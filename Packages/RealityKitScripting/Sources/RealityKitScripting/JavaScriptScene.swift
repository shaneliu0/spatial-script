//
//  JavaScriptScene.swift
//  RealityKitScripting
//
//  Created by Shane Liu on 9/8/26.
//

import Foundation
import JavaScriptCore
import RealityKit

/// Hosts the shared SpatialScript core inside JavaScriptCore and mirrors the
/// command stream it produces onto RealityKit entities.
@MainActor
public final class JavaScriptScene {
    /// A load or runtime failure reported by the core, with the source position
    /// JavaScriptCore provides when it has one.
    public struct ScriptError: LocalizedError {
        public let message: String
        public let line: Int?
        public let column: Int?

        public init(message: String, line: Int?, column: Int?) {
            self.message = message
            self.line = line
            self.column = column
        }

        public var errorDescription: String? {
            guard let line else { return message }
            guard let column else { return "\(message) (line \(line))" }
            return "\(message) (line \(line), column \(column))"
        }
    }

    private let context: JSContext
    private let applier: ScriptingCommandApplier
    private var spatial: JSValue!
    private var pendingException: ScriptError?
    private var isDisposed = false
    private var frameIndex = 0
    private var elapsed: Double = 0
    private var reportedErrors: [String] = []
    private var ownKeysFunction: JSObjectRef?
    private var watchdogInstalled = false
    /// Names the synchronous entry the host is inside, for the watchdog report.
    private var currentEntryPoint = "load"
    /// Set when the watchdog trips: the scene is beyond saving and is dropped.
    public private(set) var isTerminated = false
    private var externalInputPending = false
    private var externalTransformSyncPending = false
    private var externalBodySyncPending = false
    private var stats = ScriptingFrameStats()
    private var lastTickTimestamp: UInt64 = 0
    private let createdAt = DispatchTime.now().uptimeNanoseconds
    /// Milliseconds from this scene being constructed to its first applied frame.
    public private(set) var firstFrameMilliseconds: Double?
    /// Console output in the `"level: message"` shape the conformance
    /// expectations match against.
    public private(set) var logLines: [String] = []

    /// Console output and reported errors from this scene.
    public var logListener: ScriptingLogListener?

    /// Rolling buffer the DEBUG dev transport drains through `GET /logs`.
    public private(set) var recentLogs: [ScriptingLogEntry] = []

    public let sceneID: UUID

    public init(
        rootEntity: Entity,
        source: String,
        assetRoot: URL? = nil,
        logListener: ScriptingLogListener? = nil
    ) throws {
        guard let context = JSContext() else {
            throw ScriptError(message: "Unable to create the JavaScript execution context.", line: nil, column: nil)
        }
        self.context = context
        self.logListener = logListener
        applier = ScriptingCommandApplier(root: rootEntity, assetRoot: assetRoot)
        sceneID = applier.sceneIdentifier
        rootEntity.components.set(ScriptingEntityComponent(sceneID: sceneID, entityID: 0))

        context.exceptionHandler = { [weak self] _, exception in
            MainActor.assumeIsolated {
                guard let self, let exception else { return }
                self.pendingException = Self.scriptError(from: exception)
            }
        }

#if DEBUG
        watchdogInstalled = ScriptingWatchdog.install(on: context)
#endif
        installNativeFunctions()
        captureOwnKeysFunction()

        guard let bundleSource = Self.loadCoreBundle() else {
            throw ScriptError(
                message: "spatial-core.js is missing from the RealityKitScripting resource bundle.",
                line: nil,
                column: nil
            )
        }
        context.evaluateScript(bundleSource, withSourceURL: URL(string: "spatial-core.js"))
        if let pendingException {
            self.pendingException = nil
            throw pendingException
        }

        guard let spatialValue = context.objectForKeyedSubscript("__spatial"), !spatialValue.isUndefined else {
            throw ScriptError(
                message: "spatial-core.js did not define globalThis.__spatial.",
                line: nil,
                column: nil
            )
        }
        spatial = spatialValue

        applier.dispatch = { [weak self] type, id, payload in
            self?.dispatch(type: type, id: id, payload: payload)
        }
        applier.emitLog = { [weak self] level, message in
            self?.emit(level: level, message: message)
        }
        applier.emitWarning = { [weak self] key, message in
            self?.recordConsumerWarning(key: key, message: message)
        }

        let environment = Self.environmentDescription(assetRoot: assetRoot)
        currentEntryPoint = "load"
        let loadStarted = DispatchTime.now().uptimeNanoseconds
        spatial.invokeMethod("load", withArguments: [source, environment])
        noteIfOverran(since: loadStarted, entryPoint: "load")
        if isTerminated {
            applier.dispose()
            throw ScriptError(
                message: "The script was terminated: load ran for more than "
                    + "\(Int(ScriptingWatchdog.limitSeconds)) seconds.",
                line: nil,
                column: nil
            )
        }
        if let pendingException {
            self.pendingException = nil
            applier.dispose()
            throw pendingException
        }

        ScriptingInputRouter.shared.register(scene: self, id: sceneID)
#if os(visionOS)
        ScriptingHandTracking.shared.retain()
#endif
    }

    // MARK: - Frame loop

    /// When set, every tick uses exactly this delta regardless of the frame
    /// clock, so a parity plan replays identically on both backends.
    public var fixedDeltaTime: TimeInterval?

    /// While paused the system stops driving the scene, holding the last frame.
    public var isPaused = false

    /// Frames the system may still tick. A parity plan sets it so the plan
    /// advances exactly one tick per rendered frame and no further.
    public private(set) var planFrameBudget: Int?

    /// Ticks applied so far, for a plan driver to wait on.
    public var appliedFrames: Int { frameIndex }

    /// Lets the system tick this scene `count` more times, then hold again.
    public func allowPlanFrames(_ count: Int) {
        planFrameBudget = max(0, count)
    }

    public func clearPlanBudget() {
        planFrameBudget = nil
    }

    public func tick(deltaTime: TimeInterval) {
        guard !isDisposed, !isPaused else { return }
        if let budget = planFrameBudget {
            guard budget > 0 else { return }
            planFrameBudget = budget - 1
        }
        let deltaTime = fixedDeltaTime ?? deltaTime

        applier.sampleBodyMotion(deltaTime: deltaTime)
        applier.advanceParticleLifetimes(deltaTime: deltaTime)

        // A sync pushed in from outside owns this frame for that channel only;
        // transforms and velocities are suppressed independently.
        if externalTransformSyncPending {
            externalTransformSyncPending = false
        } else {
            let syncRecords = applier.nativeDrivenSyncRecords()
            if !syncRecords.isEmpty,
               let array = JavaScriptTypedArrayFactory.float32Array(syncRecords, in: context) {
                invoke("sync", [array])
            }
        }
        if externalBodySyncPending {
            externalBodySyncPending = false
        } else {
            let bodyRecords = applier.bodyVelocitySyncRecords()
            if !bodyRecords.isEmpty,
               let array = JavaScriptTypedArrayFactory.float32Array(bodyRecords, in: context) {
                invoke("syncBodies", [array])
            }
        }

        if externalInputPending {
            externalInputPending = false
        } else {
            invoke("setInput", [ScriptingInputRouter.shared.inputState(for: sceneID)])
        }

        frameIndex += 1
        elapsed += deltaTime

        let tickStart = DispatchTime.now().uptimeNanoseconds
        let interval = lastTickTimestamp == 0 ? 0 : Double(tickStart - lastTickTimestamp) / 1e6
        lastTickTimestamp = tickStart
        // The slot is cleared first so only this tick's exception is seen, and
        // the batch is applied either way: the core has already recorded these
        // commands as flushed and will not re-emit them.
        pendingException = nil
        let commands = spatial.invokeMethod("tick", withArguments: [deltaTime])
        let tickEnd = DispatchTime.now().uptimeNanoseconds
        noteIfOverran(since: tickStart, entryPoint: "tick")
        let thrown = pendingException
        pendingException = nil
        applier.prototypeIsClean = prototypeIsClean()
        let commandCount = commands.map { applier.apply(commands: $0, in: context) } ?? 0
        if let thrown {
            if noteTermination(thrown, entryPoint: "tick") { return }
            report(thrown)
        }
        let applyEnd = DispatchTime.now().uptimeNanoseconds

        stats.record(
            ScriptingFrameSample(
                coreTickMilliseconds: Double(tickEnd - tickStart) / 1e6,
                applyMilliseconds: Double(applyEnd - tickEnd) / 1e6,
                commandCount: commandCount,
                frameIntervalMilliseconds: interval,
                entityCount: applier.records.count
            )
        )
        if firstFrameMilliseconds == nil {
            firstFrameMilliseconds = Double(applyEnd - createdAt) / 1e6
        }
    }

    /// The last 120 frames of timing, for `GET /stats`.
    public func frameStats() -> [String: Any] {
        var summary = stats.summary()
        // A harness reading /stats could not tell a held scene from a slow one.
        summary["paused"] = isPaused || ScriptingRuntime.isPaused
        summary["sampledAtFrame"] = frameIndex
        summary["framesSinceLoad"] = frameIndex
        summary["firstFrameMs"] = firstFrameMilliseconds ?? 0
        summary["resourceCache"] = applier.resources.summary
        summary["coreVersion"] = coreVersion
        // A perf run has to be able to tell an interpreter measurement from a
        // JIT one; they differ by more than any change in this package.
        summary["jit"] = ScriptingRuntime.isJITEnabled
        return summary
    }

    public func dispose() {
        guard !isDisposed else { return }
        isDisposed = true
        if let commands = spatial.invokeMethod("dispose", withArguments: []) {
            applier.apply(commands: commands, in: context)
        }
        applier.dispose()
        ScriptingInputRouter.shared.unregister(id: sceneID)
#if os(visionOS)
        ScriptingHandTracking.shared.release()
#endif
        context.exceptionHandler = nil
#if DEBUG
        if watchdogInstalled { ScriptingWatchdog.remove(from: context) }
#endif
        if let ownKeysFunction, let contextRef = context.jsGlobalContextRef {
            JSValueUnprotect(contextRef, ownKeysFunction)
        }
        ownKeysFunction = nil
        applier.ownKeysFunction = nil
        // Drop the native bridge before the context goes so nothing holds the
        // blocks, then let JavaScriptCore reclaim the scene's heap now rather
        // than at some later allocation.
        context.setObject(nil, forKeyedSubscript: "__spatialNative" as NSString)
        if let contextRef = context.jsGlobalContextRef {
            JSGarbageCollect(contextRef)
        }
    }

    // MARK: - Introspection

    /// The core's own view of the scene, per SPEC section 8.
    public func dump() -> [String: Any] {
        dump(options: nil)
    }

    /// `options` is forwarded to the core's `dump({ compact, names, fields })`.
    /// The same filtering is applied here as well, so `?compact=1`, `?names=`
    /// and `?fields=` are useful whether or not the core supports them yet.
    public func dump(options: [String: Any]?) -> [String: Any] {
        let arguments: [Any] = options.map { [$0] } ?? []
        guard let value = invoke("dump", arguments),
              let contextRef = context.jsGlobalContextRef,
              JSValueIsObject(contextRef, value.jsValueRef),
              let object = JSValueToObject(contextRef, value.jsValueRef, nil)
        else { return [:] }
        // Read with own-property semantics: `toDictionary()` walks the
        // prototype chain, so a polluted `Object.prototype` turned every dump
        // into an unbounded structure and blew the stack.
        let raw: [String: Any]
        if prototypeIsClean() {
            raw = value.toDictionary() as? [String: Any] ?? [:]
        } else {
            var reader = JavaScriptPayloadReader(context: contextRef, ownKeys: ownKeysFunction)
            reader.prototypeIsClean = false
            raw = reader.dictionary(object: object, depth: 0)
        }
        return ScriptingDumpFilter.apply(options: options, to: raw)
    }

    /// The core dump already serialised, without crossing the JavaScript
    /// boundary once per value.
    ///
    /// A 10 000 object dump is roughly 12 MB and about a million individual
    /// `JSValue` reads, which cost seconds of main-actor time. JavaScriptCore's
    /// own serialiser walks the same tree inside the VM and hands back one
    /// string. Returns `nil` when the fast path is not safe or not applicable,
    /// in which case the caller falls back to `dump(options:)`.
    ///
    /// Not used for filtered dumps: `compact`, `names` and `fields` are applied
    /// by `ScriptingDumpFilter` in the shape this consumer serves, and those
    /// dumps are small enough that the per-value read is already cheap.
    public func dumpJSON(options: [String: Any]?) -> Data? {
        guard options?.isEmpty ?? true else { return nil }
        // `JSON.stringify` honours `toJSON`, so a polluted prototype could feed
        // the serialiser a structure of its own choosing. The bounded reader
        // stays the path for that case; `toDictionary()` is never used here.
        guard jsonSerializationIsSafe() else { return nil }
        guard let contextRef = context.jsGlobalContextRef,
              let value = invoke("dump", []),
              JSValueIsObject(contextRef, value.jsValueRef)
        else { return nil }

        var exception: JSValueRef?
        guard let json = JSValueCreateJSONString(contextRef, value.jsValueRef, 0, &exception),
              exception == nil
        else { return nil }
        defer { JSStringRelease(json) }

        guard let text = JSStringCopyCFString(kCFAllocatorDefault, json) else { return nil }
        return Data((text as String).utf8)
    }

    /// True when JavaScriptCore's serialiser can be trusted with this context:
    /// nothing enumerable on `Object.prototype`, and no `toJSON` installed on
    /// the prototypes a dump's values inherit from.
    private func jsonSerializationIsSafe() -> Bool {
        guard prototypeIsClean() else { return false }
        guard let probe = context.evaluateScript(
            "(function(){try{return typeof Object.prototype.toJSON==='undefined'"
                + "&&typeof Array.prototype.toJSON==='undefined'"
                + "&&typeof Number.prototype.toJSON==='undefined'"
                + "&&typeof String.prototype.toJSON==='undefined'"
                + "&&typeof Boolean.prototype.toJSON==='undefined';}catch(e){return false;}})()"
        ) else { return false }
        return probe.toBool()
    }

    /// The same shape rebuilt from the RealityKit entities the consumer owns.
    public func nativeDump(options: [String: Any]? = nil) -> [String: Any] {
        ScriptingDumpFilter.apply(options: options, to: nativeDump())
    }

    public func nativeDump() -> [String: Any] {
        applier.nativeDump(
            platform: Self.platformName,
            frame: frameIndex,
            elapsed: elapsed,
            errors: reportedErrors,
            logs: logLines
        )
    }

    public func drainLogs() -> [ScriptingLogEntry] {
        let logs = recentLogs
        recentLogs.removeAll()
        return logs
    }

    /// Mirrors `Spatial.inject` for the dev transport and for tests.
    public func inject(_ javaScript: String) {
        pendingException = nil
        context.evaluateScript(javaScript)
        if let pendingException {
            self.pendingException = nil
            report(pendingException)
        }
    }

    public func injectTap(target: String, point: SIMD3<Float>? = nil) {
        if let point {
            inject(
                "Spatial.inject.tap(\(quote(target)), new Spatial.Vector3(\(point.x), \(point.y), \(point.z)));"
            )
        } else {
            inject("Spatial.inject.tap(\(quote(target)));")
        }
    }

    public func injectHover(target: String, entering: Bool) {
        inject("Spatial.inject.hover(\(quote(target)), \(entering));")
    }

    public func injectDrag(target: String, translation: SIMD3<Float>, steps: Int = 1) {
        inject(
            "Spatial.inject.drag(\(quote(target)), "
            + "new Spatial.Vector3(\(translation.x), \(translation.y), \(translation.z)), "
            + "{ steps: \(steps) });"
        )
    }

    public func injectKey(code: String, down: Bool) {
        inject("Spatial.inject.key(\(quote(code)), \(down));")
    }

    private func quote(_ value: String) -> String {
        let escaped = value
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
        return "\"\(escaped)\""
    }

    // MARK: - Events in

    public func dispatch(type: String, id: Int, payload: [String: Any]?) {
        guard !isDisposed else { return }
        invoke("dispatch", [type, id, payload ?? [:]])
    }

    // MARK: - Consumer to core entry points

    /// Pushes world transforms for native driven objects, per SPEC section 6.
    public func sync(records: [Float]) {
        guard !records.isEmpty,
              let array = JavaScriptTypedArrayFactory.float32Array(records, in: context) else { return }
        externalTransformSyncPending = true
        invoke("sync", [array])
    }

    /// Pushes body velocities, per SPEC section 6.
    public func syncBodies(records: [Float]) {
        guard !records.isEmpty,
              let array = JavaScriptTypedArrayFactory.float32Array(records, in: context) else { return }
        externalBodySyncPending = true
        invoke("syncBodies", [array])
    }

    public func setInput(_ state: [String: Any]) {
        externalInputPending = true
        invoke("setInput", [state])
    }

    /// Every call into the core clears the exception slot first and drains it
    /// after, so an exception raised delivering an event can never make the
    /// next frame's command batch look failed.
    @discardableResult
    private func invoke(_ method: String, _ arguments: [Any]) -> JSValue? {
        pendingException = nil
        let previousEntry = currentEntryPoint
        currentEntryPoint = method
        let started = DispatchTime.now().uptimeNanoseconds
        let result = spatial.invokeMethod(method, withArguments: arguments)
        noteIfOverran(since: started, entryPoint: method)
        currentEntryPoint = previousEntry
        if let pendingException {
            self.pendingException = nil
            report(pendingException)
        }
        return result
    }

    /// Reports a tripped execution limit and marks the scene unusable. Returns
    /// true when the error was a termination rather than a script error.
    ///
    /// JavaScriptCore's termination exception carries no message the core can
    /// format — it reaches the log channel as `"undefined"` — so a synchronous
    /// entry that ran to the limit is the signal that is actually reliable.
    private func noteTermination(_ error: ScriptError, entryPoint: String) -> Bool {
#if DEBUG
        guard watchdogInstalled, !isTerminated,
              ScriptingWatchdog.isTermination(error.message) else { return false }
        isTerminated = true
        emit(
            level: .error,
            message: "The script was terminated: it ran for more than "
                + "\(Int(ScriptingWatchdog.limitSeconds)) seconds inside \(entryPoint). "
                + "The scene has been disposed."
        )
        return true
#else
        _ = error
        _ = entryPoint
        return false
#endif
    }

    /// Core id of the named object in the mounted scene.
    public func objectID(named name: String) -> Int? {
        guard let namespace = context.objectForKeyedSubscript("Spatial") else { return nil }
        guard let object = namespace.invokeMethod("find", withArguments: [name]),
              !object.isUndefined, !object.isNull else { return nil }
        guard let id = spatial.invokeMethod("idForObject", withArguments: [object]),
              id.isNumber else { return nil }
        return Int(id.toInt32())
    }

    public func textureID(forURL url: String) -> Int? {
        applier.textureID(forURL: url)
    }

    public func assetID(forURL url: String) -> Int? {
        applier.assetID(forURL: url)
    }

    /// Applies a literal command array, bypassing the core. Used by the unit
    /// tests to exercise every opcode with hand built commands.
    func applyCommands(javaScript: String) {
        pendingException = nil
        guard let value = context.evaluateScript("(function(){ return \(javaScript); })()") else { return }
        if let pendingException {
            self.pendingException = nil
            report(pendingException)
            return
        }
        applier.apply(commands: value, in: context)
    }

    var commandApplier: ScriptingCommandApplier { applier }

    /// Moves an entity the way physics or manipulation would have, so a
    /// `sync` from a test harness leaves both sides consistent.
    public func setNativeWorldTransform(
        id: Int,
        position: SIMD3<Float>,
        rotation: simd_quatf,
        scale: SIMD3<Float>
    ) {
        applier.setNativeWorldTransform(id: id, position: position, rotation: rotation, scale: scale)
    }

    func entityRecordID(for entity: Entity) -> Int? {
        applier.nearestRecord(from: entity)?.id
    }

    func raycastValues(origin: SIMD3<Float>, direction: SIMD3<Float>) -> [Float] {
        applier.raycast(origin: origin, direction: direction, maxDistance: 1000)
    }

    // MARK: - Native bridge

    /// True while nothing enumerable has been added to `Object.prototype`.
    /// Checked once per command batch and once per dump, not per payload.
    func prototypeIsClean() -> Bool {
        guard let probe = context.evaluateScript("(function(){let n=0;for(const k in {})n++;return n===0;})()")
        else { return false }
        return probe.toBool()
    }

    /// Captures `Object.keys` before any script runs, so command payloads are
    /// read with own-property semantics that a script cannot subvert.
    private func captureOwnKeysFunction() {
        guard let contextRef = context.jsGlobalContextRef,
              let keys = context.evaluateScript("Object.keys"),
              let function = JSValueToObject(contextRef, keys.jsValueRef, nil),
              JSObjectIsFunction(contextRef, function)
        else { return }
        JSValueProtect(contextRef, function)
        ownKeysFunction = function
        applier.ownKeysFunction = function
    }

    private func installNativeFunctions() {
        let native = JSValue(newObjectIn: context)

        // The trailing argument is optional: SPEC 6's signature stops at
        // maxDistance, and a core that forwards `recursive` gets it honoured.
        let raycast: @convention(block) (Double, Double, Double, Double, Double, Double, Double, JSValue?) -> [Double] = {
            [weak self] ox, oy, oz, dx, dy, dz, maxDistance, recursive in
            MainActor.assumeIsolated {
                guard let self else { return [] }
                let isRecursive = recursive.map { $0.isUndefined || $0.isNull ? true : $0.toBool() } ?? true
                let values = self.applier.raycast(
                    origin: SIMD3(Float(ox), Float(oy), Float(oz)),
                    direction: SIMD3(Float(dx), Float(dy), Float(dz)),
                    maxDistance: Float(maxDistance),
                    recursive: isRecursive
                )
                return values.map(Double.init)
            }
        }
        native?.setObject(raycast, forKeyedSubscript: "raycast" as NSString)

        let log: @convention(block) (String, String) -> Void = { [weak self] level, message in
            MainActor.assumeIsolated {
                self?.emit(level: ScriptingLogLevel(rawValue: level) ?? .log, message: message)
            }
        }
        native?.setObject(log, forKeyedSubscript: "log" as NSString)

        let now: @convention(block) () -> Double = {
            Date().timeIntervalSince1970 * 1000
        }
        native?.setObject(now, forKeyedSubscript: "now" as NSString)

        context.setObject(native, forKeyedSubscript: "__spatialNative" as NSString)
    }

    /// Routes a consumer warning into the core so it lands in `dump().warnings`
    /// exactly like a core warning, and is echoed back as a `log` command.
    private func recordConsumerWarning(key: String, message: String) {
        guard !isDisposed, let runtime = spatial?.objectForKeyedSubscript("runtime"),
              !runtime.isUndefined, !runtime.isNull else {
            emit(level: .warn, message: message)
            return
        }
        runtime.invokeMethod("warnOnce", withArguments: [key, message])
    }

    private func emit(level: ScriptingLogLevel, message: String) {
#if DEBUG
        // The core catches a callback's exception and reports it through the
        // log channel, so a tripped limit can arrive here rather than as a
        // pending exception.
        if level == .error, watchdogInstalled, !isTerminated,
           ScriptingWatchdog.isTermination(message) {
            _ = noteTermination(
                ScriptError(message: message, line: nil, column: nil),
                entryPoint: currentEntryPoint
            )
            return
        }
        // JavaScriptCore's termination exception carries no message, so the
        // unwind after a tripped limit reaches the log channel as a bare
        // "undefined". The real report was already emitted.
        if level == .error, isTerminated, Self.isUninformative(message) { return }
#endif
        // Console output is not an error list; `errors` carries only failures
        // the consumer itself hit, matching what the core puts in its dump.
        logLines.append("\(level.rawValue): \(message)")
        if logLines.count > 500 { logLines.removeFirst(logLines.count - 500) }
        let entry = ScriptingLogEntry(level: level, message: message)
        recentLogs.append(entry)
        if recentLogs.count > 500 { recentLogs.removeFirst(recentLogs.count - 500) }
        logListener?(entry)
    }

    /// True for the message-less exceptions JavaScriptCore raises while it
    /// unwinds a terminated entry, which carry nothing worth logging.
    private static func isUninformative(_ message: String) -> Bool {
        let trimmed = message.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty || trimmed == "undefined" || trimmed == "null"
    }

    /// A synchronous entry that reached the execution limit was terminated by
    /// the watchdog, whatever exception shape reached us.
    private func noteIfOverran(since started: UInt64, entryPoint: String) {
#if DEBUG
        guard watchdogInstalled, !isTerminated else { return }
        let elapsed = Double(DispatchTime.now().uptimeNanoseconds - started) / 1e9
        guard elapsed >= ScriptingWatchdog.limitSeconds else { return }
        isTerminated = true
        emit(
            level: .error,
            message: "The script was terminated: it ran for more than "
                + "\(Int(ScriptingWatchdog.limitSeconds)) seconds inside \(entryPoint). "
                + "The scene has been disposed."
        )
#else
        _ = started
        _ = entryPoint
#endif
    }

    private func report(_ error: ScriptError) {
        if noteTermination(error, entryPoint: currentEntryPoint) { return }
        if isTerminated, Self.isUninformative(error.message) { return }
        let message = error.errorDescription ?? error.message
        if !reportedErrors.contains(message) { reportedErrors.append(message) }
        emit(level: .error, message: message)
    }

    private static func scriptError(from exception: JSValue) -> ScriptError {
        let message = exception.objectForKeyedSubscript("message")?.toString()
            ?? exception.toString()
            ?? "Unknown JavaScript error"
        let line = exception.objectForKeyedSubscript("line").flatMap { $0.isNumber ? Int($0.toInt32()) : nil }
        let column = exception.objectForKeyedSubscript("column").flatMap { $0.isNumber ? Int($0.toInt32()) : nil }
        let stack = exception.objectForKeyedSubscript("stack")?.toString()
        let detail = (stack?.isEmpty == false && stack != "undefined") ? "\(message)\n\(stack!)" : message
        return ScriptError(message: detail, line: line, column: column)
    }

    // MARK: - Environment

    static var platformName: String {
#if os(visionOS)
        "visionos"
#else
        "macos"
#endif
    }

    static func environmentDescription(assetRoot: URL?) -> [String: Any] {
#if os(visionOS)
        let capabilities: [String: Bool] = [
            "hands": true,
            "anchors": true,
            "portals": true,
            "particles": true,
            "manipulation": true,
            "hoverEffect": true,
            "shadows": true,
        ]
#else
        let capabilities: [String: Bool] = [
            "hands": false,
            "anchors": false,
            "portals": true,
            "particles": true,
            // ManipulationComponent is visionOS only and there is no macOS
            // emulation, so the capability is reported honestly.
            "manipulation": false,
            "hoverEffect": false,
            "shadows": true,
        ]
#endif
        var environment: [String: Any] = [
            "backend": "realitykit",
            "platform": platformName,
            "capabilities": capabilities,
        ]
        if let assetRoot {
            environment["assetRoot"] = assetRoot.path
        }
        return environment
    }

    static func loadCoreBundle() -> String? {
        let bundle = Bundle.module
        let candidates = [
            bundle.url(forResource: "spatial-core", withExtension: "js"),
            bundle.url(forResource: "spatial-core", withExtension: "js", subdirectory: "Resources"),
        ]
        for case let url? in candidates {
            if let source = try? String(contentsOf: url, encoding: .utf8) { return source }
        }
        return nil
    }

    /// Reports whether the resource bundle still carries the placeholder core.
    public var isUsingPlaceholderCore: Bool {
        spatial.objectForKeyedSubscript("isPlaceholder")?.toBool() ?? false
    }

    public var coreVersion: String {
        spatial.objectForKeyedSubscript("version")?.toString() ?? "unknown"
    }

    // MARK: - Validation

    public static func validate(_ source: String) throws {
        guard let context = JSContext() else {
            throw ScriptError(message: "Unable to create the JavaScript execution context.", line: nil, column: nil)
        }
        nonisolated(unsafe) var failure: ScriptError?
        context.exceptionHandler = { _, exception in
            guard let exception else { return }
            failure = ScriptError(
                message: exception.objectForKeyedSubscript("message")?.toString() ?? exception.toString() ?? "",
                line: exception.objectForKeyedSubscript("line").flatMap { $0.isNumber ? Int($0.toInt32()) : nil },
                column: exception.objectForKeyedSubscript("column").flatMap { $0.isNumber ? Int($0.toInt32()) : nil }
            )
        }
        // The core evaluates a script as an async function body, so top level
        // `await` is legal and validation must accept it.
        context.evaluateScript(
            "(function(){ const A = Object.getPrototypeOf(async function(){}).constructor;"
            + " return new A(\(source.debugDescription)); })();"
        )
        if let failure { throw failure }
    }
}

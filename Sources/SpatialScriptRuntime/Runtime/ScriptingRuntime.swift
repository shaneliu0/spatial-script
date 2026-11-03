//
//  ScriptingRuntime.swift
//  SpatialScriptRuntime
//
//  Created by Shane Liu on 9/8/26.
//

import Darwin
import Foundation
import RealityKit

/// Entry point the app calls once at launch to register the components and the
/// system that drive SpatialScript scenes.
@MainActor
public final class ScriptingRuntime {
    public struct InputOptions: OptionSet, Sendable {
        public let rawValue: UInt8

        public init(rawValue: UInt8) {
            self.rawValue = rawValue
        }

        public static let mouse = InputOptions(rawValue: 1 << 0)
        public static let keyboard = InputOptions(rawValue: 1 << 1)
        public static let gamepad = InputOptions(rawValue: 1 << 2)
        public static let ar = InputOptions(rawValue: 1 << 3)
        public static let tap = InputOptions(rawValue: 1 << 4)
        public static let drag = InputOptions(rawValue: 1 << 5)
        public static let all: InputOptions = [.mouse, .keyboard, .gamepad, .ar, .tap, .drag]
    }

    private static var didRegister = false
    /// What `setup` was called with, for the capability report.
    public private(set) static var activeInputOptions: InputOptions = .all
    private static var scenesByEntity: [ObjectIdentifier: JavaScriptScene] = [:]

    /// Root the consumer resolves relative texture and asset paths against.
    public static var assetRoot: URL?

    /// The viewport's width over its height (SPEC 14.3). An orthographic
    /// camera's visible width follows it, because RealityKit's orthographic
    /// camera takes only a height. Set by the view that owns the RealityView.
    public static var viewportAspect: Double = 1

    /// The renderer's drawable size in points, as the view last measured it.
    /// SPEC 14.3's orthographic width follows it, so a parity run has to be
    /// able to size the other backend's viewport the same way (`GET /stats`
    /// and the `POST /parity` response both carry it).
    public static var viewportSize: (width: Double, height: Double) = (0, 0)

    /// The view's own camera on macOS (SPEC 14.3). It is switched off while a
    /// script owns `Spatial.camera`, so RealityKit renders through exactly one.
    public static weak var defaultCameraEntity: Entity?

    /// Receives console output from every scene.
    public static var logListener: ScriptingLogListener?

#if DEBUG
    /// Holds every scene at its last applied frame. The parity route sets this
    /// so a plan can be ticked by hand and the result stays on screen.
    ///
    /// SPEC 11: the dev transport and everything that exists only to serve it
    /// are DEBUG only, so a shipped build carries no way to freeze the scene.
    public static var isPaused = false

    /// Forces every tick to use exactly this delta, for deterministic replay.
    public static var fixedDeltaTime: TimeInterval?
#endif

    /// Scenes start inactive when the view that owns them is not on screen.
    public static var isActive = true

    /// Called when a script fails to load, with the position when one is known.
    public static var loadFailureListener: (@MainActor (JavaScriptScene.ScriptError) -> Void)?

    private init() {}

    @discardableResult
    public static func setup(inputOptions: InputOptions = .all) -> ScriptingRuntime {
        if !didRegister {
            ScriptingComponent.registerComponent()
            ScriptingEntityComponent.registerComponent()
            ScriptingSystem.registerSystem()
            didRegister = true
        }
        // SPEC 14.8: an omitted provider is not started and the matching
        // capability is reported false.
        activeInputOptions = inputOptions
        let router = ScriptingInputRouter.shared
        router.providesGamepad = inputOptions.contains(.gamepad)
        router.providesHandTracking = inputOptions.contains(.ar)
        if inputOptions.contains(.gamepad) {
            ScriptingGameControllerHub.shared.start()
        } else {
            ScriptingGameControllerHub.shared.stop()
        }
        return ScriptingRuntime()
    }

    // MARK: - JavaScript engine mode

    /// True when the process asked for the JavaScriptCore interpreter.
    ///
    /// `SPATIAL_INTERPRETER=1` in the environment, or `--interpreter` on the
    /// command line. Interpreter mode is also the closest thing this Mac host
    /// has to visionOS performance, so it is useful beyond the watchdog.
    public static var isInterpreterModeRequested: Bool {
        if CommandLine.arguments.contains("--interpreter") { return true }
        let requested = ProcessInfo.processInfo.environment["SPATIAL_INTERPRETER"]
        return requested == "1" || requested == "true" || requested == "YES"
    }

    /// True unless JavaScriptCore was told to stay in the interpreter.
    ///
    /// Read straight from the process environment rather than `ProcessInfo`,
    /// which snapshots and would not see `setenv` from this launch.
    public static var isJITEnabled: Bool {
        guard let raw = getenv("JSC_useJIT") else { return true }
        let value = String(cString: raw).lowercased()
        return !(value == "false" || value == "0" || value == "no")
    }

    /// Selects the JavaScriptCore execution mode for this process.
    ///
    /// Call this as the very first statement of the app's `init`, before any
    /// JavaScriptCore symbol is touched: JavaScriptCore reads `JSC_*` options
    /// once, when its VM is first initialised, and ignores later changes.
    ///
    /// The JIT's interrupt check never fires in this hardened, JIT-entitled
    /// process, so `while (true) {}` inside `tick` freezes the app with the
    /// execution time limit installed and armed. In the interpreter the same
    /// limit terminates the script on schedule, which is why the watchdog
    /// reports itself inactive until this is on.
    @discardableResult
    public static func configureJavaScriptEngine() -> Bool {
        guard isInterpreterModeRequested else { return false }
        setenv("JSC_useJIT", "false", 1)
        return true
    }

    /// Whether the DEBUG execution watchdog can actually interrupt a runaway
    /// script, for `GET /health`.
    public static var watchdogStatus: String {
#if DEBUG
        guard ScriptingWatchdog.isAvailable else { return "unavailable" }
        return isJITEnabled ? "inactive (requires interpreter mode)" : "armed"
#else
        return "release build: no watchdog"
#endif
    }

    /// The body of `GET /health` apart from the port, kept here so the shape
    /// is covered by the package tests.
    public static func healthFields() -> [String: Any] {
        [
            "ok": true,
            "jit": isJITEnabled,
            "watchdog": watchdogStatus,
        ]
    }

    // MARK: - Host channel (SPEC 14.10)

    /// A function an embedding app registers for scripts to call.
    public enum HostFunction {
        case synchronous(@MainActor ([String: Any]) throws -> Any?)
        case asynchronous(@MainActor ([String: Any]) async throws -> Any?)
        /// The app answers later, through the completion it is handed.
        case deferred(@MainActor ([String: Any], @escaping @MainActor (Any?, String?) -> Void) -> Void)
    }

    private static var hostFunctions: [String: HostFunction] = [:]
    /// Registration order, which is the order `Spatial.host.functions` lists.
    private static var hostFunctionOrder: [String] = []
    private static var hostEventHandlers: [String: [(@MainActor (String, [String: Any]) -> Void)]] = [:]

    /// `ScriptingRuntime.register(module: "MyApp", function: "save") { args in ... }`.
    /// Scripts reach it as `await Spatial.host.call("MyApp.save", args)`.
    public static func register(
        module: String,
        function: String,
        body: @escaping @MainActor ([String: Any]) throws -> Any?
    ) {
        setHostFunction("\(module).\(function)", .synchronous(body))
    }

    public static func register(
        module: String,
        function: String,
        asyncBody: @escaping @MainActor ([String: Any]) async throws -> Any?
    ) {
        setHostFunction("\(module).\(function)", .asynchronous(asyncBody))
    }

    /// Registers a function the app answers later, for a call that has to wait
    /// on the user or on work the app schedules itself.
    public static func register(
        module: String,
        function: String,
        deferredBody: @escaping @MainActor ([String: Any], @escaping @MainActor (Any?, String?) -> Void) -> Void
    ) {
        setHostFunction("\(module).\(function)", .deferred(deferredBody))
    }

    private static func setHostFunction(_ name: String, _ function: HostFunction) {
        if hostFunctions[name] == nil { hostFunctionOrder.append(name) }
        hostFunctions[name] = function
        publishHostFunctions()
    }

    /// SPEC 14.13: a registration made after a script has loaded still has to
    /// show up in `Spatial.host.functions`, so every live scene is told.
    static func publishHostFunctions() {
        let names = hostFunctionNames
        for scene in scenesByEntity.values { scene.setHostFunctions(names) }
    }

    public static func unregister(module: String, function: String) {
        let name = "\(module).\(function)"
        hostFunctions[name] = nil
        hostFunctionOrder.removeAll { $0 == name }
        publishHostFunctions()
    }

    static func hostFunction(named name: String) -> HostFunction? {
        hostFunctions[name]
    }

    /// What `Spatial.host.functions` reports.
    public static var hostFunctionNames: [String] {
        hostFunctionOrder.filter { hostFunctions[$0] != nil }
    }

    /// Listens for `Spatial.host.send(name, payload)` from any scene.
    public static func on(
        _ name: String,
        handler: @escaping @MainActor (String, [String: Any]) -> Void
    ) {
        hostEventHandlers[name, default: []].append(handler)
    }

    public static func removeHostEventHandlers(for name: String) {
        hostEventHandlers[name] = nil
    }

    static func deliverHostEvent(name: String, payload: [String: Any], from scene: JavaScriptScene) {
        for handler in hostEventHandlers[name] ?? [] { handler(name, payload) }
        for handler in hostEventHandlers["*"] ?? [] { handler(name, payload) }
        _ = scene
    }

    public static func validateScript(_ script: String) throws {
        try JavaScriptScene.validate(script)
    }

    /// The scene currently running on `entity`, for the dev transport.
    public static func scene(for entity: Entity) -> JavaScriptScene? {
        scenesByEntity[ObjectIdentifier(entity)]
    }

    /// Any running scene, for dev transport routes that do not name one.
    public static var anyScene: JavaScriptScene? {
        scenesByEntity.values.first
    }

    static func register(scene: JavaScriptScene, for entity: Entity) {
        scenesByEntity[ObjectIdentifier(entity)] = scene
    }

    static func unregisterScene(for entity: Entity) {
        scenesByEntity[ObjectIdentifier(entity)] = nil
    }

    static func pruneScenes(keeping live: Set<ObjectIdentifier>) {
        scenesByEntity = scenesByEntity.filter { live.contains($0.key) }
    }

    static func reportLoadFailure(_ error: any Error, for entity: Entity) {
        scenesByEntity[ObjectIdentifier(entity)] = nil
        let scriptError = error as? JavaScriptScene.ScriptError
            ?? JavaScriptScene.ScriptError(
                message: error.localizedDescription,
                line: nil,
                column: nil
            )
        loadFailureListener?(scriptError)
        logListener?(
            ScriptingLogEntry(level: .error, message: scriptError.errorDescription ?? scriptError.message)
        )
    }

    /// Installs the ray provider pointer hover needs on macOS. Call it from the
    /// view that owns the `RealityView`, which is the only place the camera is
    /// reachable.
    /// Drops every registered scene and the pointer ray provider, for a view
    /// that is going away.
    public static func releaseInput() {
        ScriptingInputRouter.shared.reset()
    }

    public static func setPointerRayProvider(
        _ provider: (@MainActor (CGPoint) -> (origin: SIMD3<Float>, direction: SIMD3<Float>)?)?
    ) {
        ScriptingInputRouter.shared.pointerRayProvider = provider
    }
}

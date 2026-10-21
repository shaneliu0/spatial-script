//
//  JavaScriptScene+Phase2.swift
//  RealityKitScripting
//
//  Created by Shane Liu on 9/9/26.
//

import Foundation
import JavaScriptCore
import RealityKit

extension JavaScriptScene {
    // MARK: - Lifecycle (SPEC 14.10)

    /// Activates or deactivates the scene. `this.didActivate()` and
    /// `this.willDeactivate()` run in the core, `Spatial.isActive` follows, and
    /// ticks stop while inactive so timers do not advance.
    public func setActive(_ active: Bool) {
        guard active != isActive else { return }
        isActive = active
        invokePublic("setActive", [active])
    }

    /// The JSON object the script keeps in `this.state`, read before the
    /// scene is disposed so a hot reload can hand it to the next one.
    public func captureState() -> [String: Any]? {
        guard let value = invokePublic("captureState", []), !value.isUndefined, !value.isNull else {
            return nil
        }
        guard let contextRef = jsContextRef, JSValueIsObject(contextRef, value.jsValueRef),
              let object = JSValueToObject(contextRef, value.jsValueRef, nil) else { return nil }
        if prototypeIsClean() { return value.toDictionary() as? [String: Any] }
        var reader = JavaScriptPayloadReader(context: contextRef, ownKeys: ownKeysReference)
        reader.prototypeIsClean = false
        return reader.dictionary(object: object, depth: 0)
    }

    /// SPEC 14.10 hot reload, in place. The core resets its runtime and bumps
    /// its load generation, restarting object ids, so everything the previous
    /// script built is dropped first.
    public func reload(source: String, previousState: [String: Any]? = nil) throws {
        commandApplier.disposeMedia()
        commandApplier.releaseCamera()
        commandApplier.reset()
        resetForReload()

        var environment = JavaScriptScene.environmentDescription(assetRoot: assetRoot)
        if let previousState { environment["previousState"] = previousState }
        guard let error = loadInPlace(source: source, environment: environment) else { return }
        throw error
    }

    /// Hands the previous script's state to a freshly loaded one.
    ///
    /// The core takes it as a load option and delivers it to
    /// `this.scriptChanged(previousState)` itself, so a scene that is already
    /// running can only be told after the fact; the host passes it to
    /// `init(previousState:)` instead, which is the path SPEC 14.10 describes.
    public func restoreState(_ state: [String: Any]) {
        invokePublic("scriptChanged", [state])
    }

    // MARK: - Host channel (SPEC 14.10)

    /// SPEC 14.13 `setHostFunctions(names)`. Also supplied as a load option, so
    /// this is what keeps `Spatial.host.functions` current for a function the
    /// app registers after the script is running.
    public func setHostFunctions(_ names: [String]) {
        invokePublic("setHostFunctions", [names])
    }

    /// Sends a host event into the script: `Spatial.host.on(name, handler)`.
    public func send(name: String, payload: [String: Any]? = nil) {
        invokePublic("hostEvent", [name, payload ?? [:]])
    }

    /// Answers a `hostCall` the script made.
    public func answerHostCall(id: Int, value: Any?, error: String?) {
        let payload: [String: Any] = error.map { ["error": $0] } ?? ["value": value ?? NSNull()]
        dispatch(type: "hostResult", id: id, payload: payload)
    }

    /// Answers a `fetch` the script made.
    ///
    /// The core reads `text`, `json` or `error` from the payload — a `value`
    /// key is not the contract, and a fetch answered that way is reported to
    /// the script as "the response was not JSON".
    public func answerFetch(id: Int, text: String?, json: Any?, error: String?) {
        var payload: [String: Any] = [:]
        if let error {
            payload["error"] = error
        } else if let json {
            payload["json"] = json
        } else {
            payload["text"] = text ?? ""
        }
        dispatch(type: "fetchResult", id: id, payload: payload)
    }

    /// SPEC 14.3. The camera the script set, as the consumer applied it, or
    /// nil while the view's own camera is in charge.
    public var scriptedCamera: (kind: String, transform: Transform)? {
        guard let spec = commandApplier.cameraSpec,
              let kind = spec["kind"] as? String,
              let transform = commandApplier.cameraTransform() else { return nil }
        return (kind, transform)
    }

    /// The call id a harness should answer for a pending `Spatial.host.call`.
    public func pendingHostCallID(named name: String) -> Int? {
        pendingHostCalls[name]
    }

    /// The request id a harness should answer for a pending fetch.
    public func pendingFetchID(forURL url: String) -> Int? {
        pendingFetches[url]
    }

    // MARK: - Controller injection (SPEC 14.14)

#if DEBUG
    /// Drives `Spatial.input.controllers` from a harness, since the gate runs
    /// with no controller attached. SPEC 11: harness-only, so DEBUG only.
    public func injectControllers(_ states: [[String: Any]]?) {
        ScriptingInputRouter.shared.injectControllers(states)
    }
#endif

    /// SPEC 14.8 `rumble`, exposed for the core's native bridge and for tests.
    @discardableResult
    public func rumble(controller id: String, intensity: Double, duration: Double) -> Bool {
        ScriptingGameControllerHub.shared.rumble(id: id, intensity: intensity, duration: duration)
    }
}

extension JavaScriptScene {
    // MARK: - Consumer to core sync (SPEC 14.13)

    /// Pushes the phase 2 channels for this frame. Each one is skipped when it
    /// has nothing to say, so a scene with no media costs nothing.
    func pushPhase2Sync() {
        let applier = commandApplier
        guard !externalMediaSyncOwner else {
            pushCharacterAndSkeletonSync()
            return
        }

        let audio = applier.audioSyncRecords()
        if !audio.isEmpty, let array = JavaScriptTypedArrayFactory.float32Array(audio, in: jsContext) {
            invokePublic("syncAudio", [array])
        }

        let video = applier.videoSyncRecords()
        if !video.isEmpty, let array = JavaScriptTypedArrayFactory.float32Array(video, in: jsContext) {
            invokePublic("syncVideo", [array])
        }

        pushCharacterAndSkeletonSync()
    }

    private func pushCharacterAndSkeletonSync() {
        let applier = commandApplier
        guard !externalCharacterSyncOwner else { return pushSkeletonSync() }
        let characters = applier.characterSyncRecords()
        if !characters.isEmpty,
           let array = JavaScriptTypedArrayFactory.float32Array(characters, in: jsContext) {
            invokePublic("syncCharacter", [array])
        }

        pushSkeletonSync()
    }

    private func pushSkeletonSync() {
        guard !externalSkeletonSyncOwner else { return }
        for tracked in commandApplier.trackedSkeletons() {
            invokePublic("syncSkeleton", [tracked.id, tracked.joints])
        }

        // Controller connect and disconnect are derived by the core from
        // successive frames of `setInput.controllers`, exactly as the web
        // backend derives them from the Gamepad API, so nothing is dispatched
        // from here.
    }

    /// SPEC 14.13 `syncAudio(records)`, for a harness that drives the channel
    /// rather than letting the consumer sample it.
    public func syncAudio(records: [Float]) {
        externalMediaSyncOwner = true
        commandApplier.mediaSyncIsExternal = true
        commandApplier.adoptAudioSync(records: records)
        guard !records.isEmpty,
              let array = JavaScriptTypedArrayFactory.float32Array(records, in: jsContext) else { return }
        invokePublic("syncAudio", [array])
    }

    public func syncVideo(records: [Float]) {
        externalMediaSyncOwner = true
        commandApplier.mediaSyncIsExternal = true
        commandApplier.adoptVideoSync(records: records)
        guard !records.isEmpty,
              let array = JavaScriptTypedArrayFactory.float32Array(records, in: jsContext) else { return }
        invokePublic("syncVideo", [array])
    }

    public func syncCharacter(records: [Float]) {
        externalCharacterSyncOwner = true
        guard !records.isEmpty,
              let array = JavaScriptTypedArrayFactory.float32Array(records, in: jsContext) else { return }
        invokePublic("syncCharacter", [array])
    }

    public func syncSkeleton(id: Int, joints: [String: Any]) {
        externalSkeletonSyncOwner = true
        invokePublic("syncSkeleton", [id, joints])
    }

    // MARK: - Host functions and fetch (SPEC 14.10, 14.11)

    /// `Spatial.host.call("Module.function", args)`. An unknown name rejects
    /// with the `SpatialUnsupportedError` shape the core expects.
    func performHostCall(id: Int, name: String, arguments: [String: Any]) {
        pendingHostCalls[name] = id
        guard let function = ScriptingRuntime.hostFunction(named: name) else {
            answerHostCall(
                id: id,
                value: nil,
                error: "host-function: '\(name)' is not registered. "
                    + "Registered: \(ScriptingRuntime.hostFunctionNames.joined(separator: ", "))."
            )
            return
        }
        switch function {
        case let .synchronous(body):
            do {
                answerHostCall(id: id, value: try body(arguments), error: nil)
            } catch {
                answerHostCall(id: id, value: nil, error: error.localizedDescription)
            }

        case let .deferred(body):
            // The app answers when it is ready; the call stays pending until
            // `answerHostCall` is called with this id.
            body(arguments) { [weak self] value, error in
                self?.answerHostCall(id: id, value: value, error: error)
            }

        case let .asynchronous(body):
            Task { [weak self] in
                do {
                    let value = try await body(arguments)
                    guard let self, !self.isDisposedScene else { return }
                    self.answerHostCall(id: id, value: value, error: nil)
                } catch {
                    guard let self, !self.isDisposedScene else { return }
                    self.answerHostCall(id: id, value: nil, error: error.localizedDescription)
                }
            }
        }
    }

    /// `Spatial.fetchText` and `Spatial.fetchJSON`, with the URL rules of 3.5.
    func performFetch(id: Int, request: [String: Any]) {
        let url = request["url"] as? String ?? ""
        let kind = request["kind"] as? String ?? "text"
        pendingFetches[url] = id
        let resolved = ScriptingResourceURL.resolve(url, assetDirectory: assetDirectory)

        // A fetch never answers inside the command batch that asked for it:
        // the promise the script holds resolves on a later turn on both
        // backends, and an inline answer would beat a harness to it.
        if let file = resolved?.localFile(extensions: ["json", "txt"], assetDirectory: assetDirectory) {
            Task { @MainActor [weak self] in
                guard let self, !self.isDisposedScene else { return }
                do {
                    let text = try String(contentsOf: file, encoding: .utf8)
                    self.deliverFetch(id: id, text: text, kind: kind)
                } catch {
                    self.answerFetch(id: id, text: nil, json: nil, error: "the file could not be read")
                }
            }
            return
        }
        guard let remote = resolved?.remoteURL else {
            Task { @MainActor [weak self] in
                guard let self, !self.isDisposedScene else { return }
                self.answerFetch(id: id, text: nil, json: nil, error: ScriptingResourceURL.failure(for: url))
            }
            return
        }
        Task { [weak self] in
            do {
                let (data, response) = try await URLSession.shared.data(from: remote)
                guard let self, !self.isDisposedScene else { return }
                if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
                    self.answerFetch(id: id, text: nil, json: nil, error: "\(http.statusCode)")
                    return
                }
                self.deliverFetch(id: id, text: String(decoding: data, as: UTF8.self), kind: kind)
            } catch {
                guard let self, !self.isDisposedScene else { return }
                self.answerFetch(id: id, text: nil, json: nil, error: error.localizedDescription)
            }
        }
    }

    private func deliverFetch(id: Int, text: String, kind: String) {
        guard kind == "json" else {
            answerFetch(id: id, text: text, json: nil, error: nil)
            return
        }
        guard let data = text.data(using: .utf8),
              let value = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
        else {
            answerFetch(id: id, text: nil, json: nil, error: "the response was not JSON")
            return
        }
        answerFetch(id: id, text: nil, json: value, error: nil)
    }
}

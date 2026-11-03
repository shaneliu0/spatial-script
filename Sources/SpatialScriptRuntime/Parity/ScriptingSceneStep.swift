//
//  ScriptingSceneStep.swift
//  SpatialScriptRuntime
//
//  Created by Shane Liu on 9/9/26.
//

// SPEC 11: the dev transport and everything that only exists to serve it
// are compiled out of release builds.
#if DEBUG
import Foundation
import RealityKit

/// One step of a SPEC section 9 plan, applied to a running scene.
///
/// The conformance runner and the dev transport's `POST /parity` plan speak the
/// same step vocabulary, so they share this interpreter: a step kind added for
/// one is available to the other, and the two cannot drift. Only `frames` is
/// left to the caller, because the two drive time differently — the conformance
/// runner ticks synchronously, while a parity plan has to wait for the display
/// loop so RealityKit's physics steps with it.
@MainActor
public enum ScriptingSceneStep {
    /// Resolves a `reload` step's script. The conformance runner reads a file
    /// beside the case when the step names one; a parity plan carries the
    /// source inline.
    public typealias SourceResolver = (String) -> String

    /// Applies one step. Returns false when the step is not one this
    /// interpreter knows, so the caller can handle `frames` or report it.
    @discardableResult
    public static func apply(
        _ step: [String: Any],
        to scene: JavaScriptScene,
        errors: inout [String],
        reloadSource: SourceResolver? = nil
    ) -> Bool {
        if let inject = step["inject"] as? String {
            applyInject(inject, step: step, to: scene, errors: &errors)
            return true
        }

        if let dispatch = step["dispatch"] as? [String: Any] {
            applyDispatch(dispatch, to: scene, errors: &errors)
            return true
        }

        if let records = step["sync"] as? [[String: Any]] {
            applyTransformSync(records, to: scene, errors: &errors)
            return true
        }

        if let records = step["syncBodies"] as? [[String: Any]] {
            var flat: [Float] = []
            for record in records {
                guard let id = objectID(record, in: scene, errors: &errors) else { continue }
                flat.append(Float(id))
                flat.append(contentsOf: floats(record["linear"]) ?? [0, 0, 0])
                flat.append(contentsOf: floats(record["angular"]) ?? [0, 0, 0])
                flat.append(record["sleeping"] as? Bool == true ? 1 : 0)
            }
            scene.syncBodies(records: flat)
            return true
        }

        if let input = step["setInput"] as? [String: Any] {
            scene.setInput(input)
            return true
        }

        // SPEC 14.13 channels. Audio and video share the record shape.
        if let records = step["syncAudio"] as? [[String: Any]] {
            scene.syncAudio(records: mediaRecords(records, in: scene, errors: &errors))
            return true
        }

        if let records = step["syncVideo"] as? [[String: Any]] {
            scene.syncVideo(records: mediaRecords(records, in: scene, errors: &errors))
            return true
        }

        if let records = step["syncCharacter"] as? [[String: Any]] {
            applyCharacterSync(records, to: scene, errors: &errors)
            return true
        }

        if let skeleton = step["syncSkeleton"] as? [String: Any] {
            guard let id = objectID(skeleton, in: scene, errors: &errors) else { return true }
            scene.syncSkeleton(id: id, joints: skeleton["joints"] as? [String: Any] ?? [:])
            return true
        }

        if let active = step["setActive"] as? Bool {
            scene.setActive(active)
            return true
        }

        if step["hostEvent"] != nil {
            applyHostEvent(step, to: scene, errors: &errors)
            return true
        }

        // SPEC 14.13's `hostFunctions` step: a list of `Module.function` names
        // the host registers for the rest of the plan, which is the same shape
        // the node and web runners take.
        if let functions = step["hostFunctions"] as? [String] {
            // SPEC 14.10: the app registers them. A plan's own answers arrive
            // as `dispatch` steps, so the bodies are deferred and never reply.
            for name in functions {
                let parts = name.split(separator: ".", maxSplits: 1).map(String.init)
                guard parts.count == 2 else {
                    errors.append("Error: host function \"\(name)\" is not Module.function")
                    continue
                }
                ScriptingRuntime.register(module: parts[0], function: parts[1]) { _, _ in }
            }
            // `Spatial.host.functions` has to reflect it immediately, not at
            // the next load.
            scene.setHostFunctions(ScriptingRuntime.hostFunctionNames)
            return true
        }

        if let reload = step["reload"] as? String {
            let carried = step["preserveState"] as? Bool == true ? scene.captureState() : nil
            do {
                try scene.reload(source: reloadSource?(reload) ?? reload, previousState: carried)
            } catch let error as JavaScriptScene.ScriptError {
                errors.append("Error: \(error.message)")
            } catch {
                errors.append("Error: \(error.localizedDescription)")
            }
            return true
        }

        if step["dispose"] != nil {
            scene.dispose()
            return true
        }

        return false
    }

    // MARK: - Step kinds

    private static func applyInject(
        _ inject: String,
        step: [String: Any],
        to scene: JavaScriptScene,
        errors: inout [String]
    ) {
        let target = step["target"] as? String ?? ""
        switch inject {
        case "tap":
            scene.injectTap(target: target, point: vector(step["point"]))
        case "hover":
            scene.injectHover(target: target, entering: step["entering"] as? Bool ?? true)
        case "drag":
            scene.injectDrag(
                target: target,
                translation: vector(step["translation"]) ?? .zero,
                steps: intValue(step["steps"]) ?? 1
            )
        case "key":
            scene.injectKey(
                code: step["code"] as? String ?? target,
                down: step["down"] as? Bool ?? true
            )
        case "controller":
            // SPEC 14.14: the gate runs with no controller attached.
            if let states = step["state"] as? [[String: Any]] {
                scene.injectControllers(states)
            } else if let state = step["state"] as? [String: Any] {
                scene.injectControllers([state])
            } else {
                scene.injectControllers([])
            }
        default:
            errors.append("Error: unknown inject \"\(inject)\"")
        }
    }

    private static func applyDispatch(
        _ dispatch: [String: Any],
        to scene: JavaScriptScene,
        errors: inout [String]
    ) {
        let type = dispatch["type"] as? String ?? ""
        let id: Int?
        if let texture = dispatch["texture"] as? String {
            id = scene.textureID(forURL: texture)
        } else if let asset = dispatch["asset"] as? String {
            id = scene.assetID(forURL: asset)
        } else if let call = dispatch["call"] as? String {
            id = scene.pendingHostCallID(named: call)
        } else if let fetch = dispatch["fetch"] as? String {
            id = scene.pendingFetchID(forURL: fetch)
        } else if dispatch["target"] == nil {
            // No target means the scene itself, as the node and web runners
            // spell it. Looking up the empty name matched the mounted Scene
            // only because three.js gives it an empty name by default.
            id = 0
        } else {
            id = scene.objectID(named: dispatch["target"] as? String ?? "")
        }
        guard let id else {
            errors.append("Error: no target for dispatch \(dispatch)")
            return
        }
        var payload = dispatch["payload"] as? [String: Any] ?? [:]
        if let other = payload["other"] as? String {
            payload["other"] = scene.objectID(named: other) ?? 0
        }
        scene.dispatch(type: type, id: id, payload: payload)
    }

    private static func applyTransformSync(
        _ records: [[String: Any]],
        to scene: JavaScriptScene,
        errors: inout [String]
    ) {
        var flat: [Float] = []
        for record in records {
            guard let id = objectID(record, in: scene, errors: &errors) else { continue }
            let position = floats(record["position"]) ?? [0, 0, 0]
            let quaternion = floats(record["quaternion"]) ?? [0, 0, 0, 1]
            let scale = floats(record["scale"]) ?? [1, 1, 1]
            flat.append(Float(id))
            flat.append(contentsOf: position)
            flat.append(contentsOf: quaternion)
            flat.append(contentsOf: scale)
            // A real consumer moved the entity before it called sync.
            scene.setNativeWorldTransform(
                id: id,
                position: SIMD3(position[0], position[1], position[2]),
                rotation: simd_quatf(
                    ix: quaternion[0],
                    iy: quaternion[1],
                    iz: quaternion[2],
                    r: quaternion[3]
                ),
                scale: SIMD3(scale[0], scale[1], scale[2])
            )
        }
        scene.sync(records: flat)
    }

    private static func applyCharacterSync(
        _ records: [[String: Any]],
        to scene: JavaScriptScene,
        errors: inout [String]
    ) {
        var flat: [Float] = []
        for record in records {
            guard let id = objectID(record, in: scene, errors: &errors) else { continue }
            let position = floats(record["position"]) ?? [0, 0, 0]
            flat.append(Float(id))
            flat.append(contentsOf: position)
            flat.append(record["isOnGround"] as? Bool == true ? 1 : 0)
            flat.append(contentsOf: floats(record["velocity"]) ?? [0, 0, 0])
            // The controller moved the character before it reported the pose.
            scene.setNativeWorldTransform(
                id: id,
                position: SIMD3(position[0], position[1], position[2]),
                rotation: simd_quatf(ix: 0, iy: 0, iz: 0, r: 1),
                scale: SIMD3(1, 1, 1)
            )
        }
        scene.syncCharacter(records: flat)
    }

    /// SPEC 14.10 allows both spellings: `{"hostEvent": "ping", "payload": …}`
    /// and `{"hostEvent": {"name": "ping", "payload": …}}`.
    private static func applyHostEvent(
        _ step: [String: Any],
        to scene: JavaScriptScene,
        errors: inout [String]
    ) {
        if let name = step["hostEvent"] as? String {
            scene.send(name: name, payload: step["payload"] as? [String: Any] ?? [:])
            return
        }
        guard let event = step["hostEvent"] as? [String: Any],
              let name = event["name"] as? String else {
            errors.append("Error: hostEvent needs a name")
            return
        }
        scene.send(name: name, payload: event["payload"] as? [String: Any] ?? [:])
    }

    // MARK: - Shared readers

    /// `[id, playing, currentTime, duration]` per record, for audio and video.
    private static func mediaRecords(
        _ records: [[String: Any]],
        in scene: JavaScriptScene,
        errors: inout [String]
    ) -> [Float] {
        var flat: [Float] = []
        for record in records {
            guard let id = objectID(record, in: scene, errors: &errors) else { continue }
            flat.append(Float(id))
            flat.append(record["playing"] as? Bool == true ? 1 : 0)
            flat.append(Float(doubleValue(record["currentTime"]) ?? 0))
            flat.append(Float(doubleValue(record["duration"]) ?? 0))
        }
        return flat
    }

    private static func objectID(
        _ record: [String: Any],
        in scene: JavaScriptScene,
        errors: inout [String]
    ) -> Int? {
        let name = record["target"] as? String ?? ""
        guard let id = scene.objectID(named: name) else {
            errors.append("Error: no object named \(name)")
            return nil
        }
        return id
    }

    public static func vector(_ value: Any?) -> SIMD3<Float>? {
        guard let values = floats(value), values.count >= 3 else { return nil }
        return SIMD3(values[0], values[1], values[2])
    }

    public static func floats(_ value: Any?) -> [Float]? {
        (value as? [Any])?.compactMap { ($0 as? NSNumber)?.floatValue }
    }

    public static func intValue(_ value: Any?) -> Int? {
        (value as? NSNumber)?.intValue
    }

    public static func doubleValue(_ value: Any?) -> Double? {
        (value as? NSNumber)?.doubleValue
    }
}

#endif

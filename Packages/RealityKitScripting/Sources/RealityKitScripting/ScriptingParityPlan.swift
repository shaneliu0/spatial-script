//
//  ScriptingParityPlan.swift
//  RealityKitScripting
//
//  Created by Shane Liu on 9/9/26.
//

import Foundation
import RealityKit

/// Runs a SPEC section 9 step plan against a scene with a fixed delta, so the
/// same plan produces the same state on every backend. This is the Mac side of
/// the cross-backend parity gate in SPEC section 11.
@MainActor
public enum ScriptingParityPlan {
    /// One step of the plan, in the conformance step vocabulary.
    public struct Step: Sendable {
        public let raw: [String: any Sendable]

        public init(_ raw: [String: any Sendable]) {
            self.raw = raw
        }
    }

    public struct Outcome: Sendable {
        public var frames: Int
        public var errors: [String]
    }

    /// Applies every step in order. `frames` steps tick exactly `deltaTime`;
    /// every other step is applied at the frame the plan has reached.
    /// Waits for the display loop to deliver `count` ticks to `scene`.
    ///
    /// The plan cannot tick the scene itself: RealityKit steps physics inside
    /// its own frame, so a synchronous loop on the main actor would advance the
    /// core with the simulation frozen. Instead the scene is given a frame
    /// budget and the plan waits for the renderer to spend it.
    private static func advance(_ scene: JavaScriptScene, frames count: Int) async -> Int {
        guard count > 0 else { return 0 }
        let start = scene.appliedFrames
        scene.allowPlanFrames(count)
        ScriptingRuntime.isPaused = false

        // Generous: 300 frames at 120 Hz is 2.5 s, and a stalled window must
        // not hang the request forever.
        let deadline = Date().addingTimeInterval(2 + Double(count) / 30)
        while scene.appliedFrames - start < count, Date() < deadline {
            try? await Task.sleep(for: .milliseconds(2))
        }
        ScriptingRuntime.isPaused = true
        scene.allowPlanFrames(0)
        return scene.appliedFrames - start
    }

    @discardableResult
    public static func run(
        _ steps: [[String: Any]],
        on scene: JavaScriptScene,
        deltaTime: TimeInterval
    ) async -> Outcome {
        var frames = 0
        var errors: [String] = []
        let plan = steps.isEmpty ? [["frames": 3]] : steps

        for step in plan {
            if let count = intValue(step["frames"]) {
                let applied = await advance(scene, frames: max(0, count))
                frames += applied
                if applied < max(0, count) {
                    errors.append("Error: only \(applied) of \(count) frames were rendered")
                }
                continue
            }

            if let inject = step["inject"] as? String {
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
                default:
                    errors.append("Error: unknown inject \"\(inject)\"")
                }
                continue
            }

            if let dispatch = step["dispatch"] as? [String: Any] {
                let type = dispatch["type"] as? String ?? ""
                let id: Int?
                if let texture = dispatch["texture"] as? String {
                    id = scene.textureID(forURL: texture)
                } else if let asset = dispatch["asset"] as? String {
                    id = scene.assetID(forURL: asset)
                } else {
                    id = scene.objectID(named: dispatch["target"] as? String ?? "")
                }
                guard let id else {
                    errors.append("Error: no target for dispatch \(dispatch)")
                    continue
                }
                var payload = dispatch["payload"] as? [String: Any] ?? [:]
                if let other = payload["other"] as? String {
                    payload["other"] = scene.objectID(named: other) ?? 0
                }
                scene.dispatch(type: type, id: id, payload: payload)
                continue
            }

            if let sync = step["sync"] as? [[String: Any]] {
                var flat: [Float] = []
                for record in sync {
                    guard let id = scene.objectID(named: record["target"] as? String ?? "") else {
                        errors.append("Error: no object named \(record["target"] ?? "")")
                        continue
                    }
                    let position = floats(record["position"]) ?? [0, 0, 0]
                    let quaternion = floats(record["quaternion"]) ?? [0, 0, 0, 1]
                    let scale = floats(record["scale"]) ?? [1, 1, 1]
                    flat.append(Float(id))
                    flat.append(contentsOf: position)
                    flat.append(contentsOf: quaternion)
                    flat.append(contentsOf: scale)
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
                continue
            }

            if let syncBodies = step["syncBodies"] as? [[String: Any]] {
                var flat: [Float] = []
                for record in syncBodies {
                    guard let id = scene.objectID(named: record["target"] as? String ?? "") else { continue }
                    flat.append(Float(id))
                    flat.append(contentsOf: floats(record["linear"]) ?? [0, 0, 0])
                    flat.append(contentsOf: floats(record["angular"]) ?? [0, 0, 0])
                    flat.append(record["sleeping"] as? Bool == true ? 1 : 0)
                }
                scene.syncBodies(records: flat)
                continue
            }

            if let input = step["setInput"] as? [String: Any] {
                scene.setInput(input)
                continue
            }

            if step["dispose"] != nil {
                scene.dispose()
                continue
            }

            errors.append("Error: unknown step \(step)")
        }

        ScriptingRuntime.isPaused = true
        scene.allowPlanFrames(0)
        return Outcome(frames: frames, errors: errors)
    }

    static func vector(_ value: Any?) -> SIMD3<Float>? {
        guard let values = floats(value), values.count >= 3 else { return nil }
        return SIMD3(values[0], values[1], values[2])
    }

    static func floats(_ value: Any?) -> [Float]? {
        (value as? [Any])?.compactMap { ($0 as? NSNumber)?.floatValue }
    }

    static func intValue(_ value: Any?) -> Int? {
        (value as? NSNumber)?.intValue
    }
}

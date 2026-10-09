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
        // SPEC 14.13a: a plan sees only injected input, so the pointer the
        // developer happens to be holding cannot change the result.
        ScriptingInputRouter.shared.suppressesLiveInput = true

        for step in plan {
            if let count = intValue(step["frames"]) {
                // SPEC 14.10: an inactive scene does not tick, so a plan that
                // deactivated it is asking for time that deliberately does not
                // pass. That is the step doing its job, not a stalled window.
                guard scene.isActive else { continue }
                let applied = await advance(scene, frames: max(0, count))
                frames += applied
                if applied < max(0, count) {
                    errors.append("Error: only \(applied) of \(count) frames were rendered")
                }
                continue
            }

            // Every other step kind is the conformance vocabulary, applied by
            // the interpreter both runners share.
            if ScriptingSceneStep.apply(step, to: scene, errors: &errors) { continue }

            errors.append("Error: unknown step \(step)")
        }

        ScriptingRuntime.isPaused = true
        scene.allowPlanFrames(0)
        ScriptingInputRouter.shared.suppressesLiveInput = false
        return Outcome(frames: frames, errors: errors)
    }

    static func intValue(_ value: Any?) -> Int? {
        ScriptingSceneStep.intValue(value)
    }
}

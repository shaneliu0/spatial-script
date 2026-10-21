//
//  ScriptingParityPlan.swift
//  RealityKitScripting
//
//  Created by Shane Liu on 9/9/26.
//

// SPEC 11: the dev transport and everything that only exists to serve it
// are compiled out of release builds.
#if DEBUG
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
    private static func advance(
        _ scene: JavaScriptScene,
        frames count: Int,
        errors: inout [String]
    ) async -> Int {
        guard count > 0 else { return 0 }
        let began = Date()
        let start = scene.appliedFrames
        ScriptingRuntime.isPaused = false

        // The wait is on *progress*, not on a wall clock guess at the frame
        // rate: a scene of 5000 objects rendering at 10 fps needs 12 s for 120
        // frames and used to be cut off at 6, which read as an accounting bug
        // when it was really a slow scene. A window that has genuinely stopped
        // delivering ticks — occluded, or on an idle display — is given up on
        // after `stall` seconds without a frame, and no plan may run longer
        // than `limit` whatever happens.
        let stall = 3.0
        let limit = Date().addingTimeInterval(120)
        var deadline = Date().addingTimeInterval(stall)
        var seen = scene.appliedFrames
        // The budget is granted up front and the *tick* holds each frame while
        // a load is in flight (SPEC 14.13a), so the plan keeps full display
        // pacing and still cannot step over a load. All this loop does is
        // notice a load that never answers.
        scene.allowPlanFrames(count)
        var loadWaitStarted: Date?
        while scene.appliedFrames - start < count, Date() < deadline, Date() < limit {
            if scene.pendingLoads > 0 {
                let waiting = loadWaitStarted ?? Date()
                loadWaitStarted = waiting
                if Date().timeIntervalSince(waiting) > 10 {
                    errors.append(
                        "Error: a resource load did not settle within 10 s: "
                            + scene.pendingLoadURLs.joined(separator: ", ")
                    )
                    break
                }
                // A load in flight is progress of its own kind: the frame is
                // waiting on purpose, not stalled.
                deadline = Date().addingTimeInterval(stall)
            } else {
                loadWaitStarted = nil
            }
            try? await Task.sleep(for: .milliseconds(2))
            if scene.appliedFrames != seen {
                seen = scene.appliedFrames
                deadline = Date().addingTimeInterval(stall)
            }
        }
        ScriptingRuntime.isPaused = true
        scene.allowPlanFrames(0)
        lastAdvanceSeconds = Date().timeIntervalSince(began)
        return scene.appliedFrames - start
    }

    /// How long the last `frames` step waited, so a shortfall can say whether
    /// the scene was slow or the window had stopped rendering entirely.
    private static var lastAdvanceSeconds: TimeInterval = 0


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

        // SPEC 14.10: a plan may deactivate the scene on purpose. A scene that
        // was inactive before the plan touched it is a different thing: the
        // window is hidden, miniaturised or on a sleeping display, and every
        // `frames` step would silently deliver nothing.
        var planDeactivated = false
        for step in plan {
            if let active = step["setActive"] as? Bool, !active { planDeactivated = true }
            if let count = intValue(step["frames"]) {
                guard scene.isActive else {
                    if !planDeactivated {
                        errors.append(
                            "Error: the scene is inactive, so \(count) frames were not rendered. "
                                + "The app window is hidden, miniaturised, or on a display that "
                                + "is asleep (SPEC 14.10)."
                        )
                    }
                    continue
                }
                let applied = await advance(scene, frames: max(0, count), errors: &errors)
                frames += applied
                if applied < max(0, count) {
                    let seconds = String(format: "%.1f", lastAdvanceSeconds)
                    errors.append(
                        "Error: only \(applied) of \(count) frames were rendered in \(seconds)s "
                            + "(\(scene.tickDiagnostics)). A window that is not frontmost is "
                            + "throttled by the display server."
                    )
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

#endif

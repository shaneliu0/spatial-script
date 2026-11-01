//
//  ScriptingHandTracking.swift
//  RealityKitScripting
//
//  Created by Shane Liu on 9/9/26.
//

import Foundation
#if os(visionOS)
import ARKit
import RealityKit
#endif

/// Supplies the hand state SPEC 3.8 polls. visionOS reads ARKit; every other
/// platform reports `null` hands.
@MainActor
final class ScriptingHandTracking {
    enum Chirality {
        case left
        case right
    }

    static let shared = ScriptingHandTracking()

#if os(visionOS)
    private var session: ARKitSession?
    private var provider: HandTrackingProvider?
    private var latest: [String: [String: Any]] = [:]
    private var updateTask: Task<Void, Never>?
#endif

    private var users = 0

    private init() {}

    /// ARKit sessions and providers are single use, so tracking runs once for
    /// however many scenes are alive and is torn down when the last one goes.
    func retain() {
        users += 1
        if users == 1 { start() }
    }

    func release() {
        users = max(0, users - 1)
        if users == 0 { stop() }
    }

    func start() {
#if os(visionOS)
        // ARKitSession and every provider are single use. Build fresh instances
        // on every start and stop the previous session first.
        session?.stop()
        updateTask?.cancel()

        let session = ARKitSession()
        let provider = HandTrackingProvider()
        self.session = session
        self.provider = provider

        updateTask = Task { @MainActor [weak self] in
            do {
                try await session.run([provider])
            } catch {
                return
            }
            for await update in provider.anchorUpdates {
                guard let self else { return }
                let anchor = update.anchor
                let key = anchor.chirality == .left ? "left" : "right"
                latest[key] = Self.json(for: anchor)
            }
        }
#endif
    }

    func stop() {
#if os(visionOS)
        updateTask?.cancel()
        updateTask = nil
        session?.stop()
        session = nil
        provider = nil
        latest.removeAll()
#endif
    }

    func handJSON(chirality: Chirality) -> Any {
#if os(visionOS)
        let key = chirality == .left ? "left" : "right"
        return latest[key] ?? NSNull()
#else
        _ = chirality
        return NSNull()
#endif
    }

#if os(visionOS)
    private static func json(for anchor: HandAnchor) -> [String: Any] {
        var joints: [String: [Float]] = [:]
        if let skeleton = anchor.handSkeleton {
            for joint in skeleton.allJoints where joint.isTracked {
                let world = anchor.originFromAnchorTransform * joint.anchorFromJointTransform
                let transform = Transform(matrix: world)
                joints[jointName(joint.name)] = [
                    transform.translation.x, transform.translation.y, transform.translation.z,
                    transform.rotation.imag.x, transform.rotation.imag.y, transform.rotation.imag.z,
                    transform.rotation.real,
                ]
            }
        }
        return [
            "isTracked": anchor.isTracked,
            "isPinching": isPinching(anchor: anchor),
            "joints": joints,
        ]
    }

    private static func isPinching(anchor: HandAnchor) -> Bool {
        guard
            let skeleton = anchor.handSkeleton,
            case let thumb = skeleton.joint(.thumbTip),
            case let index = skeleton.joint(.indexFingerTip),
            thumb.isTracked, index.isTracked
        else { return false }
        let thumbPosition = (anchor.originFromAnchorTransform * thumb.anchorFromJointTransform).columns.3
        let indexPosition = (anchor.originFromAnchorTransform * index.anchorFromJointTransform).columns.3
        return simd_distance(
            SIMD3(thumbPosition.x, thumbPosition.y, thumbPosition.z),
            SIMD3(indexPosition.x, indexPosition.y, indexPosition.z)
        ) < 0.025
    }

    private static func jointName(_ name: HandSkeleton.JointName) -> String {
        let description = String(describing: name)
        guard let first = description.first else { return description }
        return description.count > 1
            ? first.lowercased() + description.dropFirst()
            : description.lowercased()
    }
#endif
}

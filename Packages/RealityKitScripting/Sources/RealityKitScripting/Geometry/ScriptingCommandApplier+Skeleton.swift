//
//  ScriptingCommandApplier+Skeleton.swift
//  RealityKitScripting
//
//  Created by Shane Liu on 9/9/26.
//

import Foundation
import RealityKit

extension ScriptingCommandApplier {
    /// SPEC 14.13 `skeleton`: `{ joints: { name: [px, py, pz, qx, qy, qz, qw] }, track }`.
    func applySkeleton(id: Int, payload: [String: Any]?) {
        guard let record = records[id] else { return }
        guard let payload else {
            record.extras?.skeleton = nil
            return
        }
        let state = skeletonState(for: record)
        if let track = payload["track"] as? Bool { state.track = track }

        if let joints = payload["joints"] as? [String: Any] {
            // The core sends the whole posed set every time (`Skeleton.toJSON`),
            // so this replaces rather than accumulates: a `reset()` arrives as
            // an empty map and must leave an empty map here too.
            state.pendingJoints.removeAll(keepingCapacity: true)
            for (name, value) in joints {
                guard let numbers = (value as? [Any])?.compactMap({ Self.number($0) }),
                      numbers.count >= 7 else { continue }
                let position = SIMD3<Float>(Float(numbers[0]), Float(numbers[1]), Float(numbers[2]))
                let rotation = simd_quatf(
                    ix: Float(numbers[3]),
                    iy: Float(numbers[4]),
                    iz: Float(numbers[5]),
                    r: Float(numbers[6])
                )
                state.pendingJoints[name] = (position, rotation)
            }
        }
        writeSkeletalPose(record: record, state: state)
    }

    /// SPEC 14.13 `blendShapes`: `{ name: weight }`.
    func applyBlendShapes(id: Int, payload: [String: Any]?) {
        guard let record = records[id] else { return }
        guard let payload else { return }
        let state = skeletonState(for: record)
        // As with the pose: the payload is the whole set of weights the script
        // has set, not a delta.
        state.pendingWeights.removeAll(keepingCapacity: true)
        for (name, value) in payload {
            guard let weight = Self.number(value) else { continue }
            state.pendingWeights[name] = Float(max(0, min(1, weight)))
        }
        writeBlendShapeWeights(record: record, state: state)
    }

    func skeletonState(for record: ScriptingCommandApplier.Record) -> ScriptingSkeletonState {
        if let existing = record.extras?.skeleton { return existing }
        let created = ScriptingSkeletonState()
        record.makeExtras().skeleton = created
        return created
    }

    /// Finds the skinned parts of a freshly loaded asset and records what the
    /// script can address, for the `assetLoaded` payload of SPEC 14.5.
    func indexSkeleton(for record: ScriptingCommandApplier.Record) -> (joints: [String], blendShapes: [String]) {
        guard let container = record.assetContainer else { return ([], []) }
        let state = skeletonState(for: record)
        state.jointNames = []
        state.blendShapeNames = []
        state.poseEntity = nil
        state.blendShapeEntity = nil

        var stack: [Entity] = [container]
        while let entity = stack.popLast() {
            stack.append(contentsOf: entity.children)
            if state.poseEntity == nil,
               let poses = entity.components[SkeletalPosesComponent.self],
               let pose = poses.poses.default {
                state.poseEntity = entity
                state.jointPaths = pose.jointNames
                // USD spells a joint by its path (`root/head`); three.js names
                // the bone (`head`). SPEC 14.5 is a list of names, so the leaf
                // is reported wherever it is unambiguous and the full path is
                // kept when two joints share a leaf.
                state.jointNames = Self.jointDisplayNames(pose.jointNames)
            }
            if state.blendShapeEntity == nil,
               let weights = entity.components[BlendShapeWeightsComponent.self],
               let set = weights.weightSet.default {
                state.blendShapeEntity = entity
                state.blendShapeNames = set.weightNames
            }
        }

        if !state.pendingJoints.isEmpty { writeSkeletalPose(record: record, state: state) }
        if !state.pendingWeights.isEmpty { writeBlendShapeWeights(record: record, state: state) }
        return (state.jointNames, state.blendShapeNames)
    }

    /// SPEC 14.5: a native animation overrides script poses **while it runs**,
    /// so the edits it held back are applied the frame it stops. The core will
    /// not re-send an unchanged pose, so nothing else would ever apply them.
    func replayHeldSkeletonEdits() {
        for record in records.values {
            guard let state = record.extras?.skeleton, state.animationOverrides else { continue }
            guard !(record.animation?.isPlaying ?? false) else { continue }
            state.animationOverrides = false
            if !state.pendingJoints.isEmpty { writeSkeletalPose(record: record, state: state) }
            if !state.pendingWeights.isEmpty { writeBlendShapeWeights(record: record, state: state) }
        }
    }

    private func writeSkeletalPose(
        record: ScriptingCommandApplier.Record,
        state: ScriptingSkeletonState
    ) {
        guard let entity = state.poseEntity else { return }
        guard var component = entity.components[SkeletalPosesComponent.self],
              var pose = component.poses.default else { return }
        // A running native animation owns the pose; SPEC 14.5 says it wins
        // while it plays, so the edits are held until it stops.
        if let animation = record.animation, animation.isPlaying {
            state.animationOverrides = true
            return
        }
        state.animationOverrides = false
        var wrote = false
        for (name, value) in state.pendingJoints {
            guard let name = Self.resolveJoint(name, in: state) else {
                warnings.warnOnce(
                    "joint '\(name)' is not in this skeleton and was ignored.",
                    key: "skeleton-joint-\(name)"
                )
                continue
            }
            guard pose[name] != nil else {
                warnings.warnOnce(
                    "joint '\(name)' is not in this skeleton and was ignored.",
                    key: "skeleton-joint-\(name)"
                )
                continue
            }
            var transform = pose[name] ?? Transform()
            transform.translation = value.0
            transform.rotation = value.1
            pose[name] = transform
            wrote = true
        }
        guard wrote else { return }
        component.poses.default = pose
        entity.components.set(component)
    }

    private func writeBlendShapeWeights(
        record: ScriptingCommandApplier.Record,
        state: ScriptingSkeletonState
    ) {
        guard let entity = state.blendShapeEntity else { return }
        guard var component = entity.components[BlendShapeWeightsComponent.self],
              var set = component.weightSet.default else { return }
        var wrote = false
        for (name, weight) in state.pendingWeights {
            guard let index = set.weightNames.firstIndex(of: name) else {
                warnings.warnOnce(
                    "blend shape '\(name)' is not on this asset and was ignored.",
                    key: "blend-shape-\(name)"
                )
                continue
            }
            set.weights[index] = weight
            wrote = true
        }
        guard wrote else { return }
        _ = component.weightSet.set(set)
        entity.components.set(component)
    }

    /// The name a script uses for each joint: the leaf where that is unique,
    /// the full path where it is not.
    static func jointDisplayNames(_ paths: [String]) -> [String] {
        var leaves: [String: Int] = [:]
        for path in paths {
            let leaf = path.split(separator: "/").last.map(String.init) ?? path
            leaves[leaf, default: 0] += 1
        }
        return paths.map { path in
            let leaf = path.split(separator: "/").last.map(String.init) ?? path
            return leaves[leaf] == 1 ? leaf : path
        }
    }

    /// Maps a scripted joint name onto the path RealityKit stores it under.
    static func resolveJoint(_ name: String, in state: ScriptingSkeletonState) -> String? {
        if state.jointPaths.contains(name) { return name }
        let matches = state.jointPaths.filter {
            ($0.split(separator: "/").last.map(String.init) ?? $0) == name
        }
        return matches.count == 1 ? matches[0] : nil
    }

    /// SPEC 14.13 `syncSkeleton(id, joints)`, emitted only for assets that
    /// asked to be tracked.
    func trackedSkeletons() -> [(id: Int, joints: [String: [Float]])] {
        var result: [(Int, [String: [Float]])] = []
        for record in records.values {
            guard let state = record.extras?.skeleton, state.track,
                  let entity = state.poseEntity,
                  let pose = entity.components[SkeletalPosesComponent.self]?.poses.default else { continue }
            var joints: [String: [Float]] = [:]
            let names = Self.jointDisplayNames(pose.jointNames)
            for (index, path) in pose.jointNames.enumerated() {
                guard let transform = pose[path] else { continue }
                joints[names.indices.contains(index) ? names[index] : path] = [
                    transform.translation.x, transform.translation.y, transform.translation.z,
                    transform.rotation.imag.x, transform.rotation.imag.y, transform.rotation.imag.z,
                    transform.rotation.real,
                ]
            }
            result.append((record.id, joints))
        }
        return result.map { (id: $0.0, joints: $0.1) }
    }
}

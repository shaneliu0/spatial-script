//
//  ScriptingCommandApplier+Sync.swift
//  RealityKitScripting
//
//  Created by Shane Liu on 9/9/26.
//

import Foundation
import RealityKit

extension ScriptingCommandApplier {
    /// Records for objects RealityKit owns this frame: dynamic bodies, entities
    /// under manipulation, and anchors that have resolved a pose.
    func nativeDrivenSyncRecords() -> [Float] {
        var values: [Float] = []
        for record in records.values {
            let isDynamic = record.bodyType == "dynamic"
            let isAnchor = record.kind == .anchor
            guard isDynamic || record.isManipulated || isAnchor else { continue }
            // A detached entity's world matrix is really its local one, which
            // the core would convert against a parent that no longer applies.
            guard isAttachedToRoot(record.entity) else { continue }
            if isAnchor, let anchor = record.entity as? AnchorEntity {
                let anchored = anchor.isAnchored
                if anchored != record.isAnchoredState {
                    record.isAnchoredState = anchored
                    dispatch?(anchored ? "anchored" : "unanchored", record.id, nil)
                }
                guard anchored else { continue }
            }
            let matrix = record.entity.transformMatrix(relativeTo: nil)
            let transform = Transform(matrix: matrix)
            values.append(Float(record.id))
            values.append(contentsOf: [transform.translation.x, transform.translation.y, transform.translation.z])
            let rotation = transform.rotation
            values.append(contentsOf: [rotation.imag.x, rotation.imag.y, rotation.imag.z, rotation.real])
            values.append(contentsOf: [transform.scale.x, transform.scale.y, transform.scale.z])
        }
        return values
    }

    /// RealityKit does not write `PhysicsMotionComponent` back from the
    /// simulation, so velocity is measured by differencing the world pose of
    /// every dynamic body between frames.
    func sampleBodyMotion(deltaTime: TimeInterval) {
        let dt = Float(deltaTime)
        for record in records.values where record.bodyType == "dynamic" {
            let transform = Transform(matrix: record.entity.transformMatrix(relativeTo: nil))
            let position = transform.translation
            let orientation = transform.rotation

            if dt > 1e-6, let previousPosition = record.previousWorldPosition {
                record.linearVelocity = (position - previousPosition) / dt
            }
            if dt > 1e-6, let previousOrientation = record.previousWorldOrientation {
                record.angularVelocity = Self.angularVelocity(
                    from: previousOrientation,
                    to: orientation,
                    deltaTime: dt
                )
            }
            record.previousWorldPosition = position
            record.previousWorldOrientation = orientation

            let speed = simd_length(record.linearVelocity)
            let spin = simd_length(record.angularVelocity)
            if speed < ScriptingMotionSampling.sleepSpeedThreshold,
               spin < ScriptingMotionSampling.sleepSpeedThreshold {
                record.restingFrames += 1
            } else {
                record.restingFrames = 0
            }
        }
    }

    static func angularVelocity(
        from previous: simd_quatf,
        to current: simd_quatf,
        deltaTime: Float
    ) -> SIMD3<Float> {
        var delta = current * previous.inverse
        if delta.real < 0 { delta = simd_quatf(vector: -delta.vector) }
        let imaginaryLength = simd_length(delta.imag)
        guard imaginaryLength > 1e-8 else { return .zero }
        let angle = 2 * atan2(imaginaryLength, delta.real)
        return (delta.imag / imaginaryLength) * (angle / deltaTime)
    }

    func bodyVelocitySyncRecords() -> [Float] {
        var values: [Float] = []
        for record in records.values where record.bodyType == "dynamic" {
            values.append(Float(record.id))
            values.append(contentsOf: [
                record.linearVelocity.x, record.linearVelocity.y, record.linearVelocity.z,
                record.angularVelocity.x, record.angularVelocity.y, record.angularVelocity.z,
                record.isSleeping ? 1 : 0,
            ])
        }
        return values
    }

    /// Places an entity where a native driver would have put it. Used by the
    /// conformance harness when a case injects a `sync` record.
    func setNativeWorldTransform(
        id: Int,
        position: SIMD3<Float>,
        rotation: simd_quatf,
        scale: SIMD3<Float>
    ) {
        guard let record = records[id] else { return }
        record.entity.setTransformMatrix(
            Transform(scale: scale, rotation: rotation, translation: position).matrix,
            relativeTo: nil
        )
    }

    /// SPEC 3.7 keeps every mesh raycastable. Under the lazy strategy the
    /// shapes are built the first time a ray actually asks for them.
    func materializeDeferredColliders() {
        guard Self.colliderStrategy == .lazy else { return }
        for record in records.values
        where record.kind == .mesh && !record.needsCollisionShape
            && isAttachedToRoot(record.entity)
            && record.entity.components[CollisionComponent.self] == nil {
            record.needsCollisionShape = true
            refreshCollisionShape(record)
        }
    }
}

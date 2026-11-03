//
//  ScriptingCommandApplier+Raycast.swift
//  SpatialScriptRuntime
//
//  Created by Shane Liu on 9/9/26.
//

import Foundation
import RealityKit

extension ScriptingCommandApplier {
    /// SPEC 6's unbounded ray, as a length RealityKit will actually trace:
    /// 100 km is past anything a scene can hold, where `greatestFiniteMagnitude`
    /// makes `scene.raycast` return no hits at all.
    static let unboundedRayLength: Float = 100_000

    /// A hit is only reported for a visible, attached mesh, and only for a
    /// direct child of the mounted root when the query is not recursive.
    func isRaycastCandidate(_ record: Record, recursive: Bool) -> Bool {
        guard isAttachedToRoot(record.entity) else { return false }
        var node: Entity? = record.entity
        while let current = node, current !== root {
            if !current.isEnabled { return false }
            node = current.parent
        }
        return recursive || record.entity.parent === root
    }

    func raycast(
        origin: SIMD3<Float>,
        direction: SIMD3<Float>,
        maxDistance: Float,
        recursive: Bool = true
    ) -> [Float] {
        materializeDeferredColliders()
        guard let scene = root.scene else {
            return headlessRaycast(
                origin: origin,
                direction: direction,
                maxDistance: maxDistance,
                recursive: recursive
            )
        }
        // SPEC 6: a maxDistance below zero means unbounded. `scene.raycast`
        // returns nothing at all when the length is not a workable number, so
        // "unbounded" is a distance far beyond any scene rather than the
        // largest float there is.
        let length = maxDistance.isFinite && maxDistance > 0 ? maxDistance : Self.unboundedRayLength
        let hits = scene.raycast(
            origin: origin,
            direction: simd_length(direction) > 0 ? simd_normalize(direction) : SIMD3(0, 0, -1),
            length: length,
            query: .all,
            mask: .all,
            relativeTo: nil
        )
        // SPEC 3.7: at most one hit per object, over visible meshes only. Every
        // child of a loaded asset and every extra collision shape walks up to
        // the same record, so without this one object reports many hits.
        var values: [Float] = []
        var seen: Set<Int> = []
        for hit in hits.sorted(by: { $0.distance < $1.distance }) {
            guard let record = nearestRecord(from: hit.entity),
                  record.mesh != nil,
                  isRaycastCandidate(record, recursive: recursive),
                  seen.insert(record.id).inserted else { continue }
            values.append(Float(record.id))
            values.append(contentsOf: [hit.position.x, hit.position.y, hit.position.z])
            values.append(contentsOf: [hit.normal.x, hit.normal.y, hit.normal.z])
            values.append(hit.distance)
        }
        return values
    }

    /// Ray against every mesh's bounds, for hosts with no RealityKit scene
    /// (unit tests and the conformance runner). `scene.raycast` needs a scene.
    func headlessRaycast(
        origin: SIMD3<Float>,
        direction: SIMD3<Float>,
        maxDistance: Float,
        recursive: Bool
    ) -> [Float] {
        let length = maxDistance.isFinite && maxDistance > 0 ? maxDistance : Self.unboundedRayLength
        guard simd_length(direction) > 0 else { return [] }
        let worldDirection = simd_normalize(direction)

        var hits: [(id: Int, point: SIMD3<Float>, normal: SIMD3<Float>, distance: Float)] = []
        for record in records.values {
            guard let mesh = record.mesh,
                  isRaycastCandidate(record, recursive: recursive) else { continue }
            let toWorld = record.entity.transformMatrix(relativeTo: nil)
            let toLocal = toWorld.inverse
            let localOrigin = (toLocal * SIMD4(origin, 1)).spatialXYZ
            let localDirection = (toLocal * SIMD4(worldDirection, 0)).spatialXYZ
            guard simd_length(localDirection) > 1e-8 else { continue }
            guard let hit = Self.intersect(
                bounds: mesh.bounds,
                origin: localOrigin,
                direction: localDirection
            ) else { continue }
            let worldPoint = (toWorld * SIMD4(hit.point, 1)).spatialXYZ
            let distance = simd_distance(worldPoint, origin)
            guard distance <= length else { continue }
            var worldNormal = (toWorld * SIMD4(hit.normal, 0)).spatialXYZ
            if simd_length(worldNormal) > 1e-8 { worldNormal = simd_normalize(worldNormal) }
            hits.append((record.id, worldPoint, worldNormal, distance))
        }

        hits.sort { $0.distance < $1.distance }
        // SPEC 3.7: at most one hit per object. One record can produce several
        // bounds intersections when it carries more than one shape.
        var values: [Float] = []
        var seen: Set<Int> = []
        for hit in hits where seen.insert(hit.id).inserted {
            values.append(Float(hit.id))
            values.append(contentsOf: [hit.point.x, hit.point.y, hit.point.z])
            values.append(contentsOf: [hit.normal.x, hit.normal.y, hit.normal.z])
            values.append(hit.distance)
        }
        return values
    }

    static func intersect(
        bounds: BoundingBox,
        origin: SIMD3<Float>,
        direction: SIMD3<Float>
    ) -> (point: SIMD3<Float>, normal: SIMD3<Float>)? {
        var near = -Float.greatestFiniteMagnitude
        var far = Float.greatestFiniteMagnitude
        var axis = 0
        var sign: Float = 1

        for index in 0..<3 {
            let d = direction[index]
            let minimum = bounds.min[index]
            let maximum = bounds.max[index]
            if abs(d) < 1e-8 {
                if origin[index] < minimum || origin[index] > maximum { return nil }
                continue
            }
            var t1 = (minimum - origin[index]) / d
            var t2 = (maximum - origin[index]) / d
            var entrySign: Float = -1
            if t1 > t2 {
                swap(&t1, &t2)
                entrySign = 1
            }
            if t1 > near {
                near = t1
                axis = index
                sign = entrySign
            }
            far = min(far, t2)
            if near > far { return nil }
        }

        guard far >= 0 else { return nil }
        let distance = near >= 0 ? near : 0
        var normal = SIMD3<Float>.zero
        normal[axis] = sign
        return (origin + direction * distance, normal)
    }
}

//
//  ScriptingCommandApplier+Collision.swift
//  SpatialScriptRuntime
//
//  Created by Shane Liu on 9/9/26.
//

import Foundation
import RealityKit

extension ScriptingCommandApplier {
    func refreshCollisionShape(_ record: Record) {
        let isInputTarget = record.interactive.tap || record.interactive.hover || record.interactive.drag
        let needsShape: Bool = if Self.colliderStrategy == .lazy {
            isInputTarget || record.bodyType != nil || record.needsCollisionShape
        } else {
            isInputTarget || record.bodyType != nil || record.kind == .mesh
        }
        guard needsShape else { return }
        guard let shape = collisionShape(for: record) else { return }
        // Hit-test-only meshes keep their own group as the mask: an empty mask makes
        // RealityKit skip the shape for gesture targeting on macOS, and a mask that
        // includes the physics group would let static meshes block physics bodies.
        let filter: CollisionFilter = record.bodyType == nil
            ? CollisionFilter(group: Self.hitTestGroup, mask: Self.hitTestGroup)
            : CollisionFilter(group: Self.physicsGroup, mask: Self.physicsGroup)
        var component = CollisionComponent(shapes: [shape], filter: filter)
        component.mode = record.isTrigger ? .trigger : .default
        record.entity.components.set(component)
        if resolvedShapeKind(for: record) == "mesh" { installStaticMesh(for: record, filter: filter) }
    }

    /// SPEC 3.7's `"mesh"`: a static triangle mesh, the only shape that follows
    /// a concave surface. `ShapeResource.generateStaticMesh` is asynchronous, so
    /// the bounding shape stands in for the frame it takes to build.
    private func installStaticMesh(for record: Record, filter: CollisionFilter) {
        guard let mesh = record.mesh else { return }
        let generation = loadGeneration
        let id = record.id
        Task { @MainActor [weak self] in
            guard let self else { return }
            let shape = try? await ShapeResource.generateStaticMesh(from: mesh)
            guard let shape, self.isCurrent(generation), let record = self.records[id],
                  record.bodyShape == "mesh" else { return }
            var component = CollisionComponent(shapes: [shape], filter: filter)
            component.mode = record.isTrigger ? .trigger : .default
            record.entity.components.set(component)
            record.hasStaticMeshShape = true
        }
    }

    private func collisionShape(for record: Record) -> ShapeResource? {
        guard let mesh = record.mesh else { return nil }
        let bounds = mesh.bounds
        let extents = bounds.extents
        let kind = resolvedShapeKind(for: record)
        let geometryKey = record.geometryKey ?? "\(record.id)"
        let key = "\(kind)|\(geometryKey)|\(extents)|\(bounds.center)"
        bindShape(record, key: key)
        return resources.shape(forKey: key) {
            switch kind {
            case "sphere":
                ShapeResource.generateSphere(radius: max(extents.x, max(extents.y, extents.z)) / 2)
                    .offsetBy(translation: bounds.center)
            case "capsule":
                ShapeResource.generateCapsule(
                    height: extents.y,
                    radius: max(extents.x, extents.z) / 2
                ).offsetBy(translation: bounds.center)
            case "convex":
                ShapeResource.generateConvex(from: mesh)
            default:
                ShapeResource.generateBox(size: extents).offsetBy(translation: bounds.center)
            }
        }
    }

    private func resolvedShapeKind(for record: Record) -> String {
        // A non-static body never reaches here with `mesh`: the rigid body
        // applier rewrites it to `convex` and warns, so the dump reports the
        // shape that exists (SPEC 3.7).
        if record.bodyShape != "auto" { return record.bodyShape }
        switch record.geometryType {
        case "BoxGeometry", "PlaneGeometry": return "box"
        case "SphereGeometry": return "sphere"
        case "CapsuleGeometry": return "capsule"
        default: return record.bodyType == nil ? "box" : "convex"
        }
    }
}

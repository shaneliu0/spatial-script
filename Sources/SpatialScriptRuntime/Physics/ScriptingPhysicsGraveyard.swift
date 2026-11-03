//
//  ScriptingPhysicsGraveyard.swift
//  SpatialScriptRuntime
//
//  Created by Shane Liu on 9/9/26.
//

import Foundation
import RealityKit

/// Holds entities that took part in physics for a couple of frames after the
/// script let them go.
///
/// RealityKit deletes joints lazily: `PhysicsJointsComponentStateImpl` collects
/// them when the component changes and frees them in the next
/// `PhysicsSystem::update`. If the pinned entity has already left the scene by
/// then, `ConstraintKernelBase::onRemoveConstraint` dereferences freed memory
/// and the process dies with EXC_BAD_ACCESS. So the joints and the pins go
/// first, and the bodies and the entities follow a frame later.
@MainActor
final class ScriptingPhysicsGraveyard {
    static let shared = ScriptingPhysicsGraveyard()

    /// Three frames: one for RealityKit to notice the joints component changed,
    /// one for `processDirtyComponents` to run the deferred deletion, and one
    /// of margin before the entity is freed.
    static let framesToHold = 3

    private struct Entry {
        let entity: Entity
        var framesRemaining: Int
    }

    private var entries: [Entry] = []

    private init() {}

    var pendingCount: Int { entries.count }

    /// The caller has already cleared the joints and the pins. The entity keeps
    /// its body and its place in the tree until `advance` retires it.
    func stage(_ entity: Entity) {
        entries.append(Entry(entity: entity, framesRemaining: Self.framesToHold))
    }

    /// Called once per display frame, before anything else runs.
    func advance() {
        guard !entries.isEmpty else { return }
        var remaining: [Entry] = []
        remaining.reserveCapacity(entries.count)
        for var entry in entries {
            entry.framesRemaining -= 1
            if entry.framesRemaining > 0 {
                remaining.append(entry)
            } else {
                retire(entry.entity)
            }
        }
        entries = remaining
    }

    /// Retires everything now. Only safe when the RealityKit scene itself is
    /// going away, or in a host with no physics system running.
    func drain() {
        let staged = entries
        entries.removeAll()
        for entry in staged { retire(entry.entity) }
    }

    private func retire(_ entity: Entity) {
        entity.components.remove(PhysicsBodyComponent.self)
        entity.components.remove(PhysicsMotionComponent.self)
        entity.components.remove(CollisionComponent.self)
        entity.components.remove(GeometricPinsComponent.self)
        entity.removeFromParent()
    }
}

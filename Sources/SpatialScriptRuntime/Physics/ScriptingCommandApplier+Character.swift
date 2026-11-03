//
//  ScriptingCommandApplier+Character.swift
//  SpatialScriptRuntime
//
//  Created by Shane Liu on 9/9/26.
//

import Foundation
import RealityKit

extension ScriptingCommandApplier {
    // MARK: - Character controller (SPEC 14.4)

    func applyCharacterController(id: Int, payload: [String: Any]?) {
        guard let record = records[id] else { return }
        guard let payload else {
            record.entity.components.remove(CharacterControllerComponent.self)
            record.entity.components.remove(CharacterControllerStateComponent.self)
            record.extras?.character = nil
            return
        }
        let state = record.extras?.character ?? {
            let created = ScriptingCharacterState()
            record.makeExtras().character = created
            return created
        }()

        state.radius = Float(Self.number(payload["radius"]) ?? Double(state.radius))
        state.height = Float(Self.number(payload["height"]) ?? Double(state.height))
        state.slopeLimit = Float(Self.number(payload["slopeLimit"]) ?? Double(state.slopeLimit))
        state.stepLimit = Float(Self.number(payload["stepLimit"]) ?? Double(state.stepLimit))
        state.gravity = payload["gravity"] as? Bool ?? state.gravity

        var component = CharacterControllerComponent(
            radius: state.radius,
            height: state.height,
            slopeLimit: state.slopeLimit,
            stepLimit: state.stepLimit
        )
        component.collisionFilter = CollisionFilter(
            group: Self.physicsGroup.union(Self.hitTestGroup),
            mask: .all
        )
        record.entity.components.set(component)
        // A character is native driven like a dynamic body, and RealityKit
        // refuses both a physics body and a controller on one entity.
        record.entity.components.remove(PhysicsBodyComponent.self)
        record.entity.components.remove(PhysicsMotionComponent.self)
        record.bodyType = nil
    }

    func applyCharacterMove(id: Int, delta: SIMD3<Float>) {
        guard let state = records[id]?.extras?.character else { return }
        state.pendingMove += delta
        state.hasPendingMove = true
    }

    func applyCharacterTeleport(id: Int, position: SIMD3<Float>) {
        guard let record = records[id], let state = record.extras?.character else { return }
        record.entity.teleportCharacter(to: position, relativeTo: nil)
        // `teleportCharacter` only moves an entity that belongs to a running
        // scene, so the transform is written as well: the two agree, and a
        // headless host still lands where the script asked.
        record.entity.setPosition(position, relativeTo: nil)
        state.pendingMove = .zero
        state.hasPendingMove = false
        state.fallSpeed = 0
        state.previousPosition = position
    }

    /// Runs every queued displacement through RealityKit once per frame.
    func stepCharacters(deltaTime: TimeInterval) {
        let dt = Float(deltaTime)
        guard dt > 0 else { return }
        let gravity = root.components[PhysicsSimulationComponent.self]?.gravity
            ?? SIMD3<Float>(0, -9.81, 0)

        for record in records.values {
            guard let state = record.extras?.character,
                  record.entity.components[CharacterControllerComponent.self] != nil,
                  isAttachedToRoot(record.entity) else { continue }

            var move = state.pendingMove
            state.pendingMove = .zero
            state.hasPendingMove = false

            if state.gravity {
                // RealityKit's character controller does not fall on its own;
                // the displacement carries the accumulated fall.
                state.fallSpeed += gravity.y * dt
                move.y += state.fallSpeed * dt
            }

            let before = record.entity.position(relativeTo: nil)
            let flags = record.entity.moveCharacter(by: move, deltaTime: dt, relativeTo: nil)
            let after = record.entity.position(relativeTo: nil)

            state.isOnGround = flags.contains(.bottom)
            if state.isOnGround, state.fallSpeed < 0 { state.fallSpeed = 0 }
            state.velocity = dt > 0 ? (after - before) / dt : .zero
            state.previousPosition = after

            if let native = record.entity.components[CharacterControllerStateComponent.self] {
                state.isOnGround = native.isOnGround
                state.velocity = native.velocity
            }
        }
    }

    /// SPEC 14.13 `syncCharacter`: `[id, px, py, pz, isOnGround, vx, vy, vz]`.
    func characterSyncRecords() -> [Float] {
        var values: [Float] = []
        for record in records.values {
            guard let state = record.extras?.character else { continue }
            // A detached entity's world position is really its local one, and
            // the core would convert it against a parent that no longer holds.
            guard isAttachedToRoot(record.entity) else { continue }
            let position = record.entity.position(relativeTo: nil)
            values.append(Float(record.id))
            values.append(contentsOf: [position.x, position.y, position.z])
            values.append(state.isOnGround ? 1 : 0)
            values.append(contentsOf: [state.velocity.x, state.velocity.y, state.velocity.z])
        }
        return values
    }

    // MARK: - Force effects (SPEC 14.4)

    func applyForceField(id: Int, payload: [String: Any]?) {
        guard let record = records[id] else { return }
        guard let payload else {
            record.entity.components.remove(ForceEffectComponent.self)
            record.extras?.forceField = nil
            return
        }
        let state = record.extras?.forceField ?? {
            let created = ScriptingForceFieldState()
            record.makeExtras().forceField = created
            return created
        }()
        state.kind = payload["kind"] as? String ?? state.kind
        state.enabled = payload["enabled"] as? Bool ?? state.enabled
        state.spec = payload

        guard state.enabled else {
            record.entity.components.remove(ForceEffectComponent.self)
            state.applied = false
            return
        }
        if Self.number(payload["radius"]) == nil {
            warnings.warnOnce(
                "This force field has no radius, so it is bounded at "
                    + "\(Self.defaultForceFieldRadius) m rather than acting on the whole scene.",
                key: "force-field-radius"
            )
        }
        guard let effect = Self.forceEffect(kind: Self.forceFieldFamily(state.kind), spec: payload) else {
            state.applied = false
            warnings.warnOnce(
                "force field kind '\(state.kind)' is not known and was ignored.",
                key: "force-field-\(state.kind)"
            )
            return
        }
        record.entity.components.set(ForceEffectComponent(effect: effect))
        state.applied = true
    }

    /// Every one of SPEC 14.4's five effects has a RealityKit counterpart on
    /// macOS 15 and later, so none of them warns on this platform. `radius`
    /// becomes a spherical spatial falloff; `mask` becomes the effect's
    /// collision group mask.
    private static func forceEffect(kind: String, spec: [String: Any]) -> (any ForceEffectBase)? {
        // SPEC 14.4: an effect acts "within radius". Without one it would pull
        // on every body in the scene, so a default bound is applied instead and
        // the caller warns.
        let radius = number(spec["radius"]) ?? defaultForceFieldRadius
        let strength = number(spec["strength"]) ?? 1
        let falloff = SpatialForceFalloff(bounds: .sphere(radius: max(0.0001, radius)))
        // A script's mask is an arbitrary number: anything outside a 32 bit
        // group is every group, which is also the default.
        let mask: CollisionGroup
        if let raw = number(spec["mask"]), raw >= 0, raw <= Double(UInt32.max) {
            mask = CollisionGroup(rawValue: UInt32(raw))
        } else {
            mask = .all
        }

        switch kind {
        case "constant":
            let force = vector(spec["force"]) ?? SIMD3<Float>(0, -1, 0)
            let magnitude = simd_length(force)
            let direction = magnitude > 1e-6 ? force / magnitude : SIMD3<Float>(0, -1, 0)
            return ForceEffect(
                effect: ConstantForceEffect(strength: Double(magnitude), direction: direction),
                spatialFalloff: falloff,
                mask: mask
            )

        case "radial":
            return ForceEffect(
                effect: RadialForceEffect(
                    strength: strength,
                    restDistance: number(spec["minimumDistance"]) ?? 0.01
                ),
                spatialFalloff: Self.radialFalloff(spec: spec, radius: radius),
                mask: mask
            )

        case "vortex":
            return ForceEffect(
                effect: VortexForceEffect(
                    strength: strength,
                    axis: vector(spec["axis"]) ?? SIMD3<Float>(0, 1, 0)
                ),
                spatialFalloff: falloff,
                mask: mask
            )

        case "drag":
            return ForceEffect(
                effect: DragForceEffect(strength: number(spec["coefficient"]) ?? 1),
                spatialFalloff: falloff,
                mask: mask
            )

        case "turbulence":
            // RealityKit's turbulence is shaped by smoothness and speed;
            // SPEC's single noiseScale drives the smoothness.
            return ForceEffect(
                effect: TurbulenceForceEffect(
                    strength: strength,
                    smoothness: number(spec["noiseScale"]) ?? 1,
                    speed: number(spec["speed"]) ?? 1
                ),
                spatialFalloff: falloff,
                mask: mask
            )

        default:
            return nil
        }
    }

    /// The core names a field by its class (`VortexForceField`); this is the
    /// family name the effect table is keyed by.
    static func forceFieldFamily(_ kind: String) -> String {
        var name = kind
        if name.hasSuffix("ForceField") { name.removeLast("ForceField".count) }
        guard let first = name.first else { return kind.lowercased() }
        return first.lowercased() + name.dropFirst()
    }

    /// SPEC's `falloff` names the curve; RealityKit expresses it as the rate
    /// of a spherical spatial falloff.
    private static func radialFalloff(spec: [String: Any], radius: Double) -> SpatialForceFalloff? {
        guard radius > 0 else { return nil }
        let rate: Double
        switch spec["falloff"] as? String ?? "none" {
        case "linear": rate = 1
        case "inverseSquare": rate = 2
        default: rate = 0
        }
        return SpatialForceFalloff(bounds: .sphere(radius: radius), rate: rate)
    }

    /// The bound an unbounded field is given, wide enough for a tabletop scene.
    static let defaultForceFieldRadius: Double = 10

    static func vector(_ value: Any?) -> SIMD3<Float>? {
        guard let array = value as? [Any], array.count >= 3 else { return nil }
        let values = array.compactMap { number($0) }
        guard values.count >= 3 else { return nil }
        return SIMD3(Float(values[0]), Float(values[1]), Float(values[2]))
    }
}

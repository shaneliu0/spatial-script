//
//  ScriptingCommandApplier+Physics.swift
//  SpatialScriptRuntime
//
//  Created by Shane Liu on 9/9/26.
//

import Foundation
import RealityKit

/// The decoded form of a `joint` command.
struct ScriptingJointSpec {
    var type: String
    var bodyA: Int
    var bodyB: Int
    var anchorA: SIMD3<Float>
    var anchorB: SIMD3<Float>
    var axis: SIMD3<Float>
    var limits: ClosedRange<Float>?
}

extension ScriptingCommandApplier {
    func applyRigidBody(id: Int, payload: [String: Any]?) {
        guard let record = records[id] else { return }
        guard let payload else {
            record.bodySpec = [:]
            record.bodyType = nil
            record.isTrigger = false
            record.entity.components.remove(PhysicsBodyComponent.self)
            record.entity.components.remove(PhysicsMotionComponent.self)
            // The collider is still in the physics group, where it would act as
            // an invisible wall and be skipped by gesture targeting. Drop it and
            // let the hit-test rule decide whether a new one is needed.
            record.entity.components.remove(CollisionComponent.self)
            refreshCollisionShape(record)
            return
        }

        record.bodySpec = payload
        let type = payload["type"] as? String ?? "dynamic"
        let shape = payload["shape"] as? String ?? "auto"
        let mass = float(payload["mass"]) ?? 1
        let friction = float(payload["friction"]) ?? 0.5
        let restitution = float(payload["restitution"]) ?? 0.2
        let linearDamping = float(payload["linearDamping"]) ?? 0
        let angularDamping = float(payload["angularDamping"]) ?? 0
        let isTrigger = payload["isTrigger"] as? Bool ?? false
        let gravity = payload["gravity"] as? Bool ?? true

        // The core resolves "auto" and rejects a dynamic triangle mesh before
        // the command is sent, so `shape` is always a concrete shape here.
        if shape == "mesh", type == "dynamic" {
            warnings.warnOnce(
                "RigidBody shape 'mesh' is static only; the body falls back to convex",
                key: "body-mesh-dynamic"
            )
            record.bodyShape = "convex"
        } else {
            record.bodyShape = shape
        }
        record.bodyType = type
        record.isTrigger = isTrigger
        refreshCollisionShape(record)

        guard let collision = record.entity.components[CollisionComponent.self] else {
            warnings.warnOnce(
                "RigidBody on '\(record.entity.name.isEmpty ? "an unnamed object" : record.entity.name)' "
                + "was ignored: the object has no geometry to build a collision shape from",
                key: "body-without-geometry"
            )
            record.bodyType = nil
            return
        }

        // A trigger volume reports overlaps and never pushes. RealityKit gives a
        // solid response to anything that also carries a PhysicsBodyComponent,
        // whatever the collision mode says, so a trigger gets the collider alone.
        if isTrigger {
            record.entity.components.remove(PhysicsBodyComponent.self)
            record.entity.components.remove(PhysicsMotionComponent.self)
            return
        }

        let mode: PhysicsBodyMode = switch type {
        case "static": .static
        case "kinematic": .kinematic
        default: .dynamic
        }
        let material = PhysicsMaterialResource.generate(
            friction: friction,
            restitution: restitution
        )
        var body = PhysicsBodyComponent(
            shapes: collision.shapes,
            mass: max(mass, 0.0001),
            material: material,
            mode: mode
        )
        body.isAffectedByGravity = gravity
        body.linearDamping = linearDamping
        body.angularDamping = angularDamping
        record.entity.components.set(body)
        if record.entity.components[PhysicsMotionComponent.self] == nil, mode != .static {
            record.entity.components.set(PhysicsMotionComponent())
        }
    }

    /// The physics helpers live on `HasPhysicsBody`, which every scripted entity
    /// except an anchor conforms to. An anchor with a body falls back to the
    /// motion component so the push is not silently dropped.
    private func physicsBody(_ id: Int) -> (ModelEntity?, Record)? {
        guard let record = records[id], record.bodyType != nil else { return nil }
        return (record.entity as? ModelEntity, record)
    }

    private func mass(of record: Record) -> Float {
        max(float(record.bodySpec["mass"]) ?? 1, 0.0001)
    }

    func applyImpulse(id: Int, command: JavaScriptArrayReader) {
        guard let (model, record) = physicsBody(id) else { return }
        let impulse = SIMD3<Float>(command.float(2), command.float(3), command.float(4))
        let point: SIMD3<Float>? = if let x = command.optionalFloat(5),
                                      let y = command.optionalFloat(6),
                                      let z = command.optionalFloat(7) {
            SIMD3(x, y, z)
        } else {
            nil
        }
        if let model {
            if let point {
                model.applyImpulse(impulse, at: point, relativeTo: nil)
            } else {
                model.applyLinearImpulse(impulse, relativeTo: nil)
            }
            return
        }
        var motion = record.entity.components[PhysicsMotionComponent.self] ?? PhysicsMotionComponent()
        motion.linearVelocity += impulse / mass(of: record)
        record.entity.components.set(motion)
    }

    func applyForce(id: Int, command: JavaScriptArrayReader) {
        guard let (model, record) = physicsBody(id) else { return }
        let force = SIMD3<Float>(command.float(2), command.float(3), command.float(4))
        if let model {
            model.addForce(force, relativeTo: nil)
            return
        }
        var motion = record.entity.components[PhysicsMotionComponent.self] ?? PhysicsMotionComponent()
        motion.linearVelocity += force / mass(of: record) * Float(1.0 / 60)
        record.entity.components.set(motion)
    }

    func applyTorque(id: Int, command: JavaScriptArrayReader) {
        guard let (model, record) = physicsBody(id) else { return }
        let torque = SIMD3<Float>(command.float(2), command.float(3), command.float(4))
        if let model {
            model.addTorque(torque, relativeTo: nil)
            return
        }
        var motion = record.entity.components[PhysicsMotionComponent.self] ?? PhysicsMotionComponent()
        motion.angularVelocity += torque / mass(of: record) * Float(1.0 / 60)
        record.entity.components.set(motion)
    }

    func applyVelocity(id: Int, command: JavaScriptArrayReader) {
        guard let record = records[id] else { return }
        var motion = record.entity.components[PhysicsMotionComponent.self] ?? PhysicsMotionComponent()
        if let x = command.optionalFloat(2),
           let y = command.optionalFloat(3),
           let z = command.optionalFloat(4) {
            motion.linearVelocity = SIMD3(x, y, z)
        }
        if let x = command.optionalFloat(5),
           let y = command.optionalFloat(6),
           let z = command.optionalFloat(7) {
            motion.angularVelocity = SIMD3(x, y, z)
        }
        record.entity.components.set(motion)
    }

    func applyGravity(_ gravity: SIMD3<Float>) {
        var simulation = root.components[PhysicsSimulationComponent.self] ?? PhysicsSimulationComponent()
        simulation.gravity = gravity
        root.components.set(simulation)
    }

    func applyJoint(id: Int, payload: [String: Any]?) {
        guard let payload else {
            jointSpecs[id] = nil
            rebuildJoints()
            return
        }
        let spec = ScriptingJointSpec(
            type: payload["type"] as? String ?? "fixed",
            bodyA: intValue(payload["bodyA"]) ?? 0,
            bodyB: intValue(payload["bodyB"]) ?? 0,
            anchorA: vector3(payload["anchorA"]) ?? .zero,
            anchorB: vector3(payload["anchorB"]) ?? .zero,
            axis: vector3(payload["axis"]) ?? SIMD3(0, 1, 0),
            limits: limits(payload["limits"])
        )
        jointSpecs[id] = spec
        rebuildJoints()
    }

    private func limits(_ value: Any?) -> ClosedRange<Float>? {
        guard let array = value as? [Any], array.count >= 2,
              let lower = (array[0] as? NSNumber)?.floatValue,
              let upper = (array[1] as? NSNumber)?.floatValue,
              lower <= upper else { return nil }
        return lower...upper
    }

    func rebuildJoints() {
        var joints = PhysicsJoints()
        for (id, spec) in jointSpecs.sorted(by: { $0.key < $1.key }) {
            guard
                let entityA = records[spec.bodyA]?.entity,
                let entityB = records[spec.bodyB]?.entity
            else { continue }
            let orientation = ScriptingCommandApplier.orientation(pointingPlusXAlong: spec.axis)
            let pinA = GeometricPin(
                named: "spatial.joint.\(id).a",
                offsetPosition: spec.anchorA,
                offsetOrientation: orientation
            )
            let pinB = GeometricPin(
                named: "spatial.joint.\(id).b",
                offsetPosition: spec.anchorB,
                offsetOrientation: orientation
            )
            var pinsA = entityA.components[GeometricPinsComponent.self] ?? GeometricPinsComponent()
            pinsA.set(pin: pinA)
            entityA.components.set(pinsA)
            var pinsB = entityB.components[GeometricPinsComponent.self] ?? GeometricPinsComponent()
            pinsB.set(pin: pinB)
            entityB.components.set(pinsB)

            guard
                let resolvedA = entityA.components[GeometricPinsComponent.self]?["spatial.joint.\(id).a"],
                let resolvedB = entityB.components[GeometricPinsComponent.self]?["spatial.joint.\(id).b"]
            else { continue }

            switch spec.type {
            case "fixed":
                joints.append(PhysicsFixedJoint(pin0: resolvedA, pin1: resolvedB))
            case "revolute":
                joints.append(
                    PhysicsRevoluteJoint(pin0: resolvedA, pin1: resolvedB, angularLimit: spec.limits)
                )
            case "spherical":
                joints.append(PhysicsSphericalJoint(pin0: resolvedA, pin1: resolvedB))
            case "prismatic":
                joints.append(
                    PhysicsPrismaticJoint(pin0: resolvedA, pin1: resolvedB, linearLimit: spec.limits)
                )
            case "distance":
                // With no limits the joint pins the separation the bodies have
                // when it is created, matching the web consumer.
                let limits = spec.limits ?? {
                    let a = entityA.position(relativeTo: nil) + spec.anchorA
                    let b = entityB.position(relativeTo: nil) + spec.anchorB
                    let separation = simd_distance(a, b)
                    return separation...separation
                }()
                joints.append(
                    PhysicsDistanceJoint(pin0: resolvedA, pin1: resolvedB, distanceLimit: limits)
                )
            default:
                warnings.warnOnce(
                    "Joint type '\(spec.type)' is unsupported in RealityKit",
                    key: "joint-\(spec.type)"
                )
            }
        }
        var component = root.components[PhysicsJointsComponent.self] ?? PhysicsJointsComponent()
        component.joints = joints
        root.components.set(component)
    }

    static func orientation(pointingPlusXAlong direction: SIMD3<Float>) -> simd_quatf {
        let length = simd_length(direction)
        guard length > 1e-6 else { return simd_quatf(ix: 0, iy: 0, iz: 0, r: 1) }
        let forward = direction / length
        let reference = SIMD3<Float>(1, 0, 0)
        let dot = simd_dot(reference, forward)
        if dot > 0.999999 { return simd_quatf(ix: 0, iy: 0, iz: 0, r: 1) }
        if dot < -0.999999 { return simd_quatf(angle: .pi, axis: SIMD3(0, 1, 0)) }
        let axis = simd_normalize(simd_cross(reference, forward))
        return simd_quatf(angle: acos(max(-1, min(1, dot))), axis: axis)
    }
}

//
//  ScriptingNativeDump.swift
//  RealityKitScripting
//
//  Created by Shane Liu on 9/9/26.
//

import Foundation
import RealityKit

extension ScriptingCommandApplier {
    /// The SPEC section 8 dump shape rebuilt from the RealityKit side of the
    /// mirror. Transforms, hierarchy, component presence and the material and
    /// light parameters RealityKit stores are read back off the entities;
    /// descriptive fields the engine does not keep (the three.js class names,
    /// the geometry parameters) are echoed from the command that produced them.
    func nativeDump(platform: String, frame: Int, elapsed: Double, errors: [String], logs: [String]) -> [String: Any] {
        var objects: [[String: Any]] = []
        for record in records.values.sorted(by: { $0.id < $1.id }) where isAttached(record.entity) {
            objects.append(describe(record))
        }

        let gravity = root.components[PhysicsSimulationComponent.self]?.gravity ?? SIMD3<Float>(0, -9.81, 0)

        return [
            "backend": "realitykit",
            "platform": platform,
            "frame": frame,
            "elapsed": elapsed,
            "objects": objects,
            "objectCount": objects.count,
            "joints": jointSpecs.keys.sorted().compactMap { id -> [String: Any]? in
                guard let spec = jointSpecs[id] else { return nil }
                return [
                    "id": id,
                    "type": spec.type,
                    "bodyA": spec.bodyA,
                    "bodyB": spec.bodyB,
                    "anchorA": [spec.anchorA.x, spec.anchorA.y, spec.anchorA.z],
                    "anchorB": [spec.anchorB.x, spec.anchorB.y, spec.anchorB.z],
                    "axis": [spec.axis.x, spec.axis.y, spec.axis.z],
                    "limits": spec.limits.map { [$0.lowerBound, $0.upperBound] } ?? NSNull() as Any,
                ]
            },
            "gravity": [gravity.x, gravity.y, gravity.z],
            "environment": currentEnvironmentEntity == nil ? NSNull() : ["active": true],
            "warnings": warnings.warnings,
            "errors": errors,
            "logs": logs,
            "placeholder": false,
        ]
    }

    private func isAttached(_ entity: Entity) -> Bool {
        var node: Entity? = entity
        while let current = node {
            if current === root { return true }
            node = current.parent
        }
        return false
    }

    private func describe(_ record: Record) -> [String: Any] {
        let entity = record.entity
        let transform = entity.transform
        let world = entity.position(relativeTo: nil)

        var object: [String: Any] = [
            "id": record.id,
            "name": entity.name,
            "type": Self.dumpType(for: record),
            "parent": parentIdentifier(of: entity),
            "visible": entity.isEnabled,
            "position": [transform.translation.x, transform.translation.y, transform.translation.z],
            "quaternion": [
                transform.rotation.imag.x,
                transform.rotation.imag.y,
                transform.rotation.imag.z,
                transform.rotation.real,
            ],
            "scale": [transform.scale.x, transform.scale.y, transform.scale.z],
            "worldPosition": [world.x, world.y, world.z],
            "opacity": entity.components[OpacityComponent.self]?.opacity ?? 1,
            "billboard": entity.components[BillboardComponent.self] != nil,
            "groundingShadow": entity.components[GroundingShadowComponent.self] != nil,
            "hoverEffect": record.hoverEffect ?? NSNull(),
            "manipulable": record.manipulable,
            "castShadow": entity.components[DynamicLightShadowComponent.self]?.castsShadow ?? false,
            "receiveShadow": record.receiveShadow,
            "renderOrder": record.renderOrder,
            "world": entity.components[WorldComponent.self] != nil,
            "interactive": [
                "tap": record.interactive.tap,
                "hover": record.interactive.hover,
                "drag": record.interactive.drag,
            ],
            "components": componentNames(of: entity),
        ]

        if record.geometryType.isEmpty {
            object["geometry"] = NSNull()
        } else {
            let parameters: Any = record.geometryParameters.isEmpty ? NSNull() : record.geometryParameters
            object["geometry"] = ["type": record.geometryType, "parameters": parameters] as [String: Any]
        }
        object["material"] = materialDump(record) ?? NSNull()
        object["light"] = lightDump(record) ?? NSNull()
        object["rigidBody"] = bodyDump(record) ?? NSNull()

        if record.kind == .anchor {
            object["anchor"] = record.anchorSpec.isEmpty ? NSNull() as Any : record.anchorSpec as Any
            object["isAnchored"] = (entity as? AnchorEntity)?.isAnchored ?? false
        }
        if record.kind == .portal, !record.portalSpec.isEmpty {
            object["portal"] = record.portalSpec
        }
        if record.kind == .particles {
            object["particles"] = entity.components[ParticleEmitterComponent.self] != nil
        }
        return object
    }

    private func materialDump(_ record: Record) -> [String: Any]? {
        guard let spec = record.materialSpec else { return nil }
        var dump: [String: Any] = [
            "type": spec.type,
            "color": [spec.color.x, spec.color.y, spec.color.z],
            "opacity": spec.opacity,
            "transparent": spec.transparent,
            "side": spec.side,
            "wireframe": spec.wireframe,
            "metalness": spec.metalness,
            "roughness": spec.roughness,
            "emissive": [spec.emissive.x, spec.emissive.y, spec.emissive.z],
            "emissiveIntensity": spec.emissiveIntensity,
            "clearcoat": spec.clearcoat,
            "clearcoatRoughness": spec.clearcoatRoughness,
            "depthWrite": spec.depthWrite,
            "depthTest": spec.depthTest,
            "blending": spec.blending,
            "maps": spec.maps.mapValues { $0 as Any },
            "nativeType": "OcclusionMaterial",
        ]

        // Read the values back off the material RealityKit is actually using.
        let material = (record.entity as? ModelEntity)?.model?.materials.first
        if let physical = material as? PhysicallyBasedMaterial {
            dump["nativeType"] = "PhysicallyBasedMaterial"
            let tint = ScriptingColor.linearComponents(of: physical.baseColor.tint)
            dump["color"] = [tint.x, tint.y, tint.z]
            dump["metalness"] = physical.metallic.scale
            dump["roughness"] = physical.roughness.scale
            dump["side"] = Self.side(for: physical.faceCulling)
            dump["depthWrite"] = physical.writesDepth
            dump["depthTest"] = physical.readsDepth
            if case .transparent(let opacity) = physical.blending {
                dump["opacity"] = opacity.scale
            } else {
                dump["opacity"] = Float(1)
            }
            let emissive = ScriptingColor.linearComponents(of: physical.emissiveColor.color)
            dump["emissive"] = [emissive.x, emissive.y, emissive.z]
            dump["emissiveIntensity"] = physical.emissiveIntensity
        } else if let unlit = material as? UnlitMaterial {
            dump["nativeType"] = "UnlitMaterial"
            let tint = ScriptingColor.linearComponents(of: unlit.color.tint)
            dump["color"] = [tint.x, tint.y, tint.z]
            dump["side"] = Self.side(for: unlit.faceCulling)
            dump["depthWrite"] = unlit.writesDepth
            dump["depthTest"] = unlit.readsDepth
            if case .transparent(let opacity) = unlit.blending {
                dump["opacity"] = opacity.scale
            } else {
                dump["opacity"] = Float(1)
            }
        }
        return dump
    }

    private func lightDump(_ record: Record) -> [String: Any]? {
        guard !record.lightSpec.isEmpty else { return nil }
        var dump = record.lightSpec

        guard let holder = record.lightHolder else { return dump }
        if let component = holder.components[DirectionalLightComponent.self] {
            dump["type"] = "directional"
            dump["intensity"] = component.intensity / 1000
            let color = ScriptingColor.linearComponents(of: component.color)
            dump["color"] = [color.x, color.y, color.z]
            dump["castShadow"] = holder.components[DirectionalLightComponent.Shadow.self] != nil
        } else if let component = holder.components[PointLightComponent.self] {
            dump["type"] = "point"
            dump["intensity"] = component.intensity / (4 * .pi)
            let color = ScriptingColor.linearComponents(of: component.color)
            dump["color"] = [color.x, color.y, color.z]
        } else if let component = holder.components[SpotLightComponent.self] {
            dump["type"] = "spot"
            dump["intensity"] = component.intensity / (4 * .pi)
            let color = ScriptingColor.linearComponents(of: component.color)
            dump["color"] = [color.x, color.y, color.z]
            dump["angle"] = component.outerAngleInDegrees * .pi / 180
            dump["castShadow"] = holder.components[SpotLightComponent.Shadow.self] != nil
        }
        return dump
    }

    private func bodyDump(_ record: Record) -> [String: Any]? {
        guard !record.bodySpec.isEmpty, let type = record.bodyType else { return nil }
        var dump = record.bodySpec
        let mode = record.entity.components[PhysicsBodyComponent.self]?.mode
        dump["type"] = switch mode {
        case .static: "static"
        case .kinematic: "kinematic"
        case .dynamic: "dynamic"
        default: type
        }
        dump["shape"] = record.bodyShape
        return dump
    }

    private func parentIdentifier(of entity: Entity) -> Any {
        guard let parent = entity.parent else { return NSNull() }
        if parent === root { return 0 }
        guard let component = parent.components[ScriptingEntityComponent.self] else { return NSNull() }
        return component.entityID
    }

    private func componentNames(of entity: Entity) -> [String] {
        var names: [String] = []
        if entity.components[ModelComponent.self] != nil { names.append("ModelComponent") }
        if entity.components[CollisionComponent.self] != nil { names.append("CollisionComponent") }
        if entity.components[PhysicsBodyComponent.self] != nil { names.append("PhysicsBodyComponent") }
        if entity.components[PhysicsMotionComponent.self] != nil { names.append("PhysicsMotionComponent") }
        if entity.components[InputTargetComponent.self] != nil { names.append("InputTargetComponent") }
        if entity.components[OpacityComponent.self] != nil { names.append("OpacityComponent") }
        if entity.components[BillboardComponent.self] != nil { names.append("BillboardComponent") }
        if entity.components[GroundingShadowComponent.self] != nil { names.append("GroundingShadowComponent") }
        if entity.components[DynamicLightShadowComponent.self] != nil { names.append("DynamicLightShadowComponent") }
        if entity.components[ParticleEmitterComponent.self] != nil { names.append("ParticleEmitterComponent") }
        if entity.components[PortalComponent.self] != nil { names.append("PortalComponent") }
        if entity.components[WorldComponent.self] != nil { names.append("WorldComponent") }
        if entity.components[AnchoringComponent.self] != nil { names.append("AnchoringComponent") }
        if entity.components[ImageBasedLightReceiverComponent.self] != nil {
            names.append("ImageBasedLightReceiverComponent")
        }
#if os(visionOS)
        if entity.components[ManipulationComponent.self] != nil { names.append("ManipulationComponent") }
        if entity.components[HoverEffectComponent.self] != nil { names.append("HoverEffectComponent") }
#endif
        if let holder = entity.children.first(where: { $0.name.hasSuffix(".light") }) {
            if holder.components[DirectionalLightComponent.self] != nil { names.append("DirectionalLightComponent") }
            if holder.components[PointLightComponent.self] != nil { names.append("PointLightComponent") }
            if holder.components[SpotLightComponent.self] != nil { names.append("SpotLightComponent") }
        }
        return names
    }

    private static func side(for culling: MaterialParameterTypes.FaceCulling) -> Int {
        switch culling {
        case .front: 1
        case .none: 2
        default: 0
        }
    }

    private static func dumpType(for record: Record) -> String {
        switch record.kind {
        case .mesh: "Mesh"
        case .portal: "Portal"
        case .group: "Group"
        case .ambientLight: "AmbientLight"
        case .directionalLight: "DirectionalLight"
        case .pointLight: "PointLight"
        case .spotLight: "SpotLight"
        case .particles: "ParticleEmitter"
        case .anchor: "Anchor"
        case .asset: "Asset"
        }
    }
}

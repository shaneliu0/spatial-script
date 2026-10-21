//
//  ScriptingNativeDump.swift
//  RealityKitScripting
//
//  Created by Shane Liu on 9/9/26.
//

import Foundation
import RealityKit

extension ScriptingCommandApplier {
    /// SPEC 3.11: only visionOS actually anchors. On macOS every anchor target
    /// maps to a world transform, which RealityKit resolves the moment the
    /// entity is in a scene, so `AnchorEntity.isAnchored` reports an anchor
    /// that never happened — and the core dump, which knows better, says
    /// `false`. The two dumps in one process must not disagree, so the native
    /// dump reads the same gate the `anchored` event dispatch does.
    static func anchoredReport(native: Bool) -> Bool {
#if os(visionOS)
        return native
#else
        return false
#endif
    }
}

extension ScriptingCommandApplier {
    /// The SPEC section 8 dump shape rebuilt from the RealityKit side of the
    /// mirror. Transforms, hierarchy, component presence and the material and
    /// light parameters RealityKit stores are read back off the entities;
    /// descriptive fields the engine does not keep (the three.js class names,
    /// the geometry parameters) are echoed from the command that produced them.
    func nativeDump(
        platform: String,
        frame: Int,
        elapsed: Double,
        errors: [String],
        sceneName: String = "",
        isActive: Bool = true
    ) -> [String: Any] {
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
            // SPEC 8's scene block and load generation, derived from what the
            // consumer holds rather than echoed from the core.
            // SPEC 8: the script's own scene name, and the one addition the
            // rule allows here. The consumer is never sent a name for the
            // Scene itself (it has no id), so the name arrives the same way
            // `frame` and `elapsed` do.
            "scene": ["name": sceneName, "childCount": root.children.count] as [String: Any],
            "loadGeneration": loadGeneration,
            "droppedErrors": 0,
            "environment": environmentDump(),
            "warnings": warnings.warnings,
            "errors": errors,
        ].merging(phase2SceneDump(isActive: isActive)) { current, _ in current }
    }

    /// SPEC 8's `environment`: the image based light the scene is actually
    /// lit by, with the url and intensity that produced it.
    private func environmentDump() -> Any {
        // SPEC 8: `environment` is null until the script installs one. An
        // ambient light is not an environment: reporting it here made every
        // scene with an AmbientLight disagree with the core, which says null.
        // The url the script asked for is kept whether or not the resource
        // resolved, so a failed load still reports the request.
        guard let url = environmentURL else { return NSNull() }
        return [
            "url": url,
            "intensity": Double(explicitEnvironment?.1 ?? environmentIntensity),
        ] as [String: Any]
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
            "type": dumpType(for: record),
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
            "castShadow": record.castShadow,
            "receiveShadow": record.receiveShadow,
            "renderOrder": record.renderOrder,
            "world": entity.components[WorldComponent.self] != nil,
            "interactive": [
                "tap": record.interactive.tap,
                "hover": record.interactive.hover,
                "drag": record.interactive.drag,
                "manipulation": record.interactive.manipulation,
                "collision": record.interactive.collision,
            ],
            "components": componentNames(for: record),
        ]

        if record.geometryType.isEmpty {
            object["geometry"] = NSNull()
        } else {
            let parameters: Any = record.geometryParameters.isEmpty ? NSNull() : record.geometryParameters
            // SPEC 8's shape rule: the core's `geometry` carries `type` and
            // `parameters` (its `uuid` is omitted), so the mirror carries those
            // and nothing else. How the mesh was split is a native fact and
            // rides in `components` as "MultiPartMesh(n)".
            object["geometry"] = ["type": record.geometryType, "parameters": parameters]
        }
        for (key, value) in phase2Dump(record) { object[key] = value }
        // SPEC 14.12: a mesh with a material per part dumps an array, the way
        // the core does, and a single material stays a single object.
        if let specs = record.materialSpecs, specs.count > 1 || (record.drawnMaterialCount ?? 0) > 1 {
            let drawn = record.drawnMaterialCount ?? specs.count
            object["material"] = (0..<drawn).map {
                materialDump(record, index: min($0, specs.count - 1))
            }
        } else {
            object["material"] = materialDump(record) ?? NSNull()
        }
        // SPEC 8: the motion the consumer measured, and what a loaded asset
        // turned out to carry. Both belong to the object, not to how many
        // materials it draws.
        // SPEC 8: the core reports motion for every rigid body, not only the
        // dynamic ones, so a static body's zeroes are compared too.
        if record.bodyType != nil {
            object["velocity"] = [
                record.linearVelocity.x, record.linearVelocity.y, record.linearVelocity.z,
            ]
            object["isSleeping"] = record.isSleeping
        }
        if record.kind == .asset {
            // SPEC 3.12's four url forms, every one of them present: the core
            // dumps `{ ...urls }` with a null for each form the script omitted.
            var urls: [String: Any] = ["usdz": NSNull(), "glb": NSNull(), "reality": NSNull(), "gltf": NSNull()]
            for (key, value) in record.assetURLs { urls[key] = value }
            object["asset"] = urls
            object["loaded"] = record.assetContainer != nil
            object["animations"] = record.assetContainer?.availableAnimations.compactMap(\.name) ?? []
            // SPEC 8: every asset reports both, null when it has no rig — the
            // core does, so an asset whose load failed still carries the keys.
            if object["skeleton"] == nil { object["skeleton"] = NSNull() }
            if object["blendShapes"] == nil { object["blendShapes"] = NSNull() }
        }
        object["light"] = lightDump(record) ?? NSNull()
        object["rigidBody"] = bodyDump(record) ?? NSNull()

        if record.kind == .anchor {
            object["anchor"] = record.anchorSpec.isEmpty ? NSNull() as Any : record.anchorSpec as Any
            object["isAnchored"] = Self.anchoredReport(
                native: (entity as? AnchorEntity)?.isAnchored ?? false
            )
        }
        if record.kind == .portal, !record.portalSpec.isEmpty {
            object["portal"] = record.portalSpec
        }
        if record.kind == .particles {
            // SPEC 8: the emitter's state, not just its presence.
            if let emitter = entity.components[ParticleEmitterComponent.self] {
                var particles = record.particleSpec
                particles["isEmitting"] = emitter.isEmitting
                particles["loops"] = record.particlesLoop
                // A preset is RealityKit's own emitter, whose numbers are not
                // readable back, so the payload it was configured with is what
                // the dump reports.
                object["particles"] = particles
            } else {
                object["particles"] = NSNull()
            }
        }
        return object
    }

    /// The core's five map slots, each a texture id or null.
    static func mapSlots(_ maps: [String: Int]) -> [String: Any] {
        var slots: [String: Any] = [
            "map": NSNull(), "normalMap": NSNull(), "roughnessMap": NSNull(),
            "metalnessMap": NSNull(), "emissiveMap": NSNull(),
        ]
        for (key, value) in maps { slots[key] = value }
        return slots
    }

    private func materialDump(_ record: Record, index: Int) -> [String: Any] {
        guard let specs = record.materialSpecs, specs.indices.contains(index) else { return [:] }
        let fallback = materialDump(
            record,
            spec: specs[index],
            material: materialSlot(record, index: index)
        )
        // SPEC 8: a slot the script gave a shader graph dumps as a shader
        // graph, the way the core's `materialSnapshot` does, with the material
        // that really draws nested as its fallback. Which one RealityKit
        // ended up building is named in the object's `components` list.
        guard let shader = record.extras?.shaderGraph,
              let graph = shader.slotGraphs[index] else { return fallback }
        return [
            "type": "ShaderGraphMaterial",
            "source": graph.source,
            "name": graph.name,
            "parameters": shader.parametersBySlot[index] ?? [:],
            "generation": shader.generation,
            "fallback": fallback,
        ]
    }

    private func materialSlot(_ record: Record, index: Int) -> (any RealityKit.Material)? {
        let materials = (record.entity as? ModelEntity)?.model?.materials ?? []
        return materials.indices.contains(index) ? materials[index] : nil
    }

    private func materialDump(_ record: Record) -> [String: Any]? {
        // SPEC 14.6: a shader graph reports itself, with its fallback nested.
        if let shader = record.extras?.shaderGraph {
            var dump: [String: Any] = [
                "type": "ShaderGraphMaterial",
                "source": shader.source,
                "name": shader.name,
                "parameters": shader.parameters,
                "generation": shader.generation,
            ]
            if let spec = record.materialSpec {
                dump["fallback"] = materialDump(record, spec: spec, material: record.nativeMaterial)
            }
            return dump
        }
        guard let spec = record.materialSpec else { return nil }
        return materialDump(
            record,
            spec: spec,
            material: (record.entity as? ModelEntity)?.model?.materials.first
        )
    }

    private func materialDump(
        _ record: Record,
        spec: ScriptingMaterialSpec,
        material: (any RealityKit.Material)?
    ) -> [String: Any] {
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
            "maps": Self.mapSlots(spec.maps),
        ]

        // Read the values back off the material RealityKit is actually using.
        if let physical = material as? PhysicallyBasedMaterial {
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

    /// SPEC 8: native class names live here and nowhere else. Each drawn
    /// material slot contributes `nativeMaterial:<class>`, in slot order, so
    /// this list says what RealityKit actually built without putting a native
    /// name inside a payload the core also carries.
    private func componentNames(for record: Record) -> [String] {
        var names = componentNames(of: record.entity)
        let materials = (record.entity as? ModelEntity)?.model?.materials ?? []
        for material in materials {
            names.append("nativeMaterial:\(Self.nativeMaterialName(material))")
        }
        return names
    }

    static func nativeMaterialName(_ material: any RealityKit.Material) -> String {
        switch material {
        case is ShaderGraphMaterial: "ShaderGraphMaterial"
        case is PhysicallyBasedMaterial: "PhysicallyBasedMaterial"
        case is UnlitMaterial: "UnlitMaterial"
        case is OcclusionMaterial: "OcclusionMaterial"
        case is VideoMaterial: "VideoMaterial"
        default: "\(type(of: material))"
        }
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
        // SPEC 14.14: the phase 2 components a harness checks for.
        if entity.components[SpatialAudioComponent.self] != nil { names.append("SpatialAudioComponent") }
        if entity.components[AmbientAudioComponent.self] != nil { names.append("AmbientAudioComponent") }
        if entity.components[ChannelAudioComponent.self] != nil { names.append("ChannelAudioComponent") }
        if entity.components[AudioMixGroupsComponent.self] != nil { names.append("AudioMixGroupsComponent") }
        if entity.components[CharacterControllerComponent.self] != nil {
            names.append("CharacterControllerComponent")
        }
        if entity.components[CharacterControllerStateComponent.self] != nil {
            names.append("CharacterControllerStateComponent")
        }
        if entity.components[ForceEffectComponent.self] != nil { names.append("ForceEffectComponent") }
        if entity.components[AccessibilityComponent.self] != nil { names.append("AccessibilityComponent") }
        if entity.components[ModelDebugOptionsComponent.self] != nil {
            names.append("ModelDebugOptionsComponent")
        }
        if entity.components[SkeletalPosesComponent.self] != nil { names.append("SkeletalPosesComponent") }
        if entity.components[BlendShapeWeightsComponent.self] != nil {
            names.append("BlendShapeWeightsComponent")
        }
        if entity.components[PerspectiveCameraComponent.self] != nil {
            names.append("PerspectiveCameraComponent")
        }
        if entity.components[OrthographicCameraComponent.self] != nil {
            names.append("OrthographicCameraComponent")
        }
        if entity.children.contains(where: { $0.components[VideoPlayerComponent.self] != nil }) {
            names.append("VideoPlayerComponent")
        }
#if os(visionOS)
        if entity.components[SceneUnderstandingComponent.self] != nil {
            names.append("SceneUnderstandingComponent")
        }
        if entity.components[AdaptiveResolutionComponent.self] != nil {
            names.append("AdaptiveResolutionComponent")
        }
        if entity.components[EnvironmentLightingConfigurationComponent.self] != nil {
            names.append("EnvironmentLightingConfigurationComponent")
        }
        if entity.children.contains(where: { $0.components[DockingRegionComponent.self] != nil }) {
            names.append("DockingRegionComponent")
        }
#endif
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

    private func dumpType(for record: Record) -> String {
        // SPEC 14.3: the camera is a scripted object, identified by the pose
        // the camera command carried.
        if cameraRecordID == record.id, let kind = cameraSpec?["kind"] as? String {
            return kind == "orthographic" ? "OrthographicCamera" : "PerspectiveCamera"
        }
        return Self.dumpType(for: record)
    }

    private static func dumpType(for record: Record) -> String {
        // SPEC 14.1 and 14.2 objects are created as plain groups and take
        // their identity from the media attached to them.
        if let audio = record.extras?.audio {
            if audio.ambient { return "AmbientAudio" }
            return audio.spatial ? "PositionalAudio" : "Audio"
        }
        if record.extras?.video != nil { return "VideoScreen" }
        if let field = record.extras?.forceField, !field.kind.isEmpty { return field.kind }
        return switch record.kind {
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

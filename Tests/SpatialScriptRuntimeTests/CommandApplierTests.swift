//
//  CommandApplierTests.swift
//  SpatialScriptRuntime
//
//  Created by Shane Liu on 9/9/26.
//

import Foundation
import RealityKit
import Testing
@testable import SpatialScriptRuntime

/// Exercises every opcode in SPEC section 5 with hand built command arrays, so
/// the applier is covered without depending on what the core happens to emit.
@MainActor
struct CommandApplierTests {
    private func makeScene() throws -> (Entity, JavaScriptScene) {
        let root = Entity()
        let scene = try JavaScriptScene(rootEntity: root, source: """
            const stage = new Spatial.Scene();
            Spatial.mount(stage);
            """)
        return (root, scene)
    }

    private func entity(_ scene: JavaScriptScene, _ id: Int) throws -> Entity {
        try #require(scene.commandApplier.entity(for: id))
    }

    @Test
    func createParentNameTransformVisibleAndDestroy() throws {
        let (root, scene) = try makeScene()
        scene.applyCommands(javaScript: """
            [
              ["create", 100, "group", "parent"],
              ["create", 101, "mesh", "child"],
              ["parent", 101, 100],
              ["name", 101, "renamed"],
              ["transform", 101, 1, 2, 3, 0, 0, 0, 1, 2, 2, 2],
              ["visible", 101, false]
            ]
            """)

        let parent = try entity(scene, 100)
        let child = try entity(scene, 101)
        #expect(parent.parent === root)
        #expect(child.parent === parent)
        #expect(child.name == "renamed")
        #expect(child.position == SIMD3<Float>(1, 2, 3))
        #expect(child.scale == SIMD3<Float>(2, 2, 2))
        #expect(child.isEnabled == false)

        scene.applyCommands(javaScript: #"[["parent", 101, -1]]"#)
        #expect(child.parent == nil)

        scene.applyCommands(javaScript: #"[["destroy", 101], ["destroy", 100]]"#)
        #expect(scene.commandApplier.entity(for: 101) == nil)
        #expect(scene.commandApplier.entity(for: 100) == nil)
        scene.dispose()
    }

    @Test
    func nativeGeneratorsCoverTheParametricGeometries() throws {
        let (_, scene) = try makeScene()
        let cases: [(Int, String, String)] = [
            (110, "BoxGeometry", #"{"width":0.2,"height":0.3,"depth":0.4}"#),
            (111, "SphereGeometry", #"{"radius":0.25}"#),
            (112, "PlaneGeometry", #"{"width":1,"height":2}"#),
            (113, "CylinderGeometry", #"{"radiusTop":0.1,"radiusBottom":0.1,"height":0.5}"#),
            (114, "ConeGeometry", #"{"radius":0.2,"height":0.4}"#),
            (115, "TextGeometry", #"{"text":"hi","size":0.1,"depth":0.01}"#),
        ]
        for (id, type, parameters) in cases {
            scene.applyCommands(javaScript: """
                [
                  ["create", \(id), "mesh", "g\(id)"],
                  ["geometry", \(id), { "type": "\(type)", "parameters": \(parameters) },
                   new Float32Array(0), null, null, null]
                ]
                """)
            let entity = try entity(scene, id)
            let model = try #require(entity as? ModelEntity)
            #expect(model.model != nil, "\(type) produced no model component")
        }
        scene.dispose()
    }

    @Test
    func bufferGeometryIsRebuiltFromTypedArrays() throws {
        let (_, scene) = try makeScene()
        scene.applyCommands(javaScript: """
            [
              ["create", 120, "mesh", "triangle"],
              ["geometry", 120, { "type": "BufferGeometry", "parameters": {} },
               new Float32Array([0,0,0, 1,0,0, 0,1,0]),
               new Float32Array([0,0,1, 0,0,1, 0,0,1]),
               new Float32Array([0,0, 1,0, 0,1]),
               new Uint32Array([0,1,2])]
            ]
            """)
        let model = try #require(try entity(scene, 120) as? ModelEntity)
        let mesh = try #require(model.model?.mesh)
        #expect(mesh.expectedMaterialCount >= 1)
        scene.dispose()
    }

    @Test
    func cylinderWithDifferentRadiiWarnsAndFallsBackToBuffers() throws {
        let (_, scene) = try makeScene()
        scene.applyCommands(javaScript: """
            [
              ["create", 121, "mesh", "tapered"],
              ["geometry", 121, { "type": "CylinderGeometry",
                "parameters": {"radiusTop":0.1,"radiusBottom":0.3,"height":0.5} },
               new Float32Array([0,0,0, 1,0,0, 0,1,0]), null, null, new Uint32Array([0,1,2])]
            ]
            """)
        #expect(scene.commandApplier.warnings.warnings.contains { $0.contains("radiusTop") })
        scene.dispose()
    }

    @Test
    func materialsMapOntoTheRightRealityKitTypes() throws {
        let (_, scene) = try makeScene()
        scene.applyCommands(javaScript: """
            [
              ["create", 130, "mesh", "basic"],
              ["geometry", 130, { "type": "BoxGeometry", "parameters": {"width":0.1,"height":0.1,"depth":0.1} },
               new Float32Array(0), null, null, null],
              ["material", 130, { "type": "MeshBasicMaterial", "color": [1, 0, 0], "opacity": 1,
                "transparent": false, "side": 2, "wireframe": true, "blending": 2,
                "depthWrite": true, "depthTest": true, "maps": {} }],
              ["create", 131, "mesh", "standard"],
              ["geometry", 131, { "type": "BoxGeometry", "parameters": {"width":0.1,"height":0.1,"depth":0.1} },
               new Float32Array(0), null, null, null],
              ["material", 131, { "type": "MeshStandardMaterial", "color": [0, 1, 0], "opacity": 0.5,
                "transparent": true, "side": 0, "metalness": 1, "roughness": 0.25,
                "emissive": [0, 0, 1], "emissiveIntensity": 2, "clearcoat": 0.5,
                "clearcoatRoughness": 0.1, "depthWrite": false, "depthTest": false,
                "blending": 1, "maps": {} }],
              ["create", 132, "mesh", "occlusion"],
              ["geometry", 132, { "type": "BoxGeometry", "parameters": {"width":0.1,"height":0.1,"depth":0.1} },
               new Float32Array(0), null, null, null],
              ["material", 132, { "type": "OcclusionMaterial", "color": [0, 0, 0], "maps": {} }]
            ]
            """)

        let basic = try #require(try entity(scene, 130) as? ModelEntity)
        #expect(basic.model?.materials.first is UnlitMaterial)
        let standard = try #require(try entity(scene, 131) as? ModelEntity)
        let physical = try #require(standard.model?.materials.first as? PhysicallyBasedMaterial)
        #expect(abs(physical.roughness.scale - 0.25) < 1e-4)
        #expect(abs(physical.emissiveIntensity - 2) < 1e-4)
        #expect(physical.writesDepth == false)
        let occlusion = try #require(try entity(scene, 132) as? ModelEntity)
        #expect(occlusion.model?.materials.first is OcclusionMaterial)

        #expect(scene.commandApplier.warnings.warnings.contains { $0.contains("wireframe") })
        // AR-36: additive blending is a fact the core warns about
        // (`warnMaterial`, realitykit only), so this consumer only has to draw
        // it — object 130 asks for it — as a transparent material, and say
        // nothing.
        let blended = try #require(basic.model?.materials.first as? UnlitMaterial)
        if case .transparent = blended.blending {} else {
            Issue.record("AdditiveBlending must at least render as transparent")
        }
        #expect(!scene.commandApplier.warnings.warnings.contains { $0.contains("AdditiveBlending") })
        scene.dispose()
    }

    @Test
    func textureCommandRecordsTheRequestAndReportsFailure() throws {
        let (_, scene) = try makeScene()
        scene.applyCommands(javaScript: """
            [
              ["texture", 140, { "url": "asset://missing-texture", "repeat": [2, 3],
                "offset": [0.1, 0.2], "wrapS": 1000, "wrapT": 1000, "flipY": true }]
            ]
            """)
        let entry = try #require(scene.commandApplier.textures.entry(for: 140))
        #expect(entry.url == "asset://missing-texture")
        #expect(entry.repeats == SIMD2<Float>(2, 3))
        #expect(entry.offset == SIMD2<Float>(0.1, 0.2))
        scene.dispose()
    }

    @Test
    func lightsUseTheSpecifiedUnitConversions() throws {
        let (_, scene) = try makeScene()
        scene.applyCommands(javaScript: """
            [
              ["create", 150, "directionalLight", "sun"],
              ["light", 150, { "type": "directional", "color": [1, 1, 1], "intensity": 2,
                "distance": 0, "decay": 2, "angle": 0, "penumbra": 0, "castShadow": true,
                "direction": [0, -1, 0] }],
              ["create", 151, "pointLight", "bulb"],
              ["light", 151, { "type": "point", "color": [1, 0.5, 0], "intensity": 10,
                "distance": 4, "decay": 2, "angle": 0, "penumbra": 0, "castShadow": true,
                "direction": null }],
              ["create", 152, "spotLight", "spot"],
              ["light", 152, { "type": "spot", "color": [1, 1, 1], "intensity": 5,
                "distance": 6, "decay": 2, "angle": 0.5235987755982988, "penumbra": 0.5,
                "castShadow": true, "direction": [0, 0, -1] }],
              ["create", 153, "ambientLight", "ambient"],
              ["light", 153, { "type": "ambient", "color": [0.5, 0.5, 0.5], "intensity": 1,
                "distance": 0, "decay": 2, "angle": 0, "penumbra": 0, "castShadow": false,
                "direction": null }]
            ]
            """)

        let sun = try entity(scene, 150)
        let sunHolder = try #require(sun.children.first)
        let directional = try #require(sunHolder.components[DirectionalLightComponent.self])
        #expect(abs(directional.intensity - 2000) < 1)
        #expect(sunHolder.components[DirectionalLightComponent.Shadow.self] != nil)

        let bulbHolder = try #require(try entity(scene, 151).children.first)
        let point = try #require(bulbHolder.components[PointLightComponent.self])
        #expect(abs(point.intensity - Float(10 * 4 * Float.pi)) < 0.01)
        #expect(abs(point.attenuationRadius - 4) < 1e-4)
        // AR-36: RealityKit has no point-light shadow and the core says so for
        // this backend, so the light is built without one and in silence.
        #expect(bulbHolder.components[SpotLightComponent.Shadow.self] == nil)
        #expect(!scene.commandApplier.warnings.warnings.contains { $0.contains("PointLight") })

        let spotHolder = try #require(try entity(scene, 152).children.first)
        let spot = try #require(spotHolder.components[SpotLightComponent.self])
        #expect(abs(spot.outerAngleInDegrees - 30) < 0.01)
        #expect(abs(spot.innerAngleInDegrees - 15) < 0.01)

        #expect(scene.commandApplier.currentEnvironmentEntity != nil)
        scene.dispose()
    }

    @Test
    func presentationFlagsMapOntoComponents() throws {
        let (_, scene) = try makeScene()
        scene.applyCommands(javaScript: """
            [
              ["create", 160, "mesh", "flags"],
              ["geometry", 160, { "type": "BoxGeometry", "parameters": {"width":0.1,"height":0.1,"depth":0.1} },
               new Float32Array(0), null, null, null],
              ["shadow", 160, true, true],
              ["opacity", 160, 0.4],
              ["billboard", 160, true],
              ["groundingShadow", 160, true],
              ["hoverEffect", 160, "highlight"],
              ["renderOrder", 160, 3],
              ["manipulable", 160, true],
              ["interactive", 160, { "tap": true, "hover": true, "drag": false }]
            ]
            """)
        let entity = try entity(scene, 160)
        #expect(entity.components[DynamicLightShadowComponent.self] != nil)
        #expect(abs((entity.components[OpacityComponent.self]?.opacity ?? 1) - 0.4) < 1e-4)
        #expect(entity.components[BillboardComponent.self] != nil)
        #expect(entity.components[GroundingShadowComponent.self] != nil)
        #expect(entity.components[InputTargetComponent.self] != nil)
        #expect(entity.components[CollisionComponent.self] != nil)
#if os(macOS)
        #expect(scene.commandApplier.warnings.warnings.contains { $0.contains("renderOrder") })
        #expect(scene.commandApplier.warnings.warnings.contains { $0.contains("manipulable") })
#endif
        scene.applyCommands(javaScript: #"[["opacity", 160, 1], ["billboard", 160, false]]"#)
        #expect(entity.components[OpacityComponent.self] == nil)
        #expect(entity.components[BillboardComponent.self] == nil)
        scene.dispose()
    }

    @Test
    func rigidBodiesGravityAndBodyCommands() throws {
        let (root, scene) = try makeScene()
        scene.applyCommands(javaScript: """
            [
              ["gravity", 0, 0, -5, 0],
              ["create", 170, "mesh", "ball"],
              ["geometry", 170, { "type": "SphereGeometry", "parameters": {"radius":0.1} },
               new Float32Array(0), null, null, null],
              ["rigidBody", 170, { "type": "dynamic", "mass": 2, "shape": "auto", "friction": 0.4,
                "restitution": 0.3, "linearDamping": 0.1, "angularDamping": 0.2,
                "isTrigger": false, "gravity": true }],
              ["bodyVelocity", 170, 1, 2, 3, 4, 5, 6],
              ["bodyImpulse", 170, 0, 1, 0, null, null, null],
              ["bodyForce", 170, 0, 10, 0],
              ["bodyTorque", 170, 0, 0, 1]
            ]
            """)
        let simulation = try #require(root.components[PhysicsSimulationComponent.self])
        #expect(simulation.gravity == SIMD3<Float>(0, -5, 0))

        let ball = try entity(scene, 170)
        let body = try #require(ball.components[PhysicsBodyComponent.self])
        #expect(body.mode == .dynamic)
        #expect(abs(body.linearDamping - 0.1) < 1e-4)
        #expect(body.isAffectedByGravity)
        let motion = try #require(ball.components[PhysicsMotionComponent.self])
        #expect(motion.linearVelocity == SIMD3<Float>(1, 2, 3))
        #expect(motion.angularVelocity == SIMD3<Float>(4, 5, 6))
        let collision = try #require(ball.components[CollisionComponent.self])
        #expect(collision.filter.group == ScriptingCommandApplier.physicsGroup)

        scene.applyCommands(javaScript: #"[["rigidBody", 170, null]]"#)
        #expect(ball.components[PhysicsBodyComponent.self] == nil)
        scene.dispose()
    }

    @Test
    func inputTargetsGetAHitTestColliderImmediately() throws {
        let (_, scene) = try makeScene()
        scene.applyCommands(javaScript: """
            [
              ["create", 171, "mesh", "plain"],
              ["geometry", 171, { "type": "BoxGeometry", "parameters": {"width":0.1,"height":0.1,"depth":0.1} },
               new Float32Array(0), null, null, null],
              ["create", 172, "mesh", "tappable"],
              ["geometry", 172, { "type": "BoxGeometry", "parameters": {"width":0.1,"height":0.1,"depth":0.1} },
               new Float32Array(0), null, null, null],
              ["interactive", 172, { "tap": true, "hover": false, "drag": false }]
            ]
            """)

        let collision = try #require(try entity(scene, 172).components[CollisionComponent.self])
        #expect(collision.filter.group == ScriptingCommandApplier.hitTestGroup)
        // An empty mask makes RealityKit skip the shape for SwiftUI gesture
        // targeting on macOS, which silently kills tap, hover and drag.
        #expect(collision.filter.mask == ScriptingCommandApplier.hitTestGroup)
        #expect(collision.filter.mask != [])

        // A mesh nothing has asked about yet stays collider free: RealityKit
        // charges for every moved collider on every frame.
        #expect(try entity(scene, 171).components[CollisionComponent.self] == nil)
        scene.dispose()
    }

    @Test
    func aRaycastMaterializesTheDeferredColliders() throws {
        let (_, scene) = try makeScene()
        scene.applyCommands(javaScript: """
            [
              ["create", 173, "mesh", "wall"],
              ["geometry", 173, { "type": "BoxGeometry", "parameters": {"width":0.5,"height":0.5,"depth":0.02} },
               new Float32Array(0), null, null, null],
              ["transform", 173, 0, 0, -0.5, 0, 0, 0, 1, 1, 1, 1]
            ]
            """)
        #expect(try entity(scene, 173).components[CollisionComponent.self] == nil)

        let hits = scene.commandApplier.raycast(
            origin: SIMD3(0, 0, 0),
            direction: SIMD3(0, 0, -1),
            maxDistance: 2
        )
        #expect(hits.count == 8)
        #expect(Int(hits[0]) == 173)
        let collision = try #require(try entity(scene, 173).components[CollisionComponent.self])
        #expect(collision.filter.group == ScriptingCommandApplier.hitTestGroup)
        #expect(collision.filter.mask == ScriptingCommandApplier.hitTestGroup)
        scene.dispose()
    }

    @Test
    func jointsAreInstalledOnTheRoot() throws {
        let (root, scene) = try makeScene()
        scene.applyCommands(javaScript: """
            [
              ["create", 180, "mesh", "a"],
              ["geometry", 180, { "type": "BoxGeometry", "parameters": {"width":0.1,"height":0.1,"depth":0.1} },
               new Float32Array(0), null, null, null],
              ["rigidBody", 180, { "type": "static", "mass": 1, "shape": "box" }],
              ["create", 181, "mesh", "b"],
              ["geometry", 181, { "type": "BoxGeometry", "parameters": {"width":0.1,"height":0.1,"depth":0.1} },
               new Float32Array(0), null, null, null],
              ["rigidBody", 181, { "type": "dynamic", "mass": 1, "shape": "box" }],
              ["joint", 190, { "type": "revolute", "bodyA": 180, "bodyB": 181,
                "anchorA": [0, 0, 0], "anchorB": [0, 0.2, 0], "axis": [0, 1, 0],
                "limits": [-1, 1] }]
            ]
            """)
        let component = try #require(root.components[PhysicsJointsComponent.self])
        #expect(component.joints.count == 1)
        #expect(try entity(scene, 180).components[GeometricPinsComponent.self] != nil)

        scene.applyCommands(javaScript: #"[["joint", 190, null]]"#)
        #expect(root.components[PhysicsJointsComponent.self]?.joints.isEmpty == true)
        scene.dispose()
    }

    @Test
    func particlesUsePresetsAndExplicitFields() throws {
        let (_, scene) = try makeScene()
        scene.applyCommands(javaScript: """
            [
              ["create", 200, "particles", "sparks"],
              ["particles", 200, { "preset": "sparks", "isEmitting": true }],
              ["create", 201, "particles", "custom"],
              ["particles", 201, { "preset": null, "shape": "sphere", "shapeSize": [1, 2, 3],
                "birthRate": 250, "lifetime": 2, "lifetimeVariation": 0.5, "speed": 3,
                "speedVariation": 0.2, "size": 0.05, "sizeVariation": 0.01,
                "color": [1, 0, 0], "colorEnd": [0, 0, 1], "opacity": 1, "opacityEnd": 0,
                "spreadAngle": 0.5, "acceleration": [0, -2, 0], "isEmitting": false,
                "burstCount": 12, "loops": true, "texture": null }],
              ["particlesBurst", 201],
              ["create", 202, "particles", "smoke"],
              ["particles", 202, { "preset": "smoke", "isEmitting": true }],
              ["create", 203, "particles", "oneShot"],
              ["particles", 203, { "preset": null, "shape": "point", "birthRate": 50,
                "lifetime": 0.25, "isEmitting": true, "loops": false, "color": [1, 1, 1] }]
            ]
            """)
        let preset = try #require(try entity(scene, 200).components[ParticleEmitterComponent.self])
        #expect(preset.isEmitting)

        let custom = try #require(try entity(scene, 201).components[ParticleEmitterComponent.self])
        #expect(custom.emitterShape == .sphere)
        #expect(custom.emitterShapeSize == SIMD3<Float>(1, 2, 3))
        #expect(abs(custom.mainEmitter.birthRate - 250) < 1e-4)
        #expect(abs(custom.mainEmitter.lifeSpan - 2) < 1e-4)
        #expect(custom.burstCount == 12)
        #expect(custom.isEmitting == false)

        // C-08: smoke is a native preset now, so nothing warns about it.
        let smoke = try #require(try entity(scene, 202).components[ParticleEmitterComponent.self])
        #expect(smoke.emitterShape == .sphere)
        #expect(smoke.isEmitting)
        #expect(!scene.commandApplier.warnings.warnings.contains { $0.contains("smoke") })

        // C-07: loops = false stops the emitter after one lifetime.
        let applier = scene.commandApplier
        #expect(try entity(scene, 203).components[ParticleEmitterComponent.self]?.isEmitting == true)
        applier.advanceParticleLifetimes(deltaTime: 0.1)
        #expect(try entity(scene, 203).components[ParticleEmitterComponent.self]?.isEmitting == true)
        applier.advanceParticleLifetimes(deltaTime: 0.2)
        #expect(try entity(scene, 203).components[ParticleEmitterComponent.self]?.isEmitting == false)
        // A looping emitter is untouched.
        #expect(try entity(scene, 201).components[ParticleEmitterComponent.self] != nil)
        scene.dispose()
    }

    @Test
    func anchorsAndPortalsAreWired() throws {
        let (_, scene) = try makeScene()
        scene.applyCommands(javaScript: """
            [
              ["create", 210, "anchor", "headAnchor"],
              ["anchor", 210, { "kind": "head" }],
              ["create", 211, "group", "portalWorld"],
              ["world", 211, true],
              ["create", 212, "portal", "portal"],
              ["portal", 212, { "worldId": 211, "width": 0.5, "height": 0.8, "crossing": true }]
            ]
            """)
        let anchor = try #require(try entity(scene, 210) as? AnchorEntity)
        #expect(anchor.components[AnchoringComponent.self] != nil)
        #expect(try entity(scene, 211).components[WorldComponent.self] != nil)
        let portal = try entity(scene, 212)
        #expect(portal.components[PortalComponent.self] != nil)
        #expect((portal as? ModelEntity)?.model?.materials.first is PortalMaterial)
#if os(macOS)
        #expect(scene.commandApplier.warnings.warnings.contains { $0.contains("Head anchors") })
#endif
        scene.dispose()
    }

    @Test
    func assetCommandReportsAnErrorForAnUnsupportedKey() throws {
        let (_, scene) = try makeScene()
        scene.applyCommands(javaScript: """
            [
              ["create", 220, "asset", "robot"],
              ["asset", 220, { "glb": "https://example.com/robot.glb" }],
              ["assetAnimation", 220, "walk", true, 1]
            ]
            """)
        #expect(scene.commandApplier.warnings.warnings.contains { $0.contains("usdz") })
        scene.dispose()
    }

    @Test
    func logCommandReachesTheListener() throws {
        let root = Entity()
        nonisolated(unsafe) var entries: [ScriptingLogEntry] = []
        let scene = try JavaScriptScene(
            rootEntity: root,
            source: "const stage = new Spatial.Scene(); Spatial.mount(stage);",
            logListener: { entries.append($0) }
        )
        scene.applyCommands(javaScript: #"[["log", 0, "warn", "a warning from the core"]]"#)
        #expect(entries.contains { $0.level == .warn && $0.message == "a warning from the core" })
        scene.dispose()
    }

    @Test
    func ambientLightAndEnvironmentAreTrackedSeparately() throws {
        let (_, scene) = try makeScene()
        scene.applyCommands(javaScript: """
            [
              ["create", 230, "ambientLight", "ambient"],
              ["light", 230, { "type": "ambient", "color": [1, 1, 1], "intensity": 1,
                "distance": 0, "decay": 2, "angle": 0, "penumbra": 0, "castShadow": false,
                "direction": null }]
            ]
            """)
        let applier = scene.commandApplier
        // The ambient light installs an image based light of its own.
        let holder = try #require(applier.currentEnvironmentEntity)
        #expect(holder.components[ImageBasedLightComponent.self] != nil)
        #expect(applier.ambientLight != nil)
        #expect(applier.explicitEnvironment == nil)

        // C-30: an explicit environment outranks it and warns once.
        applier.explicitEnvironment = (applier.ambientLight!.resource, 3)
        applier.refreshImageBasedLight()
        #expect(applier.warnings.warnings.contains { $0.contains("AmbientLight intensity is ignored") })
        #expect(
            applier.currentEnvironmentEntity?.components[ImageBasedLightComponent.self]?.intensityExponent == 3
        )

        // Removing it restores the ambient one rather than leaving the scene dark.
        scene.applyCommands(javaScript: #"[["environment", 0, null]]"#)
        #expect(applier.explicitEnvironment == nil)
        #expect(
            applier.currentEnvironmentEntity?.components[ImageBasedLightComponent.self]?.intensityExponent == 1
        )

        // C-44: destroying the ambient light clears the holder entirely.
        scene.applyCommands(javaScript: #"[["destroy", 230]]"#)
        #expect(applier.currentEnvironmentEntity == nil)
        let dump = scene.nativeDump()
        #expect(dump["environment"] is NSNull)
        scene.dispose()
    }

    @Test
    func nativeDumpMirrorsTheEntityGraph() throws {
        let (_, scene) = try makeScene()
        scene.applyCommands(javaScript: """
            [
              ["create", 240, "mesh", "cube"],
              ["geometry", 240, { "type": "BoxGeometry", "parameters": {"width":0.2,"height":0.2,"depth":0.2} },
               new Float32Array(0), null, null, null],
              ["material", 240, { "type": "MeshStandardMaterial", "color": [0.1, 0.2, 0.3],
                "opacity": 1, "metalness": 0, "roughness": 1, "maps": {} }],
              ["transform", 240, 0.5, 0, 0, 0, 0, 0, 1, 1, 1, 1]
            ]
            """)
        let dump = scene.nativeDump()
        #expect(dump["backend"] as? String == "realitykit")
        let objects = try #require(dump["objects"] as? [[String: Any]])
        let cube = try #require(objects.first { $0["name"] as? String == "cube" })
        #expect(cube["type"] as? String == "Mesh")
        let position = try #require(cube["position"] as? [Float])
        #expect(abs(position[0] - 0.5) < 1e-4)
        let material = try #require(cube["material"] as? [String: Any])
        #expect(material["type"] as? String == "MeshStandardMaterial")
        // SPEC 8: native class names live in `components` and nowhere else, so
        // the class RealityKit built for each slot is named there.
        #expect(material["nativeType"] == nil)
        let components = try #require(cube["components"] as? [String])
        #expect(components.contains("ModelComponent"))
        #expect(components.contains("nativeMaterial:PhysicallyBasedMaterial"))
        scene.dispose()
    }

    @Test
    func transformOnADynamicBodyZeroesVelocity() throws {
        let (_, scene) = try makeScene()
        scene.applyCommands(javaScript: """
            [
              ["create", 250, "mesh", "body"],
              ["geometry", 250, { "type": "BoxGeometry", "parameters": {"width":0.1,"height":0.1,"depth":0.1} },
               new Float32Array(0), null, null, null],
              ["rigidBody", 250, { "type": "dynamic", "mass": 1, "shape": "box" }],
              ["bodyVelocity", 250, 5, 5, 5, null, null, null],
              ["transform", 250, 0, 1, 0, 0, 0, 0, 1, 1, 1, 1]
            ]
            """)
        let motion = try #require(try entity(scene, 250).components[PhysicsMotionComponent.self])
        #expect(motion.linearVelocity == .zero)
        scene.dispose()
    }

    @Test
    func triggerVolumesCollideWithoutPushing() throws {
        let (_, scene) = try makeScene()
        scene.applyCommands(javaScript: """
            [
              ["create", 260, "mesh", "trigger"],
              ["geometry", 260, { "type": "BoxGeometry", "parameters": {"width":0.15,"height":0.15,"depth":0.15} },
               new Float32Array(0), null, null, null],
              ["rigidBody", 260, { "type": "static", "mass": 1, "shape": "box", "isTrigger": true }],
              ["create", 261, "mesh", "solid"],
              ["geometry", 261, { "type": "BoxGeometry", "parameters": {"width":0.15,"height":0.15,"depth":0.15} },
               new Float32Array(0), null, null, null],
              ["rigidBody", 261, { "type": "static", "mass": 1, "shape": "box", "isTrigger": false }]
            ]
            """)

        let trigger = try entity(scene, 260)
        let collision = try #require(trigger.components[CollisionComponent.self])
        #expect(collision.mode == .trigger)
        #expect(collision.filter.group == ScriptingCommandApplier.physicsGroup)
        // A trigger that also carries a physics body still blocks solids, so it
        // must be a collider only.
        #expect(trigger.components[PhysicsBodyComponent.self] == nil)

        let solid = try entity(scene, 261)
        #expect(solid.components[PhysicsBodyComponent.self] != nil)
        #expect(solid.components[CollisionComponent.self]?.mode == .default)
        scene.dispose()
    }

    @Test
    func bodyVelocityIsMeasuredByFiniteDifference() throws {
        let (_, scene) = try makeScene()
        scene.applyCommands(javaScript: """
            [
              ["create", 270, "mesh", "mover"],
              ["geometry", 270, { "type": "BoxGeometry", "parameters": {"width":0.1,"height":0.1,"depth":0.1} },
               new Float32Array(0), null, null, null],
              ["rigidBody", 270, { "type": "dynamic", "mass": 1, "shape": "box" }]
            ]
            """)
        let applier = scene.commandApplier
        let record = try #require(applier.records[270])
        let step = 1.0 / 60

        applier.sampleBodyMotion(deltaTime: step)
        record.entity.position = SIMD3(0, 0.5, 0)
        applier.sampleBodyMotion(deltaTime: step)
        #expect(abs(record.linearVelocity.y - 30) < 0.01)
        #expect(record.isSleeping == false)

        record.entity.orientation = simd_quatf(angle: .pi / 6, axis: SIMD3(0, 1, 0))
        applier.sampleBodyMotion(deltaTime: step)
        #expect(abs(record.angularVelocity.y - Float.pi / 6 * 60) < 0.5)

        // Standing still for ten frames counts as asleep.
        for _ in 0..<12 { applier.sampleBodyMotion(deltaTime: step) }
        #expect(record.linearVelocity == .zero)
        #expect(record.isSleeping)

        let records = applier.bodyVelocitySyncRecords()
        #expect(records.count == 8)
        #expect(records[0] == 270)
        #expect(records[7] == 1)
        scene.dispose()
    }

    @Test
    func batchedTransformsMatchTheSingleOpcode() throws {
        let (_, scene) = try makeScene()
        scene.applyCommands(javaScript: """
            [["create", 280, "group", "a"], ["create", 281, "group", "b"]]
            """)
        scene.applyCommands(javaScript: """
            [["transforms", 0, new Float32Array([
              280, 1, 2, 3, 0, 0, 0, 1, 2, 2, 2,
              281, -1, -2, -3, 0, 0, 0, 1, 1, 1, 1
            ])]]
            """)
        #expect(try entity(scene, 280).position == SIMD3<Float>(1, 2, 3))
        #expect(try entity(scene, 280).scale == SIMD3<Float>(2, 2, 2))
        #expect(try entity(scene, 281).position == SIMD3<Float>(-1, -2, -3))

        // The single opcode stays accepted and means the same thing.
        scene.applyCommands(javaScript: #"[["transform", 280, 4, 5, 6, 0, 0, 0, 1, 1, 1, 1]]"#)
        #expect(try entity(scene, 280).position == SIMD3<Float>(4, 5, 6))
        scene.dispose()
    }

    @Test
    func sharedGeometryAndMaterialsBuildOneNativeResource() throws {
        let (_, scene) = try makeScene()
        var commands = "["
        for index in 0..<50 {
            let id = 300 + index
            commands += "[\"create\", \(id), \"mesh\", \"m\(index)\"],"
            commands += "[\"geometry\", \(id), { \"type\": \"BoxGeometry\", \"uuid\": \"shared-geo\", "
            commands += "\"parameters\": {\"width\":0.1,\"height\":0.1,\"depth\":0.1} }, new Float32Array(0), null, null, null],"
            commands += "[\"material\", \(id), { \"type\": \"MeshStandardMaterial\", \"uuid\": \"shared-mat\", "
            commands += "\"color\": [0.2, 0.4, 0.8], \"opacity\": 1, \"metalness\": 0, \"roughness\": 1, \"maps\": {} }],"
        }
        commands.removeLast()
        commands += "]"
        scene.applyCommands(javaScript: commands)

        let cache = scene.commandApplier.resources.summary
        #expect(cache["meshBuilds"] == 1)
        #expect(cache["meshHits"] == 49)
        #expect(cache["materialBuilds"] == 1)
        #expect(cache["materialHits"] == 49)
        // Colliders are deferred, so none has been built yet; one raycast
        // materializes all fifty from a single cached shape.
        #expect(cache["shapeBuilds"] == 0)
        _ = scene.commandApplier.raycast(
            origin: SIMD3(0, 0, 1),
            direction: SIMD3(0, 0, -1),
            maxDistance: 10
        )
        let afterRaycast = scene.commandApplier.resources.summary
        #expect(afterRaycast["shapeBuilds"] == 1)
        #expect(afterRaycast["shapeHits"] == 49)
        scene.dispose()
    }

    @Test
    func geometryDescriptorIsRecordedEvenWithoutAMesh() throws {
        let (_, scene) = try makeScene()
        scene.applyCommands(javaScript: """
            [
              ["create", 310, "mesh", "bare"],
              ["geometry", 310, { "type": "BufferGeometry", "parameters": null },
               new Float32Array(0), null, null, null]
            ]
            """)
        let objects = try #require(scene.nativeDump()["objects"] as? [[String: Any]])
        let bare = try #require(objects.first { $0["name"] as? String == "bare" })
        let geometry = try #require(bare["geometry"] as? [String: Any])
        #expect(geometry["type"] as? String == "BufferGeometry")
        scene.dispose()
    }

    @Test
    func collisionEventsCarryAContactPointAndNormal() throws {
        let (_, scene) = try makeScene()
        scene.applyCommands(javaScript: """
            [
              ["create", 320, "mesh", "a"],
              ["geometry", 320, { "type": "BoxGeometry", "parameters": {"width":0.1,"height":0.1,"depth":0.1} },
               new Float32Array(0), null, null, null],
              ["rigidBody", 320, { "type": "dynamic", "mass": 1, "shape": "box" }],
              ["create", 321, "mesh", "b"],
              ["geometry", 321, { "type": "BoxGeometry", "parameters": {"width":0.1,"height":0.1,"depth":0.1} },
               new Float32Array(0), null, null, null],
              ["rigidBody", 321, { "type": "static", "mass": 1, "shape": "box" }]
            ]
            """)
        let applier = scene.commandApplier
        nonisolated(unsafe) var events: [(String, Int, [String: Any])] = []
        applier.dispatch = { type, id, payload in events.append((type, id, payload ?? [:])) }

        let a = try entity(scene, 320)
        let b = try entity(scene, 321)
        applier.reportCollisionForTesting(
            a, b, began: true, impulse: 4, position: SIMD3(0.1, 0.2, 0.3), normal: SIMD3(0, 2, 0)
        )
        let start = try #require(events.first { $0.0 == "collisionstart" })
        #expect(start.2["point"] as? [Float] == [0.1, 0.2, 0.3])
        // The impulse direction is normalized before it reaches the script.
        #expect(start.2["normal"] as? [Float] == [0, 1, 0])
        #expect((start.2["impulse"] as? Float) == 4)
        #expect(start.2["other"] as? Int == 321)

        // Ended carries no contact of its own, so the pair's last one is reused.
        applier.reportCollisionForTesting(a, b, began: false, impulse: 0, position: nil, normal: nil)
        let end = try #require(events.first { $0.0 == "collisionend" })
        #expect(end.2["point"] as? [Float] == [0.1, 0.2, 0.3])
        #expect(end.2["normal"] as? [Float] == [0, 1, 0])
        #expect((end.2["impulse"] as? Float) == 0)
        scene.dispose()
    }

    @Test
    func aBodyWithoutGeometryWarnsAndIsIgnored() throws {
        let (_, scene) = try makeScene()
        scene.applyCommands(javaScript: """
            [
              ["create", 330, "group", "bodiless"],
              ["rigidBody", 330, { "type": "dynamic", "mass": 1, "shape": "convex" }]
            ]
            """)
        #expect(try entity(scene, 330).components[PhysicsBodyComponent.self] == nil)
        #expect(scene.commandApplier.warnings.warnings.contains { $0.contains("no geometry") })
        scene.dispose()
    }

    @Test
    func physicsHelpersWorkOnAnyKindOfObject() throws {
        let (_, scene) = try makeScene()
        scene.applyCommands(javaScript: """
            [
              ["create", 340, "asset", "rig"],
              ["geometry", 340, { "type": "BoxGeometry", "parameters": {"width":0.1,"height":0.1,"depth":0.1} },
               new Float32Array(0), null, null, null],
              ["rigidBody", 340, { "type": "dynamic", "mass": 2, "shape": "box" }],
              ["bodyImpulse", 340, 0, 4, 0, null, null, null],
              ["bodyForce", 340, 1, 0, 0],
              ["bodyTorque", 340, 0, 0, 1]
            ]
            """)
        // An asset group is a ModelEntity now, so the RealityKit helpers apply.
        #expect(try entity(scene, 340) is ModelEntity)
        #expect(try entity(scene, 340).components[PhysicsBodyComponent.self] != nil)
        scene.dispose()
    }

    @Test
    func partialPrimitivesFallBackToTheCommandBuffers() throws {
        let (_, scene) = try makeScene()
        #expect(ScriptingGeometryFactory.partialReason(
            type: "SphereGeometry",
            parameters: ["radius": 0.1, "phiLength": Double.pi]
        ) != nil)
        #expect(ScriptingGeometryFactory.partialReason(
            type: "SphereGeometry",
            parameters: ["radius": 0.1, "phiLength": Double.pi * 2, "thetaLength": Double.pi]
        ) == nil)
        #expect(ScriptingGeometryFactory.partialReason(
            type: "ConeGeometry",
            parameters: ["radius": 0.1, "height": 0.2, "openEnded": true]
        ) != nil)

        scene.applyCommands(javaScript: """
            [
              ["create", 350, "mesh", "hemisphere"],
              ["geometry", 350, { "type": "SphereGeometry",
                "parameters": {"radius":0.1,"widthSegments":8,"heightSegments":4,
                               "phiStart":0,"phiLength":3.141592653589793,
                               "thetaStart":0,"thetaLength":3.141592653589793} },
               new Float32Array([0,0,0, 0.1,0,0, 0,0.1,0]), null, null, new Uint32Array([0,1,2])]
            ]
            """)
        let model = try #require(try entity(scene, 350) as? ModelEntity)
        // Three vertices from the buffers, not a full generated sphere.
        let bounds = try #require(model.model?.mesh.bounds)
        #expect(bounds.max.x <= 0.11)
        #expect(bounds.min.z >= -0.001)
        #expect(scene.commandApplier.warnings.warnings.contains { $0.contains("phiLength") })
        scene.dispose()
    }

    @Test
    func textureWrapModesAndFlipYAreDecodedAndUsed() throws {
        let (_, scene) = try makeScene()
        nonisolated(unsafe) var loaded: [Int] = []
        scene.commandApplier.dispatch = { type, id, _ in
            if type == "textureLoaded" { loaded.append(id) }
        }
        scene.applyCommands(javaScript: """
            [
              ["texture", 360, { "url": "asset://missing", "repeat": [2, 3], "offset": [0, 0],
                "wrapS": 1001, "wrapT": 1002, "flipY": false }]
            ]
            """)
        let entry = try #require(scene.commandApplier.textures.entry(for: 360))
        #expect(entry.wrapS == 1001)
        #expect(entry.wrapT == 1002)
        #expect(entry.flipY == false)

        // C-19: re-emitting the texture for a property change must not resolve
        // the script's load callback.
        scene.applyCommands(javaScript: """
            [
              ["texture", 360, { "url": "asset://missing", "repeat": [4, 4], "offset": [0.5, 0],
                "wrapS": 1000, "wrapT": 1000, "flipY": true }]
            ]
            """)
        #expect(scene.commandApplier.textures.entry(for: 360)?.repeats == SIMD2<Float>(4, 4))
        #expect(loaded.isEmpty, "textureLoaded fired without a resource")
        scene.dispose()
    }

    @Test
    func macOSKeyCodesFollowKeyboardEventNames() {
        #expect(ScriptingKeyCodes.name(for: 13) == "KeyW")
        #expect(ScriptingKeyCodes.name(for: 49) == "Space")
        #expect(ScriptingKeyCodes.name(for: 36) == "Enter")
        #expect(ScriptingKeyCodes.name(for: 53) == "Escape")
        #expect(ScriptingKeyCodes.name(for: 51) == "Backspace")
        #expect(ScriptingKeyCodes.name(for: 48) == "Tab")
        #expect(ScriptingKeyCodes.name(for: 29) == "Digit0")
        #expect(ScriptingKeyCodes.name(for: 27) == "Minus")
        #expect(ScriptingKeyCodes.name(for: 24) == "Equal")
        #expect(ScriptingKeyCodes.name(for: 33) == "BracketLeft")
        #expect(ScriptingKeyCodes.name(for: 126) == "ArrowUp")
        #expect(ScriptingKeyCodes.name(for: 123) == "ArrowLeft")
        // Modifiers, which only arrive through .flagsChanged.
        #expect(ScriptingKeyCodes.name(for: 56) == "ShiftLeft")
        #expect(ScriptingKeyCodes.name(for: 60) == "ShiftRight")
        #expect(ScriptingKeyCodes.name(for: 59) == "ControlLeft")
        #expect(ScriptingKeyCodes.name(for: 62) == "ControlRight")
        #expect(ScriptingKeyCodes.name(for: 58) == "AltLeft")
        #expect(ScriptingKeyCodes.name(for: 61) == "AltRight")
        #expect(ScriptingKeyCodes.name(for: 55) == "MetaLeft")
        #expect(ScriptingKeyCodes.name(for: 54) == "MetaRight")
        #expect(ScriptingKeyCodes.name(for: 122) == "F1")
        #expect(ScriptingKeyCodes.name(for: 115) == "Home")
        #expect(ScriptingKeyCodes.name(for: 117) == "Delete")
        #expect(ScriptingKeyCodes.name(for: 82) == "Numpad0")
    }

    @Test
    func consumerWarningsReachTheCoreDump() throws {
        let root = Entity()
        let scene = try JavaScriptScene(rootEntity: root, source: """
            const stage = new Spatial.Scene();
            const box = new Spatial.Mesh(
              new Spatial.BoxGeometry(0.1, 0.1, 0.1),
              new Spatial.MeshStandardMaterial()
            );
            box.name = "box";
            box.hoverEffect = "lift";
            stage.add(box);
            Spatial.mount(stage);
            """)
        scene.tick(deltaTime: 1.0 / 60)
        scene.tick(deltaTime: 1.0 / 60)
        let warnings = scene.dump()["warnings"] as? [String] ?? []
#if os(visionOS)
        #expect(warnings.contains { $0.contains("lift") })
#else
        // macOS accepts hoverEffect with no visual and no warning, so this
        // asserts the bridge itself with a warning macOS does raise.
        scene.commandApplier.warnings.warnOnce("a consumer warning", key: "test-bridge")
        scene.tick(deltaTime: 1.0 / 60)
        let after = scene.dump()["warnings"] as? [String] ?? []
        #expect(after.contains { $0.contains("a consumer warning") })
#endif
        scene.dispose()
    }

    @Test
    func validateAcceptsTopLevelAwait() throws {
        try ScriptingRuntime.validateScript("const value = await Promise.resolve(1);")
        #expect(throws: (any Error).self) {
            try ScriptingRuntime.validateScript("const = ;")
        }
    }

    @Test
    func theParityPlanRunsDeterministically() async throws {
        func run() async throws -> [Float] {
            let root = Entity()
            let scene = try JavaScriptScene(rootEntity: root, source: """
                const stage = new Spatial.Scene();
                const box = new Spatial.Mesh(
                  new Spatial.BoxGeometry(0.1, 0.1, 0.1),
                  new Spatial.MeshBasicMaterial()
                );
                box.name = "box";
                box.userData.taps = 0;
                box.addEventListener("tap", () => { box.userData.taps += 1; });
                stage.add(box);
                Spatial.onFrame((dt) => { box.position.x += dt; });
                Spatial.mount(stage);
                """)
            // No display loop in a unit test, so the plan's frames are ticked
            // here; the ordering of injects against them is what is asserted.
            scene.tick(deltaTime: 1.0 / 60)
            for _ in 0..<9 { scene.tick(deltaTime: 1.0 / 60) }
            scene.injectTap(target: "box")
            for _ in 0..<5 { scene.tick(deltaTime: 1.0 / 60) }
            let objects = scene.dump()["objects"] as? [[String: Any]] ?? []
            let box = objects.first { $0["name"] as? String == "box" } ?? [:]
            let taps = (box["userData"] as? [String: Any])?["taps"] as? NSNumber
            #expect(taps?.intValue == 1)
            let position = box["position"] as? [Any] ?? []
            scene.dispose()
            return position.compactMap { ($0 as? NSNumber)?.floatValue }
        }
        let first = try await run()
        let second = try await run()
        #expect(first == second, "the same plan produced different states")
        #expect(abs((first.first ?? 0) - 15.0 / 60) < 1e-4)
    }

    @Test
    func aPausedSceneHoldsItsLastFrame() throws {
        let (_, scene) = try makeScene()
        scene.applyCommands(javaScript: #"[["create", 370, "group", "held"]]"#)
        scene.fixedDeltaTime = 1.0 / 60
        scene.tick(deltaTime: 5)
        let frames = scene.frameStats()["frames"] as? Int ?? 0
        scene.isPaused = true
        for _ in 0..<10 { scene.tick(deltaTime: 1.0 / 60) }
        #expect(scene.frameStats()["frames"] as? Int == frames)
        scene.isPaused = false
        scene.tick(deltaTime: 1.0 / 60)
        #expect((scene.frameStats()["frames"] as? Int ?? 0) > frames)
        scene.dispose()
    }

    @Test
    func aDisposedSceneIsReleased() throws {
        weak var weakScene: JavaScriptScene?
        do {
            let root = Entity()
            let scene = try JavaScriptScene(
                rootEntity: root,
                source: "const stage = new Spatial.Scene(); Spatial.mount(stage);"
            )
            scene.tick(deltaTime: 1.0 / 60)
            weakScene = scene
            scene.dispose()
        }
        #expect(weakScene == nil, "the scene is still retained after dispose")
    }

    @Test
    func nativeDumpReportsLightsOnTheirOwnRecord() throws {
        let root = Entity()
        let scene = try JavaScriptScene(rootEntity: root, source: """
            const stage = new Spatial.Scene();
            const sun = new Spatial.DirectionalLight(0xffffff, 2);
            sun.name = "sun";
            sun.position.set(1, 2, 1);
            stage.add(sun);
            const lamp = new Spatial.PointLight(0xff0000, 3, 4);
            lamp.name = "lamp";
            stage.add(lamp);
            Spatial.mount(stage);
            """)
        scene.tick(deltaTime: 1.0 / 60)
        let objects = try #require(scene.nativeDump()["objects"] as? [[String: Any]])
        let sun = try #require(objects.first { $0["name"] as? String == "sun" })
        let sunLight = try #require(sun["light"] as? [String: Any])
        #expect(sunLight["type"] as? String == "directional")
        #expect(abs(((sunLight["intensity"] as? NSNumber)?.floatValue ?? 0) - 2) < 0.01)
        let lamp = try #require(objects.first { $0["name"] as? String == "lamp" })
        let lampLight = try #require(lamp["light"] as? [String: Any])
        #expect(lampLight["type"] as? String == "point")
        scene.dispose()
    }

    @Test
    func unknownOpcodesWarnRatherThanCrash() throws {
        let (_, scene) = try makeScene()
        scene.applyCommands(javaScript: #"[["notARealOpcode", 0, 1]]"#)
        #expect(scene.commandApplier.warnings.warnings.contains { $0.contains("notARealOpcode") })
        scene.dispose()
    }
}

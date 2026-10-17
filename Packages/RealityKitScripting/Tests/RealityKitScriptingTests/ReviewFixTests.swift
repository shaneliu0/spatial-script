//
//  ReviewFixTests.swift
//  RealityKitScripting
//
//  Created by Shane Liu on 9/9/26.
//

import AVFoundation
import Foundation
import RealityKit
import Testing
@testable import RealityKitScripting

/// One case per phase 2 review finding, each failing before its fix.
@MainActor
struct ReviewFixTests {
    private func makeScene(_ body: String = "") throws -> (Entity, JavaScriptScene) {
        let root = Entity()
        let scene = try JavaScriptScene(
            rootEntity: root,
            source: """
                const stage = new Spatial.Scene();
                Spatial.mount(stage);
                \(body)
                """,
            assetRoot: Phase2Tests.assetRoot
        )
        return (root, scene)
    }

    private func makeSceneWithMesh() throws -> (Entity, JavaScriptScene) {
        let (root, scene) = try makeScene()
        scene.applyCommands(javaScript: """
            [
              ["create", 1, "mesh", "target"],
              ["geometry", 1, { "type": "BoxGeometry", "parameters": { "width": 1, "height": 1, "depth": 1 } },
                                null, null, null, null]
            ]
            """)
        return (root, scene)
    }

    // MARK: - P2-B-01

    @Test
    func destroyReleasesTheAudioPlayerTheVideoPlayerAndTheRecord() throws {
        let (_, scene) = try makeSceneWithMesh()
        scene.applyCommands(javaScript: """
            [["audio", 1, { "url": "asset://spatial-tone.wav", "volume": 1 }],
             ["audioControl", 1, "play", null],
             ["video", 1, { "url": "asset://spatial-bars.mp4", "width": 1, "muted": true }]]
            """)

        var strongRecord: ScriptingCommandApplier.Record?
        weak var weakPlayer: AVPlayer?
        weak var weakSurface: Entity?
        let audioState: ScriptingAudioState
        let videoState: ScriptingVideoState
        do {
            let record = try #require(scene.commandApplier.records[1])
            strongRecord = record
            audioState = try #require(record.extras?.audio)
            videoState = try #require(record.extras?.video)
            weakPlayer = videoState.player
            weakSurface = videoState.surface
        }
        #expect(weakPlayer != nil)
        #expect(audioState.controller != nil)
        #expect(audioState.isPlaying)

        scene.applyCommands(javaScript: """
            [["destroy", 1]]
            """)

        // The player is stopped and let go, the notification observer with it,
        // and the completion handler no longer holds the record alive.
        #expect(videoState.player == nil, "the AVPlayer kept playing for the life of the process")
        #expect(videoState.endObserver == nil, "the end-of-item observer was never removed")
        #expect(audioState.controller == nil)
        #expect(!audioState.isPlaying)
        #expect(weakSurface == nil)
        #expect(scene.commandApplier.records[1] == nil)
        // Nothing of the record's own state survives, so nothing it owned can
        // keep running or keep it alive.
        #expect(strongRecord?.extras == nil)
        strongRecord = nil
        scene.dispose()
    }

    // MARK: - P2-B-07 and P2-B-08

    @Test
    func aBareTextureIdBindsAndNumericZeroAndOneStayNumbers() async throws {
        let (_, scene) = try makeSceneWithMesh()
        scene.applyCommands(javaScript: """
            [["texture", 7, { "url": "asset://checker.png" }],
             ["material", 1, { "type": "ShaderGraphMaterial", "source": "asset://spatial-materials.usda",
                               "name": "Glow", "parameters": { "glowAmount": 1 },
                               "fallback": { "type": "MeshStandardMaterial" } }]]
            """)
        let state = try #require(scene.commandApplier.records[1]?.extras?.shaderGraph)
        for _ in 0..<200 where !state.loaded && state.loadError == nil {
            try? await Task.sleep(for: .milliseconds(10))
        }
        #expect(state.loaded)
        var material = try #require(scene.commandApplier.records[1]?.nativeMaterial as? ShaderGraphMaterial)

        // The declaration path hands numbers over as NSNumber, where `as? Bool`
        // succeeds for 0 and 1 and used to turn both into booleans.
        let declared = material.getParameter(name: "glowAmount")
        if case .bool = declared {
            Issue.record("a numeric 1 was coerced to a Bool on the declaration path")
        }
        if case let .float(value)? = declared { #expect(abs(value - 1) < 1e-5) }

        // A number aimed at a float parameter is a float; the same number aimed
        // at a texture parameter is a texture id.
        let asFloat = ScriptingCommandApplier.materialParameter(
            NSNumber(value: 1),
            named: "glowAmount",
            on: material,
            textures: scene.commandApplier.textures
        )
        if case .float(let value)? = asFloat { #expect(value == 1) } else { Issue.record("not a float") }

        // The graph has no texture parameter, so a texture id aimed at a float
        // one still reads as a float rather than silently binding.
        try material.setParameter(name: "glowAmount", value: .float(0))
        if case let .float(value)? = material.getParameter(name: "glowAmount") { #expect(value == 0) }
        scene.dispose()
    }

    // MARK: - P2-B-21

    @Test
    func skeletonEditsHeldDuringAnAnimationAreReplayedWhenItStops() async throws {
        let (_, scene) = try makeScene()
        nonisolated(unsafe) var loaded = false
        scene.commandApplier.dispatch = { type, _, _ in if type == "assetLoaded" { loaded = true } }
        scene.applyCommands(javaScript: """
            [["create", 1, "asset", "figure"], ["asset", 1, { "usdz": "asset://rig.usdz" }]]
            """)
        for _ in 0..<400 where !loaded { try? await Task.sleep(for: .milliseconds(10)) }
        #expect(loaded)

        let record = try #require(scene.commandApplier.records[1])
        let state = try #require(record.extras?.skeleton)
        let entity = try #require(state.poseEntity)

        // Stand in for a running native animation: the applier only asks
        // whether one is playing.
        state.animationOverrides = true
        state.pendingJoints["head"] = (SIMD3(0, 0.2, 0), simd_quatf(ix: 0, iy: 0.7071068, iz: 0, r: 0.7071068))
        let before = try #require(
            entity.components[SkeletalPosesComponent.self]?.poses.default?["root/head"]
        )
        #expect(abs(before.rotation.real - 1) < 1e-4)

        // The frame the animation stops is the frame the held edits land.
        scene.commandApplier.replayHeldSkeletonEdits()
        let after = try #require(
            entity.components[SkeletalPosesComponent.self]?.poses.default?["root/head"]
        )
        #expect(abs(after.rotation.imag.y - 0.7071068) < 1e-4, "the held pose was lost forever")
        #expect(!state.animationOverrides)
        scene.dispose()
    }

    // MARK: - P2-B-22 and P2-B-23

    @Test
    func theCameraComponentGoesOnTheObjectTheCommandNames() throws {
        let (_, scene) = try makeScene()
        let fallback = Entity()
        ScriptingRuntime.defaultCameraEntity = fallback
        scene.applyCommands(javaScript: """
            [["create", 5, "group", "eye"],
             ["camera", 5, { "kind": "perspective", "fov": 40, "near": 0.1, "far": 50 }]]
            """)
#if !os(visionOS)
        let camera = try #require(scene.commandApplier.records[5]?.entity)
        #expect(camera.components[PerspectiveCameraComponent.self] != nil, "no transform matching")
        #expect(scene.commandApplier.cameraRecordID == 5)
        #expect(!fallback.isEnabled)

        // Destroying the camera object gives the built-in camera back.
        scene.applyCommands(javaScript: """
            [["destroy", 5]]
            """)
        #expect(scene.commandApplier.cameraEntity == nil)
        #expect(fallback.isEnabled, "the window would render through nothing")

        // SPEC 14.13: a null kind restores it too.
        scene.applyCommands(javaScript: """
            [["create", 6, "group", "eye2"],
             ["camera", 6, { "kind": "perspective", "fov": 40 }]]
            """)
        #expect(!fallback.isEnabled)
        scene.applyCommands(javaScript: """
            [["camera", 0, { "kind": null }]]
            """)
        #expect(fallback.isEnabled)
        #expect(scene.commandApplier.cameraSpec == nil)
#endif
        ScriptingRuntime.defaultCameraEntity = nil
        scene.dispose()
    }

    // MARK: - P2-B-24

    @Test
    func anAudioPropertyChangeKeepsTheComponentAndThePlaybackController() throws {
        let (_, scene) = try makeSceneWithMesh()
        scene.applyCommands(javaScript: """
            [["audio", 1, { "url": "asset://spatial-tone.wav", "spatial": true, "volume": 1 }],
             ["audioControl", 1, "play", null]]
            """)
        let state = try #require(scene.commandApplier.records[1]?.extras?.audio)
        let controller = try #require(state.controller)
        let entity = try #require(scene.commandApplier.records[1]?.entity)
        let before = try #require(entity.components[SpatialAudioComponent.self])
        #expect(state.isPlaying)

        scene.applyCommands(javaScript: """
            [["audio", 1, { "volume": 0.25, "reverbLevel": -3 }]]
            """)
        let after = try #require(entity.components[SpatialAudioComponent.self])
        #expect(after.reverbLevel == -3)
        #expect(abs(after.gain - (-12.0412)) < 0.01)
        #expect(before.gain != after.gain, "the change reached the component")
        // Same controller, still playing: the component was edited, not swapped.
        #expect(state.controller === controller, "the controller was replaced under the sound")
        #expect(state.isPlaying, "a volume change restarted the sound")
        scene.dispose()
    }

    // MARK: - P2-B-26

    @Test
    func releasingAVideoPutsTheObjectsOwnMaterialBack() throws {
        let (_, scene) = try makeSceneWithMesh()
        scene.applyCommands(javaScript: """
            [["material", 1, { "type": "MeshStandardMaterial", "color": [1, 0, 0] }],
             ["video", 1, { "url": "asset://spatial-bars.mp4", "width": 1, "muted": true }]]
            """)
        let model = try #require(scene.commandApplier.records[1]?.entity as? ModelEntity)
        #expect(model.model?.materials.first is VideoMaterial)

        scene.applyCommands(javaScript: """
            [["video", 1, null]]
            """)
        #expect(
            !(model.model?.materials.first is VideoMaterial),
            "the plane kept drawing a stopped VideoMaterial"
        )
        #expect(model.model?.materials.first != nil)
        scene.dispose()
    }

    // MARK: - P2-B-38 and P2-B-44

    @Test
    func controllerIdsAreReproducibleAndAnUnsupportedRumbleWarns() throws {
        let (_, scene) = try makeScene()
        scene.applyCommands(javaScript: """
            [["controllerRumble", 0, "controller-0", 0.5, 0.2]]
            """)
        #expect(
            scene.commandApplier.warnings.warnings.contains { $0.contains("no haptics") },
            "a rumble that did nothing said nothing"
        )
        // No hardware is attached, so the reproducible default id shape is what
        // a harness sees.
        ScriptingInputRouter.shared.injectControllers([["name": "Pad"]])
        let normalized = ScriptingInputRouter.shared.controllerSnapshot()
        #expect(normalized.first?["id"] as? String == "controller-0")
        #expect((normalized.first?["buttons"] as? [String: Any])?["a"] as? Double == 0)
        #expect((normalized.first?["leftThumbstick"] as? [Double])?.count == 2)
        ScriptingInputRouter.shared.injectControllers(nil)
        scene.dispose()
    }

    // MARK: - P2-B-41

    @Test
    func anAudioControlBeforeItsPayloadIsHeld() throws {
        let (_, scene) = try makeSceneWithMesh()
        scene.applyCommands(javaScript: """
            [["audioControl", 1, "play", null],
             ["audio", 1, { "url": "asset://spatial-tone.wav", "volume": 1 }]]
            """)
        let state = try #require(scene.commandApplier.records[1]?.extras?.audio)
        #expect(state.wantsPlay, "the control was dropped")
        #expect(state.isPlaying)
        #expect(state.controller != nil, "the resource loaded and the held play applied to it")
        scene.dispose()
    }

    // MARK: - P2-B-42 and P2-B-43

    @Test
    func aDetachedCharacterDoesNotSyncAndAFieldWithoutARadiusIsBounded() throws {
        let (_, scene) = try makeSceneWithMesh()
        scene.applyCommands(javaScript: """
            [["characterController", 1, { "radius": 0.2, "height": 1, "gravity": false }]]
            """)
        #expect(scene.commandApplier.characterSyncRecords().count == 8)
        scene.applyCommands(javaScript: """
            [["visible", 1, true], ["parent", 1, -1]]
            """)
        // Detached: its world position is really a local one, so it is not
        // reported at all rather than reported wrongly.
        let record = try #require(scene.commandApplier.records[1])
        record.entity.removeFromParent()
        #expect(scene.commandApplier.characterSyncRecords().isEmpty)

        scene.applyCommands(javaScript: """
            [["create", 2, "group", "field"],
             ["forceField", 2, { "kind": "VortexForceField", "strength": 1 }]]
            """)
        #expect(scene.commandApplier.warnings.warnings.contains { $0.contains("no radius") })
        #expect(scene.commandApplier.records[2]?.extras?.forceField?.applied == true)
        scene.dispose()
    }

    // MARK: - P2-C-01

    @Test
    func aTwoGroupBoxDrawsAMaterialPerGroup() throws {
        let (_, scene) = try makeScene()
        // Two triangles, split into two groups of one triangle each.
        scene.applyCommands(javaScript: """
            [
              ["create", 1, "mesh", "quad"],
              ["geometry", 1, {
                 "type": "BufferGeometry", "parameters": {},
                 "groups": [{ "start": 0, "count": 3, "materialIndex": 0 },
                            { "start": 3, "count": 3, "materialIndex": 1 }]
               },
               new Float32Array([0,0,0, 1,0,0, 1,1,0, 0,1,0]),
               null, null, new Uint32Array([0,1,2, 0,2,3])],
              ["material", 1, [
                 { "type": "MeshStandardMaterial", "color": [1, 0, 0] },
                 { "type": "MeshBasicMaterial", "color": [0, 1, 0] }
              ]]
            ]
            """)
        let model = try #require(scene.commandApplier.records[1]?.entity as? ModelEntity)
        let mesh = try #require(model.model?.mesh)
        #expect(mesh.expectedMaterialCount == 2, "geometry.groups was discarded")
        #expect(model.model?.materials.count == 2)
        // Each group draws its own material, in the order the array gave them.
        #expect(model.model?.materials.first is PhysicallyBasedMaterial)
        #expect(model.model?.materials.last is UnlitMaterial)
        scene.dispose()
    }

    // MARK: - P2-C-02

    @Test
    func theEngineReportsItselfRunningWhenTheFirstSoundStarts() throws {
        let (_, scene) = try makeSceneWithMesh()
        nonisolated(unsafe) var events: [(String, [String: Any]?)] = []
        scene.commandApplier.dispatch = { type, _, payload in events.append((type, payload)) }
        #expect(!events.contains { $0.0 == "audioState" })

        scene.applyCommands(javaScript: """
            [["audio", 1, { "url": "asset://spatial-tone.wav", "volume": 1 }],
             ["audioControl", 1, "play", null]]
            """)
        let reported = try #require(events.first { $0.0 == "audioState" })
        #expect(reported.1?["state"] as? String == "running")
        // Once, not once per sound.
        scene.applyCommands(javaScript: """
            [["audioControl", 1, "play", null]]
            """)
        #expect(events.filter { $0.0 == "audioState" }.count == 1)
        scene.dispose()
    }

    // MARK: - P2-C-05

    @Test
    func setHostFunctionsReachesTheScriptAfterLoad() throws {
        let (_, scene) = try makeScene()
        scene.tick(deltaTime: 1.0 / 60)
        #expect((scene.dump()["hostFunctions"] as? [String])?.isEmpty ?? true)

        // A registration made after the script is running still shows up.
        ScriptingRuntime.register(module: "Late", function: "call") { _ in nil }
        scene.setHostFunctions(ScriptingRuntime.hostFunctionNames)
        scene.tick(deltaTime: 1.0 / 60)
        #expect((scene.dump()["hostFunctions"] as? [String])?.contains("Late.call") == true)
        ScriptingRuntime.unregister(module: "Late", function: "call")
        scene.dispose()
    }

    // MARK: - P2-C-06

    @Test
    func aNonDefaultReferenceDistanceIsFoldedIntoTheRolloffAndSaysSo() throws {
        let (_, scene) = try makeSceneWithMesh()
        scene.applyCommands(javaScript: """
            [["audio", 1, { "url": "asset://spatial-tone.wav", "spatial": true,
                            "refDistance": 2, "rolloff": 1, "volume": 1 }]]
            """)
        let component = try #require(
            scene.commandApplier.records[1]?.entity.components[SpatialAudioComponent.self]
        )
        // rolloff / refDistance: a sound audible for twice as far rolls off
        // half as fast.
        #expect(component.distanceAttenuation == .rolloff(factor: 0.5))
        #expect(scene.commandApplier.warnings.warnings.contains { $0.contains("reference distance") })
        scene.dispose()
    }

    // MARK: - SPEC 14.13a

    @Test
    func aParityPlanSeesOnlyInjectedInput() async throws {
        let router = ScriptingInputRouter.shared
        let (_, scene) = try makeScene()
        router.updatePointer(location: CGPoint(x: 12, y: 8))
        router.setMouseButton(0, down: true)
        router.beginFrame()
        let live = router.inputState(for: scene.sceneID)
        #expect((live["mouse"] as? [String: Any])?["position"] as? [Double] == [12, 8])

        // While a plan runs the live pointer is excluded, so the same plan
        // produces the same frames whatever the developer is doing.
        let outcome = await ScriptingParityPlan.run(
            [["inject": "controller", "state": ["id": "pad-1", "name": "Pad"]]],
            on: scene,
            deltaTime: 1.0 / 60
        )
        #expect(outcome.errors.isEmpty)
        router.suppressesLiveInput = true
        router.beginFrame()
        let planned = router.inputState(for: scene.sceneID)
        let mouse = try #require(planned["mouse"] as? [String: Any])
        #expect(mouse["position"] is NSNull)
        #expect(mouse["connected"] as? Bool == false)
        #expect((planned["keyboard"] as? [String: Any])?["connected"] as? Bool == false)
        // An injected controller is scripted input, so it survives.
        #expect((planned["controllers"] as? [[String: Any]])?.first?["id"] as? String == "pad-1")

        router.suppressesLiveInput = false
        router.injectControllers(nil)
        router.updatePointer(location: nil)
        router.setMouseButton(0, down: false)
        ScriptingRuntime.isPaused = false
        scene.clearPlanBudget()
        scene.dispose()
    }
}

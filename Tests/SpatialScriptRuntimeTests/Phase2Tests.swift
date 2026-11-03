//
//  Phase2Tests.swift
//  SpatialScriptRuntime
//
//  Created by Shane Liu on 9/9/26.
//

import AVFoundation
import Foundation
import RealityKit
import Testing
@testable import SpatialScriptRuntime

/// SPEC section 14: parity with Apple's RealityKitScripting.
///
/// The core is still growing the emitting side, so every case here drives the
/// consumer with hand-built commands exactly as SPEC 14.13 defines them.
@MainActor
struct Phase2Tests {
    /// Media fixtures live with the macOS host, which is the target that ships
    /// them; the tests read them from there rather than keeping a second copy.
    static var assetRoot: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()   // SpatialScriptRuntimeTests
            .deletingLastPathComponent()   // Tests
            .deletingLastPathComponent()   // package root
            // SPEC 3.5: the one asset root both backends read.
            .appending(path: "assets")
    }

    private func makeScene(_ body: String = "") throws -> (Entity, JavaScriptScene) {
        let root = Entity()
        let scene = try JavaScriptScene(
            rootEntity: root,
            source: """
                const stage = new Spatial.Scene();
                Spatial.mount(stage);
                \(body)
                """,
            assetRoot: Self.assetRoot
        )
        return (root, scene)
    }

    /// Creates one mesh with an id the command tests can address.
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

    private func entity(_ scene: JavaScriptScene, _ id: Int) throws -> Entity {
        try #require(scene.commandApplier.records[id]?.entity)
    }

    // MARK: - 14.1 Audio

    @Test
    func aSpatialSoundGetsASpatialAudioComponentAndLoadsItsFile() throws {
        let (_, scene) = try makeSceneWithMesh()
        scene.applyCommands(javaScript: """
            [["audio", 1, {
              "url": "asset://spatial-tone.wav", "spatial": true, "ambient": false,
              "loop": false, "volume": 0.5, "rate": 1, "group": "sfx",
              "refDistance": 1, "rolloff": 2, "distanceModel": "inverse",
              "cone": [30, 90, 0.2], "reverbLevel": -6
            }]]
            """)
        let target = try entity(scene, 1)
        let component = try #require(target.components[SpatialAudioComponent.self])
        // 0.5 is -6.02 dB.
        #expect(abs(component.gain - (-6.0206)) < 0.01)
        #expect(component.reverbLevel == -6)
        // SPEC 14.1 sends the cone in degrees: a 30 degree inner angle is a real
        // beam, where reading it as radians collapsed every realistic cone to no
        // directivity at all.
        if case let .beam(focus) = component.directivity {
            #expect(focus > 0.8, "a 30 degree cone must focus")
        } else {
            Issue.record("no beam directivity")
        }
        let state = try #require(scene.commandApplier.records[1]?.extras?.audio)
        #expect(state.resource != nil, "the bundled tone must load from the asset root")
        #expect(state.duration > 0.9 && state.duration < 1.1)
        #expect(target.components[ChannelAudioComponent.self] == nil)
        scene.dispose()
    }

    @Test
    func aNonSpatialSoundGetsAChannelComponentAndAnAmbientOneGetsAmbient() throws {
        let (_, scene) = try makeSceneWithMesh()
        scene.applyCommands(javaScript: """
            [["audio", 1, { "url": "asset://spatial-tone.wav", "spatial": false, "ambient": false, "volume": 1 }]]
            """)
        #expect(try entity(scene, 1).components[ChannelAudioComponent.self] != nil)

        scene.applyCommands(javaScript: """
            [["audio", 1, { "ambient": true }]]
            """)
        #expect(try entity(scene, 1).components[AmbientAudioComponent.self] != nil)
        #expect(try entity(scene, 1).components[ChannelAudioComponent.self] == nil)
        scene.dispose()
    }

    @Test
    func playAdvancesCurrentTimeAndEndsExactlyOnce() throws {
        let (_, scene) = try makeSceneWithMesh()
        nonisolated(unsafe) var events: [String] = []
        scene.commandApplier.dispatch = { type, _, _ in events.append(type) }
        scene.applyCommands(javaScript: """
            [
              ["audio", 1, { "url": "asset://spatial-tone.wav", "spatial": false, "loop": false, "volume": 1 }],
              ["audioControl", 1, "play", null]
            ]
            """)
        let state = try #require(scene.commandApplier.records[1]?.extras?.audio)
        #expect(state.isPlaying)

        scene.commandApplier.advanceAudioPlayback(deltaTime: 0.25)
        #expect(abs(state.currentTime - 0.25) < 1e-6)
        let records = scene.commandApplier.audioSyncRecords()
        #expect(records.count == 4)
        #expect(records[0] == 1)
        #expect(records[1] == 1)
        #expect(records[2] > 0)

        // Past the end: one `ended`, and no second one on the next frame.
        scene.commandApplier.advanceAudioPlayback(deltaTime: 2)
        scene.commandApplier.advanceAudioPlayback(deltaTime: 2)
        #expect(!state.isPlaying)
        #expect(events.filter { $0 == "ended" }.count == 1)
        scene.dispose()
    }

    @Test
    func aLoopingSoundWrapsRatherThanEnding() throws {
        let (_, scene) = try makeSceneWithMesh()
        nonisolated(unsafe) var events: [String] = []
        scene.commandApplier.dispatch = { type, _, _ in events.append(type) }
        scene.applyCommands(javaScript: """
            [
              ["audio", 1, { "url": "asset://spatial-tone.wav", "loop": true, "volume": 1 }],
              ["audioControl", 1, "play", null]
            ]
            """)
        scene.commandApplier.advanceAudioPlayback(deltaTime: 1.25)
        let state = try #require(scene.commandApplier.records[1]?.extras?.audio)
        #expect(state.isPlaying)
        #expect(state.currentTime < state.duration)
        #expect(!events.contains("ended"))
        scene.dispose()
    }

    @Test
    func seekAndStopMoveThePositionTheCoreSees() throws {
        let (_, scene) = try makeSceneWithMesh()
        scene.applyCommands(javaScript: """
            [["audio", 1, { "url": "asset://spatial-tone.wav", "volume": 1 }],
             ["audioControl", 1, "seek", 0.4]]
            """)
        let state = try #require(scene.commandApplier.records[1]?.extras?.audio)
        #expect(abs(state.currentTime - 0.4) < 1e-6)

        scene.applyCommands(javaScript: """
            [["audioControl", 1, "stop", null]]
            """)
        #expect(state.currentTime == 0)
        #expect(!state.isPlaying)
        scene.dispose()
    }

    @Test
    func theMixerRegistersEveryGroupOnTheRoot() throws {
        let (root, scene) = try makeScene()
        scene.applyCommands(javaScript: """
            [["audioMixer", 0, { "masterVolume": 0.5, "groups": { "music": 1, "sfx": 0.25 } }]]
            """)
        let component = try #require(root.components[AudioMixGroupsComponent.self])
        #expect(component.mixGroup(named: "master") != nil)
        // sfx at 0.25 under a 0.5 master is 0.125, which is -18.06 dB.
        let sfx = try #require(component.mixGroup(named: "sfx"))
        #expect(abs(sfx.gain - (-18.0618)) < 0.01)
        let music = try #require(component.mixGroup(named: "music"))
        #expect(abs(music.gain - (-6.0206)) < 0.01)
        scene.dispose()
    }

    @Test
    func aNullAudioPayloadReleasesTheSound() throws {
        let (_, scene) = try makeSceneWithMesh()
        scene.applyCommands(javaScript: """
            [["audio", 1, { "url": "asset://spatial-tone.wav", "spatial": true }]]
            """)
        #expect(try entity(scene, 1).components[SpatialAudioComponent.self] != nil)
        scene.applyCommands(javaScript: """
            [["audio", 1, null]]
            """)
        #expect(try entity(scene, 1).components[SpatialAudioComponent.self] == nil)
        #expect(scene.commandApplier.records[1]?.extras?.audio == nil)
        scene.dispose()
    }

    @Test
    func anUnresolvableAudioURLReportsAnErrorRatherThanFailingQuietly() throws {
        let (_, scene) = try makeSceneWithMesh()
        nonisolated(unsafe) var events: [(String, Int, [String: Any]?)] = []
        scene.commandApplier.dispatch = { type, id, payload in events.append((type, id, payload)) }
        scene.applyCommands(javaScript: """
            [["audio", 1, { "url": "asset://not-a-real-sound.wav" }]]
            """)
        // SPEC 3.5: the failure reaches the script through the `error` event,
        // and the core writes the one console line. This consumer writes none.
        let message = events.first { $0.0 == "error" }?.2?["message"] as? String ?? ""
        #expect(message.contains("not-a-real-sound"), "\(events.map(\.0))")
        #expect(scene.commandApplier.records[1]?.extras?.audio?.loadFailed == true)
        scene.dispose()
    }

    // MARK: - 14.2 Video

    @Test
    func aVideoScreenGetsAPlayerComponentAndAPlaneOfTheGivenSize() throws {
        let (_, scene) = try makeSceneWithMesh()
        scene.applyCommands(javaScript: """
            [["video", 1, { "url": "asset://spatial-bars.mp4", "width": 1.6, "height": 0.9,
                            "loop": false, "muted": true, "autoplay": false, "docking": false,
                            "volume": 1, "rate": 1 }]]
            """)
        let target = try entity(scene, 1)
        // The player lives on a child surface: RealityKit draws the video at a
        // size of its own choosing and that child carries the scale.
        let surface = try #require(scene.commandApplier.records[1]?.extras?.video?.surface)
        #expect(surface.components[VideoPlayerComponent.self] != nil)
        #expect(surface.parent === target)
        let state = try #require(scene.commandApplier.records[1]?.extras?.video)
        #expect(state.player != nil)
        #expect(state.player?.isMuted == true)
        // The plane the consumer built is what carries the size;
        // `VideoPlayerComponent` draws its own surface over it, so the entity's
        // visual bounds are RealityKit's, not ours.
        let plane = try #require(scene.commandApplier.records[1]?.mesh)
        #expect(abs(plane.bounds.extents.x - 1.6) < 0.01)
        #expect(abs(plane.bounds.extents.y - 0.9) < 0.01)
        scene.dispose()
    }

    @Test
    func aVideoWithOnlyAWidthTakesItsHeightFromTheClip() throws {
        let (_, scene) = try makeSceneWithMesh()
        let record = try #require(scene.commandApplier.records[1])
        let state = ScriptingVideoState()
        state.width = 1.6
        state.presentationSize = CGSize(width: 640, height: 360)
        record.makeExtras().video = state
        scene.commandApplier.refreshVideoPlane(record: record, state: state)
        let plane = try #require(record.mesh)
        #expect(abs(plane.bounds.extents.x - 1.6) < 0.01)
        #expect(abs(plane.bounds.extents.y - 0.9) < 0.01, "16:9 keeps the clip's own aspect")
        scene.dispose()
    }

    @Test
    func videoControlDrivesThePlayerAndSyncReportsIt() async throws {
        let (_, scene) = try makeSceneWithMesh()
        scene.applyCommands(javaScript: """
            [["video", 1, { "url": "asset://spatial-bars.mp4", "width": 1, "muted": true }]]
            """)
        // The duration arrives asynchronously from AVFoundation.
        for _ in 0..<100 where scene.commandApplier.records[1]?.extras?.video?.duration == 0 {
            try? await Task.sleep(for: .milliseconds(20))
        }
        let state = try #require(scene.commandApplier.records[1]?.extras?.video)
        #expect(state.duration > 1.5 && state.duration < 2.5)

        scene.applyCommands(javaScript: """
            [["videoControl", 1, "seek", 1.0]]
            """)
        #expect(abs(state.currentTime - 1.0) < 0.01)

        let records = scene.commandApplier.videoSyncRecords()
        #expect(records.count == 4)
        #expect(records[0] == 1)
        #expect(records[3] > 1.5)
        scene.dispose()
    }

    @Test
    func dockingIsKeptAndTheVideoStillPlaysOnItsPlane() throws {
        let (_, scene) = try makeSceneWithMesh()
        scene.applyCommands(javaScript: """
            [["video", 1, { "url": "asset://spatial-bars.mp4", "width": 1, "docking": true }]]
            """)
        // AR-36: that docking is visionOS only is the core's line
        // (`core/src/media/video.js:117`); this consumer neither repeats it nor
        // fails, and the state stays in the dump.
        #expect(!scene.commandApplier.warnings.warnings.contains { $0.contains("docking") })
        #expect(scene.commandApplier.records[1]?.extras?.video?.docking == true)
        // The video still plays on its plane either way.
        #expect(scene.commandApplier.records[1]?.extras?.video?.surface != nil)
        scene.dispose()
    }

    @Test
    func videoControlBeforeTheScreenIsConfiguredIsStillHonoured() throws {
        let (_, scene) = try makeSceneWithMesh()
        // The control can lead the payload in a batch; the intent has to
        // survive until the player exists.
        scene.applyCommands(javaScript: """
            [["videoControl", 1, "play", null],
             ["video", 1, { "url": "asset://spatial-bars.mp4", "width": 1, "muted": true }]]
            """)
        let state = try #require(scene.commandApplier.records[1]?.extras?.video)
        #expect(state.wantsPlay)
        #expect(state.isPlaying)
        #expect(state.player != nil)
        scene.dispose()
    }

    @Test
    func aVideoURLSetPicksMP4AndAWebmOnlySetErrors() async throws {
        let (_, scene) = try makeSceneWithMesh()
        scene.applyCommands(javaScript: """
            [["video", 1, { "url": { "webm": "asset://spatial-bars.webm", "mp4": "asset://spatial-bars.mp4" },
                            "width": 1, "muted": true }]]
            """)
        var state = try #require(scene.commandApplier.records[1]?.extras?.video)
        #expect(state.url == "asset://spatial-bars.mp4")
        #expect(state.player != nil)

        nonisolated(unsafe) var errors: [(String, Int, [String: Any]?)] = []
        scene.commandApplier.dispatch = { type, id, payload in errors.append((type, id, payload)) }
        scene.applyCommands(javaScript: """
            [["create", 2, "mesh", "webmOnly"],
             ["video", 2, { "url": { "webm": "asset://spatial-bars.webm" }, "width": 1 }]]
            """)
        #expect(
            scene.commandApplier.warnings.warnings.contains { $0.contains("no encoding this backend can play") }
        )
        for _ in 0..<100 where !errors.contains(where: { $0.0 == "error" && $0.1 == 2 }) {
            try? await Task.sleep(for: .milliseconds(10))
        }
        let reported = try #require(errors.first { $0.0 == "error" && $0.1 == 2 })
        #expect((reported.2?["message"] as? String)?.contains("webm") == true)
        state = try #require(scene.commandApplier.records[2]?.extras?.video)
        #expect(state.player == nil)
        scene.dispose()
    }

    @Test
    func theControllerRumbleOpcodeReachesTheHub() throws {
        let (_, scene) = try makeScene()
        // No controller is attached, so the call is refused rather than
        // crashing, and the opcode is not reported unknown.
        scene.applyCommands(javaScript: """
            [["controllerRumble", 0, "pad-1", 0.5, 0.2]]
            """)
        #expect(!scene.commandApplier.warnings.warnings.contains { $0.contains("controllerRumble") })
        #expect(scene.rumble(controller: "pad-1", intensity: 0.5, duration: 0.2) == false)
        scene.dispose()
    }

    // MARK: - 14.3 Cameras

    @Test
    func aPerspectiveCameraCommandBuildsACameraEntity() throws {
        let (_, scene) = try makeScene()
        scene.applyCommands(javaScript: """
            [["camera", 0, { "kind": "perspective", "fov": 45, "near": 0.05, "far": 500,
                             "transform": [0, 1, 3, 0, 0, 0, 1, 1, 1, 1] }]]
            """)
#if os(visionOS)
        #expect(scene.commandApplier.warnings.warnings.contains { $0.contains("wearer is the camera") })
#else
        let camera = try #require(scene.commandApplier.cameraEntity)
        let component = try #require(camera.components[PerspectiveCameraComponent.self])
        #expect(component.fieldOfViewInDegrees == 45)
        #expect(component.near == 0.05)
        let transform = try #require(scene.commandApplier.cameraTransform())
        #expect(transform.translation == SIMD3<Float>(0, 1, 3))
        #expect(scene.scriptedCamera?.kind == "perspective")
#endif
        scene.dispose()
    }

    /// SPEC 14.3: the visible height is `top - bottom`, the width follows the
    /// viewport, and `left`/`right` are honored when they match that width.
    @Test
    func anOrthographicCameraTakesItsHeightAndAcceptsMatchingExtents() throws {
        let previous = ScriptingRuntime.viewportAspect
        ScriptingRuntime.viewportAspect = 2
        let (_, scene) = try makeScene()
        scene.applyCommands(javaScript: """
            [["camera", 0, { "kind": "orthographic", "left": -2, "right": 2, "top": 1, "bottom": -1,
                             "near": 0.1, "far": 100, "transform": [0, 0, 2, 0, 0, 0, 1, 1, 1, 1] }]]
            """)
#if !os(visionOS)
        let camera = try #require(scene.commandApplier.cameraEntity)
        let component = try #require(camera.components[OrthographicCameraComponent.self])
        #expect(component.scale == 2, "the scale is top minus bottom")
        #expect(component.scaleDirection == .vertical)
        // 2 tall at aspect 2 is 4 wide, which is exactly what was asked for.
        #expect(!scene.commandApplier.warnings.warnings.contains { $0.contains("orthographic") })
#endif
        scene.dispose()
        ScriptingRuntime.viewportAspect = previous
    }

    @Test
    func anOrthographicCameraWarnsOnceWhenLeftAndRightDisagreeWithTheViewport() throws {
        let previous = ScriptingRuntime.viewportAspect
        ScriptingRuntime.viewportAspect = 2
        let (_, scene) = try makeScene()
        scene.applyCommands(javaScript: """
            [["camera", 0, { "kind": "orthographic", "left": -1, "right": 1, "top": 1, "bottom": -1,
                             "near": 0.1, "far": 100, "transform": [0, 0, 2, 0, 0, 0, 1, 1, 1, 1] }],
             ["camera", 0, { "kind": "orthographic", "left": -1, "right": 1, "top": 1, "bottom": -1,
                             "near": 0.1, "far": 100, "transform": [0, 0, 3, 0, 0, 0, 1, 1, 1, 1] }]]
            """)
#if !os(visionOS)
        let component = try #require(
            scene.commandApplier.cameraEntity?.components[OrthographicCameraComponent.self]
        )
        // The height still rules: 2 units tall, 4 wide on this viewport, not
        // the 2 the script asked for. Nothing is stretched to fit.
        #expect(component.scale == 2)
        // SPEC 14.3 fixes the wording, to three decimals, on both backends.
        let matching = scene.commandApplier.warnings.warnings.filter {
            $0.contains("OrthographicCamera asks for a visible width")
        }
        #expect(matching.count == 1, "the mismatch warns exactly once")
        #expect(
            matching.first == "OrthographicCamera asks for a visible width of 2.000 but the "
                + "viewport shows 4.000 at that height; the height is kept and the width "
                + "follows the viewport",
            "\(matching)"
        )
        // The dump keeps what the script asked for either way.
        let spec = try #require(scene.commandApplier.cameraSpec)
        #expect(spec["left"] as? Double == -1)
        #expect(spec["right"] as? Double == 1)
#endif
        scene.dispose()
        ScriptingRuntime.viewportAspect = previous
    }

    @Test
    func aNullCameraGivesTheViewItsOwnCameraBack() throws {
        let (_, scene) = try makeScene()
        let fallback = Entity()
        ScriptingRuntime.defaultCameraEntity = fallback
        scene.applyCommands(javaScript: """
            [["camera", 0, { "kind": "perspective", "fov": 60, "transform": [0, 0, 1, 0, 0, 0, 1, 1, 1, 1] }]]
            """)
#if !os(visionOS)
        #expect(!fallback.isEnabled)
#endif
        scene.applyCommands(javaScript: """
            [["camera", 0, null]]
            """)
        #expect(fallback.isEnabled)
        #expect(scene.commandApplier.cameraEntity == nil)
        ScriptingRuntime.defaultCameraEntity = nil
        scene.dispose()
    }

    // MARK: - 14.4 Character controller and force effects

    @Test
    func aCharacterControllerReplacesTheBodyAndMovesOncePerFrame() throws {
        let (_, scene) = try makeSceneWithMesh()
        scene.applyCommands(javaScript: """
            [
              ["rigidBody", 1, { "type": "dynamic", "shape": "auto" }],
              ["characterController", 1, { "radius": 0.3, "height": 1.6, "slopeLimit": 0.7,
                                           "stepLimit": 0.2, "gravity": false }]
            ]
            """)
        let target = try entity(scene, 1)
        let component = try #require(target.components[CharacterControllerComponent.self])
        #expect(component.radius == 0.3)
        #expect(component.height == 1.6)
        #expect(target.components[PhysicsBodyComponent.self] == nil, "a character is not also a body")

        scene.applyCommands(javaScript: """
            [["characterMove", 1, 0.5, 0, 0]]
            """)
        let state = try #require(scene.commandApplier.records[1]?.extras?.character)
        #expect(state.hasPendingMove)
        scene.commandApplier.stepCharacters(deltaTime: 1.0 / 60)
        #expect(!state.hasPendingMove, "the queued move is consumed by the frame")
        // `moveCharacter` only displaces an entity that belongs to a running
        // RealityKit scene, which a headless host does not have; the app run
        // covers the displacement itself.
        #expect(scene.commandApplier.characterSyncRecords().count == 8)
        scene.dispose()
    }

    @Test
    func teleportPlacesTheCharacterAndClearsTheQueue() throws {
        let (_, scene) = try makeSceneWithMesh()
        scene.applyCommands(javaScript: """
            [["characterController", 1, { "radius": 0.2, "height": 1, "gravity": false }],
             ["characterMove", 1, 5, 0, 0],
             ["characterTeleport", 1, 0, 2, 0]]
            """)
        let state = try #require(scene.commandApplier.records[1]?.extras?.character)
        #expect(!state.hasPendingMove)
        let position = try entity(scene, 1).position(relativeTo: nil)
        #expect(abs(position.y - 2) < 0.01)
        scene.dispose()
    }

    @Test
    func characterSyncCarriesPositionGroundAndVelocity() throws {
        let (_, scene) = try makeSceneWithMesh()
        scene.applyCommands(javaScript: """
            [["characterController", 1, { "radius": 0.2, "height": 1, "gravity": false }]]
            """)
        scene.commandApplier.stepCharacters(deltaTime: 1.0 / 60)
        let records = scene.commandApplier.characterSyncRecords()
        #expect(records.count == 8)
        #expect(records[0] == 1)
        scene.dispose()
    }

    @Test
    func everyForceFieldKindBecomesAForceEffectComponent() throws {
        let (_, scene) = try makeScene()
        let kinds: [(String, String)] = [
            ("constant", """
                { "kind": "constant", "force": [0, -5, 0], "radius": 2 }
                """),
            ("radial", """
                { "kind": "radial", "strength": 4, "minimumDistance": 0.1, "falloff": "linear", "radius": 3 }
                """),
            ("vortex", """
                { "kind": "vortex", "strength": 2, "axis": [0, 1, 0], "radius": 2 }
                """),
            ("drag", """
                { "kind": "drag", "coefficient": 0.5, "radius": 2 }
                """),
            ("turbulence", """
                { "kind": "turbulence", "strength": 1, "noiseScale": 2, "radius": 2 }
                """),
        ]
        for (index, entry) in kinds.enumerated() {
            let id = 10 + index
            scene.applyCommands(javaScript: """
                [["create", \(id), "group", "\(entry.0)"], ["forceField", \(id), \(entry.1)]]
                """)
            let target = try entity(scene, id)
            #expect(
                target.components[ForceEffectComponent.self] != nil,
                "\(entry.0) must reach RealityKit"
            )
            #expect(scene.commandApplier.records[id]?.extras?.forceField?.applied == true)
        }
        scene.dispose()
    }

    @Test
    func disablingAForceFieldRemovesTheComponentAndKeepsTheState() throws {
        let (_, scene) = try makeScene()
        scene.applyCommands(javaScript: """
            [["create", 5, "group", "wind"],
             ["forceField", 5, { "kind": "vortex", "strength": 1, "radius": 1, "enabled": true }]]
            """)
        #expect(try entity(scene, 5).components[ForceEffectComponent.self] != nil)
        scene.applyCommands(javaScript: """
            [["forceField", 5, { "enabled": false }]]
            """)
        #expect(try entity(scene, 5).components[ForceEffectComponent.self] == nil)
        #expect(scene.commandApplier.records[5]?.extras?.forceField?.kind == "vortex")
        scene.dispose()
    }

    @Test
    func anUnknownForceFieldKindWarns() throws {
        let (_, scene) = try makeScene()
        scene.applyCommands(javaScript: """
            [["create", 6, "group", "odd"], ["forceField", 6, { "kind": "magnetism" }]]
            """)
        #expect(scene.commandApplier.warnings.warnings.contains { $0.contains("magnetism") })
        scene.dispose()
    }

    // MARK: - 14.5 Skeletons and blend shapes

    @Test
    func skeletonEditsAreHeldUntilAnAssetSuppliesAPose() throws {
        let (_, scene) = try makeScene()
        scene.applyCommands(javaScript: """
            [["create", 2, "asset", "rig"],
             ["skeleton", 2, { "joints": { "spine": [0, 1, 0, 0, 0, 0, 1] }, "track": true }]]
            """)
        let state = try #require(scene.commandApplier.records[2]?.extras?.skeleton)
        #expect(state.track)
        #expect(state.pendingJoints["spine"] != nil)
        // Nothing has loaded, so nothing was written and nothing crashed.
        #expect(state.poseEntity == nil)
        #expect(scene.commandApplier.trackedSkeletons().isEmpty)
        scene.dispose()
    }

    @Test
    func blendShapeWeightsAreClampedAndRemembered() throws {
        let (_, scene) = try makeScene()
        scene.applyCommands(javaScript: """
            [["create", 3, "asset", "face"], ["blendShapes", 3, { "smile": 1.7, "blink": -0.2 }]]
            """)
        let state = try #require(scene.commandApplier.records[3]?.extras?.skeleton)
        #expect(state.pendingWeights["smile"] == 1)
        #expect(state.pendingWeights["blink"] == 0)
        scene.dispose()
    }

    /// The bundled `rig.usdz` is the RealityKit twin of `rig.glb`: RealityKit
    /// loads it, and the joints and blend shape a script addresses are the
    /// ones SPEC 14.5 promises.
    @Test
    func theBundledRigLoadsWithItsJointsAndBlendShape() async throws {
        let (_, scene) = try makeScene()
        nonisolated(unsafe) var loaded: [(String, Int, [String: Any]?)] = []
        scene.commandApplier.dispatch = { type, id, payload in loaded.append((type, id, payload)) }
        scene.applyCommands(javaScript: """
            [["create", 1, "asset", "figure"],
             ["asset", 1, { "usdz": "asset://rig.usdz" }]]
            """)
        for _ in 0..<400 where !loaded.contains(where: { $0.0 == "assetLoaded" }) {
            try? await Task.sleep(for: .milliseconds(10))
        }
        let event = try #require(
            loaded.first { $0.0 == "assetLoaded" },
            "rig.usdz must load; errors: \(loaded.filter { $0.0 == "assetError" }.map { $0.2 ?? [:] })"
        )
        let joints = try #require(event.2?["joints"] as? [String])
        // A script says `head`, not `root/head`.
        #expect(joints == ["root", "head"])
        #expect(event.2?["blendShapes"] as? [String] == ["widen"])

        let state = try #require(scene.commandApplier.records[1]?.extras?.skeleton)
        #expect(state.jointPaths == ["root", "root/head"])
        #expect(state.poseEntity != nil)
        #expect(state.blendShapeEntity != nil)
        scene.dispose()
    }

    @Test
    func settingAJointRotationOnTheBundledRigMovesTheHead() async throws {
        let (_, scene) = try makeScene()
        nonisolated(unsafe) var loaded = false
        scene.commandApplier.dispatch = { type, _, _ in if type == "assetLoaded" { loaded = true } }
        scene.applyCommands(javaScript: """
            [["create", 1, "asset", "figure"],
             ["asset", 1, { "usdz": "asset://rig.usdz" }]]
            """)
        for _ in 0..<400 where !loaded { try? await Task.sleep(for: .milliseconds(10)) }
        #expect(loaded)

        let state = try #require(scene.commandApplier.records[1]?.extras?.skeleton)
        let entity = try #require(state.poseEntity)
        let before = try #require(
            entity.components[SkeletalPosesComponent.self]?.poses.default?["root/head"]
        )
        #expect(abs(before.rotation.real - 1) < 1e-4, "the rig rests unrotated")

        // A quarter turn about Y, addressed by the leaf name.
        scene.applyCommands(javaScript: """
            [["skeleton", 1, { "joints": { "head": [0, 0.2, 0, 0, 0.7071068, 0, 0.7071068] } }]]
            """)
        let after = try #require(
            entity.components[SkeletalPosesComponent.self]?.poses.default?["root/head"]
        )
        #expect(abs(after.rotation.imag.y - 0.7071068) < 1e-4)
        #expect(after.translation == SIMD3<Float>(0, 0.2, 0))
        #expect(!scene.commandApplier.warnings.warnings.contains { $0.contains("not in this skeleton") })
        scene.dispose()
    }

    @Test
    func settingTheWidenBlendShapeOnTheBundledRigChangesTheMesh() async throws {
        let (_, scene) = try makeScene()
        nonisolated(unsafe) var loaded = false
        scene.commandApplier.dispatch = { type, _, _ in if type == "assetLoaded" { loaded = true } }
        scene.applyCommands(javaScript: """
            [["create", 1, "asset", "figure"],
             ["asset", 1, { "usdz": "asset://rig.usdz" }]]
            """)
        for _ in 0..<400 where !loaded { try? await Task.sleep(for: .milliseconds(10)) }
        #expect(loaded)

        let state = try #require(scene.commandApplier.records[1]?.extras?.skeleton)
        let entity = try #require(state.blendShapeEntity)
        let before = try #require(
            entity.components[BlendShapeWeightsComponent.self]?.weightSet.default
        )
        #expect(before.weightNames == ["widen"])
        #expect(before.weights.first == 0)

        scene.applyCommands(javaScript: """
            [["blendShapes", 1, { "widen": 1 }]]
            """)
        let after = try #require(
            entity.components[BlendShapeWeightsComponent.self]?.weightSet.default
        )
        #expect(after.weights.first == 1, "the widen weight reaches RealityKit")
        #expect(!scene.commandApplier.warnings.warnings.contains { $0.contains("blend shape") })
        scene.dispose()
    }

    @Test
    func anAssetWithoutARigReportsEmptyJointsAndBlendShapes() throws {
        let (_, scene) = try makeScene()
        scene.applyCommands(javaScript: """
            [["create", 4, "asset", "plain"]]
            """)
        let record = try #require(scene.commandApplier.records[4])
        record.assetContainer = Entity()
        let rig = scene.commandApplier.indexSkeleton(for: record)
        #expect(rig.joints.isEmpty)
        #expect(rig.blendShapes.isEmpty)
        scene.dispose()
    }

    // MARK: - 14.6 Shader graph materials

    @Test
    func aShaderGraphMaterialDrawsItsFallbackUntilItLoads() throws {
        let (_, scene) = try makeSceneWithMesh()
        scene.applyCommands(javaScript: """
            [["material", 1, { "type": "ShaderGraphMaterial", "source": "asset://spatial-materials.usda",
                               "name": "Glow", "parameters": { "glowAmount": 0.5 },
                               "fallback": { "type": "MeshStandardMaterial", "color": [1, 0, 0] } }]]
            """)
        let state = try #require(scene.commandApplier.records[1]?.extras?.shaderGraph)
        #expect(state.source == "asset://spatial-materials.usda")
        #expect(state.name == "Glow")
        #expect(state.parameters["glowAmount"] as? Double == 0.5)
        // The fallback is what draws right now, and it is a real material.
        #expect(scene.commandApplier.records[1]?.nativeMaterial != nil)
        scene.dispose()
    }

    @Test
    func aMissingShaderGraphSourceFailsLoudlyAndKeepsTheFallback() throws {
        let (_, scene) = try makeSceneWithMesh()
        scene.applyCommands(javaScript: """
            [["material", 1, { "type": "ShaderGraphMaterial", "source": "asset://no-such-materials.usda",
                               "name": "Glow", "fallback": { "type": "MeshStandardMaterial", "color": [0, 1, 0] } }]]
            """)
        let state = try #require(scene.commandApplier.records[1]?.extras?.shaderGraph)
        #expect(state.loaded == false)
        #expect(state.loadError != nil)
        #expect(scene.commandApplier.warnings.warnings.contains { $0.contains("no-such-materials") })
        #expect(scene.commandApplier.records[1]?.nativeMaterial != nil, "the fallback still draws")
        scene.dispose()
    }

    /// The bundled `spatial-materials.usda` really is a shader graph
    /// RealityKit will load, and its parameters are the ones a script sets.
    @Test
    func theBundledShaderGraphLoadsAndExposesItsParameters() async throws {
        let (_, scene) = try makeSceneWithMesh()
        scene.applyCommands(javaScript: """
            [["material", 1, { "type": "ShaderGraphMaterial", "source": "asset://spatial-materials.usda",
                               "name": "Glow", "parameters": { "glowAmount": 1.5 },
                               "fallback": { "type": "MeshStandardMaterial" } }]]
            """)
        let state = try #require(scene.commandApplier.records[1]?.extras?.shaderGraph)
        for _ in 0..<200 where !state.loaded && state.loadError == nil {
            try? await Task.sleep(for: .milliseconds(10))
        }
        #expect(state.loadError == nil, "\(state.loadError ?? "")")
        #expect(state.loaded)
        let material = try #require(scene.commandApplier.records[1]?.nativeMaterial as? ShaderGraphMaterial)
        #expect(Set(material.parameterNames) == ["glowAmount", "glowColor"])
        // The parameter the material command carried reached the graph.
        if case let .float(value)? = material.getParameter(name: "glowAmount") {
            #expect(abs(value - 1.5) < 1e-5)
        } else {
            Issue.record("glowAmount did not reach the loaded graph")
        }
        scene.dispose()
    }

    @Test
    func aShaderParameterBeforeTheGraphLoadsIsRemembered() throws {
        let (_, scene) = try makeSceneWithMesh()
        scene.applyCommands(javaScript: """
            [["material", 1, { "type": "ShaderGraphMaterial", "source": "asset://spatial-materials.usda",
                               "name": "Glow", "fallback": { "type": "MeshStandardMaterial" } }],
             ["shaderParameter", 1, "glowColor", [1, 0.5, 0]]]
            """)
        let state = try #require(scene.commandApplier.records[1]?.extras?.shaderGraph)
        let colour = try #require(state.parameters["glowColor"] as? [Any])
        #expect(colour.count == 3)
        scene.dispose()
    }

    // MARK: - 14.7 Scene understanding

    @Test
    func sceneUnderstandingIsKeptAndWarnsAboutRaycastsOnMacOS() throws {
        let (root, scene) = try makeScene()
        scene.applyCommands(javaScript: """
            [["sceneUnderstanding", 0, { "collision": true, "occlusion": false, "physics": true, "shadows": false }]]
            """)
        #expect(scene.commandApplier.sceneUnderstandingSpec["collision"] as? Bool == true)
#if os(visionOS)
        #expect(root.components[SceneUnderstandingComponent.self] != nil)
#else
        _ = root
        let warnings = scene.commandApplier.warnings.warnings
        // AR-36: that scene understanding is visionOS only is the core's line,
        // so the only thing this consumer says is the half only it knows.
        #expect(
            warnings.contains(
                "Raycasts will not see the real world here: RealityKit has no scene "
                    + "reconstruction mesh on macOS, so no hit carries sceneUnderstanding."
            ),
            "\(warnings)"
        )
#endif
        scene.dispose()
    }

    // MARK: - 14.8 and 14.9 Input

    @Test
    func injectedControllerStateReachesSetInput() throws {
        let (_, scene) = try makeScene()
        ScriptingInputRouter.shared.providesGamepad = true
        // The router caches one snapshot per frame for every scene.
        ScriptingInputRouter.shared.beginFrame()
        scene.injectControllers([
            [
                "id": "test-1",
                "name": "Test Controller",
                "leftThumbstick": [0.5, -0.25],
                "rightThumbstick": [0, 0],
                "a": ["down": true, "pressed": true, "released": false, "value": 1.0, "pressCount": 1],
            ],
        ])
        let state = ScriptingInputRouter.shared.inputState(for: scene.sceneID)
        // SPEC 14.8's shape: one flat object per controller, which is what the
        // core diffs to raise `controllerconnected` and the button edges.
        let controllers = try #require(state["controllers"] as? [[String: Any]])
        #expect(controllers.count == 1)
        #expect(controllers.first?["id"] as? String == "test-1")
        #expect(controllers.first?["name"] as? String == "Test Controller")
        let a = try #require(controllers.first?["a"] as? [String: Any])
        #expect(a["pressed"] as? Bool == true)
        scene.injectControllers(nil)
        scene.dispose()
    }

    @Test
    func omittingGamepadFromSetupDropsTheProviderAndTheCapability() throws {
        ScriptingRuntime.setup(inputOptions: [.mouse, .keyboard, .tap, .drag])
        let environment = JavaScriptScene.environmentDescription(assetRoot: nil)
        let capabilities = try #require(environment["capabilities"] as? [String: Bool])
        #expect(capabilities["controllers"] == false)

        let (_, scene) = try makeScene()
        ScriptingInputRouter.shared.beginFrame()
        let state = ScriptingInputRouter.shared.inputState(for: scene.sceneID)
        #expect((state["controllers"] as? [[String: Any]])?.isEmpty == true)
        scene.dispose()
        ScriptingRuntime.setup(inputOptions: .all)
    }

    @Test
    func mouseButtonsCarryEdgesAndClickCounts() throws {
        let router = ScriptingInputRouter.shared
        let (_, scene) = try makeScene()
        // The router is process wide and a click count spans frames, so the
        // test starts from a known pointer state.
        router.resetPointerButtons()
        router.beginFrame()
        router.setMouseButton(0, down: true)
        var state = router.inputState(for: scene.sceneID)
        var mouse = try #require(state["mouse"] as? [String: Any])
        var left = try #require(mouse["left"] as? [String: Any])
        #expect(left["down"] as? Bool == true)
        #expect(left["pressed"] as? Bool == true)
        #expect(left["pressCount"] as? Int == 1)

        router.beginFrame()
        router.setMouseButton(0, down: false)
        router.setMouseButton(0, down: true)
        state = router.inputState(for: scene.sceneID)
        mouse = try #require(state["mouse"] as? [String: Any])
        left = try #require(mouse["left"] as? [String: Any])
        #expect(left["pressCount"] as? Int == 2, "a second click inside 400 ms counts up")

        router.beginFrame()
        router.setMouseButton(0, down: false)
        state = router.inputState(for: scene.sceneID)
        mouse = try #require(state["mouse"] as? [String: Any])
        left = try #require(mouse["left"] as? [String: Any])
        #expect(left["released"] as? Bool == true)
        #expect(left["down"] as? Bool == false)
        scene.dispose()
    }

    @Test
    func scrollAndConnectedFlagsAreReported() throws {
        let router = ScriptingInputRouter.shared
        let (_, scene) = try makeScene()
        router.updatePointer(location: nil)
        router.beginFrame()
        router.addScroll(x: 3, y: -7)
        let state = router.inputState(for: scene.sceneID)
        let mouse = try #require(state["mouse"] as? [String: Any])
        let scroll = try #require(mouse["scroll"] as? [Double])
        #expect(scroll == [3, -7])
#if os(macOS)
        // `connected` is a device fact: a test process is not a regular
        // application, so no keyboard reaches it and none is reported.
        #expect((state["keyboard"] as? [String: Any])?["connected"] as? Bool == false)
        #expect(mouse["connected"] as? Bool == false, "no pointer has moved over this host")
        router.updatePointer(location: CGPoint(x: 5, y: 5))
        router.beginFrame()
        let pointed = router.inputState(for: scene.sceneID)
        #expect((pointed["mouse"] as? [String: Any])?["connected"] as? Bool == true)
        router.updatePointer(location: nil)
#endif
        router.beginFrame()
        let cleared = router.inputState(for: scene.sceneID)
        let clearedScroll = try #require((cleared["mouse"] as? [String: Any])?["scroll"] as? [Double])
        #expect(clearedScroll == [0, 0], "scroll is per frame")
        scene.dispose()
    }

    /// `scenePosition` used to cast a ray once per frame inside `setInput`,
    /// which materialised every deferred collider in the scene and cost 1500
    /// moving meshes two thirds of their frame rate.
    @Test
    func readingTheInputStateDoesNotCastARay() throws {
        let (_, scene) = try makeScene()
        scene.applyCommands(javaScript: """
            [
              ["create", 1, "mesh", "target"],
              ["geometry", 1, { "type": "BoxGeometry", "parameters": { "width": 1, "height": 1, "depth": 1 } },
                                null, null, null, null]
            ]
            """)
        let entity = try #require(scene.commandApplier.records[1]?.entity)
        let router = ScriptingInputRouter.shared
        router.updatePointer(location: nil)

        for _ in 0..<10 {
            router.beginFrame()
            _ = router.inputState(for: scene.sceneID)
        }
        #expect(
            entity.components[CollisionComponent.self] == nil
                || ScriptingCommandApplier.colliderStrategy != .lazy,
            "polling input must not build collision shapes"
        )
        scene.dispose()
    }

    // MARK: - 14.10 Lifecycle and host events

    @Test
    func anInactiveSceneDoesNotTick() throws {
        let (_, scene) = try makeScene()
        scene.tick(deltaTime: 1.0 / 60)
        let before = scene.appliedFrames
        scene.setActive(false)
        #expect(!scene.isActive)
        scene.tick(deltaTime: 1.0 / 60)
        scene.tick(deltaTime: 1.0 / 60)
        #expect(scene.appliedFrames == before, "timers must not advance while inactive")
        scene.setActive(true)
        scene.tick(deltaTime: 1.0 / 60)
        #expect(scene.appliedFrames == before + 1)
        scene.dispose()
    }

    @Test
    func aHostEventFromTheScriptReachesTheListener() throws {
        let (_, scene) = try makeScene()
        nonisolated(unsafe) var received: [(String, [String: Any])] = []
        scene.hostEventListener = { name, payload in received.append((name, payload)) }
        scene.applyCommands(javaScript: """
            [["hostEvent", 0, "saved", { "id": 7 }]]
            """)
        #expect(received.count == 1)
        #expect(received.first?.0 == "saved")
        #expect(received.first?.1["id"] as? Double == 7)
        scene.dispose()
    }

    @Test
    func aRegisteredHostFunctionAnswersAndAnUnknownOneRejects() throws {
        let (_, scene) = try makeScene()
        nonisolated(unsafe) var results: [(String, Int, [String: Any]?)] = []
        scene.dispatchObserver = { type, id, payload in results.append((type, id, payload)) }

        ScriptingRuntime.register(module: "TestApp", function: "double") { arguments in
            let value = (arguments["value"] as? Double) ?? 0
            return ["doubled": value * 2]
        }
        #expect(ScriptingRuntime.hostFunctionNames.contains("TestApp.double"))

        scene.applyCommands(javaScript: """
            [["hostCall", 11, "TestApp.double", { "value": 21 }]]
            """)
        let answered = try #require(results.first { $0.0 == "hostResult" && $0.1 == 11 })
        let value = try #require(answered.2?["value"] as? [String: Any])
        #expect(value["doubled"] as? Double == 42)

        scene.applyCommands(javaScript: """
            [["hostCall", 12, "TestApp.missing", {}]]
            """)
        let refused = try #require(results.first { $0.0 == "hostResult" && $0.1 == 12 })
        let message = try #require(refused.2?["error"] as? String)
        #expect(message.contains("host-function"))
        #expect(message.contains("TestApp.missing"))

        ScriptingRuntime.unregister(module: "TestApp", function: "double")
        scene.dispose()
    }

    @Test
    func fetchReadsALocalFileAndParsesJSON() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appending(path: "spatial-fetch-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try #"{"answer":42}"#.write(
            to: directory.appending(path: "data.json"),
            atomically: true,
            encoding: .utf8
        )

        let root = Entity()
        let scene = try JavaScriptScene(
            rootEntity: root,
            source: "const s = new Spatial.Scene(); Spatial.mount(s);",
            assetRoot: directory
        )
        nonisolated(unsafe) var results: [(String, Int, [String: Any]?)] = []
        scene.dispatchObserver = { type, id, payload in results.append((type, id, payload)) }

        scene.applyCommands(javaScript: """
            [["fetch", 3, { "url": "data.json", "kind": "json" }]]
            """)
        // A fetch always answers on a later turn, never inside the batch.
        for _ in 0..<100 where !results.contains(where: { $0.0 == "fetchResult" && $0.1 == 3 }) {
            try? await Task.sleep(for: .milliseconds(10))
        }
        let answered = try #require(results.first { $0.0 == "fetchResult" && $0.1 == 3 })
        // The core reads `json`, `text` or `error`; a `value` key would be
        // reported back to the script as "the response was not JSON".
        let value = try #require(answered.2?["json"] as? [String: Any])
        #expect(value["answer"] as? Double == 42)

        scene.applyCommands(javaScript: """
            [["fetch", 5, { "url": "data.json", "kind": "text" }]]
            """)
        for _ in 0..<100 where !results.contains(where: { $0.0 == "fetchResult" && $0.1 == 5 }) {
            try? await Task.sleep(for: .milliseconds(10))
        }
        let asText = try #require(results.first { $0.0 == "fetchResult" && $0.1 == 5 })
        #expect((asText.2?["text"] as? String)?.contains("answer") == true)

        scene.applyCommands(javaScript: """
            [["fetch", 4, { "url": "missing.json", "kind": "text" }]]
            """)
        for _ in 0..<100 where !results.contains(where: { $0.0 == "fetchResult" && $0.1 == 4 }) {
            try? await Task.sleep(for: .milliseconds(10))
        }
        let failed = try #require(results.first { $0.0 == "fetchResult" && $0.1 == 4 })
        #expect(failed.2?["error"] as? String != nil)

        scene.dispose()
        try? FileManager.default.removeItem(at: directory)
    }

    @Test
    func stateSurvivesAScriptSwapWhenItIsAskedFor() throws {
        let root = Entity()
        let first = try JavaScriptScene(
            rootEntity: root,
            source: """
                const s = new Spatial.Scene();
                this.state = { count: 3, label: 'kept' };
                Spatial.mount(s);
                """
        )
        first.tick(deltaTime: 1.0 / 60)
        let captured = try #require(first.captureState(), "this.state must reach the host")
        #expect(captured["count"] as? Double == 3)
        #expect(captured["label"] as? String == "kept")
        first.dispose()

        // The core takes it as a load option and calls `scriptChanged` before
        // the new script's first frame.
        let next = Entity()
        let second = try JavaScriptScene(
            rootEntity: next,
            source: """
                const s = new Spatial.Scene();
                this.scriptChanged = (previous) => { s.userData.carried = previous; };
                Spatial.mount(s);
                """,
            previousState: captured
        )
        second.tick(deltaTime: 1.0 / 60)
        let scene = try #require(second.dump()["scene"] as? [String: Any])
        let userData = try #require(scene["userData"] as? [String: Any])
        let carried = try #require(userData["carried"] as? [String: Any])
        #expect(carried["count"] as? Double == 3)
        #expect(carried["label"] as? String == "kept")
        second.dispose()
    }

    /// Without `preserveState` the hook is not called at all.
    @Test
    func stateIsNotCarriedUnlessItIsAskedFor() throws {
        let root = Entity()
        let scene = try JavaScriptScene(
            rootEntity: root,
            source: """
                const s = new Spatial.Scene();
                s.userData.called = false;
                this.scriptChanged = () => { s.userData.called = true; };
                Spatial.mount(s);
                """
        )
        scene.tick(deltaTime: 1.0 / 60)
        let dumped = try #require(scene.dump()["scene"] as? [String: Any])
        let userData = try #require(dumped["userData"] as? [String: Any])
        #expect(userData["called"] as? Bool == false)
        scene.dispose()
    }

    // MARK: - Parity plans (SPEC 11)

    /// The `POST /parity` plan runner and the conformance runner share one
    /// step interpreter, so every conformance step kind is a parity step kind.
    /// The plan used to stop at the first phase 2 step with "unknown step".
    @Test
    func theParityPlanAcceptsEveryPhase2StepKind() async throws {
        let root = Entity()
        let scene = try JavaScriptScene(
            rootEntity: root,
            source: """
                const scene = new Spatial.Scene();
                const screen = new Spatial.VideoScreen({ url: "asset://spatial-bars.mp4", width: 0.4 });
                screen.name = "screen";
                scene.add(screen);
                scene.userData.events = [];
                Spatial.host.on("go", (payload) => { scene.userData.events.push(payload); });
                Spatial.mount(scene);
                """,
            assetRoot: Self.assetRoot
        )
        scene.tick(deltaTime: 1.0 / 60)

        // Every kind the conformance runner knows, with no `frames` step so
        // the plan does not have to wait on a display loop.
        let outcome = await ScriptingParityPlan.run(
            [
                ["hostFunctions": ["Plan.save"]],
                ["hostEvent": "go", "payload": ["n": 1]],
                ["syncVideo": [["target": "screen", "playing": true, "currentTime": 2, "duration": 8]]],
                ["syncAudio": [[String: Any]]()],
                ["syncCharacter": [[String: Any]]()],
                ["inject": "controller", "state": ["id": "pad-1", "name": "Pad"]],
                ["setActive": false],
                ["setActive": true],
                ["setInput": ["keyboard": ["down": ["KeyA"], "pressed": [String]()]]],
            ],
            on: scene,
            deltaTime: 1.0 / 60
        )

        #expect(outcome.errors.isEmpty, "\(outcome.errors)")
        #expect(ScriptingRuntime.hostFunctionNames.contains("Plan.save"))
        #expect(scene.isActive)
        ScriptingRuntime.unregister(module: "Plan", function: "save")

        // A step the interpreter does not know is still reported.
        let unknown = await ScriptingParityPlan.run(
            [["teleportationCircuit": true]],
            on: scene,
            deltaTime: 1.0 / 60
        )
        #expect(unknown.errors.count == 1)
        #expect(unknown.errors.first?.contains("unknown step") == true)

        ScriptingRuntime.isPaused = false
        scene.clearPlanBudget()
        // The hub is shared, so an injected pad must not outlive the plan.
        scene.injectControllers(nil)
        scene.dispose()
    }

    // MARK: - 14.11 Small components

    @Test
    func accessibilityBecomesAComponentAndStaysInTheDump() throws {
        let (_, scene) = try makeSceneWithMesh()
        scene.applyCommands(javaScript: """
            [["accessibility", 1, { "label": "Play", "value": "stopped", "hint": "Tap to start", "isButton": true }]]
            """)
        let target = try entity(scene, 1)
        let component = try #require(target.components[AccessibilityComponent.self])
        #expect(component.isAccessibilityElement)
        #expect(component.systemActions.contains(.activate))
        #expect(component.customContent.count == 1, "the hint is carried as custom content")

        let dump = scene.nativeDump()
        let objects = try #require(dump["objects"] as? [[String: Any]])
        let entry = try #require(objects.first { $0["id"] as? Int == 1 })
        let accessibility = try #require(entry["accessibility"] as? [String: Any])
        #expect(accessibility["label"] as? String == "Play")
        // The component itself is asserted on the entity above; SPEC 8 keeps
        // native facts out of the payload and in `components`.
        #expect(entry["components"] as? [String] != nil)

        scene.applyCommands(javaScript: """
            [["accessibility", 1, null]]
            """)
        #expect(try entity(scene, 1).components[AccessibilityComponent.self] == nil)
        scene.dispose()
    }

    @Test
    func debugModelViewSetsTheComponentAndRejectsAnUnknownMode() throws {
        let (_, scene) = try makeSceneWithMesh()
        scene.applyCommands(javaScript: """
            [["renderOptions", 0, { "debugModelView": "normal" }]]
            """)
        let component = try #require(try entity(scene, 1).components[ModelDebugOptionsComponent.self])
        #expect(component.visualizationMode == .normal)

        scene.applyCommands(javaScript: """
            [["renderOptions", 0, { "debugModelView": "sparkles" }]]
            """)
        #expect(scene.commandApplier.warnings.warnings.contains { $0.contains("sparkles") })

        scene.applyCommands(javaScript: """
            [["renderOptions", 0, { "debugModelView": null }]]
            """)
        #expect(try entity(scene, 1).components[ModelDebugOptionsComponent.self] == nil)
        scene.dispose()
    }

    @Test
    func adaptiveResolutionIsKeptAndEnvironmentLightingScalesInstead() throws {
        let (_, scene) = try makeScene()
        scene.applyCommands(javaScript: """
            [["renderOptions", 0, { "adaptiveResolution": true, "environmentIntensityExponent": 1 }]]
            """)
        #expect(scene.commandApplier.renderOptions["adaptiveResolution"] as? Bool == true)
        // AR-36: the core warns that adaptive resolution is visionOS only, so
        // this consumer is silent and simply keeps the flag.
        #expect(scene.commandApplier.warnings.warnings.isEmpty)
#if !os(visionOS)
        #expect(scene.commandApplier.environmentIntensityExponent == 1)
#endif
        scene.dispose()
    }

    // MARK: - 14.12 Multiple materials

    @Test
    func aMaterialArrayFillsModelComponentMaterials() throws {
        let (_, scene) = try makeSceneWithMesh()
        scene.applyCommands(javaScript: """
            [["material", 1, [
              { "type": "MeshStandardMaterial", "color": [1, 0, 0] },
              { "type": "MeshBasicMaterial", "color": [0, 1, 0] },
              { "type": "MeshStandardMaterial", "color": [0, 0, 1] }
            ]]]
            """)
        let model = try #require(try entity(scene, 1) as? ModelEntity)
        #expect(model.model?.materials.count == 3)
        #expect(scene.commandApplier.records[1]?.materialSpecs?.count == 3)

        // SPEC 8's shape rule leaves no room for a `materialCount` key: how
        // many slots are drawn is visible in `material`, which is an array.
        let dump = scene.nativeDump()
        let objects = try #require(dump["objects"] as? [[String: Any]])
        let entry = try #require(objects.first { $0["id"] as? Int == 1 })
        #expect((entry["material"] as? [Any])?.count == 3)

        // A single material afterwards goes back to one slot.
        scene.applyCommands(javaScript: """
            [["material", 1, { "type": "MeshStandardMaterial", "color": [1, 1, 1] }]]
            """)
        #expect(scene.commandApplier.records[1]?.materialSpecs == nil)
        scene.dispose()
    }

    // MARK: - 14.14 Capabilities and the native dump

    @Test
    func everyPhase2CapabilityIsReported() throws {
        ScriptingRuntime.setup(inputOptions: .all)
        let environment = JavaScriptScene.environmentDescription(assetRoot: nil)
        let capabilities = try #require(environment["capabilities"] as? [String: Bool])
        for name in [
            "audio", "video", "camera", "characterController", "forceFields",
            "skeleton", "blendShapes", "shaderGraph", "sceneUnderstanding",
            "controllers", "hostFunctions", "accessibility",
        ] {
            #expect(capabilities[name] != nil, "capability '\(name)' is missing")
        }
#if os(visionOS)
        #expect(capabilities["sceneUnderstanding"] == true)
        #expect(capabilities["camera"] == false)
#else
        #expect(capabilities["sceneUnderstanding"] == false, "SceneUnderstandingComponent is unavailable on macOS")
        #expect(capabilities["camera"] == true)
#endif
        #expect(capabilities["audio"] == true)
        #expect(capabilities["video"] == true)
    }

    @Test
    func theNativeDumpCarriesTheNewSceneSections() throws {
        let (_, scene) = try makeSceneWithMesh()
        scene.applyCommands(javaScript: """
            [["audioMixer", 0, { "masterVolume": 0.5, "groups": { "sfx": 1 } }],
             ["sceneUnderstanding", 0, { "collision": true }],
             ["renderOptions", 0, { "debugModelView": "uv" }],
             ["audio", 1, { "url": "asset://spatial-tone.wav", "spatial": true, "volume": 1 }]]
            """)
        let dump = scene.nativeDump()
        let mixer = try #require(dump["audioMixer"] as? [String: Any])
        #expect(mixer["masterVolume"] as? Double == 0.5)
        // SPEC 8: the mixer group component is a native fact, not a dump key;
        // it is asserted where it lives.
        #expect(scene.commandApplier.root.components[AudioMixGroupsComponent.self] != nil)
        let understanding = try #require(dump["sceneUnderstanding"] as? [String: Any])
        #expect(understanding["collision"] as? Bool == true)
        // All four flags are always present, as booleans, like the core's.
        #expect(understanding["occlusion"] as? Bool == false)
        #expect(understanding["physics"] as? Bool == false)
        #expect(understanding["shadows"] as? Bool == false)
        // SPEC 8: `render` carries the stored flag and the debug mode is its
        // own top-level section, exactly as the core dump has it.
        #expect((dump["render"] as? [String: Any])?["adaptiveResolution"] as? Bool == false)
        #expect((dump["debug"] as? [String: Any])?["modelView"] as? String == "uv")
        #expect(dump["isActive"] as? Bool == true)
        #expect(dump["environmentLighting"] != nil)
        #expect(dump["debug"] != nil)
        #expect(dump["controllers"] as? [[String: Any]] != nil)
        #expect(dump["hostFunctions"] as? [String] != nil)

        let objects = try #require(dump["objects"] as? [[String: Any]])
        let entry = try #require(objects.first { $0["id"] as? Int == 1 })
        let audio = try #require(entry["audio"] as? [String: Any])
        // The RealityKit component is reported in `components`, never as an
        // extra key inside a payload the core also carries (SPEC 8).
        #expect((entry["components"] as? [String])?.contains("SpatialAudioComponent") == true)
        #expect(audio["url"] as? String == "asset://spatial-tone.wav")
        #expect(audio["spatial"] as? Bool == true)
        scene.dispose()
    }

    @Test
    func anUnknownPhase2OpcodeStillWarnsExactlyOnce() throws {
        let (_, scene) = try makeScene()
        scene.applyCommands(javaScript: """
            [["teleportationCircuit", 0, {}], ["teleportationCircuit", 0, {}]]
            """)
        let matching = scene.commandApplier.warnings.warnings.filter { $0.contains("teleportationCircuit") }
        #expect(matching.count == 1)
        scene.dispose()
    }
}

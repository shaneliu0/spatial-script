//
//  MediaTests.swift
//  RealityKitScripting
//
//  Created by Shane Liu on 9/9/26.
//

import AVFoundation
import Foundation
import RealityKit
import Testing
@testable import RealityKitScripting

/// SPEC 14.1 and 14.2: the audio and video a script attaches to an object,
/// and what becomes of them when it changes or goes away.
@MainActor
struct MediaTests {
    private func makeScene(_ body: String = "") throws -> (Entity, JavaScriptScene) {
        try ScriptingTestScene.make(body)
    }

    private func makeSceneWithMesh() throws -> (Entity, JavaScriptScene) {
        try ScriptingTestScene.makeWithMesh()
    }

    /// P2-B-01: destroying an object releases its audio and video players with
    /// it. The AVPlayer used to keep playing for the life of the process, and
    /// the playback controller's completion handler held the record alive.
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

    /// P2-B-24: a property change on a playing sound edits the component in
    /// place. Rebuilding it swapped the playback controller under the sound and
    /// restarted it, so a volume tween stuttered.
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

    /// P2-B-26: releasing a video puts the object's own material back. The dead
    /// VideoMaterial would otherwise keep drawing the frame it stopped on.
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

    /// P2-B-41: an `audioControl` that arrives before the sound's payload is
    /// held, not dropped, and applied when the resource lands.
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

    /// P2-C-02: SPEC 8's `audioMixer.state` is "suspended" until a sound really
    /// plays, so the audio engine is created lazily and reported once.
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

    /// P2-C-06: RealityKit has no reference distance, so a non-default one is
    /// folded into the rolloff — twice the distance, half the rate — and the
    /// substitution is warned about rather than silently dropped.
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

    /// SPEC 14.1: a video source AVFoundation cannot open reports `error` with
    /// the message, once per source. A missing local file and an http url that
    /// does not answer both surface — the failure arrives through the player
    /// item's status, so nothing but watching it would have caught either.
    @Test
    func aVideoSourceThatCannotBeOpenedReportsAnError() async throws {
        let (_, scene) = try makeScene()
        nonisolated(unsafe) var events: [(String, Int, [String: Any]?)] = []
        scene.commandApplier.dispatch = { type, id, payload in events.append((type, id, payload)) }
        scene.applyCommands(javaScript: """
            [["create", 1, "mesh", "missing-file"],
             ["video", 1, { "url": "asset://not-a-video.mp4", "width": 1, "muted": true }],
             ["create", 2, "mesh", "unreachable"],
             ["video", 2, { "url": "http://127.0.0.1:9/never-answers.mp4", "width": 1, "muted": true }],
             ["create", 3, "mesh", "not-a-movie"],
             ["video", 3, { "url": "asset://checker.png", "width": 1, "muted": true }]]
            """)
        for _ in 0..<600 where events.filter({ $0.0 == "error" }).count < 3 {
            try? await Task.sleep(for: .milliseconds(10))
        }
        let failures = events.filter { $0.0 == "error" }
        #expect(
            Set(failures.map(\.1)) == [1, 2, 3],
            "both sources must report: \(failures.map { ($0.1, $0.2 ?? [:]) })"
        )
        for failure in failures {
            let message = failure.2?["message"] as? String ?? ""
            #expect(!message.isEmpty, "SPEC 14.1: the error carries a message")
        }
        // And the dump carries it, in both dumps' shape.
        let objects = try #require(scene.nativeDump()["objects"] as? [[String: Any]])
        for name in ["missing-file", "unreachable", "not-a-movie"] {
            let object = try #require(objects.first { $0["name"] as? String == name })
            let video = try #require(object["video"] as? [String: Any])
            #expect(video["error"] is String, "\(name): \(video["error"] ?? "nil")")
        }
        // Once per source: a second frame does not report it again.
        let count = events.filter { $0.0 == "error" }.count
        for _ in 0..<10 { scene.tick(deltaTime: 1.0 / 60) }
        try? await Task.sleep(for: .milliseconds(50))
        #expect(events.filter { $0.0 == "error" }.count == count)
        scene.dispose()
    }
}

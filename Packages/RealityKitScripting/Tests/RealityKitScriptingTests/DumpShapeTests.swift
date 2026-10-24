//
//  DumpShapeTests.swift
//  RealityKitScripting
//
//  Created by Shane Liu on 9/9/26.
//

import AVFoundation
import Foundation
import RealityKit
import Testing
@testable import RealityKitScripting

/// SPEC 8 and 3.11: what the native dump reports for an object, and what it
/// must not claim on a platform that cannot do it.
@MainActor
struct DumpShapeTests {
    private func makeScene(_ body: String = "") throws -> (Entity, JavaScriptScene) {
        try ScriptingTestScene.make(body)
    }

    /// NR-02: an object carrying a material per part is still a rigid body and
    /// still an asset. A misplaced brace put the motion and asset reports
    /// inside the single-material branch, so a multi-material dynamic body
    /// dumped no `velocity` and no `isSleeping` at all.
    @Test
    func multiMaterialObjectsStillDumpTheirMotion() throws {
        let (_, scene) = try makeScene()
        // A box the way the core sends one: six groups, one material per face.
        let groups = (0..<6).map { "{ \"start\": \($0 * 6), \"count\": 6, \"materialIndex\": \($0) }" }
            .joined(separator: ",")
        let materials = (0..<6).map {
            """
            { "type": "MeshStandardMaterial", "uuid": "face-\($0)",
              "color": [\(Double($0) / 6), 0.4, 0.2], "opacity": 1, "transparent": false,
              "side": 0, "wireframe": false, "metalness": 0, "roughness": 1 }
            """
        }.joined(separator: ",")
        scene.applyCommands(javaScript: """
            [["create", 1, "mesh", "multi"],
             ["geometry", 1, { "type": "BoxGeometry",
                               "parameters": { "width": 1, "height": 1, "depth": 1 },
                               "uuid": "box-multi", "revision": "0:0:0:0:0",
                               "groups": [\(groups)] }, null, null, null, null],
             ["material", 1, [\(materials)]],
             ["rigidBody", 1, { "type": "dynamic", "mass": 1, "shape": "box" }],
             ["create", 2, "mesh", "single"],
             ["geometry", 2, { "type": "BoxGeometry",
                               "parameters": { "width": 1, "height": 1, "depth": 1 },
                               "uuid": "box-single", "revision": "0:0:0:0:0" }, null, null, null, null],
             ["rigidBody", 2, { "type": "dynamic", "mass": 1, "shape": "box" }]]
            """)
        let objects = try #require(scene.nativeDump()["objects"] as? [[String: Any]])
        let multi = try #require(objects.first { $0["name"] as? String == "multi" })
        let single = try #require(objects.first { $0["name"] as? String == "single" })
        #expect(multi["material"] is [Any], "the multi-material object must dump an array")
        #expect(single["velocity"] is [Any])
        #expect(
            multi["velocity"] is [Any],
            "a multi-material dynamic body dumped no velocity: \(multi.keys.sorted())"
        )
        #expect(multi["isSleeping"] is Bool)
        scene.dispose()
    }

    /// FA-14: the two dumps in one process must not disagree about anchoring.
    /// SPEC 3.11 says only visionOS anchors; the dispatch half was gated but
    /// the native dump still read `AnchorEntity.isAnchored`, which RealityKit
    /// resolves to true on macOS the moment the entity is in a scene, so
    /// `/native-dump` reported `true` while `dump()` reported `false`.
    @Test
    func theNativeDumpNeverClaimsAnAnchorAnchoredOffVisionOS() throws {
        // The gate itself, given the value RealityKit really returns on the Mac.
        let reported = ScriptingCommandApplier.anchoredReport(native: true)
#if os(visionOS)
        #expect(reported)
#else
        #expect(!reported, "macOS has no anchoring, so the dump must not claim it")
#endif

        let (_, scene) = try makeScene()
        scene.applyCommands(javaScript: """
            [["create", 1, "anchor", "wall"],
             ["anchor", 1, { "type": "plane", "alignment": "vertical" }]]
            """)
        let objects = try #require(scene.nativeDump()["objects"] as? [[String: Any]])
        let anchor = try #require(objects.first { $0["name"] as? String == "wall" })
        let native = try #require(anchor["isAnchored"] as? Bool)
#if os(visionOS)
        _ = native
#else
        // The core reports `false` until an `anchored` event arrives, and on
        // macOS one never does, so this is the value both dumps must carry.
        #expect(!native, "the native dump disagreed with the core dump")
#endif
        scene.dispose()
    }

    /// FA-14: SPEC 3.11 — on macOS an anchor exists but never anchors.
    @Test
    func aMacOSAnchorNeverReportsItselfAnchored() throws {
        let (_, scene) = try makeScene()
        nonisolated(unsafe) var events: [String] = []
        scene.commandApplier.dispatch = { type, _, _ in events.append(type) }
        scene.applyCommands(javaScript: """
            [["create", 1, "anchor", "spot"], ["anchor", 1, { "target": "head" }]]
            """)
        _ = scene.commandApplier.nativeDrivenSyncRecords()
        _ = scene.commandApplier.nativeDrivenSyncRecords()
#if os(visionOS)
        _ = events
#else
        #expect(!events.contains("anchored"), "macOS anchors never resolve")
        let dump = scene.nativeDump()
        let objects = try #require(dump["objects"] as? [[String: Any]])
        #expect(objects.first?["isAnchored"] as? Bool == false)
#endif
        scene.dispose()
    }

    /// AR-36: a fact the core already warns about is the core's to say. Six of
    /// them used to be said twice, in two different sentences that no
    /// deduplication could collapse, so `dump().warnings` carried both. This
    /// scene hits every one of them and holds the console to one line each.
    ///
    /// `camera-visionos` is the odd one: neither side warns about it on macOS
    /// (the core's guard is `platform === "visionos"`), so the fact this test
    /// pins there is that nothing says it at all.
    @Test
    func aFactTheCoreWarnsAboutIsNotWarnedAboutTwice() throws {
        let root = Entity()
        let scene = try JavaScriptScene(
            rootEntity: root,
            source: """
                const Spatial = require("spatial");
                const S = Spatial;
                const scene = new S.Scene();

                // additive-blending and pointlight-shadow.
                const box = new S.Mesh(
                  new S.BoxGeometry(0.2, 0.2, 0.2),
                  new S.MeshStandardMaterial({ color: 0x3366ff, blending: S.AdditiveBlending }),
                );
                box.name = "box";
                scene.add(box);
                const bulb = new S.PointLight(0xffffff, 2, 4, 2);
                bulb.name = "bulb";
                bulb.castShadow = true;
                scene.add(bulb);

                // video-docking.
                const screen = new S.VideoScreen({
                  url: "asset://spatial-bars.mp4", width: 0.4, muted: true, docking: true,
                });
                screen.name = "screen";
                scene.add(screen);

                // adaptive-resolution and scene-understanding.
                S.render.adaptiveResolution = true;
                S.sceneUnderstanding.collision = true;

                // camera-visionos, which only visionOS warns about.
                const camera = new S.PerspectiveCamera(50, 1.5, 0.1, 50);
                camera.name = "camera";
                scene.add(camera);
                S.camera = camera;

                S.mount(scene);
                """,
            assetRoot: URL(string: "assets"),
            assetDirectory: Phase2Tests.assetRoot
        )
        for _ in 0..<4 { scene.tick(deltaTime: 1.0 / 60) }
        let warnings = scene.dump()["warnings"] as? [String] ?? []

        // Each fact, by phrases that match whichever backend said it. The
        // raycast line names `sceneUnderstanding` too, so the scene
        // understanding fact is matched on what it actually claims.
        let facts: [(String, [String])] = [
            ("video docking", ["docking"]),
            ("adaptive resolution", ["adaptiveResolution", "Adaptive resolution"]),
            (
                "scene understanding",
                ["Spatial.sceneUnderstanding has no effect", "Scene understanding is visionOS only"]
            ),
            ("additive blending", ["AdditiveBlending"]),
            ("point light shadows", ["PointLight"]),
        ]
        for (fact, needles) in facts {
            let matching = warnings.filter { line in needles.contains { line.contains($0) } }
            #expect(
                matching.count == 1,
                "\(fact) is warned about \(matching.count) times: \(matching); all: \(warnings)"
            )
        }
        // The raycast line is this consumer's own knowledge — the core cannot
        // know that RealityKit will not return the reconstruction mesh — so it
        // is there exactly once beside the core's scene-understanding line.
        #expect(warnings.filter { $0.contains("Raycasts will not see the real world") }.count == 1)
        // The camera fact, not the unrelated `PerspectiveCamera.aspect` line
        // the core writes for every scripted camera.
        let camera = warnings.filter {
            $0.contains("the user is the camera") || $0.contains("the wearer is the camera")
        }
#if os(visionOS)
        #expect(camera.count == 1, "\(camera)")
#else
        #expect(camera.isEmpty, "nothing warns about the camera on macOS: \(camera)")
#endif
        scene.dispose()
    }
}

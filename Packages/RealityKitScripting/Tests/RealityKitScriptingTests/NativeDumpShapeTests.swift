//
//  NativeDumpShapeTests.swift
//  RealityKitScripting
//
//  Created by Shane Liu on 9/9/26.
//

import Foundation
import RealityKit
import Testing
@testable import RealityKitScripting

/// SPEC 8's native dump shape rule, held by one fixture scene that exercises
/// every object kind: a native dump has exactly the core dump's key set at
/// every depth, minus `userData`, `coreSource` and `uuid`, plus only
/// `scene.childCount`, per-object `nativeType` and `components`.
///
/// This is the durable half of the gate; the live half is the parity runner,
/// which compares the two consumers' native dumps against each other.
@MainActor
struct NativeDumpShapeTests {
    /// Keys the rule drops from the native dump everywhere.
    static let omitted: Set<String> = ["userData", "coreSource", "uuid"]
    /// The only keys a native dump may add, and where.
    static let additions: Set<String> = ["nativeType", "components", "childCount"]

    /// Everything the applier can build, in one scene. A kind missing here is a
    /// kind whose shape nothing checks.
    static let fixture = """
        const Spatial = require("spatial");
        const S = Spatial;
        const scene = new S.Scene();
        scene.name = "fixture";

        // Lights: all four kinds, so their whole parameter set is compared.
        const ambient = new S.AmbientLight(0xffffff, 0.4); ambient.name = "ambient"; scene.add(ambient);
        const sun = new S.DirectionalLight(0xfff0e0, 2); sun.name = "sun"; sun.castShadow = true; scene.add(sun);
        const bulb = new S.PointLight(0xff8844, 3, 4, 2); bulb.name = "bulb"; scene.add(bulb);
        const spot = new S.SpotLight(0x88ccff, 5, 6, Math.PI / 6, 0.4, 2); spot.name = "spot"; scene.add(spot);

        // A mesh with a material per face, a texture map, and a rigid body.
        const box = new S.Mesh(
          new S.BoxGeometry(0.2, 0.2, 0.2),
          [0, 1, 2, 3, 4, 5].map((i) => new S.MeshStandardMaterial({ color: 0x224466 + i })),
        );
        box.name = "box";
        box.castShadow = true;
        box.receiveShadow = true;
        box.renderOrder = 2;
        box.rigidBody = new S.RigidBody({ type: "dynamic", mass: 2 });
        box.addEventListener("tap", () => {});
        box.addEventListener("collisionstart", () => {});
        scene.add(box);

        const anchorBody = new S.Mesh(new S.BoxGeometry(1, 0.05, 1), new S.MeshStandardMaterial({
          map: new S.TextureLoader().load("checker.png"),
        }));
        anchorBody.name = "floor";
        anchorBody.position.y = -0.3;
        anchorBody.rigidBody = new S.RigidBody({ type: "static" });
        scene.add(anchorBody);

        // A joint between the two bodies.
        S.physics.add(new S.Joint({
          type: "revolute", bodyA: box, bodyB: anchorBody,
          anchorA: new S.Vector3(0, -0.1, 0), anchorB: new S.Vector3(0, 0.05, 0),
          axis: new S.Vector3(0, 1, 0), limits: [-1, 1],
        }));

        // Particles, portal, anchor.
        const sparks = new S.ParticleEmitter({ preset: "sparks" });
        sparks.name = "sparks"; scene.add(sparks);
        const world = new S.Group(); world.name = "portalWorld"; scene.add(world);
        const portal = new S.Portal({ width: 0.5, height: 0.5, world, crossing: true });
        portal.name = "portal"; scene.add(portal);
        const anchor = new S.Anchor({ plane: "horizontal" });
        anchor.name = "anchor"; scene.add(anchor);

        // Media.
        const sound = new S.PositionalAudio();
        sound.name = "sound";
        sound.setBuffer(new S.AudioLoader().load("spatial-tone.wav"));
        sound.setRefDistance(0.5);
        sound.setDirectionalCone(30, 90, 0.2);
        scene.add(sound);
        const bed = new S.AmbientAudio();
        bed.name = "bed";
        bed.setBuffer(new S.AudioLoader().load("spatial-tone.wav"));
        scene.add(bed);
        const screen = new S.VideoScreen({ url: "spatial-bars.mp4", width: 0.4, loop: true, muted: true });
        screen.name = "screen"; scene.add(screen);

        // Character controller and a force field.
        const walker = new S.Mesh(new S.CapsuleGeometry(0.05, 0.1), new S.MeshStandardMaterial());
        walker.name = "walker";
        walker.characterController = new S.CharacterController({ radius: 0.05, height: 0.16 });
        scene.add(walker);
        walker.characterController.move(new S.Vector3(0, -0.01, 0.01));
        const field = new S.RadialForceField({ strength: 0.5, radius: 0.4, falloff: "inverseSquare" });
        field.name = "field"; scene.add(field);

        // A shader graph material, with its fallback.
        const glow = new S.Mesh(new S.PlaneGeometry(0.2, 0.2), new S.ShaderGraphMaterial({
          source: "spatial-materials.usda",
          name: "Glow",
          parameters: { tint: [1, 0.5, 0.2] },
          fallback: new S.MeshStandardMaterial({ color: 0xffaa55, emissive: 0x221100 }),
        }));
        glow.name = "glow"; scene.add(glow);

        // An asset, a camera, and the scene-level sections.
        S.loadAsset({ usdz: "rig.usdz", glb: "rig.glb" }).then((asset) => {
          asset.name = "rig";
          scene.add(asset);
          asset.skeleton.setJointRotation("head", new S.Quaternion(0, 0.2, 0, 0.98));
          asset.blendShapes.set("widen", 0.5);
        });
        // A second asset whose file does not exist: it has no rig, and the
        // keys an asset always carries must be there anyway.
        S.loadAsset({ usdz: "not-here.usdz", glb: "not-here.glb" })
          .then((asset) => { asset.name = "missing"; scene.add(asset); })
          .catch(() => {});
        const camera = new S.PerspectiveCamera(55, 1.4, 0.1, 40);
        camera.name = "camera";
        camera.position.set(0, 0.2, 0.8);
        scene.add(camera);
        S.camera = camera;
        S.sceneUnderstanding.collision = true;
        S.render.adaptiveResolution = true;
        S.environmentLighting.intensityExponent = 1.5;
        S.audio.masterVolume = 0.8;
        S.audio.setGroupVolume("effects", 0.5);
        S.environment = new S.ImageBasedLight("studio-env.hdr", 1.2);
        S.mount(scene);
        """

    @Test
    func theNativeDumpHasExactlyTheCoreDumpsKeySet() throws {
        let root = Entity()
        let scene = try JavaScriptScene(
            rootEntity: root,
            source: Self.fixture,
            assetRoot: URL(string: "assets"),
            assetDirectory: Phase2Tests.assetRoot
        )
        for _ in 0..<3 { scene.tick(deltaTime: 1.0 / 60) }
        // The plan stands in for the loader, exactly as SPEC 9's runners do, so
        // the asset kind is exercised without waiting on a file read.
        if let id = scene.assetID(forURL: "assets/rig.usdz") ?? scene.assetID(forURL: "rig.usdz") {
            scene.dispatch(
                type: "assetLoaded",
                id: id,
                payload: [
                    "animations": ["idle"],
                    "joints": ["root", "head"],
                    "blendShapes": ["widen"],
                    "boundingBox": [-0.1, 0, -0.1, 0.1, 0.4, 0.1],
                ]
            )
        }
        for _ in 0..<3 { scene.tick(deltaTime: 1.0 / 60) }
        // The failed one is named through its own result, so the object exists
        // in both dumps with no rig at all.
        if let missing = scene.assetID(forURL: "assets/not-here.usdz")
            ?? scene.assetID(forURL: "not-here.usdz") {
            scene.dispatch(type: "assetError", id: missing, payload: ["message": "no such file"])
        }
        for _ in 0..<2 { scene.tick(deltaTime: 1.0 / 60) }

        let core = scene.dump()
        let native = scene.nativeDump()
        let coreObjects = (core["objects"] as? [[String: Any]] ?? []).map { $0["name"] as? String ?? "" }
        #expect(coreObjects.contains("rig"), "the asset kind must be in the fixture: \(coreObjects)")
        #expect(coreObjects.count >= 16, "every kind must be in the fixture: \(coreObjects)")

        let diffs = Self.shapeDiffs(core: core, native: native, path: "dump")
        #expect(
            diffs.isEmpty,
            Comment(rawValue: "SPEC 8 shape rule, \(diffs.count) differences:\n"
                + diffs.sorted().joined(separator: "\n"))
        )
        scene.dispose()
    }

    /// One line per key the rule does not allow, at any depth.
    static func shapeDiffs(core: Any?, native: Any?, path: String) -> [String] {
        var diffs: [String] = []
        let coreDictionary = core as? [String: Any]
        let nativeDictionary = native as? [String: Any]
        if let coreDictionary, let nativeDictionary {
            for key in coreDictionary.keys where !omitted.contains(key) {
                guard nativeDictionary[key] != nil else {
                    diffs.append("\(path).\(key): in the core dump only")
                    continue
                }
                diffs.append(contentsOf: shapeDiffs(
                    core: coreDictionary[key],
                    native: nativeDictionary[key],
                    path: "\(path).\(key)"
                ))
            }
            for key in nativeDictionary.keys
            where coreDictionary[key] == nil && !additions.contains(key) {
                diffs.append("\(path).\(key): in the native dump only")
            }
            return diffs
        }
        // A key that is an object on one side and null on the other changes the
        // key set just as surely as a missing key does.
        if coreDictionary != nil, native is NSNull || native == nil {
            return ["\(path): an object in the core dump, null in the native dump"]
        }
        if nativeDictionary != nil, core is NSNull || core == nil {
            return ["\(path): null in the core dump, an object in the native dump"]
        }
        guard let coreArray = core as? [Any], let nativeArray = native as? [Any] else { return diffs }
        if path.hasSuffix("objects") {
            let byName = (nativeArray.compactMap { $0 as? [String: Any] })
                .reduce(into: [String: [String: Any]]()) { result, object in
                    if let name = object["name"] as? String, result[name] == nil { result[name] = object }
                }
            for element in coreArray {
                guard let object = element as? [String: Any], let name = object["name"] as? String else { continue }
                guard let match = byName[name] else {
                    diffs.append("\(path)[\"\(name)\"]: missing from the native dump")
                    continue
                }
                diffs.append(contentsOf: shapeDiffs(core: object, native: match, path: "\(path)[\"\(name)\"]"))
            }
            return diffs
        }
        for (index, element) in coreArray.enumerated() where index < nativeArray.count {
            diffs.append(contentsOf: shapeDiffs(
                core: element,
                native: nativeArray[index],
                path: "\(path)[\(index)]"
            ))
        }
        return diffs
    }
}

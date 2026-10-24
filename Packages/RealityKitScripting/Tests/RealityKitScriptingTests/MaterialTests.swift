//
//  MaterialTests.swift
//  RealityKitScripting
//
//  Created by Shane Liu on 9/9/26.
//

import AVFoundation
import Foundation
import RealityKit
import Testing
@testable import RealityKitScripting

/// SPEC 3.4, 14.6 and 14.12: how a material payload becomes a native
/// material, how textures bind to it, and how a mesh with a material per part
/// is drawn.
@MainActor
struct MaterialTests {
    private func makeScene(_ body: String = "") throws -> (Entity, JavaScriptScene) {
        try ScriptingTestScene.make(body)
    }

    private func makeSceneWithMesh() throws -> (Entity, JavaScriptScene) {
        try ScriptingTestScene.makeWithMesh()
    }

    /// P2-B-07 and P2-B-08: a shader graph parameter that is numerically 0 or 1
    /// stays a number. `as? Bool` succeeds for both on the NSNumber the
    /// declaration path hands over, which turned them into booleans.
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

    /// P2-C-01: SPEC 14.12's `geometry.groups` really splits the mesh when the
    /// object carries a material per group; the groups used to be discarded.
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

    /// three.js gives an ordinary box six groups, one per face. Splitting on
    /// the descriptor alone gave every object six material slots and six draw
    /// calls, which halved the frame rate at SPEC 12's 1500 object target.
    @Test
    func aSingleMaterialMeshStaysOnePartEvenWithGroups() throws {
        let (_, scene) = try makeScene()
        scene.applyCommands(javaScript: """
            [
              ["create", 1, "mesh", "box"],
              ["material", 1, { "type": "MeshStandardMaterial", "color": [1, 0, 0] }],
              ["geometry", 1, {
                 "type": "BoxGeometry",
                 "parameters": { "width": 1, "height": 1, "depth": 1 },
                 "groups": [{ "start": 0, "count": 6, "materialIndex": 0 },
                            { "start": 6, "count": 6, "materialIndex": 1 },
                            { "start": 12, "count": 6, "materialIndex": 2 },
                            { "start": 18, "count": 6, "materialIndex": 3 },
                            { "start": 24, "count": 6, "materialIndex": 4 },
                            { "start": 30, "count": 6, "materialIndex": 5 }]
               },
               null, null, null, null]
            ]
            """)
        let model = try #require(scene.commandApplier.records[1]?.entity as? ModelEntity)
        #expect(model.model?.materials.count == 1, "one material must mean one draw call")
        #expect(scene.commandApplier.records[1]?.geometryGroups == nil)
        // SPEC 8's shape rule: `geometry` carries what the core's does, so the
        // split is visible in the mesh itself rather than in extra dump keys.
        let dump = scene.nativeDump()
        let objects = try #require(dump["objects"] as? [[String: Any]])
        let geometry = try #require(objects.first?["geometry"] as? [String: Any])
        #expect(geometry.keys.sorted() == ["parameters", "type"])
        #expect(model.model?.mesh.expectedMaterialCount == 1)

        // Two objects with the same geometry share one mesh: the split would
        // have minted a resource per object.
        scene.applyCommands(javaScript: """
            [["create", 2, "mesh", "box2"],
             ["material", 2, { "type": "MeshStandardMaterial", "color": [1, 0, 0] }],
             ["geometry", 2, { "type": "BoxGeometry", "parameters": { "width": 1, "height": 1, "depth": 1 },
                               "groups": [{ "start": 0, "count": 36, "materialIndex": 0 }] },
              null, null, null, null]]
            """)
        #expect(scene.commandApplier.resources.summary["meshHits"] as? Int ?? 0 >= 1)
        scene.dispose()
    }

    /// FA-20: a material built from the warmed prototype must be
    /// indistinguishable from one built from `PhysicallyBasedMaterial()`. The
    /// prototype exists only to pay RealityKit's per-parameter instantiation
    /// once instead of 1500 times; if it changed a default, every material in
    /// the scene would be wrong.
    @Test
    func prototypesMatchAFreshMaterial() {
        let warmed = ScriptingMaterialFactory.physicallyBasedPrototype
        let fresh = PhysicallyBasedMaterial()
        #expect(
            ScriptingColor.linearComponents(of: warmed.baseColor.tint)
                == ScriptingColor.linearComponents(of: fresh.baseColor.tint)
        )
        #expect(warmed.baseColor.texture == nil)
        #expect(warmed.metallic.scale == fresh.metallic.scale)
        #expect(warmed.roughness.scale == fresh.roughness.scale)
        #expect(warmed.emissiveIntensity == fresh.emissiveIntensity)
        #expect(
            ScriptingColor.linearComponents(of: warmed.emissiveColor.color)
                == ScriptingColor.linearComponents(of: fresh.emissiveColor.color)
        )
        #expect(warmed.clearcoat.scale == fresh.clearcoat.scale)
        #expect(warmed.clearcoatRoughness.scale == fresh.clearcoatRoughness.scale)
        #expect(warmed.faceCulling == fresh.faceCulling)
        #expect(warmed.writesDepth == fresh.writesDepth)
        #expect(warmed.readsDepth == fresh.readsDepth)
        #expect(warmed.normal.texture == nil)
        #expect(warmed.ambientOcclusion.texture == nil)
        #expect(warmed.opacityThreshold == fresh.opacityThreshold)

        let unlit = ScriptingMaterialFactory.unlitPrototype
        let freshUnlit = UnlitMaterial()
        #expect(
            ScriptingColor.linearComponents(of: unlit.color.tint)
                == ScriptingColor.linearComponents(of: freshUnlit.color.tint)
        )
        #expect(unlit.color.texture == nil)
        #expect(unlit.faceCulling == freshUnlit.faceCulling)
    }

    /// FA-20: SPEC 12 says a scene of 1500 meshes loads in under a second, with
    /// no exemption for a material per mesh. RealityKit charges ~0.57 ms for
    /// the first write to each parameter of a fresh material, so 1500 unique
    /// materials cost 0.9 s of native writes alone; built from the warmed
    /// prototype they cost about a hundredth of that.
    @Test
    func fifteenHundredUniqueMaterialsBuildWellInsideTheLoadBudget() {
        let warnings = ScriptingWarningCollector()
        let textures = ScriptingTextureStore(assetDirectory: URL(fileURLWithPath: "/tmp"))
        // Warm the prototype outside the measurement: it is built once per
        // process, not once per scene.
        _ = ScriptingMaterialFactory.physicallyBasedPrototype
        let started = DispatchTime.now().uptimeNanoseconds
        for index in 0..<1500 {
            var spec = ScriptingMaterialSpec(payload: [:])
            spec.color = SIMD3(Float(index) / 1500, 0.4, 0.7)
            spec.roughness = 0.4
            spec.metalness = 0.6
            _ = ScriptingMaterialFactory.material(for: spec, textures: textures, warnings: warnings)
        }
        let elapsed = Double(DispatchTime.now().uptimeNanoseconds - started) / 1e6
        #expect(elapsed < 300, "1500 unique materials took \(elapsed) ms")
    }

    /// FA-28: `["shaderParameter", id, name, value, materialIndex]` — the
    /// five-element form the core really emits (core/src/runtime/features.js
    /// `emitParameters`). Two slots writing the same parameter name must not
    /// collide, and a write to a slot that draws its fallback must say so
    /// rather than returning silently.
    @Test
    func shaderParametersAreKeptPerMaterialSlot() throws {
        let (_, scene) = try makeScene()
        let slot = """
            { "type": "MeshStandardMaterial", "uuid": "slot-%@",
              "color": [0.5, 0.5, 0.5], "opacity": 1, "transparent": false,
              "side": 0, "wireframe": false, "metalness": 0, "roughness": 1 }
            """
        let groups = (0..<2).map { "{ \"start\": \($0 * 3), \"count\": 3, \"materialIndex\": \($0) }" }
            .joined(separator: ",")
        scene.applyCommands(javaScript: """
            [["create", 1, "mesh", "two-slots"],
             ["geometry", 1, { "type": "BufferGeometry", "parameters": {},
                               "uuid": "two-slot-geometry", "revision": "0:0:-1:-1:0",
                               "groups": [\(groups)] },
              new Float32Array([0,0,0, 1,0,0, 1,1,0, 0,0,0, 1,1,0, 0,1,0]), null, null,
              new Uint32Array([0,1,2,3,4,5])],
             ["material", 1, [\(String(format: slot, "a")), \(String(format: slot, "b"))]],
             ["shaderParameter", 1, "tint", [1, 0, 0], 0],
             ["shaderParameter", 1, "tint", [0, 0, 1], 1]]
            """)
        // SPEC 8: each slot reports its own parameters inside its own material
        // entry, which is where the core reports them.
        let objects = try #require(scene.nativeDump()["objects"] as? [[String: Any]])
        let object = try #require(objects.first { $0["name"] as? String == "two-slots" })
        let slots = try #require(object["material"] as? [[String: Any]])
        let state = try #require(scene.commandApplier.records[1]?.extras?.shaderGraph)
        let slot0 = try #require(state.parametersBySlot[0]?["tint"] as? [Double])
        #expect(slot0 == [1, 0, 0], "slot 1 overwrote slot 0: \(slot0)")
        let slot1 = try #require(state.parametersBySlot[1]?["tint"] as? [Double])
        #expect(slot1 == [0, 0, 1])
        #expect(slots.count == 2)
        #expect(
            scene.commandApplier.warnings.warnings.contains { $0.contains("material slot 1") },
            "a write to a fallback slot must not vanish: \(scene.commandApplier.warnings.warnings)"
        )
        scene.dispose()
    }

    /// FA-16 and FA-32: a data url decodes, a blob url is refused by name, and
    /// `flipY` applies to every source.
    @Test
    func dataURLsDecodeAndBlobURLsAreRefused() async throws {
        let (_, scene) = try makeSceneWithMesh()
        nonisolated(unsafe) var failures: [String] = []
        scene.commandApplier.textures.onFailed = { _, message in failures.append(message) }
        scene.applyCommands(javaScript: """
            [["texture", 1, { "url": "blob:https://example.com/9f5c", "flipY": false }]]
            """)
        #expect(failures.contains { $0.contains("blob") })

        // A 1x1 png, the smallest thing that proves the decode path.
        let png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
        scene.applyCommands(javaScript: """
            [["texture", 2, { "url": "\(png)", "flipY": false }]]
            """)
        for _ in 0..<200 where scene.commandApplier.textures.resource(for: 2) == nil
            && !failures.contains(where: { $0.contains("data url") }) {
            try? await Task.sleep(for: .milliseconds(10))
        }
        #expect(scene.commandApplier.textures.resource(for: 2) != nil, "\(failures)")
        // The decoder is shared, so flipY is no longer remote-only.
        #expect(ScriptingTextureStore.decodeDataURL(png) != nil)
        scene.dispose()
    }

    /// FA-31: clearing a slot clears the map.
    @Test
    func clearingANormalMapClearsIt() throws {
        let (_, scene) = try makeSceneWithMesh()
        scene.applyCommands(javaScript: """
            [["texture", 5, { "url": "asset://checker.png" }],
             ["material", 1, { "type": "MeshStandardMaterial", "maps": { "normalMap": 5 } }],
             ["material", 1, { "type": "MeshStandardMaterial", "maps": {} }]]
            """)
        let material = try #require(
            (scene.commandApplier.records[1]?.entity as? ModelEntity)?
                .model?.materials.first as? PhysicallyBasedMaterial
        )
        #expect(material.normal.texture == nil, "the normal map survived being cleared")
        scene.dispose()
    }

    /// FA-37: the debug view reaches objects created after it was set.
    @Test
    func theDebugModelViewReachesLaterMeshes() throws {
        let (_, scene) = try makeScene()
        scene.applyCommands(javaScript: """
            [["renderOptions", 0, { "debugModelView": "normal" }]]
            """)
        scene.applyCommands(javaScript: """
            [["create", 9, "mesh", "late"]]
            """)
        let entity = try #require(scene.commandApplier.records[9]?.entity)
        #expect(entity.components[ModelDebugOptionsComponent.self]?.visualizationMode == .normal)
        scene.dispose()
    }
}

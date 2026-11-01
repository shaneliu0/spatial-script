//
//  ScriptingTestScene.swift
//  RealityKitScripting
//
//  Created by Shane Liu on 9/9/26.
//

import Foundation
import RealityKit
@testable import SpatialScriptRuntime

/// One mounted scene, the way every suite here starts: the core loaded with a
/// script that mounts an empty Scene, reading assets from SPEC 3.5's shared
/// folder. Shared so the suites split by spec area do not each keep a copy.
@MainActor
enum ScriptingTestScene {
    static func make(_ body: String = "") throws -> (Entity, JavaScriptScene) {
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

    /// The same, with one box mesh as object id 1.
    static func makeWithMesh() throws -> (Entity, JavaScriptScene) {
        let (root, scene) = try make()
        scene.applyCommands(javaScript: """
            [
              ["create", 1, "mesh", "target"],
              ["geometry", 1, { "type": "BoxGeometry", "parameters": { "width": 1, "height": 1, "depth": 1 } },
                                null, null, null, null]
            ]
            """)
        return (root, scene)
    }
}

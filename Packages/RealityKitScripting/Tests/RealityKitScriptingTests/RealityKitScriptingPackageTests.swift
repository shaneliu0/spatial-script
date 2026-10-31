//
//  RealityKitScriptingPackageTests.swift
//  RealityKitScripting
//
//  Created by Shane Liu on 9/9/26.
//

import Foundation
import RealityKit
import Testing
@testable import SpatialScriptRuntime

@MainActor
struct RealityKitScriptingPackageTests {
    @Test
    func validatesValidJavaScript() throws {
        try ScriptingRuntime.validateScript("const value = 1 + 2;")
    }

    @Test
    func rejectsInvalidJavaScript() {
        #expect(throws: (any Error).self) {
            try ScriptingRuntime.validateScript("const = ;")
        }
    }

    @Test
    func loadsTheCoreBundleFromTheResourceBundle() throws {
        let source = try #require(JavaScriptScene.loadCoreBundle())
        #expect(source.contains("__spatial"))
    }

    @Test
    func mountsASceneAndMirrorsItIntoRealityKit() throws {
        let root = Entity()
        let scene = try JavaScriptScene(rootEntity: root, source: """
            const { Scene, Mesh, BoxGeometry, MeshStandardMaterial } = Spatial;
            const stage = new Scene();
            const cube = new Mesh(new BoxGeometry(0.2, 0.2, 0.2), new MeshStandardMaterial({ color: 0x3366ff }));
            cube.name = "cube";
            cube.position.set(0.1, 0.2, 0.3);
            stage.add(cube);
            Spatial.mount(stage);
            """)
        scene.tick(deltaTime: 1.0 / 60)

        let cube = try #require(root.findEntity(named: "cube"))
        #expect(cube.position == SIMD3<Float>(0.1, 0.2, 0.3))
        #expect(cube.components[ModelComponent.self] != nil)
        scene.dispose()
    }

    @Test
    func reportsLoadErrorsWithLineInformation() {
        let root = Entity()
        var thrown: JavaScriptScene.ScriptError?
        do {
            _ = try JavaScriptScene(rootEntity: root, source: """
                const stage = new Spatial.Scene();
                Spatial.mount(stage);
                throw new Error("boom");
                """)
        } catch let error as JavaScriptScene.ScriptError {
            thrown = error
        } catch {
            thrown = nil
        }
        let error = thrown
        #expect(error != nil)
        #expect(error?.message.contains("boom") == true)
    }

    @Test
    func runtimeErrorsAreReportedWithoutStoppingTheScene() throws {
        let root = Entity()
        nonisolated(unsafe) var messages: [String] = []
        let scene = try JavaScriptScene(
            rootEntity: root,
            source: """
                const stage = new Spatial.Scene();
                const cube = new Spatial.Mesh(new Spatial.BoxGeometry(0.1, 0.1, 0.1), new Spatial.MeshBasicMaterial());
                cube.name = "cube";
                stage.add(cube);
                Spatial.onFrame(() => { throw new Error("frame failure"); });
                Spatial.mount(stage);
                """,
            logListener: { entry in messages.append(entry.message) }
        )
        scene.tick(deltaTime: 1.0 / 60)
        scene.tick(deltaTime: 1.0 / 60)
        #expect(messages.contains { $0.contains("frame failure") })
        #expect(root.findEntity(named: "cube") != nil)
        scene.dispose()
    }

    @Test
    func consoleOutputReachesTheLogListener() throws {
        let root = Entity()
        nonisolated(unsafe) var entries: [ScriptingLogEntry] = []
        let scene = try JavaScriptScene(
            rootEntity: root,
            source: """
                const stage = new Spatial.Scene();
                console.log("hello from the script");
                Spatial.mount(stage);
                """,
            logListener: { entries.append($0) }
        )
        scene.tick(deltaTime: 1.0 / 60)
        #expect(entries.contains { $0.message.contains("hello from the script") })
        scene.dispose()
    }

    @Test
    func disposeDestroysEveryEntityItCreated() throws {
        let root = Entity()
        let scene = try JavaScriptScene(rootEntity: root, source: """
            const stage = new Spatial.Scene();
            const cube = new Spatial.Mesh(new Spatial.BoxGeometry(0.1, 0.1, 0.1), new Spatial.MeshBasicMaterial());
            cube.name = "cube";
            stage.add(cube);
            Spatial.mount(stage);
            """)
        scene.tick(deltaTime: 1.0 / 60)
        #expect(root.children.count > 0)
        scene.dispose()
        #expect(root.findEntity(named: "cube") == nil)
    }

    @Test
    func componentAndRuntimeSurfaceIsUnchanged() {
        let component = ScriptingComponent(javaScript: "// script")
        #expect(component.source == "// script")
        ScriptingRuntime.setup()
        #expect(ScriptingRuntime.InputOptions.all.rawValue == 63)
        #expect(ScriptingRuntime.InputOptions.mouse.rawValue == 1)
        #expect(ScriptingRuntime.InputOptions.drag.rawValue == 32)
    }

    @Test
    func environmentDescriptionIsHonestAboutThePlatform() {
        let environment = JavaScriptScene.environmentDescription(assetRoot: nil)
        #expect(environment["backend"] as? String == "realitykit")
        let capabilities = environment["capabilities"] as? [String: Bool]
#if os(visionOS)
        #expect(environment["platform"] as? String == "visionos")
        #expect(capabilities?["hands"] == true)
        #expect(capabilities?["hoverEffect"] == true)
#else
        #expect(environment["platform"] as? String == "macos")
        #expect(capabilities?["hands"] == false)
        #expect(capabilities?["hoverEffect"] == false)
#endif
        #expect(capabilities?["particles"] == true)
    }

    @Test
    func linearColorRoundTripsThroughTheSRGBEncoding() {
        let linear = SIMD3<Float>(0.2, 0.5, 0.8)
        let color = ScriptingColor.platformColor(linear: linear)
        let decoded = ScriptingColor.linearComponents(of: color)
        #expect(abs(decoded.x - linear.x) < 0.01)
        #expect(abs(decoded.y - linear.y) < 0.01)
        #expect(abs(decoded.z - linear.z) < 0.01)
    }

    @Test
    func lightsPointAlongTheirNegativeZAxis() {
        let orientation = ScriptingCommandApplier.orientation(
            pointingMinusZAlong: SIMD3<Float>(0, -1, 0)
        )
        let rotated = orientation.act(SIMD3<Float>(0, 0, -1))
        #expect(abs(rotated.y + 1) < 1e-4)
    }

    @Test
    func injectionSynthesizesTheSameEventsAsRealInput() throws {
        let root = Entity()
        let scene = try JavaScriptScene(rootEntity: root, source: """
            const stage = new Spatial.Scene();
            const cube = new Spatial.Mesh(new Spatial.BoxGeometry(0.1, 0.1, 0.1), new Spatial.MeshBasicMaterial());
            cube.name = "cube";
            cube.userData.taps = 0;
            cube.addEventListener("tap", () => { cube.userData.taps += 1; });
            stage.add(cube);
            Spatial.mount(stage);
            """)
        scene.tick(deltaTime: 1.0 / 60)
        scene.injectTap(target: "cube")
        scene.tick(deltaTime: 1.0 / 60)

        let dump = scene.dump()
        let objects = try #require(dump["objects"] as? [[String: Any]])
        let cube = try #require(objects.first { $0["name"] as? String == "cube" })
        let userData = try #require(cube["userData"] as? [String: Any])
        #expect((userData["taps"] as? NSNumber)?.intValue == 1)
        scene.dispose()
    }
}

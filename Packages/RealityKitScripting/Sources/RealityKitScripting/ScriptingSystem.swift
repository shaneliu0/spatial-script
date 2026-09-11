//
//  ScriptingSystem.swift
//  RealityKitScripting
//
//  Created by Shane Liu on 9/8/26.
//

import Foundation
import RealityKit

/// Drives every ``ScriptingComponent`` from the RealityKit update loop and hot
/// swaps a scene when its source changes on the same entity.
@MainActor
final class ScriptingSystem: System {
    private static let query = EntityQuery(where: .has(ScriptingComponent.self))

    private struct Entry {
        let componentID: ScriptingComponent.ID
        let scene: JavaScriptScene
    }

    private var entries: [ObjectIdentifier: Entry] = [:]
    private var failed: [ObjectIdentifier: ScriptingComponent.ID] = [:]

    required init(scene: RealityKit.Scene) {}

    /// The RealityKit scene can go away without the query ever emptying, so
    /// the system disposes whatever it still owns when it is deallocated.
    deinit {
        MainActor.assumeIsolated {
            for entry in entries.values { entry.scene.dispose() }
            entries.removeAll()
            // The RealityKit scene is going away with us, so nothing is left to
            // dereference the staged entities.
            ScriptingPhysicsGraveyard.shared.drain()
        }
    }

    func update(context: SceneUpdateContext) {
        // Retires entities whose joints were cleared on an earlier frame.
        ScriptingPhysicsGraveyard.shared.advance()
        ScriptingInputRouter.shared.beginFrame()
        var live: Set<ObjectIdentifier> = []

        for entity in context.entities(matching: Self.query, updatingSystemWhen: .rendering) {
            guard let component = entity.components[ScriptingComponent.self] else { continue }
            let key = ObjectIdentifier(entity)
            live.insert(key)

            if let existing = entries[key], existing.componentID != component.id {
                existing.scene.dispose()
                ScriptingRuntime.unregisterScene(for: entity)
                entries[key] = nil
                failed[key] = nil
            }

            if failed[key] == component.id { continue }

            let scene: JavaScriptScene
            if let existing = entries[key] {
                scene = existing.scene
            } else {
                do {
                    scene = try JavaScriptScene(
                        rootEntity: entity,
                        source: component.source,
                        assetRoot: ScriptingRuntime.assetRoot,
                        logListener: ScriptingRuntime.logListener
                    )
                    entries[key] = Entry(componentID: component.id, scene: scene)
                    ScriptingRuntime.register(scene: scene, for: entity)
                } catch {
                    ScriptingRuntime.reportLoadFailure(error, for: entity)
                    failed[key] = component.id
                    continue
                }
            }

            // The host can hold the scene at its last frame and pin the delta,
            // which is what the parity route needs for deterministic replay.
            scene.isPaused = ScriptingRuntime.isPaused
            scene.fixedDeltaTime = ScriptingRuntime.fixedDeltaTime
            scene.tick(deltaTime: context.deltaTime)

            // A scene the watchdog killed is beyond saving; drop it so the app
            // and the dev server keep running.
            if scene.isTerminated {
                scene.dispose()
                ScriptingRuntime.unregisterScene(for: entity)
                entries[key] = nil
                failed[key] = component.id
                // The push is waiting for a first frame that will never come.
                ScriptingRuntime.reportLoadFailure(
                    JavaScriptScene.ScriptError(
                        message: "The script was terminated for running past the execution limit.",
                        line: nil,
                        column: nil
                    ),
                    for: entity
                )
            }
        }

        for (key, entry) in entries where !live.contains(key) {
            entry.scene.dispose()
            entries[key] = nil
        }
        ScriptingRuntime.pruneScenes(keeping: live)
        failed = failed.filter { live.contains($0.key) }
    }
}

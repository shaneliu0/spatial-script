//
//  ScriptingCommandApplier+Components.swift
//  RealityKitScripting
//
//  Created by Shane Liu on 9/9/26.
//

import Foundation
import RealityKit

extension ScriptingCommandApplier {
    // MARK: - Scene understanding (SPEC 14.7)

    func applySceneUnderstanding(payload: [String: Any]?) {
        let spec = payload ?? [:]
        sceneUnderstandingSpec = spec
        let wanted = ["collision", "occlusion", "physics", "shadows"].filter { spec[$0] as? Bool == true }

#if os(visionOS)
        guard !wanted.isEmpty else {
            root.components.remove(SceneUnderstandingComponent.self)
            return
        }
        root.components.set(SceneUnderstandingComponent())
        // SPEC 14.7 and 14.13: a raycast against the real-world mesh reports id
        // 0 with `sceneUnderstanding: true`. RealityKit's own raycast does not
        // return the reconstruction, so this consumer never produces one.
        warnings.warnOnce(
            "Real-world hits are not reported: RealityKit's raycast does not return the scene "
                + "reconstruction mesh, so a raycast never yields the id 0 record SPEC 14.7 "
                + "describes. Collision and occlusion against the mesh still work.",
            key: "scene-understanding-raycast"
        )
        // RealityKit's component marks an entity as part of the reconstructed
        // scene; it carries no per-feature switches, which the system provides
        // through scene reconstruction itself. The flags stay in the dump.
        warnings.warnOnce(
            "SceneUnderstandingComponent has no per-feature options in RealityKit, so "
                + "\(wanted.sorted().joined(separator: ", ")) are recorded and the root is "
                + "marked for scene understanding, but the system decides what the real-world "
                + "mesh participates in.",
            key: "scene-understanding-options"
        )
#else
        guard !wanted.isEmpty else { return }
        // SPEC 12: that scene understanding is visionOS only is the core's line
        // (`core/src/runtime/scene-state.js:57`), so it is not repeated here.
        // SPEC 14.7: the flags are on, so the script may be expecting a hit on
        // the real world. There is none to give here either, and the obligation
        // to say so is on every backend, not only the one that has a mesh.
        warnings.warnOnce(
            "Raycasts will not see the real world here: RealityKit has no scene "
                + "reconstruction mesh on macOS, so no hit carries sceneUnderstanding.",
            key: "scene-understanding-raycast"
        )
#endif
    }

    // MARK: - Accessibility (SPEC 14.11)

    func applyAccessibility(id: Int, payload: [String: Any]?) {
        guard let record = records[id] else { return }
        guard let payload else {
            record.entity.components.remove(AccessibilityComponent.self)
            record.extras?.accessibility = nil
            return
        }
        record.makeExtras().accessibility = payload

        var component = AccessibilityComponent()
        component.isAccessibilityElement = true
        if let label = payload["label"] as? String, !label.isEmpty {
            component.label = LocalizedStringResource(stringLiteral: label)
        }
        if let value = payload["value"] as? String, !value.isEmpty {
            component.value = LocalizedStringResource(stringLiteral: value)
        }
        if let hint = payload["hint"] as? String, !hint.isEmpty {
            // RealityKit's component has no hint field, so the hint is carried
            // as custom content rather than dropped.
            component.customContent = [
                AccessibilityComponent.CustomContent(
                    label: LocalizedStringResource("Hint"),
                    value: LocalizedStringResource(stringLiteral: hint),
                    importance: .default
                ),
            ]
        }
        if payload["isButton"] as? Bool == true {
            component.systemActions = [.activate]
        }
        record.entity.components.set(component)
    }

    // MARK: - Render options (SPEC 14.11)

    func applyRenderOptions(payload: [String: Any]?) {
        guard let payload else { return }
        for (key, value) in payload { renderOptions[key] = value }

        if let adaptive = payload["adaptiveResolution"] as? Bool {
            applyAdaptiveResolution(adaptive)
        }
        if let exponent = Self.number(payload["environmentIntensityExponent"]) {
            applyEnvironmentLighting(intensityExponent: exponent)
        }
        if payload.keys.contains("debugModelView") {
            applyDebugModelView(payload["debugModelView"] as? String)
        }
    }

    private func applyAdaptiveResolution(_ enabled: Bool) {
#if os(visionOS)
        if enabled {
            root.components.set(AdaptiveResolutionComponent())
        } else {
            root.components.remove(AdaptiveResolutionComponent.self)
        }
#else
        // SPEC 12: the core warns once that adaptive resolution is visionOS only
        // (`core/src/runtime/scene-state.js:97`); the flag stays in the dump.
        _ = enabled
#endif
    }

    private func applyEnvironmentLighting(intensityExponent: Double) {
        // SPEC 8: the dump reports the value the script set on every platform,
        // whatever this one does with it.
        environmentIntensityExponent = Float(intensityExponent)
#if os(visionOS)
        // The weight is linear where the script's value is an exponent, which
        // is how every other intensity in this API is expressed.
        root.components.set(
            EnvironmentLightingConfigurationComponent(
                environmentLightingWeight: Float(pow(2.0, intensityExponent))
            )
        )
#else
        // macOS has no passthrough to blend with, so SPEC 14.11's fallback is
        // to scale the ambient environment the scene already has.
        refreshImageBasedLight()
#endif
    }

    /// SPEC 14.11: the mode is scene-wide, so an object created after it was
    /// set carries it too. The core re-emits `renderOptions` only on change.
    func applyDebugModelView(to record: Record) {
        guard record.kind == .mesh || record.kind == .asset else { return }
        guard let mode = renderOptions["debugModelView"] as? String,
              let visualization = Self.debugVisualization(mode) else { return }
        record.entity.components.set(ModelDebugOptionsComponent(visualizationMode: visualization))
    }

    private func applyDebugModelView(_ mode: String?) {
        guard let mode, !mode.isEmpty, mode != "null" else {
            for record in records.values {
                record.entity.components.remove(ModelDebugOptionsComponent.self)
            }
            return
        }
        guard let visualization = Self.debugVisualization(mode) else {
            warnings.warnOnce(
                "debug.modelView '\(mode)' is not a mode RealityKit draws and was ignored.",
                key: "debug-model-view-\(mode)"
            )
            return
        }
        for record in records.values where record.kind == .mesh || record.kind == .asset {
            record.entity.components.set(ModelDebugOptionsComponent(visualizationMode: visualization))
        }
    }

    static func debugVisualization(_ mode: String) -> ModelDebugOptionsComponent.VisualizationMode? {
        switch mode {
        case "normal": .normal
        case "uv": .textureCoordinates
        case "baseColor": .baseColor
        case "roughness": .roughness
        case "metallic": .metallic
        case "occlusion": .ambientOcclusion
        case "emissive": .emissive
        default: nil
        }
    }
}

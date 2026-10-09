//
//  ScriptingNativeDump+Phase2.swift
//  RealityKitScripting
//
//  Created by Shane Liu on 9/9/26.
//

import Foundation
import RealityKit

extension ScriptingCommandApplier {
    /// SPEC 14.14: the phase 2 fields for one object's native dump entry.
    /// Only the sections an object actually has are added, so an ordinary mesh
    /// costs nothing.
    func phase2Dump(_ record: Record) -> [String: Any] {
        var result: [String: Any] = [:]

        if let audio = record.extras?.audio {
            result["audio"] = [
                "url": audio.url.isEmpty ? NSNull() : audio.url as Any,
                "playing": audio.isPlaying,
                "loop": audio.loop,
                "volume": audio.volume,
                "rate": audio.rate,
                "currentTime": audio.currentTime,
                "duration": audio.duration,
                "group": audio.group,
                "spatial": audio.spatial,
                "ambient": audio.ambient,
                "refDistance": audio.refDistance,
                "rolloff": audio.rolloff,
                "distanceModel": audio.distanceModel,
                "cone": audio.cone.map { [$0.x, $0.y, $0.z] } as Any? ?? NSNull(),
                "reverbLevel": audio.reverbLevel,
                "component": Self.audioComponentName(record.entity) as Any? ?? NSNull(),
                "loaded": audio.resource != nil,
            ]
        }

        if let video = record.extras?.video {
            result["video"] = [
                "url": video.reportedURL as Any? ?? NSNull(),
                "playing": video.isPlaying,
                "loop": video.loop,
                "muted": video.muted,
                "autoplay": video.autoplay,
                "volume": video.volume,
                "rate": video.rate,
                "currentTime": video.currentTime,
                "duration": video.duration,
                "docking": video.docking,
                "error": video.errorMessage as Any? ?? NSNull(),
                "width": video.width as Any? ?? NSNull(),
                "height": video.height as Any? ?? NSNull(),
                "component": video.surface?.components[VideoPlayerComponent.self] != nil,
            ]
        }

        if let character = record.extras?.character {
            result["characterController"] = [
                "radius": character.radius,
                "height": character.height,
                "slopeLimit": character.slopeLimit,
                "stepLimit": character.stepLimit,
                "gravity": character.gravity,
                "isOnGround": character.isOnGround,
                "velocity": [character.velocity.x, character.velocity.y, character.velocity.z],
                "component": record.entity.components[CharacterControllerComponent.self] != nil,
            ]
        }

        if let field = record.extras?.forceField {
            // SPEC 14.13 reports the field the script described, so the spec
            // itself is the dump and the consumer only adds what it did with it.
            var entry = field.spec
            entry["kind"] = field.kind
            entry["enabled"] = field.enabled
            entry["applied"] = field.applied
            entry["component"] = record.entity.components[ForceEffectComponent.self] != nil
            result["forceField"] = entry
        }

        if let skeleton = record.extras?.skeleton {
            // SPEC 14.13: `skeleton` is null when the asset has no rig, and a
            // map of joint name to transform when it has one.
            let joints = currentJointTransforms(skeleton)
            result["skeleton"] = joints.isEmpty
                ? NSNull()
                : [
                    "joints": joints,
                    "track": skeleton.track,
                    "component": skeleton.poseEntity != nil,
                    "animationOverrides": skeleton.animationOverrides,
                ] as [String: Any]
            result["blendShapes"] = currentBlendShapeWeights(skeleton)
        }

        if let accessibility = record.extras?.accessibility {
            var entry = accessibility
            entry["component"] = record.entity.components[AccessibilityComponent.self] != nil
            result["accessibility"] = entry
        }

        if let shader = record.extras?.shaderGraph {
            result["shaderGraph"] = [
                "source": shader.source,
                "name": shader.name,
                "parameters": shader.parameters,
                "loaded": shader.loaded,
                "error": shader.loadError as Any? ?? NSNull(),
            ]
        }

        if let specs = record.materialSpecs {
            result["materialCount"] = specs.count
        }

        if let debug = record.entity.components[ModelDebugOptionsComponent.self] {
            result["debugModelView"] = debug.visualizationMode.rawValue
        }

        return result
    }

    /// The pose RealityKit is actually holding, keyed by the names a script
    /// uses. Falls back to what was asked for while an asset is still loading.
    private func currentJointTransforms(_ state: ScriptingSkeletonState) -> [String: [Float]] {
        guard let entity = state.poseEntity,
              let pose = entity.components[SkeletalPosesComponent.self]?.poses.default else {
            // Without a native pose the rig is whatever the consumer was told
            // it has, at rest except where the script posed it.
            var joints: [String: [Float]] = [:]
            for name in state.jointNames { joints[name] = [0, 0, 0, 0, 0, 0, 1] }
            for (name, value) in state.pendingJoints {
                joints[name] = [
                    value.0.x, value.0.y, value.0.z,
                    value.1.imag.x, value.1.imag.y, value.1.imag.z, value.1.real,
                ]
            }
            return joints
        }
        let names = ScriptingCommandApplier.jointDisplayNames(pose.jointNames)
        var joints: [String: [Float]] = [:]
        for (index, path) in pose.jointNames.enumerated() {
            guard let transform = pose[path] else { continue }
            let name = names.indices.contains(index) ? names[index] : path
            joints[name] = [
                transform.translation.x, transform.translation.y, transform.translation.z,
                transform.rotation.imag.x, transform.rotation.imag.y, transform.rotation.imag.z,
                transform.rotation.real,
            ]
        }
        return joints
    }

    private func currentBlendShapeWeights(_ state: ScriptingSkeletonState) -> [String: Float] {
        guard let entity = state.blendShapeEntity,
              let set = entity.components[BlendShapeWeightsComponent.self]?.weightSet.default else {
            return state.pendingWeights
        }
        var weights: [String: Float] = [:]
        for (index, name) in set.weightNames.enumerated()
        where set.weights.indices.contains(index) {
            weights[name] = set.weights[index]
        }
        return weights
    }

    private static func audioComponentName(_ entity: Entity) -> String? {
        if entity.components[SpatialAudioComponent.self] != nil { return "SpatialAudioComponent" }
        if entity.components[AmbientAudioComponent.self] != nil { return "AmbientAudioComponent" }
        if entity.components[ChannelAudioComponent.self] != nil { return "ChannelAudioComponent" }
        return nil
    }

    /// The scene-level phase 2 sections of the native dump.
    func phase2SceneDump(isActive: Bool) -> [String: Any] {
        // SPEC 14.13's dump additions, under the names the core uses.
        var result: [String: Any] = [
            "isActive": isActive,
            "camera": cameraSpec as Any? ?? NSNull(),
            "sceneUnderstanding": sceneUnderstandingSpec,
            "render": renderOptions,
            "environmentLighting": ["intensityExponent": Double(environmentIntensityExponent)],
            "debug": ["modelView": renderOptions["debugModelView"] as Any? ?? NSNull()],
            "controllers": ScriptingInputRouter.shared.controllerSnapshot(),
            "audioMixer": [
                "masterVolume": audioMasterVolume,
                "groups": audioGroupVolumes,
                "state": didReportAudioRunning ? "running" : "suspended",
                "component": root.components[AudioMixGroupsComponent.self] != nil,
            ],
            "hostFunctions": ScriptingRuntime.hostFunctionNames,
        ]
#if os(visionOS)
        result["sceneUnderstandingComponent"] = root.components[SceneUnderstandingComponent.self] != nil
        result["adaptiveResolutionComponent"] = root.components[AdaptiveResolutionComponent.self] != nil
        result["environmentLightingComponent"] =
            root.components[EnvironmentLightingConfigurationComponent.self] != nil
#else
        result["sceneUnderstandingComponent"] = false
        result["adaptiveResolutionComponent"] = false
        result["environmentLightingComponent"] = false
#endif
        return result
    }
}

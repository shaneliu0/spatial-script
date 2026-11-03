//
//  ScriptingNativeDump+Phase2.swift
//  SpatialScriptRuntime
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
            ]
        }

        if let character = record.extras?.character {
            result["characterController"] = [
                "radius": character.radius,
                "height": character.height,
                "slopeLimit": character.slopeLimit,
                "stepLimit": character.stepLimit,
                "gravity": character.gravity,
            ]
            // SPEC 8: the motion belongs to the object, beside a rigid body's.
            result["isOnGround"] = character.isOnGround
            result["velocity"] = [character.velocity.x, character.velocity.y, character.velocity.z]
        }

        if let field = record.extras?.forceField {
            // SPEC 14.13 reports the field the script described, so the spec
            // itself is the dump and the consumer only adds what it did with it.
            var entry = field.spec
            entry["kind"] = field.kind
            entry["enabled"] = field.enabled
            result["forceField"] = entry
        }

        if let skeleton = record.extras?.skeleton {
            // SPEC 14.13: `skeleton` is null when the asset has no rig, and a
            // map of joint name to transform when it has one.
            // SPEC 8: `{ joints, track }`, where `joints` holds the poses that
            // were actually set — the core reports the ones the script posed,
            // not every joint the rig has — and `blendShapes` the weights that
            // were set. Null when the asset has no rig at all.
            let joints = posedJointTransforms(skeleton)
            result["skeleton"] = skeleton.jointNames.isEmpty
                ? NSNull()
                : ["joints": joints, "track": skeleton.track] as [String: Any]
            result["blendShapes"] = setBlendShapeWeights(skeleton)
        }

        if let accessibility = record.extras?.accessibility {
            result["accessibility"] = accessibility
        }

        // SPEC 8's shape rule leaves no room for extra per-object keys: a
        // shader graph reports itself inside `material` the way the core does,
        // how many material slots a mesh draws is visible in `material` itself,
        // and the debug visualisation is a component name.
        return result
    }

    /// The joints a pose was actually set on, read back off the rig where
    /// RealityKit holds one and from what was applied while it is still
    /// loading. The core reports the joints the script posed, so an untouched
    /// joint appears in neither dump.
    private func posedJointTransforms(_ state: ScriptingSkeletonState) -> [String: [Float]] {
        let posed = Set(state.pendingJoints.keys)
        guard let entity = state.poseEntity,
              let pose = entity.components[SkeletalPosesComponent.self]?.poses.default else {
            var joints: [String: [Float]] = [:]
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
            guard posed.contains(name) else { continue }
            joints[name] = [
                transform.translation.x, transform.translation.y, transform.translation.z,
                transform.rotation.imag.x, transform.rotation.imag.y, transform.rotation.imag.z,
                transform.rotation.real,
            ]
        }
        return joints
    }

    /// The weights that were set, which is what the core's `BlendShapes.toJSON`
    /// reports: a shape nobody touched is in neither dump.
    private func setBlendShapeWeights(_ state: ScriptingSkeletonState) -> [String: Float] {
        let set = Set(state.pendingWeights.keys)
        guard let entity = state.blendShapeEntity,
              let weightSet = entity.components[BlendShapeWeightsComponent.self]?.weightSet.default else {
            return state.pendingWeights
        }
        var weights: [String: Float] = [:]
        for (index, name) in weightSet.weightNames.enumerated()
        where weightSet.weights.indices.contains(index) && set.contains(name) {
            weights[name] = weightSet.weights[index]
        }
        return weights
    }

    /// The scene-level phase 2 sections of the native dump.
    func phase2SceneDump(isActive: Bool) -> [String: Any] {
        // SPEC 14.13's dump additions, under the names the core uses.
        // SPEC 8: exactly the core's key set, with the core's defaults where
        // this platform has no notion of the field. The scene block itself may
        // only add `childCount`, so which RealityKit components the root ended
        // up carrying is not reported here at all; the tests assert those on
        // the root entity, where they actually live.
        let result: [String: Any] = [
            "isActive": isActive,
            "camera": cameraSpec as Any? ?? NSNull(),
            "sceneUnderstanding": [
                "occlusion": sceneUnderstandingSpec["occlusion"] as? Bool ?? false,
                "collision": sceneUnderstandingSpec["collision"] as? Bool ?? false,
                "physics": sceneUnderstandingSpec["physics"] as? Bool ?? false,
                "shadows": sceneUnderstandingSpec["shadows"] as? Bool ?? false,
            ],
            "render": ["adaptiveResolution": renderOptions["adaptiveResolution"] as? Bool ?? false],
            "environmentLighting": ["intensityExponent": Double(environmentIntensityExponent)],
            "debug": ["modelView": renderOptions["debugModelView"] as Any? ?? NSNull()],
            "controllers": ScriptingInputRouter.shared.controllerSnapshot(),
            "audioMixer": [
                "masterVolume": audioMasterVolume,
                "groups": audioGroupVolumes,
                "state": didReportAudioRunning ? "running" : "suspended",
            ],
            "hostFunctions": ScriptingRuntime.hostFunctionNames,
        ]
        return result
    }
}

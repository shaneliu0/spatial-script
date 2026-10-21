//
//  ScriptingCommandApplier+Phase2.swift
//  RealityKitScripting
//
//  Created by Shane Liu on 9/9/26.
//

import CoreGraphics
import Foundation
import JavaScriptCore
import RealityKit

extension ScriptingCommandApplier {
    /// Follows an event the host pushed into the core, so the native dump
    /// agrees with what the core was told about media this consumer never
    /// opened (a harness-driven `ended`, `error` or `loaded`).
    func adopt(event: String, id: Int, payload: [String: Any]?) {
        guard let record = records[id] else { return }
        switch event {
        case "ended":
            if let audio = record.extras?.audio {
                audio.isPlaying = false
                audio.wantsPlay = false
                audio.endedExternally = true
                if audio.duration > 0 { audio.currentTime = audio.duration }
            }
            if let video = record.extras?.video {
                video.isPlaying = false
                video.wantsPlay = false
                if video.duration > 0 { video.currentTime = video.duration }
            }

        case "error":
            let message = payload?["message"] as? String
            if let video = record.extras?.video {
                video.errorMessage = message ?? "the video failed to load"
                video.isPlaying = false
                video.wantsPlay = false
            }
            if let audio = record.extras?.audio {
                audio.loadFailed = true
                audio.isPlaying = false
                audio.wantsPlay = false
            }

        case "assetLoaded":
            // A harness can hand the consumer a rig the loader never saw, and
            // SPEC 14.13's dump has to report it either way.
            let state = skeletonState(for: record)
            if let joints = payload?["joints"] as? [String], !joints.isEmpty {
                state.jointNames = joints
                if state.jointPaths.isEmpty { state.jointPaths = joints }
            }
            if let shapes = payload?["blendShapes"] as? [String], !shapes.isEmpty {
                state.blendShapeNames = shapes
            }

        case "loaded":
            guard let video = record.extras?.video else { return }
            if let duration = Self.number(payload?["duration"]) { video.duration = duration }
            if let width = Self.number(payload?["width"]), let height = Self.number(payload?["height"]),
               width > 0, height > 0 {
                video.presentationSize = CGSize(width: width, height: height)
                refreshVideoPlane(record: record, state: video)
            }
            video.errorMessage = nil

        default:
            break
        }
    }

    /// SPEC 14.13. Returns false for an opcode this consumer does not know, so
    /// the phase 1 switch can still report it as unknown exactly once.
    func applyPhase2(
        command: JavaScriptArrayReader,
        opcode: String,
        id: Int,
        in context: JSContext
    ) -> Bool {
        switch opcode {
        case "audio":
            applyAudio(id: id, payload: command.dictionary(2, in: context))

        case "audioControl":
            applyAudioControl(
                id: id,
                action: command.string(2) ?? "",
                value: command.optionalDouble(3)
            )

        case "audioMixer":
            applyAudioMixer(payload: command.dictionary(2, in: context))

        case "video":
            applyVideo(id: id, payload: command.dictionary(2, in: context))

        case "videoControl":
            applyVideoControl(
                id: id,
                action: command.string(2) ?? "",
                value: command.optionalDouble(3)
            )

        case "camera":
            // SPEC 14.13: the second element is the camera object's own id.
            applyCamera(id: id, payload: command.dictionary(2, in: context))

        case "characterController":
            applyCharacterController(id: id, payload: command.dictionary(2, in: context))

        case "characterMove":
            applyCharacterMove(
                id: id,
                delta: SIMD3<Float>(
                    Float(command.double(2)),
                    Float(command.double(3)),
                    Float(command.double(4))
                )
            )

        case "characterTeleport":
            applyCharacterTeleport(
                id: id,
                position: SIMD3<Float>(
                    Float(command.double(2)),
                    Float(command.double(3)),
                    Float(command.double(4))
                )
            )

        case "forceField":
            applyForceField(id: id, payload: command.dictionary(2, in: context))

        case "skeleton":
            applySkeleton(id: id, payload: command.dictionary(2, in: context))

        case "blendShapes":
            applyBlendShapes(id: id, payload: command.dictionary(2, in: context))

        case "shaderParameter":
            // SPEC 14.13: the trailing element selects the slot on a mesh that
            // carries a material per part.
            applyShaderParameter(
                id: id,
                name: command.string(2) ?? "",
                value: command.any(3, in: context),
                materialIndex: command.optionalDouble(4).map { Int($0) } ?? 0
            )

        case "sceneUnderstanding":
            applySceneUnderstanding(payload: command.dictionary(2, in: context))

        case "accessibility":
            applyAccessibility(id: id, payload: command.dictionary(2, in: context))

        case "renderOptions":
            applyRenderOptions(payload: command.dictionary(2, in: context))

        case "hostEvent":
            hostEvent?(command.string(2) ?? "", command.dictionary(3, in: context))

        case "hostCall":
            hostCall?(id, command.string(2) ?? "", command.dictionary(3, in: context))

        case "fetch":
            hostFetch?(id, command.dictionary(2, in: context))

        case "controllerRumble", "rumble":
            // SPEC 14.13: `["controllerRumble", 0, controllerId, intensity,
            // duration]`. `rumble` is the older spelling and is still taken.
            let controller = command.string(2) ?? ""
            let played = ScriptingGameControllerHub.shared.rumble(
                id: controller,
                intensity: command.double(3),
                duration: command.double(4)
            )
            if !played {
                // SPEC 14.8 says "where supported", which is exactly the case
                // that owes a warning rather than silence.
                warnings.warnOnce(
                    "Controller '\(controller)' has no haptics on this system, so rumble did "
                        + "nothing. It is still reported in the dump.",
                    key: "controller-rumble-\(controller)"
                )
            }

        default:
            return false
        }
        return true
    }
}

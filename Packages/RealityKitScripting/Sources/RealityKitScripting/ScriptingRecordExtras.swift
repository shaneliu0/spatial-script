//
//  ScriptingRecordExtras.swift
//  RealityKitScripting
//
//  Created by Shane Liu on 9/9/26.
//

import AVFoundation
import Foundation
import RealityKit

/// Phase 2 state for one scripted object.
///
/// Kept behind a single optional reference on ``ScriptingCommandApplier/Record``
/// so a scene of ten thousand plain meshes pays one pointer per object rather
/// than a dozen unused fields.
@MainActor
final class ScriptingRecordExtras {
    var audio: ScriptingAudioState?
    var video: ScriptingVideoState?
    var character: ScriptingCharacterState?
    var forceField: ScriptingForceFieldState?
    var skeleton: ScriptingSkeletonState?
    var accessibility: [String: Any]?
    var shaderGraph: ScriptingShaderGraphState?
}

/// SPEC 14.1. Playback position is tracked here rather than read back from
/// `AudioPlaybackController`, whose only position accessor is underscored:
/// the value the core sees is advanced from the frame delta, seeded by `seek`
/// and cleared by `stop`, which also makes a parity replay deterministic.
@MainActor
final class ScriptingAudioState {
    var url = ""
    var spatial = false
    var ambient = false
    var loop = false
    var volume: Double = 1
    var rate: Double = 1
    var group = "master"
    var refDistance: Double = 1
    var rolloff: Double = 1
    var distanceModel = "inverse"
    /// inner angle, outer angle (radians), outer gain (0..1).
    var cone: SIMD3<Double>?
    var reverbLevel: Double = 0

    var resource: AudioFileResource?
    var controller: AudioPlaybackController?
    var isPlaying = false
    /// Set by `audioControl play` before the resource has finished loading.
    var wantsPlay = false
    var currentTime: Double = 0
    var duration: Double = 0
    var loadFailed = false
    /// Set when the host reported this sound finished. A `play` the core had
    /// already queued before that does not un-finish it; a seek, a stop or a
    /// new url clears it.
    var endedExternally = false
    /// Which audio component is on the entity, so a property change edits it
    /// in place rather than replacing it under the playback controller.
    var componentKind: ComponentKind = .none

    enum ComponentKind: Equatable {
        case none
        case channel
        case spatial
        case ambient

        init(spatial: Bool, ambient: Bool) {
            if spatial { self = .spatial } else if ambient { self = .ambient } else { self = .channel }
        }
    }

    /// Bumped for every load so a slow one that finishes late is dropped.
    var loadToken = 0
    /// The (url, loop, group) triple the current resource was built for.
    var loadedSignature: String?
}

/// SPEC 14.2.
@MainActor
final class ScriptingVideoState {
    var url = ""
    var width: Double?
    var height: Double?
    var loop = false
    var muted = false
    var autoplay = false
    var docking = false
    var volume: Double = 1
    var rate: Double = 1

    var player: AVPlayer?
    var isPlaying = false
    /// What the script asked for, which is what `syncVideo` reports.
    var wantsPlay = false
    /// The URL the player was opened for, so a property change does not
    /// rebuild the player and lose the script's playback intent.
    var openedURL: String?
    /// Set when `url` named only encodings this backend cannot play, so the
    /// error names them.
    var unplayableEncodings: [String]?
    /// What the script asked for, which is what the dump reports: a string, an
    /// encoding set, or nothing at all.
    var reportedURL: Any?
    /// The last `error` event's message, for the dump.
    var errorMessage: String?
    /// Child entity carrying `VideoPlayerComponent`. RealityKit draws its own
    /// surface at a size it chooses, so the scale that makes it the size the
    /// script asked for lives here rather than on the object itself.
    var surface: Entity?
    /// The material the picture is drawn with, on the object's own plane.
    var material: VideoMaterial?
    var currentTime: Double = 0
    var duration: Double = 0
    var presentationSize: CGSize?
    var didReportLoaded = false
    var loadFailed = false
    var endObserver: (any NSObjectProtocol)?
    var loadToken = 0
}

/// SPEC 14.4, character half.
@MainActor
final class ScriptingCharacterState {
    var radius: Float = 0.2
    var height: Float = 1
    var slopeLimit: Float = 0.785
    var stepLimit: Float = 0.3
    var gravity = true

    /// Displacement queued by `characterMove`, consumed by the next frame.
    var pendingMove: SIMD3<Float> = .zero
    var hasPendingMove = false
    var isOnGround = false
    var velocity: SIMD3<Float> = .zero
    var previousPosition: SIMD3<Float>?
    /// Downward speed carried between frames when the controller applies
    /// gravity itself.
    var fallSpeed: Float = 0
}

/// SPEC 14.4, force effect half.
@MainActor
final class ScriptingForceFieldState {
    var kind = ""
    var enabled = true
    var spec: [String: Any] = [:]
    /// False when this platform has no matching RealityKit effect.
    var applied = false
}

/// SPEC 14.5.
@MainActor
final class ScriptingSkeletonState {
    var track = false
    /// Entity carrying `SkeletalPosesComponent`, found under the loaded asset.
    weak var poseEntity: Entity?
    weak var blendShapeEntity: Entity?
    var jointNames: [String] = []
    /// The paths RealityKit stores the joints under, which a USD rig spells
    /// as `root/head` where the script says `head`.
    var jointPaths: [String] = []
    var blendShapeNames: [String] = []
    /// Joint edits the script asked for, replayed after an asset finishes.
    var pendingJoints: [String: (SIMD3<Float>, simd_quatf)] = [:]
    var pendingWeights: [String: Float] = [:]
    var animationOverrides = false
}

/// SPEC 14.6.
@MainActor
final class ScriptingShaderGraphState {
    var source = ""
    var name = ""
    var parameters: [String: Any] = [:]
    var loaded = false
    var loadError: String?
    var loadToken = 0
    /// Parameter writes since the material was declared, which is what the
    /// dump reports so a harness can see an update land.
    var generation = 0
}

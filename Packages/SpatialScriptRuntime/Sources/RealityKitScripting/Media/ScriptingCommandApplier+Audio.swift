//
//  ScriptingCommandApplier+Audio.swift
//  RealityKitScripting
//
//  Created by Shane Liu on 9/9/26.
//

import Foundation
import RealityKit

extension ScriptingCommandApplier {
    // MARK: - Opcodes

    /// SPEC 14.1. `null` releases the sound and its components.
    func applyAudio(id: Int, payload: [String: Any]?) {
        guard let record = records[id] else { return }
        guard let payload else {
            releaseAudio(on: record)
            return
        }
        let state = record.makeExtras().audio ?? {
            let created = ScriptingAudioState()
            record.makeExtras().audio = created
            return created
        }()

        state.url = payload["url"] as? String ?? state.url
        state.spatial = payload["spatial"] as? Bool ?? state.spatial
        state.ambient = payload["ambient"] as? Bool ?? state.ambient
        state.loop = payload["loop"] as? Bool ?? state.loop
        state.volume = Self.number(payload["volume"]) ?? state.volume
        state.rate = Self.number(payload["rate"]) ?? state.rate
        state.group = payload["group"] as? String ?? state.group
        state.refDistance = Self.number(payload["refDistance"]) ?? state.refDistance
        state.rolloff = Self.number(payload["rolloff"]) ?? state.rolloff
        state.distanceModel = payload["distanceModel"] as? String ?? state.distanceModel
        state.reverbLevel = Self.number(payload["reverbLevel"]) ?? state.reverbLevel
        if payload["cone"] is NSNull {
            state.cone = nil
        } else if let cone = payload["cone"] as? [Any], cone.count >= 3 {
            state.cone = SIMD3(
                Self.number(cone[0]) ?? 0,
                Self.number(cone[1]) ?? 0,
                Self.number(cone[2]) ?? 0
            )
        }

        refreshAudioComponents(record: record, state: state)
        loadAudioIfNeeded(record: record, state: state)
    }

    /// SPEC 14.13 `audioControl`.
    func applyAudioControl(id: Int, action: String, value: Double?) {
        guard let record = records[id] else { return }
        // A control can reach the consumer before the payload that configures
        // the sound, so the intent is recorded either way and applied when the
        // resource arrives. The video side already worked this way.
        let state = record.extras?.audio ?? {
            let created = ScriptingAudioState()
            record.makeExtras().audio = created
            return created
        }()
        switch action {
        case "play":
            state.wantsPlay = true
            // A sound with no resource still reports the state the script
            // asked for; nothing is pushed to the core for it either way.
            if !state.endedExternally { state.isPlaying = true }
            if let controller = state.controller {
                if state.currentTime >= state.duration, state.duration > 0 { state.currentTime = 0 }
                controller.speed = state.rate
                controller.play()
                state.isPlaying = true
                reportAudioEngineRunning()
            }

        case "pause":
            state.wantsPlay = false
            state.controller?.pause()
            state.isPlaying = false

        case "stop":
            state.endedExternally = false
            state.wantsPlay = false
            state.controller?.stop()
            state.isPlaying = false
            state.currentTime = 0

        case "seek":
            state.endedExternally = false
            let target = max(0, value ?? 0)
            state.currentTime = state.duration > 0 ? min(target, state.duration) : target
            state.controller?.seek(to: .seconds(state.currentTime))

        default:
            warnings.warnOnce(
                "audioControl '\(action)' is not a known action and was ignored.",
                key: "audio-control-\(action)"
            )
        }
    }

    /// SPEC 14.13: the core starts at `"suspended"` on every backend and only
    /// leaves it when a consumer says otherwise. RealityKit needs no user
    /// gesture, so the first sound that actually starts is the moment to say so.
    func reportAudioEngineRunning() {
        guard !didReportAudioRunning else { return }
        didReportAudioRunning = true
        dispatch?("audioState", 0, ["state": "running"])
    }

    /// SPEC 14.13 `audioMixer`. Group gains go through `AudioMixGroupsComponent`
    /// on the root; the per-sound gain stays the object's own volume, so the
    /// two layers multiply exactly once.
    func applyAudioMixer(payload: [String: Any]?) {
        guard let payload else { return }
        if let master = Self.number(payload["masterVolume"]) {
            audioMasterVolume = max(0, min(1, master))
        }
        if let groups = payload["groups"] as? [String: Any] {
            for (name, value) in groups {
                guard let volume = Self.number(value) else { continue }
                audioGroupVolumes[name] = max(0, min(1, volume))
            }
        }
        rebuildAudioMixGroups()
    }

    // MARK: - Components

    private func refreshAudioComponents(record: ScriptingCommandApplier.Record, state: ScriptingAudioState) {
        let entity = record.entity
        let gain = Self.decibels(state.volume)

        // The controller was minted against the component that is on the
        // entity now, so a volume or cone change mid-playback edits that
        // component in place. Only a change of class (spatial to ambient, say)
        // may swap it, and that is the case where a restart is unavoidable.
        let wanted = ScriptingAudioState.ComponentKind(spatial: state.spatial, ambient: state.ambient)
        if wanted != state.componentKind {
            entity.components.remove(SpatialAudioComponent.self)
            entity.components.remove(AmbientAudioComponent.self)
            entity.components.remove(ChannelAudioComponent.self)
            state.componentKind = wanted
        }

        if state.spatial {
            var component = entity.components[SpatialAudioComponent.self] ?? SpatialAudioComponent(gain: gain)
            component.gain = gain
            component.reverbLevel = state.reverbLevel
            if let cone = state.cone {
                component.directivity = .beam(focus: Self.beamFocus(innerAngleDegrees: cone.x))
                if !didWarnAudioCone, cone.z > 0 {
                    didWarnAudioCone = true
                    warnings.warnOnce(
                        "RealityKit models directivity as a single beam focus, so the cone's "
                            + "outer angle and outer gain are kept in the dump but only the inner "
                            + "angle shapes the sound.",
                        key: "audio-cone"
                    )
                }
            }
            // RealityKit's attenuation is a single rolloff factor with no
            // reference distance, so SPEC 14.1's refDistance is folded in: a
            // sound that stays loud for longer rolls off more slowly.
            let reference = max(0.0001, state.refDistance)
            component.distanceAttenuation = .rolloff(factor: max(0, state.rolloff / reference))
            if abs(state.refDistance - 1) > 1e-6 {
                warnings.warnOnce(
                    "RealityKit's spatial audio has no reference distance, so refDistance "
                        + "\(state.refDistance) is folded into the rolloff factor rather than "
                        + "applied as its own term.",
                    key: "audio-ref-distance"
                )
            }
            if state.distanceModel != "inverse" {
                warnings.warnOnce(
                    "RealityKit only has an inverse distance model, so distanceModel "
                        + "'\(state.distanceModel)' is kept in the dump but not applied.",
                    key: "audio-distance-model"
                )
            }
            entity.components.set(component)
        } else if state.ambient {
            var component = entity.components[AmbientAudioComponent.self] ?? AmbientAudioComponent(gain: gain)
            component.gain = gain
            entity.components.set(component)
        } else {
            var component = entity.components[ChannelAudioComponent.self] ?? ChannelAudioComponent(gain: gain)
            component.gain = gain
            entity.components.set(component)
        }

        state.controller?.gain = gain
        state.controller?.speed = state.rate
    }

    /// Loads (or reloads) the file behind a sound. Looping and the mix group
    /// are baked into `AudioFileResource.Configuration`, so a change to either
    /// has to build a new resource.
    private func loadAudioIfNeeded(record: ScriptingCommandApplier.Record, state: ScriptingAudioState) {
        let signature = "\(state.url)|\(state.loop)|\(state.group)"
        guard signature != state.loadedSignature else { return }
        guard !state.url.isEmpty else { return }
        state.loadedSignature = signature
        state.loadFailed = false
        state.endedExternally = false
        state.controller?.stop()
        state.controller = nil
        state.resource = nil
        state.duration = 0

        state.loadToken += 1
        let token = state.loadToken
        let generation = loadGeneration
        let url = state.url
        let configuration = AudioFileResource.Configuration(
            shouldLoop: state.loop,
            mixGroupName: state.group
        )

        guard let resolved = ScriptingResourceURL.resolve(url, assetDirectory: assetDirectory) else {
            failAudio(record: record, state: state, message: ScriptingResourceURL.failure(for: url))
            return
        }

        if let file = resolved.localFile(extensions: ["wav", "m4a", "mp3", "aiff", "caf", "aac"], assetDirectory: assetDirectory) {
            do {
                let resource = try AudioFileResource.load(contentsOf: file, configuration: configuration)
                finishAudioLoad(record: record, state: state, resource: resource, token: token)
            } catch {
                failAudio(
                    record: record,
                    state: state,
                    message: "audio '\(url)' failed to load: \(error.localizedDescription)"
                )
            }
            return
        }

        guard let remote = resolved.remoteURL else {
            failAudio(record: record, state: state, message: ScriptingResourceURL.failure(for: url))
            return
        }

        // RealityKit only loads audio from a file, so a remote sound is
        // downloaded to a temporary file first.
        let loadToken = beginLoad(url)
        Task { [weak self] in
            let downloaded = await ScriptingDownload.file(from: remote, preferredExtension: "wav")
            guard let self else { return }
            self.endLoad(loadToken)
            guard self.loadGeneration == generation, !self.isDisposed,
                  state.loadToken == token else { return }
            guard let downloaded else {
                self.failAudio(
                    record: record,
                    state: state,
                    message: "audio '\(url)' could not be downloaded."
                )
                return
            }
            do {
                let resource = try await AudioFileResource(
                    contentsOf: downloaded,
                    configuration: configuration
                )
                self.finishAudioLoad(record: record, state: state, resource: resource, token: token)
            } catch {
                self.failAudio(
                    record: record,
                    state: state,
                    message: "audio '\(url)' failed to load: \(error.localizedDescription)"
                )
            }
        }
    }

    private func finishAudioLoad(
        record: ScriptingCommandApplier.Record,
        state: ScriptingAudioState,
        resource: AudioFileResource,
        token: Int
    ) {
        guard state.loadToken == token, !isDisposed else { return }
        state.resource = resource
        state.duration = Double(resource.duration.components.seconds)
            + Double(resource.duration.components.attoseconds) / 1e18
        let controller = record.entity.prepareAudio(resource)
        controller.gain = Self.decibels(state.volume)
        controller.speed = state.rate
        // The handler carries the id, never the record: capturing the record
        // closed the cycle Record → extras → state → controller → handler and
        // nothing was ever freed. RealityKit documents no delivery queue for
        // it either, so the work hops to the main actor rather than asserting
        // it is already there.
        let identifier = record.id
        controller.completionHandler = { [weak self] in
            Task { @MainActor [weak self] in
                guard let self, !self.isDisposed else { return }
                self.finishAudio(id: identifier)
            }
        }
        state.controller = controller
        dispatch?("loaded", record.id, ["duration": state.duration])
        if state.wantsPlay {
            if state.currentTime > 0 { controller.seek(to: .seconds(state.currentTime)) }
            controller.play()
            state.isPlaying = true
            reportAudioEngineRunning()
        }
    }

    private func failAudio(
        record: ScriptingCommandApplier.Record,
        state: ScriptingAudioState,
        message: String
    ) {
        state.loadFailed = true
        state.isPlaying = false
        // SPEC 3.5: no consumer-side console line for a load failure; the
        // message travels in the event.
        dispatch?("error", record.id, ["message": message])
    }

    func releaseAudio(on record: ScriptingCommandApplier.Record) {
        guard let state = record.extras?.audio else { return }
        state.loadToken += 1
        state.controller?.completionHandler = nil
        state.controller?.stop()
        state.controller = nil
        state.resource = nil
        state.isPlaying = false
        state.wantsPlay = false
        state.componentKind = .none
        record.entity.components.remove(SpatialAudioComponent.self)
        record.entity.components.remove(AmbientAudioComponent.self)
        record.entity.components.remove(ChannelAudioComponent.self)
        record.extras?.audio = nil
    }

    /// Called by the playback controller and by the position tracker when a
    /// non-looping sound reaches its end.
    func finishAudio(id: Int) {
        guard let state = records[id]?.extras?.audio, state.isPlaying, !state.loop else { return }
        state.isPlaying = false
        state.wantsPlay = false
        state.currentTime = state.duration
        dispatch?("ended", id, nil)
    }

    /// Registers one `AudioMixGroup` per named group, at master times group.
    private func rebuildAudioMixGroups() {
        var component = AudioMixGroupsComponent()
        var names = Set(audioGroupVolumes.keys)
        names.insert("master")
        for name in names.sorted() {
            var group = AudioMixGroup(name: name)
            group.gain = Self.decibels((audioGroupVolumes[name] ?? 1) * audioMasterVolume)
            component.set(group)
        }
        root.components.set(component)
    }

    // MARK: - Per frame

    /// Advances the position the core sees and closes out finished sounds.
    func advanceAudioPlayback(deltaTime: TimeInterval) {
        guard !mediaSyncIsExternal else { return }
        for record in records.values {
            // Only a sound with a real resource has a clock to advance.
            guard let state = record.extras?.audio, state.isPlaying, state.resource != nil
            else { continue }
            state.currentTime += deltaTime * max(0, state.rate)
            guard state.duration > 0, state.currentTime >= state.duration else { continue }
            if state.loop {
                state.currentTime = state.duration > 0
                    ? state.currentTime.truncatingRemainder(dividingBy: state.duration)
                    : 0
            } else {
                finishAudio(id: record.id)
            }
        }
    }

    /// The audio twin of `adoptVideoSync`.
    func adoptAudioSync(records: [Float]) {
        var index = 0
        while index + 3 < records.count {
            let id = Int(records[index])
            if let state = self.records[id]?.extras?.audio {
                state.isPlaying = records[index + 1] != 0
                state.wantsPlay = state.isPlaying
                state.currentTime = Double(records[index + 2])
                state.duration = Double(records[index + 3])
            }
            index += 4
        }
    }

    /// SPEC 14.13 `syncAudio`: `[id, playing, currentTime, duration]`.
    func audioSyncRecords() -> [Float] {
        var values: [Float] = []
        for record in records.values {
            guard let state = record.extras?.audio else { continue }
            // Only a sound this consumer actually opened has anything to say.
            // Until then the script's own `play()` is the truth and pushing a
            // zero would erase it, exactly as on the video side.
            guard state.resource != nil else { continue }
            guard state.isPlaying || state.duration > 0 else { continue }
            values.append(Float(record.id))
            values.append(state.isPlaying ? 1 : 0)
            values.append(Float(state.currentTime))
            values.append(Float(state.duration))
        }
        return values
    }

    // MARK: - Helpers

    /// A 0..1 volume as RealityKit gain. Zero is silence, not 0 dB.
    static func decibels(_ volume: Double) -> Audio.Decibel {
        guard volume > 0.0001 else { return -.infinity }
        return 20 * log10(min(1, volume))
    }

    /// A cone's inner angle as the beam focus RealityKit actually models:
    /// a full sphere (pi) focuses nothing, a needle focuses fully.
    /// SPEC 14.1 and three.js send the cone in **degrees**; RealityKit models
    /// directivity as a 0..1 beam focus. Clamping before converting made every
    /// realistic cone (60 degrees, say) collapse to a focus of zero, which is
    /// no directivity at all.
    static func beamFocus(innerAngleDegrees: Double) -> Double {
        let radians = max(0, min(180, innerAngleDegrees)) * .pi / 180
        return max(0, min(1, 1 - radians / .pi))
    }

    static func number(_ value: Any?) -> Double? {
        if let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() {
            return number.doubleValue
        }
        return value as? Double
    }
}

/// Downloads a remote media file to a temporary location, because
/// `AudioFileResource` and the shader graph loader only read from disk.
enum ScriptingDownload {
    static func file(from url: URL, preferredExtension: String) async -> URL? {
        do {
            let (data, response) = try await URLSession.shared.data(from: url)
            if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
                return nil
            }
            let suffix = url.pathExtension.isEmpty ? preferredExtension : url.pathExtension
            let destination = FileManager.default.temporaryDirectory
                .appending(path: "spatialscript-\(UUID().uuidString).\(suffix)")
            try data.write(to: destination)
            return destination
        } catch {
            return nil
        }
    }
}

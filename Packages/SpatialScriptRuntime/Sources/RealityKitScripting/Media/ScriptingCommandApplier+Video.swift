//
//  ScriptingCommandApplier+Video.swift
//  RealityKitScripting
//
//  Created by Shane Liu on 9/9/26.
//

import AVFoundation
import Foundation
import RealityKit

extension ScriptingCommandApplier {
    /// SPEC 14.2. `null` releases the player and its plane.
    func applyVideo(id: Int, payload: [String: Any]?) {
        guard let record = records[id] else { return }
        guard let payload else {
            releaseVideo(on: record)
            return
        }
        let state = record.extras?.video ?? {
            let created = ScriptingVideoState()
            record.makeExtras().video = created
            return created
        }()

        let previousURL = state.url
        // SPEC 14.2: `url` is a string or a set of encodings. RealityKit plays
        // mp4 and HLS; webm alone is an error, reported like any bad source.
        if payload.keys.contains("url") { state.reportedURL = payload["url"] is NSNull ? nil : payload["url"] }
        if let url = payload["url"] as? String {
            state.url = url
            state.unplayableEncodings = nil
        } else if let sources = Self.stringMap(payload["url"]) {
            if let chosen = sources["mp4"] ?? sources["hls"] {
                state.url = chosen
                state.unplayableEncodings = nil
            } else {
                state.url = ""
                state.unplayableEncodings = sources.keys.sorted()
            }
        } else if payload["url"] is NSNull, state.url.isEmpty {
            // A screen with no source at all: nothing to open, and silence
            // would look like a consumer that ignored the command.
            warnings.warnOnce(
                "A VideoScreen was configured with no url, so there is nothing to play.",
                key: "video-no-url"
            )
        }
        if payload["width"] is NSNull { state.width = nil }
        else if let width = Self.number(payload["width"]) { state.width = width }
        if payload["height"] is NSNull { state.height = nil }
        else if let height = Self.number(payload["height"]) { state.height = height }
        state.loop = payload["loop"] as? Bool ?? state.loop
        state.muted = payload["muted"] as? Bool ?? state.muted
        state.autoplay = payload["autoplay"] as? Bool ?? state.autoplay
        state.docking = payload["docking"] as? Bool ?? state.docking
        state.volume = Self.number(payload["volume"]) ?? state.volume
        state.rate = Self.number(payload["rate"]) ?? state.rate

        if let encodings = state.unplayableEncodings {
            let message = "VideoScreen has no encoding this backend can play "
                + "(\(encodings.joined(separator: ", "))); RealityKit needs mp4 or hls."
            warnings.warnOnce(message, key: "video-encodings-\(encodings.joined(separator: ","))")
            state.unplayableEncodings = nil
            let token = state.loadToken
            Task { @MainActor [weak self] in
                guard let self, !self.isDisposed, state.loadToken == token else { return }
                self.failVideo(record: record, state: state, message: message)
            }
            return
        }
        if state.url != previousURL || state.openedURL != state.url {
            openVideo(record: record, state: state)
        }
        // Autoplay is the script's intent from the moment it is declared, so
        // the reported state does not wait on AVFoundation.
        if state.autoplay { state.wantsPlay = true; state.isPlaying = true }
        applyVideoSettings(record: record, state: state)
        refreshVideoPlane(record: record, state: state)
    }

    /// SPEC 14.13 `videoControl`.
    func applyVideoControl(id: Int, action: String, value: Double?) {
        guard let record = records[id] else { return }
        // A control can reach the consumer before the payload that configures
        // the screen, so the intent is recorded either way and applied when
        // the player arrives.
        let state = record.extras?.video ?? {
            let created = ScriptingVideoState()
            record.makeExtras().video = created
            return created
        }()
        switch action {
        case "play":
            state.wantsPlay = true
            state.player?.playImmediately(atRate: Float(max(0.01, state.rate)))
            state.isPlaying = true

        case "pause":
            state.wantsPlay = false
            state.player?.pause()
            state.isPlaying = false

        case "seek":
            let target = max(0, value ?? 0)
            state.currentTime = target
            state.player?.seek(to: CMTime(seconds: target, preferredTimescale: 600))

        default:
            warnings.warnOnce(
                "videoControl '\(action)' is not a known action and was ignored.",
                key: "video-control-\(action)"
            )
        }
    }

    // MARK: - Player

    private func openVideo(record: ScriptingCommandApplier.Record, state: ScriptingVideoState) {
        // The script's standing intent outlives the player it was aimed at: a
        // `videoControl play` that arrived before the payload still applies to
        // the player this opens.
        let wanted = state.wantsPlay
        releasePlayer(state)
        state.wantsPlay = wanted
        state.loadToken += 1
        state.didReportLoaded = false
        state.loadFailed = false
        state.currentTime = 0
        state.duration = 0
        state.openedURL = state.url
        // Reopening never contradicts the script: if it asked to play, the new
        // player starts playing and the reported state stays true.
        state.isPlaying = state.wantsPlay
        guard !state.url.isEmpty else { return }

        // A video never fails synchronously: AVFoundation reports a bad file
        // through the item, and the web backend errors from a media event, so
        // an inline `error` here would fire a frame earlier than the contract.
        let resolved = ScriptingResourceURL.resolve(state.url, assetDirectory: assetDirectory)
        let source = resolved?.localFile(extensions: ["mov", "mp4", "m4v"], assetDirectory: assetDirectory)
            ?? resolved?.remoteURL
        guard let source else {
            let message = ScriptingResourceURL.failure(for: state.url)
            warnings.warnOnce(message, key: "video-url-\(state.url)")
            Task { @MainActor [weak self] in
                guard let self, !self.isDisposed, state.loadToken == self.videoToken(state) else { return }
                self.failVideo(record: record, state: state, message: message)
            }
            return
        }

        // AVPlayer streams a remote URL itself, so unlike audio there is no
        // download step.
        let asset = AVURLAsset(url: source)
        let item = AVPlayerItem(asset: asset)
        let player = AVPlayer(playerItem: item)
        player.actionAtItemEnd = state.loop ? .none : .pause
        state.player = player

        let token = state.loadToken
        let generation = loadGeneration
        let identifier = record.id

        // SPEC 14.1: a source AVFoundation cannot open — a file that is not
        // there, an http url that does not answer — surfaces through the
        // item's status and nowhere else. Without this the browser reported the
        // failure and this consumer stayed silent.
        let watchedSource = state.url
        state.statusObservation?.invalidate()
        // Nothing but Sendable values crosses the hop: KVO does not promise the
        // main actor, and the record and its state belong to it.
        state.statusObservation = item.observe(\.status, options: [.initial, .new]) {
            [weak self] observed, _ in
            guard observed.status == .failed else { return }
            let message = observed.error?.localizedDescription
                ?? "video '\(watchedSource)' could not be opened."
            Task { @MainActor in
                self?.reportVideoFailure(
                    id: identifier,
                    source: watchedSource,
                    token: token,
                    generation: generation,
                    message: message
                )
            }
        }

        // An item AVFoundation has already given up on is reported here and
        // now, without a hop: a runner that holds the main actor for a whole
        // case (SPEC 9's conformance runner does) would otherwise never see it.
        if item.status == .failed {
            reportVideoFailure(
                id: identifier,
                source: watchedSource,
                token: token,
                generation: generation,
                message: item.error?.localizedDescription
                    ?? "video '\(watchedSource)' could not be opened."
            )
        }

        state.endObserver = NotificationCenter.default.addObserver(
            forName: AVPlayerItem.didPlayToEndTimeNotification,
            object: item,
            queue: .main
        ) { [weak self] _ in
            // AVFoundation documents the queue this is posted on, but not that
            // the block runs main-actor isolated, so the work hops.
            Task { @MainActor in
                guard state.loadToken == token else { return }
                if state.loop {
                    player.seek(to: .zero)
                    player.play()
                    state.currentTime = 0
                } else {
                    state.isPlaying = false
                    state.wantsPlay = false
                    state.currentTime = state.duration
                    // SPEC 14.2 lists `ended` among VideoScreen's events; audio
                    // has always raised its own.
                    self?.dispatch?("ended", identifier, nil)
                }
            }
        }

        // SPEC 14.13a: the metadata read is a load in flight, so a plan frame
        // waits for it and both backends see the `loaded` event on the same
        // frame.
        let loadToken = beginLoad(state.url)
        Task { [weak self] in
            let duration = try? await asset.load(.duration)
            let tracks = try? await asset.loadTracks(withMediaType: .video)
            let size = try? await tracks?.first?.load(.naturalSize)
            guard let self else { return }
            self.endLoad(loadToken)
            guard self.loadGeneration == generation, !self.isDisposed,
                  state.loadToken == token else { return }
            if let duration, duration.isNumeric { state.duration = duration.seconds }
            if let size, size.width > 0, size.height > 0 { state.presentationSize = size }
            guard duration != nil else {
                self.failVideo(
                    record: record,
                    state: state,
                    message: "video '\(state.url)' could not be opened."
                )
                return
            }
            state.didReportLoaded = true
            self.refreshVideoPlane(record: record, state: state)
            self.dispatch?("loaded", record.id, [
                "duration": state.duration,
                "width": Double(state.presentationSize?.width ?? 0),
                "height": Double(state.presentationSize?.height ?? 0),
            ])
            if state.autoplay || state.wantsPlay {
                player.playImmediately(atRate: Float(max(0.01, state.rate)))
                state.isPlaying = true
            }
        }

        // SPEC 14.2 sizes the screen in metres. `VideoPlayerComponent` draws
        // its own surface at a size RealityKit chooses and reports no bounds
        // to scale against, so the picture goes on this consumer's own plane
        // through `VideoMaterial`, which is the same player either way. The
        // component still rides along on a child so a docking region and the
        // viewing mode have something to attach to.
        let surface = state.surface ?? {
            let created = Entity()
            created.name = "spatial.videoSurface"
            record.entity.addChild(created)
            state.surface = created
            return created
        }()
        surface.components.set(VideoPlayerComponent(avPlayer: player))
        surface.isEnabled = false
        state.material = VideoMaterial(avPlayer: player)
        applyVideoMaterial(record: record, state: state)

#if os(visionOS)
        if state.docking {
            surface.isEnabled = true
            surface.components.set(DockingRegionComponent())
        } else {
            surface.components.remove(DockingRegionComponent.self)
        }
#else
        // SPEC 12: the core warns once that docking is visionOS only
        // (`core/src/media/video.js:117`), so this consumer keeps the region in
        // the dump and says nothing.
        _ = state.docking
#endif
    }

    private func applyVideoSettings(record: ScriptingCommandApplier.Record, state: ScriptingVideoState) {
        guard let player = state.player else { return }
        player.isMuted = state.muted
        player.volume = Float(max(0, min(1, state.volume)))
        player.actionAtItemEnd = state.loop ? .none : .pause
        if state.isPlaying { player.rate = Float(max(0.01, state.rate)) }
    }

    /// Sizes the plane the video is drawn on. When only one dimension is given
    /// the other follows the video's own aspect once it is known.
    func refreshVideoPlane(record: ScriptingCommandApplier.Record, state: ScriptingVideoState) {
        let aspect: Double
        if let size = state.presentationSize, size.height > 0 {
            aspect = Double(size.width / size.height)
        } else {
            aspect = 16.0 / 9
        }
        var width = state.width
        var height = state.height
        if width == nil, let known = height { width = known * aspect }
        if height == nil, let known = width { height = known / aspect }
        let finalWidth = Float(width ?? 1)
        let finalHeight = Float(height ?? (1 / aspect))
        guard finalWidth > 0, finalHeight > 0 else { return }

        let key = "videoPlane:\(finalWidth)x\(finalHeight)"
        guard let mesh = resources.mesh(forKey: key, build: {
            MeshResource.generatePlane(width: finalWidth, height: finalHeight)
        }) else { return }
        bindMesh(record, key: key)
        record.mesh = mesh
        // SPEC 8: the descriptor the core sent is what both dumps report. The
        // plane built here is this consumer's way of drawing the screen, not a
        // different geometry, so it only fills in for an object that never got
        // a `geometry` command at all.
        if record.geometryType.isEmpty {
            record.geometryType = "PlaneGeometry"
            record.geometryParameters = ["width": Double(finalWidth), "height": Double(finalHeight)]
        }
        record.needsCollisionShape = true
        refreshCollisionShape(record)
        applyVideoMaterial(record: record, state: state)
    }

    /// Puts the video on the object's own plane, which is what gives it the
    /// size the script asked for.
    private func applyVideoMaterial(
        record: ScriptingCommandApplier.Record,
        state: ScriptingVideoState
    ) {
        guard let model = record.entity as? ModelEntity,
              let mesh = record.mesh,
              let material = state.material else { return }
        model.model = ModelComponent(mesh: mesh, materials: [material])
        record.nativeMaterial = material
    }

    /// A nested payload object as `[String: String]`. `JSValue.toDictionary`
    /// hands nested objects back as `[AnyHashable: Any]`, which does not cast
    /// straight to `[String: Any]`.
    static func stringMap(_ value: Any?) -> [String: String]? {
        if let typed = value as? [String: String] { return typed }
        guard let raw = value as? [AnyHashable: Any] else { return nil }
        var result: [String: String] = [:]
        for (key, element) in raw {
            guard let name = key as? String, let text = element as? String else { continue }
            result[name] = text
        }
        return result.isEmpty ? nil : result
    }

    private func videoToken(_ state: ScriptingVideoState) -> Int { state.loadToken }

    /// SPEC 14.1: `error` is `{ message }`, once per source. Looked up again on
    /// the main actor because the observation that noticed the failure runs
    /// wherever AVFoundation happened to be.
    private func reportVideoFailure(
        id: Int,
        source: String,
        token: Int,
        generation: Int,
        message: String
    ) {
        guard !isDisposed, loadGeneration == generation,
              let record = records[id], let state = record.extras?.video,
              state.loadToken == token, state.reportedErrorSource != source else { return }
        state.reportedErrorSource = source
        failVideo(record: record, state: state, message: message)
    }

    private func failVideo(
        record: ScriptingCommandApplier.Record,
        state: ScriptingVideoState,
        message: String
    ) {
        state.loadFailed = true
        state.isPlaying = false
        state.errorMessage = message
        // SPEC 3.5: no consumer-side console line for a load failure; the
        // message travels in the event and in `video.error`.
        dispatch?("error", record.id, ["message": message])
    }

    func releaseVideo(on record: ScriptingCommandApplier.Record) {
        guard let state = record.extras?.video else { return }
        releasePlayer(state)
        state.surface?.components.remove(VideoPlayerComponent.self)
        state.surface?.removeFromParent()
        state.surface = nil
        state.material = nil
        record.extras?.video = nil
        // The dead VideoMaterial would otherwise keep drawing a stopped frame.
        // The record's own material takes the plane back.
        guard let model = record.entity as? ModelEntity else { return }
        if let spec = record.materialSpec, let mesh = record.mesh {
            let material = nativeMaterial(for: spec)
            record.nativeMaterial = material
            model.model = ModelComponent(mesh: mesh, materials: [material])
        } else {
            record.nativeMaterial = nil
            model.model = nil
        }
    }

    private func releasePlayer(_ state: ScriptingVideoState) {
        state.loadToken += 1
        state.player?.pause()
        state.player?.replaceCurrentItem(with: nil)
        state.statusObservation?.invalidate()
        state.statusObservation = nil
        if let observer = state.endObserver {
            NotificationCenter.default.removeObserver(observer)
            state.endObserver = nil
        }
        state.player = nil
        state.isPlaying = false
        state.wantsPlay = false
        state.openedURL = nil
    }

    /// Reads the real playback clock back for `syncVideo`.
    func advanceVideoPlayback() {
        guard !mediaSyncIsExternal else { return }
        for record in records.values {
            guard let state = record.extras?.video, let player = state.player else { continue }
            let time = player.currentTime()
            if time.isNumeric { state.currentTime = max(0, time.seconds) }
            // `isPlaying` follows what the script asked for. AVPlayer reports
            // `.waitingToPlayAtSpecifiedRate` while it buffers, which would
            // make a freshly started clip look stopped for a frame or two.
            if player.timeControlStatus == .paused, player.rate == 0, !state.wantsPlay {
                state.isPlaying = false
            }
        }
    }

    /// A harness that drives `syncVideo` owns the playback state, so the
    /// native dump agrees with what it pushed rather than with a player this
    /// host never opened.
    func adoptVideoSync(records: [Float]) {
        var index = 0
        while index + 3 < records.count {
            let id = Int(records[index])
            if let state = self.records[id]?.extras?.video {
                state.isPlaying = records[index + 1] != 0
                state.wantsPlay = state.isPlaying
                state.currentTime = Double(records[index + 2])
                state.duration = Double(records[index + 3])
            }
            index += 4
        }
    }

    /// SPEC 14.13 `syncVideo`: `[id, playing, currentTime, duration]`.
    func videoSyncRecords() -> [Float] {
        var values: [Float] = []
        for record in records.values {
            // Only a player this consumer has actually opened has anything to
            // say. Until AVFoundation reports the clip, the script's own
            // `play()` is the truth and pushing zeroes would erase it.
            guard let state = record.extras?.video, state.player != nil,
                  state.didReportLoaded else { continue }
            values.append(Float(record.id))
            values.append(state.isPlaying ? 1 : 0)
            values.append(Float(state.currentTime))
            values.append(Float(state.duration))
        }
        return values
    }

    /// Stops every player, for scene teardown.
    func disposeMedia() {
        for record in records.values {
            if let state = record.extras?.video { releasePlayer(state) }
            if let state = record.extras?.audio {
                state.loadToken += 1
                state.controller?.stop()
                state.controller = nil
                state.resource = nil
            }
        }
    }
}

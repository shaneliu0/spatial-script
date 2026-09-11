//
//  ScriptingTextureStore.swift
//  RealityKitScripting
//
//  Created by Shane Liu on 9/9/26.
//

import CoreGraphics
import Foundation
import ImageIO
import RealityKit

/// Owns the textures the command stream declares. A `texture` command records
/// the request and starts an asynchronous load; when the resource arrives every
/// material that referenced the id is rebuilt and a `textureLoaded` event is
/// dispatched back into the core.
@MainActor
final class ScriptingTextureStore {
    struct Entry {
        var url: String
        var repeats: SIMD2<Float>
        var offset: SIMD2<Float>
        var wrapS: Int
        var wrapT: Int
        var flipY: Bool
        var resource: TextureResource?
        var isLoading: Bool
        var failed: Bool
    }

    private(set) var entries: [Int: Entry] = [:]
    private var released: Set<Int> = []
    private var isDisposed = false
    private let assetRoot: URL?

    /// Called with the texture id once its resource is ready or has failed.
    var onLoaded: ((Int) -> Void)?
    var onFailed: ((Int, String) -> Void)?
    /// Called when only the sampler or transform settings changed.
    var onSettingsChanged: ((Int) -> Void)?

    init(assetRoot: URL?) {
        self.assetRoot = assetRoot
    }

    func resource(for id: Int) -> TextureResource? {
        entries[id]?.resource
    }

    func entry(for id: Int) -> Entry? {
        entries[id]
    }

    func declare(id: Int, payload: [String: Any]) {
        let url = payload["url"] as? String ?? ""
        let repeats = vector2(payload["repeat"]) ?? SIMD2<Float>(1, 1)
        let offset = vector2(payload["offset"]) ?? SIMD2<Float>(0, 0)
        let wrapS = intValue(payload["wrapS"]) ?? 1000
        let wrapT = intValue(payload["wrapT"]) ?? 1000
        let flipY = payload["flipY"] as? Bool ?? true

        if var existing = entries[id], existing.url == url {
            // A property change re-emits the command. The materials that use the
            // texture are rebuilt, but the load events belong to the load alone.
            existing.repeats = repeats
            existing.offset = offset
            existing.wrapS = wrapS
            existing.wrapT = wrapT
            existing.flipY = flipY
            entries[id] = existing
            onSettingsChanged?(id)
            return
        }

        released.remove(id)
        entries[id] = Entry(
            url: url,
            repeats: repeats,
            offset: offset,
            wrapS: wrapS,
            wrapT: wrapT,
            flipY: flipY,
            resource: nil,
            isLoading: true,
            failed: false
        )
        load(id: id, url: url)
    }

    /// SPEC 5: `["texture", id, null]` frees the resource, drops the id and
    /// makes any in-flight load for it a no-op.
    func release(id: Int) {
        entries[id] = nil
        released.insert(id)
    }

    func removeAll() {
        entries.removeAll()
        released.removeAll()
        isDisposed = true
    }

    private func load(id: Int, url: String) {
        guard let resolved = resolve(url) else {
            fail(id: id, message: "Texture url '\(url)' could not be resolved.")
            return
        }

        switch resolved {
        case .bundled(let name):
            Task { @MainActor [weak self] in
                guard let self else { return }
                do {
                    let resource = try await TextureResource(named: name, in: .main)
                    succeed(id: id, resource: resource)
                } catch {
                    fail(id: id, message: "Texture '\(name)' is not in the app bundle.")
                }
            }

        case .file(let fileURL):
            Task { @MainActor [weak self] in
                guard let self else { return }
                do {
                    let resource = try await TextureResource(contentsOf: fileURL)
                    succeed(id: id, resource: resource)
                } catch {
                    fail(id: id, message: "Texture '\(fileURL.path)' failed to load: \(error.localizedDescription)")
                }
            }

        case .remote(let remoteURL):
            Task { @MainActor [weak self] in
                guard let self else { return }
                do {
                    let (data, _) = try await URLSession.shared.data(from: remoteURL)
                    guard
                        let source = CGImageSourceCreateWithData(data as CFData, nil),
                        let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
                    else {
                        fail(id: id, message: "Texture '\(remoteURL.absoluteString)' is not a decodable image.")
                        return
                    }
                    let flipped = entries[id]?.flipY == false ? Self.flippedVertically(image) : image
                    let resource = try await TextureResource(
                        image: flipped,
                        options: .init(semantic: nil)
                    )
                    succeed(id: id, resource: resource)
                } catch {
                    fail(
                        id: id,
                        message: "Texture '\(remoteURL.absoluteString)' failed to load: \(error.localizedDescription)"
                    )
                }
            }
        }
    }

    private func succeed(id: Int, resource: TextureResource) {
        guard !isDisposed, !released.contains(id), var entry = entries[id] else { return }
        entry.resource = resource
        entry.isLoading = false
        entries[id] = entry
        onLoaded?(id)
    }

    private func fail(id: Int, message: String) {
        guard !isDisposed, !released.contains(id), var entry = entries[id] else { return }
        entry.isLoading = false
        entry.failed = true
        entries[id] = entry
        onFailed?(id, message)
    }

    /// three.js uploads with `flipY = true`; a texture that asks for `false`
    /// is flipped on the way in so both backends sample it the same way.
    static func flippedVertically(_ image: CGImage) -> CGImage {
        guard let space = image.colorSpace,
              let context = CGContext(
                data: nil,
                width: image.width,
                height: image.height,
                bitsPerComponent: 8,
                bytesPerRow: 0,
                space: space,
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
              )
        else { return image }
        context.translateBy(x: 0, y: CGFloat(image.height))
        context.scaleBy(x: 1, y: -1)
        context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
        return context.makeImage() ?? image
    }

    private enum Resolved {
        case bundled(String)
        case file(URL)
        case remote(URL)
    }

    private func resolve(_ url: String) -> Resolved? {
        if url.hasPrefix("asset://") {
            return .bundled(String(url.dropFirst("asset://".count)))
        }
        if url.hasPrefix("http://") || url.hasPrefix("https://") {
            return URL(string: url).map(Resolved.remote)
        }
        if url.hasPrefix("file://") {
            return URL(string: url).map(Resolved.file)
        }
        if url.hasPrefix("/") {
            return .file(URL(fileURLWithPath: url))
        }
        if let assetRoot {
            return .file(assetRoot.appending(path: url))
        }
        return nil
    }

    private func vector2(_ value: Any?) -> SIMD2<Float>? {
        guard let array = value as? [Any], array.count >= 2 else { return nil }
        let x = (array[0] as? NSNumber)?.floatValue ?? 0
        let y = (array[1] as? NSNumber)?.floatValue ?? 0
        return SIMD2(x, y)
    }

    private func intValue(_ value: Any?) -> Int? {
        (value as? NSNumber)?.intValue
    }
}

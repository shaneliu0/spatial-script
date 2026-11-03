//
//  ScriptingTextureStore.swift
//  SpatialScriptRuntime
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
    private let assetDirectory: URL?

    /// Called with the texture id once its resource is ready or has failed.
    var onLoaded: ((Int) -> Void)?
    var onFailed: ((Int, String) -> Void)?
    /// Called when only the sampler or transform settings changed.
    var onSettingsChanged: ((Int) -> Void)?

    init(assetDirectory: URL?) {
        self.assetDirectory = assetDirectory
    }

    /// SPEC 14.13a: textures still being read, and what they are reading.
    var pendingLoads: Int { entries.values.count { $0.isLoading } }
    var pendingLoadURLs: [String] { entries.values.filter(\.isLoading).map(\.url).sorted() }

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
        // SPEC 3.5's url forms, all through one path so `flipY` is honoured for
        // every source and `asset://` searches the bundled asset folder.
        if url.hasPrefix("blob:") {
            // A blob url names an object in a page's memory; a native host has
            // no way to reach it.
            fail(
                id: id,
                message: "Texture url '\(url)' is a blob url, which only a browser can read. "
                    + "Use a data: url or a file the app can reach."
            )
            return
        }

        if url.hasPrefix("data:") {
            guard let data = Self.decodeDataURL(url) else {
                fail(id: id, message: "Texture data url could not be decoded.")
                return
            }
            decode(id: id, data: data, describedBy: "data url")
            return
        }

        guard let resolved = ScriptingResourceURL.resolve(url, assetDirectory: assetDirectory) else {
            fail(id: id, message: "Texture url '\(url)' could not be resolved.")
            return
        }

        if let file = resolved.localFile(
            extensions: ["png", "jpg", "jpeg", "heic", "tiff", "ktx", "exr"],
            assetDirectory: assetDirectory
        ) {
            Task { @MainActor [weak self] in
                guard let self else { return }
                guard let data = try? Data(contentsOf: file) else {
                    self.fail(id: id, message: "Texture '\(file.path)' could not be read.")
                    return
                }
                self.decode(id: id, data: data, describedBy: file.lastPathComponent)
            }
            return
        }

        guard let remote = resolved.remoteURL else {
            fail(id: id, message: "Texture url '\(url)' could not be resolved.")
            return
        }
        Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                let (data, _) = try await URLSession.shared.data(from: remote)
                self.decode(id: id, data: data, describedBy: remote.absoluteString)
            } catch {
                self.fail(
                    id: id,
                    message: "Texture '\(remote.absoluteString)' failed to load: "
                        + error.localizedDescription
                )
            }
        }
    }

    /// One decode for every source, so `flipY` applies to all of them.
    private func decode(id: Int, data: Data, describedBy name: String) {
        guard
            let source = CGImageSourceCreateWithData(data as CFData, nil),
            let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
        else {
            fail(id: id, message: "Texture '\(name)' is not a decodable image.")
            return
        }
        // three.js flips images on upload by default; `flipY: false` means the
        // image is used as authored, which is RealityKit's own orientation.
        let oriented = entries[id]?.flipY == false ? Self.flippedVertically(image) : image
        Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                let resource = try await TextureResource(image: oriented, options: .init(semantic: nil))
                self.succeed(id: id, resource: resource)
            } catch {
                self.fail(
                    id: id,
                    message: "Texture '\(name)' could not be uploaded: " + error.localizedDescription
                )
            }
        }
    }

    /// `data:[<mediatype>][;base64],<data>`; the percent-encoded form too.
    static func decodeDataURL(_ url: String) -> Data? {
        guard let comma = url.firstIndex(of: ",") else { return nil }
        let header = url[url.startIndex..<comma]
        let body = String(url[url.index(after: comma)...])
        if header.hasSuffix(";base64") {
            return Data(base64Encoded: body, options: [.ignoreUnknownCharacters])
        }
        return body.removingPercentEncoding.map { Data($0.utf8) }
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

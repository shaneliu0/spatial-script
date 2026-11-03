//
//  ScriptingResourceURL.swift
//  SpatialScriptRuntime
//
//  Created by Shane Liu on 9/9/26.
//

import Foundation

/// The SPEC 3.5 URL forms, resolved for the phase 2 loaders (audio, video,
/// shader graphs and `Spatial.fetchText`/`fetchJSON`).
///
/// The core normalises a URL before it reaches the consumer, so this only has
/// to map an already-safe string onto a local file, a bundled resource, or a
/// remote request — and refuse anything else by name.
public enum ScriptingResourceURL {
    case bundled(String)
    case file(URL)
    case remote(URL)

    /// Where an app bundles SPEC 3.5's shared asset root.
    public static let bundledAssetDirectory = "assets"

    /// The bundled asset root, when the app ships one.
    public static func bundledAssetRoot() -> URL? {
        for bundle in [Bundle.main, Bundle.module] {
            guard let resources = bundle.resourceURL else { continue }
            let candidate = resources.appending(path: bundledAssetDirectory)
            var isDirectory: ObjCBool = false
            if FileManager.default.fileExists(atPath: candidate.path, isDirectory: &isDirectory),
               isDirectory.boolValue {
                return candidate
            }
        }
        return nil
    }

    static func resolve(_ url: String, assetDirectory: URL?) -> ScriptingResourceURL? {
        if url.hasPrefix("asset://") {
            let name = String(url.dropFirst("asset://".count))
            return name.isEmpty ? nil : .bundled(name)
        }
        if url.hasPrefix("http://") || url.hasPrefix("https://") {
            return URL(string: url).map(ScriptingResourceURL.remote)
        }
        if url.hasPrefix("file://") {
            return URL(string: url).map(ScriptingResourceURL.file)
        }
        if url.hasPrefix("/") {
            return .file(URL(fileURLWithPath: url))
        }
        guard !url.isEmpty, !url.contains("://"), let assetDirectory else { return nil }
        let direct = assetDirectory.appending(path: url)
        if FileManager.default.fileExists(atPath: direct.path) { return .file(direct) }
        // The core resolves a script's `asset://name` against its own root text
        // and sends the result, so a relative url already names that root
        // ("assets/rig.usdz" for SPEC 3.5's root). When the directory this
        // consumer reads from *is* that root, appending the whole url doubles
        // the name; the leading component is the root itself and comes off.
        let components = url.split(separator: "/")
        if components.count > 1, components[0] == assetDirectory.lastPathComponent {
            return .file(assetDirectory.appending(path: components.dropFirst().joined(separator: "/")))
        }
        return .file(direct)
    }

    /// A local file for the resolved URL, or nil when the resource has to be
    /// downloaded first. `asset://` searches the app bundle before the
    /// package's own, so an app can ship its own copy of a name, and finally
    /// the asset root, which is what a headless host (the conformance runner,
    /// the unit tests) has instead of a bundle.
    func localFile(extensions: [String], assetDirectory: URL? = nil) -> URL? {
        switch self {
        case let .file(url):
            return url
        case let .remote(url):
            return url.isFileURL ? url : nil
        case let .bundled(name):
            let bundles = [Bundle.main, Bundle.module]
            let stem = (name as NSString).deletingPathExtension
            let suffix = (name as NSString).pathExtension
            // SPEC 3.5's asset root ships as a folder reference, so a bundled
            // name is looked for there as well as loose in the bundle.
            for bundle in bundles {
                for directory in [Self.bundledAssetDirectory, nil] {
                    if !suffix.isEmpty, let url = bundle.url(
                        forResource: stem,
                        withExtension: suffix,
                        subdirectory: directory
                    ) {
                        return url
                    }
                    for candidate in extensions {
                        if let url = bundle.url(
                            forResource: stem,
                            withExtension: candidate,
                            subdirectory: directory
                        ) {
                            return url
                        }
                    }
                    if let url = bundle.url(forResource: name, withExtension: nil, subdirectory: directory) {
                        return url
                    }
                }
            }
            guard let assetDirectory else { return nil }
            let direct = assetDirectory.appending(path: name)
            if FileManager.default.fileExists(atPath: direct.path) { return direct }
            for candidate in extensions {
                let url = assetDirectory.appending(path: "\(stem).\(candidate)")
                if FileManager.default.fileExists(atPath: url.path) { return url }
            }
            return nil
        }
    }

    var remoteURL: URL? {
        if case let .remote(url) = self, !url.isFileURL { return url }
        return nil
    }

    /// Message for a URL this consumer cannot turn into anything loadable.
    static func failure(for url: String) -> String {
        "'\(url)' could not be resolved: use asset://name, an absolute path, "
            + "file://, http(s)://, or a path relative to the script's asset root."
    }
}

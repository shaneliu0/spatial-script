//
//  SpatialAgentPrompt.swift
//  SpatialScriptRuntime
//
//  Created by Shane Liu on 9/11/26.
//

import Foundation

/// The self-contained SpatialScript authoring prompt, shipped in the package
/// resources so the app can hand it to a scene generator without reaching into
/// the repository.
///
/// The document is generated from `docs/AGENT-PROMPT.md` by
/// `tools/sync-agent-prompt.mjs`; the packaged copy is never hand-edited.
public enum SpatialAgentPrompt {

    /// The prompt's markdown, or a short note when the resource is missing from
    /// the bundle, so a caller always has something printable to show.
    public static var text: String {
        loadPrompt() ?? Self.missingResourceNote
    }

    /// Whether the packaged prompt was found. A caller that would rather fail
    /// than send the fallback can check this first.
    public static var isAvailable: Bool {
        loadPrompt() != nil
    }

    static let missingResourceNote = """
        The SpatialScript authoring prompt is missing from the SpatialScriptRuntime \
        resource bundle. Run "pnpm agent-prompt:sync" in SpatialScript and rebuild.
        """

    /// Reads `agent-prompt.md` the same way the core bundle is read: Xcode and
    /// SwiftPM disagree about whether a copied resource keeps its directory, so
    /// both spellings are tried.
    private static func loadPrompt() -> String? {
        let bundle = Bundle.module
        let candidates = [
            bundle.url(forResource: "agent-prompt", withExtension: "md"),
            bundle.url(forResource: "agent-prompt", withExtension: "md", subdirectory: "Resources"),
        ]
        for case let url? in candidates {
            if let source = try? String(contentsOf: url, encoding: .utf8) { return source }
        }
        return nil
    }
}

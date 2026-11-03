//
//  ScriptingLog.swift
//  SpatialScriptRuntime
//
//  Created by Shane Liu on 9/9/26.
//

import Foundation

/// Severity of a line produced by a script, matching the `console` methods the
/// core installs.
public enum ScriptingLogLevel: String, Sendable, Codable {
    case log
    case info
    case debug
    case warn
    case error
}

/// One line of script output, as delivered to a ``ScriptingLogListener``.
public struct ScriptingLogEntry: Sendable, Codable {
    public let level: ScriptingLogLevel
    public let message: String
    public let timestamp: Date

    public init(level: ScriptingLogLevel, message: String, timestamp: Date = Date()) {
        self.level = level
        self.message = message
        self.timestamp = timestamp
    }
}

/// Receives console output and reported errors from a running scene.
public typealias ScriptingLogListener = @MainActor (ScriptingLogEntry) -> Void

/// Collects the "unsupported in RealityKit" notices the consumer raises. Each
/// distinct feature is reported once per scene, per SPEC section 12.
@MainActor
final class ScriptingWarningCollector {
    private(set) var warnings: [String] = []
    private var seen: Set<String> = []
    /// Called with a stable key and the message, so the consumer can hand the
    /// warning to the core and have it appear in `dump().warnings`.
    var onWarning: ((String, String) -> Void)?

    func warnOnce(_ message: String, key: String? = nil) {
        let key = key ?? message
        guard seen.insert(key).inserted else { return }
        warnings.append(message)
        onWarning?("consumer:\(key)", message)
    }

    func reset() {
        warnings.removeAll()
        seen.removeAll()
    }
}

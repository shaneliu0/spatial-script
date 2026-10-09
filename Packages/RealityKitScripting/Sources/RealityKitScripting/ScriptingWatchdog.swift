//
//  ScriptingWatchdog.swift
//  RealityKitScripting
//
//  Created by Shane Liu on 9/9/26.
//

/// The execution limit, spelled out where every configuration can see it: the
/// watchdog itself is DEBUG only, but the message a terminated load reports is
/// compiled into release builds too.
enum ScriptingExecutionLimit {
    static let seconds = 2.0
}

#if DEBUG
import Darwin
import Foundation
import JavaScriptCore

/// A DEBUG-only execution time limit for a script context.
///
/// `while (true) {}` in `onFrame`, or a `requestAnimationFrame` storm, otherwise
/// spins forever inside RealityKit's update with the compositor frozen and the
/// dev server unreachable. `JSContextGroupSetExecutionTimeLimit` is exported by
/// JavaScriptCore but declared only in a private header, so it is resolved with
/// `dlsym`. Release builds never reference it and have **no watchdog**.
enum ScriptingWatchdog {
    /// Seconds a single synchronous entry into the core may take.
    static let limitSeconds = ScriptingExecutionLimit.seconds

    private typealias ShouldTerminateCallback = @convention(c) (
        JSContextRef?,
        UnsafeMutableRawPointer?
    ) -> Bool

    private typealias SetExecutionTimeLimit = @convention(c) (
        OpaquePointer?,
        Double,
        ShouldTerminateCallback?,
        UnsafeMutableRawPointer?
    ) -> Void

    private typealias ClearExecutionTimeLimit = @convention(c) (OpaquePointer?) -> Void

    private static let setLimit: SetExecutionTimeLimit? = {
        guard let symbol = dlsym(
            UnsafeMutableRawPointer(bitPattern: -2),
            "JSContextGroupSetExecutionTimeLimit"
        ) else { return nil }
        return unsafeBitCast(symbol, to: SetExecutionTimeLimit.self)
    }()

    private static let clearLimit: ClearExecutionTimeLimit? = {
        guard let symbol = dlsym(
            UnsafeMutableRawPointer(bitPattern: -2),
            "JSContextGroupClearExecutionTimeLimit"
        ) else { return nil }
        return unsafeBitCast(symbol, to: ClearExecutionTimeLimit.self)
    }()

    /// True when the private entry point was found.
    static var isAvailable: Bool { setLimit != nil }

    /// Always terminates: a script that has run past the limit is not going to
    /// finish, and the alternative is a frozen compositor.
    private static let shouldTerminate: ShouldTerminateCallback = { _, _ in true }

    /// True when the symbol was found and the limit is in force.
    @discardableResult
    static func install(on context: JSContext) -> Bool {
        guard ProcessInfo.processInfo.environment["SPATIAL_WATCHDOG"] != "0" else { return false }
        guard let setLimit, let contextRef = context.jsGlobalContextRef else { return false }
        setLimit(JSContextGetGroup(contextRef), limitSeconds, shouldTerminate, nil)
        return true
    }

    static func remove(from context: JSContext) {
        guard let clearLimit, let contextRef = context.jsGlobalContextRef else { return }
        clearLimit(JSContextGetGroup(contextRef))
    }

    /// JavaScriptCore reports a tripped limit as a plain exception; this is how
    /// it is told apart from a script's own error.
    static func isTermination(_ message: String) -> Bool {
        message.lowercased().contains("execution terminated")
    }
}
#endif

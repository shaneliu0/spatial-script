//
//  ScriptingFrameStats.swift
//  SpatialScriptRuntime
//
//  Created by Shane Liu on 9/9/26.
//

// SPEC 11: the dev transport and everything that only exists to serve it
// are compiled out of release builds.
#if DEBUG
import Foundation

/// One frame's timing, as served by the DEBUG dev server's `GET /stats`.
public struct ScriptingFrameSample: Sendable {
    /// Consumer work before the core tick: motion sampling, the sync channels
    /// and the input push.
    public var preTickMilliseconds: Double
    public var coreTickMilliseconds: Double
    public var applyMilliseconds: Double
    public var commandCount: Int
    public var frameIntervalMilliseconds: Double
    public var entityCount: Int
}

/// A fixed window of the most recent frames.
public struct ScriptingFrameStats: Sendable {
    public static let capacity = 120

    private var samples: [ScriptingFrameSample] = []

    mutating func record(_ sample: ScriptingFrameSample) {
        samples.append(sample)
        if samples.count > Self.capacity { samples.removeFirst(samples.count - Self.capacity) }
    }

    mutating func reset() {
        samples.removeAll()
    }

    public var count: Int { samples.count }

    public func summary() -> [String: Any] {
        guard !samples.isEmpty else { return ["frames": 0] }
        let pre = samples.map(\.preTickMilliseconds)
        let tick = samples.map(\.coreTickMilliseconds)
        let apply = samples.map(\.applyMilliseconds)
        let interval = samples.map(\.frameIntervalMilliseconds).filter { $0 > 0 }
        let commands = samples.map { Double($0.commandCount) }
        return [
            "frames": samples.count,
            "preTickMs": Self.describe(pre),
            "coreTickMs": Self.describe(tick),
            "applyMs": Self.describe(apply),
            "frameIntervalMs": Self.describe(interval),
            "commandCount": Self.describe(commands),
            "framesPerSecond": interval.isEmpty ? 0 : 1000 / Self.mean(interval),
            "entityCount": samples.last?.entityCount ?? 0,
        ]
    }

    private static func describe(_ values: [Double]) -> [String: Double] {
        guard !values.isEmpty else { return ["mean": 0, "median": 0, "max": 0] }
        let sorted = values.sorted()
        return [
            "mean": mean(values),
            "median": sorted[sorted.count / 2],
            "max": sorted[sorted.count - 1],
        ]
    }

    private static func mean(_ values: [Double]) -> Double {
        values.isEmpty ? 0 : values.reduce(0, +) / Double(values.count)
    }
}

#endif

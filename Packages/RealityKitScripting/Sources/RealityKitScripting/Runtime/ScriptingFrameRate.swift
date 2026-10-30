//
//  ScriptingFrameRate.swift
//  RealityKitScripting
//
//  Created by Shane Liu on 9/11/26.
//

import Foundation
import Observation

/// The live frame rate of the rendered scene, measured where a frame actually
/// happens: ``ScriptingSystem``'s per-frame update.
///
/// Always compiled in, unlike `ScriptingFrameStats`, which exists only for the
/// DEBUG dev transport — the in-app read-out is a shipping feature.
///
/// The per-frame cost is an increment, an add and two comparisons. The
/// observable value is written about four times a second, so a view reading it
/// is invalidated at that rate rather than once a frame; the raw frame counter
/// is deliberately outside observation for the same reason.
@MainActor
@Observable
public final class ScriptingFrameRate {
    public static let shared = ScriptingFrameRate()

    /// Frames per second over the most recently completed measuring window.
    /// Zero until the first window closes.
    public private(set) var framesPerSecond: Double = 0

    /// Every frame the system has run since launch, for callers that need to
    /// know whether frames are being delivered at all rather than how fast.
    ///
    /// Not observable on purpose: a per-frame write to an observable property
    /// would invalidate every view reading it once a frame, which is the cost
    /// this type exists to avoid.
    @ObservationIgnored public private(set) var frameCount: UInt64 = 0

    @ObservationIgnored private var windowFrames = 0
    @ObservationIgnored private var windowSeconds: TimeInterval = 0

    /// How much rendered time a measuring window covers before the rate is
    /// republished. A quarter second reads as live and keeps the publish rate
    /// at 4 Hz whether the renderer is running at 60 or at 120.
    private static let windowLength: TimeInterval = 0.25

    /// A frame interval longer than this is the view coming back rather than a
    /// slow frame, and would drag the window it lands in far below the real
    /// rate. The window is started over instead.
    private static let resumeThreshold: TimeInterval = 0.5

    private init() {}

    /// Records one rendered frame. Called from ``ScriptingSystem``.
    func record(deltaTime: TimeInterval) {
        frameCount &+= 1
        guard deltaTime <= Self.resumeThreshold else {
            windowFrames = 0
            windowSeconds = 0
            return
        }
        windowFrames += 1
        windowSeconds += deltaTime
        guard windowSeconds >= Self.windowLength else { return }
        framesPerSecond = Double(windowFrames) / windowSeconds
        windowFrames = 0
        windowSeconds = 0
    }
}

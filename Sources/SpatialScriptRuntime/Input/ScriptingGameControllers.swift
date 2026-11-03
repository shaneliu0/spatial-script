//
//  ScriptingGameControllers.swift
//  SpatialScriptRuntime
//
//  Created by Shane Liu on 9/9/26.
//

import CoreHaptics
import simd
import Foundation
import GameController

/// One button's edge state, as SPEC 14.8 and 14.9 describe it.
struct ScriptingButtonState {
    var down = false
    var pressed = false
    var released = false
    var value: Double = 0
    /// Presses within 400 ms of each other, for `mouse.left.pressCount`.
    var pressCount = 0
    var lastPressTime: Double = -1

    /// Applies this frame's raw state and derives the edges from the last one.
    mutating func update(down newValue: Bool, value newAnalog: Double, now: Double) {
        pressed = newValue && !down
        released = !newValue && down
        down = newValue
        value = newAnalog
        if pressed {
            pressCount = (now - lastPressTime) <= Self.multiClickWindow ? pressCount + 1 : 1
            lastPressTime = now
        } else if !down, now - lastPressTime > Self.multiClickWindow {
            pressCount = 0
        }
    }

    /// Clears the one-frame edges, leaving `down` and `pressCount` alone.
    mutating func clearEdges() {
        pressed = false
        released = false
    }

    static let multiClickWindow: Double = 0.4

    var json: [String: Any] {
        ["down": down, "pressed": pressed, "released": released, "value": value, "pressCount": pressCount]
    }
}

/// SPEC 14.8. Enumerates connected game controllers, samples them once per
/// frame, and reports connect and disconnect so the core can raise the scene
/// events. Skipped entirely when `ScriptingRuntime.setup` omits `.gamepad`.
@MainActor
final class ScriptingGameControllerHub {
    static let shared = ScriptingGameControllerHub()

    /// Names in SPEC 14.8's order, used for both sampling and the JSON.
    static let buttonNames = [
        "a", "b", "x", "y",
        "leftShoulder", "rightShoulder",
        "leftTrigger", "rightTrigger",
        "dpadUp", "dpadDown", "dpadLeft", "dpadRight",
        "menu", "options",
    ]

    private final class Entry {
        let controller: GCController
        let id: String
        var buttons: [String: ScriptingButtonState] = [:]
        var leftThumbstick: SIMD2<Double> = .zero
        var rightThumbstick: SIMD2<Double> = .zero
        var engine: CHHapticEngine?

        init(controller: GCController, id: String) {
            self.controller = controller
            self.id = id
        }
    }

    private var entries: [Entry] = []
    private var injected: [[String: Any]]?
    private var currentID: String?
    private var started = false
    private var observers: [any NSObjectProtocol] = []

    /// Connect and disconnect since the last drain, for the core's
    /// `controllerconnected` / `controllerdisconnected` events.
    private(set) var pendingConnects: [[String: Any]] = []
    private(set) var pendingDisconnects: [String] = []

    private init() {}

    func start() {
        guard !started else { return }
        started = true
        let center = NotificationCenter.default
        // `GCController` is not Sendable and a notification cannot cross an
        // isolation boundary, so the handlers carry nothing: the list is
        // re-read on the main actor and diffed against what is already known.
        for name in [Notification.Name.GCControllerDidConnect, .GCControllerDidDisconnect] {
            observers.append(center.addObserver(forName: name, object: nil, queue: .main) { _ in
                MainActor.assumeIsolated {
                    ScriptingGameControllerHub.shared.refresh()
                }
            })
        }
        refresh()
        GCController.startWirelessControllerDiscovery {}
    }

    func stop() {
        guard started else { return }
        started = false
        for observer in observers { NotificationCenter.default.removeObserver(observer) }
        observers.removeAll()
        entries.removeAll()
        pendingConnects.removeAll()
        pendingDisconnects.removeAll()
        currentID = nil
        injected = nil
    }

    /// Diffs the connected controllers against what is already tracked and
    /// records the connects and disconnects the core turns into events.
    func refresh() {
        let connected = GCController.controllers()
        var identifiers: [String] = []
        for (slot, controller) in connected.enumerated() {
            identifiers.append(Self.identifier(for: controller, slot: slot))
        }
        let connectedIDs = Set(identifiers)
        for entry in entries where !connectedIDs.contains(entry.id) {
            record(disconnect: entry.id)
            if currentID == entry.id { currentID = nil }
        }
        entries.removeAll { !connectedIDs.contains($0.id) }
        for (slot, controller) in connected.enumerated() {
            add(controller, id: identifiers[slot])
        }
    }

    private func add(_ controller: GCController, id: String) {
        guard !entries.contains(where: { $0.id == id }) else { return }
        let entry = Entry(controller: controller, id: id)
        entries.append(entry)
        record(connect: ["id": id, "name": controller.vendorName ?? "Game Controller"])
    }

    /// Connect and disconnect are derived by the core from successive frames of
    /// `setInput.controllers`, so nothing drains these. They are kept for a
    /// host that wants them and bounded so they cannot grow without one.
    private static let maximumPendingChanges = 32

    private func record(connect entry: [String: Any]) {
        pendingConnects.append(entry)
        if pendingConnects.count > Self.maximumPendingChanges {
            pendingConnects.removeFirst(pendingConnects.count - Self.maximumPendingChanges)
        }
    }

    private func record(disconnect id: String) {
        pendingDisconnects.append(id)
        if pendingDisconnects.count > Self.maximumPendingChanges {
            pendingDisconnects.removeFirst(pendingDisconnects.count - Self.maximumPendingChanges)
        }
    }

    /// SPEC 14.13's default id shape. `ObjectIdentifier.hashValue` is
    /// randomised per launch, so a recorded parity case could not name a
    /// controller twice; a vendor name and slot is reproducible.
    private static func identifier(for controller: GCController, slot: Int) -> String {
        guard let vendor = controller.vendorName, !vendor.isEmpty else {
            return "controller-\(slot)"
        }
        let cleaned = vendor.lowercased().map { $0.isLetter || $0.isNumber ? $0 : "-" }
        return "\(String(cleaned))-\(slot)"
    }

    /// Replaces the hardware sample with a scripted one, for verification
    /// without a controller attached (SPEC 14.14).
    func inject(_ states: [[String: Any]]?) {
        injected = states
        if let first = states?.first, let id = first["id"] as? String { currentID = id }
    }

    /// Samples every controller. Called once per display frame.
    func sample(now: Double) {
        for entry in entries {
            guard let pad = entry.controller.extendedGamepad else { continue }
            var used = false
            for name in Self.buttonNames {
                guard let input = Self.input(named: name, on: pad) else { continue }
                var state = entry.buttons[name] ?? ScriptingButtonState()
                state.update(down: input.isPressed, value: Double(input.value), now: now)
                if state.pressed { used = true }
                entry.buttons[name] = state
            }
            entry.leftThumbstick = SIMD2(Double(pad.leftThumbstick.xAxis.value), Double(pad.leftThumbstick.yAxis.value))
            entry.rightThumbstick = SIMD2(Double(pad.rightThumbstick.xAxis.value), Double(pad.rightThumbstick.yAxis.value))
            if simd_length(entry.leftThumbstick) > 0.2 || simd_length(entry.rightThumbstick) > 0.2 { used = true }
            if used { currentID = entry.id }
        }
    }

    func clearEdges() {
        for entry in entries {
            for (name, var state) in entry.buttons {
                state.clearEdges()
                entry.buttons[name] = state
            }
        }
    }

    private static func input(named name: String, on pad: GCExtendedGamepad) -> GCControllerButtonInput? {
        switch name {
        case "a": pad.buttonA
        case "b": pad.buttonB
        case "x": pad.buttonX
        case "y": pad.buttonY
        case "leftShoulder": pad.leftShoulder
        case "rightShoulder": pad.rightShoulder
        case "leftTrigger": pad.leftTrigger
        case "rightTrigger": pad.rightTrigger
        case "dpadUp": pad.dpad.up
        case "dpadDown": pad.dpad.down
        case "dpadLeft": pad.dpad.left
        case "dpadRight": pad.dpad.right
        case "menu": pad.buttonMenu
        case "options": pad.buttonOptions
        default: nil
        }
    }

    /// SPEC 14.8. One flat object per connected controller, the same shape a
    /// harness injects: `{ id, name, leftThumbstick, rightThumbstick,
    /// leftTrigger, rightTrigger, buttons: { name: value }, current }`. The
    /// core derives the edges, the connect and disconnect events, and the
    /// clamping from successive frames of this array.
    func json() -> [[String: Any]] {
        if let injected { return injected }
        return entries.map { entry in
            var buttons: [String: Any] = [:]
            for name in Self.buttonNames where name != "leftTrigger" && name != "rightTrigger" {
                buttons[name] = (entry.buttons[name] ?? ScriptingButtonState()).value
            }
            return [
                "id": entry.id,
                "name": entry.controller.vendorName ?? "Game Controller",
                "leftThumbstick": [entry.leftThumbstick.x, entry.leftThumbstick.y],
                "rightThumbstick": [entry.rightThumbstick.x, entry.rightThumbstick.y],
                "leftTrigger": (entry.buttons["leftTrigger"] ?? ScriptingButtonState()).value,
                "rightTrigger": (entry.buttons["rightTrigger"] ?? ScriptingButtonState()).value,
                "buttons": buttons,
                "current": entry.id == currentID,
            ]
        }
    }

    /// Only what a harness injected, for SPEC 14.13a's deterministic plans.
    func injectedJSON() -> [[String: Any]] {
        injected ?? []
    }

    /// SPEC 14.13's full record, with every optional field filled in the way
    /// the core defaults them. This is what the native dump reports; the raw
    /// records go to `setInput` so the core does its own defaulting.
    func normalizedJSON() -> [[String: Any]] {
        json().enumerated().map { slot, raw in
            var buttons: [String: Any] = [:]
            let given = raw["buttons"] as? [String: Any] ?? [:]
            for name in Self.buttonNames where name != "leftTrigger" && name != "rightTrigger" {
                buttons[name] = Self.axis(given[name] ?? raw[name])
            }
            return [
                "id": raw["id"] as? String ?? "controller-\(slot)",
                "name": raw["name"] as? String ?? "",
                "leftThumbstick": Self.stick(raw["leftThumbstick"]),
                "rightThumbstick": Self.stick(raw["rightThumbstick"]),
                "leftTrigger": Self.axis(raw["leftTrigger"]),
                "rightTrigger": Self.axis(raw["rightTrigger"]),
                "buttons": buttons,
            ]
        }
    }

    /// A stick is two floats clamped to the unit range on each axis.
    private static func stick(_ value: Any?) -> [Double] {
        let values = (value as? [Any])?.compactMap { ($0 as? NSNumber)?.doubleValue } ?? []
        return [
            max(-1, min(1, values.first ?? 0)),
            max(-1, min(1, values.count > 1 ? values[1] : 0)),
        ]
    }

    /// A button or trigger reads as 0 to 1, whether it arrived as a number, a
    /// boolean, or an edge record.
    private static func axis(_ value: Any?) -> Double {
        if let number = value as? NSNumber {
            if CFGetTypeID(number) == CFBooleanGetTypeID() { return number.boolValue ? 1 : 0 }
            return max(0, min(1, number.doubleValue))
        }
        if let bool = value as? Bool { return bool ? 1 : 0 }
        if let record = value as? [String: Any] { return axis(record["value"] ?? record["down"]) }
        return 0
    }

    func drainConnects() -> [[String: Any]] {
        let drained = pendingConnects
        pendingConnects.removeAll()
        return drained
    }

    func drainDisconnects() -> [String] {
        let drained = pendingDisconnects
        pendingDisconnects.removeAll()
        return drained
    }

    /// SPEC 14.8 `rumble`. Returns false when this controller has no haptics.
    @discardableResult
    func rumble(id: String, intensity: Double, duration: Double) -> Bool {
        guard let entry = entries.first(where: { $0.id == id }),
              let haptics = entry.controller.haptics else { return false }
        do {
            let engine = try entry.engine ?? {
                guard let created = haptics.createEngine(withLocality: .default) else {
                    throw CHHapticError(.notSupported)
                }
                try created.start()
                entry.engine = created
                return created
            }()
            let event = CHHapticEvent(
                eventType: .hapticContinuous,
                parameters: [
                    CHHapticEventParameter(parameterID: .hapticIntensity, value: Float(max(0, min(1, intensity)))),
                    CHHapticEventParameter(parameterID: .hapticSharpness, value: 0.5),
                ],
                relativeTime: 0,
                duration: max(0.01, duration)
            )
            let pattern = try CHHapticPattern(events: [event], parameters: [])
            let player = try engine.makePlayer(with: pattern)
            try player.start(atTime: CHHapticTimeImmediate)
            return true
        } catch {
            return false
        }
    }
}

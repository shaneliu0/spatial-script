//
//  ScriptingInputRouter.swift
//  SpatialScriptRuntime
//
//  Created by Shane Liu on 9/9/26.
//

import CoreGraphics
import Foundation
import RealityKit
#if os(macOS)
import AppKit
#endif

/// Routes tap, drag and hover from the SwiftUI gestures into the scene that
/// owns the touched entity, and holds the polled keyboard, mouse and hand state
/// the core reads every frame.
@MainActor
public final class ScriptingInputRouter {
    public static let shared = ScriptingInputRouter()

    private struct DragSession {
        let sceneID: UUID
        let entityID: Int
        var startWorld: SIMD3<Float>
    }

    /// Weak: this singleton outlives every scene, and a strong map here kept
    /// whole JSContexts and entity trees alive after their view went away.
    private final class WeakScene {
        weak var scene: JavaScriptScene?
        init(_ scene: JavaScriptScene) { self.scene = scene }
    }

    private var sceneBoxes: [UUID: WeakScene] = [:]
    private var scenes: [UUID: JavaScriptScene] {
        sceneBoxes.compactMapValues(\.scene)
    }
    private var drags: [ObjectIdentifier: DragSession] = [:]
    private var hoveredScene: JavaScriptScene?
    private var hoveredID: Int?

    private var keysDown: Set<String> = []
    private var keysPressed: Set<String> = []
    private var mousePosition: CGPoint?
    private var previousMousePosition: CGPoint?
    private var mouseButtons: [Bool] = [false, false, false]
    /// SPEC 14.9 per-button edges and click counts, indexed left, right, middle.
    private var mouseButtonStates = [ScriptingButtonState(), ScriptingButtonState(), ScriptingButtonState()]
    /// SPEC 14.9 scroll, accumulated within a frame and cleared by `beginFrame`.
    private var scrollDelta = SIMD2<Double>.zero
    /// SPEC 14.8. Set by `ScriptingRuntime.setup(inputOptions:)`.
    var providesGamepad = true
    var providesHandTracking = true
    /// True once the macOS event monitor is watching, which is the only way
    /// this consumer knows a keyboard is attached to it.
    private var hasKeyboardMonitor = false
    /// Last world point under the pointer, refreshed by `updatePointer`.
    private var scenePositionCache: [Double]?
    private var frameSnapshot: [String: Any]?
    private var consumedThisFrame: Set<UUID> = []
#if os(macOS)
    private var eventMonitor: Any?
#endif

    /// Supplies a world space ray for a point in the RealityView, used for
    /// pointer hover on macOS. The app installs it from the view that owns the
    /// `RealityView`, which is the only place the camera is reachable.
    public var pointerRayProvider: (@MainActor (CGPoint) -> (origin: SIMD3<Float>, direction: SIMD3<Float>)?)?

    private init() {
        installEventMonitor()
    }

    // MARK: - Scene registry

    func register(scene: JavaScriptScene, id: UUID) {
        sceneBoxes = sceneBoxes.filter { $0.value.scene != nil }
        sceneBoxes[id] = WeakScene(scene)
    }

    func unregister(id: UUID) {
        if hoveredScene?.sceneID == id { hoveredScene = nil; hoveredID = nil }
        sceneBoxes[id] = nil
        drags = drags.filter { $0.value.sceneID != id }
    }

    /// Drops every registered scene and the app-installed ray provider, for a
    /// view that is going away.
    public func reset() {
        endHover()
        sceneBoxes.removeAll()
        drags.removeAll()
        pointerRayProvider = nil
    }

    private func scene(for entity: Entity) -> (JavaScriptScene, Int)? {
        var node: Entity? = entity
        while let current = node {
            if let component = current.components[ScriptingEntityComponent.self],
               let scene = scenes[component.sceneID] {
                if let id = scene.entityRecordID(for: entity) { return (scene, id) }
                return (scene, component.entityID)
            }
            node = current.parent
        }
        return nil
    }

    // MARK: - Pointer events

    public func sendTap(to entity: Entity, worldPoint: SIMD3<Float>) {
        guard let (scene, id) = scene(for: entity) else { return }
        scene.dispatch(type: "tap", id: id, payload: ["point": [worldPoint.x, worldPoint.y, worldPoint.z]])
    }

    public func sendDrag(
        to entity: Entity,
        phase: ScriptingDragPhase,
        worldPoint: SIMD3<Float>,
        startWorldPoint: SIMD3<Float>
    ) {
        guard let (scene, id) = scene(for: entity) else { return }
        let key = ObjectIdentifier(entity)

        if drags[key] == nil, phase != .ended {
            drags[key] = DragSession(sceneID: scene.sceneID, entityID: id, startWorld: startWorldPoint)
            scene.dispatch(type: "dragstart", id: id, payload: payload(
                translation: .zero,
                point: startWorldPoint
            ))
            if phase == .began { return }
        }

        switch phase {
        case .began:
            return

        case .changed:
            guard let session = drags[key] else { return }
            scene.dispatch(type: "drag", id: id, payload: payload(
                translation: worldPoint - session.startWorld,
                point: worldPoint
            ))

        case .ended:
            let start = drags[key]?.startWorld ?? startWorldPoint
            drags[key] = nil
            scene.dispatch(type: "dragend", id: id, payload: payload(
                translation: worldPoint - start,
                point: worldPoint
            ))
        }
    }

    private func payload(translation: SIMD3<Float>, point: SIMD3<Float>) -> [String: Any] {
        [
            "translation": [translation.x, translation.y, translation.z],
            "point": [point.x, point.y, point.z],
        ]
    }

    public func sendHover(to entity: Entity?, entering: Bool) {
        guard let entity else { return }
        guard let (scene, id) = scene(for: entity) else { return }
        scene.dispatch(type: entering ? "hoverenter" : "hoverexit", id: id, payload: nil)
    }

    /// Updates the pointer position and resolves which entity is under it,
    /// emitting `hoverenter` and `hoverexit` as it changes.
    public func updatePointer(location: CGPoint?) {
        mousePosition = location
        guard let location, let ray = pointerRayProvider?(location) else {
            scenePositionCache = nil
            endHover()
            return
        }
        var nearest: (scene: JavaScriptScene, id: Int, distance: Float)?
        for scene in scenes.values {
            guard let hit = scene.firstRaycastHit(origin: ray.origin, direction: ray.direction) else { continue }
            if nearest == nil || hit.distance < nearest!.distance {
                nearest = (scene, hit.id, hit.distance)
            }
        }
        recordScenePosition(ray: ray, hitDistance: nearest?.distance)
        guard let nearest else {
            endHover()
            return
        }
        if let current = hoveredScene, let currentID = hoveredID {
            if current === nearest.scene, currentID == nearest.id { return }
            current.dispatch(type: "hoverexit", id: currentID, payload: nil)
        }
        hoveredScene = nearest.scene
        hoveredID = nearest.id
        nearest.scene.dispatch(type: "hoverenter", id: nearest.id, payload: nil)
    }

    /// SPEC 14.3 `Spatial.input.mouse.scenePosition`: the world point under
    /// the pointer on the first hit mesh, or on the plane through the origin
    /// facing the camera when nothing is hit.
    ///
    /// Computed by `updatePointer`, which already casts the hover ray, and
    /// cached: casting again once per frame would materialise every deferred
    /// collider in the scene and cost more than the frame itself.
    private func recordScenePosition(
        ray: (origin: SIMD3<Float>, direction: SIMD3<Float>),
        hitDistance: Float?
    ) {
        let distance: Float
        if let hitDistance {
            distance = hitDistance
        } else {
            // The plane through the origin whose normal faces the camera: the
            // ray meets it wherever the projection along the view direction
            // cancels the origin's own offset.
            let denominator = simd_dot(ray.direction, ray.direction)
            guard denominator > 1e-6 else { scenePositionCache = nil; return }
            let t = -simd_dot(ray.origin, ray.direction) / denominator
            guard t > 0 else { scenePositionCache = nil; return }
            distance = t
        }
        let point = ray.origin + ray.direction * distance
        scenePositionCache = [Double(point.x), Double(point.y), Double(point.z)]
    }

    /// SPEC 14.3 `Spatial.rayFromPoint(x, y)`, in world space. Nil where there
    /// is no view camera to project through.
    func rayFromPoint(x: Double, y: Double) -> [Double]? {
        guard let ray = pointerRayProvider?(CGPoint(x: x, y: y)) else { return nil }
        return [
            Double(ray.origin.x), Double(ray.origin.y), Double(ray.origin.z),
            Double(ray.direction.x), Double(ray.direction.y), Double(ray.direction.z),
        ]
    }

    private func endHover() {
        if let scene = hoveredScene, let id = hoveredID {
            scene.dispatch(type: "hoverexit", id: id, payload: nil)
        }
        hoveredScene = nil
        hoveredID = nil
    }

    public func setMouseButton(_ index: Int, down: Bool) {
        guard index >= 0, index < mouseButtons.count else { return }
        mouseButtons[index] = down
        mouseButtonStates[index].update(
            down: down,
            value: down ? 1 : 0,
            now: Date().timeIntervalSinceReferenceDate
        )
    }

    /// SPEC 14.9 `mouse.scroll`, in view points, summed within the frame.
    public func addScroll(x: Double, y: Double) {
        scrollDelta += SIMD2(x, y)
    }

    /// What the native dump reports under `controllers` (SPEC 14.13).
    func controllerSnapshot() -> [[String: Any]] {
        providesGamepad ? ScriptingGameControllerHub.shared.normalizedJSON() : []
    }

#if DEBUG
    /// Clears the pointer button edges and click counts. A click count spans
    /// frames by design, so a harness that wants a known starting point asks
    /// for one rather than waiting out the 400 ms window.
    ///
    /// SPEC 11: injection and the state a harness needs to reset exist only for
    /// the dev transport, so they are not in a shipped build.
    public func resetPointerButtons() {
        mouseButtons = [false, false, false]
        mouseButtonStates = [ScriptingButtonState(), ScriptingButtonState(), ScriptingButtonState()]
        scrollDelta = .zero
        frameSnapshot = nil
    }

    /// SPEC 14.13a: while a parity plan runs, the core sees only injected
    /// input, so a plan is deterministic and does not drift with whatever the
    /// pointer happened to be doing.
    var suppressesLiveInput = false

    /// SPEC 14.14: drives `Spatial.input.controllers` without hardware.
    public func injectControllers(_ states: [[String: Any]]?) {
        ScriptingGameControllerHub.shared.inject(states)
    }
#endif

    // MARK: - Polled state

    /// Edge state — `pressed` and the mouse delta — is consumed once per frame,
    /// not once per scene, so two scenes see the same input rather than the
    /// first one swallowing it.
    func inputState(for sceneID: UUID) -> [String: Any] {
        if let snapshot = frameSnapshot, consumedThisFrame.insert(sceneID).inserted == false {
            return snapshot
        }
        if let snapshot = frameSnapshot { return snapshot }

        let delta: [Double]
        if let position = mousePosition, let previous = previousMousePosition {
            delta = [Double(position.x - previous.x), Double(position.y - previous.y)]
        } else {
            delta = [0, 0]
        }
        previousMousePosition = mousePosition

        // SPEC 14.9: `connected` is a device fact, so it is only true once a
        // real keyboard or pointer is driving this process. A headless host
        // (the conformance runner) reports neither.
#if os(macOS)
        // A test or headless host is not a regular application and no key
        // events can reach it, whatever monitors are installed in-process.
        let keyboardConnected = hasKeyboardMonitor
            && NSApplication.shared.activationPolicy() == .regular
#else
        let keyboardConnected = hasKeyboardMonitor
#endif
        let mouseConnected = mousePosition != nil

#if DEBUG
        if suppressesLiveInput { return injectedOnlySnapshot(for: sceneID) }
#endif

        var mouse: [String: Any] = [
            "position": mousePosition.map { [Double($0.x), Double($0.y)] } as Any,
            "buttons": mouseButtons,
            "delta": delta,
            "scroll": [scrollDelta.x, scrollDelta.y],
            "connected": mouseConnected,
            "scenePosition": (mousePosition == nil ? nil : scenePositionCache) as Any? ?? NSNull(),
        ]
        for (index, name) in ["left", "right", "middle"].enumerated() {
            mouse[name] = mouseButtonStates[index].json
        }

        var snapshot: [String: Any] = [
            "keyboard": [
                "down": Array(keysDown),
                "pressed": Array(keysPressed),
                "connected": keyboardConnected,
            ],
            "mouse": mouse,
            "hands": providesHandTracking ? [
                "left": ScriptingHandTracking.shared.handJSON(chirality: .left) as Any,
                "right": ScriptingHandTracking.shared.handJSON(chirality: .right) as Any,
            ] : ["left": NSNull(), "right": NSNull()],
        ]
        if providesGamepad {
            snapshot["controllers"] = ScriptingGameControllerHub.shared.json()
        } else {
            snapshot["controllers"] = [[String: Any]]()
        }
        keysPressed.removeAll()
        frameSnapshot = snapshot
        consumedThisFrame = [sceneID]
        return snapshot
    }

    /// The input a parity plan sees: nothing live, only what was injected.
    private func injectedOnlySnapshot(for sceneID: UUID) -> [String: Any] {
        var snapshot: [String: Any] = [
            "keyboard": ["down": [String](), "pressed": [String](), "connected": false],
            "mouse": [
                "position": NSNull(),
                "buttons": [false, false, false],
                "delta": [0.0, 0.0],
                "scroll": [0.0, 0.0],
                "connected": false,
                "scenePosition": NSNull(),
                "left": ScriptingButtonState().json,
                "right": ScriptingButtonState().json,
                "middle": ScriptingButtonState().json,
            ],
            "hands": ["left": NSNull(), "right": NSNull()],
        ]
        // An injected controller is scripted input, so it still counts.
        snapshot["controllers"] = ScriptingGameControllerHub.shared.injectedJSON()
        frameSnapshot = snapshot
        consumedThisFrame = [sceneID]
        return snapshot
    }

    /// Called once per display frame by the system before it ticks any scene.
    func beginFrame() {
        frameSnapshot = nil
        consumedThisFrame.removeAll(keepingCapacity: true)
        scrollDelta = .zero
        for index in mouseButtonStates.indices { mouseButtonStates[index].clearEdges() }
        if providesGamepad {
            let hub = ScriptingGameControllerHub.shared
            hub.clearEdges()
            hub.sample(now: Date().timeIntervalSinceReferenceDate)
        }
    }

    /// Connect and disconnect notices the system turns into scene events.
    func drainControllerChanges() -> (connected: [[String: Any]], disconnected: [String]) {
        guard providesGamepad else { return ([], []) }
        let hub = ScriptingGameControllerHub.shared
        return (hub.drainConnects(), hub.drainDisconnects())
    }

    // MARK: - Keyboard and mouse monitors

    private func installEventMonitor() {
#if os(macOS)
        let mask: NSEvent.EventTypeMask = [
            .keyDown, .keyUp, .flagsChanged,
            .leftMouseDown, .leftMouseUp,
            .rightMouseDown, .rightMouseUp,
            .otherMouseDown, .otherMouseUp,
            .scrollWheel,
        ]
        hasKeyboardMonitor = true
        eventMonitor = NSEvent.addLocalMonitorForEvents(matching: mask) { event in
            MainActor.assumeIsolated {
                ScriptingInputRouter.shared.handle(event: event)
            }
            return event
        }
#endif
    }

#if os(macOS)
    private func handle(event: NSEvent) {
        switch event.type {
        case .keyDown:
            let code = ScriptingKeyCodes.name(for: event.keyCode)
            if keysDown.insert(code).inserted { keysPressed.insert(code) }
        case .keyUp:
            keysDown.remove(ScriptingKeyCodes.name(for: event.keyCode))
        case .flagsChanged:
            // A modifier reports its state through the flags, not through
            // separate key down and key up events.
            for modifier in ScriptingKeyCodes.modifiers where modifier.keyCode == event.keyCode {
                let code = ScriptingKeyCodes.name(for: modifier.keyCode)
                if event.modifierFlags.contains(modifier.flag) {
                    if keysDown.insert(code).inserted { keysPressed.insert(code) }
                } else {
                    keysDown.remove(code)
                }
            }
        case .leftMouseDown: setMouseButton(0, down: true)
        case .leftMouseUp: setMouseButton(0, down: false)
        case .rightMouseDown: setMouseButton(1, down: true)
        case .rightMouseUp: setMouseButton(1, down: false)
        case .otherMouseDown: setMouseButton(2, down: true)
        case .otherMouseUp: setMouseButton(2, down: false)
        case .scrollWheel: addScroll(x: Double(event.scrollingDeltaX), y: Double(event.scrollingDeltaY))
        default: break
        }
    }
#endif
}

extension JavaScriptScene {
    /// Nearest scripted object hit by a world space ray, for pointer hover.
    func firstRaycastHit(origin: SIMD3<Float>, direction: SIMD3<Float>) -> (id: Int, distance: Float)? {
        let values = raycastValues(origin: origin, direction: direction)
        guard values.count >= 8 else { return nil }
        return (Int(values[0]), values[7])
    }
}

/// Maps macOS virtual key codes onto the `KeyboardEvent.code` names SPEC 3.8
/// specifies. The mapping is by virtual key code, never by the character the
/// key produces, so it is layout independent.
enum ScriptingKeyCodes {
    private static let table: [UInt16: String] = [
        0: "KeyA", 1: "KeyS", 2: "KeyD", 3: "KeyF", 4: "KeyH", 5: "KeyG",
        6: "KeyZ", 7: "KeyX", 8: "KeyC", 9: "KeyV", 10: "IntlBackslash", 11: "KeyB",
        12: "KeyQ", 13: "KeyW", 14: "KeyE", 15: "KeyR", 16: "KeyY", 17: "KeyT",
        18: "Digit1", 19: "Digit2", 20: "Digit3", 21: "Digit4", 22: "Digit6",
        23: "Digit5", 24: "Equal", 25: "Digit9", 26: "Digit7", 27: "Minus",
        28: "Digit8", 29: "Digit0", 30: "BracketRight", 31: "KeyO", 32: "KeyU",
        33: "BracketLeft", 34: "KeyI", 35: "KeyP", 36: "Enter", 37: "KeyL",
        38: "KeyJ", 39: "Quote", 40: "KeyK", 41: "Semicolon", 42: "Backslash",
        43: "Comma", 44: "Slash", 45: "KeyN", 46: "KeyM", 47: "Period",
        48: "Tab", 49: "Space", 50: "Backquote", 51: "Backspace", 53: "Escape",
        // Modifiers, reported through .flagsChanged.
        54: "MetaRight", 55: "MetaLeft", 56: "ShiftLeft", 57: "CapsLock",
        58: "AltLeft", 59: "ControlLeft", 60: "ShiftRight", 61: "AltRight",
        62: "ControlRight", 63: "Fn",
        // Keypad.
        65: "NumpadDecimal", 67: "NumpadMultiply", 69: "NumpadAdd",
        71: "NumLock", 75: "NumpadDivide", 76: "NumpadEnter", 78: "NumpadSubtract",
        81: "NumpadEqual", 82: "Numpad0", 83: "Numpad1", 84: "Numpad2",
        85: "Numpad3", 86: "Numpad4", 87: "Numpad5", 88: "Numpad6",
        89: "Numpad7", 91: "Numpad8", 92: "Numpad9",
        // Function keys.
        96: "F5", 97: "F6", 98: "F7", 99: "F3", 100: "F8", 101: "F9",
        103: "F11", 105: "F13", 107: "F14", 109: "F10", 111: "F12",
        113: "F15", 114: "Insert", 115: "Home", 116: "PageUp", 117: "Delete",
        118: "F4", 119: "End", 120: "F2", 121: "PageDown", 122: "F1",
        // Arrows.
        123: "ArrowLeft", 124: "ArrowRight", 125: "ArrowDown", 126: "ArrowUp",
    ]

#if os(macOS)
    /// The modifier keys a `.flagsChanged` event can report, paired with the
    /// flag that is set while the key is held.
    static let modifiers: [(keyCode: UInt16, flag: NSEvent.ModifierFlags)] = [
        (55, .command), (54, .command),
        (56, .shift), (60, .shift),
        (58, .option), (61, .option),
        (59, .control), (62, .control),
        (57, .capsLock), (63, .function),
    ]
#endif

    static func name(for keyCode: UInt16) -> String {
        table[keyCode] ?? "Unidentified\(keyCode)"
    }
}

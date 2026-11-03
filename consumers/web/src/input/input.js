// Pointer, keyboard and manipulation input for the web consumer (SPEC 3.8).
// Pointer events are raycast against the scene; drag translation is measured on
// the plane through the object's world position that faces the camera, so an
// on-screen drag maps 1:1 to world displacement.

import * as THREE from 'three';
import { walkUp } from '../dump/scene-walk.js';

const TAP_SLOP_PX = 4;

export class InputController {
  /**
   * @param {object} deps
   * @param {HTMLElement} deps.element canvas the pointer events are bound to
   * @param {THREE.Camera} deps.camera
   * @param {() => THREE.Object3D[]} deps.pickables meshes eligible for hit testing
   * @param {(object: THREE.Object3D) => number|undefined} deps.idOf
   * @param {(object: THREE.Object3D, kind: string) => THREE.Object3D|null} deps.interactiveAncestor
   * @param {(object: THREE.Object3D) => boolean} deps.isManipulable
   * @param {(type: string, id: number, payload: object) => void} deps.dispatch
   */
  constructor(deps) {
    this.deps = deps;
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.plane = new THREE.Plane();

    this.keysDown = new Set();
    this.keysPressed = new Set();
    this.mousePosition = null;
    this.mouseButtons = [false, false, false];
    this.mouseDelta = new THREE.Vector2();
    this._lastMouse = null;
    // SPEC 14.9: per-button edges, click counts within 400 ms, and scroll.
    this.mouseScroll = new THREE.Vector2();
    this.mousePressed = [false, false, false];
    this.mouseReleased = [false, false, false];
    this.mousePressCount = [0, 0, 0];
    this._lastPressAt = [0, 0, 0];
    // SPEC 14.9: `connected` is a device fact, reported once real input arrives.
    this.mouseConnected = false;
    this.keyboardConnected = false;
    /** SPEC 14.8: Gamepad API state, keyed by index. */
    this.gamepadsEnabled = true;
    this.currentController = null;
    /**
     * P2-B-14: once a real pad has been seen, an empty list is news and must be
     * sent so the core can raise `controllerdisconnected`. Until then the key is
     * omitted, because headless Chromium reports no pads and an unconditional
     * empty array would clobber injected controller state.
     */
    this.sawGamepad = false;

    this.hovered = null;
    this.drag = null;
    this.manipulation = null;
    this._listeners = [];
  }

  attach() {
    const el = this.deps.element;
    if (!el) return;
    this._bind(el, 'pointerdown', (e) => this.onPointerDown(e));
    this._bind(el, 'pointermove', (e) => this.onPointerMove(e));
    this._bind(el, 'pointerup', (e) => this.onPointerUp(e));
    this._bind(el, 'pointercancel', (e) => this.onPointerUp(e));
    this._bind(el, 'pointerleave', (e) => this.onPointerLeave(e));
    this._bind(el, 'contextmenu', (e) => e.preventDefault());
    this._bind(el, 'wheel', (e) => this.onWheel(e));
    const target = el.ownerDocument ? el.ownerDocument.defaultView : null;
    if (target) {
      this._bind(target, 'keydown', (e) => this.onKeyDown(e));
      this._bind(target, 'keyup', (e) => this.onKeyUp(e));
      // Chrome only exposes a pad after one of these fires or a button is used.
      this._bind(target, 'gamepadconnected', (e) => this.onGamepadConnected(e));
      this._bind(target, 'gamepaddisconnected', () => { this.sawGamepad = true; });
    }
  }

  _bind(target, type, handler) {
    target.addEventListener(type, handler);
    this._listeners.push([target, type, handler]);
  }

  detach() {
    for (const [target, type, handler] of this._listeners) target.removeEventListener(type, handler);
    this._listeners.length = 0;
  }

  // -------------------------------------------------------------- keyboard

  onKeyDown(e) {
    this.keyboardConnected = true;
    if (!this.keysDown.has(e.code)) this.keysPressed.add(e.code);
    this.keysDown.add(e.code);
  }

  onGamepadConnected(e) {
    this.sawGamepad = true;
    // P2-B-48: the core computes the `current` flag from the state it is sent,
    // so the consumer only records which pad was used most recently.
    if (e && e.gamepad) this.currentController = e.gamepad.index;
  }

  onWheel(e) {
    this.mouseScroll.x += e.deltaX;
    this.mouseScroll.y += e.deltaY;
  }

  onKeyUp(e) {
    this.keysDown.delete(e.code);
  }

  /** Used by `inject.key`: synthesises a key without a real KeyboardEvent. */
  injectKey(code, down) {
    if (down) {
      if (!this.keysDown.has(code)) this.keysPressed.add(code);
      this.keysDown.add(code);
    } else {
      this.keysDown.delete(code);
    }
  }

  /** Builds the `setInput` payload and clears the per-frame accumulators. */
  consumeState() {
    const state = {
      keyboard: {
        down: [...this.keysDown],
        pressed: [...this.keysPressed],
        connected: this.keyboardConnected,
      },
      mouse: {
        position: this.mousePosition ? [this.mousePosition.x, this.mousePosition.y] : null,
        // The core reads [left, right, middle].
        buttons: [this.mouseButtons[0], this.mouseButtons[2], this.mouseButtons[1]],
        pressed: [this.mousePressed[0], this.mousePressed[2], this.mousePressed[1]],
        released: [this.mouseReleased[0], this.mouseReleased[2], this.mouseReleased[1]],
        pressCount: [this.mousePressCount[0], this.mousePressCount[2], this.mousePressCount[1]],
        delta: [this.mouseDelta.x, this.mouseDelta.y],
        scroll: [this.mouseScroll.x, this.mouseScroll.y],
        scenePosition: this.scenePosition(),
        connected: this.mouseConnected,
      },
      // Hand tracking is visionOS-only; the web consumer reports no hands.
      hands: { left: null, right: null },
    };
    // An empty array would clear controller state the case injected, so the key
    // is only sent when a pad is really attached.
    const controllers = this.readControllers();
    if (controllers.length) {
      this.sawGamepad = true;
      state.controllers = controllers;
    } else if (this.sawGamepad) {
      state.controllers = [];
    }
    this.keysPressed.clear();
    this.mouseDelta.set(0, 0);
    this.mouseScroll.set(0, 0);
    this.mousePressed = [false, false, false];
    this.mouseReleased = [false, false, false];
    return state;
  }

  /** The world point under the pointer, from the consumer (SPEC 14.3). */
  scenePosition() {
    if (!this.mousePosition || !this.deps.scenePositionAt) return null;
    return this.deps.scenePositionAt(this.mousePosition.x, this.mousePosition.y);
  }

  /**
   * SPEC 14.8: the Gamepad API in the core's `setInput.controllers` shape. The
   * core computes the pressed and released edges, so only levels are reported.
   */
  readControllers() {
    if (!this.gamepadsEnabled || typeof navigator === 'undefined' || !navigator.getGamepads) return [];
    let pads;
    try {
      pads = navigator.getGamepads();
    } catch {
      return [];
    }
    const out = [];
    for (let slot = 0; slot < pads.length; slot++) {
      const pad = pads[slot];
      if (!pad || !pad.connected) continue;
      const axis = (i) => (pad.axes.length > i ? pad.axes[i] : 0);
      const button = (i) => (pad.buttons.length > i ? pad.buttons[i].value : 0);
      out.push({
        id: pad.id ? `${pad.id}#${pad.index}` : `controller-${slot}`,
        name: pad.id || `controller-${slot}`,
        leftThumbstick: [axis(0), -axis(1)],
        rightThumbstick: [axis(2), -axis(3)],
        leftTrigger: button(6),
        rightTrigger: button(7),
        // The standard mapping order, which is what Apple's names line up with.
        buttons: {
          a: button(0),
          b: button(1),
          x: button(2),
          y: button(3),
          leftShoulder: button(4),
          rightShoulder: button(5),
          menu: button(9),
          options: button(8),
          dpadUp: button(12),
          dpadDown: button(13),
          dpadLeft: button(14),
          dpadRight: button(15),
        },
        // P2-B-48: forward which pad was last used and let the core decide.
        current: this.currentController === null ? undefined : this.currentController === pad.index,
      });
    }
    return out;
  }

  /** `controllerRumble`: the vibration actuator, where the browser has one. */
  rumble(controllerId, intensity, duration) {
    if (typeof navigator === 'undefined' || !navigator.getGamepads) return false;
    let pads = [];
    try {
      pads = navigator.getGamepads();
    } catch {
      return false;
    }
    for (const pad of pads) {
      if (!pad || !pad.connected) continue;
      const id = pad.id ? `${pad.id}#${pad.index}` : `controller-${pad.index}`;
      if (controllerId && id !== controllerId && String(pad.index) !== String(controllerId)) continue;
      const actuator = pad.vibrationActuator;
      if (!actuator || typeof actuator.playEffect !== 'function') {
        this.deps.warnOnce('rumble', 'this controller exposes no vibration actuator');
        return false;
      }
      actuator.playEffect('dual-rumble', {
        duration: Math.max(0, (duration || 0) * 1000),
        strongMagnitude: Math.max(0, Math.min(1, intensity || 0)),
        weakMagnitude: Math.max(0, Math.min(1, intensity || 0)),
      }).catch(() => {});
      return true;
    }
    return false;
  }

  // --------------------------------------------------------------- picking

  _updatePointer(e) {
    const el = this.deps.element;
    const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : { left: 0, top: 0, width: 1, height: 1 };
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    this.mouseConnected = true;
    this.pointer.set((x / rect.width) * 2 - 1, -(y / rect.height) * 2 + 1);
    if (!this.mousePosition) this.mousePosition = new THREE.Vector2();
    if (this._lastMouse) this.mouseDelta.add(new THREE.Vector2(x - this._lastMouse.x, y - this._lastMouse.y));
    this.mousePosition.set(x, y);
    this._lastMouse = { x, y };
    return this.pointer;
  }

  pick() {
    this.raycaster.setFromCamera(this.pointer, this.deps.camera);
    const hits = this.raycaster.intersectObjects(this.deps.pickables(), false);
    return hits.length ? hits[0] : null;
  }

  // ---------------------------------------------------------------- events

  onPointerDown(e) {
    this._updatePointer(e);
    if (e.button >= 0 && e.button < 3) {
      this.mouseButtons[e.button] = true;
      this.mousePressed[e.button] = true;
      const at = typeof performance !== 'undefined' ? performance.now() : Date.now();
      // A click within 400 ms of the last one continues the count (SPEC 14.9).
      this.mousePressCount[e.button] = at - this._lastPressAt[e.button] <= 400
        ? this.mousePressCount[e.button] + 1
        : 1;
      this._lastPressAt[e.button] = at;
    }
    if (e.button !== 0) return;
    if (this.deps.element.setPointerCapture) {
      try { this.deps.element.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
    }
    const hit = this.pick();
    if (!hit) return;

    const manipulable = walkUp(hit.object, (o) => this.deps.isManipulable(o));
    if (manipulable) {
      this.manipulation = this._beginPlaneDrag(manipulable, hit.point);
      this.manipulation.startPosition = manipulable.position.clone();
      this.deps.dispatch('manipulationstart', this.deps.idOf(manipulable), {});
      return;
    }

    const draggable = this.deps.interactiveAncestor(hit.object, 'drag');
    const tappable = this.deps.interactiveAncestor(hit.object, 'tap');
    if (!draggable && !tappable) return;
    this.drag = this._beginPlaneDrag(draggable || tappable, hit.point);
    this.drag.dragTarget = draggable;
    this.drag.tapTarget = tappable;
    this.drag.startScreen = { x: e.clientX, y: e.clientY };
    this.drag.moved = false;
    if (draggable) {
      this.deps.dispatch('dragstart', this.deps.idOf(draggable), {
        translation: [0, 0, 0],
        point: [hit.point.x, hit.point.y, hit.point.z],
      });
    }
  }

  _beginPlaneDrag(object, hitPoint) {
    object.updateWorldMatrix(true, false);
    const objectWorld = new THREE.Vector3().setFromMatrixPosition(object.matrixWorld);
    const normal = new THREE.Vector3();
    this.deps.camera.getWorldDirection(normal);
    // Plane through the object's world position, facing the camera.
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal.negate(), objectWorld);
    const start = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(plane, start)) start.copy(hitPoint);
    return { object, plane, start, last: start.clone(), objectWorld };
  }

  _pointOnPlane(session, out = new THREE.Vector3()) {
    this.raycaster.setFromCamera(this.pointer, this.deps.camera);
    if (!this.raycaster.ray.intersectPlane(session.plane, out)) out.copy(session.last);
    session.last.copy(out);
    return out;
  }

  onPointerMove(e) {
    this._updatePointer(e);

    if (this.manipulation) {
      const point = this._pointOnPlane(this.manipulation);
      const delta = point.clone().sub(this.manipulation.start);
      this._moveManipulated(this.manipulation, delta);
      this.deps.dispatch('manipulation', this.deps.idOf(this.manipulation.object), {});
      return;
    }

    if (this.drag) {
      if (Math.hypot(e.clientX - this.drag.startScreen.x, e.clientY - this.drag.startScreen.y) > TAP_SLOP_PX) {
        this.drag.moved = true;
      }
      if (this.drag.dragTarget) {
        const point = this._pointOnPlane(this.drag);
        const delta = point.clone().sub(this.drag.start);
        this.deps.dispatch('drag', this.deps.idOf(this.drag.dragTarget), {
          translation: [delta.x, delta.y, delta.z],
          point: [point.x, point.y, point.z],
        });
      }
      return;
    }

    this._updateHover();
  }

  _updateHover() {
    const hit = this.pick();
    const next = hit ? this.deps.interactiveAncestor(hit.object, 'hover') : null;
    if (next === this.hovered) return;
    if (this.hovered) this.deps.dispatch('hoverexit', this.deps.idOf(this.hovered), {});
    this.hovered = next;
    if (next) this.deps.dispatch('hoverenter', this.deps.idOf(next), {});
  }

  /** Manipulation is native-driven: the consumer moves the object and syncs it back. */
  _moveManipulated(session, worldDelta) {
    const object = session.object;
    const parent = object.parent;
    const worldTarget = session.objectWorld.clone().add(worldDelta);
    if (parent) {
      parent.updateWorldMatrix(true, false);
      const inverse = new THREE.Matrix4().copy(parent.matrixWorld).invert();
      object.position.copy(worldTarget.applyMatrix4(inverse));
    } else {
      object.position.copy(worldTarget);
    }
    object.updateMatrixWorld(true);
  }

  onPointerUp(e) {
    if (e.button >= 0 && e.button < 3) {
      this.mouseButtons[e.button] = false;
      this.mouseReleased[e.button] = true;
    }
    this._updatePointer(e);
    // Only the left button starts a drag, so only the left button ends one.
    if (e.button !== undefined && e.button !== 0) return;

    if (this.manipulation) {
      this.deps.dispatch('manipulationend', this.deps.idOf(this.manipulation.object), {});
      this.manipulation = null;
      return;
    }
    if (!this.drag) return;
    const session = this.drag;
    this.drag = null;
    if (session.dragTarget) {
      const point = this._pointOnPlane(session);
      const delta = point.clone().sub(session.start);
      this.deps.dispatch('dragend', this.deps.idOf(session.dragTarget), {
        translation: [delta.x, delta.y, delta.z],
        point: [point.x, point.y, point.z],
      });
    }
    if (!session.moved && session.tapTarget) {
      const hit = this.pick();
      const point = hit ? hit.point : session.start;
      this.deps.dispatch('tap', this.deps.idOf(session.tapTarget), { point: [point.x, point.y, point.z] });
    }
  }

  onPointerLeave() {
    if (this.hovered) {
      this.deps.dispatch('hoverexit', this.deps.idOf(this.hovered), {});
      this.hovered = null;
    }
    // A pointer that leaves the canvas cannot finish its gesture, so close it.
    this.endSessions();
    this.mousePosition = null;
    this._lastMouse = null;
  }

  /** Ends any drag or manipulation in progress, dispatching the closing event. */
  endSessions() {
    if (this.manipulation) {
      this.deps.dispatch('manipulationend', this.deps.idOf(this.manipulation.object), {});
      this.manipulation = null;
    }
    if (this.drag) {
      const session = this.drag;
      this.drag = null;
      if (session.dragTarget) {
        const delta = session.last.clone().sub(session.start);
        this.deps.dispatch('dragend', this.deps.idOf(session.dragTarget), {
          translation: [delta.x, delta.y, delta.z],
          point: [session.last.x, session.last.y, session.last.z],
        });
      }
    }
  }

  /** Drops every reference to scene objects, for a hot swap (WEB-21). */
  clearSessions() {
    this.hovered = null;
    this.drag = null;
    this.manipulation = null;
    this.keysDown.clear();
    this.keysPressed.clear();
    this.mouseDelta.set(0, 0);
    this.mouseScroll.set(0, 0);
    this.mousePressed = [false, false, false];
    this.mouseReleased = [false, false, false];
    this.mousePressCount = [0, 0, 0];
    this._lastMouse = null;
    this.sawGamepad = false;
    this.currentController = null;
  }

  /** World transforms of objects the consumer is currently driving. */
  manipulatedObjects() {
    return this.manipulation ? [this.manipulation.object] : [];
  }
}

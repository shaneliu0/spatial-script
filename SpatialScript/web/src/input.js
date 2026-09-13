// Pointer, keyboard and manipulation input for the web consumer (SPEC 3.8).
// Pointer events are raycast against the scene; drag translation is measured on
// the plane through the object's world position that faces the camera, so an
// on-screen drag maps 1:1 to world displacement.

import * as THREE from 'three';
import { walkUp } from './scene-walk.js';

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
    const target = el.ownerDocument ? el.ownerDocument.defaultView : null;
    if (target) {
      this._bind(target, 'keydown', (e) => this.onKeyDown(e));
      this._bind(target, 'keyup', (e) => this.onKeyUp(e));
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
    if (!this.keysDown.has(e.code)) this.keysPressed.add(e.code);
    this.keysDown.add(e.code);
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
      keyboard: { down: [...this.keysDown], pressed: [...this.keysPressed] },
      mouse: {
        position: this.mousePosition ? [this.mousePosition.x, this.mousePosition.y] : null,
        buttons: [this.mouseButtons[0], this.mouseButtons[2], this.mouseButtons[1]],
        delta: [this.mouseDelta.x, this.mouseDelta.y],
      },
      // Hand tracking is visionOS-only; the web consumer reports no hands.
      hands: { left: null, right: null },
    };
    this.keysPressed.clear();
    this.mouseDelta.set(0, 0);
    return state;
  }

  // --------------------------------------------------------------- picking

  _updatePointer(e) {
    const el = this.deps.element;
    const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : { left: 0, top: 0, width: 1, height: 1 };
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
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
    if (e.button >= 0 && e.button < 3) this.mouseButtons[e.button] = true;
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
    if (e.button >= 0 && e.button < 3) this.mouseButtons[e.button] = false;
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
    this._lastMouse = null;
  }

  /** World transforms of objects the consumer is currently driving. */
  manipulatedObjects() {
    return this.manipulation ? [this.manipulation.object] : [];
  }
}

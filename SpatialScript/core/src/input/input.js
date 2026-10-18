// Polled input state (SPEC 3.8). Refreshed once per frame from setInput() and
// from Spatial.inject.key().

import { Vector2, Vector3, Quaternion } from "../util/three-exports.js";
import { push } from "../util/builtins.js";
import { clamp, finite } from "../util/sanitize.js";
import { MAX_CONTROLLERS, MAX_NAME_LENGTH } from "../util/limits.js";
import { host } from "../host/host.js";

/** Two clicks closer together than this are one double click (SPEC 14.9). */
const MULTI_CLICK_SECONDS = 0.4;

/** The buttons every controller reports, in the order 14.8 lists them. */
export const CONTROLLER_BUTTONS = [
  "a",
  "b",
  "x",
  "y",
  "leftShoulder",
  "rightShoulder",
  "dpadUp",
  "dpadDown",
  "dpadLeft",
  "dpadRight",
  "menu",
  "options",
];

const HAND_JOINT_NAMES = [
  "wrist",
  "forearmWrist",
  "forearmArm",
  "thumbKnuckle",
  "thumbIntermediateBase",
  "thumbIntermediateTip",
  "thumbTip",
  "indexFingerMetacarpal",
  "indexFingerKnuckle",
  "indexFingerIntermediateBase",
  "indexFingerIntermediateTip",
  "indexFingerTip",
  "middleFingerMetacarpal",
  "middleFingerKnuckle",
  "middleFingerIntermediateBase",
  "middleFingerIntermediateTip",
  "middleFingerTip",
  "ringFingerMetacarpal",
  "ringFingerKnuckle",
  "ringFingerIntermediateBase",
  "ringFingerIntermediateTip",
  "ringFingerTip",
  "littleFingerMetacarpal",
  "littleFingerKnuckle",
  "littleFingerIntermediateBase",
  "littleFingerIntermediateTip",
  "littleFingerTip",
];

const HAND_JOINT_SET = new Set(HAND_JOINT_NAMES);

class Keyboard {
  constructor() {
    this.down = new Set();
    this.pressed = new Set();
    this.connected = false;
  }

  isDown(code) {
    return this.down.has(code);
  }

  wasPressed(code) {
    return this.pressed.has(code);
  }
}

/** One button's state for a frame: level, both edges, and a click count. */
export class ButtonState {
  constructor() {
    this.down = false;
    this.pressed = false;
    this.released = false;
    this.value = 0;
    this.pressCount = 0;
    this._lastPress = -Infinity;
  }

  _update(down, value, elapsed) {
    const wasDown = this.down;
    this.down = down === true;
    this.value = clamp(value, 0, 1, this.down ? 1 : 0);
    this.pressed = this.down && !wasDown;
    this.released = !this.down && wasDown;
    if (this.pressed) {
      this.pressCount = elapsed - this._lastPress <= MULTI_CLICK_SECONDS ? this.pressCount + 1 : 1;
      this._lastPress = elapsed;
    }
  }
}

class Mouse {
  constructor() {
    this.position = null;
    // The world point under the pointer, fed by the consumer (SPEC 14.3).
    this.scenePosition = null;
    // Kept as plain booleans: scripts written against phase 1 still read them.
    this.buttons = { left: false, right: false, middle: false };
    this.delta = new Vector2();
    this.scroll = new Vector2();
    this.connected = false;
    this.left = new ButtonState();
    this.right = new ButtonState();
    this.middle = new ButtonState();
  }
}

/** One button of a game controller (SPEC 14.8). */
class ControllerButton extends ButtonState {}

export class Controller {
  constructor(id) {
    this.id = id;
    this.name = "";
    this.leftThumbstick = new Vector2();
    this.rightThumbstick = new Vector2();
    this.leftTrigger = 0;
    this.rightTrigger = 0;
    for (const name of CONTROLLER_BUTTONS) this[name] = new ControllerButton();
    // When this controller last produced input. -1 means "connected, never
    // used", which is what keeps `current` null until someone touches one.
    this._seen = -1;
  }

  /** Haptics where the consumer has them; a warning where it does not. */
  rumble(intensity, duration) {
    const runtime = host();
    if (runtime === null) return this;
    // The command always goes out (SPEC 14.13); a consumer without haptics
    // ignores it, and the script is told once that it will.
    if (runtime.env.capabilities.controllers !== true) {
      runtime.warnOnce(
        "controller-rumble",
        "Controller.rumble has no haptics on this consumer; the request has no effect",
      );
    }
    runtime.queueCommand([
      "controllerRumble",
      0,
      this.id,
      clamp(intensity, 0, 1, 1),
      Math.max(0, finite(duration, 0.2)),
    ]);
    return this;
  }

  /**
   * Folds one consumer record in and reports whether anything the player did
   * changed, which is what "most recently used" means (SPEC 14.8, P2-B-47).
   */
  _update(json, elapsed) {
    const before = this._signature();
    if (typeof json.name === "string") {
      this.name = json.name.length > MAX_NAME_LENGTH ? json.name.slice(0, MAX_NAME_LENGTH) : json.name;
    }
    const left = json.leftThumbstick;
    if (Array.isArray(left)) this.leftThumbstick.set(clamp(left[0], -1, 1, 0), clamp(left[1], -1, 1, 0));
    else this.leftThumbstick.set(0, 0);
    const right = json.rightThumbstick;
    if (Array.isArray(right)) this.rightThumbstick.set(clamp(right[0], -1, 1, 0), clamp(right[1], -1, 1, 0));
    else this.rightThumbstick.set(0, 0);
    this.leftTrigger = clamp(json.leftTrigger, 0, 1, 0);
    this.rightTrigger = clamp(json.rightTrigger, 0, 1, 0);

    const buttons = json.buttons;
    for (let i = 0; i < CONTROLLER_BUTTONS.length; i += 1) {
      const name = CONTROLLER_BUTTONS[i];
      const raw = buttons === undefined || buttons === null ? undefined : buttons[name];
      const value = typeof raw === "number" ? raw : raw === true ? 1 : 0;
      this[name]._update(value > 0, value, elapsed);
    }
    return this._signature() !== before;
  }

  /** Everything a player can move, as one comparable string. */
  _signature() {
    let out = `${this.leftThumbstick.x},${this.leftThumbstick.y},${this.rightThumbstick.x},` +
      `${this.rightThumbstick.y},${this.leftTrigger},${this.rightTrigger}`;
    for (let i = 0; i < CONTROLLER_BUTTONS.length; i += 1) {
      out += `,${this[CONTROLLER_BUTTONS[i]].value}`;
    }
    return out;
  }

  toJSON() {
    const buttons = {};
    for (const name of CONTROLLER_BUTTONS) buttons[name] = this[name].value;
    return {
      id: this.id,
      name: this.name,
      leftThumbstick: [this.leftThumbstick.x, this.leftThumbstick.y],
      rightThumbstick: [this.rightThumbstick.x, this.rightThumbstick.y],
      leftTrigger: this.leftTrigger,
      rightTrigger: this.rightTrigger,
      buttons,
    };
  }
}

/** `Spatial.input.controllers` (SPEC 14.8). */
class ControllerSet {
  constructor() {
    this.all = [];
    this.current = null;
    this._byId = new Map();
  }

  get connected() {
    return this.all.length;
  }

  get(id) {
    const controller = this._byId.get(id);
    return controller === undefined ? null : controller;
  }
}

export class Hand {
  constructor() {
    this.isTracked = false;
    this.isPinching = false;
    this._joints = new Map();
  }

  joint(name) {
    if (!HAND_JOINT_SET.has(name)) return null;
    const record = this._joints.get(name);
    return record === undefined ? null : record;
  }

  _update(json) {
    this.isTracked = json.isTracked === true;
    this.isPinching = json.isPinching === true;
    this._joints.clear();
    const joints = json.joints;
    if (!joints) return;
    for (const name of Object.keys(joints)) {
      if (!HAND_JOINT_SET.has(name)) continue;
      const v = joints[name];
      if (!v || v.length < 7) continue;
      this._joints.set(name, {
        position: new Vector3(v[0], v[1], v[2]),
        quaternion: new Quaternion(v[3], v[4], v[5], v[6]),
      });
    }
  }
}

export class InputState {
  constructor() {
    this.keyboard = new Keyboard();
    this.mouse = new Mouse();
    this.hands = { left: null, right: null };
    this.controllers = new ControllerSet();
    // Connection changes the frame loop turns into scene events (SPEC 14.8).
    this.connectionEvents = [];
    this._injectedControllers = null;
    // Monotonic "who moved last" counter behind `controllers.current`.
    this._useCounter = 0;
    this._injectedDown = new Set();
    this._released = new Set();
  }

  /**
   * Folds the consumer's state and any injected key transitions into the
   * polled state for the coming frame.
   */
  beginFrame(pendingInput, injectedKeys, elapsed = 0) {
    const previousDown = this.keyboard.down;
    const pressed = this.keyboard.pressed;
    pressed.clear();

    // Injected releases have to be applied before the carried-forward set is
    // built, or a key released through inject.key(code, false) with no
    // consumer input that frame would stay down forever.
    const released = this._released;
    released.clear();
    for (const entry of injectedKeys) {
      if (entry.down) {
        this._injectedDown.add(entry.code);
        released.delete(entry.code);
      } else {
        this._injectedDown.delete(entry.code);
        released.add(entry.code);
      }
    }

    let nextDown;
    if (pendingInput && pendingInput.keyboard) {
      nextDown = new Set(pendingInput.keyboard.down || []);
      for (const code of pendingInput.keyboard.pressed || []) pressed.add(code);
    } else {
      nextDown = new Set(previousDown);
    }

    for (const code of released) nextDown.delete(code);
    for (const code of this._injectedDown) nextDown.add(code);
    for (const code of nextDown) if (!previousDown.has(code)) pressed.add(code);
    this.keyboard.down = nextDown;

    if (pendingInput && pendingInput.keyboard && pendingInput.keyboard.connected !== undefined) {
      this.keyboard.connected = pendingInput.keyboard.connected === true;
    }

    // "Since last frame": with no input this frame there was no motion.
    this.mouse.delta.set(0, 0);
    this.mouse.scroll.set(0, 0);
    if (pendingInput && pendingInput.mouse) {
      const mouse = pendingInput.mouse;
      if (mouse.position === null || mouse.position === undefined) {
        this.mouse.position = null;
      } else {
        if (this.mouse.position === null) this.mouse.position = new Vector2();
        this.mouse.position.set(mouse.position[0], mouse.position[1]);
      }
      const scene = mouse.scenePosition;
      if (Array.isArray(scene) && scene.length >= 3) {
        if (this.mouse.scenePosition === null) this.mouse.scenePosition = new Vector3();
        this.mouse.scenePosition.set(scene[0], scene[1], scene[2]);
      } else {
        this.mouse.scenePosition = null;
      }
      const buttons = mouse.buttons || [false, false, false];
      this.mouse.buttons.left = buttons[0] === true;
      this.mouse.buttons.right = buttons[1] === true;
      this.mouse.buttons.middle = buttons[2] === true;
      const delta = mouse.delta || [0, 0];
      this.mouse.delta.set(delta[0], delta[1]);
      const scroll = mouse.scroll;
      if (Array.isArray(scroll)) this.mouse.scroll.set(finite(scroll[0], 0), finite(scroll[1], 0));
      if (mouse.connected !== undefined) this.mouse.connected = mouse.connected === true;
      else if (mouse.position !== null && mouse.position !== undefined) this.mouse.connected = true;
    }

    // Per-button edges are computed here rather than trusted from the
    // consumer, so every backend reports the same pressed/released frame.
    this.mouse.left._update(this.mouse.buttons.left, this.mouse.buttons.left ? 1 : 0, elapsed);
    this.mouse.right._update(this.mouse.buttons.right, this.mouse.buttons.right ? 1 : 0, elapsed);
    this.mouse.middle._update(this.mouse.buttons.middle, this.mouse.buttons.middle ? 1 : 0, elapsed);

    this._updateControllers(pendingInput, elapsed);

    if (pendingInput && pendingInput.hands) {
      for (const side of ["left", "right"]) {
        const json = pendingInput.hands[side];
        if (!json) {
          this.hands[side] = null;
          continue;
        }
        if (this.hands[side] === null) this.hands[side] = new Hand();
        this.hands[side]._update(json);
      }
    }
  }
}

/** Controller state from setInput, or from Spatial.inject.controller. */
InputState.prototype._updateControllers = function _updateControllers(pendingInput, elapsed) {
  let list = null;
  if (this._injectedControllers !== null) {
    list = this._injectedControllers;
    this._injectedControllers = null;
  } else if (pendingInput && Array.isArray(pendingInput.controllers)) {
    list = pendingInput.controllers;
  }
  const set = this.controllers;
  if (list === null) {
    // No news: the level state stands, but this frame's edges are over.
    for (let i = 0; i < set.all.length; i += 1) {
      const controller = set.all[i];
      for (let k = 0; k < CONTROLLER_BUTTONS.length; k += 1) {
        const button = controller[CONTROLLER_BUTTONS[k]];
        button.pressed = false;
        button.released = false;
      }
    }
    return;
  }

  const seen = new Set();
  const runtime = host();
  for (let i = 0; i < list.length && i < MAX_CONTROLLERS; i += 1) {
    const json = list[i];
    if (json === null || typeof json !== "object") continue;
    // A consumer that omits the id gets a stable one from its slot, so a
    // half-filled record still produces a usable controller.
    const id = typeof json.id === "string" && json.id.length > 0 ? json.id : `controller-${i}`;
    let controller = set._byId.get(id);
    if (controller === undefined) {
      controller = new Controller(id);
      set._byId.set(id, controller);
      push(this.connectionEvents, { type: "controllerconnected", controller });
    }
    // "Most recently used" is by latest input change, so connecting alone does
    // not make a controller current (SPEC 14.8, P2-B-47).
    const moved = controller._update(json, elapsed);
    if (moved || json.current === true) {
      this._useCounter += 1;
      controller._seen = this._useCounter;
    }
    seen.add(id);
  }
  if (list.length > MAX_CONTROLLERS && runtime !== null) {
    runtime.warnOnce(
      "controller-count",
      `More than ${MAX_CONTROLLERS} controllers were reported; the rest were dropped`,
    );
  }

  for (const [id, controller] of set._byId) {
    if (seen.has(id)) continue;
    set._byId.delete(id);
    push(this.connectionEvents, { type: "controllerdisconnected", controller });
  }

  const all = [];
  let current = null;
  for (const controller of set._byId.values()) {
    push(all, controller);
    if (controller._seen >= 0 && (current === null || controller._seen > current._seen)) {
      current = controller;
    }
  }
  set.all = all;
  set.current = current;
};

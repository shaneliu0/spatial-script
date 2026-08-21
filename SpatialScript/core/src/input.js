// Polled input state (SPEC 3.8). Refreshed once per frame from setInput() and
// from Spatial.inject.key().

import { Vector2, Vector3, Quaternion } from "./three-exports.js";

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

export class Keyboard {
  constructor() {
    this.down = new Set();
    this.pressed = new Set();
  }

  isDown(code) {
    return this.down.has(code);
  }

  wasPressed(code) {
    return this.pressed.has(code);
  }
}

export class Mouse {
  constructor() {
    this.position = null;
    this.buttons = { left: false, right: false, middle: false };
    this.delta = new Vector2();
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
    this._injectedDown = new Set();
    this._released = new Set();
  }

  /**
   * Folds the consumer's state and any injected key transitions into the
   * polled state for the coming frame.
   */
  beginFrame(pendingInput, injectedKeys) {
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

    // "Since last frame": with no input this frame there was no motion.
    this.mouse.delta.set(0, 0);
    if (pendingInput && pendingInput.mouse) {
      const mouse = pendingInput.mouse;
      if (mouse.position === null || mouse.position === undefined) {
        this.mouse.position = null;
      } else {
        if (this.mouse.position === null) this.mouse.position = new Vector2();
        this.mouse.position.set(mouse.position[0], mouse.position[1]);
      }
      const buttons = mouse.buttons || [false, false, false];
      this.mouse.buttons.left = buttons[0] === true;
      this.mouse.buttons.right = buttons[1] === true;
      this.mouse.buttons.middle = buttons[2] === true;
      const delta = mouse.delta || [0, 0];
      this.mouse.delta.set(delta[0], delta[1]);
    }

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

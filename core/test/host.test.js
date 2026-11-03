// SPEC 14.3 cameras and pointer queries, 14.10 lifecycle and the host channel,
// and the consumer-performed fetches of 14.11.

import test from "node:test";
import assert from "node:assert/strict";
import { createHost, commandsFor, plain, transformIds } from "./helpers.mjs";

test("14.3 the active camera is named by its own id and its pose rides transforms", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const camera = new S.PerspectiveCamera(50, 1, 0.1, 100);
    camera.name = "eye";
    camera.position.set(0, 1, 3);
    scene.add(camera);
    S.camera = camera;
    S.onFrame(() => {
      if (S.time.frame === 3) camera.position.x = 2;
      if (S.time.frame === 4) S.camera = null;
    });
    S.mount(scene);
  `);
  const first = host.tick();
  const command = commandsFor(first, "camera")[0];
  const cameraId = host.idFor("eye");
  assert.equal(command[1], cameraId, "the command names the camera object");
  assert.equal(command[2].kind, "perspective");
  assert.equal(command[2].fov, 50);
  assert.equal(command[2].near, 0.1);
  assert.equal(command[2].far, 100);
  assert.equal(command[2].transform, undefined, "the pose is not in the payload any more");
  assert.ok(
    transformIds(first).includes(cameraId),
    "the camera's pose arrives through transforms like any object",
  );

  assert.equal(commandsFor(host.tick(), "camera").length, 0, "an unchanged camera is silent");
  const moved = host.tick();
  assert.equal(commandsFor(moved, "camera").length, 0, "moving it is a transform, not a camera command");
  assert.ok(transformIds(moved).includes(cameraId));

  const cleared = commandsFor(host.tick(), "camera")[0];
  assert.equal(cleared[1], 0, "clearing hands the viewport back to the consumer");
  assert.equal(cleared[2].kind, null);
});

test("14.3 a camera that was never added to the scene is still created and flushed", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const camera = new S.PerspectiveCamera(60, 1, 0.1, 100);
    camera.name = "free";
    camera.position.set(0, 0.25, 1.4);
    S.camera = camera;
    S.mount(scene);
  `);
  const first = host.tick();
  const command = commandsFor(first, "camera")[0];
  const created = commandsFor(first, "create").find((entry) => entry[3] === "free");
  assert.ok(created, "the camera is created even though it is not in the scene");
  assert.equal(command[1], created[1], "the camera command names it");
  assert.ok(transformIds(first).includes(created[1]), "and its pose is flushed");
});

test("14.3 an orthographic camera reports its own parameters", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    S.camera = new S.OrthographicCamera(-2, 2, 1, -1, 0.1, 50);
    S.mount(scene);
  `);
  const payload = commandsFor(host.tick(), "camera")[0][2];
  assert.equal(payload.kind, "orthographic");
  assert.deepEqual([payload.left, payload.right, payload.top, payload.bottom], [-2, 2, 1, -1]);
  assert.equal(payload.fov, null);
});

test("14.3 aspect is the consumer's, and visionOS keeps the camera but warns", () => {
  const host = createHost({ backend: "realitykit", platform: "visionos" });
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const camera = new S.PerspectiveCamera(60, 1, 0.1, 100);
    camera.aspect = 2.5;
    S.camera = camera;
    S.mount(scene);
  `, { backend: "realitykit", platform: "visionos" });
  host.tick();
  const dump = host.dump();
  assert.ok(dump.warnings.some((warning) => /aspect is managed by the consumer/.test(warning)));
  assert.ok(dump.warnings.some((warning) => /the user is the camera/.test(warning)));
  assert.equal(dump.camera.kind, "perspective", "the state is kept and reported");
});

test("14.3 rayFromPoint uses the consumer hook and is null without one", () => {
  const withHook = createHost({
    native: {
      log() {},
      now: () => Date.now(),
      rayFromPoint: (x, y) => new Float32Array([x, y, 0, 0, 0, -1]),
    },
  });
  withHook.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    S.onFrame(() => {
      const ray = S.rayFromPoint(4, 5);
      scene.userData.origin = ray === null ? null : ray.origin.toArray();
      scene.userData.direction = ray === null ? null : ray.direction.toArray();
    });
    S.mount(scene);
  `);
  withHook.tick();
  assert.deepEqual(plain(withHook.dump().scene.userData.origin), [4, 5, 0]);
  assert.deepEqual(plain(withHook.dump().scene.userData.direction), [0, 0, -1]);

  const without = createHost();
  without.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    S.onFrame(() => { scene.userData.ray = S.rayFromPoint(1, 1); });
    S.mount(scene);
  `);
  without.tick();
  assert.equal(without.dump().scene.userData.ray, null);
  assert.ok(without.dump().warnings.some((warning) => /rayFromPoint hook/.test(warning)));
});

test("14.3 the consumer feeds mouse.scenePosition", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    S.onFrame(() => {
      const point = S.input.mouse.scenePosition;
      scene.userData.point = point === null ? null : point.toArray();
    });
    S.mount(scene);
  `);
  host.spatial.setInput({ mouse: { position: [10, 20], scenePosition: [0.5, 0, -1] } });
  host.tick();
  assert.deepEqual(plain(host.dump().scene.userData.point), [0.5, 0, -1]);
  host.spatial.setInput({ mouse: { position: [10, 20] } });
  host.tick();
  assert.equal(host.dump().scene.userData.point, null);
});

test("14.10 the host channel carries events both ways", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    scene.userData.received = [];
    S.host.on("score", (payload) => { scene.userData.received.push(payload.value); });
    this.on("score", (payload) => { scene.userData.alias = payload.value; });
    S.onFrame(() => {
      if (S.time.frame === 1) S.host.send("ready", { level: 3 });
    });
    S.mount(scene);
  `);
  const sent = commandsFor(host.tick(), "hostEvent")[0];
  assert.equal(sent[1], 0);
  assert.equal(sent[2], "ready");
  assert.deepEqual(plain(sent[3]), { level: 3 });

  host.spatial.hostEvent("score", { value: 7 });
  assert.deepEqual(plain(host.dump().scene.userData.received), [7]);
  assert.equal(host.dump().scene.userData.alias, 7, "this.on is the same channel");
});

test("14.10 host.call resolves through hostResult and rejects an unknown function", async () => {
  const host = createHost();
  host.spatial.setHostFunctions(["MyApp.save"]);
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    scene.userData.functions = S.host.functions;
    S.host.call("MyApp.save", { slot: 1 }).then(
      (value) => { scene.userData.saved = value; },
      (error) => { scene.userData.saveError = error.message; },
    );
    S.host.call("MyApp.missing").catch((error) => {
      scene.userData.unknown = error.message;
      scene.userData.unknownFeature = error.feature;
    });
    S.mount(scene);
  `);
  const call = commandsFor(host.tick(), "hostCall")[0];
  assert.equal(call[2], "MyApp.save");
  assert.deepEqual(plain(call[3]), { slot: 1 });
  assert.deepEqual(plain(host.dump().scene.userData.functions), ["MyApp.save"]);

  host.spatial.dispatch("hostResult", call[1], { value: { ok: true } });
  host.tick();
  await Promise.resolve();
  await Promise.resolve();
  const dump = host.dump();
  assert.deepEqual(plain(dump.scene.userData.saved), { ok: true });
  assert.match(dump.scene.userData.unknown, /is not registered/);
  assert.equal(dump.scene.userData.unknownFeature, "host-function");
  assert.equal(commandsFor(host.frames[0], "hostCall").length, 1, "the unknown call never reached the wire");
});

test("14.11 fetchText and fetchJSON go through the consumer", async () => {
  const host = createHost();
  host.load(
    `
    const S = require("spatial");
    const scene = new S.Scene();
    S.fetchText("data/notes.txt").then((text) => { scene.userData.text = text; });
    S.fetchJSON("data/config.json").then((json) => { scene.userData.json = json; });
    S.fetchText("../../../../etc/passwd").catch((error) => { scene.userData.refused = error.message; });
    S.mount(scene);
  `,
    { assetRoot: "assets" },
  );
  const requests = commandsFor(host.tick(), "fetch");
  assert.equal(requests.length, 2, "the refused url never became a request");
  assert.equal(requests[0][2].url, "assets/data/notes.txt");
  assert.equal(requests[0][2].kind, "text");
  assert.equal(requests[1][2].kind, "json");

  host.spatial.dispatch("fetchResult", requests[0][1], { text: "hello" });
  host.spatial.dispatch("fetchResult", requests[1][1], { json: { mode: "fast" } });
  host.tick();
  await Promise.resolve();
  await Promise.resolve();
  const dump = host.dump();
  assert.equal(dump.scene.userData.text, "hello");
  assert.deepEqual(plain(dump.scene.userData.json), { mode: "fast" });
  assert.match(dump.scene.userData.refused, /was refused/);
});

test("14.10 setActive runs the hooks and pauses the frame loop", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    scene.userData.log = [];
    this.didActivate = () => { scene.userData.log.push("activate"); };
    this.willDeactivate = () => { scene.userData.log.push("deactivate"); };
    let timer = 0;
    setInterval(() => { timer += 1; scene.userData.timer = timer; }, 1 / 30);
    S.onFrame(() => { scene.userData.frame = S.time.frame; });
    S.mount(scene);
  `);
  host.tick();
  host.tick();
  const frameBefore = host.dump().scene.userData.frame;
  const timerBefore = host.dump().scene.userData.timer;

  host.spatial.setActive(false);
  assert.deepEqual(plain(host.dump().scene.userData.log), ["deactivate"]);
  const paused = host.tick();
  assert.equal(paused.length, 0, "an inactive tick produces no commands");
  assert.equal(host.dump().scene.userData.frame, frameBefore, "the frame did not advance");
  assert.equal(host.dump().scene.userData.timer, timerBefore, "timers did not advance");
  assert.equal(host.dump().isActive, false);

  host.spatial.setActive(true);
  assert.deepEqual(plain(host.dump().scene.userData.log), ["deactivate", "activate"]);
  host.tick();
  assert.equal(host.dump().scene.userData.frame, frameBefore + 1);
});

test("14.10 a reload hands the previous state to scriptChanged", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    this.state = { score: 12, name: "run" };
    S.mount(scene);
  `);
  host.tick();
  const state = host.spatial.captureState();
  assert.deepEqual(plain(state), { score: 12, name: "run" });

  host.load(
    `
    const S = require("spatial");
    const scene = new S.Scene();
    this.scriptChanged = (previous) => { scene.userData.restored = previous; };
    S.mount(scene);
  `,
    {},
    { previousState: state },
  );
  host.tick();
  assert.deepEqual(plain(host.dump().scene.userData.restored), { score: 12, name: "run" });

  // Without a preserved state the hook is not called at all.
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    scene.userData.called = false;
    this.scriptChanged = () => { scene.userData.called = true; };
    S.mount(scene);
  `);
  host.tick();
  assert.equal(host.dump().scene.userData.called, false);
});

test("14.8 controllers arrive through setInput with edges and connection events", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    scene.userData.events = [];
    scene.addEventListener("controllerconnected", (event) => {
      scene.userData.events.push("connected:" + event.controller.id);
    });
    scene.addEventListener("controllerdisconnected", (event) => {
      scene.userData.events.push("disconnected:" + event.controller.id);
    });
    S.onFrame(() => {
      const pad = S.input.controllers.current;
      scene.userData.connected = S.input.controllers.connected;
      if (pad === null) { scene.userData.pad = null; return; }
      scene.userData.pad = {
        id: pad.id,
        name: pad.name,
        stick: pad.leftThumbstick.toArray(),
        trigger: pad.rightTrigger,
        aDown: pad.a.down,
        aPressed: pad.a.pressed,
        aReleased: pad.a.released,
      };
    });
    S.mount(scene);
  `);
  host.spatial.setInput({
    controllers: [
      {
        id: "pad-1",
        name: "Xbox",
        leftThumbstick: [0.5, -0.25],
        rightTrigger: 0.75,
        buttons: { a: 1 },
        current: true,
      },
    ],
  });
  host.tick();
  let dump = host.dump();
  assert.deepEqual(plain(dump.scene.userData.events), ["connected:pad-1"]);
  assert.equal(dump.scene.userData.connected, 1);
  assert.deepEqual(plain(dump.scene.userData.pad), {
    id: "pad-1",
    name: "Xbox",
    stick: [0.5, -0.25],
    trigger: 0.75,
    aDown: true,
    aPressed: true,
    aReleased: false,
  });

  host.spatial.setInput({ controllers: [{ id: "pad-1", buttons: { a: 0 } }] });
  host.tick();
  dump = host.dump();
  assert.equal(dump.scene.userData.pad.aDown, false);
  assert.equal(dump.scene.userData.pad.aReleased, true);

  host.spatial.setInput({ controllers: [] });
  host.tick();
  dump = host.dump();
  assert.deepEqual(plain(dump.scene.userData.events), ["connected:pad-1", "disconnected:pad-1"]);
  assert.equal(dump.scene.userData.connected, 0);
});

test("14.8 an injected controller with missing fields still reads cleanly", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    S.onFrame(() => {
      // A controller that has not been touched is connected but is not the
      // current one (SPEC 14.8), so this reads the set, not the active one.
      const pad = S.input.controllers.all[0];
      scene.userData.current = S.input.controllers.current;
      scene.userData.pad = pad === undefined ? null : {
        id: pad.id,
        name: pad.name,
        left: pad.leftThumbstick.toArray(),
        trigger: pad.leftTrigger,
        menu: pad.menu.down,
        buttons: pad.b.value,
      };
    });
    S.mount(scene);
  `);
  host.spatial.Spatial.inject.controller({});
  host.tick();
  assert.equal(host.dump().scene.userData.current, null, "connecting alone is not using it");
  assert.deepEqual(plain(host.dump().scene.userData.pad), {
    id: "controller-0",
    name: "",
    left: [0, 0],
    trigger: 0,
    menu: false,
    buttons: 0,
  });
});

test("14.9 mouse buttons report edges, click counts and scroll", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    S.onFrame(() => {
      const mouse = S.input.mouse;
      scene.userData.state = {
        down: mouse.left.down,
        pressed: mouse.left.pressed,
        released: mouse.left.released,
        count: mouse.left.pressCount,
        legacy: mouse.buttons.left,
        scroll: mouse.scroll.toArray(),
        connected: mouse.connected,
        keyboard: S.input.keyboard.connected,
      };
    });
    S.mount(scene);
  `);
  host.spatial.setInput({ mouse: { position: [0, 0], buttons: [true, false, false], scroll: [0, 3] }, keyboard: { down: [], connected: true } });
  host.tick();
  let state = plain(host.dump().scene.userData.state);
  assert.deepEqual(state, {
    down: true,
    pressed: true,
    released: false,
    count: 1,
    legacy: true,
    scroll: [0, 3],
    connected: true,
    keyboard: true,
  });

  host.spatial.setInput({ mouse: { position: [0, 0], buttons: [false, false, false] } });
  host.tick();
  host.spatial.setInput({ mouse: { position: [0, 0], buttons: [true, false, false] } });
  host.tick();
  state = plain(host.dump().scene.userData.state);
  assert.equal(state.count, 2, "a second click inside 400 ms is a double click");
  assert.deepEqual(state.scroll, [0, 0], "scroll is per frame");
});

test("14.8 rumble reaches the consumer and host.off stops a handler", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    scene.userData.seen = [];
    const handler = (payload) => { scene.userData.seen.push(payload.n); };
    S.host.on("ping", handler);
    S.onFrame(() => {
      if (S.time.frame === 2) {
        const pad = S.input.controllers.get("pad-1");
        if (pad !== null) pad.rumble(0.5, 0.2);
        S.host.off("ping", handler);
      }
    });
    S.mount(scene);
  `);
  host.spatial.setInput({ controllers: [{ id: "pad-1" }] });
  host.tick();
  host.spatial.hostEvent("ping", { n: 1 });
  const frame = host.tick();
  const rumble = commandsFor(frame, "controllerRumble")[0];
  assert.deepEqual(plain(rumble.slice(1)), [0, "pad-1", 0.5, 0.2]);

  host.spatial.hostEvent("ping", { n: 2 });
  assert.deepEqual(plain(host.dump().scene.userData.seen), [1], "off removed the handler");
});

test("14.10 a host handler that throws is reported and does not stop the channel", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    scene.userData.second = false;
    S.host.on("go", () => { throw new Error("handler exploded"); });
    S.host.on("go", () => { scene.userData.second = true; });
    S.mount(scene);
  `);
  host.tick();
  host.spatial.hostEvent("go", {});
  host.tick();
  const dump = host.dump();
  assert.equal(dump.scene.userData.second, true, "the second handler still ran");
  assert.ok(dump.errors.some((error) => /handler exploded/.test(error)));
});

test("14.8 controllerRumble is a command on every consumer, with a warning where there are no haptics", () => {
  const host = createHost({ backend: "three", platform: "web" });
  host.load(
    `
    const S = require("spatial");
    const scene = new S.Scene();
    S.onFrame(() => {
      const pad = S.input.controllers.all[0];
      if (pad !== undefined && S.time.frame === 1) pad.rumble(2, -1);
    });
    S.mount(scene);
  `,
    { backend: "three", platform: "web", capabilities: { controllers: false } },
  );
  host.spatial.setInput({ controllers: [{ id: "pad-1" }] });
  const frame = host.tick();
  const rumble = commandsFor(frame, "controllerRumble")[0];
  assert.deepEqual(
    plain(rumble),
    ["controllerRumble", 0, "pad-1", 1, 0],
    "the opcode goes out even with no haptics, with its arguments clamped",
  );
  assert.ok(host.dump().warnings.some((warning) => /no haptics on this consumer/.test(warning)));
});

test("14.2 play() before the first flush still reaches the consumer as videoControl", () => {
  const host = createHost();
  host.load(`
    const S = require("spatial");
    const scene = new S.Scene();
    const screen = new S.VideoScreen({ url: "clip.mp4", width: 1, autoplay: true });
    screen.name = "screen";
    scene.add(screen);
    screen.play();
    S.mount(scene);
  `);
  const first = host.tick();
  assert.equal(commandsFor(first, "video")[0][2].autoplay, true, "autoplay stays in the payload");
  assert.equal(commandsFor(first, "videoControl").length, 0);
  const second = host.tick();
  assert.deepEqual(plain(commandsFor(second, "videoControl")[0].slice(2)), ["play", null]);
});

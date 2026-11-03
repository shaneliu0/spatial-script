// host-channel.js -- talking to the app the scene is embedded in: events both
// ways, a host function call, state that survives a hot reload, the activate
// and deactivate hooks, and a consumer-performed fetch.
//
// Everything sits within about 0.4 m of the origin so it fills the Mac window
// with the camera roughly 1 m away.
//
// Every one of these is optional on the other side: an app may register no
// functions, serve no urls and never send an event. Each call below is
// written so the scene still runs when the answer never comes.

const Spatial = require("spatial");
const {
  Scene,
  Group,
  Mesh,
  BoxGeometry,
  SphereGeometry,
  PlaneGeometry,
  MeshStandardMaterial,
  AmbientLight,
  DirectionalLight,
  Color,
} = Spatial;

const scene = new Scene();

const ambient = new AmbientLight(0xffffff, 0.4);
ambient.name = "ambient";
scene.add(ambient);

const sun = new DirectionalLight(0xffffff, 2.5);
sun.name = "sun";
sun.position.set(0.5, 1.1, 0.7);
sun.castShadow = true;
scene.add(sun);

const floor = new Mesh(
  new PlaneGeometry(0.9, 0.9),
  new MeshStandardMaterial({ color: 0x23262b, roughness: 0.95 }),
);
floor.name = "floor";
floor.rotation.x = -Math.PI / 2;
floor.position.y = -0.22;
floor.receiveShadow = true;
scene.add(floor);

// ---------------------------------------------------------------- the scene

const panel = new Group();
panel.name = "panel";
scene.add(panel);

const button = new Mesh(
  new BoxGeometry(0.16, 0.05, 0.16),
  new MeshStandardMaterial({ color: 0x3a6fd8, roughness: 0.4 }),
);
button.name = "button";
button.position.set(-0.16, -0.1, 0);
button.castShadow = true;
panel.add(button);

const lamp = new Mesh(
  new SphereGeometry(0.06, 28, 20),
  new MeshStandardMaterial({ color: 0x445066, emissive: 0x000000, roughness: 0.35 }),
);
lamp.name = "lamp";
lamp.position.set(0.16, -0.06, 0);
lamp.castShadow = true;
panel.add(lamp);

// -------------------------------------------------------- state across loads

// `this.state` is the one thing the runtime reads out of a script before it is
// replaced. Keep it plain JSON: it is copied, not referenced, and anything the
// copy cannot carry is dropped.
this.state = {
  presses: 0,
  hue: 0.58,
  activations: 0,
};

const state = this.state;

// Called after the replacement script has loaded and before its first frame,
// with whatever the previous script's `this.state` held. It is only called
// when the reload asked to preserve state, so a cold load skips it.
this.scriptChanged = (previousState) => {
  if (!previousState) return;
  if (typeof previousState.presses === "number") state.presses = previousState.presses;
  if (typeof previousState.hue === "number") state.hue = previousState.hue;
  if (typeof previousState.activations === "number") state.activations = previousState.activations;
  applyHue();
  console.log("carried", state.presses, "presses across the reload");
};

// ------------------------------------------------------------ activation

// The view appeared, the app came forward, or the immersive space opened.
// While inactive the frame loop is paused: time, timers and frame callbacks
// all stand still, so there is nothing to unwind here.
this.didActivate = () => {
  state.activations += 1;
  Spatial.host.send("sceneActive", { activations: state.activations });
  console.log("active again; ticks resume");
};

this.willDeactivate = () => {
  // The last chance to hand anything to the app before ticks stop.
  Spatial.host.send("sceneInactive", { presses: state.presses });
};

// --------------------------------------------------------- events from the app

function applyHue() {
  lamp.material.color.copy(new Color().setHSL(state.hue, 0.65, 0.55));
  lamp.material.emissive.copy(new Color().setHSL(state.hue, 0.7, 0.12));
}

applyHue();

// `this.on(name, handler)` is the same channel as Spatial.host.on; both are
// used below so either style reads as ordinary. Payloads are JSON.
this.on("setHue", (payload) => {
  if (!payload || typeof payload.hue !== "number") return;
  state.hue = Math.min(1, Math.max(0, payload.hue));
  applyHue();
});

const onPing = (payload) => {
  // Answering an event with an event is the whole protocol: there is no
  // reply channel, so a round trip is two sends.
  Spatial.host.send("pong", { at: Spatial.time.elapsed, echo: payload || null });
};

Spatial.host.on("ping", onPing);

// Handlers can be dropped again by name and function; passing no function
// drops every handler for that name. A reload clears them all anyway.
let listening = true;

// ------------------------------------------------------- events to the app

button.addEventListener("tap", () => {
  state.presses += 1;
  button.scale.setScalar(0.92);
  // Fire and forget: the app may have no listener for this at all.
  Spatial.host.send("buttonPressed", { presses: state.presses });
});

button.addEventListener("hoverenter", () => {
  button.hoverEffect = "highlight";
});

button.addEventListener("hoverexit", () => {
  button.hoverEffect = null;
});

// ------------------------------------------------------------ host functions

// Registered native functions are named "Module.function" and listed in
// Spatial.host.functions. Calling one that is not registered rejects straight
// away with a SpatialUnsupportedError rather than waiting for an app that will
// never answer, so the guard is a try/catch and not a timeout.
async function loadPreferences() {
  const wanted = "Preferences.read";
  if (Spatial.host.functions.indexOf(wanted) === -1) {
    console.log("host registered", Spatial.host.functions.length, "functions; using defaults");
    return;
  }
  try {
    const preferences = await Spatial.host.call(wanted, { key: "lampHue" });
    if (preferences && typeof preferences.hue === "number") {
      state.hue = preferences.hue;
      applyHue();
    }
  } catch (error) {
    // Unregistered, refused, or the app reported a failure of its own. The
    // scene keeps its defaults either way.
    console.warn("Preferences.read was not available:", error.message);
  }
}

loadPreferences();

// ------------------------------------------------------------------- fetch

// The consumer performs the request, so the same url rules as textures and
// assets apply and a rejection is the normal outcome on a host with no
// network. Never awaited at the top level: a request that is never answered
// would hold up the rest of the script body.
Spatial.fetchJSON("asset://layout.json")
  .then((layout) => {
    if (!layout || !Array.isArray(layout.lampPosition)) return;
    lamp.position.set(layout.lampPosition[0], layout.lampPosition[1], layout.lampPosition[2]);
  })
  .catch((error) => {
    console.warn("layout.json was not served:", error.message);
  });

// ------------------------------------------------------------------- frame

Spatial.onFrame((deltaTime, elapsed) => {
  // Ease the button back after a press.
  const scale = button.scale.x + (1 - button.scale.x) * Math.min(1, deltaTime * 8);
  button.scale.setScalar(scale);
  lamp.position.y = -0.06 + Math.sin(elapsed * 1.4) * 0.02;

  // Stop answering pings once the button has done its job, to show that a
  // handler is removable rather than only addable.
  if (listening && state.presses >= 5) {
    Spatial.host.off("ping", onPing);
    listening = false;
  }

  // `Spatial.isActive` mirrors the hooks above; frames only run while it is
  // true, so this is really an assertion about the contract.
  scene.userData.active = Spatial.isActive;
  scene.userData.presses = state.presses;
});

Spatial.mount(scene);

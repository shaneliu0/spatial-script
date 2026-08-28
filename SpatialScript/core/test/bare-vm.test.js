import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { bundleSource, createBareContext, plain } from "./helpers.mjs";

const FORBIDDEN = ["window", "document", "self", "navigator", "fetch", "Image", "XMLHttpRequest"];

test("the bundle evaluates in a bare context with only globalThis and __spatialNative", () => {
  const native = {
    logged: [],
    log(level, message) {
      native.logged.push([level, message]);
    },
    now() {
      return 0;
    },
  };
  const context = createBareContext(native);

  // Any read of a browser global must throw, so an accidental reference at
  // load time or during tick fails loudly instead of silently no-oping.
  for (const name of FORBIDDEN) {
    Object.defineProperty(context, name, {
      configurable: false,
      get() {
        throw new Error(`the core must not reference ${name}`);
      },
    });
  }

  vm.runInContext(bundleSource, context, { filename: "spatial-core.js" });
  assert.equal(typeof context.__spatial, "object");
  assert.equal(typeof context.__spatial.load, "function");
  assert.equal(typeof context.__spatial.tick, "function");

  const source = `
    const S = require("spatial");
    const scene = new S.Scene();

    const box = new S.Mesh(new S.BoxGeometry(0.1, 0.1, 0.1), new S.MeshStandardMaterial({ color: 0x3366ff }));
    box.name = "box";
    box.rigidBody = new S.RigidBody({});
    box.addEventListener("tap", () => { box.material.color.set(0xff0000); });
    scene.add(box);

    const label = new S.Mesh(new S.TextGeometry("Hi", { size: 0.05, depth: 0.005 }), new S.MeshBasicMaterial());
    label.name = "label";
    label.billboard = true;
    scene.add(label);

    const world = new S.Group();
    world.name = "world";
    scene.add(world);
    const portal = new S.Portal({ width: 0.2, height: 0.2, world });
    portal.name = "portal";
    scene.add(portal);

    const emitter = new S.ParticleEmitter({ preset: "sparks" });
    emitter.name = "sparks";
    scene.add(emitter);

    const anchor = new S.Anchor("head");
    anchor.name = "anchor";
    scene.add(anchor);

    const texture = new S.TextureLoader().load("asset://grid.png");
    box.material.map = texture;

    const sun = new S.DirectionalLight(0xffffff, 2);
    sun.name = "sun";
    sun.position.set(1, 2, 1);
    scene.add(sun);

    S.environment = new S.ImageBasedLight("asset://studio.exr", 1);
    setTimeout(() => { console.log("timer fired"); }, 10);
    S.onFrame((dt) => { box.rotation.y += dt; });
    S.mount(scene);
  `;

  context.__spatial.load(source, { backend: "realitykit", platform: "visionos" });
  for (let i = 0; i < 5; i += 1) {
    const commands = context.__spatial.tick(1 / 60);
    assert.ok(Array.isArray(commands) || commands.length >= 0);
  }
  context.__spatial.Spatial.inject.tap("box");
  context.__spatial.tick(1 / 60);
  const dump = context.__spatial.dump();
  assert.equal(dump.objects.length, 7);
  assert.deepEqual(plain(dump.errors), []);
  context.__spatial.dispose();
});

test("the bundle source contains no top-level browser global references", () => {
  // The guarded checks three.js performs are all inside functions; nothing may
  // read a browser global while the IIFE body runs. Verified behaviourally
  // above; this check keeps the obvious regressions visible.
  const withoutStrings = bundleSource.replace(/(["'`])(?:\\.|(?!\1)[^\\])*\1/g, '""');
  const topLevelDocument = /^\s*(?:var|let|const)\s+\w+\s*=\s*document\b/m.test(withoutStrings);
  assert.equal(topLevelDocument, false);
});

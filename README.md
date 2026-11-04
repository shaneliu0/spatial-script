# SpatialScript

**Write a 3D scene once in JavaScript. Run it natively in RealityKit on visionOS and macOS, and unchanged in a browser on three.js.**

SpatialScript is a scene API that follows three.js names and signatures, plus the
two runtimes that execute it. On Apple platforms, your script runs in
JavaScriptCore and drives real RealityKit entities, with no WebView. In a browser,
the same file runs on three.js and Rapier, so you can preview, screenshot and test
a scene headlessly without rebuilding or deploying an app.

```
                          your-scene.js
                                │
                    require("spatial") API
                                │
             ┌──────────────────┴──────────────────┐
             │     @spatialscript/core             │
             │  scene graph · diffing · events     │
             │  emits one command batch per frame  │
             └──────────────────┬──────────────────┘
                                │
              ┌─────────────────┴─────────────────┐
              ▼                                   ▼
  SpatialScriptRuntime (Swift)          @spatialscript/web
  JavaScriptCore + RealityKit           three.js + Rapier
  visionOS · macOS                      any modern browser
```

## What it does

- **Hot-loads native 3D scenes.** Swap a script at runtime instead of rebuilding your app.
- **Reuses what you know.** `Scene`, `Mesh`, `BoxGeometry`, `MeshStandardMaterial` and the rest of the core classes work the way they do in three.js.
- **Adds what spatial apps need.** Physics bodies and joints, tap, hover, drag and manipulation events with bubbling, anchors, portals, particles, hand input, and whole-object opacity.
- **Covers media and rigs.** Audio, video, cameras, character controllers, force fields, skeletons and blend shapes, shader graph materials, scene understanding, and game controllers.
- **Talks to your app.** A two-way channel lets a script and its host app exchange events.
- **Survives bad scripts.** Features RealityKit can't express are either absent or fail loudly. Script errors are reported rather than crashing the host or stopping the frame loop.
- **Is built for generated code.** Scenes are a single file, `Spatial.limits` names the caps on script-supplied work, and [`docs/AGENT-PROMPT.md`](docs/AGENT-PROMPT.md) is a self-contained authoring prompt for code generation tools.

SpatialScript is not three.js. There is no renderer, no custom GLSL and no
post-processing. You build a scene and call `Spatial.mount(scene)`, and the host
renders it. See [what differs from three.js](docs/DIFFERENCES.md).

## Example

```js runnable
const Spatial = require("spatial");
const {
  Scene, Mesh, BoxGeometry, MeshStandardMaterial,
  AmbientLight, DirectionalLight, Color,
} = Spatial;

const scene = new Scene();
scene.add(new AmbientLight(0xffffff, 0.35));

const sun = new DirectionalLight(0xfff4e6, 2.5);
sun.position.set(0.6, 1.2, 0.8);
scene.add(sun);

// Units are metres.
const cube = new Mesh(
  new BoxGeometry(0.16, 0.16, 0.16),
  new MeshStandardMaterial({ color: 0x3366ff, roughness: 0.35 }),
);
scene.add(cube);

// Registering a listener is what makes an object an input target.
cube.addEventListener("tap", () => {
  cube.material.color.copy(new Color().setHSL(Math.random(), 0.7, 0.55));
});

Spatial.onFrame((deltaTime) => {
  cube.rotation.y += deltaTime * 0.8;
});

Spatial.mount(scene);
```

## Installation

### Swift Package Manager (visionOS, macOS)

Requires Swift 6.2 and visionOS 26 or macOS 26.

In Xcode, choose **File > Add Package Dependencies** and enter the repository URL.
Or add it to `Package.swift`:

```swift
platforms: [.macOS(.v26), .visionOS(.v26)],
dependencies: [
    .package(url: "https://github.com/shaneliu0/spatial-script.git", branch: "main"),
],
targets: [
    .executableTarget(
        name: "YourApp",
        dependencies: [
            .product(name: "SpatialScriptRuntime", package: "spatial-script"),
        ]
    ),
]
```

Register the runtime once at launch, then attach a script to an entity:

```swift
import RealityKit
import SpatialScriptRuntime
import SwiftUI

@main
struct DemoApp: App {
    init() {
        ScriptingRuntime.configureJavaScriptEngine()
        ScriptingRuntime.setup()
    }

    var body: some SwiftUI.Scene {
        WindowGroup { ScriptedScene() }
    }
}

struct ScriptedScene: View {
    private let source = """
    const Spatial = require("spatial");
    const scene = new Spatial.Scene();
    scene.add(new Spatial.AmbientLight(0xffffff, 1));
    scene.add(new Spatial.Mesh(
      new Spatial.BoxGeometry(0.2, 0.2, 0.2),
      new Spatial.MeshStandardMaterial({ color: 0x3366ff })
    ));
    Spatial.mount(scene);
    """

    var body: some View {
        RealityView { content in
            let root = Entity()
            root.components.set(ScriptingComponent(javaScript: source))
            content.add(root)

            #if os(macOS)
            // macOS has no system camera, so the view supplies one.
            content.camera = .virtual
            let camera = Entity()
            camera.components.set(PerspectiveCameraComponent())
            camera.position = SIMD3(0, 0.25, 1.4)
            camera.look(at: .zero, from: camera.position, relativeTo: nil)
            content.add(camera)
            ScriptingRuntime.defaultCameraEntity = camera

            // macOS has no system ray, so the view turns pointer positions into rays.
            // Hover and drag don't work without this.
            let snapshot = content
            ScriptingRuntime.setPointerRayProvider { point in
                snapshot.ray(through: point, in: .local, to: .scene)
            }
            #endif
        }
        .enableRealityKitScriptingInput()
    }
}
```

To replace a running scene, set a new `ScriptingComponent` on the same entity. To
load files through `asset://` URLs, point `ScriptingRuntime.assetRoot` at a folder
in your app bundle. If scripts use an orthographic camera, keep
`ScriptingRuntime.viewportAspect` up to date with your view's size.

> **macOS:** an app using the hardened runtime needs the
> `com.apple.security.cs.allow-jit` entitlement for JavaScriptCore to use its JIT.

### Browser (three.js)

Requires Node.js and [Corepack](https://nodejs.org/api/corepack.html). The web
consumer isn't published to npm, so run it from a clone:

```bash
corepack enable
git clone https://github.com/shaneliu0/spatial-script.git
cd spatial-script
pnpm install
pnpm build
```

Serve a script, then open the URL it prints:

```bash
node consumers/web/harness/dev.mjs --page index.html --script examples/basics.js
```

Or leave out both options to open a page where you can paste a script and run it.

To render a script headlessly to a PNG and a JSON scene dump, install Playwright's
Chromium first. The web tests and `pnpm verify` need it too.

```bash
pnpm --filter @spatialscript/web exec playwright install chromium
```

```bash
node consumers/web/harness/screenshot.mjs examples/basics.js --out basics.png
```

## Writing scenes

Five things to know before you start:

1. **Units are metres.** Keep content close to the origin.
2. **`Spatial.mount(scene)` replaces `renderer.render()`.** Call it once.
3. **`require("spatial")` is the only import.** A scene is one file, with no `import` or `export`.
4. **An unlit `MeshStandardMaterial` is black** on both backends, so add a light.
5. **Backends differ.** Check `Spatial.env.capabilities` at runtime. For example, macOS has no hand tracking or anchoring.

The [`examples/`](examples) folder has runnable scenes for basics, interaction,
physics, animation, effects, audio and video, cameras, characters, the host channel
and asset control.

## Documentation

| Document | Read it when |
|---|---|
| [Guide](docs/GUIDE.md) | you want to run scripts, use the dev transport, or verify a scene |
| [API reference](docs/API.md) | you need every class, property and default, and which backend supports it |
| [Differences from three.js](docs/DIFFERENCES.md) | you know three.js and are writing your first script |
| [Cookbook](docs/COOKBOOK.md) | you have a task, such as tappable objects, physics, portals or assets |
| [Troubleshooting](docs/TROUBLESHOOTING.md) | something doesn't render, fire, move or load |
| [Authoring prompt](docs/AGENT-PROMPT.md) | you're generating scenes with a code generation tool |
| [Specification](SPEC.md) | you're changing the runtime rather than writing scripts |
| [TypeScript declarations](types/spatial.d.ts) | you want editor completion |

## How backends stay in sync

Both backends consume the same core bundle, and the repository checks that they
behave the same way:

- **Conformance:** 110 cases run against the core in Node, in JavaScriptCore, in a real browser and in the Swift runtime.
- **Parity:** the same script and input plan run on both backends, then their scene dumps and logs are compared, and screenshots are saved side by side for review.
- **Robustness:** a suite of deliberately hostile scripts must load and tick without taking down the host.
- **Docs:** every `js runnable` block in the documentation, including the example above, is executed.

```bash
pnpm test            # core and web unit tests
pnpm verify          # everything that doesn't need a native host
swift test           # the RealityKit consumer
```

The parity, performance and gauntlet tools (`pnpm parity`, `pnpm perf`,
`pnpm gauntlet`) also need a running macOS host app that serves the dev transport
on `127.0.0.1:8787`, as described in [SPEC 11](SPEC.md#11-dev-transport-debug-builds-only).
That host isn't part of this repository, and the Swift package doesn't include the
HTTP server. Set `SPATIAL_HOST_APP` to your app's process name.

Physics parity is structural rather than trajectory-exact: RealityKit and Rapier are
different solvers, so the same body setup won't follow the same path frame for frame.

## Repository layout

```
Package.swift      Swift package manifest
Sources/           SpatialScriptRuntime: JavaScriptCore host and RealityKit consumer
Tests/             Swift tests
core/              @spatialscript/core: the shared runtime and its built bundle
consumers/web/     @spatialscript/web: the three.js consumer and browser harness
types/             TypeScript declarations for scripts
assets/            shared asset root for asset:// URLs
examples/          runnable example scenes
verification/      conformance, scenario, parity and performance suites
docs/              guide, API reference, cookbook and troubleshooting
tools/             asset and prompt generators
SPEC.md            the contract every implementation conforms to
```

## Contributing

Issues and pull requests are welcome. [`SPEC.md`](SPEC.md) is authoritative, so a
behaviour change should update it and add a conformance case in
[`verification/conformance`](verification/conformance/README.md). If you change
`core/`, run `pnpm build` to refresh the committed bundle and its copy in
the Swift package.

## License

SpatialScript is available under the [MIT License](LICENSE). It bundles parts of
[three.js](https://threejs.org) and the helvetiker typeface. See
[`core/THIRD_PARTY.md`](core/THIRD_PARTY.md) for their notices.

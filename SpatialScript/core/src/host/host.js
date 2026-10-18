// The narrow interface the leaf modules use to reach the running scene.
//
// `Texture`, `RigidBody`, `ParticleEmitter`, `AssetGroup` and the patched
// Object3D prototype are all constructed by script code, so they cannot take
// the runtime as a constructor argument without changing the public API. They
// reach it through this accessor instead, and the interface below is the whole
// coupling surface — nine members, declared here rather than discovered by
// grepping for `rt()` (MAINT-02).
//
// @typedef {object} RuntimeHost
// @property {(command: any[]) => void}            queueCommand   append an imperative command
// @property {(object: any, feature: string) => boolean} canCommand may this object be named yet
// @property {(object: any) => number}             idForObject    command-stream id, minting one
// @property {(object: any) => number|null}        referenceIdFor id of a referenced object, or null
// @property {(key: string, message: string) => void} warnOnce    one warning per key per scene
// @property {(error: any) => void}                reportOnce     one error, no time throttle
// @property {(error: any) => void}                reportError    a script error, throttled
// @property {(texture: any) => void}              registerTexture start tracking a texture
// @property {(texture: any) => void}              disposeTexture  queue a texture for release
// @property {object|null}                         scene           the mounted scene

/** @type {{ current: RuntimeHost|null }} */
const state = { current: null };

/** Installs the host every leaf module talks to. Called once per Runtime. */
export function setHost(host) {
  state.current = host;
}

/** The active host, or null before a Runtime exists. */
export function host() {
  return state.current;
}

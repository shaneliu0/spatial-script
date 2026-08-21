// Spatial.inject (SPEC 3.8). Synthesises exactly the events a consumer would
// produce, so an agent can verify a scene without real input. Injected events
// go through the same queue as consumer events and are delivered at the start
// of the next tick.

import { push } from "./builtins.js";
import { Vector3 } from "./three-exports.js";

export function createInject(runtime) {
  const resolve = (target) => {
    if (typeof target === "string") {
      const found = runtime.scene ? runtime.scene.getObjectByName(target) : null;
      if (!found) throw new Error(`Spatial.inject could not find an object named "${target}"`);
      return found;
    }
    if (!target || !target.isObject3D) throw new TypeError("Spatial.inject expects an Object3D or a name");
    return target;
  };

  const worldPointOf = (object) => {
    object.updateWorldMatrix(true, false);
    return new Vector3().setFromMatrixPosition(object.matrixWorld);
  };

  return {
    tap(target, point) {
      const object = resolve(target);
      const id = runtime.idForObject(object);
      runtime.dispatch("tap", id, { point: point ? point.clone() : worldPointOf(object) });
    },

    drag(target, translation, options = {}) {
      const object = resolve(target);
      const id = runtime.idForObject(object);
      const steps = Math.max(1, Math.floor(options.steps === undefined ? 1 : options.steps));
      const origin = worldPointOf(object);

      runtime.dispatch("dragstart", id, { translation: new Vector3(), point: origin.clone() });
      for (let step = 1; step <= steps; step += 1) {
        const partial = translation.clone().multiplyScalar(step / steps);
        runtime.dispatch("drag", id, {
          translation: partial,
          point: origin.clone().add(partial),
        });
      }
      const full = translation.clone();
      runtime.dispatch("dragend", id, { translation: full, point: origin.clone().add(full) });
    },

    hover(target, entering) {
      const object = resolve(target);
      const id = runtime.idForObject(object);
      runtime.dispatch(entering ? "hoverenter" : "hoverexit", id, {});
    },

    key(code, down) {
      push(runtime.injectedKeys, { code: String(code), down: down === true });
    },
  };
}

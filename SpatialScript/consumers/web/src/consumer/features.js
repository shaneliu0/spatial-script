// Phase 2 features (SPEC 14), lights, opacity, particles, anchors and portals.
//
// Everything here is state the consumer holds on behalf of one object id:
// cameras, audio and video, character controllers, skeletons, shader graphs,
// accessibility, render options, lights, and the fade that multiplies down a
// subtree.

import * as THREE from 'three';
import { ParticleEmitter } from './particles.js';
import { Portal } from './portals.js';
import {
  ANCHOR_KINDS,
  KNOWN_KEYS,
  LIGHT_TYPES,
  MAP_SLOTS,
  MATERIAL_IDENTITY,
  ORTHOGRAPHIC_TOLERANCE,
  _ndc,
  _origin,
  _plane,
  _size,
  _v3,
  lightKindOf,
  shaderKey,
  whiteTexture,
} from './internals.js';

/**
 * FA-57: a mixin over the consumer class, so these methods keep `this` and every
 * call site unchanged while living in a file of their own.
 */
export function withFeatures(Base) {
  return class extends Base {
    // ------------------------------------------------------- phase 2 (SPEC 14)

    /**
     * `camera` (SPEC 14.3): the script's camera replaces the consumer's built-in
     * one. `aspect` stays the consumer's, from the viewport, and a script-set
     * value is ignored with a warning.
     */
    /**
     * `camera` (SPEC 14.13): the second element is the camera object's id, and its
     * transform rides `transforms` like any other object. `["camera", 0, { kind:
     * null }]` restores the consumer's built-in camera. `aspect` stays the
     * consumer's, from the viewport; a script-set value is ignored.
     */
    setCamera(id, spec) {
      this.checkPayloadKeys('camera', spec, KNOWN_KEYS.camera);
      this.cameraSpec = spec && spec.kind ? spec : null;
      if (!spec || !spec.kind) {
        if (this.scriptCamera) {
          this.scriptCamera = null;
          this.cameraId = null;
          this.camera = this.builtInCamera;
          this._rebindCamera();
        }
        return;
      }

      // The camera is a real object in the scene graph, so the consumer swaps the
      // three.js camera onto it rather than keeping one of its own.
      const object = this.objects.get(id);
      if (!object) {
        this.warnOnce(`cameraId:${id}`, `the camera command names unknown object id ${id}`);
        return;
      }
      const aspect = this.viewportAspect();
      const wanted = spec.kind === 'orthographic' ? 'OrthographicCamera' : 'PerspectiveCamera';
      let camera = this.scriptCamera;
      if (!camera || camera.type !== wanted || this.cameraId !== id) {
        if (camera && camera.parent) camera.removeFromParent();
        camera = spec.kind === 'orthographic'
          ? new THREE.OrthographicCamera(-1, 1, 1, -1, spec.near ?? 0.01, spec.far ?? 200)
          : new THREE.PerspectiveCamera(spec.fov ?? DEFAULT_FOV, aspect, spec.near ?? 0.01, spec.far ?? 200);
        camera.name = '__scriptCamera';
        camera.matrixAutoUpdate = false;
        // Riding the object means the script's transform commands move it for free.
        object.add(camera);
        this.scriptCamera = camera;
        this.cameraId = id;
      }
      if (camera.isPerspectiveCamera) {
        camera.fov = spec.fov ?? camera.fov;
        camera.aspect = aspect;
      } else {
        this._applyOrthographicFrustum(camera, spec, aspect);
      }
      camera.near = spec.near ?? camera.near;
      camera.far = spec.far ?? camera.far;
      camera.updateProjectionMatrix();
      if (this.camera !== camera) {
        this.camera = camera;
        this._rebindCamera();
      }
    }

    /**
     * SPEC 14.3: an orthographic camera's visible height is `top - bottom` and its
     * visible width follows the viewport aspect, so the image never stretches
     * anisotropically. The script's `left` and `right` are honored silently when
     * they already describe that width within two percent, and otherwise warn once
     * naming both numbers. The dump keeps what the script asked for.
     */
    _applyOrthographicFrustum(camera, spec, aspect) {
      const top = spec.top ?? camera.top;
      const bottom = spec.bottom ?? camera.bottom;
      const left = spec.left ?? camera.left;
      const right = spec.right ?? camera.right;

      camera.top = top;
      camera.bottom = bottom;

      const height = top - bottom;
      const derivedWidth = height * aspect;
      const requestedWidth = right - left;
      const centre = (left + right) / 2;

      if (Math.abs(requestedWidth - derivedWidth) > Math.abs(derivedWidth) * ORTHOGRAPHIC_TOLERANCE) {
        // SPEC 14.3 fixes this string, to three decimals, on both backends.
        this.warnOnce(
          'orthographicWidth',
          `OrthographicCamera asks for a visible width of ${requestedWidth.toFixed(3)} but the `
          + `viewport shows ${derivedWidth.toFixed(3)} at that height; the height is kept and the `
          + 'width follows the viewport',
        );
      }
      camera.left = centre - derivedWidth / 2;
      camera.right = centre + derivedWidth / 2;
    }

    /** Everything that holds a camera reference follows the active one. */
    _rebindCamera() {
      this.input.deps.camera = this.camera;
      this.audio.camera = this.camera;
      if (this.audio.listener) this.camera.add(this.audio.listener);
    }

    viewportAspect() {
      if (!this.renderer) return this.camera.aspect || 1;
      const size = this.renderer.getDrawingBufferSize(_size);
      return size.y ? size.x / size.y : 1;
    }

    /** `rayFromPoint` (SPEC 14.3): a world ray for a view pixel. */
    rayFromPoint(x, y) {
      const size = this.renderer ? this.renderer.getDrawingBufferSize(_size) : _size.set(1, 1);
      if (!size.x || !size.y) return null;
      _ndc.set((x / size.x) * 2 - 1, -(y / size.y) * 2 + 1);
      const caster = new THREE.Raycaster();
      caster.setFromCamera(_ndc, this.camera);
      return [
        caster.ray.origin.x, caster.ray.origin.y, caster.ray.origin.z,
        caster.ray.direction.x, caster.ray.direction.y, caster.ray.direction.z,
      ];
    }

    /**
     * The world point under the pointer: the first hit mesh, or the plane through
     * the origin facing the camera when nothing is hit (SPEC 14.3).
     */
    scenePositionAt(x, y) {
      const size = this.renderer ? this.renderer.getDrawingBufferSize(_size) : _size.set(1, 1);
      if (!size.x || !size.y) return null;
      _ndc.set((x / size.x) * 2 - 1, -(y / size.y) * 2 + 1);
      const caster = new THREE.Raycaster();
      caster.setFromCamera(_ndc, this.camera);
      const hits = caster.intersectObjects(this.pickables(), false);
      if (hits.length) return [hits[0].point.x, hits[0].point.y, hits[0].point.z];
      this.camera.getWorldDirection(_v3);
      _plane.setFromNormalAndCoplanarPoint(_v3.negate(), _origin);
      const point = new THREE.Vector3();
      if (!caster.ray.intersectPlane(_plane, point)) return null;
      return [point.x, point.y, point.z];
    }

    /** `skeleton` (SPEC 14.5): script-driven joint poses on a loaded asset. */
    setSkeleton(id, spec) {
      // SPEC 14.13: a skeleton retracts with an empty payload. `{ joints: {},
      // track: true }` is not empty — it is a request to report the rig's pose.
      if (!spec || (Object.keys(spec.joints || {}).length === 0 && spec.track !== true)) {
        this.skeletons.delete(id);
        return;
      }
      this.skeletons.set(id, { joints: spec.joints || {}, track: spec.track === true });
      const entry = this.assets.get(id);
      if (!entry || !entry.bones) return;
      for (const [name, pose] of Object.entries(spec.joints || {})) {
        const bone = entry.bones.get(name);
        if (!bone) {
          this.warnOnce(`joint:${id}:${name}`, `asset joint "${name}" not found`);
          continue;
        }
        if (pose && pose.length >= 7) {
          bone.position.set(pose[0], pose[1], pose[2]);
          bone.quaternion.set(pose[3], pose[4], pose[5], pose[6]);
        }
      }
    }

    /** `blendShapes` (SPEC 14.5): morph target weights by name. */
    setBlendShapes(id, weights) {
      // SPEC 14.13: blend shapes retract with an empty payload, not with null.
      if (!weights || Object.keys(weights).length === 0) {
        this.blendShapes.delete(id);
        return;
      }
      this.blendShapes.set(id, { ...weights });
      const entry = this.assets.get(id);
      if (!entry || !entry.morphs) return;
      for (const [name, weight] of Object.entries(weights)) {
        if (!Number.isFinite(weight)) {
          this.warnOnce(`blendShapeValue:${name}`, `the blend shape "${name}" was given a non-numeric weight`);
          continue;
        }
        const targets = entry.morphs.get(name);
        if (!targets) {
          this.warnOnce(`blendShape:${id}:${name}`, `asset blend shape "${name}" not found`);
          continue;
        }
        for (const { mesh, index } of targets) mesh.morphTargetInfluences[index] = weight;
      }
    }

    /** Flat `[id, ...]` joint report for `syncSkeleton`, only while tracking. */
    trackedSkeletons() {
      const out = [];
      for (const [id, state] of this.skeletons) {
        if (!state.track) continue;
        const entry = this.assets.get(id);
        if (!entry || !entry.bones) continue;
        const joints = {};
        for (const [name, bone] of entry.bones) {
          joints[name] = [
            bone.position.x, bone.position.y, bone.position.z,
            bone.quaternion.x, bone.quaternion.y, bone.quaternion.z, bone.quaternion.w,
          ];
        }
        out.push([id, joints]);
      }
      return out;
    }

    /** `shaderParameter` (SPEC 14.6): update a same-named fallback property. */
    /**
     * `shaderParameter` (SPEC 14.13): the fifth element is the material index, so a
     * multi-material mesh can carry a graph in any slot. The web renders the
     * fallback, so a same-named property on it is what the parameter updates; an
     * integer for a map slot is resolved against the texture cache.
     */
    setShaderParameter(id, name, value, materialIndex = 0) {
      const graph = this.shaderGraphs.get(shaderKey(id, materialIndex));
      // The dump reports what the script set, whatever the fallback does with it.
      if (graph) graph.parameters[name] = value;
      const material = this.materialAt(id, materialIndex);

      // SPEC 14.6, mirroring `ShaderGraphMaterial.setParameter` in the core: a
      // carryable value is written to the same-named property of the fallback,
      // unless the name identifies the material itself. The core warns for both
      // refusals — the identity list and a name the fallback does not have — so
      // this consumer stays quiet and only does the write.
      if (MATERIAL_IDENTITY.has(name)) return;
      if (!material || !(name in material)) return;

      const target = material[name];
      if (MAP_SLOTS.includes(name) && typeof value === 'number') {
        // A texture id, which is what the wire carries for a map parameter; the
        // core hands its own fallback the Texture object here.
        const entry = this.textures.get(value);
        if (!entry) {
          this.warnOnce(`shaderTexture:${value}`, `the shader graph parameter "${name}" names unknown texture id ${value}`);
          return;
        }
        material[name] = this._textureForColorSpace(entry, name === 'map' || name === 'emissiveMap'
          ? THREE.SRGBColorSpace
          : THREE.NoColorSpace);
      } else if (target && target.isColor && Array.isArray(value)) {
        // A Color or Vector reaches the consumer as the array the stream can
        // carry; the core copies the script's object into the same target.
        target.setRGB(value[0], value[1], value[2], THREE.LinearSRGBColorSpace);
      } else if (target && target.isVector2 && Array.isArray(value)) {
        target.set(value[0], value[1]);
      } else if (target && target.isVector3 && Array.isArray(value)) {
        target.set(value[0], value[1], value[2]);
      } else if (target && target.isVector4 && Array.isArray(value)) {
        target.set(value[0], value[1], value[2], value[3]);
      } else {
        // Everything else the stream can carry — numbers, booleans, strings and
        // arrays — is written as it arrived, the way the core writes it.
        material[name] = value;
      }
      material.needsUpdate = true;
    }

    /** The material in one slot of a mesh, single or multi. */
    materialAt(id, index = 0) {
      const object = this.objects.get(id);
      if (!object || !object.isMesh) return null;
      if (Array.isArray(object.material)) return object.material[index] || null;
      return index === 0 ? object.material : null;
    }

    /** `sceneUnderstanding` (SPEC 14.7): kept in the dump, warned once. */
    setSceneUnderstanding(spec) {
      this.sceneUnderstanding = spec ? { ...spec } : null;
      if (spec && (spec.collision || spec.occlusion || spec.physics || spec.shadows)) {
        // AR-36: the core already warns that scene understanding has no effect
        // outside visionOS; one fact, one warning. What follows is the part only
        // this consumer knows.
        // NR-06, SPEC 14.7: the flags are on, so the script may expect a hit on
        // the real world. There is none to give: a browser has no reconstruction
        // mesh, so no raycast ever returns the id 0 record with
        // `sceneUnderstanding: true` that the contract describes.
        this.warnOnce(
          'sceneUnderstandingRaycast',
          'raycasts will not see the real world here: the three.js consumer has no scene '
          + 'reconstruction mesh, so no hit carries sceneUnderstanding',
        );
      }
    }

    /** `renderOptions` (SPEC 14.11). */
    setRenderOptions(spec) {
      if (!spec) return;
      this.renderOptions = { ...this.renderOptions, ...spec };
      // AR-36: `Spatial.render.adaptiveResolution has no effect outside visionOS`
      // is the core's warning to make; the consumer keeps the state and is quiet.
      const exponent = spec.environmentIntensityExponent;
      if (typeof exponent === 'number') {
        this.environmentIntensity = exponent;
        // The ambient environment is scaled by the exponent, as macOS does.
        this.scene.environmentIntensity = (this._environmentBaseIntensity ?? 1) ** exponent;
      }
      this.setDebugModelView(spec.debugModelView ?? null);
    }

    /** `debug.modelView` (SPEC 14.11): normal and uv have three.js equivalents. */
    setDebugModelView(mode) {
      if (this.renderOptions.debugModelViewApplied === mode) return;
      this.renderOptions.debugModelViewApplied = mode;
      if (mode && mode !== 'normal' && mode !== 'uv') {
        this.warnOnce(
          `debugModelView:${mode}`,
          `the debug model view "${mode}" has no three.js substitute; the scene renders normally`,
        );
      }
      if (!mode) {
        this.scene.overrideMaterial = null;
        return;
      }
      if (mode === 'normal') {
        this.scene.overrideMaterial = new THREE.MeshNormalMaterial();
      } else if (mode === 'uv') {
        // three ships no uv debug material, so one is built from the uv attribute.
        const material = new THREE.MeshBasicMaterial();
        material.onBeforeCompile = (shader) => {
          shader.fragmentShader = shader.fragmentShader.replace(
            '#include <color_fragment>',
            '#include <color_fragment>\n  diffuseColor.rgb = vec3(vMapUv, 0.0);',
          );
        };
        material.defines = { USE_UV: '', USE_MAP: '' };
        material.map = whiteTexture();
        this.scene.overrideMaterial = material;
      } else {
        this.scene.overrideMaterial = null;
      }
    }

    // ----------------------------------------------------------------- lights

    setLight(id, spec) {
      const light = this.objects.get(id);
      if (!light || !light.isLight || !spec) return;
      this.checkPayloadKeys('light', spec, KNOWN_KEYS.light);
      if (spec.type && !LIGHT_TYPES.has(spec.type)) {
        this.warnOnce(`lightType:${spec.type}`, `unknown light type "${spec.type}" was applied as ${lightKindOf(light)}`);
      }
      if (spec.color) light.color.setRGB(spec.color[0], spec.color[1], spec.color[2], THREE.LinearSRGBColorSpace);
      // three.js already uses the physical units the SPEC describes; the lumen and
      // lux conversions in SPEC 3.6 are for the RealityKit consumer only.
      light.intensity = spec.intensity ?? 1;
      if (light.isPointLight || light.isSpotLight) {
        light.distance = spec.distance ?? 0;
        light.decay = spec.decay ?? 2;
      }
      if (light.isSpotLight) {
        light.angle = spec.angle ?? Math.PI / 3;
        light.penumbra = spec.penumbra ?? 0;
      }
      light.castShadow = !!spec.castShadow;
      if (light.shadow) this._configureShadow(light);
      this.lightDirections.set(id, spec.direction || null);
      this._updateLightTarget(id);
    }

    _configureShadow(light) {
      light.shadow.mapSize.set(1024, 1024);
      light.shadow.bias = -0.0005;
      light.shadow.normalBias = 0.02;
      const camera = light.shadow.camera;
      camera.near = 0.01;
      camera.far = 30;
      if (light.isDirectionalLight) {
        // Scenes are roughly a metre across; a tight frustum keeps the map sharp.
        camera.left = -2; camera.right = 2; camera.top = 2; camera.bottom = -2;
      }
      camera.updateProjectionMatrix();
    }

    /** Places the light's target one metre along the world direction from the light. */
    _updateLightTarget(id) {
      const light = this.objects.get(id);
      if (!light || !light.target) return;
      const direction = this.lightDirections.get(id);
      light.updateWorldMatrix(true, false);
      _v3.setFromMatrixPosition(light.matrixWorld);
      if (direction) {
        light.target.position.set(_v3.x + direction[0], _v3.y + direction[1], _v3.z + direction[2]);
      } else {
        light.target.position.set(_v3.x, _v3.y - 1, _v3.z);
      }
      light.target.updateMatrixWorld(true);
    }

    /**
     * The consumer never adds lights of its own. The macOS host does not either, so a
     * scene that declares none renders black on both backends; inventing a key
     * light here would make the browser disagree with RealityKit (SPEC 12: nothing
     * silently no-ops, so the condition is warned about instead).
     */
    ensureDefaultLighting() {
      if (this.lightIds.size > 0) return;
      this.warnOnce(
        'noLights',
        'the scene has no lights; meshes with lit materials render black',
      );
    }

    // -------------------------------------------------------------- opacity

    /**
     * OpacityComponent semantics: multiply down the hierarchy without touching the
     * material's own opacity. Materials are shared between meshes, so an object
     * whose effective opacity is below one gets a private clone; at full opacity it
     * goes back to the shared instance.
     */
    applyOpacity() {
      const walk = (object, accumulated) => {
        const id = object.userData ? object.userData.__spatialId : undefined;
        const own = id !== undefined ? (this.opacities.get(id) ?? 1) : 1;
        const value = accumulated * own;
        // A portal owns its render-target surface; nothing else may reassign it.
        if (object.isMesh && object.material && !this.portals.has(id)) {
          if (Array.isArray(object.material)) {
            // SPEC 3.2 and 14.12: opacity multiplies down the whole subtree, so
            // every material of a multi-material mesh takes it.
            for (const one of object.material) this._applyInlineOpacity(one, value);
          } else {
            const entry = id === undefined ? null : this.materialOf.get(id);
            if (entry) this._applyObjectOpacity(object, id, entry, value);
            else this._applyInlineOpacity(object.material, value);
          }
        }
        const emitter = id === undefined ? null : this.emitters.get(id);
        // SPEC 3.2 multiplies down the whole subtree, particles included (WEB-30).
        if (emitter) emitter.setOpacity(value);
        for (const child of object.children) walk(child, value);
      };
      for (const root of this.consumerRoots()) walk(root, 1);
    }

    _applyObjectOpacity(object, id, entry, value) {
      const clone = this.opacityMaterials.get(id);
      if (value >= 1) {
        if (clone) {
          clone.dispose();
          this.opacityMaterials.delete(id);
        }
        object.material = entry.material;
        return;
      }
      let target = clone;
      if (!target || target.userData.__sourceRevision !== entry.revision) {
        if (target) target.dispose();
        target = entry.material.clone();
        target.userData.__sourceRevision = entry.revision;
        this.opacityMaterials.set(id, target);
      }
      target.opacity = (entry.material.userData.__baseOpacity ?? 1) * value;
      target.transparent = true;
      object.material = target;
    }

    /** Materials the command stream does not own, such as those inside a loaded asset. */
    _applyInlineOpacity(material, value) {
      const base = material.userData.__baseOpacity ?? material.opacity;
      material.userData.__baseOpacity = base;
      const baseTransparent = material.userData.__baseTransparent ?? material.transparent;
      material.userData.__baseTransparent = baseTransparent;
      material.opacity = base * value;
      material.transparent = baseTransparent || value < 1;
    }

    // ------------------------------------------------------------- particles

    setParticles(id, spec) {
      const object = this.objects.get(id);
      if (!object) return;
      this.checkPayloadKeys('particles', spec, KNOWN_KEYS.particles);
      let emitter = this.emitters.get(id);
      if (!emitter) {
        emitter = new ParticleEmitter(object, id * 2654435761 + 1);
        this.emitters.set(id, emitter);
      }
      emitter.configure(spec, (textureId) => {
        if (textureId === null || textureId === undefined) return null;
        const entry = this.textures.get(textureId);
        return entry ? this._textureForColorSpace(entry, THREE.SRGBColorSpace) : null;
      });
    }

    // -------------------------------------------------------- anchors, portals

    setAnchor(id, spec) {
      const object = this.objects.get(id);
      if (!object || !spec) return;
      object.userData.__spatialAnchor = spec;
      this.checkPayloadKeys('anchor', spec, KNOWN_KEYS.anchor);
      if (spec.kind && !ANCHOR_KINDS.has(spec.kind)) {
        this.warnOnce(`anchorKind:${spec.kind}`, `unknown anchor kind "${spec.kind}" was created as a plain group`);
      }
      const isHead = spec.kind === 'head';
      if (isHead) {
        // Head-anchored content rides the camera on web.
        this.camera.add(object);
      }
      // Every other anchor type is a plain group; `isAnchored` stays false on web.
    }

    setPortal(id, spec) {
      const mesh = this.objects.get(id);
      if (!mesh || !spec) return;
      this.checkPayloadKeys('portal', spec, KNOWN_KEYS.portal);
      let portal = this.portals.get(id);
      if (!portal) {
        // The Portal replaces the plane the core sent, so give up its shared
        // geometry and material entries before taking ownership of the surface.
        this._releaseGeometry(id);
        this._releaseMaterial(id);
        portal = new Portal(mesh, spec, this.options.portalResolution || 1024);
        this.portals.set(id, portal);
      } else {
        portal.resize(spec);
      }
      portal.spec = spec;
      if (spec.crossing) {
        this.warnOnce('portalCrossing', 'Portal crossing is unsupported in the three.js consumer');
      }
    }

    setWorld(id, isWorld) {
      if (isWorld) this.worldGroups.add(id); else this.worldGroups.delete(id);
    }
  };
}

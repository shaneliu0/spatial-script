// The command stream and the scene graph.
//
// SPEC 5: every opcode the core can send, applied in order, plus the create /
// destroy / parent / transform half of the graph the consumer draws.

import * as THREE from 'three';
import { nativeDump } from '../dump/native-dump.js';
import {
  KNOWN_KEYS,
  MAX_ERRORS,
  disposeSubtree,
  finiteRecord,
  now,
  sanitizeAudio,
} from './internals.js';

/**
 * FA-57: a mixin over the consumer class, so these methods keep `this` and every
 * call site unchanged while living in a file of their own.
 */
export function withCommands(Base) {
  return class extends Base {
    // -------------------------------------------------------------- commands

    /**
     * Applies one command batch, then settles physics, opacity and lighting.
     * Every step is inside the error boundary and the pending queues are always
     * cleared, so one failing command or post-batch step records an error and the
     * next frame starts clean instead of retrying it forever.
     */
    apply(commands) {
      const started = now();
      this._lastCommandCount = commands ? commands.length : 0;
      this._lastTransformRecords = 0;
      if (commands) {
        for (const command of commands) {
          try {
            this.applyCommand(command);
          } catch (err) {
            this.recordError(`command ${command && command[0]}`, command && command[1], err);
          }
        }
      }
      try {
        this._afterBatch();
      } catch (err) {
        this.recordError('post-batch', null, err);
      } finally {
        this._pendingBodies.clear();
        this._pendingCharacters.clear();
        this._pendingForceFields.clear();
        this._pendingTeleports.clear();
        this._pendingJoints.clear();
        this._pendingBodyOps.length = 0;
      }
      this._lastApplyMs = now() - started;
      return this._lastApplyMs;
    }

    /**
     * Records one consumer error, naming the opcode and object. WEB-26: the list
     * is capped, and a repeat of the same message is counted rather than appended,
     * so a persistently failing command cannot flood `dump().errors`.
     */
    recordError(what, id, error) {
      const object = id === null || id === undefined ? null : this.objects.get(id);
      const name = object && object.name ? ` "${object.name}"` : '';
      const target = id === null || id === undefined ? '' : ` on id ${id}${name}`;
      const message = `${what}${target} failed: ${error && error.message ? error.message : error}`;
      this.write('error', `${message}\n${(error && error.stack) || ''}`);
      if (this._errorCounts.has(message)) {
        this._errorCounts.set(message, this._errorCounts.get(message) + 1);
        return;
      }
      this._errorCounts.set(message, 1);
      if (this.errors.length < MAX_ERRORS) {
        this.errors.push(message);
      } else {
        this.droppedErrors += 1;
      }
    }

    applyCommand(command) {
      const op = command[0];
      const id = command[1];
      switch (op) {
        case 'create': this.createObject(id, command[2], command[3]); break;
        case 'destroy': this.destroyObject(id); break;
        case 'parent': this.setParent(id, command[2]); break;
        case 'name': this.withObject(id, (o) => { o.name = command[2] || ''; }); break;
        case 'transform': this.setTransform(id, command); break;
        case 'transforms': this.setTransforms(command[2]); break;
        case 'visible': this.setVisible(id, !!command[2]); break;
        case 'geometry': this.setGeometry(id, command[2], command[3], command[4], command[5], command[6]); break;
        case 'material': this.setMaterial(id, command[2]); break;
        case 'texture': this.setTexture(id, command[2]); break;
        case 'light': this.setLight(id, command[2]); break;
        case 'shadow': this.withObject(id, (o) => { o.castShadow = !!command[2]; o.receiveShadow = !!command[3]; }); break;
        case 'opacity':
          if (this.objects.has(id)) {
            this.opacities.set(id, command[2]);
            this.opacityDirty = true;
          } else {
            this.warnOnce(`unknownId:${id}`, `opacity for unknown object id ${id} was ignored`);
          }
          break;
        case 'billboard': this.setBillboard(id, !!command[2]); break;
        // AR-36: the core already warns that groundingShadow does nothing on the
        // three.js backend, so the consumer does not say it a second time in
        // different words. The dump reports `groundingShadow: false`.
        case 'groundingShadow': break;
        case 'hoverEffect': this.withObject(id, (o) => { o.userData.__hoverEffect = command[2]; }); break;
        case 'manipulable': this.setManipulable(id, !!command[2]); break;
        case 'renderOrder': this.withObject(id, (o) => { o.renderOrder = command[2] | 0; }); break;
        case 'interactive':
          if (this.objects.has(id)) {
            this.interactive.set(id, command[2] || { tap: false, hover: false, drag: false });
          } else {
            this.warnOnce(`unknownId:${id}`, `interactive for unknown object id ${id} was ignored`);
          }
          break;
        case 'rigidBody':
          this.checkPayloadKeys('rigidBody', command[2], KNOWN_KEYS.rigidBody);
          this._pendingBodies.set(id, command[2] || null);
          break;
        case 'bodyImpulse':
          this._pendingBodyOps.push(['impulse', id, command[2], command[3], command[4], command[5], command[6], command[7]]);
          break;
        case 'bodyForce': this._pendingBodyOps.push(['force', id, command[2], command[3], command[4]]); break;
        case 'bodyTorque': this._pendingBodyOps.push(['torque', id, command[2], command[3], command[4]]); break;
        case 'bodyVelocity':
          this._pendingBodyOps.push(['velocity', id, command[2], command[3], command[4], command[5], command[6], command[7]]);
          break;
        case 'joint':
          this.checkPayloadKeys('joint', command[2], KNOWN_KEYS.joint);
          this._pendingJoints.set(id, command[2] || null);
          break;
        case 'gravity':
          if (this.physics) this.physics.setGravity(command[2], command[3], command[4]);
          else this.warnOnce('noPhysics', 'no physics module was supplied; gravity is recorded but not simulated');
          break;
        case 'particles': this.setParticles(id, command[2]); break;
        case 'particlesBurst': { const e = this.emitters.get(id); if (e) e.burst(); break; }
        case 'anchor': this.setAnchor(id, command[2]); break;
        case 'portal': this.setPortal(id, command[2]); break;
        case 'world': this.setWorld(id, !!command[2]); break;
        case 'asset': this.loadAsset(id, command[2]); break;
        case 'assetAnimation': this.setAssetAnimation(id, command[2], command[3], command[4]); break;
        case 'environment': this.setEnvironment(command[2]); break;
        case 'log': this.handleLog(command[2], command[3]); break;

        // ---- phase 2 (SPEC 14.13) ------------------------------------------
        case 'audio':
          this.checkPayloadKeys('audio', command[2], KNOWN_KEYS.audio);
          this.withObject(id, (o) => this.audio.setSource(id, o, sanitizeAudio(command[2])));
          break;
        case 'audioControl': this.audio.control(id, command[2], command[3]); break;
        case 'audioMixer':
          this.checkPayloadKeys('audioMixer', command[2], KNOWN_KEYS.audioMixer);
          this.audio.setMixer(command[2]);
          break;
        case 'video':
          this.checkPayloadKeys('video', command[2], KNOWN_KEYS.video);
          this.withObject(id, (o) => this.video.set(id, o, command[2]));
          break;
        case 'videoControl': this.video.control(id, command[2], command[3]); break;
        case 'camera': this.setCamera(id, command[2]); break;
        case 'characterController':
          this.checkPayloadKeys('characterController', command[2], KNOWN_KEYS.characterController);
          this._pendingCharacters.set(id, command[2] || null);
          break;
        case 'characterMove': this._pendingBodyOps.push(['characterMove', id, command[2], command[3], command[4]]); break;
        case 'characterTeleport': this._pendingBodyOps.push(['characterTeleport', id, command[2], command[3], command[4]]); break;
        case 'forceField':
          this.checkPayloadKeys('forceField', command[2], KNOWN_KEYS.forceField);
          this._pendingForceFields.set(id, command[2] || null);
          break;
        case 'skeleton':
          this.checkPayloadKeys('skeleton', command[2], KNOWN_KEYS.skeleton);
          this.setSkeleton(id, command[2]);
          break;
        case 'blendShapes': this.setBlendShapes(id, command[2]); break;
        case 'shaderParameter': this.setShaderParameter(id, command[2], command[3], command[4]); break;
        case 'sceneUnderstanding':
          this.checkPayloadKeys('sceneUnderstanding', command[2], KNOWN_KEYS.sceneUnderstanding);
          this.setSceneUnderstanding(command[2]);
          break;
        case 'accessibility':
          this.checkPayloadKeys('accessibility', command[2], KNOWN_KEYS.accessibility);
          this.withObject(id, (o) => this.accessibility.set(id, o.name, command[2]));
          break;
        case 'renderOptions':
          this.checkPayloadKeys('renderOptions', command[2], KNOWN_KEYS.renderOptions);
          this.setRenderOptions(command[2]);
          break;
        case 'hostEvent': this.host.emit(command[2], command[3]); break;
        case 'hostCall':
          // P2-B-29: keyed by the correlation id, indexed by name, and pruned when
          // the answer goes out, so repeated calls do not lose each other's id.
          this.pendingCalls.set(id, command[2]);
          this.host.call(id, command[2], command[3]);
          break;
        case 'fetch':
          this.pendingFetches.set(id, command[2] && command[2].url);
          this.host.fetch(id, command[2]);
          break;
        case 'controllerRumble': this.input.rumble(command[2], command[3], command[4]); break;
        default:
          this.warnOnce(`opcode:${op}`, `unknown command opcode "${op}"`);
      }
    }

    /**
     * MAINT-09: a key the consumer does not know about is a phase-2 field shipping
     * half-implemented, so it warns once per opcode and key rather than being read
     * and ignored.
     */
    checkPayloadKeys(opcode, payload, known) {
      if (!payload || typeof payload !== 'object') return;
      for (const key of Object.keys(payload)) {
        if (known.has(key)) continue;
        this.warnOnce(
          `payloadKey:${opcode}:${key}`,
          `the ${opcode} payload carries an unknown key "${key}", which this consumer ignores`,
        );
      }
    }

    withObject(id, fn) {
      const object = this.objects.get(id);
      if (object) fn(object);
    }

    _afterBatch() {
      this.root.updateMatrixWorld(true);

      for (const [id, spec] of this._pendingBodies) {
        // The spec is recorded even without Rapier so nativeDump stays truthful and
        // a later init() could replay it (WEB-13).
        if (spec) this.bodySpecs.set(id, spec.spec || spec); else this.bodySpecs.delete(id);
      }
      if (this.physics) {
        for (const [id, pending] of this._pendingBodies) {
          const object = this.objects.get(id);
          if (!object) continue;
          const spec = pending && pending.spec !== undefined ? pending.spec : pending;
          const rebuild = !!(pending && pending.rebuild);
          try {
            this.physics.setBody(id, object, spec, rebuild);
          } catch (err) {
            this.recordError('rigidBody', id, err);
          }
        }
        for (const id of this._pendingTeleports) {
          try {
            if (this.physics.isDynamic(id)) this.physics.teleport(id, this.objects.get(id));
          } catch (err) {
            this.recordError('transform teleport', id, err);
          }
        }
        for (const [jointId, spec] of this._pendingJoints) {
          try {
            this.physics.setJoint(jointId, spec);
          } catch (err) {
            this.recordError(`joint ${jointId}`, null, err);
          }
        }
      }
      if (this.characters) {
        for (const [id, spec] of this._pendingCharacters) {
          const object = this.objects.get(id);
          if (!object) continue;
          try {
            this.characters.set(id, object, spec);
          } catch (err) {
            this.recordError('characterController', id, err);
          }
        }
      }
      if (this.forceFields) {
        for (const [id, spec] of this._pendingForceFields) {
          const object = this.objects.get(id);
          if (object) this.forceFields.set(id, object, spec);
        }
      }
      if (this.physics) {
        // After the controllers exist: a batch may create a character and move it
        // in the same flush, and the move has to find its controller.
        for (const op of this._pendingBodyOps) {
          try {
            this._runBodyOp(op);
          } catch (err) {
            this.recordError(op[0], op[1], err);
          }
        }
      }
      if (!this.physics && (this._pendingCharacters.size || this._pendingForceFields.size)) {
        this.warnOnce('noPhysics',
          'no physics module was supplied; character controllers and force fields are recorded but not simulated');
      }
      if (!this.physics && (this._pendingBodies.size || this._pendingJoints.size || this._pendingBodyOps.length)) {
        this.warnOnce(
          'noPhysics',
          'no physics module was supplied; rigid bodies, joints and body forces are recorded but not simulated',
        );
      }
      if (this.opacityDirty) {
        this.applyOpacity();
        this.opacityDirty = false;
      }
    }

    _runBodyOp(op) {
      const [kind, id] = op;
      if (kind === 'impulse') this.physics.applyImpulse(id, op[2], op[3], op[4], op[5], op[6], op[7]);
      else if (kind === 'force') this.physics.applyForce(id, op[2], op[3], op[4]);
      else if (kind === 'torque') this.physics.applyTorque(id, op[2], op[3], op[4]);
      else if (kind === 'velocity') this.physics.setVelocity(id, op[2], op[3], op[4], op[5], op[6], op[7]);
      else if (kind === 'characterMove' && this.characters) this.characters.move(id, op[2], op[3], op[4]);
      else if (kind === 'characterTeleport' && this.characters) this.characters.teleport(id, op[2], op[3], op[4]);
    }

    // ------------------------------------------------------------ scene graph

    createObject(id, kind, name) {
      if (this.objects.has(id)) this.destroyObject(id);
      let object;
      switch (kind) {
        case 'group':
        case 'anchor':
        case 'asset':
        case 'particles':
          object = new THREE.Group();
          break;
        case 'mesh':
        case 'text': {
          const placeholder = new THREE.MeshStandardMaterial();
          placeholder.userData.__placeholder = true;
          object = new THREE.Mesh(new THREE.BufferGeometry(), placeholder);
          break;
        }
        case 'ambientLight':
          object = new THREE.AmbientLight(0xffffff, 1);
          break;
        case 'directionalLight':
          object = new THREE.DirectionalLight(0xffffff, 1);
          this._attachLightTarget(object);
          break;
        case 'pointLight':
          object = new THREE.PointLight(0xffffff, 1);
          break;
        case 'spotLight':
          object = new THREE.SpotLight(0xffffff, 1);
          this._attachLightTarget(object);
          break;
        case 'portal':
          object = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.5), new THREE.MeshBasicMaterial());
          break;
        default:
          this.warnOnce(`kind:${kind}`, `unknown object kind "${kind}", created as a Group`);
          object = new THREE.Group();
      }
      object.name = name || '';
      object.matrixAutoUpdate = true;
      object.userData.__spatialId = id;
      object.userData.__spatialKind = kind;
      if (object.isLight) this.lightIds.add(id);
      this.objects.set(id, object);
      // Objects stay detached until a `parent` command places them (SPEC section 5 ordering).
    }

    _attachLightTarget(light) {
      // Directional and spot lights aim at a target object; the core sends the
      // resolved world direction, so the target is kept at identity in the scene.
      light.target = new THREE.Object3D();
      this.scene.add(light.target);
    }

    destroyObject(id) {
      const object = this.objects.get(id);
      if (!object) return;
      const emitter = this.emitters.get(id);
      if (emitter) { emitter.dispose(); this.emitters.delete(id); }
      const portal = this.portals.get(id);
      if (portal) { portal.dispose(); this.portals.delete(id); }
      const asset = this.assets.get(id);
      if (asset) {
        asset.mixer.stopAllAction();
        // WEB-11: a loaded gltf owns its own geometries, materials and textures.
        if (asset.root) disposeSubtree(asset.root);
        this.assets.delete(id);
      }
      this.assetSpecs.delete(id);
      this.audio.remove(id);
      this.video.remove(id);
      this.accessibility.remove(id);
      if (this.characters) this.characters.remove(id);
      if (this.forceFields) this.forceFields.set(id, null, null);
      this.skeletons.delete(id);
      this.blendShapes.delete(id);
      this.shaderGraphs.delete(id);
      this._disposeMultiMaterial(id);
      if (this.physics) this.physics.removeBody(id);
      if (object.isLight && object.target && object.target.parent) object.target.removeFromParent();
      object.removeFromParent();
      // Shared geometry and material entries free their GPU resources with the last
      // user; anything else on this object (the placeholder material, or a loaded
      // asset's own resources) is disposed here.
      const geometryEntry = this.geometryOf.get(id);
      const materialEntry = this.materialOf.get(id);
      const owned = new Set();
      if (geometryEntry) owned.add(geometryEntry.geometry);
      if (materialEntry) owned.add(materialEntry.material);
      const clone = this.opacityMaterials.get(id);
      if (clone) owned.add(clone);
      this._releaseGeometry(id);
      this._releaseMaterial(id);
      object.traverse((node) => {
        if (!node.isMesh) return;
        if (node.geometry && !owned.has(node.geometry) && !this._isSharedGeometry(node.geometry)) {
          node.geometry.dispose();
        }
        const material = node.material;
        if (material && !Array.isArray(material) && !owned.has(material) && !this._isSharedMaterial(material)) {
          material.dispose();
        }
      });
      this.objects.delete(id);
      this.interactive.delete(id);
      this.manipulable.delete(id);
      this.billboards.delete(id);
      this.authoredRotations.delete(id);
      this.opacities.delete(id);
      this.lightDirections.delete(id);
      this.lightIds.delete(id);
      this.worldGroups.delete(id);
      this.bodySpecs.delete(id);
    }

    _isSharedGeometry(geometry) {
      return this._sharedGeometries.has(geometry);
    }

    _isSharedMaterial(material) {
      return this._sharedMaterials.has(material);
    }

    setParent(id, parentId) {
      const object = this.objects.get(id);
      if (!object) return;
      if (parentId === -1) {
        object.removeFromParent();
        this.opacityDirty = true;
        return;
      }
      const parent = parentId === 0 ? this.root : this.objects.get(parentId);
      if (!parent) {
        this.warnOnce(`parent:${parentId}`, `parent id ${parentId} is unknown; "${object.name}" left detached`);
        return;
      }
      // `add` keeps the local transform, which is what the command stream carries.
      parent.add(object);
      this.opacityDirty = true;
    }

    setTransform(id, command) {
      const object = this.objects.get(id);
      if (!object) return;
      if (!finiteRecord(command, 1)) {
        this.recordError('transform', id, new Error('the transform is not finite and was skipped'));
        return;
      }
      object.position.set(command[2], command[3], command[4]);
      object.quaternion.set(command[5], command[6], command[7], command[8]);
      object.scale.set(command[9], command[10], command[11]);
      // SPEC 3.2: billboard facing is a render-time effect, so the transform the
      // script authored is what the dump reports (see `_updateBillboards`).
      if (this.billboards.has(id)) this._noteAuthoredRotation(id, object);
      object.updateMatrix();
      // TRANSFORM on a dynamic body is a teleport (SPEC 3.7); applied after the batch
      // so the object's world matrix is final.
      if (this.physics && this.physics.isDynamic(id)) this._pendingTeleports.add(id);
    }

    /**
     * Batched local TRS for every object that moved this frame (SPEC 5
     * `transforms`): packed `[id, px,py,pz, qx,qy,qz,qw, sx,sy,sz]` records. The
     * core reuses its buffer between frames, so the records are consumed here and
     * never retained.
     */
    setTransforms(records) {
      if (!records || !records.length) return;
      const count = Math.floor(records.length / 11);
      for (let record = 0, o = 0; record < count; record++, o += 11) {
        // Ids are integers below 2^24, which float32 holds exactly.
        const id = records[o];
        const object = this.objects.get(id);
        if (!object) continue;
        if (!finiteRecord(records, o)) {
          this.recordError('transforms record', id, new Error('the record is not finite and was skipped'));
          continue;
        }
        object.position.set(records[o + 1], records[o + 2], records[o + 3]);
        object.quaternion.set(records[o + 4], records[o + 5], records[o + 6], records[o + 7]);
        object.scale.set(records[o + 8], records[o + 9], records[o + 10]);
        if (this.billboards.has(id)) this._noteAuthoredRotation(id, object);
        object.updateMatrix();
        // Same semantics as `transform`: a dynamic body is teleported.
        if (this.physics && this.physics.isDynamic(id)) this._pendingTeleports.add(id);
      }
      this._lastTransformRecords += count;
    }

    setVisible(id, visible) {
      this.withObject(id, (o) => { o.visible = visible; });
    }

    setBillboard(id, on) {
      if (on) {
        this.billboards.add(id);
        // Whatever rotation the object has now is the authored one; the facing
        // that follows is never reported (SPEC 3.2).
        const object = this.objects.get(id);
        if (object) this._noteAuthoredRotation(id, object);
      } else {
        this.billboards.delete(id);
        this.authoredRotations.delete(id);
      }
    }

    /** Remembers the rotation the script set, before any facing is applied. */
    _noteAuthoredRotation(id, object) {
      const q = object.quaternion;
      this.authoredRotations.set(id, [q.x, q.y, q.z, q.w]);
    }

    setManipulable(id, on) {
      if (on) this.manipulable.add(id); else this.manipulable.delete(id);
    }
  };
}

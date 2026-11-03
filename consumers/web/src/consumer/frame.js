// One deterministic frame.
//
// SPEC 6: step physics, sync what moved back to the core, feed it input, run its
// tick, apply the commands it returns, then advance consumer-side visuals.

import {
  EMPTY_RECORDS,
  _matrix,
  _parentQuat,
  _quat,
  _scale,
  _v3,
  now,
} from './internals.js';

/**
 * FA-57: a mixin over the consumer class, so these methods keep `this` and every
 * call site unchanged while living in a file of their own.
 */
export function withFrame(Base) {
  return class extends Base {
    // ------------------------------------------------------------------ frame

    /**
     * One deterministic frame: step physics, sync back, feed input, run the core,
     * apply the resulting commands, then advance consumer-side visuals.
     */
    tick(dt) {
      if (!this.core) return [];
      const frameStarted = now();
      this._logsThisFrame = 0;
      // Media results the elements produced since the last frame, now that any
      // host answer for the same object has had its chance to arrive.
      this.flushDeferredMedia();
      try {
        if (this.physics) {
          // Force fields and character controllers run inside the fixed step.
          this.physics.beforeStep = (step) => {
            if (this.forceFields) this.forceFields.step(step);
            if (this.characters) this.characters.step(step);
          };
          for (const event of this.physics.step(dt)) this._dispatchCollision(event);
          this._pushScriptDrivenBodies();
          if (this.characters) this._applyCharacterTransforms();
        }
        // WEB-14: manipulation reaches the core whether or not physics exists.
        if (!this.manualBridge) {
          this.core.sync(this._syncRecords());
          if (this.physics) this.core.syncBodies(this.physics.bodyRecords());
          this._syncPhase2();
        }
      } catch (err) {
        this.recordError('physics sync', null, err);
      }
      try {
        const liveInput = this.input.consumeState();
        if (this._inputOverride) this.core.setInput(this._inputOverride);
        else if (!this._inputOverridden) this.core.setInput(liveInput);
      } catch (err) {
        this.recordError('setInput', null, err);
      }
      this._inputOverride = null;
      let commands = [];
      const coreStarted = now();
      try {
        commands = this.core.tick(dt) || [];
      } catch (err) {
        // WEB-01: a failing tick is recorded, not thrown; the loop keeps running.
        this.recordError('core.tick', null, err);
      }
      const coreMs = now() - coreStarted;
      this.apply(commands);
      try {
        this.updateVisuals(dt);
      } catch (err) {
        this.recordError('frame update', null, err);
      }
      this.frame += 1;
      this.elapsed += dt;
      this._record(frameStarted, coreMs);
      return commands;
    }

    /** Keeps the last 120 frames, the same window the macOS host's /stats reports. */
    _record(frameStarted, coreMs) {
      const entry = {
        frame: this.frame,
        coreTickMs: coreMs,
        applyMs: this._lastApplyMs || 0,
        commandCount: this._lastCommandCount || 0,
        transformRecords: this._lastTransformRecords || 0,
        frameIntervalMs: this._lastFrameStart ? frameStarted - this._lastFrameStart : 0,
        objectCount: this.objects.size,
        geometryCount: this.geometries.size,
        materialCount: this.materials.size,
      };
      this._lastFrameStart = frameStarted;
      this.stats.push(entry);
      if (this.stats.length > 120) this.stats.shift();
    }

    _dispatchCollision(event) {
      const payload = (other, normal) => ({
        other,
        point: event.point,
        normal,
        impulse: event.impulse,
      });
      this.dispatch(event.type, event.idA, payload(event.idB, event.normal));
      if (this.mirrorCollisionEvents) {
        const flipped = [-event.normal[0], -event.normal[1], -event.normal[2]];
        this.dispatch(event.type, event.idB, payload(event.idA, flipped));
      }
    }

    /** The phase 2 channels: audio, video, character and skeleton state. */
    _syncPhase2() {
      if (typeof this.core.syncAudio === 'function' && this.audio.sources.size) {
        this.core.syncAudio(this.audio.syncRecords());
      }
      if (typeof this.core.syncVideo === 'function' && this.video.screens.size) {
        this.core.syncVideo(this.video.syncRecords());
      }
      if (this.characters && typeof this.core.syncCharacter === 'function' && this.characters.controllers.size) {
        this.core.syncCharacter(this.characters.syncRecords());
      }
      if (typeof this.core.syncSkeleton === 'function') {
        for (const [id, joints] of this.trackedSkeletons()) this.core.syncSkeleton(id, joints);
      }
    }

    /** A character controller is native-driven, like a dynamic body. */
    _applyCharacterTransforms() {
      for (const [id, entry] of this.characters.controllers) {
        const object = this.objects.get(id);
        if (!object) continue;
        const translation = entry.body.translation();
        if (object.parent) {
          object.parent.updateWorldMatrix(true, false);
          _v3.set(translation.x, translation.y, translation.z)
            .applyMatrix4(_matrix.copy(object.parent.matrixWorld).invert());
          object.position.copy(_v3);
        } else {
          object.position.set(translation.x, translation.y, translation.z);
        }
        object.updateMatrix();
      }
    }

    /** Static and kinematic bodies are script-driven; push the core's pose into Rapier. */
    _pushScriptDrivenBodies() {
      for (const [id, entry] of this.physics.bodies) {
        // Triggers are kinematic whatever their `type` says (SPEC 3.7), so ask the
        // physics world rather than the spec.
        if (this.physics.isDynamic(id)) continue;
        const object = this.objects.get(id);
        if (!object) continue;
        object.matrixWorld.decompose(_v3, _quat, _scale);
        // WEB-29: billboard rotation is a consumer-side effect written behind the
        // core's back; feeding it into the body would spin the collider with the
        // camera, so only the position is pushed for a billboarded body.
        const billboarded = this.billboards.has(id);
        if (entry.body.isKinematic()) {
          entry.body.setNextKinematicTranslation({ x: _v3.x, y: _v3.y, z: _v3.z });
          if (!billboarded) {
            entry.body.setNextKinematicRotation({ x: _quat.x, y: _quat.y, z: _quat.z, w: _quat.w });
          }
        } else {
          // Static bodies only move when the script moves them; re-posing every frame
          // would keep waking whatever is resting on them.
          const t = entry.body.translation();
          const r = entry.body.rotation();
          const moved = Math.abs(t.x - _v3.x) > 1e-6 || Math.abs(t.y - _v3.y) > 1e-6 || Math.abs(t.z - _v3.z) > 1e-6;
          const turned = Math.abs(r.x - _quat.x) > 1e-6 || Math.abs(r.y - _quat.y) > 1e-6
            || Math.abs(r.z - _quat.z) > 1e-6 || Math.abs(r.w - _quat.w) > 1e-6;
          if (moved) entry.body.setTranslation({ x: _v3.x, y: _v3.y, z: _v3.z }, true);
          if (turned && !billboarded) {
            entry.body.setRotation({ x: _quat.x, y: _quat.y, z: _quat.z, w: _quat.w }, true);
          }
        }
      }
    }

    /**
     * Physics transforms plus anything the consumer is driving through
     * manipulation. WEB-10: an id appears exactly once. A manipulated dynamic body
     * is driven by the pointer, so it is switched to kinematic for the duration and
     * its simulated pose is not reported.
     */
    _syncRecords() {
      const manipulated = this.input.manipulatedObjects();
      const manipulatedIds = new Set();
      for (const object of manipulated) {
        const id = this.idOf(object);
        if (id !== undefined) manipulatedIds.add(id);
      }
      this._applyManipulationToBodies(manipulatedIds);

      const physicsRecords = this.physics ? this.physics.transformRecords(manipulatedIds) : EMPTY_RECORDS;
      if (!manipulated.length) return physicsRecords;

      const total = physicsRecords.length + manipulatedIds.size * 11;
      if (this._syncScratch.length !== total) this._syncScratch = new Float32Array(total);
      this._syncScratch.set(physicsRecords, 0);
      let o = physicsRecords.length;
      const written = new Set();
      for (const object of manipulated) {
        const id = this.idOf(object);
        if (id === undefined || written.has(id)) continue;
        written.add(id);
        object.updateWorldMatrix(true, false);
        object.matrixWorld.decompose(_v3, _quat, _scale);
        this._syncScratch[o++] = id;
        this._syncScratch[o++] = _v3.x; this._syncScratch[o++] = _v3.y; this._syncScratch[o++] = _v3.z;
        this._syncScratch[o++] = _quat.x; this._syncScratch[o++] = _quat.y;
        this._syncScratch[o++] = _quat.z; this._syncScratch[o++] = _quat.w;
        this._syncScratch[o++] = _scale.x; this._syncScratch[o++] = _scale.y; this._syncScratch[o++] = _scale.z;
      }
      return this._syncScratch.subarray(0, o);
    }

    /**
     * Keeps Rapier in step with a manipulated body: kinematic and pointer-driven
     * while the gesture runs, dynamic again when it ends.
     */
    _applyManipulationToBodies(manipulatedIds) {
      if (!this.physics) return;
      for (const id of manipulatedIds) {
        if (this._manipulatedBodies.has(id)) continue;
        if (this.physics.beginManipulation(id)) this._manipulatedBodies.add(id);
      }
      for (const id of [...this._manipulatedBodies]) {
        if (manipulatedIds.has(id)) {
          const object = this.objects.get(id);
          if (object) this.physics.driveManipulated(id, object);
          continue;
        }
        this.physics.endManipulation(id);
        this._manipulatedBodies.delete(id);
      }
    }

    updateVisuals(dt) {
      this.ensureDefaultLighting();
      for (const id of this.lightDirections.keys()) this._updateLightTarget(id);
      this._updateBillboards();
      for (const emitter of this.emitters.values()) emitter.update(dt);
      this.audio.update();
      for (const [id, entry] of this.assets) {
        entry.mixer.update(dt);
        // FA-26, SPEC 14.5: a native animation owns the pose while it runs, and
        // the core never re-sends an unchanged payload, so the frame the clip
        // stops is the only chance to put the script's own poses back.
        const running = !!(entry.action && entry.action.isRunning());
        if (entry.animating && !running) this.replayHeldSkeletonEdits(id);
        entry.animating = running;
      }
      if (this.opacityDirty) {
        this.applyOpacity();
        this.opacityDirty = false;
      }
      this.root.updateMatrixWorld(true);
    }

    _updateBillboards() {
      if (!this.billboards.size) return;
      this.camera.updateMatrixWorld(true);
      this.camera.getWorldQuaternion(_quat);
      for (const id of this.billboards) {
        const object = this.objects.get(id);
        if (!object) continue;
        if (object.parent) {
          object.parent.updateWorldMatrix(true, false);
          object.parent.getWorldQuaternion(_parentQuat);
          object.quaternion.copy(_parentQuat.invert()).multiply(_quat);
        } else {
          object.quaternion.copy(_quat);
        }
        object.updateMatrix();
      }
    }
  };
}

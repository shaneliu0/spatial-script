// Geometry, materials and textures.
//
// SPEC 5 and SPEC 3.4/3.5: buffers arrive as typed arrays, geometries and
// materials are shared by the uuid the core sends and freed on their last user,
// and textures load into the instance materials are already bound to.

import * as THREE from 'three';
import {
  BLENDING,
  DEFAULT_ASSET_ROOT,
  KNOWN_KEYS,
  MAP_SLOTS,
  MAX_IDLE_GEOMETRIES,
  SIDES,
  WRAPPING,
  fullyDecode,
  now,
  resolveConstant,
  shaderKey,
  stripCredentials,
  toFloat32,
  toUint32,
} from './internals.js';

/**
 * FA-57: a mixin over the consumer class, so these methods keep `this` and every
 * call site unchanged while living in a file of their own.
 */
export function withResources(Base) {
  return class extends Base {
    // -------------------------------------------------------------- geometry

    setGeometry(id, info, positions, normals, uvs, indices) {
      const object = this.objects.get(id);
      if (!object || !object.isMesh) return;
      if (this.portals.has(id)) return;

      const previous = object.geometry;
      this.checkPayloadKeys('geometry', info, KNOWN_KEYS.geometry);
      const entry = this._acquireGeometry(id, info, positions, normals, uvs, indices);
      this._applyGroups(entry.geometry, info && info.groups);
      object.geometry = entry.geometry;
      object.userData.__spatialGeometry = entry.info;

      // WEB-03: a swapped or rewritten geometry means the collider must be derived
      // again, which the in-place body update would not do.
      if (this.bodySpecs.has(id) && (entry.changed || previous !== entry.geometry)) {
        this._pendingBodies.set(id, { spec: this.bodySpecs.get(id), rebuild: true });
      }
    }

    /**
     * Returns the shared BufferGeometry for this uuid, building or refilling it
     * only when the buffers actually differ. Without a uuid (an older core) every
     * command gets its own geometry.
     */
    _acquireGeometry(id, info, positions, normals, uvs, indices) {
      const uuid = info && info.uuid;
      const revision = info && info.revision;
      let entry = uuid ? this.geometries.get(uuid) : null;
      let changed = true;

      if (entry) {
        // A `geometry` command for a uuid and revision the core has already sent
        // arrives with null buffers, so the cached instance is reused untouched.
        changed = revision === undefined || revision !== entry.revision;
        if (changed) {
          if (!positions) {
            // New revision but no data: nothing can be rebuilt from this command.
            this.warnOnce(
              `geometryBuffers:${uuid}`,
              `geometry ${uuid} changed to revision ${revision} without buffers; the previous data is kept`,
            );
            changed = false;
          } else {
            this._fillGeometry(entry.geometry, positions, normals, uvs, indices);
            entry.revision = revision;
          }
        }
        entry.info = info;
      } else {
        if (!positions) {
          // The core believes this consumer already has the geometry, but the
          // cache entry is gone: keeping idle entries below is what avoids this.
          this.warnOnce(
            `geometryMissing:${uuid}`,
            `geometry ${uuid} was re-sent without buffers but is no longer cached; the mesh has no geometry`,
          );
        }
        const geometry = new THREE.BufferGeometry();
        if (positions) this._fillGeometry(geometry, positions, normals, uvs, indices);
        entry = { geometry, users: new Set(), info, uuid, revision };
        if (uuid) this.geometries.set(uuid, entry);
        this._sharedGeometries.add(geometry);
      }

      entry.changed = changed;
      this._releaseGeometry(id, entry);
      entry.users.add(id);
      this.geometryOf.set(id, entry);
      this._idleGeometries.delete(uuid);
      return entry;
    }

    /**
     * A geometry with no users keeps its cache entry, because the core will not
     * re-send the buffers for a uuid and revision it has already delivered. The
     * GPU side is released; the idle entries are kept in insertion order and the
     * oldest are dropped once there are too many.
     */
    _retireGeometry(entry) {
      entry.geometry.dispose();
      if (!entry.uuid) {
        this._sharedGeometries.delete(entry.geometry);
        return;
      }
      this._idleGeometries.delete(entry.uuid);
      this._idleGeometries.add(entry.uuid);
      while (this._idleGeometries.size > MAX_IDLE_GEOMETRIES) {
        const oldest = this._idleGeometries.values().next().value;
        this._idleGeometries.delete(oldest);
        const stale = this.geometries.get(oldest);
        if (!stale || stale.users.size) continue;
        this.geometries.delete(oldest);
        this._sharedGeometries.delete(stale.geometry);
      }
    }

    /**
     * Writes the buffers into a geometry. Attributes are refilled in place when the
     * counts match, so three re-uploads them and the bounding volumes, on which
     * raycasting and culling depend, stay in step.
     */
    _fillGeometry(geometry, positions, normals, uvs, indices) {
      this._setAttribute(geometry, 'position', positions, 3);
      this._setAttribute(geometry, 'normal', normals, 3);
      this._setAttribute(geometry, 'uv', uvs, 2);
      if (indices) {
        const array = toUint32(indices);
        const existing = geometry.index;
        if (existing && existing.array.length === array.length) {
          existing.array.set(array);
          existing.needsUpdate = true;
        } else {
          geometry.setIndex(new THREE.BufferAttribute(array, 1));
        }
      } else {
        geometry.setIndex(null);
      }
      if (!normals) geometry.computeVertexNormals();
      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();
    }

    /** SPEC 14.12: `groups` selects a material per index range. */
    _applyGroups(geometry, groups) {
      geometry.clearGroups();
      if (!groups) return;
      for (const group of groups) geometry.addGroup(group.start, group.count, group.materialIndex);
    }

    _setAttribute(geometry, name, values, itemSize) {
      if (!values) {
        if (geometry.getAttribute(name)) geometry.deleteAttribute(name);
        return;
      }
      const array = toFloat32(values);
      const existing = geometry.getAttribute(name);
      if (existing && existing.array.length === array.length) {
        // Same shape: copy into the live buffer and let three re-upload it.
        if (existing.array !== array) existing.array.set(array);
        existing.needsUpdate = true;
        return;
      }
      geometry.setAttribute(name, new THREE.BufferAttribute(array, itemSize));
    }

    /** Drops `id` from its previous geometry, freeing the GPU buffers with the last user. */
    _releaseGeometry(id, keep = null) {
      const previous = this.geometryOf.get(id);
      if (!previous || previous === keep) return;
      previous.users.delete(id);
      this.geometryOf.delete(id);
      if (previous.users.size === 0) this._retireGeometry(previous);
    }

    // -------------------------------------------------------------- materials

    setMaterial(id, spec) {
      const object = this.objects.get(id);
      if (!object || !object.isMesh || !spec) return;
      if (this.portals.has(id)) return;
      const previous = object.material;
      if (Array.isArray(spec)) {
        // SPEC 14.12: one material per geometry group.
        this._releaseMaterial(id);
        const materials = spec.map((one, index) => this.buildMaterial(one, id, index));
        object.material = materials;
        this.multiMaterials.set(id, materials);
        this.opacityDirty = true;
        if (previous && !Array.isArray(previous) && previous.userData.__placeholder) previous.dispose();
        this.opacityDirty = true;
        return;
      }
      this._disposeMultiMaterial(id);
      const entry = this._acquireMaterial(id, spec);
      object.material = entry.material;
      // The placeholder material a mesh is created with is owned by nobody else.
      // P2-B-12: `previous` may be the material array this mesh just left.
      if (previous && !Array.isArray(previous) && previous !== entry.material
        && previous.userData.__placeholder) {
        previous.dispose();
      }
      this.opacityDirty = true;
    }

    /**
     * Returns the shared material for this uuid. A changed spec is written into the
     * existing instance so every mesh using it updates at once (SPEC 5).
     */
    _acquireMaterial(id, spec, slot = 0) {
      // P2-B-31: the graph identity belongs to the mesh, not to the cache entry, so
      // every mesh binding the uuid records it, not only the one that built it.
      if (spec.type === 'ShaderGraphMaterial') this._recordShaderGraph(id, spec, slot);
      const uuid = spec.uuid;
      let entry = uuid ? this.materials.get(uuid) : null;
      if (entry && entry.type !== spec.type) {
        // A different material class under a recycled uuid: start over.
        this._disposeMaterialEntry(entry);
        entry = null;
      }
      if (entry) {
        const key = JSON.stringify(spec);
        if (entry.key !== key) {
          if (spec.type === 'ShaderGraphMaterial') {
            if (spec.fallback) this.applyMaterial(entry.material, spec.fallback);
          } else {
            this.applyMaterial(entry.material, spec);
          }
          entry.key = key;
          entry.revision += 1;
          this.opacityDirty = true;
        }
      } else {
        const material = this.buildMaterial(spec, id);
        entry = { material, users: new Set(), key: JSON.stringify(spec), revision: 0, uuid, type: spec.type };
        if (uuid) this.materials.set(uuid, entry);
        this._sharedMaterials.add(material);
      }
      this._releaseMaterial(id, entry);
      entry.users.add(id);
      this.materialOf.set(id, entry);
      return entry;
    }

    /** Drops `id` from its previous material, disposing it with the last user. */
    _releaseMaterial(id, keep = null) {
      const previous = this.materialOf.get(id);
      const clone = this.opacityMaterials.get(id);
      if (clone && previous !== keep) {
        clone.dispose();
        this.opacityMaterials.delete(id);
      }
      if (!previous || previous === keep) return;
      previous.users.delete(id);
      this.materialOf.delete(id);
      if (previous.users.size === 0) this._disposeMaterialEntry(previous);
    }

    _disposeMultiMaterial(id) {
      const materials = this.multiMaterials.get(id);
      if (!materials) return;
      this.multiMaterials.delete(id);
      for (const material of materials) material.dispose();
    }

    _disposeMaterialEntry(entry) {
      entry.material.dispose();
      this._sharedMaterials.delete(entry.material);
      if (entry.uuid && this.materials.get(entry.uuid) === entry) this.materials.delete(entry.uuid);
    }

    _recordShaderGraph(id, spec, slot) {
      if (id === null || id === undefined) return;
      this.shaderGraphs.set(shaderKey(id, slot), {
        source: spec.source ?? null,
        name: spec.name ?? null,
        parameters: { ...(spec.parameters || {}) },
        generation: spec.generation ?? 0,
        slot,
      });
    }

    buildMaterial(spec, id = null, slot = 0) {
      if (spec.type === 'ShaderGraphMaterial') {
        this._recordShaderGraph(id, spec, slot);
        // SPEC 14.6: RealityKit loads the graph; the web renders the fallback.
        this.warnOnce(
          'shaderGraph',
          'ShaderGraphMaterial is RealityKit only; the fallback material is rendered here',
        );
        const fallback = spec.fallback
          ? this.buildMaterial(spec.fallback)
          : new THREE.MeshStandardMaterial();
        fallback.userData.__shaderGraph = { source: spec.source ?? null, name: spec.name ?? null };
        return fallback;
      }
      let material;
      switch (spec.type) {
        case 'MeshBasicMaterial':
          material = new THREE.MeshBasicMaterial();
          break;
        case 'MeshPhysicalMaterial':
          material = new THREE.MeshPhysicalMaterial();
          break;
        case 'OcclusionMaterial':
          // Depth-only: occludes what is behind it without drawing colour.
          material = new THREE.MeshBasicMaterial();
          material.colorWrite = false;
          break;
        default:
          material = new THREE.MeshStandardMaterial();
      }
      this.applyMaterial(material, spec);
      return material;
    }

    /** Writes the full material state from a `material` command onto an instance. */
    applyMaterial(material, spec) {
      this.checkPayloadKeys('material', spec, KNOWN_KEYS.material);
      // SPEC 8: the dump reports the type the script asked for; three has one
      // class for two of them (OcclusionMaterial is a depth-only basic).
      if (spec.type) material.userData.__spatialType = spec.type;
      if (spec.color) material.color.setRGB(spec.color[0], spec.color[1], spec.color[2], THREE.LinearSRGBColorSpace);
      material.opacity = spec.opacity ?? 1;
      material.transparent = !!spec.transparent;
      material.side = resolveConstant(spec.side, SIDES, THREE.FrontSide);
      material.wireframe = !!spec.wireframe;
      material.depthWrite = spec.depthWrite ?? true;
      material.depthTest = spec.depthTest ?? true;
      material.blending = resolveConstant(spec.blending, BLENDING, THREE.NormalBlending);

      if (material.isMeshStandardMaterial) {
        material.metalness = spec.metalness ?? 0;
        material.roughness = spec.roughness ?? 1;
        if (spec.emissive) {
          material.emissive.setRGB(spec.emissive[0], spec.emissive[1], spec.emissive[2], THREE.LinearSRGBColorSpace);
        }
        material.emissiveIntensity = spec.emissiveIntensity ?? 1;
      }
      if (material.isMeshPhysicalMaterial) {
        material.clearcoat = spec.clearcoat ?? 0;
        material.clearcoatRoughness = spec.clearcoatRoughness ?? 0;
      }

      const maps = spec.maps || {};
      this._bindMap(material, 'map', maps.map, THREE.SRGBColorSpace);
      this._bindMap(material, 'normalMap', maps.normalMap, THREE.NoColorSpace);
      this._bindMap(material, 'roughnessMap', maps.roughnessMap, THREE.NoColorSpace);
      this._bindMap(material, 'metalnessMap', maps.metalnessMap, THREE.NoColorSpace);
      this._bindMap(material, 'emissiveMap', maps.emissiveMap, THREE.SRGBColorSpace);

      material.userData.__baseOpacity = material.opacity;
      material.userData.__baseTransparent = material.transparent;
      return material;
    }

    _bindMap(material, slot, textureId, colorSpace) {
      if (!(slot in material)) return;
      if (textureId === null || textureId === undefined) {
        material[slot] = null;
        return;
      }
      const entry = this.textures.get(textureId);
      if (!entry) {
        this.warnOnce(`texture:${textureId}`, `material references unknown texture id ${textureId}`);
        return;
      }
      material[slot] = this._textureForColorSpace(entry, colorSpace);
      material.needsUpdate = true;
    }

    /**
     * WEB-18: colour space belongs to the binding, not the image. The first binding
     * uses the loaded texture; a second binding that needs a different space gets a
     * clone sharing the same image, so neither material is decoded wrongly.
     */
    _textureForColorSpace(entry, colorSpace) {
      if (entry.texture.colorSpace === colorSpace || entry.views.size === 0) {
        entry.texture.colorSpace = colorSpace;
        entry.views.set(colorSpace, entry.texture);
        return entry.texture;
      }
      const existing = entry.views.get(colorSpace);
      if (existing) return existing;
      const clone = entry.texture.clone();
      clone.colorSpace = colorSpace;
      clone.needsUpdate = !!clone.image;
      entry.views.set(colorSpace, clone);
      return clone;
    }

    // --------------------------------------------------------------- textures

    /**
     * Resolves a script url. `asset://name` and a relative path are contained to
     * the asset root: the path is normalised and anything that climbs out of the
     * root is refused with a warning rather than reaching the network or the disk
     * (SPEC 3.5). Absolute http, file, data and blob urls are passed through, with
     * any `user:password@` stripped so credentials never reach a log or a dump.
     */
    resolveUrl(url) {
      if (!url) return url;
      const root = this.options.assetRoot || DEFAULT_ASSET_ROOT;
      if (url.startsWith('asset://')) {
        return this._containedUrl(root, url.slice('asset://'.length), url);
      }
      if (/^(https?:|file:|data:|blob:)/.test(url)) return stripCredentials(url);
      // A root-relative path is already absolute for the page, and cannot escape.
      if (url.startsWith('/')) return url;
      // SPEC 3.5: a relative path is relative to the shared asset root. The core
      // has already joined its own `assetRoot` name onto it, so that prefix is
      // dropped before the path is joined onto the served root.
      const prefix = `${(this.options.coreAssetRoot || 'assets').replace(/^\/+|\/+$/g, '')}/`;
      const relative = url.startsWith(prefix) ? url.slice(prefix.length) : url;
      return this._containedUrl(root, relative, url);
    }

    /** Joins `path` onto `root`, refusing a result outside it. */
    _containedUrl(root, path, original) {
      const base = String(root).replace(/\/+$/, '');
      // Percent-encoded separators are still separators: `..%2f..%2fx` must be read
      // as `../../x`, so the path is decoded until it stops changing before it is
      // split. Each surviving segment is re-encoded for the request.
      const segments = [];
      for (const raw of fullyDecode(String(path)).split(/[/\\]/)) {
        if (raw === '' || raw === '.') continue;
        if (raw === '..') {
          if (segments.length === 0) {
            this.warnOnce(
              `urlEscape:${original}`,
              `"${original}" resolves outside the asset root and was refused`,
            );
            return null;
          }
          segments.pop();
          continue;
        }
        segments.push(encodeURIComponent(raw));
      }
      if (!segments.length) {
        this.warnOnce(`urlEmpty:${original}`, `"${original}" names no file inside the asset root and was refused`);
        return null;
      }
      return `${base}/${segments.join('/')}`;
    }

    /**
     * SPEC 5 `texture`. A `null` payload releases the id. A changed url keeps the
     * same THREE.Texture instance and loads new pixels into it, so materials that
     * are already bound stay valid (WEB-12).
     */
    setTexture(textureId, spec) {
      if (spec === null || spec === undefined) {
        this.releaseTexture(textureId);
        return;
      }
      this.checkPayloadKeys('texture', spec, KNOWN_KEYS.texture);
      const url = this.resolveUrl(spec.url);
      if (url === null) return;
      let entry = this.textures.get(textureId);
      if (!entry) {
        // FA-01: the entry is stored before the load starts, because the loader's
        // callbacks check `this.textures.get(id) === entry` before they dispatch
        // `textureLoaded` / `textureError`. Building it from a throwaway literal
        // made the first load of every texture silently eventless.
        entry = { texture: this._newTexture(textureId, url), views: new Map(), url, sourceUrl: spec.url };
        this.textures.set(textureId, entry);
        if (!this.options.loadTexture && this.textureLoader) this._loadImageInto(entry, url, textureId);
      } else if (entry.url !== url) {
        entry.url = url;
        entry.sourceUrl = spec.url;
        this._loadImageInto(entry, url, textureId);
      }

      for (const texture of this._textureViews(entry)) {
        if (spec.repeat) texture.repeat.set(spec.repeat[0], spec.repeat[1]);
        if (spec.offset) texture.offset.set(spec.offset[0], spec.offset[1]);
        texture.wrapS = resolveConstant(spec.wrapS, WRAPPING, THREE.ClampToEdgeWrapping);
        texture.wrapT = resolveConstant(spec.wrapT, WRAPPING, THREE.ClampToEdgeWrapping);
        texture.flipY = spec.flipY ?? true;
        // Marking an image-less texture for update makes three warn on every frame;
        // the loader sets needsUpdate itself once the pixels arrive.
        if (texture.image) texture.needsUpdate = true;
      }
    }

    _textureViews(entry) {
      const views = new Set([entry.texture]);
      for (const view of entry.views.values()) views.add(view);
      return views;
    }

    /** Frees the texture once nothing references it and drops the id (SPEC 5). */
    releaseTexture(textureId) {
      const entry = this.textures.get(textureId);
      if (!entry) return;
      this.textures.delete(textureId);
      // In-flight loads for this id are now stale.
      entry.released = true;
      if (this._textureIsReferenced(entry)) {
        this.warnOnce(
          `textureRelease:${textureId}`,
          `texture ${textureId} was released while a material still references it; it is kept until the material changes`,
        );
        return;
      }
      for (const texture of this._textureViews(entry)) texture.dispose();
    }

    _textureIsReferenced(entry) {
      const views = this._textureViews(entry);
      const uses = (material) => MAP_SLOTS.some((slot) => views.has(material[slot]));
      for (const cached of this.materials.values()) if (uses(cached.material)) return true;
      for (const clone of this.opacityMaterials.values()) if (uses(clone)) return true;
      return false;
    }

    /**
     * Creates the texture for an id. Loader callbacks are tied to the generation
     * they started in, so a result that lands after a hot swap is dropped instead
     * of resolving against whatever object now owns that id (WEB-07).
     */
    _newTexture(textureId, url) {
      if (this.options.loadTexture) return this.options.loadTexture(url, textureId);
      const texture = new THREE.Texture();
      // Headless (node) consumer: record the texture without fetching pixels.
      if (!this.textureLoader) texture.userData.__pending = true;
      return texture;
    }

    /** Loads `url` into an existing texture instance and every colour-space view. */
    _loadImageInto(entry, url, textureId) {
      if (!this.textureLoader || this.manualBridge) return;
      if (!this.imageLoader) this.imageLoader = new THREE.ImageLoader();
      const generation = this.generation;
      const token = this.beginLoad(url);
      this.imageLoader.load(
        url,
        (image) => {
          this.endLoad(token);
          if (generation !== this.generation || entry.released) return;
          for (const texture of this._textureViews(entry)) {
            texture.image = image;
            texture.needsUpdate = true;
          }
          if (textureId !== null && this.textures.get(textureId) === entry) {
            this.dispatch('textureLoaded', textureId, {});
          }
        },
        undefined,
        () => {
          this.endLoad(token);
          if (generation !== this.generation || entry.released) return;
          // A missing texture is a resource problem, not a scene error: the script
          // hears about it through the texture's own error event.
          // SPEC 3.5: the core warns once, backend-neutrally; the platform's
          // words travel in the event payload, not in a second warning.
          const message = `texture failed to load: ${url}`;
          if (textureId !== null && this.textures.get(textureId) === entry) {
            this.dispatch('textureError', textureId, { message });
          }
        },
      );
    }
  };
}

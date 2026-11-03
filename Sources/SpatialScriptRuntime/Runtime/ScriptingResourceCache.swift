//
//  ScriptingResourceCache.swift
//  SpatialScriptRuntime
//
//  Created by Shane Liu on 9/9/26.
//

import Foundation
import RealityKit

/// Shares native resources between the meshes that ask for the same thing.
///
/// The core sends a `geometry` and a `material` command per mesh even when a
/// thousand meshes share one geometry instance, so without this cache a scene
/// of 1500 cubes builds 1500 identical `MeshResource`s. Keys come from the
/// three.js `uuid` in the payload, plus a parameter hash so two distinct
/// instances with identical parameters still share.
@MainActor
final class ScriptingResourceCache {
    /// A script that tweens a colour re-sends `material` every frame with a
    /// new key, so the caches are bounded and evict least recently used.
    ///
    /// The bound only applies to entries nothing is drawing. SPEC 5 lets the
    /// core re-send a geometry it has already delivered with null buffers, so
    /// evicting a resource a live record still draws deletes that model from
    /// the scene with no way to rebuild it: referenced entries are never
    /// candidates, and if the referenced set alone is larger than the cap the
    /// cap grows to hold it.
    static let capacity = 512

    private struct Slot<Value> {
        var value: Value
        var lastUsed: UInt64
    }

    private var meshes: [String: Slot<MeshResource>] = [:]
    private var shapes: [String: Slot<ShapeResource>] = [:]
    private var materials: [ScriptingMaterialKey: Slot<any RealityKit.Material>] = [:]
    private var clock: UInt64 = 0

    private(set) var meshHits = 0
    private(set) var meshBuilds = 0
    private(set) var materialHits = 0
    private(set) var materialBuilds = 0
    private(set) var shapeHits = 0
    private(set) var shapeBuilds = 0
    /// Individual native material property writes, the cost PERF-01 measures.
    private(set) var materialWrites = 0
    /// The key each geometry instance is currently stored under.
    private var meshKeyByUUID: [String: String] = [:]
    /// How many live records draw each key. An entry with a user is never
    /// evicted, and the effective cap follows the referenced set.
    private var meshRefs: [String: Int] = [:]
    private var materialRefs: [ScriptingMaterialKey: Int] = [:]
    private var shapeRefs: [String: Int] = [:]
    private var meshLimit = capacity
    private var materialLimit = capacity
    private var shapeLimit = capacity

    // MARK: - Reference tracking

    func retainMesh(_ key: String) { Self.retain(key, in: &meshRefs) }
    func releaseMesh(_ key: String) { Self.release(key, in: &meshRefs) }
    func retainMaterial(_ key: ScriptingMaterialKey) { Self.retain(key, in: &materialRefs) }
    func releaseMaterial(_ key: ScriptingMaterialKey) { Self.release(key, in: &materialRefs) }
    func retainShape(_ key: String) { Self.retain(key, in: &shapeRefs) }
    func releaseShape(_ key: String) { Self.release(key, in: &shapeRefs) }

    /// Test seam: how many distinct keys are held by a live record.
    var referencedResourceCounts: [String: Int] {
        ["meshes": meshRefs.count, "materials": materialRefs.count, "shapes": shapeRefs.count]
    }

    private static func retain<Key: Hashable>(_ key: Key, in refs: inout [Key: Int]) {
        refs[key, default: 0] += 1
    }

    private static func release<Key: Hashable>(_ key: Key, in refs: inout [Key: Int]) {
        guard let count = refs[key] else { return }
        if count <= 1 {
            refs[key] = nil
        } else {
            refs[key] = count - 1
        }
    }

    func countMaterialWrites(_ count: Int) { materialWrites += count }

    /// `uuid` identifies the geometry *instance*: a new revision of the same
    /// instance supersedes the old resource rather than adding one, so a
    /// BufferGeometry the script edits every frame keeps exactly one entry
    /// while 1500 objects sharing one instance still build once.
    /// Drops the entry a geometry instance holds, for an object that has been
    /// destroyed: a buffer geometry's mesh is as large as its buffers and
    /// nothing else can reach it once its last user is gone.
    func releaseGeometry(uuid: String) {
        guard let key = meshKeyByUUID.removeValue(forKey: uuid) else { return }
        // Another instance may share this key: a thousand separate BoxGeometry
        // instances with the same numbers do. It goes only when nothing draws it.
        guard meshRefs[key] == nil else { return }
        meshes[key] = nil
    }

    func mesh(forKey key: String?, uuid: String? = nil, build: () -> MeshResource?) -> MeshResource? {
        guard let key else {
            meshBuilds += 1
            return build()
        }
        clock += 1
        if let cached = meshes[key] {
            meshHits += 1
            meshes[key]?.lastUsed = clock
            return cached.value
        }
        meshBuilds += 1
        guard let built = build() else { return nil }
        if let uuid {
            if let previous = meshKeyByUUID[uuid], previous != key { meshes[previous] = nil }
            meshKeyByUUID[uuid] = key
        }
        // Replaced, never accumulated: the same uuid arriving with new buffers
        // supersedes the old resource instead of adding one.
        meshes[key] = Slot(value: built, lastUsed: clock)
        Self.evict(&meshes, referenced: meshRefs, keeping: key, limit: &meshLimit)
        return built
    }

    func shape(forKey key: String, build: () -> ShapeResource?) -> ShapeResource? {
        clock += 1
        if let cached = shapes[key] {
            shapeHits += 1
            shapes[key]?.lastUsed = clock
            return cached.value
        }
        shapeBuilds += 1
        guard let built = build() else { return nil }
        shapes[key] = Slot(value: built, lastUsed: clock)
        Self.evict(&shapes, referenced: shapeRefs, keeping: key, limit: &shapeLimit)
        return built
    }

    func material(
        forKey key: ScriptingMaterialKey?,
        build: () -> any RealityKit.Material
    ) -> any RealityKit.Material {
        guard let key else {
            materialBuilds += 1
            return build()
        }
        clock += 1
        if let cached = materials[key] {
            materialHits += 1
            materials[key]?.lastUsed = clock
            return cached.value
        }
        materialBuilds += 1
        let built = build()
        materials[key] = Slot(value: built, lastUsed: clock)
        Self.evict(&materials, referenced: materialRefs, keeping: key, limit: &materialLimit)
        return built
    }

    func cachedMaterial(forKey key: ScriptingMaterialKey?) -> (any RealityKit.Material)? {
        guard let key else { return nil }
        return materials[key]?.value
    }

    /// Texture resource identity is part of the material key, so a finished
    /// load mints a new key on its own. Kept only for a full teardown.
    func invalidateMaterials() {
        materials.removeAll()
    }

    func removeAll() {
        meshKeyByUUID.removeAll()
        meshes.removeAll()
        shapes.removeAll()
        materials.removeAll()
        meshRefs.removeAll()
        materialRefs.removeAll()
        shapeRefs.removeAll()
        meshLimit = Self.capacity
        materialLimit = Self.capacity
        shapeLimit = Self.capacity
    }

    /// Amortised O(1) and never destructive: only entries nothing draws are
    /// candidates, oldest first, a quarter of the cap at a time. A resource a
    /// live record still draws cannot be rebuilt from a later buffer-less
    /// re-send (SPEC 5), so it stays; when the referenced set alone is larger
    /// than the cap, the cap follows it rather than sweeping on every insert.
    private static func evict<Key, Value>(
        _ storage: inout [Key: Slot<Value>],
        referenced: [Key: Int],
        keeping newest: Key,
        limit: inout Int
    ) {
        guard storage.count > limit else { return }
        let excess = storage.count - capacity + capacity / 4
        if excess > 0 {
            // The entry that triggered the sweep is not a candidate: its record
            // adopts it as this call returns, so it is referenced in all but
            // instruction order.
            let doomed = storage
                .filter { referenced[$0.key] == nil && $0.key != newest }
                .sorted { $0.value.lastUsed < $1.value.lastUsed }
                .prefix(excess)
                .map(\.key)
            for key in doomed { storage[key] = nil }
        }
        limit = max(capacity, referenced.count + 1 + capacity / 4)
    }

    var summary: [String: Int] {
        [
            "meshHits": meshHits,
            "meshBuilds": meshBuilds,
            "materialHits": materialHits,
            "materialBuilds": materialBuilds,
            "shapeHits": shapeHits,
            "shapeBuilds": shapeBuilds,
            "cachedMeshes": meshes.count,
            "cachedMaterials": materials.count,
            "cachedShapes": shapes.count,
            "materialWrites": materialWrites,
        ]
    }
}

extension ScriptingGeometryFactory {
    /// SPEC 5: "consumers cache native mesh resources by uuid and revision (and
    /// by a parameters hash for parametric types)".
    ///
    /// A parametric geometry is keyed by its type, parameters and revision, so
    /// 1500 *separate* `BoxGeometry` instances with the same numbers share one
    /// native mesh and an in-place edit of one still rebuilds. A buffer
    /// geometry has no parameters, so it is keyed by uuid and revision: every
    /// sharer of one instance gets the same resource, and an edit supersedes
    /// it rather than adding another.
    static func cacheKey(
        type: String,
        parameters: [String: Any],
        uuid: String?,
        revision: String?,
        buffers: Buffers
    ) -> String? {
        // SPEC 5: "consumers cache native mesh resources by uuid and revision
        // (and by a parameters hash for parametric types)". The revision is what
        // makes an in-place buffer edit rebuild instead of returning the mesh
        // from before the edit; the uuid is what lets 1500 objects sharing one
        // BufferGeometry build a single resource.
        switch type {
        case "BoxGeometry", "SphereGeometry", "PlaneGeometry",
             "CylinderGeometry", "ConeGeometry", "TextGeometry",
             "TorusGeometry", "CapsuleGeometry", "CircleGeometry", "RingGeometry":
            // A parametric geometry is fully described by its type, parameters
            // and revision, so 1500 separate BoxGeometry instances with the
            // same numbers share one native mesh. Keying these by uuid as well
            // would mint a resource per instance for no gain.
            return "\(type)|\(parameterSignature(parameters))|r\(revision ?? "0")"
        default:
            // A buffer geometry has nothing but its identity: uuid names the
            // instance, revision the edit. The key does not depend on the
            // buffers arriving: the core sends them once per instance, so the
            // 1499 sharers that follow carry none and must still hit.
            guard let uuid else { return nil }
            _ = buffers
            return "\(type)|\(uuid)|r\(revision ?? "0")"
        }
    }

    /// SPEC 5's revision is an **opaque token**, not a number: the core emits
    /// `"<structural>:<position>:<normal>:<uv>:<index>"` (for example
    /// `"10:0:0:0:0"`), built from the attribute versions in
    /// `core/src/util/diff.js`. Reading it as a number made every revision of a
    /// geometry collide on one key, so an in-place edit kept drawing the mesh
    /// from before the edit. Anything else the payload could carry is compared
    /// as its own text rather than being dropped.
    static func revisionToken(_ value: Any?) -> String? {
        switch value {
        case let string as String:
            return string
        case let number as NSNumber:
            return number.stringValue
        default:
            return nil
        }
    }

    /// Total by construction. Only finite numbers, booleans and short strings
    /// take part; anything else contributes a fixed sentinel. A geometry
    /// parameter is never anything else, and `String(describing:)` on an
    /// arbitrary value is what blew the stack when a script polluted
    /// `Object.prototype`.
    static func parameterSignature(_ parameters: [String: Any]) -> String {
        parameters.keys.sorted().map { key in
            switch parameters[key] {
            case let number as NSNumber where CFGetTypeID(number) == CFBooleanGetTypeID():
                "\(key)=\(number.boolValue)"
            case let number as NSNumber where number.doubleValue.isFinite:
                "\(key)=\(number.doubleValue)"
            case let string as String where string.count < 256:
                "\(key)=\(string)"
            default:
                "\(key)=?"
            }
        }.joined(separator: ",")
    }

}

/// Identifies one native material without building a string. The uuid names
/// the instance; the state follows it so a change to a shared material yields a
/// new native material for every user.
struct ScriptingMaterialKey: Hashable {
    var uuid: String
    var type: String
    var color: SIMD3<Float>
    var opacity: Float
    var transparent: Bool
    var side: Int
    var wireframe: Bool
    var metalness: Float
    var roughness: Float
    var emissive: SIMD3<Float>
    var emissiveIntensity: Float
    var clearcoat: Float
    var clearcoatRoughness: Float
    var depthWrite: Bool
    var depthTest: Bool
    var blending: Int
    /// The map slots, their resource presence and their sampler settings,
    /// folded into one integer. Three dictionaries here made hashing and
    /// equality the dominant cost of a scene load.
    var mapsHash: Int
}

@MainActor
extension ScriptingMaterialSpec {
    func cacheKey(textures: ScriptingTextureStore) -> ScriptingMaterialKey? {
        var mapsHash = 0
        for (slot, id) in maps {
            let entry = textures.entry(for: id)
            var hasher = Hasher()
            hasher.combine(slot)
            hasher.combine(id)
            hasher.combine(textures.resource(for: id) != nil)
            hasher.combine(entry?.wrapS ?? 0)
            hasher.combine(entry?.wrapT ?? 0)
            hasher.combine(entry?.flipY ?? true)
            // Order independent, so the slot order never changes the key.
            mapsHash ^= hasher.finalize()
        }
        return ScriptingMaterialKey(
            uuid: uuid ?? "-",
            type: type,
            color: color,
            opacity: opacity,
            transparent: transparent,
            side: side,
            wireframe: wireframe,
            metalness: metalness,
            roughness: roughness,
            emissive: emissive,
            emissiveIntensity: emissiveIntensity,
            clearcoat: clearcoat,
            clearcoatRoughness: clearcoatRoughness,
            depthWrite: depthWrite,
            depthTest: depthTest,
            blending: blending,
            mapsHash: mapsHash
        )
    }
}

//
//  ScriptingResourceCache.swift
//  RealityKitScripting
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

    func countMaterialWrites(_ count: Int) { materialWrites += count }

    func mesh(forKey key: String?, build: () -> MeshResource?) -> MeshResource? {
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
        // Replaced, never accumulated: the same uuid arriving with new buffers
        // supersedes the old resource instead of adding one.
        meshes[key] = Slot(value: built, lastUsed: clock)
        Self.evict(&meshes)
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
        Self.evict(&shapes)
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
        Self.evict(&materials)
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
        meshes.removeAll()
        shapes.removeAll()
        materials.removeAll()
    }

    /// Amortised O(1): when the cache is over capacity a quarter of the oldest
    /// entries go in one pass, rather than a linear scan on every access.
    private static func evict<Key, Value>(_ storage: inout [Key: Slot<Value>]) {
        guard storage.count > capacity else { return }
        let excess = storage.count - capacity + capacity / 4
        let doomed = storage
            .sorted { $0.value.lastUsed < $1.value.lastUsed }
            .prefix(excess)
            .map(\.key)
        for key in doomed { storage[key] = nil }
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
    /// Parametric geometries are fully described by their type and parameters,
    /// so two instances with the same numbers share one native mesh. Buffer
    /// geometries are keyed by uuid plus a cheap checksum of the positions, so
    /// an in-place edit of the same geometry object still rebuilds.
    static func cacheKey(
        type: String,
        parameters: [String: Any],
        uuid: String?,
        buffers: Buffers
    ) -> String? {
        switch type {
        case "BoxGeometry", "SphereGeometry", "PlaneGeometry",
             "CylinderGeometry", "ConeGeometry", "TextGeometry",
             "TorusGeometry", "CapsuleGeometry", "CircleGeometry", "RingGeometry":
            return "\(type)|\(parameterSignature(parameters))"
        default:
            // A BufferGeometry the script edits per frame mints a new key every
            // frame and stores a fresh multi-megabyte MeshResource, so it is not
            // cached at all: the cache exists for the parametric types.
            _ = uuid
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

    private static func checksum(_ values: [Float]) -> UInt64 {
        var hash: UInt64 = 1469598103934665603
        for value in values {
            hash = (hash ^ UInt64(value.bitPattern)) &* 1099511628211
        }
        return hash
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

//
//  ScriptingMaterialFactory.swift
//  RealityKitScripting
//
//  Created by Shane Liu on 9/9/26.
//

import Foundation
import Metal
import RealityKit

/// The decoded form of a `material` command. Kept so a texture that finishes
/// loading later can rebuild every material that referenced it.
struct ScriptingMaterialSpec {
    var type: String = "MeshStandardMaterial"
    var color: SIMD3<Float> = SIMD3(1, 1, 1)
    var opacity: Float = 1
    var transparent = false
    var side = 0
    var wireframe = false
    var metalness: Float = 0
    var roughness: Float = 1
    var emissive: SIMD3<Float> = .zero
    var emissiveIntensity: Float = 1
    var clearcoat: Float = 0
    var clearcoatRoughness: Float = 0
    var depthWrite = true
    var depthTest = true
    var blending = 1
    var maps: [String: Int] = [:]
    var uuid: String?

    init(payload: [String: Any]) {
        type = payload["type"] as? String ?? type
        uuid = payload["uuid"] as? String
        color = Self.vector3(payload["color"]) ?? color
        opacity = Self.float(payload["opacity"]) ?? opacity
        transparent = payload["transparent"] as? Bool ?? transparent
        side = Self.int(payload["side"]) ?? side
        wireframe = payload["wireframe"] as? Bool ?? wireframe
        metalness = Self.float(payload["metalness"]) ?? metalness
        roughness = Self.float(payload["roughness"]) ?? roughness
        emissive = Self.vector3(payload["emissive"]) ?? emissive
        emissiveIntensity = Self.float(payload["emissiveIntensity"]) ?? emissiveIntensity
        clearcoat = Self.float(payload["clearcoat"]) ?? clearcoat
        clearcoatRoughness = Self.float(payload["clearcoatRoughness"]) ?? clearcoatRoughness
        depthWrite = payload["depthWrite"] as? Bool ?? depthWrite
        depthTest = payload["depthTest"] as? Bool ?? depthTest
        blending = Self.int(payload["blending"]) ?? blending
        if let maps = payload["maps"] as? [String: Any] {
            for (key, value) in maps {
                if let id = Self.int(value) { self.maps[key] = id }
            }
        }
    }

    var referencedTextureIDs: Set<Int> { Set(maps.values) }

    private static func float(_ value: Any?) -> Float? { (value as? NSNumber)?.floatValue }
    private static func int(_ value: Any?) -> Int? { (value as? NSNumber)?.intValue }
    private static func vector3(_ value: Any?) -> SIMD3<Float>? {
        guard let array = value as? [Any], array.count >= 3 else { return nil }
        return SIMD3(
            (array[0] as? NSNumber)?.floatValue ?? 0,
            (array[1] as? NSNumber)?.floatValue ?? 0,
            (array[2] as? NSNumber)?.floatValue ?? 0
        )
    }
}

/// Builds RealityKit materials from a ``ScriptingMaterialSpec`` following the
/// mapping table in SPEC section 3.4.
@MainActor
enum ScriptingMaterialFactory {
    /// Rewrites only the properties that differ from `previous`, and returns
    /// how many native writes that took.
    ///
    /// A property write on a RealityKit material costs ~0.15 ms, so rebuilding
    /// a material for a colour tween cost 0.63 ms per mesh per frame. A tween
    /// now costs exactly one write.
    @discardableResult
    static func update(
        _ material: inout any RealityKit.Material,
        from previous: ScriptingMaterialSpec,
        to spec: ScriptingMaterialSpec,
        textures: ScriptingTextureStore,
        warnings: ScriptingWarningCollector
    ) -> Int {
        if spec.wireframe, !previous.wireframe {
            warnings.warnOnce(
                "\(spec.type).wireframe is unsupported in RealityKit",
                key: "wireframe-\(spec.type)"
            )
        }
        if spec.blending == 2, previous.blending != 2 {
            warnings.warnOnce(
                "AdditiveBlending is unsupported in RealityKit; the material renders as transparent",
                key: "additive-blending"
            )
        }

        var writes = 0
        if var physical = material as? PhysicallyBasedMaterial {
            if spec.color != previous.color || spec.maps["map"] != previous.maps["map"] {
                physical.baseColor = .init(
                    tint: ScriptingColor.platformColor(linear: spec.color),
                    texture: texture(spec.maps["map"], textures)
                )
                writes += 1
            }
            if spec.metalness != previous.metalness || spec.maps["metalnessMap"] != previous.maps["metalnessMap"] {
                if let map = texture(spec.maps["metalnessMap"], textures) {
                    physical.metallic = .init(scale: spec.metalness, texture: map)
                } else {
                    physical.metallic = .init(floatLiteral: spec.metalness)
                }
                writes += 1
            }
            if spec.roughness != previous.roughness || spec.maps["roughnessMap"] != previous.maps["roughnessMap"] {
                if let map = texture(spec.maps["roughnessMap"], textures) {
                    physical.roughness = .init(scale: spec.roughness, texture: map)
                } else {
                    physical.roughness = .init(floatLiteral: spec.roughness)
                }
                writes += 1
            }
            if spec.emissive != previous.emissive || spec.maps["emissiveMap"] != previous.maps["emissiveMap"] {
                physical.emissiveColor = .init(
                    color: ScriptingColor.platformColor(linear: spec.emissive),
                    texture: texture(spec.maps["emissiveMap"], textures)
                )
                writes += 1
            }
            if spec.emissiveIntensity != previous.emissiveIntensity {
                physical.emissiveIntensity = spec.emissiveIntensity
                writes += 1
            }
            if spec.maps["normalMap"] != previous.maps["normalMap"],
               let map = texture(spec.maps["normalMap"], textures) {
                physical.normal = .init(texture: map)
                writes += 1
            }
            if spec.clearcoat != previous.clearcoat {
                physical.clearcoat = .init(floatLiteral: spec.clearcoat)
                writes += 1
            }
            if spec.clearcoatRoughness != previous.clearcoatRoughness {
                physical.clearcoatRoughness = .init(floatLiteral: spec.clearcoatRoughness)
                writes += 1
            }
            if spec.side != previous.side {
                physical.faceCulling = faceCulling(for: spec.side)
                writes += 1
            }
            if isTransparent(spec) != isTransparent(previous) || spec.opacity != previous.opacity {
                physical.blending = isTransparent(spec)
                    ? .transparent(opacity: .init(floatLiteral: spec.opacity))
                    : .opaque
                writes += 1
            }
            if spec.depthWrite != previous.depthWrite {
                physical.writesDepth = spec.depthWrite
                writes += 1
            }
            if spec.depthTest != previous.depthTest {
                physical.readsDepth = spec.depthTest
                writes += 1
            }
            material = physical
            return writes
        }

        if var unlit = material as? UnlitMaterial {
            if spec.color != previous.color || spec.maps["map"] != previous.maps["map"] {
                unlit.color = .init(
                    tint: ScriptingColor.platformColor(linear: spec.color),
                    texture: texture(spec.maps["map"], textures)
                )
                writes += 1
            }
            if spec.side != previous.side {
                unlit.faceCulling = faceCulling(for: spec.side)
                writes += 1
            }
            if isTransparent(spec) != isTransparent(previous) || spec.opacity != previous.opacity {
                unlit.blending = isTransparent(spec)
                    ? .transparent(opacity: .init(floatLiteral: spec.opacity))
                    : .opaque
                writes += 1
            }
            if spec.depthWrite != previous.depthWrite {
                unlit.writesDepth = spec.depthWrite
                writes += 1
            }
            if spec.depthTest != previous.depthTest {
                unlit.readsDepth = spec.depthTest
                writes += 1
            }
            material = unlit
            return writes
        }
        return writes
    }

    /// True when the two specs need different native material types.
    static func needsRebuild(from previous: ScriptingMaterialSpec, to spec: ScriptingMaterialSpec) -> Bool {
        nativeKind(previous) != nativeKind(spec)
            || previous.maps["map"] != spec.maps["map"]
            && (previous.maps["map"] == nil || spec.maps["map"] == nil)
    }

    private static func nativeKind(_ spec: ScriptingMaterialSpec) -> Int {
        switch spec.type {
        case "OcclusionMaterial": 2
        case "MeshBasicMaterial": 1
        default: 0
        }
    }
    static func material(
        for spec: ScriptingMaterialSpec,
        textures: ScriptingTextureStore,
        warnings: ScriptingWarningCollector
    ) -> any RealityKit.Material {
        if spec.wireframe {
            warnings.warnOnce(
                "\(spec.type).wireframe is unsupported in RealityKit",
                key: "wireframe-\(spec.type)"
            )
        }
        if spec.blending == 2 {
            warnings.warnOnce(
                "AdditiveBlending is unsupported in RealityKit; the material renders as transparent",
                key: "additive-blending"
            )
        }

        switch spec.type {
        case "OcclusionMaterial":
#if os(visionOS)
            return OcclusionMaterial()
#else
            return OcclusionMaterial(receivesDynamicLighting: false)
#endif

        case "MeshBasicMaterial":
            var material = UnlitMaterial()
            // Every property write on a RealityKit material costs a native
            // round trip (~0.15 ms, ~0.6 ms for the first), so only values that
            // differ from the engine defaults are written. Those defaults match
            // the three.js defaults exactly, apart from clearcoatRoughness.
            if spec.color != .one || spec.maps["map"] != nil {
                material.color = .init(
                    tint: ScriptingColor.platformColor(linear: spec.color),
                    texture: texture(spec.maps["map"], textures)
                )
            }
            if spec.side != 0 { material.faceCulling = faceCulling(for: spec.side) }
            if isTransparent(spec) {
                material.blending = .transparent(opacity: .init(floatLiteral: spec.opacity))
            }
            if !spec.depthWrite { material.writesDepth = false }
            if !spec.depthTest { material.readsDepth = false }
            if let transform = coordinateTransform(spec, textures) {
                material.textureCoordinateTransform = transform
            }
            return material

        default:
            var material = PhysicallyBasedMaterial()
            if spec.color != .one || spec.maps["map"] != nil {
                material.baseColor = .init(
                    tint: ScriptingColor.platformColor(linear: spec.color),
                    texture: texture(spec.maps["map"], textures)
                )
            }
            if let map = texture(spec.maps["metalnessMap"], textures) {
                material.metallic = .init(scale: spec.metalness, texture: map)
            } else if spec.metalness != 0 {
                material.metallic = .init(floatLiteral: spec.metalness)
            }
            if let map = texture(spec.maps["roughnessMap"], textures) {
                material.roughness = .init(scale: spec.roughness, texture: map)
            } else if spec.roughness != 1 {
                material.roughness = .init(floatLiteral: spec.roughness)
            }
            if spec.emissive != .zero || spec.maps["emissiveMap"] != nil {
                material.emissiveColor = .init(
                    color: ScriptingColor.platformColor(linear: spec.emissive),
                    texture: texture(spec.maps["emissiveMap"], textures)
                )
            }
            if spec.emissiveIntensity != 1 { material.emissiveIntensity = spec.emissiveIntensity }
            if let map = texture(spec.maps["normalMap"], textures) {
                material.normal = .init(texture: map)
            }
            if spec.clearcoat != 0 { material.clearcoat = .init(floatLiteral: spec.clearcoat) }
            if spec.clearcoat != 0 || spec.clearcoatRoughness != 0 {
                material.clearcoatRoughness = .init(floatLiteral: spec.clearcoatRoughness)
            }
            if spec.side != 0 { material.faceCulling = faceCulling(for: spec.side) }
            if isTransparent(spec) {
                material.blending = .transparent(opacity: .init(floatLiteral: spec.opacity))
            }
            if !spec.depthWrite { material.writesDepth = false }
            if !spec.depthTest { material.readsDepth = false }
            if let transform = coordinateTransform(spec, textures) {
                material.textureCoordinateTransform = transform
            }
            return material
        }
    }

    private static func isTransparent(_ spec: ScriptingMaterialSpec) -> Bool {
        spec.transparent || spec.opacity < 1 || spec.blending == 2
    }

    private static func faceCulling(for side: Int) -> MaterialParameterTypes.FaceCulling {
        switch side {
        case 1: .front
        case 2: .none
        default: .back
        }
    }

    private static func texture(
        _ id: Int?,
        _ textures: ScriptingTextureStore
    ) -> MaterialParameters.Texture? {
        guard let id, let resource = textures.resource(for: id) else { return nil }
        guard let entry = textures.entry(for: id) else {
            return MaterialParameters.Texture(resource)
        }
        var sampler = MaterialParameters.Texture.Sampler()
        sampler.modify { descriptor in
            descriptor.sAddressMode = addressMode(for: entry.wrapS)
            descriptor.tAddressMode = addressMode(for: entry.wrapT)
        }
        return MaterialParameters.Texture(resource, sampler: sampler)
    }

    /// three.js wrap constants: 1000 repeat, 1001 clamp to edge, 1002 mirrored.
    private static func addressMode(for wrap: Int) -> MTLSamplerAddressMode {
        switch wrap {
        case 1001: .clampToEdge
        case 1002: .mirrorRepeat
        default: .repeat
        }
    }

    /// Nil when the texture transform is the identity, so the setter is skipped.
    private static func coordinateTransform(
        _ spec: ScriptingMaterialSpec,
        _ textures: ScriptingTextureStore
    ) -> MaterialParameterTypes.TextureCoordinateTransform? {
        guard let id = spec.maps["map"], let entry = textures.entry(for: id) else { return nil }
        guard entry.offset != .zero || entry.repeats != SIMD2<Float>(1, 1) else { return nil }
        return .init(offset: entry.offset, scale: entry.repeats, rotation: 0)
    }
}

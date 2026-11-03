//
//  ScriptingGeometryFactory.swift
//  SpatialScriptRuntime
//
//  Created by Shane Liu on 9/9/26.
//

import CoreGraphics
import CoreText
import Foundation
import RealityKit

/// Turns a `geometry` command into a `MeshResource`.
///
/// The parametric types listed in SPEC section 5 use RealityKit's own
/// generators so they carry proper normals, UVs and tessellation. Everything
/// else is rebuilt from the buffers the core supplies. Winding is passed
/// through unchanged: three.js and RealityKit both treat counter-clockwise
/// triangles as front facing in a right handed, Y up space.
@MainActor
enum ScriptingGeometryFactory {
    struct Buffers {
        var positions: [Float]
        var normals: [Float]?
        var uvs: [Float]?
        var indices: [UInt32]?
    }

    static func mesh(
        type: String,
        parameters: [String: Any],
        buffers: Buffers,
        warnings: ScriptingWarningCollector
    ) -> MeshResource? {
        // A native generator can only draw the whole primitive. When the
        // parameters describe a partial one the command's buffers are the only
        // faithful source, so they win.
        if let partial = partialReason(type: type, parameters: parameters) {
            warnings.warnOnce(
                "\(type) with \(partial) has no RealityKit generator; "
                + "the mesh is rebuilt from the geometry buffers",
                key: "partial-\(type)"
            )
            return meshFromBuffers(buffers)
        }

        switch type {
        case "BoxGeometry":
            return .generateBox(
                width: number(parameters, "width", 1),
                height: number(parameters, "height", 1),
                depth: number(parameters, "depth", 1)
            )

        case "SphereGeometry":
            return .generateSphere(radius: number(parameters, "radius", 1))

        case "PlaneGeometry":
            return .generatePlane(
                width: number(parameters, "width", 1),
                height: number(parameters, "height", 1)
            )

        case "CylinderGeometry":
            let top = number(parameters, "radiusTop", 1)
            let bottom = number(parameters, "radiusBottom", 1)
            if abs(top - bottom) < 1e-5 {
                return .generateCylinder(height: number(parameters, "height", 1), radius: top)
            }
            warnings.warnOnce(
                "CylinderGeometry with radiusTop != radiusBottom has no RealityKit generator; "
                + "the mesh is rebuilt from the geometry buffers."
            )
            return meshFromBuffers(buffers)

        case "ConeGeometry":
            return .generateCone(
                height: number(parameters, "height", 1),
                radius: number(parameters, "radius", 1)
            )

        case "TextGeometry":
            let text = parameters["text"] as? String ?? ""
            let size = number(parameters, "size", 0.1)
            let depth = number(parameters, "depth", 0.01)
            // three.js text starts at x = 0 on the baseline. RealityKit centres
            // its own text, so the mesh is shifted to sit on the same bounds the
            // core reports from the vertices it sent.
            let mesh = MeshResource.generateText(
                text,
                extrusionDepth: depth,
                font: .systemFont(ofSize: CGFloat(size)),
                containerFrame: .zero,
                alignment: .left
            )
            guard let target = bounds(of: buffers.positions) else { return mesh }
            let offset = target.center - mesh.bounds.center
            guard simd_length(offset) > 1e-6 else { return mesh }
            var descriptors = mesh.contents
            descriptors.models = .init(descriptors.models.map { model in
                var moved = model
                moved.parts = .init(model.parts.map { part in
                    var shifted = part
                    if let positions = part.positions.elements as [SIMD3<Float>]? {
                        shifted.positions = .init(positions.map { $0 + offset })
                    }
                    return shifted
                })
                return moved
            })
            return (try? MeshResource.generate(from: descriptors)) ?? mesh

        default:
            return meshFromBuffers(buffers)
        }
    }

    /// SPEC 14.12: one `MeshPart` worth of faces per `geometry.groups` entry,
    /// so `ModelComponent.materials` can give each group its own material.
    /// `start` and `count` are index-buffer offsets, as in three.js.
    struct Group {
        var start: Int
        var count: Int
        var materialIndex: Int

        init?(_ raw: Any) {
            guard let entry = raw as? [String: Any],
                  let start = (entry["start"] as? NSNumber)?.intValue,
                  let count = (entry["count"] as? NSNumber)?.intValue else { return nil }
            self.start = start
            self.count = count
            materialIndex = (entry["materialIndex"] as? NSNumber)?.intValue ?? 0
        }
    }

    /// The groups that actually split the mesh. A geometry with one group, or
    /// with every group pointing at the same material, is a one-part mesh.
    ///
    /// three.js gives an ordinary box six groups, one per face, so this is the
    /// common case and not the exception: a grouped mesh has to stay shareable
    /// or 1500 boxes rebuild 1500 meshes.
    static func groups(from descriptor: [String: Any]) -> [Group]? {
        guard let raw = descriptor["groups"] as? [Any] else { return nil }
        let parsed = raw.compactMap(Group.init)
        guard parsed.count > 1 else { return nil }
        guard Set(parsed.map(\.materialIndex)).count > 1 else { return nil }
        return parsed
    }

    /// How many materials a grouped mesh draws.
    static func partCount(_ groups: [Group]) -> Int {
        (groups.map(\.materialIndex).max() ?? 0) + 1
    }

    /// The groups are part of the mesh's identity: two objects with the same
    /// parametric geometry and the same groups share one native resource.
    static func groupSignature(_ groups: [Group]) -> String {
        groups.map { "\($0.start):\($0.count):\($0.materialIndex)" }.joined(separator: ",")
    }

    /// A face-to-material index map for a grouped geometry, or nil when the
    /// groups do not describe whole triangles of the index buffer.
    static func perFaceMaterials(groups: [Group], triangleCount: Int) -> [UInt32]? {
        guard triangleCount > 0 else { return nil }
        var faces = [UInt32](repeating: 0, count: triangleCount)
        var covered = false
        for group in groups {
            guard group.count > 0, group.start >= 0 else { continue }
            let first = group.start / 3
            let last = min(triangleCount, (group.start + group.count) / 3)
            guard first < last else { continue }
            for face in first..<last { faces[face] = UInt32(max(0, group.materialIndex)) }
            covered = true
        }
        return covered ? faces : nil
    }

    static func meshFromBuffers(_ buffers: Buffers, groups: [Group]? = nil) -> MeshResource? {
        let positions = buffers.positions
        guard positions.count >= 9, positions.count % 3 == 0 else { return nil }
        let vertexCount = positions.count / 3

        var descriptor = MeshDescriptor(name: "spatial")
        descriptor.positions = MeshBuffers.Positions(
            stride(from: 0, to: positions.count, by: 3).map {
                SIMD3<Float>(positions[$0], positions[$0 + 1], positions[$0 + 2])
            }
        )

        if let normals = buffers.normals, normals.count == positions.count {
            descriptor.normals = MeshBuffers.Normals(
                stride(from: 0, to: normals.count, by: 3).map {
                    SIMD3<Float>(normals[$0], normals[$0 + 1], normals[$0 + 2])
                }
            )
        }

        if let uvs = buffers.uvs, uvs.count == vertexCount * 2 {
            descriptor.textureCoordinates = MeshBuffers.TextureCoordinates(
                stride(from: 0, to: uvs.count, by: 2).map {
                    // three.js UV origin is bottom left, RealityKit's is top left.
                    SIMD2<Float>(uvs[$0], 1 - uvs[$0 + 1])
                }
            )
        }

        if let indices = buffers.indices, !indices.isEmpty {
            descriptor.primitives = .triangles(indices)
        } else {
            descriptor.primitives = .triangles(Array(0..<UInt32(vertexCount)))
        }

        if buffers.normals == nil || buffers.normals?.count != positions.count {
            descriptor.normals = MeshBuffers.Normals(
                computedNormals(positions: descriptor.positions.elements, descriptor: descriptor)
            )
        }

        if let groups, case .triangles(let indices)? = descriptor.primitives,
           let faces = perFaceMaterials(groups: groups, triangleCount: indices.count / 3) {
            descriptor.materials = .perFace(faces)
        }

        return try? MeshResource.generate(from: [descriptor])
    }

    private static func computedNormals(
        positions: [SIMD3<Float>],
        descriptor: MeshDescriptor
    ) -> [SIMD3<Float>] {
        var normals = [SIMD3<Float>](repeating: .zero, count: positions.count)
        guard case .triangles(let indices)? = descriptor.primitives else { return normals }
        var index = 0
        while index + 2 < indices.count {
            let a = Int(indices[index])
            let b = Int(indices[index + 1])
            let c = Int(indices[index + 2])
            index += 3
            guard a < positions.count, b < positions.count, c < positions.count else { continue }
            let face = cross(positions[b] - positions[a], positions[c] - positions[a])
            normals[a] += face
            normals[b] += face
            normals[c] += face
        }
        return normals.map { simd_length($0) > 1e-8 ? simd_normalize($0) : SIMD3<Float>(0, 1, 0) }
    }

    static func bounds(of positions: [Float]) -> BoundingBox? {
        guard positions.count >= 3, positions.count % 3 == 0 else { return nil }
        var minimum = SIMD3<Float>(repeating: .greatestFiniteMagnitude)
        var maximum = SIMD3<Float>(repeating: -.greatestFiniteMagnitude)
        for index in stride(from: 0, to: positions.count, by: 3) {
            let point = SIMD3(positions[index], positions[index + 1], positions[index + 2])
            minimum = simd_min(minimum, point)
            maximum = simd_max(maximum, point)
        }
        return BoundingBox(min: minimum, max: maximum)
    }

    /// Names the parameter that makes a primitive partial, or nil when the
    /// native generator draws exactly what the parameters ask for.
    static func partialReason(type: String, parameters: [String: Any]) -> String? {
        let full = Float.pi * 2
        func value(_ key: String, _ fallback: Float) -> Float { number(parameters, key, fallback) }
        func isSet(_ key: String) -> Bool { parameters[key] != nil }

        switch type {
        case "SphereGeometry":
            if isSet("phiStart"), abs(value("phiStart", 0)) > 1e-4 { return "a phiStart" }
            if isSet("phiLength"), abs(value("phiLength", full) - full) > 1e-4 { return "a partial phiLength" }
            if isSet("thetaStart"), abs(value("thetaStart", 0)) > 1e-4 { return "a thetaStart" }
            if isSet("thetaLength"), abs(value("thetaLength", .pi) - .pi) > 1e-4 { return "a partial thetaLength" }
            return nil
        case "ConeGeometry", "CylinderGeometry":
            if parameters["openEnded"] as? Bool == true { return "openEnded" }
            if isSet("thetaStart"), abs(value("thetaStart", 0)) > 1e-4 { return "a thetaStart" }
            if isSet("thetaLength"), abs(value("thetaLength", full) - full) > 1e-4 { return "a partial thetaLength" }
            return nil
        default:
            return nil
        }
    }

    private static func number(_ parameters: [String: Any], _ key: String, _ fallback: Float) -> Float {
        if let value = parameters[key] as? Double { return Float(value) }
        if let value = parameters[key] as? NSNumber { return value.floatValue }
        return fallback
    }
}

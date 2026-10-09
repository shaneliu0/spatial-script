//
//  ScriptingCommandApplier+ShaderGraph.swift
//  RealityKitScripting
//
//  Created by Shane Liu on 9/9/26.
//

import CoreGraphics
import Foundation
import RealityKit

extension ScriptingCommandApplier {
    // MARK: - Multiple materials (SPEC 14.12)

    /// One material per mesh part, in the order the geometry's groups define.
    /// RealityKit takes them as `ModelComponent.materials`; a mesh with fewer
    /// parts than materials simply uses the leading ones.
    func applyMaterialArray(id: Int, payloads: [[String: Any]]) {
        guard let record = records[id], let model = record.entity as? ModelEntity else { return }
        guard !payloads.isEmpty else { return }

        var specs: [ScriptingMaterialSpec] = []
        var materials: [any RealityKit.Material] = []
        for payload in payloads {
            if payload["type"] as? String == "ShaderGraphMaterial" {
                // A shader graph inside an array is loaded on its own and its
                // fallback fills the slot until it arrives.
                let fallback = (payload["fallback"] as? [String: Any]).map(ScriptingMaterialSpec.init)
                    ?? ScriptingMaterialSpec(payload: [:])
                specs.append(fallback)
                materials.append(nativeMaterial(for: fallback))
                warnings.warnOnce(
                    "A ShaderGraphMaterial inside a material array uses its fallback: "
                        + "per-part shader graph loading is not wired to array slots.",
                    key: "shader-graph-array"
                )
                continue
            }
            warnUnknownKeys(payload, expected: Self.materialKeys, opcode: "material")
            let spec = ScriptingMaterialSpec(payload: payload)
            specs.append(spec)
            materials.append(nativeMaterial(for: spec))
        }

        record.materialSpecs = specs
        record.materialSpec = specs.first
        record.nativeMaterial = materials.first
        for spec in specs { indexMaterial(spec, for: id) }

        // SPEC 14.12: now that the mesh really has a material per part, build
        // the split version of it. It is cached by its groups, so every object
        // with the same geometry and the same split shares one resource.
        if specs.count > 1, let pending = pendingGroupedGeometry[id], record.geometryGroups == nil {
            let key = pending.key.map {
                $0 + "|groups=" + ScriptingGeometryFactory.groupSignature(pending.groups)
            }
            if let split = resources.mesh(forKey: key, build: {
                ScriptingGeometryFactory.meshFromBuffers(pending.buffers, groups: pending.groups)
            }) {
                record.mesh = split
                record.geometryGroups = ScriptingGeometryFactory.partCount(pending.groups)
                refreshCollisionShape(record)
            }
        }

        // One material per mesh part: a grouped mesh has as many parts as it
        // has groups, and a short array repeats its last entry rather than
        // leaving a part undrawn.
        var slots = materials
        if let parts = model.model?.mesh.expectedMaterialCount ?? record.mesh?.expectedMaterialCount,
           parts > slots.count, let last = slots.last {
            slots.append(contentsOf: Array(repeating: last, count: parts - slots.count))
        }
        if var component = model.model {
            component.materials = slots
            model.model = component
        } else if let mesh = record.mesh {
            model.model = ModelComponent(mesh: mesh, materials: slots)
        }

        let parts = model.model?.mesh.expectedMaterialCount ?? materials.count
        if parts < materials.count {
            warnings.warnOnce(
                "This mesh has \(parts) part(s) but \(materials.count) materials were given; "
                    + "the extra materials are kept in the dump and not drawn. A mesh draws one "
                    + "material per geometry.groups entry, so a mesh with no groups draws only "
                    + "the first.",
                key: "material-array-count"
            )
        }
    }

    func nativeMaterial(for spec: ScriptingMaterialSpec) -> any RealityKit.Material {
        resources.material(forKey: spec.cacheKey(textures: textures)) {
            ScriptingMaterialFactory.material(
                for: spec,
                textures: self.textures,
                warnings: self.warnings
            )
        }
    }

    // MARK: - Shader graph materials (SPEC 14.6)

    /// Loads `{ source, name, parameters, fallback }` from a bundled USD file.
    /// The fallback draws until the load resolves, and stays if it fails.
    func applyShaderGraphMaterial(id: Int, payload: [String: Any]) {
        guard let record = records[id] else { return }
        let state = record.extras?.shaderGraph ?? {
            let created = ScriptingShaderGraphState()
            record.makeExtras().shaderGraph = created
            return created
        }()

        let source = payload["source"] as? String ?? ""
        let name = payload["name"] as? String ?? ""
        if let parameters = payload["parameters"] as? [String: Any] {
            for (key, value) in parameters { state.parameters[key] = value }
        }

        // The fallback is what SPEC 14.6 requires and what draws meanwhile.
        let fallbackSpec = (payload["fallback"] as? [String: Any]).map(ScriptingMaterialSpec.init)
            ?? ScriptingMaterialSpec(payload: [:])
        record.materialSpec = fallbackSpec
        indexMaterial(fallbackSpec, for: id)
        if !state.loaded {
            applyNativeMaterial(nativeMaterial(for: fallbackSpec), to: record)
        }

        guard source != state.source || name != state.name || (!state.loaded && state.loadError == nil) else {
            reapplyShaderParameters(record: record, state: state)
            return
        }
        state.source = source
        state.name = name
        state.loaded = false
        state.loadError = nil
        state.loadToken += 1
        let token = state.loadToken
        let generation = loadGeneration

        guard !source.isEmpty, !name.isEmpty else {
            failShaderGraph(
                record: record,
                state: state,
                message: "ShaderGraphMaterial needs both a source file and a material name."
            )
            return
        }
        guard let resolved = ScriptingResourceURL.resolve(source, assetRoot: assetRoot),
              let file = resolved.localFile(extensions: ["usda", "usdc", "usdz", "reality"], assetRoot: assetRoot)
        else {
            failShaderGraph(
                record: record,
                state: state,
                message: "ShaderGraphMaterial source '\(source)' could not be resolved to a bundled USD file."
            )
            return
        }

        Task { [weak self] in
            var material: ShaderGraphMaterial?
            var failure: (any Error)?
            // RealityKit wants the material's prim path. A script names the
            // material, so the bare name is tried first and then the usual
            // places a Reality Composer Pro file puts it.
            for candidate in Self.materialPaths(for: name) {
                do {
                    material = try await ShaderGraphMaterial(named: candidate, from: file)
                    break
                } catch {
                    failure = error
                }
            }
            guard let self, self.loadGeneration == generation, !self.isDisposed,
                  state.loadToken == token else { return }
            guard let material else {
                self.failShaderGraph(
                    record: record,
                    state: state,
                    message: "ShaderGraphMaterial '\(name)' could not be loaded from '\(source)': "
                        + (failure?.localizedDescription ?? "no material of that name")
                )
                return
            }
            state.loaded = true
            var loaded = material
            self.write(parameters: state.parameters, into: &loaded, id: id)
            self.applyNativeMaterial(loaded, to: record)
            self.dispatch?("loaded", id, ["material": name])
        }
    }

    /// Names to try for a material, in order. A path is used as given.
    static func materialPaths(for name: String) -> [String] {
        guard !name.hasPrefix("/") else { return [name] }
        return [name, "/Root/\(name)", "/\(name)", "/Root/Materials/\(name)"]
    }

    /// SPEC 14.13 `shaderParameter`.
    func applyShaderParameter(id: Int, name: String, value: Any?) {
        guard let record = records[id] else { return }
        let state = record.extras?.shaderGraph ?? {
            let created = ScriptingShaderGraphState()
            record.makeExtras().shaderGraph = created
            return created
        }()
        state.parameters[name] = value ?? NSNull()
        state.generation += 1

        guard state.loaded, var material = record.nativeMaterial as? ShaderGraphMaterial else {
            // Before the graph arrives the value is remembered and written in
            // one pass when it does.
            return
        }
        write(parameters: [name: value ?? NSNull()], into: &material, id: id)
        applyNativeMaterial(material, to: record)
    }

    private func reapplyShaderParameters(
        record: ScriptingCommandApplier.Record,
        state: ScriptingShaderGraphState
    ) {
        guard state.loaded, var material = record.nativeMaterial as? ShaderGraphMaterial else { return }
        write(parameters: state.parameters, into: &material, id: record.id)
        applyNativeMaterial(material, to: record)
    }

    private func write(parameters: [String: Any], into material: inout ShaderGraphMaterial, id: Int) {
        let names = Set(material.parameterNames)
        for (name, value) in parameters {
            guard names.contains(name) else {
                warnings.warnOnce(
                    "shader parameter '\(name)' is not on this material and was ignored.",
                    key: "shader-parameter-\(name)"
                )
                continue
            }
            guard let converted = Self.materialParameter(
                value,
                named: name,
                on: material,
                textures: textures
            ) else {
                let isTexture: Bool
                if case .textureResource? = material.getParameter(name: name) { isTexture = true }
                else { isTexture = false }
                warnings.warnOnce(
                    isTexture
                        ? "shader parameter '\(name)' is a texture and the id it was given has not "
                            + "finished loading, so the graph keeps its own."
                        : "shader parameter '\(name)' has a value RealityKit cannot take and was ignored.",
                    key: "shader-parameter-value-\(name)"
                )
                continue
            }
            do {
                try material.setParameter(name: name, value: converted)
            } catch {
                warnings.warnOnce(
                    "shader parameter '\(name)' was refused: \(error.localizedDescription)",
                    key: "shader-parameter-refused-\(name)"
                )
            }
        }
    }

    /// Numbers, vectors, colours and textures, per SPEC 14.6.
    ///
    /// The core sends a texture as a bare id, so the graph's own declared type
    /// decides what a lone number means: a number for a texture parameter is a
    /// texture id, a number anywhere else is a float.
    static func materialParameter(
        _ value: Any?,
        named name: String,
        on material: ShaderGraphMaterial?,
        textures: ScriptingTextureStore
    ) -> MaterialParameters.Value? {
        // `NSNumber(1) as? Bool` is true, so booleans are told apart by their
        // CoreFoundation type rather than by a cast that numbers also pass.
        if let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() {
            return .bool(number.boolValue)
        }
        // No `value as? Bool` fallback: an `NSNumber(1)` passes that cast, which
        // is how a numeric 1 became `true` on the declaration path.
        if let number = number(value) {
            if case .textureResource? = material?.getParameter(name: name) {
                guard let resource = textures.resource(for: Int(number)) else { return nil }
                return .textureResource(resource)
            }
            return .float(Float(number))
        }
        // The wrapped form is still accepted, for a core that sends one.
        if let id = (value as? [String: Any])?["texture"], let textureID = number(id) {
            guard let resource = textures.resource(for: Int(textureID)) else { return nil }
            return .textureResource(resource)
        }
        // A shader graph has no string parameters; SPEC 14.6's short strings
        // are kept in the dump and reported as refused rather than coerced.
        guard let array = (value as? [Any])?.compactMap({ number($0) }) else { return nil }
        switch array.count {
        case 2: return .simd2Float(SIMD2(Float(array[0]), Float(array[1])))
        case 3: return .simd3Float(SIMD3(Float(array[0]), Float(array[1]), Float(array[2])))
        case 4: return .simd4Float(
            SIMD4(Float(array[0]), Float(array[1]), Float(array[2]), Float(array[3]))
        )
        default: return nil
        }
    }

    private func applyNativeMaterial(
        _ material: any RealityKit.Material,
        to record: ScriptingCommandApplier.Record
    ) {
        record.nativeMaterial = material
        guard let model = record.entity as? ModelEntity else { return }
        if var component = model.model {
            component.materials = [material]
            model.model = component
        } else if let mesh = record.mesh {
            model.model = ModelComponent(mesh: mesh, materials: [material])
        }
    }

    private func failShaderGraph(
        record: ScriptingCommandApplier.Record,
        state: ScriptingShaderGraphState,
        message: String
    ) {
        state.loaded = false
        state.loadError = message
        warnings.warnOnce(message, key: "shader-graph-\(state.source)-\(state.name)")
        emitLog?(.error, message)
        dispatch?("error", record.id, ["message": message])
    }
}

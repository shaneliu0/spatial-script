//
//  ScriptingCommandApplier+ShaderGraph.swift
//  SpatialScriptRuntime
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
        for (index, payload) in payloads.enumerated() {
            if payload["type"] as? String == "ShaderGraphMaterial" {
                // Recorded so the slot dumps as the graph the script gave it.
                let state = record.extras?.shaderGraph ?? {
                    let created = ScriptingShaderGraphState()
                    record.makeExtras().shaderGraph = created
                    return created
                }()
                state.slotGraphs[index] = (
                    source: payload["source"] as? String ?? "",
                    name: payload["name"] as? String ?? ""
                )
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
        bindMaterials(record, keys: specs.compactMap { $0.cacheKey(textures: textures) })
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
                bindMesh(record, key: key)
                record.mesh = split
                record.geometryGroups = ScriptingGeometryFactory.partCount(pending.groups)
                refreshCollisionShape(record)
            }
        }

        // One material per mesh part: a split mesh has as many parts as it has
        // distinct groups, and a short array repeats its last entry rather than
        // leaving a part undrawn. The part count comes from the groups, so a
        // shared mesh is never asked for it once per object.
        var slots = materials
        let parts = record.geometryGroups ?? model.model?.mesh.expectedMaterialCount ?? slots.count
        if parts > slots.count, let last = slots.last {
            slots.append(contentsOf: Array(repeating: last, count: parts - slots.count))
        }
        // The mesh may have just been replaced by its split version, so the
        // component is rebuilt around whichever mesh the record now holds.
        if let mesh = record.mesh {
            model.model = ModelComponent(mesh: mesh, materials: slots)
        } else if var component = model.model {
            component.materials = slots
            model.model = component
        }

        if parts < materials.count {
            warnings.warnOnce(
                "\"\(record.entity.name)\" carries \(materials.count) materials but its geometry "
                    + "groups ask for \(parts); the extras are not drawn.",
                key: "material-array-count-\(record.entity.name)"
            )
        }
        // The dump reports the slots that are actually drawn: one per part,
        // with a short array's last entry repeated, and no extras.
        record.drawnMaterialCount = model.model?.materials.count ?? slots.count
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
        guard let resolved = ScriptingResourceURL.resolve(source, assetDirectory: assetDirectory),
              let file = resolved.localFile(extensions: ["usda", "usdc", "usdz", "reality"], assetDirectory: assetDirectory)
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
    func applyShaderParameter(id: Int, name: String, value: Any?, materialIndex: Int = 0) {
        guard let record = records[id] else { return }
        let state = record.extras?.shaderGraph ?? {
            let created = ScriptingShaderGraphState()
            record.makeExtras().shaderGraph = created
            return created
        }()
        state.parametersBySlot[materialIndex, default: [:]][name] = value ?? NSNull()
        state.generation += 1

        // A mesh with a material per part has one graph per slot, so the write
        // goes to the slot the command names.
        if materialIndex > 0 {
            guard let model = record.entity as? ModelEntity,
                  var materials = model.model?.materials,
                  materials.indices.contains(materialIndex) else {
                warnings.warnOnce(
                    "shader parameter '\(name)' names material slot \(materialIndex), "
                        + "which \"\(record.entity.name)\" does not draw.",
                    key: "shader-parameter-slot-missing-\(id)-\(materialIndex)"
                )
                return
            }
            guard var slot = materials[materialIndex] as? ShaderGraphMaterial else {
                // SPEC 12: nothing silently no-ops. A shader graph inside a
                // material array is drawn by its fallback (the array path warns
                // about that), so the value is recorded for the dump and the
                // slot is named rather than the write vanishing.
                warnings.warnOnce(
                    "shader parameter '\(name)' was recorded for material slot \(materialIndex) "
                        + "but that slot draws its fallback, not a shader graph.",
                    key: "shader-parameter-fallback-slot-\(id)-\(materialIndex)"
                )
                return
            }
            write(parameters: [name: value ?? NSNull()], into: &slot, id: id)
            materials[materialIndex] = slot
            model.model?.materials = materials
            return
        }
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
        // SPEC 3.5: the failure is reported through the event and the warning,
        // never as a console line this consumer writes itself.
        dispatch?("error", record.id, ["message": message])
    }
}

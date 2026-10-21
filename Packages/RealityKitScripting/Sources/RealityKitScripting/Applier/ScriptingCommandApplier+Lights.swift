//
//  ScriptingCommandApplier+Lights.swift
//  RealityKitScripting
//
//  Created by Shane Liu on 9/9/26.
//

import CoreGraphics
import Foundation
import ImageIO
import RealityKit

extension ScriptingCommandApplier {
    func applyLight(id: Int, payload: [String: Any]) {
        guard let record = records[id] else { return }
        record.lightSpec = payload
        let type = payload["type"] as? String ?? ""
        let color = vector3(payload["color"]) ?? SIMD3(1, 1, 1)
        let intensity = float(payload["intensity"]) ?? 1
        let distance = float(payload["distance"]) ?? 0
        let decay = float(payload["decay"]) ?? 2
        let angle = float(payload["angle"]) ?? .pi / 3
        let penumbra = float(payload["penumbra"]) ?? 0
        let castShadow = payload["castShadow"] as? Bool ?? false
        // A light's shadow is a component on its holder, so the dump reads the
        // applied flag rather than the mesh-side component (SPEC 8).
        record.castShadow = castShadow
        let direction = vector3(payload["direction"])

        let holder = lightHolder(for: record)
        holder.components.remove(DirectionalLightComponent.self)
        holder.components.remove(PointLightComponent.self)
        holder.components.remove(SpotLightComponent.self)
        holder.components.remove(DirectionalLightComponent.Shadow.self)
        holder.components.remove(SpotLightComponent.Shadow.self)

        switch type {
        case "directional":
            clearAmbientLight(for: record)
#if os(visionOS)
            var component = DirectionalLightComponent(
                color: ScriptingColor.platformColor(linear: color),
                intensity: intensity * 1000
            )
#else
            var component = DirectionalLightComponent(
                color: ScriptingColor.platformColor(linear: color),
                intensity: intensity * 1000,
                isRealWorldProxy: false
            )
#endif
            component.intensity = intensity * 1000
            holder.components.set(component)
            if castShadow {
                holder.components.set(DirectionalLightComponent.Shadow())
            }
            record.pendingLightDirection = direction

        case "point":
            clearAmbientLight(for: record)
            var component = PointLightComponent(
                color: ScriptingColor.platformColor(linear: color),
                intensity: intensity * 4 * .pi,
                attenuationRadius: distance > 0 ? distance : 100
            )
            component.attenuationFalloffExponent = decay
            holder.components.set(component)

        case "spot":
            clearAmbientLight(for: record)
            let outer = min(179, max(1, angle * 180 / .pi))
            var component = SpotLightComponent(
                color: ScriptingColor.platformColor(linear: color),
                intensity: intensity * 4 * .pi,
                innerAngleInDegrees: outer * (1 - min(1, max(0, penumbra))),
                outerAngleInDegrees: outer,
                attenuationRadius: distance > 0 ? distance : 100
            )
            component.attenuationFalloffExponent = decay
            holder.components.set(component)
            if castShadow {
                holder.components.set(SpotLightComponent.Shadow())
            }
            record.pendingLightDirection = direction

        case "ambient":
            record.isAmbientSource = true
            applyAmbientLight(color: color, intensity: intensity)

        default:
            warnings.warnOnce(
                "Light type '\(type)' is unsupported in RealityKit",
                key: "light-type-\(type)"
            )
        }
    }

    /// Drops the ambient environment a light previously installed, when the
    /// light changes type or goes away.
    func clearAmbientLight(for record: Record) {
        guard record.isAmbientSource else { return }
        record.isAmbientSource = false
        ambientLight = nil
        refreshImageBasedLight()
    }

    private func lightHolder(for record: Record) -> Entity {
        if let holder = record.lightHolder { return holder }
        let holder = Entity()
        holder.name = "\(record.entity.name).light"
        record.entity.addChild(holder)
        record.lightHolder = holder
        return holder
    }

    /// Ambient light becomes an image based light over a uniform environment.
    /// An explicit `Spatial.environment` outranks it; removing that environment
    /// restores the ambient one.
    func applyAmbientLight(color: SIMD3<Float>, intensity: Float) {
        guard let image = Self.uniformEquirectangularImage(color: color) else {
            warnings.warnOnce(
                "AmbientLight could not be converted to an image based light and was skipped",
                key: "ambient-ibl"
            )
            return
        }
        do {
            ambientLight = (try EnvironmentResource(equirectangular: image), intensity)
            refreshImageBasedLight()
        } catch {
            warnings.warnOnce(
                "AmbientLight could not be converted to an image based light and was skipped",
                key: "ambient-ibl"
            )
        }
    }

    /// Installs whichever image based light is in force, explicit first.
    func refreshImageBasedLight() {
        guard let source = explicitEnvironment ?? ambientLight else {
            // The holder leaves the tree with the light, or dispose would find
            // nothing to detach and leave it on the shared root.
            currentEnvironmentEntity?.components.remove(ImageBasedLightComponent.self)
            currentEnvironmentEntity?.removeFromParent()
            setEnvironmentEntity(nil)
            return
        }
        if explicitEnvironment != nil, ambientLight != nil {
            warnings.warnOnce(
                "Spatial.environment replaces the AmbientLight image based light; "
                + "the AmbientLight intensity is ignored while an environment is set",
                key: "ambient-vs-environment"
            )
        }
        let holder = currentEnvironmentEntity ?? {
            let entity = Entity()
            entity.name = "spatial.environment"
            root.addChild(entity)
            return entity
        }()
        holder.components.set(
            ImageBasedLightComponent(
                source: .single(source.resource),
                // SPEC 14.13's `environmentIntensityExponent` is 1 at rest (the
                // core's default and RealityKit's), so it shifts the exponent
                // by its distance from 1 rather than by its value.
                intensityExponent: source.intensity + environmentIntensityExponent - 1
            )
        )
        setEnvironmentEntity(holder)
    }

    func applyEnvironment(payload: [String: Any]?) {
        guard let payload, let url = payload["url"] as? String else {
            explicitEnvironment = nil
            environmentURL = nil
            environmentIntensity = 1
            refreshImageBasedLight()
            return
        }
        let intensity = float(payload["intensity"]) ?? 1
        // Recorded before the load, so the dump reports the environment the
        // script set even while the resource is still resolving or has failed.
        environmentURL = url
        environmentIntensity = intensity
        let generation = loadGeneration
        let loadToken = beginLoad(url)
        Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                let resource = try await Self.environmentResource(for: url)
                endLoad(loadToken)
                guard isCurrent(generation) else { return }
                explicitEnvironment = (resource, intensity)
                environmentURL = url
                refreshImageBasedLight()
            } catch {
                // SPEC 3.5: the core warns once, backend-neutrally, for a load
                // failure; a consumer that warned as well put the same failure
                // in the dump twice and only on one backend.
                endLoad(loadToken)
            }
        }
    }

    private static func environmentResource(fromImageAt file: URL) async throws -> EnvironmentResource {
        let data = try Data(contentsOf: file)
        guard
            let source = CGImageSourceCreateWithData(data as CFData, nil),
            let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
        else { throw CocoaError(.fileReadCorruptFile) }
        return try await EnvironmentResource(equirectangular: image)
    }

    private static func environmentResource(for url: String) async throws -> EnvironmentResource {
        // SPEC 3.5: `asset://` names a file in the app's bundled asset root,
        // which both targets ship as a folder reference, so a bundle-name-only
        // lookup would miss it.
        // `EnvironmentResource` reads an equirectangular image, so every source
        // ends up as image data. Resolving through the one URL resolver is what
        // makes `asset://` find the folder both app targets bundle.
        let form = ScriptingResourceURL.resolve(url, assetDirectory: nil)
        if let file = form?.localFile(extensions: ["hdr", "exr", "png", "jpg", "jpeg", "heic"]) {
            return try await environmentResource(fromImageAt: file)
        }
        guard let resolved = form?.remoteURL else {
            throw CocoaError(.fileNoSuchFile)
        }
        let data = try await withCheckedThrowingContinuation { continuation in
            URLSession.shared.dataTask(with: resolved) { data, _, error in
                if let data { continuation.resume(returning: data) }
                else { continuation.resume(throwing: error ?? CocoaError(.fileReadUnknown)) }
            }.resume()
        }
        guard
            let source = CGImageSourceCreateWithData(data as CFData, nil),
            let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
        else {
            throw CocoaError(.fileReadCorruptFile)
        }
        return try await EnvironmentResource(equirectangular: image)
    }

    static func uniformEquirectangularImage(color: SIMD3<Float>) -> CGImage? {
        let width = 64
        let height = 32
        let componentsCount = 4
        var pixels = [UInt8](repeating: 255, count: width * height * componentsCount)
        let red = UInt8(clamping: Int(ScriptingColor.encode(color.x) * 255))
        let green = UInt8(clamping: Int(ScriptingColor.encode(color.y) * 255))
        let blue = UInt8(clamping: Int(ScriptingColor.encode(color.z) * 255))
        for index in stride(from: 0, to: pixels.count, by: componentsCount) {
            pixels[index] = red
            pixels[index + 1] = green
            pixels[index + 2] = blue
            pixels[index + 3] = 255
        }
        guard
            let space = CGColorSpace(name: CGColorSpace.sRGB),
            let provider = CGDataProvider(data: Data(pixels) as CFData)
        else { return nil }
        return CGImage(
            width: width,
            height: height,
            bitsPerComponent: 8,
            bitsPerPixel: 8 * componentsCount,
            bytesPerRow: width * componentsCount,
            space: space,
            bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue),
            provider: provider,
            decode: nil,
            shouldInterpolate: false,
            intent: .defaultIntent
        )
    }

    func float(_ value: Any?) -> Float? { (value as? NSNumber)?.floatValue }
    func intValue(_ value: Any?) -> Int? { (value as? NSNumber)?.intValue }

    func vector3(_ value: Any?) -> SIMD3<Float>? {
        guard let array = value as? [Any], array.count >= 3 else { return nil }
        return SIMD3(
            (array[0] as? NSNumber)?.floatValue ?? 0,
            (array[1] as? NSNumber)?.floatValue ?? 0,
            (array[2] as? NSNumber)?.floatValue ?? 0
        )
    }
}

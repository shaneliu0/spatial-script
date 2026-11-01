//
//  ScriptingCommandApplier+Scene.swift
//  RealityKitScripting
//
//  Created by Shane Liu on 9/9/26.
//

import Foundation
import RealityKit

extension ScriptingCommandApplier {
    // MARK: - Particles

    func applyParticles(id: Int, payload: [String: Any]) {
        guard let record = records[id] else { return }
        var component: ParticleEmitterComponent

        if let preset = payload["preset"] as? String {
            switch preset {
            case "fireworks": component = ParticleEmitterComponent.Presets.fireworks
            case "impact": component = ParticleEmitterComponent.Presets.impact
            case "magic": component = ParticleEmitterComponent.Presets.magic
            case "rain": component = ParticleEmitterComponent.Presets.rain
            case "snow": component = ParticleEmitterComponent.Presets.snow
            case "sparks": component = ParticleEmitterComponent.Presets.sparks
            case "smoke": component = Self.smokePreset()
            default:
                warnings.warnOnce(
                    "ParticleEmitter preset '\(preset)' has no RealityKit equivalent; "
                    + "the emitter falls back to its explicit fields",
                    key: "particles-preset-\(preset)"
                )
                component = configuredEmitter(payload: payload)
            }
            component.isEmitting = payload["isEmitting"] as? Bool ?? true
        } else {
            component = configuredEmitter(payload: payload)
        }

        // SPEC 3.10: a preset overrides every other field except isEmitting, and
        // `loops` is one of those fields. A preset loops; only an emitter built
        // from its own fields honours `loops: false`, which stops it after one
        // lifetime.
        let usedPreset = payload["preset"] as? String != nil
        record.entity.components.set(component)
        record.particleLifetime = usedPreset ? 0 : Double(float(payload["lifetime"]) ?? 1)
        record.particleSpec = payload
        record.particlesLoop = usedPreset ? true : (payload["loops"] as? Bool ?? true)
        record.particlesElapsed = 0
    }

    /// RealityKit has no smoke preset, so this is the hand tuned equivalent of
    /// the web consumer's: a slow, wide, fading grey plume.
    private static func smokePreset() -> ParticleEmitterComponent {
        var component = ParticleEmitterComponent()
        component.emitterShape = .sphere
        component.emitterShapeSize = SIMD3(repeating: 0.02)
        component.speed = 0.12
        component.speedVariation = 0.05
        component.birthDirection = .local
        component.emissionDirection = SIMD3(0, 1, 0)

        var emitter = component.mainEmitter
        emitter.birthRate = 60
        emitter.birthRateVariation = 10
        emitter.lifeSpan = 3
        emitter.lifeSpanVariation = 1
        emitter.size = 0.05
        emitter.sizeVariation = 0.02
        emitter.sizeMultiplierAtEndOfLifespan = 3.5
        emitter.spreadingAngle = 0.35
        emitter.acceleration = SIMD3(0, 0.05, 0)
        emitter.dampingFactor = 2
        emitter.opacityCurve = .gradualFadeInOut
        emitter.angleVariation = .pi
        emitter.angularSpeedVariation = 0.4
        emitter.color = .evolving(
            start: .single(ScriptingColor.platformColor(linear: SIMD3(0.32, 0.32, 0.34), alpha: 0.5)),
            end: .single(ScriptingColor.platformColor(linear: SIMD3(0.5, 0.5, 0.52), alpha: 0))
        )
        emitter.blendMode = .alpha
        emitter.sortOrder = .decreasingAge
        component.mainEmitter = emitter
        return component
    }

    /// Drives `loops: false`: the emitter is switched off once one lifetime of
    /// particles has been born.
    func advanceParticleLifetimes(deltaTime: TimeInterval) {
        for record in records.values
        where record.kind == .particles && !record.particlesLoop && record.particleLifetime > 0 {
            guard var component = record.entity.components[ParticleEmitterComponent.self],
                  component.isEmitting else { continue }
            record.particlesElapsed += deltaTime
            if record.particlesElapsed >= record.particleLifetime {
                component.isEmitting = false
                record.entity.components.set(component)
            }
        }
    }

    private func configuredEmitter(payload: [String: Any]) -> ParticleEmitterComponent {
        var component = ParticleEmitterComponent()
        component.emitterShape = switch payload["shape"] as? String {
        case "sphere": .sphere
        case "box": .box
        case "cone": .cone
        case "plane": .plane
        default: .point
        }
        if let size = vector3(payload["shapeSize"]) {
            component.emitterShapeSize = size
        }
        component.speed = float(payload["speed"]) ?? 1
        component.speedVariation = float(payload["speedVariation"]) ?? 0
        // SPEC 3.10: `spreadAngle` is the cone half-angle about the emitter's
        // +Y for every shape. RealityKit otherwise lets a cone emitter shape
        // spray far wider than the angle asks for, so the birth direction is
        // pinned to local +Y and the shape only distributes birth positions.
        component.birthDirection = .local
        component.emissionDirection = SIMD3(0, 1, 0)
        component.isEmitting = payload["isEmitting"] as? Bool ?? true
        component.burstCount = intValue(payload["burstCount"]) ?? 0

        var emitter = component.mainEmitter
        emitter.birthRate = float(payload["birthRate"]) ?? 100
        emitter.lifeSpan = Double(float(payload["lifetime"]) ?? 1)
        emitter.lifeSpanVariation = Double(float(payload["lifetimeVariation"]) ?? 0)
        emitter.size = float(payload["size"]) ?? 0.01
        emitter.sizeVariation = float(payload["sizeVariation"]) ?? 0
        emitter.spreadingAngle = float(payload["spreadAngle"]) ?? 0
        emitter.acceleration = vector3(payload["acceleration"]) ?? SIMD3(0, -1, 0)

        let start = vector3(payload["color"]) ?? SIMD3(1, 1, 1)
        let opacity = Double(float(payload["opacity"]) ?? 1)
        if let end = vector3(payload["colorEnd"]) {
            emitter.color = .evolving(
                start: .single(ScriptingColor.platformColor(linear: start, alpha: opacity)),
                end: .single(ScriptingColor.platformColor(linear: end, alpha: opacity))
            )
        } else {
            emitter.color = .constant(
                .single(ScriptingColor.platformColor(linear: start, alpha: opacity))
            )
        }
        let opacityEnd = float(payload["opacityEnd"]) ?? 0
        emitter.opacityCurve = opacityEnd < Float(opacity) ? .linearFadeOut : .constant

        if let textureID = intValue(payload["texture"]), let resource = textures.resource(for: textureID) {
            emitter.image = resource
        }
        component.mainEmitter = emitter
        return component
    }

    func burstParticles(id: Int) {
        guard let record = records[id],
              var component = record.entity.components[ParticleEmitterComponent.self] else { return }
        component.burst()
        record.entity.components.set(component)
    }

    // MARK: - Anchors

    func applyAnchor(id: Int, payload: [String: Any]?, name: String?) {
        guard let record = records[id], let anchor = record.entity as? AnchorEntity else { return }
        record.anchorSpec = payload ?? ["kind": name ?? "head"]
        let target = anchoringTarget(payload: payload, name: name)
        anchor.components.set(AnchoringComponent(target))
    }

    private func anchoringTarget(payload: [String: Any]?, name: String?) -> AnchoringComponent.Target {
        let kind = (payload?["kind"] as? String) ?? name ?? "head"

        switch kind {
        case "head":
#if os(visionOS)
            return .head
#else
            warnings.warnOnce(
                "Head anchors are visionOS only; the anchor stays at the world origin on macOS",
                key: "anchor-head-macos"
            )
            return .world(transform: matrix_identity_float4x4)
#endif

        case "hand":
#if os(visionOS)
            let chirality: AnchoringComponent.Target.Chirality =
                (payload?["hand"] as? String) == "left" ? .left : .right
            let location: AnchoringComponent.Target.HandLocation = switch payload?["location"] as? String {
            case "wrist": .wrist
            case "indexFingerTip": .indexFingerTip
            case "thumbTip": .thumbTip
            case "aboveHand": .aboveHand
            default: .palm
            }
            return .hand(chirality, location: location)
#else
            warnings.warnOnce(
                "Hand anchors are visionOS only; the anchor stays at the world origin on macOS",
                key: "anchor-hand-macos"
            )
            return .world(transform: matrix_identity_float4x4)
#endif

        case "plane":
            let alignment: AnchoringComponent.Target.Alignment = switch payload?["plane"] as? String {
            case "horizontal": .horizontal
            case "vertical": .vertical
            default: .any
            }
            var bounds = SIMD2<Float>(0.2, 0.2)
            if let minimum = payload?["minimumBounds"] as? [Any], minimum.count >= 2 {
                bounds = SIMD2(
                    (minimum[0] as? NSNumber)?.floatValue ?? 0.2,
                    (minimum[1] as? NSNumber)?.floatValue ?? 0.2
                )
            }
#if !os(visionOS)
            warnings.warnOnce(
                "Plane anchors never resolve on macOS; the anchor stays at the world origin",
                key: "anchor-plane-macos"
            )
#endif
            return .plane(alignment, classification: .any, minimumBounds: bounds)

        case "image":
            return .image(group: "AR Resources", name: payload?["image"] as? String ?? "")

        case "world":
            guard let elements = payload?["matrix"] as? [Any], elements.count >= 16 else {
                return .world(transform: matrix_identity_float4x4)
            }
            // three.js Matrix4.elements is column major, matching float4x4.
            let values = elements.map { ($0 as? NSNumber)?.floatValue ?? 0 }
            return .world(transform: float4x4(
                SIMD4(values[0], values[1], values[2], values[3]),
                SIMD4(values[4], values[5], values[6], values[7]),
                SIMD4(values[8], values[9], values[10], values[11]),
                SIMD4(values[12], values[13], values[14], values[15])
            ))

        default:
            warnings.warnOnce(
                "Anchor kind '\(kind)' is unsupported in RealityKit",
                key: "anchor-kind-\(kind)"
            )
            return .world(transform: matrix_identity_float4x4)
        }
    }

    // MARK: - Portals

    func applyWorld(id: Int, enabled: Bool) {
        guard let record = records[id] else { return }
        if enabled {
            worldGroups.insert(id)
            record.entity.components.set(WorldComponent())
        } else {
            worldGroups.remove(id)
            record.entity.components.remove(WorldComponent.self)
        }
    }

    func applyPortal(id: Int, payload: [String: Any]) {
        guard let record = records[id], let model = record.entity as? ModelEntity else { return }
        let worldID = intValue(payload["worldId"]) ?? -1
        let width = float(payload["width"]) ?? 0.5
        let height = float(payload["height"]) ?? 0.5
        let crossing = payload["crossing"] as? Bool ?? false
        record.portalSpec = payload
        guard let world = records[worldID]?.entity else {
            warnings.warnOnce(
                "Portal world group is missing; the portal was skipped",
                key: "portal-world-missing"
            )
            return
        }
        let mesh = MeshResource.generatePlane(width: width, height: height)
        record.mesh = mesh
        model.model = ModelComponent(mesh: mesh, materials: [PortalMaterial()])
        var component = PortalComponent(target: world)
        component.crossingMode = crossing ? .plane(.positiveZ) : .disabled
        model.components.set(component)
    }

    // MARK: - Assets

    func loadAsset(id: Int, payload: [String: Any]) {
        guard records[id] != nil else { return }
        for value in payload.values {
            if let url = value as? String { assetIDsByURL[url] = id }
        }
        let source = (payload["usdz"] as? String) ?? (payload["reality"] as? String)
        records[id]?.assetSource = source ?? (payload.values.compactMap { $0 as? String }.first)
        records[id]?.assetURLs = payload.filter { $0.value is String }
        guard let source else {
            let message = "loadAsset needs a usdz or reality key for the RealityKit backend"
            warnings.warnOnce(message, key: "asset-no-usdz")
            dispatch?("assetError", id, ["message": message])
            return
        }
        // Loading is asynchronous, so a resolution failure is reported the same
        // way a read failure is: on the next turn, never inline.
        let generation = loadGeneration
        let loadToken = beginLoad(source)
        Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                guard let url = assetURL(for: source) else {
                    throw CocoaError(.fileNoSuchFile)
                }
                let loaded = try await Entity(contentsOf: url)
                // Counted down the moment the read returns, on every path out
                // of this task (SPEC 14.13a).
                endLoad(loadToken)
                // The record is looked up again: the object may have been
                // destroyed, or the whole scene replaced, while this was loading.
                guard isCurrent(generation), let record = records[id] else { return }
                record.assetContainer?.removeFromParent()
                record.assetContainer = loaded
                record.entity.addChild(loaded)
                let bounds = loaded.visualBounds(relativeTo: record.entity)
                // SPEC 14.5: the skeleton and blend shapes the script can
                // address come with the load, so `asset.skeleton` and
                // `asset.blendShapes` are non-null only when they exist.
                let rig = indexSkeleton(for: record)
                dispatch?("assetLoaded", id, [
                    "animations": loaded.availableAnimations.compactMap(\.name),
                    "boundingBox": [
                        bounds.min.x, bounds.min.y, bounds.min.z,
                        bounds.max.x, bounds.max.y, bounds.max.z,
                    ],
                    "joints": rig.joints,
                    "blendShapes": rig.blendShapes,
                ])
            } catch {
                endLoad(loadToken)
                guard isCurrent(generation), records[id] != nil else { return }
                dispatch?("assetError", id, ["message": error.localizedDescription])
            }
        }
    }

    /// SPEC 3.5's url forms, through the one resolver the consumer has, so
    /// `asset://` finds the bundled asset folder both app targets ship.
    private func assetURL(for source: String) -> URL? {
        guard let resolved = ScriptingResourceURL.resolve(source, assetDirectory: assetDirectory) else {
            return nil
        }
        if let file = resolved.localFile(
            extensions: ["usdz", "reality", "usda", "usdc"],
            assetDirectory: assetDirectory
        ) {
            return file
        }
        return resolved.remoteURL
    }

    func playAssetAnimation(id: Int, name: String?, loop: Bool, speed: Float) {
        guard let record = records[id], let container = record.assetContainer else { return }
        guard let name else {
            record.animation?.stop()
            record.animation = nil
            container.stopAllAnimations(recursive: true)
            return
        }
        guard let resource = container.availableAnimations.first(where: { $0.name == name }) else {
            warnings.warnOnce(
                "Asset animation '\(name)' was not found in the loaded asset",
                key: "asset-animation-\(name)"
            )
            return
        }
        let repeated = loop ? resource.repeat() : resource
        let controller = container.playAnimation(repeated, transitionDuration: 0, startsPaused: false)
        controller.speed = speed == 0 ? 1 : speed
        record.animation = controller
    }
}

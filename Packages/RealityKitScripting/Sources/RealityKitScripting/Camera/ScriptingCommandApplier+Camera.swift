//
//  ScriptingCommandApplier+Camera.swift
//  RealityKitScripting
//
//  Created by Shane Liu on 9/9/26.
//

import Foundation
import RealityKit

extension ScriptingCommandApplier {
    /// SPEC 14.3. On macOS the RealityView's virtual camera follows
    /// `Spatial.camera`; on visionOS the user is the camera, so the spec is
    /// kept for the dump and warned about once.
    func applyCamera(id: Int, payload: [String: Any]?) {
        let kind = payload?["kind"] as? String
        guard let payload, kind != nil else {
            // SPEC 14.13: `["camera", 0, { kind: null }]` gives the built-in
            // camera back.
            cameraSpec = nil
            releaseCamera()
            return
        }
        cameraSpec = payload

#if os(visionOS)
        // SPEC 12: the core warns once that the wearer is the camera
        // (`core/src/runtime/phase2.js:49`); the spec stays in the dump.
        return
#else
        // SPEC 14.13: the camera is an object in the graph, so the component
        // goes on that entity and its transform arrives through `transforms`
        // like any other object's.
        let entity: Entity
        if let record = records[id] {
            if let previous = cameraEntity, previous !== record.entity {
                previous.components.remove(PerspectiveCameraComponent.self)
                previous.components.remove(OrthographicCameraComponent.self)
                if cameraRecordID == nil { previous.removeFromParent() }
            }
            entity = record.entity
            cameraRecordID = id
        } else if let existing = cameraEntity, cameraRecordID == nil {
            entity = existing
        } else {
            // A camera the script never added to the scene still has to render
            // from somewhere, so the consumer holds it.
            let created = Entity()
            created.name = "SpatialScript Camera"
            root.addChild(created)
            entity = created
            cameraRecordID = nil
        }
        cameraEntity = entity
        // Exactly one camera renders: the view's own steps aside.
        ScriptingRuntime.defaultCameraEntity?.isEnabled = false

        switch kind {
        case "perspective":
            entity.components.remove(OrthographicCameraComponent.self)
            var component = PerspectiveCameraComponent()
            component.near = Float(Self.number(payload["near"]) ?? 0.01)
            let far = Self.number(payload["far"]) ?? 1000
            component.far = far.isFinite ? Float(far) : .greatestFiniteMagnitude
            component.fieldOfViewInDegrees = Float(Self.number(payload["fov"]) ?? 60)
            entity.components.set(component)

        case "orthographic":
            entity.components.remove(PerspectiveCameraComponent.self)
            var component = OrthographicCameraComponent()
            component.near = Float(Self.number(payload["near"]) ?? 0.01)
            let far = Self.number(payload["far"]) ?? 1000
            component.far = far.isFinite ? Float(far) : .greatestFiniteMagnitude
            // SPEC 14.3: the visible height is top minus bottom and the width
            // follows the viewport, because RealityKit's orthographic camera
            // takes only a height. Nothing is ever stretched to fit.
            let top = Self.number(payload["top"]) ?? 1
            let bottom = Self.number(payload["bottom"]) ?? -1
            let height = abs(top - bottom)
            component.scale = Float(height)
            component.scaleDirection = .vertical
            entity.components.set(component)
            warnIfOrthographicWidthDisagrees(payload: payload, height: height)

        default:
            warnings.warnOnce(
                "camera kind '\(kind ?? "")' is not known and was ignored.",
                key: "camera-kind-\(kind ?? "")"
            )
        }

        // A camera the core sends without a transform still needs one; the
        // object's own `transform` command supplies it for a scripted camera.
        if let transform = payload["transform"] as? [Any], transform.count >= 10 {
            let values = transform.compactMap { Self.number($0) }
            guard values.count >= 10 else { return }
            entity.setTransformMatrix(
                Transform(
                    scale: SIMD3(Float(values[7]), Float(values[8]), Float(values[9])),
                    rotation: simd_quatf(
                        ix: Float(values[3]),
                        iy: Float(values[4]),
                        iz: Float(values[5]),
                        r: Float(values[6])
                    ),
                    translation: SIMD3(Float(values[0]), Float(values[1]), Float(values[2]))
                ).matrix,
                relativeTo: nil
            )
        }
#endif
    }

    /// `left` and `right` are honored when they match the width the viewport
    /// gives that height, and warn once when they do not.
    private func warnIfOrthographicWidthDisagrees(payload: [String: Any], height: Double) {
        guard let left = Self.number(payload["left"]),
              let right = Self.number(payload["right"]) else { return }
        let width = abs(right - left)
        let expected = height * ScriptingRuntime.viewportAspect
        // A couple of percent covers a script that rounded its extents.
        guard abs(width - expected) > max(1e-4, expected * 0.02) else { return }
        // SPEC 14.3 fixes the wording, so both backends warn with one string.
        warnings.warnOnce(
            "OrthographicCamera asks for a visible width of \(Self.formatted(width)) "
                + "but the viewport shows \(Self.formatted(expected)) at that height; "
                + "the height is kept and the width follows the viewport",
            key: "camera-orthographic-extent"
        )
    }

    private static func formatted(_ value: Double) -> String {
        String(format: "%.3f", value)
    }

    func releaseCamera() {
        guard let entity = cameraEntity else { return }
        entity.components.remove(PerspectiveCameraComponent.self)
        entity.components.remove(OrthographicCameraComponent.self)
        // Only a camera this consumer created is removed from the tree; one
        // that belongs to a scripted object stays where the script put it.
        if cameraRecordID == nil { entity.removeFromParent() }
        cameraEntity = nil
        cameraRecordID = nil
        ScriptingRuntime.defaultCameraEntity?.isEnabled = true
    }

    /// The world transform of the scripted camera, for the view that hosts the
    /// RealityView. Nil while the script has not set one.
    func cameraTransform() -> Transform? {
        guard let cameraEntity else { return nil }
        return Transform(matrix: cameraEntity.transformMatrix(relativeTo: nil))
    }
}

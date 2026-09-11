//
//  RealityKitScriptingInput.swift
//  RealityKitScripting
//
//  Created by Shane Liu on 9/8/26.
//

import RealityKit
import SwiftUI

public extension View {
    /// Feeds tap, drag and hover from this view's `RealityView` into every
    /// running script, using the world space conversions in SPEC 3.8.
    func enableRealityKitScriptingInput() -> some View {
        modifier(RealityKitScriptingInputModifier())
    }

    @available(*, deprecated, renamed: "enableRealityKitScriptingInput()")
    func realityScripting() -> some View {
        enableRealityKitScriptingInput()
    }
}

struct RealityKitScriptingInputModifier: ViewModifier {
    func body(content: Content) -> some View {
        let base = content
            .gesture(tapGesture)
            .gesture(dragGesture)
#if os(macOS)
        return base.onContinuousHover { phase in
            switch phase {
            case .active(let location):
                ScriptingInputRouter.shared.updatePointer(location: location)
            case .ended:
                ScriptingInputRouter.shared.updatePointer(location: nil)
            }
        }
#else
        return base
#endif
    }

    private var tapGesture: some Gesture {
        SpatialTapGesture()
            .targetedToAnyEntity()
            .onEnded { value in
                let point = Self.worldPoint(tap: value)
                ScriptingInputRouter.shared.sendTap(to: value.entity, worldPoint: point)
            }
    }

    private var dragGesture: some Gesture {
        DragGesture(minimumDistance: 0)
            .targetedToAnyEntity()
            .onChanged { value in
                let points = Self.dragWorldPoints(value)
                ScriptingInputRouter.shared.sendDrag(
                    to: value.entity,
                    phase: .changed,
                    worldPoint: points.current,
                    startWorldPoint: points.start
                )
            }
            .onEnded { value in
                let points = Self.dragWorldPoints(value)
                ScriptingInputRouter.shared.sendDrag(
                    to: value.entity,
                    phase: .ended,
                    worldPoint: points.current,
                    startWorldPoint: points.start
                )
            }
    }

    @MainActor
    private static func worldPoint(tap value: EntityTargetValue<SpatialTapGesture.Value>) -> SIMD3<Float> {
#if os(visionOS)
        value.convert(value.location3D, from: .local, to: .scene)
#else
        // The gesture value's own unproject returns nil on macOS, so the tap
        // point comes from the app-installed ray provider, the same path the
        // drag conversion uses.
        let origin = value.entity.position(relativeTo: nil)
        guard
            let provider = ScriptingInputRouter.shared.pointerRayProvider,
            let ray = provider(value.location)
        else {
            return origin
        }
        let normal = simd_normalize(ray.origin - origin)
        return Self.intersect(ray: ray, planeOrigin: origin, normal: normal) ?? origin
#endif
    }

    /// Drag translation is world space displacement since `dragstart`. On macOS
    /// the pointer is unprojected onto the plane through the object's world
    /// position that faces the camera, which gives a 1:1 on screen drag.
    @MainActor
    private static func dragWorldPoints(
        _ value: EntityTargetValue<DragGesture.Value>
    ) -> (start: SIMD3<Float>, current: SIMD3<Float>) {
        let origin = value.entity.position(relativeTo: nil)
#if os(visionOS)
        let translation = value.convert(value.translation3D, from: .local, to: .scene)
        return (origin, origin + translation)
#else
        // The gesture value's own ray and unproject helpers return nil on macOS, so use the
        // ray provider the app installs from its RealityView (the same path hover uses) and
        // intersect the pointer ray with the plane through the object that faces the camera.
        guard
            let provider = ScriptingInputRouter.shared.pointerRayProvider,
            let startRay = provider(value.startLocation),
            let currentRay = provider(value.location)
        else {
            return (origin, origin)
        }
        let normal = simd_normalize(startRay.origin - origin)
        let start = Self.intersect(ray: startRay, planeOrigin: origin, normal: normal) ?? origin
        let current = Self.intersect(ray: currentRay, planeOrigin: origin, normal: normal) ?? start
        return (start, current)
#endif
    }

    private static func intersect(
        ray: (origin: SIMD3<Float>, direction: SIMD3<Float>),
        planeOrigin: SIMD3<Float>,
        normal: SIMD3<Float>
    ) -> SIMD3<Float>? {
        let denominator = simd_dot(ray.direction, normal)
        guard abs(denominator) > 1e-6 else { return nil }
        let distance = simd_dot(planeOrigin - ray.origin, normal) / denominator
        guard distance > 0 else { return nil }
        return ray.origin + ray.direction * distance
    }

}

//
//  ScriptingStrategies.swift
//  RealityKitScripting
//
//  Created by Shane Liu on 9/9/26.
//

import Foundation

/// Selects how a `transform` record reaches the entity, and whether hit-test
/// colliders are built eagerly. Both default to the fastest measured setting;
/// the environment overrides exist so the alternatives stay measurable in the
/// app without a rebuild.
enum ScriptingTransformStrategy: String {
    /// `entity.transform = Transform(...)`
    case assign
    /// `entity.components.set(Transform(...))`
    case component
    /// Write only the parts of the transform that actually changed.
    case selective

    static let current: ScriptingTransformStrategy = {
        let name = ProcessInfo.processInfo.environment["SPATIAL_TRANSFORM_MODE"] ?? ""
        return ScriptingTransformStrategy(rawValue: name) ?? .assign
    }()
}

/// SPEC 3.7 keeps every mesh hit-testable and raycastable. RealityKit charges
/// for that per moved collider every frame: 1500 moving meshes spend 16.5 ms a
/// frame with a collider each and 5.9 ms without. So the shapes are deferred
/// until something actually needs them, which is the same behavior at a much
/// lower cost for scenes that never hit test.
enum ScriptingColliderStrategy: String {
    /// Every mesh gets a hit-test collider as soon as it has geometry.
    case eager
    /// Meshes get one when they become an input target, gain a body, or the
    /// first raycast asks for one.
    case lazy

    static let current: ScriptingColliderStrategy = {
        let name = ProcessInfo.processInfo.environment["SPATIAL_COLLIDER_MODE"] ?? ""
        return ScriptingColliderStrategy(rawValue: name) ?? .lazy
    }()
}

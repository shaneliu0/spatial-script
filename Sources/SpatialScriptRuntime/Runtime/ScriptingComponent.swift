//
//  ScriptingComponent.swift
//  SpatialScriptRuntime
//
//  Created by Shane Liu on 9/8/26.
//

import Foundation
import RealityKit

public struct ScriptingComponent: Component, Identifiable {
    public let id: UUID
    public let source: String
    /// SPEC 14.10: `this.state` from the script this one replaces, carried with
    /// the source it belongs to so a failed load cannot hand it to the wrong
    /// scene and reinstating the previous script keeps it.
    public let previousState: [String: Any]?

    public init(javaScript source: String, previousState: [String: Any]? = nil) {
        id = UUID()
        self.source = source
        self.previousState = previousState
    }

    @available(*, deprecated, renamed: "init(javaScript:)")
    public init(source: String) {
        self.init(javaScript: source)
    }
}

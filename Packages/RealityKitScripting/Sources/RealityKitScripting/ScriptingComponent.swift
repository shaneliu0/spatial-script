//
//  ScriptingComponent.swift
//  RealityKitScripting
//
//  Created by Shane Liu on 9/8/26.
//

import Foundation
import RealityKit

public struct ScriptingComponent: Component, Codable, Identifiable {
    public let id: UUID
    public let source: String

    public init(javaScript source: String) {
        id = UUID()
        self.source = source
    }

    @available(*, deprecated, renamed: "init(javaScript:)")
    public init(source: String) {
        self.init(javaScript: source)
    }
}

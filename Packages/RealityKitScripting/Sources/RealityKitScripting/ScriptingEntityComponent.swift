//
//  ScriptingEntityComponent.swift
//  RealityKitScripting
//
//  Created by Shane Liu on 9/9/26.
//

import Foundation
import RealityKit

struct ScriptingEntityComponent: Component, Codable {
    let sceneID: UUID
    let entityID: Int
}

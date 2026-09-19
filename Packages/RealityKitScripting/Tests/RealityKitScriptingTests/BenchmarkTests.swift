//
//  BenchmarkTests.swift
//  RealityKitScripting
//
//  Created by Shane Liu on 9/9/26.
//

import Foundation
import RealityKit
import Testing
@testable import RealityKitScripting

/// SPEC section 12 requires a tick of 2000 transform changes to apply within
/// 8 ms on this machine.
@MainActor
struct BenchmarkTests {
    @Test
    func appliesTwoThousandTransformsWithinTheBudget() throws {
        let root = Entity()
        let scene = try JavaScriptScene(rootEntity: root, source: """
            const stage = new Spatial.Scene();
            Spatial.mount(stage);
            """)

        let count = 2000
        var creates = "["
        for index in 0..<count {
            creates += "[\"create\", \(1000 + index), \"group\", \"n\(index)\"],"
        }
        creates.removeLast()
        creates += "]"
        scene.applyCommands(javaScript: creates)
        #expect(scene.commandApplier.entity(for: 1000) != nil)

        var transforms = "globalThis.__benchmarkCommands = ["
        for index in 0..<count {
            let offset = Float(index) * 0.001
            transforms += "[\"transform\", \(1000 + index), \(offset), \(offset), \(offset), 0, 0, 0, 1, 1, 1, 1],"
        }
        transforms.removeLast()
        transforms += "];"
        scene.inject(transforms)

        var samples: [Double] = []
        for _ in 0..<21 {
            let start = DispatchTime.now().uptimeNanoseconds
            scene.applyCommands(javaScript: "globalThis.__benchmarkCommands")
            let end = DispatchTime.now().uptimeNanoseconds
            samples.append(Double(end - start) / 1_000_000)
        }
        samples.sort()
        let median = samples[samples.count / 2]
        print("2000 transform commands: median \(String(format: "%.3f", median)) ms")
        #expect(median < 8, "median was \(median) ms")

        // The batched opcode the core actually emits, over the same boundary.
        var packed = "globalThis.__benchmarkPacked = [[\"transforms\", 0, new Float32Array(["
        for index in 0..<count {
            let offset = Float(index) * 0.001
            packed += "\(1000 + index),\(offset),\(offset),\(offset),0,0,0,1,1,1,1,"
        }
        packed.removeLast()
        packed += "])]];"
        scene.inject(packed)

        var batched: [Double] = []
        for _ in 0..<21 {
            let start = DispatchTime.now().uptimeNanoseconds
            scene.applyCommands(javaScript: "globalThis.__benchmarkPacked")
            batched.append(Double(DispatchTime.now().uptimeNanoseconds - start) / 1_000_000)
        }
        batched.sort()
        let batchedMedian = batched[batched.count / 2]
        print("2000 transforms batched: median \(String(format: "%.3f", batchedMedian)) ms")
        #expect(batchedMedian < 8, "batched median was \(batchedMedian) ms")
        #expect(batchedMedian < median, "the batched path should beat one command per object")
        scene.dispose()
    }
}

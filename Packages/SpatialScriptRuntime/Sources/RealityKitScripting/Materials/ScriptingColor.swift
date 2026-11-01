//
//  ScriptingColor.swift
//  RealityKitScripting
//
//  Created by Shane Liu on 9/9/26.
//

#if os(macOS)
import AppKit
typealias ScriptingPlatformColor = NSColor
#else
import UIKit
typealias ScriptingPlatformColor = UIColor
#endif

import CoreGraphics
import Foundation

/// Converts the linear sRGB triples carried by the command stream into the
/// gamma encoded colors RealityKit's material and light parameters expect.
enum ScriptingColor {
    static func encode(_ linear: Float) -> CGFloat {
        let value = max(0, min(1, linear))
        let encoded = value <= 0.0031308
            ? value * 12.92
            : 1.055 * pow(value, 1 / 2.4) - 0.055
        return CGFloat(encoded)
    }

    static func decode(_ encoded: CGFloat) -> Float {
        let value = Float(max(0, min(1, encoded)))
        return value <= 0.04045 ? value / 12.92 : pow((value + 0.055) / 1.055, 2.4)
    }

    static func platformColor(
        linear: SIMD3<Float>,
        alpha: CGFloat = 1
    ) -> ScriptingPlatformColor {
#if os(macOS)
        NSColor(
            srgbRed: encode(linear.x),
            green: encode(linear.y),
            blue: encode(linear.z),
            alpha: alpha
        )
#else
        UIColor(
            red: encode(linear.x),
            green: encode(linear.y),
            blue: encode(linear.z),
            alpha: alpha
        )
#endif
    }

    static func linearComponents(of color: ScriptingPlatformColor) -> SIMD3<Float> {
#if os(macOS)
        guard let converted = color.usingColorSpace(.sRGB) else { return .zero }
        return SIMD3(
            decode(converted.redComponent),
            decode(converted.greenComponent),
            decode(converted.blueComponent)
        )
#else
        var red: CGFloat = 0
        var green: CGFloat = 0
        var blue: CGFloat = 0
        var alpha: CGFloat = 0
        color.getRed(&red, green: &green, blue: &blue, alpha: &alpha)
        return SIMD3(decode(red), decode(green), decode(blue))
#endif
    }
}

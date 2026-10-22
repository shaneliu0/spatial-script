//
//  SpatialDumpMatcher.swift
//  RealityKitScripting
//
//  Created by Shane Liu on 9/9/26.
//

import Foundation

/// The subset matcher from SPEC section 9, matching `verification/conformance/match.mjs`.
///
/// Every key in `expected` must exist in `actual` with an equal value; numbers
/// match within 1e-3; arrays match element wise; entries of `objects` are
/// matched by `name` and may carry `"absent": true`; `warnings`, `errors` and
/// `logs` match by substring; keys absent from expected are unconstrained.
enum SpatialDumpMatcher {
    static let tolerance = 1e-3
    private static let substringKeys: Set<String> = ["warnings", "errors", "logs"]

    static func mismatches(expected: [String: Any], actual: [String: Any]) -> [String] {
        var diffs: [String] = []

        for key in expected.keys.sorted() {
            if key == "objects" {
                matchObjects(
                    expected: expected["objects"] as? [[String: Any]],
                    actual: actual["objects"] as? [[String: Any]] ?? [],
                    diffs: &diffs
                )
            } else if substringKeys.contains(key) {
                matchSubstrings(
                    key: key,
                    expected: expected[key] as? [String],
                    actual: actual[key] as? [String] ?? [],
                    diffs: &diffs
                )
            } else {
                matchValue(expected[key], actual[key], key, &diffs)
            }
        }

        if expected["errors"] == nil {
            let errors = actual["errors"] as? [String] ?? []
            if !errors.isEmpty {
                diffs.append("errors: expected none, got \(errors)")
            }
        }
        return diffs
    }

    private static func matchObjects(
        expected: [[String: Any]]?,
        actual: [[String: Any]],
        diffs: inout [String]
    ) {
        guard let expected else {
            diffs.append("objects: expectation must be an array")
            return
        }
        var byName: [String: [String: Any]] = [:]
        for object in actual {
            guard let name = object["name"] as? String else { continue }
            if byName[name] == nil { byName[name] = object }
        }

        for expectedObject in expected {
            guard let name = expectedObject["name"] as? String else {
                diffs.append("objects: every expected object needs a name")
                continue
            }
            let actualObject = byName[name]
            if expectedObject["absent"] as? Bool == true {
                if actualObject != nil {
                    diffs.append("objects[\"\(name)\"]: expected to be absent but it is present")
                }
                continue
            }
            guard let actualObject else {
                let available = byName.keys.sorted().joined(separator: ", ")
                diffs.append("objects[\"\(name)\"]: not found (present: \(available.isEmpty ? "none" : available))")
                continue
            }
            for key in expectedObject.keys.sorted() where key != "absent" {
                matchValue(
                    expectedObject[key],
                    actualObject[key],
                    "objects[\"\(name)\"].\(key)",
                    &diffs
                )
            }
        }
    }

    private static func matchSubstrings(
        key: String,
        expected: [String]?,
        actual: [String],
        diffs: inout [String]
    ) {
        guard let expected else {
            diffs.append("\(key): expectation must be an array of substrings")
            return
        }
        // An empty list asserts that nothing was recorded on that channel at
        // all, which is how `match.mjs` reads it: writing `[]` must not be a
        // way to switch the check off.
        guard !expected.isEmpty else {
            if !actual.isEmpty {
                diffs.append("\(key): expected none, got \(actual)")
            }
            return
        }
        for needle in expected where !actual.contains(where: { $0.contains(needle) }) {
            diffs.append("\(key): no entry contains \"\(needle)\" (got \(actual))")
        }
    }

    static func matchValue(_ expected: Any?, _ actual: Any?, _ path: String, _ diffs: inout [String]) {
        guard let expected, !(expected is NSNull) else {
            if let actual, !(actual is NSNull) {
                diffs.append("\(path): expected null, got \(actual)")
            }
            return
        }

        if isBoolean(expected) {
            guard let actual, isBoolean(actual), (actual as? NSNumber)?.boolValue == (expected as? NSNumber)?.boolValue else {
                diffs.append("\(path): expected \(expected), got \(actual ?? "undefined")")
                return
            }
            return
        }

        if let expectedNumber = numeric(expected) {
            guard let actual, let actualNumber = numeric(actual), actualNumber.isFinite else {
                diffs.append("\(path): expected number \(expectedNumber), got \(actual ?? "undefined")")
                return
            }
            if abs(expectedNumber - actualNumber) > tolerance {
                diffs.append("\(path): expected \(expectedNumber), got \(actualNumber)")
            }
            return
        }

        if let expectedArray = expected as? [Any] {
            guard let actualArray = actual as? [Any] else {
                diffs.append("\(path): expected array, got \(actual ?? "undefined")")
                return
            }
            guard expectedArray.count == actualArray.count else {
                diffs.append("\(path): expected \(expectedArray.count) elements, got \(actualArray.count)")
                return
            }
            for index in expectedArray.indices {
                matchValue(expectedArray[index], actualArray[index], "\(path)[\(index)]", &diffs)
            }
            return
        }

        if let expectedString = expected as? String {
            guard let actualString = actual as? String else {
                diffs.append("\(path): expected \"\(expectedString)\", got \(actual ?? "undefined")")
                return
            }
            if expectedString != actualString {
                diffs.append("\(path): expected \"\(expectedString)\", got \"\(actualString)\"")
            }
            return
        }

        if let expectedDictionary = expected as? [String: Any] {
            guard let actualDictionary = actual as? [String: Any] else {
                diffs.append("\(path): expected object, got \(actual ?? "undefined")")
                return
            }
            for key in expectedDictionary.keys.sorted() {
                matchValue(expectedDictionary[key], actualDictionary[key], "\(path).\(key)", &diffs)
            }
            return
        }

        diffs.append("\(path): unsupported expected value \(expected)")
    }

    private static func isBoolean(_ value: Any) -> Bool {
        guard let number = value as? NSNumber else { return value is Bool }
        return CFGetTypeID(number) == CFBooleanGetTypeID()
    }

    private static func numeric(_ value: Any) -> Double? {
        if isBoolean(value) { return nil }
        if let number = value as? NSNumber { return number.doubleValue }
        if let double = value as? Double { return double }
        if let float = value as? Float { return Double(float) }
        if let int = value as? Int { return Double(int) }
        return nil
    }
}

//
//  JavaScriptValueReader.swift
//  SpatialScriptRuntime
//
//  Created by Shane Liu on 9/9/26.
//

import Foundation
import JavaScriptCore

/// A zero-copy view over a JavaScript array. Command application walks thousands
/// of these per frame, so element access goes through the JavaScriptCore C API
/// rather than materialising Foundation objects.
struct JavaScriptArrayReader {
    let context: JSContextRef
    let object: JSObjectRef
    /// `Object.keys`, captured before any script ran. Payloads are read through
    /// it so nothing a script puts on a prototype reaches Swift.
    var ownKeys: JSObjectRef?
    var prototypeIsClean = true

    /// Only a real array is accepted: any other object has no `length`, and
    /// converting its `undefined` through `Int` would trap.
    init?(context: JSContextRef, value: JSValueRef, ownKeys: JSObjectRef? = nil) {
        guard JSValueIsArray(context, value) else { return nil }
        guard let object = JSValueToObject(context, value, nil) else { return nil }
        self.context = context
        self.object = object
        self.ownKeys = ownKeys
    }

    var count: Int {
        let name = JavaScriptStrings.length
        guard let value = JSObjectGetProperty(context, object, name, nil) else { return 0 }
        let length = JSValueToNumber(context, value, nil)
        guard length.isFinite else { return 0 }
        return Int(max(0, min(length, 4_294_967_295)))
    }

    func raw(_ index: Int) -> JSValueRef? {
        JSObjectGetPropertyAtIndex(context, object, UInt32(index), nil)
    }

    func double(_ index: Int) -> Double {
        guard let value = raw(index) else { return 0 }
        return JSValueToNumber(context, value, nil)
    }

    /// Non-finite values survive here: each opcode decides whether NaN is an
    /// error worth naming or a value to clamp.
    func float(_ index: Int) -> Float {
        Float(double(index))
    }

    /// Clamped, not just finite-checked: `1e40` is finite and still overflows
    /// `Int`, which traps.
    func int(_ index: Int) -> Int {
        let value = double(index).rounded(.towardZero)
        guard value.isFinite else { return 0 }
        if value >= Double(Int.max) { return Int.max }
        if value <= Double(Int.min) { return Int.min }
        return Int(value)
    }

    func bool(_ index: Int) -> Bool {
        guard let value = raw(index) else { return false }
        return JSValueToBoolean(context, value)
    }

    func isNullish(_ index: Int) -> Bool {
        guard let value = raw(index) else { return true }
        return JSValueIsNull(context, value) || JSValueIsUndefined(context, value)
    }

    func optionalFloat(_ index: Int) -> Float? {
        isNullish(index) ? nil : float(index)
    }

    func isArray(_ index: Int) -> Bool {
        guard let value = raw(index) else { return false }
        return JSValueIsArray(context, value)
    }

    /// The elements of an array argument, each read as a payload object.
    /// SPEC 14.12 lets `material` carry several materials for one mesh.
    func dictionaries(_ index: Int, in jsContext: JSContext) -> [[String: Any]]? {
        guard let value = raw(index), JSValueIsArray(context, value),
              let object = JSValueToObject(context, value, nil),
              let lengthName = JavaScriptStrings.length,
              let lengthValue = JSObjectGetProperty(context, object, lengthName, nil)
        else { return nil }
        let rawLength = JSValueToNumber(context, lengthValue, nil)
        guard rawLength.isFinite, rawLength > 0 else { return [] }
        let count = min(Int(rawLength), 256)
        var reader = JavaScriptPayloadReader(context: context, ownKeys: ownKeys)
        reader.prototypeIsClean = prototypeIsClean
        var result: [[String: Any]] = []
        result.reserveCapacity(count)
        for index in 0..<count {
            guard let element = JSObjectGetPropertyAtIndex(context, object, UInt32(index), nil),
                  JSValueIsObject(context, element),
                  let elementObject = JSValueToObject(context, element, nil) else { continue }
            if prototypeIsClean, let jsValue = JSValue(jsValueRef: element, in: jsContext),
               let dictionary = jsValue.toDictionary() as? [String: Any] {
                result.append(dictionary)
            } else {
                result.append(reader.dictionary(object: elementObject, depth: 0))
            }
        }
        return result
    }

    func optionalDouble(_ index: Int) -> Double? {
        isNullish(index) ? nil : double(index)
    }

    /// One command argument as a Swift value: a number, string, boolean, or a
    /// bounded array or object. Used by `shaderParameter`, whose value may be
    /// any of those. Read with the same own-property rules as `dictionary`.
    func any(_ index: Int, in jsContext: JSContext) -> Any? {
        guard let value = raw(index) else { return nil }
        switch JSValueGetType(context, value) {
        case kJSTypeNull, kJSTypeUndefined:
            return nil
        case kJSTypeBoolean:
            return JSValueToBoolean(context, value)
        case kJSTypeNumber:
            return double(index)
        case kJSTypeString:
            return string(index)
        default:
            break
        }
        guard JSValueIsObject(context, value), let object = JSValueToObject(context, value, nil) else {
            return nil
        }
        if JSValueIsArray(context, value) {
            if prototypeIsClean {
                return JSValue(jsValueRef: value, in: jsContext)?.toArray()
            }
            var reader = JavaScriptPayloadReader(context: context, ownKeys: ownKeys)
            reader.prototypeIsClean = false
            return reader.boundedArray(object: object)
        }
        return dictionary(index, in: jsContext)
    }

    func string(_ index: Int) -> String? {
        guard let value = raw(index), !JSValueIsNull(context, value),
              !JSValueIsUndefined(context, value) else { return nil }
        guard let copied = JSValueToStringCopy(context, value, nil) else { return nil }
        defer { JSStringRelease(copied) }
        let maximum = JSStringGetMaximumUTF8CStringSize(copied)
        var buffer = [UInt8](repeating: 0, count: maximum)
        let written = buffer.withUnsafeMutableBufferPointer { pointer -> Int in
            pointer.withMemoryRebound(to: CChar.self) { chars in
                JSStringGetUTF8CString(copied, chars.baseAddress, maximum)
            }
        }
        guard written > 0 else { return "" }
        return String(decoding: buffer[0..<(written - 1)], as: UTF8.self)
    }

    /// Reads a payload object using **own enumerable properties only**.
    ///
    /// `JSValue.toDictionary()` walks the prototype chain, so a script that
    /// assigns to `Object.prototype` injects its key into every payload the
    /// applier reads. With a function value on the other end that expands into
    /// an unbounded nested structure, which blew the stack inside
    /// `-[NSDictionary description]`. Nothing a script puts on a prototype
    /// reaches Swift through this path, and depth, width and string length are
    /// all bounded.
    func dictionary(_ index: Int, in jsContext: JSContext) -> [String: Any]? {
        guard let value = raw(index), !JSValueIsNull(context, value),
              !JSValueIsUndefined(context, value), JSValueIsObject(context, value),
              let object = JSValueToObject(context, value, nil)
        else { return nil }
        // With a clean prototype there is nothing inherited to pick up, so the
        // engine's own fast conversion is both correct and much cheaper. The
        // bounded own-property walk is for the polluted case.
        if prototypeIsClean {
            return JSValue(jsValueRef: value, in: jsContext)?.toDictionary() as? [String: Any]
        }
        var reader = JavaScriptPayloadReader(context: context, ownKeys: ownKeys)
        reader.prototypeIsClean = false
        return reader.dictionary(object: object, depth: 0)
    }

    /// Copies a `Float32Array` element into a Swift array in one memcpy.
    ///
    /// The `JSValueIsObject` test matters: most geometry commands carry `null`
    /// in the normals, uvs and indices slots, and calling `JSValueToObject` on
    /// `null` raises a JavaScript exception. The host formats every exception
    /// with its stack, so three nulls per geometry command cost more than the
    /// mesh itself.
    func float32Array(_ index: Int) -> [Float]? {
        guard let value = raw(index), JSValueIsObject(context, value),
              let object = JSValueToObject(context, value, nil) else { return nil }
        guard JSValueGetTypedArrayType(context, value, nil) == kJSTypedArrayTypeFloat32Array else { return nil }
        let count = JSObjectGetTypedArrayLength(context, object, nil)
        guard count > 0, let bytes = JSObjectGetTypedArrayBytesPtr(context, object, nil) else { return [] }
        return Array(UnsafeBufferPointer(start: bytes.assumingMemoryBound(to: Float.self), count: count))
    }

    /// Copies a `Uint32Array` element into a Swift array in one memcpy.
    func uint32Array(_ index: Int) -> [UInt32]? {
        guard let value = raw(index), JSValueIsObject(context, value),
              let object = JSValueToObject(context, value, nil) else { return nil }
        let type = JSValueGetTypedArrayType(context, value, nil)
        guard type == kJSTypedArrayTypeUint32Array || type == kJSTypedArrayTypeUint16Array else { return nil }
        let count = JSObjectGetTypedArrayLength(context, object, nil)
        guard count > 0, let bytes = JSObjectGetTypedArrayBytesPtr(context, object, nil) else { return [] }
        if type == kJSTypedArrayTypeUint32Array {
            return Array(UnsafeBufferPointer(start: bytes.assumingMemoryBound(to: UInt32.self), count: count))
        }
        let shorts = UnsafeBufferPointer(start: bytes.assumingMemoryBound(to: UInt16.self), count: count)
        return shorts.map(UInt32.init)
    }
}

/// Cached `JSStringRef`s so hot property lookups do not allocate.
enum JavaScriptStrings {
    nonisolated(unsafe) static let length = JSStringCreateWithUTF8CString("length")
}

/// Builds the `Float32Array`s the consumer hands back to the core through
/// `sync` and `syncBodies`.
enum JavaScriptTypedArrayFactory {
    static func float32Array(_ values: [Float], in context: JSContext) -> JSValue? {
        guard let contextRef = context.jsGlobalContextRef else { return nil }
        guard let object = JSObjectMakeTypedArray(
            contextRef,
            kJSTypedArrayTypeFloat32Array,
            values.count,
            nil
        ) else { return nil }
        if !values.isEmpty, let bytes = JSObjectGetTypedArrayBytesPtr(contextRef, object, nil) {
            bytes.assumingMemoryBound(to: Float.self).update(from: values, count: values.count)
        }
        return JSValue(jsValueRef: object, in: context)
    }
}


/// Converts a JavaScript payload into Foundation values without ever touching
/// the prototype chain, and with hard bounds on everything.
struct JavaScriptPayloadReader {
    /// A dump nests scene → objects → object → material → maps, so the bound
    /// has to clear that while still stopping a cycle.
    static let maximumDepth = 8
    /// High enough that a large dump is never silently truncated.
    static let maximumProperties = 200_000
    static let maximumStringLength = 4096

    let context: JSContextRef
    let ownKeys: JSObjectRef?
    /// When nothing enumerable sits on `Object.prototype`, the engine's own
    /// property enumeration already means own-properties, and it hands back
    /// `JSStringRef`s with no per-key allocation. That is the whole difference
    /// between a 0.1 s and a 15 s dump of 10 000 objects.
    var prototypeIsClean = true

    /// The own enumerable keys of `object`, through the `Object.keys` captured
    /// before any script ran. Falls back to the prototype-walking enumeration
    /// only when no function was captured, which is the unit-test path.
    /// Enumerates into `body` without materialising a key array.
    private func forEachKey(of object: JSObjectRef, _ body: (JSStringRef, String) -> Void) {
        guard let names = JSObjectCopyPropertyNames(context, object) else { return }
        defer { JSPropertyNameArrayRelease(names) }
        let count = min(JSPropertyNameArrayGetCount(names), Self.maximumProperties)
        let allowed: Set<String>? = prototypeIsClean ? nil : Set(keys(of: object))
        for index in 0..<count {
            guard let name = JSPropertyNameArrayGetNameAtIndex(names, index) else { continue }
            let text = JavaScriptString.bounded(name)
            if let allowed, !allowed.contains(text) { continue }
            body(name, text)
        }
    }

    private func keys(of object: JSObjectRef) -> [String] {
        if let ownKeys {
            var exception: JSValueRef?
            let argument: JSValueRef? = object
            var arguments: [JSValueRef?] = [argument]
            let result = arguments.withUnsafeMutableBufferPointer { buffer in
                JSObjectCallAsFunction(context, ownKeys, nil, 1, buffer.baseAddress, &exception)
            }
            guard exception == nil, let result, let list = JSValueToObject(context, result, nil),
                  let lengthName = JavaScriptStrings.length,
                  let lengthValue = JSObjectGetProperty(context, list, lengthName, nil)
            else { return [] }
            let rawLength = JSValueToNumber(context, lengthValue, nil)
            guard rawLength.isFinite, rawLength > 0 else { return [] }
            let count = min(Int(min(rawLength, Double(Self.maximumProperties))), Self.maximumProperties)
            var names: [String] = []
            names.reserveCapacity(count)
            for index in 0..<count {
                guard let element = JSObjectGetPropertyAtIndex(context, list, UInt32(index), nil),
                      let copied = JSValueToStringCopy(context, element, nil) else { continue }
                names.append(JavaScriptString.bounded(copied))
                JSStringRelease(copied)
            }
            return names
        }

        guard let names = JSObjectCopyPropertyNames(context, object) else { return [] }
        defer { JSPropertyNameArrayRelease(names) }
        let count = min(JSPropertyNameArrayGetCount(names), Self.maximumProperties)
        return (0..<count).compactMap { index in
            JSPropertyNameArrayGetNameAtIndex(names, index).map { JavaScriptString.bounded($0) }
        }
    }

    func dictionary(object: JSObjectRef, depth: Int) -> [String: Any] {
        guard depth < Self.maximumDepth else { return [:] }
        var result: [String: Any] = [:]
        forEachKey(of: object) { key, name in
            var exception: JSValueRef?
            guard let value = JSObjectGetProperty(context, object, key, &exception),
                  exception == nil else { return }
            guard let converted = self.value(value: value, depth: depth) else { return }
            result[name] = converted
        }
        return result
    }

    private func value(value: JSValueRef, depth: Int) -> Any? {
        switch JSValueGetType(context, value) {
        case kJSTypeNull:
            return NSNull()
        case kJSTypeBoolean:
            return JSValueToBoolean(context, value)
        case kJSTypeNumber:
            var exception: JSValueRef?
            let number = JSValueToNumber(context, value, &exception)
            return exception == nil ? number : nil
        case kJSTypeString:
            var exception: JSValueRef?
            guard let copied = JSValueToStringCopy(context, value, &exception), exception == nil else {
                return nil
            }
            defer { JSStringRelease(copied) }
            return JavaScriptString.bounded(copied)
        case kJSTypeObject:
            guard depth + 1 < Self.maximumDepth,
                  let object = JSValueToObject(context, value, nil) else { return nil }
            // Functions, symbols and anything else exotic are simply not read.
            if JSObjectIsFunction(context, object) { return nil }
            if JSValueIsArray(context, value) {
                return array(object: object, depth: depth + 1)
            }
            return dictionary(object: object, depth: depth + 1)
        default:
            return nil
        }
    }

    /// The bounded array walk, for a caller that already has the object.
    func boundedArray(object: JSObjectRef) -> [Any] {
        array(object: object, depth: 0)
    }

    private func array(object: JSObjectRef, depth: Int) -> [Any] {
        guard let lengthName = JavaScriptStrings.length,
              let lengthValue = JSObjectGetProperty(context, object, lengthName, nil) else { return [] }
        let rawLength = JSValueToNumber(context, lengthValue, nil)
        guard rawLength.isFinite, rawLength > 0 else { return [] }
        let count = min(Int(min(rawLength, Double(Self.maximumProperties))), Self.maximumProperties)
        var result: [Any] = []
        result.reserveCapacity(count)
        for index in 0..<count {
            guard let element = JSObjectGetPropertyAtIndex(context, object, UInt32(index), nil),
                  let converted = value(value: element, depth: depth) else {
                result.append(NSNull())
                continue
            }
            result.append(converted)
        }
        return result
    }
}

/// A bounded UTF-8 read of a `JSStringRef`.
enum JavaScriptString {
    static func bounded(_ jsString: JSStringRef) -> String {
        let maximum = Swift.min(
            JSStringGetMaximumUTF8CStringSize(jsString),
            JavaScriptPayloadReader.maximumStringLength * 4 + 1
        )
        var buffer = [UInt8](repeating: 0, count: maximum)
        let written = buffer.withUnsafeMutableBufferPointer { pointer -> Int in
            pointer.withMemoryRebound(to: CChar.self) { chars in
                JSStringGetUTF8CString(jsString, chars.baseAddress, maximum)
            }
        }
        return written > 0 ? String(decoding: buffer[0..<(written - 1)], as: UTF8.self) : ""
    }
}

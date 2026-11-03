//
//  ScriptingDumpFilter.swift
//  SpatialScriptRuntime
//
//  Created by Shane Liu on 9/9/26.
//

import Foundation

/// Narrows a dump so polling it is cheap.
///
/// A full dump of 10 000 objects is ~12 MB and about a second of main-actor
/// time, which makes a poll loop indistinguishable from a hang. `compact` drops
/// the object list to counts, `names` keeps only the objects asked for, and
/// `fields` keeps only the per-object keys asked for.
public enum ScriptingDumpFilter {
    /// Keys that always survive, so a filtered dump is still well formed.
    private static let identityKeys: Set<String> = ["id", "name", "type", "parent"]

    public static func options(
        compact: Bool,
        names: [String],
        fields: [String],
        objects: Bool = true
    ) -> [String: Any]? {
        guard compact || !objects || !names.isEmpty || !fields.isEmpty else { return nil }
        var options: [String: Any] = [:]
        if compact { options["compact"] = true }
        // SPEC 3.13 `objects: false`: the scene summary with no object list, the
        // cheapest poll there is.
        if !objects { options["objects"] = false }
        if !names.isEmpty { options["names"] = names }
        if !fields.isEmpty { options["fields"] = fields }
        return options
    }

    public static func apply(options: [String: Any]?, to dump: [String: Any]) -> [String: Any] {
        guard let options, !dump.isEmpty else { return dump }
        var result = dump
        let objects = dump["objects"] as? [[String: Any]] ?? []

        if options["objects"] as? Bool == false {
            result["objects"] = [[String: Any]]()
            result["objectCount"] = objects.count
            return result
        }

        var filtered = objects
        if let names = options["names"] as? [String], !names.isEmpty {
            let wanted = Set(names)
            filtered = filtered.filter { wanted.contains($0["name"] as? String ?? "") }
        }
        if let fields = options["fields"] as? [String], !fields.isEmpty {
            let wanted = Set(fields).union(identityKeys)
            filtered = filtered.map { object in object.filter { wanted.contains($0.key) } }
        }

        result["objects"] = filtered
        result["objectCount"] = objects.count
        return result
    }
}

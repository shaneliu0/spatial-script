// swift-tools-version: 6.2

import PackageDescription

let package = Package(
    name: "SpatialScriptRuntime",
    platforms: [
        .macOS(.v26),
        .visionOS(.v26),
    ],
    products: [
        .library(name: "SpatialScriptRuntime", targets: ["SpatialScriptRuntime"]),
    ],
    targets: [
        .target(
            name: "SpatialScriptRuntime",
            path: "Sources/RealityKitScripting",
            resources: [
                .copy("Resources/spatial-core.js"),
                .copy("Resources/agent-prompt.md"),
            ],
            // Xcode does not pass its own DEBUG condition down to a package
            // target, so the DEBUG-only dev transport support and the script
            // execution watchdog would be compiled out of the app.
            swiftSettings: [.define("DEBUG", .when(configuration: .debug))]
        ),
        .testTarget(
            name: "RealityKitScriptingTests",
            dependencies: ["SpatialScriptRuntime"],
            // The matcher fixtures and their node driver are read from the
            // source tree by path, not from the test bundle: `match.mjs` lives
            // beside them in the repository and both matchers must see the same
            // file (SPEC 10).
            exclude: ["Fixtures/matcher-fixtures.json", "Fixtures/run-match-fixtures.mjs"]
        ),
    ]
)

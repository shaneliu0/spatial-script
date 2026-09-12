// swift-tools-version: 6.2

import PackageDescription

let package = Package(
    name: "RealityKitScripting",
    platforms: [
        .macOS(.v26),
        .visionOS(.v26),
    ],
    products: [
        .library(name: "RealityKitScripting", targets: ["RealityKitScripting"]),
    ],
    targets: [
        .target(
            name: "RealityKitScripting",
            resources: [.copy("Resources/spatial-core.js")],
            // Xcode does not pass its own DEBUG condition down to a package
            // target, so the DEBUG-only dev transport support and the script
            // execution watchdog would be compiled out of the app.
            swiftSettings: [.define("DEBUG", .when(configuration: .debug))]
        ),
        .testTarget(
            name: "RealityKitScriptingTests",
            dependencies: ["RealityKitScripting"]
        ),
    ]
)

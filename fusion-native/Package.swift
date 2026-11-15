// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "Ketcher3D",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(name: "Ketcher3D", path: "Sources/Ketcher3D",
                          linkerSettings: [.linkedLibrary("z")])
    ]
)

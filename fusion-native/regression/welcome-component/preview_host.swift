import AppKit
import Foundation
import SwiftUI

private func createSampleMoleculeThumbnail(to url: URL) throws {
    let width = 480
    let height = 340
    let rep = NSBitmapImageRep(
        bitmapDataPlanes: nil,
        pixelsWide: width,
        pixelsHigh: height,
        bitsPerSample: 8,
        samplesPerPixel: 4,
        hasAlpha: true,
        isPlanar: false,
        colorSpaceName: .deviceRGB,
        bytesPerRow: 0,
        bitsPerPixel: 0
    )!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)

    // Light workspace backdrop + A4 paper sheet preview
    NSColor(calibratedRed: 0.933, green: 0.945, blue: 0.961, alpha: 1.0).setFill()
    NSRect(x: 0, y: 0, width: width, height: height).fill()

    let paperRect = NSRect(x: 110, y: 20, width: 260, height: 300)
    NSColor.white.setFill()
    NSBezierPath(roundedRect: paperRect, xRadius: 4, yRadius: 4).fill()
    NSColor(calibratedRed: 0.835, green: 0.863, blue: 0.894, alpha: 1.0).setStroke()
    let border = NSBezierPath(roundedRect: paperRect, xRadius: 4, yRadius: 4)
    border.lineWidth = 2
    border.stroke()

    // Draw simple benzene ring + reaction arrow inside the paper sheet
    let cx: CGFloat = 195
    let cy: CGFloat = 180
    let r: CGFloat = 42
    let hex = NSBezierPath()
    for i in 0..<6 {
        let angle = CGFloat(i) * (.pi / 3.0) + .pi / 6.0
        let pt = NSPoint(x: cx + r * cos(angle), y: cy + r * sin(angle))
        if i == 0 { hex.move(to: pt) } else { hex.line(to: pt) }
    }
    hex.close()
    hex.lineWidth = 3.0
    NSColor(calibratedRed: 0.118, green: 0.161, blue: 0.231, alpha: 1.0).setStroke()
    hex.stroke()

    // Inner double-bond strokes
    let inner = NSBezierPath()
    inner.lineWidth = 2.4
    for i in [0, 2, 4] {
        let a1 = CGFloat(i) * (.pi / 3.0) + .pi / 6.0
        let a2 = CGFloat(i + 1) * (.pi / 3.0) + .pi / 6.0
        inner.move(to: NSPoint(x: cx + (r - 8) * cos(a1), y: cy + (r - 8) * sin(a1)))
        inner.line(to: NSPoint(x: cx + (r - 8) * cos(a2), y: cy + (r - 8) * sin(a2)))
    }
    inner.stroke()

    // Reaction arrow
    let arrow = NSBezierPath()
    arrow.lineWidth = 2.8
    arrow.move(to: NSPoint(x: 255, y: 180))
    arrow.line(to: NSPoint(x: 332, y: 180))
    arrow.move(to: NSPoint(x: 322, y: 187))
    arrow.line(to: NSPoint(x: 332, y: 180))
    arrow.line(to: NSPoint(x: 322, y: 173))
    NSColor(calibratedRed: 0.086, green: 0.467, blue: 0.510, alpha: 1.0).setStroke()
    arrow.stroke()

    // Title rule bar
    NSColor(calibratedRed: 0.086, green: 0.467, blue: 0.510, alpha: 0.25).setFill()
    NSRect(x: 136, y: 274, width: 140, height: 10).fill()
    NSColor(calibratedRed: 0.835, green: 0.863, blue: 0.894, alpha: 1.0).setFill()
    NSRect(x: 136, y: 84, width: 204, height: 6).fill()
    NSRect(x: 136, y: 68, width: 162, height: 6).fill()

    NSGraphicsContext.restoreGraphicsState()
    guard let data = rep.representation(using: .png, properties: [:]) else {
        throw NSError(domain: "PreviewHost", code: 1)
    }
    try data.write(to: url)
}

final class PreviewHostController: NSObject, NSApplicationDelegate {
    private let screenshotDir: String?
    private let suiteName = "local.molstudio.welcome.preview.\(UUID().uuidString)"
    private var defaults: UserDefaults!
    private var tempRoot: URL!
    private var window: NSWindow!
    private var hostingController: NSHostingController<WelcomeView>!
    private var viewModel: WelcomeViewModel!

    init(screenshotDir: String?) {
        self.screenshotDir = screenshotDir
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        defaults = UserDefaults(suiteName: suiteName)!
        tempRoot = FileManager.default.temporaryDirectory
            .appendingPathComponent("molstudio-welcome-preview-\(UUID().uuidString)", isDirectory: true)
        let appDir = tempRoot.appendingPathComponent("AppDocs", isDirectory: true)
        let externalDir = tempRoot.appendingPathComponent("OrganicNotes", isDirectory: true)
        let thumbDir = tempRoot.appendingPathComponent("thumbnails", isDirectory: true)

        try? FileManager.default.createDirectory(at: appDir, withIntermediateDirectories: true)
        try? FileManager.default.createDirectory(at: externalDir, withIntermediateDirectories: true)
        try? FileManager.default.createDirectory(at: thumbDir, withIntermediateDirectories: true)

        let paperFile = externalDir.appendingPathComponent("咖啡因合成路线综述.molwork")
        let sn2File = appDir.appendingPathComponent("OH-CH3Br-SN2机理.molwork")
        let ketFile = externalDir.appendingPathComponent("Suzuki偶联产物.ket")
        let molFile = appDir.appendingPathComponent("Aspirin-3D参考.mol")
        let missingFile = externalDir.appendingPathComponent("已移动的旧实验记录.molwork")

        try? #"{"format":"molstudio-workbench","version":2,"document":{"mode":"paper"},"ket":{}}"#
            .write(to: paperFile, atomically: true, encoding: .utf8)
        try? #"{"format":"molstudio-workbench","version":1,"ket":{},"bindings":{},"mechanism":{}}"#
            .write(to: sn2File, atomically: true, encoding: .utf8)
        try? #"{"root":{"nodes":[]}}"#.write(to: ketFile, atomically: true, encoding: .utf8)
        try? "\n  MolStudio\n\n  0  0  0  0  0  0  0  0  0  0999 V2000\nM  END\n"
            .write(to: molFile, atomically: true, encoding: .utf8)

        let now = Date()
        try? FileManager.default.setAttributes([.modificationDate: now.addingTimeInterval(-1800)], ofItemAtPath: paperFile.path)
        try? FileManager.default.setAttributes([.modificationDate: now.addingTimeInterval(-7200)], ofItemAtPath: sn2File.path)
        try? FileManager.default.setAttributes([.modificationDate: now.addingTimeInterval(-86400)], ofItemAtPath: ketFile.path)
        try? FileManager.default.setAttributes([.modificationDate: now.addingTimeInterval(-86400 * 4)], ofItemAtPath: molFile.path)

        let paperCanonical = WelcomeRecents.canonicalPath(for: paperFile)
        let paperThumb = thumbDir.appendingPathComponent("\(WelcomeRecents.sha1Hex(paperCanonical)).png")
        try? createSampleMoleculeThumbnail(to: paperThumb)

        let examples = [
            WelcomeExampleItem(id: "sn2", title: "OH⁻ + CH₃Br Sₙ2 机理", subtitle: "含 1 对孤对电子与 2 根弯箭头"),
            WelcomeExampleItem(id: "caffeine", title: "咖啡因多路线合成", subtitle: "多步骤反应排版示例"),
        ]

        viewModel = WelcomeViewModel(
            defaults: defaults,
            appDirectoryURL: appDir,
            thumbnailsDirectoryURL: thumbDir,
            examples: examples,
            recentURLsProvider: { [paperFile, ketFile, missingFile] }
        )

        let view = WelcomeView(
            model: viewModel,
            onNewCanvas: { [weak self] in self?.logAction("新建无边画布") },
            onNewPaper: { [weak self] setup in self?.logAction("新建纸页: \(setup.detailText)") },
            onOpenPanel: { [weak self] in self?.logAction("触发打开文件面板") },
            onOpenURL: { [weak self] url in self?.logAction("打开文件: \(url.lastPathComponent)") },
            onOpenExample: { [weak self] ex in self?.logAction("打开示例: \(ex.title)") },
            onRemoveRecent: { [weak self] item in self?.logAction("从最近列表移除: \(item.displayName)") },
            onRequestRename: { [weak self] item in self?.logAction("请求重命名: \(item.displayName)") },
            onRevealInFinder: { [weak self] item in self?.logAction("在 Finder 中显示: \(item.displayName)") }
        )

        hostingController = NSHostingController(rootView: view)
        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1000, height: 680),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "MolStudio — 欢迎页独立组件宿主"
        window.contentViewController = hostingController
        window.center()

        if let screenshotDir {
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            runScreenshotSequence(into: URL(fileURLWithPath: screenshotDir, isDirectory: true))
        } else {
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        defaults?.removePersistentDomain(forName: suiteName)
        if let tempRoot {
            try? FileManager.default.removeItem(at: tempRoot)
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    private func logAction(_ msg: String) {
        print("[PreviewHost] \(msg)")
        window.subtitle = msg
    }

    private func runScreenshotSequence(into outputDir: URL) {
        try? FileManager.default.createDirectory(at: outputDir, withIntermediateDirectories: true)

        func capture(_ filename: String, after delay: TimeInterval, setup: @escaping () -> Void, next: @escaping () -> Void) {
            setup()
            hostingController.view.layoutSubtreeIfNeeded()
            window.contentView?.layoutSubtreeIfNeeded()
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
                self.hostingController.view.layoutSubtreeIfNeeded()
                self.saveWindowContentPNG(to: outputDir.appendingPathComponent(filename))
                next()
            }
        }

        // 1. Standard grid view (Light, 1000x680)
        capture("welcome-grid.png", after: 0.45) {
            self.window.appearance = NSAppearance(named: .aqua)
            self.viewModel.selectedCategory = .recents
            self.viewModel.viewMode = .grid
            self.window.setContentSize(NSSize(width: 1000, height: 680))
        } next: {
            // 2. Standard list view (Light, 1000x680)
            capture("welcome-list.png", after: 0.45) {
                self.window.appearance = NSAppearance(named: .aqua)
                self.viewModel.selectedCategory = .recents
                self.viewModel.viewMode = .list
                self.window.setContentSize(NSSize(width: 1000, height: 680))
            } next: {
                // 3. Compact window view (Light, 760x520)
                capture("welcome-narrow.png", after: 0.45) {
                    self.window.appearance = NSAppearance(named: .aqua)
                    self.viewModel.selectedCategory = .recents
                    self.viewModel.viewMode = .grid
                    self.window.setContentSize(NSSize(width: 760, height: 520))
                } next: {
                    // 4. Dark mode grid view (Dark, 1000x680)
                    capture("welcome-dark.png", after: 0.45) {
                        self.window.appearance = NSAppearance(named: .darkAqua)
                        self.viewModel.selectedCategory = .recents
                        self.viewModel.viewMode = .grid
                        self.window.setContentSize(NSSize(width: 1000, height: 680))
                    } next: {
                        // 5. Category filter view (Paper, 1000x680)
                        capture("welcome-category.png", after: 0.45) {
                            self.window.appearance = NSAppearance(named: .aqua)
                            self.viewModel.selectedCategory = .paper
                            self.viewModel.viewMode = .grid
                            self.window.setContentSize(NSSize(width: 1000, height: 680))
                        } next: {
                            // 6. Empty state view (Light, 1000x680)
                            capture("welcome-empty.png", after: 0.45) {
                                self.window.appearance = NSAppearance(named: .aqua)
                                self.window.setContentSize(NSSize(width: 1000, height: 680))
                                self.viewModel.selectedCategory = .recents
                                self.viewModel.recentItems = []
                                self.viewModel.selectedItemID = nil
                            } next: {
                                print("PASS: Generated 6 screenshots in \(outputDir.path)")
                                NSApp.terminate(nil)
                            }
                        }
                    }
                }
            }
        }
    }

    private func saveWindowContentPNG(to url: URL) {
        guard let contentView = window.contentView else {
            fputs("FAIL: missing contentView for screenshot \(url.lastPathComponent)\n", stderr)
            exit(1)
        }
        contentView.layoutSubtreeIfNeeded()
        contentView.displayIfNeeded()
        let bounds = contentView.bounds
        guard let rep = contentView.bitmapImageRepForCachingDisplay(in: bounds) else {
            fputs("FAIL: cannot allocate bitmapImageRep for \(url.lastPathComponent)\n", stderr)
            exit(1)
        }
        contentView.cacheDisplay(in: bounds, to: rep)
        guard let pngData = rep.representation(using: .png, properties: [:]) else {
            fputs("FAIL: cannot encode PNG for \(url.lastPathComponent)\n", stderr)
            exit(1)
        }
        do {
            try pngData.write(to: url)
        } catch {
            fputs("FAIL: failed writing \(url.path): \(error)\n", stderr)
            exit(1)
        }
    }
}

@main
struct WelcomePreviewHostApp {
    static func main() {
        let args = CommandLine.arguments
        var screenshotDir: String?
        if let idx = args.firstIndex(of: "--capture-screenshots"), idx + 1 < args.count {
            screenshotDir = args[idx + 1]
        }

        let app = NSApplication.shared
        let controller = PreviewHostController(screenshotDir: screenshotDir)
        app.delegate = controller
        app.setActivationPolicy(.regular)
        app.run()
    }
}

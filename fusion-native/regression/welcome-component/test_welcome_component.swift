import AppKit
import Foundation
import SwiftUI

private func expect(_ condition: @autoclosure () -> Bool, _ message: String) {
    if !condition() {
        fputs("FAIL: \(message)\n", stderr)
        exit(1)
    }
}

private func writePNG(to url: URL) throws {
    let rep = NSBitmapImageRep(
        bitmapDataPlanes: nil,
        pixelsWide: 64,
        pixelsHigh: 48,
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
    NSColor.white.setFill()
    NSRect(x: 0, y: 0, width: 64, height: 48).fill()
    NSColor(calibratedRed: 0.086, green: 0.467, blue: 0.510, alpha: 1.0).setStroke()
    let path = NSBezierPath(roundedRect: NSRect(x: 6, y: 6, width: 52, height: 36), xRadius: 4, yRadius: 4)
    path.lineWidth = 2
    path.stroke()
    NSGraphicsContext.restoreGraphicsState()
    guard let data = rep.representation(using: .png, properties: [:]) else {
        throw NSError(domain: "Test", code: 1)
    }
    try data.write(to: url)
}

@main
struct WelcomeComponentTestRunner {
    static func main() throws {
        let fm = FileManager.default
        let suiteName = "local.molstudio.welcome.test.\(UUID().uuidString)"
        guard let defaults = UserDefaults(suiteName: suiteName) else {
            fputs("FAIL: cannot create isolated UserDefaults suite\n", stderr)
            exit(1)
        }
        defer {
            defaults.removePersistentDomain(forName: suiteName)
        }

        let tempRoot = fm.temporaryDirectory.appendingPathComponent("molstudio-welcome-test-\(UUID().uuidString)", isDirectory: true)
        let appDir = tempRoot.appendingPathComponent("AppDocs", isDirectory: true)
        let externalDir = tempRoot.appendingPathComponent("ExternalResearch", isDirectory: true)
        let thumbDir = tempRoot.appendingPathComponent("thumbnails", isDirectory: true)
        try fm.createDirectory(at: appDir, withIntermediateDirectories: true)
        try fm.createDirectory(at: externalDir, withIntermediateDirectories: true)
        try fm.createDirectory(at: thumbDir, withIntermediateDirectories: true)
        defer {
            try? fm.removeItem(at: tempRoot)
        }

        // Create files across two directories with distinct modification times
        let fileAppCanvas = appDir.appendingPathComponent("sn2-mechanism.molwork")
        let fileExtPaper = externalDir.appendingPathComponent("alkene-notes.molwork")
        let fileExtKet = externalDir.appendingPathComponent("caffeine.ket")
        let hiddenDotFile = appDir.appendingPathComponent(".ignored.ket")
        let unsupportedFile = externalDir.appendingPathComponent("readme.txt")
        let missingFile = externalDir.appendingPathComponent("deleted-draft.molwork")

        try #"{"format":"molstudio-workbench","version":1,"ket":{},"bindings":{},"mechanism":{}}"#.write(to: fileAppCanvas, atomically: true, encoding: .utf8)
        try #"{"format":"molstudio-workbench","version":2,"document":{"mode":"paper"},"ket":{}}"#.write(to: fileExtPaper, atomically: true, encoding: .utf8)
        try #"{"root":{"nodes":[]}}"#.write(to: fileExtKet, atomically: true, encoding: .utf8)
        try "{}".write(to: hiddenDotFile, atomically: true, encoding: .utf8)
        try "ignore".write(to: unsupportedFile, atomically: true, encoding: .utf8)

        let tOld = Date(timeIntervalSince1970: 1_700_000_000)
        let tMid = Date(timeIntervalSince1970: 1_700_010_000)
        let tNew = Date(timeIntervalSince1970: 1_700_020_000)

        try fm.setAttributes([.modificationDate: tOld], ofItemAtPath: fileExtKet.path)
        try fm.setAttributes([.modificationDate: tMid], ofItemAtPath: fileAppCanvas.path)
        try fm.setAttributes([.modificationDate: tNew], ofItemAtPath: fileExtPaper.path)

        // Symlink duplicate pointing to fileAppCanvas to test canonical deduplication
        let symlinkDup = externalDir.appendingPathComponent("symlink-sn2.molwork")
        try fm.createSymbolicLink(at: symlinkDup, withDestinationURL: fileAppCanvas)

        // Thumbnails: valid fresh thumbnail for fileExtPaper, expired thumbnail for fileAppCanvas
        let paperCanonical = WelcomeRecents.canonicalPath(for: fileExtPaper)
        let canvasCanonical = WelcomeRecents.canonicalPath(for: fileAppCanvas)
        let paperThumb = thumbDir.appendingPathComponent("\(WelcomeRecents.sha1Hex(paperCanonical)).png")
        let canvasThumb = thumbDir.appendingPathComponent("\(WelcomeRecents.sha1Hex(canvasCanonical)).png")
        try writePNG(to: paperThumb)
        try writePNG(to: canvasThumb)
        try fm.setAttributes([.modificationDate: tNew.addingTimeInterval(10)], ofItemAtPath: paperThumb.path)
        try fm.setAttributes([.modificationDate: tMid.addingTimeInterval(-60)], ofItemAtPath: canvasThumb.path)

        // Test canonicalization for missing path under /tmp vs /private/tmp
        let missingA = URL(fileURLWithPath: "/tmp/nonexistent-molstudio-\(UUID().uuidString).ket")
        let missingB = URL(fileURLWithPath: "/private" + missingA.path)
        expect(
            WelcomeRecents.canonicalPath(for: missingA) == WelcomeRecents.canonicalPath(for: missingB),
            "canonicalPath should normalize /tmp and /private/tmp for missing files"
        )

        // Merge recentURLs (including external, symlink dup, unsupported, missing) + appDir scan
        let merged = WelcomeRecents.loadMergedRecents(
            recentURLs: [fileExtKet, symlinkDup, unsupportedFile, missingFile, fileExtPaper],
            appDirectoryURL: appDir,
            thumbnailsDirectoryURL: thumbDir
        )

        expect(merged.count == 4, "expected 4 deduplicated supported items, got \(merged.count)")
        expect(merged[0].id == paperCanonical, "newest file should sort first")
        expect(merged[0].mode == .paper, "v2 paper molwork should report .paper mode")
        expect(merged[0].thumbnailURL != nil, "fresh thumbnail should resolve")
        expect(merged[0].exists, "paper file should exist")

        expect(merged[1].id == canvasCanonical, "second newest file should sort second")
        expect(merged[1].mode == .canvas, "v1 molwork should report .canvas mode")
        expect(merged[1].thumbnailURL == nil, "expired thumbnail should be ignored")

        expect(merged[2].id == WelcomeRecents.canonicalPath(for: fileExtKet), "oldest existing file should sort third")
        expect(merged[2].mode == .canvas, ".ket should report .canvas mode")

        let missingCanonical = WelcomeRecents.canonicalPath(for: missingFile)
        expect(merged[3].id == missingCanonical, "missing file should appear after existing files")
        expect(!merged[3].exists, "missing file should have exists == false")
        expect(merged[3].mode == nil, "missing file should have nil mode")

        let canvasV2 = tempRoot.appendingPathComponent("canvas-v2.molwork")
        try #"{"format":"molstudio-workbench","version":2,"document":{"mode":"canvas"},"ket":{}}"#.write(to: canvasV2, atomically: true, encoding: .utf8)
        expect(WelcomeRecents.inspectModeQuickly(at: canvasV2, exists: true) == .canvas, "v2 canvas must not be classified as paper")
        let large = tempRoot.appendingPathComponent("large.molwork")
        let largeJSON = #"{"format":"molstudio-workbench","version":2,"ket":{"content":""# + String(repeating: "x", count: 5000) + #""},"document":{"mode":"paper"}}"#
        try largeJSON.write(to: large, atomically: true, encoding: .utf8)
        expect(WelcomeRecents.inspectModeQuickly(at: large, exists: true) == nil, "truncated large workbench mode must stay unknown")

        // Verify ViewModel persistence with isolated UserDefaults
        do {
            let vm1 = WelcomeViewModel(
                defaults: defaults,
                appDirectoryURL: appDir,
                thumbnailsDirectoryURL: thumbDir,
                examples: [WelcomeExampleItem(id: "sn2", title: "OH⁻ + CH₃Br 机理示例")],
                recentURLsProvider: { [fileExtKet, fileExtPaper, missingFile] }
            )

            expect(vm1.paperSetup.size == .a4, "default paper size should be A4")
            expect(vm1.paperSetup.orientation == .portrait, "default paper orientation should be portrait")
            expect(abs(vm1.paperSetup.widthPt - 595.28) < 0.01, "default A4 portrait widthPt mismatch")
            expect(abs(vm1.paperSetup.heightPt - 841.89) < 0.01, "default A4 portrait heightPt mismatch")
            expect(vm1.viewMode == .grid, "default viewMode should be grid")
            expect(vm1.selectedCategory == .recents, "default category should be recents")
            expect(vm1.recentItems.count == 4, "ViewModel should load 4 merged recents")
            expect(vm1.count(for: .recents) == 4, "recents category should include unknown/missing modes")
            expect(vm1.count(for: .canvas) == 2, "canvas category should count .canvas items")
            expect(vm1.count(for: .paper) == 1, "paper category should count .paper items")

            // Search filtering by name & directory path
            vm1.searchQuery = "ExternalResearch"
            expect(vm1.filteredRecentItems.count == 3, "path filter should match external directory items")
            vm1.searchQuery = "caffeine"
            expect(vm1.filteredRecentItems.count == 1 && vm1.filteredRecentItems[0].displayName == "caffeine.ket", "name filter mismatch")
            vm1.searchQuery = "nonexistent-query-xyz"
            expect(vm1.filteredRecentItems.isEmpty && vm1.isSearchEmptyState, "empty search state should trigger")
            vm1.clearSearch()
            expect(vm1.filteredRecentItems.count == 4, "clearing search should restore all items")

            // Sidebar category filtering + combined search filtering
            vm1.selectedCategory = .canvas
            expect(vm1.filteredRecentItems.count == 2, "canvas category should filter 2 items")
            vm1.searchQuery = "alkene"
            expect(vm1.filteredRecentItems.isEmpty && vm1.isSearchEmptyState, "canvas + paper-only query should yield empty search state")
            vm1.clearSearch()
            vm1.selectedCategory = .paper
            expect(vm1.filteredRecentItems.count == 1 && vm1.filteredRecentItems[0].id == paperCanonical, "paper category should show paper item")
            expect(!vm1.isCategoryEmptyState, "non-empty paper category should not trigger category empty state")
            vm1.removeRecent(vm1.filteredRecentItems[0])
            expect(vm1.filteredRecentItems.isEmpty && vm1.isCategoryEmptyState, "empty paper category with other recents present should trigger isCategoryEmptyState")
            expect(!vm1.isRecentsEmptyState && !vm1.isSearchEmptyState, "empty category must stay distinct from global empty and search empty")
            vm1.noteOpened(fileExtPaper)
            vm1.reloadRecents()
            vm1.selectedCategory = .recents
            expect(vm1.recentItems.count == 4, "restoring paper item should bring count back to 4")

            // Update paper setup & viewMode & remove missing item
            vm1.paperSetup.size = .letter
            vm1.paperSetup.orientation = .landscape
            vm1.viewMode = .list
            vm1.removeRecent(merged[3])
            expect(vm1.recentItems.count == 3, "removing missing item should drop it from recentItems")

            let payload = vm1.paperSetup.toDocumentInitPayload(pageCount: 1)
            expect((payload["mode"] as? String) == "paper", "payload mode should be paper")
            expect((payload["size"] as? String) == "Letter", "payload size should be Letter")
            expect((payload["orientation"] as? String) == "landscape", "payload orientation should be landscape")
            expect(vm1.paperSetup.toJSONString() != nil, "toJSONString should produce valid JSON")

            // Re-create ViewModel using the same isolated UserDefaults to verify restoration
            let vm2 = WelcomeViewModel(
                defaults: defaults,
                appDirectoryURL: appDir,
                thumbnailsDirectoryURL: thumbDir,
                examples: [WelcomeExampleItem(id: "sn2", title: "OH⁻ + CH₃Br 机理示例")],
                recentURLsProvider: { [fileExtKet, fileExtPaper, missingFile] }
            )
            expect(vm2.paperSetup.size == .letter, "restored paper size should be Letter")
            expect(vm2.paperSetup.orientation == .landscape, "restored orientation should be landscape")
            expect(vm2.viewMode == .list, "restored viewMode should be list")
            expect(vm2.recentItems.count == 3, "removed recent item should remain excluded after reload")

            // Re-opening a removed item clears its exclusion
            vm2.noteOpened(missingFile)
            vm2.reloadRecents()
            expect(vm2.recentItems.count == 4, "noteOpened should restore an excluded recent item")

            // Instantiate WelcomeView to ensure view builder and closure signatures compile & initialize cleanly
            let view = WelcomeView(
                model: vm2,
                onNewCanvas: {},
                onNewPaper: { _ in },
                onOpenPanel: {},
                onOpenURL: { _ in },
                onOpenExample: { _ in },
                onRemoveRecent: { _ in },
                onRequestRename: { _ in },
                onRevealInFinder: { _ in }
            )
            _ = NSHostingController(rootView: view)
        }

        print("PASS: WelcomeRecents & WelcomeViewModel isolated unit suite passed all checks.")
    }
}

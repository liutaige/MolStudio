import Foundation
import AppKit

@main struct WelcomeThumbnailTests {
    static func expect(_ condition: @autoclosure () -> Bool, _ name: String) {
        guard condition() else { fputs("FAIL: \(name)\n", stderr); exit(1) }
        print("PASS: \(name)")
    }
    static func main() throws {
        let fm = FileManager.default, root = fm.temporaryDirectory.appendingPathComponent("molstudio-thumb-test-" + UUID().uuidString)
        let cache = root.appendingPathComponent("thumbnails"), external = root.appendingPathComponent("outside", isDirectory: true)
        try fm.createDirectory(at: external, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: root) }
        let file = external.appendingPathComponent("long-paper.molwork")
        let json = #"{"format":"molstudio-workbench","version":2,"ket":{"content":""# + String(repeating: "x", count: 5000) + #""},"document":{"mode":"paper"}}"#
        try json.write(to: file, atomically: true, encoding: .utf8)
        expect(WelcomeRecents.inspectModeQuickly(at: file, exists: true) == nil, "large v2 is unknown before verified metadata")
        let png = Data(base64Encoded:"iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGO4o6EBRAwQCgAjrgSxn17XlQAAAABJRU5ErkJggg==")!
        expect(WelcomeThumbnailCache.validPNG(png), "accept bounded real PNG")
        expect(!WelcomeThumbnailCache.validPNG(Data("not PNG".utf8)), "reject invalid PNG")
        let stamp = WelcomeThumbnailCache.stamp(file)!
        try WelcomeThumbnailCache.write(url:file, directory:cache, expectedStamp:stamp, mode:.paper, png:png)
        let item = WelcomeRecents.merge(recentURLs:[file], directoryURLs:[], thumbnailsDirectoryURL:cache).first!
        expect(item.mode == .paper && item.thumbnailURL != nil, "external recent reads cached paper mode and thumbnail")
        expect(item.thumbnailURL?.lastPathComponent == WelcomeRecents.sha1Hex(WelcomeRecents.canonicalPath(for:file)) + ".png", "canonical SHA-1 path")
        let copy = external.appendingPathComponent("save-as.molwork")
        try fm.copyItem(at:file, to:copy)
        WelcomeThumbnailCache.copy(from:file, to:copy, directory:cache)
        expect(WelcomeThumbnailCache.record(for:copy, directory:cache)?.mode == .paper, "same-snapshot save-as copies cache with target stamp")
        let renamed = external.appendingPathComponent("renamed.molwork")
        try fm.moveItem(at:copy, to:renamed)
        WelcomeThumbnailCache.copy(from:copy, to:renamed, directory:cache, renamed:true)
        expect(WelcomeThumbnailCache.record(for:renamed, directory:cache)?.mode == .paper, "rename migrates matching inode cache")
        expect(!fm.fileExists(atPath:WelcomeThumbnailCache.paths(for:copy,directory:cache).metadata.path), "rename removes old metadata")
        try (json + " ").write(to:file, atomically:true, encoding:.utf8)
        expect(WelcomeThumbnailCache.record(for:file, directory:cache) == nil, "external file change invalidates metadata")
        expect(WelcomeRecents.merge(recentURLs:[file], directoryURLs:[], thumbnailsDirectoryURL:cache).first?.thumbnailURL == nil, "stale cache is not displayed")
        do { try WelcomeThumbnailCache.write(url:file,directory:cache,expectedStamp:stamp,mode:.paper,png:png); expect(false,"stale write rejected") }
        catch { print("PASS: stale write rejected") }
        let newStamp = WelcomeThumbnailCache.stamp(file)!
        try WelcomeThumbnailCache.write(url:file,directory:cache,expectedStamp:newStamp,mode:.canvas,png:nil)
        let unknownImage = WelcomeRecents.merge(recentURLs:[file],directoryURLs:[],thumbnailsDirectoryURL:cache).first!
        expect(unknownImage.mode == .canvas && unknownImage.thumbnailURL == nil, "mode only does not revive old PNG")
    }
}

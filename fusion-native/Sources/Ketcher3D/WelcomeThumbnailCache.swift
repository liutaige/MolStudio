import Foundation
import ImageIO
import Darwin

/// Per-file thumbnail and mode metadata, bound to the on-disk file identity.
/// This cache never changes the source document and is safe to discard.
enum WelcomeThumbnailCache {
    struct Stamp: Codable, Equatable {
        let device: UInt64, inode: UInt64, size: Int64, seconds: Int64, nanoseconds: Int64
    }
    struct Record: Codable {
        let version: Int
        let stamp: Stamp
        let mode: WelcomeDocumentMode
        let hasThumbnail: Bool
    }
    static let maxPNGBytes = 8 * 1024 * 1024

    static func readBounded(_ url: URL, limit: Int) -> Data? {
        guard let handle = try? FileHandle(forReadingFrom: url) else { return nil }
        defer { try? handle.close() }
        guard let data = try? handle.read(upToCount: limit + 1), data.count <= limit else { return nil }
        return data
    }

    static func stamp(_ url: URL) -> Stamp? {
        var s = stat()
        guard stat(url.path, &s) == 0, (s.st_mode & S_IFMT) == S_IFREG else { return nil }
        return Stamp(device: UInt64(bitPattern: Int64(s.st_dev)), inode: UInt64(s.st_ino), size: Int64(s.st_size),
                     seconds: Int64(s.st_mtimespec.tv_sec), nanoseconds: Int64(s.st_mtimespec.tv_nsec))
    }
    static func paths(for url: URL, directory: URL) -> (png: URL, metadata: URL) {
        let key = WelcomeRecents.sha1Hex(WelcomeRecents.canonicalPath(for: url))
        return (directory.appendingPathComponent(key + ".png"), directory.appendingPathComponent(key + ".json"))
    }
    static func record(for url: URL, directory: URL) -> Record? {
        let path = paths(for: url, directory: directory).metadata
        guard let data = readBounded(path, limit: 4096),
              let record = try? JSONDecoder().decode(Record.self, from: data), record.version == 1,
              let current = stamp(url), current == record.stamp else { return nil }
        return record
    }
    static func validPNG(_ data: Data) -> Bool {
        guard !data.isEmpty, data.count <= maxPNGBytes,
              let source = CGImageSourceCreateWithData(data as CFData, nil),
              CGImageSourceGetType(source) as String? == "public.png",
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? Int,
              let height = properties[kCGImagePropertyPixelHeight] as? Int else { return false }
        return width > 0 && height > 0 && width <= 2048 && height <= 4096
    }
    /// Writes the mode even when there is no image (e.g. a blank canvas).
    static func write(url: URL, directory: URL, expectedStamp: Stamp, mode: WelcomeDocumentMode, png: Data?) throws {
        guard stamp(url) == expectedStamp else { throw CacheError.stale }
        if let png, !validPNG(png) { throw CacheError.invalidImage }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let paths = paths(for: url, directory: directory)
        if let png { try png.write(to: paths.png, options: .atomic) }
        guard stamp(url) == expectedStamp else { throw CacheError.stale }
        let record = Record(version: 1, stamp: expectedStamp, mode: mode, hasThumbnail: png != nil)
        try JSONEncoder().encode(record).write(to: paths.metadata, options: .atomic)
    }
    /// Copy only a cache verified against the source and only when the caller
    /// has established that both files represent the same saved snapshot.
    static func copy(from old: URL, to new: URL, directory: URL, renamed: Bool = false) {
        let oldPaths = paths(for: old, directory: directory)
        guard let bytes = readBounded(oldPaths.metadata, limit: 4096),
              let record = try? JSONDecoder().decode(Record.self, from: bytes), record.version == 1,
              let newStamp = stamp(new), (renamed ? newStamp == record.stamp : stamp(old) == record.stamp) else { return }
        let image = record.hasThumbnail ? readBounded(oldPaths.png, limit: maxPNGBytes) : nil
        guard !record.hasThumbnail || image.map(validPNG) == true else { return }
        do {
            try write(url: new, directory: directory, expectedStamp: newStamp, mode: record.mode, png: image)
            if renamed { try? FileManager.default.removeItem(at: oldPaths.png); try? FileManager.default.removeItem(at: oldPaths.metadata) }
        } catch { return }
    }
    enum CacheError: Error { case stale, invalidImage }
}

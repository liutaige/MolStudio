import AppKit
import CryptoKit
import Darwin
import Foundation

/// Document mode shown on the welcome screen and passed when creating a document.
enum WelcomeDocumentMode: String, Codable, CaseIterable, Equatable, Sendable {
    case canvas
    case paper

    var title: String {
        switch self {
        case .canvas: return "无边画布"
        case .paper: return "纸页文档"
        }
    }

    var badgeTitle: String {
        switch self {
        case .canvas: return "画布"
        case .paper: return "纸页"
        }
    }
}

/// Sidebar library category filtering existing recent documents without changing storage.
enum WelcomeLibraryCategory: String, CaseIterable, Identifiable, Equatable, Sendable {
    case recents
    case canvas
    case paper

    var id: String { rawValue }

    var title: String {
        switch self {
        case .recents: return "最近文件"
        case .canvas: return "无边画布"
        case .paper: return "纸页文档"
        }
    }

    var systemImage: String {
        switch self {
        case .recents: return "clock"
        case .canvas: return "square.dashed"
        case .paper: return "doc.richtext"
        }
    }

    func matches(_ item: WelcomeRecentItem) -> Bool {
        switch self {
        case .recents:
            return true
        case .canvas:
            return item.mode == .canvas
        case .paper:
            return item.mode == .paper
        }
    }
}

/// Supported physical paper sizes matching `fusion/workbench/document-model.js`.
enum WelcomePaperSize: String, Codable, CaseIterable, Identifiable, Equatable, Sendable {
    case a4 = "A4"
    case letter = "Letter"

    var id: String { rawValue }

    var title: String {
        switch self {
        case .a4: return "A4"
        case .letter: return "Letter"
        }
    }

    var portraitWidthPt: Double {
        switch self {
        case .a4: return 595.28
        case .letter: return 612.0
        }
    }

    var portraitHeightPt: Double {
        switch self {
        case .a4: return 841.89
        case .letter: return 792.0
        }
    }

    var dimensionsMMText: String {
        switch self {
        case .a4: return "210 × 297 mm"
        case .letter: return "216 × 279 mm"
        }
    }
}

/// Page orientation for paper documents.
enum WelcomePaperOrientation: String, Codable, CaseIterable, Identifiable, Equatable, Sendable {
    case portrait
    case landscape

    var id: String { rawValue }

    var title: String {
        switch self {
        case .portrait: return "纵向"
        case .landscape: return "横向"
        }
    }
}

/// Page margins in points (default 20 mm ≈ 56.7 pt).
struct WelcomePaperMargins: Codable, Equatable, Sendable {
    var top: Double
    var right: Double
    var bottom: Double
    var left: Double

    static let standard = WelcomePaperMargins(top: 56.7, right: 56.7, bottom: 56.7, left: 56.7)
}

/// Paper creation setup chosen on the welcome card and persisted across launches.
struct WelcomePaperSetup: Codable, Equatable, Sendable {
    var size: WelcomePaperSize
    var orientation: WelcomePaperOrientation
    var margins: WelcomePaperMargins
    var ptPerBond: Double

    init(
        size: WelcomePaperSize = .a4,
        orientation: WelcomePaperOrientation = .portrait,
        margins: WelcomePaperMargins = .standard,
        ptPerBond: Double = 14.4
    ) {
        self.size = size
        self.orientation = orientation
        self.margins = margins
        self.ptPerBond = ptPerBond
    }

    var widthPt: Double {
        orientation == .landscape ? size.portraitHeightPt : size.portraitWidthPt
    }

    var heightPt: Double {
        orientation == .landscape ? size.portraitWidthPt : size.portraitHeightPt
    }

    var summaryText: String {
        "\(size.title) · \(orientation.title)"
    }

    var detailText: String {
        "\(size.title) · \(orientation.title) · \(size.dimensionsMMText)"
    }

    /// Maps directly to the options accepted by `MolWorkbench.documentModel.createDocument(...)`
    /// and `MolStudio.document.init(...)`.
    func toDocumentInitPayload(pageCount: Int = 1) -> [String: Any] {
        [
            "mode": WelcomeDocumentMode.paper.rawValue,
            "size": size.rawValue,
            "orientation": orientation.rawValue,
            "ptPerBond": ptPerBond,
            "pageCount": max(1, pageCount),
            "margins": [
                "top": margins.top,
                "right": margins.right,
                "bottom": margins.bottom,
                "left": margins.left,
            ],
        ]
    }

    func toJSONString(pageCount: Int = 1) -> String? {
        let payload = toDocumentInitPayload(pageCount: pageCount)
        guard JSONSerialization.isValidJSONObject(payload),
              let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]) else {
            return nil
        }
        return String(data: data, encoding: .utf8)
    }
}

/// Display layout preference for the recent files section.
enum WelcomeRecentViewMode: String, Codable, CaseIterable, Identifiable, Equatable, Sendable {
    case list
    case grid

    var id: String { rawValue }

    var title: String {
        switch self {
        case .list: return "列表"
        case .grid: return "网格"
        }
    }

    var systemImage: String {
        switch self {
        case .list: return "list.bullet"
        case .grid: return "square.grid.2x2"
        }
    }
}

/// Host-supplied example document entry.
struct WelcomeExampleItem: Identifiable, Equatable, Sendable {
    let id: String
    let title: String
    let subtitle: String?

    init(id: String, title: String, subtitle: String? = nil) {
        self.id = id
        self.title = title
        self.subtitle = subtitle
    }
}

/// Normalized recent document entry displayed by the welcome screen.
struct WelcomeRecentItem: Identifiable, Equatable, Sendable {
    let id: String
    let url: URL
    let displayName: String
    let modifiedAt: Date?
    let exists: Bool
    let thumbnailURL: URL?
    let mode: WelcomeDocumentMode?

    var fileExtension: String {
        url.pathExtension.lowercased()
    }

    /// Parent directory path with user home abbreviated as `~`.
    var pathHint: String {
        let dir = url.deletingLastPathComponent().standardizedFileURL.path
        let home = FileManager.default.homeDirectoryForCurrentUser.standardizedFileURL.path
        if dir == home { return "~" }
        if dir.hasPrefix(home + "/") {
            return "~/" + String(dir.dropFirst(home.count + 1))
        }
        return dir
    }

    var typeLabel: String {
        if mode == .paper { return "纸页文档" }
        switch fileExtension {
        case "molwork": return mode == nil ? "MolStudio 文档" : "画布工作台"
        case "ket": return "KET 结构"
        case "mol": return "MOL 结构"
        case "sdf": return "SDF 结构"
        case "smi", "smiles": return "SMILES"
        case "cdxml": return "CDXML"
        default: return "化学文件"
        }
    }
}

/// Pure, read-only helper for scanning, deduplicating, and sorting recent chemical files.
enum WelcomeRecents {
    static let supportedExtensions: Set<String> = [
        "molwork", "ket", "mol", "sdf", "cdxml", "smi", "smiles",
    ]

    private static let molworkHeaderInspectLimit = 4096

    /// Resolves symlinks on the file or nearest existing ancestor so missing files
    /// (e.g. `/tmp/a.ket` vs `/private/tmp/a.ket`) produce a stable canonical path.
    static func canonicalPath(for url: URL) -> String {
        let fileURL = url.standardizedFileURL
        let fm = FileManager.default
        if fm.fileExists(atPath: fileURL.path) {
            return fileURL.resolvingSymlinksInPath().standardizedFileURL.path
        }

        var missingComponents: [String] = []
        var cursor = fileURL
        while cursor.path != "/" && !fm.fileExists(atPath: cursor.path) {
            missingComponents.append(cursor.lastPathComponent)
            let parent = cursor.deletingLastPathComponent()
            if parent.path == cursor.path { break }
            cursor = parent
        }
        var resolved = fm.fileExists(atPath: cursor.path)
            ? cursor.resolvingSymlinksInPath().standardizedFileURL
            : cursor.standardizedFileURL
        for component in missingComponents.reversed() {
            resolved.appendPathComponent(component)
        }
        return resolved.standardizedFileURL.path
    }

    /// Lists supported chemical files directly inside `directoryURL` using POSIX `opendir`/`readdir`
    /// to avoid Foundation `CFURLEnumerator` hangs while never touching subdirectories.
    static func scanDirectory(_ directoryURL: URL?) -> [URL] {
        guard let directoryURL else { return [] }
        guard let dp = opendir(directoryURL.path) else { return [] }
        defer { closedir(dp) }

        var urls: [URL] = []
        while let entry = readdir(dp) {
            let name = withUnsafeBytes(of: entry.pointee.d_name) { raw -> String in
                let ptr = raw.baseAddress!.assumingMemoryBound(to: CChar.self)
                return String(cString: ptr)
            }
            if name.isEmpty || name.hasPrefix(".") { continue }
            let ext = (name as NSString).pathExtension.lowercased()
            guard supportedExtensions.contains(ext) else { continue }

            let candidate = directoryURL.appendingPathComponent(name, isDirectory: false)
            var st = stat()
            if stat(candidate.path, &st) == 0, (st.st_mode & S_IFMT) == S_IFREG {
                urls.append(candidate)
            }
        }
        return urls
    }

    /// Only a complete, small workbench can be classified without guessing.
    /// Larger/truncated files may have `document` after KET or assets: leave unknown.
    static func inspectModeQuickly(at url: URL, exists: Bool) -> WelcomeDocumentMode? {
        guard exists else { return nil }
        let ext = url.pathExtension.lowercased()
        guard supportedExtensions.contains(ext) else { return nil }
        if ext != "molwork" { return .canvas }

        guard let handle = try? FileHandle(forReadingFrom: url) else { return nil }
        defer { try? handle.close() }
        guard let data = try? handle.read(upToCount: molworkHeaderInspectLimit + 1), !data.isEmpty,
              data.count <= molworkHeaderInspectLimit,
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              object["format"] as? String == "molstudio-workbench",
              let version = object["version"] as? NSNumber,
              String(cString: version.objCType) != "c" else { return nil }
        if version.doubleValue == 1 && object["document"] == nil { return .canvas }
        guard version.doubleValue == 2, let document = object["document"] as? [String: Any],
              let mode = document["mode"] as? String else { return nil }
        return WelcomeDocumentMode(rawValue: mode)
    }

    /// Computes `<sha1(canonicalFilePath)>.png` and returns it only when present and not older than the document.
    static func resolveThumbnailURL(
        for canonicalFilePath: String,
        modifiedAt: Date?,
        thumbnailsDirectoryURL: URL?
    ) -> URL? {
        guard let thumbnailsDirectoryURL else { return nil }
        let sha1 = sha1Hex(canonicalFilePath)
        let candidate = thumbnailsDirectoryURL.appendingPathComponent("\(sha1).png", isDirectory: false)
        let fileURL = URL(fileURLWithPath: canonicalFilePath)
        let metadata = thumbnailsDirectoryURL.appendingPathComponent("\(sha1).json", isDirectory: false)
        if FileManager.default.fileExists(atPath: metadata.path) {
            guard let record = WelcomeThumbnailCache.record(for: fileURL, directory: thumbnailsDirectoryURL), record.hasThumbnail,
                  let data = WelcomeThumbnailCache.readBounded(candidate, limit: WelcomeThumbnailCache.maxPNGBytes), WelcomeThumbnailCache.validPNG(data) else { return nil }
            return candidate
        }
        guard let values = try? candidate.resourceValues(forKeys: [.isRegularFileKey, .contentModificationDateKey]),
              values.isRegularFile == true else {
            return nil
        }
        if let modifiedAt, let thumbDate = values.contentModificationDate,
           thumbDate.timeIntervalSince1970 + 1.0 < modifiedAt.timeIntervalSince1970 {
            return nil
        }
        return candidate
    }

    static func sha1Hex(_ value: String) -> String {
        let digest = Insecure.SHA1.hash(data: Data(value.utf8))
        return digest.map { String(format: "%02x", $0) }.joined()
    }

    /// Merges `recentURLs` (e.g. `NSDocumentController.shared.recentDocumentURLs`) with `directoryURLs`
    /// (e.g. app documents folder), deduplicating by canonical path and sorting existing items by
    /// modification time descending, followed by missing items. Never modifies or deletes user files.
    static func merge(
        recentURLs: [URL],
        directoryURLs: [URL],
        thumbnailsDirectoryURL: URL? = nil,
        excludedCanonicalPaths: Set<String> = []
    ) -> [WelcomeRecentItem] {
        var seen = Set<String>()
        var collected: [(order: Int, item: WelcomeRecentItem)] = []
        var order = 0

        for rawURL in recentURLs + directoryURLs {
            guard rawURL.isFileURL else { continue }
            let ext = rawURL.pathExtension.lowercased()
            guard supportedExtensions.contains(ext) else { continue }

            let canonical = canonicalPath(for: rawURL)
            guard !excludedCanonicalPaths.contains(canonical) else { continue }
            guard seen.insert(canonical).inserted else { continue }

            let cleanURL = URL(fileURLWithPath: canonical)
            let metadata = inspectFileMetadata(at: cleanURL)
            let mode = inspectModeQuickly(at: cleanURL, exists: metadata.exists) ??
                (metadata.exists ? thumbnailsDirectoryURL.flatMap { WelcomeThumbnailCache.record(for: cleanURL, directory: $0)?.mode } : nil)
            let thumb = metadata.exists
                ? resolveThumbnailURL(
                    for: canonical,
                    modifiedAt: metadata.modifiedAt,
                    thumbnailsDirectoryURL: thumbnailsDirectoryURL
                )
                : nil

            let item = WelcomeRecentItem(
                id: canonical,
                url: cleanURL,
                displayName: cleanURL.lastPathComponent,
                modifiedAt: metadata.modifiedAt,
                exists: metadata.exists,
                thumbnailURL: thumb,
                mode: mode
            )
            collected.append((order, item))
            order += 1
        }

        collected.sort { lhs, rhs in
            let a = lhs.item
            let b = rhs.item
            if a.exists != b.exists {
                return a.exists && !b.exists
            }
            if a.exists && b.exists {
                let da = a.modifiedAt ?? .distantPast
                let db = b.modifiedAt ?? .distantPast
                if da != db { return da > db }
                let cmp = a.displayName.localizedStandardCompare(b.displayName)
                if cmp != .orderedSame { return cmp == .orderedAscending }
                return a.id < b.id
            }
            return lhs.order < rhs.order
        }

        return collected.map(\.item)
    }

    /// Scans `appDirectoryURL` and merges with `recentURLs` (defaulting to `NSDocumentController.shared.recentDocumentURLs`).
    static func loadMergedRecents(
        recentURLs: [URL]? = nil,
        appDirectoryURL: URL?,
        thumbnailsDirectoryURL: URL? = nil,
        excludedCanonicalPaths: Set<String> = []
    ) -> [WelcomeRecentItem] {
        let controllerURLs = recentURLs ?? NSDocumentController.shared.recentDocumentURLs
        let dirURLs = scanDirectory(appDirectoryURL)
        return merge(
            recentURLs: controllerURLs,
            directoryURLs: dirURLs,
            thumbnailsDirectoryURL: thumbnailsDirectoryURL,
            excludedCanonicalPaths: excludedCanonicalPaths
        )
    }

    private static func inspectFileMetadata(at url: URL) -> (exists: Bool, modifiedAt: Date?) {
        var st = stat()
        guard stat(url.path, &st) == 0, (st.st_mode & S_IFMT) == S_IFREG else {
            return (false, nil)
        }
        let values = try? url.resourceValues(forKeys: [.contentModificationDateKey])
        let date = values?.contentModificationDate ?? Date(timeIntervalSince1970: TimeInterval(st.st_mtimespec.tv_sec))
        return (true, date)
    }
}

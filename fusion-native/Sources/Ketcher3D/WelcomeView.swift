import AppKit
import Combine
import SwiftUI
import UniformTypeIdentifiers

// MARK: - ViewModel

/// State container and persistence manager for the standalone SwiftUI welcome library view.
final class WelcomeViewModel: ObservableObject {
    private enum Keys {
        static let paperSetup = "MolStudioWelcomePaperSetup"
        static let viewMode = "MolStudioWelcomeViewMode"
        static let removedRecents = "MolStudioWelcomeRemovedRecents"
        static let lastFile = "lastFile"
    }

    @Published var recentItems: [WelcomeRecentItem]
    @Published var selectedCategory: WelcomeLibraryCategory = .recents {
        didSet {
            if let current = selectedItemID, filteredRecentItems.contains(where: { $0.id == current }) {
                return
            }
            selectedItemID = filteredRecentItems.first?.id
        }
    }
    @Published var searchQuery: String = ""
    @Published var viewMode: WelcomeRecentViewMode {
        didSet { persistViewMode() }
    }
    @Published var paperSetup: WelcomePaperSetup {
        didSet { persistPaperSetup() }
    }
    @Published var examples: [WelcomeExampleItem]
    @Published var selectedItemID: String?

    private let defaults: UserDefaults
    private let appDirectoryURL: URL?
    private let thumbnailsDirectoryURL: URL?
    private let recentURLsProvider: () -> [URL]

    init(
        defaults: UserDefaults = .standard,
        appDirectoryURL: URL? = nil,
        thumbnailsDirectoryURL: URL? = nil,
        examples: [WelcomeExampleItem] = [],
        recentURLsProvider: @escaping () -> [URL] = { NSDocumentController.shared.recentDocumentURLs },
        initialRecentItems: [WelcomeRecentItem]? = nil
    ) {
        self.defaults = defaults
        self.appDirectoryURL = appDirectoryURL
        self.thumbnailsDirectoryURL = thumbnailsDirectoryURL
        self.examples = examples
        self.recentURLsProvider = recentURLsProvider
        self.paperSetup = Self.loadPaperSetup(from: defaults)
        self.viewMode = Self.loadViewMode(from: defaults)

        if let initialRecentItems {
            self.recentItems = initialRecentItems
        } else {
            let excluded = Self.loadRemovedCanonicalPaths(from: defaults)
            self.recentItems = WelcomeRecents.loadMergedRecents(
                recentURLs: recentURLsProvider(),
                appDirectoryURL: appDirectoryURL,
                thumbnailsDirectoryURL: thumbnailsDirectoryURL,
                excludedCanonicalPaths: excluded
            )
        }
        restoreLastSelection()
    }

    var categoryRecentItems: [WelcomeRecentItem] {
        recentItems.filter { selectedCategory.matches($0) }
    }

    var filteredRecentItems: [WelcomeRecentItem] {
        let categoryItems = categoryRecentItems
        let query = searchQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return categoryItems }
        return categoryItems.filter { item in
            item.displayName.localizedCaseInsensitiveContains(query)
                || item.pathHint.localizedCaseInsensitiveContains(query)
                || item.url.path.localizedCaseInsensitiveContains(query)
                || item.typeLabel.localizedCaseInsensitiveContains(query)
        }
    }

    func count(for category: WelcomeLibraryCategory) -> Int {
        recentItems.filter { category.matches($0) }.count
    }

    var isRecentsEmptyState: Bool {
        recentItems.isEmpty
    }

    var isCategoryEmptyState: Bool {
        !recentItems.isEmpty
            && searchQuery.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && filteredRecentItems.isEmpty
    }

    var isSearchEmptyState: Bool {
        !recentItems.isEmpty
            && !searchQuery.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && filteredRecentItems.isEmpty
    }

    var selectedItem: WelcomeRecentItem? {
        guard let selectedItemID else { return nil }
        return filteredRecentItems.first(where: { $0.id == selectedItemID })
            ?? recentItems.first(where: { $0.id == selectedItemID })
    }

    func reloadRecents(
        recentURLs: [URL]? = nil,
        appDirectoryURL: URL? = nil,
        thumbnailsDirectoryURL: URL? = nil
    ) {
        let excluded = Self.loadRemovedCanonicalPaths(from: defaults)
        let merged = WelcomeRecents.loadMergedRecents(
            recentURLs: recentURLs ?? recentURLsProvider(),
            appDirectoryURL: appDirectoryURL ?? self.appDirectoryURL,
            thumbnailsDirectoryURL: thumbnailsDirectoryURL ?? self.thumbnailsDirectoryURL,
            excludedCanonicalPaths: excluded
        )
        recentItems = merged
        restoreLastSelection()
    }

    /// Asynchronously scans and merges recent files off the main thread, then commits to `@Published recentItems`.
    func reloadRecentsAsync(
        recentURLs: [URL]? = nil,
        appDirectoryURL: URL? = nil,
        thumbnailsDirectoryURL: URL? = nil
    ) {
        let capturedRecents = recentURLs ?? recentURLsProvider()
        let capturedAppDir = appDirectoryURL ?? self.appDirectoryURL
        let capturedThumbDir = thumbnailsDirectoryURL ?? self.thumbnailsDirectoryURL
        let excluded = Self.loadRemovedCanonicalPaths(from: defaults)

        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let merged = WelcomeRecents.loadMergedRecents(
                recentURLs: capturedRecents,
                appDirectoryURL: capturedAppDir,
                thumbnailsDirectoryURL: capturedThumbDir,
                excludedCanonicalPaths: excluded
            )
            DispatchQueue.main.async {
                guard let self else { return }
                self.recentItems = merged
                self.restoreLastSelection()
            }
        }
    }

    func removeRecent(_ item: WelcomeRecentItem) {
        var excluded = Self.loadRemovedCanonicalPaths(from: defaults)
        excluded.insert(item.id)
        defaults.set(Array(excluded).sorted(), forKey: Keys.removedRecents)
        if let last = defaults.string(forKey: Keys.lastFile),
           WelcomeRecents.canonicalPath(for: URL(fileURLWithPath: last)) == item.id {
            defaults.removeObject(forKey: Keys.lastFile)
        }
        recentItems.removeAll { $0.id == item.id }
        if selectedItemID == item.id {
            selectedItemID = filteredRecentItems.first?.id
        }
    }

    func noteOpened(_ url: URL) {
        let canonical = WelcomeRecents.canonicalPath(for: url)
        var excluded = Self.loadRemovedCanonicalPaths(from: defaults)
        if excluded.remove(canonical) != nil {
            defaults.set(Array(excluded).sorted(), forKey: Keys.removedRecents)
        }
        defaults.set(canonical, forKey: Keys.lastFile)
        selectedItemID = canonical
    }

    func clearSearch() {
        searchQuery = ""
    }

    func selectPreviousOrNext(delta: Int) {
        let list = filteredRecentItems
        guard !list.isEmpty else { return }
        guard let currentID = selectedItemID,
              let index = list.firstIndex(where: { $0.id == currentID }) else {
            selectedItemID = delta >= 0 ? list.first?.id : list.last?.id
            return
        }
        let nextIndex = max(0, min(list.count - 1, index + delta))
        selectedItemID = list[nextIndex].id
    }

    private func restoreLastSelection() {
        let visible = filteredRecentItems
        if let selectedItemID, visible.contains(where: { $0.id == selectedItemID }) {
            return
        }
        if let last = defaults.string(forKey: Keys.lastFile), !last.isEmpty {
            let canonical = WelcomeRecents.canonicalPath(for: URL(fileURLWithPath: last))
            if visible.contains(where: { $0.id == canonical }) {
                selectedItemID = canonical
                return
            }
        }
        selectedItemID = visible.first?.id ?? recentItems.first?.id
    }

    private func persistPaperSetup() {
        if let data = try? JSONEncoder().encode(paperSetup) {
            defaults.set(data, forKey: Keys.paperSetup)
        }
    }

    private func persistViewMode() {
        defaults.set(viewMode.rawValue, forKey: Keys.viewMode)
    }

    private static func loadPaperSetup(from defaults: UserDefaults) -> WelcomePaperSetup {
        guard let data = defaults.data(forKey: Keys.paperSetup),
              let decoded = try? JSONDecoder().decode(WelcomePaperSetup.self, from: data) else {
            return WelcomePaperSetup(size: .a4, orientation: .portrait)
        }
        return decoded
    }

    private static func loadViewMode(from defaults: UserDefaults) -> WelcomeRecentViewMode {
        guard let raw = defaults.string(forKey: Keys.viewMode),
              let mode = WelcomeRecentViewMode(rawValue: raw) else {
            return .grid
        }
        return mode
    }

    private static func loadRemovedCanonicalPaths(from defaults: UserDefaults) -> Set<String> {
        Set(defaults.stringArray(forKey: Keys.removedRecents) ?? [])
    }
}

// MARK: - Adaptive Light / Dark Design Tokens

private enum WelcomePalette {
    private static func dynamic(light: NSColor, dark: NSColor) -> Color {
        Color(nsColor: NSColor(name: nil) { appearance in
            let match = appearance.bestMatch(from: [.darkAqua, .aqua])
            return match == .darkAqua ? dark : light
        })
    }

    private static func rgb(_ r: CGFloat, _ g: CGFloat, _ b: CGFloat, _ a: CGFloat = 1.0) -> NSColor {
        NSColor(srgbRed: r / 255.0, green: g / 255.0, blue: b / 255.0, alpha: a)
    }

    static let sidebarBg = dynamic(
        light: rgb(0xF3, 0xF4, 0xF6),
        dark: rgb(0x23, 0x25, 0x2A)
    )
    static let contentBg = dynamic(
        light: .white,
        dark: rgb(0x1A, 0x1C, 0x20)
    )
    static let cardSurface = dynamic(
        light: .white,
        dark: rgb(0x24, 0x26, 0x2B)
    )
    static let controlBg = dynamic(
        light: rgb(0xF7, 0xF8, 0xFA),
        dark: rgb(0x2B, 0x2E, 0x34)
    )
    static let thumbWellBg = dynamic(
        light: rgb(0xF4, 0xF6, 0xF9),
        dark: rgb(0x2B, 0x2E, 0x35)
    )
    static let paperSheetStroke = dynamic(
        light: rgb(0xD3, 0xDA, 0xE2),
        dark: rgb(0x45, 0x4A, 0x55)
    )
    static let textMain = dynamic(
        light: rgb(0x1C, 0x24, 0x30),
        dark: rgb(0xEC, 0xEF, 0xF4)
    )
    static let textMuted = dynamic(
        light: rgb(0x5E, 0x69, 0x77),
        dark: rgb(0xA2, 0xAA, 0xB8)
    )
    static let textHint = dynamic(
        light: rgb(0x7D, 0x87, 0x95),
        dark: rgb(0x7E, 0x86, 0x94)
    )
    static let border = dynamic(
        light: rgb(0xDE, 0xE3, 0xEB),
        dark: rgb(0x36, 0x3A, 0x44)
    )
    static let divider = dynamic(
        light: rgb(0xE8, 0xEC, 0xF1),
        dark: rgb(0x2F, 0x32, 0x3B)
    )
    static let accent = dynamic(
        light: rgb(0x16, 0x77, 0x82),
        dark: rgb(0x2E, 0xA8, 0xB5)
    )
    static let accentHover = dynamic(
        light: rgb(0x10, 0x5F, 0x69),
        dark: rgb(0x24, 0x8F, 0x9B)
    )
    static let selectedSidebarBg = dynamic(
        light: rgb(0x16, 0x77, 0x82, 0.12),
        dark: rgb(0x2E, 0xA8, 0xB5, 0.22)
    )
    static let selectedCardBg = dynamic(
        light: rgb(0x16, 0x77, 0x82, 0.06),
        dark: rgb(0x2E, 0xA8, 0xB5, 0.14)
    )
    static let selectedBorder = dynamic(
        light: rgb(0x16, 0x77, 0x82, 0.72),
        dark: rgb(0x3B, 0xB8, 0xC6, 0.85)
    )
    static let hoverBg = dynamic(
        light: NSColor.black.withAlphaComponent(0.038),
        dark: NSColor.white.withAlphaComponent(0.055)
    )
    static let countPillBg = dynamic(
        light: rgb(0xEA, 0xEE, 0xF3),
        dark: rgb(0x2E, 0x32, 0x3B)
    )
    static let paperBadgeBg = dynamic(
        light: rgb(0xE7, 0xF4, 0xF5),
        dark: rgb(0x1C, 0x35, 0x39)
    )
    static let canvasBadgeBg = dynamic(
        light: rgb(0xF0, 0xF3, 0xF7),
        dark: rgb(0x2E, 0x32, 0x3A)
    )
    static let error = dynamic(
        light: rgb(0xB4, 0x23, 0x32),
        dark: rgb(0xF8, 0x71, 0x71)
    )
    static let errorBg = dynamic(
        light: rgb(0xFD, 0xF2, 0xF2),
        dark: rgb(0x3A, 0x1F, 0x23)
    )
    static let errorBorder = dynamic(
        light: rgb(0xF3, 0xB7, 0xBD),
        dark: rgb(0x6E, 0x33, 0x3A)
    )
}

// MARK: - WelcomeView

/// Standalone SwiftUI welcome library inspired by Apple Freeform.
struct WelcomeView: View {
    @ObservedObject var model: WelcomeViewModel

    let onNewCanvas: () -> Void
    let onNewPaper: (WelcomePaperSetup) -> Void
    let onOpenPanel: () -> Void
    let onOpenURL: (URL) -> Void
    let onOpenExample: (WelcomeExampleItem) -> Void
    let onRemoveRecent: (WelcomeRecentItem) -> Void
    let onRequestRename: (WelcomeRecentItem) -> Void
    let onRevealInFinder: (WelcomeRecentItem) -> Void

    @State private var isDropTargeted = false
    @State private var showToolbarPaperPopover = false
    @State private var draftPaperSetup = WelcomePaperSetup()
    @FocusState private var searchFocused: Bool

    private static let sidebarWidth: CGFloat = 200

    private static let relativeFormatter: RelativeDateTimeFormatter = {
        let fmt = RelativeDateTimeFormatter()
        fmt.locale = Locale(identifier: "zh_Hans_CN")
        fmt.unitsStyle = .short
        return fmt
    }()

    private static let absoluteFormatter: DateFormatter = {
        let fmt = DateFormatter()
        fmt.locale = Locale(identifier: "zh_Hans_CN")
        fmt.dateStyle = .medium
        fmt.timeStyle = .short
        return fmt
    }()

    init(
        model: WelcomeViewModel,
        onNewCanvas: @escaping () -> Void,
        onNewPaper: @escaping (WelcomePaperSetup) -> Void,
        onOpenPanel: @escaping () -> Void,
        onOpenURL: @escaping (URL) -> Void,
        onOpenExample: @escaping (WelcomeExampleItem) -> Void,
        onRemoveRecent: @escaping (WelcomeRecentItem) -> Void,
        onRequestRename: @escaping (WelcomeRecentItem) -> Void,
        onRevealInFinder: @escaping (WelcomeRecentItem) -> Void
    ) {
        self.model = model
        self.onNewCanvas = onNewCanvas
        self.onNewPaper = onNewPaper
        self.onOpenPanel = onOpenPanel
        self.onOpenURL = onOpenURL
        self.onOpenExample = onOpenExample
        self.onRemoveRecent = onRemoveRecent
        self.onRequestRename = onRequestRename
        self.onRevealInFinder = onRevealInFinder
    }

    var body: some View {
        HStack(spacing: 0) {
            sidebarView
                .frame(width: Self.sidebarWidth)
                .frame(maxHeight: .infinity)
                .background(WelcomePalette.sidebarBg)

            Rectangle()
                .fill(WelcomePalette.divider)
                .frame(width: 1)
                .frame(maxHeight: .infinity)

            contentPane
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(WelcomePalette.contentBg)
        }
        .frame(minWidth: 700, minHeight: 460)
        .overlay(dropOverlay)
        .onDrop(of: [.fileURL], isTargeted: $isDropTargeted, perform: handleDrop(providers:))
    }

    // MARK: Left Navigation Sidebar

    private var sidebarView: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("文档库")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(WelcomePalette.textHint)
                .padding(.horizontal, 18)
                .padding(.top, 16)
                .padding(.bottom, 8)

            VStack(spacing: 3) {
                ForEach(WelcomeLibraryCategory.allCases) { category in
                    SidebarCategoryRow(
                        category: category,
                        count: model.count(for: category),
                        isSelected: model.selectedCategory == category
                    ) {
                        model.selectedCategory = category
                    }
                }
            }
            .padding(.horizontal, 10)

            Spacer(minLength: 12)

            if !model.examples.isEmpty {
                Rectangle()
                    .fill(WelcomePalette.divider)
                    .frame(height: 1)
                    .padding(.horizontal, 12)

                exampleEntryView
                    .padding(.horizontal, 10)
                    .padding(.vertical, 10)
            }
        }
    }

    @ViewBuilder
    private var exampleEntryView: some View {
        if model.examples.count == 1, let single = model.examples.first {
            Button {
                onOpenExample(single)
            } label: {
                exampleButtonLabel
            }
            .buttonStyle(SidebarActionRowStyle())
            .help(single.subtitle.map { "\(single.title) · \($0)" } ?? single.title)
            .accessibilityLabel("打开示例：\(single.title)")
        } else {
            Menu {
                ForEach(model.examples) { example in
                    Button {
                        onOpenExample(example)
                    } label: {
                        Text(example.subtitle.map { "\(example.title) — \($0)" } ?? example.title)
                    }
                }
            } label: {
                exampleButtonLabel
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .padding(.horizontal, 10)
            .padding(.vertical, 7)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
            .accessibilityLabel("打开示例")
        }
    }

    private var exampleButtonLabel: some View {
        HStack(spacing: 8) {
            Image(systemName: "sparkles")
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(WelcomePalette.accent)
                .frame(width: 18)
            Text("打开示例")
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(WelcomePalette.textMain)
                .lineLimit(1)
            Spacer()
        }
    }

    // MARK: Right Content Area

    private var contentPane: some View {
        GeometryReader { geo in
            let compactToolbar = geo.size.width < 580
            VStack(spacing: 0) {
                toolbarSection(width: geo.size.width, compact: compactToolbar)
                    .padding(.horizontal, compactToolbar ? 16 : 22)
                    .padding(.top, 14)
                    .padding(.bottom, 12)

                Rectangle()
                    .fill(WelcomePalette.divider)
                    .frame(height: 1)

                mainFileArea(compact: compactToolbar)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
    }

    @ViewBuilder
    private func toolbarSection(width: CGFloat, compact: Bool) -> some View {
        if compact {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 8) {
                    categoryHeading
                    Spacer(minLength: 8)
                    newMenuButton
                    openFileButton
                    viewModeToggle
                }

                searchField
                    .frame(maxWidth: .infinity)
            }
        } else {
            let searchWidth = min(210, max(144, width * 0.24))
            HStack(spacing: 10) {
                categoryHeading
                Spacer(minLength: 8)
                newMenuButton
                openFileButton
                viewModeToggle
                searchField
                    .frame(width: searchWidth)
            }
        }
    }

    private var categoryHeading: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(model.selectedCategory.title)
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(WelcomePalette.textMain)
                .lineLimit(1)
                .fixedSize(horizontal: true, vertical: false)

            Text("\(model.filteredRecentItems.count)")
                .font(.system(size: 12, weight: .medium).monospacedDigit())
                .foregroundStyle(WelcomePalette.textMuted)
                .padding(.horizontal, 7)
                .padding(.vertical, 2)
                .background(WelcomePalette.countPillBg)
                .clipShape(Capsule())
                .accessibilityLabel("当前显示 \(model.filteredRecentItems.count) 项")
        }
        .accessibilityElement(children: .combine)
    }

    private var newMenuButton: some View {
        WelcomeNewDocumentMenuButton(
            isPaperPopoverPresented: $showToolbarPaperPopover,
            draftPaperSetup: $draftPaperSetup,
            onNewCanvas: onNewCanvas,
            onPreparePaperPopover: openToolbarPaperSetupPopover,
            onConfirmPaper: { confirmed in
                model.paperSetup = confirmed
                showToolbarPaperPopover = false
                onNewPaper(confirmed)
            }
        )
    }

    private struct WelcomeNewDocumentMenuButton: View {
        @Binding var isPaperPopoverPresented: Bool
        @Binding var draftPaperSetup: WelcomePaperSetup
        let onNewCanvas: () -> Void
        let onPreparePaperPopover: () -> Void
        let onConfirmPaper: (WelcomePaperSetup) -> Void

        @State private var anchorBox = WelcomeMenuAnchorBox()

        var body: some View {
            Button {
                presentMenu()
            } label: {
                HStack(spacing: 5) {
                    Image(systemName: "plus")
                        .font(.system(size: 11.5, weight: .semibold))
                    Text("新建")
                        .font(.system(size: 12.5, weight: .medium))
                    Image(systemName: "chevron.down")
                        .font(.system(size: 9, weight: .semibold))
                        .opacity(0.88)
                }
                .foregroundStyle(.white)
                .padding(.horizontal, 11)
                .padding(.vertical, 6)
                .contentShape(Rectangle())
            }
            .buttonStyle(WelcomeToolbarAccentPillButtonStyle())
            .background(
                WelcomeMenuAnchorBridge(box: anchorBox)
                    .allowsHitTesting(false)
            )
            .fixedSize()
            .accessibilityLabel("新建文档")
            .accessibilityHint("打开新建无边画布或新建纸页菜单")
            .popover(isPresented: $isPaperPopoverPresented, arrowEdge: .bottom) {
                WelcomePaperSetupPopover(
                    setup: $draftPaperSetup,
                    onCancel: {
                        isPaperPopoverPresented = false
                    },
                    onConfirm: onConfirmPaper
                )
            }
        }

        private func presentMenu() {
            let menu = NSMenu(title: "新建文档")
            menu.autoenablesItems = false
            menu.addItem(WelcomeClosureMenuItem(title: "新建无边画布", symbolName: "square.dashed") {
                DispatchQueue.main.async {
                    onNewCanvas()
                }
            })
            menu.addItem(WelcomeClosureMenuItem(title: "新建纸页…", symbolName: "doc.richtext") {
                DispatchQueue.main.async {
                    onPreparePaperPopover()
                }
            })
            if let anchor = anchorBox.view, anchor.window != nil {
                let y = anchor.isFlipped ? anchor.bounds.maxY + 4 : -4
                menu.popUp(positioning: nil, at: NSPoint(x: 0, y: y), in: anchor)
            } else if let contentView = NSApp.keyWindow?.contentView {
                let pt = NSPoint(x: contentView.bounds.midX, y: contentView.bounds.midY)
                menu.popUp(positioning: nil, at: pt, in: contentView)
            }
        }
    }

    private final class WelcomeMenuAnchorBox {
        weak var view: NSView?
    }

    private struct WelcomeMenuAnchorBridge: NSViewRepresentable {
        let box: WelcomeMenuAnchorBox

        func makeNSView(context: Context) -> NSView {
            let view = NSView(frame: .zero)
            box.view = view
            return view
        }

        func updateNSView(_ nsView: NSView, context: Context) {
            box.view = nsView
        }
    }

    private struct WelcomeToolbarAccentPillButtonStyle: ButtonStyle {
        func makeBody(configuration: Configuration) -> some View {
            configuration.label
                .background(
                    RoundedRectangle(cornerRadius: 6, style: .continuous)
                        .fill(WelcomePalette.accent.opacity(configuration.isPressed ? 0.82 : 1.0))
                )
                .contentShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
        }
    }

    private final class WelcomeClosureMenuItem: NSMenuItem {
        private let handler: () -> Void

        init(title: String, symbolName: String, handler: @escaping () -> Void) {
            self.handler = handler
            super.init(title: title, action: #selector(handleAction), keyEquivalent: "")
            target = self
            if let icon = NSImage(systemSymbolName: symbolName, accessibilityDescription: nil) {
                icon.isTemplate = true
                image = icon
            }
        }

        @available(*, unavailable)
        required init(coder: NSCoder) {
            fatalError("init(coder:) has not been implemented")
        }

        @objc private func handleAction() {
            handler()
        }
    }

    private var openFileButton: some View {
        Button(action: onOpenPanel) {
            Label("打开…", systemImage: "folder")
                .lineLimit(1)
        }
        .buttonStyle(WelcomeToolbarSecondaryButtonStyle())
        .fixedSize()
        .accessibilityLabel("打开文件")
        .accessibilityHint("打开文件选择面板")
    }

    private var viewModeToggle: some View {
        WelcomeSegmentedControl(
            options: [WelcomeRecentViewMode.grid, .list].map { ($0, $0.title, $0.systemImage) },
            selection: $model.viewMode,
            iconOnly: true,
            accessibilityLabel: "视图模式切换"
        )
        .fixedSize()
    }

    private var searchField: some View {
        HStack(spacing: 6) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(WelcomePalette.textHint)
                .accessibilityHidden(true)

            TextField("搜索", text: $model.searchQuery)
                .textFieldStyle(.plain)
                .font(.system(size: 12.5))
                .foregroundStyle(WelcomePalette.textMain)
                .focused($searchFocused)
                .accessibilityLabel("搜索最近文件")
                .onSubmit {
                    if let first = model.filteredRecentItems.first, first.exists {
                        openItem(first)
                    }
                }

            if !model.searchQuery.isEmpty {
                Button {
                    model.clearSearch()
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 12))
                        .foregroundStyle(WelcomePalette.textHint)
                }
                .buttonStyle(.plain)
                .help("清除搜索")
                .accessibilityLabel("清除搜索")
            }
        }
        .padding(.horizontal, 9)
        .padding(.vertical, 5.5)
        .background(WelcomePalette.controlBg)
        .overlay(
            RoundedRectangle(cornerRadius: 6, style: .continuous)
                .stroke(searchFocused ? WelcomePalette.accent : WelcomePalette.border, lineWidth: searchFocused ? 1.25 : 0.75)
        )
        .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
    }

    // MARK: File Library Area & Empty States

    @ViewBuilder
    private func mainFileArea(compact: Bool) -> some View {
        if model.isRecentsEmptyState {
            emptyRecentsView
        } else if model.isSearchEmptyState {
            emptySearchView
        } else if model.isCategoryEmptyState {
            emptyCategoryView
        } else if model.viewMode == .grid {
            recentGridView(compact: compact)
        } else {
            recentListView(compact: compact)
        }
    }

    private func recentGridView(compact: Bool) -> some View {
        ScrollView {
            LazyVGrid(
                columns: [GridItem(.adaptive(minimum: 220, maximum: 268), spacing: 16)],
                alignment: .leading,
                spacing: 16
            ) {
                ForEach(model.filteredRecentItems) { item in
                    WelcomeRecentGridCard(
                        item: item,
                        isSelected: model.selectedItemID == item.id,
                        dateText: formattedDate(item.modifiedAt),
                        onSelect: { model.selectedItemID = item.id },
                        onOpen: { openItem(item) },
                        onRemove: { removeItem(item) }
                    )
                    .contextMenu {
                        recentContextMenu(for: item)
                    }
                }
            }
            .padding(.horizontal, compact ? 16 : 22)
            .padding(.vertical, 18)
        }
        .focusable()
        .focusEffectDisabled()
        .onMoveCommand { direction in
            switch direction {
            case .left, .up: model.selectPreviousOrNext(delta: -1)
            case .right, .down: model.selectPreviousOrNext(delta: 1)
            default: break
            }
        }
        .onKeyPress(.return) {
            if let item = model.selectedItem, item.exists {
                openItem(item)
                return .handled
            }
            return .ignored
        }
    }

    private func recentListView(compact: Bool) -> some View {
        ScrollView {
            LazyVStack(spacing: 2) {
                ForEach(Array(model.filteredRecentItems.enumerated()), id: \.element.id) { index, item in
                    WelcomeRecentRow(
                        item: item,
                        isSelected: model.selectedItemID == item.id,
                        dateText: formattedDate(item.modifiedAt),
                        onSelect: { model.selectedItemID = item.id },
                        onOpen: { openItem(item) },
                        onRemove: { removeItem(item) }
                    )
                    .contextMenu {
                        recentContextMenu(for: item)
                    }

                    if index < model.filteredRecentItems.count - 1 {
                        Rectangle()
                            .fill(WelcomePalette.divider)
                            .frame(height: 1)
                            .padding(.leading, 68)
                    }
                }
            }
            .padding(.horizontal, compact ? 10 : 14)
            .padding(.vertical, 10)
        }
        .focusable()
        .focusEffectDisabled()
        .onMoveCommand { direction in
            switch direction {
            case .up: model.selectPreviousOrNext(delta: -1)
            case .down: model.selectPreviousOrNext(delta: 1)
            default: break
            }
        }
        .onKeyPress(.return) {
            if let item = model.selectedItem, item.exists {
                openItem(item)
                return .handled
            }
            return .ignored
        }
    }

    private var emptyRecentsView: some View {
        VStack(spacing: 14) {
            Image(systemName: "doc.on.doc")
                .font(.system(size: 32, weight: .light))
                .foregroundStyle(WelcomePalette.textHint)
                .accessibilityHidden(true)

            VStack(spacing: 5) {
                Text("暂无最近文件")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(WelcomePalette.textMain)

                Text("新建无边画布或纸页文档，或从本地打开 .molwork、.ket、.mol 等化学文件，也支持直接拖放到此窗口。")
                    .font(.system(size: 12.5))
                    .foregroundStyle(WelcomePalette.textMuted)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 420)
            }

            HStack(spacing: 10) {
                Button(action: onNewCanvas) {
                    Label("新建无边画布", systemImage: "square.dashed")
                }
                .buttonStyle(WelcomePrimaryButtonStyle())

                WelcomeNewPaperTriggerButton(
                    title: "新建纸页",
                    systemImage: "doc.richtext",
                    usePrimaryStyle: false,
                    model: model,
                    onConfirm: onNewPaper
                )

                Button(action: onOpenPanel) {
                    Label("打开文件", systemImage: "folder")
                }
                .buttonStyle(WelcomeSecondaryButtonStyle())
            }
            .padding(.top, 2)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(24)
    }

    private var emptyCategoryView: some View {
        VStack(spacing: 12) {
            Image(systemName: model.selectedCategory.systemImage)
                .font(.system(size: 30, weight: .light))
                .foregroundStyle(WelcomePalette.textHint)
                .accessibilityHidden(true)

            VStack(spacing: 4) {
                Text("暂无\(model.selectedCategory.title)")
                    .font(.system(size: 14.5, weight: .semibold))
                    .foregroundStyle(WelcomePalette.textMain)

                Text("最近记录中还没有该类型的文档，可以点击右上角“新建”创建，或返回查看全部最近文件。")
                    .font(.system(size: 12.5))
                    .foregroundStyle(WelcomePalette.textMuted)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 380)
            }

            HStack(spacing: 10) {
                if model.selectedCategory == .canvas {
                    Button("新建无边画布", action: onNewCanvas)
                        .buttonStyle(WelcomePrimaryButtonStyle())
                } else if model.selectedCategory == .paper {
                    WelcomeNewPaperTriggerButton(
                        title: "新建纸页",
                        systemImage: nil,
                        usePrimaryStyle: true,
                        model: model,
                        onConfirm: onNewPaper
                    )
                }

                Button("查看最近文件") {
                    model.selectedCategory = .recents
                }
                .buttonStyle(WelcomeSecondaryButtonStyle())
            }
            .padding(.top, 2)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(24)
    }

    private var emptySearchView: some View {
        VStack(spacing: 12) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 28, weight: .light))
                .foregroundStyle(WelcomePalette.textHint)
                .accessibilityHidden(true)

            VStack(spacing: 4) {
                Text("未找到匹配文件")
                    .font(.system(size: 14.5, weight: .semibold))
                    .foregroundStyle(WelcomePalette.textMain)

                Text("在“\(model.selectedCategory.title)”中没有找到与“\(model.searchQuery)”匹配的名称或路径")
                    .font(.system(size: 12.5))
                    .foregroundStyle(WelcomePalette.textMuted)
                    .lineLimit(2)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 400)
            }

            HStack(spacing: 10) {
                Button("清除搜索") {
                    model.clearSearch()
                }
                .buttonStyle(WelcomeSecondaryButtonStyle())

                if model.selectedCategory != .recents {
                    Button("切换到最近文件") {
                        model.selectedCategory = .recents
                    }
                    .buttonStyle(WelcomeSecondaryButtonStyle())
                }
            }
            .padding(.top, 2)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(24)
    }

    @ViewBuilder
    private func recentContextMenu(for item: WelcomeRecentItem) -> some View {
        Button("打开") {
            openItem(item)
        }
        .disabled(!item.exists)

        Button("在 Finder 中显示") {
            onRevealInFinder(item)
        }
        .disabled(!item.exists)

        Button("重命名…") {
            onRequestRename(item)
        }
        .disabled(!item.exists)

        Divider()

        Button("从最近列表移除") {
            removeItem(item)
        }
    }

    private var dropOverlay: some View {
        Group {
            if isDropTargeted {
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(WelcomePalette.selectedCardBg)
                    .overlay(
                        RoundedRectangle(cornerRadius: 10, style: .continuous)
                            .strokeBorder(style: StrokeStyle(lineWidth: 2, dash: [6, 4]))
                            .foregroundStyle(WelcomePalette.accent)
                    )
                    .overlay(
                        VStack(spacing: 6) {
                            Image(systemName: "arrow.down.doc")
                                .font(.system(size: 26, weight: .medium))
                                .foregroundStyle(WelcomePalette.accent)
                            Text("松开以打开文件")
                                .font(.system(size: 13.5, weight: .semibold))
                                .foregroundStyle(WelcomePalette.textMain)
                        }
                    )
                    .padding(10)
                    .allowsHitTesting(false)
            }
        }
    }

    // MARK: Actions & Formatting

    private func openToolbarPaperSetupPopover() {
        draftPaperSetup = model.paperSetup
        DispatchQueue.main.async {
            showToolbarPaperPopover = true
        }
    }

    private func openItem(_ item: WelcomeRecentItem) {
        guard item.exists else { return }
        model.noteOpened(item.url)
        onOpenURL(item.url)
    }

    private func removeItem(_ item: WelcomeRecentItem) {
        model.removeRecent(item)
        onRemoveRecent(item)
    }

    private func formattedDate(_ date: Date?) -> String {
        guard let date else { return "—" }
        let delta = Date().timeIntervalSince(date)
        if abs(delta) < 7 * 24 * 3600 {
            return Self.relativeFormatter.localizedString(for: date, relativeTo: Date())
        }
        return Self.absoluteFormatter.string(from: date)
    }

    private func handleDrop(providers: [NSItemProvider]) -> Bool {
        guard let provider = providers.first(where: { $0.canLoadObject(ofClass: URL.self) }) else {
            return false
        }
        _ = provider.loadObject(ofClass: URL.self) { url, _ in
            guard let url, url.isFileURL else { return }
            let ext = url.pathExtension.lowercased()
            guard WelcomeRecents.supportedExtensions.contains(ext) else { return }
            DispatchQueue.main.async {
                model.noteOpened(url)
                onOpenURL(url)
            }
        }
        return true
    }
}

// MARK: - Subviews

private struct SidebarCategoryRow: View {
    let category: WelcomeLibraryCategory
    let count: Int
    let isSelected: Bool
    let action: () -> Void

    @State private var isHovered = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Image(systemName: category.systemImage)
                    .font(.system(size: 13.5, weight: isSelected ? .semibold : .regular))
                    .foregroundStyle(isSelected ? WelcomePalette.accent : WelcomePalette.textMuted)
                    .frame(width: 18)

                Text(category.title)
                    .font(.system(size: 13, weight: isSelected ? .semibold : .regular))
                    .foregroundStyle(isSelected ? WelcomePalette.textMain : WelcomePalette.textMuted)
                    .lineLimit(1)

                Spacer(minLength: 6)

                Text("\(count)")
                    .font(.system(size: 11.5, weight: .medium).monospacedDigit())
                    .foregroundStyle(isSelected ? WelcomePalette.accent : WelcomePalette.textHint)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6.5)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: 7, style: .continuous)
                    .fill(backgroundColor)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { isHovered = $0 }
        .accessibilityLabel("\(category.title)，\(count) 项")
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }

    private var backgroundColor: Color {
        if isSelected { return WelcomePalette.selectedSidebarBg }
        if isHovered { return WelcomePalette.hoverBg }
        return .clear
    }
}

private struct SidebarActionRowStyle: ButtonStyle {
    @State private var isHovered = false

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .padding(.horizontal, 10)
            .padding(.vertical, 7)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: 7, style: .continuous)
                    .fill(configuration.isPressed || isHovered ? WelcomePalette.hoverBg : .clear)
            )
            .contentShape(Rectangle())
            .onHover { isHovered = $0 }
    }
}

private struct WelcomeNewPaperTriggerButton: View {
    let title: String
    let systemImage: String?
    let usePrimaryStyle: Bool
    @ObservedObject var model: WelcomeViewModel
    let onConfirm: (WelcomePaperSetup) -> Void

    @State private var isPresented = false
    @State private var draftSetup = WelcomePaperSetup()

    var body: some View {
        Group {
            if usePrimaryStyle {
                buttonContent
                    .buttonStyle(WelcomePrimaryButtonStyle())
            } else {
                buttonContent
                    .buttonStyle(WelcomeSecondaryButtonStyle())
            }
        }
        .popover(isPresented: $isPresented, arrowEdge: .bottom) {
            WelcomePaperSetupPopover(
                setup: $draftSetup,
                onCancel: { isPresented = false },
                onConfirm: { confirmed in
                    model.paperSetup = confirmed
                    isPresented = false
                    onConfirm(confirmed)
                }
            )
        }
    }

    private var buttonContent: some View {
        Button {
            draftSetup = model.paperSetup
            isPresented = true
        } label: {
            if let systemImage {
                Label(title, systemImage: systemImage)
            } else {
                Text(title)
            }
        }
    }
}

private struct WelcomePaperSetupPopover: View {
    @Binding var setup: WelcomePaperSetup
    let onCancel: () -> Void
    let onConfirm: (WelcomePaperSetup) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 3) {
                Text("新建纸页文档")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(WelcomePalette.textMain)
                Text(setup.detailText)
                    .font(.system(size: 11.5))
                    .foregroundStyle(WelcomePalette.textMuted)
            }

            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Text("纸张尺寸")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(WelcomePalette.textMuted)
                        .frame(width: 62, alignment: .leading)

                    WelcomeSegmentedControl(
                        options: WelcomePaperSize.allCases.map { ($0, $0.title, nil) },
                        selection: $setup.size,
                        iconOnly: false,
                        accessibilityLabel: "纸张尺寸"
                    )
                }

                HStack {
                    Text("页面方向")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(WelcomePalette.textMuted)
                        .frame(width: 62, alignment: .leading)

                    WelcomeSegmentedControl(
                        options: WelcomePaperOrientation.allCases.map { ($0, $0.title, nil) },
                        selection: $setup.orientation,
                        iconOnly: false,
                        accessibilityLabel: "纸张方向"
                    )
                }
            }

            HStack {
                Spacer()
                Button("取消", action: onCancel)
                    .buttonStyle(WelcomeSecondaryButtonStyle())
                    .keyboardShortcut(.cancelAction)

                Button("新建纸页") {
                    onConfirm(setup)
                }
                .buttonStyle(WelcomePrimaryButtonStyle())
                .keyboardShortcut(.defaultAction)
            }
        }
        .padding(16)
        .frame(width: 280)
    }
}

private struct WelcomeRecentRow: View {
    let item: WelcomeRecentItem
    let isSelected: Bool
    let dateText: String
    let onSelect: () -> Void
    let onOpen: () -> Void
    let onRemove: () -> Void

    @State private var isHovered = false

    var body: some View {
        HStack(spacing: 12) {
            WelcomeThumbnailPreview(item: item, compact: true)
                .frame(width: 48, height: 34)
                .clipShape(RoundedRectangle(cornerRadius: 5, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 5, style: .continuous)
                        .stroke(WelcomePalette.border, lineWidth: 0.75)
                )

            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(item.displayName)
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(item.exists ? WelcomePalette.textMain : WelcomePalette.textHint)
                        .lineLimit(1)
                        .truncationMode(.middle)

                    WelcomeModeBadge(item: item)
                }

                Text(item.pathHint)
                    .font(.system(size: 11))
                    .foregroundStyle(WelcomePalette.textHint)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }

            Spacer(minLength: 8)

            if item.exists {
                Text(dateText)
                    .font(.system(size: 11.5).monospacedDigit())
                    .foregroundStyle(WelcomePalette.textMuted)
                    .lineLimit(1)
            } else {
                HStack(spacing: 6) {
                    Text("文件不存在")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(WelcomePalette.error)
                        .padding(.horizontal, 7)
                        .padding(.vertical, 2)
                        .background(WelcomePalette.errorBg)
                        .overlay(
                            RoundedRectangle(cornerRadius: 4, style: .continuous)
                                .stroke(WelcomePalette.errorBorder, lineWidth: 0.75)
                        )
                        .clipShape(RoundedRectangle(cornerRadius: 4, style: .continuous))

                    Button("移除", action: onRemove)
                        .buttonStyle(.plain)
                        .font(.system(size: 11.5, weight: .medium))
                        .foregroundStyle(WelcomePalette.accent)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 3)
                        .accessibilityLabel("从最近列表移除 \(item.displayName)")
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(
            RoundedRectangle(cornerRadius: 7, style: .continuous)
                .fill(rowBackground)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 7, style: .continuous)
                .stroke(isSelected ? WelcomePalette.selectedBorder : .clear, lineWidth: 1)
        )
        .contentShape(Rectangle())
        .opacity(item.exists ? 1.0 : 0.8)
        .onHover { isHovered = $0 }
        .onTapGesture(count: 2) {
            onSelect()
            onOpen()
        }
        .onTapGesture(count: 1) {
            onSelect()
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityDescription)
        .accessibilityHint(item.exists ? "双击打开文件，或右键查看更多操作" : "原文件已缺失，不可打开，可从最近列表移除")
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }

    private var rowBackground: Color {
        if isSelected { return WelcomePalette.selectedCardBg }
        if isHovered { return WelcomePalette.hoverBg }
        return .clear
    }

    private var accessibilityDescription: String {
        if item.exists {
            return "\(item.displayName)，\(item.typeLabel)，位于 \(item.pathHint)，修改于 \(dateText)"
        }
        return "\(item.displayName)，文件不存在，原路径 \(item.pathHint)"
    }
}

private struct WelcomeRecentGridCard: View {
    let item: WelcomeRecentItem
    let isSelected: Bool
    let dateText: String
    let onSelect: () -> Void
    let onOpen: () -> Void
    let onRemove: () -> Void

    @State private var isHovered = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            WelcomeThumbnailPreview(item: item)
                .frame(height: 142)
                .frame(maxWidth: .infinity)
                .clipShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 7, style: .continuous)
                        .stroke(WelcomePalette.divider, lineWidth: 0.75)
                )

            VStack(alignment: .leading, spacing: 5) {
                Text(item.displayName)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(item.exists ? WelcomePalette.textMain : WelcomePalette.textHint)
                    .lineLimit(1)
                    .truncationMode(.middle)

                HStack(spacing: 6) {
                    WelcomeModeBadge(item: item)

                    Text(item.exists ? dateText : "文件不存在")
                        .font(.system(size: 11).monospacedDigit())
                        .foregroundStyle(item.exists ? WelcomePalette.textMuted : WelcomePalette.error)
                        .lineLimit(1)

                    Spacer(minLength: 4)

                    if !item.exists {
                        Button("移除", action: onRemove)
                            .buttonStyle(.plain)
                            .font(.system(size: 11, weight: .medium))
                            .foregroundStyle(WelcomePalette.accent)
                            .accessibilityLabel("从最近列表移除 \(item.displayName)")
                    }
                }
            }
        }
        .padding(10)
        .background(cardBackground)
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .stroke(isSelected ? WelcomePalette.selectedBorder : WelcomePalette.border, lineWidth: isSelected ? 1.5 : 0.75)
        )
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .contentShape(Rectangle())
        .opacity(item.exists ? 1.0 : 0.84)
        .onHover { isHovered = $0 }
        .onTapGesture(count: 2) {
            onSelect()
            onOpen()
        }
        .onTapGesture(count: 1) {
            onSelect()
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(item.exists ? "\(item.displayName)，\(item.typeLabel)，修改于 \(dateText)" : "\(item.displayName)，文件不存在")
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }

    private var cardBackground: Color {
        if isSelected { return WelcomePalette.selectedCardBg }
        if isHovered { return WelcomePalette.hoverBg }
        return WelcomePalette.cardSurface
    }
}

private struct WelcomeModeBadge: View {
    let item: WelcomeRecentItem

    var body: some View {
        let label = item.exists
            ? (item.mode?.badgeTitle ?? (item.fileExtension.isEmpty ? "文件" : item.fileExtension.uppercased()))
            : "缺失"
        let fg: Color = item.exists
            ? (item.mode == .paper ? WelcomePalette.accent : WelcomePalette.textMuted)
            : WelcomePalette.error
        let bg: Color = item.exists
            ? (item.mode == .paper ? WelcomePalette.paperBadgeBg : WelcomePalette.canvasBadgeBg)
            : WelcomePalette.errorBg

        Text(label)
            .font(.system(size: 10, weight: .medium))
            .foregroundStyle(fg)
            .padding(.horizontal, 5.5)
            .padding(.vertical, 1.5)
            .background(bg)
            .clipShape(RoundedRectangle(cornerRadius: 4, style: .continuous))
    }
}

private struct WelcomeThumbnailPreview: View {
    let item: WelcomeRecentItem
    var compact: Bool = false

    var body: some View {
        if item.exists, let thumbURL = item.thumbnailURL, let nsImage = NSImage(contentsOf: thumbURL) {
            ZStack {
                Color.white
                Image(nsImage: nsImage)
                    .resizable()
                    .scaledToFit()
                    .padding(compact ? 2 : 6)
            }
        } else if !item.exists {
            ZStack {
                WelcomePalette.errorBg
                Image(systemName: "exclamationmark.triangle")
                    .font(.system(size: compact ? 14 : 18, weight: .medium))
                    .foregroundStyle(WelcomePalette.error)
            }
        } else if item.mode == .paper {
            ZStack {
                WelcomePalette.thumbWellBg
                RoundedRectangle(cornerRadius: compact ? 1.5 : 2.5, style: .continuous)
                    .fill(Color.white)
                    .aspectRatio(0.72, contentMode: .fit)
                    .padding(compact ? 4 : 8)
                    .overlay(
                        RoundedRectangle(cornerRadius: compact ? 1.5 : 2.5, style: .continuous)
                            .stroke(WelcomePalette.paperSheetStroke, lineWidth: 0.75)
                            .padding(compact ? 4 : 8)
                    )
                    .overlay(
                        VStack(spacing: compact ? 2 : 4) {
                            Image(systemName: "hexagon")
                                .font(.system(size: compact ? 8.5 : 12, weight: .semibold))
                                .foregroundStyle(Color(red: 0x16 / 255.0, green: 0x77 / 255.0, blue: 0x82 / 255.0))
                            RoundedRectangle(cornerRadius: 1)
                                .fill(Color(red: 0xC8 / 255.0, green: 0xD0 / 255.0, blue: 0xDA / 255.0))
                                .frame(width: compact ? 12 : 22, height: compact ? 1.5 : 2)
                            if !compact {
                                RoundedRectangle(cornerRadius: 1)
                                    .fill(Color(red: 0xD8 / 255.0, green: 0xDF / 255.0, blue: 0xE7 / 255.0))
                                    .frame(width: 16, height: 2)
                            }
                        }
                    )
            }
        } else {
            ZStack {
                WelcomePalette.thumbWellBg
                Image(systemName: symbolName(for: item.fileExtension))
                    .font(.system(size: compact ? 14 : 20, weight: .medium))
                    .foregroundStyle(WelcomePalette.accent)
            }
        }
    }

    private func symbolName(for ext: String) -> String {
        switch ext {
        case "molwork": return "hexagon"
        case "ket": return "doc.text"
        case "mol", "sdf": return "cube.transparent"
        case "cdxml": return "pencil.and.outline"
        case "smi", "smiles": return "text.justify.left"
        default: return "doc"
        }
    }
}

// MARK: - Segmented Controls & Button Styles

private struct WelcomeSegmentedControl<Option: Hashable>: View {
    let options: [(value: Option, title: String, systemImage: String?)]
    @Binding var selection: Option
    let iconOnly: Bool
    let accessibilityLabel: String

    var body: some View {
        HStack(spacing: 2) {
            ForEach(options, id: \.value) { option in
                let active = selection == option.value
                Button {
                    selection = option.value
                } label: {
                    Group {
                        if iconOnly, let icon = option.systemImage {
                            Image(systemName: icon)
                                .font(.system(size: 12, weight: active ? .semibold : .regular))
                                .frame(width: 24, height: 18)
                        } else {
                            Text(option.title)
                                .font(.system(size: 11.5, weight: active ? .semibold : .regular))
                                .padding(.horizontal, 9)
                                .padding(.vertical, 4)
                                .frame(maxWidth: .infinity)
                        }
                    }
                    .foregroundStyle(active ? WelcomePalette.accent : WelcomePalette.textMuted)
                    .padding(.vertical, iconOnly ? 2.5 : 0)
                    .background(active ? WelcomePalette.cardSurface : Color.clear)
                    .overlay(
                        RoundedRectangle(cornerRadius: 4.5, style: .continuous)
                            .stroke(active ? WelcomePalette.selectedBorder.opacity(0.6) : Color.clear, lineWidth: 0.75)
                    )
                    .clipShape(RoundedRectangle(cornerRadius: 4.5, style: .continuous))
                }
                .buttonStyle(.plain)
                .help(option.title)
                .accessibilityLabel(option.title)
                .accessibilityAddTraits(active ? .isSelected : [])
            }
        }
        .padding(2)
        .background(WelcomePalette.controlBg)
        .overlay(
            RoundedRectangle(cornerRadius: 6, style: .continuous)
                .stroke(WelcomePalette.border, lineWidth: 0.75)
        )
        .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
        .accessibilityElement(children: .contain)
        .accessibilityLabel(accessibilityLabel)
    }
}

private struct WelcomePrimaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 12.5, weight: .medium))
            .foregroundStyle(.white)
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(configuration.isPressed ? WelcomePalette.accentHover : WelcomePalette.accent)
            .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
            .opacity(configuration.isPressed ? 0.92 : 1.0)
    }
}

private struct WelcomeSecondaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 12.5, weight: .medium))
            .foregroundStyle(WelcomePalette.textMain)
            .padding(.horizontal, 12)
            .padding(.vertical, 5.5)
            .background(configuration.isPressed ? WelcomePalette.hoverBg : WelcomePalette.cardSurface)
            .overlay(
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .stroke(WelcomePalette.border, lineWidth: 0.75)
            )
            .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
    }
}

private struct WelcomeToolbarSecondaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 12.5, weight: .medium))
            .foregroundStyle(WelcomePalette.textMain)
            .padding(.horizontal, 10)
            .padding(.vertical, 5.5)
            .background(configuration.isPressed ? WelcomePalette.hoverBg : WelcomePalette.controlBg)
            .overlay(
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .stroke(WelcomePalette.border, lineWidth: 0.75)
            )
            .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
    }
}

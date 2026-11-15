import AppKit
import Foundation

/// Sidebar filter categories derived solely from real injected `WelcomeRecentItem` data.
enum WorkspaceLibraryFilter: String, CaseIterable, Sendable {
    case all
    case canvas
    case paper

    var title: String {
        switch self {
        case .all: return "全部最近"
        case .canvas: return "无边画布"
        case .paper: return "纸页文档"
        }
    }

    var symbolName: String {
        switch self {
        case .all: return "clock.arrow.circlepath"
        case .canvas: return "rectangle.dashed"
        case .paper: return "doc.text"
        }
    }
}

/// Native sidebar view controller for `NSSplitViewController` featuring `+` creation menu,
/// `NSSearchField` filtering, and an `NSOutlineView` (.sourceList) displaying real recent documents.
/// Never invents placeholder documents and never includes unimplemented Share/Trash actions.
final class WorkspaceLibraryViewController: NSViewController,
    NSOutlineViewDataSource,
    NSOutlineViewDelegate,
    NSSearchFieldDelegate,
    NSMenuDelegate,
    NSMenuItemValidation
{
    private final class GroupNode: NSObject {
        enum Kind { case filters, documents }
        let kind: Kind
        var title: String
        init(kind: Kind, title: String) {
            self.kind = kind
            self.title = title
        }
    }

    private final class FilterNode: NSObject {
        let filter: WorkspaceLibraryFilter
        var count: Int = 0
        init(filter: WorkspaceLibraryFilter) {
            self.filter = filter
        }
    }

    private final class DocumentNode: NSObject {
        let item: WelcomeRecentItem
        init(item: WelcomeRecentItem) {
            self.item = item
        }
    }

    let coordinator: WorkspaceStateCoordinator

    private var allRecentItems: [WelcomeRecentItem] = []
    private(set) var filteredItems: [WelcomeRecentItem] = []
    private(set) var selectedFilter: WorkspaceLibraryFilter = .all
    private(set) var searchQuery: String = ""

    private var thumbnailCache: [String: NSImage] = [:]
    private let relativeFormatter: RelativeDateTimeFormatter = {
        let f = RelativeDateTimeFormatter()
        f.unitsStyle = .short
        return f
    }()

    private let filtersGroup = GroupNode(kind: .filters, title: "文档分类")
    private let documentsGroup = GroupNode(kind: .documents, title: "最近文档")
    private let filterNodes: [FilterNode] = WorkspaceLibraryFilter.allCases.map { FilterNode(filter: $0) }
    private var documentNodes: [DocumentNode] = []

    private let titleLabel = NSTextField(labelWithString: "文库")
    private let addButton = NSButton()
    private let addMenu = NSMenu(title: "新建或打开")
    let searchField = NSSearchField()
    let outlineView = NSOutlineView()
    private let scrollView = NSScrollView()
    private let emptyStateStack = NSStackView()
    private let emptyStateLabel = NSTextField(labelWithString: "暂无最近文档")
    private let emptyOpenButton = NSButton(title: "打开本地文件…", target: nil, action: nil)
    private let contextMenu = NSMenu(title: "文档操作")

    private lazy var menuNewCanvas = NSMenuItem(title: "新建无边画布", action: #selector(handleNewCanvas(_:)), keyEquivalent: "")
    private lazy var menuNewPaper = NSMenuItem(title: "新建纸页文档", action: #selector(handleNewPaper(_:)), keyEquivalent: "")
    private lazy var menuOpenPanel = NSMenuItem(title: "从本地打开…", action: #selector(handleOpenPanel(_:)), keyEquivalent: "")

    init(coordinator: WorkspaceStateCoordinator, initialRecentItems: [WelcomeRecentItem] = []) {
        self.coordinator = coordinator
        self.allRecentItems = initialRecentItems
        super.init(nibName: nil, bundle: nil)
        coordinator.addObserver(self) { [weak self] in
            self?.refreshControlsForCoordinatorState()
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    override func loadView() {
        let root = NSView(frame: NSRect(x: 0, y: 0, width: 256, height: 640))
        view = root
        setupLayout(in: root)
        recomputeFilteredData(reloadOutline: true)
        refreshControlsForCoordinatorState()
    }

    /// Replaces the displayed recent documents list with real records from `WelcomeRecents` / host store.
    func setRecentItems(_ items: [WelcomeRecentItem]) {
        allRecentItems = items
        thumbnailCache.removeAll()
        recomputeFilteredData(reloadOutline: isViewLoaded)
    }

    func setFilter(_ filter: WorkspaceLibraryFilter) {
        guard selectedFilter != filter else { return }
        selectedFilter = filter
        recomputeFilteredData(reloadOutline: isViewLoaded)
    }

    func setSearchQuery(_ query: String) {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        searchQuery = trimmed
        if isViewLoaded && searchField.stringValue != query {
            searchField.stringValue = query
        }
        recomputeFilteredData(reloadOutline: isViewLoaded)
    }

    // MARK: - Setup

    private func setupLayout(in root: NSView) {
        titleLabel.font = .systemFont(ofSize: 13, weight: .semibold)
        titleLabel.textColor = .labelColor

        addButton.bezelStyle = .accessoryBarAction
        addButton.isBordered = true
        addButton.image = WorkspaceIconHelper.symbolImage("plus", accessibilityDescription: "新建或打开", pointSize: 12)
        addButton.imagePosition = .imageOnly
        addButton.toolTip = "新建文档或打开本地文件"
        addButton.target = self
        addButton.action = #selector(showAddMenu(_:))

        addMenu.autoenablesItems = true
        for item in [menuNewCanvas, menuNewPaper, menuOpenPanel] {
            item.target = self
        }
        addMenu.addItem(menuNewCanvas)
        addMenu.addItem(menuNewPaper)
        addMenu.addItem(.separator())
        addMenu.addItem(menuOpenPanel)

        let headerRow = NSStackView(views: [titleLabel, NSView(), addButton])
        headerRow.orientation = .horizontal
        headerRow.alignment = .centerY
        headerRow.translatesAutoresizingMaskIntoConstraints = false

        searchField.placeholderString = "搜索文档名、类型或路径"
        searchField.sendsWholeSearchString = false
        searchField.delegate = self
        searchField.controlSize = .small
        searchField.translatesAutoresizingMaskIntoConstraints = false

        let column = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("WorkspaceLibraryColumn"))
        column.resizingMask = .autoresizingMask
        outlineView.addTableColumn(column)
        outlineView.outlineTableColumn = column
        outlineView.headerView = nil
        outlineView.style = .sourceList
        outlineView.floatsGroupRows = false
        outlineView.selectionHighlightStyle = .regular
        outlineView.rowSizeStyle = .custom
        outlineView.dataSource = self
        outlineView.delegate = self
        outlineView.target = self
        outlineView.doubleAction = #selector(outlineDoubleClicked(_:))
        outlineView.menu = contextMenu
        contextMenu.delegate = self

        scrollView.documentView = outlineView
        scrollView.hasVerticalScroller = true
        scrollView.hasHorizontalScroller = false
        scrollView.autohidesScrollers = true
        scrollView.drawsBackground = false
        scrollView.borderType = .noBorder
        scrollView.translatesAutoresizingMaskIntoConstraints = false

        emptyStateLabel.font = .systemFont(ofSize: 12)
        emptyStateLabel.textColor = .secondaryLabelColor
        emptyStateLabel.alignment = .center
        emptyStateLabel.maximumNumberOfLines = 2

        emptyOpenButton.bezelStyle = .rounded
        emptyOpenButton.controlSize = .small
        emptyOpenButton.target = self
        emptyOpenButton.action = #selector(handleOpenPanel(_:))

        emptyStateStack.orientation = .vertical
        emptyStateStack.alignment = .centerX
        emptyStateStack.spacing = 8
        emptyStateStack.translatesAutoresizingMaskIntoConstraints = false
        emptyStateStack.addArrangedSubview(emptyStateLabel)
        emptyStateStack.addArrangedSubview(emptyOpenButton)

        root.addSubview(headerRow)
        root.addSubview(searchField)
        root.addSubview(scrollView)
        root.addSubview(emptyStateStack)

        NSLayoutConstraint.activate([
            headerRow.topAnchor.constraint(equalTo: root.safeAreaLayoutGuide.topAnchor, constant: 10),
            headerRow.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 12),
            headerRow.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -12),

            searchField.topAnchor.constraint(equalTo: headerRow.bottomAnchor, constant: 8),
            searchField.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 12),
            searchField.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -12),

            scrollView.topAnchor.constraint(equalTo: searchField.bottomAnchor, constant: 6),
            scrollView.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            scrollView.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            scrollView.bottomAnchor.constraint(equalTo: root.bottomAnchor),

            emptyStateStack.centerXAnchor.constraint(equalTo: scrollView.centerXAnchor),
            emptyStateStack.centerYAnchor.constraint(equalTo: scrollView.centerYAnchor, constant: 36),
            emptyStateStack.leadingAnchor.constraint(greaterThanOrEqualTo: root.leadingAnchor, constant: 16),
            emptyStateStack.trailingAnchor.constraint(lessThanOrEqualTo: root.trailingAnchor, constant: -16),
        ])
    }

    private func recomputeFilteredData(reloadOutline: Bool) {
        let query = searchQuery.lowercased()
        let matchesQuery: (WelcomeRecentItem) -> Bool = { item in
            guard !query.isEmpty else { return true }
            return item.displayName.lowercased().contains(query)
                || item.pathHint.lowercased().contains(query)
                || item.typeLabel.lowercased().contains(query)
                || item.fileExtension.lowercased().contains(query)
        }

        let queryMatched = allRecentItems.filter(matchesQuery)
        let canvasMatched = queryMatched.filter { $0.mode == .canvas }
        let paperMatched = queryMatched.filter { $0.mode == .paper }

        for node in filterNodes {
            switch node.filter {
            case .all: node.count = queryMatched.count
            case .canvas: node.count = canvasMatched.count
            case .paper: node.count = paperMatched.count
            }
        }

        switch selectedFilter {
        case .all: filteredItems = queryMatched
        case .canvas: filteredItems = canvasMatched
        case .paper: filteredItems = paperMatched
        }

        documentsGroup.title = "最近文档 (\(filteredItems.count))"
        documentNodes = filteredItems.map { DocumentNode(item: $0) }

        if reloadOutline {
            outlineView.reloadData()
            outlineView.expandItem(filtersGroup)
            outlineView.expandItem(documentsGroup)
            syncFilterSelectionInOutline()
            updateEmptyStateVisibility()
        }
    }

    private func syncFilterSelectionInOutline() {
        if let activeFilterNode = filterNodes.first(where: { $0.filter == selectedFilter }) {
            let row = outlineView.row(forItem: activeFilterNode)
            if row >= 0 {
                outlineView.selectRowIndexes(IndexSet(integer: row), byExtendingSelection: false)
            }
        }
    }

    private func updateEmptyStateVisibility() {
        let isEmpty = filteredItems.isEmpty
        emptyStateStack.isHidden = !isEmpty
        if isEmpty {
            if !searchQuery.isEmpty {
                emptyStateLabel.stringValue = "未找到匹配“\(searchQuery)”的文档"
            } else if selectedFilter != .all {
                emptyStateLabel.stringValue = "当前分类暂无最近文档"
            } else {
                emptyStateLabel.stringValue = "暂无最近文档"
            }
        }
        refreshControlsForCoordinatorState()
    }

    func refreshControlsForCoordinatorState() {
        guard isViewLoaded else { return }
        let fileSurfaceReady = coordinator.ownsSurface(.fileCommands) && !coordinator.documentMetadata.isNavigationInFlight
        let hasCreationAction = coordinator.fileCallbacks.onNewCanvas != nil
            || coordinator.fileCallbacks.onNewPaper != nil
            || coordinator.fileCallbacks.onOpenPanel != nil

        addButton.isEnabled = fileSurfaceReady && hasCreationAction
        emptyOpenButton.isHidden = (coordinator.fileCallbacks.onOpenPanel == nil) || !searchQuery.isEmpty
        emptyOpenButton.isEnabled = fileSurfaceReady && coordinator.fileCallbacks.onOpenPanel != nil

        if !documentNodes.isEmpty {
            outlineView.reloadData()
            syncFilterSelectionInOutline()
        }
    }

    // MARK: - NSSearchFieldDelegate

    func controlTextDidChange(_ obj: Notification) {
        setSearchQuery(searchField.stringValue)
    }

    // MARK: - NSOutlineViewDataSource

    func outlineView(_ outlineView: NSOutlineView, numberOfChildrenOfItem item: Any?) -> Int {
        if item == nil {
            return 2
        }
        if (item as? GroupNode) === filtersGroup {
            return filterNodes.count
        }
        if (item as? GroupNode) === documentsGroup {
            return documentNodes.count
        }
        return 0
    }

    func outlineView(_ outlineView: NSOutlineView, child index: Int, ofItem item: Any?) -> Any {
        if item == nil {
            return index == 0 ? filtersGroup : documentsGroup
        }
        if (item as? GroupNode) === filtersGroup {
            return filterNodes[index]
        }
        return documentNodes[index]
    }

    func outlineView(_ outlineView: NSOutlineView, isItemExpandable item: Any) -> Bool {
        item is GroupNode
    }

    func outlineView(_ outlineView: NSOutlineView, isGroupItem item: Any) -> Bool {
        item is GroupNode
    }

    // MARK: - NSOutlineViewDelegate

    func outlineView(_ outlineView: NSOutlineView, heightOfRowByItem item: Any) -> CGFloat {
        if item is GroupNode { return 24 }
        if item is FilterNode { return 26 }
        return 46
    }

    func outlineView(_ outlineView: NSOutlineView, shouldSelectItem item: Any) -> Bool {
        !(item is GroupNode)
    }

    func outlineViewSelectionDidChange(_ notification: Notification) {
        let row = outlineView.selectedRow
        guard row >= 0, let item = outlineView.item(atRow: row) else { return }
        if let filterNode = item as? FilterNode, selectedFilter != filterNode.filter {
            selectedFilter = filterNode.filter
            recomputeFilteredData(reloadOutline: true)
        }
    }

    func outlineView(_ outlineView: NSOutlineView, viewFor tableColumn: NSTableColumn?, item: Any) -> NSView? {
        if let group = item as? GroupNode {
            return makeGroupCell(title: group.title)
        }
        if let filterNode = item as? FilterNode {
            return makeFilterCell(node: filterNode)
        }
        if let docNode = item as? DocumentNode {
            return makeDocumentCell(item: docNode.item)
        }
        return nil
    }

    private func makeGroupCell(title: String) -> NSTableCellView {
        let id = NSUserInterfaceItemIdentifier("WorkspaceGroupCell")
        let cell = (outlineView.makeView(withIdentifier: id, owner: self) as? NSTableCellView) ?? {
            let v = NSTableCellView()
            v.identifier = id
            let tf = NSTextField(labelWithString: "")
            tf.font = .systemFont(ofSize: 11, weight: .semibold)
            tf.textColor = .secondaryLabelColor
            tf.translatesAutoresizingMaskIntoConstraints = false
            v.addSubview(tf)
            v.textField = tf
            NSLayoutConstraint.activate([
                tf.leadingAnchor.constraint(equalTo: v.leadingAnchor, constant: 6),
                tf.trailingAnchor.constraint(lessThanOrEqualTo: v.trailingAnchor, constant: -6),
                tf.centerYAnchor.constraint(equalTo: v.centerYAnchor),
            ])
            return v
        }()
        cell.textField?.stringValue = title
        return cell
    }

    private func makeFilterCell(node: FilterNode) -> NSTableCellView {
        let id = NSUserInterfaceItemIdentifier("WorkspaceFilterCell")
        let countTag = 901
        let cell = (outlineView.makeView(withIdentifier: id, owner: self) as? NSTableCellView) ?? {
            let v = NSTableCellView()
            v.identifier = id
            let iv = NSImageView()
            iv.translatesAutoresizingMaskIntoConstraints = false
            let tf = NSTextField(labelWithString: "")
            tf.font = .systemFont(ofSize: 13)
            tf.lineBreakMode = .byTruncatingTail
            tf.translatesAutoresizingMaskIntoConstraints = false
            let count = NSTextField(labelWithString: "")
            count.tag = countTag
            count.font = .monospacedDigitSystemFont(ofSize: 11, weight: .regular)
            count.textColor = .secondaryLabelColor
            count.setContentHuggingPriority(.required, for: .horizontal)
            count.translatesAutoresizingMaskIntoConstraints = false

            v.addSubview(iv)
            v.addSubview(tf)
            v.addSubview(count)
            v.imageView = iv
            v.textField = tf

            NSLayoutConstraint.activate([
                iv.leadingAnchor.constraint(equalTo: v.leadingAnchor, constant: 4),
                iv.centerYAnchor.constraint(equalTo: v.centerYAnchor),
                iv.widthAnchor.constraint(equalToConstant: 16),
                iv.heightAnchor.constraint(equalToConstant: 16),
                tf.leadingAnchor.constraint(equalTo: iv.trailingAnchor, constant: 6),
                tf.centerYAnchor.constraint(equalTo: v.centerYAnchor),
                count.leadingAnchor.constraint(greaterThanOrEqualTo: tf.trailingAnchor, constant: 6),
                count.trailingAnchor.constraint(equalTo: v.trailingAnchor, constant: -6),
                count.centerYAnchor.constraint(equalTo: v.centerYAnchor),
            ])
            return v
        }()
        cell.imageView?.image = WorkspaceIconHelper.symbolImage(node.filter.symbolName, accessibilityDescription: node.filter.title, pointSize: 12)
        cell.textField?.stringValue = node.filter.title
        if let countField = cell.viewWithTag(countTag) as? NSTextField {
            countField.stringValue = "\(node.count)"
        }
        return cell
    }

    private func makeDocumentCell(item: WelcomeRecentItem) -> NSTableCellView {
        let id = NSUserInterfaceItemIdentifier("WorkspaceRecentDocumentCell")
        let subtitleTag = 902
        let activeBadgeTag = 903

        let cell = (outlineView.makeView(withIdentifier: id, owner: self) as? NSTableCellView) ?? {
            let v = NSTableCellView()
            v.identifier = id
            let iv = NSImageView()
            iv.imageScaling = .scaleProportionallyUpOrDown
            iv.wantsLayer = true
            iv.layer?.cornerRadius = 5
            iv.layer?.masksToBounds = true
            iv.translatesAutoresizingMaskIntoConstraints = false

            let title = NSTextField(labelWithString: "")
            title.font = .systemFont(ofSize: 12.5, weight: .medium)
            title.lineBreakMode = .byTruncatingMiddle
            title.translatesAutoresizingMaskIntoConstraints = false

            let subtitle = NSTextField(labelWithString: "")
            subtitle.tag = subtitleTag
            subtitle.font = .systemFont(ofSize: 10.5)
            subtitle.textColor = .secondaryLabelColor
            subtitle.lineBreakMode = .byTruncatingTail
            subtitle.translatesAutoresizingMaskIntoConstraints = false

            let activeDot = NSTextField(labelWithString: "●")
            activeDot.tag = activeBadgeTag
            activeDot.font = .systemFont(ofSize: 8)
            activeDot.textColor = .controlAccentColor
            activeDot.setContentHuggingPriority(.required, for: .horizontal)
            activeDot.translatesAutoresizingMaskIntoConstraints = false

            v.addSubview(iv)
            v.addSubview(title)
            v.addSubview(subtitle)
            v.addSubview(activeDot)
            v.imageView = iv
            v.textField = title

            NSLayoutConstraint.activate([
                iv.leadingAnchor.constraint(equalTo: v.leadingAnchor, constant: 4),
                iv.centerYAnchor.constraint(equalTo: v.centerYAnchor),
                iv.widthAnchor.constraint(equalToConstant: 28),
                iv.heightAnchor.constraint(equalToConstant: 28),

                title.topAnchor.constraint(equalTo: v.topAnchor, constant: 6),
                title.leadingAnchor.constraint(equalTo: iv.trailingAnchor, constant: 8),
                activeDot.centerYAnchor.constraint(equalTo: title.centerYAnchor),
                activeDot.leadingAnchor.constraint(greaterThanOrEqualTo: title.trailingAnchor, constant: 4),
                activeDot.trailingAnchor.constraint(equalTo: v.trailingAnchor, constant: -6),

                subtitle.topAnchor.constraint(equalTo: title.bottomAnchor, constant: 2),
                subtitle.leadingAnchor.constraint(equalTo: title.leadingAnchor),
                subtitle.trailingAnchor.constraint(equalTo: v.trailingAnchor, constant: -6),
            ])
            return v
        }()

        cell.imageView?.image = thumbnailOrFallbackIcon(for: item)
        cell.textField?.stringValue = item.displayName
        cell.textField?.textColor = item.exists ? .labelColor : .secondaryLabelColor
        cell.toolTip = item.url.path

        var parts: [String] = []
        parts.append(item.typeLabel)
        if let mod = item.modifiedAt {
            parts.append(relativeFormatter.localizedString(for: mod, relativeTo: Date()))
        }
        if !item.exists {
            parts.append("磁盘文件已移动或缺失")
        }
        if let subtitleField = cell.viewWithTag(subtitleTag) as? NSTextField {
            subtitleField.stringValue = parts.joined(separator: " · ")
        }
        if let dot = cell.viewWithTag(activeBadgeTag) as? NSTextField {
            let isCurrent = coordinator.documentMetadata.fileURL?.standardizedFileURL == item.url.standardizedFileURL
            dot.isHidden = !isCurrent
        }

        return cell
    }

    private func thumbnailOrFallbackIcon(for item: WelcomeRecentItem) -> NSImage {
        if let thumbURL = item.thumbnailURL {
            if let cached = thumbnailCache[thumbURL.path] {
                return cached
            }
            if let data = WelcomeThumbnailCache.readBounded(thumbURL, limit: WelcomeThumbnailCache.maxPNGBytes),
               WelcomeThumbnailCache.validPNG(data),
               let img = NSImage(data: data) {
                thumbnailCache[thumbURL.path] = img
                return img
            }
        }
        let symbol = item.mode == .paper ? "doc.richtext" : "hexagon"
        return WorkspaceIconHelper.symbolImage(symbol, accessibilityDescription: item.typeLabel, pointSize: 15)
    }

    // MARK: - Interaction & Menus

    @objc private func showAddMenu(_ sender: NSButton) {
        let point = NSPoint(x: 0, y: sender.bounds.height + 4)
        addMenu.popUp(positioning: nil, at: point, in: sender)
    }

    @objc private func outlineDoubleClicked(_ sender: Any?) {
        let row = outlineView.clickedRow >= 0 ? outlineView.clickedRow : outlineView.selectedRow
        guard row >= 0, let docNode = outlineView.item(atRow: row) as? DocumentNode else { return }
        openRecentItem(docNode.item)
    }

    /// Triggers opening a recent item via the injected host file callback.
    func openRecentItem(_ item: WelcomeRecentItem) {
        guard !coordinator.documentMetadata.isNavigationInFlight,
              coordinator.ownsSurface(.fileCommands),
              let onOpenURL = coordinator.fileCallbacks.onOpenURL else { return }
        coordinator.performFileAction {
            onOpenURL(item.url)
        }
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        guard menu === contextMenu else { return }
        menu.removeAllItems()
        let row = outlineView.clickedRow >= 0 ? outlineView.clickedRow : outlineView.selectedRow
        guard row >= 0, let docNode = outlineView.item(atRow: row) as? DocumentNode else { return }
        let item = docNode.item

        let openItem = NSMenuItem(title: "打开", action: #selector(contextOpenClicked(_:)), keyEquivalent: "")
        openItem.target = self
        openItem.representedObject = item
        menu.addItem(openItem)

        if coordinator.fileCallbacks.onRevealInFinder != nil {
            let revealItem = NSMenuItem(title: "在 Finder 中显示", action: #selector(contextRevealClicked(_:)), keyEquivalent: "")
            revealItem.target = self
            revealItem.representedObject = item
            menu.addItem(revealItem)
        }

        if coordinator.fileCallbacks.onRenameURL != nil {
            let renameItem = NSMenuItem(title: "重命名…", action: #selector(contextRenameClicked(_:)), keyEquivalent: "")
            renameItem.target = self
            renameItem.representedObject = item
            menu.addItem(renameItem)
        }

        if coordinator.fileCallbacks.onRemoveRecent != nil {
            menu.addItem(.separator())
            let removeItem = NSMenuItem(title: "从最近列表移除", action: #selector(contextRemoveRecentClicked(_:)), keyEquivalent: "")
            removeItem.target = self
            removeItem.representedObject = item
            menu.addItem(removeItem)
        }
    }

    func validateMenuItem(_ menuItem: NSMenuItem) -> Bool {
        let fileSurfaceReady = coordinator.ownsSurface(.fileCommands) && !coordinator.documentMetadata.isNavigationInFlight
        switch menuItem.action {
        case #selector(handleNewCanvas(_:)):
            return fileSurfaceReady && coordinator.fileCallbacks.onNewCanvas != nil
        case #selector(handleNewPaper(_:)):
            return fileSurfaceReady && coordinator.fileCallbacks.onNewPaper != nil
        case #selector(handleOpenPanel(_:)):
            return fileSurfaceReady && coordinator.fileCallbacks.onOpenPanel != nil
        case #selector(contextOpenClicked(_:)):
            return fileSurfaceReady && coordinator.fileCallbacks.onOpenURL != nil
        case #selector(contextRenameClicked(_:)):
            return fileSurfaceReady && coordinator.fileCallbacks.onRenameURL != nil
        case #selector(contextRevealClicked(_:)):
            guard let item = menuItem.representedObject as? WelcomeRecentItem else { return false }
            return item.exists && coordinator.fileCallbacks.onRevealInFinder != nil
        case #selector(contextRemoveRecentClicked(_:)):
            return coordinator.fileCallbacks.onRemoveRecent != nil
        default:
            return true
        }
    }

    @objc private func handleNewCanvas(_ sender: Any?) {
        guard coordinator.ownsSurface(.fileCommands), !coordinator.documentMetadata.isNavigationInFlight else { return }
        coordinator.performFileAction(coordinator.fileCallbacks.onNewCanvas)
    }

    @objc private func handleNewPaper(_ sender: Any?) {
        guard coordinator.ownsSurface(.fileCommands), !coordinator.documentMetadata.isNavigationInFlight else { return }
        coordinator.performFileAction(coordinator.fileCallbacks.onNewPaper)
    }

    @objc private func handleOpenPanel(_ sender: Any?) {
        guard coordinator.ownsSurface(.fileCommands), !coordinator.documentMetadata.isNavigationInFlight else { return }
        coordinator.performFileAction(coordinator.fileCallbacks.onOpenPanel)
    }

    @objc private func contextOpenClicked(_ sender: NSMenuItem) {
        guard let item = sender.representedObject as? WelcomeRecentItem else { return }
        openRecentItem(item)
    }

    @objc private func contextRevealClicked(_ sender: NSMenuItem) {
        guard let item = sender.representedObject as? WelcomeRecentItem else { return }
        coordinator.fileCallbacks.onRevealInFinder?(item.url)
    }

    @objc private func contextRenameClicked(_ sender: NSMenuItem) {
        guard coordinator.ownsSurface(.fileCommands),
              !coordinator.documentMetadata.isNavigationInFlight,
              let item = sender.representedObject as? WelcomeRecentItem,
              let onRename = coordinator.fileCallbacks.onRenameURL else { return }
        coordinator.cancelPendingLocalEdits()
        onRename(item.url)
    }

    @objc private func contextRemoveRecentClicked(_ sender: NSMenuItem) {
        guard let item = sender.representedObject as? WelcomeRecentItem else { return }
        coordinator.fileCallbacks.onRemoveRecent?(item)
    }
}

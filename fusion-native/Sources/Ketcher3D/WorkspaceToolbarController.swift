import AppKit
import Foundation

/// Identifies toolbar items exposed by `WorkspaceToolbarController`.
enum WorkspaceToolbarItemIdentifier {
    static let sidebarToggle = NSToolbarItem.Identifier("molstudio.workspace.sidebarToggle")
    static let documentTitle = NSToolbarItem.Identifier("molstudio.workspace.documentTitle")
    static let undo = NSToolbarItem.Identifier("molstudio.workspace.undo")
    static let redo = NSToolbarItem.Identifier("molstudio.workspace.redo")
    static let cleanLayout = NSToolbarItem.Identifier("molstudio.workspace.cleanLayout")
    static let view3D = NSToolbarItem.Identifier("molstudio.workspace.view3D")
    static let exportMenu = NSToolbarItem.Identifier("molstudio.workspace.export")
    static let inspectorToggle = NSToolbarItem.Identifier("molstudio.workspace.inspectorToggle")
    static let agentToggle = NSToolbarItem.Identifier("molstudio.workspace.agentToggle")
    static let advancedTools = NSToolbarItem.Identifier("molstudio.workspace.advancedTools")
}

/// Real AppKit `NSToolbar` controller bound to `WorkspaceStateCoordinator`.
/// Routes file/chemistry/export triggers to injected Swift service callbacks,
/// routes Undo/Redo responder-first through `WorkspaceFocusRouter`, and never invents unimplemented Share/Trash buttons.
final class WorkspaceToolbarController: NSObject, NSToolbarDelegate, NSToolbarItemValidation, NSMenuItemValidation {
    let toolbar: NSToolbar
    let coordinator: WorkspaceStateCoordinator

    /// Resolves the active window and canvas WebView for responder-first edit validation/dispatch.
    var windowProvider: (() -> NSWindow?)?
    var canvasViewProvider: (() -> NSView?)?

    /// View/panel callbacks owned by the enclosing `WorkspaceSplitViewController`.
    var onToggleSidebar: (() -> Void)?
    var onToggleInspector: (() -> Void)?
    var onToggleAgent: (() -> Void)?
    /// Opens a native "advanced chemistry" menu (periodic table, more templates,
    /// document/object panels). Never reveals the retired web toolbar.
    var onShowAdvancedToolsMenu: ((NSView) -> Void)?

    /// Reflects active split-view state for visual highlighting.
    var isSidebarVisible: Bool = true { didSet { refreshToolbarState() } }
    var isInspectorVisible: Bool = true { didSet { refreshToolbarState() } }
    var isAgentTabActive: Bool = false { didSet { refreshToolbarState() } }

    private var documentMenuItem: NSMenuToolbarItem?
    private var exportMenuItem: NSMenuToolbarItem?
    private var undoToolbarItem: NSToolbarItem?
    private var redoToolbarItem: NSToolbarItem?
    private var cleanToolbarItem: NSToolbarItem?
    private var view3DToolbarItem: NSToolbarItem?
    private var sidebarToolbarItem: NSToolbarItem?
    private var inspectorToolbarItem: NSToolbarItem?
    private var agentToolbarItem: NSToolbarItem?

    private let documentMenu = NSMenu(title: "文档操作")
    private let exportMenu = NSMenu(title: "导出")

    private lazy var menuNewCanvas = NSMenuItem(title: "新建无边画布", action: #selector(menuActionNewCanvas(_:)), keyEquivalent: "")
    private lazy var menuNewPaper = NSMenuItem(title: "新建纸页文档", action: #selector(menuActionNewPaper(_:)), keyEquivalent: "")
    private lazy var menuOpen = NSMenuItem(title: "打开…", action: #selector(menuActionOpen(_:)), keyEquivalent: "")
    private lazy var menuWelcome = NSMenuItem(title: "打开欢迎页", action: #selector(menuActionShowWelcome(_:)), keyEquivalent: "")
    private lazy var menuSave = NSMenuItem(title: "保存", action: #selector(menuActionSave(_:)), keyEquivalent: "")
    private lazy var menuSaveAs = NSMenuItem(title: "另存为…", action: #selector(menuActionSaveAs(_:)), keyEquivalent: "")
    private lazy var menuSwitchMode = NSMenuItem(title: "切换为纸页文档", action: #selector(menuActionSwitchMode(_:)), keyEquivalent: "")
    private lazy var menuPaperSetup = NSMenuItem(title: "页面设置…", action: #selector(menuActionPaperSetup(_:)), keyEquivalent: "")
    private lazy var menuAddPaperPage = NSMenuItem(title: "新增页面", action: #selector(menuActionAddPaperPage(_:)), keyEquivalent: "")
    private lazy var menuRemoveBlankLastPage = NSMenuItem(title: "删除空白末页", action: #selector(menuActionRemoveBlankLastPage(_:)), keyEquivalent: "")
    private lazy var menuInsertImage = NSMenuItem(title: "插入图片到纸页…", action: #selector(menuActionInsertImage(_:)), keyEquivalent: "")
    private lazy var menuInsertFile = NSMenuItem(title: "插入 .molwork / .ket…", action: #selector(menuActionInsertFile(_:)), keyEquivalent: "")
    private lazy var menuRename = NSMenuItem(title: "重命名…", action: #selector(menuActionRename(_:)), keyEquivalent: "")
    private lazy var menuReveal = NSMenuItem(title: "在 Finder 中显示", action: #selector(menuActionRevealInFinder(_:)), keyEquivalent: "")

    private lazy var menuExportMol = NSMenuItem(title: "导出 MOL (.mol)…", action: #selector(menuActionExportMol(_:)), keyEquivalent: "")
    private lazy var menuExportImage = NSMenuItem(title: "导出机理图 (.svg / .png)…", action: #selector(menuActionExportImage(_:)), keyEquivalent: "")
    private lazy var menuExportPDF = NSMenuItem(title: "导出纸页 PDF…", action: #selector(menuActionExportPDF(_:)), keyEquivalent: "")
    private lazy var menuCopySmiles = NSMenuItem(title: "复制 SMILES", action: #selector(menuActionCopySmiles(_:)), keyEquivalent: "")
    private lazy var menuCheckStructure = NSMenuItem(title: "结构检查", action: #selector(menuActionCheckStructure(_:)), keyEquivalent: "")
    private lazy var menuComputeProps = NSMenuItem(title: "分子理化性质", action: #selector(menuActionComputeProps(_:)), keyEquivalent: "")

    init(
        coordinator: WorkspaceStateCoordinator,
        identifier: NSToolbar.Identifier = NSToolbar.Identifier("MolStudioWorkspaceToolbar")
    ) {
        self.coordinator = coordinator
        self.toolbar = NSToolbar(identifier: identifier)
        super.init()

        configureMenus()
        toolbar.delegate = self
        toolbar.displayMode = .iconOnly
        toolbar.allowsUserCustomization = false
        toolbar.autosavesConfiguration = false

        coordinator.addObserver(self) { [weak self] in
            self?.refreshToolbarState()
        }
        refreshToolbarState()
    }

    /// Attaches this toolbar to an `NSWindow` using Apple-standard unified chrome (`titleVisibility = .hidden`).
    func attach(to window: NSWindow) {
        window.titleVisibility = .hidden
        window.toolbarStyle = .unified
        window.toolbar = toolbar
        if windowProvider == nil {
            windowProvider = { [weak window] in window }
        }
        refreshToolbarState()
    }

    func refreshToolbarState() {
        updateDocumentItemAppearance()
        rebuildMenusIfNeeded()

        sidebarToolbarItem?.isEnabled = (onToggleSidebar != nil)
        sidebarToolbarItem?.toolTip = isSidebarVisible ? "收起文库边栏" : "展开文库边栏"

        let canvasReadyForFileCommands = coordinator.isCanvasSurfaceReady(.fileCommands)
        let navBusy = coordinator.documentMetadata.isNavigationInFlight
        let window = windowProvider?()
        let canvasView = canvasViewProvider?()

        undoToolbarItem?.isEnabled = WorkspaceFocusRouter.validateEditAction(
            WorkspaceFocusRouter.undoSelector,
            in: window,
            canvasView: canvasView,
            coordinator: coordinator
        )
        redoToolbarItem?.isEnabled = WorkspaceFocusRouter.validateEditAction(
            WorkspaceFocusRouter.redoSelector,
            in: window,
            canvasView: canvasView,
            coordinator: coordinator
        )

        cleanToolbarItem?.isEnabled = !navBusy && canvasReadyForFileCommands && coordinator.fileCallbacks.onCleanLayout != nil
        view3DToolbarItem?.isEnabled = !navBusy && canvasReadyForFileCommands && coordinator.fileCallbacks.onGenerate3D != nil

        let hasAnyExport = !navBusy && canvasReadyForFileCommands && (
            coordinator.fileCallbacks.onExportMol != nil
                || coordinator.fileCallbacks.onExportMechanismImage != nil
                || coordinator.fileCallbacks.onExportDocumentPDF != nil
                || coordinator.fileCallbacks.onCopySmiles != nil
                || coordinator.fileCallbacks.onCheckStructure != nil
                || coordinator.fileCallbacks.onComputeProperties != nil
        )
        exportMenuItem?.isEnabled = hasAnyExport

        inspectorToolbarItem?.isEnabled = (onToggleInspector != nil)
        agentToolbarItem?.isEnabled = (onToggleAgent != nil)

        documentMenuItem?.isEnabled = !navBusy
        toolbar.validateVisibleItems()
    }

    // MARK: - NSToolbarDelegate

    func toolbarAllowedItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
        [
            WorkspaceToolbarItemIdentifier.sidebarToggle,
            WorkspaceToolbarItemIdentifier.documentTitle,
            .flexibleSpace,
            WorkspaceToolbarItemIdentifier.undo,
            WorkspaceToolbarItemIdentifier.redo,
            .space,
            WorkspaceToolbarItemIdentifier.cleanLayout,
            WorkspaceToolbarItemIdentifier.view3D,
            WorkspaceToolbarItemIdentifier.exportMenu,
            WorkspaceToolbarItemIdentifier.advancedTools,
            .space,
            WorkspaceToolbarItemIdentifier.inspectorToggle,
            WorkspaceToolbarItemIdentifier.agentToggle,
        ]
    }

    func toolbarDefaultItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
        [
            WorkspaceToolbarItemIdentifier.sidebarToggle,
            WorkspaceToolbarItemIdentifier.documentTitle,
            .flexibleSpace,
            WorkspaceToolbarItemIdentifier.undo,
            WorkspaceToolbarItemIdentifier.redo,
            WorkspaceToolbarItemIdentifier.cleanLayout,
            WorkspaceToolbarItemIdentifier.view3D,
            WorkspaceToolbarItemIdentifier.exportMenu,
            WorkspaceToolbarItemIdentifier.advancedTools,
            WorkspaceToolbarItemIdentifier.inspectorToggle,
            WorkspaceToolbarItemIdentifier.agentToggle,
        ]
    }

    func toolbar(
        _ toolbar: NSToolbar,
        itemForItemIdentifier itemIdentifier: NSToolbarItem.Identifier,
        willBeInsertedIntoToolbar flag: Bool
    ) -> NSToolbarItem? {
        switch itemIdentifier {
        case WorkspaceToolbarItemIdentifier.sidebarToggle:
            let item = NSToolbarItem(itemIdentifier: itemIdentifier)
            item.label = "文库"
            item.paletteLabel = "切换文库边栏"
            item.toolTip = "切换文库边栏"
            item.image = WorkspaceIconHelper.symbolImage("sidebar.leading", accessibilityDescription: "切换文库边栏")
            item.target = self
            item.action = #selector(toolbarSidebarToggleClicked(_:))
            item.isBordered = true
            sidebarToolbarItem = item
            return item

        case WorkspaceToolbarItemIdentifier.documentTitle:
            let item = NSMenuToolbarItem(itemIdentifier: itemIdentifier)
            item.label = "文档"
            item.paletteLabel = "当前文档"
            item.showsIndicator = true
            item.menu = documentMenu
            item.isBordered = true
            documentMenuItem = item
            updateDocumentItemAppearance()
            return item

        case WorkspaceToolbarItemIdentifier.undo:
            let item = NSToolbarItem(itemIdentifier: itemIdentifier)
            item.label = "撤销"
            item.paletteLabel = "撤销"
            item.toolTip = "撤销"
            item.image = WorkspaceIconHelper.symbolImage("arrow.uturn.backward", accessibilityDescription: "撤销")
            item.target = self
            item.action = #selector(toolbarUndoClicked(_:))
            item.isBordered = true
            undoToolbarItem = item
            return item

        case WorkspaceToolbarItemIdentifier.redo:
            let item = NSToolbarItem(itemIdentifier: itemIdentifier)
            item.label = "重做"
            item.paletteLabel = "重做"
            item.toolTip = "重做"
            item.image = WorkspaceIconHelper.symbolImage("arrow.uturn.forward", accessibilityDescription: "重做")
            item.target = self
            item.action = #selector(toolbarRedoClicked(_:))
            item.isBordered = true
            redoToolbarItem = item
            return item

        case WorkspaceToolbarItemIdentifier.cleanLayout:
            let item = NSToolbarItem(itemIdentifier: itemIdentifier)
            item.label = "整理结构"
            item.paletteLabel = "整理 2D 结构"
            item.toolTip = "整理 2D 结构排布"
            item.image = WorkspaceIconHelper.symbolImage("wand.and.stars", accessibilityDescription: "整理结构")
            item.target = self
            item.action = #selector(toolbarCleanLayoutClicked(_:))
            item.isBordered = true
            cleanToolbarItem = item
            return item

        case WorkspaceToolbarItemIdentifier.view3D:
            let item = NSToolbarItem(itemIdentifier: itemIdentifier)
            item.label = "3D"
            item.paletteLabel = "3D 构象预览"
            item.toolTip = "生成并查看 3D 构象"
            item.image = WorkspaceIconHelper.symbolImage("cube.transparent", accessibilityDescription: "3D 构象预览")
            item.target = self
            item.action = #selector(toolbarView3DClicked(_:))
            item.isBordered = true
            view3DToolbarItem = item
            return item

        case WorkspaceToolbarItemIdentifier.exportMenu:
            let item = NSMenuToolbarItem(itemIdentifier: itemIdentifier)
            item.label = "导出"
            item.paletteLabel = "导出与检查"
            item.toolTip = "导出文件或执行结构检查"
            item.image = WorkspaceIconHelper.symbolImage("square.and.arrow.up", accessibilityDescription: "导出")
            item.showsIndicator = true
            item.menu = exportMenu
            item.isBordered = true
            exportMenuItem = item
            return item

        case WorkspaceToolbarItemIdentifier.advancedTools:
            let item = NSToolbarItem(itemIdentifier: itemIdentifier)
            item.label = "高级化学工具"
            item.paletteLabel = item.label
            item.toolTip = "打开原生高级工具（周期表 / 模板 / 属性 / 页面）"
            item.image = WorkspaceIconHelper.symbolImage("wrench.and.screwdriver", accessibilityDescription: item.label)
            item.target = self
            item.action = #selector(toolbarAdvancedToolsClicked(_:))
            item.isBordered = true
            return item

        case WorkspaceToolbarItemIdentifier.inspectorToggle:
            let item = NSToolbarItem(itemIdentifier: itemIdentifier)
            item.label = "检查器"
            item.paletteLabel = "切换检查器"
            item.toolTip = "显示或隐藏属性检查器"
            item.image = WorkspaceIconHelper.symbolImage("sidebar.trailing", accessibilityDescription: "检查器")
            item.target = self
            item.action = #selector(toolbarInspectorToggleClicked(_:))
            item.isBordered = true
            inspectorToolbarItem = item
            return item

        case WorkspaceToolbarItemIdentifier.agentToggle:
            let item = NSToolbarItem(itemIdentifier: itemIdentifier)
            item.label = "AI"
            item.paletteLabel = "AI 化学助手"
            item.toolTip = "打开 AI 化学助手"
            item.image = WorkspaceIconHelper.symbolImage("sparkles", accessibilityDescription: "AI 化学助手")
            item.target = self
            item.action = #selector(toolbarAgentToggleClicked(_:))
            item.isBordered = true
            agentToolbarItem = item
            return item

        default:
            return nil
        }
    }

    // MARK: - Validation

    func validateToolbarItem(_ item: NSToolbarItem) -> Bool {
        let navBusy = coordinator.documentMetadata.isNavigationInFlight
        let fileSurfaceReady = coordinator.isCanvasSurfaceReady(.fileCommands)
        let window = windowProvider?()
        let canvasView = canvasViewProvider?()

        switch item.itemIdentifier {
        case WorkspaceToolbarItemIdentifier.sidebarToggle:
            return onToggleSidebar != nil
        case WorkspaceToolbarItemIdentifier.documentTitle:
            return !navBusy
        case WorkspaceToolbarItemIdentifier.undo:
            return WorkspaceFocusRouter.validateEditAction(
                WorkspaceFocusRouter.undoSelector,
                in: window,
                canvasView: canvasView,
                coordinator: coordinator
            )
        case WorkspaceToolbarItemIdentifier.redo:
            return WorkspaceFocusRouter.validateEditAction(
                WorkspaceFocusRouter.redoSelector,
                in: window,
                canvasView: canvasView,
                coordinator: coordinator
            )
        case WorkspaceToolbarItemIdentifier.cleanLayout:
            return !navBusy && fileSurfaceReady && coordinator.fileCallbacks.onCleanLayout != nil
        case WorkspaceToolbarItemIdentifier.view3D:
            return !navBusy && fileSurfaceReady && coordinator.fileCallbacks.onGenerate3D != nil
        case WorkspaceToolbarItemIdentifier.exportMenu:
            return !navBusy && fileSurfaceReady && hasAnyExportAction
        case WorkspaceToolbarItemIdentifier.inspectorToggle:
            return onToggleInspector != nil
        case WorkspaceToolbarItemIdentifier.agentToggle:
            return onToggleAgent != nil
        case WorkspaceToolbarItemIdentifier.advancedTools:
            return !navBusy && coordinator.isCanvasSurfaceReady(.toolPalette) && onShowAdvancedToolsMenu != nil
        default:
            return true
        }
    }

    func validateMenuItem(_ menuItem: NSMenuItem) -> Bool {
        let navBusy = coordinator.documentMetadata.isNavigationInFlight
        let fileReady = !navBusy && coordinator.ownsSurface(.fileCommands)
        let canvasReady = !navBusy && coordinator.isCanvasSurfaceReady(.fileCommands)
        let hasFileURL = coordinator.documentMetadata.fileURL != nil

        switch menuItem.action {
        case #selector(menuActionNewCanvas(_:)):
            return fileReady && coordinator.fileCallbacks.onNewCanvas != nil
        case #selector(menuActionNewPaper(_:)):
            return fileReady && coordinator.fileCallbacks.onNewPaper != nil
        case #selector(menuActionOpen(_:)):
            return fileReady && coordinator.fileCallbacks.onOpenPanel != nil
        case #selector(menuActionShowWelcome(_:)):
            return !navBusy && coordinator.fileCallbacks.onShowWelcome != nil
        case #selector(menuActionSave(_:)):
            return canvasReady && coordinator.fileCallbacks.onSave != nil
        case #selector(menuActionSaveAs(_:)):
            return canvasReady && coordinator.fileCallbacks.onSaveAs != nil
        case #selector(menuActionSwitchMode(_:)):
            if isPaperModeActive {
                return canvasReady && coordinator.fileCallbacks.onSwitchToCanvasMode != nil
            } else {
                return canvasReady && coordinator.fileCallbacks.onSwitchToPaperMode != nil
            }
        case #selector(menuActionPaperSetup(_:)):
            return canvasReady && isPaperModeActive && coordinator.fileCallbacks.onPaperSetup != nil
        case #selector(menuActionAddPaperPage(_:)):
            return canvasReady && isPaperModeActive && coordinator.fileCallbacks.onAddPaperPage != nil
        case #selector(menuActionRemoveBlankLastPage(_:)):
            let canRemove = coordinator.uiState.document?.canRemoveLastPage ?? true
            return canvasReady && isPaperModeActive && canRemove && coordinator.fileCallbacks.onRemoveBlankLastPage != nil
        case #selector(menuActionInsertImage(_:)):
            return canvasReady && isPaperModeActive && coordinator.fileCallbacks.onInsertImageIntoDocument != nil
        case #selector(menuActionInsertFile(_:)):
            return canvasReady && isPaperModeActive && coordinator.fileCallbacks.onInsertFileIntoDocument != nil
        case #selector(menuActionRename(_:)):
            return fileReady && hasFileURL && coordinator.fileCallbacks.onRenameURL != nil
        case #selector(menuActionRevealInFinder(_:)):
            return hasFileURL && coordinator.fileCallbacks.onRevealInFinder != nil
        case #selector(menuActionExportMol(_:)):
            return canvasReady && coordinator.fileCallbacks.onExportMol != nil
        case #selector(menuActionExportImage(_:)):
            return canvasReady && coordinator.fileCallbacks.onExportMechanismImage != nil
        case #selector(menuActionExportPDF(_:)):
            return canvasReady && coordinator.fileCallbacks.onExportDocumentPDF != nil
        case #selector(menuActionCopySmiles(_:)):
            return canvasReady && coordinator.fileCallbacks.onCopySmiles != nil
        case #selector(menuActionCheckStructure(_:)):
            return canvasReady && coordinator.fileCallbacks.onCheckStructure != nil
        case #selector(menuActionComputeProps(_:)):
            return canvasReady && coordinator.fileCallbacks.onComputeProperties != nil
        default:
            return true
        }
    }

    // MARK: - Actions

    @objc private func toolbarSidebarToggleClicked(_ sender: Any?) {
        onToggleSidebar?()
    }

    @objc private func toolbarAdvancedToolsClicked(_ sender: Any?) {
        let anchor = (sender as? NSView) ?? (sender as? NSToolbarItem)?.view ?? windowProvider?()?.contentView
        if let anchor { onShowAdvancedToolsMenu?(anchor) }
    }

    @objc private func toolbarUndoClicked(_ sender: Any?) {
        WorkspaceFocusRouter.performEditAction(
            WorkspaceFocusRouter.undoSelector,
            sender: sender,
            in: windowProvider?(),
            canvasView: canvasViewProvider?(),
            coordinator: coordinator
        )
    }

    @objc private func toolbarRedoClicked(_ sender: Any?) {
        WorkspaceFocusRouter.performEditAction(
            WorkspaceFocusRouter.redoSelector,
            sender: sender,
            in: windowProvider?(),
            canvasView: canvasViewProvider?(),
            coordinator: coordinator
        )
    }

    @objc private func toolbarCleanLayoutClicked(_ sender: Any?) {
        guard !coordinator.documentMetadata.isNavigationInFlight,
              coordinator.isCanvasSurfaceReady(.fileCommands) else { return }
        coordinator.performFileAction(coordinator.fileCallbacks.onCleanLayout)
        WorkspaceFocusRouter.restoreCanvasFocusIfSafe(in: windowProvider?(), canvasView: canvasViewProvider?())
    }

    @objc private func toolbarView3DClicked(_ sender: Any?) {
        guard !coordinator.documentMetadata.isNavigationInFlight,
              coordinator.isCanvasSurfaceReady(.fileCommands) else { return }
        coordinator.performFileAction(coordinator.fileCallbacks.onGenerate3D)
        WorkspaceFocusRouter.restoreCanvasFocusIfSafe(in: windowProvider?(), canvasView: canvasViewProvider?())
    }

    @objc private func toolbarInspectorToggleClicked(_ sender: Any?) {
        onToggleInspector?()
    }

    @objc private func toolbarAgentToggleClicked(_ sender: Any?) {
        onToggleAgent?()
    }

    @objc private func menuActionNewCanvas(_ sender: Any?) {
        guard !coordinator.documentMetadata.isNavigationInFlight,
              coordinator.ownsSurface(.fileCommands) else { return }
        coordinator.performFileAction(coordinator.fileCallbacks.onNewCanvas)
    }

    @objc private func menuActionNewPaper(_ sender: Any?) {
        guard !coordinator.documentMetadata.isNavigationInFlight,
              coordinator.ownsSurface(.fileCommands) else { return }
        coordinator.performFileAction(coordinator.fileCallbacks.onNewPaper)
    }

    @objc private func menuActionOpen(_ sender: Any?) {
        guard !coordinator.documentMetadata.isNavigationInFlight,
              coordinator.ownsSurface(.fileCommands) else { return }
        coordinator.performFileAction(coordinator.fileCallbacks.onOpenPanel)
    }

    @objc private func menuActionShowWelcome(_ sender: Any?) {
        guard !coordinator.documentMetadata.isNavigationInFlight else { return }
        coordinator.performFileAction(coordinator.fileCallbacks.onShowWelcome)
    }

    @objc private func menuActionSave(_ sender: Any?) {
        guard !coordinator.documentMetadata.isNavigationInFlight,
              coordinator.isCanvasSurfaceReady(.fileCommands) else { return }
        coordinator.performFileAction(coordinator.fileCallbacks.onSave)
    }

    @objc private func menuActionSaveAs(_ sender: Any?) {
        guard !coordinator.documentMetadata.isNavigationInFlight,
              coordinator.isCanvasSurfaceReady(.fileCommands) else { return }
        coordinator.performFileAction(coordinator.fileCallbacks.onSaveAs)
    }

    @objc private func menuActionSwitchMode(_ sender: Any?) {
        guard !coordinator.documentMetadata.isNavigationInFlight,
              coordinator.isCanvasSurfaceReady(.fileCommands) else { return }
        if isPaperModeActive {
            coordinator.performFileAction(coordinator.fileCallbacks.onSwitchToCanvasMode)
        } else {
            coordinator.performFileAction(coordinator.fileCallbacks.onSwitchToPaperMode)
        }
    }

    @objc private func menuActionPaperSetup(_ sender: Any?) {
        guard !coordinator.documentMetadata.isNavigationInFlight,
              coordinator.isCanvasSurfaceReady(.fileCommands),
              isPaperModeActive else { return }
        coordinator.performFileAction(coordinator.fileCallbacks.onPaperSetup)
    }

    @objc private func menuActionAddPaperPage(_ sender: Any?) {
        guard !coordinator.documentMetadata.isNavigationInFlight,
              coordinator.isCanvasSurfaceReady(.fileCommands),
              isPaperModeActive else { return }
        coordinator.performFileAction(coordinator.fileCallbacks.onAddPaperPage)
    }

    @objc private func menuActionRemoveBlankLastPage(_ sender: Any?) {
        guard !coordinator.documentMetadata.isNavigationInFlight,
              coordinator.isCanvasSurfaceReady(.fileCommands),
              isPaperModeActive else { return }
        coordinator.performFileAction(coordinator.fileCallbacks.onRemoveBlankLastPage)
    }

    @objc private func menuActionInsertImage(_ sender: Any?) {
        guard !coordinator.documentMetadata.isNavigationInFlight,
              coordinator.isCanvasSurfaceReady(.fileCommands),
              isPaperModeActive else { return }
        coordinator.performFileAction(coordinator.fileCallbacks.onInsertImageIntoDocument)
    }

    @objc private func menuActionInsertFile(_ sender: Any?) {
        guard !coordinator.documentMetadata.isNavigationInFlight,
              coordinator.isCanvasSurfaceReady(.fileCommands),
              isPaperModeActive else { return }
        coordinator.performFileAction(coordinator.fileCallbacks.onInsertFileIntoDocument)
    }

    @objc private func menuActionRename(_ sender: Any?) {
        guard !coordinator.documentMetadata.isNavigationInFlight,
              coordinator.ownsSurface(.fileCommands),
              let url = coordinator.documentMetadata.fileURL,
              let handler = coordinator.fileCallbacks.onRenameURL else { return }
        coordinator.cancelPendingLocalEdits()
        handler(url)
    }

    @objc private func menuActionRevealInFinder(_ sender: Any?) {
        guard let url = coordinator.documentMetadata.fileURL else { return }
        coordinator.fileCallbacks.onRevealInFinder?(url)
    }

    @objc private func menuActionExportMol(_ sender: Any?) {
        guard !coordinator.documentMetadata.isNavigationInFlight,
              coordinator.isCanvasSurfaceReady(.fileCommands) else { return }
        coordinator.performFileAction(coordinator.fileCallbacks.onExportMol)
    }

    @objc private func menuActionExportImage(_ sender: Any?) {
        guard !coordinator.documentMetadata.isNavigationInFlight,
              coordinator.isCanvasSurfaceReady(.fileCommands) else { return }
        coordinator.performFileAction(coordinator.fileCallbacks.onExportMechanismImage)
    }

    @objc private func menuActionExportPDF(_ sender: Any?) {
        guard !coordinator.documentMetadata.isNavigationInFlight,
              coordinator.isCanvasSurfaceReady(.fileCommands) else { return }
        coordinator.performFileAction(coordinator.fileCallbacks.onExportDocumentPDF)
    }

    @objc private func menuActionCopySmiles(_ sender: Any?) {
        guard !coordinator.documentMetadata.isNavigationInFlight,
              coordinator.isCanvasSurfaceReady(.fileCommands) else { return }
        coordinator.performFileAction(coordinator.fileCallbacks.onCopySmiles)
    }

    @objc private func menuActionCheckStructure(_ sender: Any?) {
        guard !coordinator.documentMetadata.isNavigationInFlight,
              coordinator.isCanvasSurfaceReady(.fileCommands) else { return }
        coordinator.performFileAction(coordinator.fileCallbacks.onCheckStructure)
    }

    @objc private func menuActionComputeProps(_ sender: Any?) {
        guard !coordinator.documentMetadata.isNavigationInFlight,
              coordinator.isCanvasSurfaceReady(.fileCommands) else { return }
        coordinator.performFileAction(coordinator.fileCallbacks.onComputeProperties)
    }

    // MARK: - Helpers

    private var hasAnyExportAction: Bool {
        coordinator.fileCallbacks.onExportMol != nil
            || coordinator.fileCallbacks.onExportMechanismImage != nil
            || coordinator.fileCallbacks.onExportDocumentPDF != nil
            || coordinator.fileCallbacks.onCopySmiles != nil
            || coordinator.fileCallbacks.onCheckStructure != nil
            || coordinator.fileCallbacks.onComputeProperties != nil
    }

    private var isPaperModeActive: Bool {
        coordinator.uiState.viewport.mode == .paper || coordinator.documentMetadata.documentMode == .paper
    }

    private func configureMenus() {
        documentMenu.autoenablesItems = true
        exportMenu.autoenablesItems = true

        for item in [
            menuNewCanvas, menuNewPaper, menuOpen, menuWelcome, menuSave, menuSaveAs,
            menuSwitchMode, menuPaperSetup, menuAddPaperPage, menuRemoveBlankLastPage,
            menuInsertImage, menuInsertFile, menuRename, menuReveal
        ] {
            item.target = self
        }
        for item in [menuExportMol, menuExportImage, menuExportPDF, menuCopySmiles, menuCheckStructure, menuComputeProps] {
            item.target = self
        }

        rebuildMenusIfNeeded()
    }

    private func rebuildMenusIfNeeded() {
        documentMenu.removeAllItems()
        documentMenu.addItem(menuNewCanvas)
        documentMenu.addItem(menuNewPaper)
        documentMenu.addItem(menuOpen)
        if coordinator.fileCallbacks.onShowWelcome != nil {
            documentMenu.addItem(menuWelcome)
        }
        documentMenu.addItem(.separator())
        documentMenu.addItem(menuSave)
        documentMenu.addItem(menuSaveAs)

        let canSwitch = isPaperModeActive
            ? (coordinator.fileCallbacks.onSwitchToCanvasMode != nil)
            : (coordinator.fileCallbacks.onSwitchToPaperMode != nil)
        if canSwitch || isPaperModeActive {
            documentMenu.addItem(.separator())
            menuSwitchMode.title = isPaperModeActive ? "切换为无边画布" : "切换为纸页文档"
            if canSwitch {
                documentMenu.addItem(menuSwitchMode)
            }
            if isPaperModeActive {
                if coordinator.fileCallbacks.onPaperSetup != nil {
                    documentMenu.addItem(menuPaperSetup)
                }
                if coordinator.fileCallbacks.onAddPaperPage != nil {
                    documentMenu.addItem(menuAddPaperPage)
                }
                if coordinator.fileCallbacks.onRemoveBlankLastPage != nil {
                    documentMenu.addItem(menuRemoveBlankLastPage)
                }
                if coordinator.fileCallbacks.onInsertImageIntoDocument != nil {
                    documentMenu.addItem(menuInsertImage)
                }
                if coordinator.fileCallbacks.onInsertFileIntoDocument != nil {
                    documentMenu.addItem(menuInsertFile)
                }
            }
        }

        if coordinator.fileCallbacks.onRenameURL != nil || coordinator.fileCallbacks.onRevealInFinder != nil {
            documentMenu.addItem(.separator())
            if coordinator.fileCallbacks.onRenameURL != nil {
                documentMenu.addItem(menuRename)
            }
            if coordinator.fileCallbacks.onRevealInFinder != nil {
                documentMenu.addItem(menuReveal)
            }
        }

        exportMenu.removeAllItems()
        exportMenu.addItem(menuExportMol)
        exportMenu.addItem(menuExportImage)
        exportMenu.addItem(menuExportPDF)
        exportMenu.addItem(.separator())
        exportMenu.addItem(menuCopySmiles)
        if coordinator.fileCallbacks.onCheckStructure != nil || coordinator.fileCallbacks.onComputeProperties != nil {
            exportMenu.addItem(.separator())
            if coordinator.fileCallbacks.onCheckStructure != nil {
                exportMenu.addItem(menuCheckStructure)
            }
            if coordinator.fileCallbacks.onComputeProperties != nil {
                exportMenu.addItem(menuComputeProps)
            }
        }
    }

    private func updateDocumentItemAppearance() {
        guard let item = documentMenuItem else { return }
        let meta = coordinator.documentMetadata
        let modeBadge = isPaperModeActive ? "纸页文档" : "无边画布"
        let dirtySuffix = meta.isDirty ? " · 未保存" : ""
        let title = meta.displayTitle.isEmpty ? "未命名文档" : meta.displayTitle
        item.title = "\(title) [\(modeBadge)]\(dirtySuffix)"
        item.toolTip = meta.fileURL?.path ?? title
    }
}

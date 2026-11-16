import AppKit
import Foundation

/// Composable 3-column macOS workbench split view (`NSSplitViewController`) pairing:
/// 1. Native `NSSplitViewItem(sidebarWithViewController:)` Library sidebar (`WorkspaceLibraryViewController`)
/// 2. Center chemistry canvas host (`WorkspaceCanvasHostViewController`) with Liquid Glass floating overlays
/// 3. Native `NSSplitViewItem(inspectorWithViewController:)` Inspector/AI panel (`WorkspaceInspectorViewController`)
/// Automatically propagates divider resize / collapse geometry to `WorkspaceStateCoordinator.updateHostViewport(...)`
/// without ever mutating document dirty state or duplicating file/chemistry/AI runtimes.
final class WorkspaceSplitViewController: NSSplitViewController, NSPopoverDelegate {
    let coordinator: WorkspaceStateCoordinator
    let libraryViewController: WorkspaceLibraryViewController
    let canvasHostViewController: WorkspaceCanvasHostViewController
    let inspectorViewController: WorkspaceInspectorViewController
    let toolbarController: WorkspaceToolbarController

    let sidebarSplitItem: NSSplitViewItem
    let canvasSplitItem: NSSplitViewItem
    let inspectorSplitItem: NSSplitViewItem

    private var notificationObservers: [NSObjectProtocol] = []
    private var firstResponderObservation: NSKeyValueObservation?
    private weak var observedWindow: NSWindow?
    private var didSetInitialDividerPositions = false
    private let propertiesPopover = NSPopover()

    init(
        coordinator: WorkspaceStateCoordinator,
        initialRecentItems: [WelcomeRecentItem] = [],
        canvasContentView: NSView? = nil,
        backdropTone: WorkspaceCanvasBackdropView.BackdropTone = .cleanWhite
    ) {
        self.coordinator = coordinator
        self.libraryViewController = WorkspaceLibraryViewController(
            coordinator: coordinator,
            initialRecentItems: initialRecentItems
        )
        self.canvasHostViewController = WorkspaceCanvasHostViewController(
            coordinator: coordinator,
            backdropTone: backdropTone
        )
        self.inspectorViewController = WorkspaceInspectorViewController(coordinator: coordinator)
        self.toolbarController = WorkspaceToolbarController(coordinator: coordinator)

        self.sidebarSplitItem = NSSplitViewItem(sidebarWithViewController: libraryViewController)
        self.canvasSplitItem = NSSplitViewItem(viewController: canvasHostViewController)
        self.inspectorSplitItem = NSSplitViewItem(inspectorWithViewController: inspectorViewController)

        super.init(nibName: nil, bundle: nil)

        configureSplitItems()
        propertiesPopover.behavior = .transient
        propertiesPopover.delegate = self
        propertiesPopover.contentViewController = inspectorViewController.propertiesViewController
        propertiesPopover.contentSize = NSSize(width: 320, height: 520)
        wireComponents()
        if let canvasContentView {
            canvasHostViewController.setCanvasContentView(canvasContentView)
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    deinit {
        for observer in notificationObservers {
            NotificationCenter.default.removeObserver(observer)
        }
        firstResponderObservation?.invalidate()
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        splitView.isVertical = true
        splitView.dividerStyle = .thin

        if splitViewItems.isEmpty {
            addSplitViewItem(sidebarSplitItem)
            addSplitViewItem(canvasSplitItem)
            addSplitViewItem(inspectorSplitItem)
        }
        syncStateAndViewport(forceViewport: true)
    }

    override func viewDidAppear() {
        super.viewDidAppear()
        if !didSetInitialDividerPositions, splitView.bounds.width >= 960 {
            didSetInitialDividerPositions = true
            if !sidebarSplitItem.isCollapsed { splitView.setPosition(240, ofDividerAt: 0) }
            splitView.setPosition(splitView.bounds.width - 310, ofDividerAt: 1)
        }
        attachWindowObserversIfNeeded()
        syncStateAndViewport(forceViewport: true)
    }

    override func splitViewDidResizeSubviews(_ notification: Notification) {
        super.splitViewDidResizeSubviews(notification)
        syncStateAndViewport(forceViewport: false)
    }

    /// Attaches unified toolbar chrome and window focus observers cleanly to `window`.
    func installWindowChrome(on window: NSWindow, attachToolbar: Bool = true) {
        if attachToolbar {
            toolbarController.attach(to: window)
        }
        observedWindow = window
        attachWindowObserversIfNeeded()
        syncStateAndViewport(forceViewport: true)
    }

    /// Injects or swaps the active canvas content view (e.g., `WKWebView`) inside the center pane.
    func setCanvasContentView(_ contentView: NSView?) {
        canvasHostViewController.setCanvasContentView(contentView)
        syncStateAndViewport(forceViewport: true)
    }

    // MARK: - Sidebar & Inspector Controls

    var isSidebarCollapsed: Bool {
        get { sidebarSplitItem.isCollapsed }
        set {
            sidebarSplitItem.isCollapsed = newValue
            syncStateAndViewport(forceViewport: true)
        }
    }

    var isInspectorCollapsed: Bool {
        get { inspectorSplitItem.isCollapsed }
        set {
            if newValue {
                inspectorViewController.cancelPendingLocalEdits()
            }
            inspectorSplitItem.isCollapsed = newValue
            syncStateAndViewport(forceViewport: true)
        }
    }

    @objc func toggleLibrarySidebar(_ sender: Any? = nil) {
        if view.window != nil {
            toggleSidebar(sender)
        } else {
            sidebarSplitItem.isCollapsed.toggle()
        }
        syncStateAndViewport(forceViewport: true)
    }

    @objc func toggleInspectorPanel(_ sender: Any? = nil) {
        if propertiesPopover.isShown {
            inspectorViewController.cancelPendingLocalEdits()
            propertiesPopover.performClose(sender)
        } else {
            let anchor = canvasHostViewController.view
            propertiesPopover.show(relativeTo: NSRect(x: anchor.bounds.maxX - 16, y: anchor.bounds.maxY - 24, width: 1, height: 1), of: anchor, preferredEdge: .minX)
        }
        syncStateAndViewport(forceViewport: true)
    }

    @objc func toggleAgentInspectorTab(_ sender: Any? = nil) {
        inspectorSplitItem.isCollapsed.toggle()
        syncStateAndViewport(forceViewport: true)
    }

    func showInspectorTab(_ tab: WorkspaceInspectorTab) {
        if tab == .properties {
            if !propertiesPopover.isShown { toggleInspectorPanel() }
        } else {
            inspectorSplitItem.isCollapsed = false
        }
        syncStateAndViewport(forceViewport: true)
    }

    private var keepsOwnedColorPickerOpen: Bool {
        NSApp.isActive && inspectorViewController.hasActiveOwnedColorPickerSession
            && NSColorPanel.shared.isVisible && NSApp.keyWindow === NSColorPanel.shared
    }

    func popoverShouldClose(_ popover: NSPopover) -> Bool {
        guard popover === propertiesPopover else { return true }
        // The shared picker is a separate key window in this interaction.
        // Other outside clicks retain the normal transient-popover behaviour.
        if keepsOwnedColorPickerOpen { return false }
        inspectorViewController.cancelPendingLocalEdits()
        return true
    }

    // MARK: - NSUserInterfaceValidations

    override func validateUserInterfaceItem(_ item: NSValidatedUserInterfaceItem) -> Bool {
        guard let action = item.action else { return super.validateUserInterfaceItem(item) }
        if action == #selector(toggleLibrarySidebar(_:))
            || action == #selector(toggleInspectorPanel(_:))
            || action == #selector(toggleAgentInspectorTab(_:)) {
            return true
        }
        if WorkspaceFocusRouter.handlesEditSelector(action) {
            return WorkspaceFocusRouter.validateEditAction(
                action,
                in: currentWindow,
                canvasView: canvasHostViewController.canvasContentView,
                coordinator: coordinator
            )
        }
        return super.validateUserInterfaceItem(item)
    }

    // MARK: - Responder-First Menu / Shortcut Forwarding

    @objc func undo(_ sender: Any?) {
        WorkspaceFocusRouter.performEditAction(
            #selector(WorkspaceSplitViewController.undo(_:)),
            sender: sender,
            in: currentWindow,
            canvasView: canvasHostViewController.canvasContentView,
            coordinator: coordinator
        )
    }

    @objc func redo(_ sender: Any?) {
        WorkspaceFocusRouter.performEditAction(
            #selector(WorkspaceSplitViewController.redo(_:)),
            sender: sender,
            in: currentWindow,
            canvasView: canvasHostViewController.canvasContentView,
            coordinator: coordinator
        )
    }

    @objc func cut(_ sender: Any?) {
        WorkspaceFocusRouter.performEditAction(
            #selector(NSText.cut(_:)),
            sender: sender,
            in: currentWindow,
            canvasView: canvasHostViewController.canvasContentView,
            coordinator: coordinator
        )
    }

    @objc func copy(_ sender: Any?) {
        WorkspaceFocusRouter.performEditAction(
            #selector(NSText.copy(_:)),
            sender: sender,
            in: currentWindow,
            canvasView: canvasHostViewController.canvasContentView,
            coordinator: coordinator
        )
    }

    @objc func paste(_ sender: Any?) {
        WorkspaceFocusRouter.performEditAction(
            #selector(NSText.paste(_:)),
            sender: sender,
            in: currentWindow,
            canvasView: canvasHostViewController.canvasContentView,
            coordinator: coordinator
        )
    }

    @objc override func selectAll(_ sender: Any?) {
        WorkspaceFocusRouter.performEditAction(
            #selector(NSText.selectAll(_:)),
            sender: sender,
            in: currentWindow,
            canvasView: canvasHostViewController.canvasContentView,
            coordinator: coordinator
        )
    }

    @objc func delete(_ sender: Any?) {
        WorkspaceFocusRouter.performEditAction(
            #selector(NSText.delete(_:)),
            sender: sender,
            in: currentWindow,
            canvasView: canvasHostViewController.canvasContentView,
            coordinator: coordinator
        )
    }

    // MARK: - Private Setup

    private var currentWindow: NSWindow? {
        view.window ?? observedWindow
    }

    private func configureSplitItems() {
        sidebarSplitItem.minimumThickness = 210
        sidebarSplitItem.maximumThickness = 360
        sidebarSplitItem.canCollapse = true
        sidebarSplitItem.isCollapsed = true
        sidebarSplitItem.holdingPriority = NSLayoutConstraint.Priority(260)

        canvasSplitItem.minimumThickness = 420
        canvasSplitItem.holdingPriority = NSLayoutConstraint.Priority(200)

        inspectorSplitItem.minimumThickness = 270
        inspectorSplitItem.maximumThickness = 440
        inspectorSplitItem.canCollapse = true
        inspectorSplitItem.holdingPriority = NSLayoutConstraint.Priority(250)

        if #available(macOS 26.0, *) {
            sidebarSplitItem.automaticallyAdjustsSafeAreaInsets = true
            canvasSplitItem.automaticallyAdjustsSafeAreaInsets = true
            inspectorSplitItem.automaticallyAdjustsSafeAreaInsets = true
        }
    }

    private func wireComponents() {
        toolbarController.windowProvider = { [weak self] in self?.currentWindow }
        toolbarController.canvasViewProvider = { [weak self] in self?.canvasHostViewController.canvasContentView }
        toolbarController.onToggleSidebar = { [weak self] in self?.toggleLibrarySidebar() }
        toolbarController.onToggleInspector = { [weak self] in self?.toggleInspectorPanel() }
        canvasHostViewController.onShapeStyleRequested = { [weak self] in self?.showInspectorTab(.properties) }
        toolbarController.onToggleAgent = { [weak self] in self?.toggleAgentInspectorTab() }

        inspectorViewController.onSelectedTabChanged = { [weak self] _ in
            self?.syncStateAndViewport(forceViewport: false)
        }
        inspectorViewController.propertiesViewController.onRestoreCanvasFocus = { [weak self] in
            guard let self else { return }
            WorkspaceFocusRouter.restoreCanvasFocusIfSafe(
                in: self.currentWindow,
                canvasView: self.canvasHostViewController.canvasContentView
            )
        }

        coordinator.onBeforeFileCommand = { [weak self] in
            self?.inspectorViewController.cancelPendingLocalEdits()
        }
        coordinator.onReturnFocusToCanvas = { [weak self] in
            guard let self else { return }
            WorkspaceFocusRouter.restoreCanvasFocusIfSafe(
                in: self.currentWindow,
                canvasView: self.canvasHostViewController.canvasContentView
            )
        }
    }

    private func attachWindowObserversIfNeeded() {
        guard let window = currentWindow else { return }
        observedWindow = window

        if notificationObservers.isEmpty {
            let become = NotificationCenter.default.addObserver(
                forName: NSWindow.didBecomeKeyNotification,
                object: window,
                queue: .main
            ) { [weak self] _ in
                self?.pushHostFocusContext()
            }
            let resign = NotificationCenter.default.addObserver(
                forName: NSWindow.didResignKeyNotification,
                object: window,
                queue: .main
            ) { [weak self] _ in
                guard let self else { return }
                if !self.keepsOwnedColorPickerOpen { self.inspectorViewController.cancelPendingLocalEdits() }
                self.pushHostFocusContext()
            }
            let resignApplication = NotificationCenter.default.addObserver(
                forName: NSApplication.didResignActiveNotification,
                object: NSApp,
                queue: .main
            ) { [weak self] _ in
                guard let self else { return }
                self.inspectorViewController.cancelPendingLocalEdits()
                self.propertiesPopover.performClose(nil)
                self.pushHostFocusContext()
            }
            let becomeAnotherWindow = NotificationCenter.default.addObserver(
                forName: NSWindow.didBecomeKeyNotification,
                object: nil,
                queue: .main
            ) { [weak self, weak window] note in
                guard let self, let window, self.inspectorViewController.hasActiveOwnedColorPickerSession,
                      let next = note.object as? NSWindow,
                      next !== window,
                      next !== self.inspectorViewController.propertiesViewController.view.window else { return }
                var parent: NSWindow? = next
                while let candidate = parent {
                    if candidate === NSColorPanel.shared { return }
                    parent = candidate.parent
                }
                self.inspectorViewController.cancelPendingLocalEdits()
                self.propertiesPopover.performClose(nil)
            }
            notificationObservers = [become, resign, resignApplication, becomeAnotherWindow]
        }

        if firstResponderObservation == nil {
            firstResponderObservation = window.observe(\.firstResponder, options: [.new]) { [weak self] _, _ in
                self?.pushHostFocusContext()
                self?.toolbarController.refreshToolbarState()
            }
        }
    }

    private func syncStateAndViewport(forceViewport: Bool) {
        toolbarController.isSidebarVisible = !sidebarSplitItem.isCollapsed
        toolbarController.isInspectorVisible = propertiesPopover.isShown
        toolbarController.isAgentTabActive = !inspectorSplitItem.isCollapsed

        pushHostFocusContext()
        canvasHostViewController.publishHostViewportIfNeeded(force: forceViewport)
    }

    private func pushHostFocusContext() {
        let window = currentWindow
        let owner = WorkspaceFocusRouter.classifyFocusOwner(
            in: window,
            canvasView: canvasHostViewController.canvasContentView
        )
        coordinator.updateHostFocus(
            windowKey: window?.isKeyWindow ?? false,
            focusOwner: owner,
            inspectorVisible: !inspectorSplitItem.isCollapsed
        )
    }
}

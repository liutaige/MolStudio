import AppKit
import Foundation

/// Palette and material visual tokens used across standalone native MolStudio chrome.
enum WorkspaceAppearanceTokens {
    /// Default corner radius for floating tool and zoom capsules on macOS.
    static let floatingCornerRadius: CGFloat = 14
    /// Default corner radius for compact floating pills.
    static let compactPillCornerRadius: CGFloat = 12
    /// Accent blue aligned with native macOS control accent and the workbench demo.
    static let chemicalAccentColor: NSColor = .controlAccentColor

    /// Returns a subtle element badge fill/stroke accent while preserving legibility in Light and Dark mode.
    static func elementTintColor(for symbol: String) -> NSColor {
        switch symbol.uppercased() {
        case "C": return NSColor.labelColor
        case "H": return NSColor.secondaryLabelColor
        case "O": return NSColor.systemRed
        case "N": return NSColor.systemBlue
        case "S": return NSColor.systemOrange
        case "P": return NSColor.systemPurple
        case "F", "CL": return NSColor.systemGreen
        case "BR": return NSColor.systemBrown
        case "I": return NSColor.systemIndigo
        default: return NSColor.secondaryLabelColor
        }
    }

    /// Resolves a dynamic `NSColor` under the view's effective appearance so CGColor updates immediately on theme switches.
    static func resolvedCGColor(_ color: NSColor, for view: NSView) -> CGColor {
        var resolved: CGColor = color.cgColor
        view.effectiveAppearance.performAsCurrentDrawingAppearance {
            resolved = color.cgColor
        }
        return resolved
    }
}

/// Visual surface style for floating canvas chrome.
enum WorkspaceMaterialStyle: Equatable, Sendable {
    /// Primary floating HUD (tool palette, zoom pill).
    case floatingControl
    /// Compact interactive popover/card inside canvas.
    case compactOverlay
    /// Solid hairline-bordered surface when transparency is intentionally disabled.
    case solidCard
}

/// Adaptive material surface for floating workspace controls.
/// Uses `NSGlassEffectView` on macOS 26+ (with macOS 27+ `effectIsInteractive` independently guarded),
/// falls back to `NSVisualEffectView` on macOS 14/15, and switches to an opaque high-contrast surface
/// when macOS Reduce Transparency or Increase Contrast accessibility preferences are enabled.
final class WorkspaceMaterialSurfaceView: NSView {
    /// Container where callers add child views. Routed to the active material view's contentView when appropriate.
    let contentContainerView = NSView()

    var materialStyle: WorkspaceMaterialStyle {
        didSet {
            if oldValue != materialStyle {
                applyMaterialConfiguration()
            }
        }
    }

    var cornerRadius: CGFloat {
        didSet {
            if oldValue != cornerRadius {
                applyCornerRadius()
            }
        }
    }

    /// Requests interactive Liquid Glass highlight behavior on macOS 27+ when supported.
    var prefersInteractiveGlass: Bool {
        didSet {
            if oldValue != prefersInteractiveGlass {
                applyMaterialConfiguration()
            }
        }
    }

    var tintColor: NSColor? {
        didSet {
            applyMaterialConfiguration()
        }
    }

    private var accessibilityObserver: NSObjectProtocol?
    private var visualEffectView: NSVisualEffectView?
    private var glassBackingView: NSView?
    private let solidBackingLayerView = NSView()

    /// Exposed for diagnostics/tests to report which native backing path is active.
    private(set) var activeBackingDescription: String = "solid"

    init(
        style: WorkspaceMaterialStyle = .floatingControl,
        cornerRadius: CGFloat = WorkspaceAppearanceTokens.floatingCornerRadius,
        prefersInteractiveGlass: Bool = true,
        tintColor: NSColor? = nil
    ) {
        self.materialStyle = style
        self.cornerRadius = cornerRadius
        self.prefersInteractiveGlass = prefersInteractiveGlass
        self.tintColor = tintColor
        super.init(frame: .zero)
        setupHierarchy()
        observeAccessibilityChanges()
        applyMaterialConfiguration()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    deinit {
        if let observer = accessibilityObserver {
            NSWorkspace.shared.notificationCenter.removeObserver(observer)
        }
    }

    override var wantsUpdateLayer: Bool { true }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        needsDisplay = true
        applyResolvedColors()
    }

    override func updateLayer() {
        super.updateLayer()
        applyResolvedColors()
    }

    /// Manually refreshes backing mode (useful for deterministic unit tests simulating appearance/accessibility refresh).
    func refreshMaterialAppearance() {
        applyMaterialConfiguration()
        applyResolvedColors()
    }

    /// Allows tests to override accessibility Reduce Transparency / Increase Contrast detection without mutating global macOS settings.
    var accessibilityOverridesForTesting: (reduceTransparency: Bool, increaseContrast: Bool)? {
        didSet {
            applyMaterialConfiguration()
        }
    }

    private var effectiveReduceTransparency: Bool {
        accessibilityOverridesForTesting?.reduceTransparency ?? NSWorkspace.shared.accessibilityDisplayShouldReduceTransparency
    }

    private var effectiveIncreaseContrast: Bool {
        accessibilityOverridesForTesting?.increaseContrast ?? NSWorkspace.shared.accessibilityDisplayShouldIncreaseContrast
    }

    private func setupHierarchy() {
        wantsLayer = true
        layer?.masksToBounds = false

        solidBackingLayerView.wantsLayer = true
        solidBackingLayerView.translatesAutoresizingMaskIntoConstraints = false
        addSubview(solidBackingLayerView)

        contentContainerView.translatesAutoresizingMaskIntoConstraints = false

        if #available(macOS 26.0, *), materialStyle != .solidCard {
            let glass = NSGlassEffectView(frame: .zero)
            glass.translatesAutoresizingMaskIntoConstraints = false
            glass.contentView = contentContainerView
            addSubview(glass)
            glassBackingView = glass
            NSLayoutConstraint.activate([
                glass.leadingAnchor.constraint(equalTo: leadingAnchor),
                glass.trailingAnchor.constraint(equalTo: trailingAnchor),
                glass.topAnchor.constraint(equalTo: topAnchor),
                glass.bottomAnchor.constraint(equalTo: bottomAnchor),
            ])
        } else {
            let visual = NSVisualEffectView(frame: .zero)
            visual.translatesAutoresizingMaskIntoConstraints = false
            visual.blendingMode = .withinWindow
            visual.state = .followsWindowActiveState
            visual.wantsLayer = true
            addSubview(visual)
            visualEffectView = visual

            addSubview(contentContainerView)
            NSLayoutConstraint.activate([
                visual.leadingAnchor.constraint(equalTo: leadingAnchor),
                visual.trailingAnchor.constraint(equalTo: trailingAnchor),
                visual.topAnchor.constraint(equalTo: topAnchor),
                visual.bottomAnchor.constraint(equalTo: bottomAnchor),
                contentContainerView.leadingAnchor.constraint(equalTo: leadingAnchor),
                contentContainerView.trailingAnchor.constraint(equalTo: trailingAnchor),
                contentContainerView.topAnchor.constraint(equalTo: topAnchor),
                contentContainerView.bottomAnchor.constraint(equalTo: bottomAnchor),
            ])
        }

        NSLayoutConstraint.activate([
            solidBackingLayerView.leadingAnchor.constraint(equalTo: leadingAnchor),
            solidBackingLayerView.trailingAnchor.constraint(equalTo: trailingAnchor),
            solidBackingLayerView.topAnchor.constraint(equalTo: topAnchor),
            solidBackingLayerView.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])

        applyCornerRadius()
    }

    private func observeAccessibilityChanges() {
        accessibilityObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.accessibilityDisplayOptionsDidChangeNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.applyMaterialConfiguration()
        }
    }

    private func applyCornerRadius() {
        solidBackingLayerView.layer?.cornerRadius = cornerRadius
        solidBackingLayerView.layer?.masksToBounds = true
        visualEffectView?.layer?.cornerRadius = cornerRadius
        visualEffectView?.layer?.masksToBounds = true
        if #available(macOS 26.0, *), let glass = glassBackingView as? NSGlassEffectView {
            glass.cornerRadius = cornerRadius
        }
    }

    private func applyMaterialConfiguration() {
        let reduceTransparency = effectiveReduceTransparency
        let useSolid = reduceTransparency || materialStyle == .solidCard

        if useSolid {
            glassBackingView?.isHidden = true
            visualEffectView?.isHidden = true
            solidBackingLayerView.isHidden = false
            // Ensure content remains mounted directly above solid backing when Glass view is hidden.
            if contentContainerView.superview !== self {
                if #available(macOS 26.0, *), let glass = glassBackingView as? NSGlassEffectView {
                    glass.contentView = nil
                }
                addSubview(contentContainerView)
                NSLayoutConstraint.activate([
                    contentContainerView.leadingAnchor.constraint(equalTo: leadingAnchor),
                    contentContainerView.trailingAnchor.constraint(equalTo: trailingAnchor),
                    contentContainerView.topAnchor.constraint(equalTo: topAnchor),
                    contentContainerView.bottomAnchor.constraint(equalTo: bottomAnchor),
                ])
            }
            activeBackingDescription = reduceTransparency ? "solid-reduce-transparency" : "solid-card"
        } else if #available(macOS 26.0, *), let glass = glassBackingView as? NSGlassEffectView {
            solidBackingLayerView.isHidden = true
            visualEffectView?.isHidden = true
            glass.isHidden = false
            if glass.contentView !== contentContainerView {
                contentContainerView.removeFromSuperview()
                glass.contentView = contentContainerView
            }
            glass.style = materialStyle == .compactOverlay ? .clear : .regular
            glass.tintColor = tintColor
            glass.cornerRadius = cornerRadius
            if #available(macOS 27.0, *) {
                glass.effectIsInteractive = prefersInteractiveGlass
                activeBackingDescription = prefersInteractiveGlass ? "glass-macOS27-interactive" : "glass-macOS27"
            } else {
                activeBackingDescription = "glass-macOS26"
            }
        } else if let visual = visualEffectView {
            solidBackingLayerView.isHidden = true
            visual.isHidden = false
            visual.material = materialStyle == .compactOverlay ? .popover : .hudWindow
            visual.blendingMode = .withinWindow
            visual.state = .followsWindowActiveState
            activeBackingDescription = "visual-effect-fallback"
        }

        applyCornerRadius()
        applyResolvedColors()
    }

    private func applyResolvedColors() {
        let increaseContrast = effectiveIncreaseContrast
        let reduceTransparency = effectiveReduceTransparency

        solidBackingLayerView.wantsLayer = true
        solidBackingLayerView.layer?.backgroundColor = WorkspaceAppearanceTokens.resolvedCGColor(
            materialStyle == .compactOverlay ? NSColor.controlBackgroundColor : NSColor.windowBackgroundColor,
            for: self
        )

        if reduceTransparency || increaseContrast || visualEffectView != nil || materialStyle == .solidCard {
            let borderColor = increaseContrast
                ? NSColor.labelColor.withAlphaComponent(0.38)
                : NSColor.separatorColor.withAlphaComponent(reduceTransparency ? 0.85 : 0.45)
            solidBackingLayerView.layer?.borderWidth = increaseContrast ? 1.5 : 1.0
            solidBackingLayerView.layer?.borderColor = WorkspaceAppearanceTokens.resolvedCGColor(borderColor, for: self)

            visualEffectView?.layer?.borderWidth = increaseContrast ? 1.25 : 0.75
            visualEffectView?.layer?.borderColor = WorkspaceAppearanceTokens.resolvedCGColor(borderColor, for: self)
        } else {
            solidBackingLayerView.layer?.borderWidth = 0
        }

        layer?.shadowColor = WorkspaceAppearanceTokens.resolvedCGColor(NSColor.black.withAlphaComponent(0.18), for: self)
        layer?.shadowOpacity = 1.0
        layer?.shadowRadius = 10
        layer?.shadowOffset = NSSize(width: 0, height: -2)
    }
}

/// Optional Glass container wrapper grouping multiple floating HUD capsules on macOS 26+ while allowing click-through gaps.
final class WorkspaceFloatingGlassGroupView: NSView {
    let contentView = NSView()

    init(spacing: CGFloat = 10) {
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        contentView.translatesAutoresizingMaskIntoConstraints = false

        if #available(macOS 26.0, *) {
            let container = NSGlassEffectContainerView(frame: .zero)
            container.translatesAutoresizingMaskIntoConstraints = false
            container.spacing = spacing
            container.contentView = contentView
            addSubview(container)
            NSLayoutConstraint.activate([
                container.leadingAnchor.constraint(equalTo: leadingAnchor),
                container.trailingAnchor.constraint(equalTo: trailingAnchor),
                container.topAnchor.constraint(equalTo: topAnchor),
                container.bottomAnchor.constraint(equalTo: bottomAnchor),
            ])
        } else {
            addSubview(contentView)
            NSLayoutConstraint.activate([
                contentView.leadingAnchor.constraint(equalTo: leadingAnchor),
                contentView.trailingAnchor.constraint(equalTo: trailingAnchor),
                contentView.topAnchor.constraint(equalTo: topAnchor),
                contentView.bottomAnchor.constraint(equalTo: bottomAnchor),
            ])
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    override func hitTest(_ point: NSPoint) -> NSView? {
        let localPoint = convert(point, from: superview)
        guard bounds.contains(localPoint) else { return nil }
        for subview in contentView.subviews.reversed() where !subview.isHidden {
            let converted = convert(point, from: superview)
            let targetPoint = subview.convert(converted, from: self)
            if let hit = subview.hitTest(targetPoint) {
                return hit
            }
        }
        return nil
    }
}

/// Crisp opaque chemistry workspace backdrop so rendered bonds, atoms, and paper sheets remain unaffected by frosted glass.
final class WorkspaceCanvasBackdropView: NSView {
    enum BackdropTone: Equatable, Sendable {
        case cleanWhite
        case softPaperDesk
        case subtleGridWhite
    }

    var tone: BackdropTone {
        didSet {
            if oldValue != tone {
                needsDisplay = true
            }
        }
    }

    init(tone: BackdropTone = .cleanWhite) {
        self.tone = tone
        super.init(frame: .zero)
        wantsLayer = true
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    override var isOpaque: Bool { true }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        needsDisplay = true
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        let isDark = effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        let bgColor: NSColor
        switch tone {
        case .cleanWhite, .subtleGridWhite:
            bgColor = isDark
                ? NSColor(srgbRed: 0x1A / 255.0, green: 0x1B / 255.0, blue: 0x1E / 255.0, alpha: 1.0)
                : NSColor.white
        case .softPaperDesk:
            bgColor = isDark
                ? NSColor(srgbRed: 0x1D / 255.0, green: 0x1F / 255.0, blue: 0x23 / 255.0, alpha: 1.0)
                : NSColor(calibratedWhite: 0.96, alpha: 1.0)
        }
        bgColor.setFill()
        dirtyRect.fill()

        if tone == .subtleGridWhite {
            (isDark ? NSColor(calibratedWhite: 0.165, alpha: 1.0) : NSColor(calibratedWhite: 0.91, alpha: 1.0)).setFill()
            let spacing: CGFloat = 20
            let startX = floor(dirtyRect.minX / spacing) * spacing
            let startY = floor(dirtyRect.minY / spacing) * spacing
            var x = startX
            while x <= dirtyRect.maxX {
                var y = startY
                while y <= dirtyRect.maxY {
                    NSRect(x: x - 0.5, y: y - 0.5, width: 1.2, height: 1.2).fill()
                    y += spacing
                }
                x += spacing
            }
        }
    }
}

/// Standard Cocoa clipboard actions routed to the host canvas pipeline (WKWebView native pasteboard + DOM events)
/// rather than semantic `edit.*` commands in contract v1.
enum WorkspaceCanvasClipboardAction: String, Sendable {
    case cut
    case copy
    case paste
}

/// Responder-first keyboard/menu routing between native macOS text inputs and the canvas JS editor.
enum WorkspaceFocusRouter {
    static let undoSelector = NSSelectorFromString("undo:")
    static let redoSelector = NSSelectorFromString("redo:")

    private static let editSelectors: Set<Selector> = [
        #selector(UndoManager.undo),
        #selector(UndoManager.redo),
        undoSelector,
        redoSelector,
        #selector(NSText.cut(_:)),
        #selector(NSText.copy(_:)),
        #selector(NSText.paste(_:)),
        #selector(NSText.selectAll(_:)),
        #selector(NSText.delete(_:)),
        #selector(NSResponder.deleteBackward(_:)),
        #selector(NSResponder.deleteForward(_:))
    ]

    /// Classifies which high-level domain owns focus in `window` relative to `canvasView`.
    static func classifyFocusOwner(in window: NSWindow?, canvasView: NSView?) -> WorkspaceFocusOwner {
        guard let window else { return .none }
        guard let firstResponder = window.firstResponder else { return .none }

        if let responderView = firstResponder as? NSView {
            if let canvasView, (responderView === canvasView || responderView.isDescendant(of: canvasView)) {
                return .canvas
            }
            if isNativeTextInputResponder(responderView) {
                return .nativeText
            }
            return .nativeChrome
        }

        if firstResponder === window {
            return .none
        }
        return .nativeChrome
    }

    static func isEditableNativeTextResponder(_ responder: NSResponder?) -> Bool {
        guard let responder else { return false }
        if let textView = responder as? NSTextView {
            return textView.isEditable
        }
        if let textField = responder as? NSTextField {
            return textField.isEditable || textField.currentEditor() != nil
        }
        if let searchField = responder as? NSSearchField {
            return searchField.isEditable || searchField.currentEditor() != nil
        }
        if let comboBox = responder as? NSComboBox {
            return comboBox.isEditable || comboBox.currentEditor() != nil
        }
        return false
    }

    /// True for any editable field/textView OR readonly selectable `NSTextView` (such as rendered assistant responses).
    static func isNativeTextInputResponder(_ responder: NSResponder?) -> Bool {
        guard let responder else { return false }
        if let textView = responder as? NSTextView {
            return textView.isEditable || textView.isSelectable
        }
        if let textField = responder as? NSTextField {
            return textField.isEditable || textField.isSelectable || textField.currentEditor() != nil
        }
        if let searchField = responder as? NSSearchField {
            return searchField.isEditable || searchField.isSelectable || searchField.currentEditor() != nil
        }
        if let comboBox = responder as? NSComboBox {
            return comboBox.isEditable || comboBox.isSelectable || comboBox.currentEditor() != nil
        }
        return false
    }

    static func handlesEditSelector(_ selector: Selector) -> Bool {
        editSelectors.contains(selector)
            || semanticEditCommandId(for: selector) != nil
            || canvasClipboardAction(for: selector) != nil
    }

    /// Maps non-clipboard standard Cocoa edit selectors onto semantic JS `edit.*` commands allowed by contract v1.
    static func semanticEditCommandId(for selector: Selector) -> String? {
        if selector == undoSelector || selector == #selector(UndoManager.undo) {
            return "edit.undo"
        }
        if selector == redoSelector || selector == #selector(UndoManager.redo) {
            return "edit.redo"
        }
        if selector == #selector(NSText.selectAll(_:)) {
            return "edit.selectAll"
        }
        if selector == #selector(NSText.delete(_:))
            || selector == #selector(NSResponder.deleteBackward(_:))
            || selector == #selector(NSResponder.deleteForward(_:)) {
            return "edit.delete"
        }
        return nil
    }

    /// Maps Cocoa clipboard selectors onto host clipboard actions (never sent as `nativeUI.dispatch("edit.copy/cut/paste")`).
    static func canvasClipboardAction(for selector: Selector) -> WorkspaceCanvasClipboardAction? {
        if selector == #selector(NSText.cut(_:)) {
            return .cut
        }
        if selector == #selector(NSText.copy(_:)) {
            return .copy
        }
        if selector == #selector(NSText.paste(_:)) {
            return .paste
        }
        return nil
    }

    static func legacyCanvasEditAction(for selector: Selector) -> WorkspaceLegacyCanvasEditAction? {
        if selector == undoSelector || selector == #selector(UndoManager.undo) {
            return .undo
        }
        if selector == redoSelector || selector == #selector(UndoManager.redo) {
            return .redo
        }
        if selector == #selector(NSText.selectAll(_:)) {
            return .selectAll
        }
        if selector == #selector(NSText.delete(_:))
            || selector == #selector(NSResponder.deleteBackward(_:))
            || selector == #selector(NSResponder.deleteForward(_:)) {
            return .delete
        }
        return nil
    }

    private static func normalizedNativeSelector(for selector: Selector) -> Selector {
        if selector == #selector(UndoManager.undo) {
            return undoSelector
        }
        if selector == #selector(UndoManager.redo) {
            return redoSelector
        }
        return selector
    }

    private static func isMutatingTextSelector(_ selector: Selector) -> Bool {
        let native = normalizedNativeSelector(for: selector)
        return native == undoSelector
            || native == redoSelector
            || native == #selector(NSText.cut(_:))
            || native == #selector(NSText.paste(_:))
            || native == #selector(NSText.delete(_:))
            || native == #selector(NSResponder.deleteBackward(_:))
            || native == #selector(NSResponder.deleteForward(_:))
    }

    /// Validates whether `selector` is currently enabled under responder-first rules.
    /// Falls back cleanly to legacy canvas JS/AppKit handlers when attach fails, no editing
    /// surface is owned, or `coordinator == nil`, while preserving navigation and `.nativeChrome` gates.
    static func validateEditAction(
        _ selector: Selector,
        in window: NSWindow?,
        canvasView: NSView?,
        coordinator: WorkspaceStateCoordinator?,
        legacyClipboardValidator: ((WorkspaceCanvasClipboardAction) -> Bool)? = nil,
        legacyEditValidator: ((WorkspaceLegacyCanvasEditAction) -> Bool)? = nil
    ) -> Bool {
        guard handlesEditSelector(selector) else {
            return false
        }
        let owner = classifyFocusOwner(in: window, canvasView: canvasView)

        if owner == .nativeText, let textResponder = window?.firstResponder {
            let nativeSelector = normalizedNativeSelector(for: selector)
            let isEditable = isEditableNativeTextResponder(textResponder)
            if isMutatingTextSelector(nativeSelector) && !isEditable {
                return false
            }
            if let textView = textResponder as? NSTextView {
                if nativeSelector == undoSelector {
                    return textView.isEditable && (textView.undoManager?.canUndo ?? false)
                }
                if nativeSelector == redoSelector {
                    return textView.isEditable && (textView.undoManager?.canRedo ?? false)
                }
                if nativeSelector == #selector(NSText.copy(_:)) {
                    return (textView.isEditable || textView.isSelectable) && textView.selectedRange().length > 0
                }
                if nativeSelector == #selector(NSText.cut(_:)) {
                    return textView.isEditable && textView.selectedRange().length > 0
                }
                if nativeSelector == #selector(NSText.paste(_:)) {
                    return textView.isEditable
                }
                if nativeSelector == #selector(NSText.selectAll(_:)) {
                    return (textView.isEditable || textView.isSelectable) && !textView.string.isEmpty
                }
                if nativeSelector == #selector(NSText.delete(_:)) {
                    // Only enable Edit -> Delete when an actual range is selected so empty-selection Backspace (`\u{8}`) is never hijacked.
                    return textView.isEditable && textView.selectedRange().length > 0
                }
                if nativeSelector == #selector(NSResponder.deleteBackward(_:))
                    || nativeSelector == #selector(NSResponder.deleteForward(_:)) {
                    return textView.isEditable
                }
            }
            if let validator = textResponder as? any NSUserInterfaceValidations {
                let dummy = NSMenuItem(title: "", action: nativeSelector, keyEquivalent: "")
                return validator.validateUserInterfaceItem(dummy)
            }
            return textResponder.responds(to: nativeSelector)
        }

        if let canvasWin = canvasView?.window, let window, canvasWin !== window {
            return false
        }

        let allowCanvasFallback = (owner == .canvas) || (owner == .none && window != nil && canvasView != nil)
        guard allowCanvasFallback else {
            return false
        }

        let nativeSelector = normalizedNativeSelector(for: selector)
        let responderStart: NSResponder? = (owner == .canvas ? window?.firstResponder : canvasView)
        let hasCanvasResponderTarget = responderStart.flatMap {
            responderTarget(from: $0, selector: nativeSelector, excludingWindowDelegate: window?.delegate)
        } != nil

        if let coordinator {
            guard !coordinator.documentMetadata.isNavigationInFlight else {
                return false
            }
            if let clipboardAction = canvasClipboardAction(for: selector) {
                if coordinator.fileCallbacks.onCanvasClipboardAction != nil
                    || coordinator.fileCallbacks.canPerformCanvasClipboardAction != nil {
                    return coordinator.canPerformCanvasClipboardAction(clipboardAction)
                }
                if let legacyClipboardValidator {
                    return legacyClipboardValidator(clipboardAction)
                }
                return hasCanvasResponderTarget
            }
            guard let commandId = semanticEditCommandId(for: selector) else {
                return false
            }
            if coordinator.hasOwnedCanvasEditingSurface {
                if commandId == "edit.undo" {
                    return coordinator.isCommandSupported("edit.undo") && coordinator.uiState.history.canUndo
                }
                if commandId == "edit.redo" {
                    return coordinator.isCommandSupported("edit.redo") && coordinator.uiState.history.canRedo
                }
                return coordinator.isCommandSupported(commandId)
            }
            if let legacyAction = legacyCanvasEditAction(for: selector) {
                if coordinator.fileCallbacks.onLegacyCanvasEditAction != nil
                    || coordinator.fileCallbacks.canPerformLegacyCanvasEditAction != nil {
                    return coordinator.canPerformLegacyCanvasEditAction(legacyAction)
                }
                if let legacyEditValidator {
                    return legacyEditValidator(legacyAction)
                }
            }
            return hasCanvasResponderTarget
        }

        if let clipboardAction = canvasClipboardAction(for: selector) {
            if let legacyClipboardValidator {
                return legacyClipboardValidator(clipboardAction)
            }
            return hasCanvasResponderTarget
        }
        if let legacyAction = legacyCanvasEditAction(for: selector), let legacyEditValidator {
            return legacyEditValidator(legacyAction)
        }
        return hasCanvasResponderTarget
    }

    /// Routes an edit action (`undo:`, `redo:`, `cut:`, `copy:`, `paste:`, `selectAll:`, `delete:`) responder-first.
    /// Falls back cleanly to legacy canvas JS/AppKit handlers when attach fails, no editing
    /// surface is owned, or `coordinator == nil`, without swallowing events or stealing `.nativeText` focus.
    @discardableResult
    static func performEditAction(
        _ selector: Selector,
        sender: Any?,
        in window: NSWindow?,
        canvasView: NSView?,
        coordinator: WorkspaceStateCoordinator?,
        legacyClipboardHandler: ((WorkspaceCanvasClipboardAction, Any?) -> Bool)? = nil,
        legacyClipboardValidator: ((WorkspaceCanvasClipboardAction) -> Bool)? = nil,
        legacyEditHandler: ((WorkspaceLegacyCanvasEditAction, Any?) -> Bool)? = nil,
        legacyEditValidator: ((WorkspaceLegacyCanvasEditAction) -> Bool)? = nil,
        completion: ((Result<WorkspaceCommandReply, Error>) -> Void)? = nil
    ) -> Bool {
        guard handlesEditSelector(selector) else {
            return false
        }

        let owner = classifyFocusOwner(in: window, canvasView: canvasView)

        if owner == .nativeText, let responder = window?.firstResponder {
            let nativeSelector = normalizedNativeSelector(for: selector)
            if isMutatingTextSelector(nativeSelector) && !isEditableNativeTextResponder(responder) {
                return false
            }
            if let textView = responder as? NSTextView,
               nativeSelector == #selector(NSText.delete(_:)),
               textView.selectedRange().length == 0 {
                return false
            }
            if nativeSelector == undoSelector {
                if let um = responder.undoManager, um.canUndo {
                    um.undo()
                    return true
                }
                return false
            }
            if nativeSelector == redoSelector {
                if let um = responder.undoManager, um.canRedo {
                    um.redo()
                    return true
                }
                return false
            }
            if let target = responderTarget(from: responder, selector: nativeSelector, excludingWindowDelegate: window?.delegate) {
                return NSApp.sendAction(nativeSelector, to: target, from: sender)
            }
            return false
        }

        if let canvasWin = canvasView?.window, let window, canvasWin !== window {
            return false
        }

        let allowCanvasFallback = (owner == .canvas) || (owner == .none && window != nil && canvasView != nil)
        guard allowCanvasFallback else {
            return false
        }

        let nativeSelector = normalizedNativeSelector(for: selector)
        let sendCanvasResponderAction: () -> Bool = {
            if owner == .none {
                restoreCanvasFocusIfSafe(in: window, canvasView: canvasView)
            }
            let start: NSResponder? = (owner == .canvas ? window?.firstResponder : canvasView) ?? canvasView
            guard let start,
                  let target = responderTarget(from: start, selector: nativeSelector, excludingWindowDelegate: window?.delegate) else {
                return false
            }
            return NSApp.sendAction(nativeSelector, to: target, from: sender)
        }

        if let coordinator {
            guard !coordinator.documentMetadata.isNavigationInFlight else {
                return false
            }
            if let clipboardAction = canvasClipboardAction(for: selector) {
                if coordinator.fileCallbacks.onCanvasClipboardAction != nil
                    || coordinator.fileCallbacks.canPerformCanvasClipboardAction != nil {
                    guard coordinator.canPerformCanvasClipboardAction(clipboardAction) else {
                        return false
                    }
                    if owner == .none {
                        restoreCanvasFocusIfSafe(in: window, canvasView: canvasView)
                    }
                    return coordinator.performCanvasClipboardAction(clipboardAction, sender: sender)
                }
                if let legacyClipboardHandler {
                    guard legacyClipboardValidator?(clipboardAction) ?? true else {
                        return false
                    }
                    if owner == .none {
                        restoreCanvasFocusIfSafe(in: window, canvasView: canvasView)
                    }
                    return legacyClipboardHandler(clipboardAction, sender)
                }
                return sendCanvasResponderAction()
            }

            guard let commandId = semanticEditCommandId(for: selector) else {
                return false
            }

            if coordinator.hasOwnedCanvasEditingSurface {
                guard coordinator.isCommandSupported(commandId) else {
                    return false
                }
                if commandId == "edit.undo", !coordinator.uiState.history.canUndo {
                    return false
                }
                if commandId == "edit.redo", !coordinator.uiState.history.canRedo {
                    return false
                }
                if owner == .none {
                    restoreCanvasFocusIfSafe(in: window, canvasView: canvasView)
                }
                coordinator.dispatchCommand(id: commandId, completion: completion)
                return true
            }

            if let legacyAction = legacyCanvasEditAction(for: selector) {
                if coordinator.fileCallbacks.onLegacyCanvasEditAction != nil
                    || coordinator.fileCallbacks.canPerformLegacyCanvasEditAction != nil {
                    guard coordinator.canPerformLegacyCanvasEditAction(legacyAction) else {
                        return false
                    }
                    if owner == .none {
                        restoreCanvasFocusIfSafe(in: window, canvasView: canvasView)
                    }
                    return coordinator.performLegacyCanvasEditAction(legacyAction, sender: sender)
                }
                if let legacyEditHandler {
                    guard legacyEditValidator?(legacyAction) ?? true else {
                        return false
                    }
                    if owner == .none {
                        restoreCanvasFocusIfSafe(in: window, canvasView: canvasView)
                    }
                    return legacyEditHandler(legacyAction, sender)
                }
            }
            return sendCanvasResponderAction()
        }

        if let clipboardAction = canvasClipboardAction(for: selector) {
            if let legacyClipboardHandler {
                guard legacyClipboardValidator?(clipboardAction) ?? true else {
                    return false
                }
                if owner == .none {
                    restoreCanvasFocusIfSafe(in: window, canvasView: canvasView)
                }
                return legacyClipboardHandler(clipboardAction, sender)
            }
            return sendCanvasResponderAction()
        }
        if let legacyAction = legacyCanvasEditAction(for: selector), let legacyEditHandler {
            guard legacyEditValidator?(legacyAction) ?? true else {
                return false
            }
            if owner == .none {
                restoreCanvasFocusIfSafe(in: window, canvasView: canvasView)
            }
            return legacyEditHandler(legacyAction, sender)
        }
        return sendCanvasResponderAction()
    }

    /// Restores keyboard focus to `canvasView` after a non-text canvas tool/toolbar action without interrupting native text entry.
    static func restoreCanvasFocusIfSafe(in window: NSWindow?, canvasView: NSView?) {
        guard let window, let canvasView else { return }
        let owner = classifyFocusOwner(in: window, canvasView: canvasView)
        guard owner != .nativeText else { return }
        if window.firstResponder !== canvasView {
            window.makeFirstResponder(canvasView)
        }
    }

    private static func responderTarget(
        from start: NSResponder,
        selector: Selector,
        excludingWindowDelegate delegate: AnyObject?
    ) -> NSResponder? {
        var current: NSResponder? = start
        while let node = current {
            if let delegate, (node as AnyObject) === delegate {
                return nil
            }
            if node is NSWindow || node is NSViewController {
                return nil
            }
            if node.responds(to: selector) {
                return node
            }
            current = node.nextResponder
        }
        return nil
    }
}

/// Crisp vector chemical and UI icon synthesizer matching `NSImage.isTemplate = true` for Light/Dark adaptation.
enum WorkspaceIconHelper {
    static func symbolImage(_ systemName: String, accessibilityDescription: String? = nil, pointSize: CGFloat = 14) -> NSImage {
        if let image = NSImage(systemSymbolName: systemName, accessibilityDescription: accessibilityDescription) {
            let config = NSImage.SymbolConfiguration(pointSize: pointSize, weight: .medium)
            let configured = image.withSymbolConfiguration(config) ?? image
            configured.isTemplate = true
            return configured
        }
        return NSImage(size: NSSize(width: 16, height: 16))
    }

    /// Returns a crisp vector icon for any v1 tool/template ID, using SF Symbols for standard chrome and CoreGraphics for chemistry glyphs.
    static func toolIcon(for toolId: String) -> NSImage {
        switch toolId {
        case "select", "tool.select", "select.structure", "select.fragment":
            return symbolImage("cursorarrow", accessibilityDescription: "选择")
        case "lasso", "tool.lasso":
            return symbolImage("lasso", accessibilityDescription: "套索")
        case "reactionPlus":
            return symbolImage("plus", accessibilityDescription: "反应加号")
        case "hand", "tool.hand":
            return symbolImage("hand.raised", accessibilityDescription: "抓手平移")
        case "erase", "tool.erase":
            return symbolImage("eraser", accessibilityDescription: "橡皮擦")
        case "text", "tool.text":
            return symbolImage("textformat", accessibilityDescription: "文本标签")
        case "image", "tool.image":
            return symbolImage("photo", accessibilityDescription: "插入图片")
        case "shape.rect", "tool.shape.rect":
            return symbolImage("rectangle", accessibilityDescription: "矩形")
        case "shape.ellipse", "tool.shape.ellipse":
            return symbolImage("circle", accessibilityDescription: "椭圆")
        case "shape.line", "tool.shape.line":
            return symbolImage("line.diagonal", accessibilityDescription: "直线")
        case "bracket", "tool.bracket":
            return templateGlyph(size: NSSize(width: 18, height: 18)) { rect in
                let path = NSBezierPath()
                path.lineWidth = 1.6
                path.lineCapStyle = .round
                path.move(to: NSPoint(x: rect.minX + 6.5, y: rect.minY + 3))
                path.line(to: NSPoint(x: rect.minX + 3.5, y: rect.minY + 3))
                path.line(to: NSPoint(x: rect.minX + 3.5, y: rect.maxY - 3))
                path.line(to: NSPoint(x: rect.minX + 6.5, y: rect.maxY - 3))
                path.move(to: NSPoint(x: rect.maxX - 6.5, y: rect.minY + 3))
                path.line(to: NSPoint(x: rect.maxX - 3.5, y: rect.minY + 3))
                path.line(to: NSPoint(x: rect.maxX - 3.5, y: rect.maxY - 3))
                path.line(to: NSPoint(x: rect.maxX - 6.5, y: rect.maxY - 3))
                path.stroke()
            }
        case "bond.single", "tool.bond.single":
            return templateGlyph(size: NSSize(width: 18, height: 18)) { rect in
                let path = NSBezierPath()
                path.lineWidth = 1.7
                path.lineCapStyle = .round
                path.move(to: NSPoint(x: rect.minX + 3.5, y: rect.minY + 4))
                path.line(to: NSPoint(x: rect.maxX - 3.5, y: rect.maxY - 4))
                path.stroke()
            }
        case "bond.double", "tool.bond.double":
            return templateGlyph(size: NSSize(width: 18, height: 18)) { rect in
                let path = NSBezierPath()
                path.lineWidth = 1.4
                path.lineCapStyle = .round
                path.move(to: NSPoint(x: rect.minX + 3.5, y: rect.minY + 5.5))
                path.line(to: NSPoint(x: rect.maxX - 5.5, y: rect.maxY - 3.5))
                path.move(to: NSPoint(x: rect.minX + 5.5, y: rect.minY + 3.5))
                path.line(to: NSPoint(x: rect.maxX - 3.5, y: rect.maxY - 5.5))
                path.stroke()
            }
        case "bond.triple", "tool.bond.triple":
            return templateGlyph(size: NSSize(width: 18, height: 18)) { rect in
                let path = NSBezierPath()
                path.lineWidth = 1.2
                path.lineCapStyle = .round
                for delta: CGFloat in [-2.6, 0, 2.6] {
                    path.move(to: NSPoint(x: rect.minX + 4 + delta * 0.45, y: rect.minY + 4.5 - delta * 0.45))
                    path.line(to: NSPoint(x: rect.maxX - 4 + delta * 0.45, y: rect.maxY - 4.5 - delta * 0.45))
                }
                path.stroke()
            }
        case "bond.wedge", "tool.bond.wedge":
            return templateGlyph(size: NSSize(width: 18, height: 18)) { rect in
                let path = NSBezierPath()
                path.move(to: NSPoint(x: rect.minX + 3.5, y: rect.minY + 4))
                path.line(to: NSPoint(x: rect.maxX - 3.5, y: rect.maxY - 6))
                path.line(to: NSPoint(x: rect.maxX - 6, y: rect.maxY - 3))
                path.close()
                path.fill()
            }
        case "bond.hashed", "bond.dash", "tool.bond.dash":
            return templateGlyph(size: NSSize(width: 18, height: 18)) { rect in
                let path = NSBezierPath()
                path.lineWidth = 1.4
                path.lineCapStyle = .round
                for step in 0..<4 {
                    let t = CGFloat(step) / 3.0
                    let center = NSPoint(x: 4.5 + t * (rect.width - 9), y: 4.5 + t * (rect.height - 9))
                    let half = 0.8 + t * 1.8
                    path.move(to: NSPoint(x: center.x - half * 0.65, y: center.y + half * 0.65))
                    path.line(to: NSPoint(x: center.x + half * 0.65, y: center.y - half * 0.65))
                }
                path.stroke()
            }
        case "bond.wavy", "tool.bond.wavy":
            return templateGlyph(size: NSSize(width: 18, height: 18)) { _ in
                let path = NSBezierPath()
                path.lineWidth = 1.45
                path.lineCapStyle = .round
                path.move(to: NSPoint(x: 3, y: 5))
                path.curve(to: NSPoint(x: 9, y: 9), controlPoint1: NSPoint(x: 4.5, y: 9), controlPoint2: NSPoint(x: 7.5, y: 5))
                path.curve(to: NSPoint(x: 15, y: 13), controlPoint1: NSPoint(x: 10.5, y: 13), controlPoint2: NSPoint(x: 13.5, y: 9))
                path.stroke()
            }
        case "chain", "tool.chain":
            return templateGlyph(size: NSSize(width: 18, height: 18)) { _ in
                let path = NSBezierPath()
                path.lineWidth = 1.5
                path.lineJoinStyle = .round
                path.lineCapStyle = .round
                path.move(to: NSPoint(x: 2.5, y: 6.5))
                path.line(to: NSPoint(x: 6.5, y: 11.5))
                path.line(to: NSPoint(x: 11, y: 6.5))
                path.line(to: NSPoint(x: 15.5, y: 11.5))
                path.stroke()
            }
        case "ring.benzene", "template.benzene", "tool.ring.benzene", "template-0":
            return polygonGlyph(sides: 6, aromatic: true)
        case "ring.cyclopentadiene", "template.cyclopentadiene", "tool.ring.cyclopentadiene", "template-1":
            return polygonGlyph(sides: 5, aromatic: true)
        case "ring.cyclohexane", "template.cyclohexane", "tool.ring.cyclohexane", "template-2":
            return polygonGlyph(sides: 6, aromatic: false)
        case "ring.cyclopentane", "template.cyclopentane", "tool.ring.cyclopentane", "template-3":
            return polygonGlyph(sides: 5, aromatic: false)
        case "ring.cyclopropane", "template.cyclopropane", "tool.ring.cyclopropane", "template-4":
            return polygonGlyph(sides: 3, aromatic: false)
        case "ring.cyclobutane", "template.cyclobutane", "tool.ring.cyclobutane", "template-5":
            return polygonGlyph(sides: 4, aromatic: false)
        case "ring.cycloheptane", "template.cycloheptane", "tool.ring.cycloheptane", "template-6":
            return polygonGlyph(sides: 7, aromatic: false)
        case "ring.cyclooctane", "template.cyclooctane", "tool.ring.cyclooctane", "template-7":
            return polygonGlyph(sides: 8, aromatic: false)
        case "document.select", "tool.document.select":
            return symbolImage("cursorarrow", accessibilityDescription: "选择纸页对象")
        case "document.text", "tool.document.text":
            return symbolImage("text.bubble", accessibilityDescription: "纸页文本框")
        case "document.image", "tool.document.image":
            return symbolImage("photo.badge.plus", accessibilityDescription: "插入图片")
        case "document.shape.rect", "tool.document.shape.rect":
            return symbolImage("rectangle", accessibilityDescription: "矩形")
        case "document.shape.ellipse", "tool.document.shape.ellipse":
            return symbolImage("circle", accessibilityDescription: "椭圆")
        case "document.shape.line", "tool.document.shape.line":
            return symbolImage("line.diagonal", accessibilityDescription: "直线")
        case "mode.paper":
            return symbolImage("doc.richtext", accessibilityDescription: "纸页文档")
        case "mode.canvas":
            return symbolImage("rectangle.dashed", accessibilityDescription: "无边画布")
        case "chargePlus", "charge.plus", "tool.charge.plus":
            return symbolImage("plus.circle", accessibilityDescription: "正电荷")
        case "chargeMinus", "charge.minus", "tool.charge.minus":
            return symbolImage("minus.circle", accessibilityDescription: "负电荷")
        case "reactionArrow", "arrow.reaction", "tool.arrow.reaction":
            return symbolImage("arrow.right", accessibilityDescription: "反应箭头")
        case "retrosyntheticArrow", "arrow.retrosynthetic", "tool.arrow.retrosynthetic":
            return templateGlyph(size: NSSize(width: 18, height: 18)) { _ in
                let path = NSBezierPath()
                path.lineWidth = 1.35
                path.move(to: NSPoint(x: 2.5, y: 7.2))
                path.line(to: NSPoint(x: 12.5, y: 7.2))
                path.move(to: NSPoint(x: 2.5, y: 10.8))
                path.line(to: NSPoint(x: 12.5, y: 10.8))
                path.move(to: NSPoint(x: 10.5, y: 5))
                path.line(to: NSPoint(x: 15.2, y: 9))
                path.line(to: NSPoint(x: 10.5, y: 13))
                path.stroke()
            }
        case "equilibriumArrow", "arrow.equilibrium", "tool.arrow.equilibrium":
            return symbolImage("arrow.left.arrow.right", accessibilityDescription: "可逆平衡箭头")
        case "resonanceArrow", "arrow.resonance", "tool.arrow.resonance":
            return symbolImage("arrow.left.and.right", accessibilityDescription: "共振箭头")
        case "electronPairArrow", "mechanism.full", "tool.mechanism.full":
            // Mirror the canvas arrow: 2e = long double-head barb. Curve first,
            // then a filled kite-shaped head pointing back along the curve.
            return templateGlyph(size: NSSize(width: 18, height: 18)) { _ in
                let path = NSBezierPath()
                path.lineWidth = 1.6
                path.lineCapStyle = .round
                path.move(to: NSPoint(x: 3, y: 5))
                path.curve(to: NSPoint(x: 13.6, y: 8.8), controlPoint1: NSPoint(x: 5, y: 12.8), controlPoint2: NSPoint(x: 9.6, y: 13))
                path.stroke()
                let head = NSBezierPath()
                head.move(to: NSPoint(x: 16.3, y: 6.4))
                head.line(to: NSPoint(x: 12.2, y: 10.6))
                head.line(to: NSPoint(x: 10.4, y: 6.2))
                head.close()
                head.fill()
            }
        case "fishhookArrow", "mechanism.half", "tool.mechanism.half":
            // Mirror the canvas arrow: 1e = same curve with a half-barb (one
            // long stroke + one short) instead of a filled head.
            return templateGlyph(size: NSSize(width: 18, height: 18)) { _ in
                let path = NSBezierPath()
                path.lineWidth = 1.6
                path.lineCapStyle = .round
                path.move(to: NSPoint(x: 3, y: 5))
                path.curve(to: NSPoint(x: 13.6, y: 8.8), controlPoint1: NSPoint(x: 5, y: 12.8), controlPoint2: NSPoint(x: 9.6, y: 13))
                path.stroke()
                let barb = NSBezierPath()
                barb.lineWidth = 1.6
                barb.lineCapStyle = .round
                barb.move(to: NSPoint(x: 9.2, y: 6.4))
                barb.line(to: NSPoint(x: 16, y: 7.2))
                barb.stroke()
                let barb2 = NSBezierPath()
                barb2.lineWidth = 1.3
                barb2.lineCapStyle = .round
                barb2.move(to: NSPoint(x: 11.6, y: 10.8))
                barb2.line(to: NSPoint(x: 15.9, y: 7.5))
                barb2.stroke()
            }
        case "lonePair", "tool.lonePair":
            return templateGlyph(size: NSSize(width: 18, height: 18)) { _ in
                NSBezierPath(ovalIn: NSRect(x: 5.2, y: 7.4, width: 3.0, height: 3.0)).fill()
                NSBezierPath(ovalIn: NSRect(x: 10.0, y: 7.4, width: 3.0, height: 3.0)).fill()
            }
        case "radical", "tool.radical":
            return templateGlyph(size: NSSize(width: 18, height: 18)) { _ in
                NSBezierPath(ovalIn: NSRect(x: 7.1, y: 7.1, width: 3.8, height: 3.8)).fill()
            }
        default:
            return polygonGlyph(sides: 6, aromatic: toolId.contains("benzene") || toolId.contains("pyridine") || toolId.contains("naphthalene"))
        }
    }

    private static func templateGlyph(size: NSSize, drawing: @escaping (NSRect) -> Void) -> NSImage {
        let image = NSImage(size: size, flipped: false) { rect in
            NSColor.labelColor.setStroke()
            NSColor.labelColor.setFill()
            drawing(rect)
            return true
        }
        image.isTemplate = true
        return image
    }

    private static func polygonGlyph(sides: Int, aromatic: Bool) -> NSImage {
        templateGlyph(size: NSSize(width: 18, height: 18)) { rect in
            let center = NSPoint(x: rect.midX, y: rect.midY)
            let radius = min(rect.width, rect.height) * 0.36
            let path = NSBezierPath()
            path.lineWidth = 1.45
            path.lineJoinStyle = .round
            for i in 0..<sides {
                let angle = (CGFloat(i) / CGFloat(sides)) * 2 * .pi + (.pi / 2)
                let point = NSPoint(x: center.x + radius * cos(angle), y: center.y + radius * sin(angle))
                if i == 0 {
                    path.move(to: point)
                } else {
                    path.line(to: point)
                }
            }
            path.close()
            path.stroke()

            if aromatic {
                let inner = NSBezierPath(ovalIn: NSRect(
                    x: center.x - radius * 0.55,
                    y: center.y - radius * 0.55,
                    width: radius * 1.1,
                    height: radius * 1.1
                ))
                inner.lineWidth = 1.2
                inner.stroke()
            }
        }
    }
}

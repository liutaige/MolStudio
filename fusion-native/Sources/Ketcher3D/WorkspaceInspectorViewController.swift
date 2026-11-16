import AppKit
import Foundation

/// Active right-hand inspector mode tab.
enum WorkspaceInspectorTab: Int, Equatable, Sendable {
    case properties = 0
    case agent = 1
}

/// Slider subclass supporting single-commit-on-release semantics, Escape cancellation, and deterministic testing hooks.
final class WorkspaceCommitSliderView: NSView {
    final class TrackingSlider: NSSlider {
        var onMouseDownWillStart: (() -> Void)?
        var onMouseUpDidFinish: ((Double) -> Void)?
        var onEscapePressed: (() -> Void)?
        var onArrowStepDidFinish: ((Double) -> Void)?
        var onFocusLost: (() -> Void)?

        override func mouseDown(with event: NSEvent) {
            onMouseDownWillStart?()
            super.mouseDown(with: event)
            onMouseUpDidFinish?(doubleValue)
        }

        override func keyDown(with event: NSEvent) {
            if event.keyCode == 53 { // Escape
                onEscapePressed?()
                return
            }
            let prev = doubleValue
            super.keyDown(with: event)
            if abs(doubleValue - prev) > 1e-9 {
                onArrowStepDidFinish?(doubleValue)
            }
        }

        override func resignFirstResponder() -> Bool {
            onFocusLost?()
            return super.resignFirstResponder()
        }
    }

    let propertyId: String
    private let titleLabel = NSTextField(labelWithString: "")
    private let readoutLabel = NSTextField(labelWithString: "")
    let slider = TrackingSlider()

    private(set) var committedValue: Double = 0
    private(set) var capturedSelectionRevision: Int?
    private(set) var isInteracting = false
    private(set) var wasCancelledDuringDrag = false

    var onCommitValue: ((String, Double, Int) -> Void)?
    private var selectionRevisionProvider: () -> Int

    init(
        property: WorkspaceSelectionProperty,
        selectionRevision: Int,
        selectionRevisionProvider: @escaping () -> Int,
        onCommitValue: @escaping (String, Double, Int) -> Void
    ) {
        self.propertyId = property.id
        self.selectionRevisionProvider = selectionRevisionProvider
        self.onCommitValue = onCommitValue
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false

        titleLabel.font = .systemFont(ofSize: 12, weight: .medium)
        titleLabel.textColor = .labelColor
        titleLabel.stringValue = property.label

        readoutLabel.font = .monospacedDigitSystemFont(ofSize: 11.5, weight: .regular)
        readoutLabel.textColor = .secondaryLabelColor
        readoutLabel.alignment = .right
        readoutLabel.setContentHuggingPriority(.required, for: .horizontal)

        slider.isContinuous = true
        slider.controlSize = .small
        slider.target = self
        slider.action = #selector(sliderValueChanged(_:))

        slider.onMouseDownWillStart = { [weak self] in
            self?.beginInteraction()
        }
        slider.onMouseUpDidFinish = { [weak self] finalValue in
            self?.finishInteractionCommit(finalValue: finalValue)
        }
        slider.onEscapePressed = { [weak self] in
            self?.cancelInteraction()
        }
        slider.onArrowStepDidFinish = { [weak self] finalValue in
            guard let self else { return }
            self.beginInteraction()
            self.finishInteractionCommit(finalValue: finalValue)
        }
        slider.onFocusLost = { [weak self] in
            self?.cancelInteractionIfUncommitted()
        }

        let header = NSStackView(views: [titleLabel, NSView(), readoutLabel])
        header.orientation = .horizontal
        header.alignment = .centerY
        header.translatesAutoresizingMaskIntoConstraints = false

        let container = NSStackView(views: [header, slider])
        container.orientation = .vertical
        container.alignment = .leading
        container.spacing = 4
        container.translatesAutoresizingMaskIntoConstraints = false

        addSubview(container)
        NSLayoutConstraint.activate([
            container.leadingAnchor.constraint(equalTo: leadingAnchor),
            container.trailingAnchor.constraint(equalTo: trailingAnchor),
            container.topAnchor.constraint(equalTo: topAnchor),
            container.bottomAnchor.constraint(equalTo: bottomAnchor),
            header.widthAnchor.constraint(equalTo: container.widthAnchor),
            slider.widthAnchor.constraint(equalTo: container.widthAnchor),
        ])

        applyProperty(property, selectionRevision: selectionRevision)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    func applyProperty(_ property: WorkspaceSelectionProperty, selectionRevision: Int) {
        titleLabel.stringValue = property.label
        slider.minValue = property.min ?? -2.4
        slider.maxValue = property.max ?? 2.4
        slider.isEnabled = property.enabled

        let numeric = property.value?.numberValue ?? 0
        if isInteracting {
            if let captured = capturedSelectionRevision, captured != selectionRevision {
                // Selection changed externally mid-drag: discard local drag without committing.
                committedValue = numeric
                cancelInteraction()
            }
            return
        }

        committedValue = numeric
        slider.doubleValue = numeric
        updateReadout(numeric)
    }

    /// Cancels any active drag or uncommitted adjustment and reverts immediately without dispatching a command.
    func cancelInteraction() {
        wasCancelledDuringDrag = true
        isInteracting = false
        capturedSelectionRevision = nil
        slider.doubleValue = committedValue
        updateReadout(committedValue)
    }

    func cancelInteractionIfUncommitted() {
        if isInteracting {
            cancelInteraction()
        }
    }

    // MARK: - Drag Lifecycle & Deterministic Test Hooks

    func beginInteraction() {
        guard slider.isEnabled else { return }
        wasCancelledDuringDrag = false
        isInteracting = true
        capturedSelectionRevision = selectionRevisionProvider()
    }

    func updatePreviewDuringInteraction(_ value: Double) {
        guard isInteracting, !wasCancelledDuringDrag else { return }
        let clamped = min(max(value, slider.minValue), slider.maxValue)
        slider.doubleValue = clamped
        updateReadout(clamped)
    }

    func finishInteractionCommit(finalValue: Double) {
        guard isInteracting else { return }
        defer {
            isInteracting = false
            capturedSelectionRevision = nil
            wasCancelledDuringDrag = false
        }
        guard !wasCancelledDuringDrag else {
            slider.doubleValue = committedValue
            updateReadout(committedValue)
            return
        }
        let clamped = min(max(finalValue, slider.minValue), slider.maxValue)
        guard abs(clamped - committedValue) > 1e-6 else {
            slider.doubleValue = committedValue
            updateReadout(committedValue)
            return
        }
        let currentRevision = selectionRevisionProvider()
        guard let expectedRev = capturedSelectionRevision, expectedRev == currentRevision else {
            slider.doubleValue = committedValue
            updateReadout(committedValue)
            return
        }

        committedValue = clamped
        slider.doubleValue = clamped
        updateReadout(clamped)
        onCommitValue?(propertyId, clamped, expectedRev)
    }

    @objc private func sliderValueChanged(_ sender: NSSlider) {
        updateReadout(sender.doubleValue)
    }

    private func updateReadout(_ value: Double) {
        readoutLabel.stringValue = String(format: "%.2f", value)
    }
}

/// Editable single-commit text property field that supports Escape/focus-loss cancellation and responder-first text editing.
final class WorkspaceCommitTextFieldView: NSView, NSTextFieldDelegate {
    let propertyId: String
    private let titleLabel = NSTextField(labelWithString: "")
    let textField = NSTextField()

    private(set) var committedValue: String = ""
    private var capturedSelectionRevision: Int?
    private var selectionRevisionProvider: () -> Int
    var onCommitValue: ((String, String, Int) -> Void)?
    var onRestoreCanvasFocus: (() -> Void)?
    private var suppressNextEndCommit = false

    init(
        property: WorkspaceSelectionProperty,
        selectionRevision: Int,
        selectionRevisionProvider: @escaping () -> Int,
        onCommitValue: @escaping (String, String, Int) -> Void,
        onRestoreCanvasFocus: (() -> Void)? = nil
    ) {
        self.propertyId = property.id
        self.selectionRevisionProvider = selectionRevisionProvider
        self.onCommitValue = onCommitValue
        self.onRestoreCanvasFocus = onRestoreCanvasFocus
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false

        titleLabel.font = .systemFont(ofSize: 12, weight: .medium)
        titleLabel.textColor = .labelColor
        titleLabel.stringValue = property.label

        textField.controlSize = .small
        textField.font = .systemFont(ofSize: 12)
        textField.delegate = self
        textField.translatesAutoresizingMaskIntoConstraints = false

        let stack = NSStackView(views: [titleLabel, textField])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 4
        stack.translatesAutoresizingMaskIntoConstraints = false

        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor),
            stack.topAnchor.constraint(equalTo: topAnchor),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor),
            textField.widthAnchor.constraint(equalTo: stack.widthAnchor),
        ])

        applyProperty(property, selectionRevision: selectionRevision)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    func applyProperty(_ property: WorkspaceSelectionProperty, selectionRevision: Int) {
        titleLabel.stringValue = property.label
        textField.isEnabled = property.enabled
        textField.isEditable = property.enabled
        let val = property.value?.stringValue ?? ""
        if let rev = capturedSelectionRevision, rev != selectionRevision {
            cancelPendingEdit()
        }
        if textField.currentEditor() == nil {
            committedValue = val
            textField.stringValue = val
        }
    }

    func cancelPendingEdit() {
        suppressNextEndCommit = true
        capturedSelectionRevision = nil
        textField.stringValue = committedValue
        let win = textField.window
        let hadFieldFocus: Bool = {
            guard let win, let fr = win.firstResponder else { return false }
            return fr === textField || fr === textField.currentEditor()
        }()
        if let editor = textField.currentEditor() {
            editor.string = committedValue
            win?.makeFirstResponder(nil)
        }
        if hadFieldFocus {
            onRestoreCanvasFocus?()
        }
        suppressNextEndCommit = false
    }

    func controlTextDidBeginEditing(_ obj: Notification) {
        capturedSelectionRevision = selectionRevisionProvider()
    }

    func control(_ control: NSControl, textView: NSTextView, doCommandBy commandSelector: Selector) -> Bool {
        if commandSelector == #selector(NSResponder.cancelOperation(_:)) {
            cancelPendingEdit()
            return true
        }
        if commandSelector == #selector(NSResponder.insertNewline(_:)) {
            commitIfChanged()
            textField.window?.makeFirstResponder(nil)
            onRestoreCanvasFocus?()
            return true
        }
        return false
    }

    func controlTextDidEndEditing(_ obj: Notification) {
        if suppressNextEndCommit {
            suppressNextEndCommit = false
            return
        }
        commitIfChanged()
    }

    private func commitIfChanged() {
        let trimmed = textField.stringValue
        guard trimmed != committedValue else {
            capturedSelectionRevision = nil
            return
        }
        let currentRev = selectionRevisionProvider()
        guard let expectedRev = capturedSelectionRevision, expectedRev == currentRev else {
            textField.stringValue = committedValue
            capturedSelectionRevision = nil
            return
        }
        committedValue = trimmed
        capturedSelectionRevision = nil
        onCommitValue?(propertyId, trimmed, expectedRev)
    }
}

/// A real AppKit colour well that commits once per picker selection and is
/// revision guarded like the numeric/text inspector controls.
final class WorkspaceCommitColorWellView: NSView {
    final class TrackingColorWell: NSColorWell {
        var onMouseDown: (() -> Void)?
        var onMouseDownEnded: (() -> Void)?
        override func mouseDown(with event: NSEvent) {
            onMouseDown?()
            super.mouseDown(with: event)
            onMouseDownEnded?()
        }
    }

    let propertyId: String
    private let titleLabel = NSTextField(labelWithString: "")
    private let valueLabel = NSTextField(labelWithString: "")
    let colorWell = TrackingColorWell()

    var hasActiveOwnedPickerSession: Bool {
        capturedSelectionRevision != nil && (ownsPickerPanel || pickerActivationInProgress) && colorWell.isActive
    }

    private var committedValue: String = "#000000"
    private var capturedSelectionRevision: Int?
    private var ownsPickerPanel = false
    private var pickerActivationInProgress = false
    private var selectionRevisionProvider: () -> Int
    var onCommitValue: ((String, String, Int) -> Void)?
    var onRestoreCanvasFocus: (() -> Void)?

    init(
        property: WorkspaceSelectionProperty,
        selectionRevision: Int,
        selectionRevisionProvider: @escaping () -> Int,
        onCommitValue: @escaping (String, String, Int) -> Void,
        onRestoreCanvasFocus: (() -> Void)? = nil
    ) {
        self.propertyId = property.id
        self.selectionRevisionProvider = selectionRevisionProvider
        self.onCommitValue = onCommitValue
        self.onRestoreCanvasFocus = onRestoreCanvasFocus
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false

        titleLabel.font = .systemFont(ofSize: 12, weight: .medium)
        titleLabel.textColor = .labelColor
        titleLabel.stringValue = property.label
        valueLabel.font = .monospacedSystemFont(ofSize: 10.5, weight: .regular)
        valueLabel.textColor = .secondaryLabelColor
        valueLabel.alignment = .right
        valueLabel.setContentHuggingPriority(.required, for: .horizontal)

        colorWell.controlSize = .small
        colorWell.isContinuous = false
        colorWell.isBordered = true
        colorWell.target = self
        colorWell.action = #selector(colorWellChanged(_:))
        colorWell.onMouseDown = { [weak self] in
            guard let self, self.colorWell.isEnabled else { return }
            self.capturedSelectionRevision = self.selectionRevisionProvider()
            self.ownsPickerPanel = false
            self.pickerActivationInProgress = true
        }
        colorWell.onMouseDownEnded = { [weak self] in
            guard let self else { return }
            self.ownsPickerPanel = self.colorWell.isActive
            self.pickerActivationInProgress = false
        }

        let row = NSStackView(views: [titleLabel, NSView(), valueLabel, colorWell])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 7
        row.translatesAutoresizingMaskIntoConstraints = false
        addSubview(row)
        NSLayoutConstraint.activate([
            row.leadingAnchor.constraint(equalTo: leadingAnchor),
            row.trailingAnchor.constraint(equalTo: trailingAnchor),
            row.topAnchor.constraint(equalTo: topAnchor),
            row.bottomAnchor.constraint(equalTo: bottomAnchor),
            colorWell.widthAnchor.constraint(equalToConstant: 34),
        ])
        applyProperty(property, selectionRevision: selectionRevision)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    func applyProperty(_ property: WorkspaceSelectionProperty, selectionRevision: Int) {
        titleLabel.stringValue = property.label
        colorWell.isEnabled = property.enabled
        if let captured = capturedSelectionRevision, captured != selectionRevision {
            cancelInteraction()
        }
        if capturedSelectionRevision == nil {
            committedValue = property.value?.stringValue ?? "#000000"
            valueLabel.stringValue = committedValue
            colorWell.color = Self.color(from: committedValue)
        }
    }

    private func closeOwnedPickerPanel() {
        let shouldClose = (ownsPickerPanel || pickerActivationInProgress) && colorWell.isActive
        ownsPickerPanel = false
        pickerActivationInProgress = false
        guard shouldClose else { return }
        colorWell.deactivate()
        NSColorPanel.shared.orderOut(nil)
    }

    func cancelInteraction() {
        capturedSelectionRevision = nil
        closeOwnedPickerPanel()
        valueLabel.stringValue = committedValue
        colorWell.color = Self.color(from: committedValue)
    }

    @objc private func colorWellChanged(_ sender: NSColorWell) {
        guard let expectedRevision = capturedSelectionRevision else {
            sender.color = Self.color(from: committedValue)
            return
        }
        if sender.isActive { ownsPickerPanel = true }
        let value = Self.hex(from: sender.color)
        // Some NSColorPanel modes can send an unchanged initial value when the
        // panel opens. Keep the captured revision for the next actual choice.
        guard value != committedValue else { return }
        guard expectedRevision == selectionRevisionProvider() else {
            cancelInteraction()
            return
        }
        committedValue = value
        valueLabel.stringValue = value
        capturedSelectionRevision = nil
        // One colour choice is one undoable property edit. Close the shared
        // panel only when this well opened it, so no stale panel can keep
        // targeting a retired view after the selection revision advances.
        closeOwnedPickerPanel()
        onCommitValue?(propertyId, value, expectedRevision)
        onRestoreCanvasFocus?()
    }

    private static func color(from value: String) -> NSColor {
        switch value.lowercased() {
        case "transparent": return .clear
        case "black": return .black
        case "white": return .white
        case "red": return .red
        case "blue": return .blue
        case "green": return .green
        case "gray": return .gray
        default: break
        }
        var hex = value.hasPrefix("#") ? String(value.dropFirst()) : value
        guard [3, 4, 6, 8].contains(hex.count) else { return .black }
        if hex.count == 3 || hex.count == 4 {
            hex = hex.map { String(repeating: String($0), count: 2) }.joined()
        }
        guard let raw = UInt64(hex, radix: 16) else { return .black }
        let hasAlpha = hex.count == 8
        let red = CGFloat((raw >> (hasAlpha ? 24 : 16)) & 0xff) / 255
        let green = CGFloat((raw >> (hasAlpha ? 16 : 8)) & 0xff) / 255
        let blue = CGFloat((raw >> (hasAlpha ? 8 : 0)) & 0xff) / 255
        let alpha = hasAlpha ? CGFloat(raw & 0xff) / 255 : 1
        return NSColor(srgbRed: red, green: green, blue: blue, alpha: alpha)
    }

    private static func hex(from color: NSColor) -> String {
        let rgb = (color.usingColorSpace(.deviceRGB) ?? color).usingColorSpace(.deviceRGB) ?? .black
        let red = Int((min(max(rgb.redComponent, 0), 1) * 255).rounded())
        let green = Int((min(max(rgb.greenComponent, 0), 1) * 255).rounded())
        let blue = Int((min(max(rgb.blueComponent, 0), 1) * 255).rounded())
        let alpha = Int((min(max(rgb.alphaComponent, 0), 1) * 255).rounded())
        return alpha < 255
            ? String(format: "#%02X%02X%02X%02X", red, green, blue, alpha)
            : String(format: "#%02X%02X%02X", red, green, blue)
    }
}

/// Native property inspector displaying Elements, Templates, dynamic `selection.properties`, and context actions.
private final class WorkspaceFlippedDocumentView: NSView {
    override var isFlipped: Bool { true }
}

final class WorkspacePropertiesViewController: NSViewController {
    static let standardElements: [String] = ["C", "H", "O", "N", "S", "P", "F", "Cl", "Br", "I"]
    static let defaultTemplates: [(id: String, title: String)] = [
        ("ring.benzene", "苯环"),
        ("ring.cyclohexane", "环己烷"),
        ("ring.cyclopentane", "环戊烷"),
        ("ring.cyclopentadiene", "环戊二烯"),
        ("ring.cyclobutane", "环丁烷"),
        ("ring.cyclopropane", "环丙烷"),
        ("ring.cycloheptane", "环庚烷"),
        ("ring.cyclooctane", "环辛烷"),
    ]

    let coordinator: WorkspaceStateCoordinator
    private let includePaletteSections: Bool
    var onRestoreCanvasFocus: (() -> Void)?

    private let scrollView = NSScrollView()
    private let contentStack = NSStackView()

    private let selectionTitleLabel = NSTextField(labelWithString: "画布未就绪")
    private let selectionSubtitleLabel = NSTextField(labelWithString: "等待画布与选区状态同步")
    private let propertiesStack = NSStackView()

    private var sliderViewsById: [String: WorkspaceCommitSliderView] = [:]
    private var textFieldViewsById: [String: WorkspaceCommitTextFieldView] = [:]
    private var colorWellViewsById: [String: WorkspaceCommitColorWellView] = [:]
    private var choicePopupsById: [String: NSPopUpButton] = [:]
    private var renderedPropertyIds: [String] = []
    private var lastRenderedSelectionRevision: Int = -1

    private let replanButton = NSButton(title: "重排弯箭头", target: nil, action: nil)
    private let toggleBondButton = NSButton(title: "切换 σ / π 端点", target: nil, action: nil)
    private let deleteButton = NSButton(title: "删除选中", target: nil, action: nil)

    private var paperSectionHeader: NSTextField?
    private var paperSectionCard: NSView?
    private let paperSummaryLabel = NSTextField(labelWithString: "纸页排版")
    let paperSetupButton = NSButton(title: "页面设置…", target: nil, action: nil)
    let addPageButton = NSButton(title: "新增页面", target: nil, action: nil)
    let removeLastPageButton = NSButton(title: "删空白末页", target: nil, action: nil)
    let insertImageButton = NSButton(title: "插入图片…", target: nil, action: nil)
    let insertFileButton = NSButton(title: "插入文件…", target: nil, action: nil)
    let switchCanvasModeButton = NSButton(title: "切换画布", target: nil, action: nil)

    private var elementButtons: [String: NSButton] = [:]
    private let templatesGridStack = NSStackView()
    private var templateButtons: [String: NSButton] = [:]

    init(coordinator: WorkspaceStateCoordinator, includePaletteSections: Bool = true) {
        self.coordinator = coordinator
        self.includePaletteSections = includePaletteSections
        super.init(nibName: nil, bundle: nil)
        coordinator.addObserver(self) { [weak self] in
            self?.refreshState()
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    override func loadView() {
        let root = NSView(frame: NSRect(x: 0, y: 0, width: 300, height: 640))
        view = root
        setupLayout(in: root)
        refreshState()
    }

    /// Cancels all uncommitted inspector edits without sending JS dispatch commands.
    var hasActiveOwnedColorPickerSession: Bool {
        colorWellViewsById.values.contains(where: \.hasActiveOwnedPickerSession)
    }

    func cancelPendingLocalEdits() {
        for slider in sliderViewsById.values {
            slider.cancelInteraction()
        }
        for field in textFieldViewsById.values {
            field.cancelPendingEdit()
        }
        for colorWell in colorWellViewsById.values {
            colorWell.cancelInteraction()
        }
    }

    func sliderView(forPropertyId id: String) -> WorkspaceCommitSliderView? {
        sliderViewsById[id]
    }

    func elementButton(forSymbol symbol: String) -> NSButton? {
        elementButtons[symbol]
    }

    func templateButton(forTemplateId id: String) -> NSButton? {
        templateButtons[id]
    }

    private func setupLayout(in root: NSView) {
        scrollView.translatesAutoresizingMaskIntoConstraints = false
        scrollView.hasVerticalScroller = true
        scrollView.hasHorizontalScroller = false
        scrollView.drawsBackground = false
        scrollView.borderType = .noBorder

        contentStack.orientation = .vertical
        contentStack.alignment = .leading
        contentStack.spacing = 14
        contentStack.edgeInsets = NSEdgeInsets(top: 12, left: 12, bottom: 16, right: 12)
        contentStack.translatesAutoresizingMaskIntoConstraints = false

        let docContainer = WorkspaceFlippedDocumentView()
        docContainer.translatesAutoresizingMaskIntoConstraints = false
        docContainer.addSubview(contentStack)
        scrollView.documentView = docContainer
        root.addSubview(scrollView)

        NSLayoutConstraint.activate([
            scrollView.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            scrollView.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            scrollView.topAnchor.constraint(equalTo: root.topAnchor),
            scrollView.bottomAnchor.constraint(equalTo: root.bottomAnchor),

            docContainer.leadingAnchor.constraint(equalTo: scrollView.contentView.leadingAnchor),
            docContainer.trailingAnchor.constraint(equalTo: scrollView.contentView.trailingAnchor),
            docContainer.topAnchor.constraint(equalTo: scrollView.contentView.topAnchor),
            docContainer.widthAnchor.constraint(equalTo: scrollView.contentView.widthAnchor),

            contentStack.leadingAnchor.constraint(equalTo: docContainer.leadingAnchor),
            contentStack.trailingAnchor.constraint(equalTo: docContainer.trailingAnchor),
            contentStack.topAnchor.constraint(equalTo: docContainer.topAnchor),
            contentStack.bottomAnchor.constraint(equalTo: docContainer.bottomAnchor),
        ])

        buildSelectionSection()
        buildPaperSection()
        if includePaletteSections {
            buildElementsSection()
            buildTemplatesSection()
        }
    }

    private func buildPaperSection() {
        let header = makeSectionHeader("纸页与文档")
        paperSummaryLabel.font = .systemFont(ofSize: 12, weight: .medium)
        paperSummaryLabel.textColor = .secondaryLabelColor
        paperSummaryLabel.maximumNumberOfLines = 2

        for (btn, act) in [
            (paperSetupButton, #selector(paperSetupClicked(_:))),
            (addPageButton, #selector(addPageClicked(_:))),
            (removeLastPageButton, #selector(removeLastPageClicked(_:))),
            (insertImageButton, #selector(insertImageClicked(_:))),
            (insertFileButton, #selector(insertFileClicked(_:))),
            (switchCanvasModeButton, #selector(switchCanvasModeClicked(_:))),
        ] {
            btn.bezelStyle = .rounded
            btn.controlSize = .small
            btn.target = self
            btn.action = act
        }

        let row1 = NSStackView(views: [paperSetupButton, addPageButton, removeLastPageButton])
        row1.orientation = .horizontal
        row1.spacing = 6
        row1.distribution = .fillEqually
        row1.translatesAutoresizingMaskIntoConstraints = false

        let row2 = NSStackView(views: [insertImageButton, insertFileButton, switchCanvasModeButton])
        row2.orientation = .horizontal
        row2.spacing = 6
        row2.distribution = .fillEqually
        row2.translatesAutoresizingMaskIntoConstraints = false

        let card = makeSectionCard(views: [paperSummaryLabel, row1, row2])
        contentStack.addArrangedSubview(header)
        contentStack.addArrangedSubview(card)
        card.widthAnchor.constraint(equalTo: contentStack.widthAnchor, constant: -24).isActive = true
        row1.widthAnchor.constraint(equalTo: card.widthAnchor, constant: -20).isActive = true
        row2.widthAnchor.constraint(equalTo: card.widthAnchor, constant: -20).isActive = true
        paperSectionHeader = header
        paperSectionCard = card
    }

    private func buildSelectionSection() {
        let header = makeSectionHeader("选区与属性")
        selectionTitleLabel.font = .systemFont(ofSize: 13, weight: .semibold)
        selectionTitleLabel.textColor = .labelColor

        selectionSubtitleLabel.font = .systemFont(ofSize: 11.5)
        selectionSubtitleLabel.textColor = .secondaryLabelColor
        selectionSubtitleLabel.maximumNumberOfLines = 2

        propertiesStack.orientation = .vertical
        propertiesStack.alignment = .leading
        propertiesStack.spacing = 10
        propertiesStack.translatesAutoresizingMaskIntoConstraints = false

        replanButton.bezelStyle = .rounded
        replanButton.controlSize = .small
        replanButton.target = self
        replanButton.action = #selector(replanClicked(_:))

        toggleBondButton.bezelStyle = .rounded
        toggleBondButton.controlSize = .small
        toggleBondButton.target = self
        toggleBondButton.action = #selector(toggleBondClicked(_:))

        deleteButton.bezelStyle = .rounded
        deleteButton.controlSize = .small
        deleteButton.contentTintColor = .systemRed
        deleteButton.target = self
        deleteButton.action = #selector(deleteClicked(_:))

        let actionRow = NSStackView(views: [replanButton, toggleBondButton, deleteButton])
        actionRow.orientation = .horizontal
        actionRow.spacing = 6
        actionRow.distribution = .fillEqually
        actionRow.translatesAutoresizingMaskIntoConstraints = false

        let card = makeSectionCard(views: [selectionTitleLabel, selectionSubtitleLabel, propertiesStack, actionRow])
        contentStack.addArrangedSubview(header)
        contentStack.addArrangedSubview(card)
        card.widthAnchor.constraint(equalTo: contentStack.widthAnchor, constant: -24).isActive = true
        propertiesStack.widthAnchor.constraint(equalTo: card.widthAnchor, constant: -20).isActive = true
        actionRow.widthAnchor.constraint(equalTo: card.widthAnchor, constant: -20).isActive = true
    }

    private func buildElementsSection() {
        let header = makeSectionHeader("元素周期快捷栏")
        let rowsStack = NSStackView()
        rowsStack.orientation = .vertical
        rowsStack.alignment = .leading
        rowsStack.spacing = 6

        var currentRow: [NSButton] = []
        for symbol in Self.standardElements {
            let btn = NSButton(title: symbol, target: self, action: #selector(elementButtonClicked(_:)))
            btn.bezelStyle = .rounded
            btn.controlSize = .small
            btn.font = .systemFont(ofSize: 12, weight: .semibold)
            btn.contentTintColor = WorkspaceAppearanceTokens.elementTintColor(for: symbol)
            btn.toolTip = "选择原子元素 \(symbol)"
            elementButtons[symbol] = btn
            currentRow.append(btn)

            if currentRow.count == 5 {
                let row = NSStackView(views: currentRow)
                row.orientation = .horizontal
                row.spacing = 6
                row.distribution = .fillEqually
                rowsStack.addArrangedSubview(row)
                row.widthAnchor.constraint(equalTo: rowsStack.widthAnchor).isActive = true
                currentRow.removeAll()
            }
        }
        if !currentRow.isEmpty {
            let row = NSStackView(views: currentRow)
            row.orientation = .horizontal
            row.spacing = 6
            row.distribution = .fillEqually
            rowsStack.addArrangedSubview(row)
            row.widthAnchor.constraint(equalTo: rowsStack.widthAnchor).isActive = true
        }

        let card = makeSectionCard(views: [rowsStack])
        contentStack.addArrangedSubview(header)
        contentStack.addArrangedSubview(card)
        card.widthAnchor.constraint(equalTo: contentStack.widthAnchor, constant: -24).isActive = true
        rowsStack.widthAnchor.constraint(equalTo: card.widthAnchor, constant: -20).isActive = true
    }

    private func buildTemplatesSection() {
        let header = makeSectionHeader("常用结构模板")
        templatesGridStack.orientation = .vertical
        templatesGridStack.alignment = .leading
        templatesGridStack.spacing = 6

        rebuildTemplatesGrid(extraTemplateIds: [])

        let card = makeSectionCard(views: [templatesGridStack])
        contentStack.addArrangedSubview(header)
        contentStack.addArrangedSubview(card)
        card.widthAnchor.constraint(equalTo: contentStack.widthAnchor, constant: -24).isActive = true
        templatesGridStack.widthAnchor.constraint(equalTo: card.widthAnchor, constant: -20).isActive = true
    }

    private func rebuildTemplatesGrid(extraTemplateIds: [String]) {
        templatesGridStack.arrangedSubviews.forEach {
            templatesGridStack.removeArrangedSubview($0)
            $0.removeFromSuperview()
        }
        templateButtons.removeAll()

        var entries = Self.defaultTemplates
        let knownIds = Set(entries.map(\.id))
        for extra in extraTemplateIds where !knownIds.contains(extra) {
            entries.append((extra, "其他模板"))
        }

        var rowButtons: [NSButton] = []
        for entry in entries {
            let btn = NSButton(title: entry.title, target: self, action: #selector(templateButtonClicked(_:)))
            btn.bezelStyle = .rounded
            btn.controlSize = .small
            btn.image = WorkspaceIconHelper.toolIcon(for: entry.id)
            btn.imagePosition = .imageLeading
            btn.toolTip = entry.title
            btn.identifier = NSUserInterfaceItemIdentifier(entry.id)
            templateButtons[entry.id] = btn
            rowButtons.append(btn)

            if rowButtons.count == 2 {
                let row = NSStackView(views: rowButtons)
                row.orientation = .horizontal
                row.spacing = 6
                row.distribution = .fillEqually
                templatesGridStack.addArrangedSubview(row)
                row.widthAnchor.constraint(equalTo: templatesGridStack.widthAnchor).isActive = true
                rowButtons.removeAll()
            }
        }
        if !rowButtons.isEmpty {
            let row = NSStackView(views: rowButtons)
            row.orientation = .horizontal
            row.spacing = 6
            row.distribution = .fillEqually
            templatesGridStack.addArrangedSubview(row)
            row.widthAnchor.constraint(equalTo: templatesGridStack.widthAnchor).isActive = true
        }
    }

    private func makeSectionHeader(_ title: String) -> NSTextField {
        let label = NSTextField(labelWithString: title)
        label.font = .systemFont(ofSize: 11, weight: .semibold)
        label.textColor = .secondaryLabelColor
        return label
    }

    private func makeSectionCard(views: [NSView]) -> NSView {
        let box = NSView()
        box.wantsLayer = true
        box.layer?.cornerRadius = 10
        box.layer?.backgroundColor = NSColor.controlBackgroundColor.withAlphaComponent(0.65).cgColor
        box.layer?.borderWidth = 0.5
        box.layer?.borderColor = NSColor.separatorColor.withAlphaComponent(0.45).cgColor
        box.translatesAutoresizingMaskIntoConstraints = false

        let stack = NSStackView(views: views)
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 8
        stack.translatesAutoresizingMaskIntoConstraints = false
        box.addSubview(stack)

        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: box.topAnchor, constant: 10),
            stack.bottomAnchor.constraint(equalTo: box.bottomAnchor, constant: -10),
            stack.leadingAnchor.constraint(equalTo: box.leadingAnchor, constant: 10),
            stack.trailingAnchor.constraint(equalTo: box.trailingAnchor, constant: -10),
        ])
        return box
    }

    func refreshState() {
        guard isViewLoaded else { return }

        let ready = coordinator.isCanvasSurfaceReady(.inspector)
        let selection = coordinator.uiState.selection
        let hasSelection = ready && selection.kind != .none && selection.count > 0
        let hasShapeDefaults = ready && !hasSelection && selection.label == "形状样式" && !selection.properties.isEmpty

        if !ready {
            cancelPendingLocalEdits()
            selectionTitleLabel.stringValue = "画布未就绪"
            selectionSubtitleLabel.stringValue = "正在连接编辑引擎，就绪前控件保持禁用"
        } else if hasShapeDefaults {
            selectionTitleLabel.stringValue = "形状样式"
            selectionSubtitleLabel.stringValue = "设置当前形状工具创建对象时使用的默认样式"
        } else if !hasSelection {
            selectionTitleLabel.stringValue = "未选中对象"
            selectionSubtitleLabel.stringValue = "请在画布中选择原子、键、机理弯箭头或标注文本"
        } else {
            let labelText = selection.label.isEmpty ? selection.kind.rawValue : selection.label
            selectionTitleLabel.stringValue = "\(labelText)（\(selection.count) 项）"
            selectionSubtitleLabel.stringValue = "版本 #\(selection.revision) · 类型：\(selection.kind.rawValue)"
        }

        syncDynamicProperties(selection.properties, revision: selection.revision, ready: ready && (hasSelection || hasShapeDefaults))

        let supportsReplan = ready && hasSelection && selection.kind == .electronFlow && coordinator.isCommandSupported("selection.replan")
        let supportsToggleBond = ready && selection.count == 1 && selection.kind == .electronFlow && coordinator.isCommandSupported("selection.toggleBondComponent")
        let supportsDelete = ready && hasSelection && coordinator.isCommandSupported("edit.delete")

        replanButton.isEnabled = supportsReplan
        toggleBondButton.isEnabled = supportsToggleBond
        deleteButton.isEnabled = supportsDelete

        let isPaper = coordinator.uiState.viewport.mode == .paper || coordinator.documentMetadata.documentMode == .paper
        let fileReady = ready && coordinator.ownsSurface(.fileCommands)
        let doc = coordinator.uiState.document
        let showPaper = isPaper && (
            coordinator.fileCallbacks.onPaperSetup != nil
                || coordinator.fileCallbacks.onAddPaperPage != nil
                || coordinator.fileCallbacks.onInsertImageIntoDocument != nil
                || coordinator.fileCallbacks.onInsertFileIntoDocument != nil
        )
        paperSectionHeader?.isHidden = !showPaper
        paperSectionCard?.isHidden = !showPaper
        if showPaper {
            var parts: [String] = []
            if let size = doc?.size, !size.isEmpty {
                let orient = (doc?.orientation == "landscape") ? "横向" : "纵向"
                parts.append("\(size) \(orient)")
            } else {
                parts.append("纸页模式")
            }
            if let pages = doc?.pageCount, pages > 0 {
                parts.append("共 \(pages) 页")
            }
            if let margin = doc?.marginMm {
                parts.append("边距 \(Int(margin.rounded())) mm")
            }
            paperSummaryLabel.stringValue = parts.joined(separator: " · ")
            paperSetupButton.isEnabled = fileReady && coordinator.fileCallbacks.onPaperSetup != nil
            addPageButton.isEnabled = fileReady && coordinator.fileCallbacks.onAddPaperPage != nil
            let canRemoveLast = doc?.canRemoveLastPage ?? true
            removeLastPageButton.isEnabled = fileReady && canRemoveLast && coordinator.fileCallbacks.onRemoveBlankLastPage != nil
            insertImageButton.isEnabled = fileReady && coordinator.fileCallbacks.onInsertImageIntoDocument != nil
            insertFileButton.isEnabled = fileReady && coordinator.fileCallbacks.onInsertFileIntoDocument != nil
            switchCanvasModeButton.isEnabled = fileReady && coordinator.fileCallbacks.onSwitchToCanvasMode != nil
        } else {
            paperSummaryLabel.stringValue = ""
            paperSetupButton.isEnabled = false
            addPageButton.isEnabled = false
            removeLastPageButton.isEnabled = false
            insertImageButton.isEnabled = false
            insertFileButton.isEnabled = false
            switchCanvasModeButton.isEnabled = false
        }

        for (symbol, btn) in elementButtons {
            btn.isEnabled = coordinator.isElementSupported(symbol)
            btn.alphaValue = btn.isEnabled ? 1.0 : 0.42
        }

        let extraIds = coordinator.uiState.supported.templateIds.sorted()
        let currentKnown = Set(templateButtons.keys)
        if includePaletteSections && !extraIds.allSatisfy({ currentKnown.contains($0) }) {
            rebuildTemplatesGrid(extraTemplateIds: extraIds)
        }

        for (templateId, btn) in templateButtons {
            let supported = coordinator.isTemplateSupported(templateId)
            btn.isEnabled = supported
            btn.alphaValue = supported ? 1.0 : 0.42
        }
    }

    private func syncDynamicProperties(_ properties: [WorkspaceSelectionProperty], revision: Int, ready: Bool) {
        let newIds = properties.map(\.id)
        let structureChanged = newIds != renderedPropertyIds || revision != lastRenderedSelectionRevision

        if !ready || properties.isEmpty {
            if !renderedPropertyIds.isEmpty || propertiesStack.arrangedSubviews.isEmpty {
                clearRenderedProperties()
                let emptyLabel = NSTextField(labelWithString: ready ? "当前选区无可调参数" : "选区属性不可用")
                emptyLabel.font = .systemFont(ofSize: 11.5)
                emptyLabel.textColor = .tertiaryLabelColor
                propertiesStack.addArrangedSubview(emptyLabel)
            }
            lastRenderedSelectionRevision = revision
            return
        }

        if structureChanged {
            clearRenderedProperties()
            renderedPropertyIds = newIds
            for prop in properties {
                switch prop.type {
                case .number:
                    let sliderView = WorkspaceCommitSliderView(
                        property: prop,
                        selectionRevision: revision,
                        selectionRevisionProvider: { [weak self] in self?.coordinator.uiState.selection.revision ?? 0 },
                        onCommitValue: { [weak self] propId, val, expectedRev in
                            self?.coordinator.commitSelectionProperty(
                                propertyId: propId,
                                value: .number(val),
                                expectedSelectionRevision: expectedRev
                            )
                            self?.onRestoreCanvasFocus?()
                        }
                    )
                    sliderViewsById[prop.id] = sliderView
                    propertiesStack.addArrangedSubview(sliderView)
                    sliderView.widthAnchor.constraint(equalTo: propertiesStack.widthAnchor).isActive = true

                case .choice:
                    let popup = NSPopUpButton(frame: .zero, pullsDown: false)
                    popup.controlSize = .small
                    popup.identifier = NSUserInterfaceItemIdentifier(prop.id)
                    for choice in prop.choices ?? [] {
                        popup.addItem(withTitle: choice.label)
                        popup.lastItem?.representedObject = choice.value
                    }
                    if let selectedId = prop.value?.stringValue,
                       let idx = prop.choices?.firstIndex(where: { $0.value == selectedId }) {
                        popup.selectItem(at: idx)
                    }
                    popup.isEnabled = prop.enabled
                    popup.target = self
                    popup.action = #selector(choicePopupChanged(_:))

                    let titleLabel = NSTextField(labelWithString: prop.label)
                    titleLabel.font = .systemFont(ofSize: 12, weight: .medium)
                    let row = NSStackView(views: [titleLabel, NSView(), popup])
                    row.orientation = .horizontal
                    row.alignment = .centerY
                    choicePopupsById[prop.id] = popup
                    propertiesStack.addArrangedSubview(row)
                    row.widthAnchor.constraint(equalTo: propertiesStack.widthAnchor).isActive = true

                case .text:
                    if ["stroke.color", "fillColor", "shapeStyle.stroke.color", "shapeStyle.fillColor"].contains(prop.id) {
                        let colorView = WorkspaceCommitColorWellView(
                            property: prop,
                            selectionRevision: revision,
                            selectionRevisionProvider: { [weak self] in self?.coordinator.uiState.selection.revision ?? 0 },
                            onCommitValue: { [weak self] propId, str, expectedRev in
                                self?.coordinator.commitSelectionProperty(
                                    propertyId: propId,
                                    value: .string(str),
                                    expectedSelectionRevision: expectedRev
                                )
                            },
                            onRestoreCanvasFocus: { [weak self] in self?.onRestoreCanvasFocus?() }
                        )
                        colorWellViewsById[prop.id] = colorView
                        propertiesStack.addArrangedSubview(colorView)
                        colorView.widthAnchor.constraint(equalTo: propertiesStack.widthAnchor).isActive = true
                    } else {
                        let fieldView = WorkspaceCommitTextFieldView(
                            property: prop,
                            selectionRevision: revision,
                            selectionRevisionProvider: { [weak self] in self?.coordinator.uiState.selection.revision ?? 0 },
                            onCommitValue: { [weak self] propId, str, expectedRev in
                                self?.coordinator.commitSelectionProperty(
                                    propertyId: propId,
                                    value: .string(str),
                                    expectedSelectionRevision: expectedRev
                                )
                            },
                            onRestoreCanvasFocus: { [weak self] in
                                self?.onRestoreCanvasFocus?()
                            }
                        )
                        textFieldViewsById[prop.id] = fieldView
                        propertiesStack.addArrangedSubview(fieldView)
                        fieldView.widthAnchor.constraint(equalTo: propertiesStack.widthAnchor).isActive = true
                    }
                }
            }
        } else {
            for prop in properties {
                sliderViewsById[prop.id]?.applyProperty(prop, selectionRevision: revision)
                textFieldViewsById[prop.id]?.applyProperty(prop, selectionRevision: revision)
                colorWellViewsById[prop.id]?.applyProperty(prop, selectionRevision: revision)
                if let popup = choicePopupsById[prop.id] {
                    popup.isEnabled = prop.enabled
                    if let selectedId = prop.value?.stringValue,
                       let idx = prop.choices?.firstIndex(where: { $0.value == selectedId }) {
                        popup.selectItem(at: idx)
                    }
                }
            }
        }

        lastRenderedSelectionRevision = revision
    }

    private func clearRenderedProperties() {
        sliderViewsById.values.forEach { $0.cancelInteraction() }
        textFieldViewsById.values.forEach { $0.cancelPendingEdit() }
        colorWellViewsById.values.forEach { $0.cancelInteraction() }
        sliderViewsById.removeAll()
        textFieldViewsById.removeAll()
        colorWellViewsById.removeAll()
        choicePopupsById.removeAll()
        renderedPropertyIds.removeAll()
        propertiesStack.arrangedSubviews.forEach {
            propertiesStack.removeArrangedSubview($0)
            $0.removeFromSuperview()
        }
    }

    // MARK: - Actions

    @objc private func choicePopupChanged(_ sender: NSPopUpButton) {
        guard let propId = sender.identifier?.rawValue,
              let choiceId = sender.selectedItem?.representedObject as? String else { return }
        let expectedRev = coordinator.uiState.selection.revision
        coordinator.commitSelectionProperty(
            propertyId: propId,
            value: .string(choiceId),
            expectedSelectionRevision: expectedRev
        )
        onRestoreCanvasFocus?()
    }

    @objc private func replanClicked(_ sender: Any?) {
        let rev = coordinator.uiState.selection.revision
        coordinator.replanSelection(expectedSelectionRevision: rev)
        onRestoreCanvasFocus?()
    }

    @objc private func toggleBondClicked(_ sender: Any?) {
        let rev = coordinator.uiState.selection.revision
        coordinator.toggleBondComponent(expectedSelectionRevision: rev)
        onRestoreCanvasFocus?()
    }

    @objc private func deleteClicked(_ sender: Any?) {
        guard coordinator.isCanvasSurfaceReady(.inspector), coordinator.isCommandSupported("edit.delete") else { return }
        coordinator.dispatchCommand(id: "edit.delete")
        onRestoreCanvasFocus?()
    }

    @objc private func elementButtonClicked(_ sender: NSButton) {
        let symbol = sender.title
        coordinator.selectElement(symbol: symbol)
        onRestoreCanvasFocus?()
    }

    @objc private func templateButtonClicked(_ sender: NSButton) {
        guard let templateId = sender.identifier?.rawValue else { return }
        coordinator.selectTemplate(id: templateId)
        onRestoreCanvasFocus?()
    }

    @objc private func paperSetupClicked(_ sender: Any?) {
        coordinator.performFileAction(coordinator.fileCallbacks.onPaperSetup)
    }

    @objc private func addPageClicked(_ sender: Any?) {
        coordinator.performFileAction(coordinator.fileCallbacks.onAddPaperPage)
        onRestoreCanvasFocus?()
    }

    @objc private func removeLastPageClicked(_ sender: Any?) {
        coordinator.performFileAction(coordinator.fileCallbacks.onRemoveBlankLastPage)
        onRestoreCanvasFocus?()
    }

    @objc private func insertImageClicked(_ sender: Any?) {
        coordinator.performFileAction(coordinator.fileCallbacks.onInsertImageIntoDocument)
    }

    @objc private func insertFileClicked(_ sender: Any?) {
        coordinator.performFileAction(coordinator.fileCallbacks.onInsertFileIntoDocument)
    }

    @objc private func switchCanvasModeClicked(_ sender: Any?) {
        coordinator.performFileAction(coordinator.fileCallbacks.onSwitchToCanvasMode)
        onRestoreCanvasFocus?()
    }
}

/// Right-hand inspector container hosting `属性` (`WorkspacePropertiesViewController`) and `AI 助手` tabs.
final class WorkspaceInspectorViewController: NSViewController {
    let coordinator: WorkspaceStateCoordinator
    let propertiesViewController: WorkspacePropertiesViewController
    let agentViewController: NSViewController

    private(set) var selectedTab: WorkspaceInspectorTab = .agent
    var onSelectedTabChanged: ((WorkspaceInspectorTab) -> Void)?

    var hasActiveOwnedColorPickerSession: Bool {
        propertiesViewController.hasActiveOwnedColorPickerSession
    }

    let segmentedControl = NSSegmentedControl(labels: ["属性", "AI 助手"], trackingMode: .selectOne, target: nil, action: nil)
    private let containerView = NSView()

    init(
        coordinator: WorkspaceStateCoordinator,
        agentViewController: NSViewController? = nil
    ) {
        self.coordinator = coordinator
        self.propertiesViewController = WorkspacePropertiesViewController(coordinator: coordinator, includePaletteSections: false)
        self.agentViewController = agentViewController ?? WorkspaceAgentViewController(coordinator: coordinator)
        super.init(nibName: nil, bundle: nil)
        addChild(self.agentViewController)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    override func loadView() {
        let root = NSView(frame: NSRect(x: 0, y: 0, width: 320, height: 640))
        view = root

        segmentedControl.segmentStyle = .automatic
        segmentedControl.selectedSegment = selectedTab.rawValue
        segmentedControl.target = self
        segmentedControl.action = #selector(segmentChanged(_:))
        segmentedControl.translatesAutoresizingMaskIntoConstraints = false

        containerView.translatesAutoresizingMaskIntoConstraints = false

        root.addSubview(containerView)

        NSLayoutConstraint.activate([
            containerView.topAnchor.constraint(equalTo: root.safeAreaLayoutGuide.topAnchor, constant: 8),
            containerView.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            containerView.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            containerView.bottomAnchor.constraint(equalTo: root.bottomAnchor),
        ])

        attachChildViews()
        updateVisibleTab()
    }

    func selectTab(_ tab: WorkspaceInspectorTab) {
        if selectedTab == .properties && tab != .properties {
            propertiesViewController.cancelPendingLocalEdits()
        }
        selectedTab = tab
        if isViewLoaded {
            segmentedControl.selectedSegment = tab.rawValue
            updateVisibleTab()
        }
        onSelectedTabChanged?(tab)
    }

    func cancelPendingLocalEdits() {
        propertiesViewController.cancelPendingLocalEdits()
    }

    private func attachChildViews() {
        for vc in [agentViewController] {
            let v = vc.view
            v.translatesAutoresizingMaskIntoConstraints = false
            containerView.addSubview(v)
            NSLayoutConstraint.activate([
                v.leadingAnchor.constraint(equalTo: containerView.leadingAnchor),
                v.trailingAnchor.constraint(equalTo: containerView.trailingAnchor),
                v.topAnchor.constraint(equalTo: containerView.topAnchor),
                v.bottomAnchor.constraint(equalTo: containerView.bottomAnchor),
            ])
        }
    }

    private func updateVisibleTab() {
        agentViewController.view.isHidden = false
    }

    @objc private func segmentChanged(_ sender: NSSegmentedControl) {
        if let tab = WorkspaceInspectorTab(rawValue: sender.selectedSegment) {
            selectTab(tab)
        }
    }
}

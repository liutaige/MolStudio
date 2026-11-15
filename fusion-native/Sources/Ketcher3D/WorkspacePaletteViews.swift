import AppKit
import Foundation

/// Descriptor for one button slot (and optional sub-variants) inside the floating chemical tool palette.
struct WorkspaceToolSlot {
    struct Variant {
        let id: String
        let title: String
        let isTemplate: Bool
    }

    let slotKey: String
    let primaryId: String
    let title: String
    let isTemplate: Bool
    let variants: [Variant]

    init(
        id: String,
        title: String,
        isTemplate: Bool = false,
        variants: [Variant] = []
    ) {
        self.slotKey = id
        self.primaryId = id
        self.title = title
        self.isTemplate = isTemplate
        self.variants = variants.isEmpty
            ? [Variant(id: id, title: title, isTemplate: isTemplate)]
            : variants
    }
}

/// Overlay container that allows mouse/scroll events in transparent regions to fall straight through to the canvas below.
final class WorkspaceOverlayContainerView: NSView {
    /// While the opaque navigation cover is up, floating controls remain in
    /// the layout (stable viewport geometry) but must not take clicks.
    var interactive: Bool = true

    override func hitTest(_ point: NSPoint) -> NSView? {
        guard interactive else { return nil }
        let localPoint = convert(point, from: superview)
        guard bounds.contains(localPoint) else { return nil }
        for subview in subviews.reversed() where !subview.isHidden && subview.alphaValue > 0.01 {
            if let hit = subview.hitTest(localPoint) {
                return hit
            }
        }
        return nil
    }
}

/// Interactive button inside the floating chemical tool palette with variant indicator and active highlight.
final class WorkspaceToolPaletteButton: NSButton {
    let slot: WorkspaceToolSlot
    var displayedVariant: WorkspaceToolSlot.Variant

    private let activeLayer = CALayer()
    private let badgeIndicator = NSTextField(labelWithString: "▾")

    var isSelectedTool: Bool = false {
        didSet {
            if oldValue != isSelectedTool {
                updateAppearance()
            }
        }
    }

    var onVariantMenuRequested: ((WorkspaceToolPaletteButton) -> Void)?

    init(slot: WorkspaceToolSlot) {
        self.slot = slot
        self.displayedVariant = slot.variants[0]
        super.init(frame: .zero)
        wantsLayer = true
        isBordered = false
        bezelStyle = .regularSquare
        imagePosition = .imageOnly
        setButtonType(.momentaryChange)

        activeLayer.cornerRadius = 8
        layer?.insertSublayer(activeLayer, at: 0)

        badgeIndicator.font = .systemFont(ofSize: 8, weight: .bold)
        badgeIndicator.textColor = .secondaryLabelColor
        badgeIndicator.isHidden = slot.variants.count <= 1
        badgeIndicator.translatesAutoresizingMaskIntoConstraints = false
        addSubview(badgeIndicator)

        NSLayoutConstraint.activate([
            widthAnchor.constraint(equalToConstant: 32),
            heightAnchor.constraint(equalToConstant: 32),
            badgeIndicator.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -2),
            badgeIndicator.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -1),
        ])

        refreshDisplayedVariant()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    override func layout() {
        super.layout()
        activeLayer.frame = bounds
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        updateAppearance()
    }

    override func rightMouseDown(with event: NSEvent) {
        if slot.variants.count > 1 {
            onVariantMenuRequested?(self)
        } else {
            super.rightMouseDown(with: event)
        }
    }

    override func mouseDown(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        if slot.variants.count > 1 && point.x >= bounds.maxX - 11 && point.y <= bounds.minY + 11 {
            onVariantMenuRequested?(self)
        } else {
            super.mouseDown(with: event)
        }
    }

    func refreshDisplayedVariant() {
        image = WorkspaceIconHelper.toolIcon(for: displayedVariant.id)
        toolTip = isEnabled ? displayedVariant.title : "\(displayedVariant.title)（当前未就绪或不支持）"
        setAccessibilityLabel(displayedVariant.title)
        updateAppearance()
    }

    func updateAppearance() {
        let baseAlpha: CGFloat = isEnabled ? 1.0 : 0.36
        alphaValue = baseAlpha

        if isSelectedTool && isEnabled {
            activeLayer.backgroundColor = WorkspaceAppearanceTokens.resolvedCGColor(
                NSColor.controlAccentColor.withAlphaComponent(0.18),
                for: self
            )
            activeLayer.borderWidth = 1.0
            activeLayer.borderColor = WorkspaceAppearanceTokens.resolvedCGColor(
                NSColor.controlAccentColor.withAlphaComponent(0.65),
                for: self
            )
            contentTintColor = .controlAccentColor
            badgeIndicator.textColor = .controlAccentColor
        } else {
            activeLayer.backgroundColor = WorkspaceAppearanceTokens.resolvedCGColor(.clear, for: self)
            activeLayer.borderWidth = 0
            contentTintColor = .labelColor
            badgeIndicator.textColor = .secondaryLabelColor
        }
    }
}

/// Floating chemical tool palette supporting single- or double-column density inside an adaptive Liquid Glass / system-material capsule.
final class WorkspaceToolPaletteView: NSView {
    let coordinator: WorkspaceStateCoordinator
    let surfaceView = WorkspaceMaterialSurfaceView(
        style: .floatingControl,
        cornerRadius: WorkspaceAppearanceTokens.floatingCornerRadius,
        prefersInteractiveGlass: true
    )

    var onLayoutDidChange: (() -> Void)?
    var onRestoreCanvasFocus: (() -> Void)?
    /// Host-driven native image insertion (NSOpenPanel → document.addImage).
    /// There is no web-toolbar fallback any more.
    var onInsertImageRequested: (() -> Void)?

    private(set) var isDoubleColumn: Bool = true
    private let rootStack = NSStackView()
    private let densityToggleButton = NSButton()
    private let gridContainer = NSStackView()

    private(set) var toolButtons: [WorkspaceToolPaletteButton] = []
    private let variantMenu = NSMenu(title: "工具变体")

    /// Ordered v1 product sections mirroring `design-demos/macos-workbench/index.html` and contract v1.
    static let sections: [(title: String, slots: [WorkspaceToolSlot])] = [
        (
            "选择",
            [
                WorkspaceToolSlot(id: "select", title: "选择", variants: [
                    .init(id: "select", title: "框选", isTemplate: false),
                    .init(id: "lasso", title: "套索选择", isTemplate: false),
                    .init(id: "select.structure", title: "结构选择", isTemplate: false),
                    .init(id: "select.fragment", title: "片段选择", isTemplate: false),
                ]),
                WorkspaceToolSlot(id: "hand", title: "抓手平移"),
                WorkspaceToolSlot(id: "erase", title: "橡皮擦"),
            ]
        ),
        (
            "结构",
            [
                WorkspaceToolSlot(
                    id: "bond.single",
                    title: "化学键",
                    variants: [
                        .init(id: "bond.single", title: "单键", isTemplate: false),
                        .init(id: "bond.double", title: "双键", isTemplate: false),
                        .init(id: "bond.triple", title: "三键", isTemplate: false),
                        .init(id: "bond.wedge", title: "实楔形键", isTemplate: false),
                        .init(id: "bond.hashed", title: "虚楔形键", isTemplate: false),
                        .init(id: "bond.wavy", title: "波浪键", isTemplate: false),
                    ]
                ),
                WorkspaceToolSlot(id: "chain", title: "碳链"),
                WorkspaceToolSlot(
                    id: "ring.benzene",
                    title: "环模板",
                    isTemplate: true,
                    variants: [
                        .init(id: "ring.benzene", title: "苯环", isTemplate: true),
                        .init(id: "ring.cyclohexane", title: "环己烷", isTemplate: true),
                        .init(id: "ring.cyclopentane", title: "环戊烷", isTemplate: true),
                        .init(id: "ring.cyclobutane", title: "环丁烷", isTemplate: true),
                        .init(id: "ring.cyclopropane", title: "环丙烷", isTemplate: true),
                    ]
                ),
                WorkspaceToolSlot(id: "chargePlus", title: "正电荷 (+)"),
                WorkspaceToolSlot(id: "chargeMinus", title: "负电荷 (−)"),
                WorkspaceToolSlot(id: "radical", title: "自由基（点击原子切换）"),
            ]
        ),
        (
            "机理",
            [
                WorkspaceToolSlot(
                    id: "reactionArrow",
                    title: "反应箭头",
                    variants: [
                        .init(id: "reactionArrow", title: "标准反应箭头", isTemplate: false),
                        .init(id: "equilibriumArrow", title: "平衡箭头", isTemplate: false),
                        .init(id: "resonanceArrow", title: "共振箭头", isTemplate: false),
                        .init(id: "retrosyntheticArrow", title: "逆合成箭头", isTemplate: false),
                    ]
                ),
                WorkspaceToolSlot(id: "electronPairArrow", title: "双电子弯箭头 (2e)"),
                WorkspaceToolSlot(id: "fishhookArrow", title: "单电子鱼钩 (1e)"),
                WorkspaceToolSlot(id: "lonePair", title: "孤对电子"),
                WorkspaceToolSlot(id: "reactionPlus", title: "反应加号"),
            ]
        ),
        (
            "插入",
            [
                WorkspaceToolSlot(id: "text", title: "文本标签"),
                WorkspaceToolSlot(id: "document.bracket", title: "方括号 / 聚合"),
                WorkspaceToolSlot(id: "document.image", title: "插入图片…"),
                WorkspaceToolSlot(
                    id: "shape.rect",
                    title: "几何图形",
                    variants: [
                        .init(id: "shape.rect", title: "矩形", isTemplate: false),
                        .init(id: "shape.ellipse", title: "椭圆", isTemplate: false),
                        .init(id: "shape.line", title: "直线", isTemplate: false),
                        .init(id: "document.roundRect", title: "圆角矩形", isTemplate: false),
                        .init(id: "document.polygon", title: "三角形", isTemplate: false),
                        .init(id: "document.arrow", title: "普通箭头", isTemplate: false),
                    ]
                ),
                WorkspaceToolSlot(id: "ketcher.image", title: "Ketcher 图片工具"),
            ]
        ),
    ]

    init(coordinator: WorkspaceStateCoordinator, doubleColumn: Bool = true) {
        self.coordinator = coordinator
        self.isDoubleColumn = doubleColumn
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        setupViews()
        rebuildGrid()
        refreshState()

        coordinator.addObserver(self) { [weak self] in
            self?.refreshState()
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    /// Toggles between double-column (workbench default) and single-column density and notifies host viewport observers.
    func setDoubleColumn(_ doubleColumn: Bool) {
        guard isDoubleColumn != doubleColumn else { return }
        isDoubleColumn = doubleColumn
        rebuildGrid()
        refreshState()
        invalidateIntrinsicContentSize()
        layoutSubtreeIfNeeded()
        onLayoutDidChange?()
    }

    /// Finds the palette button for a slot key or one of its merged variants
    /// (e.g. "lasso" lives inside the single "select" slot's submenu).
    func button(forSlotKey key: String) -> WorkspaceToolPaletteButton? {
        toolButtons.first { button in
            button.slot.slotKey == key
                || button.slot.variants.contains { $0.id == key }
        }
    }

    private func setupViews() {
        surfaceView.translatesAutoresizingMaskIntoConstraints = false
        addSubview(surfaceView)

        rootStack.orientation = .vertical
        rootStack.alignment = .centerX
        rootStack.spacing = 6
        rootStack.translatesAutoresizingMaskIntoConstraints = false

        densityToggleButton.bezelStyle = .accessoryBarAction
        densityToggleButton.isBordered = false
        densityToggleButton.imagePosition = .imageOnly
        densityToggleButton.target = self
        densityToggleButton.action = #selector(toggleColumnDensityClicked(_:))
        densityToggleButton.translatesAutoresizingMaskIntoConstraints = false

        gridContainer.orientation = .vertical
        gridContainer.alignment = .centerX
        gridContainer.spacing = 4
        gridContainer.translatesAutoresizingMaskIntoConstraints = false

        rootStack.addArrangedSubview(densityToggleButton)
        rootStack.addArrangedSubview(gridContainer)

        let content = surfaceView.contentContainerView
        content.addSubview(rootStack)

        NSLayoutConstraint.activate([
            surfaceView.leadingAnchor.constraint(equalTo: leadingAnchor),
            surfaceView.trailingAnchor.constraint(equalTo: trailingAnchor),
            surfaceView.topAnchor.constraint(equalTo: topAnchor),
            surfaceView.bottomAnchor.constraint(equalTo: bottomAnchor),

            densityToggleButton.widthAnchor.constraint(equalToConstant: 28),
            densityToggleButton.heightAnchor.constraint(equalToConstant: 18),

            rootStack.topAnchor.constraint(equalTo: content.topAnchor, constant: 8),
            rootStack.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -8),
            rootStack.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 7),
            rootStack.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -7),
        ])
    }

    private func rebuildGrid() {
        gridContainer.arrangedSubviews.forEach {
            gridContainer.removeArrangedSubview($0)
            $0.removeFromSuperview()
        }
        toolButtons.removeAll()

        densityToggleButton.image = WorkspaceIconHelper.symbolImage(
            isDoubleColumn ? "rectangle.split.2x1" : "rectangle.split.1x2",
            accessibilityDescription: isDoubleColumn ? "切换为单栏工具条" : "切换为双栏工具条",
            pointSize: 11
        )
        densityToggleButton.toolTip = isDoubleColumn ? "切换为单栏工具条" : "切换为双栏工具条"

        let columnCount = isDoubleColumn ? 2 : 1
        for (sectionIndex, section) in Self.sections.enumerated() {
            if sectionIndex > 0 {
                let divider = NSBox()
                divider.boxType = .separator
                divider.translatesAutoresizingMaskIntoConstraints = false
                gridContainer.addArrangedSubview(divider)
                divider.widthAnchor.constraint(equalToConstant: isDoubleColumn ? 62 : 28).isActive = true
            }

            var rowButtons: [WorkspaceToolPaletteButton] = []
            for slot in section.slots {
                let btn = WorkspaceToolPaletteButton(slot: slot)
                btn.target = self
                btn.action = #selector(toolButtonClicked(_:))
                btn.onVariantMenuRequested = { [weak self] targetBtn in
                    self?.presentVariantMenu(for: targetBtn)
                }
                toolButtons.append(btn)
                rowButtons.append(btn)

                if rowButtons.count == columnCount {
                    appendButtonRow(rowButtons)
                    rowButtons.removeAll()
                }
            }
            if !rowButtons.isEmpty {
                appendButtonRow(rowButtons)
            }
        }
    }

    private func appendButtonRow(_ buttons: [NSView]) {
        let row = NSStackView(views: buttons)
        row.orientation = .horizontal
        row.spacing = 4
        row.alignment = .centerY
        gridContainer.addArrangedSubview(row)
    }

    func refreshState() {
        let activeToolId = coordinator.uiState.tool.id
        for btn in toolButtons {
            let supportedVariants = btn.slot.variants.filter { variant in
                variant.isTemplate
                    ? coordinator.isTemplateSupported(variant.id)
                    : coordinator.isToolSupported(variant.id)
            }

            if let matchingActive = supportedVariants.first(where: { $0.id == activeToolId }) {
                btn.displayedVariant = matchingActive
            } else if !isVariantSupported(btn.displayedVariant), let firstSupported = supportedVariants.first {
                btn.displayedVariant = firstSupported
            }

            // Every slot is enabled only by a real verified capability. The
            // retired "open full web toolbar" fallback is never used.
            btn.isEnabled = !supportedVariants.isEmpty
            btn.isSelectedTool = btn.slot.variants.contains { $0.id == activeToolId }
            btn.refreshDisplayedVariant()
        }
    }

    private func isVariantSupported(_ variant: WorkspaceToolSlot.Variant) -> Bool {
        variant.isTemplate
            ? coordinator.isTemplateSupported(variant.id)
            : coordinator.isToolSupported(variant.id)
    }

    @objc private func toggleColumnDensityClicked(_ sender: Any?) {
        setDoubleColumn(!isDoubleColumn)
    }

    @objc private func toolButtonClicked(_ sender: WorkspaceToolPaletteButton) {
        let variant = sender.displayedVariant
        if variant.id == "document.image" {
            onInsertImageRequested?()
            return
        }
        guard isVariantSupported(variant) else { return }
        if variant.isTemplate {
            coordinator.selectTemplate(id: variant.id)
        } else {
            coordinator.selectTool(id: variant.id) { result in
                if case .success(let reply) = result, !reply.ok, let message = reply.error?.message {
                    let alert = NSAlert()
                    alert.messageText = variant.title
                    alert.informativeText = message
                    alert.addButton(withTitle: "好")
                    alert.runModal()
                }
            }
        }
        onRestoreCanvasFocus?()
    }

    private func presentVariantMenu(for button: WorkspaceToolPaletteButton) {
        variantMenu.removeAllItems()
        for variant in button.slot.variants {
            let item = NSMenuItem(title: variant.title, action: #selector(variantMenuItemSelected(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = (button, variant)
            item.image = WorkspaceIconHelper.toolIcon(for: variant.id)
            item.state = (variant.id == button.displayedVariant.id) ? .on : .off
            item.isEnabled = isVariantSupported(variant)
            variantMenu.addItem(item)
        }
        let anchorPoint = NSPoint(x: button.bounds.maxX + 4, y: button.bounds.midY)
        variantMenu.popUp(positioning: nil, at: anchorPoint, in: button)
    }

    @objc private func variantMenuItemSelected(_ sender: NSMenuItem) {
        guard let payload = sender.representedObject as? (WorkspaceToolPaletteButton, WorkspaceToolSlot.Variant) else { return }
        let (button, variant) = payload
        if variant.id == "document.image" {
            onInsertImageRequested?()
            return
        }
        guard isVariantSupported(variant) else { return }
        button.displayedVariant = variant
        button.refreshDisplayedVariant()
        if variant.isTemplate {
            coordinator.selectTemplate(id: variant.id)
        } else {
            coordinator.selectTool(id: variant.id)
        }
        onRestoreCanvasFocus?()
    }
}

/// Floating bottom-left zoom pill (`-`, `%`, `+`, divider, `适应`) gated strictly by `.zoomPalette` capability & supported commands.
final class WorkspaceZoomOverlayView: NSView {
    let coordinator: WorkspaceStateCoordinator
    let surfaceView = WorkspaceMaterialSurfaceView(
        style: .floatingControl,
        cornerRadius: WorkspaceAppearanceTokens.compactPillCornerRadius,
        prefersInteractiveGlass: true
    )

    var anchorPointProvider: (() -> CGPoint?)?
    var onRestoreCanvasFocus: (() -> Void)?

    let zoomOutButton = NSButton()
    let percentButton = NSButton()
    let zoomInButton = NSButton()
    let fitButton = NSButton(title: "适应", target: nil, action: nil)

    private let zoomPresetsMenu = NSMenu(title: "缩放比例")
    private let fitMenu = NSMenu(title: "适配视口")

    init(coordinator: WorkspaceStateCoordinator) {
        self.coordinator = coordinator
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        setupViews()
        refreshState()

        coordinator.addObserver(self) { [weak self] in
            self?.refreshState()
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    private func setupViews() {
        surfaceView.translatesAutoresizingMaskIntoConstraints = false
        addSubview(surfaceView)

        zoomOutButton.bezelStyle = .accessoryBarAction
        zoomOutButton.isBordered = false
        zoomOutButton.image = WorkspaceIconHelper.symbolImage("minus.magnifyingglass", accessibilityDescription: "缩小", pointSize: 12)
        zoomOutButton.imagePosition = .imageOnly
        zoomOutButton.toolTip = "缩小"
        zoomOutButton.target = self
        zoomOutButton.action = #selector(zoomOutClicked(_:))

        percentButton.bezelStyle = .accessoryBarAction
        percentButton.isBordered = false
        percentButton.font = .monospacedDigitSystemFont(ofSize: 11.5, weight: .medium)
        percentButton.title = "100%"
        percentButton.toolTip = "选择缩放比例"
        percentButton.target = self
        percentButton.action = #selector(showZoomPresets(_:))

        zoomInButton.bezelStyle = .accessoryBarAction
        zoomInButton.isBordered = false
        zoomInButton.image = WorkspaceIconHelper.symbolImage("plus.magnifyingglass", accessibilityDescription: "放大", pointSize: 12)
        zoomInButton.imagePosition = .imageOnly
        zoomInButton.toolTip = "放大"
        zoomInButton.target = self
        zoomInButton.action = #selector(zoomInClicked(_:))

        fitButton.bezelStyle = .accessoryBarAction
        fitButton.isBordered = false
        fitButton.font = .systemFont(ofSize: 11.5, weight: .medium)
        fitButton.toolTip = "适应页面或画布"
        fitButton.target = self
        fitButton.action = #selector(fitClicked(_:))

        let divider = NSBox()
        divider.boxType = .separator
        divider.translatesAutoresizingMaskIntoConstraints = false

        let row = NSStackView(views: [zoomOutButton, percentButton, zoomInButton, divider, fitButton])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 4
        row.translatesAutoresizingMaskIntoConstraints = false

        let content = surfaceView.contentContainerView
        content.addSubview(row)

        NSLayoutConstraint.activate([
            surfaceView.leadingAnchor.constraint(equalTo: leadingAnchor),
            surfaceView.trailingAnchor.constraint(equalTo: trailingAnchor),
            surfaceView.topAnchor.constraint(equalTo: topAnchor),
            surfaceView.bottomAnchor.constraint(equalTo: bottomAnchor),

            zoomOutButton.widthAnchor.constraint(equalToConstant: 24),
            zoomOutButton.heightAnchor.constraint(equalToConstant: 24),
            percentButton.widthAnchor.constraint(greaterThanOrEqualToConstant: 46),
            percentButton.heightAnchor.constraint(equalToConstant: 24),
            zoomInButton.widthAnchor.constraint(equalToConstant: 24),
            zoomInButton.heightAnchor.constraint(equalToConstant: 24),
            divider.heightAnchor.constraint(equalToConstant: 14),
            fitButton.heightAnchor.constraint(equalToConstant: 24),

            row.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 8),
            row.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -8),
            row.topAnchor.constraint(equalTo: content.topAnchor, constant: 4),
            row.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -4),
        ])
    }

    func refreshState() {
        let ready = coordinator.isCanvasSurfaceReady(.zoomPalette)
        let supportsZoomBy = ready && coordinator.isCommandSupported("zoom.by")
        let supportsToPercent = ready && coordinator.isCommandSupported("zoom.toPercent")
        let supportsFit = ready && coordinator.isCommandSupported("zoom.fit")

        zoomOutButton.isEnabled = supportsZoomBy
        zoomInButton.isEnabled = supportsZoomBy
        percentButton.isEnabled = supportsToPercent
        fitButton.isEnabled = supportsFit

        if let pct = coordinator.uiState.viewport.percent {
            percentButton.title = "\(Int(pct.rounded()))%"
        } else {
            percentButton.title = "—%"
        }

        if coordinator.uiState.viewport.mode == .paper {
            fitButton.title = "适页"
        } else {
            fitButton.title = "适应"
        }
        fitButton.toolTip = supportsFit ? "自适应当前视图" : "当前画布模式暂不支持自动适配"
    }

    @objc private func zoomOutClicked(_ sender: Any?) {
        guard coordinator.isCanvasSurfaceReady(.zoomPalette), coordinator.isCommandSupported("zoom.by") else { return }
        coordinator.zoomBy(factor: 1.0 / 1.25, anchorCSSPoint: anchorPointProvider?())
        onRestoreCanvasFocus?()
    }

    @objc private func zoomInClicked(_ sender: Any?) {
        guard coordinator.isCanvasSurfaceReady(.zoomPalette), coordinator.isCommandSupported("zoom.by") else { return }
        coordinator.zoomBy(factor: 1.25, anchorCSSPoint: anchorPointProvider?())
        onRestoreCanvasFocus?()
    }

    @objc private func showZoomPresets(_ sender: NSButton) {
        guard coordinator.isCanvasSurfaceReady(.zoomPalette), coordinator.isCommandSupported("zoom.toPercent") else { return }
        zoomPresetsMenu.removeAllItems()
        for preset in [50, 75, 100, 125, 150, 200] {
            let item = NSMenuItem(title: "\(preset)%", action: #selector(zoomPresetSelected(_:)), keyEquivalent: "")
            item.target = self
            item.tag = preset
            if let current = coordinator.uiState.viewport.percent, Int(current.rounded()) == preset {
                item.state = .on
            }
            zoomPresetsMenu.addItem(item)
        }
        zoomPresetsMenu.popUp(positioning: nil, at: NSPoint(x: 0, y: sender.bounds.height + 4), in: sender)
    }

    @objc private func zoomPresetSelected(_ sender: NSMenuItem) {
        guard coordinator.isCanvasSurfaceReady(.zoomPalette), coordinator.isCommandSupported("zoom.toPercent") else { return }
        coordinator.zoomToPercent(Double(sender.tag))
        onRestoreCanvasFocus?()
    }

    @objc private func fitClicked(_ sender: NSButton) {
        guard coordinator.isCanvasSurfaceReady(.zoomPalette), coordinator.isCommandSupported("zoom.fit") else { return }
        if coordinator.uiState.viewport.mode == .paper {
            fitMenu.removeAllItems()
            let pageItem = NSMenuItem(title: "适合整页", action: #selector(fitTargetSelected(_:)), keyEquivalent: "")
            pageItem.target = self
            pageItem.representedObject = "page"
            let widthItem = NSMenuItem(title: "适合页宽", action: #selector(fitTargetSelected(_:)), keyEquivalent: "")
            widthItem.target = self
            widthItem.representedObject = "width"
            fitMenu.addItem(pageItem)
            fitMenu.addItem(widthItem)
            fitMenu.popUp(positioning: nil, at: NSPoint(x: 0, y: sender.bounds.height + 4), in: sender)
        } else {
            coordinator.zoomFit(target: "content")
            onRestoreCanvasFocus?()
        }
    }

    @objc private func fitTargetSelected(_ sender: NSMenuItem) {
        guard let target = sender.representedObject as? String,
              coordinator.isCanvasSurfaceReady(.zoomPalette),
              coordinator.isCommandSupported("zoom.fit") else { return }
        coordinator.zoomFit(target: target)
        onRestoreCanvasFocus?()
    }
}

/// Center pane view controller hosting opaque chemistry backdrop, injected canvas content view (e.g. WKWebView),
/// Common elements and ring templates, backed by the same canvas coordinator.
final class WorkspaceChemicalPaletteView: NSView {
    private let coordinator: WorkspaceStateCoordinator
    private let surface = WorkspaceMaterialSurfaceView(style: .floatingControl, cornerRadius: WorkspaceAppearanceTokens.floatingCornerRadius, prefersInteractiveGlass: true)
    private var elements: [(String, NSButton)] = []
    private var templates: [(String, NSButton)] = []
    var onRestoreCanvasFocus: (() -> Void)?
    /// Native popovers for the full periodic table, extra templates and properties.
    var onPeriodicTableRequested: ((NSView) -> Void)?
    var onMoreTemplatesRequested: ((NSView) -> Void)?
    var onPropertiesRequested: ((NSView) -> Void)?

    init(coordinator: WorkspaceStateCoordinator) {
        self.coordinator = coordinator
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        surface.translatesAutoresizingMaskIntoConstraints = false
        addSubview(surface)
        let stack = NSStackView()
        stack.orientation = .vertical
        stack.spacing = 4
        stack.alignment = .centerX
        stack.translatesAutoresizingMaskIntoConstraints = false
        surface.contentContainerView.addSubview(stack)
        let symbols = ["C", "H", "O", "N", "S", "P", "F", "Cl", "Br", "I"]
        let rings: [(String, String)] = [("ring.benzene", "苯环"), ("ring.cyclohexane", "环己烷"), ("ring.cyclopentane", "环戊烷"), ("ring.cyclopentadiene", "环戊二烯"), ("ring.cyclopropane", "环丙烷"), ("ring.cyclobutane", "环丁烷"), ("ring.cycloheptane", "环庚烷"), ("ring.cyclooctane", "环辛烷")]
        func row(_ buttons: [NSButton]) {
            let row = NSStackView(views: buttons)
            row.orientation = .horizontal
            row.spacing = 4
            stack.addArrangedSubview(row)
        }
        var group: [NSButton] = []
        for symbol in symbols {
            let button = NSButton(title: symbol, target: self, action: #selector(elementClicked(_:)))
            button.identifier = NSUserInterfaceItemIdentifier(symbol)
            button.toolTip = "元素 \(symbol)"
            button.setAccessibilityLabel(button.toolTip!)
            button.contentTintColor = WorkspaceAppearanceTokens.elementTintColor(for: symbol)
            button.isBordered = false
            button.widthAnchor.constraint(equalToConstant: 32).isActive = true
            button.heightAnchor.constraint(equalToConstant: 32).isActive = true
            elements.append((symbol, button)); group.append(button)
            if group.count == 2 { row(group); group = [] }
        }
        let divider = NSBox(); divider.boxType = .separator
        divider.widthAnchor.constraint(equalToConstant: 62).isActive = true
        stack.addArrangedSubview(divider)
        for (id, title) in rings {
            let button = NSButton(image: WorkspaceIconHelper.toolIcon(for: id), target: self, action: #selector(templateClicked(_:)))
            button.identifier = NSUserInterfaceItemIdentifier(id)
            button.toolTip = title; button.setAccessibilityLabel(title)
            button.isBordered = false
            button.widthAnchor.constraint(equalToConstant: 32).isActive = true
            button.heightAnchor.constraint(equalToConstant: 32).isActive = true
            templates.append((id, button)); group.append(button)
            if group.count == 2 { row(group); group = [] }
        }
        if !group.isEmpty { row(group) }
        let divider2 = NSBox(); divider2.boxType = .separator
        divider2.widthAnchor.constraint(equalToConstant: 62).isActive = true
        stack.addArrangedSubview(divider2)
        func compact(_ title: String, _ tooltip: String, _ action: Selector, _ symbol: String) -> NSButton {
            let button = NSButton(title: title, target: self, action: action)
            button.toolTip = tooltip
            button.setAccessibilityLabel(tooltip)
            button.bezelStyle = .rounded
            button.controlSize = .small
            button.font = .systemFont(ofSize: 11, weight: .medium)
            button.widthAnchor.constraint(equalToConstant: 62).isActive = true
            button.heightAnchor.constraint(equalToConstant: 22).isActive = true
            button.identifier = NSUserInterfaceItemIdentifier(symbol)
            return button
        }
        row([compact("周期表", "打开完整元素周期表", #selector(periodicTableClicked(_:)), "periodic-table")])
        row([compact("更多模板", "打开更多环与结构模板", #selector(moreTemplatesClicked(_:)), "more-templates")])
        row([compact("属性", "打开所选对象属性", #selector(propertiesClicked(_:)), "properties")])
        NSLayoutConstraint.activate([
            surface.leadingAnchor.constraint(equalTo: leadingAnchor), surface.trailingAnchor.constraint(equalTo: trailingAnchor),
            surface.topAnchor.constraint(equalTo: topAnchor), surface.bottomAnchor.constraint(equalTo: bottomAnchor),
            stack.leadingAnchor.constraint(equalTo: surface.contentContainerView.leadingAnchor, constant: 7),
            stack.trailingAnchor.constraint(equalTo: surface.contentContainerView.trailingAnchor, constant: -7),
            stack.topAnchor.constraint(equalTo: surface.contentContainerView.topAnchor, constant: 7),
            stack.bottomAnchor.constraint(equalTo: surface.contentContainerView.bottomAnchor, constant: -7),
        ])
        coordinator.addObserver(self) { [weak self] in self?.refresh() }
        refresh()
    }
    @available(*, unavailable) required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }
    private func refresh() {
        for (symbol, button) in elements { button.isEnabled = coordinator.isElementSupported(symbol) }
        for (id, button) in templates { button.isEnabled = coordinator.isTemplateSupported(id) }
    }
    @objc private func elementClicked(_ sender: NSButton) {
        guard let symbol = sender.identifier?.rawValue else { return }
        coordinator.selectElement(symbol: symbol); onRestoreCanvasFocus?()
    }
    @objc private func templateClicked(_ sender: NSButton) {
        guard let id = sender.identifier?.rawValue else { return }
        coordinator.selectTemplate(id: id); onRestoreCanvasFocus?()
    }
    @objc private func periodicTableClicked(_ sender: NSButton) { onPeriodicTableRequested?(sender) }
    @objc private func moreTemplatesClicked(_ sender: NSButton) { onMoreTemplatesRequested?(sender) }
    @objc private func propertiesClicked(_ sender: NSButton) { onPropertiesRequested?(sender) }
}

/// and click-through floating tool/zoom overlays with accurate top-left WebView CSS px viewport synchronization.
final class WorkspaceCanvasHostViewController: NSViewController {
    let coordinator: WorkspaceStateCoordinator
    let backdropView = WorkspaceCanvasBackdropView(tone: .cleanWhite)
    let canvasSlotView = NSView()
    private let navigationCoverView = NSBox()
    private let navigationCoverLabel = NSTextField(labelWithString: "正在打开画布…")
    private let navigationDetailLabel = NSTextField(labelWithString: "")
    private let navigationRetryButton = NSButton(title: "重新载入", target: nil, action: nil)
    private let navigationWelcomeButton = NSButton(title: "返回欢迎页", target: nil, action: nil)
    private let navigationSaveButton = NSButton(title: "保存内存中内容…", target: nil, action: nil)
    private let navigationProgress = NSProgressIndicator()
    var onRetryNavigation: (() -> Void)?
    var onReturnToWelcome: (() -> Void)?
    var onSaveInMemorySnapshot: (() -> Void)?
    /// Forwarded to the host for native popovers / panels. The floating views
    /// never construct their own document or history state.
    var onInsertImageRequested: (() -> Void)?
    var onPeriodicTableRequested: ((NSView) -> Void)?
    var onMoreTemplatesRequested: ((NSView) -> Void)?
    var onPropertiesRequested: ((NSView) -> Void)?
    let glassGroupView = WorkspaceFloatingGlassGroupView(spacing: 12)
    let overlayContainerView = WorkspaceOverlayContainerView()
    let toolPaletteView: WorkspaceToolPaletteView
    let zoomOverlayView: WorkspaceZoomOverlayView
    let chemicalPaletteView: WorkspaceChemicalPaletteView

    private(set) var canvasContentView: NSView?
    /// The AppDelegate raises the cover before the window is ever shown. It is
    /// only lifted by a trusted, generation-checked attach success — never by
    /// a fixed delay. Component fixtures that do not start a navigation remain
    /// interactive for their own layout/hit-test assertions.
    private var coverVisible = false

    /// Optional provider returning live top-level WebView CSS client size when JS layout zoom differs from view bounds points.
    /// Defaults cleanly to 1pt == 1 CSS px (never multiplying by `window.backingScaleFactor`).
    var cssSizeProvider: ((NSView) -> WorkspaceCSSSize)?

    private var lastPublishedViewport: (
        cssSize: WorkspaceCSSSize,
        insets: WorkspaceEdgeInsets,
        overlays: [WorkspaceOverlayRect]
    )?

    init(coordinator: WorkspaceStateCoordinator, backdropTone: WorkspaceCanvasBackdropView.BackdropTone = .cleanWhite) {
        self.coordinator = coordinator
        self.toolPaletteView = WorkspaceToolPaletteView(coordinator: coordinator, doubleColumn: true)
        self.zoomOverlayView = WorkspaceZoomOverlayView(coordinator: coordinator)
        self.chemicalPaletteView = WorkspaceChemicalPaletteView(coordinator: coordinator)
        super.init(nibName: nil, bundle: nil)
        self.backdropView.tone = backdropTone
        coordinator.addObserver(self) { [weak self] in self?.syncPaletteVisibility() }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    override func loadView() {
        let root = NSView(frame: NSRect(x: 0, y: 0, width: 820, height: 640))
        view = root
        setupHierarchy(in: root)
        syncPaletteVisibility()
    }

    /// Legacy "advanced web tools" mode is retired. Kept as a no-op so older
    /// call sites cannot reveal the retired web toolbars.
    func setAdvancedWebToolsVisible(_ visible: Bool) { syncPaletteVisibility() }

    /// Hide the previous WebView frame while a new canvas navigation is prepared.
    func setNavigationCoverVisible(_ visible: Bool) {
        coverVisible = visible
        if visible {
            navigationCoverLabel.stringValue = "正在打开画布…"
            navigationDetailLabel.stringValue = ""
            navigationProgress.startAnimation(nil)
            for button in [navigationRetryButton, navigationWelcomeButton, navigationSaveButton] { button.isHidden = true }
        } else {
            navigationProgress.stopAnimation(nil)
        }
        navigationCoverView.isHidden = !visible
        syncPaletteVisibility()
    }

    var isNavigationLoading: Bool { !navigationCoverView.isHidden && navigationRetryButton.isHidden }

    /// Native error state: an actionable message, never an unlabelled blank
    /// canvas and never the retired web toolbar. Document bytes stay in the
    /// in-memory snapshot, so Save / Close / Quit still work.
    func showNavigationFailure(reason: String? = nil, canSave: Bool = true) {
        navigationCoverLabel.stringValue = "画布未能载入"
        navigationDetailLabel.stringValue = reason ?? "编辑器没有完成接管。当前内容仍保存在内存中，可重新载入或返回欢迎页。"
        navigationProgress.stopAnimation(nil)
        navigationRetryButton.isHidden = false
        navigationWelcomeButton.isHidden = false
        navigationSaveButton.isHidden = !canSave
        navigationCoverView.isHidden = false
        coverVisible = true
        syncPaletteVisibility()
    }

    @objc private func retryNavigationClicked(_ sender: Any?) { onRetryNavigation?() }
    @objc private func returnToWelcomeClicked(_ sender: Any?) { onReturnToWelcome?() }
    @objc private func saveInMemorySnapshotClicked(_ sender: Any?) { onSaveInMemorySnapshot?() }

    private func syncPaletteVisibility() {
        // Native palettes stay in the layout even while the loading cover is up:
        // their geometry must remain published so host viewportCSS points do
        // not jump when the cover lifts. Only interactivity is gated.
        let hideTools = !coordinator.isCanvasSurfaceReady(.toolPalette)
        let hideZoom = !coordinator.isCanvasSurfaceReady(.zoomPalette)
        let hideChemical = !coordinator.isCanvasSurfaceReady(.inspector)
        let interactive = !coverVisible
        let changed = toolPaletteView.isHidden != hideTools
            || zoomOverlayView.isHidden != hideZoom
            || chemicalPaletteView.isHidden != hideChemical
        overlayContainerView.interactive = interactive
        for view in [toolPaletteView, zoomOverlayView, chemicalPaletteView] {
            view.alphaValue = interactive ? 1.0 : 0.45
        }
        guard changed else { return }
        toolPaletteView.isHidden = hideTools
        zoomOverlayView.isHidden = hideZoom
        chemicalPaletteView.isHidden = hideChemical
        if isViewLoaded { publishHostViewportIfNeeded(force: true) }
    }

    override func viewDidLayout() {
        super.viewDidLayout()
        publishHostViewportIfNeeded()
    }

    /// Injects the primary canvas content view (e.g. WKWebView) without owning or migrating its runtime lifecycle.
    func setCanvasContentView(_ contentView: NSView?) {
        if let existing = canvasContentView, existing !== contentView {
            existing.removeFromSuperview()
        }
        canvasContentView = contentView
        guard let contentView else {
            publishHostViewportIfNeeded(force: true)
            return
        }
        contentView.translatesAutoresizingMaskIntoConstraints = false
        if navigationCoverView.superview === canvasSlotView {
            canvasSlotView.addSubview(contentView, positioned: .below, relativeTo: navigationCoverView)
        } else {
            canvasSlotView.addSubview(contentView)
        }
        NSLayoutConstraint.activate([
            contentView.leadingAnchor.constraint(equalTo: canvasSlotView.leadingAnchor),
            contentView.trailingAnchor.constraint(equalTo: canvasSlotView.trailingAnchor),
            contentView.topAnchor.constraint(equalTo: canvasSlotView.topAnchor),
            contentView.bottomAnchor.constraint(equalTo: canvasSlotView.bottomAnchor),
        ])
        view.layoutSubtreeIfNeeded()
        publishHostViewportIfNeeded(force: true)
    }

    /// Computes and publishes top-left CSS px geometry (`cssSize`, `safeAreaInsets`, `overlays`) if changed.
    func publishHostViewportIfNeeded(force: Bool = false) {
        guard isViewLoaded else { return }
        let targetView = canvasContentView ?? canvasSlotView
        let targetBounds = targetView.bounds
        guard targetBounds.width > 0, targetBounds.height > 0 else { return }

        let cssSize = cssSizeProvider?(targetView) ?? WorkspaceCSSSize(
            width: Double(targetBounds.width),
            height: Double(targetBounds.height)
        )
        let scaleX = cssSize.width > 0 ? (cssSize.width / Double(targetBounds.width)) : 1.0
        let scaleY = cssSize.height > 0 ? (cssSize.height / Double(targetBounds.height)) : 1.0

        let rawSafe = view.safeAreaInsets
        let safeInsets = WorkspaceEdgeInsets(
            top: max(0, Double(rawSafe.top) * scaleY).rounded(toPlaces: 1),
            right: max(0, Double(rawSafe.right) * scaleX).rounded(toPlaces: 1),
            bottom: max(0, Double(rawSafe.bottom) * scaleY).rounded(toPlaces: 1),
            left: max(0, Double(rawSafe.left) * scaleX).rounded(toPlaces: 1)
        )

        var overlays: [WorkspaceOverlayRect] = []
        if !toolPaletteView.isHidden {
            overlays.append(overlayCSSRect(id: .toolPalette, overlayView: toolPaletteView, relativeTo: targetView, scaleX: scaleX, scaleY: scaleY))
        }
        if !zoomOverlayView.isHidden {
            overlays.append(overlayCSSRect(id: .zoomPalette, overlayView: zoomOverlayView, relativeTo: targetView, scaleX: scaleX, scaleY: scaleY))
        }
        if !chemicalPaletteView.isHidden {
            overlays.append(overlayCSSRect(id: .chemicalPalette, overlayView: chemicalPaletteView, relativeTo: targetView, scaleX: scaleX, scaleY: scaleY))
        }

        if !force, let last = lastPublishedViewport,
           last.cssSize == cssSize,
           last.insets == safeInsets,
           last.overlays == overlays {
            return
        }

        lastPublishedViewport = (cssSize, safeInsets, overlays)
        coordinator.updateHostViewport(cssSize: cssSize, safeAreaInsets: safeInsets, overlays: overlays)
    }

    /// Computes a single overlay's occlusion rectangle in top-left WebView CSS client coordinates (+y downward).
    func overlayCSSRect(
        id: WorkspaceOverlayID,
        overlayView: NSView,
        relativeTo targetView: NSView,
        scaleX: Double = 1.0,
        scaleY: Double = 1.0
    ) -> WorkspaceOverlayRect {
        let converted = targetView.convert(overlayView.bounds, from: overlayView)
        let topLeftY: Double
        if targetView.isFlipped {
            topLeftY = Double(converted.minY)
        } else {
            topLeftY = Double(targetView.bounds.height - converted.maxY)
        }

        return WorkspaceOverlayRect(
            id: id,
            x: (Double(converted.minX) * scaleX).rounded(toPlaces: 1),
            y: (topLeftY * scaleY).rounded(toPlaces: 1),
            width: (Double(converted.width) * scaleX).rounded(toPlaces: 1),
            height: (Double(converted.height) * scaleY).rounded(toPlaces: 1)
        )
    }

    private func setupHierarchy(in root: NSView) {
        backdropView.translatesAutoresizingMaskIntoConstraints = false
        canvasSlotView.translatesAutoresizingMaskIntoConstraints = false
        glassGroupView.translatesAutoresizingMaskIntoConstraints = false
        overlayContainerView.translatesAutoresizingMaskIntoConstraints = false

        root.addSubview(backdropView)
        root.addSubview(canvasSlotView)
        root.addSubview(glassGroupView)

        navigationCoverView.boxType = .custom
        navigationCoverView.borderType = .noBorder
        navigationCoverView.fillColor = .textBackgroundColor
        navigationCoverView.isHidden = true    // AppDelegate raises it before the window appears
        navigationCoverView.translatesAutoresizingMaskIntoConstraints = false
        canvasSlotView.addSubview(navigationCoverView)
        navigationCoverLabel.textColor = .labelColor
        navigationCoverLabel.font = .systemFont(ofSize: 15, weight: .medium)
        navigationCoverLabel.alignment = .center
        navigationCoverLabel.translatesAutoresizingMaskIntoConstraints = false
        navigationDetailLabel.textColor = .secondaryLabelColor
        navigationDetailLabel.font = .systemFont(ofSize: 12)
        navigationDetailLabel.alignment = .center
        navigationDetailLabel.lineBreakMode = .byWordWrapping
        navigationDetailLabel.maximumNumberOfLines = 5
        navigationDetailLabel.translatesAutoresizingMaskIntoConstraints = false
        navigationProgress.style = .spinning
        navigationProgress.controlSize = .small
        navigationProgress.isDisplayedWhenStopped = false
        navigationProgress.startAnimation(nil)
        navigationProgress.stopAnimation(nil)
        navigationProgress.translatesAutoresizingMaskIntoConstraints = false
        for (button, action) in [
            (navigationRetryButton, #selector(retryNavigationClicked(_:))),
            (navigationWelcomeButton, #selector(returnToWelcomeClicked(_:))),
            (navigationSaveButton, #selector(saveInMemorySnapshotClicked(_:)))
        ] as [(NSButton, Selector)] {
            button.target = self
            button.action = action
            button.bezelStyle = .rounded
            button.isHidden = true
            button.translatesAutoresizingMaskIntoConstraints = false
            navigationCoverView.addSubview(button)
        }
        navigationCoverView.addSubview(navigationCoverLabel)
        navigationCoverView.addSubview(navigationDetailLabel)
        navigationCoverView.addSubview(navigationProgress)

        glassGroupView.contentView.addSubview(overlayContainerView)
        overlayContainerView.addSubview(toolPaletteView)
        overlayContainerView.addSubview(zoomOverlayView)
        overlayContainerView.addSubview(chemicalPaletteView)

        toolPaletteView.onLayoutDidChange = { [weak self] in
            self?.view.layoutSubtreeIfNeeded()
            self?.publishHostViewportIfNeeded(force: true)
        }
        toolPaletteView.onRestoreCanvasFocus = { [weak self] in
            guard let self else { return }
            WorkspaceFocusRouter.restoreCanvasFocusIfSafe(in: self.view.window, canvasView: self.canvasContentView)
        }
        toolPaletteView.onInsertImageRequested = { [weak self] in self?.onInsertImageRequested?() }
        zoomOverlayView.anchorPointProvider = { [weak self] in
            guard let self else { return nil }
            let target = self.canvasContentView ?? self.canvasSlotView
            let size = self.cssSizeProvider?(target) ?? WorkspaceCSSSize(
                width: Double(target.bounds.width),
                height: Double(target.bounds.height)
            )
            return CGPoint(x: size.width * 0.5, y: size.height * 0.5)
        }
        zoomOverlayView.onRestoreCanvasFocus = { [weak self] in
            guard let self else { return }
            WorkspaceFocusRouter.restoreCanvasFocusIfSafe(in: self.view.window, canvasView: self.canvasContentView)
        }
        chemicalPaletteView.onRestoreCanvasFocus = { [weak self] in
            guard let self else { return }
            WorkspaceFocusRouter.restoreCanvasFocusIfSafe(in: self.view.window, canvasView: self.canvasContentView)
        }
        chemicalPaletteView.onPeriodicTableRequested = { [weak self] anchor in self?.onPeriodicTableRequested?(anchor) }
        chemicalPaletteView.onMoreTemplatesRequested = { [weak self] anchor in self?.onMoreTemplatesRequested?(anchor) }
        chemicalPaletteView.onPropertiesRequested = { [weak self] anchor in self?.onPropertiesRequested?(anchor) }

        NSLayoutConstraint.activate([
            backdropView.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            backdropView.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            backdropView.topAnchor.constraint(equalTo: root.topAnchor),
            backdropView.bottomAnchor.constraint(equalTo: root.bottomAnchor),

            canvasSlotView.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            canvasSlotView.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            canvasSlotView.topAnchor.constraint(equalTo: root.topAnchor),
            canvasSlotView.bottomAnchor.constraint(equalTo: root.bottomAnchor),

            navigationCoverView.leadingAnchor.constraint(equalTo: canvasSlotView.leadingAnchor),
            navigationCoverView.trailingAnchor.constraint(equalTo: canvasSlotView.trailingAnchor),
            navigationCoverView.topAnchor.constraint(equalTo: canvasSlotView.topAnchor),
            navigationCoverView.bottomAnchor.constraint(equalTo: canvasSlotView.bottomAnchor),
            navigationCoverLabel.centerXAnchor.constraint(equalTo: navigationCoverView.centerXAnchor),
            navigationCoverLabel.centerYAnchor.constraint(equalTo: navigationCoverView.centerYAnchor, constant: -52),
            navigationDetailLabel.centerXAnchor.constraint(equalTo: navigationCoverView.centerXAnchor),
            navigationDetailLabel.topAnchor.constraint(equalTo: navigationCoverLabel.bottomAnchor, constant: 10),
            navigationDetailLabel.widthAnchor.constraint(lessThanOrEqualToConstant: 420),
            navigationProgress.centerXAnchor.constraint(equalTo: navigationCoverView.centerXAnchor),
            navigationProgress.topAnchor.constraint(equalTo: navigationDetailLabel.bottomAnchor, constant: 14),
            navigationRetryButton.centerXAnchor.constraint(equalTo: navigationCoverView.centerXAnchor, constant: -110),
            navigationRetryButton.topAnchor.constraint(equalTo: navigationDetailLabel.bottomAnchor, constant: 26),
            navigationWelcomeButton.centerXAnchor.constraint(equalTo: navigationCoverView.centerXAnchor),
            navigationWelcomeButton.topAnchor.constraint(equalTo: navigationDetailLabel.bottomAnchor, constant: 26),
            navigationSaveButton.centerXAnchor.constraint(equalTo: navigationCoverView.centerXAnchor, constant: 112),
            navigationSaveButton.topAnchor.constraint(equalTo: navigationDetailLabel.bottomAnchor, constant: 26),

            glassGroupView.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            glassGroupView.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            glassGroupView.topAnchor.constraint(equalTo: root.topAnchor),
            glassGroupView.bottomAnchor.constraint(equalTo: root.bottomAnchor),

            overlayContainerView.leadingAnchor.constraint(equalTo: glassGroupView.contentView.leadingAnchor),
            overlayContainerView.trailingAnchor.constraint(equalTo: glassGroupView.contentView.trailingAnchor),
            overlayContainerView.topAnchor.constraint(equalTo: glassGroupView.contentView.topAnchor),
            overlayContainerView.bottomAnchor.constraint(equalTo: glassGroupView.contentView.bottomAnchor),

            toolPaletteView.leadingAnchor.constraint(equalTo: root.safeAreaLayoutGuide.leadingAnchor, constant: 14),
            toolPaletteView.topAnchor.constraint(greaterThanOrEqualTo: root.safeAreaLayoutGuide.topAnchor, constant: 14),
            toolPaletteView.centerYAnchor.constraint(equalTo: root.safeAreaLayoutGuide.centerYAnchor),

            chemicalPaletteView.trailingAnchor.constraint(equalTo: root.safeAreaLayoutGuide.trailingAnchor, constant: -14),
            chemicalPaletteView.centerYAnchor.constraint(equalTo: root.safeAreaLayoutGuide.centerYAnchor),

            zoomOverlayView.leadingAnchor.constraint(equalTo: root.safeAreaLayoutGuide.leadingAnchor, constant: 14),
            zoomOverlayView.bottomAnchor.constraint(equalTo: root.safeAreaLayoutGuide.bottomAnchor, constant: -14),
        ])
    }
}

private extension Double {
    func rounded(toPlaces places: Int) -> Double {
        let factor = pow(10.0, Double(places))
        return (self * factor).rounded() / factor
    }
}

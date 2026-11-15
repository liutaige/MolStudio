import AppKit
import Foundation

/// Native-only panels and popovers that replace every retired web-toolbar entry.
///
/// Rules:
/// - These views never create a second document, history or AI runtime. They
///   dispatch through `WorkspaceStateCoordinator` (epoch + requestId guarded),
///   or through the existing AppKit action methods on AppDelegate.
/// - All controls are real AppKit controls (NSButton/NSPopUpButton/NSGridView/
///   NSColorWell/NSTextField) inside NSPopover / NSWindow. No CSS blur, no
///   simulated DOM clicks, no hidden web buttons.
/// - Nothing here reveals the old Ketcher web toolbar, in any error state.
extension AppDelegate {

    // MARK: - Periodic table (floating window)

    /// Real periodic table as its own always-on-top floating window (never
    /// occluded by the tool palette). Clicking a supported element dispatches
    /// the verified `element.set` command and keeps the window open so users
    /// can draw C → N → O in a row; clicking its own close button dismisses it.
    func presentPeriodicTable(from anchor: NSView) {
        if let win = periodicTableWin, win.isVisible {
            // Tear down the Esc monitor with the window.
            if let vc = win.contentViewController as? PeriodicTableWindowController {
                if let monitor = vc.escMonitor { NSEvent.removeMonitor(monitor); vc.escMonitor = nil }
            }
            win.orderOut(nil)
            periodicTableWin = nil
            return
        }
        let supported = Set(workspaceCoordinator?.uiState.supported.elementSymbols ?? [])
        let activeToolId = workspaceCoordinator?.uiState.tool.id ?? ""
        let activeSymbol = activeToolId.hasPrefix("element.") ? String(activeToolId.dropFirst("element.".count)) : nil
        let vc = PeriodicTableWindowController(supported: supported, activeSymbol: activeSymbol)
        vc.onElementChosen = { [weak self, weak vc] symbol in
            guard let self else { return }
            self.workspaceCoordinator?.selectElement(symbol: symbol)
            // 选完即收：一次选择对应一次放原子，窗口不再常驻。
            if let vc {
                if let monitor = vc.escMonitor { NSEvent.removeMonitor(monitor); vc.escMonitor = nil }
                vc.closeWindow()
            }
            self.periodicTableWin = nil
            WorkspaceFocusRouter.restoreCanvasFocusIfSafe(in: self.window, canvasView: self.web)
        }
        let win = NSWindow(contentViewController: vc)
        win.styleMask = [.titled, .closable, .fullSizeContentView]
        win.titleVisibility = .hidden
        win.titlebarAppearsTransparent = true
        win.isMovableByWindowBackground = true
        win.isReleasedWhenClosed = false
        win.level = .floating
        win.backgroundColor = .windowBackgroundColor
        // 红点关闭 / 其他窗口级关闭：清引用与 monitor，保证下次能再开。
        NotificationCenter.default.addObserver(forName: NSWindow.willCloseNotification,
                                               object: win, queue: .main) { [weak self] _ in
            guard let self, self.periodicTableWin === win else { return }
            if let vc = win.contentViewController as? PeriodicTableWindowController {
                if let monitor = vc.escMonitor { NSEvent.removeMonitor(monitor); vc.escMonitor = nil }
            }
            self.periodicTableWin = nil
        }
        // Esc dismisses the table (local monitor; nothing else consumes it here).
        vc.escMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak win] event in
            guard event.keyCode == 53, let win, win.isVisible else { return event }
            // Don't hijack Esc while a native text field inside the window is editing.
            if let first = win.firstResponder, first is NSTextView || first is NSTextField {
                let isFieldEditor = (first as? NSTextView)?.isFieldEditor ?? false
                if isFieldEditor { return event }
            }
            win.orderOut(nil)
            self.periodicTableWin = nil
            return nil // consumed
        }
        periodicTableWin?.orderOut(nil)
        periodicTableWin = win
        // Float over the canvas area: horizontally centered on the main
        // window's canvas region, nudged right so the left palette stays clear.
        // fullSizeContentView still reserves titlebar space, so the window
        // frame must be content height PLUS the titlebar band; using
        // setContentSize(content frame) clipped the right column.
        if let anchorWindow = anchor.window {
            let contentSize = vc.view.frame.size
            assert(contentSize.width > 100 && contentSize.height > 100, "periodic table content size degenerate")
            let titlebarExtra: CGFloat = 28
            let windowFrame = NSRect(x: 0, y: 0,
                                     width: contentSize.width,
                                     height: contentSize.height + titlebarExtra)
            let winFrame = anchorWindow.frame
            var origin = NSPoint(
                x: winFrame.midX - windowFrame.width / 2 + 120,
                y: winFrame.maxY - windowFrame.height - 60
            )
            if let screen = anchorWindow.screen {
                origin.x = min(max(origin.x, screen.visibleFrame.minX + 8),
                               screen.visibleFrame.maxX - windowFrame.width - 8)
                origin.y = min(max(origin.y, screen.visibleFrame.minY + 8),
                               screen.visibleFrame.maxY - windowFrame.height - 8)
            }
            win.setFrame(NSRect(origin: origin, size: windowFrame.size), display: true)
        } else {
            win.center()
        }
        win.orderFrontRegardless()
    }

    // MARK: - More templates (native popover)

    func presentMoreTemplates(from anchor: NSView) {
        let vc = NSViewController()
        let root = NSView(frame: NSRect(x: 0, y: 0, width: 248, height: 320))
        vc.view = root
        let stack = NSStackView()
        stack.orientation = .vertical
        stack.spacing = 5
        stack.alignment = .leading
        stack.translatesAutoresizingMaskIntoConstraints = false
        root.addSubview(stack)
        let title = NSTextField(labelWithString: "更多环与结构模板")
        title.font = .systemFont(ofSize: 13, weight: .semibold)
        stack.addArrangedSubview(title)
        let templates: [(String, String)] = [
            ("ring.benzene", "苯环"), ("ring.cyclopentadiene", "环戊二烯"),
            ("ring.cyclohexane", "环己烷"), ("ring.cyclopentane", "环戊烷"),
            ("ring.cyclopropane", "环丙烷"), ("ring.cyclobutane", "环丁烷"),
            ("ring.cycloheptane", "环庚烷"), ("ring.cyclooctane", "环辛烷")
        ]
        for (id, label) in templates {
            let button = NSButton(title: label, target: self, action: #selector(nativeTemplateChosen(_:)))
            button.identifier = NSUserInterfaceItemIdentifier(id)
            button.bezelStyle = .rounded
            button.controlSize = .small
            button.isEnabled = workspaceCoordinator?.isTemplateSupported(id) == true
            button.widthAnchor.constraint(equalToConstant: 216).isActive = true
            stack.addArrangedSubview(button)
        }
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 14),
            stack.topAnchor.constraint(equalTo: root.topAnchor, constant: 12),
        ])
        presentPopover(vc, from: anchor, width: 248, height: 320)
    }

    @objc private func nativeTemplateChosen(_ sender: NSButton) {
        guard let id = sender.identifier?.rawValue else { return }
        workspaceCoordinator?.selectTemplate(id: id)
        dismissPresentedPopover()
        WorkspaceFocusRouter.restoreCanvasFocusIfSafe(in: window, canvasView: web)
    }

    // MARK: - Advanced tools menu (native NSMenu)

    func presentAdvancedToolsMenu(from anchor: NSView) {
        let menu = NSMenu(title: "高级化学工具")
        func item(_ title: String, _ action: Selector, _ key: String) {
            let mi = NSMenuItem(title: title, action: action, keyEquivalent: key)
            mi.target = self
            menu.addItem(mi)
        }
        item("元素周期表…", #selector(advancedPeriodicTable(_:)), "")
        item("更多模板…", #selector(advancedTemplates(_:)), "")
        menu.addItem(.separator())
        item("插入文字框…", #selector(advancedAddText(_:)), "")
        item("插入图片…", #selector(advancedInsertImage(_:)), "")
        item("插入方括号", #selector(advancedBracket(_:)), "")
        item("插入普通箭头", #selector(advancedArrowShape(_:)), "")
        item("插入三角形", #selector(advancedPolygon(_:)), "")
        item("插入圆角矩形", #selector(advancedRoundRect(_:)), "")
        menu.addItem(.separator())
        item("对象属性…", #selector(advancedProperties(_:)), "")
        item("页面设置…", #selector(actPaperSetup), "")
        item("新增页面", #selector(actAddPaperPage), "")
        item("插入 .molwork / .ket…", #selector(actInsertFileIntoDocument), "")
        menu.popUp(positioning: nil, at: NSPoint(x: 0, y: anchor.bounds.height + 4), in: anchor)
    }

    @objc private func advancedPeriodicTable(_ sender: Any?) {
        guard let anchor = window.contentView else { return }
        presentPeriodicTable(from: anchor)
    }
    @objc private func advancedTemplates(_ sender: Any?) {
        guard let anchor = window.contentView else { return }
        presentMoreTemplates(from: anchor)
    }
    @objc private func advancedProperties(_ sender: Any?) {
        guard let anchor = window.contentView else { return }
        presentNativeProperties(from: anchor)
    }
    @objc private func advancedInsertImage(_ sender: Any?) { actInsertImageIntoDocument() }
    @objc private func advancedBracket(_ sender: Any?) {
        workspaceCoordinator?.selectTool(id: "document.bracket")
    }
    @objc private func advancedArrowShape(_ sender: Any?) {
        workspaceCoordinator?.selectTool(id: "document.arrow")
    }
    @objc private func advancedPolygon(_ sender: Any?) {
        workspaceCoordinator?.selectTool(id: "document.polygon")
    }
    @objc private func advancedRoundRect(_ sender: Any?) {
        workspaceCoordinator?.selectTool(id: "document.roundRect")
    }
    @objc private func advancedAddText(_ sender: Any?) {
        let alert = NSAlert()
        alert.messageText = "插入文字框"
        alert.informativeText = "输入文字内容；在当前画布中生成可编辑的文字框。"
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 260, height: 24))
        field.placeholderString = "文字内容"
        alert.accessoryView = field
        alert.addButton(withTitle: "插入")
        alert.addButton(withTitle: "取消")
        guard alert.runModal() == .alertFirstButtonReturn, !field.stringValue.isEmpty else { return }
        workspaceCoordinator?.dispatchCommand(id: "document.addText", args: ["text": .string(field.stringValue)]) { _ in }
    }

    // MARK: - Native properties popover

    func presentNativeProperties(from anchor: NSView) {
        // Prefer the already-native inspector split panel; the popover is a
        // compact, always-available companion that also exposes object actions.
        if let splitVC = workspaceSplitVC, !splitVC.isInspectorCollapsed {
            splitVC.inspectorViewController.selectTab(.properties)
            return
        }
        let vc = NSViewController()
        let root = NSView(frame: NSRect(x: 0, y: 0, width: 280, height: 250))
        vc.view = root
        let stack = NSStackView()
        stack.orientation = .vertical
        stack.spacing = 7
        stack.alignment = .leading
        stack.translatesAutoresizingMaskIntoConstraints = false
        root.addSubview(stack)
        let selection = workspaceCoordinator?.uiState.selection
        let title = NSTextField(labelWithString: "对象属性")
        title.font = .systemFont(ofSize: 13, weight: .semibold)
        stack.addArrangedSubview(title)
        let summary = NSTextField(labelWithString: selection?.label.isEmpty == false
            ? (selection?.label ?? "未选择对象") : "未选择对象")
        summary.font = .systemFont(ofSize: 11.5)
        summary.textColor = .secondaryLabelColor
        summary.lineBreakMode = .byWordWrapping
        summary.maximumNumberOfLines = 2
        stack.addArrangedSubview(summary)
        let info = NSTextField(labelWithString: "共 \(selection?.properties.count ?? 0) 项可调参数；滑动条在松开时一次性提交（一次撤销）。")
        info.font = .systemFont(ofSize: 10.5)
        info.textColor = .tertiaryLabelColor
        info.lineBreakMode = .byWordWrapping
        stack.addArrangedSubview(info)
        func actionButton(_ title: String, _ action: Selector) {
            let b = NSButton(title: title, target: self, action: action)
            b.bezelStyle = .rounded
            b.controlSize = .small
            b.widthAnchor.constraint(equalToConstant: 252).isActive = true
            stack.addArrangedSubview(b)
        }
        actionButton("打开完整属性检查器", #selector(openFullInspector(_:)))
        actionButton("复制所选文档对象", #selector(duplicateSelectedObject(_:)))
        actionButton("删除所选文档对象", #selector(deleteSelectedObject(_:)))
        actionButton("编辑所选文字框", #selector(editSelectedTextObject(_:)))
        actionButton("插入图片…", #selector(advancedInsertImage(_:)))
        actionButton("页面设置…", #selector(actPaperSetup))
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 14),
            stack.topAnchor.constraint(equalTo: root.topAnchor, constant: 12),
        ])
        presentPopover(vc, from: anchor, width: 280, height: 250)
    }

    @objc private func openFullInspector(_ sender: Any?) {
        dismissPresentedPopover()
        workspaceSplitVC?.isInspectorCollapsed = false
        workspaceSplitVC?.inspectorViewController.selectTab(.properties)
    }
    @objc private func duplicateSelectedObject(_ sender: Any?) {
        workspaceCoordinator?.dispatchCommand(id: "document.object.duplicate") { _ in }
        dismissPresentedPopover()
    }
    @objc private func deleteSelectedObject(_ sender: Any?) {
        workspaceCoordinator?.dispatchCommand(id: "document.object.delete") { _ in }
        dismissPresentedPopover()
    }
    @objc private func editSelectedTextObject(_ sender: Any?) {
        // The bridge resolves the current single selection itself; the host
        // never guesses an object id from a display label.
        workspaceCoordinator?.dispatchCommand(id: "document.object.editText") { _ in }
        dismissPresentedPopover()
    }

    // MARK: - Popover plumbing

    private static var presentedPopover: NSPopover?

    private func presentPopover(_ vc: NSViewController, from anchor: NSView, width: CGFloat, height: CGFloat) {
        Self.presentedPopover?.close()
        let popover = NSPopover()
        popover.contentViewController = vc
        popover.contentSize = NSSize(width: width, height: height)
        popover.behavior = .transient
        popover.animates = true
        Self.presentedPopover = popover
        popover.show(relativeTo: anchor.bounds, of: anchor, preferredEdge: .minX)
    }

    private func dismissPresentedPopover() {
        Self.presentedPopover?.close()
        Self.presentedPopover = nil
    }
}

// MARK: - Periodic table floating window

/// Grid-based periodic table laid out on true group/period coordinates inside
/// its own window. Cell frames are computed once — no Auto Layout squeeze, no
/// truncation — and the window sizes itself to the grid.
final class PeriodicTableWindowController: NSViewController {
    struct Element: Hashable {
        let col: Int, row: Int, symbol: String, name: String
    }

    static let elements: [Element] = [
        .init(col: 1, row: 1, symbol: "H", name: "氢"), .init(col: 18, row: 1, symbol: "He", name: "氦"),
        .init(col: 1, row: 2, symbol: "Li", name: "锂"), .init(col: 2, row: 2, symbol: "Be", name: "铍"),
        .init(col: 13, row: 2, symbol: "B", name: "硼"), .init(col: 14, row: 2, symbol: "C", name: "碳"),
        .init(col: 15, row: 2, symbol: "N", name: "氮"), .init(col: 16, row: 2, symbol: "O", name: "氧"),
        .init(col: 17, row: 2, symbol: "F", name: "氟"), .init(col: 18, row: 2, symbol: "Ne", name: "氖"),
        .init(col: 1, row: 3, symbol: "Na", name: "钠"), .init(col: 2, row: 3, symbol: "Mg", name: "镁"),
        .init(col: 13, row: 3, symbol: "Al", name: "铝"), .init(col: 14, row: 3, symbol: "Si", name: "硅"),
        .init(col: 15, row: 3, symbol: "P", name: "磷"), .init(col: 16, row: 3, symbol: "S", name: "硫"),
        .init(col: 17, row: 3, symbol: "Cl", name: "氯"), .init(col: 18, row: 3, symbol: "Ar", name: "氩"),
        .init(col: 1, row: 4, symbol: "K", name: "钾"), .init(col: 2, row: 4, symbol: "Ca", name: "钙"),
        .init(col: 3, row: 4, symbol: "Sc", name: "钪"), .init(col: 4, row: 4, symbol: "Ti", name: "钛"),
        .init(col: 5, row: 4, symbol: "V", name: "钒"), .init(col: 6, row: 4, symbol: "Cr", name: "铬"),
        .init(col: 7, row: 4, symbol: "Mn", name: "锰"), .init(col: 8, row: 4, symbol: "Fe", name: "铁"),
        .init(col: 9, row: 4, symbol: "Co", name: "钴"), .init(col: 10, row: 4, symbol: "Ni", name: "镍"),
        .init(col: 11, row: 4, symbol: "Cu", name: "铜"), .init(col: 12, row: 4, symbol: "Zn", name: "锌"),
        .init(col: 13, row: 4, symbol: "Ga", name: "镓"), .init(col: 14, row: 4, symbol: "Ge", name: "锗"),
        .init(col: 15, row: 4, symbol: "As", name: "砷"), .init(col: 16, row: 4, symbol: "Se", name: "硒"),
        .init(col: 17, row: 4, symbol: "Br", name: "溴"), .init(col: 18, row: 4, symbol: "Kr", name: "氪"),
        .init(col: 1, row: 5, symbol: "Rb", name: "铷"), .init(col: 2, row: 5, symbol: "Sr", name: "锶"),
        .init(col: 3, row: 5, symbol: "Y", name: "钇"), .init(col: 4, row: 5, symbol: "Zr", name: "锆"),
        .init(col: 5, row: 5, symbol: "Nb", name: "铌"), .init(col: 6, row: 5, symbol: "Mo", name: "钼"),
        .init(col: 7, row: 5, symbol: "Tc", name: "锝"), .init(col: 8, row: 5, symbol: "Ru", name: "钌"),
        .init(col: 9, row: 5, symbol: "Rh", name: "铑"), .init(col: 10, row: 5, symbol: "Pd", name: "钯"),
        .init(col: 11, row: 5, symbol: "Ag", name: "银"), .init(col: 12, row: 5, symbol: "Cd", name: "镉"),
        .init(col: 13, row: 5, symbol: "In", name: "铟"), .init(col: 14, row: 5, symbol: "Sn", name: "锡"),
        .init(col: 15, row: 5, symbol: "Sb", name: "锑"), .init(col: 16, row: 5, symbol: "Te", name: "碲"),
        .init(col: 17, row: 5, symbol: "I", name: "碘"), .init(col: 18, row: 5, symbol: "Xe", name: "氙"),
        .init(col: 1, row: 6, symbol: "Cs", name: "铯"), .init(col: 2, row: 6, symbol: "Ba", name: "钡"),
        .init(col: 3, row: 6, symbol: "La", name: "镧"), .init(col: 4, row: 6, symbol: "Hf", name: "铪"),
        .init(col: 5, row: 6, symbol: "Ta", name: "钽"), .init(col: 6, row: 6, symbol: "W", name: "钨"),
        .init(col: 7, row: 6, symbol: "Re", name: "铼"), .init(col: 8, row: 6, symbol: "Os", name: "锇"),
        .init(col: 9, row: 6, symbol: "Ir", name: "铱"), .init(col: 10, row: 6, symbol: "Pt", name: "铂"),
        .init(col: 11, row: 6, symbol: "Au", name: "金"), .init(col: 12, row: 6, symbol: "Hg", name: "汞"),
        .init(col: 13, row: 6, symbol: "Tl", name: "铊"), .init(col: 14, row: 6, symbol: "Pb", name: "铅"),
        .init(col: 15, row: 6, symbol: "Bi", name: "铋"), .init(col: 16, row: 6, symbol: "Po", name: "钋"),
        .init(col: 17, row: 6, symbol: "At", name: "砹"), .init(col: 18, row: 6, symbol: "Rn", name: "氡"),
        .init(col: 1, row: 7, symbol: "Fr", name: "钫"), .init(col: 2, row: 7, symbol: "Ra", name: "镭"),
        .init(col: 3, row: 7, symbol: "Ac", name: "锕"), .init(col: 4, row: 7, symbol: "Rf", name: "钅卢"),
        .init(col: 5, row: 7, symbol: "Db", name: "钅杜"), .init(col: 6, row: 7, symbol: "Sg", name: "钅希"),
        .init(col: 7, row: 7, symbol: "Bh", name: "钅波"), .init(col: 8, row: 7, symbol: "Hs", name: "钅黑"),
        .init(col: 9, row: 7, symbol: "Mt", name: "麦"), .init(col: 10, row: 7, symbol: "Ds", name: "达"),
        .init(col: 11, row: 7, symbol: "Rg", name: "仑"), .init(col: 12, row: 7, symbol: "Cn", name: "哥"),
        .init(col: 13, row: 7, symbol: "Nh", name: "钅尔"), .init(col: 14, row: 7, symbol: "Fl", name: "钅夫"),
        .init(col: 15, row: 7, symbol: "Mc", name: "莫"), .init(col: 16, row: 7, symbol: "Lv", name: "钅李"),
        .init(col: 17, row: 7, symbol: "Ts", name: "钅田"), .init(col: 18, row: 7, symbol: "Og", name: "奥"),
        // Lanthanides strip (58-71; La sits in the main grid at 57).
        .init(col: 3, row: 9, symbol: "Ce", name: "铈"), .init(col: 4, row: 9, symbol: "Pr", name: "镨"),
        .init(col: 5, row: 9, symbol: "Nd", name: "钕"), .init(col: 6, row: 9, symbol: "Pm", name: "钷"),
        .init(col: 7, row: 9, symbol: "Sm", name: "钐"), .init(col: 8, row: 9, symbol: "Eu", name: "铕"),
        .init(col: 9, row: 9, symbol: "Gd", name: "钆"), .init(col: 10, row: 9, symbol: "Tb", name: "铽"),
        .init(col: 11, row: 9, symbol: "Dy", name: "镝"), .init(col: 12, row: 9, symbol: "Ho", name: "钬"),
        .init(col: 13, row: 9, symbol: "Er", name: "铒"), .init(col: 14, row: 9, symbol: "Tm", name: "铥"),
        .init(col: 15, row: 9, symbol: "Yb", name: "镱"), .init(col: 16, row: 9, symbol: "Lu", name: "镥"),
        // Actinides strip (90-103; Ac sits in the main grid at 89).
        .init(col: 3, row: 10, symbol: "Th", name: "钍"), .init(col: 4, row: 10, symbol: "Pa", name: "镤"),
        .init(col: 5, row: 10, symbol: "U", name: "铀"), .init(col: 6, row: 10, symbol: "Np", name: "镎"),
        .init(col: 7, row: 10, symbol: "Pu", name: "钚"), .init(col: 8, row: 10, symbol: "Am", name: "镅"),
        .init(col: 9, row: 10, symbol: "Cm", name: "锔"), .init(col: 10, row: 10, symbol: "Bk", name: "锫"),
        .init(col: 11, row: 10, symbol: "Cf", name: "锎"), .init(col: 12, row: 10, symbol: "Es", name: "锿"),
        .init(col: 13, row: 10, symbol: "Fm", name: "镄"), .init(col: 14, row: 10, symbol: "Md", name: "钔"),
        .init(col: 15, row: 10, symbol: "No", name: "锘"), .init(col: 16, row: 10, symbol: "Lr", name: "铹"),
        // Query / wildcard strip.
        .init(col: 1, row: 11, symbol: "A", name: "任意原子"), .init(col: 2, row: 11, symbol: "Q", name: "Q 基团"),
        .init(col: 3, row: 11, symbol: "R", name: "R 基团"), .init(col: 4, row: 11, symbol: "M", name: "金属"),
        .init(col: 5, row: 11, symbol: "X", name: "卤素"), .init(col: 6, row: 11, symbol: "D", name: "氘"),
        .init(col: 7, row: 11, symbol: "*", name: "任意"),
    ]

    /// Chemical-family tint per symbol (soft pastels, mirrors Ketcher's table).
    private static func tint(for symbol: String) -> NSColor {
        switch symbol {
        case "H", "He": return .systemGray
        case "Li", "Na", "K", "Rb", "Cs", "Fr": return .systemRed
        case "Be", "Mg", "Ca", "Sr", "Ba", "Ra": return .systemOrange
        case "B", "Al", "Ga", "In", "Tl": return .systemBrown
        case "C", "Si", "Ge", "Sn", "Pb": return .systemGray
        case "N", "P", "As", "Sb", "Bi": return .systemBlue
        case "O", "S", "Se", "Te", "Po": return .systemYellow
        case "F", "Cl", "Br", "I", "At": return .systemGreen
        case "La", "Ce", "Pr", "Nd", "Pm", "Sm", "Eu", "Gd", "Tb", "Dy", "Ho", "Er", "Tm", "Yb", "Lu":
            return .systemPurple
        case "A", "Q", "R", "M", "X", "D", "*": return .systemTeal
        default: return .systemPink // transition metals
        }
    }

    var onElementChosen: ((String) -> Void)?
    var escMonitor: Any?
    private let supported: Set<String>
    private let activeSymbol: String?

    func closeWindow() {
        view.window?.orderOut(nil)
    }

    deinit {
        if let monitor = escMonitor { NSEvent.removeMonitor(monitor) }
    }

    init(supported: Set<String>, activeSymbol: String?) {
        self.supported = supported
        self.activeSymbol = activeSymbol
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    override func loadView() {
        let cellSize: CGFloat = 34
        let gap: CGFloat = 3
        let margin: CGFloat = 12
        let titleHeight: CGFloat = 24
        let headerSize: CGFloat = 16   // group/period number header band
        let cols = 18, gridRows = 11
        let gridWidth = CGFloat(cols) * cellSize + CGFloat(cols - 1) * gap
        let gridHeight = CGFloat(gridRows) * cellSize + CGFloat(gridRows - 1) * gap
        let width = gridWidth + margin * 2 + headerSize
        let height = gridHeight + margin * 2 + titleHeight + 6 + headerSize

        let root = NSView(frame: NSRect(x: 0, y: 0, width: width, height: height))

        let title = NSTextField(labelWithString: "元素周期表 · 点击选择元素工具")
        title.font = .systemFont(ofSize: 11.5, weight: .medium)
        title.textColor = .secondaryLabelColor
        title.frame = NSRect(x: margin + headerSize, y: height - titleHeight - 2, width: width - margin * 2 - headerSize, height: titleHeight)
        root.addSubview(title)

        // Grid origin (top-left of the cell area) in AppKit coordinates.
        let gridTop = titleHeight + 4 + headerSize
        let gridLeft = margin + headerSize   // period numbers on the left

        // Group numbers 1-18 across the top (thin grey, no button).
        for col in 1...cols {
            let x = gridLeft + CGFloat(col - 1) * (cellSize + gap)
            let y = height - gridTop + headerSize + 2
            let label = NSTextField(labelWithString: String(col))
            label.font = .systemFont(ofSize: 8)
            label.textColor = .tertiaryLabelColor
            label.alignment = .center
            label.frame = NSRect(x: x, y: y, width: cellSize, height: 10)
            root.addSubview(label)
        }
        // Period numbers 1-7 down the left edge.
        for row in 1...7 {
            let y = height - gridTop - CGFloat(row - 1) * (cellSize + gap) - cellSize
            let label = NSTextField(labelWithString: String(row))
            label.font = .systemFont(ofSize: 8)
            label.textColor = .tertiaryLabelColor
            label.alignment = .right
            label.frame = NSRect(x: margin, y: y + cellSize / 2 - 5, width: headerSize - 6, height: 10)
            root.addSubview(label)
        }

        var cellsBySymbol: [String: ElementCell] = [:]
        func addCell(frame: NSRect, symbol: String, name: String, tint: NSColor, enabled: Bool, dimmed: Bool = false) {
            let button = ElementCell(frame: frame)
            button.configure(symbol: symbol, name: name, tint: tint,
                             enabled: enabled, dimmed: dimmed)
            button.onActivated = { [weak self] symbol in
                self?.onElementChosen?(symbol)
            }
            root.addSubview(button)
            cellsBySymbol[symbol] = button
        }

        for el in Self.elements {
            let x = gridLeft + CGFloat(el.col - 1) * (cellSize + gap)
            let yTop = gridTop + CGFloat(el.row - 1) * (cellSize + gap)
            let y = height - yTop - cellSize
            addCell(frame: NSRect(x: x, y: y, width: cellSize, height: cellSize),
                    symbol: el.symbol, name: el.name,
                    tint: Self.tint(for: el.symbol),
                    enabled: supported.contains(el.symbol))
        }

        // Lanthanide / actinide strip labels sit left of rows 9-10 (the strips
        // start at Ce/Th; La/Ac live in the main grid at group 3). The main
        // grid itself needs no placeholder: La and Ac are real cells now.
        func stripLabel(row: Int, text: String) {
            let y = height - gridTop - CGFloat(row - 1) * (cellSize + gap) - cellSize
            let label = NSTextField(labelWithString: text)
            label.font = .systemFont(ofSize: 8.5)
            label.textColor = .secondaryLabelColor
            label.alignment = .right
            label.frame = NSRect(x: margin - 2, y: y + cellSize / 2 - 6, width: headerSize - 4, height: 14)
            root.addSubview(label)
        }
        stripLabel(row: 9, text: "镧系")
        stripLabel(row: 10, text: "锕系")

        // Current active element (state.tool "element.C" etc.) gets a ring.
        if let activeSymbol {
            cellsBySymbol[activeSymbol]?.markSelected()
        }

        view = root
    }
}

/// Rounded element cell: symbol + full name, tinted background when enabled.
final class ElementCell: NSControl {
    private var symbolLabel: NSTextField!
    private var nameLabel: NSTextField!
    private var tint: NSColor = .controlBackgroundColor
    private var hovered = false
    private var selected = false
    private var dimmed = false
    private var tracking: NSTrackingArea?

    var onActivated: ((String) -> Void)?

    func configure(symbol: String, name: String, tint: NSColor, enabled: Bool, dimmed: Bool = false) {
        self.tint = tint
        self.dimmed = dimmed
        let label = NSTextField(labelWithString: symbol)
        label.font = dimmed ? .systemFont(ofSize: 9, weight: .medium) : .systemFont(ofSize: 13, weight: .semibold)
        label.alignment = .center
        label.frame = NSRect(x: 0, y: dimmed ? 11 : 13, width: frame.width, height: dimmed ? 12 : 16)
        addSubview(label)
        symbolLabel = label

        let sub = NSTextField(labelWithString: enabled ? name : (dimmed ? name : "未支持"))
        sub.font = .systemFont(ofSize: 7.5)
        sub.alignment = .center
        sub.textColor = .secondaryLabelColor
        sub.frame = NSRect(x: 0, y: 5, width: frame.width, height: 9)
        addSubview(sub)
        nameLabel = sub

        self.isEnabled = enabled
        wantsLayer = true
        layer?.cornerRadius = 7
        layer?.masksToBounds = true
        refreshAppearance()
    }

    /// Ring the cell as the currently active element tool.
    func markSelected() {
        selected = true
        wantsLayer = true
        refreshAppearance()
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let tracking { removeTrackingArea(tracking) }
        // activeAlways so hover state never sticks when the window loses key.
        let area = NSTrackingArea(rect: bounds,
                                  options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect],
                                  owner: self, userInfo: nil)
        addTrackingArea(area)
        tracking = area
    }

    override func mouseEntered(with event: NSEvent) { hovered = true; refreshAppearance() }
    override func mouseExited(with event: NSEvent) { hovered = false; refreshAppearance() }

    override func mouseDown(with event: NSEvent) {
        guard isEnabled else { return }
        onActivated?(symbolLabel?.stringValue ?? "")
    }

    private func refreshAppearance() {
        guard let layer else { return }
        if !isEnabled {
            layer.backgroundColor = dimmed
                ? tint.withAlphaComponent(0.10).cgColor
                : NSColor.quaternaryLabelColor.withAlphaComponent(0.10).cgColor
            symbolLabel?.textColor = dimmed ? .secondaryLabelColor : .tertiaryLabelColor
            layer.borderColor = NSColor.clear.cgColor
            layer.borderWidth = 0
            return
        }
        if hovered {
            layer.backgroundColor = tint.withAlphaComponent(0.45).cgColor
        } else {
            layer.backgroundColor = tint.withAlphaComponent(0.22).cgColor
        }
        symbolLabel?.textColor = .labelColor
        if selected {
            layer.borderColor = NSColor.controlAccentColor.cgColor
            layer.borderWidth = 2
        } else {
            layer.borderColor = NSColor.clear.cgColor
            layer.borderWidth = 0
        }
    }
}

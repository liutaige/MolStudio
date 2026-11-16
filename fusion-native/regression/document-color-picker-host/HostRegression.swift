import WebKit
import AppKit
import Foundation

// MARK: - Lightweight Assertions & Mock Bridge

private var failedAssertions: [String] = []
private var passedTests = 0

private func expect(_ condition: @autoclosure () -> Bool, _ message: String, file: StaticString = #fileID, line: UInt = #line) {
    if !condition() {
        let entry = "FAIL [\(file):\(line)] \(message)"
        failedAssertions.append(entry)
        fputs("\(entry)\n", stderr)
    }
}

private func expectEqual<T: Equatable>(_ actual: T, _ expected: T, _ message: String, file: StaticString = #fileID, line: UInt = #line) {
    if actual != expected {
        let entry = "FAIL [\(file):\(line)] \(message): expected=\(expected), actual=\(actual)"
        failedAssertions.append(entry)
        fputs("\(entry)\n", stderr)
    }
}

@MainActor
private func runTest(_ name: String, _ block: @MainActor () -> Void) {
    let before = failedAssertions.count
    block()
    if failedAssertions.count == before {
        passedTests += 1
        print("PASS: \(name)")
    } else {
        print("FAIL: \(name)")
    }
}

/// Deterministic in-memory mock implementation of the 4-method nativeUI bridge.
private final class MockNativeUIBridge: WorkspaceNativeUIBridging {
    struct DispatchedRecord {
        let command: WorkspaceCommand
        let replyCompletion: (Result<WorkspaceCommandReply, Error>) -> Void
    }

    var onAttachCalled: ((WorkspaceAttachOptions, @escaping (Result<WorkspaceAttachReply, Error>) -> Void) -> Void)?
    var attachedEpoch: WorkspaceEpoch?
    var acceptedSurfaces: [WorkspaceSurface] = WorkspaceSurface.allCases
    var initialState = WorkspaceUIState.disabledInitial()
    var shouldFailAttach = false

    private(set) var attachCount = 0
    private(set) var detachCalls: [WorkspaceEpoch] = []
    private(set) var dispatchedCommands: [WorkspaceCommand] = []
    private(set) var inFlightDispatches: [DispatchedRecord] = []
    var autoReplyCommands = true
    var customReplyHandler: ((WorkspaceCommand) -> WorkspaceCommandReply)?

    func attach(options: WorkspaceAttachOptions, completion: @escaping (Result<WorkspaceAttachReply, Error>) -> Void) {
        attachCount += 1
        if let onAttachCalled {
            onAttachCalled(options, completion)
            return
        }
        if shouldFailAttach {
            completion(.failure(WorkspaceBridgeError.scriptError("attach rejected in test")))
            return
        }
        let epoch = attachedEpoch ?? WorkspaceEpoch(navigationGeneration: 0, pageId: "page-0")
        let reply = WorkspaceAttachReply(
            ok: true,
            epoch: epoch,
            sequence: 0,
            ownedSurfaces: acceptedSurfaces,
            state: initialState
        )
        completion(.success(reply))
    }

    func dispatch(command: WorkspaceCommand, completion: @escaping (Result<WorkspaceCommandReply, Error>) -> Void) {
        dispatchedCommands.append(command)
        if !autoReplyCommands {
            inFlightDispatches.append(DispatchedRecord(command: command, replyCompletion: completion))
            return
        }
        if let handler = customReplyHandler {
            completion(.success(handler(command)))
            return
        }
        let reply = WorkspaceCommandReply(
            epoch: command.epoch,
            requestId: command.requestId,
            ok: true,
            stateRevision: initialState.revision
        )
        completion(.success(reply))
    }

    func getState(completion: @escaping (Result<WorkspaceUIState, Error>) -> Void) {
        completion(.success(initialState))
    }

    func detach(epoch: WorkspaceEpoch) {
        detachCalls.append(epoch)
    }

    func completeNextInFlight(ok: Bool = true, errorCode: String? = nil, errorMessage: String? = nil) {
        guard !inFlightDispatches.isEmpty else { return }
        let record = inFlightDispatches.removeFirst()
        let err = ok ? nil : WorkspaceCommandError(code: errorCode ?? "failed", message: errorMessage ?? "failed")
        record.replyCompletion(.success(WorkspaceCommandReply(
            epoch: record.command.epoch,
            requestId: record.command.requestId,
            ok: ok,
            error: err,
            stateRevision: initialState.revision
        )))
    }
}

private func makeReadyState(
    epoch: WorkspaceEpoch = WorkspaceEpoch(navigationGeneration: 0, pageId: "p0"),
    revision: Int = 1,
    selection: WorkspaceUIState.Selection? = nil,
    viewportMode: WorkspaceViewportMode = .canvas,
    supportedCommands: [String]? = nil,
    canUndo: Bool = true,
    canRedo: Bool = false
) -> WorkspaceUIState {
    WorkspaceUIState(
        protocol: 1,
        epoch: epoch,
        revision: revision,
        ready: .init(canvas: true, agent: true),
        supported: .init(
            commands: supportedCommands ?? [
                "host.context", "tool.set", "element.set", "template.set",
                "zoom.by", "zoom.toPercent",
                "edit.undo", "edit.redo", "edit.selectAll", "edit.delete",
                "selection.setProperty", "selection.replan", "selection.toggleBondComponent",
                "agent.send", "agent.stop", "agent.continue", "agent.reset",
                "agent.settings.load", "agent.settings.save"
            ],
            toolIds: ["select", "bond.single", "bond.double", "electronPairArrow", "fishhookArrow", "lonePair", "reactionArrow"],
            elementSymbols: ["C", "H", "O", "N"],
            templateIds: ["ring.benzene", "ring.cyclohexane"]
        ),
        tool: .init(id: "select", label: "选择"),
        selection: selection ?? .init(revision: 3, kind: .none, count: 0, label: "", properties: []),
        history: .init(canUndo: canUndo, canRedo: canRedo),
        viewport: .init(mode: viewportMode, percent: 100.0, cssSize: WorkspaceCSSSize(width: 900, height: 640), appliedHostLayoutRevision: 0),
        agent: .init(running: false, pendingStart: false, canContinue: false, settingsBusy: false)
    )
}


@MainActor private final class ColorPickerHostRegression {
    private let bridge = MockNativeUIBridge()
    private let window = NSWindow(contentRect: NSRect(x: 100, y: 100, width: 1400, height: 900), styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
    private var split: WorkspaceSplitViewController!
    private var control: WorkspaceCommitColorWellView?
    private var otherWindow: NSWindow?
    private var checks: [[String: Any]] = []
    private var snapshots: [[String: Any]] = []
    private let output = URL(fileURLWithPath: ProcessInfo.processInfo.environment["MOLSTUDIO_NATIVE_TEST_OUT"] ?? "/tmp/molstudio-color-picker-host", isDirectory: true)
    private func later(_ seconds: Double, _ action: @escaping () -> Void) { DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: action) }
    private func findControl(_ view: NSView) -> WorkspaceCommitColorWellView? {
        if let control = view as? WorkspaceCommitColorWellView { return control }
        return view.subviews.lazy.compactMap { self.findControl($0) }.first
    }
    private func snapshot(_ name: String) -> [String: Any] {
        let state: [String: Any] = ["name": name, "panelVisible": NSColorPanel.shared.isVisible,
            "panelKey": NSApp.keyWindow === NSColorPanel.shared, "wellActive": control?.colorWell.isActive ?? false,
            "ownedSession": split.inspectorViewController.hasActiveOwnedColorPickerSession,
            "propertiesVisible": control?.window?.isVisible ?? false]
        snapshots.append(state); return state
    }
    private func check(_ name: String, _ pass: Bool) { checks.append(["name": name, "pass": pass]) }
    private func click(_ well: NSColorWell) {
        guard let target = well.window else { return }
        let point = well.convert(NSPoint(x: well.bounds.midX, y: well.bounds.midY), to: nil)
        let up = NSEvent.mouseEvent(with: .leftMouseUp, location: point, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime + 0.03, windowNumber: target.windowNumber, context: nil, eventNumber: 1, clickCount: 1, pressure: 0)!
        let down = NSEvent.mouseEvent(with: .leftMouseDown, location: point, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: target.windowNumber, context: nil, eventNumber: 1, clickCount: 1, pressure: 1)!
        // NSColorWell's mouseDown tracks synchronously. Queue the real release
        // before entering its tracking loop, just as AppKit's event queue does.
        NSApp.postEvent(up, atStart: false); NSApp.sendEvent(down)
    }
    func start() {
        let epoch = WorkspaceEpoch(navigationGeneration: 1, pageId: "native-color-host-regression")
        bridge.attachedEpoch = epoch
        bridge.initialState = makeReadyState(epoch: epoch, revision: 2, selection: .init(revision: 7, kind: .none, count: 0, label: "形状样式", properties: [
            .init(id: "shapeStyle.fillColor", label: "默认填充颜色", type: .text, value: .string("#ffffff"), enabled: true)
        ]))
        let coordinator = WorkspaceStateCoordinator(bridge: bridge)
        split = WorkspaceSplitViewController(coordinator: coordinator, canvasContentView: WKWebView(frame: .zero))
        window.title = "MolStudio isolated production colour-picker host regression"
        window.contentViewController = split; _ = split.view
        coordinator.beginNavigation(generation: 1); coordinator.attach(preparedSurfaces: WorkspaceSurface.allCases)
        split.installWindowChrome(on: window, attachToolbar: false)
        window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
        later(0.5) { self.split.showInspectorTab(.properties) }
        later(1.0) { self.control = self.findControl(self.split.inspectorViewController.propertiesViewController.view); if let control = self.control { self.click(control.colorWell) } }
        later(1.5) {
            _ = self.snapshot("after native well mouseDown")
            self.check("a native well click opens an owned picker inside the production host", NSColorPanel.shared.isVisible && self.control?.colorWell.isActive == true && self.split.inspectorViewController.hasActiveOwnedColorPickerSession)
            NSColorPanel.shared.makeKeyAndOrderFront(nil)
        }
        later(2.0) {
            _ = self.snapshot("after picker receives key")
            self.check("picker key focus retains the owned session and transient properties popover", NSApp.keyWindow === NSColorPanel.shared && NSColorPanel.shared.isVisible && self.control?.colorWell.isActive == true && self.split.inspectorViewController.hasActiveOwnedColorPickerSession && self.control?.window?.isVisible == true)
            let other = NSWindow(contentRect: NSRect(x: 20, y: 20, width: 220, height: 150), styleMask: [.titled], backing: .buffered, defer: false)
            self.otherWindow = other; other.title = "Independent ordinary-window cancellation target"; other.makeKeyAndOrderFront(nil)
        }
        later(2.5) {
            _ = self.snapshot("after ordinary other window receives key")
            self.check("an unrelated window still cancels the picker and dismisses properties", !NSColorPanel.shared.isVisible && self.control?.colorWell.isActive == false && !self.split.inspectorViewController.hasActiveOwnedColorPickerSession && self.control?.window?.isVisible != true)
            self.finish()
        }
        later(20) { self.check("host regression completed within timeout", false); self.finish() }
    }
    private func finish() {
        let ok = checks.count == 3 && checks.allSatisfy { $0["pass"] as? Bool == true }
        let report: [String: Any] = ["application": "MolStudio current native Workspace host", "runtime": "real AppKit/WKWebView, production Split/Inspector/Coordinator", "boundary": "Only JavaScript bridge state is mocked; this verifies native picker focus, popover ownership and ordinary-window cancellation, not document colour persistence.", "ok": ok, "checks": checks, "snapshots": snapshots]
        try? FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
        if let data = try? JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]) { try? data.write(to: output.appendingPathComponent("report.json")); print(String(data: data, encoding: .utf8)!) }
        NSColorPanel.shared.orderOut(nil); otherWindow?.orderOut(nil); window.orderOut(nil)
        exit(ok ? 0 : 1)
    }
}
@main private struct HostRegressionRunner {
    @MainActor static func main() { let app = NSApplication.shared; app.setActivationPolicy(.regular); let probe = ColorPickerHostRegression(); probe.start(); app.run(); withExtendedLifetime(probe) {} }
}

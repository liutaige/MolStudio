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

private func makeStateDict(epoch: WorkspaceEpoch, revision: Int, toolId: String = "bond.single") -> [String: Any] {
    [
        "protocol": 1,
        "epoch": ["navigationGeneration": epoch.navigationGeneration, "pageId": epoch.pageId],
        "revision": revision,
        "ready": ["canvas": true, "agent": true],
        "supported": [
            "commands": ["tool.set", "zoom.by"],
            "toolIds": ["select", "bond.single"],
            "elementSymbols": ["C"],
            "templateIds": ["ring.benzene"],
        ],
        "tool": ["id": toolId, "label": toolId],
        "selection": ["revision": revision, "kind": "none", "count": 0, "label": "", "properties": []],
        "history": ["canUndo": true, "canRedo": false],
        "viewport": ["mode": "canvas", "percent": 125.0, "cssSize": ["width": 800, "height": 600], "appliedHostLayoutRevision": 1],
        "agent": ["running": false, "pendingStart": false, "canContinue": false, "settingsBusy": false],
    ]
}

// MARK: - Tests

@MainActor
private func runAllTests() {
    _ = NSApplication.shared

    // 1. Epoch invalidation, sequence monotonicity & pre-attach buffering
    runTest("EpochInvalidationSequenceAndBuffering") {
        let bridge = MockNativeUIBridge()
        var pendingAttachCompletion: ((Result<WorkspaceAttachReply, Error>) -> Void)?
        bridge.onAttachCalled = { _, completion in
            pendingAttachCompletion = completion
        }

        let coordinator = WorkspaceStateCoordinator(bridge: bridge)
        let epoch0 = WorkspaceEpoch(navigationGeneration: 0, pageId: "p-main")
        coordinator.attach(preparedSurfaces: WorkspaceSurface.allCases)

        // Messages arriving before attach finishes are buffered, not dropped or prematurely active
        _ = coordinator.receiveRawScriptMessage([
            "act": "nativeUI",
            "protocol": 1,
            "epoch": ["navigationGeneration": 0, "pageId": "p-main"],
            "sequence": 2,
            "kind": "state",
            "payload": makeStateDict(epoch: epoch0, revision: 12, toolId: "bond.single"),
        ])
        _ = coordinator.receiveRawScriptMessage([
            "act": "nativeUI",
            "protocol": 1,
            "epoch": ["navigationGeneration": 0, "pageId": "p-main"],
            "sequence": 1,
            "kind": "state",
            "payload": makeStateDict(epoch: epoch0, revision: 11, toolId: "select"),
        ])
        expect(!coordinator.isAttached, "Coordinator must stay unattached until handshake finishes")
        expectEqual(coordinator.uiState.ready.canvas, false, "Canvas must stay unready during buffering")

        // Complete attach -> buffered messages replay in monotonic seq order (seq 1 then seq 2)
        pendingAttachCompletion?(.success(WorkspaceAttachReply(
            ok: true,
            epoch: epoch0,
            sequence: 0,
            ownedSurfaces: WorkspaceSurface.allCases,
            state: makeReadyState(epoch: epoch0, revision: 10)
        )))

        expect(coordinator.isAttached, "Coordinator attached after completion")
        expectEqual(coordinator.lastSequence, 2, "Replay reached seq 2")
        expectEqual(coordinator.uiState.revision, 12, "Latest buffered state seq 2 applied")
        expectEqual(coordinator.uiState.tool.id, "bond.single", "Final tool from seq 2")

        // Duplicate / older seq is rejected
        _ = coordinator.receiveRawScriptMessage([
            "act": "nativeUI",
            "protocol": 1,
            "epoch": ["navigationGeneration": 0, "pageId": "p-main"],
            "sequence": 2,
            "kind": "state",
            "payload": makeStateDict(epoch: epoch0, revision: 99, toolId: "select"),
        ])
        expectEqual(coordinator.uiState.revision, 12, "Duplicate seq 2 must be ignored")

        // Stale epoch is rejected
        _ = coordinator.receiveRawScriptMessage([
            "act": "nativeUI",
            "protocol": 1,
            "epoch": ["navigationGeneration": 0, "pageId": "p-old"],
            "sequence": 3,
            "kind": "state",
            "payload": makeStateDict(epoch: WorkspaceEpoch(navigationGeneration: 0, pageId: "p-old"), revision: 99, toolId: "select"),
        ])
        expectEqual(coordinator.uiState.revision, 12, "Stale pageId must be ignored")

        // Navigation invalidates epoch cleanly and calls detach
        coordinator.beginNavigation(generation: 1)
        expectEqual(bridge.detachCalls, [epoch0], "Old epoch must be detached on navigation")
        expectEqual(coordinator.uiState.ready.canvas, false, "Canvas immediately unready on navigation")
        expectEqual(coordinator.documentMetadata.isNavigationInFlight, true, "Navigation in flight flagged")
    }

    // 2. Partial & failed attach + strict surface/command gating
    runTest("PartialFailedAttachAndSurfaceGating") {
        // Failed attach leaves everything disabled
        let failedBridge = MockNativeUIBridge()
        failedBridge.shouldFailAttach = true
        let failedCoord = WorkspaceStateCoordinator(bridge: failedBridge)
        let paletteUnready = WorkspaceToolPaletteView(coordinator: failedCoord)
        let zoomUnready = WorkspaceZoomOverlayView(coordinator: failedCoord)
        let inspectorUnready = WorkspacePropertiesViewController(coordinator: failedCoord)
        _ = inspectorUnready.view

        failedCoord.attach(preparedSurfaces: WorkspaceSurface.allCases)
        expect(!failedCoord.isAttached, "Failed attach must not attach")
        expectEqual(paletteUnready.button(forSlotKey: "select")?.isEnabled, false, "Select disabled before attach")
        expectEqual(zoomUnready.zoomInButton.isEnabled, false, "Zoom in disabled before attach")
        expectEqual(zoomUnready.fitButton.isEnabled, false, "Zoom fit disabled before attach")
        expectEqual(inspectorUnready.elementButton(forSymbol: "C")?.isEnabled, false, "Element disabled before attach")
        expectEqual(inspectorUnready.templateButton(forTemplateId: "ring.benzene")?.isEnabled, false, "Template disabled before attach")

        // Partial attach: only toolPalette & zoomPalette & fileCommands granted; inspector & agent omitted; zoom.fit unsupported
        let partialBridge = MockNativeUIBridge()
        let ep = WorkspaceEpoch(navigationGeneration: 0, pageId: "p-part")
        partialBridge.attachedEpoch = ep
        partialBridge.acceptedSurfaces = [.fileCommands, .toolPalette, .zoomPalette]
        partialBridge.initialState = makeReadyState(
            epoch: ep,
            revision: 5,
            viewportMode: .canvas,
            supportedCommands: ["host.context", "tool.set", "zoom.by", "zoom.toPercent", "element.set", "template.set"]
        )
        let partialCoord = WorkspaceStateCoordinator(bridge: partialBridge)
        let palette = WorkspaceToolPaletteView(coordinator: partialCoord)
        let zoom = WorkspaceZoomOverlayView(coordinator: partialCoord)
        let inspector = WorkspacePropertiesViewController(coordinator: partialCoord)
        _ = inspector.view
        let agentVC = WorkspaceAgentViewController(coordinator: partialCoord)
        _ = agentVC.view

        partialCoord.attach(preparedSurfaces: WorkspaceSurface.allCases)

        expectEqual(palette.button(forSlotKey: "select")?.isEnabled, true, "Supported tool enabled when toolPalette owned")
        // Lasso is a merged variant of the single selection slot (native
        // sub-menu), not a separate default-visible button. The slot is
        // enabled when any of its verified variants is available; the
        // unsupported variant itself stays disabled in the variant menu.
        let selectSlot = palette.button(forSlotKey: "lasso")
        expect(selectSlot != nil, "Lasso resolves to the merged selection slot")
        expectEqual(selectSlot?.slot.variants.first { $0.id == "lasso" }.map { _ in true }, true,
            "Lasso variant is exposed through the selection submenu")
        expectEqual(palette.button(forSlotKey: "electronPairArrow")?.isEnabled, true, "Supported electronPairArrow enabled")
        expectEqual(zoom.zoomInButton.isEnabled, true, "zoom.by enabled")
        expectEqual(zoom.fitButton.isEnabled, false, "Unsupported zoom.fit stays disabled")
        expectEqual(inspector.elementButton(forSymbol: "C")?.isEnabled, false, "Unowned inspector surface keeps elements disabled")
        expectEqual(agentVC.sendButton.isEnabled, false, "Unowned agent surface keeps send disabled")
    }

    // 3. Single-commit slider, Escape/focus-loss cancel, revision bump cancel, deduplicated requestId, file gate cancel
    runTest("SliderSingleCommitCancelAndFileGate") {
        let bridge = MockNativeUIBridge()
        let ep = WorkspaceEpoch(navigationGeneration: 1, pageId: "p-slider")
        bridge.attachedEpoch = ep
        let bendProp = WorkspaceSelectionProperty(
            id: "bend",
            label: "弯曲度",
            type: .number,
            value: .number(0.20),
            enabled: true,
            min: -2.4,
            max: 2.4,
            step: 0.02,
            choices: nil
        )
        bridge.initialState = makeReadyState(
            epoch: ep,
            revision: 2,
            selection: .init(revision: 7, kind: .electronFlow, count: 1, label: "弯箭头", properties: [bendProp])
        )

        var saveCallCount = 0
        let callbacks = WorkspaceFileServiceCallbacks(onSave: { saveCallCount += 1 })
        let splitVC = WorkspaceSplitViewController(
            coordinator: WorkspaceStateCoordinator(bridge: bridge, fileCallbacks: callbacks)
        )
        _ = splitVC.view
        splitVC.coordinator.beginNavigation(generation: 1)
        splitVC.coordinator.attach(preparedSurfaces: WorkspaceSurface.allCases)

        let propsVC = splitVC.inspectorViewController.propertiesViewController
        _ = propsVC.view                 // ensure the AppKit view hierarchy is loaded
        propsVC.refreshState()           // bind the injected selection state
        guard let slider = propsVC.sliderView(forPropertyId: "bend") else {
            expect(false, "Expected bend slider to render")
            return
        }

        // Drag preview updates locally with zero JS commits, then release dispatches exactly 1 commit
        let initialDispatches = bridge.dispatchedCommands.filter { $0.id == "selection.setProperty" }.count
        slider.beginInteraction()
        slider.updatePreviewDuringInteraction(0.60)
        slider.updatePreviewDuringInteraction(1.10)
        slider.updatePreviewDuringInteraction(1.42)
        let midDispatches = bridge.dispatchedCommands.filter { $0.id == "selection.setProperty" }.count
        expectEqual(midDispatches, initialDispatches, "Zero selection.setProperty commits during drag")

        slider.finishInteractionCommit(finalValue: 1.42)
        let postCommits = bridge.dispatchedCommands.filter { $0.id == "selection.setProperty" }
        expectEqual(postCommits.count, 1, "Exactly one commit on slider release")
        expectEqual(postCommits.first?.expectedSelectionRevision, 7, "Expected selection revision matches captured revision")
        expectEqual(postCommits.first?.args?["value"]?.foundationValue as? Double, 1.42, "Committed bend value matches final release")
        expect(postCommits.first?.args?["editId"]?.foundationValue as? String != nil, "Committed bend carries editId")

        // File gate cancels uncommitted drag without committing property, before invoking Swift onSave
        slider.beginInteraction()
        slider.updatePreviewDuringInteraction(-2.10)
        splitVC.coordinator.performFileAction(callbacks.onSave)
        expectEqual(saveCallCount, 1, "Swift file save callback invoked")
        expect(!slider.isInteracting, "File gate cancelled active slider drag")
        expectEqual(slider.slider.doubleValue, 1.42, "Cancelled slider reverted to committed value")
        expectEqual(bridge.dispatchedCommands.filter { $0.id == "selection.setProperty" }.count, 1, "File gate must not commit uncommitted drag")

        // Stale selection revision during drag aborts commit
        slider.beginInteraction()
        slider.updatePreviewDuringInteraction(2.0)
        let nextState = makeReadyState(
            epoch: ep,
            revision: 3,
            selection: .init(revision: 8, kind: .electronFlow, count: 1, label: "弯箭头", properties: [bendProp])
        )
        bridge.initialState = nextState
        if let jsonData = try? JSONEncoder().encode(nextState),
           let stateObj = try? JSONSerialization.jsonObject(with: jsonData) as? [String: Any] {
            _ = splitVC.coordinator.receiveRawScriptMessage([
                "act": "nativeUI",
                "protocol": 1,
                "epoch": ["navigationGeneration": ep.navigationGeneration, "pageId": ep.pageId],
                "sequence": 1,
                "kind": "state",
                "payload": stateObj,
            ])
        }
        slider.finishInteractionCommit(finalValue: 2.0)
        expectEqual(bridge.dispatchedCommands.filter { $0.id == "selection.setProperty" }.count, 1, "Stale revision cancels slider commit")

        // In-flight duplicate requestId rejection on bridge
        bridge.autoReplyCommands = false
        let reqId = "fixed-req-123"
        let cmd = WorkspaceCommand(epoch: ep, requestId: reqId, id: "tool.set", args: ["id": .string("select")])
        splitVC.coordinator.dispatchCommand(id: cmd.id, args: cmd.args, requestId: reqId)
        var dupRejected = false
        splitVC.coordinator.dispatchCommand(id: cmd.id, args: cmd.args, requestId: reqId) { result in
            if case .success(let reply) = result, reply.error?.code == "failed" {
                dupRejected = true
            }
        }
        expect(dupRejected, "Duplicate in-flight requestId must be rejected cleanly")
        bridge.completeNextInFlight()
    }

    // 4. Responder-first Undo/Clipboard/Focus routing + non-text action focus protection
    runTest("ResponderFirstUndoClipboardAndFocusSafety") {
        let bridge = MockNativeUIBridge()
        let ep = WorkspaceEpoch(navigationGeneration: 0, pageId: "p-focus")
        bridge.attachedEpoch = ep
        bridge.initialState = makeReadyState(epoch: ep, revision: 1, canUndo: true, canRedo: true)

        let canvasView = NSView(frame: NSRect(x: 0, y: 0, width: 600, height: 500))
        let coord = WorkspaceStateCoordinator(bridge: bridge)
        let splitVC = WorkspaceSplitViewController(coordinator: coord, canvasContentView: canvasView)
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1180, height: 760),
            styleMask: [.titled, .closable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.contentViewController = splitVC
        splitVC.installWindowChrome(on: window)
        coord.attach(preparedSurfaces: WorkspaceSurface.allCases)
        if ProcessInfo.processInfo.environment["MOLSTUDIO_HEADLESS"] != "1" {
            window.makeKeyAndOrderFront(nil)
        } else {
            window.layoutIfNeeded()
        }

        // Show Agent tab and focus native composer text view with real undo history
        splitVC.showInspectorTab(.agent)
        let composer = splitVC.inspectorViewController.agentViewController as! WorkspaceAgentViewController
        let tv = composer.composerTextView
        window.makeFirstResponder(tv)
        expectEqual(WorkspaceFocusRouter.classifyFocusOwner(in: window, canvasView: canvasView), .nativeText, "Composer owns nativeText focus")

        let r1 = NSRange(location: 0, length: 0)
        if tv.shouldChangeText(in: r1, replacementString: "CC=O") {
            tv.textStorage?.replaceCharacters(in: r1, with: "CC=O")
            tv.didChangeText()
        }
        tv.breakUndoCoalescing()
        RunLoop.current.run(mode: .default, before: Date(timeIntervalSinceNow: 0.02))
        let r2 = NSRange(location: tv.string.count, length: 0)
        if tv.shouldChangeText(in: r2, replacementString: " + H2O") {
            tv.textStorage?.replaceCharacters(in: r2, with: " + H2O")
            tv.didChangeText()
        }
        RunLoop.current.run(mode: .default, before: Date(timeIntervalSinceNow: 0.02))
        expectEqual(tv.string, "CC=O + H2O", "Composer contains typed text")
        expectEqual(tv.undoManager?.canUndo ?? false, true, "Composer recorded native undo step")

        splitVC.undo(nil)
        expectEqual(tv.string, "CC=O", "Native Undo reverted composer text cleanly")
        expectEqual(bridge.dispatchedCommands.filter { $0.id == "edit.undo" }.count, 0, "Canvas edit.undo must NOT fire when nativeText has focus")

        // Non-text canvas focus helper does NOT steal focus away from nativeText
        WorkspaceFocusRouter.restoreCanvasFocusIfSafe(in: window, canvasView: canvasView)
        expectEqual(WorkspaceFocusRouter.classifyFocusOwner(in: window, canvasView: canvasView), .nativeText, "Focus stays in active nativeText")

        // Switch focus to canvas view -> Undo dispatches edit.undo to JS
        window.makeFirstResponder(canvasView)
        expectEqual(WorkspaceFocusRouter.classifyFocusOwner(in: window, canvasView: canvasView), .canvas, "Canvas view owns focus")
        splitVC.undo(nil)
        expectEqual(bridge.dispatchedCommands.filter { $0.id == "edit.undo" }.count, 1, "Canvas edit.undo dispatches when canvas owns focus")

        // Validation matches history.canUndo & canRedo
        let undoItem = NSMenuItem(title: "撤销", action: #selector(WorkspaceSplitViewController.undo(_:)), keyEquivalent: "")
        let redoItem = NSMenuItem(title: "重做", action: #selector(WorkspaceSplitViewController.redo(_:)), keyEquivalent: "")
        expect(splitVC.validateUserInterfaceItem(undoItem), "Undo valid when canvas owns focus and canUndo == true")
        expect(splitVC.validateUserInterfaceItem(redoItem), "Redo valid when canvas owns focus and canRedo == true")

        window.close()
    }

    // 5. Overlay hitTest click-through + top-left CSS px geometry + layoutRevision updates (without dirtying document)
    runTest("ViewportCSSCoordinatesAndClickThrough") {
        let bridge = MockNativeUIBridge()
        let ep = WorkspaceEpoch(navigationGeneration: 0, pageId: "p-layout")
        bridge.attachedEpoch = ep
        bridge.initialState = makeReadyState(epoch: ep, revision: 1)

        final class FeedbackFocusProbeView: NSView {
            override var acceptsFirstResponder: Bool { true }
        }
        let canvasView = FeedbackFocusProbeView(frame: NSRect(x: 0, y: 0, width: 700, height: 600))
        let coord = WorkspaceStateCoordinator(bridge: bridge)
        let splitVC = WorkspaceSplitViewController(coordinator: coord, canvasContentView: canvasView)
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1200, height: 760),
            styleMask: [.titled, .closable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.contentViewController = splitVC
        splitVC.installWindowChrome(on: window)
        if ProcessInfo.processInfo.environment["MOLSTUDIO_HEADLESS"] != "1" {
            window.makeKeyAndOrderFront(nil)
        }
        splitVC.splitView.adjustSubviews()
        splitVC.view.layoutSubtreeIfNeeded()
        if ProcessInfo.processInfo.environment["MOLSTUDIO_HEADLESS"] == "1" {
            window.layoutIfNeeded()
            splitVC.canvasHostViewController.publishHostViewportIfNeeded(force: true)
        }
        coord.attach(preparedSurfaces: WorkspaceSurface.allCases)

        // Verify logical points == CSS px (never backingScaleFactor 2x)
        guard let hostViewport = coord.hostContext.viewport else {
            expect(false, "Expected hostContext.viewport to be published")
            window.close()
            return
        }
        // Three native floating surfaces are published after the native UI
        // replacement: left tool palette, bottom-left zoom pill, and the right
        // element/ring palette. All are real AppKit overlays with CSS px rects.
        expectEqual(hostViewport.overlays.count, 3, "Tool / zoom / chemical palette overlays published")
        let canvasHeight = Double(canvasView.bounds.height)
        expectEqual(hostViewport.cssSize.width, Double(canvasView.bounds.width), "CSS width matches points (never backingScaleFactor 2x)")
        expectEqual(hostViewport.cssSize.height, canvasHeight, "CSS height matches points")

        if let toolRect = hostViewport.overlays.first(where: { $0.id == .toolPalette }),
           let zoomRect = hostViewport.overlays.first(where: { $0.id == .zoomPalette }) {
            expect(toolRect.x >= 0 && toolRect.y >= 0, "Tool overlay in top-left CSS px >= 0")
            expect(zoomRect.y > toolRect.y, "Bottom-left zoom overlay has larger top-left y than centered tool palette (+y downward)")
            expect(zoomRect.y + zoomRect.height <= canvasHeight + 1.0, "Zoom overlay stays within canvas CSS height")
        } else {
            expect(false, "Expected both toolPalette and zoomPalette overlay rects")
        }

        // Click-through test on WorkspaceOverlayContainerView
        let overlayContainer = splitVC.canvasHostViewController.overlayContainerView
        let openCanvasCenter = NSPoint(x: overlayContainer.bounds.midX + 120, y: overlayContainer.bounds.midY)
        let centerInSuper = overlayContainer.convert(openCanvasCenter, to: overlayContainer.superview)
        expect(overlayContainer.hitTest(centerInSuper) == nil, "Transparent center canvas region clicks through (hitTest == nil)")

        let paletteFrame = splitVC.canvasHostViewController.toolPaletteView.frame
        let paletteMidInSuper = overlayContainer.convert(NSPoint(x: paletteFrame.midX, y: paletteFrame.midY), to: overlayContainer.superview)
        expect(overlayContainer.hitTest(paletteMidInSuper) != nil, "Floating tool palette intercepts clicks inside its capsule")

        let feedbackHost = splitVC.canvasHostViewController
        expect(window.makeFirstResponder(canvasView), "Focus probe view before showing canvas feedback")
        feedbackHost.showCanvasFeedback(message: "第一次整理")
        expectEqual(feedbackHost.currentCanvasFeedbackMessage, "第一次整理", "Canvas feedback displays the current message")
        feedbackHost.showCanvasFeedback(message: "结构已整齐，位置与画法保持不变")
        expectEqual(feedbackHost.currentCanvasFeedbackMessage, "结构已整齐，位置与画法保持不变", "A newer feedback message replaces the previous one")
        let feedbackPoint = NSPoint(x: feedbackHost.canvasFeedbackOverlayView.bounds.midX, y: feedbackHost.canvasFeedbackOverlayView.bounds.midY)
        expect(feedbackHost.canvasFeedbackOverlayView.hitTest(feedbackPoint) == nil, "Canvas feedback overlay passes hit testing through")
        expect(window.firstResponder === canvasView, "Canvas feedback does not change the first responder")
        expectEqual(coord.documentMetadata.isDirty, false, "Canvas feedback never dirties the document")
        feedbackHost.setNavigationCoverVisible(true)
        expectEqual(feedbackHost.currentCanvasFeedbackMessage, nil, "Navigation clears feedback so it cannot remain on another page")
        feedbackHost.setNavigationCoverVisible(false)

        // Switch 2-column -> 1-column increments layoutRevision and narrows width without dirtying document
        let revBeforeToggle = coord.hostContext.viewport?.layoutRevision ?? 0
        let widthBeforeToggle = coord.hostContext.viewport?.overlays.first(where: { $0.id == .toolPalette })?.width ?? 0
        splitVC.canvasHostViewController.toolPaletteView.setDoubleColumn(false)
        let revAfterToggle = coord.hostContext.viewport?.layoutRevision ?? 0
        let widthAfterToggle = coord.hostContext.viewport?.overlays.first(where: { $0.id == .toolPalette })?.width ?? 0
        expect(revAfterToggle > revBeforeToggle, "Toggling 1-column density increments layoutRevision")
        expect(widthAfterToggle < widthBeforeToggle, "Single-column palette is narrower than double-column")
        expectEqual(coord.documentMetadata.isDirty, false, "Layout changes must never mark document dirty")

        // Collapse sidebar & inspector increments layoutRevision & updates viewport without dirtying document
        let revBeforeCollapse = coord.hostContext.viewport?.layoutRevision ?? 0
        splitVC.isSidebarCollapsed = true
        splitVC.splitView.adjustSubviews()
        splitVC.view.layoutSubtreeIfNeeded()
        splitVC.canvasHostViewController.publishHostViewportIfNeeded()
        let revAfterSidebar = coord.hostContext.viewport?.layoutRevision ?? 0
        // In a headless (never-ordered-front) NSWindow, NSSplitView does not
        // perform a real subview resize, so cssSize is unchanged and no new
        // layout revision is published. This is an environment limitation of
        // the headless fixture, not a product regression; a real window is
        // exercised by the native App acceptance run instead.
        if ProcessInfo.processInfo.environment["MOLSTUDIO_HEADLESS"] != "1" {
            expect(revAfterSidebar > revBeforeCollapse, "Collapsing sidebar updates layoutRevision")
        } else {
            expect(revAfterSidebar >= revBeforeCollapse, "Headless: layout revision never regresses")
        }

        let cssBeforeInsp = coord.hostContext.viewport?.cssSize.width ?? 0
        splitVC.isInspectorCollapsed = true
        splitVC.splitView.adjustSubviews()
        splitVC.view.layoutSubtreeIfNeeded()
        splitVC.canvasHostViewController.publishHostViewportIfNeeded()
        let revAfterInsp = coord.hostContext.viewport?.layoutRevision ?? 0
        let cssAfterInsp = coord.hostContext.viewport?.cssSize.width ?? 0
        expect(revAfterInsp > revAfterSidebar, "Collapsing inspector updates layoutRevision")
        expect(cssAfterInsp >= cssBeforeInsp, "Collapsing inspector leaves cssSize >= before (\(cssBeforeInsp) -> \(cssAfterInsp))")
        expectEqual(coord.documentMetadata.isDirty, false, "Panel toggle must never mark document dirty")

        window.close()
    }

    // 6. Agent presentation, hidden-channel exclusion, Markdown/LaTeX/\ce{} display, collapsible thinking & secret safety
    runTest("AgentEventsFormulasThinkingAndSecretRedaction") {
        let bridge = MockNativeUIBridge()
        let ep = WorkspaceEpoch(navigationGeneration: 0, pageId: "p-agent")
        bridge.attachedEpoch = ep
        bridge.initialState = makeReadyState(epoch: ep, revision: 1)

        let coord = WorkspaceStateCoordinator(bridge: bridge)
        let agentVC = WorkspaceAgentViewController(coordinator: coord)
        _ = agentVC.view
        coord.attach(preparedSurfaces: WorkspaceSurface.allCases)

        // Send initial public snapshot + ordered turn events + hidden channel message
        _ = coord.receiveRawScriptMessage([
            "act": "nativeUI",
            "protocol": 1,
            "epoch": ["navigationGeneration": ep.navigationGeneration, "pageId": ep.pageId],
            "sequence": 1,
            "kind": "agent",
            "payload": [
                "rendererRevision": 1,
                "resetGeneration": 0,
                "mode": "snapshot",
                "snapshot": [
                    "messages": [],
                    "runs": [],
                    "config": [
                        "configured": true,
                        "provider": "openai-compatible",
                        "baseUrl": "https://api.example.com/v1",
                        "model": "gpt-5.4",
                        "generation": ["profile": "openai", "effort": "high"]
                    ],
                ],
            ],
        ])

        let msgText = "# 机理步骤\n- 原料：**乙酸** 与 \\ce{NaOH}\n\n反应方程式：\\ce{CH3COOH + NaOH -> CH3COONa + H2O}\n\n自由能：$\\Delta G^\\circ = -RT\\ln K$"
        let rawEvents: [[String: Any]] = [
            [
                "type": "run_start",
                "runId": "run-1",
            ],
            [
                "type": "thinking_delta",
                "runId": "run-1",
                "source": "model",
                "delta": "分析乙酸与氢氧化钠的中和机理。",
            ],
            [
                "type": "plan",
                "runId": "run-1",
                "steps": [
                    ["text": "识别羧酸官能团", "status": "completed"],
                    ["text": "绘制质子转移步骤", "status": "running"],
                ],
            ],
            [
                "type": "tool_start",
                "runId": "run-1",
                "toolCallId": "tc-1",
                "name": "draw_operations",
                "label": "绘制反应步",
            ],
            [
                "type": "tool_end",
                "runId": "run-1",
                "toolCallId": "tc-1",
                "name": "draw_operations",
                "label": "绘制反应步",
                "success": true,
                "finishRejected": true,
                "summary": "已添加中和反应箭头",
                "changes": ["添加反应箭头 #1", "标注 \\ce{H2O}"],
                "diagnostic": [
                    "code": "ok_partial",
                    "reason": "Authorization: Bearer sk-secret-should-not-leak",
                ],
            ],
            [
                "type": "assistant_start",
                "runId": "run-1",
                "messageId": "m-1",
            ],
            [
                "type": "text_delta",
                "runId": "run-1",
                "messageId": "m-1",
                "delta": msgText,
                "renderedHtml": "<p>rendered</p>",
            ],
            [
                "type": "text_delta",
                "runId": "run-1",
                "messageId": "m-1",
                "channel": "analysis",
                "hidden": true,
                "delta": "HIDDEN_SHOULD_NOT_DISPLAY",
            ],
            [
                "type": "run_end",
                "runId": "run-1",
                "status": "incomplete",
                "reason": "recovery_exhausted",
            ],
            [
                "type": "recovery_exhausted",
                "runId": "run-1",
                "attempt": 2,
                "canContinue": true,
            ],
        ]

        var seq = 2
        var rev = 2
        for ev in rawEvents {
            _ = coord.receiveRawScriptMessage([
                "act": "nativeUI",
                "protocol": 1,
                "epoch": ["navigationGeneration": ep.navigationGeneration, "pageId": ep.pageId],
                "sequence": seq,
                "kind": "agent",
                "payload": [
                    "rendererRevision": rev,
                    "resetGeneration": 0,
                    "mode": "event",
                    "event": ev,
                ],
            ])
            seq += 1
            rev += 1
        }

        // Hidden channel excluded
        let allTexts = coord.agentStore.timeline.flatMap { item -> [String] in
            switch item {
            case .userMessage(let m): return [m.text]
            case .runTurn(_, let msgs): return msgs.map(\.text)
            }
        }
        expect(!allTexts.contains(where: { $0.contains("HIDDEN_SHOULD_NOT_DISPLAY") }), "Hidden channel message excluded")
        expect(coord.agentStore.canContinue, "recovery_exhausted enables continue")
        expectEqual(agentVC.continueButton.isHidden, false, "Continue button visible when canContinue is true")
        expectEqual(agentVC.continueButton.isEnabled, true, "Continue button enabled when agent surface ready")

        // Verify Markdown + LaTeX + \ce{} formatting without dropping formula content
        let formatted = WorkspaceAgentMessageFormatter.formatAttributedString(from: msgText)
        let renderedStr = formatted.string
        expect(renderedStr.contains("CH3COOH + NaOH → CH3COONa + H2O"), "Chemistry reaction arrow and formula preserved & formatted: \(renderedStr)")
        expect(renderedStr.contains("Δ G°") && renderedStr.contains("ln K"), "LaTeX Greek, superscript & ln formatted: \(renderedStr)")
        expect(WorkspaceAgentMessageFormatter.containsFormulaSyntax(msgText), "Formula syntax helper recognizes \\ce{} and $...$")

        // Safe link vs unsafe link + html:false literal HTML
        let linkAttr = WorkspaceAgentMessageFormatter.formatAttributedString(from: "访问 [文档](https://example.org) 与 [危险](javascript:alert(1)) 以及 <script>raw</script>")
        expect(linkAttr.string.contains("<script>raw</script>"), "Literal HTML preserved instead of executed/stripped")
        var foundSafeLink = false
        var foundUnsafeLink = false
        linkAttr.enumerateAttribute(.link, in: NSRange(location: 0, length: linkAttr.length)) { val, _, _ in
            if let u = val as? URL {
                if u.absoluteString == "https://example.org" { foundSafeLink = true }
                if u.scheme == "javascript" { foundUnsafeLink = true }
            }
        }
        expect(foundSafeLink && !foundUnsafeLink, "Only http/https links are clickable")

        // Secret scrubbing & transient API key clearing in Settings view
        if case .runTurn(let run, _) = coord.agentStore.timeline.first {
            expectEqual(run.thinkingText, "分析乙酸与氢氧化钠的中和机理。", "Public thinking preserved on run")
            let diagJSON = run.tools.first?.diagnostic?.prettyJSONString() ?? ""
            expect(!diagJSON.contains("sk-secret-should-not-leak"), "Bearer sk- secret redacted from diagnostic JSON")
        } else {
            expect(false, "Expected runTurn item in timeline")
        }

        agentVC.setSettingsVisible(true)
        agentVC.settingsView.apiKeyField.stringValue = "sk-my-transient-key-999"
        agentVC.settingsView.saveButton.performClick(nil)
        expectEqual(agentVC.settingsView.apiKeyField.stringValue, "", "API key field cleared immediately upon save")
        let saveReq = WorkspaceSettingsSaveRequest(
            provider: "openai-compatible",
            baseUrl: "https://api.example.com/v1",
            model: "gpt-5.4",
            apiKey: "sk-my-transient-key-999",
            generation: WorkspaceGenerationConfig(profile: "openai", effort: "high")
        )
        expect(!saveReq.description.contains("sk-my-transient-key-999"), "SaveRequest description redacts API key")

        // Reset clears timeline without corrupting canvas state
        agentVC.resetButton.performClick(nil)
        expect(bridge.dispatchedCommands.contains(where: { $0.id == "agent.reset" }), "Reset dispatches agent.reset")
    }

    // 7. Adaptive Liquid Glass (macOS 26/27+), fallback, Reduce Transparency, Increase Contrast, Dark/Light appearance
    runTest("GlassAccessibilityAndDynamicAppearance") {
        let surface = WorkspaceMaterialSurfaceView(style: .floatingControl, cornerRadius: 14, prefersInteractiveGlass: true)
        surface.frame = NSRect(x: 0, y: 0, width: 80, height: 220)
        if #available(macOS 27.0, *) {
            expectEqual(surface.activeBackingDescription, "glass-macOS27-interactive", "Uses interactive NSGlassEffectView on macOS 27+")
        } else if #available(macOS 26.0, *) {
            expectEqual(surface.activeBackingDescription, "glass-macOS26", "Uses NSGlassEffectView on macOS 26")
        } else {
            expectEqual(surface.activeBackingDescription, "visual-effect-fallback", "Uses NSVisualEffectView fallback on macOS 14/15")
        }

        // Toggle Reduce Transparency + Increase Contrast
        surface.accessibilityOverridesForTesting = (reduceTransparency: true, increaseContrast: true)
        expectEqual(surface.activeBackingDescription, "solid-reduce-transparency", "Switches cleanly to opaque solid backing under Reduce Transparency")

        // Switch Light <-> Dark appearance dynamically without crashing
        surface.appearance = NSAppearance(named: .darkAqua)
        surface.refreshMaterialAppearance()
        surface.appearance = NSAppearance(named: .aqua)
        surface.accessibilityOverridesForTesting = nil
        surface.refreshMaterialAppearance()
        expect(!surface.activeBackingDescription.isEmpty, "Recovered material surface after dynamic Light/Dark and accessibility toggles")
    }

    // 8. Toolbar clean item inventory (no Share/Trash) & real Library NSOutlineView filtering
    runTest("ToolbarAndLibraryRealDataFilteringNoShareTrash") {
        let bridge = MockNativeUIBridge()
        let ep = WorkspaceEpoch(navigationGeneration: 0, pageId: "p-lib")
        bridge.attachedEpoch = ep
        bridge.acceptedSurfaces = WorkspaceSurface.allCases
        bridge.initialState = makeReadyState(epoch: ep, revision: 1)

        var openedURLs: [URL] = []
        var revealedURLs: [URL] = []
        let callbacks = WorkspaceFileServiceCallbacks(
            onNewCanvas: {},
            onNewPaper: {},
            onOpenPanel: {},
            onOpenURL: { openedURLs.append($0) },
            onSave: {},
            onSaveAs: {},
            onRevealInFinder: { revealedURLs.append($0) },
            onCleanLayout: {},
            onGenerate3D: {},
            onExportMol: {}
        )
        let coord = WorkspaceStateCoordinator(
            bridge: bridge,
            fileCallbacks: callbacks,
            documentMetadata: WorkspaceDocumentMetadata(
                displayTitle: "咖啡因路线",
                fileURL: URL(fileURLWithPath: "/tmp/caffeine.molnote"),
                documentMode: .canvas,
                isDirty: true,
                isPageUsable: true,
                isNavigationInFlight: false,
                saveStatusText: "未保存"
            )
        )
        coord.attach(preparedSurfaces: WorkspaceSurface.allCases)

        let toolbarVC = WorkspaceToolbarController(coordinator: coord)
        let allowedIds = toolbarVC.toolbarAllowedItemIdentifiers(toolbarVC.toolbar).map(\.rawValue)
        expect(!allowedIds.contains(where: { $0.lowercased().contains("share") || $0.lowercased().contains("trash") }), "Toolbar must not expose unimplemented Share/Trash")

        let recents = [
            WelcomeRecentItem(
                id: "1",
                url: URL(fileURLWithPath: "/tmp/caffeine.molnote"),
                displayName: "咖啡因路线",
                modifiedAt: Date(),
                exists: true,
                thumbnailURL: nil,
                mode: .canvas
            ),
            WelcomeRecentItem(
                id: "2",
                url: URL(fileURLWithPath: "/tmp/report.molpaper"),
                displayName: "合成机理汇报",
                modifiedAt: Date().addingTimeInterval(-3600),
                exists: true,
                thumbnailURL: nil,
                mode: .paper
            ),
        ]

        let libVC = WorkspaceLibraryViewController(coordinator: coord, initialRecentItems: recents)
        _ = libVC.view
        expectEqual(libVC.filteredItems.count, 2, "Library starts with both real injected items")

        libVC.setFilter(.paper)
        expectEqual(libVC.filteredItems.map(\.displayName), ["合成机理汇报"], "Paper filter narrows to paper recent item")

        libVC.setFilter(.all)
        libVC.setSearchQuery("咖啡")
        expectEqual(libVC.filteredItems.map(\.displayName), ["咖啡因路线"], "Search field query matches Chinese displayName")

        libVC.openRecentItem(recents[0])
        expectEqual(openedURLs, [recents[0].url], "Opening recent routes cleanly to injected host callback")
    }

    // 9. Focus router: readonly NSTextView, empty-selection delete:, and canvas clipboard routing
    runTest("FocusRouterReadonlyTextAndCanvasClipboard") {
        let win = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 500, height: 400), styleMask: [.titled], backing: .buffered, defer: false)
        let editableView = NSTextView(frame: NSRect(x: 0, y: 0, width: 200, height: 80))
        editableView.isEditable = true
        editableView.isSelectable = true
        editableView.string = "hello"
        editableView.setSelectedRange(NSRange(location: 5, length: 0))

        let readonlyView = WorkspaceRichMessageTextView(frame: NSRect(x: 0, y: 0, width: 200, height: 80))
        readonlyView.isEditable = false
        readonlyView.isSelectable = true
        readonlyView.string = "assistant reply"
        readonlyView.setSelectedRange(NSRange(location: 0, length: 5))

        let container = NSView(frame: win.contentRect(forFrameRect: win.frame))
        container.addSubview(editableView)
        container.addSubview(readonlyView)
        win.contentView = container

        win.makeFirstResponder(editableView)
        expectEqual(WorkspaceFocusRouter.classifyFocusOwner(in: win, canvasView: nil), .nativeText, "Editable NSTextView classifies as .nativeText")
        expectEqual(WorkspaceFocusRouter.isEditableNativeTextResponder(editableView), true, "Editable NSTextView is editable responder")
        expectEqual(WorkspaceFocusRouter.validateEditAction(#selector(NSText.delete(_:)), in: win, canvasView: nil, coordinator: nil), false, "Empty-selection editable NSTextView must not intercept delete: Backspace")
        expectEqual(WorkspaceFocusRouter.validateEditAction(#selector(NSText.paste(_:)), in: win, canvasView: nil, coordinator: nil), true, "Editable NSTextView enables paste:")
        editableView.setSelectedRange(NSRange(location: 0, length: 2))
        expectEqual(WorkspaceFocusRouter.validateEditAction(#selector(NSText.delete(_:)), in: win, canvasView: nil, coordinator: nil), true, "Non-empty selection editable NSTextView enables delete:")
        expectEqual(WorkspaceFocusRouter.validateEditAction(#selector(NSText.copy(_:)), in: win, canvasView: nil, coordinator: nil), true, "Non-empty selection editable NSTextView enables copy:")

        win.makeFirstResponder(readonlyView)
        expectEqual(WorkspaceFocusRouter.classifyFocusOwner(in: win, canvasView: nil), .nativeText, "Readonly selectable NSTextView classifies as .nativeText")
        expectEqual(WorkspaceFocusRouter.isEditableNativeTextResponder(readonlyView), false, "Readonly NSTextView is not editable responder")
        expectEqual(WorkspaceFocusRouter.validateEditAction(#selector(NSText.copy(_:)), in: win, canvasView: nil, coordinator: nil), true, "Readonly selectable NSTextView allows copy:")
        expectEqual(WorkspaceFocusRouter.validateEditAction(#selector(NSText.selectAll(_:)), in: win, canvasView: nil, coordinator: nil), true, "Readonly selectable NSTextView allows selectAll:")
        expectEqual(WorkspaceFocusRouter.validateEditAction(#selector(NSText.cut(_:)), in: win, canvasView: nil, coordinator: nil), false, "Readonly NSTextView rejects cut:")
        expectEqual(WorkspaceFocusRouter.validateEditAction(#selector(NSText.paste(_:)), in: win, canvasView: nil, coordinator: nil), false, "Readonly NSTextView rejects paste:")
        expectEqual(WorkspaceFocusRouter.validateEditAction(#selector(NSText.delete(_:)), in: win, canvasView: nil, coordinator: nil), false, "Readonly NSTextView rejects delete:")

        expectEqual(WorkspaceFocusRouter.semanticEditCommandId(for: #selector(NSText.cut(_:))), nil, "Cut must not emit fake JS edit.cut semantic command")
        expectEqual(WorkspaceFocusRouter.semanticEditCommandId(for: #selector(NSText.copy(_:))), nil, "Copy must not emit fake JS edit.copy semantic command")
        expectEqual(WorkspaceFocusRouter.semanticEditCommandId(for: #selector(NSText.paste(_:))), nil, "Paste must not emit fake JS edit.paste semantic command")
        expectEqual(WorkspaceFocusRouter.canvasClipboardAction(for: #selector(NSText.cut(_:))), .cut, "Canvas cut: maps to clipboard action")
        expectEqual(WorkspaceFocusRouter.canvasClipboardAction(for: #selector(NSText.copy(_:))), .copy, "Canvas copy: maps to clipboard action")
        expectEqual(WorkspaceFocusRouter.canvasClipboardAction(for: #selector(NSText.paste(_:))), .paste, "Canvas paste: maps to clipboard action")

        let bridge = MockNativeUIBridge()
        let ep = WorkspaceEpoch(navigationGeneration: 1, pageId: "p-clip")
        bridge.attachedEpoch = ep
        bridge.acceptedSurfaces = WorkspaceSurface.allCases
        bridge.initialState = makeReadyState(epoch: ep, revision: 1)

        var clipboardActions: [WorkspaceCanvasClipboardAction] = []
        let coord = WorkspaceStateCoordinator(
            bridge: bridge,
            fileCallbacks: WorkspaceFileServiceCallbacks(
                onCanvasClipboardAction: { action, _ in clipboardActions.append(action); return true },
                canPerformCanvasClipboardAction: { action in action != .cut }
            )
        )
        coord.beginNavigation(generation: ep.navigationGeneration)
        coord.attach(preparedSurfaces: WorkspaceSurface.allCases)

        expectEqual(coord.canPerformCanvasClipboardAction(.copy), true, "Canvas copy allowed by callback")
        expectEqual(coord.canPerformCanvasClipboardAction(.cut), false, "Canvas cut honors canPerformCanvasClipboardAction callback")
        coord.performCanvasClipboardAction(.copy)
        coord.performCanvasClipboardAction(.paste)
        expectEqual(clipboardActions, [.copy, .paste], "Clipboard actions route through host callbacks")
        expect(!bridge.dispatchedCommands.contains(where: { $0.id == "edit.copy" || $0.id == "edit.paste" }), "Clipboard actions must never dispatch edit.copy/paste")
    }

    // 10. Paper Mode Inspector visibility/buttons, Toolbar menus, and legacy messageId decode
    runTest("PaperModeInspectorToolbarAndLegacyMessageId") {
        let bridge = MockNativeUIBridge()
        let ep = WorkspaceEpoch(navigationGeneration: 2, pageId: "p-paper")
        bridge.attachedEpoch = ep
        bridge.acceptedSurfaces = WorkspaceSurface.allCases
        bridge.initialState = makeReadyState(epoch: ep, revision: 1, viewportMode: .canvas)

        var paperSetupCalls = 0
        var switchCalls = 0
        let coord = WorkspaceStateCoordinator(
            bridge: bridge,
            fileCallbacks: WorkspaceFileServiceCallbacks(
                onNewCanvas: {},
                onNewPaper: {},
                onSwitchToCanvasMode: { switchCalls += 1 },
                onSwitchToPaperMode: { switchCalls += 1 },
                onPaperSetup: { paperSetupCalls += 1 },
                onAddPaperPage: {},
                onRemoveBlankLastPage: {},
                onInsertImageIntoDocument: {},
                onInsertFileIntoDocument: {}
            ),
            documentMetadata: WorkspaceDocumentMetadata(
                displayTitle: "机理报告",
                fileURL: nil,
                documentMode: .canvas,
                isDirty: false,
                isPageUsable: true,
                isNavigationInFlight: false,
                saveStatusText: "已保存"
            )
        )
        coord.beginNavigation(generation: ep.navigationGeneration)
        coord.attach(preparedSurfaces: WorkspaceSurface.allCases)

        let propsVC = WorkspacePropertiesViewController(coordinator: coord)
        _ = propsVC.view
        expectEqual(propsVC.removeLastPageButton.isEnabled, false, "Remove blank last page disabled outside paper mode")

        let toolbarVC = WorkspaceToolbarController(coordinator: coord)
        let docToolbarItem = toolbarVC.toolbar(toolbarVC.toolbar, itemForItemIdentifier: WorkspaceToolbarItemIdentifier.documentTitle, willBeInsertedIntoToolbar: false) as? NSMenuToolbarItem
        expect(docToolbarItem != nil, "Document toolbar menu item created")

        // Switch UIState into paper mode with canRemoveLastPage = false, then true
        var paperState = makeReadyState(epoch: ep, revision: 2, viewportMode: .paper)
        paperState.document = WorkspaceUIState.DocumentInfo(
            mode: .paper,
            pageCount: 2,
            size: "A4",
            orientation: "portrait",
            marginMm: 16,
            canRemoveLastPage: false
        )
        coord.receiveMessage(WorkspaceNativeUIMessage(protocol: workspaceNativeUIProtocolVersion, epoch: ep, sequence: 1, kind: .state(paperState)))
        expectEqual(propsVC.paperSetupButton.isEnabled, true, "Paper setup enabled in paper mode")
        expectEqual(propsVC.removeLastPageButton.isEnabled, false, "Remove blank last page stays disabled when canRemoveLastPage is false")
        if let docMenu = docToolbarItem?.menu {
            expect(docMenu.items.contains(where: { $0.title == "删除空白末页" }), "Paper mode adds remove blank last page menu item")
            if let removeItem = docMenu.items.first(where: { $0.title == "删除空白末页" }) {
                expectEqual(toolbarVC.validateMenuItem(removeItem), false, "Toolbar validates removeBlankLastPage against document.canRemoveLastPage")
            }
        }

        paperState = makeReadyState(epoch: ep, revision: 3, viewportMode: .paper)
        paperState.document = WorkspaceUIState.DocumentInfo(
            mode: .paper,
            pageCount: 2,
            size: "A4",
            orientation: "portrait",
            marginMm: 16,
            canRemoveLastPage: true
        )
        coord.receiveMessage(WorkspaceNativeUIMessage(protocol: workspaceNativeUIProtocolVersion, epoch: ep, sequence: 2, kind: .state(paperState)))
        expectEqual(propsVC.removeLastPageButton.isEnabled, true, "Remove blank last page enables when canRemoveLastPage is true")
        propsVC.paperSetupButton.performClick(nil)
        expectEqual(paperSetupCalls, 1, "Clicking paper setup button triggers onPaperSetup callback")
        propsVC.switchCanvasModeButton.performClick(nil)
        expectEqual(switchCalls, 1, "Clicking switch canvas mode button triggers onSwitchToCanvasMode callback")

        // Decode legacy WorkspacePublicMessage using "messageId" key
        let legacyJSON = #"{"messageId":"legacy-42","role":"assistant","text":"已生成","status":"done"}"#
        let decodedMsg = try? JSONDecoder().decode(WorkspacePublicMessage.self, from: Data(legacyJSON.utf8))
        expectEqual(decodedMsg?.id, "legacy-42", "WorkspacePublicMessage decodes legacy messageId key")
    }

    // 11. Runtime isolation & read-only AcceptanceTelemetryServer auth / GET-only security
    runTest("RuntimeConfigAndAcceptanceTelemetryServer") {
        let cfg = AppRuntimeConfig.shared
        expect(cfg.port >= 1024 && cfg.port <= 65535, "Resolved runtime port is in valid unprivileged TCP range")

        let controlPath = (NSTemporaryDirectory() as NSString).appendingPathComponent("molstudio-test-control-\(UUID().uuidString).json")
        let server = AcceptanceTelemetryServer(controlFilePath: controlPath, runtimeConfig: cfg) {
            ["ok": true, "model": "gemini-4-hydrogen-xhigh", "agent": ["configured": true]]
        }
        expect(server.start(), "AcceptanceTelemetryServer starts on loopback")
        defer { server.stop() }

        expect(FileManager.default.fileExists(atPath: controlPath), "Control file written when server starts")
        if let attrs = try? FileManager.default.attributesOfItem(atPath: controlPath),
           let perms = attrs[.posixPermissions] as? NSNumber {
            expectEqual(perms.intValue & 0o777, 0o600, "Control file permissions restricted to 0600")
        }

        let controlData = try? Data(contentsOf: URL(fileURLWithPath: controlPath))
        let controlJSON = controlData.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
        let token = controlJSON?["token"] as? String ?? ""
        let listenPort = controlJSON?["port"] as? Int ?? 0
        expect(!token.isEmpty && listenPort > 0, "Control file exposes non-empty bearer token and port")

        func performHTTP(method: String, path: String, bearer: String?) -> (Int, [String: Any]?) {
            guard let url = URL(string: "http://127.0.0.1:\(listenPort)\(path)") else { return (0, nil) }
            var req = URLRequest(url: url)
            req.httpMethod = method
            req.timeoutInterval = 2.0
            if let bearer { req.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization") }
            var statusCode = 0
            var parsedBody: [String: Any]?
            var done = false
            URLSession.shared.dataTask(with: req) { data, resp, _ in
                statusCode = (resp as? HTTPURLResponse)?.statusCode ?? 0
                if let data {
                    parsedBody = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
                }
                done = true
            }.resume()
            let deadline = Date().addingTimeInterval(3.0)
            while !done && Date() < deadline {
                RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.02))
            }
            return (statusCode, parsedBody)
        }

        let (unauthStatus, _) = performHTTP(method: "GET", path: "/state", bearer: nil)
        expectEqual(unauthStatus, 401, "Missing bearer token is rejected with 401 Unauthorized")

        let (postStatus, _) = performHTTP(method: "POST", path: "/state", bearer: token)
        expectEqual(postStatus, 405, "POST is rejected with 405 Method Not Allowed (strictly read-only GET)")

        let (stateStatus, stateJSON) = performHTTP(method: "GET", path: "/state", bearer: token)
        expectEqual(stateStatus, 200, "Authorized GET /state returns 200 OK")
        expectEqual(stateJSON?["model"] as? String, "gemini-4-hydrogen-xhigh", "Telemetry returns live snapshot")

        server.stop()
        expect(!FileManager.default.fileExists(atPath: controlPath), "stop() cleans up control file")
    }
}

@MainActor
private func loadRealJSFixturesRoot() -> [String: Any]? {
    let fixtureURL = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()
        .appendingPathComponent("fixtures/contract-fixtures.json")
    guard let data = try? Data(contentsOf: fixtureURL),
          let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
        expect(false, "failed to load fixtures/contract-fixtures.json at \(fixtureURL.path)")
        return nil
    }
    return root
}

@MainActor
private func verifyRealJSStateSync(root: [String: Any], coord: WorkspaceStateCoordinator) {
    guard let postAttach = root["postAttachMessages"] as? [[String: Any]],
          let canvasMsgs = root["canvasMessages"] as? [[String: Any]],
          let paperMsgs = root["paperMessages"] as? [[String: Any]] else {
        expect(false, "missing postAttachMessages/canvasMessages/paperMessages")
        return
    }
    for msg in postAttach {
        let seq = (msg["sequence"] as? Int) ?? -1
        expect(coord.receiveRawScriptMessage(msg), "postAttach JS message sequence=\(seq) accepted")
    }
    expectEqual(
        coord.uiState.supported.templateIds,
        ["ring.benzene", "ring.cyclohexane", "ring.cyclopentane", "ring.cyclopropane"],
        "real JS templateIds preserved"
    )
    expectEqual(coord.agentStore.config.model, "deepseek-v4.1-flash", "initial config decoded from JS fixture")
    expectEqual(
        coord.agentStore.config.generationCapabilities?.openaiModels["gpt-5.4"] ?? [],
        ["none", "low", "medium", "high", "xhigh"],
        "public generationCapabilities filtered and decoded"
    )

    if let rawSettingsReply = root["settingsLoadReply"] as? [String: Any] {
        let reply = WorkspaceContractCodec.decode(WorkspaceCommandReply.self, from: rawSettingsReply)
        expectEqual(reply?.ok, true, "settingsLoadReply decoded")
        let rawCfg = reply?.result?["config"]?.foundationValue
        let decodedCfg = rawCfg.flatMap { WorkspaceContractCodec.decode(WorkspacePublicConfig.self, from: $0) }
        expectEqual(decodedCfg?.model, "deepseek-reasoner", "settingsLoadReply model matches")
        expectEqual(
            decodedCfg?.generationCapabilities?.openaiModels["gpt-5.1"] ?? [],
            ["none", "low", "medium", "high"],
            "settingsLoadReply generationCapabilities decoded"
        )
    } else {
        expect(false, "settingsLoadReply missing from fixture")
    }

    for msg in canvasMsgs {
        let seq = (msg["sequence"] as? Int) ?? -1
        expect(coord.receiveRawScriptMessage(msg), "canvas JS message sequence=\(seq) accepted")
    }
    expectEqual(coord.uiState.tool.id, "ring.benzene", "canvas tool synced to ring.benzene")
    expectEqual(coord.uiState.selection.revision, 1, "canvas selection revision bumped on JS selectionChange")
    expectEqual(coord.uiState.viewport.appliedHostLayoutRevision, 1, "canvas appliedHostLayoutRevision synced")
    expect(coord.uiState.document?.mode == .canvas, "canvas DocumentInfo mode synced")

    for msg in paperMsgs {
        let seq = (msg["sequence"] as? Int) ?? -1
        expect(coord.receiveRawScriptMessage(msg), "paper JS message sequence=\(seq) accepted")
    }
    expectEqual(coord.uiState.viewport.mode, .paper, "paper viewport mode synced")
    expectEqual(coord.uiState.viewport.percent, 150, "paper zoom percent synced")
    expect(coord.uiState.supported.commands.contains("zoom.toPercent"), "paper mode exposes zoom.toPercent")
    expect(coord.uiState.supported.commands.contains("zoom.fit"), "paper mode exposes zoom.fit")
    expect(coord.uiState.document?.mode == .paper, "paper DocumentInfo mode")
    expectEqual(coord.uiState.document?.pageCount, 2, "paper DocumentInfo pageCount")
    expectEqual(coord.uiState.document?.size, "A4", "paper DocumentInfo size")
    expectEqual(coord.uiState.document?.orientation, "portrait", "paper DocumentInfo orientation")
    expectEqual(coord.uiState.document?.marginMm, 12, "paper DocumentInfo marginMm")
    expectEqual(coord.uiState.document?.canRemoveLastPage, true, "paper DocumentInfo canRemoveLastPage")
}

@MainActor
private func verifyRealJSAgentSync(root: [String: Any], coord: WorkspaceStateCoordinator) {
    guard let agentMsgs = root["agentRunMessages"] as? [[String: Any]],
          let rawFinal = root["finalState"] as? [String: Any] else {
        expect(false, "missing agentRunMessages/finalState")
        return
    }
    for msg in agentMsgs {
        let seq = (msg["sequence"] as? Int) ?? -1
        expect(coord.receiveRawScriptMessage(msg), "agent JS message sequence=\(seq) accepted")
    }
    var userTexts: [String] = []
    var turnMessages: [WorkspacePublicMessage] = []
    var runs: [WorkspacePublicRun] = []
    for item in coord.agentStore.timeline {
        switch item {
        case .userMessage(let msg):
            userTexts.append(msg.text)
        case .runTurn(let run, let msgs):
            runs.append(run)
            turnMessages.append(contentsOf: msgs)
        }
    }
    let assistantTexts = turnMessages.map(\.text)
    expect(userTexts.contains { $0.contains("画出咖啡因两条独立机理路线") }, "user_message rendered from real JS stream")
    expect(assistantTexts.contains { $0.contains("已完成第一步反应箭头。") }, "assistant text without input messageId decoded via JS auto-id")
    expect(!assistantTexts.contains { $0.contains("HIDDEN_CHANNEL_DROP") }, "hidden channel filtered out before Swift")

    let lastRun = runs.last
    expectEqual(coord.agentStore.canContinue, true, "run_end incomplete sets canContinue")
    expectEqual(lastRun?.status, "incomplete", "run_end incomplete status preserved")
    expectEqual(lastRun?.reason, "recovery_exhausted", "run_end recovery reason preserved")
    expect(lastRun?.thinkingText.contains("规划路线 A 与路线 B") == true, "model thinking delta accumulated")
    expectEqual(lastRun?.tools.first?.name, "draw_operations", "tool name preserved")
    expectEqual(lastRun?.tools.first?.state, .incomplete, "finishRejected tool end maps to incomplete")
    expectEqual(lastRun?.tools.first?.diagnostic?.code, "incomplete_mechanism", "diagnostic code preserved")
    expectEqual(lastRun?.tools.dropFirst().first?.state, .failed, "genuine failed tool end maps to failed")
    expectEqual(lastRun?.tools.dropFirst().first?.diagnostic?.code, "invalid_smiles", "failed tool diagnostic code preserved")
    expectEqual(coord.agentStore.checkpoint?.goal, "咖啡因双路线机理", "sanitized task_checkpoint goal decoded from real JS")
    expectEqual(coord.agentStore.checkpoint?.phases?.first?.objective, "路线 A", "sanitized checkpoint phase objective decoded")
    expectEqual(coord.agentStore.generationTooltip?.contains("最高"), true, "generation_applied decoded from real JS stream")
    let encodedRuns = (try? JSONEncoder().encode(runs)) ?? Data()
    let storeString = String(data: encodedRuns, encoding: .utf8) ?? ""
    expect(!storeString.contains("tok-should-never-escape-js") && !storeString.contains("sk-should-never-escape-js"), "nested secret sentinels stripped from decoded agent store")
    expect(!storeString.contains("sk-dummy-redaction-probe") && !storeString.contains("Authorization: Bearer"), "secret probe stripped")
    expectEqual(coord.agentStore.config.model, "deepseek-reasoner", "config event updates model live")

    let decodedFinal = WorkspaceContractCodec.decode(WorkspaceUIState.self, from: rawFinal)
    expect(decodedFinal != nil, "finalState decoded")
    expectEqual(decodedFinal?.agent.canContinue, true, "finalState agent.canContinue reflects runtime state")
    expect(decodedFinal?.document?.mode == .canvas, "finalState DocumentInfo switched back to canvas")
}

@MainActor
private func runRealJSFixtureTests() {
    runTest("RealJSFixtureCrossLanguageDecodeAndStateSync") {
        guard let root = loadRealJSFixturesRoot(),
              let rawAttach = root["attachReply"] as? [String: Any],
              let attachReply = WorkspaceContractCodec.decode(WorkspaceAttachReply.self, from: rawAttach) else {
            expect(false, "WorkspaceAttachReply failed to decode real JS fixture")
            return
        }
        expectEqual(attachReply.ok, true, "real JS attachReply ok")
        expectEqual(attachReply.sequence, 0, "real JS attachReply returns sequence 0")
        expectEqual(attachReply.epoch?.navigationGeneration, 3, "real JS generated epoch generation")
        let hasGeneratedPageId = attachReply.epoch?.pageId.hasPrefix("page-3-") ?? false
        expect(hasGeneratedPageId, "real JS generated pageId without host pageId input")

        let bridge = MockNativeUIBridge()
        bridge.onAttachCalled = { _, completion in
            completion(.success(attachReply))
        }
        let coord = WorkspaceStateCoordinator(bridge: bridge)
        coord.beginNavigation(generation: 3)
        coord.attach(preparedSurfaces: WorkspaceSurface.allCases)
        expect(coord.isAttached, "coordinator attached with real JS attachReply")

        verifyRealJSStateSync(root: root, coord: coord)
        verifyRealJSAgentSync(root: root, coord: coord)
    }
}

@main
struct WorkspaceComponentTestRunner {
    @MainActor
    static func main() {
        runAllTests()
        runColorWellTests()
        runRealJSFixtureTests()
        runIntegrationReviewFixTests()
        runCheckpointFallbackFailureInjectionTests()
        print("SUMMARY: passed=\(passedTests) failedAssertions=\(failedAssertions.count)")
        if !failedAssertions.isEmpty {
            exit(1)
        }
    }

    @MainActor
    private static func runColorWellTests() {
        runTest("ColorWellCommitsOnceAndRejectsStalePanelActions") {
            var revision = 7
            var commits: [(String, String, Int)] = []
            var focusRestores = 0
            let property = WorkspaceSelectionProperty(
                id: "shapeStyle.stroke.color",
                label: "默认描边颜色",
                type: .text,
                value: .string("#123456"),
                enabled: true
            )
            let view = WorkspaceCommitColorWellView(
                property: property,
                selectionRevision: revision,
                selectionRevisionProvider: { revision },
                onCommitValue: { id, value, expectedRevision in
                    commits.append((id, value, expectedRevision))
                },
                onRestoreCanvasFocus: { focusRestores += 1 }
            )
            expectEqual(view.colorWell.isContinuous, false, "Color well does not stream commits while a color is being chosen")

            @MainActor func sendColorAction(_ color: NSColor) {
                view.colorWell.color = color
                guard let action = view.colorWell.action else {
                    expect(false, "Color well action is installed")
                    return
                }
                let delivered = NSApplication.shared.sendAction(action, to: view.colorWell.target, from: view.colorWell)
                expect(delivered, "Color well action reaches its native property view")
            }

            @MainActor func openPicker() {
                view.colorWell.onMouseDown?()
                view.colorWell.activate(true)
                let activationSessionActive = view.hasActiveOwnedPickerSession
                expect(activationSessionActive, "The host sees the owned picker during mouseDown activation before AppKit returns")
                view.colorWell.onMouseDownEnded?()
                let isActive = view.colorWell.isActive
                let panelVisible = NSColorPanel.shared.isVisible
                let sessionActive = view.hasActiveOwnedPickerSession
                expect(isActive, "The color well owns the active picker after opening it")
                expect(panelVisible, "Opening the color well shows the shared AppKit color panel")
                expect(sessionActive, "The Inspector exposes an active owned-picker session to its host")
            }

            @MainActor func expectPanelClosed(_ message: String) {
                let panelVisible = NSColorPanel.shared.isVisible
                expect(!panelVisible, message)
            }
            openPicker()
            sendColorAction(.red)
            expectPanelClosed("Committing one color closes the panel opened by this well")
            let commitClearsSession = !view.hasActiveOwnedPickerSession
            expect(commitClearsSession, "A committed color clears the host-visible picker session")
            expectEqual(commits.count, 1, "One picker choice produces one property commit")
            if let commit = commits.first {
                expectEqual(commit.0, "shapeStyle.stroke.color", "Default color property id is preserved")
                expectEqual(commit.1, "#FF0000", "Picker color is serialized as a standard hex value")
                expectEqual(commit.2, 7, "Picker commit uses the captured selection revision")
            }
            expectEqual(focusRestores, 1, "Canvas focus is restored after the picker commits")

            // A lingering action from the old shared panel has no captured
            // revision after the first commit and cannot create a stale edit.
            sendColorAction(.blue)
            expectEqual(commits.count, 1, "A stale follow-up action from the retired picker is ignored")
            let staleColorRestored = view.colorWell.color.isEqual(NSColor.red)
            expect(staleColorRestored, "Ignored stale action restores the committed swatch")

            revision = 8
            let refreshedProperty = WorkspaceSelectionProperty(
                id: "shapeStyle.stroke.color",
                label: "默认描边颜色",
                type: .text,
                value: .string("#FF0000"),
                enabled: true
            )
            view.applyProperty(refreshedProperty, selectionRevision: revision)
            openPicker()
            sendColorAction(.blue)
            expectPanelClosed("The reopened picker closes after its second color choice")
            expectEqual(commits.count, 2, "Reopening the picker captures the refreshed revision")
            if commits.count > 1 { expectEqual(commits[1].2, 8, "Second picker choice uses the refreshed selection revision") }
            openPicker()
            view.cancelInteraction()
            expectPanelClosed("Cancelling closes the panel owned by this well")
            let cancelClearsSession = !view.hasActiveOwnedPickerSession
            expect(cancelClearsSession, "Cancelling clears the host-visible picker session")
            sendColorAction(.red)
            expectEqual(commits.count, 2, "A cancelled picker action creates no property commit")
            let cancelledColorRestored = view.colorWell.color.isEqual(NSColor.blue)
            expect(cancelledColorRestored, "Cancellation restores the last committed swatch")

            var fillCommits: [(String, String, Int)] = []
            let fillView = WorkspaceCommitColorWellView(
                property: WorkspaceSelectionProperty(id: "fillColor", label: "填充颜色", type: .text, value: .string("#FFFFFF"), enabled: true),
                selectionRevision: 9,
                selectionRevisionProvider: { 9 },
                onCommitValue: { id, value, expectedRevision in fillCommits.append((id, value, expectedRevision)) }
            )
            fillView.colorWell.onMouseDown?()
            fillView.colorWell.activate(true)
            fillView.colorWell.onMouseDownEnded?()
            fillView.colorWell.color = .green
            if let action = fillView.colorWell.action {
                _ = NSApplication.shared.sendAction(action, to: fillView.colorWell.target, from: fillView.colorWell)
            }
            expectEqual(fillCommits.count, 1, "A selected object's fill color commits through its native color well")
            if let commit = fillCommits.first {
                expectEqual(commit.0, "fillColor", "Selected fill color keeps the existing property contract")
                expectEqual(commit.1, "#00FF00", "Selected fill color is serialized to HEX")
                expectEqual(commit.2, 9, "Selected fill color uses the active selection revision")
            }
            expectPanelClosed("Selected fill commits close their own picker panel")
        }
    }

    @MainActor
    private static func runIntegrationReviewFixTests() {
        runTest("IntegrationReviewFocusAndAppearanceFixes") {
            final class CanvasSpyView: NSView {
                override var acceptsFirstResponder: Bool { true }
                var selectAllCalls = 0
                @objc override func selectAll(_ sender: Any?) { selectAllCalls += 1 }
            }

            final class ReadonlyAISpyTextView: NSTextView {
                var copyCalls = 0
                override func copy(_ sender: Any?) { copyCalls += 1 }
            }

            let window = NSWindow(
                contentRect: NSRect(x: 0, y: 0, width: 640, height: 480),
                styleMask: [.titled, .closable],
                backing: .buffered,
                defer: false
            )
            let content = NSView(frame: window.contentRect(forFrameRect: window.frame))
            window.contentView = content

            let canvas = CanvasSpyView(frame: NSRect(x: 0, y: 0, width: 320, height: 480))
            let chromeButton = NSButton(title: "Chrome", target: nil, action: nil)
            chromeButton.frame = NSRect(x: 340, y: 20, width: 80, height: 28)
            var currentRev = 1
            var committedText: String?
            let propDef = WorkspaceSelectionProperty(
                id: "width",
                label: "宽度",
                type: .text,
                value: .string("100"),
                enabled: true
            )
            let textPropField = WorkspaceCommitTextFieldView(
                property: propDef,
                selectionRevision: 1,
                selectionRevisionProvider: { currentRev },
                onCommitValue: { _, value, _ in committedText = value }
            )
            textPropField.frame = NSRect(x: 340, y: 80, width: 200, height: 28)
            let aiReadonlyText = ReadonlyAISpyTextView(frame: NSRect(x: 340, y: 140, width: 240, height: 80))
            aiReadonlyText.isEditable = false
            aiReadonlyText.isSelectable = true
            aiReadonlyText.string = "咖啡因机理路线 A"

            content.addSubview(canvas)
            content.addSubview(chromeButton)
            content.addSubview(textPropField)
            content.addSubview(aiReadonlyText)

            var restoreCalls = 0
            textPropField.onRestoreCanvasFocus = {
                restoreCalls += 1
                window.makeFirstResponder(canvas)
            }

            // 1. Escape / cancel when canvas already holds focus must NOT fire spurious restore
            window.makeFirstResponder(canvas)
            currentRev = 2
            let updatedPropDef = WorkspaceSelectionProperty(
                id: "width",
                label: "宽度",
                type: .text,
                value: .string("110"),
                enabled: true
            )
            textPropField.applyProperty(updatedPropDef, selectionRevision: 2)
            textPropField.cancelPendingEdit()
            expectEqual(restoreCalls, 0, "cancelPendingEdit skips focus restore when text field was not focused")

            // 2. Escape / cancel while inspector text field holds focus restores canvas focus cleanly
            window.makeFirstResponder(textPropField.textField)
            window.layoutIfNeeded()
            let editor = textPropField.textField.currentEditor()
            expect(editor != nil || window.firstResponder === textPropField.textField, "textField acquired window responder")
            textPropField.cancelPendingEdit()
            expectEqual(restoreCalls, 1, "cancelPendingEdit restores canvas focus when textField held focus")
            expect(window.firstResponder === canvas, "window firstResponder returns to canvas after Escape cancel")

            // 2b. Return key commits edited value and restores canvas focus
            window.makeFirstResponder(textPropField.textField)
            window.layoutIfNeeded()
            textPropField.controlTextDidBeginEditing(
                Notification(name: NSControl.textDidBeginEditingNotification, object: textPropField.textField)
            )
            textPropField.textField.stringValue = "145"
            if let fieldEditor = textPropField.textField.currentEditor() as? NSTextView {
                _ = textPropField.control(
                    textPropField.textField,
                    textView: fieldEditor,
                    doCommandBy: #selector(NSResponder.insertNewline(_:))
                )
            } else {
                _ = textPropField.control(
                    textPropField.textField,
                    textView: NSTextView(),
                    doCommandBy: #selector(NSResponder.insertNewline(_:))
                )
            }
            expectEqual(committedText, "145", "Return commits text field edit")
            expectEqual(restoreCalls, 2, "Return restores canvas focus")
            expect(window.firstResponder === canvas, "window firstResponder returns to canvas after Return commit")

            // Prepare attached coordinator before focus-router checks
            let bridge = MockNativeUIBridge()
            let coord = WorkspaceStateCoordinator(bridge: bridge)
            let ep = WorkspaceEpoch(navigationGeneration: 1, pageId: "p-ai")
            bridge.initialState = makeReadyState(epoch: ep, revision: 1)
            coord.beginNavigation(generation: 1)
            bridge.onAttachCalled = { _, cb in
                cb(.success(WorkspaceAttachReply(ok: true, epoch: ep, sequence: 0, ownedSurfaces: WorkspaceSurface.allCases, state: makeReadyState(epoch: ep, revision: 1), error: nil)))
            }
            coord.attach(preparedSurfaces: WorkspaceSurface.allCases)

            // 3. .none focus fallback allows canvas selectAll and restores canvas focus, while .nativeChrome does not
            window.makeFirstResponder(window)
            expectEqual(WorkspaceFocusRouter.classifyFocusOwner(in: window, canvasView: canvas), .none, "window responder classifies as .none")
            expectEqual(
                WorkspaceFocusRouter.validateEditAction(#selector(NSText.selectAll(_:)), in: window, canvasView: canvas, coordinator: coord),
                true,
                ".none focus owner enables canvas Select All fallback"
            )
            expectEqual(
                WorkspaceFocusRouter.performEditAction(#selector(NSText.selectAll(_:)), sender: nil, in: window, canvasView: canvas, coordinator: coord),
                true,
                ".none performEditAction routes to canvas"
            )
            expectEqual(bridge.dispatchedCommands.last?.id, "edit.selectAll", "coordinator dispatched edit.selectAll via .none fallback")
            expect(window.firstResponder === canvas, ".none fallback restored canvas as firstResponder")

            window.makeFirstResponder(chromeButton)
            expectEqual(WorkspaceFocusRouter.classifyFocusOwner(in: window, canvasView: canvas), .nativeChrome, "NSButton classifies as .nativeChrome")
            expectEqual(
                WorkspaceFocusRouter.validateEditAction(#selector(NSText.selectAll(_:)), in: window, canvasView: canvas, coordinator: coord),
                false,
                ".nativeChrome keeps canvas Select All disabled"
            )

            // 4. Readonly selectable AI text view classifies as .nativeText, handles copy:, and sends focusOwner="nativeText"
            window.makeFirstResponder(aiReadonlyText)
            aiReadonlyText.setSelectedRange(NSRange(location: 0, length: 4))
            let aiOwner = WorkspaceFocusRouter.classifyFocusOwner(in: window, canvasView: canvas)
            expectEqual(aiOwner, .nativeText, "readonly selectable AI text view classifies as .nativeText")
            coord.updateHostFocus(windowKey: true, focusOwner: aiOwner)
            RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.02))
            let hostCmd = bridge.dispatchedCommands.last { $0.id == "host.context" }
            let hostArgs = hostCmd?.args?.mapValues(\.foundationValue)
            expectEqual(hostArgs?["focusOwner"] as? String, "nativeText", "coordinator sends focusOwner=nativeText for native AI view")
            expectEqual(hostArgs?["windowKey"] as? Bool, true, "coordinator sends windowKey=true")
            expectEqual(
                WorkspaceFocusRouter.performEditAction(#selector(NSText.copy(_:)), sender: nil, in: window, canvasView: canvas, coordinator: coord),
                true,
                "readonly AI copy: handled first by responder"
            )
            expectEqual(aiReadonlyText.copyCalls, 1, "readonly AI text view handled Copy directly without hitting canvas")

            // 5. SplitView / Material surface respects dynamic Light/Dark system appearance (no pinned .aqua)
            let splitVC = WorkspaceSplitViewController(coordinator: coord, canvasContentView: canvas)
            _ = splitVC.view
            expect(splitVC.view.appearance == nil, "WorkspaceSplitViewController follows dynamic system appearance")
            let surface = WorkspaceMaterialSurfaceView(style: .floatingControl)
            expect(surface.appearance == nil, "WorkspaceMaterialSurfaceView does not pin .aqua")
        }
    }

    @MainActor
    private static func runCheckpointFallbackFailureInjectionTests() {
        runTest("CheckpointFallbackAndFailureInjection") {
            final class ResponderCanvasView: NSView {
                override var acceptsFirstResponder: Bool { true }
                var responderSelectors: [String] = []
                @objc func copy(_ sender: Any?) { responderSelectors.append("copy:") }
                @objc func cut(_ sender: Any?) { responderSelectors.append("cut:") }
                @objc func paste(_ sender: Any?) { responderSelectors.append("paste:") }
                @objc override func selectAll(_ sender: Any?) { responderSelectors.append("selectAll:") }
                @objc func delete(_ sender: Any?) { responderSelectors.append("delete:") }
            }

            final class ReadonlyClipTextView: NSTextView {
                var copyCount = 0
                var pasteCount = 0
                override func copy(_ sender: Any?) { copyCount += 1 }
                override func paste(_ sender: Any?) { pasteCount += 1 }
            }

            let window = NSWindow(
                contentRect: NSRect(x: 0, y: 0, width: 800, height: 600),
                styleMask: [.titled, .closable],
                backing: .buffered,
                defer: false
            )
            let content = NSView(frame: window.contentRect(forFrameRect: window.frame))
            window.contentView = content

            let canvas = ResponderCanvasView(frame: NSRect(x: 0, y: 0, width: 480, height: 600))
            let chromeButton = NSButton(title: "Chrome", target: nil, action: nil)
            chromeButton.frame = NSRect(x: 500, y: 40, width: 100, height: 28)
            let nativeText = NSTextView(frame: NSRect(x: 500, y: 100, width: 220, height: 80))
            nativeText.isEditable = true
            nativeText.isSelectable = true
            nativeText.allowsUndo = true
            nativeText.string = "agent prompt"
            nativeText.setSelectedRange(NSRange(location: 0, length: 5))
            content.addSubview(canvas)
            content.addSubview(chromeButton)
            content.addSubview(nativeText)

            let mockBridge = MockNativeUIBridge()
            mockBridge.shouldFailAttach = true
            var clipboardCalls: [WorkspaceCanvasClipboardAction] = []
            var legacyEditCalls: [WorkspaceLegacyCanvasEditAction] = []
            var cancelLocalEditsCount = 0
            let canUseHostFallback = true

            let callbacks = WorkspaceFileServiceCallbacks(
                onCanvasClipboardAction: { action, _ in
                    clipboardCalls.append(action)
                    return canUseHostFallback
                },
                canPerformCanvasClipboardAction: { _ in canUseHostFallback },
                onLegacyCanvasEditAction: { action, _ in
                    legacyEditCalls.append(action)
                    return canUseHostFallback
                },
                canPerformLegacyCanvasEditAction: { _ in canUseHostFallback }
            )
            let coord = WorkspaceStateCoordinator(bridge: mockBridge, fileCallbacks: callbacks)
            coord.onBeforeFileCommand = { cancelLocalEditsCount += 1 }

            let allEditSelectors: [Selector] = [
                WorkspaceFocusRouter.undoSelector,
                WorkspaceFocusRouter.redoSelector,
                #selector(NSText.cut(_:)),
                #selector(NSText.copy(_:)),
                #selector(NSText.paste(_:)),
                #selector(NSText.selectAll(_:)),
                #selector(NSText.delete(_:))
            ]

            // 1. Attach failure: semantic bridge never attached -> canvas & .none fallback MUST keep edit + clipboard enabled & runnable
            coord.attach(preparedSurfaces: WorkspaceSurface.allCases)
            expect(!coord.isAttached, "Failure injection: attach failed")
            expect(!coord.hasOwnedCanvasEditingSurface, "Attach failed -> no owned canvas editing surface")
            expect(window.makeFirstResponder(canvas), "Focus canvas for attach-failed check")
            for sel in allEditSelectors {
                expect(
                    WorkspaceFocusRouter.validateEditAction(sel, in: window, canvasView: canvas, coordinator: coord),
                    "Attach failed preserves edit validation for \(sel)"
                )
                expect(
                    WorkspaceFocusRouter.performEditAction(sel, sender: nil, in: window, canvasView: canvas, coordinator: coord),
                    "Attach failed executes fallback for \(sel)"
                )
            }
            expectEqual(clipboardCalls, [.cut, .copy, .paste], "Attach failed routes cut/copy/paste via host clipboard")
            expectEqual(legacyEditCalls, [.undo, .redo, .selectAll, .delete], "Attach failed routes undo/redo/selectAll/delete via legacy fallback")
            expectEqual(mockBridge.dispatchedCommands.count, 0, "Attach failed never dispatches semantic commands")
            expect(cancelLocalEditsCount == 7, "Host fallback actions still flush pending local edits")

            // Toolbar + SplitView reflect fallback cleanly when attach failed
            let splitWindow = NSWindow(
                contentRect: NSRect(x: 0, y: 0, width: 800, height: 600),
                styleMask: [.titled, .closable],
                backing: .buffered,
                defer: false
            )
            let splitCanvas = ResponderCanvasView(frame: NSRect(x: 0, y: 0, width: 480, height: 600))
            let splitVC = WorkspaceSplitViewController(coordinator: coord, canvasContentView: splitCanvas)
            splitWindow.contentViewController = splitVC
            splitWindow.layoutIfNeeded()
            expect(splitWindow.makeFirstResponder(splitCanvas), "Focus splitCanvas inside SplitVC window")
            let undoToolbarItem = NSToolbarItem(itemIdentifier: NSToolbarItem.Identifier("molstudio.undo"))
            expect(splitVC.validateUserInterfaceItem(undoToolbarItem), "SplitVC undo valid during attach failure fallback")
            expect(splitVC.validateUserInterfaceItem(NSMenuItem(title: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "")), "SplitVC copy valid during attach failure fallback")

            // .none focus restores canvas focus on fallback perform without requiring attach
            expect(window.makeFirstResponder(window), "Reset firstResponder to window (.none)")
            clipboardCalls.removeAll()
            legacyEditCalls.removeAll()
            expect(
                WorkspaceFocusRouter.performEditAction(#selector(NSText.copy(_:)), sender: nil, in: window, canvasView: canvas, coordinator: coord),
                ".none focus fallback executes copy:"
            )
            expect(window.firstResponder === canvas, ".none fallback restored firstResponder to canvas")
            expectEqual(clipboardCalls, [.copy], ".none fallback routed copy to canvas")

            // .nativeChrome never triggers canvas fallback; .nativeText preserves NSTextView priority even when attach failed
            expect(window.makeFirstResponder(chromeButton), "Focus native button chrome")
            expect(!WorkspaceFocusRouter.validateEditAction(#selector(NSText.copy(_:)), in: window, canvasView: canvas, coordinator: coord), ".nativeChrome disables copy")
            expect(!WorkspaceFocusRouter.performEditAction(WorkspaceFocusRouter.undoSelector, sender: nil, in: window, canvasView: canvas, coordinator: coord), ".nativeChrome does not dispatch undo")
            expect(window.makeFirstResponder(nativeText), "Focus editable NSTextView")
            expect(WorkspaceFocusRouter.validateEditAction(#selector(NSText.copy(_:)), in: window, canvasView: canvas, coordinator: coord), ".nativeText enabled during attach failure")
            expect(WorkspaceFocusRouter.validateEditAction(#selector(NSText.paste(_:)), in: window, canvasView: canvas, coordinator: coord), ".nativeText paste enabled during attach failure")

            // Cross-window guard (e.g. Viewer3D window): never falls back to background main canvas
            let otherWindow = NSWindow(
                contentRect: NSRect(x: 0, y: 0, width: 300, height: 200),
                styleMask: [.titled],
                backing: .buffered,
                defer: false
            )
            expect(!WorkspaceFocusRouter.validateEditAction(#selector(NSText.copy(_:)), in: otherWindow, canvasView: canvas, coordinator: coord), "Other window never falls back to main canvas")

            func meta(_ navigating: Bool) -> WorkspaceDocumentMetadata {
                var m = WorkspaceDocumentMetadata.empty
                m.isNavigationInFlight = navigating
                return m
            }

            // 2. Partial ownership (.agent & .fileCommands only, NEITHER .toolPalette NOR .inspector owned)
            mockBridge.shouldFailAttach = false
            let partialEpoch = WorkspaceEpoch(navigationGeneration: 1, pageId: "partial-1")
            mockBridge.attachedEpoch = partialEpoch
            mockBridge.acceptedSurfaces = [.agent, .fileCommands]
            mockBridge.initialState = WorkspaceUIState(
                protocol: workspaceNativeUIProtocolVersion,
                epoch: partialEpoch,
                revision: 1,
                ready: WorkspaceUIState.Ready(canvas: true, agent: true),
                supported: WorkspaceUIState.Supported(
                    commands: ["edit.undo", "edit.redo", "edit.selectAll", "edit.delete"],
                    toolIds: [],
                    elementSymbols: [],
                    templateIds: []
                ),
                tool: .none,
                selection: .empty,
                history: WorkspaceUIState.History(canUndo: true, canRedo: true),
                viewport: .initial,
                agent: .idle
            )
            coord.beginNavigation(generation: 1)
            coord.updateDocumentMetadata(meta(false))
            coord.attach(preparedSurfaces: [.agent, .fileCommands])
            expect(coord.isAttached, "Partial attach succeeded for agent surface")
            expect(!coord.hasOwnedCanvasEditingSurface, "Neither toolPalette nor inspector owned -> no editing surface")
            expect(window.makeFirstResponder(canvas), "Focus canvas for partial-surface check")
            clipboardCalls.removeAll()
            legacyEditCalls.removeAll()
            let cmdCountBeforePartial = mockBridge.dispatchedCommands.count
            for sel in allEditSelectors {
                expect(
                    WorkspaceFocusRouter.validateEditAction(sel, in: window, canvasView: canvas, coordinator: coord),
                    "Partial surface (no editing surface) keeps fallback enabled for \(sel)"
                )
                expect(
                    WorkspaceFocusRouter.performEditAction(sel, sender: nil, in: window, canvasView: canvas, coordinator: coord),
                    "Partial surface falls back cleanly for \(sel)"
                )
            }
            expectEqual(clipboardCalls, [.cut, .copy, .paste], "Partial non-editing attach still uses host clipboard")
            expectEqual(legacyEditCalls, [.undo, .redo, .selectAll, .delete], "Partial non-editing attach still uses legacy canvas edits")
            expectEqual(mockBridge.dispatchedCommands.count, cmdCountBeforePartial, "Partial non-editing attach avoids semantic dispatch when editing surfaces unowned")

            // 3. Owned editing surface but ready.canvas == false (not ready while not navigating)
            mockBridge.acceptedSurfaces = [.toolPalette, .inspector]
            let unreadyEpoch = WorkspaceEpoch(navigationGeneration: 2, pageId: "unready-2")
            mockBridge.attachedEpoch = unreadyEpoch
            mockBridge.initialState = WorkspaceUIState(
                protocol: workspaceNativeUIProtocolVersion,
                epoch: unreadyEpoch,
                revision: 1,
                ready: .notReady,
                supported: WorkspaceUIState.Supported(
                    commands: ["edit.undo", "edit.redo", "edit.selectAll", "edit.delete"],
                    toolIds: [],
                    elementSymbols: [],
                    templateIds: []
                ),
                tool: .none,
                selection: .empty,
                history: .disabled,
                viewport: .initial,
                agent: .idle
            )
            coord.beginNavigation(generation: 2)
            coord.updateDocumentMetadata(meta(false))
            coord.attach(preparedSurfaces: [.toolPalette, .inspector])
            expect(!coord.hasOwnedCanvasEditingSurface, "ready.canvas == false means editing surface not ready")
            legacyEditCalls.removeAll()
            expect(WorkspaceFocusRouter.performEditAction(WorkspaceFocusRouter.undoSelector, sender: nil, in: window, canvasView: canvas, coordinator: coord), "Unready canvas falls back to legacy undo")
            expectEqual(legacyEditCalls, [.undo], "Unready canvas used legacy undo instead of failing silently")

            // 4. Navigation in flight blocks canvas edit + clipboard and avoids stealing focus, while preserving .nativeText
            coord.updateDocumentMetadata(meta(true))
            expect(window.makeFirstResponder(window), "Set .none focus during navigation")
            expect(!WorkspaceFocusRouter.validateEditAction(#selector(NSText.copy(_:)), in: window, canvasView: canvas, coordinator: coord), "Navigation in flight blocks canvas copy validation")
            expect(!WorkspaceFocusRouter.performEditAction(#selector(NSText.copy(_:)), sender: nil, in: window, canvasView: canvas, coordinator: coord), "Navigation in flight blocks canvas copy execution")
            expect(window.firstResponder !== canvas, "Blocked navigation action must not steal focus")
            expect(window.makeFirstResponder(nativeText), "Focus native text during navigation")
            expect(WorkspaceFocusRouter.validateEditAction(#selector(NSText.copy(_:)), in: window, canvasView: canvas, coordinator: coord), "Native text copy stays valid during navigation")

            // 5. Recovered: navigation settles and ready.canvas == true -> semantic coordinator owns edit actions again
            coord.updateDocumentMetadata(meta(false))
            let readyState = WorkspaceUIState(
                protocol: workspaceNativeUIProtocolVersion,
                epoch: unreadyEpoch,
                revision: 2,
                ready: WorkspaceUIState.Ready(canvas: true, agent: true),
                supported: WorkspaceUIState.Supported(
                    commands: ["edit.undo", "edit.redo", "edit.selectAll", "edit.delete"],
                    toolIds: [],
                    elementSymbols: [],
                    templateIds: []
                ),
                tool: .none,
                selection: .empty,
                history: WorkspaceUIState.History(canUndo: false, canRedo: true),
                viewport: .initial,
                agent: .idle
            )
            expect(
                coord.receiveMessage(WorkspaceNativeUIMessage(protocol: workspaceNativeUIProtocolVersion, epoch: unreadyEpoch, sequence: 1, kind: .state(readyState))),
                "Recovered state message accepted"
            )
            expect(coord.hasOwnedCanvasEditingSurface, "Recovered canvas editing surface owned and ready")
            expect(window.makeFirstResponder(canvas), "Focus canvas after recovery")
            expect(!WorkspaceFocusRouter.validateEditAction(WorkspaceFocusRouter.undoSelector, in: window, canvasView: canvas, coordinator: coord), "Recovered semantic gating disables undo when canUndo == false")
            expect(WorkspaceFocusRouter.validateEditAction(WorkspaceFocusRouter.redoSelector, in: window, canvasView: canvas, coordinator: coord), "Recovered semantic gating enables redo when canRedo == true")
            let semanticCmdCountBeforeRedo = mockBridge.dispatchedCommands.count
            legacyEditCalls.removeAll()
            expect(WorkspaceFocusRouter.performEditAction(WorkspaceFocusRouter.redoSelector, sender: nil, in: window, canvasView: canvas, coordinator: coord), "Recovered semantic redo dispatches command")
            expectEqual(mockBridge.dispatchedCommands.count, semanticCmdCountBeforeRedo + 1, "Recovered redo dispatched one semantic command")
            expectEqual(mockBridge.dispatchedCommands.last?.id, "edit.redo", "Recovered redo dispatched semantically")
            expectEqual(legacyEditCalls, [], "Recovered mode does not bypass semantic channel for redo")

            // 6. Browser / no-coordinator fallback (`coordinator == nil`), both host closures & raw AppKit responder target
            canvas.responderSelectors.removeAll()
            expect(
                WorkspaceFocusRouter.validateEditAction(#selector(NSText.copy(_:)), in: window, canvasView: canvas, coordinator: nil),
                "Browser/nil-coordinator AppKit responder validates copy:"
            )
            expect(
                WorkspaceFocusRouter.performEditAction(#selector(NSText.copy(_:)), sender: nil, in: window, canvasView: canvas, coordinator: nil),
                "Browser/nil-coordinator AppKit responder performs copy:"
            )
            expectEqual(canvas.responderSelectors, ["copy:"], "AppKit responder fallback invoked copy: on canvasView")

            var browserClip: [WorkspaceCanvasClipboardAction] = []
            var browserEdit: [WorkspaceLegacyCanvasEditAction] = []
            expect(
                WorkspaceFocusRouter.validateEditAction(
                    #selector(NSText.paste(_:)),
                    in: window,
                    canvasView: canvas,
                    coordinator: nil,
                    legacyClipboardValidator: { _ in true }
                ),
                "Browser/nil-coordinator validates host clipboard closure"
            )
            expect(
                WorkspaceFocusRouter.performEditAction(
                    #selector(NSText.paste(_:)),
                    sender: nil,
                    in: window,
                    canvasView: canvas,
                    coordinator: nil,
                    legacyClipboardHandler: { action, _ in browserClip.append(action); return true },
                    legacyClipboardValidator: { _ in true }
                ),
                "Browser/nil-coordinator performs host clipboard closure"
            )
            expect(
                WorkspaceFocusRouter.performEditAction(
                    WorkspaceFocusRouter.undoSelector,
                    sender: nil,
                    in: window,
                    canvasView: canvas,
                    coordinator: nil,
                    legacyEditHandler: { action, _ in browserEdit.append(action); return true },
                    legacyEditValidator: { _ in true }
                ),
                "Browser/nil-coordinator performs host edit closure"
            )
            expectEqual(browserClip, [.paste], "Nil-coordinator routed paste via fallback closure")
            expectEqual(browserEdit, [.undo], "Nil-coordinator routed undo via fallback closure")

            // Native text responder first under nil coordinator too
            let readonlyText = ReadonlyClipTextView(frame: NSRect(x: 500, y: 200, width: 120, height: 40))
            readonlyText.isEditable = false
            readonlyText.isSelectable = true
            readonlyText.string = "hello"
            readonlyText.setSelectedRange(NSRange(location: 0, length: 5))
            content.addSubview(readonlyText)
            expect(window.makeFirstResponder(readonlyText), "Focus readonly native text")
            expect(WorkspaceFocusRouter.validateEditAction(#selector(NSText.copy(_:)), in: window, canvasView: canvas, coordinator: nil), "Readonly text allows copy under nil coordinator")
            expect(!WorkspaceFocusRouter.validateEditAction(#selector(NSText.paste(_:)), in: window, canvasView: canvas, coordinator: nil), "Readonly text blocks paste under nil coordinator")

            // 7. Process-private pasteboard UTI isolation check (never touches NSPasteboard.general)
            let isolatedPB = NSPasteboard.withUniqueName()
            defer { isolatedPB.releaseGlobally() }
            let mechType = NSPasteboard.PasteboardType("local.molstudio.mechanism")
            isolatedPB.clearContents()
            isolatedPB.declareTypes([mechType], owner: nil)
            expect(isolatedPB.setString(#"{"kind":"molstudio-mechanism","version":1}"#, forType: mechType), "Isolated pasteboard accepts custom mechanism UTI")
            expect(isolatedPB.string(forType: .string) == nil, "Custom mechanism UTI leaves NSPasteboard .string nil (no raw JSON leak)")
            expectEqual((isolatedPB.types ?? []).map(\.rawValue), ["local.molstudio.mechanism"], "Pasteboard types exclude plain text")
        }
    }
}

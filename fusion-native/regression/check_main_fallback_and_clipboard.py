#!/usr/bin/env python3
"""
Extracts verbatim clipboard & menu/shortcut fallback methods from
`fusion-native/Sources/Ketcher3D/main.swift`, links them against real
`WorkspaceContract.swift` + `WorkspaceAppearance.swift`, and verifies:
  1. `writeMechanismClipboard` / `readMechanismClipboard` write ONLY `local.molstudio.mechanism`
     (never `.string`), reject `.string`-only JSON, and clear cleanly on external text writes.
  2. `validateMenuItem`, `actUndo`/`actRedo`/`actSelectAll`/`actDeleteSel`,
     `actZoomIn`/`actZoomOut`/`actZoomReset`/`actZoomFit`, `performCanvasClipboard`,
     `actCopy`/`actCut`/`actPaste`, and `handleControlClipboardKeyEvent` preserve
     fallback when `attach` fails, neither editing surface is owned, or `coordinator == nil`,
     while never swallowing unhandled shortcuts or hijacking `.nativeText` / `.nativeChrome` / other windows.
"""
import os
import re
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
SOURCES = os.path.join(ROOT, 'fusion-native/Sources/Ketcher3D')
MAIN_SWIFT = os.path.join(SOURCES, 'main.swift')

src = open(MAIN_SWIFT, encoding='utf-8').read()
lines = src.split('\n')


def extract_method(sig):
    out = []
    for i, ln in enumerate(lines):
        if sig in ln and 'func ' in ln:
            stripped = re.sub(r'^\s*(private\(set\)\s+|private\s+|@objc\s+|@discardableResult\s+|public\s+)*', '', ln)
            if '@discardableResult' in ln or (i > 0 and '@discardableResult' in lines[i - 1]):
                stripped = '@discardableResult\n' + stripped
            if '@objc' in ln:
                stripped = '@objc ' + stripped.lstrip('@objc ')
            parens = 0

            def body_start(line):
                nonlocal parens
                for idx, ch in enumerate(line):
                    if ch == '(':
                        parens += 1
                    elif ch == ')':
                        parens -= 1
                    elif ch == '{' and parens == 0:
                        return idx
                return None

            start = body_start(stripped.split('\n')[-1])
            buf = [stripped]
            j = i + 1
            while start is None and j < len(lines):
                buf.append(lines[j])
                start = body_start(lines[j])
                j += 1
            if start is None:
                raise RuntimeError(f'No body for {sig}')
            seg = buf[-1][start:]
            depth = seg.count('{') - seg.count('}')
            while depth > 0 and j < len(lines):
                l2 = lines[j]
                buf.append(l2)
                depth += l2.count('{') - l2.count('}')
                j += 1
            if depth != 0:
                raise RuntimeError(f'Unbalanced braces for {sig}')
            body = '\n'.join(buf)
            body = re.sub(r'^    ', '', body, flags=re.M)
            out.append(body.rstrip())
    if not out:
        raise RuntimeError(f'Method not found: {sig}')
    return '\n\n'.join(out)


PASTEBOARD_SIGS = [
    'func writeMechanismClipboard(',
    'func readMechanismClipboard(',
]

MENU_FALLBACK_SIGS = [
    'func handleControlClipboardKeyEvent(',
    'func validateMenuEditAction(',
    'func validateMenuItem(',
    'func routeEditAction(',
    'func performLegacyCanvasEdit(',
    'func actUndo(',
    'func actRedo(',
    'func actSelectAll(',
    'func actDeleteSel(',
    'func actZoomIn(',
    'func actZoomOut(',
    'func actZoomReset(',
    'func actZoomFit(',
    'func performCanvasClipboard(',
    'func performCopy(',
    'func performCut(',
    'func performPaste(',
    'func actCopy(',
    'func actCut(',
    'func actPaste(',
]

pasteboard_methods = '\n\n'.join(extract_method(s) for s in PASTEBOARD_SIGS)
fallback_methods = '\n\n'.join(extract_method(s) for s in MENU_FALLBACK_SIGS)

PASTEBOARD_SWIFT = r'''import Foundation

final class NSPasteboard {
    struct PasteboardType: RawRepresentable, Equatable, Hashable {
        let rawValue: String
        init(_ rawValue: String) { self.rawValue = rawValue }
        init(rawValue: String) { self.rawValue = rawValue }
        static let string = PasteboardType("public.utf8-plain-text")
    }

    static let general = NSPasteboard()

    private(set) var types: [PasteboardType]? = []
    private(set) var storage: [PasteboardType: String] = [:]
    private(set) var clearCount = 0

    func clearContents() {
        clearCount += 1
        types = []
        storage = [:]
    }

    @discardableResult
    func declareTypes(_ newTypes: [PasteboardType], owner: Any?) -> Int {
        types = newTypes
        return newTypes.count
    }

    @discardableResult
    func setString(_ string: String, forType dataType: PasteboardType) -> Bool {
        if !(types ?? []).contains(dataType) {
            types = (types ?? []) + [dataType]
        }
        storage[dataType] = string
        return true
    }

    func string(forType dataType: PasteboardType) -> String? {
        storage[dataType]
    }
}

final class MechanismClipboardExtractorProbe {
    static let mechPasteboardType = NSPasteboard.PasteboardType("local.molstudio.mechanism")

''' + '\n'.join('    ' + ln for ln in pasteboard_methods.split('\n')) + r'''

    func runTests() -> Int {
        var failed = 0
        func check(_ cond: Bool, _ msg: String) {
            if !cond {
                print("FAIL [Pasteboard]: \(msg)")
                failed += 1
            } else {
                print("PASS [Pasteboard]: \(msg)")
            }
        }

        let sample = #"{"kind":"molstudio-mechanism","version":1,"arrows":[{"id":"a1"}]}"#
        let pb = NSPasteboard.general
        pb.clearContents()
        pb.setString("STALE-PLAIN", forType: .string)

        let okWrite = writeMechanismClipboard(sample)
        check(okWrite, "writeMechanismClipboard returns true")
        check((pb.types ?? []).map(\.rawValue) == ["local.molstudio.mechanism"], "writes ONLY local.molstudio.mechanism type")
        check(pb.string(forType: .string) == nil, "does NOT leak mechanism JSON into .string")
        check(readMechanismClipboard() == sample, "readMechanismClipboard reads custom mechanism UTI")

        // External text copy wipes local.molstudio.mechanism; readMechanismClipboard must return nil
        pb.clearContents()
        pb.declareTypes([.string], owner: nil)
        pb.setString("EXTERNAL-TEXT", forType: .string)
        check(readMechanismClipboard() == nil, "external plain text clears mechanism pasteboard")

        // Even if .string happens to hold raw mechanism JSON without local.molstudio.mechanism, never treat .string as mechanism
        pb.clearContents()
        pb.declareTypes([.string], owner: nil)
        pb.setString(sample, forType: .string)
        check(readMechanismClipboard() == nil, "readMechanismClipboard never parses raw JSON from .string")

        return failed
    }
}

func runExtractedPasteboardProbe() -> Int {
    MechanismClipboardExtractorProbe().runTests()
}
'''

MAIN_PROBE_SWIFT = r'''import AppKit
import Foundation

struct WelcomeRecentItem: Sendable {}

final class ProbeSplitViewController: NSResponder {
    @objc func undo(_ sender: Any?) {}
    @objc func redo(_ sender: Any?) {}
}

typealias WorkspaceSplitViewController = ProbeSplitViewController

final class StubBridge: WorkspaceNativeUIBridging {
    var attachShouldFail = false
    var nextGeneration = 1
    var commands: [WorkspaceCommand] = []

    func attach(options: WorkspaceAttachOptions, completion: @escaping (Result<WorkspaceAttachReply, Error>) -> Void) {
        if attachShouldFail {
            completion(.failure(WorkspaceBridgeError.scriptError("Attach failed")))
            return
        }
        let epoch = WorkspaceEpoch(navigationGeneration: options.navigationGeneration, pageId: "probe-page-\(options.navigationGeneration)")
        let reply = WorkspaceAttachReply(
            ok: true,
            epoch: epoch,
            sequence: 0,
            ownedSurfaces: options.nativeSurfaces,
            state: WorkspaceUIState.disabledInitial(epoch: epoch)
        )
        completion(.success(reply))
    }

    func dispatch(command: WorkspaceCommand, completion: @escaping (Result<WorkspaceCommandReply, Error>) -> Void) {
        commands.append(command)
        let reply = WorkspaceCommandReply(epoch: command.epoch, requestId: command.requestId, ok: true, error: nil)
        completion(.success(reply))
    }

    func getState(completion: @escaping (Result<WorkspaceUIState, Error>) -> Void) {
        completion(.success(WorkspaceUIState.disabledInitial()))
    }

    func detach(epoch: WorkspaceEpoch) {}
}

final class ProbeCanvasView: NSView {
    override var acceptsFirstResponder: Bool { true }
    @objc func copy(_ sender: Any?) {}
    @objc func cut(_ sender: Any?) {}
    @objc func paste(_ sender: Any?) {}
    @objc override func selectAll(_ sender: Any?) {}
    @objc func delete(_ sender: Any?) {}
}

struct StubSession {
    var currentSnapshot = ""
}

@MainActor
final class MainFallbackProbeHarness: NSObject {
    static let mechPasteboardType = NSPasteboard.PasteboardType("local.molstudio.mechanism")

    var window: NSWindow?
    var keyWindowOverride: NSWindow?
    var web: NSView?
    var workspaceSplitVC: ProbeSplitViewController?
    var workspaceCoordinator: WorkspaceStateCoordinator?
    var session = StubSession()
    var pageUsable = true
    var navigationInFlight = false
    var navigationGeneration = 1
    var jsCalls: [String] = []
    var jsValueQueries: [String] = []
    var mechClipboardText: String?
    var nextFocusEditable = false

    var targetEditWindow: NSWindow? { keyWindowOverride ?? window }

    func dbg(_ s: String) {}
    func jsonLiteral(_ s: String) -> String {
        guard let d = try? JSONEncoder().encode(s), let out = String(data: d, encoding: .utf8) else { return "\"\"" }
        return out
    }
    func snapshotHasDocument(_ s: String) -> Bool { false }
    func readMechanismClipboard() -> String? { mechClipboardText }
    func js(_ body: String) { jsCalls.append(body) }
    func jsValue(_ body: String, _ done: @escaping (_ value: Any?, _ ok: Bool) -> Void) {
        jsValueQueries.append(body)
        if body.contains("focusedIsEditable") {
            done(nextFocusEditable ? "editable" : "pasted", true)
            return
        }
        if body.contains("window.k3dAPI.selectAll") {
            done(true, true)
            return
        }
        done(true, true)
    }

    // Required @objc selectors referenced by main.swift's validateMenuItem
    @objc func actToggleSidebar() {}
    @objc func actToggleInspector() {}
    @objc func actToggleAgent() {}
    @objc func actSave() {}
    @objc func actSaveAs() {}
    @objc func actExportMol() {}
    @objc func actExportMechanismImage() {}
    @objc func actExportDocumentPDF() {}
    @objc func actCopySmiles() {}
    @objc func actCheck() {}
    @objc func actClean() {}
    @objc func actProps() {}
    @objc func actGen3D() {}
    @objc func actSwitchToPaperMode() {}
    @objc func actSwitchToCanvasMode() {}
    @objc func actPaperSetup() {}
    @objc func actAddPaperPage() {}
    @objc func actRemoveBlankLastPage() {}
    @objc func actInsertImageIntoDocument() {}
    @objc func actInsertFileIntoDocument() {}

''' + '\n'.join('    ' + ln for ln in fallback_methods.split('\n')) + r'''

    func wireCallbacks(on coord: WorkspaceStateCoordinator) {
        coord.fileCallbacks = WorkspaceFileServiceCallbacks(
            onCanvasClipboardAction: { [weak self] action, sender in
                self?.performCanvasClipboard(action, sender: sender) ?? false
            },
            canPerformCanvasClipboardAction: { [weak self] _ in
                guard let self else { return false }
                return self.pageUsable && !self.navigationInFlight && self.web != nil
            },
            onLegacyCanvasEditAction: { [weak self] action, sender in
                self?.performLegacyCanvasEdit(action, sender: sender) ?? false
            },
            canPerformLegacyCanvasEditAction: { [weak self] _ in
                guard let self else { return false }
                return self.pageUsable && !self.navigationInFlight && self.web != nil
            }
        )
    }
}

@main
@MainActor
struct ProbeRunner {
    static func main() {
        _ = NSApplication.shared
        var failed = runExtractedPasteboardProbe()

        func check(_ cond: Bool, _ msg: String) {
            if !cond {
                print("FAIL [MainFallback]: \(msg)")
                failed += 1
            } else {
                print("PASS [MainFallback]: \(msg)")
            }
        }

        let mainWin = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 800, height: 600), styleMask: [.titled], backing: .buffered, defer: false)
        let content = NSView(frame: NSRect(x: 0, y: 0, width: 800, height: 600))
        mainWin.contentView = content
        let webView = ProbeCanvasView(frame: NSRect(x: 0, y: 0, width: 500, height: 600))
        let chrome = NSButton(title: "Chrome", target: nil, action: nil)
        let nativeText = NSTextView(frame: NSRect(x: 520, y: 80, width: 200, height: 80))
        nativeText.isEditable = true
        nativeText.isSelectable = true
        nativeText.string = "agent-input"
        nativeText.setSelectedRange(NSRange(location: 0, length: 5))
        content.addSubview(webView)
        content.addSubview(chrome)
        content.addSubview(nativeText)

        let harness = MainFallbackProbeHarness()
        harness.window = mainWin
        harness.web = webView

        let menuSelectors: [(String, Selector)] = [
            ("Undo", #selector(MainFallbackProbeHarness.actUndo)),
            ("Redo", #selector(MainFallbackProbeHarness.actRedo)),
            ("Cut", #selector(MainFallbackProbeHarness.actCut)),
            ("Copy", #selector(MainFallbackProbeHarness.actCopy)),
            ("Paste", #selector(MainFallbackProbeHarness.actPaste)),
            ("SelectAll", #selector(MainFallbackProbeHarness.actSelectAll)),
            ("Delete", #selector(MainFallbackProbeHarness.actDeleteSel)),
            ("ZoomIn", #selector(MainFallbackProbeHarness.actZoomIn)),
            ("ZoomOut", #selector(MainFallbackProbeHarness.actZoomOut)),
            ("ZoomReset", #selector(MainFallbackProbeHarness.actZoomReset)),
        ]

        // 1. Browser / coordinator == nil fallback
        harness.workspaceCoordinator = nil
        mainWin.makeFirstResponder(webView)
        for (name, sel) in menuSelectors {
            let item = NSMenuItem(title: name, action: sel, keyEquivalent: "")
            check(harness.validateMenuItem(item), "Nil coordinator enables \(name)")
        }
        harness.jsCalls.removeAll()
        harness.jsValueQueries.removeAll()
        harness.actUndo()
        harness.actRedo()
        harness.actDeleteSel()
        harness.actSelectAll()
        harness.actZoomIn()
        harness.actZoomOut()
        harness.actZoomReset()
        harness.actCopy()
        check(harness.jsCalls.contains { $0.contains("k3dAPI.undo") }, "Nil coordinator actUndo hits k3dAPI.undo")
        check(harness.jsCalls.contains { $0.contains("k3dAPI.redo") }, "Nil coordinator actRedo hits k3dAPI.redo")
        check(harness.jsCalls.contains { $0.contains("k3dAPI.deleteSel") }, "Nil coordinator actDeleteSel hits k3dAPI.deleteSel")
        check(harness.jsValueQueries.contains { $0.contains("k3dAPI.selectAll") }, "Nil coordinator actSelectAll hits k3dAPI.selectAll")
        check(harness.jsCalls.contains { $0.contains("zoomBy(1.25)") }, "Nil coordinator actZoomIn hits zoomBy(1.25)")
        check(harness.jsCalls.contains { $0.contains("zoomBy(0.8)") }, "Nil coordinator actZoomOut hits zoomBy(0.8)")
        check(harness.jsCalls.contains { $0.contains("zoomToPercent(100)") }, "Nil coordinator actZoomReset hits zoomToPercent(100)")
        check(harness.jsValueQueries.contains { $0.contains("prepareNativeClipboard(\"copy\")") }, "Nil coordinator actCopy hits prepareNativeClipboard")

        // Paste with local.molstudio.mechanism present invokes mechPaste directly without touching .string
        harness.jsValueQueries.removeAll()
        harness.mechClipboardText = #"{"kind":"molstudio-mechanism","version":1,"arrows":[]}"#
        harness.actPaste()
        check(harness.jsValueQueries.contains { $0.contains("mechPaste") }, "actPaste delivers custom mechanism payload via mechPaste")

        // 2. Attach failed fallback via real WorkspaceStateCoordinator
        let bridge = StubBridge()
        bridge.attachShouldFail = true
        let coord = WorkspaceStateCoordinator(bridge: bridge)
        harness.wireCallbacks(on: coord)
        harness.workspaceCoordinator = coord
        coord.attach(preparedSurfaces: WorkspaceSurface.allCases)
        check(!coord.isAttached, "Attach failed as expected")
        for (name, sel) in menuSelectors {
            let item = NSMenuItem(title: name, action: sel, keyEquivalent: "")
            check(harness.validateMenuItem(item), "Attach-failed preserves menu item \(name)")
        }
        harness.jsCalls.removeAll()
        harness.jsValueQueries.removeAll()
        harness.actUndo()
        harness.actCopy()
        harness.actZoomIn()
        check(harness.jsCalls.contains { $0.contains("k3dAPI.undo") }, "Attach-failed actUndo falls back to k3dAPI.undo")
        check(harness.jsValueQueries.contains { $0.contains("prepareNativeClipboard(\"copy\")") }, "Attach-failed actCopy falls back to prepareNativeClipboard")
        check(harness.jsCalls.contains { $0.contains("zoomBy(1.25)") }, "Attach-failed actZoomIn falls back to zoomBy(1.25)")

        // Control+C/X/V shortcut handling: handled on canvas/none, NOT swallowed on nativeText/nativeChrome or other window
        let dummyKeyEvent = NSEvent.keyEvent(
            with: .keyDown,
            location: .zero,
            modifierFlags: [.control],
            timestamp: 0,
            windowNumber: mainWin.windowNumber,
            context: nil,
            characters: "c",
            charactersIgnoringModifiers: "c",
            isARepeat: false,
            keyCode: 8
        )!
        mainWin.makeFirstResponder(webView)
        check(harness.handleControlClipboardKeyEvent(dummyKeyEvent, character: "c", in: mainWin) == nil, "Ctrl+C on canvas is handled even when attach failed")
        mainWin.makeFirstResponder(mainWin)
        check(harness.handleControlClipboardKeyEvent(dummyKeyEvent, character: "c", in: mainWin) == nil, "Ctrl+C with .none focus falls back to canvas")
        mainWin.makeFirstResponder(chrome)
        check(harness.handleControlClipboardKeyEvent(dummyKeyEvent, character: "c", in: mainWin) != nil, "Ctrl+C on .nativeChrome is NOT swallowed")
        mainWin.makeFirstResponder(nativeText)
        check(harness.handleControlClipboardKeyEvent(dummyKeyEvent, character: "c", in: mainWin) != nil, "Ctrl+C on .nativeText passes through to text system")
        let otherWin = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 200, height: 200), styleMask: [.titled], backing: .buffered, defer: false)
        check(harness.handleControlClipboardKeyEvent(dummyKeyEvent, character: "c", in: otherWin) != nil, "Ctrl+C in Viewer3D/other window is NOT hijacked")

        // Cross-window menu validation: Viewer3D key window must NOT inherit main canvas fallback
        harness.keyWindowOverride = otherWin
        check(!harness.validateMenuItem(NSMenuItem(title: "Copy", action: #selector(MainFallbackProbeHarness.actCopy), keyEquivalent: "")), "Other keyWindow does not hijack main canvas Copy")
        harness.keyWindowOverride = nil

        var clearMeta = WorkspaceDocumentMetadata.empty
        clearMeta.isNavigationInFlight = false

        // 3. Attach succeeded with partial non-editing surfaces (.agent only, no .toolPalette/.inspector/.zoomPalette)
        bridge.attachShouldFail = false
        coord.beginNavigation(generation: 1)
        coord.updateDocumentMetadata(clearMeta)
        coord.attach(preparedSurfaces: [.agent, .fileCommands])
        mainWin.makeFirstResponder(webView)
        for (name, sel) in menuSelectors {
            check(harness.validateMenuItem(NSMenuItem(title: name, action: sel, keyEquivalent: "")), "Partial non-editing attach keeps \(name) enabled")
        }
        harness.jsCalls.removeAll()
        bridge.commands.removeAll()
        harness.actUndo()
        check(harness.jsCalls.contains { $0.contains("k3dAPI.undo") } && bridge.commands.isEmpty, "Partial non-editing attach falls back to k3dAPI instead of dropping undo")

        // 4. Recovered semantic attach takes back semantic zoom & undo gating
        coord.beginNavigation(generation: 2)
        coord.updateDocumentMetadata(clearMeta)
        coord.attach(preparedSurfaces: WorkspaceSurface.allCases)
        let recoveredEpoch = coord.attachedEpoch!
        let s = WorkspaceUIState(
            protocol: workspaceNativeUIProtocolVersion,
            epoch: recoveredEpoch,
            revision: 1,
            ready: WorkspaceUIState.Ready(canvas: true, agent: true),
            supported: WorkspaceUIState.Supported(
                commands: ["edit.undo", "edit.redo", "edit.selectAll", "edit.delete", "zoom.by", "zoom.toPercent", "zoom.fit"],
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
        check(coord.receiveMessage(WorkspaceNativeUIMessage(protocol: workspaceNativeUIProtocolVersion, epoch: recoveredEpoch, sequence: 1, kind: .state(s))), "Recovered state applied")
        mainWin.makeFirstResponder(webView)
        check(!harness.validateMenuItem(NSMenuItem(title: "Undo", action: #selector(MainFallbackProbeHarness.actUndo), keyEquivalent: "")), "Recovered semantic gating disables Undo when canUndo==false")
        check(harness.validateMenuItem(NSMenuItem(title: "Redo", action: #selector(MainFallbackProbeHarness.actRedo), keyEquivalent: "")), "Recovered semantic gating enables Redo when canRedo==true")
        check(harness.validateMenuItem(NSMenuItem(title: "ZoomFit", action: #selector(MainFallbackProbeHarness.actZoomFit), keyEquivalent: "")), "Recovered zoomPalette enables ZoomFit")

        print("MAIN_FALLBACK_PROBE_FAILED=\(failed)")
        if failed > 0 { exit(1) }
    }
}
'''

with tempfile.TemporaryDirectory(prefix='molstudio-main-fallback-probe-') as tmp:
    pb_path = os.path.join(tmp, 'PasteboardProbe.swift')
    main_path = os.path.join(tmp, 'MainFallbackProbe.swift')
    bin_path = os.path.join(tmp, 'probe-bin')
    mcache = os.path.join(tmp, 'mcache')
    with open(pb_path, 'w', encoding='utf-8') as f:
        f.write(PASTEBOARD_SWIFT)
    with open(main_path, 'w', encoding='utf-8') as f:
        f.write(MAIN_PROBE_SWIFT)
    cmd = [
        'swiftc', '-parse-as-library', '-O',
        '-module-cache-path', mcache,
        '-o', bin_path,
        os.path.join(SOURCES, 'WorkspaceContract.swift'),
        os.path.join(SOURCES, 'WorkspaceAppearance.swift'),
        pb_path,
        main_path,
    ]
    res = subprocess.run(cmd, capture_output=True, text=True)
    if res.returncode != 0:
        print(res.stdout)
        print(res.stderr, file=sys.stderr)
        sys.exit(res.returncode)
    run = subprocess.run([bin_path], capture_output=True, text=True)
    print(run.stdout, end='')
    if run.stderr:
        print(run.stderr, file=sys.stderr, end='')
    sys.exit(run.returncode)

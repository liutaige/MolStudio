#!/usr/bin/env python3
# R01-R06 回归测试生成器（复用复核者 /tmp/molstudio-review-1101/probe.swift 的方法：
# 从 main.swift 提取真实方法体 + 替身面板/WebKit，保证测试的是交付代码本身）。
import os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))          # …/fusion-native/regression
ROOT = os.path.dirname(os.path.dirname(HERE))              # 仓库根（…/MolStudio）
SRC = os.path.join(ROOT, 'fusion-native/Sources/Ketcher3D/main.swift')
OUT_DIR = os.environ.get('OUT_DIR', os.path.join('/tmp', 'molstudio-regression'))
os.makedirs(OUT_DIR, exist_ok=True)
OUT = os.path.join(OUT_DIR, 'probe-tests.swift')

src = open(SRC, encoding='utf-8').read()
lines = src.split('\n')

# 需要提取的真实方法（签名行子串）。confirmDiscard 有两个重载，全部提取。
TARGETS = [
    'func sessionOf(', 'func commitSessionSnapshot(', 'func pollActiveSnapshot(',
    'func fetchSnapshot(', 'func applicationShouldTerminate(', 'func askTerminateSave(',
    'func saveAllForTerminate(', 'func verifySavedBeforeLeaving(', 'func finishTerminate(', 'func sessionName(',
    'func confirmDiscard(', 'func windowShouldClose(', 'func closeActiveSession(', 'func actNewDocument(', 'func startNewPaperDocument(',
    'func startNavigation(', 'func endNavigationTransaction(', 'func captureForNavigation(',
    'func captureActiveSession(', 'func waitPaperEditorReady(', 'func applyPending(', 'func rollbackAfterFailedInjection(', 'func scheduleWelcomeThumbnail(',
    'func freshBaselineAfterPageReady(', 'func commitFreshSession(', 'func openDocument(',
    'func navigateWithCapture(', 'func actOpen(', 'func actOpenSelected(',
    'func gen3dWarningText(', 'func applyGen3DWarning(',
    'func appendServerStderr(', 'func serverFailureDiagnostics(',
    'func pythonRuntimeMissingMessage(', 'func jsonLiteral(',
    'func saveSession(', 'func fetchCanvasSaveTexts(',
    # 2026-11-01 机理层：完整快照识别/抽取与自检 JS
    'func canvasSnapshotJS(', 'func normalizedCanvasFileText(', 'func isWorkbenchSnapshot(',
    'func workbenchLoadError(', 'func ketTextFromSnapshot(',
    'func wrapKetAsWorkbench(', 'func snapshotHasMechanism(', 'func snapshotHasDocument(',   # 2026-11-01 机理层：fetchCanvasSavePair → fetchCanvasSaveTexts（取完整快照 + 写盘文本）
    # 2026-11-01 父代理补充：导航失败出口 / 逃生阀 / 页面可用性
    'func abortNavigation(', 'func offerReloadAfterPageFailure(', 'func reloadCurrentPage(',
    'func armNavigationWatchdog(', 'func cancelNavigationWatchdog(',
    'func askDiscardAnyway(', 'func askTerminateDiscardAnyway(', 'func contentTypes(',
    # 2026-11-01 立体整理 / 3D 提示：文案与结果提示
    'func stereoPromptMessage(', 'func stereoBadgeText(', 'func reportLayoutResult(',
    'func actClean(', 'func invalidateCleanLayoutRequest(',
    'func confirmStereoExample(',
]

def extract(sig):
    """返回该签名对应的所有方法体（从签名行开始做大括号配对，逐字复制）。"""
    out = []
    for i, ln in enumerate(lines):
        if sig in ln and 'func ' in ln:
            # 去访问修饰符
            stripped = re.sub(r'^\s*(private\(set\)\s+|private\s+|@objc\s+|public\s+)*', '', ln)
            # 默认闭包也含大括号；函数体只能从参数括号之外的 { 开始。
            parens = 0
            def body_start(line):
                nonlocal parens
                for index, char in enumerate(line):
                    if char == '(':
                        parens += 1
                    elif char == ')':
                        parens -= 1
                    elif char == '{' and parens == 0:
                        return index
                return None
            start = body_start(stripped)
            buf = [stripped]
            j = i + 1
            while start is None and j < len(lines):
                buf.append(lines[j])
                start = body_start(lines[j])
                j += 1
            if start is None:
                raise RuntimeError(f'no body for {sig}')
            seg = buf[-1][start:]
            depth = seg.count('{') - seg.count('}')
            while depth > 0 and j < len(lines):
                l2 = lines[j]
                buf.append(l2)
                depth += l2.count('{') - l2.count('}')
                j += 1
            if depth != 0:
                raise RuntimeError(f'unbalanced braces for {sig}')
            body = '\n'.join(buf)
            # 缩进规整：统一去掉一层公共缩进
            body = re.sub(r'^    ', '', body, flags=re.M)
            out.append(body.rstrip())
    if not out:
        raise RuntimeError(f'method not found: {sig}')
    return '\n\n'.join(out)

parts = []
for t in TARGETS:
    parts.append(extract(t))
    print(f'extracted: {t} (x{parts[-1].count("func ")})')

extracted = '\n\n    // ===== 以下为 main.swift 逐字提取的真实方法体 =====\n\n' + '\n\n'.join(parts) + '\n'

TEMPLATE_HEAD = r'''import Foundation
import UniformTypeIdentifiers
import CryptoKit

// ============================================================
// MolStudio R01-R06 回归测试（第二轮复核报告回归）
// 测试对象：fusion-native/Sources/Ketcher3D/main.swift（生成时逐字提取）
// 中逐字提取的真实 AppDelegate 方法体（见下方"逐字提取"标记），
// 仅用替身替换 AppKit 面板 / WebKit 求值，不启动 GUI。
// ============================================================

let kPort = 8462
let kServerPy = "/fusion/server.py"
// CLI 探针运行于开发态；真实诊断方法也会读取原生壳的打包状态。
let kIsBundled = false

// MARK: 会话模型（与 main.swift 一致；仅作状态容器，被测逻辑都在提取的方法体里）
enum SessionMode: Equatable {
    case canvas
}

final class CanvasSession {
    var currentSnapshot: String = ""
    var hasSnapshot: Bool = false
    var savedBaseline: String = ""
    var fileURL: URL?
    var initialized: Bool = false
    var molExport: String?
    var smilesExport: String?
    var exportSnapshot: String?
    var saveGeneration = 0
    var dirty: Bool { hasSnapshot && currentSnapshot != savedBaseline }
}

enum PendingPayload {
    case none
    case newDocument
    case newPaperDocument(setup: WelcomePaperSetup)
    case openCanvasFile(text: String, url: URL)
    case restoreSession(text: String)
}
struct WelcomePaperSetup {
    var size = "Letter", orientation = "landscape"
    func toJSONString() -> String? {
        "{\"mode\":\"paper\",\"size\":\"\(size)\",\"orientation\":\"\(orientation)\"}"
    }
}
enum WelcomeDocumentMode: String { case canvas, paper }
enum WelcomeThumbnailCache {
    struct Stamp: Equatable {}
    static var writes = 0
    static let maxPNGBytes = 8 * 1024 * 1024
    static func stamp(_ url: URL) -> Stamp? { FileManager.default.fileExists(atPath:url.path) ? Stamp() : nil }
    static func validPNG(_ data: Data) -> Bool { !data.isEmpty }
    static func write(url: URL, directory: URL, expectedStamp: Stamp, mode: WelcomeDocumentMode, png: Data?) throws { writes += 1 }
    static func copy(from: URL, to: URL, directory: URL, renamed: Bool = false) {}
}

// MARK: AppKit / WebKit 替身
final class NSApplication {
    enum TerminateReply { case terminateCancel, terminateLater }
}
final class NSAppStub {
    static var replies: [Bool] = []
    static var terminates = 0
    static var monitor: ((NSEvent) -> NSEvent?)?
    static var stoppedModalCodes: [NSAlert.ReturnCode] = []
    func reply(toApplicationShouldTerminate allow: Bool) { NSAppStub.replies.append(allow) }
    func terminate(_ sender: Any?) { NSAppStub.terminates += 1 }
    func stopModal(withCode code: NSAlert.ReturnCode) {
        NSAppStub.stoppedModalCodes.append(code)
        NSAlert.nextResult = code
    }
}
var NSApp = NSAppStub()

final class NSAlertWindow {
    var orderedOut = false
    func orderOut(_ s: Any?) { orderedOut = true }
}
final class NSAlert {
    enum Style { case warning, informational }
    enum ReturnCode { case alertFirstButtonReturn, alertSecondButtonReturn, cancel }
    static var nextResult: ReturnCode = .cancel
    static var count = 0
    static var lastMessage = ""
    static var lastInformative = ""
    static var lastButtons: [String] = []
    static var onRun: (() -> Void)?
    var messageText = ""
    var informativeText = ""
    var alertStyle: Style = .warning
    var window = NSAlertWindow()
    func addButton(withTitle t: String) { NSAlert.lastButtons.append(t) }
    func runModal() -> ReturnCode {
        NSAlert.count += 1
        NSAlert.lastMessage = messageText
        NSAlert.lastInformative = informativeText
        NSAlert.onRun?()          // 模拟模态期间收到按键（Escape 接线测试）
        return NSAlert.nextResult
    }
}

// NSEvent / 模态替身：用于 Escape → "返回画布" 的接线测试
struct NSEventMask: OptionSet {
    let rawValue: UInt64
    init(rawValue: UInt64) { self.rawValue = rawValue }
    static let keyDown = NSEventMask(rawValue: 1 << 10)
}
final class NSEvent {
    var keyCode: Int = 0
    init(keyCode: Int = 0) { self.keyCode = keyCode }
    static func addLocalMonitorForEvents(matching: NSEventMask,
                                         handler: @escaping (NSEvent) -> NSEvent?) -> Any? {
        NSAppStub.monitor = handler
        return "monitor"
    }
    static func removeMonitor(_ m: Any) { NSAppStub.monitor = nil }
}

final class NSOpenPanel {
    enum Reply { case OK, cancel }
    static var chosen: URL?
    static var count = 0
    var directoryURL: URL?
    var allowedFileTypes: [String]?
    var allowedContentTypes: [UTType] = []
    var allowsMultipleSelection = false
    var canChooseDirectories = false
    var url: URL? { Self.chosen }
    func runModal() -> Reply {
        Self.count += 1
        return Self.chosen != nil ? .OK : .cancel
    }
}

class NSWindow {
    var title = ""
    var subtitle = ""
    var isVisible = true
    func orderOut(_ s: Any?) { isVisible = false }
    func makeKeyAndOrderFront(_ s: Any?) { isVisible = true }
}

final class StubTableView { var clickedRow = -1 }
final class StubWeb {
    var loaded: [String] = []
    func load(_ r: URLRequest) { loaded.append(r.url?.absoluteString ?? "?") }
}
// Native-canvas lifecycle stubs: the real methods are extracted verbatim from
// main.swift, so these only model the AppKit/Workspace objects they talk to.
final class StubCanvasHost {
    var coverVisible = true
    var feedbackMessages: [String] = []
    func showCanvasFeedback(message: String) { feedbackMessages.append(message) }
    var failureReasons: [String] = []
    func setNavigationCoverVisible(_ visible: Bool) { coverVisible = visible }
    func showNavigationFailure(reason: String? = nil, canSave: Bool = true) {
        coverVisible = true; failureReasons.append(reason ?? "")
    }
}
final class StubSplitVC { let canvasHostViewController = StubCanvasHost() }
struct WorkbenchLayerRequirements { var reactionSteps = false; var document = false; var agentTask = false }
final class StubWorkspaceCoordinator {
    var navigationGeneration = 0
    var attachedEpoch: String?
    var isAttaching = false
    func beginNavigation(generation: Int) { navigationGeneration = generation; attachedEpoch = nil }
    func detachCurrentEpoch() { attachedEpoch = nil }
    func attach(preparedSurfaces: [String], completion: @escaping (Bool) -> Void) { completion(true) }
    func abandonPendingAttach() { isAttaching = false }
}
final class Viewer3D {
    var subtitle: String = ""
    var warningText: String?
    var stereoNote: String?
}

final class NSSavePanel {
    enum Reply { case OK, cancel }
    static var chosen: URL?
    static var count = 0
    static var onRun: (() -> Void)?
    var directoryURL: URL?
    var nameFieldStringValue = ""
    var allowedFileTypes: [String]?
    var allowedContentTypes: [UTType] = []
    var url: URL? { Self.chosen }
    func runModal() -> Reply {
        Self.count += 1
        Self.onRun?()
        return Self.chosen != nil ? .OK : .cancel
    }
}

// MARK: 被测宿主（字段与 AppDelegate 同名同型；方法体逐字提取）
final class Probe {
    var window: NSWindow = NSWindow()
    var web = StubWeb()
    var welcomeWin: NSWindow?
    var fileTable: StubTableView?
    var fileList: [URL] = []
    var docsDir: URL! = URL(fileURLWithPath: "/tmp")
    var activeMode: SessionMode = .canvas
    var canvasSession = CanvasSession()
    var navigationGeneration = 1
    var openRequestGeneration = 0
    var pendingPayload: PendingPayload = .none
    var pendingGeneration = -1
    var navigationInFlight = false
    var pageUsable = true
    var pageQuarantined = false
    var navigationWatchdog: DispatchWorkItem?
    var terminatePending = false
    var workspaceCoordinator: StubWorkspaceCoordinator? = StubWorkspaceCoordinator()
    var workspaceSplitVC: StubSplitVC? = StubSplitVC()
    var workspaceAttachFallbackGeneration: Int?
    var coverLiftCount = 0
    func attachWorkspaceCoordinator() { coverLiftCount += 1 }
    func workbenchRequiredLayers(_ text: String) -> WorkbenchLayerRequirements { WorkbenchLayerRequirements() }
    func waitWorkbenchLayersReady(gen: Int, required: WorkbenchLayerRequirements, attemptsLeft: Int, _ done: @escaping (Bool, String) -> Void) { done(true, "") }
    var serverPython: String?
    var serverStderrTail = ""
    var cleanLayoutInFlight = false
    var cleanLayoutRequestGeneration = 0
    var thumbnailGeneration = 0
    let serverStderrLimit = 8000

    var statuses: [String] = []
    var alerts: [(String, String)] = []
    var welcomed = false
    var savedModes: [SessionMode] = []
    var saveResult = false

    var base: URL { URL(string: "http://127.0.0.1:\(kPort)")! }
    var session: CanvasSession { sessionOf(activeMode) }
    var appUserDefaults: UserDefaults { .standard }

    func updateTitle() {}
    func dbg(_ s: String) {}
    func setStatus(_ s: String) { statuses.append(s) }
    func alert(_ a: String, _ b: String) { alerts.append((a, b)) }
    func showWelcome() { welcomed = true }
    func post(_ path: String, data: String, done: @escaping ([String: Any]?) -> Void) {
        if deferPost { pendingPosts.append(done); return }
        done(postResult)
    }
    var postResult: [String: Any]?
    var deferPost = false
    var pendingPosts: [([String: Any]?) -> Void] = []
    var refreshCount = 0
    func refreshFileList() { refreshCount += 1 }
    var recentNoted: [URL] = []
    func noteRecentDocument(_ url: URL) { recentNoted.append(url); refreshFileList() }

    // jsValue 替身：脚本化页面快照与注入结果
    var deferClean = false
    var pendingClean: [(Any?, Bool) -> Void] = []
    var pageSnapshot: String?          // 完整画布快照
    var injectResultOK = true          // setMolecule 是否成功
    var injectReturnValue: Any? = "true"
    var injected: [String] = []
    var deferInject = false
    var pendingJS: [(Any?, Bool) -> Void] = []
    var deferSnapshot = false
    var pendingSnapshots: [(Any?, Bool) -> Void] = []
    var deferSavePair = false
    var pendingSavePairs: [(Any?, Bool) -> Void] = []
    var deferCapture = false
    var pendingCaptures: [(Any?, Bool) -> Void] = []
    var jsBodies: [String] = []
    var deferThumbnail = false
    var pendingThumbnails: [(Any?, Bool) -> Void] = []

    func jsValue(_ body: String, _ done: @escaping (Any?, Bool) -> Void) {
        jsBodies.append(body)
        if body.contains("k3dAPI.cleanLayout()") {
            if deferClean { pendingClean.append(done) }
            else { done(["ok": true, "message": "结构已整理"], true) }
            return
        }
        if body.contains("crypto.subtle.digest") {
            if deferThumbnail { pendingThumbnails.append(done) }
            else { done(["mode":"paper", "dataUrl":"data:image/png;base64,YQ=="], true) }
            return
        }
        if body.contains("k3dAPI?.workbenchReady") { done(true, true); return }
        // 2026-11-01 机理层：saveSession 改走 fetchCanvasSaveTexts（完整快照 + 写盘文本）
        if body.contains("const snap =") {
            if body.contains("mol: mol") {
                if deferCapture { pendingCaptures.append(done); return }
                let snap = pageSnapshot ?? ""
                done(["snap": snap, "mol": snap, "smi": snap], pageSnapshot != nil)
                return
            }
            if deferSavePair { pendingSavePairs.append(done); return }
            let snap = pageSnapshot ?? ""
            done(["snap": snap, "txt": snap], true)
            return
        }
        if body.contains("setMolecule") || body.contains("loadWorkbench") || body.contains("k3dAPI.document.init") {
            injected.append(body)
            if deferInject { pendingJS.append(done); return }
            done(injectReturnValue, injectResultOK)
            return
        }
        if deferSnapshot { pendingSnapshots.append(done); return }
        if let snap = pageSnapshot { done(snap, true) } else { done(nil, false) }
    }
    func flushInject() {
        let q = pendingJS
        pendingJS = []
        for d in q { d(injectReturnValue, injectResultOK) }
    }

'''

TEMPLATE_TAIL = r'''
}

// MARK: - 测试
var failed = 0
var total = 0
func check(_ name: String, _ cond: Bool, _ detail: String = "") {
    total += 1
    let mark = cond ? "PASS" : "FAIL"
    print("\(mark) | \(name)\(detail.isEmpty ? "" : " | " + detail)")
    if !cond { failed += 1 }
}
func resetStatics() {
    NSAppStub.monitor = nil
    NSAppStub.stoppedModalCodes = []
    NSAlert.lastInformative = ""
    NSAlert.lastButtons = []
    NSAlert.onRun = nil
    NSAppStub.replies = []
    NSAppStub.terminates = 0
    NSAlert.nextResult = .cancel
    NSAlert.count = 0
    NSAlert.lastMessage = ""
    NSOpenPanel.chosen = nil
    NSOpenPanel.count = 0
    NSSavePanel.chosen = nil
    NSSavePanel.count = 0
    NSSavePanel.onRun = nil
    UserDefaults.standard.removeObject(forKey: "lastFile")
    WelcomeThumbnailCache.writes = 0
}
func makeClean(_ s: CanvasSession, _ v: String, url: URL? = nil) {
    s.currentSnapshot = v; s.savedBaseline = v; s.hasSnapshot = true
    s.initialized = true; s.fileURL = url
}
func makeDirtyCanvas(_ s: CanvasSession) {
    s.currentSnapshot = "UNSAVED_CANVAS"; s.savedBaseline = "SAVED"; s.hasSnapshot = true
    s.initialized = true
    s.fileURL = URL(fileURLWithPath: "/tmp/r-fix/fixtures/A.ket")
}

let fixtureDir = ProcessInfo.processInfo.environment["OUT_DIR"] != nil
    ? ProcessInfo.processInfo.environment["OUT_DIR"]! + "/fixtures"
    : "/tmp/molstudio-regression/fixtures"
try? FileManager.default.createDirectory(atPath: fixtureDir, withIntermediateDirectories: true)
try! "B_CONTENT".write(toFile: fixtureDir + "/B.ket", atomically: true, encoding: .utf8)
try! "MECH_B".write(toFile: fixtureDir + "/B.mechdoc", atomically: true, encoding: .utf8)

// ---------- R1 ----------
print("---- R1 退出使用最新快照（R01）----")
do {
    // R1a：干净会话 → 编辑（最新快照≠缓存）→ 不跑轮询 → 退出 → 必须出现保存询问，不允许直接退出
    resetStatics()
    let p = Probe()
    makeClean(p.canvasSession, "SAVED")
    p.pageSnapshot = "JUST_EDITED"
    NSAlert.nextResult = .cancel
    _ = p.applicationShouldTerminate(NSApplication())
    check("R1a 出现保存询问", NSAlert.count == 1, "alerts=\(NSAlert.count)")
    check("R1a 退出被取消（不允许直接退出）", NSAppStub.replies == [false], "replies=\(NSAppStub.replies)")
    check("R1a 最新快照已提交进会话", p.canvasSession.currentSnapshot == "JUST_EDITED")
}
do {
    // R1b：不保存 → 允许退出
    resetStatics()
    let p = Probe()
    makeClean(p.canvasSession, "SAVED")
    p.pageSnapshot = "JUST_EDITED"
    NSAlert.nextResult = .alertSecondButtonReturn
    _ = p.applicationShouldTerminate(NSApplication())
    check("R1b 不保存 → 允许退出", NSAppStub.replies == [true], "replies=\(NSAppStub.replies)")
}
do {
    // R1c：用户选"保存"但写盘失败（目标目录不存在）→ 取消退出，仍停留在运行状态
    resetStatics()
    let p = Probe()
    makeClean(p.canvasSession, "SAVED")
    p.pageSnapshot = "JUST_EDITED"
    NSAlert.nextResult = .alertFirstButtonReturn
    NSSavePanel.chosen = URL(fileURLWithPath: "/tmp/r-fix/no-such-dir/out.ket")
    _ = p.applicationShouldTerminate(NSApplication())
    check("R1c 写盘失败 → 取消退出", NSAppStub.replies == [false], "replies=\(NSAppStub.replies)")
    check("R1c 未命名文档经另存为面板确定目标", NSSavePanel.count == 1, "panels=\(NSSavePanel.count)")
    check("R1c 失败时文件身份保持", p.canvasSession.savedBaseline == "SAVED")
}
do {
    // R1d：保存成功（真实写盘）→ 允许退出
    resetStatics()
    let p = Probe()
    makeClean(p.canvasSession, "SAVED")
    p.pageSnapshot = "JUST_EDITED"
    NSAlert.nextResult = .alertFirstButtonReturn
    let outURL = URL(fileURLWithPath: fixtureDir + "/OUT.ket")
    NSSavePanel.chosen = outURL
    try? FileManager.default.removeItem(at: outURL)
    _ = p.applicationShouldTerminate(NSApplication())
    check("R1d 保存成功 → 允许退出", NSAppStub.replies == [true], "replies=\(NSAppStub.replies)")
    check("R1d 文件真实写盘", FileManager.default.fileExists(atPath: outURL.path)
          && (try? String(contentsOf: outURL, encoding: .utf8)) == "JUST_EDITED")
    check("R1d 基线更新为本次写入内容", p.canvasSession.savedBaseline == "JUST_EDITED")
}
do {
    // R1e：读取失败（初始化过的会话）→ 取消退出并提示
    resetStatics()
    let p = Probe()
    makeClean(p.canvasSession, "SAVED")
    p.pageSnapshot = nil
    _ = p.applicationShouldTerminate(NSApplication())
    check("R1e 读取失败 → 取消退出", NSAppStub.replies == [false], "replies=\(NSAppStub.replies)")
    check("R1e 有可读错误提示", NSAlert.count > 0 && NSAlert.lastMessage.contains("无法检查未保存更改"),
          "count=\(NSAlert.count) msg=\(NSAlert.lastMessage)")
}
do {
    // R1e2：逃生阀 —— 用户明确放弃更改后退出（页面永久读不到时不能只留强制退出）
    resetStatics()
    let p = Probe()
    makeClean(p.canvasSession, "SAVED")
    p.pageSnapshot = nil
    NSAlert.nextResult = .alertSecondButtonReturn
    _ = p.applicationShouldTerminate(NSApplication())
    check("R1e2 明确放弃 → 放行退出", NSAppStub.replies == [true], "replies=\(NSAppStub.replies)")
}
do {
    // R1f：未初始化（启动空页）读取失败 → 放行退出（避免启动失败锁死退出）
    resetStatics()
    let p = Probe()
    p.pageSnapshot = nil
    _ = p.applicationShouldTerminate(NSApplication())
    check("R1f 未初始化+读取失败 → 放行", NSAppStub.replies == [true], "replies=\(NSAppStub.replies)")
}


// ---------- R2 ----------
print("---- R2 导航事务门闸与固定拷贝（R02）----")

// ---------- R3 ----------
print("---- R3 打开文件确认目标会话（R03）----")


do {
    // R3c：当前=目标 → 只问一次
    resetStatics()
    let p = Probe()
    makeDirtyCanvas(p.canvasSession)
    p.activeMode = .canvas
    p.pageSnapshot = "UNSAVED_CANVAS"
    NSOpenPanel.chosen = URL(fileURLWithPath: fixtureDir + "/B.ket")
    NSAlert.nextResult = .cancel
    p.actOpen()
    check("R3c 同模式打开只询问 1 次", NSAlert.count == 1, "prompts=\(NSAlert.count)")
    check("R3c 取消 → 未导航", p.web.loaded.isEmpty)
}


do {
    // R3f：文件列表入口（actOpenSelected）走同一入口并确认目标会话
    resetStatics()
    let p = Probe()
    makeDirtyCanvas(p.canvasSession)
    p.activeMode = .canvas
    p.pageSnapshot = "UNSAVED_CANVAS"
    p.fileList = [URL(fileURLWithPath: fixtureDir + "/B.ket")]
    let t = StubTableView(); t.clickedRow = 0; p.fileTable = t
    NSAlert.nextResult = .cancel
    p.actOpenSelected()
    check("R3f 文件列表入口 → 目标会话被询问 1 次", NSAlert.count == 1, "prompts=\(NSAlert.count)")
    check("R3f 取消 → 未导航", p.web.loaded.isEmpty)
}

// ---------- R4 ----------
print("---- R4 读取失败不放行破坏性操作（R04）----")
do {
    // R4a：initialized 会话 fetchSnapshot 返回 nil → 关闭/新建/打开/退出全部不放行
    resetStatics()
    let p = Probe()
    makeClean(p.canvasSession, "SAVED")
    p.pageSnapshot = nil
    let closeOK = p.windowShouldClose(p.window)
    check("R4a 关闭：确认不放行", closeOK == false && p.welcomed == false
          && NSAlert.count > 0 && NSAlert.lastMessage.contains("无法确认"),
          "returned=\(closeOK) welcomed=\(p.welcomed) msg=\(NSAlert.lastMessage)")
    p.actNewDocument()
    check("R4a 新建：不放行（未导航）", p.web.loaded.isEmpty, "loaded=\(p.web.loaded)")
    NSOpenPanel.chosen = URL(fileURLWithPath: fixtureDir + "/B.ket")
    p.actOpen()
    check("R4a 打开：不放行（未导航）", p.web.loaded.isEmpty, "loaded=\(p.web.loaded)")
    _ = p.applicationShouldTerminate(NSApplication())
    check("R4a 退出：不放行", NSAppStub.replies == [false], "replies=\(NSAppStub.replies)")
}
do {
    // R4b：未初始化会话（启动空页）读取失败 → 放行，避免启动失败后连退出都被锁死
    resetStatics()
    let p = Probe()
    p.pageSnapshot = nil
    let closeOK = p.windowShouldClose(p.window)
    check("R4b 未初始化：关闭放行（回到欢迎页）", closeOK == false && p.welcomed == true
          && p.alerts.isEmpty, "returned=\(closeOK) welcomed=\(p.welcomed)")
    _ = p.applicationShouldTerminate(NSApplication())
    check("R4b 未初始化：退出放行", NSAppStub.replies == [true], "replies=\(NSAppStub.replies)")
    p.actNewDocument()
    check("R4b 未初始化：新建放行", p.web.loaded.last?.contains("canvas.html") == true)
}


// ---------- 关闭后回到欢迎页：会话必须真正结束 ----------
print("---- C 关闭文档后的保存确认回归 ----")
do {
    resetStatics()
    let p = Probe()
    makeDirtyCanvas(p.canvasSession)
    p.pageSnapshot = "UNSAVED_CANVAS"
    p.canvasSession.molExport = "OLD_MOL"
    p.canvasSession.smilesExport = "OLD_SMILES"
    p.canvasSession.exportSnapshot = "UNSAVED_CANVAS"
    p.welcomeWin = NSWindow()
    let gen = p.navigationGeneration
    NSAlert.nextResult = .alertSecondButtonReturn
    _ = p.windowShouldClose(p.window)
    check("C1 不保存关闭只确认一次并返回欢迎页", NSAlert.count == 1 && p.welcomed && !p.window.isVisible)
    let s = p.canvasSession
    check("C1 已关闭会话清除内容、文件身份和导出缓存",
          !s.initialized && !s.hasSnapshot && s.currentSnapshot.isEmpty && s.savedBaseline.isEmpty
          && s.fileURL == nil && s.molExport == nil && s.smilesExport == nil && s.exportSnapshot == nil)
    check("C1 关闭隔离旧页面并作废回调", !p.pageUsable && p.pageQuarantined && p.navigationGeneration > gen)
    p.pollActiveSnapshot()
    check("C1 后台轮询不会复活旧文档", !p.canvasSession.hasSnapshot)
    _ = p.windowShouldClose(p.welcomeWin!)
    check("C1 关闭欢迎页请求退出", NSAppStub.terminates == 1)
    _ = p.applicationShouldTerminate(NSApplication())
    check("C1 退出不再重复询问旧文档", NSAlert.count == 1 && NSAppStub.replies == [true])
}
do {
    resetStatics()
    let p = Probe()
    makeDirtyCanvas(p.canvasSession)
    p.pageSnapshot = "UNSAVED_CANVAS"
    NSAlert.nextResult = .alertSecondButtonReturn
    _ = p.windowShouldClose(p.window)
    NSAlert.nextResult = .cancel
    p.actNewDocument()
    check("C2 关闭后新建无需重复确认", NSAlert.count == 1 && p.web.loaded.count == 1)
    p.pageSnapshot = "EMPTY"
    p.applyPending(mode: .canvas, gen: p.navigationGeneration)
    p.pageSnapshot = "NEW_EDIT"
    _ = p.windowShouldClose(p.window)
    check("C2 新文档有修改仍会正常询问且取消后保留", NSAlert.count == 2 && p.window.isVisible
          && p.canvasSession.currentSnapshot == "NEW_EDIT" && p.canvasSession.dirty)
}
do {
    resetStatics()
    let p = Probe()
    makeDirtyCanvas(p.canvasSession)
    p.pageSnapshot = "UNSAVED_CANVAS"
    NSAlert.nextResult = .alertSecondButtonReturn
    _ = p.windowShouldClose(p.window)
    NSAlert.nextResult = .cancel
    p.openDocument(at: URL(fileURLWithPath: fixtureDir + "/B.ket"))
    check("C3 关闭后打开文件无需重复确认", NSAlert.count == 1 && p.web.loaded.count == 1)
    p.pageSnapshot = "OPENED_B"
    p.applyPending(mode: .canvas, gen: p.navigationGeneration)
    _ = p.windowShouldClose(p.window)
    check("C3 新打开的文件未修改直接关闭", NSAlert.count == 1 && !p.window.isVisible)
}
do {
    resetStatics()
    let p = Probe()
    makeDirtyCanvas(p.canvasSession)
    p.pageSnapshot = "UNSAVED_CANVAS"
    p.deferSnapshot = true
    p.pollActiveSnapshot() // 关闭前发出的轮询，关闭后才返回
    p.deferSnapshot = false
    NSAlert.nextResult = .alertSecondButtonReturn
    _ = p.windowShouldClose(p.window)
    for done in p.pendingSnapshots { done("UNSAVED_CANVAS", true) }
    check("C4 迟到的轮询不能恢复已丢弃的内容", !p.canvasSession.hasSnapshot && !p.canvasSession.dirty)
}
do {
    resetStatics()
    let p = Probe()
    makeDirtyCanvas(p.canvasSession)
    p.pageSnapshot = "UNSAVED_CANVAS"
    NSAlert.nextResult = .cancel
    _ = p.windowShouldClose(p.window)
    check("C5 取消关闭保留会话和页面", p.canvasSession.dirty && p.pageUsable && !p.welcomed && p.window.isVisible)
    NSAlert.nextResult = .alertFirstButtonReturn
    NSSavePanel.chosen = nil
    p.canvasSession.fileURL = nil
    _ = p.windowShouldClose(p.window)
    check("C5 取消保存面板保留会话和页面", p.canvasSession.dirty && p.pageUsable && !p.welcomed)
}

do {
    resetStatics()
    let p = Probe()
    makeDirtyCanvas(p.canvasSession)
    p.canvasSession.fileURL = nil
    p.pageSnapshot = "SAVE_ON_CLOSE"
    let out = URL(fileURLWithPath: fixtureDir + "/CLOSE.ket")
    NSSavePanel.chosen = out
    NSAlert.nextResult = .alertFirstButtonReturn
    _ = p.windowShouldClose(p.window)
    check("C7 选择保存后实际写盘才结束会话", (try? String(contentsOf: out, encoding: .utf8)) == "SAVE_ON_CLOSE"
          && p.welcomed && !p.canvasSession.initialized && !p.pageUsable)
    _ = p.applicationShouldTerminate(NSApplication())
    check("C7 保存后关闭也不会重复提示", NSAlert.count == 1 && NSAppStub.replies == [true])
}
do {
    resetStatics()
    let p = Probe()
    makeDirtyCanvas(p.canvasSession)
    p.canvasSession.fileURL = URL(fileURLWithPath: "/dev/null/close.ket")
    p.pageSnapshot = "UNSAVED_CANVAS"
    NSAlert.nextResult = .alertFirstButtonReturn
    _ = p.windowShouldClose(p.window)
    check("C8 写盘失败不能结束会话", p.canvasSession.dirty && p.canvasSession.initialized
          && p.window.isVisible && !p.welcomed && p.pageUsable && !p.alerts.isEmpty)
}

// ---------- R5 ----------
print("---- R5 未收敛警告显示（R05）----")
do {
    resetStatics()
    let p = Probe()
    let resp: [String: Any] = [
        "ok": true, "molblock": "MOLBLOCK",
        "warnings": ["片段2（CCO）: UFF 力场优化未在 1000 次迭代内收敛，构象可能未达到能量极小"],
    ]
    let w = p.gen3dWarningText(resp)
    check("R5a 有 warnings → 文案包含'未收敛'与片段说明",
          w != nil && w!.contains("未收敛") && w!.contains("片段2（CCO）"), "w=\(w as Any)")
    let win = Viewer3D()
    p.applyGen3DWarning(win, w)
    check("R5a 警告写入 3D 窗口副标题", win.subtitle.contains("未收敛") && win.subtitle.contains("片段2（CCO）"),
          "subtitle=\(win.subtitle)")
    check("R5a 警告写入状态区字符串（同一文案对象）", w == win.subtitle)
}
do {
    resetStatics()
    let p = Probe()
    let noWarn = p.gen3dWarningText(["ok": true, "molblock": "MOLBLOCK"])
    check("R5b 无 warnings → nil（不显示）", noWarn == nil)
    let win = Viewer3D()
    win.subtitle = "旧文字"
    p.applyGen3DWarning(win, noWarn)
    check("R5b 无警告 → 副标题清空", win.subtitle == "")
    let failResp = p.gen3dWarningText(["ok": false, "error": "生成失败"])
    check("R5b 失败响应无 warnings 字段 → nil", failResp == nil)
    let empty = p.gen3dWarningText(["ok": true, "warnings": [String]()])
    check("R5b 空 warnings 列表 → nil", empty == nil)
}

do {
    resetStatics()
    let p = Probe()
    // 2026-11-01 芳香正离子：转换补氢说明必须显示，且不能冒充"未收敛"
    let notesOnly: [String: Any] = [
        "ok": true, "molblock": "MOLBLOCK",
        "notes": ["芳香环上第 1 个碳带正电且未标氢，已按芳香价态补 1 个隐含氢（C3H3+）；画布结构未改动"],
    ]
    let w = p.gen3dWarningText(notesOnly)
    check("R5c notes → 文案包含'说明：'与补氢内容",
          w != nil && w!.contains("说明：") && w!.contains("C3H3+"), "w=\(w as Any)")
    check("R5c notes 不写成'未收敛'", w != nil && !w!.contains("未收敛"), "w=\(w as Any)")
    let win2 = Viewer3D()
    p.applyGen3DWarning(win2, w)
    check("R5c 说明写入 3D 窗口副标题", win2.subtitle.contains("说明："), "subtitle=\(win2.subtitle)")
    let both: [String: Any] = ["ok": true, "notes": ["补氢说明"], "warnings": ["片段2（CCO）: 未收敛"]]
    let w2 = p.gen3dWarningText(both)
    check("R5c notes 与 warnings 同时显示",
          w2 != nil && w2!.contains("说明：") && w2!.contains("未收敛："), "w2=\(w2 as Any)")
}

// ---------- R6 ----------
print("---- R6 服务 stderr 诊断（R06）----")
do {
    resetStatics()
    let p = Probe()
    p.serverPython = "/Users/tiger/venvs/plain/bin/python"
    p.serverStderrTail = """
    Traceback (most recent call last):
      File "server.py", line 20, in <module>
        from rdkit import Chem
    ModuleNotFoundError: No module named 'rdkit'
    """
    let msg = p.serverFailureDiagnostics(reason: "本地化学服务进程在启动期间退出（退出码 1）。")
    check("R6a 诊断包含 RDKit", msg.contains("RDKit") && msg.contains("缺 RDKit"), "msg=\(msg.prefix(200))")
    check("R6a 诊断包含解释器路径", msg.contains("/Users/tiger/venvs/plain/bin/python"))
    check("R6a 诊断给出处置（pip install rdkit / 换解释器）",
          msg.contains("pip install rdkit") && msg.contains("换用含 RDKit 的解释器"))
    check("R6a 诊断包含原始 stderr", msg.contains("ModuleNotFoundError"))
    p.serverStderrTail = "SomeOtherError: something else broke"
    let noRd = p.serverFailureDiagnostics(reason: "x")
    check("R6a stderr 无 rdkit 错误时不下 RDKit 结论",
          !(noRd.contains("缺 RDKit")) && noRd.contains("排查建议"))
    p.serverStderrTail = ""
    let empty = p.serverFailureDiagnostics(reason: "y")
    check("R6a stderr 为空时明说没有输出", empty.contains("没有输出错误信息"))
}
do {
    resetStatics()
    let p = Probe()
    let big = String(repeating: "x", count: 20000) + "END-MARKER"
    p.appendServerStderr(big)
    check("R6b stderr 限长（≤ 上限）", p.serverStderrTail.count <= 8000,
          "len=\(p.serverStderrTail.count)")
    check("R6b 保留尾部", p.serverStderrTail.hasSuffix("END-MARKER"))
}
do {
    resetStatics()
    let p = Probe()
    let msg = p.pythonRuntimeMissingMessage(tried: ["/usr/bin/python3"])
    check("R6c 旧的不准确文案已移除", !msg.contains("会在使用化学功能时体现"))
    check("R6c 新文案说明启动即导入 RDKit", msg.contains("import rdkit") && msg.contains("直接退出"))
    check("R6c 提示包含已尝试的解释器", msg.contains("/usr/bin/python3"))
}

print("---- R7 导航失败出口 / 页面不可用降级（父代理 2026-11-01 补）----")
do {
    // R7a：页面不可用（载入失败/崩溃）但会话脏 → 退出仍按内存快照询问保存，而不是"读不到"卡死
    resetStatics()
    let p = Probe()
    makeDirtyCanvas(p.canvasSession)
    p.pageUsable = false
    _ = p.applicationShouldTerminate(NSApplication())
    check("R7a 页面不可用仍会询问保存", NSAlert.count == 1 && NSAlert.lastMessage.contains("更改吗"),
          "count=\(NSAlert.count) msg=\(NSAlert.lastMessage)")
    check("R7a 未静默放行", NSAppStub.replies == [false], "replies=\(NSAppStub.replies)")
}
do {
    // R7b：页面不可用且干净 → 直接放行退出
    resetStatics()
    let p = Probe()
    makeClean(p.canvasSession, "SAVED")
    p.pageUsable = false
    _ = p.applicationShouldTerminate(NSApplication())
    check("R7b 页面不可用+干净 → 放行退出", NSAppStub.replies == [true], "replies=\(NSAppStub.replies)")
}
do {
    // R7c：abortNavigation 必须释放门闸（失败不能把事务永久关着）
    resetStatics()
    let p = Probe()
    p.navigationInFlight = true
    p.pageUsable = true
    p.abortNavigation(reason: "模拟载入失败")
    check("R7c 失败后门闸释放", p.navigationInFlight == false)
    check("R7c 页面标为不可用", p.pageUsable == false)
    check("R7c 给出重新载入入口", NSAlert.count == 1 && NSAlert.lastMessage.contains("页面未能载入"),
          "count=\(NSAlert.count) msg=\(NSAlert.lastMessage)")
}
do {
    // R7d：页面不可用时轮询不得把空页提交进会话（降级不能变成新的污染源）
    resetStatics()
    let p = Probe()
    makeDirtyCanvas(p.canvasSession)
    p.pageSnapshot = "EMPTY_PAGE"
    p.pageUsable = false
    p.pollActiveSnapshot()
    check("R7d 页面不可用不提交轮询结果", p.canvasSession.currentSnapshot == "UNSAVED_CANVAS",
          "snap=\(p.canvasSession.currentSnapshot)")
}
do {
    // R7e：页面不可用时离开确认走内存快照（不误报"读取失败"）
    resetStatics()
    let p = Probe()
    makeDirtyCanvas(p.canvasSession)
    p.pageUsable = false
    var allowed: Bool?
    p.confirmDiscard { allowed = $0 }
    check("R7e 页面不可用仍按内存快照询问", NSAlert.count == 1 && NSAlert.lastMessage.contains("要保存对"),
          "count=\(NSAlert.count) msg=\(NSAlert.lastMessage)")
    check("R7e 取消则不放行", allowed == false, "allowed=\(String(describing: allowed))")
}
do {
    // R7f：fetchSnapshot 在页面不可用时返回内存快照（保存/退出依赖它）
    resetStatics()
    let p = Probe()
    makeDirtyCanvas(p.canvasSession)
    p.pageSnapshot = nil
    p.pageUsable = false
    var snap: String?
    p.fetchSnapshot(.canvas) { snap = $0 }
    check("R7f 页面不可用 → 内存快照", snap == "UNSAVED_CANVAS", "snap=\(String(describing: snap))")
}

print("---- S01 终止事务必须作废迟到回调（第二次复核）----")
do {
    // S01a：延迟注入 → abort（选“稍后”）→ 迟到成功：不得提交文件身份/基线，页面保持不可用
    resetStatics()
    let p = Probe()
    p.canvasSession.currentSnapshot = "UNSAVED_A"
    p.canvasSession.savedBaseline = "SAVED_A"
    p.canvasSession.hasSnapshot = true
    p.canvasSession.initialized = true
    p.canvasSession.fileURL = URL(fileURLWithPath: "/tmp/A.ket")
    p.deferInject = true
    p.startNavigation(to: .canvas, pending: .openCanvasFile(text: "B_CONTENT", url: URL(fileURLWithPath: "/tmp/B.ket")))
    p.applyPending(mode: .canvas, gen: p.navigationGeneration)
    check("S01a 注入已延迟", p.pendingJS.count == 1, "pending=\(p.pendingJS.count)")
    p.abortNavigation(reason: "模拟超时")            // NSAlert 默认 cancel = “稍后”
    p.flushInject()                                   // 迟到的 setMolecule 成功回调
    check("S01a 迟到回调不改文件身份", p.canvasSession.fileURL?.lastPathComponent == "A.ket",
          "url=\(String(describing: p.canvasSession.fileURL?.lastPathComponent))")
    check("S01a 快照与基线原样", p.canvasSession.currentSnapshot == "UNSAVED_A"
          && p.canvasSession.savedBaseline == "SAVED_A",
          "cur=\(p.canvasSession.currentSnapshot) base=\(p.canvasSession.savedBaseline)")
    check("S01a 页面保持不可用", p.pageUsable == false && p.navigationInFlight == false)
    check("S01a 页面被隔离", p.pageQuarantined == true)
    check("S01a 未显示已打开", !p.statuses.contains { $0.hasPrefix("已打开") }, "statuses=\(p.statuses)")
    check("S01a 未登记 lastFile", UserDefaults.standard.string(forKey: "lastFile") == nil)
}
do {
    // S01b：abort 后启动新导航，旧回调到达不得结束新事务
    resetStatics()
    let p = Probe()
    p.deferInject = true
    p.startNavigation(to: .canvas, pending: .openCanvasFile(text: "B", url: URL(fileURLWithPath: "/tmp/B.ket")))
    p.applyPending(mode: .canvas, gen: p.navigationGeneration)
    p.abortNavigation(reason: "模拟超时")
    p.startNavigation(to: .canvas, pending: .restoreSession(text: "X"))
    p.flushInject()
    check("S01b 旧回调不影响新事务", p.navigationInFlight == true)
    check("S01b 新事务未被提前提交", p.pageUsable == false)
    check("S01b 新导航解除隔离", p.pageQuarantined == false)
}

print("---- S02 导出缓存与当前快照必须同版（第二次复核）----")
let s02Dir = fixtureDir + "/s02"
try? FileManager.default.createDirectory(atPath: s02Dir, withIntermediateDirectories: true)
do {
    // S02a：旧缓存 + 新 KET + 页面不可用 → 拒绝写盘，保留 dirty
    resetStatics()
    let p = Probe()
    p.canvasSession.currentSnapshot = "NEW_KET"
    p.canvasSession.savedBaseline = "OLD_KET"
    p.canvasSession.hasSnapshot = true
    p.canvasSession.initialized = true
    p.canvasSession.molExport = "OLD_MOL"
    p.canvasSession.exportSnapshot = "OLD_KET"
    p.pageUsable = false
    let path = s02Dir + "/a.mol"
    try? FileManager.default.removeItem(atPath: path)
    NSSavePanel.chosen = URL(fileURLWithPath: path)
    var ok: Bool?
    p.saveSession(.canvas, forceSaveAs: false) { ok = $0 }
    check("S02a 版本不一致拒绝保存", ok == false)
    check("S02a 没有写盘", !FileManager.default.fileExists(atPath: path))
    check("S02a dirty 保留", p.canvasSession.dirty == true)
}
do {
    // S02b：缓存与当前快照同版 → 正常保存
    resetStatics()
    let p = Probe()
    p.canvasSession.currentSnapshot = "NEW_KET"
    p.canvasSession.savedBaseline = "OLD_KET"
    p.canvasSession.hasSnapshot = true
    p.canvasSession.initialized = true
    p.canvasSession.molExport = "NEW_MOL"
    p.canvasSession.exportSnapshot = "NEW_KET"
    p.pageUsable = false
    let path = s02Dir + "/b.mol"
    try? FileManager.default.removeItem(atPath: path)
    NSSavePanel.chosen = URL(fileURLWithPath: path)
    var ok: Bool?
    p.saveSession(.canvas, forceSaveAs: false) { ok = $0 }
    check("S02b 同版缓存可保存", ok == true)
    check("S02b 写的是缓存内容", (try? String(contentsOfFile: path, encoding: .utf8)) == "NEW_MOL")
    check("S02b 基线更新为当前快照", p.canvasSession.savedBaseline == "NEW_KET")
}
do {
    // S02c：没有导出缓存 → 明确失败
    resetStatics()
    let p = Probe()
    p.canvasSession.currentSnapshot = "NEW_KET"
    p.canvasSession.hasSnapshot = true
    p.canvasSession.initialized = true
    p.pageUsable = false
    let path = s02Dir + "/c.smi"
    try? FileManager.default.removeItem(atPath: path)
    NSSavePanel.chosen = URL(fileURLWithPath: path)
    var ok: Bool?
    p.saveSession(.canvas, forceSaveAs: false) { ok = $0 }
    check("S02c 无缓存明确失败", ok == false && !FileManager.default.fileExists(atPath: path))
}
do {
    // S02d：KET 保存不受导出缓存限制（用内存最新内容）
    resetStatics()
    let p = Probe()
    p.canvasSession.currentSnapshot = "NEW_KET"
    p.canvasSession.hasSnapshot = true
    p.canvasSession.initialized = true
    p.canvasSession.molExport = "OLD_MOL"
    p.canvasSession.exportSnapshot = "OLD_KET"
    p.pageUsable = false
    let path = s02Dir + "/d.ket"
    try? FileManager.default.removeItem(atPath: path)
    NSSavePanel.chosen = URL(fileURLWithPath: path)
    var ok: Bool?
    p.saveSession(.canvas, forceSaveAs: false) { ok = $0 }
    check("S02d KET 用内存最新内容", ok == true
          && (try? String(contentsOfFile: path, encoding: .utf8)) == "NEW_KET")
}

do {
    // S02e：.sdf 走同一分支 —— 同版缓存可以保存
    resetStatics()
    let p = Probe()
    p.canvasSession.currentSnapshot = "NEW_KET"
    p.canvasSession.hasSnapshot = true
    p.canvasSession.initialized = true
    p.canvasSession.molExport = "NEW_SDF"
    p.canvasSession.exportSnapshot = "NEW_KET"
    p.pageUsable = false
    let path = s02Dir + "/e.sdf"
    try? FileManager.default.removeItem(atPath: path)
    NSSavePanel.chosen = URL(fileURLWithPath: path)
    var ok: Bool?
    p.saveSession(.canvas, forceSaveAs: false) { ok = $0 }
    check("S02e .sdf 同版缓存可保存", ok == true
          && (try? String(contentsOfFile: path, encoding: .utf8)) == "NEW_SDF")
}
do {
    // S02f：.smiles 用 smilesExport，旧版缓存必须拒绝
    resetStatics()
    let p = Probe()
    p.canvasSession.currentSnapshot = "NEW_KET"
    p.canvasSession.savedBaseline = "OLD_KET"
    p.canvasSession.hasSnapshot = true
    p.canvasSession.initialized = true
    p.canvasSession.smilesExport = "OLD_SMILES"
    p.canvasSession.exportSnapshot = "OLD_KET"
    p.pageUsable = false
    let path = s02Dir + "/f.smiles"
    try? FileManager.default.removeItem(atPath: path)
    NSSavePanel.chosen = URL(fileURLWithPath: path)
    var ok: Bool?
    p.saveSession(.canvas, forceSaveAs: false) { ok = $0 }
    check("S02f .smiles 旧缓存拒绝", ok == false && !FileManager.default.fileExists(atPath: path))
}


// ---- 立体整理 / 3D 提示（2026-11-01） ----
do {
    // T1 提示文案：只列非零项，不把已指定的部分说成未确定
    let p = Probe()
    let r: [String: Any] = ["summary": [
        "tetrahedral": ["unspecified": 2, "unknown": 0, "specified": 1],
        "double": ["unspecified": 1, "unknown": 0, "specified": 0],
        "groups": ["or": 0, "and": 0, "abs": 2]]]
    let msg = p.stereoPromptMessage(r)
    check("T1 文案列出四面体与双键",
          msg.contains("2 个四面体中心") && msg.contains("1 处双键构型"), msg)
    check("T1 文案说明示例只是可能结果", msg.contains("示例只是一种可能结果"))
    check("T1 无立体组时不提混合物", !msg.contains("立体组信息"))
}
do {
    // T2 只有双键问题：不引导用户去画四面体楔键
    let p = Probe()
    let r: [String: Any] = ["summary": [
        "tetrahedral": ["unspecified": 0, "unknown": 0],
        "double": ["unspecified": 1, "unknown": 0],
        "groups": ["or": 0, "and": 0]]]
    let msg = p.stereoPromptMessage(r)
    check("T2 只提双键", msg.contains("1 处双键构型") && !msg.contains("四面体"), msg)
}
do {
    // T3 AND / OR 组语义单独说明
    let p = Probe()
    let r: [String: Any] = ["summary": [
        "tetrahedral": ["unspecified": 0, "unknown": 0],
        "double": ["unspecified": 0, "unknown": 0],
        "groups": ["or": 1, "and": 0]]]
    let msg = p.stereoPromptMessage(r)
    check("T3 立体组文案", msg.contains("立体组信息") && msg.contains("仅展示一个代表"), msg)
    check("T3 无中心时也给正文", !msg.isEmpty)
}
do {
    // T4 未知（波浪键）也算未确定
    let p = Probe()
    let r: [String: Any] = ["summary": [
        "tetrahedral": ["unspecified": 0, "unknown": 1],
        "double": ["unspecified": 0, "unknown": 0],
        "groups": ["or": 0, "and": 0]]]
    check("T4 显式未知计入提示", p.stereoPromptMessage(r).contains("1 个四面体中心"))
}
do {
    // T5 窗口标识：普通未指定 vs 立体组；非示例不显示
    let p = Probe()
    let plain: [String: Any] = ["example": true, "groups": ["or": 0, "and": 0], "molecules": ["分子 1"]]
    check("T5 普通示例标识", p.stereoBadgeText(plain) == "示例构型 · 原图未指定立体",
          p.stereoBadgeText(plain) ?? "nil")
    let grp: [String: Any] = ["example": true, "groups": ["or": 1, "and": 0], "molecules": ["分子 1"]]
    check("T5 立体组标识", p.stereoBadgeText(grp) == "示例构型 · 输入含相对构型或混合物信息",
          p.stereoBadgeText(grp) ?? "nil")
    check("T5 非示例无标识", p.stereoBadgeText(["example": false]) == nil)
    check("T5 无数据无标识", p.stereoBadgeText(nil) == nil)
    let multi: [String: Any] = ["example": true, "groups": ["or": 0, "and": 0],
                                "molecules": ["分子 2", "分子 3"]]
    let badge = p.stereoBadgeText(multi, moleculeCount: 3)
    check("T5 多分子同窗标出示例分子",
          (badge ?? "").contains("分子 2、分子 3 为示例构型"), badge ?? "nil")
    check("T5 单分子窗口不加分子列表", !(p.stereoBadgeText(multi, moleculeCount: 1) ?? "").contains("为示例构型"))
}
do {
    // T6 选择框：默认按钮是"返回画布"，且按钮顺序固定
    resetStatics()
    let p = Probe()
    NSAlert.nextResult = .alertFirstButtonReturn
    let pick = p.confirmStereoExample(nil)
    check("T6 默认返回画布", pick == false)
    check("T6 第一个按钮是返回画布", NSAlert.lastButtons.first == "返回画布",
          NSAlert.lastButtons.joined(separator: "|"))
    check("T6 第二个按钮是查看一个示例",
          NSAlert.lastButtons.count == 2 && NSAlert.lastButtons[1] == "查看一个示例",
          NSAlert.lastButtons.joined(separator: "|"))
    check("T6 标题固定", NSAlert.lastMessage == "部分立体构型尚未确定", NSAlert.lastMessage)
}
do {
    // T7 选择"查看一个示例"
    resetStatics()
    let p = Probe()
    NSAlert.nextResult = .alertSecondButtonReturn
    check("T7 选择查看示例", p.confirmStereoExample(nil) == true)
}
do {
    // T8 Escape 等价于"返回画布"（不能默认接受示例）
    resetStatics()
    let p = Probe()
    NSAlert.nextResult = .alertSecondButtonReturn   // 若 Escape 没被接管，会落到"查看示例"
    NSAlert.onRun = {
        if let m = NSAppStub.monitor { _ = m(NSEvent(keyCode: 53)) }
    }
    let pick = p.confirmStereoExample(nil)
    check("T8 Escape 回到返回画布", pick == false)
    check("T8 Escape 触发首选按钮", NSAppStub.stoppedModalCodes.contains(.alertFirstButtonReturn),
          "\(NSAppStub.stoppedModalCodes)")
    check("T8 结束后移除监听器", NSAppStub.monitor == nil)
}
do {
    // T9 整理结果提示：成功只写状态；未选分子与失败分别提示
    resetStatics()
    let p = Probe()
    p.reportLayoutResult(["ok": true, "message": "结构已整理"])
    check("T9 成功只更新状态", p.statuses.last == "结构已整理" && p.alerts.isEmpty)
    p.reportLayoutResult(["ok": false, "code": "no_molecule", "message": "请选择要整理的分子"])
    check("T9 未选分子提示", p.alerts.last?.0 == "请选择要整理的分子", "\(String(describing: p.alerts.last))")
    p.reportLayoutResult(["ok": false, "code": "layout_failed", "message": "整理会改变立体构型，已取消"])
    check("T9 失败提示未应用",
          p.alerts.last?.0 == "整理未应用" && p.alerts.last?.1 == "整理会改变立体构型，已取消")
    p.reportLayoutResult(["ok": false, "code": "stale", "message": "画布内容已改变，本次整理未应用"])
    check("T9 陈旧结果不当作成功", p.alerts.last?.0 == "整理未应用")
}

do {
    resetStatics()
    let p = Probe()
    p.workspaceSplitVC = StubSplitVC()
    p.deferClean = true
    p.actClean()
    p.actClean()
    check("T10 连续点击仅发送一次整理", p.pendingClean.count == 1 && p.cleanLayoutInFlight)
    check("T10 整理开始显示原生进度", p.workspaceSplitVC?.canvasHostViewController.feedbackMessages.last == "正在整理结构…")
    let complete = p.pendingClean.removeFirst()
    complete(["ok": true, "unchanged": true], true)
    check("T10 完成后允许再次整理", !p.cleanLayoutInFlight)
    check("T10 无需调整也显示明确结果", p.workspaceSplitVC?.canvasHostViewController.feedbackMessages.last == "结构已整齐，位置与画法保持不变")
    p.actClean()
    let old = p.pendingClean.removeFirst()
    p.navigationGeneration += 1
    p.invalidateCleanLayoutRequest()
    check("T10 导航作废旧请求并恢复整理", !p.cleanLayoutInFlight)
    p.actClean()
    let newRequest = p.pendingClean.removeFirst()
    let statusCount = p.statuses.count
    old(["ok": true, "message": "OLD"], true)
    check("T10 旧回调不能清除新请求忙状态", p.cleanLayoutInFlight)
    check("T10 旧回调不能显示到新页面", p.statuses.count == statusCount && p.workspaceSplitVC?.canvasHostViewController.feedbackMessages.last == "正在整理结构…")
    newRequest(["ok": true, "message": "NEW"], true)
    check("T10 新请求正常完成", !p.cleanLayoutInFlight && p.statuses.last == "NEW")
    p.actClean()
    p.pendingClean.removeFirst()(nil, false)
    check("T10 页面读取失败恢复按钮并提示", !p.cleanLayoutInFlight && p.alerts.last?.0 == "整理未应用")
}

print("---- S03 保存请求不得跨会话或覆盖后发保存 ----")

do {
    resetStatics()
    let p = Probe()
    let a = URL(fileURLWithPath: fixtureDir + "/S03-pair-A.ket")
    let b = URL(fileURLWithPath: fixtureDir + "/S03-pair-B.ket")
    try? FileManager.default.removeItem(at: a)
    makeClean(p.canvasSession, "A_SAVED", url: a)
    p.pageSnapshot = "A_EDIT"
    p.deferSavePair = true
    var result: Bool? = nil
    p.saveSession(.canvas, forceSaveAs: false) { result = $0 }
    p.startNavigation(to: .canvas, pending: .openCanvasFile(text: "B_SAVED", url: b))
    makeClean(p.canvasSession, "B_SAVED", url: b)
    p.endNavigationTransaction()
    p.pendingSavePairs.removeFirst()(["snap": "A_EDIT", "txt": "A_EDIT"], true)
    check("S03b 旧画布导出回调取消保存", result == false && !FileManager.default.fileExists(atPath: a.path))
    check("S03b 不把 B 身份改回 A", p.canvasSession.fileURL == b && p.canvasSession.savedBaseline == "B_SAVED")
    check("S03b 不报告旧保存成功", p.statuses.isEmpty)
}
do {
    resetStatics()
    let p = Probe()
    makeClean(p.canvasSession, "A_SAVED")
    p.pageSnapshot = "A_EDIT"
    let target = URL(fileURLWithPath: fixtureDir + "/S03-modal.ket")
    try? FileManager.default.removeItem(at: target)
    NSSavePanel.chosen = target
    NSSavePanel.onRun = {
        p.startNavigation(to: .canvas, pending: .newDocument)
        makeClean(p.canvasSession, "B_SAVED")
        p.endNavigationTransaction()
    }
    var result: Bool? = nil
    p.saveSession(.canvas, forceSaveAs: true) { result = $0 }
    check("S03c 保存面板期间导航后拒绝写盘", result == false && !FileManager.default.fileExists(atPath: target.path))
    check("S03c 保留面板期间建立的新会话", p.canvasSession.fileURL == nil && p.canvasSession.savedBaseline == "B_SAVED")
}
do {
    resetStatics()
    let p = Probe()
    let target = URL(fileURLWithPath: fixtureDir + "/S03-continued-edit.ket")
    makeClean(p.canvasSession, "SAVED", url: target)
    p.pageSnapshot = "EDIT_1"
    p.deferSavePair = true
    var result: Bool? = nil
    p.saveSession(.canvas, forceSaveAs: false) { result = $0 }
    p.pageSnapshot = "EDIT_2"
    p.canvasSession.currentSnapshot = "EDIT_2"
    p.pendingSavePairs.removeFirst()(["snap": "EDIT_1", "txt": "EDIT_1"], true)
    check("S03d 同文件继续编辑仍可保存本次快照", result == true && (try? String(contentsOf: target, encoding: .utf8)) == "EDIT_1")
    check("S03d 后续编辑保持未保存", p.canvasSession.currentSnapshot == "EDIT_2" && p.canvasSession.savedBaseline == "EDIT_1" && p.canvasSession.dirty)
}
do {
    resetStatics()
    let p = Probe()
    let target = URL(fileURLWithPath: fixtureDir + "/S03-save-order.ket")
    makeClean(p.canvasSession, "SAVED", url: target)
    p.pageSnapshot = "EDIT_1"
    p.deferSavePair = true
    var first: Bool? = nil
    var second: Bool? = nil
    p.saveSession(.canvas, forceSaveAs: false) { first = $0 }
    p.pageSnapshot = "EDIT_2"
    p.saveSession(.canvas, forceSaveAs: false) { second = $0 }
    let firstCallback = p.pendingSavePairs.removeFirst()
    let secondCallback = p.pendingSavePairs.removeFirst()
    secondCallback(["snap": "EDIT_2", "txt": "EDIT_2"], true)
    firstCallback(["snap": "EDIT_1", "txt": "EDIT_1"], true)
    check("S03e 后发保存优先，旧回调取消", first == false && second == true)
    check("S03e 旧保存不能覆写新版文件或基线", (try? String(contentsOf: target, encoding: .utf8)) == "EDIT_2" && p.canvasSession.savedBaseline == "EDIT_2")
}
do {
    resetStatics()
    let p = Probe()
    let original = URL(fileURLWithPath: fixtureDir + "/S03-old-name.ket")
    let renamed = URL(fileURLWithPath: fixtureDir + "/S03-new-name.ket")
    try? FileManager.default.removeItem(at: original)
    makeClean(p.canvasSession, "SAVED", url: original)
    p.pageSnapshot = "EDIT"
    p.deferSavePair = true
    var result: Bool? = nil
    p.saveSession(.canvas, forceSaveAs: false) { result = $0 }
    p.canvasSession.fileURL = renamed
    p.pendingSavePairs.removeFirst()(["snap": "EDIT", "txt": "EDIT"], true)
    check("S03f 重命名后不重建旧路径", result == false && !FileManager.default.fileExists(atPath: original.path))
    check("S03f 重命名的身份保留", p.canvasSession.fileURL == renamed && p.canvasSession.savedBaseline == "SAVED")
}
do {
    resetStatics()
    let p = Probe()
    let target = URL(fileURLWithPath: fixtureDir + "/S03-closed.ket")
    try? FileManager.default.removeItem(at: target)
    makeClean(p.canvasSession, "SAVED", url: target)
    p.pageSnapshot = "EDIT"
    p.deferSavePair = true
    var result: Bool? = nil
    p.saveSession(.canvas, forceSaveAs: false) { result = $0 }
    p.closeActiveSession()
    p.pendingSavePairs.removeFirst()(["snap": "EDIT", "txt": "EDIT"], true)
    check("S03g 关闭后旧保存不能写盘", result == false && !FileManager.default.fileExists(atPath: target.path))
    check("S03g 关闭的会话不能被旧保存重新建立", !p.canvasSession.initialized && p.canvasSession.fileURL == nil)
}
do {
    resetStatics()
    let p = Probe()
    let target = URL(fileURLWithPath: fixtureDir + "/S03-new-mechanism.ket")
    try? FileManager.default.removeItem(at: target)
    makeClean(p.canvasSession, "SAVED", url: target)
    p.pageSnapshot = "STRUCTURE_ONLY"
    p.deferSavePair = true
    var result: Bool? = nil
    p.saveSession(.canvas, forceSaveAs: false) { result = $0 }
    let full = #"{"format":"molstudio-workbench","version":1,"ket":{"root":{"nodes":[]}},"bindings":{"atoms":[],"bonds":[]},"mechanism":{"lonePairs":[{}],"arrows":[],"steps":[]}}"#
    p.canvasSession.currentSnapshot = full
    p.pendingSavePairs.removeFirst()(["snap": full, "txt": "STRUCTURE_ONLY"], true)
    check("S03h 最终快照新增机理时不写有损格式", result == false && !FileManager.default.fileExists(atPath: target.path))
    check("S03h 新增机理保持未保存并提示完整格式", p.canvasSession.dirty && p.canvasSession.savedBaseline == "SAVED" && p.alerts.last?.0.contains("molwork") == true)
}


print("---- S04 快照与导出必须同版提交 ----")
do {
    resetStatics()
    let p = Probe()
    makeClean(p.canvasSession, "SAVED")
    p.canvasSession.molExport = "OLD_MOL"
    p.canvasSession.smilesExport = "OLD_SMILES"
    p.canvasSession.exportSnapshot = "SAVED"
    p.deferCapture = true
    var result: Bool? = nil
    p.captureActiveSession { result = $0 }
    // 实际生成的 JS 由下方 Node 测试执行；检测到中途编辑时返回 null。
    try! p.jsBodies.last!.write(toFile: fixtureDir + "/capture-exports.js", atomically: true, encoding: .utf8)
    p.pendingCaptures.removeFirst()(nil, true)
    check("S04a 读取期间变化取消离开捕获", result == false)
    check("S04a 失败不提交一半快照或缓存", p.canvasSession.currentSnapshot == "SAVED" && p.canvasSession.molExport == "OLD_MOL" && p.canvasSession.smilesExport == "OLD_SMILES" && p.canvasSession.exportSnapshot == "SAVED")
}
do {
    resetStatics()
    let p = Probe()
    makeClean(p.canvasSession, "SAVED")
    p.deferCapture = true
    var result: Bool? = nil
    p.captureActiveSession { result = $0 }
    p.pendingCaptures.removeFirst()(["snap": "CURRENT", "mol": "CURRENT_MOL", "smi": "CURRENT_SMILES"], true)
    check("S04b 校验成功才一起提交快照与缓存", result == true && p.canvasSession.currentSnapshot == "CURRENT" && p.canvasSession.exportSnapshot == "CURRENT" && p.canvasSession.molExport == "CURRENT_MOL" && p.canvasSession.smilesExport == "CURRENT_SMILES")
}
for ext in ["mol", "smiles"] {
    resetStatics()
    let p = Probe()
    p.deferSavePair = true
    var snapshot: String? = "UNSET"
    var text: String? = "UNSET"
    p.fetchCanvasSaveTexts(ext) { snapshot = $0; text = $1 }
    try! p.jsBodies.last!.write(toFile: fixtureDir + "/save-" + ext + ".js", atomically: true, encoding: .utf8)
    p.pendingSavePairs.removeFirst()(nil, true)
    check("S04c \(ext) 混版结果不返回保存文本或基线", snapshot == nil && text == nil)
    p.fetchCanvasSaveTexts(ext) { snapshot = $0; text = $1 }
    p.pendingSavePairs.removeFirst()(["snap": "VALID_JSON_SNAPSHOT", "txt": NSNull()], true)
    check("S04d \(ext) 空导出不降级写入 JSON", text == nil)
}

print("---- S05 保存成功后离开前仍须确认最新内容 ----")
for action in ["close", "new", "open"] {
    resetStatics()
    let p = Probe()
    let original = URL(fileURLWithPath: fixtureDir + "/S05-" + action + "-A.ket")
    let destination = URL(fileURLWithPath: fixtureDir + "/S05-" + action + "-B.ket")
    try! "B_ON_DISK".write(to: destination, atomically: true, encoding: .utf8)
    makeClean(p.canvasSession, "SAVED", url: original)
    p.pageSnapshot = "EDIT_1"
    p.deferSavePair = true
    NSAlert.nextResult = .alertFirstButtonReturn
    let gen = p.navigationGeneration
    switch action {
    case "close": _ = p.windowShouldClose(p.window)
    case "new": p.actNewDocument()
    default: p.openDocument(at: destination)
    }
    p.pageSnapshot = "EDIT_2"
    p.pendingSavePairs.removeFirst()(["snap": "EDIT_1", "txt": "EDIT_1"], true)
    check("S05a \(action) 保存本次快照仍实际落盘", (try? String(contentsOf: original, encoding: .utf8)) == "EDIT_1")
    check("S05a \(action) 后续编辑取消离开并保留当前会话", p.navigationGeneration == gen && p.canvasSession.fileURL == original && p.canvasSession.currentSnapshot == "EDIT_2" && p.canvasSession.dirty && p.window.isVisible && !p.welcomed)
    check("S05a \(action) 提示未保存后续编辑且目标文件未变", p.alerts.last?.0 == "仍有未保存的更改" && (try? String(contentsOf: destination, encoding: .utf8)) == "B_ON_DISK")
}

do {
    resetStatics()
    let p = Probe()
    makeClean(p.canvasSession, "SAVED", url: URL(fileURLWithPath: fixtureDir + "/S05-unreadable.ket"))
    p.pageSnapshot = "EDIT"
    p.deferSavePair = true
    NSAlert.nextResult = .alertFirstButtonReturn
    _ = p.windowShouldClose(p.window)
    p.deferSnapshot = true
    p.pendingSavePairs.removeFirst()(["snap": "EDIT", "txt": "EDIT"], true)
    // 第一个等待是保存后轮询，第二个是必须完成后才能离开的复查。
    let verification = p.pendingSnapshots.removeLast()
    verification(nil, false)
    check("S05e 保存后复查读取失败也不能关闭", p.window.isVisible && !p.welcomed && p.canvasSession.initialized && p.alerts.last?.0 == "无法确认保存后的内容")
}


print("---- 单画布导航与已停用格式 ----")
do {
    resetStatics()
    let p = Probe()
    let file = URL(fileURLWithPath: fixtureDir + "/restore-canvas.ket")
    makeDirtyCanvas(p.canvasSession)
    p.canvasSession.fileURL = file
    p.startNavigation(to: .canvas, pending: .restoreSession(text: p.canvasSession.currentSnapshot))
    p.pageSnapshot = "EMPTY_PAGE"
    p.pollActiveSnapshot()
    check("N1 导航事务中空页不覆盖原快照", p.canvasSession.currentSnapshot == "UNSAVED_CANVAS")
    p.deferInject = true
    p.applyPending(mode: .canvas, gen: p.navigationGeneration)
    check("N1 恢复注入使用导航前固定文本", p.injected.last?.contains("UNSAVED_CANVAS") == true)
    p.pageSnapshot = "UNSAVED_CANVAS"
    p.flushInject()
    check("N1 恢复完成仍保留文件身份和未保存状态", !p.navigationInFlight && p.canvasSession.fileURL == file && p.canvasSession.dirty && p.canvasSession.savedBaseline == "SAVED")
}
do {
    resetStatics()
    let p = Probe()
    makeDirtyCanvas(p.canvasSession)
    p.pageSnapshot = "UNSAVED_CANVAS"
    let file = URL(fileURLWithPath: fixtureDir + "/retired.mechdoc")
    try! "{\"version\":2}".write(to: file, atomically: true, encoding: .utf8)
    let gen = p.navigationGeneration
    p.openDocument(at: file)
    check("N2 旧MECHDOC明确拒绝且不导航", p.navigationGeneration == gen && p.web.loaded.isEmpty && p.alerts.last?.0 == "旧机理格式已停用")
    check("N2 拒绝旧格式后当前画布原样保留", p.canvasSession.currentSnapshot == "UNSAVED_CANVAS" && p.canvasSession.dirty)
}
do {
    resetStatics()
    let p = Probe()
    makeDirtyCanvas(p.canvasSession)
    p.pageSnapshot = "UNSAVED_CANVAS"
    p.deferInject = true
    let replacement = URL(fileURLWithPath: fixtureDir + "/failed-open.ket")
    p.startNavigation(to: .canvas, pending: .openCanvasFile(text: "NEW_KET", url: replacement))
    p.applyPending(mode: .canvas, gen: p.navigationGeneration)
    p.injectResultOK = false
    p.flushInject()
    // Native host now loads canvas.html with the first-frame mode marker and
    // the navigation generation; browser mode (no query) is unchanged.
    let lastURL = p.web.loaded.last ?? ""
    check("N3 载入失败导航回当前画布（首帧模式 URL）",
          lastURL.contains("/canvas.html?nativeCanvas=1") &&
          lastURL.contains("navGen=\(p.navigationGeneration)") && p.navigationInFlight)
    check("N3 失败的新文件身份未提交", p.canvasSession.fileURL != replacement && p.canvasSession.currentSnapshot == "UNSAVED_CANVAS")
    p.injectResultOK = true
    p.deferInject = false
    p.pageSnapshot = "UNSAVED_CANVAS"
    p.applyPending(mode: .canvas, gen: p.navigationGeneration)
    check("N3 回退恢复当前画布并保留dirty", !p.navigationInFlight && p.canvasSession.currentSnapshot == "UNSAVED_CANVAS" && p.canvasSession.dirty)
}


print("---- P1 打开意图竞态与完整工作台识别 ----")
let smilesFile = URL(fileURLWithPath: fixtureDir + "/delayed.smi")
try! "CCO".write(to: smilesFile, atomically: true, encoding: .utf8)

do {
    resetStatics()
    let p = Probe()
    makeClean(p.canvasSession, "SAVED")
    p.pageSnapshot = "SAVED"
    p.deferPost = true
    p.openDocument(at: smilesFile)
    check("O1 SMILES转换等待期间不提前询问放弃", p.pendingPosts.count == 1 && NSAlert.count == 0)
    let newer = URL(fileURLWithPath: fixtureDir + "/B.ket")
    p.openDocument(at: newer)
    p.pageSnapshot = "B_CONTENT"
    p.applyPending(mode: .canvas, gen: p.navigationGeneration)
    p.pageSnapshot = "B_EDIT_NOT_SAVED"
    p.pollActiveSnapshot()
    let gen = p.navigationGeneration, prompts = NSAlert.count
    p.pendingPosts.removeFirst()(["ok": true, "molblock": "A_CONVERTED"])
    check("O1 A迟到成功不覆盖新打开且已编辑的B", p.navigationGeneration == gen && p.canvasSession.fileURL == newer && p.canvasSession.currentSnapshot == "B_EDIT_NOT_SAVED" && p.canvasSession.dirty)
    check("O1 旧打开请求不再弹确认或报错", NSAlert.count == prompts && p.alerts.isEmpty)
}
do {
    resetStatics()
    let p = Probe()
    makeClean(p.canvasSession, "SAVED")
    p.pageSnapshot = "SAVED"
    p.deferPost = true
    p.openDocument(at: smilesFile)
    p.openDocument(at: URL(fileURLWithPath: fixtureDir + "/B.ket"))
    let gen = p.navigationGeneration
    p.pendingPosts.removeFirst()(["ok": false, "error": "OLD_ERROR"])
    check("O2 A迟到失败不向B弹旧错误", p.navigationGeneration == gen && p.alerts.isEmpty)
}
do {
    resetStatics()
    let p = Probe()
    makeClean(p.canvasSession, "SAVED")
    p.pageSnapshot = "SAVED"
    p.deferPost = true
    p.openDocument(at: smilesFile)
    p.pageSnapshot = "EDITED_DURING_CONVERSION"
    NSAlert.nextResult = .cancel
    p.pendingPosts.removeFirst()(["ok": true, "molblock": "CONVERTED"])
    check("O3 同画布转换等待中新编辑必须重新确认", NSAlert.count == 1 && p.canvasSession.currentSnapshot == "EDITED_DURING_CONVERSION" && p.canvasSession.dirty)
    check("O3 取消确认保留新编辑且不导航", p.web.loaded.isEmpty && p.canvasSession.fileURL == nil)
}
for action in ["cancel-open", "new", "close", "quit"] {
    resetStatics()
    let p = Probe()
    makeClean(p.canvasSession, "SAVED")
    p.pageSnapshot = "SAVED"
    p.deferPost = true
    p.openDocument(at: smilesFile)
    switch action {
    case "cancel-open": NSOpenPanel.chosen = nil; p.actOpen()
    case "new": p.actNewDocument()
    case "close": _ = p.windowShouldClose(p.window)
    default: _ = p.applicationShouldTerminate(NSApplication())
    }
    let gen = p.navigationGeneration, alerts = p.alerts.count
    p.pendingPosts.removeFirst()(["ok": true, "molblock": "OLD_CONVERTED"])
    check("O4 \(action)撤销未完成的打开意图", p.navigationGeneration == gen && p.alerts.count == alerts)
}
do {
    resetStatics()
    let p = Probe()
    makeClean(p.canvasSession, "SAVED")
    p.pageSnapshot = "SAVED"
    p.deferPost = true
    p.openDocument(at: smilesFile)
    let second = URL(fileURLWithPath: fixtureDir + "/second.smiles")
    try! "CCN".write(to: second, atomically: true, encoding: .utf8)
    p.openDocument(at: second)
    p.pendingPosts[0](["ok": true, "molblock": "FIRST_RESULT"])
    check("O5 两个转换请求只接受后发意图", p.web.loaded.isEmpty)
    p.pendingPosts[1](["ok": true, "molblock": "SECOND_RESULT"])
    p.applyPending(mode: .canvas, gen: p.navigationGeneration)
    check("O5 后发转换正常打开", p.injected.last?.contains("SECOND_RESULT") == true && p.canvasSession.fileURL == second)
}
do {
    resetStatics()
    let p = Probe()
    makeClean(p.canvasSession, "SAVED")
    p.pageSnapshot = "SAVED"
    p.deferCapture = true
    p.openDocument(at: URL(fileURLWithPath: fixtureDir + "/B.ket"))
    p.pageSnapshot = "EDIT_AFTER_CONFIRM"
    p.pendingCaptures.removeFirst()(["snap":"EDIT_AFTER_CONFIRM", "mol":"MOL_NEW", "smi":"SMI_NEW"], true)
    check("O6 确认之后捕获到新编辑取消打开", p.web.loaded.isEmpty && p.canvasSession.currentSnapshot == "EDIT_AFTER_CONFIRM" && p.canvasSession.dirty && p.alerts.last?.0 == "内容已改变")
}
do {
    resetStatics()
    let p = Probe()
    makeClean(p.canvasSession, "SAVED")
    p.pageSnapshot = "SAVED"
    p.deferCapture = true
    p.openDocument(at: URL(fileURLWithPath: fixtureDir + "/B.ket"))
    // 用户发起另一个打开并取消，旧捕获即便同版本返回，也不得继续导航。
    p.actOpen()
    p.pendingCaptures.removeFirst()(["snap":"SAVED", "mol":"MOL_SAVED", "smi":"SMI_SAVED"], true)
    check("O6 迟到导航捕获也检查打开意图", p.web.loaded.isEmpty)
}


do {
    resetStatics()
    let p = Probe()
    makeDirtyCanvas(p.canvasSession)
    p.pageSnapshot = "EDIT_CONSIDERED_BY_CONFIRM"
    NSAlert.nextResult = .alertSecondButtonReturn
    NSAlert.onRun = {
        p.pageSnapshot = "EDIT_DURING_CONFIRM"
        p.pollActiveSnapshot()
    }
    p.openDocument(at: URL(fileURLWithPath: fixtureDir + "/B.ket"))
    check("O7 确认期间的轮询不能扩大放弃授权", p.web.loaded.isEmpty && p.canvasSession.currentSnapshot == "EDIT_DURING_CONFIRM" && p.canvasSession.dirty && p.alerts.last?.0 == "内容已改变")
}

// 确认前的快照本身也异步：过期打开不能先弹窗、再由外层丢弃结果。
for action in ["new-open", "cancel-open"] {
    for succeeds in [true, false] {
        resetStatics()
        let p = Probe()
        makeDirtyCanvas(p.canvasSession)
        p.pageSnapshot = "CURRENT_EDIT"
        p.deferSnapshot = true
        p.postResult = ["ok": true, "molblock": "A_CONVERTED"]
        p.openDocument(at: smilesFile)
        let oldSnapshot = p.pendingSnapshots.removeFirst()
        let gen = p.navigationGeneration
        if action == "new-open" {
            p.openDocument(at: URL(fileURLWithPath: fixtureDir + "/B.ket"))
        } else {
            p.actOpen()
        }
        oldSnapshot(succeeds ? "OLD_SNAPSHOT" : nil, succeeds)
        check("O8 \(action)使旧确认快照\(succeeds ? "成功" : "失败")静默失效", NSAlert.count == 0 && p.alerts.isEmpty && p.web.loaded.isEmpty && p.navigationGeneration == gen)
        check("O8 \(action)过期快照不提交会话", p.canvasSession.currentSnapshot == "UNSAVED_CANVAS" && p.canvasSession.dirty)
    }
}
do {
    resetStatics()
    let p = Probe()
    let file = URL(fileURLWithPath: fixtureDir + "/stale-confirm-save.ket")
    makeClean(p.canvasSession, "SAVED", url: file)
    p.pageSnapshot = "EDIT_TO_SAVE"
    p.deferSavePair = true
    NSAlert.nextResult = .alertFirstButtonReturn
    p.openDocument(at: URL(fileURLWithPath: fixtureDir + "/B.ket"))
    p.actOpen()
    p.deferSnapshot = true
    p.pendingSavePairs.removeFirst()(["snap":"EDIT_TO_SAVE", "txt":"EDIT_TO_SAVE"], true)
    // 保存本身仍会轮询一次以更新 dirty；过期离开意图不能再多读一次用于离开复查。
    check("O9 旧确认保存回调不再启动离开复查", p.pendingSnapshots.count == 1 && p.web.loaded.isEmpty && p.alerts.isEmpty && NSAlert.count == 1)
}
for succeeds in [true, false] {
    resetStatics()
    let p = Probe()
    let file = URL(fileURLWithPath: fixtureDir + "/stale-confirm-verification.ket")
    makeClean(p.canvasSession, "SAVED", url: file)
    p.pageSnapshot = "EDIT_TO_SAVE"
    p.deferSavePair = true
    NSAlert.nextResult = .alertFirstButtonReturn
    p.openDocument(at: URL(fileURLWithPath: fixtureDir + "/B.ket"))
    p.deferSnapshot = true
    p.pendingSavePairs.removeFirst()(["snap":"EDIT_TO_SAVE", "txt":"EDIT_TO_SAVE"], true)
    let oldVerification = p.pendingSnapshots.removeLast()
    p.actOpen()
    oldVerification(succeeds ? "EDIT_AFTER_SAVE" : nil, succeeds)
    check("O9 旧保存复查\(succeeds ? "成功" : "失败")不向新意图弹错", p.web.loaded.isEmpty && p.alerts.isEmpty && NSAlert.count == 1)
}

let fullFixtureURL = URL(fileURLWithPath: fixtureDir + "/source-F01.molwork")
let fullSource = try! String(contentsOf: fullFixtureURL, encoding: .utf8)
let fullObject = try! JSONSerialization.jsonObject(with: Data(fullSource.utf8)) as! [String: Any]
let prettyData = try! JSONSerialization.data(withJSONObject: fullObject, options: [.prettyPrinted, .sortedKeys])
let prettySource = String(data: prettyData, encoding: .utf8)!
for (name, text) in [("compact", fullSource), ("pretty", prettySource), ("bom", "\u{FEFF}" + prettySource)] {
    resetStatics()
    let p = Probe()
    makeClean(p.canvasSession, "SAVED")
    p.pageSnapshot = "SAVED"
    p.injectReturnValue = #"{"ok":true}"#
    let file = URL(fileURLWithPath: fixtureDir + "/open-" + name + ".molwork")
    try! text.write(to: file, atomically: true, encoding: .utf8)
    check("W1 \(name)按JSON顶层格式识别", p.isWorkbenchSnapshot(text) && p.workbenchLoadError(text) == nil)
    p.openDocument(at: file)
    p.pageSnapshot = fullSource
    p.applyPending(mode: .canvas, gen: p.navigationGeneration)
    check("W1 \(name)完整载入而非结构降级", p.injected.last?.contains("loadWorkbench") == true && p.injected.allSatisfy { !$0.contains("setMolecule") })
    check("W1 \(name)载入后保留完整快照和文件身份", p.canvasSession.currentSnapshot == fullSource && p.canvasSession.savedBaseline == fullSource && p.canvasSession.fileURL == file && !p.canvasSession.dirty && !p.navigationInFlight)
    if name == "bom" {
        check("W1 BOM载入参数中已移除BOM", !(p.injected.last?.contains("\u{FEFF}") ?? true))
        try! p.injected.last!.write(toFile: fixtureDir + "/load-pretty-workbench.js", atomically: true, encoding: .utf8)
    }
}
do {
    let p = Probe()
    let falsePositive = #"{"root":{"nodes":[]},"note":{"format":"molstudio-workbench"}}"#
    check("W2 嵌套格式字样不误判为完整工作台", !p.isWorkbenchSnapshot(falsePositive))
    check("W2 保留MOL空白头行", p.normalizedCanvasFileText("\n  MOL\n") == "\n  MOL\n")
    check("W2 带BOM工作台仍检测孤对和机理", p.snapshotHasMechanism("\u{FEFF}" + prettySource))
    check("W2 工作台KET提取接受漂亮JSON", p.ketTextFromSnapshot(prettySource)?.contains("ket_version") == true)
}
do {
    resetStatics()
    let p = Probe()
    var v2Object = fullObject
    v2Object["version"] = 2
    v2Object["document"] = ["mode": "paper", "objects": [["id": "text-1", "rich": ["text": "中文"]]]]
    let bytes = try! JSONSerialization.data(withJSONObject: v2Object, options: [.sortedKeys])
    let source = String(data: bytes, encoding: .utf8)!
    check("W2 v2完整外壳通过且包装不降级", p.workbenchLoadError(source) == nil && p.wrapKetAsWorkbench(source) == source)
    check("W2 v2显式导出KET仍可提取", p.ketTextFromSnapshot(source)?.contains("ket_version") == true)
    makeClean(p.canvasSession, "SAVED")
    p.pageSnapshot = "SAVED"; p.injectReturnValue = #"{"ok":true}"#
    let file = URL(fileURLWithPath: fixtureDir + "/open-document-v2.molwork")
    try! source.write(to: file, atomically: true, encoding: .utf8)
    p.openDocument(at: file); p.pageSnapshot = source
    p.applyPending(mode: .canvas, gen: p.navigationGeneration)
    check("W2 v2完整载入与保存快照保留document", p.injected.last?.contains("loadWorkbench") == true && p.canvasSession.currentSnapshot == source && p.canvasSession.savedBaseline == source)
}
for (name, text) in [
    ("bad-json", "{"),
    ("wrong-format", #"{"format":"another-format","version":1}"#),
    ("missing-version", #"{"format":"molstudio-workbench","ket":{},"bindings":{},"mechanism":{}}"#),
    ("boolean-version", #"{"format":"molstudio-workbench","version":true,"ket":{},"bindings":{},"mechanism":{}}"#),
    ("newer-version", #"{"format":"molstudio-workbench","version":3,"ket":{},"bindings":{},"mechanism":{}}"#),
    ("fractional-version", #"{"format":"molstudio-workbench","version":1.5,"ket":{},"bindings":{},"mechanism":{}}"#),
    ("v2-missing-document", #"{"format":"molstudio-workbench","version":2,"ket":{},"bindings":{},"mechanism":{}}"#),
    ("v2-array-document", #"{"format":"molstudio-workbench","version":2,"ket":{},"bindings":{},"mechanism":{},"document":[]}"#),
    ("missing-mechanism", #"{"format":"molstudio-workbench","version":1,"ket":{},"bindings":{}}"#)
] {
    resetStatics()
    let p = Probe()
    makeDirtyCanvas(p.canvasSession)
    p.pageSnapshot = "UNSAVED_CANVAS"
    let file = URL(fileURLWithPath: fixtureDir + "/invalid-" + name + ".molwork")
    try! text.write(to: file, atomically: true, encoding: .utf8)
    p.openDocument(at: file)
    check("W3 \(name)拒绝而不降级或导航", p.web.loaded.isEmpty && p.injected.isEmpty && p.alerts.last?.0 == "打开失败")
    check("W3 \(name)保留原画布与dirty", p.canvasSession.currentSnapshot == "UNSAVED_CANVAS" && p.canvasSession.dirty)
}

print("---- W4 新纸页初始化和保存 ----")
let paperSnapshot = #"{"format":"molstudio-workbench","version":2,"ket":{"root":{"nodes":[]}},"bindings":{"atoms":[],"bonds":[]},"mechanism":{"arrows":[],"lonePairs":[]},"document":{"mode":"paper"}}"#
do {
    resetStatics(); let p = Probe(); makeDirtyCanvas(p.canvasSession); p.pageSnapshot = "UNSAVED_CANVAS"
    NSAlert.nextResult = .cancel
    p.startNewPaperDocument(WelcomePaperSetup())
    check("W4 取消新建纸页保留旧内容和文件身份", p.web.loaded.isEmpty && p.canvasSession.currentSnapshot == "UNSAVED_CANVAS" && p.canvasSession.fileURL != nil)
}
do {
    resetStatics(); let p = Probe(); makeClean(p.canvasSession, "OLD", url: URL(fileURLWithPath: "/tmp/old.ket")); p.pageSnapshot = "OLD"
    p.startNewPaperDocument(WelcomePaperSetup()); let gen = p.navigationGeneration
    p.injectReturnValue = true; p.pageSnapshot = paperSnapshot
    p.applyPending(mode: .canvas, gen: gen)
    check("W4 纸张配置传入JS", p.injected.last?.contains("\"size\":\"Letter\"") == true && p.injected.last?.contains("\"orientation\":\"landscape\"") == true)
    check("W4 初始化成功才建立干净v2基线", p.canvasSession.currentSnapshot == paperSnapshot && p.canvasSession.savedBaseline == paperSnapshot && p.canvasSession.fileURL == nil && !p.canvasSession.dirty && !p.navigationInFlight)
}
do {
    resetStatics(); let p = Probe(); makeClean(p.canvasSession, "OLD", url: URL(fileURLWithPath: "/tmp/old.ket")); p.pageSnapshot = "OLD"
    p.startNewPaperDocument(WelcomePaperSetup()); let gen = p.navigationGeneration
    p.injectReturnValue = false; p.injectResultOK = false
    p.applyPending(mode: .canvas, gen: gen)
    check("W4 初始化失败保留旧身份和快照并回退", p.canvasSession.currentSnapshot == "OLD" && p.canvasSession.fileURL?.path == "/tmp/old.ket" && p.web.loaded.count == 2)
}
do {
    resetStatics(); let p = Probe(); makeClean(p.canvasSession, "OLD", url: URL(fileURLWithPath: "/tmp/old.ket")); p.pageSnapshot = "OLD"
    p.startNewPaperDocument(WelcomePaperSetup()); let gen = p.navigationGeneration
    p.injectReturnValue = true; p.deferInject = true; p.applyPending(mode: .canvas, gen: gen)
    p.startNavigation(to: .canvas, pending: .newDocument); p.flushInject()
    check("W4 迟到纸页回调不改新导航会话", p.canvasSession.currentSnapshot == "OLD" && p.canvasSession.fileURL?.path == "/tmp/old.ket" && p.navigationInFlight)
}
do {
    resetStatics(); let p = Probe(); let old = URL(fileURLWithPath: fixtureDir + "/paper-old.ket"), target = URL(fileURLWithPath: fixtureDir + "/paper-new.molwork")
    try? FileManager.default.removeItem(at: target); makeClean(p.canvasSession, "OLD", url: old); p.pageSnapshot = paperSnapshot
    NSSavePanel.chosen = target; var ok = false; p.saveSession(.canvas, forceSaveAs: false) { ok = $0 }
    check("W4 带文档的旧KET先另存完整molwork", ok && NSSavePanel.count == 1 && p.canvasSession.fileURL == target && (try? String(contentsOf: target, encoding: .utf8)) == paperSnapshot)
    check("W4 只有成功保存才记录最近文件", p.recentNoted == [target])
}
do {
    resetStatics(); let p = Probe(); let old = URL(fileURLWithPath: fixtureDir + "/paper-old.ket")
    makeClean(p.canvasSession, "OLD", url: old); p.pageSnapshot = paperSnapshot; NSSavePanel.chosen = nil
    var ok = true; p.saveSession(.canvas, forceSaveAs: false) { ok = $0 }
    check("W4 取消纸页另存保留旧文件身份", !ok && p.canvasSession.fileURL == old && p.canvasSession.savedBaseline == "OLD" && p.recentNoted.isEmpty)
}

print("---- W5 异步欢迎缩略图隔离 ----")
for scenario in ["current", "navigation", "save", "session", "identity", "snapshot", "superseded"] {
    resetStatics(); let p = Probe(); let file = URL(fileURLWithPath: fixtureDir + "/thumb-" + scenario + ".molwork")
    try! "document".write(to:file, atomically:true, encoding:.utf8)
    makeClean(p.canvasSession, paperSnapshot, url:file); p.pageSnapshot = paperSnapshot; p.deferThumbnail = true
    p.scheduleWelcomeThumbnail(url:file, snapshot:paperSnapshot)
    RunLoop.current.run(until: Date().addingTimeInterval(0.05))
    check("W5 \(scenario) 已排队异步渲染", p.pendingThumbnails.count == 1)
    WelcomeThumbnailCache.writes = 0
    switch scenario {
    case "navigation": p.navigationGeneration += 1
    case "save": p.canvasSession.saveGeneration += 1
    case "session": p.canvasSession = CanvasSession()
    case "identity": p.canvasSession.fileURL = URL(fileURLWithPath: "/tmp/other.molwork")
    case "snapshot": p.pageSnapshot = "EDITED_AFTER_RENDER"
    case "superseded": p.thumbnailGeneration += 1
    default: break
    }
    if !p.pendingThumbnails.isEmpty { p.pendingThumbnails.removeFirst()(["mode":"paper", "dataUrl":"data:image/png;base64,YQ=="], true) }
    check("W5 \(scenario) 仅当前快照可写", WelcomeThumbnailCache.writes == (scenario == "current" ? 1 : 0), "writes=\(WelcomeThumbnailCache.writes), jsCalls=\(p.jsBodies.count)")
}

print("---- 汇总 ----")
print("TOTAL=\(total) PASS=\(total - failed) FAIL=\(failed)")
if failed > 0 { exit(1) }
'''

os.makedirs(os.path.join(OUT_DIR, 'fixtures'), exist_ok=True)
with open(os.path.join(ROOT, 'fusion/tests/fixtures/workbench-mechanism/F01.molwork'), encoding='utf-8') as source:
    with open(os.path.join(OUT_DIR, 'fixtures/source-F01.molwork'), 'w', encoding='utf-8') as target:
        target.write(source.read())

open(OUT, 'w', encoding='utf-8').write(TEMPLATE_HEAD + extracted + TEMPLATE_TAIL)
print(f'written: {OUT}')

import AppKit
import Combine
import Darwin
import UniformTypeIdentifiers
import WebKit
import SwiftUI
import CryptoKit

/// 本地服务端口：正式包为 8462；隔离候选包或自测构建独立分配/指定端口，避免与用户正在用的 MolStudio 冲突。
private let kPort: Int = AppRuntimeConfig.shared.port

// MARK: - 运行环境解析（B14 解释器半项）
// 资源（server.py/网页/vendor/Ketcher）随包或源码树解析，不再写死开发目录；
// Python/RDKit 随包提供，也可配置外置解释器；启动前预检，失败给可读错误。

/// 开发态源码树根（工作区根）：由本文件路径推导，
/// 仅在 swift run / .build 直跑（非 .app）时用于回退，保持开发体验。
private let kDevRoot: URL? = {
    let dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()   // …/fusion-native/Sources/Ketcher3D
    guard dir.lastPathComponent == "Ketcher3D",
          dir.deletingLastPathComponent().lastPathComponent == "Sources" else { return nil }
    return dir.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
}()

/// 打包态：从 .app 包内运行（bundlePath 以 .app 结尾，或 Contents/Info.plist 存在）。
private let kIsBundled: Bool = {
    if Bundle.main.bundlePath.hasSuffix(".app") { return true }
    return FileManager.default.fileExists(atPath: Bundle.main.bundlePath + "/Contents/Info.plist")
}()

/// 服务与网页资源根：打包态 = MolStudio.app/Contents/Resources（绝不回退读源码目录）；
/// 开发态 = 工作区根/fusion/。
private let kServerDir: URL = {
    if kIsBundled {
        return Bundle.main.resourceURL
            ?? Bundle.main.bundleURL.appendingPathComponent("Contents/Resources", isDirectory: true)
    }
    if let root = kDevRoot { return root.appendingPathComponent("fusion", isDirectory: true) }
    return URL(fileURLWithPath: "fusion",
               relativeTo: URL(fileURLWithPath: FileManager.default.currentDirectoryPath))
}()

/// 本地服务脚本：随资源根解析（替代旧的硬编码路径）。
private let kServerPy = kServerDir.appendingPathComponent("server.py").path

/// 存在且可执行才算可用（符号链接会跟随解析）。
private func isExecutableFile(_ path: String) -> Bool {
    FileManager.default.isExecutableFile(atPath: path)
}

/// Python 解释器解析（优先级从高到低；候选"存在且可执行"才采用，否则继续往后找）：
/// 1) UserDefaults "MolStudioPythonPath"；2) 环境变量 MOLSTUDIO_PYTHON；
/// 3) 打包态 Resources/python/bin/python；
/// 4) 开发态回退：源码根/.venv-rdkit/bin/python（打包态不走这条，防止偷读源码目录）。
/// 返回 (选中的解释器或 nil, 实际尝试过的候选列表——预检失败提示用)。
private func resolvePython() -> (path: String?, tried: [String]) {
    var tried: [String] = []
    if let configured = AppRuntimeConfig.shared.userDefaults.string(forKey: "MolStudioPythonPath"), !configured.isEmpty {
        tried.append(configured)
        if isExecutableFile(configured) { return (configured, tried) }
    }
    if let env = ProcessInfo.processInfo.environment["MOLSTUDIO_PYTHON"], !env.isEmpty {
        tried.append(env)
        if isExecutableFile(env) { return (env, tried) }
    }
    if kIsBundled, let res = Bundle.main.resourceURL {
        let bundled = res.appendingPathComponent("python/bin/python").path
        tried.append(bundled)
        if isExecutableFile(bundled) { return (bundled, tried) }
    }
    if !kIsBundled, let root = kDevRoot {
        let venv = root.appendingPathComponent(".venv-rdkit/bin/python").path
        tried.append(venv)
        if isExecutableFile(venv) { return (venv, tried) }
    }
    return (nil, tried)
}

// MARK: - WebView（接受首次点击，其余交给网页/系统手势）
final class GestureWebView: WKWebView {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

// MARK: - 悬停着色按钮（文件行的重命名/删除小图标）
final class HoverButton: NSButton {
    var hoverTint: NSColor?
    var pressTint: NSColor?
    private var baseTint: NSColor?
    private var tracking: NSTrackingArea?

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let tracking { removeTrackingArea(tracking) }
        let t = NSTrackingArea(rect: bounds,
                               options: [.mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect],
                               owner: self)
        addTrackingArea(t)
        tracking = t
    }
    override func mouseEntered(with event: NSEvent) {
        baseTint = contentTintColor
        contentTintColor = hoverTint ?? baseTint
    }
    override func mouseExited(with event: NSEvent) {
        contentTintColor = baseTint
    }
    override func mouseDown(with event: NSEvent) {
        contentTintColor = pressTint ?? contentTintColor
        super.mouseDown(with: event)
        contentTintColor = baseTint
    }
}

// MARK: - 3D 窗口（普通窗口：可最小化、不置顶、可多开）
final class Viewer3D: NSWindow {
    let web: GestureWebView
    var molblock: String = ""
    var stylePopup: NSPopUpButton?
    var spinCheck: NSButton?
    // 力场未收敛警告 与 示例构型标识 分别存储、分别显示，互不覆盖（D08）
    var warningText: String?
    var stereoNote: String?
    var stereoLabel: NSTextField?
    var stereoHeight: NSLayoutConstraint?

    init(web: GestureWebView) {
        self.web = web
        super.init(contentRect: NSRect(x: 0, y: 0, width: 620, height: 560),
                   styleMask: [.titled, .closable, .miniaturizable, .resizable],
                   backing: .buffered, defer: false)
        isReleasedWhenClosed = false      // 关键：交给 ARC，避免关闭后数组里留悬垂引用
    }
}

// >>> SESSION-MODEL-START
// MARK: - 画布会话状态模型
enum SessionMode: Equatable {
    case canvas   // 结构画布（canvas.html，KET 快照）
}

/// 一个编辑会话：当前快照、已保存基线、文件身份、是否已初始化。
/// dirty = 当前快照 != 已保存基线；新建空文档允许建立干净空基线；
/// 导入得到的内容没有落盘，基线保持空串（显示未保存）。
final class CanvasSession {
    var currentSnapshot: String = ""   // 最近一次从页面读到的完整快照
    var hasSnapshot: Bool = false      // 是否成功读到过快照（区分"空文档"与"还没读过"）
    var savedBaseline: String = ""     // 与本会话文件落盘内容一致的基线；空串 = 从未保存
    var fileURL: URL?
    var initialized: Bool = false      // 会话已建立（打开/导入/新建过）
    // 同版化学格式导出缓存，供页面不可用时保存使用
    var molExport: String?
    var smilesExport: String?
    // S02：上面两个导出缓存对应的 KET 快照版本。轮询只刷新 currentSnapshot，
    // 导出缓存只在离开页面时刷新，两者可能不是同一版；保存 MOL/SMILES 前必须比对。
    var exportSnapshot: String?
    // 同一画布后发的保存使之前仍在等待 WebKit/面板的保存失效。
    var saveGeneration = 0

    var dirty: Bool { hasSnapshot && currentSnapshot != savedBaseline }
}

/// 页面就绪后要注入的画布数据来源：
/// 只有"打开已有文件"和"保存成功"能更新已保存基线；恢复会话不能清 dirty。
enum PendingPayload {
    case none                                   // 无待注入：为尚未初始化的会话建立干净基线
    case newDocument                            // 新建：空画布 + 干净基线 + 清文件身份
    case newPaperDocument(setup: WelcomePaperSetup) // 纸页完成初始化后才提交新会话
    case openCanvasFile(text: String, url: URL) // 打开已有结构文件：载入成功才提交会话身份
    case restoreSession(text: String)           // 恢复内存会话（往返切换）；R02：文本在进入 pending 事务时固定拷贝，注入时不再回读可能被污染的 currentSnapshot
}
// >>> SESSION-MODEL-END

// MARK: - App
final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate,
                         WKScriptMessageHandler, NSWindowDelegate,
                         NSTableViewDataSource, NSTableViewDelegate,
                         NSMenuItemValidation {

    var window: NSWindow!
    var web: GestureWebView!
    private var workspaceBridge: WorkspaceWKWebViewBridge?
    // Internal (not private): native panel extension in WorkspaceNativePanels.swift
    // dispatches through the same coordinator / split controller.
    var workspaceCoordinator: WorkspaceStateCoordinator?
    var workspaceSplitVC: WorkspaceSplitViewController?
    private var workspaceAttachFallbackGeneration: Int?
    private var welcomeRecentsCancellable: AnyCancellable?
    private var acceptanceTelemetryServer: AcceptanceTelemetryServer?
    private var appUserDefaults: UserDefaults { AppRuntimeConfig.shared.userDefaults }
    var server: Process?
    var serverPython: String?   // 预检通过的 Python 解释器路径（服务启动失败提示用，B14）
    // R06：服务进程 stderr 尾部缓存（appendServerStderr 限长防刷屏），启动失败诊断用
    private var serverStderrTail = ""
    private let serverStderrLimit = 8000
    var base: URL { URL(string: "http://127.0.0.1:\(kPort)")! }

    var viewers: [Viewer3D] = []
    var panelAna: NSPanel?
    var anaValues: [String: NSTextField] = [:]

    // 文件管理
    var docsDir: URL!
    var welcomeWin: NSWindow?
    private var welcomeModel: WelcomeViewModel?
    var helpWin: NSWindow?
    var periodicTableWin: NSWindow?
    var fileTable: NSTableView?
    var fileList: [URL] = []
    var dirtyTimer: Timer?
    var emptyLabel: NSTextField?

    // 画布会话；currentFile/isDirty 只通过本会话读写文件身份与修改状态
    var activeMode: SessionMode = .canvas
    var canvasSession = CanvasSession()
    private var documentPDFExporter: DocumentPDFExporter?
    private var documentPDFExportInFlight = false
    private var cleanLayoutInFlight = false
    private var cleanLayoutRequestGeneration = 0
    private var thumbnailGeneration = 0
    var navigationGeneration = 1     // 每次 web.load 递增；旧导航的回调凭序号作废
    var openRequestGeneration = 0    // 打开意图：后发打开/取消/新建/关闭/退出撤销旧请求
    private var pendingPayload: PendingPayload = .none
    private var pendingGeneration = -1

    // R02/R03/R04 共用的导航事务门闸（一个标志，不另造多套）：
    // 从 startNavigation 开始，到目标内容注入成功并取回快照为止。期间：
    // • 轮询不得把结果提交进任何会话（新页面可导出空快照，注入未完成前会污染会话）
    // • 保存与离开确认按 R04/R03 规则处理（无法读取最新内容 → 已建立会话取消、未建立放行）
    // • 退出按读取失败分支处理
    private(set) var navigationInFlight = false
    // R02 补：页面可用性。false = 当前页面内容不可信（载入失败/超时/渲染进程退出/注入失败），
    // 此时一切读取改用内存快照（会话里保存的就是最后一次可信内容），保存/关闭/退出照常可用，
    // 不再出现"页面坏了 → 既存不了也退不了"的死锁。
    private(set) var pageUsable = false
    // S01：页面隔离。失败后为 true，直到用户开始新的导航（startNavigation 清零）：
    // 迟到的 didFinish / 注入回调不能把刚判定失败的页面重新激活，也不能提交文件身份。
    private(set) var pageQuarantined = false
    private var navigationWatchdog: DispatchWorkItem?   // 事务超时看门狗：失败必须有出口

    // 退出等待状态（B02）：一次退出请求只回复一次
    private var terminatePending = false

    #if MOLSTUDIO_SELFTEST
    var selfTestAutoExample = false     // 取证构建：自动选择"查看一个示例"
    var selfTestPreviousApp: NSRunningApplication?   // 取证前的前台 App：结束时还回去
    #endif

    var session: CanvasSession { sessionOf(activeMode) }
    func sessionOf(_ mode: SessionMode) -> CanvasSession { canvasSession }

    /// 当前画布会话的文件身份与修改状态
    var currentFile: URL? {
        get { session.fileURL }
        set { session.fileURL = newValue; updateTitle() }
    }
    var isDirty: Bool { session.dirty }

    private let anaKeys: [(String, String)] = [
        ("formula", "分子式"), ("mw", "分子量"), ("exact_mass", "精确质量"),
        ("logp", "LogP"), ("tpsa", "TPSA"), ("hb", "氢键供体 / 受体"),
        ("rotb", "可旋转键"), ("rings", "环数"), ("heavy", "重原子数"),
        ("ea", "元素分析"), ("smiles", "SMILES"),
    ]

    // MARK: 生命周期
    func applicationDidFinishLaunching(_ note: Notification) {
        AppRuntimeConfig.shared.prepareDirectories()
        startServer()
        setupDocuments()
        buildMenu()
        makeWindow()
        // The opaque native cover goes up before the window is ever shown, so
        // no stale WebView frame or retired web toolbar can appear on launch.
        workspaceSplitVC?.canvasHostViewController.setNavigationCoverVisible(true)
        #if MOLSTUDIO_SELFTEST
        scheduleSelfTest()          // 仅 -D MOLSTUDIO_SELFTEST 的取证构建
        #endif
        window.orderOut(nil)
        installMagnifyMonitor()
        // 欢迎页是常驻启动页：每次启动都显示（启动器式生命周期），
        // 上次打开的文件在列表里预选，双击即可继续。不再自动跳过欢迎页。
        showWelcome()
        startDirtyTracking()
        startAcceptanceObserverIfRequested()
        // B14：预检失败时服务没有启动（startServer 内已弹可读错误），不再空等端口约 30 秒后报第二个错
        if server != nil { waitForServer(attempts: 80) }
    }

    func applicationWillTerminate(_ note: Notification) {
        acceptanceTelemetryServer?.stop()
        workspaceCoordinator?.detachCurrentEpoch()
        server?.terminate()
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    /// 应用退出检查：现读画布快照，确认未保存内容，
    /// 包括仅显示欢迎页、主窗口隐藏时。需要异步读快照/保存时用延迟回复机制：
    /// 本次退出请求只回复一次；等待期间再次 ⌘Q 直接取消（不弹第二个确认、不建第二个保存任务）。
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        openRequestGeneration += 1
        if terminatePending { return .terminateCancel }
        terminatePending = true
        // R02：导航事务进行中（页面正在载入/注入）读取与保存都不可靠，直接取消本次退出
        if navigationInFlight {
            terminatePending = false
            alert("正在载入文档", "页面导航尚未完成，已取消本次退出；请等载入完成后再退出。")
            return .terminateCancel
        }
        let gen = navigationGeneration
        let mode = activeMode
        // R01：退出前再读一次当前页面最新快照，读到的结果必须提交进对应会话
        //（与轮询同一提交入口），dirty 才基于最新内容计算，不能沿用轮询缓存。
        fetchSnapshot(mode) { [weak self] text in
            guard let self else { return }
            guard gen == self.navigationGeneration, mode == self.activeMode else {
                return self.finishTerminate(allow: false)
            }
            if let text {
                self.commitSessionSnapshot(mode, text: text)   // 与轮询同一提交入口（R01）
            } else {
                // R01/R04：读取失败 → 取消退出并提示，不拿缓存"干净"当安全依据；
                // 例外：尚未建立文档的启动空页（欢迎页/启动时）放行，避免启动失败后连退出都被锁死。
                let active = self.sessionOf(mode)
                if active.initialized {
                    // R04 + 逃生阀：默认取消退出，但允许用户明确放弃更改后退出
                    return self.finishTerminate(allow: self.askTerminateDiscardAnyway())
                }
                // 启动空页或已关闭的会话无需读取。
            }
            let candidates: [(SessionMode, CanvasSession)] = [
                (.canvas, self.canvasSession),
            ]
            var dirtyList: [(SessionMode, String)] = []
            for (m, sess) in candidates where sess.dirty {
                let name = sess.fileURL?.lastPathComponent ?? "未命名"
                dirtyList.append((m, name))
            }
            guard !dirtyList.isEmpty else { return self.finishTerminate(allow: true) }
            self.askTerminateSave(dirtyList: dirtyList)
        }
        return .terminateLater
    }

    private func askTerminateSave(dirtyList: [(SessionMode, String)]) {
        let gen = navigationGeneration
        let names = dirtyList.map { $0.1 }.joined(separator: "、")
        let a = NSAlert()
        a.messageText = dirtyList.count == 1
            ? "要保存对“\(names)”的更改吗？"
            : "有 \(dirtyList.count) 个未保存的文档（\(names)）"
        a.informativeText = "退出前如果不保存，这些更改将会丢失。"
        a.alertStyle = .warning
        a.addButton(withTitle: "保存")
        a.addButton(withTitle: "不保存")
        a.addButton(withTitle: "取消")
        let reply = a.runModal()
        guard gen == navigationGeneration else { return finishTerminate(allow: false) }
        switch reply {
        case .alertFirstButtonReturn:
            // 用户点"保存"不等于成功：等所有写盘结果出来才回复退出请求
            saveAllForTerminate(dirtyList.map { $0.0 }) { ok in self.finishTerminate(allow: ok) }
        case .alertSecondButtonReturn:
            finishTerminate(allow: true)
        default:
            finishTerminate(allow: false)
        }
    }

    /// 保存请求取消或失败时中止退出，画布继续保留未保存状态。
    private func saveAllForTerminate(_ modes: [SessionMode], _ done: @escaping (Bool) -> Void) {
        guard let mode = modes.first else {
            // 保存完成后，活动画布也可能又被编辑。
            return verifySavedBeforeLeaving([.canvas], done)
        }
        saveSession(mode, forceSaveAs: false) { ok in
            guard ok else { return done(false) }
            self.saveAllForTerminate(Array(modes.dropFirst()), done)
        }
    }

    /// 写盘成功只说明该次快照已保存；离开前必须再读取当前内容，确认没有后续编辑。
    /// 不自动重试保存，避免持续输入时无限等待；保留当前会话，由用户再次保存或明确放弃。
    private func verifySavedBeforeLeaving(_ modes: [SessionMode],
                                          isValid: @escaping () -> Bool = { true },
                                          _ done: @escaping (Bool) -> Void) {
        guard isValid() else { return done(false) }
        guard let mode = modes.first else { return done(true) }
        let s = sessionOf(mode)
        guard s.initialized || s.hasSnapshot else {
            return verifySavedBeforeLeaving(Array(modes.dropFirst()), isValid: isValid, done)
        }
        let gen = navigationGeneration
        fetchSnapshot(mode) { [weak self] text in
            guard let self else { return done(false) }
            guard isValid(), gen == self.navigationGeneration, !self.navigationInFlight,
                  self.sessionOf(mode) === s else { return done(false) }
            guard let text else {
                self.alert("无法确认保存后的内容", "未能读取当前内容，已取消离开。请稍后重试。")
                return done(false)
            }
            self.commitSessionSnapshot(mode, text: text)
            guard text == s.savedBaseline else {
                self.alert("仍有未保存的更改", "保存期间又产生了修改，已取消离开。当前内容仍保留，请再次保存，或重新选择是否放弃更改。")
                return done(false)
            }
            self.verifySavedBeforeLeaving(Array(modes.dropFirst()), isValid: isValid, done)
        }
    }

    /// 每个退出请求只回复一次；取消退出时结束等待状态。
    /// 禁止在这里再调 terminate()；只有回复允许后才会走到 applicationWillTerminate 停服务。
    private func finishTerminate(allow: Bool) {
        terminatePending = false
        NSApp.reply(toApplicationShouldTerminate: allow)
    }

    /// Dock 图标点击：没有任何可见窗口时重新打开欢迎页
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { showWelcome() }
        return true
    }

    // MARK: 本地服务
    /// 启动预检（B14 解释器半项 + R06 文案修正）：资源与解释器齐了才允许启动服务。
    /// 通过 → 返回解释器路径；失败 → 弹可读错误并返回 nil，调用方必须停止启动流程
    /// （不重试、不启动半截服务）。RDKit 可导入性交给运行期诊断：服务启动即 import rdkit，
    /// 缺库时进程立即退出，startServer 已捕获 stderr，waitForServer 会给出明确诊断。
    /// 取证构建不弹模态框（会挡住用户屏幕、也没有人能点）：只记日志，让脚本自己失败退出。
    private func precheckFailure(_ title: String, _ body: String) {
        #if MOLSTUDIO_SELFTEST
        if ProcessInfo.processInfo.environment["MOLSTUDIO_SELFTEST"] != nil { return }
        #endif
        alert(title, body)
    }

    private func precheckRuntime() -> String? {
        let fm = FileManager.default
        // 资源检查：打包态必须齐全（绝不回退读源码目录）；开发态只看 server.py
        if kIsBundled {
            let required = ["server.py", "stereo.py", "agent_gateway.py", "agent_external_bridge.py", "mcp_server.py", "mcp_response.py",
                            "canvas.html", "help.html", "threed.html",
                            "vendor/ngl.js", "workbench", "ketcher-local", "examples",
                            "agent/app.js", "agent/panel.js", "agent/panel.css", "agent/native-renderer.js", "agent/dist/agent-runtime.js"]
            let missing = required.filter {
                !fm.fileExists(atPath: kServerDir.appendingPathComponent($0).path)
            }
            guard missing.isEmpty else {
                precheckFailure("启动失败：应用包资源不完整",
                      "以下运行资源在应用包内缺失：\n"
                    + missing.map { "• \($0)" }.joined(separator: "\n")
                    + "\n\n资源位置：\(kServerDir.path)\n"
                    + "请重新安装或重新构建 MolStudio.app。")
                return nil
            }
        } else if !fm.fileExists(atPath: kServerPy) {
            precheckFailure("启动失败：找不到服务脚本",
                  "本地化学服务脚本不存在：\n\(kServerPy)\n\n"
                + "开发态从源码树 fusion/ 目录读取服务与网页资源；请确认在源码工作区内构建运行。")
            return nil
        }
        let (py, tried) = resolvePython()
        guard let py else {
            precheckFailure("启动失败：找不到可用的 Python 解释器", pythonRuntimeMissingMessage(tried: tried))
            return nil
        }
        return py
    }

    /// R06：找不到解释器时的提示文案。修正旧文案的不准确说法——
    /// server.py 顶层就 import rdkit，缺 RDKit 时服务进程立即退出（连编辑页面都不会加载），
    /// 不再声称"缺 RDKit 会在使用化学功能时体现"。
    private func pythonRuntimeMissingMessage(tried: [String]) -> String {
        var msg = "MolStudio 需要一个装有 RDKit 的 Python 3 来运行本地化学服务。\n"
        if kIsBundled {
            msg += "应用包应包含解释器；若缺失或损坏，请重新安装或构建应用。\n"
        }
        if tried.isEmpty {
            msg += "\n没有找到任何候选解释器。\n"
        } else {
            msg += "\n已尝试（不存在或不可执行）：\n"
            msg += tried.map { "• \($0)" }.joined(separator: "\n") + "\n"
        }
        msg += "\n配置方法（任选其一）：\n"
        msg += "1. 终端执行：defaults write local.ketcher3d.native MolStudioPythonPath <python路径>\n"
        msg += "2. 启动应用前设置环境变量：MOLSTUDIO_PYTHON=<python路径>\n\n"
        msg += "注意：服务启动时会立即 import rdkit，缺 RDKit 会导致服务进程直接退出，\n"
        msg += "届时应用会显示服务输出的具体报错。可用下面命令自检：\n"
        msg += "<python路径> -B -c \"import rdkit\""
        return msg
    }

    private func startServer() {
        // B14：启动预检。失败时上面已弹可读错误，这里直接停：不重试、不启动半截服务
        guard let python = precheckRuntime() else { return }
        serverPython = python

        // 上次崩溃/强退会遗留孤儿 server.py 占着端口：先清掉，避免用到旧进程旧代码。
        // 隔离候选构建额外防御：绝不清理正式/演示保留端口（8462 / 48975 / 49180）。
        if !AppRuntimeConfig.shared.isIsolated || ![8462, 48975, 49180].contains(kPort) {
            let cleanup = Process()
            cleanup.executableURL = URL(fileURLWithPath: "/bin/bash")
            cleanup.arguments = ["-c",
                "for pid in $(lsof -ti tcp:\(kPort) 2>/dev/null); do "
              + "ps -p $pid -o args= 2>/dev/null | grep -q 'server.py' && kill $pid; done; sleep 0.3"]
            do { try cleanup.run(); cleanup.waitUntilExit() } catch { dbg("server cleanup failed: \(error)") }
        }

        let p = Process()
        p.executableURL = URL(fileURLWithPath: python)
        if let agentConfigDir = AppRuntimeConfig.shared.agentConfigDirectoryURL {
            var env = ProcessInfo.processInfo.environment
            env["MOLSTUDIO_AGENT_CONFIG_DIR"] = agentConfigDir.path
            p.environment = env
        }
        let bundledPython = kServerDir.appendingPathComponent("python/bin/python").standardizedFileURL.path
        // 包内运行时隔离用户 Python 环境；所有打包态解释器都禁止写入 pyc，
        // 避免外置解释器导入包内 stereo.py 时也污染应用包和破坏签名。
        // server.py 显式把自己的资源目录加入 sys.path，-I 不影响 stereo 导入。
        let isBundledPython = kIsBundled && URL(fileURLWithPath: python).standardizedFileURL.path == bundledPython
        let pythonFlags = isBundledPython ? ["-I", "-B"] : (kIsBundled ? ["-B"] : [])
        p.arguments = pythonFlags + [kServerPy, String(kPort)]
        p.standardOutput = FileHandle.nullDevice
        // R06：捕获 stderr（原来是 nullDevice，报错全被丢弃）。
        // 缺 RDKit 时 server.py 顶层 import 即崩，这里留下 stderr 供 waitForServer 诊断。
        let errPipe = Pipe()
        p.standardError = errPipe
        errPipe.fileHandleForReading.readabilityHandler = { [weak self] h in
            let data = h.availableData
            guard !data.isEmpty else { h.readabilityHandler = nil; return }
            let chunk = String(data: data, encoding: .utf8) ?? ""
            DispatchQueue.main.async { self?.appendServerStderr(chunk) }
        }
        // R06：进程退出即记录；若发生在探活成功前，waitForServer 会立即用 stderr 诊断，
        // 不再干等约 24 秒重试耗尽。
        p.terminationHandler = { [weak self] proc in
            DispatchQueue.main.async {
                guard let self, proc === self.server else { return }
                self.dbg("server exited: status=\(proc.terminationStatus)")
            }
        }
        do { try p.run(); server = p } catch { dbg("server start failed: \(error)") }
    }

    /// R06：累积服务 stderr，超出上限丢弃头部（防刷屏/防内存膨胀），保留最后一段用于诊断。
    private func appendServerStderr(_ chunk: String) {
        serverStderrTail += chunk
        if serverStderrTail.count > serverStderrLimit {
            serverStderrTail = String(serverStderrTail.suffix(serverStderrLimit))
        }
    }

    /// R06：服务启动失败的统一诊断（探活耗尽或进程提前退出时调用）。
    /// stderr 含 RDKit 导入错误 → 明确指出解释器缺 RDKit 与处置办法；
    /// 否则附上 stderr 尾部与手动排查命令。
    private func serverFailureDiagnostics(reason: String) -> String {
        let py = serverPython ?? "（未解析到解释器）"
        var msg = reason + "\n\n"
        msg += "Python 解释器：\(py)\n"
        msg += "服务脚本：\(kServerPy)\n"
        let err = serverStderrTail.trimmingCharacters(in: .whitespacesAndNewlines)
        let lowered = err.lowercased()
        if lowered.contains("rdkit"),
           lowered.contains("modulenotfounderror") || lowered.contains("importerror") {
            msg += "\n诊断：解释器缺 RDKit：\(py)\n"
            msg += "请换用含 RDKit 的解释器，或在该解释器的环境中执行 pip install rdkit 后重试。\n"
            msg += "配置方法：defaults write local.ketcher3d.native MolStudioPythonPath <python路径>\n"
            if kIsBundled {
                msg += "如果此前配置了外置解释器，可执行 defaults delete local.ketcher3d.native MolStudioPythonPath 并取消 MOLSTUDIO_PYTHON 后重启，以使用包内解释器。\n"
            }
        } else if lowered.contains("modulenotfounderror") || lowered.contains("importerror") {
            msg += "\n诊断：解释器缺少服务所需的 Python 依赖（见下方错误输出）。\n"
        }
        if !err.isEmpty {
            msg += "\n服务进程 stderr（尾部截取）：\n\(err)\n"
        } else {
            msg += "\n服务进程没有输出错误信息。\n"
        }
        msg += "\n排查建议：\n"
        msg += "• RDKit 是否可导入：'\(py)' -B -c 'import rdkit'\n"
        msg += "• 手动前台运行看具体报错：'\(py)' -B '\(kServerPy)' \(kPort)\n"
        msg += "• 端口是否被占用：lsof -i tcp:\(kPort)"
        return msg
    }

    private func waitForServer(attempts: Int) {
        guard attempts > 0 else {
            // R06：最终失败也走统一诊断（含 stderr 尾部 / RDKit 判断），不再只有笼统提示
            return alert("启动失败",
                serverFailureDiagnostics(reason: "本地化学服务未能启动（127.0.0.1:\(kPort)，探活重试已耗尽）。"))
        }
        // R06：服务进程已提前退出 → 立即读 stderr 诊断（如缺 RDKit 的 ModuleNotFoundError），
        // 不再继续空等端口
        if let p = server, !p.isRunning {
            return alert("启动失败",
                serverFailureDiagnostics(reason: "本地化学服务进程在启动期间退出（退出码 \(p.terminationStatus)）。"))
        }
        var req = URLRequest(url: base.appendingPathComponent("canvas.html"))
        req.timeoutInterval = 2
        URLSession.shared.dataTask(with: req) { [weak self] _, resp, _ in
            guard let self else { return }
            let ok = (resp as? HTTPURLResponse)?.statusCode == 200
            DispatchQueue.main.async {
                if ok {
                    // No startup canvas preload. The main window stays hidden
                    // behind its first-frame loading cover until an explicit
                    // navigation registers a new generation and loads
                    // canvas.html?nativeCanvas=1. Preloading here was the source
                    // of the "old frame / old attach state" flash on 新建画布.
                    self.dbg("service ready; waiting for explicit navigation")
                } else {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) {
                        self.waitForServer(attempts: attempts - 1)
                    }
                }
            }
        }.resume()
    }

    // MARK: 主窗口
    private func makeWindow() {
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1360, height: 860),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.title = "MolStudio"
        window.subtitle = "就绪"
        window.minSize = NSSize(width: 960, height: 640)
        // Follow system Light/Dark appearance so native chrome and macOS 26+ Glass adapt cleanly.
        window.center()
        let frameName = AppRuntimeConfig.shared.isIsolated
            ? "K3DMain-\(AppRuntimeConfig.shared.isolationProfile ?? "isolated")"
            : "K3DMain"
        window.setFrameAutosaveName(frameName)

        let cfg = WKWebViewConfiguration()
        cfg.userContentController.add(self, name: "k3d")
        // WKWebView exposes the async Clipboard API even when its permission check fails.
        // Use Ketcher's existing event clipboard handlers in every editor frame.
        cfg.userContentController.addUserScript(WKUserScript(source: """
            window.molstudioClipboard = window.molstudioClipboard || {};
            window.molstudioClipboard.preferEvents = true;
            """, injectionTime: .atDocumentStart, forMainFrameOnly: false))
        // First-frame canvas mode: inject the Ketcher toolbar-hiding stylesheet
        // into the iframe at document start (before its React bundle renders).
        // It is scoped to the Ketcher document only; the top-level canvas.html
        // hides its own legacy UI with a parse-time stylesheet. Engine button
        // definitions are deliberately left intact: hiding them through
        // hiddenControls breaks Ketcher's default selected tool and its editor
        // instance. This is a real first-frame hide, not a post-attach CSS fix.
        cfg.userContentController.addUserScript(WKUserScript(source: Self.ketcherCanvasModeCSS,
            injectionTime: .atDocumentStart, forMainFrameOnly: false))
        cfg.userContentController.addUserScript(WKUserScript(source: Self.canvasDarkModeCSS,
            injectionTime: .atDocumentStart, forMainFrameOnly: false))
        let gw = GestureWebView(frame: .zero, configuration: cfg)
        gw.setValue(false, forKey: "drawsBackground")
        gw.underPageBackgroundColor = .clear
        gw.navigationDelegate = self
        gw.translatesAutoresizingMaskIntoConstraints = false
        web = gw

        let bridge = WorkspaceWKWebViewBridge(webView: gw, expectedOrigin: "http://127.0.0.1:\(kPort)")
        let callbacks = WorkspaceFileServiceCallbacks(
            onNewCanvas: { [weak self] in self?.actNewDocument() },
            onNewPaper: { [weak self] in self?.actNewPaperDocument() },
            onOpenPanel: { [weak self] in self?.actOpen() },
            onOpenURL: { [weak self] url in self?.openDocument(at: url) },
            onSave: { [weak self] in self?.actSave() },
            onSaveAs: { [weak self] in self?.actSaveAs() },
            onShowWelcome: { [weak self] in self?.actShowWelcome() },
            onRevealInFinder: { url in NSWorkspace.shared.activateFileViewerSelecting([url]) },
            onRenameURL: { [weak self] url in self?.renameRecentFile(at: url) },
            onRemoveRecent: { [weak self] item in self?.removeRecentItem(item) },
            onCleanLayout: { [weak self] in self?.actClean() },
            onGenerate3D: { [weak self] in self?.actGen3D() },
            onCheckStructure: { [weak self] in self?.actCheck() },
            onComputeProperties: { [weak self] in self?.actProps() },
            onExportMol: { [weak self] in self?.actExportMol() },
            onExportMechanismImage: { [weak self] in self?.actExportMechanismImage() },
            onExportDocumentPDF: { [weak self] in self?.actExportDocumentPDF() },
            onCopySmiles: { [weak self] in self?.actCopySmiles() },
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
            },
            onSwitchToCanvasMode: { [weak self] in self?.actSwitchToCanvasMode() },
            onSwitchToPaperMode: { [weak self] in self?.actSwitchToPaperMode() },
            onPaperSetup: { [weak self] in self?.actPaperSetup() },
            onAddPaperPage: { [weak self] in self?.actAddPaperPage() },
            onRemoveBlankLastPage: { [weak self] in self?.actRemoveBlankLastPage() },
            onInsertImageIntoDocument: { [weak self] in self?.actInsertImageIntoDocument() },
            onInsertFileIntoDocument: { [weak self] in self?.actInsertFileIntoDocument() }
        )
        let coordinator = WorkspaceStateCoordinator(bridge: bridge, fileCallbacks: callbacks)
        coordinator.beginNavigation(generation: navigationGeneration)
        let splitVC = WorkspaceSplitViewController(
            coordinator: coordinator,
            initialRecentItems: welcomeModel?.recentItems ?? [],
            canvasContentView: gw,
            backdropTone: .cleanWhite
        )
        workspaceBridge = bridge
        workspaceCoordinator = coordinator
        workspaceSplitVC = splitVC
        splitVC.canvasHostViewController.onRetryNavigation = { [weak self] in self?.reloadCurrentPage() }
        splitVC.canvasHostViewController.onReturnToWelcome = { [weak self] in self?.showWelcome() }
        splitVC.canvasHostViewController.onSaveInMemorySnapshot = { [weak self] in self?.actSaveAs() }
        splitVC.canvasHostViewController.onInsertImageRequested = { [weak self] in self?.actInsertImageIntoDocument() }
        splitVC.canvasHostViewController.onPeriodicTableRequested = { [weak self] anchor in
            self?.presentPeriodicTable(from: anchor)
        }
        splitVC.canvasHostViewController.onMoreTemplatesRequested = { [weak self] anchor in
            self?.presentMoreTemplates(from: anchor)
        }
        splitVC.canvasHostViewController.onPropertiesRequested = { [weak self] anchor in
            self?.presentNativeProperties(from: anchor)
        }
        splitVC.toolbarController.onShowAdvancedToolsMenu = { [weak self] anchor in
            self?.presentAdvancedToolsMenu(from: anchor)
        }

        window.contentViewController = splitVC
        splitVC.installWindowChrome(on: window)

        window.delegate = self          // B01：主窗口关闭确认（windowShouldClose）必需
        installClipboardShortcuts()
        #if MOLSTUDIO_SELFTEST
        // 取证构建：先挪到屏幕外再显示，用户屏幕上不会闪出一个窗口
        if ProcessInfo.processInfo.environment["MOLSTUDIO_SELFTEST"] != nil {
            window.setFrameOrigin(NSPoint(x: -6000, y: -6000))
        }
        #endif
        #if MOLSTUDIO_SELFTEST
        // 取证构建：窗口立刻最小化，不盖住用户正在用的 MolStudio
        if ProcessInfo.processInfo.environment["MOLSTUDIO_SELFTEST"] != nil {
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            window.miniaturize(nil)
        }
        #endif
    }

    private func setStatus(_ s: String) { window.subtitle = s }

    /// Control 别名兜底；Command 由标准菜单快捷键和 AppKit responder chain 处理。
    private var clipboardMonitor: Any?
    private func installClipboardShortcuts() {
        guard clipboardMonitor == nil else { return }
        clipboardMonitor = NSEvent.addLocalMonitorForEvents(matching: [.keyDown]) { [weak self] ev in
            guard let self else { return ev }
            // 只管主画布窗口；对话框、3D 窗口里的输入框照旧走系统
            guard let key = NSApp.keyWindow, key === self.window else { return ev }
            let mods = ev.modifierFlags.intersection(.deviceIndependentFlagsMask)
            guard mods.contains(.control), !mods.contains(.command), !mods.contains(.option), !mods.contains(.shift) else { return ev }
            guard !ev.isARepeat, let ch = ev.charactersIgnoringModifiers?.lowercased() else { return ev }
            return self.handleControlClipboardKeyEvent(ev, character: ch, in: key)
        }
    }

    func handleControlClipboardKeyEvent(_ event: NSEvent, character: String, in keyWindow: NSWindow) -> NSEvent? {
        guard keyWindow === window else { return event }
        let owner = WorkspaceFocusRouter.classifyFocusOwner(in: keyWindow, canvasView: web)
        // 原生文本框/只读可选中回复及原生控件保留自己的键盘语义，不吞事件
        guard owner == .canvas || owner == .none else { return event }
        let handled: Bool
        switch character {
        case "c": handled = performCopy()
        case "x": handled = performCut()
        case "v": handled = performPaste()
        default: return event
        }
        return handled ? nil : event
    }

    // MARK: 菜单
    private func buildMenu() {
        let main = NSMenu()

        let appItem = NSMenuItem()
        main.addItem(appItem)
        let appMenu = NSMenu(title: "MolStudio")
        appItem.submenu = appMenu
        appMenu.addItem(withTitle: "关于 MolStudio", action: #selector(actAbout), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "隐藏", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(withTitle: "退出", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")

        main.addItem(submenu("文件", [
            // 欢迎页用 ⇧⌘H（H=Home）。⇧⌘W 与系统"关闭窗口 ⌘W / 关闭全部 ⌥⌘W"的联想冲突。
            ("欢迎页…", #selector(actShowWelcome), "h", [.command, .shift]),
            ("新建画布", #selector(actNewDocument), "n", [.command]),
            ("新建纸页", #selector(actNewPaperDocument), "n", [.command, .shift]),
            ("打开…", #selector(actOpen), "o", [.command]),
            ("-", nil, "", []),
            ("保存", #selector(actSave), "s", [.command]),
            ("另存为…", #selector(actSaveAs), "s", [.command, .shift]),
            ("-", nil, "", []),
            // 系统惯例：⌘W 关闭当前窗口（帮助/3D 窗口也走这里；主窗口仍由 windowShouldClose 把关）
            ("关闭窗口", #selector(actCloseWindow(_:)), "w", [.command]),
            ("-", nil, "", []),
            ("导出 MOL…", #selector(actExportMol), "", []),
            ("导出机理图…", #selector(actExportMechanismImage), "", []),
            ("导出文档 PDF…", #selector(actExportDocumentPDF), "", []),
            ("复制 SMILES", #selector(actCopySmiles), "", []),
        ]))

        main.addItem(submenu("编辑", [
            ("撤销", #selector(actUndo), "z", [.command]),
            ("重做", #selector(actRedo), "z", [.command, .shift]),
            ("-", nil, "", []),
            ("剪切", #selector(actCut), "x", [.command]),
            ("复制", #selector(actCopy), "c", [.command]),
            ("粘贴", #selector(actPaste), "v", [.command]),
            ("-", nil, "", []),
            ("全选", #selector(actSelectAll), "a", [.command]),
            ("删除所选", #selector(actDeleteSel), "\u{8}", []),
        ]))

        main.addItem(submenu("视图", [
            ("显示/隐藏文库边栏", #selector(actToggleSidebar), "s", [.command, .control]),
            ("显示/隐藏检查器", #selector(actToggleInspector), "i", [.command]),
            ("AI 化学助手", #selector(actToggleAgent), "j", [.command]),
            ("-", nil, "", []),
            ("放大", #selector(actZoomIn), "=", [.command]),
            ("缩小", #selector(actZoomOut), "-", [.command]),
            ("实际大小 (100%)", #selector(actZoomReset), "0", [.command]),
            ("适应视图", #selector(actZoomFit), "9", [.command]),
            ("-", nil, "", []),
            ("分析窗口", #selector(actProps), "a", [.command, .shift]),
            ("3D 预览窗口", #selector(actToggle3D), "3", [.command, .shift]),
        ]))

        main.addItem(submenu("结构", [
            ("检查结构…", #selector(actCheck), "", []),
            ("清理结构", #selector(actClean), "k", [.command, .shift]),
            ("-", nil, "", []),
            ("计算性质…", #selector(actProps), "p", [.command, .shift]),
            ("生成 3D 预览", #selector(actGen3D), "d", [.command, .shift]),
        ]))

        main.addItem(submenu("纸页", [
            ("切换为纸页文档", #selector(actSwitchToPaperMode), "", []),
            ("切换为无边画布", #selector(actSwitchToCanvasMode), "", []),
            ("-", nil, "", []),
            ("页面设置…", #selector(actPaperSetup), "", []),
            ("新增页面", #selector(actAddPaperPage), "", []),
            ("删除空白末页", #selector(actRemoveBlankLastPage), "", []),
            ("-", nil, "", []),
            ("插入图片到纸页…", #selector(actInsertImageIntoDocument), "", []),
            ("插入 .molwork / .ket 到纸页…", #selector(actInsertFileIntoDocument), "", []),
        ]))

        let winItem = NSMenuItem()
        main.addItem(winItem)
        let winMenu = NSMenu(title: "窗口")
        winItem.submenu = winMenu
        winMenu.addItem(withTitle: "最小化", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        winMenu.addItem(withTitle: "缩放", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        NSApp.windowsMenu = winMenu

        // 帮助菜单：真实可用的本地帮助页（help.html，随包分发，不联网）。
        // 不设 NSApp.helpMenu：那会让系统往菜单里插一个"搜索"栏并占用 ⌘?。
        // 菜单标题"帮助"本身仍会被 macOS 识别为帮助菜单（搜索栏由系统加），
        // 所以这里不绑快捷键——⌘? 归系统的帮助搜索，本条目点菜单打开。
        let helpItem = NSMenuItem()
        main.addItem(helpItem)
        let helpMenu = NSMenu(title: "帮助")
        helpItem.submenu = helpMenu
        let helpEntry = NSMenuItem(title: "MolStudio 帮助", action: #selector(actShowHelp), keyEquivalent: "")
        helpEntry.target = self
        helpMenu.addItem(helpEntry)

        NSApp.mainMenu = main
    }

    private func submenu(_ title: String,
                         _ items: [(String, Selector?, String, NSEvent.ModifierFlags)]) -> NSMenuItem {
        let item = NSMenuItem()
        let menu = NSMenu(title: title)
        item.submenu = menu
        for (t, sel, key, mods) in items {
            if t == "-" { menu.addItem(.separator()); continue }
            let mi = NSMenuItem(title: t, action: sel, keyEquivalent: key)
            mi.keyEquivalentModifierMask = mods
            mi.target = self
            menu.addItem(mi)
        }
        return item
    }

    // MARK: JS 桥
    private func js(_ body: String, _ done: ((Any?) -> Void)? = nil) {
        guard let web else { return }
        web.callAsyncJavaScript(body, arguments: [:], in: nil, in: .page) { result in
            switch result {
            case .success(let v): done?(v)
            case .failure(let e): self.dbg("JS: \(e)"); done?(nil)
            }
        }
    }

    /// 带成功标识的求值（B03 实现步骤 6）：JS 失败时 ok=false。
    /// 关键数据流（快照/载入/就绪探测）必须用它，不得把 nil 当成功去清 pending、刷基线或报"已打开"。
    private func jsValue(_ body: String, _ done: @escaping (_ value: Any?, _ ok: Bool) -> Void) {
        guard let web else { return done(nil, false) }
        web.callAsyncJavaScript(body, arguments: [:], in: nil, in: .page) { result in
            switch result {
            case .success(let v): done(v, true)
            case .failure(let e): self.dbg("JS: \(e)"); done(nil, false)
            }
        }
    }

    private func currentSmiles(_ done: @escaping (String?) -> Void) {
        js("return await window.k3dAPI.getSmiles()") { v in
            done((v as? String)?.trimmingCharacters(in: .whitespacesAndNewlines))
        }
    }

    private func currentMolfile(_ done: @escaping (String?) -> Void) {
        js("return await window.k3dAPI.getMolfile()") { done($0 as? String) }
    }

    private func selectionAtoms(_ done: @escaping ([Int]) -> Void) {
        js("return String(window.k3dAPI.selectionAtoms ? window.k3dAPI.selectionAtoms() : '[]')") { v in
            let str = (v as? String) ?? "[]"
            let data = str.data(using: .utf8) ?? Data()
            let arr = (try? JSONSerialization.jsonObject(with: data)) as? [Int] ?? []
            done(arr)
        }
    }

    private func selectionPoints(_ done: @escaping ([[Double]]) -> Void) {
        js("return String(window.k3dAPI.selectionPoints ? window.k3dAPI.selectionPoints() : '[]')") { v in
            let str = (v as? String) ?? "[]"
            let data = str.data(using: .utf8) ?? Data()
            let arr = (try? JSONSerialization.jsonObject(with: data)) as? [[Double]] ?? []
            done(arr)
        }
    }

    private func selectionAtomCount(_ done: @escaping (Int) -> Void) {
        js("return String(window.k3dAPI.selectionCount ? window.k3dAPI.selectionCount() : 0)") { v in
            done(Int((v as? String) ?? "0") ?? 0)
        }
    }

    // MARK: 后端
    private func post(_ path: String, data: String, done: @escaping ([String: Any]?) -> Void) {
        var req = URLRequest(url: base.appendingPathComponent(path))
        req.httpMethod = "POST"
        req.timeoutInterval = 60
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["data": data])
        URLSession.shared.dataTask(with: req) { d, _, _ in
            var obj: [String: Any]?
            if let d, let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any] { obj = j }
            DispatchQueue.main.async { done(obj) }
        }.resume()
    }

    private func postPayload(_ path: String, _ payload: [String: Any],
                             done: @escaping ([String: Any]?) -> Void) {
        var req = URLRequest(url: base.appendingPathComponent(path))
        req.httpMethod = "POST"
        req.timeoutInterval = 60
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: payload)
        URLSession.shared.dataTask(with: req) { d, _, _ in
            var obj: [String: Any]?
            if let d, let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any] { obj = j }
            DispatchQueue.main.async { done(obj) }
        }.resume()
    }

    // MARK: 文件 / 编辑
    // 注：原 actNew / actClear（无确认直接清空画布并把结果刷成已保存基线）已删除：
    // 菜单与网页桥都不再引用它们，留着就是一条潜在的静默丢数据路径。
    private var targetEditWindow: NSWindow? { NSApp.keyWindow ?? window }

    private func validateMenuEditAction(_ selector: Selector, editWindow: NSWindow?, canUseCanvas: Bool) -> Bool {
        let isMainCanvasWindow = (editWindow === window)
        let canFallbackCanvas = isMainCanvasWindow && canUseCanvas && web != nil
        return WorkspaceFocusRouter.validateEditAction(
            selector,
            in: editWindow,
            canvasView: isMainCanvasWindow ? web : nil,
            coordinator: isMainCanvasWindow ? workspaceCoordinator : nil,
            legacyClipboardValidator: canFallbackCanvas ? { _ in true } : { _ in false },
            legacyEditValidator: canFallbackCanvas ? { _ in true } : { _ in false }
        )
    }

    func validateMenuItem(_ menuItem: NSMenuItem) -> Bool {
        guard let action = menuItem.action else { return true }
        let editWindow = targetEditWindow
        let canUseCanvas = pageUsable && !navigationInFlight
        let isPaper = (workspaceCoordinator?.uiState.viewport.mode == .paper) || snapshotHasDocument(session.currentSnapshot)

        switch action {
        case #selector(actUndo):
            return validateMenuEditAction(#selector(WorkspaceSplitViewController.undo(_:)), editWindow: editWindow, canUseCanvas: canUseCanvas)
        case #selector(actRedo):
            return validateMenuEditAction(#selector(WorkspaceSplitViewController.redo(_:)), editWindow: editWindow, canUseCanvas: canUseCanvas)
        case #selector(actCut):
            return validateMenuEditAction(#selector(NSText.cut(_:)), editWindow: editWindow, canUseCanvas: canUseCanvas)
        case #selector(actCopy):
            return validateMenuEditAction(#selector(NSText.copy(_:)), editWindow: editWindow, canUseCanvas: canUseCanvas)
        case #selector(actPaste):
            return validateMenuEditAction(#selector(NSText.paste(_:)), editWindow: editWindow, canUseCanvas: canUseCanvas)
        case #selector(actSelectAll):
            return validateMenuEditAction(#selector(NSText.selectAll(_:)), editWindow: editWindow, canUseCanvas: canUseCanvas)
        case #selector(actDeleteSel):
            return validateMenuEditAction(#selector(NSText.delete(_:)), editWindow: editWindow, canUseCanvas: canUseCanvas)
        case #selector(actToggleSidebar), #selector(actToggleInspector), #selector(actToggleAgent):
            return workspaceSplitVC != nil
        case #selector(actZoomIn), #selector(actZoomOut):
            if let coord = workspaceCoordinator, coord.isCanvasSurfaceReady(.zoomPalette) {
                return canUseCanvas && coord.isCommandSupported("zoom.by")
            }
            return canUseCanvas
        case #selector(actZoomReset):
            if let coord = workspaceCoordinator, coord.isCanvasSurfaceReady(.zoomPalette) {
                return canUseCanvas && coord.isCommandSupported("zoom.toPercent")
            }
            return canUseCanvas
        case #selector(actZoomFit):
            return canUseCanvas && (workspaceCoordinator?.isCanvasSurfaceReady(.zoomPalette) == true) && (workspaceCoordinator?.isCommandSupported("zoom.fit") == true)
        case #selector(actSave), #selector(actSaveAs), #selector(actExportMol), #selector(actExportMechanismImage),
             #selector(actExportDocumentPDF), #selector(actCopySmiles), #selector(actCheck), #selector(actClean),
             #selector(actProps), #selector(actGen3D):
            return canUseCanvas
        case #selector(actSwitchToPaperMode):
            return canUseCanvas && !isPaper
        case #selector(actSwitchToCanvasMode), #selector(actPaperSetup), #selector(actAddPaperPage),
             #selector(actInsertImageIntoDocument), #selector(actInsertFileIntoDocument):
            return canUseCanvas && isPaper
        case #selector(actRemoveBlankLastPage):
            let canRemove = workspaceCoordinator?.uiState.document?.canRemoveLastPage ?? true
            return canUseCanvas && isPaper && canRemove
        default:
            return true
        }
    }

    @objc func actToggleSidebar() { workspaceSplitVC?.toggleLibrarySidebar(nil) }
    @objc func actToggleInspector() { workspaceSplitVC?.toggleInspectorPanel(nil) }
    @objc func actToggleAgent() { workspaceSplitVC?.toggleAgentInspectorTab(nil) }

    @discardableResult
    private func routeEditAction(_ selector: Selector, sender: Any? = nil) -> Bool {
        let editWindow = targetEditWindow
        let isMainCanvasWindow = (editWindow === window)
        let canFallbackCanvas = isMainCanvasWindow && pageUsable && !navigationInFlight && web != nil
        return WorkspaceFocusRouter.performEditAction(
            selector,
            sender: sender,
            in: editWindow,
            canvasView: isMainCanvasWindow ? web : nil,
            coordinator: isMainCanvasWindow ? workspaceCoordinator : nil,
            legacyClipboardHandler: canFallbackCanvas ? { [weak self] action, src in
                self?.performCanvasClipboard(action, sender: src) ?? false
            } : nil,
            legacyClipboardValidator: canFallbackCanvas ? { _ in true } : { _ in false },
            legacyEditHandler: canFallbackCanvas ? { [weak self] action, src in
                self?.performLegacyCanvasEdit(action, sender: src) ?? false
            } : nil,
            legacyEditValidator: canFallbackCanvas ? { _ in true } : { _ in false }
        )
    }

    @discardableResult
    private func performLegacyCanvasEdit(_ action: WorkspaceLegacyCanvasEditAction, sender: Any? = nil) -> Bool {
        guard pageUsable, !navigationInFlight, web != nil else { return false }
        switch action {
        case .undo:
            js("window.k3dAPI && window.k3dAPI.undo && window.k3dAPI.undo()")
            return true
        case .redo:
            js("window.k3dAPI && window.k3dAPI.redo && window.k3dAPI.redo()")
            return true
        case .delete:
            js("window.k3dAPI && window.k3dAPI.deleteSel && window.k3dAPI.deleteSel()")
            return true
        case .selectAll:
            let editWindow = targetEditWindow
            let gen = navigationGeneration
            jsValue("return !!(window.k3dAPI && window.k3dAPI.selectAll && window.k3dAPI.selectAll())") { value, ok in
                guard gen == self.navigationGeneration else { return }
                if let activeKey = NSApp.keyWindow, activeKey !== editWindow { return }
                if !ok || (value as? Bool) != true {
                    let target: Any? = (NSApp.keyWindow === editWindow) ? nil : self.web
                    _ = NSApp.sendAction(#selector(NSText.selectAll(_:)), to: target, from: sender)
                }
            }
            return true
        }
    }

    @objc func actUndo() {
        _ = routeEditAction(#selector(WorkspaceSplitViewController.undo(_:)))
    }

    @objc func actRedo() {
        _ = routeEditAction(#selector(WorkspaceSplitViewController.redo(_:)))
    }

    @objc func actSelectAll() {
        if routeEditAction(#selector(NSText.selectAll(_:))) {
            return
        }
        if targetEditWindow !== window {
            _ = NSApp.sendAction(#selector(NSText.selectAll(_:)), to: nil, from: nil)
        }
    }

    @objc func actDeleteSel() {
        _ = routeEditAction(#selector(NSText.delete(_:)))
    }

    @objc func actZoomIn() {
        if let coord = workspaceCoordinator, coord.isCanvasSurfaceReady(.zoomPalette), coord.isCommandSupported("zoom.by") {
            let size = web?.bounds.size ?? .zero
            coord.zoomBy(factor: 1.25, anchorCSSPoint: CGPoint(x: size.width * 0.5, y: size.height * 0.5))
        } else {
            js("window.k3dAPI.zoomBy(1.25)")
        }
    }

    @objc func actZoomOut() {
        if let coord = workspaceCoordinator, coord.isCanvasSurfaceReady(.zoomPalette), coord.isCommandSupported("zoom.by") {
            let size = web?.bounds.size ?? .zero
            coord.zoomBy(factor: 0.8, anchorCSSPoint: CGPoint(x: size.width * 0.5, y: size.height * 0.5))
        } else {
            js("window.k3dAPI.zoomBy(0.8)")
        }
    }

    @objc func actZoomReset() {
        if let coord = workspaceCoordinator, coord.isCanvasSurfaceReady(.zoomPalette), coord.isCommandSupported("zoom.toPercent") {
            coord.zoomToPercent(100)
        } else {
            js("window.k3dAPI.zoomToPercent ? window.k3dAPI.zoomToPercent(100) : null")
        }
    }

    @objc func actZoomFit() {
        guard let coord = workspaceCoordinator, coord.isCanvasSurfaceReady(.zoomPalette), coord.isCommandSupported("zoom.fit") else { return }
        let target = coord.uiState.viewport.mode == .paper ? "page" : "content"
        coord.zoomFit(target: target)
    }

    // MARK: 剪贴板（编辑菜单 ⌘X/⌘C/⌘V）
    // 菜单和快捷键都发送标准 copy:/cut:/paste:，由 WebKit 派发真实 DOM 事件。
    // Ketcher 处理原生内容；机理层在同一事件入口仅扩展弯箭头和鱼钩。

    /// 机理载荷只写自定义类型、不写纯文本：粘进文本框不会蹦出一串 JSON，
    /// 而「剪贴板被别的内容覆盖」时这个类型自然消失，粘贴就自动回到原生路径。
    /// Injected at document start into the Ketcher iframe so the retired web
    /// toolbars are never painted, even for a single frame. `!important` and
    /// an all-frame WKUserScript mean a late detach/attach callback cannot
    /// restore them. Scoped by Ketcher's own root id to avoid touching other
    /// pages (help.html / threed.html) served by the same WKWebView.
    static let ketcherCanvasModeCSS = """
    (function () {
      if (location.pathname.indexOf('/ketcher/') !== 0) return;
      if (document.getElementById('molstudio-ketcher-canvas-mode')) return;
      var style = document.createElement('style');
      style.id = 'molstudio-ketcher-canvas-mode';
      style.textContent = [
        '[data-testid="top-toolbar"],',
        '[data-testid="left-toolbar"],',
        '[data-testid="right-toolbar"],',
        '[data-testid="bottom-toolbar"],',
        '[data-testid="left-toolbar-buttons"],',
        '[data-mech-tool],',
        '[data-mech-actions],',
        '[data-mech-action],',
        '.MuiAppBar-root',
        '{ display: none !important; visibility: hidden !important; pointer-events: none !important; }',
        'html, body { margin: 0 !important; padding: 0 !important; overflow: hidden !important; }'
      ].join('\\n');
      (document.head || document.documentElement).appendChild(style);
    })();
    """

    /// Adaptive Dark Mode canvas stylesheet injected at document start for nativeCanvas=1 & /ketcher/.
    /// Infinite Canvas uses a deep charcoal background with hue-preserving light chemical strokes;
    /// Paper Mode keeps crisp white paper sheets on a dark desk. Exports clone clean SVGs separately.
    static let canvasDarkModeCSS = """
    (function () {
      var isKetcher = location.pathname.indexOf('/ketcher/') === 0;
      var isNativeCanvas = location.search.indexOf('nativeCanvas=1') !== -1;
      if (!isKetcher && !isNativeCanvas) return;
      if (document.getElementById('molstudio-canvas-dark-mode')) return;
      var style = document.createElement('style');
      style.id = 'molstudio-canvas-dark-mode';
      if (isKetcher) {
        style.textContent = [
          '@media (prefers-color-scheme: dark) {',
          '  html, body, #root, main,',
          '  .Ketcher-root, .Ketcher-polymer-editor-root,',
          '  [class*="Editor-module_editorsWrapper"],',
          '  [class*="Editor-module_editor"],',
          '  [class*="App-module_app"],',
          '  [class*="App-module_left"],',
          '  [class*="App-module_right"],',
          '  [class*="App-module_canvas"],',
          '  [class*="StructEditor-module_canvas"],',
          '  [class*="StructEditor-module_intermediateCanvas"] {',
          '    background-color: #1a1a1a !important;',
          '    --color-background-primary: #1a1a1a;',
          '    --color-background-canvas: #1a1a1a;',
          '    color-scheme: dark;',
          '  }',
          '  [class*="StructEditor-module_canvas"] ::-webkit-scrollbar,',
          '  [class*="StructEditor-module_intermediateCanvas"] ::-webkit-scrollbar {',
          '    background-color: #202227 !important;',
          '  }',
          '  [class*="StructEditor-module_canvas"] ::-webkit-scrollbar-thumb,',
          '  [class*="StructEditor-module_intermediateCanvas"] ::-webkit-scrollbar-thumb {',
          '    background-color: rgba(136, 146, 160, 0.52) !important;',
          '  }',
          '  [class*="StructEditor-module_measureLog"] {',
          '    background-color: #25272d !important;',
          '    border-color: #3a3f4b !important;',
          '    color: #e6e9ef !important;',
          '  }',
          '  [class*="StructEditor-module_spinnerOverlay"] {',
          '    background-color: rgba(26, 26, 26, 0.72) !important;',
          '  }',
          '  [class*="StructEditor-module_canvas"] svg:not(g svg):not(:has([data-page-id])) {',
          '    background-color: #ffffff !important;',
          '    filter: invert(0.898) hue-rotate(180deg);',
          '  }',
          '  [class*="StructEditor-module_canvas"] svg:not(g svg):not(:has([data-page-id])) [data-doc-kind="image"] image {',
          '    filter: invert(1) hue-rotate(180deg);',
          '  }',
          '  body:not(:has([data-page-id])) #molstudio-document-editor {',
          '    filter: invert(0.898) hue-rotate(180deg);',
          '  }',
          '  body:has([data-page-id]),',
          '  body:has([data-page-id]) #root,',
          '  body:has([data-page-id]) main,',
          '  body:has([data-page-id]) .Ketcher-root,',
          '  body:has([data-page-id]) [class*="Editor-module_editorsWrapper"],',
          '  body:has([data-page-id]) [class*="Editor-module_editor"],',
          '  body:has([data-page-id]) [class*="App-module_app"],',
          '  body:has([data-page-id]) [class*="App-module_left"],',
          '  body:has([data-page-id]) [class*="App-module_right"],',
          '  body:has([data-page-id]) [class*="App-module_canvas"],',
          '  body:has([data-page-id]) [class*="StructEditor-module_canvas"],',
          '  [class*="StructEditor-module_canvas"] svg:not(g svg):has([data-page-id]) {',
          '    background-color: #1d1f23 !important;',
          '    filter: none !important;',
          '  }',
          '  rect[data-document-background="1"] {',
          '    fill: #1d1f23 !important;',
          '  }',
          '  g#molstudio-page-layer > text {',
          '    fill: #9ba5b4 !important;',
          '  }',
          '}'
        ].join('\\n');
      } else {
        style.textContent = [
          '@media (prefers-color-scheme: dark) {',
          '  html, body { background: #1a1a1a !important; color-scheme: dark; }',
          '  body[data-doc-mode="paper"] { background: #1d1f23 !important; }',
          '}'
        ].join('\\n');
      }
      (document.head || document.documentElement).appendChild(style);
    })();
    """

    static let mechPasteboardType = NSPasteboard.PasteboardType("local.molstudio.mechanism")

    @discardableResult
    private func writeMechanismClipboard(_ text: String) -> Bool {
        let pb = NSPasteboard.general
        pb.clearContents()
        pb.declareTypes([Self.mechPasteboardType], owner: nil)
        return pb.setString(text, forType: Self.mechPasteboardType)
    }

    private func readMechanismClipboard() -> String? {
        guard let s = NSPasteboard.general.string(forType: Self.mechPasteboardType), !s.isEmpty else {
            return nil
        }
        return s
    }

    @discardableResult
    private func performCanvasClipboard(_ action: WorkspaceCanvasClipboardAction, sender: Any? = nil) -> Bool {
        let selector: Selector
        switch action {
        case .copy: selector = #selector(NSText.copy(_:))
        case .cut: selector = #selector(NSText.cut(_:))
        case .paste: selector = #selector(NSText.paste(_:))
        }
        let command = action.rawValue
        let sourceWindow = targetEditWindow
        let send = {
            if let keyWin = NSApp.keyWindow, keyWin === sourceWindow {
                if !NSApp.sendAction(selector, to: nil, from: sender) {
                    self.dbg("CLIP standard \(command) has no responder")
                }
            } else if let sourceWindow, sourceWindow === self.window, let web = self.web {
                guard WorkspaceFocusRouter.classifyFocusOwner(in: sourceWindow, canvasView: web) != .nativeText else {
                    self.dbg("CLIP standard \(command) yielded to native text")
                    return
                }
                if sourceWindow.firstResponder !== web {
                    sourceWindow.makeFirstResponder(web)
                }
                if !NSApp.sendAction(selector, to: web, from: sender) {
                    self.dbg("CLIP standard \(command) direct web target failed")
                }
            } else {
                self.dbg("CLIP standard \(command) has no key window")
            }
        }
        let gen = navigationGeneration
        if action == .paste, let mechText = readMechanismClipboard() {
            let pasteJS = """
            if (window.k3dAPI && window.k3dAPI.focusedIsEditable && window.k3dAPI.focusedIsEditable()) {
              return "editable";
            }
            if (window.k3dAPI && window.k3dAPI.mechPaste) {
              const pasted = await window.k3dAPI.mechPaste(\(jsonLiteral(mechText)));
              return pasted ? "pasted" : "fallback";
            }
            return "fallback";
            """
            jsValue(pasteJS) { value, ok in
                guard gen == self.navigationGeneration else { return }
                if let activeKey = NSApp.keyWindow, activeKey !== sourceWindow {
                    self.dbg("CLIP standard paste cancelled after focus changed")
                    return
                }
                let state = (ok ? value as? String : nil) ?? "fallback"
                if state != "pasted" {
                    send()
                }
            }
            return true
        }
        let expr = "return !!(window.k3dAPI && window.k3dAPI.prepareNativeClipboard && window.k3dAPI.prepareNativeClipboard(\(jsonLiteral(command))))"
        jsValue(expr) { _, ok in
            guard gen == self.navigationGeneration else { return }
            if let activeKey = NSApp.keyWindow, activeKey !== sourceWindow {
                self.dbg("CLIP standard \(command) cancelled after focus changed")
                return
            }
            if !ok { self.dbg("CLIP standard \(command) preparation failed") }
            send()
        }
        return true
    }

    @discardableResult
    private func performCopy() -> Bool {
        routeEditAction(#selector(NSText.copy(_:)))
    }

    @discardableResult
    private func performCut() -> Bool {
        routeEditAction(#selector(NSText.cut(_:)))
    }

    @discardableResult
    private func performPaste() -> Bool {
        routeEditAction(#selector(NSText.paste(_:)))
    }

    @objc func actCopy() {
        _ = performCopy()
    }

    @objc func actCut() {
        _ = performCut()
    }

    @objc func actPaste() {
        _ = performPaste()
    }

    // MARK: 纸页模式操作（宿主驱动对话 + JS 文档接口）
    @objc func actSwitchToPaperMode() {
        guard pageUsable, !navigationInFlight else { return }
        let setup = welcomeModel?.paperSetup ?? WelcomePaperSetup()
        let gen = navigationGeneration
        let finish: (Bool, String?) -> Void = { [weak self] ok, message in
            guard let self, gen == self.navigationGeneration else { return }
            if ok {
                self.pollActiveSnapshot(); self.updateTitle()
                WorkspaceFocusRouter.restoreCanvasFocusIfSafe(in: self.window, canvasView: self.web)
            } else { self.alert("切换失败", message ?? "当前画布暂无法切换为纸页文档。") }
        }
        // setPageSetup preserves objects; init() would create a fresh document.
        let args: WorkspaceJSONObject = [
            "mode": .string("paper"),
            "size": .string(setup.size.rawValue),
            "orientation": .string(setup.orientation.rawValue),
            "marginMm": .number(setup.margins.top * 25.4 / 72)
        ]
        if let coord = workspaceCoordinator, coord.isCommandSupported("document.page.setup") {
            coord.dispatchCommand(id: "document.page.setup", args: args) { result in
                if case .success(let reply) = result { finish(reply.ok, reply.error?.message) }
                else { finish(false, "桥接命令未返回结果") }
            }
        } else if let opts = setup.toJSONString() {
            jsValue("if (!window.k3dAPI?.document?.init) return false; const r = await window.k3dAPI.document.init(\(opts)); return r?.mode === 'paper';") { value, ok in
                finish(ok && (value as? Bool) == true, "当前画布暂无法切换为纸页文档。")
            }
        }
    }

    @objc func actSwitchToCanvasMode() {
        guard pageUsable, !navigationInFlight else { return }
        let gen = navigationGeneration
        let confirm = NSAlert()
        confirm.messageText = "切换回无边画布？"
        confirm.informativeText = "化学结构会保留在画布中，多页纸页排版框将隐藏。"
        confirm.addButton(withTitle: "切换")
        confirm.addButton(withTitle: "取消")
        guard confirm.runModal() == .alertFirstButtonReturn else { return }
        let finish: (Bool, String?) -> Void = { [weak self] ok, message in
            guard let self, gen == self.navigationGeneration else { return }
            if ok {
                self.pollActiveSnapshot(); self.updateTitle()
                WorkspaceFocusRouter.restoreCanvasFocusIfSafe(in: self.window, canvasView: self.web)
            } else { self.alert("切换失败", message ?? "无法切换回无边画布。") }
        }
        let args: WorkspaceJSONObject = ["mode": .string("canvas")]
        if let coord = workspaceCoordinator, coord.isCommandSupported("document.page.setup") {
            coord.dispatchCommand(id: "document.page.setup", args: args) { result in
                if case .success(let reply) = result { finish(reply.ok, reply.error?.message) }
                else { finish(false, "桥接命令未返回结果") }
            }
        } else {
            jsValue("if (!window.k3dAPI?.document?.init) return false; const r = await window.k3dAPI.document.init({ mode: 'canvas' }); return r?.mode === 'canvas';") { value, ok in
                finish(ok && (value as? Bool) == true, "无法切换回无边画布。")
            }
        }
    }

    @objc func actPaperSetup() {
        guard pageUsable, !navigationInFlight else { return }
        let doc = workspaceCoordinator?.uiState.document
        let alertPanel = NSAlert()
        alertPanel.messageText = "纸页设置"
        alertPanel.informativeText = "调整纸张规格、方向与页边距（mm）。"

        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 8
        stack.frame = NSRect(x: 0, y: 0, width: 260, height: 90)

        let sizePopup = NSPopUpButton(frame: .zero, pullsDown: false)
        // document-model only accepts A4 / Letter; A3 was never implemented.
        sizePopup.addItems(withTitles: ["A4", "Letter"])
        if let cur = doc?.size, ["A4", "Letter"].contains(cur) {
            sizePopup.selectItem(withTitle: cur)
        }

        let orientPopup = NSPopUpButton(frame: .zero, pullsDown: false)
        orientPopup.addItems(withTitles: ["纵向 (Portrait)", "横向 (Landscape)"])
        orientPopup.selectItem(at: (doc?.orientation == "landscape") ? 1 : 0)

        let marginField = NSTextField(string: String(Int((doc?.marginMm ?? 15).rounded())))
        marginField.frame = NSRect(x: 0, y: 0, width: 80, height: 22)

        for (lbl, ctrl) in [("纸张尺寸", sizePopup), ("页面方向", orientPopup), ("页边距 (mm)", marginField)] as [(String, NSView)] {
            let row = NSStackView(views: [NSTextField(labelWithString: lbl), ctrl])
            row.orientation = .horizontal
            row.spacing = 10
            stack.addArrangedSubview(row)
        }
        alertPanel.accessoryView = stack
        alertPanel.addButton(withTitle: "应用")
        alertPanel.addButton(withTitle: "取消")
        guard alertPanel.runModal() == .alertFirstButtonReturn else { return }

        let size = sizePopup.selectedItem?.title ?? "A4"
        let orientation = (orientPopup.indexOfSelectedItem == 1) ? "landscape" : "portrait"
        let marginMm = max(0, min(50, Double(marginField.stringValue) ?? 15))
        let marginPt = marginMm * 72 / 25.4
        let gen = navigationGeneration
        let finish: () -> Void = { [weak self] in
            guard let self, gen == self.navigationGeneration else { return }
            self.pollActiveSnapshot()
            WorkspaceFocusRouter.restoreCanvasFocusIfSafe(in: self.window, canvasView: self.web)
        }
        // Real command path: document.page.setup → documentController.setPageSetup.
        // Fallback uses the actual k3dAPI.document.setPageSetup signature
        // (margins in points), not the removed updateSetup/marginMm stubs.
        let args: WorkspaceJSONObject = [
            "mode": .string("paper"), "size": .string(size),
            "orientation": .string(orientation), "marginMm": .number(marginMm)
        ]
        if let coord = workspaceCoordinator, coord.isCommandSupported("document.page.setup") {
            coord.dispatchCommand(id: "document.page.setup", args: args) { [weak self] result in
                guard let self, gen == self.navigationGeneration else { return }
                if case .success(let reply) = result, !reply.ok {
                    self.alert("页面设置失败", reply.error?.message ?? "未能应用页面设置")
                }
                finish()
            }
        } else {
            let margins: [String: Any] = ["top": marginPt, "right": marginPt, "bottom": marginPt, "left": marginPt]
            let payload: [String: Any] = ["mode": "paper", "size": size, "orientation": orientation, "margins": margins]
            guard let data = try? JSONSerialization.data(withJSONObject: payload),
                  let json = String(data: data, encoding: .utf8) else { return }
            jsValue("if (!window.k3dAPI?.document?.setPageSetup) return false; await window.k3dAPI.document.setPageSetup(\(json)); return true;") { [weak self] value, ok in
                guard let self, gen == self.navigationGeneration else { return }
                if !ok || (value as? Bool) != true { self.alert("页面设置失败", "无法应用页面设置。") }
                finish()
            }
        }
    }

    @objc func actAddPaperPage() {
        guard pageUsable, !navigationInFlight else { return }
        let gen = navigationGeneration
        // Same nativeUI channel as every other document mutation: epoch +
        // requestId guarded, single undo commit inside the JS controller.
        workspaceCoordinator?.dispatchCommand(id: "document.page.add") { [weak self] result in
            guard let self, gen == self.navigationGeneration else { return }
            if case .success(let reply) = result, reply.ok {
                self.pollActiveSnapshot()
            } else if case .success(let reply) = result {
                self.setStatus(reply.error?.message ?? "新增页面失败")
            } else {
                self.setStatus("无法读取页面状态，未新增")
            }
            WorkspaceFocusRouter.restoreCanvasFocusIfSafe(in: self.window, canvasView: self.web)
        }
    }

    @objc func actRemoveBlankLastPage() {
        guard pageUsable, !navigationInFlight else { return }
        let gen = navigationGeneration
        let finish: (Bool, String?) -> Void = { [weak self] success, message in
            guard let self, gen == self.navigationGeneration else { return }
            if success { self.pollActiveSnapshot() }
            else { self.setStatus(message ?? "末页非空白或仅有单页，未删除") }
            WorkspaceFocusRouter.restoreCanvasFocusIfSafe(in: self.window, canvasView: self.web)
        }
        if let coord = workspaceCoordinator, coord.isCommandSupported("document.page.removeLastBlank") {
            coord.dispatchCommand(id: "document.page.removeLastBlank") { result in
                if case .success(let reply) = result, reply.ok {
                    finish(true, nil)
                } else if case .success(let reply) = result {
                    finish(false, reply.error?.message ?? "末页含内容或仅有单页，未删除")
                } else {
                    finish(false, "无法读取页面状态，未删除")
                }
            }
        } else {
            // Real controller method: removePage(lastId) validates emptiness.
            jsValue("""
            const doc = window.k3dAPI?.document;
            if (!doc?.removePage) return false;
            const s = doc.getState?.();
            if (!s?.pages?.length || s.pages.length < 2) return false;
            return await doc.removePage(s.pages[s.pages.length - 1].id);
            """) { value, ok in
                finish(ok && (value as? Bool) == true, "末页非空白或仅有单页，未删除")
            }
        }
    }

    @objc func actInsertImageIntoDocument() {
        guard pageUsable, !navigationInFlight else { return }
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.png, .jpeg, .gif]
        panel.allowsMultipleSelection = false
        guard panel.runModal() == .OK, let url = panel.url else { return }
        guard let attrs = try? FileManager.default.attributesOfItem(atPath: url.path),
              let fileSize = (attrs[.size] as? NSNumber)?.intValue,
              fileSize > 0, fileSize <= 20 * 1024 * 1024,
              let data = try? Data(contentsOf: url) else {
            return alert("无法插入图片", "仅支持 20 MB 以内的 PNG / JPEG / WebP / GIF 图片。")
        }
        let mime: String = {
            switch url.pathExtension.lowercased() {
            case "jpg", "jpeg": return "image/jpeg"
            case "gif": return "image/gif"
            case "webp": return "image/webp"
            default: return "image/png"
            }
        }()
        let dataUrl = "data:\(mime);base64,\(data.base64EncodedString())"
        let gen = navigationGeneration
        let finish: () -> Void = { [weak self] in
            guard let self, gen == self.navigationGeneration else { return }
            self.pollActiveSnapshot()
            WorkspaceFocusRouter.restoreCanvasFocusIfSafe(in: self.window, canvasView: self.web)
        }
        // Real native path: document.addImage -> documentController.addImage
        // (one undo entry, real SVG object). No hidden <input type=file>.
        let args: WorkspaceJSONObject = ["dataUrl": .string(dataUrl),
            "point": .object(["x": .number(3), "y": .number(4)]),
            "w": .number(6), "h": .number(4.5)]
        if let coord = workspaceCoordinator, coord.isCommandSupported("document.addImage") {
            coord.dispatchCommand(id: "document.addImage", args: args) { [weak self] result in
                guard let self, gen == self.navigationGeneration else { return }
                if case .success(let reply) = result, !reply.ok {
                    self.alert("插入图片失败", reply.error?.message ?? "纸页文档未能添加所选图片。")
                }
                finish()
            }
        } else {
            jsValue("if (!window.k3dAPI?.document?.addImage) return false; await window.k3dAPI.document.addImage({ x: 3, y: 4, w: 6, h: 4.5, dataUrl: \(jsonLiteral(dataUrl)) }); return true;") { [weak self] value, ok in
                guard let self, gen == self.navigationGeneration else { return }
                if !ok || (value as? Bool) != true { self.alert("插入图片失败", "纸页文档未能添加所选图片。") }
                finish()
            }
        }
    }

    @objc func actInsertFileIntoDocument() {
        guard pageUsable, !navigationInFlight else { return }
        let panel = NSOpenPanel()
        panel.allowedContentTypes = contentTypes(["molwork", "ket"])
        panel.allowsMultipleSelection = false
        guard panel.runModal() == .OK, let url = panel.url else { return }
        guard let text = try? String(contentsOf: url, encoding: .utf8), !text.isEmpty else {
            return alert("无法读取文件", "无法打开 \(url.lastPathComponent)。")
        }
        let gen = navigationGeneration
        let name = url.lastPathComponent
        let finish: () -> Void = { [weak self] in
            guard let self, gen == self.navigationGeneration else { return }
            self.pollActiveSnapshot()
            WorkspaceFocusRouter.restoreCanvasFocusIfSafe(in: self.window, canvasView: self.web)
        }
        let args: WorkspaceJSONObject = ["text": .string(text), "name": .string(name)]
        if let coord = workspaceCoordinator, coord.isCommandSupported("document.importFile") {
            coord.dispatchCommand(id: "document.importFile", args: args) { [weak self] result in
                guard let self, gen == self.navigationGeneration else { return }
                if case .success(let reply) = result, !reply.ok {
                    self.alert("插入失败", reply.error?.message ?? "请确认文件格式有效。")
                } else {
                    self.setStatus("已载入 \(name)，移动鼠标放置，Esc 取消")
                }
                finish()
            }
        } else {
            // The real browser/native API is documentController.importFile.
            jsValue("if (!window.k3dAPI?.document?.importFile) return { ok: false, error: '文档插入接口未就绪' }; return await window.k3dAPI.document.importFile(\(jsonLiteral(text)), { name: \(jsonLiteral(name)) });") { [weak self] value, ok in
                guard let self, gen == self.navigationGeneration else { return }
                if let dict = value as? [String: Any], dict["ok"] as? Bool == true {
                    self.setStatus("已载入 \(name)，移动鼠标放置，Esc 取消")
                } else {
                    let errMsg = (value as? [String: Any])?["error"] as? String ?? "请确认文件格式有效。"
                    self.alert("插入失败", errMsg)
                }
                finish()
            }
        }
    }


    // MARK: 未保存检测（完整画布快照）
    private func startDirtyTracking() {
        dirtyTimer = Timer.scheduledTimer(withTimeInterval: 1.5, repeats: true) { [weak self] _ in
            self?.pollActiveSnapshot()
        }
    }

    /// 轮询当前活动页面的完整快照并更新对应会话；属于旧导航序号的结果一律作废，
    /// 不得更新当前标题或基线。R02：导航事务进行中（startNavigation → 注入成功取回快照）
    /// 完全不轮询提交——新页面的编辑器可导出空快照，此时提交会把会话覆盖成空页。
    private func pollActiveSnapshot() {
        guard !navigationInFlight, pageUsable else { return }
        let mode = activeMode
        let gen = navigationGeneration
        fetchSnapshot(mode) { [weak self] text in
            guard let self, let text else { return }
            guard gen == self.navigationGeneration, mode == self.activeMode else { return }
            self.commitSessionSnapshot(mode, text: text)
        }
    }

    /// 会话快照提交的唯一入口（R01/R02）：轮询、退出前读取、确认前读取、注入后取回
    /// 都经由这里提交，保证"确认成功且属于当前导航"才写会话。
    private func commitSessionSnapshot(_ mode: SessionMode, text: String) {
        let s = sessionOf(mode)
        s.currentSnapshot = text
        s.hasSnapshot = true
        updateTitle()
    }

    /// 画布快照 JS：优先取完整工作台快照（KET + 绑定 + 机理层）；
    /// 工作台接口缺失时允许使用标准 KET；接口报错时不能丢弃文档数据而降级。
    static func canvasSnapshotJS() -> String {
        return """
        if (window.k3dAPI && typeof window.k3dAPI.serializeWorkbench === 'function') {
          return await window.k3dAPI.serializeWorkbench();
        }
        return await window.k3dAPI.getKet();
        """
    }

    /// 只移除文件开头的 UTF-8 BOM，不修剪 MOL 文件有意义的空白头行。
    private func normalizedCanvasFileText(_ text: String) -> String {
        text.first == "\u{FEFF}" ? String(text.dropFirst()) : text
    }

    /// 用顶层格式标识分类；版本不合法也必须交由工作台校验，不能降级成 KET。
    private func isWorkbenchSnapshot(_ text: String) -> Bool {
        guard let data = normalizedCanvasFileText(text).data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return false }
        return obj["format"] as? String == "molstudio-workbench"
    }

    /// 原生入口先检查完整文件外壳；字段/引用的完整校验继续由 loadWorkbench 完成。
    private func workbenchLoadError(_ text: String) -> String? {
        guard let data = normalizedCanvasFileText(text).data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return "工作台文件不是有效的 JSON 对象。"
        }
        guard obj["format"] as? String == "molstudio-workbench" else {
            return "不是 MolStudio 工作台文件（format 字段不匹配）。"
        }
        guard let version = obj["version"] as? NSNumber,
              String(cString: version.objCType) != "c", [1.0, 2.0].contains(version.doubleValue) else {
            return "工作台文件版本不受支持；当前支持 version 1 和 2。"
        }
        guard obj["ket"] is [String: Any], obj["bindings"] is [String: Any],
              obj["mechanism"] is [String: Any] else {
            return "工作台文件缺少 ket、bindings 或 mechanism 对象。"
        }
        if version.doubleValue == 2 && !(obj["document"] is [String: Any]) {
            return "工作台 v2 文件缺少 document 对象。"
        }
        return nil
    }

    // MARK: 工作台分层就绪（Cmd+O .molwork 修复）
    /// k3dAPI.isReady 只覆盖 Ketcher；reactionSteps / agentTask 由 agent-bridge 在机理层
    /// 就绪后异步安装（agent-bridge.js 尾部轮询 → createBridge → app.reactionSteps）。
    /// 新导航上立即注入含 reactionSteps 的 .molwork 会得到
    /// "反应步骤层尚未就绪，未替换画布"并回滚。载入前必须按本快照实际需要等待分层。
    private struct WorkbenchLayerRequirements {
        var reactionSteps = false
        var document = false
        var agentTask = false
    }

    /// 从快照外壳判断 loadWorkbench 需要哪些分层；字段级校验仍在 loadWorkbench。
    /// 与 main.js loadWorkbench 的就绪检查保持同一真值语义（数组非空 / 对象存在）。
    private func workbenchRequiredLayers(_ text: String) -> WorkbenchLayerRequirements {
        guard let data = normalizedCanvasFileText(text).data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return WorkbenchLayerRequirements()
        }
        let hasSteps = ((obj["reactionSteps"] as? [Any])?.isEmpty == false)
            || ((obj["reactionStepOperations"] as? [Any])?.isEmpty == false)
        let hasDocument = obj["document"] is [String: Any]
        let hasAgentTask = obj["agentTask"] is [String: Any]
        return WorkbenchLayerRequirements(reactionSteps: hasSteps, document: hasDocument, agentTask: hasAgentTask)
    }

    /// 等待本快照需要的实际分层就绪（按导航序号 gen 作废；超时或真实初始化失败带原因退出）。
    /// bootError / bridgeFailure 是机理层启动 / agent-bridge 装载的确定性失败信号：
    /// 它们一旦出现就不会再就绪，立即失败并报告真实原因，不做盲目重试或固定延时。
    private func waitWorkbenchLayersReady(gen: Int, required: WorkbenchLayerRequirements,
                                          attemptsLeft: Int, _ done: @escaping (Bool, String) -> Void) {
        guard gen == navigationGeneration else { return done(false, "导航已切换") }
        guard attemptsLeft > 0 else { return done(false, "工作台分层未能在限时内就绪") }
        let probe = """
        const app = window.MolWorkbench && window.MolWorkbench.app;
        const bridgeBox = window.MolWorkbench && window.MolWorkbench.agentBridge;
        return JSON.stringify({
          ready: !!(app && app.ready && window.k3dAPI && window.k3dAPI.workbenchReady && window.k3dAPI.workbenchReady()),
          reactionSteps: !!(app && app.reactionSteps),
          document: !!(app && app.documentController),
          agentTask: !!(app && app.agentTask),
          bootError: (app && app.error) || null,
          bridgeFailure: (bridgeBox && bridgeBox.bridgeFailure) || null
        });
        """
        jsValue(probe) { [weak self] value, ok in
            guard let self else { return done(false, "窗口已关闭") }
            guard gen == self.navigationGeneration else { return done(false, "导航已切换") }
            if ok, let text = value as? String, let data = text.data(using: .utf8),
               let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                let ready = obj["ready"] as? Bool ?? false
                let hasSteps = obj["reactionSteps"] as? Bool ?? false
                let hasDocument = obj["document"] as? Bool ?? false
                let hasAgentTask = obj["agentTask"] as? Bool ?? false
                if ready
                    && (!required.reactionSteps || hasSteps)
                    && (!required.document || hasDocument)
                    && (!required.agentTask || hasAgentTask) {
                    return done(true, "")
                }
                // 分层尚未齐备：先看是否有确定性失败，再继续轮询。
                if let failure = obj["bootError"] as? String, !failure.isEmpty { return done(false, failure) }
                if let failure = obj["bridgeFailure"] as? String, !failure.isEmpty { return done(false, failure) }
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { [weak self] in
                self?.waitWorkbenchLayersReady(gen: gen, required: required, attemptsLeft: attemptsLeft - 1, done)
            }
        }
    }

    /// 从完整快照里取出标准 KET 文本（给 .ket 保存/导出用）
    private func ketTextFromSnapshot(_ snapshot: String) -> String? {
        if !isWorkbenchSnapshot(snapshot) { return snapshot }
        guard workbenchLoadError(snapshot) == nil,
              let data = normalizedCanvasFileText(snapshot).data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let ket = obj["ket"],
              let ketData = try? JSONSerialization.data(withJSONObject: ket, options: [.sortedKeys]),
              let text = String(data: ketData, encoding: .utf8) else { return nil }
        return text
    }

    /// 把标准 KET 包成空机理层的 .molwork（没有机理内容时另存为 .molwork 用）
    private func wrapKetAsWorkbench(_ ket: String) -> String? {
        if isWorkbenchSnapshot(ket) {
            return workbenchLoadError(ket) == nil ? normalizedCanvasFileText(ket) : nil
        }
        guard let data = normalizedCanvasFileText(ket).data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) else { return nil }
        let doc: [String: Any] = [
            "format": "molstudio-workbench",
            "version": 1,
            "ket": obj,
            "bindings": ["atoms": [], "bonds": []],
            "mechanism": ["lonePairs": [], "arrows": [], "steps": [["id": "step-1", "label": "步骤 1"]]]
        ]
        guard let out = try? JSONSerialization.data(withJSONObject: doc, options: [.sortedKeys]) else { return nil }
        return String(data: out, encoding: .utf8)
    }

    /// 快照里是否有新增的孤对/语义箭头（非活动会话或页面不可用时用快照判断）
    private func snapshotHasMechanism(_ snapshot: String) -> Bool {
        guard isWorkbenchSnapshot(snapshot),
              let data = normalizedCanvasFileText(snapshot).data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let mech = obj["mechanism"] as? [String: Any] else { return false }
        let lp = (mech["lonePairs"] as? [Any])?.count ?? 0
        let ar = (mech["arrows"] as? [Any])?.count ?? 0
        return lp + ar > 0
    }

    private func snapshotHasDocument(_ snapshot: String) -> Bool {
        guard isWorkbenchSnapshot(snapshot),
              let data = normalizedCanvasFileText(snapshot).data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return false }
        return obj["document"] is [String: Any]
    }

    /// 从画布读取完整工作台快照。
    /// nil = 读取失败（JS 报错或非字符串），调用方不得当作成功。
    /// 页面不可用（载入失败/崩溃）时返回内存快照：会话里的内容就是最后一份可信数据，
    /// 保证保存/退出仍能按真实内容判断，而不是被"读不到"永久卡住。
    private func fetchSnapshot(_ mode: SessionMode, _ done: @escaping (String?) -> Void) {
        guard mode == activeMode else {
            let s = sessionOf(mode)
            return done(s.hasSnapshot ? s.currentSnapshot : nil)   // 非活动会话用离开时捕获的快照
        }
        guard pageUsable else {
            let s = sessionOf(mode)
            return done(s.hasSnapshot ? s.currentSnapshot : nil)   // 页面不可用：内存快照即内容
        }
        let body = Self.canvasSnapshotJS()
        jsValue(body) { value, ok in
            guard ok, let text = value as? String else { return done(nil) }
            done(text)
        }
    }

    // 注：原 refreshBaseline（把当前页面快照直接当成"已保存"基线）已随 actNew/actClear 一并删除。
    // 需要"新建/清空"语义时应走 actNewDocument → startNavigation(.newDocument)，
    // 让清空经过离开确认与导航事务，而不是就地抹掉基线。

    private func updateTitle() {
        let s = session
        let name = s.fileURL?.lastPathComponent ?? sessionName(activeMode)
        window.title = "MolStudio — " + name + (s.dirty ? " •" : "")
        syncWorkspaceCoordinatorState()
    }

    private func syncWorkspaceCoordinatorState() {
        guard let coordinator = workspaceCoordinator else { return }
        let docMode: WorkspaceViewportMode =
            (coordinator.uiState.viewport.mode == .paper || snapshotHasDocument(session.currentSnapshot))
            ? .paper : .canvas
        let saveText: String = {
            if navigationInFlight { return "正在载入…" }
            if !pageUsable || pageQuarantined { return "页面未就绪" }
            return session.dirty ? "未保存" : "已保存"
        }()
        let meta = WorkspaceDocumentMetadata(
            displayTitle: session.fileURL?.lastPathComponent ?? sessionName(activeMode),
            fileURL: session.fileURL,
            documentMode: docMode,
            isDirty: session.dirty,
            isPageUsable: pageUsable && !pageQuarantined,
            isNavigationInFlight: navigationInFlight,
            saveStatusText: saveText
        )

        if navigationInFlight {
            if coordinator.navigationGeneration != navigationGeneration || coordinator.attachedEpoch != nil {
                coordinator.beginNavigation(generation: navigationGeneration)
            }
            coordinator.updateDocumentMetadata(meta)
            return
        }

        if pageUsable && !pageQuarantined {
            if coordinator.navigationGeneration != navigationGeneration {
                coordinator.beginNavigation(generation: navigationGeneration)
            }
            coordinator.updateDocumentMetadata(meta)
            if coordinator.attachedEpoch == nil && !coordinator.isAttaching && workspaceAttachFallbackGeneration != navigationGeneration {
                attachWorkspaceCoordinator()
            }
            return
        }

        if coordinator.attachedEpoch != nil {
            coordinator.detachCurrentEpoch()
        } else if coordinator.navigationGeneration != navigationGeneration {
            coordinator.beginNavigation(generation: navigationGeneration)
        }
        coordinator.updateDocumentMetadata(meta)
    }

    private func attachWorkspaceCoordinator() {
        guard let coordinator = workspaceCoordinator,
              pageUsable,
              !navigationInFlight,
              !pageQuarantined else { return }
        guard coordinator.attachedEpoch == nil, !coordinator.isAttaching else { return }
        let gen = navigationGeneration
        // Bounded liveness guard for the takeover itself. This is a failure
        // convergence timeout (not a delay to hide a flash): the cover is only
        // lifted by the success receipt below, never by this timer.
        DispatchQueue.main.asyncAfter(deadline: .now() + 20) { [weak self] in
            guard let self, gen == self.navigationGeneration,
                  self.workspaceCoordinator?.attachedEpoch == nil,
                  self.workspaceSplitVC?.canvasHostViewController.isNavigationLoading == true else { return }
            self.failAttachNatively(gen: gen)
        }
        coordinator.attach(preparedSurfaces: WorkspaceSurface.allCases) { [weak self] result in
            guard let self, gen == self.navigationGeneration,
                  !self.navigationInFlight, !self.pageQuarantined else { return }
            if case .success(let reply) = result, reply.ok,
               let epoch = reply.epoch, epoch.navigationGeneration == gen {
                // Trusted, generation-checked success: only now reveal the
                // native-first canvas. No fixed delay, no stale-frame flash.
                self.workspaceSplitVC?.canvasHostViewController.setNavigationCoverVisible(false)
                WorkspaceFocusRouter.restoreCanvasFocusIfSafe(in: self.window, canvasView: self.web)
                self.workspaceSplitVC?.canvasHostViewController.publishHostViewportIfNeeded(force: true)
                if self.workspaceSplitVC?.inspectorViewController.selectedTab == .agent {
                    coordinator.loadAgentSettings()
                }
            } else {
                self.failAttachNatively(gen: gen)
            }
        }
    }

    /// Native takeover failed or timed out: keep the opaque cover, show an
    /// actionable AppKit error state, and retain the in-memory document.
    /// The retired web toolbar is never revealed as an error fallback.
    private func failAttachNatively(gen: Int) {
        guard gen == navigationGeneration, !pageQuarantined,
              workspaceAttachFallbackGeneration != gen else { return }
        workspaceAttachFallbackGeneration = gen
        workspaceCoordinator?.abandonPendingAttach()
        let script = """
        const b = window.MolWorkbench?.nativeUI?.current?.();
        if (b?.attached && b.epoch?.navigationGeneration === \(gen)) b.detach(b.epoch);
        return !!(b && !b.attached);
        """
        jsValue(script) { [weak self] _, ok in
            guard let self, gen == self.navigationGeneration else { return }
            if !ok {
                self.workspaceSplitVC?.canvasHostViewController.showNavigationFailure(
                    reason: "原生接管失败，且无法安全清理旧接管状态。当前文档仍保存在内存中。",
                    canSave: true)
            } else {
                self.workspaceSplitVC?.canvasHostViewController.showNavigationFailure(
                    reason: "原生界面未能完成接管。当前内容仍保存在内存中，可重新载入；保存、关闭、退出不会丢失数据。",
                    canSave: true)
            }
        }
        // A page that never answers JS evaluation must still reach an error
        // state; this is a bounded liveness guard, not a fixed "hide the flash"
        // delay (the cover is never lifted by a timer).
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
            guard let self, gen == self.navigationGeneration,
                  self.workspaceSplitVC?.canvasHostViewController.isNavigationLoading == true else { return }
            self.workspaceSplitVC?.canvasHostViewController.showNavigationFailure(
                reason: "编辑器没有响应接管请求。当前内容仍保存在内存中，可重新载入；旧网页工具栏不会被显示。",
                canSave: true)
        }
    }

    /// 会话的显示名（无文件身份时用），提示文案共用（R04）
    private func sessionName(_ mode: SessionMode) -> String {
        "未命名"
    }

    /// 有未保存更改时询问。确认前先读一次最新内容，
    /// 不只依赖定时器缓存的 dirty。completion(true) = 可以离开（已保存/不保存），
    /// completion(false) = 用户取消或保存未完成（另存为面板被取消/写盘失败），留在原地防丢数据。
    private func confirmDiscard(_ done: @escaping (Bool) -> Void) { confirmDiscard(for: activeMode, done) }

    private func confirmDiscard(for mode: SessionMode,
                                isValid: @escaping () -> Bool = { true },
                                onApprovedSnapshot: ((String?) -> Void)? = nil,
                                _ done: @escaping (Bool) -> Void) {
        guard isValid() else { return done(false) }
        // R02/R04：导航事务进行中无法可靠读取最新内容（页面正在载入/注入）：
        // 已建立会话 → 取消破坏性操作并提示；未建立（启动空页/欢迎页）→ 放行，避免锁死。
        if navigationInFlight {
            let s = sessionOf(mode)
            if s.initialized {
                alert("无法确认未保存更改",
                      "页面正在载入，暂时无法读取“\(sessionName(mode))”的当前内容，已取消该操作。请稍后重试。")
                return done(false)
            }
            return done(true)
        }
        let gen = navigationGeneration
        let ask: () -> Void = { [weak self] in
            guard let self else { return done(false) }
            guard isValid(), gen == self.navigationGeneration else { return done(false) }
            let s = self.sessionOf(mode)
            let consideredSnapshot = s.hasSnapshot ? s.currentSnapshot : nil
            guard s.dirty else {
                onApprovedSnapshot?(consideredSnapshot)
                return done(true)
            }
            let name = s.fileURL?.lastPathComponent ?? self.sessionName(mode)
            let a = NSAlert()
            a.messageText = "要保存对“\(name)”的更改吗？"
            a.informativeText = "如果不保存，你的更改将会丢失。"
            a.alertStyle = .warning
            a.addButton(withTitle: "保存")
            a.addButton(withTitle: "不保存")
            a.addButton(withTitle: "取消")
            let reply = a.runModal()
            guard isValid(), gen == self.navigationGeneration, self.sessionOf(mode) === s else { return done(false) }
            switch reply {
            case .alertFirstButtonReturn:
                self.saveSession(mode, forceSaveAs: false) { ok in
                    guard isValid(), ok else { return done(false) }
                    self.verifySavedBeforeLeaving([mode], isValid: isValid) { verified in
                        guard isValid() else { return done(false) }
                        if verified { onApprovedSnapshot?(s.hasSnapshot ? s.currentSnapshot : nil) }
                        done(verified)
                    }
                }
            case .alertSecondButtonReturn:
                // 轮询可能在模态确认期间更新会话；授权只覆盖提示开始时的版本。
                onApprovedSnapshot?(consideredSnapshot)
                done(true)
            default:
                done(false)
            }
        }
        if mode == activeMode, pageUsable {
            // 确认前读取最新内容：一次笔画/输入后立即关闭/切走也能检测到修改
            fetchSnapshot(mode) { [weak self] text in
                guard let self else { return done(false) }
                guard isValid(), gen == self.navigationGeneration else { return done(false) }   // 意图过期或发生导航：静默取消，不误报"读取失败"
                guard let text else {
                    // R04：读取失败不能拿缓存的"干净"当安全依据 → 已建立会话默认取消；
                    // 尚未建立文档的启动空页放行（避免启动失败后连退出都被永久锁住）。
                    let s = self.sessionOf(mode)
                    guard s.initialized else { return done(true) }
                    return self.askDiscardAnyway(mode: mode) { done(isValid() && $0) }   // 逃生阀：明确放弃才继续
                }
                self.commitSessionSnapshot(mode, text: text)
                ask()
            }
        } else {
            // 非活动会话 / 页面不可用：内存快照就是内容，不再向页面读取
            ask()
        }
    }

    /// R04 逃生阀：页面内容读不到时默认取消破坏性操作，但允许用户明确放弃更改，
    /// 避免"页面坏了 → 永远关不掉/退不掉，只能强制退出"。
    private func askDiscardAnyway(mode: SessionMode, _ done: @escaping (Bool) -> Void) {
        let a = NSAlert()
        a.messageText = "无法确认“\(sessionName(mode))”的未保存更改"
        a.informativeText = "读取页面当前内容失败，默认取消本次操作。\n如果你确定不需要这些更改，也可以明确放弃后继续。"
        a.alertStyle = .warning
        a.addButton(withTitle: "取消")
        a.addButton(withTitle: "放弃更改并继续")
        done(a.runModal() == .alertSecondButtonReturn)
    }

    /// R04 逃生阀（退出）：读不到内容时默认取消退出，但允许明确放弃后退出，
    /// 避免"页面坏了 → 永远退不掉，只能强制退出"。
    private func askTerminateDiscardAnyway() -> Bool {
        let a = NSAlert()
        a.messageText = "无法检查未保存更改"
        a.informativeText = "读取当前页面内容失败，默认取消本次退出。\n如果你确定不需要这些更改，也可以明确放弃后退出。"
        a.alertStyle = .warning
        a.addButton(withTitle: "取消退出")
        a.addButton(withTitle: "放弃更改并退出")
        return a.runModal() == .alertSecondButtonReturn
    }

    /// 关主窗口 = 回到欢迎页（启动器式生命周期），不真正销毁窗口。
    /// 欢迎页关闭且画布不可见时退出应用。Viewer3D 等其它窗口不受影响。
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        if sender === welcomeWin {
            if window.isVisible { return true }
            NSApp.terminate(self)
            return false
        }
        guard sender === window else { return true }
        guard !terminatePending else { return false }   // 退出等待期间不再弹关闭确认
        openRequestGeneration += 1
        let openRequest = openRequestGeneration
        let gen = navigationGeneration
        confirmDiscard(for: activeMode) { ok in
            guard ok, gen == self.navigationGeneration, openRequest == self.openRequestGeneration else { return }
            self.closeActiveSession()
            self.window.orderOut(nil)
            self.showWelcome()
        }
        return false
    }

    /// 关闭的是文档会话，窗口只是复用。只隐藏窗口会让旧内容继续参与轮询、打开和退出确认。
    /// 仅在关闭确认/保存成功后调用；打开失败仍可恢复原内容。
    private func closeActiveSession() {
        openRequestGeneration += 1
        // 先隔离旧页面并作废在途回调，不能让迟到的轮询/注入重新提交已丢弃的内容。
        navigationGeneration += 1
        invalidateCleanLayoutRequest()
        workspaceAttachFallbackGeneration = nil
        navigationInFlight = false
        pageUsable = false
        pageQuarantined = true
        pendingPayload = .none
        pendingGeneration = -1
        cancelNavigationWatchdog()
        canvasSession = CanvasSession()
        updateTitle()
    }

    @objc func actShowWelcome() { showWelcome() }

    /// 文件 > 关闭窗口（⌘W）：关当前键窗口。主窗口仍走 windowShouldClose（保存确认/回欢迎页），
    /// 帮助与 3D 窗口直接关闭。菜单项目标固定为 AppDelegate，所以这里显式取 keyWindow。
    @objc func actCloseWindow(_ sender: Any?) {
        (NSApp.keyWindow ?? window)?.performClose(sender)
    }

    // MARK: 文件管理
    private func setupDocuments() {
        docsDir = AppRuntimeConfig.shared.docsDirectoryURL
        try? FileManager.default.createDirectory(at: docsDir, withIntermediateDirectories: true)
        ensureWelcomeModel()
        refreshFileList()
        // 注意：不要再在启动路径上碰 ~/Documents（旧目录迁移早已完成）——
        // Documents 有 TCC 保护，后台 Space 首次访问会静默弹授权框挂死启动（见项目记忆）。
    }

    private func ensureWelcomeModel() {
        if welcomeModel != nil { return }
        let examples = exampleDocumentURL() == nil ? [] : [WelcomeExampleItem(id: "sn2-oh-ch3br", title: "OH⁻ + CH₃Br 机理", subtitle: "孤对电子与弯箭头")]
        let model = WelcomeViewModel(
            defaults: AppRuntimeConfig.shared.userDefaults,
            appDirectoryURL: docsDir,
            thumbnailsDirectoryURL: docsDir.appendingPathComponent("thumbnails", isDirectory: true),
            examples: examples,
            recentURLsProvider: { AppRuntimeConfig.shared.recentURLs() },
            initialRecentItems: nil
        )
        welcomeModel = model
        welcomeRecentsCancellable = model.$recentItems
            .receive(on: DispatchQueue.main)
            .sink { [weak self] items in
                self?.workspaceSplitVC?.libraryViewController.setRecentItems(items)
            }
    }

    private func refreshFileList() {
        welcomeModel?.reloadRecentsAsync()
    }

    /// Only successful opens/saves enter the recent-documents list.
    private func noteRecentDocument(_ url: URL) {
        let canonical = URL(fileURLWithPath: WelcomeRecents.canonicalPath(for: url))
        AppRuntimeConfig.shared.noteRecentURL(canonical)
        welcomeModel?.noteOpened(canonical)
        refreshFileList()
    }

    private func removeRecentItem(_ item: WelcomeRecentItem) {
        AppRuntimeConfig.shared.removeIsolatedRecentURL(item.url)
        welcomeModel?.removeRecent(item)
    }

    /// Best-effort cache, fenced by file identity, session, navigation, save
    /// generation and the exact saved snapshot. Never changes dirty state.
    private func scheduleWelcomeThumbnail(url: URL, snapshot: String) {
        guard let directory = docsDir?.appendingPathComponent("thumbnails", isDirectory: true),
              let stamp = WelcomeThumbnailCache.stamp(url), pageUsable, !navigationInFlight else { return }
        thumbnailGeneration += 1
        let request = thumbnailGeneration, generation = navigationGeneration, session = canvasSession, saveGeneration = session.saveGeneration
        let digest = SHA256.hash(data: Data(snapshot.utf8)).map { String(format: "%02x", $0) }.joined()
        let valid: () -> Bool = { [weak self, weak session] in
            guard let self, let session else { return false }
            return self.thumbnailGeneration == request && self.navigationGeneration == generation && !self.navigationInFlight && self.pageUsable &&
                self.canvasSession === session && session.saveGeneration == saveGeneration && session.fileURL == url &&
                session.savedBaseline == snapshot && WelcomeThumbnailCache.stamp(url) == stamp
        }
        let body = """
        const hash = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), n => n.toString(16).padStart(2,'0')).join('');
        const snapshot = async () => await window.k3dAPI.serializeWorkbench();
        if (await hash(await snapshot()) !== '\(digest)') return { stale:true };
        const controller = window.MolWorkbench?.app?.documentController;
        const mode = controller?.active && controller.state.mode === 'paper' ? 'paper' : 'canvas';
        let dataUrl = null;
        try {
          if (mode === 'paper') {
            const output = await window.k3dAPI.document.exportPages(), page = output.ok && output.pages?.[0];
            if (page && page.widthPt > 0 && page.heightPt > 0) {
              const width = Math.min(480, Math.max(1, Math.floor(4096 * page.widthPt / page.heightPt)));
              const image = await window.MolWorkbench.exporter.svgToPng(page.svg, width, width * page.heightPt / page.widthPt, 1, document.getElementById('k').contentWindow);
              if (image.ok) dataUrl = image.dataUrl;
            }
          } else {
            const image = await window.k3dAPI.exportMechanismImage('png');
            if (image.ok && image.dataUrl) {
              const element = new Image(); element.src = image.dataUrl; await element.decode();
              const width = Math.min(480, Math.max(1, Math.floor(4096 * element.naturalWidth / element.naturalHeight)));
              const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = Math.max(1, Math.round(width * element.naturalHeight / element.naturalWidth));
              const g = canvas.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0,0,canvas.width,canvas.height); g.drawImage(element,0,0,canvas.width,canvas.height);
              dataUrl = canvas.toDataURL('image/png');
            }
          }
        } catch (_) { dataUrl = null; }
        if (await hash(await snapshot()) !== '\(digest)') return { stale:true };
        return { mode, dataUrl };
        """
        DispatchQueue.main.async { [weak self] in
            guard let self, valid() else { return }
            self.jsValue(body) { value, ok in
                guard ok, valid(), let output = value as? [String: Any], output["stale"] as? Bool != true,
                      let rawMode = output["mode"] as? String, let mode = WelcomeDocumentMode(rawValue: rawMode) else { return }
                let prefix = "data:image/png;base64,"
                var png: Data?
                if let source = output["dataUrl"] as? String, source.hasPrefix(prefix), source.count <= WelcomeThumbnailCache.maxPNGBytes * 2 {
                    png = Data(base64Encoded: String(source.dropFirst(prefix.count)))
                    if let data = png, !WelcomeThumbnailCache.validPNG(data) { png = nil }
                }
                self.fetchSnapshot(.canvas) { current in
                    guard valid(), current == snapshot else { return }
                    do {
                        try WelcomeThumbnailCache.write(url: url, directory: directory, expectedStamp: stamp, mode: mode, png: png)
                        self.refreshFileList()
                    } catch { self.dbg("thumbnail cache failed: \(error.localizedDescription)") }
                }
            }
        }
    }

    private func showWelcome() {
        ensureWelcomeModel()
        // Returning to the welcome screen must not leave the previous canvas
        // frame visibly behind the welcome window. The opaque cover goes up
        // immediately; the next explicit navigation replaces the frame.
        workspaceSplitVC?.canvasHostViewController.setNavigationCoverVisible(true)
        workspaceCoordinator?.detachCurrentEpoch()
        if let welcomeWin {
            refreshFileList()
            welcomeWin.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return
        }
        guard let model = welcomeModel else { return }
        let content = WelcomeView(model: model,
            onNewCanvas: { [weak self] in self?.actNewDocument() },
            onNewPaper: { [weak self] setup in self?.startNewPaperDocument(setup) },
            onOpenPanel: { [weak self] in self?.actOpen() },
            onOpenURL: { [weak self] url in self?.openDocument(at: url) },
            onOpenExample: { [weak self] example in
                guard example.id == "sn2-oh-ch3br" else { return }
                self?.actOpenExample()
            },
            onRemoveRecent: { [weak self] item in self?.removeRecentItem(item) },
            onRequestRename: { [weak self] item in self?.renameRecentFile(at: item.url) },
            onRevealInFinder: { item in NSWorkspace.shared.activateFileViewerSelecting([item.url]) })
        let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1000, height: 680),
                         styleMask: [.titled, .closable, .miniaturizable, .resizable],
                         backing: .buffered, defer: false)
        w.title = "MolStudio"
        w.isReleasedWhenClosed = false
        w.delegate = self
        w.minSize = NSSize(width: 720, height: 480)
        w.contentView = NSHostingView(rootView: content)
        w.center(); welcomeWin = w
        refreshFileList()
        w.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    @objc func actNewDocument() {
        openRequestGeneration += 1
        let openRequest = openRequestGeneration
        confirmDiscard(for: .canvas) { ok in
            guard ok, openRequest == self.openRequestGeneration else { return }
            self.startNavigation(to: .canvas, pending: .newDocument)
        }
    }

    @objc func actNewPaperDocument() {
        startNewPaperDocument(welcomeModel?.paperSetup ?? WelcomePaperSetup())
    }

    private func startNewPaperDocument(_ setup: WelcomePaperSetup) {
        openRequestGeneration += 1
        let openRequest = openRequestGeneration
        confirmDiscard(for: .canvas) { ok in
            guard ok, openRequest == self.openRequestGeneration else { return }
            self.startNavigation(to: .canvas, pending: .newPaperDocument(setup: setup))
        }
    }

    // MARK: 导航核心（B03 + R02）
    /// 加载画布并登记待注入数据；就绪后由 didFinish → applyPending 应用。
    /// R02：这里开启"导航事务"（navigationInFlight）：轮询提交/保存/离开确认挂起，
    /// 直到目标内容注入成功并取回快照（endNavigationTransaction）或事务失败回退。
    private func startNavigation(to target: SessionMode, pending: PendingPayload) {
        openRequestGeneration += 1
        navigationGeneration += 1
        invalidateCleanLayoutRequest()
        // Register the new generation with the coordinator BEFORE any load so
        // late callbacks from the previous epoch cannot be replayed onto the
        // new page. The opaque cover goes up in the same synchronous turn.
        workspaceCoordinator?.beginNavigation(generation: navigationGeneration)
        workspaceCoordinator?.detachCurrentEpoch()
        workspaceAttachFallbackGeneration = nil
        workspaceSplitVC?.canvasHostViewController.setNavigationCoverVisible(true)
        pendingPayload = pending
        pendingGeneration = navigationGeneration
        navigationInFlight = true            // R02：事务开始
        pageUsable = false                   // 新页面内容可信之前一律按"不可用"处理
        pageQuarantined = false              // S01：新导航解除上一次失败的隔离
        armNavigationWatchdog()              // R02 补：事务必须有超时出口
        activeMode = target
        // Explicit first-frame canvas mode. navGen lets the page self-check its
        // generation; hiddenControls is applied to the Ketcher iframe at boot.
        var components = URLComponents(url: base.appendingPathComponent("canvas.html"), resolvingAgainstBaseURL: false)!
        components.queryItems = [
            URLQueryItem(name: "nativeCanvas", value: "1"),
            URLQueryItem(name: "navGen", value: String(navigationGeneration))
        ]
        let url = components.url ?? base.appendingPathComponent("canvas.html")
        dbg("startNavigation canvas.html?nativeCanvas=1 gen=\(navigationGeneration)")
        web.load(URLRequest(url: url))
        // Window is shown only after the cover is already covering the stale
        // WebView frame; the page itself never renders the retired web UI.
        window.makeKeyAndOrderFront(nil)
        welcomeWin?.orderOut(nil)
        updateTitle()
    }

    /// R02：导航事务结束（目标内容注入成功且已取回快照/基线已建立）。
    /// 只有这里恢复轮询提交与保存；失败路径走 abortNavigation（释放事务 + 页面标为不可用）。
    private func endNavigationTransaction() {
        navigationInFlight = false
        pageUsable = true
        cancelNavigationWatchdog()
        updateTitle()
        // No fixed delay. The opaque cover is lifted only by the attach success
        // receipt (generation-checked). A missing/failed attach is detected by
        // the existing navigation watchdog and shown as a native error state.
        attachWorkspaceCoordinator()
    }

    // MARK: 导航事务的失败出口（R02 补）
    /// 事务超时看门狗：45 秒（页面就绪等待是 30 秒）还没结束就判定失败，
    /// 避免"页面卡住 → 门闸永久关闭 → 存不了、关不掉、退不了"。
    private func armNavigationWatchdog() {
        cancelNavigationWatchdog()
        let gen = navigationGeneration
        let item = DispatchWorkItem { [weak self] in
            guard let self, self.navigationInFlight, gen == self.navigationGeneration else { return }
            self.abortNavigation(reason: "编辑器页面 45 秒内没有完成载入。")
        }
        navigationWatchdog = item
        DispatchQueue.main.asyncAfter(deadline: .now() + 45, execute: item)
    }

    private func cancelNavigationWatchdog() {
        navigationWatchdog?.cancel()
        navigationWatchdog = nil
    }

    /// 导航失败统一处理：释放事务、把页面标为不可用（内容以内存快照为准），并给重新载入入口。
    /// 关键点：不再让门闸永久关闭——保存/关闭/退出都退回"用内存快照"的正常路径。
    /// S01：终止事务必须同时作废该事务的所有异步回调——
    /// ① 递增 navigationGeneration，让已发出的 setMolecule/取快照回调凭序号全部失效；
    /// ② 隔离当前页面（pageQuarantined），迟到的 didFinish 也不能把它重新激活；
    /// 两者都要，序号管已发出的回调，隔离管之后才到的页面事件。只有新的 startNavigation 能解除。
    private func abortNavigation(reason: String) {
        workspaceSplitVC?.canvasHostViewController.showNavigationFailure(
            reason: reason + "\n当前内容仍保存在内存中，可重新载入或返回欢迎页；旧网页工具栏不会被显示。",
            canSave: session.hasSnapshot)
        openRequestGeneration += 1
        let wasInFlight = navigationInFlight
        let alreadyDegraded = !wasInFlight && !pageUsable
        navigationInFlight = false
        pageUsable = false
        pageQuarantined = true
        navigationGeneration += 1
        invalidateCleanLayoutRequest()
        cancelNavigationWatchdog()
        if wasInFlight {
            pendingPayload = .none      // 丢掉未消费的注入任务，避免迟到的 didFinish 再套用旧 pending
            pendingGeneration = -1
        }
        updateTitle()
        // 已经处在降级状态（用户选了"稍后"）时不再重复弹窗，只记日志，避免一次故障弹一串框
        if alreadyDegraded { return dbg("navigation failure (already degraded): \(reason)") }
        offerReloadAfterPageFailure(reason: reason)
    }

    /// 失败后的重试入口：明确告知内容仍在内存里，可一键重载当前页面。
    private func offerReloadAfterPageFailure(reason: String) {
        let a = NSAlert()
        a.messageText = "页面未能载入"
        a.informativeText = reason
            + "\n\n当前内容仍保存在内存中：现在保存、关闭、退出都会使用内存里的快照，不会卡住。"
            + "\n点“重新载入”可重试当前页面（会用内存中的内容覆盖页面）。"
        a.alertStyle = .warning
        a.addButton(withTitle: "重新载入")
        a.addButton(withTitle: "稍后")
        if a.runModal() == .alertFirstButtonReturn { reloadCurrentPage() }
    }

    /// 重载画布；已建立的会话用内存快照恢复，未建立则按空页建立干净基线。
    private func reloadCurrentPage() {
        let mode = activeMode
        let s = sessionOf(mode)
        let pending: PendingPayload =
            (s.initialized && s.hasSnapshot && !s.currentSnapshot.isEmpty)
            ? .restoreSession(text: s.currentSnapshot) : .none
        startNavigation(to: mode, pending: pending)
    }

    /// 导航前抓取离开页面（R02）：导航事务进行中（上一次导航失败/未完成，页面是失败后的
    /// 空页）跳过抓取——读取只会把空页提交进内存会话；直接继续导航，由注入恢复内存内容。
    private func captureForNavigation(_ done: @escaping (Bool) -> Void) {
        // 页面不可用（上次导航失败/崩溃）时同样跳过抓取：读到的不是会话内容，只会污染内存快照
        if navigationInFlight || !pageUsable { return done(true) }
        captureActiveSession(done)
    }

    /// 抓取画布完整快照，同时缓存同版 MOL/SMILES 导出供页面不可用时保存。
    private func captureActiveSession(_ done: @escaping (Bool) -> Void) {
        let mode = activeMode
        let gen = navigationGeneration
        let snapshotExpr = "await (async () => { " + Self.canvasSnapshotJS() + " })()"
        let body = "const snap = " + snapshotExpr + ";\n"
                 + "let mol = null, smi = null;\n"
                 + "try { mol = await window.k3dAPI.getMolfile(); } catch (e) {}\n"
                 + "try { smi = await window.k3dAPI.getSmiles(); } catch (e) {}\n"
                 + "const after = " + snapshotExpr + ";\n"
                 + "if (snap !== after) return null;\n"
                 + "return { snap: snap, mol: mol, smi: smi };"
        jsValue(body) { [weak self] value, ok in
            guard let self else { return done(false) }
            guard gen == self.navigationGeneration, ok,
                  let values = value as? [String: Any], let text = values["snap"] as? String else {
                return done(false)
            }
            // 只有导出前后完整快照一致，才将快照和两种缓存一起提交。
            self.commitSessionSnapshot(mode, text: text)
            let s = self.sessionOf(mode)
            s.molExport = values["mol"] as? String
            s.smilesExport = values["smi"] as? String
            s.exportSnapshot = text
            done(true)
        }
    }

    /// 等待页面就绪：有次数/时间上限（0.5s × 60 = 30s），失败要有反馈；
    /// 旧导航的等待直接作废，回调不能写入新页面。
    private func waitPageReady(mode: SessionMode, gen: Int, attemptsLeft: Int, _ done: @escaping (Bool) -> Void) {
        guard gen == navigationGeneration else { return done(false) }
        guard attemptsLeft > 0 else { return done(false) }
        let probe = "return String(window.k3dAPI && window.k3dAPI.isReady ? window.k3dAPI.isReady() : false)"
        jsValue(probe) { value, ok in
            guard gen == self.navigationGeneration else { return done(false) }
            if ok, (value as? String) == "true" { return done(true) }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                self.waitPageReady(mode: mode, gen: gen, attemptsLeft: attemptsLeft - 1, done)
            }
        }
    }

    /// Ketcher can become ready before the separately mounted document layer.
    private func waitPaperEditorReady(gen: Int, attemptsLeft: Int, _ done: @escaping (Bool) -> Void) {
        guard gen == navigationGeneration, attemptsLeft > 0 else { return done(false) }
        let probe = "return !!(window.k3dAPI?.workbenchReady?.() && window.k3dAPI?.document?.init && window.MolWorkbench?.app?.adapter?.ed)"
        jsValue(probe) { value, ok in
            guard gen == self.navigationGeneration else { return done(false) }
            if ok, value as? Bool == true { return done(true) }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
                self.waitPaperEditorReady(gen: gen, attemptsLeft: attemptsLeft - 1, done)
            }
        }
    }

    /// 页面就绪后注入待载的画布数据：
    /// • 所有异步完成回调都检查导航序号 gen，只有当前导航且注入成功才提交会话身份/状态；
    /// • 注入成功且取回快照后才 endNavigationTransaction（恢复轮询提交与保存）；
    /// • 注入失败保留旧会话，回退到画布恢复其内容（rollbackAfterFailedInjection），
    ///   不把空页当作旧文件的新当前内容。
    private func applyPending(mode: SessionMode, gen: Int) {
        var payload: PendingPayload = (gen == pendingGeneration) ? pendingPayload : .none
        pendingGeneration = -1   // 消费掉，防止同一份 pending 被重复注入
        pageUsable = true        // 页面已就绪、可以正常求值（注入是否成功另判）
        let s = sessionOf(mode)

        // R02（pendingGeneration 清理时机复查）：pending 已被消费/丢失而会话已建立时，
        // 按"恢复内存会话"处理（进入注入前固定拷贝），不把刚加载的空页当新基线
        //（didFinish 重复触发等场景）；未建立的会话仍走 freshBaseline。
        if case .none = payload, s.initialized, s.hasSnapshot, !s.currentSnapshot.isEmpty {
            payload = .restoreSession(text: s.currentSnapshot)
        }

        switch payload {
        case .none:
            freshBaselineAfterPageReady(mode: mode, forcedUnsaved: false)

        case .newDocument:
            s.fileURL = nil
            appUserDefaults.removeObject(forKey: "lastFile")
            freshBaselineAfterPageReady(mode: mode, forcedUnsaved: false)

        case .newPaperDocument(let setup):
            guard gen == navigationGeneration else { return }
            guard let options = setup.toJSONString() else {
                return rollbackAfterFailedInjection(reason: "纸张设置无法编码。")
            }
            let body = """
            if (!window.k3dAPI?.document?.init || !window.MolWorkbench?.app?.adapter?.ed) throw new Error('文档编辑器尚未就绪');
            const result = await window.k3dAPI.document.init(\(options));
            if (result?.mode !== 'paper') throw new Error('纸页初始化失败');
            window.MolWorkbench.app.adapter.ed.clearHistory();
            return true;
            """
            waitPaperEditorReady(gen: gen, attemptsLeft: 100) { [weak self] ready in
                guard let self, gen == self.navigationGeneration else { return }
                guard ready else { return self.rollbackAfterFailedInjection(reason: "文档编辑器未能及时就绪。") }
                self.jsValue(body) { value, ok in
                    guard gen == self.navigationGeneration else { return }
                    guard ok, value as? Bool == true else {
                        return self.rollbackAfterFailedInjection(reason: "无法初始化纸页，原文档已保留。")
                    }
                    self.fetchSnapshot(mode) { snapshot in
                        guard gen == self.navigationGeneration else { return }
                        guard let snapshot, let data = snapshot.data(using: .utf8),
                              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                              let doc = obj["document"] as? [String: Any], doc["mode"] as? String == "paper",
                              (obj["version"] as? NSNumber)?.intValue == 2 else {
                            return self.rollbackAfterFailedInjection(reason: "纸页快照不可用，原文档已保留。")
                        }
                        s.fileURL = nil
                        self.appUserDefaults.removeObject(forKey: "lastFile")
                        self.commitFreshSession(s, mode: mode, snapshot: snapshot, unsaved: false)
                    }
                }
            }

        case .openCanvasFile(let text, let url):
            guard gen == navigationGeneration else { return }
            let text = self.normalizedCanvasFileText(text)
            let isWorkbench = url.pathExtension.lowercased() == "molwork" || self.isWorkbenchSnapshot(text)
            if isWorkbench, let error = self.workbenchLoadError(text) {
                return self.rollbackAfterFailedInjection(reason: "工作台载入失败：\(url.lastPathComponent)\n\(error)")
            }
            let injectOpenCanvas: () -> Void = { [weak self] in
                guard let self else { return }
                let body = isWorkbench
                    ? "return JSON.stringify(await window.k3dAPI.loadWorkbench(\(self.jsonLiteral(text))))"
                    : "return await window.k3dAPI.setMolecule(\(self.jsonLiteral(text)))"
                self.jsValue(body) { [weak self] value, ok in
                    guard let self else { return }
                    guard gen == self.navigationGeneration else { return }   // 旧导航回调不得提交
                    var injectOK = ok
                    var detail = ""
                    if isWorkbench {
                        // 工作台文件：loadWorkbench 返回 {ok,error}，失败必须回退且说明原因
                        if let s = value as? String, let d = s.data(using: .utf8),
                           let obj = try? JSONSerialization.jsonObject(with: d) as? [String: Any] {
                            injectOK = (obj["ok"] as? Bool) == true
                            if !injectOK { detail = (obj["error"] as? String) ?? "" }
                        } else {
                            injectOK = false
                            detail = "工作台载入没有返回结果（机理层可能未就绪）"
                        }
                    }
                    guard injectOK else {
                        // R02：载入失败 → 不提交会话身份，回退到来源页面恢复其内容
                        return self.rollbackAfterFailedInjection(reason: "结构载入失败：\(url.lastPathComponent)" + (detail.isEmpty ? "" : "\n\(detail)"))
                    }
                    s.fileURL = url
                    appUserDefaults.set(url.path, forKey: "lastFile")
                    self.noteRecentDocument(url)
                    s.initialized = true
                    self.fetchSnapshot(mode) { snap in
                        guard gen == self.navigationGeneration else { return }
                        if let snap {
                            self.commitSessionSnapshot(mode, text: snap)   // 先同步当前快照，避免刚打开就显示"未保存"
                            s.savedBaseline = snap   // 打开成功：载入内容即已保存基线
                        } else {
                            s.savedBaseline = ""     // 读不到基线按未保存处理（安全侧）
                        }
                        self.updateTitle()
                        self.setStatus("已打开 \(url.lastPathComponent)")
                        self.endNavigationTransaction()   // R02：注入成功且取回快照 → 事务结束
                        if let snap { self.scheduleWelcomeThumbnail(url: url, snapshot: snap) }
                    }
                }
            }
            if isWorkbench {
                // 分层就绪等待（见 waitWorkbenchLayersReady 注释）：新导航的 isReady 不代表
                // reactionSteps/agentTask 已安装；必须等本快照需要的层可用后再注入。
                // 超时/失败仍走 rollbackAfterFailedInjection，来源画布内容保持原样。
                let required = self.workbenchRequiredLayers(text)
                self.waitWorkbenchLayersReady(gen: gen, required: required, attemptsLeft: 75) { [weak self] layersReady, failure in
                    guard let self, gen == self.navigationGeneration else { return }
                    guard layersReady else {
                        let detail = failure.isEmpty ? "工作台分层未能及时就绪。" : "工作台初始化失败：\(failure)"
                        return self.rollbackAfterFailedInjection(reason: "结构载入失败：\(url.lastPathComponent)\n\(detail)")
                    }
                    injectOpenCanvas()
                }
            } else {
                injectOpenCanvas()
            }

        case .restoreSession(let text):
            guard s.initialized, !text.isEmpty else {
                return self.freshBaselineAfterPageReady(mode: mode, forcedUnsaved: false)   // 防御：会话从未建立
            }
            guard gen == navigationGeneration else { return }
            let restoreIsWorkbench = self.isWorkbenchSnapshot(text)
            let injectRestoreSession: () -> Void = { [weak self] in
                guard let self else { return }
                let body: String
                if restoreIsWorkbench {
                    body = "return JSON.stringify(await window.k3dAPI.loadWorkbench(\(self.jsonLiteral(text))))"
                } else {
                    body = "return await window.k3dAPI.setMolecule(\(self.jsonLiteral(text)))"
                }
                self.jsValue(body) { [weak self] value, ok in
                    guard let self else { return }
                    guard gen == self.navigationGeneration else { return }
                    var injectOK = ok
                    if restoreIsWorkbench {
                        if let sv = value as? String, let sd = sv.data(using: .utf8),
                           let obj = try? JSONSerialization.jsonObject(with: sd) as? [String: Any] {
                            injectOK = (obj["ok"] as? Bool) == true
                        } else { injectOK = false }
                    }
                    guard injectOK else {
                        // R02 补：恢复失败 → 走统一失败出口（释放事务 + 页面标为不可用）。
                        // 旧会话的内存快照原样保留，保存/关闭/退出改用内存内容，不再把门闸永久关死；
                        // 用户可在提示里点"重新载入"重试。
                        return self.abortNavigation(reason: "无法把内存中的内容注入页面，页面当前内容不可信。")
                    }
                    self.fetchSnapshot(mode) { snap in
                        guard gen == self.navigationGeneration else { return }
                        if let snap { self.commitSessionSnapshot(mode, text: snap) }
                        // 基线与文件身份都不动：恢复会话不能清 dirty
                        self.updateTitle()
                        self.endNavigationTransaction()
                    }
                }
            }
            if restoreIsWorkbench {
                // 与 openCanvasFile 相同的分层就绪等待：恢复内存会话同样可能含 reactionSteps。
                // 失败出口沿用 abortNavigation（内存快照仍是权威内容）。
                let required = self.workbenchRequiredLayers(text)
                self.waitWorkbenchLayersReady(gen: gen, required: required, attemptsLeft: 75) { [weak self] layersReady, failure in
                    guard let self, gen == self.navigationGeneration else { return }
                    guard layersReady else {
                        let detail = failure.isEmpty ? "工作台分层未能及时就绪。" : "工作台初始化失败：\(failure)"
                        return self.abortNavigation(reason: "无法把内存中的内容注入页面，页面当前内容不可信。（\(detail)）")
                    }
                    injectRestoreSession()
                }
            } else {
                injectRestoreSession()
            }

        }
    }

    /// 目标内容注入失败时不提交文件身份，重载画布并恢复其内存内容
    /// 原内容重新可见后可再次尝试打开。
    /// 恢复文本在回退事务开始前固定拷贝；回退本身若再失败，由 restoreSession
    /// 失败分支兜底，避免连环回滚。
    private func rollbackAfterFailedInjection(reason: String) {
        let origin: SessionMode = .canvas
        let originSession = sessionOf(origin)
        let pending: PendingPayload
        if originSession.initialized, originSession.hasSnapshot, !originSession.currentSnapshot.isEmpty {
            pending = .restoreSession(text: originSession.currentSnapshot)
        } else {
            pending = .none
        }
        // 先提示再导航：避免回退事务的失败提示叠在这一层模态框里（两个 alert 嵌套）
        alert("打开失败", reason + "\n\n已保留原文档内容，正在返回原页面，可重新打开重试。")
        startNavigation(to: origin, pending: pending)
    }

    /// 首次建立画布会话（新建/首次进入/无待注入）：读快照建立基线。
    /// forcedUnsaved（导入的内容）→ 基线空串 → 显示未保存；
    private func freshBaselineAfterPageReady(mode: SessionMode, forcedUnsaved: Bool) {
        let s = sessionOf(mode)
        let gen = navigationGeneration
        fetchSnapshot(mode) { snap in
            guard gen == self.navigationGeneration else { return }
            self.commitFreshSession(s, mode: mode, snapshot: snap, unsaved: forcedUnsaved)
        }
    }

    private func commitFreshSession(_ s: CanvasSession, mode: SessionMode, snapshot: String?, unsaved: Bool) {
        if let snapshot { s.currentSnapshot = snapshot; s.hasSnapshot = true }
        s.savedBaseline = unsaved ? "" : s.currentSnapshot
        s.initialized = true
        updateTitle()
        // 空页/新建路径的快照已取回、基线已建立，结束导航事务
        endNavigationTransaction()
    }


    @objc func actOpen() {
        // 即使新的选文件面板被取消，也不允许之前仍在转换的文件稍后打开。
        openRequestGeneration += 1
        // 菜单/欢迎页"打开…"（R03）：只负责选文件，确认与载入走统一入口 openDocument
        let panel = NSOpenPanel()
        panel.directoryURL = self.docsDir
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false
        if panel.runModal() == .OK, let url = panel.url { self.openDocument(at: url) }
    }

    @objc func actOpenSelected() {
        guard let t = fileTable, t.clickedRow >= 0, t.clickedRow < fileList.count else { return }
        openDocument(at: fileList[t.clickedRow])
    }

    // MARK: 文件打开统一入口（R03）
    /// 菜单、欢迎页和文件列表打开入口共用此处。
    /// 流程：确认画布最新内容，确认通过后才导航注入；initialized 且 dirty 时询问保存。
    /// 确认画布最新未保存内容后只问一次；
    /// 取消时不导航，会话内容与文件身份原样。
    private func openDocument(at url: URL) {
        openRequestGeneration += 1
        let request = openRequestGeneration
        let gen = navigationGeneration
        let originalSession = canvasSession
        let isCurrent = {
            request == self.openRequestGeneration && gen == self.navigationGeneration
                && self.canvasSession === originalSession
        }
        guard let rawText = try? String(contentsOf: url, encoding: .utf8), !rawText.isEmpty else {
            return alert("打开失败", "无法读取 \(url.lastPathComponent)")
        }
        let text = normalizedCanvasFileText(rawText)
        let ext = url.pathExtension.lowercased()
        guard ext != "mechdoc" else {
            return alert("旧机理格式已停用", "MolStudio 画布不再打开 .mechdoc 文件。原文件保持不变；当前完整机理请使用 .molwork。")
        }
        if ext == "molwork" || isWorkbenchSnapshot(text), let error = workbenchLoadError(text) {
            return alert("打开失败", error)
        }
        let confirmAndOpen: (String) -> Void = { preparedText in
            guard isCurrent() else { return }
            // 转换完成之后才确认当前画布：等待期间新增的编辑必须在询问范围内。
            var approved: String?
            self.confirmDiscard(for: .canvas, isValid: isCurrent, onApprovedSnapshot: { approved = $0 }) { ok in
                guard ok, isCurrent() else { return }
                self.navigateWithCapture(to: .canvas, pending: .openCanvasFile(text: preparedText, url: url),
                                         openRequest: request, approvedSnapshot: approved)
            }
        }
        if ext == "smi" || ext == "smiles" {
            self.post("/api/clean", data: text) { r in
                guard isCurrent() else { return } // 包括迟到失败：不向新文档弹旧请求错误。
                guard let r, r["ok"] as? Bool == true, let block = r["molblock"] as? String else {
                    return self.alert("打开失败", (r?["error"] as? String) ?? "无法解析 SMILES")
                }
                confirmAndOpen(block)
            }
        } else {
            confirmAndOpen(text)
        }
    }

    /// 离开当前页面前抓取其完整快照（失败则取消打开、留在原页面），再导航注入。
    /// 当前会话的捕获是静默的：打开文件的确认只针对目标会话（R03）。
    private func navigateWithCapture(to target: SessionMode, pending: PendingPayload,
                                     openRequest: Int? = nil, approvedSnapshot: String? = nil) {
        let gen = navigationGeneration
        let originalSession = canvasSession
        captureForNavigation { ok in
            guard gen == self.navigationGeneration, self.canvasSession === originalSession,
                  openRequest == nil || openRequest == self.openRequestGeneration else { return }
            guard ok else { return self.alert("打开失败", "无法读取当前页面内容，已取消打开。") }
            if let approvedSnapshot, originalSession.currentSnapshot != approvedSnapshot {
                return self.alert("内容已改变", "确认离开后画布又有新修改，本次打开已取消，请重新打开。")
            }
            self.startNavigation(to: target, pending: pending)
        }
    }

    // MARK: 统一保存链路（B12）
    /// 普通保存 / 另存为 / 未保存确认里的"保存" / 退出前保存全走这里。
    /// completion(true) 仅在目标文件实际写盘成功后回调；取消或失败保留旧文件身份与 dirty。
    private func saveSession(_ mode: SessionMode, forceSaveAs: Bool, _ done: @escaping (Bool) -> Void) {
        // R02：导航事务进行中页面内容不可靠（新页可能尚未注入），禁止保存，
        // 避免把未注入的空页写进文件；等事务结束后再保存。
        if navigationInFlight {
            alert("正在载入文档", "页面导航尚未完成，暂不能保存；请等载入完成后再保存。")
            return done(false)
        }
        let s = sessionOf(mode)
        let gen = navigationGeneration
        let originalURL = s.fileURL
        s.saveGeneration += 1
        let saveGen = s.saveGeneration
        // 只比较会话身份与保存请求；正文继续编辑不使本次快照失效。
        // 导航、关闭、重命名或后发保存后，旧回调不能写盘或提交新会话的基线。
        let isCurrentSave = {
            gen == self.navigationGeneration && !self.navigationInFlight
                && self.sessionOf(mode) === s && s.saveGeneration == saveGen
                && s.fileURL == originalURL
        }
        // 页面不可用时读取内存快照，不从坏页面读取。
        let isActive = (mode == activeMode) && pageUsable

        let gotSnapshot: (String?) -> Void = { snapshot in
            guard isCurrentSave() else { return done(false) }
            guard let snapshot else {
                self.alert("保存失败", "无法读取画布当前内容")
                return done(false)
            }
            // 第一步：确定目标文件（未命名或另存为才弹面板）
            var url = s.fileURL
            let hasDocument = self.snapshotHasDocument(snapshot)
            if forceSaveAs || url == nil || (hasDocument && url?.pathExtension.lowercased() != "molwork") {
                let panel = NSSavePanel()
                panel.directoryURL = self.docsDir
                // 有机理内容默认给 .molwork（KET 装不下孤对与语义箭头）
                let hasMech = self.snapshotHasMechanism(snapshot)
                panel.nameFieldStringValue = hasDocument ? (url?.deletingPathExtension().lastPathComponent ?? "未命名") + ".molwork" : (url?.lastPathComponent ?? (hasMech ? "未命名.molwork" : "未命名.ket"))
                panel.allowedContentTypes = self.contentTypes(hasDocument ? ["molwork"] : ["molwork", "ket", "mol", "sdf", "smi", "smiles"])
                guard panel.runModal() == .OK, let chosen = panel.url else { return done(false) } // 取消：身份不变
                url = chosen
            }
            guard isCurrentSave() else { return done(false) }
            guard let target = url else { return done(false) }
            let ext = target.pathExtension.lowercased()
            if hasDocument && ext != "molwork" {
                self.alert("保存失败", "文档文字、图片和页面设置需要保存为 .molwork。")
                return done(false)
            }

            // 第三步：写盘 + 成功后才提交身份/基线/标题/最近文件
            let commit: (String, String) -> Void = { writtenText, ketBaseline in
                guard isCurrentSave() else { return done(false) }
                let previousBaseline = s.savedBaseline
                do {
                    try writtenText.write(to: target, atomically: true, encoding: .utf8)
                } catch {
                    self.alert("保存失败", error.localizedDescription)
                    return done(false)   // 失败：旧文件身份与 dirty 保持
                }
                s.fileURL = target
                s.savedBaseline = ketBaseline   // 基线 = 本次实际写入的快照
                if let old = originalURL, old.standardizedFileURL != target.standardizedFileURL,
                   previousBaseline == ketBaseline, let directory = self.docsDir?.appendingPathComponent("thumbnails", isDirectory: true) {
                    WelcomeThumbnailCache.copy(from: old, to: target, directory: directory)
                }
                self.appUserDefaults.set(target.path, forKey: "lastFile")
                self.noteRecentDocument(target)
                if mode == self.activeMode {
                    self.updateTitle()
                    self.pollActiveSnapshot()   // 立刻重算 dirty：保存等待期间的新编辑仍是未保存
                }
                self.setStatus("已保存 \(target.lastPathComponent)")
                done(true)
                if mode == self.activeMode { self.scheduleWelcomeThumbnail(url: target, snapshot: ketBaseline) }
            }

            // 第二步：验证目标格式 + 取要写入的内容
            guard ["ket", "mol", "sdf", "smi", "smiles", "molwork"].contains(ext) else {
                // 不认识的格式不硬写，避免把文件写坏（如 .cdxml）
                let a = NSAlert()
                a.messageText = "“.\(target.pathExtension)”格式暂不支持直接保存"
                a.informativeText = "为避免写坏文件，请另存为 MOLWORK / KET / MOL / SDF / SMILES。"
                a.addButton(withTitle: "另存为…")
                a.addButton(withTitle: "取消")
                let reply = a.runModal()
                guard isCurrentSave() else { return done(false) }
                return reply == .alertFirstButtonReturn
                    ? self.saveSession(mode, forceSaveAs: true, done)
                    : done(false)
            }
            // 有机理内容却要存进不带机理的格式：引导另存 .molwork，成功前不改身份
            let snapshotHasMech = self.snapshotHasMechanism(snapshot)
            if ext != "molwork" && snapshotHasMech {
                let a = NSAlert()
                a.messageText = "这份画布含孤对或机理箭头"
                a.informativeText = ".\(target.pathExtension) 只能保存化学结构，孤对与语义箭头会丢失。\n请另存为 .molwork（完整工作台文件），原文件保持不变。"
                a.addButton(withTitle: "另存为 .molwork")
                a.addButton(withTitle: "取消")
                guard a.runModal() == .alertFirstButtonReturn else { return done(false) }
                guard isCurrentSave() else { return done(false) }
                return self.saveSession(mode, forceSaveAs: true, done)
            }
            if isActive {
                // 导出前后校验完整快照，期间编辑则取消，避免文本与保存基线不同版。
                self.fetchCanvasSaveTexts(ext) { fullSnapshot, writeText in
                    guard isCurrentSave() else { return done(false) }
                    guard let fullSnapshot, let writeText, !writeText.isEmpty else {
                        self.alert("保存失败", "读取结构数据失败，或读取期间画布已改变。本次未保存，请重试。")
                        return done(false)
                    }
                    // 面板等待或异步导出期间可能新增机理；必须对实际写入版本再检查。
                    if ext != "molwork" && self.snapshotHasMechanism(fullSnapshot) {
                        self.alert("请另存为 .molwork", "画布已新增孤对或机理箭头，本次保存已取消。请另存为 .molwork，以保留完整工作台内容。")
                        return done(false)
                    }
                    if ext == "molwork" {
                        guard let wrapped = self.wrapKetAsWorkbench(fullSnapshot) else {
                            self.alert("保存失败", "无法生成完整工作台内容")
                            return done(false)
                        }
                        commit(wrapped, wrapped)
                    } else if ext == "ket" {
                        guard let ketOnly = self.ketTextFromSnapshot(fullSnapshot) else {
                            self.alert("保存失败", "无法从工作台快照中取出结构")
                            return done(false)
                        }
                        commit(ketOnly, fullSnapshot)   // 基线仍是完整快照：机理层变化也要算未保存
                    } else {
                        commit(writeText, fullSnapshot)
                    }
                }
            } else {
                // 非活动会话 / 页面不可用（如退出前保存、崩溃后保存）：只能用离开页面时捕获的导出缓存。
                // S02：缓存与当前 KET 不是同一版时绝不写旧内容，也不能把新快照标成已保存。
                let export: String?
                switch ext {
                case "molwork":
                    guard let wrapped = self.wrapKetAsWorkbench(snapshot) else {
                        self.alert("保存失败", "无法生成完整工作台内容")
                        return done(false)
                    }
                    export = wrapped
                case "ket":
                    guard let ketOnly = self.ketTextFromSnapshot(snapshot) else {
                        self.alert("保存失败", "无法从快照中取出结构")
                        return done(false)
                    }
                    export = ketOnly
                case "mol", "sdf", "smi", "smiles":
                    let cached = (ext == "mol" || ext == "sdf") ? s.molExport : s.smilesExport
                    guard let cached, !cached.isEmpty else {
                        self.alert("保存失败",
                                   "无法读取 \(target.lastPathComponent) 需要的内容（页面当前不可用，也没有可用的导出缓存）。\n"
                                 + "可以改存 .ket（用内存中的最新结构），或恢复页面后重试。")
                        return done(false)
                    }
                    guard s.exportSnapshot == snapshot else {
                        // 导出缓存来自更早的编辑版本：写盘会覆盖成旧内容，同时把新编辑误标为已保存
                        self.alert("无法保存为 \(target.pathExtension.uppercased())",
                                   "页面当前不可用，缓存里的 \(ext.uppercased()) 与内存中的最新结构不是同一版。\n"
                                 + "为避免写入旧内容，本次保存已取消。请改存 .ket（保留最新结构），或恢复页面后重试。")
                        return done(false)
                    }
                    export = cached
                default:
                    export = snapshot   // 兜底：直接用内存中的最新快照
                }
                guard let export, !export.isEmpty else {
                    self.alert("保存失败", "无法读取 \(target.lastPathComponent) 的内容（页面不在该模式），请切到结构画布后保存。")
                    return done(false)
                }
                commit(export, snapshot)
            }
        }

        // 第零步：拿到要写入的完整快照（活动会话现读最新；非活动会话用捕获的快照）
        if isActive {
            fetchSnapshot(mode) { text in gotSnapshot(text) }
        } else {
            gotSnapshot(s.hasSnapshot ? s.currentSnapshot : nil)
        }
    }

    /// 取「完整快照 + 按扩展名的写盘文本」，导出前后快照不同就拒绝本次保存。
    /// 快照是 .molwork 封装（含机理层），写盘文本按目标格式取（MOL/SMILES/KET/工作台）。
    private func fetchCanvasSaveTexts(_ ext: String, _ done: @escaping (_ snapshot: String?, _ writeText: String?) -> Void) {
        let snapshotExpr = "await (async () => { " + Self.canvasSnapshotJS() + " })()"
        let exportExpr: String
        switch ext {
        case "mol", "sdf": exportExpr = "await window.k3dAPI.getMolfile()"
        case "smi", "smiles": exportExpr = "await window.k3dAPI.getSmiles()"
        default: exportExpr = "null"
        }
        let body = "const snap = " + snapshotExpr + ";\n"
                 + "const txt = " + exportExpr + ";\n"
                 + "const after = " + snapshotExpr + ";\n"
                 + "if (snap !== after) return null;\n"
                 + "return { snap: snap, txt: txt };"
        jsValue(body) { value, ok in
            guard ok, let d = value as? [String: Any] else { return done(nil, nil) }
            let snap = d["snap"] as? String
            let txt = d["txt"] as? String
            let needsExport = ["mol", "sdf", "smi", "smiles"].contains(ext)
            done(snap, needsExport ? txt : snap)   // 导出失败不能把 JSON 快照当作 MOL/SMILES 写盘
        }
    }

    @objc func actSave() { saveSession(activeMode, forceSaveAs: false) { _ in } }
    @objc func actSaveAs() { saveSession(activeMode, forceSaveAs: true) { _ in } }

    /// Export is independent of the document's file identity and dirty state.
    /// Pages are requested through the nativeUI bridge (`document.exportPages`)
    /// so the call carries the same epoch/requestId/idempotency guarantees as
    /// every other document command.
    @objc func actExportDocumentPDF() {
        guard !documentPDFExportInFlight else { return alert("导出进行中", "请等待当前 PDF 导出完成。") }
        guard pageUsable, !navigationInFlight else { return alert("无法导出", "画布尚未准备好。") }
        documentPDFExportInFlight = true
        let gen = navigationGeneration
        let originalSession = canvasSession
        let stillValid: () -> Bool = { [weak self] in
            guard let self else { return false }
            return self.navigationGeneration == gen && self.canvasSession === originalSession && self.pageUsable && !self.navigationInFlight
        }
        /// Pages are requested through the nativeUI bridge (`document.exportPages`)
        /// so the call carries the same epoch/requestId/idempotency guarantees as
        /// every other document command.
        workspaceCoordinator?.dispatchCommand(id: "document.exportPages") { [weak self] result in
            guard let self else { return }
            guard stillValid() else { self.documentPDFExportInFlight = false; return }
            switch result {
            case .failure:
                self.documentPDFExportInFlight = false
                self.alert("PDF 导出失败", "画布没有返回可用的页面数据。")
            case .success(let reply):
                guard reply.ok else {
                    self.documentPDFExportInFlight = false
                    return self.alert("PDF 导出失败", reply.error?.message ?? "无法生成页面。")
                }
                let result = reply.result?.mapValues(\.foundationValue) ?? [:]
                guard (result["ok"] as? Bool) == true else {
                    self.documentPDFExportInFlight = false
                    return self.alert("PDF 导出失败", result["error"] as? String ?? "无法生成页面。")
                }
                guard let entries = result["pages"] as? [[String: Any]], !entries.isEmpty, entries.count <= 100 else {
                    self.documentPDFExportInFlight = false
                    return self.alert("PDF 导出失败", "页面列表无效或超过 100 页。")
                }
                var pages: [DocumentPDFExporter.Page] = []
                for entry in entries {
                    guard let id = entry["id"] as? String, let width = entry["widthPt"] as? Double,
                          let height = entry["heightPt"] as? Double, let svg = entry["svg"] as? String else {
                        self.documentPDFExportInFlight = false
                        return self.alert("PDF 导出失败", "页面数据不完整。")
                    }
                    pages.append(.init(id: id, widthPt: width, heightPt: height, svg: svg))
                }
                let warnings = result["warnings"] as? [String] ?? []
                if !warnings.isEmpty {
                    let prompt = NSAlert()
                    prompt.messageText = "导出前请注意"
                    prompt.informativeText = warnings.prefix(10).joined(separator: "\n")
                    prompt.addButton(withTitle: "继续导出")
                    prompt.addButton(withTitle: "取消")
                    guard prompt.runModal() == .alertFirstButtonReturn, stillValid() else {
                        self.documentPDFExportInFlight = false; return
                    }
                }
                let panel = NSSavePanel()
                panel.nameFieldStringValue = (self.currentFile?.deletingPathExtension().lastPathComponent ?? "文档") + ".pdf"
                panel.allowedContentTypes = [.pdf]
                guard panel.runModal() == .OK, let url = panel.url, stillValid() else {
                    self.documentPDFExportInFlight = false; return
                }
                let exporter = DocumentPDFExporter()
                self.documentPDFExporter = exporter
                exporter.export(pages: pages, isValid: stillValid) { [weak self] result in
                    guard let self else { return }
                    self.documentPDFExporter = nil; self.documentPDFExportInFlight = false
                    guard stillValid() else { return }
                    switch result {
                    case .failure(let error): self.alert("PDF 导出失败", error.localizedDescription)
                    case .success(let data):
                        do {
                            try data.write(to: url, options: .atomic)
                            self.setStatus("已导出 \(url.lastPathComponent)（\(pages.count) 页）")
                        } catch { self.alert("PDF 导出失败", error.localizedDescription) }
                    }
                }
            }
        }
    }

    /// 导出机理图（SVG/PNG）：包含 Ketcher 内容、孤对与全部箭头；不改文件身份、不清 dirty
    @objc func actExportMechanismImage() {
        let pick = NSAlert()
        pick.messageText = "导出机理图"
        pick.informativeText = "包含当前画布的结构、孤对与全部箭头（选择手柄、悬停高亮与未提交草稿不会导出）。"
        pick.addButton(withTitle: "SVG")
        pick.addButton(withTitle: "PNG")
        pick.addButton(withTitle: "取消")
        let resp = pick.runModal()
        let kind: String
        if resp == .alertFirstButtonReturn { kind = "svg" }
        else if resp == .alertSecondButtonReturn { kind = "png" }
        else { return }

        exportMechanismImage(kind)
    }

    private func exportMechanismImage(_ kind: String) {
        guard kind == "svg" || kind == "png" else { return }
        let panel = NSSavePanel()
        panel.directoryURL = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
        panel.nameFieldStringValue = kind == "svg" ? "机理图.svg" : "机理图.png"
        panel.allowedContentTypes = self.contentTypes([kind])
        guard panel.runModal() == .OK, let url = panel.url else { return }   // 取消：不写盘

        jsValue("return JSON.stringify(await window.k3dAPI.exportMechanismImage('\(kind)'))") { [weak self] value, ok in
            guard let self else { return }
            guard ok, let s = value as? String, let d = s.data(using: .utf8),
                  let obj = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else {
                return self.alert("导出失败", "画布没有返回可用的图片数据。")
            }
            guard (obj["ok"] as? Bool) == true, let dataUrl = obj["dataUrl"] as? String else {
                return self.alert("导出失败", (obj["error"] as? String) ?? "未知错误")
            }
            guard let comma = dataUrl.firstIndex(of: ","),
                  let bytes = Data(base64Encoded: String(dataUrl[dataUrl.index(after: comma)...])) else {
                return self.alert("导出失败", "图片数据无法解码。")
            }
            do {
                try bytes.write(to: url)
                self.setStatus("已导出 \(url.lastPathComponent)（\(bytes.count) 字节）")
            } catch {
                self.alert("导出失败", error.localizedDescription)
            }
        }
    }

    @objc func actExportMol() {
        // IO11：显式导出结构前说明不携带的内容；导出不改变主文件身份与 dirty
        let warn: () -> Void = { [weak self] in
            guard let self else { return }
            self.jsValue("return !!(window.k3dAPI && window.k3dAPI.hasMechanismContent && window.k3dAPI.hasMechanismContent())") { hasMech, _ in
                if hasMech as? Bool == true {
                    let a = NSAlert()
                    a.messageText = "导出结构不包含孤对与机理箭头"
                    a.informativeText = "MOL/SDF/SMILES 只包含化学结构。孤对、电子对箭头与鱼钩箭头不会写入导出文件；完整内容请保存为 .molwork。"
                    a.addButton(withTitle: "继续导出")
                    a.addButton(withTitle: "取消")
                    guard a.runModal() == .alertFirstButtonReturn else { return }
                }
                self.exportMolNow()
            }
        }
        warn()
    }

    private func exportMolNow() {
        currentMolfile { m in
            guard let m, !m.isEmpty else { return self.alert("画布是空的", "先画一个结构。") }
            let panel = NSSavePanel()
            panel.nameFieldStringValue = "molecule.mol"
            if panel.runModal() == .OK, let url = panel.url {
                try? m.write(to: url, atomically: true, encoding: .utf8)
                self.setStatus("已导出 \(url.lastPathComponent)")
            }
        }
    }

    @objc func actCopySmiles() {
        currentSmiles { s in
            guard let s, !s.isEmpty else { return self.alert("画布是空的", "先画一个结构。") }
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(s, forType: .string)
            self.setStatus("SMILES 已复制：\(s)")
        }
    }

    // MARK: 结构
    /// 生成 3D：先固定"本次目标清单"，再做立体检查，需要时由用户选择，最后生成。
    /// 检查、选择、生成都基于同一份 KET 与文档身份（期间改动即作废，D09）。
    @objc func actGen3D() {
        let gen = navigationGeneration
        setStatus("检查立体信息…")
        jsValue("return await window.k3dAPI.stereoTargets()") { value, ok in
            guard gen == self.navigationGeneration else { return }
            guard ok, let t = value as? [String: Any] else {
                self.setStatus("")
                return self.alert("无法生成 3D", "无法读取画布内容，请稍后重试。")
            }
            guard t["ok"] as? Bool == true else {
                self.setStatus("")
                let msg = (t["message"] as? String) ?? "无法读取画布内容"
                if (t["code"] as? String) == "no_molecule" {
                    return self.alert("请选择分子", msg)
                }
                return self.alert("无法生成 3D", msg)
            }
            self.checkStereoThenGenerate(t, gen: gen)
        }
    }

    /// 立体检查 → （必要时）用户选择 → 生成。所有分支共用同一份目标清单。
    private func checkStereoThenGenerate(_ targets: [String: Any], gen: Int) {
        guard let ket = targets["ket"] as? String,
              let keys = targets["keys"] as? [String], !keys.isEmpty else {
            setStatus("")
            return alert("无法生成 3D", "没有可生成的结构。")
        }
        let labels = (targets["labels"] as? [String: String]) ?? [:]
        let identity = (targets["identity"] as? String) ?? ""
        let hasSelection = (targets["hasSelection"] as? Bool) ?? false
        var payload: [String: Any] = ["ket": ket, "keys": keys, "identity": identity]
        if !labels.isEmpty { payload["labelOf"] = labels }
        postPayload("/api/stereocheck", payload) { r in
            guard gen == self.navigationGeneration else { return }
            guard let r, r["ok"] as? Bool == true else {
                self.setStatus("")
                // 结构解析/芳香性/价态问题不是"立体"问题：标题要能指向真正原因
                let code = (r?["code"] as? String) ?? ""
                let title = (code == "chem_error" || code == "bad_ket") ? "结构检查失败" : "立体检查失败"
                return self.alert(title, (r?["error"] as? String) ?? "未知错误")
            }
            let needs = ((r["summary"] as? [String: Any])?["needsChoice"] as? Bool) ?? false
            guard needs else {
                return self.generate3D(ket: ket, keys: keys, labels: labels, identity: identity,
                                       hasSelection: hasSelection, gen: gen, allowExample: false)
            }
            guard self.confirmStereoExample(r) else {
                self.setStatus("已返回画布")
                return
            }
            // 提示期间画布可能被改动：确认仍是同一份输入才继续
            self.jsValue("return await window.k3dAPI.docIdentity()") { id, okId in
                guard gen == self.navigationGeneration else { return }
                guard okId, let now = id as? String, now == identity else {
                    self.setStatus("")
                    return self.alert("内容已改变",
                                      "画布内容在提示期间发生了变化，本次生成已取消，请重新生成。")
                }
                self.generate3D(ket: ket, keys: keys, labels: labels, identity: identity,
                                hasSelection: hasSelection, gen: gen, allowExample: true)
            }
        }
    }

    /// 真正调用生成接口：单分子单独开窗；有选区的多分子各开一窗；无选区的多分子同窗排开。
    private func generate3D(ket: String, keys: [String], labels: [String: String],
                            identity: String, hasSelection: Bool, gen: Int, allowExample: Bool) {
        setStatus("生成 3D…")
        let base: [String: Any] = ["ket": ket, "identity": identity,
                                   "allowExample": allowExample]
        if keys.count == 1 {
            var payload = base
            payload["keys"] = keys
            postPayload("/api/gen3d", payload) { r in
                guard gen == self.navigationGeneration else { return }
                guard let r, r["ok"] as? Bool == true, let block = r["molblock"] as? String else {
                    self.setStatus("")
                    return self.alert("生成失败", (r?["error"] as? String) ?? "未知错误")
                }
                self.open3DWindow(block: block, smiles: (r["smiles"] as? String) ?? keys[0],
                                  index: 0, total: 1, warning: self.gen3dWarningText(r),
                                  stereo: r["stereo"] as? [String: Any], moleculeCount: 1)
            }
            return
        }
        if hasSelection {
            for (i, key) in keys.enumerated() {
                var payload = base
                payload["keys"] = [key]
                postPayload("/api/gen3d", payload) { r in
                    guard gen == self.navigationGeneration else { return }
                    guard let r, r["ok"] as? Bool == true, let block = r["molblock"] as? String else {
                        return self.alert("生成失败", (r?["error"] as? String) ?? "未知错误")
                    }
                    self.open3DWindow(block: block, smiles: (r["smiles"] as? String) ?? key,
                                      index: i, total: keys.count,
                                      warning: self.gen3dWarningText(r),
                                      stereo: r["stereo"] as? [String: Any], moleculeCount: 1)
                }
            }
            setStatus("已为选中的 \(keys.count) 个分子各开 3D 窗口")
            return
        }
        var payload = base
        payload["keys"] = keys
        postPayload("/api/gen3d_all", payload) { r in
            guard gen == self.navigationGeneration else { return }
            guard let r, r["ok"] as? Bool == true, let block = r["molblock"] as? String else {
                self.setStatus("")
                return self.alert("生成失败", (r?["error"] as? String) ?? "未知错误")
            }
            let warn = self.gen3dWarningText(r)
            self.setStatus("已在一个窗口显示 \(keys.count) 个分子")
            self.open3DWindow(block: block, smiles: "\(keys.count) 个分子", index: 0, total: 1,
                              warning: warn, stereo: r["stereo"] as? [String: Any],
                              moleculeCount: keys.count)
        }
    }

    // MARK: 立体提示（示例构型）
    /// 提示框正文：只列非零项；只有双键问题时不说四面体楔键。
    func stereoPromptMessage(_ report: [String: Any]?) -> String {
        let summary = (report?["summary"] as? [String: Any]) ?? [:]
        let tetra = (summary["tetrahedral"] as? [String: Any]) ?? [:]
        let dbl = (summary["double"] as? [String: Any]) ?? [:]
        let groups = (summary["groups"] as? [String: Any]) ?? [:]
        func n(_ d: [String: Any], _ k: String) -> Int { (d[k] as? Int) ?? 0 }
        let t = n(tetra, "unspecified") + n(tetra, "unknown")
        let d = n(dbl, "unspecified") + n(dbl, "unknown")
        let groupCount = n(groups, "or") + n(groups, "and")
        var items: [String] = []
        if t > 0 { items.append("\(t) 个四面体中心") }
        if d > 0 { items.append("\(d) 处双键构型") }
        var text: String
        if items.isEmpty {
            text = "本次要生成的结构包含立体组信息，单个三维结构无法完整表示。"
        } else {
            text = "本次要生成的结构有 " + items.joined(separator: "、") + "尚未确定。"
        }
        text += "你可以返回画布指定构型，也可以查看其中一种可能的三维结构。"
        text += "示例只是一种可能结果，不表示原图已经确定了全部构型。"
        if groupCount > 0 {
            text += "\n\n结构还包含相对构型或混合物的立体组信息。"
            text += "本次 3D 仅展示一个代表，不能表示完整的组或混合物。"
        }
        return text
    }

    /// 返回 true = 查看一个示例；false = 返回画布（默认按钮，回车与 Escape 都走这里）。
    func confirmStereoExample(_ report: [String: Any]?) -> Bool {
        #if MOLSTUDIO_SELFTEST
        if selfTestAutoExample { selfTestAutoExample = false; return true }
        #endif
        let a = NSAlert()
        a.messageText = "部分立体构型尚未确定"
        a.informativeText = stereoPromptMessage(report)
        a.addButton(withTitle: "返回画布")        // 第一个 = 默认按钮（回车）
        a.addButton(withTitle: "查看一个示例")
        // NSAlert 的取消键只能绑一个按钮，这里用本地监听器把 Escape 也接到"返回画布"
        var monitor: Any?
        monitor = NSEvent.addLocalMonitorForEvents(matching: [.keyDown]) { ev in
            if ev.keyCode == 53 {                 // Escape
                NSApp.stopModal(withCode: .alertFirstButtonReturn)
                return nil
            }
            return ev
        }
        let resp = a.runModal()
        if let monitor { NSEvent.removeMonitor(monitor) }
        a.window.orderOut(nil)
        return resp == .alertSecondButtonReturn
    }

    /// 3D 窗口里的持久标识（不是提示框文案）；与力场警告分别存储、分别表达。
    func stereoBadgeText(_ stereo: [String: Any]?, moleculeCount: Int = 1) -> String? {
        guard let s = stereo, (s["example"] as? Bool) == true else { return nil }
        let groups = (s["groups"] as? [String: Any]) ?? [:]
        let groupCount = ((groups["or"] as? Int) ?? 0) + ((groups["and"] as? Int) ?? 0)
        var text = groupCount > 0
            ? "示例构型 · 输入含相对构型或混合物信息"
            : "示例构型 · 原图未指定立体"
        let mols = (s["molecules"] as? [String]) ?? []
        if moleculeCount > 1, !mols.isEmpty {
            text += "（\(mols.joined(separator: "、")) 为示例构型）"
        }
        return text
    }

    // MARK: 3D 未收敛警告（R05）
    /// 从 gen3d / gen3d_all 的成功响应中提取未收敛警告文案（纯文字，不用 emoji 图标；
    /// 失败响应没有 warnings 字段 → nil）。无警告返回 nil，调用方不显示、不弹阻塞对话框，
    /// 查看构象的行为不受影响。
    func gen3dWarningText(_ r: [String: Any]?) -> String? {
        // notes：转换时做过的处理（例如芳香正电碳按价态补 1 个隐含氢），
        // 必须和力场警告一样显示出来，不能让用户以为画布被悄悄改了。
        var parts: [String] = []
        if let notes = r?["notes"] as? [String], !notes.isEmpty {
            parts.append("说明：" + notes.joined(separator: "；"))
        }
        if let list = r?["warnings"] as? [String], !list.isEmpty {
            parts.append("未收敛：" + list.joined(separator: "；"))
        }
        return parts.isEmpty ? nil : parts.joined(separator: "\n")
    }

    /// R05：把警告显示在 3D 窗口副标题；无警告清空副标题。
    private func applyGen3DWarning(_ win: Viewer3D, _ warning: String?) {
        win.warningText = warning
        win.subtitle = warning ?? ""
    }

    @objc func actToggle3D() {
        let visible = viewers.filter { $0.isVisible }
        if !visible.isEmpty { visible.forEach { $0.orderOut(nil) }; return }
        actGen3D()
    }

    @objc func actCheck() {
        currentSmiles { s in
            guard let s, !s.isEmpty else { return self.alert("画布是空的", "先画一个结构。") }
            self.post("/api/check", data: s) { r in
                guard let r, r["ok"] as? Bool == true else {
                    return self.alert("检查失败", (r?["error"] as? String) ?? "未知错误")
                }
                if r["clean"] as? Bool == true {
                    self.alert("结构检查", "价键与化合价检查通过。")
                } else {
                    let p = (r["problems"] as? [String]) ?? []
                    self.alert("结构检查：发现 \(p.count) 处问题", p.joined(separator: "\n"))
                }
            }
        }
    }

    /// 结构 → 清理结构（⌘⇧K）：与顶部 Layout、⌘L 走同一套整理逻辑，
    /// 不再把整张画布导出 MOL 再整体替换（那会丢选区、丢画布内容、丢历史）。
    @objc func actClean() {
        guard !cleanLayoutInFlight else { return }
        cleanLayoutInFlight = true
        cleanLayoutRequestGeneration += 1
        let requestGeneration = cleanLayoutRequestGeneration
        let gen = navigationGeneration
        setStatus("整理结构中…")
        workspaceSplitVC?.canvasHostViewController.showCanvasFeedback(message: "正在整理结构…")
        jsValue("return await window.k3dAPI.cleanLayout()") { value, ok in
            defer {
                if self.cleanLayoutRequestGeneration == requestGeneration {
                    self.cleanLayoutInFlight = false
                }
            }
            guard gen == self.navigationGeneration else { return }
            guard ok, let r = value as? [String: Any] else {
                self.setStatus("")
                self.workspaceSplitVC?.canvasHostViewController.showCanvasFeedback(message: "无法读取画布内容，本次整理未应用。")
                return self.alert("整理未应用", "无法读取画布内容，本次整理未应用。")
            }
            self.reportLayoutResult(r)
        }
    }

    private func invalidateCleanLayoutRequest() {
        cleanLayoutRequestGeneration += 1
        cleanLayoutInFlight = false
    }

    /// 整理结果统一提示（原生菜单与顶部按钮共用同一套文案规则）
    func reportLayoutResult(_ r: [String: Any]) {
        let success = (r["ok"] as? Bool) ?? false
        let message = (r["message"] as? String) ?? ""
        let code = (r["code"] as? String) ?? ""
        if success {
            let unchanged = (r["unchanged"] as? Bool) ?? false
            let feedback = message.isEmpty
                ? (unchanged ? "结构已整齐，位置与画法保持不变" : "结构已整理")
                : message
            workspaceSplitVC?.canvasHostViewController.showCanvasFeedback(message: feedback)
            setStatus(feedback)
            return
        }
        let feedback = message.isEmpty ? "本次整理未完成，原图未修改。" : message
        workspaceSplitVC?.canvasHostViewController.showCanvasFeedback(message: feedback)
        setStatus("")
        if code == "no_molecule" {
            alert("请选择要整理的分子", message.isEmpty ? "先选中一个分子再整理。" : message)
        } else {
            alert("整理未应用", message.isEmpty ? "本次整理未完成，原图未修改。" : message)
        }
    }

    // MARK: 分析窗口
    @objc func actProps() {
        makeAnalysisPanel()
        panelAna?.makeKeyAndOrderFront(nil)
        refreshAnalysis()
    }

    private func makeAnalysisPanel() {
        if panelAna != nil { return }
        let p = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 340, height: 440),
                        styleMask: [.titled, .closable, .resizable, .utilityWindow],
                        backing: .buffered, defer: false)
        p.title = "分析 / 性质"
        p.isReleasedWhenClosed = false

        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 5
        stack.edgeInsets = NSEdgeInsets(top: 12, left: 14, bottom: 12, right: 14)

        for (key, label) in anaKeys {
            let row = NSStackView()
            row.orientation = .horizontal
            row.spacing = 8
            let l = NSTextField(labelWithString: label)
            l.font = .systemFont(ofSize: 11.5)
            l.textColor = .secondaryLabelColor
            l.widthAnchor.constraint(equalToConstant: 92).isActive = true
            let v = NSTextField(labelWithString: "—")
            v.font = .monospacedDigitSystemFont(ofSize: 12, weight: .regular)
            v.lineBreakMode = .byTruncatingTail
            row.addArrangedSubview(l)
            row.addArrangedSubview(v)
            stack.addArrangedSubview(row)
            anaValues[key] = v
        }

        let scroll = NSScrollView()
        scroll.hasVerticalScroller = true
        scroll.drawsBackground = false
        scroll.documentView = stack
        scroll.translatesAutoresizingMaskIntoConstraints = false
        let host = NSView(frame: NSRect(x: 0, y: 0, width: 340, height: 440))
        host.addSubview(scroll)
        NSLayoutConstraint.activate([
            scroll.leadingAnchor.constraint(equalTo: host.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: host.trailingAnchor),
            scroll.topAnchor.constraint(equalTo: host.topAnchor),
            scroll.bottomAnchor.constraint(equalTo: host.bottomAnchor),
        ])
        stack.translatesAutoresizingMaskIntoConstraints = false
        stack.widthAnchor.constraint(equalTo: scroll.widthAnchor).isActive = true

        p.contentView = host
        p.center()
        panelAna = p
    }

    private func refreshAnalysis() {
        currentSmiles { s in
            guard let s, !s.isEmpty else { return }
            self.post("/api/props", data: s) { r in
                guard let r, r["ok"] as? Bool == true else { return }
                func num(_ k: String, _ d: Int = 2) -> String {
                    if let v = r[k] as? Double { return String(format: "%.\(d)f", v) }
                    if let v = r[k] as? Int { return "\(v)" }
                    return "—"
                }
                self.anaValues["formula"]?.stringValue = (r["formula"] as? String) ?? "—"
                self.anaValues["mw"]?.stringValue = num("mw", 3)
                self.anaValues["exact_mass"]?.stringValue = num("exact_mass", 4)
                self.anaValues["logp"]?.stringValue = num("logp", 2)
                self.anaValues["tpsa"]?.stringValue = num("tpsa", 2) + " Å²"
                self.anaValues["hb"]?.stringValue = "\((r["hbd"] as? Int) ?? 0) / \((r["hba"] as? Int) ?? 0)"
                self.anaValues["rotb"]?.stringValue = "\((r["rotb"] as? Int) ?? 0)"
                self.anaValues["rings"]?.stringValue = "\((r["rings"] as? Int) ?? 0)"
                self.anaValues["heavy"]?.stringValue = "\((r["heavy"] as? Int) ?? 0)"
                if let ea = r["ea"] as? [String: Double] {
                    self.anaValues["ea"]?.stringValue = ea.keys.sorted()
                        .map { "\($0) \(String(format: "%.2f", ea[$0] ?? 0))%" }.joined(separator: "  ")
                }
                self.anaValues["smiles"]?.stringValue = (r["smiles"] as? String) ?? "—"
            }
        }
    }

    // MARK: 3D 窗口
    /// R05：warning = gen3dWarningText 的结果；非 nil 时显示在窗口副标题与状态区（纯文字），
    /// 不弹阻塞对话框，构象照常可查看。
    /// warning = 力场未收敛（副标题）；stereo = 立体来源（窗口内固定说明条）。
    /// 两者分别存储、同时可见，互不覆盖（D08）。
    private func open3DWindow(block: String, smiles: String, index: Int, total: Int,
                              warning: String? = nil, stereo: [String: Any]? = nil,
                              moleculeCount: Int = 1) {
        let cfg = WKWebViewConfiguration()
        let w = GestureWebView(frame: .zero, configuration: cfg)
        let win = Viewer3D(web: w)
        win.title = total > 1 ? "3D 预览 \(index + 1)/\(total) · \(smiles)" : "3D 预览 · \(smiles)"
        applyGen3DWarning(win, warning)
        win.stereoNote = stereoBadgeText(stereo, moleculeCount: moleculeCount)
        if let warning { setStatus(warning) }
        win.molblock = block
        win.delegate = self

        let bar = NSStackView()
        bar.orientation = .horizontal
        bar.spacing = 8
        bar.edgeInsets = NSEdgeInsets(top: 4, left: 10, bottom: 4, right: 10)
        bar.translatesAutoresizingMaskIntoConstraints = false

        let popup = NSPopUpButton()
        popup.addItems(withTitles: ["球棍模型", "棍模型", "线模型", "空间填充"])
        popup.target = self
        popup.action = #selector(actStyleChanged(_:))
        let spin = NSButton(checkboxWithTitle: "自转", target: self, action: #selector(actSpinChanged(_:)))
        let reset = NSButton(title: "复位", target: self, action: #selector(actReset3D))
        reset.bezelStyle = .rounded
        bar.addArrangedSubview(popup)
        bar.addArrangedSubview(spin)
        bar.addArrangedSubview(reset)
        bar.addArrangedSubview(NSView())

        // 示例构型的固定说明条：不随样式切换、旋转、缩放消失（D03/D08）
        let note = NSTextField(labelWithString: win.stereoNote ?? "")
        note.font = .systemFont(ofSize: 11.5)
        note.textColor = .secondaryLabelColor
        note.lineBreakMode = .byTruncatingTail
        note.translatesAutoresizingMaskIntoConstraints = false
        let noteHeight = note.heightAnchor.constraint(equalToConstant: win.stereoNote == nil ? 0 : 20)
        win.stereoLabel = note
        win.stereoHeight = noteHeight

        w.translatesAutoresizingMaskIntoConstraints = false
        let host = NSView()
        host.addSubview(w)
        host.addSubview(note)
        host.addSubview(bar)
        NSLayoutConstraint.activate([
            w.topAnchor.constraint(equalTo: host.topAnchor),
            w.leadingAnchor.constraint(equalTo: host.leadingAnchor),
            w.trailingAnchor.constraint(equalTo: host.trailingAnchor),
            w.bottomAnchor.constraint(equalTo: note.topAnchor),
            note.leadingAnchor.constraint(equalTo: host.leadingAnchor, constant: 10),
            note.trailingAnchor.constraint(equalTo: host.trailingAnchor, constant: -10),
            noteHeight,
            bar.topAnchor.constraint(equalTo: note.bottomAnchor),
            bar.leadingAnchor.constraint(equalTo: host.leadingAnchor),
            bar.trailingAnchor.constraint(equalTo: host.trailingAnchor),
            bar.bottomAnchor.constraint(equalTo: host.bottomAnchor),
            bar.heightAnchor.constraint(equalToConstant: 30),
        ])
        win.contentView = host
        win.stylePopup = popup
        win.spinCheck = spin

        let baseFrame = window.frame
        let off = CGFloat(index) * 28
        win.setFrame(NSRect(x: baseFrame.midX - 310 + off,
                            y: baseFrame.midY - 280 - off,
                            width: 620, height: 560), display: true)

        viewers.append(win)
        win.makeKeyAndOrderFront(nil)
        w.load(URLRequest(url: base.appendingPathComponent("threed.html")))
        push3D(win, attempts: 24)
    }

    private func push3D(_ win: Viewer3D, attempts: Int) {
        guard attempts > 0 else { return }
        win.web.evaluateJavaScript("typeof window.k3d") { v, _ in
            guard (v as? String) == "object" else {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                    self.push3D(win, attempts: attempts - 1)
                }
                return
            }
            let json = self.jsonLiteral(win.molblock)
            win.web.callAsyncJavaScript("window.k3d.show(\(json))",
                                        arguments: [:], in: nil, in: .page) { _ in }
        }
    }

    @objc func actStyleChanged(_ sender: NSPopUpButton) {
        guard let win = sender.window as? Viewer3D else { return }
        let styles = ["ballstick", "stick", "line", "sphere"]
        let s = styles[max(0, min(styles.count - 1, sender.indexOfSelectedItem))]
        win.web.callAsyncJavaScript("window.k3d && window.k3d.style('\(s)')",
                                    arguments: [:], in: nil, in: .page) { _ in }
    }

    @objc func actSpinChanged(_ sender: NSButton) {
        guard let win = sender.window as? Viewer3D else { return }
        let on = sender.state == .on ? "true" : "false"
        win.web.callAsyncJavaScript("window.k3d && window.k3d.spin(\(on))",
                                    arguments: [:], in: nil, in: .page) { _ in }
    }

    @objc func actReset3D() {
        guard let win = NSApp.keyWindow as? Viewer3D else { return }
        win.web.callAsyncJavaScript("window.k3d && window.k3d.reset()",
                                    arguments: [:], in: nil, in: .page) { _ in }
    }

    // MARK: 捏合缩放
    private func installMagnifyMonitor() {
        _ = NSEvent.addLocalMonitorForEvents(matching: [.magnify, .rotate]) { [weak self] ev in
            guard let self else { return ev }

            // 双指旋转手势 → 3D 绕屏幕法线旋转
            if ev.type == .rotate {
                guard let v = self.viewers.first(where: { $0 === ev.window }) else { return ev }
                let deg = CGFloat(ev.rotation)      // 度，系统已算好
                if abs(deg) > 0.01 {
                    self.dbg("ROTATE3D \(deg)")
                    v.web.callAsyncJavaScript("window.k3d && window.k3d.rotateBy(\(-deg))",
                                              arguments: [:], in: nil, in: .page) { _ in }
                }
                return nil
            }

            // 捏合 → 缩放
            let f = 1.0 + ev.magnification
            guard f > 0 else { return ev }
            if let v = self.viewers.first(where: { $0 === ev.window }) {
                v.web.callAsyncJavaScript("window.k3d && window.k3d.zoomBy(\(f))",
                                          arguments: [:], in: nil, in: .page) { _ in }
                return nil
            }
            if ev.window === self.window {
                let point = self.web.convert(ev.locationInWindow, from: nil)
                guard self.web.bounds.contains(point) else { return ev }
                let x = point.x - self.web.bounds.minX
                let y = self.web.isFlipped ? point.y - self.web.bounds.minY : self.web.bounds.maxY - point.y
                self.js("window.k3dAPI.zoomBy(\(f), {x: \(x), y: \(y)})")
                return nil
            }
            return ev
        }
    }

    // MARK: 桥
    func userContentController(_ uc: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "k3d" else { return }
        let body = message.body as? [String: Any] ?? [:]
        let act = body["act"] as? String ?? ""
        if act == "nativeUI" {
            if let decoded = workspaceBridge?.parseScriptMessage(message) {
                _ = workspaceCoordinator?.receiveMessage(decoded)
            }
            return
        }
        switch act {
        case "save": actSave()
        case "saveAs": actSaveAs()
        case "paste": actPaste()
        case "open": actOpen()
        case "new": actNewDocument()
        case "help": actShowHelp()
        case "openExample": actOpenExample()
        case "gen3d": actGen3D()
        case "props": actProps()
        case "check": actCheck()
        case "clean": actClean()
        case "layoutResult": reportLayoutResult(body)
        case "revealCanvas":
            if !window.isVisible {
                window.makeKeyAndOrderFront(nil)
                welcomeWin?.orderOut(nil)
                updateTitle()
            }
        case "exportMechanismImage":
            if let kind = body["kind"] as? String { exportMechanismImage(kind) }
        case "exportDocumentPDF": actExportDocumentPDF()
        case "clipboardWrite":
            guard let text = body["text"] as? String, !text.isEmpty else {
                if let requestID = body["requestId"] as? String {
                    js("window.k3dAPI && window.k3dAPI.mechClipboardWriteResult(\(jsonLiteral(requestID)), false)")
                }
                break
            }
            let requestID = body["requestId"] as? String
            let ok = writeMechanismClipboard(text)
            if let requestID {
                js("window.k3dAPI && window.k3dAPI.mechClipboardWriteResult(\(jsonLiteral(requestID)), \(ok ? "true" : "false"))")
            }
        // 页面拿不到纯文本时（例如别处写进来的自定义类型）向原生要一次载荷
        case "clipboardRead":
            if let text = readMechanismClipboard() {
                js("return window.k3dAPI.mechPaste(\(jsonLiteral(text)))")
            }
        default: break
        }
    }

    func windowWillClose(_ notification: Notification) {
        guard let win = notification.object as? Viewer3D else { return }
        viewers.removeAll { $0 === win }
        dbg("3D 窗口关闭，剩余 \(viewers.count)")
    }

    // MARK: 页面载入失败（R02 补）
    /// 页面根本没能载入（服务未起/端口被占/返回错误）：没有 didFinish 就没有注入流程，
    /// 必须在这里释放导航事务，否则门闸会永久关闭（存不了、关不掉、退不了）。
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        guard webView === web else { return }
        if (error as NSError).code == NSURLErrorCancelled { return }   // 被下一次导航取代，不算失败
        dbg("didFailProvisional \(error.localizedDescription)")
        abortNavigation(reason: "编辑器页面无法载入：\(error.localizedDescription)")
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        guard webView === web else { return }
        if (error as NSError).code == NSURLErrorCancelled { return }
        dbg("didFail \(error.localizedDescription)")
        abortNavigation(reason: "编辑器页面载入中断：\(error.localizedDescription)")
    }

    /// 渲染进程崩溃（内存不足等）：页面内容已失效，立即降级为"以内存快照为准"。
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        guard webView === web else { return }
        dbg("webContentProcessDidTerminate")
        abortNavigation(reason: "页面渲染进程已退出（可能内存不足），页面内容已失效。")
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        guard webView === web else { return }
        dbg("didStart \(webView.url?.absoluteString ?? "?")")
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        dbg("didFinish \(webView.url?.absoluteString ?? "?")")
        // S01：失败后页面处于隔离状态，迟到的 didFinish 不得重新激活它（只有新导航能解除隔离）
        guard !pageQuarantined else { return dbg("didFinish ignored (page quarantined)") }
        let gen = navigationGeneration
        let mode = activeMode
        // 等待真实画布接口就绪后再注入内容
        waitPageReady(mode: mode, gen: gen, attemptsLeft: 60) { [weak self] ready in
            guard let self else { return }
            guard gen == self.navigationGeneration else { return }   // 旧导航的回调不能写入新页面
            guard ready else {
                // R02 补：就绪超时同样走失败出口，不能只弹个框把门闸永久关着
                return self.abortNavigation(reason: "结构画布页面 30 秒内没有就绪。")
            }
            self.applyPending(mode: mode, gen: gen)
        }
    }

    // MARK: 表格
    func numberOfRows(in tableView: NSTableView) -> Int { fileList.count }

    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        guard row < fileList.count else { return nil }
        let url = fileList[row]
        let id = NSUserInterfaceItemIdentifier("cell")
        let cell: NSTableCellView
        if let reused = tableView.makeView(withIdentifier: id, owner: self) as? NSTableCellView {
            cell = reused
        } else {
            cell = NSTableCellView()
            cell.identifier = id

            let icon = NSImageView()
            icon.translatesAutoresizingMaskIntoConstraints = false
            cell.addSubview(icon)
            // NSTableCellView.textField 是 assign（裸指针）属性：必须先有强引用（addSubview）再赋值
            let tf = NSTextField(labelWithString: "")
            tf.translatesAutoresizingMaskIntoConstraints = false
            tf.lineBreakMode = .byTruncatingMiddle
            cell.addSubview(tf)
            cell.textField = tf

            let ext = url.pathExtension.lowercased()
            let iconName: String
            switch ext {
            case "ket": iconName = "doc.text"
            case "mol", "sdf": iconName = "cube.transparent"
            case "cdxml": iconName = "pencil.and.outline"
            case "smi": iconName = "text.justify.left"
            default: iconName = "doc"
            }
            icon.image = NSImage(systemSymbolName: iconName, accessibilityDescription: ext)

            // 行尾：重命名 / 删除（小、轻、悬停微亮，安静不抢眼）
            let cfg = NSImage.SymbolConfiguration(pointSize: 11, weight: .medium)
            let renameImg = NSImage(systemSymbolName: "square.and.pencil", accessibilityDescription: "重命名")?
                .withSymbolConfiguration(cfg) ?? NSImage()
            let rename = HoverButton(image: renameImg, target: self, action: #selector(actRenameFile(_:)))
            rename.isBordered = false
            rename.contentTintColor = .tertiaryLabelColor
            let delImg = NSImage(systemSymbolName: "trash", accessibilityDescription: "删除")?
                .withSymbolConfiguration(cfg) ?? NSImage()
            let del = HoverButton(image: delImg, target: self, action: #selector(actDeleteFile(_:)))
            del.isBordered = false
            del.contentTintColor = .tertiaryLabelColor
            // 悬停提亮；按下高亮，删除按下变红示警
            rename.hoverTint = .secondaryLabelColor
            rename.pressTint = .controlAccentColor
            del.hoverTint = .secondaryLabelColor
            del.pressTint = .systemRed
            for b in [rename, del] { b.translatesAutoresizingMaskIntoConstraints = false; b.tag = row }
            cell.addSubview(rename)
            cell.addSubview(del)

            NSLayoutConstraint.activate([
                icon.leadingAnchor.constraint(equalTo: cell.leadingAnchor, constant: 8),
                icon.centerYAnchor.constraint(equalTo: cell.centerYAnchor),
                icon.widthAnchor.constraint(equalToConstant: 18),
                tf.leadingAnchor.constraint(equalTo: icon.trailingAnchor, constant: 7),
                tf.centerYAnchor.constraint(equalTo: cell.centerYAnchor),
                tf.trailingAnchor.constraint(lessThanOrEqualTo: rename.leadingAnchor, constant: -6),
                del.trailingAnchor.constraint(equalTo: cell.trailingAnchor, constant: -8),
                del.centerYAnchor.constraint(equalTo: cell.centerYAnchor),
                del.widthAnchor.constraint(equalToConstant: 22),
                del.heightAnchor.constraint(equalToConstant: 20),
                rename.trailingAnchor.constraint(equalTo: del.leadingAnchor, constant: 0),
                rename.centerYAnchor.constraint(equalTo: cell.centerYAnchor),
                rename.widthAnchor.constraint(equalToConstant: 22),
                rename.heightAnchor.constraint(equalToConstant: 20),
            ])
        }
        cell.textField?.stringValue = url.lastPathComponent
        cell.textField?.textColor = .labelColor
        if let iv = cell.subviews.compactMap({ $0 as? NSImageView }).first {
            let ext2 = url.pathExtension.lowercased()
            let iconName2: String
            switch ext2 {
            case "ket": iconName2 = "doc.text"
            case "mol", "sdf": iconName2 = "cube.transparent"
            case "cdxml": iconName2 = "pencil.and.outline"
            case "smi": iconName2 = "text.justify.left"
            default: iconName2 = "doc"
            }
            let img2 = NSImage(systemSymbolName: iconName2, accessibilityDescription: ext2)?
                .withSymbolConfiguration(NSImage.SymbolConfiguration(pointSize: 13, weight: .regular))
            iv.image = img2
        }
        // tag 记录行号（cell 复用时要更新按钮 tag）
        for v in cell.subviews { (v as? HoverButton)?.tag = row }
        return cell
    }

    // MARK: 文件管理：重命名 / 删除
    /// 右键菜单入口：定位鼠标所在行，复用按钮的处理逻辑
    @objc func actRenameFromMenu(_ sender: NSMenuItem) { rowMenuAction(#selector(actRenameFile(_:))) }
    @objc func actDeleteFromMenu(_ sender: NSMenuItem) { rowMenuAction(#selector(actDeleteFile(_:))) }

    private func rowMenuAction(_ sel: Selector) {
        guard let t = fileTable, t.clickedRow >= 0, t.clickedRow < fileList.count else { return }
        let fake = NSButton()
        fake.tag = t.clickedRow
        NSApp.sendAction(sel, to: self, from: fake)
    }

    @objc func actRenameFile(_ sender: NSButton) {
        guard sender.tag < fileList.count else { return }
        renameRecentFile(at: fileList[sender.tag])
    }

    private func renameRecentFile(at url: URL) {
        let a = NSAlert()
        a.messageText = "重命名"
        a.informativeText = url.lastPathComponent
        let input = NSTextField(string: url.lastPathComponent)
        input.frame = NSRect(x: 0, y: 0, width: 260, height: 24)
        a.accessoryView = input
        a.addButton(withTitle: "好")
        a.addButton(withTitle: "取消")
        a.window.initialFirstResponder = input
        guard a.runModal() == .alertFirstButtonReturn else { return }
        var name = input.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { return }
        if !name.contains(".") { name += "." + url.pathExtension }
        let newURL = url.deletingLastPathComponent().appendingPathComponent(name)
        if newURL.lastPathComponent != url.lastPathComponent {
            do {
                try FileManager.default.moveItem(at: url, to: newURL)
                if let directory = docsDir?.appendingPathComponent("thumbnails", isDirectory: true) {
                    WelcomeThumbnailCache.copy(from: url, to: newURL, directory: directory, renamed: true)
                }
                if currentFile?.standardizedFileURL == url.standardizedFileURL {
                    currentFile = newURL
                    appUserDefaults.set(newURL.path, forKey: "lastFile")
                    updateTitle()
                }
                if let item = welcomeModel?.recentItems.first(where: { $0.id == WelcomeRecents.canonicalPath(for: url) }) {
                    welcomeModel?.removeRecent(item)
                }
                noteRecentDocument(newURL)
                setStatus("已重命名为 \(name)")
            } catch { alert("重命名失败", error.localizedDescription) }
        }
    }

    @objc func actDeleteFile(_ sender: NSButton) {
        guard sender.tag < fileList.count else { return }
        let url = fileList[sender.tag]
        let a = NSAlert()
        a.messageText = "要删除“\(url.lastPathComponent)”吗？"
        a.informativeText = "此操作无法撤销。"
        a.alertStyle = .warning
        a.addButton(withTitle: "删除")
        a.addButton(withTitle: "取消")
        guard a.runModal() == .alertFirstButtonReturn else { return }
        do {
            try FileManager.default.trashItem(at: url, resultingItemURL: nil)
            if currentFile?.standardizedFileURL == url.standardizedFileURL {
                currentFile = nil
                appUserDefaults.removeObject(forKey: "lastFile")
            }
            refreshFileList()
            setStatus("已删除 \(url.lastPathComponent)")
        } catch { alert("删除失败", error.localizedDescription) }
    }

    // MARK: 工具
    private func jsonLiteral(_ s: String) -> String {
        guard let d = try? JSONSerialization.data(withJSONObject: [s]),
              let str = String(data: d, encoding: .utf8) else { return "\"\"" }
        return String(str.dropFirst().dropLast())
    }

    /// 扩展名 → UTType（替代弃用的 allowedFileTypes；未注册的自定义扩展名会生成动态类型）
    private func contentTypes(_ exts: [String]) -> [UTType] {
        exts.compactMap { ext in
            if let t = UTType(filenameExtension: ext) { return t }
            // .molwork 是应用私有格式，系统没有注册，按导出的 JSON 派生类型处理
            if ext == "molwork" { return UTType(exportedAs: "local.ketcher3d.molwork", conformingTo: .json) }
            return nil
        }
    }

    private func alert(_ title: String, _ msg: String) {
        let a = NSAlert()
        a.messageText = title
        a.informativeText = msg
        a.alertStyle = .informational
        a.addButton(withTitle: "好")
        a.runModal()
    }

    @objc func actAbout() {
        let a = NSAlert()
        a.messageText = "MolStudio"
        a.informativeText = """
        分子结构编辑与 3D 预览 · 原生 macOS 外壳（AppKit + WebKit）
        2D 画布：Ketcher 3.18（Apache-2.0）
        3D 渲染：NGL（MIT）
        3D 构象与分析：RDKit（BSD）
        """
        a.addButton(withTitle: "好")
        a.runModal()
    }

    // MARK: 帮助
    /// 菜单"帮助 > MolStudio 帮助"与画布页内"帮助"按钮共用。
    /// 独立窗口加载随包的 help.html，不联网、不依赖当前画布内容。
    @objc func actShowHelp() {
        if let w = helpWin {
            w.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return
        }
        let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 760, height: 620),
                         styleMask: [.titled, .closable, .miniaturizable, .resizable],
                         backing: .buffered, defer: false)
        w.title = "MolStudio 帮助"
        w.isReleasedWhenClosed = false
        w.center()
        let cfg = WKWebViewConfiguration()
        // 帮助页里的"打开示例"需要与主页面同一条原生桥
        cfg.userContentController.add(self, name: "k3d")
        let v = WKWebView(frame: .zero, configuration: cfg)
        v.autoresizingMask = [.width, .height]
        w.contentView = v
        v.load(URLRequest(url: base.appendingPathComponent("help.html")))
        helpWin = w
        w.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    /// 欢迎页/帮助页"打开示例"：载入随包分发的已验收机理夹具（F01：OH⁻ + CH₃Br）。
    /// 打包态读 Resources/examples/，开发态读 fusion/tests/fixtures/（同一份源文件）。
    @objc func actOpenExample() {
        guard let url = exampleDocumentURL() else {
            return alert("示例不可用", "找不到示例文件 examples/OH-CH3Br.molwork。请重新构建 MolStudio.app。")
        }
        if let w = helpWin, w.isVisible { w.orderOut(nil) }
        openDocument(at: url)
    }

    private func exampleDocumentURL() -> URL? {
        let fm = FileManager.default
        let bundled = kServerDir.appendingPathComponent("examples/OH-CH3Br.molwork")
        if fm.fileExists(atPath: bundled.path) { return bundled }
        // 开发态（非打包运行，kServerDir = fusion/）：直接读源码树里的同一份夹具
        let dev = kServerDir.appendingPathComponent("tests/fixtures/workbench-mechanism/F01.molwork")
        return fm.fileExists(atPath: dev.path) ? dev : nil
    }

    private func startAcceptanceObserverIfRequested() {
        let cfg = AppRuntimeConfig.shared
        guard let controlPath = cfg.acceptanceControlFilePath, !controlPath.isEmpty else { return }
        let server = AcceptanceTelemetryServer(controlFilePath: controlPath, runtimeConfig: cfg) { [weak self] in
            self?.buildAcceptanceSnapshot() ?? ["ok": false]
        }
        if server.start() {
            acceptanceTelemetryServer = server
            dbg("acceptance telemetry started on loopback port \(server.port)")
        } else {
            dbg("acceptance telemetry failed to start for control file \(controlPath)")
        }
    }

    @MainActor
    private func buildAcceptanceSnapshot() -> [String: Any] {
        let cfg = AppRuntimeConfig.shared
        let coord = workspaceCoordinator
        let ui = coord?.uiState ?? .disabledInitial()
        let agent = coord?.agentStore
        let splitVC = workspaceSplitVC
        let documentInfo: [String: Any] = [
            "mode": ui.document?.mode?.rawValue ?? ui.viewport.mode.rawValue,
            "pageCount": ui.document?.pageCount ?? 0,
            "size": ui.document?.size ?? "",
            "orientation": ui.document?.orientation ?? "",
            "marginMm": ui.document?.marginMm ?? 0,
            "canRemoveLastPage": ui.document?.canRemoveLastPage ?? false,
        ]
        let agentPublic: [String: Any] = [
            "hasSnapshot": agent?.hasSnapshot ?? false,
            "configured": agent?.config.configured ?? false,
            "provider": agent?.config.provider ?? "",
            "baseUrl": agent?.config.baseUrl ?? "",
            "model": agent?.config.model ?? "",
            "generationProfile": agent?.config.generation.profile ?? "",
            "generationEffort": agent?.config.generation.effort ?? "",
            "running": agent?.running ?? false,
            "pendingStart": agent?.pendingStart ?? false,
            "canContinue": agent?.canContinue ?? false,
            "statusText": agent?.statusText ?? "",
            "errorMessage": agent?.errorMessage ?? "",
            "timelineCount": agent?.timeline.count ?? 0,
            "usageSummary": agent?.usageSummary ?? "",
            "checkpointStatus": agent?.checkpoint?.status ?? "",
            "checkpointPhaseIndex": agent?.checkpoint?.phaseIndex ?? -1,
            "checkpointPhaseCount": agent?.checkpoint?.phases?.count ?? 0,
        ]
        var info: [String: Any] = [
            "ok": true,
            "pid": ProcessInfo.processInfo.processIdentifier,
            "bundleId": cfg.bundleIdentifier,
            "isBundled": kIsBundled,
            "isIsolated": cfg.isIsolated,
            "isolationProfile": cfg.isolationProfile ?? "",
            "port": kPort,
            "docsDir": cfg.docsDirectoryURL.path,
            "agentConfigDir": cfg.agentConfigDirectoryURL?.path ?? "",
            "defaultsSuite": cfg.defaultsSuiteName ?? "",
            "windowVisible": window?.isVisible ?? false,
            "welcomeVisible": welcomeWin?.isVisible ?? false,
            "windowTitle": window?.title ?? "",
            "windowSubtitle": window?.subtitle ?? "",
            "pageUsable": pageUsable,
            "navigationInFlight": navigationInFlight,
            "currentFile": currentFile?.path ?? "",
            "dirty": isDirty,
            "coordinator": [
                "navigationGeneration": coord?.navigationGeneration ?? 0,
                "isAttaching": coord?.isAttaching ?? false,
                "attached": coord?.attachedEpoch != nil,
                "attachedPageId": coord?.attachedEpoch?.pageId ?? "",
                "lastSequence": coord?.lastSequence ?? -1,
                "ownedSurfaces": (coord?.ownedSurfaces.map(\.rawValue).sorted() ?? []),
                "uiRevision": ui.revision,
                "readyCanvas": ui.ready.canvas,
                "readyAgent": ui.ready.agent,
                "toolId": ui.tool.id as Any,
                "toolLabel": ui.tool.label,
                "supportedCommands": ui.supported.commands,
                "supportedToolIds": ui.supported.toolIds,
                "selectionKind": ui.selection.kind.rawValue,
                "selectionCount": ui.selection.count,
                "canUndo": ui.history.canUndo,
                "canRedo": ui.history.canRedo,
                "viewportMode": ui.viewport.mode.rawValue,
                "viewportPercent": ui.viewport.percent as Any,
                "viewportCssSize": ["width": ui.viewport.cssSize.width, "height": ui.viewport.cssSize.height],
                "document": documentInfo,
                "sidebarCollapsed": splitVC?.isSidebarCollapsed ?? true,
                "inspectorCollapsed": splitVC?.isInspectorCollapsed ?? true,
                "inspectorTab": (splitVC?.inspectorViewController.selectedTab == .agent) ? "agent" : "properties",
                "agent": agentPublic,
            ],
        ]
        if let welcomeCount = welcomeModel?.recentItems.count {
            info["welcomeRecentCount"] = welcomeCount
        }
        return info
    }

    private func dbg(_ msg: String) {
        let logPath = AppRuntimeConfig.shared.logFilePath
        let line = "[\(Date())] \(msg)\n"
        if let h = FileHandle(forWritingAtPath: logPath) {
            h.seekToEndOfFile(); h.write(line.data(using: .utf8)!); h.closeFile()
        } else {
            try? line.write(toFile: logPath, atomically: true, encoding: .utf8)
        }
    }
}

// MARK: - 启动
// 单实例守护：正式包已有相同 Bundle ID 在运行就把它调到前台、自己退出（避免双实例抢 8462 端口）。
// 隔离候选构建与取证构建另开端口与数据目录，不与正在用的实例互相抢占。
let selftestIsolatedPort = AppRuntimeConfig.shared.selftestIsolatedPort
if !AppRuntimeConfig.shared.allowMultipleInstances {
    for running in NSRunningApplication.runningApplications(withBundleIdentifier: AppRuntimeConfig.shared.bundleIdentifier)
    where running != .current {
        running.activate()
        exit(0)
    }
}
let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()

#if MOLSTUDIO_SELFTEST
// MARK: - 验收取证（仅 -D MOLSTUDIO_SELFTEST 编译，正常构建不含本段）
extension AppDelegate {
    func scheduleSelfTest() {
        let env = ProcessInfo.processInfo.environment
        guard let action = env["MOLSTUDIO_SELFTEST"], !action.isEmpty else { return }
        // 记下用户原本在用的 App，取证结束后把前台还回去（窗口已最小化，但 App 会被激活）
        let previousApp = NSWorkspace.shared.frontmostApplication
        self.selfTestPreviousApp = previousApp
        let ketPath = env["MOLSTUDIO_SELFTEST_KET"] ?? ""
        let ket = (try? String(contentsOfFile: ketPath, encoding: .utf8)) ?? ""

        DispatchQueue.main.asyncAfter(deadline: .now() + 4) {
            if action == "document" {
                self.captureWelcomeSelfTestScreenshot()
                self.welcomeModel?.paperSetup = WelcomePaperSetup()
                self.actNewPaperDocument()
            } else {
                self.actNewDocument()      // 从欢迎页进入结构画布
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 11) {
            if action != "document" && !ket.isEmpty {
                self.js("await window.k3dAPI.setMolecule(\(self.jsonLiteral(ket)))")
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 15) {
            switch action {
            case "layout": self.actClean()
            case "mech": self.runMechanismSelfTest()
            case "clipboard": self.runClipboardSelfTest()
            case "document": self.runDocumentSelfTest()
            case "thumbnail-canvas": self.runCanvasThumbnailSelfTest()
            case "gen3d": self.actGen3D()
            case "gen3d-example":
                self.selfTestAutoExample = true
                self.actGen3D()
            default: break
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 22) {
            // 验证标识不随样式切换消失（D03/D08）
            if let win = self.viewers.first, let popup = win.stylePopup {
                popup.selectItem(at: 2)
                self.actStyleChanged(popup)
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 26) {
            // 注入一条力场警告，验证两种信息同时可见（D08；警告文案为取证注入）
            if let win = self.viewers.first {
                self.applyGen3DWarning(win, "未收敛：MMFF 力场优化未在 2000 次迭代内收敛，构象可能未达到能量极小")
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 95) {
            self.selfTestPreviousApp?.activate()
            self.server?.terminate()
            exit(0)
        }
    }

    func jsValueDetailed(_ body: String, _ done: @escaping (Any?, Bool, String?) -> Void) {
        guard let web else { return done(nil, false, "no web view") }
        web.callAsyncJavaScript(body, arguments: [:], in: nil, in: .page) { result in
            switch result {
            case .success(let v): done(v, true, nil)
            case .failure(let e): done(nil, false, String(describing: e))
            }
        }
    }

    static func writeSelfTestReport(_ report: [String: Any], to path: String) {
        if let data = try? JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]) {
            try? data.write(to: URL(fileURLWithPath: path))
        }
    }

    func captureWelcomeSelfTestScreenshot() {
        guard let path = ProcessInfo.processInfo.environment["MOLSTUDIO_SELFTEST_WELCOME_PNG"],
              let content = welcomeWin?.contentView, let bitmap = content.bitmapImageRepForCachingDisplay(in: content.bounds) else { return }
        content.cacheDisplay(in: content.bounds, to: bitmap)
        if let data = bitmap.representation(using: .png, properties: [:]) { try? data.write(to: URL(fileURLWithPath: path), options: .atomic) }
    }

    func runCanvasThumbnailSelfTest() {
        let env = ProcessInfo.processInfo.environment
        let output = env["MOLSTUDIO_SELFTEST_OUT"] ?? NSTemporaryDirectory() + "molstudio-canvas-thumb-selftest.json"
        let path = env["MOLSTUDIO_SELFTEST_SAVE"] ?? NSTemporaryDirectory() + "molstudio-canvas-thumb-selftest.molwork"
        let target = URL(fileURLWithPath: path)
        var report: [String: Any] = ["application": "MolStudio native canvas", "page": "fusion/canvas.html",
                                     "build": "MOLSTUDIO_SELFTEST isolated native app", "port": kPort]
        var done = false
        func finish(_ error: String? = nil) {
            guard !done else { return }; done = true
            report["ok"] = error == nil; report["error"] = error
            Self.writeSelfTestReport(report, to: output)
            self.selfTestPreviousApp?.activate(); self.server?.terminate(); exit(error == nil ? 0 : 1)
        }
        func waitUntil(_ predicate: @escaping () -> Bool, remaining: Int = 100, completion: @escaping (Bool) -> Void) {
            if done { return }; if predicate() { return completion(true) }; if remaining <= 0 { return completion(false) }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { waitUntil(predicate, remaining: remaining - 1, completion: completion) }
        }
        guard selftestIsolatedPort, !FileManager.default.fileExists(atPath: target.path),
              let source = exampleDocumentURL(), let text = try? String(contentsOf: source, encoding: .utf8) else {
            return finish("Missing isolated port or example, or output already exists")
        }
        waitUntil({ self.pageUsable && !self.navigationInFlight && self.canvasSession.initialized }) { ready in
            guard ready else { return finish("Canvas not ready") }
            self.jsValue("return JSON.stringify(await window.k3dAPI.loadWorkbench(\(self.jsonLiteral(text))))") { value, ok in
                guard ok, let json = value as? String, let data = json.data(using: .utf8),
                      let result = try? JSONSerialization.jsonObject(with: data) as? [String: Any], result["ok"] as? Bool == true else {
                    return finish("Cannot load F01 fixture")
                }
                self.canvasSession.fileURL = target
                self.saveSession(.canvas, forceSaveAs: false) { saved in
                    guard saved else { return finish("Native save failed") }
                    let directory = self.docsDir.appendingPathComponent("thumbnails", isDirectory: true)
                    waitUntil({ WelcomeThumbnailCache.record(for: target, directory: directory)?.hasThumbnail == true }) { ready in
                        guard ready else { return finish("Canvas thumbnail was not generated") }
                        let thumbnail = WelcomeThumbnailCache.paths(for: target, directory: directory).png
                        let bitmap = WelcomeThumbnailCache.readBounded(thumbnail, limit: WelcomeThumbnailCache.maxPNGBytes).flatMap(NSBitmapImageRep.init(data:))
                        let recent = WelcomeRecents.merge(recentURLs: [target], directoryURLs: [], thumbnailsDirectoryURL: directory).first
                        report["thumbnailPath"] = thumbnail.path; report["width"] = bitmap?.pixelsWide; report["height"] = bitmap?.pixelsHigh
                        guard bitmap?.pixelsWide == 480, (bitmap?.pixelsHigh ?? 0) > 0, recent?.mode == .canvas, recent?.thumbnailURL != nil else {
                            return finish("Canvas thumbnail dimensions or recent metadata invalid")
                        }
                        finish()
                    }
                }
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 55) { finish("Canvas thumbnail self-test timed out") }
    }

    /// Native self-test build, isolated service and bundle ID: exercises the real
    /// welcome action, paper initialization, full snapshot save/open and WK view.
    func runDocumentSelfTest() {
        let env = ProcessInfo.processInfo.environment
        let out = env["MOLSTUDIO_SELFTEST_OUT"] ?? NSTemporaryDirectory() + "molstudio-document-selftest.json"
        let savePath = env["MOLSTUDIO_SELFTEST_SAVE"] ?? NSTemporaryDirectory() + "molstudio-document-selftest.molwork"
        let target = URL(fileURLWithPath: savePath)
        var report: [String: Any] = ["application": "MolStudio native canvas", "page": "fusion/canvas.html",
            "build": "MOLSTUDIO_SELFTEST isolated native app", "port": kPort, "savePath": savePath, "checks": [String: Bool]()]
        var checks: [String: Bool] = [:], finished = false
        func finish(_ error: String? = nil) {
            guard !finished else { return }; finished = true
            report["checks"] = checks; report["error"] = error
            report["ok"] = error == nil && checks.values.allSatisfy { $0 }
            Self.writeSelfTestReport(report, to: out)
            self.selfTestPreviousApp?.activate(); self.server?.terminate()
            exit((report["ok"] as? Bool) == true ? 0 : 1)
        }
        func waitUntil(_ predicate: @escaping () -> Bool, remaining: Int = 150, done: @escaping (Bool) -> Void) {
            guard !finished else { return }
            if predicate() { return done(true) }
            if remaining <= 0 { return done(false) }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { waitUntil(predicate, remaining: remaining - 1, done: done) }
        }
        guard selftestIsolatedPort else { return finish("Self-test requires a separate MOLSTUDIO_SELFTEST_PORT") }
        guard !FileManager.default.fileExists(atPath: target.path) else { return finish("Self-test target already exists; refusing to overwrite it") }
        guard let example = exampleDocumentURL(), let seed = try? String(contentsOf: example, encoding: .utf8) else { return finish("F01 example unavailable") }
        if let welcome = env["MOLSTUDIO_SELFTEST_WELCOME_PNG"] { checks["welcomeScreenshot"] = FileManager.default.fileExists(atPath: welcome) }
        waitUntil({ self.pageUsable && !self.navigationInFlight && self.canvasSession.initialized }) { ready in
            guard ready else { return finish("New paper navigation timed out") }
            checks["newPaperClean"] = !self.canvasSession.dirty && self.canvasSession.fileURL == nil
            let script = """
            const state = window.k3dAPI.document.getState();
            if (state.mode !== 'paper' || state.page.size !== 'A4' || state.page.orientation !== 'portrait') throw new Error('paper setup mismatch');
            const fixture = JSON.parse(\(self.jsonLiteral(seed))); fixture.version = 2; fixture.document = state;
            const loaded = await window.k3dAPI.loadWorkbench(JSON.stringify(fixture));
            if (!loaded.ok) throw new Error(loaded.error || 'fixture load failed');
            const a = window.MolWorkbench.app.adapter, atoms = [...a.struct().atoms.values()];
            if (atoms.length) {
              const x = Math.min(...atoms.map(atom => atom.pp.x)), y = Math.min(...atoms.map(atom => atom.pp.y));
              for (const atom of atoms) { atom.pp.x += 5 - x; atom.pp.y += 12 - y; }
              a.ed.update(true);
            }
            const text = window.k3dAPI.document.addText({x:4,y:5,w:20,h:2,text:'中文纸页 原生验收'});
            const shape = window.k3dAPI.document.addShape({x:24,y:10,w:5,h:3,shape:'rect',fill:'#ffffff'});
            const image = await window.k3dAPI.document.addImage({x:24,y:16,w:3,h:3,dataUrl:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGO4o6EBRAwQCgAjrgSxn17XlQAAAABJRU5ErkJggg=='});
            return { text, shape, image, atoms:atoms.length, arrows:window.MolWorkbench.app.model.state.arrows.length,
                     lonePairs:window.MolWorkbench.app.model.state.lonePairs.length };
            """
            self.jsValue(script) { value, ok in
                guard ok, let seeded = value as? [String: Any], let textID = seeded["text"] as? String else { return finish("Cannot seed paper fixture") }
                report["seeded"] = seeded
                checks["fixtureHasChemistry"] = (seeded["atoms"] as? Int ?? 0) > 0 && (seeded["arrows"] as? Int ?? 0) > 0 && (seeded["lonePairs"] as? Int ?? 0) > 0
                self.canvasSession.fileURL = target
                self.saveSession(.canvas, forceSaveAs: false) { saved in
                    checks["nativeSave"] = saved && FileManager.default.fileExists(atPath: target.path)
                    guard saved else { return finish("Native save failed") }
                    let directory = self.docsDir.appendingPathComponent("thumbnails", isDirectory: true)
                    waitUntil({ WelcomeThumbnailCache.record(for: target, directory: directory)?.hasThumbnail == true }, remaining: 100) { thumbReady in
                        guard thumbReady else { return finish("Saved document thumbnail was not generated") }
                        let thumb = WelcomeThumbnailCache.paths(for: target, directory: directory).png
                        let bitmap = WelcomeThumbnailCache.readBounded(thumb, limit: WelcomeThumbnailCache.maxPNGBytes).flatMap(NSBitmapImageRep.init(data:))
                        checks["thumbnailDimensions"] = bitmap?.pixelsWide == 480 && (bitmap?.pixelsHigh ?? 0) > 0
                        let recents = WelcomeRecents.merge(recentURLs: [target], directoryURLs: [], thumbnailsDirectoryURL: directory)
                        checks["externalRecentMerge"] = !target.path.hasPrefix(self.docsDir.standardizedFileURL.path + "/") &&
                            recents.first?.id == WelcomeRecents.canonicalPath(for: target) && recents.first?.mode == .paper && recents.first?.thumbnailURL != nil
                        report["thumbnailPath"] = thumb.path
                        let generation = self.navigationGeneration
                        self.openDocument(at: target)
                        waitUntil({ self.navigationGeneration > generation && !self.navigationInFlight && self.pageUsable && self.canvasSession.fileURL == target }) { reopened in
                        guard reopened else { return finish("Native reopen timed out") }
                        checks["reopenedClean"] = !self.canvasSession.dirty
                        let verify = """
                        const state = window.k3dAPI.document.getState(), model = window.MolWorkbench.app.model.state;
                        const text = state.objects.find(o => o.id === \(self.jsonLiteral(textID)));
                        if (!text) throw new Error('text object missing after reopen');
                        window.k3dAPI.document.updateObject(text.id, {rich:{...text.rich,text:text.rich.text+'!'}});
                        const edited = window.k3dAPI.document.getState().objects.find(o => o.id === text.id).rich.text.endsWith('!');
                        return {mode:state.mode, objects:state.objects.map(o=>o.kind), text:text.rich.text,
                                atoms:window.MolWorkbench.app.adapter.struct().atoms.size,
                                arrows:model.arrows.length,lonePairs:model.lonePairs.length,editable:edited};
                        """
                        self.jsValue(verify) { result, ok in
                            guard ok, let result = result as? [String: Any] else { return finish("Cannot verify reopened document") }
                            report["reopened"] = result
                            let kinds = result["objects"] as? [String] ?? []
                            checks["editableRoundTrip"] = result["mode"] as? String == "paper" && result["editable"] as? Bool == true &&
                                kinds.contains("text") && kinds.contains("shape") && kinds.contains("image") &&
                                (result["atoms"] as? Int ?? 0) > 0 && (result["arrows"] as? Int ?? 0) > 0 && (result["lonePairs"] as? Int ?? 0) > 0
                            func captureCanvas() {
                                guard let screenshot = env["MOLSTUDIO_SELFTEST_CANVAS_PNG"] else { return finish() }
                                let config = WKSnapshotConfiguration()
                                self.web.takeSnapshot(with: config) { image, error in
                                    guard error == nil, let image, let tiff = image.tiffRepresentation,
                                          let bitmap = NSBitmapImageRep(data: tiff), let bytes = bitmap.representation(using: .png, properties: [:]) else {
                                        return finish("WK canvas screenshot failed")
                                    }
                                    do { try bytes.write(to: URL(fileURLWithPath: screenshot), options: .atomic); checks["canvasScreenshot"] = true; finish() }
                                    catch { finish("Cannot write WK canvas screenshot: \(error.localizedDescription)") }
                                }
                            }
                            guard let pagesPath = env["MOLSTUDIO_SELFTEST_PAGES_JSON"] else { return captureCanvas() }
                            self.jsValue("return JSON.stringify(await window.k3dAPI.document.exportPages())") { value, ok in
                                guard ok, let json = value as? String, let data = json.data(using: .utf8),
                                      let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                                      payload["ok"] as? Bool == true, let pages = payload["pages"] as? [[String: Any]], !pages.isEmpty else {
                                    return finish("Cannot export reopened canvas pages")
                                }
                                do { try data.write(to: URL(fileURLWithPath: pagesPath), options: .atomic); checks["canvasPagesJSON"] = true; captureCanvas() }
                                catch { finish("Cannot write canvas pages JSON: \(error.localizedDescription)") }
                            }
                        }
                        }
                    }
                }
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 70) { finish("Document self-test timed out") }
    }

    /// 机理层原生取证：真实 WKWebView 里画两根箭头 → 走原生保存链路写 .molwork →
    /// 走原生打开链路重新载入 → 比对数量与引用状态，结果写 JSON。
    /// 只证明「包内资源在 WKWebView 里可用 + 原生保存/打开链路完整」，不冒充鼠标操作验收。
    func runMechanismSelfTest() {
        let outPath = ProcessInfo.processInfo.environment["MOLSTUDIO_SELFTEST_OUT"]
            ?? NSTemporaryDirectory() + "molstudio-mech-selftest.json"
        let savePath = ProcessInfo.processInfo.environment["MOLSTUDIO_SELFTEST_SAVE"]
            ?? NSTemporaryDirectory() + "mech-selftest.molwork"
        var report: [String: Any] = ["outPath": outPath, "savePath": savePath]

        // 逐步 trace 到单独文件：定位原生链路停在哪一步
        let tracePath = outPath + ".trace"
        try? "".write(to: URL(fileURLWithPath: tracePath), atomically: true, encoding: .utf8)
        func trace(_ msg: String) {
            let line = "[\(Date().timeIntervalSince1970)] \(msg)\n"
            if let h = FileHandle(forWritingAtPath: tracePath) {
                h.seekToEndOfFile(); h.write(line.data(using: .utf8) ?? Data()); h.closeFile()
            } else {
                try? line.write(to: URL(fileURLWithPath: tracePath), atomically: true, encoding: .utf8)
            }
        }


        // 自检脚本：直接在模型层建两个箭头（鼠标命中由浏览器集成测试覆盖；
        // 这里要验证的是包内资源 + 原生保存/打开链路）
        let drawJS = """
        const app = window.MolWorkbench.app;
        const a = app.adapter, M = window.MolWorkbench.model;
        a.syncIdentity();
        const st = a.struct();
        const list = Array.from(st.atoms.entries()).map(([id, at]) => ({ id: id, label: at.label, x: at.pp.x, y: at.pp.y, uuid: a.uuidOfAtom(id) }));
        const o = list.find(x => x.label === 'O');
        const c = list.find(x => x.label === 'C');
        const br = list.find(x => x.label === 'Br');
        if (!o || !c || !br) return JSON.stringify({ ok: false, err: 'atoms', list: list });
        const lp = M.makeLonePair(o.uuid, { origin: 'manual', angle: 0 });
        const bondUuid = a.uuidOfBond(Array.from(st.bonds.keys())[0]);
        const before = app.model.cloneState();
        app.model.addLonePair(lp);
        app.model.addArrow(M.makeArrow({ type: 'lonePair', ownerAtomId: o.uuid, slotId: lp.id },
                                       { type: 'formingBond', atomA: o.uuid, atomB: c.uuid }, { bend: -0.22 }));
        if (bondUuid) {
          app.model.addArrow(M.makeArrow({ type: 'bond', bondId: bondUuid, component: 'sigma' },
                                         { type: 'atom', atomId: br.uuid }, { bend: -0.22 }));
        }
        const after = app.model.cloneState();
        app.model.setState(before, 'silent');
        app.controller.commitStatePair(before, after, 'selftest');
        await new Promise(r => setTimeout(r, 250));
        return JSON.stringify({ ok: true, counts: app.model.counts(), bondUuid: bondUuid });
        """

        DispatchQueue.main.asyncAfter(deadline: .now() + 10) {
            self.js("await window.k3dAPI.setMolecule('[OH-].CBr')")
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 13) {
            self.jsValueDetailed(drawJS) { v, ok, err in
                report["draw"] = (ok ? v as? String : nil) ?? "JS 失败"
                if !ok { report["drawError"] = err ?? "unknown" }
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 16) {
            // 走原生保存链路：先给定文件身份，再 saveSession（不弹面板）
            let url = URL(fileURLWithPath: savePath)
            try? FileManager.default.removeItem(at: url)
            self.canvasSession.fileURL = url
            self.canvasSession.initialized = true
            self.saveSession(.canvas, forceSaveAs: false) { saved in
                report["saved"] = saved
                let exists = FileManager.default.fileExists(atPath: savePath)
                report["fileExists"] = exists
                if let text = try? String(contentsOf: url, encoding: .utf8) {
                    report["fileBytes"] = text.count
                    report["formatOk"] = text.contains("\"format\":\"molstudio-workbench\"")
                    report["hasMechanism"] = text.contains("\"arrows\":[{\"id\"")
                }
                Self.writeSelfTestReport(report, to: outPath)
                trace("saved ok=\(saved) bytes=\(report["fileBytes"] ?? "")")
                DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
                    // 走原生打开链路重新载入（保存后会话是干净的，不会弹确认框）
                    trace("openDocument start")
                    self.openDocument(at: url)
                    trace("openDocument returned")
                }
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 70) { trace("hard timeout"); self.server?.terminate(); exit(0) }

        // 检查点：把会话状态写进报告，用于判断打开链路停在哪一步
        func checkpoint(_ label: String) {
            var marks = (report["marks"] as? [String: Any]) ?? [:]
            marks[label] = [
                "dirty": self.canvasSession.dirty,
                "hasSnapshot": self.canvasSession.hasSnapshot,
                "pageUsable": self.pageUsable,
                "navInFlight": self.navigationInFlight,
                "file": self.canvasSession.fileURL?.lastPathComponent ?? "",
                "activeMode": "canvas"
            ]
            report["marks"] = marks
            Self.writeSelfTestReport(report, to: outPath)
        }
        for (i, t) in [20.0, 24.0, 28.0, 32.0].enumerated() {
            DispatchQueue.main.asyncAfter(deadline: .now() + t) { checkpoint("t\(Int(t))_\(i)") }
        }

        DispatchQueue.main.asyncAfter(deadline: .now() + 36) {
            trace("collect start")
            let collect = """
            const app = window.MolWorkbench && window.MolWorkbench.app;
            if (!app || !app.ready) return JSON.stringify({ ready: false });
            const d = document.getElementById('k').contentDocument;
            return JSON.stringify({
              ready: !!(window.k3dAPI && window.k3dAPI.workbenchReady && window.k3dAPI.workbenchReady()),
              counts: app.model.counts(),
              bad: d.querySelectorAll('.mech-arrow[data-bad="1"]').length,
              rendered: d.querySelectorAll('.mech-arrow').length,
              arrows: app.model.state.arrows.map(x => ({ e: x.electronCount, s: x.source.type, t: x.target.type })),
              title: document.title
            });
            """
            self.jsValue(collect) { v, ok in
                trace("collect done ok=\(ok)")
                report["afterOpen"] = (ok ? v as? String : nil) ?? "JS 失败"
                report["title"] = self.window?.title ?? ""
                Self.writeSelfTestReport(report, to: outPath)
                self.server?.terminate()
                exit(0)
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 6) {
                trace("collect timeout")
                report["afterOpen"] = "超时：页面没有返回结果"
                checkpoint("timeout")
                self.server?.terminate()
                exit(0)
            }
        }
    }

    // MARK: 剪贴板原生取证（真实 ⌘C / ⌘V / ⌘Z）
    /// 合成 ⌘ 组合键 → NSApp.sendEvent → 主菜单快捷键 → actCopy/actPaste/actUndo。
    /// 与真人按键走同一条 AppKit 路径（WKWebView 自己收不到编辑类 keyDown，见实现说明）。
    func sendCommandKey(_ ch: String, _ keyCode: UInt16, shift: Bool = false) {
        guard let win = window else { return }
        let mods: NSEvent.ModifierFlags = shift ? [.command, .shift] : [.command]
        // 真实键盘按住 Shift 时 characters 是上档字符，charactersIgnoringModifiers 仍是基准字符；
        // 菜单匹配用后者，两个都给对才能命中 ⇧⌘Z 这类组合。
        let chars = shift ? ch.uppercased() : ch
        for type in [NSEvent.EventType.keyDown, NSEvent.EventType.keyUp] {
            guard let ev = NSEvent.keyEvent(with: type, location: .zero, modifierFlags: mods,
                                            timestamp: ProcessInfo.processInfo.systemUptime,
                                            windowNumber: win.windowNumber, context: nil,
                                            characters: chars, charactersIgnoringModifiers: ch,
                                            isARepeat: false, keyCode: keyCode) else { continue }
            if type == .keyDown, !win.isKeyWindow, let menu = NSApp.mainMenu, menu.performKeyEquivalent(with: ev) {
                continue
            }
            NSApp.sendEvent(ev)
        }
    }

    /// 覆盖：弯箭头单独复制 → 粘贴后坐标/曲率/电子数保留、只选中副本、一次撤销；
    ///       文本框里 ⌘C 不抢（原生复制文字）。
    func runClipboardSelfTest() {
        let outPath = ProcessInfo.processInfo.environment["MOLSTUDIO_SELFTEST_OUT"]
            ?? FileManager.default.currentDirectoryPath + "/clipboard-selftest.json"
        var report: [String: Any] = ["outPath": outPath]
        var geo: [String: Any] = [:]

        func save() { AppDelegate.writeSelfTestReport(report, to: outPath) }
        func finish(_ why: String) {
            report["finishedAt"] = why
            save()
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
                self.selfTestPreviousApp?.activate()
                self.server?.terminate()
                exit(0)
            }
        }
        func later(_ s: Double, _ block: @escaping () -> Void) {
            DispatchQueue.main.asyncAfter(deadline: .now() + s, execute: block)
        }
        func num(_ v: Any?) -> Double { (v as? NSNumber)?.doubleValue ?? Double.nan }

        let drawJS = """
        const app = window.MolWorkbench.app;
        const a = app.adapter, M = window.MolWorkbench.model;
        a.syncIdentity();
        const st = a.struct();
        const list = Array.from(st.atoms.entries()).map(([id, at]) => ({ id: id, label: at.label, x: at.pp.x, y: at.pp.y, uuid: a.uuidOfAtom(id) }));
        const o = list.find(x => x.label === 'O');
        const cs = list.filter(x => x.label === 'C');
        if (!o || !cs.length) return JSON.stringify({ ok: false, err: 'atoms', list: list });
        const c = cs[0];
        const lp = M.makeLonePair(o.uuid, { origin: 'manual', angle: 0 });
        app.model.addLonePair(lp);
        const bent = M.makeArrow({ type: 'lonePair', ownerAtomId: o.uuid, slotId: lp.id },
                                 { type: 'atom', atomId: c.uuid },
                                 { electronCount: 2, bend: -0.26, mode: 'manual', routeVersion: 0 });
        app.model.addArrow(bent);
        let bondUuid = null;
        for (const [id] of st.bonds) { bondUuid = a.uuidOfBond(id); break; }
        const fish = M.makeArrow({ type: 'bond', bondId: bondUuid, component: 'sigma' },
                                 { type: 'atom', atomId: c.uuid },
                                 { electronCount: 1, bend: 0.2, mode: 'manual', routeVersion: 0 });
        app.model.addArrow(fish);
        app.controller.selection.clear();
        app.controller.selection.add(bent.id);
        app.controller.emitSelection();
        app.controller.render();
        const g = M.arrowGeometry(bent, app.controller.ctx());
        return JSON.stringify({ ok: true, bent: bent.id, fish: fish.id, counts: app.model.counts(),
          sel: app.controller.selection.size,
          geo: { start: g.start, end: g.end, bend: g.bend } });
        """

        let collectJS = """
        const app = window.MolWorkbench.app;
        const st = app.model.cloneState();
        const last = st.arrows[st.arrows.length - 1];
        return JSON.stringify({ counts: app.model.counts(), selection: app.controller.selection.size,
          last: last ? { s: last.source, t: last.target, e: last.electronCount, bend: last.geometry.bend } : null });
        """

        // 1) 等页面就绪 → 建分子
        func waitReady(_ n: Int) {
            jsValue("return !!(window.k3dAPI && window.k3dAPI.workbenchReady && window.k3dAPI.workbenchReady())") { v, ok in
                if ok, (v as? Bool) == true {
                    report["ready"] = true
                    self.js("await window.k3dAPI.setMolecule('CC(=O)C')")
                    later(1.6) { draw() }
                } else if n < 80 {
                    later(0.5) { waitReady(n + 1) }
                } else {
                    report["ready"] = false
                    finish("page-not-ready")
                }
            }
        }

        // 2) 建两根箭头并只选中弯箭头
        // 页面偶尔会在首次 didFinish 之后再刷一次（模型被重置），这里核对「箭头在、且仍选中」再继续
        func draw(_ attempt: Int = 0) {
            jsValue(drawJS) { v, ok in
                let text = (ok ? v as? String : nil) ?? "{}"
                report["draw"] = text
                if let d = text.data(using: .utf8),
                   let obj = try? JSONSerialization.jsonObject(with: d) as? [String: Any] {
                    if let g = obj["geo"] as? [String: Any] { geo = g }
                    let sel = (obj["sel"] as? NSNumber)?.intValue ?? 0
                    let okDraw = (obj["ok"] as? Bool) == true
                    report["drawOk"] = okDraw
                    if (!okDraw || sel != 1) && attempt < 3 {
                        report["drawRetry"] = attempt + 1
                        later(1.0) { draw(attempt + 1) }
                        return
                    }
                }
                later(0.4) { copyStep() }
            }
        }

        // 3) 真实 ⌘C
        func copyStep() {
            self.window?.deminiaturize(nil)
            sendCommandKey("c", 8)
            later(0.8) {
                let pb = self.readMechanismClipboard() ?? ""
                let plainPb = NSPasteboard.general.string(forType: .string) ?? ""
                let pbTypes = (NSPasteboard.general.types ?? []).map { $0.rawValue }
                report["copyBytes"] = pb.count
                report["copyPlainBytes"] = plainPb.count
                report["copyTypes"] = pbTypes
                report["copyHasPayload"] = !pb.isEmpty
                // 机理复制只写原生自定义剪贴板类型 local.molstudio.mechanism，绝不能把 JSON 泄漏到 .string
                report["copyPlainLeaked"] = !plainPb.isEmpty
                report["copyTypesOnlyMechanism"] = !pb.isEmpty && plainPb.isEmpty && pbTypes == [Self.mechPasteboardType.rawValue]
                if let d = pb.data(using: .utf8),
                   let obj = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
                   let arrows = obj["arrows"] as? [[String: Any]],
                   let first = arrows.first,
                   let src = first["source"] as? [String: Any],
                   let tgt = first["target"] as? [String: Any] {
                    report["copyHasLast"] = (src["last"] != nil) && (tgt["last"] != nil)
                    report["copyBend"] = (first["geometry"] as? [String: Any])?["bend"]
                    report["copyElectrons"] = first["electronCount"]
                }
                // 复制本身不改文档
                self.jsValue(collectJS) { v2, _ in
                    report["afterCopy"] = (v2 as? String) ?? ""
                    // 页面路径：⌘C 被 WebKit 吃掉时走的是 keydown → copySelection → postMessage → NSPasteboard
                    self.writeMechanismClipboard("CLEARED")
                    self.js("return window.MolWorkbench.app.controller.copySelection()") { _ in
                        later(0.6) {
                            let viaPage = self.readMechanismClipboard() ?? ""
                            report["pagePathBytes"] = viaPage.count
                            report["pagePathWrote"] = viaPage.count > 100
                            later(0.2) { pasteStep() }
                        }
                    }
                }
            }
        }

        // 4) 真实 ⌘V（进入交互预览后点击落位，再验证坐标/选择/历史）
        func pasteStep() {
            sendCommandKey("v", 9)
            later(0.8) {
                let placeJS = """
                (() => {
                  const c = window.MolWorkbench && window.MolWorkbench.app && window.MolWorkbench.app.controller;
                  if (!c || !c.pastePreview) return JSON.stringify({ preview: false });
                  const a = c.pastePreview.anchor || { x: 0, y: 0 };
                  const placed = !!c.finishPastePreview({ x: a.x + 2.0, y: a.y + 1.5 });
                  return JSON.stringify({ preview: true, placed });
                })()
                """
                self.jsValue("return \(placeJS)") { placeVal, _ in
                    let placeText = (placeVal as? String) ?? "{}"
                    report["pastePlacement"] = placeText
                    later(0.8) {
                        self.jsValue(collectJS) { v, ok in
                            let text = (ok ? v as? String : nil) ?? "{}"
                            report["afterPaste"] = text
                            if let d = text.data(using: .utf8),
                               let obj = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
                               let last = obj["last"] as? [String: Any],
                               let s = last["s"] as? [String: Any],
                               let t = last["t"] as? [String: Any],
                               let counts = obj["counts"] as? [String: Any] {
                                let arrows = (counts["arrows"] as? NSNumber)?.intValue ?? -1
                                let start = geo["start"] as? [String: Any] ?? [:]
                                let end = geo["end"] as? [String: Any] ?? [:]
                                let dx1 = num(s["x"]) - num(start["x"]), dy1 = num(s["y"]) - num(start["y"])
                                let dx2 = num(t["x"]) - num(end["x"]), dy2 = num(t["y"]) - num(end["y"])
                                let chordP = hypot(num(t["x"]) - num(s["x"]), num(t["y"]) - num(s["y"]))
                                let chordO = hypot(num(end["x"]) - num(start["x"]), num(end["y"]) - num(start["y"]))
                                report["pasteArrows"] = arrows
                                report["pasteFreeEnds"] = (s["type"] as? String) == "free" && (t["type"] as? String) == "free"
                                report["pasteOffsetSame"] = abs(dx1 - dx2) < 1e-6 && abs(dy1 - dy2) < 1e-6 && hypot(dx1, dy1) > 0.5
                                report["pasteChordSame"] = abs(chordP - chordO) < 1e-6
                                report["pasteBend"] = last["bend"]
                                report["pasteElectrons"] = last["e"]
                                report["pasteSelection"] = obj["selection"]
                            }
                            later(0.2) { undoStep() }
                        }
                    }
                }
            }
        }

        // 5) 一次撤销：粘贴只产生一条历史，撤销一次就回到粘贴前
        func undoStep() {
            sendCommandKey("z", 6)
            later(1.0) {
                self.jsValue("return JSON.stringify(window.MolWorkbench.app.model.counts())") { v, _ in
                    let counts = (v as? String) ?? ""
                    report["afterUndo"] = counts
                    report["undoOnceOk"] = counts.contains("\"arrows\":2")
                    later(0.2) { textFieldStep() }
                }
            }
        }

        // 6) 文本框里 ⌘C：应走原生复制文字，而不是复制机理对象
        func textFieldStep() {
            let focusJS = """
            const d = document.getElementById('k').contentDocument;
            const old = d.getElementById('selftest-input'); if (old) old.remove();
            const inp = d.createElement('input'); inp.id = 'selftest-input'; inp.value = 'SELFTEST-TEXT';
            inp.style.cssText = 'position:fixed;left:24px;top:24px;width:220px;height:26px;z-index:99999';
            d.body.appendChild(inp);
            const frame = document.getElementById('k');
            if (document.activeElement !== frame) frame.focus();
            inp.focus(); inp.select();
            return JSON.stringify({ active: d.activeElement === inp });
            """
            // 窗口在屏幕外，取消最小化只是为了拿回 key window（NSText.copy: 走响应链需要）；
            // 还要把 WKWebView 设为 first responder，否则 copy: 落不到网页上（真人点击画布就会设上）。
            self.window?.deminiaturize(nil)
            self.window?.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            if let web = self.web { self.window?.makeFirstResponder(web) }
            report["keyWindow"] = self.window?.isKeyWindow ?? false
            report["firstResponder"] = String(describing: type(of: self.window?.firstResponder ?? NSResponder()))
            jsValue(focusJS) { v, _ in
                report["textFieldFocus"] = (v as? String) ?? ""
                let pb = NSPasteboard.general
                pb.clearContents()
                pb.setString("BEFORE-TEXT-COPY", forType: .string)
                self.sendCommandKey("c", 8)
                later(0.9) {
                    let mech = self.readMechanismClipboard()
                    let plain = NSPasteboard.general.string(forType: .string) ?? ""
                    report["textFieldMechPayload"] = mech != nil
                    report["textFieldCopiedText"] = plain
                    report["textFieldOk"] = (mech == nil) && plain == "SELFTEST-TEXT"
                    self.js("(() => { const d = document.getElementById('k').contentDocument; const i = d.getElementById('selftest-input'); if (i) i.remove(); return true; })()")
                    later(0.3) { finish("done") }
                }
            }
        }

        later(0.5) { waitReady(0) }
        later(45) { finish("hard-timeout") }
    }
}
#endif

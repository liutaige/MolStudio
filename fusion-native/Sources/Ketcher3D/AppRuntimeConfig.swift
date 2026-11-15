import AppKit
import Darwin
import Foundation
import Security

/// Resolves runtime identity, server port, storage directories, UserDefaults isolation, and logging path.
/// Formal default builds preserve `local.ketcher3d.native`, port `8462`, `Application Support/Ketcher3D`,
/// and `UserDefaults.standard`. Candidate and selftest builds isolate all state from the user's running MolStudio.
final class AppRuntimeConfig: @unchecked Sendable {
    static let shared = AppRuntimeConfig()

    private enum PlistKeys {
        static let isolationProfile = "MolStudioIsolationProfile"
        static let defaultPort = "MolStudioDefaultPort"
        static let dataFolderName = "MolStudioDataFolderName"
        static let defaultsSuiteName = "MolStudioDefaultsSuiteName"
    }

    private enum DefaultsKeys {
        static let isolatedRecentPaths = "MolStudioIsolatedRecentPaths"
    }

    static let formalBundleIdentifier = "local.ketcher3d.native"
    static let formalPort = 8462
    private static let reservedPorts: Set<Int> = [8462, 48975, 49180]

    let bundleIdentifier: String
    let isolationProfile: String?
    var isIsolated: Bool { isolationProfile != nil }
    let selftestIsolatedPort: Bool
    let allowMultipleInstances: Bool
    let port: Int
    let docsDirectoryURL: URL
    let agentConfigDirectoryURL: URL?
    let userDefaults: UserDefaults
    let defaultsSuiteName: String?
    let logFilePath: String
    let acceptanceControlFilePath: String?

    private init() {
        let env = ProcessInfo.processInfo.environment
        let info = Bundle.main.infoDictionary ?? [:]

        let resolvedBundleId = Bundle.main.bundleIdentifier
            ?? Self.nonEmpty(env["MOLSTUDIO_BUNDLE_IDENTIFIER"])
            ?? Self.formalBundleIdentifier
        self.bundleIdentifier = resolvedBundleId

        #if MOLSTUDIO_SELFTEST
        let isSelftestPort = Self.nonEmpty(env["MOLSTUDIO_SELFTEST_PORT"]) != nil
        let selftestProfile: String? = isSelftestPort ? "selftest" : nil
        #else
        let isSelftestPort = false
        let selftestProfile: String? = nil
        #endif
        self.selftestIsolatedPort = isSelftestPort

        let explicitProfile = Self.nonEmpty(env["MOLSTUDIO_ISOLATION_PROFILE"])
            ?? Self.nonEmpty(info[PlistKeys.isolationProfile] as? String)
        let bundleDerivedProfile: String? = (resolvedBundleId != Self.formalBundleIdentifier)
            ? resolvedBundleId.replacingOccurrences(of: Self.formalBundleIdentifier + ".", with: "")
            : nil
        let profileRaw = explicitProfile ?? bundleDerivedProfile ?? selftestProfile
        self.isolationProfile = profileRaw.map(Self.sanitizeProfileComponent)

        self.allowMultipleInstances = (env["MOLSTUDIO_ALLOW_MULTIPLE"] == "1")
            || isSelftestPort
            || (self.isolationProfile != nil && env["MOLSTUDIO_ENFORCE_SINGLE_INSTANCE"] != "1" && !Bundle.main.bundlePath.hasSuffix(".app"))

        self.port = Self.resolvePort(env: env, info: info, isIsolated: self.isolationProfile != nil, isSelftestPort: isSelftestPort)

        let fm = FileManager.default
        if isSelftestPort {
            let path = Self.nonEmpty(env["MOLSTUDIO_SELFTEST_DOCS_DIR"])
                ?? (NSTemporaryDirectory() + "molstudio-selftest-documents-\(self.port)")
            self.docsDirectoryURL = URL(fileURLWithPath: path, isDirectory: true)
        } else if let envDataDir = Self.nonEmpty(env["MOLSTUDIO_DATA_DIR"]) {
            self.docsDirectoryURL = URL(fileURLWithPath: envDataDir, isDirectory: true)
        } else {
            let appSupport = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
                ?? URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
            let folderName = Self.nonEmpty(env["MOLSTUDIO_DATA_DIR_NAME"])
                ?? Self.nonEmpty(info[PlistKeys.dataFolderName] as? String)
                ?? (self.isolationProfile.map { "MolStudio-\($0)" } ?? "Ketcher3D")
            self.docsDirectoryURL = appSupport.appendingPathComponent(folderName, isDirectory: true)
        }

        if let envAgentDir = Self.nonEmpty(env["MOLSTUDIO_AGENT_CONFIG_DIR"]) {
            self.agentConfigDirectoryURL = URL(fileURLWithPath: envAgentDir, isDirectory: true)
        } else if self.isolationProfile != nil {
            self.agentConfigDirectoryURL = self.docsDirectoryURL.appendingPathComponent("agent-config", isDirectory: true)
        } else {
            self.agentConfigDirectoryURL = nil
        }

        let resolvedSuite = Self.nonEmpty(env["MOLSTUDIO_DEFAULTS_SUITE"])
            ?? Self.nonEmpty(info[PlistKeys.defaultsSuiteName] as? String)
            ?? (self.isolationProfile.map { "\(resolvedBundleId).\($0).prefs" })
        self.defaultsSuiteName = resolvedSuite
        if let resolvedSuite, let suiteDefaults = UserDefaults(suiteName: resolvedSuite) {
            self.userDefaults = suiteDefaults
        } else {
            self.userDefaults = .standard
        }

        if let envLog = Self.nonEmpty(env["MOLSTUDIO_LOG_FILE"]) {
            self.logFilePath = envLog
        } else if self.isolationProfile != nil {
            self.logFilePath = self.docsDirectoryURL.appendingPathComponent("molstudio.log").path
        } else {
            self.logFilePath = "/tmp/k3d.log"
        }

        self.acceptanceControlFilePath = Self.nonEmpty(env["MOLSTUDIO_ACCEPTANCE_CONTROL_FILE"])
    }

    func prepareDirectories() {
        let fm = FileManager.default
        try? fm.createDirectory(at: docsDirectoryURL, withIntermediateDirectories: true)
        if let agentConfigDirectoryURL {
            try? fm.createDirectory(at: agentConfigDirectoryURL, withIntermediateDirectories: true)
        }
    }

    func recentURLs() -> [URL] {
        guard isIsolated else {
            return NSDocumentController.shared.recentDocumentURLs
        }
        let paths = userDefaults.stringArray(forKey: DefaultsKeys.isolatedRecentPaths) ?? []
        return paths.map { URL(fileURLWithPath: $0) }
    }

    func noteRecentURL(_ url: URL) {
        let canonical = URL(fileURLWithPath: WelcomeRecents.canonicalPath(for: url))
        guard isIsolated else {
            NSDocumentController.shared.noteNewRecentDocumentURL(canonical)
            return
        }
        var paths = userDefaults.stringArray(forKey: DefaultsKeys.isolatedRecentPaths) ?? []
        paths.removeAll { $0 == canonical.path }
        paths.insert(canonical.path, at: 0)
        if paths.count > 40 {
            paths = Array(paths.prefix(40))
        }
        userDefaults.set(paths, forKey: DefaultsKeys.isolatedRecentPaths)
    }

    func removeIsolatedRecentURL(_ url: URL) {
        guard isIsolated else { return }
        let canonical = WelcomeRecents.canonicalPath(for: url)
        var paths = userDefaults.stringArray(forKey: DefaultsKeys.isolatedRecentPaths) ?? []
        paths.removeAll { $0 == canonical || $0 == url.path }
        userDefaults.set(paths, forKey: DefaultsKeys.isolatedRecentPaths)
    }

    private static func resolvePort(
        env: [String: String],
        info: [String: Any],
        isIsolated: Bool,
        isSelftestPort: Bool
    ) -> Int {
        if isSelftestPort,
           let raw = env["MOLSTUDIO_SELFTEST_PORT"],
           let parsed = Int(raw),
           (1024...65535).contains(parsed) {
            return parsed
        }
        if let raw = env["MOLSTUDIO_PORT"],
           let parsed = Int(raw),
           (1024...65535).contains(parsed) {
            if !isIsolated || !reservedPorts.contains(parsed) {
                return parsed
            }
        }
        if let plistPort = (info[PlistKeys.defaultPort] as? NSNumber)?.intValue,
           (1024...65535).contains(plistPort) {
            if !isIsolated || !reservedPorts.contains(plistPort) {
                return plistPort
            }
        }
        if isIsolated {
            return allocateEphemeralLoopbackPort() ?? 18462
        }
        return formalPort
    }

    private static func allocateEphemeralLoopbackPort() -> Int? {
        for _ in 0..<16 {
            let fd = Darwin.socket(AF_INET, SOCK_STREAM, 0)
            guard fd >= 0 else { continue }
            var closed = false
            defer {
                if !closed { Darwin.close(fd) }
            }

            var addr = sockaddr_in()
            addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
            addr.sin_family = sa_family_t(AF_INET)
            addr.sin_port = in_port_t(0)
            addr.sin_addr = in_addr(s_addr: inet_addr("127.0.0.1"))

            let bound = withUnsafePointer(to: &addr) {
                $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                    Darwin.bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
                }
            }
            guard bound == 0 else { continue }

            var outAddr = sockaddr_in()
            var len = socklen_t(MemoryLayout<sockaddr_in>.size)
            let got = withUnsafeMutablePointer(to: &outAddr) {
                $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                    Darwin.getsockname(fd, $0, &len)
                }
            }
            Darwin.close(fd)
            closed = true
            guard got == 0 else { continue }

            let chosen = Int(UInt16(bigEndian: outAddr.sin_port))
            if (1024...65535).contains(chosen) && !reservedPorts.contains(chosen) {
                return chosen
            }
        }
        return nil
    }

    private static func nonEmpty(_ value: String?) -> String? {
        guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else {
            return nil
        }
        return trimmed
    }

    private static func sanitizeProfileComponent(_ raw: String) -> String {
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_."))
        let scalars = raw.unicodeScalars.map { allowed.contains($0) ? Character($0) : "-" }
        let collapsed = String(scalars).trimmingCharacters(in: CharacterSet(charactersIn: "-_."))
        return collapsed.isEmpty ? "isolated" : collapsed
    }
}

/// Strictly read-only, token-authenticated loopback inspection endpoint enabled ONLY when
/// `MOLSTUDIO_ACCEPTANCE_CONTROL_FILE` is set by an isolated acceptance run.
/// Never opens a second DOM panel, never stores/returns secrets, and rejects non-GET requests.
final class AcceptanceTelemetryServer {
    private let controlFilePath: String
    private let token: String
    private let runtimeConfig: AppRuntimeConfig
    private let stateProvider: @MainActor () -> [String: Any]
    private let queue = DispatchQueue(label: "local.molstudio.acceptance-telemetry", qos: .utility)

    private var listenFD: Int32 = -1
    private var running = false
    private(set) var port: Int = 0

    init(
        controlFilePath: String,
        runtimeConfig: AppRuntimeConfig = .shared,
        stateProvider: @escaping @MainActor () -> [String: Any]
    ) {
        self.controlFilePath = controlFilePath
        self.token = Self.generateHexToken()
        self.runtimeConfig = runtimeConfig
        self.stateProvider = stateProvider
    }

    deinit {
        stop()
    }

    @discardableResult
    func start() -> Bool {
        guard !running else { return true }

        let fd = Darwin.socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else { return false }

        var yes: Int32 = 1
        Darwin.setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &yes, socklen_t(MemoryLayout<Int32>.size))

        var addr = sockaddr_in()
        addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = in_port_t(0)
        addr.sin_addr = in_addr(s_addr: inet_addr("127.0.0.1"))

        let bindResult = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        guard bindResult == 0, Darwin.listen(fd, 16) == 0 else {
            Darwin.close(fd)
            return false
        }

        var outAddr = sockaddr_in()
        var len = socklen_t(MemoryLayout<sockaddr_in>.size)
        let got = withUnsafeMutablePointer(to: &outAddr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.getsockname(fd, $0, &len)
            }
        }
        guard got == 0 else {
            Darwin.close(fd)
            return false
        }

        self.port = Int(UInt16(bigEndian: outAddr.sin_port))
        self.listenFD = fd
        self.running = true

        writeControlFile()

        queue.async { [weak self] in
            self?.acceptLoop()
        }
        return true
    }

    func stop() {
        running = false
        if listenFD >= 0 {
            Darwin.shutdown(listenFD, SHUT_RDWR)
            Darwin.close(listenFD)
            listenFD = -1
        }
        try? FileManager.default.removeItem(atPath: controlFilePath)
    }

    private func writeControlFile() {
        let targetURL = URL(fileURLWithPath: controlFilePath)
        try? FileManager.default.createDirectory(at: targetURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        var payload: [String: Any] = [
            "pid": ProcessInfo.processInfo.processIdentifier,
            "port": port,
            "token": token,
            "serverPort": runtimeConfig.port,
            "bundleId": runtimeConfig.bundleIdentifier,
            "docsDir": runtimeConfig.docsDirectoryURL.path,
            "logFile": runtimeConfig.logFilePath,
            "readOnly": true,
        ]
        if let profile = runtimeConfig.isolationProfile {
            payload["isolationProfile"] = profile
        }
        if let agentDir = runtimeConfig.agentConfigDirectoryURL?.path {
            payload["agentConfigDir"] = agentDir
        }
        if let suite = runtimeConfig.defaultsSuiteName {
            payload["defaultsSuite"] = suite
        }
        guard let data = try? JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted, .sortedKeys]) else {
            return
        }
        try? data.write(to: targetURL, options: .atomic)
        Darwin.chmod(controlFilePath, 0o600)
    }

    private func acceptLoop() {
        while running && listenFD >= 0 {
            var clientAddr = sockaddr_in()
            var clientLen = socklen_t(MemoryLayout<sockaddr_in>.size)
            let clientFD = withUnsafeMutablePointer(to: &clientAddr) {
                $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                    Darwin.accept(listenFD, $0, &clientLen)
                }
            }
            if clientFD < 0 {
                if errno == EINTR { continue }
                break
            }
            handleClient(clientFD)
        }
    }

    private func handleClient(_ clientFD: Int32) {
        defer { Darwin.close(clientFD) }

        var tv = timeval(tv_sec: 2, tv_usec: 0)
        Darwin.setsockopt(clientFD, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))

        var buffer = [UInt8](repeating: 0, count: 8192)
        let n = Darwin.recv(clientFD, &buffer, buffer.count, 0)
        guard n > 0 else { return }

        let requestText = String(decoding: buffer[0..<n], as: UTF8.self)
        let lines = requestText.components(separatedBy: "\r\n")
        guard let requestLine = lines.first else {
            sendJSON(clientFD, status: "400 Bad Request", body: ["ok": false, "error": "bad_request"])
            return
        }
        let parts = requestLine.split(separator: " ")
        guard parts.count >= 2 else {
            sendJSON(clientFD, status: "400 Bad Request", body: ["ok": false, "error": "bad_request"])
            return
        }
        let method = String(parts[0]).uppercased()
        let rawPath = String(parts[1])
        let path = rawPath.split(separator: "?", maxSplits: 1).first.map(String.init) ?? rawPath

        var authHeader = ""
        for line in lines.dropFirst() {
            if line.isEmpty { break }
            if let colon = line.firstIndex(of: ":") {
                let key = line[..<colon].trimmingCharacters(in: .whitespaces).lowercased()
                if key == "authorization" {
                    authHeader = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
                    break
                }
            }
        }

        guard authHeader == "Bearer \(token)" else {
            sendJSON(clientFD, status: "401 Unauthorized", body: ["ok": false, "error": "unauthorized"])
            return
        }
        guard method == "GET" else {
            sendJSON(clientFD, status: "405 Method Not Allowed", body: ["ok": false, "error": "read_only_get_only"])
            return
        }

        switch path {
        case "/health":
            sendJSON(clientFD, status: "200 OK", body: [
                "ok": true,
                "pid": ProcessInfo.processInfo.processIdentifier,
                "serverPort": runtimeConfig.port,
            ])

        case "/state":
            let snapshot: [String: Any]
            if Thread.isMainThread {
                snapshot = MainActor.assumeIsolated { stateProvider() }
            } else {
                var captured: [String: Any] = ["ok": false, "error": "main_thread_timeout"]
                let sem = DispatchSemaphore(value: 0)
                DispatchQueue.main.async { [stateProvider] in
                    captured = MainActor.assumeIsolated { stateProvider() }
                    sem.signal()
                }
                _ = sem.wait(timeout: .now() + 2.0)
                snapshot = captured
            }
            sendJSON(clientFD, status: "200 OK", body: snapshot)

        default:
            sendJSON(clientFD, status: "404 Not Found", body: ["ok": false, "error": "not_found"])
        }
    }

    private func sendJSON(_ clientFD: Int32, status: String, body: [String: Any]) {
        let jsonData = (try? JSONSerialization.data(withJSONObject: body, options: [.sortedKeys])) ?? Data("{}".utf8)
        let header = "HTTP/1.1 \(status)\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: \(jsonData.count)\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n"
        var response = Data(header.utf8)
        response.append(jsonData)
        response.withUnsafeBytes { rawBuf in
            guard let base = rawBuf.baseAddress else { return }
            var sent = 0
            while sent < rawBuf.count {
                let wrote = Darwin.send(clientFD, base.advanced(by: sent), rawBuf.count - sent, 0)
                if wrote <= 0 { break }
                sent += wrote
            }
        }
    }

    private static func generateHexToken() -> String {
        var bytes = [UInt8](repeating: 0, count: 24)
        let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        if status == errSecSuccess {
            return bytes.map { String(format: "%02x", $0) }.joined()
        }
        return UUID().uuidString.replacingOccurrences(of: "-", with: "")
            + UUID().uuidString.replacingOccurrences(of: "-", with: "")
    }
}

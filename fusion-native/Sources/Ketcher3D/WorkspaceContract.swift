import Foundation
import WebKit

// MARK: - Protocol Constants & Surface Identifiers

/// Protocol version frozen by MolStudio native UI contract v1.
let workspaceNativeUIProtocolVersion = 1

/// The five fixed native UI migration surfaces defined by contract v1.
/// Surfaces are only treated as natively owned after `attach` succeeds and lists them in `ownedSurfaces`.
enum WorkspaceSurface: String, Codable, CaseIterable, Hashable, Sendable {
    case fileCommands
    case toolPalette
    case zoomPalette
    case inspector
    case agent
}

/// Identifies a specific top-level JS page instance and Swift navigation transaction.
struct WorkspaceEpoch: Codable, Equatable, Hashable, Sendable {
    let navigationGeneration: Int
    let pageId: String
}

/// Identifies who currently owns keyboard/edit focus in the main window.
enum WorkspaceFocusOwner: String, Codable, Equatable, Sendable {
    case canvas
    case nativeText
    case nativeChrome
    case none
}

// MARK: - Host Viewport Geometry (Top-Level WebView CSS px)

struct WorkspaceCSSSize: Codable, Equatable, Sendable {
    var width: Double
    var height: Double

    static let zero = WorkspaceCSSSize(width: 0, height: 0)
}

struct WorkspaceEdgeInsets: Codable, Equatable, Sendable {
    var top: Double
    var right: Double
    var bottom: Double
    var left: Double

    static let zero = WorkspaceEdgeInsets(top: 0, right: 0, bottom: 0, left: 0)
}

enum WorkspaceOverlayID: String, Codable, Equatable, Sendable {
    case toolPalette
    case zoomPalette
    case chemicalPalette
}

/// Native overlay occlusion rectangle expressed in top-level WebView CSS client pixels
/// (top-left origin, +y downward). Never screen coordinates, NSWindow coordinates, or backing pixels.
struct WorkspaceOverlayRect: Codable, Equatable, Sendable {
    let id: WorkspaceOverlayID
    let x: Double
    let y: Double
    let width: Double
    let height: Double
}

struct WorkspaceHostViewport: Codable, Equatable, Sendable {
    let layoutRevision: Int
    let cssSize: WorkspaceCSSSize
    let safeAreaInsets: WorkspaceEdgeInsets
    let overlays: [WorkspaceOverlayRect]
}

struct WorkspaceHostContext: Codable, Equatable, Sendable {
    var windowKey: Bool
    var focusOwner: WorkspaceFocusOwner
    var inspectorVisible: Bool
    var viewport: WorkspaceHostViewport?

    static let initial = WorkspaceHostContext(
        windowKey: false,
        focusOwner: .none,
        inspectorVisible: true,
        viewport: nil
    )
}

// MARK: - Attach Handshake

struct WorkspaceAttachOptions: Codable, Equatable, Sendable {
    let `protocol`: Int
    let navigationGeneration: Int
    let nativeSurfaces: [WorkspaceSurface]
    let host: WorkspaceHostContext

    init(
        protocolVersion: Int = workspaceNativeUIProtocolVersion,
        navigationGeneration: Int,
        nativeSurfaces: [WorkspaceSurface],
        host: WorkspaceHostContext
    ) {
        self.protocol = protocolVersion
        self.navigationGeneration = navigationGeneration
        self.nativeSurfaces = nativeSurfaces
        self.host = host
    }
}

struct WorkspaceAttachReply: Codable, Equatable, Sendable {
    let ok: Bool
    let epoch: WorkspaceEpoch?
    let sequence: Int?
    let ownedSurfaces: [WorkspaceSurface]
    let state: WorkspaceUIState?
    let error: WorkspaceCommandError?

    init(
        ok: Bool,
        epoch: WorkspaceEpoch? = nil,
        sequence: Int? = nil,
        ownedSurfaces: [WorkspaceSurface] = [],
        state: WorkspaceUIState? = nil,
        error: WorkspaceCommandError? = nil
    ) {
        self.ok = ok
        self.epoch = epoch
        self.sequence = sequence
        self.ownedSurfaces = ownedSurfaces
        self.state = state
        self.error = error
    }
}

// MARK: - Unified UIState Snapshot

enum WorkspaceSelectionKind: String, Codable, Equatable, Sendable {
    case none
    case molecule
    case electronFlow
    case lonePair
    case document
    case mixed
}

enum WorkspaceViewportMode: String, Codable, Equatable, Sendable {
    case canvas
    case paper
}

struct WorkspaceSelectionProperty: Codable, Equatable, Identifiable, Sendable {
    enum PropertyType: String, Codable, Equatable, Sendable {
        case number
        case choice
        case text
    }

    enum PropertyValue: Equatable, Sendable, Codable {
        case number(Double)
        case string(String)

        init(from decoder: Decoder) throws {
            let container = try decoder.singleValueContainer()
            if let num = try? container.decode(Double.self) {
                self = .number(num)
                return
            }
            if let str = try? container.decode(String.self) {
                self = .string(str)
                return
            }
            if let boolVal = try? container.decode(Bool.self) {
                self = .string(boolVal ? "true" : "false")
                return
            }
            throw DecodingError.typeMismatch(
                PropertyValue.self,
                DecodingError.Context(codingPath: decoder.codingPath, debugDescription: "Expected number or string property value")
            )
        }

        func encode(to encoder: Encoder) throws {
            var container = encoder.singleValueContainer()
            switch self {
            case .number(let val): try container.encode(val)
            case .string(let val): try container.encode(val)
            }
        }

        var numberValue: Double? {
            switch self {
            case .number(let n): return n
            case .string(let s): return Double(s)
            }
        }

        var stringValue: String {
            switch self {
            case .number(let n): return String(n)
            case .string(let s): return s
            }
        }
    }

    struct Choice: Codable, Equatable, Sendable {
        let value: String
        let label: String
    }

    let id: String
    let label: String
    let type: PropertyType
    let value: PropertyValue?
    let enabled: Bool
    let min: Double?
    let max: Double?
    let step: Double?
    let choices: [Choice]?

    init(
        id: String,
        label: String,
        type: PropertyType,
        value: PropertyValue? = nil,
        enabled: Bool = true,
        min: Double? = nil,
        max: Double? = nil,
        step: Double? = nil,
        choices: [Choice]? = nil
    ) {
        self.id = id
        self.label = label
        self.type = type
        self.value = value
        self.enabled = enabled
        self.min = min
        self.max = max
        self.step = step
        self.choices = choices
    }
}

struct WorkspaceUIState: Codable, Equatable, Sendable {
    struct Ready: Codable, Equatable, Sendable {
        var canvas: Bool
        var agent: Bool

        static let notReady = Ready(canvas: false, agent: false)
    }

    struct Supported: Codable, Equatable, Sendable {
        var commands: [String]
        var toolIds: [String]
        var elementSymbols: [String]
        var templateIds: [String]

        static let empty = Supported(commands: [], toolIds: [], elementSymbols: [], templateIds: [])
    }

    struct Tool: Codable, Equatable, Sendable {
        var id: String?
        var label: String

        static let none = Tool(id: nil, label: "")
    }

    struct Selection: Codable, Equatable, Sendable {
        var revision: Int
        var kind: WorkspaceSelectionKind
        var count: Int
        var label: String
        var properties: [WorkspaceSelectionProperty]

        static let empty = Selection(revision: 0, kind: .none, count: 0, label: "画布", properties: [])
    }

    struct History: Codable, Equatable, Sendable {
        var canUndo: Bool
        var canRedo: Bool

        static let disabled = History(canUndo: false, canRedo: false)
    }

    struct Viewport: Codable, Equatable, Sendable {
        var mode: WorkspaceViewportMode
        var percent: Double?
        var cssSize: WorkspaceCSSSize
        var appliedHostLayoutRevision: Int

        static let initial = Viewport(mode: .canvas, percent: nil, cssSize: .zero, appliedHostLayoutRevision: 0)
    }

    struct AgentSummary: Codable, Equatable, Sendable {
        var running: Bool
        var pendingStart: Bool
        var canContinue: Bool
        var settingsBusy: Bool

        static let idle = AgentSummary(running: false, pendingStart: false, canContinue: false, settingsBusy: false)
    }

    struct DocumentInfo: Codable, Equatable, Sendable {
        var mode: WorkspaceViewportMode?
        var pageCount: Int?
        var size: String?
        var orientation: String?
        var marginMm: Double?
        var canRemoveLastPage: Bool?
    }

    let `protocol`: Int
    let epoch: WorkspaceEpoch
    let revision: Int
    let ready: Ready
    let supported: Supported
    let tool: Tool
    let selection: Selection
    let history: History
    let viewport: Viewport
    let agent: AgentSummary
    var document: DocumentInfo?

    init(
        protocol: Int,
        epoch: WorkspaceEpoch,
        revision: Int,
        ready: Ready,
        supported: Supported,
        tool: Tool,
        selection: Selection,
        history: History,
        viewport: Viewport,
        agent: AgentSummary,
        document: DocumentInfo? = nil
    ) {
        self.protocol = `protocol`
        self.epoch = epoch
        self.revision = revision
        self.ready = ready
        self.supported = supported
        self.tool = tool
        self.selection = selection
        self.history = history
        self.viewport = viewport
        self.agent = agent
        self.document = document
    }

    static func disabledInitial(epoch: WorkspaceEpoch = WorkspaceEpoch(navigationGeneration: 0, pageId: "")) -> WorkspaceUIState {
        WorkspaceUIState(
            protocol: workspaceNativeUIProtocolVersion,
            epoch: epoch,
            revision: 0,
            ready: .notReady,
            supported: .empty,
            tool: .none,
            selection: .empty,
            history: .disabled,
            viewport: .initial,
            agent: .idle,
            document: nil
        )
    }
}

// MARK: - Generic JSON Value for Commands & Sanitized Diagnostics

enum WorkspaceJSONValue: Equatable, Sendable, Codable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case null
    case array([WorkspaceJSONValue])
    case object([String: WorkspaceJSONValue])

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let b = try? container.decode(Bool.self) {
            self = .bool(b)
        } else if let n = try? container.decode(Double.self) {
            self = .number(n)
        } else if let s = try? container.decode(String.self) {
            self = .string(s)
        } else if let arr = try? container.decode([WorkspaceJSONValue].self) {
            self = .array(arr)
        } else if let obj = try? container.decode([String: WorkspaceJSONValue].self) {
            self = .object(obj)
        } else {
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Unsupported JSON value")
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let v): try container.encode(v)
        case .number(let v): try container.encode(v)
        case .bool(let v): try container.encode(v)
        case .null: try container.encodeNil()
        case .array(let v): try container.encode(v)
        case .object(let v): try container.encode(v)
        }
    }

    var foundationValue: Any {
        switch self {
        case .string(let v): return v
        case .number(let v): return v
        case .bool(let v): return v
        case .null: return NSNull()
        case .array(let v): return v.map(\.foundationValue)
        case .object(let v): return v.mapValues(\.foundationValue)
        }
    }

    static func from(foundation value: Any?) -> WorkspaceJSONValue? {
        guard let value else { return nil }
        if value is NSNull { return .null }
        if let s = value as? String { return .string(s) }
        if let n = value as? NSNumber {
            if CFGetTypeID(n) == CFBooleanGetTypeID() {
                return .bool(n.boolValue)
            }
            return .number(n.doubleValue)
        }
        if let b = value as? Bool { return .bool(b) }
        if let arr = value as? [Any] {
            return .array(arr.compactMap { from(foundation: $0) })
        }
        if let dict = value as? [String: Any] {
            var out: [String: WorkspaceJSONValue] = [:]
            for (k, v) in dict {
                if let converted = from(foundation: v) {
                    out[k] = converted
                }
            }
            return .object(out)
        }
        return nil
    }
}

typealias WorkspaceJSONObject = [String: WorkspaceJSONValue]

// MARK: - Command Envelope

struct WorkspaceCommand: Codable, Equatable, Sendable {
    let `protocol`: Int
    let epoch: WorkspaceEpoch
    let requestId: String
    let id: String
    let args: WorkspaceJSONObject?
    let expectedSelectionRevision: Int?

    init(
        protocolVersion: Int = workspaceNativeUIProtocolVersion,
        epoch: WorkspaceEpoch,
        requestId: String = UUID().uuidString,
        id: String,
        args: WorkspaceJSONObject? = nil,
        expectedSelectionRevision: Int? = nil
    ) {
        self.protocol = protocolVersion
        self.epoch = epoch
        self.requestId = requestId
        self.id = id
        self.args = args
        self.expectedSelectionRevision = expectedSelectionRevision
    }
}

struct WorkspaceCommandError: Codable, Equatable, Sendable {
    let code: String
    let message: String
}

struct WorkspaceCommandReply: Codable, Equatable, Sendable {
    let `protocol`: Int
    let epoch: WorkspaceEpoch?
    let requestId: String
    let ok: Bool
    let error: WorkspaceCommandError?
    let result: WorkspaceJSONObject?
    let stateRevision: Int?

    init(
        protocolVersion: Int = workspaceNativeUIProtocolVersion,
        epoch: WorkspaceEpoch? = nil,
        requestId: String,
        ok: Bool,
        error: WorkspaceCommandError? = nil,
        result: WorkspaceJSONObject? = nil,
        stateRevision: Int? = nil
    ) {
        self.protocol = protocolVersion
        self.epoch = epoch
        self.requestId = requestId
        self.ok = ok
        self.error = error
        self.result = result
        self.stateRevision = stateRevision
    }
}

// MARK: - Public Agent Presentation & Events (No Second Runtime, No Secret Storage)

struct WorkspaceGenerationConfig: Codable, Equatable, Sendable {
    var profile: String
    var effort: String
    var maxOutputTokens: Int?

    init(profile: String = "provider-default", effort: String = "default", maxOutputTokens: Int? = nil) {
        self.profile = ["provider-default", "deepseek", "openai"].contains(profile) ? profile : "provider-default"
        self.effort = ["default", "none", "low", "medium", "high", "xhigh", "max"].contains(effort) ? effort : "default"
        if let maxOutputTokens, maxOutputTokens > 0 {
            self.maxOutputTokens = maxOutputTokens
        } else {
            self.maxOutputTokens = nil
        }
    }
}

struct WorkspaceGenerationCapabilities: Codable, Equatable, Sendable {
    var openaiModels: [String: [String]]

    init(openaiModels: [String: [String]] = [:]) {
        var sanitized: [String: [String]] = [:]
        let allowed = Set(["none", "low", "medium", "high", "xhigh", "max"])
        for (model, efforts) in openaiModels {
            sanitized[model] = efforts.filter { allowed.contains($0) }
        }
        self.openaiModels = sanitized
    }
}

/// Public agent configuration exposed across the native bridge.
/// Intentionally omits `sessionToken` and `apiKey`; those never cross into or persist in Swift UI state.
struct WorkspacePublicConfig: Codable, Equatable, Sendable {
    var configured: Bool
    var provider: String
    var baseUrl: String
    var model: String
    var generation: WorkspaceGenerationConfig
    var generationCapabilities: WorkspaceGenerationCapabilities?
    var notice: String?

    enum CodingKeys: String, CodingKey {
        case configured, provider, baseUrl, model, generation, generationCapabilities, notice
    }

    init(
        configured: Bool = false,
        provider: String = "openai-compatible",
        baseUrl: String = "",
        model: String = "",
        generation: WorkspaceGenerationConfig = WorkspaceGenerationConfig(),
        generationCapabilities: WorkspaceGenerationCapabilities? = nil,
        notice: String? = nil
    ) {
        self.configured = configured
        self.provider = provider
        self.baseUrl = baseUrl
        self.model = model
        self.generation = generation
        self.generationCapabilities = generationCapabilities
        self.notice = notice
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.configured = try c.decodeIfPresent(Bool.self, forKey: .configured) ?? false
        self.provider = try c.decodeIfPresent(String.self, forKey: .provider) ?? "openai-compatible"
        self.baseUrl = try c.decodeIfPresent(String.self, forKey: .baseUrl) ?? ""
        self.model = try c.decodeIfPresent(String.self, forKey: .model) ?? ""
        self.generation = try c.decodeIfPresent(WorkspaceGenerationConfig.self, forKey: .generation) ?? WorkspaceGenerationConfig()
        self.generationCapabilities = try c.decodeIfPresent(WorkspaceGenerationCapabilities.self, forKey: .generationCapabilities)
        self.notice = try c.decodeIfPresent(String.self, forKey: .notice)
    }
}

/// Transient payload for `agent.settings.save`. API key is never logged or persisted in Swift state.
struct WorkspaceSettingsSaveRequest: Equatable, Sendable, CustomStringConvertible, CustomDebugStringConvertible {
    let provider: String
    let baseUrl: String
    let model: String
    let apiKey: String?
    let generation: WorkspaceGenerationConfig

    var description: String {
        "WorkspaceSettingsSaveRequest(provider: \(provider), baseUrl: \(baseUrl), model: \(model), apiKey: \(apiKey == nil ? "omitted" : "[REDACTED]"))"
    }

    var debugDescription: String { description }

    func toCommandArgs() -> WorkspaceJSONObject {
        var gen: WorkspaceJSONObject = [
            "profile": .string(generation.profile),
            "effort": .string(generation.effort),
        ]
        if let maxTokens = generation.maxOutputTokens {
            gen["maxOutputTokens"] = .number(Double(maxTokens))
        } else {
            gen["maxOutputTokens"] = .null
        }
        var args: WorkspaceJSONObject = [
            "provider": .string(provider),
            "baseUrl": .string(baseUrl),
            "model": .string(model),
            "generation": .object(gen),
        ]
        if let apiKey, !apiKey.isEmpty {
            args["apiKey"] = .string(apiKey)
        }
        return args
    }
}

struct WorkspacePublicMessage: Codable, Equatable, Identifiable, Sendable {
    enum Role: String, Codable, Equatable, Sendable {
        case user
        case assistant
        case system
    }

    let id: String
    let runId: String?
    let role: Role
    var text: String
    var renderedHtml: String?
    var createdAt: Double?

    var stableKey: String {
        if let runId, !runId.isEmpty { return "\(runId):\(id)" }
        return id
    }

    init(
        id: String,
        runId: String? = nil,
        role: Role,
        text: String,
        renderedHtml: String? = nil,
        createdAt: Double? = nil
    ) {
        self.id = id
        self.runId = runId
        self.role = role
        self.text = text
        self.renderedHtml = renderedHtml
        self.createdAt = createdAt
    }

    enum CodingKeys: String, CodingKey {
        case id
        case messageId
        case runId
        case role
        case text
        case renderedHtml
        case createdAt
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let decodedId = try container.decodeIfPresent(String.self, forKey: .id)
            ?? container.decodeIfPresent(String.self, forKey: .messageId)
        guard let decodedId, !decodedId.isEmpty else {
            throw DecodingError.keyNotFound(
                CodingKeys.id,
                DecodingError.Context(codingPath: decoder.codingPath, debugDescription: "Missing message id/messageId")
            )
        }
        self.id = decodedId
        self.runId = try container.decodeIfPresent(String.self, forKey: .runId)
        self.role = try container.decodeIfPresent(Role.self, forKey: .role) ?? .assistant
        self.text = try container.decodeIfPresent(String.self, forKey: .text) ?? ""
        self.renderedHtml = try container.decodeIfPresent(String.self, forKey: .renderedHtml)
        self.createdAt = try container.decodeIfPresent(Double.self, forKey: .createdAt)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encodeIfPresent(runId, forKey: .runId)
        try container.encode(role, forKey: .role)
        try container.encode(text, forKey: .text)
        try container.encodeIfPresent(renderedHtml, forKey: .renderedHtml)
        try container.encodeIfPresent(createdAt, forKey: .createdAt)
    }
}

struct WorkspacePublicPlanStep: Codable, Equatable, Sendable {
    enum Status: String, Codable, Equatable, Sendable {
        case pending
        case running
        case completed
        case failed
    }

    let text: String
    let status: Status

    init(text: String, status: Status = .pending) {
        self.text = text
        self.status = status
    }

    init(from decoder: Decoder) throws {
        if let single = try? decoder.singleValueContainer(), let plain = try? single.decode(String.self) {
            self.text = plain
            self.status = .pending
            return
        }
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let label = try container.decodeIfPresent(String.self, forKey: .text)
            ?? container.decodeIfPresent(String.self, forKey: .label)
            ?? ""
        self.text = label
        if let rawStatus = try container.decodeIfPresent(String.self, forKey: .status)?.lowercased() {
            switch rawStatus {
            case "done", "complete", "completed": self.status = .completed
            case "running", "in_progress", "executing": self.status = .running
            case "failed", "error": self.status = .failed
            default: self.status = .pending
            }
        } else if (try container.decodeIfPresent(Bool.self, forKey: .done)) == true {
            self.status = .completed
        } else {
            self.status = .pending
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(text, forKey: .text)
        try container.encode(status.rawValue, forKey: .status)
    }

    enum CodingKeys: String, CodingKey {
        case text, label, status, done
    }
}

struct WorkspacePublicDiagnostic: Codable, Equatable, Sendable {
    var code: String?
    var phase: String?
    var errorName: String?
    var operationType: String?
    var operationId: String?
    var field: String?
    var stepId: String?
    var reason: String?
    var operationIndex: Int?
    var atomIndex: Int?
    var atomMap: Int?
    var expectedVersion: Int?
    var actualVersion: Int?
    var currentVersion: Int?
    var missingElectronFlowSteps: [WorkspaceJSONValue]?
    var invalidReactionSteps: [WorkspaceJSONValue]?

    func redacted() -> WorkspacePublicDiagnostic {
        var copy = self
        if let reason = copy.reason {
            copy.reason = WorkspaceAgentSanitizer.redactSecrets(reason)
        }
        if let code = copy.code, code.lowercased().hasPrefix("sk-") || code.lowercased().hasPrefix("sk_") {
            copy.code = nil
        }
        return copy
    }

    func formattedSummary(fallbackMessage: String = "") -> String {
        let phaseLabel = WorkspaceAgentSanitizer.drawingPhaseLabel(phase)
        let desc = WorkspaceAgentSanitizer.drawingErrorDescription(code)
            ?? WorkspaceAgentSanitizer.failureText(reason ?? fallbackMessage, fallback: phaseLabel.map { "\($0)失败" } ?? "这次绘图未能应用")
        let cleanReason = WorkspaceAgentSanitizer.failureText(reason ?? "", fallback: "")
        var locationParts: [String] = []
        if let idx = operationIndex { locationParts.append("第 \(idx + 1) 项") }
        if let operationType, !operationType.isEmpty { locationParts.append(operationType) }
        if let operationId, !operationId.isEmpty { locationParts.append(operationId) }
        if let field, !field.isEmpty { locationParts.append(field) }
        if let atomMap { locationParts.append("原子 :\(atomMap)") }
        let location = locationParts.joined(separator: " ")

        return [
            desc,
            code ?? "",
            location,
            (!cleanReason.isEmpty && cleanReason != desc) ? cleanReason : "",
        ].filter { !$0.isEmpty }.joined(separator: " · ")
    }

    func prettyJSONString() -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        guard let data = try? encoder.encode(redacted()),
              let str = String(data: data, encoding: .utf8) else {
            return "{}"
        }
        return WorkspaceAgentSanitizer.redactSecrets(str)
    }
}

struct WorkspacePublicToolCall: Codable, Equatable, Identifiable, Sendable {
    enum State: String, Codable, Equatable, Sendable {
        case running
        case complete
        case incomplete
        case failed
        case stopped
    }

    let id: String
    var name: String?
    var label: String
    var state: State
    var summary: String
    var changes: [String]
    var diagnostic: WorkspacePublicDiagnostic?
}

struct WorkspacePublicTaskCheckpoint: Codable, Equatable, Sendable {
    struct Phase: Codable, Equatable, Sendable {
        var objective: String?
        var status: String?
    }

    var goal: String?
    var status: String?
    var phaseIndex: Int?
    var phases: [Phase]?
}

struct WorkspacePublicUsage: Codable, Equatable, Sendable {
    var requests: Int?
    var turns: Int?
    var httpRequests: Int?
    var transportRetries: Int?
    var totalTokens: Int?
    var inputTokens: Int?
    var outputTokens: Int?
    var input: Int?
    var cacheRead: Int?
    var output: Int?
    var reasoning: Int?
}

struct WorkspacePublicRun: Codable, Equatable, Identifiable, Sendable {
    let id: String
    var external: Bool
    var clientName: String?
    var finished: Bool
    var status: String?
    var reason: String?
    var thinkingText: String
    var plan: [WorkspacePublicPlanStep]
    var tools: [WorkspacePublicToolCall]
    var lastDiagnosticCode: String?
    var requests: Int
    var tokens: Int?

    init(
        id: String,
        external: Bool = false,
        clientName: String? = nil,
        finished: Bool = false,
        status: String? = nil,
        reason: String? = nil,
        thinkingText: String = "",
        plan: [WorkspacePublicPlanStep] = [],
        tools: [WorkspacePublicToolCall] = [],
        lastDiagnosticCode: String? = nil,
        requests: Int = 0,
        tokens: Int? = nil
    ) {
        self.id = id
        self.external = external
        self.clientName = clientName
        self.finished = finished
        self.status = status
        self.reason = reason
        self.thinkingText = thinkingText
        self.plan = plan
        self.tools = tools
        self.lastDiagnosticCode = lastDiagnosticCode
        self.requests = requests
        self.tokens = tokens
    }
}

struct WorkspaceAgentSnapshot: Codable, Equatable, Sendable {
    var messages: [WorkspacePublicMessage]
    var runs: [WorkspacePublicRun]
    var config: WorkspacePublicConfig
}

struct WorkspaceAgentPresentation: Equatable, Sendable {
    enum Mode: String, Codable, Equatable, Sendable {
        case snapshot
        case event
    }

    let rendererRevision: Int
    let resetGeneration: Int
    let mode: Mode
    let event: WorkspaceJSONObject?
    let snapshot: WorkspaceAgentSnapshot?

    init(
        rendererRevision: Int,
        resetGeneration: Int,
        mode: Mode,
        event: WorkspaceJSONObject? = nil,
        snapshot: WorkspaceAgentSnapshot? = nil
    ) {
        self.rendererRevision = rendererRevision
        self.resetGeneration = resetGeneration
        self.mode = mode
        self.event = event
        self.snapshot = snapshot
    }
}

// MARK: - Single Ordered NativeUI Channel Message

enum WorkspaceNativeUIMessageKind: Equatable, Sendable {
    case state(WorkspaceUIState)
    case agent(WorkspaceAgentPresentation)
}

struct WorkspaceNativeUIMessage: Equatable, Sendable {
    let `protocol`: Int
    let epoch: WorkspaceEpoch
    let sequence: Int
    let kind: WorkspaceNativeUIMessageKind
}

// MARK: - Message Parsing & Sanitization Helpers

enum WorkspaceAgentSanitizer {
    private static let drawingPhases: [String: String] = [
        "decode": "读取绘图指令",
        "validate": "校验绘图指令",
        "prepare": "准备结构",
        "layout": "排布对象",
        "apply": "写入画布",
    ]

    private static let drawingErrors: [String: String] = [
        "wrong_arrow_type": "这项操作只支持电子流弯箭头",
        "missing_reference": "引用的对象不在当前画布上",
        "arrow_pi_unavailable": "所引用的键没有可用的 π 电子，请核对实际键级",
        "arrow_endpoint_invalid": "电子流端点引用无效，请核对当前对象",
        "arrow_endpoints_overlap": "电子流的起点与终点重合",
        "operation_conflict": "已执行的指令不能用同一个编号修改",
        "step_version_conflict": "反应步骤版本已变化，请读取当前版本后修改",
        "reaction_reagent_layout_failed": "试剂排布失败，本批次已撤回",
        "reaction_curve_readability_failed": "电子流弯箭头尚不清晰，本批次已撤回",
        "completion_check_failed": "绘图已提交，完成核对尚未通过",
        "invalid_tool_arguments": "绘图参数未通过校验",
        "structure_failed": "分子结构未能解析",
        "smiles_syntax": "SMILES 语法有误",
        "smiles_valence": "SMILES 中有原子价态不合法",
        "smiles_sanitization": "分子结构未通过化学检查",
        "partial_atom_mapping": "SMILES 原子映射不完整",
        "duplicate_atom_mapping": "SMILES 原子映射重复",
        "duplicate_two_electron_target": "重复或多余的双电子箭头",
        "duplicate_lone_pair_donation": "同一孤对电子被重复使用",
        "proton_transfer_sigma_to_base": "质子转移的弯箭头方向有误",
        "proton_transfer_sigma_wrong_target": "质子转移的键电子应回到供体原子",
        "isolated_hydride_dithionite_source": "连二亚硫酸盐步骤缺少合理的电子来源",
        "layout_failed": "无法整理这些对象",
        "reaction_arrow_gap": "反应物和产物之间缺少直箭头空间",
        "step_unsealed": "这一步尚未封口，可以继续补齐",
        "stale_canvas": "画布版本已更新，请从当前内容继续",
        "viewport_full": "可见画布空间不足",
    ]

    private static let runEndMessages: [String: String] = [
        "user": "已停止（手动），已完成内容保留",
        "canvas_changed": "画布有新编辑，已暂停，可从当前内容继续",
        "canvas_stale": "画布版本已更新，已暂停，可从当前内容继续",
        "manual_edit": "画布已手动编辑，已暂停，可从当前内容继续",
        "document_changed": "已切换文档，绘图已停止",
        "interrupted": "执行中断，已完成内容保留",
        "transport_interrupted": "模型连接中断，已完成内容保留，可继续执行",
        "upstream_stream_error": "上游连接中断，已完成内容保留，可继续执行",
        "model_failed": "模型请求失败，已完成内容保留，可继续执行",
        "no_progress": "连续尝试未推进，已暂停，可从当前内容继续",
        "mechanism_incomplete": "机理尚未画完整，可从当前内容继续",
        "drawing_failed": "有绘图操作未完成，可从当前内容继续",
        "viewport_full": "可见画布空间不足，调整视图后继续",
        "provider_length": "模型响应截断，可从当前进度继续",
        "external_cancel": "外部请求已取消，已完成内容保留",
    ]

    static func drawingPhaseLabel(_ phase: String?) -> String? {
        guard let phase else { return nil }
        return drawingPhases[phase]
    }

    static func drawingErrorDescription(_ code: String?) -> String? {
        guard let code else { return nil }
        return drawingErrors[code]
    }

    static func runEndMessage(for reason: String?) -> String? {
        guard let reason else { return nil }
        return runEndMessages[reason]
    }

    static func toolDisplayLabel(name: String?) -> String {
        let value = (name ?? "").lowercased()
        if value.contains("arrow") || value.contains("electron") { return "绘制电子箭头" }
        if value.contains("molecule") || value.contains("structure") { return "处理分子结构" }
        if value.contains("selection") || value.contains("scene") || value.contains("read") || value.contains("inspect") { return "读取画布" }
        if value.contains("draw") || value.contains("operation") { return "更新画布" }
        if value.contains("complete_phase") { return "核对阶段" }
        if value.contains("complete_layout") { return "核对排版" }
        if value.contains("plan") { return "更新计划" }
        return "执行操作"
    }

    static func redactSecrets(_ text: String, transientSecret: String? = nil) -> String {
        var result = text
        if let transientSecret, !transientSecret.isEmpty {
            result = result.replacingOccurrences(of: transientSecret, with: "••••")
        }
        let patterns = [
            "Bearer\\s+\\S+",
            "\\bsk[-_][A-Za-z0-9_-]{8,}\\b",
            "\"(?:apiKey|api_key|sessionToken|authorization)\"\\s*:\\s*\"[^\"]*\"",
        ]
        for pattern in patterns {
            if let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) {
                let range = NSRange(result.startIndex..<result.endIndex, in: result)
                result = regex.stringByReplacingMatches(in: result, options: [], range: range, withTemplate: "[redacted]")
            }
        }
        return result
    }

    static func failureText(_ raw: String?, fallback: String, transientSecret: String? = nil) -> String {
        var message = (raw ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if message.isEmpty { return fallback }
        let lower = message.lowercased()
        if lower.contains("json parse") || lower.contains("unable to parse json") { return fallback }
        if let splitRange = message.range(of: "Received arguments:", options: [.caseInsensitive]) {
            message = String(message[..<splitRange.lowerBound])
        }
        message = redactSecrets(message, transientSecret: transientSecret).trimmingCharacters(in: .whitespacesAndNewlines)
        if message.hasPrefix("{"), let data = message.data(using: .utf8),
           let diag = try? JSONDecoder().decode(WorkspacePublicDiagnostic.self, from: data) {
            let reason = (diag.reason ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            if !reason.isEmpty {
                message = redactSecrets(reason, transientSecret: transientSecret)
            } else if let mapped = drawingErrorDescription(diag.code) {
                message = mapped
            } else {
                return fallback
            }
        }
        if let regex = try? NSRegularExpression(pattern: "^(?:Invalid arguments|Validation failed) for tool \"[^\"]+\":\\s*", options: [.caseInsensitive]) {
            let range = NSRange(message.startIndex..<message.endIndex, in: message)
            message = regex.stringByReplacingMatches(in: message, options: [], range: range, withTemplate: "")
        }
        message = message.components(separatedBy: .whitespacesAndNewlines).filter { !$0.isEmpty }.joined(separator: " ")
        if message.isEmpty || message.contains("{") || message.contains("}") { return fallback }
        if message.count > 320 {
            let idx = message.index(message.startIndex, offsetBy: 319)
            return String(message[..<idx]) + "…"
        }
        return message
    }
}

enum WorkspaceContractCodec {
    static func decodeMessage(from body: [String: Any]) -> WorkspaceNativeUIMessage? {
        guard (body["act"] as? String) == "nativeUI",
              let proto = body["protocol"] as? Int, proto == workspaceNativeUIProtocolVersion,
              let sequence = body["sequence"] as? Int,
              let kindRaw = body["kind"] as? String,
              let epochDict = body["epoch"] as? [String: Any],
              let navGen = epochDict["navigationGeneration"] as? Int,
              let pageId = epochDict["pageId"] as? String,
              let payloadDict = body["payload"] as? [String: Any] else {
            return nil
        }

        let epoch = WorkspaceEpoch(navigationGeneration: navGen, pageId: pageId)
        switch kindRaw {
        case "state":
            let stateDict = (payloadDict["state"] as? [String: Any]) ?? payloadDict
            guard let data = try? JSONSerialization.data(withJSONObject: stateDict),
                  let state = try? JSONDecoder().decode(WorkspaceUIState.self, from: data),
                  state.protocol == workspaceNativeUIProtocolVersion,
                  state.epoch == epoch else {
                return nil
            }
            return WorkspaceNativeUIMessage(protocol: proto, epoch: epoch, sequence: sequence, kind: .state(state))

        case "agent":
            guard let presentation = decodeAgentPresentation(from: payloadDict) else {
                return nil
            }
            return WorkspaceNativeUIMessage(protocol: proto, epoch: epoch, sequence: sequence, kind: .agent(presentation))

        default:
            return nil
        }
    }

    static func decodeAgentPresentation(from dict: [String: Any]) -> WorkspaceAgentPresentation? {
        guard let rendererRevision = dict["rendererRevision"] as? Int,
              let resetGeneration = dict["resetGeneration"] as? Int,
              let modeRaw = dict["mode"] as? String,
              let mode = WorkspaceAgentPresentation.Mode(rawValue: modeRaw) else {
            return nil
        }
        switch mode {
        case .snapshot:
            guard let snapDict = dict["snapshot"] as? [String: Any],
                  let data = try? JSONSerialization.data(withJSONObject: snapDict),
                  let snapshot = try? JSONDecoder().decode(WorkspaceAgentSnapshot.self, from: data) else {
                return nil
            }
            return WorkspaceAgentPresentation(
                rendererRevision: rendererRevision,
                resetGeneration: resetGeneration,
                mode: .snapshot,
                event: nil,
                snapshot: snapshot
            )

        case .event:
            guard let eventDict = dict["event"] as? [String: Any],
                  case let .object(eventObj)? = WorkspaceJSONValue.from(foundation: eventDict) else {
                return nil
            }
            return WorkspaceAgentPresentation(
                rendererRevision: rendererRevision,
                resetGeneration: resetGeneration,
                mode: .event,
                event: eventObj,
                snapshot: nil
            )
        }
    }

    static func foundationDictionary<T: Encodable>(from value: T) -> [String: Any]? {
        guard let data = try? JSONEncoder().encode(value),
              let dict = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return nil
        }
        return dict
    }

    static func decode<T: Decodable>(_ type: T.Type, from object: Any?) -> T? {
        guard let object, JSONSerialization.isValidJSONObject(object),
              let data = try? JSONSerialization.data(withJSONObject: object) else {
            return nil
        }
        return try? JSONDecoder().decode(type, from: data)
    }
}

// MARK: - Four-Method Bridge Interface & WKWebView Implementation

/// Abstract bridge matching the exact four JS methods on `window.k3dAPI.nativeUI`.
/// Components inject a coordinator backed by this protocol, enabling isolated testing without WKWebView.
protocol WorkspaceNativeUIBridging: AnyObject {
    func attach(options: WorkspaceAttachOptions, completion: @escaping (Result<WorkspaceAttachReply, Error>) -> Void)
    func dispatch(command: WorkspaceCommand, completion: @escaping (Result<WorkspaceCommandReply, Error>) -> Void)
    func getState(completion: @escaping (Result<WorkspaceUIState, Error>) -> Void)
    func detach(epoch: WorkspaceEpoch)
}

enum WorkspaceBridgeError: LocalizedError, Equatable {
    case unavailable
    case invalidReply
    case scriptError(String)

    var errorDescription: String? {
        switch self {
        case .unavailable: return "nativeUI bridge is unavailable"
        case .invalidReply: return "nativeUI bridge returned an invalid reply"
        case .scriptError(let detail): return detail
        }
    }
}

/// Concrete WKWebView bridge using `callAsyncJavaScript` with structured `arguments` (no JS string interpolation).
final class WorkspaceWKWebViewBridge: WorkspaceNativeUIBridging {
    private weak var webView: WKWebView?
    private let expectedOrigin: String?

    init(webView: WKWebView?, expectedOrigin: String? = nil) {
        self.webView = webView
        self.expectedOrigin = expectedOrigin
    }

    /// Validates origin + main frame before decoding the single `nativeUI` act from `WKScriptMessage`.
    func parseScriptMessage(_ message: WKScriptMessage) -> WorkspaceNativeUIMessage? {
        guard message.name == "k3d",
              message.frameInfo.isMainFrame,
              let body = message.body as? [String: Any] else {
            return nil
        }
        if let expectedOrigin {
            let sec = message.frameInfo.securityOrigin
            let actualOrigin = "\(sec.protocol)://\(sec.host):\(sec.port)"
            let actualNoDefaultPort = sec.port == 0 ? "\(sec.protocol)://\(sec.host)" : actualOrigin
            guard expectedOrigin == actualOrigin || expectedOrigin == actualNoDefaultPort else {
                return nil
            }
        }
        return WorkspaceContractCodec.decodeMessage(from: body)
    }

    func attach(options: WorkspaceAttachOptions, completion: @escaping (Result<WorkspaceAttachReply, Error>) -> Void) {
        guard let webView, let payload = WorkspaceContractCodec.foundationDictionary(from: options) else {
            completion(.failure(WorkspaceBridgeError.unavailable))
            return
        }
        let script = """
        if (!window.k3dAPI || !window.k3dAPI.nativeUI || typeof window.k3dAPI.nativeUI.attach !== 'function') {
          return { ok: false, ownedSurfaces: [], error: { code: 'unavailable', message: 'k3dAPI.nativeUI.attach missing' } };
        }
        return await window.k3dAPI.nativeUI.attach(options);
        """
        webView.callAsyncJavaScript(script, arguments: ["options": payload], in: nil, in: .page) { result in
            switch result {
            case .failure(let error):
                completion(.failure(WorkspaceBridgeError.scriptError(error.localizedDescription)))
            case .success(let value):
                guard let reply = WorkspaceContractCodec.decode(WorkspaceAttachReply.self, from: value) else {
                    completion(.failure(WorkspaceBridgeError.invalidReply))
                    return
                }
                completion(.success(reply))
            }
        }
    }

    func dispatch(command: WorkspaceCommand, completion: @escaping (Result<WorkspaceCommandReply, Error>) -> Void) {
        guard let webView, let payload = WorkspaceContractCodec.foundationDictionary(from: command) else {
            completion(.failure(WorkspaceBridgeError.unavailable))
            return
        }
        let script = """
        if (!window.k3dAPI || !window.k3dAPI.nativeUI || typeof window.k3dAPI.nativeUI.dispatch !== 'function') {
          return { protocol: 1, requestId: command.requestId, ok: false, error: { code: 'not_ready', message: 'k3dAPI.nativeUI.dispatch missing' } };
        }
        return await window.k3dAPI.nativeUI.dispatch(command);
        """
        webView.callAsyncJavaScript(script, arguments: ["command": payload], in: nil, in: .page) { result in
            switch result {
            case .failure(let error):
                completion(.failure(WorkspaceBridgeError.scriptError(error.localizedDescription)))
            case .success(let value):
                guard let reply = WorkspaceContractCodec.decode(WorkspaceCommandReply.self, from: value) else {
                    completion(.failure(WorkspaceBridgeError.invalidReply))
                    return
                }
                completion(.success(reply))
            }
        }
    }

    func getState(completion: @escaping (Result<WorkspaceUIState, Error>) -> Void) {
        guard let webView else {
            completion(.failure(WorkspaceBridgeError.unavailable))
            return
        }
        let script = """
        if (!window.k3dAPI || !window.k3dAPI.nativeUI || typeof window.k3dAPI.nativeUI.getState !== 'function') {
          return null;
        }
        return window.k3dAPI.nativeUI.getState();
        """
        webView.callAsyncJavaScript(script, arguments: [:], in: nil, in: .page) { result in
            switch result {
            case .failure(let error):
                completion(.failure(WorkspaceBridgeError.scriptError(error.localizedDescription)))
            case .success(let value):
                guard let state = WorkspaceContractCodec.decode(WorkspaceUIState.self, from: value) else {
                    completion(.failure(WorkspaceBridgeError.invalidReply))
                    return
                }
                completion(.success(state))
            }
        }
    }

    func detach(epoch: WorkspaceEpoch) {
        guard let webView, let payload = WorkspaceContractCodec.foundationDictionary(from: epoch) else { return }
        let script = """
        if (window.k3dAPI && window.k3dAPI.nativeUI && typeof window.k3dAPI.nativeUI.detach === 'function') {
          window.k3dAPI.nativeUI.detach(epoch);
        }
        """
        webView.callAsyncJavaScript(script, arguments: ["epoch": payload], in: nil, in: .page) { _ in }
    }
}

// MARK: - Existing Swift File Service Callbacks (No Parallel Lifecycle / No NSDocument Migration)

/// Read-only projection of existing Swift session state (`CanvasSession` / `AppDelegate`).
struct WorkspaceDocumentMetadata: Equatable, Sendable {
    var displayTitle: String
    var fileURL: URL?
    var documentMode: WorkspaceViewportMode
    var isDirty: Bool
    var isPageUsable: Bool
    var isNavigationInFlight: Bool
    var saveStatusText: String

    static let empty = WorkspaceDocumentMetadata(
        displayTitle: "未命名",
        fileURL: nil,
        documentMode: .canvas,
        isDirty: false,
        isPageUsable: false,
        isNavigationInFlight: false,
        saveStatusText: "等待页面就绪"
    )
}

/// Legacy canvas non-clipboard edit actions used when attach fails or no native editing surface is owned.
enum WorkspaceLegacyCanvasEditAction: String, Sendable {
    case undo = "edit.undo"
    case redo = "edit.redo"
    case selectAll = "edit.selectAll"
    case delete = "edit.delete"
}

/// Callback hooks routing file, host-owned structural, and export operations strictly to existing Swift services.
/// Leaves nil callbacks disabled cleanly; never introduces unimplemented share/trash actions.
struct WorkspaceFileServiceCallbacks {
    var onNewCanvas: (() -> Void)?
    var onNewPaper: (() -> Void)?
    var onOpenPanel: (() -> Void)?
    var onOpenURL: ((URL) -> Void)?
    var onSave: (() -> Void)?
    var onSaveAs: (() -> Void)?
    var onShowWelcome: (() -> Void)?
    var onRevealInFinder: ((URL) -> Void)?
    var onRenameURL: ((URL) -> Void)?
    var onRemoveRecent: ((WelcomeRecentItem) -> Void)?

    // Host-owned chemistry/export actions (existing Swift pipelines, not JS nativeUI.dispatch)
    var onCleanLayout: (() -> Void)?
    var onGenerate3D: (() -> Void)?
    var onCheckStructure: (() -> Void)?
    var onComputeProperties: (() -> Void)?
    var onExportMol: (() -> Void)?
    var onExportMechanismImage: (() -> Void)?
    var onExportDocumentPDF: (() -> Void)?
    var onCopySmiles: (() -> Void)?

    // Host-owned WKWebView clipboard pipeline (cut/copy/paste)
    var onCanvasClipboardAction: ((WorkspaceCanvasClipboardAction, Any?) -> Bool)?
    var canPerformCanvasClipboardAction: ((WorkspaceCanvasClipboardAction) -> Bool)?
    // Host-owned legacy JS/AppKit edit fallback (undo/redo/selectAll/delete)
    var onLegacyCanvasEditAction: ((WorkspaceLegacyCanvasEditAction, Any?) -> Bool)?
    var canPerformLegacyCanvasEditAction: ((WorkspaceLegacyCanvasEditAction) -> Bool)?

    // Paper mode & document insertion actions (host-coordinated)
    var onSwitchToCanvasMode: (() -> Void)?
    var onSwitchToPaperMode: (() -> Void)?
    var onPaperSetup: (() -> Void)?
    var onAddPaperPage: (() -> Void)?
    var onRemoveBlankLastPage: (() -> Void)?
    var onInsertImageIntoDocument: (() -> Void)?
    var onInsertFileIntoDocument: (() -> Void)?

    init(
        onNewCanvas: (() -> Void)? = nil,
        onNewPaper: (() -> Void)? = nil,
        onOpenPanel: (() -> Void)? = nil,
        onOpenURL: ((URL) -> Void)? = nil,
        onSave: (() -> Void)? = nil,
        onSaveAs: (() -> Void)? = nil,
        onShowWelcome: (() -> Void)? = nil,
        onRevealInFinder: ((URL) -> Void)? = nil,
        onRenameURL: ((URL) -> Void)? = nil,
        onRemoveRecent: ((WelcomeRecentItem) -> Void)? = nil,
        onCleanLayout: (() -> Void)? = nil,
        onGenerate3D: (() -> Void)? = nil,
        onCheckStructure: (() -> Void)? = nil,
        onComputeProperties: (() -> Void)? = nil,
        onExportMol: (() -> Void)? = nil,
        onExportMechanismImage: (() -> Void)? = nil,
        onExportDocumentPDF: (() -> Void)? = nil,
        onCopySmiles: (() -> Void)? = nil,
        onCanvasClipboardAction: ((WorkspaceCanvasClipboardAction, Any?) -> Bool)? = nil,
        canPerformCanvasClipboardAction: ((WorkspaceCanvasClipboardAction) -> Bool)? = nil,
        onLegacyCanvasEditAction: ((WorkspaceLegacyCanvasEditAction, Any?) -> Bool)? = nil,
        canPerformLegacyCanvasEditAction: ((WorkspaceLegacyCanvasEditAction) -> Bool)? = nil,
        onSwitchToCanvasMode: (() -> Void)? = nil,
        onSwitchToPaperMode: (() -> Void)? = nil,
        onPaperSetup: (() -> Void)? = nil,
        onAddPaperPage: (() -> Void)? = nil,
        onRemoveBlankLastPage: (() -> Void)? = nil,
        onInsertImageIntoDocument: (() -> Void)? = nil,
        onInsertFileIntoDocument: (() -> Void)? = nil
    ) {
        self.onNewCanvas = onNewCanvas
        self.onNewPaper = onNewPaper
        self.onOpenPanel = onOpenPanel
        self.onOpenURL = onOpenURL
        self.onSave = onSave
        self.onSaveAs = onSaveAs
        self.onShowWelcome = onShowWelcome
        self.onRevealInFinder = onRevealInFinder
        self.onRenameURL = onRenameURL
        self.onRemoveRecent = onRemoveRecent
        self.onCleanLayout = onCleanLayout
        self.onGenerate3D = onGenerate3D
        self.onCheckStructure = onCheckStructure
        self.onComputeProperties = onComputeProperties
        self.onExportMol = onExportMol
        self.onExportMechanismImage = onExportMechanismImage
        self.onExportDocumentPDF = onExportDocumentPDF
        self.onCopySmiles = onCopySmiles
        self.onCanvasClipboardAction = onCanvasClipboardAction
        self.canPerformCanvasClipboardAction = canPerformCanvasClipboardAction
        self.onLegacyCanvasEditAction = onLegacyCanvasEditAction
        self.canPerformLegacyCanvasEditAction = canPerformLegacyCanvasEditAction
        self.onSwitchToCanvasMode = onSwitchToCanvasMode
        self.onSwitchToPaperMode = onSwitchToPaperMode
        self.onPaperSetup = onPaperSetup
        self.onAddPaperPage = onAddPaperPage
        self.onRemoveBlankLastPage = onRemoveBlankLastPage
        self.onInsertImageIntoDocument = onInsertImageIntoDocument
        self.onInsertFileIntoDocument = onInsertFileIntoDocument
    }
}

// MARK: - Agent Presentation Store (No Second Runtime)

enum WorkspaceAgentTimelineItem: Equatable, Identifiable, Sendable {
    case userMessage(WorkspacePublicMessage)
    case runTurn(WorkspacePublicRun, messages: [WorkspacePublicMessage])

    var id: String {
        switch self {
        case .userMessage(let msg): return "msg:\(msg.stableKey)"
        case .runTurn(let run, _): return "run:\(run.id)"
        }
    }
}

/// Pure presentation store driven exclusively by `WorkspaceAgentPresentation` snapshots and events.
final class WorkspaceAgentStore {
    private(set) var hasSnapshot = false
    private(set) var currentResetGeneration = 0
    private(set) var lastRendererRevision = -1

    private(set) var config = WorkspacePublicConfig()
    private(set) var timeline: [WorkspaceAgentTimelineItem] = []
    private(set) var statusText = "就绪"
    private(set) var errorMessage: String?
    private(set) var configNoticeVisible = true
    private(set) var running = false
    private(set) var pendingStart = false
    private(set) var stopRequested = false
    private(set) var canContinue = false
    private(set) var settingsBusy = false
    private(set) var shouldOpenSettings = false
    private(set) var elapsedSeconds: Int?
    private(set) var usageSummary = ""
    private(set) var usageDetailTooltip = ""
    private(set) var generationTooltip: String?
    private(set) var transportProgressText: String?
    private(set) var taskProgressText: String?
    private(set) var checkpoint: WorkspacePublicTaskCheckpoint?

    private var ignoredRunIds = Set<String>()
    private var currentRunId: String?
    private var localSerial = 0
    private var lastTransientSecret: String?

    var onChange: (() -> Void)?

    func noteTransientSecret(_ secret: String?) {
        if let secret, !secret.isEmpty {
            lastTransientSecret = secret
        }
    }

    func clearTransientSecret() {
        lastTransientSecret = nil
    }

    func dismissError() {
        errorMessage = nil
        onChange?()
    }

    func acknowledgeSettingsOpened() {
        shouldOpenSettings = false
    }

    func markStopRequested() {
        guard running || pendingStart else { return }
        stopRequested = true
        statusText = "正在停止，已完成内容保留…"
        onChange?()
    }

    func syncAgentSummary(_ summary: WorkspaceUIState.AgentSummary) {
        let wasRunning = running
        running = summary.running
        pendingStart = summary.pendingStart
        if !running && !pendingStart {
            stopRequested = false
        }
        canContinue = summary.canContinue && !running && !pendingStart
        settingsBusy = summary.settingsBusy
        if wasRunning != running {
            onChange?()
        }
    }

    func resetForNewEpoch() {
        hasSnapshot = false
        currentResetGeneration = 0
        lastRendererRevision = -1
        config = WorkspacePublicConfig()
        timeline.removeAll()
        ignoredRunIds.removeAll()
        currentRunId = nil
        statusText = "就绪"
        errorMessage = nil
        configNoticeVisible = true
        running = false
        pendingStart = false
        stopRequested = false
        canContinue = false
        settingsBusy = false
        shouldOpenSettings = false
        elapsedSeconds = nil
        usageSummary = ""
        usageDetailTooltip = ""
        generationTooltip = nil
        transportProgressText = nil
        taskProgressText = nil
        checkpoint = nil
        lastTransientSecret = nil
        onChange?()
    }

    func applyPublicConfig(_ nextConfig: WorkspacePublicConfig) {
        config = nextConfig
        configNoticeVisible = !nextConfig.configured
        onChange?()
    }

    func showPublicError(_ rawMessage: String?) {
        errorMessage = WorkspaceAgentSanitizer.failureText(
            rawMessage,
            fallback: "操作失败，请重试。",
            transientSecret: lastTransientSecret
        )
        onChange?()
    }

    /// Applies ordered presentation payload (`snapshot` before subsequent `event`s, fenced by `resetGeneration` and `rendererRevision`).
    @discardableResult
    func apply(_ presentation: WorkspaceAgentPresentation) -> Bool {
        switch presentation.mode {
        case .snapshot:
            guard let snapshot = presentation.snapshot else { return false }
            if presentation.resetGeneration < currentResetGeneration {
                return false
            }
            if presentation.resetGeneration == currentResetGeneration &&
               hasSnapshot &&
               presentation.rendererRevision < lastRendererRevision {
                return false
            }
            if presentation.resetGeneration > currentResetGeneration {
                ignoredRunIds.removeAll()
                errorMessage = nil
                checkpoint = nil
                taskProgressText = nil
                transportProgressText = nil
                elapsedSeconds = nil
                usageSummary = ""
                usageDetailTooltip = ""
            }
            currentResetGeneration = presentation.resetGeneration
            lastRendererRevision = presentation.rendererRevision
            hasSnapshot = true
            rebuildFromSnapshot(snapshot)
            onChange?()
            return true

        case .event:
            guard hasSnapshot,
                  presentation.resetGeneration == currentResetGeneration,
                  presentation.rendererRevision > lastRendererRevision,
                  let event = presentation.event else {
                return false
            }
            lastRendererRevision = presentation.rendererRevision
            let handled = applyEvent(event)
            if handled { onChange?() }
            return handled
        }
    }

    private func rebuildFromSnapshot(_ snapshot: WorkspaceAgentSnapshot) {
        config = snapshot.config
        configNoticeVisible = !snapshot.config.configured
        timeline.removeAll()
        currentRunId = nil
        running = false
        stopRequested = false

        var messagesByRun: [String: [WorkspacePublicMessage]] = [:]
        var standaloneMessages: [WorkspacePublicMessage] = []
        for msg in snapshot.messages {
            if let runId = msg.runId, !runId.isEmpty, msg.role != .user {
                messagesByRun[runId, default: []].append(msg)
            } else {
                standaloneMessages.append(msg)
            }
        }
        // Preserve chronological order if user messages share runId or appear sequentially
        var emittedRuns = Set<String>()
        for msg in snapshot.messages {
            if msg.role == .user {
                timeline.append(.userMessage(msg))
            } else if let runId = msg.runId, let run = snapshot.runs.first(where: { $0.id == runId }), !emittedRuns.contains(runId) {
                emittedRuns.insert(runId)
                timeline.append(.runTurn(run, messages: messagesByRun[runId] ?? []))
            } else if msg.runId == nil {
                timeline.append(.userMessage(msg))
            }
        }
        for run in snapshot.runs where !emittedRuns.contains(run.id) {
            emittedRuns.insert(run.id)
            timeline.append(.runTurn(run, messages: messagesByRun[run.id] ?? []))
        }
        if let active = snapshot.runs.last(where: { !$0.finished }) {
            currentRunId = active.id
            running = true
        } else if let last = snapshot.runs.last {
            currentRunId = last.id
        }
        _ = standaloneMessages
    }

    private func stringField(_ event: WorkspaceJSONObject, _ key: String) -> String? {
        if case let .string(s)? = event[key] { return s }
        return nil
    }

    private func boolField(_ event: WorkspaceJSONObject, _ key: String) -> Bool? {
        if case let .bool(b)? = event[key] { return b }
        return nil
    }

    private func numberField(_ event: WorkspaceJSONObject, _ key: String) -> Double? {
        if case let .number(n)? = event[key] { return n }
        return nil
    }

    private func intField(_ event: WorkspaceJSONObject, _ key: String) -> Int? {
        // Int(Double) 对超出 Int64 表示范围的值会直接 trap（如 Int(1e300) 是 fatal error）。
        // 这里的数值来自 agent 事件（attempt/delayMs/tokens 等），属于不可信输入：
        // 先做范围防护再截断，超界/非有限值按字段缺失处理（调用方均有 ?? 回退或 if let）。
        guard let n = numberField(event, key), n.isFinite,
              n >= Double(Int.min), n < Double(Int.max) else { return nil }
        return Int(n)
    }

    private func applyEvent(_ event: WorkspaceJSONObject) -> Bool {
        let type = stringField(event, "type") ?? stringField(event, "event") ?? ""
        guard !type.isEmpty else { return false }

        if type == "clear" || type == "reset" {
            for item in timeline {
                if case .runTurn(let run, _) = item { ignoredRunIds.insert(run.id) }
            }
            timeline.removeAll()
            currentRunId = nil
            errorMessage = nil
            canContinue = false
            running = false
            stopRequested = false
            usageSummary = ""
            usageDetailTooltip = ""
            elapsedSeconds = nil
            transportProgressText = nil
            taskProgressText = nil
            checkpoint = nil
            statusText = "就绪"
            return true
        }

        if type == "user_message" {
            let text = stringField(event, "text") ?? ""
            guard !text.isEmpty else { return false }
            localSerial += 1
            let id = stringField(event, "messageId") ?? "user-\(localSerial)"
            let msg = WorkspacePublicMessage(
                id: id,
                runId: stringField(event, "runId"),
                role: .user,
                text: text,
                renderedHtml: nil,
                createdAt: numberField(event, "createdAt")
            )
            timeline.append(.userMessage(msg))
            errorMessage = nil
            return true
        }

        if type == "config" {
            let cfgObject = event["config"]?.foundationValue ?? event.mapValues(\.foundationValue)
            if let decoded = WorkspaceContractCodec.decode(WorkspacePublicConfig.self, from: cfgObject) {
                config = decoded
                configNoticeVisible = !decoded.configured
                return true
            }
            return false
        }

        if let runId = stringField(event, "runId"), ignoredRunIds.contains(runId) {
            return false
        }

        switch type {
        case "run_start":
            return startRun(event)

        case "task_checkpoint":
            if case let .object(cpObj)? = event["checkpoint"],
               let cp = WorkspaceContractCodec.decode(WorkspacePublicTaskCheckpoint.self, from: cpObj.mapValues(\.foundationValue)) {
                checkpoint = cp
                taskProgressText = formatCheckpoint(cp)
            } else {
                checkpoint = nil
                taskProgressText = nil
            }
            return true

        case "resume_available":
            if !running {
                canContinue = true
                statusText = "已载入保存的任务，点击继续执行"
            }
            return true

        case "resume_unavailable":
            canContinue = false
            if stringField(event, "reason") == "document_changed" {
                taskProgressText = nil
                if !running { statusText = "已切换文档，上一个任务已结束" }
            }
            return true

        case "recovery_scheduled", "recovery_started", "recovery_exhausted", "recovery_cancelled":
            guard let activeId = currentRunId, stringField(event, "runId") == activeId else {
                return false
            }
            let attempt = intField(event, "attempt") ?? intField(event, "recoveryAttempts") ?? 0
            let suffix = "（\(attempt)/2）"
            if type == "recovery_scheduled" || type == "recovery_started" {
                errorMessage = nil
                canContinue = false
                running = true
                let delayMs = max(0, numberField(event, "delayMs") ?? 0)
                let seconds = Int(ceil(delayMs / 1000.0))
                statusText = type == "recovery_started"
                    ? "正在从断点续跑\(suffix)"
                    : "上游中断，\(seconds)秒后从断点续跑\(suffix)"
            } else {
                running = false
                stopRequested = false
                canContinue = boolField(event, "canContinue") ?? true
                if type == "recovery_exhausted" {
                    let msg = "上游连续中断，自动续跑已达 2 次，已完成内容保留，可手动继续"
                    statusText = msg
                    errorMessage = msg
                } else {
                    switch stringField(event, "reason") {
                    case "document_changed": statusText = "已切换文档，自动续跑已取消"
                    case "reset": statusText = "自动续跑已取消"
                    case "config_changed": statusText = "模型设置已变化，自动续跑已取消，可手动继续"
                    case "manual_edit", "canvas_changed": statusText = "画布已编辑，自动续跑已取消，可从当前内容继续"
                    default: statusText = "自动续跑已停止，已完成内容保留"
                    }
                }
            }
            return true

        case "assistant_start":
            guard let runIndex = activeRunIndex(for: event) else { return false }
            localSerial += 1
            let msgId = stringField(event, "messageId") ?? "assistant-\(localSerial)"
            ensureAssistantMessage(runIndex: runIndex, messageId: msgId)
            statusText = "正在回复…"
            return true

        case "assistant_end":
            return activeRunIndex(for: event) != nil

        case "text_delta":
            let channel = stringField(event, "channel") ?? ""
            let isHidden = boolField(event, "hidden") == true
            if ["analysis", "reasoning", "thinking"].contains(channel) || isHidden {
                // Hidden channel text NEVER mixes into public assistant message bubbles.
                statusText = "正在思考…"
                return true
            }
            guard let delta = stringField(event, "delta"), !delta.isEmpty,
                  let runIndex = activeRunIndex(for: event) else {
                return false
            }
            let msgId = stringField(event, "messageId")
            appendAssistantDelta(runIndex: runIndex, messageId: msgId, delta: delta, renderedHtml: stringField(event, "renderedHtml"))
            statusText = "正在回复…"
            return true

        case "thinking":
            statusText = boolField(event, "active") == false ? "正在处理…" : "正在思考…"
            return true

        case "thinking_delta":
            guard stringField(event, "source") == "model",
                  let delta = stringField(event, "delta"), !delta.isEmpty,
                  let runIndex = activeRunIndex(for: event) else {
                return false
            }
            updateRun(at: runIndex) { run, _ in
                run.thinkingText += delta
            }
            return true

        case "transport_progress":
            guard activeRunIndex(for: event) != nil else { return false }
            updateTransportProgress(event)
            return true

        case "transport_retry":
            statusText = "模型连接失败，正在重连…"
            return true

        case "tool_start", "tool_progress":
            guard let runIndex = activeRunIndex(for: event) else { return false }
            var labelForStatus = ""
            updateRun(at: runIndex) { run, _ in
                if run.external && !running { running = true }
                let callId = stringField(event, "toolCallId") ?? stringField(event, "id") ?? {
                    localSerial += 1
                    return "tool-\(localSerial)"
                }()
                let toolName = stringField(event, "name") ?? stringField(event, "toolName")
                let idx = ensureToolIndex(in: &run, id: callId, name: toolName, explicitLabel: stringField(event, "label"))
                if run.tools[idx].state == .running {
                    var summary = stringField(event, "summary") ?? stringField(event, "message") ?? stringField(event, "progress") ?? ""
                    if summary.isEmpty, case let .object(prog)? = event["progress"] {
                        let phase = stringField(prog, "phase") ?? ""
                        if phase == "committed", let count = intField(prog, "count") {
                            summary = "已完成 \(max(0, count)) 项绘图操作"
                        } else if phase == "applying" {
                            summary = "正在绘制…"
                        }
                    }
                    if !summary.isEmpty { run.tools[idx].summary = summary }
                    if case let .array(changesArr)? = event["changes"] {
                        run.tools[idx].changes = parseChanges(changesArr)
                    }
                }
                labelForStatus = run.external ? "外部助手正在操作画布…" : run.tools[idx].label
            }
            if !labelForStatus.isEmpty { statusText = labelForStatus }
            return true

        case "tool_end":
            guard let runIndex = activeRunIndex(for: event) else { return false }
            var statusOut = ""
            updateRun(at: runIndex) { run, _ in
                let callId = stringField(event, "toolCallId") ?? stringField(event, "id") ?? run.tools.last?.id ?? {
                    localSerial += 1
                    return "tool-\(localSerial)"
                }()
                let toolName = stringField(event, "name") ?? stringField(event, "toolName")
                let idx = ensureToolIndex(in: &run, id: callId, name: toolName, explicitLabel: stringField(event, "label"))
                let statusStr = stringField(event, "status") ?? ""
                let success = boolField(event, "success") != false
                    && boolField(event, "isError") != true
                    && event["error"] == nil
                    && statusStr != "error" && statusStr != "failed"
                let message = stringField(event, "summary")
                    ?? stringField(event, "message")
                    ?? stringField(event, "error")
                    ?? ""
                let incomplete = success && (
                    boolField(event, "finishRejected") == true ||
                    (stringField(event, "finishRejected") != nil)
                )

                var diagnostic: WorkspacePublicDiagnostic?
                if (!success || incomplete), case let .object(diagObj)? = event["diagnostic"] {
                    diagnostic = WorkspaceContractCodec.decode(WorkspacePublicDiagnostic.self, from: diagObj.mapValues(\.foundationValue))?.redacted()
                }
                if incomplete && diagnostic == nil {
                    diagnostic = WorkspacePublicDiagnostic(code: "completion_check_failed", phase: "validate", reason: stringField(event, "finishRejected"))
                }

                run.tools[idx].state = incomplete ? .incomplete : (success ? .complete : .failed)
                if case let .array(changesArr)? = event["changes"] {
                    run.tools[idx].changes = parseChanges(changesArr)
                }
                if let diagnostic {
                    run.tools[idx].diagnostic = diagnostic
                    run.tools[idx].summary = diagnostic.formattedSummary(fallbackMessage: message)
                    run.lastDiagnosticCode = diagnostic.code
                } else {
                    run.tools[idx].diagnostic = nil
                    if success {
                        run.tools[idx].summary = message.isEmpty ? "已完成" : message
                    } else {
                        let fallback = toolName == "draw_operations" ? "这次绘图未能应用" : "操作未完成"
                        run.tools[idx].summary = WorkspaceAgentSanitizer.failureText(message, fallback: fallback, transientSecret: lastTransientSecret)
                    }
                }
                if incomplete {
                    statusOut = "绘图已提交，完成核对尚未通过"
                } else if success {
                    statusOut = "操作已完成，继续处理…"
                } else {
                    statusOut = "操作未完成" + (diagnostic?.code.map { " · \($0)" } ?? "")
                }
            }
            if !statusOut.isEmpty { statusText = statusOut }
            return true

        case "plan":
            guard let runIndex = activeRunIndex(for: event),
                  case let .array(stepsArr)? = event["steps"] else {
                return false
            }
            let foundationSteps = stepsArr.map(\.foundationValue)
            let steps = WorkspaceContractCodec.decode([WorkspacePublicPlanStep].self, from: foundationSteps) ?? []
            updateRun(at: runIndex) { run, _ in
                run.plan = steps
            }
            return true

        case "phase_start", "phase_end":
            let idxStr = intField(event, "phaseIndex").map { "\($0 + 1)" }
            let countStr = intField(event, "phaseCount").map { "/\($0)" } ?? ""
            let label = idxStr.map { "阶段 \($0)\(countStr)" } ?? "当前阶段"
            let rawDetail = stringField(event, type == "phase_start" ? "objective" : "summary") ?? ""
            let detail = String(rawDetail.prefix(500))
            let suffix = type == "phase_end" ? "已核对" : ""
            taskProgressText = [label + suffix, detail].filter { !$0.isEmpty }.joined(separator: " · ")
            statusText = type == "phase_start" ? "正在执行\(label)" : "\(label)已完成，继续处理…"
            return true

        case "generation_applied":
            let requestedObj: WorkspaceJSONObject? = {
                if case let .object(gen)? = event["generation"], case let .object(req)? = gen["requested"] { return req }
                if case let .object(req)? = event["requested"] { return req }
                return nil
            }()
            if let requestedObj {
                let effortMap = ["default": "服务默认", "none": "关闭思考", "low": "低", "medium": "中", "high": "高", "xhigh": "更高", "max": "最高"]
                let effort = effortMap[stringField(requestedObj, "effort") ?? "default"] ?? "服务默认"
                let cap = intField(requestedObj, "maxOutputTokens").map { " · 总输出上限 \($0)" } ?? ""
                generationTooltip = "\(config.model) · 思考：\(effort)\(cap)"
            }
            return true

        case "step_commit":
            if let count = intField(event, "completedOperations") {
                statusText = "已提交 \(count) 项绘图操作，继续生成…"
            } else {
                statusText = "已提交一步，继续生成…"
            }
            return true

        case "usage":
            if let runIndex = activeRunIndex(for: event) {
                updateUsage(runIndex: runIndex, event: event)
            }
            return true

        case "external_idle":
            if let runIndex = activeRunIndex(for: event) {
                updateRun(at: runIndex) { run, _ in run.finished = true }
            }
            running = false
            stopRequested = false
            let failed = boolField(event, "isError") == true || boolField(event, "ok") == false || boolField(event, "success") == false
            if failed {
                let errText = WorkspaceAgentSanitizer.failureText(stringField(event, "error"), fallback: "", transientSecret: lastTransientSecret)
                statusText = errText.isEmpty ? "外部操作未完成" : "外部操作未完成 · \(errText)"
            } else {
                statusText = boolField(event, "taskCompleted") == true ? "外部任务已完成" : "外部操作已应用"
            }
            return true

        case "error":
            let msg = stringField(event, "message") ?? {
                if case let .object(errObj)? = event["error"] { return stringField(errObj, "message") }
                return nil
            }()
            errorMessage = WorkspaceAgentSanitizer.failureText(msg, fallback: "操作失败，请重试。", transientSecret: lastTransientSecret)
            if stringField(event, "code") == "SETUP_REQUIRED" {
                shouldOpenSettings = true
            }
            if boolField(event, "fatal") != false {
                running = false
                stopRequested = false
                statusText = "执行遇到问题，已完成内容保留"
            }
            return true

        case "run_end":
            guard let runIndex = activeRunIndex(for: event) else { return false }
            let statusStr = stringField(event, "status") ?? ""
            let reasonStr = stringField(event, "reason") ?? ""
            let stopped = ["stopped", "cancelled", "canceled", "aborted"].contains(statusStr)
            let setup = statusStr == "setup_required"
            let failed = ["failed", "error"].contains(statusStr) || setup
            let moreHint = (statusStr + " " + reasonStr).lowercased()
            let more = boolField(event, "canContinue") == true
                || moreHint.contains("max_turn") || moreHint.contains("max-turn")
                || moreHint.contains("limit") || moreHint.contains("needs_continue")
                || moreHint.contains("paused") || moreHint.contains("budget")
            var diagSuffix = ""
            updateRun(at: runIndex) { run, _ in
                run.finished = true
                run.status = statusStr
                run.reason = reasonStr
                for i in run.tools.indices where run.tools[i].state == .running {
                    run.tools[i].state = stopped ? .stopped : .failed
                    run.tools[i].summary = stopped ? "已停止" : "未完成"
                }
                for i in run.plan.indices where run.plan[i].status == .running {
                    run.plan[i] = WorkspacePublicPlanStep(text: run.plan[i].text, status: .pending)
                }
                if reasonStr == "no_progress", let code = run.lastDiagnosticCode, !code.isEmpty {
                    diagSuffix = " · 最近错误：\(code)"
                }
            }
            updateUsage(runIndex: runIndex, event: event)
            running = false
            pendingStart = false
            stopRequested = false
            canContinue = more
            if setup { shouldOpenSettings = true }
            let baseStatus = WorkspaceAgentSanitizer.runEndMessage(for: reasonStr)
                ?? (setup ? "请先配置模型"
                    : stopped ? "已停止，已完成内容保留"
                    : failed ? "执行结束，部分操作未完成"
                    : more ? "可从当前进度继续" : "已完成")
            statusText = baseStatus + diagSuffix
            return true

        default:
            return false
        }
    }

    private func startRun(_ event: WorkspaceJSONObject) -> Bool {
        localSerial += 1
        let id = stringField(event, "runId") ?? stringField(event, "id") ?? "local-run-\(localSerial)"
        if ignoredRunIds.contains(id) { return false }
        if let existingIdx = timeline.firstIndex(where: {
            if case .runTurn(let run, _) = $0 { return run.id == id }
            return false
        }) {
            if case .runTurn(let run, _) = timeline[existingIdx], run.id == currentRunId, !run.finished {
                return true
            }
            return false
        }
        errorMessage = nil
        canContinue = false
        let external = boolField(event, "external") == true
        let clientName = stringField(event, "clientName") ?? "MCP"
        let run = WorkspacePublicRun(id: id, external: external, clientName: external ? clientName : nil)
        timeline.append(.runTurn(run, messages: []))
        currentRunId = id
        running = true
        stopRequested = false
        if external {
            statusText = "外部助手正在操作画布…"
            elapsedSeconds = nil
            transportProgressText = nil
        } else if let attempt = intField(event, "recoveryAttempt") {
            statusText = "正在从断点续跑（\(attempt)/2）"
            updateTransportProgress(["elapsedMs": .number(0), "receivedBytes": .number(0), "phase": .string("processing")])
        } else {
            statusText = "正在处理…"
            updateTransportProgress(["elapsedMs": .number(0), "receivedBytes": .number(0), "phase": .string("processing")])
        }
        usageSummary = ""
        usageDetailTooltip = ""
        return true
    }

    private func activeRunIndex(for event: WorkspaceJSONObject) -> Int? {
        if let eventRunId = stringField(event, "runId") {
            if ignoredRunIds.contains(eventRunId) { return nil }
            if let currentRunId, eventRunId != currentRunId { return nil }
            if let idx = timeline.lastIndex(where: {
                if case .runTurn(let run, _) = $0 { return run.id == eventRunId && !run.finished }
                return false
            }) {
                return idx
            }
            if running && startRun(["runId": .string(eventRunId)]) {
                return timeline.indices.last
            }
            return nil
        }
        guard let currentRunId else { return nil }
        return timeline.lastIndex(where: {
            if case .runTurn(let run, _) = $0 { return run.id == currentRunId && !run.finished }
            return false
        })
    }

    private func updateRun(at index: Int, _ body: (inout WorkspacePublicRun, inout [WorkspacePublicMessage]) -> Void) {
        guard index >= 0, index < timeline.count,
              case .runTurn(var run, var messages) = timeline[index] else {
            return
        }
        body(&run, &messages)
        timeline[index] = .runTurn(run, messages: messages)
    }

    private func ensureAssistantMessage(runIndex: Int, messageId: String) {
        updateRun(at: runIndex) { run, messages in
            if !messages.contains(where: { $0.id == messageId }) {
                messages.append(WorkspacePublicMessage(id: messageId, runId: run.id, role: .assistant, text: "", renderedHtml: nil, createdAt: nil))
            }
        }
    }

    private func appendAssistantDelta(runIndex: Int, messageId: String?, delta: String, renderedHtml: String?) {
        updateRun(at: runIndex) { run, messages in
            let resolvedId: String
            if let messageId, !messageId.isEmpty {
                resolvedId = messageId
            } else if let existing = messages.last?.id {
                resolvedId = existing
            } else {
                localSerial += 1
                resolvedId = "assistant-\(localSerial)"
            }
            if let idx = messages.firstIndex(where: { $0.id == resolvedId }) {
                messages[idx].text += delta
                if let renderedHtml { messages[idx].renderedHtml = renderedHtml }
            } else {
                messages.append(WorkspacePublicMessage(id: resolvedId, runId: run.id, role: .assistant, text: delta, renderedHtml: renderedHtml, createdAt: nil))
            }
        }
    }

    private func ensureToolIndex(in run: inout WorkspacePublicRun, id: String, name: String?, explicitLabel: String?) -> Int {
        if let idx = run.tools.firstIndex(where: { $0.id == id }) {
            return idx
        }
        let label = (explicitLabel?.isEmpty == false ? explicitLabel! : WorkspaceAgentSanitizer.toolDisplayLabel(name: name))
        run.tools.append(WorkspacePublicToolCall(id: id, name: name, label: label, state: .running, summary: "", changes: [], diagnostic: nil))
        return run.tools.count - 1
    }

    private func parseChanges(_ arr: [WorkspaceJSONValue]) -> [String] {
        arr.compactMap { item in
            switch item {
            case .string(let s): return s.isEmpty ? nil : s
            case .object(let obj):
                return stringField(obj, "text") ?? stringField(obj, "label") ?? stringField(obj, "summary")
            default:
                return nil
            }
        }
    }

    private func updateTransportProgress(_ event: WorkspaceJSONObject) {
        let bytes = max(0.0, numberField(event, "receivedBytes") ?? 0.0)
        let seconds = max(0, Int(floor((numberField(event, "elapsedMs") ?? 0.0) / 1000.0)))
        let sizeText: String
        if bytes < 1024 {
            sizeText = "\(Int(bytes)) B"
        } else if bytes < 1024 * 1024 {
            sizeText = String(format: "%.1f KB", bytes / 1024.0)
        } else {
            sizeText = String(format: "%.1f MB", bytes / (1024.0 * 1024.0))
        }
        let phase = stringField(event, "phase") ?? ""
        let isFinal = boolField(event, "final") == true
        var stateLabel: String
        if isFinal { stateLabel = "接收已结束" }
        else if phase == "receiving" { stateLabel = "持续接收中" }
        else if phase == "waiting_first_byte" { stateLabel = "等待本次首批数据" }
        else if phase == "waiting" { stateLabel = "等待新数据" }
        else if bytes > 0 { stateLabel = "正在处理已接收内容" }
        else { stateLabel = "正在准备模型请求" }
        if phase == "waiting", let agoMs = numberField(event, "lastByteAgoMs") {
            stateLabel += "（\(Int(floor(agoMs / 1000.0)))秒无新数据）"
        }
        elapsedSeconds = seconds
        let prefix = bytes > 0 ? "已接收 \(sizeText)" : (isFinal ? "未收到模型数据" : "尚未收到模型数据")
        transportProgressText = "\(prefix) · \(stateLabel)"
    }

    private func updateUsage(runIndex: Int, event: WorkspaceJSONObject) {
        let usageObj: WorkspaceJSONObject = {
            if case let .object(u)? = event["usage"] { return u }
            return event
        }()
        let reqs = intField(event, "requests") ?? intField(event, "turns")
        let totalTokens: Int? = intField(usageObj, "totalTokens") ?? {
            if let i = intField(usageObj, "inputTokens"), let o = intField(usageObj, "outputTokens") {
                return i + o
            }
            return nil
        }()
        let httpReqs = intField(event, "httpRequests")

        updateRun(at: runIndex) { run, _ in
            if let reqs { run.requests = max(0, reqs) }
            if let totalTokens { run.tokens = max(0, totalTokens) }
            var parts: [String] = []
            if run.requests > 0 {
                parts.append("\(run.requests)" + (httpReqs == nil ? " 次请求" : " 轮"))
            }
            if let tok = run.tokens {
                parts.append("\(tok) tokens")
            }
            usageSummary = parts.joined(separator: " · ")
        }
        if let httpReqs {
            var details = ["\(httpReqs) 次本机请求"]
            if let retries = intField(event, "transportRetries"), retries > 0 {
                details.append("\(retries) 次重连")
            }
            if let input = intField(usageObj, "input"), input > 0 { details.append("未缓存输入 \(input)") }
            if let cacheRead = intField(usageObj, "cacheRead"), cacheRead > 0 { details.append("缓存读取 \(cacheRead)") }
            if let output = intField(usageObj, "output"), output > 0 { details.append("输出 \(output)") }
            if let reasoning = intField(usageObj, "reasoning"), reasoning > 0 { details.append("其中思考 \(reasoning)") }
            usageDetailTooltip = details.joined(separator: " · ")
        } else {
            usageDetailTooltip = ""
        }
    }

    private func formatCheckpoint(_ cp: WorkspacePublicTaskCheckpoint) -> String? {
        let phases = cp.phases ?? []
        let completed = phases.filter { $0.status == "completed" }.count
        var parts: [String] = []
        if let goal = cp.goal, !goal.isEmpty { parts.append(String(goal.prefix(240))) }
        if !phases.isEmpty { parts.append("阶段 \(completed)/\(phases.count) 已完成") }
        if cp.status != "completed", let idx = cp.phaseIndex, idx >= 0, idx < phases.count,
           let obj = phases[idx].objective, !obj.isEmpty {
            parts.append(String(obj.prefix(240)))
        }
        if cp.status == "completed" { parts.append("任务已完成") }
        let text = parts.joined(separator: " · ")
        return text.isEmpty ? nil : text
    }
}

// MARK: - Workspace State Coordinator (Epoch Fence, Ordered Channel, Surface Gating)

final class WorkspaceStateCoordinator {
    private final class WeakObserver {
        weak var target: AnyObject?
        let callback: () -> Void
        init(target: AnyObject, callback: @escaping () -> Void) {
            self.target = target
            self.callback = callback
        }
    }

    private let bridge: WorkspaceNativeUIBridging
    let agentStore = WorkspaceAgentStore()

    private(set) var navigationGeneration = 0
    private(set) var attachedEpoch: WorkspaceEpoch?
    private(set) var ownedSurfaces: Set<WorkspaceSurface> = []
    private(set) var lastSequence = -1
    private(set) var uiState: WorkspaceUIState = .disabledInitial()
    private(set) var documentMetadata: WorkspaceDocumentMetadata = .empty
    private(set) var hostContext: WorkspaceHostContext = .initial

    var fileCallbacks: WorkspaceFileServiceCallbacks
    /// Called immediately before invoking Swift file/navigation gates to cancel uncommitted slider/text edits.
    var onBeforeFileCommand: (() -> Void)?
    /// Optional non-text toolbar focus return hook (never steals focus from active native text input).
    var onReturnFocusToCanvas: (() -> Void)?

    private var layoutRevision = 0
    private var attachToken = 0
    private(set) var isAttaching = false
    private var bufferedMessages: [WorkspaceNativeUIMessage] = []
    private let maxBufferedMessages = 256
    private var inFlightMutationRequestIds = Set<String>()
    private var observers: [WeakObserver] = []

    init(
        bridge: WorkspaceNativeUIBridging,
        fileCallbacks: WorkspaceFileServiceCallbacks = WorkspaceFileServiceCallbacks(),
        documentMetadata: WorkspaceDocumentMetadata = .empty
    ) {
        self.bridge = bridge
        self.fileCallbacks = fileCallbacks
        self.documentMetadata = documentMetadata
        self.agentStore.onChange = { [weak self] in
            self?.notifyObservers()
        }
    }

    func addObserver(_ target: AnyObject, callback: @escaping () -> Void) {
        observers.removeAll { $0.target == nil }
        observers.append(WeakObserver(target: target, callback: callback))
    }

    func notifyObservers() {
        observers.removeAll { $0.target == nil }
        for obs in observers {
            obs.callback()
        }
    }

    // MARK: Capability & Surface Gating

    var isAttached: Bool { attachedEpoch != nil }

    func ownsSurface(_ surface: WorkspaceSurface) -> Bool {
        attachedEpoch != nil && ownedSurfaces.contains(surface)
    }

    func isCommandSupported(_ commandId: String) -> Bool {
        uiState.supported.commands.contains(commandId)
    }

    func isCanvasSurfaceReady(_ surface: WorkspaceSurface) -> Bool {
        ownsSurface(surface) && uiState.ready.canvas && !documentMetadata.isNavigationInFlight
    }

    var hasOwnedCanvasEditingSurface: Bool {
        isCanvasSurfaceReady(.toolPalette) || isCanvasSurfaceReady(.inspector)
    }

    func isAgentSurfaceReady() -> Bool {
        ownsSurface(.agent) && uiState.ready.agent && !documentMetadata.isNavigationInFlight
    }

    func isToolSupported(_ toolId: String) -> Bool {
        isCanvasSurfaceReady(.toolPalette)
            && isCommandSupported("tool.set")
            && uiState.supported.toolIds.contains(toolId)
    }

    func isElementSupported(_ symbol: String) -> Bool {
        isCanvasSurfaceReady(.inspector)
            && isCommandSupported("element.set")
            && uiState.supported.elementSymbols.contains(symbol)
    }

    func isTemplateSupported(_ templateId: String) -> Bool {
        let readyForToolOrInspector = isCanvasSurfaceReady(.inspector) || isCanvasSurfaceReady(.toolPalette)
        return readyForToolOrInspector
            && isCommandSupported("template.set")
            && uiState.supported.templateIds.contains(templateId)
    }

    // MARK: Document Metadata Injection (Host-Owned)

    func updateDocumentMetadata(_ metadata: WorkspaceDocumentMetadata) {
        guard metadata != documentMetadata else { return }
        documentMetadata = metadata
        notifyObservers()
    }

    func cancelPendingLocalEdits() {
        onBeforeFileCommand?()
    }

    func performFileAction(_ action: (() -> Void)?) {
        guard let action else { return }
        cancelPendingLocalEdits()
        action()
    }

    func canPerformCanvasClipboardAction(_ action: WorkspaceCanvasClipboardAction) -> Bool {
        guard !documentMetadata.isNavigationInFlight else {
            return false
        }
        if let customCheck = fileCallbacks.canPerformCanvasClipboardAction {
            return customCheck(action)
        }
        return fileCallbacks.onCanvasClipboardAction != nil
    }

    @discardableResult
    func performCanvasClipboardAction(_ action: WorkspaceCanvasClipboardAction, sender: Any? = nil) -> Bool {
        guard canPerformCanvasClipboardAction(action),
              let handler = fileCallbacks.onCanvasClipboardAction else {
            return false
        }
        cancelPendingLocalEdits()
        return handler(action, sender)
    }

    func canPerformLegacyCanvasEditAction(_ action: WorkspaceLegacyCanvasEditAction) -> Bool {
        guard !documentMetadata.isNavigationInFlight else {
            return false
        }
        if let customCheck = fileCallbacks.canPerformLegacyCanvasEditAction {
            return customCheck(action)
        }
        return fileCallbacks.onLegacyCanvasEditAction != nil
    }

    @discardableResult
    func performLegacyCanvasEditAction(_ action: WorkspaceLegacyCanvasEditAction, sender: Any? = nil) -> Bool {
        guard canPerformLegacyCanvasEditAction(action),
              let handler = fileCallbacks.onLegacyCanvasEditAction else {
            return false
        }
        cancelPendingLocalEdits()
        return handler(action, sender)
    }

    // MARK: Navigation & Epoch Lifecycle

    /// Immediately invalidates the previous epoch and resets controls to disabled until the new page attaches.
    func beginNavigation(generation: Int) {
        let previousEpoch = attachedEpoch
        navigationGeneration = generation
        attachToken += 1
        isAttaching = false
        attachedEpoch = nil
        ownedSurfaces.removeAll()
        lastSequence = -1
        bufferedMessages.removeAll()
        inFlightMutationRequestIds.removeAll()
        documentMetadata.isNavigationInFlight = true
        uiState = .disabledInitial(epoch: WorkspaceEpoch(navigationGeneration: generation, pageId: ""))
        cancelPendingLocalEdits()
        agentStore.resetForNewEpoch()
        if let previousEpoch {
            bridge.detach(epoch: previousEpoch)
        }
        notifyObservers()
    }

    func detachCurrentEpoch() {
        guard let epoch = attachedEpoch else { return }
        attachToken += 1
        isAttaching = false
        attachedEpoch = nil
        ownedSurfaces.removeAll()
        lastSequence = -1
        bufferedMessages.removeAll()
        inFlightMutationRequestIds.removeAll()
        uiState = .disabledInitial(epoch: WorkspaceEpoch(navigationGeneration: navigationGeneration, pageId: ""))
        agentStore.resetForNewEpoch()
        bridge.detach(epoch: epoch)
        notifyObservers()
    }

    /// Ignore an optional native attach whose reply failed or timed out.
    func abandonPendingAttach() {
        attachToken += 1
        isAttaching = false
        attachedEpoch = nil
        ownedSurfaces.removeAll()
        bufferedMessages.removeAll()
        notifyObservers()
    }

    func attach(
        preparedSurfaces: [WorkspaceSurface] = WorkspaceSurface.allCases,
        completion: ((Result<WorkspaceAttachReply, Error>) -> Void)? = nil
    ) {
        let gen = navigationGeneration
        attachToken += 1
        let currentToken = attachToken
        isAttaching = true

        let options = WorkspaceAttachOptions(
            navigationGeneration: gen,
            nativeSurfaces: preparedSurfaces,
            host: hostContext
        )

        bridge.attach(options: options) { [weak self] result in
            guard let self else { return }
            guard gen == self.navigationGeneration, currentToken == self.attachToken else {
                return
            }
            self.isAttaching = false

            switch result {
            case .failure(let error):
                self.attachedEpoch = nil
                self.ownedSurfaces.removeAll()
                self.bufferedMessages.removeAll()
                self.notifyObservers()
                completion?(.failure(error))

            case .success(let reply):
                guard reply.ok, let epoch = reply.epoch, epoch.navigationGeneration == gen else {
                    self.attachedEpoch = nil
                    self.ownedSurfaces.removeAll()
                    self.bufferedMessages.removeAll()
                    self.notifyObservers()
                    completion?(.success(reply))
                    return
                }
                self.attachedEpoch = epoch
                self.documentMetadata.isNavigationInFlight = false
                self.ownedSurfaces = Set(reply.ownedSurfaces).intersection(Set(preparedSurfaces))
                self.lastSequence = reply.sequence ?? 0
                if let initialState = reply.state, initialState.epoch == epoch {
                    self.applyUIState(initialState)
                }
                self.replayBufferedMessages(for: epoch)
                self.notifyObservers()
                self.sendHostContextIfAttached()
                completion?(.success(reply))
            }
        }
    }

    // MARK: Single Ordered Channel Ingestion

    func receiveRawScriptMessage(_ body: [String: Any]) -> Bool {
        guard let msg = WorkspaceContractCodec.decodeMessage(from: body) else {
            return false
        }
        return receiveMessage(msg)
    }

    @discardableResult
    func receiveMessage(_ message: WorkspaceNativeUIMessage) -> Bool {
        guard message.protocol == workspaceNativeUIProtocolVersion else { return false }

        if attachedEpoch == nil {
            guard isAttaching, message.epoch.navigationGeneration == navigationGeneration else {
                return false
            }
            if bufferedMessages.count >= maxBufferedMessages {
                bufferedMessages.removeFirst()
            }
            bufferedMessages.append(message)
            return true
        }

        guard let epoch = attachedEpoch,
              message.epoch == epoch,
              message.sequence > lastSequence else {
            return false
        }

        lastSequence = message.sequence
        applyMessagePayload(message.kind, expectedEpoch: epoch)
        return true
    }

    private func replayBufferedMessages(for epoch: WorkspaceEpoch) {
        let matching = bufferedMessages
            .filter { $0.epoch == epoch && $0.sequence > lastSequence }
            .sorted { $0.sequence < $1.sequence }
        bufferedMessages.removeAll()
        for msg in matching where msg.sequence > lastSequence {
            lastSequence = msg.sequence
            applyMessagePayload(msg.kind, expectedEpoch: epoch)
        }
    }

    private func applyMessagePayload(_ kind: WorkspaceNativeUIMessageKind, expectedEpoch: WorkspaceEpoch) {
        switch kind {
        case .state(let nextState):
            guard nextState.epoch == expectedEpoch, nextState.revision >= uiState.revision else {
                return
            }
            applyUIState(nextState)
            notifyObservers()

        case .agent(let presentation):
            _ = agentStore.apply(presentation)
        }
    }

    private func applyUIState(_ nextState: WorkspaceUIState) {
        uiState = nextState
        agentStore.syncAgentSummary(nextState.agent)
    }

    // MARK: Host Context & Viewport Geometry

    func updateHostFocus(windowKey: Bool? = nil, focusOwner: WorkspaceFocusOwner? = nil, inspectorVisible: Bool? = nil) {
        var next = hostContext
        if let windowKey { next.windowKey = windowKey }
        if let focusOwner { next.focusOwner = focusOwner }
        if let inspectorVisible { next.inspectorVisible = inspectorVisible }
        guard next != hostContext else { return }
        hostContext = next
        sendHostContextIfAttached()
    }

    func updateHostViewport(cssSize: WorkspaceCSSSize, safeAreaInsets: WorkspaceEdgeInsets, overlays: [WorkspaceOverlayRect]) {
        if let prev = hostContext.viewport,
           prev.cssSize == cssSize && prev.safeAreaInsets == safeAreaInsets && prev.overlays == overlays {
            return
        }
        layoutRevision += 1
        hostContext.viewport = WorkspaceHostViewport(
            layoutRevision: layoutRevision,
            cssSize: cssSize,
            safeAreaInsets: safeAreaInsets,
            overlays: overlays
        )
        sendHostContextIfAttached()
    }

    private func sendHostContextIfAttached() {
        guard let epoch = attachedEpoch else { return }
        guard let hostDict = WorkspaceContractCodec.foundationDictionary(from: hostContext),
              case let .object(args)? = WorkspaceJSONValue.from(foundation: hostDict) else {
            return
        }
        let command = WorkspaceCommand(epoch: epoch, id: "host.context", args: args)
        bridge.dispatch(command: command) { _ in }
    }

    // MARK: Command Dispatch (Strict Epoch, RequestId, Revision, No Auto-Retry)

    func dispatchCommand(
        id: String,
        args: WorkspaceJSONObject? = nil,
        expectedSelectionRevision: Int? = nil,
        requestId: String = UUID().uuidString,
        completion: ((Result<WorkspaceCommandReply, Error>) -> Void)? = nil
    ) {
        guard let epoch = attachedEpoch else {
            let reply = WorkspaceCommandReply(
                epoch: nil,
                requestId: requestId,
                ok: false,
                error: WorkspaceCommandError(code: "not_ready", message: "Bridge not attached")
            )
            completion?(.success(reply))
            return
        }

        if id != "host.context" && !isCommandAllowedByReadyAndSupport(id: id) {
            let code = isCommandSupported(id) ? "not_ready" : "unsupported"
            let reply = WorkspaceCommandReply(
                epoch: epoch,
                requestId: requestId,
                ok: false,
                error: WorkspaceCommandError(code: code, message: "Command \(id) is \(code)")
            )
            completion?(.success(reply))
            return
        }

        let requiresSelectionRevision = id.hasPrefix("selection.")
        if requiresSelectionRevision && expectedSelectionRevision == nil {
            let reply = WorkspaceCommandReply(
                epoch: epoch,
                requestId: requestId,
                ok: false,
                error: WorkspaceCommandError(code: "invalid_arguments", message: "Missing expectedSelectionRevision")
            )
            completion?(.success(reply))
            return
        }

        guard !requestId.isEmpty, !inFlightMutationRequestIds.contains(requestId) else {
            let reply = WorkspaceCommandReply(
                epoch: epoch,
                requestId: requestId,
                ok: false,
                error: WorkspaceCommandError(code: "failed", message: "Duplicate or empty requestId rejected")
            )
            completion?(.success(reply))
            return
        }
        inFlightMutationRequestIds.insert(requestId)

        let command = WorkspaceCommand(
            epoch: epoch,
            requestId: requestId,
            id: id,
            args: args,
            expectedSelectionRevision: expectedSelectionRevision
        )

        bridge.dispatch(command: command) { [weak self] result in
            guard let self else { return }
            self.inFlightMutationRequestIds.remove(requestId)
            // Drop replies belonging to invalidated epochs. 但不能无声丢：completion 里
            // 可能挂着唯一一次清理（如 agent.settings.save 的 defer 清明文 API key，
            // 见 noteTransientSecret）。被丢弃时在这里补清，避免明文滞留
            // lastTransientSecret（S2）。不向旧 epoch 回注合成错误——通用 dispatch 的
            // completion（agent.send 等）会把失败显示到新文档界面上，噪声大于收益。
            if self.attachedEpoch != epoch {
                self.agentStore.clearTransientSecret()
                return
            }
            if case .success(let reply) = result {
                // 回复携带了别的 epoch：协议异常且请求已消费、completion 必然被丢，同样补清。
                if let replyEpoch = reply.epoch, replyEpoch != epoch {
                    self.agentStore.clearTransientSecret()
                    return
                }
                // requestId 不匹配：本请求的正确回复可能稍后仍会到达，不提前清理。
                if reply.requestId != requestId { return }
            }
            completion?(result)
        }
    }

    private func isCommandAllowedByReadyAndSupport(id: String) -> Bool {
        if id.hasPrefix("agent.") {
            if id == "agent.settings.load" || id == "agent.settings.save" || id == "agent.stop" {
                return ownsSurface(.agent) && isCommandSupported(id)
            }
            return isAgentSurfaceReady() && isCommandSupported(id)
        }
        return attachedEpoch != nil && uiState.ready.canvas && isCommandSupported(id)
    }

    // MARK: Semantic Convenience Dispatchers

    func selectTool(id: String, completion: ((Result<WorkspaceCommandReply, Error>) -> Void)? = nil) {
        guard isToolSupported(id) else { return }
        // Radical is a persistent click-to-toggle tool (choose-function-first);
        // it no longer consumes a selection revision snapshot.
        dispatchCommand(id: "tool.set", args: ["id": .string(id)], completion: completion)
    }

    func selectElement(symbol: String, completion: ((Result<WorkspaceCommandReply, Error>) -> Void)? = nil) {
        guard isElementSupported(symbol) else { return }
        dispatchCommand(id: "element.set", args: ["symbol": .string(symbol)], completion: completion)
    }

    func selectTemplate(id: String, completion: ((Result<WorkspaceCommandReply, Error>) -> Void)? = nil) {
        guard isTemplateSupported(id) else { return }
        dispatchCommand(id: "template.set", args: ["id": .string(id)], completion: completion)
    }

    func zoomBy(factor: Double, anchorCSSPoint: CGPoint? = nil) {
        guard isCanvasSurfaceReady(.zoomPalette), isCommandSupported("zoom.by") else { return }
        var args: WorkspaceJSONObject = ["factor": .number(factor)]
        if let anchorCSSPoint {
            args["anchor"] = .object(["x": .number(Double(anchorCSSPoint.x)), "y": .number(Double(anchorCSSPoint.y))])
        }
        dispatchCommand(id: "zoom.by", args: args)
    }

    func zoomToPercent(_ percent: Double) {
        guard isCanvasSurfaceReady(.zoomPalette), isCommandSupported("zoom.toPercent") else { return }
        dispatchCommand(id: "zoom.toPercent", args: ["percent": .number(percent)])
    }

    func zoomFit(target: String) {
        guard isCanvasSurfaceReady(.zoomPalette), isCommandSupported("zoom.fit") else { return }
        dispatchCommand(id: "zoom.fit", args: ["target": .string(target)])
    }

    func commitSelectionProperty(
        propertyId: String,
        value: WorkspaceSelectionProperty.PropertyValue,
        expectedSelectionRevision: Int,
        editId: String = UUID().uuidString,
        completion: ((Result<WorkspaceCommandReply, Error>) -> Void)? = nil
    ) {
        guard isCanvasSurfaceReady(.inspector), isCommandSupported("selection.setProperty") else { return }
        guard expectedSelectionRevision == uiState.selection.revision else {
            let reply = WorkspaceCommandReply(
                epoch: attachedEpoch,
                requestId: UUID().uuidString,
                ok: false,
                error: WorkspaceCommandError(code: "stale_selection", message: "Selection revision changed before commit")
            )
            completion?(.success(reply))
            return
        }
        let valJSON: WorkspaceJSONValue = {
            switch value {
            case .number(let n): return .number(n)
            case .string(let s): return .string(s)
            }
        }()
        let args: WorkspaceJSONObject = [
            "propertyId": .string(propertyId),
            "value": valJSON,
            "editId": .string(editId),
        ]
        dispatchCommand(
            id: "selection.setProperty",
            args: args,
            expectedSelectionRevision: expectedSelectionRevision,
            completion: completion
        )
    }

    func replanSelection(expectedSelectionRevision: Int) {
        guard isCanvasSurfaceReady(.inspector), isCommandSupported("selection.replan") else { return }
        dispatchCommand(id: "selection.replan", expectedSelectionRevision: expectedSelectionRevision)
    }

    func toggleBondComponent(expectedSelectionRevision: Int) {
        guard isCanvasSurfaceReady(.inspector), isCommandSupported("selection.toggleBondComponent") else { return }
        dispatchCommand(id: "selection.toggleBondComponent", expectedSelectionRevision: expectedSelectionRevision)
    }

    func sendAgentMessage(_ text: String, completion: ((Bool) -> Void)? = nil) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty,
              isAgentSurfaceReady(),
              isCommandSupported("agent.send"),
              !uiState.agent.running,
              !uiState.agent.pendingStart else {
            completion?(false)
            return
        }
        dispatchCommand(id: "agent.send", args: ["text": .string(trimmed)]) { [weak self] result in
            switch result {
            case .success(let reply):
                if !reply.ok, let msg = reply.error?.message {
                    self?.agentStore.showPublicError(msg)
                }
                completion?(reply.ok)
            case .failure(let error):
                self?.agentStore.showPublicError(error.localizedDescription)
                completion?(false)
            }
        }
    }

    func stopAgent() {
        guard ownsSurface(.agent), isCommandSupported("agent.stop") else { return }
        agentStore.markStopRequested()
        dispatchCommand(id: "agent.stop") { [weak self] result in
            if case .success(let reply) = result, !reply.ok {
                self?.agentStore.showPublicError(reply.error?.message)
            }
        }
    }

    func continueAgent() {
        guard isAgentSurfaceReady(),
              isCommandSupported("agent.continue"),
              !uiState.agent.running,
              !uiState.agent.pendingStart,
              uiState.agent.canContinue || agentStore.canContinue else {
            return
        }
        dispatchCommand(id: "agent.continue") { [weak self] result in
            if case .success(let reply) = result, !reply.ok {
                self?.agentStore.showPublicError(reply.error?.message)
            }
        }
    }

    func resetAgent() {
        guard isAgentSurfaceReady(),
              isCommandSupported("agent.reset"),
              !uiState.agent.running,
              !uiState.agent.pendingStart else {
            return
        }
        dispatchCommand(id: "agent.reset") { [weak self] result in
            if case .success(let reply) = result, !reply.ok {
                self?.agentStore.showPublicError(reply.error?.message)
            }
        }
    }

    func loadAgentSettings(completion: ((Result<WorkspacePublicConfig, Error>) -> Void)? = nil) {
        guard ownsSurface(.agent), isCommandSupported("agent.settings.load") else { return }
        dispatchCommand(id: "agent.settings.load") { [weak self] result in
            guard let self else { return }
            switch result {
            case .failure(let error):
                completion?(.failure(error))
            case .success(let reply):
                guard reply.ok else {
                    completion?(.failure(WorkspaceBridgeError.scriptError(reply.error?.message ?? "无法读取设置")))
                    return
                }
                let dict = (reply.result?["config"]?.foundationValue as? [String: Any])
                    ?? reply.result?.mapValues(\.foundationValue)
                    ?? [:]
                if let config = WorkspaceContractCodec.decode(WorkspacePublicConfig.self, from: dict) {
                    self.agentStore.applyPublicConfig(config)
                    completion?(.success(config))
                } else {
                    completion?(.failure(WorkspaceBridgeError.invalidReply))
                }
            }
        }
    }

    func saveAgentSettings(_ request: WorkspaceSettingsSaveRequest, completion: ((Result<(config: WorkspacePublicConfig?, notice: String?), Error>) -> Void)? = nil) {
        guard ownsSurface(.agent),
              isCommandSupported("agent.settings.save"),
              !uiState.agent.running,
              !uiState.agent.settingsBusy else {
            return
        }
        agentStore.noteTransientSecret(request.apiKey)
        dispatchCommand(id: "agent.settings.save", args: request.toCommandArgs()) { [weak self] result in
            guard let self else { return }
            defer { self.agentStore.clearTransientSecret() }
            switch result {
            case .failure(let error):
                let safeMsg = WorkspaceAgentSanitizer.failureText(error.localizedDescription, fallback: "设置未保存，请重试。", transientSecret: request.apiKey)
                completion?(.failure(WorkspaceBridgeError.scriptError(safeMsg)))
            case .success(let reply):
                guard reply.ok else {
                    let safeMsg = WorkspaceAgentSanitizer.failureText(reply.error?.message, fallback: "设置未保存，请重试。", transientSecret: request.apiKey)
                    completion?(.failure(WorkspaceBridgeError.scriptError(safeMsg)))
                    return
                }
                let rawResult = reply.result?.mapValues(\.foundationValue) ?? [:]
                let configDict = (rawResult["config"] as? [String: Any]) ?? rawResult
                let parsedConfig = WorkspaceContractCodec.decode(WorkspacePublicConfig.self, from: configDict)
                if let parsedConfig {
                    self.agentStore.applyPublicConfig(parsedConfig)
                }
                let notice = (rawResult["notice"] as? String) ?? parsedConfig?.notice
                completion?(.success((parsedConfig, notice)))
            }
        }
    }
}

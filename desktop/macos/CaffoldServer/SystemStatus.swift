import Foundation

enum IntegrationState: Equatable {
    case checking
    case ready
    case notInstalled
    case attention
    case unavailable
}

struct IntegrationDetail {
    let label: String
    let value: String
}

struct IntegrationStatus {
    let name: String
    let state: IntegrationState
    let status: String
    let details: [IntegrationDetail]

    static func checking(_ name: String) -> Self {
        Self(name: name, state: .checking, status: "Checking...", details: [])
    }
}

/// What every Task request, the agent list included, answers while the server
/// is still preparing its Task store.
private struct TaskStoreRefusal: Decodable {
    struct Detail: Decodable {
        let code: String
    }

    let error: Detail
}

struct VoiceStatusResponse: Decodable {
    let provider: String
    let ready: Bool
    let maxRecordingSeconds: Int
}

private struct GithubStatusResponse: Decodable {
    struct Account: Decodable {
        let state: String
        let error: String?
        let active: Bool
        let host: String
        let login: String
        let gitProtocol: String?
    }

    let hosts: [String: [Account]]
}

func probeGitStatus(completion: @escaping (IntegrationStatus) -> Void) {
    guard let git = caffoldExecutable(named: "git") else {
        completion(IntegrationStatus(
            name: "Git",
            state: .unavailable,
            status: "Not installed",
            details: []
        ))
        return
    }
    runCommand(executable: git, arguments: ["--version"]) { result in
        switch result {
        case let .success(command) where command.status == 0:
            let version = command.output.replacingOccurrences(of: "git version ", with: "")
            completion(IntegrationStatus(
                name: "Git",
                state: .ready,
                status: "Ready",
                details: [IntegrationDetail(label: "Version", value: version)]
            ))
        case .success, .failure:
            completion(IntegrationStatus(
                name: "Git",
                state: .unavailable,
                status: "Unavailable",
                details: []
            ))
        }
    }
}

func probeGithubStatus(completion: @escaping (IntegrationStatus) -> Void) {
    guard let gh = caffoldExecutable(named: "gh") else {
        completion(IntegrationStatus(
            name: "GitHub CLI",
            state: .unavailable,
            status: "Not installed",
            details: []
        ))
        return
    }
    var environment = caffoldEnvironment()
    // These force gh to color its output even into a pipe, which corrupts the
    // JSON. An app opened from a color-forcing shell inherits them.
    environment["CLICOLOR_FORCE"] = nil
    environment["GH_FORCE_TTY"] = nil
    runCommand(
        executable: gh,
        arguments: ["auth", "status", "--hostname", "github.com", "--json", "hosts"],
        environment: environment
    ) { result in
        guard
            case let .success(command) = result,
            let data = command.output.data(using: .utf8),
            let response = try? JSONDecoder().decode(GithubStatusResponse.self, from: data),
            let account = response.hosts["github.com"]?.first(where: \.active)
                ?? response.hosts["github.com"]?.first
        else {
            completion(IntegrationStatus(
                name: "GitHub CLI",
                state: .unavailable,
                status: "Unavailable",
                details: []
            ))
            return
        }

        let ready = account.state == "success"
        let error = account.error?.lowercased() ?? ""
        let needsAuthentication = error.contains("auth")
            || error.contains("login")
            || error.contains("token")
        completion(IntegrationStatus(
            name: "GitHub CLI",
            state: ready ? .ready : needsAuthentication ? .attention : .unavailable,
            status: ready ? "Ready" : needsAuthentication ? "Sign-in required" : "Unavailable",
            details: [
                IntegrationDetail(label: "Account", value: account.login),
                IntegrationDetail(label: "Host", value: account.host),
            ]
        ))
    }
}

private struct AgentInstallationsResponse: Decodable {
    struct Agent: Decodable {
        enum State: String, Decodable {
            case ready
            case notInstalled
            case unavailable
        }

        let provider: String
        let name: String
        let state: State
        let version: String?
    }

    let agents: [Agent]
}

/// One row of the Agents section, and the agent whose Settings page it opens.
struct AgentStatus {
    let provider: String
    let status: IntegrationStatus
}

/// The server's list of agents, or why it gave none.
enum AgentStatusAnswer {
    case agents([AgentStatus])
    case unanswered(IntegrationState, String)
}

/// What the Agents section shows.
///
/// Until the server has listed its agents there are no rows, only a line
/// saying why. A list once received stays: an answer without one changes the
/// status of each row it already has, so the section does not shrink and grow
/// as the server comes and goes.
enum AgentSection {
    case waiting(String)
    case agents([AgentStatus])
}

func agentSection(after answer: AgentStatusAnswer, showing section: AgentSection) -> AgentSection {
    switch (answer, section) {
    case let (.agents(agents), _):
        return .agents(agents)
    case let (.unanswered(state, status), .agents(shown)):
        return .agents(shown.map { agent in
            AgentStatus(
                provider: agent.provider,
                status: IntegrationStatus(
                    name: agent.status.name,
                    state: state,
                    status: status,
                    details: []
                )
            )
        })
    case let (.unanswered(_, status), .waiting):
        return .waiting(status)
    }
}

func probeAgentStatus(
    url: URL,
    session: URLSession = .shared,
    completion: @escaping (AgentStatusAnswer) -> Void
) {
    var request = URLRequest(url: url)
    request.timeoutInterval = 4
    session.dataTask(with: request) { data, response, _ in
        let answer: AgentStatusAnswer
        if
            let response = response as? HTTPURLResponse,
            response.statusCode == 200,
            let data,
            let listed = try? JSONDecoder().decode(AgentInstallationsResponse.self, from: data)
        {
            answer = .agents(listed.agents.map { agent in
                let (state, status): (IntegrationState, String) = switch agent.state {
                case .ready: (.ready, "Ready")
                case .notInstalled: (.notInstalled, "Not installed")
                case .unavailable: (.unavailable, "Unavailable")
                }
                return AgentStatus(
                    provider: agent.provider,
                    status: IntegrationStatus(
                        name: agent.name,
                        state: state,
                        status: status,
                        details: agent.version.map {
                            [IntegrationDetail(label: "Version", value: $0)]
                        } ?? []
                    )
                )
            })
        } else if
            let response = response as? HTTPURLResponse,
            response.statusCode == 503,
            let data,
            let refusal = try? JSONDecoder().decode(TaskStoreRefusal.self, from: data),
            ["task_store_migration_pending", "task_store_migration_failed"]
                .contains(refusal.error.code)
        {
            answer = refusal.error.code == "task_store_migration_pending"
                ? .unanswered(.checking, "Preparing...")
                : .unanswered(.unavailable, "Unavailable")
        } else {
            answer = .unanswered(.unavailable, "Server unavailable")
        }
        DispatchQueue.main.async {
            completion(answer)
        }
    }.resume()
}

func voiceIntegrationStatus(_ response: VoiceStatusResponse) -> IntegrationStatus {
    IntegrationStatus(
        name: "Voice",
        state: response.ready ? .ready : .attention,
        status: response.ready ? "Ready" : "Setup required",
        details: [
            IntegrationDetail(label: "Provider", value: voiceProviderName(response.provider)),
            IntegrationDetail(
                label: "Limit",
                value: formatVoiceRecordingLimit(response.maxRecordingSeconds)
            ),
        ]
    )
}

func probeVoiceStatus(
    url: URL,
    session: URLSession = .shared,
    completion: @escaping (IntegrationStatus) -> Void
) {
    var request = URLRequest(url: url)
    request.timeoutInterval = 4
    session.dataTask(with: request) { data, response, _ in
        let statusResult: IntegrationStatus
        if
            let response = response as? HTTPURLResponse,
            response.statusCode == 200,
            let data,
            let voice = try? JSONDecoder().decode(VoiceStatusResponse.self, from: data)
        {
            statusResult = voiceIntegrationStatus(voice)
        } else {
            statusResult = IntegrationStatus(
                name: "Voice",
                state: .unavailable,
                status: "Server unavailable",
                details: []
            )
        }
        DispatchQueue.main.async {
            completion(statusResult)
        }
    }.resume()
}

private func voiceProviderName(_ provider: String) -> String {
    switch provider {
    case "whisper": return "Whisper"
    case "openai": return "OpenAI"
    case "gemini": return "Gemini"
    case "grok": return "Grok"
    default: return provider
    }
}

private func formatVoiceRecordingLimit(_ seconds: Int) -> String {
    guard seconds > 0 else { return "Unavailable" }
    if seconds.isMultiple(of: 60) {
        let minutes = seconds / 60
        return "\(minutes) \(minutes == 1 ? "minute" : "minutes")"
    }
    return "\(seconds) seconds"
}

struct TailscaleStatus: Decodable, Equatable {
    enum State: String, Decodable {
        case notInstalled
        case disconnected
        case serveOff
        case configuring
        case disabling
        case ready
        case unavailable
        case failed
    }

    let state: State
    let reasonCode: String
    let diagnosticMessage: String
    let tailnetURL: URL?
    let canManage: Bool

    enum CodingKeys: String, CodingKey {
        case state
        case reasonCode
        case diagnosticMessage
        case tailnetURL = "tailnetUrl"
        case canManage
    }

    var title: String {
        switch state {
        case .notInstalled:
            "Tailscale · Not installed"
        case .disconnected:
            "Tailscale · Disconnected"
        case .serveOff:
            "Tailscale · Connected · Serve off"
        case .configuring:
            "Tailscale · Configuring Serve..."
        case .disabling:
            "Tailscale · Turning Serve off..."
        case .ready:
            "Tailscale · Connected · Serve on"
        case .unavailable:
            reasonCode == "serveTargetConflict"
                ? "Tailscale · Connected · Serve port in use"
                : "Tailscale · Unavailable"
        case .failed:
            "Tailscale · Failed"
        }
    }

    var serveEnabled: Bool { state == .ready }

    var canToggleServe: Bool {
        canManage && (state == .serveOff || state == .ready)
    }

    static let serverUnavailable = Self(
        state: .unavailable,
        reasonCode: "serverUnavailable",
        diagnosticMessage: "The local Caffold server is unavailable.",
        tailnetURL: nil,
        canManage: false
    )
}

func probeTailscaleStatus(
    url: URL,
    session: URLSession = .shared,
    completion: @escaping (TailscaleStatus) -> Void
) {
    var request = URLRequest(url: url)
    request.timeoutInterval = 4
    session.dataTask(with: request) { data, response, _ in
        let status: TailscaleStatus
        if
            let response = response as? HTTPURLResponse,
            response.statusCode == 200,
            let data,
            let decoded = try? JSONDecoder().decode(TailscaleStatus.self, from: data)
        {
            status = decoded
        } else {
            status = .serverUnavailable
        }
        DispatchQueue.main.async {
            completion(status)
        }
    }.resume()
}

func updateTailscaleServe(
    url: URL,
    enabled: Bool,
    session: URLSession = .shared,
    completion: @escaping (Result<TailscaleStatus, Error>) -> Void
) {
    var request = URLRequest(url: url)
    request.httpMethod = "PUT"
    request.timeoutInterval = 12
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try? JSONEncoder().encode(["enabled": enabled])
    session.dataTask(with: request) { data, response, error in
        let result: Result<TailscaleStatus, Error>
        if
            let response = response as? HTTPURLResponse,
            response.statusCode == 200,
            let data,
            let status = try? JSONDecoder().decode(TailscaleStatus.self, from: data)
        {
            result = .success(status)
        } else {
            result = .failure(TailscaleAPIError.requestFailed(error))
        }
        DispatchQueue.main.async {
            completion(result)
        }
    }.resume()
}

private enum TailscaleAPIError: Error, LocalizedError {
    case requestFailed(Error?)

    var errorDescription: String? {
        "The local Caffold server could not update Tailscale Serve."
    }
}

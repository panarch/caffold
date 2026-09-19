import Foundation

enum IntegrationState: Equatable {
    case checking
    case ready
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

private struct CodexStatusResponse: Decodable {
    struct Account: Decodable {
        let email: String?
        let planType: String?
    }

    struct Readiness: Decodable {
        struct Executable: Decodable {
            let path: String?
            let version: String?
        }

        let state: String
        let blocksTaskOperations: Bool
        let reasonCode: String
        let minimumSupportedVersion: String
        let detectedExecutable: Executable?
        let managedExecutable: Executable?
        let runningAppServerVersion: String?
    }

    let readiness: Readiness
    let account: Account?
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

func probeCodexStatus(
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
            let status = try? JSONDecoder().decode(CodexStatusResponse.self, from: data)
        {
            let readiness = status.readiness
            let version = readiness.detectedExecutable?.version?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            let versionDetail = version.flatMap { value in
                value.isEmpty
                    ? nil
                    : IntegrationDetail(label: "Version", value: value)
            }
            let versionDetails = [versionDetail].compactMap { $0 }
            switch readiness.state {
            case "ready":
                let details = [
                    versionDetail,
                    status.account?.email.map { IntegrationDetail(label: "Account", value: $0) },
                    status.account?.planType.map { IntegrationDetail(label: "Plan", value: $0) },
                ].compactMap { $0 }
                statusResult = IntegrationStatus(
                    name: "Codex",
                    state: .ready,
                    status: "Ready",
                    details: details
                )
            case "missing", "unsupportedInstall":
                statusResult = IntegrationStatus(
                    name: "Codex",
                    state: .attention,
                    status: "Setup required",
                    details: versionDetails
                )
            case "updateRequired":
                let details = [
                    versionDetail,
                    IntegrationDetail(
                        label: "Minimum",
                        value: readiness.minimumSupportedVersion
                    ),
                ].compactMap { $0 }
                statusResult = IntegrationStatus(
                    name: "Codex",
                    state: .attention,
                    status: "Update required",
                    details: details
                )
            case "signInRequired":
                statusResult = IntegrationStatus(
                    name: "Codex",
                    state: .attention,
                    status: "Sign-in required",
                    details: versionDetails
                )
            case "restartRequired":
                let runtimeDetail = readiness.runningAppServerVersion.map {
                    IntegrationDetail(label: "Runtime", value: $0)
                }
                statusResult = IntegrationStatus(
                    name: "Codex",
                    state: .attention,
                    status: "Restart required",
                    details: [versionDetail, runtimeDetail].compactMap { $0 }
                )
            case "incompatible", "error":
                statusResult = IntegrationStatus(
                    name: "Codex",
                    state: .unavailable,
                    status: "Unavailable",
                    details: versionDetails
                )
            default:
                statusResult = IntegrationStatus(
                    name: "Codex",
                    state: .unavailable,
                    status: "Unavailable",
                    details: versionDetails
                )
            }
        } else {
            statusResult = IntegrationStatus(
                name: "Codex",
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
            "Tailscale · Unavailable"
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

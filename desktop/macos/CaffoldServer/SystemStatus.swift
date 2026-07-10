import Foundation

struct TailscaleStatus {
    let title: String
    let connected: Bool
    let serveEnabled: Bool
    let tailnetURL: URL?
}

enum IntegrationState {
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

    let available: Bool
    let codexCliAvailable: Bool
    let appServerAvailable: Bool
    let message: String?
    let account: Account?
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

private struct TailscaleNodeResponse: Decodable {
    struct Node: Decodable {
        let dnsName: String?

        enum CodingKeys: String, CodingKey {
            case dnsName = "DNSName"
        }
    }

    let backendState: String
    let node: Node?

    enum CodingKeys: String, CodingKey {
        case backendState = "BackendState"
        case node = "Self"
    }
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
    runCommand(
        executable: gh,
        arguments: ["auth", "status", "--hostname", "github.com", "--json", "hosts"]
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
    completion: @escaping (IntegrationStatus) -> Void
) {
    var request = URLRequest(url: url)
    request.timeoutInterval = 4
    URLSession.shared.dataTask(with: request) { data, response, _ in
        let statusResult: IntegrationStatus
        if
            let response = response as? HTTPURLResponse,
            response.statusCode == 200,
            let data,
            let status = try? JSONDecoder().decode(CodexStatusResponse.self, from: data)
        {
            if !status.codexCliAvailable {
                statusResult = IntegrationStatus(
                    name: "Codex",
                    state: .unavailable,
                    status: "Not installed",
                    details: []
                )
            } else if status.available, status.appServerAvailable {
                let details = [
                    status.account?.email.map { IntegrationDetail(label: "Account", value: $0) },
                    status.account?.planType.map { IntegrationDetail(label: "Plan", value: $0) },
                ].compactMap { $0 }
                statusResult = IntegrationStatus(
                    name: "Codex",
                    state: .ready,
                    status: "Ready",
                    details: details
                )
            } else if status.message?.lowercased().contains("auth") == true {
                statusResult = IntegrationStatus(
                    name: "Codex",
                    state: .attention,
                    status: "Sign-in required",
                    details: []
                )
            } else {
                statusResult = IntegrationStatus(
                    name: "Codex",
                    state: .unavailable,
                    status: "Unavailable",
                    details: []
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

func probeTailscaleStatus(
    localTarget: String,
    completion: @escaping (TailscaleStatus) -> Void
) {
    guard let tailscale = caffoldExecutable(named: "tailscale") else {
        completion(TailscaleStatus(
            title: "Tailscale · Not installed",
            connected: false,
            serveEnabled: false,
            tailnetURL: nil
        ))
        return
    }

    runCommand(executable: tailscale, arguments: ["status", "--json"]) { statusResult in
        guard case let .success(statusCommand) = statusResult else {
            completion(TailscaleStatus(
                title: "Tailscale · Status unavailable",
                connected: false,
                serveEnabled: false,
                tailnetURL: nil
            ))
            return
        }
        guard
            statusCommand.status == 0,
            let statusData = statusCommand.output.data(using: .utf8),
            let nodeStatus = try? JSONDecoder().decode(TailscaleNodeResponse.self, from: statusData)
        else {
            completion(TailscaleStatus(
                title: "Tailscale · Status unavailable",
                connected: false,
                serveEnabled: false,
                tailnetURL: nil
            ))
            return
        }
        guard nodeStatus.backendState == "Running" else {
            completion(TailscaleStatus(
                title: "Tailscale · Disconnected",
                connected: false,
                serveEnabled: false,
                tailnetURL: nil
            ))
            return
        }

        runCommand(executable: tailscale, arguments: ["serve", "status", "--json"]) { serveResult in
            let serve = serveStatus(
                result: serveResult,
                localTarget: localTarget,
                dnsName: nodeStatus.node?.dnsName
            )
            completion(TailscaleStatus(
                title: serve.enabled
                    ? "Tailscale · Connected · Serve on"
                    : "Tailscale · Connected · Serve off",
                connected: true,
                serveEnabled: serve.enabled,
                tailnetURL: serve.url
            ))
        }
    }
}

private func serveStatus(
    result: Result<CommandResult, Error>,
    localTarget: String,
    dnsName: String?
) -> (enabled: Bool, url: URL?) {
    guard
        case let .success(command) = result,
        command.status == 0,
        let data = command.output.data(using: .utf8),
        let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
        let web = payload["Web"] as? [String: Any]
    else {
        return (false, nil)
    }

    for (host, value) in web {
        guard
            let entry = value as? [String: Any],
            let handlers = entry["Handlers"] as? [String: Any]
        else {
            continue
        }
        let matchesTarget = handlers.values.contains { handler in
            guard let handler = handler as? [String: Any] else { return false }
            return handler["Proxy"] as? String == localTarget
        }
        if matchesTarget {
            let hostWithoutDefaultPort = host.hasSuffix(":443")
                ? String(host.dropLast(4))
                : host
            return (true, URL(string: "https://\(hostWithoutDefaultPort)/"))
        }
    }

    let normalizedDNSName = dnsName?.trimmingCharacters(in: CharacterSet(charactersIn: "."))
    return (false, normalizedDNSName.flatMap { URL(string: "https://\($0)/") })
}

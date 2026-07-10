import Foundation

struct TailscaleStatus {
    let title: String
    let connected: Bool
    let serveEnabled: Bool
    let tailnetURL: URL?
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

func probeGitStatus(completion: @escaping (String) -> Void) {
    guard let git = caffoldExecutable(named: "git") else {
        completion("Git · Not installed")
        return
    }
    runCommand(executable: git, arguments: ["--version"]) { result in
        switch result {
        case let .success(command) where command.status == 0:
            let version = command.output.replacingOccurrences(of: "git version ", with: "")
            completion("Git · Ready · \(version)")
        case .success, .failure:
            completion("Git · Unavailable")
        }
    }
}

func probeGithubStatus(completion: @escaping (String) -> Void) {
    guard let gh = caffoldExecutable(named: "gh") else {
        completion("GitHub CLI · Not installed")
        return
    }
    runCommand(
        executable: gh,
        arguments: ["auth", "status", "--hostname", "github.com"]
    ) { result in
        switch result {
        case let .success(command) where command.status == 0:
            completion("GitHub CLI · Ready")
        case let .success(command):
            let output = command.output.lowercased()
            if output.contains("not logged") || output.contains("token") || output.contains("login") {
                completion("GitHub CLI · Sign-in required")
            } else {
                completion("GitHub CLI · Unavailable")
            }
        case .failure:
            completion("GitHub CLI · Unavailable")
        }
    }
}

func probeCodexStatus(
    url: URL,
    completion: @escaping (String) -> Void
) {
    var request = URLRequest(url: url)
    request.timeoutInterval = 4
    URLSession.shared.dataTask(with: request) { data, response, _ in
        let title: String
        if
            let response = response as? HTTPURLResponse,
            response.statusCode == 200,
            let data,
            let status = try? JSONDecoder().decode(CodexStatusResponse.self, from: data)
        {
            if !status.codexCliAvailable {
                title = "Codex · Not installed"
            } else if status.available, status.appServerAvailable {
                let account = status.account?.email ?? status.account?.planType
                title = account.map { "Codex · Ready · \($0)" } ?? "Codex · Ready"
            } else if status.message?.lowercased().contains("auth") == true {
                title = "Codex · Sign-in required"
            } else {
                title = "Codex · Unavailable"
            }
        } else {
            title = "Codex · Server unavailable"
        }
        DispatchQueue.main.async {
            completion(title)
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
        guard
            case let .success(statusCommand) = statusResult,
            statusCommand.status == 0,
            let statusData = statusCommand.output.data(using: .utf8),
            let nodeStatus = try? JSONDecoder().decode(TailscaleNodeResponse.self, from: statusData),
            nodeStatus.backendState == "Running"
        else {
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

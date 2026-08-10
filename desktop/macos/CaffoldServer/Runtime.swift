import Darwin
import Foundation

enum OwnedProcessTerminationOutcome: Equatable {
    case alreadyStopped
    case terminated
    case forceTerminated
    case timedOut

    var description: String {
        switch self {
        case .alreadyStopped:
            return "already stopped"
        case .terminated:
            return "stopped gracefully"
        case .forceTerminated:
            return "stopped after the graceful-shutdown deadline"
        case .timedOut:
            return "did not stop after SIGKILL"
        }
    }
}

func terminateOwnedProcess(
    _ process: Process,
    gracefulTimeout: TimeInterval = 5,
    forceTimeout: TimeInterval = 2
) -> OwnedProcessTerminationOutcome {
    guard process.isRunning else { return .alreadyStopped }

    process.terminate()
    if waitForProcessExit(process, timeout: gracefulTimeout) {
        return .terminated
    }

    // The Process instance is the ownership proof. Check it again immediately
    // before signaling its exact PID so an unrelated process is never selected
    // by name, port, or executable path.
    guard process.isRunning else { return .terminated }
    guard Darwin.kill(process.processIdentifier, SIGKILL) == 0 else {
        return process.isRunning ? .timedOut : .forceTerminated
    }

    return waitForProcessExit(process, timeout: forceTimeout)
        ? .forceTerminated
        : .timedOut
}

private func waitForProcessExit(_ process: Process, timeout: TimeInterval) -> Bool {
    let deadline = Date().addingTimeInterval(max(0, timeout))
    while process.isRunning, Date() < deadline {
        Thread.sleep(forTimeInterval: 0.025)
    }
    return !process.isRunning
}

enum ServerBindMode: String {
    case local = "127.0.0.1"
    case lan = "0.0.0.0"

    var title: String {
        switch self {
        case .local:
            return "Local only"
        case .lan:
            return "LAN"
        }
    }
}

struct ServerRuntimePreferences: Equatable {
    private static let bindAddressKey = "server.bindAddress"
    private static let portKey = "server.port"
    private static let autoStartTailscaleKey = "tailscale.autoStartServe"

    var bindMode: ServerBindMode
    var port: Int
    var autoStartTailscaleServe: Bool

    static func load(defaults: UserDefaults = .standard) -> ServerRuntimePreferences {
        let bindMode = ServerBindMode(
            rawValue: defaults.string(forKey: bindAddressKey) ?? ""
        ) ?? .local
        let savedPort = defaults.integer(forKey: portKey)
        let port = (1 ... 65_535).contains(savedPort) ? savedPort : 5_178
        let autoStart = defaults.object(forKey: autoStartTailscaleKey) == nil
            ? true
            : defaults.bool(forKey: autoStartTailscaleKey)
        return ServerRuntimePreferences(
            bindMode: bindMode,
            port: port,
            autoStartTailscaleServe: autoStart
        )
    }

    func save(defaults: UserDefaults = .standard) {
        defaults.set(bindMode.rawValue, forKey: Self.bindAddressKey)
        defaults.set(port, forKey: Self.portKey)
        defaults.set(autoStartTailscaleServe, forKey: Self.autoStartTailscaleKey)
    }
}

struct CommandResult {
    let status: Int32
    let output: String
}

func caffoldEnvironment() -> [String: String] {
    var environment = ProcessInfo.processInfo.environment
    let home = FileManager.default.homeDirectoryForCurrentUser.path
    let paths = [
        "\(home)/.local/bin",
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "\(home)/.cargo/bin",
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
        "/Applications/Codex.app/Contents/Resources",
    ]
    let inherited = environment["PATH"] ?? ""
    environment["PATH"] = (paths + [inherited]).joined(separator: ":")
    environment["HOME"] = home
    if environment["TERM"]?.isEmpty != false {
        environment["TERM"] = "dumb"
    }
    return environment
}

func caffoldExecutable(named name: String) -> URL? {
    let environment = caffoldEnvironment()
    let pathEntries = (environment["PATH"] ?? "").split(separator: ":")
    for entry in pathEntries {
        let candidate = URL(fileURLWithPath: String(entry), isDirectory: true)
            .appendingPathComponent(name)
        if FileManager.default.isExecutableFile(atPath: candidate.path) {
            return candidate
        }
    }

    let appCandidates = [
        "tailscale": "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
        "codex": "/Applications/Codex.app/Contents/Resources/codex",
    ]
    guard let path = appCandidates[name] else { return nil }
    return FileManager.default.isExecutableFile(atPath: path)
        ? URL(fileURLWithPath: path)
        : nil
}

func runCommand(
    executable: URL,
    arguments: [String],
    completion: @escaping (Result<CommandResult, Error>) -> Void
) {
    DispatchQueue.global(qos: .utility).async {
        let process = Process()
        let output = Pipe()
        process.executableURL = executable
        process.arguments = arguments
        process.environment = caffoldEnvironment()
        process.standardOutput = output
        process.standardError = output

        do {
            try process.run()
            let data = output.fileHandleForReading.readDataToEndOfFile()
            process.waitUntilExit()
            let result = CommandResult(
                status: process.terminationStatus,
                output: String(decoding: data, as: UTF8.self).trimmingCharacters(
                    in: .whitespacesAndNewlines
                )
            )
            DispatchQueue.main.async {
                completion(.success(result))
            }
        } catch {
            DispatchQueue.main.async {
                completion(.failure(error))
            }
        }
    }
}

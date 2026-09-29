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

/// The Caffold server on the configured port, as the app sees it from
/// outside: the process it started, if any, and whether `/api/health`
/// answers. Every change goes through `ServerLifecycle.handle`.
enum ServerPhase: Equatable {
    /// The app has just launched and has not heard from the port yet.
    case checking
    /// The app's server has not answered yet.
    case starting
    /// The app's server answers.
    case ready
    /// The app's server runs but does not answer: it stopped answering, or it
    /// never answered before the startup wait ended.
    case notResponding
    /// The app is stopping its server to start it again.
    case restarting
    /// The app is stopping its server because the app is quitting.
    case stopping
    /// No server of the app's runs, and nothing answers on the port.
    case stopped(ServerStop)
    /// A server the app did not start answers on the port.
    case external
}

enum ServerStop: Equatable {
    case notStarted
    case exited(Int32)
    case failedToStart
}

enum ServerEvent: Equatable {
    /// A health check sent while `generation` was current answered, or did not.
    case healthAnswered(Bool, generation: Int)
    case launched
    case launchFailed
    case startupExpired
    case restartRequested
    case restartTimedOut
    case quitRequested
    case exited(Int32)
}

struct ServerLifecycle {
    private(set) var phase = ServerPhase.checking
    /// Advances each time the app starts a server, so an answer to a health
    /// check sent before then cannot change how the new server is shown.
    private(set) var generation = 0

    /// Applies `event` if the current phase accepts it, and returns whether it
    /// did.
    mutating func handle(_ event: ServerEvent) -> Bool {
        if case let .healthAnswered(_, generation) = event, generation != self.generation {
            return false
        }
        guard let next = Self.next(from: phase, on: event) else { return false }
        if event == .launched {
            generation += 1
        }
        phase = next
        return true
    }

    /// Every allowed transition; any other pair is ignored.
    private static func next(from phase: ServerPhase, on event: ServerEvent) -> ServerPhase? {
        switch (phase, event) {
        case (.checking, .healthAnswered(true, _)),
             (.stopped, .healthAnswered(true, _)),
             (.external, .healthAnswered(true, _)):
            return .external
        case (.external, .healthAnswered(false, _)):
            return .stopped(.notStarted)
        case (.checking, .launched),
             (.restarting, .launched),
             (.stopped, .launched),
             (.external, .launched):
            return .starting
        case (.checking, .launchFailed),
             (.restarting, .launchFailed),
             (.stopped, .launchFailed),
             (.external, .launchFailed):
            return .stopped(.failedToStart)
        case (.starting, .healthAnswered(true, _)),
             (.ready, .healthAnswered(true, _)),
             (.notResponding, .healthAnswered(true, _)):
            return .ready
        case (.ready, .healthAnswered(false, _)),
             (.notResponding, .healthAnswered(false, _)),
             (.starting, .startupExpired),
             (.restarting, .restartTimedOut):
            return .notResponding
        case (.starting, .restartRequested),
             (.ready, .restartRequested),
             (.notResponding, .restartRequested),
             (.restarting, .exited):
            return .restarting
        case (.starting, .quitRequested),
             (.ready, .quitRequested),
             (.notResponding, .quitRequested),
             (.restarting, .quitRequested):
            return .stopping
        case let (.starting, .exited(status)),
             let (.ready, .exited(status)),
             let (.notResponding, .exited(status)),
             let (.stopping, .exited(status)):
            return .stopped(.exited(status))
        default:
            return nil
        }
    }
}

/// What the Server rows of the menu show for a phase.
struct ServerPresentation: Equatable {
    let status: String
    let control: String
    let controlEnabled: Bool
}

extension ServerPhase {
    func presentation(bindMode: ServerBindMode, port: Int) -> ServerPresentation {
        let address = "127.0.0.1:\(port)"
        switch self {
        case .checking:
            return ServerPresentation(
                status: "Checking local server...",
                control: "Restart Server",
                controlEnabled: false
            )
        case .starting:
            return ServerPresentation(
                status: "Starting Caffold...",
                control: "Restart Server",
                controlEnabled: false
            )
        case .ready:
            return ServerPresentation(
                status: "Running · \(bindMode.title) · \(address)",
                control: "Restart Server",
                controlEnabled: true
            )
        case .notResponding:
            return ServerPresentation(
                status: "Server · Not responding",
                control: "Restart Server",
                controlEnabled: true
            )
        case .restarting:
            return ServerPresentation(
                status: "Restarting server...",
                control: "Restart Server",
                controlEnabled: false
            )
        case .stopping:
            return ServerPresentation(
                status: "Stopping server...",
                control: "Restart Server",
                controlEnabled: false
            )
        case .stopped(.notStarted):
            return ServerPresentation(
                status: "Server · Stopped",
                control: "Start Server",
                controlEnabled: true
            )
        case let .stopped(.exited(status)):
            return ServerPresentation(
                status: "Server · Stopped (exit \(status))",
                control: "Start Server",
                controlEnabled: true
            )
        case .stopped(.failedToStart):
            return ServerPresentation(
                status: "Caffold failed to start",
                control: "Start Server",
                controlEnabled: true
            )
        case .external:
            return ServerPresentation(
                status: "Running · External · \(address)",
                control: "Restart Server",
                controlEnabled: false
            )
        }
    }
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
    runCommand(
        executable: executable,
        arguments: arguments,
        environment: caffoldEnvironment(),
        completion: completion
    )
}

func runCommand(
    executable: URL,
    arguments: [String],
    environment: [String: String],
    completion: @escaping (Result<CommandResult, Error>) -> Void
) {
    DispatchQueue.global(qos: .utility).async {
        let process = Process()
        let output = Pipe()
        process.executableURL = executable
        process.arguments = arguments
        process.environment = environment
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

import Foundation

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

import Darwin
import Foundation

struct ServerDiagnosticsTiming {
    var probeInterval: TimeInterval = 1
    var requestTimeout: TimeInterval = 0.8
    var stallAfter: TimeInterval = 5
    var sampleTimeout: TimeInterval = 10
}

struct ServerStackCapture {
    let pid: Int32
    let report: URL
    let context: URL
    let failure: String?

    var description: String {
        if let failure {
            return "Stack capture for PID \(pid) failed: \(failure). Context: \(context.path)"
        }
        return "Stack capture for PID \(pid) saved to \(report.path)"
    }
}

/// Watches HTTP from the wrapper process, independently of the backend's
/// scheduler, locks, request tracker, and log writer. One instance owns exactly
/// the Process the wrapper started; a replacement receives a new instance.
final class OwnedServerDiagnostics {
    private enum Phase {
        case monitoring
        case unresponsive
        case stopped
    }

    private let process: Process
    private let healthURL: URL
    private let directory: URL
    private let timing: ServerDiagnosticsTiming
    private let onCapture: (ServerStackCapture) -> Void
    private let queue = DispatchQueue(label: "io.panarch.caffold.server-diagnostics")
    private let session: URLSession
    private var phase = Phase.monitoring
    private var lastHealthy = ProcessInfo.processInfo.systemUptime
    private var healthRequest: URLSessionDataTask?
    private var timer: DispatchSourceTimer?
    private var lastCapture: ServerStackCapture?
    private var lastHealthFailure = "No successful HTTP health response"

    init(
        process: Process,
        healthURL: URL,
        directory: URL,
        timing: ServerDiagnosticsTiming = ServerDiagnosticsTiming(),
        onCapture: @escaping (ServerStackCapture) -> Void
    ) {
        self.process = process
        self.healthURL = healthURL
        self.directory = directory
        self.timing = timing
        self.onCapture = onCapture
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = timing.requestTimeout
        configuration.timeoutIntervalForResource = timing.requestTimeout
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.httpCookieStorage = nil
        session = URLSession(configuration: configuration)
        queue.async { self.startWatching() }
    }

    /// Call on the restart worker before SIGTERM, not after the backend has
    /// begun shutting down. The serial queue also waits for an ongoing sample.
    /// A successful capture of this incident is reused; failed captures retry.
    func captureBeforeStopping(reason: String, requireCapture: Bool = true) -> ServerStackCapture? {
        queue.sync {
            let previous = phase
            stopWatching()
            if previous != .monitoring, let capture = lastCapture, capture.failure == nil {
                return capture
            }
            guard requireCapture || previous == .unresponsive else { return nil }
            let capture = captureOwnedServer(
                process, in: directory, reason: reason,
                healthFailure: lastHealthFailure, timeout: timing.sampleTimeout
            )
            lastCapture = capture
            return capture
        }
    }

    func stop() {
        queue.async { self.stopWatching() }
    }

    private func startWatching() {
        guard phase != .stopped else { return }
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now(), repeating: timing.probeInterval)
        timer.setEventHandler { [weak self] in self?.checkHealth() }
        self.timer = timer
        timer.resume()
    }

    private func checkHealth() {
        guard phase != .stopped else { return }
        guard process.isRunning else {
            stopWatching()
            return
        }
        guard healthRequest == nil else { return }
        var request = URLRequest(url: healthURL, cachePolicy: .reloadIgnoringLocalCacheData)
        request.timeoutInterval = timing.requestTimeout
        let task = session.dataTask(with: request) { [weak self] _, response, error in
            guard let self else { return }
            let status = (response as? HTTPURLResponse)?.statusCode
            self.queue.async {
                self.healthRequest = nil
                guard self.phase != .stopped, self.process.isRunning else { return }
                self.acceptHealth(status: status, error: error)
            }
        }
        healthRequest = task
        task.resume()
    }

    private func acceptHealth(status: Int?, error: Error?) {
        let now = ProcessInfo.processInfo.systemUptime
        if status == 200 {
            lastHealthy = now
            phase = .monitoring
            lastCapture = nil
            return
        }
        lastHealthFailure = error?.localizedDescription ?? "HTTP status \(status.map(String.init) ?? "missing")"
        guard phase == .monitoring, now - lastHealthy >= timing.stallAfter else { return }
        phase = .unresponsive
        let capture = captureOwnedServer(
            process, in: directory, reason: "HTTP health unanswered for at least \(timing.stallAfter)s",
            healthFailure: lastHealthFailure, timeout: timing.sampleTimeout
        )
        lastCapture = capture
        // Evidence is already on disk before any app or backend log is touched.
        onCapture(capture)
    }

    private func stopWatching() {
        phase = .stopped
        timer?.cancel()
        timer = nil
        healthRequest?.cancel()
        healthRequest = nil
        session.invalidateAndCancel()
    }
}

/// The only signal sent here targets the sampler helper, on its deadline.
/// The backend stays alive throughout collection and is never signaled here.
private func captureOwnedServer(
    _ process: Process, in directory: URL, reason: String,
    healthFailure: String, timeout: TimeInterval
) -> ServerStackCapture {
    let pid = process.processIdentifier
    let dateFormatter = ISO8601DateFormatter()
    dateFormatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let stamp = dateFormatter.string(from: Date()).replacingOccurrences(of: ":", with: "")
    let name = "external-\(stamp)-\(pid)-\(UUID().uuidString)"
    let report = directory.appendingPathComponent(name + ".sample.txt")
    let context = directory.appendingPathComponent(name + ".context.txt")
    do {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try retainExternalCaptures(in: directory, keep: 9)
        let header = """
        Caffold external stack capture
        Time: \(ISO8601DateFormatter().string(from: Date()))
        Backend PID: \(pid)
        Backend executable: \(process.executableURL?.path ?? "unknown")
        Reason: \(reason)
        Last health failure: \(healthFailure)
        Stack report: \(report.path)

        """
        try Data(header.utf8).write(to: context, options: .withoutOverwriting)
        try Data().write(to: report, options: .withoutOverwriting)
        guard process.isRunning else {
            throw DiagnosticCaptureError("the owned backend exited before capture")
        }
        let output = try FileHandle(forWritingTo: context)
        defer { try? output.close() }
        try output.seekToEnd()
        let helper = Process()
        helper.executableURL = URL(fileURLWithPath: "/usr/bin/sample")
        helper.arguments = [String(pid), "3", "-file", report.path]
        helper.standardInput = FileHandle.nullDevice
        helper.standardOutput = output
        helper.standardError = output
        try helper.run()
        try waitForDiagnosticSample(helper, timeout: timeout)
        let stacks = try String(contentsOf: report, encoding: .utf8)
        guard stacks.contains("Call graph:") else {
            throw DiagnosticCaptureError("sample produced no call graph")
        }
        try output.write(contentsOf: Data("\nCapture completed successfully.\n".utf8))
        return ServerStackCapture(pid: pid, report: report, context: context, failure: nil)
    } catch {
        let failure = "Caffold stack capture failed for PID \(pid): \(error)\n"
        for path in [context, report] {
            if let output = try? FileHandle(forWritingTo: path) {
                _ = try? output.seekToEnd()
                try? output.write(contentsOf: Data(failure.utf8))
                try? output.close()
            }
        }
        return ServerStackCapture(pid: pid, report: report, context: context, failure: String(describing: error))
    }
}

struct DiagnosticCaptureError: Error, CustomStringConvertible {
    let description: String

    init(_ description: String) { self.description = description }
}

func waitForDiagnosticSample(_ helper: Process, timeout: TimeInterval) throws {
    let deadline = ProcessInfo.processInfo.systemUptime + max(0, timeout)
    while helper.isRunning, ProcessInfo.processInfo.systemUptime < deadline {
        Thread.sleep(forTimeInterval: 0.025)
    }
    if helper.isRunning {
        // This exact Process was launched here. Never select a target by name.
        guard Darwin.kill(helper.processIdentifier, SIGKILL) == 0 else {
            throw DiagnosticCaptureError("sample exceeded its deadline and could not be stopped")
        }
        let reapDeadline = ProcessInfo.processInfo.systemUptime + 2
        while helper.isRunning, ProcessInfo.processInfo.systemUptime < reapDeadline {
            Thread.sleep(forTimeInterval: 0.025)
        }
        guard !helper.isRunning else {
            throw DiagnosticCaptureError("sample did not exit after SIGKILL")
        }
        throw DiagnosticCaptureError("sample exceeded its \(timeout)s deadline")
    }
    helper.waitUntilExit()
    guard helper.terminationStatus == 0 else {
        throw DiagnosticCaptureError("sample exited with status \(helper.terminationStatus)")
    }
}

/// External evidence has its own prefix; never prune a backend-owned sample.
private func retainExternalCaptures(in directory: URL, keep: Int) throws {
    let keys: Set<URLResourceKey> = [.isRegularFileKey, .isSymbolicLinkKey]
    let files = try FileManager.default.contentsOfDirectory(
        at: directory, includingPropertiesForKeys: Array(keys)
    ).filter { file in
        guard file.lastPathComponent.hasPrefix("external-"), file.lastPathComponent.hasSuffix(".context.txt") else {
            return false
        }
        let values = try file.resourceValues(forKeys: keys)
        return values.isRegularFile == true && values.isSymbolicLink != true
    }.sorted { $0.lastPathComponent < $1.lastPathComponent }
    for context in files.prefix(max(0, files.count - keep)) {
        let name = String(context.lastPathComponent.dropLast(".context.txt".count))
        let report = directory.appendingPathComponent(name + ".sample.txt")
        if let values = try? report.resourceValues(forKeys: keys),
           values.isRegularFile == true, values.isSymbolicLink != true {
            try FileManager.default.removeItem(at: report)
        }
        try FileManager.default.removeItem(at: context)
    }
}

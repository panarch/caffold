import Darwin
import Foundation

private struct TestFailure: Error, CustomStringConvertible {
    let description: String
}

private func require(_ condition: Bool, _ message: String) throws {
    guard condition else { throw TestFailure(description: message) }
}

private func startProcess(arguments: [String]) throws -> Process {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: CommandLine.arguments[0])
    process.arguments = arguments
    process.standardOutput = FileHandle.nullDevice
    process.standardError = FileHandle.nullDevice
    try process.run()
    return process
}

private func runTests() throws {
    let graceful = try startProcess(arguments: ["--wait"])
    let gracefulOutcome = terminateOwnedProcess(
        graceful,
        gracefulTimeout: 1,
        forceTimeout: 1
    )
    try require(gracefulOutcome == .terminated, "a normal child must stop on SIGTERM")
    try require(!graceful.isRunning, "the graceful child must be reaped before returning")

    let stubborn = try startProcess(arguments: ["--ignore-term"])
    Thread.sleep(forTimeInterval: 0.1)
    let stubbornOutcome = terminateOwnedProcess(
        stubborn,
        gracefulTimeout: 0.1,
        forceTimeout: 1
    )
    try require(
        stubbornOutcome == .forceTerminated,
        "a child that ignores SIGTERM must be stopped by the exact-PID fallback"
    )
    try require(!stubborn.isRunning, "the forced child must be reaped before returning")

    let alreadyStopped = try startProcess(arguments: ["--exit"])
    alreadyStopped.waitUntilExit()
    try require(
        terminateOwnedProcess(alreadyStopped) == .alreadyStopped,
        "an exited child must not be signaled again"
    )

    try serverLifecycleTests()
    try externalDiagnosticsTests()
}

/// The child accepts HTTP while its main loop remains live, but leaves health
/// requests unanswered unless the test's flag exists. It ignores SIGTERM so
/// the tests can prove collection precedes the forced restart fallback.
private func serveDiagnosticHealth(ready: URL, healthy: URL) throws {
    Darwin.signal(SIGTERM, SIG_IGN)
    Darwin.signal(SIGPIPE, SIG_IGN)
    let server = Darwin.socket(AF_INET, SOCK_STREAM, 0)
    guard server >= 0 else { throw TestFailure(description: "cannot create fixture socket") }
    defer { Darwin.close(server) }
    var address = sockaddr_in()
    address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
    address.sin_family = sa_family_t(AF_INET)
    address.sin_addr.s_addr = inet_addr("127.0.0.1")
    let bound = withUnsafePointer(to: &address) { pointer in
        pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            Darwin.bind(server, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
        }
    }
    guard bound == 0, Darwin.listen(server, 32) == 0 else {
        throw TestFailure(description: "cannot bind fixture listener")
    }
    var length = socklen_t(MemoryLayout<sockaddr_in>.size)
    _ = withUnsafeMutablePointer(to: &address) { pointer in
        pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            Darwin.getsockname(server, $0, &length)
        }
    }
    try Data(String(UInt16(bigEndian: address.sin_port)).utf8).write(to: ready)
    while true {
        let client = Darwin.accept(server, nil, nil)
        guard client >= 0 else { continue }
        var bytes = [UInt8](repeating: 0, count: 4096)
        let received = Darwin.recv(client, &bytes, bytes.count, 0)
        if received > 0, FileManager.default.fileExists(atPath: healthy.path) {
            let response = Array("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}".utf8)
            _ = response.withUnsafeBytes { Darwin.send(client, $0.baseAddress, $0.count, 0) }
        } else {
            Thread.sleep(forTimeInterval: 0.15)
        }
        Darwin.close(client)
    }
}

private func diagnosticChild(in directory: URL) throws -> (Process, URL, URL) {
    let ready = directory.appendingPathComponent("ready")
    let healthy = directory.appendingPathComponent("healthy")
    let child = try startProcess(arguments: ["--diagnostic-health", ready.path, healthy.path])
    let deadline = ProcessInfo.processInfo.systemUptime + 5
    while !FileManager.default.fileExists(atPath: ready.path),
          ProcessInfo.processInfo.systemUptime < deadline {
        Thread.sleep(forTimeInterval: 0.025)
    }
    guard let port = try? String(contentsOf: ready, encoding: .utf8) else {
        _ = terminateOwnedProcess(child, gracefulTimeout: 0.1)
        throw TestFailure(description: "fixture did not publish its port")
    }
    return (child, URL(string: "http://127.0.0.1:\(port)/api/health")!, healthy)
}

private func externalDiagnosticsTests() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("caffold-diagnostics-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let (child, healthURL, healthy) = try diagnosticChild(in: root)
    defer { _ = terminateOwnedProcess(child, gracefulTimeout: 0.1) }
    let directory = root.appendingPathComponent("reports")
    let captured = DispatchSemaphore(value: 0)
    let lock = NSLock()
    var captures = [ServerStackCapture]()
    let timing = ServerDiagnosticsTiming(probeInterval: 0.15, requestTimeout: 0.08, stallAfter: 0.3)
    let diagnostics = OwnedServerDiagnostics(process: child, healthURL: healthURL, directory: directory, timing: timing) { capture in
        lock.lock()
        captures.append(capture)
        lock.unlock()
        captured.signal()
    }
    defer { diagnostics.stop() }

    try require(captured.wait(timeout: .now() + 15) == .success, "unanswered HTTP must trigger external capture")
    lock.lock()
    let first = captures[0]
    lock.unlock()
    try require(first.failure == nil, first.description)
    let firstStacks = try String(contentsOf: first.report, encoding: .utf8)
    try require(firstStacks.contains("Call graph:"), "automatic capture must contain actual stacks")
    try require(firstStacks.contains("[\(child.processIdentifier)]"), "the report must name the exact owned child PID")
    try require(child.isRunning, "automatic collection must not terminate its target")
    try require(captured.wait(timeout: .now() + 0.7) == .timedOut, "one continuous failure must not pile up captures")

    try Data().write(to: healthy)
    Thread.sleep(forTimeInterval: 0.8)
    try FileManager.default.removeItem(at: healthy)
    try require(captured.wait(timeout: .now() + 15) == .success, "health recovery must rearm capture")
    lock.lock()
    let second = captures[1]
    lock.unlock()
    try require(second.failure == nil && second.report != first.report, "a second incident must save new stacks")
    let before = ProcessInfo.processInfo.systemUptime
    let reused = diagnostics.captureBeforeStopping(reason: "test restart")
    try require(reused?.report == second.report, "restart must reuse completed incident evidence")
    try require(ProcessInfo.processInfo.systemUptime - before < 1, "restart must not sample a completed incident twice")
    try require(child.isRunning, "restart preparation must finish collection before SIGTERM")
    try require(
        terminateOwnedProcess(child, gracefulTimeout: 0.1) == .forceTerminated,
        "the stubborn target is force-stopped only after its report is saved"
    )
    try require(captured.wait(timeout: .now() + 0.3) == .timedOut, "stopped diagnostics must ignore pending health callbacks")

    try captureBeforeHealthyRestart(in: root.appendingPathComponent("restart"))
    try diagnosticFailureTests(in: root.appendingPathComponent("failure"))
    print("External HTTP stall: real PID \(first.pid) sampled twice; restart reused saved stacks")
}

private func captureBeforeHealthyRestart(in root: URL) throws {
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    try Data().write(to: root.appendingPathComponent("healthy"))
    let (child, healthURL, _) = try diagnosticChild(in: root)
    defer { _ = terminateOwnedProcess(child, gracefulTimeout: 0.1) }
    let quiet = OwnedServerDiagnostics(process: child, healthURL: healthURL, directory: root.appendingPathComponent("quiet")) { _ in }
    try require(quiet.captureBeforeStopping(reason: "healthy quit", requireCapture: false) == nil, "an ordinary healthy quit must skip collection")
    try require(!FileManager.default.fileExists(atPath: root.appendingPathComponent("quiet").path), "a healthy quit must not create capture files")

    let diagnostics = OwnedServerDiagnostics(process: child, healthURL: healthURL, directory: root.appendingPathComponent("reports")) { _ in }
    let finished = DispatchSemaphore(value: 0)
    let lock = NSLock()
    var restartCapture: ServerStackCapture?
    DispatchQueue.global().async {
        let captured = diagnostics.captureBeforeStopping(reason: "Restart Server requested")
        lock.lock()
        restartCapture = captured
        lock.unlock()
        finished.signal()
    }
    let capture = diagnostics.captureBeforeStopping(reason: "quit during restart", requireCapture: true)
    try require(finished.wait(timeout: .now() + 15) == .success, "both restart and quit preparations must complete")
    lock.lock()
    let restarted = restartCapture
    lock.unlock()
    try require(capture?.report == restarted?.report, "concurrent restart and quit must reuse the same saved evidence")
    try require(capture?.failure == nil, capture?.description ?? "restart did not capture")
    try require(child.isRunning, "restart must save stacks while the original target is alive")
    let stacks = try String(contentsOf: capture!.report, encoding: .utf8)
    try require(stacks.contains("Call graph:"), "restart preparation must save a real call graph")
    try require(try FileManager.default.contentsOfDirectory(at: root.appendingPathComponent("reports"), includingPropertiesForKeys: nil).filter { $0.lastPathComponent.hasSuffix(".sample.txt") }.count == 1, "restart and quit must not collect twice")

    // A failed termination leaves this same owned process alive. A replacement
    // observer must still collect a later HTTP stall, despite the stopped one.
    try FileManager.default.removeItem(at: root.appendingPathComponent("healthy"))
    let captured = DispatchSemaphore(value: 0)
    let reattached = OwnedServerDiagnostics(
        process: child, healthURL: healthURL, directory: root.appendingPathComponent("reports"),
        timing: ServerDiagnosticsTiming(probeInterval: 0.15, requestTimeout: 0.08, stallAfter: 0.3)
    ) { capture in
        if capture.failure == nil { captured.signal() }
    }
    defer { reattached.stop() }
    try require(captured.wait(timeout: .now() + 15) == .success, "a still-owned process must be observed after failed restart")
    try require(child.isRunning, "reattaching diagnostics must not stop the owned process")
}

private func diagnosticFailureTests(in root: URL) throws {
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    let exited = try startProcess(arguments: ["--exit"])
    exited.waitUntilExit()
    let directory = root.appendingPathComponent("reports")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let untouched = directory.appendingPathComponent("stall-backend.sample.txt")
    try Data("backend evidence".utf8).write(to: untouched)
    let linkedContext = directory.appendingPathComponent("external-000-link.context.txt")
    let linkedReport = directory.appendingPathComponent("external-000-report.sample.txt")
    try FileManager.default.createSymbolicLink(at: linkedContext, withDestinationURL: untouched)
    try Data("old context".utf8).write(to: directory.appendingPathComponent("external-000-report.context.txt"))
    try FileManager.default.createSymbolicLink(at: linkedReport, withDestinationURL: untouched)
    let diagnostics = OwnedServerDiagnostics(process: exited, healthURL: URL(string: "http://127.0.0.1:1/api/health")!, directory: directory) { _ in }
    for _ in 0..<12 {
        let capture = diagnostics.captureBeforeStopping(reason: "exited target")!
        try require(capture.failure?.contains("exited") == true, "an exited target must leave an explicit failure")
        try require(try String(contentsOf: capture.context, encoding: .utf8).contains("Backend PID:"), "failure context must retain target identity")
        try require(try String(contentsOf: capture.report, encoding: .utf8).contains("capture failed"), "failure must remain in the partial stack report")
    }
    let contexts = try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: [.isSymbolicLinkKey]).filter {
        guard $0.lastPathComponent.hasSuffix(".context.txt") else { return false }
        return try $0.resourceValues(forKeys: [.isSymbolicLinkKey]).isSymbolicLink != true
    }
    try require(contexts.count == 10, "external capture retention must keep ten incidents")
    try require(try String(contentsOf: untouched, encoding: .utf8) == "backend evidence", "external retention must not remove backend evidence")
    try require(try linkedContext.resourceValues(forKeys: [.isSymbolicLinkKey]).isSymbolicLink == true, "retention must leave context symlinks alone")
    try require(try linkedReport.resourceValues(forKeys: [.isSymbolicLinkKey]).isSymbolicLink == true, "retention must leave report symlinks alone")

    let helper = try startProcess(arguments: ["--ignore-term"])
    do {
        try waitForDiagnosticSample(helper, timeout: 0.1)
        throw TestFailure(description: "a stuck sampler must time out")
    } catch let error as DiagnosticCaptureError {
        try require(error.description.contains("deadline"), "a timeout must identify its deadline")
    }
    try require(!helper.isRunning, "the timed-out exact sampler Process must be killed and reaped")
    let failedHelper = try startProcess(arguments: ["--fail"])
    do {
        try waitForDiagnosticSample(failedHelper, timeout: 1)
        throw TestFailure(description: "a failing helper must fail capture")
    } catch let error as DiagnosticCaptureError {
        try require(error.description.contains("status 7"), "helper errors must preserve the exit status")
    }
}

/// A lifecycle whose server the app started and saw answer.
private func readyLifecycle() -> ServerLifecycle {
    var lifecycle = ServerLifecycle()
    _ = lifecycle.handle(.launched)
    _ = lifecycle.handle(.healthAnswered(true, generation: lifecycle.generation))
    return lifecycle
}

private func presentation(_ lifecycle: ServerLifecycle) -> ServerPresentation {
    lifecycle.phase.presentation(bindMode: .local, port: 5_178)
}

private func serverLifecycleTests() throws {
    var hung = readyLifecycle()
    try require(hung.phase == .ready, "a launched server that answers is ready")
    try require(
        hung.handle(.healthAnswered(false, generation: hung.generation)),
        "a ready server that stops answering must be noticed"
    )
    try require(hung.phase == .notResponding, "a server that stopped answering is not responding")
    try require(
        presentation(hung) == ServerPresentation(
            status: "Server · Not responding",
            control: "Restart Server",
            controlEnabled: true
        ),
        "a server that is not responding must be shown as such and be restartable"
    )

    var slowStart = ServerLifecycle()
    _ = slowStart.handle(.launched)
    try require(
        !slowStart.handle(.healthAnswered(false, generation: slowStart.generation)),
        "an unanswered check while starting leaves the server starting"
    )
    try require(!presentation(slowStart).controlEnabled, "a starting server is not restarted from the menu")
    _ = slowStart.handle(.startupExpired)
    try require(
        slowStart.phase == .notResponding && presentation(slowStart).controlEnabled,
        "a server that never answered before the startup wait ended must be restartable"
    )

    var restarted = hung
    let hungGeneration = restarted.generation
    try require(restarted.handle(.restartRequested), "a server that is not responding restarts")
    try require(restarted.phase == .restarting, "the app stops its server before starting it again")
    try require(
        !restarted.handle(.healthAnswered(true, generation: hungGeneration)),
        "a health answer while restarting must not change the phase"
    )
    try require(
        restarted.handle(.exited(SIGKILL)) && restarted.phase == .restarting,
        "the stopped server's exit leaves the app about to start it again"
    )
    _ = restarted.handle(.launched)
    try require(
        restarted.phase == .starting && restarted.generation == hungGeneration + 1,
        "starting again begins a new generation"
    )
    try require(
        !restarted.handle(.healthAnswered(true, generation: hungGeneration)),
        "an answer to a check sent before the new server started must be ignored"
    )
    try require(restarted.phase == .starting, "the new server is still starting")

    var timedOut = hung
    _ = timedOut.handle(.restartRequested)
    _ = timedOut.handle(.restartTimedOut)
    try require(
        timedOut.phase == .notResponding,
        "a server that outlived its restart is still not responding"
    )

    var quitting = hung
    _ = quitting.handle(.restartRequested)
    _ = quitting.handle(.quitRequested)
    try require(quitting.phase == .stopping, "quitting during a restart stops the server for good")
    _ = quitting.handle(.exited(0))
    try require(quitting.phase == .stopped(.exited(0)), "a server stopped by quitting is not started again")

    var external = ServerLifecycle()
    _ = external.handle(.healthAnswered(true, generation: external.generation))
    try require(external.phase == .external, "a server the app did not start is external")
    try require(!presentation(external).controlEnabled, "the app does not restart a server it did not start")
    try require(!external.handle(.restartRequested), "a restart request does not apply to an external server")
    _ = external.handle(.healthAnswered(false, generation: external.generation))
    try require(
        presentation(external) == ServerPresentation(
            status: "Server · Stopped",
            control: "Start Server",
            controlEnabled: true
        ),
        "when the external server stops answering, the app can start its own"
    )
}

if CommandLine.arguments.contains("--diagnostic-health") {
    try serveDiagnosticHealth(ready: URL(fileURLWithPath: CommandLine.arguments[2]), healthy: URL(fileURLWithPath: CommandLine.arguments[3]))
} else if CommandLine.arguments.contains("--fail") {
    exit(7)
} else if CommandLine.arguments.contains("--ignore-term") {
    Darwin.signal(SIGTERM, SIG_IGN)
    while true {
        Thread.sleep(forTimeInterval: 1)
    }
} else if CommandLine.arguments.contains("--wait") {
    while true {
        Thread.sleep(forTimeInterval: 1)
    }
} else if CommandLine.arguments.contains("--exit") {
    exit(0)
} else {
    do {
        try runTests()
        print("Caffold runtime tests passed")
    } catch {
        fputs("Caffold runtime tests failed: \(error)\n", stderr)
        exit(1)
    }
}

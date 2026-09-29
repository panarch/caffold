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

if CommandLine.arguments.contains("--ignore-term") {
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

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

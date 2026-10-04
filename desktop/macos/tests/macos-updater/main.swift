import AppKit
import Foundation

private final class MockURLProtocol: URLProtocol {
    static var handler: ((URLRequest) throws -> (HTTPURLResponse, Data))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        do {
            guard let handler = Self.handler else {
                throw TestFailure(description: "mock URL handler is missing")
            }
            let (response, data) = try handler(request)
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}

private struct TestFailure: Error, CustomStringConvertible {
    let description: String
}

private func require(_ condition: Bool, _ message: String) throws {
    guard condition else { throw TestFailure(description: message) }
}

private func version(_ value: String) throws -> CaffoldVersion {
    guard let parsed = CaffoldVersion(value) else {
        throw TestFailure(description: "expected a valid version: \(value)")
    }
    return parsed
}

private func runTests() throws {
    try require(version("v0.1.1") == version("0.1.1"), "v prefix must be accepted")
    try require(version("0.1.1") > version("0.1.0"), "patch releases must sort")
    try require(version("0.2.0") > version("0.1.99"), "minor releases must sort")
    try require(version("1.0.0") > version("0.99.99"), "major releases must sort")
    try require(version("1.0.0") > version("1.0.0-rc.1"), "stable must follow prerelease")
    try require(
        version("1.0.0-rc.10") > version("1.0.0-rc.2"),
        "numeric prerelease identifiers must compare numerically"
    )
    try require(CaffoldVersion("1.0") == nil, "short versions must be rejected")
    try require(CaffoldVersion("release-1.0.0") == nil, "unknown prefixes must be rejected")

    let releaseData = Data(
        #"{"tag_name":"v0.1.1","html_url":"https://github.com/panarch/caffold/releases/tag/v0.1.1","draft":false,"prerelease":false}"#.utf8
    )
    let release = try decodeCaffoldRelease(releaseData)
    try require(release.version == version("0.1.1"), "release tag must provide the version")
    try require(
        release.webpageURL.absoluteString.hasSuffix("/v0.1.1"),
        "release page must be preserved"
    )
    let releaseRequest = caffoldLatestReleaseRequest(currentVersion: try version("0.1.0"))
    try require(
        releaseRequest.url?.absoluteString == "https://api.github.com/repos/panarch/caffold/releases/latest",
        "update checks must use the canonical GitHub release endpoint"
    )
    try require(
        releaseRequest.value(forHTTPHeaderField: "User-Agent") == "CaffoldServer/0.1.0",
        "GitHub update checks must identify the installed version"
    )

    let draftData = Data(
        #"{"tag_name":"v0.1.2","html_url":"https://example.invalid","draft":true,"prerelease":false}"#.utf8
    )
    do {
        _ = try decodeCaffoldRelease(draftData)
        throw TestFailure(description: "draft releases must be rejected")
    } catch ApplicationUpdateError.invalidRelease {
        // Expected.
    }

    try require(
        caffoldUpdateArguments(
            bundleURL: URL(fileURLWithPath: "/Applications/Caffold Server.app"),
            dataDirectory: URL(fileURLWithPath: "/Users/me/Library/Application Support/Caffold/data"),
            port: 5178
        ) == [
            "update",
            "--app", "/Applications/Caffold Server.app",
            "--data-dir", "/Users/me/Library/Application Support/Caffold/data",
            "--port", "5178",
            "--from-menu-bar",
        ],
        "the menu bar must hand caffold update its app, data, and port"
    )
    try require(
        updateConfirmationText(for: try version("0.18.3"))
            == "Caffold backs up this version, installs 0.18.3 with Homebrew, and restarts. If 0.18.3 does not start, this version is restored. Running Tasks keep going; open terminals close.",
        "the confirmation must say what the update does without counting Tasks"
    )

    let temporary = FileManager.default.temporaryDirectory
        .appendingPathComponent("caffold-updater-\(UUID().uuidString)", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: temporary) }
    let records = temporary.appendingPathComponent("caffold-updates", isDirectory: true)
    try require(
        latestUpdateAttempt(in: records) == nil,
        "no attempt is read before the first update"
    )
    func writeAttempt(_ id: String, _ json: String) throws {
        let directory = records
            .appendingPathComponent("attempts", isDirectory: true)
            .appendingPathComponent(id, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try Data(json.utf8).write(to: directory.appendingPathComponent("attempt.json"))
    }
    try writeAttempt(
        "20261004T100000.000Z",
        #"{"id":"20261004T100000.000Z","startedAt":"2026-10-04T10:00:00Z","finishedAt":"2026-10-04T10:01:00Z","fromVersion":"0.18.2","toVersion":"0.18.3","startedFromMenuBar":true,"pid":1,"outcome":"succeeded","reason":null}"#
    )
    try writeAttempt(
        "20261004T110000.000Z",
        #"{"id":"20261004T110000.000Z","startedAt":"2026-10-04T11:00:00Z","finishedAt":"2026-10-04T11:02:00Z","fromVersion":"0.18.2","toVersion":"0.18.3","startedFromMenuBar":true,"pid":2,"outcome":"rolledBack","reason":"0.18.3 could not start"}"#
    )
    try writeAttempt("20261004T120000.000Z", "not a record")
    let latest = latestUpdateAttempt(in: records)
    try require(
        latest == UpdateAttempt(
            id: "20261004T110000.000Z",
            fromVersion: "0.18.2",
            toVersion: "0.18.3",
            startedFromMenuBar: true,
            outcome: .rolledBack,
            reason: "0.18.3 could not start"
        ),
        "the newest readable attempt must be the result to show"
    )

    let rolledBack = updateResultAlert(for: latest!, recordsDirectory: records)
    try require(
        rolledBack == UpdateResultAlert(
            title: "Caffold update was rolled back",
            detail: "0.18.3 could not start, so Caffold 0.18.2 was restored.\n\nThe records are in \(records.path).",
            isWarning: true,
            showsRecords: true
        ),
        "a rollback must say why and where its records are"
    )
    func alert(_ outcome: UpdateAttempt.Outcome, reason: String? = nil) -> UpdateResultAlert? {
        updateResultAlert(
            for: UpdateAttempt(
                id: "id",
                fromVersion: "0.18.2",
                toVersion: "0.18.3",
                startedFromMenuBar: true,
                outcome: outcome,
                reason: reason
            ),
            recordsDirectory: records
        )
    }
    try require(alert(.running) == nil, "a running attempt has no result yet")
    try require(
        alert(.succeeded)?.title == "Caffold was updated"
            && alert(.succeeded)?.detail == "Caffold 0.18.3 is running and the local server is ready."
            && alert(.succeeded)?.showsRecords == false,
        "a success must name the running version"
    )
    try require(
        alert(.upToDate)?.title == "Caffold is up to date" && alert(.upToDate)?.isWarning == false,
        "nothing newer is not a failure"
    )
    try require(
        alert(.homebrewFailed, reason: "Error: Download failed")?.detail
            == "Homebrew could not update Caffold, so Caffold 0.18.2 kept running.\n\nError: Download failed",
        "a Homebrew failure must say Caffold kept running and what Homebrew said"
    )
    try require(
        alert(.restoreFailed, reason: "0.18.3 could not start, and 0.18.2 could not be restored")?.title
            == "Caffold update failed",
        "a failed restore must say the update failed"
    )
    try require(
        alert(.interrupted)?.showsRecords == true,
        "an interrupted update must point at its records"
    )

    let sessionConfiguration = URLSessionConfiguration.ephemeral
    sessionConfiguration.protocolClasses = [MockURLProtocol.self]
    let mockSession = URLSession(configuration: sessionConfiguration)
    MockURLProtocol.handler = { request in
        try require(
            request.url?.absoluteString == "https://api.github.com/repos/panarch/caffold/releases/latest",
            "automatic checks must request the canonical release endpoint"
        )
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: 200,
            httpVersion: nil,
            headerFields: ["Content-Type": "application/json"]
        )!
        return (response, releaseData)
    }
    let menuItem = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    let defaults = UserDefaults(suiteName: "caffold-updater-tests-\(UUID().uuidString)")!
    let updater = ApplicationUpdater(
        currentVersion: "0.1.0",
        bundleURL: temporary,
        dataDirectory: temporary,
        menuItem: menuItem,
        defaults: defaults,
        session: mockSession,
        executableResolver: { _ in nil },
        commandRunner: { _, _, _ in
            fatalError("automatic release checks must not run commands")
        },
        serverIsExternal: { false },
        serverPort: { 5178 },
        logger: { _ in }
    )
    try require(updater != nil, "a valid bundle version must create the updater")
    updater?.checkAutomatically()
    let deadline = Date().addingTimeInterval(2)
    while menuItem.title == "Checking for Updates…", Date() < deadline {
        RunLoop.main.run(until: Date().addingTimeInterval(0.01))
    }
    try require(
        menuItem.title == "Update to Caffold 0.1.1…",
        "an automatic check must expose a newer release without installing it"
    )
    try require(menuItem.isEnabled, "the available update action must be enabled")
    try require(
        updater?.aboutStatusText == "Update available: 0.1.1",
        "About must share the same release projection as the menu"
    )
}

do {
    try runTests()
    print("Caffold updater tests passed")
} catch {
    fputs("Caffold updater tests failed: \(error)\n", stderr)
    exit(1)
}

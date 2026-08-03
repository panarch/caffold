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

    let taskData = Data(
        #"{"tasks":[{"threadStatus":{"type":"idle"}},{"threadStatus":{"type":"active","activeFlags":[]}},{"threadStatus":{"type":"notLoaded"}}],"nextCursor":"page-2"}"#.utf8
    )
    let taskPage = try decodeUpdateTaskPage(taskData)
    try require(taskPage.activeCount == 1, "only canonical active thread status may block update")
    try require(taskPage.nextCursor == "page-2", "task pagination cursor must be preserved")
    let taskRequest = caffoldTaskPageRequest(
        baseURL: URL(string: "http://127.0.0.1:5178/")!,
        cursor: "page 2"
    )
    try require(
        taskRequest?.url?.absoluteString == "http://127.0.0.1:5178/api/tasks?cursor=page%202",
        "task cursors must be encoded without changing the local endpoint"
    )

    try require(
        homebrewUpgradeArguments() == ["upgrade", "--cask", "panarch/tap/caffold"],
        "Homebrew must remain the only application replacement path"
    )

    let temporary = FileManager.default.temporaryDirectory
        .appendingPathComponent("caffold-updater-\(UUID().uuidString)", isDirectory: true)
    let contents = temporary.appendingPathComponent("Contents", isDirectory: true)
    try FileManager.default.createDirectory(at: contents, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: temporary) }
    let plist: NSDictionary = ["CFBundleShortVersionString": "0.1.1"]
    try require(
        plist.write(to: contents.appendingPathComponent("Info.plist"), atomically: true),
        "test bundle plist must be written"
    )
    try require(
        installedBundleVersion(at: temporary) == version("0.1.1"),
        "the updated bundle version must be read from disk"
    )
    try validateHomebrewUpgrade(
        CommandResult(status: 0, output: "Successfully installed"),
        expectedVersion: try version("0.1.1"),
        bundleURL: temporary
    )
    do {
        try validateHomebrewUpgrade(
            CommandResult(status: 1, output: "upgrade failed"),
            expectedVersion: try version("0.1.1"),
            bundleURL: temporary
        )
        throw TestFailure(description: "a failed Homebrew command must reject the update")
    } catch ApplicationUpdateError.upgradeFailed {
        // Expected.
    }

    let relaunchScript = caffoldRelaunchScript()
    try require(relaunchScript.contains("parent_pid=\"$1\""), "relaunch must wait for the app")
    try require(relaunchScript.contains("server_pid=\"$2\""), "relaunch must wait for its server")
    try require(relaunchScript.contains("/usr/bin/open \"$app_path\""), "relaunch must reopen the app")

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
        menuItem: menuItem,
        defaults: defaults,
        session: mockSession,
        executableResolver: { _ in nil },
        commandRunner: { _, _, _ in
            fatalError("automatic release checks must not run Homebrew")
        },
        runtimeState: { .stopped },
        serverBaseURL: { URL(string: "http://127.0.0.1:5178/")! },
        scheduleRelaunch: { _ in .success(()) },
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

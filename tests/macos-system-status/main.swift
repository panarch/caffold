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

private func voiceResponse(
    supported: Bool = true,
    installed: Bool = false,
    loaded: Bool = false,
    downloading: Bool = false
) -> WhisperStatusResponse {
    WhisperStatusResponse(
        supported: supported,
        model: WhisperStatusResponse.Model(
            id: "large-v3-turbo",
            installed: installed,
            loaded: loaded,
            downloading: downloading
        ),
        maxRecordingSeconds: 300
    )
}

private func detail(_ label: String, in status: IntegrationStatus) -> String? {
    status.details.first(where: { $0.label == label })?.value
}

private func awaitIntegrationStatus(
    _ start: (@escaping (IntegrationStatus) -> Void) -> Void
) throws -> IntegrationStatus {
    var result: IntegrationStatus?
    start { status in
        result = status
    }
    let deadline = Date().addingTimeInterval(2)
    while result == nil, Date() < deadline {
        RunLoop.main.run(until: Date().addingTimeInterval(0.01))
    }
    guard let result else {
        throw TestFailure(description: "integration status probe timed out")
    }
    return result
}

private func probeCodexFixture(
    _ json: String,
    url: URL,
    session: URLSession
) throws -> IntegrationStatus {
    MockURLProtocol.handler = { request in
        try require(request.url == url, "the menu must probe the Codex status endpoint")
        let response = HTTPURLResponse(
            url: url,
            statusCode: 200,
            httpVersion: nil,
            headerFields: ["Content-Type": "application/json"]
        )!
        return (response, Data(json.utf8))
    }
    return try awaitIntegrationStatus { completion in
        probeCodexStatus(url: url, session: session, completion: completion)
    }
}

private func runTests() throws {
    let codexStatusURL = URL(string: "http://127.0.0.1:5178/api/codex/status")!
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [MockURLProtocol.self]
    let session = URLSession(configuration: configuration)
    let initialCodex = try probeCodexFixture(
        #"{"available":true,"codexCliAvailable":true,"appServerAvailable":true,"account":{"email":"user@example.com","planType":"pro"},"diagnostics":{"codexCliVersion":"0.146.1"}}"#,
        url: codexStatusURL,
        session: session
    )
    try require(initialCodex.state == .ready, "a reported version must not change Ready state")
    try require(
        detail("Version", in: initialCodex) == "0.146.1",
        "the connected app-server version must be visible"
    )
    try require(
        detail("Account", in: initialCodex) == "user@example.com",
        "the Codex account must remain visible"
    )
    try require(detail("Plan", in: initialCodex) == "pro", "the Codex plan must remain visible")
    try require(
        initialCodex.details.map(\.label) == ["Version", "Account", "Plan"],
        "Codex integration details must keep their menu order"
    )

    let refreshedCodex = try probeCodexFixture(
        #"{"available":true,"codexCliAvailable":true,"appServerAvailable":true,"diagnostics":{"codexCliVersion":"0.147.0"}}"#,
        url: codexStatusURL,
        session: session
    )
    try require(
        detail("Version", in: refreshedCodex) == "0.147.0",
        "a repeated menu probe must show the reconnected app-server version"
    )

    let codexWithoutVersion = try probeCodexFixture(
        #"{"available":true,"codexCliAvailable":true,"appServerAvailable":true,"account":{"email":"user@example.com","planType":"pro"}}"#,
        url: codexStatusURL,
        session: session
    )
    try require(
        codexWithoutVersion.state == .ready,
        "missing version diagnostics must not change Ready state"
    )
    try require(
        detail("Version", in: codexWithoutVersion) == nil,
        "missing version diagnostics must not add an empty detail"
    )
    try require(
        detail("Account", in: codexWithoutVersion) == "user@example.com",
        "missing version diagnostics must preserve account details"
    )
    try require(
        detail("Plan", in: codexWithoutVersion) == "pro",
        "missing version diagnostics must preserve plan details"
    )

    let codexWithMalformedVersion = try probeCodexFixture(
        #"{"available":true,"codexCliAvailable":true,"appServerAvailable":true,"diagnostics":{"codexCliVersion":147}}"#,
        url: codexStatusURL,
        session: session
    )
    try require(
        codexWithMalformedVersion.state == .ready,
        "malformed version diagnostics must not change Ready state"
    )
    try require(
        detail("Version", in: codexWithMalformedVersion) == nil,
        "malformed version diagnostics must not add an empty detail"
    )

    let codexNeedsSignIn = try probeCodexFixture(
        #"{"available":false,"codexCliAvailable":true,"appServerAvailable":true,"message":"authentication required","diagnostics":{"codexCliVersion":"0.147.0"}}"#,
        url: codexStatusURL,
        session: session
    )
    try require(codexNeedsSignIn.state == .attention, "version details must not change auth state")
    try require(
        codexNeedsSignIn.status == "Sign-in required",
        "version details must not change the sign-in status"
    )
    try require(
        detail("Version", in: codexNeedsSignIn) == "0.147.0",
        "a connected app-server version must remain visible while sign-in is required"
    )

    let unavailableCodex = try probeCodexFixture(
        #"{"available":false,"codexCliAvailable":true,"appServerAvailable":false,"diagnostics":{"codexCliVersion":"0.147.0"}}"#,
        url: codexStatusURL,
        session: session
    )
    try require(unavailableCodex.state == .unavailable, "version details must not change failures")
    try require(
        unavailableCodex.status == "Unavailable",
        "version details must not change unavailable status"
    )
    try require(
        detail("Version", in: unavailableCodex) == "0.147.0",
        "a reported version must remain informational while unavailable"
    )

    let codexNotInstalled = try probeCodexFixture(
        #"{"available":false,"codexCliAvailable":false,"appServerAvailable":false,"diagnostics":{"codexCliVersion":147}}"#,
        url: codexStatusURL,
        session: session
    )
    try require(codexNotInstalled.state == .unavailable, "invalid versions must not change state")
    try require(
        codexNotInstalled.status == "Not installed",
        "invalid versions must not change the not-installed status"
    )
    try require(
        detail("Version", in: codexNotInstalled) == nil,
        "invalid versions must not add a not-installed detail"
    )

    let setup = whisperIntegrationStatus(voiceResponse())
    try require(setup.name == "Whisper", "voice status must use the Whisper integration name")
    try require(setup.state == .attention, "a missing model must need attention")
    try require(setup.status == "Setup required", "a missing model must require setup")
    try require(
        detail("Model", in: setup) == "large-v3-turbo",
        "the model ID must remain visible"
    )
    try require(detail("State", in: setup) == "Not installed", "setup must explain the model state")
    try require(detail("Limit", in: setup) == "5 minutes", "the recording limit must be readable")

    let downloading = whisperIntegrationStatus(voiceResponse(downloading: true))
    try require(downloading.state == .attention, "a download in progress must need attention")
    try require(downloading.status == "Downloading model", "download progress must be explicit")

    let installed = whisperIntegrationStatus(voiceResponse(installed: true))
    try require(installed.state == .ready, "an installed model must be ready")
    try require(installed.status == "Ready", "an installed model must report ready")
    try require(
        detail("State", in: installed) == "Installed · loads on first use",
        "lazy loading must not be mistaken for an unavailable model"
    )

    let loaded = whisperIntegrationStatus(voiceResponse(installed: true, loaded: true))
    try require(detail("State", in: loaded) == "Loaded", "a resident model must report loaded")

    let unsupported = whisperIntegrationStatus(voiceResponse(supported: false))
    try require(unsupported.state == .unavailable, "unsupported hosts must be unavailable")
    try require(unsupported.status == "Unsupported", "unsupported hosts must be explicit")

    let statusURL = URL(string: "http://127.0.0.1:5178/api/voice/status")!
    let readyData = Data(
        #"{"supported":true,"model":{"id":"large-v3-turbo","bytes":1624555275,"installed":true,"loaded":false,"downloading":false},"maxRecordingSeconds":300}"#.utf8
    )
    MockURLProtocol.handler = { request in
        try require(request.url == statusURL, "the menu must probe the local voice endpoint")
        let response = HTTPURLResponse(
            url: statusURL,
            statusCode: 200,
            httpVersion: nil,
            headerFields: ["Content-Type": "application/json"]
        )!
        return (response, readyData)
    }
    var probed: IntegrationStatus?
    probeWhisperStatus(url: statusURL, session: session) { status in
        probed = status
    }
    var deadline = Date().addingTimeInterval(2)
    while probed == nil, Date() < deadline {
        RunLoop.main.run(until: Date().addingTimeInterval(0.01))
    }
    try require(probed?.state == .ready, "the local voice response must decode as ready")
    try require(
        probed.flatMap { detail("State", in: $0) } == "Installed · loads on first use",
        "the endpoint projection must preserve lazy loading"
    )

    MockURLProtocol.handler = { request in
        try require(request.url == statusURL, "the menu must keep probing the local voice endpoint")
        let response = HTTPURLResponse(
            url: statusURL,
            statusCode: 503,
            httpVersion: nil,
            headerFields: ["Content-Type": "application/json"]
        )!
        return (response, Data())
    }
    var unavailable: IntegrationStatus?
    probeWhisperStatus(url: statusURL, session: session) { status in
        unavailable = status
    }
    deadline = Date().addingTimeInterval(2)
    while unavailable == nil, Date() < deadline {
        RunLoop.main.run(until: Date().addingTimeInterval(0.01))
    }
    try require(unavailable?.state == .unavailable, "server failures must be unavailable")
    try require(
        unavailable?.status == "Server unavailable",
        "server failures must remain distinct from model setup"
    )
}

do {
    try runTests()
    print("Caffold system status tests passed")
} catch {
    fputs("Caffold system status tests failed: \(error)\n", stderr)
    exit(1)
}

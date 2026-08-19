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

private func requestBody(_ request: URLRequest) throws -> Data {
    if let body = request.httpBody {
        return body
    }
    guard let stream = request.httpBodyStream else {
        throw TestFailure(description: "request body is missing")
    }
    stream.open()
    defer { stream.close() }
    var data = Data()
    var buffer = [UInt8](repeating: 0, count: 1_024)
    while stream.hasBytesAvailable {
        let count = stream.read(&buffer, maxLength: buffer.count)
        guard count >= 0 else {
            throw stream.streamError ?? TestFailure(description: "request body could not be read")
        }
        if count == 0 { break }
        data.append(buffer, count: count)
    }
    return data
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

private func awaitTailscaleStatus(
    _ start: (@escaping (TailscaleStatus) -> Void) -> Void
) throws -> TailscaleStatus {
    var result: TailscaleStatus?
    start { status in
        result = status
    }
    let deadline = Date().addingTimeInterval(2)
    while result == nil, Date() < deadline {
        RunLoop.main.run(until: Date().addingTimeInterval(0.01))
    }
    guard let result else {
        throw TestFailure(description: "Tailscale status request timed out")
    }
    return result
}

private func awaitTailscaleUpdate(
    _ start: (@escaping (Result<TailscaleStatus, Error>) -> Void) -> Void
) throws -> TailscaleStatus {
    var result: Result<TailscaleStatus, Error>?
    start { update in
        result = update
    }
    let deadline = Date().addingTimeInterval(2)
    while result == nil, Date() < deadline {
        RunLoop.main.run(until: Date().addingTimeInterval(0.01))
    }
    guard let result else {
        throw TestFailure(description: "Tailscale Serve update timed out")
    }
    return try result.get()
}

private func tailscaleFixture(
    state: String,
    canManage: Bool = true,
    tailnetURL: String? = nil
) -> Data {
    let url = tailnetURL.map { "\"\($0)\"" } ?? "null"
    return Data(
        """
        {
          "state": "\(state)",
          "reasonCode": "fixtureReason",
          "diagnosticMessage": "Fixture diagnostic.",
          "tailnetUrl": \(url),
          "canManage": \(canManage)
        }
        """.utf8
    )
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

private func codexFixture(
    state: String,
    blocksTaskOperations: Bool = true,
    detectedVersion: String? = "0.147.0",
    runningVersion: String? = nil,
    account: Bool = false
) -> String {
    let version = detectedVersion.map { "\"\($0)\"" } ?? "null"
    let running = runningVersion.map { "\"\($0)\"" } ?? "null"
    let detectedExecutable = state == "missing"
        ? "null"
        : "{\"path\":\"/Users/example/.local/bin/codex\",\"version\":\(version)}"
    let managedExecutable = ["missing", "unsupportedInstall", "updateRequired"].contains(state)
        ? "null"
        : "{\"path\":\"/Users/example/.local/bin/codex\",\"version\":\(version)}"
    let accountJson = account
        ? #", "account":{"email":"user@example.com","planType":"pro"}"#
        : ""
    return """
    {
      "readiness": {
        "state": "\(state)",
        "blocksTaskOperations": \(blocksTaskOperations),
        "reasonCode": "fixtureReason",
        "diagnosticMessage": "fixture diagnostic",
        "minimumSupportedVersion": "0.147.0",
        "detectedExecutable": \(detectedExecutable),
        "managedExecutable": \(managedExecutable),
        "runningAppServerVersion": \(running)
      }
      \(accountJson)
    }
    """
}

private func runTests() throws {
    let codexStatusURL = URL(string: "http://127.0.0.1:5178/api/codex/status")!
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [MockURLProtocol.self]
    let session = URLSession(configuration: configuration)

    let tailscaleStatusURL = URL(string: "http://127.0.0.1:5178/api/tailscale/status")!
    let tailscaleServeURL = URL(string: "http://127.0.0.1:5178/api/tailscale/serve")!
    let canonicalTailscaleStates: [(String, String, Bool)] = [
        ("notInstalled", "Tailscale · Not installed", false),
        ("disconnected", "Tailscale · Disconnected", false),
        ("serveOff", "Tailscale · Connected · Serve off", true),
        ("configuring", "Tailscale · Configuring Serve...", false),
        ("disabling", "Tailscale · Turning Serve off...", false),
        ("unavailable", "Tailscale · Unavailable", false),
        ("failed", "Tailscale · Failed", false),
    ]
    for (state, expectedTitle, expectedCanToggle) in canonicalTailscaleStates {
        MockURLProtocol.handler = { request in
            try require(
                request.url == tailscaleStatusURL,
                "the menu must probe the server-owned Tailscale status endpoint"
            )
            let response = HTTPURLResponse(
                url: tailscaleStatusURL,
                statusCode: 200,
                httpVersion: nil,
                headerFields: ["Content-Type": "application/json"]
            )!
            return (response, tailscaleFixture(state: state))
        }
        let status = try awaitTailscaleStatus { completion in
            probeTailscaleStatus(
                url: tailscaleStatusURL,
                session: session,
                completion: completion
            )
        }
        try require(status.title == expectedTitle, "\(state) must keep its compact menu title")
        try require(
            status.canToggleServe == expectedCanToggle,
            "\(state) must keep its canonical menu action availability"
        )
    }

    let tailnetURL = "https://caffold.example.ts.net/"
    MockURLProtocol.handler = { request in
        let response = HTTPURLResponse(
            url: tailscaleStatusURL,
            statusCode: 200,
            httpVersion: nil,
            headerFields: ["Content-Type": "application/json"]
        )!
        return (
            response,
            tailscaleFixture(state: "ready", tailnetURL: tailnetURL)
        )
    }
    let readyTailscale = try awaitTailscaleStatus { completion in
        probeTailscaleStatus(url: tailscaleStatusURL, session: session, completion: completion)
    }
    try require(readyTailscale.serveEnabled, "ready must turn the compact menu action off")
    try require(readyTailscale.canToggleServe, "a local ready response must allow disabling")
    try require(
        readyTailscale.tailnetURL?.absoluteString == tailnetURL,
        "the native menu must use the canonical tailnet URL"
    )

    MockURLProtocol.handler = { request in
        try require(request.url == tailscaleServeURL, "Serve must use the shared server endpoint")
        try require(request.httpMethod == "PUT", "Serve changes must use PUT")
        try require(
            request.value(forHTTPHeaderField: "Content-Type") == "application/json",
            "Serve changes must use JSON"
        )
        let body = try JSONSerialization.jsonObject(with: requestBody(request))
        let enabled = (body as? [String: Bool])?["enabled"]
        try require(enabled == true, "the native toggle must request only the enabled flag")
        let response = HTTPURLResponse(
            url: tailscaleServeURL,
            statusCode: 200,
            httpVersion: nil,
            headerFields: ["Content-Type": "application/json"]
        )!
        return (
            response,
            tailscaleFixture(state: "ready", tailnetURL: tailnetURL)
        )
    }
    let enabledTailscale = try awaitTailscaleUpdate { completion in
        updateTailscaleServe(
            url: tailscaleServeURL,
            enabled: true,
            session: session,
            completion: completion
        )
    }
    try require(
        enabledTailscale.tailnetURL?.absoluteString == tailnetURL,
        "the native action must consume the canonical update response"
    )

    MockURLProtocol.handler = { request in
        try require(request.url == tailscaleServeURL, "Serve off must use the shared endpoint")
        let body = try JSONSerialization.jsonObject(with: requestBody(request))
        let enabled = (body as? [String: Bool])?["enabled"]
        try require(enabled == false, "the native toggle must request the disabled state")
        let response = HTTPURLResponse(
            url: tailscaleServeURL,
            statusCode: 200,
            httpVersion: nil,
            headerFields: ["Content-Type": "application/json"]
        )!
        return (response, tailscaleFixture(state: "serveOff"))
    }
    let disabledTailscale = try awaitTailscaleUpdate { completion in
        updateTailscaleServe(
            url: tailscaleServeURL,
            enabled: false,
            session: session,
            completion: completion
        )
    }
    try require(
        disabledTailscale.state == .serveOff,
        "the native menu must consume the canonical disabled response"
    )

    MockURLProtocol.handler = { request in
        let response = HTTPURLResponse(
            url: tailscaleStatusURL,
            statusCode: 503,
            httpVersion: nil,
            headerFields: nil
        )!
        return (response, Data())
    }
    let unavailableTailscale = try awaitTailscaleStatus { completion in
        probeTailscaleStatus(url: tailscaleStatusURL, session: session, completion: completion)
    }
    try require(
        unavailableTailscale == .serverUnavailable,
        "server failures must not be classified by the native wrapper"
    )

    let initialCodex = try probeCodexFixture(
        codexFixture(
            state: "ready",
            blocksTaskOperations: false,
            runningVersion: "0.147.0",
            account: true
        ),
        url: codexStatusURL,
        session: session
    )
    try require(initialCodex.state == .ready, "canonical ready must map to Ready")
    try require(
        detail("Version", in: initialCodex) == "0.147.0",
        "the detected standalone version must be visible"
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

    let codexNeedsSignIn = try probeCodexFixture(
        codexFixture(state: "signInRequired", runningVersion: "0.147.0"),
        url: codexStatusURL,
        session: session
    )
    try require(codexNeedsSignIn.state == .attention, "sign-in must need attention")
    try require(
        codexNeedsSignIn.status == "Sign-in required",
        "canonical sign-in must keep its compact status"
    )
    try require(
        detail("Version", in: codexNeedsSignIn) == "0.147.0",
        "the standalone version must remain visible while sign-in is required"
    )

    let canonicalMappings: [(String, IntegrationState, String)] = [
        ("missing", .attention, "Setup required"),
        ("unsupportedInstall", .attention, "Setup required"),
        ("updateRequired", .attention, "Update required"),
        ("restartRequired", .attention, "Restart required"),
        ("incompatible", .unavailable, "Unavailable"),
        ("error", .unavailable, "Unavailable"),
    ]
    for (readinessState, expectedState, expectedStatus) in canonicalMappings {
        let status = try probeCodexFixture(
            codexFixture(
                state: readinessState,
                detectedVersion: readinessState == "missing" ? nil : "0.147.0",
                runningVersion: readinessState == "restartRequired" ? "0.146.0" : nil
            ),
            url: codexStatusURL,
            session: session
        )
        try require(
            status.state == expectedState,
            "\(readinessState) must use the canonical menu state"
        )
        try require(
            status.status == expectedStatus,
            "\(readinessState) must use the canonical compact summary"
        )
    }

    let updateRequired = try probeCodexFixture(
        codexFixture(state: "updateRequired", detectedVersion: "0.146.0"),
        url: codexStatusURL,
        session: session
    )
    try require(
        detail("Minimum", in: updateRequired) == "0.147.0",
        "update guidance must expose the backend-owned minimum"
    )

    let restartRequired = try probeCodexFixture(
        codexFixture(state: "restartRequired", runningVersion: "0.146.0"),
        url: codexStatusURL,
        session: session
    )
    try require(
        detail("Runtime", in: restartRequired) == "0.146.0",
        "restart guidance must expose the running runtime"
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

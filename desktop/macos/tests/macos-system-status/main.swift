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

private func voiceResponse(provider: String = "whisper", ready: Bool = false) -> VoiceStatusResponse {
    VoiceStatusResponse(provider: provider, ready: ready, maxRecordingSeconds: 300)
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
    reasonCode: String = "fixtureReason",
    canManage: Bool = true,
    tailnetURL: String? = nil
) -> Data {
    let url = tailnetURL.map { "\"\($0)\"" } ?? "null"
    return Data(
        """
        {
          "state": "\(state)",
          "reasonCode": "\(reasonCode)",
          "diagnosticMessage": "Fixture diagnostic.",
          "tailnetUrl": \(url),
          "canManage": \(canManage)
        }
        """.utf8
    )
}

private func probeAgentFixture(
    _ json: String,
    statusCode: Int = 200,
    url: URL,
    session: URLSession
) throws -> AgentStatusAnswer {
    MockURLProtocol.handler = { request in
        try require(request.url == url, "the menu must ask the agent installations endpoint")
        let response = HTTPURLResponse(
            url: url,
            statusCode: statusCode,
            httpVersion: nil,
            headerFields: ["Content-Type": "application/json"]
        )!
        return (response, Data(json.utf8))
    }
    var result: AgentStatusAnswer?
    probeAgentStatus(url: url, session: session) { answer in
        result = answer
    }
    let deadline = Date().addingTimeInterval(2)
    while result == nil, Date() < deadline {
        RunLoop.main.run(until: Date().addingTimeInterval(0.01))
    }
    guard let result else {
        throw TestFailure(description: "agent status probe timed out")
    }
    return result
}

private func runTests() throws {
    let agentStatusURL = URL(string: "http://127.0.0.1:5178/api/agent/installations")!
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

    MockURLProtocol.handler = { request in
        let response = HTTPURLResponse(
            url: tailscaleStatusURL,
            statusCode: 200,
            httpVersion: nil,
            headerFields: ["Content-Type": "application/json"]
        )!
        return (
            response,
            tailscaleFixture(state: "unavailable", reasonCode: "serveTargetConflict")
        )
    }
    let conflictingTailscale = try awaitTailscaleStatus { completion in
        probeTailscaleStatus(url: tailscaleStatusURL, session: session, completion: completion)
    }
    try require(
        conflictingTailscale.title == "Tailscale · Connected · Serve port in use",
        "a Serve port conflict must not read like an unreachable server"
    )

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

    let listed = try probeAgentFixture(
        """
        {"agents": [
          {"provider": "codex", "name": "Codex", "state": "ready", "version": "0.155.1"},
          {"provider": "claude", "name": "Claude", "state": "ready",
           "version": "2.1.239 (Claude Code)"},
          {"provider": "grok", "name": "Grok", "state": "notInstalled"},
          {"provider": "antigravity", "name": "Antigravity", "state": "unavailable",
           "version": "1.4.5"}
        ]}
        """,
        url: agentStatusURL,
        session: session
    )
    guard case let .agents(agents) = listed else {
        throw TestFailure(description: "a listed answer must read as agents")
    }
    try require(
        agents.map(\.provider) == ["codex", "claude", "grok", "antigravity"],
        "rows must keep the server's order and providers"
    )
    try require(
        agents.map(\.status.name) == ["Codex", "Claude", "Grok", "Antigravity"],
        "rows must use the names the server gives"
    )
    try require(
        agents.map(\.status.state) == [.ready, .ready, .notInstalled, .unavailable],
        "each installation state must keep its own menu state"
    )
    try require(
        agents.map(\.status.status) == ["Ready", "Ready", "Not installed", "Unavailable"],
        "each installation state must keep its own compact status"
    )
    try require(
        detail("Version", in: agents[1].status) == "2.1.239 (Claude Code)",
        "a version must read as the agent answered it"
    )
    try require(agents[2].status.details.isEmpty, "an agent that is not installed has no version")
    try require(
        detail("Version", in: agents[3].status) == "1.4.5",
        "an unavailable agent keeps the version it answered"
    )

    let refusals: [(String, IntegrationState, String)] = [
        ("task_store_migration_pending", .checking, "Preparing..."),
        ("task_store_migration_failed", .unavailable, "Unavailable"),
        ("internal_error", .unavailable, "Server unavailable"),
    ]
    for (code, expectedState, expectedStatus) in refusals {
        let answer = try probeAgentFixture(
            #"{"error":{"code":"\#(code)","message":"Caffold is preparing the Task store."}}"#,
            statusCode: 503,
            url: agentStatusURL,
            session: session
        )
        guard case let .unanswered(state, status) = answer else {
            throw TestFailure(description: "a 503 \(code) must not read as a list")
        }
        try require(
            state == expectedState && status == expectedStatus,
            "a 503 \(code) must read as \(expectedStatus)"
        )
    }

    let firstLine = AgentSection.waiting("Checking...")
    guard
        case .waiting("Server unavailable") = agentSection(
            after: .unanswered(.unavailable, "Server unavailable"),
            showing: firstLine
        )
    else {
        throw TestFailure(description: "before any list, an unanswered request only changes the line")
    }
    let shown = agentSection(after: listed, showing: firstLine)
    guard case let .agents(rows) = shown, rows.map(\.provider) == agents.map(\.provider) else {
        throw TestFailure(description: "the first list must replace the line with a row per agent")
    }
    guard
        case let .agents(kept) = agentSection(
            after: .unanswered(.unavailable, "Server unavailable"),
            showing: shown
        )
    else {
        throw TestFailure(description: "a list once received must stay when the server stops answering")
    }
    try require(
        kept.map(\.provider) == agents.map(\.provider)
            && kept.map(\.status.name) == agents.map(\.status.name),
        "the rows that stay must be the agents last listed"
    )
    try require(
        kept.allSatisfy {
            $0.status.state == .unavailable
                && $0.status.status == "Server unavailable"
                && $0.status.details.isEmpty
        },
        "each row that stays must say why it has no answer"
    )
    guard
        case let .agents(checking) = agentSection(
            after: .unanswered(.checking, "Checking..."),
            showing: shown
        ),
        checking.allSatisfy({ $0.status.state == .checking && $0.status.status == "Checking..." })
    else {
        throw TestFailure(description: "asking again must mark every row as checking")
    }

    let setup = voiceIntegrationStatus(voiceResponse())
    try require(setup.name == "Voice", "voice status must use the Voice integration name")
    try require(setup.state == .attention, "a provider that is not ready must need attention")
    try require(setup.status == "Setup required", "a provider that is not ready must require setup")
    try require(detail("Provider", in: setup) == "Whisper", "the selected provider must be readable")
    try require(detail("Limit", in: setup) == "5 minutes", "the recording limit must be readable")

    let ready = voiceIntegrationStatus(voiceResponse(provider: "openai", ready: true))
    try require(ready.state == .ready, "a ready provider must be ready")
    try require(ready.status == "Ready", "a ready provider must report ready")
    try require(detail("Provider", in: ready) == "OpenAI", "a cloud provider must be named")
    let grok = voiceIntegrationStatus(voiceResponse(provider: "grok", ready: true))
    try require(detail("Provider", in: grok) == "Grok", "Grok must be named by its product")

    let statusURL = URL(string: "http://127.0.0.1:5178/api/voice/status")!
    let readyData = Data(
        #"{"provider":"gemini","ready":true,"maxRecordingSeconds":300}"#.utf8
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
    probeVoiceStatus(url: statusURL, session: session) { status in
        probed = status
    }
    var deadline = Date().addingTimeInterval(2)
    while probed == nil, Date() < deadline {
        RunLoop.main.run(until: Date().addingTimeInterval(0.01))
    }
    try require(probed?.state == .ready, "the local voice response must decode as ready")
    try require(
        probed.flatMap { detail("Provider", in: $0) } == "Gemini",
        "the endpoint projection must name the selected provider"
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
    probeVoiceStatus(url: statusURL, session: session) { status in
        unavailable = status
    }
    deadline = Date().addingTimeInterval(2)
    while unavailable == nil, Date() < deadline {
        RunLoop.main.run(until: Date().addingTimeInterval(0.01))
    }
    try require(unavailable?.state == .unavailable, "server failures must be unavailable")
    try require(unavailable?.name == "Voice", "server failures must keep the Voice row")
    try require(
        unavailable?.status == "Server unavailable",
        "server failures must remain distinct from provider setup"
    )
}

do {
    try runTests()
    print("Caffold system status tests passed")
} catch {
    fputs("Caffold system status tests failed: \(error)\n", stderr)
    exit(1)
}

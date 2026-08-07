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

private func runTests() throws {
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
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [MockURLProtocol.self]
    let session = URLSession(configuration: configuration)
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

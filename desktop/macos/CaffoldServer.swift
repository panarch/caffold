import AppKit
import Foundation

private struct ServerSettings: Codable {
    let name: String
}

private struct UpdateServerSettingsRequest: Encodable {
    let name: String
}

final class CaffoldServer: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private var serverProcess: Process?
    private var logHandle: FileHandle?
    private var statusItem: NSStatusItem?
    private var statusMenuItem: NSMenuItem?
    private var restartMenuItem: NSMenuItem?
    private var tailscaleStatusMenuItem: NSMenuItem?
    private var tailscaleToggleMenuItem: NSMenuItem?
    private var tailnetURLMenuItem: NSMenuItem?
    private var codexStatusMenuItem: NSMenuItem?
    private var gitStatusMenuItem: NSMenuItem?
    private var githubStatusMenuItem: NSMenuItem?
    private var preferences = ServerRuntimePreferences.load()
    private var lastTailscaleStatus: TailscaleStatus?
    private var ownsServer = false
    private var serverRunning = false
    private var restartAfterTermination = false
    private var configureTailscaleAfterRestart = false

    private var localURL: URL {
        URL(string: "http://127.0.0.1:\(preferences.port)/")!
    }

    private var healthURL: URL {
        localURL.appendingPathComponent("api/health")
    }

    private var settingsURL: URL {
        localURL.appendingPathComponent("api/server/settings")
    }

    private var codexStatusURL: URL {
        localURL.appendingPathComponent("api/codex/status")
    }

    private var tailscaleTarget: String {
        "http://127.0.0.1:\(preferences.port)"
    }

    private lazy var applicationSupportDirectory: URL = {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Caffold", isDirectory: true)
    }()

    private lazy var dataDirectory = applicationSupportDirectory
        .appendingPathComponent("data", isDirectory: true)

    private lazy var logDirectory: URL = {
        FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Logs/Caffold", isDirectory: true)
    }()

    private lazy var logURL = logDirectory.appendingPathComponent("caffold.log")

    func applicationDidFinishLaunching(_ notification: Notification) {
        ProcessInfo.processInfo.disableAutomaticTermination(
            "Caffold Server keeps the local review server available"
        )
        ProcessInfo.processInfo.disableSuddenTermination()
        NSApp.setActivationPolicy(.accessory)
        installStatusMenu()
        setStatus("Checking local server...")

        checkHealth { [weak self] isRunning in
            guard let self else { return }
            if isRunning {
                self.serverRunning = true
                self.setStatus(self.serverStatusTitle(external: true))
                self.updateServerControls()
                if self.preferences.autoStartTailscaleServe {
                    self.configureTailscaleServe()
                }
                self.refreshSystemStatus()
                self.openCaffold()
            } else {
                self.startServer()
            }
        }
    }

    func applicationShouldHandleReopen(
        _ sender: NSApplication,
        hasVisibleWindows flag: Bool
    ) -> Bool {
        openCaffold()
        return true
    }

    func applicationWillTerminate(_ notification: Notification) {
        restartAfterTermination = false
        if ownsServer, let serverProcess, serverProcess.isRunning {
            serverProcess.terminate()
        }
        try? logHandle?.close()
    }

    private func installStatusMenu() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        if let button = item.button {
            button.image = menuBarIcon()
            button.toolTip = "Caffold Server"
        }

        let menu = NSMenu()
        menu.delegate = self
        menu.addItem(actionItem("Open Caffold", action: #selector(openCaffold), key: "o"))

        menu.addItem(.separator())
        menu.addItem(sectionItem("Server"))

        let status = makeStatusItem("Checking server...")
        menu.addItem(status)
        statusMenuItem = status
        menu.addItem(actionItem("Server Name...", action: #selector(changeServerName), key: "n"))
        menu.addItem(actionItem("Server Settings...", action: #selector(showServerSettings)))

        let restart = actionItem("Restart Server", action: #selector(restartServer))
        restart.isEnabled = false
        menu.addItem(restart)
        restartMenuItem = restart

        menu.addItem(.separator())
        menu.addItem(sectionItem("Remote Access"))

        let tailscaleStatus = makeStatusItem("Tailscale · Checking...")
        menu.addItem(tailscaleStatus)
        tailscaleStatusMenuItem = tailscaleStatus

        let tailnetURL = actionItem("Open Tailnet URL", action: #selector(openTailnetURL))
        tailnetURL.isEnabled = false
        menu.addItem(tailnetURL)
        tailnetURLMenuItem = tailnetURL

        let tailscaleToggle = actionItem(
            "Turn On Tailscale Serve",
            action: #selector(toggleTailscaleServe),
            key: "t"
        )
        tailscaleToggle.isEnabled = false
        menu.addItem(tailscaleToggle)
        tailscaleToggleMenuItem = tailscaleToggle

        menu.addItem(.separator())
        menu.addItem(sectionItem("Integrations"))

        let codexStatus = makeIntegrationItem("Codex")
        menu.addItem(codexStatus)
        codexStatusMenuItem = codexStatus

        let gitStatus = makeIntegrationItem("Git")
        menu.addItem(gitStatus)
        gitStatusMenuItem = gitStatus

        let githubStatus = makeIntegrationItem("GitHub CLI")
        menu.addItem(githubStatus)
        githubStatusMenuItem = githubStatus

        menu.addItem(.separator())
        menu.addItem(actionItem("Show Logs", action: #selector(showLogs), key: "l"))
        menu.addItem(actionItem("Quit", action: #selector(quit), key: "q"))

        item.menu = menu
        statusItem = item
    }

    func menuWillOpen(_ menu: NSMenu) {
        refreshSystemStatus()
    }

    private func sectionItem(_ title: String) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        item.isEnabled = false
        return item
    }

    private func makeStatusItem(_ title: String) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        item.isEnabled = false
        item.indentationLevel = 1
        return item
    }

    private func actionItem(
        _ title: String,
        action: Selector,
        key: String = ""
    ) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
        item.target = self
        item.indentationLevel = 1
        return item
    }

    private func makeIntegrationItem(_ name: String) -> NSMenuItem {
        let item = NSMenuItem(title: name, action: nil, keyEquivalent: "")
        applyIntegrationStatus(.checking(name), to: item)
        return item
    }

    private func menuBarIcon() -> NSImage {
        let image = NSImage(size: NSSize(width: 18, height: 18))
        image.lockFocus()

        NSColor.black.setStroke()

        let frame = NSBezierPath()
        frame.lineWidth = 1.7
        frame.lineCapStyle = .round
        frame.lineJoinStyle = .round
        frame.move(to: NSPoint(x: 4, y: 2.5))
        frame.line(to: NSPoint(x: 4, y: 15.5))
        frame.move(to: NSPoint(x: 14, y: 2.5))
        frame.line(to: NSPoint(x: 14, y: 15.5))
        for y in [4.2, 9.0, 13.8] {
            frame.move(to: NSPoint(x: 2.5, y: y))
            frame.line(to: NSPoint(x: 15.5, y: y))
        }
        frame.stroke()

        let braces = NSBezierPath()
        braces.lineWidth = 1.45
        braces.lineCapStyle = .round
        braces.lineJoinStyle = .round
        braces.move(to: NSPoint(x: 4, y: 4.2))
        braces.line(to: NSPoint(x: 14, y: 13.8))
        braces.move(to: NSPoint(x: 4, y: 13.8))
        braces.line(to: NSPoint(x: 14, y: 4.2))
        braces.stroke()

        image.unlockFocus()
        image.isTemplate = true
        return image
    }

    private func setStatus(_ status: String) {
        DispatchQueue.main.async { [weak self] in
            self?.statusMenuItem?.title = status
        }
    }

    private func serverStatusTitle(external: Bool = false) -> String {
        let ownership = external ? "External" : preferences.bindMode.title
        return "Running · \(ownership) · 127.0.0.1:\(preferences.port)"
    }

    private func updateServerControls() {
        if serverRunning {
            restartMenuItem?.title = "Restart Server"
            restartMenuItem?.isEnabled = ownsServer
        } else if serverProcess?.isRunning == true {
            restartMenuItem?.title = "Restart Server"
            restartMenuItem?.isEnabled = false
        } else {
            restartMenuItem?.title = "Start Server"
            restartMenuItem?.isEnabled = true
        }
    }

    private func refreshSystemStatus() {
        applyIntegrationStatus(.checking("Codex"), to: codexStatusMenuItem)
        applyIntegrationStatus(.checking("Git"), to: gitStatusMenuItem)
        applyIntegrationStatus(.checking("GitHub CLI"), to: githubStatusMenuItem)
        tailscaleStatusMenuItem?.title = "Tailscale · Checking..."
        tailscaleToggleMenuItem?.isEnabled = false
        tailnetURLMenuItem?.isEnabled = false

        checkHealth { [weak self] isRunning in
            guard let self else { return }
            self.serverRunning = isRunning
            if isRunning {
                self.setStatus(self.serverStatusTitle(external: !self.ownsServer))
            } else if self.serverProcess?.isRunning == true {
                self.setStatus("Starting server...")
            } else {
                self.setStatus("Server · Stopped")
            }
            self.updateServerControls()
        }

        probeCodexStatus(url: codexStatusURL) { [weak self] status in
            self?.applyIntegrationStatus(status, to: self?.codexStatusMenuItem)
        }
        probeGitStatus { [weak self] status in
            self?.applyIntegrationStatus(status, to: self?.gitStatusMenuItem)
        }
        probeGithubStatus { [weak self] status in
            self?.applyIntegrationStatus(status, to: self?.githubStatusMenuItem)
        }
        probeTailscaleStatus(localTarget: tailscaleTarget) { [weak self] status in
            self?.applyTailscaleStatus(status)
        }
    }

    private func applyTailscaleStatus(_ status: TailscaleStatus) {
        lastTailscaleStatus = status
        tailscaleStatusMenuItem?.title = status.title
        tailnetURLMenuItem?.isEnabled = status.serveEnabled && status.tailnetURL != nil
        tailscaleToggleMenuItem?.title = status.serveEnabled
            ? "Turn Off Tailscale Serve"
            : "Turn On Tailscale Serve"
        tailscaleToggleMenuItem?.isEnabled = status.connected
    }

    private func applyIntegrationStatus(
        _ status: IntegrationStatus,
        to item: NSMenuItem?
    ) {
        guard let item else { return }
        item.title = status.name
        item.image = integrationStatusImage(status.state)
        item.isEnabled = true

        let submenu = NSMenu()
        let statusDetail = NSMenuItem(
            title: "Status · \(status.status)",
            action: nil,
            keyEquivalent: ""
        )
        statusDetail.isEnabled = false
        submenu.addItem(statusDetail)
        if !status.details.isEmpty {
            submenu.addItem(.separator())
        }
        for entry in status.details {
            let detail = NSMenuItem(
                title: "\(entry.label) · \(entry.value)",
                action: nil,
                keyEquivalent: ""
            )
            detail.isEnabled = false
            submenu.addItem(detail)
        }
        item.submenu = submenu
    }

    private func integrationStatusImage(_ state: IntegrationState) -> NSImage? {
        let symbol: String
        switch state {
        case .checking:
            symbol = "arrow.clockwise.circle"
        case .ready:
            symbol = "checkmark.circle.fill"
        case .attention:
            symbol = "exclamationmark.triangle.fill"
        case .unavailable:
            symbol = "xmark.circle.fill"
        }
        let image = NSImage(
            systemSymbolName: symbol,
            accessibilityDescription: "Integration status: \(state)"
        )
        image?.isTemplate = true
        return image
    }

    private func startServer() {
        do {
            try FileManager.default.createDirectory(
                at: dataDirectory,
                withIntermediateDirectories: true
            )
            try FileManager.default.createDirectory(
                at: logDirectory,
                withIntermediateDirectories: true
            )
            if !FileManager.default.fileExists(atPath: logURL.path) {
                FileManager.default.createFile(atPath: logURL.path, contents: nil)
            }

            let handle = try FileHandle(forWritingTo: logURL)
            try handle.seekToEnd()
            logHandle = handle

            guard let binary = Bundle.main.resourceURL?.appendingPathComponent("caffold") else {
                throw ServerError.missingBinary
            }

            let process = Process()
            process.executableURL = binary
            process.arguments = [
                "serve",
                "--host", preferences.bindMode.rawValue,
                "--port", String(preferences.port),
                "--data-dir", dataDirectory.path,
            ]
            process.currentDirectoryURL = FileManager.default.homeDirectoryForCurrentUser
            process.environment = caffoldEnvironment()
            process.standardOutput = handle
            process.standardError = handle
            process.terminationHandler = { [weak self] process in
                DispatchQueue.main.async {
                    guard let self else { return }
                    let shouldRestart = self.restartAfterTermination
                    self.restartAfterTermination = false
                    self.serverProcess = nil
                    self.ownsServer = false
                    self.serverRunning = false
                    try? self.logHandle?.close()
                    self.logHandle = nil
                    if shouldRestart {
                        self.setStatus("Restarting server...")
                        self.startServer()
                    } else {
                        self.setStatus("Server · Stopped (exit \(process.terminationStatus))")
                        self.updateServerControls()
                    }
                }
            }

            try process.run()
            serverProcess = process
            ownsServer = true
            serverRunning = false
            setStatus("Starting Caffold...")
            updateServerControls()
            waitForHealth(attemptsRemaining: 80)
        } catch {
            setStatus("Caffold failed to start")
            presentError("Caffold could not start", detail: error.localizedDescription)
        }
    }

    private func waitForHealth(attemptsRemaining: Int) {
        checkHealth { [weak self] isRunning in
            guard let self else { return }
            if isRunning {
                self.serverRunning = true
                self.setStatus(self.serverStatusTitle())
                self.updateServerControls()
                if self.preferences.autoStartTailscaleServe || self.configureTailscaleAfterRestart {
                    self.configureTailscaleAfterRestart = false
                    self.configureTailscaleServe()
                } else {
                    self.refreshSystemStatus()
                }
                self.openCaffold()
                return
            }

            guard attemptsRemaining > 0 else {
                self.setStatus("Caffold did not become ready")
                self.presentError(
                    "Caffold did not become ready",
                    detail: "Review \(self.logURL.path) for startup errors."
                )
                return
            }

            DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
                self.waitForHealth(attemptsRemaining: attemptsRemaining - 1)
            }
        }
    }

    private func checkHealth(completion: @escaping (Bool) -> Void) {
        var request = URLRequest(url: healthURL)
        request.timeoutInterval = 0.8
        URLSession.shared.dataTask(with: request) { _, response, _ in
            let statusCode = (response as? HTTPURLResponse)?.statusCode
            DispatchQueue.main.async {
                completion(statusCode == 200)
            }
        }.resume()
    }

    private func loadServerSettings(
        completion: @escaping (Result<ServerSettings, Error>) -> Void
    ) {
        var request = URLRequest(url: settingsURL)
        request.timeoutInterval = 2
        URLSession.shared.dataTask(with: request) { data, response, error in
            let result = Result {
                if let error {
                    throw error
                }
                guard
                    let response = response as? HTTPURLResponse,
                    response.statusCode == 200,
                    let data
                else {
                    throw ServerAPIError.invalidResponse
                }
                return try JSONDecoder().decode(ServerSettings.self, from: data)
            }
            DispatchQueue.main.async {
                completion(result)
            }
        }.resume()
    }

    private func saveServerName(
        _ name: String,
        completion: @escaping (Result<ServerSettings, Error>) -> Void
    ) {
        var request = URLRequest(url: settingsURL)
        request.httpMethod = "PATCH"
        request.timeoutInterval = 2
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        do {
            request.httpBody = try JSONEncoder().encode(UpdateServerSettingsRequest(name: name))
        } catch {
            completion(.failure(error))
            return
        }

        URLSession.shared.dataTask(with: request) { data, response, error in
            let result = Result {
                if let error {
                    throw error
                }
                guard let response = response as? HTTPURLResponse, let data else {
                    throw ServerAPIError.invalidResponse
                }
                guard response.statusCode == 200 else {
                    let message = serverErrorMessage(data) ?? "Caffold rejected the server name."
                    throw ServerAPIError.requestFailed(message)
                }
                return try JSONDecoder().decode(ServerSettings.self, from: data)
            }
            DispatchQueue.main.async {
                completion(result)
            }
        }.resume()
    }

    private func promptForServerName(currentName: String) {
        NSApp.activate(ignoringOtherApps: true)
        let field = NSTextField(string: currentName)
        field.frame = NSRect(x: 0, y: 0, width: 320, height: 24)
        field.placeholderString = "Caffold - Mac Studio"

        let alert = NSAlert()
        alert.messageText = "Server Name"
        alert.informativeText = "This name is used when installing Caffold as a web app."
        alert.accessoryView = field
        alert.addButton(withTitle: "Save")
        alert.addButton(withTitle: "Cancel")

        guard alert.runModal() == .alertFirstButtonReturn else { return }
        let name = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else {
            presentError("Server name cannot be empty", detail: "Enter a name and try again.")
            return
        }

        setStatus("Updating server name...")
        saveServerName(name) { [weak self] result in
            guard let self else { return }
            switch result {
            case let .success(settings):
                self.refreshSystemStatus()
                self.presentInformation(
                    "Server name updated",
                    detail: "New web app installations use \"\(settings.name)\". Existing installations may need to be reinstalled."
                )
            case let .failure(error):
                self.setStatus("Server name update failed")
                self.presentError("Server name could not be updated", detail: error.localizedDescription)
            }
        }
    }

    private func promptForServerSettings(currentName: String) {
        NSApp.activate(ignoringOtherApps: true)
        let form = ServerSettingsView(name: currentName, preferences: preferences)
        let alert = NSAlert()
        alert.messageText = "Server Settings"
        alert.informativeText = "Network changes restart the server managed by this app."
        alert.accessoryView = form
        alert.addButton(withTitle: "Apply")
        alert.addButton(withTitle: "Cancel")

        guard alert.runModal() == .alertFirstButtonReturn else { return }
        let name = form.name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else {
            presentError("Server name cannot be empty", detail: "Enter a name and try again.")
            return
        }
        guard let port = form.port, (1 ... 65_535).contains(port) else {
            presentError("Port is invalid", detail: "Enter a port from 1 through 65535.")
            return
        }

        let nextPreferences = ServerRuntimePreferences(
            bindMode: form.bindMode,
            port: port,
            autoStartTailscaleServe: form.autoStartTailscaleServe
        )
        let runtimeChanged = nextPreferences.bindMode != preferences.bindMode
            || nextPreferences.port != preferences.port

        if runtimeChanged, serverRunning, !ownsServer {
            presentError(
                "Server settings cannot be applied",
                detail: "Caffold Server is connected to an externally managed process. Stop that process before changing its address or port."
            )
            return
        }

        setStatus("Applying server settings...")
        saveServerName(name) { [weak self] result in
            guard let self else { return }
            switch result {
            case .success:
                if runtimeChanged, self.lastTailscaleStatus?.serveEnabled == true {
                    self.configureTailscaleAfterRestart = true
                }
                self.preferences = nextPreferences
                self.preferences.save()

                if runtimeChanged {
                    self.restartServerProcess()
                } else {
                    if self.preferences.autoStartTailscaleServe,
                       self.lastTailscaleStatus?.serveEnabled != true
                    {
                        self.configureTailscaleServe()
                    }
                    self.refreshSystemStatus()
                }
            case let .failure(error):
                self.setStatus("Server settings update failed")
                self.presentError(
                    "Server settings could not be updated",
                    detail: error.localizedDescription
                )
            }
        }
    }

    private func restartServerProcess() {
        if ownsServer, let serverProcess, serverProcess.isRunning {
            restartAfterTermination = true
            setStatus("Restarting server...")
            restartMenuItem?.isEnabled = false
            serverProcess.terminate()
        } else if !serverRunning {
            startServer()
        } else {
            presentInformation(
                "Server is externally managed",
                detail: "Caffold Server will not restart a process it did not start."
            )
        }
    }

    private func configureTailscaleServe() {
        guard let tailscale = caffoldExecutable(named: "tailscale") else {
            applyTailscaleStatus(TailscaleStatus(
                title: "Tailscale · Not installed",
                connected: false,
                serveEnabled: false,
                tailnetURL: nil
            ))
            appendLog("Tailscale CLI not found; local Caffold remains available.")
            return
        }
        tailscaleStatusMenuItem?.title = "Tailscale · Configuring Serve..."
        tailscaleToggleMenuItem?.isEnabled = false
        runCommand(
            executable: tailscale,
            arguments: [
                "serve", "--bg", "--yes", "--https=443",
                tailscaleTarget,
            ]
        ) { [weak self] result in
            guard let self else { return }
            switch result {
            case let .success(command) where command.status == 0:
                self.appendLog(command.output)
                self.refreshSystemStatus()
            case let .success(command):
                self.appendLog("Tailscale Serve failed: \(command.output)")
                self.tailscaleStatusMenuItem?.title = "Tailscale · Serve setup failed"
            case let .failure(error):
                self.appendLog("Failed to start Tailscale Serve: \(error.localizedDescription)")
                self.tailscaleStatusMenuItem?.title = "Tailscale · Serve setup failed"
            }
        }
    }

    private func disableTailscaleServe() {
        guard let tailscale = caffoldExecutable(named: "tailscale") else { return }
        tailscaleStatusMenuItem?.title = "Tailscale · Turning Serve off..."
        tailscaleToggleMenuItem?.isEnabled = false
        runCommand(
            executable: tailscale,
            arguments: ["serve", "--yes", "--https=443", "off"]
        ) { [weak self] result in
            guard let self else { return }
            switch result {
            case let .success(command) where command.status == 0:
                self.appendLog(command.output)
                self.refreshSystemStatus()
            case let .success(command):
                self.appendLog("Failed to disable Tailscale Serve: \(command.output)")
                self.tailscaleStatusMenuItem?.title = "Tailscale · Serve update failed"
            case let .failure(error):
                self.appendLog("Failed to disable Tailscale Serve: \(error.localizedDescription)")
                self.tailscaleStatusMenuItem?.title = "Tailscale · Serve update failed"
            }
        }
    }

    private func appendLog(_ message: String) {
        guard let data = "[CaffoldServer] \(message)\n".data(using: .utf8) else { return }
        do {
            try logHandle?.write(contentsOf: data)
        } catch {
            // There is no secondary log destination if the app log itself fails.
        }
    }

    private func presentError(_ message: String, detail: String) {
        DispatchQueue.main.async {
            NSApp.activate(ignoringOtherApps: true)
            let alert = NSAlert()
            alert.alertStyle = .warning
            alert.messageText = message
            alert.informativeText = detail
            alert.addButton(withTitle: "OK")
            alert.runModal()
        }
    }

    private func presentInformation(_ message: String, detail: String) {
        DispatchQueue.main.async {
            NSApp.activate(ignoringOtherApps: true)
            let alert = NSAlert()
            alert.alertStyle = .informational
            alert.messageText = message
            alert.informativeText = detail
            alert.addButton(withTitle: "OK")
            alert.runModal()
        }
    }

    @objc private func openCaffold() {
        NSWorkspace.shared.open(localURL)
    }

    @objc private func showLogs() {
        try? FileManager.default.createDirectory(
            at: logDirectory,
            withIntermediateDirectories: true
        )
        NSWorkspace.shared.open(logDirectory)
    }

    @objc private func changeServerName() {
        setStatus("Loading server name...")
        loadServerSettings { [weak self] result in
            guard let self else { return }
            switch result {
            case let .success(settings):
                self.promptForServerName(currentName: settings.name)
            case let .failure(error):
                self.setStatus("Server name is unavailable")
                self.presentError(
                    "Server name could not be loaded",
                    detail: error.localizedDescription
                )
            }
        }
    }

    @objc private func showServerSettings() {
        setStatus("Loading server settings...")
        loadServerSettings { [weak self] result in
            guard let self else { return }
            switch result {
            case let .success(settings):
                self.promptForServerSettings(currentName: settings.name)
            case let .failure(error):
                self.setStatus("Server settings are unavailable")
                self.presentError(
                    "Server settings could not be loaded",
                    detail: error.localizedDescription
                )
            }
        }
    }

    @objc private func restartServer() {
        restartServerProcess()
    }

    @objc private func toggleTailscaleServe() {
        if lastTailscaleStatus?.serveEnabled == true {
            disableTailscaleServe()
        } else {
            configureTailscaleServe()
        }
    }

    @objc private func openTailnetURL() {
        guard let url = lastTailscaleStatus?.tailnetURL else { return }
        NSWorkspace.shared.open(url)
    }

    @objc private func quit() {
        NSApp.terminate(nil)
    }
}

private final class ServerSettingsView: NSView {
    private let nameField: NSTextField
    private let bindModeControl: NSPopUpButton
    private let portField: NSTextField
    private let autoStartTailscaleControl: NSButton

    var name: String {
        nameField.stringValue
    }

    var bindMode: ServerBindMode {
        bindModeControl.indexOfSelectedItem == 1 ? .lan : .local
    }

    var port: Int? {
        Int(portField.stringValue)
    }

    var autoStartTailscaleServe: Bool {
        autoStartTailscaleControl.state == .on
    }

    init(name: String, preferences: ServerRuntimePreferences) {
        nameField = NSTextField(string: name)
        bindModeControl = NSPopUpButton(frame: .zero, pullsDown: false)
        portField = NSTextField(string: String(preferences.port))
        autoStartTailscaleControl = NSButton(
            checkboxWithTitle: "Start Tailscale Serve automatically",
            target: nil,
            action: nil
        )
        super.init(frame: NSRect(x: 0, y: 0, width: 390, height: 126))

        nameField.placeholderString = "Caffold - Mac Studio"
        bindModeControl.addItems(withTitles: ["Local only (127.0.0.1)", "LAN (0.0.0.0)"])
        bindModeControl.selectItem(at: preferences.bindMode == .lan ? 1 : 0)
        autoStartTailscaleControl.state = preferences.autoStartTailscaleServe ? .on : .off

        let portFormatter = NumberFormatter()
        portFormatter.numberStyle = .none
        portFormatter.minimum = 1
        portFormatter.maximum = 65_535
        portFormatter.allowsFloats = false
        portField.formatter = portFormatter

        let grid = NSGridView(views: [
            [NSTextField(labelWithString: "Name"), nameField],
            [NSTextField(labelWithString: "Listen"), bindModeControl],
            [NSTextField(labelWithString: "Port"), portField],
            [NSTextField(labelWithString: ""), autoStartTailscaleControl],
        ])
        grid.translatesAutoresizingMaskIntoConstraints = false
        grid.columnSpacing = 12
        grid.rowSpacing = 8
        grid.column(at: 0).xPlacement = .trailing
        grid.column(at: 1).xPlacement = .fill
        addSubview(grid)

        NSLayoutConstraint.activate([
            grid.leadingAnchor.constraint(equalTo: leadingAnchor),
            grid.trailingAnchor.constraint(equalTo: trailingAnchor),
            grid.topAnchor.constraint(equalTo: topAnchor),
            grid.bottomAnchor.constraint(lessThanOrEqualTo: bottomAnchor),
            nameField.widthAnchor.constraint(greaterThanOrEqualToConstant: 260),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }
}

private enum ServerError: LocalizedError {
    case missingBinary

    var errorDescription: String? {
        switch self {
        case .missingBinary:
            return "The Caffold server binary is missing from the application bundle."
        }
    }
}

private enum ServerAPIError: LocalizedError {
    case invalidResponse
    case requestFailed(String)

    var errorDescription: String? {
        switch self {
        case .invalidResponse:
            return "Caffold returned an invalid response."
        case let .requestFailed(message):
            return message
        }
    }
}

private func serverErrorMessage(_ data: Data) -> String? {
    guard
        let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
        let error = payload["error"] as? [String: Any],
        let message = error["message"] as? String
    else {
        return nil
    }
    return message
}

@main
private enum CaffoldServerApplication {
    static func main() {
        let application = NSApplication.shared
        let server = CaffoldServer()
        application.delegate = server
        application.run()
    }
}

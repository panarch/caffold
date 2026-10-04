import AppKit
import Foundation

final class ApplicationUpdater {
    typealias ExecutableResolver = (String) -> URL?
    typealias CommandRunner = (
        URL,
        [String],
        @escaping (Result<CommandResult, Error>) -> Void
    ) -> Void

    private static let lastShownAttemptKey = "update.lastShownAttemptId"
    private static let staleCheckInterval: TimeInterval = 6 * 60 * 60
    /// How long a relaunched app waits for the update that relaunched it to
    /// record its outcome.
    private static let resultChecks = 60

    private let currentVersion: CaffoldVersion
    private let bundleURL: URL
    private let dataDirectory: URL
    private let menuItem: NSMenuItem
    private let defaults: UserDefaults
    private let session: URLSession
    private let executableResolver: ExecutableResolver
    private let commandRunner: CommandRunner
    private let serverIsExternal: () -> Bool
    private let serverPort: () -> Int
    private let logger: (String) -> Void

    private var latestRelease: CaffoldRelease?
    private var lastCheckAt: Date?
    private var isChecking = false
    private var isInstalling = false

    var aboutStatusText: String? {
        if let latestRelease, latestRelease.version > currentVersion {
            return "Update available: \(latestRelease.version)"
        }
        return nil
    }

    private var recordsDirectory: URL {
        dataDirectory.appendingPathComponent("caffold-updates", isDirectory: true)
    }

    init?(
        currentVersion rawCurrentVersion: String,
        bundleURL: URL,
        dataDirectory: URL,
        menuItem: NSMenuItem,
        defaults: UserDefaults = .standard,
        session: URLSession = .shared,
        executableResolver: @escaping ExecutableResolver = caffoldExecutable,
        commandRunner: @escaping CommandRunner = runCommand,
        serverIsExternal: @escaping () -> Bool,
        serverPort: @escaping () -> Int,
        logger: @escaping (String) -> Void
    ) {
        guard let currentVersion = CaffoldVersion(rawCurrentVersion) else {
            menuItem.title = "Updates unavailable"
            menuItem.isEnabled = false
            return nil
        }
        self.currentVersion = currentVersion
        self.bundleURL = bundleURL
        self.dataDirectory = dataDirectory
        self.menuItem = menuItem
        self.defaults = defaults
        self.session = session
        self.executableResolver = executableResolver
        self.commandRunner = commandRunner
        self.serverIsExternal = serverIsExternal
        self.serverPort = serverPort
        self.logger = logger
        updateMenuTitle()
    }

    func checkAutomatically() {
        checkForUpdates(presentingResult: false)
    }

    func refreshIfStale() {
        guard
            !isChecking,
            !isInstalling,
            lastCheckAt.map({ Date().timeIntervalSince($0) >= Self.staleCheckInterval }) ?? true
        else {
            return
        }
        checkForUpdates(presentingResult: false)
    }

    func handleMenuAction() {
        if let latestRelease, latestRelease.version > currentVersion {
            beginInstall(latestRelease)
        } else {
            checkForUpdates(presentingResult: true)
        }
    }

    /// An update the menu bar started restarts the app, so the app that comes
    /// back tells its result once the update records it.
    func serverDidBecomeReady() {
        presentMenuBarResultWhenFinished(remainingChecks: Self.resultChecks)
    }

    private func checkForUpdates(presentingResult: Bool) {
        guard !isChecking, !isInstalling else { return }
        isChecking = true
        menuItem.title = "Checking for Updates…"
        menuItem.isEnabled = false

        let request = caffoldLatestReleaseRequest(currentVersion: currentVersion)

        session.dataTask(with: request) { [weak self] data, response, error in
            DispatchQueue.main.async {
                guard let self else { return }
                self.isChecking = false
                self.lastCheckAt = Date()
                do {
                    if let error { throw error }
                    guard
                        let response = response as? HTTPURLResponse,
                        response.statusCode == 200,
                        let data
                    else {
                        throw ApplicationUpdateError.invalidResponse
                    }
                    let release = try decodeCaffoldRelease(data)
                    self.latestRelease = release
                    self.updateMenuTitle()
                    if presentingResult {
                        if release.version > self.currentVersion {
                            self.beginInstall(release)
                        } else {
                            self.presentInformation(
                                "Caffold is up to date",
                                detail: "Version \(self.currentVersion) is the latest available release."
                            )
                        }
                    }
                } catch {
                    self.updateMenuTitle()
                    self.logger("Update check failed: \(error.localizedDescription)")
                    if presentingResult {
                        self.presentError(
                            "Caffold could not check for updates",
                            detail: error.localizedDescription
                        )
                    }
                }
            }
        }.resume()
    }

    private func beginInstall(_ release: CaffoldRelease) {
        guard !isInstalling else { return }
        guard !serverIsExternal() else {
            presentError(
                "Caffold cannot update right now",
                detail: ApplicationUpdateError.externallyManagedServer.localizedDescription
            )
            return
        }
        guard let brew = executableResolver("brew") else {
            presentManualInstall(for: release, error: .homebrewUnavailable)
            return
        }

        menuItem.title = "Checking Homebrew installation…"
        menuItem.isEnabled = false
        commandRunner(brew, ["list", "--cask", "--versions", "caffold"]) {
            [weak self] result in
            guard let self else { return }
            guard
                case let .success(command) = result,
                command.status == 0,
                !command.output.isEmpty
            else {
                self.updateMenuTitle()
                self.presentManualInstall(for: release, error: .notInstalledByHomebrew)
                return
            }
            self.updateMenuTitle()
            self.presentInstallConfirmation(release)
        }
    }

    private func presentInstallConfirmation(_ release: CaffoldRelease) {
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.alertStyle = .informational
        alert.messageText = "Update to Caffold \(release.version)?"
        alert.informativeText = updateConfirmationText(for: release.version)
        alert.addButton(withTitle: "Update and Restart")
        alert.addButton(withTitle: "Cancel")
        alert.addButton(withTitle: "View Release")

        switch alert.runModal() {
        case .alertFirstButtonReturn:
            runUpdate(release)
        case .alertThirdButtonReturn:
            NSWorkspace.shared.open(release.webpageURL)
        default:
            break
        }
    }

    /// Runs `caffold update` from this app. When the update restarts the app,
    /// the app that comes back reports the result; when it does not, the
    /// update has ended by the time the command does.
    private func runUpdate(_ release: CaffoldRelease) {
        guard let caffold = Bundle.main.resourceURL?.appendingPathComponent("caffold") else {
            presentError(
                "Caffold could not update",
                detail: "The caffold command is missing from the application bundle."
            )
            return
        }
        isInstalling = true
        menuItem.title = "Updating to Caffold \(release.version)…"
        menuItem.isEnabled = false
        logger("Updating Caffold to \(release.version).")
        let attemptBefore = latestUpdateAttempt(in: recordsDirectory)?.id

        commandRunner(
            caffold,
            caffoldUpdateArguments(
                bundleURL: bundleURL,
                dataDirectory: dataDirectory,
                port: serverPort()
            )
        ) { [weak self] result in
            guard let self else { return }
            self.isInstalling = false
            self.updateMenuTitle()
            if let attempt = latestUpdateAttempt(in: self.recordsDirectory),
               attempt.id != attemptBefore,
               attempt.startedFromMenuBar,
               attempt.outcome != .running {
                // A server restart during the update may have shown it already.
                if attempt.id != self.defaults.string(forKey: Self.lastShownAttemptKey) {
                    self.present(attempt)
                }
                return
            }
            // No attempt was recorded: `caffold update` refused and said why.
            let output: String
            switch result {
            case let .success(command):
                output = command.output
            case let .failure(error):
                output = error.localizedDescription
            }
            self.logger("Caffold update did not start: \(output)")
            self.presentError("Caffold could not update", detail: output)
        }
    }

    private func presentMenuBarResultWhenFinished(remainingChecks: Int) {
        guard
            let attempt = latestUpdateAttempt(in: recordsDirectory),
            attempt.startedFromMenuBar,
            attempt.id != defaults.string(forKey: Self.lastShownAttemptKey)
        else {
            return
        }
        guard attempt.outcome != .running else {
            guard remainingChecks > 0 else { return }
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
                self?.presentMenuBarResultWhenFinished(remainingChecks: remainingChecks - 1)
            }
            return
        }
        present(attempt)
    }

    /// Shows an attempt's result once.
    private func present(_ attempt: UpdateAttempt) {
        guard let result = updateResultAlert(for: attempt, recordsDirectory: recordsDirectory) else {
            return
        }
        defaults.set(attempt.id, forKey: Self.lastShownAttemptKey)
        logger("\(result.title): \(attempt.reason ?? attempt.outcome.rawValue)")
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.alertStyle = result.isWarning ? .warning : .informational
        alert.messageText = result.title
        alert.informativeText = result.detail
        if result.showsRecords {
            alert.addButton(withTitle: "Show Records")
        }
        alert.addButton(withTitle: "OK")
        if alert.runModal() == .alertFirstButtonReturn, result.showsRecords {
            NSWorkspace.shared.open(recordsDirectory)
        }
    }

    private func presentManualInstall(
        for release: CaffoldRelease,
        error: ApplicationUpdateError
    ) {
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = "Automatic update is unavailable"
        alert.informativeText = "\(error.localizedDescription) Open the release page or update manually with Homebrew."
        alert.addButton(withTitle: "View Release")
        alert.addButton(withTitle: "Cancel")
        if alert.runModal() == .alertFirstButtonReturn {
            NSWorkspace.shared.open(release.webpageURL)
        }
    }

    private func updateMenuTitle() {
        if let latestRelease, latestRelease.version > currentVersion {
            menuItem.title = "Update to Caffold \(latestRelease.version)…"
        } else {
            menuItem.title = "Check for Updates…"
        }
        menuItem.isEnabled = !isChecking && !isInstalling
    }

    private func presentError(_ message: String, detail: String) {
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = message
        alert.informativeText = detail
        alert.addButton(withTitle: "OK")
        alert.runModal()
    }

    private func presentInformation(_ message: String, detail: String) {
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.alertStyle = .informational
        alert.messageText = message
        alert.informativeText = detail
        alert.addButton(withTitle: "OK")
        alert.runModal()
    }
}

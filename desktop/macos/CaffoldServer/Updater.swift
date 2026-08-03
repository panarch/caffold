import AppKit
import Foundation

final class ApplicationUpdater {
    typealias ExecutableResolver = (String) -> URL?
    typealias CommandRunner = (
        URL,
        [String],
        @escaping (Result<CommandResult, Error>) -> Void
    ) -> Void

    private static let pendingVersionKey = "update.pendingVersion"
    private static let staleCheckInterval: TimeInterval = 6 * 60 * 60

    private let currentVersion: CaffoldVersion
    private let bundleURL: URL
    private let menuItem: NSMenuItem
    private let defaults: UserDefaults
    private let session: URLSession
    private let executableResolver: ExecutableResolver
    private let commandRunner: CommandRunner
    private let runtimeState: () -> UpdateRuntimeState
    private let serverBaseURL: () -> URL
    private let scheduleRelaunch: (String) -> Result<Void, Error>
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

    init?(
        currentVersion rawCurrentVersion: String,
        bundleURL: URL,
        menuItem: NSMenuItem,
        defaults: UserDefaults = .standard,
        session: URLSession = .shared,
        executableResolver: @escaping ExecutableResolver = caffoldExecutable,
        commandRunner: @escaping CommandRunner = runCommand,
        runtimeState: @escaping () -> UpdateRuntimeState,
        serverBaseURL: @escaping () -> URL,
        scheduleRelaunch: @escaping (String) -> Result<Void, Error>,
        logger: @escaping (String) -> Void
    ) {
        guard let currentVersion = CaffoldVersion(rawCurrentVersion) else {
            menuItem.title = "Updates unavailable"
            menuItem.isEnabled = false
            return nil
        }
        self.currentVersion = currentVersion
        self.bundleURL = bundleURL
        self.menuItem = menuItem
        self.defaults = defaults
        self.session = session
        self.executableResolver = executableResolver
        self.commandRunner = commandRunner
        self.runtimeState = runtimeState
        self.serverBaseURL = serverBaseURL
        self.scheduleRelaunch = scheduleRelaunch
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

    func serverDidBecomeReady(isOwnedServer: Bool) {
        guard let expected = defaults.string(forKey: Self.pendingVersionKey) else { return }
        guard let expectedVersion = CaffoldVersion(expected), currentVersion >= expectedVersion else {
            return
        }
        guard isOwnedServer else {
            presentError(
                "Caffold update needs attention",
                detail: "The new application is running, but port verification reached an externally managed server. Stop that server and restart Caffold to finish validation."
            )
            return
        }
        defaults.removeObject(forKey: Self.pendingVersionKey)
        presentInformation(
            "Caffold was updated",
            detail: "Caffold \(currentVersion) is running and the local server is ready."
        )
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
        guard runtimeState() != .externalServer else {
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
            self.confirmInstall(release, brew: brew)
        }
    }

    private func confirmInstall(_ release: CaffoldRelease, brew: URL) {
        switch runtimeState() {
        case .stopped:
            presentInstallConfirmation(release, brew: brew, activeTaskCount: .success(0))
        case .ownedServer:
            loadActiveTaskCount { [weak self] result in
                self?.presentInstallConfirmation(release, brew: brew, activeTaskCount: result)
            }
        case .externalServer:
            updateMenuTitle()
            presentError(
                "Caffold cannot update right now",
                detail: ApplicationUpdateError.externallyManagedServer.localizedDescription
            )
        }
    }

    private func loadActiveTaskCount(
        completion: @escaping (Result<Int, Error>) -> Void
    ) {
        loadActiveTaskPage(
            cursor: nil,
            activeCount: 0,
            visitedCursors: [],
            completion: completion
        )
    }

    private func loadActiveTaskPage(
        cursor: String?,
        activeCount: Int,
        visitedCursors: Set<String>,
        completion: @escaping (Result<Int, Error>) -> Void
    ) {
        guard let request = caffoldTaskPageRequest(
            baseURL: serverBaseURL(),
            cursor: cursor
        ) else {
            completion(.failure(ApplicationUpdateError.invalidResponse))
            return
        }
        session.dataTask(with: request) { [weak self] data, response, error in
            DispatchQueue.main.async {
                guard let self else { return }
                do {
                    if let error { throw error }
                    guard
                        let response = response as? HTTPURLResponse,
                        response.statusCode == 200,
                        let data
                    else {
                        throw ApplicationUpdateError.invalidResponse
                    }
                    let page = try decodeUpdateTaskPage(data)
                    let count = activeCount + page.activeCount
                    guard let nextCursor = page.nextCursor, !nextCursor.isEmpty else {
                        completion(.success(count))
                        return
                    }
                    guard !visitedCursors.contains(nextCursor), visitedCursors.count < 100 else {
                        throw ApplicationUpdateError.invalidResponse
                    }
                    var nextVisited = visitedCursors
                    nextVisited.insert(nextCursor)
                    self.loadActiveTaskPage(
                        cursor: nextCursor,
                        activeCount: count,
                        visitedCursors: nextVisited,
                        completion: completion
                    )
                } catch {
                    completion(.failure(error))
                }
            }
        }.resume()
    }

    private func presentInstallConfirmation(
        _ release: CaffoldRelease,
        brew: URL,
        activeTaskCount: Result<Int, Error>
    ) {
        updateMenuTitle()
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.messageText = "Update to Caffold \(release.version)?"
        switch activeTaskCount {
        case let .success(count) where count > 0:
            alert.alertStyle = .warning
            alert.informativeText = "\(count) active task\(count == 1 ? " is" : "s are") still running. Updating restarts Caffold and may interrupt active work."
        case .success:
            alert.alertStyle = .informational
            alert.informativeText = "Homebrew will replace the application, then Caffold will restart and verify the local server."
        case .failure:
            alert.alertStyle = .warning
            alert.informativeText = "Caffold could not verify whether tasks are active. Updating restarts the local server and may interrupt active work."
        }
        alert.addButton(withTitle: "Update and Restart")
        alert.addButton(withTitle: "Cancel")
        alert.addButton(withTitle: "View Release")

        switch alert.runModal() {
        case .alertFirstButtonReturn:
            runUpgrade(release, brew: brew)
        case .alertThirdButtonReturn:
            NSWorkspace.shared.open(release.webpageURL)
        default:
            break
        }
    }

    private func runUpgrade(_ release: CaffoldRelease, brew: URL) {
        isInstalling = true
        menuItem.title = "Updating to Caffold \(release.version)…"
        menuItem.isEnabled = false
        logger("Updating Caffold to \(release.version) with Homebrew.")

        commandRunner(brew, homebrewUpgradeArguments()) { [weak self] result in
            guard let self else { return }
            do {
                let command = try result.get()
                try validateHomebrewUpgrade(
                    command,
                    expectedVersion: release.version,
                    bundleURL: self.bundleURL
                )

                self.defaults.set(
                    release.version.description,
                    forKey: Self.pendingVersionKey
                )
                switch self.scheduleRelaunch(release.version.description) {
                case .success:
                    self.logger("Caffold \(release.version) installed; relaunch scheduled.")
                case let .failure(error):
                    self.defaults.removeObject(forKey: Self.pendingVersionKey)
                    throw ApplicationUpdateError.relaunchFailed(error.localizedDescription)
                }
            } catch {
                self.isInstalling = false
                self.updateMenuTitle()
                self.logger("Caffold update failed: \(error.localizedDescription)")
                self.presentError("Caffold could not update", detail: error.localizedDescription)
            }
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

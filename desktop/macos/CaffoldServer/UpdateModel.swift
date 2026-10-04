import Foundation

struct CaffoldVersion: Comparable, CustomStringConvertible {
    private enum PrereleaseIdentifier: Equatable {
        case number(Int)
        case text(String)
    }

    let major: Int
    let minor: Int
    let patch: Int
    private let prerelease: [PrereleaseIdentifier]

    var description: String {
        let core = "\(major).\(minor).\(patch)"
        guard !prerelease.isEmpty else { return core }
        let suffix = prerelease.map { identifier in
            switch identifier {
            case let .number(value):
                return String(value)
            case let .text(value):
                return value
            }
        }.joined(separator: ".")
        return "\(core)-\(suffix)"
    }

    init?(_ rawValue: String) {
        let trimmed = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
        let version = trimmed.hasPrefix("v") ? String(trimmed.dropFirst()) : trimmed
        let parts = version.split(separator: "-", maxSplits: 1, omittingEmptySubsequences: false)
        let core = parts[0].split(separator: ".", omittingEmptySubsequences: false)
        guard
            core.count == 3,
            let major = Int(core[0]), major >= 0,
            let minor = Int(core[1]), minor >= 0,
            let patch = Int(core[2]), patch >= 0
        else {
            return nil
        }

        var prerelease: [PrereleaseIdentifier] = []
        if parts.count == 2 {
            let identifiers = parts[1].split(separator: ".", omittingEmptySubsequences: false)
            guard !identifiers.isEmpty, identifiers.allSatisfy({ !$0.isEmpty }) else {
                return nil
            }
            prerelease = identifiers.map { identifier in
                if let number = Int(identifier) {
                    return .number(number)
                }
                return .text(String(identifier))
            }
        }

        self.major = major
        self.minor = minor
        self.patch = patch
        self.prerelease = prerelease
    }

    static func < (left: Self, right: Self) -> Bool {
        let leftCore = [left.major, left.minor, left.patch]
        let rightCore = [right.major, right.minor, right.patch]
        if leftCore != rightCore {
            return leftCore.lexicographicallyPrecedes(rightCore)
        }
        if left.prerelease.isEmpty || right.prerelease.isEmpty {
            return !left.prerelease.isEmpty && right.prerelease.isEmpty
        }

        for (leftIdentifier, rightIdentifier) in zip(left.prerelease, right.prerelease) {
            if leftIdentifier == rightIdentifier { continue }
            switch (leftIdentifier, rightIdentifier) {
            case let (.number(leftValue), .number(rightValue)):
                return leftValue < rightValue
            case (.number, .text):
                return true
            case (.text, .number):
                return false
            case let (.text(leftValue), .text(rightValue)):
                return leftValue < rightValue
            }
        }
        return left.prerelease.count < right.prerelease.count
    }
}

struct CaffoldRelease: Equatable {
    let version: CaffoldVersion
    let webpageURL: URL
}

private struct GitHubReleasePayload: Decodable {
    let tagName: String
    let htmlURL: URL
    let draft: Bool
    let prerelease: Bool

    enum CodingKeys: String, CodingKey {
        case tagName = "tag_name"
        case htmlURL = "html_url"
        case draft
        case prerelease
    }
}

enum ApplicationUpdateError: LocalizedError {
    case invalidRelease
    case invalidResponse
    case homebrewUnavailable
    case notInstalledByHomebrew
    case externallyManagedServer

    var errorDescription: String? {
        switch self {
        case .invalidRelease:
            return "GitHub returned an invalid Caffold release."
        case .invalidResponse:
            return "The update service returned an invalid response."
        case .homebrewUnavailable:
            return "Homebrew is not available on this Mac."
        case .notInstalledByHomebrew:
            return "This copy of Caffold is not managed by Homebrew."
        case .externallyManagedServer:
            return "Caffold is connected to an externally managed server. Stop that server before updating the application."
        }
    }
}

func decodeCaffoldRelease(_ data: Data) throws -> CaffoldRelease {
    let payload = try JSONDecoder().decode(GitHubReleasePayload.self, from: data)
    guard
        !payload.draft,
        !payload.prerelease,
        let version = CaffoldVersion(payload.tagName)
    else {
        throw ApplicationUpdateError.invalidRelease
    }
    return CaffoldRelease(version: version, webpageURL: payload.htmlURL)
}

func caffoldLatestReleaseRequest(currentVersion: CaffoldVersion) -> URLRequest {
    let url = URL(string: "https://api.github.com/repos/panarch/caffold/releases/latest")!
    var request = URLRequest(url: url)
    request.timeoutInterval = 8
    request.cachePolicy = .reloadIgnoringLocalCacheData
    request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
    request.setValue("CaffoldServer/\(currentVersion)", forHTTPHeaderField: "User-Agent")
    request.setValue("2022-11-28", forHTTPHeaderField: "X-GitHub-Api-Version")
    return request
}


/// The `caffold update` arguments that update this app and record the attempt
/// as started from the menu bar.
func caffoldUpdateArguments(bundleURL: URL, dataDirectory: URL, port: Int) -> [String] {
    [
        "update",
        "--app", bundleURL.path,
        "--data-dir", dataDirectory.path,
        "--port", String(port),
        "--from-menu-bar",
    ]
}

func updateConfirmationText(for version: CaffoldVersion) -> String {
    "Caffold backs up this version, installs \(version) with Homebrew, and restarts. If \(version) does not start, this version is restored. Running Tasks keep going; open terminals close."
}

/// One `caffold update` run, as it records itself in
/// `caffold-updates/attempts/<id>/attempt.json` under the data directory.
struct UpdateAttempt: Decodable, Equatable {
    enum Outcome: String, Decodable {
        case running
        case upToDate
        case homebrewFailed
        case succeeded
        case rolledBack
        case restoreFailed
        case interrupted
    }

    let id: String
    let fromVersion: String
    let toVersion: String?
    let startedFromMenuBar: Bool
    let outcome: Outcome
    let reason: String?
}

/// The newest attempt with a record Caffold can read. Attempt ids are their
/// UTC start times, so the newest sorts last.
func latestUpdateAttempt(in recordsDirectory: URL) -> UpdateAttempt? {
    let attempts = recordsDirectory.appendingPathComponent("attempts", isDirectory: true)
    guard let ids = try? FileManager.default.contentsOfDirectory(atPath: attempts.path) else {
        return nil
    }
    for id in ids.sorted(by: >) {
        let record = attempts
            .appendingPathComponent(id, isDirectory: true)
            .appendingPathComponent("attempt.json")
        if let data = try? Data(contentsOf: record),
           let attempt = try? JSONDecoder().decode(UpdateAttempt.self, from: data) {
            return attempt
        }
    }
    return nil
}

struct UpdateResultAlert: Equatable {
    let title: String
    let detail: String
    let isWarning: Bool
    /// Offers to open the records, for an outcome someone may need to look
    /// into.
    let showsRecords: Bool
}

/// The alert for a finished attempt; a running attempt has none yet.
func updateResultAlert(
    for attempt: UpdateAttempt,
    recordsDirectory: URL
) -> UpdateResultAlert? {
    let from = attempt.fromVersion
    let to = attempt.toVersion ?? "the new version"
    let reason = attempt.reason ?? ""
    let records = "The records are in \(recordsDirectory.path)."
    switch attempt.outcome {
    case .running:
        return nil
    case .succeeded:
        return UpdateResultAlert(
            title: "Caffold was updated",
            detail: "Caffold \(to) is running and the local server is ready.",
            isWarning: false,
            showsRecords: false
        )
    case .upToDate:
        return UpdateResultAlert(
            title: "Caffold is up to date",
            detail: "Homebrew has nothing newer than Caffold \(from).",
            isWarning: false,
            showsRecords: false
        )
    case .homebrewFailed:
        return UpdateResultAlert(
            title: "Caffold could not update",
            detail: "Homebrew could not update Caffold, so Caffold \(from) kept running.\n\n\(reason)",
            isWarning: true,
            showsRecords: true
        )
    case .rolledBack:
        return UpdateResultAlert(
            title: "Caffold update was rolled back",
            detail: "\(reason), so Caffold \(from) was restored.\n\n\(records)",
            isWarning: true,
            showsRecords: true
        )
    case .restoreFailed:
        return UpdateResultAlert(
            title: "Caffold update failed",
            detail: "\(reason).\n\n\(records)",
            isWarning: true,
            showsRecords: true
        )
    case .interrupted:
        return UpdateResultAlert(
            title: "Caffold update stopped",
            detail: "The update stopped before it finished.\n\n\(records)",
            isWarning: true,
            showsRecords: true
        )
    }
}

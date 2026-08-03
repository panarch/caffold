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

enum UpdateRuntimeState {
    case stopped
    case ownedServer
    case externalServer
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

private struct UpdateTaskPage: Decodable {
    struct Task: Decodable {
        struct ThreadStatus: Decodable {
            let type: String
        }

        let threadStatus: ThreadStatus
    }

    let tasks: [Task]
    let nextCursor: String?
}

enum ApplicationUpdateError: LocalizedError {
    case invalidRelease
    case invalidResponse
    case homebrewUnavailable
    case notInstalledByHomebrew
    case externallyManagedServer
    case upgradeFailed(String)
    case installedVersionMismatch(expected: String, found: String?)
    case relaunchFailed(String)

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
        case let .upgradeFailed(message):
            return "Homebrew could not update Caffold.\n\n\(message)"
        case let .installedVersionMismatch(expected, found):
            let actual = found ?? "unknown"
            return "Homebrew completed, but the installed app is version \(actual) instead of \(expected). The tap may still be publishing; try again shortly."
        case let .relaunchFailed(message):
            return "Caffold was updated but could not schedule its relaunch.\n\n\(message)"
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

func decodeUpdateTaskPage(_ data: Data) throws -> (activeCount: Int, nextCursor: String?) {
    let page = try JSONDecoder().decode(UpdateTaskPage.self, from: data)
    return (
        page.tasks.filter { $0.threadStatus.type == "active" }.count,
        page.nextCursor
    )
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

func caffoldTaskPageRequest(baseURL: URL, cursor: String?) -> URLRequest? {
    var components = URLComponents(
        url: baseURL.appendingPathComponent("api/tasks"),
        resolvingAgainstBaseURL: false
    )
    if let cursor {
        components?.queryItems = [URLQueryItem(name: "cursor", value: cursor)]
    }
    guard let url = components?.url else { return nil }
    var request = URLRequest(url: url)
    request.timeoutInterval = 5
    return request
}

func homebrewUpgradeArguments() -> [String] {
    ["upgrade", "--cask", "panarch/tap/caffold"]
}

func caffoldRelaunchScript() -> String {
    """
    parent_pid="$1"
    server_pid="$2"
    app_path="$3"
    attempts=0
    while /bin/kill -0 "$parent_pid" 2>/dev/null && [ "$attempts" -lt 300 ]; do
      /bin/sleep 0.1
      attempts=$((attempts + 1))
    done
    attempts=0
    while [ "$server_pid" -gt 0 ] && /bin/kill -0 "$server_pid" 2>/dev/null && [ "$attempts" -lt 150 ]; do
      /bin/sleep 0.1
      attempts=$((attempts + 1))
    done
    /usr/bin/open "$app_path"
    """
}

func installedBundleVersion(at bundleURL: URL) -> CaffoldVersion? {
    let plistURL = bundleURL.appendingPathComponent("Contents/Info.plist")
    guard
        let dictionary = NSDictionary(contentsOf: plistURL),
        let rawVersion = dictionary["CFBundleShortVersionString"] as? String
    else {
        return nil
    }
    return CaffoldVersion(rawVersion)
}

@discardableResult
func validateHomebrewUpgrade(
    _ command: CommandResult,
    expectedVersion: CaffoldVersion,
    bundleURL: URL
) throws -> CaffoldVersion {
    guard command.status == 0 else {
        let output = String(command.output.prefix(2_000))
        throw ApplicationUpdateError.upgradeFailed(
            output.isEmpty ? "Homebrew exited with status \(command.status)." : output
        )
    }
    let installedVersion = installedBundleVersion(at: bundleURL)
    guard installedVersion == expectedVersion else {
        throw ApplicationUpdateError.installedVersionMismatch(
            expected: expectedVersion.description,
            found: installedVersion?.description
        )
    }
    return expectedVersion
}

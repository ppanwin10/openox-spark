import Foundation
import CryptoKit

nonisolated struct RemoteHost: Codable, Equatable, Identifiable, Sendable {
    var name: String
    var endpoint: URL
    var caFingerprint: String?
    var connectionID: String?
    var outside: OutsideAccess?
    var preferredRoute: Route?

    var id: URL { endpoint }

    enum Route: String, Codable, Sendable { case local, outside }

    struct OutsideAccess: Codable, Equatable, Sendable {
        enum Provider: String, Codable, CaseIterable, Sendable { case tailscale, https }
        var provider: Provider
        var endpoint: URL
    }

    var workspaceURL: URL? {
        Self.webOrigin(preferredRoute == .outside ? outside?.endpoint : endpoint)
    }

    var activeFingerprint: String? { preferredRoute == .outside ? nil : caFingerprint }

    func websiteDataStoreID(for route: Route) -> UUID {
        let origin = Self.webOrigin(route == .outside ? outside?.endpoint : endpoint)?.absoluteString ?? "invalid"
        let namespace = "\(AppConfiguration.websiteDataNamespace)|host-workspace|\(endpoint.absoluteString)|\(origin)|\(caFingerprint ?? "public-ca")"
        var bytes = Array(SHA256.hash(data: Data(namespace.utf8)).prefix(16))
        bytes[6] = (bytes[6] & 0x0F) | 0x50
        bytes[8] = (bytes[8] & 0x3F) | 0x80
        return UUID(uuid: bytes.withUnsafeBytes { $0.load(as: uuid_t.self) })
    }

    static func webOrigin(_ url: URL?) -> URL? {
        guard let url, var components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let host = components.host, !host.isEmpty, components.user == nil, components.password == nil,
              components.query == nil, components.fragment == nil,
              components.port.map({ (1...65535).contains($0) }) != false,
              ["", "/", "/rpc"].contains(components.path) else {               return nil }
        switch components.scheme?.lowercased() {
        case "wss", "https": components.scheme = "https"
        case "ws", "http":
            guard ["localhost", "127.0.0.1", "::1"].contains(host.lowercased()) else { return nil }
            components.scheme = "http"
        default: return nil
        }
        components.path = ""
        return components.url
    }
}

nonisolated enum HostSelection: Codable, Equatable, Hashable, Sendable {
    case local
    case remote(endpoint: URL)
}

nonisolated struct HostConfiguration: Codable, Equatable, Sendable {
    static let defaultPort: UInt16 = 9876

    var format = 1
    var allowConnections = false
    var remoteHosts: [RemoteHost] = []
    var selection = HostSelection.local
    var remoteWorkspaceRouting = true

    init() {}

    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        format = try container.decode(Int.self, forKey: .format)
        allowConnections = try container.decode(Bool.self, forKey: .allowConnections)
        remoteHosts = try container.decodeIfPresent([RemoteHost].self, forKey: .remoteHosts) ?? []
        selection = try container.decodeIfPresent(HostSelection.self, forKey: .selection) ?? .local
        remoteWorkspaceRouting = try container.decodeIfPresent(Bool.self, forKey: .remoteWorkspaceRouting) ?? false
        if case .remote(let endpoint) = selection, !remoteHosts.contains(where: { $0.endpoint == endpoint }) {
            throw StorageMigrationError.invalidApplicationStorage("The selected Host is missing")
        }
        guard Set(remoteHosts.map(\.endpoint)).count == remoteHosts.count,
              remoteHosts.allSatisfy({ host in
                  (host.preferredRoute != .outside || host.outside != nil)
                      && (host.caFingerprint == nil || host.caFingerprint?.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil)
              }) else {
            throw StorageMigrationError.invalidApplicationStorage("Host connections require repair")
        }
    }

    static func load() throws -> Self {
        let value = try JSONDecoder().decode(Self.self, from: Data(contentsOf: AppStoragePaths.hostConfiguration))
        guard value.format == 1 else { throw StorageMigrationError.invalidApplicationStorage("Host configuration") }
        return value
    }

    func save() throws {
        guard format == 1 else { throw StorageMigrationError.invalidApplicationStorage("Host configuration") }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try FileManager.default.createDirectory(at: AppStoragePaths.configuration, withIntermediateDirectories: true)
        try encoder.encode(self).write(to: AppStoragePaths.hostConfiguration, options: .atomic)
    }
}

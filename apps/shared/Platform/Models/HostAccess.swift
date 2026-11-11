import Foundation
import Observation

@MainActor
@Observable
final class HostAccess {
    static let preferenceKey = "host.allowConnections"

    private var configuration: HostConfiguration
    private(set) var configurationError: String?
    private(set) var errorMessage: String?
    private(set) var workspaceRevision = 0
    private var pendingInvitation: URL?

    var selectedRemoteHost: RemoteHost? {
        guard case .remote(let endpoint) = selection else { return nil }
        return remoteHosts.first { $0.endpoint == endpoint }
    }

    var enabled: Bool {
        get { configuration.allowConnections }
        set {
            guard newValue != configuration.allowConnections else { return }
            guard update({ $0.allowConnections = newValue }) else { return }
            Log.app.info("HostAccess enabled=\(newValue)")
            onEnabledChange?(newValue)
        }
    }
    @ObservationIgnored var onEnabledChange: ((Bool) -> Void)?

    var remoteHosts: [RemoteHost] { configuration.remoteHosts }
    var needsWorkspaceSelection: Bool { !configuration.remoteWorkspaceRouting && !configuration.remoteHosts.isEmpty }

    var selection: HostSelection {
        get { configuration.remoteWorkspaceRouting ? configuration.selection : .local }
        set {
            guard newValue != selection || !configuration.remoteWorkspaceRouting else { return }
            if case .remote(let endpoint) = newValue, !configuration.remoteHosts.contains(where: { $0.endpoint == endpoint }) {
                staleHost()
                return
            }
            guard update({ $0.selection = newValue; $0.remoteWorkspaceRouting = true }) else { return }
            Log.app.info("HostAccess.select host=\(Self.logName(newValue))")
        }
    }

    init() {
        do { configuration = try Self.load() }
        catch {
            configuration = HostConfiguration()
            configurationError = error.localizedDescription
            Log.app.error("HostAccess.load failed error=\(LogPrivacy.text(error.localizedDescription))")
        }
    }

    @discardableResult
    func addRemoteHost(_ host: RemoteHost, invitation: URL? = nil) -> Bool {
        guard !configuration.remoteHosts.contains(where: { $0.endpoint == host.endpoint }) else {
            errorMessage = L10n.string("This Host is already saved. Open its connection details instead.")
            return false
        }
        guard update({ next in
            next.remoteHosts.append(host)
            next.selection = .remote(endpoint: host.endpoint)
            next.remoteWorkspaceRouting = true
        }) else { return false }
        pendingInvitation = invitation
        Log.app.info("HostAccess.addRemote endpoint=\(LogPrivacy.url(host.endpoint.absoluteString)) count=\(configuration.remoteHosts.count)")
        return true
    }

    @discardableResult
    func updateRemoteHost(_ host: RemoteHost) -> Bool {
        guard configuration.remoteHosts.contains(where: { $0.endpoint == host.endpoint }) else { staleHost(); return false }
        return update { next in
            next.remoteHosts = next.remoteHosts.map { $0.endpoint == host.endpoint ? host : $0 }
        }
    }

    @discardableResult
    func removeRemoteHost(_ endpoint: URL) -> Bool {
        guard update({ next in
            next.remoteHosts.removeAll { $0.endpoint == endpoint }
            if next.selection == .remote(endpoint: endpoint) { next.selection = .local }
        }) else { return false }
        Log.app.info("HostAccess.removeRemote endpoint=\(LogPrivacy.url(endpoint.absoluteString)) count=\(configuration.remoteHosts.count)")
        return true
    }

    func takeInvitation(for host: RemoteHost) -> URL? {
        guard let pendingInvitation, let workspace = host.workspaceURL,
              var components = URLComponents(url: pendingInvitation, resolvingAgainstBaseURL: false) else { return nil }
        components.fragment = nil
        guard RemoteHost.webOrigin(components.url) == workspace else { return nil }
        self.pendingInvitation = nil
        return pendingInvitation
    }

    func reloadWorkspace() { workspaceRevision += 1 }
    func dismissError() { errorMessage = nil }

    private func staleHost() {
        errorMessage = L10n.string("This saved Host changed. Reopen Host and connections before trying again.")
        Log.app.warning("HostAccess rejected a stale Host selection")
    }

    func reloadConfiguration() {
        do {
            configuration = try Self.load()
            configurationError = nil
            errorMessage = nil
        } catch {
            configurationError = error.localizedDescription
            Log.app.error("HostAccess.reload failed error=\(LogPrivacy.text(error.localizedDescription))")
        }
    }

    func resetConfiguration() {
        let original = AppStoragePaths.hostConfiguration
        let backup = original.appendingPathExtension("recovery-\(UUID().uuidString)")
        do {
            if FileManager.default.fileExists(atPath: original.path) {
                try FileManager.default.copyItem(at: original, to: backup)
            }
            let next = HostConfiguration()
            try next.save()
            configuration = next
            configurationError = nil
            errorMessage = nil
            Log.app.warning("HostAccess.reset original configuration preserved for recovery")
        } catch {
            errorMessage = error.localizedDescription
            Log.app.error("HostAccess.reset failed error=\(LogPrivacy.text(error.localizedDescription))")
        }
    }

    private static func load() throws -> HostConfiguration {
        do { return try HostConfiguration.load() }
        catch let error as CocoaError where error.code == .fileReadNoSuchFile { return HostConfiguration() }
    }

    private func update(_ change: (inout HostConfiguration) -> Void) -> Bool {
        do {
            guard configurationError == nil, try Self.load() == configuration else {
                throw StorageMigrationError.collision("Host configuration changed externally")
            }
            var next = configuration
            change(&next)
            try next.save()
            configuration = next
            errorMessage = nil
            return true
        } catch {
            errorMessage = error.localizedDescription
            Log.app.error("HostAccess.save failed error=\(error.localizedDescription)")
            return false
        }
    }

    private static func logName(_ selection: HostSelection) -> String {
        switch selection {
        case .local: "local"
        case .remote(let endpoint): "remote:\(LogPrivacy.url(endpoint.absoluteString))"
        }
    }
}

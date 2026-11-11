import CryptoKit
import Foundation
import Security
import Synchronization
import WebKit

struct HostInvitation {
    let endpoint: URL
    let pairingURL: URL?
    let caFingerprint: String?
    let connectionID: String?

    init(_ input: String) throws {
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: text), var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            throw HostConnectionError.address
        }
        guard ["http", "https"].contains(components.scheme?.lowercased() ?? "") else { throw HostConnectionError.address }
        let fragment = components.fragment
        components.fragment = nil
        guard let endpoint = RemoteHost.webOrigin(components.url),
              components.path.isEmpty || components.path == "/" else { throw HostConnectionError.address }
        self.endpoint = endpoint
        guard let fragment, !fragment.isEmpty else {
            pairingURL = nil
            caFingerprint = nil
            connectionID = nil
            return
        }
        let parts = fragment.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false)
        guard parts[0].range(of: "^/pair/[A-Za-z0-9-]{4,16}$", options: .regularExpression) != nil else {
            throw HostConnectionError.invitation
        }
        let items = parts.count == 2 ? URLComponents(string: "https://invitation.invalid/?" + parts[1])?.queryItems ?? [] : []
        if !items.isEmpty {
            guard items.count == 2, Set(items.map(\.name)) == ["host", "ca"],
                  let ca = items.first(where: { $0.name == "ca" })?.value?.lowercased(),
                  ca.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
                  let id = items.first(where: { $0.name == "host" })?.value, UUID(uuidString: id) != nil else {
                throw HostConnectionError.invitation
            }
            caFingerprint = ca
            connectionID = id
        } else {
            guard parts.count == 1 else { throw HostConnectionError.invitation }
            caFingerprint = nil
            connectionID = nil
        }
        var pairedComponents = URLComponents(url: endpoint, resolvingAgainstBaseURL: false)
        pairedComponents?.fragment = fragment
        pairingURL = pairedComponents?.url
    }
}

enum HostConnectionError: LocalizedError {
    case address, invitation, incompatible, wrongHost, certificate

    var errorDescription: String? {
        switch self {
        case .address: L10n.string("Use a trusted HTTPS Host origin or paste its pairing invitation. Do not include passwords or query parameters.")
        case .invitation: L10n.string("This is not a valid OpenOx invitation. Create a fresh invitation on the Host.")
        case .incompatible: L10n.string("This address does not provide a compatible Host workspace. Update the Host or check its HTTPS address.")
        case .wrongHost: L10n.string("This address answered as a different Host. Check the address; no workspace was opened.")
        case .certificate: L10n.string("The Host certificate or pinned identity could not be verified. Check the address and get a fresh invitation. Do not bypass certificate checks.")
        }
    }
}

nonisolated enum HostConnectionTrust {
    static func sameOrigin(_ first: URL, _ second: URL) -> Bool {
        first.scheme?.lowercased() == second.scheme?.lowercased()
            && first.host?.lowercased() == second.host?.lowercased()
            && (first.port ?? (first.scheme == "https" ? 443 : 80)) == (second.port ?? (second.scheme == "https" ? 443 : 80))
    }

    static func response(to challenge: URLAuthenticationChallenge, endpoint: URL, fingerprint: String?)
        -> (URLSession.AuthChallengeDisposition, URLCredential?) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              challenge.protectionSpace.host.lowercased() == endpoint.host?.lowercased(),
              challenge.protectionSpace.port == (endpoint.port ?? 443),
              let trust = challenge.protectionSpace.serverTrust else { return (.cancelAuthenticationChallenge, nil) }
        guard let fingerprint else { return (.performDefaultHandling, nil) }
        guard let certificates = SecTrustCopyCertificateChain(trust) as? [SecCertificate],
              let anchor = certificates.first(where: {
                  SHA256.hash(data: SecCertificateCopyData($0) as Data).map { String(format: "%02x", $0) }.joined() == fingerprint
              }),
              SecTrustSetAnchorCertificates(trust, [anchor] as CFArray) == errSecSuccess,
              SecTrustSetAnchorCertificatesOnly(trust, true) == errSecSuccess,
              SecTrustSetPolicies(trust, SecPolicyCreateSSL(true, challenge.protectionSpace.host as CFString)) == errSecSuccess,
              SecTrustEvaluateWithError(trust, nil) else { return (.cancelAuthenticationChallenge, nil) }
        return (.useCredential, URLCredential(trust: trust))
    }
}

nonisolated private final class HostConnectionDelegate: NSObject, URLSessionTaskDelegate {
    let endpoint: URL
    let fingerprint: String?
    private let rejection = Mutex(false)
    var rejectedTrust: Bool { rejection.withLock { $0 } }

    init(endpoint: URL, fingerprint: String?) {
        self.endpoint = endpoint
        self.fingerprint = fingerprint
    }

    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping @Sendable (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        let result = HostConnectionTrust.response(to: challenge, endpoint: endpoint, fingerprint: fingerprint)
        if result.0 == .cancelAuthenticationChallenge { rejection.withLock { $0 = true } }
        completionHandler(result.0, result.1)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

nonisolated struct HostConnectionSession: Decodable, Sendable {
    struct Descriptor: Decodable, Sendable { let id: String; let version: String; let connectionId: String }
    let paired: Bool
    let host: Descriptor
}

enum RemoteHostStatus: Equatable {
    case checking
    case reachable(name: String, paired: Bool?)
    case failed(String)

    var subtitle: String {
        switch self {
        case .checking: L10n.string("Checking…")
        case .reachable(_, let paired):
            if let paired {
                paired ? L10n.string("Connected and paired") : L10n.string("Reachable · pairing required")
            } else {
                L10n.string("Reachable · open workspace to check pairing")
            }
        case .failed(let reason): reason
        }
    }
}

enum RemoteHostProbe {
    static func inspect(_ host: RemoteHost) async throws -> (session: HostConnectionSession, hasPairingCookie: Bool) {
        guard let endpoint = host.workspaceURL else { throw HostConnectionError.address }
        let delegate = HostConnectionDelegate(endpoint: endpoint, fingerprint: host.activeFingerprint)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 5
        configuration.timeoutIntervalForResource = 8
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.urlCredentialStorage = nil
        let session = URLSession(configuration: configuration, delegate: delegate, delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        var request = URLRequest(url: endpoint.appendingPathComponent("api/session"), cachePolicy: .reloadIgnoringLocalCacheData)
        let cookies = await HostWorkspaceData.cookies(for: host)
        for (key, value) in HTTPCookie.requestHeaderFields(with: cookies) { request.setValue(value, forHTTPHeaderField: key) }
        let data: Data, response: URLResponse
        do { (data, response) = try await session.data(for: request) }
        catch {
            if delegate.rejectedTrust { throw HostConnectionError.certificate }
            if let urlError = error as? URLError, [.serverCertificateUntrusted, .serverCertificateHasUnknownRoot,
                .serverCertificateHasBadDate, .serverCertificateNotYetValid, .secureConnectionFailed].contains(urlError.code) {
                throw HostConnectionError.certificate
            }
            throw error
        }
        try Task.checkCancellation()
        guard (response as? HTTPURLResponse)?.statusCode == 200,
              let result = try? JSONDecoder().decode(HostConnectionSession.self, from: data) else { throw HostConnectionError.incompatible }
        if let expected = host.connectionID, result.host.connectionId != expected { throw HostConnectionError.wrongHost }
        return (result, cookies.contains { $0.name == "ox_device" })
    }

    static func status(of host: RemoteHost) async -> RemoteHostStatus {
        do {
            let result = try await inspect(host)
            return .reachable(name: result.session.host.id, paired: result.hasPairingCookie ? result.session.paired : nil)
        } catch {
            Log.app.warning("HostConnection.probe failed error=\(LogPrivacy.text(error.localizedDescription))")
            return .failed(error.localizedDescription)
        }
    }
}

enum HostWorkspaceData {
    private static var stores: [UUID: WKWebsiteDataStore] = [:]

    static func store(for host: RemoteHost) -> WKWebsiteDataStore {
        store(identifier: host.websiteDataStoreID(for: host.preferredRoute ?? .local))
    }

    private static func store(identifier: UUID) -> WKWebsiteDataStore {
        if let existing = stores[identifier] { return existing }
        let value = WKWebsiteDataStore(forIdentifier: identifier)
        stores[identifier] = value
        return value
    }

    static func cookies(for host: RemoteHost) async -> [HTTPCookie] {
        guard let hostname = host.workspaceURL?.host?.lowercased() else { return [] }
        let cookies = await withCheckedContinuation { continuation in
            store(for: host).httpCookieStore.getAllCookies { continuation.resume(returning: $0) }
        }
        return cookies.filter { $0.domain.trimmingCharacters(in: CharacterSet(charactersIn: ".")).lowercased() == hostname }
    }

    static func clear(_ host: RemoteHost, allRoutes: Bool = false) async {
        let routes: [RemoteHost.Route] = allRoutes ? [.local, .outside] : [host.preferredRoute ?? .local]
        for identifier in Set(routes.map { host.websiteDataStoreID(for: $0) }) {
            await withCheckedContinuation { continuation in
                store(identifier: identifier).removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast) {
                    continuation.resume()
                }
            }
            stores[identifier] = nil
        }
    }
}

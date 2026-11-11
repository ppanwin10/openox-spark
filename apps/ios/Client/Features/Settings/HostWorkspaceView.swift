import SwiftUI
import UIKit
import WebKit

struct HostWorkspaceView: View {
    let host: RemoteHost
    @Environment(HostAccess.self) private var access
    @State private var status = RemoteHostStatus.checking
    @State private var showingConnections = false
    @State private var initialURL: URL?
    @State private var notice: String?
    @State private var files: [HostDownloadedFile] = []
    @State private var retry = 0

    var body: some View {
        NavigationStack {
            Group {
                switch status {
                case .checking:
                    ProgressView("Checking the Host's identity…").frame(maxWidth: .infinity, maxHeight: .infinity)
                case .reachable:
                    if let initialURL {
                        HostWorkspaceWebView(host: host, initialURL: initialURL,
                            failed: { status = .failed($0) }, notice: { notice = $0 }, downloaded: { files.append($0) })
                            .accessibilityIdentifier("host.workspace")
                    }
                case .failed(let reason):
                    ContentUnavailableView {
                        Label("Couldn't Connect to Host", systemImage: "network.slash")
                    } description: {
                        Text(verbatim: reason)
                        Text("Check the network and Host identity, then try again. Your workspace has not switched to this device.")
                    } actions: {
                        Button { retry += 1 } label: {
                            Text("Try Again").frame(minHeight: Theme.Size.minimumTouchTarget)
                        }.accessibilityIdentifier("host.workspace.retry")
                    }
                }
            }
            .background(Theme.Colors.background)
            .navigationTitle(host.name)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Hosts") { showingConnections = true }.accessibilityIdentifier(A11yID.Settings.hostPicker)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Refresh", systemImage: "arrow.clockwise") { retry += 1 }
                        .accessibilityIdentifier("host.workspace.refresh")
                }
            }
            .sheet(isPresented: $showingConnections) { HostConnectionsSheet() }
            .sheet(isPresented: Binding(get: { !files.isEmpty }, set: { if !$0 { finishDownload() } })) {
                if let file = files.first {
                    NavigationStack {
                        VStack(spacing: Theme.Spacing.xl) {
                            Image(systemName: "doc").font(.largeTitle).accessibilityHidden(true)
                            Text(verbatim: file.url.lastPathComponent).font(Theme.Fonts.title)
                            ShareLink(item: file.url) {
                                Label("Save or Share", systemImage: "square.and.arrow.up").frame(minHeight: Theme.Size.minimumTouchTarget)
                            }
                                .accessibilityIdentifier("host.download.share")
                        }.padding(Theme.Spacing.xl)
                            .navigationTitle("Download Ready")
                            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { finishDownload() }.accessibilityIdentifier("host.download.done") } }
                    }
                }
            }
            .alert("Host Workspace", isPresented: Binding(get: { notice != nil }, set: { if !$0 { notice = nil } })) {
                Button("OK", role: .cancel) { notice = nil }
            } message: { Text(notice ?? "") }
            .task(id: retry) {
                status = .checking
                initialURL = access.takeInvitation(for: host) ?? host.workspaceURL
                let result = await RemoteHostProbe.status(of: host)
                guard !Task.isCancelled else { return }
                status = result
            }
            .onDisappear {
                for file in files { removeDownload(file) }
                files = []
            }
        }
        .tint(Theme.Colors.primary)
        .environment(\.locale, AppLocale.shared.locale)
    }

    private func finishDownload() {
        guard !files.isEmpty else { return }
        removeDownload(files.removeFirst())
    }

    private func removeDownload(_ file: HostDownloadedFile) {
        do { try FileManager.default.removeItem(at: file.directory) }
        catch {
            notice = error.localizedDescription
            Log.app.error("HostWorkspace.download cleanup failed error=\(LogPrivacy.text(error.localizedDescription))")
        }
    }
}

private struct HostDownloadedFile {
    let directory: URL
    let url: URL
}

private struct HostWorkspaceWebView: UIViewRepresentable {
    let host: RemoteHost
    let initialURL: URL
    let failed: (String) -> Void
    let notice: (String) -> Void
    let downloaded: (HostDownloadedFile) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = HostWorkspaceData.store(for: host)
        configuration.allowsInlineMediaPlayback = true
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = context.coordinator
        view.uiDelegate = context.coordinator
        view.isOpaque = false
        view.backgroundColor = UIColor(Theme.Colors.background.dynamic)
        #if targetEnvironment(simulator)
        view.isInspectable = true
        #endif
        view.load(URLRequest(url: initialURL))
        return view
    }

    func updateUIView(_ view: WKWebView, context: Context) {}

    static func dismantleUIView(_ view: WKWebView, coordinator: Coordinator) {
        coordinator.stop()
        view.stopLoading()
        view.loadHTMLString("", baseURL: nil)
        view.navigationDelegate = nil
        view.uiDelegate = nil
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
        private struct Transfer { let download: WKDownload; var file: HostDownloadedFile? }
        let parent: HostWorkspaceWebView
        private var transfers: [ObjectIdentifier: Transfer] = [:]
        private var stopping = false

        init(_ parent: HostWorkspaceWebView) { self.parent = parent }

        private func owns(_ url: URL) -> Bool {
            guard let endpoint = parent.host.workspaceURL else { return false }
            if url.scheme == "blob", let underlying = URL(string: String(url.absoluteString.dropFirst(5))) {
                return HostConnectionTrust.sameOrigin(underlying, endpoint)
            }
            return HostConnectionTrust.sameOrigin(url, endpoint)
        }

        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
            if ["about:blank", "about:srcdoc"].contains(url.absoluteString) { decisionHandler(.allow); return }
            guard owns(url) else {
                decisionHandler(.cancel)
                if navigationAction.navigationType == .linkActivated, ["https", "http", "mailto", "tel"].contains(url.scheme ?? "") {
                    UIApplication.shared.open(url)
                } else {
                    parent.notice(L10n.string("Navigation left the selected Host and was blocked. Change Hosts in Host and connections."))
                }
                return
            }
            decisionHandler(navigationAction.shouldPerformDownload ? .download : .allow)
        }

        func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
            let attachment = (navigationResponse.response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Disposition")?.lowercased().hasPrefix("attachment") == true
            decisionHandler(attachment || !navigationResponse.canShowMIMEType ? .download : .allow)
        }

        func webView(_ webView: WKWebView, didReceive challenge: URLAuthenticationChallenge,
                     completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
            guard let endpoint = parent.host.workspaceURL else { completionHandler(.cancelAuthenticationChallenge, nil); return }
            let result = HostConnectionTrust.response(to: challenge, endpoint: endpoint, fingerprint: parent.host.activeFingerprint)
            completionHandler(result.0, result.1)
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: any Error) { navigationFailed(error) }
        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: any Error) { navigationFailed(error) }

        private func navigationFailed(_ error: any Error) {
            guard !stopping, (error as NSError).code != NSURLErrorCancelled else { return }
            parent.failed(error.localizedDescription)
            Log.app.warning("HostWorkspace.navigation failed domain=\((error as NSError).domain) code=\((error as NSError).code)")
        }

        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                     for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            if let url = navigationAction.request.url, owns(url) { webView.load(navigationAction.request) }
            else if navigationAction.navigationType == .linkActivated, let url = navigationAction.request.url,
                    ["http", "https"].contains(url.scheme ?? "") { UIApplication.shared.open(url) }
            return nil
        }

        func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { begin(download) }
        func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { begin(download) }

        private func begin(_ download: WKDownload) {
            transfers[ObjectIdentifier(download)] = Transfer(download: download)
            download.delegate = self
        }

        func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
            do {
                let name = URL(fileURLWithPath: suggestedFilename).lastPathComponent
                guard !name.isEmpty, name != ".", name != ".." else { throw CocoaError(.fileWriteInvalidFileName) }
                let directory = FileManager.default.temporaryDirectory.appendingPathComponent("host-download-\(UUID().uuidString)", isDirectory: true)
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
                let file = HostDownloadedFile(directory: directory, url: directory.appendingPathComponent(name))
                transfers[ObjectIdentifier(download)]?.file = file
                completionHandler(file.url)
            } catch { parent.notice(error.localizedDescription); completionHandler(nil) }
        }

        func download(_ download: WKDownload, didReceive challenge: URLAuthenticationChallenge,
                      completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
            guard let endpoint = parent.host.workspaceURL else { completionHandler(.cancelAuthenticationChallenge, nil); return }
            let result = HostConnectionTrust.response(to: challenge, endpoint: endpoint, fingerprint: parent.host.activeFingerprint)
            completionHandler(result.0, result.1)
        }

        func download(_ download: WKDownload, willPerformHTTPRedirection response: HTTPURLResponse,
                      newRequest request: URLRequest, decisionHandler: @escaping (WKDownload.RedirectPolicy) -> Void) {
            decisionHandler(request.url.map(owns) == true ? .allow : .cancel)
        }

        func downloadDidFinish(_ download: WKDownload) {
            guard let transfer = transfers.removeValue(forKey: ObjectIdentifier(download)), let file = transfer.file else { return }
            parent.downloaded(file)
        }

        func download(_ download: WKDownload, didFailWithError error: any Error, resumeData: Data?) {
            if let transfer = transfers.removeValue(forKey: ObjectIdentifier(download)), let file = transfer.file { cleanup(file) }
            guard !stopping else { return }
            parent.notice(error.localizedDescription)
            Log.app.warning("HostWorkspace.download failed error=\(LogPrivacy.text(error.localizedDescription))")
        }

        private func cleanup(_ file: HostDownloadedFile) {
            do { try FileManager.default.removeItem(at: file.directory) }
            catch { Log.app.error("HostWorkspace.download cleanup failed error=\(LogPrivacy.text(error.localizedDescription))") }
        }

        func stop() {
            stopping = true
            let owned = Array(transfers.values)
            transfers = [:]
            for transfer in owned {
                transfer.download.cancel { _ in }
                if let file = transfer.file { cleanup(file) }
            }
        }
    }
}

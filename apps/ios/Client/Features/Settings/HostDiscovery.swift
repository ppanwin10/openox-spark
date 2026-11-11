import AVFoundation
import Network
import Observation
import SwiftUI
import Vision
import VisionKit

@MainActor
@Observable
final class HostDiscovery {
    struct Candidate: Identifiable {
        let name: String
        let endpoint: URL
        var id: URL { endpoint }
    }

    private var browser: NWBrowser?
    private(set) var candidates: [Candidate] = []
    private(set) var errorMessage: String?

    func start() {
        guard browser == nil else { return }
        let browser = NWBrowser(for: .bonjourWithTXTRecord(type: "_openox._tcp", domain: "local."), using: .tcp)
        self.browser = browser
        browser.stateUpdateHandler = { [weak self] state in
            Task { @MainActor [weak self] in
                switch state {
                case .failed(let error), .waiting(let error):
                    self?.errorMessage = error.localizedDescription
                    Log.app.warning("HostDiscovery unavailable error=\(LogPrivacy.text(error.localizedDescription))")
                case .ready: self?.errorMessage = nil
                default: break
                }
            }
        }
        browser.browseResultsChangedHandler = { [weak self] results, _ in
            Task { @MainActor [weak self] in
                self?.candidates = results.compactMap { result in
                    guard case .service(let name, _, _, _) = result.endpoint,
                          case .bonjour(let txt) = result.metadata,
                          case .string(let address) = txt.getEntry(for: "url"),
                          let endpoint = URL(string: address), endpoint.scheme == "https",
                          RemoteHost.webOrigin(endpoint) != nil,
                          let host = endpoint.host, IPv4Address(host) != nil else { return nil }
                    let octets = host.split(separator: ".").compactMap { UInt8($0) }
                    guard octets.count == 4, octets[0] == 10 || octets[0] == 192 && octets[1] == 168
                        || octets[0] == 172 && (16...31).contains(octets[1]) else { return nil }
                    return Candidate(name: name, endpoint: endpoint)
                }.sorted { $0.name < $1.name }
            }
        }
        browser.start(queue: .main)
    }

    func stop() {
        browser?.stateUpdateHandler = nil
        browser?.browseResultsChangedHandler = nil
        browser?.cancel()
        browser = nil
    }
}

struct HostInvitationScanner: UIViewControllerRepresentable {
    let onRead: (String) -> Void
    let onError: (String) -> Void

    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        let parent: HostInvitationScanner
        private var finished = false

        init(_ parent: HostInvitationScanner) { self.parent = parent }

        func dataScanner(_ dataScanner: DataScannerViewController, didAdd addedItems: [RecognizedItem], allItems: [RecognizedItem]) {
            guard !finished else { return }
            for case .barcode(let barcode) in addedItems {
                guard let payload = barcode.payloadStringValue else { continue }
                do {
                    guard try HostInvitation(payload).pairingURL != nil else { throw HostConnectionError.invitation }
                    finished = true
                    dataScanner.stopScanning()
                    parent.onRead(payload)
                    return
                } catch { parent.onError(error.localizedDescription) }
            }
        }

        func dataScanner(_ dataScanner: DataScannerViewController, becameUnavailableWithError error: DataScannerViewController.ScanningUnavailable) {
            parent.onError(error.localizedDescription)
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIViewController(context: Context) -> DataScannerViewController {
        let scanner = DataScannerViewController(recognizedDataTypes: [.barcode(symbologies: [.qr])],
            qualityLevel: .balanced, recognizesMultipleItems: false, isHighFrameRateTrackingEnabled: false,
            isPinchToZoomEnabled: true, isGuidanceEnabled: true, isHighlightingEnabled: true)
        scanner.delegate = context.coordinator
        do { try scanner.startScanning() }
        catch { Task { @MainActor in onError(error.localizedDescription) } }
        return scanner
    }

    func updateUIViewController(_ controller: DataScannerViewController, context: Context) {}

    static func dismantleUIViewController(_ controller: DataScannerViewController, coordinator: Coordinator) {
        controller.stopScanning()
    }
}

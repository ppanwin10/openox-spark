import AVFoundation
import SwiftUI
import UIKit
import VisionKit

struct HostConnectionsSheet: View {
    var invitation: String?
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            HostPickerView(invitation: invitation)
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Done") { dismiss() }.accessibilityIdentifier(A11yID.Settings.close)
                    }
                }
        }
        .tint(Theme.Colors.primary)
        .environment(\.locale, AppLocale.shared.locale)
    }
}

struct HostPickerView: View {
    var invitation: String?
    @Environment(HostAccess.self) private var access
    @State private var statuses: [URL: RemoteHostStatus] = [:]
    @State private var addingHost = false
    @State private var pendingRemoval: RemoteHost?
    @State private var receivedInvitation: String?

    static var localTitle: LocalizedStringKey {
        UIDevice.current.userInterfaceIdiom == .pad ? "This iPad" : "This iPhone"
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: SettingsLayout.sectionSpacing) {
                if access.needsWorkspaceSelection {
                    SettingsSection(layout: .group) {
                        Text("Saved connections previously checked reachability only. Select a Host again to open its workspace. Your current workspace is still on this device.")
                            .font(Theme.Fonts.bodySm).settingsRowPadding()
                    }
                }
                SettingsSection(footer: "Choose where your assistant runs and its data is stored. Switching does not move files or conversations. An unavailable Host never falls back to this device.", layout: .group) {
                    VStack(spacing: 0) {
                        Button { access.selection = .local } label: {
                            selectionRow(Text(Self.localTitle), subtitle: L10n.string("Native workspace on this device"), selected: access.selection == .local)
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier(A11yID.Settings.hostLocal)
                        .accessibilityValue(access.selection == .local ? L10n.string("Selected") : "")
                        ForEach(access.remoteHosts) { host in
                            Divider().settingsContentInset()
                            remoteRow(host)
                        }
                        Divider().settingsContentInset()
                        Button { addingHost = true } label: {
                            Label("Connect a Host", systemImage: "plus")
                                .font(Theme.Fonts.bodyMd)
                                .foregroundStyle(Theme.Colors.primary)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .settingsRowPadding()
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier(A11yID.Settings.hostAdd)
                    }
                }
                SettingsSection(footer: "Local network use needs no Tailscale account. Outside access is optional and self-managed in V1. Configure each Host's connection details; no network service is installed automatically.", layout: .group) {
                    Text("Local first. Outside access is optional.")
                        .font(Theme.Fonts.bodyMd)
                        .settingsRowPadding()
                }
            }
            .settingsPagePadding()
        }
        .background(Theme.Colors.background, ignoresSafeAreaEdges: .all)
        .navigationTitle("Host and connections")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await probeAll() }
        .task(id: access.remoteHosts) { await probeAll() }
        .task {
            if let invitation {
                receivedInvitation = invitation
                addingHost = true
            }
        }
        .sheet(isPresented: $addingHost, onDismiss: { receivedInvitation = nil }) {
            RemoteHostCreationSheet(invitation: receivedInvitation)
        }
        .alert("Couldn't Save Connections", isPresented: Binding(get: { access.errorMessage != nil }, set: { if !$0 { access.dismissError() } })) {
            Button("OK", role: .cancel) { access.dismissError() }
        } message: { Text(access.errorMessage ?? "") }
        .confirmationDialog("Remove this Host?", isPresented: Binding(get: { pendingRemoval != nil }, set: { if !$0 { pendingRemoval = nil } }),
            titleVisibility: .visible, presenting: pendingRemoval) { host in
            Button("Remove", role: .destructive) {
                guard access.removeRemoteHost(host.endpoint) else { return }
                Task { await HostWorkspaceData.clear(host, allRoutes: true) }
            }
            .accessibilityIdentifier(A11yID.Settings.hostRemoveConfirm)
            Button("Cancel", role: .cancel) {}
        } message: { _ in
            Text("Remove this connection and its cached website data from this device. The Host's files and conversations are not deleted.")
        }
    }

    private func remoteRow(_ host: RemoteHost) -> some View {
        HStack(spacing: 0) {
            Button { access.selection = .remote(endpoint: host.endpoint) } label: {
                selectionRow(Text(verbatim: host.name), subtitle: statuses[host.id]?.subtitle ?? L10n.string("Checking…"),
                    selected: access.selection == .remote(endpoint: host.endpoint))
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier(A11yID.Settings.hostRemote(host.endpoint.absoluteString))
            .accessibilityValue(access.selection == .remote(endpoint: host.endpoint) ? L10n.string("Selected") : "")
            .accessibilityAction(named: Text("Remove")) { pendingRemoval = host }
            NavigationLink { HostConnectionDetails(host: host) } label: {
                Image(systemName: "info.circle")
                    .foregroundStyle(Theme.Colors.primary)
                    .frame(minWidth: 44, minHeight: 44)
                    .padding(.trailing, Theme.Spacing.sm)
            }
            .accessibilityLabel("Connection details")
            .accessibilityIdentifier("settings.host.details.\(host.endpoint.absoluteString)")
        }
        .contextMenu {
            Button("Remove", role: .destructive) { pendingRemoval = host }
                .accessibilityIdentifier(A11yID.Settings.hostRemove(host.endpoint.absoluteString))
        }
    }

    private func selectionRow(_ title: Text, subtitle: String, selected: Bool) -> some View {
        HStack(spacing: Theme.Spacing.md) {
            VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
                title.font(Theme.Fonts.bodyMd).foregroundStyle(Theme.Colors.onSurface)
                Text(verbatim: subtitle).font(Theme.Fonts.caption).foregroundStyle(Theme.Colors.onSurfaceMuted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
            if selected { Image(systemName: "checkmark").foregroundStyle(Theme.Colors.primary).accessibilityHidden(true) }
        }
        .settingsRowPadding()
        .frame(minHeight: 44)
        .contentShape(Rectangle())
    }

    private func probeAll() async {
        let hosts = access.remoteHosts
        for host in hosts { statuses[host.id] = .checking }
        await withTaskGroup(of: (URL, RemoteHostStatus).self) { group in
            for host in hosts { group.addTask { (host.id, await RemoteHostProbe.status(of: host)) } }
            for await (id, status) in group {
                guard !Task.isCancelled else { return }
                statuses[id] = status
            }
        }
    }
}

private struct RemoteHostCreationSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(HostAccess.self) private var access
    @State private var discovery = HostDiscovery()
    @State private var name = ""
    @State private var address: String
    @State private var errorMessage: String?
    @State private var connecting = false
    @State private var scanning = false
    @State private var connectTask: Task<Void, Never>?

    init(invitation: String?) { _address = State(initialValue: invitation ?? "") }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: SettingsLayout.sectionSpacing) {
                    SettingsSection(footer: "Scan or paste an invitation from the Host or a paired device. A manually entered HTTPS address must already be trusted. Never bypass certificate warnings.", layout: .group) {
                        VStack(spacing: 0) {
                            TextField("Name", text: $name).settingsRowPadding()
                                .accessibilityIdentifier(A11yID.Settings.hostAddName)
                            Divider().settingsContentInset()
                            TextField("HTTPS address or pairing invitation", text: $address, axis: .vertical)
                                .lineLimit(2...5)
                                .textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                                .settingsRowPadding()
                                .accessibilityIdentifier(A11yID.Settings.hostAddEndpoint)
                            Divider().settingsContentInset()
                            HStack {
                                PasteButton(payloadType: String.self) { values in if let first = values.first { address = first } }
                                    .controlSize(.large)
                                    .accessibilityIdentifier("settings.host.paste")
                                Spacer()
                                Button { scan() } label: {
                                    Label("Scan invitation", systemImage: "qrcode.viewfinder")
                                        .frame(minHeight: Theme.Size.minimumTouchTarget)
                                }
                                    .disabled(!DataScannerViewController.isSupported)
                                    .accessibilityIdentifier("settings.host.scan")
                            }.settingsRowPadding()
                        }
                    }
                    SettingsSection(footer: "Nearby announcements are not proof of identity. For a private local Host, use its invitation to verify it.", layout: .group) {
                        VStack(alignment: .leading, spacing: 0) {
                            if let error = discovery.errorMessage {
                                Text(verbatim: error).foregroundStyle(Theme.Colors.error).settingsRowPadding()
                                Text("Allow Local Network access in iOS Settings, or paste the invitation.").font(Theme.Fonts.bodySm).settingsRowPadding()
                            } else if discovery.candidates.isEmpty {
                                Text("No nearby Hosts found yet. You can paste an invitation.").foregroundStyle(Theme.Colors.onSurfaceMuted).settingsRowPadding()
                            } else {
                                ForEach(discovery.candidates) { candidate in
                                    Button { address = candidate.endpoint.absoluteString } label: {
                                        VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
                                            Text(verbatim: candidate.name).font(Theme.Fonts.bodyMd)
                                            Text(verbatim: candidate.endpoint.absoluteString).font(Theme.Fonts.caption)
                                        }.frame(maxWidth: .infinity, alignment: .leading).settingsRowPadding()
                                    }
                                    .accessibilityIdentifier("settings.host.discovered.\(candidate.endpoint.absoluteString)")
                                }
                            }
                        }
                    }
                    if connecting { ProgressView("Checking the Host's identity…") }
                }.settingsPagePadding()
            }
            .background(Theme.Colors.background)
            .navigationTitle("Connect a Host")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }.accessibilityIdentifier(A11yID.Settings.hostAddCancel)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Connect") { connect() }.disabled(address.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || connecting)
                        .accessibilityIdentifier(A11yID.Settings.hostAddConfirm)
                }
            }
            .task { discovery.start() }
            .onDisappear { discovery.stop(); connectTask?.cancel() }
            .sheet(isPresented: $scanning) {
                NavigationStack {
                    HostInvitationScanner(onRead: { address = $0; scanning = false }, onError: { errorMessage = $0; scanning = false })
                        .ignoresSafeArea()
                        .navigationTitle("Scan invitation")
                        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { scanning = false }.accessibilityIdentifier("settings.host.scan.cancel") } }
                }
            }
            .alert("Couldn't Connect to Host", isPresented: Binding(get: { errorMessage != nil }, set: { if !$0 { errorMessage = nil } })) {
                Button("OK", role: .cancel) { errorMessage = nil }
            } message: { Text(errorMessage ?? "") }
        }
    }

    private func scan() {
        Task {
            guard await AVCaptureDevice.requestAccess(for: .video) else {
                errorMessage = L10n.string("Camera access is unavailable. Paste the Host invitation instead.")
                return
            }
            scanning = true
        }
    }

    private func connect() {
        connectTask = Task {
            connecting = true
            defer { connecting = false }
            do {
                let invitation = try HostInvitation(address)
                var host = RemoteHost(name: name.trimmingCharacters(in: .whitespacesAndNewlines), endpoint: invitation.endpoint,
                    caFingerprint: invitation.caFingerprint, connectionID: invitation.connectionID)
                let session = try await RemoteHostProbe.inspect(host).session
                try Task.checkCancellation()
                if host.name.isEmpty { host.name = session.host.id.isEmpty ? invitation.endpoint.host ?? "OpenOx" : session.host.id }
                host.connectionID = session.host.connectionId
                guard access.addRemoteHost(host, invitation: invitation.pairingURL) else {
                    errorMessage = access.errorMessage
                    access.dismissError()
                    return
                }
                dismiss()
            } catch is CancellationError {
            } catch {
                guard !Task.isCancelled else { return }
                errorMessage = error.localizedDescription
            }
        }
    }
}

private struct HostConnectionDetails: View {
    @Environment(HostAccess.self) private var access
    let host: RemoteHost
    @State private var outsideAddress: String
    @State private var provider: RemoteHost.OutsideAccess.Provider
    @State private var status = RemoteHostStatus.checking
    @State private var errorMessage: String?
    @State private var confirmingPairing = false
    @State private var confirmingOutsideRemoval = false

    init(host: RemoteHost) {
        self.host = host
        _outsideAddress = State(initialValue: host.outside?.endpoint.absoluteString ?? "")
        _provider = State(initialValue: host.outside?.provider ?? .tailscale)
    }

    private var current: RemoteHost { access.remoteHosts.first { $0.id == host.id } ?? host }

    var body: some View {
        ScrollView {
            VStack(spacing: SettingsLayout.sectionSpacing) {
                SettingsSection(footer: "Your assistant and its files stay on this Host. This device may cache content. A failed connection never uses the phone's Host instead.", layout: .group) {
                    VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                        Text(verbatim: current.name).font(Theme.Fonts.title)
                        Text(verbatim: status.subtitle).font(Theme.Fonts.bodySm)
                        Text(verbatim: current.workspaceURL?.absoluteString ?? current.endpoint.absoluteString)
                            .font(Theme.Fonts.caption.monospaced()).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                    }.settingsRowPadding()
                }
                SettingsSection(footer: "Choose an address explicitly. Each address is paired separately. No automatic route fallback or data migration.", layout: .group) {
                    VStack(spacing: 0) {
                        route("Primary address", .local, enabled: true)
                        Divider().settingsContentInset()
                        route("Outside address", .outside, enabled: current.outside != nil)
                    }
                }
                SettingsSection(footer: "Optional, self-managed access away from the local network. Set up Tailscale on the Host and this device, or provide an existing trusted HTTPS entry. Saving does not configure the network.", layout: .group) {
                    VStack(spacing: 0) {
                        Picker("Connection method", selection: $provider) {
                            Text("Tailscale private network").tag(RemoteHost.OutsideAccess.Provider.tailscale)
                            Text("Existing HTTPS entry").tag(RemoteHost.OutsideAccess.Provider.https)
                        }.settingsRowPadding().disabled(current.outside != nil).accessibilityIdentifier("settings.host.outside.provider")
                        Divider().settingsContentInset()
                        TextField("Outside HTTPS address", text: $outsideAddress)
                            .textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                            .disabled(current.outside != nil)
                            .settingsRowPadding().accessibilityIdentifier("settings.host.outside.address")
                        Divider().settingsContentInset()
                        if current.outside == nil {
                            Button { saveOutside() } label: {
                                Text("Save outside address").settingsRowPadding().frame(maxWidth: .infinity).contentShape(Rectangle())
                            }.accessibilityIdentifier("settings.host.outside.save")
                        } else {
                            Button(role: .destructive) { confirmingOutsideRemoval = true } label: {
                                Text("Remove outside address").settingsRowPadding().frame(maxWidth: .infinity).contentShape(Rectangle())
                            }.accessibilityIdentifier("settings.host.outside.remove")
                        }
                    }
                }
                HStack {
                    Button { Task { status = .checking; status = await RemoteHostProbe.status(of: current) } } label: {
                        SettingsActionButtonLabel { Text("Test connection") }
                    }
                        .accessibilityIdentifier("settings.host.test")
                    Spacer()
                    Button { confirmingPairing = true } label: {
                        SettingsActionButtonLabel { Text("Pair again") }
                    }.accessibilityIdentifier("settings.host.repair")
                }.font(Theme.Fonts.bodyMd)
            }.settingsPagePadding()
        }
        .background(Theme.Colors.background)
        .navigationTitle("Connection details")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: current) { status = await RemoteHostProbe.status(of: current) }
        .confirmationDialog("Pair this address again?", isPresented: $confirmingPairing, titleVisibility: .visible) {
            Button("Pair again", role: .destructive) {
                Task { await HostWorkspaceData.clear(current); access.reloadWorkspace(); status = await RemoteHostProbe.status(of: current) }
            }.accessibilityIdentifier("settings.host.repair.confirm")
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Clear this address's pairing and website cache on this device. Get a fresh code from the Host. Host files and conversations are kept.")
        }
        .confirmationDialog("Remove the saved outside address?", isPresented: $confirmingOutsideRemoval, titleVisibility: .visible) {
            Button("Remove", role: .destructive) {
                let previous = current
                var next = previous
                next.outside = nil
                next.preferredRoute = .local
                guard access.updateRemoteHost(next) else { errorMessage = access.errorMessage; return }
                outsideAddress = ""
                Task {
                    var outside = previous
                    outside.preferredRoute = .outside
                    await HostWorkspaceData.clear(outside)
                }
            }.accessibilityIdentifier("settings.host.outside.remove.confirm")
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Remove this entry and its device cache, then use the primary address. This does not stop Tailscale or delete Host files. Remove an entry before replacing it.")
        }
        .alert("Couldn't Save Connections", isPresented: Binding(get: { errorMessage != nil }, set: { if !$0 { errorMessage = nil } })) {
            Button("OK", role: .cancel) { errorMessage = nil }
        } message: { Text(errorMessage ?? "") }
    }

    private func route(_ title: LocalizedStringKey, _ route: RemoteHost.Route, enabled: Bool) -> some View {
        Button {
            var next = current
            next.preferredRoute = route
            if !access.updateRemoteHost(next) { errorMessage = access.errorMessage }
        } label: {
            HStack {
                Text(title)
                Spacer()
                if (current.preferredRoute ?? .local) == route { Image(systemName: "checkmark") }
            }.settingsRowPadding().contentShape(Rectangle())
        }
        .disabled(!enabled)
        .accessibilityIdentifier("settings.host.route.\(route.rawValue)")
    }

    private func saveOutside() {
        do {
            var next = current
            guard next.outside == nil else { throw HostConnectionError.address }
            let invitation = try HostInvitation(outsideAddress)
            guard invitation.endpoint.scheme == "https", invitation.pairingURL == nil else { throw HostConnectionError.address }
            next.outside = .init(provider: provider, endpoint: invitation.endpoint)
            guard access.updateRemoteHost(next) else { errorMessage = access.errorMessage; return }
        } catch { errorMessage = error.localizedDescription }
    }
}

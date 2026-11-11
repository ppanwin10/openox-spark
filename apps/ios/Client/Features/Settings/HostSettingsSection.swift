import SwiftUI

struct HostSettingsSection: View {
    @Environment(HostAccess.self) private var access

    private var selectedHostName: Text {
        switch access.selection {
        case .local:
            return Text(HostPickerView.localTitle)
        case .remote(let endpoint):
            return Text(verbatim: access.remoteHosts.first { $0.endpoint == endpoint }?.name ?? "")
        }
    }

    var body: some View {
        VStack(spacing: SettingsLayout.sectionSpacing) {
            SettingsSection(footer: "Choose the Host that runs your assistant and stores its files. Local use does not require Tailscale. Outside access is optional.", layout: .group) {
                NavigationLink {
                    HostPickerView()
                } label: {
                    SettingsDisclosureRow(title: "Host and connections", value: selectedHostName)
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier(A11yID.Settings.hostPicker)
            }
            SettingsSection(footer: "Off by default. Allow other devices on your Tailscale network to connect to this device, manage its conversations, and run tools. Keep Ox open while connected. This does not select an external Host.", layout: .group) {
                Toggle("Share this device · advanced", isOn: Binding(get: { access.enabled }, set: { access.enabled = $0 }))
                    .font(Theme.Fonts.bodyMd)
                    .foregroundStyle(Theme.Colors.onSurface)
                    .tint(Theme.Colors.primary)
                    .settingsRowPadding()
                    .accessibilityIdentifier(A11yID.Settings.hostEnabled)
            }
        }
    }
}

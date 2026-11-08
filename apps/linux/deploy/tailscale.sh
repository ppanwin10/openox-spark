#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: tailscale.sh [options]

Runs Tailscale in userspace mode as a systemd user service, without root, and
publishes the OpenOx Host over HTTPS inside your tailnet. Run it from an
OpenOx checkout on the Host machine after install.sh.

Userspace mode forwards tailnet connections to every loopback port on this
machine. Use --tag with an access rule that allows only port 443 to that tag.

Options:
  --hostname <name>  Tailnet machine name (default: openox)
  --tag <tag>        Tag to advertise, such as tag:openox
  --port <port>      Host port to publish (default: 9876)
  -h, --help         Show this help
EOF
}

note() { printf '%s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
fail() { printf 'error: %s\n' "$*" >&2; exit 1; }
option() { [ "$#" -ge 2 ] && [ -n "$2" ] || fail "$1 requires a value"; }

install_tailscale() {
  local arch="$1" bin="$2" index file version current work expected actual name
  index=$(curl -fsS -m 30 "https://pkgs.tailscale.com/stable/?mode=json")
  file=$(grep -oE "tailscale_[0-9.]+_${arch}\.tgz" <<<"$index" | awk 'NR == 1')
  [ -n "$file" ] || fail "No stable Tailscale build is published for $arch"
  version=${file#tailscale_}
  version=${version%_"$arch".tgz}
  current=$("$bin/tailscale" version 2>/dev/null | awk 'NR == 1' || true)
  if [ "$current" = "$version" ]; then return 1; fi
  work=$(mktemp -d)
  curl -fsS -m 300 -o "$work/$file" "https://pkgs.tailscale.com/stable/$file"
  expected=$(curl -fsS -m 30 "https://pkgs.tailscale.com/stable/$file.sha256" | tr -d '[:space:]')
  actual=$(sha256sum "$work/$file" | cut -d' ' -f1)
  if [ "$expected" != "$actual" ]; then
    rm -rf "$work"
    fail "Tailscale $version did not match its published checksum"
  fi
  tar -xzf "$work/$file" -C "$work"
  mkdir -p "$bin"
  for name in tailscale tailscaled; do
    install -m 0755 "$work/${file%.tgz}/$name" "$bin/$name.new"
    mv -f "$bin/$name.new" "$bin/$name"
  done
  rm -rf "$work"
  note "Installed Tailscale $version"
}

main() {
  local hostname=openox tag="" port=9876
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --hostname) option "$@"; hostname="$2"; shift 2 ;;
      --tag) option "$@"; tag="$2"; shift 2 ;;
      --port) option "$@"; port="$2"; shift 2 ;;
      -h|--help) usage; return 0 ;;
      *) fail "Unknown option: $1 (see --help)" ;;
    esac
  done
  [[ "$port" =~ ^[0-9]+$ ]] && [ "$port" -ge 1 ] && [ "$port" -le 65535 ] || fail "--port must be a TCP port"
  [[ "$hostname" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ ]] || fail "--hostname must use lowercase letters, digits and hyphens"
  if [ -n "$tag" ] && ! [[ "$tag" =~ ^tag:[a-z0-9-]+$ ]]; then fail "--tag must look like tag:openox"; fi

  local tool
  for tool in curl tar sha256sum systemctl; do
    command -v "$tool" >/dev/null 2>&1 || fail "Missing prerequisite: $tool"
  done
  local here unit arch bin socket units updated=0 changed=0
  here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
  unit="$here/systemd/openox-tailscaled.service"
  [ -f "$unit" ] || fail "Run this script from an OpenOx checkout"
  case "$(uname -m)" in
    aarch64|arm64) arch=arm64 ;;
    x86_64|amd64) arch=amd64 ;;
    *) fail "Unsupported architecture: $(uname -m)" ;;
  esac
  bin="$HOME/.local/tailscale"
  socket="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/openox-tailscale/tailscaled.sock"
  units="$HOME/.config/systemd/user"

  if install_tailscale "$arch" "$bin"; then updated=1; fi
  mkdir -p "$units" "$HOME/.local/state/openox-tailscale"
  chmod 700 "$HOME/.local/state/openox-tailscale"
  if ! cmp -s "$unit" "$units/openox-tailscaled.service"; then
    install -m 0644 "$unit" "$units/openox-tailscaled.service"
    changed=1
  fi
  systemctl --user daemon-reload
  systemctl --user enable --quiet openox-tailscaled.service
  if [ "$updated" = 1 ] || [ "$changed" = 1 ] || ! systemctl --user is-active --quiet openox-tailscaled.service; then
    systemctl --user restart openox-tailscaled.service
  fi
  local attempt
  for attempt in $(seq 1 20); do
    if [ -S "$socket" ]; then break; fi
    sleep 1
  done
  [ -S "$socket" ] || fail "tailscaled did not start; see journalctl --user -u openox-tailscaled"

  ts() { "$bin/tailscale" --socket="$socket" "$@"; }
  local status state
  status=$(ts status --json 2>/dev/null || true)
  state=$(sed -n 's/.*"BackendState": *"\([A-Za-z]*\)".*/\1/p' <<<"$status" | awk 'NR == 1')
  if [ "$state" != Running ]; then
    if [ -n "$tag" ]; then
      note "Before you open the login link, add $tag to your tailnet policy file and allow only port 443 to it, for example:"
      cat <<EOF
  "tagOwners": { "$tag": ["autogroup:admin"] },
  "acls": [
    { "action": "accept", "src": ["autogroup:member"], "dst": ["autogroup:self:*"] },
    { "action": "accept", "src": ["autogroup:member"], "dst": ["$tag:443"] }
  ]
EOF
    else
      warn "Without --tag and an access rule, every device in your tailnet can reach every loopback port on this machine"
    fi
    local up=(--hostname="$hostname" --accept-dns=false)
    if [ -n "$tag" ]; then up+=(--advertise-tags="$tag"); fi
    ts up "${up[@]}"
  fi

  local serving name
  serving=$(ts serve status 2>/dev/null || true)
  case "$serving" in
    *"127.0.0.1:$port"*) ;;
    *) ts serve --bg "$port" ;;
  esac
  status=$(ts status --json)
  name=$(sed -n 's/.*"DNSName": *"\([^"]*\)".*/\1/p' <<<"$status" | awk 'NR == 1')
  note "OpenOx is available in your tailnet at https://${name%.}/"
  local bun
  bun=$(command -v bun || printf '%s' "$HOME/.bun/bin/bun")
  if [ -x "$bun" ]; then
    "$bun" "$here/../src/main.ts" pair --url "https://${name%.}" || warn "Could not create a pairing code; run openox-host pair on this machine later"
  fi
}

main "$@"; exit $?

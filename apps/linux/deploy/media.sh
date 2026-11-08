#!/usr/bin/env bash
set -euo pipefail

ROOT="$HOME/.local/share/openox-media"
UNITS="$HOME/.config/systemd/user"
UNIT_NAME="openox-media.service"
DEFAULT_DIR="$HOME/openox/apps/linux/media"

usage() {
  cat <<'EOF'
Usage: media.sh [options]

Installs or updates the OpenOx media service (transcription, speech, image
generation and media extraction) and runs it as a systemd user service on
loopback. Run it on the Host machine, or pipe it over SSH:

  ssh <machine> 'bash -s -- --download' < apps/linux/deploy/media.sh

Everything stays under ~/.local/share/openox-media: two Python environments,
the model cache and the FP8 image weights. Models are only downloaded with
--download; until then the service reports them as not installed.

Options:
  --dir <path>   Service code directory (default: ~/openox/apps/linux/media)
  --port <port>  Loopback port (default: 9877)
  --download     Download the models (about 35 GB) and prepare the FP8 image
                 weights (about 10 GB more)
  --restart      Restart the service even when nothing changed
  -h, --help     Show this help
EOF
}

note() { printf '%s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
fail() { printf 'error: %s\n' "$*" >&2; exit 1; }
option() { [ "$#" -ge 2 ] && [ -n "$2" ] || fail "$1 requires a value"; }

healthy() {
  local port="$1" attempt
  for attempt in $(seq 1 60); do
    if curl -fsS -m 2 "http://127.0.0.1:$port/health" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  return 1
}

find_python() {
  local candidate
  for candidate in python3.12 python3.13 python3.11 python3; do
    if command -v "$candidate" >/dev/null 2>&1 \
      && "$candidate" -c 'import ensurepip, sys, venv; sys.exit(sys.version_info < (3, 11))' >/dev/null 2>&1; then
      command -v "$candidate"
      return 0
    fi
  done
  return 1
}

sync_venv() {
  local python="$1" venv="$2" requirements="$3" stamp log="$ROOT/install.log"
  stamp="$("$python" --version 2>&1) $(sha256sum "$requirements" | cut -d' ' -f1)"
  if [ -x "$venv/bin/python" ] && [ "$(cat "$venv/.openox-requirements" 2>/dev/null)" = "$stamp" ]; then return 1; fi
  if [ ! -x "$venv/bin/python" ]; then "$python" -m venv "$venv"; fi
  if ! {
    "$venv/bin/python" -m pip install --quiet --upgrade pip \
      && "$venv/bin/python" -m pip install --quiet --no-deps -r "$requirements"
  } >"$log" 2>&1; then
    cat "$log" >&2
    fail "Could not install $(basename "$requirements") into $venv"
  fi
  rm -f "$log"
  printf '%s\n' "$stamp" > "$venv/.openox-requirements"
  note "Installed $(basename "$requirements") into $venv"
}

render_unit() {
  local source="$1" dir="$2" port="$3"
  if [ "$dir" = "$DEFAULT_DIR" ]; then
    sed -e "s|--port 9877|--port $port|" "$source"
  else
    sed -e "s|%h/openox/apps/linux/media|$dir|g" -e "s|--port 9877|--port $port|" "$source"
  fi
}

write_unit() {
  local content="$1" target="$UNITS/$UNIT_NAME"
  mkdir -p "$UNITS"
  if [ -f "$target" ] && [ "$(cat "$target")" = "$content" ]; then return 1; fi
  printf '%s\n' "$content" > "$target.new"
  mv -f "$target.new" "$target"
}

code_changed() {
  local dir="$1" stamp
  stamp=$(cat "$dir"/*.py "$dir"/requirements*.txt | sha256sum | cut -d' ' -f1)
  if [ "$(cat "$ROOT/.code" 2>/dev/null)" = "$stamp" ]; then return 1; fi
  printf '%s\n' "$stamp" > "$ROOT/.code"
}

summary() {
  curl -fsS -m 5 "http://127.0.0.1:$1/health" | "$ROOT/venv/bin/python" -c '
import json, sys
health = json.load(sys.stdin)
print("Memory available: %.1f GiB (%.0f GiB stays free for other services)" % (health["memAvailableBytes"] / 2**30, health["reserveBytes"] / 2**30))
for capability in health["capabilities"]:
    print("  %-13s %-38s %s" % (capability["id"], capability["model"], capability["state"]))
'
}

main() {
  local dir="$DEFAULT_DIR" port=9877 download=0 restart=0
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --dir) option "$@"; dir="${2%/}"; shift 2 ;;
      --port) option "$@"; port="$2"; shift 2 ;;
      --download) download=1; shift ;;
      --restart) restart=1; shift ;;
      -h|--help) usage; return 0 ;;
      *) fail "Unknown option: $1 (see --help)" ;;
    esac
  done
  [[ "$dir" =~ ^/[A-Za-z0-9._/+-]+$ ]] || fail "--dir must be a plain absolute path"
  [[ "$port" =~ ^[0-9]+$ ]] && [ "$port" -ge 1024 ] && [ "$port" -le 65535 ] || fail "--port must be a TCP port from 1024"
  [ -f "$dir/server.py" ] && [ -f "$dir/requirements.txt" ] && [ -f "$dir/requirements-tts.txt" ] \
    || fail "$dir does not contain the media service"
  local source="$dir/../deploy/systemd/$UNIT_NAME"
  [ -f "$source" ] || fail "Missing the unit template $source"

  local tool python
  for tool in curl sha256sum systemctl journalctl flock sed; do
    command -v "$tool" >/dev/null 2>&1 || fail "Missing prerequisite: $tool"
  done
  python=$(find_python) || fail "Python 3.11 or newer with the venv module is required"
  export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
  export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}"
  systemctl --user show-environment >/dev/null 2>&1 || fail "systemd user services are unavailable for $(id -un)"
  mkdir -p "$ROOT" "$HOME/.cache/openox-media"
  exec 9>"$HOME/.cache/openox-media/install.lock"
  flock -n 9 || fail "Another media install is already running"
  if [ "$(loginctl show-user "$(id -un)" --property=Linger --value 2>/dev/null)" != yes ]; then
    warn "Lingering is off, so the service stops when you log out; an administrator can run: sudo loginctl enable-linger $(id -un)"
  fi
  if ! systemctl --user is-active --quiet "$UNIT_NAME" && command -v ss >/dev/null 2>&1 \
    && [ -n "$(ss -Hltn "sport = :$port" 2>/dev/null)" ]; then
    fail "Port $port is already in use"
  fi

  export PIP_CACHE_DIR="$HOME/.cache/openox-media/pip" PIP_DISABLE_PIP_VERSION_CHECK=1
  local changed=0
  if sync_venv "$python" "$ROOT/venv" "$dir/requirements.txt"; then changed=1; fi
  if sync_venv "$python" "$ROOT/venv-tts" "$dir/requirements-tts.txt"; then changed=1; fi
  "$ROOT/venv/bin/python" -c 'import torch, sys; sys.exit(not torch.cuda.is_available())' 2>/dev/null \
    || warn "PyTorch cannot reach a CUDA GPU, so the models will not load"

  if [ "$download" = 1 ]; then
    local free
    free=$(df -Pk "$ROOT" | awk 'NR == 2 { print $4 }')
    [ "$free" -gt $((50 * 1024 * 1024)) ] || warn "Less than 50 GB is free under $ROOT"
    HF_HOME="$ROOT/hf" HF_HUB_DISABLE_TELEMETRY=1 OPENOX_MEDIA_HOME="$ROOT" PYTHONDONTWRITEBYTECODE=1 \
      "$ROOT/venv/bin/python" "$dir/download.py" || fail "Could not download the models"
  fi

  if code_changed "$dir"; then changed=1; fi
  if write_unit "$(render_unit "$source" "$dir" "$port")"; then changed=1; fi
  systemctl --user daemon-reload
  systemctl --user enable --quiet "$UNIT_NAME"
  if [ "$changed" = 1 ] || [ "$restart" = 1 ] || ! systemctl --user is-active --quiet "$UNIT_NAME"; then
    systemctl --user restart "$UNIT_NAME"
    if ! healthy "$port"; then
      journalctl --user --unit "$UNIT_NAME" --lines 30 --no-pager --output cat >&2 || true
      fail "The media service did not become healthy"
    fi
    note "Started the media service from $dir"
  else
    note "The media service is already running; nothing changed"
  fi
  summary "$port" || warn "Could not read the service health"
  note "Service: http://127.0.0.1:$port  Logs: journalctl --user -u $UNIT_NAME"
}

main "$@" </dev/null; exit $?

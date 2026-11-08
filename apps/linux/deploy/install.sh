#!/usr/bin/env bash
set -euo pipefail

BUN="$HOME/.bun/bin/bun"
UNITS="$HOME/.config/systemd/user"
UNIT_NAME="openox-host.service"

usage() {
  cat <<'EOF'
Usage: install.sh [options]

Installs or updates the OpenOx Linux Host from Git and runs it as a systemd
user service on loopback. Run it on the Host machine as the user who owns the
Host data, or pipe it over SSH:

  ssh <machine> 'bash -s -- --repo <url>' < apps/linux/deploy/install.sh

Options:
  --repo <url>         Repository to clone on first install; also replaces origin
  --ref <ref>          Branch, tag or commit to deploy (default: main)
  --dir <path>         Checkout directory (default: ~/openox)
  --port <port>        Loopback port (default: 9876)
  --model-url <url>    Make this OpenAI-compatible endpoint the default model
  --model-id <id>      Model ID served by that endpoint (required with --model-url)
  --model-name <name>  Endpoint display name (default: Local model)
  --model-images       The endpoint's model accepts image input
  --restart            Restart the Host even when nothing changed
  -h, --help           Show this help
EOF
}

note() { printf '%s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
fail() { printf 'error: %s\n' "$*" >&2; exit 1; }
option() { [ "$#" -ge 2 ] && [ -n "$2" ] || fail "$1 requires a value"; }

healthy() {
  local port="$1" attempt
  for attempt in $(seq 1 30); do
    if curl -fsS -m 2 "http://127.0.0.1:$port/api/health" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  return 1
}

ensure_bun() {
  local version="$1" arch asset base work
  if [ -x "$BUN" ] && [ "$("$BUN" --version 2>/dev/null)" = "$version" ]; then return 0; fi
  case "$(uname -m)" in
    aarch64|arm64) arch=aarch64 ;;
    x86_64|amd64) arch=x64 ;;
    *) fail "Unsupported architecture: $(uname -m)" ;;
  esac
  asset="bun-linux-$arch.zip"
  base="https://github.com/oven-sh/bun/releases/download/bun-v$version"
  work=$(mktemp -d)
  curl -fsSL -m 300 -o "$work/$asset" "$base/$asset"
  curl -fsSL -m 60 -o "$work/SHASUMS256.txt" "$base/SHASUMS256.txt"
  if ! (cd "$work" && grep " $asset\$" SHASUMS256.txt | sha256sum --check --status -); then
    rm -rf "$work"
    fail "Bun $version did not match its published checksum"
  fi
  unzip -q "$work/$asset" -d "$work"
  mkdir -p "$(dirname "$BUN")"
  install -m 0755 "$work/bun-linux-$arch/bun" "$BUN.new"
  mv -f "$BUN.new" "$BUN"
  ln -sf bun "$(dirname "$BUN")/bunx"
  rm -rf "$work"
  note "Installed Bun $version"
}

install_dependencies() {
  local dir="$1" log
  log=$(mktemp)
  if ! (cd "$dir" && "$BUN" install --frozen-lockfile --ignore-scripts) >"$log" 2>&1; then
    cat "$log" >&2
    rm -f "$log"
    return 1
  fi
  if [ -f "$dir/apps/linux/node_modules/playwright-core/cli.js" ] && ! (cd "$dir/apps/linux" && "$BUN" node_modules/playwright-core/cli.js install chromium) >"$log" 2>&1; then
    cat "$log" >&2
    rm -f "$log"
    return 1
  fi
  rm -f "$log"
}

unit_source() {
  local path
  for path in apps/linux/deploy/systemd/openox-host.service apps/linux/openox-host.service; do
    if [ -f "$1/$path" ]; then printf '%s\n' "$1/$path"; return 0; fi
  done
  return 1
}

render_unit() {
  local source="$1" dir="$2" port="$3" tessdata="$4" path="$2"
  if [ "$dir" = "$HOME/openox" ]; then path="%h/openox"; fi
  sed -e "s|%h/openox|$path|g" -e "s|--port 9876|--port $port|" "$source" | if [ -n "$tessdata" ]; then
    awk -v line="Environment=TESSDATA_PREFIX=$tessdata" '{ print } /^Environment=PATH=/ { print line }'
  else cat; fi
}

prepare_tessdata() {
  local target="$HOME/.local/share/openox-host/tessdata" languages system download
  local url="https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/4.1.0/chi_sim.traineddata"
  local checksum="a5fcb6f0db1e1d6d8522f39db4e848f05984669172e584e8d76b6b3141e1f730"
  if ! command -v tesseract >/dev/null 2>&1; then
    warn "tesseract is missing, so text in images cannot be read; install tesseract-ocr"
    return 0
  fi
  languages=$(tesseract --list-langs 2>&1 || true)
  if grep -qx chi_sim <<<"$languages"; then return 0; fi
  system=$(sed -n 's/^List of available languages in "\([^"]*\)".*/\1/p' <<<"$languages" | awk 'NR == 1')
  system=${system%/}
  [ -d "$system" ] || return 0
  mkdir -p "$target"
  cp -n "$system"/*.traineddata "$target"/ 2>/dev/null || true
  if [ ! -f "$target/chi_sim.traineddata" ]; then
    download=$(mktemp "$target/.chi_sim.XXXXXX")
    if curl -fsSL -m 120 -o "$download" "$url" && [ "$(sha256sum "$download" | cut -d' ' -f1)" = "$checksum" ]; then
      mv -f "$download" "$target/chi_sim.traineddata"
      note "Installed Simplified Chinese OCR data" >&2
    else
      rm -f "$download"
      warn "Could not install Simplified Chinese OCR data; images are read in English only"
    fi
  fi
  printf '%s\n' "$target"
}

write_unit() {
  local content="$1" target="$UNITS/$UNIT_NAME"
  mkdir -p "$UNITS"
  if [ -f "$target" ] && [ "$(cat "$target")" = "$content" ]; then return 1; fi
  printf '%s\n' "$content" > "$target.new"
  mv -f "$target.new" "$target"
}

register_model() {
  local dir="$1" port="$2" url="${3%/}" id="$4" name="$5" images="$6" output device token headers custom choice status=0
  curl -fsS -m 15 "$url/models" | ID="$id" "$BUN" -e 'const body = await Bun.stdin.json(); process.exit((body.data ?? []).some(model => model.id === process.env.ID) ? 0 : 1)' \
    || fail "$url/models does not list $id"
  output=$(cd "$dir" && "$BUN" apps/linux/src/main.ts token --name "Installer (temporary)") || fail "Could not create a temporary Host token"
  device=$(printf '%s\n' "$output" | sed -n 's/^Device \([^ ]*\) .*/\1/p')
  token=$(printf '%s\n' "$output" | sed -n 's/^OX_HOST_TOKEN=//p')
  [ -n "$device" ] && [ -n "$token" ] || fail "Could not read the temporary Host token"
  headers=$(mktemp)
  chmod 600 "$headers"
  printf 'Authorization: Bearer %s\ncontent-type: application/json\n' "$token" > "$headers"
  custom=$(URL="$url" ID="$id" NAME="$name" IMAGES="$images" "$BUN" -e 'console.log(JSON.stringify({ baseUrl: process.env.URL, models: [process.env.ID], name: process.env.NAME, images: process.env.IMAGES === "1" }))')
  choice=$(ID="$id" "$BUN" -e 'console.log(JSON.stringify({ provider: "custom", modelId: process.env.ID }))')
  curl -fsS -m 30 -X PUT -H "@$headers" --data "$custom" "http://127.0.0.1:$port/api/settings/providers/custom" >/dev/null \
    && curl -fsS -m 30 -X PUT -H "@$headers" --data "$choice" "http://127.0.0.1:$port/api/settings/default-model" >/dev/null \
    || status=$?
  rm -f "$headers"
  (cd "$dir" && "$BUN" apps/linux/src/main.ts revoke "$device") >/dev/null || warn "Revoke the temporary device $device in Settings"
  [ "$status" = 0 ] || fail "Could not make $id the default model"
  note "Default model: $name ($id at $url$([ "$images" = 1 ] && printf ', accepts images'))"
}

main() {
  local repo="" ref="main" dir="$HOME/openox" port=9876 model_url="" model_id="" model_name="Local model" model_images=0 restart=0
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --repo) option "$@"; repo="$2"; shift 2 ;;
      --ref) option "$@"; ref="$2"; shift 2 ;;
      --dir) option "$@"; dir="${2%/}"; shift 2 ;;
      --port) option "$@"; port="$2"; shift 2 ;;
      --model-url) option "$@"; model_url="$2"; shift 2 ;;
      --model-id) option "$@"; model_id="$2"; shift 2 ;;
      --model-name) option "$@"; model_name="$2"; shift 2 ;;
      --model-images) model_images=1; shift ;;
      --restart) restart=1; shift ;;
      -h|--help) usage; return 0 ;;
      *) fail "Unknown option: $1 (see --help)" ;;
    esac
  done
  case "$dir" in /?*) ;; *) fail "--dir must be an absolute path" ;; esac
  [ "$dir" != "$HOME" ] || fail "--dir must be a dedicated directory"
  [[ "$port" =~ ^[0-9]+$ ]] && [ "$port" -ge 1 ] && [ "$port" -le 65535 ] || fail "--port must be a TCP port"
  if { [ -n "$model_url" ] && [ -z "$model_id" ]; } || { [ -z "$model_url" ] && [ -n "$model_id" ]; }; then
    fail "--model-url and --model-id go together"
  fi

  local tool
  for tool in git curl unzip sha256sum systemctl journalctl flock; do
    command -v "$tool" >/dev/null 2>&1 || fail "Missing prerequisite: $tool"
  done
  systemctl --user show-environment >/dev/null 2>&1 || fail "systemd user services are unavailable for $(id -un)"
  mkdir -p "$HOME/.cache"
  exec 9>"$HOME/.cache/openox-install.lock"
  flock -n 9 || fail "Another install is already running"
  if [ "$(loginctl show-user "$(id -un)" --property=Linger --value 2>/dev/null)" != yes ]; then
    warn "Lingering is off, so the Host stops when you log out; an administrator can run: sudo loginctl enable-linger $(id -un)"
  fi
  command -v pdftotext >/dev/null 2>&1 || warn "pdftotext is missing, so PDF files cannot be read; install poppler-utils"

  local previous="" aside="" previous_unit=""
  if [ -f "$UNITS/$UNIT_NAME" ]; then previous_unit=$(cat "$UNITS/$UNIT_NAME"); fi
  if [ -d "$dir/.git" ]; then
    [ -z "$(git -C "$dir" status --porcelain --untracked-files=no)" ] || fail "$dir has local changes to tracked files; commit or discard them first"
    previous=$(git -C "$dir" rev-parse HEAD)
    if [ -n "$repo" ]; then git -C "$dir" remote set-url origin "$repo"; fi
  else
    [ -n "$repo" ] || fail "Pass --repo <url> for the first install"
    if [ -e "$dir" ]; then
      aside="$dir.before-git-$(date +%Y%m%d%H%M%S)"
      mv "$dir" "$aside"
      note "Moved the existing $dir to $aside"
    fi
    if ! git clone --quiet --filter=blob:none --no-checkout "$repo" "$dir"; then
      rm -rf "$dir"
      if [ -n "$aside" ]; then mv "$aside" "$dir"; fi
      fail "Could not clone $repo"
    fi
  fi

  restore() {
    if [ -n "$previous" ]; then
      git -C "$dir" checkout --quiet --detach "$previous" && install_dependencies "$dir" || return 1
    elif [ -n "$aside" ]; then
      rm -rf "$dir" && mv "$aside" "$dir" || return 1
    else
      return 1
    fi
    if [ -n "$previous_unit" ]; then
      printf '%s\n' "$previous_unit" > "$UNITS/$UNIT_NAME"
    fi
    systemctl --user daemon-reload
    systemctl --user restart "$UNIT_NAME"
    healthy "$port"
  }

  abort() {
    if restore; then fail "$1; the previous version is running again"; fi
    fail "$1"
  }

  local target
  git -C "$dir" fetch --quiet --prune --tags origin || abort "Could not fetch from origin"
  target=$(git -C "$dir" rev-parse --verify --quiet "refs/remotes/origin/$ref^{commit}" || git -C "$dir" rev-parse --verify --quiet "$ref^{commit}") \
    || abort "Unknown ref: $ref"
  git -C "$dir" checkout --quiet --detach "$target" || abort "Could not check out $ref"

  local version source changed=0
  version=$(sed -n 's/.*bun-version: *\([0-9][0-9.]*\).*/\1/p' "$dir/.github/workflows/ci.yml" | awk 'NR == 1')
  [ -n "$version" ] || abort "$ref does not pin a Bun version in .github/workflows/ci.yml"
  ensure_bun "$version"
  install_dependencies "$dir" || abort "Dependency installation failed for $ref"
  source=$(unit_source "$dir") || abort "$ref has no $UNIT_NAME"
  local tessdata
  tessdata=$(prepare_tessdata)
  if write_unit "$(render_unit "$source" "$dir" "$port" "$tessdata")"; then changed=1; fi
  systemctl --user daemon-reload
  systemctl --user enable --quiet "$UNIT_NAME"

  if [ "$target" != "$previous" ] || [ "$changed" = 1 ] || [ "$restart" = 1 ] || ! systemctl --user is-active --quiet "$UNIT_NAME"; then
    systemctl --user restart "$UNIT_NAME"
    if ! healthy "$port"; then
      journalctl --user --unit "$UNIT_NAME" --lines 20 --no-pager --output cat >&2 || true
      abort "${target:0:8} did not become healthy"
    fi
    note "Deployed ${target:0:8}: $(git -C "$dir" log -1 --format=%s "$target")"
  else
    note "Already running ${target:0:8}; nothing changed"
  fi
  if [ -n "$aside" ]; then note "The files from before Git are in $aside; delete them once this version works"; fi

  if [ -n "$model_url" ]; then register_model "$dir" "$port" "$model_url" "$model_id" "$model_name" "$model_images"; fi
  note "Host: http://127.0.0.1:$port  Data: $HOME/.local/share/openox-host"
  note "Pair a device: cd $dir && $BUN apps/linux/src/main.ts pair"
  if [ -z "$model_url" ] && [ -x "$dir/apps/linux/packs/pack.sh" ]; then
    local pack
    if pack=$("$dir/apps/linux/packs/pack.sh" recommend 2>/dev/null); then
      [ -f "$HOME/.local/share/openox-packs/$pack/settings" ] || note "Run a local model here: $dir/apps/linux/packs/pack.sh install $pack"
    elif [ -n "$pack" ]; then note "$pack"; fi
  fi
}

main "$@" </dev/null; exit $?

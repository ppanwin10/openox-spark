#!/usr/bin/env bash
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
APP=$(cd "$HERE/.." && pwd)
DATA="${OPENOX_PACKS_DIR:-$HOME/.local/share/openox-packs}"
HOST_PORT="${OPENOX_HOST_PORT:-9876}"

usage() {
  cat <<'USAGE'
Usage: pack.sh <command> [pack] [options]

Model packs run a tested local model for the OpenOx Host in Docker.

Commands:
  list               Packs in this checkout and whether they fit this machine
  recommend          The pack that fits this machine best
  check <pack>       Compare this machine with a pack's requirements
  install <pack>     Pull the engine, get the model, start it and add it to the Host
  start <pack>       Start an installed pack and add it to the Host if the Host lacks it
  stop <pack>        Stop it; it stays stopped after a reboot
  status <pack>      Container state, the model it serves and free memory
  remove <pack>      Remove the container (asks first; --purge also deletes downloaded weights and the engine cache)

Options:
  --port <port>      Loopback port for the engine (default: the pack's port)
  --weights <dir>    Use model files already on this machine after checking their checksums
  --no-start         Install without starting the engine
  --no-register      Do not add the model to the OpenOx Host
  --force            Start even when free memory looks too low
  --purge            With remove, also delete the weights it downloaded and the engine cache
  --yes              Do not ask before removing
USAGE
}

note() { printf '%s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
fail() { printf 'error: %s\n' "$*" >&2; exit 1; }

field() { python3 -c 'import json,sys; v=json.load(open(sys.argv[1])); [v := v[k] for k in sys.argv[2].split(".")]; print(" ".join(v) if isinstance(v, list) else v)' "$1" "$2"; }

packs() { local file; for file in "$HERE"/*/pack.json; do [ -f "$file" ] && basename "$(dirname "$file")"; done; }

manifest() {
  [ -n "${1:-}" ] || fail "Name a pack; see pack.sh list"
  [ -f "$HERE/$1/pack.json" ] || { printf 'error: Unknown pack %s; see pack.sh list\n' "$1" >&2; exit 2; }
  printf '%s' "$HERE/$1/pack.json"
}

gib() { awk -v kb="$1" 'BEGIN { printf "%.1f", kb / 1048576 }'; }

hardware() {
  ARCH=$(uname -m)
  GPU=$(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -1 || true)
  if [ -r /proc/meminfo ]; then
    MEMORY_KB=$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)
    FREE_KB=$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo)
  else
    MEMORY_KB=$(( $(sysctl -n hw.memsize 2>/dev/null || echo 0) / 1024 ))
    FREE_KB=""
  fi
  local probe="$DATA"
  while [ ! -d "$probe" ]; do probe=$(dirname "$probe"); done
  DISK_KB=$(df -Pk "$probe" | awk 'NR == 2 {print $4}')
}

docker_command() {
  if docker info >/dev/null 2>&1; then DOCKER=(docker)
  elif sudo -n docker info >/dev/null 2>&1; then DOCKER=(sudo -n docker)
  elif command -v docker >/dev/null 2>&1; then DOCKER=(sudo docker)
  else DOCKER=(); fi
}

need_docker() {
  docker_command
  [ "${#DOCKER[@]}" -gt 0 ] || fail "Docker is not available; install Docker and the NVIDIA Container Toolkit first"
}

fits() {
  local file="$1" show="${2:-}" ok=0 need line
  hardware
  docker_command
  report() { [ -z "$show" ] || printf '  %-12s %-20s %-16s %s\n' "$1" "$2" "$3" "$4"; }
  need=$(field "$file" fits.arch)
  if [ "$ARCH" = "$need" ]; then report architecture "$ARCH" "needs $need" ok; else report architecture "$ARCH" "needs $need" "does not fit"; ok=1; fi
  need=$(field "$file" fits.gpu)
  if [[ "$GPU" == *"$need"* ]]; then report GPU "${GPU:-none}" "needs $need" ok; else report GPU "${GPU:-none}" "needs $need" "does not fit"; ok=1; fi
  need=$(field "$file" fits.memoryGiB)
  if awk -v have="$MEMORY_KB" -v need="$need" 'BEGIN { exit !(have >= need * 1048576 * 0.95) }'; then report memory "$(gib "$MEMORY_KB") GiB" "needs $need GiB" ok; else report memory "$(gib "$MEMORY_KB") GiB" "needs $need GiB" "does not fit"; ok=1; fi
  need=$(field "$file" fits.diskGiB)
  if awk -v have="$DISK_KB" -v need="$need" 'BEGIN { exit !(have >= need * 1048576) }'; then report disk "$(gib "$DISK_KB") GiB free" "needs $need GiB" ok; else report disk "$(gib "$DISK_KB") GiB free" "needs $need GiB" "does not fit"; ok=1; fi
  if [ "${#DOCKER[@]}" -gt 0 ]; then report docker available "" ok; else report docker missing "needs Docker" "does not fit"; ok=1; fi
  need=$(field "$file" fits.freeMemoryGiB)
  if [ -z "$FREE_KB" ]; then report "free memory" unknown "needs $need GiB" ""
  elif awk -v have="$FREE_KB" -v need="$need" 'BEGIN { exit !(have >= need * 1048576) }'; then report "free memory" "$(gib "$FREE_KB") GiB" "needs $need GiB" ok
  else report "free memory" "$(gib "$FREE_KB") GiB" "needs $need GiB" "stop other models before starting"; fi
  return "$ok"
}

enough_memory() {
  local file="$1" need
  hardware
  need=$(field "$file" fits.freeMemoryGiB)
  [ -n "$FREE_KB" ] && awk -v have="$FREE_KB" -v need="$need" 'BEGIN { exit !(have >= need * 1048576) }'
}

container() { printf 'openox-%s' "$1"; }

healthy() { curl -fsS -m 3 "http://127.0.0.1:$1/health" >/dev/null 2>&1; }

port_busy() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

state() { "${DOCKER[@]}" inspect -f "$2" "$(container "$1")" 2>/dev/null || true; }

wait_healthy() {
  local name="$1" port="$2" deadline=$(( $(date +%s) + $3 )) first
  first=$(state "$name" '{{.State.Status}} {{.State.StartedAt}}')
  while [ "$(date +%s)" -lt "$deadline" ]; do
    healthy "$port" && return 0
    [ "$(state "$name" '{{.State.Status}} {{.State.StartedAt}}')" = "$first" ] || return 1
    sleep 2
  done
  return 1
}

saved() { if [ -f "$DATA/$1/settings" ]; then cat "$DATA/$1/settings"; fi; }

checksums() {
  local file="$1" dir="$2" repo revision listing
  repo=$(field "$file" model.repo)
  revision=$(field "$file" model.revision)
  listing=$(curl -fsS -m 60 "https://huggingface.co/api/models/$repo/tree/$revision?recursive=1") || fail "Could not read the file list of $repo from Hugging Face"
  LISTING="$listing" DIR="$dir" REPO="$repo" REVISION="$revision" python3 - <<'PY'
import hashlib, json, os, sys
from concurrent.futures import ThreadPoolExecutor
entries = [entry for entry in json.loads(os.environ["LISTING"]) if entry.get("type") == "file" and not entry["path"].startswith(".")]
root = os.path.realpath(os.environ["DIR"])
def check(entry):
    path = os.path.join(root, entry["path"])
    if not os.path.isfile(path): return f"missing {entry['path']}"
    if os.path.realpath(path) != path: return f"link {entry['path']}"
    lfs = entry.get("lfs")
    if os.path.getsize(path) != (lfs or entry)["size"]: return f"wrong size {entry['path']}"
    if not lfs: return None
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(16 << 20), b""): digest.update(block)
    return None if digest.hexdigest() == lfs["oid"] else f"checksum mismatch {entry['path']}"
with ThreadPoolExecutor(4) as pool: problems = [problem for problem in pool.map(check, entries) if problem]
if problems:
    print("\n".join(problems))
    if any(problem.startswith("link ") for problem in problems):
        print(f"The engine sees only the files inside the folder and cannot follow links out of it, such as into a Hugging Face cache; make a copy with: hf download {os.environ['REPO']} --revision {os.environ['REVISION']} --local-dir <folder>")
    sys.exit(1)
print(f"{len(entries)} files match the pinned revision")
PY
}

download() {
  local file="$1" dir="$2" image repo revision
  image=$(field "$file" engine.image)
  repo=$(field "$file" model.repo)
  revision=$(field "$file" model.revision)
  mkdir -p "$dir"
  note "Downloading $repo at ${revision:0:12} into $dir"
  "${DOCKER[@]}" run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp -e HF_HOME=/tmp/hf -v "$dir:/weights" --entrypoint python3 "$image" \
    -c "from huggingface_hub import snapshot_download; snapshot_download(repo_id='$repo', revision='$revision', local_dir='/weights')" \
    || fail "Downloading the model failed"
}

body() {
  python3 -c '
import json, sys
fields = dict(pair.split("=", 1) for pair in sys.argv[1:])
if "models" in fields: fields["models"] = [fields["models"]]
if "images" in fields: fields["images"] = fields["images"] == "true"
print(json.dumps(fields))' "$@"
}

register() {
  local name="$1" file="$2" port="$3" base api id images label bun output device token headers settings decision action machine current
  base="http://127.0.0.1:$port/v1"
  api="http://127.0.0.1:$HOST_PORT/api/settings"
  curl -fs -m 5 "http://127.0.0.1:$HOST_PORT/api/health" >/dev/null || { warn "The OpenOx Host is not running on port $HOST_PORT; once it runs, pair 127.0.0.1:$port in Settings → Models"; return 0; }
  bun=$(command -v bun || printf '%s' "$HOME/.bun/bin/bun")
  [ -x "$bun" ] || { warn "bun not found; pair 127.0.0.1:$port in Settings → Models"; return 0; }
  output=$(cd "$APP" && "$bun" src/main.ts token --name "Pack installer (temporary)") || { warn "Could not create a temporary Host token; pair 127.0.0.1:$port in Settings → Models"; return 0; }
  device=$(printf '%s\n' "$output" | sed -n 's/^Device \([^ ]*\) .*/\1/p')
  token=$(printf '%s\n' "$output" | sed -n 's/^OX_HOST_TOKEN=//p')
  headers=$(mktemp)
  printf 'Authorization: Bearer %s\ncontent-type: application/json\n' "$token" > "$headers"
  id=$(field "$file" model.id)
  images=$(field "$file" model.images | tr '[:upper:]' '[:lower:]')
  label=$(field "$file" name)
  settings=$(curl -fs -m 10 -H "@$headers" "$api" || true)
  decision=$(SETTINGS="$settings" BASE="$base" ID="$id" python3 -c '
import json, os
settings = json.loads(os.environ["SETTINGS"])
machines = settings.get("machines") or []
same = next((machine for machine in machines if machine["baseUrl"] == os.environ["BASE"]), None)
if same and os.environ["ID"] in same["models"]: print("same")
elif same: print("update", same["id"], "default" if (settings.get("defaultModel") or {}).get("provider") == same["id"] else "other")
else: print("pair" if machines else "first")' 2>/dev/null || true)
  read -r action machine current <<< "$decision"
  case "$action" in
    same) note "The Host already uses $id at $base" ;;
    update)
      if curl -fsS -m 60 -X PUT -H "@$headers" --data "$(body "models=$id" "images=$images")" "$api/machines/$machine" >/dev/null \
        && { [ "$current" != default ] || curl -fsS -m 30 -X PUT -H "@$headers" --data "$(body "provider=$machine" "modelId=$id")" "$api/default-model" >/dev/null; }
      then note "The Host's local machine at $base now uses $id"
      else warn "Could not update the local machine at $base; edit it in Settings → Models"; fi ;;
    pair)
      if curl -fsS -m 60 -X POST -H "@$headers" --data "$(body "address=$base" "name=$label" "images=$images")" "$api/machines" >/dev/null
      then note "Added $label to the Host's local machines"
      else warn "Could not add $label to the Host; pair 127.0.0.1:$port in Settings → Models"; fi ;;
    first)
      if curl -fsS -m 60 -X PUT -H "@$headers" --data "$(body "baseUrl=$base" "models=$id" "name=$label" "images=$images")" "$api/providers/custom" >/dev/null \
        && curl -fsS -m 30 -X PUT -H "@$headers" --data "$(body provider=custom "modelId=$id")" "$api/default-model" >/dev/null
      then note "$label is now the Host's default model"
      else warn "Could not add $label to the Host; pair 127.0.0.1:$port in Settings → Models"; fi ;;
    *) warn "Could not read the Host's settings; pair 127.0.0.1:$port in Settings → Models" ;;
  esac
  rm -f "$headers"
  (cd "$APP" && "$bun" src/main.ts revoke "$device") >/dev/null || warn "Revoke the temporary device $device in Settings"
}

start_pack() {
  local name="$1" file="$2" port
  port=$(saved "$name" | sed -n 's/^port=//p')
  [ -n "$port" ] && [ -n "$(state "$name" '{{.Id}}')" ] || fail "$name is not installed; run pack.sh install $name"
  if [ "$(state "$name" '{{.State.Running}}')" != true ]; then
    ! port_busy "$port" || fail "Another program already uses 127.0.0.1:$port; stop it and run pack.sh start $name, or remove $name and install it again with --port"
    if [ "$FORCE" != 1 ] && ! enough_memory "$file"; then
      fail "Only $(gib "$FREE_KB") GiB of memory is free and $name needs $(field "$file" fits.freeMemoryGiB) GiB; stop other models, then run pack.sh start $name (or add --force)"
    fi
  fi
  "${DOCKER[@]}" update --restart=unless-stopped "$(container "$name")" >/dev/null
  "${DOCKER[@]}" start "$(container "$name")" >/dev/null
  note "Starting $name on 127.0.0.1:$port; the first start tunes kernels and takes a few minutes"
  if ! wait_healthy "$name" "$port" 1200; then
    "${DOCKER[@]}" logs --tail 20 "$(container "$name")" 2>&1 | cut -c1-200 >&2
    "${DOCKER[@]}" stop "$(container "$name")" >/dev/null 2>&1 || true
    fail "$name did not start, so it was stopped; the engine's last lines are above"
  fi
  note "$name is serving $(field "$file" model.id) on 127.0.0.1:$port"
}

run_pack() {
  start_pack "$1" "$2"
  if [ "$REGISTER" = 1 ]; then register "$1" "$2" "$(saved "$1" | sed -n 's/^port=//p')"; fi
}

install_pack() {
  local name="$1" file="$2" port weights image
  fits "$file" show || fail "$name does not fit this machine"
  port="${PORT:-$(field "$file" engine.port)}"
  image=$(field "$file" engine.image)
  if "${DOCKER[@]}" inspect "$(container "$name")" >/dev/null 2>&1; then fail "$name is already installed; use pack.sh start $name, or remove it first"; fi
  note "Pulling $image"
  "${DOCKER[@]}" pull "$image" || fail "Could not pull $image"
  if [ -n "$WEIGHTS" ]; then
    weights=$(cd "$WEIGHTS" && pwd)
    note "Checking the model files in $weights"
  else
    weights="$DATA/$name/weights"
    download "$file" "$weights"
  fi
  checksums "$file" "$weights" || fail "The model files in $weights cannot be used as they are; see the lines above"
  mkdir -p "$DATA/$name"
  printf 'port=%s\nweights=%s\n' "$port" "$weights" > "$DATA/$name/settings"
  local args
  read -r -a args <<< "$(field "$file" engine.args)"
  "${DOCKER[@]}" create --name "$(container "$name")" --label "openox.pack=$name" --gpus all --ipc=host --restart no \
    -p "127.0.0.1:$port:8000" -v "$weights:/models/$name:ro" -v "$(container "$name")-cache:/root/.cache" \
    "$image" vllm serve "/models/$name" --served-model-name "$(field "$file" model.id)" --host 0.0.0.0 --port 8000 "${args[@]}" >/dev/null \
    || fail "Could not create the $name container"
  note "Installed $name"
  if [ "$START" = 1 ]; then run_pack "$name" "$file"; else note "Start it with: pack.sh start $name"; fi
}

status_pack() {
  local name="$1" port running
  port=$(saved "$name" | sed -n 's/^port=//p')
  running=$(state "$name" '{{.State.Status}}, restart {{.HostConfig.RestartPolicy.Name}}')
  note "$name: ${running:-not installed}"
  if [ "$(state "$name" '{{.State.Running}}')" = true ]; then
    if healthy "$port"; then note "serving $(curl -s -m 3 "http://127.0.0.1:$port/v1/models" | python3 -c 'import json,sys; print(", ".join(m["id"] for m in json.load(sys.stdin)["data"]))') on 127.0.0.1:$port"
    else note "starting; 127.0.0.1:$port is not answering yet"; fi
  fi
  hardware
  note "free memory: $(if [ -n "$FREE_KB" ]; then printf '%s GiB' "$(gib "$FREE_KB")"; else printf unknown; fi)"
}

remove_pack() {
  local name="$1" weights owned="$DATA/$1/weights" answer
  weights=$(saved "$name" | sed -n 's/^weights=//p')
  if [ "$YES" != 1 ]; then
    printf 'Remove the %s container%s? Type the pack name to confirm: ' "$name" "$([ "$PURGE" = 1 ] && [ -d "$owned" ] && printf ' and delete %s' "$owned")"
    read -r answer
    [ "$answer" = "$name" ] || fail "Nothing removed"
  fi
  "${DOCKER[@]}" rm -f "$(container "$name")" >/dev/null 2>&1 || true
  if [ "$PURGE" = 1 ]; then
    "${DOCKER[@]}" volume rm "$(container "$name")-cache" >/dev/null 2>&1 || true
    rm -rf "$owned"
    if [ -n "$weights" ] && [ "$weights" != "$owned" ]; then note "Kept $weights because pack.sh did not download it"; fi
  fi
  rm -f "$DATA/$name/settings"
  rmdir "$DATA/$name" 2>/dev/null || true
  note "Removed $name"
}

COMMAND="${1:-}"; [ $# -gt 0 ] && shift
case "$COMMAND" in -h|--help) usage; exit 0 ;; esac
NAME=""; PORT=""; WEIGHTS=""; START=1; REGISTER=1; FORCE=0; PURGE=0; YES=0
while [ $# -gt 0 ]; do
  case "$1" in
    --port) [[ "${2:-}" =~ ^[0-9]+$ ]] || fail "--port needs a port number"; PORT="$2"; shift 2 ;;
    --weights) [ -d "${2:-}" ] || fail "--weights needs an existing folder"; WEIGHTS="$2"; shift 2 ;;
    --no-start) START=0; shift ;;
    --no-register) REGISTER=0; shift ;;
    --force) FORCE=1; shift ;;
    --purge) PURGE=1; shift ;;
    --yes) YES=1; shift ;;
    -h|--help) usage; exit 0 ;;
    -*) fail "Unknown option $1" ;;
    *) [ -z "$NAME" ] || fail "Name one pack"; NAME="$1"; shift ;;
  esac
done

case "$COMMAND" in
  list)
    for pack in $(packs); do
      if fits "$HERE/$pack/pack.json"; then note "$pack  fits  $(field "$HERE/$pack/pack.json" name)"; else note "$pack  does not fit  $(field "$HERE/$pack/pack.json" name)"; fi
    done ;;
  recommend)
    for pack in $(packs); do if fits "$HERE/$pack/pack.json"; then note "$pack"; exit 0; fi; done
    note "No pack fits this machine; add an AI provider key, or pair a computer that runs models, in Settings → Models"; exit 1 ;;
  check) file=$(manifest "$NAME"); note "$(field "$file" name)"; fits "$file" show ;;
  install) file=$(manifest "$NAME"); need_docker; install_pack "$NAME" "$file" ;;
  start) file=$(manifest "$NAME"); need_docker; run_pack "$NAME" "$file" ;;
  stop) manifest "$NAME" >/dev/null; need_docker; "${DOCKER[@]}" stop "$(container "$NAME")" >/dev/null && note "Stopped $NAME" ;;
  status) manifest "$NAME" >/dev/null; need_docker; status_pack "$NAME" ;;
  remove) manifest "$NAME" >/dev/null; need_docker; remove_pack "$NAME" ;;
  ""|help) usage ;;
  *) usage >&2; exit 2 ;;
esac

import { spawn } from "node:child_process";
import { chmod, lstat, mkdir, open, readFile, readdir, realpath, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createJSON, readJSON, writeJSON } from "../src/config";
import { processBirth } from "../src/process-info";
import metadata from "../package.json";

process.umask(0o077);
const keep = new Set(["HOME", "PATH", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "USER", "LOGNAME", "SHELL", "TERM", "NO_COLOR", "__CF_USER_TEXT_ENCODING", "__CFBundleIdentifier"]);
for (const name of Object.keys(process.env)) if (!keep.has(name)) delete process.env[name];
process.env.OPENOX_PERSONAL_AGENT = "1";
process.env.OPENOX_MEDIA_URL = "http://127.0.0.1:9";

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  data: { type: "string" }, "no-open": { type: "boolean" }, "no-start": { type: "boolean" },
} });
const command = positionals[0] ?? "open";
if (positionals.length > 1 || !["open", "serve", "stop", "status"].includes(command)) throw new Error("Use open, serve, stop or status");
if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("This local preview supports Apple Silicon Macs only");
const requested = resolve(values.data ?? join(homedir(), "Library/Application Support/OpenOx Personal Preview"));
const script = await realpath(import.meta.path);
type Owner = { version: 1; state: "starting" | "running"; pid: number; birth: string; data: string; script: string; nonce: string; socket: string; origin: string | null };
type Reply = { running?: boolean; origin?: string; url?: string; expiresAt?: string; stopped?: boolean };
type Marker = { version: 1; kind: "openox-personal-preview"; id: string; port?: number };
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

async function exists(path: string) {
  try { return await lstat(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
if (!await exists(requested) && ["stop", "status"].includes(command)) {
  console.log(JSON.stringify({ running: false })); process.exit(0);
}
await mkdir(requested, { recursive: true, mode: 0o700 });
const info = await lstat(requested);
if (!info.isDirectory() || info.isSymbolicLink() || info.mode & 0o077) throw new Error("Use a direct, owner-only preview data directory");
const data = await realpath(requested), markerPath = join(data, "preview.json"), recordPath = join(data, "run.json"), lockPath = join(data, "run.lock"), socketPath = join(data, "owner.sock");
if (Buffer.byteLength(socketPath) >= 104) throw new Error("The preview data path is too long for its private control socket");
let marker = await readJSON<Marker | null>(markerPath, null);
if (!marker) {
  if ((await readdir(data)).length) throw new Error("This folder already contains other data. Choose an empty independent preview folder");
  marker = { version: 1, kind: "openox-personal-preview", id: crypto.randomUUID() };
  await createJSON(markerPath, marker);
}
if (marker.version !== 1 || marker.kind !== "openox-personal-preview" || !/^[a-f0-9-]{36}$/.test(marker.id)) throw new Error("The preview data marker is invalid or belongs to another application");
if (marker.port !== undefined && (!Number.isInteger(marker.port) || marker.port < 1024 || marker.port > 65535)) throw new Error("The preview's saved port is invalid; it was not replaced");

function validOwner(value: unknown): value is Owner {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.version === 1 && record.data === data && record.script === script && record.socket === socketPath
    && typeof record.pid === "number" && Number.isSafeInteger(record.pid) && record.pid > 0 && record.pid <= 2_147_483_647
    && typeof record.birth === "string" && record.birth.length > 0 && record.birth.length <= 128
    && typeof record.nonce === "string" && /^[a-f0-9-]{36}$/.test(record.nonce)
    && (record.state === "starting" && record.origin === null || record.state === "running" && typeof record.origin === "string" && /^http:\/\/127\.0\.0\.1:\d+$/.test(record.origin));
}
async function recoverStaleOwner() {
  const guard = join(data, "recovery.lock");
  if (await exists(guard)) throw new Error("Preview recovery is already running or was interrupted. Its files were retained.");
  const lock = await readJSON<unknown>(lockPath, null);
  if (!lock) {
    if (await exists(recordPath) || await exists(socketPath)) throw new Error("Preview ownership is incomplete. Its files were retained.");
    return;
  }
  if (!validOwner(lock) || (await lstat(lockPath)).mode & 0o077) throw new Error("Preview ownership is invalid or belongs to another bundle. It was not recovered.");
  if (await processBirth(lock.pid) === lock.birth) return;
  const tag = crypto.randomUUID();
  try { await createJSON(guard, { tag, pid: process.pid }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("Preview recovery is already running. No ownership files were changed.");
    throw error;
  }
  try {
    const current = await readJSON<unknown>(lockPath, null);
    if (!validOwner(current) || current.nonce !== lock.nonce || await processBirth(current.pid) === current.birth) throw new Error("Preview ownership changed. Its files were retained.");
    const record = await readJSON<unknown>(recordPath, null);
    if (record && (!validOwner(record) || record.state !== "running" || record.nonce !== current.nonce || record.pid !== current.pid || record.birth !== current.birth)) {
      throw new Error("Preview ownership records disagree. They were retained.");
    }
    const socket = await exists(socketPath);
    if (socket) {
      if (!socket.isSocket() || socket.mode & 0o077) throw new Error("The preview control channel is foreign or unverified. It was retained.");
      try {
        await fetch("http://owner/", { unix: socketPath, method: "POST", signal: AbortSignal.timeout(2_000),
          headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "status", nonce: current.nonce }) });
        throw new Error("The preview control channel is still active. It was not replaced.");
      } catch (error) {
        if (!["ECONNREFUSED", "ENOENT", "ConnectionRefused"].includes(String((error as NodeJS.ErrnoException).code))) throw error;
      }
    }
    if (record) await rm(recordPath);
    if (socket) await rm(socketPath);
    const final = await readJSON<unknown>(lockPath, null);
    if (!validOwner(final) || final.nonce !== current.nonce) throw new Error("Preview ownership changed. Its files were retained.");
    await rm(lockPath);
    console.error("Recovered verified interrupted preview ownership; data and saved origin retained.");
  } finally {
    const value = await readJSON<{ tag: string }>(guard, { tag: "" });
    if (value.tag !== tag) throw new Error("Preview recovery ownership changed. Its files were retained.");
    await rm(guard);
  }
}

async function owner() {
  const value = await readJSON<Owner | null>(recordPath, null);
  if (!value) return null;
  if (!validOwner(value) || value.state !== "running") {
    throw new Error("The preview ownership record is invalid or belongs to another bundle. It was not replaced or stopped");
  }
  if (await processBirth(value.pid) !== value.birth) throw new Error("The previous preview owner is gone. Its record was retained; reopen the preview to recover verified ownership.");
  return value;
}
async function request(value: Owner, action: "open" | "stop" | "status") {
  const [socket, parent] = await Promise.all([lstat(value.socket), lstat(data)]);
  if (!socket.isSocket() || socket.mode & 0o077 || parent.mode & 0o077) throw new Error("The preview control channel needs owner-only permissions");
  const response = await fetch("http://owner/", { unix: value.socket, method: "POST", signal: AbortSignal.timeout(5_000),
    headers: { "content-type": "application/json" }, body: JSON.stringify({ action, nonce: value.nonce }) });
  if (!response.ok) throw new Error(`The owned preview control request failed with HTTP ${response.status}`);
  const reply = await response.json() as Reply;
  if (reply.origin !== value.origin) throw new Error("The preview control reply does not match this owner");
  return reply;
}
async function waitReady() {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const value = await owner();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error("The preview did not become ready. Inspect preview-launch.log; no other Host was stopped");
    await Bun.sleep(100);
  }
}
async function release(nonce: string) {
  const lock = await readJSON<Owner | null>(lockPath, null);
  if (!lock || lock.nonce !== nonce || lock.script !== script || lock.data !== data) throw new Error("Preview ownership changed; its files were retained");
  const current = await readJSON<Owner | null>(recordPath, null);
  if (current && current.nonce !== nonce) throw new Error("Preview ownership changed; its record was retained");
  if (current) await rm(recordPath);
  await rm(socketPath, { force: true });
  await rm(lockPath);
}

if (command === "serve") {
  await recoverStaleOwner();
  if (await exists(lockPath)) throw new Error("This preview already has an owner or an unfinished shutdown. No other process was replaced");
  const ownBirth = await processBirth(process.pid);
  if (!ownBirth) throw new Error("Cannot establish preview process ownership");
  const nonce = crypto.randomUUID(), starting: Owner = { version: 1, state: "starting", pid: process.pid, birth: ownBirth, data, script, nonce, socket: socketPath, origin: null };
  await createJSON(lockPath, starting);
  const finished = Promise.withResolvers<void>(), signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  const stop = () => finished.resolve();
  for (const signal of signals) process.on(signal, stop);
  let host: import("../src/host").Host | undefined, server: Awaited<ReturnType<typeof import("../src/server").startServer>> | undefined, control: ReturnType<typeof Bun.serve> | undefined;
  try {
    const [{ Host }, { startServer }] = await Promise.all([import("../src/host"), import("../src/server")]);
    const scope = `ox_personal_${new Bun.CryptoHasher("sha256").update(data).digest("hex").slice(0, 20)}`;
    host = await Host.open({ data, hostID: "OpenOx Personal Preview", version: metadata.version, quiet: true, browserCookieName: scope });
    server = await startServer(host, { hostname: "127.0.0.1", port: marker.port ?? 0 });
    if (marker.port === undefined) { marker.port = server.port; await writeJSON(markerPath, marker); }
    const origin = `http://127.0.0.1:${server.port}`, workspace = host;
    workspace.localWorkspaceOrigin = origin;
    control = Bun.serve({ unix: socketPath, maxRequestBodySize: 4_096, async fetch(input) {
      if (input.method !== "POST" || input.headers.has("origin")) return Response.json({ error: "Private owner control only" }, { status: 403 });
      let body: { nonce?: unknown; action?: unknown };
      try { body = await input.json(); } catch { return Response.json({ error: "Send an owner action" }, { status: 400 }); }
      if (!body || body.nonce !== nonce) return Response.json({ error: "Owner authorization required" }, { status: 403 });
      if (body.action === "status") return Response.json({ running: true, origin });
      if (body.action === "open") {
        const grant = workspace.devices.createWorkspaceGrant();
        return Response.json({ origin, url: `${origin}/#/local-workspace/${grant.grant}/home`, expiresAt: grant.expiresAt });
      }
      if (body.action === "stop") { setTimeout(stop, 25); return Response.json({ stopped: true, origin }); }
      return Response.json({ error: "Unknown owner action" }, { status: 400 });
    } });
    await chmod(socketPath, 0o600);
    await writeJSON(recordPath, { ...starting, state: "running", origin } satisfies Owner);
    console.log(`OpenOx Personal Preview ready: ${origin}\nData: ${data}`);
    await finished.promise;
  } finally {
    for (const signal of signals) process.removeListener(signal, stop);
    if (host) { host.localWorkspaceOrigin = null; host.devices.clearWorkspaceGrants(); }
    const failures: unknown[] = [];
    for (const close of [() => control?.stop(true), () => server?.stop(true), () => host?.close()]) {
      try { await close(); } catch (error) { failures.push(error); console.error("Preview cleanup failed:", message(error)); }
    }
    if (failures.length) throw new AggregateError(failures, "The preview did not finish stopping; its ownership record was retained");
    await release(nonce);
  }
} else if (command === "stop") {
  const value = await owner();
  if (!value) { console.log(JSON.stringify({ running: false })); process.exit(0); }
  await request(value, "stop");
  const deadline = Date.now() + 20_000;
  while (await exists(recordPath)) {
    if (Date.now() >= deadline) throw new Error("The owned preview is still stopping; it was not force-killed");
    await Bun.sleep(100);
  }
  console.log(JSON.stringify({ stopped: true, dataPreserved: true }));
} else if (command === "status") {
  const value = await owner();
  console.log(JSON.stringify(value ? await request(value, "status") : { running: false }));
} else {
  if (!values["no-start"]) await recoverStaleOwner();
  let value = await owner();
  if (!value) {
    if (values["no-start"]) throw new Error("The preview is not running");
    if (await exists(lockPath)) throw new Error("Another preview launch or unfinished shutdown owns this folder. It was not replaced");
    const log = await open(join(data, "preview-launch.log"), "a", 0o600);
    try {
      const child = spawn(process.execPath, ["--no-env-file", script, "serve", "--data", data], { detached: true, stdio: ["ignore", log.fd, log.fd], env: process.env });
      child.once("error", error => console.error("Preview launch failed:", message(error)));
      child.unref();
    } finally { await log.close(); }
    value = await waitReady();
  }
  const link = await request(value, "open");
  if (!link.url || !link.expiresAt || !link.url.startsWith(`${value.origin}/#/local-workspace/`) || !link.url.endsWith("/home")) throw new Error("The owned preview did not return a valid local entry");
  if (values["no-open"]) console.log(JSON.stringify(link));
  else {
    const child = Bun.spawn(["/usr/bin/open", link.url], { stdout: "inherit", stderr: "inherit" });
    if (await child.exited) throw new Error("The browser could not open the preview; the Host remains running");
    console.log(`Opened OpenOx Personal Preview: ${value.origin}/#/home`);
  }
}

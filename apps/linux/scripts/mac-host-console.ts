import { createServer, createConnection, type Socket } from "node:net";
import { chmod, lstat, mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Host } from "../src/host";
import type { DeviceInfo } from "../src/auth";
import { readJSON } from "../src/config";
import { invitation } from "../src/connections";
import { webAssets } from "../src/server";

type PairingView = { state: "none" | "active" | "expired" | "used-or-replaced"; url?: string; expiresAt?: string };
export type ConsoleRuntimeState = { kind: "stopped" | "starting" | "running" | "stopping" }
  | { kind: "failed"; action: "start" | "stop"; message: string };
export type ConsoleContext = Pick<Host, "paths" | "devices" | "settings" | "hostID" | "version" | "localWorkspaceOrigin"> & {
  logs: Pick<Host["logs"], "info" | "warning" | "error">;
  notifications: Pick<Host["notifications"], "webSessions">;
  emit(event: { type: "devices" }): void;
  lifecycle?: { state(): ConsoleRuntimeState; revision(): number; start(): Promise<void>; stop(): Promise<void> };
};
export type ConsoleState = {
  host: { name: string; workspace: string; version: string; origin: string; data: string; certificateExpires: string };
  devices: (DeviceInfo & { webSessions: number })[];
  pairing: PairingView;
  csrf: string;
  checkedAt: string;
  runtime: { controllable: boolean; revision: number; state: ConsoleRuntimeState };
};
type Link = { url: string; expiresAt: string };
class ControlError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
const hash = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex");
const secret = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");

export async function startHostConsole(host: ConsoleContext, origin: string, certificateExpires: string) {
  if (host.localWorkspaceOrigin) throw new Error("A local console is already active for this Host");
  const assets = await webAssets(join(import.meta.dir, "../web/host-console.html"), [["icon.svg", "image/svg+xml"]]);
  const prefix = `/host/${crypto.randomUUID()}/`, cookie = `ox_control_${crypto.randomUUID().replaceAll("-", "")}`;
  const claims = new Map<string, number>(), sessions = new Map<string, { expires: number; csrf: string }>();
  let pending: { code: string; expiresAt: string } | undefined;
  let controlOrigin = "";
  const runtime = () => ({ controllable: !!host.lifecycle, revision: host.lifecycle?.revision() ?? 0, state: host.lifecycle?.state() ?? { kind: "running" as const } });
  const requireRunning = () => {
    if (runtime().state.kind !== "running") throw new ControlError(409, "Start the Host from this console first.");
  };
  const headers = { "cache-control": "no-store", "referrer-policy": "same-origin", "x-content-type-options": "nosniff", "x-frame-options": "DENY",
    "content-security-policy": `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self' ${origin}` };
  const json = (body: unknown, status = 200, extra: Record<string, string> = {}) => Response.json(body, { status, headers: { ...headers, ...extra } });
  const sessionKey = (request: Request) => {
    const raw = request.headers.get("cookie")?.split(";").map(value => value.trim()).find(value => value.startsWith(`${cookie}=`))?.slice(cookie.length + 1);
    return raw ? hash(raw) : undefined;
  };
  const sessionFor = (request: Request) => {
    const key = sessionKey(request);
    if (!key) return undefined;
    const session = sessions.get(key);
    if (!session || session.expires <= Date.now()) return undefined;
    return session;
  };
  async function pairing(): Promise<PairingView> {
    if (runtime().state.kind !== "running") return { state: "none" };
    if (!pending) return { state: "none" };
    if (Date.parse(pending.expiresAt) <= Date.now()) return { state: "expired", expiresAt: pending.expiresAt };
    const file = await readJSON<{ hash: string; expiresAt: string } | null>(host.paths.pairing, null);
    if (!file || file.hash !== hash(pending.code.replaceAll("-", ""))) return { state: "used-or-replaced", expiresAt: pending.expiresAt };
    if (!Number.isFinite(Date.parse(file.expiresAt))) throw new Error("The pairing record is invalid");
    if (Date.parse(file.expiresAt) <= Date.now()) return { state: "expired", expiresAt: file.expiresAt };
    return { state: "active", url: invitation(origin, pending.code), expiresAt: pending.expiresAt };
  }
  async function newPairing() {
    requireRunning();
    pending = await host.devices.createPairingCode();
    return pairing();
  }
  function link(panel = "devices"): Link {
    const now = Date.now();
    for (const [key, expires] of claims) if (expires <= now) claims.delete(key);
    for (const [key, value] of sessions) if (value.expires <= now) sessions.delete(key);
    if (claims.size >= 16 || sessions.size >= 32) throw new Error("Too many local console sessions; close old sessions and try again");
    const token = secret(), expires = now + 120000;
    claims.set(hash(token), expires);
    return { url: `${controlOrigin}${prefix}#claim=${token}&panel=${panel}`, expiresAt: new Date(expires).toISOString() };
  }
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, maxRequestBodySize: 4096, development: false,
    async fetch(request) {
      try {
        const url = new URL(request.url);
        if (url.origin !== controlOrigin) throw new ControlError(403, "Unexpected local Host header");
        const source = request.headers.get("origin");
        if (source && source !== controlOrigin) throw new ControlError(403, "Cross-origin console request refused");
        if (!url.pathname.startsWith(prefix)) throw new ControlError(404, "Not found");
        const path = url.pathname.slice(prefix.length);
        if (!path.startsWith("api/")) {
          if (request.method !== "GET") throw new ControlError(405, "Use GET");
          const asset = assets.get(`/${path}`);
          if (!asset) throw new ControlError(404, "Not found");
          return new Response(asset.body, { headers: { ...headers, "content-type": asset.type } });
        }
        if (request.method !== "GET" && source !== controlOrigin) throw new ControlError(403, "A same-origin console action is required");
        if (path === "api/claim" && request.method === "POST") {
          if (!request.headers.get("content-type")?.startsWith("application/json")) throw new ControlError(400, "Send JSON");
          let body: unknown;
          try { body = await request.json(); } catch { throw new ControlError(400, "Invalid JSON"); }
          if (!body || typeof body !== "object" || !("claim" in body) || typeof body.claim !== "string" || !/^[a-f0-9]{64}$/.test(body.claim)) {
            throw new ControlError(401, "Local authorization is invalid");
          }
          const digest = hash(body.claim), expires = claims.get(digest);
          if (!expires || expires <= Date.now()) throw new ControlError(401, "Local authorization expired or was already used");
          claims.delete(digest);
          const previous = sessionKey(request);
          if (previous) sessions.delete(previous);
          const token = secret();
          sessions.set(hash(token), { expires: Date.now() + 8 * 60 * 60_000, csrf: secret() });
          return json({ authorized: true }, 200, { "set-cookie": `${cookie}=${token}; HttpOnly; SameSite=Strict; Path=${prefix}; Max-Age=28800` });
        }
        const session = sessionFor(request);
        if (!session) throw new ControlError(401, "Open the console from Open Console.command on this Mac");
        if (path === "api/state" && request.method === "GET") {
          const devices = await host.devices.list();
          const state: ConsoleState = { host: { name: host.hostID, workspace: host.settings.profile.name, version: host.version,
            origin, data: host.paths.data, certificateExpires },
          devices: devices.map(device => ({ ...device, webSessions: host.notifications.webSessions(device.id) })),
          pairing: await pairing(), csrf: session.csrf, checkedAt: new Date().toISOString(), runtime: runtime() };
          return json(state);
        }
        if (path === "api/workspace" && request.method === "POST") {
          if (!request.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded")) throw new ControlError(400, "Use the workspace form");
          const body = new URLSearchParams(await request.text());
          if (body.get("csrf") !== session.csrf) throw new ControlError(403, "Console action verification failed");
          requireRunning();
          const fresh = host.devices.createWorkspaceGrant(Math.min(60_000, session.expires - Date.now()));
          return new Response(null, { status: 303, headers: { ...headers, location: `${origin}/#/local-workspace/${fresh.grant}` } });
        }
        if (request.headers.get("x-ox-control") !== session.csrf) throw new ControlError(403, "Console action verification failed");
        if ((path === "api/runtime/start" || path === "api/runtime/stop") && request.method === "POST") {
          if (!host.lifecycle) throw new ControlError(404, "Host controls are not available in this console");
          const current = runtime().state;
          if (current.kind === "starting" || current.kind === "stopping") throw new ControlError(409, "A Host operation is already in progress");
          if (path === "api/runtime/start") await host.lifecycle.start();
          else await host.lifecycle.stop();
          return json(runtime());
        }
        if (path === "api/pairing" && request.method === "POST") return json(await newPairing());
        if (path.startsWith("api/devices/") && request.method === "DELETE") {
          const id = path.slice("api/devices/".length);
          if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new ControlError(400, "Invalid pairing identifier");
          if (!await host.devices.revoke(id)) throw new ControlError(404, "The pairing no longer exists");
          host.logs.info("console", `device revoked by local operator id=${id}`);
          host.emit({ type: "devices" });
          return json({ revoked: true });
        }
        throw new ControlError(404, "Not found");
      } catch (error) {
        if (error instanceof ControlError) return json({ error: error.message }, error.status);
        host.logs.error("console", error instanceof Error ? error.message : String(error));
        return json({ error: "The local console operation failed. Check this Host's diagnostics." }, 500);
      }
    },
  });
  controlOrigin = `http://127.0.0.1:${server.port}`;
  const directory = await mkdtemp("/tmp/ox-host-console-");
  await chmod(directory, 0o700);
  const socketPath = join(directory, "control.sock"), sockets = new Set<Socket>();
  const ipc = createServer(socket => {
    sockets.add(socket);
    socket.setTimeout(5000, () => socket.destroy());
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", error => host.logs.warning("console", `local IPC failed: ${error.message}`));
    let input = "", handled = false;
    socket.on("data", bytes => {
      if (handled) return;
      input += bytes.toString("utf8");
      if (input.length > 1024) { socket.destroy(); return; }
      if (!input.includes("\n")) return;
      handled = true;
      void (async () => {
        try {
          const body = JSON.parse(input) as { action?: unknown };
          if (body.action !== "open" && body.action !== "pair" && body.action !== "start") throw new Error("Unknown local action");
          if (body.action === "start") {
            if (!host.lifecycle) throw new Error("Host controls are not available in this console");
            await host.lifecycle.start();
          }
          if (body.action === "pair") await newPairing();
          socket.end(JSON.stringify(link(body.action === "pair" ? "pair" : "devices")) + "\n");
        } catch (error) {
          host.logs.error("console", error instanceof Error ? error.message : "Local console launch failed");
          socket.end(JSON.stringify({ error: "Cannot open the local console; inspect Host diagnostics" }) + "\n");
        }
      })();
    });
  });
  try {
    await new Promise<void>((resolve, reject) => { ipc.once("error", reject); ipc.listen(socketPath, resolve); });
    await chmod(socketPath, 0o600);
  } catch (error) {
    await server.stop(true);
    for (const socket of sockets) socket.destroy();
    if (ipc.listening) await new Promise<void>(resolve => ipc.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  host.localWorkspaceOrigin = origin;
  return {
    url: `${controlOrigin}${prefix}`, socket: socketPath, link,
    async close() {
      claims.clear(); sessions.clear();
      host.localWorkspaceOrigin = null; host.devices.clearWorkspaceGrants();
      await server.stop(true);
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => ipc.close(error => error ? reject(error) : resolve()));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

export async function consoleLink(socketPath: string, expected: string, action: "open" | "pair" | "start"): Promise<Link> {
  const [socketInfo, parent] = await Promise.all([lstat(socketPath), lstat(dirname(socketPath))]);
  if (!socketInfo.isSocket() || (socketInfo.mode & 0o077) || !parent.isDirectory() || (parent.mode & 0o077)) {
    throw new Error("The local control socket needs owner-only permissions");
  }
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let output = "", finished = false;
    const finish = (error?: Error, value?: Link) => {
      if (finished) return; finished = true; socket.destroy();
      if (error) reject(error); else if (value) resolve(value);
    };
    socket.setTimeout(5000, () => finish(new Error("Local console request timed out")));
    socket.on("error", error => finish(error));
    socket.on("connect", () => socket.write(JSON.stringify({ action }) + "\n"));
    socket.on("end", () => { if (!finished) finish(new Error("Local console reply was incomplete")); });
    socket.on("data", bytes => {
      output += bytes.toString("utf8");
      if (output.length > 4096) { finish(new Error("Local console reply is too large")); return; }
      if (!output.includes("\n")) return;
      try {
        const value = JSON.parse(output) as Link & { error?: string };
        if (value.error) throw new Error(value.error);
        const url = new URL(value.url), base = new URL(expected);
        if (url.origin !== base.origin || url.pathname !== base.pathname || url.search || !/^#claim=[a-f0-9]{64}&panel=(devices|pair)$/.test(url.hash)) {
          throw new Error("Unexpected local console reply");
        }
        finish(undefined, value);
      } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
    });
  });
}

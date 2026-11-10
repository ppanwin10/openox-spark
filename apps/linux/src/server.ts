import { join } from "node:path";
import type { Server, ServerWebSocket } from "bun";
import type { Host } from "./host";
import { handleAPI, json } from "./api";
import { handleRPC, changedNotification } from "./rpc";
import { requestToken, sameOrigin, type DeviceInfo } from "./auth";

type SocketData = { device: DeviceInfo | undefined; token: string | undefined };
const admission = "Authentication required: create a token with openox-host token --name <device> on the Host and set OX_HOST_TOKEN";
const security = {
  "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "x-frame-options": "DENY",
  "cross-origin-opener-policy": "same-origin", "permissions-policy": "camera=(), microphone=(self), geolocation=()",
};
const appPolicy = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; "
  + "font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; manifest-src 'self'";

async function webAssets() {
  const result = await Bun.build({ entrypoints: [join(import.meta.dir, "../web/index.html")], target: "browser", minify: true, naming: { asset: "[name]-[hash].[ext]" } });
  if (!result.success) throw new AggregateError(result.logs, "Web client build failed");
  const assets = new Map<string, { body: Blob; type: string }>();
  for (const output of result.outputs) {
    const path = "/" + output.path.replace(/^\.\//, "");
    assets.set(path, { body: output, type: output.type });
  }
  const index = assets.get("/index.html");
  if (!index) throw new Error("Web client build produced no index.html");
  assets.set("/", index);
  for (const [name, type] of [["manifest.webmanifest", "application/manifest+json"], ["icon.svg", "image/svg+xml"]] as const) {
    assets.set(`/${name}`, { body: Bun.file(join(import.meta.dir, "../web", name)), type });
  }
  return assets;
}

function asset(assets: Awaited<ReturnType<typeof webAssets>>, pathname: string) {
  const found = assets.get(pathname);
  if (!found) return undefined;
  const html = found.type.startsWith("text/html");
  return new Response(found.body, { headers: { ...security, "content-type": found.type,
    "cache-control": html || pathname.endsWith(".webmanifest") ? "no-cache" : "public, max-age=31536000, immutable",
    ...(html ? { "content-security-policy": appPolicy } : {}) } });
}

function admissionFailure(text: string) {
  let id: unknown = null;
  try { const parsed = JSON.parse(text) as { id?: unknown }; if (typeof parsed.id === "string" || typeof parsed.id === "number") id = parsed.id; } catch {}
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32001, message: admission } });
}

export async function startServer(host: Host, options: { hostname: string; port: number; tls?: { cert: string; key: string } }) {
  const assets = await webAssets();
  const sockets = new Set<ServerWebSocket<SocketData>>();
  const server: Server<SocketData> = Bun.serve<SocketData>({
    hostname: options.hostname, port: options.port, tls: options.tls, idleTimeout: 120, maxRequestBodySize: 210 * 1024 * 1024, development: false,
    async fetch(request, server) {
      const url = new URL(request.url);
      const upgrade = request.headers.get("upgrade")?.toLowerCase() === "websocket";
      if (url.pathname === "/rpc" || (upgrade && url.pathname === "/")) {
        if (!sameOrigin(request)) return json({ error: "Cross-origin connection refused" }, { status: 403 });
        const token = requestToken(request);
        const device = await host.devices.authenticate(token);
        if (!upgrade && !device) return json({ error: admission }, { status: 401 });
        if (server.upgrade(request, { data: { device, token } })) return undefined;
        return json({ error: "WebSocket upgrade required" }, { status: 426 });
      }
      if (url.pathname.startsWith("/api/")) {
        if (request.method !== "GET" && !sameOrigin(request)) return json({ error: "Cross-origin request refused" }, { status: 403 });
        const response = await handleAPI(host, request, url);
        for (const [key, value] of Object.entries(security)) response.headers.set(key, value);
        return response;
      }
      return asset(assets, url.pathname) ?? (request.method === "GET" && !url.pathname.includes(".") ? asset(assets, "/") : undefined)
        ?? new Response("Not found", { status: 404, headers: security });
    },
    websocket: {
      idleTimeout: 960,
      open(socket) {
        if (!socket.data.device) { setTimeout(() => socket.close(4401, "Authentication required"), 5_000); return; }
        sockets.add(socket);
        host.logs.info("rpc", `connected device=${socket.data.device.id}`);
      },
      async message(socket, message) {
        const text = typeof message === "string" ? message : new TextDecoder().decode(message);
        if (!socket.data.device || !await host.devices.authenticate(socket.data.token)) {
          socket.send(admissionFailure(text));
          socket.close(4401, "Authentication required");
          return;
        }
        const reply = await handleRPC(host, text);
        if (reply !== undefined) socket.send(reply);
      },
      close(socket) { sockets.delete(socket); },
    },
  });
  host.subscribe(event => {
    if (event.type === "conversation") for (const socket of sockets) socket.send(changedNotification(event.id));
    if (event.type === "devices") for (const socket of sockets) {
      void host.devices.authenticate(socket.data.token).then(device => { if (!device) socket.close(4401, "Device revoked"); });
    }
  });
  host.logs.info("host", `listening on ${options.tls ? "https" : "http"}://${server.hostname}:${server.port}`);
  return server;
}

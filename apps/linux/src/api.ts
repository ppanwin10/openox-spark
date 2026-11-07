import { isUtf8 } from "node:buffer";
import { basename, extname } from "node:path";
import type { Host } from "./host";
import { AuthError, clearedCookie, deviceCookie, requestToken, type DeviceInfo } from "./auth";
import { customProviderID } from "./providers";

const fileLimit = 32 * 1024 * 1024;
const textLimit = 200 * 1024;
const jsonLimit = 1024 * 1024;
const types: Record<string, string> = {
  ".txt": "text/plain; charset=utf-8", ".md": "text/plain; charset=utf-8", ".csv": "text/csv; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".pdf": "application/pdf", ".mp4": "video/mp4", ".mp3": "audio/mpeg",
  ".js": "text/plain; charset=utf-8", ".ts": "text/plain; charset=utf-8", ".py": "text/plain; charset=utf-8", ".xml": "text/plain; charset=utf-8",
  ".yaml": "text/plain; charset=utf-8", ".yml": "text/plain; charset=utf-8", ".log": "text/plain; charset=utf-8",
};
const inline = new Set([".txt", ".md", ".csv", ".json", ".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".pdf", ".mp4", ".mp3", ".html", ".htm",
  ".js", ".ts", ".py", ".xml", ".yaml", ".yml", ".log"]);

export class HTTPError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
export const json = (value: unknown, init: ResponseInit = {}) => Response.json(value, { ...init, headers: { "cache-control": "no-store", ...init.headers } });
const problem = (status: number, message: string) => json({ error: message }, { status });

async function payload<T>(request: Request): Promise<T> {
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > jsonLimit) throw new HTTPError(413, "Request is too large");
  const text = await request.text();
  if (text.length > jsonLimit) throw new HTTPError(413, "Request is too large");
  try { return JSON.parse(text || "{}") as T; } catch { throw new HTTPError(400, "Expected JSON"); }
}
async function bytes(request: Request) {
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > fileLimit) throw new HTTPError(413, "Files are limited to 32 MiB");
  const data = new Uint8Array(await request.arrayBuffer());
  if (data.length > fileLimit) throw new HTTPError(413, "Files are limited to 32 MiB");
  return data;
}
const content = (data: Uint8Array) => data.length <= textLimit && isUtf8(data) ? new TextDecoder().decode(data) : data;
const parameter = (url: URL, name: string) => {
  const value = url.searchParams.get(name);
  if (value === null) throw new HTTPError(400, `Missing ${name}`);
  return value;
};
const conversationID = (value: string) => {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new HTTPError(404, "Conversation not found");
  return Number(value);
};
const safeName = (value: string) => {
  const name = basename(value.replaceAll("\\", "/")).replace(/[\x00-\x1f\x7f]/g, "").trim();
  if (!name || name === "." || name === ".." || new TextEncoder().encode(name).length > 200) throw new HTTPError(400, "Choose a shorter file name");
  return name;
};

async function availablePath(host: Host, directory: string, name: string) {
  const extension = extname(name);
  const stem = extension ? name.slice(0, -extension.length) : name;
  for (let index = 1; index < 1_000; index++) {
    const candidate = `${directory}/${index === 1 ? name : `${stem} (${index})${extension}`}`;
    const exists = /^(conversation\.json|turns\.jsonl)$/i.test(basename(candidate)) || await host.profile.statFile(candidate).then(() => true, () => false);
    if (!exists) return candidate;
  }
  throw new HTTPError(409, "Too many files with this name");
}

function fileResponse(path: string, data: Blob, size: number, download: boolean) {
  const extension = extname(path).toLowerCase();
  const name = basename(path);
  const disposition = download || !inline.has(extension) ? "attachment" : "inline";
  return new Response(data, { headers: {
    "content-type": types[extension] ?? "application/octet-stream", "content-length": String(size),
    "content-disposition": `${disposition}; filename*=UTF-8''${encodeURIComponent(name)}`,
    "content-security-policy": "sandbox allow-scripts allow-popups allow-downloads; default-src 'unsafe-inline' data: blob:; img-src data: blob: 'self'",
    "cache-control": "no-store", "x-content-type-options": "nosniff",
  } });
}

function events(host: Host, request: Request, device: DeviceInfo) {
  const encoder = new TextEncoder();
  const token = requestToken(request);
  let stop = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let open = true;
      const send = (chunk: string) => { if (open) { try { controller.enqueue(encoder.encode(chunk)); } catch { close(); } } };
      const ping = setInterval(() => send(": keep-alive\n\n"), 20_000);
      const unsubscribe = host.subscribe(event => {
        if (event.type === "devices") {
          void host.devices.authenticate(token).then(current => { if (!current) close(); });
          return;
        }
        send(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      });
      const close = () => {
        if (!open) return;
        open = false;
        clearInterval(ping);
        unsubscribe();
        try { controller.close(); } catch {}
      };
      stop = close;
      request.signal.addEventListener("abort", close, { once: true });
      send(`retry: 3000\nevent: ready\ndata: ${JSON.stringify({ device: device.id })}\n\n`);
    },
    cancel() { stop(); },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" } });
}

async function settings(host: Host) {
  return { host: { id: host.hostID, version: host.version }, profile: host.settings.profile, storage: host.profile.content,
    defaultModel: host.defaultModel() ?? null, providers: host.providers.catalog(), custom: host.settings.custom ?? null,
    customKey: host.providers.hasKey(customProviderID) };
}

async function conversations(host: Host, request: Request, url: URL, parts: string[]) {
  const method = request.method;
  if (parts.length === 0) {
    if (method === "GET") {
      const items = [];
      let cursor;
      do { const page = await host.profile.list(100, cursor); items.push(...page.items); cursor = page.next; } while (cursor && items.length < 500);
      return json({ items });
    }
    if (method === "POST") {
      const body = await payload<{ model?: unknown }>(request);
      const choice = body.model ? host.providers.validChoice(body.model) : host.defaultModel();
      if (!choice) throw new HTTPError(409, "Add a model provider in Settings before starting a conversation");
      return json({ id: await host.profile.create(choice) }, { status: 201 });
    }
  }
  const id = conversationID(parts[0]!);
  const action = parts[1];
  if (!action) {
    if (method === "GET") return json(await host.profile.view(id));
    if (method === "PATCH") {
      const body = await payload<{ title?: unknown; model?: unknown }>(request);
      if (typeof body.title === "string") await host.profile.rename(id, body.title);
      if (body.model) await host.profile.setModel(id, host.providers.validChoice(body.model));
      return json(await host.profile.summary(id));
    }
    if (method === "DELETE") { await host.profile.remove(id); return json({ deleted: true }); }
  }
  if (method === "POST" && action === "messages") {
    const body = await payload<{ text?: unknown; attachments?: unknown }>(request);
    const text = typeof body.text === "string" ? body.text.trim() : "";
    const attachments = Array.isArray(body.attachments) ? body.attachments.filter((path): path is string => typeof path === "string").slice(0, 10) : [];
    if (!text && !attachments.length) throw new HTTPError(400, "Write a message or attach a file");
    if (text.length > 100_000) throw new HTTPError(413, "Messages are limited to 100,000 characters");
    if (host.profile.busy(id)) throw new HTTPError(409, "This conversation is still working");
    await host.profile.ready(id);
    host.logs.info("conversation", `send conversation=${id} characters=${text.length} attachments=${attachments.length}`);
    host.profile.send(id, text || "Please review the attached files.", attachments).then(result => {
      if (result.outcome === "failed") host.logs.warning("conversation", `run failed conversation=${id}: ${result.error}`);
    }, error => host.logs.error("conversation", `run error conversation=${id}: ${error instanceof Error ? error.message : String(error)}`));
    return json({ accepted: true }, { status: 202 });
  }
  if (method === "POST" && action === "stop") return json({ wasRunning: await host.profile.stop(id) });
  if (method === "POST" && action === "respond") {
    const body = await payload<{ promptId?: unknown; answer?: unknown }>(request);
    host.profile.respond(id, String(body.promptId ?? ""), String(body.answer ?? ""));
    return json({ answered: true });
  }
  if (method === "POST" && action === "read") { await host.profile.markRead(id); return json({ read: true }); }
  if (method === "POST" && action === "attachments") {
    const path = await availablePath(host, `conversations/${id}`, safeName(parameter(url, "name")));
    return json(await host.profile.writeFile(path, content(await bytes(request))), { status: 201 });
  }
  throw new HTTPError(404, "Not found");
}

async function files(host: Host, request: Request, url: URL, parts: string[]) {
  const method = request.method;
  if (parts.length === 0) {
    const path = url.searchParams.get("path") ?? "";
    if (method === "GET") return json({ path, entries: await host.profile.listFiles(path) });
    if (method === "DELETE") { await host.profile.removeFile(parameter(url, "path")); return json({ deleted: true }); }
  }
  if (parts[0] === "content") {
    const path = parameter(url, "path");
    if (method === "GET") {
      const { entry, file } = await host.profile.openFile(path);
      return fileResponse(entry.path, file, entry.size, url.searchParams.get("download") === "1");
    }
    if (method === "PUT") {
      const exists = await host.profile.statFile(path).then(() => true, () => false);
      if (exists && url.searchParams.get("overwrite") !== "1") throw new HTTPError(409, "A file with this name already exists");
      return json(await host.profile.writeFile(path, content(await bytes(request))), { status: 201 });
    }
  }
  if (method === "POST" && parts[0] === "folder") {
    const body = await payload<{ path?: unknown }>(request);
    return json(await host.profile.makeDirectory(String(body.path ?? "")), { status: 201 });
  }
  if (method === "POST" && parts[0] === "move") {
    const body = await payload<{ from?: unknown; to?: unknown }>(request);
    return json(await host.profile.moveFile(String(body.from ?? ""), String(body.to ?? "")));
  }
  throw new HTTPError(404, "Not found");
}

async function settingsRoute(host: Host, request: Request, parts: string[]) {
  const method = request.method;
  if (parts.length === 0 && method === "GET") return json(await settings(host));
  if (parts[0] === "default-model" && method === "PUT") {
    await host.updateSettings({ defaultModel: host.providers.validChoice(await payload(request)) });
    return json(await settings(host));
  }
  if (parts[0] === "profile" && method === "PUT") {
    const body = await payload<{ name?: unknown }>(request);
    const name = typeof body.name === "string" ? body.name.trim().slice(0, 60) : "";
    if (!name) throw new HTTPError(400, "Enter a Profile name");
    await host.updateSettings({ profile: { ...host.settings.profile, name } });
    return json(await settings(host));
  }
  if (parts[0] === "providers" && parts[1] === customProviderID && method === "PUT") {
    const body = await payload<{ baseUrl?: unknown; models?: unknown; name?: unknown; key?: unknown }>(request);
    const models = Array.isArray(body.models) ? body.models.map(String) : String(body.models ?? "").split(/[\n,]/);
    await host.setCustomProvider({ baseUrl: String(body.baseUrl ?? ""), models, name: typeof body.name === "string" ? body.name : undefined });
    if (typeof body.key === "string" && body.key.trim()) await host.providers.setKey(customProviderID, body.key);
    return json(await settings(host));
  }
  if (parts[0] === "providers" && parts[1] === customProviderID && method === "DELETE") {
    await host.providers.setKey(customProviderID, null).catch(() => {});
    await host.setCustomProvider(undefined);
    return json(await settings(host));
  }
  if (parts[0] === "providers" && parts[1] && parts[2] === "key") {
    if (method === "PUT") {
      const body = await payload<{ key?: unknown }>(request);
      await host.providers.setKey(parts[1], typeof body.key === "string" ? body.key : "");
    } else if (method === "DELETE") await host.providers.setKey(parts[1], null);
    else throw new HTTPError(405, "Method not allowed");
    host.logs.info("settings", `provider key ${method === "PUT" ? "saved" : "removed"} provider=${parts[1]}`);
    host.emit({ type: "settings" });
    return json(await settings(host));
  }
  if (parts[0] === "memory") {
    if (method === "GET") return json({ text: host.profile.memoryText });
    if (method === "PUT") {
      const body = await payload<{ text?: unknown }>(request);
      if (typeof body.text !== "string" || new TextEncoder().encode(body.text).length > 512 * 1024) throw new HTTPError(400, "Memory is limited to 512 KiB of text");
      await host.profile.setMemory(body.text);
      return json({ text: host.profile.memoryText });
    }
  }
  throw new HTTPError(404, "Not found");
}

async function devices(host: Host, request: Request, parts: string[], device: DeviceInfo) {
  if (parts.length === 0 && request.method === "GET") return json({ devices: await host.devices.list(), current: device.id });
  if (parts[0] === "pairing" && request.method === "POST") {
    host.logs.info("devices", `pairing code created by device=${device.id}`);
    return json(await host.devices.createPairingCode(), { status: 201 });
  }
  if (parts[0] && request.method === "DELETE") {
    if (!await host.devices.revoke(parts[0])) throw new HTTPError(404, "Device not found");
    host.logs.info("devices", `device revoked id=${parts[0]} by=${device.id}`);
    host.emit({ type: "devices" });
    return json({ revoked: true }, parts[0] === device.id ? { headers: { "set-cookie": clearedCookie(request) } } : {});
  }
  throw new HTTPError(404, "Not found");
}

export async function handleAPI(host: Host, request: Request, url: URL) {
  const parts = url.pathname.slice(5).split("/").filter(Boolean).map(decodeURIComponent);
  const [group, ...rest] = parts;
  try {
    if (group === "health" && request.method === "GET") return json({ ok: true });
    const device = await host.devices.authenticate(requestToken(request));
    if (group === "session" && request.method === "GET") {
      return json({ paired: !!device, device: device ?? null, host: { id: host.hostID, version: host.version }, profile: device ? host.settings.profile : null });
    }
    if (group === "pair" && request.method === "POST") {
      const body = await payload<{ code?: unknown; name?: unknown }>(request);
      const paired = await host.devices.pair(String(body.code ?? ""), String(body.name ?? ""), "browser");
      host.logs.info("devices", `device paired id=${paired.device.id}`);
      host.emit({ type: "devices" });
      return json({ device: paired.device }, { status: 201, headers: { "set-cookie": deviceCookie(request, paired.token) } });
    }
    if (!device) return problem(401, "Pair this device first");
    if (group === "logout" && request.method === "POST") {
      await host.devices.revoke(device.id);
      host.emit({ type: "devices" });
      return json({ revoked: true }, { headers: { "set-cookie": clearedCookie(request) } });
    }
    if (group === "events" && request.method === "GET") return events(host, request, device);
    if (group === "conversations") return await conversations(host, request, url, rest);
    if (group === "files") return await files(host, request, url, rest);
    if (group === "settings") return await settingsRoute(host, request, rest);
    if (group === "devices") return await devices(host, request, rest, device);
    return problem(404, "Not found");
  } catch (error) {
    if (error instanceof HTTPError) return problem(error.status, error.message);
    if (error instanceof AuthError) return problem(403, error.message);
    const message = error instanceof Error ? error.message : String(error);
    const status = /not found|unavailable/i.test(message) ? 404 : 400;
    host.logs.warning("api", `${request.method} ${url.pathname} failed: ${message}`);
    return problem(status, message);
  }
}

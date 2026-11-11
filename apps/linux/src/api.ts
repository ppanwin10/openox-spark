import { isUtf8 } from "node:buffer";
import { basename, extname, join } from "node:path";
import type { Host } from "./host";
import { AuthError, clearedCookie, deviceCookie, requestToken, type DeviceInfo } from "./auth";
import { customProviderID, localMachines } from "./providers";
import { machineURL } from "./host";
import { HTTPError, json, payload, bodyBytes } from "./http";
import { pagesRoute } from "./pages";
import { connectionOrigin, invitation, outsideConnection } from "./connections";
import { framePolicy, pagePolicy, preparePage, unavailablePage, type Unavailable } from "./file-page";
import { pageContracts, pageFunctions, type PageFlow, type PageReply } from "./page-calls";
import { conversationPackageLimits, conversationPackageType, discardConversationPackage, exportConversation, packageMessages, packageTitle, readConversationPackage,
  stageConversationPackage, takeConversationPackage } from "./conversation-package";

export { HTTPError, json } from "./http";

const fileLimit = 32 * 1024 * 1024;
const textLimit = 200 * 1024;
const types: Record<string, string> = {
  ".txt": "text/plain; charset=utf-8", ".md": "text/plain; charset=utf-8", ".csv": "text/csv; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".pdf": "application/pdf", ".mp4": "video/mp4", ".mp3": "audio/mpeg",
  ".wav": "audio/wav", ".m4a": "audio/mp4", ".aac": "audio/aac", ".ogg": "audio/ogg", ".opus": "audio/ogg", ".flac": "audio/flac", ".webm": "video/webm", ".mov": "video/quicktime",
  ".js": "text/plain; charset=utf-8", ".ts": "text/plain; charset=utf-8", ".py": "text/plain; charset=utf-8", ".xml": "text/plain; charset=utf-8",
  ".yaml": "text/plain; charset=utf-8", ".yml": "text/plain; charset=utf-8", ".log": "text/plain; charset=utf-8",
};
const media = new Set([".mp4", ".mp3", ".wav", ".m4a", ".aac", ".ogg", ".opus", ".flac", ".webm", ".mov"]);
const mediaLimit = 200 * 1024 * 1024;
const inline = new Set([...media, ".txt", ".md", ".csv", ".json", ".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".pdf", ".html", ".htm",
  ".js", ".ts", ".py", ".xml", ".yaml", ".yml", ".log"]);

const problem = (status: number, message: string) => json({ error: message }, { status });
function bytes(request: Request, limit = fileLimit) {
  return bodyBytes(request, limit, limit === mediaLimit ? "Audio and video files are limited to 200 MB" : "Files are limited to 32 MiB");
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

function fileResponse(path: string, data: Blob, size: number, download: boolean, range: string | null = null) {
  const extension = extname(path).toLowerCase();
  const name = basename(path);
  const disposition = download || !inline.has(extension) ? "attachment" : "inline";
  const headers = {
    "content-type": types[extension] ?? "application/octet-stream", "content-length": String(size), "accept-ranges": "bytes",
    "content-disposition": `${disposition}; filename*=UTF-8''${encodeURIComponent(name)}`,
    "content-security-policy": "sandbox allow-scripts allow-popups allow-downloads; default-src 'unsafe-inline' data: blob:; img-src data: blob: 'self'",
    "cache-control": "no-store", "x-content-type-options": "nosniff",
  };
  const match = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;
  if (!match || (!match[1] && !match[2])) return new Response(data, { headers });
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  if (start >= size || start > end) return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
  return new Response(data.slice(start, end + 1), { status: 206, headers: { ...headers, "content-length": String(end - start + 1), "content-range": `bytes ${start}-${end}/${size}` } });
}

const tabID = (value: unknown) => typeof value === "string" && /^[A-Za-z0-9-]{8,64}$/.test(value) ? value : undefined;
const pageHeaders = (policy: string) => ({ "content-type": "text/html; charset=utf-8", "content-security-policy": policy, "cache-control": "no-store",
  "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" });

function pushWorker() {
  return new Response(Bun.file(join(import.meta.dir, "../web/push-worker.js")), { headers: { "content-type": "text/javascript; charset=utf-8",
    "service-worker-allowed": "/", "cache-control": "no-cache" } });
}

async function push(host: Host, request: Request, device: DeviceInfo) {
  const notifications = host.notifications;
  if (request.method === "GET") return json({ publicKey: notifications.publicKey, subscribed: notifications.subscribed(device.id) });
  if (request.method === "PUT") {
    await notifications.subscribe(device.id, await payload(request), request.headers.get("origin"));
    host.logs.info("notifications", `subscribed device=${device.id}`);
    return json({ publicKey: notifications.publicKey, subscribed: true });
  }
  if (request.method === "DELETE") {
    await notifications.unsubscribe(device.id);
    host.logs.info("notifications", `unsubscribed device=${device.id}`);
    return json({ publicKey: notifications.publicKey, subscribed: false });
  }
  return problem(404, "Not found");
}

function events(host: Host, request: Request, device: DeviceInfo, url: URL) {
  const encoder = new TextEncoder();
  const token = requestToken(request);
  const tab = tabID(url.searchParams.get("tab"));
  const leave = tab ? host.notifications.connect(device.id, tab, url.searchParams.get("visible") === "1") : () => {};
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
        leave();
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
    customKey: host.providers.hasKey(customProviderID),
    machines: localMachines(host.settings).map(machine => ({ id: machine.id, name: machine.name ?? null, baseUrl: machine.baseUrl, models: machine.models, images: !!machine.images,
      hasKey: host.providers.hasKey(machine.id) })) };
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
      const body = await payload<{ model?: unknown; temporary?: unknown }>(request);
      const choice = body.model ? host.providers.validChoice(body.model) : host.defaultModel();
      if (!choice) throw new HTTPError(409, "Add a model provider in Settings before starting a conversation");
      return json({ id: await host.profile.create(choice, { temporary: body.temporary === true }) }, { status: 201 });
    }
  }
  if (parts[0] === "import") {
    const token = parts[1];
    if (parts.length === 1 && method === "POST") {
      const data = await bodyBytes(request, conversationPackageLimits.archive, "Conversation packages are limited to 128 MiB");
      return json(stageConversationPackage(readConversationPackage(data)));
    }
    if (token && parts.length === 2 && method === "POST") {
      const choice = host.defaultModel();
      if (!choice) throw new HTTPError(409, "Add a model provider in Settings before starting a conversation");
      const value = takeConversationPackage(token);
      const id = await host.profile.adopt({ choice, title: packageTitle(value.header.title), files: [...value.artifacts].map(([name, data]) => ({ name, data })),
        messages: folder => packageMessages(value.turns, folder) });
      host.logs.info("conversation", `import conversation=${id} turns=${value.turns.length} files=${value.artifacts.size}`);
      return json({ id }, { status: 201 });
    }
    if (token && parts.length === 2 && method === "DELETE") { discardConversationPackage(token); return json({ discarded: true }); }
    throw new HTTPError(404, "Not found");
  }
  const id = conversationID(parts[0]!);
  const action = parts[1];
  if (method === "GET" && action === "export" && parts.length === 2) {
    if (host.profile.busy(id)) throw new HTTPError(409, "This conversation is still working");
    const { title, archive } = await exportConversation(host, id);
    const name = `${Array.from(title.toWellFormed().replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-")).slice(0, 100).join("").trim() || "Conversation"}.conversation`;
    host.logs.info("conversation", `export conversation=${id} bytes=${archive.length}`);
    return new Response(archive, { headers: { "content-type": conversationPackageType, "cache-control": "no-store",
      "content-disposition": `attachment; filename="${name.replace(/[^\x20-\x7e]|"/g, "_")}"; filename*=UTF-8''${encodeURIComponent(name)}` } });
  }
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
    const body = await payload<{ text?: unknown; attachments?: unknown; skill?: unknown }>(request);
    const text = typeof body.text === "string" ? body.text.trim() : "";
    const attachments = Array.isArray(body.attachments) ? body.attachments.filter((path): path is string => typeof path === "string").slice(0, 10) : [];
    if (body.skill !== undefined && typeof body.skill !== "string") throw new HTTPError(400, "Choose a skill");
    if (!text && !attachments.length && body.skill === undefined) throw new HTTPError(400, "Write a message or attach a file");
    if (text.length > 100_000) throw new HTTPError(413, "Messages are limited to 100,000 characters");
    if (host.profile.busy(id)) throw new HTTPError(409, "This conversation is still working");
    await host.profile.ready(id);
    let content = text || "Please review the attached files.", origin: { skill: string; argument: string } | undefined;
    if (typeof body.skill === "string") {
      const skill = await host.invokeSkill(body.skill, id);
      if (!skill) throw new HTTPError(404, "Skill not found");
      content = text ? `${skill.instructions}\n\n${text}` : skill.instructions;
      origin = { skill: skill.name, argument: text };
    }
    host.logs.info("conversation", `send conversation=${id} characters=${text.length} attachments=${attachments.length}${origin ? ` skill=${origin.skill}` : ""}`);
    host.profile.send(id, content, attachments, origin).then(result => {
      if (result.outcome === "failed") host.logs.warning("conversation", `run failed conversation=${id}: ${result.error}`);
    }, error => host.logs.error("conversation", `run error conversation=${id}: ${error instanceof Error ? error.message : String(error)}`));
    return json({ accepted: true }, { status: 202 });
  }
  if (method === "POST" && (action === "branch" || action === "rerun")) {
    const body = await payload<{ entry?: unknown; text?: unknown }>(request);
    if (typeof body.entry !== "number" || !Number.isSafeInteger(body.entry) || body.entry < 0) throw new HTTPError(400, "Choose a message");
    if (body.text !== undefined && (typeof body.text !== "string" || body.text.length > 100_000)) throw new HTTPError(400, "Messages are limited to 100,000 characters");
    if (host.profile.busy(id)) throw new HTTPError(409, "This conversation is still working");
    if (action === "branch") {
      const created = await host.profile.branch(id, body.entry);
      host.logs.info("conversation", `branch conversation=${id} entry=${body.entry} into=${created}`);
      return json({ id: created }, { status: 201 });
    }
    const rerun = await host.profile.rerun(id, body.entry, body.text as string | undefined);
    host.logs.info("conversation", `rerun conversation=${id} entry=${body.entry} into=${rerun.id} edited=${body.text !== undefined}`);
    host.profile.send(rerun.id, rerun.text, rerun.files, rerun.origin).then(result => {
      if (result.outcome === "failed") host.logs.warning("conversation", `run failed conversation=${rerun.id}: ${result.error}`);
    }, error => host.logs.error("conversation", `run error conversation=${rerun.id}: ${error instanceof Error ? error.message : String(error)}`));
    return json({ id: rerun.id }, { status: 202 });
  }
  if (method === "POST" && action === "stop") return json({ wasRunning: await host.profile.stop(id) });
  if (method === "POST" && action === "respond") {
    const body = await payload<{ promptId?: unknown; answer?: unknown; values?: unknown; cancel?: unknown }>(request);
    const values = body.values && typeof body.values === "object" && !Array.isArray(body.values)
      ? Object.fromEntries(Object.entries(body.values as Record<string, unknown>).map(([key, value]) => [key, String(value ?? "")])) : undefined;
    host.profile.respond(id, String(body.promptId ?? ""), body.cancel === true ? { cancel: true } : values ? { values } : String(body.answer ?? ""));
    return json({ answered: true });
  }
  if (method === "POST" && action === "read") { await host.profile.markRead(id); return json({ read: true }); }
  if (method === "POST" && action === "attachments") {
    const path = await availablePath(host, `conversations/${id}`, safeName(parameter(url, "name")));
    return json(await host.profile.writeFile(path, content(await bytes(request, media.has(extname(path).toLowerCase()) ? mediaLimit : fileLimit))), { status: 201 });
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
  if (parts[0] === "page" && method === "GET") {
    const path = parameter(url, "path");
    const page = await preparePage(host.profile, path, request.signal);
    if (page === undefined) {
      const { entry, file } = await host.profile.openFile(path);
      return fileResponse(entry.path, file, entry.size, false, request.headers.get("range"));
    }
    return new Response(page, { headers: pageHeaders(pagePolicy) });
  }
  if (parts[0] === "frame" && method === "GET") {
    const path = parameter(url, "path");
    if (![".html", ".htm"].includes(extname(path).toLowerCase())) throw new HTTPError(415, "Only HTML pages open this way");
    let page: string | undefined, status = 200, reason: Unavailable = "unsupported";
    try {
      page = await preparePage(host.profile, path, request.signal, pageContracts);
      if (page === undefined) status = 415;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const missing = /not found|unavailable/i.test(message);
      if (!missing) host.logs.warning("api", `GET ${url.pathname} failed: ${message}`);
      [status, reason] = missing ? [404, "missing"] : [error instanceof HTTPError ? error.status : 400, "failed"];
    }
    return new Response(page ?? unavailablePage(reason), { status, headers: pageHeaders(framePolicy) });
  }
  if (parts[0] === "text" && method === "PUT") {
    const body = await payload<{ path?: unknown; text?: unknown; previous?: unknown }>(request);
    const path = String(body.path ?? "");
    if (![".md", ".markdown"].includes(extname(path).toLowerCase())) throw new HTTPError(415, "Only Markdown files can be edited here");
    if (typeof body.text !== "string" || typeof body.previous !== "string") throw new HTTPError(400, "Send the text and the text it replaces");
    if (Buffer.byteLength(body.text) > textLimit) throw new HTTPError(413, "Markdown files are limited to 200 KB");
    try { return json(await host.profile.writeFile(path, body.text, body.previous)); }
    catch (error) {
      if (error instanceof Error && /changed after reading|not valid/i.test(error.message)) throw new HTTPError(409, "This file changed after you opened it. Open it again to see the latest version.");
      throw error;
    }
  }
  if (parts[0] === "content") {
    const path = parameter(url, "path");
    if (method === "GET") {
      const { entry, file } = await host.profile.openFile(path);
      return fileResponse(entry.path, file, entry.size, url.searchParams.get("download") === "1", request.headers.get("range"));
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
  if (parts[0] === "connections" && parts.length === 1) {
    if (method === "PUT") {
      const body = await payload<{ outside?: unknown }>(request);
      let outside;
      try { outside = outsideConnection(body.outside); } catch (error) { throw new HTTPError(400, (error as Error).message); }
      await host.updateSettings({ connections: { outside } });
    } else if (method !== "GET") throw new HTTPError(404, "Not found");
    return json({ host: { id: host.settings.profile.id, name: host.hostID }, current: connectionOrigin(request),
      profile: host.settings.profile, local: host.localConnection, outside: host.settings.connections?.outside ?? null });
  }
  if (parts[0] === "models" && parts.length === 1 && method === "GET") return json(await host.servedModels());
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
  if (parts[0] === "machines" && parts.length === 1 && method === "POST") {
    const body = await payload<{ address?: unknown; name?: unknown; key?: unknown; images?: unknown }>(request);
    const paired = await host.pairMachine({ address: String(body.address ?? ""), name: typeof body.name === "string" ? body.name : undefined,
      key: typeof body.key === "string" && body.key.trim() ? body.key.trim() : undefined, images: body.images === true });
    return json({ ...(await settings(host)), paired }, { status: 201 });
  }
  if (parts[0] === "machines" && parts.length === 2 && (method === "PUT" || method === "DELETE")) {
    const machine = localMachines(host.settings).find(entry => entry.id === parts[1]);
    if (!machine) throw new HTTPError(404, "Machine not found");
    if (method === "DELETE") { await host.removeMachine(machine.id); return json(await settings(host)); }
    const body = await payload<{ address?: unknown; name?: unknown; key?: unknown; images?: unknown; models?: unknown }>(request);
    const key = typeof body.key === "string" && body.key.trim() ? body.key.trim() : undefined;
    const address = typeof body.address === "string" ? body.address.trim() : "";
    await host.saveMachine(machine.id, { baseUrl: address && address !== machine.baseUrl ? machineURL(address) : machine.baseUrl,
      models: Array.isArray(body.models) ? body.models.map(String) : machine.models, name: typeof body.name === "string" ? body.name : machine.name,
      images: typeof body.images === "boolean" ? body.images : machine.images }, key);
    if (key) await host.providers.setKey(machine.id, key);
    return json(await settings(host));
  }
  if (parts[0] === "providers" && parts[1] === customProviderID && method === "PUT") {
    const body = await payload<{ baseUrl?: unknown; models?: unknown; name?: unknown; key?: unknown; images?: unknown }>(request);
    const models = Array.isArray(body.models) ? body.models.map(String) : String(body.models ?? "").split(/[\n,]/);
    await host.setCustomProvider({ baseUrl: String(body.baseUrl ?? ""), models, name: typeof body.name === "string" ? body.name : undefined, images: body.images === true },
      typeof body.key === "string" ? body.key.trim() : undefined);
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
    const body = request.body ? await payload<{ route?: unknown }>(request) : {};
    if (body.route !== undefined && body.route !== "outside") throw new HTTPError(400, "Choose a configured connection");
    const outside = host.settings.connections?.outside;
    if (body.route === "outside" && !outside) throw new HTTPError(409, "Outside access is not configured");
    host.logs.info("devices", `pairing code created by device=${device.id}`);
    const pairing = await host.devices.createPairingCode();
    const local = host.localConnection;
    const current = connectionOrigin(request);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(new URL(current).hostname);
    const origin = body.route === "outside" ? outside!.url : loopback && local ? local.url : current;
    return json({ ...pairing, url: invitation(origin, pairing.code, local), appScan: local?.url === origin }, { status: 201 });
  }
  if (parts[0] && request.method === "DELETE") {
    if (!await host.devices.revoke(parts[0])) throw new HTTPError(404, "Device not found");
    host.logs.info("devices", `device revoked id=${parts[0]} by=${device.id}`);
    host.emit({ type: "devices" });
    return json({ revoked: true }, parts[0] === device.id ? { headers: { "set-cookie": clearedCookie(request) } } : {});
  }
  throw new HTTPError(404, "Not found");
}

function outcomes(host: Host, flow: PageFlow) {
  const label = (pageFunctions as readonly string[]).includes(flow.name) ? flow.name : "unsupported";
  const encoder = new TextEncoder();
  let keepalive: ReturnType<typeof setInterval> | undefined, delivered = false;
  return new Response(new ReadableStream({
    async start(controller) {
      const send = (text: string) => { try { controller.enqueue(encoder.encode(text)); return true; } catch { clearInterval(keepalive); return false; } };
      send("\n");
      keepalive = setInterval(() => send("\n"), 20_000);
      const outcome = await flow.next().finally(() => clearInterval(keepalive));
      delivered = true;
      if ("interaction" in outcome) host.logs.info("pages", `ask function=${label} kind=${outcome.interaction.kind}`);
      else host.logs.info("pages", `call function=${label} ok=${outcome.ok}${outcome.ok ? "" : ` code=${outcome.error.code}`}`);
      if (send(`${JSON.stringify(outcome)}\n`)) try { controller.close(); } catch { return; }
    },
    cancel() { clearInterval(keepalive); if (!delivered) flow.abandon(); },
  }), { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" } });
}

async function canvas(host: Host, request: Request, parts: string[], device: DeviceInfo) {
  if (request.method !== "POST" || parts.length !== 1 || !["call", "answer", "close"].includes(parts[0]!)) throw new HTTPError(404, "Not found");
  const text = new TextDecoder().decode(await bodyBytes(request, 2 * 1024 * 1024, "HTML requests are limited to 1 MiB"));
  let body: { session?: unknown; path?: unknown; function?: unknown; arguments?: unknown; interaction?: unknown; answer?: unknown; values?: unknown; cancel?: unknown };
  try { body = JSON.parse(text || "{}"); } catch { throw new HTTPError(400, "Expected JSON"); }
  const id = String(body.session ?? "");
  if (parts[0] === "close") return json({ closed: host.pageCalls.close(device.id, id) });
  if (parts[0] === "answer") {
    const values = body.values && typeof body.values === "object" && !Array.isArray(body.values) ? body.values as Record<string, string> : undefined;
    const reply: PageReply | undefined = body.cancel === true ? null : typeof body.answer === "string" ? body.answer : values ? { values } : undefined;
    if (reply === undefined) throw new HTTPError(400, "Send an answer or cancel");
    return outcomes(host, host.pageCalls.answer(device.id, id, String(body.interaction ?? ""), reply));
  }
  const session = host.pageCalls.open(device.id, id, String(body.path ?? ""));
  return outcomes(host, host.pageCalls.call(session, String(body.function ?? ""), body.arguments ?? {}));
}

export async function handleAPI(host: Host, request: Request, url: URL) {
  const parts = url.pathname.slice(5).split("/").filter(Boolean).map(decodeURIComponent);
  const [group, ...rest] = parts;
  try {
    if (group === "health" && request.method === "GET") return json({ ok: true });
    if (group === "push" && rest.join("/") === "worker.js" && request.method === "GET") return pushWorker();
    const device = await host.devices.authenticate(requestToken(request));
    if (group === "session" && request.method === "GET") {
      return json({ paired: !!device, device: device ?? null, host: { id: host.hostID, version: host.version, connectionId: host.settings.profile.id }, profile: device ? host.settings.profile : null });
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
    if (group === "events" && request.method === "GET") return events(host, request, device, url);
    if (group === "push" && !rest.length) return await push(host, request, device);
    if (group === "presence" && request.method === "PUT") {
      const body = await payload<{ tab?: unknown; visible?: unknown }>(request);
      const tab = tabID(body.tab);
      if (!tab || typeof body.visible !== "boolean") throw new HTTPError(400, "Send the tab and whether it is visible");
      host.notifications.present(device.id, tab, body.visible);
      return json({ ok: true });
    }
    if (group === "conversations") return await conversations(host, request, url, rest);
    if (group === "files") return await files(host, request, url, rest);
    if (group === "canvas") return await canvas(host, request, rest, device);
    if (group === "settings") return await settingsRoute(host, request, rest);
    if (group === "devices") return await devices(host, request, rest, device);
    if (group === "pages") return await pagesRoute(host, request, url, rest);
    const route = group ? host.route(group) : undefined;
    if (route) return await route(request, url, rest);
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

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT } from "../../../../lib.ts";

type Message = { role: string; content: unknown };
type View = { summary: { id: number; title: string }; busy: boolean; pendingPrompt?: { id: string; prompt: string } };
type Push = { path: string; headers: Record<string, string>; body: Uint8Array };

const encoder = new TextEncoder();
const b64url = (data: Uint8Array) => Buffer.from(data).toString("base64url");
const bytes = (text: string): Uint8Array<ArrayBuffer> => new Uint8Array(Buffer.from(text, "base64url"));
const textOf = (content: unknown): string => typeof content === "string" ? content
  : Array.isArray(content) ? content.map(part => typeof part === "string" ? part : (part as { text?: string }).text ?? "").join("\n") : "";
const chunk = (delta: unknown, finish: string | null = null) => `data: ${JSON.stringify({ id: "chatcmpl-push", object: "chat.completion.chunk", created: 0, model: "fixture",
  choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const call = (source: string) => [chunk({ role: "assistant", tool_calls: [{ index: 0, id: `call_${crypto.randomUUID()}`, type: "function",
  function: { name: "execute", arguments: JSON.stringify({ purpose: "Push step", source }) } }] }), chunk({}, "tool_calls")];
const script = (source: string) => `run:${Buffer.from(source).toString("base64")}`;

const model = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  if (request.method === "GET") return new Response("Not found", { status: 404 });
  const body = await request.json() as { messages: Message[]; tools?: unknown[] };
  const last = body.messages.at(-1)!;
  const latest = textOf([...body.messages].reverse().find(message => message.role === "user")?.content);
  if (latest.includes("fail-run")) return Response.json({ error: { message: "The fixture refused this request. ".repeat(200) } }, { status: 400 });
  const encoded = /run:([A-Za-z0-9+/=]+)/.exec(latest)?.[1];
  const events = last.role === "tool" ? [chunk({ role: "assistant", content: `OUTPUT ${textOf(last.content)}` }), chunk({}, "stop")]
    : encoded && body.tools?.length ? call(Buffer.from(encoded, "base64").toString("utf8"))
    : [chunk({ role: "assistant", content: "## Plan\nYour **week** is ready: [three meetings](https://example.com/x)." }), chunk({}, "stop")];
  return new Response(events.join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
} });

const pushes: Push[] = [];
let gone = false;
const service = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  pushes.push({ path: new URL(request.url).pathname, headers: Object.fromEntries(request.headers), body: new Uint8Array(await request.arrayBuffer()) });
  return new Response(null, { status: gone ? 410 : 201 });
} });

let data = "";
let host: ReturnType<typeof Bun.spawn> | undefined;
let base = "";
let token = "";
let browser: CryptoKeyPair;
let p256dh = "";
let auth = "";

const command = async (...args: string[]) => new Response(Bun.spawn([process.execPath, `${ROOT}/apps/linux/src/main.ts`, ...args, "--data", data], { stdout: "pipe" }).stdout).text();
function api(path: string, init: RequestInit & { json?: unknown; as?: string } = {}) {
  const { json, as, ...rest } = init;
  return fetch(`${base}${path}`, { ...rest, ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
    headers: { authorization: `Bearer ${as ?? token}`, ...(json !== undefined ? { "content-type": "application/json" } : {}), ...rest.headers } });
}
const read = async <T>(path: string) => await (await api(path)).json() as T;
async function until<T>(load: () => Promise<T> | T, done: (value: T) => boolean, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await load();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting: ${JSON.stringify(value).slice(0, 400)}`);
    await Bun.sleep(50);
  }
}

async function hkdf(salt: Uint8Array<ArrayBuffer>, secret: Uint8Array<ArrayBuffer>, info: Uint8Array<ArrayBuffer>, length: number) {
  const key = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8));
}
async function decrypt(push: Push) {
  const body = push.body, salt = body.slice(0, 16), length = body[20]!, sender = body.slice(21, 21 + length);
  expect(new DataView(body.buffer, body.byteOffset).getUint32(16)).toBe(4096);
  const senderKey = await crypto.subtle.importKey("raw", sender, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: senderKey }, browser.privateKey, 256));
  const info = new Uint8Array([...encoder.encode("WebPush: info\0"), ...bytes(p256dh), ...sender]);
  const ikm = await hkdf(bytes(auth), shared, info, 32);
  const key = await crypto.subtle.importKey("raw", await hkdf(salt, ikm, encoder.encode("Content-Encoding: aes128gcm\0"), 16), "AES-GCM", false, ["decrypt"]);
  const nonce = await hkdf(salt, ikm, encoder.encode("Content-Encoding: nonce\0"), 12);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, body.slice(21 + length)));
  expect(plain.at(-1)).toBe(2);
  return JSON.parse(new TextDecoder().decode(plain.slice(0, -1))) as { title: string; body: string; tag: string; url: string };
}
async function verifiedClaims(push: Push, publicKey: string) {
  const match = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(push.headers.authorization ?? "");
  expect(match?.[4]).toBe(publicKey);
  const key = await crypto.subtle.importKey("raw", bytes(publicKey), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, bytes(match![3]!), encoder.encode(`${match![1]}.${match![2]}`))).toBe(true);
  expect(JSON.parse(Buffer.from(match![1]!, "base64url").toString())).toEqual({ typ: "JWT", alg: "ES256" });
  return JSON.parse(Buffer.from(match![2]!, "base64url").toString()) as { aud: string; exp: number; sub: string };
}
async function conversation() {
  const response = await api("/api/conversations", { method: "POST", json: {} });
  return (await response.json() as { id: number }).id;
}
async function send(id: number, text: string) {
  expect((await api(`/api/conversations/${id}/messages`, { method: "POST", json: { text } })).status).toBe(202);
  return until(() => read<View>(`/api/conversations/${id}`), view => !view.busy || !!view.pendingPrompt);
}
const settled = async (count: number) => { await Bun.sleep(600); expect(pushes).toHaveLength(count); };
async function subscribe(language: string, as?: string) {
  return api("/api/push", { method: "PUT", as, json: { endpoint: `http://127.0.0.1:${service.port}/push/${crypto.randomUUID()}`, keys: { p256dh, auth }, language } });
}

async function startHost() {
  base = "";
  const child = Bun.spawn([process.execPath, `${ROOT}/apps/linux/src/main.ts`, "serve", "--data", data, "--port", "0", "--name", "push"],
    { stdout: "pipe", stderr: "ignore", env: { ...Bun.env, OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "", OX_HOST_TEST_PUSH: `http://127.0.0.1:${service.port}` } });
  host = child;
  const reader = child.stdout.getReader();
  let output = "";
  while (!base) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`Host did not start: ${output}`);
    output += new TextDecoder().decode(value);
    const port = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(output)?.[1];
    if (port) base = `http://127.0.0.1:${port}`;
  }
  void (async () => { while (!(await reader.read()).done); })();
}

beforeAll(async () => {
  data = await mkdtemp(join(tmpdir(), "openox-linux-push-"));
  await startHost();
  token = /OX_HOST_TOKEN=(\S+)/.exec(await command("token", "--name", "push-test"))![1]!;
  expect((await api("/api/settings/providers/custom", { method: "PUT", json: { name: "Scripted", baseUrl: `http://127.0.0.1:${model.port}/v1`, models: ["fixture"] } })).status).toBe(200);
  browser = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) as CryptoKeyPair;
  p256dh = b64url(new Uint8Array(await crypto.subtle.exportKey("raw", browser.publicKey)));
  auth = b64url(crypto.getRandomValues(new Uint8Array(16)));
}, 30_000);

afterAll(async () => {
  host?.kill("SIGTERM");
  await host?.exited;
  model.stop(true);
  service.stop(true);
  if (data) await rm(data, { recursive: true, force: true });
});

test("Devices subscribe to Web Push, and a reply that finishes while no tab is visible arrives encrypted and signed for the push service", async () => {
  const worker = await fetch(`${base}/api/push/worker.js`);
  expect(worker.status).toBe(200);
  expect(worker.headers.get("content-type")).toStartWith("text/javascript");
  expect(worker.headers.get("service-worker-allowed")).toBe("/");
  expect(await worker.text()).toContain("showNotification");

  const initial = await read<{ publicKey: string; subscribed: boolean }>("/api/push");
  expect(initial.subscribed).toBe(false);
  expect(bytes(initial.publicKey)).toHaveLength(65);
  expect((await api("/api/push", { method: "PUT", json: { endpoint: "https://push.example.com/x", keys: { p256dh, auth } } })).status).toBe(400);
  expect((await api("/api/push", { method: "PUT", json: { endpoint: `http://127.0.0.1:${service.port}/push/a`, keys: { p256dh, auth: "short" } } })).status).toBe(400);
  expect((await subscribe("en")).status).toBe(200);
  const state = await read<Record<string, unknown>>("/api/push");
  expect(state).toEqual({ publicKey: initial.publicKey, subscribed: true });

  const id = await conversation();
  await send(id, "Plan my week");
  const push = await until(() => pushes, list => list.length === 1);
  expect(push[0]!.headers).toMatchObject({ "content-encoding": "aes128gcm", ttl: "86400", urgency: "normal" });
  expect(push[0]!.headers.topic).toMatch(/^[\w-]{32}$/);
  expect(await decrypt(push[0]!)).toEqual({ title: "Plan my week", body: "Plan Your week is ready: three meetings.", tag: `conversation-${id}`, url: `/#/c/${id}` });
  const claims = await verifiedClaims(push[0]!, initial.publicKey);
  expect(claims.aud).toBe(`http://127.0.0.1:${service.port}`);
  expect(claims.sub).toStartWith("mailto:");
  expect(claims.exp * 1000).toBeGreaterThan(Date.now());
  expect(claims.exp * 1000).toBeLessThanOrEqual(Date.now() + 24 * 3600 * 1000);

  const temporary = (await (await api("/api/conversations", { method: "POST", json: { temporary: true } })).json() as { id: number }).id;
  await send(temporary, "Plan my week");
  await settled(1);
}, 30_000);

test("A visible tab holds pushes back until it reports hidden or its stream closes, and approvals and failed schedules notify in the device's language", async () => {
  const id = await conversation();
  const stream = new AbortController();
  const events = await api("/api/events?tab=tab-visible-1&visible=1", { signal: stream.signal });
  const reader = events.body!.getReader();
  await reader.read();
  const before = pushes.length;
  await send(id, "Plan my week");
  await settled(before);
  expect((await api("/api/presence", { method: "PUT", json: { tab: "tab-visible-1", visible: false } })).status).toBe(200);
  await send(id, "Plan my week");
  await until(() => pushes, list => list.length === before + 1);
  expect((await api("/api/presence", { method: "PUT", json: { tab: "tab-visible-1", visible: true } })).status).toBe(200);
  await send(id, "Plan my week");
  await settled(before + 1);
  stream.abort();
  await reader.cancel().catch(() => {});
  await Bun.sleep(300);
  expect((await api("/api/presence", { method: "PUT", json: { tab: "tab-visible-1", visible: true } })).status).toBe(200);
  expect((await api("/api/presence", { method: "PUT", json: { tab: "unknown-tab-1", visible: true } })).status).toBe(200);
  await send(id, "Plan my week");
  await until(() => pushes, list => list.length === before + 2);

  expect((await subscribe("zh-Hans")).status).toBe(200);
  const waiting = await send(id, script(`return await ox.provider.generate({ purpose: "Generate", id: "custom", model: "fixture", messages: [{ role: "user", content: "Hi" }], maxOutputTokens: 16 });`));
  expect(waiting.pendingPrompt).toBeDefined();
  const attention = (await until(() => pushes, list => list.length === before + 3)).at(-1)!;
  expect(attention.headers.urgency).toBe("high");
  expect(await decrypt(attention)).toMatchObject({ body: "Ox 需要你的批准", tag: `conversation-${id}`, url: `/#/c/${id}` });
  expect((await api(`/api/conversations/${id}/respond`, { method: "POST", json: { promptId: waiting.pendingPrompt!.id, answer: "Deny" } })).status).toBe(200);
  await until(() => read<View>(`/api/conversations/${id}`), view => !view.busy);
  await until(() => pushes, list => list.length === before + 4);

  const fireAt = new Date(Date.now() + 1_500).toISOString();
  const created = await send(id, script(`return await ox.schedule.create({ purpose: "Schedule", name: "Water plants", frequency: "once", fireAt: ${JSON.stringify(fireAt)}, prompt: "fail-run now" });`));
  expect((await api(`/api/conversations/${id}/respond`, { method: "POST", json: { promptId: created.pendingPrompt!.id, answer: "Approve" } })).status).toBe(200);
  const failure = await until(async () => await Promise.all(pushes.slice(before + 4).map(decrypt)), list => list.some(entry => entry.tag.startsWith("schedule-")), 20_000);
  expect(failure.filter(entry => entry.tag.startsWith("conversation-") && entry.tag !== `conversation-${id}`)).toEqual([]);
  const { title, body } = failure.find(entry => entry.tag.startsWith("schedule-"))!;
  expect(title).toBe("“Water plants”需要你处理");
  expect(body).toContain("The fixture refused this request.");
  expect(Array.from(body).length).toBeWithin(590, 601);
  expect(body).toEndWith("…");
  expect(pushes.every(push => push.body.length <= 4096)).toBe(true);
}, 60_000);

test("A push service that reports the subscription gone removes it, and revoking a device removes its subscription", async () => {
  gone = true;
  const id = await conversation();
  await send(id, "Plan my week");
  await until(() => read<{ subscribed: boolean }>("/api/push"), state => !state.subscribed);
  gone = false;

  const second = /OX_HOST_TOKEN=(\S+)/.exec(await command("token", "--name", "push-second"))![1]!;
  expect((await subscribe("en", second)).status).toBe(200);
  const devices = await read<{ devices: { id: string; name: string }[] }>("/api/devices");
  const target = devices.devices.find(device => device.name === "push-second")!;
  const stored = async () => Object.keys((JSON.parse(await readFile(join(data, "push.json"), "utf8")) as { devices: Record<string, unknown> }).devices);
  expect(await stored()).toContain(target.id);
  expect(JSON.stringify(await read("/api/push"))).not.toContain("/push/");
  expect((await api(`/api/devices/${target.id}`, { method: "DELETE" })).status).toBe(200);
  await until(stored, list => !list.includes(target.id));

  const third = /OX_HOST_TOKEN=(\S+)/.exec(await command("token", "--name", "push-third"))![1]!;
  expect((await subscribe("en", third)).status).toBe(200);
  const offline = (await read<{ devices: { id: string; name: string }[] }>("/api/devices")).devices.find(device => device.name === "push-third")!;
  expect(await stored()).toContain(offline.id);
  host!.kill("SIGTERM");
  await host!.exited;
  await command("revoke", offline.id);
  expect(await stored()).toContain(offline.id);
  await startHost();
  expect(await stored()).not.toContain(offline.id);
}, 60_000);

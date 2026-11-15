import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Value } from "typebox/value";
import { ROOT } from "../../../../lib.ts";
import { scriptContracts } from "../../../../../packages/agent/src/adapters/linux/functions";
import { sqliteDatabase } from "../../../../../packages/agent/src/adapters/linux/database";
import type { ApprovalReceipt } from "../../../../../packages/agent/src/adapters/linux/approval-history";
import { Providers } from "../../../../../apps/linux/src/providers";
import { InboxState, type InboxNotice } from "../../../../../packages/agent/src/adapters/linux/inbox";
import { LinuxProfile } from "../../../../../packages/agent/src/adapters/linux/profile";
import { zipDecode, zipEncode } from "../../../../../apps/linux/src/vm/skills-package";
import { ScheduleStore } from "../../../../../apps/linux/src/vm/schedules-store";
import { Database } from "bun:sqlite";

type Message = { role: string; content: unknown };
type Pending = { id: string; prompt: string; options: string[] };
type View = { summary: { id: number; title: string; model: { provider: string; modelId: string } | null }; busy: boolean; pendingPrompt?: Pending; messages: { role: string; content: unknown }[] };
type Row = { id: string; name: string; state: string; nextFireAt: number | null; lastRunAt: number | null; lastOutcome: string | null; lastError: string | null; conversationId: number | null };

const SECRET = "sk-workspace-0123456789-secret";
const contracts = Object.assign({}, ...["skill", "schedule", "conversation", "provider"].map(name =>
  JSON.parse(readFileSync(join(ROOT, "packages/agent/src/functions", name, "contracts.json"), "utf8")))) as Record<string, { inputSchema: object; outputSchema: object }>;
const chunk = (delta: unknown, finish: string | null = null) => `data: ${JSON.stringify({ id: "chatcmpl-workspace", object: "chat.completion.chunk", created: 0, model: "fixture",
  choices: [{ index: 0, delta, finish_reason: finish }], ...(finish ? { usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } } : {}) })}\n\n`;
const reply = (value: string) => [chunk({ role: "assistant", content: value }), chunk({}, "stop")];
const call = (source: string) => [chunk({ role: "assistant", tool_calls: [{ index: 0, id: `call_${crypto.randomUUID()}`, type: "function",
  function: { name: "execute", arguments: JSON.stringify({ purpose: "Workspace step", source }) } }] }), chunk({}, "tool_calls")];
const textOf = (content: unknown): string => typeof content === "string" ? content
  : Array.isArray(content) ? content.map(part => typeof part === "string" ? part : (part as { text?: string }).text ?? "").join("\n") : "";
const script = (source: string) => `run:${Buffer.from(source).toString("base64")}`;

const requests: { model: string; system: string; authorization: string | null; tools: boolean }[] = [];
const mrRequests: { user: unknown; system: string }[] = [];
const watchedPage = { version: 1, status: 200, cookies: [] as (string | null)[], sideEffects: 0, held: false, waiting: new Set<() => void>() };
function scriptedModel() {
  return Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/watch-side-effect") { watchedPage.sideEffects++; return Response.json({ wrote: true }); }
    if (request.method === "GET") {
      if (url.pathname === "/watch-seed") return new Response("<!doctype html><title>Owner browser page</title><p>Keep this resident page.</p>",
        { headers: { "content-type": "text/html", "set-cookie": "watch-owner=1; Path=/; SameSite=Lax" } });
      if (url.pathname === "/watch-redirect") return Response.redirect(`http://127.0.0.2:${url.port}/watch-side-effect`);
      if (url.pathname === "/watch-page") {
        watchedPage.cookies.push(request.headers.get("cookie"));
        if (watchedPage.held) await new Promise<void>(resolve => watchedPage.waiting.add(resolve));
        return new Response(`<!doctype html><title>Public score</title><main id="score">Fixture score ${watchedPage.version}</main>
          <img src="/watch-side-effect"><script>fetch("/watch-side-effect",{method:"POST"})</script>`,
        { status: watchedPage.status, headers: { "content-type": "text/html; charset=utf-8" } });
      }
      return new Response("Not found", { status: 404 });
    }
    const body = await request.json() as { model: string; messages: Message[]; tools?: unknown[] };
    const system = body.messages.filter(message => message.role === "system" || message.role === "developer").map(message => textOf(message.content)).join("\n");
    requests.push({ model: body.model, system, authorization: request.headers.get("authorization"), tools: !!body.tools?.length });
    const last = body.messages.at(-1)!;
    const latest = textOf([...body.messages].reverse().find(message => message.role === "user")?.content);
    if (latest.includes("MR fixture")) mrRequests.push({ user: [...body.messages].reverse().find(message => message.role === "user")?.content, system });
    if (latest.includes("slow-run") && last.role === "user") await Bun.sleep(2_500);
    const encoded = /run:([A-Za-z0-9+/=]+)/.exec(latest)?.[1];
    const generation = /\[OpenOx (feed|ideas) generation ([a-f0-9-]{36})\]/.exec(latest);
    if (generation && last.role === "user" && latest.includes("FI controlled failure")) return Response.json({ error: { message: "Controlled generation failure" } }, { status: 503 });
    if (generation && last.role === "user" && latest.includes("FI held generation")) await Bun.sleep(2_500);
    const publication = generation && !latest.includes("FI no publication") ? latest.includes("FI no updates")
      ? `return await ox.feed.publish({purpose:"Explicitly report no updates",generationId:${JSON.stringify(generation[2])},items:[]});` : generation[1] === "feed"
      ? `return await ox.feed.publish({purpose:"Publish the controlled generated update",generationId:${JSON.stringify(generation[2])},items:[{name:"Generated source update",body:"A controlled source-labelled update.",sources:[{name:"Fixture source",url:"https://example.com/generated"}]}]});`
      : `return await ox.idea.publish({purpose:"Publish the controlled generated proposal",generationId:${JSON.stringify(generation[2])},items:[{name:"Generated actionable proposal",body:"A controlled suggestion.",action:"Help me prepare the proposed plan."}]});` : undefined;
    const events = !body.tools?.length ? reply(`generated: ${textOf(last.content)}`)
      : last.role === "tool" ? reply(`OUTPUT ${textOf(last.content)}`)
      : encoded ? call(Buffer.from(encoded, "base64").toString("utf8"))
      : publication ? call(publication)
      : reply(latest.includes("MR fixture") ? "MR fixture received the original quoted request." : "Hello from the scripted model.");
    return new Response(events.join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  } });
}

let data = "";
let model: ReturnType<typeof scriptedModel>;
let host: { process: ReturnType<typeof Bun.spawn>; port: number } | undefined;
let token = "";
let profileID = "";
let diagnostics = "";

async function drain(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader(), decoder = new TextDecoder();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    diagnostics += decoder.decode(value);
  }
}

async function startHost(personalAgent = true, museParity = false) {
  const child = Bun.spawn([process.execPath, `${ROOT}/apps/linux/src/main.ts`, "serve", "--data", data, "--port", "0", "--name", "workspace"],
    { stdout: "pipe", stderr: "pipe", env: { ...Bun.env, OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "", OPENOX_MEDIA_URL: "http://127.0.0.1:9",
      OPENOX_PERSONAL_AGENT: personalAgent ? "1" : "", OPENOX_MUSE_PARITY: museParity ? "1" : "", OX_HOST_TEST_ORIGINS: `http://127.0.0.1:${model.port}` } });
  void drain(child.stderr);
  const reader = child.stdout.getReader();
  let output = "";
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    output += new TextDecoder().decode(value);
    const match = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(output);
    if (match) {
      void (async () => { for (;;) { const { done } = await reader.read(); if (done) return; } })().catch(() => {});
      return { process: child, port: Number(match[1]) };
    }
  }
  child.kill();
  throw new Error(`Host did not start: ${output}${diagnostics}`);
}

async function stopHost() {
  if (!host) return;
  host.process.kill("SIGTERM");
  await host.process.exited;
  host = undefined;
}

function api(path: string, init: RequestInit & { json?: unknown } = {}) {
  const { json, ...rest } = init;
  return fetch(`http://127.0.0.1:${host!.port}${path}`, { ...rest, ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
    headers: { authorization: `Bearer ${token}`, ...(json !== undefined ? { "content-type": "application/json" } : {}), ...rest.headers } });
}
const read = async <T>(path: string) => await (await api(path)).json() as T;

async function until<T>(load: () => Promise<T>, done: (value: T) => boolean, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await load();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting: ${JSON.stringify(value).slice(0, 800)}`);
    await Bun.sleep(100);
  }
}

async function conversation() {
  const response = await api("/api/conversations", { method: "POST", json: {} });
  expect(response.status).toBe(201);
  return (await response.json() as { id: number }).id;
}

const lastText = (view: View) => textOf([...view.messages].reverse().find(message => message.role === "assistant")?.content);

async function turn(id: number, source: string, answer?: (prompt: Pending) => Record<string, unknown>) {
  const sent = await api(`/api/conversations/${id}/messages`, { method: "POST", json: { text: script(source) } });
  expect(sent.status).toBe(202);
  const answered = new Set<string>();
  const prompts: Pending[] = [];
  for (;;) {
    const view = await until(() => read<View>(`/api/conversations/${id}`), value => !value.busy || (!!value.pendingPrompt && !answered.has(value.pendingPrompt.id)));
    if (!view.busy) {
      const text = lastText(view);
      expect(text.startsWith("OUTPUT ")).toBe(true);
      return { output: text.slice(7), prompts, view };
    }
    const prompt = view.pendingPrompt!;
    if (!answer) throw new Error(`Unexpected prompt: ${prompt.prompt}`);
    answered.add(prompt.id);
    prompts.push(prompt);
    expect((await api(`/api/conversations/${id}/respond`, { method: "POST", json: { promptId: prompt.id, ...answer(prompt) } })).status).toBe(200);
  }
}
async function value<T = Record<string, unknown>>(id: number, source: string, answer?: (prompt: Pending) => Record<string, unknown>) {
  const { output, prompts } = await turn(id, source, answer);
  return { result: JSON.parse(output) as T, prompts };
}

function conforms(name: string, result: unknown) {
  const schema = scriptContracts([name])[name]?.outputSchema;
  if (!schema) throw new Error(`Missing Linux output contract: ${name}`);
  const errors = [...Value.Errors(schema, result)].map(error => `${error.instancePath} ${error.message}`);
  expect(errors).toEqual([]);
}
const numberOf = (uuid: string) => Number.parseInt(uuid.replaceAll("-", "").slice(16), 16);
const profilePath = (...parts: string[]) => join(data, "profiles", profileID, ...parts);
const approve = () => ({ answer: "Approve" });
const always = () => ({ answer: "Always approve" });
type HistoryState = { records: Record<string, ApprovalReceipt>; requests: Record<string, { id: string; fingerprint: string }> };
async function historyFixture(change: (state: HistoryState) => void) {
  expect(host).toBeUndefined();
  const resolve = (name: string) => Bun.resolveSync(name, join(ROOT, "packages/agent"));
  const [{ Harness, defineDoc, createRegistry }, { SqliteStorage }, { BACKGROUND_CONTEXT }] = await Promise.all([
    import(resolve("@earendil-works/pi-durable")), import(resolve("@earendil-works/pi-durable/storage/sqlite")), import(resolve("@earendil-works/chord/context")),
  ]);
  const providers = await Providers.open(join(data, "credentials.json"));
  const harness = await Harness.open(await SqliteStorage.open(sqliteDatabase(profilePath("state", "state.sqlite"))),
    { models: providers.models, registry: createRegistry() }, BACKGROUND_CONTEXT);
  try {
    const document = defineDoc({ kind: "ox.approval-history", version: 1, scope: "session", initial: () => ({ records: {}, requests: {} }), checkpointWhen: () => true });
    return await harness.commit(async (tx: { doc(value: unknown): Promise<HistoryState> }) => {
      const state = await tx.doc(document), saved = Value.Clone(state);
      change(state); return saved;
    }, BACKGROUND_CONTEXT) as HistoryState;
  } finally { await harness.close(BACKGROUND_CONTEXT); }
}

async function noticeFixture(change: (records: Record<string, InboxNotice>) => void) {
  expect(host).toBeUndefined();
  const resolve = (name: string) => Bun.resolveSync(name, join(ROOT, "packages/agent"));
  const [{ Harness, createRegistry }, { SqliteStorage }, { BACKGROUND_CONTEXT }] = await Promise.all([
    import(resolve("@earendil-works/pi-durable")), import(resolve("@earendil-works/pi-durable/storage/sqlite")), import(resolve("@earendil-works/chord/context")),
  ]);
  const providers = await Providers.open(join(data, "credentials.json"));
  const harness = await Harness.open(await SqliteStorage.open(sqliteDatabase(profilePath("state", "state.sqlite"))),
    { models: providers.models, registry: createRegistry() }, BACKGROUND_CONTEXT);
  try {
    await harness.commit(async (tx: { doc(value: typeof InboxState): Promise<{ records: Record<string, InboxNotice> }> }) => {
      change((await tx.doc(InboxState)).records);
    }, BACKGROUND_CONTEXT);
  } finally { await harness.close(BACKGROUND_CONTEXT); }
}
function attentionNotice(targetUrl: string, status: InboxNotice["delivery"]["status"] = "in_app"): InboxNotice {
  const now = new Date().toISOString();
  return { id: crypto.randomUUID(), tag: "conversation-lookalike", targetUrl, urgency: "normal",
    title: { en: "NT private title", "zh-Hans": "NT 私有标题" }, body: { en: "NT private body", "zh-Hans": "NT 私有正文" },
    createdAt: now, occurredAt: now, readAt: null, cancelledAt: null, delivery: { status, attempts: {} } };
}

function zipNames(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = bytes.length - 22;
  expect(view.getUint32(end, true)).toBe(0x06054b50);
  const names: string[] = [];
  let cursor = view.getUint32(end + 16, true);
  for (let index = 0; index < view.getUint16(end + 10, true); index++) {
    const length = view.getUint16(cursor + 28, true);
    names.push(new TextDecoder().decode(bytes.subarray(cursor + 46, cursor + 46 + length)));
    cursor += 46 + length + view.getUint16(cursor + 30, true) + view.getUint16(cursor + 32, true);
  }
  return names.sort();
}

async function filesContaining(directory: string, needle: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await filesContaining(path, needle));
    else if (entry.isFile() && (await readFile(path)).includes(needle)) found.push(path);
  }
  return found;
}

beforeAll(async () => {
  data = await mkdtemp(join(tmpdir(), "openox-linux-workspace-"));
  model = scriptedModel();
  host = await startHost();
  const child = Bun.spawn([process.execPath, `${ROOT}/apps/linux/src/main.ts`, "token", "--name", "workspace-test", "--data", data], { stdout: "pipe" });
  token = /OX_HOST_TOKEN=(\S+)/.exec(await new Response(child.stdout).text())![1]!;
  const configured = await api("/api/settings/providers/custom", { method: "PUT",
    json: { name: "Scripted", baseUrl: `http://127.0.0.1:${model.port}/v1`, models: ["fixture", "fixture-2"] } });
  expect(configured.status).toBe(200);
  profileID = JSON.parse(await readFile(join(data, "host.json"), "utf8")).profile.id;
}, 30_000);

afterAll(async () => {
  for (const release of watchedPage.waiting) release();
  await stopHost();
  model?.stop(true);
  if (data) await rm(data, { recursive: true, force: true });
});

async function dataControlsFixture(work: () => Promise<void>) {
  await stopHost();
  const previous = { data, token, profileID };
  data = await mkdtemp(join(tmpdir(), "openox-data-controls-"));
  try {
    host = await startHost(true, true);
    const child = Bun.spawn([process.execPath, `${ROOT}/apps/linux/src/main.ts`, "token", "--name", "DC isolated owner", "--data", data], { stdout: "pipe" });
    token = /OX_HOST_TOKEN=(\S+)/.exec(await new Response(child.stdout).text())![1]!;
    expect(await child.exited).toBe(0);
    profileID = JSON.parse(await readFile(join(data, "host.json"), "utf8")).profile.id;
    await work();
  } finally {
    await stopHost();
    await rm(data, { recursive: true, force: true });
    ({ data, token, profileID } = previous);
    host = await startHost();
  }
}

const dcUpload = (name: string, body: Uint8Array | string) => api(`/api/data-controls/imports?name=${encodeURIComponent(name)}`, { method: "POST", body: typeof body === "string" ? body : new Uint8Array(body) });
const dcRead = async (response: Response, status = 200) => {
  expect(response.status).toBe(status);
  return await response.json() as any;
};
const dcPrepare = async () => dcRead(await api("/api/data-controls/resets", { method: "POST", json: { requestId: crypto.randomUUID() } }), 201);
const dcConfirm = (prepared: any, extra: object = {}) => api(`/api/data-controls/resets/${prepared.requestId}/confirm`, { method: "POST",
  json: { confirmationId: prepared.confirmationId, inventory: prepared.inventory, profileId: prepared.profileId, epoch: prepared.epoch, confirm: true, phrase: "RESET", ...extra } });
const dcFact = (preview: any, text: string) => ({ sourceId: preview.sources[0].id, text });
const dcCandidates = (preview: any, requestId: string, facts: any[]) => api(`/api/data-controls/imports/${preview.token}/candidates`,
  { method: "POST", json: { requestId, confirm: true, facts } });
const dcZIP = (files: { path: string; data: Uint8Array }[]) => zipEncode(files, 128 * 1_048_576);
const dcText = (text: string) => new TextEncoder().encode(text);
function dcConversationPackage() {
  const text = dcText(JSON.stringify({ id: crypto.randomUUID(), type: "user", user: { intent: "DC original user durable preference.", attachments: [], at: 800_000_000 } }) + "\n"
    + JSON.stringify({ id: crypto.randomUUID(), type: "agent", agent: { at: 800_000_001,
      generations: [{ id: "g1", at: 800_000_001, model: "imported", outcome: { type: "completed", at: 800_000_002 } }],
      steps: [{ id: "s1", generation: "g1", type: "text", text: "DC assistant statement is not an owner fact." },
        { id: "s2", generation: "g1", type: "action", action: { type: "execute", execute: { source: "throw new Error('NEVER REPLAY IMPORT')",
          effects: [], outcome: { type: "succeeded", output: "Historical, not executed." } } } }], outcome: { type: "completed", at: 800_000_002 } } }) + "\n");
  return dcZIP([{ path: "conversation.json", data: dcText(JSON.stringify({ packageVersion: 1, transcriptSchemaVersion: 1, title: "DC passive source",
    createdAt: 800_000_000, exportedAt: 800_000_010, turnCount: 2, artifactCount: 0, hasContext: false, hasCompactedContext: false, serviceDomains: [],
    files: [{ path: "turns.jsonl", bytes: text.length, sha256: new Bun.CryptoHasher("sha256").update(text).digest("hex") }] })) }, { path: "turns.jsonl", data: text }]);
}

test("Muse Data controls DC-01 paired explanation has no collector, consent mutation or model dispatch", async () => dataControlsFixture(async () => {
  const called = requests.length, memory = await (await api("/api/files/content?path=MEMORY.md")).text();
  const state = await dcRead(await api("/api/data-controls"));
  expect(state.version).toBe(1);
  expect(state.collector).toEqual({ available: false, sending: false });
  expect(state.profileId).toBe(profileID);
  expect(state.scope.included).toContain("profile-content");
  expect((await api("/api/data-controls")).headers.get("cache-control")).toBe("no-store");
  expect((await fetch(`http://127.0.0.1:${host!.port}/api/data-controls`)).status).toBe(401);
  expect((await api("/api/data-controls", { headers: { origin: "https://foreign.example" } })).status).toBe(403);
  expect((await api("/api/data-controls", { method: "PUT", json: { trainingConsent: true } })).status).toBe(404);
  expect((await api("/api/data-controls/exports", { method: "POST", headers: { origin: "null" }, json: {} })).status).toBe(403);
  for (const [personal, parity] of [[false, true], [true, false]] as const) {
    await stopHost(); host = await startHost(personal, parity);
    expect((await api("/api/data-controls")).status).toBe(404);
    expect((await dcUpload("facts.txt", "Unselected text")).status).toBe(404);
  }
  await stopHost(); host = await startHost(true, true);
  expect(await (await api("/api/files/content?path=MEMORY.md")).text()).toBe(memory);
  expect((await read<{ defaultModel: unknown }>("/api/settings")).defaultModel).toBeNull();
  expect(requests.length).toBe(called);
}), 60_000);

test("Muse Data controls DC-02 no-model passive memory import uses atomic original manual review and MEMORY publication", async () => dataControlsFixture(async () => {
  const called = requests.length, before = await read("/api/review"), original = await (await api("/api/files/content?path=MEMORY.md")).text();
  const cancelled = await dcRead(await dcUpload("owner-facts.md", "I prefer checked sources.\n\nI work in English."), 201);
  expect(cancelled.sources.map((source: any) => source.text).join("\n")).toContain("I prefer checked sources.");
  expect((await read<any>("/api/review")).candidates).toEqual((before as any).candidates);
  expect(await (await api("/api/files/content?path=MEMORY.md")).text()).toBe(original);
  expect((await api(`/api/data-controls/imports/${cancelled.token}`, { method: "DELETE" })).status).toBe(200);
  expect((await api(`/api/data-controls/imports/${cancelled.token}`)).status).toBe(404);
  const preview = await dcRead(await dcUpload("owner-facts.txt", "I prefer checked sources.\n\nI work in English."), 201), requestId = crypto.randomUUID();
  const imported = await dcRead(await dcCandidates(preview, requestId, [dcFact(preview, "I prefer checked sources."), dcFact(preview, "I work in English.")]), 201);
  expect(imported.candidates).toHaveLength(2);
  expect(imported.candidates.every((candidate: any) => candidate.origin.kind === "manual" && candidate.status === "pending")).toBe(true);
  expect((await read<any>("/api/review")).settings.suggestionsEnabled).toBe(false);
  expect(await (await api("/api/files/content?path=MEMORY.md")).text()).toBe(original);
  expect((await dcRead(await api(`/api/data-controls/imports/requests/${requestId}`))).outcome).toBe("committed");
  for (const candidate of imported.candidates) {
    const detail = await read<any>(`/api/review/${candidate.id}`);
    expect((await api(`/api/review/${candidate.id}/accept`, { method: "POST",
      json: { expectedRevision: detail.candidate.revision, expectedSourceRevision: detail.source.revision } })).status).toBe(200);
  }
  const text = await (await api("/api/files/content?path=MEMORY.md")).text();
  expect(text).toContain("- I prefer checked sources.");
  expect(text).toContain("- I work in English.");
  await stopHost(); host = await startHost(true, true);
  expect(await (await api("/api/files/content?path=MEMORY.md")).text()).toBe(text);
  const proof = await dcRead(await api(`/api/data-controls/imports/requests/${requestId}`));
  expect(proof.candidates.every((candidate: any) => candidate.status === "accepted")).toBe(true);
  expect(proof.source.sha256).toMatch(/^[0-9a-f]{64}$/);
  expect(JSON.stringify(proof.source)).not.toContain("I prefer");
  expect((await read<any>("/api/review")).settings.suggestionsEnabled).toBe(false);
  expect((await read<any>("/api/conversations")).items).toEqual([]);
  expect(requests.length).toBe(called);
}), 60_000);

test("Muse Data controls DC-03 validated ZIP schemas refuse unsafe inputs and recover original peer publication conflicts", async () => dataControlsFixture(async () => {
  const initial = await dcRead(await api("/api/data-controls")), called = requests.length;
  expect(initial.collector.sending).toBe(false);
  const original = await (await api("/api/files/content?path=MEMORY.md")).text();
  for (const [name, bytes] of [["empty.txt", dcText(" \n")], ["invalid.txt", new Uint8Array([0xc3, 0x28])], ["nul.md", dcText("a\0b")],
    ["unknown.zip", dcZIP([{ path: "unknown.json", data: dcText("{}") }])], ["unknown.json", dcText("{}")],
    ["future.zip", dcZIP([{ path: "conversations.json", data: dcText(JSON.stringify({ version: 99, conversations: [] })) }])]] as const) {
    expect((await dcUpload(name, bytes)).status).toBe(400);
  }
  expect((await dcUpload("big.txt", dcText("x".repeat(512 * 1024 + 1)))).status).toBe(413);
  const badCRC = dcZIP([{ path: "conversations.json", data: dcText("[]") }]); badCRC[49] ^= 1;
  expect((await dcUpload("bad.zip", badCRC)).status).toBe(400);
  for (const mutate of [(bytes: Uint8Array) => {
    const view = new DataView(bytes.buffer), central = view.getUint32(bytes.length - 6, true);
    view.setUint16(6, 0x0801, true); view.setUint16(central + 8, 0x0801, true);
  }, (bytes: Uint8Array) => {
    const view = new DataView(bytes.buffer), central = view.getUint32(bytes.length - 6, true);
    view.setUint32(central + 38, 0xa000 << 16, true);
  }, (bytes: Uint8Array) => {
    const view = new DataView(bytes.buffer), central = view.getUint32(bytes.length - 6, true);
    view.setUint32(central + 24, 16 * 1_048_576 + 1, true);
  }, (bytes: Uint8Array) => {
    const view = new DataView(bytes.buffer), central = view.getUint32(bytes.length - 6, true);
    bytes.set(dcText("../history.json___"), 30); bytes.set(dcText("../history.json___"), central + 46);
  }]) {
    const bytes = dcZIP([{ path: "conversations.json", data: dcText("[]") }]); mutate(bytes);
    expect([400, 413]).toContain((await dcUpload("unsafe.zip", bytes)).status);
  }
  const openox = await dcRead(await dcUpload("original.conversation", dcConversationPackage()), 201);
  expect(openox.format).toBe("openox-conversation");
  expect(openox.sources.map((source: any) => source.text).join("\n")).toContain("DC original user");
  expect(JSON.stringify(openox.sources)).not.toContain("DC assistant");
  const history = [{ id: "chat-1", title: "Original source", current_node: "assistant", mapping: {
    root: { id: "root", parent: null, children: ["user"], message: null },
    user: { id: "user", parent: "root", children: ["assistant"], message: { id: "user-message", author: { role: "user" },
      content: { content_type: "text", parts: ["DC ChatGPT user-selected fact."] }, create_time: 1 } },
    assistant: { id: "assistant", parent: "user", children: [], message: { id: "assistant-message", author: { role: "assistant" },
      content: { content_type: "text", parts: ["DC unverified assistant fact."] }, create_time: 2 } },
  } }];
  const preview = await dcRead(await dcUpload("chatgpt.zip", dcZIP([{ path: "conversations.json", data: dcText(JSON.stringify(history)) }])), 201);
  expect(preview.format).toBe("chatgpt-history");
  expect(preview.sources).toHaveLength(1);
  expect(preview.sources[0].text).toBe("DC ChatGPT user-selected fact.");
  const requestId = crypto.randomUUID(), selected = await dcRead(await dcCandidates(preview, requestId, [dcFact(preview, "DC owner edited fact.")]), 201);
  const candidate = selected.candidates[0], stale = await read<any>(`/api/review/${candidate.id}`);
  expect((await api("/api/review/memory", { method: "PUT", json: { expectedSourceRevision: stale.source.revision, text: original + "DC peer text\n" } })).status).toBe(200);
  expect((await api(`/api/review/${candidate.id}/accept`, { method: "POST",
    json: { expectedRevision: candidate.revision, expectedSourceRevision: stale.source.revision } })).status).toBe(409);
  const current = await read<any>(`/api/review/${candidate.id}`);
  expect((await api(`/api/review/${candidate.id}/accept`, { method: "POST",
    json: { expectedRevision: current.candidate.revision, expectedSourceRevision: current.source.revision } })).status).toBe(200);
  expect((await read<any>(`/api/review/${candidate.id}`)).candidate.status).toBe("accepted");
  expect(await (await api("/api/files/content?path=MEMORY.md")).text()).toContain("DC peer text");
  expect(requests.length).toBe(called);
}), 60_000);

test("Muse Data controls DC-03 stable upload identity cancels late and still-reading previews without active mutation", async () => dataControlsFixture(async () => {
  const stageId = crypto.randomUUID(), before = await read<any>("/api/review"), called = requests.length;
  const uploaded = await dcRead(await api(`/api/data-controls/imports?name=late.txt&stageId=${stageId}`, { method: "POST", body: "DC late passive source" }), 201);
  expect(uploaded.token).toBe(stageId);
  expect((await api(`/api/data-controls/imports/${stageId}`, { method: "DELETE" })).status).toBe(200);
  expect((await api(`/api/data-controls/imports/${stageId}`)).status).toBe(404);
  const cancelled = crypto.randomUUID();
  expect((await api(`/api/data-controls/imports/${cancelled}`, { method: "DELETE" })).status).toBe(200);
  expect((await api(`/api/data-controls/imports?name=cancelled.txt&stageId=${cancelled}`, { method: "POST", body: "DC late cancelled source" })).status).toBe(409);
  const reading = crypto.randomUUID();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; value.enqueue(dcText("DC partial passive ")); } });
  const pending = api(`/api/data-controls/imports?name=reading.txt&stageId=${reading}`, { method: "POST", body: stream });
  try {
    await Bun.sleep(80);
    expect((await api(`/api/data-controls/imports/${reading}`, { method: "DELETE" })).status).toBe(200);
  } finally { controller.close(); }
  expect((await pending).status).toBe(409);
  expect((await api(`/api/data-controls/imports/${reading}`)).status).toBe(404);
  expect((await read<any>("/api/review")).candidates).toEqual(before.candidates);
  expect(await (await api("/api/files/content?path=MEMORY.md")).text()).toBe("");
  expect(requests.length).toBe(called);
}), 60_000);

async function dcContentFixture() {
  expect((await api("/api/settings/providers/custom", { method: "PUT", json: { name: "DC controlled setup",
    baseUrl: `http://127.0.0.1:${model.port}/v1`, models: ["fixture"] } })).status).toBe(200);
  const staged = await dcRead(await api("/api/conversations/import", { method: "POST", body: dcConversationPackage() }));
  const original = (await dcRead(await api(`/api/conversations/import/${staged.token}`, { method: "POST", json: {} }), 201)).id;
  const view = await read<any>(`/api/conversations/${original}`);
  const entry = view.blocks.find((block: any) => block.kind.type === "userText").kind.entry;
  const side = (await dcRead(await api(`/api/conversations/${original}/branch`, { method: "POST", json: { entry } }), 201)).id;
  expect((await api(`/api/conversations/${original}`, { method: "DELETE" })).status).toBe(200);
  const write = async (path: string, text: string | Uint8Array, overwrite = false) => {
    expect((await api(`/api/files/content?path=${encodeURIComponent(path)}${overwrite ? "&overwrite=1" : ""}`, { method: "PUT", body: typeof text === "string" ? text : new Uint8Array(text) })).status).toBe(201);
  };
  await write("MEMORY.md", "DC original memory\n", true);
  await write("SOUL.md", "DC original user guidance");
  await write(`conversations/${side}/evidence.bin`, new Uint8Array([0, 255, 1, 128, 17]));
  await write("skills/dc-owned/SKILL.md", "---\nname: dc-owned\ndescription: DC original Skill\n---\nUse checked sources.\n");
  await write("artifacts/dc-space.html", "<!doctype html><title>DC original Space</title><h1>Owned content</h1>");
  const todo = (await dcRead(await api("/api/todos", { method: "POST", headers: { "idempotency-key": "dc-todo" }, json: { title: "DC retained task content" } }), 201)).todo;
  await dcRead(await api("/api/goals", { method: "POST", headers: { "idempotency-key": "dc-goal" },
    json: { title: "DC original goal", outcome: "Verify original ownership", todoIds: [todo.id] } }), 201);
  await dcRead(await api("/api/spaces", { method: "POST", headers: { "idempotency-key": "dc-space" }, json: { name: "DC named Space", entryPath: "artifacts/dc-space.html" } }), 201);
  await dcRead(await api("/api/watches", { method: "POST", headers: { "idempotency-key": "dc-watch" },
    json: { name: "DC paused watch", url: "https://example.com/", intervalMinutes: 60, enabled: false } }), 201);
  await dcRead(await api("/api/schedules", { method: "POST", headers: { "idempotency-key": "dc-schedule" },
    json: { name: "DC paused scheduled work", prompt: "DC do not replay", recurrence: { type: "once", fireAt: Date.now() + 3_600_000 }, enabled: false } }), 201);
  const preview = await dcRead(await dcUpload("original.txt", "DC selected source"), 201);
  await dcRead(await dcCandidates(preview, crypto.randomUUID(), [dcFact(preview, "DC inactive original proposal")]), 201);
  const identity = await read<any>("/api/identity");
  await dcRead(await api("/api/identity", { method: "PATCH", json: { expectedRevision: identity.agent.revision, name: "DC original Agent" } }));
  const prompt = (await read<any>("/api/feed")).prompt;
  await dcRead(await api("/api/feed/prompt", { method: "PATCH", json: { expectedRevision: prompt.revision, text: "DC original Feed prompt" } }));
  const secret = { id: crypto.randomUUID(), requestId: crypto.randomUUID(), url: "https://example.com/private-dc-login", username: "DC private username", password: "DC secret keep exact" };
  await dcRead(await api("/api/passwords", { method: "POST", json: secret }), 201);
  await stopHost(); host = await startHost(true, true);
  return { original, side, secret, write };
}

test("Muse Data controls DC-04 complete bounded export includes hidden lineage and all declared owners but not authority", async () => dataControlsFixture(async () => {
  await dcRead(await api("/api/data-controls"));
  const fixture = await dcContentFixture(), called = requests.length;
  const response = await api("/api/data-controls/exports", { method: "POST", json: {} });
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("content-disposition")).toContain("attachment");
  const archive = new Uint8Array(await response.arrayBuffer()), files = zipDecode(archive, 128 * 1_048_576, 32 * 1_048_576, 256, undefined, 128 * 1_048_576);
  const manifest = JSON.parse(new TextDecoder().decode(files.find(file => file.path === "manifest.json")!.data));
  expect(manifest.packageVersion).toBe(1);
  expect(manifest.profileId).toBe(profileID);
  expect(manifest.scope.excluded).toContain("credentials-and-authority");
  expect(manifest.restoreSupported).toBe(false);
  for (const declared of manifest.files) {
    const bytes = files.find(file => file.path === declared.path)!.data;
    expect(bytes.length).toBe(declared.bytes);
    expect(new Bun.CryptoHasher("sha256").update(bytes).digest("hex")).toBe(declared.sha256);
  }
  expect(files).toHaveLength(manifest.files.length + 1);
  expect(files.some(file => file.path === "profile/state.sqlite")).toBe(true);
  expect(files.find(file => file.path === "profile/files/MEMORY.md")!.data).toEqual(dcText("DC original memory\n"));
  expect(files.some(file => file.path.endsWith("skills/dc-owned/SKILL.md"))).toBe(true);
  expect(files.find(file => file.path.endsWith(`conversations/${fixture.side}/evidence.bin`))!.data).toEqual(new Uint8Array([0, 255, 1, 128, 17]));
  const projection = JSON.parse(new TextDecoder().decode(files.find(file => file.path === "content.json")!.data));
  expect(projection.conversations.map((row: any) => row.id)).toContain(fixture.original);
  for (const owner of ["todos", "notifications", "review", "watches", "goals", "library", "discovery", "identity", "approvalHistory", "schedules"]) expect(projection).toHaveProperty(owner);
  const encoded = files.map(file => Buffer.from(file.data).toString("utf8")).join("\n");
  expect(encoded).not.toContain("DC secret keep exact");
  expect(encoded).not.toContain("DC private username");
  expect(files.some(file => /secrets|devices|credentials|action-policies|browser\//.test(file.path))).toBe(false);
  const unsafe = profilePath("files", "artifacts", "dc-symlink");
  await symlink(profilePath("vm", "state", "secrets.json"), unsafe);
  try { expect((await api("/api/data-controls/exports", { method: "POST", json: {} })).status).toBe(409); }
  finally { await rm(unsafe); }
  expect(requests.length).toBe(called);
}), 90_000);

test("Muse Data controls DC-05 protected Reset binds inventory, refuses busy/stale and permanently clears only authorized content", async () => dataControlsFixture(async () => {
  await dcRead(await api("/api/data-controls"));
  const fixture = await dcContentFixture(), called = requests.length;
  const keptSettings = await read("/api/settings"), keptSecret = await readFile(profilePath("vm", "state", "secrets.json"));
  const cancelled = await dcPrepare();
  expect(cancelled.summary.deleted.conversations).toBeGreaterThanOrEqual(2);
  expect(cancelled.summary.deleted.todos).toBe(1);
  expect(cancelled.summary.kept.credentials).toBe(1);
  expect((await api(`/api/data-controls/resets/${cancelled.requestId}`, { method: "DELETE" })).status).toBe(200);
  expect((await dcConfirm(cancelled)).status).toBe(409);
  const stale = await dcPrepare();
  await fixture.write("artifacts/dc-new-content.txt", "DC new inventory");
  expect((await dcConfirm(stale)).status).toBe(409);
  expect((await api(`/api/conversations/${fixture.side}/messages`, { method: "POST", json: { text: "slow-run DC busy refusal" } })).status).toBe(202);
  expect((await api("/api/data-controls/resets", { method: "POST", json: { requestId: crypto.randomUUID() } })).status).toBe(409);
  await until(() => read<View>(`/api/conversations/${fixture.side}`), view => !view.busy);
  const prepared = await dcPrepare(), confirmed = await dcRead(await dcConfirm(prepared));
  expect(confirmed.phase).toBe("completed");
  expect(confirmed.summary.deleted).toEqual(prepared.summary.deleted);
  expect((await dcRead(await api(`/api/data-controls/resets/${prepared.requestId}`))).phase).toBe("completed");
  expect((await read<any>("/api/conversations")).items).toEqual([]);
  expect(await read("/api/conversations/main")).toEqual({ id: null });
  expect((await api(`/api/conversations/${fixture.side}`)).status).toBe(404);
  expect(await (await api("/api/files/content?path=MEMORY.md")).text()).toBe("");
  expect((await read<any>("/api/review")).settings.suggestionsEnabled).toBe(false);
  expect((await read<any>("/api/review")).candidates).toEqual([]);
  for (const [path, key] of [["/api/todos", "todos"], ["/api/goals", "goals"], ["/api/watches", "watches"], ["/api/schedules", "schedules"], ["/api/spaces", "spaces"]]) {
    expect((await read<any>(path!))[key!]).toEqual([]);
  }
  expect(await read("/api/settings")).toEqual({ ...(keptSettings as any), contentEpoch: confirmed.epoch });
  expect(await readFile(profilePath("vm", "state", "secrets.json"))).toEqual(keptSecret);
  expect((await api("/api/conversations", { method: "POST", json: {} })).status).toBe(409);
  expect((await api("/api/files/content?path=artifacts/late.txt", { method: "PUT", body: "Must not resurrect",
    headers: { "x-openox-content-epoch": String(prepared.epoch) } })).status).toBe(409);
  await stopHost(); host = await startHost(true, true);
  expect((await read<any>("/api/conversations")).items).toEqual([]);
  expect(await readFile(profilePath("vm", "state", "secrets.json"))).toEqual(keptSecret);
  expect(requests.length).toBe(called + 1);
}), 90_000);

test("Muse Data controls DC-05 confirmed I/O failure is recoverable before workers and unconfirmed failure never erases", async () => dataControlsFixture(async () => {
  await dcRead(await api("/api/data-controls"));
  const fixture = await dcContentFixture(), called = requests.length;
  const journal = profilePath("state", "content-control.json"), privateState = profilePath("state");
  const before = await dcPrepare();
  await chmod(privateState, 0o500);
  try {
    expect((await dcConfirm(before)).status).toBe(503);
    expect(await (await api("/api/files/content?path=MEMORY.md")).text()).toBe("DC original memory\n");
  } finally { await chmod(privateState, 0o700); }
  expect(existsSync(journal)).toBe(false);
  const prepared = await dcPrepare(), blocked = profilePath("files", "artifacts");
  await chmod(blocked, 0o500);
  try {
    expect((await dcConfirm(prepared)).status).toBe(503);
    const record = JSON.parse(await readFile(journal, "utf8"));
    expect(record.operation.confirmed).toBe(true);
    expect(record.operation.phase).not.toBe("completed");
    const status = await dcRead(await api(`/api/data-controls/resets/${prepared.requestId}`));
    expect(status.phase).not.toBe("completed");
    expect(status.summaryKind).toBe("confirmed-scope");
    expect(status.progress.recorded).toBeLessThan(status.progress.total);
    expect(status.progress.logicalContentCleared).toBe(false);
    expect((await api("/api/conversations", { method: "POST", json: {}, headers: { "x-openox-content-epoch": String(prepared.epoch) } })).status).toBe(503);
  } finally { await chmod(blocked, 0o700); }
  await stopHost(); host = await startHost(true, true);
  const proof = await dcRead(await api(`/api/data-controls/resets/${prepared.requestId}`));
  expect(proof.phase).toBe("completed");
  expect((await read<any>("/api/conversations")).items).toEqual([]);
  expect(await read("/api/conversations/main")).toEqual({ id: null });
  expect((await read<any>("/api/passwords")).passwords[0].id).toBe(fixture.secret.id);
  expect(requests.length).toBe(called);
}), 90_000);

test("Muse Data controls DC-05 complete inventory binds original private conversation metadata, not only listed records", async () => dataControlsFixture(async () => {
  const fixture = await dcContentFixture();
  const prepared = await dcPrepare();
  expect((await api(`/api/conversations/${fixture.side}`, { method: "PATCH", json: { title: "DC changed original presentation" } })).status).toBe(200);
  expect((await dcConfirm(prepared)).status).toBe(409);
  expect((await read<View>(`/api/conversations/${fixture.side}`)).summary.title).toBe("DC changed original presentation");
  const entry = (await read<any>(`/api/conversations/${fixture.side}`)).blocks.find((block: any) => block.kind.type === "userText").kind.entry;
  expect((await api(`/api/conversations/${fixture.side}/branch`, { method: "POST", json: { entry } })).status).toBe(201);
  const hidden = await dcPrepare();
  expect((await api(`/api/conversations/${fixture.side}`, { method: "DELETE" })).status).toBe(200);
  expect((await dcConfirm(hidden)).status).toBe(409);
}), 60_000);

test("Muse Data controls DC-05 preparation recovery refuses unexpected original-owner content before consumers", async () => dataControlsFixture(async () => {
  const before = await dcRead(await api("/api/settings"));
  const prepared = await dcPrepare(), stage = profilePath("state", "staging");
  await chmod(stage, 0o500);
  try {
    expect((await dcConfirm(prepared)).status).toBe(503);
    expect(JSON.parse(await readFile(profilePath("state", "content-control.json"), "utf8")).operation.phase).toBe("preparing");
  } finally { await chmod(stage, 0o700); }
  await stopHost();
  const providers = await Providers.open(join(data, "credentials.json"));
  const options = { directory: profilePath(), profileID, hostID: before.host.id, models: providers.models };
  await LinuxProfile.prepareContentReset(options, { revision: 0, suggestionsEnabled: false });
  const owner = await LinuxProfile.open(options);
  try { await owner.goals.create({ title: "DC unexpected independent writer", outcome: "Retain this unconfirmed new content" }, "dc-ghost-goal"); }
  finally { await owner.close(); }
  host = await startHost(true, true);
  expect((await api("/api/goals")).status).toBe(503);
  const status = await dcRead(await api(`/api/data-controls/resets/${prepared.requestId}`));
  expect(status.complete).toBe(false);
  expect(status.phase).toBe("preparing");
}), 60_000);

test("Muse Data controls DC-05 later confirmed phases revalidate original VM content before workers can resume", async () => dataControlsFixture(async () => {
  await dcContentFixture();
  const prepared = await dcPrepare(), blocked = profilePath("files", "artifacts");
  await chmod(blocked, 0o500);
  try { expect((await dcConfirm(prepared)).status).toBe(503); }
  finally { await chmod(blocked, 0o700); }
  expect(JSON.parse(await readFile(profilePath("state", "content-control.json"), "utf8")).operation.phase).toBe("files");
  await stopHost();
  const schedules = new ScheduleStore(profilePath("vm", "state"), () => {});
  await schedules.load();
  await schedules.create({ name: "DC unexpected independent schedule", prompt: "Never replay unconfirmed new work", services: [], condition: null,
    deadline: null, conversationId: null, recurrence: { type: "once", fireAt: Date.now() + 3_600_000 } }, Date.now(), { key: "dc-new-independent-work", enabled: false });
  host = await startHost(true, true);
  expect((await api("/api/schedules")).status).toBe(503);
  const status = await dcRead(await api(`/api/data-controls/resets/${prepared.requestId}`));
  expect(status.complete).toBe(false);
}), 60_000);

type SearchItem = { id: string; kind: "conversation" | "message" | "file"; title: string; snippet: string; match: { start: number; end: number } | null;
  source: { conversationId?: number; mainChat?: boolean; fileId?: string; path?: string } };
type SearchPage = { available: boolean; epoch: number; requestId: string; items: SearchItem[]; nextCursor: string | null; complete: boolean;
  coverage: { sources: number; bytes: number; issues: { code: string; count: number }[] } };
async function gsPage(q: string, extra: Record<string, string> = {}) {
  const params = new URLSearchParams({ q, requestId: crypto.randomUUID(), ...extra });
  const response = await api(`/api/search?${params}`);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  return await response.json() as SearchPage;
}
async function gsAll(q: string, extra: Record<string, string> = {}, retain = false) {
  const requestId = crypto.randomUUID(), items: SearchItem[] = [], cursors = new Set<string>();
  let page = await gsPage(q, { requestId, ...extra });
  for (;;) {
    items.push(...page.items);
    if (!page.nextCursor) break;
    expect(cursors.has(page.nextCursor)).toBe(false); cursors.add(page.nextCursor);
    expect(cursors.size).toBeLessThan(200);
    page = await gsPage(q, { requestId, ...extra, cursor: page.nextCursor });
  }
  if (!retain) expect((await api(`/api/search/${requestId}`, { method: "DELETE" })).status).toBe(200);
  return { ...page, items };
}
async function gsSeed(work: (owner: LinuxProfile, choice: Parameters<LinuxProfile["setModel"]>[1]) => Promise<void>) {
  expect((await api("/api/settings/providers/custom", { method: "PUT",
    json: { name: "GS fixture authoring only", baseUrl: `http://127.0.0.1:${model.port}/v1`, models: ["fixture"] } })).status).toBe(200);
  const choice = (await read<{ defaultModel: Parameters<LinuxProfile["setModel"]>[1] }>("/api/settings")).defaultModel;
  await stopHost();
  const providers = await Providers.open(join(data, "credentials.json"), [{ id: "custom", name: "GS fixture authoring only",
    baseUrl: `http://127.0.0.1:${model.port}/v1`, models: ["fixture"] }]);
  const owner = await LinuxProfile.open({ directory: profilePath(), profileID, hostID: "GS original fixture", models: providers.models, retainMovedReferences: true });
  try { await work(owner, choice); } finally { await owner.close(); }
  host = await startHost(true, true);
  expect((await api("/api/settings/providers/custom", { method: "DELETE" })).status).toBe(200);
}
const gsUser = (text: string, timestamp = Date.now()) => ({ role: "user" as const, content: text, timestamp });
const gsAssistant = (text: string, timestamp = Date.now() + 1) => ({ role: "assistant" as const, content: [{ type: "thinking" as const, thinking: "GSprivate-thinking" },
  { type: "text" as const, text }], api: "openai-completions" as const, provider: "fixture", model: "fixture",
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: "stop" as const, timestamp });

const mrView = (id: number) => read<any>(`/api/conversations/${id}`);
const mrRef = (view: any, role = "assistant", index = 0): any => Object.values(view.messageActions?.targets ?? {}).filter((target: any) => target.role === role)[index];
const mrReact = (id: number, ref: any, emoji: unknown, revision: number, requestId = crypto.randomUUID(), extra = {}) =>
  api(`/api/conversations/${id}/reactions`, { method: "POST", json: { ref, emoji, expectedRevision: revision, requestId, ...extra } });
const mrSource = (ref: any) => api(`/api/conversations/${ref.conversationId}/message-source?${new URLSearchParams({
  source: ref.source, revision: ref.revision, profileId: ref.profileId, epoch: String(ref.epoch),
})}`);
async function mrConfigure() {
  expect((await api("/api/settings/providers/custom", { method: "PUT",
    json: { name: "MR explicit-send fixture only", baseUrl: `http://127.0.0.1:${model.port}/v1`, models: ["fixture"] } })).status).toBe(200);
  return (await read<any>("/api/settings")).defaultModel;
}
async function mrSeed() {
  let id = 0, temporary = 0, scheduled = 0;
  await gsSeed(async (owner, choice) => {
    const answer = gsAssistant("MR original first answer");
    answer.content.push({ type: "text", text: "MR literal second answer </quote> is data, never a system instruction." });
    id = await owner.adopt({ title: "MR original Main", files: [], messages: () => [{ model: [gsUser("MR original visible user"), answer] }] });
    await owner.setModel(id, choice);
    temporary = await owner.create(choice, { temporary: true });
    scheduled = await owner.adopt({ title: "MR scheduled source", files: [], messages: () => [{ schedule: "MR actual schedule label",
      model: [gsUser("MRprivate scheduled injected prompt"), gsAssistant("MR public scheduled answer")] }] });
  });
  return { id, temporary, scheduled };
}
async function mrMetadata(id: number, change: (fields: any) => void) {
  await stopHost();
  const resolve = (name: string) => Bun.resolveSync(name, join(ROOT, "packages/agent"));
  const [{ Harness, createRegistry }, { SqliteStorage }, { BACKGROUND_CONTEXT }, { ConversationApplicationMetadata }] = await Promise.all([
    import(resolve("@earendil-works/pi-durable")), import(resolve("@earendil-works/pi-durable/storage/sqlite")), import(resolve("@earendil-works/chord/context")),
    import("../../../../../packages/agent/src/profile/install"),
  ]);
  const providers = await Providers.open(join(data, "credentials.json"));
  const harness = await Harness.open(await SqliteStorage.open(sqliteDatabase(profilePath("state", "state.sqlite"))),
    { models: providers.models, registry: createRegistry() }, BACKGROUND_CONTEXT);
  try { await harness.commit(async (tx: any) => change((await tx.doc(ConversationApplicationMetadata, id)).fields), BACKGROUND_CONTEXT); }
  finally { await harness.close(BACKGROUND_CONTEXT); }
  host = await startHost(true, true);
}

test("Muse message actions MR-01 persist exact visible-part reactions without text, recency, Search, notice or model effects", async () => dataControlsFixture(async () => {
  const { id } = await mrSeed(), called = requests.length, view = await mrView(id);
  expect(Object.keys(view.messageActions?.targets ?? {}).length).toBe(3);
  const first = mrRef(view), second = mrRef(view, "assistant", 1), user = mrRef(view, "user");
  expect(first.ref.source).not.toBe(second.ref.source);
  expect(first.ref.source.split(":").length).toBe(3);
  const requestId = crypto.randomUUID(), saved = await dcRead(await mrReact(id, second.ref, "❤️", view.messageActions.revision, requestId));
  expect(saved.inputApplied).toBe(true); expect(saved.replayed).toBe(false); expect(saved.emoji).toBe("❤️");
  const peer = await mrView(id);
  expect(mrRef(peer).emoji).toBeNull(); expect(mrRef(peer, "assistant", 1).emoji).toBe("❤️"); expect(mrRef(peer, "user").emoji).toBeNull();
  expect(peer.messages).toEqual(view.messages); expect(peer.summary.lastActivity).toBe(view.summary.lastActivity);
  expect((await gsAll("MR original first")).items.length).toBe(1);
  expect((await gsAll("❤️")).items.length).toBe(0);
  const notices = await read("/api/notifications");
  await stopHost(); host = await startHost(true, true);
  const reloaded = await mrView(id);
  expect(mrRef(reloaded, "assistant", 1).emoji).toBe("❤️");
  expect(await read("/api/notifications")).toEqual(notices);
  expect((await mrSource(user.ref)).status).toBe(200);
  const cleared = await dcRead(await mrReact(id, second.ref, null, reloaded.messageActions.revision));
  expect(cleared.emoji).toBeNull(); expect(mrRef(await mrView(id), "assistant", 1).emoji).toBeNull();
  expect(requests.length).toBe(called);
}), 60_000);

test("Muse message actions MR-02 serialize peer CAS and distinguish exact historical proof from a fresh different save", async () => dataControlsFixture(async () => {
  const { id } = await mrSeed(), view = await mrView(id), target = mrRef(view);
  expect(target).toBeDefined();
  const requestId = crypto.randomUUID(), revision = view.messageActions.revision;
  const results = await Promise.all([mrReact(id, target.ref, "👍", revision, requestId), mrReact(id, target.ref, "🎉", revision)]);
  expect(results.map(response => response.status).sort()).toEqual([200, 409]);
  const replay = await dcRead(await mrReact(id, target.ref, "👍", revision, requestId));
  expect(replay.replayed).toBe(true); expect(replay.inputApplied).toBe(false); expect(replay.current).toBe(true);
  expect((await mrReact(id, target.ref, "🙏", revision, requestId)).status).toBe(409);
  const current = await mrView(id);
  await dcRead(await mrReact(id, target.ref, null, current.messageActions.revision));
  const proof = await dcRead(await api(`/api/conversations/${id}/reactions/${requestId}`));
  expect(proof.inputApplied).toBe(false); expect(proof.current).toBe(false); expect(proof.emoji).toBeNull();
  const ownerToken = token, peer = Bun.spawn([process.execPath, `${ROOT}/apps/linux/src/main.ts`, "token", "--name", "MR other paired owner", "--data", data], { stdout: "pipe" });
  const peerToken = /OX_HOST_TOKEN=(\S+)/.exec(await new Response(peer.stdout).text())![1]!;
  expect(await peer.exited).toBe(0);
  try {
    token = peerToken;
    expect((await api(`/api/conversations/${id}/reactions/${requestId}`)).status).toBe(404);
    expect((await mrReact(id, target.ref, "👍", revision, requestId)).status).toBe(409);
  } finally { token = ownerToken; }
}), 60_000);

test("Muse message actions MR-02 reject temporary, private, foreign, malformed and stale canonical references before mutation", async () => dataControlsFixture(async () => {
  const { id, temporary, scheduled } = await mrSeed(), view = await mrView(id), target = mrRef(view);
  expect(target).toBeDefined();
  for (const ref of [{ ...target.ref, profileId: crypto.randomUUID() }, { ...target.ref, epoch: 1 },
    { ...target.ref, revision: "0".repeat(64) }, { ...target.ref, source: target.ref.source.replace(/:\d+$/, ":0") }]) {
    expect((await mrReact(id, ref, "👍", 0)).status).toBe(409);
  }
  expect((await mrReact(temporary, { ...target.ref, conversationId: temporary }, "👍", 0)).status).toBe(409);
  expect((await mrReact(scheduled, target.ref, "👍", 0)).status).toBe(409);
  for (const emoji of ["hello", "👍🏽", "😀", "👍👍", "", 4]) expect((await mrReact(id, target.ref, emoji, 0)).status).toBe(400);
  expect((await mrReact(id, { ...target.ref, text: "MRprivate forged quote" }, "👍", 0)).status).toBe(400);
  expect((await mrReact(id, target.ref, "👍", -1)).status).toBe(400);
  expect((await mrReact(id, target.ref, "👍", 0, "not-a-uuid" as any)).status).toBe(400);
  expect((await mrReact(id, target.ref, "👍", 0, crypto.randomUUID(), { purpose: "x".repeat(5_000) })).status).toBe(413);
  const original = await mrView(scheduled);
  expect(Object.values(original.messageActions.targets).some((item: any) => item.role === "user")).toBe(false);
  const source = await dcRead(await mrSource(target.ref));
  expect(source.text).toBe("MR original first answer");
  expect(JSON.stringify(source)).not.toContain("GSprivate-thinking");
  expect((await mrReact(id, target.ref, "👍", 0)).status).toBe(200);
}), 60_000);

test("Muse message actions MR-02 branch and rerun never clone reactions, receipts or source authority onto replacement messages", async () => dataControlsFixture(async () => {
  const { id } = await mrSeed(), view = await mrView(id), target = mrRef(view);
  expect(target).toBeDefined();
  const requestId = crypto.randomUUID();
  await dcRead(await mrReact(id, target.ref, "🎉", 0, requestId));
  await mrConfigure();
  const entry = view.blocks.find((block: any) => block.kind.type === "userText").kind.entry;
  const branch = await dcRead(await api(`/api/conversations/${id}/branch`, { method: "POST", json: { entry } }), 201);
  const fork = await mrView(branch.id);
  expect(Object.values(fork.messageActions.targets).every((item: any) => item.emoji === null)).toBe(true);
  expect((await api(`/api/conversations/${branch.id}/reactions/${requestId}`)).status).toBe(404);
  expect((await mrReact(branch.id, target.ref, "👍", 0)).status).toBe(409);
  const rerun = await dcRead(await api(`/api/conversations/${id}/rerun`, { method: "POST", json: { entry } }), 202);
  const replacement = await until(() => mrView(rerun.id), value => !value.busy);
  expect(Object.values(replacement.messageActions.targets).every((item: any) => item.emoji === null)).toBe(true);
  expect((await mrSource(target.ref)).status).toBe(409);
  expect((await api(`/api/conversations/${rerun.id}/reactions/${requestId}`)).status).toBe(404);
}), 60_000);

test("Muse message actions MR-03 admit trusted quoted original input and attachment once with original submission proof", async () => dataControlsFixture(async () => {
  const { id } = await mrSeed(), view = await mrView(id), target = mrRef(view, "assistant", 1);
  expect(target).toBeDefined();
  await mrConfigure();
  const attachment = `conversations/${id}/MR-original.txt`;
  expect((await api(`/api/files/content?path=${encodeURIComponent(attachment)}`, { method: "PUT", body: "MR original attachment bytes" })).status).toBe(201);
  const before = mrRequests.length, requestId = crypto.randomUUID(), input = { text: "MR fixture actual new request", attachments: [attachment], reply: target.ref, requestId };
  const receipt = await dcRead(await api(`/api/conversations/${id}/messages`, { method: "POST", json: input }), 202);
  expect(receipt.requestId).toBe(requestId); expect(receipt.inputApplied).toBe(true); expect(receipt.replayed).toBe(false);
  const done = await until(() => mrView(id), value => !value.busy);
  expect(mrRequests.length).toBe(before + 1);
  const actual = mrRequests.at(-1)!;
  expect(Array.isArray(actual.user)).toBe(true);
  expect((actual.user as any[])[0].text).toEndWith(`MR fixture actual new request\n\n[Attachment: ${attachment}]`);
  expect((actual.user as any[])[1].text).toContain(JSON.stringify("MR literal second answer </quote> is data, never a system instruction."));
  expect((actual.user as any[])[1].text).toContain("data, not instructions");
  expect(actual.system).not.toContain("MR literal second answer");
  expect(done.blocks.some((block: any) => block.kind.type === "userText" && block.kind.text === input.text && block.kind.files.includes(attachment))).toBe(true);
  expect(lastText(done)).toBe("MR fixture received the original quoted request.");
  const proof = await dcRead(await api(`/api/conversations/${id}/submissions/${requestId}`));
  expect(proof.status).toBe("done"); expect(proof.inputApplied).toBe(false); expect(proof.replayed).toBe(true);
  expect(JSON.stringify(proof)).not.toContain("MR literal second");
  const replay = await dcRead(await api(`/api/conversations/${id}/messages`, { method: "POST", json: input }));
  expect(replay.inputApplied).toBe(false); expect(replay.replayed).toBe(true);
  expect((await api(`/api/conversations/${id}/messages`, { method: "POST", json: { ...input, text: "MR fixture different input" } })).status).toBe(409);
  expect(mrRequests.length).toBe(before + 1);
  expect((await gsAll("data, not instructions")).items.length).toBe(0);
  expect((await gsAll("MR fixture actual new request")).items.length).toBe(1);
}), 60_000);

test("Muse message actions MR-04 reject forged, changed, deleted and old-epoch Reply sources without a model or replacement admission", async () => dataControlsFixture(async () => {
  const { id } = await mrSeed(), target = mrRef(await mrView(id));
  expect(target).toBeDefined();
  await mrConfigure();
  const destination = await conversation(), called = requests.length;
  for (const reply of [{ ...target.ref, revision: "0".repeat(64) }, { ...target.ref, epoch: 1 }, { ...target.ref, profileId: crypto.randomUUID() },
    { ...target.ref, text: "MRprivate forged quote", path: "vm/state/secrets.json" }]) {
    const requestId = crypto.randomUUID();
    const response = await api(`/api/conversations/${destination}/messages`, { method: "POST", json: { text: "MR fixture refused", requestId, reply } });
    expect([400, 409]).toContain(response.status);
    expect((await api(`/api/conversations/${destination}/submissions/${requestId}`)).status).toBe(404);
  }
  expect((await api(`/api/conversations/${id}`, { method: "DELETE" })).status).toBe(200);
  expect((await api(`/api/conversations/${destination}/messages`, { method: "POST", json: { text: "MR fixture deleted", requestId: crypto.randomUUID(), reply: target.ref } })).status).toBe(409);
  expect(requests.length).toBe(called);
  expect((await mrView(destination)).messages).toEqual([]);
  expect((await mrView(destination)).error).toBeNull();
  const reset = await dcPrepare();
  await dcRead(await dcConfirm(reset));
  expect((await mrReact(id, target.ref, "👍", 0)).status).toBe(409);
  expect((await api(`/api/conversations/${destination}/messages`, { method: "POST",
    json: { text: "MR fixture stale", requestId: crypto.randomUUID(), reply: target.ref }, headers: { "x-openox-content-epoch": "0" } })).status).toBe(409);
  expect((await read<any>("/api/conversations")).items).toEqual([]);
}), 60_000);

test("Muse message actions MR-02 preserve bad, future and full original metadata without empty replacement or pruning", async () => dataControlsFixture(async () => {
  const { id } = await mrSeed(), target = mrRef(await mrView(id));
  expect(target).toBeDefined();
  for (const metadata of [{ version: 2, revision: 0, reactions: {}, requests: {} }, { version: 1, revision: -1, reactions: {}, requests: {} }]) {
    await mrMetadata(id, fields => { fields.messageActions = metadata; });
    expect((await mrReact(id, target.ref, "👍", 0)).status).toBe(503);
  }
  await mrMetadata(id, fields => { fields.messageActions = { version: 1, revision: 0,
    reactions: Object.fromEntries(Array.from({ length: 1_000 }, (_, index) => [`${100_000 + index}:0:0`, null])), requests: {} }; });
  expect((await mrReact(id, target.ref, "👍", 0)).status).toBe(507);
  let retained = 0;
  await mrMetadata(id, fields => { retained = Object.keys(fields.messageActions.reactions).length; delete fields.messageActions; });
  expect(retained).toBe(1_000);
  expect((await mrReact(id, target.ref, "👍", 0)).status).toBe(200);
}), 90_000);

test("Muse message actions MR-02 report actual SQLite write-lock failure and never certify an uncommitted reaction", async () => dataControlsFixture(async () => {
  const { id } = await mrSeed(), target = mrRef(await mrView(id));
  expect(target).toBeDefined();
  const requestId = crypto.randomUUID(), database = new Database(profilePath("state", "state.sqlite"));
  try {
    database.exec("BEGIN IMMEDIATE");
    expect((await mrReact(id, target.ref, "👍", 0, requestId)).status).toBe(503);
  } finally { database.exec("ROLLBACK"); database.close(); }
  await stopHost(); host = await startHost(true, true);
  expect(mrRef(await mrView(id)).emoji).toBeNull();
  expect((await api(`/api/conversations/${id}/reactions/${requestId}`)).status).toBe(404);
}), 60_000);

test("Muse message actions MR-05 retain source metadata but expose no new behavior when either gate is disabled", async () => dataControlsFixture(async () => {
  const { id } = await mrSeed(), target = mrRef(await mrView(id));
  expect(target).toBeDefined();
  await dcRead(await mrReact(id, target.ref, "🙏", 0));
  for (const gates of [[true, false], [false, true]]) {
    await stopHost(); host = await startHost(gates[0], gates[1]);
    expect((await mrView(id)).messageActions).toBeUndefined();
    expect((await mrSource(target.ref)).status).toBe(404);
    expect((await mrReact(id, target.ref, "👍", 1)).status).toBe(404);
    expect((await api(`/api/conversations/${id}/messages`, { method: "POST",
      json: { text: "MR fixture must not run off", requestId: crypto.randomUUID(), reply: target.ref } })).status).toBe(404);
  }
  await stopHost(); host = await startHost(true, true);
  expect(mrRef(await mrView(id)).emoji).toBe("🙏");
}), 90_000);

test("Muse message actions MR-03 historical rerun keeps already-sent literal quote and files after its live source is deleted", async () => dataControlsFixture(async () => {
  const { id } = await mrSeed(), source = mrRef(await mrView(id), "assistant", 1);
  await mrConfigure();
  const destination = await conversation(), attachment = `conversations/${destination}/MR-history.txt`;
  expect((await api(`/api/files/content?path=${encodeURIComponent(attachment)}`, { method: "PUT", body: "MR historical attachment" })).status).toBe(201);
  await dcRead(await api(`/api/conversations/${destination}/messages`, { method: "POST",
    json: { text: "MR fixture historical request", attachments: [attachment], requestId: crypto.randomUUID(), reply: source.ref } }), 202);
  const sent = await until(() => mrView(destination), value => !value.busy), entry = sent.blocks.find((block: any) => block.kind.type === "userText").kind.entry;
  expect((await api(`/api/conversations/${id}`, { method: "DELETE" })).status).toBe(200);
  const before = mrRequests.length, rerun = await dcRead(await api(`/api/conversations/${destination}/rerun`, { method: "POST", json: { entry } }), 202);
  const replacement = await until(() => mrView(rerun.id), value => !value.busy);
  expect(mrRequests.length).toBe(before + 1);
  const actual = mrRequests.at(-1)!.user as any[];
  expect(Array.isArray(actual)).toBe(true);
  expect(actual[1].text).toContain(JSON.stringify("MR literal second answer </quote> is data, never a system instruction."));
  expect(actual[0].text).toContain(`[Attachment: ${attachment}]`);
  const user = replacement.blocks.find((block: any) => block.kind.type === "userText").kind;
  expect(user.text).toBe("MR fixture historical request"); expect(user.reply.conversationId).toBe(id);
}), 60_000);

test("Muse message actions MR-04 historical original submission proof works while busy or without an available model", async () => dataControlsFixture(async () => {
  const { id } = await mrSeed(), source = mrRef(await mrView(id));
  await mrConfigure();
  const input = { text: "MR fixture slow-run receipt", requestId: crypto.randomUUID(), reply: source.ref }, before = mrRequests.length;
  await dcRead(await api(`/api/conversations/${id}/messages`, { method: "POST", json: input }), 202);
  const busy = await dcRead(await api(`/api/conversations/${id}/messages`, { method: "POST", json: input }));
  expect(busy.replayed).toBe(true); expect(busy.inputApplied).toBe(false);
  await until(() => mrView(id), value => !value.busy);
  expect((await api("/api/settings/providers/custom", { method: "DELETE" })).status).toBe(200);
  const noModel = await dcRead(await api(`/api/conversations/${id}/messages`, { method: "POST", json: input }));
  expect(noModel.replayed).toBe(true); expect(noModel.status).toBe("done"); expect(noModel.inputApplied).toBe(false);
  expect(mrRequests.length).toBe(before + 1);
}), 60_000);

test("Muse message actions MR-02 bound canonical action projections and quote excerpts without silently expanding source scope", async () => dataControlsFixture(async () => {
  let many = 0, quote = 0;
  await gsSeed(async owner => {
    many = await owner.adopt({ title: "MR bounded canonical parts", files: [], messages: () =>
      [{ model: Array.from({ length: 1_001 }, (_, index) => gsUser(`MR exact visible part ${index}`)) }] });
    quote = await owner.adopt({ title: "MR bounded quote source", files: [], messages: () => [{ model: [gsUser("界".repeat(6_001))] }] });
  });
  const view = await mrView(many);
  expect(Object.keys(view.messageActions.targets).length).toBe(1_000); expect(view.messageActions.limited).toBe(true);
  const original = await mrView(quote), source = await dcRead(await mrSource(mrRef(original, "user").ref));
  expect(Array.from(source.text).length).toBe(4_000); expect(Array.from(source.excerpt).length).toBe(160);
  expect(source.truncated).toBe(true); expect(source.text).toBe("界".repeat(4_000));
  expect(JSON.stringify(view.messageActions).length).toBeLessThan(512 * 1_024);
}), 60_000);

test("Muse message actions MR-02 canonical proof ignores JSON member order but never different source or input", async () => dataControlsFixture(async () => {
  const { id } = await mrSeed(), target = mrRef(await mrView(id)), requestId = crypto.randomUUID();
  await dcRead(await mrReact(id, target.ref, "👍", 0, requestId));
  const reordered = Object.fromEntries(Object.entries(target.ref).reverse());
  const replay = await dcRead(await mrReact(id, reordered, "👍", 0, requestId));
  expect(replay.replayed).toBe(true); expect(replay.inputApplied).toBe(false);
  expect((await mrReact(id, { ...reordered, source: reordered.source + "0" }, "👍", 0, requestId)).status).toBe(409);
  await mrConfigure();
  const input = { text: "MR fixture canonical user request", requestId: crypto.randomUUID(), reply: target.ref };
  await dcRead(await api(`/api/conversations/${id}/messages`, { method: "POST", json: input }), 202);
  await until(() => mrView(id), value => !value.busy);
  const called = requests.length, existing = await dcRead(await api(`/api/conversations/${id}/messages`, { method: "POST", json: { ...input, reply: reordered } }));
  expect(existing.replayed).toBe(true); expect(existing.inputApplied).toBe(false);
  expect(requests.length).toBe(called);
}), 60_000);

test("Muse global Search GS-01 reads original full visible messages and public UTF8 files without model or private sources", async () => dataControlsFixture(async () => {
  let side = 0, fork = 0, main = 0;
  await gsSeed(async (owner, choice) => {
    side = await owner.adopt({ title: "GS visible source", files: [], messages: () => [{ model: [gsUser("x".repeat(5_000) + " GSbody 搜索 e\u0301lan STRASSE"),
      gsAssistant("GS assistant public answer")] }] });
    await owner.setModel(side, choice);
    const entry = (await owner.view(side)).blocks.find((block: any) => block.kind.type === "userText") as any;
    fork = await owner.branch(side, entry.kind.entry); await owner.rename(fork, "GS visible branch"); await owner.remove(side);
    main = await owner.create(undefined, { mainChat: true });
    const temporary = await owner.create(undefined, { temporary: true }); await owner.rename(temporary, "GSprivate-temporary");
    await owner.writeFile("artifacts/GS中文.txt", "Original GSfile 搜索 e\u0301lan Straße content.");
    await owner.writeFile("artifacts/GSmedia.pdf", new Uint8Array([37, 80, 68, 70, 0, 255, 0]));
    await owner.writeFile("artifacts/GSinvalid.txt", new Uint8Array([71, 83, 255, 254]));
    await owner.writeFile("app/GSprivate-owner.json", "GSprivate-app");
    await owner.writeFile("logs/GSprivate-log.txt", "GSprivate-log");
  });
  const calls = requests.length, before = await read("/api/conversations/main");
  const body = await gsAll("GSbody");
  expect(body.available).toBe(true);
  expect(body.items.length).toBe(1);
  expect(body.items[0]!.kind).toBe("message");
  expect(body.items[0]!.source.conversationId).toBe(fork);
  expect(body.items[0]!.snippet).toContain("GSbody");
  expect(body.items[0]!.snippet.slice(body.items[0]!.match!.start, body.items[0]!.match!.end)).toBe("GSbody");
  expect((await gsAll("搜索")).items.map(item => item.kind).sort()).toEqual(["file", "message"]);
  expect((await gsAll("ÉLAN")).items.length).toBe(2);
  expect((await gsAll("strasse")).items.length).toBe(2);
  expect((await gsAll("GS assistant public")).items[0]!.source.conversationId).toBe(fork);
  expect((await gsAll("GSmedia.pdf")).items[0]!.source.path).toBe("artifacts/GSmedia.pdf");
  const privateItems = await gsAll("GSprivate");
  expect(privateItems.items).toEqual([]);
  expect(privateItems.complete).toBe(false);
  expect(privateItems.coverage.issues.some(issue => issue.code === "unsupported-text")).toBe(true);
  const recent = await gsAll("");
  expect(recent.items.some(item => item.source.conversationId === main)).toBe(true);
  expect(recent.items.some(item => item.source.conversationId === side)).toBe(false);
  expect(await read("/api/conversations/main")).toEqual(before);
  expect(requests.length).toBe(calls);
}), 60_000);

test("Muse global Search GS-02 continues beyond loaded conversation and history pages with exact lineage anchors", async () => dataControlsFixture(async () => {
  let ancient = 0, visible = 0, fork = 0;
  await gsSeed(async (owner, choice) => {
    ancient = await owner.adopt({ title: "GS oldest history", files: [], messages: () => Array.from({ length: 625 }, (_, index) =>
      ({ model: [gsUser(index === 0 ? "GSancient exact original anchor" : `ordinary history ${index}`, 1_700_000_000_000 + index)] })) });
    for (let index = 0; index < 505; index++) {
      visible = await owner.adopt({ title: `GS page source ${index}`, files: [], messages: () => [{ model: [gsUser(`GSpagination ${index}`, 1_700_010_000_000 + index)] }] });
    }
    await owner.setModel(visible, choice);
    const entry = (await owner.view(visible)).blocks.find((block: any) => block.kind.type === "userText") as any;
    fork = await owner.branch(visible, entry.kind.entry);
  });
  const all = await gsAll("GSpagination", { limit: "7", scope: "chats" });
  expect(all.complete).toBe(true);
  expect(all.items.length).toBe(505);
  expect(new Set(all.items.map(item => item.id)).size).toBe(505);
  expect(all.items.filter(item => item.source.conversationId === visible || item.source.conversationId === fork).length).toBe(1);
  const found = await gsAll("GSancient", { scope: "chats" }, true);
  expect(found.complete).toBe(true);
  expect(found.items.length).toBe(1);
  const opened = await read<any>(`/api/search/targets/${found.items[0]!.id}`);
  expect(opened.target.kind).toBe("chat");
  expect(opened.target.conversationId).toBe(ancient);
  expect(opened.target.view.blocks.some((block: any) => block.kind.text === "GSancient exact original anchor")).toBe(true);
  expect(opened.target.source).toBeString();
}), 120_000);

test("Muse global Search GS-02 binds continuation and retained targets to owner inventory and original moved identities", async () => dataControlsFixture(async () => {
  await gsSeed(async owner => {
    for (let index = 0; index < 3; index++) await owner.adopt({ title: `GSchange title ${index}`, files: [],
      messages: () => [{ model: [gsUser(`GSchange message ${index}`)] }] });
    await owner.writeFile("artifacts/GSchange.txt", "GSchange original file anchor");
  });
  const page = await gsPage("GSchange", { limit: "1" });
  expect(page.nextCursor).toBeString();
  const file = (await gsAll("original file anchor", {}, true)).items[0]!;
  expect(file.kind).toBe("file");
  expect((await api("/api/files/move", { method: "POST", json: { from: "artifacts/GSchange.txt", to: "artifacts/GSchange-moved.txt" } })).status).toBe(200);
  const moved = await read<any>(`/api/search/targets/${file.id}`);
  expect(moved.target.path).toBe("artifacts/GSchange-moved.txt");
  expect(moved.target.text).toBe("GSchange original file anchor");
  expect((await api(`/api/search?${new URLSearchParams({ q: "GSchange", requestId: page.requestId, limit: "1", cursor: page.nextCursor! })}`)).status).toBe(409);
  expect((await api("/api/files?path=artifacts%2FGSchange-moved.txt", { method: "DELETE" })).status).toBe(200);
  expect((await api("/api/files/content?path=artifacts%2FGSchange-moved.txt", { method: "PUT", body: "GSchange replacement same path" })).status).toBe(201);
  expect((await api(`/api/search/targets/${file.id}`)).status).toBe(409);
  const current = await gsPage("GSchange", { limit: "1", scope: "chats" });
  expect((await api(`/api/search?${new URLSearchParams({ q: "different", requestId: current.requestId, limit: "1", scope: "chats", cursor: current.nextCursor! })}`)).status).toBe(409);
  const cancelled = await gsPage("GSchange", { limit: "1" });
  expect((await api(`/api/search/${cancelled.requestId}`, { method: "DELETE" })).status).toBe(200);
  expect((await api(`/api/search/targets/${cancelled.items[0]!.id}`)).status).toBe(404);
}), 60_000);

test("Muse global Search GS-03 validates private GET authority, query bounds and honest unsupported or unavailable content", async () => dataControlsFixture(async () => {
  await gsSeed(async owner => {
    await owner.writeFile("artifacts/GSdenied.txt", "GSdenied original content");
    await owner.writeFile("artifacts/GSbig.txt", new Uint8Array(1_048_577).fill(120));
    await owner.writeFile("artifacts/GSpdf.pdf", new Uint8Array([0, 255]));
  });
  for (const query of ["q=" + "x".repeat(201), "scope=private", "limit=0", "limit=51", "cursor=bad!", "path=vm/state/secrets.json", "q=a&q=b"]) {
    expect((await api(`/api/search?requestId=${crypto.randomUUID()}&${query}`)).status).toBe(400);
  }
  expect((await fetch(`http://127.0.0.1:${host!.port}/api/search?q=x&requestId=${crypto.randomUUID()}`)).status).toBe(401);
  expect((await api(`/api/search?q=x&requestId=${crypto.randomUUID()}`, { headers: { origin: "https://foreign.example" } })).status).toBe(403);
  const max = await gsPage("中".repeat(200), { scope: "chats" }); expect(max.complete).toBe(true);
  const unsupported = await gsAll("absent");
  expect(unsupported.items).toEqual([]);
  expect(unsupported.complete).toBe(false);
  expect(unsupported.coverage.issues.some(issue => issue.code === "source-too-large")).toBe(true);
  expect(unsupported.coverage.issues.some(issue => issue.code === "unsupported-text")).toBe(true);
  const path = profilePath("files/artifacts/GSdenied.txt");
  await chmod(path, 0o000);
  try {
    const denied = await gsAll("GSdenied", { scope: "files" });
    expect(denied.items.some(item => item.source.path === "artifacts/GSdenied.txt")).toBe(true);
    expect(denied.complete).toBe(false);
    expect(denied.coverage.issues.some(issue => issue.code === "unreadable-text")).toBe(true);
  } finally { await chmod(path, 0o600); }
  expect((await gsAll("GSdenied original", { scope: "files" })).items.length).toBe(1);
  await stopHost(); host = await startHost(true, false);
  expect((await api(`/api/search?q=GSdenied&requestId=${crypto.randomUUID()}`)).status).toBe(404);
  await stopHost(); host = await startHost(false, true);
  expect((await api(`/api/search?q=GSdenied&requestId=${crypto.randomUUID()}`)).status).toBe(404);
}), 60_000);

test("Muse global Search GS-01 orders real recents across original chats and files rather than grouping or pinning them", async () => dataControlsFixture(async () => {
  await gsSeed(async owner => {
    await owner.adopt({ title: "GS old conversation", files: [], messages: () => [{ model: [gsUser("older original activity", 1_600_000_000_000)] }] });
    await owner.writeFile("artifacts/GS newest original.txt", "latest original file");
  });
  const recent = await gsAll("");
  expect(recent.items[0]!.kind).toBe("file");
  expect(recent.items[0]!.source.path).toBe("artifacts/GS newest original.txt");
}), 30_000);

test("Muse global Search GS-04 target windows retain original scheduled and Skill presentation rather than exposing injected prompts", async () => dataControlsFixture(async () => {
  await gsSeed(async owner => {
    await owner.adopt({ title: "GS scheduled source", files: [], messages: () => [{ schedule: "GS original scheduled label",
      model: [gsUser("GSprivate-scheduled-prompt"), gsAssistant("GS scheduled visible answer")] }] });
  });
  expect((await gsAll("GSprivate-scheduled-prompt")).items).toEqual([]);
  const page = await gsAll("GS scheduled visible answer", {}, true);
  const target = await read<any>(`/api/search/targets/${page.items[0]!.id}`);
  const user = target.target.view.blocks.find((block: any) => block.kind.type === "userText");
  expect(user.kind.schedule).toBe("GS original scheduled label");
}), 30_000);

test("Muse global Search GS-03 refuses an indivisible oversized Unicode snippet instead of empty infinite continuations", async () => dataControlsFixture(async () => {
  await gsSeed(async owner => { await owner.writeFile("artifacts/GS giant cluster.txt", "e" + "\u035c".repeat(70_000)); });
  const response = await api(`/api/search?${new URLSearchParams({ q: "\u035c", requestId: crypto.randomUUID() })}`);
  expect(response.status).toBe(413);
  expect((await response.text()).length).toBeLessThan(512);
}), 30_000);

test("Muse global Search GS-03 retires owner request identity before a delayed initial GET can create transient results", async () => dataControlsFixture(async () => {
  const requestId = crypto.randomUUID();
  expect((await api(`/api/search/${requestId}`, { method: "DELETE" })).status).toBe(200);
  expect((await api(`/api/search?${new URLSearchParams({ q: "", requestId })}`)).status).toBe(409);
}), 30_000);

test("Muse global Search GS-03 admits original file text before the exact per-request byte budget and continues the rest", async () => dataControlsFixture(async () => {
  await gsSeed(async owner => {
    const bytes = new Uint8Array(1_000_000).fill(120);
    for (let index = 0; index < 10; index++) await owner.writeFile(`artifacts/GS-budget-${index}.txt`, bytes);
  });
  const first = await gsPage("absent-budget-needle", { scope: "files" });
  expect(first.complete).toBe(false); expect(first.nextCursor).toBeString();
  expect(first.coverage.bytes).toBeLessThanOrEqual(8 * 1_048_576);
  const next = await gsPage("absent-budget-needle", { scope: "files", requestId: first.requestId, cursor: first.nextCursor! });
  expect(next.complete).toBe(true);
  expect(next.items).toEqual([]);
  expect(next.coverage.bytes).toBe(10_000_000);
}), 45_000);

test("Muse global Search GS-03 ends explicitly partial at its retained-reference bound without claiming completion", async () => dataControlsFixture(async () => {
  await gsSeed(async owner => {
    await owner.adopt({ title: "GS retained original source", files: [], messages: () => Array.from({ length: 2_002 }, (_, index) =>
      ({ model: [gsUser(`GSreference-bound original message ${index}`, 1_700_000_000_000 + index)] })) });
  });
  const page = await gsAll("GSreference-bound", { scope: "chats", limit: "50" });
  expect(page.items.length).toBe(2_000);
  expect(page.complete).toBe(false);
  expect(page.nextCursor).toBeNull();
  expect(page.coverage.issues).toContainEqual({ code: "reference-limit", count: 1 });
}), 45_000);

test("Muse Main chat keeps one owner across concurrent creation, Side branches, regeneration and restart", async () => {
  await stopHost(); host = await startHost(true, true);
  try {
    const before = (await read<{ items: { id: number }[] }>("/api/conversations")).items.map(item => item.id);
    const called = requests.length;
    expect((await api("/api/conversations/main")).status).toBe(200);
    expect(await read("/api/conversations/main")).toEqual({ id: null });
    expect((await read<{ items: { id: number }[] }>("/api/conversations")).items.map(item => item.id)).toEqual(before);
    const choice = (await read<{ defaultModel: { provider: string; modelId: string } }>("/api/settings")).defaultModel;
    const responses = await Promise.all([0, 1].map(() => api("/api/conversations/main", { method: "POST", json: { model: choice } })));
    expect(responses.map(response => response.status).sort()).toEqual([200, 201]);
    const created = await Promise.all(responses.map(response => response.json() as Promise<{ id: number }>));
    const main = created[0]!.id;
    expect(created[1]!.id).toBe(main);
    expect(await read("/api/conversations/main")).toEqual({ id: main });
    expect((await read<{ summary: { temporary: boolean; model: unknown } }>(`/api/conversations/${main}`)).summary).toMatchObject({ temporary: false, model: choice });
    expect(requests.length).toBe(called);
    const side = await conversation();
    expect(side).not.toBe(main);
    expect((await api("/api/conversations/main", { method: "POST", json: { model: { ...choice, modelId: "fixture-2" } } })).status).toBe(409);
    expect((await read<{ summary: { model: unknown } }>(`/api/conversations/${main}`)).summary.model).toEqual(choice);
    const users = async (id: number) => (await read<{ blocks: { kind: { type: string; text?: string; entry?: number } }[] }>(`/api/conversations/${id}`)).blocks
      .flatMap(block => block.kind.type === "userText" && typeof block.kind.entry === "number" ? [{ entry: block.kind.entry, text: block.kind.text }] : []);
    const send = async (id: number, text: string) => {
      expect((await api(`/api/conversations/${id}/messages`, { method: "POST", json: { text } })).status).toBe(202);
      await until(() => read<View>(`/api/conversations/${id}`), view => !view.busy && view.messages.some(message => message.role === "user" && textOf(message.content).includes(text)));
    };
    await send(main, "Main context marker");
    await send(main, "Main second turn");
    await send(side, "Side context marker");
    const listed = (await read<{ items: { id: number }[] }>("/api/conversations")).items;
    expect(listed.filter(item => item.id === main)).toHaveLength(1);
    expect((await users(main)).map(user => user.text).join("\n")).not.toContain("Side context marker");
    expect((await users(side)).map(user => user.text).join("\n")).not.toContain("Main context marker");
    const fork = await api(`/api/conversations/${main}/branch`, { method: "POST", json: { entry: (await users(main))[0]!.entry } });
    expect(fork.status).toBe(201);
    const branch = (await fork.json() as { id: number }).id;
    expect(branch).not.toBe(main);
    expect(await read("/api/conversations/main")).toEqual({ id: main });
    const rerun = await api(`/api/conversations/${main}/rerun`, { method: "POST", json: { entry: (await users(main))[1]!.entry } });
    expect(rerun.status).toBe(202);
    let active = (await rerun.json() as { id: number }).id;
    await until(() => read<View>(`/api/conversations/${active}`), view => !view.busy);
    expect(await read("/api/conversations/main")).toEqual({ id: active });
    const first = await api(`/api/conversations/${active}/rerun`, { method: "POST", json: { entry: (await users(active))[0]!.entry, text: "Revised Main context" } });
    expect(first.status).toBe(202);
    active = (await first.json() as { id: number }).id;
    await until(() => read<View>(`/api/conversations/${active}`), view => !view.busy);
    expect(await read("/api/conversations/main")).toEqual({ id: active });
    expect((await api(`/api/conversations/${active}`, { method: "PATCH", json: { title: "Owner Main" } })).status).toBe(200);
    const stoppedAt = requests.length;
    await stopHost(); host = await startHost(true, true);
    expect(await read("/api/conversations/main")).toEqual({ id: active });
    expect((await read<View>(`/api/conversations/${active}`)).summary.title).toBe("Owner Main");
    expect((await users(active)).map(user => user.text).join("\n")).toContain("Revised Main context");
    expect((await users(side)).map(user => user.text).join("\n")).toContain("Side context marker");
    expect((await api(`/api/conversations/${branch}`)).status).toBe(200);
    expect(requests.length).toBe(stoppedAt);
    await stopHost(); host = await startHost(true, false);
    expect((await api("/api/conversations/main")).status).toBe(404);
    expect((await api("/api/conversations/main", { method: "POST", json: {} })).status).toBe(404);
    expect((await api(`/api/conversations/${active}`)).status).toBe(200);
    await stopHost(); host = await startHost(true, true);
    expect(await read("/api/conversations/main")).toEqual({ id: active });
    expect((await api(`/api/conversations/${active}`, { method: "DELETE" })).status).toBe(200);
    expect(await read("/api/conversations/main")).toEqual({ id: null });
    expect((await api(`/api/conversations/${side}`)).status).toBe(200);
    expect(requests.length).toBe(stoppedAt);
  } finally { await stopHost(); host = await startHost(); }
}, 60_000);

test("Muse Main chat refuses unavailable, malformed and unpaired creation without mutation or inference", async () => {
  const called = requests.length;
  for (const [personal, parity] of [[false, true], [true, false]] as const) {
    await stopHost(); host = await startHost(personal, parity);
    const before = (await read<{ items: { id: number }[] }>("/api/conversations")).items.map(item => item.id);
    expect((await api("/api/conversations/main")).status).toBe(404);
    expect((await api("/api/conversations/main", { method: "POST", json: {} })).status).toBe(404);
    expect((await read<{ items: { id: number }[] }>("/api/conversations")).items.map(item => item.id)).toEqual(before);
  }
  await stopHost(); host = await startHost(true, true);
  try {
    const leftover = await read<{ id: number | null }>("/api/conversations/main");
    if (leftover.id !== null) expect((await api(`/api/conversations/${leftover.id}`, { method: "DELETE" })).status).toBe(200);
    const before = (await read<{ items: { id: number }[] }>("/api/conversations")).items.map(item => item.id);
    expect((await fetch(`http://127.0.0.1:${host.port}/api/conversations/main`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(401);
    for (const body of [null, [], { temporary: true }, { model: "not-a-model" }]) {
      expect((await api("/api/conversations/main", { method: "POST", json: body })).status).toBe(400);
    }
    expect((await api("/api/settings/providers/custom", { method: "DELETE" })).status).toBe(200);
    expect((await api("/api/conversations/main", { method: "POST", json: {} })).status).toBe(409);
    expect(await read("/api/conversations/main")).toEqual({ id: null });
    expect((await read<{ items: { id: number }[] }>("/api/conversations")).items.map(item => item.id)).toEqual(before);
    expect(requests.length).toBe(called);
  } finally {
    expect((await api("/api/settings/providers/custom", { method: "PUT",
      json: { name: "Scripted", baseUrl: `http://127.0.0.1:${model.port}/v1`, models: ["fixture", "fixture-2"] } })).status).toBe(200);
    await stopHost(); host = await startHost();
  }
}, 45_000);

test("Muse Goals keep outcome ownership, receipts and revisions across task progress, deletion and restart", async () => {
  await stopHost(); host = await startHost(true, true);
  try {
    const called = requests.length;
    expect((await api("/api/goals")).status).toBe(200);
    const linked = await createTodo("goal-linked-task", { title: "Read a controlled reference" });
    expect(linked.status).toBe(201);
    const todo = (await linked.json() as { todo: { id: string; revision: number } }).todo;
    const draft = { title: "Learn a subject", outcome: "Explain the subject using a checked source", todoIds: [todo.id] };
    const create = (body: unknown = draft) => api("/api/goals", { method: "POST", headers: { "idempotency-key": "goal-owner-create" }, json: body });
    const created = await create();
    expect(created.status).toBe(201);
    type Goal = { id: string; title: string; outcome: string; notes: string; todoIds: string[]; completed: boolean; completedAt: string | null; revision: number };
    let goal = (await created.json() as { goal: Goal }).goal;
    expect(goal).toMatchObject({ ...draft, notes: "", completed: false, completedAt: null, revision: 1 });
    expect(goal.id).not.toBe(todo.id);
    expect((await create()).status).toBe(200);
    expect((await (await create()).json() as { goal: Goal }).goal.id).toBe(goal.id);
    expect((await create({ ...draft, title: "Changed request" })).status).toBe(409);
    expect((await api(`/api/todos/${todo.id}`, { method: "PATCH", json: { expectedRevision: todo.revision, completed: true } })).status).toBe(200);
    expect((await read<Goal>(`/api/goals/${goal.id}`)).completed).toBe(false);
    const edited = await api(`/api/goals/${goal.id}`, { method: "PATCH", json: { expectedRevision: 1, notes: "One checked source" } });
    expect(edited.status).toBe(200);
    goal = await edited.json() as Goal;
    expect(goal).toMatchObject({ revision: 2, notes: "One checked source", completed: false });
    expect((await api(`/api/goals/${goal.id}`, { method: "PATCH", json: { expectedRevision: 1, notes: "Must not overwrite" } })).status).toBe(409);
    goal = await (await api(`/api/goals/${goal.id}`, { method: "PATCH", json: { expectedRevision: 2, completed: true } })).json() as Goal;
    expect(goal.completed).toBe(true);
    expect(typeof goal.completedAt).toBe("string");
    goal = await (await api(`/api/goals/${goal.id}`, { method: "PATCH", json: { expectedRevision: 3, completed: false } })).json() as Goal;
    expect(goal).toMatchObject({ completed: false, completedAt: null, revision: 4 });
    expect((await api(`/api/todos/${todo.id}`, { method: "DELETE", json: { expectedRevision: 2 } })).status).toBe(200);
    expect((await read<Goal>(`/api/goals/${goal.id}`)).todoIds).toEqual([todo.id]);
    for (const body of [null, [], { title: " ", outcome: "Result" }, { title: "Name", outcome: " " }, { ...draft, todoIds: [crypto.randomUUID()] }, { ...draft, invented: true }]) {
      expect((await api("/api/goals", { method: "POST", headers: { "idempotency-key": crypto.randomUUID() }, json: body })).status).toBe(400);
    }
    await stopHost(); host = await startHost(true, true);
    expect(await read(`/api/goals/${goal.id}`)).toEqual(goal);
    await stopHost(); host = await startHost(true, false);
    expect(await read("/api/goals")).toEqual({ available: false });
    expect((await create()).status).toBe(503);
    await stopHost(); host = await startHost(true, true);
    expect(await read(`/api/goals/${goal.id}`)).toEqual(goal);
    expect((await api(`/api/goals/${goal.id}`, { method: "DELETE", json: { expectedRevision: 3 } })).status).toBe(409);
    expect((await api(`/api/goals/${goal.id}`, { method: "DELETE", json: { expectedRevision: 4 } })).status).toBe(200);
    expect((await create()).status).toBe(409);
    expect((await api(`/api/goals/${goal.id}`)).status).toBe(404);
    expect(requests.length).toBe(called);
  } finally { await stopHost(); host = await startHost(); }
}, 45_000);

test("Muse Goal tools share approved records but cannot complete goals or write from temporary and disabled contexts", async () => {
  await stopHost(); host = await startHost(true, true);
  try {
    const id = await conversation();
    expect((await value<{ available: boolean }>(id, `return {available:typeof ox.goal?.create==="function"};`)).result.available).toBe(true);
    const created = await value<{ goal: { id: string; revision: number; completed: boolean }; replayed: boolean }>(id,
      `return await ox.goal.create({purpose:"Create a learning outcome",title:"Tool outcome",outcome:"Explain a verified result"});`, approve);
    conforms("ox.goal.create", created.result);
    expect(created.prompts).toHaveLength(1);
    const goal = created.result.goal;
    expect(await read(`/api/goals/${goal.id}`)).toMatchObject({ title: "Tool outcome", completed: false, revision: 1 });
    const list = await value<{ goals: { id: string }[] }>(id, `return await ox.goal.list({purpose:"Inspect current outcomes"});`, approve);
    conforms("ox.goal.list", list.result);
    expect(list.prompts).toHaveLength(1);
    expect(list.result.goals.some(item => item.id === goal.id)).toBe(true);
    const updated = await value(id, `return await ox.goal.update({purpose:"Record actual progress",id:${JSON.stringify(goal.id)},expectedRevision:1,notes:"A source was checked"});`, approve);
    conforms("ox.goal.update", updated.result);
    expect(updated.result).toMatchObject({ revision: 2, notes: "A source was checked", completed: false });
    const forbidden = await turn(id, `return await ox.goal.update({purpose:"Cannot self-complete",id:${JSON.stringify(goal.id)},expectedRevision:2,completed:true});`);
    expect(forbidden.prompts).toHaveLength(0);
    expect(forbidden.output).toContain("completed");
    expect((await read<{ completed: boolean }>(`/api/goals/${goal.id}`)).completed).toBe(false);
    const denied = await turn(id, `return await ox.goal.create({purpose:"Refused creation",title:"Declined goal",outcome:"Must not exist"});`, () => ({ answer: "Deny" }));
    expect(denied.prompts).toHaveLength(1);
    expect((await read<{ goals: { title: string }[] }>("/api/goals")).goals.some(item => item.title === "Declined goal")).toBe(false);
    const temporaryResponse = await api("/api/conversations", { method: "POST", json: { temporary: true } });
    expect(temporaryResponse.status).toBe(201);
    const temporary = (await temporaryResponse.json() as { id: number }).id;
    const refused = await turn(temporary, `return await ox.goal.create({purpose:"Temporary write",title:"Temporary goal",outcome:"Must not persist"});`);
    expect(refused.prompts).toHaveLength(0);
    expect(refused.output).toContain("Temporary");
    expect((await api("/api/permissions", { method: "PUT", json: { scope: "action", id: "ox.goal.update", policy: "block" } })).status).toBe(200);
    const blocked = await turn(id, `return await ox.goal.update({purpose:"Blocked update",id:${JSON.stringify(goal.id)},expectedRevision:2,notes:"Must not overwrite"});`);
    expect(blocked.prompts).toHaveLength(0);
    expect((await read<{ notes: string }>(`/api/goals/${goal.id}`)).notes).toBe("A source was checked");
    expect((await api("/api/permissions", { method: "PUT", json: { scope: "action", id: "ox.goal.update", policy: null } })).status).toBe(200);
    const removed = await value(id, `return await ox.goal.delete({purpose:"Remove this goal",id:${JSON.stringify(goal.id)},expectedRevision:2});`, approve);
    conforms("ox.goal.delete", removed.result);
    expect(removed.result).toEqual({ deleted: true });
    await stopHost(); host = await startHost(true, false);
    const hidden = await value<{ available: boolean }>(await conversation(), `return {available:typeof ox.goal?.create==="function"};`);
    expect(hidden.result.available).toBe(false);
    expect(Object.keys(scriptContracts([])).some(name => name.startsWith("ox.goal."))).toBe(false);
  } finally { await stopHost(); host = await startHost(); }
}, 45_000);

test("Muse Library keeps original file identities and persistent Spaces across moves, deletion and explicit rebinding", async () => {
  await stopHost(); host = await startHost(true, true);
  try {
    const called = requests.length;
    expect((await api("/api/library?category=documents")).status).toBe(200);
    const put = (path: string, text: string, overwrite = false) => api(`/api/files/content?path=${encodeURIComponent(path)}${overwrite ? "&overwrite=1" : ""}`, { method: "PUT", body: text });
    const page = "artifacts/library-space.html", renamed = "artifacts/library-renamed.html";
    expect((await put(page, "<!doctype html><h1>Persistent artifact</h1>")).status).toBe(201);
    expect((await put("artifacts/library-note.md", "# A real document")).status).toBe(201);
    expect((await put("artifacts/library-second.md", "# Another real document")).status).toBe(201);
    expect((await put(`artifacts/${"x".repeat(237)}.md`, "An original-owner filename at the240-byte limit")).status).toBe(201);
    expect((await put(`artifacts/${"x".repeat(238)}.md`, "Beyond the original owner limit")).status).toBe(400);
    expect((await put("artifacts/library-image.svg", '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>')).status).toBe(201);
    expect((await put("artifacts/library-audio.wav", "controlled audio classification fixture")).status).toBe(201);
    type Item = { id: string; path: string | null; name: string; tagRevision: number };
    const documents = await read<{ items: Item[] }>("/api/library?category=documents");
    const audio = documents.items.find(item => item.path === "artifacts/library-audio.wav")!;
    expect(audio).toBeDefined();
    expect((await read<{ items: Item[] }>("/api/library?category=podcasts")).items.some(item => item.id === audio.id)).toBe(false);
    expect((await read<{ items: Item[] }>("/api/library?category=images")).items.some(item => item.path === "artifacts/library-image.svg")).toBe(true);
    expect((await read<{ items: Item[] }>("/api/library?category=system")).items.some(item => item.path === "MEMORY.md")).toBe(true);
    expect((await api(`/api/library/podcasts/${encodeURIComponent(audio.id)}`, { method: "PUT", json: { expectedRevision: 0, podcast: true } })).status).toBe(200);
    expect((await read<{ items: Item[] }>("/api/library?category=podcasts")).items.some(item => item.id === audio.id)).toBe(true);
    const draft = { name: "Persistent reference", entryPath: page };
    const create = () => api("/api/spaces", { method: "POST", headers: { "idempotency-key": "space-file-owner" }, json: draft });
    const created = await create();
    expect(created.status).toBe(201);
    type Space = { id: string; fileId: string; entryPath: string | null; revision: number; pinned: boolean; missing: boolean };
    let space = (await created.json() as { space: Space }).space;
    expect(space).toMatchObject({ entryPath: page, revision: 1, pinned: false, missing: false });
    expect((await read<{ spaces: Space[] }>("/api/spaces?pinned=true")).spaces).toEqual([]);
    expect((await api("/api/spaces?pinned=unknown")).status).toBe(400);
    expect((await api("/api/library?category=documents&pinned=true")).status).toBe(400);
    expect((await create()).status).toBe(200);
    expect((await read<{ items: Item[] }>("/api/library?category=documents")).items.some(item => item.path === page)).toBe(false);
    expect((await api("/api/files/move", { method: "POST", json: { from: page, to: renamed } })).status).toBe(200);
    space = await read<Space>(`/api/spaces/${space.id}`);
    expect(space.entryPath).toBe(renamed);
    const originalID = space.fileId;
    expect((await put(renamed, "<!doctype html><h1>Ordinary file update</h1>", true)).status).toBe(201);
    expect((await read<Space>(`/api/spaces/${space.id}`)).fileId).toBe(originalID);
    expect((await api(`/api/files?path=${encodeURIComponent(renamed)}`, { method: "DELETE" })).status).toBe(200);
    expect(await read(`/api/spaces/${space.id}`)).toMatchObject({ missing: true, entryPath: null, fileId: originalID });
    expect((await put(renamed, "<!doctype html><h1>Explicitly new file</h1>")).status).toBe(201);
    expect((await read<Space>(`/api/spaces/${space.id}`)).missing).toBe(true);
    const rebound = await api(`/api/spaces/${space.id}`, { method: "PATCH", json: { expectedRevision: 1, entryPath: renamed, pinned: true } });
    expect(rebound.status).toBe(200); space = await rebound.json() as Space;
    expect(space.fileId).not.toBe(originalID);
    expect(space).toMatchObject({ revision: 2, pinned: true, missing: false });
    expect((await read<{ spaces: Space[] }>("/api/spaces?pinned=true")).spaces.map(item => item.id)).toEqual([space.id]);
    expect((await api(`/api/spaces/${space.id}`, { method: "PATCH", json: { expectedRevision: 1, name: "Stale" } })).status).toBe(409);
    const one = await read<{ nextCursor: string | null }>("/api/library?category=documents&limit=1");
    expect(typeof one.nextCursor).toBe("string");
    expect((await put("artifacts/library-new.md", "A later file")).status).toBe(201);
    expect((await api(`/api/library?category=documents&limit=1&cursor=${encodeURIComponent(one.nextCursor!)}`)).status).toBe(409);
    for (const entryPath of ["../outside.html", "MEMORY.md", "app/private.html", "skills/private.html"]) {
      expect((await api("/api/spaces", { method: "POST", headers: { "idempotency-key": crypto.randomUUID() }, json: { name: "Refused", entryPath } })).status).toBe(400);
    }
    await stopHost(); host = await startHost(true, true);
    expect(await read(`/api/spaces/${space.id}`)).toEqual(space);
    expect((await api(`/api/spaces/${space.id}`, { method: "DELETE", json: { expectedRevision: 1 } })).status).toBe(409);
    expect((await api(`/api/spaces/${space.id}`, { method: "DELETE", json: { expectedRevision: 2 } })).status).toBe(200);
    expect((await create()).status).toBe(409);
    const remaining = await api(`/api/files/content?path=${encodeURIComponent(renamed)}`);
    expect(remaining.status).toBe(200); expect(await remaining.text()).toContain("Explicitly new file");
    expect(requests.length).toBe(called);
  } finally { await stopHost(); host = await startHost(); }
}, 45_000);

test("Muse Space and Library tools use approved metadata without widening file or temporary scope", async () => {
  await stopHost(); host = await startHost(true, true);
  try {
    const path = "artifacts/tool-space.html";
    expect((await api(`/api/files/content?path=${encodeURIComponent(path)}`, { method: "PUT", body: "<!doctype html><h1>Tool artifact</h1>" })).status).toBe(201);
    const id = await conversation();
    expect((await value<{ available: boolean }>(id, `return {available:typeof ox.space?.create==="function"};`)).result.available).toBe(true);
    const created = await value<{ space: { id: string; revision: number } }>(id,
      `return await ox.space.create({purpose:"Publish an existing artifact",name:"Tool space",entryPath:${JSON.stringify(path)}});`, approve);
    conforms("ox.space.create", created.result); expect(created.prompts).toHaveLength(1);
    const space = created.result.space;
    const listed = await value<{ spaces: { id: string }[] }>(id, `return await ox.space.list({purpose:"Inspect published spaces"});`, approve);
    conforms("ox.space.list", listed.result); expect(listed.prompts).toHaveLength(1);
    expect(listed.result.spaces.some(item => item.id === space.id)).toBe(true);
    const library = await value(id, `return await ox.library.list({purpose:"Inspect documents",category:"documents",limit:10});`, approve);
    conforms("ox.library.list", library.result); expect(library.prompts).toHaveLength(1);
    const audioPath = "artifacts/tool-podcast.wav";
    expect((await api(`/api/files/content?path=${encodeURIComponent(audioPath)}`, { method: "PUT", body: "controlled audio metadata fixture" })).status).toBe(201);
    const audio = (await read<{ items: { id: string; path: string | null }[] }>("/api/library?category=documents")).items.find(item => item.path === audioPath)!;
    const tagged = await value(id, `return await ox.library.tag({purpose:"Classify the explicit podcast artifact",fileId:${JSON.stringify(audio.id)},expectedRevision:0,podcast:true});`, approve);
    conforms("ox.library.tag", tagged.result); expect(tagged.prompts).toHaveLength(1);
    expect(tagged.result).toMatchObject({ fileId: audio.id, podcast: true, revision: 1 });
    const updated = await value(id, `return await ox.space.update({purpose:"Pin this Space",id:${JSON.stringify(space.id)},expectedRevision:1,pinned:true});`, approve);
    conforms("ox.space.update", updated.result); expect(updated.result).toMatchObject({ pinned: true, revision: 2 });
    const movedPath = "artifacts/tool-space-moved.html";
    await value(id, `return await ox.fs.move({purpose:"Move the same entry",from:${JSON.stringify(path)},to:${JSON.stringify(movedPath)}});`);
    const entry = await read<{ entryPath: string; fileId: string }>(`/api/spaces/${space.id}`);
    expect(entry.entryPath).toBe(movedPath);
    const declined = await turn(id, `return await ox.space.create({purpose:"Declined Space",name:"Must not exist",entryPath:${JSON.stringify(path)}});`, () => ({ answer: "Deny" }));
    expect(declined.prompts).toHaveLength(1);
    const temporary = (await (await api("/api/conversations", { method: "POST", json: { temporary: true } })).json() as { id: number }).id;
    const refused = await turn(temporary, `return await ox.space.create({purpose:"Temporary Space",name:"No persistent write",entryPath:${JSON.stringify(path)}});`);
    expect(refused.prompts).toHaveLength(0); expect(refused.output).toContain("Temporary");
    const removed = await value(id, `return await ox.space.delete({purpose:"Remove the registration",id:${JSON.stringify(space.id)},expectedRevision:2});`, approve);
    conforms("ox.space.delete", removed.result); expect(removed.result).toEqual({ deleted: true });
    expect((await api(`/api/files/content?path=${encodeURIComponent(movedPath)}`)).status).toBe(200);
    const keeperResponse = await api("/api/spaces", { method: "POST", headers: { "idempotency-key": "legacy-space-reference" },
      json: { name: "Default move reference check", entryPath: movedPath } });
    expect(keeperResponse.status).toBe(201);
    const keeper = (await keeperResponse.json() as { space: { id: string; revision: number } }).space;
    await stopHost(); host = await startHost(true, false);
    await value(await conversation(), `return await ox.fs.move({purpose:"Default move semantics",from:${JSON.stringify(movedPath)},to:"artifacts/tool-space-legacy.html"});`);
    const hidden = await value<{ available: boolean }>(await conversation(), `return {available:typeof ox.space?.create==="function"||typeof ox.library?.list==="function"};`);
    expect(hidden.result.available).toBe(false);
    expect(Object.keys(scriptContracts([])).some(name => /^ox\.(space|library)\./.test(name))).toBe(false);
    await stopHost(); host = await startHost(true, true);
    expect((await read<{ missing: boolean }>(`/api/spaces/${keeper.id}`)).missing).toBe(true);
    expect((await api(`/api/spaces/${keeper.id}`, { method: "DELETE", json: { expectedRevision: keeper.revision } })).status).toBe(200);
  } finally { await stopHost(); host = await startHost(); }
}, 45_000);

type SPSpace = { id: string; fileId: string; entryPath: string; revision: number; pinned: boolean; placement?: string; order?: number };
type SPData = { fileId: string; path: string; sourceRevision: string; revision: number; data: { notes: string; items: { id: string; text: string; checked: boolean }[] }; updatedAt: string | null; source: unknown };
const spDocument = () => ({ version: 1, revision: 0, data: { notes: "", items: [] }, receipts: [], updatedAt: null, source: null });
async function spJSON<T = any>(response: Response, status = 200): Promise<T> {
  const body = await response.text();
  expect({ status: response.status, error: response.status === status ? "" : body }).toEqual({ status, error: "" });
  return JSON.parse(body);
}
async function spFixture(work: () => Promise<void>) {
  await stopHost(); host = await startHost(true, true);
  try { await work(); } finally { await stopHost(); host = await startHost(); }
}
async function spSpace(label: string) {
  const path = `artifacts/sp-${label}.html`, dataPath = `artifacts/sp-${label}.json`;
  await spJSON(await api(`/api/files/content?path=${encodeURIComponent(path)}`, { method: "PUT", body: `<!doctype html><title>${label}</title><h1>Original SP ${label}</h1>` }), 201);
  await spJSON(await api(`/api/files/content?path=${encodeURIComponent(dataPath)}`, { method: "PUT", body: JSON.stringify(spDocument()) }), 201);
  const { space } = await spJSON<{ space: SPSpace }>(await api("/api/spaces", { method: "POST", headers: { "idempotency-key": crypto.randomUUID() },
    json: { name: `SP ${label}`, entryPath: path } }), 201);
  const resources = await spJSON(await api(`/api/spaces/${space.id}/resources`));
  const file = (await read<{ items: { id: string; path: string; sha256: string }[] }>("/api/library?category=documents&limit=100")).items.find(item => item.path === dataPath)!;
  expect(file).toBeDefined();
  return { space, path, dataPath, file, entrySha256: resources.entry.sha256 };
}
async function spGrant(fixture: Awaited<ReturnType<typeof spSpace>>, access = "readWrite") {
  const { space, file, entrySha256 } = fixture;
  const result = await spJSON(await api(`/api/spaces/${space.id}/data/default`, { method: "PUT",
    json: { expectedRevision: space.revision, fileId: file.id, sourceRevision: file.sha256, entrySha256, access, confirm: true } }));
  fixture.space = result;
  return result;
}
const spWrite = (id: string, snapshot: SPData, data: SPData["data"], requestId = crypto.randomUUID()) => api(`/api/spaces/${id}/data/default/write`, {
  method: "POST", json: { sourceRevision: snapshot.sourceRevision, requestId, data, confirm: true },
});
async function spOpening(path: string) {
  const response = await api(`/api/files/frame?path=${encodeURIComponent(path)}`);
  expect(response.status).toBe(200);
  const source = /source:"([a-f0-9-]{36})"/.exec(await response.text())?.[1];
  expect(source).toBeDefined(); return source!;
}
async function spOutcome(response: Response) {
  expect(response.status).toBe(200); return JSON.parse((await response.text()).trim().split("\n").at(-1)!) as any;
}
async function spPage(path: string, source: string | undefined, session: string, name: string, args: object, answer = "Approve") {
  let outcome = await spOutcome(await api("/api/canvas/call", { method: "POST", json: { session, path, source, function: name, arguments: args } }));
  for (let count = 0; outcome.interaction && count < 8; count++) outcome = await spOutcome(await api("/api/canvas/answer", {
    method: "POST", json: { session, interaction: outcome.interaction.id, answer },
  }));
  return outcome;
}

test("Muse Spaces SP-01 projects original sidebar main hidden order and zoned weekday date cross-midnight DST visibility without work", async () => spFixture(async () => {
  const called = requests.length;
  const first = await spSpace("placement"), second = await spSpace("ordering");
  const patch = (item: SPSpace, fields: object) => api(`/api/spaces/${item.id}`, { method: "PATCH", json: { expectedRevision: item.revision, ...fields } });
  first.space = await spJSON(await patch(first.space, { placement: "main", order: 4, visibility: { timeZone: "America/Los_Angeles",
    windows: [{ weekdays: [2], start: "22:00", end: "02:00", from: "2026-11-02", until: "2026-11-09" }] } }));
  second.space = await spJSON(await patch(second.space, { placement: "sidebar", order: 1 }));
  const navigation = async (at: string) => spJSON(await api(`/api/spaces/navigation?at=${encodeURIComponent(at)}`));
  expect((await navigation("2026-11-03T07:00:00Z")).main.map((item: SPSpace) => item.id)).toContain(first.space.id);
  expect((await navigation("2026-11-03T09:59:00Z")).main.map((item: SPSpace) => item.id)).toContain(first.space.id);
  expect((await navigation("2026-11-03T10:00:00Z")).main.map((item: SPSpace) => item.id)).not.toContain(first.space.id);
  expect((await navigation("2026-11-17T07:00:00Z")).main.map((item: SPSpace) => item.id)).not.toContain(first.space.id);
  first.space = await spJSON(await patch(first.space, { visibility: { timeZone: "America/Los_Angeles", windows: [{ weekdays: [1], start: "01:00", end: "02:00" }] } }));
  for (const at of ["2026-11-01T08:30:00Z", "2026-11-01T09:30:00Z"]) expect((await navigation(at)).main.some((item: SPSpace) => item.id === first.space.id)).toBe(true);
  expect((await patch(first.space, { visibility: { timeZone: "bad/zone", windows: [] } })).status).toBe(400);
  first.space = await spJSON(await patch(first.space, { pinned: true }));
  expect(first.space).toMatchObject({ pinned: true, placement: "sidebar" });
  second.space = await spJSON(await patch(second.space, { placement: "hidden" }));
  expect((await navigation("2026-11-01T08:30:00Z")).sidebar.some((item: SPSpace) => item.id === second.space.id)).toBe(false);
  expect((await read<{ spaces: SPSpace[] }>("/api/spaces")).spaces.some(item => item.id === second.space.id)).toBe(true);
  await stopHost(); host = await startHost(true, true);
  expect(await read(`/api/spaces/${second.space.id}`)).toEqual(second.space);
  expect(requests.length).toBe(called);
}), 45_000);

test("Muse Spaces SP-02 persist original notes checklist CAS receipts peer conflict and historical proof across reload", async () => spFixture(async () => {
  const fixture = await spSpace("data"), called = requests.length;
  await spGrant(fixture);
  const readData = async () => spJSON<SPData>(await api(`/api/spaces/${fixture.space.id}/data/default/read`));
  const a = await readData(), b = await readData(), requestId = crypto.randomUUID();
  const data = { notes: "Persistent owner notes 中文", items: [{ id: crypto.randomUUID(), text: "Actual checked item", checked: true }] };
  const saved = await spJSON(await spWrite(fixture.space.id, a, data, requestId));
  expect(saved).toMatchObject({ inputApplied: true, historical: false, snapshot: { revision: 1, data } });
  expect((await spWrite(fixture.space.id, b, { ...data, notes: "Must not replace peer" })).status).toBe(409);
  const proof = await spJSON(await api(`/api/spaces/${fixture.space.id}/data/default/requests/${requestId}`));
  expect(proof).toMatchObject({ inputApplied: true, revision: 1 });
  const replay = await spJSON(await spWrite(fixture.space.id, a, data, requestId));
  expect(replay).toMatchObject({ inputApplied: true, historical: true });
  expect((await spWrite(fixture.space.id, a, { ...data, notes: "Different input" }, requestId)).status).toBe(409);
  const next = await readData();
  await spJSON(await spWrite(fixture.space.id, next, { ...data, notes: "A later deliberate save" }));
  expect(await spJSON(await api(`/api/spaces/${fixture.space.id}/data/default/requests/${requestId}`))).toMatchObject({ inputApplied: false, revision: 1 });
  await stopHost(); host = await startHost(true, true);
  expect((await readData()).data.notes).toBe("A later deliberate save");
  const original = JSON.parse(await (await api(`/api/files/content?path=${encodeURIComponent(fixture.dataPath)}`)).text());
  expect(original.receipts).toHaveLength(2); expect(original.revision).toBe(2);
  expect(requests.length).toBe(called);
}), 45_000);

test("Muse Spaces SP-05 refuse malformed private foreign stale code moved alias delete recreate and actual IO failures without mutation", async () => spFixture(async () => {
  const fixture = await spSpace("boundaries"), peer = await spSpace("foreign");
  await spGrant(fixture);
  const readData = () => api(`/api/spaces/${fixture.space.id}/data/default/read`);
  const before = await spJSON<SPData>(await readData());
  expect((await api(`/api/spaces/${peer.space.id}/data/default/read`)).status).toBe(403);
  expect((await spWrite(fixture.space.id, before, { notes: "x", items: [{ id: "forged", text: "x", checked: true }] })).status).toBe(400);
  const resources = await spJSON(await api(`/api/spaces/${fixture.space.id}/resources`));
  for (const fileId of ["MEMORY.md", "../private", peer.space.fileId, "file-not-in-owner.json"]) {
    expect((await api(`/api/spaces/${fixture.space.id}/data/other`, { method: "PUT", json: { expectedRevision: fixture.space.revision, fileId,
      sourceRevision: fixture.file.sha256, entrySha256: resources.entry.sha256, access: "readWrite", confirm: true } })).status).not.toBe(200);
  }
  const content = profilePath("files", fixture.dataPath), directory = join(content, "..");
  const uncertain = crypto.randomUUID();
  await chmod(directory, 0o500);
  try {
    const response = await spWrite(fixture.space.id, before, { notes: "Original journal publication recovered", items: [] }, uncertain);
    expect(response.status).toBe(503); expect(await response.text()).toContain("could not be verified");
  } finally { await chmod(directory, 0o700); }
  const recovered = await spJSON<SPData>(await readData());
  expect(recovered).toMatchObject({ revision: 1, data: { notes: "Original journal publication recovered" } });
  expect(await spJSON(await api(`/api/spaces/${fixture.space.id}/data/default/requests/${uncertain}`))).toMatchObject({ revision: 1, inputApplied: true });
  expect((await api(`/api/files/content?path=${encodeURIComponent(fixture.path)}&overwrite=1`, { method: "PUT", body: "<!doctype html><title>Changed code</title>" })).status).toBe(201);
  expect((await readData()).status).toBe(403);
  expect((await api(`/api/files?path=${encodeURIComponent(fixture.dataPath)}`, { method: "DELETE" })).status).toBe(200);
  await spJSON(await api(`/api/files/content?path=${encodeURIComponent(fixture.dataPath)}`, { method: "PUT", body: JSON.stringify(spDocument()) }), 201);
  expect((await readData()).status).toBe(403);
}), 45_000);

test("Muse Spaces SP-04 creates only paused original schedules with real bound entry data identity and rejects forged or missing bindings", async () => spFixture(async () => {
  const fixture = await spSpace("scheduled"), called = requests.length;
  await spGrant(fixture);
  const draft = { name: "SP original bound update", prompt: "Update only the explicitly granted notes slot.", recurrence: { type: "interval", seconds: 86400 },
    space: { id: fixture.space.id, slot: "default", expectedRevision: fixture.space.revision, entrySha256: fixture.entrySha256 } };
  const created = await spJSON(await api("/api/schedules", { method: "POST", headers: { "idempotency-key": crypto.randomUUID() }, json: draft }), 201);
  expect(created.schedule).toMatchObject({ state: "paused", space: { id: fixture.space.id, fileId: fixture.space.fileId, dataFileId: fixture.file.id } });
  expect((await api("/api/schedules", { method: "POST", headers: { "idempotency-key": crypto.randomUUID() },
    json: { ...draft, space: { ...draft.space, dataFileId: fixture.file.id } } })).status).toBe(400);
  expect((await api(`/api/schedules/${created.schedule.id}/run`, { method: "POST", json: {} })).status).toBe(200);
  const rows = await until(() => read<{ schedules: any[] }>("/api/schedules"), state => state.schedules.find(row => row.id === created.schedule.id)?.lastOutcome);
  expect(rows.schedules.find(row => row.id === created.schedule.id)).toMatchObject({ state: "paused", lastOutcome: "failed" });
  expect(requests.length).toBe(called);
  expect((await api(`/api/schedules/${created.schedule.id}`, { method: "DELETE" })).status).toBe(200);
}), 45_000);

test("Muse Spaces SP-02 trusted original frame calls persist two-client CAS and reject forged cross-Space and first-call old-code authority", async () => spFixture(async () => {
  const fixture = await spSpace("frames"); await spGrant(fixture);
  const first = crypto.randomUUID(), second = crypto.randomUUID(), unused = await spOpening(fixture.path), a = await spOpening(fixture.path), b = await spOpening(fixture.path);
  const args = { purpose: "Read the explicitly granted source", slot: "default" };
  const readA = await spPage(fixture.path, a, first, "ox.space.data.read", args), readB = await spPage(fixture.path, b, second, "ox.space.data.read", args);
  expect(readA.ok).toBe(true); expect(readB.value).toEqual(readA.value);
  const input = { ...args, requestId: crypto.randomUUID(), sourceRevision: readA.value.sourceRevision, data: { notes: "Actual frame commit", items: [] } };
  expect((await spPage(fixture.path, a, first, "ox.space.data.write", input)).value).toMatchObject({ inputApplied: true });
  expect((await spPage(fixture.path, b, second, "ox.space.data.write", { ...input, requestId: crypto.randomUUID(), data: { notes: "Stale second frame", items: [] } })).error.code).toBe("conflict");
  expect((await spPage(fixture.path, b, second, "ox.space.data.read", { ...args, spaceId: crypto.randomUUID() })).error.code).toBe("invalid_argument");
  const noOpening = crypto.randomUUID();
  expect((await spPage(fixture.path, undefined, noOpening, "ox.space.data.read", args)).error.code).toBe("permission_denied");
  await spJSON(await api(`/api/spaces/${fixture.space.id}`, { method: "PATCH", json: { expectedRevision: fixture.space.revision, placement: "hidden" } }));
  expect((await spPage(fixture.path, a, first, "ox.space.data.read", args)).value.data.notes).toBe("Actual frame commit");
  await api(`/api/files/content?path=${encodeURIComponent(fixture.path)}&overwrite=1`, { method: "PUT", body: "<!doctype html><title>New code cannot inherit a frame grant</title>" });
  expect((await spPage(fixture.path, unused, crypto.randomUUID(), "ox.space.data.read", args)).error.code).toBe("permission_denied");
  for (const session of [first, second, noOpening]) await api("/api/canvas/close", { method: "POST", json: { session } });
}), 45_000);

test("Muse Spaces SP-04 original scheduled submission proves only its own actual file commit and stale bindings fail before model", async () => spFixture(async () => {
  const fixture = await spSpace("commit-proof"); await spGrant(fixture);
  for (const action of ["ox.space.data.read", "ox.space.data.write"]) await spJSON(await api("/api/permissions", { method: "PUT", json: { scope: "action", id: action, policy: "allow" } }));
  const updateId = crypto.randomUUID(), source = `const s=await ox.space.data.read({purpose:"Read bound scheduled source",slot:"default"});return await ox.space.data.write({purpose:"Commit a real scheduled update",slot:"default",requestId:${JSON.stringify(updateId)},sourceRevision:s.sourceRevision,data:{notes:"Real scheduled source commit",items:[]}});`;
  const create = async (prompt: string) => {
    const result = await spJSON(await api("/api/schedules", { method: "POST", headers: { "idempotency-key": crypto.randomUUID() }, json: {
      name: "SP real scheduled publication", prompt, recurrence: { type: "interval", seconds: 86400 },
      space: { id: fixture.space.id, slot: "default", expectedRevision: fixture.space.revision, entrySha256: fixture.entrySha256 },
    } }), 201);
    await spJSON(await api("/api/permissions", { method: "PUT", json: { scope: "action", id: `ox.schedule.execute:${result.schedule.id}`, policy: "allow" } }));
    return result.schedule.id as string;
  };
  const run = async (id: string) => {
    const previous = (await read<{ schedules: any[] }>("/api/schedules")).schedules.find(row => row.id === id)?.lastRunAt;
    await spJSON(await api(`/api/schedules/${id}/run`, { method: "POST", json: {} }));
    const state = await until(() => read<{ schedules: any[] }>("/api/schedules"), state => {
      const current = state.schedules.find(row => row.id === id); return current?.lastRunAt && current.lastRunAt !== previous && current.state !== "running";
    });
    return state.schedules.find(row => row.id === id);
  };
  const committed = await create(script(source)), noCommit = await create("Only say updated, without writing any file.");
  try {
    const saved = await run(committed);
    expect(saved).toMatchObject({ state: "active", lastOutcome: "succeeded", lastCommit: { fileId: fixture.file.id, requestId: updateId, revision: 1 } });
    expect((await spJSON<SPData>(await api(`/api/spaces/${fixture.space.id}/data/default/read`))).data.notes).toBe("Real scheduled source commit");
    const claimed = await run(noCommit);
    expect(claimed).toMatchObject({ state: "paused", lastOutcome: "failed", lastCommit: null }); expect(claimed.lastError).toContain("no original Space data commit");
    const called = requests.length;
    await api(`/api/files/content?path=${encodeURIComponent(fixture.path)}&overwrite=1`, { method: "PUT", body: "<!doctype html><title>Changed bound code</title>" });
    expect((await run(committed)).lastOutcome).toBe("failed"); expect(requests.length).toBe(called);
  } finally { for (const id of [committed, noCommit]) await api(`/api/schedules/${id}`, { method: "DELETE" }); }
}), 60_000);

test("Muse Spaces SP-05 original pending page writes block Reset and close or old epoch cannot publish later", async () => dataControlsFixture(async () => {
  const fixture = await spSpace("epoch"); await spGrant(fixture);
  const snapshot = await spJSON<SPData>(await api(`/api/spaces/${fixture.space.id}/data/default/read`));
  await spJSON(await api("/api/permissions", { method: "PUT", json: { scope: "action", id: `ox.space.bridge:${fixture.space.id}`, policy: "allow" } }));
  const session = crypto.randomUUID(), opening = await spOpening(fixture.path), requestId = crypto.randomUUID();
  const outcome = await spOutcome(await api("/api/canvas/call", { method: "POST", json: { session, path: fixture.path, source: opening, function: "ox.space.data.write",
    arguments: { purpose: "Pending original write", slot: "default", requestId, sourceRevision: snapshot.sourceRevision, data: { notes: "Must not publish", items: [] } } } }));
  expect(outcome.interaction.kind).toBe("approval");
  expect((await api("/api/data-controls/resets", { method: "POST", json: { requestId: crypto.randomUUID() } })).status).toBe(409);
  await spJSON(await api("/api/canvas/close", { method: "POST", json: { session } }));
  await Bun.sleep(100);
  expect((await api("/api/canvas/answer", { method: "POST", json: { session, interaction: outcome.interaction.id, answer: "Approve" } })).status).toBe(409);
  expect((await spJSON<SPData>(await api(`/api/spaces/${fixture.space.id}/data/default/read`))).sourceRevision).toBe(snapshot.sourceRevision);
  const prepared = await dcPrepare();
  await spJSON(await dcConfirm(prepared));
  expect((await api("/api/canvas/call", { method: "POST", headers: { "x-openox-content-epoch": "0" },
    json: { session: crypto.randomUUID(), path: fixture.path, source: opening, function: "ox.space.data.read", arguments: { purpose: "Old frame", slot: "default" } } })).status).toBe(409);
}), 45_000);

test("Muse Spaces SP-05 original read Deny also protects owner commit proofs", async () => spFixture(async () => {
  const fixture = await spSpace("proof-deny"); await spGrant(fixture);
  const snapshot = await spJSON<SPData>(await api(`/api/spaces/${fixture.space.id}/data/default/read`)), requestId = crypto.randomUUID();
  await spJSON(await spWrite(fixture.space.id, snapshot, { notes: "Proof subject", items: [] }, requestId));
  await spJSON(await api("/api/permissions", { method: "PUT", json: { scope: "action", id: "ox.space.data.read", policy: "block" } }));
  try {
    expect((await api(`/api/spaces/${fixture.space.id}/data/default/read`)).status).toBe(403);
    expect((await api(`/api/spaces/${fixture.space.id}/data/default/requests/${requestId}`)).status).toBe(403);
  } finally { await api("/api/permissions", { method: "PUT", json: { scope: "action", id: "ox.space.data.read", policy: "ask" } }); }
}), 45_000);

test("Muse Spaces SP-05 original data aliases cannot retain grants after relocation into a private app namespace", async () => spFixture(async () => {
  const fixture = await spSpace("moved-private"); await spGrant(fixture);
  await spJSON(await api("/api/files/move", { method: "POST", json: { from: fixture.dataPath, to: "app/sp-private.json" } }));
  expect((await api(`/api/spaces/${fixture.space.id}/data/default/read`)).status).toBe(403);
}), 45_000);

test("Muse Spaces SP-05 typed validation limits and unavailable original data are not peer conflict or uncertain publication", async () => spFixture(async () => {
  const fixture = await spSpace("typed-failure"); await spGrant(fixture);
  const snapshot = await spJSON<SPData>(await api(`/api/spaces/${fixture.space.id}/data/default/read`));
  const response = await spWrite(fixture.space.id, snapshot, { notes: "界".repeat(22000), items: [] });
  expect(response.status).toBe(409); expect(await response.json()).toHaveProperty("code", "limit_exceeded");
  expect((await spJSON<SPData>(await api(`/api/spaces/${fixture.space.id}/data/default/read`))).sourceRevision).toBe(snapshot.sourceRevision);
}), 45_000);

test("Muse Spaces SP-05 duplicate checklist identities are invalid input before any original file publication", async () => spFixture(async () => {
  const fixture = await spSpace("duplicate-items"); await spGrant(fixture);
  const snapshot = await spJSON<SPData>(await api(`/api/spaces/${fixture.space.id}/data/default/read`)), id = crypto.randomUUID();
  const response = await spWrite(fixture.space.id, snapshot, { notes: "", items: [{ id, text: "First", checked: false }, { id, text: "Other", checked: true }] });
  expect(response.status).toBe(400); expect(await response.json()).toHaveProperty("code", "invalid_argument");
  expect((await spJSON<SPData>(await api(`/api/spaces/${fixture.space.id}/data/default/read`))).sourceRevision).toBe(snapshot.sourceRevision);
}), 45_000);

test("Muse Spaces SP-04 an explicit owner pause stops the original running update without a false failed or successful file claim", async () => spFixture(async () => {
  const fixture = await spSpace("owner-stop"); await spGrant(fixture);
  for (const action of ["ox.space.data.read", "ox.space.data.write"]) await spJSON(await api("/api/permissions", { method: "PUT", json: { scope: "action", id: action, policy: "allow" } }));
  const before = await spJSON<SPData>(await api(`/api/spaces/${fixture.space.id}/data/default/read`));
  const taskSource = `const s=await ox.space.data.read({purpose:"Read bound stop fixture",slot:"default"});return await ox.space.data.write({purpose:"Must not write after stop",slot:"default",requestId:${JSON.stringify(crypto.randomUUID())},sourceRevision:s.sourceRevision,data:{notes:"Must not commit",items:[]}});`;
  const created = await spJSON(await api("/api/schedules", { method: "POST", headers: { "idempotency-key": crypto.randomUUID() }, json: {
    name: "SP explicitly stopped update", prompt: `${script(taskSource)} slow-run`,
    recurrence: { type: "interval", seconds: 86400 }, space: { id: fixture.space.id, slot: "default", expectedRevision: fixture.space.revision, entrySha256: fixture.entrySha256 },
  } }), 201);
  const id = created.schedule.id, called = requests.length;
  await spJSON(await api("/api/permissions", { method: "PUT", json: { scope: "action", id: `ox.schedule.execute:${id}`, policy: "allow" } }));
  try {
    await spJSON(await api(`/api/schedules/${id}/run`, { method: "POST", json: {} }));
    await until(async () => requests.length, count => count > called);
    await spJSON(await api(`/api/schedules/${id}`, { method: "PUT", json: { enabled: false } }));
    const finished = await until(() => read<{ schedules: any[] }>("/api/schedules"), state => state.schedules.find(row => row.id === id)?.lastRunAt);
    expect(finished.schedules.find(row => row.id === id)).toMatchObject({ state: "paused", lastOutcome: "cancelled", lastCommit: null });
    expect((await spJSON<SPData>(await api(`/api/spaces/${fixture.space.id}/data/default/read`))).sourceRevision).toBe(before.sourceRevision);
  } finally { await api(`/api/schedules/${id}`, { method: "DELETE" }); }
}), 45_000);

test("Muse Feed and Ideas keep source-labelled publications, prompt revisions and owner choices across restart", async () => {
  await stopHost(); host = await startHost(true, true);
  try {
    const called = requests.length;
    const initial = await api("/api/feed");
    expect(initial.status).toBe(200);
    const prompt = (await initial.json() as { prompt: { text: string; revision: number } }).prompt;
    expect(typeof prompt.text).toBe("string");
    const savedPrompt = await api("/api/feed/prompt", { method: "PATCH", json: { expectedRevision: prompt.revision, text: "Keep a concise feed with explicit sources." } });
    expect({ status: savedPrompt.status, body: await savedPrompt.json() }).toMatchObject({ status: 200 });
    expect((await api("/api/feed/prompt", { method: "PATCH", json: { expectedRevision: prompt.revision, text: "Stale overwrite" } })).status).toBe(409);
    expect((await read<{ items: unknown[] }>("/api/ideas")).items).toEqual([]);
    expect(requests).toHaveLength(called);
    const id = await conversation();
    const feed = await value<{ items: { id: string; revision: number; loved: boolean; hidden: boolean; name: string; sources: { url: string }[] }[] }>(id,
      `return await ox.feed.publish({purpose:"Save the bounded source update",items:[{name:"A checked fixture topic",body:"Source-labelled, not independently verified.",icon:"🗂️",sources:[{name:"Fixture source",url:"https://example.com/update#section"}]}]});`, approve);
    conforms("ox.feed.publish", feed.result); expect(feed.prompts).toHaveLength(1);
    const item = feed.result.items[0]!;
    expect(item.sources[0]!.url).toBe("https://example.com/update#section");
    expect((await api(`/api/feed/items/${item.id}`, { method: "PATCH", json: { expectedRevision: item.revision, loved: true } })).status).toBe(200);
    const duplicate = await value(id, `return await ox.feed.publish({purpose:"Update the same source, not the owner choice",items:[{name:"A checked fixture topic",body:"Updated source-labelled note.",icon:"🗂️",sources:[{name:"Fixture source",url:"https://example.com/update"}]}]});`, approve);
    conforms("ox.feed.publish", duplicate.result);
    const loved = (await read<{ items: { id: string; revision: number; loved: boolean }[] }>("/api/feed")).items.find(row => row.id === item.id)!;
    expect(loved.loved).toBe(true);
    expect((await read<{ items: unknown[] }>("/api/feed")).items).toHaveLength(1);
    expect((await api(`/api/feed/items/${item.id}`, { method: "PATCH", json: { expectedRevision: item.revision, loved: false } })).status).toBe(409);
    const idea = await value<{ items: { id: string; revision: number }[] }>(id,
      `return await ox.idea.publish({purpose:"Propose an actual next action",items:[{name:"Prepare a plan",body:"An actionable suggestion, not a Goal.",icon:"💡",action:"Help me prepare a bounded plan."}]});`, approve);
    conforms("ox.idea.publish", idea.result);
    expect((await api(`/api/ideas/items/${idea.result.items[0]!.id}`, { method: "PATCH", json: { expectedRevision: 1, hidden: true } })).status).toBe(200);
    expect((await read<{ items: unknown[] }>("/api/ideas")).items).toEqual([]);
    const invalid = await turn(id, `return await ox.feed.publish({purpose:"Refuse credential-bearing URLs",items:[{name:"Unsafe source",body:"Do not save",icon:"!",sources:[{name:"Unsafe",url:"https://user:password@example.com"}]}]});`, approve);
    expect(invalid.output).toContain("invalid_argument");
    await stopHost(); host = await startHost(true, true);
    expect((await read<{ items: { loved: boolean }[] }>("/api/feed")).items[0]!.loved).toBe(true);
    expect((await read<{ items: unknown[] }>("/api/ideas")).items).toEqual([]);
  } finally { await stopHost(); host = await startHost(true, false); }
}, 60_000);

test("Muse Feed generation shares one original Side receipt and approved tools stay hidden or refused in temporary contexts", async () => {
  await stopHost(); host = await startHost(true, true);
  try {
    const namespace = await value<{ available: boolean }>(await conversation(), `return {available:typeof ox.feed?.publish==="function"&&typeof ox.idea?.publish==="function"};`);
    expect(namespace.result.available).toBe(true);
    expect((await api("/api/feed/generate", { method: "POST", json: {} })).status).toBe(400);
    const prompt = (await read<{ prompt: { revision: number } }>("/api/feed")).prompt;
    const mainBefore = (await read<{ id: number | null }>("/api/conversations/main")).id;
    const generate = () => api("/api/feed/generate", { method: "POST", headers: { "idempotency-key": "feed-generation-receipt" }, json: { expectedRevision: prompt.revision } });
    const pair = await Promise.all([generate(), generate()]);
    expect(pair.map(response => response.status).sort()).toEqual([200, 202]);
    type Generation = { id: string; conversationId: number; status: string };
    const records = await Promise.all(pair.map(async response => (await response.json() as { generation: Generation }).generation));
    expect(records[0]!.id).toBe(records[1]!.id); expect(records[0]!.conversationId).toBe(records[1]!.conversationId);
    expect((await read<{ id: number | null }>("/api/conversations/main")).id).toBe(mainBefore);
    const view = await until(() => read<View>(`/api/conversations/${records[0]!.conversationId}`), view => !view.busy || !!view.pendingPrompt);
    if (view.pendingPrompt) expect((await api(`/api/conversations/${records[0]!.conversationId}/respond`, { method: "POST",
      json: { promptId: view.pendingPrompt.id, answer: "Approve" } })).status).toBe(200);
    await until(() => read<View>(`/api/conversations/${records[0]!.conversationId}`), view => !view.busy);
    expect((await read<Generation>(`/api/feed/generations/${records[0]!.id}`)).status).toBe("completed");
    expect((await generate()).status).toBe(200);
    const temporary = await api("/api/conversations", { method: "POST", json: { temporary: true } });
    const scratch = (await temporary.json() as { id: number }).id;
    const refused = await turn(scratch, `return await ox.idea.publish({purpose:"No persistent temporary proposal",items:[{name:"Refused",body:"No save",icon:"!",action:"Do not save."}]});`);
    expect(refused.prompts).toHaveLength(0); expect(refused.output).toContain("Temporary");
    await stopHost(); host = await startHost(true, false);
    const hidden = await value<{ available: boolean }>(await conversation(), `return {available:typeof ox.feed?.publish==="function"||typeof ox.idea?.publish==="function"};`);
    expect(hidden.result.available).toBe(false);
    expect(Object.keys(scriptContracts([])).some(name => /^ox\.(feed|idea)\./.test(name))).toBe(false);
    expect(await read("/api/feed")).toEqual({ available: false });
  } finally { await stopHost(); host = await startHost(true, false); }
}, 60_000);

test("Muse Feed generation distinguishes no updates, missing publication, cancellation, restart and unavailable models", async () => {
  await stopHost(); host = await startHost(true, true);
  try {
    const start = async (text: string, key: string) => {
      const before = (await read<{ prompt: { revision: number } }>("/api/feed")).prompt;
      const prompt = await api("/api/feed/prompt", { method: "PATCH", json: { expectedRevision: before.revision, text } });
      expect(prompt.status).toBe(200);
      const revision = (await prompt.json() as { revision: number }).revision;
      const response = await api("/api/feed/generate", { method: "POST", headers: { "idempotency-key": key }, json: { expectedRevision: revision } });
      expect(response.status).toBe(202);
      return (await response.json() as { generation: { id: string; conversationId: number } }).generation;
    };
    const finish = async (id: number) => {
      let view = await until(() => read<View>(`/api/conversations/${id}`), view => !view.busy || !!view.pendingPrompt);
      if (view.pendingPrompt) expect((await api(`/api/conversations/${id}/respond`, { method: "POST", json: { promptId: view.pendingPrompt.id, answer: "Approve" } })).status).toBe(200);
      view = await until(() => read<View>(`/api/conversations/${id}`), view => !view.busy);
      return view;
    };
    const empty = await start("FI no updates", "feed-no-updates");
    await finish(empty.conversationId);
    expect((await read<{ status: string }>(`/api/feed/generations/${empty.id}`)).status).toBe("noUpdate");
    const incomplete = await start("FI no publication", "feed-no-publication");
    await finish(incomplete.conversationId);
    expect((await read<{ status: string }>(`/api/feed/generations/${incomplete.id}`)).status).toBe("incomplete");
    const failed = await start("FI controlled failure", "feed-provider-failed");
    await finish(failed.conversationId);
    expect((await read<{ status: string }>(`/api/feed/generations/${failed.id}`)).status).toBe("failed");
    const held = await start("FI held generation", "feed-held-generation");
    await until(() => read<View>(`/api/conversations/${held.conversationId}`), view => view.busy && view.messages.some(message => message.role === "user"));
    expect((await api(`/api/feed/generations/${held.id}/stop`, { method: "POST" })).status).toBe(200);
    await finish(held.conversationId);
    expect(await read(`/api/feed/generations/${held.id}`)).toMatchObject({ status: "cancelled" });
    await stopHost();
    const called = requests.length;
    host = await startHost(true, true);
    expect((await read<{ status: string }>(`/api/feed/generations/${held.id}`)).status).toBe("cancelled");
    expect(requests).toHaveLength(called);
    expect((await api("/api/settings/providers/custom", { method: "DELETE" })).status).toBe(200);
    expect((await read<{ defaultModel: unknown }>("/api/settings")).defaultModel).toBeNull();
    const revision = (await read<{ prompt: { revision: number } }>("/api/feed")).prompt.revision;
    expect((await api("/api/feed/generate", { method: "POST", headers: { "idempotency-key": "feed-no-model" }, json: { expectedRevision: revision } })).status).toBe(503);
    expect((await read<{ generation: { id: string } }>("/api/feed")).generation.id).toBe(held.id);
    expect(requests).toHaveLength(called);
  } finally {
    expect((await api("/api/settings/providers/custom", { method: "PUT", json: { name: "Scripted", baseUrl: `http://127.0.0.1:${model.port}/v1`, models: ["fixture", "fixture-2"] } })).status).toBe(200);
    await stopHost(); host = await startHost(true, false);
  }
}, 60_000);

test("Muse Agent Identity keeps real SOUL context, avatar references and Workspace separation across restart", async () => {
  await stopHost(); host = await startHost(true, true);
  try {
    const initial = await api("/api/identity");
    expect(initial.status).toBe(200);
    type Identity = { agent: { name: string; revision: number; avatarPath: string | null }; soul: { text: string | null; revision: string; exists: boolean } };
    const before = await initial.json() as Identity, workspace = (await read<{ profile: { name: string } }>("/api/settings")).profile.name;
    expect(before.soul.exists).toBe(false);
    const renamed = await api("/api/identity", { method: "PATCH", json: { expectedRevision: before.agent.revision, name: "Owner's Agent" } });
    expect(renamed.status).toBe(200);
    expect((await read<{ profile: { name: string } }>("/api/settings")).profile.name).toBe(workspace);
    expect((await api("/api/identity", { method: "PATCH", json: { expectedRevision: before.agent.revision, name: "Stale" } })).status).toBe(409);
    const soul = "IA actual user-owned Agent stance marker. Distinguish evidence from assumptions.";
    const concurrent = await Promise.all([soul, "IA competing creator"].map(text => api("/api/identity/soul", {
      method: "PUT", json: { expectedSourceRevision: "missing", text },
    })));
    expect(concurrent.map(response => response.status).sort()).toEqual([200, 409]);
    const observed = (await read<Identity>("/api/identity")).soul;
    const created = await api("/api/identity/soul", { method: "PUT", json: { expectedSourceRevision: observed.revision, text: soul } });
    expect({ status: created.status, body: await created.json() }).toMatchObject({ status: 200 });
    const equal = await api("/api/identity/soul", { method: "PUT", json: { expectedSourceRevision: "missing", text: soul } });
    expect(equal.status).toBe(200);
    expect((await equal.json() as Identity["soul"]).text).toBe(soul);
    const main = (await (await api("/api/conversations/main", { method: "POST", json: {} })).json() as { id: number }).id;
    const mainCalls = requests.length;
    await value(main, `return {observed:"IA actual Main turn"};`);
    expect(requests.slice(mainCalls).every(request => request.system.includes(soul) && request.system.includes("Owner's Agent"))).toBe(true);
    const id = await conversation(), called = requests.length;
    await value(id, `return {observed:"IA context read through the real turn"};`);
    expect(requests.slice(called).some(request => request.system.includes(soul) && request.system.includes("Owner's Agent"))).toBe(true);
    const image = "artifacts/ia-avatar.svg";
    expect((await api(`/api/files/content?path=${encodeURIComponent(image)}`, { method: "PUT", body: '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"></svg>' })).status).toBe(201);
    const current = await read<Identity>("/api/identity");
    expect((await api("/api/identity", { method: "PATCH", json: { expectedRevision: current.agent.revision, avatarPath: image } })).status).toBe(200);
    expect((await api("/api/files/move", { method: "POST", json: { from: image, to: "artifacts/ia-avatar-moved.svg" } })).status).toBe(200);
    expect((await read<Identity>("/api/identity")).agent.avatarPath).toBe("artifacts/ia-avatar-moved.svg");
    const snapshot = (await read<Identity>("/api/identity")).soul;
    expect((await api("/api/files/text", { method: "PUT", json: { path: "SOUL.md", previous: soul, text: "IA peer original-owner edit" } })).status).toBe(200);
    expect((await api("/api/identity/soul", { method: "PUT", json: { expectedSourceRevision: snapshot.revision, text: "Must not overwrite" } })).status).toBe(409);
    expect((await read<Identity>("/api/identity")).soul.text).toBe("IA peer original-owner edit");
    await stopHost(); host = await startHost(true, true);
    const restored = await read<Identity>("/api/identity");
    expect(restored.agent.name).toBe("Owner's Agent"); expect(restored.soul.text).toBe("IA peer original-owner edit");
    await stopHost(); host = await startHost(true, false);
    const legacy = requests.length;
    await value(await conversation(), `return {observed:"IA old-context boundary"};`);
    expect(requests.slice(legacy).some(request => request.system.includes("IA peer original-owner edit") || request.system.includes("Owner's Agent"))).toBe(false);
    expect(await read("/api/identity")).toEqual({ available: false });
  } finally { await stopHost(); host = await startHost(true, false); }
}, 60_000);

test("Muse Agent Identity tools require actual approval and refuse temporary or disabled edits", async () => {
  await stopHost(); host = await startHost(true, true);
  try {
    const id = await conversation();
    const found = await value<{ available: boolean }>(id, `return {available:typeof ox.identity?.get==="function"&&typeof ox.identity?.setSoul==="function"};`);
    expect(found.result.available).toBe(true);
    const state = await value<{ agent: { revision: number }; soul: { revision: string } }>(id, `return await ox.identity.get({purpose:"Read the same real Agent"});`, approve);
    conforms("ox.identity.get", state.result);
    const changed = await value(id, `return await ox.identity.setSoul({purpose:"Set the explicit Agent guidance",expectedSourceRevision:${JSON.stringify(state.result.soul.revision)},text:"IA approved Agent guidance"});`, approve);
    conforms("ox.identity.setSoul", changed.result); expect(changed.prompts).toHaveLength(1);
    const denied = await turn(id, `return await ox.identity.update({purpose:"Do not change the Agent",expectedRevision:${state.result.agent.revision},name:"Denied Agent"});`, () => ({ answer: "Deny" }));
    expect(denied.prompts).toHaveLength(1);
    expect((await read<{ agent: { name: string } }>("/api/identity")).agent.name).not.toBe("Denied Agent");
    const temporary = await api("/api/conversations", { method: "POST", json: { temporary: true } });
    const scratch = (await temporary.json() as { id: number }).id;
    const refused = await turn(scratch, `return await ox.identity.update({purpose:"No persistent temporary identity",expectedRevision:1,name:"Refused Agent"});`);
    expect(refused.prompts).toHaveLength(0); expect(refused.output).toContain("Temporary");
    await stopHost(); host = await startHost(true, false);
    expect((await value<{ available: boolean }>(await conversation(), `return {available:typeof ox.identity?.get==="function"};`)).result.available).toBe(false);
  } finally { await stopHost(); host = await startHost(true, false); }
}, 60_000);

test("Muse approval history records real decisions without secret arguments or retroactive Allow-rule history", async () => {
  await stopHost(); host = await startHost(true, true);
  try {
    const response = await api("/api/approvals/history");
    expect(response.status).toBe(200);
    const before = (await response.json() as { records: unknown[] }).records.length;
    const id = await conversation(), marker = "IA-private-purpose-sk-not-a-real-key";
    const approved = await value(id, `return await ox.goal.list({purpose:${JSON.stringify(marker)}});`, approve);
    expect(approved.prompts).toHaveLength(1);
    const history = await read<{ records: { decision: string; action: string; conversationId: number | null; recordedAt: string }[] }>("/api/approvals/history");
    expect(history.records.length).toBe(before + 1);
    expect(history.records[0]).toMatchObject({ decision: "approved", action: "ox.goal.list", conversationId: id });
    expect(Number.isFinite(Date.parse(history.records[0]!.recordedAt))).toBe(true);
    expect(JSON.stringify(history)).not.toContain(marker);
    await turn(id, `return await ox.identity.get({purpose:"IA denied decision"});`, () => ({ answer: "Deny" }));
    expect((await read<{ records: { decision: string }[] }>("/api/approvals/history")).records[0]!.decision).toBe("denied");
    expect((await api(`/api/conversations/${id}/messages`, { method: "POST", json: {
      text: script(`return await ox.identity.get({purpose:"IA cancelled decision"});`),
    } })).status).toBe(202);
    await until(() => read<View>(`/api/conversations/${id}`), view => !!view.pendingPrompt);
    expect((await api(`/api/conversations/${id}/stop`, { method: "POST" })).status).toBe(200);
    await until(() => read<View>(`/api/conversations/${id}`), view => !view.busy);
    expect((await read<{ records: { decision: string }[] }>("/api/approvals/history")).records[0]!.decision).toBe("cancelled");
    await value(id, `return await ox.goal.list({purpose:"IA Always decision"});`, always);
    const unasked = await value(id, `return await ox.goal.list({purpose:"IA policy decision"});`);
    expect(unasked.prompts).toHaveLength(0);
    expect((await read<{ records: { decision: string }[] }>("/api/approvals/history")).records[0]!.decision).toBe("allowedByPolicy");
    expect((await api("/api/permissions", { method: "PUT", json: { scope: "action", id: "ox.goal.list", policy: "block" } })).status).toBe(200);
    const blocked = await turn(id, `return await ox.goal.list({purpose:"IA blocked decision"});`);
    expect(blocked.prompts).toHaveLength(0); expect(blocked.output).toContain("blocked");
    expect((await read<{ records: { decision: string }[] }>("/api/approvals/history")).records[0]!.decision).toBe("blockedByPolicy");
    expect((await api("/api/permissions", { method: "PUT", json: { scope: "action", id: "ox.goal.list", policy: null } })).status).toBe(200);
    await stopHost(); host = await startHost(true, true);
    expect((await read<{ records: unknown[] }>("/api/approvals/history")).records.length).toBe(before + 6);
    await stopHost(); host = await startHost(true, false);
    expect(await read("/api/approvals/history")).toEqual({ available: false });
  } finally { await stopHost(); host = await startHost(true, false); }
}, 60_000);

test("Muse approval history records original browser site gates with actual safe origins", async () => {
  await stopHost(); host = await startHost(true, true);
  const url = `http://127.0.0.1:${model.port}/watch-seed?private=IA-not-a-credential`;
  try {
    const id = await conversation(), before = (await read<{ total: number }>("/api/approvals/history")).total;
    const navigated = await turn(id, `await ox.web.browser.navigate({purpose:"IA original site gate",url:${JSON.stringify(url)}});
      return await ox.web.browser.getPageState({purpose:"IA inspect the controlled original page"});`, approve);
    expect(navigated.prompts).toHaveLength(2);
    const history = await read<{ records: ApprovalReceipt[]; total: number }>("/api/approvals/history");
    expect(history.total).toBe(before + 2);
    expect(history.records[0]).toMatchObject({ action: "browserAccess", decision: "approved", conversationId: id, source: new URL(url).origin });
    expect(history.records[1]).toMatchObject({ action: "browserAccess", decision: "approved", conversationId: id, source: new URL(url).origin });
    expect(JSON.stringify(history)).not.toContain("private=IA");
    expect((await api("/api/permissions", { method: "PUT", json: { scope: "action", id: "ox.web.browser:127.0.0.1", policy: "block" } })).status).toBe(200);
    const refused = await turn(await conversation(), `await ox.web.browser.navigate({purpose:"IA blocked site gate",url:${JSON.stringify(url)}});
      return await ox.web.browser.getPageState({purpose:"IA refuse the controlled page read"});`);
    expect(refused.prompts).toHaveLength(0); expect(refused.output).toContain("blocked");
    expect((await read<{ records: ApprovalReceipt[] }>("/api/approvals/history")).records[0]).toMatchObject({ action: "browserAccess", decision: "blockedByPolicy" });
  } finally {
    expect((await api("/api/permissions", { method: "PUT", json: { scope: "action", id: "ox.web.browser:127.0.0.1", policy: null } })).status).toBe(200);
    await stopHost(); host = await startHost(true, false);
  }
}, 60_000);

test("Muse approval history fails closed for full and corrupt receipts through both actual authorization paths", async () => {
  await stopHost(); host = await startHost(true, true);
  const id = await conversation(), todos = await read("/api/todos");
  await stopHost();
  const saved = await historyFixture(state => {
    state.records = {}; state.requests = {};
    for (let index = 0; index < 5_000; index++) {
      const receipt = crypto.randomUUID(), key = new Bun.CryptoHasher("sha256").update(`IA full ${index}`).digest("hex");
      state.records[receipt] = { id: receipt, action: "ox.identity.get", label: "Read Agent identity", source: null,
        decision: "approved", scope: "fallback", conversationId: id, origin: "conversation", recordedAt: new Date().toISOString() };
      state.requests[key] = { id: receipt, fingerprint: key };
    }
  });
  try {
    host = await startHost(true, true);
    expect((await read<{ total: number }>("/api/approvals/history")).total).toBe(5_000);
    const rejected = await turn(id, `return await ox.todo.create({purpose:"IA refuse an unrecorded mutation",title:"Must not exist"});`, approve);
    expect(rejected.output).toContain("history is full"); expect(await read("/api/todos")).toEqual(todos);
    const generic = await turn(id, `return await ox.provider.list({purpose:"IA refuse a built-in policy authorization"});`);
    expect(generic.prompts).toHaveLength(0); expect(generic.output).toContain("history is full");
    const policy = await turn(id, `return await ox.identity.get({purpose:"IA Always must not survive failed audit"});`, always);
    expect(policy.output).toContain("history is full");
    const allowed = await turn(id, `return await ox.identity.get({purpose:"IA retry is still refused"});`);
    expect(allowed.prompts).toHaveLength(0); expect(allowed.output).toContain("history is full");
    await stopHost();
    const policyText = await readFile(profilePath("vm", "state", "action-policies.json"), "utf8"), policyFile = JSON.parse(policyText);
    expect(policyFile.format).toBe(2);
    expect(policyFile.actions["ox.identity.get"]).toBeUndefined();
    const fullState = await historyFixture(state => {
      const request = Object.values(state.requests)[0]!;
      request.id = Object.keys(state.records).find(id => id !== request.id)!;
    });
    host = await startHost(true, true);
    const corrupt = await api("/api/approvals/history");
    expect(corrupt.status).toBe(503); expect(await corrupt.text()).toContain("invalid");
    const refused = await turn(id, `return await ox.identity.get({purpose:"IA invalid receipt owner must not grant"});`);
    expect(refused.prompts).toHaveLength(0); expect(refused.output).toContain("history is invalid");
    await stopHost();
    const corruptState = await historyFixture(() => {});
    expect(Object.keys(corruptState.records)).toHaveLength(5_000);
    await historyFixture(state => {
      Object.assign(state, fullState);
      Object.values(state.records)[0]!.source = "https://example.com/private?fixture=not-a-credential";
    });
    host = await startHost(true, true);
    const privateSource = await api("/api/approvals/history");
    expect(privateSource.status).toBe(503);
    expect(await privateSource.text()).not.toContain("private?fixture");
    await stopHost();
    const retained = await historyFixture(() => {});
    expect(Object.values(retained.records)[0]!.source).toContain("private?fixture");
    expect(await readFile(profilePath("vm", "state", "action-policies.json"), "utf8")).toBe(policyText);
  } finally {
    await stopHost(); await historyFixture(state => Object.assign(state, saved));
    host = await startHost(true, true);
    expect((await api("/api/permissions", { method: "PUT", json: { scope: "action", id: "ox.identity.get", policy: null } })).status).toBe(200);
    await stopHost(); host = await startHost(true, false);
  }
}, 60_000);

test("Byte-page reads preserve a long UTF-8 source across continuations and reject a partial-character offset", async () => {
  const id = await conversation();
  const { result } = await value(id, `
    const source = "α😀".repeat(10000), path = "/byte-page-fixture.txt";
    await ox.fs.write({purpose:"Create source",path,content:source});
    let offset=0, joined="", pages=0, totalBytes=0;
    for (;;) {
      const page = await ox.fs.read({purpose:"Read bounded page",path,byteOffset:offset});
      joined += page.text; pages++; totalBytes=page.totalBytes;
      if (page.nextByteOffset===null) break;
      if (!(page.nextByteOffset>offset)) throw Error("Byte cursor did not advance");
      offset=page.nextByteOffset;
    }
    const invalid = await ox.fs.read({purpose:"Refuse broken boundary",path,byteOffset:1});
    return {same:joined===source,pages,totalBytes,unsupported:invalid.unsupported};
  `);
  expect(result).toMatchObject({ same: true, pages: 8, totalBytes: 60000 });
  expect(result.unsupported).toContain("character boundary");
});

test("Skills are created into the prompt, run their scripts, and are shared, copied and deleted", async () => {
  const id = await conversation();
  const created = await value(id, `return await ox.skill.create({ purpose: "Create skill", name: "Daily Notes", description: "Summarize daily notes.", instructions: "Read today's notes and summarize them.", services: ["Example.com"] });`);
  conforms("ox.skill.create", created.result);
  expect(created.result).toEqual({ name: "daily-notes", description: "Summarize daily notes.", services: ["example.com"], path: "skills/daily-notes/SKILL.md" });
  expect(await readFile(profilePath("files", "skills", "daily-notes", "SKILL.md"), "utf8")).toContain("name: daily-notes");
  await turn(id, `return "noted";`);
  expect(requests.at(-1)!.system).toContain("<name>daily-notes</name>");
  expect(requests.at(-1)!.system).toContain("<description>Summarize daily notes.</description>");

  const helper = `const file = await ox.fs.write({ purpose: "Save", path: args.path, content: args.text });\nconst back = await ox.fs.read({ purpose: "Read", path: args.path });\nreturn { path: file.path, text: back.text };`;
  expect((await api(`/api/files/content?path=${encodeURIComponent("skills/daily-notes/scripts/save.js")}`, { method: "PUT", body: helper })).status).toBe(201);
  const ran = await value(id, `return await ox.skill.run({ purpose: "Run helper", name: "daily-notes", script: "save.js", args: { path: "from-skill.md", text: "written by a skill" } });`);
  expect(ran.result).toMatchObject({ text: "written by a skill" });
  expect(await readFile(profilePath("files", "conversations", String(id), "from-skill.md"), "utf8")).toBe("written by a skill");
  expect((await turn(id, `return await ox.skill.run({ purpose: "Run", name: "daily-notes", script: "../save.js" });`)).output).toContain("Invalid skill script path");

  const plain = await turn(id, `return await ox.fs.write({ purpose: "Save", path: "skills/plain-notes/SKILL.md", content: "# Notes\\nNo frontmatter here." });`);
  expect(plain.output).toContain("skills/plain-notes/SKILL.md must contain valid skill frontmatter and non-empty instructions");
  expect(existsSync(profilePath("files", "skills", "plain-notes"))).toBe(false);
  await value(id, `return await ox.fs.write({ purpose: "Save", path: "skills/file-skill/SKILL.md", content: "---\\nname: file-skill\\ndescription: Made with a file write.\\n---\\nDo the thing." });`);
  expect((await read<{ skills: { name: string }[] }>("/api/skills")).skills.map(skill => skill.name)).toContain("file-skill");
  const broken = await turn(id, `return await ox.fs.edit({ purpose: "Edit", path: "skills/file-skill/SKILL.md", edits: [{ oldText: "name: file-skill\\n", newText: "" }] });`);
  expect(broken.output).toContain("skills/file-skill/SKILL.md must contain valid skill frontmatter");
  expect(await readFile(profilePath("files", "skills", "file-skill", "SKILL.md"), "utf8")).toContain("name: file-skill");
  expect((await turn(id, `return await ox.fs.write({ purpose: "Save", path: "skills/file-skill/notes.txt", content: "x" });`)).output).toContain("skills/file-skill/notes.txt is not a skill resource path");

  const shared = await value(id, `return await ox.skill.share({ purpose: "Share", name: "daily-notes" });`);
  conforms("ox.skill.share", shared.result);
  expect(shared.result).toMatchObject({ name: "daily-notes", source: "repository:local" });
  expect(existsSync(profilePath("vm", "repositories", "local", "skills", "daily-notes", "scripts", "save.js"))).toBe(true);
  expect(JSON.parse(await readFile(profilePath("vm", "repositories", "local", "repository.json"), "utf8")).skills).toEqual(["daily-notes"]);
  const archive = new Uint8Array(await readFile(profilePath("files", "conversations", String(id), "daily-notes.skill")));
  expect(zipNames(archive)).toEqual(["daily-notes/SKILL.md", "daily-notes/scripts/save.js"]);
  expect((await turn(id, `return await ox.skill.share({ purpose: "Share again", name: "daily-notes" });`)).output).toContain("A skill named /daily-notes already exists.");

  const copied = await value(id, `return await ox.skill.copy({ purpose: "Copy", source: "daily-notes", name: "Notes Copy" });`);
  conforms("ox.skill.copy", copied.result);
  expect(copied.result).toMatchObject({ name: "notes-copy", source: "daily-notes", services: ["example.com"] });
  expect(existsSync(profilePath("files", "skills", "notes-copy", "scripts", "save.js"))).toBe(true);
  expect((await value(id, `return await ox.skill.copy({ purpose: "Copy system", source: "visualize", name: "my-visualize" });`)).result).toMatchObject({ name: "my-visualize", source: "visualize" });
  expect((await turn(id, `return await ox.skill.create({ purpose: "Reserved", name: "evolve", description: "x", instructions: "y" });`)).output).toContain("reserved for a bundled System skill");
  expect((await turn(id, `return await ox.skill.delete({ purpose: "System", name: "visualize" });`)).output).toContain("reserved for a bundled System skill");

  const deleted = await value(id, `return await ox.skill.delete({ purpose: "Delete copy", name: "notes-copy" });`, approve);
  conforms("ox.skill.delete", deleted.result);
  expect(deleted.result).toEqual({ name: "notes-copy", path: "skills/notes-copy/SKILL.md", deleted: true });
  expect(deleted.prompts.map(prompt => prompt.options)).toEqual([["Approve", "Always approve", "Deny"]]);
  expect(existsSync(profilePath("files", "skills", "notes-copy"))).toBe(false);
  expect((await turn(id, `return await ox.skill.delete({ purpose: "Delete", name: "daily-notes" });`, () => ({ answer: "Deny" }))).output).toContain("the user declined");

  await value(id, `return await ox.skill.share({ purpose: "Share", name: "my-visualize" });`);
  let listed = await read<{ skills: { name: string; description: string; source: string; path: string; services: string[]; enabled: boolean; lastUsedAt: number | null; deletable: boolean; builtIn: boolean }[] }>("/api/skills");
  expect(listed.skills.find(skill => skill.name === "daily-notes")).toEqual({ name: "daily-notes", description: "Summarize daily notes.", source: "profile", path: "skills/daily-notes/SKILL.md",
    services: ["example.com"], enabled: true, lastUsedAt: expect.any(Number), deletable: true, builtIn: false });
  expect(listed.skills.find(skill => skill.name === "visualize")?.source).toBe("system");
  expect((await api("/api/skills/visualize", { method: "DELETE" })).status).toBe(404);
  expect(await (await api("/api/skills/my-visualize", { method: "DELETE" })).json()).toEqual({ deleted: true });
  listed = await read("/api/skills");
  expect(listed.skills.find(skill => skill.name === "my-visualize")).toMatchObject({ source: "local", path: "repositories/local/skills/my-visualize/SKILL.md" });
  await turn(id, `return "after";`);
  expect(requests.at(-1)!.system).toContain("<name>my-visualize</name>");
  expect(requests.at(-1)!.system).toContain("repositories/local/skills/my-visualize/");

  const repository = profilePath("vm", "repositories", "team-tools");
  await mkdir(join(repository, "skills", "standup"), { recursive: true });
  await writeFile(join(repository, "repository.json"), JSON.stringify({ version: 3, name: "Team Tools", services: [], skills: ["standup"] }));
  await writeFile(join(repository, "skills", "standup", "SKILL.md"), "---\nname: standup\ndescription: Prepare the team standup.\n---\n\nCollect everyone's updates.\n");
  const state = (enabled: boolean) => writeFile(profilePath("vm", "state", "repositories.json"), JSON.stringify({ repositories: [{ id: "team-tools",
    url: "https://example.com/team-tools.git", name: "Team Tools", enabled, syncedAt: null, commit: null, error: null }], selections: {} }));
  await state(true);
  await turn(id, `return "connected";`);
  expect(requests.at(-1)!.system).toContain("<description>Prepare the team standup. Files: repositories/team-tools/skills/standup/</description>");
  expect((await read<typeof listed>("/api/skills")).skills.find(skill => skill.name === "standup")).toMatchObject({ source: "team-tools", path: "repositories/team-tools/skills/standup/SKILL.md" });
  expect((await turn(id, `return await ox.skill.delete({ purpose: "Delete", name: "standup" });`)).output).toContain("read-only repository Team Tools");
  expect((await value(id, `return await ox.skill.copy({ purpose: "Customize", source: "standup", name: "my-standup" });`)).result).toMatchObject({ name: "my-standup", source: "standup" });
  await state(false);
  expect((await read<typeof listed>("/api/skills")).skills.map(skill => skill.name)).not.toContain("standup");
}, 60_000);

test("Skills turn off, are created and imported from Settings, and record when they were last used", async () => {
  const id = await conversation();
  type Row = { name: string; source: string; enabled: boolean; lastUsedAt: number | null; deletable: boolean };
  const skill = async (name: string) => (await read<{ skills: Row[] }>("/api/skills")).skills.find(entry => entry.name === name);
  const created = await api("/api/skills", { method: "POST", json: { name: "Trip Notes", description: "Plan trips from notes.", instructions: "Read the trip notes and plan each day." } });
  expect(created.status).toBe(201);
  expect(await created.json()).toMatchObject({ name: "trip-notes", source: "profile", enabled: true, lastUsedAt: null, deletable: true });
  expect((await api("/api/skills", { method: "POST", json: { name: "trip-notes", description: "Again.", instructions: "Again." } })).status).toBe(409);
  expect((await api("/api/skills", { method: "POST", json: { name: "evolve", description: "Reserved.", instructions: "Reserved." } })).status).toBe(400);

  await turn(id, `return await ox.fs.read({ purpose: "Read skill", path: "/skills/trip-notes/SKILL.md" });`);
  expect(requests.at(-1)!.system).toContain("<name>trip-notes</name>");
  await until(() => skill("trip-notes"), row => typeof row?.lastUsedAt === "number");

  for (const name of ["trip-notes", "visualize"]) expect((await api(`/api/skills/${name}/enabled`, { method: "PUT", json: { enabled: false } })).status).toBe(200);
  expect(await skill("trip-notes")).toMatchObject({ enabled: false });
  expect((await turn(id, `return await ox.skill.run({ purpose: "Run", name: "trip-notes", script: "plan.js" });`)).output).toContain("/trip-notes is turned off in Settings");
  expect(requests.at(-1)!.system).not.toContain("<name>trip-notes</name>");
  expect(requests.at(-1)!.system).not.toContain("<name>visualize</name>");
  expect((await api("/api/skills/visualize/enabled", { method: "PUT", json: { enabled: true } })).status).toBe(200);
  await turn(id, `return "back";`);
  expect(requests.at(-1)!.system).toContain("<name>visualize</name>");
  expect((await api("/api/skills/missing-skill/enabled", { method: "PUT", json: { enabled: false } })).status).toBe(404);

  const uploaded = await api("/api/skills/import", { method: "POST", body: "---\nname: Packing List\ndescription: Make a packing list.\n---\nList what to pack for the trip." });
  expect(uploaded.status).toBe(201);
  expect(await uploaded.json()).toMatchObject({ name: "packing-list", enabled: true, deletable: true });
  expect(await readFile(profilePath("files", "skills", "packing-list", "SKILL.md"), "utf8")).toContain("name: packing-list");
  const invalid = await api("/api/skills/import", { method: "POST", body: "# Only notes" });
  expect(invalid.status).toBe(400);
  expect((await invalid.json() as { error: string }).error).toContain("SKILL.md needs frontmatter");
  await value(id, `return await ox.skill.share({ purpose: "Share", name: "packing-list" });`);
  const archive = new Uint8Array(await readFile(profilePath("files", "conversations", String(id), "packing-list.skill")));
  expect((await api("/api/skills/packing-list", { method: "DELETE" })).status).toBe(200);
  const restored = await api("/api/skills/import", { method: "POST", body: archive });
  expect(restored.status).toBe(201);
  expect(await readFile(profilePath("files", "skills", "packing-list", "SKILL.md"), "utf8")).toContain("List what to pack for the trip.");

  expect((await api("/api/skills/trip-notes", { method: "DELETE" })).status).toBe(200);
  expect((await api("/api/skills", { method: "POST", json: { name: "trip-notes", description: "Plan trips again.", instructions: "Plan each day." } })).status).toBe(201);
  expect(await skill("trip-notes")).toMatchObject({ enabled: true, lastUsedAt: null });
}, 60_000);

test("Schedules run on time in new conversations, complete conditions, pause, resume and delete", async () => {
  const id = await conversation();
  const fireAt = new Date(Date.now() + 4_000).toISOString();
  const once = await value(id, `return await ox.schedule.create({ purpose: "Schedule", name: "Morning note", frequency: "once", fireAt: ${JSON.stringify(fireAt)}, prompt: ${JSON.stringify(script(`await ox.fs.write({ purpose: "Save", path: "scheduled.md", content: "from a schedule" }); return "scheduled";`))} });`, always);
  conforms("ox.schedule.create", once.result);
  expect(once.result).toMatchObject({ name: "Morning note", status: "active", enabled: true });
  expect(once.prompts).toHaveLength(1);
  const scheduleID = once.result.id as string;
  const ran = await until(() => read<{ schedules: Row[] }>("/api/schedules"), body => body.schedules.some(row => row.id === scheduleID && row.lastOutcome !== null));
  const row = ran.schedules.find(entry => entry.id === scheduleID)!;
  expect(row).toMatchObject({ state: "completed", lastOutcome: "succeeded", nextFireAt: null, lastError: null });
  expect(row.lastRunAt).toBeGreaterThanOrEqual(Date.parse(fireAt));
  const scheduled = await read<View>(`/api/conversations/${row.conversationId}`);
  expect(scheduled.summary.title).toBe("Morning note");
  expect(lastText(scheduled)).toBe("OUTPUT scheduled");
  expect(await readFile(profilePath("files", "conversations", String(row.conversationId), "scheduled.md"), "utf8")).toBe("from a schedule");

  const deadline = new Date(Date.now() + 3_600_000).toISOString();
  const complete = script(`return await ox.schedule.complete({ purpose: "Condition met" });`);
  const conditional = await value(id, `return await ox.schedule.create({ purpose: "Watch", name: "Until ready", frequency: "interval", intervalSeconds: 60, condition: "The report is ready", deadline: ${JSON.stringify(deadline)}, prompt: ${JSON.stringify(complete)} });`);
  expect(conditional.prompts).toHaveLength(0);
  const conditionID = conditional.result.id as string;
  expect(await (await api(`/api/schedules/${conditionID}/run`, { method: "POST" })).json()).toEqual({ started: true });
  const completed = (await until(() => read<{ schedules: Row[] }>("/api/schedules"), body => body.schedules.find(entry => entry.id === conditionID)?.lastOutcome !== null)).schedules.find(entry => entry.id === conditionID)!;
  expect(completed).toMatchObject({ state: "completed", lastOutcome: "succeeded", nextFireAt: null });
  const check = await read<View>(`/api/conversations/${completed.conversationId}`);
  expect(textOf(check.messages[0]!.content)).toContain("This is a scheduled condition check. Stop condition: The report is ready");
  expect(lastText(check)).toContain(`"id": "${conditionID}"`);
  expect(lastText(check)).toContain(`"completed": true`);
  expect((await turn(id, `return await ox.schedule.complete({ purpose: "Not scheduled" });`)).output).toContain("Only an active scheduled check can complete its own schedule.");

  const waiting = await value(id, `return await ox.schedule.create({ purpose: "Watch", name: "Not yet", frequency: "interval", intervalSeconds: 60, condition: "Never", deadline: ${JSON.stringify(deadline)}, prompt: ${JSON.stringify(script(`return "not yet";`))} });`);
  const waitingID = waiting.result.id as string;
  const run = await value(id, `return await ox.schedule.run({ purpose: "Check now", id: ${JSON.stringify(waitingID)} });`, approve);
  expect(run.result).toEqual({ id: waitingID, started: true });
  conforms("ox.schedule.run", run.result);
  const checked = (await until(() => read<{ schedules: Row[] }>("/api/schedules"), body => body.schedules.find(entry => entry.id === waitingID)?.lastOutcome === "succeeded")).schedules.find(entry => entry.id === waitingID)!;
  expect(checked.state).toBe("active");
  expect(checked.nextFireAt!).toBeGreaterThan(Date.now() + 30_000);

  const attention = await value(id, `return await ox.schedule.create({ purpose: "Ask", name: "Needs a person", frequency: "daily", hour: 9, minute: 30, timeZone: "Europe/Paris", prompt: ${JSON.stringify(script(`return await ox.user.choose({ purpose: "Ask", body: "Which one?", options: ["A", "B"] });`))} });`);
  expect(attention.result.recurrence).toBe("daily at 09:30 Europe/Paris");
  const attentionID = attention.result.id as string;
  await api(`/api/schedules/${attentionID}/run`, { method: "POST" });
  const paused = (await until(() => read<{ schedules: Row[] }>("/api/schedules"), body => body.schedules.find(entry => entry.id === attentionID)?.lastOutcome === "failed")).schedules.find(entry => entry.id === attentionID)!;
  expect(paused).toMatchObject({ state: "paused", lastError: "The schedule needs attention in Ox." });
  const asking = await read<View>(`/api/conversations/${paused.conversationId}`);
  expect(asking.pendingPrompt?.prompt).toBe("Which one?");
  await api(`/api/conversations/${paused.conversationId}/respond`, { method: "POST", json: { promptId: asking.pendingPrompt!.id, answer: "A" } });
  await until(() => read<View>(`/api/conversations/${paused.conversationId}`), view => !view.busy);

  const disabled = await value(id, `return await ox.schedule.enable({ purpose: "Pause", id: ${JSON.stringify(waitingID)}, enabled: false });`, approve);
  conforms("ox.schedule.enable", disabled.result);
  expect(disabled.result).toMatchObject({ status: "paused", enabled: false });
  const resumed = await (await api(`/api/schedules/${waitingID}`, { method: "PUT", json: { enabled: true } })).json() as Row;
  expect(resumed).toMatchObject({ id: waitingID, state: "active", lastOutcome: "succeeded" });
  expect(resumed.nextFireAt!).toBeGreaterThan(Date.now());
  const listed = await value<Record<string, unknown>[]>(id, `return await ox.schedule.list({ purpose: "List" });`);
  conforms("ox.schedule.list", listed.result);
  expect(listed.result.map(entry => entry.id)).toEqual(expect.arrayContaining([scheduleID, conditionID, waitingID, attentionID]));
  expect((await turn(id, `return await ox.schedule.create({ purpose: "Past", name: "Late", frequency: "once", fireAt: "2020-01-01T00:00:00Z", prompt: "x" });`)).output).toContain("fireAt must be a future ISO-8601 timestamp");

  const removed = await value(id, `return await ox.schedule.delete({ purpose: "Delete", id: ${JSON.stringify(attentionID)} });`, approve);
  conforms("ox.schedule.delete", removed.result);
  expect(await (await api(`/api/schedules/${waitingID}`, { method: "DELETE" })).json()).toEqual({ deleted: true });
  expect((await api(`/api/schedules/${waitingID}`, { method: "DELETE" })).status).toBe(404);
  const remaining = (await read<{ schedules: Row[] }>("/api/schedules")).schedules.map(entry => entry.id);
  expect(remaining).toContain(scheduleID);
  expect(remaining).not.toContain(waitingID);
  expect(remaining).not.toContain(attentionID);
}, 60_000);

test("A schedule missed while the Host is stopped runs once after restart", async () => {
  const id = await conversation();
  const fireAt = new Date(Date.now() + 1_500).toISOString();
  const created = await value(id, `return await ox.schedule.create({ purpose: "Schedule", name: "Missed", frequency: "once", fireAt: ${JSON.stringify(fireAt)}, prompt: ${JSON.stringify(script(`return "caught up";`))} });`);
  await stopHost();
  await Bun.sleep(Math.max(0, Date.parse(fireAt) - Date.now()) + 500);
  host = await startHost();
  const row = (await until(() => read<{ schedules: Row[] }>("/api/schedules"), body => body.schedules.find(entry => entry.id === created.result.id)?.lastOutcome === "succeeded"))
    .schedules.find(entry => entry.id === created.result.id)!;
  expect(row.state).toBe("completed");
  expect(lastText(await read<View>(`/api/conversations/${row.conversationId}`))).toBe("OUTPUT caught up");
}, 40_000);

test("Regenerating or editing a conversation moves the schedules bound to it", async () => {
  const id = await conversation();
  await turn(id, `return "first";`);
  const created = await value(id, `return await ox.schedule.create({ purpose: "Schedule", name: "Bound note", frequency: "daily", hour: 9, minute: 0, timeZone: "UTC", conversation: "current", prompt: "Say hello" });`, approve);
  const scheduleID = created.result.id as string;
  expect((await read<{ schedules: Row[] }>("/api/schedules")).schedules.find(row => row.id === scheduleID)?.conversationId).toBe(id);
  const first = (await read<{ blocks: { kind: { type: string; entry?: number } }[] }>(`/api/conversations/${id}`)).blocks.find(block => block.kind.type === "userText")!.kind.entry!;
  const rerun = await api(`/api/conversations/${id}/rerun`, { method: "POST", json: { entry: first } });
  expect(rerun.status).toBe(202);
  const replacement = (await rerun.json() as { id: number }).id;
  expect((await read<{ schedules: Row[] }>("/api/schedules")).schedules.find(row => row.id === scheduleID)?.conversationId).toBe(replacement);
  await until(() => read<View>(`/api/conversations/${replacement}`), view => !view.busy);
  expect((await api(`/api/schedules/${scheduleID}`, { method: "DELETE" })).status).toBe(200);
}, 60_000);

test("Schedules are edited from the web, and the agent's step names the schedule it created", async () => {
  type Edited = Row & { prompt: string; condition: string | null; deadline: number | null; recurrence: Record<string, unknown> };
  type Step = { name: string; outcome: Record<string, { _0?: unknown }> };
  const id = await conversation();
  const created = await value(id, `return await ox.schedule.create({ purpose: "Schedule", name: "Daily digest", frequency: "daily", hour: 8, minute: 0, timeZone: "UTC", prompt: "Summarize the news" });`, approve);
  const scheduleID = created.result.id as string;
  const blocks = (await read<{ blocks: { kind: { trace?: { entries: { invocation?: Step }[] } } }[] }>(`/api/conversations/${id}`)).blocks;
  const step = blocks.flatMap(block => block.kind.trace?.entries ?? []).find(entry => entry.invocation?.name === "ox.schedule.create")!.invocation!;
  expect(step.outcome.succeeded?._0).toEqual({ id: scheduleID, name: "Daily digest" });

  const patch = (target: string, json: unknown) => api(`/api/schedules/${target}`, { method: "PATCH", json });
  const deadline = Date.now() + 14 * 86_400_000;
  const edited = await (await patch(scheduleID, { name: "  Weekly digest ", prompt: "Summarize the week", condition: "The report is ready", deadline,
    recurrence: { type: "weekly", weekday: 2, hour: 7, minute: 30, timeZone: "Europe/Paris" } })).json() as Edited;
  expect(edited).toMatchObject({ id: scheduleID, name: "Weekly digest", prompt: "Summarize the week", condition: "The report is ready", deadline, state: "active",
    recurrence: { type: "weekly", weekday: 2, hour: 7, minute: 30, timeZone: "Europe/Paris" } });
  expect(new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Paris", weekday: "long", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(edited.nextFireAt!)).toBe("Monday 07:30");
  expect((await read<{ schedules: Edited[] }>("/api/schedules")).schedules.find(row => row.id === scheduleID)).toMatchObject({ condition: "The report is ready", deadline });

  const base = { name: "Digest", prompt: "Summarize", condition: null, deadline: null, recurrence: { type: "interval", seconds: 3_600 } };
  const refused = async (json: unknown, status: number, message?: string) => {
    const response = await patch(scheduleID, json);
    expect(response.status).toBe(status);
    if (message) expect(((await response.json()) as { error: string }).error).toBe(message);
  };
  await refused({ ...base, name: " " }, 400, "The schedule is invalid.");
  await refused({ ...base, condition: "Done" }, 400, "A schedule with a stop condition must repeat and have a deadline.");
  await refused({ ...base, condition: "Done", deadline, recurrence: { type: "once", fireAt: Date.now() + 60_000 } }, 400, "A schedule with a stop condition must repeat and have a deadline.");
  await refused({ ...base, recurrence: { type: "once", fireAt: Date.now() - 60_000 } }, 400, "Choose a time in the future.");
  await refused({ ...base, deadline: Date.now() + 60_000 }, 400, "Choose a time in the future.");
  await refused({ ...base, recurrence: { type: "daily", hour: 9, minute: 0, timeZone: "Mars/Olympus" } }, 400, "Choose a valid schedule time and time zone.");
  await refused({ ...base, recurrence: { type: "interval", seconds: 5 } }, 400, "Choose a valid schedule time and time zone.");
  await refused({ ...base, recurrence: "daily" }, 400);
  await refused({ ...base, name: 7 }, 400);
  expect((await patch("00000000-0000-4000-8000-000000000000", base)).status).toBe(404);
  expect((await read<{ schedules: Edited[] }>("/api/schedules")).schedules.find(row => row.id === scheduleID)?.name).toBe("Weekly digest");

  expect((await api(`/api/schedules/${scheduleID}`, { method: "PUT", json: { enabled: false } })).status).toBe(200);
  expect(await (await patch(scheduleID, base)).json()).toMatchObject({ state: "paused", name: "Digest", condition: null, deadline: null });

  const fireAt = new Date(Date.now() + 3_000).toISOString();
  const once = await value(id, `return await ox.schedule.create({ purpose: "Schedule", name: "Once", frequency: "once", fireAt: ${JSON.stringify(fireAt)}, prompt: "Say hi" });`, approve);
  const onceID = once.result.id as string;
  await until(() => read<{ schedules: Row[] }>("/api/schedules"), body => body.schedules.find(row => row.id === onceID)?.state === "completed");
  const later = Date.now() + 3_600_000;
  expect(await (await patch(onceID, { ...base, name: "Once again", recurrence: { type: "once", fireAt: later } })).json()).toMatchObject({ state: "active", nextFireAt: later });

  const slow = await value(id, `return await ox.schedule.create({ purpose: "Schedule", name: "Slow", frequency: "interval", intervalSeconds: 3600, prompt: "slow-run" });`, approve);
  const slowID = slow.result.id as string;
  await api(`/api/schedules/${slowID}/run`, { method: "POST" });
  await until(() => read<{ schedules: Row[] }>("/api/schedules"), body => body.schedules.find(row => row.id === slowID)?.state === "running");
  const busy = await patch(slowID, base);
  expect(busy.status).toBe(409);
  expect(((await busy.json()) as { error: string }).error).toBe("Pause this schedule before editing or running it again.");
  await until(() => read<{ schedules: Row[] }>("/api/schedules"), body => body.schedules.find(row => row.id === slowID)?.lastOutcome !== null);
  for (const target of [scheduleID, onceID, slowID]) expect((await api(`/api/schedules/${target}`, { method: "DELETE" })).status).toBe(200);
}, 60_000);

test("Messages a schedule sends carry its name, and skills the agent creates, writes or reads are named in their steps", async () => {
  type Step = { name: string; outcome: Record<string, { _0?: unknown }> };
  type Block = { kind: { type: string; schedule?: string; text?: string; entry?: number; trace?: { entries: { invocation?: Step }[] } } };
  type Detail = { name: string; description: string; instructions: string; editable: boolean; source: string };
  const { zipDecode } = await import(`${ROOT}/apps/linux/src/vm/skills-package.ts`) as typeof import("../../../../../apps/linux/src/vm/skills-package");
  const blocks = async (target: number) => (await read<{ blocks: Block[] }>(`/api/conversations/${target}`)).blocks;
  const users = async (target: number) => (await blocks(target)).filter(block => block.kind.type === "userText").map(block => block.kind);
  const finished = (scheduleID: string) => until(() => read<{ schedules: Row[] }>("/api/schedules"), body => body.schedules.find(row => row.id === scheduleID)?.lastOutcome !== null)
    .then(body => body.schedules.find(row => row.id === scheduleID)!);
  const id = await conversation();

  const once = await value(id, `return await ox.schedule.create({ purpose: "Schedule", name: "Morning note", frequency: "once", fireAt: ${JSON.stringify(new Date(Date.now() + 2_500).toISOString())}, prompt: "Say hi" });`, approve);
  const ran = (await finished(once.result.id as string)).conversationId!;
  expect((await users(ran))[0]).toMatchObject({ schedule: "Morning note", text: "Say hi" });

  const bound = await value(id, `return await ox.schedule.create({ purpose: "Schedule", name: "Bound check", frequency: "interval", intervalSeconds: 3600, conversation: "current", prompt: "Check in" });`, approve);
  await api(`/api/schedules/${bound.result.id}/run`, { method: "POST" });
  await finished(bound.result.id as string);
  await until(() => read<View>(`/api/conversations/${id}`), view => !view.busy);
  const asked = await users(id);
  expect(asked.at(-1)).toMatchObject({ schedule: "Bound check", text: "Check in" });
  expect(asked.slice(0, -1).every(kind => kind.schedule === undefined)).toBe(true);

  await stopHost();
  host = await startHost();
  expect((await users(ran))[0]?.schedule).toBe("Morning note");
  expect((await users(id)).at(-1)?.schedule).toBe("Bound check");

  const interrupted = await conversation();
  const slow = await value(interrupted, `return await ox.schedule.create({ purpose: "Schedule", name: "Slow check", frequency: "interval", intervalSeconds: 3600, conversation: "current", prompt: "slow-run" });`, approve);
  const first = (await users(interrupted))[0]!.entry;
  await api(`/api/schedules/${slow.result.id}/run`, { method: "POST" });
  await until(() => read<{ schedules: Row[] }>("/api/schedules"), body => body.schedules.find(row => row.id === slow.result.id)?.state === "running");
  await Bun.sleep(500);
  host!.process.kill(9);
  await host!.process.exited;
  host = await startHost();
  await until(() => read<{ items: { id: number; busy: boolean }[] }>("/api/conversations"), body => body.items.some(item => item.id === interrupted && !item.busy), 30_000);
  const early = await api(`/api/conversations/${interrupted}/branch`, { method: "POST", json: { entry: first } });
  expect(early.status).toBe(201);
  const resumed = (await users(interrupted)).at(-1)!;
  expect(resumed).toMatchObject({ schedule: "Slow check", text: "slow-run" });
  const fork = await api(`/api/conversations/${interrupted}/branch`, { method: "POST", json: { entry: resumed.entry } });
  expect(fork.status).toBe(201);
  expect((await users(((await fork.json()) as { id: number }).id)).at(-1)?.schedule).toBe("Slow check");
  expect((await api(`/api/schedules/${slow.result.id}`, { method: "DELETE" })).status).toBe(200);

  const exported = new Uint8Array(await (await api(`/api/conversations/${ran}/export`)).arrayBuffer());
  const turns = new TextDecoder().decode(zipDecode(exported, 134_217_728, 33_554_432, 256).find(entry => entry.path === "turns.jsonl")!.data).trim().split("\n").map(line => JSON.parse(line));
  expect(turns[0]).toMatchObject({ type: "user", user: { intent: "Say hi", scheduleName: "Morning note" } });
  const staged = await (await api("/api/conversations/import", { method: "POST", body: new Blob([exported as Uint8Array<ArrayBuffer>]) })).json() as { token: string };
  const imported = ((await (await api(`/api/conversations/import/${staged.token}`, { method: "POST" })).json()) as { id: number }).id;
  expect((await users(imported))[0]).toMatchObject({ schedule: "Morning note", text: "Say hi" });
  const branched = await api(`/api/conversations/${ran}/branch`, { method: "POST", json: { entry: (await users(ran))[0]!.entry } });
  expect(branched.status).toBe(201);
  expect((await users(((await branched.json()) as { id: number }).id))[0]?.schedule).toBe("Morning note");

  await value(id, `return await ox.skill.create({ purpose: "Create", name: "trip-planner", description: "Plan trips.", instructions: "Plan each day of the trip." });`, approve);
  await value(id, `return await ox.fs.write({ purpose: "Save", path: "skills/notes-helper/SKILL.md", content: "---\\nname: notes-helper\\ndescription: Help with notes.\\n---\\nKeep notes short." });`, approve);
  await turn(id, `return await ox.fs.read({ purpose: "Read skill", path: "/skills/trip-planner/SKILL.md" });`);
  const steps = (await blocks(id)).flatMap(block => block.kind.trace?.entries ?? []).flatMap(entry => entry.invocation ? [entry.invocation] : []);
  const results = (name: string) => steps.filter(step => step.name === name).map(step => step.outcome.succeeded?._0);
  expect(results("ox.skill.create")).toContainEqual({ skill: "trip-planner" });
  expect(results("ox.fs.write")).toContainEqual({ skill: "notes-helper" });
  expect(results("ox.fs.read")).toContainEqual({ skill: "trip-planner" });

  const opened = await read<Detail & { revision: string; builtIn: boolean }>("/api/skills/trip-planner");
  expect(opened).toMatchObject({ name: "trip-planner", description: "Plan trips.", instructions: "Plan each day of the trip.", editable: true, source: "profile", builtIn: false });
  expect(await read<Detail & { builtIn: boolean }>("/api/skills/visualize")).toMatchObject({ editable: false, builtIn: true });
  await value(id, `return await ox.fs.edit({ purpose: "Edit", path: "skills/trip-planner/SKILL.md", edits: [{ oldText: "Plan each day of the trip.", newText: "Plan each day of the trip carefully." }] });`, approve);
  const stale = await api("/api/skills/trip-planner", { method: "PUT", json: { description: "Plan trips.", instructions: "Overwrite.", revision: opened.revision } });
  expect(stale.status).toBe(409);
  expect(((await stale.json()) as { error: string }).error).toBe("This skill changed after you opened it. Open it again to see the latest version.");
  expect((await read<Detail>("/api/skills/trip-planner")).instructions).toBe("Plan each day of the trip carefully.");
  expect((await api("/api/skills/visualize", { method: "PUT", json: { description: "x", instructions: "y" } })).status).toBe(403);
  expect((await api("/api/skills/missing-skill")).status).toBe(404);
  const empty = await api("/api/skills/trip-planner", { method: "PUT", json: { description: " ", instructions: "x" } });
  expect(empty.status).toBe(400);
  expect(((await empty.json()) as { error: string }).error).toBe("Skill description cannot be empty.");
  expect((await api("/api/skills/trip-planner", { method: "PUT", json: { description: "Plan trips." } })).status).toBe(400);
  const current = (await read<{ revision: string }>("/api/skills/trip-planner")).revision;
  const edited = await api("/api/skills/trip-planner", { method: "PUT", json: { description: "Plan trips with care.", instructions: "Plan each day, then pack.", revision: current } });
  expect(edited.status).toBe(200);
  expect(await edited.json()).toMatchObject({ description: "Plan trips with care.", instructions: "Plan each day, then pack.", editable: true });
  expect(await readFile(profilePath("files", "skills", "trip-planner", "SKILL.md"), "utf8")).toContain("Plan each day, then pack.");

  const local = profilePath("vm", "repositories", "local");
  const manifest = await readFile(join(local, "repository.json"), "utf8");
  await mkdir(join(local, "skills", "team-notes"), { recursive: true });
  await writeFile(join(local, "skills", "team-notes", "SKILL.md"), "---\nname: team-notes\ndescription: Team notes.\n---\nWrite team notes.\n");
  const parsed = JSON.parse(manifest) as { skills: string[] };
  await writeFile(join(local, "repository.json"), JSON.stringify({ ...parsed, skills: [...parsed.skills, "team-notes"].sort() }));
  expect(await read<Detail>("/api/skills/team-notes")).toMatchObject({ source: "local", editable: true });
  expect((await api("/api/skills/team-notes", { method: "PUT", json: { description: "Shared team notes.", instructions: "Write shared notes." } })).status).toBe(200);
  expect(await readFile(join(local, "skills", "team-notes", "SKILL.md"), "utf8")).toContain("Write shared notes.");
  expect((await readdir(join(local, "skills", "team-notes"))).sort()).toEqual(["SKILL.md"]);
  await writeFile(join(local, "repository.json"), manifest);
  await rm(join(local, "skills", "team-notes"), { recursive: true, force: true });
  for (const name of ["trip-planner", "notes-helper"]) expect((await api(`/api/skills/${name}`, { method: "DELETE" })).status).toBe(200);
  expect((await api(`/api/schedules/${bound.result.id}`, { method: "DELETE" })).status).toBe(200);
}, 90_000);

test("Skills sent from the composer expand their instructions, attach their services and keep the skill on the message", async () => {
  type Kind = { type: string; skill?: { name: string; argument: string }; entry?: number };
  type Full = View & { blocks: { kind: Kind }[] };
  const users = async (target: number) => (await read<Full>(`/api/conversations/${target}`)).blocks.filter(block => block.kind.type === "userText").map(block => block.kind);
  const idle = (target: number) => until(() => read<Full>(`/api/conversations/${target}`), view => !view.busy);
  const id = await conversation();
  await value(id, `return await ox.skill.create({ purpose: "Create", name: "tour-notes", description: "Plan trips.", instructions: "Plan each day of the trip.", services: ["en.wikipedia.org"] });`, approve);
  const send = (target: number, json: unknown) => api(`/api/conversations/${target}/messages`, { method: "POST", json });
  expect((await send(id, { skill: "tour-notes", text: "Paris in May" })).status).toBe(202);
  const view = await idle(id);
  expect((await users(id)).at(-1)!.skill).toEqual({ name: "tour-notes", argument: "Paris in May" });
  expect(textOf([...view.messages].reverse().find(message => message.role === "user")!.content)).toBe("Plan each day of the trip.\n\nParis in May");
  expect((await read<{ services: { domain: string; attached?: boolean }[] }>(`/api/services?conversation=${id}`)).services.find(service => service.domain === "en.wikipedia.org")?.attached).toBe(true);
  expect((await read<{ skills: { name: string; lastUsedAt: number | null }[] }>("/api/skills")).skills.find(skill => skill.name === "tour-notes")?.lastUsedAt).toEqual(expect.any(Number));

  const bare = await conversation();
  expect((await send(bare, { skill: "tour-notes" })).status).toBe(202);
  const quiet = await idle(bare);
  expect(quiet.summary.title).toBe("/tour-notes");
  expect((await users(bare))[0]!.skill).toEqual({ name: "tour-notes", argument: "" });
  expect(textOf(quiet.messages.find(message => message.role === "user")!.content)).toBe("Plan each day of the trip.");

  expect((await send(id, { skill: "visualize", text: "x" })).status).toBe(404);
  expect((await send(id, { skill: "missing-skill" })).status).toBe(404);
  expect((await send(id, { skill: 7 })).status).toBe(400);
  expect((await api("/api/skills/tour-notes/enabled", { method: "PUT", json: { enabled: false } })).status).toBe(200);
  expect((await send(id, { skill: "tour-notes" })).status).toBe(404);
  expect((await api("/api/skills/tour-notes/enabled", { method: "PUT", json: { enabled: true } })).status).toBe(200);
  const memory = await conversation();
  expect((await api(`/api/conversations/${memory}`, { method: "PATCH", json: { title: "Import memory to Ox" } })).status).toBe(200);
  expect((await send(memory, { skill: "import-memory" })).status).toBe(202);
  const imported = await idle(memory);
  expect(imported.summary.title).toBe("Import memory to Ox");
  expect((await users(memory))[0]!.skill).toEqual({ name: "import-memory", argument: "" });
  expect(textOf(imported.messages.find(message => message.role === "user")!.content)).toContain("# Import Memory");
  expect((await api("/api/skills/import-memory/enabled", { method: "PUT", json: { enabled: false } })).status).toBe(200);
  expect((await send(memory, { skill: "import-memory" })).status).toBe(404);
  expect((await api("/api/skills/import-memory/enabled", { method: "PUT", json: { enabled: true } })).status).toBe(200);

  await stopHost();
  host = await startHost();
  const kept = (await users(id)).at(-1)!;
  expect(kept.skill).toEqual({ name: "tour-notes", argument: "Paris in May" });
  const fork = await api(`/api/conversations/${id}/branch`, { method: "POST", json: { entry: kept.entry } });
  expect(fork.status).toBe(201);
  expect((await users(((await fork.json()) as { id: number }).id)).at(-1)?.skill).toEqual({ name: "tour-notes", argument: "Paris in May" });
  const regenerated = await api(`/api/conversations/${id}/rerun`, { method: "POST", json: { entry: kept.entry } });
  expect(regenerated.status).toBe(202);
  const again = ((await regenerated.json()) as { id: number }).id;
  await idle(again);
  expect((await users(again)).at(-1)?.skill).toEqual({ name: "tour-notes", argument: "Paris in May" });
  const editedFrom = (await users(again)).at(-1)!.entry;
  const edited = await api(`/api/conversations/${again}/rerun`, { method: "POST", json: { entry: editedFrom, text: "Rome instead" } });
  expect(edited.status).toBe(202);
  const plain = ((await edited.json()) as { id: number }).id;
  await idle(plain);
  expect((await users(plain)).at(-1)).toMatchObject({ text: "Rome instead" });
  expect((await users(plain)).at(-1)?.skill).toBeUndefined();
  expect((await api("/api/skills/tour-notes", { method: "DELETE" })).status).toBe(200);
}, 90_000);

test("Conversation functions start, rename, change the model and delete conversations", async () => {
  const id = await conversation();
  const started = await value<{ id: string }>(id, `return await ox.conversation.start({ purpose: "Start", prompt: "hello there", title: "Side task" });`);
  conforms("ox.conversation.start", started.result);
  const other = numberOf(started.result.id);
  const side = await until(() => read<View>(`/api/conversations/${other}`), view => !view.busy && lastText(view) !== "");
  expect(side.summary.title).toBe("Side task");
  expect(lastText(side)).toBe("Hello from the scripted model.");

  const renamed = await value(id, `return await ox.conversation.rename({ purpose: "Name", title: "Renamed by agent" });`);
  conforms("ox.conversation.rename", renamed.result);
  expect(renamed.result).toEqual({ renamed: true, title: "Renamed by agent" });
  expect((await read<View>(`/api/conversations/${id}`)).summary.title).toBe("Renamed by agent");
  await api(`/api/conversations/${id}`, { method: "PATCH", json: { title: "Chosen by the user" } });
  expect((await value(id, `return await ox.conversation.rename({ purpose: "Name", title: "Agent again" });`)).result).toEqual({ renamed: false, title: "Chosen by the user" });
  const invalid = (await turn(id, `return await ox.conversation.rename({ purpose: "Name", title: "x".repeat(51) });`)).output;
  expect(invalid).toContain("invalid_argument");
  expect(invalid).toContain(`Retry with arguments that match this input schema: ${JSON.stringify(contracts["ox.conversation.rename"]!.inputSchema)}`);

  const changed = await value(id, `return await ox.conversation.setModel({ purpose: "Switch", selection: { provider: "custom", model: "fixture-2" } });`);
  conforms("ox.conversation.setModel", changed.result);
  expect(changed.result).toEqual({ status: "pending", selection: { provider: "custom", model: "fixture-2", thinkingLevel: null }, changed: true });
  await until(() => read<View>(`/api/conversations/${id}`), view => view.summary.model?.modelId === "fixture-2");
  const current = await value(id, `return await ox.conversation.model({ purpose: "Model" });`);
  conforms("ox.conversation.model", current.result);
  expect(current.result).toMatchObject({ provider: { id: "custom", name: "Scripted" }, model: { id: "fixture-2" }, thinkingLevel: null,
    change: { status: "applied", selection: { provider: "custom", model: "fixture-2", thinkingLevel: null }, error: null },
    authentication: { method: "none", status: "notRequired" } });
  expect(requests.at(-1)!.model).toBe("fixture-2");
  expect((await turn(id, `return await ox.conversation.setModel({ purpose: "Switch", selection: { provider: "custom", model: "missing" } });`)).output).toContain("Choose an existing provider");

  expect((await turn(id, `return await ox.conversation.delete({ purpose: "Delete", id: ${JSON.stringify(started.result.id.slice(0, 24) + id.toString(16).padStart(12, "0"))} });`)).output).toContain("choose another existing conversation");
  const deleted = await value(id, `return await ox.conversation.delete({ purpose: "Delete", id: ${JSON.stringify(started.result.id)} });`, approve);
  conforms("ox.conversation.delete", deleted.result);
  expect(deleted.result).toEqual({ id: started.result.id, deleted: true });
  expect((await api(`/api/conversations/${other}`)).status).toBe(404);
}, 60_000);

test("Provider functions list, generate, authenticate without exposing keys, and manage saved definitions", async () => {
  const id = await conversation();
  const listed = await value<Record<string, unknown>[]>(id, `return await ox.provider.list({ purpose: "Providers" });`);
  conforms("ox.provider.list", listed.result);
  expect(listed.result[0]).toMatchObject({ id: "custom", name: "Scripted", source: "added", api: "openai-chat-completions", authentication: "optional", models: 2 });
  expect(listed.result.find(entry => entry.id === "anthropic")).toMatchObject({ source: "bundled", api: "anthropic-messages", authentication: "required" });
  const models = await value(id, `return await ox.provider.models({ purpose: "Models", id: "custom" });`);
  conforms("ox.provider.models", models.result);
  expect((models.result as unknown as { id: string; available: boolean }[]).map(entry => [entry.id, entry.available])).toEqual([["fixture", true], ["fixture-2", true]]);
  const described = await value(id, `const schema = await ox.provider.schema(); const defaults = await ox.provider.default({ purpose: "Defaults" }); const one = await ox.provider.get({ purpose: "Get", id: "custom" }); return { schema: Array.isArray(schema.anyOf), defaults: defaults.length, custom: defaults.some(entry => entry.id === "custom"), one };`);
  expect(described.result).toMatchObject({ schema: true, custom: false, one: { id: "custom", api: "openai-chat-completions", auth: { kind: "bearer", optional: true } } });
  expect(described.result.defaults as number).toBeGreaterThan(10);

  let since = requests.length;
  const generated = await value(id, `return await ox.provider.generate({ purpose: "Generate", id: "custom", model: "fixture", messages: [{ role: "user", content: "Say hi" }], maxOutputTokens: 64 });`, approve);
  conforms("ox.provider.generate", generated.result);
  expect(generated.result).toMatchObject({ id: "custom", model: "fixture", text: "generated: Say hi", stopReason: "stop", usage: { input: 20, output: 5, totalTokens: 25 } });
  expect(requests.slice(since).filter(entry => !entry.tools)).toEqual([{ model: "fixture", system: "", authorization: "Bearer none", tools: false }]);
  expect((await turn(id, `return await ox.provider.generate({ purpose: "Generate", id: "custom", model: "fixture", messages: [{ role: "user", content: "x" }], maxOutputTokens: 9000 });`)).output).toContain("invalid_argument");

  const authenticated = await value(id, `return await ox.provider.authenticate({ purpose: "Log in", id: "custom" });`, () => ({ values: { key: SECRET } }));
  conforms("ox.provider.authenticate", authenticated.result);
  expect(authenticated.result).toEqual({ id: "custom", status: "credential-stored" });
  expect(authenticated.prompts[0]!.prompt).toContain("Log in to Scripted");
  await turn(id, `return "with key";`);
  expect(requests.at(-1)!.authorization).toBe(`Bearer ${SECRET}`);
  const status = await value<Record<string, unknown>[]>(id, `return await ox.provider.list({ purpose: "Providers" });`);
  expect(status.result[0]).toMatchObject({ id: "custom", authentication: "credential-stored" });
  expect((await turn(id, `return await ox.provider.authenticate({ purpose: "Log in", id: "github-copilot" });`)).output).toContain("not_supported");
  const cancelled = await turn(id, `return await ox.provider.authenticate({ purpose: "Log in", id: "openai" });`, () => ({ cancel: true }));
  expect(cancelled.output).toContain("Provider authentication was cancelled.");
  expect(JSON.stringify(await read(`/api/conversations/${id}`))).not.toContain(SECRET);
  expect(JSON.stringify(await read("/api/settings"))).not.toContain(SECRET);
  expect((await filesContaining(data, SECRET)).map(path => path.slice(data.length))).toEqual(["/credentials.json"]);
  const signedOut = await value(id, `return await ox.provider.deauthenticate({ purpose: "Log out", id: "custom" });`);
  conforms("ox.provider.deauthenticate", signedOut.result);
  expect(signedOut.result).toEqual({ id: "custom", status: "optional" });
  expect(await readFile(join(data, "credentials.json"), "utf8")).not.toContain(SECRET);

  const definition = { id: "scripted-two", name: "Scripted Two", url: `http://127.0.0.1:${model.port}/v1`, api: "openai-chat-completions", auth: { kind: "none" },
    models: [{ id: "fixture-3", name: "Fixture 3", wireID: "fixture-wire", contextTokens: 32000, outputTokens: 2048 }] };
  expect((await value(id, `return await ox.provider.validate({ purpose: "Validate", provider: ${JSON.stringify(definition)} });`)).result).toEqual({ id: "scripted-two", valid: true });
  expect((await turn(id, `return await ox.provider.validate({ purpose: "Validate", provider: ${JSON.stringify({ ...definition, url: "http://10.0.0.5/v1" })} });`)).output).toContain("must be a public");
  expect((await turn(id, `return await ox.provider.validate({ purpose: "Validate", provider: ${JSON.stringify({ ...definition, options: { headers: { Authorization: "Bearer x" } } })} });`)).output).toContain("must not contain credentials");
  expect((await turn(id, `return await ox.provider.save({ purpose: "Save", provider: ${JSON.stringify({ ...definition, id: "openai" })} });`)).output).toContain("built-in provider");
  const saved = await value(id, `return await ox.provider.save({ purpose: "Save", provider: ${JSON.stringify(definition)} });`);
  conforms("ox.provider.save", saved.result);
  expect((await value<Record<string, unknown>[]>(id, `return await ox.provider.list({ purpose: "Providers" });`)).result.find(entry => entry.id === "scripted-two"))
    .toMatchObject({ source: "added", authentication: "not-required", inferenceLocation: "user-hosted" });
  since = requests.length;
  const second = await value(id, `return await ox.provider.generate({ purpose: "Generate", id: "scripted-two", model: "fixture-3", messages: [{ role: "user", content: "Hello" }, { role: "assistant", content: "Hi" }, { role: "user", content: "Again" }], systemPrompt: "Be brief.", maxOutputTokens: 32 });`, always);
  expect(second.result).toMatchObject({ id: "scripted-two", model: "fixture-3", text: "generated: Again" });
  expect(requests.slice(since).filter(entry => !entry.tools)).toEqual([{ model: "fixture-wire", system: "Be brief.", authorization: "Bearer none", tools: false }]);
  expect((await value(id, `return await ox.provider.generate({ purpose: "Generate", id: "scripted-two", model: "fixture-3", messages: [{ role: "user", content: "Once more" }], maxOutputTokens: 32 });`)).prompts).toHaveLength(0);
  const keyed = { ...definition, id: "scripted-key", auth: { kind: "bearer" } };
  const authentication = async () => (await value<Record<string, unknown>[]>(id, `return await ox.provider.list({ purpose: "Providers" });`)).result.find(entry => entry.id === "scripted-key")?.authentication;
  await value(id, `return await ox.provider.save({ purpose: "Save", provider: ${JSON.stringify(keyed)} });`);
  await value(id, `return await ox.provider.authenticate({ purpose: "Log in", id: "scripted-key" });`, () => ({ values: { key: `${SECRET}-keyed` } }));
  await value(id, `return await ox.provider.save({ purpose: "Rename", provider: ${JSON.stringify({ ...keyed, name: "Scripted Key" })} });`);
  expect(await authentication()).toBe("credential-stored");
  await value(id, `return await ox.provider.save({ purpose: "Repoint", provider: ${JSON.stringify({ ...keyed, url: `http://127.0.0.1:${model.port}/v2` })} });`);
  expect(await authentication()).toBe("required");
  expect(await readFile(join(data, "credentials.json"), "utf8")).not.toContain(`${SECRET}-keyed`);
  await value(id, `return await ox.provider.delete({ purpose: "Delete", id: "scripted-key" });`, approve);
  expect((await turn(id, `return await ox.provider.delete({ purpose: "Delete", id: "openai" });`)).output).toContain("Provider has no saved override: openai");
  const removed = await value(id, `return await ox.provider.delete({ purpose: "Delete", id: "scripted-two" });`, approve);
  conforms("ox.provider.delete", removed.result);
  expect(removed.result).toEqual({ id: "scripted-two", deleted: true });
  expect(JSON.parse(await readFile(join(data, "providers.json"), "utf8")).providers).toEqual([]);
  expect(JSON.parse(await readFile(profilePath("vm", "state", "action-policies.json"), "utf8")).actions).toEqual({ "ox.provider.generate": "allow", "ox.schedule.create": "allow" });
  expect(diagnostics).not.toMatch(/ error (skills|schedules|providers|conversation):| warning skills:|refresh failed/);
  expect(diagnostics).not.toContain(SECRET);
}, 60_000);

test("The app folder shows the Host's state without keys and changes saved services and the default model as on the phone", async () => {
  const id = await conversation();
  await value(id, `return await ox.provider.authenticate({ purpose: "Log in", id: "custom" });`, () => ({ values: { key: SECRET } }));
  const listed = await value<{ root: string[]; app: string[]; actions: string[] }>(id, `const names = async path => (await ox.fs.list({ purpose: "List", path })).items.map(item => item.name);
return { root: await names("/"), app: await names("app"), actions: await names("app/actions") };`);
  expect(listed.result.root).toContain("app");
  expect((await read<{ entries: { name: string }[] }>("/api/files?path=")).entries.map(entry => entry.name)).not.toContain("app");
  expect(listed.result.app.sort()).toEqual(["actions", "logs.jsonl", "policy.json", "providers.json", "services.json", "status.json"]);
  expect(listed.result.actions).toEqual(expect.arrayContaining(["ox.app.info.json", "ox.app.logs.json", "ox.provider.list.json", "ox.schedule.create.json"]));

  const reads = await value<Record<string, Record<string, unknown>>>(id, `const json = async path => JSON.parse((await ox.fs.read({ purpose: "Read", path })).text);
return { status: await json("app/status.json"), policy: await json("app/policy.json"), logs: await json("app/actions/ox.app.logs.json"),
  generate: await json("app/actions/" + encodeURIComponent("ox.provider.generate") + ".json"), providers: await json("app/providers.json"), services: await json("app/services.json") };`);
  expect(reads.prompts).toHaveLength(0);
  expect(reads.result.status).toMatchObject({ app: { name: "Ox", version: "0.1.0", platform: "linux" }, profiles: { profiles: [{ name: "Personal", storage: "local", active: true }], truncated: false },
    defaultModel: { provider: { id: "custom", name: "Scripted" }, model: { id: "fixture" }, supportsTools: true, authentication: { method: "apiKey", status: "ready" } },
    repositories: { status: "ready", truncated: false }, host: { allowConnections: true }, language: null, notifications: null });
  expect(reads.result.policy).toEqual({ format: 2, sources: {}, actions: { "ox.provider.generate": "allow", "ox.schedule.create": "allow" } });
  expect(reads.result.logs).toEqual({ defaultPolicy: null, resolved: { action: "ox.app.logs", source: "ox", policy: "ask", inheritedFrom: "actionDefault" }, overrides: [], truncated: false });
  expect(reads.result.generate).toMatchObject({ resolved: { policy: "allow", inheritedFrom: "action" }, overrides: [{ scope: "action", id: "ox.provider.generate", source: "ox", policy: "allow" }] });
  expect(reads.result.providers).toEqual({ format: 2, providers: [expect.objectContaining({ id: "custom", name: "Scripted", auth: { kind: "bearer", optional: true } })] });
  expect(reads.result.services).toEqual({ format: 1, names: {}, saved: [] });
  expect(JSON.stringify(reads.result)).not.toContain(SECRET);

  const saved = await value(id, `const file = await ox.fs.read({ purpose: "Read", path: "app/services.json" });
const next = JSON.parse(file.text);
next.names["amazon.com"] = "Shopping";
next.saved.push("amazon.com");
await ox.fs.write({ purpose: "Save services", path: "app/services.json", content: JSON.stringify(next) });
return JSON.parse((await ox.fs.read({ purpose: "Read", path: "app/services.json" })).text);`);
  expect(saved.result).toEqual({ format: 1, names: { "amazon.com": "Shopping" }, saved: ["amazon.com"] });
  const services = await read<{ services: { domain: string; name: string; saved: boolean }[] }>("/api/services");
  expect(services.services.find(service => service.domain === "amazon.com")).toMatchObject({ name: "Shopping", saved: true });
  expect((await turn(id, `const next = JSON.parse((await ox.fs.read({ purpose: "Read", path: "app/services.json" })).text);
next.names["missing.example"] = "Missing";
return await ox.fs.write({ purpose: "Save", path: "app/services.json", content: JSON.stringify(next) });`)).output).toContain("New service preferences must refer to existing services");
  const fresh = await conversation();
  expect((await turn(fresh, `return await ox.fs.write({ purpose: "Save", path: "app/services.json", content: JSON.stringify({ format: 1, names: {}, saved: [] }) });`)).output)
    .toContain("Read the app file before replacing it");

  const chosen = await value(id, `await ox.fs.edit({ purpose: "Default model", path: "app/providers.json", edits: [{ oldText: '"format": 2,', newText: '"defaultModel": { "modelID": "fixture-2", "providerID": "custom" },\\n  "format": 2,' }] });
return JSON.parse((await ox.fs.read({ purpose: "Read", path: "app/providers.json" })).text).defaultModel;`);
  expect(chosen.result).toEqual({ modelID: "fixture-2", providerID: "custom" });
  expect((await read<{ defaultModel: unknown }>("/api/settings")).defaultModel).toEqual({ provider: "custom", modelId: "fixture-2" });
  expect((await value(id, `return JSON.parse((await ox.fs.read({ purpose: "Read", path: "app/status.json" })).text).defaultModel;`)).result)
    .toMatchObject({ configured: true, model: { id: "fixture-2" } });
  expect((await turn(id, `return await ox.fs.edit({ purpose: "Rename", path: "app/providers.json", edits: [{ oldText: '"name": "Scripted"', newText: '"name": "Renamed"' }] });`)).output)
    .toContain("only with ox.provider.save and ox.provider.delete");
  expect((await turn(id, `return await ox.fs.edit({ purpose: "Default model", path: "app/providers.json", edits: [{ oldText: '"modelID": "fixture-2"', newText: '"modelID": "missing"' }] });`)).output)
    .toContain("custom/missing is not available");
  expect((await read<{ defaultModel: unknown }>("/api/settings")).defaultModel).toEqual({ provider: "custom", modelId: "fixture-2" });
  await value(id, `return await ox.provider.deauthenticate({ purpose: "Log out", id: "custom" });`);
  expect(diagnostics).not.toContain(SECRET);
}, 60_000);

test("App files refuse read-only and temporary changes, keep logs behind an approval, follow blocked Actions and give way to the Profile's own app folder", async () => {
  const id = await conversation();
  const readOnly = (await turn(id, `return await ox.fs.write({ purpose: "Save", path: "app/status.json", content: "{}" });`)).output;
  expect(readOnly).toContain("permission_denied");
  expect(readOnly).toContain("This app file is read-only.");
  expect((await turn(id, `return await ox.fs.rm({ purpose: "Delete", path: "app/services.json" });`)).output).toContain("App files do not support deletion");
  expect((await turn(id, `return await ox.fs.read({ purpose: "Read", path: "app/settings.json" });`)).output).toContain("each browser keeps its own language");

  const temporary = await api("/api/conversations", { method: "POST", json: { temporary: true } });
  const scratch = (await temporary.json() as { id: number }).id;
  const refused = (await turn(scratch, `const file = await ox.fs.read({ purpose: "Read", path: "app/services.json" });
return await ox.fs.write({ purpose: "Save", path: "app/services.json", content: file.text });`)).output;
  expect(refused).toContain("profile_required");
  expect(refused).toContain("Temporary conversations can't save changes.");
  expect((await api("/api/permissions", { method: "PUT", json: { scope: "action", id: "ox.provider.list", policy: "ask" } })).status).toBe(200);
  const unasked = await turn(scratch, `return await ox.fs.edit({ purpose: "Default model", path: "app/providers.json", edits: [{ oldText: '"format": 2', newText: '"format": 2 ' }] });`);
  expect(unasked.prompts).toHaveLength(0);
  expect(unasked.output).toContain("profile_required");
  expect((await api("/api/permissions", { method: "PUT", json: { scope: "action", id: "ox.provider.list", policy: null } })).status).toBe(200);

  const leaks = ["https://example.com/private/path?key=AIzaSy0123456789abcdefgh&q=1", "sk-0123456789abcdefghij"];
  for (const leak of leaks) expect((await api("/api/permissions", { method: "PUT", json: { scope: "action", id: leak, policy: "ask" } })).status).toBe(200);
  for (const leak of leaks) expect((await api("/api/permissions", { method: "PUT", json: { scope: "action", id: leak, policy: null } })).status).toBe(200);
  const denied = await turn(id, `return await ox.fs.read({ purpose: "Check logs", path: "app/logs.jsonl" });`, () => ({ answer: "Deny" }));
  expect(denied.prompts[0]!.prompt).toContain("Logs may include private data from other conversations");
  expect(denied.output).toContain("permission_denied");
  const logs = await value<{ lines: Record<string, unknown>[]; grep: { matches: { path: string }[]; diagnostics: { path: string }[] } }>(id,
    `const text = (await ox.fs.read({ purpose: "Check logs", path: "app/logs.jsonl" })).text;
return { lines: text.trim().split("\\n").map(line => JSON.parse(line)), grep: await ox.fs.grep({ purpose: "Search", path: "app", pattern: "info" }) };`, approve);
  expect(logs.prompts).toHaveLength(1);
  expect(logs.result.lines.some(line => line.category === "host" && String(line.message).startsWith("listening on"))).toBe(true);
  expect(Object.keys(logs.result.lines[0]!).sort()).toEqual(["category", "level", "message", "timestamp", "truncated"]);
  const permissions = logs.result.lines.map(line => String(line.message)).filter(message => message.startsWith("permission scope=action id=") && message.endsWith("policy=ask"));
  expect(permissions).toEqual(expect.arrayContaining(["permission scope=action id=https://example.com/private/path?keys=key,q policy=ask", "permission scope=action id=sk-<redacted> policy=ask"]));
  expect(JSON.stringify(logs.result.lines)).not.toMatch(/AIzaSy0123|sk-0123456789/);
  expect(logs.result.grep.matches.some(match => match.path.endsWith("logs.jsonl"))).toBe(false);
  expect(logs.result.grep.diagnostics.some(entry => entry.path.endsWith("app/logs.jsonl"))).toBe(true);

  expect((await api("/api/permissions", { method: "PUT", json: { scope: "action", id: "ox.app.info", policy: "block" } })).status).toBe(200);
  const blocked = (await turn(id, `return await ox.fs.read({ purpose: "Read", path: "app/status.json" });`)).output;
  expect(blocked).toContain("permission_denied");
  expect(blocked).toContain("ox.app.info: the user blocked this Action in Settings.");
  expect((await api("/api/permissions", { method: "PUT", json: { scope: "action", id: "ox.app.info", policy: null } })).status).toBe(200);
  expect((await api("/api/permissions", { method: "PUT", json: { scope: "action", id: "ox.provider.list", policy: "block" } })).status).toBe(200);
  expect((await turn(id, `return await ox.provider.list({ purpose: "Providers" });`)).output).toContain("ox.provider.list: the user blocked this Action in Settings.");
  expect((await api("/api/permissions", { method: "PUT", json: { scope: "action", id: "ox.provider.list", policy: null } })).status).toBe(200);

  await mkdir(profilePath("files", "app"), { recursive: true });
  await writeFile(profilePath("files", "app", "notes.txt"), "mine");
  const own = await value<string[]>(id, `return (await ox.fs.list({ purpose: "List", path: "app" })).items.map(item => item.name);`);
  expect(own.result).toEqual(["notes.txt"]);
  await rm(profilePath("files", "app"), { recursive: true });
}, 60_000);

test("Folder searches skip app files that need approval, and an app change waiting for approval doesn't hold other conversations' writes", async () => {
  const id = await conversation(), other = await conversation();
  const put = (action: string, policy: string | null) => api("/api/permissions", { method: "PUT", json: { scope: "action", id: action, policy } });
  await turn(id, `await ox.fs.write({ purpose: "Save", path: "/notes/needle.md", content: "find the needle here" }); return "saved";`);
  expect((await put("ox.app.actionPolicies", "ask")).status).toBe(200);
  expect((await put("ox.app.info", "block")).status).toBe(200);
  const searched = await value<{ matches: { path: string }[]; diagnostics: { path: string; message: string }[] }>(id,
    `return await ox.fs.grep({ purpose: "Search", path: "/", pattern: "needle|Shopping" });`);
  expect(searched.prompts).toHaveLength(0);
  const found = searched.result.matches.map(match => match.path.replace(/^\//, ""));
  expect(found).toEqual(expect.arrayContaining(["notes/needle.md", "app/services.json"]));
  const notes = Object.fromEntries(searched.result.diagnostics.map(entry => [entry.path.replace(/^\//, ""), entry.message]));
  expect(notes["app/status.json"]).toBe("Not searched: the user blocked App info (ox.app.info) in Settings.");
  expect(notes["app/policy.json"]).toContain("Actions (ox.app.actionPolicies) asks the user first");
  expect(notes["app/actions"]).toContain("Actions (ox.app.actionPolicies) asks the user first");
  expect(notes["app/logs.jsonl"]).toContain("excluded from directory searches");
  expect(Object.keys(notes).filter(path => path.startsWith("app/actions/"))).toEqual([]);
  const named = await value<{ info: string }>(id, `return { info: JSON.parse((await ox.fs.read({ purpose: "Read", path: "app/policy.json" })).text).actions["ox.app.info"] };`, approve);
  expect(named.prompts).toHaveLength(1);
  expect(named.result).toEqual({ info: "block" });
  expect((await turn(id, `return await ox.fs.attach({ purpose: "Attach", path: "app/services.json" });`)).output).toContain("App files cannot be attached or transferred.");
  expect((await put("ox.app.info", null)).status).toBe(200);
  expect((await put("ox.app.actionPolicies", null)).status).toBe(200);

  expect((await put("ox.app.setDefaultModel", "ask")).status).toBe(200);
  const sent = await api(`/api/conversations/${id}/messages`, { method: "POST", json: { text: script(`await ox.fs.edit({ purpose: "Default model", path: "app/providers.json", edits: [{ oldText: '"modelID": "fixture-2"', newText: '"modelID": "fixture"' }] });
return { changed: true };`) } });
  expect(sent.status).toBe(202);
  const waiting = await until(() => read<View>(`/api/conversations/${id}`), view => !!view.pendingPrompt);
  expect(waiting.pendingPrompt!.prompt).toContain("Change the default model for new conversations");
  const written = await turn(other, `const file = await ox.fs.write({ purpose: "Save", path: "notes.md", content: "while waiting" }); return { path: file.path };`);
  expect(written.output).toContain("notes.md");
  expect((await read<{ defaultModel: unknown }>("/api/settings")).defaultModel).toEqual({ provider: "custom", modelId: "fixture-2" });
  expect((await api(`/api/conversations/${id}/respond`, { method: "POST", json: { promptId: waiting.pendingPrompt!.id, answer: "Approve" } })).status).toBe(200);
  const done = await until(() => read<View>(`/api/conversations/${id}`), view => !view.busy);
  expect(lastText(done)).toContain("changed");
  expect((await read<{ defaultModel: unknown }>("/api/settings")).defaultModel).toEqual({ provider: "custom", modelId: "fixture" });
  expect((await put("ox.app.setDefaultModel", null)).status).toBe(200);
}, 90_000);

type Todo = { id: string; title: string; notes: string; completed: boolean; dueAt: string | null; timeZone: string | null; revision: number;
  reminder: "pending" | "sending" | "queued" | null; reminderQueuedAt: string | null };
type TodoReceipt = { todo: Todo; replayed: boolean };
const createTodo = (key: string, input: { title: string; notes?: string; dueAt?: string | null; timeZone?: string | null }) =>
  api("/api/todos", { method: "POST", headers: { "idempotency-key": key }, json: input });

test("Personal-agent Todos keep stable receipts, optimistic revisions and data across a Host restart", async () => {
  expect(await read("/api/todos")).toMatchObject({ available: true, todos: [] });
  const input = { title: "Prepare the meeting", notes: "Bring the reviewed agenda." };
  const response = await createTodo("workspace-todo-create", input);
  expect(response.status).toBe(201);
  const created = await response.json() as TodoReceipt;
  expect(created).toMatchObject({ replayed: false, todo: { ...input, completed: false, revision: 1, dueAt: null, reminder: null } });
  const repeated = await createTodo("workspace-todo-create", input);
  expect(repeated.status, JSON.stringify(await repeated.clone().json())).toBe(200);
  expect(await repeated.json()).toMatchObject({ replayed: true, todo: { id: created.todo.id } });
  expect((await createTodo("workspace-todo-create", { title: "Different intent" })).status).toBe(409);
  expect((await createTodo("workspace-invalid-zone", { title: "Bad zone", dueAt: new Date(Date.now() + 60_000).toISOString(), timeZone: "Not/AZone" })).status).toBe(400);
  expect((await createTodo("workspace-invalid-day", { title: "Bad date", dueAt: "2027-02-30T12:00:00Z", timeZone: "UTC" })).status).toBe(400);
  expect((await createTodo("workspace-offset-required", { title: "Ambiguous date", dueAt: "2027-02-28T12:00:00", timeZone: "UTC" })).status).toBe(400);

  const path = `/api/todos/${created.todo.id}`;
  const writes = await Promise.all(["Reviewed meeting", "Updated meeting"].map(title =>
    api(path, { method: "PATCH", json: { title, expectedRevision: 1 } })));
  expect(writes.map(item => item.status).sort()).toEqual([200, 409]);
  const updated = await read<Todo>(path);
  expect(updated.revision).toBe(2);
  expect(["Reviewed meeting", "Updated meeting"]).toContain(updated.title);
  await stopHost();
  host = await startHost();
  expect(await read<Todo>(path)).toEqual(updated);
  expect((await api(path, { method: "DELETE", json: { expectedRevision: 1 } })).status).toBe(409);
  expect((await api(path, { method: "DELETE", json: { expectedRevision: updated.revision } })).status).toBe(200);
  expect((await createTodo("workspace-todo-create", input)).status).toBe(409);
}, 30_000);

test("Personal-agent Todo tools require approval and return the same durable objects as the page API", async () => {
  type Policies = { builtIn: { actions: { id: string; label: string; default: string }[] } };
  const policies = await read<Policies>("/api/permissions");
  expect(policies.builtIn.actions.filter(action => action.id.startsWith("ox.todo.")).map(action => ({ id: action.id, default: action.default }))).toEqual([
    { id: "ox.todo.create", default: "ask" }, { id: "ox.todo.update", default: "ask" }, { id: "ox.todo.delete", default: "ask" },
  ]);
  const id = await conversation();
  const denied = await turn(id, `return await ox.todo.create({ purpose: "Create a todo", title: "Denied task" });`, () => ({ answer: "Deny" }));
  expect(denied.output).toContain("permission_denied");
  expect((await read<{ todos: Todo[] }>("/api/todos")).todos.some(todo => todo.title === "Denied task")).toBe(false);
  const created = await value<TodoReceipt>(id, `return await ox.todo.create({ purpose: "Create a todo", title: "Agent task", notes: "Saved on this Host." });`, approve);
  expect(created.prompts).toHaveLength(1);
  conforms("ox.todo.create", created.result);
  const task = created.result.todo;
  expect(await read<Todo>(`/api/todos/${task.id}`)).toMatchObject({ title: "Agent task", notes: "Saved on this Host.", completed: false });
  const listed = await value<{ todos: Todo[] }>(id, `return await ox.todo.list({ purpose: "List todos" });`);
  conforms("ox.todo.list", listed.result);
  expect(listed.result.todos.map(item => item.id)).toContain(task.id);
  const completed = await value<Todo>(id, `return await ox.todo.update({ purpose: "Complete todo", id: "${task.id}", expectedRevision: ${task.revision}, completed: true });`, approve);
  conforms("ox.todo.update", completed.result);
  expect(completed.result.completed).toBe(true);
  expect((await read<Todo>(`/api/todos/${task.id}`)).completed).toBe(true);
  const removed = await value(id, `return await ox.todo.delete({ purpose: "Delete todo", id: "${task.id}", expectedRevision: ${completed.result.revision} });`, approve);
  conforms("ox.todo.delete", removed.result);
  expect(removed.result).toEqual({ deleted: true });
}, 30_000);

test("Personal-agent due todos queue reminders without a model and completion suppresses an unsent reminder", async () => {
  const calls = requests.length;
  const cancelledResponse = await createTodo("workspace-todo-cancelled", { title: "Already handled", dueAt: new Date(Date.now() + 6_000).toISOString(), timeZone: "UTC" });
  expect(cancelledResponse.status).toBe(201);
  const cancelled = (await cancelledResponse.json() as TodoReceipt).todo;
  const dueResponse = await createTodo("workspace-todo-due", { title: "Take a short break", dueAt: new Date(Date.now() + 2_500).toISOString(), timeZone: "UTC" });
  expect(dueResponse.status).toBe(201);
  const due = (await dueResponse.json() as TodoReceipt).todo;
  expect(due.reminder).toBe("pending");
  expect((await api(`/api/todos/${cancelled.id}`, { method: "PATCH", json: { completed: true, expectedRevision: cancelled.revision } })).status).toBe(200);
  const queued = await until(() => read<Todo>(`/api/todos/${due.id}`), task => task.reminder === "queued");
  expect(queued.reminderQueuedAt).not.toBeNull();
  type Notices = { notifications: { id: string; targetUrl: string }[] };
  const inbox = await read<Notices>("/api/notifications");
  const reminder = inbox.notifications.find(notice => notice.targetUrl === `/#/todos/${due.id}`);
  expect(reminder).toBeDefined();
  expect(inbox.notifications.some(notice => notice.targetUrl === `/#/todos/${cancelled.id}`)).toBe(false);
  expect((await read<Todo>(`/api/todos/${cancelled.id}`)).reminder).toBeNull();
  expect(requests.length).toBe(calls);
  await stopHost();
  host = await startHost();
  expect((await read<Todo>(`/api/todos/${due.id}`)).reminderQueuedAt).toBe(queued.reminderQueuedAt);
  expect((await read<Notices>("/api/notifications")).notifications.filter(notice => notice.targetUrl === `/#/todos/${due.id}`)).toEqual([expect.objectContaining({ id: reminder!.id })]);
  expect((await read<Todo>(`/api/todos/${cancelled.id}`)).reminder).toBeNull();
  const reopened = await api(`/api/todos/${cancelled.id}`, { method: "PATCH", json: { completed: false, expectedRevision: (await read<Todo>(`/api/todos/${cancelled.id}`)).revision } });
  expect(reopened.status).toBe(200);
  expect(await reopened.json()).toMatchObject({ completed: false, reminder: null });
  for (const task of [queued, cancelled]) {
    const current = await read<Todo>(`/api/todos/${task.id}`);
    expect((await api(`/api/todos/${task.id}`, { method: "DELETE", json: { expectedRevision: current.revision } })).status).toBe(200);
  }
}, 30_000);

test("Personal-agent Todos are opt-in and disabling them preserves stored tasks and existing schedules", async () => {
  const response = await createTodo("workspace-todo-gate", { title: "Keep this task" });
  expect(response.status).toBe(201);
  const created = (await response.json() as TodoReceipt).todo;
  const schedules = await read("/api/schedules");
  await stopHost();
  host = await startHost(false);
  try {
    expect(await read("/api/todos")).toEqual({ available: false });
    expect(await read("/api/notifications")).toEqual({ available: false });
    expect((await createTodo("workspace-disabled-create", { title: "Must not be saved" })).status).toBe(503);
    expect(await read("/api/schedules")).toEqual(schedules);
    const policies = await read<{ builtIn: { actions: { id: string }[] } }>("/api/permissions");
    expect(policies.builtIn.actions.some(action => action.id.startsWith("ox.todo."))).toBe(false);
    const disabled = await value<{ available: boolean }>(await conversation(), `return { available: typeof ox.todo?.create === "function" };`);
    expect(disabled.result.available).toBe(false);
  } finally {
    await stopHost();
    host = await startHost();
  }
  expect(await read<Todo>(`/api/todos/${created.id}`)).toEqual(created);
  expect((await api(`/api/todos/${created.id}`, { method: "DELETE", json: { expectedRevision: created.revision } })).status).toBe(200);
}, 30_000);

test("Personal-agent notifications distinguish receipt from reading and share durable read state between authorized clients", async () => {
  type Notice = { id: string; targetUrl: string; readAt: string | null; createdAt: string };
  type Inbox = { available: boolean; notifications: Notice[]; unreadCount: number };
  expect((await api("/api/notifications")).status).toBe(200);
  const secondProcess = Bun.spawn([process.execPath, `${ROOT}/apps/linux/src/main.ts`, "token", "--name", "inbox-second", "--data", data], { stdout: "pipe" });
  const second = /OX_HOST_TOKEN=(\S+)/.exec(await new Response(secondProcess.stdout).text())![1]!;
  expect(await secondProcess.exited).toBe(0);
  const id = await conversation();
  expect((await api(`/api/conversations/${id}/messages`, { method: "POST", json: { text: "Prepare my next steps" } })).status).toBe(202);
  await until(() => read<View>(`/api/conversations/${id}`), view => !view.busy && lastText(view) !== "");
  const listed = await until(() => read<Inbox>("/api/notifications"), inbox => inbox.notifications.some(item => item.targetUrl === `/#/c/${id}`));
  const notice = listed.notifications.find(item => item.targetUrl === `/#/c/${id}`)!;
  expect(notice.readAt).toBeNull();
  expect(await read("/api/notifications?summary=1")).toEqual({ available: true, unreadCount: listed.unreadCount, limit: 1_000, warning: null });
  const path = `/api/notifications/${notice.id}`;
  expect((await read<Notice>(path)).readAt).toBeNull();
  const received = await api(path, { headers: { authorization: `Bearer ${second}` } });
  expect(received.status).toBe(200);
  expect((await received.json() as Notice).readAt).toBeNull();

  const controller = new AbortController();
  const events = await api("/api/events?tab=inbox-second-tab&visible=1", { headers: { authorization: `Bearer ${second}` }, signal: controller.signal });
  const reader = events.body!.getReader();
  await reader.read();
  let readAt: string;
  try {
    const marked = await api(`${path}/read`, { method: "PUT", json: {} });
    expect(marked.status).toBe(200);
    const current = await marked.json() as Notice;
    expect(current.readAt).not.toBeNull();
    readAt = current.readAt!;
    const event = await Promise.race([
      reader.read(),
      Bun.sleep(3_000).then(() => { throw new Error("The shared read receipt produced no stream event"); }),
    ]);
    expect(new TextDecoder().decode(event.value)).toContain("event: notifications");
    const other = await api(path, { headers: { authorization: `Bearer ${second}` } });
    expect((await other.json() as Notice).readAt).toBe(readAt);
    expect((await read<Inbox>("/api/notifications")).unreadCount).toBe(listed.unreadCount - 1);
    expect((await (await api(`${path}/read`, { method: "PUT", json: {} })).json() as Notice).readAt).toBe(readAt);
  } finally {
    controller.abort();
    await reader.cancel().catch(() => {});
  }
  await stopHost();
  host = await startHost();
  expect((await read<Notice>(path)).readAt).toBe(readAt!);
  const devices = await read<{ devices: { id: string; name: string }[] }>("/api/devices");
  const device = devices.devices.find(item => item.name === "inbox-second")!;
  expect((await api(`/api/devices/${device.id}`, { method: "DELETE" })).status).toBe(200);
  expect((await api(`${path}/read`, { method: "PUT", json: {}, headers: { authorization: `Bearer ${second}` } })).status).toBe(401);
  expect((await read<Notice>(path)).readAt).toBe(readAt!);
}, 30_000);

type ReviewCandidate = { id: string; revision: number; status: string; data: { type: string; text?: string; name?: string };
  origin: { kind: string; conversationId: number | null }; appliedAt: string | null };
type ReviewState = { available: boolean; settings: { revision: number; suggestionsEnabled: boolean }; candidates: ReviewCandidate[];
  memory: { text: string; revision: string } };
const reviewState = () => read<ReviewState>("/api/review");
const reviewDecision = (candidate: ReviewCandidate, revision: string) => api(`/api/review/${candidate.id}/accept`,
  { method: "POST", json: { expectedRevision: candidate.revision, expectedSourceRevision: revision } });
async function enableSuggestions() {
  const { settings } = await reviewState();
  if (!settings.suggestionsEnabled) expect((await api("/api/review/settings",
    { method: "PUT", json: { expectedRevision: settings.revision, suggestionsEnabled: true } })).status).toBe(200);
}

test("Muse chat attention NT-01 groups only canonical targets and rejects malformed or mismatched atomic reads", async () => {
  await stopHost(); host = await startHost(true, true);
  const first = await conversation(), second = await conversation();
  const notices = [
    attentionNotice(`/#/c/${first}`), attentionNotice(`/#/c/${second}`),
    ...[`/#/c/0${first}`, `/#/c/${first}?other=1`, `/#/c/${first}/extra`, "/#/c/9007199254740992",
      "/#/c/-1", `/#/todos/${crypto.randomUUID()}`, `/#/automations/${crypto.randomUUID()}`].map(target => attentionNotice(target)),
  ];
  await stopHost();
  await noticeFixture(records => { for (const notice of notices) records[notice.id] = notice; });
  host = await startHost(true, true);
  try {
    type Summary = { conversationCounts: { id: number; unreadCount: number }[] };
    const summary = await read<Summary>("/api/notifications?summary=1");
    expect(summary.conversationCounts.find(row => row.id === first)).toEqual({ id: first, unreadCount: 1 });
    expect(summary.conversationCounts.find(row => row.id === second)).toEqual({ id: second, unreadCount: 1 });
    expect(JSON.stringify(summary)).not.toMatch(/NT private|NT 私有|targetUrl|title|body/);
    const selected = await read(`/api/notifications?conversationId=${first}`);
    expect(selected).toEqual({ available: true, conversationId: first, ids: [notices[0]!.id], unreadCount: 1, limit: 1_000, warning: null });
    for (const target of ["-1", "1.5", "01", "9007199254740992", "NaN", "", `${first}&conversationId=${second}`]) {
      expect((await api(`/api/notifications?conversationId=${target}`)).status).toBe(400);
    }
    for (const input of [null, [], {}, { conversationId: first, ids: [] }, { conversationId: first, ids: ["invalid"] },
      { conversationId: first, ids: [notices[0]!.id, notices[0]!.id] }, { conversationId: String(first), ids: [notices[0]!.id] },
      { conversationId: first, ids: [notices[0]!.id], extra: true }]) {
      expect((await api("/api/notifications/read", { method: "PUT", json: input })).status).toBe(400);
    }
    expect((await api("/api/notifications/read", { method: "PUT", body: "not JSON", headers: { "content-type": "application/json" } })).status).toBe(400);
    expect((await api("/api/notifications/read", { method: "PUT", json: { conversationId: first, ids: [notices[0]!.id, notices[1]!.id] } })).status).toBe(409);
    expect((await api("/api/notifications/read", { method: "PUT", json: { conversationId: first, ids: [notices[0]!.id, crypto.randomUUID()] } })).status).toBe(404);
    expect((await api(`/api/notifications/${notices[0]!.id}/read`, { method: "PUT", body: "not JSON" })).status).toBe(400);
    expect((await api(`/api/notifications/${notices[0]!.id}/read`, { method: "PUT", json: { conversationId: second } })).status).toBe(400);
    expect((await api(`/api/notifications/${notices[0]!.id}/read?conversationId=${second}`, { method: "PUT", json: {} })).status).toBe(400);
    for (const notice of notices) expect((await read<InboxNotice>(`/api/notifications/${notice.id}`)).readAt).toBeNull();
    expect((await api("/api/notifications/read", { method: "PUT", json: { conversationId: first, ids: [notices[2]!.id] } })).status).toBe(409);
  } finally {
    await stopHost(); await noticeFixture(records => { for (const notice of notices) delete records[notice.id]; }); host = await startHost();
  }
}, 30_000);

test("Muse chat attention NT-02/03 reads only the matched snapshot with shared SSE, stable delivery and no conversation-read coupling", async () => {
  await stopHost(); host = await startHost(true, true);
  const id = await conversation(), calls = requests.length;
  const notices = [attentionNotice(`/#/c/${id}`, "pending"), attentionNotice(`/#/c/${id}`, "unknown"), attentionNotice(`/#/c/${id}`, "suppressed")];
  notices[1]!.delivery.attempts = { "old-device": { status: "unknown" } };
  notices[2]!.cancelledAt = new Date().toISOString();
  await stopHost(); await noticeFixture(records => { for (const notice of notices) records[notice.id] = notice; }); host = await startHost(true, true);
  const issued = Bun.spawn([process.execPath, `${ROOT}/apps/linux/src/main.ts`, "token", "--name", "NT second", "--data", data], { stdout: "pipe" });
  const second = /OX_HOST_TOKEN=(\S+)/.exec(await new Response(issued.stdout).text())![1]!;
  expect(await issued.exited).toBe(0);
  const snapshot = await read<{ ids: string[] }>(`/api/notifications?conversationId=${id}`);
  const before = await Promise.all(notices.map(notice => read<InboxNotice>(`/api/notifications/${notice.id}`)));
  expect(snapshot.ids.toSorted()).toEqual(notices.slice(0, 2).map(notice => notice.id).toSorted());
  expect(before.every(notice => notice.readAt === null)).toBe(true);
  expect((await api("/api/notifications/read", { method: "PUT", json: { conversationId: id, ids: [notices[0]!.id, notices[2]!.id] } })).status).toBe(409);
  expect((await read<InboxNotice>(`/api/notifications/${notices[0]!.id}`)).readAt).toBeNull();
  expect(requests.length).toBe(calls);
  expect((await api(`/api/conversations/${id}/messages`, { method: "POST", json: { text: "NT controlled original result" } })).status).toBe(202);
  await until(() => read<View>(`/api/conversations/${id}`), view => !view.busy && !!lastText(view));
  const newer = await until(() => read<{ notifications: InboxNotice[] }>("/api/notifications"),
    state => state.notifications.some(notice => notice.targetUrl === `/#/c/${id}` && !notices.some(old => old.id === notice.id)));
  const unseen = newer.notifications.find(notice => notice.targetUrl === `/#/c/${id}` && !notices.some(old => old.id === notice.id))!;
  const abort = new AbortController();
  const stream = await api("/api/events?tab=nt-second&visible=1", { signal: abort.signal, headers: { authorization: `Bearer ${second}` } });
  const reader = stream.body!.getReader(); await reader.read();
  try {
    const response = await api("/api/notifications/read", { method: "PUT", json: { conversationId: id, ids: snapshot.ids } });
    expect(response.status).toBe(200);
    const marked = await response.json() as { notifications: InboxNotice[] };
    expect(marked.notifications.map(notice => notice.id).toSorted()).toEqual(snapshot.ids.toSorted());
    expect(marked.notifications.every(notice => typeof notice.readAt === "string")).toBe(true);
    const event = await Promise.race([reader.read(), Bun.sleep(3_000).then(() => { throw new Error("Missing NT shared read SSE"); })]);
    expect(new TextDecoder().decode(event.value)).toContain("event: notifications");
    expect((await read<InboxNotice>(`/api/notifications/${unseen.id}`)).readAt).toBeNull();
    const repeat = await api("/api/notifications/read", { method: "PUT", json: { conversationId: id, ids: snapshot.ids }, headers: { authorization: `Bearer ${second}` } });
    expect(repeat.status).toBe(200); expect(await repeat.json()).toEqual(marked);
    const unknown = await read<InboxNotice>(`/api/notifications/${notices[1]!.id}`);
    expect(unknown.delivery).toEqual(before[1]!.delivery);
    expect((await read<InboxNotice>(`/api/notifications/${notices[2]!.id}`)).readAt).toBeNull();
    expect((await read<{ summary: { unread: boolean } }>(`/api/conversations/${id}`)).summary.unread).toBe(true);
    expect((await api(`/api/conversations/${id}/read`, { method: "POST" })).status).toBe(200);
    expect((await read<InboxNotice>(`/api/notifications/${unseen.id}`)).readAt).toBeNull();
    await stopHost(); host = await startHost(true, true);
    for (const notice of marked.notifications) expect(await read(`/api/notifications/${notice.id}`)).toEqual(notice);
    const device = (await read<{ devices: { id: string; name: string }[] }>("/api/devices")).devices.find(row => row.name === "NT second")!;
    expect((await api(`/api/devices/${device.id}`, { method: "DELETE" })).status).toBe(200);
    expect((await api("/api/notifications/read", { method: "PUT", json: { conversationId: id, ids: [unseen.id] },
      headers: { authorization: `Bearer ${second}` } })).status).toBe(401);
    expect((await read<InboxNotice>(`/api/notifications/${unseen.id}`)).readAt).toBeNull();
    expect(requests.length).toBe(calls + 1);
  } finally {
    abort.abort(); await reader.cancel().catch(() => {});
    await stopHost(); await noticeFixture(records => { for (const notice of notices) delete records[notice.id]; }); host = await startHost();
  }
}, 40_000);

test("Muse chat attention NT-01/04 keeps legacy unlinked notices and strict double gates without changing their owner", async () => {
  const calls = requests.length;
  const notice = attentionNotice(`/#/todos/${crypto.randomUUID()}`, "unknown");
  await stopHost(); await noticeFixture(records => { records[notice.id] = notice; }); host = await startHost(true, true);
  try {
    const readResponse = await api(`/api/notifications/${notice.id}/read`, { method: "PUT", json: {} });
    expect(readResponse.status).toBe(200);
    const marked = await readResponse.json() as InboxNotice;
    expect(marked.delivery).toEqual(notice.delivery); expect(marked.readAt).toBeString();
    await stopHost(); host = await startHost(true, false);
    expect((await read<Record<string, unknown>>("/api/notifications?summary=1")).conversationCounts).toBeUndefined();
    expect((await api("/api/notifications?conversationId=0")).status).toBe(503);
    expect((await api("/api/notifications/read", { method: "PUT", json: { conversationId: 0, ids: [notice.id] } })).status).toBe(503);
    expect(await read(`/api/notifications/${notice.id}`)).toEqual(marked);
    await stopHost(); host = await startHost(false, true);
    expect(await read("/api/notifications")).toEqual({ available: false });
    expect((await api("/api/notifications?conversationId=0")).status).toBe(503);
    expect((await api("/api/notifications/read", { method: "PUT", json: { conversationId: 0, ids: [notice.id] } })).status).toBe(503);
    await stopHost(); host = await startHost(true, true);
    expect(await read(`/api/notifications/${notice.id}`)).toEqual(marked);
    expect(requests.length).toBe(calls);
  } finally {
    await stopHost(); await noticeFixture(records => { delete records[notice.id]; }); host = await startHost();
  }
}, 30_000);

test("Reviewed suggestions keep model memory pending until owner publication and refresh the real MEMORY context", async () => {
  expect((await api("/api/review")).status).toBe(200);
  const initial = await reviewState();
  expect(initial.settings.suggestionsEnabled).toBe(false);
  expect((await api("/api/settings/memory", { method: "PUT", json: { text: "Manual owner note.\n" } })).status).toBe(200);
  expect((await api("/api/review/settings", { method: "PUT", json: { expectedRevision: initial.settings.revision, suggestionsEnabled: true } })).status).toBe(200);
  const id = await conversation();
  const proposed = await value<{ candidate: ReviewCandidate; replayed: boolean }>(id,
    `return await ox.memory.propose({ purpose: "Suggest a useful preference", text: "Prefer a concise morning briefing.", classification: "inferred", reason: "A suggestion for the owner to review." });`, approve);
  conforms("ox.memory.propose", proposed.result);
  expect(proposed.result.candidate).toMatchObject({ status: "pending", origin: { kind: "agent", conversationId: id } });
  expect((await read<{ text: string }>("/api/settings/memory")).text).toBe("Manual owner note.\n");
  const current = await reviewState(), candidate = proposed.result.candidate;
  const acceptedResponse = await reviewDecision(candidate, current.memory.revision);
  expect(acceptedResponse.status).toBe(200);
  const accepted = await acceptedResponse.json() as { candidate: ReviewCandidate };
  expect(accepted.candidate.status).toBe("accepted");
  expect(accepted.candidate.appliedAt).not.toBeNull();
  const memory = (await read<{ text: string }>("/api/settings/memory")).text;
  expect(memory).toContain("Manual owner note.");
  expect(memory.split("Prefer a concise morning briefing.")).toHaveLength(2);
  expect((await reviewDecision(candidate, current.memory.revision)).status).toBe(200);
  expect((await read<{ text: string }>("/api/settings/memory")).text).toBe(memory);
  await turn(id, `return { contextReloaded: true };`);
  expect(requests.at(-1)!.system).toContain("Prefer a concise morning briefing.");
  await stopHost();
  host = await startHost();
  const restored = await reviewState();
  expect(restored.candidates.find(item => item.id === candidate.id)).toMatchObject({ status: "accepted", appliedAt: accepted.candidate.appliedAt });
  expect(restored.memory.text).toBe(memory);
}, 30_000);

test("Reviewed suggestions refuse stale memory, preserve manual edits, and separate rejecting a draft from forgetting memory", async () => {
  expect((await api("/api/review")).status).toBe(200);
  const response = await api("/api/review", { method: "POST", headers: { "idempotency-key": "review-memory-owner" },
    json: { data: { type: "memory", text: "Track one public event at a time.", classification: "explicit" }, reason: "Entered by the owner." } });
  expect(response.status).toBe(201);
  const candidate = (await response.json() as { candidate: ReviewCandidate }).candidate, before = await reviewState();
  expect((await api("/api/settings/memory", { method: "PUT", json: { text: before.memory.text + "\nA concurrent manual edit." } })).status).toBe(200);
  expect((await reviewDecision(candidate, before.memory.revision)).status).toBe(409);
  const fresh = await reviewState();
  expect(fresh.candidates.find(item => item.id === candidate.id)?.status).toBe("pending");
  expect(fresh.memory.text).toContain("A concurrent manual edit.");
  expect((await reviewDecision(candidate, fresh.memory.revision)).status).toBe(200);
  const second = await api("/api/review", { method: "POST", headers: { "idempotency-key": "review-memory-reject" },
    json: { data: { type: "memory", text: "This proposal should not become memory.", classification: "inferred" }, reason: "Review only." } });
  const rejected = (await second.json() as { candidate: ReviewCandidate }).candidate;
  const memory = (await reviewState()).memory;
  expect((await api(`/api/review/${rejected.id}/reject`, { method: "POST", json: { expectedRevision: rejected.revision } })).status).toBe(200);
  const terminal = (await reviewState()).candidates.find(item => item.id === rejected.id)!;
  expect((await api(`/api/review/${rejected.id}`, { method: "DELETE", json: { expectedRevision: terminal.revision } })).status).toBe(200);
  expect((await reviewState()).memory).toEqual(memory);
  expect((await api("/api/review/memory", { method: "PUT", json: { text: "", expectedSourceRevision: before.memory.revision } })).status).toBe(409);
  expect((await api("/api/review/memory", { method: "PUT", json: { text: "Owner-edited memory only.", expectedSourceRevision: memory.revision } })).status).toBe(200);
  expect((await read<{ text: string }>("/api/settings/memory")).text).toBe("Owner-edited memory only.");
}, 30_000);

test("Reviewed Skill suggestions remain quarantined, publish through the existing Skill owner and refuse stale updates", async () => {
  expect((await api("/api/review")).status).toBe(200);
  await enableSuggestions();
  const id = await conversation();
  const proposed = await value<{ candidate: ReviewCandidate }>(id,
    `return await ox.skill.propose({ purpose: "Propose a reusable briefing workflow", operation: "create", name: "reviewed-brief", description: "Use for a short cited briefing.", instructions: "Read the explicitly selected sources, cite them, and report failures separately from no updates.", services: [], reason: "A proposed reusable workflow, not an installed skill." });`, approve);
  conforms("ox.skill.propose", proposed.result);
  expect(proposed.result.candidate.status).toBe("pending");
  expect((await read<{ skills: { name: string }[] }>("/api/skills")).skills.some(item => item.name === "reviewed-brief")).toBe(false);
  const detail = await read<{ source: { revision: string } }>(`/api/review/${proposed.result.candidate.id}`);
  expect((await reviewDecision(proposed.result.candidate, detail.source.revision)).status).toBe(200);
  const installed = await read<{ instructions: string; revision: string }>("/api/skills/reviewed-brief");
  expect(installed.instructions).toContain("report failures");
  const next = await api("/api/review", { method: "POST", headers: { "idempotency-key": "review-skill-update" },
    json: { data: { type: "skill", operation: "update", name: "reviewed-brief", description: "Use for a reviewed briefing.", instructions: "Proposed replacement instructions.", services: [] }, reason: "Explicit review." } });
  expect(next.status).toBe(201);
  const update = (await next.json() as { candidate: ReviewCandidate }).candidate;
  const source = await read<{ source: { revision: string } }>(`/api/review/${update.id}`);
  expect((await api("/api/skills/reviewed-brief", { method: "PUT", json: { description: "Manual change", instructions: "Keep this manual change.", revision: installed.revision } })).status).toBe(200);
  expect((await reviewDecision(update, source.source.revision)).status).toBe(409);
  expect((await read<{ instructions: string }>("/api/skills/reviewed-brief")).instructions).toBe("Keep this manual change.");
  expect((await api("/api/skills/reviewed-brief", { method: "DELETE" })).status).toBe(200);
}, 30_000);

test("Reviewed suggestions pause without changing legacy manual editing and stay unavailable with the preview off", async () => {
  expect((await api("/api/review")).status).toBe(200);
  await enableSuggestions();
  const initial = await reviewState();
  const temporary = (await (await api("/api/conversations", { method: "POST", json: { temporary: true } })).json() as { id: number }).id;
  const temporaryDenied = await turn(temporary, `return await ox.memory.propose({ purpose: "Temporary context", text: "Do not retain temporary context.", classification: "inferred", reason: "Temporary conversation." });`);
  expect(temporaryDenied.output).toContain("Temporary conversations cannot retain");
  expect((await reviewState()).candidates).toHaveLength(initial.candidates.length);
  expect((await api(`/api/conversations/${temporary}`, { method: "DELETE" })).status).toBe(200);
  expect((await api("/api/review/settings", { method: "PUT", json: { expectedRevision: initial.settings.revision, suggestionsEnabled: false } })).status).toBe(200);
  const id = await conversation();
  const denied = await turn(id, `return await ox.memory.propose({ purpose: "A paused suggestion", text: "Do not retain this.", classification: "inferred", reason: "The workflow is paused." });`);
  expect(denied.output).toContain("permission_denied");
  const current = (await reviewState()).memory;
  expect((await api("/api/review/memory", { method: "PUT", json: { text: "Manual edit while suggestions are paused.", expectedSourceRevision: current.revision } })).status).toBe(200);
  const saved = await reviewState();
  await stopHost();
  host = await startHost(false);
  try {
    expect(await read("/api/review")).toEqual({ available: false });
    const absent = await value<{ memory: boolean; skill: boolean }>(await conversation(),
      `return { memory: typeof ox.memory?.propose === "function", skill: typeof ox.skill.propose === "function" };`);
    expect(absent.result).toEqual({ memory: false, skill: false });
  } finally { await stopHost(); host = await startHost(); }
  expect((await reviewState()).memory).toEqual(saved.memory);
}, 30_000);

type Watch = { id: string; name: string; url: string; selector: string | null; intervalMinutes: number; enabled: boolean; revision: number; checking: boolean;
  fingerprint: string | null; lastOutcome: string; lastCheckedAt: string | null; lastSuccessAt: string | null; lastError: string | null; nextCheckAt: string | null };
type WatchState = { available: boolean; watches: Watch[]; running: number };
const watchURL = () => `http://127.0.0.1:${model.port}/watch-page`;
const watchState = () => read<WatchState>("/api/watches");
const watchCheck = async (id: string) => {
  const current = await read<Watch>(`/api/watches/${id}`);
  return api(`/api/watches/${id}/check`, { method: "POST", json: { expectedRevision: current.revision } });
};
async function createWatch(key: string, extra: Record<string, unknown> = {}) {
  const response = await api("/api/watches", { method: "POST", headers: { "idempotency-key": key },
    json: { name: key, url: watchURL(), selector: "#score", intervalMinutes: 5, ...extra } });
  expect(response.status).toBe(201);
  return (await response.json() as { watch: Watch }).watch;
}

test("Conversational page watches share approved CRUD, per-call receipts and current owner revisions", async () => {
  const id = await conversation();
  expect((await value<{ ready: boolean }>(id, `return { ready: typeof ox.watch?.create === "function" };`)).result.ready).toBe(true);
  const before = (await watchState()).watches.length;
  const draft = { name: "First agent watch", url: watchURL(), selector: "#score", intervalMinutes: 5 };
  const made = await value<{ first: { watch: Watch; replayed: boolean }; second: { watch: Watch; replayed: boolean } }>(id,
    `const first = await ox.watch.create(${JSON.stringify({ purpose: "Save a public page watch", ...draft })});
     const second = await ox.watch.create(${JSON.stringify({ purpose: "Save another public page watch", ...draft, name: "Second agent watch" })});
     return { first, second };`, approve);
  const first = made.result.first.watch, second = made.result.second.watch;
  try {
    expect(made.prompts).toHaveLength(2);
    for (const receipt of Object.values(made.result)) {
      conforms("ox.watch.create", receipt);
      expect(receipt).toMatchObject({ replayed: false, watch: { enabled: false, checking: false, nextCheckAt: null, fingerprint: null } });
    }
    expect(first.id).not.toBe(second.id);
    expect((await watchState()).watches).toHaveLength(before + 2);
    expect(await read<Watch>(`/api/watches/${first.id}`)).toEqual(first);
    const listed = await value<{ watches: Watch[]; running: number; warning: string | null }>(id,
      `return await ox.watch.list({ purpose:"Inspect current public page watches" });`, approve);
    conforms("ox.watch.list", listed.result);
    expect(listed.prompts).toHaveLength(1);
    expect(listed.result.watches.map(watch => watch.id)).toEqual(expect.arrayContaining([first.id, second.id]));
    expect(listed.result).toMatchObject({ running: 0, warning: null });
    expect((await api(`/api/watches/${first.id}`, { method: "PATCH", json: { expectedRevision: first.revision, name: "Owner edited watch" } })).status).toBe(200);
    const stale = await turn(id, `return await ox.watch.update(${JSON.stringify({ purpose: "Pause the watch", id: first.id, expectedRevision: first.revision, enabled: false })});`, approve);
    expect(stale.output).toContain("conflict");
    const current = await read<Watch>(`/api/watches/${first.id}`);
    expect(current.name).toBe("Owner edited watch");
    const edited = await value<Watch>(id, `return await ox.watch.update(${JSON.stringify({
      purpose: "Rename the public page watch", id: first.id, expectedRevision: current.revision, name: "Agent edited watch",
    })});`, approve);
    conforms("ox.watch.update", edited.result);
    expect(await read<Watch>(`/api/watches/${first.id}`)).toEqual(edited.result);
    const denied = await turn(id, `return await ox.watch.delete(${JSON.stringify({
      purpose: "Delete the public page watch", id: first.id, expectedRevision: edited.result.revision,
    })});`, () => ({ answer: "Deny" }));
    expect(denied.output).toContain("permission_denied");
    expect(await read<Watch>(`/api/watches/${first.id}`)).toEqual(edited.result);
    const deleted = await value(id, `return await ox.watch.delete(${JSON.stringify({
      purpose: "Delete the public page watch", id: first.id, expectedRevision: edited.result.revision,
    })});`, approve);
    conforms("ox.watch.delete", deleted.result);
    expect(deleted.result).toEqual({ deleted: true });
    expect((await api(`/api/watches/${first.id}`)).status).toBe(404);
  } finally {
    for (const watch of (await watchState()).watches.filter(watch => [first.id, second.id].includes(watch.id))) {
      expect((await api(`/api/watches/${watch.id}`, { method: "DELETE", json: { expectedRevision: watch.revision } })).status).toBe(200);
    }
  }
}, 60_000);

test("Conversational page watches enforce denied, invalid, temporary and disabled boundaries before background work", async () => {
  const policies = await read<{ builtIn: { actions: { id: string; default: string }[] } }>("/api/permissions");
  expect(policies.builtIn.actions.filter(action => action.id.startsWith("ox.watch.")).map(action => [action.id, action.default]).sort()).toEqual(
    ["create", "delete", "list", "update"].map(name => [`ox.watch.${name}`, "ask"]).sort());
  const id = await conversation(), before = await watchState(), reads = watchedPage.cookies.length;
  const draft = { purpose: "Watch a public page", name: "Must not be retained", url: watchURL(), intervalMinutes: 5 };
  const denied = await turn(id, `return await ox.watch.create(${JSON.stringify(draft)});`, () => ({ answer: "Deny" }));
  expect(denied.output).toContain("permission_denied");
  for (const input of [{ ...draft, url: "http://127.0.0.2/private" }, { ...draft, url: "https://owner:password@example.org/" }, { ...draft, intervalMinutes: 1 }]) {
    expect((await turn(id, `return await ox.watch.create(${JSON.stringify(input)});`)).output).toContain("invalid_argument");
  }
  expect((await api("/api/permissions", { method: "PUT", json: { scope: "action", id: "ox.watch.create", policy: "block" } })).status).toBe(200);
  try { expect((await turn(id, `return await ox.watch.create(${JSON.stringify(draft)});`)).output).toContain("permission_denied"); }
  finally { expect((await api("/api/permissions", { method: "PUT", json: { scope: "action", id: "ox.watch.create", policy: null } })).status).toBe(200); }
  const temporary = (await (await api("/api/conversations", { method: "POST", json: { temporary: true } })).json() as { id: number }).id;
  try {
    expect((await turn(temporary, `return await ox.watch.create(${JSON.stringify(draft)});`)).output).toContain("Temporary conversations cannot");
  } finally { expect((await api(`/api/conversations/${temporary}`, { method: "DELETE" })).status).toBe(200); }
  expect(await watchState()).toEqual(before);
  expect(watchedPage.cookies).toHaveLength(reads);
  const kept = await createWatch("agent-watch-off-preservation");
  await stopHost(); host = await startHost(false);
  try {
    const absent = await value<{ namespace: string; help: boolean }>(await conversation(),
      `return { namespace: typeof ox.watch, help: ox.help().includes("ox.watch.") };`);
    expect(absent.result).toEqual({ namespace: "undefined", help: false });
    const off = await read<{ builtIn: { actions: { id: string }[] } }>("/api/permissions");
    expect(off.builtIn.actions.some(action => action.id.startsWith("ox.watch."))).toBe(false);
    expect(await read("/api/watches")).toEqual({ available: false });
  } finally { await stopHost(); host = await startHost(); }
  expect(await read<Watch>(`/api/watches/${kept.id}`)).toEqual(kept);
  expect((await api(`/api/watches/${kept.id}`, { method: "DELETE", json: { expectedRevision: kept.revision } })).status).toBe(200);
}, 60_000);

test("Conversational page watches enable only explicit approved reads and share anonymous change notices without model work", async () => {
  const id = await conversation();
  expect((await value<{ ready: boolean }>(id, `return { ready: typeof ox.watch?.create === "function" };`)).result.ready).toBe(true);
  watchedPage.version = 1; watchedPage.status = 200; watchedPage.cookies = []; watchedPage.sideEffects = 0;
  const pages = await read("/api/pages");
  const created = await value<{ watch: Watch; replayed: boolean }>(id, `return await ox.watch.create(${JSON.stringify({
    purpose: "Enable agreed public page text monitoring", name: "Approved public page", url: watchURL(), selector: "#score", intervalMinutes: 5, enabled: true,
  })});`, approve);
  conforms("ox.watch.create", created.result);
  const watch = created.result.watch, path = `/api/watches/${watch.id}`;
  const notices = async () => (await read<{ notifications: { id: string; tag: string }[] }>("/api/notifications")).notifications.filter(notice => notice.tag === `watch-${watch.id}`);
  try {
    const baseline = await until(() => read<Watch>(path), value => value.lastOutcome === "baseline");
    expect(await notices()).toHaveLength(0);
    expect(baseline.enabled).toBe(true);
    const paused = await value<Watch>(id, `return await ox.watch.update(${JSON.stringify({
      purpose: "Pause the public page watch", id: watch.id, expectedRevision: baseline.revision, enabled: false,
    })});`, approve);
    expect(paused.result.enabled).toBe(false);
    const modelRequests = requests.length;
    watchedPage.version = 2;
    expect((await watchCheck(watch.id)).status).toBe(200);
    const changed = await read<Watch>(path);
    expect(changed.lastOutcome).toBe("changed");
    expect(await notices()).toHaveLength(1);
    expect((await watchCheck(watch.id)).status).toBe(200);
    expect(await notices()).toHaveLength(1);
    expect(requests).toHaveLength(modelRequests);
    expect(watchedPage.cookies.length).toBeGreaterThan(0);
    expect(watchedPage.cookies.every(cookie => cookie === null)).toBe(true);
    expect(watchedPage.sideEffects).toBe(0);
    expect(await read("/api/pages")).toEqual(pages);
    const listed = await value(id, `return await ox.watch.list({purpose:"Read the latest monitoring status"});`, approve);
    conforms("ox.watch.list", listed.result);
    expect(JSON.stringify(listed.result)).not.toContain("Fixture score 2");
  } finally {
    const current = await read<Watch>(path);
    expect((await api(path, { method: "DELETE", json: { expectedRevision: current.revision } })).status).toBe(200);
  }
}, 60_000);

test("Conversational page watches preserve complete bounded approval scopes for long create and update requests", async () => {
  const url = `https://example.org/${"p".repeat(1_980)}`, selector = `#${"s".repeat(1_998)}`;
  const response = await api("/api/watches", { method: "POST", headers: { "idempotency-key": "long-watch-owner" },
    json: { name: "Long owner watch", url, selector, intervalMinutes: 5 } });
  expect(response.status).toBe(201);
  const existing = (await response.json() as { watch: Watch }).watch;
  type ApprovalView = View & { blocks: { kind: { title?: string; detail?: string } }[] };
  try {
    for (const action of ["create", "update"]) {
      const id = await conversation(), args = { purpose: "Confirm the complete long watch scope", name: "Long proposed watch", url, selector, intervalMinutes: 5, enabled: false,
        ...(action === "update" ? { id: existing.id, expectedRevision: existing.revision } : {}) };
      expect((await api(`/api/conversations/${id}/messages`, { method: "POST", json: { text: script(`return await ox.watch.${action}(${JSON.stringify(args)});`) } })).status).toBe(202);
      const pending = await until(() => read<ApprovalView>(`/api/conversations/${id}`), view => !!view.pendingPrompt && view.blocks.some(block => !!block.kind.detail));
      try {
        const detail = pending.blocks.find(block => block.kind.title === (action === "create" ? "Create a page watch" : "Update a page watch"))!.kind.detail!;
        expect(detail.length).toBeGreaterThan(4_000);
        expect(detail.length).toBeLessThanOrEqual(32_768);
        expect(detail.endsWith("}")).toBe(true);
        const target = JSON.parse(detail) as { url: string; selector: string; enabled: boolean; current?: { url: string; selector: string } };
        expect(target).toMatchObject({ url, selector, enabled: false });
        if (action === "update") expect(target.current).toMatchObject({ url, selector });
      } finally {
        expect((await api(`/api/conversations/${id}/respond`, { method: "POST", json: { promptId: pending.pendingPrompt!.id, answer: "Deny" } })).status).toBe(200);
        await until(() => read<View>(`/api/conversations/${id}`), view => !view.busy);
      }
    }
    expect(await read<Watch>(`/api/watches/${existing.id}`)).toEqual(existing);
  } finally { expect((await api(`/api/watches/${existing.id}`, { method: "DELETE", json: { expectedRevision: existing.revision } })).status).toBe(200); }
}, 60_000);

test("Public-page watches keep paused owner CRUD, stable receipts and data across restart and disabled preview", async () => {
  expect((await api("/api/watches")).status).toBe(200);
  const watch = await createWatch("public-watch-owner");
  expect(watch).toMatchObject({ enabled: false, checking: false, fingerprint: null, lastOutcome: "never", nextCheckAt: null });
  const replay = await api("/api/watches", { method: "POST", headers: { "idempotency-key": "public-watch-owner" },
    json: { name: "public-watch-owner", url: watchURL(), selector: "#score", intervalMinutes: 5 } });
  expect(replay.status).toBe(200);
  expect((await replay.json() as { watch: Watch }).watch.id).toBe(watch.id);
  const path = `/api/watches/${watch.id}`;
  expect((await api(path, { method: "PATCH", json: { expectedRevision: watch.revision, name: "Renamed public watch" } })).status).toBe(200);
  expect((await api(path, { method: "PATCH", json: { expectedRevision: watch.revision, enabled: true } })).status).toBe(409);
  for (const url of ["http://127.0.0.2/private", "file:///etc/passwd", "https://owner:password@example.org/"]) {
    expect((await api("/api/watches", { method: "POST", headers: { "idempotency-key": crypto.randomUUID() },
      json: { name: "Rejected URL", url, intervalMinutes: 5 } })).status).toBe(400);
  }
  const summary = JSON.stringify(await read("/api/watches?summary=1"));
  expect(summary).not.toContain("Renamed public watch");
  expect(summary).not.toContain(watchURL());
  await stopHost();
  host = await startHost(false);
  try {
    expect(await read("/api/watches")).toEqual({ available: false });
    expect((await api(path, { method: "PATCH", json: { expectedRevision: 2, enabled: true } })).status).toBe(503);
  } finally { await stopHost(); host = await startHost(); }
  const restored = await read<Watch>(path);
  expect(restored).toMatchObject({ name: "Renamed public watch", enabled: false, fingerprint: null });
  expect((await api(path, { method: "DELETE", json: { expectedRevision: restored.revision } })).status).toBe(200);
  expect((await api("/api/watches", { method: "POST", headers: { "idempotency-key": "public-watch-owner" },
    json: { name: "public-watch-owner", url: watchURL(), selector: "#score", intervalMinutes: 5 } })).status).toBe(409);
}, 30_000);

test("Public-page watches use a real anonymous browser baseline, atomic change notices and explicit failures without a model", async () => {
  expect((await api("/api/watches")).status).toBe(200);
  await value(await conversation(), `return await ox.web.browser.navigate({ purpose: "Seed the existing fixture browser", url: ${JSON.stringify(`http://127.0.0.1:${model.port}/watch-seed`)} });`, approve);
  const pages = await read("/api/pages"), modelRequests = requests.length;
  watchedPage.version = 1; watchedPage.status = 200; watchedPage.cookies = []; watchedPage.sideEffects = 0;
  const watch = await createWatch("public-watch-observe");
  const notices = async () => (await read<{ notifications: { id: string; tag: string; targetUrl: string }[] }>("/api/notifications")).notifications.filter(notice => notice.tag === `watch-${watch.id}`);
  expect((await watchCheck(watch.id)).status).toBe(200);
  const baseline = await read<Watch>(`/api/watches/${watch.id}`);
  expect(baseline.lastOutcome).toBe("baseline");
  expect(baseline.fingerprint).not.toBeNull();
  expect(baseline.lastSuccessAt).not.toBeNull();
  expect(await notices()).toHaveLength(0);
  expect((await watchCheck(watch.id)).status).toBe(200);
  expect((await read<Watch>(`/api/watches/${watch.id}`)).lastOutcome).toBe("unchanged");
  watchedPage.version = 2;
  expect((await watchCheck(watch.id)).status).toBe(200);
  const changed = await read<Watch>(`/api/watches/${watch.id}`);
  expect(changed.lastOutcome).toBe("changed");
  const queued = await notices();
  expect(queued).toHaveLength(1);
  expect(queued[0]!.targetUrl).toBe(`/#/automations/${watch.id}`);
  expect((await watchCheck(watch.id)).status).toBe(200);
  expect((await notices()).map(notice => notice.id)).toEqual(queued.map(notice => notice.id));
  const successful = await read<Watch>(`/api/watches/${watch.id}`);
  watchedPage.status = 503;
  expect((await watchCheck(watch.id)).status).toBe(502);
  const failed = await read<Watch>(`/api/watches/${watch.id}`);
  expect(failed.lastOutcome).toBe("failed");
  expect(failed.fingerprint).toBe(successful.fingerprint);
  expect(failed.lastSuccessAt).toBe(successful.lastSuccessAt);
  expect(failed.lastError).toContain("503");
  watchedPage.status = 200;
  expect((await watchCheck(watch.id)).status).toBe(200);
  expect(await notices()).toHaveLength(1);
  const redirected = await createWatch("public-watch-redirect", { url: `http://127.0.0.1:${model.port}/watch-redirect` });
  expect((await watchCheck(redirected.id)).status).toBe(502);
  expect((await read<Watch>(`/api/watches/${redirected.id}`)).lastOutcome).toBe("failed");
  expect(watchedPage.cookies.length).toBeGreaterThan(0);
  expect(watchedPage.cookies.every(cookie => cookie === null)).toBe(true);
  expect(watchedPage.sideEffects).toBe(0);
  expect(await read("/api/pages")).toEqual(pages);
  expect(requests).toHaveLength(modelRequests);
}, 60_000);

test("Public-page watches run an enabled baseline without a model and discard an in-flight result after pause", async () => {
  expect((await api("/api/watches")).status).toBe(200);
  watchedPage.held = true; watchedPage.status = 200;
  const before = requests.length;
  try {
    const watch = await createWatch("public-watch-inflight", { enabled: true });
    const checking = await until(() => read<Watch>(`/api/watches/${watch.id}`), value => value.checking && watchedPage.waiting.size > 0);
    expect((await api(`/api/watches/${watch.id}`, { method: "PATCH", json: { expectedRevision: checking.revision, enabled: false } })).status).toBe(200);
    watchedPage.held = false;
    for (const release of watchedPage.waiting) release();
    watchedPage.waiting.clear();
    await until(watchState, state => state.running === 0);
    const paused = await read<Watch>(`/api/watches/${watch.id}`);
    expect(paused).toMatchObject({ enabled: false, fingerprint: null, nextCheckAt: null });
    const inbox = await read<{ notifications: { tag: string }[] }>("/api/notifications");
    expect(inbox.notifications.some(notice => notice.tag === `watch-${watch.id}`)).toBe(false);
    expect((await api(`/api/watches/${watch.id}`, { method: "PATCH", json: { expectedRevision: paused.revision, enabled: true } })).status).toBe(200);
    const baseline = await until(() => read<Watch>(`/api/watches/${watch.id}`), value => value.lastOutcome === "baseline");
    expect(Date.parse(baseline.nextCheckAt!) - Date.now()).toBeGreaterThan(240_000);
    expect(requests).toHaveLength(before);
    expect((await api(`/api/watches/${watch.id}`, { method: "PATCH", json: { expectedRevision: baseline.revision, enabled: false } })).status).toBe(200);
  } finally {
    watchedPage.held = false;
    for (const release of watchedPage.waiting) release();
    watchedPage.waiting.clear();
  }
}, 60_000);

test("Personal-agent overview Todo summaries expose counts without private titles or notes and never invoke a model", async () => {
  const response = await api("/api/todos", { method: "POST", headers: { "idempotency-key": "overview-summary-proof" },
    json: { title: "Private overview title", notes: "private-dashboard-note-do-not-include" } });
  expect(response.status).toBe(201);
  const { todo } = await response.json() as { todo: { id: string; revision: number } };
  try {
    const before = requests.length, summaryResponse = await api("/api/todos?summary=1");
    expect(summaryResponse.status).toBe(200);
    const text = await summaryResponse.text();
    expect(text).not.toContain("private-dashboard-note-do-not-include");
    expect(text).not.toContain("Private overview title");
    const summary = JSON.parse(text) as { available: boolean; total: number; open: number; completed: number };
    expect(summary.available).toBe(true);
    expect(summary.open).toBeGreaterThan(0);
    expect(summary.total).toBe(summary.open + summary.completed);
    expect(requests).toHaveLength(before);
  } finally { expect((await api(`/api/todos/${todo.id}`, { method: "DELETE", json: { expectedRevision: todo.revision } })).status).toBe(200); }
}, 30_000);

const ownerScheduleDraft = (name: string) => ({ name, prompt: "private-owner-schedule-prompt", condition: null, deadline: null,
  recurrence: { type: "interval", seconds: 3_600 } });
const ownerScheduleCreate = (key: string, draft = ownerScheduleDraft(key)) => api("/api/schedules", {
  method: "POST", headers: { "idempotency-key": key }, json: draft,
});

test("Unified automations create owner schedules paused with stable receipts and no model request", async () => {
  const before = requests.length, draft = ownerScheduleDraft("Owner digest");
  const response = await ownerScheduleCreate("owner-schedule-receipt", draft);
  expect(response.status).toBe(201);
  const created = await response.json() as { schedule: Row; replayed: boolean };
  expect(created.replayed).toBe(false);
  expect(created.schedule).toMatchObject({ name: "Owner digest", state: "paused", lastRunAt: null, lastOutcome: null, conversationId: null });
  const replay = await ownerScheduleCreate("owner-schedule-receipt", draft);
  expect(replay.status).toBe(200);
  expect((await replay.json() as { schedule: Row }).schedule.id).toBe(created.schedule.id);
  expect((await ownerScheduleCreate("owner-schedule-receipt", { ...draft, prompt: "Different intent" })).status).toBe(409);
  expect(requests).toHaveLength(before);
  expect((await api(`/api/schedules/${created.schedule.id}`, { method: "DELETE" })).status).toBe(200);
  expect((await ownerScheduleCreate("owner-schedule-receipt", draft)).status).toBe(409);
}, 30_000);

test("Unified automation summaries count existing scheduled jobs without exposing names or prompts", async () => {
  const created = await value(await conversation(), `return await ox.schedule.create({ purpose:"Set up a future schedule", name:"Private scheduled title", frequency:"interval", intervalSeconds:3600, prompt:"private-summary-schedule-prompt" });`, approve);
  const id = String(created.result.id);
  try {
    const before = requests.length, response = await api("/api/schedules?summary=1"), text = await response.text();
    expect(response.status).toBe(200);
    expect(text).not.toContain("private-summary-schedule-prompt");
    expect(text).not.toContain("Private scheduled title");
    const summary = JSON.parse(text) as { total: number; enabled: number; attention: number };
    const { schedules } = await read<{ schedules: Row[] }>("/api/schedules");
    expect(summary.total).toBe(schedules.length);
    expect(summary.enabled).toBe(schedules.filter(row => ["active", "running"].includes(row.state)).length);
    expect(requests).toHaveLength(before);
  } finally { expect((await api(`/api/schedules/${id}`, { method: "DELETE" })).status).toBe(200); }
}, 30_000);

test("Unified automation owner receipts survive edits and restart while default-off legacy scheduling stays available", async () => {
  const draft = ownerScheduleDraft("Persisted owner schedule"), response = await ownerScheduleCreate("owner-schedule-restart", draft);
  expect(response.status).toBe(201);
  const { schedule } = await response.json() as { schedule: Row }, path = `/api/schedules/${schedule.id}`;
  expect((await api(path, { method: "PATCH", json: { ...draft, name: "Owner edited schedule" } })).status).toBe(200);
  await stopHost(); host = await startHost();
  const replay = await ownerScheduleCreate("owner-schedule-restart", draft);
  expect(replay.status).toBe(200);
  expect((await replay.json() as { schedule: Row }).schedule).toMatchObject({ id: schedule.id, name: "Owner edited schedule", state: "paused" });
  await stopHost(); host = await startHost(false);
  try {
    expect((await ownerScheduleCreate("owner-schedule-off", draft)).status).toBe(404);
    const { schedules } = await read<{ schedules: Row[] }>("/api/schedules");
    expect(schedules.find(row => row.id === schedule.id)?.name).toBe("Owner edited schedule");
  } finally { await stopHost(); host = await startHost(); }
  expect((await api(path, { method: "DELETE" })).status).toBe(200);
  expect((await ownerScheduleCreate("owner-schedule-restart", draft)).status).toBe(409);
}, 30_000);

test("Public-page watches recover their owned browser after the Host is killed during a held read", async () => {
  const identity = async (pid: number) => {
    const read = async (field: string) => {
      const child = Bun.spawn(["/bin/ps", "-ww", "-p", String(pid), "-o", field], { stdout: "pipe", stderr: "pipe", env: { ...Bun.env, LC_ALL: "C" } });
      const [code, text] = await Promise.all([child.exited, new Response(child.stdout).text()]);
      if (code === 1) return null;
      expect(code).toBe(0);
      return text.trim();
    };
    const birth = await read("lstart=");
    return birth ? { birth, command: await read("args=") } : null;
  };
  const before = requests.length, watch = await createWatch("unassisted-browser-recovery");
  let browserPID = 0, browser: Awaited<ReturnType<typeof identity>> = null;
  let interrupted: Promise<unknown> | undefined;
  try {
    watchedPage.version = 1; watchedPage.status = 200;
    expect((await watchCheck(watch.id)).status).toBe(200);
    const baseline = await read<Watch>(`/api/watches/${watch.id}`);
    const lock = await readlink(profilePath("vm", "browser", "SingletonLock"));
    browserPID = Number(lock.split("-").at(-1));
    expect(Number.isSafeInteger(browserPID) && browserPID > 0).toBe(true);
    browser = await identity(browserPID);
    expect(browser?.command).toContain(data.split("/").at(-1)!);
    watchedPage.version = 2; watchedPage.held = true;
    interrupted = watchCheck(watch.id).catch((error: unknown) => error);
    await until(() => read<Watch>(`/api/watches/${watch.id}`), current => current.checking && watchedPage.waiting.size > 0);
    host!.process.kill("SIGKILL");
    await host!.process.exited;
    host = undefined;
    expect(await interrupted).toBeInstanceOf(Error);
    host = await startHost();
    const restored = await read<Watch>(`/api/watches/${watch.id}`);
    expect(restored).toMatchObject({ lastOutcome: "interrupted", checking: false, fingerprint: baseline.fingerprint, lastSuccessAt: baseline.lastSuccessAt });
    expect((await api(`/api/watches/${watch.id}`, { method: "PATCH", json: {
      expectedRevision: restored.revision, url: `http://127.0.0.1:${model.port}/watch-seed`, selector: "p", enabled: false,
    } })).status).toBe(200);
    const checked = await watchCheck(watch.id);
    expect(checked.status, await checked.text()).toBe(200);
    expect((await read<Watch>(`/api/watches/${watch.id}`)).lastOutcome).toBe("baseline");
    const retired = await identity(browserPID);
    expect(retired?.birth !== browser?.birth || retired?.command !== browser?.command).toBe(true);
    expect(requests).toHaveLength(before);
  } finally {
    watchedPage.held = false;
    for (const release of watchedPage.waiting) release();
    watchedPage.waiting.clear();
    if (interrupted) await interrupted;
    if (browser && browserPID) {
      const current = await identity(browserPID);
      if (current?.birth === browser.birth && current.command === browser.command) {
        try { process.kill(browserPID, "SIGTERM"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      }
    }
    if (host) {
      const current = await read<Watch>(`/api/watches/${watch.id}`);
      expect((await api(`/api/watches/${watch.id}`, { method: "DELETE", json: { expectedRevision: current.revision } })).status).toBe(200);
    }
  }
}, 60_000);

test("Owned browser recovery refuses foreign active and reused identities and keeps the off-gate browser usable", async () => {
  const watch = await createWatch("ownership-negative-seed");
  expect((await watchCheck(watch.id)).status).toBe(200);
  const path = profilePath("vm", "browser", ".openox-owner.json");
  const saved = JSON.parse(await readFile(path, "utf8")) as { version: number; tag: string; profile: string; machine: string;
    host: { pid: number; birth: string }; browser: { pid: number; birth: string } };
  await stopHost();
  const foreign = Bun.spawn(["/bin/sleep", "60"], { stdout: "ignore", stderr: "ignore" });
  const probe = Bun.spawn(["/bin/ps", "-ww", "-p", String(foreign.pid), "-o", "lstart="], { stdout: "pipe", env: { ...Bun.env, LC_ALL: "C" } });
  const foreignBirth = (await new Response(probe.stdout).text()).trim();
  expect(await probe.exited).toBe(0);
  expect(foreignBirth.length).toBeGreaterThan(0);
  const rejected = async (pattern: RegExp) => {
    const child = Bun.spawn([process.execPath, `${ROOT}/apps/linux/src/main.ts`, "serve", "--data", data, "--port", "0", "--name", "ownership-refusal"],
      { stdout: "pipe", stderr: "pipe", env: { ...Bun.env, OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "", OPENOX_PERSONAL_AGENT: "1" } });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, 5_000);
    try {
      const [code, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      expect(timedOut).toBe(false); expect(code).not.toBe(0); expect(error).toMatch(pattern);
    } finally { clearTimeout(timer); if (child.exitCode === null) { child.kill("SIGTERM"); await child.exited; } }
    expect(foreign.exitCode).toBeNull();
  };
  try {
    const variants = [
      { ...saved, tag: crypto.randomUUID(), browser: { pid: foreign.pid, birth: foreignBirth } },
      { ...saved, browser: { pid: foreign.pid, birth: "a different process start identity" } },
      { ...saved, host: { pid: foreign.pid, birth: foreignBirth } },
      { ...saved, profile: `${saved.profile}-foreign` },
    ];
    for (const value of variants) {
      const serialized = JSON.stringify(value);
      await writeFile(path, serialized, { mode: 0o600 });
      await rejected(/ownership|running Host/);
      expect(await readFile(path, "utf8")).toBe(serialized);
      expect(existsSync(`${path}.recovery`)).toBe(false);
      await rm(path);
    }
    await writeFile(`${path}.recovery`, JSON.stringify({ tag: crypto.randomUUID(), pid: foreign.pid }), { mode: 0o600 });
    await rejected(/recovery is already running or was interrupted/);
    expect(existsSync(`${path}.recovery`)).toBe(true);
    await rm(`${path}.recovery`);
    const legacy = JSON.stringify(variants[0]);
    await writeFile(path, legacy, { mode: 0o600 });
    host = await startHost(false);
    await value(await conversation(), `return await ox.web.browser.navigate({purpose:"Seed an ordinary persistent cookie",url:${JSON.stringify(`http://127.0.0.1:${model.port}/watch-seed`)}});`, approve);
    expect(await readFile(path, "utf8")).toBe(legacy);
    expect(foreign.exitCode).toBeNull();
    expect((await read<{ pages: unknown[] }>("/api/pages")).pages.length).toBeGreaterThan(0);
    await stopHost(); await rm(path); host = await startHost();
    await value(await conversation(), `return await ox.web.browser.navigate({purpose:"Open the same controlled page with owned recovery enabled",url:${JSON.stringify(`http://127.0.0.1:${model.port}/watch-seed`)}});`, approve);
    expect((await read<{ pages: unknown[] }>("/api/pages")).pages.length).toBeGreaterThan(0);
  } finally {
    if (foreign.exitCode === null) foreign.kill("SIGTERM");
    await foreign.exited;
    await stopHost();
    await rm(path, { force: true }); await rm(`${path}.recovery`, { force: true });
    host = await startHost();
    const current = await read<Watch>(`/api/watches/${watch.id}`);
    expect((await api(`/api/watches/${watch.id}`, { method: "DELETE", json: { expectedRevision: current.revision } })).status).toBe(200);
  }
}, 60_000);

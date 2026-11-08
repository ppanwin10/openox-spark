import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT } from "../../../../lib.ts";

const chunk = (delta: unknown, finish: string | null = null) => `data: ${JSON.stringify({ id: "chatcmpl-fixture", object: "chat.completion.chunk", created: 0, model: "fixture",
  choices: [{ index: 0, delta, finish_reason: finish }], ...(finish ? { usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } } : {}) })}\n\n`;
const text = (value: string) => [chunk({ role: "assistant", content: value }), chunk({}, "stop")];
const call = (purpose: string, source: string) => [chunk({ role: "assistant", tool_calls: [{ index: 0, id: `call_${crypto.randomUUID()}`, type: "function",
  function: { name: "execute", arguments: JSON.stringify({ purpose, source }) } }] }), chunk({}, "tool_calls")];

const limits: number[] = [];
const penalties: { model: string; presence: unknown }[] = [];

function scriptedModel() {
  return Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (request.method === "GET" && new URL(request.url).pathname === "/v1/models") return Response.json({ object: "list", data: [{ id: "fixture", object: "model", max_model_len: 40_960 }] });
    const body = await request.json() as { model: string; messages: { role: string; content: unknown }[]; max_tokens?: number; max_completion_tokens?: number; presence_penalty?: unknown };
    limits.push(body.max_completion_tokens ?? body.max_tokens ?? 0);
    penalties.push({ model: body.model, presence: body.presence_penalty });
    const last = body.messages.at(-1)!;
    const asked = JSON.stringify([...body.messages].reverse().find(message => message.role === "user")?.content ?? "");
    if (asked.includes("stream") && last.role !== "tool") {
      const encoder = new TextEncoder();
      return new Response(new ReadableStream({ async start(controller) {
        controller.enqueue(encoder.encode(chunk({ role: "assistant", reasoning_content: "Planning the reply. " })));
        for (let index = 0; index < 24; index++) { controller.enqueue(encoder.encode(chunk({ content: `Part ${index} of the streamed reply. ` }))); await Bun.sleep(25); }
        controller.enqueue(encoder.encode(chunk({}, "stop") + "data: [DONE]\n\n"));
        controller.close();
      } }), { headers: { "content-type": "text/event-stream" } });
    }
    const events = last.role === "tool"
      ? text(asked.includes("choose") ? `You chose ${JSON.stringify(last.content).includes("Markdown") ? "Markdown" : "something else"}.`
        : asked.includes("long") ? `Tool output was ${JSON.stringify(last.content).length} characters.` : "Saved the note.")
      : asked.includes("choose") ? call("Ask for a format", `return await ox.user.choose({ purpose: "Choose a format", body: "Which format?", options: ["Markdown", "PDF"] });`)
      : asked.includes("long") ? call("Print a long line", `return "x".repeat(500000);`)
      : asked.includes("write") ? call("Write a note", `const file = await ox.fs.write({ purpose: "Save note", path: "note.md", content: "written by the scripted model" }); console.log(file.path);`)
      : asked.includes("ramble") ? [chunk({ role: "assistant", reasoning_content: "Still weighing every option" }), chunk({}, "length")]
      : text("Hello from the scripted model.");
    return new Response(events.join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  } });
}

let data = "";
let model: ReturnType<typeof scriptedModel>;
let host: { process: ReturnType<typeof Bun.spawn>; port: number } | undefined;
let token = "";

async function startHost() {
  const child = Bun.spawn([process.execPath, `${ROOT}/apps/linux/src/main.ts`, "serve", "--data", data, "--port", "0", "--name", "fixture"],
    { stdout: "pipe", stderr: "pipe", env: { ...Bun.env, OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "" } });
  const reader = child.stdout.getReader();
  let output = "";
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    output += new TextDecoder().decode(value);
    const match = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(output);
    if (match) { reader.releaseLock(); return { process: child, port: Number(match[1]) }; }
  }
  child.kill();
  throw new Error(`Host did not start: ${output}${await new Response(child.stderr).text()}`);
}

async function stopHost() {
  if (!host) return;
  host.process.kill("SIGTERM");
  await host.process.exited;
  host = undefined;
}

async function hostCommand(...args: string[]) {
  const child = Bun.spawn([process.execPath, `${ROOT}/apps/linux/src/main.ts`, ...args, "--data", data], { stdout: "pipe", stderr: "pipe" });
  const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  expect(code).toBe(0);
  return stdout;
}

async function cli(withToken: boolean, ...args: string[]) {
  const child = Bun.spawn([process.execPath, `${ROOT}/apps/cli/src/ox.ts`, "--host", `ws://127.0.0.1:${host!.port}`, ...args],
    { stdout: "pipe", stderr: "pipe", env: { ...Bun.env, OX_REPOSITORY: "", OX_HOST_TOKEN: withToken ? token : "" } });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, stdout, stderr };
}

function api(path: string, init: RequestInit & { auth?: string | null } = {}) {
  const { auth = `Bearer ${token}`, ...rest } = init;
  return fetch(`http://127.0.0.1:${host!.port}${path}`, { ...rest, headers: { ...(auth ? { authorization: auth } : {}), ...rest.headers } });
}

beforeAll(async () => {
  data = await mkdtemp(join(tmpdir(), "openox-linux-host-"));
  model = scriptedModel();
  host = await startHost();
  token = /OX_HOST_TOKEN=(\S+)/.exec(await hostCommand("token", "--name", "protocol-test"))![1]!;
  const configured = await api("/api/settings/providers/custom", { method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Scripted", baseUrl: `http://127.0.0.1:${model.port}/v1`, models: ["fixture"] }) });
  expect(configured.status).toBe(200);
}, 30_000);

afterAll(async () => {
  await stopHost();
  model?.stop(true);
  if (data) await rm(data, { recursive: true, force: true });
});

test("Linux Host requires a device token and runs a real execute turn through the CLI", async () => {
  const refused = await cli(false, "host", "describe");
  expect(refused.code).toBe(1);
  expect(refused.stderr).toContain("Authentication required");
  const described = await cli(true, "host", "describe", "--json");
  expect(described.code).toBe(0);
  expect(JSON.parse(described.stdout)).toMatchObject({ protocols: { rpc: [4] }, implementation: { name: "OpenOx Linux Host" } });
  const created = await cli(true, "conversation", "new", "--json");
  expect(created.code).toBe(0);
  const { conversationId, model: label } = JSON.parse(created.stdout);
  expect(label).toBe("custom:fixture");
  const greeted = await cli(true, "--conversation", conversationId, "conversation", "send", "hello", "--json");
  expect(JSON.parse(greeted.stdout)).toMatchObject({ conversationId, outcome: "completed", text: "Hello from the scripted model." });
  const wrote = await cli(true, "--conversation", conversationId, "conversation", "send", "please write a note", "--json");
  expect(JSON.parse(wrote.stdout)).toMatchObject({ outcome: "completed", text: "Saved the note." });
  const profile = JSON.parse(await readFile(join(data, "host.json"), "utf8")).profile.id;
  expect(await readFile(join(data, "profiles", profile, "files", "conversations", conversationId, "note.md"), "utf8")).toBe("written by the scripted model");
  const inspected = JSON.parse((await cli(true, "--conversation", conversationId, "conversation", "inspect", "--json")).stdout);
  expect(inspected).toMatchObject({ id: conversationId, isBusy: false });
  expect(inspected.blocks.map((block: { kind: { type: string } }) => block.kind.type)).toEqual(["userText", "agentContent", "userText", "thinking", "agentContent"]);
  const listed = JSON.parse((await cli(true, "conversation", "list", "--json")).stdout);
  expect(listed.map((row: { id: string }) => row.id)).toContain(conversationId);
  const long = JSON.parse((await cli(true, "--conversation", conversationId, "conversation", "send", "print a long line", "--json")).stdout);
  const characters = Number(/Tool output was (\d+) characters/.exec(long.text)?.[1]);
  expect(characters).toBeGreaterThan(50_000);
  expect(characters).toBeLessThan(52_000);
  const reserved = await api(`/api/files/content?path=conversations/${conversationId}/turns.jsonl`, { method: "PUT", body: "{}" });
  expect(reserved.status).toBe(400);
  const attached = await (await api(`/api/conversations/${conversationId}/attachments?name=turns.jsonl`, { method: "POST", body: "{}" })).json() as { name: string };
  expect(attached.name).toBe("turns (2).jsonl");
}, 60_000);

test("A choice reports needsAttention and the Host accepts the CLI response", async () => {
  const created = JSON.parse((await cli(true, "conversation", "new", "--json")).stdout);
  const sent = await cli(true, "--conversation", created.conversationId, "conversation", "send", "please choose a format", "--json");
  expect(sent.code).toBe(1);
  expect(JSON.parse(sent.stdout)).toMatchObject({ outcome: "needsAttention" });
  const pending = JSON.parse((await cli(true, "--conversation", created.conversationId, "conversation", "inspect", "--pending", "--json")).stdout);
  expect(pending.pendingPrompt).toMatchObject({ prompt: "Which format?", options: ["Markdown", "PDF"] });
  const busy = await cli(true, "--conversation", created.conversationId, "conversation", "send", "another message", "--no-wait", "--json");
  expect(busy.code).toBe(1);
  expect(busy.stderr).toContain("still working");
  expect((await cli(true, "--conversation", created.conversationId, "conversation", "respond", "Markdown", "--prompt", pending.pendingPrompt.id)).code).toBe(0);
  let snapshot;
  for (let attempt = 0; attempt < 50; attempt++) {
    snapshot = JSON.parse((await cli(true, "--conversation", created.conversationId, "conversation", "inspect", "--json")).stdout);
    if (!snapshot.isBusy) break;
    await Bun.sleep(100);
  }
  expect(snapshot.isBusy).toBe(false);
  expect(JSON.stringify(snapshot.messages.at(-1))).toContain("You chose Markdown.");
  const stale = await cli(true, "--conversation", created.conversationId, "conversation", "respond", "PDF", "--prompt", pending.pendingPrompt.id);
  expect(stale.code).toBe(1);
}, 60_000);

test("Pairing codes, origin checks and revocation guard the browser API", async () => {
  expect((await api("/api/conversations", { auth: null })).status).toBe(401);
  const code = /Pairing code: (\S+)/.exec(await hostCommand("pair"))![1]!;
  const pair = (value: string) => api("/api/pair", { auth: null, method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: value, name: "Test phone" }) });
  expect((await pair("AAAA-AAAA")).status).toBe(403);
  const paired = await pair(code);
  expect(paired.status).toBe(201);
  const cookie = paired.headers.get("set-cookie")!.split(";")[0]!;
  expect(paired.headers.get("set-cookie")).toContain("HttpOnly");
  expect((await pair(code)).status).toBe(403);
  const session = await (await api("/api/session", { auth: null, headers: { cookie } })).json() as { paired: boolean; device: { id: string } };
  expect(session.paired).toBe(true);
  const crossSite = await api("/api/conversations", { auth: null, method: "POST", headers: { cookie, origin: "https://attacker.example", "content-type": "application/json" }, body: "{}" });
  expect(crossSite.status).toBe(403);
  expect((await api(`/api/devices/${session.device.id}`, { method: "DELETE" })).status).toBe(200);
  expect((await api("/api/conversations", { auth: null, headers: { cookie } })).status).toBe(401);
}, 30_000);

test("The served context sets the output limit, and a reply cut off by that limit is reported", async () => {
  const json = { "content-type": "application/json" };
  const { id } = await (await api("/api/conversations", { method: "POST", headers: json, body: "{}" })).json() as { id: number };
  expect((await api(`/api/conversations/${id}/messages`, { method: "POST", headers: json, body: JSON.stringify({ text: "please ramble" }) })).status).toBe(202);
  let view: { busy: boolean; error: string | null } = { busy: true, error: null };
  for (let attempt = 0; attempt < 100 && view.busy; attempt++) {
    await Bun.sleep(100);
    view = await (await api(`/api/conversations/${id}`)).json() as typeof view;
  }
  expect(view.error).toBe("The model reached its output limit before it wrote an answer. Ask again, or ask for a shorter answer.");
  expect(limits.at(-1)).toBe(10_240);
}, 30_000);

test("Qwen 3.5 and later get the presence penalty their model card asks for, and other models are left alone", async () => {
  const json = { "content-type": "application/json" };
  const turn = async () => {
    const { id } = await (await api("/api/conversations", { method: "POST", headers: json, body: "{}" })).json() as { id: number };
    expect((await api(`/api/conversations/${id}/messages`, { method: "POST", headers: json, body: JSON.stringify({ text: "sampling check" }) })).status).toBe(202);
    for (let attempt = 0; attempt < 100; attempt++) {
      await Bun.sleep(100);
      if (!(await (await api(`/api/conversations/${id}`)).json() as { busy: boolean }).busy) return penalties.at(-1)!;
    }
    throw new Error("Timed out waiting for the turn");
  };
  expect((await api("/api/settings/providers/custom", { method: "PUT", headers: json,
    body: JSON.stringify({ name: "Scripted", baseUrl: `http://127.0.0.1:${model.port}/v1`, models: ["fixture", "Qwen3.6-35B"] }) })).status).toBe(200);
  expect((await api("/api/settings/default-model", { method: "PUT", headers: json, body: JSON.stringify({ provider: "custom", modelId: "Qwen3.6-35B" }) })).status).toBe(200);
  expect(await turn()).toEqual({ model: "Qwen3.6-35B", presence: 1.5 });
  expect((await api("/api/settings/default-model", { method: "PUT", headers: json, body: JSON.stringify({ provider: "custom", modelId: "fixture" }) })).status).toBe(200);
  expect(await turn()).toEqual({ model: "fixture", presence: undefined });
}, 30_000);

test("Replies stream as deltas that rebuild the committed text, and keep their block when committed", async () => {
  const json = { "content-type": "application/json" };
  const received: { event: string; data: { id?: number; ref?: string; kind?: string; offset?: number; delta?: string; final?: boolean } }[] = [];
  const stream = await api("/api/events");
  const reader = stream.body!.getReader();
  void (async () => {
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
      if (done) return;
      buffer += new TextDecoder().decode(value);
      for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
        const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        const event = /^event: (.+)$/m.exec(frame)?.[1], data = /^data: (.+)$/m.exec(frame)?.[1];
        if (event && data) received.push({ event, data: JSON.parse(data) });
      }
    }
  })();
  const { id } = await (await api("/api/conversations", { method: "POST", headers: json, body: "{}" })).json() as { id: number };
  expect((await api(`/api/conversations/${id}/messages`, { method: "POST", headers: json, body: JSON.stringify({ text: "please stream a reply" }) })).status).toBe(202);
  type Item = { text?: string; ref?: string };
  type View = { busy: boolean; blocks: { id: string; kind: { type: string; items?: Item[] } }[] };
  const textBlock = (view: View) => view.blocks.find(block => block.kind.type === "agentContent" && block.kind.items?.some(item => item.ref));
  let live: string | undefined, view: View = { busy: true, blocks: [] };
  for (let attempt = 0; attempt < 200 && view.busy; attempt++) {
    view = await (await api(`/api/conversations/${id}`)).json() as View;
    if (view.busy && textBlock(view)) live ??= textBlock(view)!.id;
    await Bun.sleep(20);
  }
  const final = textBlock(view)!;
  const item = final.kind.items!.find(entry => entry.ref)!;
  const deltas = () => received.filter(entry => entry.event === "stream" && entry.data.id === id && entry.data.ref === item.ref);
  for (let attempt = 0; attempt < 100 && !deltas().at(-1)?.data.final; attempt++) await Bun.sleep(20);
  await reader.cancel();
  let rebuilt = "";
  for (const { data } of deltas()) {
    expect(data.offset).toBeLessThanOrEqual(rebuilt.length);
    rebuilt += data.delta!.slice(rebuilt.length - data.offset!);
  }
  expect(live).toBe(final.id);
  expect(deltas().length).toBeGreaterThan(5);
  expect(deltas().filter(entry => entry.data.final).length).toBe(1);
  expect(rebuilt).toBe(item.text!);
  expect(item.text).toContain("Part 23 of the streamed reply.");
  expect(received.some(entry => entry.event === "stream" && entry.data.id === id && entry.data.kind === "reasoning")).toBe(true);
  expect(received.filter(entry => entry.event === "conversation" && entry.data.id === id).length).toBeLessThan(deltas().length);
}, 30_000);

test("Conversations and Profile files survive a Host restart, even with an open event stream", async () => {
  const before = JSON.parse((await cli(true, "conversation", "list", "--json")).stdout) as { id: string; title: string }[];
  const stream = await api("/api/events");
  expect(stream.status).toBe(200);
  const started = Date.now();
  await stopHost();
  expect(Date.now() - started).toBeLessThan(10_000);
  await stream.body?.cancel().catch(() => {});
  host = await startHost();
  const after = JSON.parse((await cli(true, "conversation", "list", "--json")).stdout) as { id: string; title: string }[];
  expect(after.map(row => [row.id, row.title])).toEqual(before.map(row => [row.id, row.title]));
  const written = before.find(row => row.title === "hello")!;
  const listing = await (await api(`/api/files?path=conversations/${written.id}`)).json() as { entries: { name: string }[] };
  expect(listing.entries.map(entry => entry.name)).toContain("note.md");
  expect((await api("/api/settings/providers/custom", { method: "DELETE" })).status).toBe(200);
  const orphaned = await cli(true, "--conversation", written.id, "conversation", "send", "hello", "--json");
  expect(orphaned.code).toBe(1);
  expect(orphaned.stderr).toContain("Choose an available model");
  const profile = JSON.parse(await readFile(join(data, "host.json"), "utf8")).profile.id;
  const folder = join(data, "profiles", profile, "files", "conversations", written.id);
  expect((await api(`/api/conversations/${written.id}`, { method: "DELETE" })).status).toBe(200);
  expect(existsSync(folder)).toBe(false);
  const trashed = await readdir(join(data, "profiles", profile, "state", "trash"), { recursive: true });
  expect(trashed.some(path => path.endsWith(join("conversations", written.id, "note.md")))).toBe(true);
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "left.md"), "left behind");
  await stopHost();
  host = await startHost();
  expect(existsSync(folder)).toBe(false);
}, 60_000);

import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Value } from "typebox/value";
import { ROOT } from "../../../../lib.ts";

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
function scriptedModel() {
  return Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (request.method === "GET") return new Response("Not found", { status: 404 });
    const body = await request.json() as { model: string; messages: Message[]; tools?: unknown[] };
    const system = body.messages.filter(message => message.role === "system" || message.role === "developer").map(message => textOf(message.content)).join("\n");
    requests.push({ model: body.model, system, authorization: request.headers.get("authorization"), tools: !!body.tools?.length });
    const last = body.messages.at(-1)!;
    const latest = textOf([...body.messages].reverse().find(message => message.role === "user")?.content);
    if (latest.includes("slow-run") && last.role === "user") await Bun.sleep(2_500);
    const encoded = /run:([A-Za-z0-9+/=]+)/.exec(latest)?.[1];
    const events = !body.tools?.length ? reply(`generated: ${textOf(last.content)}`)
      : last.role === "tool" ? reply(`OUTPUT ${textOf(last.content)}`)
      : encoded ? call(Buffer.from(encoded, "base64").toString("utf8"))
      : reply("Hello from the scripted model.");
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

async function startHost() {
  const child = Bun.spawn([process.execPath, `${ROOT}/apps/linux/src/main.ts`, "serve", "--data", data, "--port", "0", "--name", "workspace"],
    { stdout: "pipe", stderr: "pipe", env: { ...Bun.env, OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "", OX_HOST_TEST_ORIGINS: `http://127.0.0.1:${model.port}` } });
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
  const schema = contracts[name]!.outputSchema as Parameters<typeof Value.Check>[0];
  const errors = [...Value.Errors(schema, result)].map(error => `${error.instancePath} ${error.message}`);
  expect(errors).toEqual([]);
}
const numberOf = (uuid: string) => Number.parseInt(uuid.replaceAll("-", "").slice(16), 16);
const profilePath = (...parts: string[]) => join(data, "profiles", profileID, ...parts);
const approve = () => ({ answer: "Approve" });
const always = () => ({ answer: "Always approve" });

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
  await stopHost();
  model?.stop(true);
  if (data) await rm(data, { recursive: true, force: true });
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

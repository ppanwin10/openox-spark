import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { appendFile, cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT } from "../../../../lib.ts";

const chunk = (delta: unknown, finish: string | null = null) => `data: ${JSON.stringify({ id: "chatcmpl-fixture", object: "chat.completion.chunk", created: 0, model: "fixture",
  choices: [{ index: 0, delta, finish_reason: finish }], ...(finish ? { usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } } : {}) })}\n\n`;
const text = (value: string) => [chunk({ role: "assistant", content: value }), chunk({}, "stop")];
const call = (purpose: string, source: string) => [chunk({ role: "assistant", tool_calls: [{ index: 0, id: `call_${crypto.randomUUID()}`, type: "function",
  function: { name: "execute", arguments: JSON.stringify({ purpose, source }) } }] }), chunk({}, "tool_calls")];
const contentText = (content: unknown) => typeof content === "string" ? content
  : Array.isArray(content) ? content.map(part => typeof part === "object" && part && "text" in part ? String((part as { text: unknown }).text) : "").join("") : "";

type Validator = ((value: unknown) => boolean) & { errors?: unknown };
const { default: Ajv } = await import(Bun.resolveSync("ajv", join(ROOT, "apps", "linux"))) as { default: new (options: object) => { compile(schema: unknown): Validator } };
const validator = new Ajv({ strict: false, validateFormats: false, allowUnionTypes: true });
const contracts: Record<string, { outputSchema: unknown }> = Object.assign({}, ...await Promise.all(["service", "web", "repository", "secret"].map(async namespace =>
  JSON.parse(await readFile(join(ROOT, "packages", "agent", "src", "functions", namespace, "contracts.json"), "utf8")))));
function conforms(name: string, value: unknown) {
  const validate = validator.compile(contracts[name]!.outputSchema);
  if (!validate(value)) throw new Error(`${name} output does not match its contract: ${JSON.stringify(validate.errors)}`);
}

const modelRequests: string[] = [];
function scriptedModel() {
  return Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (request.method === "GET") return new Response("Not found", { status: 404 });
    const raw = await request.text();
    modelRequests.push(raw);
    const body = JSON.parse(raw) as { messages: { role: string; content: unknown }[] };
    const last = body.messages.at(-1)!;
    const events = last.role === "tool" ? text("done") : call("Run the test script", contentText(last.content).replace(/^\[[^\]\n]*\]\n\n/, ""));
    return new Response(events.join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  } });
}

let gitRoot = "";
function gitSite() {
  return Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = decodeURIComponent(new URL(request.url).pathname);
    if (!path.startsWith("/fixture.git/") || path.includes("..")) return new Response("not found", { status: 404 });
    const file = Bun.file(join(gitRoot, "served", path));
    return await file.exists() ? new Response(file) : new Response("not found", { status: 404 });
  } });
}

async function git(cwd: string, ...args: string[]) {
  const child = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: { ...Bun.env, GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.com",
    GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.com", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
  return stdout.trim();
}

const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: "object", properties, required, additionalProperties: false });
const webService = (domain: string) => ({ domain, name: `Repository ${domain}`, description: "Service from a connected repository.", baseUrl: `https://${domain}/`,
  actions: [{ id: "ping", label: "Ping", inputSchema: object({}), outputSchema: object({ ok: { type: "boolean" } }), requireApproval: false, requireAuth: false }] });

async function writeRepository(directory: string, domains: string[]) {
  await writeFile(join(directory, "repository.json"), JSON.stringify({ version: 3, name: "Fixture Repo", services: domains.map(domain => `web:${domain}`), skills: ["fixture-skill"] }, null, 2));
  for (const domain of domains) {
    await mkdir(join(directory, "web", domain), { recursive: true });
    await writeFile(join(directory, "web", domain, "service.json"), JSON.stringify(webService(domain), null, 2));
    await writeFile(join(directory, "web", domain, "actions.js"), `window.ox.install(({ action }) => action("ping", { invoke() { return { ok: true }; } }));\n`);
  }
  await mkdir(join(directory, "skills", "fixture-skill"), { recursive: true });
  await writeFile(join(directory, "skills", "fixture-skill", "SKILL.md"), "---\nname: fixture-skill\ndescription: Fixture skill from a connected repository.\n---\n\n# Fixture\n");
}

const SECRET = "s3cr3t-VALUE-9f8e7d", API_SECRET = "api-TOKEN-4c3b2a";
let data = "", local = "", origin = "";
let model: ReturnType<typeof scriptedModel>, site: ReturnType<typeof gitSite>;
let host: { process: ReturnType<typeof Bun.spawn>; port: number } | undefined;
let token = "";

async function startHost() {
  const child = Bun.spawn([process.execPath, `${ROOT}/apps/linux/src/main.ts`, "serve", "--data", data, "--port", "0", "--name", "fixture"],
    { stdout: "pipe", stderr: "pipe", env: { ...Bun.env, OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "", OX_HOST_TEST_ORIGINS: `http://127.0.0.1:${site.port}` } });
  const reader = child.stdout.getReader();
  let output = "";
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    output += new TextDecoder().decode(value);
    const match = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(output);
    if (match) {
      void (async () => { while (!(await reader.read()).done); })().catch(() => {});
      void new Response(child.stderr).text().catch(() => "");
      return { process: child, port: Number(match[1]) };
    }
  }
  child.kill();
  throw new Error(`Host did not start: ${output}${await new Response(child.stderr).text()}`);
}

async function hostCommand(...args: string[]) {
  const child = Bun.spawn([process.execPath, `${ROOT}/apps/linux/src/main.ts`, ...args, "--data", data], { stdout: "pipe", stderr: "pipe" });
  const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  expect(code).toBe(0);
  return stdout;
}

function api(path: string, init: RequestInit & { json?: unknown } = {}) {
  const { json, ...rest } = init;
  return fetch(`http://127.0.0.1:${host!.port}${path}`, { ...rest, ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
    headers: { authorization: `Bearer ${token}`, ...(json !== undefined ? { "content-type": "application/json" } : {}), ...rest.headers } });
}
const getJSON = async <T>(path: string) => (await api(path)).json() as Promise<T>;

type Prompt = { id: string; prompt: string; options: string[]; requiresApp: boolean };
type View = { busy: boolean; pendingPrompt?: Prompt; messages: { role: string; content: unknown }[]; blocks: unknown[] };
type Answer = { answer: string } | { values: Record<string, string> } | { cancel: true };

async function run(conversation: number, body: string, answer: (prompt: Prompt) => Answer | undefined = () => undefined) {
  const source = `try { return await (async () => {\n${body}\n})(); } catch (error) { return { error: error.code ?? "error", message: String(error.message ?? error) }; }`;
  const sent = await api(`/api/conversations/${conversation}/messages`, { method: "POST", json: { text: source } });
  expect(sent.status).toBe(202);
  const answered = new Set<string>();
  const prompts: Prompt[] = [];
  for (let attempt = 0; attempt < 900; attempt++) {
    const view = await getJSON<View>(`/api/conversations/${conversation}`);
    if (view.pendingPrompt && !answered.has(view.pendingPrompt.id)) {
      const reply = answer(view.pendingPrompt);
      if (!reply) throw new Error(`Unexpected prompt: ${view.pendingPrompt.prompt}`);
      answered.add(view.pendingPrompt.id);
      prompts.push(view.pendingPrompt);
      const responded = await api(`/api/conversations/${conversation}/respond`, { method: "POST", json: { promptId: view.pendingPrompt.id, ...reply } });
      expect(responded.status).toBe(200);
      continue;
    }
    if (!view.busy && !view.pendingPrompt) {
      const result = [...view.messages].reverse().find(message => message.role === "toolResult");
      const output = contentText(result?.content);
      try { return { value: JSON.parse(output), prompts, view }; } catch { throw new Error(`Script output was not JSON: ${output}`); }
    }
    await Bun.sleep(100);
  }
  throw new Error("The conversation did not finish");
}

async function conversation() {
  const created = await api("/api/conversations", { method: "POST", json: {} });
  expect(created.status).toBe(201);
  return ((await created.json()) as { id: number }).id;
}

async function register(kind: string, identity: string) {
  const repository = JSON.parse(await readFile(join(local, "repository.json"), "utf8")) as { services: string[] };
  if (!repository.services.includes(`${kind}:${identity}`)) repository.services.push(`${kind}:${identity}`);
  await writeFile(join(local, "repository.json"), JSON.stringify(repository, null, 2));
}

beforeAll(async () => {
  data = await mkdtemp(join(tmpdir(), "openox-linux-repositories-"));
  gitRoot = await mkdtemp(join(tmpdir(), "openox-linux-git-"));
  const work = join(gitRoot, "work");
  await mkdir(work, { recursive: true });
  await writeRepository(work, ["repo.localhost"]);
  await git(work, "init", "-q", "-b", "main");
  await git(work, "add", "-A");
  await git(work, "commit", "-q", "-m", "First fixture");
  await mkdir(join(gitRoot, "served"), { recursive: true });
  await git(gitRoot, "clone", "-q", "--bare", work, join(gitRoot, "served", "fixture.git"));
  await git(gitRoot, "--git-dir", join(gitRoot, "served", "fixture.git"), "update-server-info");
  model = scriptedModel();
  site = gitSite();
  origin = `http://127.0.0.1:${site.port}/fixture.git`;
  host = await startHost();
  token = /OX_HOST_TOKEN=(\S+)/.exec(await hostCommand("token", "--name", "repositories-test"))![1]!;
  const configured = await api("/api/settings/providers/custom", { method: "PUT", json: { name: "Scripted", baseUrl: `http://127.0.0.1:${model.port}/v1`, models: ["fixture"] } });
  expect(configured.status).toBe(200);
  const profile = (JSON.parse(await readFile(join(data, "host.json"), "utf8")) as { profile: { id: string } }).profile.id;
  local = join(data, "profiles", profile, "vm", "repositories", "local");
}, 60_000);

afterAll(async () => {
  if (host) { host.process.kill("SIGTERM"); await host.process.exited; }
  model?.stop(true);
  site?.stop(true);
  if (data) await rm(data, { recursive: true, force: true });
  if (gitRoot) await rm(gitRoot, { recursive: true, force: true });
});

test("Git repositories connect, sync, enable and disconnect through functions and HTTP routes", async () => {
  const id = await conversation();
  const rejected = (await run(id, `
    const result = [];
    for (const origin of ["file:///etc/passwd", "https://user:secret@example.com/repo.git", "http://example.com/repo.git", "mounts/folder"]) {
      try { await ox.repository.connect({ purpose: "Reject", origin }); result.push("connected"); } catch (error) { result.push(error.code); }
    }
    return result;
  `)).value;
  expect(rejected).toEqual(["invalid_argument", "invalid_argument", "invalid_argument", "not_supported"]);

  const connected = (await run(id, `
    const connected = await ox.repository.connect({ purpose: "Connect fixture", origin: ${JSON.stringify(origin)} });
    const listed = await ox.repository.list({ purpose: "List repositories" });
    const services = await ox.service.list({ purpose: "List services", kind: "web" });
    const manifest = await ox.fs.read({ purpose: "Read repository", path: "/repositories/" + connected.id + "/repository.json" });
    return { connected, listed, service: services.find(service => service.domain === "repo.localhost"), manifest };
  `)).value;
  expect(connected.connected).toEqual({ id: "fixture-repo", name: "Fixture Repo", origin, serviceCount: 1, skillCount: 1, connected: true });
  conforms("ox.repository.connect", connected.connected);
  conforms("ox.repository.list", connected.listed);
  expect(connected.listed.repositories.map((repository: { id: string }) => repository.id)).toEqual(["bundled", "local", "fixture-repo"]);
  expect(connected.listed.repositories[2]).toEqual({ id: "fixture-repo", path: "repositories/fixture-repo", name: "Fixture Repo", provenance: "remote", enabled: true,
    state: "ready", serviceCount: 1, skillCount: 1 });
  expect(connected.service).toMatchObject({ repository: "fixture-repo", repositoryProvenance: "remote", manifestPath: "repositories/fixture-repo/web/repo.localhost/service.json" });
  expect(connected.manifest.text).toContain("Fixture Repo");
  const snapshot = join(local, "..", "fixture-repo");
  expect(existsSync(join(snapshot, ".git"))).toBe(false);
  const firstCommit = (await getJSON<{ repositories: { id: string; commit: string }[] }>("/api/repositories")).repositories.find(row => row.id === "fixture-repo")!.commit;

  const work = join(gitRoot, "work");
  await writeRepository(work, ["repo.localhost", "second.localhost"]);
  await git(work, "add", "-A");
  await git(work, "commit", "-q", "-m", "Second fixture");
  await git(work, "push", "-q", join(gitRoot, "served", "fixture.git"), "main");
  await git(gitRoot, "--git-dir", join(gitRoot, "served", "fixture.git"), "update-server-info");
  const synced = (await run(id, `
    const synced = await ox.repository.sync({ purpose: "Sync fixture", repository: "fixture-repo" });
    const disabled = await ox.repository.enable({ purpose: "Disable fixture", repository: "fixture-repo", enabled: false });
    const hidden = (await ox.service.list({ purpose: "List services", kind: "web" })).some(service => service.domain === "second.localhost");
    const enabled = await ox.repository.enable({ purpose: "Enable fixture", repository: "fixture-repo", enabled: true });
    const visible = (await ox.service.list({ purpose: "List services", kind: "web" })).some(service => service.domain === "second.localhost");
    let local;
    try { await ox.repository.enable({ purpose: "Disable Local", repository: "local", enabled: false }); } catch (error) { local = error.code; }
    return { synced, disabled, hidden, enabled, visible, local };
  `)).value;
  expect(synced.synced).toEqual({ id: "fixture-repo", name: "Fixture Repo", serviceCount: 2, skillCount: 1, synced: true });
  conforms("ox.repository.sync", synced.synced);
  expect(synced.disabled).toEqual({ id: "fixture-repo", enabled: false, changed: true, serviceCount: 2, skillCount: 1 });
  conforms("ox.repository.enable", synced.disabled);
  expect(synced.hidden).toBe(false);
  expect(synced.enabled).toMatchObject({ enabled: true, changed: true });
  expect(synced.visible).toBe(true);
  expect(synced.local).toBe("invalid_argument");

  const rows = await getJSON<{ repositories: Record<string, unknown>[] }>("/api/repositories");
  const row = rows.repositories.find(entry => entry.id === "fixture-repo")!;
  expect(row).toMatchObject({ name: "Fixture Repo", kind: "git", url: origin, enabled: true, error: null, services: 2, skills: 1 });
  expect(row.commit).not.toBe(firstCommit);
  expect(rows.repositories.find(entry => entry.id === "bundled")).toMatchObject({ kind: "bundled", enabled: true, url: null });
  expect((await (await api("/api/repositories/fixture-repo", { method: "PUT", json: { enabled: false } })).json())).toMatchObject({ id: "fixture-repo", enabled: false });
  expect((await (await api("/api/repositories/fixture-repo/sync", { method: "POST" })).json())).toMatchObject({ id: "fixture-repo", services: 2, enabled: false });
  const disconnected = (await run(id, `return await ox.repository.disconnect({ purpose: "Disconnect", repository: "fixture-repo" });`)).value;
  expect(disconnected).toEqual({ id: "fixture-repo", disconnected: true });
  conforms("ox.repository.disconnect", disconnected);
  expect(existsSync(snapshot)).toBe(false);

  const reconnected = await api("/api/repositories", { method: "POST", json: { url: origin } });
  expect(reconnected.status).toBe(201);
  expect(await reconnected.json()).toMatchObject({ id: "fixture-repo", kind: "git", services: 2 });
  expect((await (await api("/api/repositories/fixture-repo", { method: "DELETE" })).json())).toEqual({ deleted: true });
  expect((await getJSON<{ repositories: { id: string }[] }>("/api/repositories")).repositories.map(entry => entry.id)).toEqual(["bundled", "local"]);
}, 90_000);

test("Local and bundled copies of a service conflict until a source is resolved", async () => {
  await cp(join(ROOT, "apps", "shared", "Resources", "OxServices.bundle", "web", "en.wikipedia.org"), join(local, "web", "en.wikipedia.org"), { recursive: true });
  await register("web", "en.wikipedia.org");
  const id = await conversation();
  const { value } = await run(id, `
    const conflicts = await ox.repository.conflicts({ purpose: "Conflicts" });
    const compared = await ox.repository.conflicts({ purpose: "Compare", service: "en.wikipedia.org", compare: true });
    const resolved = await ox.repository.resolve({ purpose: "Use Local", service: "en.wikipedia.org", repository: "local" });
    const again = await ox.repository.resolve({ purpose: "Use Local", service: "en.wikipedia.org", repository: "local" });
    const attached = await ox.service.attach({ purpose: "Attach", domain: "en.wikipedia.org" });
    let missing;
    try { await ox.repository.resolve({ purpose: "Bad", service: "en.wikipedia.org", repository: "nowhere" }); } catch (error) { missing = error.code; }
    return { conflicts, compared, resolved, again, attached, missing };
  `);
  conforms("ox.repository.conflicts", value.conflicts);
  conforms("ox.repository.conflicts", value.compared);
  conforms("ox.repository.resolve", value.resolved);
  expect(value.conflicts.conflicts).toEqual([{ service: "en.wikipedia.org", selectedRepository: "bundled", candidates: [
    { repository: "bundled", name: "Built-in", path: "repositories/bundled/web/en.wikipedia.org" },
    { repository: "local", name: "Local", path: "repositories/local/web/en.wikipedia.org" },
  ] }]);
  expect(value.compared.comparison.identical).toBe(true);
  expect(value.compared.comparison.candidates[0].files.map((file: { path: string }) => file.path)).toEqual(["actions.js", "service.json"]);
  expect(value.resolved).toEqual({ service: "en.wikipedia.org", selectedRepository: "local", reloadRequired: false });
  expect(value.again).toEqual({ service: "en.wikipedia.org", selectedRepository: "local", reloadRequired: false });
  expect(value.attached).toMatchObject({ domain: "en.wikipedia.org", repository: "local", repositoryProvenance: "local" });
  expect(value.missing).toBe("invalid_argument");
  await appendFile(join(local, "web", "en.wikipedia.org", "actions.js"), "\n");
  const edited = (await run(id, `return await ox.repository.conflicts({ purpose: "Compare", service: "en.wikipedia.org", compare: true });`)).value;
  expect(edited.conflicts[0].selectedRepository).toBe("local");
  expect(edited.comparison.identical).toBe(false);
}, 60_000);

test("Secrets are entered through a form prompt and never reach views, logs or the model", async () => {
  const id = await conversation();
  const added = await run(id, `return await ox.secret.add({ purpose: "Save the token", key: "fixture-token" });`,
    prompt => prompt.requiresApp ? { values: { displayName: "Fixture token", field: "token", value: SECRET } } : undefined);
  expect(added.prompts).toHaveLength(1);
  expect(added.prompts[0]!.prompt).toContain("Add Secret");
  expect(added.value).toEqual({ key: "fixture-token", status: "saved" });
  conforms("ox.secret.add", added.value);
  const cancelled = await run(id, `return await ox.secret.add({ purpose: "Save another", key: "other-token" });`, () => ({ cancel: true }));
  expect(cancelled.value).toEqual({ key: "other-token", status: "cancelled" });
  const listed = (await run(id, `return await ox.secret.list({ purpose: "List secrets" });`)).value;
  expect(listed).toEqual([{ key: "fixture-token", displayName: "Fixture token", fields: ["token"], available: true, type: null, serviceID: null }]);
  conforms("ox.secret.list", listed);
  expect((await getJSON<{ secrets: unknown[] }>("/api/secrets")).secrets).toEqual([{ key: "fixture-token", name: "Fixture token", fields: ["token"], available: true }]);

  await mkdir(join(local, "api", "fixture-api"), { recursive: true });
  await writeFile(join(local, "api", "fixture-api", "service.json"), JSON.stringify({ kind: "api", domain: "fixture-api", name: "Fixture API", description: "Fixture HTTP API.",
    baseUrl: "https://api.example.com/v1/", auth: { type: "http", scheme: "bearer" }, actions: [
      { id: "echo", label: "Echo", inputSchema: object({ text: { type: "string" } }), outputSchema: object({ echoed: { type: "string" } }), requireApproval: false, requireAuth: false },
      { id: "listItems", label: "List items", inputSchema: object({}), outputSchema: object({ items: { type: "array", items: { type: "string" } } }), requireApproval: false, requireAuth: true },
    ] }, null, 2));
  await writeFile(join(local, "api", "fixture-api", "actions.js"), `window.ox.install(({ action, request }) => {
  action("echo", { async invoke({ text }) { return { echoed: text }; } });
  action("listItems", { async invoke() { return await request({ path: "items" }); } });
});\n`);
  await register("api", "fixture-api");
  const configured = await run(id, `
    const attached = await ox.service.attach({ purpose: "Attach API", domain: "fixture-api" });
    const inspected = await ox.service.inspect({ purpose: "Inspect API", domain: "fixture-api" });
    const before = await ox.service.invoke({ purpose: "Status", name: "api:fixture-api:credentialStatus" });
    let unauthenticated;
    try { await ox.service.invoke({ purpose: "List", name: "api:fixture-api:listItems" }); } catch (error) { unauthenticated = error.code; }
    const echoed = await ox.service.invoke({ purpose: "Echo", name: "api:fixture-api:echo", input: { text: "hi" } });
    const setup = await ox.service.invoke({ purpose: "Set up", name: "api:fixture-api:configureCredentials" });
    const after = await ox.service.invoke({ purpose: "Status", name: "api:fixture-api:credentialStatus" });
    const secrets = await ox.secret.list({ purpose: "List secrets" });
    return { attached, inspected, before, unauthenticated, echoed, setup, after, secrets };
  `, prompt => prompt.requiresApp ? { values: { token: API_SECRET } } : undefined);
  expect(configured.value.attached).toMatchObject({ kind: "api", login: "signedOut", repository: "local" });
  expect(configured.value.inspected.standardActions).toEqual(["credentialStatus", "configureCredentials"]);
  expect(Object.keys(configured.value.inspected.actions)).toEqual(["echo", "listItems"]);
  expect(configured.value.before).toEqual({ state: "notConfigured" });
  expect(configured.value.unauthenticated).toBe("authentication_required");
  expect(configured.value.echoed).toEqual({ echoed: "hi" });
  expect(configured.value.setup).toEqual({ completed: true, completion: "configured", state: "configured" });
  expect(configured.value.after).toEqual({ state: "configured" });
  expect(configured.value.secrets.find((secret: { key: string }) => secret.key.startsWith("ox.api-service."))).toMatchObject({ displayName: "Fixture API", fields: ["token"], available: true });
  const generated = configured.value.secrets.find((secret: { key: string }) => secret.key.startsWith("ox.api-service.")).key as string;
  const rotated = await api(`/api/secrets/${encodeURIComponent(generated)}`, { method: "PUT", json: { name: "Fixture API", fields: { token: "" } } });
  expect(rotated.status).toBe(200);
  expect(await rotated.text()).not.toContain(API_SECRET);
  expect((await run(id, `return await ox.service.invoke({ purpose: "Status", name: "api:fixture-api:credentialStatus" });`)).value).toEqual({ state: "configured" });

  const removed = await run(id, `return await ox.secret.delete({ purpose: "Delete the token", key: "fixture-token" });`,
    prompt => prompt.options.includes("Approve") ? { answer: "Approve" } : prompt.options.includes("Delete") ? { answer: "Delete" } : undefined);
  expect(removed.prompts.map(prompt => prompt.options)).toEqual([["Approve", "Always approve", "Deny"], ["Delete", "Cancel"]]);
  expect(removed.value).toEqual({ key: "fixture-token", status: "deleted" });
  conforms("ox.secret.delete", removed.value);
  expect((await getJSON<{ secrets: { key: string }[] }>("/api/secrets")).secrets.some(secret => secret.key === "fixture-token")).toBe(false);

  const view = JSON.stringify(await getJSON(`/api/conversations/${id}`));
  const secretsFile = join(local, "..", "..", "state", "secrets.json");
  expect((await stat(secretsFile)).mode & 0o777).toBe(0o600);
  expect(await readFile(secretsFile, "utf8")).toContain(API_SECRET);
  await Bun.sleep(200);
  const logs = await readFile(join(data, "logs", "host.jsonl"), "utf8");
  for (const value of [SECRET, API_SECRET]) {
    expect(view).not.toContain(value);
    expect(logs).not.toContain(value);
    expect(modelRequests.some(request => request.includes(value))).toBe(false);
  }
}, 60_000);

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

const sdk = (path: string) => import(Bun.resolveSync(`@modelcontextprotocol/sdk/${path}`, join(ROOT, "apps", "linux")));
const { Server } = await sdk("server/index.js") as { Server: new (info: object, options: object) => { setRequestHandler(schema: unknown, handler: (request: { params: { arguments: Record<string, number> } }) => unknown): void; connect(transport: unknown): Promise<void> } };
const { WebStandardStreamableHTTPServerTransport } = await sdk("server/webStandardStreamableHttp.js") as { WebStandardStreamableHTTPServerTransport: new (options: object) => { handleRequest(request: Request): Promise<Response> } };
const { CallToolRequestSchema, ListToolsRequestSchema } = await sdk("types.js") as { CallToolRequestSchema: unknown; ListToolsRequestSchema: unknown };
const { CONVERSATION_ACTION_SCHEMA } = await import(join(ROOT, "packages", "protocol", "src", "model-actions.ts")) as { CONVERSATION_ACTION_SCHEMA: { inputSchema: unknown; outputSchema: unknown } };
const toolCalls: Record<string, number>[] = [];
function mcpFixture() {
  return Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const server = new Server({ name: "fixture-mcp", version: "1.0.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [{ name: "add", title: "Add numbers", description: "Adds two numbers.",
      inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] },
      outputSchema: { type: "object", properties: { sum: { type: "number" } }, required: ["sum"] } }] }));
    server.setRequestHandler(CallToolRequestSchema, request => {
      toolCalls.push(request.params.arguments);
      return { content: [{ type: "text", text: "added" }], structuredContent: { sum: request.params.arguments.a! + request.params.arguments.b! } };
    });
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    return transport.handleRequest(request);
  } });
}

const systemPrompts: string[] = [];
function scriptedModel() {
  return Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (request.method === "GET") return new Response("Not found", { status: 404 });
    const body = await request.json() as { messages: { role: string; content: unknown }[] };
    systemPrompts.push(contentText(body.messages.find(message => message.role === "system")?.content));
    const last = body.messages.at(-1)!;
    const events = last.role === "tool" ? text("done") : call("Run the test script", contentText(last.content));
    return new Response(events.join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  } });
}

const orders: string[] = [];
const html = (title: string) => new Response(`<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1></body></html>`, { headers: { "content-type": "text/html" } });
const searchItems: Record<string, { title: string; url: string | null; snippet: string | null }[]> = {
  "a.localhost": [{ title: "Shared result", url: "https://example.org/shared?utm_source=a", snippet: "from A" }, { title: "Only A", url: "https://example.org/a", snippet: "A" }],
  "b.localhost": [{ title: "Only B", url: "https://example.org/b", snippet: "B" }, { title: "Shared result again", url: "https://example.org/shared", snippet: "from B" }],
};
function fixtureSite() {
  return Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url);
    const host = (request.headers.get("host") ?? "").split(":")[0]!;
    if (host === "app.localhost") {
      if (url.pathname === "/api/greet") return Response.json({ greeting: `Hello ${url.searchParams.get("name")}` });
      if (url.pathname === "/api/orders" && request.method === "POST") {
        orders.push(((await request.json()) as { item: string }).item);
        return Response.json({ orderId: `order-${orders.length}` });
      }
      return html("App fixture");
    }
    if (searchItems[host]) {
      if (url.pathname === "/search") return Response.json({ items: searchItems[host].slice(0, Number(url.searchParams.get("limit") ?? 10)) });
      return html(`Search ${host}`);
    }
    if (host === "auth.localhost") return html(url.pathname === "/account" ? "Account" : "Auth fixture");
    if (host === "chat.localhost") return html("Chat fixture");
    if (host === "evolve.localhost") return html("Evolve fixture");
    return new Response("not found", { status: 404 });
  } });
}

const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: "object", properties, required, additionalProperties: false });
const action = (id: string, inputSchema: unknown, outputSchema: unknown, extra: Record<string, unknown> = {}) => ({ id, label: id, description: `Fixture ${id}.`, inputSchema, outputSchema,
  requireApproval: false, requireAuth: false, ...extra });
const searchAction = action("search", object({ query: { type: "string", minLength: 1 }, limit: { type: "integer", minimum: 1, maximum: 20, default: 10 }, cursor: { type: "string", minLength: 1 } }, ["query"]),
  object({ items: { type: "array", items: object({ title: { type: "string", minLength: 1 }, url: { type: ["string", "null"] }, snippet: { type: ["string", "null"] } }) },
    nextCursor: { type: ["string", "null"] }, scope: { type: "string", minLength: 1 }, coverage: { type: "string", enum: ["complete", "partial", "unknown"] } }));

let data = "", local = "", port = 0;
let model: ReturnType<typeof scriptedModel>, site: ReturnType<typeof fixtureSite>, mcp: ReturnType<typeof mcpFixture>;
let host: { process: ReturnType<typeof Bun.spawn>; port: number } | undefined;
let token = "";

async function startHost() {
  const origins = [...["app", "a", "b", "auth", "broken", "chat", "evolve"].map(name => `http://${name}.localhost:${site.port}`), `http://127.0.0.1:${mcp.port}`].join(",");
  const child = Bun.spawn([process.execPath, `${ROOT}/apps/linux/src/main.ts`, "serve", "--data", data, "--port", "0", "--name", "fixture"],
    { stdout: "pipe", stderr: "pipe", env: { ...Bun.env, OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "", OX_HOST_TEST_ORIGINS: origins } });
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

async function writeService(kind: string, domain: string, manifest: Record<string, unknown>, actions?: string) {
  const directory = join(local, kind, domain);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "service.json"), JSON.stringify(manifest, null, 2));
  if (actions !== undefined) await writeFile(join(directory, "actions.js"), actions);
  const repository = JSON.parse(await readFile(join(local, "repository.json"), "utf8")) as { services: string[] };
  if (!repository.services.includes(`${kind}:${domain}`)) repository.services.push(`${kind}:${domain}`);
  await writeFile(join(local, "repository.json"), JSON.stringify(repository, null, 2));
}

beforeAll(async () => {
  data = await mkdtemp(join(tmpdir(), "openox-linux-services-"));
  model = scriptedModel();
  site = fixtureSite();
  mcp = mcpFixture();
  port = site.port!;
  host = await startHost();
  token = /OX_HOST_TOKEN=(\S+)/.exec(await hostCommand("token", "--name", "services-test"))![1]!;
  const configured = await api("/api/settings/providers/custom", { method: "PUT", json: { name: "Scripted", baseUrl: `http://127.0.0.1:${model.port}/v1`, models: ["fixture"] } });
  expect(configured.status).toBe(200);
  const profile = (JSON.parse(await readFile(join(data, "host.json"), "utf8")) as { profile: { id: string } }).profile.id;
  local = join(data, "profiles", profile, "vm", "repositories", "local");
  await writeService("web", "app.localhost", {
    domain: "app.localhost", name: "App Fixture", description: "Fixture web app for Linux Host tests.", baseUrl: `http://app.localhost:${port}/`,
    $defs: { greeting: object({ greeting: { type: "string" } }) },
    actions: [
      action("greet", object({ name: { type: "string", minLength: 1 } }), { $ref: "#/$defs/greeting" }),
      action("brokenOutput", object({}), object({ count: { type: "integer" } })),
      action("placeOrder", object({ item: { type: "string" } }), object({ orderId: { type: "string" } }), { requireApproval: true }),
    ],
  }, `window.ox.install(({ action }) => {
  action("greet", { async invoke({ name }) { const response = await fetch("/api/greet?name=" + encodeURIComponent(name)); return await response.json(); } });
  action("brokenOutput", { async invoke() { return { count: "many" }; } });
  action("placeOrder", { async invoke({ item }) { const response = await fetch("/api/orders", { method: "POST", body: JSON.stringify({ item }) }); return await response.json(); } });
});\n`);
  for (const domain of ["a.localhost", "b.localhost"]) {
    await writeService("web", domain, { domain, name: `Search ${domain[0]!.toUpperCase()}`, description: "Fixture search.", baseUrl: `http://${domain}:${port}/`, actions: [searchAction] },
      `window.ox.install(({ action }) => action("search", { async invoke({ query, limit = 10 }) {
  const response = await fetch("/search?q=" + encodeURIComponent(query) + "&limit=" + limit);
  const data = await response.json();
  return { items: data.items, nextCursor: null, scope: "Fixture ${domain}", coverage: "complete" };
} }));\n`);
  }
  await writeService("web", "auth.localhost", {
    domain: "auth.localhost", name: "Auth Fixture", description: "Fixture site with accounts.", baseUrl: `http://auth.localhost:${port}/`,
    actions: [
      action("listSessions", object({}), { type: "array", items: object({ id: { type: "string" }, label: { type: "string" }, url: { type: "string" } }) }),
      action("login", object({}), { type: "null" }),
      action("whoami", object({}), object({ user: { type: "string" }, path: { type: "string" } }), { requireAuth: true }),
    ],
  }, `window.ox.install(({ action }) => {
  action("listSessions", { async invoke() { return document.cookie.includes("fixture_session=1") ? [{ id: "ada", label: "Ada", url: location.origin + "/account" }] : []; } });
  action("login", { async invoke() { document.cookie = "fixture_session=1; path=/"; return null; } });
  action("whoami", { async invoke(_, { session }) { return { user: session.label, path: location.pathname }; } });
});\n`);
  await writeService("web", "chat.localhost", {
    domain: "chat.localhost", name: "Chat Fixture", description: "Fixture website conversation.", baseUrl: `http://chat.localhost:${port}/`,
    actions: [{ id: "conversation", label: "Conversation", description: "Fixture conversation.", ...CONVERSATION_ACTION_SCHEMA, requireApproval: false, requireAuth: false }],
  }, `window.ox.install(({ action }) => action("conversation", { async invoke(args) {
  const state = window.__chat ??= { submissions: {}, next: 1 };
  if (args.operation === "submit") {
    const id = "native-" + state.next++;
    const text = "Echo: " + args.messages.at(-1).text;
    state.submissions[id] = [{ type: "text", text: "Echo:" }, { type: "text", text }, { type: "completed", result: { url: null, files: [] } }];
    return { operation: "submit", submissionId: id, conversationRef: "chat-1", submission: "confirmed", continuation: true, url: null };
  }
  if (args.operation === "read") {
    const events = state.submissions[args.submissionId].slice(args.after);
    return { operation: "read", conversationRef: "chat-1", url: null, nextCursor: args.after + events.length, events };
  }
  return { operation: "cancel", status: "completed" };
} }));\n`);
  await writeService("web", "evolve.localhost", {
    domain: "evolve.localhost", name: "Evolve Fixture", description: "Fixture edited through Local source.", baseUrl: `http://evolve.localhost:${port}/`,
    actions: [action("version", object({}), object({ value: { type: "string" } }))],
  }, `window.ox.install(({ action }) => action("version", { invoke() { return { value: "one" }; } }));\n`);
  await writeService("web", "broken.localhost", {
    domain: "broken.localhost", name: "Broken Fixture", baseUrl: `http://broken.localhost:${port}/`,
    actions: [action("first", object({}), object({})), action("second", object({}), object({}))],
  }, `window.ox.install(({ action }) => action("first", { invoke() { return {}; } }));\n`);
}, 60_000);

afterAll(async () => {
  if (host) { host.process.kill("SIGTERM"); await host.process.exited; }
  model?.stop(true);
  site?.stop(true);
  mcp?.stop(true);
  if (data) await rm(data, { recursive: true, force: true });
});

test("Services are listed, attached, inspected, invoked with output validation, and detached", async () => {
  const id = await conversation();
  const listed = (await run(id, `return await ox.service.list({ purpose: "List web services", kind: "web" });`)).value as Record<string, unknown>[];
  expect(listed.find(service => service.domain === "app.localhost")).toMatchObject({ kind: "web", repository: "local", repositoryProvenance: "local",
    manifestPath: "repositories/local/web/app.localhost/service.json", attached: false });
  expect(listed.find(service => service.domain === "en.wikipedia.org")).toMatchObject({ repository: "bundled", name: "Wikipedia" });
  expect(listed.some(service => service.kind !== "web")).toBe(false);
  conforms("ox.service.list", listed);
  const all = (await run(id, `return await ox.service.list({ purpose: "List services" });`)).value as Record<string, unknown>[];
  expect(all.find(service => service.domain === "ios:calendar")).toMatchObject({ kind: "ios", repository: "bundled" });
  conforms("ox.service.list", all);

  const { value } = await run(id, `
    const attached = await ox.service.attach({ purpose: "Attach the fixture", domain: "app.localhost" });
    const inspected = await ox.service.inspect({ purpose: "Inspect the fixture", domain: "app.localhost" });
    const listedAttached = await ox.service.listAttached({ purpose: "List attachments" });
    const greeting = await ox.service.invoke({ purpose: "Greet", name: "web:app.localhost:greet", input: { name: "Ada" } });
    const shown = await ox.service.showPage({ purpose: "Show the page", name: "web:app.localhost:greet", input: { name: "Ada" } });
    let invalid;
    try { await ox.service.invoke({ purpose: "Break", name: "web:app.localhost:brokenOutput" }); } catch (error) { invalid = { code: error.code, message: error.message }; }
    let badInput;
    try { await ox.service.invoke({ purpose: "Bad input", name: "web:app.localhost:greet", input: { name: 4 } }); } catch (error) { badInput = error.code; }
    let reused;
    try { await ox.service.showPage({ purpose: "Show the page", name: "web:app.localhost:greet", input: { name: "Ada" } }); } catch (error) { reused = error.code; }
    return { attached, inspected, listedAttached, greeting, invalid, badInput, shown, reused };
  `);
  expect(value.attached).toMatchObject({ domain: "app.localhost", kind: "web", attached: true, saved: true, reloaded: false, repository: "local" });
  expect(value.inspected.standardActions).toEqual([]);
  expect(Object.keys(value.inspected.actions)).toEqual(["brokenOutput", "greet", "placeOrder"]);
  expect(value.inspected.actions.greet.outputSchema).toMatchObject({ $ref: "#/$defs/greeting", $defs: { greeting: { type: "object" } } });
  expect(value.inspected.actions.placeOrder.requireApproval).toBe(true);
  expect(value.listedAttached.map((service: { domain: string }) => service.domain)).toEqual(["app.localhost"]);
  expect(value.greeting).toEqual({ greeting: "Hello Ada" });
  expect(value.invalid.code).toBe("invalid_output");
  expect(value.invalid.message).toContain("returned invalid output");
  expect(value.badInput).toBe("invalid_argument");
  expect(value.shown).toEqual({ shown: true });
  expect(value.reused).toBe("page_unavailable");
  conforms("ox.service.attach", value.attached);
  conforms("ox.service.inspect", value.inspected);
  conforms("ox.service.listAttached", value.listedAttached);
  conforms("ox.service.showPage", value.shown);
  const view = await getJSON<View>(`/api/conversations/${id}`);
  expect(JSON.stringify(view.blocks)).toContain("App fixture");
  expect(systemPrompts.at(-1)).toContain("app.localhost — Fixture web app for Linux Host tests.");

  const detached = (await run(id, `
    const detached = await ox.service.detach({ purpose: "Detach", domain: "app.localhost" });
    const remaining = await ox.service.listAttached({ purpose: "List attachments" });
    let stale;
    try { await ox.service.invoke({ purpose: "Greet", name: "web:app.localhost:greet", input: { name: "Ada" } }); } catch (error) { stale = error.code; }
    return { detached, remaining, stale };
  `)).value;
  expect(detached.detached).toMatchObject({ domain: "app.localhost", attached: false });
  expect(detached.remaining).toEqual([]);
  expect(detached.stale).toBe("service_not_attached");
  conforms("ox.service.detach", detached.detached);
  expect(systemPrompts.at(-1)).toContain("No services are attached.");
}, 60_000);

test("Approvals prompt through the respond API and Always approve persists per action", async () => {
  const id = await conversation();
  const order = `await ox.service.attach({ purpose: "Attach", domain: "app.localhost" });
    return await ox.service.invoke({ purpose: "Order", name: "web:app.localhost:placeOrder", input: { item: "tea" } });`;
  const first = await run(id, order, prompt => ({ answer: "Approve" }));
  expect(first.prompts).toHaveLength(1);
  expect(first.prompts[0]!.options).toEqual(["Approve", "Always approve", "Deny"]);
  expect(first.prompts[0]!.prompt).toContain("App Fixture - placeOrder");
  expect(first.value).toEqual({ orderId: "order-1" });
  const always = await run(id, order, () => ({ answer: "Always approve" }));
  expect(always.value).toEqual({ orderId: "order-2" });
  const silent = await run(id, order);
  expect(silent.prompts).toHaveLength(0);
  expect(silent.value).toEqual({ orderId: "order-3" });
  const services = (await getJSON<{ services: { domain: string; alwaysApproved: string[]; available: boolean; repository: string }[] }>("/api/services")).services;
  expect(services.find(service => service.domain === "app.localhost")).toMatchObject({ alwaysApproved: ["web:app.localhost:placeOrder"], available: true, repository: "local" });
  expect(services.find(service => service.domain === "ios:calendar")).toMatchObject({ available: false });
  expect((await (await api("/api/services/app.localhost/approvals", { method: "DELETE" })).json())).toEqual({ cleared: true });
  const denied = await run(id, order, () => ({ answer: "Deny" }));
  expect(denied.value).toMatchObject({ error: "permission_denied" });
  expect(orders).toEqual(["tea", "tea", "tea"]);
  const state = join(local, "..", "..", "state");
  expect(JSON.parse(await readFile(join(state, "attachments.json"), "utf8")).conversations[String(id)]).toHaveLength(1);
  expect((await api(`/api/conversations/${id}`, { method: "DELETE" })).status).toBe(200);
  expect(JSON.parse(await readFile(join(state, "attachments.json"), "utf8")).conversations[String(id)]).toBeUndefined();
}, 60_000);

test("Local source edits through the repositories mount take effect only after attach reloads them", async () => {
  const id = await conversation();
  const { value } = await run(id, `
    const name = "web:evolve.localhost:version";
    await ox.service.attach({ purpose: "Attach", domain: "evolve.localhost" });
    const before = await ox.service.invoke({ purpose: "Version", name });
    await ox.fs.edit({ purpose: "Edit source", path: "/repositories/local/web/evolve.localhost/actions.js", edits: [{ oldText: '"one"', newText: '"two"' }] });
    const unchanged = await ox.service.invoke({ purpose: "Version", name });
    const valid = await ox.service.validate({ purpose: "Validate", domain: "evolve.localhost" });
    const reloaded = await ox.service.attach({ purpose: "Reload", domain: "evolve.localhost" });
    const after = await ox.service.invoke({ purpose: "Version", name });
    let readOnly;
    try { await ox.fs.write({ purpose: "Write", path: "/repositories/bundled/web/en.wikipedia.org/actions.js", content: "" }); } catch (error) { readOnly = error.code; }
    return { before, unchanged, valid, reloaded: reloaded.reloaded, after, readOnly };
  `);
  expect(value).toEqual({ before: { value: "one" }, unchanged: { value: "one" }, valid: { domain: "evolve.localhost", valid: true }, reloaded: true, after: { value: "two" },
    readOnly: "permission_denied" });
}, 60_000);

test("Native iOS services are listed but not supported, and broken Local services fail validation", async () => {
  const id = await conversation();
  const { value } = await run(id, `
    const result = {};
    for (const [label, work] of [
      ["invoke", () => ox.service.invoke({ purpose: "Add event", name: "ios:calendar:addEvent", input: {} })],
      ["attach", () => ox.service.attach({ purpose: "Attach calendar", domain: "ios:calendar" })],
      ["validate", () => ox.service.validate({ purpose: "Validate broken", domain: "broken.localhost" })],
      ["attachBroken", () => ox.service.attach({ purpose: "Attach broken", domain: "broken.localhost" })],
    ]) {
      try { result[label] = await work(); } catch (error) { result[label] = { code: error.code, message: error.message }; }
    }
    result.valid = await ox.service.validate({ purpose: "Validate app", domain: "app.localhost" });
    return result;
  `);
  expect(value.invoke.code).toBe("not_supported");
  expect(value.invoke.message).toContain("not available on this Linux Host");
  expect(value.attach.code).toBe("not_supported");
  expect(value.validate.code).toBe("invalid_argument");
  expect(value.validate.message).toContain("actions.js registration mismatch; missing implementations: second");
  expect(value.attachBroken.message).toContain("missing implementations: second");
  expect(value.valid).toEqual({ domain: "app.localhost", valid: true });
  conforms("ox.service.validate", value.valid);
}, 60_000);

test("Web search merges two fixture services with reciprocal rank fusion and reports unsupported domains", async () => {
  const id = await conversation();
  const { value } = await run(id, `return await ox.web.search({ purpose: "Search fixtures", query: "shared", domains: ["a.localhost", "b.localhost", "app.localhost"], limit: 5 });`);
  expect(value.query).toBe("shared");
  conforms("ox.web.search", value);
  expect(value.results.map((result: { service: string }) => result.service)).toEqual(["web:a.localhost", "web:b.localhost"]);
  expect(value.results[0]).toMatchObject({ scope: "Fixture a.localhost", coverage: "complete", nextCursor: null });
  expect(value.errors).toEqual([expect.objectContaining({ service: "web:app.localhost", code: "search_unsupported" })]);
  expect(value.mergedResults[0].sources).toEqual([{ service: "web:a.localhost", rank: 1 }, { service: "web:b.localhost", rank: 2 }]);
  expect(value.mergedResults[0].score).toBeCloseTo(1 / 61 + 1 / 62, 10);
  expect(value.mergedResults.slice(1).map((entry: { sources: unknown[] }) => entry.sources)).toEqual([[{ service: "web:b.localhost", rank: 1 }], [{ service: "web:a.localhost", rank: 2 }]]);
}, 60_000);

test("Website login hands off a live page and session-aware actions use the discovered account", async () => {
  const id = await conversation();
  const { value, prompts } = await run(id, `
    await ox.service.attach({ purpose: "Attach", domain: "auth.localhost" });
    const before = await ox.service.invoke({ purpose: "Sessions", name: "web:auth.localhost:listSessions" });
    let signedOut;
    try { await ox.service.invoke({ purpose: "Who", name: "web:auth.localhost:whoami" }); } catch (error) { signedOut = error.code; }
    const login = await ox.service.invoke({ purpose: "Log in", name: "web:auth.localhost:login" });
    const after = await ox.service.invoke({ purpose: "Sessions", name: "web:auth.localhost:listSessions" });
    const who = await ox.service.invoke({ purpose: "Who", name: "web:auth.localhost:whoami" });
    return { before, signedOut, login, after, who };
  `, prompt => prompt.requiresApp ? { answer: "Done" } : undefined);
  expect(prompts).toHaveLength(1);
  expect(prompts[0]!.prompt).toContain("Auth Fixture - Log in");
  expect(value.before).toEqual([]);
  expect(value.signedOut).toBe("authentication_required");
  expect(value.login).toBeNull();
  expect(value.after).toEqual([{ id: "ada", label: "Ada", url: `http://auth.localhost:${port}/account` }]);
  expect(value.who).toEqual({ user: "Ada", path: "/account" });
  const pages = await getJSON<{ pages: { owner: string; url: string }[] }>("/api/pages");
  expect(pages.pages.some(page => page.owner.startsWith("service:auth.localhost:session:") && page.url.endsWith("/account"))).toBe(true);
  const opened = await api("/api/services/auth.localhost/login", { method: "POST" });
  expect(opened.status).toBe(200);
  expect(((await opened.json()) as { page: { owner: string; url: string } }).page).toMatchObject({ owner: "service:auth.localhost", url: `http://auth.localhost:${port}/` });
  const plain = (await (await api("/api/services/app.localhost/login", { method: "POST" })).json()) as { page: { owner: string; url: string } };
  expect(plain.page).toMatchObject({ owner: "service:app.localhost", url: `http://app.localhost:${port}/` });
}, 60_000);

test("Website conversations submit, read and continue on a dedicated page", async () => {
  const id = await conversation();
  const { value } = await run(id, `
    const name = "web:chat.localhost:conversation";
    const inspected = await ox.service.attach({ purpose: "Attach", domain: "chat.localhost" }).then(() => ox.service.inspect({ purpose: "Inspect", domain: "chat.localhost" }));
    const options = { temperature: null, maxTokens: null };
    const first = await ox.service.invoke({ purpose: "Submit", name, input: { operation: "submit", conversationRef: null, accountId: null, modelId: "fixture",
      messages: [{ role: "user", text: "hello" }], attachments: [], options } });
    const read = await ox.service.invoke({ purpose: "Read", name, input: { operation: "read", submissionId: first.submissionId, after: 0, waitMilliseconds: 0 } });
    const second = await ox.service.invoke({ purpose: "Continue", name, input: { operation: "submit", conversationRef: first.conversationRef, accountId: null, modelId: "fixture",
      messages: [{ role: "user", text: "again" }], attachments: [], options } });
    let skipped;
    try { await ox.service.invoke({ purpose: "Read", name, input: { operation: "read", submissionId: second.submissionId, after: 1, waitMilliseconds: 0 } }); } catch (error) { skipped = error.message; }
    const reread = await ox.service.invoke({ purpose: "Read", name, input: { operation: "read", submissionId: second.submissionId, after: 0, waitMilliseconds: 0 } });
    let unknown;
    try { await ox.service.invoke({ purpose: "Read", name, input: { operation: "read", submissionId: "missing", after: 0, waitMilliseconds: 0 } }); } catch (error) { unknown = error.message; }
    return { standard: inspected.standardActions, first, read, second, skipped, reread, unknown };
  `);
  expect(value.standard).toEqual(["conversation"]);
  expect(value.first).toMatchObject({ operation: "submit", submission: "confirmed", continuation: true, url: null });
  expect(value.first.submissionId).not.toBe("native-1");
  expect(value.read).toEqual({ operation: "read", conversationRef: value.first.conversationRef, url: null, nextCursor: 3,
    events: [{ type: "text", text: "Echo:" }, { type: "text", text: "Echo: hello" }, { type: "completed", result: { url: null, files: [] } }] });
  expect(value.second.conversationRef).toBe(value.first.conversationRef);
  expect(value.skipped).toContain("skips unobserved events");
  expect(value.reread.events.map((event: { text?: string }) => event.text)).toEqual(["Echo:", "Echo: again", undefined]);
  expect(value.unknown).toContain("expired or belongs to another caller");
  const pages = await getJSON<{ pages: { owner: string; conversationId: number | null }[] }>(`/api/pages?conversation=${id}`);
  expect(pages.pages.some(page => page.owner.startsWith("service:chat.localhost:conversation:"))).toBe(true);
}, 60_000);

test("Local services can be renamed and deleted with approval, and remote MCP connections are created, invoked and removed", async () => {
  const id = await conversation();
  const renamed = (await run(id, `return await ox.service.update({ purpose: "Rename", domain: "broken.localhost", name: "Renamed Fixture" });`)).value;
  expect(renamed).toMatchObject({ domain: "broken.localhost", name: "Renamed Fixture", kind: "web" });
  conforms("ox.service.update", renamed);
  expect((await getJSON<{ services: { domain: string; name: string }[] }>("/api/services")).services.find(service => service.domain === "broken.localhost")!.name).toBe("Renamed Fixture");
  const deleted = await run(id, `return await ox.service.delete({ purpose: "Delete", domain: "broken.localhost" });`, prompt => ({ answer: "Approve" }));
  expect(deleted.prompts[0]!.prompt).toContain("Delete a service");
  expect(deleted.value).toEqual({ domain: "broken.localhost", kind: "web", deleted: true, source: "local" });
  conforms("ox.service.delete", deleted.value);
  expect(JSON.parse(await readFile(join(local, "repository.json"), "utf8")).services).not.toContain("web:broken.localhost");

  const endpoint = `http://127.0.0.1:${mcp.port}/mcp`;
  const created = (await run(id, `
    const created = await ox.service.create({ purpose: "Connect MCP", kind: "mcp", endpoint: ${JSON.stringify(endpoint)} });
    const again = await ox.service.create({ purpose: "Connect MCP", kind: "mcp", endpoint: ${JSON.stringify(endpoint)} });
    const attached = await ox.service.attach({ purpose: "Attach MCP", domain: created.domain });
    const inspected = await ox.service.inspect({ purpose: "Inspect MCP", domain: created.domain });
    const status = await ox.service.invoke({ purpose: "Status", name: "mcp:" + created.domain + ":connectionStatus" });
    const authorize = await ox.service.invoke({ purpose: "Authorize", name: "mcp:" + created.domain + ":authorize" });
    return { created, again, attached, inspected, status, authorize };
  `)).value;
  conforms("ox.service.create", created.created);
  expect(created.created).toMatchObject({ domain: "127.0.0.1", kind: "mcp", endpoint, transport: "auto", repository: "local", saved: true });
  expect(created.again.domain).toBe("127.0.0.1");
  expect(created.attached).toMatchObject({ domain: "127.0.0.1", kind: "mcp", attached: true });
  expect(created.inspected.standardActions).toEqual(["connectionStatus", "authorize"]);
  expect(created.inspected.actions.add).toMatchObject({ description: "Adds two numbers.", requireApproval: true });
  expect(created.status).toEqual({ state: "notRequired" });
  expect(created.authorize).toEqual({ completed: true, completion: "notRequired", state: "notRequired" });
  const invoked = await run(id, `return await ox.service.invoke({ purpose: "Add", name: "mcp:127.0.0.1:add", input: { a: 2, b: 3 } });`, () => ({ answer: "Approve" }));
  expect(invoked.prompts).toHaveLength(1);
  expect(invoked.value).toEqual({ sum: 5 });
  expect(toolCalls).toEqual([{ a: 2, b: 3 }]);
  const removed = await run(id, `
    const removed = await ox.service.delete({ purpose: "Remove MCP", domain: "127.0.0.1" });
    return { removed, attached: await ox.service.listAttached({ purpose: "List" }) };
  `, () => ({ answer: "Approve" }));
  expect(removed.value).toEqual({ removed: { domain: "127.0.0.1", kind: "mcp", deleted: true }, attached: [] });
}, 60_000);

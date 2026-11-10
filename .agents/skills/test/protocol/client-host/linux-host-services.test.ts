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
const { Server } = await sdk("server/index.js") as { Server: new (info: object, options: object) => { setRequestHandler(schema: unknown, handler: (request: { params: { name: string; arguments: Record<string, number> } }) => unknown): void; connect(transport: unknown): Promise<void> } };
const { WebStandardStreamableHTTPServerTransport } = await sdk("server/webStandardStreamableHttp.js") as { WebStandardStreamableHTTPServerTransport: new (options: object) => { handleRequest(request: Request): Promise<Response> } };
const { CallToolRequestSchema, ListToolsRequestSchema } = await sdk("types.js") as { CallToolRequestSchema: unknown; ListToolsRequestSchema: unknown };
const { CONVERSATION_ACTION_SCHEMA } = await import(join(ROOT, "packages", "protocol", "src", "model-actions.ts")) as { CONVERSATION_ACTION_SCHEMA: { inputSchema: unknown; outputSchema: unknown } };
const toolCalls: Record<string, number>[] = [];
let toolsGate: Promise<void> | undefined, toolsListed = 0;
const chartPNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 7, 7, 7]);
function mcpFixture() {
  return Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const server = new Server({ name: "fixture-mcp", version: "1.0.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      toolsListed += 1;
      await toolsGate;
      return { tools: [{ name: "add", title: "Add numbers", description: "Adds two numbers.",
        inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] },
        outputSchema: { type: "object", properties: { sum: { type: "number" } }, required: ["sum"] } },
        { name: "chart", title: "Chart", description: "Draws a chart.", inputSchema: { type: "object", properties: {} } },
        { name: "measure", title: "Measure", description: "Measures a file.", inputSchema: { type: "object", properties: { file: { type: "string", contentEncoding: "base64" } }, required: ["file"] },
          outputSchema: { type: "object", properties: { bytes: { type: "number" } }, required: ["bytes"] } }] };
    });
    server.setRequestHandler(CallToolRequestSchema, request => {
      if (request.params.name === "chart") return { content: [{ type: "image", data: Buffer.from(chartPNG).toString("base64"), mimeType: "image/png" }] };
      if (request.params.name === "measure") return { content: [{ type: "text", text: "measured" }], structuredContent: { bytes: Buffer.from(String(request.params.arguments.file), "base64").length } };
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
    const events = last.role === "tool" ? text("done") : call("Run the test script", contentText(last.content).replace(/^\[[^\]\n]*\]\n\n/, ""));
    return new Response(events.join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  } });
}

const orders: string[] = [];
const greetCookies: string[] = [];
let sessionCookie = 0;
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
      if (url.pathname === "/api/greet") {
        greetCookies.push(request.headers.get("cookie") ?? "");
        return Response.json({ greeting: `Hello ${url.searchParams.get("name")}` });
      }
      if (url.pathname === "/" && !(request.headers.get("cookie") ?? "").includes("session=")) {
        sessionCookie += 1;
        return new Response("<!doctype html><title>App fixture</title><h1>App fixture</h1>", { headers: { "content-type": "text/html", "set-cookie": `session=${sessionCookie}; Path=/` } });
      }
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
  const { value, prompts, view: finished } = await run(id, `
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
  const handoff = (finished as unknown as { blocks: { kind: Record<string, unknown> }[] }).blocks.map(block => block.kind).find(kind => kind.type === "confirm" && kind.promptKind === "page");
  expect(handoff).toMatchObject({ title: "Auth Fixture - Log in", done: "Done", login: true });
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

test("The web client attaches and detaches a service for a conversation, and the agent sees the change", async () => {
  const id = await conversation();
  type Listed = { services: { domain: string; attached?: boolean; saved: boolean }[] };
  const attach = (domain: string, target: unknown = id) => api(`/api/services/${domain}/attach`, { method: "POST", json: { conversation: target } });
  expect((await attach("app.localhost")).status).toBe(200);
  const listed = (await getJSON<Listed>(`/api/services?conversation=${id}`)).services;
  expect(listed.find(service => service.domain === "app.localhost")).toMatchObject({ attached: true, saved: true });
  expect(listed.find(service => service.domain === "en.wikipedia.org")).toMatchObject({ attached: false });
  expect((await getJSON<Listed>("/api/services")).services.find(service => service.domain === "app.localhost")).not.toHaveProperty("attached");
  const seen = (await run(id, `return await ox.service.listAttached({ purpose: "List attachments" });`)).value as { domain: string }[];
  expect(seen.map(service => service.domain)).toEqual(["app.localhost"]);
  expect(systemPrompts.at(-1)).toContain("app.localhost — Fixture web app for Linux Host tests.");
  expect((await attach("ios:calendar")).status).toBe(400);
  expect((await attach("nothing.example")).status).toBe(404);
  expect((await attach("app.localhost", 999_999)).status).toBe(404);
  expect((await attach("app.localhost", "x")).status).toBe(400);
  expect((await api(`/api/services/app.localhost/attach?conversation=${id}`, { method: "DELETE" })).status).toBe(200);
  expect((await getJSON<Listed>(`/api/services?conversation=${id}`)).services.find(service => service.domain === "app.localhost")).toMatchObject({ attached: false });
  expect((await run(id, `return await ox.service.listAttached({ purpose: "List attachments" });`)).value).toEqual([]);
  expect(systemPrompts.at(-1)).toContain("No services are attached.");
}, 60_000);

test("Permissions set the default, source and action policies, and secrets are added and edited without exposing values", async () => {
  const id = await conversation();
  type Permissions = { default: string | null; builtIn: { policy: string | null; actions: { id: string; default: string; policy: string | null; group: string }[] }; services: { domain: string; policy: string | null }[] };
  const order = `await ox.service.attach({ purpose: "Attach", domain: "app.localhost" });
    return await ox.service.invoke({ purpose: "Order", name: "web:app.localhost:placeOrder", input: { item: "coffee" } });`;
  const put = (json: unknown) => api("/api/permissions", { method: "PUT", json });
  const initial = await getJSON<Permissions>("/api/permissions");
  expect(initial.default).toBeNull();
  expect(initial.builtIn.actions.find(action => action.id === "ox.schedule.create")).toMatchObject({ default: "ask", policy: null, group: "schedule" });
  expect(initial.builtIn.actions.find(action => action.id === "ox.secret.delete")).toMatchObject({ default: "ask" });
  expect(initial.services.some(service => service.domain === "ios:calendar")).toBe(false);
  const detail = await getJSON<{ actions: { id: string; default: string; policy: string | null }[] }>("/api/permissions/app.localhost");
  expect(detail.actions[0]).toMatchObject({ id: "ox.service.attach:app.localhost", default: "allow" });
  expect(detail.actions.find(action => action.id === "web:app.localhost:placeOrder")).toMatchObject({ default: "ask", policy: null });
  expect((await api("/api/permissions/ios:calendar")).status).toBe(400);

  expect((await put({ scope: "action", id: "web:app.localhost:placeOrder", policy: "allow" })).status).toBe(200);
  expect((await run(id, order)).prompts).toHaveLength(0);
  expect((await getJSON<{ actions: { id: string; policy: string | null }[] }>("/api/permissions/app.localhost")).actions
    .find(action => action.id === "web:app.localhost:placeOrder")).toMatchObject({ policy: "allow" });
  expect((await put({ scope: "action", id: "web:app.localhost:placeOrder", policy: null })).status).toBe(200);
  expect((await put({ scope: "source", id: "app.localhost", policy: "block" })).status).toBe(200);
  expect((await run(id, order)).value).toMatchObject({ error: "permission_denied" });
  expect((await getJSON<Permissions>("/api/permissions")).services.find(service => service.domain === "app.localhost")).toMatchObject({ policy: "block" });
  expect((await put({ scope: "source", id: "app.localhost", policy: null })).status).toBe(200);
  expect((await put({ scope: "default", policy: "allow" })).status).toBe(200);
  expect((await getJSON<Permissions>("/api/permissions")).default).toBe("allow");
  expect((await run(id, order)).prompts).toHaveLength(0);
  expect((await put({ scope: "default", policy: null })).status).toBe(200);
  expect((await put({ scope: "default", policy: "never" })).status).toBe(400);
  expect((await put({ scope: "nowhere", policy: "ask" })).status).toBe(400);
  const asked = await run(id, order, () => ({ answer: "Deny" }));
  expect(asked.prompts).toHaveLength(1);

  expect((await put({ scope: "source", id: "app.localhost", policy: "block" })).status).toBe(200);
  expect((await put({ scope: "action", id: "web:app.localhost:placeOrder", policy: "ask" })).status).toBe(200);
  expect((await put({ scope: "action", id: "ox.service.attach:app.localhost", policy: "allow" })).status).toBe(200);
  expect((await put({ scope: "action", id: "ox.schedule.create", policy: "allow" })).status).toBe(200);
  expect((await getJSON<{ approvals: { action: string }[] }>("/api/approvals")).approvals.map(entry => entry.action).sort()).toEqual(["ox.schedule.create", "ox.service.attach:app.localhost"]);
  expect((await api("/api/services/app.localhost/approvals", { method: "DELETE" })).status).toBe(200);
  const reset = await getJSON<{ policy: string | null; actions: { id: string; policy: string | null }[] }>("/api/permissions/app.localhost");
  expect(reset.policy).toBe("block");
  expect(reset.actions.find(action => action.id === "web:app.localhost:placeOrder")).toMatchObject({ policy: "ask" });
  expect(reset.actions.find(action => action.id === "ox.service.attach:app.localhost")).toMatchObject({ policy: null });
  expect((await api("/api/approvals", { method: "DELETE" })).status).toBe(200);
  const forgotten = await getJSON<Permissions>("/api/permissions");
  expect(forgotten.builtIn.actions.find(action => action.id === "ox.schedule.create")).toMatchObject({ policy: null });
  expect(forgotten.services.find(service => service.domain === "app.localhost")).toMatchObject({ policy: "block" });
  expect((await getJSON<{ actions: { id: string; policy: string | null }[] }>("/api/permissions/app.localhost")).actions
    .find(action => action.id === "web:app.localhost:placeOrder")).toMatchObject({ policy: "ask" });
  expect((await put({ scope: "source", id: "app.localhost", policy: null })).status).toBe(200);
  expect((await put({ scope: "action", id: "web:app.localhost:placeOrder", policy: null })).status).toBe(200);

  const added = await api("/api/secrets", { method: "POST", json: { key: "fixture-token", name: "Fixture token", fields: { apiKey: "secret-abc" } } });
  expect(added.status).toBe(201);
  expect(await added.text()).not.toContain("secret-abc");
  expect((await api("/api/secrets", { method: "POST", json: { key: "fixture-token", fields: { apiKey: "x" } } })).status).toBe(409);
  expect((await api("/api/secrets", { method: "POST", json: { key: "ox.reserved", fields: { apiKey: "x" } } })).status).toBe(400);
  expect((await api("/api/secrets", { method: "POST", json: { key: "empty", fields: {} } })).status).toBe(400);
  const edited = await api("/api/secrets/fixture-token", { method: "PUT", json: { name: "Renamed token", fields: { apiKey: "", region: "eu-west" } } });
  expect(edited.status).toBe(200);
  expect(await edited.json()).toEqual({ key: "fixture-token", name: "Renamed token", fields: ["apiKey", "region"] });
  expect((await api("/api/secrets/fixture-token", { method: "PUT", json: { fields: { extra: "" } } })).status).toBe(400);
  expect((await api("/api/secrets/missing", { method: "PUT", json: { fields: { value: "v" } } })).status).toBe(404);
  const listed = await (await api("/api/secrets")).text();
  expect(listed).toContain("Renamed token");
  expect(listed).not.toContain("secret-abc");
  expect(listed).not.toContain("eu-west");
  const stored = JSON.parse(await readFile(join(local, "..", "..", "state", "secrets.json"), "utf8")) as { entries: { key: string; value: Record<string, string> }[] };
  expect(stored.entries.find(entry => entry.key === "fixture-token")?.value).toEqual({ apiKey: "secret-abc", region: "eu-west" });
  expect((await api("/api/secrets/fixture-token", { method: "DELETE" })).status).toBe(200);
}, 90_000);

test("Service details save, open the website, clear website data, share and import packages, and delete Local services", async () => {
  const { zipDecode, zipEncode } = await import(`${ROOT}/apps/linux/src/vm/skills-package.ts`) as typeof import("../../../../../apps/linux/src/vm/skills-package");
  type Detail = { domain: string; kind: string; name: string; description: string; saved: boolean; supportsLogin: boolean; repository: { kind: string };
    manage: Record<string, boolean>; policy: string | null; attach: { id: string }; actions: { id: string; label: string; description: string; standard: boolean; authenticated: boolean; default: string }[] };
  const detail = await getJSON<Detail>("/api/services/app.localhost");
  expect(detail).toMatchObject({ domain: "app.localhost", kind: "web", name: "App Fixture", description: "Fixture web app for Linux Host tests.", repository: { kind: "local" },
    manage: { inspect: true, share: true, websiteData: true, removeServer: false, deleteLocal: true }, attach: { id: "ox.service.attach:app.localhost" } });
  expect(detail.actions.find(action => action.id === "web:app.localhost:placeOrder")).toMatchObject({ label: "placeOrder", description: "Fixture placeOrder.", default: "ask", standard: false });
  expect(detail.actions.find(action => action.id === "web:app.localhost:greet")).toMatchObject({ default: "allow" });
  expect((await api("/api/services/en.wikipedia.org")).status).toBe(200);
  expect((await getJSON<Detail>("/api/services/en.wikipedia.org")).manage).toMatchObject({ share: false, deleteLocal: false });
  expect((await api("/api/services/missing.example")).status).toBe(404);

  expect((await api("/api/services/app.localhost/saved", { method: "PUT", json: { saved: false } })).status).toBe(200);
  expect((await getJSON<Detail>("/api/services/app.localhost")).saved).toBe(false);
  expect((await api("/api/services/app.localhost/saved", { method: "PUT", json: { saved: true } })).status).toBe(200);
  expect((await getJSON<{ services: { domain: string; saved: boolean }[] }>("/api/services")).services.find(service => service.domain === "app.localhost")?.saved).toBe(true);
  expect((await api("/api/services/app.localhost/saved", { method: "PUT", json: { saved: "yes" } })).status).toBe(400);

  const opened = await api("/api/services/app.localhost/page", { method: "POST" });
  expect(opened.status).toBe(200);
  expect(((await opened.json()) as { page: { id: string } }).page.id).toBeTruthy();
  const id = await conversation();
  const greet = `await ox.service.attach({ purpose: "Attach", domain: "app.localhost" });
    return await ox.service.invoke({ purpose: "Greet", name: "web:app.localhost:greet", input: { name: "Ada" } });`;
  expect((await run(id, greet)).value).toEqual({ greeting: "Hello Ada" });
  expect((await api("/api/services/app.localhost/website-data", { method: "DELETE" })).status).toBe(200);
  expect((await run(id, greet)).value).toEqual({ greeting: "Hello Ada" });
  expect(greetCookies.slice(-2)).toEqual(["session=1", "session=2"]);
  expect((await api("/api/services/en.wikipedia.org/website-data", { method: "DELETE" })).status).toBe(200);

  const shared = await api("/api/services/app.localhost/package");
  expect(shared.status).toBe(200);
  expect(shared.headers.get("content-disposition")).toContain("app.localhost.service");
  const archive = new Uint8Array(await shared.arrayBuffer());
  const files = zipDecode(archive, 4_500_000, 4_000_000, 65);
  expect(files.map(file => file.path).sort()).toEqual(["package.json", "services/web/app.localhost/actions.js", "services/web/app.localhost/service.json"]);
  expect(JSON.parse(new TextDecoder().decode(files.find(file => file.path === "package.json")!.data))).toEqual({ version: 1, kind: "web", domain: "app.localhost" });
  expect((await api("/api/services/en.wikipedia.org/package")).status).toBe(400);

  const stage = async (data: Uint8Array) => api("/api/service-imports", { method: "POST", body: new Blob([data as Uint8Array<ArrayBuffer>]) });
  const encoder = new TextEncoder();
  const manifest = { domain: "new.localhost", name: "New Fixture", description: "Imported fixture.", baseUrl: `http://new.localhost:${port}/`, actions: [] };
  const fresh = (header: unknown, files: Record<string, string>) => zipEncode([{ path: "package.json", data: encoder.encode(JSON.stringify(header)) },
    ...Object.entries(files).map(([path, text]) => ({ path, data: encoder.encode(text) }))], 4_500_000);
  const refused = async (data: Uint8Array, message: string) => {
    const response = await stage(data);
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain(message);
  };
  expect((await api("/api/services/import", { method: "POST", body: new Blob([archive as Uint8Array<ArrayBuffer>]) })).status).toBe(404);
  const preview = await (await stage(archive)).json() as { token: string; name: string; domain: string; actions: string[]; exists: boolean };
  expect(preview).toMatchObject({ name: "App Fixture", domain: "app.localhost", actions: ["greet", "brokenOutput", "placeOrder"], exists: true });
  expect((await api(`/api/service-imports/${preview.token}`, { method: "POST", json: {} })).status).toBe(409);
  const appFiles = Object.fromEntries(files.filter(file => file.path !== "package.json").map(file => [file.path, new TextDecoder().decode(file.data)]));
  const appHeader = { version: 1, kind: "web", domain: "app.localhost" };
  const unregistered = await (await stage(fresh(appHeader, { ...appFiles, "services/web/app.localhost/actions.js": "window.ox.install(() => {});\n" }))).json() as { token: string; exists: boolean };
  expect(unregistered.exists).toBe(true);
  expect((await api(`/api/service-imports/${unregistered.token}`, { method: "POST", json: { replace: true } })).status).toBe(400);
  expect((await run(id, greet)).value).toEqual({ greeting: "Hello Ada" });
  const clashing = await (await stage(fresh(appHeader, { ...appFiles, "services/web/app.localhost/a": "x", "services/web/app.localhost/a/b": "y" }))).json() as { token: string };
  expect((await api(`/api/service-imports/${clashing.token}`, { method: "POST", json: { replace: true } })).status).toBe(400);
  expect((await run(id, greet)).value).toEqual({ greeting: "Hello Ada" });
  await refused(fresh(appHeader, { ...appFiles, "services/web/app.localhost/service.json": JSON.stringify({ domain: "app.localhost" }) }), "missing or invalid source files");
  const again = await (await stage(archive)).json() as { token: string };
  expect((await api(`/api/service-imports/${again.token}`, { method: "POST", json: { replace: true } })).status).toBe(201);
  expect((await run(id, greet)).value).toEqual({ greeting: "Hello Ada" });


  const valid = fresh({ version: 1, kind: "web", domain: "new.localhost" }, { "services/web/new.localhost/service.json": JSON.stringify(manifest),
    "services/web/new.localhost/actions.js": "window.ox.install(() => {});\n" });
  const added = await (await stage(valid)).json() as { token: string; exists: boolean; name: string };
  expect(added).toMatchObject({ name: "New Fixture", exists: false });
  expect((await api(`/api/service-imports/${added.token}`, { method: "POST", json: {} })).status).toBe(201);
  expect((await getJSON<Detail>("/api/services/new.localhost")).repository.kind).toBe("local");
  await refused(fresh({ version: 1, kind: "web", domain: "other.localhost" }, { "services/web/other.localhost/service.json": JSON.stringify(manifest),
    "services/web/other.localhost/actions.js": "" }), "missing or invalid source files");
  await refused(fresh({ version: 1, kind: "web", domain: "other.localhost" }, { "services/web/other.localhost/service.json": JSON.stringify({ ...manifest, domain: "other.localhost" }) }),
    "missing or invalid source files");
  await refused(fresh({ version: 2, kind: "web", domain: "new.localhost" }, {}), "isn't a valid Ox service package");
  await refused(fresh({ version: 1, kind: "mcp", domain: "new.localhost" }, {}), "isn't a valid Ox service package");
  await refused(encoder.encode("not a zip"), "isn't a valid Ox service package");
  const discarded = await (await stage(valid)).json() as { token: string };
  expect((await api(`/api/service-imports/${discarded.token}`, { method: "DELETE" })).status).toBe(200);
  expect((await api(`/api/service-imports/${discarded.token}`, { method: "POST", json: {} })).status).toBe(404);

  await mkdir(join(local, "web", "stray.localhost"), { recursive: true });
  await writeFile(join(local, "web", "stray.localhost", "draft.txt"), "keep me");
  const stray = await (await stage(fresh({ version: 1, kind: "web", domain: "stray.localhost" }, { "services/web/stray.localhost/service.json": JSON.stringify({ ...manifest, domain: "stray.localhost", baseUrl: `http://stray.localhost:${port}/` }),
    "services/web/stray.localhost/actions.js": "window.ox.install(() => {});\n" }))).json() as { token: string };
  expect((await api(`/api/service-imports/${stray.token}`, { method: "POST", json: {} })).status).toBe(409);
  expect(await readFile(join(local, "web", "stray.localhost", "draft.txt"), "utf8")).toBe("keep me");
  await rm(join(local, "web", "stray.localhost"), { recursive: true, force: true });
  await refused(fresh({ version: 1, kind: "api", domain: "a".repeat(250) }, {}), "isn't a valid Ox service package");

  const race = fresh({ version: 1, kind: "web", domain: "race.localhost" }, { "services/web/race.localhost/service.json": JSON.stringify({ ...manifest, domain: "race.localhost", baseUrl: `http://race.localhost:${port}/` }),
    "services/web/race.localhost/actions.js": "window.ox.install(() => {});\n" });
  const racers = await Promise.all([stage(race), stage(race)].map(async response => ((await response).json() as Promise<{ token: string }>)));
  const raced = await Promise.all(racers.map(racer => api(`/api/service-imports/${racer.token}`, { method: "POST", json: {} }).then(response => response.status)));
  expect(raced.sort()).toEqual([201, 409]);
  expect((await api("/api/services/race.localhost", { method: "DELETE" })).status).toBe(200);

  const registry = join(local, "repository.json");
  const original = await readFile(registry, "utf8");
  const listed = JSON.parse(original) as { services: string[] };
  const filler = Array.from({ length: 256 - listed.services.length }, (_, index) => `api:filler-${index}`);
  await writeFile(registry, JSON.stringify({ ...listed, services: [...listed.services, ...filler].sort() }));
  const full = await (await stage(race)).json() as { token: string };
  const refusedFull = await api(`/api/service-imports/${full.token}`, { method: "POST", json: {} });
  expect(refusedFull.status).toBe(409);
  expect(((await refusedFull.json()) as { error: string }).error).toContain("256 services");
  expect((JSON.parse(await readFile(registry, "utf8")) as { services: string[] }).services).toHaveLength(256);
  await writeFile(registry, original);

  await writeService("web", "broken.localhost", { domain: "broken.localhost", name: "Broken", description: "Broken fixture.", baseUrl: `http://broken.localhost:${port}/`, actions: [] },
    "window.ox.install(() => { throw new Error('mid-edit'); });\n");
  expect((await api("/api/services/broken.localhost")).status).toBe(200);
  expect((await api("/api/services/broken.localhost/website-data", { method: "DELETE" })).status).toBe(200);

  const deleted = await api("/api/services/new.localhost", { method: "DELETE" });
  expect(deleted.status).toBe(200);
  expect(await deleted.json()).toEqual({ domain: "new.localhost", kind: "web", deleted: true });
  expect((await api("/api/services/new.localhost")).status).toBe(404);
  expect((await api("/api/services/en.wikipedia.org", { method: "DELETE" })).status).toBe(400);
}, 120_000);

test("HTML pages list, inspect and validate services through their own session, within the phone's limits", async () => {
  const id = await conversation();
  const page = `conversations/${id}/panel.html`;
  const put = (path: string, body: string) => api(`/api/files/content?path=${encodeURIComponent(path)}&overwrite=1`, { method: "PUT", body });
  expect((await put(page, "<p>Panel</p>")).status).toBe(201);
  expect((await put(`conversations/${id}/notes.md`, "# Notes")).status).toBe(201);
  type Outcome = { ok: boolean; value?: unknown; error?: { code: string; message: string; recovery: string } };
  const as = (bearer?: string) => bearer ? { headers: { authorization: `Bearer ${bearer}` } } : {};
  const send = (session: string, name: string, args: unknown, extra: { path?: string; bearer?: string } = {}) =>
    api("/api/canvas/call", { method: "POST", json: { session, path: extra.path ?? page, function: name, arguments: args }, ...as(extra.bearer) });
  const outcome = async (response: Response) => {
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/x-ndjson; charset=utf-8");
    return JSON.parse((await response.text()).trim().split("\n").at(-1)!) as Outcome;
  };
  const call = async (session: string, name: string, args: unknown, extra: { path?: string; bearer?: string } = {}) => outcome(await send(session, name, args, extra));
  const close = async (session: string, bearer?: string) => ((await (await api("/api/canvas/close", { method: "POST", json: { session }, ...as(bearer) })).json()) as { closed: boolean }).closed;
  const other = /OX_HOST_TOKEN=(\S+)/.exec(await hostCommand("token", "--name", "pages-other"))![1]!;

  const frame = await (await api(`/api/files/frame?path=${encodeURIComponent(page)}`)).text();
  expect(frame).toContain(`Object.defineProperty(window,"ox"`);
  for (const name of ["list", "inspect", "validate", "invoke", "create", "update", "delete", "showPage"]) expect(frame).toContain(`"ox.service.${name}":{`);
  for (const name of ["attach", "detach", "listAttached", "signIn", "checkAccess"]) expect(frame).not.toContain(`"ox.service.${name}"`);
  expect(await (await api(`/api/files/page?path=${encodeURIComponent(page)}`)).text()).not.toContain("ox-call");

  expect((await run(id, `return await ox.service.attach({ purpose: "Attach", domain: "app.localhost" });`)).value).toMatchObject({ domain: "app.localhost", attached: true });
  const session = crypto.randomUUID();
  const listed = await call(session, "ox.service.list", { purpose: "Show services" });
  expect(listed.ok).toBe(true);
  conforms("ox.service.list", listed.value);
  const entries = listed.value as { domain: string; attached: boolean }[];
  expect(entries.find(entry => entry.domain === "app.localhost")).toMatchObject({ attached: false });
  expect(entries.every(entry => entry.attached === false)).toBe(true);
  const inspected = await call(session, "ox.service.inspect", { purpose: "Show actions", domain: "evolve.localhost" });
  expect(inspected.ok).toBe(true);
  conforms("ox.service.inspect", inspected.value);
  expect(await call(session, "ox.service.validate", { purpose: "Check", domain: "app.localhost" })).toEqual({ ok: true, value: { domain: "app.localhost", valid: true } });
  expect((await call(session, "ox.service.attach", { purpose: "Attach", domain: "app.localhost" })).error).toMatchObject({ code: "not_supported", message: "ox.service.attach isn't available to pages" });
  expect((await call(session, "ox.service.list", {})).error?.code).toBe("invalid_argument");
  expect((await call(session, "ox.service.list", { purpose: "x".repeat(1024 * 1024) })).error?.code).toBe("too_large");

  type Asked = { interaction: { id: string; kind: string; title: string; body: string; options: string[] } };
  const answer = (session: string, interaction: string, reply: { answer: string } | { cancel: true }, bearer?: string) =>
    api("/api/canvas/answer", { method: "POST", json: { session, interaction, ...reply }, ...as(bearer) });
  expect((await api("/api/permissions", { method: "PUT", json: { scope: "default", policy: "ask" } })).status).toBe(200);
  const asked = await call(session, "ox.service.list", { purpose: "Show services" }) as unknown as Asked;
  expect(asked.interaction).toMatchObject({ kind: "approval", body: "Show services", options: ["Approve", "Always approve", "Deny"] });
  expect((await answer(session, crypto.randomUUID(), { answer: "Approve" })).status).toBe(409);
  expect((await answer(session, asked.interaction.id, { answer: "Maybe" })).status).toBe(400);
  expect((await answer(session, asked.interaction.id, { answer: "Approve" }, other)).status).toBe(409);
  expect((await outcome(await answer(session, asked.interaction.id, { answer: "Deny" }))).error?.code).toBe("permission_denied");
  expect((await answer(session, asked.interaction.id, { answer: "Approve" })).status).toBe(409);
  const again = await call(session, "ox.service.list", { purpose: "Show services" }) as unknown as Asked;
  expect(await outcome(await answer(session, again.interaction.id, { cancel: true }))).toMatchObject({ ok: false, error: { code: "cancelled" } });
  const third = await call(session, "ox.service.list", { purpose: "Show services" }) as unknown as Asked;
  const approved = await outcome(await answer(session, third.interaction.id, { answer: "Approve" }));
  expect(approved.ok).toBe(true);
  conforms("ox.service.list", approved.value);
  const always = await call(session, "ox.service.validate", { purpose: "Check", domain: "app.localhost" }) as unknown as Asked;
  expect(await outcome(await answer(session, always.interaction.id, { answer: "Always approve" }))).toEqual({ ok: true, value: { domain: "app.localhost", valid: true } });
  expect(await call(session, "ox.service.validate", { purpose: "Check again", domain: "app.localhost" })).toEqual({ ok: true, value: { domain: "app.localhost", valid: true } });
  const abandoned = crypto.randomUUID();
  const waiting = await call(abandoned, "ox.service.list", { purpose: "Show services" }) as unknown as Asked;
  expect(await close(abandoned)).toBe(true);
  expect((await answer(abandoned, waiting.interaction.id, { answer: "Approve" })).status).toBe(409);
  expect((await api("/api/approvals", { method: "DELETE" })).status).toBe(200);
  expect((await api("/api/permissions", { method: "PUT", json: { scope: "default", policy: "block" } })).status).toBe(200);
  expect((await call(session, "ox.service.list", { purpose: "Block" })).error?.code).toBe("permission_denied");
  expect((await api("/api/permissions", { method: "PUT", json: { scope: "default", policy: null } })).status).toBe(200);

  expect((await send(session, "ox.service.list", { purpose: "Borrow" }, { bearer: other })).status).toBe(409);
  expect((await send(session, "ox.service.list", { purpose: "Move" }, { path: `conversations/${id}/other.html` })).status).toBe(409);
  expect((await send("short", "ox.service.list", { purpose: "Session" })).status).toBe(400);
  expect((await send(crypto.randomUUID(), "ox.service.list", { purpose: "Escape" }, { path: `conversations/${id}/../${id}/panel.html` })).status).toBe(400);
  expect((await send(crypto.randomUUID(), "ox.service.list", { purpose: "Markdown" }, { path: `conversations/${id}/notes.md` })).status).toBe(415);
  expect(await close(session, other)).toBe(false);
  expect(await close(session)).toBe(true);
  expect(await close(session)).toBe(false);
  expect((await send(session, "ox.service.list", { purpose: "After close" })).status).toBe(410);
  const early = crypto.randomUUID();
  expect(await close(early)).toBe(false);
  expect((await send(early, "ox.service.list", { purpose: "Closed first" })).status).toBe(410);
  const theirs = crypto.randomUUID();
  expect(await close(theirs, other)).toBe(false);
  expect((await call(theirs, "ox.service.list", { purpose: "Still mine" })).ok).toBe(true);
  expect(await close(theirs)).toBe(true);

  const counted = crypto.randomUUID(), missing = { path: `conversations/${id}/gone.html` };
  for (let index = 0; index < 120; index++) expect((await call(counted, "ox.service.list", { purpose: "Count" }, missing)).error?.code).toBe("not_found");
  expect((await call(counted, "ox.service.list", { purpose: "One more" }, missing)).error?.code).toBe("rate_limited");

  const crowd = Array.from({ length: 63 }, () => crypto.randomUUID());
  for (const member of crowd) expect((await call(member, "ox.service.list", { purpose: "Crowd" }, missing)).error?.code).toBe("not_found");
  expect((await call(crypto.randomUUID(), "ox.service.list", { purpose: "Sixty-fifth" }, missing)).error?.code).toBe("not_found");
  expect(await close(counted)).toBe(false);
  expect(await close(crowd[0]!)).toBe(true);

  const endpoint = `http://127.0.0.1:${mcp.port}/mcp/pages`;
  expect((await run(id, `return await ox.service.create({ purpose: "Connect MCP", kind: "mcp", endpoint: ${JSON.stringify(endpoint)} });`)).value).toMatchObject({ domain: "127.0.0.1" });
  let release!: () => void;
  toolsGate = new Promise(resolve => { release = resolve; });
  const before = toolsListed, held = crypto.randomUUID();
  const slow = send(held, "ox.service.inspect", { purpose: "Inspect MCP", domain: "127.0.0.1" });
  while (toolsListed === before) await Bun.sleep(20);
  const queued: Response[] = [];
  for (let index = 0; index < 15; index++) queued.push(await send(held, "ox.service.list", { purpose: "Queued" }));
  expect((await call(held, "ox.service.list", { purpose: "Seventeenth" })).error?.code).toBe("rate_limited");
  const first = outcome(queued[0]!);
  expect(await Promise.race([first.then(() => "done"), Bun.sleep(300).then(() => "waiting")])).toBe("waiting");
  expect(await close(held)).toBe(true);
  expect((await outcome(await slow)).error?.code).toBe("cancelled");
  expect((await first).error?.code).toBe("cancelled");
  for (const response of queued.slice(1)) expect((await outcome(response)).error?.code).toBe("cancelled");
  release();
  toolsGate = undefined;
  const removed = await run(id, `return await ox.service.delete({ purpose: "Remove MCP", domain: "127.0.0.1" });`, () => ({ answer: "Approve" }));
  expect(removed.value).toMatchObject({ domain: "127.0.0.1", deleted: true });
}, 90_000);

test("HTML pages invoke, create, update and delete services, with approvals answered beneath the page", async () => {
  const page = "pages/tools.html", session = crypto.randomUUID();
  const put = (path: string, body: BodyInit) => api(`/api/files/content?path=${encodeURIComponent(path)}&overwrite=1`, { method: "PUT", body });
  expect((await put(page, "<p>Tools</p>")).status).toBe(201);
  expect((await put("pages/data.bin", "12345")).status).toBe(201);
  type Outcome = { ok?: boolean; value?: unknown; error?: { code: string; message: string }; interaction?: { id: string; kind: string; title: string; body: string; detail?: string } };
  const read = async (response: Response) => { expect(response.status).toBe(200); return JSON.parse((await response.text()).trim().split("\n").at(-1)!) as Outcome; };
  const call = async (name: string, args: unknown) => read(await api("/api/canvas/call", { method: "POST", json: { session, path: page, function: name, arguments: args } }));
  const approve = async (asked: Outcome) => {
    expect(asked.interaction?.kind).toBe("approval");
    return read(await api("/api/canvas/answer", { method: "POST", json: { session, interaction: asked.interaction!.id, answer: "Approve" } }));
  };

  expect(await call("ox.service.invoke", { purpose: "Greet", name: "web:app.localhost:greet", input: { name: "Ada" } })).toEqual({ ok: true, value: { greeting: "Hello Ada" } });
  expect((await call("ox.service.invoke", { purpose: "Greet", name: "greet", input: { name: "Ada" } })).error?.code).toBe("invalid_argument");
  expect((await call("ox.service.invoke", { purpose: "Greet", name: "api:app.localhost:greet", input: { name: "Ada" } })).error?.code).toBe("unknown_action");
  expect((await call("ox.service.invoke", { purpose: "Greet", name: "web:missing.localhost:greet", input: {} })).error?.code).toBe("not_found");
  expect((await call("ox.service.invoke", { purpose: "Greet", name: "ftp:app.localhost:greet", input: { name: "Ada" } })).error?.code).toBe("invalid_argument");

  const order = await call("ox.service.invoke", { purpose: "Order", name: "web:app.localhost:placeOrder", input: { item: "tea" } });
  expect(order.interaction).toMatchObject({ title: "App Fixture - placeOrder", body: "Order" });
  expect(JSON.parse(order.interaction!.detail!)).toEqual({ item: "tea" });
  const placed = orders.length;
  expect(await approve(order)).toEqual({ ok: true, value: { orderId: `order-${placed + 1}` } });
  expect(orders.at(-1)).toBe("tea");

  const chats = async () => (await getJSON<{ pages: { owner: string; conversationId: number | null }[] }>("/api/pages")).pages
    .filter(entry => entry.owner.startsWith("service:chat.localhost:conversation:") && (entry.conversationId ?? 0) < 0);
  const chat = (attachments: unknown[]) => call("ox.service.invoke", { purpose: "Chat", name: "web:chat.localhost:conversation", input: { operation: "submit", conversationRef: null, accountId: null,
    modelId: "fixture", messages: [{ role: "user", text: "hello" }], attachments, options: { temperature: null, maxTokens: null } } });
  expect((await chat([{ id: 0, name: "data.bin", mimeType: "application/octet-stream" }])).error).toMatchObject({ code: "not_supported", message: "Pages can't send files to websites" });
  expect(await chats()).toHaveLength(0);
  const submitted = await chat([]);
  expect(submitted).toMatchObject({ ok: true, value: { operation: "submit", submission: "confirmed" } });
  expect(await chats()).toHaveLength(1);

  const endpoint = `http://127.0.0.1:${mcp.port}/mcp/tools`;
  const created = await call("ox.service.create", { purpose: "Connect", kind: "mcp", endpoint });
  expect(created).toMatchObject({ ok: true, value: { domain: "127.0.0.1", kind: "mcp", endpoint } });
  conforms("ox.service.create", created.value);
  let release!: () => void;
  toolsGate = new Promise(resolve => { release = resolve; });
  const listedBefore = toolsListed, dropped = new AbortController();
  const lost = api("/api/canvas/call", { method: "POST", signal: dropped.signal, json: { session, path: page, function: "ox.service.invoke",
    arguments: { purpose: "Add", name: "mcp:127.0.0.1:add", input: { a: 1, b: 1 } } } });
  await (await lost).body!.getReader().read();
  while (toolsListed === listedBefore) await Bun.sleep(20);
  dropped.abort();
  await Bun.sleep(200);
  release();
  toolsGate = undefined;
  const after = await Promise.race([call("ox.service.list", { purpose: "After a lost call" }), Bun.sleep(5_000).then(() => undefined)]);
  expect(after?.ok).toBe(true);
  expect(await approve(await call("ox.service.invoke", { purpose: "Add", name: "mcp:127.0.0.1:add", input: { a: 2, b: 5 } }))).toEqual({ ok: true, value: { sum: 7 } });
  for (const path of ["data.bin", "/pages/data.bin", "/MEMORY.md"]) {
    expect((await approve(await call("ox.service.invoke", { purpose: "Measure", name: "mcp:127.0.0.1:measure", input: { file: { path } } }))).error)
      .toMatchObject({ code: "not_supported", message: "Pages can't send files to services" });
  }
  expect(await approve(await call("ox.service.invoke", { purpose: "Chart", name: "mcp:127.0.0.1:chart", input: {} })))
    .toEqual({ ok: true, value: [{ type: "image", filename: "FileItem.png", mimeType: "image/png", bytes: chartPNG.length }] });
  expect((await api(`/api/files/content?path=${encodeURIComponent("pages/FileItem.png")}`)).status).toBe(404);
  expect((await getJSON<{ entries: { name: string }[] }>("/api/files?path=conversations")).entries.filter(entry => entry.name.startsWith("-"))).toEqual([]);
  expect(await call("ox.service.update", { purpose: "Rename", domain: "127.0.0.1", name: "Page tools" })).toMatchObject({ ok: true, value: { domain: "127.0.0.1", name: "Page tools" } });
  expect(await approve(await call("ox.service.delete", { purpose: "Remove", domain: "127.0.0.1" }))).toEqual({ ok: true, value: { domain: "127.0.0.1", kind: "mcp", deleted: true } });

  expect(await (await api("/api/canvas/close", { method: "POST", json: { session } })).json()).toEqual({ closed: true });
  for (let attempt = 0; attempt < 50 && (await chats()).length; attempt++) await Bun.sleep(100);
  expect(await chats()).toHaveLength(0);
}, 90_000);

test("HTML pages show live pages and hand website login and API setup to the user beneath the page", async () => {
  const page = "pages/live.html", session = crypto.randomUUID();
  expect((await api(`/api/files/content?path=${encodeURIComponent(page)}&overwrite=1`, { method: "PUT", body: "<p>Live</p>" })).status).toBe(201);
  type Outcome = { ok?: boolean; value?: unknown; page?: { id: string; title: string; url: string }; error?: { code: string; message: string };
    interaction?: { id: string; kind: string; title: string; body: string; page?: string; done?: string; options: string[]; fields?: { name: string; secret?: boolean }[]; submit?: string } };
  const read = async (response: Response) => { expect(response.status).toBe(200); return JSON.parse((await response.text()).trim().split("\n").at(-1)!) as Outcome; };
  const call = async (name: string, args: unknown) => read(await api("/api/canvas/call", { method: "POST", json: { session, path: page, function: name, arguments: args } }));
  const answer = (interaction: string, reply: Record<string, unknown>) => api("/api/canvas/answer", { method: "POST", json: { session, interaction, ...reply } });
  const live = async (id: string) => ((await getJSON<{ page: { url: string } }>(`/api/pages/${encodeURIComponent(id)}`)).page.url);

  expect(await call("ox.service.invoke", { purpose: "Greet", name: "web:app.localhost:greet", input: { name: "Grace" } })).toEqual({ ok: true, value: { greeting: "Hello Grace" } });
  const shown = await call("ox.service.showPage", { purpose: "Show", name: "web:app.localhost:greet", input: { name: "Grace" } });
  expect(shown).toMatchObject({ ok: true, value: { shown: true } });
  expect(await live(shown.page!.id)).toStartWith(`http://app.localhost:${port}/`);
  expect((await call("ox.service.showPage", { purpose: "Show", name: "web:app.localhost:greet", input: { name: "Nobody" } })).error?.code).toBe("page_unavailable");

  const login = await call("ox.service.invoke", { purpose: "Log in", name: "web:auth.localhost:login", input: {} });
  expect(login.interaction).toMatchObject({ kind: "page", title: "Auth Fixture - Log in", done: "Done", login: true, options: ["Done"] });
  expect(await live(login.interaction!.page!)).toStartWith(`http://auth.localhost:${port}/`);
  expect((await answer(login.interaction!.id, { answer: "Approve" })).status).toBe(400);
  expect((await answer(login.interaction!.id, { values: { token: "x" } })).status).toBe(400);
  const formless = await answer(login.interaction!.id, { values: {} });
  expect(formless.status).toBe(400);
  expect(await formless.json()).toEqual({ error: "This request does not take form values" });
  expect((await read(await answer(login.interaction!.id, { cancel: true }))).ok).toBe(false);
  const again = await call("ox.service.invoke", { purpose: "Log in", name: "web:auth.localhost:login", input: {} });
  expect(await read(await answer(again.interaction!.id, { answer: "Done" }))).toEqual({ ok: true, value: null });
  expect(await call("ox.service.invoke", { purpose: "Sessions", name: "web:auth.localhost:listSessions", input: {} })).toMatchObject({ ok: true, value: [{ id: "ada", label: "Ada" }] });

  await writeService("api", "pages-api", { kind: "api", domain: "pages-api", name: "Pages API", description: "Fixture HTTP API for pages.", baseUrl: "https://api.example.com/v1/",
    auth: { type: "http", scheme: "bearer" }, actions: [action("echo", object({ text: { type: "string" } }), object({ echoed: { type: "string" } }))] },
    `window.ox.install(({ action }) => action("echo", { async invoke({ text }) { return { echoed: text }; } }));\n`);
  const setup = await call("ox.service.invoke", { purpose: "Set up", name: "api:pages-api:configureCredentials", input: {} });
  expect(setup.interaction).toMatchObject({ kind: "form", title: "Pages API - Set up access", submit: "Save", fields: [{ name: "token", secret: true }], options: [] });
  expect((await answer(setup.interaction!.id, { values: { password: "x" } })).status).toBe(400);
  expect((await answer(setup.interaction!.id, { values: { token: 7 } })).status).toBe(400);
  expect((await answer(setup.interaction!.id, { values: { token: "x".repeat(16_385) } })).status).toBe(400);
  expect((await answer(setup.interaction!.id, { values: { token: "   " } })).status).toBe(400);
  expect((await answer(setup.interaction!.id, { answer: "Save" })).status).toBe(400);
  const saved = await answer(setup.interaction!.id, { values: { token: "page-secret" } });
  const savedText = await saved.text();
  expect(JSON.parse(savedText.trim().split("\n").at(-1)!)).toEqual({ ok: true, value: { completed: true, completion: "configured", state: "configured" } });
  expect(savedText).not.toContain("page-secret");
  expect(await call("ox.service.invoke", { purpose: "Status", name: "api:pages-api:credentialStatus", input: {} })).toEqual({ ok: true, value: { state: "configured" } });
  expect(await (await api("/api/canvas/close", { method: "POST", json: { session } })).json()).toEqual({ closed: true });
}, 90_000);

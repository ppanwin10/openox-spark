import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
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
const ustaVisits: string[] = [];
const greetCookies: string[] = [];
let sessionCookie = 0;
let headerRequests = 0;
const html = (title: string) => new Response(`<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1></body></html>`, { headers: { "content-type": "text/html" } });
const searchItems: Record<string, { title: string; url: string | null; snippet: string | null }[]> = {
  "a.localhost": [{ title: "Shared result", url: "https://example.org/shared?utm_source=a", snippet: "from A" }, { title: "Only A", url: "https://example.org/a", snippet: "A" }],
  "b.localhost": [{ title: "Only B", url: "https://example.org/b", snippet: "B" }, { title: "Shared result again", url: "https://example.org/shared", snippet: "from B" }],
};
function fixtureSite() {
  return Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url);
    const host = (request.headers.get("host") ?? "").split(":")[0]!;
    if (host === "account.usta.localhost") {
      ustaVisits.push(url.pathname);
      return new Response('<!doctype html><title>USTA sign-in fixture</title><h1>Sign in</h1><input type="email"><input type="password">',
        { headers: { "content-type": "text/html" } });
    }
    if (host === "www.usta.localhost") {
      ustaVisits.push(url.pathname);
      if (url.pathname === "/en/login.html") return html("Broken legacy login");
      return new Response(`<!doctype html><title>USTA header fixture</title><h1>Home</h1>
        <button class="v-authentication-button" onclick="location.assign('/joined')">Join</button>
        <button class="v-authentication-button" style="display:none" onclick="location.assign('/wrong')">Sign in</button>
        <button id="signin" class="v-authentication-button" disabled> Sign  In </button>
        <script>setTimeout(() => { signin.onclick = () => location.assign('http://account.usta.localhost:${port}/u/login'); signin.disabled = false; }, 100);</script>`,
      { headers: { "content-type": "text/html" } });
    }
    if (host === "app.localhost") {
      if (url.pathname === "/v1/headers") {
        headerRequests++;
        return Response.json({ accepted: request.headers.get("x-fixture"), authorized: request.headers.has("authorization") });
      }
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
let connectorOrigins: string[] = [];

async function startHost(personalAgent = false, museParity = false) {
  const origins = [...["app", "a", "b", "auth", "broken", "chat", "evolve", "www.usta", "account.usta"].map(name => `http://${name}.localhost:${site.port}`),
    `http://127.0.0.1:${mcp.port}`, ...connectorOrigins].join(",");
  const child = Bun.spawn([process.execPath, `${ROOT}/apps/linux/src/main.ts`, "serve", "--data", data, "--port", "0", "--name", "fixture"],
    { stdout: "pipe", stderr: "pipe", env: { ...Bun.env, OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "",
      OPENOX_PERSONAL_AGENT: personalAgent ? "1" : "", OPENOX_MUSE_PARITY: museParity ? "1" : "", OX_HOST_TEST_ORIGINS: origins } });
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
async function secretLogs() {
  const child = Bun.spawn([process.execPath, `${ROOT}/apps/cli/src/ox.ts`, "--host", `ws://127.0.0.1:${host!.port}`, "host", "logs", "--all", "--json"],
    { stdout: "pipe", stderr: "pipe", env: { ...Bun.env, OX_HOST_TOKEN: token, OX_REPOSITORY: "" } });
  const [code, text] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  expect(code).toBe(0);
  const rows = JSON.parse(text) as { category: string; message: string }[];
  expect(Array.isArray(rows) && rows.length > 0).toBe(true);
  return rows;
}

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

function connectorOAuthFixture() {
  const state = { registrations: [] as any[], authorizations: [] as URLSearchParams[], exchanges: 0, refreshes: 0, revocations: 0, dispatches: 0, apiReads: 0,
    metadata: "valid", tokenFailure: false, revocationFailure: false, noAuth: false, expire: false, tokenHeld: false, tokenWaiting: [] as (() => void)[],
    apiToken: "CNAPI-private-token", accessToken: "CNOAUTH-private-access", refreshToken: "CNOAUTH-private-refresh",
    largeInitialize: false, echoTransport: false, echoTool: false };
  const codes = new Map<string, URLSearchParams>();
  let origin = "";
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/.well-known/oauth-protected-resource/mcp" || url.pathname === "/.well-known/oauth-protected-resource") {
      return Response.json({ resource: state.metadata === "resource" ? `${origin}/foreign` : `${origin}/mcp`, authorization_servers: [origin], scopes_supported: ["read:fixture"] });
    }
    if (url.pathname === "/.well-known/oauth-authorization-server" || url.pathname === "/.well-known/openid-configuration") {
      return Response.json({ issuer: state.metadata === "issuer" ? `${origin}/foreign` : origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`,
        ...(state.metadata === "registration" ? {} : { registration_endpoint: `${origin}/register` }), revocation_endpoint: `${origin}/revoke`,
        response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: state.metadata === "pkce" ? ["plain"] : ["S256"], token_endpoint_auth_methods_supported: ["none"],
        authorization_response_iss_parameter_supported: true });
    }
    if (url.pathname === "/register" && request.method === "POST") {
      const body = await request.json() as any;
      state.registrations.push(body);
      if (body.client_name !== "OpenOx" || body.token_endpoint_auth_method !== "none" || body.redirect_uris.length !== 1) return Response.json({ error: "invalid_client_metadata" }, { status: 400 });
      return Response.json({ ...body, client_id: `openox-fixture-${state.registrations.length}`, client_id_issued_at: Math.floor(Date.now() / 1000) }, { status: 201 });
    }
    if (url.pathname === "/authorize" && request.method === "GET") {
      const params = url.searchParams;
      state.authorizations.push(new URLSearchParams(params));
      return new Response(`<html><title>Controlled OpenOx consent</title><form action="/approve" method="post">
        <p>OpenOx requests read:fixture for the controlled server.</p>${[...params].map(([name, value]) => `<input type="hidden" name="${name}" value="${value.replaceAll('"', "&quot;")}">`).join("")}
        <button>Approve fixture</button></form></html>`, { headers: { "content-type": "text/html" } });
    }
    if (url.pathname === "/approve" && request.method === "POST") {
      const params = new URLSearchParams(await request.text()), code = `CNOAUTH-private-code-${crypto.randomUUID()}`;
      codes.set(code, params);
      const redirect = new URL(params.get("redirect_uri")!);
      redirect.searchParams.set("state", params.get("state")!); redirect.searchParams.set("code", code); redirect.searchParams.set("iss", origin);
      return Response.redirect(redirect, 303);
    }
    if (url.pathname === "/token" && request.method === "POST") {
      const params = new URLSearchParams(await request.text());
      if (params.get("grant_type") === "refresh_token") {
        state.refreshes++;
        if (params.get("refresh_token") !== state.refreshToken || params.get("resource") !== `${origin}/mcp`) return Response.json({ error: "invalid_grant" }, { status: 400 });
        state.refreshToken = `CNOAUTH-private-refresh-${state.refreshes}`;
      } else {
        state.exchanges++;
        const authorization = codes.get(params.get("code")!); codes.delete(params.get("code")!);
        const challenge = new Bun.CryptoHasher("sha256").update(params.get("code_verifier") ?? "").digest("base64url");
        if (!authorization || challenge !== authorization.get("code_challenge") || authorization.get("code_challenge_method") !== "S256"
          || params.get("redirect_uri") !== authorization.get("redirect_uri") || params.get("client_id") !== authorization.get("client_id")
          || params.get("resource") !== `${origin}/mcp`) return Response.json({ error: "invalid_grant" }, { status: 400 });
      }
      if (state.tokenHeld) await new Promise<void>(resolve => state.tokenWaiting.push(resolve));
      if (state.tokenFailure) return Response.json({ error: "invalid_grant", error_description: "CNOAUTH-private-server-error" }, { status: 400 });
      return Response.json({ token_type: "Bearer", access_token: state.accessToken, refresh_token: state.refreshToken, scope: "read:fixture", expires_in: state.expire ? 1 : 3600 });
    }
    if (url.pathname === "/revoke") {
      state.revocations++;
      return new Response(null, { status: state.revocationFailure ? 503 : 200 });
    }
    if (url.pathname === "/api/status") {
      state.apiReads++;
      return request.headers.get("authorization") === `Bearer ${state.apiToken}` ? Response.json({ ok: true }) : Response.json({ error: "unauthorized" }, { status: 401 });
    }
    if (url.pathname === "/mcp") {
      if (!state.noAuth && request.headers.get("authorization") !== `Bearer ${state.accessToken}`) return new Response(null, { status: 401,
        headers: { "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp", scope="read:fixture"` } });
      if (state.echoTransport) return new Response(`MCP fixture transport error ${state.accessToken}`, { status: 500 });
      if (state.largeInitialize) {
        if (request.method !== "POST") return new Response(null, { status: 405 });
        const message = await request.json() as any;
        if (message.id === undefined) return new Response(null, { status: 202 });
        const body = new TextEncoder().encode(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: message.params.protocolVersion,
          capabilities: { tools: {} }, serverInfo: { name: "x".repeat(4 * 1024 * 1024 + 1), version: "1.0.0" } } }));
        let offset = 0;
        return new Response(new ReadableStream({ pull(controller) {
          if (offset === body.length) { controller.close(); return; }
          const end = Math.min(offset + 65_536, body.length); controller.enqueue(body.subarray(offset, end)); offset = end;
        } }), { headers: { "content-type": "application/json" } });
      }
      const service = new Server({ name: "connector-fixture", version: "1.0.0" }, { capabilities: { tools: {} } });
      service.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [{ name: "read", inputSchema: object({}), outputSchema: object({ ok: { type: "boolean" } }) }] }));
      service.setRequestHandler(CallToolRequestSchema, () => { state.dispatches++; return state.echoTool
        ? { isError: true, content: [{ type: "text", text: `MCP fixture echoed credential ${state.accessToken}` }] }
        : { content: [{ type: "text", text: "ok" }], structuredContent: { ok: true } }; });
      const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      await service.connect(transport);
      return transport.handleRequest(request);
    }
    return new Response("Not found", { status: 404 });
  } });
  origin = `http://127.0.0.1:${server.port}`;
  const grant = async (authorizationUrl: string) => {
    const opened = await fetch(authorizationUrl);
    expect(opened.status).toBe(200);
    const params = new URL(authorizationUrl).searchParams;
    const response = await fetch(`${origin}/approve`, { method: "POST", body: params, redirect: "manual" });
    expect(response.status).toBe(303);
    return new URL(response.headers.get("location")!);
  };
  return { origin, state, grant, close: () => { for (const release of state.tokenWaiting.splice(0)) release(); server.stop(true); } };
}

type ConnectorFixture = ReturnType<typeof connectorOAuthFixture>;
async function connectorsFixture(work: (fixture: ConnectorFixture) => Promise<void>) {
  if (host) { host.process.kill("SIGTERM"); await host.process.exited; host = undefined; }
  const previous = { data, local, token }, fixture = connectorOAuthFixture();
  data = await mkdtemp(join(tmpdir(), "openox-connectors-"));
  connectorOrigins = [fixture.origin];
  try {
    host = await startHost(true, true);
    expect((await fetch(`http://127.0.0.1:${host.port}/api/health`)).status).toBe(200);
    token = /OX_HOST_TOKEN=(\S+)/.exec(await hostCommand("token", "--name", "CN original owner"))![1]!;
    const profile = JSON.parse(await readFile(join(data, "host.json"), "utf8")).profile.id;
    local = join(data, "profiles", profile, "vm/repositories/local");
    await writeService("mcp", "cn-server", { id: "cn-server", name: "Controlled MCP", description: "Read the controlled business server.",
      endpoint: `${fixture.origin}/mcp`, transport: "streamable-http" });
    await writeService("api", "cn-api", { kind: "api", domain: "cn-api", name: "Controlled API", description: "Read a controlled productivity account.",
      baseUrl: `${fixture.origin}/api/`, auth: { type: "http", scheme: "bearer" },
      actions: [action("status", object({}), object({ ok: { type: "boolean" } }), { requireAuth: true })] },
    'window.ox.install(({action,request})=>action("status",{async invoke(){return await request({path:"status"})}}));\n');
    await writeService("web", "auth.localhost", { domain: "auth.localhost", name: "Controlled website", description: "Read a controlled productivity account.",
      baseUrl: `http://auth.localhost:${port}/`, actions: [
        action("listSessions", object({}), { type: "array", items: object({ id: { type: "string" }, label: { type: "string" }, url: { type: "string" } }) }),
        action("login", object({}), { type: "null" }), action("whoami", object({}), object({ user: { type: "string" }, path: { type: "string" } }), { requireAuth: true }),
      ] }, `window.ox.install(({action})=>{
        action("listSessions",{async invoke(){return document.cookie.includes("fixture_session=1")?[{id:"ada",label:"Controlled account",url:location.origin+"/account"}]:[]}});
        action("login",{async invoke(){document.cookie="fixture_session=1; path=/";return null}});
        action("whoami",{async invoke(_, {session}){return {user:session.label,path:location.pathname}}});
      });\n`);
    await work(fixture);
  } finally {
    if (host) { host.process.kill("SIGTERM"); await host.process.exited; host = undefined; }
    fixture.close(); await rm(data, { recursive: true, force: true });
    ({ data, local, token } = previous); connectorOrigins = [];
    host = await startHost();
  }
}
async function cnRead(response: Response, status = 200): Promise<any> {
  expect(response.status).toBe(status);
  return response.json();
}
const cnDetail = (domain: string) => api(`/api/connectors/${domain}`).then(response => cnRead(response));
const cnBody = (detail: any, requestId = crypto.randomUUID()) => ({ requestId, expectedRevision: detail.revision, repository: detail.repository,
  kind: detail.kind, definition: detail.definition, confirm: true });
async function cnSetup(domain: string) {
  const detail = await cnDetail(domain), body = cnBody(detail);
  return cnRead(await api(`/api/connectors/${domain}/setup`, { method: "POST", json: body }), 201);
}
async function cnAuthorize(fixture: ConnectorFixture) {
  const setup = await cnSetup("cn-server");
  expect(setup.state).toBe("oauthPreview");
  expect(setup.authorization).toMatchObject({ issuer: fixture.origin, resource: `${fixture.origin}/mcp`, scopes: ["read:fixture"], registration: "dynamic" });
  const waiting = await cnRead(await api(`/api/connectors/requests/${setup.requestId}/authorize`, { method: "POST", json: { confirm: true } }));
  expect(waiting.state).toBe("oauthWaiting");
  return { setup, waiting, callback: await fixture.grant(waiting.authorizationUrl) };
}
const cnCallback = (callback: URL, authorization = token) => fetch(callback, { redirect: "manual", headers: { authorization: `Bearer ${authorization}` } });
async function cnPageInvoke(name: string) {
  const path = "artifacts/cn-owner-page.html";
  if ((await api(`/api/files/content?path=${encodeURIComponent(path)}`)).status === 404) {
    expect((await api(`/api/files/content?path=${encodeURIComponent(path)}`, { method: "PUT", body: "<!doctype html><title>CN owner page</title>" })).status).toBe(201);
  }
  const session = crypto.randomUUID(), response = await api("/api/canvas/call", { method: "POST", json: { session, path, function: "ox.service.invoke",
    arguments: { purpose: "CN controlled original dispatcher", name, input: {} } } });
  expect(response.status).toBe(200);
  const result = JSON.parse((await response.text()).trim().split("\n").at(-1)!);
  await api("/api/canvas/close", { method: "POST", json: { session } });
  return result;
}

test("Muse Connectors CN-01 projects complete original discovery without confusing saved attached or configured with access", async () => connectorsFixture(async fixture => {
  const initial = await cnRead(await api("/api/connectors"));
  expect(initial).toMatchObject({ available: true, coverage: "complete" });
  expect(initial.connectors.length).toBeGreaterThan(70);
  expect(initial.categories.map((entry: any) => entry.id)).toEqual(["productivity", "social", "health", "business", "other"]);
  expect(initial.connectors.find((row: any) => row.domain === "calendar.google.com")).toMatchObject({ category: "productivity", featured: true, status: { connected: false } });
  expect(initial.connectors.find((row: any) => row.domain === "www.usta.com")).toMatchObject({ category: "health" });
  expect(initial.connectors.find((row: any) => row.domain === "mail.google.com")).toMatchObject({ category: "productivity" });
  expect(initial.connectors.find((row: any) => row.domain === "gemini.google.com")).toMatchObject({ category: "social" });
  expect(initial.connectors.find((row: any) => row.domain === "ctrip.com")).toMatchObject({ category: "other" });
  expect(initial.connectors.find((row: any) => row.domain === "ios:calendar")).toMatchObject({ available: false, status: { connected: false } });
  expect((await cnRead(await api("/api/connectors?q=USTA"))).connectors.map((row: any) => row.domain)).toContain("www.usta.com");
  expect((await cnRead(await api("/api/connectors?q=no-cn-match"))).connectors).toEqual([]);
  expect((await cnRead(await api("/api/connectors?tab=connected"))).connectors).toEqual([]);
  await api("/api/services/cn-api/saved", { method: "PUT", json: { saved: true } });
  expect((await api("/api/settings/providers/custom", { method: "PUT", json: { name: "CN attachment prerequisite", baseUrl: `http://127.0.0.1:${model.port}/v1`, models: ["fixture"] } })).status).toBe(200);
  const id = await conversation();
  expect((await api("/api/settings/providers/custom", { method: "DELETE" })).status).toBe(200);
  expect((await api("/api/services/cn-api/attach", { method: "POST", json: { conversation: id } })).status).toBe(200);
  expect((await cnDetail("cn-api")).status).toMatchObject({ state: "notConfigured", connected: false });
  await writeService("web", "broken.localhost", { domain: "broken.localhost", name: "Broken", baseUrl: "invalid", actions: [] }, "");
  const invalid = (await cnRead(await api("/api/connectors"))).connectors.find((row: any) => row.domain === "broken.localhost");
  expect(invalid).toMatchObject({ available: false, status: { state: "unavailable", connected: false } });
  for (const query of ["tab=unknown", "category=unknown", `q=${"a".repeat(201)}`, "unexpected=1"]) expect((await api(`/api/connectors?${query}`)).status).toBe(400);
  expect((await api("/api/connectors", { headers: { origin: "null" } })).status).toBe(403);
  expect((await fetch(`http://127.0.0.1:${host!.port}/api/connectors`)).status).toBe(401);
  expect((await getJSON<any>("/api/settings")).defaultModel).toBeNull();
  expect(fixture.state.registrations).toEqual([]); expect(fixture.state.exchanges + fixture.state.dispatches + fixture.state.apiReads).toBe(0);
}), 60_000);

test("Muse Connectors CN-02 configures original API and Browser owners with explicit verification selection and narrow disconnect", async () => connectorsFixture(async fixture => {
  const website = await savedPassword(), originalWebsite = JSON.parse(await readFile(secretsPath(), "utf8")).websiteRequests;
  const setup = await cnSetup("cn-api");
  expect(setup.state).toBe("credentials"); expect(setup.fields.map((field: any) => field.name)).toEqual(["token"]);
  const saved = await cnRead(await api(`/api/connectors/requests/${setup.requestId}/credentials`, { method: "POST", json: { confirm: true, fields: { token: fixture.state.apiToken } } }));
  expect(saved.state).toBe("completed");
  expect((await cnDetail("cn-api")).status).toMatchObject({ state: "configured", connected: false });
  expect(fixture.state.apiReads).toBe(0);
  const detail = await cnDetail("cn-api");
  expect(detail.setup.verificationActions).toContainEqual({ id: "status", label: "status" });
  const verified = await cnRead(await api("/api/connectors/cn-api/verify", { method: "POST", json: { ...cnBody(detail), actionId: "status" } }));
  expect(verified.connector.status).toMatchObject({ state: "verified", connected: true });
  expect(fixture.state.apiReads).toBe(1);
  const noReplay = await cnRead(await api(`/api/connectors/requests/${setup.requestId}/credentials`, { method: "POST", json: { confirm: true, fields: { token: "CN-never-applied" } } }));
  expect(noReplay.replayed).toBe(true); expect(fixture.state.apiReads).toBe(1);
  const web = await cnSetup("auth.localhost");
  expect(web.state).toBe("web"); expect(typeof web.page.id).toBe("string");
  const sessions = await cnRead(await api(`/api/connectors/requests/${web.requestId}/verify`, { method: "POST", json: { confirm: true } }));
  expect(sessions.state).toBe("chooseSession"); expect(sessions.sessions.map((session: any) => session.id)).toEqual(["ada"]);
  expect((await api(`/api/connectors/requests/${web.requestId}/session`, { method: "POST", json: { confirm: true, sessionId: "foreign" } })).status).toBe(409);
  const selected = await cnRead(await api(`/api/connectors/requests/${web.requestId}/session`, { method: "POST", json: { confirm: true, sessionId: "ada" } }));
  expect(selected.connector.status).toMatchObject({ state: "signedIn", connected: true });
  expect((await cnRead(await api("/api/connectors?tab=connected"))).connectors.map((row: any) => row.domain)).toEqual(expect.arrayContaining(["cn-api", "auth.localhost"]));
  const disconnect = await cnRead(await api("/api/connectors/cn-api/disconnect", { method: "POST", json: cnBody(await cnDetail("cn-api")) }));
  expect(disconnect).toMatchObject({ state: "completed", revocation: "notSupported", local: "disconnected" });
  expect((await cnDetail("cn-api")).status).toMatchObject({ state: "disconnected", connected: false });
  expect((await cnPageInvoke("api:cn-api:status")).error.code).toBe("permission_denied");
  expect(fixture.state.apiReads).toBe(1);
  const stored = JSON.parse(await readFile(secretsPath(), "utf8"));
  expect(stored.entries.find((entry: any) => entry.website?.id === website.input.id).value.password).toBe(website.input.password);
  expect(stored.websiteRequests).toEqual(originalWebsite);
  expect(stored.bindings.some((binding: any) => binding.consumerKind === "apiService")).toBe(false);
  const exposed = JSON.stringify({ saved, verified, disconnect, list: await cnRead(await api("/api/connectors")), logs: await secretLogs(), history: await getJSON("/api/approvals/history") });
  for (const marker of [fixture.state.apiToken, website.input.username, website.input.password, "CN-never-applied"]) expect(exposed).not.toContain(marker);
}), 60_000);

test("Muse Connectors CN-02 CN-03 runs genuine OpenOx DCR PKCE callback refresh and revocation without cross-owner dispatch", async () => connectorsFixture(async fixture => {
  fixture.state.expire = true;
  const { setup, waiting, callback } = await cnAuthorize(fixture);
  const registration = fixture.state.registrations[0];
  expect(registration).toMatchObject({ client_name: "OpenOx", token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"] });
  const params = new URL(waiting.authorizationUrl).searchParams;
  expect(params.get("code_challenge_method")).toBe("S256"); expect(params.get("resource")).toBe(`${fixture.origin}/mcp`);
  expect(params.get("state")!.length).toBeGreaterThanOrEqual(43); expect(params.get("nonce")!.length).toBeGreaterThanOrEqual(43);
  const other = /OX_HOST_TOKEN=(\S+)/.exec(await hostCommand("token", "--name", "CN other owner"))![1]!;
  expect((await api(`/api/connectors/requests/${setup.requestId}`, { headers: { authorization: `Bearer ${other}` } })).status).toBe(404);
  expect((await cnCallback(callback, other)).status).toBe(403); expect(fixture.state.exchanges).toBe(0);
  const wrongState = new URL(callback); wrongState.searchParams.set("state", "not-the-state");
  expect((await cnCallback(wrongState)).status).toBe(400);
  const wrongIssuer = new URL(callback); wrongIssuer.searchParams.set("iss", `${fixture.origin}/wrong`);
  expect((await cnCallback(wrongIssuer)).status).toBe(400); expect(fixture.state.exchanges).toBe(0);
  const accepted = await cnCallback(callback);
  expect(accepted.status).toBe(200);
  const html = await accepted.text();
  expect(html).toContain('history.replaceState(null,"","/oauth/mcp/result")');
  expect(html).not.toContain(callback.searchParams.get("code")!);
  expect(fixture.state.exchanges).toBe(1);
  expect((await cnCallback(callback)).status).toBe(400); expect(fixture.state.exchanges).toBe(1);
  const completed = await cnRead(await api(`/api/connectors/requests/${setup.requestId}`));
  expect(completed).toMatchObject({ state: "completed", connector: { status: { state: "authorized", connected: true } } });
  expect(completed.connector.actions.find((action: any) => action.id === "read")).toMatchObject({ requireApproval: true, policy: { policy: "ask" } });
  const stored = JSON.parse(await readFile(secretsPath(), "utf8")), binding = stored.bindings.find((binding: any) => binding.consumerKind === "mcpServer");
  expect(binding).toBeDefined(); expect(binding.destination).toBe(`${fixture.origin}/mcp`);
  expect(JSON.stringify(stored.entries.find((entry: any) => entry.key === binding.secretKey).value)).toContain(fixture.state.accessToken);
  expect((await stat(secretsPath())).mode & 0o777).toBe(0o600);
  await Bun.sleep(1150);
  expect((await cnDetail("cn-server")).status.connected).toBe(false); expect(fixture.state.refreshes).toBe(0);
  fixture.state.expire = false;
  const refreshed = await cnRead(await api("/api/connectors/cn-server/verify", { method: "POST", json: cnBody(await cnDetail("cn-server")) }));
  expect(refreshed.connector.status.state).toBe("authorized"); expect(fixture.state.refreshes).toBe(1);
  await cnRead(await api(`/api/connectors/requests/${refreshed.requestId}`)); expect(fixture.state.refreshes).toBe(1);
  await api("/api/permissions", { method: "PUT", json: { scope: "action", id: "mcp:cn-server:read", policy: "block" } });
  expect((await cnPageInvoke("mcp:cn-server:read")).error.code).toBe("permission_denied"); expect(fixture.state.dispatches).toBe(0);
  fixture.state.revocationFailure = true;
  const disconnected = await cnRead(await api("/api/connectors/cn-server/disconnect", { method: "POST", json: cnBody(await cnDetail("cn-server")) }));
  expect(disconnected).toMatchObject({ local: "disconnected", revocation: "failed" }); expect(fixture.state.revocations).toBe(1);
  expect((await cnPageInvoke("mcp:cn-server:read")).error.code).toBe("permission_denied"); expect(fixture.state.dispatches).toBe(0);
  expect(JSON.parse(await readFile(secretsPath(), "utf8")).bindings.some((binding: any) => binding.consumerKind === "mcpServer")).toBe(false);
  const exposed = JSON.stringify({ completed, refreshed, disconnected, list: await cnRead(await api("/api/connectors")), logs: await secretLogs(), history: await getJSON("/api/approvals/history") });
  for (const marker of [fixture.state.accessToken, fixture.state.refreshToken, callback.searchParams.get("code")!, params.get("state")!, "CNOAUTH-private-server-error"]) expect(exposed).not.toContain(marker);
}), 60_000);

test("Muse Connectors CN-03 fails closed for metadata token storage policies and unknown rotated refresh while keeping original owners", async () => connectorsFixture(async fixture => {
  for (const mode of ["issuer", "resource", "pkce", "registration"]) {
    fixture.state.metadata = mode;
    const response = await api("/api/connectors/cn-server/setup", { method: "POST", json: cnBody(await cnDetail("cn-server")) });
    expect(response.status).toBe(mode === "registration" ? 422 : 400);
    expect(fixture.state.registrations.length).toBe(0);
  }
  fixture.state.metadata = "valid";
  await api("/api/permissions", { method: "PUT", json: { scope: "source", id: "cn-server", policy: "block" } });
  expect((await api("/api/connectors/cn-server/setup", { method: "POST", json: cnBody(await cnDetail("cn-server")) })).status).toBe(403);
  expect(fixture.state.registrations.length).toBe(0);
  await api("/api/permissions", { method: "PUT", json: { scope: "source", id: "cn-server", policy: null } });
  const website = await savedPassword(), before = await readFile(secretsPath(), "utf8");
  const failed = await cnAuthorize(fixture);
  await chmod(join(secretsPath(), ".."), 0o500);
  try { expect((await cnCallback(failed.callback)).status).toBe(503); }
  finally { await chmod(join(secretsPath(), ".."), 0o700); }
  expect(await readFile(secretsPath(), "utf8")).toBe(before);
  expect((await cnRead(await api(`/api/connectors/requests/${failed.setup.requestId}`))).state).toBe("failed");
  expect((await cnCallback(failed.callback)).status).toBe(400); expect(fixture.state.exchanges).toBe(1);
  fixture.state.expire = true;
  const successful = await cnAuthorize(fixture); expect((await cnCallback(successful.callback)).status).toBe(200);
  await Bun.sleep(1150); fixture.state.tokenFailure = true;
  const refresh = await api("/api/connectors/cn-server/verify", { method: "POST", json: cnBody(await cnDetail("cn-server")) });
  expect(refresh.status).toBe(503); expect(fixture.state.refreshes).toBe(1);
  expect((await cnDetail("cn-server")).status).toMatchObject({ state: "unknown", connected: false });
  expect((await api("/api/connectors/cn-server/verify", { method: "POST", json: cnBody(await cnDetail("cn-server")) })).status).toBe(503);
  expect(fixture.state.refreshes).toBe(1);
  await chmod(secretsPath(), 0o000);
  try { expect((await api("/api/connectors/cn-api")).status).toBe(503); }
  finally { await chmod(secretsPath(), 0o600); }
  expect((await cnDetail("cn-api")).status.connected).toBe(false);
  const stored = JSON.parse(await readFile(secretsPath(), "utf8"));
  expect(stored.entries.find((entry: any) => entry.website?.id === website.input.id).value.password).toBe(website.input.password);
  const policy = join(secretsPath(), "..", "action-policies.json"), validPolicy = await readFile(policy, "utf8");
  await writeFile(policy, JSON.stringify({ format: 3, sources: {}, actions: {} }));
  expect((await api("/api/connectors/cn-api/setup", { method: "POST", json: cnBody(await cnDetail("cn-api")) })).status).toBe(503);
  expect(await readFile(policy, "utf8")).toContain('"format":3');
  await writeFile(policy, validPolicy);
}), 60_000);

test("Muse Connectors CN-03 retires exact peer and late OAuth flows through original Reset epochs and double gates", async () => connectorsFixture(async fixture => {
  const first = await cnSetup("cn-server"), other = /OX_HOST_TOKEN=(\S+)/.exec(await hostCommand("token", "--name", "CN second owner"))![1]!;
  expect((await api("/api/connectors/cn-server/setup", { method: "POST", json: cnBody(await cnDetail("cn-server")), headers: { authorization: `Bearer ${other}` } })).status).toBe(409);
  expect((await api(`/api/connectors/requests/${first.requestId}`, { method: "DELETE", headers: { authorization: `Bearer ${other}` } })).status).toBe(404);
  expect((await api("/api/data-controls/resets", { method: "POST", json: { requestId: crypto.randomUUID() } })).status).toBe(409);
  expect((await cnRead(await api(`/api/connectors/requests/${first.requestId}`, { method: "DELETE" }))).state).toBe("cancelled");
  const pending = await cnAuthorize(fixture); fixture.state.tokenHeld = true;
  const callback = cnCallback(pending.callback);
  for (let attempts = 0; fixture.state.exchanges === 0 && attempts < 100; attempts++) await Bun.sleep(10);
  expect(fixture.state.exchanges).toBe(1);
  await cnRead(await api(`/api/connectors/requests/${pending.setup.requestId}`, { method: "DELETE" }));
  for (const release of fixture.state.tokenWaiting.splice(0)) release();
  expect((await callback).status).not.toBe(200);
  expect(JSON.parse(await readFile(secretsPath(), "utf8").catch(() => '{"bindings":[]}')).bindings).toEqual([]);
  const prepared = await cnRead(await api("/api/data-controls/resets", { method: "POST", json: { requestId: crypto.randomUUID() } }), 201);
  const reset = await cnRead(await api(`/api/data-controls/resets/${prepared.requestId}/confirm`, { method: "POST", json: {
    confirmationId: prepared.confirmationId, inventory: prepared.inventory, profileId: prepared.profileId, epoch: prepared.epoch, confirm: true, phrase: "RESET",
  } }));
  expect(reset.phase).toBe("completed");
  expect((await api("/api/connectors/cn-api/setup", { method: "POST", json: cnBody(await cnDetail("cn-api")) })).status).toBe(409);
  const epoch = (await getJSON<any>("/api/settings")).contentEpoch;
  expect(epoch).toBeGreaterThan(0);
  const fresh = await cnRead(await api("/api/connectors/cn-api/setup", { method: "POST", json: cnBody(await cnDetail("cn-api")), headers: { "x-openox-content-epoch": String(epoch) } }), 201);
  await cnRead(await api(`/api/connectors/requests/${fresh.requestId}`, { method: "DELETE", headers: { "x-openox-content-epoch": String(epoch) } }));
  expect((await cnCallback(pending.callback)).status).toBe(400);
  for (const [personal, parity] of [[true, false], [false, true], [false, false]]) {
    await restartSecretsHost(personal, parity);
    expect((await api("/api/connectors")).status).toBe(404);
    expect((await getJSON<any>("/api/settings")).features?.connectors).not.toBe(true);
  }
}), 60_000);

test("Muse Connectors CN-02 binds the selected Browser account to the original dispatcher and verifies without replaying login", async () => connectorsFixture(async () => {
  await writeService("web", "auth.localhost", { domain: "auth.localhost", name: "Controlled multi-account website", description: "Read a controlled productivity account.",
    baseUrl: `http://auth.localhost:${port}/`, actions: [
      action("listSessions", object({}), { type: "array", items: object({ id: { type: "string" }, label: { type: "string" }, url: { type: "string" } }) }),
      action("login", object({}), { type: "null" }), action("whoami", object({}), object({ user: { type: "string" }, logins: { type: "integer" } }), { requireAuth: true }),
    ] }, `window.ox.install(({action})=>{
      const count=()=>Number((document.cookie.match(/cn_logins=(\\d+)/)||[])[1]||0);
      action("listSessions",{async invoke(){return count()?[{id:"ada",label:"First controlled account",url:location.origin+"/account"},
        {id:"grace",label:"Second controlled account",url:location.origin+"/grace"}]:[]}});
      action("login",{async invoke(){document.cookie="cn_logins="+(count()+1)+"; path=/";return null}});
      action("whoami",{async invoke(_, {session}){return {user:session.label,logins:count()}}});
    });\n`);
  const setup = await cnSetup("auth.localhost");
  const accounts = await cnRead(await api(`/api/connectors/requests/${setup.requestId}/verify`, { method: "POST", json: { confirm: true } }));
  expect(accounts.sessions.map((session: any) => session.id)).toEqual(["ada", "grace"]);
  await cnRead(await api(`/api/connectors/requests/${setup.requestId}/session`, { method: "POST", json: { confirm: true, sessionId: "grace" } }));
  const first = await cnPageInvoke("web:auth.localhost:whoami");
  expect(first).toMatchObject({ ok: true, value: { user: "Second controlled account", logins: 1 } });
  const verified = await cnRead(await api("/api/connectors/auth.localhost/verify", { method: "POST", json: cnBody(await cnDetail("auth.localhost")) }));
  expect(verified.connector.status).toMatchObject({ state: "signedIn", connected: true });
  expect((await cnPageInvoke("web:auth.localhost:whoami")).value).toEqual({ user: "Second controlled account", logins: 1 });
}), 60_000);

test("Muse Connectors CN-03 owns operation identities and refuses full original receipt storage before saving credentials", async () => connectorsFixture(async fixture => {
  const setup = await cnSetup("cn-api"), detail = await cnDetail("cn-api");
  expect((await api("/api/connectors/cn-api/disconnect", { method: "POST", json: cnBody(detail, setup.requestId) })).status).toBe(409);
  expect((await api("/api/connectors/cn-api/setup", { method: "POST", json: { ...cnBody(detail, setup.requestId), kind: "mcp" } })).status).toBe(409);
  await cnRead(await api(`/api/connectors/requests/${setup.requestId}`, { method: "DELETE" }));
  fixture.state.noAuth = true;
  const anonymous = await cnSetup("cn-server");
  expect(anonymous.connector.status).toMatchObject({ state: "notRequired", connected: true });
  expect(fixture.state.registrations).toEqual([]);
  await api("/api/services/cn-api/saved", { method: "PUT", json: { saved: true } });
  const file = join(secretsPath(), "..", "services.json"), valid = await readFile(file, "utf8"), stored = JSON.parse(valid);
  const owner = (await getJSON<any>("/api/session")).device.id, identity = "a".repeat(64);
  stored.connectorRequests = Array.from({ length: 5000 }, () => ({ requestId: crypto.randomUUID(), owner, identity, operation: "configure", expectedRevision: 0, revision: 1, local: "configured" }));
  await writeFile(file, JSON.stringify(stored)); await restartSecretsHost(true, true);
  const original = await readFile(secretsPath(), "utf8").catch(() => null);
  expect((await api("/api/connectors/cn-api/setup", { method: "POST", json: cnBody(await cnDetail("cn-api")) })).status).toBe(507);
  expect(await readFile(secretsPath(), "utf8").catch(() => null)).toBe(original);
  expect(fixture.state.apiReads).toBe(0);
  await writeFile(file, valid); await restartSecretsHost(true, true);
}), 60_000);

test("Muse Connectors CN-03 refuses duplicate original MCP bindings at normal relaunch without token or action replay", async () => connectorsFixture(async fixture => {
  const authorization = await cnAuthorize(fixture);
  expect((await cnCallback(authorization.callback)).status).toBe(200);
  const valid = await readFile(secretsPath(), "utf8"), stored = JSON.parse(valid);
  stored.bindings.push(structuredClone(stored.bindings.find((binding: any) => binding.consumerKind === "mcpServer")));
  await writeFile(secretsPath(), JSON.stringify(stored)); await restartSecretsHost(true, true);
  expect((await api("/api/connectors/cn-server")).status).toBe(503);
  expect(fixture.state.exchanges).toBe(1); expect(fixture.state.refreshes + fixture.state.dispatches).toBe(0);
  expect(await readFile(secretsPath(), "utf8")).toBe(JSON.stringify(stored));
  await writeFile(secretsPath(), valid); await restartSecretsHost(true, true);
  expect((await cnDetail("cn-server")).status.connected).toBe(false);
}), 60_000);

test("Muse Connectors CN-03 refuses a stale private API form after an original Secret peer edit", async () => connectorsFixture(async fixture => {
  const initial = await cnSetup("cn-api");
  await cnRead(await api(`/api/connectors/requests/${initial.requestId}/credentials`, { method: "POST", json: { confirm: true, fields: { token: fixture.state.apiToken } } }));
  const pending = await cnSetup("cn-api"), stored = JSON.parse(await readFile(secretsPath(), "utf8"));
  const binding = stored.bindings.find((binding: any) => binding.consumerKind === "apiService");
  const peer = /OX_HOST_TOKEN=(\S+)/.exec(await hostCommand("token", "--name", "CN Secret peer"))![1]!;
  expect((await api(`/api/secrets/${binding.secretKey}`, { method: "PUT", headers: { authorization: `Bearer ${peer}` }, json: { fields: { token: "CN-peer-secret-choice" } } })).status).toBe(200);
  const response = await api(`/api/connectors/requests/${pending.requestId}/credentials`, { method: "POST", json: { confirm: true, fields: { token: "CN-stale-form-choice" } } });
  expect(response.status).toBe(409);
  expect(JSON.parse(await readFile(secretsPath(), "utf8")).entries.find((entry: any) => entry.key === binding.secretKey).value.token).toBe("CN-peer-secret-choice");
  expect(fixture.state.apiReads).toBe(0);
}), 60_000);

test("Muse Connectors CN-03 refuses actual oversized chunked MCP initialization without a Content-Length", async () => connectorsFixture(async fixture => {
  fixture.state.noAuth = true; fixture.state.largeInitialize = true;
  expect((await api("/api/connectors/cn-server/setup", { method: "POST", json: cnBody(await cnDetail("cn-server")) })).status).toBe(503);
  expect((await cnDetail("cn-server")).status.connected).toBe(false);
  expect(fixture.state.dispatches).toBe(0);
  fixture.state.largeInitialize = false;
  expect((await cnSetup("cn-server")).connector.status).toMatchObject({ state: "notRequired", connected: true });
}), 60_000);

test("Muse Connectors CN-03 withholds original OAuth credentials echoed by transport and tool errors", async () => connectorsFixture(async fixture => {
  const flow = await cnAuthorize(fixture);
  expect((await cnCallback(flow.callback)).status).toBe(200);
  fixture.state.echoTransport = true;
  const status = await cnPageInvoke("mcp:cn-server:connectionStatus");
  expect(status.ok).toBe(false);
  expect(JSON.stringify(status)).not.toContain(fixture.state.accessToken);
  fixture.state.echoTransport = false; fixture.state.echoTool = true;
  await api("/api/permissions", { method: "PUT", json: { scope: "action", id: "mcp:cn-server:read", policy: "allow" } });
  const tool = await cnPageInvoke("mcp:cn-server:read");
  expect(tool.ok).toBe(false);
  expect(JSON.stringify(tool)).not.toContain(fixture.state.accessToken);
  expect(fixture.state.dispatches).toBe(1);
  const exposed = JSON.stringify({ logs: await secretLogs(), history: await getJSON("/api/approvals/history") });
  expect(exposed).not.toContain(fixture.state.accessToken);
}), 60_000);

test("Muse Connectors CN-03 refuses expired authorization on an already active original MCP client before tool dispatch", async () => connectorsFixture(async fixture => {
  fixture.state.expire = true;
  const flow = await cnAuthorize(fixture); expect((await cnCallback(flow.callback)).status).toBe(200);
  await api("/api/permissions", { method: "PUT", json: { scope: "action", id: "mcp:cn-server:read", policy: "allow" } });
  expect((await cnPageInvoke("mcp:cn-server:read")).ok).toBe(true);
  expect(fixture.state.dispatches).toBe(1);
  await Bun.sleep(1150);
  const expired = await cnPageInvoke("mcp:cn-server:read");
  expect(expired.ok).toBe(false);
  expect(expired.error.code).toBe("authentication_required");
  expect(fixture.state.dispatches).toBe(1); expect(fixture.state.refreshes).toBe(0);
}), 60_000);

test("Muse Connectors CN-03 consumes callback authority once across overlapping original requests", async () => connectorsFixture(async fixture => {
  const flow = await cnAuthorize(fixture); fixture.state.tokenHeld = true;
  const requests = Promise.all([cnCallback(flow.callback), cnCallback(flow.callback)]);
  for (let attempt = 0; fixture.state.tokenWaiting.length === 0 && attempt < 100; attempt++) await Bun.sleep(10);
  for (const release of fixture.state.tokenWaiting.splice(0)) release();
  const responses = await requests;
  expect(fixture.state.exchanges).toBe(1);
  expect(responses.map(response => response.status).sort()).toEqual([200, 400]);
  expect(JSON.parse(await readFile(secretsPath(), "utf8")).bindings.filter((binding: any) => binding.consumerKind === "mcpServer")).toHaveLength(1);
}), 60_000);

test("Muse Connectors CN-03 preserves ordinary API binding encoding when either Muse gate is off", async () => connectorsFixture(async fixture => {
  const path = "artifacts/cn-ordinary-api.html";
  expect((await api(`/api/files/content?path=${encodeURIComponent(path)}`, { method: "PUT", body: "<!doctype html><title>Original ordinary API owner</title>" })).status).toBe(201);
  for (const [index, [personal, parity]] of [[false, false], [true, false], [false, true]].entries()) {
    const domain = `cn-ordinary-api-${index}`;
    await writeService("api", domain, { kind: "api", domain, name: domain, baseUrl: `${fixture.origin}/api/`, auth: { type: "http", scheme: "bearer" },
      actions: [action("status", object({}), object({ ok: { type: "boolean" } }), { requireAuth: true })] },
      'window.ox.install(({action,request})=>action("status",{async invoke(){return await request({path:"status"})}}));');
    await restartSecretsHost(personal, parity);
    const session = crypto.randomUUID();
    const outcome = async (response: Response) => JSON.parse((await response.text()).trim().split("\n").at(-1)!);
    const form = await outcome(await api("/api/canvas/call", { method: "POST", json: { session, path, function: "ox.service.invoke",
      arguments: { purpose: "Configure original ordinary API", name: `api:${domain}:configureCredentials`, input: {} } } }));
    expect(form.interaction.kind).toBe("form");
    const saved = await outcome(await api("/api/canvas/answer", { method: "POST", json: { session, interaction: form.interaction.id, values: { token: fixture.state.apiToken } } }));
    expect(saved).toMatchObject({ ok: true, value: { state: "configured" } });
    await api("/api/canvas/close", { method: "POST", json: { session } });
    const stored = JSON.parse(await readFile(secretsPath(), "utf8"));
    expect(stored.bindings.find((binding: any) => binding.destination === `${fixture.origin}/api/` && stored.entries.find((entry: any) => entry.key === binding.secretKey).displayName === domain).revision).toBeUndefined();
    expect((await api("/api/connectors")).status).toBe(404);
  }
}), 60_000);

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
  expect(value.shown).toEqual({ shown: true, status: "awaiting_user" });
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

test("API service headers preserve safe values and refuse reserved, duplicate and injected fields before sending", async () => {
  await writeService("api", "header-fixture", { kind: "api", domain: "header-fixture", name: "Header Fixture",
    baseUrl: `http://app.localhost:${port}/v1/`, auth: { type: "none" },
    actions: [action("headers", object({ headers: { type: "object", additionalProperties: { type: "string" } } }),
      object({ accepted: { type: ["string", "null"] }, authorized: { type: "boolean" } }))],
  }, `window.ox.install(({action,request}) => action("headers",{async invoke({headers}) {return await request({path:"headers",headers});}}));`);
  const id = await conversation(), before = headerRequests;
  const { value } = await run(id, `
    await ox.service.attach({purpose:"Attach fixture",domain:"header-fixture"});
    const invoke = headers => ox.service.invoke({purpose:"Read headers",name:"api:header-fixture:headers",input:{headers}});
    const valid = await invoke({"X-Fixture":"kept"});
    const rejected = [];
    for (const headers of [{Authorization:"blocked"},{"X-Field":"a","x-field":"b"},{"X-Fixture":"bad\\r\\nInjected: value"}]) {
      try { await invoke(headers); } catch(error) { rejected.push(error.code); }
    }
    return {valid,rejected};
  `);
  expect(value).toEqual({ valid: { accepted: "kept", authorized: false }, rejected: ["invalid_argument", "invalid_argument", "invalid_argument"] });
  expect(headerRequests - before).toBe(1);
});

test("Typed secrets expose only service-owned metadata and unsupported frame targeting never executes an action", async () => {
  const id = await conversation(), username = "fixture-account-user", password = "fixture-account-private-value", before = orders.length;
  const { value, prompts, view } = await run(id, `
    await ox.service.attach({purpose:"Attach app",domain:"app.localhost"});
    const saved = await ox.secret.add({purpose:"Save fixture account",key:"typed-fixture",type:"account",serviceID:"web:app.localhost"});
    const listed = await ox.secret.list({purpose:"Read metadata"});
    const inspected = await ox.service.inspect({purpose:"Inspect owned metadata",domain:"app.localhost"});
    let frame;
    try { await ox.service.invoke({purpose:"Do not write",name:"web:app.localhost:placeOrder",input:{item:"not-created"},frameId:"unavailable-frame"}); }
    catch(error) { frame=error.code; }
    return {saved,listed,inspected,frame};
  `, prompt => prompt.requiresApp ? { values: { displayName: "Fixture account", username, password } } : undefined);
  expect(prompts).toHaveLength(1);
  expect(value.saved).toEqual({ key: "typed-fixture", status: "saved" });
  expect(value.listed).toContainEqual({ key: "typed-fixture", displayName: "Fixture account", fields: ["password", "username"], available: true, type: "account", serviceID: "web:app.localhost" });
  expect(value.inspected.secrets).toEqual([{ key: "typed-fixture", displayName: "Fixture account", type: "account" }]);
  conforms("ox.secret.list", value.listed); conforms("ox.service.inspect", value.inspected);
  expect(value.frame).toBe("not_supported");
  expect(orders.length).toBe(before);
  const exposed = JSON.stringify({ value, view, logs: await secretLogs() });
  expect(exposed).not.toContain(username); expect(exposed).not.toContain(password);
});

type PasswordRow = { id: string; revision: number; site: string; connectedServices: number };
type PasswordProof = { outcome: string; receipt: { requestId: string; id: string; operation: string; expectedRevision: number; revision: number } | null; password: PasswordRow | null; replayed?: boolean; inputApplied?: boolean };
type PasswordFile = { version: number; entries: { key: string; displayName: string; origin: unknown; value: Record<string, string>; type?: string; website?: { id: string; revision: number } }[];
  bindings: { consumerKind: string; consumerID: string; secretKey: string; destination: string; configurationFingerprint: string; requiredFields: string[] }[];
  websiteRequests?: NonNullable<PasswordProof["receipt"]>[] };
const passwordInput = () => ({ id: crypto.randomUUID(), requestId: crypto.randomUUID(), url: "https://example.com/ss-private-path",
  username: "ss-private-username", password: "ss-private-password" });
const secretsPath = () => join(local, "..", "..", "state", "secrets.json");
async function restartSecretsHost(personal = false, parity = false) {
  if (host) { host.process.kill("SIGTERM"); expect(await host.process.exited).toBe(0); host = undefined; }
  host = await startHost(personal, parity);
  expect((await fetch(`http://127.0.0.1:${host.port}/api/health`)).status).toBe(200);
}
async function savedPassword(input = passwordInput()) {
  const response = await api("/api/passwords", { method: "POST", json: input });
  expect(response.status).toBe(201);
  const proof = await response.json() as PasswordProof;
  expect(proof.outcome).toBe("committed");
  expect(proof.inputApplied).toBe(true); expect(proof.replayed).toBe(false);
  expect(proof.password).toEqual({ id: input.id, revision: 1, site: "https://example.com", connectedServices: 0 });
  return { input, proof, row: proof.password! };
}
async function passwordAPISetup(domain: string, username: string, password: string) {
  await writeService("api", domain, { kind: "api", domain, name: "Secure store API fixture", description: "Original credential binding fixture.",
    baseUrl: "https://api.example.com/v1/", auth: { type: "http", scheme: "basic" }, actions: [action("status", object({}), object({ ok: { type: "boolean" } }))] },
  'window.ox.install(({action})=>action("status",{async invoke(){return {ok:true}}}));\n');
  const id = await conversation();
  const result = await run(id, `await ox.service.attach({purpose:"Attach original API owner",domain:${JSON.stringify(domain)}});
    return await ox.service.invoke({purpose:"Configure original API owner",name:${JSON.stringify(`api:${domain}:configureCredentials`)},input:{}});`,
    prompt => prompt.requiresApp ? { values: { username, password } } : { answer: "Approve" });
  expect(result.value).toMatchObject({ completed: true, state: "configured" });
  return { id, result };
}

test("Muse Secure store keeps website passwords in original Secrets with private metadata and compatible API bindings", async () => {
  await restartSecretsHost(true, true);
  try {
    const apiOwner = await passwordAPISetup("ss-original-api", "ss-api-user", "ss-api-password");
    const initial = JSON.parse(await readFile(secretsPath(), "utf8")) as PasswordFile;
    const bindings = structuredClone(initial.bindings);
    const modelCalls = systemPrompts.length, dispatches = orders.length + headerRequests;
    const abort = new AbortController(), stream = await api("/api/events", { signal: abort.signal });
    expect(stream.status).toBe(200);
    const reader = stream.body!.getReader();
    let eventText = "";
    const event = (async () => {
      while (!eventText.includes("event: secrets")) {
        const next = await reader.read();
        if (next.done) throw new Error("No original Secrets event");
        eventText += new TextDecoder().decode(next.value);
      }
    })();
    const { input, row, proof } = await savedPassword();
    try { await Promise.race([event, Bun.sleep(3000).then(() => { throw new Error("Original Secrets event timed out"); })]); }
    finally { abort.abort(); await reader.cancel().catch(() => {}); }
    expect(eventText).toContain('data: {"type":"secrets"}');
    for (const text of [input.username, input.password, input.url, "/ss-private-path"]) expect(eventText).not.toContain(text);
    expect((await getJSON<{ features: { secureStore?: boolean } }>("/api/settings")).features.secureStore).toBe(true);
    expect(await getJSON("/api/passwords")).toMatchObject({ available: true, passwords: [row] });
    const stored = JSON.parse(await readFile(secretsPath(), "utf8")) as PasswordFile;
    expect(stored.version).toBe(1);
    expect(stored.entries.find(entry => entry.website?.id === input.id)).toMatchObject({
      key: `password.${input.id}`, displayName: "https://example.com", type: "account",
      value: { url: input.url, username: input.username, password: input.password }, website: { id: input.id, revision: 1 },
    });
    expect(stored.bindings).toEqual(bindings);
    expect(stored.websiteRequests).toContainEqual(proof.receipt!);
    expect((await stat(secretsPath())).mode & 0o777).toBe(0o600);
    const changed = await api(`/api/passwords/${input.id}`, { method: "PATCH", json: {
      requestId: crypto.randomUUID(), expectedRevision: 1, confirm: true, username: "ss-edited-private-user", password: "", url: "",
    } });
    expect(changed.status).toBe(200);
    expect((await changed.json() as PasswordProof).password?.revision).toBe(2);
    expect((JSON.parse(await readFile(secretsPath(), "utf8")) as PasswordFile).entries.find(entry => entry.website?.id === input.id)?.value)
      .toEqual({ url: input.url, username: "ss-edited-private-user", password: input.password });
    expect(systemPrompts.length).toBe(modelCalls); expect(orders.length + headerRequests).toBe(dispatches);
    const metadata = await run(apiOwner.id, 'return {list:await ox.secret.list({purpose:"Read safe metadata"}),service:await ox.service.inspect({purpose:"Read original API status",domain:"ss-original-api"})};');
    conforms("ox.secret.list", metadata.value.list); conforms("ox.service.inspect", metadata.value.service);
    const exposed = JSON.stringify({ metadata, list: await getJSON("/api/passwords"), proof: await getJSON(`/api/passwords/requests/${input.requestId}`),
      logs: await secretLogs(), history: await getJSON("/api/approvals/history") });
    expect((await secretLogs()).some(row => row.category === "secrets" && row.message.includes(`password add id=${input.id}`))).toBe(true);
    for (const privateText of [input.username, input.password, "/ss-private-path", "ss-edited-private-user", "ss-api-user", "ss-api-password"]) expect(exposed).not.toContain(privateText);
    expect(metadata.value.list.find((entry: { key: string }) => entry.key === `password.${input.id}`).serviceID).toBeNull();
    await restartSecretsHost(true, true);
    expect((await getJSON<{ passwords: PasswordRow[] }>("/api/passwords")).passwords).toContainEqual({ ...row, revision: 2 });
    expect((JSON.parse(await readFile(secretsPath(), "utf8")) as PasswordFile).bindings).toEqual(bindings);
    expect((await api(`/api/passwords/${input.id}`, { method: "DELETE", json: { requestId: crypto.randomUUID(), expectedRevision: 2, confirm: false } })).status).toBe(400);
    expect((await api(`/api/passwords/${input.id}`, { method: "DELETE", json: { requestId: crypto.randomUUID(), expectedRevision: 2, confirm: true } })).status).toBe(200);
    expect((await getJSON<{ passwords: PasswordRow[] }>("/api/passwords")).passwords.some(entry => entry.id === input.id)).toBe(false);
    expect((JSON.parse(await readFile(secretsPath(), "utf8")) as PasswordFile).bindings).toEqual(bindings);
  } finally { await restartSecretsHost(); }
}, 60_000);

test("Muse Secure store validates bounded input and paired double gates before any credential mutation", async () => {
  await restartSecretsHost(true, true);
  const original = await readFile(secretsPath(), "utf8").catch(() => null);
  try {
    const input = passwordInput();
    const invalid = [
      { ...input, id: "../private" }, { ...input, requestId: "request" }, { ...input, username: "" }, { ...input, password: "" },
      { ...input, username: "u".repeat(513) }, { ...input, password: "p".repeat(4097) }, { ...input, url: "https://example.com/" + "a".repeat(2049) },
      { ...input, url: "javascript:alert(1)" }, { ...input, url: "https://user:private@example.com/" },
      { ...input, url: "https://example.com/?token=ss-private-query" }, { ...input, url: "https://example.com/#ss-private-fragment" },
      { ...input, url: "https://example.com/\nprivate" }, { ...input, url: "https://example.com/ private" }, { ...input, serviceID: "web:example.com" }, null,
    ];
    for (const body of invalid) {
      const response = await api("/api/passwords", { method: "POST", json: body });
      expect(response.status).toBe(400);
      const error = await response.text();
      for (const privateText of [input.username, input.password, "ss-private-query", "ss-private-fragment", "user:private"]) expect(error).not.toContain(privateText);
    }
    expect((await api("/api/passwords", { method: "POST", json: { ...input, password: "p".repeat(9000) } })).status).toBe(413);
    expect((await fetch(`http://127.0.0.1:${host!.port}/api/passwords`)).status).toBe(401);
    expect((await api("/api/passwords", { method: "POST", json: input, headers: { origin: "https://foreign.invalid" } })).status).toBe(403);
    expect((await api("/api/passwords", { headers: { origin: "null" } })).status).toBe(403);
    expect((await api("/api/passwords/requests/not-safe")).status).toBe(400);
    expect(await readFile(secretsPath(), "utf8").catch(() => null)).toBe(original);
    for (const [personal, parity] of [[false, false], [true, false], [false, true]]) {
      await restartSecretsHost(personal, parity);
      expect((await api("/api/passwords")).status).toBe(404);
      expect((await api("/api/passwords", { method: "POST", json: input })).status).toBe(404);
      expect((await getJSON<{ features?: { secureStore?: boolean } }>("/api/settings")).features?.secureStore).not.toBe(true);
      expect(await readFile(secretsPath(), "utf8").catch(() => null)).toBe(original);
    }
  } finally { await restartSecretsHost(); }
}, 60_000);

test("Muse Secure store serializes peer and generic edits and proves lost commits without replay or resurrection", async () => {
  await restartSecretsHost(true, true);
  try {
    const { input, row } = await savedPassword();
    const recordedBytes = await readFile(secretsPath(), "utf8");
    const ignoredInput = await api("/api/passwords", { method: "POST", json: { ...input, username: "ss-ignored-replay-user", password: "ss-ignored-replay-password" } });
    expect(ignoredInput.status).toBe(200);
    expect(await ignoredInput.json()).toMatchObject({ outcome: "committed", replayed: true, inputApplied: false });
    expect(await readFile(secretsPath(), "utf8")).toBe(recordedBytes);
    const peer = /OX_HOST_TOKEN=(\S+)/.exec(await hostCommand("token", "--name", "SS peer"))![1]!;
    const edits = await Promise.all([token, peer].map((credential, index) => api(`/api/passwords/${input.id}`, { method: "PATCH",
      headers: { authorization: `Bearer ${credential}` }, json: { requestId: crypto.randomUUID(), expectedRevision: row.revision, confirm: true, username: `ss-peer-${index}` } })));
    expect(edits.map(response => response.status).sort()).toEqual([200, 409]);
    const current = (await getJSON<{ passwords: PasswordRow[] }>("/api/passwords")).passwords.find(entry => entry.id === input.id)!;
    expect(current.revision).toBe(2);
    expect((await api(`/api/secrets/password.${input.id}`, { method: "PUT", json: { fields: { username: "ss-generic-peer", password: "", url: "" } } })).status).toBe(200);
    expect((await api(`/api/passwords/${input.id}`, { method: "PATCH", json: { requestId: crypto.randomUUID(), expectedRevision: 2, confirm: true, password: "ss-stale-overwrite" } })).status).toBe(409);
    const before = JSON.parse(await readFile(secretsPath(), "utf8")) as PasswordFile;
    expect(before.entries.find(entry => entry.website?.id === input.id)?.website?.revision).toBe(3);
    const typed = await run(await conversation(), `return await ox.secret.add({purpose:"Edit through original typed owner",key:${JSON.stringify(`password.${input.id}`)},type:"account"});`,
      prompt => prompt.requiresApp ? { values: { username: "ss-typed-peer", password: "ss-typed-password" } } : { answer: "Approve" });
    expect(typed.value.status).toBe("saved");
    const typedStored = JSON.parse(await readFile(secretsPath(), "utf8")) as PasswordFile;
    expect(typedStored.entries.find(entry => entry.website?.id === input.id)).toMatchObject({ website: { revision: 4 }, value: { url: input.url } });
    expect((await api(`/api/passwords/${input.id}`, { method: "DELETE", json: { requestId: crypto.randomUUID(), expectedRevision: 3, confirm: true } })).status).toBe(409);
    const replay = await api("/api/passwords", { method: "POST", json: { ...input, password: "ss-never-replayed" } });
    expect(replay.status).toBe(200); expect((await replay.json() as PasswordProof).outcome).toBe("superseded");
    expect((await api("/api/passwords", { method: "POST", json: { ...input, id: crypto.randomUUID() } })).status).toBe(409);
    const deletion = { requestId: crypto.randomUUID(), expectedRevision: 4, confirm: true };
    expect((await api(`/api/passwords/${input.id}`, { method: "DELETE", json: deletion })).status).toBe(200);
    expect((await getJSON<PasswordProof>(`/api/passwords/requests/${input.requestId}`)).outcome).toBe("deleted");
    expect((await api("/api/passwords", { method: "POST", json: input })).status).toBe(200);
    expect((await api("/api/passwords", { method: "POST", json: { ...input, requestId: crypto.randomUUID() } })).status).toBe(409);
    expect((await api(`/api/passwords/${input.id}`, { method: "DELETE", json: deletion })).status).toBe(200);
    const originalAPI = await passwordAPISetup("ss-cas-api", "ss-api-revision-user", "ss-api-revision-password");
    await restartSecretsHost();
    const originalFile = JSON.parse(await readFile(secretsPath(), "utf8")) as PasswordFile;
    const apiEntry = originalFile.entries.find(entry => entry.value.username === "ss-api-revision-user")!;
    const apiID = crypto.randomUUID();
    apiEntry.website = { id: apiID, revision: 1 }; apiEntry.type = "account"; apiEntry.value.url = "https://api.example.com/private";
    apiEntry.displayName = "https://api.example.com";
    await writeFile(secretsPath(), JSON.stringify(originalFile));
    await restartSecretsHost(true, true);
    const requestId = crypto.randomUUID();
    expect((await api(`/api/passwords/${apiID}`, { method: "PATCH", json: { requestId, expectedRevision: 1, confirm: true, password: "ss-owner-edited-api-password" } })).status).toBe(200);
    const manifest = join(local, "api", "ss-cas-api", "service.json");
    const definition = JSON.parse(await readFile(manifest, "utf8")); definition.baseUrl = "https://api.example.com/v2/";
    await writeFile(manifest, JSON.stringify(definition));
    const configured = await run(originalAPI.id, 'await ox.service.attach({purpose:"Reload original API",domain:"ss-cas-api"}); return await ox.service.invoke({purpose:"Reconfigure original API",name:"api:ss-cas-api:configureCredentials",input:{}});',
      prompt => prompt.requiresApp ? { values: { username: "ss-api-peer-user", password: "ss-api-peer-password" } } : { answer: "Approve" });
    expect(configured.value.state).toBe("configured");
    const afterAPI = JSON.parse(await readFile(secretsPath(), "utf8")) as PasswordFile;
    expect(afterAPI.entries.find(entry => entry.website?.id === apiID)).toMatchObject({ key: apiEntry.key, website: { revision: 3 },
      value: { url: "https://api.example.com/private", username: "ss-api-peer-user", password: "ss-api-peer-password" } });
    expect(afterAPI.bindings.filter(binding => binding.secretKey === apiEntry.key)).toHaveLength(1);
    expect((await getJSON<PasswordProof>(`/api/passwords/requests/${requestId}`)).outcome).toBe("superseded");
    expect((await api(`/api/passwords/${apiID}`, { method: "DELETE", json: { requestId: crypto.randomUUID(), expectedRevision: 2, confirm: true } })).status).toBe(409);
    const lost = passwordInput();
    const response = await api("/api/passwords", { method: "POST", json: lost });
    expect(response.status).toBe(201); await response.body?.cancel();
    const verified = await getJSON<PasswordProof>(`/api/passwords/requests/${lost.requestId}`);
    expect(verified).toMatchObject({ outcome: "committed", password: { id: lost.id, revision: 1 } });
    const unknown = await getJSON<PasswordProof>(`/api/passwords/requests/${crypto.randomUUID()}`);
    expect(unknown).toEqual({ outcome: "unconfirmed", receipt: null, password: null });
    await restartSecretsHost(true, true);
    expect(await getJSON(`/api/passwords/requests/${lost.requestId}`)).toEqual(verified);
    const stored = JSON.parse(await readFile(secretsPath(), "utf8")) as PasswordFile;
    expect(stored.entries.filter(entry => entry.website?.id === lost.id)).toHaveLength(1);
    expect(JSON.stringify(stored.websiteRequests)).not.toContain("ss-private");
  } finally { await restartSecretsHost(); }
}, 60_000);

test("Muse Secure store refuses corrupt future full and actual I/O-failed owner writes while retaining old secrets", async () => {
  await restartSecretsHost(true, true);
  const { input } = await savedPassword();
  const original = await readFile(secretsPath(), "utf8"), directory = join(local, "..", "..", "state");
  try {
    await chmod(secretsPath(), 0o000);
    expect((await api("/api/passwords")).status).toBe(503);
    expect((await api(`/api/passwords/requests/${input.requestId}`)).status).toBe(503);
    await chmod(secretsPath(), 0o600);
    expect((await api("/api/passwords")).status).toBe(200);
    expect(await readFile(secretsPath(), "utf8")).toBe(original);
    await chmod(directory, 0o500);
    const denied = await api("/api/passwords", { method: "POST", json: passwordInput() });
    expect(denied.status).toBe(503); expect(await denied.json()).toMatchObject({ code: "write_failed" });
    expect(await readFile(secretsPath(), "utf8")).toBe(original);
    await chmod(directory, 0o700);
    expect((await readdir(directory)).some(name => name.startsWith("secrets.json.") && name.endsWith(".tmp"))).toBe(false);
    expect((await getJSON<{ passwords: PasswordRow[] }>("/api/passwords")).passwords.some(entry => entry.id === input.id)).toBe(true);
    for (const bad of ["{corrupt", JSON.stringify({ ...JSON.parse(original), version: 2 })]) {
      await restartSecretsHost();
      await writeFile(secretsPath(), bad);
      await restartSecretsHost(true, true);
      expect((await api("/api/passwords")).status).toBe(503);
      expect((await api("/api/passwords", { method: "POST", json: passwordInput() })).status).toBe(503);
      expect((await api("/api/secrets", { method: "POST", json: { key: "ss-no-empty-fallback", fields: { value: "kept" } } })).status).not.toBe(201);
      expect(await readFile(secretsPath(), "utf8")).toBe(bad);
      expect((await readdir(directory)).some(name => name.startsWith("secrets.json.corrupt-"))).toBe(false);
      await writeFile(secretsPath(), original);
      expect((await api("/api/passwords")).status).toBe(200);
    }
    const full = JSON.parse(original) as PasswordFile;
    const template = full.entries.find(entry => entry.website?.id === input.id)!;
    full.entries = full.entries.filter(entry => !entry.website);
    for (let count = 0; count < 500; count++) {
      const id = crypto.randomUUID();
      full.entries.push({ ...structuredClone(template), key: `password.${id}`, website: { id, revision: 1 } });
    }
    await restartSecretsHost(); await writeFile(secretsPath(), JSON.stringify(full)); await restartSecretsHost(true, true);
    const fullBytes = await readFile(secretsPath(), "utf8");
    expect((await api("/api/passwords", { method: "POST", json: passwordInput() })).status).toBe(507);
    expect(await readFile(secretsPath(), "utf8")).toBe(fullBytes);
    const receipts = JSON.parse(original) as PasswordFile;
    receipts.websiteRequests = Array.from({ length: 5000 }, () => ({ requestId: crypto.randomUUID(), id: crypto.randomUUID(), operation: "delete", expectedRevision: 1, revision: 2 }));
    await restartSecretsHost(); await writeFile(secretsPath(), JSON.stringify(receipts)); await restartSecretsHost(true, true);
    const receiptBytes = await readFile(secretsPath(), "utf8");
    expect((await api(`/api/passwords/${input.id}`, { method: "DELETE", json: { requestId: crypto.randomUUID(), expectedRevision: 1, confirm: true } })).status).toBe(507);
    expect(await readFile(secretsPath(), "utf8")).toBe(receiptBytes);
  } finally {
    await chmod(directory, 0o700);
    await chmod(secretsPath(), 0o600);
    if (host) { host.process.kill("SIGTERM"); await host.process.exited; host = undefined; }
    await writeFile(secretsPath(), original);
    host = await startHost();
  }
}, 90_000);

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

async function installUstaFixture() {
  const directory = join(ROOT, "apps/shared/Resources/OxServices.bundle/web/www.usta.com");
  const manifest = JSON.parse(await readFile(join(directory, "service.json"), "utf8")) as Record<string, unknown>;
  const origin = `http://www.usta.localhost:${port}`;
  const source = (await readFile(join(directory, "actions.js"), "utf8")).replace(/https:\/\/(?:[a-z0-9-]+\.)*usta\.com/g, origin);
  await writeService("web", "www.usta.localhost", { ...manifest, domain: "www.usta.localhost", name: "USTA Fixture", baseUrl: origin + "/", faviconUrl: undefined }, source);
}

test("The bundled USTA login action follows the visible ready header button, never Join or the obsolete login URL", async () => {
  await installUstaFixture();
  ustaVisits.length = 0;
  const response = await api("/api/services/www.usta.localhost/login", { method: "POST" });
  expect(response.status).toBe(200);
  const { page } = await response.json() as { page: { id: string } };
  let state: { url: string; title: string } | undefined;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    state = (await getJSON<{ page: { url: string; title: string } }>(`/api/pages/${page.id}`)).page;
    if (state.title === "USTA sign-in fixture") break;
    await Bun.sleep(50);
  }
  expect(state).toMatchObject({ url: `http://account.usta.localhost:${port}/u/login`, title: "USTA sign-in fixture" });
  expect(ustaVisits).not.toContain("/joined");
  expect(ustaVisits).not.toContain("/wrong");
  expect(ustaVisits).not.toContain("/en/login.html");
}, 20_000);

test("A service website stays above Settings when Back reaches another Settings entry or the same hash", async () => {
  await installUstaFixture();
  const { chromium } = await import(Bun.resolveSync("playwright-core", join(ROOT, "apps/linux"))) as typeof import("../../../../../apps/linux/node_modules/playwright-core");
  const browser = await chromium.launch();
  try {
    const base = `http://127.0.0.1:${host!.port}`;
    const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    await context.addCookies([{ name: "ox_device", value: token, url: base, httpOnly: true, sameSite: "Strict" }]);
    const page = await context.newPage();
    await page.goto(base);
    await page.locator("[data-testid=onboarding-start]").click();
    for (const scenario of ["normal", "another-settings", "same-hash"]) {
      await page.goto(base);
      await page.locator("[data-testid=nav-settings]:visible").first().click();
      await page.locator("[data-testid=settings-tab-services]").waitFor();
      if (scenario === "another-settings") await page.evaluate(() => { location.hash = "#/settings/services"; });
      else await page.locator("[data-testid=settings-tab-services]").click();
      await page.locator("[data-testid=service-search]").fill("USTA Fixture");
      await page.locator("[data-domain='www.usta.localhost'] [data-testid=service-open]").click();
      if (scenario === "same-hash") await page.evaluate(() => history.pushState(null, "", location.href));
      await page.locator("[data-testid=service-sign-in]").click();
      const stage = page.locator("[data-testid=viewer-stage]");
      await stage.locator("img[src]").waitFor({ timeout: 10000 });
      await page.locator("[data-testid=settings]").waitFor({ state: "detached", timeout: 3000 });
      expect(await stage.evaluate(element => {
        const rect = element.getBoundingClientRect();
        return !!document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)?.closest("[data-testid=page-viewer]");
      })).toBe(true);
      await page.locator("[data-testid=viewer-close]").click();
      await stage.waitFor({ state: "detached" });
    }
    await context.close();
  } finally { await browser.close(); }
}, 45_000);

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

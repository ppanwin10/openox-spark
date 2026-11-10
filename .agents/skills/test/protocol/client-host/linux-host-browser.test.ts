import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Value } from "typebox/value";
import { ROOT } from "../../../../lib.ts";

type Prompt = { id: string; prompt: string; options: string[]; requiresApp: boolean };
type View = { busy: boolean; pendingPrompt?: Prompt; blocks: { kind: Record<string, unknown> }[]; messages: { role: string; content: unknown }[] };
type Answer = { answer: string } | { cancel: true };
type Result = Record<string, any>;

const chunk = (delta: unknown, finish: string | null = null) => `data: ${JSON.stringify({ id: "chatcmpl-fixture", object: "chat.completion.chunk", created: 0, model: "fixture",
  choices: [{ index: 0, delta, finish_reason: finish }], ...(finish ? { usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } } : {}) })}\n\n`;
const text = (value: string) => [chunk({ role: "assistant", content: value }), chunk({}, "stop")];
const call = (purpose: string, source: string) => [chunk({ role: "assistant", tool_calls: [{ index: 0, id: `call_${crypto.randomUUID()}`, type: "function",
  function: { name: "execute", arguments: JSON.stringify({ purpose, source }) } }] }), chunk({}, "tool_calls")];
const plain = (content: unknown) => typeof content === "string" ? content
  : Array.isArray(content) ? content.map(part => typeof part === "string" ? part : (part as { text?: string }).text ?? "").join("") : JSON.stringify(content);

function scriptedModel() {
  return Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (request.method === "GET") return new Response("Not found", { status: 404 });
    const body = await request.json() as { messages: { role: string; content: unknown }[] };
    const last = body.messages.at(-1)!;
    const script = /SCRIPT:([A-Za-z0-9+/=]+)/.exec(plain(last.content))?.[1];
    const events = last.role === "tool" ? text(`RESULT ${plain(last.content)}`) : script ? call("Use the browser", Buffer.from(script, "base64").toString()) : text("No script.");
    return new Response(events.join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  } });
}

function fixtureSite() {
  return Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const url = new URL(request.url);
    const page = (title: string, body: string) => new Response(`<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`,
      { headers: { "content-type": "text/html; charset=utf-8" } });
    switch (url.pathname) {
      case "/": return page("Fixture Home", `<h1>Fixture Home</h1><p role="status">Ready</p><dialog open aria-label="Cookie notice"><p>Cookies</p></dialog>
        <a id="next" href="/form">Form</a><a id="private" href="${base.replace("127.0.0.1", "127.0.0.2")}/">Private</a>`);
      case "/form": return page("Fixture Form", `<h1>Sign up</h1><form id="signup" action="/submitted" method="post"><label for="email">Email</label>
        <input id="email" name="email" value="person@example.com"><input type="password" name="password" value="hunter2-secret" aria-label="Password">
        <input type="checkbox" name="terms" checked aria-label="Terms"><button type="submit">Send</button></form>`);
      case "/api/data": return Response.json({ token: "server-token-value", value: 42 });
      case "/dialogs": return page("Dialogs", `<h1>Dialogs</h1><script>alert("hello"); window.confirmed = confirm("Continue?"); window.prompted = prompt("Name?");</script>`);
      case "/slow": return new Response(new ReadableStream({ async start(controller) {
        controller.enqueue(new TextEncoder().encode(`<!doctype html><html><head><title>Slow</title></head><body><h1>Slow</h1>${" ".repeat(2_048)}`));
        await Bun.sleep(4_000);
        try { controller.enqueue(new TextEncoder().encode("</body></html>")); controller.close(); } catch {}
      } }), { headers: { "content-type": "text/html; charset=utf-8" } });
      case "/download": return new Response("data", { headers: { "content-type": "application/octet-stream", "content-disposition": "attachment; filename=data.bin" } });
      case "/redirect": return Response.redirect(`${base}/form`, 302);
      case "/escape": return Response.redirect(`${internalBase}/secret`, 302);
      case "/escape-post": return new Response(null, { status: 307, headers: { location: `${internalBase}/api/pull` } });
      case "/autopost": return page("Autopost", `<form method="post" action="/escape-post"><input name="name" value="evil"></form><script>document.forms[0].submit();</script>`);
      case "/long": case "/plain": return new Response(`<!doctype html><html><head>${url.pathname === "/long" ? `<meta name="viewport" content="width=device-width, initial-scale=1">` : ""}
        <title>Long</title><style>body { margin: 0; font: 16px sans-serif } p { height: 80px; margin: 0; border-bottom: 1px solid #ccc }
        #tap { position: fixed; top: 10px; left: 10px; width: 120px; height: 60px }</style>
        </head><body><button id="tap">Tap</button>${url.pathname === "/plain" ? `<button id="far" style="position: absolute; left: 700px; top: 600px; width: 200px; height: 100px">Far</button>` : ""}
        ${Array.from({ length: 80 }, (_, row) => `<p>Row ${row}</p>`).join("")}<script>
        let taps = 0, touches = 0, cancels = 0, fars = 0;
        const report = () => { document.title = JSON.stringify({ width: innerWidth, device: Math.round(visualViewport.width * visualViewport.scale), points: navigator.maxTouchPoints,
          coarse: matchMedia("(pointer: coarse)").matches, y: Math.round(scrollY), zoom: Math.round(visualViewport.scale * 100) / 100, taps, touches, cancels, fars }); };
        document.getElementById("tap").addEventListener("click", () => { taps += 1; report(); });
        document.getElementById("far")?.addEventListener("click", () => { fars += 1; report(); });
        addEventListener("touchstart", () => { touches += 1; report(); }, { passive: true });
        addEventListener("touchcancel", () => { cancels += 1; report(); }, { passive: true });
        addEventListener("scroll", report, { passive: true });
        addEventListener("resize", report);
        visualViewport.addEventListener("resize", report);
        setInterval(report, 100);
        report();
        </script></body></html>`, { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    return new Response("Not found", { status: 404 });
  } });
}

let data = "";
let internal: ReturnType<typeof Bun.serve> | undefined;
let internalBase = "";
const internalHits: string[] = [];
let model: ReturnType<typeof scriptedModel>;
let site: ReturnType<typeof fixtureSite>;
let host: { process: ReturnType<typeof Bun.spawn>; port: number } | undefined;
let token = "";
let base = "";
let contracts: Record<string, { outputSchema: object }> = {};
let first = 0;
let pageID = "";

async function startHost() {
  const child = Bun.spawn([process.execPath, `${ROOT}/apps/linux/src/main.ts`, "serve", "--data", data, "--port", "0", "--name", "fixture"],
    { stdout: "pipe", stderr: "pipe", env: { ...Bun.env, OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "", OX_HOST_TEST_ORIGINS: base } });
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

async function hostCommand(...args: string[]) {
  const child = Bun.spawn([process.execPath, `${ROOT}/apps/linux/src/main.ts`, ...args, "--data", data], { stdout: "pipe", stderr: "pipe" });
  const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  expect(code).toBe(0);
  return stdout;
}

function api(path: string, init: RequestInit = {}) {
  return fetch(`http://127.0.0.1:${host!.port}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init.headers } });
}

async function conversation() {
  const response = await api("/api/conversations", { method: "POST", body: "{}" });
  expect(response.status).toBe(201);
  return (await response.json() as { id: number }).id;
}

const view = async (id: number) => await (await api(`/api/conversations/${id}`)).json() as View;

async function run(id: number, body: string, answer?: (prompt: Prompt, current: View) => Answer | Promise<Answer>) {
  const prelude = `const BASE = ${JSON.stringify(base)}; const attempt = async work => { try { return { ok: await work() }; } catch (error) { return { code: error.code, message: error.message }; } };\n`;
  const sent = await api(`/api/conversations/${id}/messages`, { method: "POST", body: JSON.stringify({ text: `SCRIPT:${Buffer.from(prelude + body).toString("base64")}` }) });
  expect(sent.status).toBe(202);
  const prompts: { prompt: Prompt; view: View }[] = [];
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const current = await view(id);
    if (current.pendingPrompt && !prompts.some(item => item.prompt.id === current.pendingPrompt!.id)) {
      prompts.push({ prompt: current.pendingPrompt, view: current });
      if (!answer) throw new Error(`Unexpected prompt: ${current.pendingPrompt.prompt}`);
      const response = await api(`/api/conversations/${id}/respond`, { method: "POST", body: JSON.stringify({ promptId: current.pendingPrompt.id, ...await answer(current.pendingPrompt, current) }) });
      expect(response.status).toBe(200);
    } else if (!current.busy) {
      const reply = plain(current.messages.at(-1)?.content);
      if (!reply.startsWith("RESULT {")) throw new Error(`Unexpected reply: ${reply.slice(0, 4_000)}`);
      return { result: JSON.parse(reply.slice(7)) as Result, prompts, view: current };
    }
    await Bun.sleep(50);
  }
  throw new Error("The browser turn did not finish");
}

function valid<T>(name: string, value: T) {
  const schema = contracts[`ox.web.browser.${name}`]!.outputSchema;
  const errors = [...Value.Errors(schema, value)].map(error => `${error.instancePath} ${error.message}`);
  expect(errors).toEqual([]);
  return value;
}

const pages = async (id: number) => (await (await api(`/api/pages?conversation=${id}`)).json() as { pages: { id: string; owner: string; url: string; conversationId: number }[] }).pages;
const profileDirectory = async () => join(data, "profiles", JSON.parse(await readFile(join(data, "host.json"), "utf8")).profile.id);

beforeAll(async () => {
  data = await mkdtemp(join(tmpdir(), "openox-linux-browser-"));
  model = scriptedModel();
  site = fixtureSite();
  base = `http://127.0.0.1:${site.port}`;
  internal = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    internalHits.push(`${request.method} ${new URL(request.url).pathname}`);
    return new Response("<!doctype html><title>INTERNAL SECRET</title>internal", { headers: { "content-type": "text/html" } });
  } });
  internalBase = `http://127.0.0.1:${internal.port}`;
  contracts = await Bun.file(`${ROOT}/packages/agent/src/functions/web/contracts.json`).json();
  host = await startHost();
  token = /OX_HOST_TOKEN=(\S+)/.exec(await hostCommand("token", "--name", "browser-test"))![1]!;
  const configured = await api("/api/settings/providers/custom", { method: "PUT", body: JSON.stringify({ name: "Scripted", baseUrl: `http://127.0.0.1:${model.port}/v1`, models: ["fixture"] }) });
  expect(configured.status).toBe(200);
}, 30_000);

afterAll(async () => {
  if (host) { host.process.kill("SIGTERM"); await host.process.exited; host = undefined; }
  model?.stop(true);
  site?.stop(true);
  internal?.stop(true);
  if (data) await rm(data, { recursive: true, force: true });
});

test("Browser navigates public pages, refuses other destinations and lists its live page", async () => {
  first = await conversation();
  const { result, view: current } = await run(first, `
    const home = await ox.web.browser.navigate({ purpose: "Open the fixture", url: BASE + "/" });
    const privateAddress = await attempt(() => ox.web.browser.navigate({ purpose: "Open a private address", url: BASE.replace("127.0.0.1", "127.0.0.2") + "/" }));
    const file = await attempt(() => ox.web.browser.navigate({ purpose: "Open a file", url: "file:///etc/passwd" }));
    const redirected = await ox.web.browser.navigate({ purpose: "Follow a redirect", url: BASE + "/redirect" });
    const download = await attempt(() => ox.web.browser.navigate({ purpose: "Open a download", url: BASE + "/download" }));
    const history = await ox.web.browser.getNavigationHistory({ purpose: "Read history" });
    const back = await ox.web.browser.goBack({ purpose: "Go back" });
    const forward = await ox.web.browser.goForward({ purpose: "Go forward" });
    const ahead = await ox.web.browser.goForward({ purpose: "Go past the end" });
    const reload = await ox.web.browser.reload({ purpose: "Reload", fromOrigin: true });
    const stop = await ox.web.browser.stopLoading({ purpose: "Stop loading" });
    const shown = await ox.web.browser.showPage({ purpose: "Show the page" });
    return { home, privateAddress, file, redirected, download, history, back, forward, ahead, reload, stop, shown };`);
  expect(valid("navigate", result.home)).toEqual({ url: `${base}/` });
  expect(result.privateAddress).toMatchObject({ code: "operation_failed" });
  expect(result.privateAddress.message).toContain("public HTTP or HTTPS URL");
  expect(result.file.message).toContain("public HTTP or HTTPS URL");
  expect(valid("navigate", result.redirected)).toEqual({ url: `${base}/form` });
  expect(result.download.message).toContain("navigation became a download");
  valid("getNavigationHistory", result.history);
  expect(result.history.back.map((item: { url: string }) => item.url)).toEqual(["about:blank", `${base}/`]);
  expect(result.history.current).toEqual({ initialUrl: `${base}/redirect`, title: "Fixture Form", url: `${base}/form` });
  expect(result.history.forward).toEqual([]);
  expect(valid("goBack", result.back)).toEqual({ navigated: true, url: `${base}/` });
  expect(valid("goForward", result.forward)).toEqual({ navigated: true, url: `${base}/form` });
  expect(result.ahead).toEqual({ navigated: false, url: null });
  expect(valid("reload", result.reload)).toEqual({ url: `${base}/form` });
  expect(valid("stopLoading", result.stop)).toEqual({ stopped: true, url: `${base}/form` });
  expect(valid("showPage", result.shown)).toEqual({ shown: true });
  const listed = await pages(first);
  expect(listed).toHaveLength(1);
  expect(listed[0]).toMatchObject({ owner: `browser:${first}`, conversationId: first, url: `${base}/form` });
  pageID = listed[0]!.id;
  const card = current.blocks.flatMap(block => (block.kind.items as { page?: unknown }[] | undefined) ?? []).find(item => item.page);
  expect(card).toEqual({ page: { id: pageID, title: "Fixture Form", url: `${base}/form` } });
}, 60_000);

test("Redirects and form posts cannot carry the browser to non-public addresses", async () => {
  const id = await conversation();
  const { result } = await run(id, `
    const redirect = await attempt(() => ox.web.browser.navigate({ purpose: "Follow a redirect to a private address", url: BASE + "/escape" }));
    const posted = await attempt(() => ox.web.browser.navigate({ purpose: "Open a page that posts away", url: BASE + "/autopost" }));
    const history = await ox.web.browser.getNavigationHistory({ purpose: "Read history" });
    return { redirect, posted, history };`);
  await Bun.sleep(1_500);
  expect(result.redirect).toMatchObject({ code: "operation_failed" });
  expect(result.redirect.message).toContain("Browser blocked navigation to a private-network");
  expect(JSON.stringify(result.history)).not.toContain("INTERNAL SECRET");
  expect(internalHits).toEqual([]);
  const logs = await readFile(join(data, "logs", "host.jsonl"), "utf8");
  expect(logs).toContain(`blocked non-public connection ${internalBase}`);
}, 60_000);

test("Page state and scripts need site approval, observe without values and track navigations", async () => {
  const approved = await run(first, `
    const state = await ox.web.browser.getPageState({ purpose: "Inspect the form" });
    const scoped = await ox.web.browser.getPageState({ purpose: "Inspect the form only", selector: "form" });
    const missing = await ox.web.browser.getPageState({ purpose: "Inspect a missing scope", selector: "#nothing" });
    const values = await ox.web.browser.executeScript({ purpose: "Read values", script: "return { title: document.title, nan: NaN, date: new Date(0), skipped: undefined, list: [undefined, 1] };" });
    const thrown = await attempt(() => ox.web.browser.executeScript({ purpose: "Fail", script: "throw new TypeError('bad input');" }));
    const identity = await ox.web.browser.executeScript({ purpose: "Read the browser identity",
      script: "return { agent: navigator.userAgent, webdriver: navigator.webdriver, brands: (navigator.userAgentData?.brands ?? []).map(brand => brand.brand) };" });
    await ox.web.browser.navigate({ purpose: "Open home", url: BASE + "/" });
    const waiting = ox.web.browser.waitForNavigation({ purpose: "Wait for the click", timeoutMs: 10000 });
    await ox.web.browser.executeScript({ purpose: "Click the link", script: "setTimeout(() => document.getElementById('next').click(), 100); return true;" });
    const clicked = await waiting;
    const after = await ox.web.browser.getPageState({ purpose: "Inspect again" });
    const idle = await attempt(() => ox.web.browser.waitForNavigation({ purpose: "Wait without navigation", timeoutMs: 300 }));
    await ox.web.browser.navigate({ purpose: "Open home", url: BASE + "/" });
    const home = await ox.web.browser.getPageState({ purpose: "Inspect home" });
    const blockedWait = ox.web.browser.waitForNavigation({ purpose: "Wait for the private link", timeoutMs: 10000 });
    await ox.web.browser.executeScript({ purpose: "Click the private link", script: "setTimeout(() => document.getElementById('private').click(), 100); return true;" });
    const blocked = await attempt(() => blockedWait);
    const dialogs = await ox.web.browser.navigate({ purpose: "Open dialogs", url: BASE + "/dialogs" });
    const answers = await ox.web.browser.executeScript({ purpose: "Read dialog results", script: "return [window.confirmed, window.prompted];" });
    const slow = attempt(() => ox.web.browser.navigate({ purpose: "Open a slow page", url: BASE + "/slow" }));
    let loading = null;
    for (let index = 0; index < 20 && !loading; index++) {
      const polled = await attempt(() => ox.web.browser.getPageState({ purpose: "Poll loading" }));
      if (polled.ok && polled.ok.isLoading) loading = polled.ok;
    }
    const stopped = await ox.web.browser.stopLoading({ purpose: "Stop the slow page" });
    const slowResult = await slow;
    return { state, scoped, missing, values, thrown, identity, clicked, after, idle, home, blocked, dialogs, answers, loading, stopped, slowResult };`,
  () => ({ answer: "Approve" }));
  expect(approved.prompts).toHaveLength(1);
  expect(approved.prompts[0]!.prompt.options).toEqual(["Approve", "Always approve", "Deny"]);
  expect(approved.prompts[0]!.prompt.prompt).toBe("Browser - 127.0.0.1\n\nInspect the form\nBrowser can read and act on this site, including logged-in data, and share it with the model. Approve trusts it for this conversation.");
  const { state, scoped, missing, values, thrown, identity, clicked, after, idle, home, blocked, dialogs, answers, loading, stopped, slowResult } = approved.result;
  valid("getPageState", state);
  expect(state).toMatchObject({ pageID, url: `${base}/form`, title: "Fixture Form", estimatedProgress: 1, isLoading: false, hasOnlySecureContent: false,
    isBlockedByScreenTime: false, fullscreenState: "notInFullscreen" });
  expect(state.document).toMatchObject({ scope: null, scopeFound: true, readyState: "complete", busy: false, headings: ["Sign up"], dialogs: [], messages: [], truncated: false });
  expect(state.document.controls).toEqual([
    { id: "email", name: "email", role: "input", label: "Email", type: "input", disabled: false, required: false, invalid: false, hasValue: true },
    { id: null, name: "password", role: "input", label: "Password", type: "password", disabled: false, required: false, invalid: false },
    { id: null, name: "terms", role: "input", label: "Terms", type: "checkbox", disabled: false, required: false, invalid: false, checked: true, hasValue: true },
    { id: null, name: null, role: "button", label: "Send", type: "submit", disabled: false, required: false, invalid: false },
  ]);
  expect(JSON.stringify(approved.result)).not.toContain("hunter2-secret");
  expect(JSON.stringify(approved.result)).not.toContain("person@example.com");
  expect(valid("getPageState", scoped).document).toMatchObject({ scope: "form", scopeFound: true, headings: [] });
  expect(valid("getPageState", missing).document).toMatchObject({ scope: "#nothing", scopeFound: false, controls: [] });
  expect(valid("executeScript", values)).toEqual({ title: "Fixture Form", nan: null, date: "1970-01-01T00:00:00.000Z", list: [null, 1] });
  expect(thrown).toMatchObject({ code: "operation_failed" });
  expect(thrown.message).toContain("TypeError: bad input");
  expect(identity.agent).toContain("Chrome/");
  expect(`${identity.agent} ${identity.brands.join(" ")}`).not.toContain("Headless");
  expect(identity.webdriver).toBe(false);
  expect(valid("waitForNavigation", clicked)).toEqual({ url: `${base}/form` });
  expect(after.navigationGeneration).toBeGreaterThan(state.navigationGeneration);
  expect(idle.message).toContain("waitForNavigation timed out");
  expect(home.document).toMatchObject({ headings: ["Fixture Home"], dialogs: [{ label: "Cookie notice" }], messages: ["Ready"] });
  expect(blocked.message).toContain("Browser blocked navigation to a private-network");
  expect(dialogs).toEqual({ url: `${base}/dialogs` });
  expect(answers).toEqual([false, null]);
  expect(valid("getPageState", loading)).toMatchObject({ isLoading: true, url: `${base}/slow`, title: "Slow", estimatedProgress: 0.4 });
  expect(loading.document).toMatchObject({ readyState: "loading", headings: ["Slow"] });
  expect(stopped).toEqual({ stopped: true, url: `${base}/slow` });
  expect(slowResult).toEqual({ ok: { url: `${base}/slow` } });
}, 60_000);

test("Network capture records redacted fetch, XHR and markers with bounded bodies", async () => {
  const { result, prompts } = await run(first, `
    await ox.web.browser.navigate({ purpose: "Open the form", url: BASE + "/form" });
    const start = await ox.web.browser.startCapture({ purpose: "Capture requests", includeBodies: true });
    const marked = await ox.web.browser.markCapture({ purpose: "Mark", label: "before requests" });
    await ox.web.browser.executeScript({ purpose: "Call the API", script: [
      "await fetch('/api/data?token=abc123&page=1', { headers: { authorization: 'Bearer secret-value', 'x-trace': 'visible' } }).then(response => response.json());",
      "await new Promise(resolve => { const request = new XMLHttpRequest(); request.open('POST', '/api/data?session=s1'); request.setRequestHeader('x-api-key', 'key-value');",
      "request.onloadend = resolve; request.send(JSON.stringify({ password: 'pw', note: 'hi' })); });",
      "await new Promise(resolve => setTimeout(resolve, 300)); return true;"].join("\\n") });
    const list = await ox.web.browser.listCapturedEvents({ purpose: "List events" });
    const fetched = await ox.web.browser.readCapturedEvent({ purpose: "Read the fetch", id: list.events.find(event => event.kind === "fetch").id });
    const posted = await ox.web.browser.readCapturedEvent({ purpose: "Read the XHR", id: list.events.find(event => event.kind === "xhr").id });
    const stopped = await ox.web.browser.stopCapture({ purpose: "Stop capture" });
    const unmarked = await ox.web.browser.markCapture({ purpose: "Mark after stop", label: "late" });
    const kept = await ox.web.browser.listCapturedEvents({ purpose: "List kept events" });
    const discarded = await ox.web.browser.stopCapture({ purpose: "Discard capture", discard: true });
    const empty = await ox.web.browser.listCapturedEvents({ purpose: "List discarded events" });
    const missing = await attempt(() => ox.web.browser.readCapturedEvent({ purpose: "Read a missing event", id: "missing" }));
    return { start, marked, list, fetched, posted, stopped, unmarked, kept, discarded, empty, missing };`);
  expect(prompts).toHaveLength(0);
  const { start, marked, list, fetched, posted, stopped, unmarked, kept, discarded, empty, missing } = result;
  expect(valid("startCapture", start)).toEqual({ active: true, includeBodies: true, reloaded: false, url: `${base}/form` });
  expect(valid("markCapture", marked)).toEqual({ marked: true });
  valid("listCapturedEvents", list);
  expect(list).toMatchObject({ active: true, dropped: 0, evicted: 0 });
  expect(list.events[0]).toMatchObject({ kind: "mark", label: "before requests" });
  const fetchEvent = list.events.find((event: { kind: string }) => event.kind === "fetch");
  expect(fetchEvent).toMatchObject({ method: "GET", url: `${base}/api/data?token=%5BREDACTED%5D&page=1`, status: 200, site: "127.0.0.1", frameURL: `${base}/form`,
    requestHeaders: { authorization: "[REDACTED]", "x-trace": "visible" } });
  expect(list.events.some((event: Record<string, unknown>) => "responseBody" in event || "requestBody" in event)).toBe(false);
  expect(list.events.some((event: { kind: string; initiatorType?: string }) => event.kind === "resource" && event.initiatorType === "fetch")).toBe(true);
  expect(valid("readCapturedEvent", fetched)).toMatchObject({ id: fetchEvent.id, requestBody: null, responseBody: '{"token":"[REDACTED]","value":42}' });
  expect(valid("readCapturedEvent", posted)).toMatchObject({ kind: "xhr", method: "POST", url: `${base}/api/data?session=%5BREDACTED%5D`, status: 200,
    requestHeaders: { "x-api-key": "[REDACTED]" }, requestBody: '{"password":"[REDACTED]","note":"hi"}', responseBody: '{"token":"[REDACTED]","value":42}' });
  expect(JSON.stringify(result)).not.toContain("secret-value");
  expect(JSON.stringify(result)).not.toContain("server-token-value");
  expect(JSON.stringify(result)).not.toContain("abc123");
  expect(valid("stopCapture", stopped)).toEqual({ stopped: true });
  expect(unmarked).toEqual({ marked: false });
  expect(kept.active).toBe(false);
  expect(kept.events.length).toBeGreaterThanOrEqual(list.events.length);
  expect(discarded).toEqual({ stopped: false });
  expect(empty).toEqual({ active: false, dropped: 0, evicted: 0, events: [] });
  expect(missing.message).toContain("valid captured event id");
}, 60_000);

test("Injected document-start scripts persist across navigations until cleared", async () => {
  const { result } = await run(first, `
    const injected = await ox.web.browser.injectScript({ purpose: "Inject a marker", domains: ["127.0.0.1"], script: "window.__oxMarker = (window.__oxMarker || 0) + 1;" });
    const seen = await ox.web.browser.executeScript({ purpose: "Read the marker", script: "return window.__oxMarker ?? null;" });
    await ox.web.browser.navigate({ purpose: "Open home", url: BASE + "/" });
    const seenAgain = await ox.web.browser.executeScript({ purpose: "Read the marker again", script: "return window.__oxMarker ?? null;" });
    const suffix = await attempt(() => ox.web.browser.injectScript({ purpose: "Inject for a suffix", domains: ["com"], script: "1" }));
    const invalid = await attempt(() => ox.web.browser.injectScript({ purpose: "Inject for a bad domain", domains: ["not a domain"], script: "1" }));
    const cleared = await ox.web.browser.clearScripts({ purpose: "Clear scripts" });
    const gone = await ox.web.browser.executeScript({ purpose: "Read the cleared marker", script: "return window.__oxMarker ?? null;" });
    const clearedAgain = await ox.web.browser.clearScripts({ purpose: "Clear scripts again" });
    return { injected, seen, seenAgain, suffix, invalid, cleared, gone, clearedAgain };`);
  expect(valid("injectScript", result.injected)).toEqual({ url: `${base}/form` });
  expect(result.seen).toBe(1);
  expect(result.seenAgain).toBe(1);
  expect(result.suffix.message).toContain("registrable domains");
  expect(result.invalid.message).toContain("invalid or excessive document-start script");
  expect(valid("clearScripts", result.cleared)).toEqual({ url: `${base}/` });
  expect(result.gone).toBeNull();
  expect(result.clearedAgain).toEqual({ url: `${base}/` });
}, 60_000);

test("exportPdf saves PDFs in the conversation folder", async () => {
  const { result, view: current } = await run(first, `
    await ox.web.browser.navigate({ purpose: "Open the form", url: BASE + "/form" });
    const named = await ox.web.browser.exportPdf({ purpose: "Save the page", filename: "fixture page" });
    const unnamed = await ox.web.browser.exportPdf({ purpose: "Save the page again" });
    const repeated = await ox.web.browser.exportPdf({ purpose: "Save the page once more" });
    return { named, unnamed, repeated };`);
  for (const value of Object.values(result)) {
    valid("exportPdf", value);
    expect(value).toMatchObject({ url: `${base}/form`, contentType: "application/pdf", attached: false });
    expect(value.pages).toBeGreaterThanOrEqual(1);
  }
  expect([result.named.file, result.unnamed.file, result.repeated.file]).toEqual(["fixture page.pdf", "Browser Page.pdf", "Browser Page (2).pdf"]);
  const folder = join(await profileDirectory(), "files", "conversations", String(first));
  const bytes = await readFile(join(folder, "fixture page.pdf"));
  expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
  expect(bytes.length).toBe(result.named.bytes);
  expect(JSON.stringify(current.blocks)).toContain(`conversations/${first}/fixture page.pdf`);
}, 60_000);

test("waitForUserInteraction clears capture and scripts, then hands the live page to the user", async () => {
  let confirm: Record<string, unknown> | undefined;
  const { result, prompts } = await run(first, `
    await ox.web.browser.startCapture({ purpose: "Capture requests" });
    await ox.web.browser.injectScript({ purpose: "Inject a marker", domains: ["127.0.0.1"], script: "window.__oxMarker = 1;" });
    const handoff = await ox.web.browser.waitForUserInteraction({ purpose: "Let the user check the page", instructions: "Review the form, then choose Done." });
    const capture = await ox.web.browser.listCapturedEvents({ purpose: "List events" });
    const marker = await ox.web.browser.executeScript({ purpose: "Read the marker", script: "return window.__oxMarker ?? null;" });
    const cancelled = await attempt(() => ox.web.browser.waitForUserInteraction({ purpose: "Ask again", instructions: "Close this request." }));
    return { handoff, capture, marker, cancelled };`,
  (prompt, current) => {
    confirm = current.blocks.map(block => block.kind).find(kind => kind.type === "confirm" && kind.promptId === prompt.id);
    return prompt.prompt.endsWith("Review the form, then choose Done.") ? { answer: "Done" } : { cancel: true };
  });
  expect(prompts).toHaveLength(2);
  expect(prompts[0]!.prompt).toMatchObject({ prompt: "Browser\n\nReview the form, then choose Done.", options: ["Done"], requiresApp: true });
  expect(confirm).toMatchObject({ promptKind: "page", page: pageID, done: "Done", title: "Browser" });
  expect(valid("waitForUserInteraction", result.handoff)).toEqual({ completed: true });
  expect(result.capture).toEqual({ active: false, dropped: 0, evicted: 0, events: [] });
  expect(result.marker).toBeNull();
  expect(result.cancelled).toMatchObject({ code: "cancelled" });
}, 60_000);

test("Site approval can be denied or remembered, and removing a conversation closes its pages", async () => {
  const open = `await ox.web.browser.navigate({ purpose: "Open the fixture", url: BASE + "/" });
    const state = await attempt(() => ox.web.browser.getPageState({ purpose: "Inspect the page" }));
    const script = await attempt(() => ox.web.browser.executeScript({ purpose: "Read the title", script: "return document.title;" }));
    return { state, script };`;
  const denied = await conversation();
  const refused = await run(denied, open, () => ({ answer: "Deny" }));
  expect(refused.prompts).toHaveLength(2);
  expect(refused.result.state).toMatchObject({ code: "permission_denied" });
  expect(refused.result.state.message).toContain("ox.web.browser:127.0.0.1: the user declined.");
  expect(refused.result.script).toMatchObject({ code: "permission_denied" });
  const remembered = await conversation();
  const always = await run(remembered, open, () => ({ answer: "Always approve" }));
  expect(always.prompts).toHaveLength(1);
  expect(always.result.script).toEqual({ ok: "Fixture Home" });
  const later = await conversation();
  const silent = await run(later, open);
  expect(silent.prompts).toHaveLength(0);
  expect(silent.result.state.ok.pageID).not.toBe(pageID);
  const stored = JSON.parse(await readFile(join(await profileDirectory(), "vm", "state", "action-policies.json"), "utf8"));
  expect(stored.actions).toEqual({ "ox.web.browser:127.0.0.1": "allow" });
  const approvalList = await (await api("/api/approvals")).json() as { approvals: { action: string; kind: string; target: string }[] };
  expect(approvalList.approvals).toEqual([expect.objectContaining({ action: "ox.web.browser:127.0.0.1", kind: "browser", target: "127.0.0.1" })]);
  expect(await pages(denied)).toHaveLength(1);
  expect((await api(`/api/conversations/${denied}`, { method: "DELETE" })).status).toBe(200);
  expect(await pages(denied)).toEqual([]);
  expect(await pages(first)).toHaveLength(1);
}, 60_000);

type Shown = { width: number; device: number; points: number; coarse: boolean; y: number; zoom: number; taps: number; touches: number; cancels: number; fars: number };
type StreamFrame = { data: string; width: number; height: number; scrollX: number; scrollY: number; zoom: number };
type Contact = { id: number; x: number; y: number };
type Step = { kind: "start" | "move" | "end" | "cancel"; points: Contact[] };

const shown = async () => JSON.parse((await (await api(`/api/pages/${pageID}`)).json() as { page: { title: string } }).page.title) as Shown;
const pageInput = (body: unknown) => api(`/api/pages/${pageID}/input`, { method: "POST", body: JSON.stringify(body) });
const finger = (id: number, x: number, y: number): Contact => ({ id, x, y });
const open = (path: string) => run(first, `return await ox.web.browser.navigate({ purpose: "Open the test page", url: BASE + ${JSON.stringify(path)} });`);
const restarts = async () => (await readFile(join(data, "logs", "host.jsonl"), "utf8").catch(() => "")).split("\n").filter(line => line.includes("touch sequence restarted"));

async function until<T>(read: () => Promise<T>, check: (value: T) => boolean, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  for (let value = await read(); ; value = await read()) {
    if (check(value)) return value;
    if (Date.now() > deadline) throw new Error(`Timed out at ${JSON.stringify(value)}`);
    await Bun.sleep(50);
  }
}

async function settled() {
  let last = await shown();
  for (let still = 0; still < 4; still += 1) {
    await Bun.sleep(120);
    const next = await shown();
    if (next.y !== last.y || next.zoom !== last.zoom) still = -1;
    last = next;
  }
  return last;
}

async function later() {
  await Bun.sleep(250);
  return await shown();
}

function openStream(query: string) {
  const frames: StreamFrame[] = [];
  const controller = new AbortController();
  const reading = (async () => {
    const response = await api(`/api/pages/${pageID}/stream?${query}`, { signal: controller.signal });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader(), decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      for (let index = buffer.indexOf("\n\n"); index >= 0; index = buffer.indexOf("\n\n")) {
        const data = /^event: frame\ndata: (.*)$/s.exec(buffer.slice(0, index))?.[1];
        buffer = buffer.slice(index + 2);
        if (data) frames.push(JSON.parse(data) as StreamFrame);
      }
    }
  })().catch(() => {});
  return { frames, first: () => until(async () => frames[0], frame => !!frame).then(frame => frame!), close: async () => { controller.abort(); await reading; } };
}

function jpegSize(base64: string) {
  const bytes = Buffer.from(base64, "base64");
  for (let offset = 2; offset + 9 < bytes.length && bytes[offset] === 0xff; offset += 2 + bytes.readUInt16BE(offset + 2)) {
    if (bytes[offset + 1]! >= 0xc0 && bytes[offset + 1]! <= 0xc3) return { width: bytes.readUInt16BE(offset + 7), height: bytes.readUInt16BE(offset + 5) };
  }
  return undefined;
}

async function gesture(steps: Step[], every = 16, batch = 4) {
  const begin = performance.now();
  const events = steps.map((step, index) => ({ ...step, at: begin + index * every }));
  for (let index = 0; index < events.length; index += batch) {
    const chunk = events.slice(index, index + batch);
    const wait = chunk.at(-1)!.at - performance.now();
    if (wait > 0) await Bun.sleep(wait);
    const response = await pageInput({ type: "touch", sentAt: performance.now(), events: chunk });
    expect(response.status).toBe(200);
  }
}

test("A phone viewer gets the phone layout and native touch: momentum scrolling, taps, pinch and lifting one finger", async () => {
  await open("/plain");
  const at = performance.now(), one = [finger(0, 0.5, 0.5)];
  for (const body of [
    { type: "touch", sentAt: at, events: [] },
    { type: "touch", sentAt: at, events: Array.from({ length: 241 }, () => ({ kind: "move", at, points: one })) },
    { type: "touch", events: [{ kind: "start", at, points: one }] },
    { type: "touch", sentAt: at, events: [{ kind: "press", at, points: one }] },
    { type: "touch", sentAt: at, events: [{ kind: "start", points: one }] },
    { type: "touch", sentAt: at, events: [{ kind: "start", at, points: [finger(10, 0.5, 0.5)] }] },
    { type: "touch", sentAt: at, events: [{ kind: "start", at, points: [{ id: 0, x: "0.5", y: 0.5 }] }] },
    { type: "touch", sentAt: at, events: [{ kind: "start", at, points: Array.from({ length: 11 }, (_, id) => finger(id % 10, 0.5, 0.5)) }] },
    { type: "touch", sentAt: at, events: [{ kind: "start", at, points: [finger(1, 0.4, 0.5), finger(1, 0.6, 0.5)] }] },
  ]) expect((await pageInput(body)).status).toBe(400);
  expect(await until(shown, value => value.width === value.device)).toMatchObject({ points: 0, coarse: false, zoom: 1 });

  const phone = openStream("width=390&height=700&mobile=1");
  try {
    const opened = await phone.first();
    expect(opened).toMatchObject({ width: 390, height: 700, scrollY: 0 });
    expect(jpegSize(opened.data)).toEqual({ width: 390, height: 700 });
    expect(await until(shown, value => value.width === 980 && value.points === 10)).toMatchObject({ device: 390, coarse: true });
    expect((await later()).width).toBe(980);
    const thumbnail = await api(`/api/pages/${pageID}/snapshot`);
    expect(thumbnail.status).toBe(200);
    expect(thumbnail.headers.get("content-type")).toBe("image/jpeg");
    expect(jpegSize(Buffer.from(await thumbnail.arrayBuffer()).toString("base64"))).toEqual({ width: 390, height: 700 });
    expect((await later()).width).toBe(980);
    const shrunk = 390 / 980;
    await gesture([{ kind: "start", points: [finger(0, 800 * shrunk / 390, 650 * shrunk / 700)] }, { kind: "end", points: [] }], 60, 1);
    expect(await until(shown, value => value.fars === 1)).toMatchObject({ fars: 1, width: 980, y: 0 });

    await open("/long");
    expect(await until(shown, value => value.width === 390)).toMatchObject({ device: 390, points: 10, coarse: true, y: 0, zoom: 1, taps: 0, touches: 0 });
    const distance = 0.5 * 700;
    await gesture([{ kind: "start", points: [finger(0, 0.5, 0.8)] },
      ...Array.from({ length: 10 }, (_, step): Step => ({ kind: "move", points: [finger(0, 0.5, 0.8 - (step + 1) * 0.05)] })), { kind: "end", points: [] }]);
    const flung = await settled();
    expect(flung.touches).toBe(1);
    expect(flung.y).toBeGreaterThan(distance * 1.3);
    const scrolled = await until(async () => phone.frames.at(-1)!, frame => Math.abs(frame.scrollY - flung.y) <= 2);
    expect(scrolled).toMatchObject({ width: 390, height: 700, zoom: 1 });
    expect(jpegSize(scrolled.data)).toEqual({ width: 390, height: 700 });

    await gesture([{ kind: "start", points: [finger(0, 70 / 390, 40 / 700)] }, { kind: "end", points: [] }], 60, 1);
    expect(await until(shown, value => value.taps === 1)).toMatchObject({ taps: 1, touches: 2, y: flung.y });

    const begin = performance.now() - 1_500;
    const slow = [{ kind: "start", at: begin, points: [finger(0, 0.5, 0.8)] },
      ...Array.from({ length: 25 }, (_, step) => ({ kind: "move", at: begin + (step + 1) * 40, points: [finger(0, 0.5, 0.8 - (step + 1) * 0.02)] })),
      { kind: "end", at: begin + 26 * 40 + 300, points: [] }];
    expect((await pageInput({ type: "touch", sentAt: performance.now(), events: slow })).status).toBe(200);
    const held = await settled();
    expect(held.y - flung.y).toBeGreaterThan(distance * 0.75);
    expect(held.y - flung.y).toBeLessThan(distance * 1.2);

    await gesture([{ kind: "start", points: [finger(0, 0.35, 0.5)] }, { kind: "start", points: [finger(0, 0.35, 0.5), finger(1, 0.65, 0.5)] },
      ...Array.from({ length: 10 }, (_, step): Step => ({ kind: "move", points: [finger(0, 0.35 - (step + 1) * 0.02, 0.5), finger(1, 0.65 + (step + 1) * 0.02, 0.5)] })),
      { kind: "end", points: [finger(1, 0.85, 0.5)] },
      ...Array.from({ length: 4 }, (_, step): Step => ({ kind: "move", points: [finger(1, 0.85 - (step + 1) * 0.05, 0.5)] })), { kind: "end", points: [] }]);
    const pinched = await settled();
    expect(pinched.zoom).toBeGreaterThan(1.6);
    expect(pinched.zoom).toBeLessThan(2.6);
    expect(pinched).toMatchObject({ taps: 1, touches: 5 });
    expect((await until(async () => phone.frames.at(-1)!, frame => Math.abs(frame.zoom - pinched.zoom) < 0.05)).zoom).toBeGreaterThan(1.5);
    const zoomed = await api(`/api/pages/${pageID}/snapshot`);
    expect(jpegSize(Buffer.from(await zoomed.arrayBuffer()).toString("base64"))).toEqual({ width: 390, height: 700 });
    expect(await later()).toMatchObject({ zoom: pinched.zoom, y: pinched.y });
    await gesture([{ kind: "start", points: [finger(0, 0.5, 0.5)] }], 16, 1);
    expect(await until(shown, value => value.touches === 6)).toMatchObject({ cancels: 0 });
  } finally { await phone.close(); }
  expect(await until(shown, value => value.points === 0)).toMatchObject({ width: 390, coarse: false, touches: 6, cancels: 1 });
  await open("/plain");
  expect(await until(shown, value => value.width === 390)).toMatchObject({ device: 390, points: 0, coarse: false, zoom: 1 });
  expect((await pageInput({ type: "reload" })).status).toBe(200);
  expect(await later()).toMatchObject({ width: 390, device: 390, points: 0, coarse: false, zoom: 1 });
  await Bun.sleep(200);
  expect(await restarts()).toEqual([]);
}, 90_000);

test("Dense touch input keeps up: a 120 Hz drag sent as the app sends it is dispatched in time and scrolls by its distance", async () => {
  await open("/long");
  const phone = openStream("width=390&height=700&mobile=1");
  try {
    await phone.first();
    await until(shown, value => value.points === 10 && value.width === 390);
    const before = await settled();
    const begin = performance.now() + 50, distance = 0.8 * 700;
    const events = [{ kind: "start", at: begin, points: [finger(0, 0.5, 0.9)] },
      ...Array.from({ length: 250 }, (_, step) => ({ kind: "move", at: begin + (step + 1) * 8, points: [finger(0, 0.5, 0.9 - (step + 1) * 0.8 / 250)] })),
      { kind: "end", at: begin + 251 * 8 + 300, points: [] }];
    let index = 0, requests = 0;
    while (index < events.length) {
      let count = 0;
      while (index + count < events.length && count < 200 && events[index + count]!.at <= performance.now()) count += 1;
      if (!count) { await Bun.sleep(Math.max(1, events[index]!.at - performance.now())); continue; }
      requests += 1;
      expect((await pageInput({ type: "touch", sentAt: performance.now(), events: events.slice(index, index + count) })).status).toBe(200);
      index += count;
    }
    expect(performance.now() - events.at(-1)!.at).toBeLessThan(400);
    expect(requests).toBeLessThan(events.length);
    const after = await settled();
    expect(after.y - before.y).toBeGreaterThan(distance * 0.8);
    expect(after.y - before.y).toBeLessThan(distance * 1.2);
  } finally { await phone.close(); }
  expect(await restarts()).toEqual([]);
}, 60_000);

test("A thumbnail taken as phone mode starts doesn't leave the phone on the desktop layout", async () => {
  await open("/plain");
  for (let round = 0; round < 4; round += 1) {
    expect(await until(shown, value => value.width === value.device && value.points === 0)).toMatchObject({ coarse: false });
    const thumbnail = api(`/api/pages/${pageID}/snapshot`);
    const phone = openStream("width=390&height=700&mobile=1");
    try {
      expect((await thumbnail).status).toBe(200);
      await phone.first();
      expect(await until(shown, value => value.width === 980 && value.points === 10)).toMatchObject({ device: 390 });
      expect(await later()).toMatchObject({ width: 980, device: 390 });
    } finally { await phone.close(); }
  }
}, 90_000);

test("Viewers share the page: phone mode survives a resize, a desktop viewer, a second phone leaving and a rotation, and touch from a desktop viewer ends with its stream", async () => {
  await open("/plain");
  const streams: ReturnType<typeof openStream>[] = [];
  const watch = (query: string) => { const stream = openStream(query); streams.push(stream); return stream; };
  try {
    const phone = watch("width=390&height=700&mobile=1");
    await phone.first();
    expect(await until(shown, value => value.width === 980 && value.points === 10)).toMatchObject({ device: 390, coarse: true });
    const wide = watch("width=500&height=700");
    expect(await wide.first()).toMatchObject({ width: 500, height: 700 });
    expect(await until(shown, value => value.device === 500)).toMatchObject({ width: 980, points: 10 });
    expect(await later()).toMatchObject({ width: 980, device: 500 });
    const half = 500 / 980;
    expect((await pageInput({ type: "tap", x: 800 * half / 500, y: 650 * half / 700 })).status).toBe(200);
    expect(await until(shown, value => value.fars === 1)).toMatchObject({ width: 980, device: 500, fars: 1 });
    await wide.close();
    await Bun.sleep(300);
    expect(await shown()).toMatchObject({ width: 980, device: 500, points: 10, coarse: true });
    const tablet = watch("width=500&height=700&mobile=1");
    await tablet.first();
    await tablet.close();
    await Bun.sleep(300);
    expect(await shown()).toMatchObject({ width: 980, device: 500, points: 10, coarse: true });
    const rotated = watch("width=700&height=480&mobile=1");
    await phone.close();
    expect(await rotated.first()).toMatchObject({ width: 700, height: 480 });
    expect(await until(shown, value => value.device === 700)).toMatchObject({ width: 980, points: 10, coarse: true });
    expect(await later()).toMatchObject({ width: 980, device: 700, points: 10 });
  } finally {
    for (const stream of streams) await stream.close();
  }
  expect(await until(shown, value => value.width === 700)).toMatchObject({ device: 700, points: 0, coarse: false, zoom: 1 });

  const laptop = openStream("width=500&height=700");
  try {
    const frame = await laptop.first();
    expect(frame).toMatchObject({ width: 500, height: 700, zoom: 1 });
    expect(jpegSize(frame.data)).toEqual({ width: 500, height: 700 });
    await gesture([{ kind: "start", points: [finger(0, 70 / 500, 40 / 700)] }, { kind: "end", points: [] }], 60, 1);
    expect(await until(shown, value => value.taps === 1)).toMatchObject({ width: 500, points: 10, taps: 1, touches: 1 });
  } finally { await laptop.close(); }
  expect(await until(shown, value => value.points === 0)).toMatchObject({ width: 500, coarse: false, taps: 1 });
  expect(await restarts()).toEqual([]);
}, 90_000);

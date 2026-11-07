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

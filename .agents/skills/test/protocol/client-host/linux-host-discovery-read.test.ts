import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { Host } from "../../../../../apps/linux/src/host";
import { startServer } from "../../../../../apps/linux/src/server";
import { reviewJourney } from "./fixtures/identity-space-review";

const prompt = "Publish the Meridian notice to Feed and the comparison suggestion to Ideas for this local reading check.";
const source = { name: "Meridian circular", url: "https://meridian.example.invalid/circular" };
const note = { name: "Meridian tide-table notice", body: "The harbour circular lists two reading sessions on Thursday.", icon: "📘", sources: [source] };
const idea = { name: "Compare the two reading sessions", body: "Make a short checklist before choosing a session.", icon: "💡", action: "Help me outline that checklist." };
const draft = "Keep my unsent question about the Thursday sessions.";
const hash = (value: unknown) => new Bun.CryptoHasher("sha256").update(JSON.stringify(value)).digest("hex");

function publisher() {
  let calls = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    if (new URL(req.url).pathname === "/v1/models") return Response.json({ data: [{ id: "fixture" }] });
    if (new URL(req.url).pathname !== "/v1/chat/completions") return new Response(null, { status: 404 });
    calls++;
    const { messages } = await req.json() as { messages: { role: string; content: unknown }[] };
    const user = messages.findLastIndex(m => m.role === "user");
    if (!JSON.stringify(messages[user]?.content).includes(prompt)) return new Response(null, { status: 400 });
    const done = messages.slice(user + 1).some(m => m.role === "tool");
    const code = `await ox.feed.publish(${JSON.stringify({ purpose: "Publish the requested Meridian note", items: [note] })});
return await ox.idea.publish(${JSON.stringify({ purpose: "Publish the requested comparison suggestion", items: [idea] })});`;
    const delta = done ? { content: "The requested local publication step has finished." } : { tool_calls: [{ index: 0, id: "call_meridian",
      type: "function", function: { name: "execute", arguments: JSON.stringify({ purpose: "Save the two requested records", source: code }) } }] };
    const chunk = (delta: object, finish_reason: string | null) => `data: ${JSON.stringify({ id: "meridian", object: "chat.completion.chunk",
      created: 0, model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    return new Response(chunk({ role: "assistant", ...delta }, null) + chunk({}, done ? "stop" : "tool_calls") + "data: [DONE]\n\n",
      { headers: { "content-type": "text/event-stream" } });
  } });
  return { server, calls: () => calls };
}

function records(host: Host) {
  const db = new Database(join(host.paths.profiles, host.profile.id, "state/state.sqlite"), { readonly: true });
  try {
    const revisions = db.query(`SELECT r.* FROM document_revisions r JOIN documents d ON r.document_id=d.id
      WHERE json_extract(d.record,'$.kind')='ox.discovery' ORDER BY r.document_id,r.seq`).all();
    expect(revisions.length).toBeGreaterThan(0);
    return { discovery: hash(revisions), documents: hash(db.query("SELECT * FROM document_revisions ORDER BY document_id,seq").all()),
      messages: hash(db.query("SELECT * FROM entries ORDER BY id").all()),
      conversations: hash(db.query("SELECT * FROM conversations ORDER BY id").all()), submissions: hash(db.query("SELECT * FROM submissions ORDER BY id").all()) };
  } finally { db.close(); }
}

test("J10 FI-01/05/06: failed passive Feed and Ideas reads keep recoverable content read-only; retry reads the original owner", async () => {
  const data = join(process.cwd(), `.discovery-read-${crypto.randomUUID()}`), model = publisher(), native = globalThis.fetch;
  const modelOrigin = `http://127.0.0.1:${model.server.port}`, allowed = new Set([modelOrigin]), outside: string[] = [], writes: string[] = [];
  const flags = { OPENOX_PERSONAL_AGENT: "1", OPENOX_MUSE_PARITY: "1", OPENOX_PROACTIVE_AGENT: "0", OPENOX_EVIDENCE_ONLY: "0",
    OPENOX_PUBLIC_LOOKUP: "0", OPENOX_VERTEX_ADC: "0", OPENOX_MEDIA_URL: `${modelOrigin}/media`, OX_HOST_TEST_ORIGINS: modelOrigin };
  const previous = Object.fromEntries(Object.keys(flags).map(k => [k, process.env[k]]));
  const { chromium } = await import(Bun.resolveSync("playwright-core", join(import.meta.dir, "../../../../../apps/linux"))) as typeof import("../../../../../apps/linux/node_modules/playwright-core");
  let host: Host | undefined, server: Awaited<ReturnType<typeof startServer>> | undefined, browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    await mkdir(data); Object.assign(process.env, flags);
    globalThis.fetch = Object.assign((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (!allowed.has(url.origin)) { outside.push(url.origin); throw new Error("Non-fixture origin blocked"); }
      return native(input, init);
    }, { preconnect: native.preconnect });
    const options = { data, hostID: "Meridian discovery fixture", version: "test", quiet: true };
    host = await Host.open(options);
    await host.setCustomProvider({ name: "Meridian fixture", baseUrl: `${modelOrigin}/v1`, models: ["fixture"] });
    server = await startServer(host, { hostname: "127.0.0.1", port: 0 });
    const base = `http://127.0.0.1:${server.port}`; allowed.add(base);
    const { token } = await host.devices.add("Local observer", "cli");
    const api = async (path: string, method = "GET", body?: object) => {
      const res = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body && JSON.stringify(body) });
      if (!res.ok) throw new Error(`Fixture ${method} ${path}: ${res.status}`);
      return res.json();
    };
    await api("/api/settings/default-model", "PUT", { provider: "custom", modelId: "fixture" });
    browser = await chromium.launch();
    const paired = await browser.newPage({ viewport: { width: 1285, height: 736 }, colorScheme: "dark", serviceWorkers: "block" });
    paired.setDefaultTimeout(6500);
    await paired.route("**/*", r => {
      const origin = new URL(r.request().url()).origin;
      if (origin === base) return r.continue();
      outside.push(origin); return r.abort();
    });
    const { code } = await api("/api/devices/pairing", "POST");
    await paired.goto(base); await paired.getByTestId("pair-code").fill(code); await paired.getByTestId("pair-name").fill("Meridian reader");
    await paired.getByTestId("pair-submit").click(); await paired.getByTestId("onboarding-start").click();
    const emptyClaims = [];
    for (const kind of ["feed", "ideas"] as const) {
      await paired.getByTestId(`muse-${kind}`).click(); await paired.getByTestId("discovery-empty").waitFor();
      const pattern = `**/api/${kind}?**`; await paired.route(pattern, r => r.abort("failed"));
      await paired.getByTestId("discovery-menu").click(); await paired.getByTestId("discovery-refresh").click();
      await paired.getByTestId("discovery-read-error").waitFor(); emptyClaims.push(await paired.getByTestId("discovery-empty").count());
      await paired.unroute(pattern); await paired.getByTestId("discovery-retry").press("Enter");
      await paired.getByTestId("discovery-read-error").waitFor({ state: "hidden" });
      await paired.getByTestId("discovery-empty").waitFor();
    }
    expect(await host.profile.discovery.contentEmpty()).toBe(true); expect(model.calls()).toBe(0);
    await paired.getByTestId("muse-chat").click();
    const input = paired.getByTestId("composer-input"); await input.fill(prompt); await paired.getByTestId("send").click();
    const approval = paired.getByTestId("pending-approval");
    for (const expected of ["Feed", "Idea"]) {
      await approval.filter({ hasText: expected }).getByTestId("approval-approve").click();
    }
    await paired.getByText("The requested local publication step has finished.", { exact: true }).waitFor();
    const { page, capture, finish } = await reviewJourney(paired, "openox-discovery");
    page.setDefaultTimeout(6500);
    await page.route("**/*", r => {
      const origin = new URL(r.request().url()).origin;
      if (origin === base) return r.fallback();
      outside.push(origin); return r.abort();
    });
    await page.routeWebSocket(url => url.origin !== base.replace("http:", "ws:"), ws => { outside.push(ws.url()); ws.close(); });
    const ids = { feed: (await host.profile.discovery.list("feed"))[0]!.id, ideas: (await host.profile.discovery.list("ideas"))[0]!.id };
    const receipts = (await host.profile.approvalHistory.list()).map(({ id, action, decision, scope, conversationId }) => ({ id, action, decision, scope, conversationId }));
    expect(receipts.map(r => r.action).sort()).toEqual(["ox.feed.publish", "ox.idea.publish"]);
    expect(receipts.every(r => r.decision === "approved" && r.scope === "once")).toBe(true);
    expect(model.calls()).toBe(2);
    const mainDraft = "Unsent Main reading note";
    await page.getByTestId("composer-input").fill(mainDraft);
    const snapshot = async () => ({ ...records(host!), preferences: hash(host!.settings), permissions: hash(await api("/api/permissions")),
      feed: await api("/api/feed?includeHidden=true"), ideas: await api("/api/ideas?includeHidden=true"), approvals: await host!.profile.approvalHistory.list() });
    const original = await snapshot();
    expect(original.feed.generation).toBeNull(); expect(original.ideas.generation).toBeNull();
    page.on("request", r => { const path = new URL(r.url()).pathname; if (path.startsWith("/api/") && r.method() !== "GET") writes.push(`${r.method()} ${path}`); });
    const observations = [], reads: string[] = [];
    for (const kind of ["feed", "ideas"] as const) {
      if (kind === "ideas") await page.setViewportSize({ width: 390, height: 844 });
      const item = page.getByTestId(`discovery-item-${ids[kind]}`), retry = page.getByTestId("discovery-retry"), menu = page.getByTestId("discovery-menu");
      const error = page.getByTestId("discovery-read-error"), empty = page.getByTestId("discovery-empty");
      let fault = 503;
      await page.route(`**/api/${kind}?**`, r => {
        reads.push(`${r.request().method()} ${kind} ${fault || "owner"}`);
        return fault ? r.fulfill({ status: fault, json: { error: fault === 403 ? "Reading is not permitted." : "The reading shelf is temporarily unavailable." } }) : r.continue();
      });
      await page.goto(`${base}/#/${kind}`); await error.waitFor();
      expect(await item.count()).toBe(0); expect(await empty.count()).toBe(0);
      await capture(`${kind}-first-failure`);
      fault = 0; await retry.press("Enter"); await item.waitFor();
      expect(await item.innerText()).toContain(kind === "feed" ? note.name : idea.name);
      if (kind === "feed") expect(await item.getByRole("link", { name: source.name }).getAttribute("href")).toBe(source.url);
      await capture(`${kind}-original`);
      const side = page.getByTestId("space-context-chat"), editor = side.getByTestId("composer-input"), discuss = page.getByTestId(`discovery-discuss-${ids[kind]}`);
      await discuss.click(); await editor.fill(draft); await side.getByTestId("space-context-close").click();
      const refresh = async () => { await menu.click(); await page.getByTestId("discovery-refresh").click(); await error.waitFor(); };
      fault = 503; await refresh(); await retry.focus();
      const stale = await error.innerText(); await capture(`${kind}-stale`);
      expect(await item.isVisible()).toBe(true); expect(await empty.count()).toBe(0);
      const itemMenu = page.getByTestId(`discovery-item-menu-${ids[kind]}`);
      const actions = [itemMenu, discuss, ...(kind === "feed" ? [page.getByTestId("feed-prompt-edit"), page.getByTestId("feed-generate"), page.getByTestId(`feed-love-${ids.feed}`)] : [])];
      const disabled = await Promise.all(actions.map(control => control.isDisabled()));
      await menu.click(); const menuGenerate = await page.getByTestId("discovery-generate-more").count(); await page.keyboard.press("Escape");
      fault = 0;
      const gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
      await page.route(`**/api/${kind}?**`, async r => { entered.resolve(); await gate.promise; await r.fallback(); }, { times: 1 });
      await retry.press("Enter"); await entered.promise;
      const retryLocked = await retry.isDisabled(); gate.resolve();
      await error.waitFor({ state: "hidden" }); await item.waitFor();
      const focus = await page.evaluate(() => (document.activeElement as HTMLElement)?.dataset.testid);
      await capture(`${kind}-recovered`); expect(await discuss.isEnabled()).toBe(true);
      await discuss.click(); expect(await editor.inputValue()).toBe(draft); await side.getByTestId("space-context-close").click();
      fault = 403; await refresh(); const exposedAfterDenial = await item.count();
      fault = 0; await retry.press("Enter"); await error.waitFor({ state: "hidden" }); await item.waitFor();
      observations.push({ kind, markedStale: /out of date/i.test(stale), locked: disabled.every(Boolean), menuGenerate, retryLocked, focus, exposedAfterDenial });
      expect(await snapshot()).toEqual(original);
    }
    await page.goto(`${base}/#/main`); expect(await page.getByTestId("composer-input").inputValue()).toBe(mainDraft);
    await finish();
    const port = server.port; server.stop(true); await host.close();
    host = await Host.open(options); server = await startServer(host, { hostname: "127.0.0.1", port });
    expect(await snapshot()).toEqual(original);
    expect(writes).toEqual([]); expect(outside).toEqual([]); expect(model.calls()).toBe(2);
    for (const kind of ["feed", "ideas"]) {
      const statuses = reads.filter(r => r.includes(` ${kind} `));
      expect(statuses.filter((r, i) => r !== statuses[i - 1])).toEqual([503, "owner", 503, "owner", 403, "owner"].map(outcome => `GET ${kind} ${outcome}`));
    }
    const proof = { scope: "controlled loopback; browser-injected list faults; no Muse failure reference", ids, receipts, document: original.discovery, documents: original.documents,
      messages: original.messages, submissions: original.submissions, conversations: original.conversations, preferences: original.preferences,
      permissions: original.permissions, unchangedAfterRestart: true, setupModelCalls: 2, passiveModelCalls: 0, outside, writes, reads, emptyClaims, observations };
    if (process.env.OPENOX_TEST_ARTIFACTS) await Bun.write(join(process.env.OPENOX_TEST_ARTIFACTS, "openox-discovery-proof.json"), JSON.stringify(proof, null, 2));
    expect({ emptyClaims, observations }).toEqual({ emptyClaims: [0, 0], observations: ["feed", "ideas"].map(kind =>
      ({ kind, markedStale: true, locked: true, menuGenerate: 0, retryLocked: true, focus: "discovery-menu", exposedAfterDenial: 0 })) });
  } finally {
    await browser?.close(); server?.stop(true); await host?.close(); model.server.stop(true); globalThis.fetch = native;
    for (const [k, v] of Object.entries(previous)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await rm(data, { recursive: true, force: true });
  }
}, 90_000);

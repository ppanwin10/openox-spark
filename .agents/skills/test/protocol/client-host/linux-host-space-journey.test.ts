import { expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { Host } from "../../../../../apps/linux/src/host";
import { startServer } from "../../../../../apps/linux/src/server";
import type { Space } from "../../../../../packages/agent/src/adapters/linux/library-contracts";
import { reviewJourney } from "./fixtures/identity-space-review";

const title = "Courtside Almanac";
const entry = "artifacts/courtside-almanac.html";
const create = `Build a tennis Space called ${title} with a practice-card toggle. It should work offline.`;
const change = "Add a clay-court footwork drill to that same Space. Keep the practice card.";
const drill = "Split-step at the baseline, then recover to the middle.";
const doc = `<!doctype html><html lang="en"><title>${title}</title><main><h1>${title}</h1><details><summary>Practice card</summary><p>Alternate five forehands and five backhands.</p></details></main></html>`;
const resultText = (data: unknown): string => typeof data === "string" ? data : Array.isArray(data)
  ? data.map(part => typeof part?.text === "string" ? part.text : "").join("\n") : "";
type Msg = { role: string; content: unknown };

function provider() {
  const turns: string[] = [];
  const authorGuidance: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    if (new URL(req.url).pathname === "/v1/models") return Response.json({ data: [{ id: "fixture" }] });
    const { messages, tools } = await req.json() as { messages: Msg[]; tools: { function: { name: string } }[] };
    if (!turns.length) authorGuidance.push(...messages.filter(m => m.role === "system").map(m => resultText(m.content)));
    const i = messages.findLastIndex(m => m.role === "user"), user = resultText(messages[i]?.content);
    const outputs = messages.slice(i + 1).filter(m => m.role === "tool").map(m => resultText(m.content));
    const last = outputs.at(-1) ?? "";
    const original = messages.slice(0, i).filter(m => m.role === "tool").map(m => resultText(m.content)).filter(s => s.startsWith("{"))
      .map(s => (JSON.parse(s) as { space?: Space }).space).find(s => s?.name === title && s.entryPath === entry);
    const source = !outputs.length && user.includes(create) ? `await ox.fs.write({purpose:"Write the offline practice card",path:${JSON.stringify("/" + entry)},content:${JSON.stringify(doc)}});
await ox.fs.write({purpose:"Draw a clay practice notebook",path:${JSON.stringify("/" + journalIcon)},content:${JSON.stringify(iconFiles[journalIcon])}});
return await ox.space.create({purpose:"Register the requested tennis Space",name:${JSON.stringify(title)},entryPath:${JSON.stringify(entry)},iconPath:${JSON.stringify(journalIcon)}});`
      : !outputs.length && user.includes(change) && original?.entryPath
        ? `return await ox.fs.edit({purpose:"Customize the same practice card",path:${JSON.stringify("/" + original.entryPath)},edits:[{oldText:"</main>",newText:${JSON.stringify(`<h2>Clay-court drill</h2><p>${drill}</p></main>`)} }]});`
        : undefined;
    const useTool = !!source && tools.some(t => t.function.name === "execute");
    const text = last.includes('"space"') && last.includes(entry) ? "The Space is registered."
      : last.includes(entry) && user.includes(change) ? "The drill was added to the existing card."
      : "I do not have a completed Space change to report.";
    const delta = useTool ? { tool_calls: [{ index: 0, id: `call_${crypto.randomUUID()}`, type: "function",
      function: { name: "execute", arguments: JSON.stringify({ purpose: "Work on the requested tennis Space", source }) } }] } : { content: text };
    const chunk = (delta: object, finish_reason: string | null) => `data: ${JSON.stringify({ id: "tennis", object: "chat.completion.chunk", created: 0, model: "fixture",
      choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    turns.push(user.includes(change) ? "change" : user.includes(create) ? "create" : "other");
    return new Response(chunk({ role: "assistant", ...delta }, null) + chunk({}, useTool ? "tool_calls" : "stop") + "data: [DONE]\n\n",
      { headers: { "content-type": "text/event-stream" } });
  } });
  return { server, turns, authorGuidance };
}

type SpacePage = import("../../../../../apps/linux/node_modules/playwright-core").Page;
async function withReviewSpace(html: string, review: (page: SpacePage, write: (html: string) => Promise<void>, space: Space) => Promise<void>,
  draft: { name: string; placement?: "sidebar"; iconPath?: string } = { name: "Practice" }, artwork: Record<string, string> = {},
  engine: "chromium" | "webkit" = "chromium") {
  const data = join(process.cwd(), `.space-journey-${crypto.randomUUID()}`);
  await mkdir(data);
  const flags = { OPENOX_PERSONAL_AGENT: "1", OPENOX_MUSE_PARITY: "1", OPENOX_MEDIA_URL: "http://127.0.0.1:9" };
  const before = Object.fromEntries(Object.keys(flags).map(key => [key, process.env[key]])); Object.assign(process.env, flags);
  const browsers = await import(Bun.resolveSync("playwright-core", join(import.meta.dir, "../../../../../apps/linux"))) as typeof import("../../../../../apps/linux/node_modules/playwright-core");
  let host: Host | undefined, server: Awaited<ReturnType<typeof startServer>> | undefined, browser: Awaited<ReturnType<typeof browsers.chromium.launch>> | undefined;
  try {
    host = await Host.open({ data, hostID: "Space tabs", version: "test", quiet: true });
    server = await startServer(host, { hostname: "127.0.0.1", port: 0 }); const base = `http://127.0.0.1:${server.port}`;
    const { token } = await host.devices.add("Layout setup", "cli"), path = "artifacts/practice.html", headers = { authorization: `Bearer ${token}` };
    const write = async (body: string) => {
      expect((await fetch(`${base}/api/files/content?path=${path}&overwrite=1`, { method: "PUT", headers, body })).status).toBe(201);
    };
    await write(html);
    for (const [path, body] of Object.entries(artwork)) {
      expect((await fetch(`${base}/api/files/content?path=${encodeURIComponent(path)}`, { method: "PUT", headers, body })).status).toBe(201);
    }
    const res = await fetch(`${base}/api/spaces`, { method: "POST", headers: { ...headers, "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify({ ...draft, entryPath: path }) }); expect(res.status).toBe(201);
    const { space } = await res.json() as { space: Space };
    browser = await browsers[engine].launch(); const page = await browser.newPage({ viewport: { width: 375, height: 812 }, hasTouch: true, serviceWorkers: "block" });
    await page.route("**/*", r => new URL(r.request().url()).origin === base ? r.continue() : r.abort());
    await page.goto(base); await page.getByTestId("pair-code").fill((await host.devices.createPairingCode()).code); await page.getByTestId("pair-name").fill("Layout reader");
    await page.getByTestId("pair-submit").tap(); await page.getByTestId("onboarding-start").tap();
    await page.goto(`${base}/#/spaces/${space.id}`); await review(page, write, space);
  } finally {
    await browser?.close(); server?.stop(true); await host?.close();
    for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(data, { recursive: true, force: true });
  }
}

const courtIcon = "artifacts/court.svg", journalIcon = "artifacts/journal.svg";
const iconFiles = {
  [courtIcon]: '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48"><title>Courtside flip score</title><rect x="2" y="8" width="44" height="33" rx="6" fill="#164f41" stroke="#bdd9a3" stroke-width="2"/><path d="M24 9v30" stroke="#9bc2a4" stroke-width="2"/><path d="M17 17h-7v7h7v7h-7m20-14h7v14h-7z" fill="none" stroke="#fff5ce" stroke-width="3" stroke-linejoin="round"/><circle cx="40" cy="8" r="6" fill="#dfed55" stroke="#42572c" stroke-width="2"/></svg>',
  [journalIcon]: '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 48 48"><title>Clay court practice notes</title><path d="M10 5h24q4 0 4 4v33H11q-5 0-5-5V11q0-6 4-6Z" fill="#a74732" stroke="#e3b492" stroke-width="2"/><path d="M14 6v32M20 16h10m-10 6h7M10 38h25" fill="none" stroke="#ffe8bf" stroke-width="3" stroke-linecap="round"/><path d="m26 34 11-18 5 3-12 17-6 3z" fill="#fed275" stroke="#623224" stroke-width="2" stroke-linejoin="round"/></svg>',
};
for (const [engine, width, height, theme] of [["chromium", 1285, 736, "dark"], ["webkit", 375, 812, "light"]] as const)
test(`LS-06 ${engine} changes scoreboard artwork to journal artwork without changing Agent identity`, () => withReviewSpace("<h1>Tour results</h1>", async (page, _write, space) => {
  await page.setViewportSize({ width, height }); await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
  const capture = async (stage: string) => {
    if (process.env.OPENOX_TEST_ARTIFACTS) await page.screenshot({ path: join(process.env.OPENOX_TEST_ARTIFACTS, `artwork-${width}-${stage}.png`), animations: "disabled" });
  };
  expect(space).toMatchObject({ name: "Tennis World", iconPath: courtIcon });
  const pin = page.getByTestId(`muse-pinned-space-${space.id}`), card = page.getByTestId(`library-space-${space.id}`);
  const route = `/api/spaces/${space.id}`, writes: unknown[] = [];
  page.on("request", req => { if (new URL(req.url()).pathname === route && req.method() === "PATCH") writes.push(req.postDataJSON()); });
  const edit = async () => { await page.getByTestId(`library-space-menu-${space.id}`).press("Enter"); await page.getByTestId("space-menu-edit").press("Enter"); };
  const choose = page.getByTestId("space-icon-path");
  const save = async () => { await page.getByTestId("space-save").press("Enter"); await page.getByTestId("space-editor").waitFor({ state: "hidden" }); };
  const decoded = async (width: number) => {
    for (const owner of [pin, card]) {
      const image = owner.locator("img"); await image.waitFor();
      expect(await image.evaluate(async el => { if (!(el instanceof HTMLImageElement)) throw new Error("No icon image"); await el.decode(); return el.naturalWidth; })).toBe(width);
    }
  };
  const identity = () => page.evaluate(async () => (await (await fetch("/api/identity")).json()).agent);
  const before = await identity(); await page.getByTestId("space-back").press("Enter"); await decoded(48);
  await capture("scoreboard");
  expect(await pin.getAttribute("aria-label")).toBe(space.name);
  expect(await pin.evaluate(el => el.getBoundingClientRect().width >= 44 && el.getBoundingClientRect().height >= 44)).toBe(true);
  await edit(); await choose.selectOption(journalIcon); await choose.selectOption(courtIcon); await save(); expect(writes).toEqual([]);
  await edit(); await choose.selectOption(journalIcon); await page.getByTestId("space-editor-cancel").press("Enter");
  await page.getByRole("button", { name: "Discard", exact: true }).press("Enter"); await page.getByTestId("space-editor").waitFor({ state: "hidden" }); expect(writes).toEqual([]);
  await edit(); await choose.selectOption(journalIcon); await page.getByTestId("space-name").fill("Tennis journal"); await capture("editor"); await save();
  expect(writes).toEqual([{ expectedRevision: 1, name: "Tennis journal", iconPath: journalIcon }]);
  await page.reload(); await decoded(32); expect(await pin.getAttribute("aria-label")).toBe("Tennis journal"); await capture("journal");
  const fresh = await page.evaluate(async url => (await fetch(url)).json(), route);
  expect(fresh).toMatchObject({ id: space.id, fileId: space.fileId, entryPath: space.entryPath, placement: "sidebar", iconPath: journalIcon, revision: 2 });
  await edit(); await choose.selectOption(""); await save(); await card.locator("svg").waitFor();
  expect(await identity()).toEqual(before);
  await pin.press("Enter"); await page.frameLocator('[data-testid="space-canvas"] iframe').getByRole("heading", { name: "Tour results" }).waitFor();
}, { name: "Tennis World", placement: "sidebar", iconPath: courtIcon }, iconFiles, engine), 45_000);

test("LS-06 compact Space management keeps every primary tab visible without a sideways swipe", () => withReviewSpace("<h1>Practice</h1>", async page => {
  await page.getByTestId("space-manage").tap(); await page.getByTestId("space-placement").waitFor();
  const tabs = page.getByTestId("space-manager").getByRole("tablist");
  for (const width of [375, 320, 768]) {
    await page.setViewportSize({ width, height: 812 });
    const sizes = await tabs.evaluate(nav => [...nav.querySelectorAll("button")].map(b => {
      const r = b.getBoundingClientRect(), bounds = nav.getBoundingClientRect(); return { inside: r.left >= bounds.left && r.right <= bounds.right + 1, height: r.height };
    }));
    expect(sizes).toHaveLength(4); expect(sizes.every(r => r.inside && r.height >= 44)).toBe(true);
    await page.getByTestId("space-tab-updates").tap(); await page.getByTestId("space-updates-empty").waitFor();
    await page.getByTestId("space-tab-placement").tap(); await page.getByTestId("space-placement").waitFor();
  }
}), 45_000);

test("LS-06 a Space with a failed startup reports it without hiding the original page", () => withReviewSpace(
  "<h1>Practice</h1><script>localStorage.getItem('practice');document.body.append('Ready')</script>", async (page, write) => {
    const canvas = page.getByTestId("space-canvas"), frame = canvas.frameLocator("iframe"), warning = canvas.getByRole("alert");
    await frame.getByRole("heading", { name: "Practice" }).waitFor();
    expect(await frame.getByText("Ready", { exact: true }).count()).toBe(0);
    await warning.waitFor({ timeout: 2500 });
    expect(await warning.innerText()).toContain("didn’t finish loading");
    expect(await frame.getByRole("heading", { name: "Practice" }).isVisible()).toBe(true);
    await write("<h1>Practice</h1><p>Ready</p>");
    await page.getByTestId("space-refresh").tap();
    await frame.getByText("Ready", { exact: true }).waitFor();
    expect(await warning.isVisible()).toBe(false);
  }), 45_000);

test("a registered Space refreshes a declared public page without a provider account", async () => {
  let body = "North Court: 4–2", reads = 0, responseStatus = 200;
  const site = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    expect(new URL(request.url).pathname).toBe("/bulletin"); expect(request.method).toBe("GET");
    expect(request.headers.get("cookie")).toBeNull(); expect(request.headers.get("authorization")).toBeNull();
    reads++;
    return new Response(`<html><title>Bulletin</title><article><p>${body}</p></article></html>`,
      { status: responseStatus, headers: { "content-type": "text/html", ...(responseStatus === 302 ? { location: "/other" } : {}) } });
  } });
  const origin = `http://127.0.0.1:${site.port}`, previous = process.env.OX_HOST_TEST_ORIGINS, lookup = process.env.OPENOX_PUBLIC_LOOKUP;
  process.env.OPENOX_PUBLIC_LOOKUP = "1";
  process.env.OX_HOST_TEST_ORIGINS = origin;
  const html = `<meta name="ox-public-source" data-slot="board" content="${origin}/bulletin">
    <button>Refresh</button><output>Unread</output><script>document.querySelector('button').onclick=async()=>{
      const out=document.querySelector('output');try{const r=await ox.space.source.read({purpose:'Read the public bulletin',slot:'board'});out.textContent=r.text+' @ '+r.url+' '+r.readAt;}
      catch(e){out.textContent=e.code||e.message;}};</script>`;
  try {
    await withReviewSpace(html, async page => {
      const frame = page.frameLocator('[data-testid="space-canvas"] iframe'), out = frame.locator("output");
      const refresh = () => frame.getByRole("button", { name: "Refresh" }).tap();
      const answer = async (kind: "approve" | "deny") => { await page.getByTestId("approval-" + kind).first().click({ timeout: 3500 }); };
      await out.getByText("Unread").waitFor();
      expect(await frame.locator("body").evaluate(() => typeof (window as Window & { ox?: { space?: { source?: { read?: unknown } } } }).ox?.space?.source?.read)).toBe("function");
      await refresh(); await answer("approve"); await answer("deny"); await out.getByText("permission_denied").waitFor(); expect(reads).toBe(0);
      const allowRead = async () => { await refresh(); await answer("approve"); await answer("approve"); };
      await allowRead(); await out.getByText("North Court: 4–2", { exact: false }).waitFor();
      expect(await out.textContent()).toContain(origin + "/bulletin"); expect(reads).toBe(1);
      body = "North Court: 5–2"; await allowRead(); await out.getByText("North Court: 5–2", { exact: false }).waitFor();
      expect(reads).toBe(2);
      responseStatus = 302; await allowRead(); await out.getByText("permission_denied").waitFor(); expect(reads).toBe(3);
    });
  } finally {
    site.stop(true); if (previous === undefined) delete process.env.OX_HOST_TEST_ORIGINS; else process.env.OX_HOST_TEST_ORIGINS = previous;
    if (lookup === undefined) delete process.env.OPENOX_PUBLIC_LOOKUP; else process.env.OPENOX_PUBLIC_LOOKUP = lookup;
  }
}, 45_000);

test("LS-05/06: natural Space chat creates, customizes and reopens one working original artifact", async () => {
  const data = join(process.cwd(), `.space-journey-${crypto.randomUUID()}`);
  await mkdir(data);
  const model = provider();
  const flags = { OPENOX_PERSONAL_AGENT: "1", OPENOX_MUSE_PARITY: "1", OPENOX_PROACTIVE_AGENT: "1", OPENOX_EVIDENCE_ONLY: "0", OPENOX_VERTEX_ADC: "0",
    OPENOX_PUBLIC_LOOKUP: "0", OPENOX_MEDIA_URL: "http://127.0.0.1:9", OX_HOST_TEST_ORIGINS: `http://127.0.0.1:${model.server.port}` };
  const before = Object.fromEntries(Object.keys(flags).map(key => [key, process.env[key]])), native = globalThis.fetch;
  Object.assign(process.env, flags);
  const { chromium } = await import(Bun.resolveSync("playwright-core", join(import.meta.dir, "../../../../../apps/linux"))) as typeof import("../../../../../apps/linux/node_modules/playwright-core");
  let host: Host | undefined, server: Awaited<ReturnType<typeof startServer>> | undefined, browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    globalThis.fetch = Object.assign((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname !== "127.0.0.1") throw new Error(`External traffic is disabled: ${url.origin}`);
      return native(input, init);
    }, { preconnect: native.preconnect });
    host = await Host.open({ data, hostID: "Tennis Space fixture", version: "test", quiet: true });
    await host.setCustomProvider({ name: "Fixture", baseUrl: `http://127.0.0.1:${model.server.port}/v1`, models: ["fixture"] });
    const choice = { provider: "custom", modelId: "fixture" };
    server = await startServer(host, { hostname: "127.0.0.1", port: 0 });
    const base = `http://127.0.0.1:${server.port}`, { token } = await host.devices.add("Fixture observer", "cli");
    const api = async (path: string, method = "GET", body?: object) => {
      const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
      if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
      return r;
    };
    const get = async <T>(path: string) => (await api(path)).json() as Promise<T>;
    const spaces = async () => (await get<{ spaces: Space[] }>("/api/spaces")).spaces;
    const unrelated = async () => Promise.all(["/api/goals", "/api/todos", "/api/schedules", "/api/feed", "/api/ideas", "/api/permissions"].map(path => get(path)));
    await api("/api/settings/default-model", "PUT", choice);
    const initial = await unrelated();
    browser = await chromium.launch({ headless: true });
    const paired = await browser.newPage({ viewport: { width: 1285, height: 736 }, colorScheme: "dark" });
    await paired.route("**/*", route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
    const { code } = await (await api("/api/devices/pairing", "POST")).json() as { code: string };
    await paired.goto(base); await paired.getByTestId("pair-code").fill(code); await paired.getByTestId("pair-name").fill("Tennis client");
    await paired.getByTestId("pair-submit").click(); await paired.getByTestId("onboarding-start").click();
    const { page, capture, finish } = await reviewJourney(paired, "space-tennis");
    page.setDefaultTimeout(6500);
    const chat = page.getByTestId("space-context-chat"), input = chat.getByTestId("composer-input");
    await page.getByTestId("muse-feed").click(); await page.getByTestId("muse-space").click();
    await page.getByTestId("feed-prompt").waitFor();
    expect((await input.inputValue()).trim()).toBe("I want to make a space about");
    expect(await spaces()).toEqual([]); expect(model.turns).toEqual([]);
    await capture("feed-draft");
    await chat.getByTestId("space-context-close").click();
    await page.getByTestId("muse-library").click(); await page.getByTestId("library-create-space").waitFor();
    await capture("library");
    await page.getByTestId("library-create-space").click();
    expect((await input.inputValue()).trim().length).toBeGreaterThan(0);
    expect(await spaces()).toEqual([]); expect(model.turns).toEqual([]);
    const send = async (text: string) => { await input.fill(text); await chat.getByTestId("send").click(); };
    await send(create);
    const approval = chat.getByTestId("pending-approval");
    await approval.waitFor();
    expect(await approval.innerText()).toContain("Create a persistent Space");
    await capture("pending");
    const namedStage = await approval.innerText();
    expect(await spaces()).toEqual([]);
    await approval.getByTestId("approval-deny").click();
    await chat.getByText("I do not have a completed Space change to report.").waitFor();
    expect(await spaces()).toEqual([]);
    await capture("denied");
    const bytes = async () => (await api(`/api/files/content?path=${encodeURIComponent(entry)}`)).text();
    expect(await bytes()).toBe(doc);
    await send(create); await approval.getByTestId("approval-approve").waitFor();
    await capture("retry-consent"); await approval.getByTestId("approval-approve").click();
    await chat.getByText("The Space is registered.").waitFor();
    const thread = page.url();
    const [space] = await spaces();
    expect(space).toMatchObject({ name: title, entryPath: entry, missing: false });
    const ownerFiles = await get<{ items: { id: string }[] }>("/api/library?category=system&q=courtside-almanac.html");
    expect(ownerFiles.items.map(file => file.id)).toEqual([space!.fileId]);
    expect((await host.profile.library.items("system")).some(file => file.id === space!.fileId)).toBe(false);
    const open = async () => { await page.getByTestId(`library-space-${space!.id}`).click(); await page.getByTestId("space-title").waitFor(); };
    expect(await page.getByTestId("space-canvas").count()).toBe(0);
    await page.getByTestId(`library-space-${space!.id}`).waitFor();
    await capture("created");
    await input.fill(change); await open();
    const frame = page.frameLocator('[data-testid="space-canvas"] iframe');
    await frame.getByRole("heading", { name: title }).waitFor();
    await frame.getByText("Practice card", { exact: true }).click();
    expect(await frame.getByText("Alternate five forehands and five backhands.").isVisible()).toBe(true);
    await capture("open");
    expect(await chat.isVisible()).toBe(true);
    expect(await input.inputValue()).toBe(change);
    await page.getByTestId("space-back").click(); await page.getByTestId(`library-space-${space!.id}`).waitFor();
    expect(page.url()).toBe(thread); await open();
    await chat.getByTestId("send").click(); await chat.getByText("The drill was added to the existing card.").waitFor();
    await frame.getByRole("heading", { name: "Clay-court drill" }).waitFor();
    await capture("customized");
    await chat.getByTestId("space-context-close").click(); await page.getByTestId("space-back").click(); await open();
    expect(await chat.isVisible()).toBe(false);
    const port = server.port!; server.stop(true); await host.close();
    host = await Host.open({ data, hostID: "Tennis Space fixture", version: "test", quiet: true });
    server = await startServer(host, { hostname: "127.0.0.1", port });
    await page.reload();
    await frame.getByRole("heading", { name: "Clay-court drill" }).waitFor(); expect(await frame.getByText(drill).isVisible()).toBe(true);
    await capture("reopened");
    const saved = await spaces(); expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ id: space!.id, fileId: space!.fileId, entryPath: entry, missing: false, iconPath: journalIcon });
    expect(await (await api(`/api/spaces/${space!.id}/icon?v=${saved[0]!.iconRevision}`)).text()).toBe(iconFiles[journalIcon]);
    expect(saved[0]!.dataGrants ?? []).toEqual([]); expect(saved[0]!.connections ?? []).toEqual([]);
    const customized = await bytes();
    expect(customized).toContain(drill);
    expect(await unrelated()).toEqual(initial);
    expect(model.turns).toEqual(["create", "create", "create", "create", "change", "change"]);
    expect(model.authorGuidance.join("\n")).toContain("external results");
    expect(model.authorGuidance.join("\n")).toContain("manual scorekeeper");
    expect(model.authorGuidance.join("\n")).toContain("iconPath");
    expect(namedStage).toContain(journalIcon);
    expect(namedStage).toContain(title);
    expect(namedStage).toContain(entry);
    expect(namedStage).toMatch(/awaiting (?:your )?(?:approval|permission)/i);
    if (process.env.OPENOX_TEST_ARTIFACTS) {
      const digest = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex");
      await Bun.write(join(process.env.OPENOX_TEST_ARTIFACTS, "space-tennis-proof.json"), JSON.stringify({
        provider: "loopback-scripted", modelRequests: model.turns.length, approvals: ["deny", "approve once"],
        initial: { spaceId: space!.id, entryFileId: space!.fileId, sha256: digest(doc) },
        reopenedAfterHostRestart: { spaceId: saved[0]!.id, entryFileId: saved[0]!.fileId, sha256: digest(customized), entryPath: entry },
        persistedSpaces: saved.length, dataGrants: saved[0]!.dataGrants ?? [], connections: saved[0]!.connections ?? [],
        unchanged: ["policies", "schedules", "todos", "goals", "feed", "ideas"],
      }, null, 2));
    }
    await finish();
  } finally {
    await browser?.close(); server?.stop(true); await host?.close(); model.server.stop(true); globalThis.fetch = native;
    for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(data, { recursive: true, force: true });
  }
}, 60_000);

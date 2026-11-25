import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT } from "../../../../lib.ts";

type Prompt = { id: string; prompt: string; options: string[]; requiresApp: boolean };
type View = { busy: boolean; pendingPrompt?: Prompt; blocks: { kind: Record<string, unknown> }[]; messages: { role: string; content: unknown }[] };
type Answer = { answer: string } | { cancel: true };
type Host = { process: ReturnType<typeof Bun.spawn>; port: number; token: string; data: string };

const chunk = (delta: unknown, finish: string | null = null) => `data: ${JSON.stringify({ id: "chatcmpl-fixture", object: "chat.completion.chunk", created: 0, model: "fixture",
  choices: [{ index: 0, delta, finish_reason: finish }], ...(finish ? { usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } } : {}) })}\n\n`;
const text = (value: string) => [chunk({ role: "assistant", content: value }), chunk({}, "stop")];
const call = (purpose: string, source: string) => [chunk({ role: "assistant", tool_calls: [{ index: 0, id: `call_${crypto.randomUUID()}`, type: "function",
  function: { name: "execute", arguments: JSON.stringify({ purpose, source }) } }] }), chunk({}, "tool_calls")];
const plain = (content: unknown) => typeof content === "string" ? content
  : Array.isArray(content) ? content.map(part => typeof part === "string" ? part : (part as { text?: string }).text ?? "").join("") : JSON.stringify(content);

let base = "";
const crc32 = (data: Uint8Array) => { let c = ~0; for (const b of data) { c ^= b; for (let k = 0; k < 8; k++) c = c >>> 1 ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
function storedZip(files: Record<string, string>) {
  const parts: Buffer[] = [], central: Buffer[] = []; let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text), nameBytes = Buffer.from(name), crc = crc32(data);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBytes.length, 26);
    const entry = Buffer.alloc(46); entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6); entry.writeUInt32LE(crc, 16); entry.writeUInt32LE(data.length, 20); entry.writeUInt32LE(data.length, 24); entry.writeUInt16LE(nameBytes.length, 28); entry.writeUInt32LE(offset, 42);
    parts.push(local, nameBytes, data); central.push(entry, nameBytes); offset += 30 + nameBytes.length + data.length;
  }
  const dir = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10); end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, dir, end]);
}
const crx = (zip: Buffer) => { const head = Buffer.alloc(12); head.write("Cr24", 0); head.writeUInt32LE(3, 4); head.writeUInt32LE(0, 8); return Buffer.concat([head, zip]); };
const extensionID = "abcdefghijklmnopabcdefghijklmnop";
const extensionPackage = crx(storedZip({
  "manifest.json": JSON.stringify({ manifest_version: 3, name: "Fixture Cashback", version: "1.2.0", host_permissions: ["<all_urls>"], permissions: ["storage"],
    content_scripts: [{ matches: ["<all_urls>"], js: ["content.js"], run_at: "document_end" }] }),
  "content.js": "document.body.insertAdjacentHTML('beforeend', '<p id=\"ox-ext\">Cashback ready</p>');",
}));
let orders = 0;
const partnerHits: string[] = [];
const cart: string[] = [];
const shop = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const url = new URL(request.url);
  const page = (title: string, body: string) => new Response(`<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8" } });
  if (request.method === "POST" && url.pathname === "/cart/add") { cart.push(new URLSearchParams(await request.text()).get("item") ?? "?"); return Response.redirect(`${base}/cart`, 303); }
  if (url.hostname === "hop.localhost") { partnerHits.push(url.pathname + url.search); return url.pathname === "/pixel" ? new Response("ok") : page("Partner", `<h1>Partner landing</h1>`); }
  if (url.pathname === "/cross") return page("Cross", `<h1>Cross-site shop</h1><img src="${base.replace("127.0.0.1", "hop.localhost")}/pixel" alt="">
    <a href="/redirect">Continue to partner</a><button onclick="window.open('${base.replace("127.0.0.1", "hop.localhost")}/landing?popup=1')">Sign in with Partner</button>`);
  if (url.pathname === "/redirect") return Response.redirect(`${base.replace("127.0.0.1", "hop.localhost")}/landing`, 303);
  if (url.pathname === `/store/${extensionID}.crx`) return new Response(extensionPackage, { headers: { "content-type": "application/x-chrome-extension" } });
  if (request.method === "POST" && url.pathname === "/order") { orders += 1; return Response.redirect(`${base}/done`, 303); }
  if (request.method === "POST" && url.pathname === "/login") {
    const form = new URLSearchParams(await request.text());
    if (form.get("email") !== "ada@example.com" || form.get("password") !== "correct horse") return page("Sign in", `<h1>Sign in</h1><p>Wrong email or password.</p>`);
    return new Response(null, { status: 303, headers: { location: `${base}/account`, "set-cookie": "shop-session=ada; Path=/; HttpOnly" } });
  }
  switch (url.pathname) {
    case "/": return page("Fixture shop", `<h1>Fixture shop</h1><input id="q" aria-label="Search">
      <form method="post" action="/cart/add"><input type="hidden" name="item" value="Friskies"><p>Friskies 40 cans</p><button>Add to cart</button></form>
      <form method="post" action="/cart/add"><input type="hidden" name="item" value="Mouse pen"><p>Mouse pen</p><button>Add to cart</button></form>`);
    case "/cart": return page("Cart", `<h1>Your cart</h1><p>Items: ${cart.join(", ") || "none"}</p><p>Order total: $52.51</p>
      <form method="post" action="/order"><label>Card number <input name="cardnumber" autocomplete="cc-number"></label><button>Place order</button></form>`);
    case "/signin": return page("Sign in", `<h1>Sign in</h1><form><label>Email <input name="email"></label><label>Password <input type="password" name="password"></label>
      <label>Verification code <input name="code" autocomplete="one-time-code"></label><button type="button">Sign in</button></form>`);
    case "/done": return page("Order placed", `<h1>Order placed</h1><p>Order #1001</p>`);
    case "/login": return page("Sign in", `<h1>Sign in</h1><form method="post" action="/login"><label>Email <input type="email" name="email" autocomplete="username"></label>
      <label>Password <input type="password" name="password" autocomplete="current-password"></label><button>Sign in</button></form>`);
    case "/account": return page("Account", request.headers.get("cookie")?.includes("shop-session=ada") ? `<h1>Account</h1><p>Signed in as ada@example.com</p>` : `<h1>Account</h1><p>Not signed in</p>`);
    case "/logout": return new Response(null, { status: 303, headers: { location: `${base}/login`, "set-cookie": "shop-session=; Path=/; Max-Age=0" } });
    default: return new Response("Not found", { status: 404 });
  }
} });
base = `http://127.0.0.1:${shop.port}`;

const model = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  if (request.method === "GET") return new Response("Not found", { status: 404 });
  const body = await request.json() as { messages: { role: string; content: unknown }[] };
  const last = body.messages.at(-1)!;
  const script = /SCRIPT:([A-Za-z0-9+/=]+)/.exec(plain(last.content))?.[1];
  const events = last.role === "tool" ? text(`RESULT ${plain(last.content)}`) : script ? call("Use the browser", Buffer.from(script, "base64").toString()) : text("No script.");
  return new Response(events.join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
} });

async function startHost(jobs: boolean, extra: Record<string, string> = {}): Promise<Host> {
  const data = await mkdtemp(join(tmpdir(), "ox-browser-jobs-"));
  const env = { ...Bun.env, OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "", OX_HOST_TEST_ORIGINS: `${base},${base.replace("127.0.0.1", "hop.localhost")}`, OPENOX_BROWSER_JOBS: jobs ? "1" : "0", OX_EXTENSION_STORE_URL: `${base}/store/{id}.crx`, ...extra };
  const child = Bun.spawn([process.execPath, `${ROOT}/apps/linux/src/main.ts`, "serve", "--data", data, "--port", "0", "--name", "fixture"], { stdout: "pipe", stderr: "pipe", env });
  const reader = child.stdout.getReader();
  let output = "", port = 0;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && !port) {
    const { value, done } = await reader.read();
    if (done) break;
    output += new TextDecoder().decode(value);
    port = Number(/listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(output)?.[1] ?? 0);
  }
  reader.releaseLock();
  if (!port) { child.kill(); throw new Error(`Host did not start: ${output}`); }
  const tokenRun = Bun.spawn([process.execPath, `${ROOT}/apps/linux/src/main.ts`, "token", "--name", "jobs-test", "--data", data], { stdout: "pipe", stderr: "pipe" });
  const token = /OX_HOST_TOKEN=(\S+)/.exec(await new Response(tokenRun.stdout).text())![1]!;
  const host = { process: child, port, token, data };
  expect((await api(host, "/api/settings/providers/custom", { method: "PUT", body: JSON.stringify({ name: "Scripted", baseUrl: `http://127.0.0.1:${model.port}/v1`, models: ["fixture"] }) })).status).toBe(200);
  return host;
}
async function stopHost(host: Host) { host.process.kill("SIGTERM"); await host.process.exited; await rm(host.data, { recursive: true, force: true }); }
const api = (host: Host, path: string, init: RequestInit = {}) =>
  fetch(`http://127.0.0.1:${host.port}${path}`, { ...init, headers: { authorization: `Bearer ${host.token}`, "content-type": "application/json", ...init.headers } });

async function run(host: Host, body: string, answer?: (prompt: Prompt, view: View) => Answer | Promise<Answer>) {
  const created = await api(host, "/api/conversations", { method: "POST", body: "{}" });
  const id = (await created.json() as { id: number }).id;
  const prelude = `const BASE = ${JSON.stringify(base)}; const attempt = async work => { try { return { ok: await work() }; } catch (error) { return { code: error.code, message: error.message }; } };\n`;
  expect((await api(host, `/api/conversations/${id}/messages`, { method: "POST", body: JSON.stringify({ text: `SCRIPT:${Buffer.from(prelude + body).toString("base64")}` }) })).status).toBe(202);
  const prompts: Prompt[] = [];
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const current = await (await api(host, `/api/conversations/${id}`)).json() as View;
    if (current.pendingPrompt && !prompts.some(item => item.id === current.pendingPrompt!.id)) {
      prompts.push(current.pendingPrompt);
      if (!answer) throw new Error(`Unexpected prompt: ${current.pendingPrompt.prompt}`);
      expect((await api(host, `/api/conversations/${id}/respond`, { method: "POST", body: JSON.stringify({ promptId: current.pendingPrompt.id, ...await answer(current.pendingPrompt, current) }) })).status).toBe(200);
    } else if (!current.busy) {
      const reply = plain(current.messages.at(-1)?.content);
      if (!reply.startsWith("RESULT {")) throw new Error(`Unexpected reply: ${reply.slice(0, 4_000)}`);
      return { result: JSON.parse(reply.slice(7)) as Record<string, any>, prompts, view: current };
    }
    await Bun.sleep(50);
  }
  throw new Error("The browser turn did not finish");
}

let jobs: Host;
beforeAll(async () => { jobs = await startHost(true); }, 40_000);
afterAll(async () => { if (jobs) await stopHost(jobs); shop.stop(true); model.stop(true); });

test("Browser jobs BJ-H1 interact acts on one visible control, reads page text, refuses secret fields and asks before committing steps", async () => {
  const commits: string[] = [];
  const { result, prompts } = await run(jobs, `
    await ox.web.browser.navigate({ purpose: "Open the shop", url: BASE + "/" });
    const ambiguous = await attempt(() => ox.web.browser.interact({ purpose: "Add to cart", action: "click", target: { label: "Add to cart" } }));
    const added = await ox.web.browser.interact({ purpose: "Add Friskies", action: "click", target: { label: "Add to cart", index: 1 } });
    const cartText = await ox.web.browser.readText({ purpose: "Read the cart" });
    await ox.web.browser.navigate({ purpose: "Open the shop", url: BASE + "/" });
    const typed = await ox.web.browser.interact({ purpose: "Search", action: "type", target: { label: "Search" }, text: "cat food" });
    await ox.web.browser.navigate({ purpose: "Open sign-in", url: BASE + "/signin" });
    const password = await attempt(() => ox.web.browser.interact({ purpose: "Type password", action: "type", target: { label: "Password" }, text: "secret-value" }));
    const code = await attempt(() => ox.web.browser.interact({ purpose: "Type code", action: "type", target: { label: "Verification code" }, text: "123456" }));
    await ox.web.browser.navigate({ purpose: "Open cart", url: BASE + "/cart" });
    const card = await attempt(() => ox.web.browser.interact({ purpose: "Type card", action: "type", target: { label: "Card number" }, text: "4111111111111111" }));
    const denied = await attempt(() => ox.web.browser.interact({ purpose: "Place the order", action: "click", target: { label: "Place order" }, commits: "Pay $52.51 for Friskies" }));
    const stillCart = await ox.web.browser.readText({ purpose: "Check the cart" });
    const undeclared = await ox.web.browser.interact({ purpose: "Continue", action: "click", target: { label: "Place order" } });
    const placed = await ox.web.browser.interact({ purpose: "Place the order", action: "click", target: { label: "Place order" }, commits: "Pay $52.51 for Friskies" });
    const done = await ox.web.browser.readText({ purpose: "Read the confirmation" });
    return { ambiguous, added, cartText, typed, password, code, card, denied, stillCart: stillCart.text, undeclared, placed, done: done.text };`,
  prompt => {
    if (prompt.options.includes("I'll do it myself")) {
      commits.push(prompt.prompt);
      return { answer: commits.length === 1 ? "Deny" : commits.length === 2 ? "I'll do it myself" : "Approve once" };
    }
    if (prompt.options.includes("Hand back")) return { answer: "Hand back" };
    return { answer: "Approve" };
  });
  expect(result.ambiguous).toMatchObject({ code: "invalid_argument" });
  expect(result.ambiguous.message).toContain("2 controls");
  expect(result.added).toMatchObject({ url: `${base}/cart`, title: "Cart" });
  expect(result.cartText).toMatchObject({ url: `${base}/cart`, truncated: false });
  expect(result.cartText.text).toContain("Items: Friskies");
  expect(result.cartText.text).toContain("Order total: $52.51");
  expect(result.typed).toMatchObject({ url: `${base}/` });
  for (const refused of [result.password, result.code, result.card]) {
    expect(refused).toMatchObject({ code: "permission_denied" });
    expect(refused.message).toContain("waitForUserInteraction");
  }
  expect(result.denied).toMatchObject({ code: "permission_denied" });
  expect(result.stillCart).toContain("Your cart");
  expect(result.undeclared).toMatchObject({ handedOff: true, url: `${base}/cart` });
  expect(result.placed).toMatchObject({ url: `${base}/done` });
  expect(result.done).toContain("Order #1001");
  expect(orders).toBe(1);
  expect(commits).toHaveLength(3);
  expect(commits[0]).toContain("Pay $52.51 for Friskies");
  expect(commits[0]).toContain("Order total: $52.51");
  expect(commits[1]).toContain("Place order");
  const options = prompts.find(prompt => prompt.options.includes("I'll do it myself"))!.options;
  expect(options).toEqual(["Approve once", "I'll do it myself", "Deny"]);
  expect(prompts.some(prompt => prompt.options.includes("Hand back"))).toBe(true);
}, 90_000);

test("Browser jobs BJ-H2 without the gate interact and readText are unavailable", async () => {
  const off = await startHost(false);
  try {
    const { result } = await run(off, `
      return { interact: await attempt(() => ox.web.browser.interact({ purpose: "Click", action: "click", target: { label: "x" } })),
        read: await attempt(() => ox.web.browser.readText({ purpose: "Read" })) };`);
    for (const missing of [result.interact, result.read]) expect(`${missing.code ?? ""} ${missing.message}`).toMatch(/not_supported|not a function|Unknown function/);
  } finally { await stopHost(off); }
}, 60_000);

test("Browser jobs BJ-10 the confirm and take-over cards render in chat at 1280 and 390 and answer from the page", async () => {
  const { chromium } = await import(Bun.resolveSync("playwright-core", join(ROOT, "apps/linux"))) as typeof import("../../../../../apps/linux/node_modules/playwright-core");
  const browser = await chromium.launch({ headless: true });
  const origin = `http://127.0.0.1:${jobs.port}`;
  try {
    for (const [width, language] of [[1280, "en"], [390, "zh-Hans"]] as const) {
      const created = await api(jobs, "/api/conversations", { method: "POST", body: "{}" });
      const id = (await created.json() as { id: number }).id;
      const prelude = `const BASE = ${JSON.stringify(base)};\n`;
      const script = `await ox.web.browser.navigate({ purpose: "Open cart", url: BASE + "/cart" });
        const first = await ox.web.browser.interact({ purpose: "Place the order", action: "click", target: { label: "Place order" }, commits: "Place order: Friskies, $52.51" });
        return { first };`;
      expect((await api(jobs, `/api/conversations/${id}/messages`, { method: "POST", body: JSON.stringify({ text: `SCRIPT:${Buffer.from(prelude + script).toString("base64")}` }) })).status).toBe(202);
      const page = await browser.newPage({ viewport: { width, height: 860 }, serviceWorkers: "block" });
      await page.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
      const pair = await (await api(jobs, "/api/devices/pairing", { method: "POST" })).json() as { code: string };
      await page.goto(origin); await page.evaluate(lang => localStorage.setItem("ox.language", lang), language); await page.reload();
      await page.getByTestId("pair-code").fill(pair.code); await page.getByTestId("pair-name").fill(`Jobs ${width}`); await page.getByTestId("pair-submit").click();
      await page.getByTestId("onboarding-start").click(); await page.getByTestId("onboarding").waitFor({ state: "hidden" });
      await page.goto(`${origin}/#/c/${id}`);
      for (const until = Date.now() + 15_000; Date.now() < until;) {
        const pending = ((await (await api(jobs, `/api/conversations/${id}`)).json()) as View).pendingPrompt;
        if (pending?.options.includes("I'll do it myself")) break;
        if (pending?.options.includes("Always approve")) await api(jobs, `/api/conversations/${id}/respond`, { method: "POST", body: JSON.stringify({ promptId: pending.id, answer: "Approve" }) });
        await Bun.sleep(100);
      }
      await page.getByText("Place order: Friskies, $52.51", { exact: false }).first().waitFor({ timeout: 15_000 });
      if (language !== "en") expect(await page.getByTestId("approval-source").last().innerText()).toContain("在 127.0.0.1 上确认");
      expect(await page.getByTestId("pending-approval").last().getByRole("button").allInnerTexts()).toEqual(language === "en" ? ["Approve once", "I'll do it myself", "Deny"] : ["批准这一次", "我自己来", "拒绝"]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      if (process.env.OPENOX_TEST_ARTIFACTS) await page.screenshot({ path: join(process.env.OPENOX_TEST_ARTIFACTS, `browser-job-confirm-${width}.png`), animations: "disabled" });
      await page.getByTestId("approval-ill-do-it-myself").click();
      await page.getByTestId("page-done").first().waitFor({ timeout: 15_000 });
      expect(await page.getByTestId("page-done").first().innerText()).toBe(language === "en" ? "Hand back" : "交还给助手");
      if (language !== "en") expect(await page.getByTestId("pending-page").last().innerText()).toContain("请你接手：Place order: Friskies, $52.51。完成后交还给助手。");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      if (process.env.OPENOX_TEST_ARTIFACTS) await page.screenshot({ path: join(process.env.OPENOX_TEST_ARTIFACTS, `browser-job-takeover-${width}.png`), animations: "disabled" });
      await page.getByTestId("page-done").first().click();
      const deadline = Date.now() + 20_000;
      let reply = "";
      while (Date.now() < deadline) {
        const current = await (await api(jobs, `/api/conversations/${id}`)).json() as View;
        if (!current.busy) { reply = plain(current.messages.at(-1)?.content); break; }
        await Bun.sleep(100);
      }
      expect(reply).toMatch(/"handedOff": ?true/);
      await page.close();
    }
  } finally { await browser.close(); }
}, 120_000);

test("Browser jobs BJ-07 signIn hands off with an option to save the login, then signs in with the saved login after approval without exposing it", async () => {
  let cards: Record<string, unknown>[] = [];
  const first = await run(jobs, `
    await ox.web.browser.navigate({ purpose: "Open sign-in", url: BASE + "/login" });
    const handed = await ox.web.browser.signIn({ purpose: "Sign in to the shop" });
    const account = await ox.web.browser.readText({ purpose: "Check the account" });
    await ox.web.browser.navigate({ purpose: "Sign out", url: BASE + "/logout" });
    const saved = await ox.web.browser.signIn({ purpose: "Sign in again" });
    const again = await ox.web.browser.readText({ purpose: "Check the account" });
    return { handed, account: account.text, saved, again: again.text };`,
  async (prompt, view) => {
    const card = view.blocks.map(block => block.kind).find(kind => kind.promptId === prompt.id);
    if (card?.promptKind === "page") {
      cards.push(card);
      const filled = await api(jobs, `/api/pages/${encodeURIComponent(String(card.page))}/sign-in`, { method: "POST",
        body: JSON.stringify({ username: "ada@example.com", password: "correct horse", save: true }) });
      expect(filled.status).toBe(200);
      return { answer: "Hand back" };
    }
    if (prompt.options.includes("Approve once")) { cards.push({ approval: prompt.prompt }); return { answer: "Approve once" }; }
    return { answer: "Approve" };
  });
  const result = first.result;
  expect(cards[0]).toMatchObject({ promptKind: "page", login: true, saveLogin: true, done: "Hand back" });
  expect(result.handed).toMatchObject({ status: "handedOff" });
  expect(result.account).toContain("Signed in as ada@example.com");
  const approval = String(cards[1]?.approval ?? "");
  expect(approval).toContain("saved login");
  expect(approval).toContain("a***@example.com");
  expect(result.saved).toMatchObject({ status: "signedIn", savedLogin: true });
  expect(result.again).toContain("Signed in as ada@example.com");
  expect(JSON.stringify(first.view.messages)).not.toContain("correct horse");
  const stores = await Array.fromAsync(new Bun.Glob("**/secrets.json").scan({ cwd: jobs.data, absolute: true }));
  const entries = (await Promise.all(stores.map(file => Bun.file(file).json()))).flatMap(store => (store as { entries: { website?: unknown; value: Record<string, string> }[] }).entries);
  expect(entries.some(entry => entry.website && entry.value.url.startsWith(base) && entry.value.username === "ada@example.com")).toBe(true);
  const logs = await Array.fromAsync(new Bun.Glob("**/*.jsonl").scan({ cwd: jobs.data, absolute: true }));
  for (const file of logs) expect(await Bun.file(file).text()).not.toContain("correct horse");
}, 90_000);

test("Browser jobs BJ-09 an approved extension is installed from the store, loaded into the job browser, listed and removed; a denied one is not installed", async () => {
  const asked: string[] = [];
  const { result } = await run(jobs, `
    const denied = await attempt(() => ox.web.browser.extensions.install({ purpose: "Install the cashback helper", id: ${JSON.stringify(extensionID)} }));
    const installed = await ox.web.browser.extensions.install({ purpose: "Install the cashback helper", id: ${JSON.stringify(extensionID)} });
    await ox.web.browser.navigate({ purpose: "Open the shop", url: BASE + "/" });
    const withExtension = await ox.web.browser.readText({ purpose: "Read the page" });
    const listed = await ox.web.browser.extensions.list({ purpose: "List extensions" });
    const removed = await ox.web.browser.extensions.remove({ purpose: "Remove the helper", id: ${JSON.stringify(extensionID)} });
    await ox.web.browser.navigate({ purpose: "Open the shop", url: BASE + "/" });
    const without = await ox.web.browser.readText({ purpose: "Read the page" });
    const bad = await attempt(() => ox.web.browser.extensions.install({ purpose: "Bad id", id: "../../etc" }));
    return { denied, installed, withExtension: withExtension.text, listed, removed, without: without.text, bad, after: await ox.web.browser.extensions.list({ purpose: "List" }) };`,
  prompt => {
    if (prompt.options.includes("Approve once")) { asked.push(prompt.prompt); return { answer: asked.length === 1 ? "Deny" : "Approve once" }; }
    return { answer: "Approve" };
  });
  expect(result.denied).toMatchObject({ code: "permission_denied" });
  expect(asked[0]).toContain("Fixture Cashback 1.2.0");
  expect(asked[0]).toContain("<all_urls>");
  expect(asked[0]).toContain("storage");
  expect(result.installed).toMatchObject({ id: extensionID, name: "Fixture Cashback", version: "1.2.0" });
  expect(result.withExtension).toContain("Cashback ready");
  expect(result.listed.extensions).toEqual([expect.objectContaining({ id: extensionID, name: "Fixture Cashback", version: "1.2.0" })]);
  expect(result.removed).toMatchObject({ removed: true });
  expect(result.without).not.toContain("Cashback ready");
  expect(result.bad).toMatchObject({ code: "invalid_argument" });
  expect(result.after.extensions).toEqual([]);
}, 120_000);

test("Browser jobs BJ-12 Settings lists an installed extension under Passwords and removes it after confirming, at 1280 and 390", async () => {
  const muse = await startHost(true, { OPENOX_MUSE_PARITY: "1", OPENOX_PERSONAL_AGENT: "1" });
  const { chromium } = await import(Bun.resolveSync("playwright-core", join(ROOT, "apps/linux"))) as typeof import("../../../../../apps/linux/node_modules/playwright-core");
  const browser = await chromium.launch({ headless: true });
  const origin = `http://127.0.0.1:${muse.port}`;
  try {
    for (const [width, language] of [[1280, "en"], [390, "zh-Hans"]] as const) {
      await run(muse, `return await ox.web.browser.extensions.install({ purpose: "Install the cashback helper", id: ${JSON.stringify(extensionID)} });`,
        prompt => ({ answer: prompt.options.includes("Approve once") ? "Approve once" : prompt.options.includes("Approve for this task") ? "Approve for this task" : "Approve" }));
      const page = await browser.newPage({ viewport: { width, height: 860 }, serviceWorkers: "block" });
      await page.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
      const pair = await (await api(muse, "/api/devices/pairing", { method: "POST" })).json() as { code: string };
      await page.goto(origin); await page.evaluate(lang => localStorage.setItem("ox.language", lang), language); await page.reload();
      await page.getByTestId("pair-code").fill(pair.code); await page.getByTestId("pair-name").fill(`Ext ${width}`); await page.getByTestId("pair-submit").click();
      const start = page.getByTestId("onboarding-start");
      if (await start.waitFor({ timeout: 5_000 }).then(() => true, () => false)) { await start.click(); await page.getByTestId("onboarding").waitFor({ state: "hidden" }); }
      await page.goto(`${origin}/#/settings/secrets`);
      const item = page.getByTestId(`browser-extension-${extensionID}`);
      await item.waitFor({ timeout: 15_000 });
      expect(await item.innerText()).toContain("Fixture Cashback 1.2.0");
      expect(await page.getByTestId("browser-extensions").locator("..").innerText()).toContain(language === "en" ? "Browser extensions" : "浏览器扩展");
      expect(await page.getByTestId("muse-password-privacy").innerText()).toContain(language === "en" ? "only after you approve it" : "只有在你批准后");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      if (process.env.OPENOX_TEST_ARTIFACTS) await page.screenshot({ path: join(process.env.OPENOX_TEST_ARTIFACTS, `browser-extensions-settings-${width}.png`), animations: "disabled" });
      await page.getByTestId(`browser-extension-remove-${extensionID}`).click();
      await page.getByRole("dialog").last().getByRole("button", { name: language === "en" ? "Remove" : "移除", exact: true }).last().click();
      await page.getByTestId("browser-extensions-empty").waitFor({ timeout: 15_000 });
      await page.close();
    }
  } finally { await browser.close(); await stopHost(muse); }
}, 150_000);

test("Browser jobs BJ-13 with parity permissions, an approved job page loads third-party resources, follows redirects to other sites and opens popups; without jobs they stay blocked", async () => {
  const script = `
    await ox.web.browser.navigate({ purpose: "Open the shop", url: BASE + "/cross" });
    const jobs = typeof ox.web.browser.interact === "function";
    const moved = jobs ? await ox.web.browser.interact({ purpose: "Continue", action: "click", target: { label: "Continue to partner" } }) : null;
    if (jobs) { await ox.web.browser.navigate({ purpose: "Back to the shop", url: BASE + "/cross" }); await ox.web.browser.interact({ purpose: "Partner sign-in", action: "click", target: { label: "Sign in with Partner" } }); }
    return { moved };`;
  const answer = (prompt: Prompt) => ({ answer: prompt.options.includes("Approve for this task") ? "Approve for this task" : "Approve" });
  const parity = { OPENOX_MUSE_PARITY: "1", OPENOX_PERSONAL_AGENT: "1" };
  const off = await startHost(false, parity);
  try { partnerHits.length = 0; await run(off, script, answer); expect(partnerHits).not.toContain("/pixel"); } finally { await stopHost(off); }
  const on = await startHost(true, parity);
  try {
    partnerHits.length = 0;
    const { result } = await run(on, script, answer);
    expect(partnerHits).toContain("/pixel");
    expect(result.moved.url).toBe(`${base.replace("127.0.0.1", "hop.localhost")}/landing`);
    expect(partnerHits).toContain("/landing");
    for (const until = Date.now() + 5_000; !partnerHits.includes("/landing?popup=1") && Date.now() < until;) await Bun.sleep(100);
    expect(partnerHits).toContain("/landing?popup=1");
  } finally { await stopHost(on); }
}, 150_000);

test("Browser jobs BJ-14 answering a take-over card renews the job's permission scope, so the agent continues after a long hand-off", async () => {
  const host = await startHost(true, { OPENOX_MUSE_PARITY: "1", OPENOX_PERSONAL_AGENT: "1", OX_TEST_TASK_TTL_MS: "3000" });
  try {
    const { result } = await run(host, `
      await ox.web.browser.navigate({ purpose: "Open the cart", url: BASE + "/cart" });
      await ox.web.browser.waitForUserInteraction({ purpose: "Let the user check", instructions: "Check the cart, then hand back." });
      return { after: await attempt(() => ox.web.browser.readText({ purpose: "Read the cart again" })) };`,
    async prompt => {
      if (prompt.options.includes("Done")) { await Bun.sleep(4_500); return { answer: "Done" }; }
      return { answer: prompt.options.includes("Approve for this task") ? "Approve for this task" : "Approve" };
    });
    expect(result.after.ok?.text).toContain("Your cart");
  } finally { await stopHost(host); }
}, 90_000);

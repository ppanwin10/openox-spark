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
let orders = 0;
const cart: string[] = [];
const shop = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const url = new URL(request.url);
  const page = (title: string, body: string) => new Response(`<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8" } });
  if (request.method === "POST" && url.pathname === "/cart/add") { cart.push(new URLSearchParams(await request.text()).get("item") ?? "?"); return Response.redirect(`${base}/cart`, 303); }
  if (request.method === "POST" && url.pathname === "/order") { orders += 1; return Response.redirect(`${base}/done`, 303); }
  switch (url.pathname) {
    case "/": return page("Fixture shop", `<h1>Fixture shop</h1><input id="q" aria-label="Search">
      <form method="post" action="/cart/add"><input type="hidden" name="item" value="Friskies"><p>Friskies 40 cans</p><button>Add to cart</button></form>
      <form method="post" action="/cart/add"><input type="hidden" name="item" value="Mouse pen"><p>Mouse pen</p><button>Add to cart</button></form>`);
    case "/cart": return page("Cart", `<h1>Your cart</h1><p>Items: ${cart.join(", ") || "none"}</p><p>Order total: $52.51</p>
      <form method="post" action="/order"><label>Card number <input name="cardnumber" autocomplete="cc-number"></label><button>Place order</button></form>`);
    case "/signin": return page("Sign in", `<h1>Sign in</h1><form><label>Email <input name="email"></label><label>Password <input type="password" name="password"></label>
      <label>Verification code <input name="code" autocomplete="one-time-code"></label><button type="button">Sign in</button></form>`);
    case "/done": return page("Order placed", `<h1>Order placed</h1><p>Order #1001</p>`);
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

async function startHost(jobs: boolean): Promise<Host> {
  const data = await mkdtemp(join(tmpdir(), "ox-browser-jobs-"));
  const env = { ...Bun.env, OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "", OX_HOST_TEST_ORIGINS: base, OPENOX_BROWSER_JOBS: jobs ? "1" : "0" };
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

async function run(host: Host, body: string, answer?: (prompt: Prompt) => Answer) {
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
      expect((await api(host, `/api/conversations/${id}/respond`, { method: "POST", body: JSON.stringify({ promptId: current.pendingPrompt.id, ...answer(current.pendingPrompt) }) })).status).toBe(200);
    } else if (!current.busy) {
      const reply = plain(current.messages.at(-1)?.content);
      if (!reply.startsWith("RESULT {")) throw new Error(`Unexpected reply: ${reply.slice(0, 4_000)}`);
      return { result: JSON.parse(reply.slice(7)) as Record<string, any>, prompts };
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

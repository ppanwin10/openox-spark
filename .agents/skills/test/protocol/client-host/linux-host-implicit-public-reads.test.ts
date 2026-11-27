import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Host } from "../../../../../apps/linux/src/host";
import { startServer } from "../../../../../apps/linux/src/server";

const page = "https://handbook.example/public", result = "https://first.example/guide";

async function journey(gate: boolean, siteRule?: "ask") {
  const data = await mkdtemp(join(tmpdir(), "openox-implicit-public-"));
  const env: Record<string, string> = { OPENOX_PERSONAL_AGENT: "1", OPENOX_MUSE_PARITY: "1", OPENOX_PROACTIVE_AGENT: "1", OPENOX_PUBLIC_LOOKUP: "1",
    OPENOX_EVIDENCE_ONLY: "0", OPENOX_VERTEX_ADC: "0", OPENOX_MEDIA_URL: "http://local-media.invalid", OPENOX_IMPLICIT_PUBLIC_READS: gate ? "1" : "0",
    OX_HOST_TEST_ORIGINS: ["https://duckduckgo.com", page, result].join(",") };
  const prior = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  const native = globalThis.fetch, reads: string[] = [], engine: string[] = [];
  let host: Host | undefined, server: Awaited<ReturnType<typeof startServer>> | undefined;
  const model = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (new URL(request.url).pathname === "/v1/models") return Response.json({ data: [{ id: "fixture" }] });
    const b = await request.json() as { messages: { role: string; content: string }[]; tools?: { function: { name: string } }[] };
    const last = b.messages.at(-1)!, user = b.messages.filter(m => m.role === "user").at(-1)?.content ?? "";
    const call = last.role !== "user" ? undefined : user.includes("Read https://") ? { name: "ox_web_fetch", arguments: { purpose: "Read the page", url: page } }
      : user.includes("alder register") ? { name: "ox_web_search", arguments: { purpose: "Search the web", query: "alder register", domains: ["duckduckgo.com"] } } : undefined;
    const chunk = (d: object, finish: string | null) => `data: ${JSON.stringify({ id: "f", object: "chat.completion.chunk", created: 0, model: "fixture", choices: [{ index: 0, delta: d, finish_reason: finish }] })}\n\n`;
    const delta = call ? { tool_calls: [{ index: 0, id: "call_" + crypto.randomUUID(), type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] } : { content: "Done." };
    return new Response(chunk({ role: "assistant", ...delta }, null) + chunk({}, call ? "tool_calls" : "stop") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  } });
  try {
    globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname === "127.0.0.1") return native(input, init);
      if (url.href === `${env.OPENOX_MEDIA_URL}/health`) return new Response(null, { status: 503 });
      if (url.href !== page && url.href !== result) throw new Error("Unplanned test request: " + url.origin);
      expect(init?.credentials).toBe("omit");
      reads.push(url.href);
      return new Response(`Public entry from ${url.hostname}`, { headers: { "content-type": "text/plain" } });
    }, { preconnect: native.preconnect });
    host = await Host.open({ data, hostID: "Implicit public read fixture", version: "test", quiet: true });
    const anonymous = host.browser.withAnonymousPage.bind(host.browser);
    host.browser.withAnonymousPage = (url, domain, signal, work) => anonymous(url, domain, signal, async tab => {
      expect(await tab.context().cookies()).toEqual([]);
      await tab.route("**/*", route => {
        if (route.request().url() !== url) return route.abort();
        engine.push(domain);
        return route.fulfill({ contentType: "text/html", body: `<article class="result" data-type="web"><a class="result__a" href="${result}"><span class="search-snippet-title">Alder register</span></a></article>` });
      });
      return work(tab);
    });
    server = await startServer(host, { hostname: "127.0.0.1", port: 0 });
    const base = `http://127.0.0.1:${server.port}`, { token } = await host.devices.add("Fixture reader", "cli");
    const api = async (path: string, method = "GET", body?: object) => {
      const res = await native(base + path, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
      if (!res.ok) throw new Error(`${path}: HTTP ${res.status}: ${await res.text()}`);
      return res.json();
    };
    await host.setCustomProvider({ name: "Fixture", baseUrl: `http://127.0.0.1:${model.port}/v1`, models: ["fixture"] });
    if (siteRule) await api("/api/permissions", "PUT", { scope: "action", id: "ox.web.browser:handbook.example:publicPages", policy: siteRule });
    const { id } = await api("/api/conversations", "POST", { model: { provider: "custom", modelId: "fixture" } }) as { id: number };
    const asked: string[] = [];
    for (const text of [`Read ${page} please`, "Could you find a couple of sources on the alder register for me?"]) {
      await api(`/api/conversations/${id}/messages`, "POST", { text, requestId: crypto.randomUUID() });
      const seen = new Set<string>(), deadline = Date.now() + 25_000;
      for (;;) {
        if (Date.now() > deadline) throw new Error("Turn did not settle");
        const view = await api(`/api/conversations/${id}`) as { busy: boolean; pendingPrompt?: { id: string }; blocks: { kind: { promptId?: string; title?: string } }[] };
        const p = view.pendingPrompt;
        if (p && !seen.has(p.id)) {
          seen.add(p.id); asked.push(view.blocks.find(b => b.kind.promptId === p.id)?.kind.title ?? "");
          await api(`/api/conversations/${id}/respond`, "POST", { promptId: p.id, answer: "Approve" });
        } else if (!view.busy && !p) break;
        await Bun.sleep(45);
      }
    }
    const history = await api("/api/approvals/history") as { records: { decision: string; action: string }[] };
    return { asked, reads, engine, history: history.records.map(r => [r.decision, r.action]) };
  } finally {
    server?.stop(true); await host?.close(); model.stop(true); globalThis.fetch = native;
    for (const [key, value] of Object.entries(prior)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(data, { recursive: true, force: true });
  }
}

test("PX-01/02 an ordinary chat reads a public page and searches anonymously without prompts when implicit public reads are on", async () => {
  const on = await journey(true);
  expect(on.asked).toEqual([]);
  expect(on.reads).toEqual([page, result]); expect(on.engine).toEqual(["duckduckgo.com"]);
  expect(on.history.length).toBeGreaterThan(0);
  expect(on.history.every(([decision]) => decision === "allowedByPolicy")).toBe(true);
}, 90_000);

test("PX-01/02 explicit site rules and the default-off gate keep their existing prompts", async () => {
  const ruled = await journey(true, "ask");
  expect(ruled.asked).toContain("Browser - handbook.example");
  const off = await journey(false);
  expect(off.asked).toContain("Browser - handbook.example");
  expect(off.asked).toContain("DuckDuckGo - Search");
}, 120_000);

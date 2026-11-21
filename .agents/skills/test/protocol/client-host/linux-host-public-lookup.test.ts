import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Host } from "../../../../../apps/linux/src/host";
import { startServer } from "../../../../../apps/linux/src/server";

test("PX requested public lookup isolates context, searches anonymously and reads results without per-site approvals", async () => {
  const data = await mkdtemp(join(tmpdir(), "openox-public-lookup-"));
  const engines = ["duckduckgo.com", "search.brave.com"], results = ["https://first.example/guide", "https://second.example/summary"];
  const directURL = "https://handbook.example/public";
  const env = { OPENOX_PERSONAL_AGENT: "1", OPENOX_MUSE_PARITY: "1", OPENOX_PROACTIVE_AGENT: "1", OPENOX_PUBLIC_LOOKUP: "1",
    OPENOX_EVIDENCE_ONLY: "0", OPENOX_VERTEX_ADC: "0", OPENOX_MEDIA_URL: "http://local-media.invalid",
    OX_HOST_TEST_ORIGINS: [...engines.map(d => `https://${d}`), ...results, directURL].join(",") };
  const prior = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  const native = globalThis.fetch, readURLs: string[] = [], engineVisits: string[] = [];
  const wires: { tools: string[]; privateContext: boolean }[] = [], toolResults: string[] = [];
  const sentinel = "PRIVATE-NOTE-KEPT-IN-CHAT", topic = "Marble Almanac", requestText = `帮我查看${topic}`;
  let host: Host | undefined, server: Awaited<ReturnType<typeof startServer>> | undefined;
  const model = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (new URL(request.url).pathname === "/v1/models") return Response.json({ data: [{ id: "fixture" }] });
    const b = await request.json() as { messages: { role: string; content: string }[]; tools?: { function: { name: string } }[] };
    const tools = b.tools?.map(t => t.function.name) ?? [], privateContext = JSON.stringify(b.messages).includes(sentinel);
    const user = b.messages.filter(m => m.role === "user").at(-1)?.content ?? "";
    const lookup = user.includes(requestText) || user.includes("look up ") || user.includes("Read https://");
    if (lookup) wires.push({ tools, privateContext });
    const last = b.messages.at(-1);
    if (lookup && last?.role === "tool") toolResults.push(last.content);
    const tool = lookup && !privateContext && tools.length === 1 && b.messages.at(-1)?.role === "user" ? tools[0] : undefined;
    const args = tool === "ox_web_search" ? { purpose: "Research the requested public subject", query: `${topic} model-added text`, domains: engines }
      : { purpose: "Read the requested public page", url: directURL };
    const delta = tool ? { tool_calls: [{ index: 0, id: "call_" + crypto.randomUUID(), type: "function",
      function: { name: tool, arguments: JSON.stringify(args) } }] }
      : { content: lookup ? "Lookup finished." : "Noted for this chat." };
    const chunk = (d: object, finish: string | null) => `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 0, model: "fixture", choices: [{ index: 0, delta: d, finish_reason: finish }] })}\n\n`;
    return new Response(chunk({ role: "assistant", ...delta }, null) + chunk({}, tool ? "tool_calls" : "stop") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  } });
  try {
    globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname === "127.0.0.1") return native(input, init);
      if (url.href === `${env.OPENOX_MEDIA_URL}/health`) return new Response(null, { status: 503 });
      if (!results.includes(url.href) && url.href !== directURL) throw new Error("Unplanned test request: " + url.origin);
      expect(init?.credentials).toBe("omit"); expect(init?.redirect).toBe("manual");
      readURLs.push(url.href);
      return new Response(`Public entry from ${url.hostname}`, { headers: { "content-type": "text/plain" } });
    }, { preconnect: native.preconnect });
    host = await Host.open({ data, hostID: "Private public lookup fixture", version: "test", quiet: true });
    const anonymous = host.browser.withAnonymousPage.bind(host.browser);
    host.browser.withAnonymousPage = (url, domain, signal, work) => anonymous(url, domain, signal, async page => {
      expect(engines).toContain(domain); expect(new URL(url).searchParams.get("q")).toBe(topic);
      expect(await page.context().cookies()).toEqual([]);
      await page.route("**/*", route => {
        if (route.request().url() !== url || route.request().method() !== "GET") return route.abort();
        engineVisits.push(domain);
        const target = results[engines.indexOf(domain)]!;
        return route.fulfill({ contentType: "text/html", body: `<article class="result" data-type="web"><a class="result__a" href="${target}"><span class="search-snippet-title">Public register</span></a></article>` });
      });
      return work(page);
    });
    server = await startServer(host, { hostname: "127.0.0.1", port: 0 });
    const base = `http://127.0.0.1:${server.port}`, { token } = await host.devices.add("Fixture reader", "cli");
    const api = async (path: string, method = "GET", body?: object) => {
      const res = await native(base + path, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
      if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
      return res.json();
    };
    const modelChoice = { provider: "custom", modelId: "fixture" };
    await host.setCustomProvider({ name: "Private fixture", baseUrl: `http://127.0.0.1:${model.port}/v1`, models: ["fixture"] });
    const { id } = await api("/api/conversations", "POST", { model: modelChoice }) as { id: number };
    const path = `/api/conversations/${id}`;
    const turn = async (text: string, expected: string[] = []) => {
      const key = crypto.randomUUID(), asked: string[] = [], seen = new Set<string>();
      await api(path + "/messages", "POST", { text, requestId: key });
      const deadline = Date.now() + 25_000;
      while (Date.now() < deadline) {
        const view = await api(path) as { busy: boolean; pendingPrompt?: { id: string }; blocks: { kind: { promptId?: string; title?: string } }[] };
        const p = view.pendingPrompt;
        if (p && !seen.has(p.id)) {
          const title = view.blocks.find(b => b.kind.promptId === p.id)?.kind.title;
          expect(title).toBe(expected[asked.length]); seen.add(p.id); asked.push(title!);
          await api(path + "/respond", "POST", { promptId: p.id, answer: "Deny" });
        } else if (!view.busy && !p) {
          expect(asked).toEqual(expected); return;
        }
        await Bun.sleep(45);
      }
      throw new Error("Lookup did not settle");
    };
    await turn(`Keep ${sentinel} in this chat only.`);
    const initial = await api("/api/permissions/@muse") as { revision: number; objects: { websites: unknown[] } };
    await turn(requestText);
    expect(wires[0]).toEqual({ tools: ["ox_web_search"], privateContext: false });
    expect(engineVisits.toSorted()).toEqual(engines.toSorted()); expect(readURLs.toSorted()).toEqual(results.toSorted());
    const first = JSON.parse(toolResults[0]!) as { query: string; sourceDocuments: { ok: boolean; text: string }[] };
    expect(first.query).toBe(topic); expect(first.sourceDocuments.filter(d => d.ok).map(d => d.text).sort()).toEqual(["Public entry from first.example", "Public entry from second.example"]);
    const after = await api("/api/permissions/@muse") as typeof initial;
    expect(after.revision).toBe(initial.revision); expect(after.objects.websites).toEqual([]);
    await api("/api/permissions", "PUT", { scope: "action", id: "ox.web.browser:first.example:publicPages", policy: "block" });
    await api("/api/permissions", "PUT", { scope: "action", id: "ox.web.browser:second.example:publicPages", policy: "ask" });
    await turn(`Please look up ${topic}`, ["Browser - second.example"]);
    expect(readURLs).toHaveLength(2);
    const history = (await api("/api/approvals/history") as { records: { decision: string; source: string | null }[] }).records;
    expect(history.some(r => r.source === "https://first.example" && r.decision === "blockedByPolicy")).toBe(true);
    expect(history.some(r => r.source === "https://second.example" && r.decision === "denied")).toBe(true);
    await api("/api/permissions", "PUT", { scope: "action", id: "web:duckduckgo.com:search", policy: "block" });
    await api("/api/permissions", "PUT", { scope: "action", id: "web:search.brave.com:search", policy: "block" });
    const searches = engineVisits.length, beforeFailure = wires.length;
    await turn(requestText); expect(engineVisits).toHaveLength(searches);
    expect(wires.length - beforeFailure).toBe(1);
    const failed = await api(path) as { blocks: { kind: { items?: { text?: string }[] } }[] };
    expect(failed.blocks.at(-1)?.kind.items?.at(-1)?.text).toContain("未能读取公开来源");
    await turn(`Read ${directURL}`); expect(readURLs).toHaveLength(3);
    expect(wires.at(-1)).toEqual({ tools: ["ox_web_fetch"], privateContext: false });
    const current = await api("/api/permissions/@muse") as typeof initial;
    await api("/api/permissions/@muse", "POST", { requestId: crypto.randomUUID(), expectedRevision: current.revision, operation: "default", target: "web", value: "ask" });
    await turn(`Read ${directURL}`, ["Browser - handbook.example"]); expect(readURLs).toHaveLength(3);
    await turn("Please look up my tasks");
    expect(wires.at(-1)?.tools).toContain("ox_todo_list");
    expect(engineVisits).toHaveLength(searches);
  } finally {
    server?.stop(true); await host?.close(); model.stop(true); globalThis.fetch = native;
    for (const [k,v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await rm(data, { recursive: true, force: true });
  }
}, 90_000);

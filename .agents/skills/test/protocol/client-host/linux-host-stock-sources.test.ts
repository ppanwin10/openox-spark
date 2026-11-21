import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Host } from "../../../../../apps/linux/src/host";
import { startServer } from "../../../../../apps/linux/src/server";
import { requestedPublicLookup } from "../../../../../apps/linux/src/vm/public-lookup";

const flags = { OPENOX_PERSONAL_AGENT: "1", OPENOX_MUSE_PARITY: "1", OPENOX_PUBLIC_LOOKUP: "1",
  OPENOX_PROACTIVE_AGENT: "0", OPENOX_VERTEX_ADC: "0", OPENOX_EVIDENCE_ONLY: "0" };
function environment(values: Record<string, string>) {
  const old = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  return () => { for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } };
}

test("PX stock journey recognizes original phrases without sending them to a provider", () => {
  const restore = environment(flags);
  try {
    expect(requestedPublicLookup("check goog stock")?.subject).toBe("goog stock");
    expect(requestedPublicLookup("which website you searched?")?.kind).toBe("sources");
    expect(requestedPublicLookup("how about checking yahoo finance?")?.kind).toBe("finance");
    for (const text of ["check my stock", "check its stock", "check attached stock", "check earlier stock", "check Alice’s private stock",
      "check ZLQ stock and buy two", "how about checking my signed-in Yahoo Finance?", "how about checking yahoo finance in the attached file?"]) {
      expect(requestedPublicLookup(text)).toBeUndefined();
    }
    process.env.OPENOX_PUBLIC_LOOKUP = "0";
    expect(requestedPublicLookup("how about checking yahoo finance?")).toBeUndefined();
  } finally { restore(); }
});

test("PX named stock → actual sources → original public finance page stays adjacent, anonymous and source-bound", async () => {
  const stock = "ZLQ", subject = `${stock} stock`, lookup = `Please check ${subject}`;
  const sources = "Which websites did you search?", finance = "How about checking Yahoo Finance instead?";
  const engine = "duckduckgo.com", article = "https://market.example/closing", failed = "https://listed.example/unreadable";
  const quote = `https://finance.yahoo.com/quote/${stock}/`, unrelated = "https://different.example/something";
  const sentinel = "PRIVATE-ORCHARD", decoy = "imaginary.example";
  const data = await mkdtemp(join(tmpdir(), "ox-px-stock-"));
  const restore = environment({ ...flags, OPENOX_MEDIA_URL: "http://local-media.invalid",
    OX_HOST_TEST_ORIGINS: [`https://${engine}`, article, failed, quote, unrelated].join(",") });
  const native = globalThis.fetch, queries: string[] = [], gets: string[] = [], prompts: string[] = [], scoped: string[] = [];
  let wires = 0, mode: "read" | "challenge" | "redirect" | "unsupported" | "fabricate" = "read";
  let host: Host | undefined, server: Awaited<ReturnType<typeof startServer>> | undefined;
  const model = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    if (new URL(req.url).pathname === "/v1/models") return Response.json({ data: [{ id: "fixture" }] });
    const b = await req.json() as { tools?: { function: { name: string } }[]; messages: { role: string; content: string }[] };
    wires++;
    const tool = b.tools?.length === 1 ? b.tools[0]!.function.name : undefined;
    if (tool) scoped.push(JSON.stringify(b.messages));
    const call = tool && b.messages.at(-1)?.role === "user" && mode !== "fabricate";
    const args = tool === "ox_web_search" ? { purpose: "Find public prices", query: "model invented query", domains: [engine] }
      : { purpose: "Read the public quote", url: quote };
    const delta = call ? { tool_calls: [{ index: 0, id: crypto.randomUUID(), type: "function",
      function: { name: tool, arguments: JSON.stringify(args) } }] } : { content: `I checked ${decoy}.` };
    const chunk = (d: object, finish: string | null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: d, finish_reason: finish }] })}\n\n`;
    return new Response(chunk({ role: "assistant", ...delta }, null) + chunk({}, call ? "tool_calls" : "stop") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  } });
  try {
    globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname === "127.0.0.1" && [model.port, server?.port].includes(Number(url.port))) return native(input, init);
      if (url.href === "http://local-media.invalid/health") return new Response(null, { status: 503 });
      if (![article, failed, quote, unrelated].includes(url.href)) throw new Error(`Unexpected request: ${url.origin}`);
      expect(init?.method).toBe("GET"); expect(init?.credentials).toBe("omit"); expect(init?.redirect).toBe("manual");
      gets.push(url.href);
      if (url.href === quote && mode === "redirect") return Response.redirect(unrelated);
      if (url.href === failed || url.href === quote && mode === "challenge") return new Response("Verify you're human", { status: 403 });
      return new Response(url.href === quote && mode === "unsupported" ? "Sign in to continue" : `${stock} fixture quote: 17.25 test units.`, { headers: { "content-type": "text/plain" } });
    }, { preconnect: native.preconnect });
    host = await Host.open({ data, hostID: "Stock fixture", version: "test", quiet: true });
    const anonymous = host.browser.withAnonymousPage.bind(host.browser);
    host.browser.withAnonymousPage = (url, domain, signal, work) => anonymous(url, domain, signal, async page => {
      expect(domain).toBe(engine); expect(await page.context().cookies()).toEqual([]);
      await page.route("**/*", route => {
        if (route.request().url() !== url || route.request().method() !== "GET") return route.abort();
        queries.push(new URL(url).searchParams.get("q")!);
        return route.fulfill({ contentType: "text/html", body: [article, failed].map(link => `<div class="result"><a class="result__a" href="${link}">Quote</a></div>`).join("") });
      });
      return work(page);
    });
    await host.setCustomProvider({ name: "Private fixture", baseUrl: `http://127.0.0.1:${model.port}/v1`, models: ["fixture"] });
    server = await startServer(host, { hostname: "127.0.0.1", port: 0 });
    const { token } = await host.devices.add("Stock fixture", "cli");
    const api = async (path: string, method = "GET", body?: object) => {
      const res = await native(`http://127.0.0.1:${server!.port}/api${path}`, { method,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
      if (!res.ok) throw new Error(`Fixture ${path}: ${res.status}`);
      return res.json();
    };
    const chat = () => host!.profile.create({ provider: "custom", modelId: "fixture" });
    const turn = async (id: number, text: string, attachments: string[] = []) => {
      const path = `/conversations/${id}`, key = crypto.randomUUID();
      await api(path + "/messages", "POST", { text, requestId: key, attachments });
      const deadline = Date.now() + 20_000, answered = new Set<string>();
      while (Date.now() < deadline) {
        const view = await api(path) as { busy: boolean; pendingPrompt?: { id: string; prompt: string }; error: string | null;
          blocks: { kind: { type: string; items?: { text?: string }[] } }[] };
        if (view.pendingPrompt && !answered.has(view.pendingPrompt.id)) {
          prompts.push(view.pendingPrompt.prompt); answered.add(view.pendingPrompt.id);
          await api(path + "/respond", "POST", { promptId: view.pendingPrompt.id, answer: "Deny" });
        } else if (!view.busy && !view.pendingPrompt) {
          return view.blocks.slice(view.blocks.findLastIndex(b => b.kind.type === "userText") + 1)
            .flatMap(b => b.kind.items?.map(i => i.text ?? "") ?? []).join("\n") || view.error || "";
        }
        await Bun.sleep(25);
      }
      throw new Error("Stock fixture turn did not settle");
    };
    const id = await chat();
    await turn(id, `Keep ${sentinel} and the private ticker ABC in this chat.`);
    await turn(id, lookup);
    expect(queries).toEqual([subject]); expect(gets.toSorted()).toEqual([article, failed].toSorted());
    const afterSearch = wires, before = [...gets];
    const receipt = await turn(id, sources);
    expect(receipt).toContain(engine); expect(receipt).toContain(article); expect(receipt).not.toContain(failed);
    expect(receipt).not.toContain(decoy); expect(wires).toBe(afterSearch); expect(gets).toEqual(before); expect(queries).toEqual([subject]);
    const result = await turn(id, finance);
    expect(gets.slice(before.length)).toEqual([quote]); expect(queries).toEqual([subject]);
    expect(result).toContain(quote); expect(result).toContain("17.25"); expect(result).not.toContain(decoy);
    expect(prompts).toEqual([]); expect(scoped.join("\n")).not.toContain(sentinel);
    const perms = await api("/permissions/@muse") as { objects: { websites: unknown[] } };
    expect(perms.objects.websites).toEqual([]);
    for (const failure of ["challenge", "redirect", "unsupported", "fabricate"] as const) {
      await turn(id, lookup); mode = failure;
      const start = gets.length, text = await turn(id, finance);
      expect(gets.slice(start)).toEqual(failure === "fabricate" ? [] : [quote]);
      expect(text).not.toContain(decoy); expect(text).not.toContain("17.25");
      expect(text).toMatch(/couldn.t|could not|not verified|no .*verified|unverified|unable|rejected/i);
      mode = "read";
    }
    const other = await chat(), initial = gets.length, searched = queries.length;
    for (const target of [other, id]) {
      if (target === id) await turn(id, `My private account uses ${sentinel}.`);
      const text = await turn(target, finance);
      expect(text).toMatch(/which|specify|provide|name the|tell me/i); expect(text).not.toContain(stock);
      expect(gets.length).toBe(initial); expect(queries.length).toBe(searched);
    }
    await turn(other, "Please look up public weather");
    const preWeather = gets.length;
    expect(await turn(other, finance)).not.toContain(stock); expect(gets.length).toBe(preWeather);
    await turn(id, lookup, ["PRIVATE-ORCHARD.txt"]);
    const attached = gets.length;
    expect(await turn(id, finance)).not.toContain(stock); expect(gets.length).toBe(attached);
    expect(queries).toEqual([...Array(searched).fill(subject), "public weather"]);
    for (const policy of ["ask", "block"]) {
      await turn(id, lookup);
      await api("/permissions", "PUT", { scope: "action", id: "ox.web.browser:yahoo.com:publicPages", policy });
      const count = gets.length, decisions = prompts.length;
      const reply = await turn(id, finance);
      expect(gets.length).toBe(count); expect(reply).not.toContain("17.25");
      expect(prompts.length - decisions).toBe(policy === "ask" ? 1 : 0);
    }
  } finally {
    server?.stop(true); await host?.close(); model.stop(true); globalThis.fetch = native; restore();
    await rm(data, { recursive: true, force: true });
  }
}, 120_000);

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
    for (const text of ["What's the current share price of BRK.B?", "What is BRK.B’s stock price today?", "How much is BRK.B stock?", "Check brk.b stock price"]) {
      expect(requestedPublicLookup(text)?.ticker).toBe("BRK.B");
    }
    for (const text of ["Research ACME stock", "Analyze ACME stock price", "What is ACME stock?", "What is Acme's stock price?",
      "What is the stock price of Marble Almanac?", "Search for ACME stock price"]) {
      expect(requestedPublicLookup(text)?.kind).toBe("search"); expect(requestedPublicLookup(text)?.ticker).toBeUndefined();
    }
    expect(requestedPublicLookup("which website you searched?")?.kind).toBe("sources");
    expect(requestedPublicLookup("how about checking yahoo finance?")?.kind).toBe("finance");
    expect(requestedPublicLookup("Check Yahoo Finance")?.kind).toBe("finance");
    for (const text of ["check my stock", "check its stock", "check token stock", "check attached stock", "check earlier stock", "check Alice’s private stock",
      "check ZLQ stock and buy two", "Check my stock price", "What is the stock price of MY?", "Check Yahoo Finance in my account",
      "how about checking my signed-in Yahoo Finance?", "how about checking yahoo finance in the attached file?"]) {
      expect(requestedPublicLookup(text)).toBeUndefined();
    }
    process.env.OPENOX_PUBLIC_LOOKUP = "0";
    expect(requestedPublicLookup("how about checking yahoo finance?")).toBeUndefined();
    expect(requestedPublicLookup("Check Yahoo Finance")).toBeUndefined();
    expect(requestedPublicLookup("What is ACME's stock price?")).toBeUndefined();
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
  let wires = 0, mode: "read" | "challenge" | "redirect" | "unsupported" | "wrongTicker" | "fabricate" | "noPrice" | "noResults"
    | "quoteHeader" | "conflictingHeader" | "wrongHeading" | "consentWall" | "partialDocument" | "shortBudget" | "otherSymbolQuote" | "targetOnly" = "read";
  let host: Host | undefined, server: Awaited<ReturnType<typeof startServer>> | undefined;
  let beforeNextQuote: (() => Promise<void>) | undefined;
  const model = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    if (new URL(req.url).pathname === "/v1/models") return Response.json({ data: [{ id: "fixture" }] });
    const b = await req.json() as { tools?: { function: { name: string } }[]; messages: { role: string; content: string }[] };
    wires++;
    const tool = b.tools?.length === 1 ? b.tools[0]!.function.name : undefined;
    if (tool) scoped.push(JSON.stringify(b.messages));
    const call = tool && b.messages.at(-1)?.role === "user" && mode !== "fabricate";
    if (call && tool === "ox_web_fetch" && beforeNextQuote) {
      const change = beforeNextQuote; beforeNextQuote = undefined; await change();
    }
    const args = tool === "ox_web_search" ? { purpose: "Find public prices", query: "model invented query", domains: [engine] }
      : { purpose: "Read the public quote", url: quote, ...(mode === "shortBudget" ? { options: { maxBytes: 32 } } : {}) };
    const delta = call ? { content: `I checked ${decoy}.`, tool_calls: [{ index: 0, id: crypto.randomUUID(), type: "function",
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
      if (url.href === quote && mode === "wrongTicker") return new Response("ABC stock price: 32.50.", { headers: { "content-type": "text/plain" } });
      if (url.href === quote && mode === "partialDocument") return new Response(`<p>${stock} quote: 81.20 USD.</p>`, { status: 206, headers: { "content-type": "text/html" } });
      if (url.href === quote && ["quoteHeader", "conflictingHeader", "wrongHeading", "consentWall", "shortBudget"].includes(mode)) {
        const body = `<html><head><title>Public stock page</title><link rel="canonical" href="${quote}"></head><body>
          ${mode === "consentWall" ? "<dialog open>Sign in to continue</dialog>" : ""}<main>
          <section data-testid="quote-hdr"><h1>Example Instruments (${mode === "wrongHeading" ? "ABC" : stock})</h1>
          <span>Example Exchange • USD</span><div data-testid="price-statistic"><span data-testid="qsp-price">42.38</span>
          <span data-testid="qsp-price-change">-0.42</span><span data-testid="qsp-price-change-percent">(-0.98%)</span></div>
          ${mode === "conflictingHeader" ? '<span data-testid="qsp-price">80.99</span>' : ""}
          <span data-testid="qsp-price" hidden>850.00</span><div>At close: November 20 at 4:00:00 PM EST</div>
          <div data-testid="price-statistic"><span data-testid="qsp-post-price">43.62</span></div><div>After hours: 7:33:00 PM EST</div></section>
          <article><p>${stock} stock has an analyst price target of $999.95. That number is a forecast, not a market quote. This article discusses estimates rather than the regular-session price.</p></article>
          </main></body></html>`;
        return new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
      }
      if (url.href === article && mode === "noPrice") return new Response(`${stock} is the public stock ticker; no quote is available here.`, { headers: { "content-type": "text/plain" } });
      if (url.href === article && mode === "targetOnly") return new Response(`${stock} stock has an analyst price target of $999.95.`, { headers: { "content-type": "text/plain" } });
      if (url.href === article && mode === "otherSymbolQuote") return new Response(`Stock comparison: ${stock} and ABC. ABC quote: 74.21 USD.`, { headers: { "content-type": "text/plain" } });
      return new Response(url.href === quote && mode === "unsupported" ? "Sign in to continue" : `Fixture: ${stock} quote: 17.25 test units.`, { headers: { "content-type": "text/plain" } });
    }, { preconnect: native.preconnect });
    host = await Host.open({ data, hostID: "Stock fixture", version: "test", quiet: true });
    const anonymous = host.browser.withAnonymousPage.bind(host.browser);
    host.browser.withAnonymousPage = (url, domain, signal, work) => anonymous(url, domain, signal, async page => {
      expect(domain).toBe(engine); expect(await page.context().cookies()).toEqual([]);
      await page.route("**/*", route => {
        if (route.request().url() !== url || route.request().method() !== "GET") return route.abort();
        queries.push(new URL(url).searchParams.get("q")!);
        return route.fulfill({ contentType: "text/html", body: mode === "noResults" ? "<p>No results found.</p>" :
          [article, failed].map(link => `<div class="result"><a class="result__a" href="${link}">Quote</a></div>`).join("") });
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
    const at = (await api(`/conversations/${id}`) as { blocks: { kind: { entry?: number; type: string } }[] }).blocks.findLast(b => b.kind.type === "userText")!.kind.entry!;
    const fork = await host.profile.branch(id, at);
    expect(await turn(fork, finance)).toMatch(/which stock/i); expect(gets).toEqual(before); expect(wires).toBe(afterSearch);
    const result = await turn(id, finance);
    expect(gets.slice(before.length)).toEqual([quote]); expect(queries).toEqual([subject]);
    expect(result).toContain(quote); expect(result).toContain("17.25"); expect(result).not.toContain(decoy);
    expect(scoped.at(-1)).toContain(quote); expect(scoped.at(-1)).not.toContain(article);
    expect(prompts).toEqual([]); expect(scoped.join("\n")).not.toContain(sentinel);
    const perms = await api("/permissions/@muse") as { objects: { websites: unknown[] } };
    expect(perms.objects.websites).toEqual([]);
    const attributionCalls = wires, attributionReads = [...gets], attributionSearches = [...queries];
    const fromQuote = await turn(id, "你刚才查了哪些网站？");
    expect(fromQuote).toContain(quote); expect(fromQuote).toContain("没有使用搜索引擎");
    const noSource = await turn(await chat(), "你搜索了哪个网站？");
    expect(noSource).toContain("没有可核对的"); expect(noSource).not.toContain(quote);
    expect(wires).toBe(attributionCalls); expect(gets).toEqual(attributionReads); expect(queries).toEqual(attributionSearches);
    mode = "targetOnly";
    expect(await turn(id, lookup)).toMatch(/couldn't verify/i);
    mode = "otherSymbolQuote";
    expect(await turn(id, lookup)).toMatch(/couldn't verify/i);
    mode = "read";
    for (const variant of ["quoteHeader", "conflictingHeader", "wrongHeading", "consentWall", "partialDocument", "shortBudget"] as const) {
      await turn(id, lookup); mode = variant;
      const beforeGet = gets.length, reply = await turn(id, finance);
      expect(gets.slice(beforeGet)).toEqual([quote]);
      if (variant === "quoteHeader" || variant === "shortBudget") {
        expect(reply).toContain("42.38"); expect(reply).toContain("USD"); expect(reply).toContain("-0.98%");
        expect(reply).toContain("November 20 at 4:00:00 PM EST"); expect(reply).toMatch(/After.hours[^\n]*43\.62/i);
        expect(reply).toContain(quote); expect(reply).not.toContain("850.00");
      } else {
        expect(reply).toMatch(/couldn.t verify/i); expect(reply).not.toMatch(/42\.38|43\.62|80\.99/);
      }
      expect(reply).not.toContain("999.95");
      mode = "read";
    }
    mode = "noResults";
    const emptyReads = gets.length;
    expect(await turn(id, lookup)).toMatch(/couldn.t verify/i);
    expect(gets.length).toBe(emptyReads);
    const callsOnMiss = wires, miss = await turn(id, sources);
    expect(miss).toContain("I didn't successfully read a public page");
    expect(wires).toBe(callsOnMiss);
    mode = "read";
    expect(await turn(id, "Check Yahoo Finance")).toContain(quote);
    expect(gets.slice(emptyReads)).toEqual([quote]);
    expect(miss).toContain(`Search engines I tried: ${engine}`);
    expect(miss).toContain("returned results: none recorded");
    mode = "noPrice";
    expect(await turn(id, lookup)).toMatch(/couldn.t verify/i);
    expect(await turn(id, finance)).toContain(quote);
    mode = "read";
    for (const failure of ["challenge", "redirect", "unsupported", "wrongTicker", "fabricate"] as const) {
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
    const siteAction = "ox.web.browser:yahoo.com:publicPages";
    const setAction = (action: string, policy: "allow" | "ask" | "block" | null) =>
      api("/permissions", "PUT", { scope: "action", id: action, policy });
    await setAction(siteAction, "allow");
    const approved = await chat(), queryCount = queries.length, readCount = gets.length, decisions = prompts.length;
    const savedPolicy = await api("/permissions/@muse");
    mode = "quoteHeader";
    const firstQuote = await turn(approved, `What's the current stock price of ${stock}?`);
    expect(gets.slice(readCount)).toEqual([quote]); expect(queries.length).toBe(queryCount);
    expect(firstQuote).toContain("42.38"); expect(firstQuote).toContain(quote);
    const afterQuote = wires, attribution = await turn(approved, sources);
    expect(attribution).toContain(quote); expect(attribution).toMatch(/didn't (?:run|use) a search engine/i);
    expect(queries.length).toBe(queryCount); expect(gets.length).toBe(readCount + 1); expect(wires).toBe(afterQuote);
    expect(prompts.length).toBe(decisions); expect(await api("/permissions/@muse")).toEqual(savedPolicy);
    const audit = await api("/approvals/history") as { records: { conversationId: number; source: string; decision: string; scope: string }[] };
    expect(audit.records.some(r => r.conversationId === approved && r.source === "https://finance.yahoo.com" && r.decision === "allowedByPolicy" && r.scope === "action")).toBe(true);

    beforeNextQuote = async () => { await setAction(siteAction, null); };
    const revoked = await turn(approved, lookup);
    expect(beforeNextQuote).toBeUndefined();
    expect(revoked).not.toContain("42.38"); expect(gets.length).toBe(readCount + 1);
    expect(queries.length).toBe(queryCount); expect(prompts.length).toBe(decisions);
    await setAction("ox.web.browser.publicPages", "allow");
    mode = "noResults";
    await turn(approved, lookup);
    expect(queries.slice(queryCount)).toEqual([subject]); expect(gets.length).toBe(readCount + 1);
    await setAction(siteAction, "allow");
    await setAction("ox.web.search", "block");
    await turn(approved, lookup);
    expect(queries.length).toBe(queryCount + 1); expect(gets.length).toBe(readCount + 1);
  } finally {
    server?.stop(true); await host?.close(); model.stop(true); globalThis.fetch = native; restore();
    await rm(data, { recursive: true, force: true });
  }
}, 120_000);

import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Host } from "../../../../../apps/linux/src/host";
import { startServer } from "../../../../../apps/linux/src/server";

test("J06 evidence search keeps the requested itinerary before asking a search engine for fares", async () => {
  const data = await mkdtemp(join(tmpdir(), "ox-evidence-fare-")), engine = "duckduckgo.com";
  const fare = "https://fares.example/offer", policy = "https://fares.example/policy";
  const statement = "PDX to BOI, April 8 to April 13, 2031, nonstop round trip: USD 594 total for three adults.";
  const booking = "Reservations may open up to 330 days before departure; the booking window is not a fare.";
  const flags = { OPENOX_PERSONAL_AGENT: "1", OPENOX_MUSE_PARITY: "1", OPENOX_EVIDENCE_ONLY: "1",
    OPENOX_VERTEX_ADC: "0", OPENOX_MEDIA_URL: "http://media.invalid", OX_HOST_TEST_ORIGINS: `https://${engine},${fare}` };
  const previous = Object.fromEntries(Object.keys(flags).map(k => [k, process.env[k]]));
  const correct = "PDX to BOI return fares Apr 8 2031 returning Apr 13 2031 three adults";
  const drift = "how far in advance do airlines open flight bookings";
  const original = "Compare round-trip fares from PDX to BOI for 3 adults, departing 2031-04-08 and returning 2031-04-13. Give the party total and source.";
  const queries: string[] = [], reads: string[] = [], proposed: string[] = [];
  let attempts: string[] = [], answerable = true, host: Host | undefined, server: Awaited<ReturnType<typeof startServer>> | undefined;
  const native = globalThis.fetch;
  const model = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (new URL(request.url).pathname === "/v1/models") return Response.json({ data: [{ id: "fixture" }] });
    const body = await request.json() as { tools: { function: { name: string } }[]; messages: { role: string; content: string }[] };
    const tools = body.tools.map(t => t.function.name), last = body.messages.at(-1)!;
    let name: string, args: object;
    if (tools.includes("ox_evidence_route")) { name = "ox_evidence_route"; args = { kind: "public", language: "en" }; }
    else if (last.role === "tool" && last.content.startsWith('{"sources":')) {
      const [s] = (JSON.parse(last.content) as { sources: { id: number; url: string; passages: { id: number; text: string }[] }[] }).sources;
      if (!s) throw new Error("No actual source for this fixture turn.");
      name = "ox_evidence_answer"; args = s.url === fare
        ? { purpose: "Quote the matching party fare", selections: [{ source: s.id, passages: [s.passages[0]!.id] }] }
        : { purpose: "Report that no fare was verified", unverifiedSource: s.id };
    } else if (last.role === "tool" && last.content.includes('"sourceDocuments"')) {
      name = "ox_evidence_sources"; args = { purpose: "Inspect the pages that were actually read" };
    } else {
      const query = attempts.shift();
      if (!query) throw new Error(`No scripted search remains: ${last.content.slice(0, 400)}`);
      proposed.push(query); name = "ox_evidence_search"; args = { purpose: "Check public fares", query, domains: [engine] };
    }
    const delta = { role: "assistant", tool_calls: [{ index: 0, id: crypto.randomUUID(), type: "function", function: { name, arguments: JSON.stringify(args) } }] };
    const chunk = (value: object, finish_reason: string | null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: value, finish_reason }] })}\n\n`;
    return new Response(chunk(delta, null) + chunk({}, "tool_calls") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  } });
  try {
    Object.assign(process.env, flags);
    globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname === "127.0.0.1" && [model.port, server?.port].includes(Number(url.port))) return native(input, init);
      if (url.href === `${flags.OPENOX_MEDIA_URL}/health`) return new Response(null, { status: 503 });
      if (![fare, policy].includes(url.href)) throw new Error(`Unplanned fixture origin: ${url.origin}`);
      expect(init?.method).toBe("GET"); reads.push(url.href);
      return new Response(url.href === fare ? statement : booking, { headers: { "content-type": "text/plain" } });
    }, { preconnect: native.preconnect });
    host = await Host.open({ data, hostID: "Isolated fare ledger", version: "test", quiet: true });
    const open = host.browser.open.bind(host.browser);
    host.browser.open = async (...args) => {
      const live = await open(...args);
      await live.page.route("**/*", route => {
        const url = new URL(route.request().url());
        if (url.origin !== `https://${engine}` || route.request().method() !== "GET") return route.abort();
        const q = url.searchParams.get("q"); if (!q) return route.abort();
        queries.push(q);
        const target = q === correct && answerable ? fare : policy;
        return route.fulfill({ contentType: "text/html", body: `<div class="result"><a class="result__a" href="${target}">Controlled airline source</a></div>` });
      });
      return live;
    };
    await host.setCustomProvider({ name: "Local fare fixture", baseUrl: `http://127.0.0.1:${model.port}/v1`, models: ["fixture"] });
    server = await startServer(host, { hostname: "127.0.0.1", port: 0 });
    const { token } = await host.devices.add("Fare checker", "cli");
    const api = async (path: string, body?: object) => {
      const response = await native(`http://127.0.0.1:${server!.port}/api${path}`, { method: body ? "POST" : "GET",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
      if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
      return response.json();
    };
    const run = async (text: string, sequence: string[], sourceAvailable = true) => {
      // Start each trial with no resident result page, so the observed navigations equal the dispatched searches.
      await host!.browser.closeOwner(`service:${engine}`);
      attempts = [...sequence]; answerable = sourceAvailable;
      const path = `/conversations/${await host!.profile.create({ provider: "custom", modelId: "fixture" })}`;
      const at = queries.length, seen = reads.length, start = proposed.length, approvals: string[] = [];
      await api(path + "/messages", { text });
      const until = Date.now() + 18_000;
      while (Date.now() < until) {
        const v = await api(path) as { busy: boolean; error?: string; pendingPrompt?: { id: string; prompt: string };
          blocks: { kind: { type: string; items?: { text?: string }[] } }[] };
        if (v.pendingPrompt) { approvals.push(v.pendingPrompt.prompt); await api(path + "/respond", { promptId: v.pendingPrompt.id, answer: "Approve" }); }
        else if (!v.busy) {
          expect(v.error).toBeFalsy();
          return { engine: queries.slice(at), pages: reads.slice(seen), proposed: proposed.slice(start), approvals,
            text: v.blocks.filter(b => b.kind.type === "agentContent").flatMap(b => b.kind.items?.map(i => i.text) ?? []).join("\n") };
        }
        await Bun.sleep(40);
      }
      throw new Error("Local fare lookup did not settle");
    };
    const clean = await run(original, [correct]);
    expect(clean.engine).toEqual([correct]); expect(clean.pages).toEqual([fare]); expect(clean.text).toContain(statement);
    const wrong = [drift, correct.replace("PDX", "BOS"), correct.replace("BOI", "ORD"), correct.replace("Apr 13", "Apr 14"), correct.replace("three adults", "one adult")];
    for (const candidate of wrong) {
      const actual = await run(original, [candidate, correct]);
      expect(actual.engine).toEqual([correct]); expect(actual.pages).toEqual([fare]); expect(actual.proposed).toEqual([candidate, correct]);
      expect(actual.approvals.length).toBe(clean.approvals.length); expect(actual.text).toContain(statement); expect(actual.text).not.toContain(booking);
    }
    const unavailable = await run(original, [correct], false);
    expect(unavailable.text).toContain("couldn't verify"); expect(unavailable.text).toContain(policy); expect(unavailable.text).not.toContain("USD 594");
  } finally {
    server?.stop(true); await host?.close(); model.stop(true); globalThis.fetch = native;
    for (const [k,v] of Object.entries(previous)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await rm(data, { recursive: true, force: true });
  }
}, 120_000);

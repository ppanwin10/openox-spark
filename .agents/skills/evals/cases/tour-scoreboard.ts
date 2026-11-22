import { succeeded } from "../scripts/checks.ts";
import type { EvalCase } from "../scripts/types.ts";

const pages = [
  { url: "https://courts.example/results", match: "ATP · Alder / Reed", score: "4–2", at: "2031-05-18T15:10:00Z" },
  { url: "https://draw.example/results", match: "WTA · Vale / Lark", score: "3–5", at: "2031-05-18T15:12:00Z" },
];
const hits = pages.map(p => ({ title: p.match, url: p.url, snippet: "Score at the start of play: 0–0." }));

export default {
  task: "Make board.html for today's ATP and WTA scores using public websites. Include each match as reported, its source link and full source timestamp. A dated snapshot is sufficient.",
  stubs: { functions: {
    "ox.web.search": [{ result: { query: { $arg: "query" }, results: [{ service: "search.example", items: hits, nextCursor: null, scope: "public", coverage: "partial" }], errors: [] } }],
    "ox.web.fetch": pages.map(p => {
      const text = `${p.match} · ${p.score} · ${p.at}`;
      return { args: { url: p.url }, result: { ok: true, status: 200, statusText: "OK", url: p.url, redirected: false, headers: {}, kind: "html",
        filename: "results.html", bytes: Buffer.byteLength(text), text, truncated: false, attached: false, unsupported: null } };
    }),
  } },
  checks: async run => {
    const text = await run.read("board.html") ?? "";
    return [
      { detail: "Discovered the sources and read both public pages without a connector", passed: succeeded(run, "ox.web.search").length > 0
        && pages.every(p => succeeded(run, "ox.web.fetch").some(c => c.args.url === p.url)) && !run.calls.some(c => c.name.startsWith("ox.service.")) },
      { detail: "Saved both scores from the documents, not the search previews", passed: pages.every(p => text.includes(p.match) && text.includes(p.score)) && !text.includes("0–0") },
      { detail: "Kept original source links and timestamps", passed: pages.every(p => text.includes(p.url) && text.includes(p.at)) },
    ];
  },
} satisfies EvalCase;

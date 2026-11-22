import { succeeded } from "../scripts/checks.ts";
import type { EvalCase } from "../scripts/types.ts";

const name = "web:courts.example:scoreboard";
const feed = { asOf: "2031-05-18T15:10:00Z", matches: [{ name: "ATP · Alder / Reed", score: "4–2" }, { name: "WTA · Vale / Lark", score: "3–5" }] };
const service = { domain: "courts.example", kind: "web", name: "Courts Wire", attached: true };

export default {
  task: "Make board.html for today's ATP and WTA scores. Include the score and match names exactly as reported, source and observation time. A dated snapshot is sufficient.",
  attached: [{ domain: service.domain, description: "Courts Wire: tour results", login: "signedIn" }],
  stubs: { functions: {
    "ox.service.listAttached": [{ result: [service] }],
    "ox.service.inspect": [{ result: { service, actions: { scoreboard: { name, description: "Read current ATP and WTA scores.", inputSchema: { type: "object", properties: {} }, outputSchema: { type: "object", properties: { asOf: { type: "string" }, matches: { type: "array" } } } } } } }],
    "ox.service.invoke": [{ args: { name, input: {} }, result: feed }],
  } },
  checks: async run => {
    const text = await run.read("board.html") ?? "";
    return [
      { detail: "Read the authorized original tour source", passed: succeeded(run, "ox.service.invoke").some(c => c.args.name === name) },
      { detail: "Both reported matches and scores reached the actual artifact", passed: feed.matches.every(m => text.includes(m.name) && text.includes(m.score)) },
      { detail: "Identify the source and date of the snapshot", passed: /courts wire|courts\.example/i.test(text) && /2031-05-18|May 18,? 2031|18 May 2031/i.test(text) },
    ];
  },
} satisfies EvalCase;

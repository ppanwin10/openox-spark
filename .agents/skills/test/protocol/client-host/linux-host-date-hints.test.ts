import { expect, test } from "bun:test";
import { withSendTimes } from "../../../../../apps/linux/src/providers";

const sent = async (text: string, gate: boolean) => {
  const prior = process.env.OPENOX_DATE_HINTS;
  if (gate) process.env.OPENOX_DATE_HINTS = "1"; else delete process.env.OPENOX_DATE_HINTS;
  try {
    let seen: any;
    const models = { stream: (_model: unknown, context: any) => { seen = context; return "ok"; } };
    const wrapped = withSendTimes(models as any) as any;
    wrapped.stream({ id: "fixture" }, { messages: [{ role: "user", content: text, timestamp: Date.parse("2026-11-24T20:00:00Z") }] });
    return seen.messages[0].content as string;
  } finally { if (prior === undefined) delete process.env.OPENOX_DATE_HINTS; else process.env.OPENOX_DATE_HINTS = prior; }
};

test("Explicit calendar dates in a user message carry their distance from the send date", async () => {
  const content = await sent("Depart Dec 18, 2026 evening or Dec 19, return 2026-12-27. 也可以2027年1月5日出发。Last year: March 3, 2025.", true);
  const [stamp, hint] = content.split("\n");
  expect(stamp).toMatch(/^\[\w{3} 2026-11-24 /);
  expect(hint).toContain("Dec 18, 2026 = in 24 days");
  expect(hint).toContain("2026-12-27 = in 33 days");
  expect(hint).toContain("2027年1月5日 = in 42 days");
  expect(hint).toContain("March 3, 2025 = 631 days ago");
  expect(hint).not.toContain("Dec 19 =");
});

test("Messages without explicit years, and the default-off gate, keep the original stamp only", async () => {
  expect((await sent("Remind me on Dec 19 please", true)).split("\n")[1]).toBe("");
  expect((await sent("Depart Dec 18, 2026", false)).split("\n")[1]).toBe("");
});

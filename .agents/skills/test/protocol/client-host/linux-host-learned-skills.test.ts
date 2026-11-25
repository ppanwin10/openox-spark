import { expect, test } from "bun:test";
import { verifyExtraction } from "../../../../../packages/agent/src/adapters/linux/learned";

const page = [
  "Search results. Prices include required taxes + fees for 2 adults.",
  "8:05 PM – 10:46 PM Delta 2 hr 41 min Nonstop $525 round trip Departure Sat, Dec 19",
  "7:47 PM – 10:25 PM Frontier 2 hr 38 min Nonstop $546 round trip Departure Sat, Dec 19",
  "Price insights. " + "The cheapest time to book is usually now. ".repeat(30),
  "Other departing flights 9:27 PM – 11:59 PM Alaska 2 hr 32 min Nonstop $555 round trip",
  "Track prices from Seattle to Las Vegas departing 2026-12-19 and returning 2026-12-26",
].join("\n\n");

test("Learned LS-01 keeps rows whose values appear together on the page and adds verified page-wide values", () => {
  const result = verifyExtraction(page, {
    page: { party: "Prices include required taxes + fees for 2 adults", trip: "Track prices from Seattle to Las Vegas departing 2026-12-19 and returning 2026-12-26" },
    rows: [{ airline: "Delta", depart: "8:05 PM", price: "$525", fare: "round trip", date: "Sat, Dec 19" },
      { airline: "Frontier", depart: "7:47 PM", price: "$546", fare: "round trip", date: "Sat, Dec 19" }],
  });
  expect(result.kept).toBe(2); expect(result.dropped).toBe(0);
  expect(result.lines[0]).toBe("airline: Delta · depart: 8:05 PM · price: $525 · fare: round trip · date: Sat, Dec 19 · party: Prices include required taxes + fees for 2 adults · trip: Track prices from Seattle to Las Vegas departing 2026-12-19 and returning 2026-12-26");
});

test("Learned LS-02 drops invented values, mixed rows and unverified page-wide values", () => {
  const result = verifyExtraction(page, {
    page: { party: "Prices include taxes for 4 adults" },
    rows: [{ airline: "Delta", price: "$199" }, { airline: "Delta", price: "$555" }, { airline: "Frontier", price: "$546" }, { airline: "Delta", price: 525 as unknown as string }],
  });
  expect(result.lines).toEqual(["airline: Frontier · price: $546"]);
  expect(result.kept).toBe(1); expect(result.dropped).toBe(3); expect(result.droppedPage).toBe(1);
});

test("Learned LS-03 matches across whitespace differences but never partial values", () => {
  const result = verifyExtraction("Total   $1,234.50\nfor two adults", { rows: [{ total: "Total $1,234.50" }, { total: "$1,234.5" }, { total: "$234.50" }] });
  expect(result.lines).toEqual(["total: Total $1,234.50"]);
});

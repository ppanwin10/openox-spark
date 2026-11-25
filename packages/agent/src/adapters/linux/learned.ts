// Generic checks for values returned by agent-written learned skills (decision 0030).
// Code output is never trusted: every value must appear in the page text the Host captured.
export interface Extraction { page?: Record<string, unknown>; rows?: Record<string, unknown>[] }
export interface VerifiedExtraction { lines: string[]; kept: number; dropped: number; droppedPage: number }

const rowWindow = 600, maxRows = 50, maxValue = 300, maxFields = 12;
const normal = (text: string) => text.normalize("NFKC").replace(/\s+/g, " ").trim();
const wordChar = /[\p{L}\p{N}]/u;

function occurrences(text: string, value: string) {
  const found: number[] = [];
  for (let at = text.indexOf(value); at >= 0; at = text.indexOf(value, at + 1)) {
    const before = text[at - 1], after = text.slice(at + value.length, at + value.length + 2);
    const startsWord = wordChar.test(value[0]!), endsWord = wordChar.test(value[value.length - 1]!);
    if (startsWord && before !== undefined && wordChar.test(before)) continue;
    if (endsWord && (wordChar.test(after[0] ?? "") || /^[.,]\p{N}/u.test(after))) continue;
    found.push(at);
  }
  return found;
}
function fields(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value).slice(0, maxFields);
  if (!entries.length || entries.some(([key, item]) => !/^[A-Za-z][\w ]{0,39}$/.test(key) || typeof item !== "string" || !normal(item) || item.length > maxValue)) return undefined;
  return entries.map(([key, item]) => [key, normal(item as string)] as const);
}
function together(text: string, values: readonly string[]) {
  const spots = values.map(value => occurrences(text, value));
  if (spots.some(list => !list.length)) return false;
  const anchor = spots.reduce((best, list) => list.length < best.length ? list : best);
  return anchor.some(at => {
    let low = at, high = at;
    for (const [index, list] of spots.entries()) {
      const near = list.filter(spot => Math.abs(spot - at) <= rowWindow);
      if (!near.length) return false;
      const spot = near.reduce((best, item) => Math.abs(item - at) < Math.abs(best - at) ? item : best);
      low = Math.min(low, spot); high = Math.max(high, spot + values[index]!.length);
    }
    return high - low <= rowWindow;
  });
}

export function verifyExtraction(pageText: string, extraction: Extraction): VerifiedExtraction {
  const text = normal(pageText);
  const page = Object.entries(extraction.page ?? {}).slice(0, maxFields);
  const verifiedPage = page.filter(([key, value]) => /^[A-Za-z][\w ]{0,39}$/.test(key) && typeof value === "string" && normal(value)
    && value.length <= maxValue && occurrences(text, normal(value)).length > 0).map(([key, value]) => `${key}: ${normal(value as string)}`);
  const rows = (Array.isArray(extraction.rows) ? extraction.rows : []).slice(0, maxRows);
  const lines: string[] = [];
  for (const row of rows) {
    const entries = fields(row);
    if (!entries || !together(text, entries.map(([, value]) => value))) continue;
    lines.push([...entries.map(([key, value]) => `${key}: ${value}`), ...verifiedPage].join(" · "));
  }
  return { lines, kept: lines.length, dropped: rows.length - lines.length, droppedPage: page.length - verifiedPage.length };
}

export type SearchScope = "all" | "chats" | "files";
export type SearchRange = { start: number; end: number };
export type SearchResult = { id: string; kind: "conversation" | "message" | "file"; title: string; snippet: string; match: SearchRange | null;
  source: { conversationId: number; mainChat: boolean } | { fileId: string; path: string } };
export type SearchPage = { available: true; epoch: number; requestId: string; query: string; scope: SearchScope; items: SearchResult[];
  nextCursor: string | null; complete: boolean; expiresAt: number; coverage: { sources: number; bytes: number; issues: { code: string; count: number }[] } };
export const searchFold = (text: string) => text.normalize("NFC").toUpperCase().toLowerCase().normalize("NFC");
const segmenter = new Intl.Segmenter("und", { granularity: "grapheme" });
export function searchRange(text: string, query: string): SearchRange | null {
  const needle = searchFold(query), at = searchFold(text).indexOf(needle);
  if (!needle || at < 0) return null;
  let folded = 0, start = 0;
  for (const part of segmenter.segment(text)) {
    const end = folded + searchFold(part.segment).length;
    if (folded <= at && at < end) start = part.index;
    if (end >= at + needle.length) return { start, end: part.index + part.segment.length };
    folded = end;
  }
  return null;
}
export function searchSnippet(text: string, range: SearchRange | null) {
  const start = range ? Math.max(0, range.start - 80) : 0;
  const from = start > 0 && /[\uDC00-\uDFFF]/u.test(text[start]!) ? start - 1 : start;
  const end = range ? Math.min(text.length, range.end + 80) : Math.min(text.length, 240);
  const to = end < text.length && /[\uDC00-\uDFFF]/u.test(text[end]!) ? end + 1 : end;
  const prefix = from ? "…" : "", suffix = to < text.length ? "…" : "";
  return { snippet: prefix + text.slice(from, to) + suffix, match: range ? { start: range.start - from + prefix.length, end: range.end - from + prefix.length } : null };
}

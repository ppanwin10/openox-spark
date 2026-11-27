import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ToolResultEntry, type ConversationId, type Cursor, type EntryId, type EntryRecord } from "@earendil-works/pi-durable";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import type { ProfileRuntime } from "../../profile/runtime";

const tickerPattern = "^[A-Z]{1,5}(?:[.-][A-Z])?$";
const enginesSchema = Type.Array(Type.String({ pattern: "^[a-z0-9.-]{1,100}$" }), { maxItems: 3 });
const receiptSchema = Type.Object({
  engines: enginesSchema,
  attempted: Type.Optional(enginesSchema),
  pages: Type.Array(Type.String({ maxLength: 4096 }), { maxItems: 8 }),
  ticker: Type.Optional(Type.String({ pattern: tickerPattern })),
  requestedTicker: Type.Optional(Type.String({ pattern: tickerPattern })),
}, { additionalProperties: false });
export type LookupReceipt = Static<typeof receiptSchema>;
export type LookupScope = { kind: "search" | "page" | "sources" | "finance"; subject: string; urls: Set<string>;
  ticker?: string; observed: LookupReceipt };
export type LocalLookupAnswer = { text: string; sourceEntry?: number };
const answerKind = "ox.lookup.answer";

export function localLookupEntry(text: string, answer: LocalLookupAnswer) {
  return { kind: answerKind, model: [{ role: "user" as const, content: text, timestamp: Date.now() }], data: { lookupAnswer: answer } };
}

export function localLookupAnswer(entry: EntryRecord): LocalLookupAnswer | undefined {
  if (entry.kind !== answerKind || entry.model?.length !== 1 || entry.model[0]?.role !== "user") return;
  const answer = entry.data && typeof entry.data === "object" && !Array.isArray(entry.data) && entry.data.lookupAnswer;
  if (answer && typeof answer === "object" && !Array.isArray(answer) && typeof answer.text === "string")
    return { text: answer.text, ...(typeof answer.sourceEntry === "number" ? { sourceEntry: answer.sourceEntry } : {}) };
}

function lookupRecord(entry: EntryRecord | undefined, id: number) {
  if (!entry || entry.conversationId !== id || !ToolResultEntry.is(entry) || entry.byTaskId === undefined) return;
  const message = entry.model?.[0];
  if (message?.role !== "toolResult" || !["ox_web_search", "ox_web_fetch"].includes(message.toolName)) return;
  const receipt = message.details && typeof message.details === "object" && "lookupReceipt" in message.details && message.details.lookupReceipt;
  if (Value.Check(receiptSchema, receipt)) return { sourceEntry: entry.id as number, receipt, searched: message.toolName === "ox_web_search" };
}

async function adjacentLookup(runtime: ProfileRuntime, id: number, followSourceAnswer: boolean) {
  return runtime.harness.commit(async tx => {
    let cursor: Cursor | undefined;
    for (let i = 0; i < 8; i++) {
      const page = await tx.scanEntries({ conversationId: id as ConversationId }, 8, cursor);
      for (const entry of page.items) {
        if (entry.conversationId !== id || entry.kind === "pi.reset") return;
        const record = lookupRecord(entry, id);
        if (record) return record;
        if (entry.model?.some(message => message.role === "user")) {
          const ref = followSourceAnswer && localLookupAnswer(entry)?.sourceEntry;
          if (ref && ref < entry.id) return lookupRecord((await tx.scanEntries({ conversationId: id as ConversationId,
            minEntryId: ref as EntryId, maxEntryId: ref as EntryId }, 1)).items[0], id);
          return;
        }
      }
      if (!page.next) return;
      cursor = page.next;
    }
  }, BACKGROUND_CONTEXT);
}

export async function resolveLookupFollowup(runtime: ProfileRuntime, id: number, scope: LookupScope, request: string): Promise<LocalLookupAnswer | undefined> {
  if (scope.kind !== "sources" && scope.kind !== "finance") return;
  const previous = scope.ticker ? undefined : await adjacentLookup(runtime, id, scope.kind === "finance");
  if (scope.kind === "sources") {
    const zh = /\p{Script=Han}/u.test(request);
    if (!previous) return { text: zh ? "这个对话的上一轮没有可核对的公开查询记录。我没有重新搜索。" : "I don't have a verified public lookup record for the preceding turn in this chat. I didn't run a new search." };
    const { attempted, engines, pages } = previous.receipt;
    const links = pages.map(url => `- <${url}>`).join("\n");
    if (zh) return { sourceEntry: previous.sourceEntry, text: [
      ...(attempted?.length ? [`尝试过的搜索引擎：${attempted.join("、")}。`] : []),
      previous.searched ? engines.length ? `返回了结果的搜索引擎：${engines.join("、")}。` : "没有搜索引擎返回结果的记录。" : "那次查询没有使用搜索引擎。",
      pages.length ? `实际读到的网页：\n${links}` : "那次查询没有成功读取公开网页。",
    ].join("\n\n") };
    return { sourceEntry: previous.sourceEntry, text: [
      ...(attempted?.length ? [`Search engines I tried: ${attempted.join(", ")}.`] : []),
      previous.searched ? `Search engines that returned results: ${engines.length ? engines.join(", ") : "none recorded"}.` : "I didn't use a search engine for that lookup.",
      pages.length ? `Pages I successfully read:\n${links}` : "I didn't successfully read a public page.",
    ].join("\n\n") };
  }
  const ticker = scope.ticker ?? previous?.receipt.requestedTicker ?? (previous?.receipt.pages.length ? previous.receipt.ticker : undefined);
  if (!ticker) return { text: "Which stock ticker should I check on Yahoo Finance? I couldn't identify one from the preceding public lookup in this chat." };
  scope.ticker = ticker;
  scope.subject = `https://finance.yahoo.com/quote/${scope.ticker}/`;
  scope.urls.add(scope.subject);
}

export function stockReply(scope: LookupScope, output: string | undefined) {
  const ticker = scope.ticker!;
  if (output && new RegExp(tickerPattern).test(ticker)) {
    let parsed;
    try { parsed = JSON.parse(output); } catch {}
    const symbol = new RegExp(`(?:^|[^A-Za-z0-9.-])${ticker.replace(".", "\\.")}(?![A-Za-z0-9.-])`);
    const pages = scope.kind === "finance" ? [parsed] : parsed?.sourceDocuments;
    if (Array.isArray(pages)) for (const page of pages) {
      if (page?.ok !== true || typeof page.text !== "string" || !scope.observed.pages.includes(page.url)
        || scope.kind === "finance" && page.url !== scope.subject) continue;
      if (/captcha|verify (?:you|your)|sign in to continue|access denied/i.test(page.text)) {
        scope.observed.pages = scope.observed.pages.filter(url => url !== page.url);
        continue;
      }
      const relevant = (page.text as string).split(/\n\s*\n/).map(s => s.trim()).filter(s => symbol.test(s)
        && /\b(?:price|quote|stock|shares?|ticker|close|USD)\b|\$/i.test(s));
      if (!relevant.length) continue;
      scope.observed.ticker = ticker;
      const passage = relevant.find(s => s.length <= 600 && s.split(/\s+/).length <= 80 && !/\b(?:targets?|forecast|projection|estimated)\b/i.test(s)
        && s.split(symbol).slice(1).some(afterSymbol =>
          /^(?:['’]s|\))?[ \t]+(?:(?:(?:regular-session|stock|share|last|closing|market) )?(?:quote|price)\s*(?:[:=]|is\b|was\b)|(?:shares? )?(?:closed|traded|trading) at)\s*(?:[$€£]|USD\s*)?\d/i.test(afterSymbol)));
      if (!passage) continue;
      const label = page.kind === "html" && page.url === `https://finance.yahoo.com/quote/${ticker}/` ? "Quote snapshot" : "Public quote excerpt";
      return `${label} from <${page.url}> (not independently verified as live):\n\n> ${passage.replace(/[\\\x60*_{}[\]<>#!|~]/g, "\\$&").replace(/\n/g, "\n> ")}`;
    }
  }
  return scope.kind === "finance" ? `I couldn't verify a quote for ${ticker} on Yahoo Finance from its public quote page.`
    : `I couldn't verify a quote for ${ticker} from the public pages returned by this lookup.`;
}

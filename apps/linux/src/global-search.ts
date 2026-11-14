import { OxError } from "@openox/agent/linux";
import type { SearchChat, SearchFile, SearchInventory, SearchPart } from "../../../packages/agent/src/adapters/linux/search";
import { searchOwnerLimits } from "../../../packages/agent/src/adapters/linux/search";
import { searchRange, searchSnippet, type SearchPage, type SearchRange, type SearchResult, type SearchScope } from "./search-contract";
import type { Host } from "./host";
import { sameOrigin } from "./auth";
import { museParityEnabled } from "./config";
import { HTTPError, json } from "./http";

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const hash = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");
export const globalSearchLimits = { queries: 4, ttl: 120_000, requestBytes: 8 * 1_048_576, queryBytes: 64 * 1_048_576,
  entries: 128, queryReferences: 2_000, references: 4_000, cancellations: 512, pageBytes: 65_536, targetBytes: 2 * 1_048_576 };
type Anchor = { kind: "conversation"; conversationId: number; revision: string }
  | { kind: "message"; conversationId: number; entry: number; source: string; revision: string; range: SearchRange }
  | { kind: "file"; fileId: string; revision: string; range: SearchRange | null };
type Candidate = Omit<SearchResult, "id"> & { key: string; anchor: Anchor };
type Query = { id: string; owner: string; profile: string; epoch: number; query: string; scope: SearchScope; limit: number;
  expires: number; controller: AbortController; busy: boolean; cursor: string | null; inventory?: SearchInventory;
  chat: number; title: boolean; before: number | null; part: number; file: number; terminal: boolean;
  sources: number; bytes: number; issues: Map<string, number>; seen: Set<string>; refs: Set<string>; pending?: Candidate };
type Reference = { query: Query; anchor: Anchor };
type Work = { units: number; bytes: number; entry?: { chat: number; before: number | null; parts: SearchPart[]; id: number; native: boolean; bytes: number } };
const changed = () => new HTTPError(409, "Search sources changed. Search again; no incomplete continuation or replacement source was returned.");
const issue = (query: Query, code: string, count = 1) => query.issues.set(code, (query.issues.get(code) ?? 0) + count);

export class GlobalSearch {
  private readonly queries = new Map<string, Query>();
  private readonly references = new Map<string, Reference>();
  private readonly cancelled = new Map<string, number>();
  private readonly host: Host;
  constructor(host: Host) { this.host = host; }

  private remove(query: Query) {
    query.controller.abort();
    this.queries.delete(query.id);
    for (const id of query.refs) this.references.delete(id);
  }
  private expire() {
    for (const [id, expires] of this.cancelled) if (expires <= Date.now()) this.cancelled.delete(id);
    for (const query of this.queries.values()) if (query.expires <= Date.now() || query.epoch !== this.host.contentEpoch
      || query.profile !== this.host.profile.id) this.remove(query);
  }
  private parameters(url: URL) {
    const allowed = ["q", "scope", "limit", "requestId", "cursor"];
    for (const key of url.searchParams.keys()) if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1) throw new HTTPError(400, "Invalid or repeated Search parameter.");
    const raw = url.searchParams.get("q") ?? "", query = raw.trim().normalize("NFC"), scope = url.searchParams.get("scope") ?? "all";
    const limit = url.searchParams.get("limit") ?? "20", id = url.searchParams.get("requestId"), cursor = url.searchParams.get("cursor");
    if (Array.from(raw).length > 200 || Buffer.byteLength(raw) > 800 || /[\u0000-\u001f\u007f]/u.test(raw) || !raw.isWellFormed()
      || !["all", "chats", "files"].includes(scope) || !/^[1-9]\d?$/.test(limit) || Number(limit) > 50 || !id || !uuid.test(id)
      || cursor !== null && !uuid.test(cursor)) throw new HTTPError(400, "Use a literal query of at most 200 characters, a valid Search scope, page size and request identity.");
    return { query, scope: scope as SearchScope, limit: Number(limit), id, cursor };
  }
  private current(query: Query, signal: AbortSignal) {
    signal.throwIfAborted();
    if (this.queries.get(query.id) !== query || query.epoch !== this.host.contentEpoch || query.profile !== this.host.profile.id
      || query.expires <= Date.now()) throw changed();
  }
  private async inventory(query: Query, signal: AbortSignal) {
    const inventory = await this.host.profile.searchOwner().inventory(signal);
    this.current(query, signal);
    if (query.inventory && query.inventory.stamp !== inventory.stamp) throw changed();
    if (!query.inventory) {
      query.inventory = inventory;
      if (inventory.unregistered) issue(query, "unregistered-files", inventory.unregistered);
    }
    return inventory;
  }
  private nextChat(query: Query) { query.chat++; query.title = false; query.before = null; query.part = 0; }
  private match(query: Query, text: string) { return query.query ? searchRange(text, query.query) : null; }
  private conversation(chat: SearchChat, range: SearchRange | null): Candidate {
    return { kind: "conversation", title: chat.title, ...searchSnippet(chat.title, range), source: { conversationId: chat.id, mainChat: chat.mainChat },
      key: `title:${chat.id}`, anchor: { kind: "conversation", conversationId: chat.id, revision: hash(chat.title) } };
  }
  private file(file: SearchFile, text?: string, range: SearchRange | null = null, nameRange: SearchRange | null = null): Candidate {
    const name = file.path.split("/").at(-1)!;
    return { kind: "file", title: name, ...searchSnippet(range ? text! : name, range ?? nameRange),
      source: { fileId: file.id, path: file.path }, key: `file:${file.id}`, anchor: { kind: "file", fileId: file.id, revision: file.sha256, range } };
  }

  private async next(query: Query, work: Work, signal: AbortSignal): Promise<Candidate | null | undefined> {
    const inventory = query.inventory!, owner = this.host.profile.searchOwner();
    if (query.pending) { const result = query.pending; query.pending = undefined; return result; }
    if (!query.query) {
      const chat = query.scope === "files" ? undefined : inventory.chats[query.chat], file = query.scope === "chats" ? undefined : inventory.files[query.file];
      if (!chat && !file) return null;
      query.sources++;
      if (chat && (!file || chat.at >= file.mtime)) { query.chat++; return this.conversation(chat, null); }
      query.file++; return this.file(file!);
    }
    while (query.scope !== "files" && query.chat < inventory.chats.length) {
      this.current(query, signal);
      const chat = inventory.chats[query.chat]!;
      if (!query.title) {
        query.title = true; query.sources++;
        const range = this.match(query, chat.title);
        if (range) return this.conversation(chat, range);
      }
      if (work.units >= globalSearchLimits.entries || work.bytes >= globalSearchLimits.requestBytes) return undefined;
      if (query.before !== null && query.before < 0) { this.nextChat(query); continue; }
      let loaded = work.entry;
      if (!loaded || loaded.chat !== chat.id || loaded.before !== query.before) {
        const entry = await owner.entry(chat.id, query.before, signal);
        work.units++;
        if (!entry) { this.nextChat(query); continue; }
        const bytes = Buffer.byteLength(JSON.stringify(entry));
        work.bytes += bytes; query.bytes += bytes; query.sources++;
        if (bytes > searchOwnerLimits.sourceBytes) {
          issue(query, "source-too-large"); query.before = entry.id - 1; query.part = 0; continue;
        }
        loaded = { chat: chat.id, before: query.before, id: entry.id as number, bytes, native: entry.kind === "ox.native.transcript",
          parts: await owner.parts(chat.id, entry) };
        work.entry = loaded;
        if (loaded.native) issue(query, "unprepared-transcript");
      }
      if (query.bytes >= globalSearchLimits.queryBytes) { issue(query, "scan-limit"); query.terminal = true; return null; }
      while (query.part < loaded.parts.length) {
        const part = loaded.parts[query.part++]!, range = this.match(query, part.text);
        if (!range) continue;
        return { kind: "message", title: chat.title, ...searchSnippet(part.text, range), source: { conversationId: chat.id, mainChat: chat.mainChat },
          key: `message:${part.source}`, anchor: { kind: "message", conversationId: chat.id, source: part.source, entry: part.entry, revision: hash(part.text), range } };
      }
      query.before = loaded.id - 1; query.part = 0; work.entry = undefined;
    }
    while (query.scope !== "chats" && query.file < inventory.files.length) {
      this.current(query, signal);
      if (work.units >= globalSearchLimits.entries || work.bytes >= globalSearchLimits.requestBytes) return undefined;
      const file = inventory.files[query.file++]!;
      work.units++; query.sources++;
      const name = file.path.split("/").at(-1)!, nameRange = this.match(query, name);
      let text: string | undefined, range: SearchRange | null = null;
      if (query.query) {
        try {
          const result = await owner.text(file, signal);
          if (result.issue) issue(query, result.issue);
          else {
            text = result.text; range = this.match(query, text);
            work.bytes += file.size; query.bytes += file.size;
          }
        } catch (error) {
          signal.throwIfAborted();
          if (error instanceof OxError && error.code === "conflict") throw changed();
          issue(query, "unreadable-text");
        }
      }
      if (query.bytes >= globalSearchLimits.queryBytes) { issue(query, "scan-limit"); query.terminal = true; return null; }
      if (!query.query || range || nameRange) {
        return this.file(file, text, range, nameRange);
      }
    }
    return null;
  }

  private async page(request: Request, url: URL, owner: string) {
    const params = this.parameters(url);
    if (this.cancelled.has(`${owner}:${params.id}`)) throw new HTTPError(409, "This Search request was cancelled. Start a fresh request.");
    let query = this.queries.get(params.id);
    if (params.cursor) {
      if (!query || query.owner !== owner) throw new HTTPError(404, "This Search continuation expired or belongs to another owner.");
      if (query.cursor !== params.cursor || query.query !== params.query || query.scope !== params.scope || query.limit !== params.limit) throw changed();
    } else {
      if (query) throw new HTTPError(409, "This Search request already exists. Continue it or start a fresh request.");
      if (this.queries.size >= globalSearchLimits.queries) throw new HTTPError(429, "Too many active searches. Close an earlier search or wait two minutes.");
      query = { id: params.id, owner, profile: this.host.profile.id, epoch: this.host.contentEpoch, query: params.query, scope: params.scope, limit: params.limit,
        expires: Date.now() + globalSearchLimits.ttl, controller: new AbortController(), busy: false, cursor: null,
        chat: 0, title: false, before: null, part: 0, file: 0, terminal: false, sources: 0, bytes: 0, issues: new Map(), seen: new Set(), refs: new Set() };
      this.queries.set(query.id, query);
    }
    if (query.busy) throw new HTTPError(409, "This Search page is still being scanned. Do not replay a continuation.");
    query.busy = true;
    const signal = AbortSignal.any([request.signal, query.controller.signal, AbortSignal.timeout(15_000)]);
    try {
      await this.inventory(query, signal);
      const items: SearchResult[] = [], work: Work = { units: 0, bytes: 0 };
      let exhausted = false, size = 1_024;
      while (items.length < query.limit) {
        const candidate = await this.next(query, work, signal);
        if (candidate === undefined) break;
        if (candidate === null) { exhausted = true; break; }
        if (query.seen.has(candidate.key)) continue;
        const { key, anchor, ...metadata } = candidate;
        const bytes = Buffer.byteLength(JSON.stringify(metadata)) + 64;
        if (bytes > globalSearchLimits.pageBytes - 3_072) throw new HTTPError(413, "One original Search snippet exceeds the result-page budget. Use a more specific query.");
        if (size + bytes > globalSearchLimits.pageBytes - 2_048) { query.pending = candidate; break; }
        if (query.refs.size >= globalSearchLimits.queryReferences || this.references.size >= globalSearchLimits.references) {
          issue(query, "reference-limit"); query.terminal = true; exhausted = true; break;
        }
        const id = crypto.randomUUID();
        this.references.set(id, { query, anchor }); query.refs.add(id); query.seen.add(key);
        items.push({ id, ...metadata }); size += bytes;
      }
      await this.inventory(query, signal);
      this.current(query, signal);
      if (!(await this.host.devices.list()).some(device => device.id === owner)) throw new HTTPError(401, "Pair this device first.");
      query.cursor = exhausted || query.terminal ? null : crypto.randomUUID();
      const result: SearchPage = { available: true, requestId: query.id, query: query.query, scope: query.scope, epoch: query.epoch,
        items, nextCursor: query.cursor, complete: exhausted && !query.terminal && !query.issues.size, expiresAt: query.expires,
        coverage: { sources: query.sources, bytes: query.bytes, issues: [...query.issues].map(([code, count]) => ({ code, count })) } };
      if (Buffer.byteLength(JSON.stringify(result)) > globalSearchLimits.pageBytes) throw new HTTPError(413, "Search metadata exceeds the result-page budget.");
      return json(result);
    } catch (error) {
      this.remove(query);
      throw error;
    } finally { query.busy = false; }
  }

  private async target(request: Request, id: string, owner: string, download: boolean) {
    if (!uuid.test(id)) throw new HTTPError(400, "Invalid Search target.");
    const reference = this.references.get(id);
    if (!reference || reference.query.owner !== owner) throw new HTTPError(404, "This Search target expired or belongs to another owner. Search again.");
    const { query, anchor } = reference, signal = AbortSignal.any([request.signal, query.controller.signal, AbortSignal.timeout(15_000)]);
    this.current(query, signal);
    const source = this.host.profile.searchOwner(), inventory = await source.inventory(signal);
    let target: object;
    if (anchor.kind === "file") {
      const file = inventory.files.find(file => file.id === anchor.fileId || file.aliases?.includes(anchor.fileId));
      if (!file || file.sha256 !== anchor.revision) throw changed();
      if (download) {
        const bytes = await source.download(file, signal);
        this.current(query, signal);
        return new Response(bytes, { headers: { "cache-control": "no-store", "content-type": "application/octet-stream",
          "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.path.split("/").at(-1)!)}`, "x-content-type-options": "nosniff" } });
      }
      const content = await source.text(file, signal);
      if (anchor.range && (!content.text || searchRange(content.text, query.query)?.start !== anchor.range.start)) throw changed();
      target = { kind: "file", fileId: anchor.fileId, path: file.path, text: content.text ?? null, range: anchor.range, issue: content.issue ?? null,
        downloadURL: `/api/search/targets/${id}/content` };
    } else {
      if (download) throw new HTTPError(404, "Not found");
      const chat = inventory.chats.find(chat => chat.id === anchor.conversationId);
      if (!chat) throw changed();
      if (anchor.kind === "conversation") {
        if (hash(chat.title) !== anchor.revision) throw changed();
        target = { kind: "chat", conversationId: chat.id, source: null, range: null };
      } else {
        const entry = await source.entry(chat.id, anchor.entry, signal);
        if (!entry || entry.id !== anchor.entry) throw changed();
        const part = (await source.parts(chat.id, entry)).find(part => part.source === anchor.source);
        if (!part || hash(part.text) !== anchor.revision) throw changed();
        target = { kind: "chat", conversationId: chat.id, source: anchor.source, range: anchor.range,
          view: await this.host.profile.searchView(chat.id, anchor.entry, signal) };
      }
    }
    this.current(query, signal);
    if ((await source.inventory(signal)).stamp !== inventory.stamp) throw changed();
    const result = { available: true, epoch: query.epoch, target };
    if (Buffer.byteLength(JSON.stringify(result)) > globalSearchLimits.targetBytes) throw new HTTPError(413, "The original target exceeds the Search preview budget.");
    return json(result);
  }

  async route(request: Request, url: URL, parts: string[], owner: string) {
    if (!museParityEnabled()) throw new HTTPError(404, "Not found");
    if (!sameOrigin(request)) throw new HTTPError(403, "Use the paired workspace origin for Search.");
    this.expire();
    try {
      if (!parts.length && request.method === "GET") return await this.page(request, url, owner);
      if (parts.length === 1 && request.method === "DELETE" && uuid.test(parts[0]!)) {
        const query = this.queries.get(parts[0]!);
        const key = `${owner}:${parts[0]!}`;
        if (!this.cancelled.has(key) && this.cancelled.size >= globalSearchLimits.cancellations) throw new HTTPError(429, "Search cancellation identity limit reached. Wait two minutes.");
        this.cancelled.set(key, Date.now() + globalSearchLimits.ttl);
        if (query?.owner === owner) this.remove(query);
        return json({ cancelled: true });
      }
      if (parts[0] === "targets" && (parts.length === 2 || parts.length === 3 && parts[2] === "content") && request.method === "GET" && !url.search) {
        return await this.target(request, parts[1]!, owner, parts.length === 3);
      }
      throw new HTTPError(404, "Not found");
    } catch (error) {
      if (error instanceof HTTPError) throw error;
      if (request.signal.aborted || error instanceof DOMException && ["AbortError", "TimeoutError"].includes(error.name)) throw new HTTPError(408, "Search was cancelled or timed out. Start a fresh search.");
      if (error instanceof OxError) throw new HTTPError(error.code === "conflict" ? 409 : error.code === "limit_exceeded" ? 507 : 503, error.message);
      throw new HTTPError(503, "Original Search sources are unavailable. Retry; no empty replacement result was returned.");
    }
  }
}

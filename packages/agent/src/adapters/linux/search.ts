import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId, Cursor, EntryId, EntryRecord } from "@earendil-works/pi-durable";
import type { ProfileRuntime } from "../../profile/runtime";
import { ConversationPresentation } from "../../profile/conversations";
import { ConversationApplicationMetadata } from "../../profile/install";
import { ConversationIndex } from "../../profile/conversation-index";
import { conversationRecordPath, type ProfileFileRecord } from "../../profile/file-store";
import { diskPath, digest } from "./files";
import { displayed, userInput } from "./transcript";
import { OxError } from "./functions";

const context = BACKGROUND_CONTEXT;
const privateRoot = /^(app|state|vm|logs|cookies|history|chats|tmp|repositories|mounts)(\/|$)/i;
const unsupported = /\.(pdf|png|jpe?g|gif|webp|avif|bmp|mp[34]|mov|webm|wav|m4a|aac|ogg|opus|flac|zip|gz|docx?|xlsx?|pptx?)$/i;
export const searchOwnerLimits = { conversations: 5_000, files: 10_000, inventoryBytes: 4 * 1_048_576, sourceBytes: 1_048_576 };
export type SearchChat = { id: number; title: string; mainChat: boolean; at: number; latest: number | null };
export type SearchFile = Pick<ProfileFileRecord, "id" | "aliases" | "path" | "size" | "sha256" | "mtime" | "owner"> & { physical: string };
export type SearchInventory = { chats: SearchChat[]; files: SearchFile[]; unregistered: number; stamp: string };
export type SearchPart = { source: string; text: string; entry: number };
const conflict = () => new OxError("conflict", "The original search source changed. Search again before opening it.");
const limited = () => new OxError("limit_exceeded", "Search inventory exceeds 5,000 conversations, 10,000 files or 4 MiB of metadata. Narrowing cannot certify a complete inventory.");
const physicalStamp = (info: Awaited<ReturnType<typeof lstat>>) => [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs, info.mode].join(":");

export class ProfileSearch {
  private readonly runtime: ProfileRuntime;
  private readonly content: string;
  constructor(runtime: ProfileRuntime, content: string) { this.runtime = runtime; this.content = content; }

  async inventory(signal: AbortSignal): Promise<SearchInventory> {
    signal.throwIfAborted();
    const state = await this.runtime.files.state();
    if (state.pending.length || state.pendingIndex) throw new OxError("unavailable", "Original file publication is incomplete. Retry after it settles.");
    const indexed = (await this.runtime.harness.snapshot(ConversationIndex, context))?.rows ?? {};
    const chats: SearchChat[] = [];
    let cursor: Cursor | undefined, count = 0, bytes = 0;
    do {
      signal.throwIfAborted();
      const page = await this.runtime.harness.commit(tx => tx.scanConversations({}, 100, cursor), context);
      count += page.items.length;
      if (count > searchOwnerLimits.conversations) throw limited();
      for (const record of page.items) {
        signal.throwIfAborted();
        if (state.deletedConversations.includes(record.id)) continue;
        const [presentation, metadata, latest] = await Promise.all([
          this.runtime.harness.snapshot(ConversationPresentation, record.id, context),
          this.runtime.harness.snapshot(ConversationApplicationMetadata, record.id, context),
          this.runtime.harness.commit(tx => tx.latestEntryId(record.id), context),
        ]);
        if (presentation?.visible !== true || metadata?.fields.temporary === true) continue;
        const created = metadata?.fields.createdAt;
        const chat = { id: record.id as number, title: presentation.title, mainChat: metadata?.fields.mainChat === true,
          at: indexed[String(record.id)]?.at ?? (typeof created === "number" ? (created + 978_307_200) * 1_000 : 0), latest: latest as number | undefined ?? null };
        bytes += Buffer.byteLength(JSON.stringify(chat));
        if (bytes > searchOwnerLimits.inventoryBytes) throw limited();
        chats.push(chat);
      }
      cursor = page.next;
    } while (cursor);
    chats.sort((a, b) => b.at - a.at || b.id - a.id);
    const visible = new Set(chats.map(chat => chat.id));
    const publicPath = (path: string) => {
      if (privateRoot.test(path) || conversationRecordPath(path)) return false;
      const conversation = /^conversations\/(\d+)(\/|$)/.exec(path);
      return !conversation || visible.has(Number(conversation[1]));
    };
    const records = Object.values(state.files).filter(file => !file.hidden && publicPath(file.path) && (file.owner === null || visible.has(file.owner)));
    if (records.length > searchOwnerLimits.files) throw limited();
    const known = new Map(records.map(file => [file.path, file])), files: SearchFile[] = [];
    let objects = 0, unregistered = 0;
    const root = await lstat(this.content);
    if (!root.isDirectory() || root.isSymbolicLink()) throw conflict();
    const walk = async (prefix: string) => {
      signal.throwIfAborted();
      for (const entry of (await readdir(prefix ? await diskPath(this.content, prefix) : this.content, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : 1)) {
        signal.throwIfAborted();
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (!publicPath(path)) continue;
        if (++objects > searchOwnerLimits.files) throw limited();
        if (entry.isSymbolicLink()) { unregistered++; continue; }
        if (entry.isDirectory()) { await walk(path); continue; }
        if (!entry.isFile()) { unregistered++; continue; }
        const original = known.get(path);
        if (!original) { unregistered++; continue; }
        const info = await lstat(await diskPath(this.content, path));
        if (!info.isFile() || info.isSymbolicLink()) throw conflict();
        const file: SearchFile = { id: original.id, aliases: original.aliases, path, size: original.size, sha256: original.sha256,
          mtime: original.mtime, owner: original.owner, physical: physicalStamp(info) };
        bytes += Buffer.byteLength(JSON.stringify(file));
        if (bytes > searchOwnerLimits.inventoryBytes) throw limited();
        files.push(file); known.delete(path);
      }
    };
    await walk("");
    unregistered += known.size;
    files.sort((a, b) => b.mtime - a.mtime || (a.id < b.id ? -1 : 1));
    const stamp = digest(new TextEncoder().encode(JSON.stringify([chats, files, unregistered])));
    return { chats, files, unregistered, stamp };
  }

  async entry(id: number, before: number | null, signal: AbortSignal) {
    signal.throwIfAborted();
    const handle = await this.runtime.harness.conversation(id as ConversationId, context);
    if (!handle) throw conflict();
    const page = await handle.entries(before === null ? {} : { maxEntryId: before as EntryId }, 1, undefined, context);
    signal.throwIfAborted();
    return page.items[0];
  }

  async parts(id: number, entry: EntryRecord): Promise<SearchPart[]> {
    if (!displayed(entry)) return [];
    const fields = (await this.runtime.harness.snapshot(ConversationApplicationMetadata, id as ConversationId, context))?.fields;
    const marks = [fields?.marks, fields?.scheduled].flatMap(value => Array.isArray(value) ? value : []);
    let note: { skill?: boolean; argument?: string; name?: string } | undefined;
    for (const raw of marks) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      let marked: unknown = raw.entry;
      if (marked === undefined && typeof raw.request === "string") marked = (await this.runtime.harness.commit(tx =>
        tx.submissionByRequest(id as ConversationId, raw.request as string), context))?.entry as number | undefined;
      if (marked === entry.id) note = raw as typeof note;
    }
    return entry.model!.flatMap((message, index) => {
      if (message.role === "user") {
        const text = note ? note.skill ? note.argument ?? "" : "" : userInput(message).text;
        return text ? [{ source: `${entry.id}:${index}:0`, text, entry: entry.id as number }] : [];
      }
      return message.role === "assistant" ? message.content.flatMap((part, at) => part.type === "text" && part.text
        ? [{ source: `${entry.id}:${index}:${at}`, text: part.text, entry: entry.id as number }] : []) : [];
    });
  }

  async text(file: SearchFile, signal: AbortSignal) {
    signal.throwIfAborted();
    if (file.size > searchOwnerLimits.sourceBytes) return { issue: "source-too-large" as const };
    if (unsupported.test(file.path)) return { issue: "unsupported-text" as const };
    const data = await this.read(file, signal);
    if (data.some(byte => byte < 9 || byte > 13 && byte < 32)) return { issue: "unsupported-text" as const };
    try { return { text: new TextDecoder("utf-8", { fatal: true }).decode(data) }; }
    catch { return { issue: "unsupported-text" as const }; }
  }

  async download(file: SearchFile, signal: AbortSignal) {
    if (file.size > 32 * 1_048_576) throw new OxError("limit_exceeded", "This original file exceeds the 32 MiB download budget.");
    return this.read(file, signal);
  }

  private async read(file: SearchFile, signal: AbortSignal) {
    signal.throwIfAborted();
    const path = await diskPath(this.content, file.path);
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await handle.stat();
      if (!before.isFile() || physicalStamp(before) !== file.physical || before.size !== file.size) throw conflict();
      const bytes = new Uint8Array(file.size + 1);
      let size = 0;
      while (size < bytes.length) {
        signal.throwIfAborted();
        const read = await handle.read(bytes, size, bytes.length - size, null);
        if (!read.bytesRead) break;
        size += read.bytesRead;
      }
      signal.throwIfAborted();
      const data = bytes.subarray(0, size);
      if (size !== file.size || physicalStamp(await handle.stat()) !== file.physical || digest(data) !== file.sha256) throw conflict();
      return data;
    } finally { await handle.close(); }
  }
}

import { isUtf8 } from "node:buffer";
import { readConversationPackage } from "./conversation-package";
import { HTTPError } from "./http";
import { zipDecode, type ZipFailure } from "./vm/skills-package";

export const memoryImportLimits = { upload: 8 * 1_048_576, expanded: 16 * 1_048_576, entry: 8 * 1_048_576, entries: 128,
  text: 512 * 1024, source: 32 * 1024, sources: 2_000, facts: 20, fact: 1_000, stages: 2, ttl: 10 * 60_000 };
export interface MemorySource { id: string; role: "user" | "owner"; text: string; label: string }
export interface MemoryPreview { format: "text" | "openox-conversation" | "chatgpt-history"; sources: MemorySource[]; excludedMessages: number }
const text = new TextDecoder("utf-8", { fatal: true });
const invalid = () => new HTTPError(400, "Choose nonempty UTF-8 text/Markdown, an OpenOx conversation package or a supported ChatGPT text-history ZIP.");
const large = () => new HTTPError(413, "Memory import exceeds its declared bounds. No truncated preview or partial history was accepted.");
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const hash = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex");
const zipFailure = (key: ZipFailure) => key === "tooLarge" ? large() : new HTTPError(400,
  key === "checksumMismatch" ? "The memory ZIP is damaged (CRC mismatch)." : `The memory ZIP was refused: ${key}.`);

function zipStructure(bytes: Uint8Array) {
  if (bytes.length < 22) throw invalid();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = bytes.length - 22;
  while (end >= Math.max(0, bytes.length - 65_557) && view.getUint32(end, true) !== 0x06054b50) end--;
  if (end < 0 || end + 22 > bytes.length) throw invalid();
  let cursor = view.getUint32(end + 16, true);
  const count = view.getUint16(end + 10, true);
  if (count > memoryImportLimits.entries) throw large();
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > end) throw invalid();
    const flags = view.getUint16(cursor + 8, true), attributes = view.getUint32(cursor + 38, true), mode = attributes >>> 16 & 0xf000;
    if (flags & 1) throw zipFailure("encrypted");
    if (![0, 0x8000, 0x4000].includes(mode)) throw zipFailure("unsafePath");
    const length = view.getUint16(cursor + 28, true), next = cursor + 46 + length + view.getUint16(cursor + 30, true) + view.getUint16(cursor + 32, true);
    if (next > end || cursor + 46 + length > bytes.length) throw invalid();
    const name = bytes.subarray(cursor + 46, cursor + 46 + length);
    if (!isUtf8(name)) throw zipFailure("unsafePath");
    const path = text.decode(name);
    if (/[\0-\x1f\x7f]/.test(path) || path !== path.normalize("NFC") || name.length > 4096) throw zipFailure("unsafePath");
    if ((path.endsWith("/") || attributes & 0x10 || mode === 0x4000) && (view.getUint32(cursor + 20, true) || view.getUint32(cursor + 24, true)
      || view.getUint32(cursor + 16, true))) throw zipFailure("invalidArchive");
    cursor = next;
  }
}

export function memoryFileName(value: string) {
  if (!value || value.length > 200 || /[/\\\0-\x1f\x7f]/.test(value) || value !== value.normalize("NFC")) throw invalid();
  return value;
}

export function readMemoryImport(bytes: Uint8Array, name: string): MemoryPreview {
  memoryFileName(name);
  if (bytes.length > memoryImportLimits.upload) throw large();
  if (!bytes.length) throw invalid();
  const sources: MemorySource[] = [];
  let total = 0, excludedMessages = 0;
  const add = (value: string, role: MemorySource["role"], label: string) => {
    if (/[\0-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) throw invalid();
    if (!value.trim()) return;
    const size = new TextEncoder().encode(value).length;
    total += size;
    if (size > memoryImportLimits.source || total > memoryImportLimits.text || sources.length >= memoryImportLimits.sources) throw large();
    sources.push({ id: `source-${sources.length + 1}`, role, text: value, label: label.slice(0, 200) });
  };
  if (/\.(txt|md)$/i.test(name)) {
    if (bytes.length > memoryImportLimits.text) throw large();
    if (!isUtf8(bytes)) throw invalid();
    for (const paragraph of text.decode(bytes).replace(/^\uFEFF/, "").split(/\r?\n[ \t]*\r?\n/)) add(paragraph, "owner", name);
    if (!sources.length) throw invalid();
    return { format: "text", sources, excludedMessages };
  }
  if (!/\.(zip|conversation)$/i.test(name)) throw invalid();
  zipStructure(bytes);
  const files = zipDecode(bytes, memoryImportLimits.upload, memoryImportLimits.entry, memoryImportLimits.entries, zipFailure, memoryImportLimits.expanded);
  if (files.some(file => file.path === "conversation.json" || file.path === "chat.json")) {
    const conversation = readConversationPackage(bytes);
    for (const turn of conversation.turns) {
      if (turn.type === "user") add(turn.user.intent, "user", conversation.header.title);
      else excludedMessages++;
    }
    if (!sources.length) throw invalid();
    return { format: "openox-conversation", sources, excludedMessages };
  }
  const history = files.find(file => file.path === "conversations.json");
  if (!history || !isUtf8(history.data)) throw invalid();
  let value: unknown;
  try { value = JSON.parse(text.decode(history.data)); } catch { throw invalid(); }
  if (!Array.isArray(value) || !value.length) throw invalid();
  let nodes = 0;
  const seen = new Set<string>();
  for (const conversation of value) {
    if (!object(conversation) || typeof conversation.id !== "string" || !conversation.id || typeof conversation.title !== "string"
      || !object(conversation.mapping) || seen.has(conversation.id)) throw invalid();
    seen.add(conversation.id);
    const mapping = conversation.mapping;
    if (!Object.keys(mapping).length || typeof conversation.current_node !== "string" || !Object.hasOwn(mapping, conversation.current_node)) throw invalid();
    for (const [id, node] of Object.entries(mapping)) {
      if (++nodes > 10_000) throw large();
      if (!object(node) || node.id !== id || !(node.parent === null || typeof node.parent === "string" && Object.hasOwn(mapping, node.parent))
        || !Array.isArray(node.children) || node.children.some(child => typeof child !== "string" || !Object.hasOwn(mapping, child))) throw invalid();
      if (node.message === null) continue;
      const message = node.message;
      if (!object(message) || typeof message.id !== "string" || !object(message.author)
        || !["user", "assistant", "system", "tool"].includes(String(message.author.role)) || !object(message.content)
        || typeof message.content.content_type !== "string") throw invalid();
      if (message.author.role !== "user") { excludedMessages++; continue; }
      if (message.content.content_type !== "text" || !Array.isArray(message.content.parts) || !message.content.parts.every(part => typeof part === "string")) throw invalid();
      add(message.content.parts.join("\n"), "user", `${conversation.title} · ${hash(id).slice(0, 12)}`);
    }
  }
  if (!sources.length) throw invalid();
  return { format: "chatgpt-history", sources, excludedMessages };
}

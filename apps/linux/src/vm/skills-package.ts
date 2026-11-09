import { isUtf8 } from "node:buffer";
import { crc32, inflateRawSync } from "node:zlib";
import { OxError } from "@openox/agent/linux";
import { isSkillResourcePath, RESERVED_SKILL_NAMES } from "@openox/protocol/skills";
import { isLocalSkillName, parseSkill, serializeSkill, validateSkill, type SkillContent } from "./skills-files";

export interface ZipFile { path: string; data: Uint8Array }
export const packageLimits = { archive: 1_048_576, entry: 524_288, entries: 64 };

const messages = {
  tooLarge: "This skill package is too large.",
  invalidArchive: "This isn't a valid skill package.",
  encrypted: "Encrypted skill packages aren't supported.",
  unsupportedCompression: "This skill package uses unsupported compression.",
  unsafePath: "This skill package contains an unsafe path.",
  invalidSkill: "This package doesn't contain a valid SKILL.md.",
  checksumMismatch: "This skill package appears to be damaged.",
};
const failure = (key: keyof typeof messages) => new OxError("invalid", messages[key], "Use a .skill package exported by Ox.");
export type ZipFailure = "tooLarge" | "invalidArchive" | "encrypted" | "unsupportedCompression" | "unsafePath" | "checksumMismatch";
type Fail = (key: ZipFailure) => Error;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const reserved = new Set<string>(RESERVED_SKILL_NAMES);

function checkPath(path: string, attributes: number, fail: Fail) {
  if (!path || path.startsWith("/") || path.includes("\\")) throw fail("unsafePath");
  const parts = (path.endsWith("/") ? path.slice(0, -1) : path).split("/");
  if (!parts.length || parts.some(part => !part || part === "." || part === "..")) throw fail("unsafePath");
  if (((attributes >>> 16) & 0xf000) === 0xa000) throw fail("unsafePath");
}

export function zipEncode(files: ZipFile[], maximum: number, fail: Fail = failure) {
  if (!files.length || files.length > 0xffff) throw fail("invalidArchive");
  const chunks: Uint8Array[] = [], central: Uint8Array[] = [];
  const paths = new Set<string>();
  let offset = 0, centralSize = 0;
  for (const file of files) {
    checkPath(file.path, 0, fail);
    const name = encoder.encode(file.path);
    if (file.path.endsWith("/") || paths.has(file.path.toLowerCase()) || name.length > 0xffff) throw fail("invalidArchive");
    paths.add(file.path.toLowerCase());
    if (file.data.length > 0xffffffff || offset > 0xffffffff) throw fail("tooLarge");
    const checksum = crc32(file.data) >>> 0;
    const local = new Uint8Array(30 + name.length), entry = new Uint8Array(46 + name.length);
    const head = new DataView(local.buffer), record = new DataView(entry.buffer);
    head.setUint32(0, 0x04034b50, true); head.setUint16(4, 20, true); head.setUint16(6, 0x0800, true); head.setUint16(12, 33, true);
    head.setUint32(14, checksum, true); head.setUint32(18, file.data.length, true); head.setUint32(22, file.data.length, true); head.setUint16(26, name.length, true);
    local.set(name, 30);
    record.setUint32(0, 0x02014b50, true); record.setUint16(4, 20, true); record.setUint16(6, 20, true); record.setUint16(8, 0x0800, true); record.setUint16(14, 33, true);
    record.setUint32(16, checksum, true); record.setUint32(20, file.data.length, true); record.setUint32(24, file.data.length, true); record.setUint16(28, name.length, true);
    record.setUint32(42, offset, true);
    entry.set(name, 46);
    chunks.push(local, file.data);
    central.push(entry);
    offset += local.length + file.data.length;
    centralSize += entry.length;
    if (offset + centralSize + 22 > maximum) throw fail("tooLarge");
  }
  const end = new Uint8Array(22), tail = new DataView(end.buffer);
  tail.setUint32(0, 0x06054b50, true); tail.setUint16(8, files.length, true); tail.setUint16(10, files.length, true);
  tail.setUint32(12, centralSize, true); tail.setUint32(16, offset, true);
  const archive = new Uint8Array(offset + centralSize + 22);
  let cursor = 0;
  for (const chunk of [...chunks, ...central, end]) { archive.set(chunk, cursor); cursor += chunk.length; }
  return archive;
}

export function zipDecode(data: Uint8Array, maximumArchive: number, maximumEntry: number, maximumEntries: number, fail: Fail = failure, maximumTotal = Number.POSITIVE_INFINITY): ZipFile[] {
  if (data.length > maximumArchive) throw fail("tooLarge");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const u16 = (at: number) => { if (at < 0 || at + 2 > data.length) throw fail("invalidArchive"); return view.getUint16(at, true); };
  const u32 = (at: number) => { if (at < 0 || at + 4 > data.length) throw fail("invalidArchive"); return view.getUint32(at, true); };
  if (data.length < 22) throw fail("invalidArchive");
  let end = -1;
  for (let cursor = data.length - 22; cursor >= Math.max(0, data.length - 65_557); cursor--) {
    if (u32(cursor) === 0x06054b50 && cursor + 22 + u16(cursor + 20) === data.length && u16(cursor + 4) === 0 && u16(cursor + 6) === 0
      && u16(cursor + 8) === u16(cursor + 10) && u16(cursor + 10) !== 0xffff) { end = cursor; break; }
  }
  if (end < 0) throw fail("invalidArchive");
  const count = u16(end + 10), centralSize = u32(end + 12), centralOffset = u32(end + 16);
  if (!count || count > maximumEntries || centralOffset + centralSize > end) throw fail("invalidArchive");
  const entries: { path: string; flags: number; method: number; checksum: number; compressed: number; size: number; offset: number; attributes: number }[] = [];
  const paths = new Set<string>();
  const centralEnd = centralOffset + centralSize;
  let cursor = centralOffset, total = 0;
  for (let index = 0; index < count; index++) {
    if (u32(cursor) !== 0x02014b50 || cursor + 46 > centralEnd) throw fail("invalidArchive");
    const nameLength = u16(cursor + 28), next = cursor + 46 + nameLength + u16(cursor + 30) + u16(cursor + 32);
    const compressed = u32(cursor + 20), size = u32(cursor + 24), attributes = u32(cursor + 38);
    total += size;
    if (u16(cursor + 34) !== 0 || !nameLength || next > centralEnd || compressed > maximumArchive || size > maximumEntry || total > maximumTotal) throw fail("tooLarge");
    const nameBytes = data.subarray(cursor + 46, cursor + 46 + nameLength);
    if (!isUtf8(nameBytes)) throw fail("unsafePath");
    const path = decoder.decode(nameBytes);
    checkPath(path, attributes, fail);
    if (paths.has(path.toLowerCase())) throw fail("invalidArchive");
    paths.add(path.toLowerCase());
    entries.push({ path, flags: u16(cursor + 8), method: u16(cursor + 10), checksum: u32(cursor + 16), compressed, size, offset: u32(cursor + 42), attributes });
    cursor = next;
  }
  if (cursor !== centralEnd) throw fail("invalidArchive");
  return entries.filter(entry => !entry.path.endsWith("/") && !(entry.attributes & 0x10)).map(entry => {
    if (entry.flags & 1) throw fail("encrypted");
    if (entry.method !== 0 && entry.method !== 8) throw fail("unsupportedCompression");
    if (entry.offset + 30 > centralOffset || u32(entry.offset) !== 0x04034b50) throw fail("invalidArchive");
    const nameStart = entry.offset + 30, nameEnd = nameStart + u16(entry.offset + 26), start = nameEnd + u16(entry.offset + 28), stop = start + entry.compressed;
    if (u16(entry.offset + 6) !== entry.flags || u16(entry.offset + 8) !== entry.method || nameEnd > centralOffset || stop > centralOffset
      || decoder.decode(data.subarray(nameStart, nameEnd)) !== entry.path) throw fail("invalidArchive");
    const body = data.subarray(start, stop);
    let content: Uint8Array;
    if (entry.method === 0) {
      if (entry.compressed !== entry.size) throw fail("invalidArchive");
      content = body.slice();
    } else {
      try { content = new Uint8Array(inflateRawSync(body, { maxOutputLength: entry.size + 1 })); } catch { throw fail("invalidArchive"); }
      if (content.length !== entry.size) throw fail("invalidArchive");
    }
    if ((crc32(content) >>> 0) !== entry.checksum) throw fail("checksumMismatch");
    return { path: entry.path, data: content };
  });
}

export function encodeSkillPackage(skill: SkillContent) {
  validateSkill(skill);
  const files: Record<string, string> = { ...skill.resources, "SKILL.md": serializeSkill(skill) };
  return zipEncode(Object.keys(files).sort().map(path => ({ path: `${skill.name}/${path}`, data: encoder.encode(files[path]!) })), packageLimits.archive);
}

export function decodeSkillPackage(data: Uint8Array): SkillContent {
  const files = zipDecode(data, packageLimits.archive, packageLimits.entry, packageLimits.entries);
  const main = files.find(file => file.path.endsWith("/SKILL.md"));
  const name = main?.path.split("/")[0] ?? "";
  if (!main || main.path !== `${name}/SKILL.md` || !isLocalSkillName(name) || reserved.has(name) || !isUtf8(main.data)) throw failure("invalidSkill");
  const skill = parseSkill(decoder.decode(main.data), name);
  if (!skill) throw failure("invalidSkill");
  for (const file of files.filter(file => file !== main)) {
    if (!file.path.startsWith(`${name}/`)) throw failure("unsafePath");
    const relative = file.path.slice(name.length + 1);
    if (!isSkillResourcePath(relative) || relative in skill.resources || !isUtf8(file.data)) throw failure("invalidSkill");
    skill.resources[relative] = decoder.decode(file.data);
  }
  validateSkill(skill);
  return skill;
}

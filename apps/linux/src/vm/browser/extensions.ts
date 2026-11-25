import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, normalize } from "node:path";
import { inflateRawSync } from "node:zlib";
import { OxError } from "@openox/agent/linux";

export type ExtensionRecord = { id: string; name: string; version: string; permissions: string[]; sites: string[]; installedAt: number };
export type PreparedExtension = ExtensionRecord & { staging: string };

const idPattern = /^[a-p]{32}$/;
const limits = { download: 32 * 1024 * 1024, unpacked: 128 * 1024 * 1024, entries: 5_000 };
const storeURL = (id: string) => (process.env.OX_EXTENSION_STORE_URL
  ?? "https://clients2.google.com/service/update2/crx?response=redirect&prodversion=131.0&acceptformat=crx2,crx3&x=id%3D{id}%26uc").replace("{id}", id);
const invalid = (message: string) => new OxError("invalid_argument", message, "Use the 32-letter extension ID from its Chrome Web Store address.");
const unavailable = (message: string) => new OxError("unavailable", message, "Tell the user the extension couldn't be installed. Nothing was installed.");

export const validExtensionID = (id: unknown): id is string => typeof id === "string" && idPattern.test(id);

function zipStart(data: Buffer) {
  if (data.subarray(0, 4).toString("latin1") !== "Cr24") return 0;
  const version = data.readUInt32LE(4);
  if (version === 3) return 12 + data.readUInt32LE(8);
  if (version === 2) return 16 + data.readUInt32LE(8) + data.readUInt32LE(12);
  throw unavailable("The extension package has an unsupported format.");
}

function unzip(zip: Buffer) {
  let end = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65_557); i--) if (zip.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  if (end < 0) throw unavailable("The extension package is not a readable archive.");
  const count = zip.readUInt16LE(end + 10);
  if (count > limits.entries) throw unavailable("The extension package has too many files.");
  const files = new Map<string, Buffer>();
  let offset = zip.readUInt32LE(end + 16), total = 0;
  for (let n = 0; n < count; n++) {
    if (zip.readUInt32LE(offset) !== 0x02014b50) throw unavailable("The extension package is damaged.");
    const method = zip.readUInt16LE(offset + 10), size = zip.readUInt32LE(offset + 20), full = zip.readUInt32LE(offset + 24);
    const nameLength = zip.readUInt16LE(offset + 28), extra = zip.readUInt16LE(offset + 30), comment = zip.readUInt16LE(offset + 32), local = zip.readUInt32LE(offset + 42);
    const name = zip.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    offset += 46 + nameLength + extra + comment;
    if (name.endsWith("/")) continue;
    const safe = normalize(name);
    if (!name || name.includes("\\") || name.startsWith("/") || /^[A-Za-z]:/.test(name) || safe.startsWith("..") || safe !== name.replace(/^\.\//, "")) throw unavailable("The extension package contains an unsafe file path.");
    total += full;
    if (total > limits.unpacked) throw unavailable("The extension package is too large once unpacked.");
    if (zip.readUInt32LE(local) !== 0x04034b50) throw unavailable("The extension package is damaged.");
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28), raw = zip.subarray(start, start + size);
    const data = method === 0 ? Buffer.from(raw) : method === 8 ? inflateRawSync(raw, { maxOutputLength: full + 1 }) : undefined;
    if (!data || data.length !== full) throw unavailable("The extension package uses an unsupported compression.");
    files.set(safe, data);
  }
  return files;
}

function summary(files: Map<string, Buffer>) {
  const json = (name: string) => { const data = files.get(name); if (!data) return undefined; try { return JSON.parse(data.toString("utf8").replace(/^\uFEFF/, "")) as Record<string, unknown>; } catch { return undefined; } };
  const manifest = json("manifest.json");
  if (!manifest || typeof manifest.version !== "string" || typeof manifest.name !== "string") throw unavailable("The extension has no readable manifest.");
  const locale = typeof manifest.default_locale === "string" ? manifest.default_locale : "en";
  const messages = json(`_locales/${locale}/messages.json`) ?? json("_locales/en/messages.json") ?? {};
  const text = (value: string) => value.replace(/^__MSG_(\w+)__$/, (_, key: string) => {
    const entry = Object.entries(messages).find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1] as { message?: unknown } | undefined;
    return typeof entry?.message === "string" ? entry.message : key;
  });
  const strings = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  const declared = [...strings(manifest.permissions), ...strings(manifest.optional_permissions)];
  const sites = [...new Set([...strings(manifest.host_permissions), ...declared.filter(item => item.includes("://") || item === "<all_urls>"),
    ...(Array.isArray(manifest.content_scripts) ? manifest.content_scripts.flatMap(script => strings((script as { matches?: unknown }).matches)) : [])])];
  return { name: text(manifest.name).slice(0, 120), version: manifest.version.slice(0, 40), permissions: [...new Set(declared.filter(item => !sites.includes(item)))], sites };
}

export class BrowserExtensions {
  private readonly directory: string;
  private readonly registry: string;
  constructor(directory: string) { this.directory = directory; this.registry = join(directory, "extensions.json"); }

  async list(): Promise<ExtensionRecord[]> {
    try { const value = JSON.parse(await readFile(this.registry, "utf8")) as { extensions?: ExtensionRecord[] }; return Array.isArray(value.extensions) ? value.extensions : []; }
    catch { return []; }
  }
  async paths() { return (await this.list()).map(item => join(this.directory, item.id)); }

  async prepare(id: string, signal?: AbortSignal): Promise<PreparedExtension> {
    if (!validExtensionID(id)) throw invalid("This isn't a Chrome Web Store extension ID.");
    const response = await fetch(storeURL(id), { redirect: "follow", signal }).catch(() => { throw unavailable("The Chrome Web Store couldn't be reached."); });
    if (!response.ok) throw unavailable(`The Chrome Web Store returned HTTP ${response.status} for this extension.`);
    const data = Buffer.from(await response.arrayBuffer());
    if (data.length > limits.download) throw unavailable("The extension package is too large.");
    const files = unzip(data.subarray(zipStart(data))), info = summary(files);
    const staging = join(this.directory, `.staging-${id}-${crypto.randomUUID()}`);
    for (const [name, content] of files) { const target = join(staging, name); await mkdir(dirname(target), { recursive: true, mode: 0o700 }); await writeFile(target, content, { mode: 0o600 }); }
    return { id, ...info, installedAt: Date.now(), staging };
  }

  async discard(prepared: PreparedExtension) { await rm(prepared.staging, { recursive: true, force: true }); }

  async commit(prepared: PreparedExtension) {
    const target = join(this.directory, prepared.id);
    await rm(target, { recursive: true, force: true });
    await rename(prepared.staging, target);
    const { staging: _, ...record } = prepared;
    await this.save([...(await this.list()).filter(item => item.id !== prepared.id), record]);
    return record;
  }

  async remove(id: string) {
    const current = await this.list();
    if (!current.some(item => item.id === id)) return false;
    await this.save(current.filter(item => item.id !== id));
    await rm(join(this.directory, id), { recursive: true, force: true });
    return true;
  }

  private async save(extensions: ExtensionRecord[]) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.registry}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify({ version: 1, extensions }, null, 2), { mode: 0o600 });
    await rename(temporary, this.registry);
  }
}

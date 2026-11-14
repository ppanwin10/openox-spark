import { constants } from "node:fs";
import { lstat, open, readdir, rmdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { OxError } from "./functions";
import { storagePath } from "./files";

export interface ContentEntry {
  path: string;
  kind: "file" | "directory";
  bytes: number;
  sha256: string | null;
  device: number;
  inode: number;
}
export const contentFileLimits = { bytes: 128 * 1_048_576, entry: 32 * 1_048_576, objects: 10_000 };
const roots = ["files", "state/trash", "state/staging", "state/scratch", "vm/scratch"];
const databases = ["state/state.sqlite", "state/state.sqlite-wal", "state/state.sqlite-shm"];
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";
const conflict = () => new OxError("conflict", "Workspace storage changed or contains an unsafe object. No complete result was produced.");
const tooLarge = () => new OxError("limit_exceeded", "Complete content operations are limited to 128 MiB, 32 MiB per file and 10,000 objects. Nothing was truncated.");

export class ContentFiles {
  private readonly directory: string;
  constructor(directory: string) { this.directory = directory; }

  private async path(relative: string) {
    const safe = storagePath(relative);
    if (!roots.some(root => safe === root || safe.startsWith(root + "/")) && !databases.includes(safe)) throw conflict();
    let path = this.directory;
    const root = await lstat(path);
    if (!root.isDirectory() || root.isSymbolicLink()) throw conflict();
    for (const part of safe.split("/")) {
      path = join(path, part);
      const info = await lstat(path).catch(error => { if (missing(error)) return undefined; throw error; });
      if (!info) break;
      if (info.isSymbolicLink() || !info.isDirectory() && !info.isFile()) throw conflict();
    }
    return join(this.directory, safe);
  }

  private async observe(relative: string): Promise<ContentEntry | undefined> {
    const path = await this.path(relative);
    const info = await lstat(path).catch(error => { if (missing(error)) return undefined; throw error; });
    if (!info) return undefined;
    if (!info.isDirectory() && !info.isFile()) throw conflict();
    if (info.isDirectory()) return { path: relative, kind: "directory", bytes: 0, sha256: null, device: info.dev, inode: info.ino };
    if (info.size > contentFileLimits.entry) throw tooLarge();
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await handle.stat(), hash = new Bun.CryptoHasher("sha256"), buffer = new Uint8Array(128 * 1024);
      let bytes = 0;
      for (;;) {
        const result = await handle.read(buffer, 0, buffer.length, null);
        if (!result.bytesRead) break;
        bytes += result.bytesRead;
        if (bytes > contentFileLimits.entry) throw tooLarge();
        hash.update(buffer.subarray(0, result.bytesRead));
      }
      const after = await handle.stat();
      if (info.ino !== before.ino || info.dev !== before.dev || bytes !== before.size || before.size !== after.size
        || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw conflict();
      return { path: relative, kind: "file", bytes, sha256: hash.digest("hex"), device: before.dev, inode: before.ino };
    } finally { await handle.close(); }
  }

  async inventory(database = false) {
    const entries: ContentEntry[] = [];
    let bytes = 0;
    const add = (entry: ContentEntry) => {
      entries.push(entry); bytes += entry.bytes;
      if (entries.length > contentFileLimits.objects || bytes > contentFileLimits.bytes) throw tooLarge();
    };
    const visit = async (relative: string) => {
      const current = await this.observe(relative);
      if (!current) return;
      if (current.kind !== "directory") throw conflict();
      for (const name of (await readdir(await this.path(relative))).sort()) {
        const child = `${relative}/${name}`, entry = await this.observe(child);
        if (!entry) throw conflict();
        add(entry);
        if (entry.kind === "directory") await visit(child);
      }
    };
    for (const root of roots) await visit(root);
    if (database) for (const path of databases) {
      const entry = await this.observe(path);
      if (entry) { if (entry.kind !== "file") throw conflict(); add(entry); }
    }
    return entries.sort((a, b) => a.path.localeCompare(b.path));
  }

  async database() {
    const entries: ContentEntry[] = [];
    for (const path of databases) {
      const entry = await this.observe(path);
      if (entry) { if (entry.kind !== "file") throw conflict(); entries.push(entry); }
    }
    return entries;
  }

  async read(entry: ContentEntry) {
    if (entry.kind !== "file") throw conflict();
    const observed = await this.observe(entry.path);
    if (JSON.stringify(observed) !== JSON.stringify(entry)) throw conflict();
    const handle = await open(await this.path(entry.path), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (stat.ino !== entry.inode || stat.dev !== entry.device || stat.size !== entry.bytes) throw conflict();
      const bytes = new Uint8Array(await handle.readFile());
      if (bytes.length !== entry.bytes || new Bun.CryptoHasher("sha256").update(bytes).digest("hex") !== entry.sha256) throw conflict();
      return bytes;
    } finally { await handle.close(); }
  }

  async erase(entry: ContentEntry) {
    const observed = await this.observe(entry.path);
    if (!observed) return;
    if (JSON.stringify(observed) !== JSON.stringify(entry)) throw conflict();
    const path = await this.path(entry.path);
    if (entry.kind === "file") await unlink(path);
    else await rmdir(path);
    const parent = await open(join(path, ".."), constants.O_RDONLY);
    try { await parent.sync(); } finally { await parent.close(); }
  }
}

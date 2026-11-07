import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rm, rmdir } from "node:fs/promises";
import { isUtf8 } from "node:buffer";
import { dirname, join } from "node:path";
import { FileError } from "@earendil-works/pi-durable/env";
import type { FileRecord } from "../../profile/file-record";
import type { FileMutation, FileObservation, ProfileFileBackend } from "../../profile/file-store";

const stagedName = /^staging\/(\.stage-[0-9a-f-]{36})$/;
const maximumEntries = 20_000;
const fileLimit = 32 * 1024 * 1024;
export const digest = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
type Observed = { kind: "missing" } | { kind: "directory" } | { kind: "other" } | { kind: "file"; size: number; sha256: string };

const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";

export function storagePath(value: string) {
  if (!value || value.startsWith("/") || value.includes("\\") || value.includes("\0")
    || value.split("/").some(part => !part || part === "." || part === "..")) throw new FileError("invalid", "Invalid Profile storage path", value);
  return value;
}

async function guardPath(content: string, path: string) {
  let current = content;
  for (const part of storagePath(path).split("/")) {
    current = join(current, part);
    const info = await lstat(current).catch(error => { if (missing(error)) return undefined; throw error; });
    if (!info) return;
    if (info.isSymbolicLink()) throw new FileError("permission_denied", "Symbolic links in Profile storage are not followed", path);
  }
}

export async function diskPath(content: string, path: string) {
  await guardPath(content, path);
  return join(content, storagePath(path));
}

async function readBytes(path: string) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { return new Uint8Array(await handle.readFile()); }
  finally { await handle.close(); }
}

async function hashFile(path: string) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const hasher = new Bun.CryptoHasher("sha256");
    const buffer = new Uint8Array(128 * 1024);
    let size = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      hasher.update(buffer.subarray(0, bytesRead));
      size += bytesRead;
    }
    return { size, sha256: hasher.digest("hex") };
  } finally { await handle.close(); }
}

export function diskProfileFiles(content: string, state: string): ProfileFileBackend {
  const staging = join(state, "staging");
  const trash = join(state, "trash");
  const contentPath = (value: string) => join(content, storagePath(value));
  const stagedPath = (value: string) => {
    const match = stagedName.exec(value);
    if (!match) throw new FileError("invalid", "Invalid staged file", value);
    return join(staging, match[1]!);
  };
  const sourcePath = (value: string) => value.startsWith("staging/") ? stagedPath(value) : contentPath(value);
  const guard = (path: string) => guardPath(content, path);
  const observe = async (path: string): Promise<Observed> => {
    const info = await lstat(path).catch(error => { if (missing(error)) return undefined; throw error; });
    if (!info) return { kind: "missing" };
    if (info.isDirectory()) return { kind: "directory" };
    if (!info.isFile()) return { kind: "other" };
    return { kind: "file", ...await hashFile(path) };
  };
  const verified = async (record: FileRecord) => {
    if (!record.path.startsWith("staging/")) await guard(record.path);
    if (record.size > fileLimit) throw new FileError("invalid", "Files over 32 MiB cannot be opened through the Profile; download them instead", record.path);
    const bytes = await readBytes(sourcePath(record.path)).catch(error => {
      if (missing(error)) throw new FileError("not_found", "File is missing from Profile storage", record.path);
      throw error;
    });
    if (bytes.length !== record.size || digest(bytes) !== record.sha256) throw new FileError("invalid", "File changed outside OpenOx; open it again", record.path);
    return bytes;
  };
  const applyOne = async (operation: FileMutation): Promise<boolean> => {
    await guard(operation.path);
    const target = contentPath(operation.path);
    if (operation.op === "mkdir") {
      const current = await observe(target);
      if (current.kind === "directory") return true;
      if (current.kind !== "missing") return false;
      await mkdir(target, { recursive: true, mode: 0o700 });
      return true;
    }
    if (operation.op === "replace") {
      const current = await observe(target);
      if (current.kind === "file" && current.size === operation.size && current.sha256 === operation.sha256) {
        await rm(stagedPath(operation.source), { force: true });
        return true;
      }
      const previous = operation.previous;
      if (current.kind === "directory" || current.kind === "other") return false;
      if (previous === null ? current.kind !== "missing" : current.kind !== "file" || current.size !== previous.size || current.sha256 !== previous.sha256) return false;
      const staged = await observe(stagedPath(operation.source));
      if (staged.kind !== "file" || staged.sha256 !== operation.sha256) return false;
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await rename(stagedPath(operation.source), target);
      return true;
    }
    if (operation.op === "move") {
      await guard(operation.source);
      const [destination, source] = await Promise.all([observe(target), observe(contentPath(operation.source))]);
      if (destination.kind === "file" && destination.sha256 === operation.sha256 && source.kind === "missing") return true;
      if (destination.kind !== "missing" || source.kind !== "file" || source.sha256 !== operation.sha256) return false;
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await rename(contentPath(operation.source), target);
      return true;
    }
    if (operation.op === "remove") {
      try {
        if (operation.directory) await rmdir(target);
        else {
          const info = await lstat(target);
          if (!info.isFile()) return false;
          await rm(target);
        }
      } catch (error) {
        if (missing(error)) return true;
        if ((error as NodeJS.ErrnoException).code === "ENOTEMPTY") return false;
        throw error;
      }
      return true;
    }
    const current = await observe(target);
    if (current.kind === "missing") return true;
    if ((current.kind === "directory") !== operation.directory) return false;
    const destination = join(trash, `${Date.now()}-${crypto.randomUUID()}`, operation.path);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await rename(target, destination);
    return true;
  };
  const inventory = async (prefix: string, known: Map<string, { size: number; sha256: string; binary: boolean; stamp?: string }>) => {
    const files: FileObservation[] = [];
    const directories: string[] = [];
    let entries = 0;
    const file = async (path: string) => {
      const absolute = contentPath(path);
      const info = await lstat(absolute);
      const stamp = `${info.ino}:${info.size}:${info.mtimeMs}`;
      const previous = known.get(path);
      if (previous?.stamp === stamp) {
        files.push({ path, size: previous.size, sha256: previous.sha256, binary: previous.binary, mtime: Math.floor(info.mtimeMs), stamp });
        return;
      }
      if (info.size > fileLimit) {
        files.push({ path, ...await hashFile(absolute), binary: true, mtime: Math.floor(info.mtimeMs), stamp });
        return;
      }
      const bytes = await readBytes(absolute);
      files.push({ path, size: bytes.length, sha256: digest(bytes), binary: !isUtf8(bytes), mtime: Math.floor(info.mtimeMs), stamp });
    };
    const visit = async (path: string) => {
      for (const entry of await readdir(path ? contentPath(path) : content, { withFileTypes: true })) {
        if (++entries > maximumEntries) throw new FileError("invalid", "Profile storage has too many entries");
        const child = path ? `${path}/${entry.name}` : entry.name;
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) { directories.push(child); await visit(child); }
        else if (entry.isFile()) await file(child);
      }
    };
    if (!prefix) await visit("");
    else {
      await guard(prefix);
      const parts = prefix.split("/");
      for (let index = 1; index < parts.length; index++) {
        const ancestor = parts.slice(0, index).join("/");
        const info = await lstat(contentPath(ancestor)).catch(error => { if (missing(error)) return undefined; throw error; });
        if (!info?.isDirectory()) return { files, directories };
        directories.push(ancestor);
      }
      const info = await lstat(contentPath(prefix)).catch(error => { if (missing(error)) return undefined; throw error; });
      if (info?.isDirectory()) { directories.push(prefix); await visit(prefix); }
      else if (info?.isFile()) await file(prefix);
    }
    return { files, directories };
  };
  return {
    async stage(bytes) {
      const name = `.stage-${crypto.randomUUID()}`;
      const handle = await open(join(staging, name), "wx", 0o600);
      try { await handle.writeFile(bytes); await handle.sync(); }
      finally { await handle.close(); }
      return { path: `staging/${name}`, size: bytes.length, sha256: digest(bytes) };
    },
    async validate(operations) {
      for (const operation of operations) {
        storagePath(operation.path);
        if (operation.op === "replace" && (await observe(stagedPath(operation.source))).kind !== "file") throw new FileError("invalid", "Staged file is missing", operation.path);
        if (operation.op === "move") storagePath(operation.source);
      }
    },
    async apply(operations) {
      for (const operation of operations) if (!await applyOne(operation)) return { conflict: true };
    },
    async snapshot(known, prefix = "") {
      return inventory(prefix, new Map(known.map(file => [file.path, file])));
    },
    read: verified,
    async readRange(record, offset, length) {
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > record.size) throw new FileError("invalid", "Invalid file range", record.path);
      return (await verified(record)).slice(offset, offset + length).toBase64();
    },
    async identifier() { return crypto.randomUUID(); },
    async inventory() { return []; },
    async verify(record) { await verified(record); },
    async sweep() {
      for (const name of await readdir(staging)) await rm(join(staging, name), { force: true, recursive: true });
    },
    async close() {},
  };
}

import { cp, lstat, mkdir, readdir, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { FileError, type FileBackend, type FileInfo } from "@openox/agent/linux";

export interface RepositoryRoots {
  bundled: string;
  local: string;
  connected(): { id: string; directory: string }[];
}

const fileLimit = 32 * 1024 * 1024;
const decoder = new TextDecoder("utf-8", { fatal: true });
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";

export function repositoryBackend(roots: RepositoryRoots): FileBackend {
  const resolve = (path: string, mutation = false) => {
    const parts = path.split("/").filter(Boolean);
    if (parts.some(part => part === "." || part === ".." || part.includes("\0"))) throw new FileError("invalid", "Invalid repository path", path);
    const [id, ...rest] = parts;
    if (!id) return { id: "", root: "", directory: "", relative: "" };
    const root = id === "bundled" ? roots.bundled : id === "local" ? roots.local : roots.connected().find(entry => entry.id === id)?.directory;
    if (!root) throw new FileError("not_found", "Repository not found", path);
    if (mutation && id !== "local") throw new FileError("permission_denied", `Repository ${id} is read-only; copy its source into repositories/local to change it`, path);
    return { id, root, directory: join(root, ...rest), relative: rest.join("/") };
  };
  const guard = async (root: string, relative: string, path: string) => {
    let current = root;
    for (const part of relative.split("/").filter(Boolean)) {
      current = join(current, part);
      const info = await lstat(current).catch(error => { if (missing(error)) return undefined; throw error; });
      if (!info) return;
      if (info.isSymbolicLink()) throw new FileError("permission_denied", "Symbolic links are not followed", path);
    }
  };
  const info = async (path: string): Promise<FileInfo> => {
    const target = resolve(path);
    const name = path.split("/").filter(Boolean).at(-1) ?? "";
    if (!target.id) return { name, path, kind: "directory", size: 0, mtimeMs: 0 };
    await guard(target.root, target.relative, path);
    const stat = await lstat(target.directory).catch(error => { if (missing(error)) throw new FileError("not_found", "File not found", path); throw error; });
    if (stat.isSymbolicLink()) throw new FileError("permission_denied", "Symbolic links are not followed", path);
    return { name, path, kind: stat.isDirectory() ? "directory" : "file", size: stat.isDirectory() ? 0 : stat.size, mtimeMs: Math.floor(stat.mtimeMs) };
  };
  const readText = async (path: string) => {
    const content = await read(path);
    if (typeof content !== "string") throw new FileError("invalid", "Edit requires an existing text file", path);
    return content;
  };
  const read = async (path: string): Promise<string | Uint8Array> => {
    const target = resolve(path);
    const stat = await info(path);
    if (stat.kind !== "file") throw new FileError("is_directory", "Expected a file", path);
    if (stat.size > fileLimit) throw new FileError("not_supported", "File is larger than 32 MiB", path);
    const bytes = new Uint8Array(await readFile(target.directory));
    try { return decoder.decode(bytes); } catch { return bytes; }
  };
  const writeAtomic = async (file: string, content: string | Uint8Array) => {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.ox-${crypto.randomUUID()}`;
    await writeFile(temporary, content, { mode: 0o600 });
    await rename(temporary, file);
  };
  return {
    id: `ox-repositories:${roots.local}`,
    assertWritable: path => { resolve(path, true); },
    info: async path => info(path),
    list: async path => {
      const target = resolve(path);
      if (!target.id) {
        const ids = ["bundled", "local", ...roots.connected().map(entry => entry.id)];
        return [...new Set(ids)].sort().map(id => ({ name: id, path: path ? `${path}/${id}` : id, kind: "directory" as const, size: 0, mtimeMs: 0 }));
      }
      if ((await info(path)).kind !== "directory") throw new FileError("not_directory", "Not a directory", path);
      const entries = await readdir(target.directory, { withFileTypes: true });
      const visible = entries.filter(entry => !entry.isSymbolicLink() && (entry.isFile() || entry.isDirectory()) && !entry.name.startsWith(".ox-") && entry.name !== ".git");
      return Promise.all(visible.sort((a, b) => a.name.localeCompare(b.name)).map(entry => info(`${path}/${entry.name}`)));
    },
    read: async path => read(path),
    write: async (path, content, _context, expected) => {
      const target = resolve(path, true);
      await guard(target.root, target.relative, path);
      if (expected !== undefined && await readText(path).catch(() => undefined) !== expected) throw new FileError("invalid", "File changed after reading; read again before editing", path);
      const existing = await lstat(target.directory).catch(() => undefined);
      if (existing?.isDirectory()) throw new FileError("is_directory", "A directory exists at this path", path);
      await writeAtomic(target.directory, content);
    },
    edit: async (path, edits) => {
      const target = resolve(path, true);
      const source = await readText(path);
      const ranges = edits.map(edit => {
        const start = source.indexOf(edit.oldText);
        if (!edit.oldText || start < 0 || source.indexOf(edit.oldText, start + 1) >= 0) throw new FileError("invalid", "Edit must match exactly once", path);
        return { ...edit, start, end: start + edit.oldText.length };
      }).sort((a, b) => a.start - b.start);
      if (ranges.some((range, index) => index > 0 && ranges[index - 1]!.end > range.start)) throw new FileError("invalid", "Edits overlap", path);
      let output = "", cursor = 0;
      for (const range of ranges) { output += source.slice(cursor, range.start) + range.newText; cursor = range.end; }
      await writeAtomic(target.directory, output + source.slice(cursor));
    },
    remove: async path => {
      const target = resolve(path, true);
      if ((await info(path)).kind !== "file") throw new FileError("is_directory", "Expected a file", path);
      await rm(target.directory);
    },
    createDirectory: async (path, _context, recursive) => {
      const target = resolve(path, true);
      await guard(target.root, target.relative, path);
      const existing = await lstat(target.directory).catch(() => undefined);
      if (existing) {
        if (existing.isDirectory() && recursive) return;
        throw new FileError("invalid", "Path already exists", path);
      }
      await mkdir(target.directory, { recursive: !!recursive, mode: 0o700 }).catch(error => {
        if (missing(error)) throw new FileError("not_found", "Parent directory not found", path);
        throw error;
      });
    },
    removeDirectory: async (path, recursive) => {
      const target = resolve(path, true);
      if (!target.relative) throw new FileError("permission_denied", "The Local repository root cannot be removed", path);
      if ((await info(path)).kind !== "directory") throw new FileError("not_directory", "Not a directory", path);
      if (recursive) await rm(target.directory, { recursive: true });
      else await rmdir(target.directory).catch(error => {
        if ((error as NodeJS.ErrnoException).code === "ENOTEMPTY") throw new FileError("invalid", "Directory is not empty", path);
        throw error;
      });
    },
    move: async (from, to) => {
      const source = resolve(from, true), target = resolve(to, true);
      await info(from);
      if (await lstat(target.directory).catch(() => undefined)) throw new FileError("invalid", "Destination already exists", to);
      await mkdir(dirname(target.directory), { recursive: true, mode: 0o700 });
      await rename(source.directory, target.directory);
    },
    copy: async (from, to) => {
      const source = resolve(from), target = resolve(to, true);
      await guard(source.root, source.relative, from);
      await info(from);
      if (await lstat(target.directory).catch(() => undefined)) throw new FileError("invalid", "Destination already exists", to);
      await mkdir(dirname(target.directory), { recursive: true, mode: 0o700 });
      await cp(source.directory, target.directory, { recursive: true, errorOnExist: true, force: false,
        filter: async entry => !entry.split("/").includes(".git") && !(await lstat(entry)).isSymbolicLink() });
    },
  };
}

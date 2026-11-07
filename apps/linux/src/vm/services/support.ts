import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { OxError } from "@openox/agent/linux";

export type Kind = "web" | "api" | "ios" | "mcp";
export type JSONObject = Record<string, unknown>;

export const describe = (error: unknown) => error instanceof Error ? error.message : String(error);
export const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
export const isObject = (value: unknown): value is JSONObject => !!value && typeof value === "object" && !Array.isArray(value);
export const clone = <T>(value: T): T => value === undefined ? value : JSON.parse(JSON.stringify(value)) as T;
export const sleep = (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds));
export const fail = (code: string, message: string, recovery?: string) => new OxError(code, message, recovery);

export function canonicalJSON(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(",")}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => `${JSON.stringify(key)}:${canonicalJSON(value[key])}`).join(",")}}`;
  return JSON.stringify(value ?? null);
}
export const same = (a: unknown, b: unknown) => canonicalJSON(a ?? null) === canonicalJSON(b ?? null);

export async function readJSONFile<T>(path: string, fallback: T): Promise<T> {
  let text: string;
  try { text = await readFile(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
  try { return JSON.parse(text) as T; }
  catch {
    await rename(path, `${path}.corrupt-${Date.now()}`).catch(() => {});
    return fallback;
  }
}

export async function writeJSONFile(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

export class Serial {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(work: () => Promise<T>): Promise<T> {
    const next = this.tail.then(work, work);
    this.tail = next.catch(() => {});
    return next;
  }
}

export async function withTimeout<T>(work: Promise<T>, milliseconds: number, timeout: () => Error, signal?: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined, abort: (() => void) | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(timeout()), milliseconds);
      if (signal) {
        abort = () => reject(fail("cancelled", "The run stopped before the service action finished", "Inspect the resulting state before retrying."));
        if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
      }
    })]);
  } finally {
    if (timer) clearTimeout(timer);
    if (abort) signal?.removeEventListener("abort", abort);
  }
}

export interface TreeFile { path: string; absolute: string; size: number }
export async function walk(root: string, options: { skipGit?: boolean } = {}): Promise<TreeFile[]> {
  const files: TreeFile[] = [];
  const visit = async (directory: string, prefix: string) => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      if (options.skipGit && entry.name === ".git") continue;
      const absolute = join(directory, entry.name), path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw fail("invalid_argument", `Symbolic links are not supported: ${path}`, "Replace symbolic links with regular files.");
      if (entry.isDirectory()) await visit(absolute, path);
      else if (entry.isFile()) files.push({ path, absolute, size: (await lstat(absolute)).size });
    }
  };
  await visit(root, "");
  return files;
}

export async function directoryHash(root: string) {
  const hash = createHash("sha256");
  for (const file of await walk(root)) {
    hash.update(file.path);
    hash.update(new Uint8Array(await readFile(file.absolute)));
  }
  return hash.digest("hex");
}

export async function fileHashes(root: string) {
  const files = [];
  for (const file of await walk(root)) {
    const data = new Uint8Array(await readFile(file.absolute));
    files.push({ path: file.path, bytes: data.length, sha256: sha256(data) });
  }
  return files;
}

export async function regularFile(path: string, maximum: number, label: string) {
  const info = await lstat(path).catch(() => undefined);
  if (!info || info.isSymbolicLink() || !info.isFile() || info.size > maximum) throw fail("invalid_argument", `Invalid file ${label}`, `Provide ${label} as a regular file of at most ${maximum} bytes.`);
  return info;
}

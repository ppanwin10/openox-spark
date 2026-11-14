import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { dirname } from "node:path";
import { OxError } from "@openox/agent/linux";

export const contentHash = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
export async function contentState(path: string) {
  const info = await lstat(path).catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; });
  if (!info) return null;
  if (!info.isFile() || info.isSymbolicLink()) throw new OxError("conflict", "An original content state file is unsafe.");
  if (info.size > 8 * 1_048_576) throw new OxError("limit_exceeded", "An original content state file exceeds 8 MiB.");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat(), data = new Uint8Array(await handle.readFile()), after = await handle.stat();
    if (before.ino !== info.ino || before.dev !== info.dev || before.size !== data.length || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new OxError("conflict", "An original content state file changed while reading.");
    }
    return { data, sha256: contentHash(data) };
  } finally { await handle.close(); }
}
export function resetSource(current: Awaited<ReturnType<typeof contentState>>, expected: string | null | undefined, empty: boolean) {
  if (expected === undefined || (current?.sha256 ?? null) !== expected && !empty) {
    throw new OxError("conflict", "An original content owner changed after Reset confirmation. Its new content was retained.");
  }
}
export async function syncContentState(path: string) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await file.sync(); } finally { await file.close(); }
  const parent = await open(dirname(path), constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await parent.sync(); } finally { await parent.close(); }
}

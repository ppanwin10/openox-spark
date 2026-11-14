import { HTTPError } from "../http";

export type MetadataQuery = { q?: unknown; sort?: unknown; limit?: unknown; cursor?: unknown };
export function metadataPage<T extends { id: string; name: string; modified: number | null }>(input: T[], query: MetadataQuery, key: string, model = false) {
  const label = key.startsWith("feed") ? "Feed" : key.startsWith("ideas") ? "Ideas" : "Library";
  const q = query.q === undefined ? "" : query.q, sort = query.sort ?? "modified", rawLimit = query.limit ?? (model ? 20 : 60);
  const limit = typeof rawLimit === "string" && /^\d+$/.test(rawLimit) ? Number(rawLimit) : rawLimit;
  if (typeof q !== "string" || q.length > 200 || !["name", "modified"].includes(String(sort))
    || typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > (model ? 30 : 100)) throw new HTTPError(400, `Invalid ${label} search, sort or page size.`);
  const needle = q.trim().toLocaleLowerCase();
  const rows = input.filter(item => !needle || Object.entries(item).filter(([key]) => ["name", "path", "entryPath", "description", "body", "action"].includes(key))
    .map(([, value]) => typeof value === "string" ? value : "").join("\n").toLocaleLowerCase().includes(needle))
    .sort((a, b) => sort === "name" ? a.name.localeCompare(b.name) || a.id.localeCompare(b.id)
      : (b.modified ?? 0) - (a.modified ?? 0) || a.id.localeCompare(b.id));
  const stamp = new Bun.CryptoHasher("sha256").update(JSON.stringify([key, q, sort, rows])).digest("hex");
  let offset = 0;
  if (query.cursor !== undefined && query.cursor !== null) {
    if (typeof query.cursor !== "string" || query.cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(query.cursor)) throw new HTTPError(400, `Invalid ${label} cursor.`);
    let cursor: { stamp?: unknown; offset?: unknown };
    try { cursor = JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8")); } catch { throw new HTTPError(400, `Invalid ${label} cursor.`); }
    if (!cursor || typeof cursor !== "object" || typeof cursor.stamp !== "string" || typeof cursor.offset !== "number"
      || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0 || Object.keys(cursor).some(key => !["stamp", "offset"].includes(key))) throw new HTTPError(400, `Invalid ${label} cursor.`);
    if (cursor.stamp !== stamp) throw new HTTPError(409, `The ${label} changed. Refresh before continuing; no incomplete page was returned.`);
    offset = cursor.offset;
    if (offset > rows.length) throw new HTTPError(400, `Invalid ${label} cursor offset.`);
  }
  const items: T[] = [];
  let bytes = 0;
  while (offset + items.length < rows.length && items.length < limit) {
    const item = rows[offset + items.length]!, size = Buffer.byteLength(JSON.stringify(item));
    if (bytes + size > (model ? 22_000 : 65_536)) break;
    items.push(item); bytes += size;
  }
  if (!items.length && offset < rows.length) throw new HTTPError(413, `A ${label} metadata item exceeds this page's size budget.`);
  const next = offset + items.length;
  return { items, total: rows.length, nextCursor: next < rows.length ? Buffer.from(JSON.stringify({ stamp, offset: next })).toString("base64url") : null };
}

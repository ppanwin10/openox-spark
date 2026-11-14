import { libraryCategorySchema, libraryInput, libraryRevisionSchema, OxError, podcastPatchSchema, spaceDraftSchema, spacePatchSchema, type FunctionCall } from "@openox/agent/linux";
import { museParityEnabled } from "../config";
import { HTTPError, json, payload } from "../http";
import type { VMFactory, VMRoute } from "./context";
import { FunctionApprovals } from "./skills-approval";

type Query = { q?: unknown; sort?: unknown; limit?: unknown; cursor?: unknown };
const statuses: Record<string, number> = { not_found: 404, conflict: 409, unavailable: 503, limit_exceeded: 409 };
function page<T extends { id: string; name: string; modified: number | null }>(input: T[], query: Query, key: string, model = false) {
  const q = query.q === undefined ? "" : query.q, sort = query.sort ?? "modified", rawLimit = query.limit ?? (model ? 20 : 60);
  const limit = typeof rawLimit === "string" && /^\d+$/.test(rawLimit) ? Number(rawLimit) : rawLimit;
  if (typeof q !== "string" || q.length > 200 || !["name", "modified"].includes(String(sort))
    || typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > (model ? 30 : 100)) throw new HTTPError(400, "Invalid Library search, sort or page size.");
  const needle = q.trim().toLocaleLowerCase();
  const rows = input.filter(item => !needle || Object.entries(item).filter(([key]) => ["name", "path", "entryPath", "description"].includes(key))
    .map(([, value]) => typeof value === "string" ? value : "").join("\n").toLocaleLowerCase().includes(needle))
    .sort((a, b) => sort === "name" ? a.name.localeCompare(b.name) || a.id.localeCompare(b.id)
      : (b.modified ?? 0) - (a.modified ?? 0) || a.id.localeCompare(b.id));
  const stamp = new Bun.CryptoHasher("sha256").update(JSON.stringify([key, q, sort, rows])).digest("hex");
  let offset = 0;
  if (query.cursor !== undefined && query.cursor !== null) {
    if (typeof query.cursor !== "string" || query.cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(query.cursor)) throw new HTTPError(400, "Invalid Library cursor.");
    let cursor: { stamp?: unknown; offset?: unknown };
    try { cursor = JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8")); } catch { throw new HTTPError(400, "Invalid Library cursor."); }
    if (!cursor || typeof cursor !== "object" || typeof cursor.stamp !== "string" || typeof cursor.offset !== "number"
      || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0 || Object.keys(cursor).some(key => !["stamp", "offset"].includes(key))) throw new HTTPError(400, "Invalid Library cursor.");
    if (cursor.stamp !== stamp) throw new HTTPError(409, "The Library changed. Refresh before continuing; no incomplete page was returned.");
    offset = cursor.offset;
    if (offset > rows.length) throw new HTTPError(400, "Invalid Library cursor offset.");
  }
  const items: T[] = [];
  let bytes = 0;
  while (offset + items.length < rows.length && items.length < limit) {
    const item = rows[offset + items.length]!, size = Buffer.byteLength(JSON.stringify(item));
    if (bytes + size > (model ? 22_000 : 65_536)) break;
    items.push(item); bytes += size;
  }
  if (!items.length && offset < rows.length) throw new HTTPError(413, "A Library metadata item exceeds this page's size budget.");
  const next = offset + items.length;
  return { items, total: rows.length, nextCursor: next < rows.length ? Buffer.from(JSON.stringify({ stamp, offset: next })).toString("base64url") : null };
}
export const libraryModule: VMFactory = context => {
  const enabled = museParityEnabled(), store = () => context.profile().library, approvals = FunctionApprovals.for(context.paths.state);
  const sync = () => context.profile().syncLibrary();
  const changed = () => context.emit({ type: "library" });
  const authorize = async (call: FunctionCall, title: string) => {
    if (JSON.stringify(call.args).length > 32_768) throw new OxError("invalid_argument", "Library approval details are too long.");
    await approvals.require(call, { action: call.name, title, args: call.args, detailLimit: 32_768,
      disclosure: "Metadata is shared with this model. Files remain under their original owner. Registration, pin and classification do not generate, run or display content." });
    call.signal.throwIfAborted();
  };
  const write = async <T>(call: FunctionCall, title: string, work: () => Promise<T>) => {
    if ((await call.profile.summary(call.conversationId)).temporary) throw new OxError("permission_denied", "Temporary conversations cannot manage persistent Library metadata.");
    await authorize(call, title); await sync();
    const result = await work(); context.logs.info("library", `${call.name} by=agent`); changed(); return result;
  };
  const input = (call: FunctionCall) => { const { purpose: _purpose, id: _id, fileId: _file, ...value } = call.args; return value; };
  const guard = (route: VMRoute): VMRoute => async (request, url, parts) => {
    if (!enabled) {
      if (!parts.length && request.method === "GET") return json({ available: false });
      throw new HTTPError(503, "Library Spaces are disabled on this Host.");
    }
    try { return await route(request, url, parts); }
    catch (error) { throw error instanceof OxError ? new HTTPError(statuses[error.code] ?? 400, error.message) : error; }
  };
  const query = (url: URL, spaces = false): Query => {
    if ([...url.searchParams.keys()].some(key => !["category", "q", "sort", "limit", "cursor", ...(spaces ? ["pinned"] : [])].includes(key))) throw new HTTPError(400, "Unknown Library query field.");
    return Object.fromEntries([...url.searchParams].filter(([key]) => !["category", "pinned"].includes(key)));
  };
  return {
    routes: {
      library: guard(async (request, url, parts) => {
        await sync();
        if (!parts.length && request.method === "GET") {
          const category = libraryInput(libraryCategorySchema, url.searchParams.get("category") ?? "documents");
          return json({ available: true, ...page(await store().items(category), query(url), category) });
        }
        if (parts.length === 2 && parts[0] === "podcasts" && request.method === "PUT") {
          const result = await store().tagPodcast(parts[1]!, libraryInput(podcastPatchSchema, await payload(request)));
          context.logs.info("library", `classify file=${parts[1]} by=web`); changed(); return json(result);
        }
        throw new HTTPError(404, "Not found");
      }),
      spaces: guard(async (request, url, parts) => {
        await sync();
        if (!parts.length && request.method === "GET") {
          const pinned = url.searchParams.get("pinned");
          if (pinned !== null && !["true", "false"].includes(pinned)) throw new HTTPError(400, "Invalid Space pin filter.");
          const items = (await store().listSpaces()).filter(item => pinned === null || item.pinned === (pinned === "true"));
          const result = page(items, query(url, true), `spaces:${pinned ?? "all"}`);
          return json({ available: true, spaces: result.items, total: result.total, nextCursor: result.nextCursor });
        }
        if (!parts.length && request.method === "POST") {
          const result = await store().createSpace(await payload(request), request.headers.get("idempotency-key") ?? "");
          context.logs.info("library", `space create id=${result.space.id} replayed=${result.replayed} by=web`); changed();
          return json(result, { status: result.replayed ? 200 : 201, headers: { location: `/api/spaces/${result.space.id}` } });
        }
        const id = parts[0] ?? "";
        if (parts.length === 1 && request.method === "GET") return json(await store().getSpace(id));
        if (parts.length === 1 && request.method === "PATCH") {
          const item = await store().updateSpace(id, await payload(request));
          context.logs.info("library", `space update id=${id} by=web`); changed(); return json(item);
        }
        if (parts.length === 1 && request.method === "DELETE") {
          const revision = libraryInput(libraryRevisionSchema, await payload(request));
          const result = await store().deleteSpace(id, revision.expectedRevision);
          context.logs.info("library", `space remove id=${id} by=web`); changed(); return json(result);
        }
        throw new HTTPError(404, "Not found");
      }),
    },
    handlers: enabled ? {
      "ox.library.list": async call => {
        await authorize(call, "List Library metadata"); await sync();
        const category = libraryInput(libraryCategorySchema, call.args.category);
        return page(await store().items(category), call.args, category, true);
      },
      "ox.library.tag": async call => write(call, "Classify an audio artifact", () => store().tagPodcast(String(call.args.fileId), input(call))),
      "ox.space.list": async call => {
        await authorize(call, "List Spaces"); await sync();
        const result = page(await store().listSpaces(), call.args, "spaces", true);
        return { spaces: result.items, total: result.total, nextCursor: result.nextCursor };
      },
      "ox.space.create": async call => {
        if (!call.requestID) throw new OxError("invalid_state", "This Space creation has no Host request identity.");
        const key = call.requestID, draft = libraryInput(spaceDraftSchema, input(call));
        return write(call, "Create a persistent Space", () => store().createSpace(draft, key));
      },
      "ox.space.update": async call => write(call, "Update a Space", () => store().updateSpace(String(call.args.id), libraryInput(spacePatchSchema, input(call)))),
      "ox.space.delete": async call => write(call, "Remove a Space", () => store().deleteSpace(String(call.args.id), Number(call.args.expectedRevision))),
    } : undefined,
  };
};

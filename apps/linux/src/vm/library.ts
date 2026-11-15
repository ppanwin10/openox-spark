import { libraryCategorySchema, libraryInput, libraryRevisionSchema, OxError, podcastPatchSchema, spaceDataWriteSchema, spaceDraftSchema, spacePatchSchema, type FunctionCall, type SpaceScheduleBinding, type SpaceVisibility } from "@openox/agent/linux";
import { Type } from "typebox";
import { museParityEnabled } from "../config";
import { HTTPError, json, payload } from "../http";
import type { VMFactory, VMRoute } from "./context";
import { FunctionApprovals } from "./skills-approval";
import { metadataPage as page, type MetadataQuery as Query } from "./metadata-page";
import { parseISODate, validVisibility, visibleAt } from "./schedules-recurrence";
import { Approvals } from "./approvals";

const statuses: Record<string, number> = { not_found: 404, conflict: 409, unavailable: 503, write_unverified: 503, limit_exceeded: 409, permission_denied: 403 };
const strict = { additionalProperties: false }, hash = Type.String({ pattern: "^[a-f0-9]{64}$" });
const grantSchema = Type.Object({
  expectedRevision: Type.Integer({ minimum: 1 }), fileId: Type.String({ minLength: 1, maxLength: 512 }), sourceRevision: hash, entrySha256: hash,
  access: Type.Union([Type.Literal("read"), Type.Literal("readWrite")]), confirm: Type.Literal(true),
}, strict);
const ownerWriteSchema = Type.Object({ ...spaceDataWriteSchema.properties, confirm: Type.Literal(true) }, strict);
const connectionSchema = Type.Object({ expectedRevision: Type.Integer({ minimum: 1 }), entrySha256: hash, confirm: Type.Literal(true),
  kind: Type.Union([Type.Literal("api"), Type.Literal("web"), Type.Literal("mcp")]), repository: Type.String({ minLength: 1, maxLength: 500 }),
  definition: Type.String({ minLength: 1, maxLength: 2_000 }), revision: Type.Integer({ minimum: 0 }), proof: hash,
}, strict);
const navigationInput = (value: { visibility?: SpaceVisibility }) => {
  if (value.visibility && !validVisibility(value.visibility)) throw new OxError("invalid_argument", "Choose valid local dates and an IANA visibility time zone.");
  return value;
};
export const libraryModule: VMFactory = context => {
  const enabled = museParityEnabled(), store = () => context.profile().library, approvals = FunctionApprovals.for(context.paths.state);
  const policy = Approvals.for(context.paths.state);
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
    catch (error) {
      if (error instanceof OxError) return json({ error: error.message, code: error.code }, { status: statuses[error.code] ?? 400 });
      throw error;
    }
  };
  const query = (url: URL, spaces = false): Query => {
    if ([...url.searchParams.keys()].some(key => !["category", "q", "sort", "limit", "cursor", ...(spaces ? ["pinned"] : [])].includes(key))) throw new HTTPError(400, "Unknown Library query field.");
    return Object.fromEntries([...url.searchParams].filter(([key]) => !["category", "pinned"].includes(key)));
  };
  const dataBinding = async (call: FunctionCall): Promise<SpaceScheduleBinding> => {
    const slot = String(call.args.slot);
    if (call.page) {
      if (!call.page.source) throw new OxError("permission_denied", "Reopen this Space to obtain its original frame and data-grant proof.");
      return context.profile().spaceBinding(call.page.source.id, slot, undefined, call.page.source.sha256);
    }
    const binding = context.spaceTask(call);
    if (!binding || binding.slot !== slot) throw new OxError("permission_denied", "Only the original current Space frame or its bound scheduled task can access this data slot.");
    await context.profile().validateSpaceBinding(binding, false);
    return binding;
  };
  const dataCall = async (call: FunctionCall, operation: "read" | "write" | "proof") => {
    const binding = await dataBinding(call);
    await policy.require(call, `ox.space.data.${operation === "proof" ? "read" : operation}`, "ask", { title: "Space data access",
      args: { slot: binding.slot, fileId: binding.dataFileId, scope: operation } });
    await policy.guard(call); call.signal.throwIfAborted();
    if (operation === "proof") return context.profile().spaceDataProof(binding, String(call.args.requestId));
    const { purpose: _purpose, slot: _slot, ...input } = call.args;
    const result = await context.profile().spaceData(binding, operation === "write" ? input : undefined, () => policy.guard(call),
      operation === "write" ? { kind: call.page ? "owner" : "schedule", ...(policy.scheduled(call) ? { scheduleId: policy.scheduled(call) } : {}),
        submissionId: policy.submission(call) ?? String(call.args.requestId) } : null);
    if (operation === "write") { changed(); return { inputApplied: result.inputApplied, historical: result.historical, snapshot: result.snapshot }; }
    return result.snapshot;
  };
  return {
    routes: {
      library: guard(async (request, url, parts) => {
        await sync();
        if (!parts.length && request.method === "GET") {
          const category = libraryInput(libraryCategorySchema, url.searchParams.get("category") ?? "documents");
          const result = page(await store().items(category), query(url), category);
          return json({ available: true, ...result, items: await context.profile().fileRemovalRows(result.items) });
        }
        if (parts.length === 2 && parts[0] === "podcasts" && request.method === "PUT") {
          const result = await store().tagPodcast(parts[1]!, libraryInput(podcastPatchSchema, await payload(request)));
          context.logs.info("library", `classify file=${parts[1]} by=web`); changed(); return json(result);
        }
        throw new HTTPError(404, "Not found");
      }),
      spaces: guard(async (request, url, parts) => {
        await sync();
        if (parts.length === 1 && parts[0] === "navigation" && request.method === "GET") {
          if ([...url.searchParams.keys()].some(key => key !== "at")) throw new HTTPError(400, "Unknown navigation query field.");
          const at = url.searchParams.has("at") ? parseISODate(url.searchParams.get("at")!) : Date.now();
          if (at === undefined) throw new HTTPError(400, "Choose an ISO visibility observation time.");
          const spaces = (await store().listSpaces()).filter(space => !space.missing && visibleAt(space.visibility, at))
            .sort((a, b) => (a.order ?? 499) - (b.order ?? 499) || a.id.localeCompare(b.id));
          const placed = (placement: string) => spaces.filter(space => (space.placement ?? (space.pinned ? "sidebar" : "hidden")) === placement);
          return json({ observedAt: new Date(at).toISOString(), sidebar: placed("sidebar"), main: placed("main") });
        }
        if (!parts.length && request.method === "GET") {
          const pinned = url.searchParams.get("pinned");
          if (pinned !== null && !["true", "false"].includes(pinned)) throw new HTTPError(400, "Invalid Space pin filter.");
          const items = (await store().listSpaces()).filter(item => pinned === null || item.pinned === (pinned === "true"));
          const result = page(items, query(url, true), `spaces:${pinned ?? "all"}`);
          return json({ available: true, spaces: result.items, total: result.total, nextCursor: result.nextCursor });
        }
        if (!parts.length && request.method === "POST") {
          const draft = libraryInput(spaceDraftSchema, await payload(request)); navigationInput(draft);
          const result = await store().createSpace(draft, request.headers.get("idempotency-key") ?? "");
          context.logs.info("library", `space create id=${result.space.id} replayed=${result.replayed} by=web`); changed();
          return json(result, { status: result.replayed ? 200 : 201, headers: { location: `/api/spaces/${result.space.id}` } });
        }
        const id = parts[0] ?? "";
        if (parts.length === 2 && parts[1] === "resources" && request.method === "GET") return json(await context.profile().spaceResources(id));
        if (parts[1] === "data") {
          const slot = parts[2] ?? "";
          if (!/^[a-z][a-z0-9_-]{0,39}$/.test(slot)) throw new HTTPError(400, "Choose a declared data slot.");
          if (parts.length === 3 && request.method === "PUT") {
            const input = libraryInput(grantSchema, await payload(request));
            const result = await context.profile().grantSpaceData(id, slot, input); changed(); return json(result);
          }
          if (parts.length === 3 && request.method === "DELETE") {
            const revision = libraryInput(libraryRevisionSchema, await payload(request));
            const result = await context.profile().grantSpaceData(id, slot, revision); changed(); return json(result);
          }
          const binding = await context.profile().spaceBinding(id, slot);
          if (parts.length === 4 && parts[3] === "read" && request.method === "GET") {
            await policy.current();
            if (policy.policy("ox.space.data.read", "ask") === "block") throw new OxError("permission_denied", "The original action policy blocks Space data reads.");
            return json((await context.profile().spaceData(binding)).snapshot);
          }
          if (parts.length === 5 && parts[3] === "requests" && request.method === "GET") {
            await policy.current();
            if (policy.policy("ox.space.data.read", "ask") === "block") throw new OxError("permission_denied", "The original action policy blocks Space data proof reads.");
            return json(await context.profile().spaceDataProof(binding, libraryInput(Type.String({ format: "uuid" }), parts[4])));
          }
          if (parts.length === 4 && parts[3] === "write" && request.method === "POST") {
            const { confirm, ...input } = libraryInput(ownerWriteSchema, await payload(request));
            await policy.ownerDecision(context, "ox.space.data.write", "ask", input.requestId, confirm, null);
            const result = await context.profile().spaceData(binding, input, async () => {
              await policy.current();
              if (policy.policy("ox.space.data.write", "ask") === "block") throw new OxError("permission_denied", "The original action policy blocks Space data writes.");
            }, { kind: "owner", submissionId: input.requestId });
            changed(); return json({ inputApplied: result.inputApplied, historical: result.historical, snapshot: result.snapshot });
          }
          throw new HTTPError(404, "Not found");
        }
        if (parts.length === 3 && parts[1] === "connections") {
          const domain = parts[2]!;
          if (request.method === "PUT") {
            const input = libraryInput(connectionSchema, await payload(request)), current = await context.spaceConnectionProof(domain);
            if (!current.connected || ["kind", "repository", "definition", "revision", "proof"].some(key => current[key as keyof typeof current] !== input[key as keyof typeof input])) {
              throw new OxError("conflict", "Verify and select the current original connector account before granting this Space access.");
            }
            const { connected: _connected, verifiedAt: _verified, ...connection } = current;
            const result = await context.profile().grantSpaceConnection(id, input.expectedRevision, input.entrySha256, domain, connection); changed(); return json(result);
          }
          if (request.method === "DELETE") {
            const input = libraryInput(Type.Object({ expectedRevision: Type.Integer({ minimum: 1 }), entrySha256: hash }, strict), await payload(request));
            const result = await context.profile().grantSpaceConnection(id, input.expectedRevision, input.entrySha256, domain, null); changed(); return json(result);
          }
        }
        if (parts.length === 1 && request.method === "GET") return json(await store().getSpace(id));
        if (parts.length === 1 && request.method === "PATCH") {
          const patch = libraryInput(spacePatchSchema, await payload(request)); navigationInput(patch);
          const item = await store().updateSpace(id, patch);
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
      "ox.space.data.read": call => dataCall(call, "read"),
      "ox.space.data.write": call => dataCall(call, "write"),
      "ox.space.data.proof": call => dataCall(call, "proof"),
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
        const key = call.requestID, draft = libraryInput(spaceDraftSchema, input(call)); navigationInput(draft);
        return write(call, "Create a persistent Space", () => store().createSpace(draft, key));
      },
      "ox.space.update": async call => write(call, "Update a Space", () => {
        const patch = libraryInput(spacePatchSchema, input(call)); navigationInput(patch);
        return store().updateSpace(String(call.args.id), patch);
      }),
      "ox.space.delete": async call => write(call, "Remove a Space", () => store().deleteSpace(String(call.args.id), Number(call.args.expectedRevision))),
    } : undefined,
  };
};

import { identityInput, identityPatchSchema, soulPatchSchema, OxError, type FunctionCall } from "@openox/agent/linux";
import { museParityEnabled } from "../config";
import { HTTPError, json, payload } from "../http";
import type { VMFactory, VMRoute } from "./context";
import { FunctionApprovals } from "./skills-approval";

const statuses: Record<string, number> = { conflict: 409, not_found: 404, unavailable: 503, limit_exceeded: 409 };
export const identityModule: VMFactory = context => {
  const enabled = museParityEnabled(), approvals = FunctionApprovals.for(context.paths.state);
  const snapshot = async () => {
    await context.profile().syncLibrary();
    const [agent, soul] = await Promise.all([context.profile().identity.get(), context.profile().soulSnapshot()]);
    return { agent, soul };
  };
  const changed = () => context.emit({ type: "identity" });
  const route: VMRoute = async (request, _url, parts) => {
    if (!enabled) { if (!parts.length && request.method === "GET") return json({ available: false }); throw new HTTPError(503, "Agent identity is disabled on this Host."); }
    try {
      if (!parts.length && request.method === "GET") return json({ available: true, ...await snapshot() });
      if (!parts.length && request.method === "PATCH") {
        await context.profile().syncLibrary();
        const result = await context.profile().identity.update(await payload(request)); changed(); return json(result);
      }
      if (parts.length === 1 && parts[0] === "soul" && request.method === "PUT") {
        const input = identityInput(soulPatchSchema, await payload(request));
        const result = await context.profile().setSoul(input.text, input.expectedSourceRevision); changed(); return json(result);
      }
      throw new HTTPError(404, "Not found");
    } catch (error) { throw error instanceof OxError ? new HTTPError(statuses[error.code] ?? 400, error.message) : error; }
  };
  const authorize = async (call: FunctionCall, title: string) => {
    if (JSON.stringify(call.args, null, 2).length > 32_768) throw new OxError("invalid_argument", "Identity approval details exceed the full-detail budget.");
    await approvals.require(call, { action: call.name, title, args: call.args, detailLimit: 32_768,
      disclosure: "Agent identity and original SOUL guidance are shared with this model. They do not rename the Workspace, change MEMORY, grant permissions or override core rules." });
    call.signal.throwIfAborted();
  };
  const input = (call: FunctionCall) => { const { purpose: _purpose, ...fields } = call.args; return fields; };
  const write = async <T>(call: FunctionCall, title: string, work: () => Promise<T>) => {
    if ((await call.profile.summary(call.conversationId)).temporary) throw new OxError("permission_denied", "Temporary conversations cannot change persistent Agent identity.");
    await authorize(call, title); await call.profile.syncLibrary();
    const result = await work(); changed(); context.logs.info("identity", `${call.name} by=agent`); return result;
  };
  return { routes: { identity: route }, handlers: enabled ? {
    "ox.identity.get": async call => { await authorize(call, "Read Agent identity"); return snapshot(); },
    "ox.identity.update": async call => {
      const draft = identityInput(identityPatchSchema, input(call));
      return write(call, "Change Agent identity", () => call.profile.identity.update(draft));
    },
    "ox.identity.setSoul": async call => {
      const draft = identityInput(soulPatchSchema, input(call));
      return write(call, "Save Agent guidance", () => call.profile.setSoul(draft.text, draft.expectedSourceRevision));
    },
  } : undefined };
};

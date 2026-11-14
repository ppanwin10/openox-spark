import { goalAgentPatchSchema, goalDraftSchema, goalInput, goalPatchSchema, goalRevisionSchema, OxError, type FunctionCall } from "@openox/agent/linux";
import { museParityEnabled } from "../config";
import { HTTPError, json, payload } from "../http";
import type { VMFactory, VMRoute } from "./context";
import { FunctionApprovals } from "./skills-approval";

const statuses: Record<string, number> = { not_found: 404, conflict: 409, unavailable: 503, limit_exceeded: 409 };
export const goalsModule: VMFactory = context => {
  const enabled = museParityEnabled(), store = () => context.profile().goals, approvals = FunctionApprovals.for(context.paths.state);
  const changed = () => context.emit({ type: "goals" });
  const authorize = async (call: FunctionCall, title: string, args: Record<string, unknown>) => {
    if (JSON.stringify(args).length > 32_768) throw new OxError("invalid_argument", "Goal approval details are too long. Shorten the request before asking for approval.");
    await approvals.require(call, { action: call.name, title, args, detailLimit: 32_768,
      disclosure: "Goal data is shared with this model. Saving does not start work or complete the outcome. Linked tasks remain under their existing owners." });
    call.signal.throwIfAborted();
  };
  const write = async <T>(call: FunctionCall, title: string, args: Record<string, unknown>, work: () => Promise<T>) => {
    if ((await call.profile.summary(call.conversationId)).temporary) throw new OxError("permission_denied", "Temporary conversations cannot manage persistent goals.");
    await authorize(call, title, args);
    const result = await work();
    context.logs.info("goals", `${call.name} by=agent`); changed();
    return result;
  };
  const input = (call: FunctionCall) => { const { purpose: _purpose, id: _id, ...value } = call.args; return value; };
  const route: VMRoute = async (request, _url, parts) => {
    if (!enabled) {
      if (!parts.length && request.method === "GET") return json({ available: false });
      throw new HTTPError(503, "Goals are disabled on this Host.");
    }
    try {
      if (!parts.length && request.method === "GET") return json({ available: true, goals: await store().list(), limit: 500 });
      if (!parts.length && request.method === "POST") {
        const draft = goalInput(goalDraftSchema, await payload(request));
        const result = await store().create(draft, request.headers.get("idempotency-key") ?? "");
        context.logs.info("goals", `create id=${result.goal.id} replayed=${result.replayed} by=web`); changed();
        return json(result, { status: result.replayed ? 200 : 201, headers: { location: `/api/goals/${result.goal.id}` } });
      }
      const id = parts[0] ?? "";
      if (parts.length === 1 && request.method === "GET") return json(await store().get(id));
      if (parts.length === 1 && request.method === "PATCH") {
        const patch = goalInput(goalPatchSchema, await payload(request));
        const goal = await store().update(id, patch);
        context.logs.info("goals", `update id=${id} by=web`); changed(); return json(goal);
      }
      if (parts.length === 1 && request.method === "DELETE") {
        const revision = goalInput(goalRevisionSchema, await payload(request));
        const result = await store().delete(id, revision.expectedRevision);
        context.logs.info("goals", `delete id=${id} by=web`); changed(); return json(result);
      }
      throw new HTTPError(404, "Not found");
    } catch (error) { throw error instanceof OxError ? new HTTPError(statuses[error.code] ?? 400, error.message) : error; }
  };
  return { routes: { goals: route }, handlers: enabled ? {
    "ox.goal.list": async call => {
      await authorize(call, "List goals", call.args);
      return { goals: await store().list() };
    },
    "ox.goal.create": async call => {
      if (!call.requestID) throw new OxError("invalid_state", "This goal creation has no Host request identity.");
      const key = call.requestID, draft = goalInput(goalDraftSchema, input(call));
      return write(call, "Create a goal", call.args, () => store().create(draft, key));
    },
    "ox.goal.update": async call => {
      const id = String(call.args.id), patch = goalInput(goalAgentPatchSchema, input(call)), current = await store().get(id);
      return write(call, "Update a goal", { ...call.args, current }, () => store().update(id, patch));
    },
    "ox.goal.delete": async call => {
      const id = String(call.args.id), current = await store().get(id);
      return write(call, "Delete a goal", { ...call.args, current }, () => store().delete(id, Number(call.args.expectedRevision)));
    },
  } : undefined };
};

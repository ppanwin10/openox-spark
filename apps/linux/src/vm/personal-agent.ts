import { OxError, todoDeleteSchema, todoInput, type FunctionCall } from "@openox/agent/linux";
import { HTTPError, json, payload } from "../http";
import type { VMContext, VMFactory, VMRoute } from "./context";
import { FunctionApprovals } from "./skills-approval";

export const personalAgentEnabled = () => process.env.OPENOX_PERSONAL_AGENT === "1";
const describe = (error: unknown) => error instanceof Error ? error.message : String(error);
const statuses: Record<string, number> = { not_found: 404, conflict: 409, unavailable: 503, limit_exceeded: 409 };

export const personalAgentModule: VMFactory = (context: VMContext) => {
  const enabled = personalAgentEnabled();
  const approvals = FunctionApprovals.for(context.paths.state);
  const store = () => context.profile().todos;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let failure: string | null = null;
  let chain: Promise<void> = Promise.resolve();
  const changed = () => { context.emit({ type: "todos" }); context.emit({ type: "notifications" }); };
  const report = (error: unknown) => {
    failure = describe(error);
    context.logs.warning("todos", failure);
    context.emit({ type: "todos" });
    if (!closed) timer = setTimeout(() => void refresh(), 60_000);
  };
  const update = async () => {
    if (closed) return;
    clearTimeout(timer);
    const queued = await store().queueDue((todo, id) => {
      if (todo.dueAt === null) throw new OxError("unavailable", "This Todo reminder has no deadline.");
      return { id, tag: `todo-${todo.id}`, targetUrl: `/#/todos/${todo.id}`, urgency: "normal",
        title: { en: "Todo reminder", "zh-Hans": "待办提醒" }, body: { en: todo.title, "zh-Hans": todo.title }, occurredAt: todo.dueAt };
    });
    for (const { todo, notice } of queued) {
      context.logs.info("todos", `reminder queued id=${todo.id}`);
      context.notify({ id: notice.id, tag: notice.tag, url: notice.targetUrl, urgency: notice.urgency,
        title: language => notice.title[language], body: language => notice.body[language] });
    }
    if (queued.length) changed();
    const pending = (await store().list()).flatMap(todo => todo.reminder === "pending" && todo.dueAt !== null ? [Date.parse(todo.dueAt)] : []);
    failure = null;
    if (pending.length && !closed) {
      const next = Math.min(...pending);
      timer = setTimeout(() => void refresh(), Math.min(Math.max(next - Date.now(), 100), 60_000));
    }
  };
  const refresh = () => {
    chain = chain.then(update).catch(report);
    return chain;
  };
  const route = (body: VMRoute): VMRoute => async (request, url, parts) => {
    if (!enabled) {
      if (!parts.length && request.method === "GET") return json({ available: false });
      throw new HTTPError(503, "The personal-agent preview is disabled on this Host.");
    }
    try { return await body(request, url, parts); }
    catch (error) { throw error instanceof OxError ? new HTTPError(statuses[error.code] ?? 400, error.message) : error; }
  };
  const write = async (call: FunctionCall, title: string, operation: () => Promise<unknown>) => {
    await approvals.require(call, { action: call.name, title });
    call.signal.throwIfAborted();
    const result = await operation();
    context.logs.info("todos", `${call.name} by=agent`);
    changed();
    void refresh();
    return result;
  };
  const input = (call: FunctionCall) => { const { purpose: _purpose, id: _id, ...value } = call.args; return value; };

  return {
    handlers: enabled ? {
      "ox.todo.list": async () => ({ todos: await store().list() }),
      "ox.todo.create": async call => {
        const requestID = call.requestID;
        if (!requestID) throw new OxError("invalid_state", "This Todo creation has no Host request identity.");
        return write(call, "Create a Todo", () => store().create(input(call), requestID));
      },
      "ox.todo.update": async call => write(call, "Update a Todo", () => store().update(String(call.args.id), input(call))),
      "ox.todo.delete": async call => write(call, "Delete a Todo", () => store().delete(String(call.args.id), Number(call.args.expectedRevision))),
    } : undefined,
    routes: {
      todos: route(async (request, _url, parts) => {
        if (!parts.length && request.method === "GET") return json({ available: true, todos: await store().list(), warning: failure, limit: 500 });
        if (!parts.length && request.method === "POST") {
          const result = await store().create(await payload(request), request.headers.get("idempotency-key") ?? "");
          context.logs.info("todos", `create id=${result.todo.id} replayed=${result.replayed} by=web`);
          changed();
          void refresh();
          return json(result, { status: result.replayed ? 200 : 201 });
        }
        const id = parts[0] ?? "";
        if (parts.length === 1 && request.method === "GET") return json(await store().get(id));
        if (parts.length === 1 && request.method === "PATCH") {
          const todo = await store().update(id, await payload(request));
          context.logs.info("todos", `update id=${id} by=web`);
          changed();
          void refresh();
          return json(todo);
        }
        if (parts.length === 1 && request.method === "DELETE") {
          const input = todoInput(todoDeleteSchema, await payload(request));
          const result = await store().delete(id, input.expectedRevision);
          context.logs.info("todos", `delete id=${id} by=web`);
          changed();
          void refresh();
          return json(result);
        }
        throw new HTTPError(404, "Not found");
      }),
      notifications: route(async (request, url, parts) => {
        const store = context.profile().inbox, id = parts[0] ?? "";
        if (!parts.length && request.method === "GET") {
          const { notifications, unreadCount, limit } = await store.list();
          return json({ available: true, unreadCount, limit, ...(url.searchParams.get("summary") === "1" ? {} : { notifications }),
            warning: context.notificationProblem?.() ?? null });
        }
        if (parts.length === 1 && request.method === "GET") return json(await store.get(id));
        if (parts.length === 2 && parts[1] === "read" && request.method === "PUT") {
          const notice = await store.read(id);
          context.logs.info("notifications", `read id=${id} by=web`);
          context.emit({ type: "notifications" });
          return json(notice);
        }
        throw new HTTPError(404, "Not found");
      }),
    },
    start: enabled ? async () => { await refresh(); } : undefined,
    close: async () => { closed = true; clearTimeout(timer); await chain; },
  };
};

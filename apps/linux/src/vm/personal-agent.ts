import { noticeConversationID, OxError, todoDeleteSchema, todoInput, type FunctionCall, type InboxNotice, type InboxStore } from "@openox/agent/linux";
import { HTTPError, json, payload } from "../http";
import { museParityEnabled, personalAgentEnabled } from "../config";
import type { VMContext, VMFactory, VMRoute } from "./context";
import { FunctionApprovals } from "./skills-approval";

const describe = (error: unknown) => error instanceof Error ? error.message : String(error);
const statuses: Record<string, number> = { not_found: 404, conflict: 409, unavailable: 503, limit_exceeded: 409 };
const unread = (notice: InboxNotice) => notice.readAt === null && notice.cancelledAt === null;
function notificationConversation(url: URL) {
  const values = url.searchParams.getAll("conversationId");
  if (!values.length) return null;
  const id = noticeConversationID(`/#/c/${values[0]}`);
  if (values.length !== 1 || id === null) throw new HTTPError(400, "Send one canonical safe conversation ID.");
  return id;
}
function notificationCounts(notifications: InboxNotice[]) {
  const counts = new Map<number, number>();
  for (const notice of notifications) {
    const target = noticeConversationID(notice.targetUrl);
    if (target !== null && unread(notice)) counts.set(target, (counts.get(target) ?? 0) + 1);
  }
  return [...counts].sort(([a], [b]) => a - b).map(([id, unreadCount]) => ({ id, unreadCount }));
}
async function notificationList(store: InboxStore, url: URL, attention: boolean, warning: string | null) {
  const conversationId = notificationConversation(url), summary = url.searchParams.get("summary") === "1";
  const { notifications, unreadCount, limit } = await store.list();
  if (conversationId !== null) {
    const ids = notifications.filter(notice => unread(notice) && noticeConversationID(notice.targetUrl) === conversationId).map(notice => notice.id);
    return { available: true, conversationId, unreadCount: ids.length, limit, ...(summary ? {} : { ids }), warning };
  }
  return { available: true, unreadCount, limit, ...(summary ? {} : { notifications }),
    ...(attention && summary ? { conversationCounts: notificationCounts(notifications) } : {}), warning };
}

export const personalAgentModule: VMFactory = (context: VMContext) => {
  const enabled = personalAgentEnabled(), attention = museParityEnabled();
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
      if (!parts.length && request.method === "GET" && !url.searchParams.has("conversationId")) return json({ available: false });
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
      todos: route(async (request, url, parts) => {
        if (!parts.length && request.method === "GET") {
          const todos = await store().list(), completed = todos.filter(todo => todo.completed).length;
          return json({ available: true, warning: failure, limit: 500, ...(url.searchParams.get("summary") === "1"
            ? { total: todos.length, open: todos.length - completed, completed } : { todos }) });
        }
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
        if (url.searchParams.has("conversationId") || id === "read") {
          if (!attention) throw new HTTPError(503, "Chat attention is disabled on this Host.");
        }
        if (url.searchParams.has("conversationId") && (parts.length || request.method !== "GET")) throw new HTTPError(400, "Conversation selection is only supported on the notification collection.");
        if (!parts.length && request.method === "GET") {
          return json(await notificationList(store, url, attention, context.notificationProblem?.() ?? null));
        }
        if (parts.length === 1 && id === "read" && request.method === "PUT") {
          const notifications = await store.readConversation(await payload(request));
          context.logs.info("notifications", `read matched count=${notifications.length} by=web`);
          context.emit({ type: "notifications" });
          return json({ notifications });
        }
        if (parts.length === 1 && request.method === "GET") return json(await store.get(id));
        if (parts.length === 2 && parts[1] === "read" && request.method === "PUT") {
          const input = await payload<unknown>(request);
          if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length) throw new HTTPError(400, "Send an empty notification-detail read request.");
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

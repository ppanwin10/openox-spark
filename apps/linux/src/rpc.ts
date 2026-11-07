import { RPC_VERSION, validateParams, validateResult, type MethodName } from "@openox/protocol";
import type { Host } from "./host";

type Params = Record<string, unknown>;
type Handler = (host: Host, params: Params) => Promise<unknown>;
class RPCError extends Error {
  readonly code: number;
  constructor(message: string, code = -32000) { super(message); this.code = code; }
}

const iso = (milliseconds: number | null) => milliseconds === null ? null : new Date(milliseconds).toISOString();
const label = (model: { provider: string; modelId: string } | null) => model ? `${model.provider}:${model.modelId}` : null;

function selectedConversation(host: Host, value: unknown) {
  if (value === undefined || value === null) return host.active;
  const id = Number(value);
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(id)) throw new RPCError("Conversation not found");
  return id;
}
function conversationID(host: Host, value: unknown) {
  const id = selectedConversation(host, value);
  if (id === null) throw new RPCError("No conversation is selected; pass --conversation <id> or start one with conversation new");
  return id;
}

async function snapshot(host: Host, id: number) {
  const view = await host.profile.view(id);
  const choice = view.summary.model;
  const model = choice ? host.providers.models.getModel(choice.provider, choice.modelId) : undefined;
  const systemPrompt = await host.profile.systemPrompt(id);
  return {
    id: String(id),
    model: { id: choice?.modelId ?? "none", provider: choice?.provider ?? null, displayName: model?.name ?? choice?.modelId ?? "No model", maxTokens: model?.maxTokens ?? 0, maxContext: model?.contextWindow ?? 0 },
    systemPrompt, renderedSystemPrompt: systemPrompt, soul: "", memory: host.profile.memoryText,
    tools: host.profile.tools(), messages: view.messages.map(message => message.role === "user" && typeof message.content === "string"
      ? { ...message, content: [{ type: "text", text: message.content }] } : message), blocks: view.blocks, isBusy: view.busy,
    ...(view.pendingPrompt ? { pendingPrompt: view.pendingPrompt } : {}),
  };
}

function waitForAttention(host: Host, id: number, settled: Promise<unknown>) {
  return new Promise<"attention" | "settled">(resolve => {
    if (host.profile.pendingPrompt(id)) { resolve("attention"); return; }
    const stop = host.subscribe(event => {
      if (event.type === "conversation" && event.id === id && host.profile.pendingPrompt(id)) { stop(); resolve("attention"); }
    });
    settled.finally(() => { stop(); resolve("settled"); });
  });
}

const profileRow = (host: Host) => ({ id: host.settings.profile.id, name: host.settings.profile.name, location: host.profile.content, version: "linux-1", active: true });
function requireProfile(host: Host, params: Params) {
  if (params.profileId !== host.settings.profile.id) throw new RPCError("Profile not found");
}

const handlers: Partial<Record<MethodName, Handler>> = {
  "host.describe": async host => ({
    implementation: { name: "OpenOx Linux Host", version: host.version, build: host.hostID },
    protocols: { rpc: [RPC_VERSION] }, methods: Object.keys(handlers),
  }),
  "profiles.list": async host => ({ profiles: [profileRow(host)] }),
  "profiles.inspect": async (host, params) => {
    requireProfile(host, params);
    return { profile: profileRow(host), memory: host.profile.memoryText, soul: "" };
  },
  "profiles.update": async (host, params) => {
    requireProfile(host, params);
    if (typeof params.soul === "string") throw new RPCError("SOUL.md is not used by the Linux Host");
    if (typeof params.name === "string") await host.updateSettings({ profile: { ...host.settings.profile, name: params.name.trim() || host.settings.profile.name } });
    if (typeof params.memory === "string") await host.profile.setMemory(params.memory);
    return { profile: profileRow(host), memory: host.profile.memoryText, soul: "" };
  },
  "files.list": async () => ({ folders: [] }),
  "conversations.list": async host => {
    const conversations = [];
    let cursor;
    do {
      const page = await host.profile.list(100, cursor);
      conversations.push(...page.items.map(item => ({ id: String(item.id), title: item.title || "New conversation", model: label(item.model),
        createdAt: iso(item.createdAt)!, lastActivity: iso(item.lastActivity), active: item.id === host.active })));
      cursor = page.next;
    } while (cursor);
    return { conversations };
  },
  "conversations.get": async (host, params) => {
    const id = selectedConversation(host, params.conversationId);
    return id === null ? {} : { data: await snapshot(host, id) };
  },
  "conversations.open": async (host, params) => {
    const id = conversationID(host, params.conversationId);
    const data = await snapshot(host, id);
    host.active = id;
    return { data };
  },
  "conversations.new": async (host, params) => {
    if (params.temporary === true) throw new RPCError("Temporary conversations are not supported by the Linux Host");
    const choice = params.providerId || params.modelId ? host.providers.validChoice({ provider: params.providerId, modelId: params.modelId }) : host.defaultModel();
    if (!choice) throw new RPCError("No model is configured. Add a provider key in the Host's Settings, then retry.");
    const id = await host.profile.create(choice);
    host.active = id;
    return { conversationId: String(id), temporary: false, model: label(choice)! };
  },
  "conversations.send": async (host, params) => {
    let id = selectedConversation(host, params.conversationId);
    if (id === null) {
      const choice = host.defaultModel();
      if (!choice) throw new RPCError("No model is configured. Add a provider key in the Host's Settings, then retry.");
      id = await host.profile.create(choice);
    }
    const text = String(params.text ?? "");
    if (!text.trim()) throw new RPCError("Message text is required");
    await host.profile.ready(id);
    host.active = id;
    host.logs.info("conversation", `send conversation=${id} characters=${text.length}`);
    const run = host.profile.send(id, text);
    if (params.wait === false) {
      run.catch(() => {});
      return { conversationId: String(id), outcome: "queued" };
    }
    const settled = run.then(() => undefined, () => undefined);
    if (await waitForAttention(host, id, settled) === "attention") return { conversationId: String(id), outcome: "needsAttention" };
    const result = await run;
    return { conversationId: String(id), outcome: result.outcome, ...(result.text !== undefined ? { text: result.text } : {}), ...(result.error ? { error: result.error } : {}) };
  },
  "conversations.stop": async (host, params) => {
    const id = conversationID(host, params.conversationId);
    return { conversationId: String(id), wasRunning: await host.profile.stop(id) };
  },
  "conversations.respond": async (host, params) => {
    const id = conversationID(host, params.conversationId);
    host.profile.respond(id, String(params.promptId), String(params.answer));
    return { conversationId: String(id), promptId: String(params.promptId) };
  },
  "providers.list": async host => ({ region: "global", providers: host.providers.rows() }),
  "logs.list": async (host, params) => host.logs.page(params as Parameters<Host["logs"]["page"]>[0]),
};

const failure = (id: unknown, code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
const validID = (id: unknown) => id === undefined || id === null || typeof id === "string" || typeof id === "number";

async function request(host: Host, value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return failure(null, -32600, "Invalid Request");
  const message = value as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
  if (message.jsonrpc !== "2.0" || typeof message.method !== "string" || !validID(message.id)) return failure(null, -32600, "Invalid Request");
  const notification = message.id === undefined;
  const handler = handlers[message.method as MethodName];
  const reply = (body: object) => notification ? undefined : { jsonrpc: "2.0", id: message.id, ...body };
  if (!handler) return reply({ error: { code: -32601, message: "Method not found" } });
  const params = Array.isArray(message.params) && message.params.length === 0 ? {} : message.params ?? {};
  if (typeof params !== "object" || Array.isArray(params) || !validateParams(message.method, params)) return reply({ error: { code: -32602, message: "Invalid params" } });
  try {
    const result = await handler(host, params as Params);
    if (!validateResult(message.method, result)) {
      host.logs.error("rpc", `invalid result method=${message.method}`);
      return reply({ error: { code: -32603, message: "Internal error" } });
    }
    return reply({ result });
  } catch (error) {
    const code = error instanceof RPCError ? error.code : -32000;
    host.logs.warning("rpc", `method=${message.method} failed: ${error instanceof Error ? error.message : String(error)}`);
    return reply({ error: { code, message: error instanceof Error ? error.message : String(error) } });
  }
}

export async function handleRPC(host: Host, text: string) {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return JSON.stringify(failure(null, -32700, "Parse error")); }
  if (Array.isArray(value)) {
    if (!value.length || value.length > 64) return JSON.stringify(failure(null, -32600, "Invalid Request"));
    const replies = [];
    for (const item of value) { const reply = await request(host, item); if (reply) replies.push(reply); }
    return replies.length ? JSON.stringify(replies) : undefined;
  }
  const reply = await request(host, value);
  return reply ? JSON.stringify(reply) : undefined;
}

export const changedNotification = (id: number) => JSON.stringify({ jsonrpc: "2.0", method: "conversations.changed", params: { conversationId: String(id) } });

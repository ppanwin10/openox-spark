import { createProvider, type Api, type Credential, type Model, type ModelAuth, type Provider, type ProviderStreams } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { OxError } from "@openox/agent/linux";
import { Value } from "typebox/value";
import type { TSchema } from "typebox";
import definitionSchema from "../../../shared/Host/ModelProviders/provider-definition.schema.json";
import { allowsURL, resolvesPublic } from "./net";

export interface DefinitionModel {
  id: string; name: string; wireID?: string; contextTokens?: number; outputTokens?: number; input?: string[]; output?: string[]; reasoningEfforts?: string[];
  options?: Record<string, unknown>;
}
export interface ProviderDefinition {
  id: string; name: string; url: string; api: string;
  auth: { kind: string; optional?: boolean; header?: string; [key: string]: unknown };
  options?: { headers?: Record<string, string>; extraBody?: Record<string, unknown>; maxTokensField?: string; [key: string]: unknown };
  models: DefinitionModel[];
}

export const providerSchema = definitionSchema as Record<string, unknown>;
const supportedWireProtocols = ["openai-chat-completions", "openai-responses", "anthropic-messages"] as const;
const piApis: Record<string, string> = { "openai-chat-completions": "openai-completions", "openai-responses": "openai-responses", "anthropic-messages": "anthropic-messages" };
const streams: Record<string, () => ProviderStreams> = { "openai-completions": openAICompletionsApi, "openai-responses": openAIResponsesApi, "anthropic-messages": anthropicMessagesApi };
const thinking = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
const ownedFields = new Set(["model", "messages", "input", "tools", "stream", "max_tokens", "max_completion_tokens", "max_output_tokens", "contents", "system", "systemInstruction"]);
const secretNames = new Set(["authorization", "proxy_authorization", "cookie", "set_cookie", "api_key", "apikey", "access_token", "refresh_token", "id_token", "client_secret", "password", "secret"]);
const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

const invalid = (message: string) => new OxError("invalid_argument", `Invalid provider: ${message}`, "Read ox.provider.schema() and correct the provider document before retrying.");
const unsupported = (message: string) => new OxError("not_supported", message, "Use an openai-chat-completions, openai-responses, or anthropic-messages endpoint with no, bearer, or API key authentication.");
const secretName = (name: string) => { const value = name.toLowerCase().replaceAll("-", "_"); return secretNames.has(value) || value.endsWith("_api_key"); };
const containsSecret = (value: unknown): boolean => Array.isArray(value) ? value.some(containsSecret)
  : !!value && typeof value === "object" && Object.entries(value).some(([key, entry]) => secretName(key) || containsSecret(entry));
const headerName = (value: string) => { if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(value)) throw invalid("invalid HTTP header name"); };

export function wireProtocol(api: string) {
  if (["openai-responses", "azure-openai-responses", "openai-codex-responses"].includes(api)) return "openai-responses";
  if (api === "anthropic-messages") return "anthropic-messages";
  if (["google-generative-ai", "google-vertex"].includes(api)) return "gemini-generate-content";
  return "openai-chat-completions";
}

export function thinkingLevels(model: Model<Api>): string[] {
  if (!model.reasoning) return [];
  const map = (model.thinkingLevelMap ?? {}) as Record<string, string | null | undefined>;
  return thinking.filter(level => level in map ? map[level] !== null : ["minimal", "low", "medium", "high"].includes(level));
}

function checkURL(value: string, field: string, allowHTTP: boolean) {
  let url: URL;
  try { url = new URL(value); } catch { throw invalid(`${field} must be a public endpoint without credentials, query, or fragment`); }
  if (!(url.protocol === "https:" || (allowHTTP && url.protocol === "http:")) || !url.hostname || url.username || url.password || value.includes("?") || value.includes("#")) {
    throw invalid(`${field} must be a public endpoint without credentials, query, or fragment`);
  }
}

export function validateDefinition(value: unknown): ProviderDefinition {
  const schema = providerSchema as unknown as TSchema;
  if (!Value.Check(schema, value)) {
    const errors = [...new Set([...Value.Errors(schema, value)].map(error => `${error.instancePath || "/"} ${error.message}`))].slice(0, 4).join("; ");
    throw invalid(errors);
  }
  const definition = structuredClone(value) as ProviderDefinition;
  checkURL(definition.url, "url", true);
  const options = definition.options ?? {};
  for (const header of [definition.auth.header, options.sessionHeader, options.accountHeader]) if (typeof header === "string") headerName(header);
  for (const [key, entry] of Object.entries(options.headers ?? {})) {
    headerName(key);
    if (secretName(key) || /[\r\n]/.test(entry)) throw invalid("options.headers must not contain credentials or line breaks");
  }
  if (Object.keys(options.extraBody ?? {}).some(key => ownedFields.has(key)) || containsSecret(options.extraBody ?? {})) throw invalid("extraBody overrides an owned request field or contains credential fields");
  if (new Set(definition.models.map(model => model.id)).size !== definition.models.length) throw invalid("duplicate model IDs");
  for (const model of definition.models) {
    if (model.contextTokens !== undefined && model.outputTokens !== undefined && model.outputTokens > model.contextTokens) throw invalid(`models.${model.id}.outputTokens exceeds contextTokens`);
    const modelOptions = model.options ?? {};
    if (modelOptions.serviceTier !== undefined && definition.api !== "openai-responses") throw invalid("serviceTier requires openai-responses");
    if (modelOptions.adaptiveThinking !== undefined && definition.api !== "anthropic-messages") throw invalid("adaptiveThinking requires anthropic-messages");
    if (modelOptions.replayReasoning !== undefined && definition.api !== "openai-chat-completions") throw invalid("replayReasoning requires openai-chat-completions");
    if (modelOptions.systemUpdates !== undefined && definition.api === "gemini-generate-content") throw invalid("systemUpdates is unavailable for gemini-generate-content");
  }
  if (definition.auth.kind === "oauth") {
    for (const field of ["tokenURL", "authorizeURL", "deviceAuthorizationURL"]) if (typeof definition.auth[field] === "string") checkURL(definition.auth[field] as string, field, false);
    const reserved = ["client_id", "response_type", "redirect_uri", "scope", "state", "nonce", "code_challenge", "code_challenge_method"];
    const params = Object.keys((definition.auth.authorizeParams ?? {}) as Record<string, string>);
    if (params.some(key => reserved.includes(key) || secretName(key))) throw invalid("authorizeParams overrides OAuth fields or contains credentials");
    if (typeof definition.auth.redirectURI === "string") {
      let callback: URL | undefined;
      try { callback = new URL(definition.auth.redirectURI); } catch { callback = undefined; }
      if (!callback || callback.username || callback.password || callback.hash || definition.auth.redirectURI.includes("#")) throw invalid("redirectURI is not a callback URI");
    }
  }
  if (options.streaming === "websocket-with-sse-fallback" && definition.auth.kind !== "custom") throw invalid("WebSocket account routing requires a registered custom adapter");
  return definition;
}

export function hostSupport(definition: ProviderDefinition, endpoint = true) {
  if (!(supportedWireProtocols as readonly string[]).includes(definition.api)) throw unsupported(`${definition.api} providers are not available on this Linux Host.`);
  if (!["none", "bearer", "api-key"].includes(definition.auth.kind)) throw unsupported(`${definition.auth.kind} authentication is not available on this Linux Host.`);
  if (endpoint && !allowsURL(definition.url)) throw invalid("url must be a public http or https endpoint on port 80 or 443 without credentials");
}

export async function resolvesPublicEndpoint(definition: ProviderDefinition) {
  if (!await resolvesPublic(definition.url)) throw invalid("url must resolve only to public addresses");
}

const guardedFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (!await resolvesPublic(url)) throw new Error("The provider endpoint must resolve only to public addresses");
  return fetch(input, { ...init, redirect: "error" });
}) as typeof fetch;

function authFor(definition: ProviderDefinition, key: string | undefined): ModelAuth {
  if (definition.auth.kind === "none" || !key) return { apiKey: "none" };
  const standard = definition.api === "anthropic-messages" ? "x-api-key" : "authorization";
  if (definition.auth.kind === "bearer") return definition.api === "anthropic-messages" ? { apiKey: "none", headers: { authorization: `Bearer ${key}`, "x-api-key": null } } : { apiKey: key };
  const header = definition.auth.header ?? standard;
  return header.toLowerCase() === standard ? { apiKey: key } : { apiKey: "none", headers: { [header]: key, [standard]: null } };
}

export function definitionProvider(definition: ProviderDefinition): Provider {
  const api = piApis[definition.api]!;
  const trimmed = definition.url.replace(/\/+$/, "");
  const baseUrl = api === "anthropic-messages" ? trimmed.replace(/\/v1$/, "") : trimmed;
  const wire = new Map(definition.models.filter(model => model.wireID).map(model => [model.id, model.wireID!]));
  const extra = definition.options?.extraBody ?? {};
  const provider = createProvider({ id: definition.id, name: definition.name, baseUrl, ...(definition.options?.headers ? { headers: definition.options.headers } : {}),
    auth: { apiKey: { name: `${definition.name} API key`, resolve: async ({ credential }: { credential?: Credential }) => ({
      auth: authFor(definition, credential?.type === "api_key" ? credential.key : undefined), source: "OpenOx Host" }) } },
    models: definition.models.map(model => {
      const efforts = model.reasoningEfforts ?? [];
      return { id: model.id, name: model.name, api, provider: definition.id, baseUrl, reasoning: efforts.some(level => (thinking as readonly string[]).includes(level)),
        thinkingLevelMap: Object.fromEntries(thinking.map(level => [level, efforts.includes(level) ? level : null])),
        input: model.input?.includes("image") ? ["text", "image"] as ("text" | "image")[] : ["text"] as ("text" | "image")[],
        contextWindow: model.contextTokens ?? 32_768, maxTokens: model.outputTokens ?? 4_096, cost: zeroCost,
        ...(api === "openai-completions" && definition.options?.maxTokensField ? { compat: { maxTokensField: definition.options.maxTokensField } } : {}) } as unknown as Model<Api>;
    }),
    api: streams[api]!() });
  const prepare = <T extends { onPayload?: (payload: unknown, model: Model<Api>) => unknown }>(options?: T) => ({ ...options, fetch: guardedFetch,
    onPayload: async (payload: unknown, model: Model<Api>) => {
      const value = (await options?.onPayload?.(payload, model) ?? payload) as Record<string, unknown>;
      return { ...extra, ...value, ...(wire.has(model.id) ? { model: wire.get(model.id) } : {}) };
    } }) as unknown as T;
  return {
    id: provider.id, name: provider.name, baseUrl: provider.baseUrl, headers: provider.headers, auth: provider.auth,
    getModels: () => provider.getModels(),
    stream: (model, context, options) => provider.stream(model, context, prepare(options)),
    streamSimple: (model, context, options) => provider.streamSimple(model, context, prepare(options)),
  };
}

const definitionModel = (model: Model<Api>): DefinitionModel => {
  const levels = thinkingLevels(model);
  return { id: model.id, name: model.name, contextTokens: model.contextWindow, outputTokens: model.maxTokens, input: [...model.input].sort(), output: ["text"],
    ...(levels.length ? { reasoningEfforts: levels } : {}) };
};

export function catalogDefinition(provider: Provider, models: readonly Model<Api>[], custom = false): ProviderDefinition {
  const counts = new Map<string, number>();
  for (const model of models) counts.set(model.api, (counts.get(model.api) ?? 0) + 1);
  const api = wireProtocol([...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "openai-completions");
  const auth = custom ? { kind: "bearer", optional: true } : api === "anthropic-messages" ? { kind: "api-key", header: "x-api-key" }
    : api === "gemini-generate-content" ? { kind: "api-key", header: "x-goog-api-key" } : { kind: "bearer" };
  return { id: provider.id, name: provider.name, url: provider.baseUrl ?? "", api, auth, models: models.map(definitionModel) };
}

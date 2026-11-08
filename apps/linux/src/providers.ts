import { createProvider, type Credential, type CredentialInfo, type CredentialStore, type Model, type Api, type MutableModels, type Provider } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { dirname, join } from "node:path";
import type { ModelChoice } from "@openox/agent/linux";
import { readJSON, writeJSON, type CustomProvider } from "./config";
import { definitionProvider, hostSupport, validateDefinition, type ProviderDefinition } from "./vm/models-definitions";

export const customProviderID = "custom";

const sampling = (id: string): Record<string, unknown> => /^qwen3\.[5-9]/i.test(id) ? { presence_penalty: 1.5 } : {};

function withSampling(provider: Provider): Provider {
  const prepare = <T extends { onPayload?: (payload: unknown, model: Model<Api>) => unknown }>(options?: T) => ({ ...options,
    onPayload: async (payload: unknown, model: Model<Api>) => ({ ...sampling(model.id), ...(await options?.onPayload?.(payload, model) ?? payload) as Record<string, unknown> }) }) as unknown as T;
  return { id: provider.id, name: provider.name, baseUrl: provider.baseUrl, headers: provider.headers, auth: provider.auth, getModels: () => provider.getModels(),
    stream: (model, context, options) => provider.stream(model, context, prepare(options)),
    streamSimple: (model, context, options) => provider.streamSimple(model, context, prepare(options)) };
}
const excluded = new Set(["github-copilot", "openai-codex", "radius", "typesafe"]);
const preferred = ["anthropic", "openai", "google", "openrouter", "deepseek", "xai", "mistral", "moonshotai", "zai", "groq"];
const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export interface ModelInfo { id: string; name: string; contextWindow: number; maxTokens: number; reasoning: boolean; input: string[]; api: string }
export interface ProviderInfo { id: string; name: string; configured: boolean; custom: boolean; baseUrl: string; models: ModelInfo[] }

class FileCredentials implements CredentialStore {
  private path: string;
  private values: Record<string, Credential> = {};
  private tail: Promise<unknown> = Promise.resolve();
  constructor(path: string) { this.path = path; }
  async load() { this.values = await readJSON<Record<string, Credential>>(this.path, {}); }
  async read(providerId: string) { const value = this.values[providerId]; return value ? structuredClone(value) : undefined; }
  async list(): Promise<readonly CredentialInfo[]> { return Object.entries(this.values).map(([providerId, value]) => ({ providerId, type: value.type })); }
  modify(providerId: string, change: (current: Credential | undefined) => Promise<Credential | undefined>) {
    const next = this.tail.then(async () => {
      const updated = await change(await this.read(providerId));
      if (updated === undefined) return this.read(providerId);
      this.values = { ...this.values, [providerId]: updated };
      await writeJSON(this.path, this.values);
      return structuredClone(updated);
    });
    this.tail = next.catch(() => {});
    return next;
  }
  delete(providerId: string) {
    const next = this.tail.then(async () => {
      if (!(providerId in this.values)) return;
      const { [providerId]: _, ...rest } = this.values;
      this.values = rest;
      await writeJSON(this.path, this.values);
    });
    this.tail = next.catch(() => {});
    return next;
  }
  has(providerId: string) { const value = this.values[providerId]; return value?.type === "api_key" && !!value.key; }
}

const information = (model: Model<Api>): ModelInfo => ({ id: model.id, name: model.name, contextWindow: model.contextWindow, maxTokens: model.maxTokens,
  reasoning: model.reasoning, input: [...model.input], api: model.api });

export class Providers {
  readonly models: MutableModels;
  private credentials: FileCredentials;
  private custom?: CustomProvider;
  private builtins: ReadonlyMap<string, Provider>;
  private saved = new Map<string, ProviderDefinition>();
  private definitionsPath = "";

  private constructor(credentials: FileCredentials) {
    this.credentials = credentials;
    this.models = builtinModels({ credentials, authContext: { env: async () => undefined, fileExists: async () => false } });
    this.builtins = new Map(this.models.getProviders().map(provider => [provider.id, provider]));
  }

  static async open(path: string, custom?: CustomProvider) {
    const credentials = new FileCredentials(path);
    await credentials.load();
    const providers = new Providers(credentials);
    providers.setCustom(custom);
    providers.definitionsPath = join(dirname(path), "providers.json");
    const stored = await readJSON<{ providers?: unknown }>(providers.definitionsPath, {});
    for (const value of Array.isArray(stored.providers) ? stored.providers : []) {
      try {
        const definition = validateDefinition(value);
        hostSupport(definition, false);
        if (!providers.reserved(definition.id)) providers.register(definition);
      } catch {}
    }
    return providers;
  }

  private register(definition: ProviderDefinition) {
    this.saved.set(definition.id, definition);
    this.models.setProvider(definitionProvider(definition));
  }

  private async persistDefinitions() {
    await writeJSON(this.definitionsPath, { format: 1, providers: [...this.saved.values()] });
  }

  reserved(id: string) { return id === customProviderID || this.builtins.has(id); }
  builtin(id: string) { return this.builtins.get(id); }
  listed(id: string) {
    const provider = this.models.getProvider(id);
    return provider && this.eligible(provider) ? provider : undefined;
  }
  definition(id: string) { const definition = this.saved.get(id); return definition && structuredClone(definition); }

  async saveDefinition(definition: ProviderDefinition) {
    if (this.reserved(definition.id)) throw new Error(`${definition.id} is a built-in provider on this Host; save the definition under a new id`);
    if (!this.saved.has(definition.id) && this.saved.size >= 50) throw new Error("This Host keeps at most 50 saved providers");
    const previous = this.saved.get(definition.id);
    const endpoint = (value: ProviderDefinition) => JSON.stringify([value.url, value.api, value.auth]);
    if (!previous || endpoint(previous) !== endpoint(definition)) await this.credentials.delete(definition.id);
    this.register(structuredClone(definition));
    try { await this.persistDefinitions(); }
    catch (error) {
      if (previous) this.register(previous); else { this.saved.delete(definition.id); this.models.deleteProvider(definition.id); }
      throw error;
    }
  }

  async deleteDefinition(id: string) {
    if (!this.saved.delete(id)) throw new Error(`Provider has no saved override: ${id}`);
    this.models.deleteProvider(id);
    await this.persistDefinitions();
    await this.credentials.delete(id);
  }

  authKind(id: string): "none" | "optional" | "required" {
    if (id === customProviderID) return "optional";
    const definition = this.saved.get(id);
    if (!definition) return "required";
    return definition.auth.kind === "none" ? "none" : definition.auth.optional ? "optional" : "required";
  }

  setCustom(custom?: CustomProvider) {
    this.custom = custom;
    if (!custom) { this.models.deleteProvider(customProviderID); return; }
    const baseUrl = custom.baseUrl.replace(/\/+$/, "");
    const contextWindow = custom.contextWindow ?? 131_072, maxTokens = custom.contextWindow ? Math.min(16_384, Math.floor(custom.contextWindow / 4)) : 8_192;
    this.models.setProvider(withSampling(createProvider({ id: customProviderID, name: custom.name || "Custom endpoint", baseUrl,
      auth: { apiKey: { name: "Optional API key", resolve: async ({ credential }) => ({ auth: { apiKey: credential?.key || "none" }, source: "OpenOx Host" }) } },
      models: custom.models.map(id => ({ id, name: id, api: "openai-completions", provider: customProviderID, baseUrl, reasoning: false, input: custom.images ? ["text", "image"] : ["text"],
        contextWindow, maxTokens, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })),
      api: openAICompletionsApi() })));
  }

  private eligible(provider: Provider) {
    if (this.saved.has(provider.id)) return true;
    return provider.id === customProviderID ? !!this.custom : !excluded.has(provider.id) && !!provider.auth.apiKey && !!provider.baseUrl;
  }

  configured(providerId: string) {
    if (this.saved.has(providerId)) return this.authKind(providerId) !== "required" || this.credentials.has(providerId);
    return providerId === customProviderID ? !!this.custom : this.credentials.has(providerId);
  }

  catalog(): ProviderInfo[] {
    const rank = (id: string) => { const index = preferred.indexOf(id); return index < 0 ? preferred.length : index; };
    return this.models.getProviders().filter(provider => this.eligible(provider))
      .map(provider => ({ id: provider.id, name: provider.name, configured: this.configured(provider.id), custom: provider.id === customProviderID,
        baseUrl: provider.baseUrl ?? "", models: this.configured(provider.id) ? this.models.getModels(provider.id).map(information) : [] }))
      .sort((a, b) => Number(b.custom) - Number(a.custom) || rank(a.id) - rank(b.id) || a.name.localeCompare(b.name));
  }

  available(): ModelChoice[] {
    return this.catalog().filter(provider => provider.configured).flatMap(provider => provider.models.map(model => ({ provider: provider.id, modelId: model.id })));
  }

  validChoice(choice: unknown): ModelChoice {
    const value = choice as Partial<ModelChoice> | null;
    if (!value || typeof value.provider !== "string" || typeof value.modelId !== "string") throw new Error("Choose a provider and model");
    if (!this.configured(value.provider) || !this.models.getModel(value.provider, value.modelId)) throw new Error(`Model ${value.provider}/${value.modelId} is not available; add its key in Settings`);
    if (value.thinkingLevel !== undefined && !(thinkingLevels as readonly string[]).includes(value.thinkingLevel)) throw new Error("Invalid reasoning level");
    return { provider: value.provider, modelId: value.modelId, ...(value.thinkingLevel && value.thinkingLevel !== "off" ? { thinkingLevel: value.thinkingLevel } : {}) };
  }

  async setKey(providerId: string, key: string | null) {
    const provider = this.models.getProvider(providerId);
    if (!provider || !this.eligible(provider)) throw new Error("Unknown provider");
    if (key === null) { await this.credentials.delete(providerId); return; }
    const trimmed = key.trim();
    if (!trimmed || trimmed.length > 4_096 || /\s/.test(trimmed)) throw new Error("Enter the provider's API key");
    await this.credentials.modify(providerId, async () => ({ type: "api_key", key: trimmed }));
  }

  hasKey(providerId: string) { return this.credentials.has(providerId); }
  async key(providerId: string) { const credential = await this.credentials.read(providerId); return credential?.type === "api_key" ? credential.key : undefined; }

  rows() {
    return this.catalog().filter(provider => provider.configured).map(provider => ({
      id: provider.id, displayName: provider.name, regions: ["global"], supportsTools: true, reasoningPolicy: provider.models.some(model => model.reasoning) ? "levels" : "none",
      credentialID: provider.id, endpoint: provider.baseUrl,
      models: provider.models.map(model => ({ id: model.id, providerModelID: model.id, displayName: model.name, maxTokens: model.maxTokens, maxContext: model.contextWindow,
        supportsTools: true, reasoning: model.reasoning, reasoningEfforts: model.reasoning ? ["minimal", "low", "medium", "high"] : [],
        inputModalities: model.input, outputModalities: ["text"], wireProtocol: model.api })),
    }));
  }
}

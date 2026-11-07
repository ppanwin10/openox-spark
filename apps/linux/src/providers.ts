import { createProvider, type Credential, type CredentialInfo, type CredentialStore, type Model, type Api, type MutableModels, type Provider } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import type { ModelChoice } from "@openox/agent/linux";
import { readJSON, writeJSON, type CustomProvider } from "./config";

export const customProviderID = "custom";
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

  private constructor(credentials: FileCredentials) {
    this.credentials = credentials;
    this.models = builtinModels({ credentials, authContext: { env: async () => undefined, fileExists: async () => false } });
  }

  static async open(path: string, custom?: CustomProvider) {
    const credentials = new FileCredentials(path);
    await credentials.load();
    const providers = new Providers(credentials);
    providers.setCustom(custom);
    return providers;
  }

  setCustom(custom?: CustomProvider) {
    this.custom = custom;
    if (!custom) { this.models.deleteProvider(customProviderID); return; }
    const baseUrl = custom.baseUrl.replace(/\/+$/, "");
    this.models.setProvider(createProvider({ id: customProviderID, name: custom.name || "Custom endpoint", baseUrl,
      auth: { apiKey: { name: "Optional API key", resolve: async ({ credential }) => ({ auth: { apiKey: credential?.key || "none" }, source: "OpenOx Host" }) } },
      models: custom.models.map(id => ({ id, name: id, api: "openai-completions", provider: customProviderID, baseUrl, reasoning: false, input: ["text"],
        contextWindow: 131_072, maxTokens: 8_192, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })),
      api: openAICompletionsApi() }));
  }

  private eligible(provider: Provider) {
    return provider.id === customProviderID ? !!this.custom : !excluded.has(provider.id) && !!provider.auth.apiKey && !!provider.baseUrl;
  }

  configured(providerId: string) { return providerId === customProviderID ? !!this.custom : this.credentials.has(providerId); }

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

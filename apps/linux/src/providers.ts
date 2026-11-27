import { createProvider, type Credential, type CredentialInfo, type CredentialStore, type Context, type Message, type Model, type Models, type Api, type MutableModels, type Provider } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { dirname, join } from "node:path";
import { lstatSync } from "node:fs";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { OxError, type ModelChoice } from "@openox/agent/linux";
import { readJSON, writeJSON, type HostSettings, type LocalMachine } from "./config";
import { definitionProvider, hostSupport, validateDefinition, type ProviderDefinition } from "./vm/models-definitions";
import { hostTimeZone } from "./vm/schedules-recurrence";

export const customProviderID = "custom";
export const machinePrefix = "machine-";
export const isLocalProvider = (id: string) => id === customProviderID || id.startsWith(machinePrefix);
export const vertexProviderID = "google-vertex";
const adcSchema = Type.Object({
  project: Type.String({ pattern: "^[a-z][a-z0-9-]{4,61}[a-z0-9]$" }),
  location: Type.String({ pattern: "^(global|[a-z]{2,20}-[a-z0-9-]{1,30}[0-9])$" }),
}, { additionalProperties: false });
export interface VertexADCInfo {
  project: string | null; location: string | null;
  credentialState: "available" | "missing" | "insecure" | "unavailable" | "invalid";
}
function adcFileState(path: string): VertexADCInfo["credentialState"] {
  try {
    const directory = lstatSync(dirname(path)), file = lstatSync(path), uid = process.getuid?.();
    if (!directory.isDirectory() || directory.isSymbolicLink() || directory.mode & 0o077 || directory.uid !== uid
      || !file.isFile() || file.isSymbolicLink() || file.mode & 0o077 || file.uid !== uid || file.size < 1 || file.size > 65_536) return "insecure";
    return "available";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? "missing" : "unavailable";
  }
}

export function localMachines(settings: Pick<HostSettings, "custom" | "machines">): LocalMachine[] {
  return [...(settings.custom ? [{ id: customProviderID, ...settings.custom }] : []), ...(settings.machines ?? [])];
}

export function withoutMachine(settings: HostSettings, id: string): Partial<HostSettings> {
  return { ...(id === customProviderID ? { custom: undefined } : { machines: (settings.machines ?? []).filter(machine => machine.id !== id) }),
    defaultModel: settings.defaultModel?.provider === id ? undefined : settings.defaultModel };
}

const sampling = (id: string): Record<string, unknown> => /^qwen3\.[5-9]/i.test(id) ? { presence_penalty: 1.5 } : {};

function withSampling(provider: Provider): Provider {
  const prepare = <T extends { onPayload?: (payload: unknown, model: Model<Api>) => unknown }>(options?: T) => ({ ...options,
    onPayload: async (payload: unknown, model: Model<Api>) => ({ ...sampling(model.id), ...(await options?.onPayload?.(payload, model) ?? payload) as Record<string, unknown> }) }) as unknown as T;
  return { id: provider.id, name: provider.name, baseUrl: provider.baseUrl, headers: provider.headers, auth: provider.auth, getModels: () => provider.getModels(),
    stream: (model, context, options) => provider.stream(model, context, prepare(options)),
    streamSimple: (model, context, options) => provider.streamSimple(model, context, prepare(options)) };
}
function sentAt(timeZone: string) {
  const format = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  return (time: number) => {
    const part = Object.fromEntries(format.formatToParts(time).map(({ type, value }) => [type, value]));
    return `[${part.weekday} ${part.year}-${part.month}-${part.day} ${part.hour}:${part.minute} ${timeZone}]`;
  };
}

const months: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const datePatterns: [RegExp, (m: RegExpExecArray) => [number, number, number]][] = [
  [/\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sept?(?:ember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/gi,
    m => [Number(m[3]), months[m[1]!.slice(0, 3).toLowerCase()]!, Number(m[2])]],
  [/\b(\d{4})-(\d{2})-(\d{2})\b/g, m => [Number(m[1]), Number(m[2]), Number(m[3])]],
  [/(\d{4})年(\d{1,2})月(\d{1,2})日/g, m => [Number(m[1]), Number(m[2]), Number(m[3])]],
];
export function dateDistances(text: string, time: number, timeZone: string) {
  const local = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(time).map(p => [p.type, p.value]));
  const today = Date.UTC(Number(local.year), Number(local.month) - 1, Number(local.day));
  const found: { index: number; note: string }[] = [], labels = new Set<string>();
  for (const [pattern, parse] of datePatterns) for (const m of text.matchAll(pattern)) {
    const [year, month, day] = parse(m as RegExpExecArray), target = Date.UTC(year, month - 1, day), check = new Date(target);
    if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day || labels.has(m[0])) continue;
    const days = Math.round((target - today) / 86_400_000); labels.add(m[0]);
    found.push({ index: m.index ?? 0, note: `${m[0]} = ${days === 0 ? "today" : days > 0 ? `in ${days} days` : `${-days} days ago`}` });
  }
  return found.sort((a, b) => a.index - b.index).slice(0, 6).map(f => f.note);
}

function stamped(message: Message, prefix: (time: number) => string, timeZone = hostTimeZone()): Message {
  if (message.role !== "user" || !(message.timestamp > 0)) return message;
  const body = typeof message.content === "string" ? message.content : message.content.map(part => part.type === "text" ? part.text : "").join("\n");
  const notes = process.env.OPENOX_DATE_HINTS === "1" ? dateDistances(body, message.timestamp, timeZone) : [];
  const line = prefix(message.timestamp) + (notes.length ? `\n[Computed from today's date above; do not recompute: ${notes.join("; ")}]` : "");
  if (typeof message.content === "string") return { ...message, content: message.content ? `${line}\n\n${message.content}` : line };
  const [first, ...rest] = message.content;
  return { ...message, content: first?.type === "text" ? [{ ...first, text: first.text ? `${line}\n\n${first.text}` : line }, ...rest] : [{ type: "text", text: line }, ...message.content] };
}

const requests = new Set<PropertyKey>(["stream", "complete", "streamSimple", "completeSimple"]);

export function withSendTimes<T extends Models>(models: T): T {
  return new Proxy(models, { get(target, key) {
    const value = Reflect.get(target, key, target);
    if (typeof value !== "function") return value;
    if (!requests.has(key)) return value.bind(target);
    return (model: Model<Api>, context: Context, ...rest: unknown[]) => {
      const prefix = sentAt(hostTimeZone());
      return value.call(target, model, { ...context, messages: context.messages.map(message => stamped(message, prefix)) }, ...rest);
    };
  } });
}

const excluded = new Set(["github-copilot", "openai-codex", "radius", "typesafe"]);
const preferred = ["anthropic", "openai", "google", "openrouter", "deepseek", "xai", "mistral", "moonshotai", "zai", "groq"];
const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export interface ModelInfo { id: string; name: string; contextWindow: number; maxTokens: number; reasoning: boolean; input: string[]; api: string }
export interface ProviderInfo { id: string; name: string; configured: boolean; custom: boolean; baseUrl: string; models: ModelInfo[]; adc?: VertexADCInfo }

class FileCredentials implements CredentialStore {
  private path: string;
  readonly adcFile: string | undefined;
  private values: Record<string, Credential> = {};
  private tail: Promise<unknown> = Promise.resolve();
  constructor(path: string, adcFile?: string) { this.path = path; this.adcFile = adcFile; }
  async load() { this.values = await readJSON<Record<string, Credential>>(this.path, {}); }
  async read(providerId: string) {
    if (providerId === vertexProviderID) {
      const info = this.adcInfo();
      return info?.project && info.location && info.credentialState === "available" ? this.adcCredential(info.project, info.location) : undefined;
    }
    const value = this.values[providerId]; return value ? structuredClone(value) : undefined;
  }
  async list(): Promise<readonly CredentialInfo[]> { return Object.entries(this.values).map(([providerId, value]) => ({ providerId, type: value.type })); }
  modify(providerId: string, change: (current: Credential | undefined) => Promise<Credential | undefined>) {
    const next = this.tail.then(async () => {
      const updated = await change(await this.read(providerId));
      if (updated === undefined) return this.read(providerId);
      if (providerId === vertexProviderID && !this.adcBinding(updated)) throw new OxError("invalid_argument", "Configure the explicit Host ADC connection in Models settings.");
      const next = { ...this.values, [providerId]: updated };
      await writeJSON(this.path, next);
      this.values = next;
      return structuredClone(updated);
    });
    this.tail = next.catch(() => {});
    return next;
  }
  delete(providerId: string) {
    const next = this.tail.then(async () => {
      if (!(providerId in this.values)) return;
      const { [providerId]: _, ...rest } = this.values;
      await writeJSON(this.path, rest);
      this.values = rest;
    });
    this.tail = next.catch(() => {});
    return next;
  }
  has(providerId: string) { const value = this.values[providerId]; return value?.type === "api_key" && !!value.key; }
  private adcBinding(value?: Credential) {
    const env = value?.env;
    if (!this.adcFile || value?.type !== "api_key" || value.key !== undefined || !env || typeof env !== "object" || Array.isArray(env)
      || Object.keys(env).length !== 3 || !("GOOGLE_APPLICATION_CREDENTIALS" in env) || env.GOOGLE_APPLICATION_CREDENTIALS !== this.adcFile
      || !("GOOGLE_CLOUD_PROJECT" in env) || !("GOOGLE_CLOUD_LOCATION" in env)) return undefined;
    const input = { project: env.GOOGLE_CLOUD_PROJECT, location: env.GOOGLE_CLOUD_LOCATION };
    return Value.Check(adcSchema, input) ? input : undefined;
  }
  private adcCredential(project: string, location: string): Credential {
    return { type: "api_key", env: { GOOGLE_CLOUD_PROJECT: project, GOOGLE_CLOUD_LOCATION: location, GOOGLE_APPLICATION_CREDENTIALS: this.adcFile! } };
  }
  adcInfo(): VertexADCInfo | undefined {
    if (!this.adcFile) return undefined;
    const stored = this.values[vertexProviderID], binding = this.adcBinding(stored);
    return { project: binding?.project ?? null, location: binding?.location ?? null,
      credentialState: stored && !binding ? "invalid" : adcFileState(this.adcFile) };
  }
  adcFileExists(path: string) {
    const info = this.adcInfo();
    return path === this.adcFile && !!info?.project && !!info.location && info.credentialState === "available";
  }
  async setADC(value: unknown) {
    if (!this.adcFile) throw new OxError("not_supported", "Explicit Google Cloud ADC is disabled on this Host.");
    if (value === null) { await this.delete(vertexProviderID); return; }
    if (!Value.Check(adcSchema, value)) throw new OxError("invalid_argument", "Provide only a valid Google Cloud project ID and inference location.");
    await this.modify(vertexProviderID, async () => {
      if (adcFileState(this.adcFile!) !== "available") throw new OxError("unavailable", "The private Host ADC file is missing, insecure or unavailable. Complete the approved Host-side ADC setup first.");
      return this.adcCredential(value.project, value.location);
    });
  }
}

const information = (model: Model<Api>): ModelInfo => ({ id: model.id, name: model.name, contextWindow: model.contextWindow, maxTokens: model.maxTokens,
  reasoning: model.reasoning, input: [...model.input], api: model.api });

export class Providers {
  readonly models: MutableModels;
  private credentials: FileCredentials;
  private machines = new Map<string, LocalMachine>();
  private builtins: ReadonlyMap<string, Provider>;
  private saved = new Map<string, ProviderDefinition>();
  private definitionsPath = "";

  private constructor(credentials: FileCredentials) {
    this.credentials = credentials;
    this.models = builtinModels({ credentials, authContext: { env: async () => undefined, fileExists: async path => credentials.adcFileExists(path) } });
    this.builtins = new Map(this.models.getProviders().map(provider => [provider.id, provider]));
  }

  static async open(path: string, machines: readonly LocalMachine[] = [], options: { vertexADC?: boolean } = {}) {
    const credentials = new FileCredentials(path, options.vertexADC ? join(dirname(path), "google-adc", "application_default_credentials.json") : undefined);
    await credentials.load();
    const providers = new Providers(credentials);
    providers.setMachines(machines);
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

  reserved(id: string) { return isLocalProvider(id) || this.builtins.has(id); }
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
    if (isLocalProvider(id)) return "optional";
    const definition = this.saved.get(id);
    if (!definition) return "required";
    return definition.auth.kind === "none" ? "none" : definition.auth.optional ? "optional" : "required";
  }

  setMachines(machines: readonly LocalMachine[]) {
    for (const id of this.machines.keys()) if (!machines.some(machine => machine.id === id)) this.models.deleteProvider(id);
    this.machines = new Map(machines.map(machine => [machine.id, machine]));
    for (const machine of machines) {
      const baseUrl = machine.baseUrl.replace(/\/+$/, "");
      const contextWindow = machine.contextWindow ?? 131_072, maxTokens = machine.contextWindow ? Math.min(16_384, Math.floor(machine.contextWindow / 4)) : 8_192;
      this.models.setProvider(withSampling(createProvider({ id: machine.id, name: machine.name || "Local machine", baseUrl,
        auth: { apiKey: { name: "Optional API key", resolve: async ({ credential }) => ({ auth: { apiKey: credential?.key || "none" }, source: "OpenOx Host" }) } },
        models: machine.models.map(id => ({ id, name: id, api: "openai-completions", provider: machine.id, baseUrl, reasoning: false, input: machine.images ? ["text", "image"] : ["text"],
          contextWindow, maxTokens, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })),
        api: openAICompletionsApi() })));
    }
  }

  private eligible(provider: Provider) {
    if (this.usesADC(provider.id)) return true;
    if (this.saved.has(provider.id)) return true;
    return isLocalProvider(provider.id) ? this.machines.has(provider.id) : !excluded.has(provider.id) && !!provider.auth.apiKey && !!provider.baseUrl;
  }

  configured(providerId: string) {
    if (this.usesADC(providerId)) {
      const info = this.credentials.adcInfo();
      return !!info?.project && !!info.location && info.credentialState === "available";
    }
    if (this.saved.has(providerId)) return this.authKind(providerId) !== "required" || this.credentials.has(providerId);
    return isLocalProvider(providerId) ? this.machines.has(providerId) : this.credentials.has(providerId);
  }

  catalog(): ProviderInfo[] {
    const rank = (id: string) => { const index = preferred.indexOf(id); return index < 0 ? preferred.length : index; };
    return this.models.getProviders().filter(provider => this.eligible(provider))
      .map(provider => ({ id: provider.id, name: provider.name, configured: this.configured(provider.id), custom: isLocalProvider(provider.id),
        baseUrl: this.usesADC(provider.id) ? "https://aiplatform.googleapis.com" : provider.baseUrl ?? "",
        models: this.configured(provider.id) ? this.models.getModels(provider.id).map(information) : [],
        ...(this.usesADC(provider.id) ? { adc: this.credentials.adcInfo() } : {}) }))
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
    if (this.usesADC(providerId)) throw new OxError("invalid_argument", "This provider uses Google Cloud ADC, not an API key. Use its ADC setup in Models settings.");
    const provider = this.models.getProvider(providerId);
    if (!provider || !this.eligible(provider)) throw new Error("Unknown provider");
    if (key === null) { await this.credentials.delete(providerId); return; }
    const trimmed = key.trim();
    if (!trimmed || trimmed.length > 4_096 || /\s/.test(trimmed)) throw new Error("Enter the provider's API key");
    await this.credentials.modify(providerId, async () => ({ type: "api_key", key: trimmed }));
  }

  hasKey(providerId: string) { return this.credentials.has(providerId); }
  usesADC(providerId: string) { return providerId === vertexProviderID && this.credentials.adcFile !== undefined; }
  adcInfo() { return this.credentials.adcInfo(); }
  setADC(value: unknown) { return this.credentials.setADC(value); }
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

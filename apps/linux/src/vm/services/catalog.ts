import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { validateIOSManifest, validateMCPManifest } from "@openox/protocol/catalog";
import { validateServiceManifest } from "@openox/protocol/manifest";
import { CONVERSATION_ACTION_SCHEMA, MODEL_ACTION_SCHEMAS, normalizedModelSchema } from "@openox/protocol/model-actions";
import { repositoryServiceIdentity, repositoryServiceKind, validateRepositoryPackage } from "@openox/protocol/repository";
import type { VMPaths } from "../context";
import { allowsURL, isTestURL } from "../net";
import { loadRepositoryState, type ConnectedRepository } from "../repository-state";
import { runIsolated } from "./sandbox";
import { describe, directoryHash, fail, isObject, regularFile, walk, type JSONObject, type Kind } from "./support";

export type Provenance = "bundled" | "local" | "remote";
export interface RepositoryEntry {
  id: string; name: string; provenance: Provenance; root: string; enabled: boolean; state: "ready" | "failed"; error: string | null;
  services: string[]; skills: string[]; url: string | null; syncedAt: number | null; commit: string | null;
}
export interface Candidate { qualified: string; kind: Kind; identity: string; runtime: string; repository: RepositoryEntry; root: string; path: string }
export interface Conflict { service: string; selectedRepository: string | null; candidates: Candidate[] }
export interface CatalogState { repositories: RepositoryEntry[]; selected: Map<string, Candidate>; conflicts: Conflict[]; candidates: Map<string, Candidate[]> }
export interface ActionDef {
  id: string; label: string; description?: string; baseUrl?: string; blocking: boolean; inputSchema: unknown; outputSchema: unknown;
  requireApproval: boolean; requireAuth: boolean; raw: JSONObject;
}
export interface Snapshot { domain: string; kind: Kind; version: string; definition: Definition; source: string }
export interface Definition {
  candidate: Candidate; kind: Kind; domain: string; name: string; description: string; baseUrl: string | null; faviconUrl: string | null;
  actions: ActionDef[]; index: Map<string, ActionDef>; defs: Record<string, unknown>; manifest: JSONObject;
  auth?: JSONObject; endpoint?: string; transport?: "streamable-http" | "sse";
}

const priority: Record<Provenance, number> = { bundled: 0, local: 1, remote: 3 };
const emptyObject = { type: "object", properties: {}, additionalProperties: false };
export const generationActions = new Set(["startModelGeneration", "continueModelGeneration", "readModelGeneration", "cancelModelGeneration"]);
export const searchInputSchema = { type: "object", properties: { query: { type: "string", minLength: 1 }, limit: { type: "integer", minimum: 1, maximum: 50, default: 10 },
  cursor: { type: "string", minLength: 1 } }, required: ["query"], additionalProperties: false };
const completion = (states: string[]) => ({ type: "object", properties: { completed: { const: true }, completion: { type: "string", enum: states },
  state: { type: "string" } }, required: ["completed", "completion", "state"], additionalProperties: false });
const host = (id: string, description: string, outputSchema: unknown): ActionDef => ({ id, label: id, description, blocking: false, inputSchema: emptyObject, outputSchema,
  requireApproval: false, requireAuth: false, raw: { id, description, inputSchema: emptyObject, outputSchema, requireApproval: false, requireAuth: false } });
const hostStandard: Record<"api" | "mcp" | "ios", ActionDef[]> = {
  api: [
    host("credentialStatus", "Read credential configuration without prompting or contacting the API. Configured credentials are not verified server access.",
      { type: "object", properties: { state: { type: "string", enum: ["configured", "notConfigured", "notRequired"] } }, required: ["state"], additionalProperties: false }),
    host("configureCredentials", "Open Host-managed credential setup. Never request credentials in chat. Completion means configuration, not verified API access. Do not reopen after cancellation or replay writes.",
      completion(["configured", "notRequired"])),
  ],
  mcp: [
    host("connectionStatus", "Check server connectivity and authentication readiness without prompting or invoking tools. Connectivity is not tool authorization; errors are not absence.",
      { type: "object", properties: { state: { type: "string", enum: ["authorized", "authorizationRequired", "notRequired"] } }, required: ["state"], additionalProperties: false }),
    host("authorize", "Run the server's supported authorization flow through the Host. Available before tool discovery succeeds. Do not reopen after cancellation or replay writes.",
      completion(["authorized", "notRequired"])),
  ],
  ios: [
    host("permissionStatus", "Read native permission state without prompting. OS permission is not account authentication.",
      { type: "object", properties: { state: { type: "string", enum: ["authorized", "authorizationRequired", "denied", "notRequired"] } }, required: ["state"], additionalProperties: false }),
    host("requestPermission", "Ask the user for the service's native OS permission through the Host. Do not reopen after cancellation or replay writes.",
      completion(["authorized", "notRequired"])),
  ],
};

export const runtimeID = (kind: Kind, identity: string) => kind === "ios" ? `ios:${identity}` : identity;
export const qualifiedName = (definition: { kind: Kind; domain: string }, action: string) =>
  definition.kind === "ios" ? `${definition.domain}:${action}` : `${definition.kind}:${definition.domain}:${action}`;
export const sessionsEnabled = (definition: Definition) => definition.kind === "web" && definition.index.has("listSessions") && definition.index.has("login");

function parseAction(raw: JSONObject): ActionDef {
  return { id: String(raw.id), label: typeof raw.label === "string" ? raw.label : String(raw.id), ...(typeof raw.description === "string" ? { description: raw.description } : {}),
    ...(typeof raw.baseUrl === "string" ? { baseUrl: raw.baseUrl } : {}), blocking: raw.blocking === true, inputSchema: raw.inputSchema, outputSchema: raw.outputSchema,
    requireApproval: raw.requireApproval === true, requireAuth: raw.requireAuth === true, raw };
}

function expanded(schema: unknown, defs: Record<string, unknown>, depth = 0): JSONObject {
  if (depth > 12) throw fail("invalid_contract", "Search schema reference is too deep.");
  if (!isObject(schema)) return {};
  const reference = schema.$ref;
  if (typeof reference !== "string") return schema;
  if (!reference.startsWith("#/$defs/")) throw fail("invalid_contract", "Search schema uses an unsupported reference.");
  const target = defs[reference.slice(8)];
  if (!target) throw fail("invalid_contract", "Search schema reference is missing.");
  return expanded(target, defs, depth + 1);
}

export function searchInput(definition: Definition, action: ActionDef) {
  const service = `web:${definition.domain}`;
  const input = expanded(action.inputSchema, definition.defs), output = expanded(action.outputSchema, definition.defs);
  const properties = isObject(input.properties) ? input.properties : {};
  const required = Array.isArray(input.required) ? input.required : [];
  const type = (schema: unknown) => (isObject(schema) ? expanded(schema, definition.defs).type : undefined);
  const types = (schema: unknown, expected: string[]) => {
    const value = type(schema);
    const actual = Array.isArray(value) ? value : value === undefined ? [] : [value];
    return actual.length === expected.length && expected.every(entry => actual.includes(entry));
  };
  const outputProperties = isObject(output.properties) ? output.properties : {};
  const outputRequired = Array.isArray(output.required) ? output.required : [];
  if (input.type !== "object" || input.additionalProperties !== false || !required.includes("query") || !required.every(name => name === "query")
    || type(properties.query) !== "string" || type(properties.limit) !== "integer" || type(properties.cursor) !== "string"
    || !Object.keys(properties).every(key => ["query", "limit", "cursor"].includes(key)) || output.type !== "object"
    || !["items", "nextCursor", "scope", "coverage"].every(field => outputRequired.includes(field))) {
    throw fail("invalid_contract", `${service}:search does not implement the standard search contract.`, "Inspect the service search contract before retrying.");
  }
  const items = expanded(outputProperties.items, definition.defs);
  const item = expanded(items.items, definition.defs);
  const itemProperties = isObject(item.properties) ? item.properties : {};
  const itemRequired = Array.isArray(item.required) ? item.required : [];
  const coverage = expanded(outputProperties.coverage, definition.defs);
  if (output.additionalProperties !== false || !types(outputProperties.items, ["array"]) || !types(outputProperties.nextCursor, ["string", "null"])
    || !types(outputProperties.scope, ["string"]) || !types(outputProperties.coverage, ["string"])
    || !["complete", "partial", "unknown"].every(value => Array.isArray(coverage.enum) && coverage.enum.includes(value))
    || item.type !== "object" || item.additionalProperties !== false || !["title", "url", "snippet"].every(field => itemRequired.includes(field))
    || !types(itemProperties.title, ["string"]) || !types(itemProperties.url, ["string", "null"]) || !types(itemProperties.snippet, ["string", "null"])) {
    throw fail("invalid_contract", `${service}:search does not declare standard search results.`, "Inspect the service search contract before retrying.");
  }
  return input;
}

export function searchMaximum(definition: Definition, action: ActionDef) {
  const input = searchInput(definition, action);
  const limit = isObject(input.properties) && isObject(input.properties.limit) ? expanded(input.properties.limit, definition.defs) : {};
  const maximum = limit.maximum;
  if (typeof maximum !== "number" || !Number.isInteger(maximum) || maximum < 1 || maximum > 50) {
    throw fail("invalid_contract", "Search limit must declare a maximum from 1 to 50.", "Inspect the service search contract before retrying.");
  }
  return maximum;
}

const sameSchema = (actual: unknown, expected: unknown, defs: Record<string, unknown>) => {
  try { return JSON.stringify(normalizedModelSchema(actual, defs as Record<string, Record<string, unknown>>)) === JSON.stringify(normalizedModelSchema(expected)); }
  catch { return false; }
};

export function standardActions(definition: Definition): ActionDef[] {
  if (definition.kind !== "web") return hostStandard[definition.kind];
  const standard: ActionDef[] = [];
  for (const id of ["listSessions", "login", "search", "listModels", "conversation"]) {
    const action = definition.index.get(id);
    if (!action) continue;
    if (id === "listSessions" || id === "login") { if (sessionsEnabled(definition)) standard.push(action); continue; }
    if (id === "search") {
      try { if (!action.requireApproval && searchMaximum(definition, action)) standard.push(action); } catch {}
      continue;
    }
    const expected = id === "conversation" ? CONVERSATION_ACTION_SCHEMA : MODEL_ACTION_SCHEMAS.listModels!;
    if (sameSchema(action.inputSchema, expected.inputSchema, definition.defs) && sameSchema(action.outputSchema, expected.outputSchema, definition.defs)) standard.push(action);
  }
  return standard;
}

export const isGenerationAction = (definition: Definition, id: string) => definition.kind === "web" && generationActions.has(id);

export function exposedActions(definition: Definition) {
  const standard = standardActions(definition);
  const ids = new Set(standard.map(action => action.id));
  return [...standard, ...definition.actions.filter(action => !isGenerationAction(definition, action.id) && !ids.has(action.id))];
}

export function findAction(definition: Definition, id: string, includingStandard = false) {
  if (definition.kind !== "web") {
    const standard = hostStandard[definition.kind].find(action => action.id === id);
    if (standard) return standard;
  }
  const action = definition.index.get(id);
  return action && (includingStandard || !isGenerationAction(definition, id)) ? action : undefined;
}

export const isHostStandard = (definition: Definition, id: string) => definition.kind !== "web" && hostStandard[definition.kind].some(action => action.id === id);

export function actionDetail(definition: Definition, id: string) {
  const action = findAction(definition, id);
  if (!action) return undefined;
  const withDefs = (schema: unknown) => isObject(schema) && Object.keys(definition.defs).length && schema.$defs === undefined ? { ...schema, $defs: definition.defs } : schema ?? {};
  const entry: JSONObject = {};
  if (typeof action.raw.label === "string") entry.description = action.raw.label;
  if (typeof action.raw.description === "string") entry.description = action.raw.description;
  entry.requireAuth = action.requireAuth;
  if (action.requireApproval) entry.requireApproval = true;
  entry.inputSchema = withDefs(action.inputSchema ?? {});
  entry.outputSchema = withDefs(action.outputSchema ?? null);
  return entry;
}

export function resolvedBaseURL(definition: Definition, action: ActionDef, args: unknown) {
  const raw = action.baseUrl ?? definition.baseUrl;
  if (!raw) return undefined;
  const question = raw.indexOf("?");
  if (question < 0) return raw;
  const hash = raw.indexOf("#", question);
  const query = raw.slice(question + 1, hash < 0 ? undefined : hash);
  const input = isObject(args) ? args : {};
  const parts = query.split("&").flatMap(part => {
    const separator = part.indexOf("=");
    if (separator < 0) return [part];
    const name = part.slice(0, separator), value = part.slice(separator + 1);
    const placeholder = /^\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(decodeURIComponent(value));
    if (!placeholder) return [part];
    const supplied = input[placeholder[1]!];
    return typeof supplied === "string" ? [`${name}=${encodeURIComponent(supplied)}`] : [];
  });
  return `${raw.slice(0, question)}${parts.length ? `?${parts.join("&")}` : ""}${hash < 0 ? "" : raw.slice(hash)}`;
}

async function readPackage(root: string, provenance: Provenance) {
  const path = join(root, "repository.json");
  const info = await lstat(path).catch(() => undefined);
  if (!info) throw new Error("The repository is missing repository.json at its root.");
  if (info.isSymbolicLink() || !info.isFile() || info.size > 512_000) throw new Error("repository.json is invalid or too large");
  let raw: unknown;
  try { raw = JSON.parse(await readFile(path, "utf8")); } catch { throw new Error("repository.json is invalid"); }
  const validated = validateRepositoryPackage(raw);
  if ("error" in validated) throw new Error(`repository.json: ${validated.error}`);
  if (!validated.name.trim()) throw new Error("repository.json metadata is invalid");
  if (provenance !== "bundled" && validated.services.some(service => repositoryServiceKind(service) === "ios")) throw new Error("External repositories cannot provide native iOS services");
  return validated;
}

export async function validatePackageDirectory(root: string, provenance: Provenance) {
  const validated = await readPackage(root, provenance);
  for (const service of validated.services) {
    const kind = repositoryServiceKind(service) as Kind, identity = repositoryServiceIdentity(service);
    await validateServiceFiles(join(root, kind, identity), kind, identity, service);
  }
  for (const skill of validated.skills) await regularFile(join(root, "skills", skill, "SKILL.md"), 1_000_000, `skills/${skill}/SKILL.md`);
  return validated;
}

export async function validateServiceFiles(root: string, kind: Kind, identity: string, qualified: string) {
  const info = await lstat(root).catch(() => undefined);
  if (!info?.isDirectory() || info.isSymbolicLink()) throw fail("invalid_argument", `Service source directory is unavailable: ${qualified}`, "Create the service directory before validating it.");
  const manifestPath = join(root, "service.json");
  await regularFile(manifestPath, 512_000, "service.json");
  let manifest: unknown;
  try { manifest = JSON.parse(await readFile(manifestPath, "utf8")); } catch (error) { throw fail("invalid_argument", `service.json is not valid JSON: ${describe(error)}`, "Fix the JSON syntax."); }
  const declared = isObject(manifest) ? kind === "mcp" ? manifest.id : manifest.domain : undefined;
  if (declared !== runtimeID(kind, identity)) throw fail("invalid_argument", `Manifest identity mismatch for ${qualified}`, "Make the manifest identity match its directory.");
  if (kind === "web" || kind === "api") await regularFile(join(root, "actions.js"), 1_000_000, "actions.js");
  let total = 0;
  for (const file of await walk(root)) {
    total += file.size;
    if (total > 4_000_000) throw fail("invalid_argument", `Service ${qualified} is too large`, "Keep each service under 4 MB.");
  }
  return manifest;
}

interface Cached { mtimeMs: number; size: number; result: Definition | Error }

export class Catalog {
  private paths: VMPaths;
  private bundledEnabled: () => boolean;
  private bundledPackage?: Promise<Awaited<ReturnType<typeof readPackage>>>;
  private definitions = new Map<string, Cached>();
  private bundledHashes = new Map<string, string>();

  constructor(paths: VMPaths, bundledEnabled: () => boolean) {
    this.paths = paths;
    this.bundledEnabled = bundledEnabled;
  }

  private async entry(id: string, provenance: Provenance, root: string, enabled: boolean, stored?: ConnectedRepository): Promise<RepositoryEntry> {
    const base = { id, provenance, root, enabled, url: stored?.url ?? null, syncedAt: stored?.syncedAt ?? null, commit: stored?.commit ?? null };
    try {
      const loaded = provenance === "bundled" ? await (this.bundledPackage ??= readPackage(root, provenance)) : await readPackage(root, provenance);
      return { ...base, name: loaded.name, state: "ready", error: stored?.error ?? null, services: [...loaded.services], skills: [...loaded.skills] };
    } catch (error) {
      if (provenance === "bundled") this.bundledPackage = undefined;
      return { ...base, name: stored?.name ?? (provenance === "local" ? "Local" : provenance === "bundled" ? "Built-in" : id), state: "failed", error: describe(error), services: [], skills: [] };
    }
  }

  async repositories() {
    const state = await loadRepositoryState(this.paths.state);
    const entries = await Promise.all([
      this.entry("bundled", "bundled", this.paths.bundled, this.bundledEnabled()),
      this.entry("local", "local", this.paths.local, true),
      ...state.repositories.map(stored => this.entry(stored.id, "remote", join(this.paths.repositories, stored.id), stored.enabled, stored)),
    ]);
    return { entries, selections: state.selections };
  }

  async load(): Promise<CatalogState> {
    const { entries, selections } = await this.repositories();
    const candidates = new Map<string, Candidate[]>();
    for (const repository of entries) {
      if (!repository.enabled || repository.state !== "ready") continue;
      for (const qualified of repository.services) {
        const kind = repositoryServiceKind(qualified) as Kind, identity = repositoryServiceIdentity(qualified), runtime = runtimeID(kind, identity);
        const candidate: Candidate = { qualified, kind, identity, runtime, repository, root: join(repository.root, kind, identity), path: `repositories/${repository.id}/${kind}/${identity}` };
        candidates.set(runtime, [...candidates.get(runtime) ?? [], candidate]);
      }
    }
    const selected = new Map<string, Candidate>(), conflicts: Conflict[] = [];
    for (const runtime of [...candidates.keys()].sort()) {
      const options = candidates.get(runtime)!.sort((a, b) => priority[a.repository.provenance] - priority[b.repository.provenance]
        || a.repository.name.localeCompare(b.repository.name, undefined, { sensitivity: "base" }));
      candidates.set(runtime, options);
      if (options.length === 1) { selected.set(runtime, options[0]!); continue; }
      const chosen = options.find(option => selections[option.qualified] === option.repository.id) ?? options.find(option => option.repository.provenance === "bundled");
      if (chosen) selected.set(runtime, chosen);
      conflicts.push({ service: runtime, selectedRepository: chosen?.repository.id ?? null, candidates: options });
    }
    return { repositories: entries, selected, conflicts, candidates };
  }

  async definition(candidate: Candidate): Promise<Definition> {
    const path = join(candidate.root, "service.json");
    const info = await lstat(path).catch(() => undefined);
    if (!info || info.isSymbolicLink() || !info.isFile() || info.size > 512_000) throw fail("invalid_argument", `Service manifest is unavailable: ${candidate.path}/service.json`, "Inspect the service source.");
    const key = `${candidate.repository.id}:${candidate.qualified}:${path}`;
    const cached = this.definitions.get(key);
    if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) {
      if (cached.result instanceof Error) throw cached.result;
      return { ...cached.result, candidate };
    }
    let result: Definition | Error;
    try { result = this.parse(candidate, await readFile(path, "utf8")); }
    catch (error) { result = error instanceof Error ? error : new Error(String(error)); }
    if (this.definitions.size > 1_000) this.definitions.delete(this.definitions.keys().next().value!);
    this.definitions.set(key, { mtimeMs: info.mtimeMs, size: info.size, result });
    if (result instanceof Error) throw result;
    return result;
  }

  private parse(candidate: Candidate, text: string): Definition {
    let raw: unknown;
    try { raw = JSON.parse(text); } catch (error) { throw fail("invalid_argument", `service.json is not valid JSON: ${describe(error)}`, "Fix the manifest syntax."); }
    if (!isObject(raw)) throw fail("invalid_argument", "invalid root", "Fix the manifest.");
    const base = { candidate, kind: candidate.kind, domain: candidate.runtime, manifest: raw };
    if (candidate.kind === "ios") {
      const manifest = validateIOSManifest(candidate.runtime, raw);
      if ("error" in manifest) throw fail("invalid_argument", manifest.error, "Inspect the native service manifest.");
      const actions = manifest.actions.map(action => parseAction(action as unknown as JSONObject));
      return { ...base, name: manifest.name, description: manifest.description ?? "", baseUrl: null, faviconUrl: manifest.faviconUrl ?? null, actions,
        index: new Map(actions.map(action => [action.id, action])), defs: {} };
    }
    if (candidate.kind === "mcp") {
      const endpoint = typeof raw.endpoint === "string" ? raw.endpoint : "";
      const testing = URL.canParse(endpoint) && isTestURL(new URL(endpoint));
      const manifest = validateMCPManifest(candidate.identity, testing ? { ...raw, endpoint: endpoint.replace(/^http:/, "https:") } : raw);
      if ("error" in manifest) throw fail("invalid_argument", manifest.error, "Fix the MCP connection definition.");
      return { ...base, name: manifest.name, description: manifest.description ?? `Remote MCP server at ${new URL(endpoint).host}`, baseUrl: endpoint,
        faviconUrl: manifest.faviconUrl ?? null, actions: [], index: new Map(), defs: {}, endpoint, ...(manifest.transport ? { transport: manifest.transport } : {}) };
    }
    const validated = validateServiceManifest(raw, "repository");
    if (!validated.ok) throw fail("invalid_argument", `invalid manifest: ${validated.errors.slice(0, 5).join("; ")}`, "Repair the manifest, then validate the service again.");
    if (raw.domain !== candidate.identity || (raw.kind === "api") !== (candidate.kind === "api")) {
      throw fail("invalid_argument", `Service identity does not match ${candidate.kind}/${candidate.identity}`, "Make the manifest domain and kind match the service directory.");
    }
    const baseUrl = String(raw.baseUrl);
    if (candidate.kind === "api" && !allowsURL(baseUrl, ["https:"])) throw fail("invalid_argument", "invalid baseUrl", "Use a public HTTPS API base URL.");
    const faviconUrl = typeof raw.faviconUrl === "string" ? raw.faviconUrl : null;
    if (faviconUrl && !allowsURL(faviconUrl, ["https:"])) throw fail("invalid_argument", "invalid faviconUrl", "Use a public HTTPS favicon URL.");
    const actions = (raw.actions as JSONObject[]).map(parseAction);
    return { ...base, name: String(raw.name), description: typeof raw.description === "string" ? raw.description : "", baseUrl, faviconUrl, actions,
      index: new Map(actions.map(action => [action.id, action])), defs: isObject(raw.$defs) ? raw.$defs : {}, ...(isObject(raw.auth) ? { auth: raw.auth } : {}) };
  }

  async version(candidate: Candidate) {
    const cached = candidate.repository.provenance === "bundled" ? this.bundledHashes.get(candidate.root) : undefined;
    const hash = cached ?? await directoryHash(candidate.root);
    if (candidate.repository.provenance === "bundled") this.bundledHashes.set(candidate.root, hash);
    return `${candidate.qualified}:${candidate.repository.id}:${hash}`;
  }

  async source(candidate: Candidate) {
    await regularFile(join(candidate.root, "actions.js"), 1_000_000, "actions.js");
    try { return new TextDecoder("utf-8", { fatal: true }).decode(await readFile(join(candidate.root, "actions.js"))); }
    catch { throw fail("invalid_argument", "actions.js is not UTF-8", "Save actions.js as UTF-8 text."); }
  }

  async validate(candidate: Candidate) {
    await validateServiceFiles(candidate.root, candidate.kind, candidate.identity, candidate.qualified);
    if (candidate.kind === "ios") throw fail("not_supported", "Native iOS services cannot be edited in Local.", "Use web, API, or MCP services on this Host.");
    const definition = await this.definition(candidate);
    if (candidate.kind === "mcp") return definition;
    const source = await this.source(candidate);
    const kind = candidate.kind;
    const script = `const source = ${JSON.stringify(source)};
try { new Function(source); } catch (error) { return { error: "actions.js syntax: " + String(error && error.message || error) }; }
globalThis.window = globalThis;
let installations = 0;
const registered = [];
globalThis.ox = { install(installer, ...extra) {
  installations++;
  if (installations > 1) throw new Error("service installer may run only once");
  if (typeof installer !== "function" || extra.length) throw new Error("window.ox.install takes only the installer");
  const action = (name, definition) => {
    if (typeof name !== "string" || !name) throw new Error("action name must be a non-empty string");
    if (registered.includes(name)) throw new Error("duplicate action: " + name);
    if (typeof definition?.invoke !== "function") throw new Error("action " + name + " has no invoke function");
    registered.push(name);
  };
  const unavailable = () => { throw new Error("not callable during registration validation"); };
  const api = new Proxy(Object.freeze(${kind === "api" ? "{ action, request: unavailable }" : "{ action }"}), { get(target, name) {
    if (name in target) return target[name];
    throw new Error("service installer does not provide " + String(name));
  } });
  const result = installer(api);
  if (result && typeof result.then === "function") throw new Error("service installer must be synchronous");
} };
try { (0, eval)(source); } catch (error) { return { error: "actions.js registration: " + String(error && error.message || error) }; }
return { installations, registered };`;
    const result = await runIsolated(script, { timeoutMs: 5_000, memoryLimitBytes: 64 * 1024 * 1024 });
    if (!result.ok) throw fail("invalid_argument", `actions.js registration: ${result.error.message}`, "Fix actions.js, then validate the service again.");
    const value = result.value as { error?: string; installations?: number; registered?: string[] };
    if (value.error) throw fail("invalid_argument", value.error, "Fix actions.js, then validate the service again.");
    if (value.installations !== 1 || !Array.isArray(value.registered)) throw fail("invalid_argument", "actions.js must install exactly once", "Call window.ox.install exactly once.");
    const declared = new Set(definition.actions.map(action => action.id)), implemented = new Set(value.registered);
    const missing = [...declared].filter(id => !implemented.has(id)).sort(), extra = [...implemented].filter(id => !declared.has(id)).sort();
    if (missing.length || extra.length) {
      const details = [missing.length ? `missing implementations: ${missing.join(", ")}` : "", extra.length ? `undeclared implementations: ${extra.join(", ")}` : ""].filter(Boolean).join("; ");
      throw fail("invalid_argument", `actions.js registration mismatch; ${details}`, "Register every declared action exactly once.");
    }
    return definition;
  }
}

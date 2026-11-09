import { FileError, OxError, type AppFileRequest, type FileBackend, type FileInfo, type FunctionCall, type ModelChoice } from "@openox/agent/linux";
import type { VMContext } from "./context";
import { actionLabel, builtInActions, defaultPolicy, sourceID, type Policy } from "./approvals";
import { addedProvider, providerDefinition } from "./models";
import { exposedActions, qualifiedName } from "./services/catalog";
import type { Services } from "./services/manager";
import { repositoryStatus } from "./services/repositories";
import { canonicalJSON, isObject, same } from "./services/support";

const files = ["providers.json", "services.json", "policy.json", "status.json", "logs.jsonl"];
const writable = new Set(["providers.json", "services.json"]);
const purpose = "Read app configuration";
const logsNotice = "Read app-wide diagnostic logs\nLogs may include private data from other conversations and become available to the current model. Always approve applies to all app logs.";
const pretty = (value: unknown) => JSON.stringify(JSON.parse(canonicalJSON(value)), null, 2) + "\n";
const filename = (action: string) => `${encodeURIComponent(action)}.json`;
const entry = (path: string, directory = false): FileInfo => ({ path, name: path.split("/").at(-1)!, kind: directory ? "directory" : "file", size: 0, mtimeMs: 0 });
type Gate = (action: string, body?: string) => Promise<void>;
const secrets: [RegExp, string][] = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer <redacted>"],
  [/(["']?\b(?:authorization|cookie|set-cookie|(?:access|refresh|id|session)[_-]?token|token|api[_-]?key|client[_-]?secret|password|secret)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\r\n,}]+)/gi, "$1<redacted>"],
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "<redacted>"],
  [/\bsk-[A-Za-z0-9_-]{12,}/g, "sk-<redacted>"],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{12,}|github_pat_[A-Za-z0-9_]{12,})/g, "github_<redacted>"],
  [/\bAIza[A-Za-z0-9_-]{12,}/g, "AIza<redacted>"],
];
const segment = (value: string) => value.length > 32 ? "<redacted>" : value;
function redactedURL(raw: string) {
  try {
    const url = new URL(raw), keys = [...new Set([...url.searchParams.keys()].map(segment))].sort().join(",");
    const value = `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ""}${url.pathname.split("/").map(segment).join("/")}${keys ? `?keys=${keys}` : ""}`;
    return value.length > 240 ? `${value.slice(0, 240)}… chars=${value.length}` : value;
  } catch { return raw.split(/[?#]/)[0]!.split("/").map(segment).join("/"); }
}
const redacted = (text: string) => secrets.reduce((value, [pattern, replacement]) => value.replace(pattern, replacement), text.replace(/\bhttps?:\/\/[^\s"'<>]+/gi, redactedURL));
const invalid = (message: string) => new OxError("invalid_argument", message, "Read the file again and keep its fields and JSON format.");
const changed = (message: string) => new OxError("file_changed", message, "Read the file again and rebuild the edit from its current contents.");

function actionOf(path: string) {
  if (!path.startsWith("actions/")) return undefined;
  const name = path.slice("actions/".length);
  let action = "";
  try { if (name.endsWith(".json")) action = decodeURIComponent(name.slice(0, -5)); } catch {}
  if (!action || action.length > 500 || filename(action) !== name) throw new FileError("invalid", "Use app/actions/<encodeURIComponent(action)>.json for an exact Action", `app/${path}`);
  return action;
}

function known(path: string) {
  if (path === "settings.json") throw new FileError("not_found", "This Host has no app/settings.json: each browser keeps its own language.", "app/settings.json");
  if (path !== "" && path !== "actions" && !files.includes(path) && !actionOf(path)) throw new FileError("not_found", "App file not found", `app/${path}`);
}

export function appFiles(context: VMContext, services: Services) {
  const { approvals } = services;
  const providers = context.providers;
  const revisions = new Map<string, string>();

  const providerCatalog = () => {
    const stored = context.settings().defaultModel;
    return {
      format: 2,
      providers: providers.catalog().filter(info => addedProvider(providers, info.id)).map(info => providerDefinition(providers, info.id)),
      ...(stored ? { defaultModel: { providerID: stored.provider, modelID: stored.modelId, ...(stored.thinkingLevel ? { reasoningEffort: stored.thinkingLevel } : {}) } } : {}),
    };
  };
  const defaultModel = () => {
    const stored = context.settings().defaultModel, effective = context.defaultModel();
    if (!effective) return null;
    const { provider, modelId } = effective, key = providers.hasKey(provider), kind = providers.authKind(provider);
    return {
      configured: stored?.provider === provider && stored.modelId === modelId,
      provider: { id: provider, name: providers.listed(provider)?.name ?? provider },
      model: { id: modelId, name: providers.models.getModel(provider, modelId)?.name ?? modelId },
      thinkingLevel: effective.thinkingLevel ?? null, supportsTools: true,
      authentication: { method: key || kind === "required" ? "apiKey" : "none", status: key ? "ready" : kind === "required" ? "missingCredential" : "notRequired", settingsPath: "Settings > Models" },
    };
  };
  const actionDefault = async (action: string): Promise<Policy> => {
    if (action.startsWith("ox.")) return defaultPolicy(action);
    const definition = await services.definitionFor(sourceID(action)).catch(() => undefined);
    const found = definition && exposedActions(definition).find(candidate => qualifiedName(definition, candidate.id) === action);
    return found && !found.requireApproval ? "allow" : "ask";
  };

  async function text(gate: Gate | undefined, path: string) {
    const action = actionOf(path);
    if (action) {
      await gate?.("ox.app.actionPolicies");
      const stored = approvals.stored(), source = sourceID(action);
      return pretty({ defaultPolicy: stored.defaultPolicy, truncated: false,
        resolved: { action, source, policy: approvals.policy(action, await actionDefault(action)),
          inheritedFrom: stored.actions[action] ? "action" : stored.sources[source] ? "source" : stored.defaultPolicy ? "default" : "actionDefault" },
        overrides: stored.actions[action] ? [{ scope: "action", id: action, source, policy: stored.actions[action] }] : [] });
    }
    switch (path) {
      case "policy.json": {
        await gate?.("ox.app.actionPolicies");
        const stored = approvals.stored();
        return pretty({ format: 2, ...(stored.defaultPolicy ? { defaultPolicy: stored.defaultPolicy } : {}), sources: stored.sources, actions: stored.actions });
      }
      case "providers.json":
        await gate?.("ox.provider.list");
        return pretty(providerCatalog());
      case "services.json":
        return pretty(services.preferences.snapshot());
      case "status.json": {
        for (const action of ["ox.app.info", "ox.app.profiles", "ox.app.defaultModel", "ox.app.repositories"]) await gate?.(action);
        return pretty({
          app: { name: "Ox", version: context.version, platform: "linux" },
          profiles: { profiles: [{ name: context.settings().profile.name, storage: "local", active: true }], truncated: false },
          notifications: null, language: null, defaultModel: defaultModel(), repositories: await repositoryStatus(services), host: { allowConnections: true },
        });
      }
      case "logs.jsonl":
        await gate?.("ox.app.logs", logsNotice);
        return context.logs.snapshot().map(row => {
          const characters = Array.from(redacted(row.message));
          return JSON.stringify({ timestamp: row.time, level: row.level, category: row.category, message: characters.slice(0, 2_048).join(""), truncated: characters.length > 2_048 }) + "\n";
        }).join("");
    }
    throw new FileError("not_found", "App file not found", `app/${path}`);
  }

  async function saveServices(fields: Record<string, unknown>, revision: string) {
    const { names, saved } = fields;
    if (Object.keys(fields).sort().join() !== "format,names,saved" || fields.format !== 1 || !isObject(names) || !Array.isArray(saved)
      || Object.entries(names).some(([domain, name]) => !domain || typeof name !== "string" || !name.trim())
      || saved.some(domain => typeof domain !== "string" || !domain) || new Set(saved).size !== saved.length) throw invalid("Unsupported service preference fields.");
    const current = services.preferences.snapshot(), state = await services.catalog.load();
    const exists = (domain: string) => state.selected.has(domain) || state.conflicts.some(conflict => conflict.service === domain);
    if ([...saved.filter(domain => !current.saved.includes(domain)), ...Object.keys(names).filter(domain => !(domain in current.names))].some(domain => !exists(domain))) {
      throw new OxError("invalid_argument", "New service preferences must refer to existing services.", "List services with ox.service.list and use their domains.");
    }
    await services.preferences.update(file => {
      if (pretty({ format: 1, names: file.names, saved: file.saved }) !== revision) throw changed("App configuration changed after reading.");
      file.names = Object.fromEntries(Object.entries(names).map(([domain, name]) => [domain, (name as string).trim()]));
      file.saved = saved as string[];
    });
    services.changed();
  }

  async function saveProviders(call: FunctionCall, fields: Record<string, unknown>, revision: string) {
    const selection = fields.defaultModel ?? null;
    if (Object.keys(fields).some(key => !["format", "providers", "defaultModel"].includes(key)) || fields.format !== 2) throw invalid("Unsupported provider configuration fields.");
    if (selection !== null && (!isObject(selection) || Object.keys(selection).some(key => !["providerID", "modelID", "reasoningEffort"].includes(key))
      || typeof selection.providerID !== "string" || typeof selection.modelID !== "string" || !["string", "undefined"].includes(typeof selection.reasoningEffort))) throw invalid("Unsupported default-model fields.");
    const current = providerCatalog();
    if (!same(fields.providers ?? [], current.providers)) {
      throw new OxError("not_supported", "This Host changes provider definitions only with ox.provider.save and ox.provider.delete.", "Keep providers unchanged here; use ox.provider.save or ox.provider.delete for definitions.");
    }
    if (same(selection, current.defaultModel)) return;
    let choice: ModelChoice | undefined;
    if (selection) {
      try { choice = providers.validChoice({ provider: selection.providerID, modelId: selection.modelID, thinkingLevel: selection.reasoningEffort }); }
      catch (error) { throw new OxError("invalid_argument", error instanceof Error ? error.message : String(error), "Choose an existing provider from ox.provider.list and an exact available model ID from ox.provider.get."); }
    }
    await approvals.require(call, "ox.app.setDefaultModel", defaultPolicy("ox.app.setDefaultModel"),
      { body: "Change the default model for new conversations", args: choice ? { provider: choice.provider, model: choice.modelId, thinkingLevel: choice.thinkingLevel ?? null } : null });
    if (await text(undefined, "providers.json") !== revision) throw changed("Provider configuration changed during approval.");
    await context.updateSettings({ defaultModel: choice });
  }

  return {
    forget(conversationId: number) { for (const key of revisions.keys()) if (key.startsWith(`${conversationId}:`)) revisions.delete(key); },
    backend(call: FunctionCall, request: AppFileRequest): FileBackend {
      const ask: Gate = (action, body = purpose) => approvals.require(call, action, defaultPolicy(action), { body });
      const editable = async () => {
        if (!(await call.profile.summary(call.conversationId)).temporary) return;
        throw new OxError("profile_required", `${call.name}: Temporary conversations can't save changes.`, "Ask the user to continue in a regular conversation to change app settings.");
      };
      const skip = (path: string): Gate => async action => {
        const policy = approvals.policy(action, defaultPolicy(action));
        if (policy === "allow") return;
        const shown = path.startsWith("actions/") ? "app/actions" : `app/${path}`;
        if (!request.diagnostics.some(entry => entry.path === shown)) request.diagnostics.push({ path: shown, message: policy === "block"
          ? `Not searched: the user blocked ${actionLabel(action) ?? action} (${action}) in Settings.`
          : `Not searched: ${actionLabel(action) ?? action} (${action}) asks the user first, so folder searches skip it. Read the file by name if it is needed.` });
        throw new FileError("not_supported", "App file not searched without approval", `app/${path}`);
      };
      return {
        id: "app",
        assertWritable: path => {
          known(path);
          if (request.operation !== "write" && request.operation !== "edit") {
            throw new OxError("not_supported", "App files do not support deletion, directory creation, moves, copies, or attachment.", "Read app files with ox.fs.read and change services.json or the default model with ox.fs.edit.");
          }
          if (!writable.has(path)) throw new OxError("permission_denied", "This app file is read-only.", "Inspect its current contents; use trusted Settings controls for protected preferences. Do not bypass file permissions.");
        },
        info: async path => { known(path); return entry(path, path === "" || path === "actions"); },
        list: async path => {
          known(path);
          if (path === "") return [...files.map(name => entry(name)), entry("actions", true)];
          if (path !== "actions") throw new FileError("not_directory", `Not an app directory: app/${path}`, `app/${path}`);
          const actions = [...new Set([...builtInActions().map(action => action.id), ...Object.keys(approvals.stored().actions)])].sort();
          if (actions.length > 1_000) throw new FileError("invalid", "Action inventory exceeds the listing limit; read an exact encoded action path", "app/actions");
          return actions.map(action => entry(`actions/${filename(action)}`));
        },
        read: async path => {
          known(path);
          if (path === "" || path === "actions") throw new FileError("is_directory", "Cannot read an app directory", `app/${path}`);
          if (path === "logs.jsonl" && request.path !== "app/logs.jsonl") {
            throw new FileError("permission_denied", "Read or search app/logs.jsonl explicitly; app-wide logs are excluded from directory searches", "app/logs.jsonl");
          }
          if (request.operation === "write" || request.operation === "edit") await editable();
          const value = await text(request.operation === "grep" && request.path !== `app/${path}` ? skip(path) : ask, path);
          if (Buffer.byteLength(value) > 32 * 1024 * 1024) throw new FileError("invalid", "App file exceeds the read safety limit", `app/${path}`);
          if (writable.has(path) && request.operation === "read") revisions.set(`${call.conversationId}:${path}`, value);
          return value;
        },
        write: async (path, content, _context, expected) => {
          await editable();
          if (typeof content !== "string") throw new OxError("invalid_argument", "App configuration requires UTF-8 JSON content.", "Use ox.fs.read, then ox.fs.edit with valid JSON. Binary configuration writes are unsupported.");
          const key = `${call.conversationId}:${path}`, revision = expected ?? revisions.get(key);
          if (revision === undefined) throw new OxError("invalid_state", "Read the app file before replacing it; prefer ox.fs.edit.", "Read the file with ox.fs.read, then change it with ox.fs.edit.");
          let fields: unknown;
          try { fields = JSON.parse(content); } catch {}
          if (Buffer.byteLength(content) > 200 * 1024 || !isObject(fields)) throw invalid("App configuration must be a bounded JSON object.");
          if (await text(undefined, path) !== revision) throw changed("App configuration changed after reading.");
          if (path === "services.json") await saveServices(fields, revision);
          else await saveProviders(call, fields, revision);
          revisions.delete(key);
        },
      };
    },
  };
}

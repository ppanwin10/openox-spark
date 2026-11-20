import { museParityEnabled } from "../config";
import { HTTPError, json, payload } from "../http";
import type { VMRoute } from "./context";
import { policies, type PermissionChange, type Policy } from "./approvals";
import { exposedActions, qualifiedName } from "./services/catalog";
import type { Services } from "./services/manager";
import { isObject } from "./services/support";
import { directProtocols, protocolEnabled } from "./network-policy";

const uuid = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const browser = [
  { id: "ox.web.browser.publicPages", label: "Visit and read public pages", group: "read", available: true },
  { id: "ox.web.browser.visit", label: "Visit websites", group: "read", available: true },
  { id: "ox.web.browser.read", label: "Read page content", group: "read", available: true },
  { id: "ox.web.browser.interact", label: "Interact with pages", group: "write", available: true },
  { id: "ox.web.browser.credentials", label: "Fill saved credentials", group: "write", available: false,
    reason: "Safe origin-bound Host credential injection is unavailable. Saved passwords do not authorize Browser actions." },
  { id: "ox.web.browser.download", label: "Download files", group: "write", available: true },
  { id: "ox.web.browser.upload", label: "Upload files", group: "write", available: true },
  { id: "ox.web.browser.background", label: "Scheduled Browser access", group: "background", available: true },
] as const;
type Action = { id: string; label: string; group: string; available: boolean; reason?: string; policy: Policy | null; effective: Policy; scope: string };
type ObjectRow = { id: string; name: string; actions: Action[]; available: boolean; custom: boolean; reason?: string };

export function musePermissionRoute(services: Services): VMRoute {
  const { approvals, context } = services;
  const inventory = async () => {
    const stored = await approvals.current();
    let actionCount = 0, bytes = 0;
    const budget = (value: unknown) => {
      bytes += Buffer.byteLength(JSON.stringify(value));
      if (bytes > 4 * 1024 * 1024) throw new HTTPError(503, "The complete permission inventory exceeds its response limit.");
    };
    const action = (id: string, label: string, group: string, fallback: Policy, available = true, reason?: string): Action => {
      if (++actionCount > 5000) throw new HTTPError(503, "The complete permission inventory exceeds its action limit.");
      const row = { id, label, group, available, ...(reason ? { reason } : {}), policy: stored.actions[id] ?? null,
        effective: approvals.policy(id, fallback), scope: approvals.resolution(id, fallback).scope };
      budget(row); return row;
    };
    const connectorRows: ObjectRow[] = [{ id: "@browser", name: "Browser", available: true,
      custom: browser.some(row => stored.actions[row.id] !== undefined),
      reason: "Arbitrary scripts require read, interact, upload and download permission together. Upload/download cannot be isolated inside a script. Persistent injected scripts and unsupervised sync are unavailable; background means actual scheduled Browser access.",
      actions: browser.map(row => {
        const projected = action(row.id, row.label, row.group, "ask", row.available, "reason" in row ? row.reason : undefined);
        if (row.id !== "ox.web.browser.publicPages" && row.id !== "ox.web.browser.visit") return projected;
        const resolved = approvals.browserResolution(null, row.id === "ox.web.browser.visit" ? "visit" : "publicPages");
        return { ...projected, effective: resolved.policy, scope: resolved.restricted ? "restriction" : resolved.scope };
      }) }];
    const state = await services.catalog.load();
    if (state.selected.size > 1000 || state.repositories.some(row => row.state === "failed")) throw new HTTPError(503, "The original connector inventory is incomplete or exceeds its limit.");
    for (const candidate of state.selected.values()) {
      if (candidate.kind === "ios") continue;
      const cached = await services.definitionFor(candidate.runtime).catch(() => undefined);
      const definition = cached?.kind === candidate.kind && cached.candidate.repository.id === candidate.repository.id ? cached
        : await services.catalog.definition(candidate).catch(() => undefined);
      if (!definition) {
        budget({ id: candidate.runtime, name: candidate.runtime });
        connectorRows.push({ id: candidate.runtime, name: candidate.runtime, actions: [], available: false, custom: false, reason: "The original connector definition is unavailable." });
        continue;
      }
      const actions = exposedActions(definition).map(row => action(qualifiedName(definition, row.id), row.label,
        definition.kind === "api" && !row.requireApproval ? "read" : "write", approvals.connectorFallback(definition.kind, row.requireApproval)));
      actions.push(action(`ox.connector.background:${definition.domain}`, "Scheduled connector access", "background", "ask"));
      connectorRows.push({ id: definition.domain, name: services.title(definition), available: true,
        custom: stored.sources[definition.domain] !== undefined || actions.some(row => row.policy !== null), actions,
        ...(definition.kind === "api" ? {} : { reason: "Website installers and unknown MCP tools are conservatively treated as write actions. Connection does not grant action permission." }) });
      budget({ id: definition.domain, name: services.title(definition) });
    }
    const sites = new Set(Object.keys(stored.actions).filter(key => key.startsWith("ox.web.browser:")).map(key => key.slice("ox.web.browser:".length).split(":")[0]!)
      .filter(site => /^[a-z0-9.-]{1,253}$/.test(site)));
    const websites: ObjectRow[] = [...sites].sort().map(site => ({ id: site, name: site, available: true, custom: true,
      actions: [action(`ox.web.browser:${site}`, "Website access", "read", "ask"),
        ...browser.filter(row => row.available).map(row => {
          const resolved = approvals.browserResolution(site, row.id.split(".").at(-1)! as BrowserCapability);
          const projected = action(`ox.web.browser:${site}:${row.id.split(".").at(-1)}`, row.label, row.group, resolved.policy);
          return { ...projected, effective: resolved.policy, scope: resolved.restricted ? "restriction" : resolved.scope };
        })] }));
    await context.profile().syncLibrary();
    const spaces: ObjectRow[] = (await context.profile().library.listSpaces()).map(space => ({ id: space.id, name: space.name, available: !space.missing,
      custom: stored.actions[`ox.space.bridge:${space.id}`] !== undefined,
      actions: [action(`ox.space.bridge:${space.id}`, "Call connected services", "write", "ask", !space.missing),
        action(`ox.space.privateData:${space.id}`, "Read private workspace data", "read", "block", false,
          "Private owner reads are not exposed to HTML. The original eight-function service bridge and sandbox remain unchanged.")] }));
    const scheduledTasks: ObjectRow[] = (await context.permissionSchedules()).map(task => ({ id: task.id, name: task.name, available: true,
      custom: stored.actions[`ox.schedule.execute:${task.id}`] !== undefined,
      actions: [action(`ox.schedule.execute:${task.id}`, "Start scheduled task", "background", "ask")] }));
    const protocols = directProtocols.map(item => ({ ...item, available: true, enabled: protocolEnabled(stored.actions, item.id),
      reason: item.id === "dns" ? "Structured queries use an explicit public resolver. Internal HTTP resolution is separate; stricter action policies still apply."
        : "One finite classified transport exchange requires per-connection approval. Not a complete application client or deep-packet inspection." }));
    const objects = { connectors: connectorRows, websites, spaces, scheduledTasks, protocols };
    for (const row of [...spaces, ...scheduledTasks]) budget({ id: row.id, name: row.name });
    const result = { available: true, revision: stored.revision, defaults: stored.defaults,
      advancedOverrides: stored.defaultPolicy !== null || Object.keys(stored.sources).length > 0,
      groups: Object.entries(objects).map(([id, rows]) => ({ id, count: rows.length })), objects };
    if ((await approvals.current()).revision !== stored.revision) throw new HTTPError(409, "Permissions changed while loading. Reload before continuing.");
    if (Buffer.byteLength(JSON.stringify(result)) > 4 * 1024 * 1024) throw new HTTPError(503, "The complete permission inventory exceeds its response limit.");
    return result;
  };
  return async (request, _url, parts, owner) => {
    if (!museParityEnabled()) throw new HTTPError(404, "Muse permissions are not enabled.");
    if (!owner || !await context.ownerActive?.(owner)) throw new HTTPError(403, "The original paired owner is unavailable.");
    if (parts.length === 2 && parts[0] === "requests" && uuid(parts[1]) && request.method === "GET") return json(await approvals.requestProof(owner, parts[1]));
    if (parts.length) throw new HTTPError(404, "Permission request not found.");
    if (request.method === "GET") return json(await inventory());
    if (request.method !== "POST") throw new HTTPError(405, "Use a permission request.");
    const body = await payload<Record<string, unknown>>(request, 8192);
    if (!isObject(body) || !uuid(body.requestId) || !Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 0) throw new HTTPError(400, "Send the permission request identity and current revision.");
    const { requestId, expectedRevision, ...fields } = body;
    const keys = Object.keys(fields).sort().join(",");
    const data = await inventory();
    const rows = [...data.objects.connectors, ...data.objects.websites, ...data.objects.spaces, ...data.objects.scheduledTasks];
    let change: PermissionChange;
    if (fields.operation === "default" && keys === "operation,target,value" && ["connectors", "web"].includes(String(fields.target)) && ["some", "ask"].includes(String(fields.value))) {
      change = fields as PermissionChange;
    } else if (fields.operation === "protocol" && keys === "confirm,enabled,id,operation" && fields.confirm === true
      && typeof fields.enabled === "boolean" && directProtocols.some(item => item.id === fields.id)) {
      change = fields as PermissionChange;
    } else if (fields.operation === "action" && keys === "id,operation,policy" && typeof fields.id === "string"
      && (fields.policy === null || policies.includes(fields.policy as Policy)) && rows.some(row => row.actions.some(action => action.id === fields.id && action.available))) {
      change = fields as PermissionChange;
    } else if (fields.operation === "source" && keys === "id,operation,policy" && typeof fields.id === "string"
      && (fields.policy === null || policies.includes(fields.policy as Policy)) && data.objects.connectors.some(row => row.id !== "@browser" && row.id === fields.id && row.available)) {
      change = fields as PermissionChange;
    } else if (fields.operation === "reset" && keys === "confirm,object,operation" && fields.confirm === true && typeof fields.object === "string"
      && ["all", "browser", ...data.objects.connectors.filter(row => row.id !== "@browser").map(row => `connector:${row.id}`),
        ...data.objects.websites.map(row => `website:${row.id}`), ...data.objects.spaces.map(row => `space:${row.id}`), ...data.objects.scheduledTasks.map(row => `schedule:${row.id}`)].includes(fields.object)) {
      change = fields as PermissionChange;
    } else throw new HTTPError(400, "Choose an available permission, default or explicitly confirmed reset.");
    const epoch = context.contentEpoch?.() ?? 0;
    const result = await approvals.change(owner, requestId, Number(expectedRevision), change, next => {
      if (change.operation !== "reset") return;
      if (change.object === "all") {
        delete next.defaultPolicy; next.sources = {}; next.actions = {};
        if (next.muse) next.muse.defaults = { connectors: "some", web: "some" };
        return;
      }
      const [kind, ...identity] = change.object.split(":"), id = identity.join(":");
      const remove = (key: string) => kind === "browser" ? key.startsWith("ox.web.browser.")
        : kind === "connector" ? approvals.belongs(key, id, `${stateKind(id)}:${id}`) || key === `ox.connector.background:${id}`
        : kind === "website" ? key === `ox.web.browser:${id}` || key.startsWith(`ox.web.browser:${id}:`)
        : key.startsWith(kind === "space" ? `ox.space.bridge:${id}` : `ox.schedule.execute:${id}`);
      const stateKind = (domain: string) => data.objects.connectors.find(row => row.id === domain)?.actions.find(row => /^(web|api|mcp):/.test(row.id))?.id.split(":")[0] ?? "web";
      next.actions = Object.fromEntries(Object.entries(next.actions).filter(([key]) => !remove(key)));
      if (kind === "connector") delete next.sources[id];
    }, async () => {
      if (context.contentEpoch?.() !== epoch || context.contentBlocked?.() || !await context.ownerActive?.(owner)) throw new HTTPError(409, "The workspace or paired owner changed. Nothing was saved.");
    });
    return json(result);
  };
}
export type BrowserCapability = "visit" | "publicPages" | "read" | "interact" | "download" | "upload" | "background";

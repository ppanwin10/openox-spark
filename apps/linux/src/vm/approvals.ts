import { join } from "node:path";
import { OxError, type ApprovalReceipt, type FunctionCall } from "@openox/agent/linux";
import { canonicalJSON, clone, fail, isObject, readJSONFile, Serial, sha256, writeJSONFile } from "./services/support";
import { HTTPError, json } from "../http";
import type { VMContext, VMFactory } from "./context";
import { museParityEnabled, personalAgentEnabled, proactiveAgentEnabled } from "../config";
import { metadataPage } from "./metadata-page";
import { lstat, readFile } from "node:fs/promises";
import { protocolEnabled, protocolKey, type DirectProtocol } from "./network-policy";
import { publicLookupEngines, type PublicLookup } from "./public-lookup";

export type Policy = "ask" | "allow" | "block";
export type RiskDefaults = { connectors: "some" | "ask"; web: "some" | "ask" };
interface PolicyRequest { owner: string; fingerprint: string; revision: number }
interface PolicyFile { format: 2; defaultPolicy?: Policy; sources: Record<string, Policy>; actions: Record<string, Policy>;
  muse?: { version: 1; revision: number; defaults: RiskDefaults; requests: Record<string, PolicyRequest> } }
export type PermissionChange = { operation: "default"; target: keyof RiskDefaults; value: "some" | "ask" }
  | { operation: "action" | "source"; id: string; policy: Policy | null }
  | { operation: "protocol"; id: DirectProtocol; enabled: boolean; confirm: true }
  | { operation: "reset"; object: string; confirm: true };
type RequireOptions = { title?: string; body?: string; args?: unknown; sourceURL?: string; detail?: string;
  browser?: { site: string | null; capability: string; familiar: boolean }; anonymousSearch?: boolean; connection?: boolean; originalAction?: string; standing?: string };
type TaskScope = { id: string; expires: number; schedule?: string; goal?: string; publicLookup?: PublicLookup; active?: () => boolean; grants: Set<string>; denials: Set<string> };
const initialDefaults = (): RiskDefaults => ({ connectors: "some", web: "some" });
const ownerUnavailable = () => new HTTPError(503, "The original action policy is unavailable, changed or invalid. No permission was granted.");
const permissionDenied = () => fail("permission_denied", "The permission changed, expired or was denied. No further operation is authorized; earlier effects are not undone.", "Stop. Read current permissions before asking the user to continue.");
const validRevision = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) < Number.MAX_SAFE_INTEGER;

const builtIn = new Set([
  "ox.secret.list", "ox.secret.add", "ox.secret.delete", "ox.web.search",
  "ox.service.list", "ox.service.listAttached", "ox.service.inspect", "ox.service.checkAccess", "ox.service.validate", "ox.service.create",
  "ox.service.update", "ox.service.delete", "ox.repository.connect", "ox.repository.sync", "ox.repository.enable", "ox.repository.disconnect",
  "ox.repository.conflicts", "ox.repository.resolve", "ox.service.attach", "ox.service.showPage", "ox.service.signIn", "ox.service.detach", "ox.app.repositories",
  "ox.provider.list", "ox.app.info", "ox.app.profiles", "ox.app.defaultModel", "ox.app.setDefaultModel", "ox.app.actionPolicies", "ox.app.logs",
]);
const labels: Record<string, string> = {
  "ox.secret.list": "List secrets", "ox.secret.add": "Add a secret", "ox.secret.delete": "Delete a secret", "ox.web.search": "Search the web",
  "ox.service.list": "Services", "ox.service.listAttached": "List attached services", "ox.service.inspect": "Inspect a service",
  "ox.service.checkAccess": "Inspect a service", "ox.service.validate": "Validate a service", "ox.service.create": "Create a service",
  "ox.service.update": "Update a service", "ox.service.delete": "Delete a service", "ox.repository.connect": "Add Repository",
  "ox.repository.conflicts": "Conflicts", "ox.repository.resolve": "Choose", "ox.repository.sync": "Sync", "ox.repository.enable": "Repositories",
  "ox.repository.disconnect": "Remove Repository", "ox.service.attach": "Attach a service", "ox.service.showPage": "Show page",
  "ox.service.signIn": "Service login", "ox.service.detach": "Detach a service", "ox.app.repositories": "Repositories",
  "ox.provider.list": "List model providers", "ox.app.info": "App info", "ox.app.profiles": "Profiles", "ox.app.defaultModel": "Default model",
  "ox.app.setDefaultModel": "Change default model", "ox.app.actionPolicies": "Actions", "ox.app.logs": "Logs",
  "ox.network.exchange": "Make a direct connection", "ox.network.resolve": "Query an external DNS resolver",
};

export const defaultPolicy = (action: string): Policy => {
  if (action.startsWith("ox.service.attach:")) return "allow";
  if (!builtIn.has(action)) return "ask";
  return action.endsWith(".delete") || action === "ox.app.logs" ? "ask" : "allow";
};
export const actionLabel = (action: string): string | undefined => labels[action] ?? functionLabels[action];
export const policies: readonly Policy[] = ["ask", "allow", "block"];

export function sourceID(action: string) {
  if (action.startsWith("ox.service.attach:")) return action.slice("ox.service.attach:".length);
  if (action.startsWith("ox.connector.background:")) return action.slice("ox.connector.background:".length);
  if (action.startsWith("ox.")) return "ox";
  for (const prefix of ["web:", "api:", "mcp:"]) if (action.startsWith(prefix)) return action.slice(prefix.length).split(":")[0] || "ox";
  const separator = action.lastIndexOf(":");
  if (separator < 0) return "ox";
  const namespace = action.slice(0, separator);
  for (const prefix of ["web:", "api:", "mcp:"]) if (namespace.startsWith(prefix)) return namespace.slice(prefix.length);
  return namespace;
}

const functionLabels: Record<string, string> = {
  "ox.plan.capture": "Manage local plans and reminders", "ox.todo.preferences": "Set default reminder time",
  "ox.schedule.create": "Create a schedule", "ox.schedule.delete": "Delete a schedule", "ox.schedule.enable": "Change a schedule", "ox.schedule.run": "Run a schedule",
  "ox.todo.create": "Create a Todo", "ox.todo.update": "Update a Todo", "ox.todo.delete": "Delete a Todo",
  "ox.watch.list": "List page watches", "ox.watch.create": "Create a page watch", "ox.watch.update": "Update a page watch", "ox.watch.delete": "Delete a page watch",
  "ox.goal.list": "List goals", "ox.goal.create": "Create a goal", "ox.goal.update": "Update a goal", "ox.goal.delete": "Delete a goal",
  "ox.library.list": "List Library metadata", "ox.library.tag": "Classify an audio artifact",
  "ox.space.list": "List Spaces", "ox.space.create": "Create a persistent Space", "ox.space.update": "Update a Space", "ox.space.delete": "Remove a Space",
  "ox.feed.list": "Read Feed objects", "ox.feed.setPrompt": "Save the Feed prompt", "ox.feed.publish": "Publish Feed updates",
  "ox.idea.list": "Read Ideas", "ox.idea.publish": "Save actionable Ideas",
  "ox.identity.get": "Read Agent identity", "ox.identity.update": "Change Agent identity", "ox.identity.setSoul": "Save Agent guidance",
  "ox.memory.propose": "Save a memory suggestion", "ox.skill.propose": "Save a Skill suggestion",
  "ox.conversation.delete": "Delete Conversation", "ox.skill.delete": "Delete a skill", "ox.provider.generate": "Run a model", "ox.provider.delete": "Delete a model provider",
};
const stores = new Map<string, Approvals>();

export function builtInActions() {
  const asked = Object.entries(functionLabels).filter(([id]) => (!["ox.plan.capture", "ox.todo.preferences"].includes(id) || proactiveAgentEnabled())
    && ((!id.startsWith("ox.todo.") && !id.startsWith("ox.watch.")
    && !["ox.memory.propose", "ox.skill.propose"].includes(id)) || personalAgentEnabled()) && (!/^ox\.(goal|library|space|feed|idea|identity|network)\./.test(id) || museParityEnabled()))
    .map(([id, label]) => ({ id, label, default: "ask" as Policy }));
  const known = [...builtIn].filter(id => !(id in functionLabels)).map(id => ({ id, label: labels[id] ?? id, default: defaultPolicy(id) }));
  return [...asked, ...known].map(action => ({ ...action, group: action.id.split(".")[1] ?? "app" }));
}

export interface ApprovalEntry { action: string; policy: Policy; kind: "service" | "browser" | "function"; label: string; target: string | null }

export function describeAction(action: string, policy: Policy): ApprovalEntry {
  if (action.startsWith("ox.web.browser:")) return { action, policy, kind: "browser", label: "Browser", target: action.slice("ox.web.browser:".length) };
  if (action.startsWith("ox.service.attach:")) return { action, policy, kind: "service", label: "Attach", target: action.slice("ox.service.attach:".length) };
  if (action.startsWith("ox.")) return { action, policy, kind: "function", label: functionLabels[action] ?? actionLabel(action) ?? action, target: null };
  const separator = action.lastIndexOf(":");
  return { action, policy, kind: "service", label: separator < 0 ? action : action.slice(separator + 1), target: sourceID(action) };
}
const auditRequests = new WeakMap<FunctionCall, string>();
export async function recordApproval(call: FunctionCall, action: string, decision: ApprovalReceipt["decision"], scope: ApprovalReceipt["scope"], sourceURL?: string) {
  if (!museParityEnabled()) return;
  let request = call.requestID ?? auditRequests.get(call);
  if (!request) { request = crypto.randomUUID(); auditRequests.set(call, request); }
  const named = /^ox\.[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)*$/.test(action);
  const browser = action.startsWith("ox.web.browser:");
  const safeAction = named ? action : browser ? "browserAccess" : "serviceAction";
  const rawSource = sourceURL ?? (browser ? action.slice("ox.web.browser:".length) : sourceID(action));
  let source: string | null = null;
  if (rawSource !== "ox") {
    try {
      const url = new URL(rawSource.includes("://") ? rawSource : `https://${rawSource}`);
      if (["http:", "https:"].includes(url.protocol) && /^[A-Za-z0-9.-]+$/.test(url.hostname)) source = url.origin;
    } catch { source = null; }
  }
  const origin = call.page || call.conversationId < 0 ? "page" : "conversation";
  await call.profile.approvalHistory.record({ action: safeAction, label: named ? actionLabel(action) ?? safeAction : browser ? "Browser access" : "Service action",
    source, decision, scope, conversationId: origin === "conversation" ? call.conversationId : null, origin },
  `${request}:${sha256(action)}:${safeAction}:${source ?? ""}:${decision}:${scope}`);
}
export async function approvalAnswer(call: FunctionCall, action: string, scope: ApprovalReceipt["scope"], request: Parameters<FunctionCall["ask"]>[0], sourceURL?: string) {
  try { return await call.untimed(() => call.ask(request)); }
  catch (error) {
    if (call.signal.aborted || error instanceof OxError && error.code === "cancelled") await recordApproval(call, action, "cancelled", scope, sourceURL);
    throw error;
  }
}

export class Approvals {
  private path: string;
  private file: PolicyFile = { format: 2, sources: {}, actions: {} };
  private serial = new Serial();
  private promptQueues = new Map<number, { serial: Serial; pending: number }>();
  private loading?: Promise<void>;
  private ownerFailure = false;
  private tasks = new Map<number, TaskScope>();
  private leases = new WeakMap<FunctionCall, { revision: number; task?: TaskScope }>();
  private declinedSearches = new WeakSet<FunctionCall>();
  private browserRevokers = new Set<() => Promise<void>>();
  private changes = new Set<() => void>();

  private constructor(state: string) { this.path = join(state, "action-policies.json"); }

  static for(state: string) {
    let store = stores.get(state);
    if (!store) { store = new Approvals(state); stores.set(state, store); }
    return store;
  }

  private async permissionTurn<T>(call: FunctionCall, work: () => Promise<T>) {
    if (call.page || call.conversationId < 0) return work();
    let queue = this.promptQueues.get(call.conversationId);
    if (!queue) {
      queue = { serial: new Serial(), pending: 0 };
      this.promptQueues.set(call.conversationId, queue);
    }
    queue.pending++;
    try { return await call.untimed(() => queue.serial.run(work)); }
    finally {
      queue.pending--;
      if (!queue.pending && this.promptQueues.get(call.conversationId) === queue) this.promptQueues.delete(call.conversationId);
    }
  }

  load() {
    this.loading ??= (async () => {
      if (museParityEnabled()) {
        try { this.file = await this.readOwnerPolicy(); this.ownerFailure = false; } catch { this.ownerFailure = true; }
        return;
      }
      const stored = await readJSONFile<Partial<PolicyFile>>(this.path, {});
      this.file = { ...stored, format: 2, sources: stored.sources ?? {}, actions: stored.actions ?? {}, ...(stored.defaultPolicy ? { defaultPolicy: stored.defaultPolicy } : {}) };
    })().catch(error => { this.loading = undefined; throw error; });
    return this.loading;
  }
  private async readOwnerPolicy() {
    let stored: unknown;
    try {
      const info = await lstat(this.path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 2 * 1024 * 1024) throw new Error();
      stored = JSON.parse(await readFile(this.path, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { format: 2, sources: {}, actions: {} } as PolicyFile;
      throw ownerUnavailable();
    }
    if (!isObject(stored) || stored.format !== 2 || !isObject(stored.sources) || !isObject(stored.actions)
      || Object.keys(stored.sources).length + Object.keys(stored.actions).length > 5000
      || [...Object.values(stored.sources), ...Object.values(stored.actions), ...(stored.defaultPolicy === undefined ? [] : [stored.defaultPolicy])]
        .some(value => !policies.includes(value as Policy))) throw ownerUnavailable();
    if (stored.muse !== undefined) {
      const muse = stored.muse;
      if (!isObject(muse) || muse.version !== 1 || !validRevision(muse.revision) || !isObject(muse.defaults)
        || Object.keys(muse.defaults).length !== 2 || !["some", "ask"].includes(String(muse.defaults.connectors)) || !["some", "ask"].includes(String(muse.defaults.web))
        || !isObject(muse.requests) || Object.keys(muse.requests).length > 5000
        || Object.entries(muse.requests).some(([id, proof]) => !/^[a-f0-9-]{36}$/.test(id) || !isObject(proof)
          || Object.keys(proof).length !== 3 || !/^[a-f0-9]{64}$/.test(String(proof.owner)) || !/^[a-f0-9]{64}$/.test(String(proof.fingerprint))
          || !validRevision(proof.revision) || Number(proof.revision) > Number(muse.revision))) throw ownerUnavailable();
    }
    return stored as unknown as PolicyFile;
  }
  private async verifyOwnerPolicy() {
    const stored = await this.readOwnerPolicy();
    if (this.ownerFailure) { this.file = stored; this.ownerFailure = false; }
    if (canonicalJSON(stored) !== canonicalJSON(this.file)) throw ownerUnavailable();
  }
  get revision() { return this.file.muse?.revision ?? 0; }
  get defaults(): RiskDefaults { return { ...(this.file.muse?.defaults ?? initialDefaults()) }; }
  connectorFallback(kind: string, requiresApproval: boolean): Policy {
    return museParityEnabled() ? kind === "api" && !requiresApproval && this.defaults.connectors === "some" ? "allow" : "ask" : requiresApproval ? "ask" : "allow";
  }
  fallback(action: string, fallback: Policy): Policy {
    if (!museParityEnabled() || fallback === "block") return fallback;
    for (const kind of ["web", "api", "mcp"]) if (action.startsWith(`${kind}:`)) return this.connectorFallback(kind, fallback === "ask");
    return fallback;
  }
  private singleBrowserResolution(site: string | null, capability: string, familiar = false): { policy: Policy; scope: ApprovalReceipt["scope"]; restricted?: boolean } {
    const category = `ox.web.browser.${capability}`, base = site ? `ox.web.browser:${site}` : category, exact = site ? `${base}:${capability}` : category;
    const keys = [...new Set([exact, base, category])];
    if (keys.some(key => this.file.actions[key] === "block")) return { policy: "block", scope: "action", restricted: true };
    for (const key of keys) if (this.file.actions[key] !== undefined) return { policy: this.file.actions[key]!, scope: "action" };
    return this.resolution(exact, capability === "visit" && familiar && this.defaults.web === "some" ? "allow" : "ask");
  }
  browserResolution(site: string | null, capability: string, familiar = false, foreground = true): { policy: Policy; scope: ApprovalReceipt["scope"]; restricted?: boolean } {
    const publicRead = capability === "publicPages";
    const original = this.singleBrowserResolution(site, publicRead ? "read" : capability, familiar);
    if (!publicRead && capability !== "visit") return original;
    const rules = this.file.actions;
    const group = [site ? rules[`ox.web.browser:${site}:publicPages`] : undefined, rules["ox.web.browser.publicPages"]];
    const chosen = group.find(value => value !== undefined);
    const visit = publicRead ? this.singleBrowserResolution(site, "visit") : original;
    if (group.includes("block") || original.policy === "block" || visit.policy === "block") return { policy: "block", scope: "action", restricted: true };
    if (!chosen || !foreground) return original;
    const restrict = this.defaults.web === "ask" || [original, visit].some(row => row.policy === "ask" && row.scope !== "fallback");
    return { policy: restrict || group.includes("ask") ? "ask" : chosen, scope: "action", ...(restrict ? { restricted: true } : {}) };
  }
  browserFallback(site: string, capability: string): Policy {
    return this.browserResolution(site || null, capability).policy;
  }
  async current() {
    await this.load();
    return this.serial.run(async () => { await this.verifyOwnerPolicy(); return { ...this.stored(), revision: this.revision, defaults: this.defaults }; });
  }
  private metadata(file: PolicyFile) {
    return file.muse ??= { version: 1, revision: 0, defaults: initialDefaults(), requests: {} };
  }
  private async publish(next: PolicyFile, beforePublish?: () => Promise<void>) {
    if (museParityEnabled() || next.muse?.version === 1) {
      this.metadata(next).revision = this.revision + 1;
      if (!validRevision(next.muse!.revision) || Object.keys(next.sources).length + Object.keys(next.actions).length > 5000
        || Buffer.byteLength(JSON.stringify(next, null, 2)) + 1 > 2 * 1024 * 1024) throw ownerUnavailable();
    }
    const restricted = (previous: Policy | undefined, current: Policy | undefined) => previous !== current
      && (previous === "allow" || current === "block" || current === "ask" && previous === undefined);
    const revokeBrowser = museParityEnabled() && (restricted(this.file.defaultPolicy, next.defaultPolicy)
      || restricted(this.file.sources.ox, next.sources.ox) || this.defaults.web === "some" && next.muse?.defaults.web === "ask"
      || [...new Set([...Object.keys(this.file.actions), ...Object.keys(next.actions)])]
        .some(key => key.startsWith("ox.web.browser") && restricted(this.file.actions[key], next.actions[key])));
    try { await writeJSONFile(this.path, next, async () => {
      await beforePublish?.();
      if (revokeBrowser) for (const close of this.browserRevokers) await close();
    }); }
    catch { throw ownerUnavailable(); }
    this.file = next;
    for (const task of this.tasks.values()) task.grants.clear();
    if (museParityEnabled()) for (const changed of this.changes) changed();
  }
  onBrowserRevoke(close: () => Promise<void>) { this.browserRevokers.add(close); return () => { this.browserRevokers.delete(close); }; }
  onChanged(changed: () => void) { this.changes.add(changed); return () => { this.changes.delete(changed); }; }
  private mutate(change: (next: PolicyFile) => void) {
    return this.serial.run(async () => {
      await this.load();
      if (museParityEnabled() || this.file.muse?.version === 1) await this.verifyOwnerPolicy();
      const next = clone(this.file); change(next); await this.publish(next);
    });
  }
  async change(owner: string, requestId: string, expectedRevision: number, change: PermissionChange, reset: (next: PolicyFile) => void, guard: () => Promise<void>) {
    return this.serial.run(async () => {
      await this.load(); await this.verifyOwnerPolicy(); await guard();
      const fingerprint = sha256(canonicalJSON({ expectedRevision, ...change })), ownerID = sha256(owner), old = this.file.muse?.requests[requestId];
      if (old) {
        if (old.owner !== ownerID || old.fingerprint !== fingerprint) throw new HTTPError(409, "This request belongs to a different permission change. Nothing was saved.");
        return { ...this.proof(owner, requestId), replayed: true, inputApplied: false };
      }
      if (expectedRevision !== this.revision) throw new HTTPError(409, "Permissions changed in another page. Read them before saving again.");
      if (Object.keys(this.file.muse?.requests ?? {}).length >= 5000) throw new HTTPError(409, "Permission request history is full. Nothing was saved.");
      const next = clone(this.file), muse = this.metadata(next);
      if (change.operation === "default") muse.defaults[change.target] = change.value;
      else if (change.operation === "protocol") next.actions[protocolKey(change.id)] = change.enabled ? change.id === "dns" ? "allow" : "ask" : "block";
      else if (change.operation === "reset") reset(next);
      else {
        const rules = change.operation === "action" ? next.actions : next.sources;
        if (change.policy === null) delete rules[change.id]; else rules[change.id] = change.policy;
      }
      muse.requests[requestId] = { owner: ownerID, fingerprint, revision: this.revision + 1 };
      await this.publish(next, async () => { await this.verifyOwnerPolicy(); await guard(); });
      return { ...this.proof(owner, requestId), replayed: false, inputApplied: true };
    });
  }
  private proof(owner: string, requestId: string) {
    const receipt = this.file.muse?.requests[requestId];
    if (receipt && receipt.owner !== sha256(owner)) throw new HTTPError(404, "Permission request not found.");
    return { requestId, revision: this.revision, receipt: receipt ? { revision: receipt.revision } : null,
      outcome: !receipt ? "unconfirmed" : receipt.revision === this.revision ? "committed" : "superseded" };
  }
  async requestProof(owner: string, requestId: string) {
    await this.current();
    return this.serial.run(async () => { await this.verifyOwnerPolicy(); return this.proof(owner, requestId); });
  }
  async requireUnusedDirectRequest(requestId: string) {
    await this.current();
    return this.serial.run(async () => {
      await this.verifyOwnerPolicy();
      if (this.file.muse?.requests[requestId]) throw fail("conflict", "This direct request identity was already attempted. It was not replayed.", "Inspect the earlier result; use a new identity only for a new intentional operation.");
    });
  }
  async claimDirectRequest(call: FunctionCall, requestId: string, protocol: DirectProtocol) {
    return this.serial.run(async () => {
      await this.verifyOwnerPolicy();
      const task = this.tasks.get(call.conversationId), lease = this.leases.get(call);
      if (!task || !this.validTask(call, task) || !lease || lease.revision !== this.revision || call.signal.aborted
        || !protocolEnabled(this.file.actions, protocol)) throw permissionDenied();
      const next = clone(this.file), muse = this.metadata(next);
      if (muse.requests[requestId]) throw fail("conflict", "This direct request identity was already attempted. It was not replayed.");
      if (Object.keys(muse.requests).length >= 5000) throw fail("limit_exceeded", "Permission request history is full. No direct request was dispatched.");
      muse.requests[requestId] = { owner: sha256(`direct:${task.id}`), fingerprint: sha256("direct-attempt"), revision: this.revision };
      if (Buffer.byteLength(JSON.stringify(next, null, 2)) + 1 > 2 * 1024 * 1024) throw fail("limit_exceeded", "Permission request storage is full. No direct request was dispatched.");
      await writeJSONFile(this.path, next, async () => {
        await this.verifyOwnerPolicy();
        if (lease.revision !== this.revision || call.signal.aborted || !this.validTask(call, task)) throw permissionDenied();
      }).catch(error => { if (error instanceof OxError || error instanceof HTTPError) throw error; throw ownerUnavailable(); });
      this.file = next;
    });
  }
  async withTask<T>(conversation: number, id: string, schedule: { id: string; active(): boolean; goal?: string } | undefined, work: () => Promise<T>, publicLookup?: PublicLookup) {
    if (!museParityEnabled()) return work();
    if (this.tasks.has(conversation) || this.tasks.size >= 128) throw fail("conflict", "This task's original permission identity is unavailable.");
    const task: TaskScope = { id, expires: Date.now() + 15 * 60_000, ...(schedule ? { schedule: schedule.id, active: schedule.active, ...(schedule.goal ? { goal: schedule.goal } : {}) } : { publicLookup }),
      grants: new Set(schedule?.goal ? ["ox.goal.update"] : []), denials: new Set() };
    this.tasks.set(conversation, task);
    try { return await work(); }
    finally { if (this.tasks.get(conversation) === task) this.tasks.delete(conversation); task.grants.clear(); task.denials.clear(); }
  }
  scheduled(call: FunctionCall) { return this.tasks.get(call.conversationId)?.schedule; }
  publicLookup(id: number) { return this.tasks.get(id)?.publicLookup; }
  submission(call: FunctionCall) { return this.tasks.get(call.conversationId)?.id; }
  private validTask(call: FunctionCall, task: TaskScope | undefined) {
    return !task || this.tasks.get(call.conversationId) === task && task.expires > Date.now() && (!task.active || task.active());
  }
  async guard(call: FunctionCall) {
    if (!museParityEnabled()) return;
    return this.serial.run(async () => {
      await this.verifyOwnerPolicy();
      const lease = this.leases.get(call);
      if (call.signal.aborted || this.declinedSearches.has(call) || lease && (lease.revision !== this.revision || !this.validTask(call, lease.task))) throw permissionDenied();
    });
  }
  async backgroundDecision(context: VMContext, action: string, requestId: string, explicit = false) {
    await this.current();
    return this.serial.run(async () => {
      await this.verifyOwnerPolicy();
      const revision = this.revision, original = this.resolution(action, "ask");
      const resolved = { ...original, policy: explicit && original.policy === "allow" && this.file.actions[action] !== "allow" ? "ask" : original.policy };
      await context.profile().approvalHistory.record({ action: "ox.schedule.run", label: "Run scheduled task", source: null,
        decision: resolved.policy === "allow" ? "allowedByPolicy" : resolved.policy === "block" ? "blockedByPolicy" : "denied",
        scope: resolved.scope, conversationId: null, origin: "page" }, `schedule:${requestId}:${action}:${revision}`);
      await this.verifyOwnerPolicy();
      if (resolved.policy !== "allow" || revision !== this.revision) throw permissionDenied();
      return revision;
    });
  }
  ownerDecision(context: VMContext, action: string, fallback: Policy, requestId: string, confirmed: boolean, sourceURL: string | null) {
    return this.serial.run(async () => {
      await this.verifyOwnerPolicy();
      const { policy, scope } = this.resolution(action, fallback);
      const decision = policy === "block" ? "blockedByPolicy" : policy === "allow" ? "allowedByPolicy" : confirmed ? "approved" : "denied";
      const safeAction = action.startsWith("ox.") ? action : "serviceAction";
      let source: string | null = null;
      try { source = sourceURL ? new URL(sourceURL).origin : null; } catch {}
      await context.profile().approvalHistory.record({ action: safeAction, label: action === "ox.space.data.write" ? "Write Space data"
        : action === "ox.service.checkAccess" ? "Verify connector" : action === "ox.service.detach" ? "Disconnect connector" : "Set up connector",
        source, decision, scope, conversationId: null, origin: "page" }, `${requestId}:${action}:${source ?? ""}:${decision}:${scope}`);
      if (policy === "block") throw new HTTPError(403, action === "ox.space.data.write" ? "The original action policy blocks Space data writes." : "The original action policy blocks this connector operation.");
      if (policy === "ask" && !confirmed) throw new HTTPError(400, "Confirm this connector operation before continuing.");
    });
  }

  entries() {
    return Object.entries(this.file.actions).filter(([, policy]) => policy === "allow").map(([action, policy]) => describeAction(action, policy))
      .sort((a, b) => a.kind.localeCompare(b.kind) || (a.target ?? "").localeCompare(b.target ?? "") || a.label.localeCompare(b.label));
  }

  stored() { return { defaultPolicy: this.file.defaultPolicy ?? null, sources: { ...this.file.sources }, actions: { ...this.file.actions } }; }

  setDefault(policy: Policy | undefined) {
    return this.mutate(next => { if (policy) next.defaultPolicy = policy; else delete next.defaultPolicy; });
  }

  setSource(source: string, policy: Policy | undefined) {
    return this.mutate(next => { if (policy) next.sources[source] = policy; else delete next.sources[source]; });
  }

  forgetAll() {
    return this.mutate(next => { next.actions = Object.fromEntries(Object.entries(next.actions).filter(([, policy]) => policy !== "allow")); });
  }

  policy(action: string, fallback: Policy): Policy {
    return this.resolution(action, fallback).policy;
  }
  resolution(action: string, fallback: Policy): { policy: Policy; scope: ApprovalReceipt["scope"] } {
    if (this.file.actions[action] !== undefined) return { policy: this.file.actions[action]!, scope: "action" };
    const source = this.file.sources[sourceID(action)];
    if (source !== undefined) return { policy: source, scope: "source" };
    return this.file.defaultPolicy === undefined ? { policy: this.fallback(action, fallback), scope: "fallback" } : { policy: this.file.defaultPolicy, scope: "default" };
  }

  set(action: string, policy: Policy | undefined) {
    return this.mutate(next => { if (policy) next.actions[action] = policy; else delete next.actions[action]; });
  }

  belongs(action: string, domain: string, namespace: string) {
    return action === `ox.service.attach:${domain}` || action.startsWith(`${namespace}:`) || action.startsWith(`${domain}:`);
  }

  explicit(domain: string, namespace: string, policy: Policy) {
    return Object.entries(this.file.actions).filter(([action, value]) => value === policy && this.belongs(action, domain, namespace)).map(([action]) => action).sort();
  }

  clear(domain: string, namespace: string) {
    return this.mutate(next => { next.actions = Object.fromEntries(Object.entries(next.actions).filter(([action, policy]) => policy !== "allow" || !this.belongs(action, domain, namespace))); });
  }

  private async requireMuse(call: FunctionCall, requestedAction: string, fallback: Policy, options: RequireOptions) {
    let action = requestedAction;
    const parameters = Object.fromEntries(Object.entries(call.args).filter(([key]) => key !== "purpose"));
    const browser = options.browser ? { site: options.browser.site, capability: options.browser.capability } : null;
    const snapshot = await this.serial.run(async () => {
      await this.load(); await this.verifyOwnerPolicy();
      if ((await call.profile.approvalHistory.list()).length >= 5000) throw fail("limit_exceeded", "Approval history is full. No unrecorded permission was granted.");
      const task = this.tasks.get(call.conversationId);
      const previous = this.leases.get(call);
      if (call.signal.aborted || !this.validTask(call, task) || previous && previous.revision !== this.revision) throw permissionDenied();
      const original = options.originalAction ? this.resolution(options.originalAction, fallback) : undefined;
      const selected = options.originalAction && original && (original.policy === "block"
        || !options.standing && (original.policy !== "ask" || task?.grants.has(options.originalAction))) ? options.originalAction : requestedAction;
      const resolved = options.browser ? this.browserResolution(options.browser.site, options.browser.capability, options.browser.familiar, !!task && !task.schedule && !call.page) : this.resolution(selected, fallback);
      const lookup = !call.page && task?.publicLookup;
      const site = options.browser?.site;
      const publicRead = options.browser?.capability === "publicPages" && (call.name === "ox.web.search"
        || call.name === "ox.web.fetch" && !!options.sourceURL && !!lookup && lookup.urls.has(options.sourceURL));
      const strictVisit = publicRead && this.singleBrowserResolution(site ?? null, "visit");
      const implicitLookup = lookup && this.defaults.web === "some" && resolved.scope === "fallback"
        && (options.anonymousSearch && this.defaults.connectors === "some" || publicRead && !(strictVisit && strictVisit.scope !== "fallback" && strictVisit.policy !== "allow"));
      return { action: selected, revision: this.revision, task, ...resolved,
        implicitLookup: !!implicitLookup,
        policy: resolved.policy === "allow" && (options.connection || options.standing && this.file.actions[selected] !== "allow") ? "ask" as const : resolved.policy };
    });
    action = snapshot.action;
    const denialKey = sha256(options.standing ? `goal-follow:${options.standing}` : action === "ox.plan.capture" ? action
      : canonicalJSON({ name: call.name, action, args: parameters, browser, connection: options.connection ?? false }));
    const researchRead = snapshot.task?.goal && (call.name === "ox.web.fetch" && ["read", "background"].includes(options.browser?.capability ?? "")
      || call.name === "ox.web.search" && (action === "ox.web.search" || action.startsWith("ox.connector.background:")
        || /^web:[a-z0-9.-]+:search$/.test(action) || ["read", "background"].includes(options.browser?.capability ?? "")));
    const taskGrant = !options.connection && !options.standing && snapshot.policy === "ask" && (snapshot.task?.grants.has(action) || researchRead || snapshot.implicitLookup);
    const scope = taskGrant ? "task" : snapshot.scope;
    const record = (decision: ApprovalReceipt["decision"], selected = scope) => recordApproval(call, action, decision, selected, options.sourceURL);
    const check = () => this.serial.run(async () => {
      await this.verifyOwnerPolicy();
      if (snapshot.revision !== this.revision || call.signal.aborted || !this.validTask(call, snapshot.task)) throw permissionDenied();
    });
    if (snapshot.task?.denials.has(denialKey)) {
      await record("denied", "task");
      throw fail("permission_denied", "This operation was already denied in the current task. It was not repeated or requested again.",
        "Stop. A fresh explicit user request is required before asking to perform the same operation.");
    }
    if (snapshot.policy === "block") {
      await record("blockedByPolicy");
      throw fail("permission_denied", "The user blocked this action in Settings. Earlier effects are not undone.", "Stop. Do not bypass the policy.");
    }
    if (snapshot.policy === "allow" || taskGrant) {
      await record("allowedByPolicy"); await check();
      this.leases.set(call, { revision: this.revision, task: snapshot.task }); return;
    }
    const detail = options.detail ?? (options.args === undefined ? undefined : JSON.stringify(options.args, null, 2).slice(0, 4000));
    const body = options.body ?? call.step.purpose ?? "";
    const answer = await approvalAnswer(call, action, snapshot.scope,
      { kind: "approval", title: options.title ?? actionLabel(action) ?? action, body, ...(detail ? { detail } : {}),
        ...(options.browser?.site ? { persistentScope: "site" } : {}),
        ...(options.connection || options.standing ? { options: ["Approve", "Deny"] } : !call.page && snapshot.task ? { options: ["Approve", "Approve for this task", "Always approve", "Deny"] } : {}) }, options.sourceURL);
    try {
      await check();
      if (answer.kind !== "answer") { await record("cancelled"); throw fail("cancelled", "The permission request was cancelled."); }
      if (!(options.connection || options.standing ? ["Approve"] : ["Approve", "Approve for this task", "Always approve"]).includes(answer.text)) {
        if (call.name === "ox.web.search" && snapshot.task && !snapshot.task.schedule && !call.page) this.declinedSearches.add(call);
        await record("denied", "once");
        await this.serial.run(async () => {
          if (!snapshot.task) return;
          if (snapshot.task.denials.size >= 256) throw fail("limit_exceeded", "This task's denied-operation history is full. No further operation is authorized.");
          snapshot.task.denials.add(denialKey);
        });
        throw permissionDenied();
      }
      const selected = options.standing ? "action" : answer.text === "Approve for this task" ? "task" : answer.text === "Always approve" ? "action" : "once";
      await record(answer.text === "Always approve" ? "alwaysApproved" : "approved", selected);
      await this.serial.run(async () => {
        await this.verifyOwnerPolicy();
        if (snapshot.revision !== this.revision || call.signal.aborted || !this.validTask(call, snapshot.task)) throw permissionDenied();
        if (answer.text === "Always approve" || options.standing) {
          const next = clone(this.file); next.actions[action] = "allow"; await this.publish(next);
        } else if (answer.text === "Approve for this task") {
          if (!snapshot.task || snapshot.task.grants.size >= 256) throw permissionDenied();
          snapshot.task.grants.add(action);
        }
        this.leases.set(call, { revision: this.revision, task: snapshot.task });
      });
    } catch (error) {
      if (answer.kind === "answer" && ["Approve", "Approve for this task", "Always approve"].includes(answer.text)) await call.update({ answer: "Approval not applied" });
      throw error;
    }
  }
  async require(call: FunctionCall, action: string, fallback: Policy, options: RequireOptions = {}) {
    if (museParityEnabled()) return this.permissionTurn(call, async () => {
      if (call.signal.aborted || this.declinedSearches.has(call)) {
        await recordApproval(call, action, "cancelled", "once", options.sourceURL);
        throw fail("cancelled", "The operation was cancelled before its approval turn.", "Stop. Do not retry unless the user asks.");
      }
      return this.requireMuse(call, action, fallback, options);
    });
    const { policy, scope } = this.resolution(action, fallback);
    const record = (decision: ApprovalReceipt["decision"]) => recordApproval(call, action, decision, scope, options.sourceURL);
    if (policy === "allow") { await record("allowedByPolicy"); return; }
    if (policy === "block") {
      await record("blockedByPolicy");
      throw fail("permission_denied", `${action}: the user blocked this Action in Settings.`, "Do not bypass the policy. Ask the user to change it in Settings only if they want to allow this action.");
    }
    const args = options.args === undefined || options.args === null || (typeof options.args === "object" && !Array.isArray(options.args) && !Object.keys(options.args).length)
      ? undefined : JSON.stringify(options.args, null, 2).slice(0, 4_000);
    const answer = await approvalAnswer(call, action, scope, { kind: "approval", title: options.title ?? actionLabel(action) ?? action,
      body: options.body ?? call.step.purpose ?? "", ...(args ? { detail: args } : {}) }, options.sourceURL);
    if (answer.kind === "answer" && answer.text === "Always approve") { await this.set(action, "allow"); await record("alwaysApproved"); return; }
    if (answer.kind === "answer" && answer.text === "Approve") { await record("approved"); return; }
    if (answer.kind === "cancelled") {
      await record("cancelled");
      throw fail("cancelled", `${action}: the user stopped before answering.`, "Stop. Do not reopen the request unless the user asks.");
    }
    await record("denied");
    throw fail("permission_denied", `${action}: the user declined.`, "Stop. Do not repeat the action unless the user asks.");
  }
}

export const approvalsModule: VMFactory = async context => {
  const approvals = Approvals.for(context.paths.state);
  await approvals.load();
  let release: (() => void) | undefined;
  return {
    start: async () => { release ??= approvals.onChanged(() => context.emit({ type: "services" })); },
    beforeFunction: async call => {
      const lookup = !call.page && approvals.publicLookup(call.conversationId);
      if (!lookup) return;
      if (call.name === "ox.web.search" && lookup.kind === "search" && call.args.sessions === undefined && call.args.cursors === undefined
        && (call.args.domains === undefined || Array.isArray(call.args.domains) && call.args.domains.every(d => typeof d === "string" && publicLookupEngines.has(d)))) {
        call.args.query = lookup.subject;
        call.args.domains ??= [...publicLookupEngines];
        return;
      }
      if (call.name === "ox.web.fetch" && typeof call.args.url === "string" && URL.canParse(call.args.url) && lookup.urls.has(new URL(call.args.url).href)) {
        if (lookup.kind === "finance") call.args.options = { maxBytes: 6144, maxPages: 2 };
        return;
      }
      throw fail("permission_denied", "This public lookup only permits anonymous search and reading its original sources.", "Clarify the request before using private context or performing another action.");
    },
    close: async () => { release?.(); release = undefined; },
    routes: {
      approvals: async (request, _url, parts) => {
        if (parts.length === 1 && parts[0] === "history" && request.method === "GET") {
          if (!museParityEnabled()) return json({ available: false });
          if ([..._url.searchParams.keys()].some(key => !["q", "sort", "limit", "cursor"].includes(key))) throw new HTTPError(400, "Unknown approval-history query field.");
          let records: ApprovalReceipt[];
          try { records = await context.profile().approvalHistory.list(); }
          catch (error) { throw error instanceof OxError ? new HTTPError(503, error.message) : error; }
          const result = metadataPage(records.map(row => ({ ...row, name: row.label, modified: Date.parse(row.recordedAt) })),
            Object.fromEntries(_url.searchParams), "approvalHistory");
          return json({ available: true, records: result.items.map(({ name: _name, modified: _modified, ...row }) => row), total: result.total, nextCursor: result.nextCursor });
        }
        if (!parts.length && request.method === "GET") return json({ approvals: approvals.entries() });
        if (!parts.length && request.method === "DELETE") { await approvals.forgetAll(); context.emit({ type: "services" }); return json({ cleared: true }); }
        if (parts.length === 1 && request.method === "DELETE") {
          if (!approvals.entries().some(entry => entry.action === parts[0])) throw new HTTPError(404, "Approval not found");
          await approvals.set(parts[0]!, undefined);
          context.emit({ type: "services" });
          return json({ deleted: true });
        }
        throw new HTTPError(404, "Not found");
      },
    },
  };
};

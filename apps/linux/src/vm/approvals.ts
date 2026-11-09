import { join } from "node:path";
import type { FunctionCall } from "@openox/agent/linux";
import { fail, readJSONFile, Serial, writeJSONFile } from "./services/support";
import { HTTPError, json } from "../http";
import type { VMFactory } from "./context";

export type Policy = "ask" | "allow" | "block";
interface PolicyFile { format: 2; defaultPolicy?: Policy; sources: Record<string, Policy>; actions: Record<string, Policy> }

const builtIn = new Set([
  "ox.secret.list", "ox.secret.add", "ox.secret.delete", "ox.web.search",
  "ox.service.list", "ox.service.listAttached", "ox.service.inspect", "ox.service.checkAccess", "ox.service.validate", "ox.service.create",
  "ox.service.update", "ox.service.delete", "ox.repository.connect", "ox.repository.sync", "ox.repository.enable", "ox.repository.disconnect",
  "ox.repository.conflicts", "ox.repository.resolve", "ox.service.attach", "ox.service.showPage", "ox.service.signIn", "ox.service.detach", "ox.app.repositories",
]);
const labels: Record<string, string> = {
  "ox.secret.list": "List secrets", "ox.secret.add": "Add a secret", "ox.secret.delete": "Delete a secret", "ox.web.search": "Search the web",
  "ox.service.list": "Services", "ox.service.listAttached": "List attached services", "ox.service.inspect": "Inspect a service",
  "ox.service.checkAccess": "Inspect a service", "ox.service.validate": "Validate a service", "ox.service.create": "Create a service",
  "ox.service.update": "Update a service", "ox.service.delete": "Delete a service", "ox.repository.connect": "Add Repository",
  "ox.repository.conflicts": "Conflicts", "ox.repository.resolve": "Choose", "ox.repository.sync": "Sync", "ox.repository.enable": "Repositories",
  "ox.repository.disconnect": "Remove Repository", "ox.service.attach": "Attach a service", "ox.service.showPage": "Show page",
  "ox.service.signIn": "Service login", "ox.service.detach": "Detach a service", "ox.app.repositories": "Repositories",
};

export const defaultPolicy = (action: string): Policy => {
  if (action.startsWith("ox.service.attach:")) return "allow";
  if (!builtIn.has(action)) return "ask";
  return action.endsWith(".delete") ? "ask" : "allow";
};
export const actionLabel = (action: string) => labels[action];
export const policies: readonly Policy[] = ["ask", "allow", "block"];

export function sourceID(action: string) {
  if (action.startsWith("ox.service.attach:")) return action.slice("ox.service.attach:".length);
  if (action.startsWith("ox.")) return "ox";
  const separator = action.lastIndexOf(":");
  if (separator < 0) return "ox";
  const namespace = action.slice(0, separator);
  for (const prefix of ["web:", "api:", "mcp:"]) if (namespace.startsWith(prefix)) return namespace.slice(prefix.length);
  return namespace;
}

const functionLabels: Record<string, string> = {
  "ox.schedule.create": "Create a schedule", "ox.schedule.delete": "Delete a schedule", "ox.schedule.enable": "Change a schedule", "ox.schedule.run": "Run a schedule",
  "ox.conversation.delete": "Delete Conversation", "ox.skill.delete": "Delete a skill", "ox.provider.generate": "Run a model", "ox.provider.delete": "Delete a model provider",
};
const stores = new Map<string, Approvals>();

export function builtInActions() {
  const asked = Object.entries(functionLabels).map(([id, label]) => ({ id, label, default: "ask" as Policy }));
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

export class Approvals {
  private path: string;
  private file: PolicyFile = { format: 2, sources: {}, actions: {} };
  private serial = new Serial();
  private loading?: Promise<void>;

  private constructor(state: string) { this.path = join(state, "action-policies.json"); }

  static for(state: string) {
    let store = stores.get(state);
    if (!store) { store = new Approvals(state); stores.set(state, store); }
    return store;
  }

  load() {
    this.loading ??= (async () => {
      const stored = await readJSONFile<Partial<PolicyFile>>(this.path, {});
      this.file = { format: 2, sources: stored.sources ?? {}, actions: stored.actions ?? {}, ...(stored.defaultPolicy ? { defaultPolicy: stored.defaultPolicy } : {}) };
    })().catch(error => { this.loading = undefined; throw error; });
    return this.loading;
  }

  entries() {
    return Object.entries(this.file.actions).filter(([, policy]) => policy === "allow").map(([action, policy]) => describeAction(action, policy))
      .sort((a, b) => a.kind.localeCompare(b.kind) || (a.target ?? "").localeCompare(b.target ?? "") || a.label.localeCompare(b.label));
  }

  stored() { return { defaultPolicy: this.file.defaultPolicy ?? null, sources: { ...this.file.sources }, actions: { ...this.file.actions } }; }

  setDefault(policy: Policy | undefined) {
    return this.serial.run(async () => {
      const next: PolicyFile = { format: 2, sources: this.file.sources, actions: this.file.actions, ...(policy ? { defaultPolicy: policy } : {}) };
      await writeJSONFile(this.path, next);
      this.file = next;
    });
  }

  setSource(source: string, policy: Policy | undefined) {
    return this.serial.run(async () => {
      const next = { ...this.file, sources: { ...this.file.sources } };
      if (policy) next.sources[source] = policy; else delete next.sources[source];
      await writeJSONFile(this.path, next);
      this.file = next;
    });
  }

  forgetAll() {
    return this.serial.run(async () => {
      const next = { ...this.file, actions: Object.fromEntries(Object.entries(this.file.actions).filter(([, policy]) => policy !== "allow")) };
      await writeJSONFile(this.path, next);
      this.file = next;
    });
  }

  policy(action: string, fallback: Policy): Policy {
    return this.file.actions[action] ?? this.file.sources[sourceID(action)] ?? this.file.defaultPolicy ?? fallback;
  }

  set(action: string, policy: Policy | undefined) {
    return this.serial.run(async () => {
      const next = { ...this.file, actions: { ...this.file.actions } };
      if (policy) next.actions[action] = policy; else delete next.actions[action];
      await writeJSONFile(this.path, next);
      this.file = next;
    });
  }

  belongs(action: string, domain: string, namespace: string) {
    return action === `ox.service.attach:${domain}` || action.startsWith(`${namespace}:`) || action.startsWith(`${domain}:`);
  }

  explicit(domain: string, namespace: string, policy: Policy) {
    return Object.entries(this.file.actions).filter(([action, value]) => value === policy && this.belongs(action, domain, namespace)).map(([action]) => action).sort();
  }

  clear(domain: string, namespace: string) {
    return this.serial.run(async () => {
      const actions = Object.fromEntries(Object.entries(this.file.actions).filter(([action, policy]) => policy !== "allow" || !this.belongs(action, domain, namespace)));
      const next = { ...this.file, actions };
      await writeJSONFile(this.path, next);
      this.file = next;
    });
  }

  async require(call: FunctionCall, action: string, fallback: Policy, options: { title?: string; body?: string; args?: unknown } = {}) {
    const policy = this.policy(action, fallback);
    if (policy === "allow") return;
    if (policy === "block") throw fail("permission_denied", `${action}: the user blocked this Action in Settings.`, "Do not bypass the policy. Ask the user to change it in Settings only if they want to allow this action.");
    const args = options.args === undefined || options.args === null || (typeof options.args === "object" && !Array.isArray(options.args) && !Object.keys(options.args).length)
      ? undefined : JSON.stringify(options.args, null, 2).slice(0, 4_000);
    const answer = await call.untimed(() => call.ask({ kind: "approval", title: options.title ?? actionLabel(action) ?? action,
      body: options.body ?? call.step.purpose ?? "", ...(args ? { detail: args } : {}) }));
    if (answer.kind === "answer" && answer.text === "Always approve") { await this.set(action, "allow"); return; }
    if (answer.kind === "answer" && answer.text === "Approve") return;
    if (answer.kind === "cancelled") throw fail("cancelled", `${action}: the user stopped before answering.`, "Stop. Do not reopen the request unless the user asks.");
    throw fail("permission_denied", `${action}: the user declined.`, "Stop. Do not repeat the action unless the user asks.");
  }
}

export const approvalsModule: VMFactory = async context => {
  const approvals = Approvals.for(context.paths.state);
  await approvals.load();
  return {
    routes: {
      approvals: async (request, _url, parts) => {
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

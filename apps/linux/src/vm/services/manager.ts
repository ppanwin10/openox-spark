import type { AttachedService, FunctionCall } from "@openox/agent/linux";
import { OxError } from "@openox/agent/linux";
import type { VMContext } from "../context";
import { APIRuntime } from "./api";
import { Catalog, findAction, isHostStandard, qualifiedName, searchInputSchema, searchMaximum, sessionsEnabled, standardActions, type Candidate, type Definition, type Snapshot } from "./catalog";
import { WebConversations } from "./conversation";
import { invokeError, iosUnavailable, notAttached } from "./errors";
import { MCPRuntime } from "./mcp";
import { Approvals } from "./policy";
import { violations } from "./schema";
import { Secrets } from "./secrets";
import { Attachments, Preferences, type AttachmentRecord } from "./state";
import { fail, isObject, type JSONObject, type Kind } from "./support";
import { executionURL, normalizedURL, WebRuntime, type Approve, type StagedFile } from "./web";

export type LoginState = "notRequired" | "signedIn" | "signedOut" | "authorized" | "notAuthorized" | "unknown";
const kinds = new Set(["web", "api", "ios", "mcp"]);

export class Services {
  readonly context: VMContext;
  readonly preferences: Preferences;
  readonly attachments: Attachments;
  readonly approvals: Approvals;
  readonly secrets: Secrets;
  readonly catalog: Catalog;
  readonly web: WebRuntime;
  readonly conversations: WebConversations;
  readonly api: APIRuntime;
  readonly mcp: MCPRuntime;
  private runtimes = new Map<string, Snapshot>();
  private loading = new Map<string, Promise<Snapshot>>();

  constructor(context: VMContext) {
    this.context = context;
    this.preferences = new Preferences(context.paths.state);
    this.attachments = new Attachments(context.paths.state);
    this.approvals = Approvals.for(context.paths.state);
    this.secrets = new Secrets(context.paths.state);
    this.catalog = new Catalog(context.paths, () => this.preferences.bundledEnabled);
    this.web = new WebRuntime(context);
    this.conversations = new WebConversations(this.web);
    this.api = new APIRuntime(context, this.secrets);
    this.mcp = new MCPRuntime(context);
  }

  async start() {
    await Promise.all([this.preferences.load(), this.attachments.load(), this.approvals.load(), this.secrets.load()]);
  }

  async close() { await this.mcp.close(); }

  changed() { this.context.emit({ type: "services" }); }
  title(definition: Definition) { return this.preferences.name(definition.domain) ?? definition.name; }

  async retire(snapshot: Snapshot) {
    if (snapshot.kind === "web") {
      await this.conversations.closeWhere(conversation => conversation.domain === snapshot.domain);
      await this.web.closeDomain(snapshot.domain);
    }
    if (snapshot.kind === "mcp") await this.mcp.deactivate(snapshot.domain);
  }

  async forget(domain: string) {
    const snapshot = this.runtimes.get(domain);
    this.runtimes.delete(domain);
    if (snapshot) await this.retire(snapshot);
  }

  async load(candidate: Candidate): Promise<Snapshot> {
    if (candidate.kind === "ios") throw iosUnavailable(candidate.runtime);
    const key = `${candidate.repository.id}:${candidate.qualified}`;
    const pending = this.loading.get(key);
    if (pending) return pending;
    const work = (async () => {
      const version = await this.catalog.version(candidate);
      const existing = this.runtimes.get(candidate.runtime);
      if (existing && existing.version === version) return existing;
      const definition = candidate.repository.provenance === "local" ? await this.catalog.validate(candidate) : await this.catalog.definition(candidate);
      const source = candidate.kind === "web" || candidate.kind === "api" ? await this.catalog.source(candidate) : "";
      const snapshot: Snapshot = { domain: candidate.runtime, kind: candidate.kind, version, definition, source };
      if (existing) await this.retire(existing);
      this.runtimes.set(candidate.runtime, snapshot);
      this.context.logs.info("services", `service loaded domain=${candidate.runtime} repository=${candidate.repository.id} version=${version.slice(-12)}`);
      return snapshot;
    })();
    this.loading.set(key, work);
    try { return await work; } finally { this.loading.delete(key); }
  }

  async selected(domain: string) {
    const state = await this.catalog.load();
    const candidate = state.selected.get(domain);
    if (candidate) return { state, candidate };
    if (state.conflicts.some(conflict => conflict.service === domain)) {
      throw fail("source_conflict", `${domain} has several sources and none is selected.`, "Compare them with ox.repository.conflicts, then choose one with ox.repository.resolve.");
    }
    throw fail("not_found", `No service with domain '${domain}'.`, "List services with ox.service.list. Create missing web or API sources under repositories/local/ and register them in repositories/local/repository.json.");
  }

  async snapshot(domain: string) { return this.load((await this.selected(domain)).candidate); }

  async definitionFor(domain: string) {
    const loaded = this.runtimes.get(domain);
    if (loaded) return loaded.definition;
    const candidate = (await this.catalog.load()).selected.get(domain);
    return candidate ? this.catalog.definition(candidate).catch(() => undefined) : undefined;
  }

  login(definition: Definition): LoginState {
    if (definition.kind === "api") return this.api.loginState(definition) as LoginState;
    if (definition.kind === "mcp") return this.mcp.login(definition) as LoginState;
    if (definition.kind === "ios") return typeof definition.manifest.permission === "string" ? "unknown" : "notRequired";
    return "unknown";
  }

  fields(definition: Definition, attached: boolean): JSONObject {
    const fields: JSONObject = { domain: definition.domain, name: this.title(definition), ...(definition.description ? { description: definition.description } : {}),
      login: this.login(definition), saved: this.preferences.saved(definition.domain), attached, kind: definition.kind };
    if (definition.kind === "mcp") { fields.endpoint = definition.endpoint; fields.transport = definition.transport ?? "auto"; }
    fields.repository = definition.candidate.repository.id;
    fields.repositoryProvenance = definition.candidate.repository.provenance;
    return fields;
  }

  serviceSnapshot(definition: Definition, attached: boolean) {
    const fields = this.fields(definition, attached);
    if (definition.kind === "mcp") fields.faviconUrl = definition.faviconUrl;
    return fields;
  }

  recordFields(record: AttachmentRecord, definition: Definition | undefined, attached: boolean): JSONObject {
    if (definition && definition.kind === record.kind) return this.fields(definition, attached);
    return { domain: record.domain, name: this.preferences.name(record.domain) ?? record.domain, login: "unknown", saved: this.preferences.saved(record.domain), attached, kind: record.kind,
      repository: record.repository };
  }

  async attachedServices(conversation: number): Promise<AttachedService[]> {
    const services: AttachedService[] = [];
    for (const record of this.attachments.list(conversation)) {
      const definition = await this.definitionFor(record.domain);
      services.push({ domain: record.domain, ...(definition?.description ? { description: definition.description } : {}), login: definition ? this.login(definition) : "unknown" });
    }
    return services;
  }

  async attachedSnapshot(record: AttachmentRecord) {
    const candidate = (await this.catalog.load()).selected.get(record.domain);
    if (!candidate || candidate.kind !== record.kind) {
      throw fail("service_changed", `Service ${record.domain} changed or disconnected before execution.`, "Find the service with ox.service.list and attach it again before using its actions.");
    }
    const current = this.runtimes.get(record.domain);
    if (current && current.kind === candidate.kind && current.definition.candidate.repository.id === candidate.repository.id) return current;
    return this.load(candidate);
  }

  async attached(call: FunctionCall, domain: string) {
    if (domain.startsWith("ios:")) throw iosUnavailable(domain);
    if (call.page) return this.load((await this.selected(domain)).candidate);
    const record = this.attachments.find(call.conversationId, domain);
    if (!record) throw fail("service_not_attached", `Service '${domain}' isn't attached to this conversation.`, "Attach it with ox.service.attach first.");
    return this.attachedSnapshot(record);
  }

  async target(call: FunctionCall, name: string, label: string) {
    const first = name.indexOf(":"), second = first < 0 ? -1 : name.indexOf(":", first + 1);
    if (call.page) {
      const kind = name.slice(0, first), identity = name.slice(first + 1, second), actionId = name.slice(second + 1);
      if (second < 0 || !kinds.has(kind) || !identity || !actionId) {
        throw fail("invalid_argument", `${label}: use a qualified action: web:<domain>:<action>, api:<service>:<action> or mcp:<server>:<action>.`, "Pages call actions by their qualified name.");
      }
      if (kind === "ios") throw iosUnavailable(`ios:${identity}`);
      const snapshot = await this.load((await this.selected(identity)).candidate);
      if (snapshot.kind !== kind) throw invokeError.unknown(name);
      return { snapshot, actionId };
    }
    if (second > 0 && kinds.has(name.slice(0, first))) {
      const kind = name.slice(0, first) as Kind, identity = name.slice(first + 1, second);
      if (kind === "ios") throw iosUnavailable(`ios:${identity}`);
      const record = this.attachments.find(call.conversationId, identity);
      if (!record || record.kind !== kind) throw notAttached(label, `${kind}:${identity}`);
      return { snapshot: await this.attachedSnapshot(record), actionId: name.slice(second + 1) };
    }
    const records = this.attachments.list(call.conversationId);
    if (records.length === 1) return { snapshot: await this.attachedSnapshot(records[0]!), actionId: name };
    throw fail("invalid_argument", `${label}: use 'web:<domain>:${name}', 'api:<service>:${name}', or 'mcp:<server>:${name}' — the conversation has ${records.length} services attached.`,
      "Use the backend-qualified action name.");
  }

  approver(call: FunctionCall, definition: Definition, outer: string): Approve {
    return async (name, input) => {
      if (definition.kind !== "web" || name !== qualifiedName(definition, "listSessions") || name === outer) return true;
      try {
        await this.approvals.require(call, name, "allow", { title: `${this.title(definition)} - ${findAction(definition, "listSessions", true)?.label ?? "listSessions"}`, args: input });
        return true;
      } catch { return false; }
    };
  }

  private async stagedFiles(call: FunctionCall, references: unknown): Promise<StagedFile[]> {
    const list = Array.isArray(references) ? references : [];
    const files: StagedFile[] = [];
    let total = 0;
    for (const [index, reference] of list.entries()) {
      if (!isObject(reference) || reference.id !== index || typeof reference.name !== "string" || typeof reference.mimeType !== "string") {
        throw fail("invalid_argument", "Invalid website attachment reference", "Pass the attachments array unchanged.");
      }
      const opened = await call.profile.openFile(`conversations/${call.conversationId}/${reference.name}`).catch(() => undefined);
      const type = opened?.file.type.split(";")[0];
      if (!opened || type !== reference.mimeType || opened.entry.size > 32 * 1024 * 1024) {
        throw fail("invalid_argument", "Website attachment is unavailable, too large, or has a different MIME type", "Attach the file to this conversation first.");
      }
      const data = new Uint8Array(await opened.file.arrayBuffer());
      total += data.length;
      if (!data.length || total > 32 * 1024 * 1024) throw fail("invalid_argument", "Website attachments exceed the upload limit", "Send fewer or smaller files.");
      files.push({ name: reference.name, mimeType: reference.mimeType, data });
    }
    return files;
  }

  private async standard(call: FunctionCall, snapshot: Snapshot, actionId: string) {
    const definition = snapshot.definition;
    if (["credentialStatus", "connectionStatus", "permissionStatus"].includes(actionId)) {
      if (this.approvals.policy("ox.service.checkAccess", "allow") !== "allow") {
        throw fail("permission_denied", "Status inspection is blocked by the existing access-check policy.", "Stop. Do not bypass the policy through another action.");
      }
      if (definition.kind === "api") return { state: this.api.credentialStatus(definition) };
      if (definition.kind === "mcp") return { state: await this.mcp.check(definition) };
      throw iosUnavailable(definition.domain);
    }
    await this.approvals.require(call, "ox.service.signIn", "allow", { args: { domain: definition.domain } });
    if (definition.kind === "api") {
      const result = await this.api.configure(call, definition);
      this.changed();
      return result;
    }
    if (definition.kind === "mcp") {
      if (await this.mcp.check(definition) === "notRequired") return { completed: true, completion: "notRequired", state: "notRequired" };
      throw fail("not_supported", `${this.title(definition)} requires OAuth authorization, which this Linux Host cannot complete yet.`,
        "Tell the user to authorize this MCP server from an Ox app Host, or use a server that does not need authorization.");
    }
    throw iosUnavailable(definition.domain);
  }

  async invoke(call: FunctionCall, snapshot: Snapshot, actionId: string, args: JSONObject, session?: unknown, pageURL?: string) {
    if (snapshot.kind === "ios") throw iosUnavailable(snapshot.domain);
    const hostStandard = isHostStandard(snapshot.definition, actionId);
    if (snapshot.kind === "mcp" && !hostStandard) {
      try { await this.mcp.capabilities(snapshot); }
      catch (error) {
        if (error instanceof OxError && error.code === "authentication_required") throw error;
        throw fail("capabilities_unavailable", `Service capabilities are unavailable: ${error instanceof Error ? error.message : String(error)}`,
          "Invoke the server's authorize action if authorization is required; otherwise inspect the connection error.");
      }
    }
    const definition = snapshot.definition;
    let input = args;
    if (session !== undefined || pageURL !== undefined) {
      if (definition.kind !== "web" || !definition.baseUrl) throw fail("invalid_argument", "Session routing is supported only for web services", "Omit session and pageUrl for this service.");
      executionURL(definition, normalizedURL(definition.baseUrl), session, pageURL);
    }
    const name = qualifiedName(definition, actionId);
    const action = findAction(definition, actionId);
    if (!action || action.inputSchema === undefined) throw invokeError.unknown(name);
    if (definition.kind === "web" && actionId === "search" && standardActions(definition).some(entry => entry.id === "search")) {
      const issues = violations(input, searchInputSchema);
      if (issues.length) throw invokeError.invalidInput(name, issues);
      input = { ...input, limit: Math.min(typeof input.limit === "number" ? input.limit : 10, searchMaximum(definition, action)) };
    }
    const issues = violations(input, action.inputSchema, definition.defs);
    if (issues.length) throw invokeError.invalidInput(name, issues);
    if (call.page && definition.kind === "web" && actionId === "conversation" && Array.isArray(input.attachments) && input.attachments.length) {
      throw fail("not_supported", "Pages can't send files to websites", "Send the files from a conversation instead.");
    }
    const recorded = session === undefined && pageURL === undefined ? input : { input, session: session ?? null, pageUrl: pageURL ?? null };
    if (actionId !== "conversation" || input.operation === "submit") {
      await this.approvals.require(call, name, action.requireApproval ? "ask" : "allow", { title: `${this.title(definition)} - ${action.label}`, args: recorded });
    }
    const started = Date.now();
    if (hostStandard) {
      const value = await this.standard(call, snapshot, actionId);
      const outputIssues = violations(value, action.outputSchema);
      if (outputIssues.length) throw invokeError.invalidOutput(name, outputIssues);
      return value;
    }
    const approve = this.approver(call, definition, name);
    let value: unknown;
    if (definition.kind === "web" && actionId === "conversation" && definition.index.has("conversation")) {
      value = await this.conversations.invoke({ snapshot, owner: call.conversationId, args: input, session, pageURL: pageURL ?? null, approve, signal: call.signal,
        attachments: await this.stagedFiles(call, input.attachments) });
    } else if (definition.kind === "api") value = await this.api.invoke(call, snapshot, actionId, input);
    else if (definition.kind === "mcp") value = await this.mcp.invoke(call, snapshot, actionId, input);
    else value = await this.web.invoke({ snapshot, actionId, args: input, session, pageURL: pageURL ?? null, approve, signal: call.signal });
    if (definition.kind === "web" && sessionsEnabled(definition) && actionId === "login") {
      const title = this.title(definition);
      await this.web.presentLogin({ snapshot, actionId, args: input, session, pageURL: pageURL ?? null, approve, signal: call.signal }, async page => {
        const answer = await call.untimed(() => call.ask({ kind: "page", title: `${title} - Log in`, page: page.live.id, done: "Done",
          body: `Log in to ${title} on this page, then choose Done. Ox does not see what you type.` }));
        return answer.kind === "answer";
      });
    }
    this.context.logs.info("services", `invoke done name=${name} ms=${Date.now() - started}`);
    return value;
  }
}

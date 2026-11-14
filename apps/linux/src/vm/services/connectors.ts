import { OxError } from "@openox/agent/linux";
import { sameOrigin } from "../../auth";
import { museParityEnabled } from "../../config";
import { HTTPError, json, payload } from "../../http";
import type { VMRoute } from "../context";
import { exposedActions, qualifiedName, sessionsEnabled, type Candidate, type Definition, type Snapshot } from "./catalog";
import type { Services } from "./manager";
import type { OAuthPreparation } from "./mcp-oauth";
import { connectorIdentity, connectorLimits, type ConnectorReceipt } from "./state";
import { isObject, sha256 } from "./support";
import type { ServicePage } from "./web";

type Category = "productivity" | "social" | "health" | "business" | "other";
type FlowState = "preparing" | "credentials" | "committing" | "web" | "chooseSession" | "oauthPreview" | "authorizing" | "oauthWaiting" | "exchanging" | "verifying" | "disconnecting" | "completed" | "failed" | "cancelled";
interface Flow {
  requestId: string; owner: string; identity: string; snapshot: Snapshot; expectedRevision: number; epoch: number; profile: string;
  controller: AbortController; expires: number; state: FlowState; page?: ServicePage; prepared?: OAuthPreparation; authorizationUrl?: string;
  fields?: { name: string; label: string; secret?: boolean }[]; sessions?: unknown[]; local?: string; revocation?: ConnectorReceipt["revocation"]; error?: string; running?: boolean;
  operation: "setup" | "verify" | "disconnect";
  credentialRevision?: number;
}
const uuid = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const categories: Category[] = ["productivity", "social", "health", "business", "other"];
const active = (flow: Flow) => !["completed", "failed", "cancelled"].includes(flow.state);
const categoryOf = (definition: Definition): Category => {
  const meaning = `${definition.name} ${definition.description} ${definition.actions.map(action => action.id).join(" ")}`.toLowerCase();
  if (/\b(health|medical|biomedical|pubmed|tennis|usta|fitness|club registration|lesson|coverage balances|claims)\b/.test(meaning)) return "health";
  if (/\b(github|software-development|app store|developer|analytics|mixpanel|job|jobs|candidate|tailnet|infrastructure|business|project spend|gemini projects)\b/.test(meaning)) return "business";
  if (/\b(social|instagram|facebook|discord|reddit|youtube|chat|chats|conversation|conversations|community|communities|media|video|videos)\b/.test(meaning)) return "social";
  if (/\b(calendar|mail|email|gmail|outlook|drive|docs|forms|files|documents|productivity|reminders|to-dos|contact|contacts|account balances|portfolio)\b/.test(meaning)) return "productivity";
  return "other";
};
function asset(raw: string | null) {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && /^openox-service-assets-prod\.s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com$/.test(url.hostname)
      && !url.username && !url.password && !url.search && !url.hash ? url.href : null;
  } catch { return null; }
}
function safeFailure(error: unknown) {
  if (error instanceof HTTPError) return error;
  if (error instanceof OxError && error.code === "permission_denied") return new HTTPError(403, "The original action policy blocks this connector operation.");
  if (error instanceof OxError && ["invalid_argument", "not_supported", "authentication_required"].includes(error.code)) {
    return new HTTPError(error.code === "not_supported" ? 422 : error.code === "authentication_required" ? 401 : 400,
      error.code === "authentication_required" ? "Authorization is required. No authenticated connection was verified."
        : error.code === "not_supported" ? "This connector has no supported setup or destination-read verification channel." : "Enter valid connector fields within their limits.");
  }
  return new HTTPError(503, "The connector result is unavailable or unverified. Read its original owner before starting another operation.");
}
const callbackScript = 'history.replaceState(null,"","/oauth/mcp/result")';
function callbackResult(status = 200) {
  const hash = new Bun.CryptoHasher("sha256").update(callbackScript).digest("base64");
  return new Response(`<!doctype html><title>OpenOx authorization</title><script>${callbackScript}</script><p>Return to OpenOx Connectors to read the original connection result.</p>`,
    { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer",
      "content-security-policy": `default-src 'none'; script-src 'sha256-${hash}'; base-uri 'none'; frame-ancestors 'none'` } });
}

export class Connectors {
  private services: Services;
  private flows = new Map<string, Flow>();
  private cancelled = new Map<string, { owner: string; expires: number }>();
  private sweeper: ReturnType<typeof setInterval>;
  constructor(services: Services) {
    this.services = services;
    this.sweeper = setInterval(() => this.prune(), 30_000); this.sweeper.unref();
  }
  private prune() {
    const now = Date.now();
    for (const [id, flow] of this.flows) if (flow.expires <= now) { void this.retire(flow, "cancelled"); this.flows.delete(id); }
    for (const [id, entry] of this.cancelled) if (entry.expires <= now) this.cancelled.delete(id);
    const finished = [...this.flows.values()].filter(flow => !active(flow));
    for (const flow of finished.slice(0, Math.max(0, finished.length - connectorLimits.cancellations))) this.flows.delete(flow.requestId);
  }
  busy() { this.prune(); return [...this.flows.values()].some(active); }
  async close() {
    for (const flow of [...this.flows.values()]) if (active(flow)) await this.retire(flow, "cancelled");
  }
  private async guard(flow: Flow, preferences = true) {
    const context = this.services.context;
    if (this.flows.get(flow.requestId) !== flow || !active(flow) || flow.controller.signal.aborted || flow.expires <= Date.now()
      || flow.profile !== context.settings().profile.id || flow.epoch !== (context.contentEpoch?.() ?? 0) || context.contentBlocked?.()
      || !await context.ownerActive?.(flow.owner)) throw new HTTPError(409, "This connector flow was cancelled, expired or belongs to an old workspace.");
    const current = await this.services.snapshot(flow.snapshot.domain);
    if (current.version !== flow.snapshot.version || current.definition.candidate.repository.id !== flow.snapshot.definition.candidate.repository.id) {
      throw new HTTPError(409, "The original connector definition changed before completion.");
    }
    if (preferences) {
      await this.services.preferences.verify();
      if ((this.services.preferences.connector(flow.identity)?.revision ?? 0) !== flow.expectedRevision) throw new HTTPError(409, "This connector changed in another owner. Read it before continuing.");
      if (flow.operation !== "verify") this.services.preferences.connectorCapacity(flow.identity);
    }
  }
  private async retire(flow: Flow, state: "cancelled" | "failed" | "completed") {
    flow.state = state; flow.controller.abort();
    if (flow.page) await this.services.web.closePage(flow.page);
    flow.page = undefined; flow.prepared = undefined; flow.authorizationUrl = undefined; flow.sessions = undefined;
    this.services.changed();
  }
  private async status(definition: Definition) {
    const preference = this.services.preferences.connector(connectorIdentity(definition.kind, definition.candidate.repository.id, definition.domain));
    if (preference?.disabled) return { state: preference.phase === "disconnecting" ? "unknown" : "disconnected", connected: false, verifiedAt: null };
    if (definition.kind === "api") return this.services.api.status(definition);
    if (definition.kind === "mcp") return this.services.mcp.connectionState(definition);
    if (definition.kind === "web") return this.services.web.connectionState(definition, preference?.sessionDigest);
    return { state: "unavailable", connected: false, verifiedAt: null };
  }
  private async row(candidate: Candidate, definition?: Definition) {
    const identity = connectorIdentity(candidate.kind, candidate.repository.id, candidate.runtime), preference = this.services.preferences.connector(identity);
    const base = { id: candidate.qualified, domain: candidate.runtime, kind: candidate.kind, repository: candidate.repository.id,
      provenance: candidate.repository.provenance, revision: preference?.revision ?? 0, saved: this.services.preferences.saved(candidate.runtime),
      attached: this.services.attachments.conversations().filter(id => this.services.attachments.find(id, candidate.runtime)?.repository === candidate.repository.id).length };
    if (!definition) {
      try { definition = await this.services.catalog.definition(candidate); }
      catch { return { ...base, name: this.services.preferences.name(candidate.runtime) ?? candidate.runtime, description: "", faviconUrl: null, category: "other", featured: false,
        available: false, reason: "The original connector definition is invalid or unavailable.", status: { state: "unavailable", connected: false, verifiedAt: null } }; }
    }
    const native = definition.kind === "ios";
    return { ...base, name: this.services.title(definition).slice(0, 200), description: definition.description.slice(0, 4096), faviconUrl: asset(definition.faviconUrl),
      category: categoryOf(definition), featured: definition.kind === "web" && candidate.repository.provenance === "bundled"
        && ["calendar.google.com", "drive.google.com", "github.com"].includes(definition.domain),
      available: !native, reason: native ? "Native account and OS permissions require an Ox app Host; they are not available here." : null,
      status: native ? { state: "unavailable", connected: false, verifiedAt: null } : await this.status(definition) };
  }
  async inventory(url: URL) {
    for (const field of url.searchParams.keys()) if (!["q", "category", "tab"].includes(field)) throw new HTTPError(400, "Unknown connector query field.");
    const query = url.searchParams.get("q") ?? "", category = url.searchParams.get("category"), tab = url.searchParams.get("tab") ?? "available";
    if (query.length > 200 || category && !categories.includes(category as Category) || !["available", "connected"].includes(tab)) throw new HTTPError(400, "Choose a valid connector search, category or tab.");
    await Promise.all([this.services.preferences.verify(), this.services.secrets.verify()]);
    const state = await this.services.catalog.load();
    if (state.candidates.size > connectorLimits.count) throw new HTTPError(507, "The original connector inventory exceeds the complete-directory limit. Nothing was truncated.");
    const rows: Array<Awaited<ReturnType<typeof this.row>>> = [];
    for (const candidate of state.selected.values()) rows.push(await this.row(candidate));
    for (const conflict of state.conflicts.filter(conflict => !conflict.selectedRepository)) {
      const row = await this.row(conflict.candidates[0]!);
      rows.push({ ...row, available: false, reason: "Several original repositories provide this connector. Choose a source in Advanced services.",
        status: { state: "unavailable", connected: false, verifiedAt: null } });
    }
    const needle = query.trim().toLowerCase(), filtered = rows.filter(row => (!category || row.category === category) && (tab !== "connected" || row.status.connected)
      && (!needle || `${row.name} ${row.domain} ${row.description}`.toLowerCase().includes(needle))).sort((a, b) => a.name.localeCompare(b.name) || a.domain.localeCompare(b.domain));
    const failed = state.repositories.filter(repository => repository.enabled && repository.state === "failed").map(repository => repository.id);
    return { available: true, coverage: failed.length ? "incomplete" : "complete", failedRepositories: failed, total: rows.length,
      categories: categories.map(id => ({ id, count: rows.filter(row => row.category === id).length })), connectors: filtered };
  }
  async detail(domain: string) {
    await Promise.all([this.services.preferences.verify(), this.services.secrets.verify()]);
    const { candidate } = await this.services.selected(domain), definition = await this.services.catalog.definition(candidate);
    const row = await this.row(candidate, definition);
    if (candidate.kind === "ios") return { ...row, definition: "", destination: null, actions: [], setup: { method: "unsupported", verificationActions: [] },
      dependencies: { attachments: row.attached, schedules: 0, activeSchedules: 0 } };
    const snapshot = await this.services.snapshot(domain), actions = exposedActions(snapshot.definition);
    const destination = definition.endpoint ?? definition.baseUrl;
    const schedules = await this.services.context.serviceDependencies?.(domain) ?? { schedules: 0, activeSchedules: 0 };
    return { ...row, definition: snapshot.version, destination, repositoryName: candidate.repository.name,
      actions: actions.map(action => ({ id: action.id, label: action.label, authenticated: action.requireAuth, requireApproval: action.requireApproval,
        policy: this.services.approvals.resolution(qualifiedName(definition, action.id), action.requireApproval ? "ask" : "allow") })),
      setup: { method: definition.kind === "mcp" ? "oauth" : definition.kind === "api" ? definition.auth?.type === "oauth2" ? "unsupported"
        : this.services.api.requiresCredentials(definition) ? "credentials" : "verify" : sessionsEnabled(definition) ? "web" : "verify",
        fields: definition.kind === "api" ? this.services.api.fields(definition) : [],
        verificationActions: definition.kind === "api" ? this.services.api.verificationActions(definition) : [] },
      dependencies: { attachments: row.attached, ...schedules } };
  }
  private async begin(domain: string, body: unknown, owner: string, operation: Flow["operation"], extra: string[] = []) {
    this.prune();
    if (!isObject(body) || Object.keys(body).some(key => !["requestId", "expectedRevision", "repository", "kind", "definition", "confirm", ...extra].includes(key))
      || !uuid(body.requestId) || !Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 0 || body.confirm !== true) {
      throw new HTTPError(400, "Confirm this connector operation with its current identity and revision.");
    }
    const cancelled = this.cancelled.get(body.requestId);
    if (cancelled) throw new HTTPError(409, "This connector request was already cancelled.");
    const previous = this.flows.get(body.requestId);
    if (previous) {
      if (previous.owner !== owner || previous.snapshot.domain !== domain || previous.expectedRevision !== body.expectedRevision || previous.operation !== operation
        || previous.snapshot.kind !== body.kind || previous.snapshot.definition.candidate.repository.id !== body.repository || previous.snapshot.version !== body.definition) {
        throw new HTTPError(409, "This request identity belongs to another connector flow.");
      }
      return previous;
    }
    const snapshot = await this.services.snapshot(domain);
    if (snapshot.kind !== body.kind || snapshot.definition.candidate.repository.id !== body.repository || snapshot.version !== body.definition) {
      throw new HTTPError(409, "The original connector identity or definition changed. Read it again.");
    }
    const identity = connectorIdentity(snapshot.kind, String(body.repository), domain);
    await Promise.all([this.services.preferences.verify(), this.services.secrets.verify()]);
    const receipt = this.services.preferences.connectorRequest(body.requestId, owner);
    if (receipt) throw new HTTPError(409, "This operation was already recorded. Read its original request proof; it will not be replayed.");
    if ((this.services.preferences.connector(identity)?.revision ?? 0) !== body.expectedRevision) throw new HTTPError(409, "This connector changed. Read its current revision.");
    if (operation !== "verify") this.services.preferences.connectorCapacity(identity);
    if ([...this.flows.values()].some(flow => active(flow) && flow.identity === identity) || [...this.flows.values()].filter(active).length >= connectorLimits.flows) {
      throw new HTTPError(409, "A connector setup is already pending. Finish or cancel the original flow.");
    }
    const flow: Flow = { requestId: body.requestId, owner, identity, snapshot, expectedRevision: Number(body.expectedRevision), epoch: this.services.context.contentEpoch?.() ?? 0,
      profile: this.services.context.settings().profile.id, controller: new AbortController(), expires: Date.now() + connectorLimits.ttl, state: "preparing", operation,
      ...(snapshot.kind === "api" ? { credentialRevision: this.services.api.credentialRevision(snapshot.definition) } : {}) };
    if (this.cancelled.has(flow.requestId)) throw new HTTPError(409, "This connector request was cancelled before preparation completed.");
    this.flows.set(flow.requestId, flow);
    return flow;
  }
  private async decision(flow: Flow, action: string, fallback: "ask" | "allow" = "allow") {
    await this.guard(flow);
    await this.services.approvals.ownerDecision(this.services.context, action, fallback, flow.requestId, true, flow.snapshot.definition.baseUrl);
  }
  private async commit(flow: Flow, operation: "connect" | "configure", sessionDigest?: string) {
    await this.guard(flow);
    const definition = flow.snapshot.definition;
    await this.services.preferences.commitConnector(flow.identity, { kind: definition.kind, repository: definition.candidate.repository.id, domain: definition.domain,
      definition: flow.snapshot.version, disabled: false, ...(sessionDigest ? { sessionDigest } : {}) }, flow.expectedRevision, flow.requestId, flow.owner, operation,
      () => this.guard(flow, false));
    await this.retire(flow, "completed");
  }
  private async view(flow: Flow, replayed = false): Promise<any> {
    return { requestId: flow.requestId, state: flow.state, replayed, expiresAt: new Date(flow.expires).toISOString(),
      ...(flow.fields ? { fields: flow.fields } : {}), ...(flow.page ? { page: { id: flow.page.live.id } } : {}),
      ...(flow.sessions ? { sessions: flow.sessions } : {}), ...(flow.error ? { error: flow.error } : {}),
      ...(flow.prepared ? { authorization: { issuer: flow.prepared.issuer, resource: flow.prepared.resource, scopes: flow.prepared.scopes, registration: "dynamic",
        authorizationEndpoint: flow.prepared.metadata.authorization_endpoint, tokenEndpoint: flow.prepared.metadata.token_endpoint } } : {}),
      ...(flow.authorizationUrl ? { authorizationUrl: flow.authorizationUrl } : {}), ...(flow.local ? { local: flow.local, revocation: flow.revocation } : {}),
      ...(flow.state === "completed" ? { connector: await this.detail(flow.snapshot.domain) } : {}) };
  }
  private async setup(domain: string, body: unknown, owner: string, origin: string) {
    const flow = await this.begin(domain, body, owner, "setup");
    if (flow.state !== "preparing" || flow.running) return this.view(flow, true);
    flow.running = true;
    const definition = flow.snapshot.definition;
    try {
      await this.decision(flow, "ox.service.signIn");
      await this.decision(flow, qualifiedName(definition, definition.kind === "api" ? "configureCredentials" : definition.kind === "mcp" ? "authorize" : sessionsEnabled(definition) ? "login" : "listSessions"));
      if (definition.kind === "api") {
        if (definition.auth?.type === "oauth2") throw new HTTPError(422, "This API needs an OpenOx-registered OAuth integration; MCP dynamic registration does not grant API access.");
        flow.fields = this.services.api.fields(definition);
        if (flow.fields.length) flow.state = "credentials";
        else await this.commit(flow, "connect");
      } else if (definition.kind === "web") {
        if (sessionsEnabled(definition)) {
          flow.page = await this.services.web.connectorLogin(flow.snapshot, `connector:${flow.requestId}`, flow.controller.signal);
          await this.guard(flow); flow.state = "web";
        } else {
          await this.services.web.verifyPublicConnector(flow.snapshot, `connector:${flow.requestId}`, flow.controller.signal);
          await this.commit(flow, "connect");
        }
      } else {
        const state = await this.services.mcp.check(definition, { signal: flow.controller.signal });
        if (state === "authorizationRequired") {
          if (!this.services.mcp.oauth) throw new HTTPError(422, "OpenOx authorization is not supported on this Host.");
          flow.prepared = await this.services.mcp.oauth.prepare(definition, `${origin}/oauth/mcp/callback`, flow.controller.signal);
          await this.guard(flow); flow.state = "oauthPreview";
        } else await this.commit(flow, "connect");
      }
      return this.view(flow);
    } catch (error) { const failed = safeFailure(error); flow.error = failed.message; await this.retire(flow, "failed"); throw failed; }
  }
  private owned(id: string, owner: string) {
    if (!uuid(id)) throw new HTTPError(400, "Choose a valid connector request.");
    this.prune();
    const flow = this.flows.get(id);
    if (!flow || flow.owner !== owner) throw new HTTPError(404, "This owner has no such pending connector flow.");
    return flow;
  }
  private async step(id: string, action: string, body: unknown, owner: string) {
    const flow = this.owned(id, owner);
    if (!isObject(body) || body.confirm !== true || Object.keys(body).some(key => !["confirm", ...(action === "credentials" ? ["fields"] : action === "session" ? ["sessionId"] : [])].includes(key))) {
      throw new HTTPError(400, "Confirm the exact connector setup step.");
    }
    if (flow.state === "completed") return this.view(flow, true);
    await this.guard(flow);
    const definition = flow.snapshot.definition;
    try {
      if (action === "credentials" && flow.state === "credentials") {
        flow.state = "committing";
        await this.decision(flow, qualifiedName(definition, "configureCredentials"));
        await this.services.api.save(definition, body.fields, () => this.guard(flow), flow.credentialRevision);
        await this.commit(flow, "configure");
      } else if (action === "authorize" && flow.state === "oauthPreview" && flow.prepared && this.services.mcp.oauth) {
        flow.state = "authorizing";
        await this.decision(flow, qualifiedName(definition, "authorize"));
        flow.authorizationUrl = await this.services.mcp.oauth.authorize(definition, flow.prepared, flow.controller.signal, () => this.guard(flow));
        flow.state = "oauthWaiting";
      } else if ((action === "verify" || action === "session") && ["web", "chooseSession"].includes(flow.state) && flow.page) {
        flow.state = "verifying";
        await this.decision(flow, "ox.service.checkAccess");
        await this.decision(flow, qualifiedName(definition, "listSessions"));
        const sessions = await this.services.web.connectorSessions(flow.snapshot, flow.page, flow.controller.signal);
        await this.guard(flow);
        flow.sessions = sessions as unknown[]; flow.state = "chooseSession";
        if (action === "session") {
          const selected = flow.sessions.find(session => isObject(session) && session.id === body.sessionId);
          if (!isObject(selected)) throw new HTTPError(409, "The selected original Browser account is no longer available.");
          const digest = sha256(String(selected.id));
          this.services.web.rememberConnection(definition, digest);
          await this.commit(flow, "connect", digest);
        }
      } else throw new HTTPError(409, "This setup step is no longer pending. Read its current result; it will not be replayed.");
      return this.view(flow);
    } catch (error) {
      const failed = safeFailure(error);
      if (failed.status === 400 && action === "credentials") { flow.state = "credentials"; throw failed; }
      if (failed.status === 409 && flow.state === "chooseSession") throw failed;
      flow.error = failed.message; await this.retire(flow, "failed"); throw failed;
    }
  }
  private async verify(domain: string, body: unknown, owner: string) {
    const flow = await this.begin(domain, body, owner, "verify", ["actionId"]);
    if (flow.state !== "preparing" || flow.running) return this.view(flow, true);
    flow.running = true;
    flow.state = "verifying";
    const definition = flow.snapshot.definition;
    try {
      if (this.services.preferences.connector(flow.identity)?.disabled) throw new HTTPError(409, "Reconnect explicitly before verifying a disconnected connector.");
      await this.decision(flow, "ox.service.checkAccess");
      if (definition.kind === "api") {
        const actionId = isObject(body) && typeof body.actionId === "string" ? body.actionId : "";
        const action = definition.index.get(actionId);
        await this.decision(flow, qualifiedName(definition, actionId), action?.requireApproval ? "ask" : "allow");
        await this.services.api.verify(flow.snapshot, actionId, flow.controller.signal);
      } else if (definition.kind === "mcp") {
        await this.decision(flow, qualifiedName(definition, "connectionStatus"));
        const result = await this.services.mcp.check(definition, { refresh: true, signal: flow.controller.signal });
        if (result === "authorizationRequired") throw new HTTPError(401, "Authorization is required. No authenticated connection was verified.");
      } else if (!sessionsEnabled(definition)) {
        await this.services.web.verifyPublicConnector(flow.snapshot, `connector:${flow.requestId}`, flow.controller.signal);
      } else {
        await this.decision(flow, qualifiedName(definition, "listSessions"));
        flow.page = await this.services.web.connectorSessionPage(flow.snapshot, `connector:${flow.requestId}`, flow.controller.signal);
        const sessions = await this.services.web.connectorSessions(flow.snapshot, flow.page, flow.controller.signal);
        const digest = this.services.preferences.connector(flow.identity)?.sessionDigest;
        if (!digest || !Array.isArray(sessions) || !sessions.some(session => isObject(session) && sha256(String(session.id)) === digest)) {
          throw new HTTPError(401, "The owner-selected Browser account is unavailable. Choose Connect to explicitly select an account.");
        }
        this.services.web.rememberConnection(definition, digest);
      }
      await this.guard(flow); await this.retire(flow, "completed");
      return this.view(flow);
    } catch (error) { const failed = safeFailure(error); flow.error = failed.message; await this.retire(flow, "failed"); throw failed; }
  }
  private async disconnect(domain: string, body: unknown, owner: string) {
    const flow = await this.begin(domain, body, owner, "disconnect");
    if (flow.state !== "preparing" || flow.running) return this.view(flow, true);
    flow.running = true;
    flow.state = "disconnecting";
    const definition = flow.snapshot.definition;
    try {
      await this.decision(flow, "ox.service.detach", "ask");
      await this.services.preferences.commitConnector(flow.identity, { kind: definition.kind, repository: definition.candidate.repository.id, domain,
        definition: flow.snapshot.version, disabled: true, phase: "disconnecting" }, flow.expectedRevision, flow.requestId, owner, "disconnect", () => this.guard(flow, false));
      this.services.mcp.oauth?.retire(definition);
      this.services.web.forgetConnection(domain);
      await this.services.forget(domain); await this.services.mcp.forget(domain);
      await this.services.attachments.removeConnector(domain, definition.kind, definition.candidate.repository.id);
      flow.revocation = definition.kind === "mcp" && this.services.mcp.oauth ? await this.services.mcp.oauth.revoke(definition, flow.controller.signal) : "notSupported";
      if (definition.kind === "api") await this.services.api.clear(definition);
      if (definition.kind === "mcp") await this.services.mcp.oauth?.clear(definition);
      await this.services.preferences.finishDisconnect(flow.requestId, owner, flow.revocation!);
      flow.local = "disconnected"; await this.retire(flow, "completed");
      return this.view(flow);
    } catch (error) { const failed = safeFailure(error); flow.error = failed.message; await this.retire(flow, "failed"); throw failed; }
  }
  readonly route: VMRoute = async (request, url, parts, owner) => {
    if (!museParityEnabled()) return json({ error: "Connectors are not enabled on this Host." }, { status: 404 });
    if (!sameOrigin(request)) return json({ error: "Use this Host's paired workspace." }, { status: 403 });
    if (!owner) return json({ error: "Pair this device first." }, { status: 401 });
    try {
      if (!parts.length && request.method === "GET") return json(await this.inventory(url));
      if (parts[0] === "requests" && parts.length === 2) {
        const id = parts[1]!;
        if (!uuid(id)) throw new HTTPError(400, "Choose a valid connector request.");
        if (request.method === "GET") {
          await this.services.preferences.verify();
          const flow = this.flows.get(id);
          if (flow?.owner === owner) return json(await this.view(flow));
          const cancelled = this.cancelled.get(id);
          if (cancelled?.owner === owner) return json({ requestId: id, state: "cancelled" });
          const receipt = this.services.preferences.connectorRequest(id, owner);
          if (receipt) return json({ requestId: id, state: receipt.local === "pending" ? "failed" : "completed", local: receipt.local, revocation: receipt.revocation,
            replayed: true });
          throw new HTTPError(404, "This owner has no connector request proof.");
        }
        if (request.method === "DELETE") {
          const flow = this.flows.get(id);
          if (flow && flow.owner !== owner) throw new HTTPError(404, "This owner has no such connector flow.");
          if (flow) { if (active(flow)) await this.retire(flow, "cancelled"); return json(await this.view(flow)); }
          if (this.cancelled.size >= connectorLimits.cancellations) throw new HTTPError(507, "The bounded cancellation history is full.");
          this.cancelled.set(id, { owner, expires: Date.now() + connectorLimits.ttl });
          return json({ requestId: id, state: "cancelled" });
        }
      }
      if (parts[0] === "requests" && parts.length === 3 && request.method === "POST") return json(await this.step(parts[1]!, parts[2]!, await payload(request, 8192), owner));
      if (parts.length === 1 && request.method === "GET") return json(await this.detail(parts[0]!));
      if (parts.length === 2 && request.method === "POST") {
        const body = await payload(request, 8192);
        if (parts[1] === "setup") return json(await this.setup(parts[0]!, body, owner, url.origin), { status: 201 });
        if (parts[1] === "verify") return json(await this.verify(parts[0]!, body, owner));
        if (parts[1] === "disconnect") return json(await this.disconnect(parts[0]!, body, owner));
      }
      throw new HTTPError(404, "Not found");
    } catch (error) { const failed = safeFailure(error); return json({ error: failed.message, code: failed.status === 503 ? "unverified" : "connector_refused" }, { status: failed.status }); }
  };
  readonly callback: VMRoute = async (request, url, _parts, owner) => {
    if (!museParityEnabled() || request.method !== "GET" || url.search.length > 4096) return callbackResult(400);
    const state = url.searchParams.get("state"), flow = [...this.flows.values()].find(flow => flow.state === "oauthWaiting" && flow.prepared?.state === state);
    if (!flow?.prepared || [...url.searchParams.keys()].some(key => !["state", "code", "iss", "error", "error_description"].includes(key))
      || [...url.searchParams.keys()].some(key => url.searchParams.getAll(key).length !== 1) || new URL(flow.prepared.redirectUri).origin !== url.origin) return callbackResult(400);
    if (!owner || owner !== flow.owner) return callbackResult(403);
    const issuer = url.searchParams.get("iss");
    if (issuer !== null && issuer !== flow.prepared.issuer
      || (flow.prepared.metadata as unknown as Record<string, unknown>).authorization_response_iss_parameter_supported === true && issuer === null) return callbackResult(400);
    if (url.searchParams.has("error")) { await this.retire(flow, "cancelled"); return callbackResult(); }
    const code = url.searchParams.get("code");
    if (!code || code.length > 2048 || /[\x00-\x20\x7f]/.test(code)) return callbackResult(400);
    const work = async () => {
      try {
        await this.guard(flow); flow.state = "exchanging";
        await this.services.mcp.oauth!.exchange(flow.snapshot.definition, flow.prepared!, code, flow.controller.signal, () => this.guard(flow));
        const status = await this.services.mcp.check(flow.snapshot.definition, { signal: flow.controller.signal });
        if (status !== "authorized") throw new HTTPError(503, "The server did not verify the stored authorization.");
        await this.commit(flow, "connect");
        return callbackResult();
      } catch (error) { const failed = safeFailure(error); flow.error = failed.message; await this.retire(flow, flow.state === "cancelled" ? "cancelled" : "failed"); return callbackResult(failed.status); }
    };
    try { return await this.services.context.withContentEpoch!(flow.epoch, work); }
    catch { return callbackResult(409); }
  };
}

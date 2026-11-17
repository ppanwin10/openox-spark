import { api } from "./client";
import { keepFocus } from "./capabilities";
import { h, icon, loader, type IconName } from "./dom";
import { hostText, t, type StringKey } from "./i18n";
import type { Settings } from "./settings";

type Category = "productivity" | "social" | "health" | "business" | "other";
type Status = { state: string; connected: boolean; verifiedAt: string | null; requestedScopes?: string[]; grantedScopes?: string[] | null };
type Row = { id: string; domain: string; kind: string; repository: string; provenance: string; revision: number; name: string; description: string;
  available: boolean; reason: string | null; category: Category; featured: boolean; faviconUrl: string | null; saved: boolean; attached: number; status: Status };
type Detail = Row & { definition: string; destination: string | null; repositoryName?: string; actions: { id: string; label: string; authenticated: boolean; requireApproval: boolean;
  policy: { policy: string; scope: string } }[]; setup: { method: string; fields: { name: string; label: string; secret?: boolean }[]; verificationActions: { id: string; label: string }[] };
  dependencies: { attachments: number; schedules: number; activeSchedules: number } };
type Inventory = { available: boolean; coverage: "complete" | "incomplete"; total: number; connectors: Row[]; categories: { id: Category; count: number }[] };
type Intent = { requestId: string; domain: string };
type Result = { requestId: string; state: string; replayed?: boolean; fields?: Detail["setup"]["fields"]; page?: { id: string }; sessions?: { id: string; label: string }[];
  authorization?: { issuer: string; resource: string; scopes: string[]; registration: string }; authorizationUrl?: string; connector?: Detail; error?: string; local?: string; revocation?: string };
type Bridge = { live(): boolean; heading(title: string, sub: boolean): void; advanced(): void; presentPage(id: string): void };
const categoryKeys: Record<Category, StringKey> = { productivity: "cnProductivity", social: "cnSocial", health: "cnHealth", business: "cnBusiness", other: "cnOther" };
const categoryIcons: Record<Category, IconName> = { productivity: "clock", social: "chat", health: "heart", business: "cube", other: "plug" };
const safeID = (value: unknown) => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const validRow = (row: Row) => row && typeof row.domain === "string" && typeof row.name === "string" && typeof row.description === "string" && row.category in categoryKeys
  && typeof row.available === "boolean" && typeof row.status?.connected === "boolean" && typeof row.status.state === "string"
  && (!row.status.connected || row.available && ["verified", "authorized", "signedIn", "notRequired"].includes(row.status.state))
  && Number.isSafeInteger(row.revision) && row.revision >= 0;
export const statusText = (status: Status) => t(status.state === "configured" ? "cnConfigured" : status.state === "verified" ? "cnVerified"
  : status.state === "authorized" ? "cnAuthorized" : status.state === "signedIn" ? "cnSignedIn" : status.state === "notRequired" ? "cnNoAuth"
  : status.state === "authorizationRequired" ? "cnNeedsAuth" : status.state === "disconnected" ? "cnDisconnected"
  : status.state === "unavailable" ? "cnUnavailable" : "cnNotChecked");
const button = (text: string, id: string, run: () => void, kind = "secondary") => h("button", { type: "button", className: `button ${kind}`, "data-testid": id, onclick: run }, text);
const note = (text: string, id?: string) => h("p", { className: "connector-note", ...(id ? { "data-testid": id } : {}) }, text);
const displayIcon = (row: Row, large = false) => {
  const fallback = icon(categoryIcons[row.category], large ? 26 : 22), container = h("span", { className: `connector-icon${large ? " large" : ""}`, "aria-hidden": "true" }, fallback);
  if (row.faviconUrl) {
    const image = h("img", { src: row.faviconUrl, alt: "", loading: "lazy", referrerpolicy: "no-referrer", onerror: () => image.remove(), onload: () => fallback.remove() });
    container.append(image);
  }
  return container;
};
const identityBody = (detail: Detail, requestId: string) => ({ requestId, expectedRevision: detail.revision, kind: detail.kind, repository: detail.repository, definition: detail.definition, confirm: true });

export function mountConnectors(target: HTMLElement, settings: Settings, bridge: Bridge) {
  const recoveryKey = `ox.connectors.request.${settings.host.id}.${settings.profile.id}`;
  let disposed = false, mode: "directory" | "detail" | "review" | "credentials" | "flow" | "disconnect" | "result" = "directory", generation = 0, busy = false;
  let inventory: Inventory | undefined, detail: Detail | undefined, intent: Intent | undefined, query = "", tab = "available", category: Category | null = null;
  let clearFields = () => {}, polling: ReturnType<typeof setTimeout> | undefined;
  const controllers = new Set<AbortController>();
  const active = () => !disposed && bridge.live() && target.isConnected;
  const controller = () => { const value = new AbortController(); controllers.add(value); return value; };
  const remember = (value: Intent | undefined) => {
    intent = value;
    try { if (value) sessionStorage.setItem(recoveryKey, JSON.stringify(value)); else sessionStorage.removeItem(recoveryKey); } catch {}
  };
  if (settings.features?.connectors) {
    try {
      const text = sessionStorage.getItem(recoveryKey), value = text && text.length < 512 ? JSON.parse(text) : null;
      if (value && Object.keys(value).length === 2 && safeID(value.requestId) && typeof value.domain === "string" && value.domain.length <= 253) intent = value;
    } catch {}
  }
  const frame = (next: typeof mode, ...nodes: Node[]) => {
    if (!active()) return;
    clearTimeout(polling); generation++; mode = next;
    target.replaceChildren(h("div", { className: `connector-page connector-${next}` }, ...nodes)); target.scrollTop = 0;
  };
  const privacy = () => note(t("cnPrivacy"), "connector-privacy");
  const advanced = () => button(t("cnAdvanced"), "connector-advanced", () => { clearFields(); void cancel(true); bridge.advanced(); }, "ghost");
  const reportError = (failure: unknown) => h("p", { className: "form-error", role: "alert", tabindex: "-1", "data-testid": "connector-error" },
    hostText(failure instanceof Error ? failure.message : t("cnResultUnknown")));
  async function read<T>(path: string) {
    const abort = controller();
    try { return await api<T>(path, { signal: abort.signal }); } finally { controllers.delete(abort); }
  }
  async function loadDirectory() {
    if (!active() || busy) return;
    bridge.heading(t("museConnectors"), false);
    frame("directory", h("div", { className: "connector-loading", role: "status", "data-testid": "connector-loading" }, loader(22), t("personalLoading")));
    const version = generation;
    if (!settings.features?.connectors) {
      frame("directory", note(t("cnUnavailable")), advanced()); return;
    }
    try {
      const value = await read<Inventory>("/api/connectors");
      if (!active() || generation !== version) return;
      if (value.available !== true || !["complete", "incomplete"].includes(value.coverage) || !Array.isArray(value.connectors) || value.connectors.length > 1000
        || !value.connectors.every(validRow) || !Number.isSafeInteger(value.total) || value.total < value.connectors.length || value.total > 1000) throw new Error(t("cnResultUnavailable"));
      inventory = value; drawDirectory();
    } catch (failure) { if (active() && generation === version) frame("directory", reportError(failure), button(t("museRetry"), "connector-retry", () => void loadDirectory()), advanced()); }
  }
  function drawDirectory() {
    if (!active() || !inventory) return;
    const restore = keepFocus(target);
    bridge.heading(category ? t(categoryKeys[category]) : t("museConnectors"), !!category);
    const search = h("input", { type: "search", className: "field", value: query, maxlength: "200", placeholder: t("museSearch"), "aria-label": t("museSearch"),
      autocomplete: "off", autocapitalize: "off", spellcheck: "false", "data-testid": "connector-search" });
    const lists = h("div", { className: "connector-lists" });
    const segments = h("div", { className: "connector-tabs", role: "tablist", "aria-label": t("museConnectors"), "data-testid": "connector-tabs" },
      ...["available", "connected"].map(value => h("button", { type: "button", role: "tab", "aria-selected": String(tab === value), "data-testid": `connector-tab-${value}`,
        onclick: () => { tab = value; drawDirectory(); } }, t(value === "available" ? "availableServices" : "museConnected"))));
    const row = (item: Row) => h("div", { className: `connector-row${item.available ? "" : " unavailable"}`, "data-testid": "connector-row", "data-domain": item.domain },
      h("button", { type: "button", className: "connector-row-open", "data-testid": "connector-open", "aria-label": item.name, onclick: () => void openDetail(item.domain) },
        displayIcon(item), h("span", { className: "connector-name" }, item.name,
          item.status.state !== "unknown" ? h("small", {}, statusText(item.status)) : null)),
      h("button", { type: "button", className: "connector-row-action", "data-testid": "connector-row-action", disabled: !item.available,
        "aria-label": `${t(item.status.connected || item.status.state === "configured" || item.status.state === "authorizationRequired" ? "cnView" : "connect")}: ${item.name}`,
        onclick: () => void openDetail(item.domain, !item.status.connected && item.status.state !== "configured" && item.status.state !== "authorizationRequired") },
        t(!item.available ? "cnUnavailable" : item.status.connected || item.status.state === "configured" || item.status.state === "authorizationRequired" ? "cnView" : "connect")));
    function draw() {
      query = search.value;
      const needle = query.trim().toLowerCase(), matches = inventory!.connectors.filter(item => (tab !== "connected" || item.status.connected)
        && (!category || item.category === category) && (!needle || `${item.name} ${item.domain} ${item.description}`.toLowerCase().includes(needle)))
        .sort((a, b) => Number(b.available) - Number(a.available) || a.name.localeCompare(b.name));
      const order = ["calendar.google.com", "drive.google.com", "github.com"];
      const featured = matches.filter(item => item.featured).sort((a, b) => order.indexOf(a.domain) - order.indexOf(b.domain));
      lists.replaceChildren(...(!category && !needle && tab === "available" && featured.length ? [
        h("section", { className: "connector-featured", "data-testid": "connector-featured" }, h("h3", {}, t("cnFeatured")),
          h("div", { className: "connector-featured-grid" }, ...featured.slice(0, 3).map(item => h("button", { type: "button", className: "connector-featured-card",
            "data-testid": `connector-featured-${item.domain}`, onclick: () => void openDetail(item.domain) }, displayIcon(item, true), h("strong", {}, item.name),
            h("span", {}, item.description))))) ] : []),
        ...(!matches.length ? [note(t(tab === "connected" ? "cnConnectedEmpty" : "cnEmpty"), "connector-empty")] : category || needle || tab === "connected"
          ? [h("div", { className: "connector-list-card" }, ...matches.map(row))]
          : (Object.keys(categoryKeys) as Category[]).map(id => h("section", { className: "connector-category", "data-testid": `connector-category-${id}` },
            h("div", { className: "connector-category-head" }, h("h3", {}, t(categoryKeys[id])), h("button", { type: "button", className: "button ghost", "data-testid": `connector-see-all-${id}`,
              onclick: () => { category = id; drawDirectory(); } }, t("cnSeeAll"), icon("chevron", 16))),
            h("div", { className: "connector-list-card" }, ...matches.filter(item => item.category === id).slice(0, 5).map(row)),
            matches.some(item => item.category === id) ? null : note(t("cnEmpty"))))));
    }
    search.addEventListener("input", draw);
    frame("directory", h("div", { className: "connector-directory", "data-testid": "connector-directory" }, h("label", { className: "connector-search" }, icon("search", 20), search),
      segments, lists, inventory.coverage === "incomplete" ? note(t("cnInventoryIncomplete"), "connector-incomplete") : null, note(t("cnBoundary")), advanced()));
    draw(); restore();
  }
  async function openDetail(domain: string, setup = false) {
    if (!active() || busy) return;
    clearFields();
    bridge.heading(inventory?.connectors.find(item => item.domain === domain)?.name ?? domain, true);
    frame("detail", h("div", { className: "connector-loading", role: "status" }, loader(22), t("personalLoading")));
    const version = generation;
    try {
      const value = await read<Detail>(`/api/connectors/${encodeURIComponent(domain)}`);
      if (!active() || generation !== version) return;
      if (!validRow(value) || !Array.isArray(value.actions) || !Array.isArray(value.setup?.verificationActions) || typeof value.definition !== "string") throw new Error(t("cnResultUnavailable"));
      detail = value;
      if (setup && value.available) review(); else drawDetail();
    } catch (failure) { if (active() && generation === version) frame("detail", reportError(failure), button(t("museRetry"), "connector-retry", () => void openDetail(domain))); }
  }
  function drawDetail(message?: string) {
    if (!active() || !detail) return;
    bridge.heading(detail.name, true);
    const value = detail;
    const verification = h("select", { className: "field", "aria-label": t("cnVerificationAction"), "data-testid": "connector-verify-action" },
      ...value.setup.verificationActions.map(action => h("option", { value: action.id }, action.label)));
    const verify = button(t("cnVerify"), "connector-verify", () => void submit("verify", value.kind === "api" ? { actionId: verification.value } : {}));
    verify.disabled = !value.available || value.status.state === "disconnected" || value.kind === "api" && value.setup.verificationActions.length === 0;
    frame("detail", h("section", { className: "connector-detail", "data-testid": "connector-detail" },
      h("div", { className: "connector-detail-head" }, displayIcon(value, true), h("div", {}, h("h3", {}, value.name),
        h("p", { className: "connector-status", "data-testid": "connector-status" }, statusText(value.status)))),
      value.status.verifiedAt ? note(t("cnLastChecked", { time: new Date(value.status.verifiedAt).toLocaleString() })) : null,
      note(value.description), value.reason ? note(value.reason) : null, message ? note(message, "connector-outcome") : null,
      h("div", { className: "connector-buttons" }, button(t("connect"), "connector-connect", review, "primary"), verify,
        button(t("cnDisconnect"), "connector-disconnect", disconnectReview, "danger")),
      value.kind === "api" && value.setup.verificationActions.length ? h("label", { className: "stack connector-verification" }, t("cnVerificationAction"), verification) : null,
      value.kind === "api" && !value.setup.verificationActions.length ? note(t("cnNoVerification")) : null,
      h("dl", { className: "connector-facts" }, h("dt", {}, t("cnDestination")), h("dd", {}, value.destination ?? value.domain),
        h("dt", {}, t("serviceRepository")), h("dd", {}, `${value.repositoryName ?? value.repository} · ${value.provenance}`),
        h("dt", {}, t("cnDefinition")), h("dd", {}, value.kind)),
      h("section", { className: "connector-action-list" }, h("h4", {}, t("serviceActions")), ...value.actions.map(action =>
        h("div", {}, h("span", {}, action.label), h("small", {}, `${t(action.policy.policy === "allow" ? "policyAllow" : action.policy.policy === "block" ? "policyBlock" : "policyAsk")} · ${action.policy.scope}`)))),
      note(t("cnSetupOnly")), privacy(), advanced()));
    target.querySelector<HTMLButtonElement>('[data-testid="connector-connect"]')!.disabled = !value.available || value.setup.method === "unsupported";
    target.querySelector<HTMLButtonElement>('[data-testid="connector-disconnect"]')!.disabled = !value.available;
  }
  function review() {
    if (!detail || !active()) return;
    bridge.heading(detail.name, true);
    frame("review", h("section", { className: "connector-review", "data-testid": "connector-review" }, h("h3", {}, t("cnSetupReview")), note(t("cnSetupBody")),
      h("dl", { className: "connector-facts" }, h("dt", {}, t("cnDestination")), h("dd", {}, detail.destination ?? detail.domain),
        h("dt", {}, t("serviceRepository")), h("dd", {}, detail.repositoryName ?? detail.repository)),
      note(t("cnSetupConsent")), h("div", { className: "connector-buttons" }, button(t("cancel"), "connector-cancel", () => drawDetail()),
        button(t("cnContinue"), "connector-continue", () => void submit("setup"), "primary")), privacy()));
  }
  function disconnectReview() {
    if (!detail || !active()) return;
    frame("disconnect", h("section", { "data-testid": "connector-disconnect-review" }, h("h3", {}, t("cnDisconnectTitle", { name: detail.name })),
      note(t("cnDisconnectBody")), note(t("cnDependencies", { chats: detail.dependencies.attachments, schedules: detail.dependencies.schedules })),
      note(t("cnRevocationUnsupported")), h("div", { className: "connector-buttons" }, button(t("cancel"), "connector-cancel", () => drawDetail()),
        button(t("cnDisconnect"), "connector-confirm-disconnect", () => void submit("disconnect"), "danger"))));
  }
  async function submit(action: "setup" | "verify" | "disconnect", extra: object = {}) {
    if (!detail || busy || !active()) return;
    const value = detail, next = { requestId: crypto.randomUUID(), domain: value.domain };
    remember(next); busy = true; clearFields();
    frame("result", note(t("cnSaving"), "connector-pending"), button(t("cancel"), "connector-cancel", () => void cancel()));
    const version = generation, abort = controller();
    try {
      const result = await api<Result>(`/api/connectors/${encodeURIComponent(value.domain)}/${action}`, { method: "POST", json: { ...identityBody(value, next.requestId), ...extra }, signal: abort.signal });
      if (active() && generation === version) showResult(result);
    } catch (failure) { if (active() && generation === version) unknown(failure); }
    finally { controllers.delete(abort); busy = false; }
  }
  async function step(action: string, extra: object = {}) {
    if (!intent || busy || !active()) return;
    const current = intent; busy = true; clearFields();
    frame("result", note(t("cnSaving"), "connector-pending"), button(t("cancel"), "connector-cancel", () => void cancel()));
    const version = generation, abort = controller();
    try {
      const result = await api<Result>(`/api/connectors/requests/${current.requestId}/${action}`, { method: "POST", json: { confirm: true, ...extra }, signal: abort.signal });
      if (active() && generation === version) showResult(result);
    } catch (failure) { if (active() && generation === version) unknown(failure); }
    finally { controllers.delete(abort); busy = false; }
  }
  function credentialForm(result: Result) {
    const fields = result.fields ?? [];
    if (!fields.length || fields.length > 3 || fields.some(field => !["apiKey", "token", "username", "password"].includes(field.name))) { unknown(new Error(t("cnResultUnavailable"))); return; }
    const controls = fields.map(field => h("input", { className: "field", type: field.secret ? "password" : "text", autocomplete: field.secret ? "new-password" : "off", maxlength: "4096",
      "aria-label": field.label, "data-testid": `connector-field-${field.name}`, autocapitalize: "off", spellcheck: "false" }));
    clearFields = () => { for (const input of controls) input.value = ""; };
    const save = h("button", { type: "submit", className: "button primary", "data-testid": "connector-save", disabled: true }, t("save"));
    for (const input of controls) input.addEventListener("input", () => { save.disabled = controls.some(input => !input.value); });
    frame("credentials", h("form", { autocomplete: "off", "data-testid": "connector-credentials", onsubmit: (event: Event) => {
      event.preventDefault(); const fields = Object.fromEntries(controls.map((input, index) => [result.fields![index]!.name, input.value]));
      void step("credentials", { fields });
    } }, h("h3", {}, t("cnCredentials")), note(t("cnCredentialsBody")),
      h("div", { className: "connector-field-card" }, ...controls.map((input, index) => h("label", { className: "stack" }, h("span", {}, fields[index]!.label), input))),
      h("div", { className: "connector-buttons" }, button(t("cancel"), "connector-cancel", () => void cancel()), save), privacy()));
    controls[0]!.focus();
  }
  function showResult(result: Result) {
    if (!active() || !intent || result.requestId !== intent.requestId || typeof result.state !== "string") { unknown(new Error(t("cnResultUnavailable"))); return; }
    if (result.state === "completed") {
      clearFields();
      const message = result.local === "disconnected" ? `${t("cnLocalDisconnected")} ${t(result.revocation === "revoked" ? "cnRevoked"
        : result.revocation === "failed" ? "cnRevocationFailed" : result.revocation === "unknown" ? "cnRevocationUnknown" : "cnRevocationUnsupported")}` : undefined;
      if (result.connector && validRow(result.connector)) { detail = result.connector; remember(undefined); drawDetail(message); }
      else { frame("result", note(t("cnRecorded"), "connector-result"), button(t("cnVerify"), "connector-return-detail", () => { const domain = intent!.domain; remember(undefined); void openDetail(domain); })); }
      return;
    }
    if (result.state === "credentials") { credentialForm(result); return; }
    if (result.state === "web" && result.page) {
      frame("flow", h("section", { "data-testid": "connector-web" }, h("h3", {}, t("cnWebLogin")), note(t("cnWebBody")),
        h("div", { className: "connector-buttons" }, button(t("cnOpenPage"), "connector-open-page", () => bridge.presentPage(result.page!.id)),
          button(t("cnWebDone"), "connector-web-done", () => void step("verify"), "primary"), button(t("cancel"), "connector-cancel", () => void cancel())), privacy()));
      return;
    }
    if (result.state === "chooseSession" && Array.isArray(result.sessions)) {
      frame("flow", h("section", { "data-testid": "connector-accounts" }, h("h3", {}, t("cnChooseAccount")), note(t("cnSetupOnly")),
        ...(result.sessions.length ? result.sessions.map(session => h("button", { type: "button", className: "connector-session", "data-testid": "connector-session",
          "data-session": session.id, onclick: () => void step("session", { sessionId: session.id }) }, icon("user", 20), session.label, icon("chevron", 18))) : [note(t("cnNoSessions"))]),
        h("div", { className: "connector-buttons" }, button(t("cnWebDone"), "connector-web-done", () => void step("verify")), button(t("cancel"), "connector-cancel", () => void cancel()))));
      return;
    }
    if (result.state === "oauthPreview" && result.authorization) {
      const authorization = result.authorization;
      frame("flow", h("section", { "data-testid": "connector-oauth-preview" }, h("h3", {}, t("cnOAuthTitle")), note(t("cnOAuthBody")),
        h("dl", { className: "connector-facts" }, h("dt", {}, t("cnIssuer")), h("dd", {}, authorization.issuer),
          h("dt", {}, t("cnResource")), h("dd", {}, authorization.resource), h("dt", {}, t("cnScopes")), h("dd", {}, authorization.scopes.join(", ") || t("cnScopeUnknown"))),
        h("div", { className: "connector-buttons" }, button(t("cancel"), "connector-cancel", () => void cancel()),
          button(t("cnAuthorize"), "connector-authorize", () => void step("authorize"), "primary")), privacy()));
      return;
    }
    if (result.state === "oauthWaiting" && result.authorizationUrl) {
      let url: URL;
      try {
        url = new URL(result.authorizationUrl);
        if (url.username || url.password || url.hash || !(url.protocol === "https:" || url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname))) throw new Error();
      } catch { unknown(new Error(t("cnResultUnavailable"))); return; }
      frame("flow", h("section", { "data-testid": "connector-oauth-waiting" }, h("h3", {}, t("cnOAuthTitle")), note(t("cnWaiting")),
        h("div", { className: "connector-buttons" }, h("a", { className: "button primary", href: url.href, target: "_blank", rel: "noopener noreferrer",
          "data-testid": "connector-oauth-open" }, t("cnOpenConsent")), button(t("cnReadResult"), "connector-read-result", () => void readResult()),
          button(t("cancel"), "connector-cancel", () => void cancel())), privacy()));
      polling = setTimeout(() => void readResult(true), 1000);
      return;
    }
    if (["preparing", "authorizing", "committing", "ownerConfirmation", "exchanging", "verifying", "disconnecting"].includes(result.state)) {
      unknown(); polling = setTimeout(() => void readResult(true), 1000); return;
    }
    frame("result", note(t(result.state === "cancelled" ? "cnCancelled" : result.state === "failed" ? "cnFailed" : "cnResultUnknown"), "connector-result"),
      ...(result.error ? [reportError(new Error(result.error))] : []),
      h("div", { className: "connector-buttons" }, button(t("cnReadResult"), "connector-read-result", () => void readResult()),
        button(t("cnRetrySetup"), "connector-retry", () => void retry()), button(t("back"), "connector-result-back", () => { remember(undefined); void loadDirectory(); })));
  }
  function unknown(failure?: unknown) {
    frame("result", note(t("cnResultUnknown"), "connector-result"), ...(failure ? [reportError(failure)] : []),
      h("div", { className: "connector-buttons" }, button(t("cnReadResult"), "connector-read-result", () => void readResult()),
        button(t("cnRetrySetup"), "connector-retry", () => void retry()), button(t("cancel"), "connector-cancel", () => void cancel())));
  }
  async function readResult(automatic = false) {
    if (!intent || busy || !active()) { if (automatic && active()) polling = setTimeout(() => void readResult(true), 1000); return; }
    const current = intent, version = generation;
    try {
      const result = await read<Result>(`/api/connectors/requests/${current.requestId}`);
      if (!active() || generation !== version || intent?.requestId !== current.requestId) return;
      if (automatic && !["completed", "failed", "cancelled"].includes(result.state)) { polling = setTimeout(() => void readResult(true), 1000); return; }
      showResult(result);
    } catch (failure) { if (active() && generation === version) unknown(failure); }
  }
  async function cancel(silent = false) {
    const current = intent;
    clearFields(); clearTimeout(polling);
    for (const abort of controllers) abort.abort(); controllers.clear();
    generation++; busy = false;
    if (!current) { if (!silent && detail) drawDetail(); return; }
    try {
      const result = await api<Result>(`/api/connectors/requests/${current.requestId}`, { method: "DELETE", keepalive: true });
      if (!silent && active()) { if (result.state === "completed") showResult(result); else { remember(undefined); if (detail) drawDetail(t("cnCancelled")); else void loadDirectory(); } }
      else if (result.state === "cancelled") remember(undefined);
    } catch (failure) { if (!silent && active()) unknown(failure); }
  }
  async function retry() {
    const domain = intent?.domain ?? detail?.domain;
    await cancel(true); remember(undefined);
    if (domain && active()) await openDetail(domain, true);
  }
  const leave = () => { clearFields(); void cancel(true); };
  window.addEventListener("pagehide", leave);
  if (intent) { unknown(); void readResult(); } else void loadDirectory();
  return { target, refresh: () => {
    if (!active() || busy || ["credentials", "review", "disconnect"].includes(mode)) return;
    if (intent) void readResult(true); else if (mode === "directory") void loadDirectory(); else if (mode === "detail" && detail) void openDetail(detail.domain);
  }, back: () => {
    if (mode === "directory" && category) { category = null; drawDirectory(); }
    else if (mode === "directory") return false;
    else { clearFields(); void cancel(true); if (detail && ["review", "credentials", "flow", "disconnect", "result"].includes(mode)) drawDetail(); else void loadDirectory(); }
    return true;
  }, dispose: () => { disposed = true; generation++; clearFields(); clearTimeout(polling); window.removeEventListener("pagehide", leave); void cancel(true); } };
}

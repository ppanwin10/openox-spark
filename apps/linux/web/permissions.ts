import { api, APIError, ask, menu } from "./client";
import { h, icon, loader, type IconName } from "./dom";
import { hostText, t, type StringKey } from "./i18n";
import { keepFocus } from "./capabilities";
import type { Settings } from "./settings";

type Policy = "allow" | "ask" | "block";
type Group = "connectors" | "websites" | "spaces" | "scheduledTasks" | "protocols";
type Action = { id: string; label: string; group: "read" | "write" | "background"; available: boolean; reason?: string; policy: Policy | null; effective: Policy; scope: string };
type ObjectRow = { id: string; name: string; actions: Action[]; available: boolean; custom: boolean; reason?: string; enabled?: boolean };
type Snapshot = { available: boolean; revision: number; defaults: { connectors: "some" | "ask"; web: "some" | "ask" };
  advancedOverrides: boolean; groups: { id: Group; count: number }[]; objects: Record<Group, ObjectRow[]> };
type Intent = { requestId: string; expectedRevision: number };
type Proof = { requestId: string; revision: number; outcome: "committed" | "superseded" | "unconfirmed"; inputApplied?: boolean; replayed?: boolean };
type Bridge = { live(): boolean; heading(title: string, sub: boolean): void; advanced(): void };
const groups: Record<Group, StringKey> = { connectors: "museConnectors", websites: "ppWebsites", spaces: "librarySpaces", scheduledTasks: "ppScheduledTasks", protocols: "ppProtocols" };
const protocolTitles: Record<string, StringKey> = { ssh: "ppSSH", smtp: "ppSMTP", imap: "ppIMAP", database: "ppDatabase", ftp: "ppFTP", dns: "ppDNS", tcp: "ppTCP", udp: "ppUDP" };
const protocolBodies: Record<string, StringKey> = { ssh: "dpSSHBody", smtp: "dpSMTPBody", imap: "dpIMAPBody", database: "dpDatabaseBody", ftp: "dpFTPBody", dns: "ppDNSBoundary", tcp: "dpTCPBody", udp: "dpUDPBody" };
const protocolIcons: Record<string, IconName> = { ssh: "code", smtp: "mail", imap: "mail", database: "file", ftp: "transfer", dns: "globe", tcp: "globe", udp: "globe" };
const titles: Record<Policy, StringKey> = { allow: "ppAllow", ask: "ppAsk", block: "ppDeny" };
const safeID = (value: unknown) => typeof value === "string" && /^[a-f0-9-]{36}$/.test(value);
const button = (text: string, id: string, run: () => void, kind = "secondary") => h("button",
  { type: "button", className: `button ${kind}`, "data-testid": id, onclick: run }, text);
const note = (text: string, id?: string) => h("p", { className: "permission-note", ...(id ? { "data-testid": id } : {}) }, text);
const validAction = (row: Action) => row && typeof row.id === "string" && typeof row.label === "string" && ["read", "write", "background"].includes(row.group)
  && typeof row.available === "boolean" && (row.policy === null || row.policy in titles) && row.effective in titles;
const valid = (value: Snapshot) => value?.available === true && Number.isSafeInteger(value.revision) && value.revision >= 0
  && ["some", "ask"].includes(value.defaults?.connectors) && ["some", "ask"].includes(value.defaults?.web)
  && Object.keys(groups).every(id => Array.isArray(value.objects?.[id as Group]) && value.objects[id as Group].length <= 1001
    && value.objects[id as Group].every(row => row && typeof row.id === "string" && typeof row.name === "string"
      && (id === "protocols" ? row.id in protocolTitles && typeof row.available === "boolean" && typeof row.enabled === "boolean" : Array.isArray(row.actions) && row.actions.every(validAction))));

export function mountPermissions(target: HTMLElement, settings: Settings, bridge: Bridge) {
  const recoveryKey = `ox.permissions.request.${settings.host.id}.${settings.profile.id}`;
  let disposed = false, generation = 0, busy = false, snapshot: Snapshot | undefined, group: Group | undefined, object: string | undefined, intent: Intent | undefined;
  const controllers = new Set<AbortController>();
  const active = () => !disposed && bridge.live() && target.isConnected;
  const remember = (value?: Intent) => {
    intent = value;
    try { if (value) sessionStorage.setItem(recoveryKey, JSON.stringify(value)); else sessionStorage.removeItem(recoveryKey); } catch {}
  };
  try {
    const text = sessionStorage.getItem(recoveryKey), value = text && text.length < 256 ? JSON.parse(text) : null;
    if (value && Object.keys(value).length === 2 && safeID(value.requestId) && Number.isSafeInteger(value.expectedRevision) && value.expectedRevision >= 0) intent = value;
  } catch {}
  const frame = (...nodes: Node[]) => {
    if (!active()) return;
    generation++;
    target.replaceChildren(h("div", { className: "permission-page", "data-testid": "permission-page" }, ...nodes));
  };
  const section = (title: string, ...nodes: Node[]) => h("section", { className: "permission-section" },
    title ? h("h3", {}, title) : null, h("div", { className: "permission-card" }, ...nodes));
  const error = (failure: unknown) => h("p", { className: "form-error", role: "alert", "data-testid": "permission-error" },
    hostText(failure instanceof Error ? failure.message : t("ppUnknown")));
  async function read<T>(path: string) {
    const abort = new AbortController(); controllers.add(abort);
    try { return await api<T>(path, { signal: abort.signal }); } finally { controllers.delete(abort); }
  }
  async function load() {
    if (!active() || busy || intent) return;
    const scroll = group === "protocols" ? target.scrollTop : null;
    frame(h("div", { className: "permission-loading", role: "status" }, loader(20), t("personalLoading")));
    const current = generation;
    try {
      const value = await read<Snapshot>("/api/permissions/@muse");
      if (!active() || current !== generation) return;
      if (!valid(value)) throw new Error(t("ppUnavailable"));
      snapshot = value; draw();
      if (scroll !== null) target.scrollTop = scroll;
    } catch (failure) { if (active() && current === generation) frame(error(failure), button(t("museRetry"), "permission-retry", () => void load()),
      button(t("ppAdvanced"), "permission-advanced", bridge.advanced, "ghost")); }
  }
  function unknown(message = t("ppUnknown")) {
    if (!active()) return;
    bridge.heading(t("permissions"), !!group);
    frame(note(message, "permission-unknown"), note(t("ppNoReplay")),
      button(t("ppVerify"), "permission-verify", () => void verify()));
  }
  async function verify() {
    if (!intent || busy || !active()) return;
    busy = true;
    try {
      const proof = await read<Proof>(`/api/permissions/@muse/requests/${intent.requestId}`);
      if (!active()) return;
      if (proof.requestId !== intent.requestId || !["committed", "superseded", "unconfirmed"].includes(proof.outcome) || !Number.isSafeInteger(proof.revision)) throw new Error(t("ppUnavailable"));
      if (proof.outcome === "unconfirmed") {
        frame(note(t("ppUnconfirmed"), "permission-unknown"), note(t("ppNoReplay")),
          button(t("ppInspect"), "permission-inspect", () => { remember(); busy = false; void load(); }),
          button(t("ppVerify"), "permission-verify", () => void verify()));
        return;
      }
      remember();
      frame(note(t(proof.outcome === "committed" ? "ppVerified" : "ppSuperseded"), "permission-proof"),
        button(t("ppReload"), "permission-reload", () => void load()));
    } catch (failure) { if (active()) frame(error(failure), note(t("ppNoReplay")),
      button(t("ppInspect"), "permission-inspect", () => { remember(); busy = false; void load(); }),
      button(t("ppVerify"), "permission-verify", () => void verify())); }
    finally { busy = false; }
  }
  async function save(change: Record<string, unknown>, returnTo?: string) {
    if (!active() || busy || intent || !snapshot) return;
    const opening = generation, request: Intent = { requestId: crypto.randomUUID(), expectedRevision: snapshot.revision };
    const scroll = target.scrollTop, restoreFocus = keepFocus(target), location = { group, object };
    remember(request); busy = true;
    frame(h("p", { role: "status", "data-testid": "permission-saving" }, t("ppSaving")));
    try {
      const result = await api<Proof>("/api/permissions/@muse", { method: "POST", json: { ...request, ...change } });
      if (!active()) return;
      if (result.requestId !== request.requestId || result.inputApplied !== true || result.replayed !== false || !Number.isSafeInteger(result.revision)
        || result.revision <= request.expectedRevision) { unknown(); return; }
      remember(); busy = false; await load();
      if (active() && group === location.group && object === location.object
        && (document.activeElement === document.body || target.contains(document.activeElement))) {
        target.scrollTop = scroll;
        if (returnTo) target.querySelector<HTMLElement>(`[data-testid="${CSS.escape(returnTo)}"]`)?.focus({ preventScroll: true });
        else restoreFocus();
      }
    } catch (failure) {
      if (!active() || opening > generation) return;
      if (failure instanceof APIError && failure.status < 500) {
        remember();
        frame(error(failure), button(t("ppReload"), "permission-reload", () => void load()));
      } else unknown();
    } finally { busy = false; }
  }
  async function reset(scope: string, name: string) {
    if (!active() || busy || intent) return;
    const version = generation;
    const answer = await ask({ title: t(scope === "all" ? "ppResetAll" : "ppReset"),
      message: scope === "all" ? t("ppResetAllBody") : t("ppResetScopeBody", { name }), confirm: t("ppResetConfirm"), destructive: true });
    if (answer !== "confirm" || !active() || generation !== version) return;
    await save({ operation: "reset", object: scope, confirm: true });
  }
  async function changeProtocol(item: ObjectRow) {
    if (!active() || busy || intent || !item.available) return;
    const version = generation, enabled = !item.enabled;
    const answer = await ask({ title: t(enabled ? "dpEnableNamed" : "dpDisableNamed", { protocol: t(protocolTitles[item.id]!) }),
      message: t(enabled ? item.id === "dns" ? "dpConfirmDNS" : "dpConfirmEnable" : "dpConfirmDisable"),
      confirm: t(enabled ? "dpEnable" : "dpDisable"), destructive: !enabled });
    if (answer !== "confirm" || !active() || generation !== version) return;
    await save({ operation: "protocol", id: item.id, enabled, confirm: true }, `permission-protocol-toggle-${item.id}`);
  }
  function row(title: string, detail: string, control: Node, id: string) {
    return h("div", { className: "permission-row", "data-testid": id },
      h("div", { className: "permission-row-text" }, h("span", { className: "permission-row-title" }, title), detail ? h("small", {}, detail) : null), control);
  }
  function drill(title: string, subtitle: string, count: string, id: string, run: () => void) {
    return h("button", { type: "button", className: "permission-row permission-drill", "data-testid": id, onclick: run },
      h("span", { className: "permission-row-text" }, h("span", { className: "permission-row-title" }, title), subtitle ? h("small", {}, subtitle) : null),
      h("span", { className: "permission-count" }, count), icon("chevron", 16));
  }
  function policy(action: Action) {
    const picker = h("button", { type: "button", className: "permission-policy", "data-testid": `permission-policy-${action.id}`, "aria-label": hostText(action.label),
      "aria-haspopup": "menu", disabled: !action.available, onclick: () => menu(picker, (["allow", "ask", "block"] as const).map(value => ({
        label: t(titles[value]), testID: `permission-option-${value}`, run: () => void save({ operation: "action", id: action.id, policy: value }),
      })), { className: "permission-menu" }) }, t(action.available ? titles[action.effective] : "ppUnavailableShort"), action.available ? h("span", { className: "permission-down" }, icon("chevron", 14)) : null);
    return row(hostText(action.label), action.available ? t(action.scope === "restriction" ? "ppRestricted" : action.policy !== null ? "ppCustom" : "ppInherited") : hostText(action.reason ?? t("ppUnavailable")),
      picker, "permission-action");
  }
  function draw() {
    if (!snapshot || !active()) return;
    if (!group) {
      bridge.heading(t("permissions"), false);
      const defaults = (which: "connectors" | "web") => section(t(which === "connectors" ? "ppConnectorDefaults" : "ppWebDefaults"),
        ...(["some", "ask"] as const).map(value => h("button", { type: "button", className: "permission-row permission-default", role: "radio",
          "aria-checked": String(snapshot!.defaults[which] === value), "data-testid": `permission-default-${which}-${value}`,
          onclick: () => { if (snapshot!.defaults[which] !== value) void save({ operation: "default", target: which, value }); } },
          h("span", { className: "permission-row-text" }, h("span", { className: "permission-row-title" }, t(value === "some" ? "ppSome" : "ppAlwaysAsk")),
            h("small", {}, t(value === "some" ? which === "connectors" ? "ppConnectorSomeBody" : "ppWebSomeBody" : which === "connectors" ? "ppConnectorAskBody" : "ppWebAskBody"))),
          snapshot!.defaults[which] === value ? icon("check", 20) : h("span", { className: "permission-check-space" }))));
      const connectorDefaults = defaults("connectors"); connectorDefaults.dataset.testid = "permission-default-connectors";
      const webDefaults = defaults("web"); webDefaults.dataset.testid = "permission-default-web";
      const objects = section(t("ppManage"), ...Object.keys(groups).map(id => drill(t(groups[id as Group]), "", String(snapshot!.objects[id as Group].length),
        `permission-group-${id}`, () => { group = id as Group; object = undefined; draw(); target.scrollTop = 0; })));
      objects.dataset.testid = "permission-objects";
      frame(connectorDefaults, webDefaults, objects, h("div", { className: "permission-card permission-reset-card" },
        button(t("ppResetAll"), "permission-reset-all", () => void reset("all", t("ppResetAll")), "ghost danger")),
        snapshot.advancedOverrides ? note(t("ppAdvancedOverrides"), "permission-advanced-overrides") : note(t("ppDefaultsBoundary")),
        button(t("ppAdvanced"), "permission-advanced", bridge.advanced, "ghost"));
      return;
    }
    const rows = snapshot.objects[group];
    if (group === "protocols") {
      bridge.heading(t("ppProtocols"), true);
      frame(section("", ...rows.map(item => {
        const toggle = h("input", { type: "checkbox", role: "switch", className: "switch", checked: item.enabled === true,
          disabled: !item.available, "aria-label": t(protocolTitles[item.id]!), "aria-checked": String(item.enabled === true),
          "data-testid": `permission-protocol-toggle-${item.id}`, onchange: () => { toggle.checked = item.enabled === true; void changeProtocol(item); } });
        const element = row(t(protocolTitles[item.id]!), t(protocolBodies[item.id]!), toggle, `permission-protocol-${item.id}`);
        element.classList.add("permission-protocol");
        element.prepend(icon(protocolIcons[item.id]!, 18));
        return element;
      })),
        note(t("ppNetworkBoundary")));
      return;
    }
    if (!object) {
      bridge.heading(t(groups[group]), true);
      frame(section(t(group === "websites" ? "ppWebsiteRules" : groups[group]), ...(rows.length ? rows.map(item => drill(hostText(item.name),
        item.custom ? t("ppCustomPermissions") : item.available ? "" : t("ppUnavailableShort"), "", `permission-object-${item.id}`,
        () => { object = item.id; draw(); target.scrollTop = 0; })) : [note(t(group === "spaces" ? "ppNoSpaces" : group === "scheduledTasks" ? "ppNoSchedules" : "ppNoWebsites"), "permission-empty")])));
      return;
    }
    const selected = rows.find(row => row.id === object);
    if (!selected) { object = undefined; draw(); return; }
    bridge.heading(hostText(selected.name), true);
    const sections = (["read", "write", "background"] as const).filter(group => selected.actions.some(action => action.group === group))
      .map(group => section(t(group === "read" ? "ppRead" : group === "write" ? "ppWrite" : "ppBackground"), ...selected.actions.filter(action => action.group === group).map(policy)));
    const scope = selected.id === "@browser" ? "browser" : `${group === "connectors" ? "connector" : group === "websites" ? "website" : group === "spaces" ? "space" : "schedule"}:${selected.id}`;
    frame(...sections, button(t("ppReset"), "permission-reset-object", () => void reset(scope, hostText(selected.name)), "ghost danger"),
      note(t(selected.id === "@browser" ? "ppBrowserBoundary" : group === "spaces" ? "ppSpaceBoundary" : group === "scheduledTasks" ? "ppScheduleBoundary" : "ppConnectorBoundary")));
  }
  if (intent) unknown(); else void load();
  return {
    target,
    refresh() { if (active() && !busy && !intent) void load(); },
    back() { if (busy || intent) return true; if (object) object = undefined; else if (group) group = undefined; else return false; draw(); target.scrollTop = 0; return true; },
    dispose() { disposed = true; generation++; for (const controller of controllers) controller.abort(); controllers.clear(); },
  };
}

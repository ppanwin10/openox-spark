import { h, icon, type IconName } from "./dom";
import { ask, sheet, toast } from "./client";
import { applyTheme } from "./settings";
import { hostText, locale, t } from "./i18n";
import { qrCode } from "./qr";
import type { ConsoleState } from "../scripts/mac-host-console";

type View = { kind: "opening" } | { kind: "locked"; message: string }
  | { kind: "ready"; data: ConsoleState } | { kind: "stale"; data: ConsoleState; message: string };
type PairAction = { kind: "idle" } | { kind: "generating" } | { kind: "failed"; message: string };
type HostAction = { kind: "idle" } | { kind: "sending" | "uncertain"; action: "start" | "stop" };
type Selection = { kind: "host" } | { kind: "devices" } | { kind: "device"; id: string };
class ConsoleError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
const root = document.getElementById("control-app")!;
const base = new URL(".", location.href).pathname;
let view: View = { kind: "opening" }, selection: Selection = { kind: "devices" }, query = "", loading = false;
let list: HTMLElement, detail: HTMLElement, banner: HTMLElement, status: HTMLElement, main: HTMLElement, workspaceCsrf: HTMLInputElement, power: HTMLButtonElement;
let pairDialog: ReturnType<typeof sheet> | undefined, pairBody: HTMLElement | undefined, regenerate: HTMLButtonElement | undefined;
let pairSignature = "", detailSignature = "", listSignature = "", pairRevision = 0;
let pairAction: PairAction = { kind: "idle" };
let hostAction: HostAction = { kind: "idle" };
let hostRevision = 0;
const date = (value: string | null) => value ? new Date(value).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" }) : t("consoleNever");
const snapshot = () => view.kind === "ready" || view.kind === "stale" ? view.data : null;
const message = (error: unknown) => error instanceof ConsoleError && (error.status === 401 || error.status === 403) ? t("consoleDenied")
  : error instanceof ConsoleError && error.status === 404 ? t("consoleGone") : t("consoleFailed");
async function api<T>(path: string, method = "GET", json?: unknown): Promise<T> {
  const response = await fetch(`${base}api/${path}`, { method, credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(10000),
    headers: { ...(json === undefined ? {} : { "content-type": "application/json" }), ...(method !== "GET" ? { "x-ox-control": snapshot()?.csrf ?? "" } : {}) },
    ...(json === undefined ? {} : { body: JSON.stringify(json) }) });
  if (!response.ok) throw new ConsoleError(response.status, `Local console HTTP ${response.status}`);
  return response.json() as Promise<T>;
}
function button(text: string, testID: string, run: () => void, className = "secondary", symbol?: IconName) {
  return h("button", { type: "button", className: `button hc-action ${className}`, "data-testid": testID, "aria-label": text, title: text, onclick: run },
    symbol ? icon(symbol, 18) : null, h("span", { className: "hc-action-label" }, text));
}
function shell() {
  const search = h("input", { type: "search", className: "field", "aria-label": t("consoleSearch"), placeholder: t("consoleSearch"),
    "data-testid": "console-search", oninput: (event: Event) => { query = (event.currentTarget as HTMLInputElement).value; renderList(); } });
  list = h("div", { className: "hc-list", "data-testid": "console-device-list" });
  detail = h("section", { className: "hc-detail", "data-testid": "console-detail", "aria-label": t("consolePairings") });
  banner = h("div", { className: "hc-banner", role: "alert", hidden: true, "data-testid": "console-error" });
  status = h("span", { className: "hc-status", role: "status", "data-testid": "console-status" }, t("consoleOpening"));
  workspaceCsrf = h("input", { type: "hidden", name: "csrf" });
  const workspace = h("form", { action: `${base}api/workspace`, method: "POST", target: "_blank", rel: "noopener",
    onsubmit: (event: Event) => {
      if (view.kind !== "ready" || snapshot()?.runtime.state.kind !== "running" || hostAction.kind !== "idle") {
        event.preventDefault(); toast(t("consoleStoppedBody"), "error");
      }
    } }, workspaceCsrf, h("button", { type: "submit", className: "button secondary hc-action", "data-testid": "console-workspace",
    title: t("consoleWorkspaceNote") }, h("span", {}, t("consoleWorkspace")), icon("external", 16)));
  main = h("main", { className: "hc-main", "data-view": selection.kind },
    h("section", { className: "hc-list-pane", id: "console-list-pane" },
      h("div", { className: "hc-list-head" },
        h("div", { className: "hc-list-title" }, h("h1", {}, t("consolePairings")),
          button(t("consoleHost"), "console-overview", () => select({ kind: "host" }), "ghost hc-info", "info")),
        h("div", { className: "hc-search" }, icon("search", 18), search)),
      list, h("div", { className: "hc-list-note" }, h("p", {}, t("consoleAccessScope")), h("p", {}, t("consoleTest")))), detail);
  detail.id = "console-detail-pane";
  power = button(t("consoleStart"), "console-power", () => void changeHost(), "hc-power primary hc-add");
  power.hidden = true;
  root.replaceChildren(h("div", { className: "hc-shell" },
    h("header", { className: "hc-header" },
      h("div", { className: "hc-brand" }, icon("host", 26), h("div", { className: "hc-brand-text" }, h("strong", {}, t("consoleTitle")), status)),
      power,
      h("div", { className: "hc-tools" },
        button(t("consoleRefresh"), "console-refresh", () => void refresh(), "secondary", "reload"),
        workspace, button(t("consoleAdd"), "console-add", () => void openPair(), "primary hc-add", "plus"))), banner, main));
}
function renderRuntime() {
  const data = snapshot();
  if (!data || !power) return;
  const state = data.runtime.state, running = state.kind === "running", stopping = state.kind === "stopping"
    || state.kind === "failed" && state.action === "stop";
  const busy = hostAction.kind === "sending" || state.kind === "starting" || state.kind === "stopping";
  power.hidden = !data.runtime.controllable;
  power.disabled = view.kind !== "ready" || hostAction.kind !== "idle" || busy;
  const stop = running || stopping;
  const pendingAction = hostAction.kind === "sending" ? hostAction.action : state.kind === "stopping" ? "stop" : "start";
  const label = t(busy ? pendingAction === "stop" ? "consoleStopping" : "consoleStarting" : stop ? "consoleStop" : "consoleStart");
  power.replaceChildren(h("span", { className: "hc-action-label" }, label));
  power.setAttribute("aria-label", label);
  power.className = `button hc-action hc-power ${stop ? "secondary" : "primary hc-add"}`;
  power.dataset.action = stop ? "stop" : "start";
  for (const id of ["console-workspace", "console-add"]) {
    const control = root.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`);
    if (control) control.disabled = !running || view.kind !== "ready" || hostAction.kind !== "idle";
  }
  if (view.kind === "ready") {
    banner.hidden = true;
    const labels = { running: "consoleRunning", stopped: "consoleStopped", starting: "consoleStarting", stopping: "consoleStopping" } as const;
    status.textContent = hostAction.kind === "sending" ? label
      : t(state.kind === "failed" ? state.action === "start" ? "consoleStartFailed" : "consoleStopFailed" : labels[state.kind]);
    status.dataset.state = hostAction.kind === "sending" ? hostAction.action === "start" ? "starting" : "stopping" : state.kind;
    status.dataset.live = String(running && hostAction.kind === "idle");
    if (state.kind === "failed" && hostAction.kind === "idle") {
      banner.replaceChildren(icon("warning", 18), h("span", {}, `${status.textContent}. ${hostText(state.message)}`));
      banner.hidden = false;
    }
  }
}
async function changeHost() {
  const data = snapshot();
  if (view.kind !== "ready" || !data?.runtime.controllable || hostAction.kind !== "idle") return;
  const state = data.runtime.state;
  if (state.kind === "starting" || state.kind === "stopping") return;
  const action = state.kind === "running" || state.kind === "failed" && state.action === "stop" ? "stop" : "start";
  if (action === "stop" && await ask({ title: t("consoleStopTitle"), message: t("consoleStopBody"), confirm: t("consoleStop"), destructive: true }) !== "confirm") return;
  if (view.kind !== "ready" || hostAction.kind !== "idle") return;
  hostRevision++; hostAction = { kind: "sending", action }; pairDialog?.close(); renderRuntime();
  try {
    const runtime = await api<ConsoleState["runtime"]>(`runtime/${action}`, "POST");
    const current = snapshot();
    if (current && runtime.revision >= current.runtime.revision) {
      view = { kind: "ready", data: { ...current, runtime, ...(runtime.state.kind !== "running" ? { pairing: { state: "none" } } : {}) } };
    }
    hostAction = { kind: "idle" };
  } catch {
    hostAction = { kind: "uncertain", action };
    const current = snapshot();
    if (current) view = { kind: "stale", data: current, message: t("consoleActionUnknown") };
    status.textContent = t("consoleStale"); status.dataset.live = "false"; status.dataset.state = "unknown";
    banner.replaceChildren(icon("warning", 18), h("span", {}, t("consoleActionUnknown"))); banner.hidden = false;
  } finally { hostRevision++; renderRuntime(); renderList(); renderDetail(); }
}
function select(next: Selection) {
  selection = next; detailSignature = ""; listSignature = "";
  main.dataset.view = next.kind;
  root.querySelector('[data-testid="console-overview"]')?.setAttribute("aria-pressed", String(next.kind === "host"));
  renderList(); renderDetail();
}
function renderList() {
  const data = snapshot();
  if (!data || !list) return;
  const visible = data.devices.filter(device => device.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const selected = selection.kind === "device" ? selection.id : null;
  const signature = JSON.stringify([visible, selected, query, data.runtime.state.kind]);
  if (signature === listSignature) return;
  listSignature = signature;
  const focus = list.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.testid : undefined;
  list.replaceChildren(...(visible.length ? visible.map(device => h("button", { type: "button", className: "hc-client",
    "aria-pressed": String(selected === device.id), "data-testid": `console-device-${device.id}`, onclick: () => select({ kind: "device", id: device.id }) },
    h("span", { className: "row-icon" }, icon(device.kind === "cli" ? "key" : "globe", 20)),
    h("span", { className: "hc-client-copy" }, h("span", { className: "hc-client-name" }, device.name),
      h("span", { className: "hc-client-meta" }, t(device.kind === "cli" ? "consoleCli" : "consoleBrowser")),
      h("span", { className: "hc-session", "data-active": String(device.webSessions > 0) },
        device.kind === "cli" ? date(device.lastSeenAt) : device.webSessions ? t("consoleActive", { count: device.webSessions }) : t("consoleNoSession")))))
    : [h("div", { className: "hc-empty", "data-testid": "console-empty" }, icon(query ? "search" : "globe", 28),
      h("strong", {}, t(query ? "consoleNoMatch" : "consoleEmpty")),
      query ? null : h("p", {}, t(data.runtime.state.kind === "running" ? "consoleEmptyBody" : "consoleStoppedBody")))]));
  if (focus) list.querySelector<HTMLElement>(`[data-testid="${CSS.escape(focus)}"]`)?.focus({ preventScroll: true });
}
function facts(rows: [string, string | Node][]) {
  return h("dl", { className: "hc-facts" }, ...rows.map(([name, value]) => h("div", {}, h("dt", {}, name), h("dd", {}, value))));
}
function renderDetail() {
  const data = snapshot();
  if (!data || !detail) return;
  if (selection.kind === "devices") { detail.replaceChildren(); detailSignature = ""; return; }
  const selected = selection.kind === "device" ? selection.id : null;
  const device = data.devices.find(value => value.id === selected);
  if (selection.kind === "device" && !device) { select({ kind: "devices" }); return; }
  const signature = JSON.stringify([device, device ? null : data.host, selection.kind, data.runtime, view.kind]);
  if (signature === detailSignature) return;
  detailSignature = signature;
  const focus = detail.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.testid : undefined;
  const body = device ? [
    h("h2", {}, device.name),
    h("p", { className: "hc-detail-lead" }, t("consolePaired")),
    facts([[t("consoleClientType"), t(device.kind === "cli" ? "consoleCli" : "consoleBrowser")],
      ...(device.kind === "browser" ? [[t("consoleSessionLabel"), t(device.webSessions ? "consoleActive" : "consoleNoSession", { count: device.webSessions })] as [string, string]] : []),
      [t("consoleCreated"), date(device.createdAt)], [t("consoleLastSeen"), date(device.lastSeenAt)]]),
    h("div", { className: "hc-detail-notes" }, h("p", {}, t(device.kind === "browser" ? "consoleActivityNote" : "consoleCliNote"))),
    h("div", { className: "hc-detail-actions" }, button(t("consoleRemove"), "console-revoke", async () => {
      if (await ask({ title: t("consoleRemoveTitle", { name: device.name }), message: t("consoleRemoveBody"),
        confirm: t("consoleRemove"), destructive: true }) !== "confirm") return;
      try { await api(`devices/${encodeURIComponent(device.id)}`, "DELETE"); select({ kind: "devices" }); await refresh(); }
      catch (error) { toast(message(error), "error"); }
    }, "danger")),
  ] : [
    h("h2", {}, data.host.name),
    h("p", { className: "hc-detail-lead" }, t("consoleOverview")),
    facts([[t("profile"), data.host.workspace], [t("consoleAddress"), h("code", { className: "mono" }, data.host.origin)],
      [t("consoleData"), h("code", { className: "mono" }, data.host.data)], [t("consoleVersion"), data.host.version], [t("consoleCertificate"), date(data.host.certificateExpires)]]),
    h("div", { className: "hc-detail-notes" }, h("p", {}, t("consoleWorkspaceNote"))),
  ];
  detail.replaceChildren(h("div", { className: "hc-detail-inner" },
    button(t("consolePairings"), "console-back", () => select({ kind: "devices" }), "ghost hc-back", "back"), ...body,
    h("p", { className: "hc-updated", "data-testid": "console-updated" }, t("consoleUpdated", { time: date(data.checkedAt) }))));
  if (focus) detail.querySelector<HTMLElement>(`[data-testid="${CSS.escape(focus)}"]`)?.focus({ preventScroll: true });
}
function renderPair() {
  if (!pairBody) return;
  const data = snapshot(), pairing = data?.pairing;
  const state = data?.runtime.state.kind !== "running" || hostAction.kind !== "idle" ? "host-stopped"
    : pairAction.kind !== "idle" ? pairAction.kind : view.kind !== "ready" ? "stale"
    : pairing?.state === "active" && pairing.expiresAt && Date.parse(pairing.expiresAt) <= Date.now() ? "expired" : pairing?.state;
  if (regenerate) {
    regenerate.disabled = pairAction.kind === "generating" || !data || data.runtime.state.kind !== "running" || hostAction.kind !== "idle";
    regenerate.textContent = t(pairAction.kind === "generating" ? "consoleQrGenerating" : pairAction.kind === "failed" ? "consoleQrRetry" : "consoleQrNew");
    regenerate.setAttribute("aria-label", regenerate.textContent);
  }
  pairBody.setAttribute("aria-busy", String(pairAction.kind === "generating"));
  const signature = JSON.stringify([state, pairing, pairAction]);
  if (signature === pairSignature) return;
  pairSignature = signature;
  pairBody.replaceChildren(h("div", {},
    h("p", { className: "hc-pair-note" }, t("consoleQrHelp")),
    state === "active" && pairing?.url ? h("div", { className: "hc-qr", "data-testid": "console-pairing-qr", "data-link": pairing.url },
      qrCode(pairing.url, t("pairCode")))
      : state === "generating" || state === "failed" ? h("div", { className: "hc-qr-placeholder", "data-state": state, "aria-hidden": "true" },
        icon(state === "generating" ? "reload" : "warning", 28)) : null,
    state === "active" && pairing?.url ? h("p", { className: "hc-pair-code", "data-testid": "console-pairing-code" },
      t("pairCode"), " ", h("strong", {}, new URL(pairing.url).hash.slice("#/pair/".length))) : null,
    h("p", { className: "hc-pair-note", role: "status", "data-testid": "console-pairing-status" },
      state === "active" ? t("consoleQrFresh", { time: new Date(pairing!.expiresAt!).toLocaleString(locale, { dateStyle: "medium", timeStyle: "medium" }) })
        : state === "host-stopped" ? t("consoleStoppedBody") : state === "failed" && pairAction.kind === "failed" ? pairAction.message
          : t(state === "generating" ? "consoleQrGenerating"
            : state === "expired" ? "consoleQrExpired" : state === "stale" ? "consoleStale" : "consoleQrUsed")),
    h("p", { className: "hc-pair-note" }, t("consoleQrReplace"))));
}
async function createPair() {
  if (pairAction.kind === "generating" || snapshot()?.runtime.state.kind !== "running") return;
  pairRevision++;
  pairAction = { kind: "generating" }; renderPair();
  try {
    const pairing = await api<ConsoleState["pairing"]>("pairing", "POST");
    const data = snapshot();
    if (!data) throw new ConsoleError(401, "Local authorization is unavailable");
    view = { kind: "ready", data: { ...data, pairing } };
    renderRuntime(); banner.hidden = true;
    pairAction = { kind: "idle" };
  } catch (error) {
    pairAction = { kind: "failed", message: error instanceof ConsoleError && (error.status === 401 || error.status === 403)
      ? t("consoleDenied") : t("consoleQrFailed") };
  } finally { pairRevision++; renderPair(); }
}
async function openPair(create = true) {
  if (pairDialog) { if (create) await createPair(); return; }
  pairDialog = sheet({ testID: "console-pair-dialog", className: "hc-pair-dialog", label: t("consoleQrTitle"), onClose: () => {
    pairDialog = undefined; pairBody = undefined; regenerate = undefined; pairSignature = "";
  } });
  pairBody = h("div", { className: "sheet-body" });
  regenerate = button(t("consoleQrNew"), "console-pair-regenerate", () => void createPair(), "primary hc-add");
  pairDialog.dialog.append(h("div", { className: "sheet-head" }, h("h2", { className: "sheet-title" }, t("consoleQrTitle")),
    h("button", { type: "button", className: "icon-button hc-close", "aria-label": t("close"), title: t("close"),
      "data-testid": "console-pair-close", onclick: () => pairDialog?.close() }, icon("close", 20))), pairBody,
  h("div", { className: "dialog-actions hc-pair-actions" }, regenerate));
  renderPair();
  if (create) await createPair();
}
function locked(text: string) {
  root.replaceChildren(h("main", { className: "hc-locked" }, icon("host", 32), h("h1", {}, t("consoleTitle")),
    h("p", { role: "alert", "data-testid": "console-auth-message" }, text)));
}
async function refresh() {
  if (loading) return;
  loading = true;
  const revision = pairRevision;
  const runtimeRevision = hostRevision;
  try {
    const data = await api<ConsoleState>("state");
    if (revision !== pairRevision || runtimeRevision !== hostRevision) return;
    const previous = snapshot();
    if (previous && data.runtime.revision < previous.runtime.revision) return;
    view = { kind: "ready", data };
    if (hostAction.kind === "uncertain") hostAction = { kind: "idle" };
    if (!root.querySelector(".hc-shell")) shell();
    banner.hidden = true; workspaceCsrf.value = data.csrf;
    renderRuntime(); renderList(); renderDetail(); renderPair();
    detail.querySelector<HTMLElement>('[data-testid="console-updated"]')?.replaceChildren(t("consoleUpdated", { time: date(data.checkedAt) }));
  } catch (error) {
    if (revision !== pairRevision || runtimeRevision !== hostRevision) return;
    const data = snapshot();
    if (error instanceof ConsoleError && error.status === 401) {
      pairDialog?.close(); view = { kind: "locked", message: t("consoleAuthNeeded") }; locked(view.message);
    } else if (data) {
      view = { kind: "stale", data, message: message(error) };
      status.textContent = t("consoleStale"); status.dataset.live = "false"; status.dataset.state = "unknown";
      banner.replaceChildren(icon("warning", 18), h("span", {}, view.message)); banner.hidden = false; renderRuntime(); renderPair();
    } else { view = { kind: "locked", message: message(error) }; locked(view.message); }
  } finally { loading = false; }
}
async function start() {
  applyTheme(); document.documentElement.lang = locale; document.title = t("consoleTitle");
  locked(t("consoleOpening"));
  const fragment = new URLSearchParams(location.hash.slice(1)), claim = fragment.get("claim"), panel = fragment.get("panel");
  history.replaceState(null, "", location.pathname);
  try {
    if (claim) await api("claim", "POST", { claim });
    await refresh();
    if (view.kind === "ready" && panel === "pair") await openPair(false);
  } catch (error) { view = { kind: "locked", message: message(error) }; locked(view.message); }
}
void start();
window.addEventListener("hashchange", () => {
  if (new URLSearchParams(location.hash.slice(1)).has("claim")) location.reload();
});
setInterval(() => { if (!document.hidden && view.kind !== "locked" && view.kind !== "opening") void refresh(); }, 3000);
setInterval(() => { if (pairDialog) renderPair(); }, 1000);
document.addEventListener("visibilitychange", () => { if (!document.hidden && (view.kind === "ready" || view.kind === "stale")) void refresh(); });

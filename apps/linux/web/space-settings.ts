import type { Space, SpaceDataSnapshot, SpaceNotes, SpaceVisibility } from "@openox/agent/linux";
import { api, APIError, ask, failed, getContentEpoch, sheet, toast } from "./client";
import { editSchedule, openScheduleDetails, scheduleListRow, type ScheduleRow } from "./capabilities";
import { h, icon } from "./dom";
import { hostText, locale, t, type StringKey } from "./i18n";

type Resources = { space: Space; entry: { fileId: string; path: string; sha256: string }; dataFiles: { id: string; path: string; sha256: string }[] };
type Tab = "placement" | "data" | "connections" | "updates";
const describe = (error: unknown) => hostText(error instanceof Error ? error.message : String(error));
const label = (name: string, field: HTMLElement) => { field.setAttribute("aria-label", name); return h("label", { className: "stack" }, h("span", { className: "label" }, name), field); };
const field = (testID: string, attributes: Record<string, unknown> = {}) => h("input", { className: "field", "data-testid": testID, ...attributes });
const button = (text: string, testID: string, run: () => void, primary = false) => h("button", {
  type: "button", className: `button ${primary ? "primary" : "secondary"}`, "data-testid": testID, onclick: run,
}, text);
const note = (text: string, testID?: string) => h("p", { className: "muted small", ...(testID ? { "data-testid": testID } : {}) }, text);
const when = (value: string | number) => new Date(value).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });
const discard = async () => await ask({ title: t("discardChanges"), message: t("formCloseBody"), confirm: t("discard"), destructive: true }) === "confirm";
const fingerprint = async (data: SpaceNotes) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",
  new TextEncoder().encode(JSON.stringify({ notes: data.notes, items: data.items.map(({ id, text, checked }) => ({ id, text, checked })) }))))).map(byte => byte.toString(16).padStart(2, "0")).join("");
function originalAPI() {
  const epoch = getContentEpoch();
  return <T>(path: string, init: RequestInit & { json?: unknown } = {}) => api<T>(path, { ...init,
    headers: { ...init.headers, ...(epoch === undefined ? {} : { "x-openox-content-epoch": String(epoch) }) } });
}

export function manageSpace(id: string) {
  const request = originalAPI(), base = `/api/spaces/${encodeURIComponent(id)}`;
  let resource: Resources | undefined, tab: Tab = "placement", busy = false, closed = false, dirty = () => false, serial = 0;
  const view = sheet({ testID: "space-manager", className: "todo-editor-sheet space-manager-sheet", label: t("spManage"),
    canClose: async () => !busy && (!dirty() || await discard()), onClose: () => { closed = true; window.removeEventListener("ox-schedules-changed", schedulesChanged); } });
  const body = h("div", { className: "sheet-body space-manager-body", "data-testid": "space-manager-body" });
  const status = h("div", { className: "space-form-status", role: "status", "aria-live": "polite", "data-testid": "space-manager-status" });
  const tabs: { id: Tab; key: StringKey }[] = [{ id: "placement", key: "spPlacement" }, { id: "data", key: "spData" },
    { id: "connections", key: "spConnections" }, { id: "updates", key: "spUpdates" }];
  const nav = h("div", { className: "space-manager-tabs", role: "tablist", "aria-label": t("spManage") });
  const here = () => !closed && view.dialog.isConnected;
  const fail = (error: unknown) => {
    if (!here()) return;
    const uncertain = error instanceof TypeError || error instanceof APIError && error.status >= 500;
    status.replaceChildren(h("p", { className: "form-error", role: "alert", "data-testid": uncertain ? "space-manager-unknown" : "space-manager-error" }, uncertain ? t("spManagerUnknown") : describe(error)),
      ...(uncertain || error instanceof APIError && error.status === 409 ? [button(t("spReload"), "space-manager-reload", () => void reload(true))] : []));
  };
  const lock = (value: boolean) => {
    busy = value; view.dialog.setAttribute("aria-busy", String(value));
    view.dialog.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("button,input,select,textarea").forEach(control => { control.disabled = value || control.dataset.unavailable === "true"; });
  };
  async function run(work: () => Promise<void>) {
    if (busy) return;
    const active = document.activeElement instanceof HTMLElement ? document.activeElement.dataset.testid : undefined, scroll = body.scrollTop;
    lock(true); status.replaceChildren(note(t("spSaving")));
    try { await work(); if (here()) { status.replaceChildren(note(t("saved"), "space-manager-saved")); dirty = () => false; } }
    catch (error) { fail(error); }
    finally {
      if (here()) {
        lock(false); body.scrollTop = scroll;
        if (active) view.dialog.querySelector<HTMLElement>(`[data-testid="${CSS.escape(active)}"]`)?.focus({ preventScroll: true });
      }
    }
  }
  async function reload(confirm = false) {
    if (busy || confirm && dirty() && !await discard()) return;
    const generation = ++serial;
    body.replaceChildren(h("div", { className: "page-loading", role: "status", "data-testid": "space-manager-loading" }, h("span", { className: "spinner" }), t("spLoading")));
    status.replaceChildren();
    try {
      const current = await request<Resources>(`${base}/resources`);
      if (!here() || generation !== serial) return;
      resource = current; dirty = () => false; await draw();
    } catch (error) {
      if (here() && generation === serial) body.replaceChildren(h("p", { className: "form-error", role: "alert", "data-testid": "space-manager-read-error" }, describe(error)),
        button(t("museRetry"), "space-manager-retry", () => void reload()));
    }
  }
  async function select(next: Tab) {
    if (busy || next === tab || dirty() && !await discard()) return;
    tab = next; dirty = () => false; status.replaceChildren(); await draw();
    nav.querySelector<HTMLButtonElement>(`[data-testid="space-tab-${tab}"]`)?.focus();
  }
  function drawTabs() {
    nav.replaceChildren(...tabs.map((item, index) => h("button", { type: "button", role: "tab", className: item.id === tab ? "selected" : "",
      "aria-selected": String(item.id === tab), tabindex: item.id === tab ? 0 : -1, "data-testid": `space-tab-${item.id}`, onclick: () => void select(item.id),
      onkeydown: (event: Event) => {
        if (!(event instanceof KeyboardEvent)) return;
        const next = event.key === "ArrowRight" ? (index + 1) % tabs.length : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length
          : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : null;
        if (next !== null) { event.preventDefault(); void select(tabs[next]!.id); }
      } }, t(item.key))));
  }
  async function fresh() { resource = await request<Resources>(`${base}/resources`); }
  async function draw() {
    if (!resource || !here()) return;
    const currentTab = tab; drawTabs(); body.replaceChildren();
    body.append(note(resource.space.name), h("details", { className: "space-source-details" }, h("summary", {}, t("spSourceDetails")),
      h("p", {}, resource.entry.path), h("code", {}, resource.entry.fileId), h("code", {}, resource.entry.sha256)));
    if (tab === "placement") placement();
    else if (tab === "data") data();
    else {
      const loading = h("div", { className: "page-loading", role: "status", "data-testid": "space-section-loading" }, h("span", { className: "spinner" }), t("spLoading"));
      body.append(loading);
      try { if (tab === "connections") await connections(); else await updates(); }
      catch (error) {
        if (here() && tab === currentTab) body.append(h("p", { className: "form-error", role: "alert", "data-testid": "space-section-error" }, describe(error)),
          button(t("museRetry"), "space-section-retry", () => void draw()));
      } finally { loading.remove(); }
    }
  }
  function placement() {
    const space = resource!.space, placement = h("select", { className: "field", "data-testid": "space-placement" },
      ...([["sidebar", "spSidebar"], ["main", "spMainTabs"], ["hidden", "spHidden"]] as const).map(([value, key]) => h("option", { value }, t(key))));
    placement.value = space.placement ?? (space.pinned ? "sidebar" : "hidden");
    const order = field("space-order", { type: "number", min: 0, max: 499, step: 1, value: String(space.order ?? 499) });
    const zone = field("space-visibility-zone", { value: space.visibility?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone, maxlength: 100, autocapitalize: "off", spellcheck: "false" });
    const always = field("space-visibility-always", { type: "checkbox", checked: !space.visibility?.windows.length, "aria-label": t("spAlways") });
    let windows = structuredClone(space.visibility?.windows ?? []) as SpaceVisibility["windows"];
    const list = h("div", { className: "space-window-list" }), read = () => ({
      placement: placement.value, order: Number(order.value), visibility: { timeZone: zone.value, windows: always.checked ? [] : windows },
    });
    const initial = JSON.stringify(read()); dirty = () => JSON.stringify(read()) !== initial;
    const drawWindows = () => {
      list.replaceChildren(); zone.disabled = always.checked; list.hidden = always.checked;
      windows.forEach((window, index) => {
        const days = new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" });
        const start = field(`space-window-start-${index}`, { type: "time", value: window.start, required: true, oninput: () => { window.start = start.value; } });
        const end = field(`space-window-end-${index}`, { type: "time", value: window.end, required: true, oninput: () => { window.end = end.value; } });
        const from = field(`space-window-from-${index}`, { type: "date", value: window.from ?? "", oninput: () => { if (from.value) window.from = from.value; else delete window.from; } });
        const until = field(`space-window-until-${index}`, { type: "date", value: window.until ?? "", oninput: () => { if (until.value) window.until = until.value; else delete window.until; } });
        list.append(h("fieldset", { className: "space-window" }, h("legend", {}, t("spWindow", { count: index + 1 })),
          h("div", { className: "space-weekdays" }, ...[1, 2, 3, 4, 5, 6, 7].map(day => h("label", {},
            field(`space-window-day-${index}-${day}`, { type: "checkbox", checked: window.weekdays.includes(day), onchange: (event: Event) => {
              window.weekdays = (event.target as HTMLInputElement).checked ? [...window.weekdays, day].sort() : window.weekdays.filter(value => value !== day);
            } }), days.format(new Date(Date.UTC(2023, 0, day)))))),
          h("div", { className: "space-field-pair" }, label(t("spStart"), start), label(t("spEnd"), end)),
          h("div", { className: "space-field-pair" }, label(t("spFrom"), from), label(t("spUntil"), until)),
          button(t("remove"), `space-window-remove-${index}`, () => { windows.splice(index, 1); drawWindows(); })));
      });
      if (windows.length < 8) list.append(button(t("spAddWindow"), "space-window-add", () => { windows.push({ weekdays: [2, 3, 4, 5, 6], start: "09:00", end: "17:00" }); drawWindows(); }));
    };
    always.addEventListener("change", () => { if (!always.checked && !windows.length) windows = [{ weekdays: [2, 3, 4, 5, 6], start: "09:00", end: "17:00" }]; drawWindows(); });
    const form = h("form", { className: "space-settings-form", onsubmit: (event: Event) => {
      event.preventDefault(); void run(async () => { await request(base, { method: "PATCH", json: { expectedRevision: space.revision, ...read() } }); await fresh(); placement.dataset.saved = "true"; });
    } }, label(t("spPlacement"), placement), label(t("spOrder"), order), note(t("spVisibilityHint")),
      h("label", { className: "space-check-row" }, always, t("spAlways")), label(t("spZone"), zone), list,
      h("div", { className: "space-actions" }, button(t("spReload"), "space-placement-reload", () => void reload(true)),
        h("button", { type: "submit", className: "button primary", "data-testid": "space-placement-save" }, t("save"))));
    drawWindows(); body.append(form);
  }
  function data() {
    const { space, dataFiles } = resource!, grant = space.dataGrants?.find(grant => grant.slot === "default");
    body.append(note(t("spSourceHint")));
    if (grant) body.append(h("div", { className: "space-source-card", "data-testid": "space-data-grant" },
      h("strong", {}, t(grant.access === "readWrite" ? "spReadWrite" : "spReadOnly")), h("code", {}, grant.fileId),
      note(grant.entrySha256 === resource!.entry.sha256 ? t("spGranted") : t("spDataChanged")),
      h("div", { className: "space-actions" }, button(t("spOpenNotes"), "space-open-notes", () => openSpaceNotes(id, "default", grant.access === "read", request)),
        button(t("spRevoke"), "space-data-revoke", () => { void (async () => {
          if (await ask({ title: t("spRevoke"), message: t("spRevokeBody"), confirm: t("spRevoke"), destructive: true }) !== "confirm") return;
          await run(async () => { await request(`${base}/data/default`, { method: "DELETE", json: { expectedRevision: space.revision } }); await fresh(); dataRedraw(); });
        })(); }))));
    else body.append(note(t("spNoData"), "space-data-empty"));
    const source = h("select", { className: "field", "data-testid": "space-data-source" }, h("option", { value: "" }, t("spChooseData")),
      ...dataFiles.map(file => h("option", { value: file.id }, file.path)));
    const access = h("select", { className: "field", "data-testid": "space-data-access" },
      h("option", { value: "readWrite" }, t("spReadWrite")), h("option", { value: "read" }, t("spReadOnly")));
    const path = field("space-data-path", { value: `artifacts/space-${id}.json`, maxlength: 4096, autocapitalize: "off", spellcheck: "false" });
    body.append(h("div", { className: "space-settings-form" }, label(t("spDataPath"), path),
      button(t("spCreateData"), "space-data-create", () => void run(async () => {
        await request(`/api/files/content?path=${encodeURIComponent(path.value)}`, { method: "PUT",
          body: JSON.stringify({ version: 1, revision: 0, data: { notes: "", items: [] }, receipts: [], updatedAt: null, source: null }) });
        const created = path.value; await fresh(); dataRedraw();
        const next = body.querySelector<HTMLSelectElement>('[data-testid="space-data-source"]');
        if (next) next.value = resource!.dataFiles.find(file => file.path === created)?.id ?? "";
      })), label(t("spData"), source), label(t("spSources"), access),
      button(t("spGrant"), "space-data-grant-save", () => { void (async () => {
        const file = resource!.dataFiles.find(file => file.id === source.value);
        if (!file) { fail(new Error(t("spChooseData"))); return; }
        if (await ask({ title: t("spGrant"), message: t("spGrantBody", { path: file.path, scope: access.options[access.selectedIndex]!.text }), confirm: t("spGrant") }) !== "confirm") return;
        await run(async () => { await request(`${base}/data/default`, { method: "PUT", json: { expectedRevision: resource!.space.revision,
          fileId: file.id, sourceRevision: file.sha256, entrySha256: resource!.entry.sha256, access: access.value, confirm: true } }); await fresh(); dataRedraw(); });
      })(); }, true)));
  }
  function dataRedraw() { body.replaceChildren(); dirty = () => false; void draw(); }
  async function connections() {
    const inventory = await request<{ connectors: { domain: string; name: string; status: { connected: boolean; state: string } }[] }>("/api/connectors");
    if (!here() || tab !== "connections") return;
    body.append(note(t("spConnectionHint")), h("a", { href: "#/settings/connectors", className: "button secondary", "data-testid": "space-connector-settings",
      onclick: () => view.close() }, t("spConnections")));
    if (!inventory.connectors.length) body.append(note(t("spNoConnectors"), "space-connections-empty"));
    for (const connector of inventory.connectors) {
      const granted = resource!.space.connections?.some(grant => grant.domain === connector.domain);
      body.append(h("div", { className: "space-source-card", "data-testid": `space-connection-${connector.domain}` }, h("strong", {}, connector.name),
        note(`${connector.domain} · ${hostText(connector.status.state)} · ${t(granted ? "spGranted" : "spNotGranted")}`),
        button(t(granted ? "spRevoke" : "spGrant"), `space-connection-grant-${connector.domain}`, () => { void (async () => {
          try {
            const detail = await request<any>(`/api/connectors/${encodeURIComponent(connector.domain)}`);
            if (!granted && !detail.spaceGrant?.connected) { fail(new Error(t("spVerifyFirst"))); return; }
            if (await ask({ title: t(granted ? "spRevoke" : "spGrant"), message: t("spConnectionHint"), confirm: t(granted ? "spRevoke" : "spGrant"), destructive: granted }) !== "confirm") return;
            await run(async () => {
              const { domain: _domain, connected: _connected, verifiedAt: _verified, ...proof } = detail.spaceGrant;
              await request(`${base}/connections/${encodeURIComponent(connector.domain)}`, { method: granted ? "DELETE" : "PUT", json: {
                expectedRevision: resource!.space.revision, entrySha256: resource!.entry.sha256, ...(granted ? {} : { ...proof, confirm: true }),
              } }); await fresh(); await draw();
            });
          } catch (error) { fail(error); }
        })(); })));
    }
  }
  async function updates() {
    const [state, settings] = await Promise.all([request<{ schedules: (ScheduleRow & { space?: { id: string }; lastCommit?: { at: string; revision: number; fileId: string } | null })[] }>("/api/schedules"),
      request<{ providers: { configured: boolean; models: unknown[] }[] }>("/api/settings")]);
    if (!here() || tab !== "updates") return;
    body.append(note(t("spUpdateHint")));
    if (!settings.providers.some(provider => provider.configured && provider.models.length)) body.append(note(t("spNoModel"), "space-updates-no-model"));
    const tasks = state.schedules.filter(schedule => schedule.space?.id === id), writable = resource!.space.dataGrants?.some(grant =>
      grant.slot === "default" && grant.access === "readWrite" && grant.entrySha256 === resource!.entry.sha256);
    if (!tasks.length) body.append(note(t("spNoUpdates"), "space-updates-empty"));
    for (const task of tasks) body.append(h("div", { className: "space-source-card", "data-testid": `space-update-${task.id}` },
      scheduleListRow(task, () => void draw(), { protectDraft: true }), note(task.lastCommit
        ? t("spLastCommit", { time: when(task.lastCommit.at), revision: task.lastCommit.revision }) : t("spNoCommit"), `space-update-proof-${task.id}`),
      task.lastCommit ? h("code", {}, task.lastCommit.fileId) : null,
      button(t("moreOptions"), `space-update-details-${task.id}`, () => openScheduleDetails(task.id, task.name, () => void draw(), true))));
    const create = button(t("spNewUpdate"), "space-update-create", () => { void editSchedule(undefined, true, {
      id, slot: "default", expectedRevision: resource!.space.revision, entrySha256: resource!.entry.sha256,
    }).then(() => draw()).catch(fail); }, true);
    create.disabled = !writable; create.dataset.unavailable = String(!writable);
    body.append(create); if (!writable) body.append(note(t("spNoData")));
  }
  const schedulesChanged = () => { if (tab === "updates" && here() && !busy && !document.querySelector('[data-testid="schedule-editor"]')) void draw(); };
  window.addEventListener("ox-schedules-changed", schedulesChanged);
  view.dialog.append(h("div", { className: "sheet-head" }, h("h2", { className: "sheet-title" }, t("spManage")),
    h("button", { type: "button", className: "icon-button", "aria-label": t("close"), "data-testid": "space-manager-close", onclick: () => void view.attempt() }, icon("close"))),
    nav, body, status);
  void reload();
}

function openSpaceNotes(id: string, slot: string, readonly: boolean, request: ReturnType<typeof originalAPI>) {
  const base = `/api/spaces/${encodeURIComponent(id)}/data/${slot}`, key = `ox.space.data.request.${id}.${slot}`;
  type Pending = { requestId: string; sourceRevision: string; fingerprint: string };
  let snapshot: SpaceDataSnapshot | undefined, items: SpaceNotes["items"] = [], baseline = "", busy = false, closed = false, pending: Pending | undefined;
  try { const stored = JSON.parse(sessionStorage.getItem(key) ?? "null"); if (stored && typeof stored.requestId === "string" && typeof stored.fingerprint === "string" && typeof stored.sourceRevision === "string") pending = stored; } catch {}
  const notes = h("textarea", { className: "field", rows: 6, maxlength: 32000, "aria-label": t("spNotes"), "data-testid": "space-notes" });
  const list = h("div", { className: "space-checklist", "data-testid": "space-checklist" }), item = field("space-item-text", { maxlength: 500, "aria-label": t("spItemText") });
  const status = h("div", { className: "space-form-status", role: "status", "aria-live": "polite", "data-testid": "space-data-status" });
  const body = h("div", { className: "sheet-body space-manager-body" }), read = () => ({ notes: notes.value, items });
  const changed = () => !!snapshot && JSON.stringify(read()) !== baseline;
  const view = sheet({ testID: "space-data-editor", className: "todo-editor-sheet space-manager-sheet", label: t("spOpenNotes"),
    canClose: async () => !busy && (!changed() || await discard()), onClose: () => { closed = true; } });
  const here = () => !closed && view.dialog.isConnected;
  const setStatus = (text: string, error = false, testID = "space-data-message") => { if (here()) status.replaceChildren(h("p", { className: error ? "form-error" : "muted small", role: error ? "alert" : "status", "data-testid": testID }, text)); };
  const forget = () => { pending = undefined; sessionStorage.removeItem(key); };
  const sync = () => {
    notes.readOnly = readonly || busy; item.disabled = readonly || busy;
    save.disabled = readonly || busy || !!pending || !snapshot;
    verify.hidden = !pending; verify.disabled = busy; reload.disabled = busy;
    view.dialog.setAttribute("aria-busy", String(busy));
    body.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input,button").forEach(control => { control.disabled = readonly || busy; });
  };
  const drawItems = () => {
    list.replaceChildren(...items.map((entry, index) => {
      const text = field(`space-item-${index}`, { value: entry.text, maxlength: 500, "aria-label": t("spItemText"), oninput: () => { entry.text = text.value; } });
      return h("div", { className: "space-check-row" },
        field(`space-item-check-${index}`, { type: "checkbox", checked: entry.checked, "aria-label": entry.text, onchange: (event: Event) => { entry.checked = (event.target as HTMLInputElement).checked; } }),
        text, h("button", { type: "button", className: "icon-button", "aria-label": t("remove"), "data-testid": `space-item-remove-${index}`,
          onclick: () => { items.splice(index, 1); drawItems(); sync(); } }, icon("close", 18)));
    }));
    if (!items.length) list.append(note(t("spNoItems"), "space-checklist-empty"));
  };
  async function load(confirm = false) {
    if (busy || confirm && changed() && !await discard()) return;
    busy = true; sync(); setStatus(t("spLoading"), false, "space-data-loading");
    try {
      const current = await request<SpaceDataSnapshot>(`${base}/read`);
      if (!here()) return;
      snapshot = current; notes.value = current.data.notes; items = structuredClone(current.data.items); baseline = JSON.stringify(read());
      drawItems();
      body.replaceChildren(note(current.path, "space-data-source-path"), note(current.updatedAt
        ? `${t(current.source?.kind === "schedule" ? "spScheduledSource" : "spSavedSource")} · ${when(current.updatedAt)} · r${current.revision}`
        : t("spNeverUpdated"), "space-data-source-time"), ...(readonly ? [note(t("spReadOnlyHint"))] : []),
        label(t("spNotes"), notes), h("h3", {}, t("spChecklist")), list,
        h("div", { className: "space-check-row" }, label(t("spItemText"), item), button(t("spAddItem"), "space-item-add", () => {
          if (!item.value.trim() || items.length >= 200) { setStatus(t("spValidation"), true); return; }
          items.push({ id: crypto.randomUUID(), text: item.value.trim(), checked: false }); item.value = ""; drawItems(); sync();
        })));
      if (confirm) forget();
      setStatus(pending ? t("spUnknown") : "", !!pending, pending ? "space-data-unknown" : "space-data-ready");
    } catch (error) {
      if (here()) { setStatus(describe(error), true, "space-data-read-error"); if (!snapshot) body.replaceChildren(button(t("museRetry"), "space-data-read-retry", () => void load())); }
    } finally { busy = false; if (here()) sync(); }
  }
  const reload = button(t("spReload"), "space-data-reload", () => void load(true));
  const verify = button(t("spVerify"), "space-data-verify", () => { void (async () => {
    if (!pending || busy) return;
    busy = true; sync();
    try {
      const proof = await request<{ inputApplied: boolean; fingerprint: string; sourceRevision: string }>(`${base}/requests/${pending.requestId}`);
      if (!here()) return;
      const matches = proof.fingerprint === pending.fingerprint && proof.sourceRevision === pending.sourceRevision && await fingerprint(read()) === pending.fingerprint;
      setStatus(proof.inputApplied && matches ? t("spVerified") : t("spHistorical"), !proof.inputApplied || !matches, proof.inputApplied && matches ? "space-data-verified" : "space-data-historical");
      if (proof.inputApplied && matches) { snapshot = await request<SpaceDataSnapshot>(`${base}/read`); baseline = JSON.stringify(read()); forget(); }
    } catch (error) { setStatus(error instanceof APIError && error.status === 404 ? t("spNoProof") : describe(error), true, "space-data-proof-error"); }
    finally { busy = false; if (here()) sync(); }
  })(); });
  const save = button(t("save"), "space-data-save", () => { void (async () => {
    if (busy || readonly || pending || !snapshot) return;
    if (items.some(entry => !entry.text.trim())) { setStatus(t("spValidation"), true); return; }
    const data = structuredClone(read()), attempt = { requestId: crypto.randomUUID(), sourceRevision: snapshot.sourceRevision, fingerprint: await fingerprint(data) };
    busy = true; sync(); setStatus(t("spSaving"));
    try {
      pending = attempt; sessionStorage.setItem(key, JSON.stringify(attempt));
      const result = await request<{ inputApplied: boolean; snapshot: SpaceDataSnapshot }>(`${base}/write`, {
        method: "POST", json: { requestId: attempt.requestId, sourceRevision: attempt.sourceRevision, data, confirm: true },
      });
      if (!here()) return;
      if (!result.inputApplied) { setStatus(t("spHistorical"), true, "space-data-historical"); return; }
      snapshot = result.snapshot; baseline = JSON.stringify(read()); forget(); setStatus(t("saved"), false, "space-data-saved"); toast(t("saved"));
      const source = body.querySelector('[data-testid="space-data-source-time"]');
      if (source && snapshot.updatedAt) source.textContent = `${t(snapshot.source?.kind === "schedule" ? "spScheduledSource" : "spSavedSource")} · ${when(snapshot.updatedAt)} · r${snapshot.revision}`;
    } catch (error) {
      if (error instanceof APIError && error.status < 500) { forget(); setStatus(error.status === 409 ? t("spConflict") : describe(error), true, error.status === 409 ? "space-data-conflict" : "space-data-error"); }
      else setStatus(t("spUnknown"), true, "space-data-unknown");
    } finally { busy = false; if (here()) sync(); }
  })(); }, true);
  view.dialog.append(h("div", { className: "sheet-head" }, h("h2", { className: "sheet-title" }, t("spOpenNotes")),
    h("button", { type: "button", className: "icon-button", "aria-label": t("close"), "data-testid": "space-data-close", onclick: () => void view.attempt() }, icon("close"))),
    body, status, h("div", { className: "personal-form-actions space-data-actions" }, reload, verify, save));
  void load();
}

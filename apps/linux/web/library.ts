import type { LibraryCategory, LibraryItem, Space } from "@openox/agent/linux";
import { api, APIError, ask, clearInfoToasts, deferRefreshWhileDialogOpen, failed, formDialog, getContentEpoch, menu, relativeTime, returnFocus, sheet, toast, type MenuItem } from "./client";
import { keepFocus, type PageHost } from "./capabilities";
import { h, icon, type IconName } from "./dom";
import { fileEmbed, fileIcon, fileURL, openFile } from "./file-viewer";
import { hostText, t, type StringKey } from "./i18n";
import { manageSpace } from "./space-settings";
import { fileRemovalInput, fileRemovalLimits, sameRemovalScope, type FileRemovalReceipt, type FileRemovalRequest, type FileRemovalScope, type FileRemovalTarget } from "../../../packages/agent/src/profile/file-removal";

export type LibrarySection = "spaces" | LibraryCategory;
type FileRow = LibraryItem & { removal?: FileRemovalTarget };
type Row = Space | FileRow;
type RemovalCapability = FileRemovalScope & { available: true; limits: typeof fileRemovalLimits };
type Listing = { available: boolean; total: number; nextCursor: string | null; items?: LibraryItem[]; spaces?: Space[] };
const sections: { id: LibrarySection; label: StringKey; glyph: IconName }[] = [
  { id: "spaces", label: "librarySpaces", glyph: "globe" }, { id: "documents", label: "libraryDocuments", glyph: "file" },
  { id: "images", label: "libraryImages", glyph: "image" }, { id: "videos", label: "libraryVideos", glyph: "play" },
  { id: "podcasts", label: "libraryPodcasts", glyph: "speaker" }, { id: "system", label: "librarySystem", glyph: "folder" },
];
export const isLibrarySection = (value: string): value is LibrarySection => sections.some(section => section.id === value);
const queries = new Map<LibrarySection, string>(), sorts = new Map<LibrarySection, "name" | "modified">();
let generation = 0, searchTimer: ReturnType<typeof setTimeout> | undefined, refreshTimer: ReturnType<typeof setTimeout> | undefined;
let active: { context: PageHost; lifetime: AbortController; refresh(): void; busy(): boolean } | undefined;
const describe = (error: unknown) => error instanceof TypeError && error.message === "Failed to fetch" ? t("requestResultUnavailable") : hostText(error instanceof Error ? error.message : String(error));
const spaceRow = (row: Row): row is Space => "fileId" in row;
const removalTarget = (value: unknown): value is FileRemovalTarget => {
  const file = value as FileRemovalTarget | null;
  return !!file && typeof file === "object" && Object.keys(file).length === 5 && typeof file.id === "string" && file.id.startsWith("file-") && file.id.length <= 512
    && typeof file.path === "string" && file.path.length > 0 && file.path.length <= 4_096 && Number.isSafeInteger(file.size) && file.size >= 0
    && typeof file.sha256 === "string" && /^[a-f0-9]{64}$/.test(file.sha256) && typeof file.revision === "string" && file.revision.length > 0 && file.revision.length <= 256;
};
async function removalCapability() {
  let value: RemovalCapability;
  try { value = await api<RemovalCapability>("/api/files/removals"); }
  catch (error) { if (error instanceof APIError && error.status === 404) return undefined; throw error; }
  return value?.available === true && value.version === 1 && Object.keys(value).length === 7
    && typeof value.hostId === "string" && value.hostId.length > 0 && value.hostId.length <= 160
    && typeof value.profileId === "string" && typeof value.callerId === "string" && value.profileId.length === 36 && value.callerId.length === 36
    && Number.isSafeInteger(value.epoch) && value.epoch === getContentEpoch() && !!crypto.subtle
    && value.limits && Object.keys(value.limits).length === Object.keys(fileRemovalLimits).length
    && Object.entries(fileRemovalLimits).every(([key, limit]) => value.limits[key as keyof typeof fileRemovalLimits] === limit) ? value : undefined;
}
const checkedRows = (rows: Row[], capability: RemovalCapability | undefined) => !!capability && rows.length <= capability.limits.files
  && rows.every(row => !spaceRow(row) && removalTarget(row.removal) && row.removal.path === row.path && row.removal.size === row.size && row.removal.sha256 === row.sha256)
  && rows.reduce((sum, row) => sum + (!spaceRow(row) ? row.size ?? 0 : 0), 0) <= capability.limits.selectedBytes;
const removalConfirmed = (count: number) => t(count === 1 ? "libraryDeleteCheckedConfirmedOne" : "libraryDeleteCheckedConfirmed", { count });
async function removeOriginalFiles(rows: FileRow[], capability: RemovalCapability, here: () => boolean) {
  const input: FileRemovalRequest = { version: 1, hostId: capability.hostId, profileId: capability.profileId, callerId: capability.callerId,
    epoch: capability.epoch, requestId: crypto.randomUUID(), confirmed: true, files: rows.map(row => ({ ...row.removal! })) };
  const route = location.hash, current = () => here() && location.hash === route && getContentEpoch() === input.epoch;
  if (!checkedRows(rows, capability) || new TextEncoder().encode(JSON.stringify(input)).length > capability.limits.requestBytes) throw new Error(t("libraryFileDeleteUnavailable"));
  const fingerprint = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(fileRemovalInput(input))))]
    .map(byte => byte.toString(16).padStart(2, "0")).join("");
  if (!current()) return false;
  const matches = (value: unknown): value is FileRemovalReceipt => {
    const receipt = value as FileRemovalReceipt | null;
    return !!receipt && Object.keys(receipt).length === 9 && sameRemovalScope(receipt, input) && receipt.requestId === input.requestId && receipt.fingerprint === fingerprint
      && ["committed", "conflict"].includes(receipt.status) && Array.isArray(receipt.files) && receipt.files.length === input.files.length && receipt.files.every(removalTarget)
      && fileRemovalInput({ ...input, files: receipt.files }) === fileRemovalInput(input);
  };
  let phase: "ready" | "unknown" | "refused" | "committed" = "ready", checking = false;
  const committed = () => phase === "committed";
  const status = h("p", { className: "muted", role: "status", hidden: true, "data-testid": "library-file-remove-proof" });
  const confirm = () => inspect.closest("form")?.querySelector<HTMLButtonElement>('[data-testid="dialog-confirm"]');
  const inspect = h("button", { type: "button", className: "button secondary", hidden: true, "data-testid": "library-file-remove-inspect", onclick: async () => {
    if (checking || phase !== "unknown" || !current()) return;
    checking = true; inspect.disabled = true; status.hidden = false; status.textContent = t("personalLoading");
    try {
      const receipt = await api<unknown>(`/api/files/removals/${input.requestId}?${new URLSearchParams({
        profileId: input.profileId, epoch: String(input.epoch), fingerprint,
      })}`);
      if (!current()) return;
      if (!matches(receipt)) throw new Error(t("personalDataInvalid"));
      phase = receipt.status === "committed" ? "committed" : "refused";
      status.textContent = phase === "committed" ? removalConfirmed(rows.length) : t("libraryDeleteCheckedConflict");
      inspect.hidden = true;
      const error = inspect.closest("form")?.querySelector<HTMLElement>('[data-testid="dialog-error"]');
      if (error) error.hidden = true;
      const button = confirm();
      if (button && phase === "committed") { button.hidden = false; button.textContent = t("done"); button.focus(); }
    } catch (error) {
      if (current()) status.textContent = t(error instanceof APIError && error.status === 404 ? "libraryDeleteCheckedMissing" : "libraryDeleteCheckedUnknown");
    } finally { checking = false; inspect.disabled = false; }
  } }, t("mrCheckResult"));
  const completed = await formDialog({ title: t("libraryRemoveSelected"), message: t("libraryDeleteCheckedBody"), confirm: t("remove"), destructive: true,
    testID: "library-file-remove-dialog", protectDraft: true,
    content: h("div", {}, h("ul", { className: "space-removal-scope", "data-testid": "library-removal-scope" },
      ...rows.map(row => h("li", {}, h("strong", {}, row.name), h("p", { className: "muted small" }, row.path)))), status, inspect),
    submit: async () => {
      if (!current()) throw new Error(t("libraryDeleteCheckedConflict"));
      if (phase === "committed") return;
      if (phase !== "ready" || checking) throw new Error(t("libraryDeleteCheckedUnknown"));
      phase = "unknown";
      try {
        const result = await api<{ receipt?: unknown }>("/api/files/removals", { method: "POST", json: input });
        if (!matches(result.receipt) || result.receipt.status !== "committed") throw new Error(t("personalDataInvalid"));
        phase = "committed";
      } catch (error) {
        phase = error instanceof APIError && error.status >= 400 && error.status < 500 && error.status !== 408 ? "refused" : "unknown";
        const button = confirm(); if (button) button.hidden = true;
        inspect.hidden = phase !== "unknown";
        throw new Error(t(phase === "refused" ? "libraryDeleteCheckedConflict" : "libraryDeleteCheckedUnknown"));
      }
    } });
  if (completed && committed() && current()) {
    return true;
  }
  return false;
}
const title = (section: LibrarySection) => t(sections.find(item => item.id === section)!.label);
export const libraryHash = (section: LibrarySection = "spaces") => `#/library/${section}`;
export const spaceHash = (id: string) => `#/spaces/${encodeURIComponent(id)}`;
function spaceWorkbenchLink(current: string, next: string) {
  const [chat, from] = location.hash.split("?");
  return chat && /^#\/create-space\/c\/\d+$/.test(chat) && from === `from=${encodeURIComponent(current)}`
    ? `${chat}?from=${encodeURIComponent(next)}` : next;
}
export function closeLibraryView() { generation++; clearTimeout(searchTimer); clearTimeout(refreshTimer); active?.lifetime.abort(); active = undefined; }
export function refreshLibrary() {
  const view = active;
  clearTimeout(refreshTimer);
  if (view?.context.main.isConnected && !view.busy()) refreshTimer = setTimeout(() => {
    if (active !== view || !view.context.main.isConnected || view.busy()) return;
    if (!deferRefreshWhileDialogOpen(refreshLibrary, view.lifetime.signal)) view.refresh();
  }, 100);
}
export function renderLibrarySidebar(element: HTMLElement, section: LibrarySection, open: () => void) {
  element.setAttribute("aria-label", t("museLibrary"));
  element.setAttribute("data-testid", "library-sidebar");
  const search = h("input", { type: "search", placeholder: t("museSearch"), "aria-label": t("librarySearch"), maxlength: 200,
    value: queries.get(section) ?? "", "data-testid": "library-search", oninput: () => {
      queries.set(section, search.value); clearTimeout(searchTimer); searchTimer = setTimeout(refreshLibrary, 150);
    } });
  const links = (start: number, end: number) => sections.slice(start, end).map(item => h("a", {
    href: libraryHash(item.id), className: `library-category${item.id === section ? " selected" : ""}`,
    "aria-current": item.id === section ? "page" : null, "data-testid": `library-category-${item.id}`, onclick: open,
  }, icon(item.glyph, 18), h("span", {}, t(item.label))));
  element.replaceChildren(h("div", { className: "library-search" }, h("label", {}, icon("search", 18), search)),
    h("nav", { className: "library-categories" }, h("div", { className: "library-group" }, h("h2", {}, t("files")), ...links(0, 2)),
      h("div", { className: "library-group media" }, h("h2", {}, t("libraryMedia")), ...links(2, 5)),
      h("div", { className: "library-system" }, ...links(5, 6))));
}

async function editSpace(source?: Space) {
  clearInfoToasts();
  let current = source, saving = false;
  const key = crypto.randomUUID();
  const name = h("input", { className: "field", maxlength: 200, required: true, "aria-label": t("spaceName"), "data-testid": "space-name" });
  const description = h("textarea", { className: "field", maxlength: 2_000, rows: 4, "aria-label": t("spaceDescription"), "data-testid": "space-description" });
  const entry = h("input", { className: "field", maxlength: 4_096, required: !source, "aria-label": t("spaceEntry"), "data-testid": "space-entry",
    placeholder: "artifacts/my-space.html", autocapitalize: "off", spellcheck: "false" });
  const values = () => ({ name: name.value, description: description.value, entryPath: entry.value });
  const populate = (item?: Space) => { name.value = item?.name ?? ""; description.value = item?.description ?? ""; entry.value = item?.entryPath ?? ""; };
  populate(current);
  let baseline = values();
  const edits = (draft: typeof baseline) => ({
    ...(draft.name.trim() !== baseline.name.trim() ? { name: draft.name } : {}),
    ...(draft.description !== baseline.description ? { description: draft.description } : {}),
    ...(draft.entryPath !== baseline.entryPath ? { entryPath: draft.entryPath } : {}),
  });
  const changed = () => Object.keys(edits(values())).length > 0;
  const beforeUnload = (event: BeforeUnloadEvent) => { if (saving || changed()) { event.preventDefault(); event.returnValue = ""; } };
  window.addEventListener("beforeunload", beforeUnload);
  const view = sheet({ testID: "space-editor", className: "todo-editor-sheet space-editor-sheet", label: t(source ? "spaceEdit" : "spaceRegister"),
    onClose: () => { window.removeEventListener("beforeunload", beforeUnload); refreshLibrary(); },
    canClose: async () => !saving && (!changed()
      || await ask({ title: t("discardChanges"), message: t("formCloseBody"), confirm: t("discard"), destructive: true }) === "confirm") });
  const error = h("p", { className: "form-error", role: "alert", hidden: true, "data-testid": "space-editor-error" });
  const progressLabel = h("span");
  const progress = h("p", { className: "dialog-progress muse-editor-progress", role: "status", hidden: true, "data-testid": "space-editor-progress" },
    h("span", { className: "spinner", "aria-hidden": "true" }), progressLabel);
  const lock = (busy: boolean, loading = false) => {
    saving = busy; view.dialog.setAttribute("aria-busy", String(busy)); progress.hidden = !busy; progressLabel.textContent = t(loading ? "personalLoading" : "personalSaving");
    view.dialog.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLButtonElement>("input,textarea,button").forEach(control => { control.disabled = busy; });
  };
  const reload = h("button", { type: "button", className: "button secondary", hidden: true, "data-testid": "space-editor-reload", onclick: async () => {
    if (!current || saving || changed() && await ask({ title: t("spaceReloadTitle"), message: t("spaceReloadBody"), confirm: t("todoReload") }) !== "confirm") return;
    lock(true, true);
    try { current = await api<Space>(`/api/spaces/${current.id}`); populate(current); baseline = values(); error.hidden = true; reload.hidden = true; }
    catch (failure) { error.textContent = describe(failure); error.hidden = false; }
    finally { lock(false); }
  } }, t("todoReload"));
  const label = (text: string, field: Node) => h("label", { className: "stack" }, h("span", { className: "label" }, text), field);
  const form = h("form", { className: "todo-editor-form", onsubmit: async (event: Event) => {
    event.preventDefault(); if (saving) return;
    const draft = values(), patch = edits(draft);
    if (current && !Object.keys(patch).length) { view.close(); return; }
    clearInfoToasts(); lock(true); error.hidden = true; reload.hidden = true;
    try {
      const body = current ? { expectedRevision: current.revision, ...patch } : draft;
      await api(current ? `/api/spaces/${current.id}` : "/api/spaces", { method: current ? "PATCH" : "POST",
        headers: current ? {} : { "idempotency-key": key }, json: body });
      baseline = values(); view.close(); toast(t("saved"));
    } catch (failure) {
      error.textContent = failure instanceof TypeError ? t(current ? "spaceEditUnknown" : "spaceCreateUnknown") : describe(failure);
      error.hidden = false; reload.hidden = !current || !(failure instanceof TypeError || failure instanceof APIError && (failure.status === 409 || failure.status === 408 || failure.status >= 500));
    } finally { lock(false); }
  } }, h("div", { className: "sheet-body space-editor-body" }, label(t("spaceName"), name), label(t("spaceDescription"), description),
    label(t("spaceEntry"), entry), h("p", { className: "muted small" }, t("spaceRegistrationScope"))), progress, error, reload,
    h("div", { className: "personal-form-actions" }, h("button", { type: "button", className: "button secondary", "data-testid": "space-editor-cancel",
      onclick: () => void view.attempt() }, t("cancel")), h("button", { type: "submit", className: "button primary", "data-testid": "space-save" }, t("save"))));
  view.dialog.append(h("div", { className: "sheet-head" }, h("h2", { className: "sheet-title" }, t(source ? "spaceEdit" : "spaceRegister")),
    h("button", { type: "button", className: "icon-button", "aria-label": t("close"), "data-testid": "space-editor-close", onclick: () => void view.attempt() }, icon("close"))), form);
  name.focus();
}
type Mutation = (work: () => Promise<unknown>, saved?: () => void) => Promise<void>;
async function removeSpaces(spaces: Space[], removed?: () => void, progress?: (id: string) => void) {
  const owner = active, version = generation, route = location.hash;
  const here = () => owner === active && version === generation && !!owner?.context.main.isConnected && route === location.hash;
  const { schedules } = await api<{ schedules: { id: string; name: string; space?: { id: string } }[] }>("/api/schedules");
  if (!here()) return;
  const ids = new Set(spaces.map(space => space.id)), dependencies = schedules.filter(schedule => schedule.space && ids.has(schedule.space.id));
  const remaining = new Map(spaces.map(space => [space.id, space])), paused = new Set<string>();
  let uncertain = false, inspecting = false;
  const range = h("ul", {}, ...spaces.map(space => h("li", {}, space.name)));
  const inspected = h("p", { className: "muted", role: "status", hidden: true, "data-testid": "space-remove-inspected" });
  const inspect = h("button", { type: "button", className: "button secondary", hidden: true, "data-testid": "space-remove-inspect", onclick: async () => {
    if (inspecting || !here()) return;
    inspecting = true; inspect.disabled = true; inspected.hidden = false; inspected.textContent = t("personalLoading");
    try {
      for (const [id, source] of remaining) {
        try {
          const current = await api<Space>(`/api/spaces/${id}`);
          if (current.revision !== source.revision) throw new Error(t("spaceRemoveChanged"));
        } catch (failure) {
          if (!(failure instanceof APIError && failure.status === 404)) throw failure;
          remaining.delete(id); progress?.(id);
        }
      }
      const current = await api<{ schedules: { id: string; state: string }[] }>("/api/schedules");
      for (const task of dependencies) if (!current.schedules.some(row => row.id === task.id && row.state !== "paused")) paused.add(task.id);
      uncertain = false; inspected.textContent = t("spaceRemoveInspected", { count: remaining.size });
      range.replaceChildren(...[...remaining.values()].map(space => h("li", {}, space.name)));
      const error = inspect.closest("form")?.querySelector<HTMLElement>('[data-testid="dialog-error"]');
      if (error) error.hidden = true;
      const confirm = inspect.closest("form")?.querySelector<HTMLButtonElement>('[data-testid="dialog-confirm"]');
      if (confirm) { confirm.hidden = false; confirm.textContent = t(remaining.size ? "remove" : "done"); }
      inspect.hidden = true;
    } catch (failure) { inspected.textContent = describe(failure); }
    finally { inspecting = false; inspect.disabled = false; }
  } }, t("mrCheckResult"));
  await formDialog({ title: t("spaceRemove"), message: t("spaceRemoveBody"), confirm: t("remove"), destructive: true,
    testID: "space-remove-dialog", protectDraft: true,
    content: h("div", { className: "space-removal-scope", "data-testid": "space-removal-scope" },
      range,
      ...(dependencies.length ? [h("p", { className: "muted" }, t("spBoundUpdates", { count: dependencies.length })),
        h("ul", {}, ...dependencies.map(task => h("li", {}, task.name)))] : []), inspected, inspect),
    fields: dependencies.length ? [{ name: "stop", label: t("spStopUpdates"), kind: "switch", checked: false, testID: "space-remove-stop-updates" }] : [],
    submit: async values => {
      if (uncertain || inspecting) throw new Error(t("spaceRemoveUnknown"));
      try {
        if (values.stop === true) for (const task of dependencies) if (!paused.has(task.id)) {
          await api(`/api/schedules/${task.id}`, { method: "PUT", json: { enabled: false } }); paused.add(task.id);
        }
        for (const space of remaining.values()) {
          await api(`/api/spaces/${space.id}`, { method: "DELETE", json: { expectedRevision: space.revision } });
          remaining.delete(space.id); progress?.(space.id);
        }
      } catch (failure) {
        range.replaceChildren(...[...remaining.values()].map(space => h("li", {}, space.name)));
        uncertain = !(failure instanceof APIError) || failure.status === 408 || failure.status >= 500;
        if (uncertain) {
          inspect.hidden = false;
          const confirm = inspect.closest("form")?.querySelector<HTMLButtonElement>('[data-testid="dialog-confirm"]');
          if (confirm) confirm.hidden = true;
        }
        throw new Error(uncertain ? t("spaceRemoveUnknown") : t("spaceRemovePartial", { count: spaces.length - remaining.size, reason: describe(failure) }));
      }
      if (here()) { removed?.(); refreshLibrary(); }
    } });
}
function spaceActions(space: Space, mutate: Mutation, removed?: () => void): MenuItem[] {
  return [
    { label: t(space.pinned ? "spaceUnpin" : "spacePin"), icon: "sidebar", testID: "space-menu-pin", run: () =>
      mutate(() => api(`/api/spaces/${space.id}`, { method: "PATCH", json: { expectedRevision: space.revision, pinned: !space.pinned } })) },
    { label: t("spaceEdit"), icon: "pencil", testID: "space-menu-edit", run: () => void editSpace(space).catch(failed) },
    { label: t("spaceRemove"), icon: "trash", destructive: true, testID: "space-menu-remove", run: () => void mutate(() => removeSpaces([space], removed)) },
  ];
}

export function renderLibrary(context: PageHost, section: LibrarySection, create: () => void, navigation?: Node) {
  closeLibraryView();
  const version = generation, here = () => version === generation && context.main.isConnected;
  let rows: Row[] = [], cursor: string | null = null, total = 0, selecting = false, saving = false, loading = false, loaded = false, issue = false, request = 0;
  const selected = new Set<string>();
  let capability: RemovalCapability | undefined;
  const page = h("div", { className: "muse-library-page", "data-testid": "library-page" });
  const heading = h("header", { className: "library-heading" }, navigation ?? null, h("h1", { "data-testid": "library-title" }, title(section)));
  const controls = h("div", { className: "library-controls" }), list = h("div", { className: "library-item-list", "data-testid": "library-item-list" });
  const status = h("div", { className: "library-status", "aria-live": "polite" }), continuation = h("div", { className: "library-continuation" });
  const unavailable = h("p", { className: "muted small", id: "library-file-delete-unavailable", role: "status",
    "data-testid": "library-file-delete-unavailable" }, t("libraryFileDeleteUnavailable"));
  page.append(heading, ...(section === "spaces" ? [h("h2", { className: "library-subheading" }, t("libraryAllSpaces"))]
    : section === "system" ? [] : [unavailable]), status, list, continuation);
  context.main.replaceChildren(page);
  active = { context, lifetime: new AbortController(), refresh: () => void load(), busy: () => saving || issue };
  const failure = (error: unknown, action = false) => { issue = true; status.replaceChildren(
    h("p", { className: "form-error", role: "alert", "data-testid": action ? "library-action-error" : "library-read-error" }, describe(error)),
    h("button", { type: "button", className: "button secondary", "data-testid": "library-retry", onclick: () => void load() }, t("museRetry"))); draw();
    if (!document.querySelector("dialog[open]") && (document.activeElement === document.body || page.contains(document.activeElement))) {
      status.querySelector<HTMLButtonElement>('[data-testid="library-retry"]')?.focus();
    }
  };
  const mutate: Mutation = async (work, saved) => {
    if (saving || issue) return;
    const focused = document.activeElement;
    clearInfoToasts(); saving = true; draw();
    status.replaceChildren(h("p", { className: "dialog-progress", role: "status", "data-testid": "library-action-progress" },
      h("span", { className: "spinner", "aria-hidden": "true" }), t("dialogSubmitting")));
    try { await work(); if (here()) { if (saved) saved(); else await load(); } }
    catch (error) {
      const failureReason = error instanceof TypeError || error instanceof APIError && (error.status === 408 || error.status >= 500) ? new Error(t("libraryActionUnknown")) : error;
      if (here()) failure(failureReason, true); else failed(failureReason);
    }
    finally {
      saving = false;
      if (here()) {
        draw();
        if (document.activeElement === document.body && !document.querySelector("dialog[open]")) {
          if (issue) status.querySelector<HTMLButtonElement>('[data-testid="library-retry"]')?.focus(); else returnFocus(focused);
        }
      }
    }
  };
  const removeSelected = async () => {
    const targets = rows.filter(row => selected.has(row.id));
    if (!targets.length || saving || issue) return;
    if (section === "spaces") {
      await mutate(() => removeSpaces(targets.filter(spaceRow), undefined, id => selected.delete(id)));
      return;
    }
    if (targets.some(row => !spaceRow(row) && !!row.path)) {
      if (!capability || !checkedRows(targets, capability)) { failed(new Error(t("libraryFileDeleteUnavailable"))); return; }
      const scope = capability;
      let removed = false;
      await mutate(async () => {
        removed = await removeOriginalFiles(targets.filter((row): row is FileRow => !spaceRow(row)), scope, here);
        if (removed) for (const row of targets) selected.delete(row.id);
      });
      if (removed && here() && getContentEpoch() === scope.epoch) status.replaceChildren(h("p", { className: "muted", role: "status",
        "data-testid": "library-file-remove-confirmed" }, removalConfirmed(targets.length)));
      return;
    }
    if (!await formDialog({ title: t("libraryRemoveSelected"), message: t("libraryDeleteBody"), testID: "dialog",
      content: h("ul", { className: "space-removal-scope", "data-testid": "library-removal-scope" },
        ...targets.map(row => h("li", {}, h("strong", {}, row.name), !spaceRow(row) && row.path ? h("p", { className: "muted small" }, row.path) : null))),
      confirm: t("remove"), destructive: true })) return;
    let done = 0;
    await mutate(async () => {
      try {
        for (const row of targets) {
          if (spaceRow(row)) await api(`/api/spaces/${row.id}`, { method: "DELETE", json: { expectedRevision: row.revision } });
          else if (row.path) throw new Error(t("libraryFileDeleteUnavailable"));
          else await api(`/api/library/podcasts/${encodeURIComponent(row.id)}`, { method: "PUT", json: { expectedRevision: row.tagRevision, podcast: false } });
          selected.delete(row.id); done++;
        }
      } catch (error) { throw new Error(t(error instanceof TypeError ? "libraryDeleteUnknown" : "libraryDeletePartial", { count: done, reason: describe(error) })); }
    });
  };
  function drawControls() {
    const restoreFocus = keepFocus(controls);
    const targets = rows.filter(row => selected.has(row.id));
    const fileDeletionUnavailable = targets.some(row => !spaceRow(row) && !!row.path) && !checkedRows(targets, capability);
    unavailable.hidden = !!capability && !fileDeletionUnavailable;
    const select = h("button", { type: "button", className: "button secondary", disabled: saving || issue || section === "system", "aria-pressed": String(selecting),
      "data-testid": "library-select", onclick: () => { selecting = !selecting; selected.clear(); draw(); } }, t(selecting ? "done" : "librarySelect"));
    const options = h("button", { type: "button", className: "icon-button library-options", disabled: saving || issue, "aria-label": t("librarySort"), "data-testid": "library-menu",
      onclick: () => menu(options, [
        { label: t("librarySortModified"), icon: "clock", testID: "library-sort-modified", run: () => { sorts.set(section, "modified"); void load(); } },
        { label: t("librarySortName"), icon: "file", testID: "library-sort-name", run: () => { sorts.set(section, "name"); void load(); } },
        { label: t("spaceRegister"), icon: "globe", testID: "library-register-existing", run: () => void editSpace().catch(failed) },
        { label: t("pageReload"), icon: "reload", testID: "library-refresh", run: () => void load() },
      ]) }, icon("sort", 20));
    controls.replaceChildren(select, options, selecting
      ? h("button", { type: "button", className: "button secondary", disabled: saving || issue || !selected.size || fileDeletionUnavailable,
        "aria-describedby": fileDeletionUnavailable ? "library-file-delete-unavailable" : null,
        "data-testid": "library-remove-selected", onclick: () => void removeSelected() },
        t("librarySelection", { count: selected.size }), icon("trash", 16))
      : h("button", { type: "button", className: "button primary", disabled: saving || issue, "data-testid": "library-create-space", onclick: create }, icon("plus", 18), t("museSpace")));
    if (!heading.contains(controls)) heading.append(controls);
    restoreFocus();
  }
  function draw() {
    const restoreFocus = keepFocus(page);
    page.setAttribute("aria-busy", String(saving || loading));
    drawControls();
    list.classList.toggle("spaces", section === "spaces");
    const checkbox = (row: Row) => selecting ? h("label", { className: "library-selection" },
      h("input", { type: "checkbox", checked: selected.has(row.id), disabled: saving || issue, "aria-label": t("librarySelectItem", { name: row.name }), "data-testid": `library-select-${row.id}`,
        onchange: (event: Event) => { if ((event.target as HTMLInputElement).checked) selected.add(row.id); else selected.delete(row.id); drawControls(); } })) : null;
    list.replaceChildren(...rows.map(row => {
      if (spaceRow(row)) {
        const options = h("button", { type: "button", className: "icon-button", disabled: saving || issue, "aria-label": `${t("moreOptions")}: ${row.name}`, "data-testid": `library-space-menu-${row.id}`,
          onclick: () => menu(options, spaceActions(row, mutate)) }, icon("more", 18));
        return h("article", { className: `library-space-card${row.missing ? " missing" : ""}` }, checkbox(row),
          h("button", { type: "button", className: "library-space-open", disabled: saving, "data-testid": `library-space-${row.id}`,
            onclick: () => { location.hash = spaceWorkbenchLink(libraryHash(), spaceHash(row.id)); } },
            h("div", { className: "library-space-preview", "aria-hidden": "true" }, icon(row.missing ? "warning" : "globe", 36)),
            h("strong", {}, row.name), h("span", {}, row.missing ? t("spaceMissing") : row.description || t("spaceArtifact"))), options);
      }
      const thumb = h("span", { className: "library-file-thumb", "aria-hidden": "true" });
      if (row.category === "images" && row.path && row.size !== null && row.size <= 2 * 1024 * 1024) {
        const image = h("img", { src: fileURL(row.path), alt: "", loading: "lazy", decoding: "async" });
        image.addEventListener("error", () => { thumb.replaceChildren(icon("image", 24)); }, { once: true }); thumb.append(image);
      } else thumb.append(icon(row.missing ? "warning" : fileIcon(row.path ?? row.name), 24));
      const options = h("button", { type: "button", className: "icon-button", disabled: saving || issue, "aria-label": `${t("moreOptions")}: ${row.name}`, "data-testid": `library-item-menu-${row.id}`,
        onclick: () => menu(options, [
          ...(row.path ? [{ label: t("open"), icon: "file" as const, run: () => openFile(row.path!) }] : []),
          ...(section !== "system" && /\.(mp3|wav|m4a|aac|ogg|opus|flac)$/i.test(row.name) ? [{ label: t(row.category === "podcasts" ? "libraryUntagPodcast" : "libraryTagPodcast"),
            icon: "speaker" as const, testID: "library-tag-podcast", run: () => mutate(() => api(`/api/library/podcasts/${encodeURIComponent(row.id)}`,
              { method: "PUT", json: { expectedRevision: row.tagRevision, podcast: row.category !== "podcasts" } })) }] : []),
        ]) }, icon("more", 18));
      return h("div", { className: "library-file-row" }, checkbox(row),
        h("button", { type: "button", className: "library-file-open", disabled: saving || row.missing, "data-testid": `library-item-open-${row.id}`,
          onclick: () => { if (row.path) openFile(row.path); } }, thumb, h("span", { className: "library-file-name" }, h("strong", {}, row.name),
          h("small", {}, row.missing ? t("spaceMissing") : [row.path, row.modified ? relativeTime(row.modified) : ""].filter(Boolean).join(" - ")))), options);
    }));
    if (!rows.length && !loading && !issue) list.append(h("p", { className: "muted library-empty", "data-testid": (queries.get(section) ?? "").trim() ? "library-no-matches" : "library-empty" },
      t((queries.get(section) ?? "").trim() ? "libraryNoMatches" : section === "spaces" ? "libraryEmptySpaces" : "libraryEmptyFiles")));
    continuation.replaceChildren(...(cursor ? [h("button", { type: "button", className: "button secondary", disabled: loading || saving || issue, "data-testid": "library-more",
      onclick: () => void load(true) }, t("libraryLoadMore", { count: rows.length, total }))] : []));
    restoreFocus();
  }
  async function load(append = false) {
    if (append && (loading || !cursor)) return;
    const current = ++request;
    loading = true; issue = false;
    page.setAttribute("aria-busy", "true");
    if (section === "spaces" && !loaded) {
      controls.replaceChildren(...["select", "sort", "create"].map(kind => h("span", { className: `library-loading-control ${kind}`, "aria-hidden": "true" })));
      if (!heading.contains(controls)) heading.append(controls);
    }
    continuation.querySelector<HTMLButtonElement>("button")?.setAttribute("disabled", "");
    const params = new URLSearchParams({ q: queries.get(section) ?? "", sort: sorts.get(section) ?? "modified", limit: "60" });
    if (section !== "spaces") params.set("category", section);
    if (append && cursor) params.set("cursor", cursor);
    status.replaceChildren(h("p", { className: "dialog-progress", role: "status", "data-testid": "library-loading" },
      h("span", { className: "spinner", "aria-hidden": "true" }), t("personalLoading")));
    try {
      const [state, removal] = await Promise.all([
        api<Listing>(`${section === "spaces" ? "/api/spaces" : "/api/library"}?${params}`),
        section === "spaces" || section === "system" ? undefined : removalCapability(),
      ]);
      if (!here() || current !== request) return;
      const received = section === "spaces" ? state.spaces : state.items;
      if (state.available !== true || !Array.isArray(received) || !Number.isSafeInteger(state.total) || state.total < 0
        || state.nextCursor !== null && typeof state.nextCursor !== "string") throw new Error(t("personalDataInvalid"));
      rows = append ? [...rows, ...received] : received; total = state.total; cursor = state.nextCursor; capability = removal;
      const ids = new Set(rows.map(row => row.id)); for (const id of selected) if (!ids.has(id)) selected.delete(id);
      status.replaceChildren(); loaded = true; loading = false; draw();
    } catch (error) { if (here() && current === request) failure(error); }
    finally { if (current === request) { loading = false; if (here()) page.setAttribute("aria-busy", String(saving)); } }
  }
  drawControls(); void load();
}

export function renderSpace(context: PageHost, id: string) {
  closeLibraryView();
  const version = generation, here = () => version === generation && context.main.isConnected;
  let saving = false, issue = false, request = 0, path: string | null | undefined;
  const page = h("div", { className: "muse-space-page", "data-testid": "space-page" });
  const heading = h("header", { className: "library-heading" }), status = h("div", { className: "library-status", "aria-live": "polite" });
  const canvas = h("div", { className: "muse-space-canvas", "data-testid": "space-canvas" });
  page.append(heading, status, canvas); context.main.replaceChildren(page);
  active = { context, lifetime: new AbortController(), refresh: () => void load(), busy: () => saving || issue };
  const mutate: Mutation = async (work, saved) => {
    if (saving || issue) return;
    const focused = document.activeElement;
    clearInfoToasts(); saving = true; page.setAttribute("aria-busy", "true");
    heading.querySelectorAll<HTMLButtonElement>("button").forEach(control => { control.disabled = true; });
    status.replaceChildren(h("p", { className: "dialog-progress", role: "status" }, h("span", { className: "spinner", "aria-hidden": "true" }), t("dialogSubmitting")));
    try { await work(); if (here()) { if (saved) saved(); else await load(); } }
    catch (error) {
      const failureReason = error instanceof TypeError || error instanceof APIError && (error.status === 408 || error.status >= 500) ? new Error(t("libraryActionUnknown")) : error;
      if (here()) showFailure(failureReason); else failed(failureReason);
    }
    finally {
      saving = false;
      if (here()) {
        page.setAttribute("aria-busy", "false");
        heading.querySelectorAll<HTMLButtonElement>("button").forEach(control => { control.disabled = issue || !!canvas.querySelector('[data-testid="space-missing"]') && control.dataset.testid !== "space-menu"; });
        if (document.activeElement === document.body && !document.querySelector("dialog[open]")) returnFocus(focused);
      }
    }
  };
  const showFailure = (error: unknown) => { issue = true; status.replaceChildren(
    h("p", { className: "form-error", role: "alert", "data-testid": "space-error" }, describe(error)),
    h("button", { type: "button", className: "button secondary", "data-testid": "space-retry", onclick: () => void load() }, t("museRetry")));
    heading.querySelectorAll<HTMLButtonElement>("button").forEach(control => { control.disabled = true; });
  };
  async function load() {
    const current = ++request;
    issue = false; page.setAttribute("aria-busy", "true");
    status.replaceChildren(h("p", { className: "dialog-progress", role: "status", "data-testid": "space-loading" },
      h("span", { className: "spinner", "aria-hidden": "true" }), t("personalLoading")));
    try {
      const space = await api<Space>(`/api/spaces/${id}`);
      if (!here() || current !== request) return;
      const options = h("button", { type: "button", className: "icon-button library-options", "aria-label": t("moreOptions"), "data-testid": "space-menu",
        onclick: () => menu(options, spaceActions(space, mutate, () => { location.hash = libraryHash(); })) }, icon("more"));
      const restoreFocus = keepFocus(heading);
      heading.replaceChildren(h("a", { href: libraryHash(), className: "icon-button", "aria-label": t("librarySpaces"), "data-testid": "space-back",
        onclick: (event: Event) => { (event.currentTarget as HTMLAnchorElement).href = spaceWorkbenchLink(spaceHash(id), libraryHash()); } }, icon("back")),
        h("h1", { "data-testid": "space-title" }, space.name), h("div", { className: "library-controls" },
          h("button", { type: "button", className: "button secondary", disabled: space.missing, "data-testid": "space-manage", onclick: () => manageSpace(space.id, () => {
            const restore = heading.contains(document.activeElement);
            heading.querySelectorAll<HTMLButtonElement>("button").forEach(button => { button.disabled = true; });
            void load().then(() => {
              if (!restore || !here() || document.activeElement !== document.body || document.querySelector("dialog[open]")) return;
              const control = heading.querySelector<HTMLButtonElement>('[data-testid="space-manage"]');
              (control && !control.disabled ? control : status.querySelector<HTMLButtonElement>('[data-testid="space-retry"]'))?.focus({ preventScroll: true });
            });
          }) }, t("spManage")),
          h("button", { type: "button", className: "icon-button library-options", "aria-label": t("pageReload"), disabled: space.missing, "data-testid": "space-refresh",
            onclick: () => { if (space.entryPath) canvas.replaceChildren(fileEmbed(space.entryPath, space.name, true)); } }, icon("reload")), options));
      status.replaceChildren();
      restoreFocus();
      if (path !== space.entryPath) {
        path = space.entryPath; page.dataset.path = path ?? "";
        canvas.replaceChildren(path ? fileEmbed(path, space.name, true) : h("div", { className: "space-missing", "data-testid": "space-missing" },
          icon("warning", 32), h("h2", {}, t("spaceMissing")), h("p", {}, t("spaceMissingBody")),
          h("button", { type: "button", className: "button secondary", "data-testid": "space-rebind", onclick: () => void editSpace(space).catch(failed) }, t("spaceEdit"))));
      } else if (path && canvas.firstElementChild instanceof HTMLElement && canvas.firstElementChild.dataset.title !== space.name) {
        canvas.firstElementChild.dataset.title = space.name;
      }
    } catch (error) { if (here() && current === request) showFailure(error); }
    finally { if (here() && current === request) page.setAttribute("aria-busy", String(saving)); }
  }
  void load();
}

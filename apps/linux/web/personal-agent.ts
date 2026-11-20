import type { InboxNotice, ProactiveConversation, Todo } from "@openox/agent/linux";
import { noticeConversationID, noticeTask } from "../../../packages/agent/src/adapters/linux/notice-target";
import { api, APIError, ask, failed, sheet, toast } from "./client";
import { keepFocus, openScheduleDetails, type PageHost } from "./capabilities";
import { h, icon, loader } from "./dom";
import { hostText, locale, t, type StringKey } from "./i18n";
import { closeReadNotifications, openNotifications } from "./notifications";

export type PersonalSummary = { available: false } | { available: true; unreadCount: number; limit: number; warning: string | null;
  conversationCounts?: { id: number; unreadCount: number }[] };
export type PersonalPage = "todos" | "inbox";
type TodoList = { available: boolean; todos: Todo[]; warning: string | null; limit: number };
export type NoticeList = { available: boolean; notifications: InboxNotice[]; unreadCount: number; warning: string | null; limit: number };
let version = 0;
let stopVisibility = () => {};
let taskFilter: "open" | "completed" | "all" = "open";
let noticeFilter: "all" | "unread" = "all";

export async function loadPersonalSummary(): Promise<PersonalSummary> {
  try {
    const result = await api<PersonalSummary>("/api/notifications?summary=1", { signal: AbortSignal.timeout(10_000) });
    if (result.available === false) return result;
    if (result.available !== true || !Number.isSafeInteger(result.unreadCount) || result.unreadCount < 0
      || !Number.isSafeInteger(result.limit) || result.limit < 1 || (result.warning !== null && typeof result.warning !== "string")) {
      throw new Error(t("personalDataInvalid"));
    }
    if (result.conversationCounts !== undefined && (!Array.isArray(result.conversationCounts)
      || result.conversationCounts.some(row => !Number.isSafeInteger(row.id) || row.id < 0 || !Number.isSafeInteger(row.unreadCount) || row.unreadCount < 1)
      || new Set(result.conversationCounts.map(row => row.id)).size !== result.conversationCounts.length
      || result.conversationCounts.reduce((sum, row) => sum + row.unreadCount, 0) > result.unreadCount)) throw new Error(t("personalDataInvalid"));
    return result;
  } catch (error) {
    if (error instanceof APIError && error.status === 404) return { available: false };
    throw error;
  }
}

export function closePersonalView() { version++; stopVisibility(); stopVisibility = () => {}; }
const dateText = (value: string, zone?: string | null) => new Date(value).toLocaleString(locale,
  { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", ...(zone ? { timeZone: zone, timeZoneName: "short" as const } : {}) });
const localInput = (milliseconds: number) => {
  const date = new Date(milliseconds), pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
};
const reminderText = (todo: Todo) => t(todo.reminder === "pending" ? "todoReminderPending" : todo.reminder === "queued" ? "todoReminderQueued" : "todoNoReminder");
const deliveryKeys: Record<InboxNotice["delivery"]["status"], StringKey> = {
  pending: "noticePending", sending: "noticeSending", accepted: "noticeAccepted", failed: "noticeFailed",
  unknown: "noticeUnknown", in_app: "noticeInApp", suppressed: "noticeSuppressed",
};
const retry = (run: () => void) => h("button", { type: "button", className: "button secondary", "data-testid": "personal-retry", onclick: run }, icon("reload", 16), t("personalRetry"));
const note = (text: string, testID?: string) => h("p", { className: "personal-note", ...(testID ? { "data-testid": testID } : {}) }, text);
const empty = (title: string, body: string, symbol: "check" | "inbox", testID: string) => h("div", { className: "personal-empty", "data-testid": testID },
  h("span", { className: "personal-empty-icon" }, icon(symbol, 28)), h("h2", {}, title), h("p", {}, body));

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export function validNotice(notice: InboxNotice) {
  const timestamp = (value: string | null) => value === null || typeof value === "string" && Number.isFinite(Date.parse(value));
  if (!notice || !uuid.test(notice.id) || typeof notice.targetUrl !== "string" || !notice.targetUrl.startsWith("/#/")
    || !notice.title || !notice.body || [notice.title.en, notice.title["zh-Hans"], notice.body.en, notice.body["zh-Hans"]].some(value => typeof value !== "string")
    || !timestamp(notice.readAt) || !timestamp(notice.cancelledAt) || typeof notice.createdAt !== "string" || !timestamp(notice.createdAt)
    || typeof notice.occurredAt !== "string" || !timestamp(notice.occurredAt) || !notice.delivery || !Object.hasOwn(deliveryKeys, notice.delivery.status)) {
    throw new Error(t("personalDataInvalid"));
  }
  return notice;
}
export async function loadNotices() {
  const result = await api<NoticeList>("/api/notifications", { signal: AbortSignal.timeout(10_000) });
  if (result.available !== true || !Array.isArray(result.notifications) || !Number.isSafeInteger(result.limit) || result.limit < 1
    || result.notifications.length > result.limit || !Number.isSafeInteger(result.unreadCount)
    || result.warning !== null && typeof result.warning !== "string") throw new Error(t("personalDataInvalid"));
  result.notifications.forEach(validNotice);
  if (result.unreadCount !== result.notifications.filter(notice => notice.readAt === null && notice.cancelledAt === null).length) throw new Error(t("personalDataInvalid"));
  return result;
}

export function personalConversation(value: ProactiveConversation | undefined, refresh: () => void): HTMLElement[] {
  if (!value) return [];
  if (value.status === "unavailable") return [h("div", { className: "proactive-feedback", role: "alert", "data-testid": "proactive-unavailable" },
    h("p", {}, t("pfUnavailable")), retry(refresh))];
  if (!Array.isArray(value.todos) || !Array.isArray(value.notices)) throw new Error(t("personalDataInvalid"));
  const plans = value.todos.map(todo => {
    const change = h("button", { type: "button", className: "button secondary small", "data-testid": "proactive-plan-edit",
      onclick: () => editTodo(todo, refresh, !!todo.plannedFor && todo.dueAt === null) }, t(todo.dueAt ? "pfEditTime" : "pfSetTime"));
    const cancel: HTMLButtonElement | null = todo.reminder === "pending" ? h("button", { type: "button", className: "button secondary small", "data-testid": "proactive-reminder-cancel", onclick: async () => {
      if (!cancel) return;
      cancel.disabled = true;
      try {
        await api(`/api/todos/${todo.id}`, { method: "PATCH", json: { expectedRevision: todo.revision, dueAt: null, timeZone: null, plannedFor: null } });
        toast(t("pfReminderCancelled")); refresh();
      } catch (error) { failed(error); }
      finally { cancel.disabled = false; }
    } }, t("pfCancelReminder")) : null;
    if (todo.reminder === "pending" && !todo.completed && todo.dueAt) {
      return h("article", { className: "proactive-card proactive-saved-plan", "data-testid": `proactive-plan-${todo.id}` },
        h("header", { className: "saved-plan-header" },
          h("span", { className: "saved-plan-badge", "aria-hidden": "true" }, icon("calendar", 30), icon("clock", 16)),
          h("div", {}, h("h3", {}, todo.title), h("span", { className: "saved-plan-status" }, t("pfReminderSet")))),
        h("time", { datetime: todo.dueAt }, t("pfReminderAt", { time: dateText(todo.dueAt, todo.timeZone) })),
        h("div", { className: "proactive-actions" }, change, cancel),
        h("a", { className: "button secondary proactive-view-reminder", href: `#/todos/${todo.id}`, "data-testid": "proactive-plan-open" }, t("pfViewReminder")));
    }
    return h("article", { className: "proactive-card", "data-testid": `proactive-plan-${todo.id}` },
      h("div", { className: "proactive-heading" }, icon("clock", 16), h("span", {}, t(todo.completed ? "done" : todo.reminder === "queued" ? "pfReminderQueued"
        : todo.dueAt ? "pfReminderSet" : todo.plannedFor ? "pfNoTime" : "todoNoReminder"))),
      h("h3", {}, todo.title), todo.dueAt ? h("p", { className: "proactive-meta" }, t("pfReminderAt", { time: dateText(todo.dueAt, todo.timeZone) }))
        : todo.plannedFor ? h("p", { className: "proactive-meta" }, t("pfPlannedDate", { date: todo.plannedFor.date, zone: todo.plannedFor.timeZone })) : null,
      !todo.completed ? h("div", { className: "proactive-actions" }, change, cancel) : null,
      todo.dueAt && !todo.completed ? h("p", { className: "proactive-meta" }, t("pfDeliveryNote")) : null);
  });
  const events = [...value.notices].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.id.localeCompare(b.id)).flatMap(notice => {
    validNotice(notice);
    const task = noticeTask(notice.tag);
    if (!task) return [];
    const todo = task.kind === "todo";
    return [h("article", { className: `proactive-card proactive-event${notice.cancelledAt ? " cancelled" : ""}`,
      "data-proactive-notice": notice.id, "data-testid": `proactive-notice-${notice.id}` },
    h("div", { className: "proactive-heading" }, icon(todo ? "clock" : "chat", 16), h("span", {}, t(todo ? "pfReminder" : "pfGoalUpdate")),
      h("span", { className: "proactive-read-state" }, t(notice.cancelledAt ? "noticeCancelled" : notice.readAt ? "noticeRead" : "noticeUnread"))),
    h("h3", {}, todo ? notice.body[locale] : notice.title[locale]),
    !todo ? h("p", { className: "proactive-body" }, notice.body[locale]) : null,
    h("p", { className: "proactive-meta" }, t(todo ? "pfReminderAt" : "pfUpdatedAt", { time: dateText(notice.occurredAt, Intl.DateTimeFormat().resolvedOptions().timeZone) })),
    todo && Date.parse(notice.createdAt) - Date.parse(notice.occurredAt) > 60_000 ? h("p", { className: "proactive-meta" }, t("pfNoticeLate")) : null,
    h("div", { className: "proactive-actions" }, h("button", { type: "button", className: "button secondary small", "data-testid": "proactive-notice-details",
      onclick: () => todo ? location.hash = `#/todos/${task.id}` : openScheduleDetails(task.id, notice.title[locale]) }, t("pfDetails"))))];
  });
  return [...(plans.length ? [h("section", { className: "proactive-group" }, h("h2", {}, t("pfPlans")), ...plans)] : []),
    ...(events.length ? [h("section", { className: "proactive-group" }, h("h2", {}, t("pfUpdates")), ...events)] : [])];
}

function noticeDetail(initial: InboxNotice, active: () => boolean, ready: () => boolean, openSource?: (notice: InboxNotice) => Promise<void>) {
  let selected = validNotice(initial), marking = false, attempted = false;
  const state = h("span", { className: "tag subtle", "data-testid": "notification-read-state" });
  const delivery = note("", "notification-delivery-state");
  const cancelled = note(t("noticeCancelled"), "notification-cancelled");
  const error = h("p", { className: "form-error", role: "alert", hidden: true, "data-testid": "notification-read-error" });
  const sourceError = h("p", { className: "form-error", role: "alert", hidden: true, "data-testid": "notification-source-error" });
  const readButton = h("button", { type: "button", className: "button secondary", "data-testid": "notification-mark-read", onclick: () => void mark() }, t("noticeMarkRead"));
  const recheck = h("button", { type: "button", className: "button secondary", hidden: true, "data-testid": "notification-read-recheck", onclick: () => void check() }, t("noticeCheckRead"));
  const update = (current: InboxNotice) => {
    validNotice(current);
    if (current.id !== selected.id) throw new Error(t("personalDataInvalid"));
    selected = current; state.textContent = t(selected.readAt ? "noticeRead" : "noticeUnread");
    delivery.textContent = t(openSource && selected.delivery.status === "in_app" ? "museAttentionInApp" : deliveryKeys[selected.delivery.status]); cancelled.hidden = selected.cancelledAt === null;
    readButton.hidden = selected.readAt !== null || selected.cancelledAt !== null || !recheck.hidden;
    if (selected.readAt !== null) { error.hidden = true; recheck.hidden = true; void closeReadNotifications([selected.id]); }
  };
  const showError = (failure: unknown, uncertain = false) => {
    if (selected.readAt !== null) return;
    error.textContent = `${uncertain ? `${t("noticeReadUnknown")} ` : ""}${hostText(failure instanceof Error ? failure.message : String(failure))}`;
    error.hidden = false; recheck.hidden = !uncertain; readButton.hidden = uncertain || selected.cancelledAt !== null;
  };
  const eligible = () => active() && ready() && navigator.onLine && document.visibilityState === "visible" && document.hasFocus() && state.isConnected;
  const check = async () => {
    if (!active() || marking) return;
    marking = true; recheck.disabled = true;
    try {
      const current = validNotice(await api<InboxNotice>(`/api/notifications/${selected.id}`, { signal: AbortSignal.timeout(10_000) }));
      if (!active()) return;
      recheck.hidden = true; update(current);
      if (current.readAt === null) showError(new Error(t("noticeReadUnconfirmed")));
    } catch (failure) { if (active()) showError(failure, true); }
    finally { marking = false; recheck.disabled = false; }
  };
  const mark = async () => {
    if (!eligible() || selected.readAt !== null || selected.cancelledAt !== null || marking || !recheck.hidden) return;
    attempted = true; marking = true; readButton.disabled = true;
    try {
      const current = validNotice(await api<InboxNotice>(`/api/notifications/${selected.id}/read`, { method: "PUT", json: {}, signal: AbortSignal.timeout(10_000) }));
      if (current.readAt === null) throw new Error(t("personalDataInvalid"));
      if (active()) update(current);
      await closeReadNotifications([selected.id]);
    } catch (failure) { if (active()) showError(failure, !(failure instanceof APIError) || failure.status >= 500); }
    finally { marking = false; readButton.disabled = false; }
  };
  const automatic = () => { if (!attempted) requestAnimationFrame(() => requestAnimationFrame(() => { if (!attempted) void mark(); })); };
  const source = openSource ? h("button", { type: "button", className: "button primary", "data-testid": "notification-open-source", onclick: async (event: Event) => {
    const button = event.currentTarget as HTMLButtonElement; button.disabled = true;
    try { await openSource(selected); }
    catch (failure) { if (active()) { sourceError.textContent = hostText(failure instanceof Error ? failure.message : String(failure)); sourceError.hidden = false; } }
    finally { button.disabled = false; }
  } }, t("noticeOpenSource")) : h("a", { href: selected.targetUrl, className: "button primary", "data-testid": "notification-open-source" }, t("noticeOpenSource"));
  const element = h("article", { className: "group personal-detail", "data-testid": "notification-detail", "data-notification": selected.id },
    h("div", { className: "personal-detail-title" }, state, h("h2", {}, selected.title[locale])),
    h("p", { className: "personal-detail-body" }, selected.body[locale]), note(t(openSource ? "museAttentionSavedAt" : "noticeQueuedAt", { time: dateText(selected.createdAt) })),
    /^\/#\/todos\//.test(selected.targetUrl) ? note(t("noticeOccurredAt", { time: dateText(selected.occurredAt) })) : null,
    delivery, cancelled, error, sourceError, h("div", { className: "personal-detail-actions" }, source, readButton, recheck));
  update(selected);
  return { element, update, start: () => {
    document.addEventListener("visibilitychange", automatic); window.addEventListener("focus", automatic); automatic();
  }, stop: () => { document.removeEventListener("visibilitychange", automatic); window.removeEventListener("focus", automatic); } };
}

type NoticeHost = { ready(): boolean; navigate(hash: string): void; changed(): void };
let noticeSheet: { id: string; close(): void; refresh(): Promise<void> } | undefined;
export function closeNoticeDetails() { noticeSheet?.close(); }
export function refreshNoticeDetails() { if (noticeSheet) void noticeSheet.refresh(); }
export function openNoticeDetails(id: string, host: NoticeHost) {
  if (noticeSheet?.id === id) { void noticeSheet.refresh(); return; }
  noticeSheet?.close();
  let detail: ReturnType<typeof noticeDetail> | undefined, request = 0;
  const view = sheet({ testID: "muse-notice-detail", label: t("museAttentionDetail"), onClose: () => {
    request++; detail?.stop(); if (noticeSheet?.id === id) noticeSheet = undefined; host.changed();
  } });
  const body = h("div", { className: "sheet-body" }), feedback = h("div", { className: "personal-form-feedback" });
  view.dialog.append(h("div", { className: "sheet-head" }, h("h2", { className: "sheet-title" }, t("museAttentionDetail")),
    h("button", { type: "button", className: "icon-button", "aria-label": t("close"), "data-testid": "muse-notice-close", onclick: view.close }, icon("close"))), body, feedback);
  const source = async (notice: InboxNotice) => {
    const conversation = noticeConversationID(notice.targetUrl), item = /^\/#\/(todos|automations)\/([a-f0-9-]+)$/.exec(notice.targetUrl);
    let hash: string;
    if (conversation !== null) { await api(`/api/conversations/${conversation}`); hash = `#/c/${conversation}`; }
    else if (item && uuid.test(item[2]!)) {
      await api(`/api/${item[1] === "todos" ? "todos" : "watches"}/${item[2]}`);
      hash = item[1] === "todos" ? `#/todos/${item[2]}` : `#/activity/watches/${item[2]}`;
    } else if (notice.targetUrl === "/#/schedules") { await api("/api/schedules"); hash = "#/schedules"; }
    else throw new Error(t("noticeSourceUnavailable"));
    if (view.open()) { view.close(); host.navigate(hash); }
  };
  const load = async () => {
    const current = ++request;
    if (!detail) body.replaceChildren(h("div", { className: "page-loading", role: "status" }, loader(24)));
    try {
      const notice = validNotice(await api<InboxNotice>(`/api/notifications/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(10_000) }));
      if (!view.open() || current !== request) return;
      feedback.replaceChildren();
      if (detail) detail.update(notice);
      else {
        detail = noticeDetail(notice, view.open, host.ready, source);
        body.replaceChildren(detail.element, note(t("noticeReadNote")), note(t("noticeDeliveryNote"))); detail.start();
      }
    } catch (failure) {
      if (!view.open() || current !== request) return;
      if (!detail) body.replaceChildren();
      feedback.replaceChildren(h("p", { className: "form-error", role: "alert", "data-testid": "notification-load-error" },
        hostText(failure instanceof Error ? failure.message : String(failure))),
      h("button", { type: "button", className: "button secondary", "data-testid": "notification-load-retry", onclick: () => void load() }, t("personalRetry")));
    }
  };
  noticeSheet = { id, close: view.close, refresh: load }; void load();
}

function editTodo(todo: Todo | undefined, refresh: () => void, chooseTime = false) {
  const planning = document.documentElement.hasAttribute("data-proactive"), deviceZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const dateOnly = () => planning && todo?.dueAt === null ? todo.plannedFor : null;
  let zone = dateOnly()?.timeZone ?? deviceZone;
  const title = h("input", { className: "field", value: todo?.title ?? "", maxlength: 240, required: true, autocomplete: "off", "data-testid": "todo-title" });
  const notes = h("textarea", { className: "field", rows: 4, maxlength: 10_000, "data-testid": "todo-notes" });
  notes.value = todo?.notes ?? "";
  const hasTime = h("input", { type: "checkbox", className: "switch", role: "switch", checked: chooseTime || todo?.dueAt !== null && todo?.dueAt !== undefined,
    "aria-label": t("todoHasTime"), "data-testid": "todo-has-time" });
  const originalTime = todo?.dueAt ? localInput(Date.parse(todo.dueAt)) : "";
  const runAt = h("input", { type: dateOnly() ? "time" : "datetime-local", className: "field", step: 60,
    value: dateOnly() ? "" : originalTime || localInput(Math.ceil((Date.now() + 3_600_000) / 60_000) * 60_000), "data-testid": "todo-due-at" });
  const field = (label: string, control: HTMLElement) => {
    control.setAttribute("aria-label", label);
    return h("label", { className: "stack" }, h("span", { className: "label" }, label), control);
  };
  const preview = note("", "todo-time-preview");
  const originalZone = note("", "todo-original-zone");
  const timeFields = h("div", { className: "editor-section" }, field(t("todoDueTime"), runAt), preview,
    originalZone);
  const syncTime = () => {
    timeFields.hidden = runAt.disabled = !hasTime.checked;
    runAt.required = hasTime.checked;
    const planned = dateOnly();
    const timeLabel = t(planned ? "pfSetTime" : "todoDueTime");
    timeFields.querySelector(".label")!.textContent = timeLabel;
    runAt.setAttribute("aria-label", timeLabel);
    if (planned) {
      preview.textContent = t("pfPlannedDate", { date: planned.date, zone }) + (runAt.value ? ` · ${runAt.value}` : "");
      originalZone.hidden = true;
      return;
    }
    const parsed = new Date(runAt.value).getTime();
    preview.textContent = t("todoDeviceZone", { zone }) + (Number.isFinite(parsed)
      ? ` ${new Date(parsed).toLocaleString(locale, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "longOffset" })}${parsed < Date.now() ? ` ${t("todoPastTime")}` : ""}` : "");
    originalZone.hidden = !todo?.timeZone || todo.timeZone === zone;
    originalZone.textContent = todo?.timeZone ? t("todoOriginalZone", { zone: todo.timeZone }) : "";
  };
  hasTime.addEventListener("change", syncTime);
  runAt.addEventListener("input", syncTime);
  syncTime();
  const snapshot = () => JSON.stringify([title.value, notes.value, hasTime.checked, hasTime.checked ? runAt.value : ""]);
  let baseline = snapshot(), saving = false, revision = todo?.revision;
  const key = crypto.randomUUID();
  const error = h("p", { className: "form-error", role: "alert", hidden: true, "data-testid": "todo-editor-error" });
  const beforeUnload = (event: BeforeUnloadEvent) => { if (snapshot() !== baseline) { event.preventDefault(); event.returnValue = ""; } };
  window.addEventListener("beforeunload", beforeUnload);
  const view = sheet({
    testID: "todo-editor", className: "todo-editor-sheet", label: t(todo ? "todoEdit" : "todoNew"),
    onClose: () => { window.removeEventListener("beforeunload", beforeUnload); refresh(); },
    canClose: async () => !saving && (snapshot() === baseline
      || await ask({ title: t("discardChanges"), message: t("todoCloseBody"), confirm: t("discard"), destructive: true }) === "confirm"),
  });
  const reload = h("button", { type: "button", className: "button secondary", hidden: true, "data-testid": "todo-reload", onclick: async () => {
    if (!todo || saving) return;
    if (snapshot() !== baseline && await ask({ title: t("todoReloadTitle"), message: t("todoReloadBody"), confirm: t("todoReload") }) !== "confirm") return;
    reload.disabled = true;
    try {
      const current = await api<Todo>(`/api/todos/${todo.id}`);
      title.value = current.title;
      notes.value = current.notes;
      hasTime.checked = current.dueAt !== null;
      todo = current;
      zone = dateOnly()?.timeZone ?? deviceZone;
      runAt.type = dateOnly() ? "time" : "datetime-local";
      runAt.value = current.dueAt ? localInput(Date.parse(current.dueAt)) : "";
      revision = current.revision;
      baseline = snapshot();
      error.hidden = true;
      reload.hidden = true;
      feedback.hidden = true;
      syncTime();
    } catch (failure) { error.textContent = hostText(failure instanceof Error ? failure.message : String(failure)); error.hidden = false; feedback.hidden = false; }
    finally { reload.disabled = false; }
  } }, t("todoReload"));
  const save = h("button", { type: "submit", className: "button primary", "data-testid": "todo-save" }, t("save"));
  const cancel = h("button", { type: "button", className: "button secondary", "data-testid": "todo-cancel", onclick: () => void view.attempt() }, t("cancel"));
  const close = h("button", { type: "button", className: "icon-button", "aria-label": t("close"), "data-testid": "todo-editor-close", onclick: () => void view.attempt() }, icon("close"));
  const feedback = h("div", { className: "personal-form-feedback", hidden: true, "data-testid": "todo-editor-feedback" }, error, reload);
  const form = h("form", { className: "todo-editor-form", onsubmit: async (event: Event) => {
    event.preventDefault();
    if (saving) return;
    error.hidden = true;
    feedback.hidden = true;
    try {
      if (!title.value.trim()) { title.focus(); throw new Error(t("todoRequiredTitle")); }
      const planned = dateOnly(), local = planned ? `${planned.date}T${runAt.value}` : runAt.value;
      const parsed = hasTime.checked && !planning ? new Date(runAt.value).getTime() : null;
      if (hasTime.checked && (planning ? !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local)
        : parsed === null || !Number.isFinite(parsed) || localInput(parsed) !== runAt.value)) throw new Error(t("todoBadTime"));
      const timingChanged = hasTime.checked !== (todo?.dueAt !== null && todo?.dueAt !== undefined)
        || hasTime.checked && runAt.value !== (todo?.dueAt ? localInput(Date.parse(todo.dueAt)) : "");
      const timing = !hasTime.checked ? { dueAt: null, timeZone: null } : planning ? { localDueAt: local, timeZone: zone }
        : { dueAt: new Date(parsed!).toISOString(), timeZone: zone };
      const body = { title: title.value, notes: notes.value, ...(!todo || timingChanged ? timing : {}),
        ...(todo ? { expectedRevision: revision } : {}) };
      saving = true;
      for (const control of [title, notes, hasTime, runAt, save, cancel, close, reload]) control.disabled = true;
      form.setAttribute("aria-busy", "true");
      save.textContent = t("personalSaving");
      await api(todo ? `/api/todos/${todo.id}` : "/api/todos",
        { method: todo ? "PATCH" : "POST", json: body, ...(todo ? {} : { headers: { "idempotency-key": key } }) });
      baseline = snapshot();
      view.close();
      toast(t("saved"));
    } catch (failure) {
      const message = hostText(failure instanceof Error ? failure.message : String(failure));
      error.textContent = failure instanceof TypeError ? `${t("todoSaveUnknown")} ${message}` : message;
      error.hidden = false;
      reload.hidden = !todo;
      feedback.hidden = false;
    } finally {
      saving = false;
      if (view.open()) {
        for (const control of [title, notes, hasTime, runAt, save, cancel, close, reload]) control.disabled = false;
        form.removeAttribute("aria-busy");
        save.textContent = t("save");
        syncTime();
      }
    }
  } }, h("div", { className: "sheet-body todo-editor-body" },
    field(t("todoTitle"), title), field(t("todoNotes"), notes),
    h("label", { className: "switch-row" }, h("span", {}, t("todoHasTime")), hasTime),
    timeFields, note(t("todoTimeHelp"))), feedback,
  h("div", { className: "personal-form-actions" }, cancel, save));
  view.dialog.append(h("div", { className: "sheet-head" }, h("h2", { className: "sheet-title" }, t(todo ? "todoEdit" : "todoNew")), close), form);
  (chooseTime && dateOnly() ? runAt : title).focus();
}

async function deleteTodo(todo: Todo, done: () => void) {
  if (await ask({ title: t("todoDeleteTitle", { name: todo.title }), message: t("todoDeleteBody"), confirm: t("delete"), destructive: true }) !== "confirm") return;
  try {
    await api(`/api/todos/${todo.id}`, { method: "DELETE", json: { expectedRevision: todo.revision } });
    toast(t("todoDeleted"));
    done();
  } catch (error) { failed(error); }
}

export async function renderPersonal(context: PageHost, kind: PersonalPage, id: string | null) {
  closePersonalView();
  const request = version, hash = location.hash;
  const here = () => context.route() === kind && location.hash === hash && context.main.isConnected;
  const active = () => request === version && here();
  const title = t(kind === "todos" ? "todoTasks" : "noticeInbox");
  const refresh = () => { if (here()) void renderPersonal(context, kind, id); };
  let available = false;
  const shell = (...children: Node[]) => {
    if (!active()) return;
    const restore = keepFocus(context.main), scroll = context.main.querySelector(".personal-page")?.scrollTop ?? 0;
    const actions = !available ? [] : kind === "todos" && id === null
      ? [h("button", { type: "button", className: "button primary", "data-testid": "todo-new", onclick: () => editTodo(undefined, refresh) }, icon("plus", 16), t("todoNew"))]
      : kind === "inbox" ? [h("button", { type: "button", className: "icon-button", "aria-label": t("noticePermission"), title: t("noticePermission"),
        "data-testid": "inbox-permissions", onclick: () => openNotifications() }, icon("gear"))] : [];
    context.main.replaceChildren(context.topbar(title, ...actions), h("div", { className: `page personal-page ${kind}-page`, "data-testid": `${kind}-page` },
      h("div", { className: "personal-content" }, ...children)));
    context.main.querySelector(".personal-page")!.scrollTop = scroll;
    restore();
  };
  if (!context.main.querySelector(`.${kind}-page`)) shell(h("div", { className: "page-loading", role: "status", "aria-label": t("personalLoading") }, loader(24)));
  try {
    if (kind === "todos") {
      const result = await api<TodoList>("/api/todos", { signal: AbortSignal.timeout(15_000) });
      if (!active()) return;
      if (result.available === false) { shell(empty(t("personalUnavailable"), t("personalUnavailableBody"), "check", "personal-unavailable")); return; }
      if (result.available !== true || !Array.isArray(result.todos)) throw new Error(t("personalDataInvalid"));
      available = true;
      const todo = id ? result.todos.find(item => item.id === id) : undefined;
      const toggle = (item: Todo) => h("button", { type: "button", role: "checkbox", "aria-checked": String(item.completed),
        className: `todo-toggle${item.completed ? " checked" : ""}`, "aria-label": t(item.completed ? "todoReopen" : "todoComplete", { name: item.title }),
        "data-testid": `todo-toggle-${item.id}`, onclick: async (event: Event) => {
          const button = event.currentTarget as HTMLButtonElement;
          button.disabled = true;
          button.setAttribute("aria-busy", "true");
          try { await api(`/api/todos/${item.id}`, { method: "PATCH", json: { completed: !item.completed, expectedRevision: item.revision } }); refresh(); }
          catch (error) { failed(error); }
          finally { button.disabled = false; button.removeAttribute("aria-busy"); }
        } }, h("span", { className: "todo-check" }, item.completed ? icon("check", 15) : null));
      const remove = (item: Todo) => h("button", { type: "button", className: "icon-button", "aria-label": t("delete"), title: t("delete"),
        "data-testid": `todo-delete-${item.id}`, onclick: () => void deleteTodo(item, () => { if (id) location.hash = "#/todos"; else refresh(); }) }, icon("trash", 18));
      const warning = result.warning ? h("p", { className: "form-error", role: "alert" }, hostText(result.warning)) : null;
      if (id) {
        if (!todo) throw new Error(t("todoUnavailable"));
        shell(h("a", { href: "#/todos", className: "personal-back", "data-testid": "todos-back" }, icon("back", 16), t("todoTasks")),
          h("article", { className: "group personal-detail", "data-testid": "todo-detail" },
            h("div", { className: "personal-detail-head" }, toggle(todo), h("h2", {}, todo.title), remove(todo)),
            todo.notes ? h("p", { className: "personal-detail-body" }, todo.notes) : null,
            note(reminderText(todo), "todo-reminder-state"),
            todo.dueAt ? note(`${t("todoDue", { time: dateText(todo.dueAt, todo.timeZone) })}${todo.timeZone ? ` · ${todo.timeZone}` : ""}`) : null,
            document.documentElement.hasAttribute("data-proactive") && todo.conversationId !== undefined && todo.reminder === "pending" && !todo.completed
              ? note(t("pfDeliveryNote")) : null,
            h("div", { className: "personal-detail-actions" }, h("button", { type: "button", className: "button secondary", "data-testid": "todo-edit", onclick: () => editTodo(todo, refresh) }, icon("pencil", 16), t("edit")))),
          ...(warning ? [warning] : []), note(t("todoHostNote")));
        return;
      }
      const shown = result.todos.filter(item => taskFilter === "all" || item.completed === (taskFilter === "completed"));
      const filters = h("div", { className: "personal-tabs", role: "group", "aria-label": t("todoFilters") },
        ...(["open", "completed", "all"] as const).map(filter => h("button", { type: "button", className: "personal-tab", "aria-pressed": String(taskFilter === filter),
          "data-testid": `todo-filter-${filter}`, onclick: () => { taskFilter = filter; refresh(); } }, t(filter === "open" ? "todoOpenFilter" : filter === "completed" ? "todoCompletedFilter" : "todoAllFilter"))));
      shell(h("div", { className: "personal-intro" }, h("span", { className: "tag subtle" }, t("personalPreview")), note(t("todoIntro"))), filters,
        ...(warning ? [warning] : []),
        shown.length ? h("div", { className: "group" }, ...shown.map(item => h("div", { className: `row todo-row${item.completed ? " completed" : ""}`, "data-testid": "todo-row", "data-todo": item.id },
          toggle(item), h("a", { href: `#/todos/${item.id}`, className: "personal-open", "aria-label": t("todoOpen", { name: item.title }), "data-testid": `todo-open-${item.id}` },
            h("span", { className: "row-name" }, item.title),
            item.notes ? h("span", { className: "muted small clamp" }, item.notes) : null,
            h("span", { className: "muted small", "data-testid": "todo-reminder-state" },
              [item.dueAt ? dateText(item.dueAt, item.timeZone) : "", reminderText(item)].filter(Boolean).join(" · "))), remove(item))))
          : empty(t("todoEmpty"), t(result.todos.length ? "todoEmptyFilter" : "todoEmptyBody"), "check", "todos-empty"),
        note(t("todoHostNote")), note(t("todoCount", { count: result.todos.length, limit: result.limit })));
      return;
    }
    const result = await api<NoticeList>("/api/notifications", { signal: AbortSignal.timeout(15_000) });
    if (!active()) return;
    if (result.available === false) { shell(empty(t("personalUnavailable"), t("personalUnavailableBody"), "inbox", "personal-unavailable")); return; }
    if (result.available !== true || !Array.isArray(result.notifications)) throw new Error(t("personalDataInvalid"));
    available = true;
    if (id) {
      const notice = result.notifications.find(item => item.id === id);
      if (!notice) throw new Error(t("noticeUnavailable"));
      const detail = noticeDetail(notice, active, () => navigator.onLine);
      shell(h("a", { href: "#/inbox", className: "personal-back", "data-testid": "inbox-back" }, icon("back", 16), t("noticeInbox")),
        detail.element,
        note(t("noticeReadNote")), note(t("noticeDeliveryNote")));
      stopVisibility = detail.stop; detail.start();
      return;
    }
    const filters = h("div", { className: "personal-tabs", role: "group", "aria-label": t("noticeFilters") },
      ...(["all", "unread"] as const).map(filter => h("button", { type: "button", className: "personal-tab", "aria-pressed": String(noticeFilter === filter),
        "data-testid": `notification-filter-${filter}`, onclick: () => { noticeFilter = filter; refresh(); } }, t(filter === "all" ? "todoAllFilter" : "noticeUnread"))));
    const shown = result.notifications.filter(item => noticeFilter === "all" || item.readAt === null && item.cancelledAt === null);
    shell(h("div", { className: "personal-intro" }, h("span", { className: "tag subtle" }, t("personalPreview")), note(t("noticeIntro"))), filters,
      ...(result.warning ? [h("p", { className: "form-error", role: "alert" }, hostText(result.warning))] : []),
      shown.length ? h("div", { className: "group" }, ...shown.map(item => h("a", { href: `#/inbox/${item.id}`,
        className: `row notification-row${item.readAt === null && item.cancelledAt === null ? " unread" : ""}`,
        "data-testid": `notification-open-${item.id}`, "data-notification": item.id },
        h("span", { className: "notice-marker" }, item.readAt === null && item.cancelledAt === null ? h("span", { className: "dot unread", "aria-label": t("noticeUnread") }) : icon("check", 16)),
        h("span", { className: "row-text" }, h("span", { className: "row-name" }, item.title[locale]), h("span", { className: "muted small clamp" }, item.body[locale]),
          h("span", { className: "faint small" }, dateText(item.createdAt))), icon("chevron", 16))))
        : empty(t("noticeEmpty"), t("noticeEmptyBody"), "inbox", "inbox-empty"),
      note(t("noticeReadNote")), note(t("noticeCount", { count: result.notifications.length, limit: result.limit })));
  } catch (error) {
    if (!active()) return;
    shell(h("div", { className: "personal-failure", role: "alert", "data-testid": "personal-error" },
      h("h2", {}, t("personalLoadFailed")), h("p", {}, hostText(error instanceof Error ? error.message : String(error))),
      ...(id ? [h("a", { href: `#/${kind}`, className: "button secondary", "data-testid": "personal-back" }, t("back"))] : []), retry(refresh)));
  }
}

import type { InboxNotice, Todo } from "@openox/agent/linux";
import { api, APIError, ask, failed, sheet, toast } from "./client";
import { keepFocus, type PageHost } from "./capabilities";
import { h, icon, loader } from "./dom";
import { hostText, locale, t, type StringKey } from "./i18n";
import { closeReadNotifications, openNotifications } from "./notifications";

export type PersonalSummary = { available: false } | { available: true; unreadCount: number; limit: number; warning: string | null };
export type PersonalPage = "todos" | "inbox";
type TodoList = { available: boolean; todos: Todo[]; warning: string | null; limit: number };
type NoticeList = { available: boolean; notifications: InboxNotice[]; unreadCount: number; warning: string | null; limit: number };
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

function editTodo(todo: Todo | undefined, refresh: () => void) {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const title = h("input", { className: "field", value: todo?.title ?? "", maxlength: 240, required: true, autocomplete: "off", "data-testid": "todo-title" });
  const notes = h("textarea", { className: "field", rows: 4, maxlength: 10_000, "data-testid": "todo-notes" });
  notes.value = todo?.notes ?? "";
  const hasTime = h("input", { type: "checkbox", className: "switch", role: "switch", checked: todo?.dueAt !== null && todo?.dueAt !== undefined,
    "aria-label": t("todoHasTime"), "data-testid": "todo-has-time" });
  const originalTime = todo?.dueAt ? localInput(Date.parse(todo.dueAt)) : "";
  const runAt = h("input", { type: "datetime-local", className: "field", step: 60,
    value: originalTime || localInput(Math.ceil((Date.now() + 3_600_000) / 60_000) * 60_000), "data-testid": "todo-due-at" });
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
      runAt.value = current.dueAt ? localInput(Date.parse(current.dueAt)) : "";
      todo = current;
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
      const parsed = hasTime.checked ? new Date(runAt.value).getTime() : null;
      if (hasTime.checked && (parsed === null || !Number.isFinite(parsed) || localInput(parsed) !== runAt.value)) throw new Error(t("todoBadTime"));
      const timingChanged = hasTime.checked !== (todo?.dueAt !== null && todo?.dueAt !== undefined)
        || hasTime.checked && runAt.value !== (todo?.dueAt ? localInput(Date.parse(todo.dueAt)) : "");
      const timing = { dueAt: parsed === null ? null : new Date(parsed).toISOString(), timeZone: parsed === null ? null : zone };
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
  title.focus();
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
      const selected = notice;
      const state = h("span", { className: "tag subtle", "data-testid": "notification-read-state" }, t(notice.readAt ? "noticeRead" : "noticeUnread"));
      const error = h("p", { className: "form-error", role: "alert", hidden: true, "data-testid": "notification-read-error" });
      const readButton = h("button", { type: "button", className: "button secondary", hidden: notice.readAt !== null,
        "data-testid": "notification-mark-read", onclick: () => void mark() }, t("noticeMarkRead"));
      let marking = false;
      const mark = async () => {
        if (!active() || document.visibilityState !== "visible" || selected.readAt !== null || marking || !state.isConnected) return;
        marking = true;
        readButton.disabled = true;
        try {
          const current = await api<InboxNotice>(`/api/notifications/${selected.id}/read`, { method: "PUT", json: {} });
          if (typeof current.readAt !== "string") throw new Error(t("personalDataInvalid"));
          selected.readAt = current.readAt;
          if (active()) { state.textContent = t("noticeRead"); error.hidden = true; readButton.hidden = true; }
          await closeReadNotifications([selected.id]);
        } catch (failure) { if (active()) { error.textContent = hostText(failure instanceof Error ? failure.message : String(failure)); error.hidden = false; } }
        finally { marking = false; readButton.disabled = false; }
      };
      shell(h("a", { href: "#/inbox", className: "personal-back", "data-testid": "inbox-back" }, icon("back", 16), t("noticeInbox")),
        h("article", { className: "group personal-detail", "data-testid": "notification-detail", "data-notification": notice.id },
          h("div", { className: "personal-detail-title" }, state, h("h2", {}, notice.title[locale])),
          h("p", { className: "personal-detail-body" }, notice.body[locale]),
          note(t("noticeQueuedAt", { time: dateText(notice.createdAt) })),
          notice.tag.startsWith("todo-") ? note(t("noticeOccurredAt", { time: dateText(notice.occurredAt) })) : null,
          note(t(deliveryKeys[notice.delivery.status]), "notification-delivery-state"),
          notice.cancelledAt ? note(t("noticeCancelled")) : null,
          error, h("div", { className: "personal-detail-actions" },
            h("a", { href: notice.targetUrl, className: "button primary", "data-testid": "notification-open-source" }, t("noticeOpenSource")),
            readButton)),
        note(t("noticeReadNote")), note(t("noticeDeliveryNote")));
      document.addEventListener("visibilitychange", mark);
      stopVisibility = () => document.removeEventListener("visibilitychange", mark);
      requestAnimationFrame(() => { void mark(); });
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

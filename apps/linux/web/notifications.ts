import { api, APIError, ask, clearInfoToasts, placeToasts, sheet } from "./client";
import { h, icon } from "./dom";
import { hostText, locale, t } from "./i18n";
import type { InboxNotice } from "@openox/agent/linux";
import { noticeTask } from "../../../packages/agent/src/adapters/linux/notice-target";

type Support = "ready" | "homeScreen" | "insecure" | "unsupported";
type PushState = { publicKey: string; subscribed: boolean };
const worker = "/api/push/worker.js";
const dismissed = new Set<string>();

export function clearForegroundNotices() {
  document.querySelectorAll("[data-proactive-alert]").forEach(element => element.remove());
  dismissed.clear();
}

export function showForegroundNotices(notices: InboxNotice[], open: (notice: InboxNotice) => void) {
  const notice = notices.find(item => noticeTask(item.tag) && !item.readAt && !item.cancelledAt && !dismissed.has(item.id));
  const existing = document.querySelector<HTMLElement>("[data-proactive-alert]");
  if (existing?.dataset.proactiveAlert === notice?.id) return;
  existing?.remove();
  if (!notice) return;
  const todo = noticeTask(notice.tag)?.kind === "todo";
  const alert = h("div", { className: "toast proactive-alert", role: todo ? "alert" : "status", "data-testid": "proactive-alert", "data-proactive-alert": notice.id },
    icon(todo ? "clock" : "chat", 18),
    h("div", { className: "toast-copy" }, h("strong", {}, t(todo ? "pfReminder" : "pfGoalUpdate")),
      h("p", { className: "proactive-alert-body" }, todo ? notice.body[locale] : notice.title[locale])),
    h("button", { type: "button", className: "button secondary small", "data-testid": "proactive-alert-open", onclick: () => open(notice) }, t("pfOpen")),
    h("button", { type: "button", className: "toast-close", "aria-label": t("dismiss"), title: t("dismiss"), "data-testid": "proactive-alert-dismiss",
      onclick: () => { dismissed.add(notice.id); alert.remove(); } }, icon("close", 16)));
  placeToasts().append(alert);
}

const apple = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const standalone = () => matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
const keyBytes = (key: string) => Uint8Array.from(atob(key.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(key.length / 4) * 4, "=")), character => character.charCodeAt(0));

export function pushSupport(): Support {
  if (!isSecureContext) return "insecure";
  if ("serviceWorker" in navigator && "PushManager" in window && "Notification" in window) return "ready";
  return apple() && !standalone() ? "homeScreen" : "unsupported";
}

async function subscription(publicKey: string) {
  await navigator.serviceWorker.register(worker, { scope: "/" });
  const registration = await navigator.serviceWorker.ready;
  const key = keyBytes(publicKey);
  const current = await registration.pushManager.getSubscription();
  const existing = current?.options.applicationServerKey ? new Uint8Array(current.options.applicationServerKey) : null;
  if (current && existing && existing.length === key.length && existing.every((value, index) => value === key[index])) return current;
  await current?.unsubscribe();
  return registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
}

const save = async (publicKey: string) =>
  api<PushState>("/api/push", { method: "PUT", json: { ...(await subscription(publicKey)).toJSON(), language: locale } });

export async function syncPush() {
  if (pushSupport() !== "ready" || Notification.permission !== "granted") return;
  const state = await api<PushState>("/api/push");
  const registration = await navigator.serviceWorker.getRegistration("/");
  if (!state.subscribed && !await registration?.pushManager.getSubscription()) return;
  await save(state.publicKey);
}

export function watchNotificationClicks(open: (hash: string) => void) {
  navigator.serviceWorker?.addEventListener("message", event => {
    const data = event.data as { type?: unknown; hash?: unknown } | null;
    if (data?.type === "open" && typeof data.hash === "string" && /^#\/[\w/-]*$/.test(data.hash)) open(data.hash);
  });
}

export async function closeReadNotifications(ids?: readonly string[]) {
  if (!("serviceWorker" in navigator)) return;
  try {
    const registration = await navigator.serviceWorker.getRegistration("/");
    if (!registration) return;
    for (const notification of await registration.getNotifications()) {
      const data: unknown = notification.data;
      if (!data || typeof data !== "object" || !("noticeId" in data) || typeof data.noticeId !== "string") continue;
      const id = data.noticeId;
      if (ids) { if (ids.includes(id)) notification.close(); continue; }
      try {
        const notice = await api<{ readAt: string | null; cancelledAt: string | null }>(`/api/notifications/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(5_000) });
        if ((notice.readAt !== null && typeof notice.readAt !== "string") || (notice.cancelledAt !== null && typeof notice.cancelledAt !== "string")) {
          throw new Error("The Host returned invalid notification state.");
        }
        if (notice.readAt !== null || notice.cancelledAt !== null) notification.close();
      } catch (error) {
        if (error instanceof APIError && [401, 403, 404].includes(error.status)) notification.close();
        else console.warn("Could not check a shown notification's read state", error);
      }
    }
  } catch (error) { console.warn("Local notification cleanup is unavailable", error); }
}

export function openNotifications() {
  let savingPreference = false, preferenceDirty = false;
  const view = sheet({ testID: "notifications", className: "notifications-sheet", label: t("notifications"),
    canClose: async () => !savingPreference && (!preferenceDirty
      || await ask({ title: t("discardChanges"), message: t("todoCloseBody"), confirm: t("discard"), destructive: true }) === "confirm") });
  const body = h("div", { className: "stay-notified" });
  view.dialog.append(h("div", { className: "sheet-head" }, h("h2", { className: "sheet-title" }, t("notifications")),
    h("div", { className: "sheet-tools" }, h("button", { type: "button", className: "icon-button", "aria-label": t("close"), title: t("close"), "data-testid": "notifications-close",
      onclick: () => void view.attempt() }, icon("close", 20)))), body);
  if (document.documentElement.hasAttribute("data-proactive")) {
    clearInfoToasts();
    let baseline: string | null | undefined, uncertain = false;
    const time = h("input", { type: "time", className: "field", disabled: true, "aria-label": t("pfDefaultTime"), "data-testid": "reminder-default-time" });
    const status = h("p", { className: "personal-note", role: "status", "data-testid": "reminder-default-status" });
    const error = h("p", { className: "form-error", role: "alert", hidden: true, "data-testid": "reminder-default-error" });
    const lock = (busy: boolean) => {
      savingPreference = busy; preferenceDirty = baseline !== undefined && (time.value || null) !== baseline;
      time.disabled = busy || baseline === undefined;
      save.disabled = busy || baseline === undefined || !preferenceDirty || uncertain;
      check.disabled = busy;
    };
    const read = async (initial: boolean) => {
      lock(true); error.hidden = true;
      try {
        const current = await api<{ defaultReminderTime: string | null }>("/api/todos/preferences", { signal: AbortSignal.timeout(10_000) });
        if (!view.open()) return;
        if (current.defaultReminderTime !== null && (typeof current.defaultReminderTime !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(current.defaultReminderTime))) throw new Error(t("personalDataInvalid"));
        baseline = current.defaultReminderTime;
        if (initial) time.value = baseline ?? "";
        uncertain = false; check.hidden = true;
        status.textContent = initial ? "" : (time.value || null) === baseline ? t("pfDefaultChecked") : t("pfDefaultDifferent", { time: baseline || t("todoNoReminder") });
      } catch (failure) {
        if (view.open()) { error.textContent = hostText(failure instanceof Error ? failure.message : String(failure)); error.hidden = false; check.hidden = false; }
      } finally { if (view.open()) lock(false); }
    };
    const check = h("button", { type: "button", className: "button secondary", hidden: true, "data-testid": "reminder-default-check",
      onclick: () => void read(baseline === undefined) }, t("pfDefaultCheck"));
    const save = h("button", { type: "submit", className: "button secondary", disabled: true, "data-testid": "reminder-default-save" }, t("save"));
    const form = h("form", { className: "reminder-preferences", onsubmit: async (event: Event) => {
      event.preventDefault();
      if (savingPreference || !preferenceDirty || uncertain) return;
      lock(true); error.hidden = true; status.textContent = "";
      try {
        const value = time.value || null;
        const current = await api<{ defaultReminderTime: string | null }>("/api/todos/preferences",
          { method: "PATCH", json: { defaultReminderTime: value }, signal: AbortSignal.timeout(10_000) });
        if (!view.open()) return;
        baseline = current.defaultReminderTime; check.hidden = true;
        status.textContent = baseline === value ? t("saved") : t("pfDefaultDifferent", { time: baseline || t("todoNoReminder") });
      } catch (failure) {
        if (!view.open()) return;
        uncertain = !(failure instanceof APIError) || failure.status >= 500 || failure.status === 408;
        error.textContent = uncertain ? t("pfDefaultSaveUnknown") : hostText(failure instanceof Error ? failure.message : String(failure));
        error.hidden = false; check.hidden = !uncertain;
      } finally { if (view.open()) lock(false); }
    } }, h("label", { className: "stack" }, h("span", { className: "label" }, t("pfDefaultTime")), time),
    h("p", { className: "personal-note" }, t("pfDefaultHint")), h("div", { className: "button-row" }, save, check), status, error);
    time.addEventListener("input", () => lock(false));
    view.dialog.insertBefore(form, body);
    void read(true);
  }
  const show = (message: string, control: Node | null, error = "") => body.replaceChildren(
    h("div", { className: "stay-notified-head" }, h("h3", { className: "stay-notified-title" }, t("stayNotified")), h("p", { className: "stay-notified-message", "data-testid": "notifications-message" }, message)),
    ...(control ? [control] : []), ...(error ? [h("p", { className: "form-error", role: "alert", "data-testid": "notifications-error" }, error)] : []));
  const note = (text: string) => h("p", { className: "stay-notified-state", "data-testid": "notifications-state" }, text);
  const render = async (error = "") => {
    const support = pushSupport();
    if (support !== "ready") {
      show(t("notifyIntro"), note(support === "homeScreen" ? t("notifyHomeScreen") : support === "insecure" ? t("notifyInsecure") : t("notifyUnsupported")));
      return;
    }
    if (Notification.permission === "denied") { show(t("notifyDenied"), null); return; }
    const state = await api<PushState>("/api/push").catch(() => null);
    if (!view.open()) return;
    if (Notification.permission === "granted" && state?.subscribed) { show(t("notifyOn"), note(t("notifyAlreadyOn"))); return; }
    let busy = false;
    const allow: HTMLButtonElement = h("button", { type: "button", className: "permission-allow", "aria-label": t("allowNotifications"), "data-testid": "notifications-allow",
      onclick: async () => {
        if (busy) return;
        busy = true;
        allow.disabled = true;
        try {
          if (await Notification.requestPermission() === "granted") await save(state?.publicKey ?? (await api<PushState>("/api/push")).publicKey);
          if (view.open()) await render();
        } catch (failure) {
          if (view.open()) await render(t("notifyFailed", { message: failure instanceof Error ? failure.message : String(failure) }));
        }
      } }, t("allow"));
    show(t("notifyIntro"), h("div", { className: "permission-prompt" },
      h("div", { className: "permission-card" }, h("p", { className: "permission-title" }, t("notifyPromptTitle")),
        h("div", { className: "permission-actions" }, h("span", { className: "permission-deny", "aria-hidden": "true" }, t("dontAllow")), allow)),
      h("span", { className: "permission-pointer", "aria-hidden": "true" }, icon("chevron", 14))), error);
  };
  void render();
}

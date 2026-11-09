import { api, sheet } from "./client";
import { h, icon } from "./dom";
import { locale, t } from "./i18n";

type Support = "ready" | "homeScreen" | "insecure" | "unsupported";
type PushState = { publicKey: string; subscribed: boolean };
const worker = "/api/push/worker.js";

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

export function openNotifications() {
  const view = sheet({ testID: "notifications", className: "notifications-sheet", label: t("notifications") });
  const body = h("div", { className: "stay-notified" });
  view.dialog.append(h("div", { className: "sheet-head" }, h("h2", { className: "sheet-title" }, t("notifications")),
    h("div", { className: "sheet-tools" }, h("button", { type: "button", className: "icon-button", "aria-label": t("close"), title: t("close"), "data-testid": "notifications-close",
      onclick: () => view.close() }, icon("close", 20)))), body);
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

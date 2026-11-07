import { h, icon, type IconName } from "./dom";
import { hostText, locale, t } from "./i18n";

let unauthorized = () => {};
export function onUnauthorized(handler: () => void) { unauthorized = handler; }

export class APIError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init;
  const response = await fetch(path, { ...rest, credentials: "same-origin",
    headers: { ...(json === undefined ? {} : { "content-type": "application/json" }), ...rest.headers },
    body: json === undefined ? rest.body : JSON.stringify(json) });
  const body = await response.json().catch(() => ({})) as { error?: string };
  if (response.status === 401) unauthorized();
  if (!response.ok) throw new APIError(response.status, body.error ?? `${t("error")} (${response.status})`);
  return body as T;
}

export function toast(message: string, kind: "info" | "error" = "info") {
  const region = document.querySelector(".toasts") ?? document.body.appendChild(h("div", { className: "toasts", role: "status", "aria-live": "polite" }));
  const element = h("div", { className: `toast ${kind}`, "data-testid": `toast-${kind}` }, icon(kind === "error" ? "close" : "check", 16), h("span", {}, message));
  region.append(element);
  setTimeout(() => element.classList.add("leaving"), kind === "error" ? 5_000 : 1_800);
  setTimeout(() => element.remove(), kind === "error" ? 5_400 : 2_200);
}
export const failed = (error: unknown) => toast(hostText(error instanceof Error ? error.message : String(error)), "error");

export function ask(options: { title: string; message?: string; input?: { value: string; label: string; type?: string }; confirm?: string; destructive?: boolean;
  actions?: { label: string; value: string; destructive?: boolean }[] }) {
  return new Promise<string | null>(resolve => {
    const field = options.input ? h("input", { className: "field", value: options.input.value, "aria-label": options.input.label, type: options.input.type ?? "text",
      autocomplete: "off", autocapitalize: "off", spellcheck: "false", "data-testid": "dialog-input" }) : undefined;
    const dialog = h("dialog", { className: "dialog", "data-testid": "dialog" });
    let settled = false;
    const finish = (value: string | null) => { if (settled) return; settled = true; dialog.close(); dialog.remove(); resolve(value); };
    const actions = options.actions?.map(action => h("button", { type: "button", className: `button ${action.destructive ? "danger" : "secondary"} wide`,
      "data-testid": `dialog-action-${action.value}`, onclick: () => finish(action.value) }, action.label)) ?? [];
    const form = h("form", { method: "dialog", onsubmit: (event: Event) => { event.preventDefault(); finish(field ? field.value : "confirm"); } },
      h("h2", {}, options.title),
      options.message ? h("p", { className: "muted" }, options.message) : null,
      field ? h("label", { className: "stack" }, h("span", { className: "label" }, options.input!.label), field) : null,
      actions.length ? h("div", { className: "dialog-actions vertical" }, ...actions,
        h("button", { type: "button", className: "button secondary wide", "data-testid": "dialog-cancel", onclick: () => finish(null) }, t("cancel")))
        : h("div", { className: "dialog-actions" },
          h("button", { type: "button", className: "button secondary", "data-testid": "dialog-cancel", onclick: () => finish(null) }, t("cancel")),
          h("button", { type: "submit", className: `button ${options.destructive ? "danger" : "primary"}`, "data-testid": "dialog-confirm" }, options.confirm ?? t("save"))));
    dialog.append(form);
    dialog.addEventListener("cancel", event => { event.preventDefault(); finish(null); });
    dialog.addEventListener("click", event => { if (event.target === dialog) finish(null); });
    document.body.append(dialog);
    dialog.showModal();
    field?.focus();
    field?.select();
  });
}

export interface MenuItem { label: string; icon?: IconName; destructive?: boolean; testID?: string; run(): void }
let closeOpenMenu = () => {};

export function menu(anchor: HTMLElement, items: MenuItem[]) {
  closeOpenMenu();
  const element = h("div", { className: "menu", role: "menu", "data-testid": "menu" }, ...items.map(item => h("button", { type: "button", role: "menuitem",
    className: `menu-item${item.destructive ? " danger" : ""}`, "data-testid": item.testID ?? null, onclick: () => { close(); item.run(); } }, item.icon ? icon(item.icon, 18) : null, h("span", {}, item.label))));
  const outside = (event: PointerEvent) => { if (!element.contains(event.target as Node) && !anchor.contains(event.target as Node)) close(); };
  const keys = (event: KeyboardEvent) => {
    if (event.key === "Escape") { close(); anchor.focus(); return; }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const buttons = [...element.querySelectorAll("button")], index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    buttons[(index + (event.key === "ArrowDown" ? 1 : buttons.length - 1)) % buttons.length]?.focus();
  };
  function close() {
    element.remove();
    anchor.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", outside, true);
    document.removeEventListener("keydown", keys, true);
    window.removeEventListener("resize", close);
    closeOpenMenu = () => {};
  }
  document.body.append(element);
  const rect = anchor.getBoundingClientRect(), width = element.offsetWidth, height = element.offsetHeight;
  const below = rect.bottom + 6 + height <= innerHeight - 8;
  element.style.left = `${Math.round(Math.min(Math.max(8, rect.right - width), innerWidth - width - 8))}px`;
  element.style.top = `${Math.round(below ? rect.bottom + 6 : Math.max(8, rect.top - height - 6))}px`;
  element.dataset.side = below ? "bottom" : "top";
  anchor.setAttribute("aria-expanded", "true");
  document.addEventListener("pointerdown", outside, true);
  document.addEventListener("keydown", keys, true);
  window.addEventListener("resize", close);
  closeOpenMenu = close;
  (element.querySelector("button") as HTMLButtonElement | null)?.focus({ preventScroll: true });
}

export function relativeTime(milliseconds: number | null) {
  if (!milliseconds) return "";
  const date = new Date(milliseconds);
  const now = new Date();
  if (now.getTime() - milliseconds < 60_000) return t("justNow");
  if (date.toDateString() === now.toDateString()) return date.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
  if (now.getTime() - milliseconds < 6 * 86_400_000) return date.toLocaleDateString(locale, { weekday: "short" });
  return date.toLocaleDateString(locale, { month: "short", day: "numeric", ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }) });
}

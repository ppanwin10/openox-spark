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

function dismissToast(element: HTMLElement) {
  element.classList.add("leaving");
  setTimeout(() => element.remove(), 300);
}

export function placeToasts() {
  const host = [...document.querySelectorAll<HTMLDialogElement>("dialog[open]")].at(-1) ?? document.body;
  const region = document.querySelector<HTMLElement>(".toasts") ?? h("div", { className: "toasts", role: "status", "aria-live": "polite", popover: "manual" });
  if (region.matches(":popover-open")) region.hidePopover();
  if (region.parentElement !== host) host.append(region);
  if (region.childElementCount) region.showPopover();
  return region;
}

export function toast(message: string, kind: "info" | "error" = "info") {
  const region = placeToasts();
  if (!region.matches(":popover-open")) region.showPopover();
  const visible = [...region.querySelectorAll<HTMLElement>(`.toast.${kind}:not(.leaving)`)];
  const repeated = visible.find(element => element.dataset.message === message);
  if (repeated) { if (kind === "error") region.append(repeated); else linger(repeated); return; }
  if (kind === "error") visible.slice(0, Math.max(0, visible.length - 2)).forEach(dismissToast);
  const element = h("div", { className: `toast ${kind}`, "data-testid": `toast-${kind}`, "data-message": message }, icon(kind === "error" ? "warning" : "check", 16), h("span", {}, message));
  if (kind === "error") element.append(h("button", { type: "button", className: "toast-close", "aria-label": t("dismiss"), title: t("dismiss"), "data-testid": "toast-dismiss",
    onclick: () => dismissToast(element) }, icon("close", 14)));
  region.append(element);
  if (kind === "info") linger(element);
}

const lingering = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();
function linger(element: HTMLElement) {
  clearTimeout(lingering.get(element));
  lingering.set(element, setTimeout(() => dismissToast(element), 1_800));
}
export const failed = (error: unknown) => toast(hostText(error instanceof Error ? error.message : String(error)), "error");

export async function download(path: string, fallback: string) {
  const response = await fetch(path, { credentials: "same-origin" });
  if (response.status === 401) unauthorized();
  if (!response.ok) throw new APIError(response.status, ((await response.json().catch(() => ({}))) as { error?: string }).error ?? `${t("error")} (${response.status})`);
  const header = response.headers.get("content-disposition") ?? "";
  const encoded = /filename\*=UTF-8''([^;]+)/.exec(header)?.[1];
  const name = encoded ? decodeURIComponent(encoded) : /filename="([^"]+)"/.exec(header)?.[1] ?? fallback;
  const url = URL.createObjectURL(await response.blob());
  const link = h("a", { href: url, download: name, hidden: true });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

function returnFocus(opener: Element | null) {
  if (!(opener instanceof HTMLElement) || opener.isConnected) return;
  const control = opener.dataset.testid;
  if (!control) return;
  const target = `[data-testid="${CSS.escape(control)}"]`;
  const scope = (["schedule", "skill"] as const).flatMap(key => {
    const value = opener.closest<HTMLElement>(`[data-${key}]`)?.dataset[key];
    return value === undefined ? [] : [`[data-${key}="${CSS.escape(value)}"]`];
  })[0];
  document.querySelector<HTMLElement>(scope ? `${scope}${target}, ${scope} ${target}` : target)?.focus({ preventScroll: true });
}

export function closeOnBackdrop(dialog: HTMLDialogElement, close: () => void) {
  const outside = (event: MouseEvent) => {
    const rect = dialog.getBoundingClientRect();
    return event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom);
  };
  let armed = false;
  dialog.addEventListener("pointerdown", event => { armed = outside(event); });
  dialog.addEventListener("click", event => { if (armed && outside(event)) close(); armed = false; });
}

export function ask(options: { title: string; message?: string; input?: { value: string; label: string; type?: string }; confirm?: string; cancel?: string; destructive?: boolean;
  actions?: { label: string; value: string; destructive?: boolean }[] }) {
  return new Promise<string | null>(resolve => {
    const field = options.input ? h("input", { className: "field", value: options.input.value, "aria-label": options.input.label, type: options.input.type ?? "text",
      autocomplete: "off", autocapitalize: "off", spellcheck: "false", "data-testid": "dialog-input" }) : undefined;
    const dialog = h("dialog", { className: "dialog", "data-testid": "dialog" });
    let settled = false;
    const opener = document.activeElement;
    const finish = (value: string | null) => { if (settled) return; settled = true; dialog.close(); placeToasts(); dialog.remove(); returnFocus(opener); resolve(value); };
    const actions = options.actions?.map(action => h("button", { type: "button", className: `button ${action.destructive ? "danger" : "secondary"} wide`,
      "data-testid": `dialog-action-${action.value}`, onclick: () => finish(action.value) }, action.label)) ?? [];
    const form = h("form", { method: "dialog", onsubmit: (event: Event) => { event.preventDefault(); finish(field ? field.value : "confirm"); } },
      h("h2", {}, options.title),
      options.message ? h("p", { className: "muted" }, options.message) : null,
      field ? h("label", { className: "stack" }, h("span", { className: "label" }, options.input!.label), field) : null,
      actions.length ? h("div", { className: "dialog-actions vertical" }, ...actions,
        h("button", { type: "button", className: "button secondary wide", "data-testid": "dialog-cancel", onclick: () => finish(null) }, t("cancel")))
        : h("div", { className: "dialog-actions" },
          h("button", { type: "button", className: "button secondary", "data-testid": "dialog-cancel", onclick: () => finish(null) }, options.cancel ?? t("cancel")),
          h("button", { type: "submit", className: `button ${options.destructive ? "danger" : "primary"}`, "data-testid": "dialog-confirm" }, options.confirm ?? t("save"))));
    dialog.append(form);
    dialog.addEventListener("cancel", event => { event.preventDefault(); finish(null); });
    closeOnBackdrop(dialog, () => finish(null));
    document.body.append(dialog);
    dialog.showModal();
    placeToasts();
    field?.focus();
    field?.select();
  });
}

export function sheet(options: { testID: string; className?: string; label?: string; onClose?(): void; canClose?(): boolean | Promise<boolean> }) {
  const dialog = h("dialog", { className: `dialog sheet${options.className ? ` ${options.className}` : ""}`, "data-testid": options.testID,
    ...(options.label ? { "aria-label": options.label } : {}) });
  const opener = document.activeElement;
  let closed = false;
  const close = () => { if (closed) return; closed = true; dialog.close(); placeToasts(); dialog.remove(); returnFocus(opener); options.onClose?.(); };
  let asking = false;
  const attempt = async () => {
    if (closed || asking) return;
    asking = true;
    try { if (!options.canClose || await options.canClose()) close(); } finally { asking = false; }
  };
  dialog.addEventListener("cancel", event => { if (!event.cancelable) return; event.preventDefault(); void attempt(); });
  dialog.addEventListener("close", () => {
    if (closed) return;
    if (!options.canClose) { close(); return; }
    dialog.showModal();
    void attempt();
  });
  closeOnBackdrop(dialog, () => void attempt());
  document.body.append(dialog);
  dialog.showModal();
  placeToasts();
  return { dialog, close, attempt, open: () => !closed };
}

export interface FormField { name: string; label: string; kind?: "text" | "password" | "url" | "textarea" | "switch"; value?: string; checked?: boolean;
  placeholder?: string; help?: string; rows?: number; testID?: string }

export function formDialog(options: { title: string; message?: string; content?: Node; fields?: FormField[]; confirm?: string; destructive?: boolean;
  cancel?: boolean; testID?: string; submit?(values: Record<string, string | boolean>): Promise<void> }) {
  return new Promise<boolean>(resolve => {
    const dialog = h("dialog", { className: "dialog form-dialog", "data-testid": options.testID ?? "form-dialog" });
    const error = h("p", { className: "form-error", role: "alert", hidden: true, "data-testid": "dialog-error" });
    const inputs = new Map<string, HTMLInputElement | HTMLTextAreaElement>();
    const fields = (options.fields ?? []).map(field => {
      if (field.kind === "switch") {
        const input = h("input", { type: "checkbox", className: "switch", checked: !!field.checked, role: "switch", "data-testid": field.testID ?? `field-${field.name}` });
        inputs.set(field.name, input);
        return h("label", { className: "switch-row" }, h("span", { className: "switch-text" }, h("span", {}, field.label),
          field.help ? h("span", { className: "muted small" }, field.help) : null), input);
      }
      const common = { className: "field", placeholder: field.placeholder ?? "", "aria-label": field.label, autocapitalize: "off", spellcheck: "false", "data-testid": field.testID ?? `field-${field.name}` };
      const input = field.kind === "textarea" ? h("textarea", { ...common, rows: field.rows ?? 6 })
        : h("input", { ...common, type: field.kind === "password" ? "password" : field.kind === "url" ? "url" : "text", autocomplete: "off", ...(field.kind === "url" ? { inputmode: "url" } : {}) });
      input.value = field.value ?? "";
      inputs.set(field.name, input);
      return h("label", { className: "stack" }, h("span", { className: "label" }, field.label), input, field.help ? h("span", { className: "muted small" }, field.help) : null);
    });
    let settled = false;
    const opener = document.activeElement;
    const finish = (value: boolean) => { if (settled) return; settled = true; dialog.close(); placeToasts(); dialog.remove(); returnFocus(opener); resolve(value); };
    const confirm = h("button", { type: "submit", className: `button ${options.destructive ? "danger" : "primary"}`, "data-testid": "dialog-confirm" }, options.confirm ?? t("save"));
    const form = h("form", { method: "dialog", onsubmit: async (event: Event) => {
      event.preventDefault();
      if (!options.submit) { finish(true); return; }
      const values = Object.fromEntries([...inputs].map(([name, input]) => [name, input instanceof HTMLInputElement && input.type === "checkbox" ? input.checked : input.value]));
      confirm.disabled = true;
      error.hidden = true;
      try { await options.submit(values); finish(true); }
      catch (failure) { error.textContent = hostText(failure instanceof Error ? failure.message : String(failure)); error.hidden = false; confirm.disabled = false; }
    } }, h("h2", {}, options.title), options.message ? h("p", { className: "muted" }, options.message) : null, options.content ?? null, ...fields, error,
      h("div", { className: "dialog-actions" },
        options.cancel === false ? null : h("button", { type: "button", className: "button secondary", "data-testid": "dialog-cancel", onclick: () => finish(false) }, t("cancel")),
        confirm));
    dialog.append(form);
    dialog.addEventListener("cancel", event => { event.preventDefault(); finish(false); });
    closeOnBackdrop(dialog, () => finish(false));
    document.body.append(dialog);
    dialog.showModal();
    placeToasts();
    const first = [...inputs.values()].find(input => !(input instanceof HTMLInputElement && input.type === "checkbox"));
    (first ?? confirm).focus();
  });
}

export interface MenuItem { label: string; icon?: IconName; destructive?: boolean; testID?: string; run(): void }
let closeOpenMenu = () => {};

export function menu(anchor: HTMLElement, items: MenuItem[], options: { className?: string; focus?: boolean } = {}) {
  closeOpenMenu();
  const focus = options.focus ?? true;
  const element = h("div", { className: `menu${options.className ? ` ${options.className}` : ""}`, role: "menu", "data-testid": "menu" }, ...items.map(item => h("button", { type: "button", role: "menuitem",
    className: `menu-item${item.destructive ? " danger" : ""}`, "data-testid": item.testID ?? null, onclick: () => { close(); item.run(); } }, item.icon ? icon(item.icon, 18) : null, h("span", {}, item.label))));
  if (!focus) element.addEventListener("mousedown", event => event.preventDefault());
  const outside = (event: PointerEvent) => { if (!element.contains(event.target as Node) && !anchor.contains(event.target as Node)) close(); };
  const keys = (event: KeyboardEvent) => {
    const inside = element.contains(document.activeElement);
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); if (focus || inside) anchor.focus(); return; }
    if ((event.key !== "ArrowDown" && event.key !== "ArrowUp") || (!focus && !inside)) return;
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
  (anchor.closest("dialog[open]") ?? document.body).append(element);
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
  if (focus) (element.querySelector("button") as HTMLButtonElement | null)?.focus({ preventScroll: true });
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

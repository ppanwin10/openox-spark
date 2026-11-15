import { h, icon, loader, type IconName } from "./dom";
import { hostText, locale, t } from "./i18n";

let unauthorized = () => {};
export function onUnauthorized(handler: () => void) { unauthorized = handler; }
let contentEpoch: number | undefined;
export function setContentEpoch(value: number | undefined) { contentEpoch = Number.isSafeInteger(value) && value! >= 0 ? value : undefined; }
export function getContentEpoch() { return contentEpoch; }

export class APIError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  constructor(status: number, message: string, code?: string) { super(message); this.status = status; this.code = code; }
}

export async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init;
  const response = await fetch(path, { ...rest, credentials: "same-origin",
    headers: { ...(contentEpoch === undefined ? {} : { "x-openox-content-epoch": String(contentEpoch) }),
      ...(json === undefined ? {} : { "content-type": "application/json" }), ...rest.headers },
    body: json === undefined ? rest.body : JSON.stringify(json) });
  const body = await response.json().catch(() => ({})) as { error?: string; code?: string };
  if (response.status === 401) unauthorized();
  if (!response.ok) throw new APIError(response.status, body.error ?? `${t("error")} (${response.status})`, typeof body.code === "string" ? body.code : undefined);
  return body as T;
}

function dismissToast(element: HTMLElement) {
  element.classList.add("leaving");
  setTimeout(() => element.remove(), 300);
}

let feedbackRegion: HTMLElement | undefined;
const feedbackObserver = new MutationObserver(() => {
  if (feedbackRegion?.childElementCount && document.documentElement.hasAttribute("data-muse")) placeToasts();
});

export function placeToasts() {
  const muse = document.documentElement.hasAttribute("data-muse");
  const dialog = [...document.querySelectorAll<HTMLDialogElement>("dialog[open]")].at(-1);
  const viewer = muse ? document.querySelector<HTMLElement>('[data-testid="page-viewer"] > .viewer-sheet') : null;
  const host = viewer && (!dialog || dialog.contains(viewer)) ? viewer : dialog ?? document.body;
  const region = (muse ? feedbackRegion : undefined) ?? document.querySelector<HTMLElement>(".toasts") ?? h("div", { className: "toasts", role: "status", "aria-live": "polite" });
  feedbackRegion = muse ? region : undefined;
  if (region.matches(":popover-open")) region.hidePopover();
  if (muse) region.removeAttribute("popover");
  else region.setAttribute("popover", "manual");
  if (region.parentElement !== host) host.append(region);
  if (!muse && region.childElementCount) region.showPopover();
  feedbackObserver.disconnect();
  if (muse) {
    feedbackObserver.observe(document.body, { childList: true });
    for (const dialog of document.querySelectorAll("dialog")) feedbackObserver.observe(dialog, { childList: true, attributes: true, attributeFilter: ["open"] });
  }
  return region;
}

export function toast(message: string, kind: "info" | "error" = "info", detail?: string) {
  const region = placeToasts();
  const muse = document.documentElement.hasAttribute("data-muse");
  if (!muse && !region.matches(":popover-open")) region.showPopover();
  const visible = [...region.querySelectorAll<HTMLElement>(`.toast.${kind}:not(.leaving)`)];
  const identity = detail ? `${message}\n${detail}` : message;
  const repeated = visible.find(element => element.dataset.message === identity);
  if (repeated) { if (kind === "error") region.append(repeated); else linger(repeated); return; }
  if (muse && kind === "error") closeOpenMenu();
  if (kind === "error") visible.slice(0, Math.max(0, visible.length - 2)).forEach(dismissToast);
  const content = detail ? h("div", { className: "toast-copy" }, h("span", {}, message),
    h("details", { className: "toast-details" }, h("summary", { "data-testid": "toast-details-toggle" }, t("technicalDetails")),
      h("p", { "data-testid": "toast-technical-detail" }, detail))) : h("span", {}, message);
  const element = h("div", { className: `toast ${kind}`, "data-testid": `toast-${kind}`, "data-message": identity }, icon(kind === "error" ? "warning" : "check", 16), content);
  if (kind === "error") element.append(h("button", { type: "button", className: "toast-close", "aria-label": t("dismiss"), title: t("dismiss"), "data-testid": "toast-dismiss",
    onclick: () => dismissToast(element) }, icon("close", 14)));
  region.append(element);
  if (kind === "info") linger(element);
}

const lingering = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();
export function clearInfoToasts() {
  for (const element of feedbackRegion?.querySelectorAll<HTMLElement>(".toast.info") ?? []) {
    clearTimeout(lingering.get(element)); element.remove();
  }
}
function linger(element: HTMLElement) {
  clearTimeout(lingering.get(element));
  lingering.set(element, setTimeout(() => dismissToast(element), 1_800));
}
export const failed = (error: unknown, unverified?: string) => {
  const message = error instanceof Error ? error.message : String(error);
  if (unverified && document.documentElement.hasAttribute("data-muse") && (!(error instanceof APIError) || error.status === 408 || error.status >= 500)) toast(unverified, "error", hostText(message));
  else if (document.documentElement.hasAttribute("data-muse") && /^EACCES: permission denied(?:,|$)/.test(message)) toast(t("hostFileAccessDenied"), "error", message);
  else if (document.documentElement.hasAttribute("data-muse") && message === "Failed to fetch") toast(t("requestResultUnavailable"), "error");
  else if (document.documentElement.hasAttribute("data-muse") && message === "Files are limited to 32 MiB") toast(t("attachmentLimit"), "error");
  else toast(hostText(message), "error");
};

export async function download(path: string, fallback: string, init: RequestInit & { json?: unknown } = {}) {
  const { json, ...rest } = init;
  const response = await fetch(path, { ...rest, credentials: "same-origin",
    headers: { ...(contentEpoch === undefined ? {} : { "x-openox-content-epoch": String(contentEpoch) }),
      ...(json === undefined ? {} : { "content-type": "application/json" }), ...rest.headers },
    body: json === undefined ? rest.body : JSON.stringify(json) });
  if (response.status === 401) unauthorized();
  if (!response.ok) throw new APIError(response.status, ((await response.json().catch(() => ({}))) as { error?: string }).error ?? `${t("error")} (${response.status})`);
  const header = response.headers.get("content-disposition") ?? "";
  const encoded = /filename\*=UTF-8''([^;]+)/.exec(header)?.[1];
  const name = encoded ? decodeURIComponent(encoded) : /filename="([^"]+)"/.exec(header)?.[1] ?? fallback;
  const blob = await response.blob();
  init.signal?.throwIfAborted();
  const url = URL.createObjectURL(blob);
  const link = h("a", { href: url, download: name, hidden: true });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export function returnFocus(opener: Element | null) {
  if (!(opener instanceof HTMLElement)) return;
  if (opener.isConnected) {
    if (document.documentElement.hasAttribute("data-muse")) opener.focus({ preventScroll: true });
    return;
  }
  const control = opener.dataset.testid;
  if (!control) return;
  const target = `[data-testid="${CSS.escape(control)}"]`;
  const file = opener.closest(".file-row")?.querySelector("a")?.getAttribute("href");
  const scope = (["schedule", "skill", "message-actions"] as const).flatMap(key => {
    const value = opener.closest<HTMLElement>(`[data-${key}]`)?.getAttribute(`data-${key}`);
    return value == null ? [] : [`[data-${key}="${CSS.escape(value)}"]`];
  })[0] ?? (file ? `.file-row:has(a[href="${CSS.escape(file)}"])` : undefined);
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
    const dialog = h("dialog", { className: "dialog", "data-testid": "dialog",
      ...(document.documentElement.hasAttribute("data-muse") ? { "aria-label": options.title } : {}) });
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
  cancel?: boolean; testID?: string; protectDraft?: boolean; submit?(values: Record<string, string | boolean>): Promise<void> }) {
  return new Promise<boolean>(resolve => {
    const muse = document.documentElement.hasAttribute("data-muse"), guarded = options.protectDraft || muse;
    const dialog = h("dialog", { className: "dialog form-dialog", "data-testid": options.testID ?? "form-dialog",
      ...(muse ? { "aria-label": options.title } : {}) });
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
    type DraftControl = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
    const controls: DraftControl[] = [...inputs.values(), ...(guarded && options.content instanceof Element
      ? options.content.querySelectorAll<DraftControl>("input,textarea,select") : [])];
    const valueOf = (input: DraftControl) => input instanceof HTMLInputElement && input.type === "checkbox" ? input.checked : input.value;
    const read = () => Object.fromEntries([...inputs].map(([name, input]) => [name, valueOf(input)]));
    const baseline = new Map(controls.map(input => [input, valueOf(input)]));
    const disabled = new Map<DraftControl, boolean>();
    const dirty = () => controls.some(input => valueOf(input) !== baseline.get(input));
    let settled = false, pending = false, asking = false;
    const beforeUnload = (event: BeforeUnloadEvent) => { if (pending || dirty()) { event.preventDefault(); event.returnValue = ""; } };
    if (options.protectDraft) window.addEventListener("beforeunload", beforeUnload);
    const opener = document.activeElement;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true; window.removeEventListener("beforeunload", beforeUnload);
      dialog.close(); placeToasts(); dialog.remove(); returnFocus(opener); resolve(value);
    };
    const attempt = async () => {
      if (settled || asking || guarded && pending) return;
      asking = true;
      try {
        if (!options.protectDraft || !dirty() || await ask({ title: t("discardChanges"), message: t("formCloseBody"), confirm: t("discard"), destructive: true }) === "confirm") finish(false);
      } finally { asking = false; }
    };
    const confirm = h("button", { type: "submit", className: `button ${options.destructive ? "danger" : "primary"}`, "data-testid": "dialog-confirm" }, options.confirm ?? t("save"));
    const cancel = options.cancel === false ? null : h("button", { type: "button", className: "button secondary", "data-testid": "dialog-cancel", onclick: () => void attempt() }, t("cancel"));
    const progress = muse ? h("p", { className: "dialog-progress", role: "status", hidden: true, "data-testid": "dialog-progress" }, loader(16), t("dialogSubmitting")) : null;
    const saving = (value: boolean) => {
      pending = value; confirm.disabled = value;
      if (muse) {
        dialog.setAttribute("aria-busy", String(value));
        if (progress) progress.hidden = !value;
      }
      if (guarded) {
        for (const input of controls) {
          if (value) disabled.set(input, input.disabled);
          input.disabled = value || disabled.get(input) === true;
        }
        if (!value) disabled.clear();
        if (cancel) cancel.disabled = value;
      }
      if (muse && value) dialog.scrollTop = dialog.scrollHeight;
    };
    const form = h("form", { method: "dialog", onsubmit: async (event: Event) => {
      event.preventDefault();
      if (guarded && pending) return;
      if (!options.submit) { finish(true); return; }
      const values = read();
      saving(true);
      error.hidden = true;
      try { await options.submit(values); finish(true); }
      catch (failure) {
        const message = failure instanceof Error ? failure.message : String(failure);
        error.textContent = muse && message === "Failed to fetch" ? t("requestResultUnavailable") : hostText(message); error.hidden = false; saving(false);
        if (options.protectDraft || muse) dialog.scrollTop = dialog.scrollHeight;
      }
    } }, h("h2", {}, options.title), options.message ? h("p", { className: "muted" }, options.message) : null, options.content ?? null, ...fields, error, progress,
      h("div", { className: "dialog-actions" }, cancel, confirm));
    dialog.append(form);
    dialog.addEventListener("cancel", event => { event.preventDefault(); void attempt(); });
    closeOnBackdrop(dialog, () => void attempt());
    document.body.append(dialog);
    dialog.showModal();
    placeToasts();
    const first = controls.find(input => !input.disabled && !(input instanceof HTMLInputElement && input.type === "checkbox"));
    (first ?? (muse && options.destructive ? cancel ?? confirm : confirm)).focus();
  });
}

export interface MenuItem { label: string; icon?: IconName; destructive?: boolean; testID?: string; run(): void }
let closeOpenMenu = () => {};

export function menu(anchor: HTMLElement, items: MenuItem[], options: { className?: string; focus?: boolean } = {}) {
  closeOpenMenu();
  const focus = options.focus ?? true;
  const muse = document.documentElement.hasAttribute("data-muse");
  const element = h("div", { className: `menu${options.className ? ` ${options.className}` : ""}`, role: "menu", "data-testid": "menu" }, ...items.map(item => h("button", { type: "button", role: "menuitem",
    className: `menu-item${item.destructive ? " danger" : ""}`, "data-testid": item.testID ?? null,
    onclick: () => { close(); if (muse && focus) returnFocus(anchor); item.run(); } }, item.icon ? icon(item.icon, 18) : null, h("span", {}, item.label))));
  if (!focus) element.addEventListener("mousedown", event => event.preventDefault());
  const outside = (event: PointerEvent) => { if (!element.contains(event.target as Node) && !anchor.contains(event.target as Node)) close(); };
  const keys = (event: KeyboardEvent) => {
    const inside = element.contains(document.activeElement);
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); if (focus || inside) { if (muse) returnFocus(anchor); else anchor.focus(); } return; }
    if (muse && event.key === "Tab") { close(); if (inside) returnFocus(anchor); return; }
    if (muse && inside && (event.key === "Home" || event.key === "End")) {
      event.preventDefault();
      const buttons = [...element.querySelectorAll("button")];
      (event.key === "Home" ? buttons[0] : buttons.at(-1))?.focus();
      return;
    }
    if ((event.key !== "ArrowDown" && event.key !== "ArrowUp") || (!focus && !inside)) return;
    event.preventDefault();
    const buttons = [...element.querySelectorAll("button")], index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    buttons[(index + (event.key === "ArrowDown" ? 1 : buttons.length - 1)) % buttons.length]?.focus();
  };
  function close() {
    const restore = muse && element.contains(document.activeElement);
    element.remove();
    anchor.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", outside, true);
    document.removeEventListener("keydown", keys, true);
    window.removeEventListener("resize", close);
    closeOpenMenu = () => {};
    if (restore) returnFocus(anchor);
  }
  (anchor.closest("dialog[open]") ?? document.body).append(element);
  const feedback = muse ? document.querySelector<HTMLElement>(".toasts:not(:empty)") : null;
  const bottom = Math.min(innerHeight - 8, feedback ? feedback.getBoundingClientRect().top - 8 : innerHeight - 8);
  if (muse) element.style.maxHeight = `${Math.max(0, bottom - 8)}px`;
  const rect = anchor.getBoundingClientRect(), width = element.offsetWidth, height = element.offsetHeight;
  const below = rect.bottom + 6 + height <= bottom;
  element.style.left = `${Math.round(Math.min(Math.max(8, rect.right - width), innerWidth - width - 8))}px`;
  element.style.top = `${Math.round(below ? rect.bottom + 6 : Math.max(8, muse ? Math.min(rect.top - height - 6, bottom - height) : rect.top - height - 6))}px`;
  element.dataset.side = below ? "bottom" : "top";
  anchor.setAttribute("aria-expanded", "true");
  if (muse) anchor.setAttribute("aria-haspopup", "menu");
  document.addEventListener("pointerdown", outside, true);
  document.addEventListener("keydown", keys, true);
  window.addEventListener("resize", close);
  closeOpenMenu = close;
  if (focus) (element.querySelector("button") as HTMLButtonElement | null)?.focus({ preventScroll: true });
  return close;
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

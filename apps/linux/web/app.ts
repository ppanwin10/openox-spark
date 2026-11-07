import { h, icon, type IconName } from "./dom";
import { markdown, type Resolve } from "./markdown";
import { locale, t } from "./i18n";

type ModelChoice = { provider: string; modelId: string; thinkingLevel?: string };
type Summary = { id: number; title: string; model: ModelChoice | null; createdAt: number; lastActivity: number | null; unread: boolean; favorite: boolean; busy: boolean };
type Kind = { type: string; [key: string]: unknown };
type Block = { id: string; createdAt: number; kind: Kind };
type Prompt = { id: string; prompt: string; options: string[] };
type View = { summary: Summary; blocks: Block[]; busy: boolean; pendingPrompt?: Prompt; follow: { label: string; message: string }[]; error: string | null };
type ModelInfo = { id: string; name: string };
type Provider = { id: string; name: string; configured: boolean; custom: boolean; baseUrl: string; models: ModelInfo[] };
type Settings = { host: { id: string; version: string }; profile: { id: string; name: string }; storage: string; defaultModel: ModelChoice | null;
  providers: Provider[]; custom: { baseUrl: string; models: string[]; name?: string } | null; customKey: boolean };
type Device = { id: string; name: string; kind: string; createdAt: string; lastSeenAt: string | null };
type Entry = { path: string; name: string; kind: "file" | "directory"; size: number; modified: number };
type Invocation = { id: string; name: string; purpose: string; args: { source?: string; path?: string }; outcome: Record<string, { _0?: unknown }> };
type Route = { name: "chat"; id: number | null } | { name: "list" } | { name: "files"; path: string } | { name: "settings" };

const roots = new Set(["app", "MEMORY.md", "skills", "repositories", "mounts", "files", "artifacts", "conversations", "history", "chats", "tmp"]);
const imageExtensions = /\.(png|jpe?g|gif|webp|svg)$/i;
const app = document.getElementById("app")!;
const wide = window.matchMedia("(min-width: 900px)");
const state = {
  paired: false,
  deviceID: "",
  settings: null as Settings | null,
  conversations: [] as Summary[],
  route: { name: "chat", id: null } as Route,
  view: null as View | null,
  draftModel: null as ModelChoice | null,
  drafts: new Map<string, string>(),
  attachments: [] as { path: string; name: string }[],
  uploading: 0,
  expanded: new Set<string>(),
  optimistic: null as { id: number; text: string; files: string[]; users: number } | null,
  online: true,
  sending: false,
};
let events: EventSource | undefined;
let main: HTMLElement | undefined;
let sidebar: HTMLElement | undefined;
let transcriptRoot: HTMLElement | undefined;
let composerRefs: { textarea: HTMLTextAreaElement; send: HTMLButtonElement; chips: HTMLElement; follow: HTMLElement } | undefined;
const blockCache = new Map<string, { signature: string; element: HTMLElement }>();

class APIError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init;
  const response = await fetch(path, { ...rest, credentials: "same-origin",
    headers: { ...(json === undefined ? {} : { "content-type": "application/json" }), ...rest.headers },
    body: json === undefined ? rest.body : JSON.stringify(json) });
  const body = await response.json().catch(() => ({})) as { error?: string };
  if (response.status === 401 && state.paired) { state.paired = false; renderPairing(); }
  if (!response.ok) throw new APIError(response.status, body.error ?? `${t("error")} (${response.status})`);
  return body as T;
}

function toast(message: string, kind: "info" | "error" = "info") {
  const region = document.querySelector(".toasts") ?? document.body.appendChild(h("div", { className: "toasts", role: "status", "aria-live": "polite" }));
  const element = h("div", { className: `toast ${kind}`, "data-testid": `toast-${kind}` }, icon(kind === "error" ? "close" : "check", 16), h("span", {}, message));
  region.append(element);
  setTimeout(() => element.classList.add("leaving"), kind === "error" ? 5_000 : 1_800);
  setTimeout(() => element.remove(), kind === "error" ? 5_400 : 2_200);
}
const failed = (error: unknown) => toast(error instanceof Error ? error.message : String(error), "error");

function ask(options: { title: string; message?: string; input?: { value: string; label: string; type?: string }; confirm?: string; destructive?: boolean;
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

function relativeTime(milliseconds: number | null) {
  if (!milliseconds) return "";
  const date = new Date(milliseconds);
  const now = new Date();
  if (now.getTime() - milliseconds < 60_000) return t("justNow");
  if (date.toDateString() === now.toDateString()) return date.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
  if (now.getTime() - milliseconds < 6 * 86_400_000) return date.toLocaleDateString(locale, { weekday: "short" });
  return date.toLocaleDateString(locale, { month: "short", day: "numeric", ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }) });
}
function size(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10_240 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
const fileURL = (path: string, download = false) => `/api/files/content?path=${encodeURIComponent(path)}${download ? "&download=1" : ""}`;
function normalize(path: string) {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop(); else parts.push(part);
  }
  return parts.join("/");
}
function resolver(conversation: number | null): Resolve {
  return target => {
    if (/^(https?:|mailto:)/i.test(target)) return { href: target, file: false, image: false };
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//") || target.startsWith("#")) return undefined;
    let clean = target.split(/[?#]/)[0]!;
    try { clean = decodeURI(clean); } catch {}
    const absolute = clean.startsWith("/") || roots.has(clean.split("/")[0]!);
    const path = normalize(absolute || conversation === null ? clean : `conversations/${conversation}/${clean}`);
    if (!path) return undefined;
    return { href: fileURL(path), file: true, image: imageExtensions.test(path) };
  };
}

function parseRoute(): Route {
  const hash = location.hash.replace(/^#\/?/, "");
  const [name, ...rest] = hash.split("/");
  if (name === "c" && /^\d+$/.test(rest[0] ?? "")) return { name: "chat", id: Number(rest[0]) };
  if (name === "files") return { name: "files", path: normalize(rest.map(part => decodeURIComponent(part)).join("/")) };
  if (name === "settings") return { name: "settings" };
  if (name === "list") return { name: "list" };
  return { name: "chat", id: null };
}
function go(hash: string, replace = false) {
  if (location.hash === hash) { route(); return; }
  if (replace) { history.replaceState(null, "", hash); route(); } else location.hash = hash;
}
const filesHash = (path: string) => `#/files${path ? "/" + path.split("/").map(encodeURIComponent).join("/") : ""}`;

function choiceKey(choice: ModelChoice | null) { return choice ? JSON.stringify([choice.provider, choice.modelId]) : ""; }
function modelName(choice: ModelChoice | null) {
  if (!choice) return t("noModels");
  const provider = state.settings?.providers.find(item => item.id === choice.provider);
  return provider?.models.find(model => model.id === choice.modelId)?.name ?? choice.modelId;
}
function modelSelect(current: ModelChoice | null, disabled: boolean, onchange: (choice: ModelChoice) => void, testID: string) {
  const configured = state.settings?.providers.filter(provider => provider.configured && provider.models.length) ?? [];
  if (!configured.length) return h("a", { href: "#/settings", className: "model-chip", "data-testid": testID }, h("span", { className: "model-name" }, t("addModel")));
  const select = h("select", { className: "model-select", "aria-label": t("model"), disabled: disabled || !configured.length, "data-testid": testID },
    !configured.length ? h("option", { value: "" }, t("noModels")) : null,
    ...configured.map(provider => h("optgroup", { label: provider.name }, ...provider.models.map(model =>
      h("option", { value: choiceKey({ provider: provider.id, modelId: model.id }) }, model.name)))));
  if (current && !configured.some(provider => provider.id === current.provider && provider.models.some(model => model.id === current.modelId))) {
    select.prepend(h("option", { value: choiceKey(current) }, current.modelId));
  }
  select.value = choiceKey(current);
  select.addEventListener("change", () => {
    const [provider, modelId] = JSON.parse(select.value) as [string, string];
    onchange({ provider, modelId });
  });
  return h("label", { className: "model-chip" }, h("span", { className: "model-name" }, modelName(current)), icon("chevron", 14), select);
}

async function loadSettings() { state.settings = await api<Settings>("/api/settings"); state.draftModel ??= state.settings.defaultModel; }
async function loadConversations() {
  state.conversations = (await api<{ items: Summary[] }>("/api/conversations")).items;
  renderSidebarList();
}
let listTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleList() { clearTimeout(listTimer); listTimer = setTimeout(() => { void loadConversations().catch(() => {}); }, 250); }
let viewTimer: ReturnType<typeof setTimeout> | undefined;
let viewLoading: Promise<void> | undefined;
function scheduleView(delay = 60) {
  clearTimeout(viewTimer);
  viewTimer = setTimeout(() => { void loadView(); }, delay);
}
async function loadView() {
  if (state.route.name !== "chat" || state.route.id === null) return;
  const id = state.route.id;
  if (viewLoading) { await viewLoading; scheduleView(); return; }
  viewLoading = (async () => {
    try {
      const view = await api<View>(`/api/conversations/${id}`);
      if (state.route.name !== "chat" || state.route.id !== id) return;
      state.view = view;
      renderConversation();
      if (!state.conversations.some(item => item.id === id && item.title === view.summary.title && item.busy === view.busy)) scheduleList();
      if (view.summary.unread && document.visibilityState === "visible") void api(`/api/conversations/${id}/read`, { method: "POST" }).then(scheduleList, () => {});
    } catch (error) {
      if (error instanceof APIError && error.status === 404) { toast(error.message, "error"); go("#/", true); }
    } finally { viewLoading = undefined; }
  })();
  await viewLoading;
}

function connectEvents() {
  events?.close();
  events = new EventSource("/api/events");
  events.addEventListener("ready", () => {
    if (!state.online) { state.online = true; renderOffline(); void refresh(); }
  });
  events.addEventListener("conversation", event => {
    const { id } = JSON.parse((event as MessageEvent).data) as { id: number };
    if (state.route.name === "chat" && state.route.id === id) scheduleView();
    scheduleList();
  });
  events.addEventListener("settings", () => { void loadSettings().then(() => { if (state.route.name === "settings") renderMain(); else renderConversationHeader(); }).catch(() => {}); });
  events.addEventListener("devices", () => { void checkSession(); });
  events.onerror = () => {
    if (state.online) { state.online = false; renderOffline(); }
    void checkSession();
  };
}

async function checkSession() {
  try {
    const session = await api<{ paired: boolean; device: Device | null }>("/api/session");
    if (!session.paired) { state.paired = false; events?.close(); renderPairing(); }
  } catch {}
}

async function refresh() {
  await Promise.all([loadSettings(), loadConversations()]).catch(failed);
  if (state.route.name === "chat") await loadView(); else renderMain();
}

function renderOffline() {
  document.querySelector(".offline")?.remove();
  if (!state.online && state.paired) document.body.append(h("div", { className: "offline", role: "status" }, t("offline")));
}

function renderPairing() {
  blockCache.clear();
  transcriptRoot = undefined;
  const code = h("input", { className: "field code-field", inputmode: "text", autocomplete: "one-time-code", autocapitalize: "characters", spellcheck: "false",
    placeholder: "ABCD-EFGH", maxlength: 12, required: true, "aria-label": t("pairCode"), "data-testid": "pair-code" });
  const guess = /iPhone/.test(navigator.userAgent) ? "iPhone" : /iPad/.test(navigator.userAgent) ? "iPad" : /Android/.test(navigator.userAgent) ? "Android"
    : /Mac/.test(navigator.platform) ? "Mac" : /Win/.test(navigator.platform) ? "Windows" : "Browser";
  const name = h("input", { className: "field", value: guess, maxlength: 80, required: true, "aria-label": t("deviceName"), "data-testid": "pair-name" });
  const button = h("button", { type: "submit", className: "button primary wide", "data-testid": "pair-submit" }, t("pair"));
  const message = h("p", { className: "form-error", role: "alert", "data-testid": "pair-error" });
  const form = h("form", { className: "pair-card", onsubmit: async (event: Event) => {
    event.preventDefault();
    button.disabled = true;
    button.textContent = t("pairing");
    message.textContent = "";
    try {
      await api("/api/pair", { method: "POST", json: { code: code.value, name: name.value } });
      await start();
    } catch (error) {
      message.textContent = error instanceof Error ? error.message : String(error);
      button.disabled = false;
      button.textContent = t("pair");
    }
  } },
    h("img", { src: "/icon.svg", alt: "", className: "pair-icon", width: 64, height: 64 }),
    h("h1", {}, t("pairTitle")),
    h("p", { className: "muted" }, t("pairBody")),
    h("label", { className: "stack" }, h("span", { className: "label" }, t("pairCode")), code),
    h("label", { className: "stack" }, h("span", { className: "label" }, t("deviceName")), name),
    message, button);
  app.replaceChildren(h("main", { className: "pair-page" }, form));
  code.focus();
}

function navRow(label: string, iconName: IconName, hash: string, active: boolean, testID: string) {
  return h("a", { href: hash, className: `nav-row${active ? " active" : ""}`, "data-testid": testID }, icon(iconName), h("span", {}, label));
}

function renderShell() {
  sidebar = h("aside", { className: "sidebar", "aria-label": t("conversations") });
  main = h("main", { className: "main" });
  const pane = state.route.name === "list" ? "list" : "main";
  app.replaceChildren(h("div", { className: "shell", "data-pane": pane }, sidebar, main));
  renderSidebar();
  renderMain();
}

function renderSidebar() {
  if (!sidebar) return;
  const route = state.route;
  sidebar.replaceChildren(
    h("div", { className: "sidebar-head" },
      h("div", { className: "brand" }, h("img", { src: "/icon.svg", alt: "", width: 28, height: 28 }),
        h("div", {}, h("div", { className: "brand-name" }, t("appName")), h("div", { className: "brand-profile" }, state.settings?.profile.name ?? ""))),
      h("a", { href: "#/", className: "icon-button", "aria-label": t("newChat"), title: t("newChat"), "data-testid": "new-chat" }, icon("compose"))),
    h("nav", { className: "conversation-list", "data-testid": "conversation-list" }),
    h("div", { className: "sidebar-foot" },
      navRow(t("files"), "folder", "#/files", route.name === "files", "nav-files"),
      navRow(t("settings"), "gear", "#/settings", route.name === "settings", "nav-settings")));
  renderSidebarList();
}

function renderSidebarList() {
  const list = sidebar?.querySelector(".conversation-list");
  if (!list) return;
  const current = state.route.name === "chat" ? state.route.id : null;
  list.replaceChildren(
    h("div", { className: "section-label" }, t("conversations")),
    ...(state.conversations.length ? state.conversations.map(item => h("a", { href: `#/c/${item.id}`, className: `conversation-row${item.id === current ? " active" : ""}`,
      "data-testid": `conversation-${item.id}`, "aria-current": item.id === current ? "page" : null },
      h("span", { className: "row-title" }, item.title || t("untitled")),
      h("span", { className: "row-meta" }, item.busy ? h("span", { className: "dot busy", "aria-label": t("working") })
        : item.unread ? h("span", { className: "dot unread", "aria-label": "unread" }) : null, relativeTime(item.lastActivity))))
      : [h("p", { className: "empty-list" }, t("noConversations"))]));
}

function renderMain() {
  if (!main) return;
  blockCache.clear();
  transcriptRoot = undefined;
  composerRefs = undefined;
  if (state.route.name === "files") renderFiles(state.route.path);
  else if (state.route.name === "settings") renderSettings();
  else if (state.route.name === "chat") renderChat();
  else main.replaceChildren();
}

function topbar(title: Node | string, ...actions: (Node | null)[]) {
  return h("header", { className: "topbar" },
    h("a", { href: "#/list", className: "icon-button sidebar-toggle", "aria-label": t("conversations"), "data-testid": "open-sidebar" }, icon("sidebar")),
    typeof title === "string" ? h("h1", { className: "topbar-title" }, title) : title, h("div", { className: "topbar-actions" }, ...actions));
}

function renderChat() {
  const id = state.route.name === "chat" ? state.route.id : null;
  const header = h("div", { className: "conversation-header" });
  transcriptRoot = h("div", { className: "transcript", "data-testid": "transcript" });
  const scroller = h("div", { className: "scroller" }, transcriptRoot);
  const composer = renderComposer(id);
  main!.replaceChildren(header, scroller, composer);
  renderConversationHeader();
  if (id === null) {
    state.view = null;
    const ready = state.settings?.providers.some(provider => provider.configured && provider.models.length);
    transcriptRoot.append(h("div", { className: "empty-state", "data-testid": "empty-state" }, h("h2", {}, t("emptyTitle")),
      h("p", { className: "muted" }, ready ? t("emptyBody") : t("noProviders")),
      ready ? null : h("a", { href: "#/settings", className: "button primary", "data-testid": "add-model" }, t("addModel"))));
  } else if (state.view?.summary.id === id) renderConversation(true);
  else void loadView().then(() => scrollToEnd(true));
  updateComposer();
}

function renderConversationHeader() {
  const header = main?.querySelector(".conversation-header");
  if (!header) return;
  const id = state.route.name === "chat" ? state.route.id : null;
  const view = id !== null && state.view?.summary.id === id ? state.view : null;
  const model = id === null ? state.draftModel ?? state.settings?.defaultModel ?? null : view?.summary.model ?? null;
  const picker = modelSelect(model, !!view?.busy, choice => {
    if (id === null) { state.draftModel = choice; renderConversationHeader(); return; }
    void api(`/api/conversations/${id}`, { method: "PATCH", json: { model: choice } }).then(() => loadView(), error => { failed(error); renderConversationHeader(); });
  }, "model-picker");
  const more = id === null ? null : h("button", { type: "button", className: "icon-button", "aria-label": t("rename"), "data-testid": "conversation-menu", onclick: () => void conversationMenu(id) }, icon("more"));
  header.replaceChildren(topbar(h("div", { className: "topbar-title" }, h("h1", {}, view?.summary.title || (id === null ? t("newChat") : t("untitled")))), picker, more));
}

async function conversationMenu(id: number) {
  const action = await ask({ title: state.view?.summary.title || t("untitled"), actions: [{ label: t("rename"), value: "rename" }, { label: t("delete"), value: "delete", destructive: true }] });
  if (action === "rename") {
    const title = await ask({ title: t("renameTitle"), input: { value: state.view?.summary.title ?? "", label: t("renameTitle") }, confirm: t("save") });
    if (title?.trim()) await api(`/api/conversations/${id}`, { method: "PATCH", json: { title } }).then(() => { void loadView(); scheduleList(); }, failed);
  } else if (action === "delete") {
    if (await ask({ title: t("deleteTitle"), message: t("deleteBody"), confirm: t("delete"), destructive: true }) !== "confirm") return;
    await api(`/api/conversations/${id}`, { method: "DELETE" }).then(() => { state.view = null; scheduleList(); go("#/", true); }, failed);
  }
}

function renderComposer(id: number | null) {
  const key = id === null ? "new" : String(id);
  const textarea = h("textarea", { className: "composer-input", rows: 1, placeholder: t("messagePlaceholder"), "aria-label": t("messagePlaceholder"), "data-testid": "composer-input" });
  textarea.value = state.drafts.get(key) ?? "";
  const resize = () => { textarea.style.height = "auto"; textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`; };
  textarea.addEventListener("input", () => { state.drafts.set(key, textarea.value); resize(); updateComposer(); });
  textarea.addEventListener("keydown", event => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing && wide.matches) { event.preventDefault(); void send(); }
  });
  const picker = h("input", { type: "file", multiple: true, hidden: true, "data-testid": "attach-input" });
  picker.addEventListener("change", () => { void attach([...picker.files ?? []]); picker.value = ""; });
  const sendButton = h("button", { type: "button", className: "send-button", "data-testid": "send", onclick: () => void (state.view?.busy ? stop() : send()) }, icon("send"));
  const chips = h("div", { className: "attachment-chips" });
  const follow = h("div", { className: "follow-chips" });
  composerRefs = { textarea, send: sendButton, chips, follow };
  queueMicrotask(resize);
  return h("div", { className: "composer-wrap" }, follow,
    h("div", { className: "composer", "data-testid": "composer" }, chips, textarea,
      h("div", { className: "composer-actions" },
        h("button", { type: "button", className: "icon-button", "aria-label": t("attach"), title: t("attach"), "data-testid": "attach", onclick: () => picker.click() }, icon("clip")),
        h("div", { className: "spacer" }), sendButton)), picker);
}

function updateComposer() {
  if (!composerRefs) return;
  const busy = !!state.view?.busy && state.route.name === "chat" && state.view.summary.id === state.route.id;
  const ready = !!composerRefs.textarea.value.trim() || state.attachments.length > 0;
  composerRefs.send.replaceChildren(icon(busy ? "stop" : "send", busy ? 16 : 20));
  composerRefs.send.setAttribute("aria-label", busy ? t("stop") : t("send"));
  composerRefs.send.dataset.state = busy ? "stop" : "send";
  composerRefs.send.disabled = !busy && (!ready || state.uploading > 0 || state.sending || !state.settings?.providers.some(provider => provider.configured));
  composerRefs.chips.replaceChildren(...state.attachments.map(file => h("span", { className: "chip", "data-testid": "attachment-chip" }, icon("file", 14), h("span", {}, file.name),
    h("button", { type: "button", className: "chip-remove", "aria-label": t("removeAttachment"), onclick: () => {
      state.attachments = state.attachments.filter(item => item !== file); updateComposer();
    } }, icon("close", 12)))), ...(state.uploading ? [h("span", { className: "chip muted" }, t("uploading"))] : []));
  const intents = !busy ? state.view?.follow ?? [] : [];
  composerRefs.follow.replaceChildren(...intents.map(intent => h("button", { type: "button", className: "follow-chip", "data-testid": "follow-chip",
    onclick: () => { composerRefs!.textarea.value = intent.message; void send(); } }, intent.label)));
}

async function ensureConversation() {
  if (state.route.name === "chat" && state.route.id !== null) return state.route.id;
  const created = await api<{ id: number }>("/api/conversations", { method: "POST", json: { model: state.draftModel ?? state.settings?.defaultModel ?? undefined } });
  const draft = state.drafts.get("new");
  if (draft !== undefined) { state.drafts.set(String(created.id), draft); state.drafts.delete("new"); }
  history.replaceState(null, "", `#/c/${created.id}`);
  state.route = { name: "chat", id: created.id };
  return created.id;
}

async function attach(files: File[]) {
  if (!files.length) return;
  try {
    const id = await ensureConversation();
    state.uploading += files.length;
    updateComposer();
    for (const file of files) {
      try {
        const stored = await api<Entry>(`/api/conversations/${id}/attachments?name=${encodeURIComponent(file.name)}`, { method: "POST", body: file });
        state.attachments.push({ path: stored.path, name: stored.name });
      } catch (error) { failed(error); }
      finally { state.uploading -= 1; updateComposer(); }
    }
  } catch (error) { failed(error); }
}

async function send() {
  if (!composerRefs || state.sending) return;
  const text = composerRefs.textarea.value.trim();
  if (!text && !state.attachments.length) return;
  state.sending = true;
  updateComposer();
  try {
    const id = await ensureConversation();
    const files = state.attachments.map(file => file.path);
    const users = state.view?.summary.id === id ? state.view.blocks.filter(block => block.kind.type === "userText").length : 0;
    await api(`/api/conversations/${id}/messages`, { method: "POST", json: { text, attachments: files } });
    state.optimistic = { id, text, files, users };
    state.attachments = [];
    state.drafts.delete(String(id));
    state.drafts.delete("new");
    composerRefs.textarea.value = "";
    composerRefs.textarea.style.height = "auto";
    if (state.view?.summary.id !== id) {
      state.view = null;
      renderMain();
    }
    if (state.view) state.view = { ...state.view, busy: true, follow: [] };
    renderConversation();
    scrollToEnd(true);
    scheduleView(150);
    scheduleList();
  } catch (error) { failed(error); }
  finally { state.sending = false; updateComposer(); }
}

async function stop() {
  if (state.route.name !== "chat" || state.route.id === null) return;
  await api(`/api/conversations/${state.route.id}/stop`, { method: "POST" }).catch(failed);
  scheduleView();
}

function nearEnd() {
  const scroller = transcriptRoot?.parentElement;
  return !scroller || scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120;
}
function scrollToEnd(force = false) {
  const scroller = transcriptRoot?.parentElement;
  if (scroller && force) requestAnimationFrame(() => { scroller.scrollTop = scroller.scrollHeight; });
}

function renderConversation(initial = false) {
  if (!transcriptRoot || state.route.name !== "chat") return;
  const view = state.view;
  if (!view || view.summary.id !== state.route.id) return;
  const stick = initial || nearEnd();
  const users = view.blocks.filter(block => block.kind.type === "userText").length;
  if (state.optimistic && (state.optimistic.id !== view.summary.id || users > state.optimistic.users)) state.optimistic = null;
  const resolve = resolver(view.summary.id);
  const elements: HTMLElement[] = [];
  const seen = new Set<string>();
  for (const block of view.blocks) {
    const signature = JSON.stringify(block.kind) + (state.expanded.has(block.id) ? "+" : "");
    seen.add(block.id);
    let cached = blockCache.get(block.id);
    if (!cached || cached.signature !== signature) {
      cached = { signature, element: blockElement(block, resolve, !!view.pendingPrompt) };
      blockCache.set(block.id, cached);
    }
    elements.push(cached.element);
  }
  for (const key of [...blockCache.keys()]) if (!seen.has(key)) blockCache.delete(key);
  if (state.optimistic) elements.push(userBubble(state.optimistic.text, state.optimistic.files, resolve));
  const last = view.blocks.at(-1);
  const streaming = last?.kind.type === "agentContent" && view.busy;
  if (view.busy && !view.pendingPrompt && !streaming) elements.push(h("div", { className: "working", "data-testid": "working" }, h("span", { className: "plow" }, h("i"), h("i"), h("i")), t("working")));
  if (view.error && !view.busy) elements.push(h("div", { className: "turn agent failure", "data-testid": "run-error" }, h("p", {}, view.error)));
  transcriptRoot.replaceChildren(...elements);
  renderConversationHeader();
  updateComposer();
  if (stick) scrollToEnd(true);
}

function userBubble(text: string, files: string[], resolve: Resolve) {
  return h("div", { className: "turn user", "data-testid": "user-message" },
    files.length ? h("div", { className: "bubble-files" }, ...files.map(path => {
      const target = resolve(`/${path}`);
      return h("a", { className: "chip", href: target?.href ?? "#", target: "_blank", rel: "noopener noreferrer" }, icon("file", 14), h("span", {}, path.split("/").at(-1)!));
    })) : null,
    text ? h("div", { className: "bubble" }, text) : null);
}

function blockElement(block: Block, resolve: Resolve, pending: boolean): HTMLElement {
  const kind = block.kind;
  if (kind.type === "userText") return userBubble(String(kind.text ?? ""), (kind.files as string[] | undefined) ?? [], resolve);
  if (kind.type === "agentContent") {
    const items = (kind.items as { text?: string; progress?: string }[]) ?? [];
    return h("div", { className: `turn agent${kind.failure ? " failure" : ""}`, "data-testid": kind.failure ? "agent-failure" : "agent-message" },
      ...items.map(item => item.text !== undefined
        ? h("div", { className: "markdown" }, markdown(item.text, resolve, locale === "zh-Hans" ? "复制" : "Copy"))
        : item.progress !== undefined ? h("div", { className: "progress-line", "data-testid": "progress" }, icon("spark", 14), h("span", {}, item.progress)) : null));
  }
  if (kind.type === "thinking") return activity(block);
  if (kind.type === "confirm") return requestCard(block, pending);
  return h("div");
}

function stepIcon(outcome: Invocation["outcome"]) {
  if ("running" in outcome) return h("span", { className: "spinner", "aria-hidden": "true" });
  return h("span", { className: `step-status ${"failed" in outcome ? "error" : "ok"}` }, icon("failed" in outcome ? "close" : "check", 12));
}

function activity(block: Block) {
  const trace = block.kind.trace as { entries: { kind: string; invocation?: Invocation; reasoning?: { id: string; text: string } }[]; completedAt?: number };
  const invocations = trace.entries.flatMap(entry => entry.invocation ? [entry.invocation] : []);
  const running = invocations.filter(invocation => "running" in invocation.outcome);
  const failedCount = invocations.filter(invocation => "failed" in invocation.outcome).length;
  const expanded = state.expanded.has(block.id);
  const label = running.length ? (running.at(-1)!.purpose || running.at(-1)!.name) : `${t("activity")} · ${invocations.length === 1 ? t("step") : t("steps", { count: invocations.length })}`;
  const toggle = h("button", { type: "button", className: "activity-summary", "aria-expanded": expanded ? "true" : "false", "data-testid": "activity-toggle",
    onclick: () => { if (state.expanded.has(block.id)) state.expanded.delete(block.id); else state.expanded.add(block.id); renderConversation(); } },
    running.length ? h("span", { className: "spinner", "aria-hidden": "true" }) : h("span", { className: `step-status ${failedCount ? "error" : "ok"}` }, icon(failedCount ? "close" : "check", 12)),
    h("span", { className: running.length ? "shimmer" : "" }, label), icon("chevron", 14));
  const details = expanded ? h("div", { className: "activity-steps" }, ...trace.entries.map(entry => {
    if (entry.reasoning) return h("div", { className: "step reasoning" }, h("span", { className: "step-name" }, t("reasoning")), h("p", {}, entry.reasoning.text));
    const invocation = entry.invocation!;
    const result = Object.values(invocation.outcome)[0]?._0;
    return h("div", { className: "step", "data-testid": "activity-step" }, stepIcon(invocation.outcome),
      h("div", { className: "step-body" },
        h("div", { className: "step-title" }, invocation.purpose || invocation.name, invocation.purpose ? h("span", { className: "step-name" }, invocation.name) : null),
        invocation.args.path ? h("a", { href: fileURL(invocation.args.path), target: "_blank", rel: "noopener noreferrer", className: "file-link step-path" }, invocation.args.path) : null,
        invocation.args.source ? h("details", { className: "code" }, h("summary", {}, t("showCode")), h("pre", {}, h("code", {}, invocation.args.source)),
          typeof result === "string" && result ? h("pre", { className: "result" }, h("code", {}, result)) : null) : null));
  })) : null;
  return h("div", { className: `activity${running.length ? " running" : ""}`, "data-testid": "activity" }, toggle, details);
}

function requestCard(block: Block, pending: boolean) {
  const kind = block.kind as Kind & { prompt: string; options: string[]; answer?: string; promptId?: string };
  const card = h("div", { className: "request-card", "data-testid": kind.promptId ? "pending-choice" : "resolved-choice" }, h("p", { className: "request-prompt" }, kind.prompt));
  if (kind.promptId && pending && state.route.name === "chat" && state.route.id !== null) {
    const id = state.route.id;
    const respond = async (answer: string) => {
      card.querySelectorAll("button, input").forEach(element => (element as HTMLButtonElement).disabled = true);
      await api(`/api/conversations/${id}/respond`, { method: "POST", json: { promptId: kind.promptId, answer } }).catch(failed);
      scheduleView();
    };
    const custom = h("input", { className: "field", placeholder: t("customAnswer"), "aria-label": t("customAnswer"), maxlength: 2000, "data-testid": "choice-custom" });
    card.append(h("div", { className: "request-options" }, ...kind.options.map(option => h("button", { type: "button", className: "button secondary", "data-testid": "choice-option",
      onclick: () => void respond(option) }, option))),
      h("form", { className: "request-custom", onsubmit: (event: Event) => { event.preventDefault(); if (custom.value.trim()) void respond(custom.value.trim()); } },
        custom, h("button", { type: "submit", className: "button primary" }, t("submit"))));
  } else card.append(h("p", { className: "muted" }, kind.answer !== undefined ? t("answered", { answer: kind.answer }) : t("notAnswered")));
  return card;
}

async function renderFiles(path: string) {
  const crumbs = path ? path.split("/") : [];
  const titles = new Map(state.conversations.map(item => [String(item.id), item.title || t("untitled")]));
  const label = (segment: string, index: number) => index === 0 && segment === "conversations" ? t("conversationFiles")
    : crumbs[0] === "conversations" && index === 1 ? titles.get(segment) ?? segment : segment;
  const list = h("div", { className: "file-list", "data-testid": "file-list" });
  const picker = h("input", { type: "file", multiple: true, hidden: true, "data-testid": "upload-input" });
  picker.addEventListener("change", () => { void upload(path, [...picker.files ?? []]); picker.value = ""; });
  main!.replaceChildren(
    topbar(t("files"),
      h("button", { type: "button", className: "button secondary small", "data-testid": "new-folder", onclick: () => void newFolder(path) }, icon("plus", 16), h("span", { className: "label-text" }, t("newFolder"))),
      h("button", { type: "button", className: "button primary small", "data-testid": "upload", onclick: () => picker.click() }, icon("upload", 16), h("span", { className: "label-text" }, t("upload")))),
    h("div", { className: "page" },
      crumbs.length ? h("nav", { className: "breadcrumbs", "aria-label": "Breadcrumb" },
        h("a", { href: filesHash("") }, t("files")),
        ...crumbs.flatMap((segment, index) => [icon("chevron", 14), h("a", { href: filesHash(crumbs.slice(0, index + 1).join("/")) }, label(segment, index))])) : null,
      list), picker);
  try {
    const { entries } = await api<{ entries: Entry[] }>(`/api/files?path=${encodeURIComponent(path)}`);
    if (state.route.name !== "files" || state.route.path !== path) return;
    const sorted = [...entries].sort((a, b) => Number(b.kind === "directory") - Number(a.kind === "directory") || a.name.localeCompare(b.name));
    list.replaceChildren(...(sorted.length ? sorted.map(entry => fileRow(entry, path, label)) : [h("p", { className: "empty-list" }, t("emptyFolder"))]));
  } catch (error) { list.replaceChildren(h("p", { className: "form-error" }, error instanceof Error ? error.message : String(error))); }
}

function fileRow(entry: Entry, parent: string, label: (segment: string, index: number) => string) {
  const depth = parent ? parent.split("/").length : 0;
  const name = label(entry.name, depth);
  const main = entry.kind === "directory"
    ? h("a", { href: filesHash(entry.path), className: "file-main", "data-testid": "file-row" }, icon("folder"), h("span", { className: "file-text" }, h("span", { className: "file-name" }, name)))
    : h("a", { href: fileURL(entry.path), target: "_blank", rel: "noopener noreferrer", className: "file-main", "data-testid": "file-row" }, icon("file"),
      h("span", { className: "file-text" }, h("span", { className: "file-name" }, name), h("span", { className: "file-meta" }, `${size(entry.size)} · ${relativeTime(entry.modified)}`)));
  const managed = entry.kind === "directory" && /^conversations(\/\d+)?$/.test(entry.path);
  const menu = managed ? h("span", { className: "icon-spacer" }) : h("button", { type: "button", className: "icon-button", "aria-label": entry.name, "data-testid": "file-menu", onclick: () => void fileMenu(entry, parent) }, icon("more"));
  return h("div", { className: "file-row" }, main, menu);
}

async function fileMenu(entry: Entry, parent: string) {
  const managed = /^conversations(\/\d+)?$/.test(entry.path);
  const actions = [
    ...(entry.kind === "file" ? [{ label: t("open"), value: "open" }, { label: t("download"), value: "download" }] : []),
    ...(managed ? [] : [{ label: t("move"), value: "move" }, { label: t("delete"), value: "delete", destructive: true }]),
  ];
  if (!actions.length) return;
  const action = await ask({ title: entry.name, actions });
  if (action === "open") window.open(fileURL(entry.path), "_blank", "noopener");
  if (action === "download") location.href = fileURL(entry.path, true);
  if (action === "move") {
    const target = await ask({ title: t("move"), input: { value: entry.path, label: t("movePrompt") }, confirm: t("save") });
    if (target && normalize(target) !== entry.path) await api("/api/files/move", { method: "POST", json: { from: entry.path, to: normalize(target) } }).then(() => renderFiles(parent), failed);
  }
  if (action === "delete") {
    if (await ask({ title: t("deleteFile", { name: entry.name }), message: t("deleteFileBody"), confirm: t("delete"), destructive: true }) !== "confirm") return;
    await api(`/api/files?path=${encodeURIComponent(entry.path)}`, { method: "DELETE" }).then(() => renderFiles(parent), failed);
  }
}

async function newFolder(parent: string) {
  const name = await ask({ title: t("newFolder"), input: { value: "", label: t("folderName") }, confirm: t("save") });
  if (!name?.trim()) return;
  await api("/api/files/folder", { method: "POST", json: { path: normalize(`${parent}/${name.trim()}`) } }).then(() => renderFiles(parent), failed);
}

async function upload(parent: string, files: File[]) {
  for (const file of files) {
    const path = normalize(`${parent}/${file.name}`);
    const put = (overwrite: boolean) => api(`/api/files/content?path=${encodeURIComponent(path)}${overwrite ? "&overwrite=1" : ""}`, { method: "PUT", body: file });
    try { await put(false); }
    catch (error) {
      if (error instanceof APIError && error.status === 409 && await ask({ title: t("overwriteTitle", { name: file.name }), message: t("overwriteBody"), confirm: t("replace") }) === "confirm") {
        await put(true).catch(failed);
      } else if (!(error instanceof APIError && error.status === 409)) failed(error);
    }
  }
  if (state.route.name === "files" && state.route.path === parent) void renderFiles(parent);
}

function section(title: string, body: string | null, ...children: (Node | null)[]) {
  return h("section", { className: "settings-section" }, h("h2", {}, title), body ? h("p", { className: "muted section-body" }, body) : null, h("div", { className: "group" }, ...children));
}

async function renderSettings() {
  const settings = state.settings;
  if (!settings) return;
  const configured = settings.providers.filter(provider => provider.configured && !provider.custom);
  const available = settings.providers.filter(provider => !provider.configured && !provider.custom);
  const providerSelect = h("select", { className: "field", "aria-label": t("provider"), "data-testid": "provider-select" },
    ...available.map(provider => h("option", { value: provider.id }, provider.name)));
  const keyInput = h("input", { className: "field", type: "password", autocomplete: "off", placeholder: t("apiKey"), "aria-label": t("apiKey"), "data-testid": "provider-key" });
  const custom = settings.custom;
  const customName = h("input", { className: "field", value: custom?.name ?? "", placeholder: t("customEndpoint"), "aria-label": t("endpointName"), "data-testid": "custom-name" });
  const customURL = h("input", { className: "field", value: custom?.baseUrl ?? "", placeholder: "http://127.0.0.1:11434/v1", inputmode: "url", autocapitalize: "off", spellcheck: "false", "aria-label": t("baseUrl"), "data-testid": "custom-url" });
  const customModels = h("input", { className: "field", value: custom?.models.join(", ") ?? "", placeholder: "llama-3.3-70b", autocapitalize: "off", spellcheck: "false", "aria-label": t("modelIds"), "data-testid": "custom-models" });
  const customKey = h("input", { className: "field", type: "password", autocomplete: "off", placeholder: settings.customKey ? "••••••••" : t("optionalKey"), "aria-label": t("optionalKey"), "data-testid": "custom-key" });
  const memory = h("textarea", { className: "field memory", rows: 8, "aria-label": t("memory"), "data-testid": "memory-input" });
  const profileName = h("input", { className: "field", value: settings.profile.name, maxlength: 60, "aria-label": t("profileName"), "data-testid": "profile-name" });
  const devices = h("div", { className: "device-list", "data-testid": "device-list" });
  const pairingCode = h("div", { className: "pairing-code-slot" });
  main!.replaceChildren(topbar(t("settings")), h("div", { className: "page settings" },
    section(t("models"), null, settings.providers.some(provider => provider.configured && provider.models.length)
      ? h("label", { className: "row" }, h("span", { className: "row-label" }, t("defaultModel")), modelSelect(settings.defaultModel, false, choice => {
        void api("/api/settings/default-model", { method: "PUT", json: choice }).then(value => { state.settings = value as Settings; state.draftModel = state.settings.defaultModel; renderSettings(); toast(t("saved")); }, failed);
      }, "default-model"))
      : h("div", { className: "row" }, h("span", { className: "muted" }, t("noDefault")))),
    section(t("providers"), null,
      ...configured.map(provider => h("div", { className: "row", "data-testid": `provider-${provider.id}` },
        h("div", {}, h("div", {}, provider.name), h("div", { className: "muted small" }, t("providerConfigured"))),
        h("button", { type: "button", className: "button secondary small", onclick: async () => {
          if (await ask({ title: t("removeKeyTitle", { name: provider.name }), message: t("removeKeyBody"), confirm: t("removeKey"), destructive: true }) !== "confirm") return;
          await api(`/api/settings/providers/${encodeURIComponent(provider.id)}/key`, { method: "DELETE" }).then(value => { state.settings = value as Settings; renderSettings(); }, failed);
        } }, t("removeKey")))),
      h("form", { className: "row form-row", onsubmit: async (event: Event) => {
        event.preventDefault();
        if (!keyInput.value.trim()) return;
        await api(`/api/settings/providers/${encodeURIComponent(providerSelect.value)}/key`, { method: "PUT", json: { key: keyInput.value } })
          .then(value => { state.settings = value as Settings; state.draftModel ??= state.settings.defaultModel; renderSettings(); toast(t("keySaved")); }, failed);
      } }, h("div", { className: "label" }, t("addProvider")), providerSelect, keyInput, h("button", { type: "submit", className: "button primary", "data-testid": "save-key" }, t("saveKey")))),
    section(t("customEndpoint"), t("customBody"),
      h("form", { className: "row form-row", onsubmit: async (event: Event) => {
        event.preventDefault();
        await api("/api/settings/providers/custom", { method: "PUT", json: { name: customName.value, baseUrl: customURL.value, models: customModels.value, key: customKey.value } })
          .then(value => { state.settings = value as Settings; state.draftModel ??= state.settings.defaultModel; renderSettings(); toast(t("saved")); }, failed);
      } }, customName, customURL, customModels, customKey,
        h("div", { className: "button-row" }, h("button", { type: "submit", className: "button primary", "data-testid": "save-custom" }, t("save")),
          custom ? h("button", { type: "button", className: "button secondary", onclick: async () => {
            await api("/api/settings/providers/custom", { method: "DELETE" }).then(value => { state.settings = value as Settings; renderSettings(); }, failed);
          } }, t("removeEndpoint")) : null))),
    section(t("memory"), t("memoryBody"), h("form", { className: "row form-row", onsubmit: async (event: Event) => {
      event.preventDefault();
      await api("/api/settings/memory", { method: "PUT", json: { text: memory.value } }).then(() => toast(t("saved")), failed);
    } }, memory, h("button", { type: "submit", className: "button primary", "data-testid": "save-memory" }, t("save")))),
    section(t("devices"), null, devices, pairingCode,
      h("div", { className: "row" }, h("button", { type: "button", className: "button secondary", "data-testid": "pair-device", onclick: async () => {
        await api<{ code: string; expiresAt: string }>("/api/devices/pairing", { method: "POST" }).then(({ code, expiresAt }) => {
          pairingCode.replaceChildren(h("div", { className: "pairing-code", "data-testid": "pairing-code" }, h("div", { className: "label" }, t("pairCodeTitle")),
            h("div", { className: "code" }, code), h("p", { className: "muted small" }, `${t("pairCodeBody")} ${new Date(expiresAt).toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" })}`)));
        }, failed);
      } }, t("pairDevice")))),
    section(t("profile"), null, h("form", { className: "row form-row", onsubmit: async (event: Event) => {
      event.preventDefault();
      await api("/api/settings/profile", { method: "PUT", json: { name: profileName.value } }).then(value => { state.settings = value as Settings; renderSidebar(); toast(t("saved")); }, failed);
    } }, h("div", { className: "label" }, t("profileName")), profileName, h("button", { type: "submit", className: "button primary" }, t("save")))),
    section(t("about"), null,
      h("div", { className: "row" }, h("span", {}, t("about")), h("span", { className: "muted" }, settings.host.id)),
      h("div", { className: "row" }, h("span", {}, t("version")), h("span", { className: "muted" }, settings.host.version)),
      h("div", { className: "row" }, h("span", {}, t("storage")), h("span", { className: "muted mono" }, settings.storage))),
    h("button", { type: "button", className: "button danger-text", "data-testid": "sign-out", onclick: async () => {
      if (await ask({ title: t("signOutTitle"), message: t("revokeBody"), confirm: t("signOut"), destructive: true }) !== "confirm") return;
      await api("/api/logout", { method: "POST" }).then(() => { state.paired = false; events?.close(); renderPairing(); }, failed);
    } }, t("signOut"))));
  if (available.length === 0) providerSelect.closest("form")?.remove();
  void api<{ text: string }>("/api/settings/memory").then(value => { memory.value = value.text; }, () => {});
  void api<{ devices: Device[]; current: string }>("/api/devices").then(({ devices: items, current }) => {
    devices.replaceChildren(...items.map(device => h("div", { className: "row", "data-testid": "device-row" },
      h("div", {}, h("div", {}, device.name, device.id === current ? h("span", { className: "tag" }, t("thisDevice")) : null),
        h("div", { className: "muted small" }, t("lastSeen", { time: device.lastSeenAt ? relativeTime(Date.parse(device.lastSeenAt)) : t("never") }))),
      device.id === current ? null : h("button", { type: "button", className: "button secondary small", onclick: async () => {
        if (await ask({ title: t("revokeTitle", { name: device.name }), message: t("revokeBody"), confirm: t("revoke"), destructive: true }) !== "confirm") return;
        await api(`/api/devices/${device.id}`, { method: "DELETE" }).then(() => renderSettings(), failed);
      } }, t("revoke")))));
  }, () => {});
}

function route() {
  const previous = state.route;
  state.route = parseRoute();
  if (!state.paired) return;
  if (!wide.matches && state.route.name === "list") {
    const shell = app.querySelector(".shell") as HTMLElement | null;
    if (shell) { shell.dataset.pane = "list"; renderSidebarList(); return; }
  }
  const shell = app.querySelector(".shell") as HTMLElement | null;
  if (!shell) { renderShell(); return; }
  shell.dataset.pane = state.route.name === "list" ? "list" : "main";
  if (state.route.name === "list") { renderSidebarList(); return; }
  const sameChat = previous.name === "chat" && state.route.name === "chat" && previous.id === state.route.id && main?.querySelector(".composer");
  if (state.route.name !== "chat" || state.route.id !== (state.view?.summary.id ?? null)) state.view = state.route.name === "chat" && state.route.id === state.view?.summary.id ? state.view : null;
  if (!sameChat) { state.attachments = previous.name === "chat" && state.route.name === "chat" && previous.id === null ? state.attachments : []; renderMain(); }
  renderSidebar();
}

async function start() {
  const session = await api<{ paired: boolean; device: Device | null }>("/api/session");
  state.paired = session.paired;
  if (!session.paired) { renderPairing(); return; }
  state.deviceID = session.device?.id ?? "";
  state.route = parseRoute();
  await Promise.all([loadSettings(), loadConversations().catch(() => {})]);
  if (state.route.name === "list" && wide.matches) state.route = { name: "chat", id: null };
  renderShell();
  connectEvents();
}

window.addEventListener("hashchange", route);
wide.addEventListener("change", () => { if (state.paired) renderShell(); });
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && state.paired) { void refresh(); } });
void start().catch(error => {
  app.replaceChildren(h("main", { className: "pair-page" }, h("div", { className: "pair-card" }, h("h1", {}, t("error")), h("p", { className: "muted" }, error instanceof Error ? error.message : String(error)))));
});

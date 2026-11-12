import { h, icon, loader, type IconName } from "./dom";
import { closeOpen, copyText, patchMarkdown, type Resolve } from "./markdown";
import { firstRun } from "./onboarding";
import { syncPush, watchNotificationClicks } from "./notifications";
import { fileEmbed, fileIcon, fileURL, openFile } from "./file-viewer";
import { hostText, locale, t } from "./i18n";
import { api, APIError, ask, download, failed, formDialog, menu, onUnauthorized, relativeTime, toast } from "./client";
import { avatar, cachedSchedules, cachedSkills, importServiceFile, loadSchedules, loadSkills, openSkillDetails, renderSchedules, scheduleCard, skillCard, type PageHost } from "./capabilities";
import { applyTheme, closeSettings, openSettings, refreshSettings, settingsOpen, settingsTab, settingsTabs, type Device, type ModelChoice, type Settings,
  type SettingsHost, type SettingsTab } from "./settings";
import { approvalCard, formCard, pageHandoffCard, pageItem, refreshSignIns, type PageCard, type PromptContext, type PromptKind } from "./prompts";
import { isPageOpen, openViewer, pagesChanged, refreshOpenPages } from "./viewer";
import { cancelDictation, canDictate, canSpeak, dictationButton, loadMedia, readAloudButton } from "./voice";

type Summary = { id: number; title: string; model: ModelChoice | null; createdAt: number; lastActivity: number | null; unread: boolean; favorite: boolean; busy: boolean; temporary?: boolean };
type Kind = { type: string; [key: string]: unknown };
type Block = { id: string; createdAt: number; kind: Kind };
type Prompt = { id: string; prompt: string; options: string[] };
type View = { summary: Summary; blocks: Block[]; busy: boolean; pendingPrompt?: Prompt; follow: { label: string; message: string }[]; error: string | null };
type Entry = { path: string; name: string; kind: "file" | "directory"; size: number; modified: number };
type Invocation = { id: string; name: string; purpose: string; args: { source?: string; path?: string; from?: string }; outcome: Record<string, { _0?: unknown }> };
type Route = { name: "chat"; id: number | null } | { name: "list" } | { name: "files"; path: string } | { name: "schedules" };
type Item = { text?: string; ref?: string; progress?: string; page?: PageCard };
type Trace = { entries: { kind: string; invocation?: Invocation; reasoning?: { id: string; text: string; ref?: string } }[]; completedAt?: number };
type StreamEvent = { id: number; ref: string; kind: string; offset: number; delta: string; final?: boolean };
type LiveText = { text: string; shown: number; kind: string; final?: boolean };
type ServiceItem = { domain: string; name: string; available: boolean; attached?: boolean; saved?: boolean };

const roots = new Set(["app", "MEMORY.md", "skills", "repositories", "mounts", "files", "artifacts", "conversations", "history", "chats", "tmp"]);
const appPath = (path: string) => /^\/*app(\/|$)/.test(path);
const imageExtensions = /\.(png|jpe?g|gif|webp|svg)$/i;
const audioExtensions = /\.(wav|mp3|m4a|aac|ogg|opus|flac)$/i;
const videoExtensions = /\.(mp4|mov|webm)$/i;
const thumbnailLimit = 2 * 1024 * 1024;
const app = document.getElementById("app")!;
const wide = window.matchMedia("(min-width: 900px)");
const touch = window.matchMedia("(pointer: coarse)");
const mentionPattern = /(?:^|[\s\u3000-\u9fff\uff00-\uffef])@([^\s@]{0,40})$/;
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
  optimistic: null as { id: number; text: string; files: string[]; users: number; skill?: { name: string; argument: string }; element?: HTMLElement } | null,
  online: true,
  sending: false,
  unconfirmedSends: new Map<string, string>(),
  drawer: false,
  collapsed: localStorage.getItem("ox.sidebar") === "collapsed",
  search: "",
  pendingServices: [] as string[],
  editing: null as { conversation: number; entry: number } | null,
  temporaryDraft: false,
};
let events: EventSource | undefined;
let main: HTMLElement | undefined;
let sidebar: HTMLElement | undefined;
let transcriptRoot: HTMLElement | undefined;
let composerRefs: { textarea: HTMLTextAreaElement; send: HTMLButtonElement; attach: HTMLButtonElement; chips: HTMLElement; follow: HTMLElement; services: HTMLElement; picker: HTMLElement } | undefined;
let temporaryID: number | null = null;
let serviceCatalog: ServiceItem[] = [];
let attachedServices: ServiceItem[] = [];
let attachedFor: number | null = null;
let servicesRequest = 0;
let pickerIndex = 0, pickerQuery: string | null = null, pickerDismissed: string | null = null;
const blockCache = new Map<string, { signature: string; element: HTMLElement }>();
const PENDING = -1;
const live = new Map<string, LiveText>();
const waiting = new Map<string, StreamEvent[]>();
const viewCache = new Map<number, View>();
let liveConversation: number | null = null;
let revealing = 0;
let anchor: { id: number; users: number } | null = null;
let atEnd = false;
let pendingScroll = false;
let revealFrom = Number.POSITIVE_INFINITY;
let spacer: HTMLElement | undefined;
let jump: HTMLButtonElement | undefined;
let workingDot: HTMLElement | undefined;
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const shownId = () => state.route.name === "chat" ? state.route.id ?? PENDING : null;
const isBusy = () => !!state.view?.busy && state.view.summary.id === shownId();
const draftKey = () => state.route.name === "chat" && state.route.id !== null ? String(state.route.id) : "new";
const userCount = (view: View) => view.blocks.filter(block => block.kind.type === "userText").length;
const copyLabel = () => t("copyReply");

function size(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10_240 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
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
    return { href: fileURL(path), file: true, image: imageExtensions.test(path), media: audioExtensions.test(path) ? "audio" : videoExtensions.test(path) ? "video" : undefined,
      embed: (title: string) => fileEmbed(path, title) };
  };
}

function parseRoute(): Route {
  const hash = location.hash.replace(/^#\/?/, "");
  const [name, ...rest] = hash.split("/");
  if (name === "c" && /^\d+$/.test(rest[0] ?? "")) return { name: "chat", id: Number(rest[0]) };
  if (name === "files") return { name: "files", path: normalize(rest.map(part => decodeURIComponent(part)).join("/")) };
  if (name === "schedules") return { name };
  if (name === "list") return { name: "list" };
  return { name: "chat", id: null };
}
function go(hash: string, replace = false) {
  if (location.hash === hash) { route(); return; }
  if (replace) { history.replaceState(null, "", hash); route(); } else location.hash = hash;
}
const filesHash = (path: string) => `#/files${path ? "/" + path.split("/").map(encodeURIComponent).join("/") : ""}`;
const routeHash = (route: Route) => route.name === "chat" ? (route.id === null ? "#/" : `#/c/${route.id}`) : route.name === "files" ? filesHash(route.path) : `#/${route.name}`;
function fileLocation() {
  const match = /^#\/file\/(.+)$/.exec(location.hash);
  if (!match) return null;
  try { return normalize(match[1]!.split("/").map(part => decodeURIComponent(part)).join("/")); } catch { return ""; }
}

function choiceKey(choice: ModelChoice | null) { return choice ? JSON.stringify([choice.provider, choice.modelId]) : ""; }
function modelName(choice: ModelChoice | null) {
  if (!choice) return t("noModels");
  const provider = state.settings?.providers.find(item => item.id === choice.provider);
  return provider?.models.find(model => model.id === choice.modelId)?.name ?? choice.modelId;
}
function modelSelect(current: ModelChoice | null, disabled: boolean, onchange: (choice: ModelChoice) => void, testID: string) {
  const configured = state.settings?.providers.filter(provider => provider.configured && provider.models.length) ?? [];
  if (!configured.length) return h("a", { href: "#/settings/models", className: "model-chip", "data-testid": testID }, h("span", { className: "model-name" }, t("addModel")));
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
  return h("label", { className: "model-chip" }, h("span", { className: "model-name" }, modelName(current)), icon("expand", 16), select);
}

const offered = (settings: Settings, choice: ModelChoice | null) => !!choice && settings.providers.some(provider => provider.id === choice.provider && provider.configured
  && provider.models.some(model => model.id === choice.modelId));

async function loadSettings() {
  state.settings = await api<Settings>("/api/settings");
  if (!offered(state.settings, state.draftModel)) state.draftModel = state.settings.defaultModel;
  main?.querySelector(".workspace-context-bar")?.replaceWith(workspaceContext());
}
async function loadConversations() {
  state.conversations = (await api<{ items: Summary[] }>("/api/conversations")).items;
  renderSidebarList();
}
let listTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleList() { listTimer ??= setTimeout(() => { listTimer = undefined; void loadConversations().catch(() => {}); }, 250); }
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
      viewCache.delete(id);
      viewCache.set(id, view);
      if (viewCache.size > 30) viewCache.delete(viewCache.keys().next().value!);
      state.view = view;
      if (view.summary.temporary) temporaryID = id;
      syncLive(view);
      renderConversation();
      if (!view.summary.temporary && !state.conversations.some(item => item.id === id && item.title === view.summary.title && item.busy === view.busy)) scheduleList();
      if (view.summary.unread && document.visibilityState === "visible") void api(`/api/conversations/${id}/read`, { method: "POST" }).then(scheduleList, () => {});
    } catch (error) {
      if (error instanceof APIError && error.status === 404) { toast(error.message, "error"); go("#/", true); }
    } finally { viewLoading = undefined; }
  })();
  await viewLoading;
}

function textOfRef(view: View | null, ref: string) {
  for (const block of view?.blocks ?? []) {
    if (block.kind.type === "agentContent") for (const item of (block.kind.items as Item[] | undefined) ?? []) if (item.ref === ref) return item.text ?? "";
    if (block.kind.type === "thinking") for (const entry of (block.kind.trace as Trace).entries) if (entry.reasoning?.ref === ref) return entry.reasoning.text;
  }
  return undefined;
}

function resetLive(id: number | null) {
  if (liveConversation === id) return;
  live.clear();
  waiting.clear();
  liveConversation = id;
}

function append(entry: LiveText, update: StreamEvent) {
  if (update.offset > entry.text.length) { scheduleView(0); return; }
  entry.text += update.delta.slice(entry.text.length - update.offset);
  if (update.final) entry.final = true;
}

function stream(update: StreamEvent) {
  if (state.route.name !== "chat" || state.route.id !== update.id) return;
  resetLive(update.id);
  let entry = live.get(update.ref);
  if (!entry) {
    const shown = textOfRef(state.view, update.ref);
    if (shown !== undefined) entry = { text: shown, shown: shown.length, kind: update.kind };
    else if (update.offset === 0) entry = { text: "", shown: 0, kind: update.kind };
    else { waiting.set(update.ref, [...waiting.get(update.ref) ?? [], update]); scheduleView(0); return; }
    live.set(update.ref, entry);
    if (shown === undefined) scheduleView(0);
  }
  const settled = entry.shown >= entry.text.length;
  append(entry, update);
  if (update.final && settled && entry.shown >= entry.text.length) paint(update.ref, entry);
  reveal();
}

function syncLive(view: View) {
  resetLive(view.summary.id);
  for (const [ref, updates] of waiting) {
    const text = textOfRef(view, ref);
    if (text === undefined) continue;
    const entry: LiveText = { text, shown: 0, kind: updates[0]!.kind };
    for (const update of updates) append(entry, update);
    live.set(ref, entry);
    waiting.delete(ref);
  }
  for (const [ref, entry] of live) {
    const text = textOfRef(view, ref);
    if (text === undefined || text === entry.text) continue;
    if (text.startsWith(entry.text)) entry.text = text;
    else if (!entry.text.startsWith(text)) { entry.text = text; entry.shown = Math.min(entry.shown, text.length); }
  }
  reveal();
}

function streaming(entry: LiveText, settled = false) {
  return !settled && (entry.shown < entry.text.length || (!entry.final && isBusy()));
}

function shownText(entry: LiveText, settled = false) {
  const visible = entry.text.slice(0, entry.shown);
  return streaming(entry, settled) ? closeOpen(visible) : visible;
}

function displayed(item: Item) {
  const entry = item.ref ? live.get(item.ref) : undefined;
  return entry ? shownText(entry) : item.text ?? "";
}

function patchItem(element: Element, item: Item, resolve: Resolve) {
  const entry = item.ref ? live.get(item.ref) : undefined;
  patchMarkdown(element, displayed(item), resolve, copyLabel(), !!entry && streaming(entry));
}

function reveal() { if (!revealing) revealing = requestAnimationFrame(frame); }

function frame() {
  revealing = 0;
  let more = false;
  for (const [ref, entry] of live) {
    if (entry.shown >= entry.text.length) continue;
    let next = entry.shown + (reducedMotion.matches ? entry.text.length : Math.max(1, Math.ceil((entry.text.length - entry.shown) / 8)));
    if (/[\uD800-\uDBFF]/.test(entry.text[next - 1] ?? "")) next += 1;
    entry.shown = Math.min(entry.text.length, next);
    paint(ref, entry);
    if (entry.shown < entry.text.length) more = true;
  }
  if (more) reveal();
  else if (!isBusy()) for (const [ref, entry] of live) { live.delete(ref); paint(ref, { ...entry, shown: entry.text.length }, true); }
  layoutSpacer();
  updateJump();
}

function paint(ref: string, entry: LiveText, settled = false) {
  const element = transcriptRoot?.querySelector<HTMLElement>(`[data-ref="${CSS.escape(ref)}"]`);
  if (!element || !state.view) return;
  if (entry.kind === "reasoning") { const visible = entry.text.slice(0, entry.shown); if (element.textContent !== visible) element.textContent = visible; return; }
  patchMarkdown(element, shownText(entry, settled), resolver(state.view.summary.id), copyLabel(), streaming(entry, settled));
  const owner = element.closest<HTMLElement>("[data-block]");
  const cached = owner ? blockCache.get(owner.dataset.block!) : undefined;
  if (cached && settled) cached.signature = "";
}

const presenceTab = Array.from(crypto.getRandomValues(new Uint8Array(16)), value => value.toString(16).padStart(2, "0")).join("");
const reportPresence = () => {
  if (!state.paired) return;
  void fetch("/api/presence", { method: "PUT", credentials: "same-origin", keepalive: true, headers: { "content-type": "application/json" },
    body: JSON.stringify({ tab: presenceTab, visible: document.visibilityState === "visible" }) }).catch(() => {});
};

function connectEvents() {
  events?.close();
  events = new EventSource(`/api/events?tab=${presenceTab}&visible=${document.visibilityState === "visible" ? 1 : 0}`);
  events.addEventListener("ready", () => {
    reportPresence();
    if (!state.online) { state.online = true; renderOffline(); void refresh(); }
  });
  events.addEventListener("conversation", event => {
    const { id } = JSON.parse((event as MessageEvent).data) as { id: number };
    if (state.route.name === "chat" && state.route.id === id) scheduleView();
    scheduleList();
    window.dispatchEvent(new Event("ox-files"));
  });
  events.addEventListener("stream", event => stream(JSON.parse((event as MessageEvent).data) as StreamEvent));
  events.addEventListener("settings", () => { void loadSettings().then(() => { refreshSettings(); renderConversationHeader(); }).catch(() => {}); });
  events.addEventListener("devices", () => { void checkSession(); refreshSettings("security"); });
  events.addEventListener("skills", () => { refreshSettings("profile"); refreshSkills(); });
  events.addEventListener("pages", () => {
    pagesChanged();
    void refreshOpenPages().then(() => {
      if (state.route.name !== "chat" || !state.view?.blocks.some(block => JSON.stringify(block.kind).includes('"page"'))) return;
      const pending = (element: HTMLElement) => element.matches("[data-testid=pending-page]") || !!element.querySelector("[data-testid=pending-page]");
      for (const [key, { element }] of blockCache) if (!pending(element)) blockCache.delete(key);
      renderConversation(true);
      for (const thumb of document.querySelectorAll<HTMLImageElement>("[data-testid=pending-page] .page-thumb")) thumb.src = thumb.src.replace(/([?&]t=)\d+/, `$1${Date.now()}`);
      refreshSignIns();
    });
  });
  events.addEventListener("services", () => { if (state.route.name === "chat") void loadServices(state.route.id).catch(() => {}); });
  for (const [name, tabs] of [["services", ["services", "permissions"]], ["repositories", ["repositories", "services"]], ["secrets", ["secrets"]]] as const) {
    events.addEventListener(name, () => { for (const tab of tabs) refreshSettings(tab); });
  }
  events.addEventListener("schedules", () => {
    if (state.route.name === "schedules" && !document.querySelector(".dialog, .menu")) { schedulesRequested = false; renderMain(); return; }
    refreshSchedules();
  });
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
  refreshSchedules();
  refreshSkills();
  if (state.route.name === "chat") await loadView(); else renderMain();
}

function renderOffline() {
  document.querySelector(".offline")?.remove();
  if (!state.online && state.paired) document.body.append(h("div", { className: "offline", role: "status" }, t("offline")));
}

function renderPairing() {
  renderOffline();
  cancelDictation();
  blockCache.clear();
  transcriptRoot = undefined;
  const code = h("input", { className: "field code-field", inputmode: "text", autocomplete: "one-time-code", autocapitalize: "characters", spellcheck: "false",
    placeholder: "ABCD-EFGH", maxlength: 12, required: true, "aria-label": t("pairCode"), "data-testid": "pair-code" });
  const guess = /iPhone/.test(navigator.userAgent) ? "iPhone" : /iPad/.test(navigator.userAgent) ? "iPad" : /Android/.test(navigator.userAgent) ? "Android"
    : /Mac/.test(navigator.platform) ? "Mac" : /Win/.test(navigator.platform) ? "Windows" : "Browser";
  const name = h("input", { className: "field", value: guess, maxlength: 80, required: true, "aria-label": t("deviceName"), "data-testid": "pair-name" });
  if (linkedCode) code.value = linkedCode;
  const button = h("button", { type: "submit", className: "button primary wide large", "data-testid": "pair-submit" }, t("pair"));
  const message = h("p", { className: "form-error", role: "alert", "data-testid": "pair-error" });
  const form = h("form", { className: "pair-card", onsubmit: async (event: Event) => {
    event.preventDefault();
    button.disabled = true;
    button.textContent = t("pairing");
    message.textContent = "";
    try {
      await api("/api/pair", { method: "POST", json: { code: code.value, name: name.value } });
      linkedCode = "";
      await start();
    } catch (error) {
      message.textContent = hostText(error instanceof Error ? error.message : String(error));
      button.disabled = false;
      button.textContent = t("pair");
    }
  } },
    h("img", { src: "/icon.svg", alt: "", className: "pair-icon", width: 52, height: 52 }),
    h("div", { className: "pair-heading" }, h("h1", {}, t("pairTitle")), h("p", { className: "muted" }, t("pairBody"))),
    h("label", { className: "stack" }, h("span", { className: "label" }, t("pairCode")), code),
    h("label", { className: "stack" }, h("span", { className: "label" }, t("deviceName")), name),
    message, button);
  app.replaceChildren(h("main", { className: "pair-page" }, form));
  (linkedCode ? button : code).focus();
}

function setCollapsed(collapsed: boolean) {
  state.collapsed = collapsed;
  localStorage.setItem("ox.sidebar", collapsed ? "collapsed" : "open");
  app.querySelector<HTMLElement>(".shell")?.setAttribute("data-collapsed", String(collapsed));
  if (state.route.name === "chat") renderConversationHeader(); else renderMain();
}

function syncDrawer() {
  app.querySelector<HTMLElement>(".shell")?.setAttribute("data-drawer", state.drawer ? "open" : "closed");
  sidebar?.toggleAttribute("inert", !wide.matches && !state.drawer);
}

function openDrawer() {
  if (wide.matches) { setCollapsed(false); return; }
  state.drawer = true;
  renderSidebarList();
  syncDrawer();
  (sidebar?.querySelector<HTMLElement>(".conversation-row") ?? sidebar?.querySelector<HTMLElement>('[data-testid="close-sidebar"]'))?.focus({ preventScroll: true });
}

function closeDrawer() {
  if (!state.drawer) return;
  state.drawer = false;
  if (sidebar?.contains(document.activeElement)) main?.querySelector<HTMLElement>('[data-testid="open-sidebar"]')?.focus({ preventScroll: true });
  syncDrawer();
}

function startNewChat(event: Event) {
  closeDrawer();
  if (state.route.name === "chat" && state.route.id === null && (location.hash === "" || location.hash === "#/")) {
    event.preventDefault();
    if (state.view?.summary.id === PENDING) return;
    composerRefs?.textarea.focus();
  }
}

function renderShell() {
  sidebar = h("aside", { className: "sidebar", "aria-label": t("conversations") });
  main = h("main", { className: "main" });
  const scrim = h("div", { className: "scrim", "aria-hidden": "true", onclick: () => closeDrawer() });
  app.replaceChildren(h("div", { className: "shell", "data-drawer": state.drawer ? "open" : "closed", "data-collapsed": String(state.collapsed) }, sidebar, main, scrim));
  renderSidebar();
  renderMain();
  syncDrawer();
}

function renderSidebar() {
  if (!sidebar) return;
  const route = state.route;
  const phone = !wide.matches;
  const profile = state.settings?.profile.name ?? "";
  sidebar.replaceChildren(
    h("div", { className: "sidebar-head" },
      h("a", { href: "#/", className: "brand", onclick: startNewChat }, h("img", { src: "/icon.svg", alt: "", width: 26, height: 26 }), h("span", { className: "brand-name" }, t("appName"))),
      h("button", { type: "button", className: "icon-button", "aria-label": t("closeSidebar"), title: t("closeSidebar"), "data-testid": "close-sidebar",
        onclick: () => phone ? closeDrawer() : setCollapsed(true) }, icon(phone ? "close" : "sidebar"))),
    ...(phone ? [] : [h("nav", { className: "sidebar-nav" },
      h("a", { href: "#/", className: `nav-row${route.name === "chat" && route.id === null ? " active" : ""}`, "data-testid": "new-chat", onclick: startNewChat }, icon("pencil"), h("span", {}, t("newChat"))))]),
    h("div", { className: "sidebar-search", role: "search" }, h("input", { type: "search", className: "field search-field", placeholder: t("searchConversations"),
      "aria-label": t("searchConversations"), value: state.search, autocomplete: "off", "data-testid": "conversation-search",
      oninput: (event: Event) => { state.search = (event.currentTarget as HTMLInputElement).value; renderSidebarList(); } })),
    h("nav", { className: "conversation-list", "data-testid": "conversation-list", "aria-label": t("conversations") }),
    phone
      ? h("div", { className: "sidebar-foot drawer-foot" },
        h("a", { href: "#/", className: "button accent", "data-testid": "new-chat", onclick: startNewChat }, icon("pencil", 18), h("span", {}, t("newChat"))),
        h("a", { href: "#/settings", className: "icon-button outlined", "aria-label": t("settings"), title: t("settings"), "data-testid": "nav-settings", onclick: () => closeDrawer() }, icon("gear")))
      : h("div", { className: "sidebar-foot" },
        h("a", { href: "#/settings", className: "profile-row", "data-testid": "nav-settings" },
          h("span", { className: "profile-avatar", "aria-hidden": "true" }, (profile.trim()[0] ?? "O").toUpperCase()),
          h("span", { className: "profile-text" }, h("span", { className: "profile-name" }, profile || t("appName")), h("span", { className: "profile-sub" }, t("settings"))),
          icon("gear", 18))));
  renderSidebarList();
}

function groupLabel(time: number) {
  const now = new Date(), today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime(), day = 86_400_000;
  return time >= today ? t("today") : time >= today - day ? t("yesterday") : time >= today - 7 * day ? t("previous7") : time >= today - 30 * day ? t("previous30") : t("older");
}

function renderSidebarList() {
  const list = sidebar?.querySelector<HTMLElement>(".conversation-list");
  if (!list) return;
  const scroll = list.scrollTop;
  const current = state.route.name === "chat" ? state.route.id : null;
  const groups = new Map<string, Summary[]>();
  const query = state.search.trim().toLocaleLowerCase();
  const shown = query ? state.conversations.filter(item => (item.title || t("untitled")).toLocaleLowerCase().includes(query)) : state.conversations;
  for (const item of shown) {
    const label = groupLabel(item.lastActivity ?? item.createdAt);
    groups.set(label, [...groups.get(label) ?? [], item]);
  }
  list.replaceChildren(...(shown.length ? [...groups].flatMap(([label, items]) => [h("div", { className: "section-label" }, label),
    ...items.map(item => h("a", { href: `#/c/${item.id}`, className: `conversation-row${item.id === current ? " active" : ""}`, "data-testid": `conversation-${item.id}`,
      "aria-current": item.id === current ? "page" : null, onclick: () => closeDrawer() },
      h("span", { className: "row-title" }, item.title || t("untitled")),
      item.busy ? h("span", { className: "row-loader", role: "img", "aria-label": t("working") }, loader(12))
        : item.unread ? h("span", { className: "dot unread", role: "img", "aria-label": "unread" }) : null))])
    : [h("p", { className: "empty-list", "data-testid": "conversation-search-empty" }, query ? t("noMatches") : t("noConversations"))]));
  list.scrollTop = scroll;
}

function renderMain() {
  if (!main) return;
  cancelDictation();
  blockCache.clear();
  transcriptRoot = undefined;
  composerRefs = undefined;
  main.classList.remove("empty");
  if (state.route.name === "files") renderFiles(state.route.path);
  else if (state.route.name === "schedules") void renderSchedules(pageHost);
  else if (state.route.name === "chat") renderChat();
  else main.replaceChildren();
}

const pageHost: PageHost = {
  get main() { return main!; },
  topbar: (title, ...actions) => topbar(title, ...actions),
  openPage: id => openViewer(id),
  route: () => state.route.name,
};

function promptContext(pending: boolean): PromptContext {
  return { conversationId: state.route.name === "chat" ? state.route.id : null, pending, answered: () => scheduleView(), openPage: (id, handoff) => openViewer(id, handoff), isOpen: isPageOpen };
}

function sidebarButtons() {
  if (wide.matches && !state.collapsed) return [];
  return [h("button", { type: "button", className: "icon-button sidebar-toggle", "aria-label": t("openSidebar"), title: t("openSidebar"), "data-testid": "open-sidebar",
    onclick: () => openDrawer() }, icon(wide.matches ? "sidebar" : "menu"))];
}

function topbar(title: Node | string, ...actions: (Node | null)[]) {
  return h("div", { className: "workspace-header" }, workspaceContext(),
    h("header", { className: "topbar page-bar" }, h("div", { className: "topbar-start" }, ...sidebarButtons()),
      typeof title === "string" ? h("h1", { className: "topbar-title" }, title) : title, h("div", { className: "topbar-actions" }, ...actions)));
}

function workspaceContext() {
  const settings = state.settings;
  const label = settings ? t("workspaceContext", { workspace: settings.profile.name, host: settings.host.id }) : null;
  return h("div", { className: "workspace-context-bar" },
    label ? h("a", { href: "#/settings/connections", className: "workspace-context", title: label, "aria-label": `${label}. ${t("hostConnections")}`,
      "data-testid": "workspace-context" }, icon("host", 16), h("span", { className: "workspace-context-name" }, label), icon("chevron", 14)) : null);
}

function emptyState() {
  const ready = state.settings?.providers.some(provider => provider.configured && provider.models.length);
  if (ready && state.temporaryDraft) return h("div", { className: "empty-state temporary", "data-testid": "empty-state" }, h("h2", {}, t("temporaryTitle")),
    h("p", { className: "muted" }, t("temporaryBody")));
  return h("div", { className: "empty-state", "data-testid": "empty-state" }, h("h2", {}, t("emptyTitle")),
    ready ? null : h("p", { className: "muted" }, t("noProviders")),
    ready ? null : h("a", { href: "#/settings/models", className: "button primary", "data-testid": "add-model" }, t("addModel")));
}

function renderChat() {
  const id = state.route.name === "chat" ? state.route.id : null;
  const header = h("div", { className: "conversation-header workspace-header" });
  transcriptRoot = h("div", { className: "transcript", "data-testid": "transcript" });
  spacer = h("div", { className: "turn-spacer", "aria-hidden": "true" });
  workingDot = h("div", { className: "working", "data-testid": "working", role: "status" }, loader(16), h("span", { className: "shimmer" }, t("working")));
  const scroller = h("div", { className: "scroller" }, transcriptRoot);
  scroller.addEventListener("scroll", updateJump, { passive: true });
  jump = h("button", { type: "button", className: "jump", "aria-label": t("scrollToBottom"), title: t("scrollToBottom"), "data-testid": "scroll-bottom", onclick: () => scrollToEnd(true) }, icon("down", 18));
  main!.replaceChildren(header, h("div", { className: "chat-stage" }, scroller, jump), renderComposer(id));
  const pending = state.view?.summary.id === PENDING;
  main!.classList.toggle("empty", id === null && !pending);
  renderConversationHeader();
  if (id === null && !pending) { state.view = null; transcriptRoot.append(emptyState()); }
  else if (state.view && state.view.summary.id === (id ?? PENDING)) { renderConversation(true); scrollToEnd(false); }
  else void loadView().then(() => scrollToEnd(false));
  if (wide.matches) composerRefs?.textarea.focus({ preventScroll: true });
  updateComposer();
}

function renderConversationHeader() {
  const header = main?.querySelector(".conversation-header");
  if (!header) return;
  const id = state.route.name === "chat" ? state.route.id : null;
  const view = state.view && state.view.summary.id === (id ?? PENDING) ? state.view : null;
  const model = view?.summary.model ?? state.draftModel ?? state.settings?.defaultModel ?? null;
  const picker = modelSelect(model, !!view?.busy, choice => {
    if (id === null) { state.draftModel = choice; renderConversationHeader(); return; }
    void api(`/api/conversations/${id}`, { method: "PATCH", json: { model: choice } }).then(() => loadView(), error => { failed(error); renderConversationHeader(); });
  }, "model-picker");
  const compose = !wide.matches || state.collapsed ? h("a", { href: "#/", className: "icon-button", "aria-label": t("newChat"), title: t("newChat"), "data-testid": "topbar-new-chat", onclick: startNewChat }, icon("pencil")) : null;
  const more = id === null ? null : h("button", { type: "button", className: "icon-button", "aria-label": t("moreOptions"), title: t("moreOptions"), "aria-haspopup": "menu", "data-testid": "conversation-menu",
    onclick: (event: Event) => conversationMenu(id, event.currentTarget as HTMLElement) }, icon("more"));
  const temporary = view?.summary.temporary ? h("span", { className: "temporary-badge", "data-testid": "temporary-badge", title: t("temporaryTitle") }, icon("temporaryOn", 18),
    h("span", { className: "label-text" }, t("temporaryBadge")))
    : id === null && !view ? h("button", { type: "button", className: `icon-button temporary-toggle${state.temporaryDraft ? " on" : ""}`, "aria-pressed": String(state.temporaryDraft),
      "aria-label": t(state.temporaryDraft ? "stopTemporary" : "startTemporary"), title: t(state.temporaryDraft ? "stopTemporary" : "startTemporary"), "data-testid": "temporary-toggle",
      onclick: () => {
        state.temporaryDraft = !state.temporaryDraft;
        if (main?.classList.contains("empty")) transcriptRoot?.replaceChildren(emptyState());
        renderConversationHeader();
        updateComposer();
      } }, icon(state.temporaryDraft ? "temporaryOn" : "temporary")) : null;
  header.replaceChildren(workspaceContext(), h("header", { className: "topbar chat-bar" },
    h("div", { className: "topbar-start" }, ...sidebarButtons(), wide.matches ? picker : null),
    wide.matches ? h("div", { className: "topbar-center" }) : h("div", { className: "topbar-center" }, picker),
    h("div", { className: "topbar-actions" }, temporary, compose, more)));
}

type PackageSummary = { token: string; title: string; messages: number; artifacts: number; bytes: number; services: string[]; compacted: boolean };


async function importPackage(file: File) {
  let summary: PackageSummary;
  try { summary = await api<PackageSummary>("/api/conversations/import", { method: "POST", body: file }); }
  catch (error) { toast(t("importFailed", { reason: hostText(error instanceof Error ? error.message : String(error)) }), "error"); return; }
  let created: number | undefined, pending: Promise<number> | undefined;
  const note = (title: string, ...lines: string[]) => h("div", { className: "import-note" }, h("strong", {}, title), ...lines.map(line => h("p", {}, line)));
  await formDialog({ title: t("importConversation"), testID: "import-dialog", confirm: t("addConversation"),
    content: h("div", { className: "import-summary", "data-testid": "import-summary" },
      h("p", { className: "import-title" }, summary.title),
      h("p", { className: "import-meta" }, summary.messages === 1 ? t("importMessage") : t("importMessages", { count: summary.messages })),
      summary.artifacts ? h("p", { className: "import-meta" }, icon("file", 14),
        h("span", {}, summary.artifacts === 1 ? t("importFile", { size: size(summary.bytes) }) : t("importFiles", { count: summary.artifacts, size: size(summary.bytes) }))) : null,
      summary.compacted ? note(t("importCompacted"), t("importCompactedBody")) : null,
      summary.services.length ? note(t("importServices"), summary.services.join(", "), t("importServicesBody")) : null),
    submit: async () => {
      pending = api<{ id: number }>(`/api/conversations/import/${summary.token}`, { method: "POST" }).then(result => result.id);
      created = await pending;
    } });
  if (created === undefined && pending) created = await pending.catch(() => undefined);
  if (created === undefined) { void api(`/api/conversations/import/${summary.token}`, { method: "DELETE" }).catch(() => {}); return; }
  const id = created;
  scheduleList();
  leaveSettings(() => go(`#/c/${id}`));
}

function conversationMenu(id: number, anchor: HTMLElement) {
  const view = state.view?.summary.id === id ? state.view : null;
  menu(anchor, [
    ...(view?.blocks.length ? [{ label: t("copyConversation"), icon: "copy" as const, testID: "menu-copy", run: () => {
      void navigator.clipboard?.writeText(conversationText(view)).then(() => toast(t("copied")), failed);
    } }, ...(view.busy ? [] : [{ label: t("exportConversation"), icon: "download" as const, testID: "menu-export", run: () => void download(`/api/conversations/${id}/export`, "Conversation.conversation").catch(failed) }])] : []),
    { label: t("rename"), icon: "pencil", testID: "menu-rename", run: async () => {
      const title = await ask({ title: t("renameTitle"), input: { value: state.view?.summary.title ?? "", label: t("renameTitle") }, confirm: t("save") });
      if (title?.trim()) await api(`/api/conversations/${id}`, { method: "PATCH", json: { title } }).then(() => { void loadView(); scheduleList(); }, failed);
    } },
    { label: t("delete"), icon: "trash", destructive: true, testID: "menu-delete", run: async () => {
      if (await ask({ title: t("deleteTitle"), message: t("deleteBody"), confirm: t("delete"), destructive: true }) !== "confirm") return;
      await api(`/api/conversations/${id}`, { method: "DELETE" }).then(() => { state.view = null; viewCache.delete(id); scheduleList(); go("#/", true); }, failed);
    } },
  ]);
}

function resizeComposer() {
  const textarea = composerRefs?.textarea;
  if (!textarea) return;
  textarea.style.height = "auto";
  textarea.style.height = `${Math.min(textarea.scrollHeight, 220)}px`;
}

function renderComposer(id: number | null) {
  const key = id === null ? "new" : String(id);
  const textarea = h("textarea", { className: "composer-input", rows: 1, placeholder: t("messagePlaceholder"), "aria-label": t("messagePlaceholder"), "data-testid": "composer-input" });
  textarea.value = state.drafts.get(key) ?? "";
  textarea.addEventListener("input", () => { state.drafts.set(draftKey(), textarea.value); resizeComposer(); updateComposer(); updatePicker(); });
  textarea.addEventListener("keyup", event => { if (!["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"].includes(event.key)) updatePicker(); });
  textarea.addEventListener("click", () => updatePicker());
  textarea.addEventListener("blur", () => { if (composerRefs) composerRefs.picker.hidden = true; });
  textarea.addEventListener("keydown", event => {
    if (pickerKey(event)) return;
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing && wide.matches) { event.preventDefault(); if (!isBusy()) void send(); }
  });
  const input = (testID: string, extra: Record<string, string | boolean> = {}) => {
    const element = h("input", { type: "file", hidden: true, "data-testid": testID, ...extra });
    element.addEventListener("change", () => { void attach([...element.files ?? []]); element.value = ""; });
    return element;
  };
  const picker = input("attach-input", { multiple: true });
  const camera = input("attach-camera-input", { accept: "image/*", capture: "environment" });
  const photos = input("attach-photos-input", { accept: "image/*,video/*", multiple: true });
  const sendButton = h("button", { type: "button", className: "send-button", "data-testid": "send", onclick: () => void (isBusy() ? stop() : send()) }, icon("send"));
  const row = h("div", { className: "composer-row" });
  const attachButton: HTMLButtonElement = h("button", { type: "button", className: "icon-button composer-attach", "aria-label": t("attach"), title: t("attach"), "aria-haspopup": "menu", "data-testid": "attach",
    onmousedown: (event: Event) => event.preventDefault(),
    onclick: () => menu(attachButton, [
      ...(touch.matches ? [{ label: t("camera"), icon: "camera" as const, testID: "attach-camera", run: () => camera.click() }] : []),
      { label: t("photos"), icon: "image", testID: "attach-photos", run: () => photos.click() },
      { label: t("files"), icon: "clip", testID: "attach-files", run: () => picker.click() },
      { label: t("services"), icon: "plug", testID: "attach-services", run: () => startMention() },
    ], { className: "attach-menu", focus: document.activeElement !== textarea }) }, icon("plus", 22));
  let box: HTMLElement | null = null;
  const insert = (text: string, key: string) => {
    const join = (value: string) => {
      const before = value.replace(/\s+$/, "");
      return before ? `${before}${/[\u3000-\u9fff\uff00-\uffef]$/.test(before) ? "" : " "}${text}` : text;
    };
    const live = composerRefs?.textarea;
    if (live?.isConnected && draftKey() === key) {
      live.value = join(live.value);
      live.dispatchEvent(new Event("input"));
      return true;
    }
    state.drafts.set(key, join(state.drafts.get(key) ?? ""));
    return false;
  };
  const ready = () => !isBusy() && !editingHere() && !state.sending && state.uploading === 0 && !!state.settings?.providers.some(provider => provider.configured);
  const mic = canDictate() ? dictationButton(row, textarea, { key: draftKey, insert: (text, key) => { insert(text, key); }, hold: () => touch.matches, area: () => box,
    canHold: () => state.uploading === 0, send: (text, key) => { if (insert(text, key) && ready()) void send(); } }) : null;
  textarea.addEventListener("paste", event => {
    const data = event.clipboardData;
    const text = !!data?.types.includes("text/plain");
    const files = [...data?.files ?? []].filter(file => !text || !genericImage(file));
    if (!files.length || editingHere()) return;
    event.preventDefault();
    void attach(pastedFiles(files));
  });
  row.append(h("div", { className: "composer-controls" }, attachButton, textarea, mic, sendButton));
  const chips = h("div", { className: "attachment-chips" });
  const follow = h("div", { className: "follow-chips" });
  const services = h("div", { className: "service-chips", "data-testid": "service-chips" });
  const servicePicker = h("div", { className: "service-picker", role: "listbox", "aria-label": t("services"), hidden: true, "data-testid": "service-picker" });
  composerRefs = { textarea, send: sendButton, attach: attachButton, chips, follow, services, picker: servicePicker };
  if (!cachedSkills() && !skillsRequested) { skillsRequested = true; void loadSkills().then(() => updateComposer(), () => { skillsRequested = false; }); }
  void loadServices(id).catch(() => {});
  queueMicrotask(resizeComposer);
  const suggestions = h("div", { className: "suggestions", "data-testid": "suggestions" }, ...[t("suggestion1"), t("suggestion2"), t("suggestion3")].map(text =>
    h("button", { type: "button", className: "suggestion", onclick: () => { if (composerRefs) { composerRefs.textarea.value = text; void send(); } } }, text)));
  box = h("div", { className: "composer", "data-testid": "composer" }, follow, id === null ? suggestions : null, chips, row);
  return h("div", { className: "composer-wrap" }, servicePicker, services, box, picker, camera, photos);
}

const genericImage = (file: File) => file.type.startsWith("image/") && (!file.name || /^image\.(png|jpe?g|gif|webp|heic|heif|avif|bmp|tiff?)$/i.test(file.name));
function pastedFiles(files: File[]) {
  const generic = files.filter(genericImage);
  return files.map(file => {
    const index = generic.indexOf(file);
    if (index < 0) return file;
    const extension = (file.type.split("/")[1] ?? "png").replace("jpeg", "jpg").replace(/[^a-z0-9]/gi, "") || "png";
    return new File([file], generic.length === 1 ? `Pasted Image.${extension}` : `Pasted Image ${index + 1}.${extension}`, { type: file.type, lastModified: file.lastModified });
  });
}

let dragDepth = 0, dropsWatched = false;
const draggingFiles = (event: DragEvent) => !!event.dataTransfer?.types.includes("Files");
const dropTarget = () => {
  if (!state.paired || state.route.name !== "chat" || editingHere() || document.querySelector("dialog[open]")) return null;
  const composer = main?.querySelector<HTMLElement>(".composer");
  return composer?.isConnected ? composer : null;
};
function watchDrops() {
  if (dropsWatched) return;
  dropsWatched = true;
  const clear = () => { dragDepth = 0; document.querySelector(".composer.dropping")?.classList.remove("dropping"); };
  document.addEventListener("dragenter", event => {
    if (!draggingFiles(event) || !dropTarget()) return;
    dragDepth += 1;
    dropTarget()?.classList.add("dropping");
  });
  document.addEventListener("dragover", event => {
    if (!draggingFiles(event) || !dropTarget()) return;
    event.preventDefault();
    event.dataTransfer!.dropEffect = "copy";
  });
  document.addEventListener("dragleave", event => {
    if (!draggingFiles(event)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) clear();
  });
  document.addEventListener("drop", event => {
    if (!draggingFiles(event)) return;
    const target = dropTarget();
    clear();
    if (!target) return;
    event.preventDefault();
    void attach([...event.dataTransfer!.files]);
  });
}

const shownView = () => state.route.name === "chat" && state.view?.summary.id === state.route.id ? state.view : null;
function syncFilesChip() {
  if (!composerRefs) return;
  const files = conversationFiles(shownView());
  const current = composerRefs.services.querySelector<HTMLButtonElement>("[data-testid=files-chip]");
  if (!files.length) { current?.remove(); return; }
  if (current) updateFilesChip(current, files.length);
  else composerRefs.services.prepend(filesChip()!);
}

function conversationFiles(view: View | null) {
  if (!view) return [];
  const id = view.summary.id;
  const absolute = (path: string) => normalize(path.replace(/^\/+/, ""));
  const files: string[] = [];
  const add = (path: string) => {
    const file = absolute(path);
    if (!file || file === "MEMORY.md" || appPath(file) || /(^|\/)skills\//.test(file) || files.includes(file)) return;
    files.push(file);
  };
  for (const block of view.blocks) {
    if (block.kind.type === "userText") for (const path of (block.kind.files as string[] | undefined) ?? []) add(path);
    if (block.kind.type !== "thinking") continue;
    for (const entry of (block.kind.trace as Trace).entries) {
      const invocation = entry.invocation;
      if (!invocation?.args.path || !("succeeded" in invocation.outcome)) continue;
      const remove = (path: string) => {
        const removed = absolute(path);
        for (let index = files.length - 1; index >= 0; index--) if (files[index] === removed || files[index]!.startsWith(`${removed}/`)) files.splice(index, 1);
      };
      if (invocation.name === "ox.fs.move" && invocation.args.from) remove(invocation.args.from);
      if (/^ox\.fs\.(write|edit|copy|move)$/.test(invocation.name)) add(invocation.args.path);
      else if (invocation.name === "ox.fs.rm") remove(invocation.args.path);
    }
  }
  return files;
}

function updateFilesChip(chip: HTMLButtonElement, count: number) {
  chip.setAttribute("aria-label", t("filesCount", { count }));
  chip.querySelector(".files-count")!.textContent = `· ${count}`;
}

function filesChip() {
  const files = conversationFiles(shownView());
  if (!files.length) return null;
  const kind = (path: string): IconName => imageExtensions.test(path) ? "image" : audioExtensions.test(path) ? "speaker" : "file";
  const chip: HTMLButtonElement = h("button", { type: "button", className: "service-chip files-chip", "aria-haspopup": "menu", "data-testid": "files-chip",
    onclick: () => menu(chip, conversationFiles(shownView()).map(path => ({ label: path.split("/").at(-1)!, icon: kind(path), testID: "files-chip-item",
      run: () => openFile(path) })), { className: "files-menu" }) },
    icon("folder", 14), h("span", { className: "service-chip-name" }, t("files")), h("span", { className: "files-count" }));
  updateFilesChip(chip, files.length);
  return chip;
}

function updateComposer() {
  if (!composerRefs) return;
  const busy = isBusy();
  const editing = editingHere();
  const ready = !!composerRefs.textarea.value.trim() || (!editing && state.attachments.length > 0);
  composerRefs.attach.hidden = !!editing;
  const mode = busy ? "stop" : "send";
  if (composerRefs.send.dataset.state !== mode) composerRefs.send.replaceChildren(icon(mode, busy ? 14 : 20));
  composerRefs.send.setAttribute("aria-label", busy ? t("stop") : t("send"));
  composerRefs.send.dataset.state = mode;
  composerRefs.send.disabled = !busy && (!ready || state.uploading > 0 || state.sending || !state.settings?.providers.some(provider => provider.configured));
  composerRefs.send.hidden = !busy && !ready && !state.sending;
  composerRefs.chips.replaceChildren(...state.attachments.map(file => h("span", { className: "chip", "data-testid": "attachment-chip" }, icon("file", 14), h("span", {}, file.name),
    h("button", { type: "button", className: "chip-remove", "aria-label": t("removeAttachment"), onclick: () => {
      state.attachments = state.attachments.filter(item => item !== file); updateComposer();
    } }, icon("close", 12)))), ...(state.uploading ? [h("span", { className: "chip muted" }, t("uploading"))] : []));
  const intents = !busy ? state.view?.follow ?? [] : [];
  composerRefs.follow.replaceChildren(...intents.map(intent => h("button", { type: "button", className: "follow-chip", "data-testid": "follow-chip",
    onclick: () => { composerRefs!.textarea.value = intent.message; void send(); } }, intent.label)),
    ...(!intents.length && memoryIntent() ? [h("button", { type: "button", className: "follow-chip", "data-testid": "import-memory",
      onclick: () => { if (memoryIntent()) void send({ skill: "import-memory", title: t("importMemory") }); else updateComposer(); } }, t("importMemory"))] : []));
}

const memoryVisits = new WeakSet<object>();
function memoryIntent() {
  const route = state.route;
  const skill = cachedSkills()?.find(row => row.name === "import-memory");
  if (route.name !== "chat" || route.id !== null || state.temporaryDraft || !composerRefs || composerRefs.textarea.value || state.attachments.length || state.uploading
    || state.pendingServices.length || isBusy() || state.sending || editingHere() || !skill?.builtIn || !skill.enabled || !state.settings?.providers.some(provider => provider.configured)) return false;
  if (memoryVisits.has(route)) return true;
  if (document.querySelector("dialog[open]")) return false;
  const shown = Number(localStorage.getItem("ox.memoryIntent") ?? 0) || 0;
  if (shown >= 3) return false;
  memoryVisits.add(route);
  try { localStorage.setItem("ox.memoryIntent", String(shown + 1)); } catch {}
  return true;
}

async function loadServices(conversation: number | null) {
  const shown = () => (state.route.name === "chat" ? state.route.id : null) === conversation;
  if (!shown()) return;
  const request = ++servicesRequest;
  const { services } = await api<{ services: ServiceItem[] }>(`/api/services${conversation === null ? "" : `?conversation=${conversation}`}`);
  if (request !== servicesRequest || !shown()) return;
  serviceCatalog = services.filter(service => service.available);
  attachedServices = conversation === null ? [] : serviceCatalog.filter(service => service.attached);
  attachedFor = conversation;
  renderServiceChips();
  updatePicker();
}

function chosenServices(): ServiceItem[] {
  const id = state.route.name === "chat" ? state.route.id : null;
  if (id === null) return state.pendingServices.map(domain => serviceCatalog.find(service => service.domain === domain) ?? { domain, name: domain, available: true });
  return attachedFor === id ? attachedServices : [];
}

function editingHere() {
  const editing = state.editing;
  return editing && state.route.name === "chat" && state.route.id === editing.conversation ? editing : null;
}

function startEdit(entry: number, text: string) {
  if (!composerRefs || state.route.name !== "chat" || state.route.id === null) return;
  state.editing = { conversation: state.route.id, entry };
  state.attachments = [];
  composerRefs.textarea.value = text;
  state.drafts.set(draftKey(), text);
  resizeComposer();
  renderServiceChips();
  updateComposer();
  composerRefs.textarea.focus();
  composerRefs.textarea.setSelectionRange(text.length, text.length);
}

function cancelEdit() {
  state.editing = null;
  if (composerRefs) { composerRefs.textarea.value = ""; state.drafts.delete(draftKey()); resizeComposer(); }
  renderServiceChips();
  updateComposer();
}

async function rerunFrom(id: number, entry: number, text?: string) {
  const { id: created } = await api<{ id: number }>(`/api/conversations/${id}/rerun`, { method: "POST", json: { entry, ...(text === undefined ? {} : { text }) } });
  viewCache.delete(id);
  state.conversations = state.conversations.filter(item => item.id !== id);
  scheduleList();
  go(`#/c/${created}`, true);
}

async function regenerate(id: number, entry: number) {
  if (await ask({ title: t("regenerateTitle"), message: t("regenerateBody"), confirm: t("regenerateConfirm"), destructive: true }) !== "confirm") return;
  await rerunFrom(id, entry).catch(failed);
}

async function branchFrom(id: number, entry: number) {
  if (await ask({ title: t("branchTitle"), message: t("branchBody"), confirm: t("branchConfirm") }) !== "confirm") return;
  await api<{ id: number }>(`/api/conversations/${id}/branch`, { method: "POST", json: { entry } }).then(({ id: created }) => { scheduleList(); go(`#/c/${created}`); }, failed);
}

function conversationText(view: View) {
  const parts: string[] = [];
  let reply: string[] = [];
  const flush = () => { if (reply.length) parts.push(`${t("transcriptOx")}\n${reply.join("\n\n")}`); reply = []; };
  for (const block of view.blocks) {
    const kind = block.kind;
    if (kind.type === "userText") {
      flush();
      if (typeof kind.schedule === "string") { parts.push(t("transcriptSchedule", { name: kind.schedule.trim() || t("schedule") })); continue; }
      const skill = kind.skill as { name: string; argument: string } | undefined;
      if (skill) { parts.push([t("transcriptYou"), `/${skill.name}${skill.argument ? ` ${skill.argument}` : ""}`].join("\n")); continue; }
      const files = ((kind.files as string[] | undefined) ?? []).map(path => path.split("/").at(-1)!);
      parts.push([t("transcriptYou"), String(kind.text ?? ""), files.length ? t("transcriptFiles", { names: files.join(", ") }) : ""].filter(Boolean).join("\n"));
    } else if (kind.type === "agentContent" && !kind.failure) reply.push(...((kind.items as Item[] | undefined) ?? []).flatMap(item => item.text?.trim() ? [item.text.trim()] : []));
  }
  flush();
  return parts.join("\n\n");
}

function discardTemporary() {
  const id = temporaryID;
  if (id === null) return;
  temporaryID = null;
  viewCache.delete(id);
  void api(`/api/conversations/${id}`, { method: "DELETE" }).catch(() => {});
}

function renderServiceChips() {
  const editing = editingHere();
  const files = filesChip();
  composerRefs?.services.replaceChildren(...(files ? [files] : []), ...(editing ? [h("button", { type: "button", className: "service-chip editing-chip", "aria-label": t("cancelEditing"), title: t("cancelEditing"),
    "data-testid": "editing-chip", onclick: cancelEdit }, icon("pencil", 14), h("span", { className: "service-chip-name" }, t("editingMessage")), icon("close", 12))] : []), ...chosenServices().map(service => h("span", { className: "service-chip", "data-testid": "service-chip", "data-domain": service.domain },
    avatar(service.name, service.domain, true), h("span", { className: "service-chip-name" }, service.name),
    h("button", { type: "button", className: "chip-remove", "aria-label": t("removeService", { name: service.name }), title: t("removeService", { name: service.name }),
      "data-testid": "service-chip-remove", onclick: () => void detachService(service.domain) }, icon("close", 12)))));
}

async function attachService(domain: string) {
  const id = state.route.name === "chat" ? state.route.id : null;
  if (id === null) {
    if (!state.pendingServices.includes(domain)) state.pendingServices = [...state.pendingServices, domain];
    renderServiceChips();
    updateComposer();
    return;
  }
  await api(`/api/services/${encodeURIComponent(domain)}/attach`, { method: "POST", json: { conversation: id } }).then(() => loadServices(id), failed);
}

async function detachService(domain: string) {
  const id = state.route.name === "chat" ? state.route.id : null;
  if (id === null) {
    state.pendingServices = state.pendingServices.filter(item => item !== domain);
    renderServiceChips();
    updateComposer();
    return;
  }
  await api(`/api/services/${encodeURIComponent(domain)}/attach?conversation=${id}`, { method: "DELETE" }).then(() => loadServices(id), failed);
}

function mentionQuery() {
  const textarea = composerRefs?.textarea;
  if (!textarea || textarea.selectionStart !== textarea.selectionEnd || document.activeElement !== textarea) return null;
  return mentionPattern.exec(textarea.value.slice(0, textarea.selectionStart))?.[1] ?? null;
}

function slashQuery() {
  const textarea = composerRefs?.textarea;
  if (!textarea || document.activeElement !== textarea || editingHere()) return null;
  return /^\/(\S*)$/.exec(textarea.value)?.[1] ?? null;
}

const invocableSkills = () => (cachedSkills() ?? []).filter(skill => !skill.builtIn && skill.enabled);

function slashInvocation(text: string) {
  const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text);
  if (!match) return null;
  const skill = invocableSkills().find(row => row.name.toLowerCase() === match[1]!.toLowerCase());
  return skill ? { name: skill.name, argument: (match[2] ?? "").trim() } : null;
}

function updateSlashPicker(picker: HTMLElement, query: string) {
  const needle = query.toLowerCase();
  const matches = invocableSkills().filter(skill => !needle || skill.name.toLowerCase().includes(needle));
  if (!matches.length) { picker.hidden = true; pickerQuery = null; return; }
  if (`/${query}` !== pickerQuery) { pickerIndex = 0; pickerQuery = `/${query}`; }
  pickerIndex = Math.min(pickerIndex, matches.length - 1);
  picker.hidden = false;
  picker.dataset.mode = "skills";
  picker.setAttribute("aria-label", t("skills"));
  const room = picker.parentElement!.getBoundingClientRect().top - (main?.querySelector(".topbar")?.getBoundingClientRect().bottom ?? 0) - 12;
  picker.style.maxHeight = `${Math.max(44, Math.min(280, room))}px`;
  picker.replaceChildren(...matches.map((skill, index) => h("button", { type: "button", className: "skill-option", role: "option", "aria-selected": String(index === pickerIndex),
    tabindex: "-1", "data-testid": "skill-option", "data-skill": skill.name, onpointerdown: (event: Event) => event.preventDefault(), onclick: () => chooseSkill(skill.name) },
    h("span", { className: "skill-option-name" }, `/${skill.name}`), h("span", { className: "skill-option-description" }, skill.description))));
  picker.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
}

function chooseSkill(name: string) {
  const textarea = composerRefs?.textarea;
  if (!textarea) return;
  composerRefs!.picker.hidden = true;
  pickerQuery = null;
  textarea.value = `/${name}`;
  if (!isBusy()) void send();
}

function updatePicker() {
  const picker = composerRefs?.picker;
  if (!picker) return;
  if (pickerDismissed !== null && composerRefs!.textarea.value !== pickerDismissed) pickerDismissed = null;
  const slash = slashQuery();
  if (slash !== null && composerRefs!.textarea.value !== pickerDismissed) {
    if (!cachedSkills()) { picker.hidden = true; if (!skillsRequested) { skillsRequested = true; void loadSkills().then(() => updatePicker(), () => { skillsRequested = false; }); } return; }
    updateSlashPicker(picker, slash);
    return;
  }
  const query = mentionQuery();
  if (query === null || composerRefs!.textarea.value === pickerDismissed) { picker.hidden = true; pickerQuery = null; return; }
  picker.dataset.mode = "services";
  picker.setAttribute("aria-label", t("services"));
  pickerDismissed = null;
  if (query !== pickerQuery) { pickerIndex = 0; pickerQuery = query; }
  const taken = new Set(chosenServices().map(service => service.domain)), needle = query.toLocaleLowerCase();
  const matches = serviceCatalog.filter(service => !taken.has(service.domain) && (!needle || `${service.name} ${service.domain}`.toLocaleLowerCase().includes(needle)))
    .sort((a, b) => Number(!!b.saved) - Number(!!a.saved) || a.name.localeCompare(b.name, locale)).slice(0, 40);
  pickerIndex = Math.min(pickerIndex, Math.max(0, matches.length - 1));
  picker.hidden = false;
  const room = picker.parentElement!.getBoundingClientRect().top - (main?.querySelector(".topbar")?.getBoundingClientRect().bottom ?? 0) - 12;
  picker.style.maxHeight = `${Math.max(120, Math.min(334, room))}px`;
  picker.replaceChildren(
    h("a", { href: "#/settings/services", className: "service-picker-head", "data-testid": "service-picker-head", onpointerdown: (event: Event) => event.preventDefault() },
      h("span", {}, t("services")), icon("plug", 18)),
    ...(matches.length ? matches.map((service, index) => h("button", { type: "button", className: "service-option", role: "option", "aria-selected": String(index === pickerIndex),
      tabindex: "-1", "data-testid": "service-option", "data-domain": service.domain, onpointerdown: (event: Event) => event.preventDefault(), onclick: () => chooseService(service.domain) },
      avatar(service.name, service.domain, true), h("span", {}, service.name)))
      : [h("div", { className: "service-picker-empty", "data-testid": "service-picker-empty" }, icon("plug", 24), h("span", {}, t("noServicesFound")))]));
  picker.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
}

function pickerKey(event: KeyboardEvent) {
  const picker = composerRefs?.picker;
  if (!picker || picker.hidden || event.isComposing) return false;
  const options = [...picker.querySelectorAll<HTMLElement>(".service-option, .skill-option")];
  if ((event.key === "ArrowDown" || event.key === "ArrowUp") && options.length) {
    pickerIndex = (pickerIndex + (event.key === "ArrowDown" ? 1 : options.length - 1)) % options.length;
    updatePicker();
  } else if ((event.key === "Enter" || event.key === "Tab") && options.length) {
    const option = options[pickerIndex]!;
    if (option.dataset.skill) chooseSkill(option.dataset.skill); else chooseService(option.dataset.domain!);
  }
  else if (event.key === "Escape") { pickerDismissed = composerRefs!.textarea.value; picker.hidden = true; }
  else return false;
  event.preventDefault();
  return true;
}

function startMention() {
  const textarea = composerRefs?.textarea;
  if (!textarea) return;
  textarea.value += !textarea.value || /\s$/.test(textarea.value) ? "@" : " @";
  textarea.focus();
  textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  textarea.dispatchEvent(new Event("input"));
}

function chooseService(domain: string) {
  const textarea = composerRefs?.textarea;
  if (!textarea) return;
  const caret = textarea.selectionStart, before = textarea.value.slice(0, caret);
  const start = before.lastIndexOf("@");
  if (start >= 0) {
    const kept = before.slice(0, start).replace(/ $/, "");
    textarea.value = kept + textarea.value.slice(caret);
    textarea.setSelectionRange(kept.length, kept.length);
    textarea.dispatchEvent(new Event("input"));
  }
  composerRefs!.picker.hidden = true;
  void attachService(domain);
}

async function ensureConversation(text: string, busy = true) {
  if (state.route.name === "chat" && state.route.id !== null) return state.route.id;
  const chosen = state.pendingServices, temporary = state.temporaryDraft;
  const created = await api<{ id: number }>("/api/conversations", { method: "POST", json: { model: state.draftModel ?? state.settings?.defaultModel ?? undefined, ...(temporary ? { temporary } : {}) } });
  if (temporary) { temporaryID = created.id; state.temporaryDraft = false; }
  state.pendingServices = state.pendingServices.filter(domain => !chosen.includes(domain));
  if (state.route.name === "chat" && state.route.id === null) {
    history.replaceState(null, "", `#/c/${created.id}`);
    state.route = { name: "chat", id: created.id };
    servicesRequest += 1;
    attachedFor = created.id;
    attachedServices = serviceCatalog.filter(service => chosen.includes(service.domain));
    const draft = state.drafts.get("new");
    state.drafts.delete("new");
    if (draft) state.drafts.set(String(created.id), draft);
    if (state.view?.summary.id === PENDING) state.view = { ...state.view, summary: { ...state.view.summary, id: created.id } };
    if (state.optimistic?.id === PENDING) state.optimistic.id = created.id;
    if (anchor?.id === PENDING) anchor.id = created.id;
  }
  const now = Date.now();
  if (!temporary) state.conversations = [{ id: created.id, title: text.split("\n")[0]!.slice(0, 80), model: state.draftModel ?? state.settings?.defaultModel ?? null, createdAt: now, lastActivity: now, unread: false, favorite: false, busy },
    ...state.conversations.filter(item => item.id !== created.id)];
  renderSidebarList();
  renderConversationHeader();
  if (chosen.length) await Promise.all(chosen.map(domain => api(`/api/services/${encodeURIComponent(domain)}/attach`, { method: "POST", json: { conversation: created.id } }).catch(failed)));
  void loadServices(created.id).catch(() => {});
  return created.id;
}

async function isZip(file: File) {
  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer().catch(() => new ArrayBuffer(0)));
  return head.length === 4 && head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
}

async function attach(files: File[]) {
  if (!files.length) return;
  const single = files.length === 1 ? files[0]! : undefined;
  if (single && /\.(conversation|chat|service)$/i.test(single.name) && await isZip(single)) {
    if (/\.service$/i.test(single.name)) void importServiceFile(single); else void importPackage(single);
    return;
  }
  state.uploading += files.length;
  updateComposer();
  try {
    const id = await ensureConversation(files[0]?.name ?? "", false);
    for (const file of files) {
      try {
        const stored = await api<Entry>(`/api/conversations/${id}/attachments?name=${encodeURIComponent(file.name)}`, { method: "POST", body: file });
        state.attachments.push({ path: stored.path, name: stored.name });
        updateComposer();
      } catch (error) { failed(error); }
    }
  } catch (error) { failed(error); }
  finally { state.uploading -= files.length; updateComposer(); }
}

function placeholder(text: string, id = PENDING): View {
  const now = Date.now();
  return { summary: { id, title: text.split("\n")[0]!.slice(0, 80), model: state.draftModel ?? state.settings?.defaultModel ?? null, createdAt: now, lastActivity: now, unread: false, favorite: false, busy: true,
    temporary: id === PENDING && state.temporaryDraft },
    blocks: [], busy: true, follow: [], error: null };
}

function moveComposerDown() {
  if (!main?.classList.contains("empty")) return false;
  const moving = [...main.querySelectorAll<HTMLElement>(".service-chips, .composer")];
  const first = moving.map(element => element.getBoundingClientRect().top);
  main.classList.remove("empty");
  moving.forEach((element, index) => {
    const offset = first[index]! - element.getBoundingClientRect().top;
    if (!reducedMotion.matches && offset) element.animate([{ transform: `translateY(${offset}px)` }, { transform: "none" }], { duration: 320, easing: "cubic-bezier(.2,.8,.2,1)" });
  });
  return true;
}

async function send(direct?: { skill: string; title: string }) {
  if (!composerRefs || state.sending) return;
  const origin = state.route;
  const text = direct ? "" : composerRefs.textarea.value.trim();
  const attachments = direct ? [] : state.attachments;
  const files = attachments.map(file => file.path);
  if (!text && !files.length && !direct) return;
  const retryKey = draftKey(), submission = JSON.stringify([text, files, direct?.skill ?? null]);
  if (state.unconfirmedSends.get(retryKey) === submission) {
    if (await ask({ title: t("sendAgainTitle"), message: t("sendAgainBody"), confirm: t("sendAgainConfirm") }) !== "confirm") return;
    if (state.sending) return;
    if (state.route !== origin) { toast(t("sendAgainChanged"), "info"); return; }
  }
  const editing = direct ? null : editingHere();
  if (editing) {
    if (!text) return;
    state.sending = true;
    state.editing = null;
    composerRefs.textarea.value = "";
    state.drafts.delete(draftKey());
    resizeComposer();
    renderServiceChips();
    updateComposer();
    try { await rerunFrom(editing.conversation, editing.entry, text); }
    catch (error) {
      failed(error);
      if (composerRefs && editingHere() === null && state.route.name === "chat" && state.route.id === editing.conversation) {
        state.editing = editing;
        composerRefs.textarea.value = text;
        resizeComposer();
        renderServiceChips();
      }
    } finally { state.sending = false; updateComposer(); }
    return;
  }
  state.sending = true;
  const route = state.route.name === "chat" ? state.route.id : null;
  if (route !== null && state.view?.summary.id !== route && !main?.classList.contains("empty")) await loadView().catch(() => {});
  if (!composerRefs || shownId() !== (route ?? PENDING)) { state.sending = false; updateComposer(); return; }
  let target = route;
  state.attachments = [];
  composerRefs.textarea.value = "";
  resizeComposer();
  state.drafts.delete(draftKey());
  if (!wide.matches) composerRefs.textarea.blur();
  const shown = route ?? PENDING;
  const current = state.view?.summary.id === shown ? state.view : null;
  const users = current ? userCount(current) : 0;
  const invocation = direct ? { name: direct.skill, argument: "" } : slashInvocation(text);
  state.view = current ? { ...current, busy: true, follow: [], error: null } : placeholder(direct?.title ?? (invocation ? text : text || files[0] || ""), shown);
  state.optimistic = { id: shown, text, files, users, ...(invocation ? { skill: invocation } : {}) };
  anchor = { id: shown, users: users + 1 };
  pendingScroll = true;
  if (moveComposerDown()) transcriptRoot?.replaceChildren();
  renderConversation();
  updateComposer();
  try {
    target = await ensureConversation(direct?.title ?? text);
    if (direct && route === null) await api(`/api/conversations/${target}`, { method: "PATCH", json: { title: direct.title } });
    await api(`/api/conversations/${target}/messages`, { method: "POST", json: invocation ? { skill: invocation.name, text: invocation.argument, attachments: files } : { text, attachments: files } });
    state.unconfirmedSends.delete(retryKey);
    state.unconfirmedSends.delete(String(target));
    scheduleView(120);
    scheduleList();
  } catch (error) {
    if (!(error instanceof APIError) || error.status === 408 || error.status >= 500) state.unconfirmedSends.set(target === null ? retryKey : String(target), submission);
    failed(error);
    if (direct && route === null && target !== null && error instanceof APIError && error.status >= 400 && error.status < 500) {
      const created = target;
      state.optimistic = null;
      anchor = null;
      if (state.view?.summary.id === created) state.view = null;
      viewCache.delete(created);
      state.conversations = state.conversations.filter(item => item.id !== created);
      renderSidebarList();
      void api(`/api/conversations/${created}`, { method: "DELETE" }).catch(() => {}).finally(scheduleList);
      if (shownId() === created) {
        go("#/", true);
        if (memoryVisits.has(origin)) memoryVisits.add(state.route);
      }
      return;
    }
    const key = target === null ? "new" : String(target);
    if (text && !state.drafts.get(key)) state.drafts.set(key, text);
    state.optimistic = null;
    anchor = null;
    if (shownId() === (target ?? PENDING)) {
      state.attachments = attachments;
      if (composerRefs && !composerRefs.textarea.value) { composerRefs.textarea.value = text; resizeComposer(); }
      if (state.view?.summary.id === PENDING) { state.view = null; renderMain(); }
      else if (state.view?.summary.id === target) { state.view = { ...state.view, busy: false }; renderConversation(); }
    }
  } finally { state.sending = false; updateComposer(); }
}

async function stop() {
  if (state.route.name !== "chat" || state.route.id === null) return;
  await api(`/api/conversations/${state.route.id}/stop`, { method: "POST" }).catch(failed);
  scheduleView();
}

function contentEnd(scroller: HTMLElement) { return Math.max(0, scroller.scrollHeight - (spacer?.offsetHeight ?? 0) - scroller.clientHeight); }

function updateJump() {
  const scroller = transcriptRoot?.parentElement;
  if (!scroller || !jump) return;
  atEnd = contentEnd(scroller) - scroller.scrollTop <= 2;
  jump.classList.toggle("visible", contentEnd(scroller) - scroller.scrollTop > 160);
}

document.addEventListener("content-change", () => {
  const scroller = transcriptRoot?.parentElement;
  if (!scroller?.isConnected) return;
  if (atEnd && !(anchor && anchor.id === state.view?.summary.id)) scroller.scrollTop = contentEnd(scroller);
  layoutSpacer();
  updateJump();
});
function scrollToEnd(smooth = false) {
  const scroller = transcriptRoot?.parentElement;
  if (!scroller) return;
  requestAnimationFrame(() => { scroller.scrollTo({ top: contentEnd(scroller), behavior: smooth && !reducedMotion.matches ? "smooth" : "auto" }); updateJump(); });
}

function lastUserBubble() {
  const bubbles = transcriptRoot?.querySelectorAll<HTMLElement>('[data-testid="user-message"], [data-testid="skill-message"]');
  return bubbles?.[bubbles.length - 1];
}

function layoutSpacer() {
  const scroller = transcriptRoot?.parentElement;
  if (!scroller || !spacer) return;
  const target = anchor && anchor.id === state.view?.summary.id && !main?.classList.contains("empty") ? lastUserBubble() : undefined;
  const height = target ? Math.max(0, scroller.clientHeight - 16 - (spacer.offsetTop - target.offsetTop)) : 0;
  if (spacer.offsetHeight !== Math.round(height)) spacer.style.height = `${Math.round(height)}px`;
}

function anchorScroll() {
  const scroller = transcriptRoot?.parentElement, target = lastUserBubble();
  if (!scroller || !target) return;
  const top = target.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - 16;
  scroller.scrollTo({ top: Math.max(0, top), behavior: reducedMotion.matches ? "auto" : "smooth" });
}

function reconcile(parent: HTMLElement, elements: HTMLElement[]) {
  const kept = new Set<Element>(elements);
  for (const child of [...parent.children]) if (!kept.has(child)) child.remove();
  elements.forEach((element, index) => { if (parent.children[index] !== element) parent.insertBefore(element, parent.children[index] ?? null); });
}

function cachedBlock(block: Block, signature: string, build: (previous?: HTMLElement) => HTMLElement) {
  const cached = blockCache.get(block.id);
  if (cached && cached.signature === signature) return cached.element;
  const element = build(cached?.element);
  element.dataset.block = block.id;
  blockCache.set(block.id, { signature, element });
  return element;
}

let schedulesRequested = false;
function createdSchedules(block: Block) {
  return ((block.kind.trace as Trace | undefined)?.entries ?? []).flatMap(entry => {
    const result = entry.invocation?.name === "ox.schedule.create" ? entry.invocation.outcome.succeeded?._0 : undefined;
    return result && typeof result === "object" && typeof (result as { id?: unknown }).id === "string" ? [result as { id: string; name?: string }] : [];
  });
}

function scheduleRow(key: string, created: { id: string; name?: string }) {
  const list = cachedSchedules();
  if (!list && !schedulesRequested) {
    schedulesRequested = true;
    void loadSchedules().then(() => renderConversation(), () => {});
  }
  const schedule = list ? list.find(row => row.id === created.id) ?? null : undefined;
  const signature = JSON.stringify([created, schedule === undefined ? "loading" : schedule && [schedule.name, schedule.state, schedule.recurrence, schedule.summary]]);
  const cached = blockCache.get(key);
  if (cached && cached.signature === signature) return cached.element;
  const element = scheduleCard(created, schedule, cached?.element as HTMLButtonElement | undefined);
  blockCache.set(key, { signature, element });
  return element;
}

function refreshSchedules() {
  schedulesRequested = false;
  if (cachedSchedules()) void loadSchedules().then(() => { if (state.route.name === "chat") renderConversation(); }, () => {});
}

let skillsRequested = false;
function createdSkills(block: Block) {
  return [...new Set(((block.kind.trace as Trace | undefined)?.entries ?? []).flatMap(entry => {
    const result = entry.invocation?.outcome.succeeded?._0;
    return result && typeof result === "object" && typeof (result as { skill?: unknown }).skill === "string" ? [(result as { skill: string }).skill] : [];
  }))];
}

function skillRow(key: string, name: string) {
  const list = cachedSkills();
  if (!list && !skillsRequested) {
    skillsRequested = true;
    void loadSkills().then(() => renderConversation(), () => {});
  }
  const skill = list ? list.find(row => row.name === name) ?? null : undefined;
  const signature = JSON.stringify([name, skill === undefined ? "loading" : skill && [skill.description, skill.source]]);
  const cached = blockCache.get(key);
  if (cached && cached.signature === signature) return cached.element;
  const element = skillCard(name, skill, cached?.element as HTMLButtonElement | undefined);
  blockCache.set(key, { signature, element });
  return element;
}

function refreshSkills() {
  skillsRequested = false;
  if (cachedSkills()) void loadSkills().then(() => { if (state.route.name === "chat") renderConversation(); updateComposer(); }, () => {});
}

function actionButton(name: IconName, label: string, testID: string, run: () => void, disabled = false) {
  return h("button", { type: "button", className: "icon-button action", "aria-label": label, title: label, "data-testid": testID, disabled, onclick: run }, icon(name, 18));
}

function replyActions(key: string, texts: string[], view: View, entry: number | undefined) {
  const text = texts.join("\n\n");
  const mutable = entry !== undefined && !view.summary.temporary;
  const signature = `${view.summary.id}\u0000${text}\u0000${entry ?? ""}\u0000${mutable}\u0000${view.busy}`;
  const cached = blockCache.get(key);
  if (cached && cached.signature === signature) return cached.element;
  const copy = h("button", { type: "button", className: "icon-button action", "aria-label": t("copyReply"), title: t("copyReply"), "data-testid": "copy-reply" }, icon("copy", 18));
  copy.addEventListener("click", () => copyText(copy, text, 18));
  const id = view.summary.id;
  const share = typeof navigator.share === "function"
    ? actionButton("share", t("shareReply"), "share-reply", () => void navigator.share({ text: text.trim() || t("noReplyText") }).catch(() => {})) : null;
  const element = h("div", { className: "reply-actions", "data-testid": "reply-actions" }, copy, canSpeak() ? readAloudButton(() => text) : null, share,
    mutable ? actionButton("branch", t("branchReply"), "branch-reply", () => void branchFrom(id, entry!), view.busy) : null,
    mutable ? actionButton("reload", t("regenerateReply"), "regenerate-reply", () => void regenerate(id, entry!), view.busy) : null);
  blockCache.set(key, { signature, element });
  return element;
}

function renderConversation(initial = false) {
  if (!transcriptRoot || state.route.name !== "chat" || main?.classList.contains("empty")) return;
  const view = state.view;
  if (!view || view.summary.id !== shownId()) return;
  const users = userCount(view);
  if (state.optimistic && (state.optimistic.id !== view.summary.id || users > state.optimistic.users)) state.optimistic = null;
  const resolve = resolver(view.summary.id);
  const pending = !!view.pendingPrompt;
  const elements: HTMLElement[] = [];
  const seen = new Set<string>();
  let texts: string[] = [];
  let turnEntry: number | undefined;
  const editable = !view.busy && !view.summary.temporary;
  let newPrompt: HTMLElement | undefined;
  const turnStart = view.blocks.map(block => block.kind.type).lastIndexOf("userText");
  view.blocks.forEach((block, index) => {
    revealFrom = !initial && view.busy && index > turnStart ? 0 : Number.POSITIVE_INFINITY;
    seen.add(block.id);
    const last = index === view.blocks.length - 1;
    const kind = block.kind;
    if (kind.type === "userText") turnEntry = typeof kind.entry === "number" ? kind.entry : undefined;
    const liveTrace = kind.type === "thinking" && last && view.busy;
    const signature = JSON.stringify(kind) + (state.expanded.has(block.id) ? "+" : "") + (liveTrace ? "~" : "") + (kind.type === "confirm" ? String(pending) : "")
      + (kind.type === "userText" ? `${editable}:${view.summary.id}` : "") + (kind.type === "thinking" ? `@${block.createdAt}` : "");
    const skillKind = kind.skill as { name: string; argument: string } | undefined;
    const matches = state.optimistic?.skill ? skillKind?.name === state.optimistic.skill.name && skillKind.argument === state.optimistic.skill.argument : String(kind.text ?? "") === state.optimistic?.text;
    if (kind.type === "userText" && state.optimistic?.element && !blockCache.has(block.id) && matches) {
      blockCache.set(block.id, { signature, element: state.optimistic.element });
      state.optimistic.element.classList.remove("appear");
    }
    const element = kind.type === "agentContent" ? cachedBlock(block, signature, previous => agentContent(block, previous, resolve, pending))
      : cachedBlock(block, signature, () => blockElement(block, resolve, pending, liveTrace, editable));
    if (kind.type === "confirm" && (kind as PromptKind).promptId && !element.isConnected) newPrompt = element;
    elements.push(element);
    if (kind.type === "thinking") {
      for (const created of createdSchedules(block)) {
        const key = `schedule:${block.id}:${created.id}`;
        elements.push(scheduleRow(key, created));
        seen.add(key);
      }
      for (const name of createdSkills(block)) {
        const key = `skill:${block.id}:${name}`;
        elements.push(skillRow(key, name));
        seen.add(key);
      }
    }
    if (kind.type === "agentContent" && !kind.failure) texts.push(...((kind.items as Item[] | undefined) ?? []).flatMap(item => item.text ? [item.text] : []));
    const turnEnd = last || view.blocks[index + 1]!.kind.type === "userText";
    if (turnEnd) {
      if (texts.length && !(last && view.busy)) { elements.push(replyActions(`actions:${block.id}`, texts, view, turnEntry)); seen.add(`actions:${block.id}`); }
      texts = [];
    }
  });
  revealFrom = Number.POSITIVE_INFINITY;
  for (const key of [...blockCache.keys()]) if (!seen.has(key)) blockCache.delete(key);
  if (state.optimistic) {
    state.optimistic.element ??= state.optimistic.skill ? skillMessage(state.optimistic.skill, state.optimistic.files, resolve, true)
      : userBubble(state.optimistic.text, state.optimistic.files, resolve, true);
    elements.push(state.optimistic.element);
  }
  const lastKind = view.blocks.at(-1)?.kind.type;
  if (view.busy && !pending && (state.optimistic || !lastKind || lastKind === "userText") && workingDot) elements.push(workingDot);
  if (view.error && !view.busy) elements.push(h("div", { className: "turn agent failure", "data-testid": "run-error" }, h("p", {}, hostText(view.error))));
  if (spacer) elements.push(spacer);
  reconcile(transcriptRoot, elements);
  renderConversationHeader();
  updateComposer();
  syncFilesChip();
  layoutSpacer();
  if (pendingScroll) { pendingScroll = false; anchorScroll(); }
  else if (newPrompt && !initial) newPrompt.scrollIntoView({ block: "nearest", behavior: reducedMotion.matches ? "auto" : "smooth" });
  updateJump();
  if (live.size) reveal();
}

function fileChips(files: string[], resolve: Resolve) {
  return files.length ? h("div", { className: "bubble-files" }, ...files.map(path => {
    const target = resolve(`/${path}`);
    return h("a", { className: "chip", href: target?.href ?? "#", target: "_blank", rel: "noopener noreferrer" }, icon("file", 14), h("span", {}, path.split("/").at(-1)!));
  })) : null;
}

function skillMessage(skill: { name: string; argument: string }, files: string[], resolve: Resolve, appear = false) {
  const description = cachedSkills()?.find(row => row.name === skill.name)?.description;
  const label = skill.name === "import-memory" ? t("importMemory") : `/${skill.name}`;
  return h("div", { className: `turn user skill-message${appear ? " appear" : ""}`, "data-testid": "skill-message" },
    h("button", { type: "button", className: "skill-bubble", "data-testid": "skill-bubble", "aria-label": description ? `${label}, ${description}` : label,
      onclick: () => openSkillDetails(skill.name) }, label),
    fileChips(files, resolve), skill.argument ? h("div", { className: "bubble", "data-testid": "skill-argument" }, skill.argument) : null);
}

function scheduleBubble(name: string) {
  const title = name.trim() || t("schedule");
  return h("div", { className: "turn user", "data-testid": "schedule-message" },
    h("div", { className: "schedule-bubble", role: "note", "aria-label": t("transcriptSchedule", { name: title }) }, icon("clock", 16), h("span", {}, title)));
}

function userBubble(text: string, files: string[], resolve: Resolve, appear = false, entry?: number, editable = false) {
  const copy = text ? h("button", { type: "button", className: "icon-button action", "aria-label": t("copyMessage"), title: t("copyMessage"), "data-testid": "copy-message" }, icon("copy", 18)) : null;
  copy?.addEventListener("click", () => copyText(copy, text, 18));
  const actions = entry === undefined ? null : h("div", { className: "user-actions", "data-testid": "user-actions" }, copy,
    editable && text ? actionButton("pencil", t("editMessage"), "edit-message", () => startEdit(entry, text)) : null);
  const bubble = text ? h("div", { className: "bubble" }, text) : null;
  const root = h("div", { className: `turn user${appear ? " appear" : ""}`, "data-testid": "user-message" }, fileChips(files, resolve), bubble, actions);
  if (actions) bubble?.addEventListener("click", () => { if (touch.matches) root.classList.toggle("show-actions"); });
  return root;
}

function itemKey(item: Item) {
  if (item.text !== undefined) return `text:${item.ref ?? ""}`;
  if (item.progress !== undefined) return `progress:${item.progress}`;
  return `page:${JSON.stringify(item.page)}:${item.page ? isPageOpen(item.page.id) : false}`;
}

function agentContent(block: Block, previous: HTMLElement | undefined, resolve: Resolve, pending: boolean) {
  const kind = block.kind;
  const items = (kind.items as Item[] | undefined) ?? [];
  const root = previous ?? h("div", {});
  root.className = `turn agent${kind.failure ? " failure" : ""}`;
  root.dataset.testid = kind.failure ? "agent-failure" : "agent-message";
  items.forEach((item, index) => {
    const key = itemKey(item);
    const current = root.children[index] as HTMLElement | undefined;
    if (current && current.dataset.key === key) {
      if (item.text !== undefined) patchItem(current, item, resolve);
      return;
    }
    const element = item.text !== undefined ? h("div", { className: "markdown", "data-ref": item.ref ?? null })
      : item.progress !== undefined ? h("div", { className: "progress-line", "data-testid": "progress" }, icon("spark", 14), h("span", {}, item.progress))
      : item.page ? pageItem(item.page, promptContext(pending)) : h("div");
    element.dataset.key = key;
    if (item.ref && item.text && !live.has(item.ref) && revealFrom === 0) live.set(item.ref, { text: item.text, shown: 0, kind: "text" });
    if (item.text !== undefined) patchItem(element, item, resolve);
    if (current) root.replaceChild(element, current); else root.append(element);
  });
  while (root.children.length > items.length) root.lastElementChild!.remove();
  return root;
}

function blockElement(block: Block, resolve: Resolve, pending: boolean, liveTrace = false, editable = false): HTMLElement {
  const kind = block.kind;
  if (kind.type === "userText" && typeof kind.schedule === "string") return scheduleBubble(kind.schedule);
  if (kind.type === "userText" && kind.skill) return skillMessage(kind.skill as { name: string; argument: string }, (kind.files as string[] | undefined) ?? [], resolve);
  if (kind.type === "userText") return userBubble(String(kind.text ?? ""), (kind.files as string[] | undefined) ?? [], resolve, false, typeof kind.entry === "number" ? kind.entry : undefined, editable);
  if (kind.type === "thinking") return activity(block, liveTrace);
  if (kind.type === "confirm") {
    const prompt = kind as PromptKind;
    if (prompt.promptKind === "approval") return approvalCard(prompt, promptContext(pending));
    if (prompt.promptKind === "form") return formCard(prompt, promptContext(pending));
    if (prompt.promptKind === "page") return pageHandoffCard(prompt, promptContext(pending));
    return requestCard(block, pending);
  }
  return h("div");
}

function stepIcon(outcome: Invocation["outcome"]) {
  if ("running" in outcome) return loader(14);
  return h("span", { className: `step-status ${"failed" in outcome ? "error" : "ok"}` }, icon("failed" in outcome ? "close" : "check", 12));
}

function thoughtFor(duration: number) {
  const seconds = Math.max(1, Math.round(duration));
  if (seconds < 60) return seconds === 1 ? t("thoughtForSecond") : t("thoughtForSeconds", { seconds });
  return t(seconds % 60 === 1 ? "thoughtForMinutesSecond" : "thoughtForMinutes", { minutes: Math.floor(seconds / 60), seconds: seconds % 60 });
}

function activity(block: Block, liveTrace = false) {
  const trace = block.kind.trace as Trace;
  const invocations = trace.entries.flatMap(entry => entry.invocation ? [entry.invocation] : []);
  const running = invocations.filter(invocation => "running" in invocation.outcome);
  const endedInFailure = !!invocations.length && "failed" in invocations.at(-1)!.outcome;
  const expanded = state.expanded.has(block.id);
  if (!invocations.length && !trace.entries.length) return h("div", { hidden: true });
  const working = running.length > 0 || liveTrace;
  const label = running.length ? (running.at(-1)!.purpose || running.at(-1)!.name) : liveTrace ? t("thinking")
    : !invocations.length ? (typeof trace.completedAt === "number" && trace.completedAt > block.createdAt ? thoughtFor(trace.completedAt - block.createdAt) : t("thought"))
    : `${t("activity")} · ${invocations.length === 1 ? t("step") : t("steps", { count: invocations.length })}`;
  const toggle = h("button", { type: "button", className: "activity-summary", "aria-expanded": expanded ? "true" : "false", "data-testid": "activity-toggle",
    onclick: () => { if (state.expanded.has(block.id)) state.expanded.delete(block.id); else state.expanded.add(block.id); renderConversation(); } },
    working ? loader(16) : endedInFailure ? h("span", { className: "step-status error" }, icon("close", 12)) : null,
    h("span", { className: working ? "shimmer" : "" }, label), icon("chevron", 14));
  const details = expanded ? h("div", { className: "activity-steps" }, ...trace.entries.map(entry => {
    if (entry.reasoning) return h("div", { className: "step reasoning" }, h("span", { className: "step-name" }, t("reasoning")),
      h("p", { "data-ref": entry.reasoning.ref ?? null }, entry.reasoning.ref && live.has(entry.reasoning.ref) ? live.get(entry.reasoning.ref)!.text.slice(0, live.get(entry.reasoning.ref)!.shown) : entry.reasoning.text));
    const invocation = entry.invocation!;
    const result = Object.values(invocation.outcome)[0]?._0;
    return h("div", { className: "step", "data-testid": "activity-step" }, stepIcon(invocation.outcome),
      h("div", { className: "step-body" },
        h("div", { className: "step-title" }, invocation.purpose || invocation.name, invocation.purpose ? h("span", { className: "step-name" }, invocation.name) : null),
        invocation.args.path ? appPath(invocation.args.path) ? h("span", { className: "step-path" }, invocation.args.path)
          : h("a", { href: fileURL(invocation.args.path), target: "_blank", rel: "noopener noreferrer", className: "file-link step-path" }, invocation.args.path) : null,
        invocation.args.source ? h("details", { className: "code" }, h("summary", {}, t("showCode")), h("pre", {}, h("code", {}, invocation.args.source)),
          typeof result === "string" && result ? h("pre", { className: "result" }, h("code", {}, result)) : null) : null));
  })) : null;
  return h("div", { className: `activity${working ? " running" : ""}`, "data-testid": "activity" }, toggle, details);
}

function requestCard(block: Block, pending: boolean) {
  const kind = block.kind as Kind & { prompt: string; options: string[]; answer?: string; promptId?: string };
  const card = h("div", { className: "request-card", "data-testid": kind.promptId ? "pending-choice" : "resolved-choice" }, h("p", { className: "request-prompt" }, hostText(kind.prompt)));
  if (kind.promptId && pending && state.route.name === "chat" && state.route.id !== null) {
    const id = state.route.id;
    const respond = async (answer: string) => {
      card.querySelectorAll("button, input").forEach(element => (element as HTMLButtonElement).disabled = true);
      await api(`/api/conversations/${id}/respond`, { method: "POST", json: { promptId: kind.promptId, answer } }).catch(failed);
      scheduleView();
    };
    const custom = h("input", { className: "field", placeholder: t("customAnswer"), "aria-label": t("customAnswer"), maxlength: 2000, "data-testid": "choice-custom" });
    card.append(h("div", { className: "request-options" }, ...kind.options.map(option => h("button", { type: "button", className: "button secondary", "data-testid": "choice-option",
      onclick: () => void respond(option) }, hostText(option)))),
      h("form", { className: "request-custom", onsubmit: (event: Event) => { event.preventDefault(); if (custom.value.trim()) void respond(custom.value.trim()); } },
        custom, h("button", { type: "submit", className: "button primary" }, t("submit"))));
  } else card.append(h("p", { className: "muted" }, kind.answer !== undefined ? t("answered", { answer: hostText(kind.answer) }) : t("notAnswered")));
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

function fileThumb(entry: Entry) {
  const tile = h("span", { className: "file-thumb", "data-testid": "file-thumb" });
  if (entry.kind === "directory") tile.append(icon("folder"));
  else if (imageExtensions.test(entry.name) && entry.size <= thumbnailLimit) {
    const image = h("img", { loading: "lazy", decoding: "async", alt: "", src: fileURL(entry.path) });
    image.addEventListener("error", () => image.replaceWith(icon("image")), { once: true });
    tile.append(image);
  } else tile.append(icon(fileIcon(entry.path)));
  return tile;
}

function fileRow(entry: Entry, parent: string, label: (segment: string, index: number) => string) {
  const depth = parent ? parent.split("/").length : 0;
  const name = label(entry.name, depth);
  const main = entry.kind === "directory"
    ? h("a", { href: filesHash(entry.path), className: "file-main", "data-testid": "file-row" }, fileThumb(entry), h("span", { className: "file-text" }, h("span", { className: "file-name" }, name)))
    : h("a", { href: fileURL(entry.path), target: "_blank", rel: "noopener noreferrer", className: "file-main", "data-testid": "file-row" }, fileThumb(entry),
      h("span", { className: "file-text" }, h("span", { className: "file-name" }, name), h("span", { className: "file-meta" }, `${size(entry.size)} · ${relativeTime(entry.modified)}`)));
  const managed = entry.kind === "directory" && /^conversations(\/\d+)?$/.test(entry.path);
  const actions = managed ? h("span", { className: "icon-spacer" }) : h("button", { type: "button", className: "icon-button", "aria-label": `${t("moreOptions")}: ${entry.name}`, title: t("moreOptions"),
    "aria-haspopup": "menu", "data-testid": "file-menu", onclick: (event: Event) => fileMenu(entry, parent, event.currentTarget as HTMLElement) }, icon("more"));
  return h("div", { className: "file-row" }, main, actions);
}

function fileMenu(entry: Entry, parent: string, anchor: HTMLElement) {
  const managed = /^conversations(\/\d+)?$/.test(entry.path);
  menu(anchor, [
    ...(entry.kind === "file" ? [{ label: t("open"), icon: "file" as const, testID: "menu-open", run: () => openFile(entry.path) },
      { label: t("download"), icon: "download" as const, testID: "menu-download", run: () => { location.href = fileURL(entry.path, true); } }] : []),
    ...(managed ? [] : [{ label: t("move"), icon: "forward" as const, testID: "menu-move", run: async () => {
      const target = await ask({ title: t("move"), input: { value: entry.path, label: t("movePrompt") }, confirm: t("save") });
      if (target && normalize(target) !== entry.path) await api("/api/files/move", { method: "POST", json: { from: entry.path, to: normalize(target) } }).then(() => renderFiles(parent), failed);
    } }, { label: t("delete"), icon: "trash" as const, destructive: true, testID: "menu-delete", run: async () => {
      if (await ask({ title: t("deleteFile", { name: entry.name }), message: t("deleteFileBody"), confirm: t("delete"), destructive: true }) !== "confirm") return;
      await api(`/api/files?path=${encodeURIComponent(entry.path)}`, { method: "DELETE" }).then(() => renderFiles(parent), failed);
    } }]),
  ]);
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

let settingsReplace = false;

function leaveSettings(then: () => void) {
  if (!settingsOpen()) { then(); return; }
  if (settingsReplace) { settingsHost.close(); then(); return; }
  window.addEventListener("popstate", () => {
    if (settingsLocation()) history.replaceState(null, "", hashFor(state.route));
    closeSettings();
    then();
  }, { once: true });
  history.back();
}

function hashFor(route: Route) {
  if (route.name === "chat") return route.id === null ? "#/" : `#/c/${route.id}`;
  if (route.name === "files") return filesHash(route.path);
  if (route.name === "list") return "#/";
  return `#/${route.name}`;
}

function settingsLocation() {
  const [name, tab] = location.hash.replace(/^#\/?/, "").split("/");
  if (name !== "settings") return null;
  return { tab: (settingsTabs as string[]).includes(tab ?? "") ? tab as SettingsTab : null };
}

const settingsHost: SettingsHost = {
  settings: () => state.settings,
  apply: (value, defaultChanged) => {
    state.settings = value;
    main?.querySelector(".workspace-context-bar")?.replaceWith(workspaceContext());
    if (defaultChanged || !offered(value, state.draftModel)) state.draftModel = value.defaultModel;
    renderSidebar();
    renderConversationHeader();
    updateComposer();
  },
  modelSelect: (current, onchange, testID) => modelSelect(current, false, onchange, testID),
  show: tab => { history.replaceState(null, "", tab ? `#/settings/${tab}` : "#/settings"); openSettings(settingsHost, tab); },
  close: () => {
    if (!settingsReplace) { history.back(); return; }
    history.replaceState(null, "", hashFor(state.route));
    closeSettings();
  },
  openHost: async address => {
    if (state.uploading || state.sending) { failed(new Error(t("hostSwitchPending"))); return; }
    const unsent = !!composerRefs?.textarea.value.trim() || state.attachments.length > 0 || [...state.drafts.values()].some(value => value.trim());
    if (unsent && await ask({ title: t("hostSwitchDraftTitle"), message: t("hostSwitchDraftBody"), confirm: t("hostSwitchLeave"),
      cancel: t("hostSwitchStay") }) !== "confirm") return;
    if (state.uploading || state.sending) { failed(new Error(t("hostSwitchPending"))); return; }
    location.assign(address);
  },
  openPage: id => leaveSettings(() => openViewer(id)),
  importConversation: file => void importPackage(file),
  startConversation: domain => leaveSettings(() => {
    if (!state.pendingServices.includes(domain)) state.pendingServices = [...state.pendingServices, domain];
    if (state.route.name === "chat" && state.route.id === null && main?.querySelector(".composer")) { renderServiceChips(); updateComposer(); }
    else go("#/");
  }),
  signOut: async () => {
    await api("/api/logout", { method: "POST" });
    closeSettings();
    state.paired = false;
    events?.close();
    renderPairing();
  },
};

let linkedCode = "";

function canonicalHash() {
  const pairing = /^#\/pair\/([A-Za-z0-9-]{4,16})(?:\?host=[A-Za-z0-9-]+&ca=[a-f0-9]{64})?$/.exec(location.hash);
  if (pairing) { linkedCode = pairing[1]!.toUpperCase(); history.replaceState(null, "", "#/"); }
  if (/^#\/?(?:skills|settings\/(?:skills|personalization))\/?$/.test(location.hash)) history.replaceState(null, "", "#/settings/profile");
  if (/^#\/?services\/?$/.test(location.hash)) history.replaceState(null, "", "#/settings/services");
  return !!pairing;
}

function route() {
  const file = fileLocation();
  if (file !== null) {
    history.replaceState(null, "", routeHash(state.route));
    if (state.paired && file) openFile(file);
    return;
  }
  const linked = canonicalHash();
  const target = settingsLocation();
  if (target) {
    if (!state.paired) return;
    if (!app.querySelector(".shell")) { settingsReplace = true; state.route = { name: "chat", id: null }; renderShell(); }
    else if (!settingsOpen()) settingsReplace = false;
    closeDrawer();
    if (!target.tab && wide.matches) history.replaceState(null, "", "#/settings/general");
    openSettings(settingsHost, target.tab);
    return;
  }
  if (settingsOpen()) {
    const next = parseRoute();
    closeSettings();
    if (JSON.stringify(next) === JSON.stringify(state.route)) return;
  }
  const previous = state.route;
  state.route = parseRoute();
  if (!state.paired) { if (linked) renderPairing(); return; }
  if (state.route.name === "list") {
    state.route = previous.name === "list" ? { name: "chat", id: null } : previous;
    history.replaceState(null, "", previous.name === "chat" && previous.id !== null ? `#/c/${previous.id}` : "#/");
    if (!app.querySelector(".shell")) renderShell();
    openDrawer();
    return;
  }
  closeDrawer();
  const here = (id: number | null) => state.route.name === "chat" && state.route.id === id;
  if (temporaryID !== null && !here(temporaryID)) discardTemporary();
  if (!here(null)) state.temporaryDraft = false;
  if (state.editing && !here(state.editing.conversation)) { state.drafts.delete(String(state.editing.conversation)); state.editing = null; }
  if (!app.querySelector(".shell")) { renderShell(); return; }
  const sameChat = previous.name === "chat" && state.route.name === "chat" && previous.id === state.route.id && !!main?.querySelector(".composer");
  if (state.route.name === "chat") {
    const id = state.route.id;
    if (id === null) { if (!sameChat) state.view = null; }
    else if (state.view?.summary.id !== id) state.view = viewCache.get(id) ?? null;
  } else state.view = null;
  if (!sameChat) {
    if (anchor && anchor.id !== shownId()) anchor = null;
    resetLive(state.route.name === "chat" ? state.route.id : null);
    state.attachments = previous.name === "chat" && state.route.name === "chat" && previous.id === null ? state.attachments : [];
    renderMain();
    if (state.route.name === "chat" && state.route.id !== null && state.view) void loadView();
  }
  renderSidebar();
}

onUnauthorized(() => { if (state.paired) { state.paired = false; renderPairing(); } });

async function start() {
  canonicalHash();
  applyTheme();
  const session = await api<{ paired: boolean; device: Device | null }>("/api/session");
  state.paired = session.paired;
  if (!session.paired) { renderPairing(); return; }
  linkedCode = "";
  state.deviceID = session.device?.id ?? "";
  const file = fileLocation();
  if (file !== null) history.replaceState(null, "", "#/");
  state.route = parseRoute();
  await Promise.all([loadSettings(), loadConversations().catch(() => {}), refreshOpenPages(), loadMedia()]);
  const drawer = state.route.name === "list";
  if (drawer) { state.route = { name: "chat", id: null }; history.replaceState(null, "", "#/"); }
  renderShell();
  if (drawer) openDrawer();
  const settings = settingsLocation();
  if (settings) {
    settingsReplace = true;
    if (!settings.tab && wide.matches) history.replaceState(null, "", "#/settings/general");
    openSettings(settingsHost, settings.tab);
  }
  if (file) openFile(file);
  connectEvents();
  watchDrops();
  watchNotificationClicks(hash => go(hash));
  void syncPush().catch(() => {});
  if (!document.querySelector("dialog[open]") && state.settings) firstRun(updateComposer,
    { workspace: state.settings.profile.name, host: state.settings.host.id });
}

window.addEventListener("hashchange", route);
document.addEventListener("click", event => {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const link = (event.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
  if (!link || link.dataset.newTab) return;
  const url = new URL(link.href, location.href);
  const path = url.searchParams.get("path");
  if (url.origin !== location.origin || url.pathname !== "/api/files/content" || url.searchParams.has("download") || !path) return;
  event.preventDefault();
  openFile(path);
});
window.addEventListener("pagehide", () => {
  if (temporaryID !== null) void fetch(`/api/conversations/${temporaryID}`, { method: "DELETE", credentials: "same-origin", keepalive: true }).catch(() => {});
});
wide.addEventListener("change", () => { if (state.paired) { state.drawer = false; renderShell(); if (settingsOpen()) openSettings(settingsHost, settingsTab()); } });
document.addEventListener("keydown", event => { if (event.key === "Escape" && state.drawer) closeDrawer(); });
window.addEventListener("resize", () => { layoutSpacer(); updateJump(); });
document.addEventListener("visibilitychange", () => {
  reportPresence();
  if (document.visibilityState === "visible" && state.paired) { void refresh(); }
});
void start().catch(error => {
  app.replaceChildren(h("main", { className: "pair-page" }, h("div", { className: "pair-card" }, h("h1", {}, t("error")), h("p", { className: "muted" }, error instanceof Error ? error.message : String(error)))));
});

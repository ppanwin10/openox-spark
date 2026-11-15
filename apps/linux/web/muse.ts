import type { AgentIdentity, ApprovalReceipt, SoulSnapshot } from "@openox/agent/linux";
import { api, APIError, ask, closeOnBackdrop, failed, formDialog, menu, placeToasts, relativeTime, sheet, toast } from "./client";
import { h, icon, type IconName } from "./dom";
import { keepFocus, openScheduleDetails, scheduleSummary, type ScheduleRow } from "./capabilities";
import { fileURL } from "./file-viewer";
import { editMemory } from "./review";
import { hostText, locale, t, type StringKey } from "./i18n";
import { loadNotices } from "./personal-agent";
import { noticeConversationID } from "../../../packages/agent/src/adapters/linux/notice-target";
import { openMuseSearch as openSearch, type SearchHost } from "./search";

export type AgentTab = "activity" | "approvals" | "identity";
type Chat = { id: number; title: string; unread: boolean };
export interface MuseHost extends SearchHost {
  conversations(): Chat[];
  mainID(): number | null;
  online(): boolean;
  unread(): number;
  goalsAvailable(): boolean;
  feedAvailable(): boolean;
  ideasAvailable(): boolean;
  libraryAvailable(): boolean;
  spacesAvailable(): boolean;
  identityAvailable(): boolean;
  approvalHistoryAvailable(): boolean;
  pinnedSpaces(): { id: string; name: string }[];
  pinnedError(): boolean;
  retryPins(): void;
  createSpace(): void;
  openChat(id: number): void;
  openNotice(id: string): void;
  openAgent(tab: AgentTab | null): void;
  navigate(hash: string): void;
}
let panel: { element: HTMLElement; host: MuseHost; tab: AgentTab; attentionLimit: number } | undefined;
let generation = 0, portraitRequest = 0, refreshTimer: ReturnType<typeof setTimeout> | undefined;
let agent: AgentIdentity | undefined, railHost: MuseHost | undefined;
type Identity = { available: boolean; agent: AgentIdentity; soul: SoulSnapshot };
const describe = (error: unknown) => error instanceof TypeError && error.message === "Failed to fetch"
  ? t("museReadFailed") : hostText(error instanceof Error ? error.message : String(error));
const when = (value: string) => new Date(value).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });
const unknownSave = (error: unknown) => !(error instanceof APIError) || error.status >= 500;
function validAgent(value: AgentIdentity) {
  if (!value || typeof value.name !== "string" || !value.name.trim() || value.name.length > 100
    || !Number.isSafeInteger(value.revision) || value.revision < 1 || typeof value.avatarMissing !== "boolean"
    || value.avatarPath !== null && (typeof value.avatarPath !== "string" || !value.avatarPath.length)
    || value.updatedAt !== null && (typeof value.updatedAt !== "string" || !Number.isFinite(Date.parse(value.updatedAt)))) throw new Error(t("personalDataInvalid"));
  return value;
}
function validSoul(value: SoulSnapshot) {
  if (!value || value.path !== "SOUL.md" || typeof value.exists !== "boolean"
    || (value.exists ? typeof value.text !== "string" || !/^[a-f0-9]{64}$/.test(value.revision)
      : value.text !== null || value.revision !== "missing")) throw new Error(t("personalDataInvalid"));
  return value;
}
const avatarURL = (host: MuseHost) => host.identityAvailable() && agent?.avatarPath ? fileURL(agent.avatarPath) : "/icon.svg";
function portrait(image: HTMLImageElement, url: string) {
  if (image.getAttribute("src") === url) return;
  image.src = url; image.title = "";
  image.onerror = () => { image.onerror = null; image.src = "/icon.svg"; image.title = t("museAvatarUnreadable"); };
}
function drawPortrait(host: MuseHost, error = false) {
  document.querySelectorAll<HTMLImageElement>("img[data-muse-avatar]").forEach(image => portrait(image, avatarURL(host)));
  document.querySelectorAll<HTMLElement>('[data-testid="muse-agent-name"]').forEach(name => { name.textContent = host.identityAvailable() && agent ? agent.name : t("appName"); });
  const status = document.querySelector<HTMLElement>('[data-testid="muse-identity-status"]');
  if (status) { status.hidden = !error && !agent?.avatarMissing; status.textContent = t(error ? "museIdentityReadError" : "museAvatarMissing"); }
}
async function readIdentity(host: MuseHost) {
  const request = ++portraitRequest;
  try {
    const state = await api<Identity>("/api/identity", { signal: AbortSignal.timeout(10_000) });
    if (state.available !== true) throw new Error(t("museIdentityUnavailable"));
    validAgent(state.agent); validSoul(state.soul);
    if (request === portraitRequest) { agent = state.agent; drawPortrait(host); }
    return state;
  } catch (error) { if (request === portraitRequest) drawPortrait(host, true); throw error; }
}
async function openIdentityEditor(host: MuseHost, avatarFocus = false) {
  const element = panel?.element;
  if (!element?.isConnected || document.querySelector('[data-testid="muse-identity-editor"]')) return;
  const state = await readIdentity(host);
  if (element.isConnected && !document.querySelector('[data-testid="muse-identity-editor"]')) editIdentity(state.agent, host, avatarFocus);
}
async function openSoulEditor(host: MuseHost) {
  const element = panel?.element;
  if (!element?.isConnected || document.querySelector('[data-testid="muse-soul-editor"]')) return;
  const state = await readIdentity(host);
  if (element.isConnected && !document.querySelector('[data-testid="muse-soul-editor"]')) openSoul(state.soul, host);
}
async function openMemoryEditor() {
  const element = panel?.element;
  if (!element?.isConnected || document.querySelector('[data-testid="review-memory-editor"]')) return;
  const state = await api<{ memory: { text: string; revision: string } }>("/api/review", { signal: AbortSignal.timeout(10_000) });
  if (!state.memory || typeof state.memory.text !== "string" || typeof state.memory.revision !== "string") throw new Error(t("personalDataInvalid"));
  if (element.isConnected && !document.querySelector('[data-testid="review-memory-editor"]')) editMemory(state.memory, refreshMuseAgent);
}
const button = (label: string, name: IconName, testID: string, run: () => void) =>
  h("button", { type: "button", className: "muse-rail-button", title: label, "aria-label": label, "data-testid": testID, onclick: run }, icon(name, 22));

export function museRail(host: MuseHost, chat: boolean, files: boolean, goals = false, space: string | null = null, creating = false, discovery: "feed" | "ideas" | null = null) {
  railHost = host;
  const unavailable = (key: "museFeed" | "museIdeas" | "museGoals" | "museSpace", name: IconName) => h("button", {
    type: "button", className: "muse-rail-button", disabled: true, "aria-label": `${t(key)}. ${t("museUnavailable")}`,
    title: `${t(key)}. ${t("museUnavailable")}`, "data-testid": `muse-${key.slice(4).toLowerCase()}`,
  }, icon(name, 22));
  const chatLink = h("a", { href: "#/main", className: `muse-rail-button${chat ? " selected" : ""}`, "aria-label": t("museChat"), title: t("museChat"),
    "aria-current": chat ? "page" : null, "data-testid": "muse-chat" }, icon("chat", 22));
  const library = h("a", { href: host.libraryAvailable() ? "#/library/spaces" : "#/files", className: `muse-rail-button${files ? " selected" : ""}`, "aria-label": t("museLibrary"), title: t("museLibrary"),
    "aria-current": files ? "page" : null, "data-testid": "muse-library" }, icon("library", 22));
  const avatar = button(t("museOpenAgent"), "user", "muse-agent-open", () => host.openAgent("activity"));
  avatar.classList.add("muse-rail-avatar");
  avatar.replaceChildren(h("img", { src: avatarURL(host), alt: "", width: 40, height: 40, "data-muse-avatar": "" }));
  if (host.identityAvailable()) queueMicrotask(() => { if (avatar.isConnected) void readIdentity(host).catch(() => {}); });
  const more = button(t("moreOptions"), "menu", "muse-menu", () => menu(more, [
    { label: t("museKeyboardShortcuts"), icon: "keyboard", testID: "muse-shortcuts", run: () => void shortcuts() },
    { label: t("museDownloadApps"), icon: "download", testID: "muse-download", run: () => { window.open("https://github.com/ppanwin10/openox-spark/releases", "_blank", "noopener,noreferrer"); } },
    { label: t("museReportIssue"), icon: "warning", testID: "muse-report", run: () => {
      void formDialog({ title: t("museReportIssue"), message: t("museSupportUnavailable"), confirm: t("ok"), cancel: false, testID: "muse-report-unavailable" });
    } },
    { label: t("settings"), icon: "gear", testID: "nav-settings", run: () => host.navigate("#/settings") },
  ]));
  return h("nav", { className: "muse-rail", "aria-label": t("personalNavigation"), "data-testid": "muse-rail" }, avatar,
    h("div", { className: "muse-rail-pages" }, chatLink, button(t("museSearch"), "search", "muse-search-open", () => openMuseSearch(host)),
      host.feedAvailable() ? h("a", { href: "#/feed", className: `muse-rail-button${discovery === "feed" ? " selected" : ""}`, "data-testid": "muse-feed",
        "aria-label": t("museFeed"), title: t("museFeed"), "aria-current": discovery === "feed" ? "page" : null }, icon("feed", 22)) : unavailable("museFeed", "feed"),
      host.ideasAvailable() ? h("a", { href: "#/ideas", className: `muse-rail-button${discovery === "ideas" ? " selected" : ""}`, "data-testid": "muse-ideas",
        "aria-label": t("museIdeas"), title: t("museIdeas"), "aria-current": discovery === "ideas" ? "page" : null }, icon("bulb", 22)) : unavailable("museIdeas", "bulb"),
      host.goalsAvailable() ? h("a", { href: "#/goals", className: `muse-rail-button${goals ? " selected" : ""}`, title: t("museGoals"),
        "aria-label": t("museGoals"), "aria-current": goals ? "page" : null, "data-testid": "muse-goals" }, icon("goal", 22)) : unavailable("museGoals", "goal"), library,
      h("hr"), host.spacesAvailable() ? h("button", { type: "button", className: `muse-rail-button${creating ? " selected" : ""}`,
        "aria-label": t("museSpace"), title: t("museSpace"), "data-testid": "muse-space", onclick: host.createSpace }, icon("space", 22)) : unavailable("museSpace", "space"),
      h("div", { className: "muse-pinned-spaces" }, ...host.pinnedSpaces().map(item => h("a", { href: `#/spaces/${encodeURIComponent(item.id)}`,
        className: `muse-rail-button${item.id === space ? " selected" : ""}`, "aria-label": item.name, title: item.name,
        "aria-current": item.id === space ? "page" : null, "data-testid": `muse-pinned-space-${item.id}` }, icon("globe", 20))),
        host.pinnedError() ? h("button", { type: "button", className: "muse-rail-button", title: t("libraryPinnedError"), "aria-label": t("libraryPinnedError"),
          "data-testid": "muse-pins-retry", onclick: host.retryPins }, icon("warning", 20)) : null)),
    h("div", { className: "muse-rail-bottom" }, more));
}

export function shortcuts() {
  return formDialog({ title: t("museKeyboardShortcuts"), testID: "muse-shortcuts-dialog", cancel: false, confirm: t("ok"),
    content: h("div", { className: "muse-shortcuts" },
      ...[["Cmd / Ctrl + K", t("museSearch")], ["Cmd / Ctrl + ,", t("settings")], ["Cmd / Ctrl + /", t("museKeyboardShortcuts")], ["Esc", t("close")]]
        .map(([key, label]) => h("div", {}, h("span", {}, label), h("kbd", {}, key)))) });
}

export function openMuseSearch(host: MuseHost, query = "") {
  openSearch(host, query);
}

export function closeMuseAgent() { generation++; clearTimeout(refreshTimer); panel = undefined; }
export function refreshMuseAgent() {
  clearTimeout(refreshTimer);
  const current = panel;
  if (current?.element.isConnected && !document.querySelector("dialog[open]")) refreshTimer = setTimeout(() => {
    if (panel === current && current.element.isConnected && !document.querySelector("dialog[open]")) void renderAgentBody(current.element, current.host, current.tab);
  }, 100);
  else if (railHost?.identityAvailable()) void readIdentity(railHost).catch(() => {});
}
export function museAgent(host: MuseHost, tab: AgentTab) {
  const element = h("aside", { className: "muse-agent", "aria-label": t("museAgent"), "data-testid": "muse-agent" });
  panel = { element, host, tab, attentionLimit: 30 };
  const hero = h("header", { className: "muse-agent-hero" },
    h("button", { type: "button", className: "icon-button muse-agent-close", "aria-label": t("close"), "data-testid": "muse-agent-close", onclick: () => host.openAgent(null) }, icon("close", 20)),
    h("div", { className: "muse-agent-avatar" }, h("img", { src: avatarURL(host), alt: "", width: 128, height: 128, "data-muse-avatar": "", "data-testid": "muse-agent-avatar-image" }),
      h("button", { type: "button", className: "icon-button muse-avatar-edit", "aria-label": t("museIdentity"), title: t("museIdentity"),
        "data-testid": "muse-avatar-edit", onclick: () => {
          if (host.identityAvailable()) void openIdentityEditor(host, true).catch(failed);
          else host.openAgent("identity");
        } }, icon("pencil", 18))),
    h("strong", { className: "muse-agent-name", "data-testid": "muse-agent-name" }, host.identityAvailable() && agent ? agent.name : t("appName")),
    h("span", { className: `muse-agent-connection${host.online() ? "" : " disconnected"}`, title: t("museHostConnection") },
      h("span", { className: "muse-connection-dot", "aria-hidden": "true" }, icon("spark", 10)), t(host.online() ? "museConnected" : "museDisconnected")),
    h("span", { className: "muse-agent-identity-status", hidden: true, "data-testid": "muse-identity-status" }));
  const tabs: { id: AgentTab; name: IconName; label: string }[] = [
    { id: "activity", name: "activity", label: t("museActivity") }, { id: "approvals", name: "shield", label: t("museApprovals") }, { id: "identity", name: "identity", label: t("museIdentity") }];
  const body = h("div", { id: "muse-agent-content", className: "muse-agent-body", role: "tabpanel",
    "aria-labelledby": `muse-tab-${tab}`, "data-testid": "muse-agent-body" });
  element.append(hero, h("div", { className: "muse-agent-tabs", role: "tablist", "aria-label": t("museAgent") },
    ...tabs.map((item, index) => h("button", { type: "button", role: "tab", id: `muse-tab-${item.id}`, className: item.id === tab ? "selected" : "",
      "aria-label": item.label, title: item.label, tabindex: item.id === tab ? 0 : -1, "aria-controls": "muse-agent-content",
      "aria-selected": String(item.id === tab), "data-testid": `muse-agent-${item.id}`, onclick: () => host.openAgent(item.id),
      onkeydown: (event: Event) => {
        if (!(event instanceof KeyboardEvent)) return;
        const next = event.key === "ArrowRight" ? (index + 1) % tabs.length : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length
          : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : null;
        if (next !== null) { event.preventDefault(); host.openAgent(tabs[next]!.id); }
      } }, icon(item.name, 20)))), body);
  queueMicrotask(() => { if (element.isConnected) void renderAgentBody(element, host, tab); });
  return element;
}

async function renderAgentBody(element: HTMLElement, host: MuseHost, tab: AgentTab) {
  const current = ++generation, body = element.querySelector<HTMLElement>(".muse-agent-body")!;
  const active = () => current === generation && element.isConnected;
  const restore = keepFocus(body), scroll = body.scrollTop;
  body.replaceChildren(h("div", { className: "muse-panel-loading", role: "status", "data-testid": "muse-agent-loading" }, h("span", { className: "spinner" }), t("personalLoading")));
  if (tab !== "identity" && host.identityAvailable()) void readIdentity(host).catch(() => {});
  try {
    if (tab === "activity") await renderActivity(body, host, active);
    else if (tab === "identity") await renderIdentity(body, host, active);
    else if (host.approvalHistoryAvailable()) await renderHistory(body, host, active);
    else body.replaceChildren(h("h3", { className: "muse-section-heading" }, t("museApprovalsHistory")),
      h("p", { className: "muse-panel-note", "data-testid": "muse-approvals-unavailable" }, t("museApprovalsUnavailable")));
  } catch (error) {
    if (!active()) return;
    body.replaceChildren(h("p", { className: "form-error", role: "alert", "data-testid": "muse-agent-error" }, describe(error)),
      h("button", { type: "button", className: "button secondary", "data-testid": "muse-agent-retry",
        onclick: () => void renderAgentBody(element, host, tab) }, t("museRetry")));
  } finally {
    if (active()) {
      body.scrollTop = scroll;
      if (document.activeElement === document.body || body.contains(document.activeElement)) restore();
    }
  }
}
async function renderActivity(body: HTMLElement, host: MuseHost, active: () => boolean) {
  const [scheduled, watched, notices] = await Promise.all([api<{ schedules: ScheduleRow[] }>("/api/schedules"),
    api<{ watches: { id: string; name: string; enabled: boolean; lastError: string | null }[]; warning: string | null }>("/api/watches"), loadNotices()]);
  if (!Array.isArray(scheduled.schedules) || !Array.isArray(watched.watches)) throw new Error(t("personalDataInvalid"));
  if (!active()) return;
  const items = scheduled.schedules, list = h("div", { className: "muse-task-list" }, ...items.map(item => h("button", {
    type: "button", className: "muse-task-row", "data-testid": `muse-task-${item.id}`,
    onclick: () => openScheduleDetails(item.id, item.name, refreshMuseAgent, true),
  }, icon("clock", 16), h("span", {}, h("strong", {}, item.name), h("small", {}, scheduleSummary(item))), icon("chevron", 14))));
  const disclosure = h("button", { type: "button", className: "muse-section-heading", "aria-expanded": "true", "data-testid": "muse-task-count",
    onclick: () => { list.hidden = !list.hidden; disclosure.setAttribute("aria-expanded", String(!list.hidden)); } },
  h("span", {}, t("museScheduledCount", { count: items.length })), icon("expand", 16));
  body.replaceChildren(disclosure, list);
  if (!items.length) body.append(h("p", { className: "muse-panel-note", "data-testid": "muse-tasks-empty" }, t("museNoScheduled")));
  if (watched.warning) body.append(h("p", { className: "form-error", role: "alert" }, hostText(watched.warning)));
  if (watched.watches.length) body.append(h("h3", { className: "muse-section-heading" }, t("watchPublicPages")),
    ...watched.watches.map(watch => h("a", { href: `#/activity/watches/${watch.id}`, className: "muse-task-row", "data-testid": `muse-watch-${watch.id}` }, icon("globe", 16),
      h("span", {}, h("strong", {}, watch.name), h("small", {}, watch.lastError ?? t(watch.enabled ? "watchEnabled" : "watchPaused"))), icon("chevron", 14))));
  const updates = h("div", { className: "muse-attention-list", "data-testid": "muse-attention-list" });
  const continuation = h("div", { className: "muse-history-continuation" });
  let visible = panel?.attentionLimit ?? 30;
  const chats = new Map(host.conversations().map(chat => [chat.id, chat]));
  const draw = () => {
    updates.replaceChildren(...notices.notifications.slice(0, visible).map(notice => {
      const target = noticeConversationID(notice.targetUrl), linked = target !== null && chats.has(target);
      const unread = notice.readAt === null && notice.cancelledAt === null;
      const context = target === null ? t("museAttentionUnlinked") : !linked ? t("museAttentionChatMissing") : target === host.mainID() ? t("museMainChat")
        : chats.get(target!)!.title || t("untitled");
      return h("div", { className: `muse-attention-row${unread ? " unread" : ""}`, "data-testid": `muse-attention-${notice.id}` },
        h("button", { type: "button", className: "muse-task-row", "data-testid": `muse-attention-open-${notice.id}`,
          onclick: () => { if (linked) host.openChat(target!); else host.openNotice(notice.id); } }, icon(linked ? "chat" : "activity", 16),
        h("span", {}, h("strong", {}, notice.title[locale]), h("small", { className: "clamp" }, notice.body[locale]),
          h("small", {}, context, " · ", h("time", { datetime: notice.createdAt, title: when(notice.createdAt) }, relativeTime(Date.parse(notice.createdAt))))),
        unread ? h("span", { className: "dot unread", role: "img", "aria-label": t("noticeUnread") }) : null),
        h("button", { type: "button", className: "icon-button", "aria-label": t("museAttentionDetail"), title: t("museAttentionDetail"),
          "data-testid": `muse-attention-detail-${notice.id}`, onclick: () => host.openNotice(notice.id) }, icon("more", 16)));
    }));
    continuation.replaceChildren(...(visible < notices.notifications.length ? [h("button", { type: "button", className: "button secondary",
      "data-testid": "muse-attention-more", onclick: () => { visible += 30; if (panel) panel.attentionLimit = visible; draw(); } }, t("libraryLoadMore", { count: Math.min(visible, notices.notifications.length), total: notices.notifications.length }))] : []));
  };
  body.append(h("h3", { className: "muse-section-heading muse-attention-heading", "data-testid": "muse-attention-count" },
    t("museAttentionUpdates"), h("span", { className: "muted small" }, t("noticeUnreadCount", { count: notices.unreadCount }))),
  updates, continuation);
  if (notices.warning) body.append(h("p", { className: "form-error", role: "alert", "data-testid": "muse-attention-warning" }, hostText(notices.warning)));
  if (!notices.notifications.length) updates.append(h("p", { className: "muse-panel-note", "data-testid": "muse-attention-empty" }, t("museAttentionEmpty")));
  else draw();
}
async function renderIdentity(body: HTMLElement, host: MuseHost, active: () => boolean) {
  const [identity, state] = await Promise.all([host.identityAvailable() ? readIdentity(host) : undefined,
    api<{ memory: { text: string; revision: string } }>("/api/review")]);
  if (!state.memory || typeof state.memory.text !== "string" || typeof state.memory.revision !== "string") throw new Error(t("personalDataInvalid"));
  if (!active()) return;
  const memory = h("button", { type: "button", className: "muse-file-card memory", "data-testid": "muse-memory",
    onclick: () => void openMemoryEditor().catch(failed) }, h("strong", {}, "MEMORY"), h("span", {}, t("museAccessCare")),
    h("small", {}, state.memory.text.trim().split("\n")[0]?.slice(0, 80) || t("museNoMemory")), icon("heart", 20));
  const soul = h("button", { type: "button", className: "muse-file-card soul", disabled: !identity, "data-testid": "muse-soul",
    title: identity ? "SOUL.md" : t("museSoulUnavailable"), "aria-label": `SOUL. ${identity ? t("museAccessCare") : t("museSoulUnavailable")}`,
    onclick: () => { if (identity) void openSoulEditor(host).catch(failed); } }, h("strong", {}, "SOUL"), h("span", {}, t("museAccessCare")),
    h("small", {}, identity ? identity.soul.text?.trim().split("\n")[0]?.slice(0, 80) || t(identity.soul.exists ? "museSoulEmpty" : "museSoulMissing") : t("museNotConnected")), icon("heart", 20));
  body.replaceChildren(h("div", { className: "muse-identity-summary", "data-testid": "muse-identity-summary" },
    h("p", {}, t(identity ? "museIdentitySummary" : "museIdentityPending")),
    identity ? h("button", { type: "button", className: "muse-identity-edit", "data-testid": "muse-identity-edit",
      onclick: () => void openIdentityEditor(host).catch(failed) }, icon("pencil", 16), t("edit")) : null), h("div", { className: "muse-file-cards" }, soul, memory));
}
function editIdentity(source: AgentIdentity, host: MuseHost, avatarFocus = false) {
  placeToasts().querySelectorAll(".toast.info").forEach(element => element.remove());
  let current = source, working = false, avatarTouched = false, cursor: string | null = null;
  const name = h("input", { className: "field", required: true, maxlength: 100, "aria-label": t("museAgentName"), "data-testid": "muse-identity-name" });
  const selection = h("select", { className: "field", "aria-label": t("museAvatarOriginal"), "data-testid": "muse-avatar-path" });
  const query = h("input", { className: "field", type: "search", maxlength: 200, placeholder: t("museAvatarSearch"), "aria-label": t("museAvatarSearch"), "data-testid": "muse-avatar-search" });
  const preview = h("img", { className: "muse-avatar-preview", alt: "", width: 72, height: 72, "data-testid": "muse-avatar-preview" });
  const choices = new Map<string, string>();
  const error = h("p", { className: "form-error", role: "alert", hidden: true, "data-testid": "muse-identity-error" });
  const progressLabel = h("span");
  const progress = h("p", { className: "dialog-progress muse-editor-progress", role: "status", hidden: true, "data-testid": "muse-identity-progress" },
    h("span", { className: "spinner", "aria-hidden": "true" }), progressLabel);
  const values = () => ({ name: name.value.trim(), avatarPath: selection.value || null, resetMissing: avatarTouched && current.avatarMissing });
  const changed = () => name.value !== current.name || values().avatarPath !== current.avatarPath || values().resetMissing;
  const drawChoices = (selected: string | null) => {
    selection.replaceChildren(h("option", { value: "" }, t("museAvatarDefault")),
      ...[...new Map([...choices, ...(selected ? [[selected, selected] as [string, string]] : [])])].map(([path, label]) => h("option", { value: path }, label)));
    selection.value = selected ?? ""; portrait(preview, selected ? fileURL(selected) : "/icon.svg");
  };
  const populate = () => { name.value = current.name; avatarTouched = false; drawChoices(current.avatarPath); };
  populate();
  selection.addEventListener("change", () => { avatarTouched = true; portrait(preview, selection.value ? fileURL(selection.value) : "/icon.svg"); });
  const beforeUnload = (event: BeforeUnloadEvent) => { if (working || changed()) { event.preventDefault(); event.returnValue = ""; } };
  window.addEventListener("beforeunload", beforeUnload);
  const view = sheet({ testID: "muse-identity-editor", className: "todo-editor-sheet muse-identity-editor", label: t("museEditIdentity"),
    onClose: () => { window.removeEventListener("beforeunload", beforeUnload); refreshMuseAgent(); },
    canClose: async () => !working && (!changed() || await ask({ title: t("discardChanges"), message: t("formCloseBody"), confirm: t("discard"), destructive: true }) === "confirm") });
  const lock = (value: boolean, message: StringKey = "personalLoading") => {
    working = value; view.dialog.setAttribute("aria-busy", String(value)); progress.hidden = !value; progressLabel.textContent = t(message);
    view.dialog.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>("input,select,button").forEach(control => { control.disabled = value; });
  };
  const more = h("button", { type: "button", className: "button secondary", hidden: true, "data-testid": "muse-avatar-more", onclick: () => void loadImages(true) }, t("museAvatarMore"));
  const loadImages = async (append = false) => {
    if (working || !view.open()) return;
    lock(true); error.hidden = true; feedback.hidden = true;
    try {
      const params = new URLSearchParams({ category: "images", limit: "60", q: query.value, sort: "name" });
      if (append && cursor) params.set("cursor", cursor);
      const result = await api<{ available: boolean; items: { path: string | null; name: string; size: number | null; missing: boolean }[]; nextCursor: string | null }>(`/api/library?${params}`,
        { signal: AbortSignal.timeout(10_000) });
      if (result.available !== true || !Array.isArray(result.items) || result.nextCursor !== null && typeof result.nextCursor !== "string") throw new Error(t("personalDataInvalid"));
      const selected = selection.value;
      if (!append) choices.clear();
      for (const item of result.items) if (typeof item.path === "string" && typeof item.name === "string" && typeof item.size === "number" && item.size <= 2 * 1024 * 1024 && !item.missing) choices.set(item.path, item.path);
      drawChoices(selected); cursor = result.nextCursor; more.hidden = !cursor;
    } catch (failure) { error.textContent = describe(failure); error.hidden = false; feedback.hidden = false; }
    finally { lock(false); }
  };
  const upload = h("input", { type: "file", hidden: true, accept: ".png,.jpg,.jpeg,.webp,.gif,.svg", "data-testid": "muse-avatar-upload", onchange: async () => {
    const file = upload.files?.[0]; upload.value = "";
    if (!file || working) return;
    if (!/\.(png|jpe?g|webp|gif|svg)$/i.test(file.name) || file.size > 2 * 1024 * 1024) { error.textContent = t("museAvatarLimit"); error.hidden = false; feedback.hidden = false; return; }
    const path = `artifacts/avatar-${crypto.randomUUID()}-${file.name.replace(/[^A-Za-z0-9._-]/g, "_").slice(-100)}`;
    lock(true, "uploading"); error.hidden = true; feedback.hidden = true;
    try {
      await api(fileURL(path), { method: "PUT", body: file });
      choices.set(path, path); drawChoices(path); avatarTouched = true;
    } catch (failure) { error.textContent = unknownSave(failure) ? t("museAvatarUploadUnknown") : describe(failure); error.hidden = false; feedback.hidden = false; }
    finally { lock(false); }
  } });
  const reload = h("button", { type: "button", className: "button secondary", hidden: true, "data-testid": "muse-identity-reload", onclick: async () => {
    if (working || changed() && await ask({ title: t("todoReloadTitle"), message: t("museIdentityReloadBody"), confirm: t("todoReload") }) !== "confirm") return;
    lock(true);
    try { current = (await readIdentity(host)).agent; populate(); error.hidden = true; reload.hidden = true; feedback.hidden = true; }
    catch (failure) { error.textContent = describe(failure); error.hidden = false; feedback.hidden = false; }
    finally { lock(false); }
  } }, t("todoReload"));
  const feedback = h("div", { className: "personal-form-feedback", hidden: true }, error, reload);
  const label = (text: string, field: Node) => h("label", { className: "stack" }, h("span", { className: "label" }, text), field);
  const form = h("form", { className: "todo-editor-form", onsubmit: async (event: Event) => {
    event.preventDefault(); if (working) return;
    const draft = values();
    if (!draft.name) { error.textContent = t("museAgentNameRequired"); error.hidden = false; feedback.hidden = false; name.focus(); return; }
    lock(true, "personalSaving"); error.hidden = true; reload.hidden = true; feedback.hidden = true;
    const finish = (saved: AgentIdentity, verified = false) => { current = agent = saved; drawPortrait(host); populate(); view.close(); toast(t(verified ? "museVerifiedSave" : "saved")); };
    try {
      const saved = validAgent(await api<AgentIdentity>("/api/identity", { method: "PATCH", json: { expectedRevision: current.revision, name: draft.name,
        ...(avatarTouched || draft.avatarPath !== current.avatarPath ? { avatarPath: draft.avatarPath } : {}) } }));
      finish(saved);
    } catch (failure) {
      if (unknownSave(failure)) {
        try {
          const saved = (await readIdentity(host)).agent;
          if (saved.name === draft.name && (!avatarTouched && draft.avatarPath === current.avatarPath || saved.avatarPath === draft.avatarPath)) { finish(saved, true); return; }
        } catch {}
      }
      error.textContent = unknownSave(failure) ? t("museIdentitySaveUnknown") : failure instanceof APIError && failure.status === 409 ? t("museIdentityConflict") : describe(failure);
      error.hidden = false; reload.hidden = false; feedback.hidden = false;
    } finally { lock(false); }
  } }, h("div", { className: "sheet-body todo-editor-body" }, h("p", { className: "muted small" }, t("museIdentityAuthority")),
    label(t("museAgentName"), name), h("div", { className: "muse-avatar-controls" }, preview, h("div", { className: "stack" }, label(t("museAvatarOriginal"), selection),
      h("button", { type: "button", className: "button secondary", "data-testid": "muse-avatar-reset", onclick: () => { avatarTouched = true; drawChoices(null); } }, t("museAvatarReset")))),
    label(t("museAvatarSearch"), query), h("div", { className: "personal-detail-actions" },
      h("button", { type: "button", className: "button secondary", "data-testid": "muse-avatar-search-submit", onclick: () => void loadImages() }, t("museSearch")),
      more, h("button", { type: "button", className: "button secondary", "data-testid": "muse-avatar-upload-button", onclick: () => upload.click() }, t("museAvatarUpload"))),
    upload, h("p", { className: "muted small" }, t("museAvatarScope"))), feedback, progress,
    h("div", { className: "personal-form-actions" },
      h("button", { type: "button", className: "button secondary", "data-testid": "muse-identity-cancel", onclick: () => void view.attempt() }, t("cancel")),
      h("button", { type: "submit", className: "button primary", "data-testid": "muse-identity-save" }, t("save"))));
  view.dialog.append(h("div", { className: "sheet-head" }, h("h2", { className: "sheet-title" }, t("museEditIdentity")),
    h("button", { type: "button", className: "icon-button", "aria-label": t("close"), "data-testid": "muse-identity-close", onclick: () => void view.attempt() }, icon("close"))), form);
  void loadImages().then(() => { if (view.open()) (avatarFocus ? selection : name).focus(); });
}
function openSoul(source: SoulSnapshot, host: MuseHost) {
  placeToasts().querySelectorAll(".toast.info").forEach(element => element.remove());
  let current = source, baseline = source.text ?? "", working = false;
  const text = h("textarea", { className: "field review-memory-input", rows: 14, maxlength: 8_000, readonly: true,
    "aria-label": "SOUL.md", "data-testid": "muse-soul-input", placeholder: t("museSoulMissingBody") });
  text.value = baseline;
  const status = h("p", { className: "muted small", "data-testid": "muse-soul-status" });
  const revision = h("code", { className: "muse-source-revision", "data-testid": "muse-soul-revision" });
  const draw = () => {
    text.placeholder = t(current.exists ? "museSoulEmpty" : "museSoulMissingBody");
    status.textContent = t(current.exists ? "museSoulOriginal" : "museSoulMissingBody"); revision.textContent = current.revision;
  };
  draw();
  const changed = () => text.value !== baseline;
  const beforeUnload = (event: BeforeUnloadEvent) => { if (working || changed()) { event.preventDefault(); event.returnValue = ""; } };
  window.addEventListener("beforeunload", beforeUnload);
  const view = sheet({ testID: "muse-soul-editor", className: "todo-editor-sheet", label: "SOUL.md",
    onClose: () => { window.removeEventListener("beforeunload", beforeUnload); refreshMuseAgent(); },
    canClose: async () => !working && (!changed() || await ask({ title: t("discardChanges"), message: t("formCloseBody"), confirm: t("discard"), destructive: true }) === "confirm") });
  const error = h("p", { className: "form-error", role: "alert", hidden: true, "data-testid": "muse-soul-error" });
  const feedback = h("div", { className: "personal-form-feedback", hidden: true }, error);
  const progressLabel = h("span");
  const progress = h("p", { className: "dialog-progress muse-editor-progress", role: "status", hidden: true, "data-testid": "muse-soul-progress" },
    h("span", { className: "spinner", "aria-hidden": "true" }), progressLabel);
  const lock = (value: boolean, message: StringKey = "personalLoading") => {
    working = value; view.dialog.setAttribute("aria-busy", String(value)); progress.hidden = !value; progressLabel.textContent = t(message);
    view.dialog.querySelectorAll<HTMLTextAreaElement | HTMLButtonElement>("textarea,button").forEach(control => { control.disabled = value; });
  };
  const edit = h("button", { type: "button", className: "button secondary", "data-testid": "muse-soul-edit", onclick: () => {
    text.readOnly = false; edit.hidden = true; save.hidden = false; text.focus();
  } }, t("edit"));
  const reload = h("button", { type: "button", className: "button secondary", "data-testid": "muse-soul-reload", onclick: async () => {
    if (working || changed() && await ask({ title: t("todoReloadTitle"), message: t("museSoulReloadBody"), confirm: t("todoReload") }) !== "confirm") return;
    lock(true);
    try { current = (await readIdentity(host)).soul; text.value = baseline = current.text ?? ""; draw(); error.hidden = true; feedback.hidden = true; }
    catch (failure) { error.textContent = describe(failure); error.hidden = false; feedback.hidden = false; }
    finally { lock(false); }
  } }, t("todoReload"));
  const save = h("button", { type: "submit", className: "button primary", hidden: true, "data-testid": "muse-soul-save" }, t("save"));
  const form = h("form", { className: "todo-editor-form", onsubmit: async (event: Event) => {
    event.preventDefault(); if (working || text.readOnly) return;
    const draft = text.value; lock(true, "personalSaving"); error.hidden = true; feedback.hidden = true;
    const finish = (saved: SoulSnapshot, verified = false) => { current = saved; baseline = draft; view.close(); toast(t(verified ? "museVerifiedSave" : "saved")); };
    try {
      const saved = validSoul(await api<SoulSnapshot>("/api/identity/soul", { method: "PUT", json: { expectedSourceRevision: current.revision, text: draft } }));
      if (saved.text !== draft || !saved.exists) throw new Error(t("personalDataInvalid"));
      finish(saved);
    } catch (failure) {
      if (unknownSave(failure)) {
        try {
          const saved = (await readIdentity(host)).soul;
          const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(draft)))].map(byte => byte.toString(16).padStart(2, "0")).join("");
          if (saved.exists && saved.text === draft && saved.revision === digest) { finish(saved, true); return; }
        } catch {}
      }
      error.textContent = unknownSave(failure) ? t("museSoulSaveUnknown") : failure instanceof APIError && failure.status === 409 ? t("museSoulConflict") : describe(failure);
      error.hidden = false; feedback.hidden = false;
    } finally { lock(false); }
  } }, h("div", { className: "sheet-body todo-editor-body" }, h("p", { className: "muted small" }, t("museSoulAuthority")), status, revision, text), feedback, progress,
    h("div", { className: "personal-form-actions" },
      h("button", { type: "button", className: "button secondary", "data-testid": "muse-soul-close", onclick: () => void view.attempt() }, t("close")), reload, edit, save));
  view.dialog.append(h("div", { className: "sheet-head" }, h("h2", { className: "sheet-title" }, "SOUL.md"),
    h("button", { type: "button", className: "icon-button", "aria-label": t("close"), "data-testid": "muse-soul-dismiss", onclick: () => void view.attempt() }, icon("close"))), form);
  text.focus();
}
const decisions: Record<ApprovalReceipt["decision"], StringKey> = { approved: "museDecisionApproved", alwaysApproved: "museDecisionAlways",
  allowedByPolicy: "museDecisionPolicy", denied: "museDecisionDenied", cancelled: "museDecisionCancelled", blockedByPolicy: "museDecisionBlocked" };
const scopes: Record<ApprovalReceipt["scope"], StringKey> = { action: "museScopeAction", source: "museScopeSource", default: "museScopeDefault", fallback: "museScopeFallback",
  once: "museScopeOnce", task: "museScopeTask" };
function validReceipt(row: ApprovalReceipt) {
  if (!row || typeof row.id !== "string" || !/^[a-f0-9-]{36}$/i.test(row.id) || !Object.hasOwn(decisions, row.decision) || !Object.hasOwn(scopes, row.scope)
    || typeof row.label !== "string" || !row.label.length || typeof row.action !== "string" || !row.action.length
    || typeof row.recordedAt !== "string" || !Number.isFinite(Date.parse(row.recordedAt)) || !["conversation", "page"].includes(row.origin)
    || row.conversationId !== null && (!Number.isSafeInteger(row.conversationId) || row.conversationId < 0)) throw new Error(t("personalDataInvalid"));
  if (row.source !== null) {
    try { const url = new URL(row.source); if (!["http:", "https:"].includes(url.protocol) || url.origin !== row.source) throw new Error(); }
    catch { throw new Error(t("personalDataInvalid")); }
  }
  return row;
}
function receiptContext(row: ApprovalReceipt, host: MuseHost) {
  if (row.origin === "page") return t("museHistoryPage");
  if (row.conversationId === host.mainID()) return t("museMainChat");
  return host.conversations().find(chat => chat.id === row.conversationId)?.title || t("museHistoryChatMissing");
}
function receiptDetail(row: ApprovalReceipt, host: MuseHost) {
  const view = sheet({ testID: "muse-history-detail", label: t("museHistoryDecision"), onClose: refreshMuseAgent });
  const field = (label: string, value: string, id: string) => [h("dt", {}, label), h("dd", { "data-testid": id }, value)];
  const link = row.origin === "conversation" && row.conversationId !== null && host.conversations().some(chat => chat.id === row.conversationId)
    ? h("button", { type: "button", className: "button secondary", "data-testid": "muse-receipt-chat", onclick: () => { view.close(); host.openChat(row.conversationId!); } },
      icon("chat", 16), t("museHistoryOpenChat")) : null;
  view.dialog.append(h("div", { className: "sheet-head" }, h("h2", { className: "sheet-title" }, t("museHistoryDecision")),
    h("button", { type: "button", className: "icon-button", "aria-label": t("close"), "data-testid": "muse-history-detail-close", onclick: view.close }, icon("close"))),
  h("div", { className: "sheet-body" }, h("h3", {}, hostText(row.label)), h("dl", { className: "muse-receipt-fields" },
    ...field(t("museHistoryDecision"), t(decisions[row.decision]), "muse-receipt-decision"),
    ...field(t("museHistoryTime"), when(row.recordedAt), "muse-receipt-time"),
    ...field(t("museHistoryAction"), row.action, "muse-receipt-action"),
    ...field(t("museHistorySource"), row.source ?? t("builtIntoOx"), "muse-receipt-source"),
    ...field(t("museHistoryScope"), t(scopes[row.scope]), "muse-receipt-scope"),
    ...field(t("museHistoryContext"), receiptContext(row, host), "muse-receipt-context")),
    h("p", { className: "muted small", "data-testid": "muse-receipt-note" }, t("museHistoryDecisionNote")), link));
}
async function renderHistory(body: HTMLElement, host: MuseHost, active: () => boolean) {
  const list = h("div", { className: "muse-history-list", "data-testid": "muse-history-list" });
  const status = h("div", { className: "muse-history-status", "aria-live": "polite" });
  const pageStatus = h("div", { className: "muse-history-status", "aria-live": "polite", "data-testid": "muse-history-page-status" });
  const continuation = h("div", { className: "muse-history-continuation" });
  let rows: ApprovalReceipt[] = [], cursor: string | null = null, total = 0, request = 0, loading = false;
  body.replaceChildren(h("h3", { className: "muse-section-heading muse-history-title" }, t("museApprovalsHistory")), status, list, pageStatus, continuation,
    h("p", { className: "muse-panel-note muse-history-note" }, t("museHistoryDecisionNote")));
  const draw = () => {
    list.replaceChildren(...rows.map(row => h("button", { type: "button", className: `muse-history-row ${row.decision}`,
      "data-testid": `muse-receipt-${row.id}`, "data-decision": row.decision, onclick: () => receiptDetail(row, host) }, icon("shield", 18),
      h("span", {}, h("strong", {}, hostText(row.label)), h("small", {}, t(decisions[row.decision]), " · ",
        h("time", { datetime: row.recordedAt, title: when(row.recordedAt) }, relativeTime(Date.parse(row.recordedAt)))),
      h("small", { className: "muse-history-context" }, [receiptContext(row, host), row.source].filter(Boolean).join(" · "))), icon("chevron", 14))));
    if (!rows.length && !loading) list.append(h("p", { className: "muse-panel-note", "data-testid": "muse-history-empty" }, t("museHistoryEmpty")));
    continuation.replaceChildren(...(cursor ? [h("button", { type: "button", className: "button secondary", disabled: loading, "data-testid": "muse-history-more",
      onclick: () => void load(true) }, t("libraryLoadMore", { count: rows.length, total }))] : []));
  };
  const load = async (append = false) => {
    if (!active()) return;
    const focused = body.contains(document.activeElement), restore = keepFocus(body), feedback = append ? pageStatus : status;
    const version = ++request; loading = true;
    status.replaceChildren(); pageStatus.replaceChildren();
    feedback.replaceChildren(h("div", { className: "muse-panel-loading", role: "status", "data-testid": "muse-history-loading" }, h("span", { className: "spinner" }), t("personalLoading")));
    draw();
    try {
      const result = await api<{ available: boolean; records: ApprovalReceipt[]; total: number; nextCursor: string | null }>(
        `/api/approvals/history?${new URLSearchParams({ limit: "30", ...(append && cursor ? { cursor } : {}) })}`, { signal: AbortSignal.timeout(10_000) });
      if (result.available !== true || !Array.isArray(result.records) || !Number.isSafeInteger(result.total) || result.total < result.records.length
        || result.nextCursor !== null && typeof result.nextCursor !== "string") throw new Error(t("personalDataInvalid"));
      result.records.forEach(validReceipt);
      if (!active() || version !== request) return;
      rows = append ? [...new Map([...rows, ...result.records].map(row => [row.id, row])).values()] : result.records;
      cursor = result.nextCursor; total = result.total; feedback.replaceChildren();
    } catch (error) {
      if (!active() || version !== request) return;
      if (!append) { rows = []; cursor = null; }
      feedback.replaceChildren(h("p", { className: "form-error", role: "alert", "data-testid": "muse-history-error" }, describe(error)),
        h("button", { type: "button", className: "button secondary", "data-testid": "muse-history-retry", onclick: () => void load(append && !(error instanceof APIError && error.status === 409)) }, t("museRetry")));
    } finally {
      if (active() && version === request) {
        loading = false; draw();
        if (feedback.querySelector('[role="alert"]')) {
          list.querySelector('[data-testid="muse-history-empty"]')?.remove();
          if (append) feedback.scrollIntoView({ block: "nearest" });
        }
        if (focused && document.activeElement === document.body) restore();
      }
    }
  };
  await load();
}

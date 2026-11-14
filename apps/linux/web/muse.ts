import { api, closeOnBackdrop, formDialog, menu } from "./client";
import { h, icon, type IconName } from "./dom";
import { openScheduleDetails, scheduleSummary, type ScheduleRow } from "./capabilities";
import { editMemory } from "./review";
import { hostText, t } from "./i18n";

export type AgentTab = "activity" | "approvals" | "identity";
type Chat = { id: number; title: string; unread: boolean };
export interface MuseHost {
  conversations(): Chat[];
  mainID(): number | null;
  online(): boolean;
  unread(): number;
  openChat(id: number): void;
  openAgent(tab: AgentTab | null): void;
  navigate(hash: string): void;
}
let panel: { element: HTMLElement; host: MuseHost; tab: AgentTab } | undefined;
let generation = 0;
const button = (label: string, name: IconName, testID: string, run: () => void) =>
  h("button", { type: "button", className: "muse-rail-button", title: label, "aria-label": label, "data-testid": testID, onclick: run }, icon(name, 22));

export function museRail(host: MuseHost, chat: boolean, files: boolean) {
  const unavailable = (key: "museFeed" | "museIdeas" | "museGoals" | "museSpace", name: IconName) => h("button", {
    type: "button", className: "muse-rail-button", disabled: true, "aria-label": `${t(key)}. ${t("museUnavailable")}`,
    title: `${t(key)}. ${t("museUnavailable")}`, "data-testid": `muse-${key.slice(4).toLowerCase()}`,
  }, icon(name, 22));
  const chatLink = h("a", { href: "#/main", className: `muse-rail-button${chat ? " selected" : ""}`, "aria-label": t("museChat"), title: t("museChat"),
    "aria-current": chat ? "page" : null, "data-testid": "muse-chat" }, icon("chat", 22));
  const library = h("a", { href: "#/files", className: `muse-rail-button${files ? " selected" : ""}`, "aria-label": t("museLibrary"), title: t("museLibrary"),
    "aria-current": files ? "page" : null, "data-testid": "muse-library" }, icon("library", 22));
  const avatar = button(t("museOpenAgent"), "user", "muse-agent-open", () => host.openAgent("activity"));
  avatar.classList.add("muse-rail-avatar");
  avatar.replaceChildren(h("img", { src: "/icon.svg", alt: "", width: 40, height: 40 }));
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
      unavailable("museFeed", "feed"), unavailable("museIdeas", "bulb"), unavailable("museGoals", "goal"), library,
      h("hr"), unavailable("museSpace", "space")),
    h("div", { className: "muse-rail-bottom" }, more));
}

export function shortcuts() {
  return formDialog({ title: t("museKeyboardShortcuts"), testID: "muse-shortcuts-dialog", cancel: false, confirm: t("ok"),
    content: h("div", { className: "muse-shortcuts" },
      ...[["Cmd / Ctrl + K", t("museSearch")], ["Cmd / Ctrl + ,", t("settings")], ["Cmd / Ctrl + /", t("museKeyboardShortcuts")], ["Esc", t("close")]]
        .map(([key, label]) => h("div", {}, h("span", {}, label), h("kbd", {}, key)))) });
}

export function openMuseSearch(host: MuseHost) {
  if (document.querySelector('[data-testid="muse-search"]')) return;
  const previous = document.activeElement;
  const dialog = h("dialog", { className: "muse-search-dialog", "aria-label": t("museSearch"), "data-testid": "muse-search" });
  const input = h("input", { type: "search", placeholder: t("museSearch"), "aria-label": t("museSearch"), autocomplete: "off", "data-testid": "muse-search-input" });
  const results = h("div", { className: "muse-search-results" });
  const close = () => { dialog.close(); dialog.remove(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  const render = () => {
    const query = input.value.trim().toLocaleLowerCase();
    const chats = host.conversations().filter(chat => !query || (chat.id === host.mainID() ? t("museMainChat") : chat.title).toLocaleLowerCase().includes(query)).slice(0, 30);
    results.replaceChildren(h("p", { className: "muse-search-label" }, query ? t("museSearchResults") : t("museRecents")),
      ...(chats.length ? chats.map(chat => h("button", { type: "button", className: "muse-search-result", "data-testid": `muse-search-result-${chat.id}`,
        onclick: () => { close(); host.openChat(chat.id); } }, icon("chat", 20), h("span", {}, chat.id === host.mainID() ? t("museMainChat") : chat.title || t("untitled"))))
        : [h("p", { className: "muse-search-empty", "data-testid": "muse-search-empty" }, t("museSearchEmpty"))]));
  };
  input.addEventListener("input", render);
  input.addEventListener("keydown", event => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
    else if (event.key === "ArrowDown") { event.preventDefault(); results.querySelector<HTMLButtonElement>("button")?.focus(); }
  });
  dialog.addEventListener("cancel", event => { event.preventDefault(); close(); });
  closeOnBackdrop(dialog, close);
  dialog.append(h("div", { className: "muse-search-head" }, icon("search", 22), input), results);
  document.body.append(dialog);
  render(); dialog.showModal(); input.focus();
}

export function closeMuseAgent() { generation++; panel = undefined; }
export function refreshMuseAgent() {
  if (panel?.element.isConnected && !document.querySelector("dialog[open]")) void renderAgentBody(panel.element, panel.host, panel.tab);
}
export function museAgent(host: MuseHost, tab: AgentTab) {
  const element = h("aside", { className: "muse-agent", "aria-label": t("museAgent"), "data-testid": "muse-agent" });
  panel = { element, host, tab };
  const hero = h("header", { className: "muse-agent-hero" },
    h("button", { type: "button", className: "icon-button muse-agent-close", "aria-label": t("close"), "data-testid": "muse-agent-close", onclick: () => host.openAgent(null) }, icon("close", 20)),
    h("div", { className: "muse-agent-avatar" }, h("img", { src: "/icon.svg", alt: "", width: 128, height: 128 }),
      h("button", { type: "button", className: "icon-button muse-avatar-edit", "aria-label": t("museIdentity"), title: t("museIdentity"),
        "data-testid": "muse-avatar-edit", onclick: () => host.openAgent("identity") }, icon("pencil", 18))),
    h("strong", { className: "muse-agent-name" }, t("appName")),
    h("span", { className: `muse-agent-connection${host.online() ? "" : " disconnected"}`, title: t("museHostConnection") },
      h("span", { className: "muse-connection-dot", "aria-hidden": "true" }, icon("spark", 10)), t(host.online() ? "museConnected" : "museDisconnected")));
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
  body.replaceChildren(h("div", { className: "muse-panel-loading", role: "status" }, h("span", { className: "spinner" }), t("personalLoading")));
  try {
    if (tab === "activity") {
      const [scheduled, watched] = await Promise.all([api<{ schedules: ScheduleRow[] }>("/api/schedules"),
        api<{ watches: { id: string; name: string; enabled: boolean; lastError: string | null }[]; warning: string | null }>("/api/watches")]);
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
      if (host.unread()) body.append(h("a", { href: "#/inbox", className: "muse-task-row", "data-testid": "muse-unread-results" },
        icon("chat", 16), t("noticeUnreadCount", { count: host.unread() }), icon("chevron", 14)));
    } else if (tab === "identity") {
      const state = await api<{ memory: { text: string; revision: string } }>("/api/review");
      if (!state.memory || typeof state.memory.text !== "string" || typeof state.memory.revision !== "string") throw new Error(t("personalDataInvalid"));
      if (!active()) return;
      const memory = h("button", { type: "button", className: "muse-file-card memory", "data-testid": "muse-memory",
        onclick: () => editMemory(state.memory, refreshMuseAgent) }, h("strong", {}, "MEMORY"), h("span", {}, t("museAccessCare")),
      h("small", {}, state.memory.text.trim().split("\n")[0]?.slice(0, 80) || t("museNoMemory")), icon("heart", 20));
      const soul = h("button", { type: "button", className: "muse-file-card soul", disabled: true, "data-testid": "muse-soul", title: t("museSoulUnavailable"),
        "aria-label": `SOUL. ${t("museSoulUnavailable")}` }, h("strong", {}, "SOUL"), h("span", {}, t("museAccessCare")),
      h("small", {}, t("museNotConnected")), icon("heart", 20));
      body.replaceChildren(h("div", { className: "muse-identity-summary" }, h("p", {}, t("museIdentityPending"))),
        h("div", { className: "muse-file-cards" }, soul, memory));
    } else {
      if (!active()) return;
      body.replaceChildren(h("h3", { className: "muse-section-heading" }, t("museApprovalsHistory")),
        h("p", { className: "muse-panel-note", "data-testid": "muse-approvals-unavailable" }, t("museApprovalsUnavailable")));
    }
  } catch (error) {
    if (!active()) return;
    body.replaceChildren(h("p", { className: "form-error", role: "alert", "data-testid": "muse-agent-error" }, hostText(error instanceof Error ? error.message : String(error))),
      h("button", { type: "button", className: "button secondary", "data-testid": "muse-agent-retry",
        onclick: () => void renderAgentBody(element, host, tab) }, t("museRetry")));
  }
}

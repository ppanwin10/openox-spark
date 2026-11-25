import { h, icon } from "./dom";
import { api } from "./client";
import { t } from "./i18n";
import { openViewer } from "./viewer";

type PageState = { id: string; owner: string; label: string; conversationId: number | null; url: string; title: string };
type PanelView = { busy: boolean; pendingPrompt?: unknown | null; blocks?: { kind: Record<string, unknown> }[] };
const collapsedKey = "ox.browserPanel.collapsed";
const siteOf = (url: string) => { try { return new URL(url).host; } catch { return ""; } };

export interface BrowserPanel { update(view: PanelView | null): void; refresh(): void; dispose(): void }
type Placement = { variant: "aside"; main: HTMLElement; header: HTMLElement } | { variant: "column"; container: HTMLElement };

export function mountBrowserPanel(main: HTMLElement, header: HTMLElement, conversationId: number, onPages?: (count: number) => void): BrowserPanel {
  return mountBrowserView({ variant: "aside", main, header }, conversationId, onPages);
}

export function mountComputerView(container: HTMLElement, conversationId: number | null): BrowserPanel {
  if (conversationId === null) {
    container.replaceChildren(h("p", { className: "muse-panel-note", "data-testid": "computer-idle" }, t("computerIdle")));
    return { update() {}, refresh() {}, dispose() {} };
  }
  return mountBrowserView({ variant: "column", container }, conversationId);
}

function mountBrowserView(placement: Placement, conversationId: number, onPages?: (count: number) => void): BrowserPanel {
  const column = placement.variant === "column", main = placement.variant === "aside" ? placement.main : undefined, header = placement.variant === "aside" ? placement.header : undefined;
  let pages: PageState[] = [], selected: string | undefined, events: EventSource | undefined, streaming: string | undefined, disposed = false;
  let handoff = false, busy = false, collapsed = !column && localStorage.getItem(collapsedKey) === "1";
  const image = h("img", { className: "browser-panel-image", alt: "", draggable: "false", "data-testid": "browser-panel-image" }) as HTMLImageElement;
  const site = h("span", { className: "browser-panel-site", "data-testid": "browser-panel-site" });
  const status = h("span", { className: "browser-panel-status", "data-testid": "browser-panel-status" });
  const tabs = h("div", { className: "browser-panel-tabs" });
  const takeover = h("button", { type: "button", className: "button secondary small", "data-testid": "browser-panel-takeover", onclick: () => open() }) as HTMLButtonElement;
  const toggle = h("button", { type: "button", className: "icon-button browser-panel-toggle", "data-testid": "browser-panel-toggle", onclick: () => setCollapsed(!collapsed) }) as HTMLButtonElement;
  const stage = h("button", { type: "button", className: "browser-panel-stage", "aria-label": t("browserPanelOpen"), onclick: () => open() }, image);
  const idle = h("p", { className: "muse-panel-note", "data-testid": "computer-idle", hidden: true }, t("computerIdle"));
  const root = h(column ? "section" : "aside", { className: "browser-panel", "data-testid": "browser-panel", "data-variant": placement.variant, "aria-label": t("browserPanelTitle"), hidden: !column },
    h("div", { className: "browser-panel-head" }, icon(column ? "monitor" : "globe", 16), h("div", { className: "browser-panel-heading" }, h("strong", {}, t(column ? "computerTitle" : "browserPanelTitle")), site), status, column ? null : toggle),
    tabs, stage, h("div", { className: "browser-panel-actions" }, takeover), idle);
  if (placement.variant === "aside") placement.header.after(root); else placement.container.replaceChildren(root);

  function open() {
    const card = [...document.querySelectorAll<HTMLButtonElement>('[data-testid="pending-page"] [data-testid="open-handoff-page"]')].at(-1);
    if (handoff && card) card.click();
    else if (selected) openViewer(selected);
  }
  function setCollapsed(value: boolean) {
    collapsed = value;
    try { localStorage.setItem(collapsedKey, value ? "1" : "0"); } catch {}
    render();
  }
  function stream() {
    const viewerOpen = !!document.querySelector('[data-testid="viewer-stage"]');
    const target = !disposed && !collapsed && !viewerOpen && !root.hidden && root.isConnected && root.offsetParent !== null ? selected : undefined;
    if (target === streaming) return;
    events?.close(); events = undefined; streaming = target;
    if (!target) return;
    // The computer view shows a desktop screen; other views watch without resizing the assistant's page.
    const source = new EventSource(`/api/pages/${encodeURIComponent(target)}/stream${column ? "?width=1280&height=800" : ""}`);
    events = source;
    source.addEventListener("frame", event => {
      if (events !== source) return;
      image.src = `data:image/jpeg;base64,${(JSON.parse((event as MessageEvent).data) as { data: string }).data}`;
    });
    source.onerror = () => { source.close(); if (events === source) { events = undefined; streaming = undefined; setTimeout(stream, 1_500); } };
  }
  function render() {
    const page = pages.find(item => item.id === selected);
    if (column) {
      idle.hidden = !!page;
      for (const part of [stage, takeover.parentElement!, status, site]) (part as HTMLElement).hidden = !page;
    } else root.hidden = !page;
    main?.toggleAttribute("data-browser", !!page);
    main?.toggleAttribute("data-browser-collapsed", !!page && collapsed);
    root.toggleAttribute("data-collapsed", collapsed);
    if (header) root.style.setProperty("--browser-panel-top", `${header.offsetHeight}px`);
    if (page) {
      site.textContent = siteOf(page.url) || page.title;
      status.textContent = t(handoff ? "browserPanelYourTurn" : busy ? "browserPanelWorking" : "browserPanelIdle");
      root.dataset.state = handoff ? "handoff" : busy ? "working" : "idle";
      takeover.textContent = t(handoff ? "browserPanelTakeOver" : "browserPanelOpen");
      takeover.className = `button ${handoff ? "primary" : "secondary"} small`;
      toggle.replaceChildren(icon(collapsed ? "chevron" : "close", 16));
      toggle.setAttribute("aria-label", t(collapsed ? "browserPanelShow" : "browserPanelHide"));
      tabs.hidden = pages.length < 2;
      tabs.replaceChildren(...pages.map(item => h("button", { type: "button", className: `viewer-tab${item.id === selected ? " active" : ""}`,
        onclick: () => { selected = item.id; render(); } }, siteOf(item.url) || item.label)));
    }
    stream();
  }
  async function refresh() {
    try {
      const result = await api<{ pages: PageState[] }>(`/api/pages?conversation=${conversationId}`);
      if (disposed) return;
      pages = result.pages.filter(page => page.conversationId === conversationId && page.owner.startsWith(`browser:${conversationId}`))
        .sort((a, b) => Number(a.owner.includes("#")) - Number(b.owner.includes("#")));
      if (!pages.some(page => page.id === selected)) selected = pages[0]?.id;
    } catch { if (disposed) return; pages = []; selected = undefined; }
    onPages?.(pages.length);
    render();
  }
  const poll = setInterval(() => stream(), 1_000);
  void refresh();
  return {
    update(view) {
      busy = !!view?.busy;
      handoff = !!view?.pendingPrompt && !!view.blocks?.some(block => block.kind.promptKind === "page" && block.kind.promptId === (view.pendingPrompt as { id?: string }).id);
      if (!root.hidden || column) render();
    },
    refresh: () => void refresh(),
    dispose() {
      disposed = true; clearInterval(poll); events?.close(); events = undefined;
      root.remove(); main?.removeAttribute("data-browser"); main?.removeAttribute("data-browser-collapsed");
    },
  };
}

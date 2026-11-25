import { h, icon } from "./dom";
import { api } from "./client";
import { t } from "./i18n";
import { openViewer } from "./viewer";

type PageState = { id: string; owner: string; label: string; conversationId: number | null; url: string; title: string };
type PanelView = { busy: boolean; pendingPrompt?: unknown | null; blocks?: { kind: Record<string, unknown> }[] };
const collapsedKey = "ox.browserPanel.collapsed";
const siteOf = (url: string) => { try { return new URL(url).host; } catch { return ""; } };

export interface BrowserPanel { update(view: PanelView | null): void; refresh(): void; dispose(): void }

export function mountBrowserPanel(main: HTMLElement, header: HTMLElement, conversationId: number): BrowserPanel {
  let pages: PageState[] = [], selected: string | undefined, events: EventSource | undefined, streaming: string | undefined, disposed = false;
  let handoff = false, busy = false, collapsed = localStorage.getItem(collapsedKey) === "1";
  const image = h("img", { className: "browser-panel-image", alt: "", draggable: "false", "data-testid": "browser-panel-image" }) as HTMLImageElement;
  const site = h("span", { className: "browser-panel-site", "data-testid": "browser-panel-site" });
  const status = h("span", { className: "browser-panel-status", "data-testid": "browser-panel-status" });
  const tabs = h("div", { className: "browser-panel-tabs" });
  const takeover = h("button", { type: "button", className: "button secondary small", "data-testid": "browser-panel-takeover", onclick: () => open() }) as HTMLButtonElement;
  const toggle = h("button", { type: "button", className: "icon-button browser-panel-toggle", "data-testid": "browser-panel-toggle", onclick: () => setCollapsed(!collapsed) }) as HTMLButtonElement;
  const stage = h("button", { type: "button", className: "browser-panel-stage", "aria-label": t("browserPanelOpen"), onclick: () => open() }, image);
  const root = h("aside", { className: "browser-panel", "data-testid": "browser-panel", "aria-label": t("browserPanelTitle"), hidden: true },
    h("div", { className: "browser-panel-head" }, icon("globe", 16), h("div", { className: "browser-panel-heading" }, h("strong", {}, t("browserPanelTitle")), site), status, toggle),
    tabs, stage, h("div", { className: "browser-panel-actions" }, takeover));
  header.after(root);

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
    const target = !disposed && !collapsed && !viewerOpen && !root.hidden ? selected : undefined;
    if (target === streaming) return;
    events?.close(); events = undefined; streaming = target;
    if (!target) return;
    const width = Math.max(320, Math.round(stage.clientWidth || 480)), height = Math.max(240, Math.round(stage.clientHeight || 360));
    const source = new EventSource(`/api/pages/${encodeURIComponent(target)}/stream?width=${width}&height=${height}`);
    events = source;
    source.addEventListener("frame", event => {
      if (events !== source) return;
      image.src = `data:image/jpeg;base64,${(JSON.parse((event as MessageEvent).data) as { data: string }).data}`;
    });
    source.onerror = () => { source.close(); if (events === source) { events = undefined; streaming = undefined; setTimeout(stream, 1_500); } };
  }
  function render() {
    const page = pages.find(item => item.id === selected);
    root.hidden = !page;
    main.toggleAttribute("data-browser", !!page);
    main.toggleAttribute("data-browser-collapsed", !!page && collapsed);
    root.toggleAttribute("data-collapsed", collapsed);
    root.style.setProperty("--browser-panel-top", `${header.offsetHeight}px`);
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
    render();
  }
  const poll = setInterval(() => stream(), 1_000);
  void refresh();
  return {
    update(view) {
      busy = !!view?.busy;
      handoff = !!view?.pendingPrompt && !!view.blocks?.some(block => block.kind.promptKind === "page" && block.kind.promptId === (view.pendingPrompt as { id?: string }).id);
      if (!root.hidden) render();
    },
    refresh: () => void refresh(),
    dispose() {
      disposed = true; clearInterval(poll); events?.close(); events = undefined;
      root.remove(); main.removeAttribute("data-browser"); main.removeAttribute("data-browser-collapsed");
    },
  };
}

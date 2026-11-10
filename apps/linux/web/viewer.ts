import { api, APIError, failed } from "./client";
import { h, icon } from "./dom";
import { t } from "./i18n";
import { host, type Handoff } from "./prompts";

type PageState = { id: string; owner: string; label: string; conversationId: number | null; url: string; title: string; viewport: { width: number; height: number } };
type Input = { type: "tap"; x: number; y: number } | { type: "scroll"; x: number; y: number; deltaX: number; deltaY: number } | { type: "text"; text: string }
  | { type: "key"; key: string } | { type: "back" } | { type: "forward" } | { type: "reload" };

const specialKeys = new Set(["Enter", "Backspace", "Tab", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Delete", "Home", "End", "PageUp", "PageDown"]);
let openIDs = new Set<string>();
let current: Viewer | undefined;

export async function refreshOpenPages() {
  try { openIDs = new Set((await api<{ pages: PageState[] }>("/api/pages")).pages.map(page => page.id)); } catch {}
}
export const isPageOpen = (id: string) => openIDs.has(id);
export function pagesChanged() { void current?.refresh(); }
export function openViewer(id: string, handoff?: Handoff, container?: HTMLElement, focusPage = true) {
  const replacing = !!current;
  current?.close(false);
  current = new Viewer(id, handoff, container, focusPage, replacing && !!(history.state as { oxViewer?: string } | null)?.oxViewer);
  return current;
}
export const viewerOpenIn = (container: HTMLElement) => !!current && current.within(container);
export function closeViewerIn(container: HTMLElement) { if (current?.within(container)) current.close(); }

class Viewer {
  private id: string;
  private handoff?: Handoff;
  private root: HTMLElement;
  private stage: HTMLElement;
  private image: HTMLImageElement;
  private status: HTMLElement;
  private heading: HTMLElement;
  private tabs: HTMLElement;
  private keys: HTMLFormElement;
  private events?: EventSource;
  private frame = { width: 0, height: 0 };
  private queue: Promise<unknown> = Promise.resolve();
  private typed = "";
  private typing?: ReturnType<typeof setTimeout>;
  private resizing?: ReturnType<typeof setTimeout>;
  private retry?: ReturnType<typeof setTimeout>;
  private gone = false;
  private closed = false;
  private pushed = false;
  private previousFocus: Element | null;
  private onPop = () => this.close(false);
  private onResize = () => { clearTimeout(this.resizing); this.resizing = setTimeout(() => this.connect(), 300); };
  private onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && document.activeElement !== this.stage) { event.preventDefault(); this.close(); } };

  constructor(id: string, handoff?: Handoff, container: HTMLElement = document.body, focusPage = true, replace = false) {
    this.id = id;
    this.handoff = handoff;
    this.previousFocus = document.activeElement;
    this.image = h("img", { className: "viewer-frame", alt: "", draggable: "false" });
    this.status = h("div", { className: "viewer-status", role: "status", "data-testid": "viewer-status" }, h("span", { className: "spinner", "aria-hidden": "true" }), t("connectingPage"));
    this.stage = h("div", { className: "viewer-stage", tabindex: 0, "aria-label": t("livePage"), "data-testid": "viewer-stage" }, this.image, this.status);
    this.heading = h("div", { className: "viewer-heading" }, h("div", { className: "viewer-title" }, t("livePage")), h("div", { className: "viewer-host" }));
    this.tabs = h("nav", { className: "viewer-tabs", hidden: true });
    const text = h("input", { className: "field", placeholder: t("typeHere"), "aria-label": t("typeHere"), autocomplete: "off", autocapitalize: "off", spellcheck: "false", "data-testid": "viewer-text" });
    this.keys = h("form", { className: "viewer-keys", hidden: true, onsubmit: (event: Event) => {
      event.preventDefault();
      if (text.value) { this.send({ type: "text", text: text.value }); text.value = ""; }
    } }, text,
      h("button", { type: "submit", className: "button primary small", "data-testid": "viewer-send-text" }, t("sendText")),
      h("button", { type: "button", className: "icon-button", "aria-label": t("enterKey"), title: t("enterKey"), onclick: () => this.send({ type: "key", key: "Enter" }) }, icon("enter", 18)),
      h("button", { type: "button", className: "icon-button", "aria-label": t("eraseKey"), title: t("eraseKey"), onclick: () => this.send({ type: "key", key: "Backspace" }) }, icon("erase", 18)));
    const action = (name: "back" | "forward" | "reload", iconName: "back" | "forward" | "reload", label: string) =>
      h("button", { type: "button", className: "icon-button", "aria-label": label, title: label, "data-testid": `viewer-${name}`, onclick: () => this.send({ type: name }) }, icon(iconName, 18));
    this.root = h("div", { className: "viewer", role: "dialog", "aria-modal": "true", "aria-label": t("livePage"), "data-testid": "page-viewer" },
      h("div", { className: "viewer-sheet" },
        h("header", { className: "viewer-bar" },
          h("button", { type: "button", className: "icon-button", "aria-label": t("closePage"), title: t("closePage"), "data-testid": "viewer-close", onclick: () => this.close() }, icon("close", 18)),
          this.heading,
          h("div", { className: "viewer-actions" }, action("back", "back", t("pageBack")), action("forward", "forward", t("pageForward")), action("reload", "reload", t("pageReload")),
            h("button", { type: "button", className: "icon-button", "aria-label": t("keyboard"), title: t("keyboard"), "data-testid": "viewer-keyboard", onclick: () => {
              this.keys.hidden = !this.keys.hidden;
              if (!this.keys.hidden) text.focus();
            } }, icon("keyboard", 18)))),
        this.tabs, this.stage, this.keys,
        handoff ? h("div", { className: "viewer-handoff", "data-testid": "viewer-handoff" },
          h("div", { className: "viewer-handoff-text" }, h("div", { className: "label" }, t("waitingForYou")), h("p", {}, handoff.body)),
          h("button", { type: "button", className: "button primary", "data-testid": "viewer-done", onclick: () => void this.finish() }, handoff.done === "Done" ? t("done") : handoff.done)) : null));
    this.bindInput();
    container.append(this.root);
    document.body.classList.add("viewer-open");
    if (replace) history.replaceState({ oxViewer: id }, "", location.href); else history.pushState({ oxViewer: id }, "", location.href);
    this.pushed = true;
    window.addEventListener("popstate", this.onPop);
    window.addEventListener("resize", this.onResize);
    document.addEventListener("keydown", this.onKey);
    if (focusPage) this.stage.focus({ preventScroll: true });
    else this.root.querySelector<HTMLElement>("[data-testid=viewer-close]")?.focus({ preventScroll: true });
    void this.refresh();
    requestAnimationFrame(() => this.connect());
  }

  within(container: HTMLElement) { return !this.closed && container.contains(this.root); }

  async refresh() {
    if (this.closed) return;
    try {
      const { page, related } = await api<{ page: PageState; related: PageState[] }>(`/api/pages/${encodeURIComponent(this.id)}`);
      this.heading.replaceChildren(h("div", { className: "viewer-title" }, page.title || page.label), h("div", { className: "viewer-host" }, host(page.url)));
      this.tabs.hidden = related.length < 2;
      this.tabs.replaceChildren(...related.map(item => h("button", { type: "button", className: `viewer-tab${item.id === this.id ? " active" : ""}`,
        onclick: () => { if (item.id !== this.id) this.switchTo(item.id); } }, item.title || host(item.url) || item.label)));
    } catch (error) {
      if (error instanceof APIError && error.status === 404) this.markGone();
    }
  }

  private switchTo(id: string) {
    this.id = id;
    this.frame = { width: 0, height: 0 };
    this.image.removeAttribute("src");
    void this.refresh();
    this.connect();
  }

  private markGone() {
    this.gone = true;
    this.events?.close();
    this.status.replaceChildren(h("span", {}, t("pageGone")));
    this.status.hidden = false;
    this.image.removeAttribute("src");
  }

  private connect() {
    if (this.closed || this.gone) return;
    clearTimeout(this.retry);
    this.events?.close();
    const width = Math.round(this.stage.clientWidth), height = Math.round(this.stage.clientHeight);
    const events = new EventSource(`/api/pages/${encodeURIComponent(this.id)}/stream?width=${width}&height=${height}`);
    this.events = events;
    events.addEventListener("frame", event => {
      const frame = JSON.parse((event as MessageEvent).data) as { data: string; width: number; height: number };
      this.frame = { width: frame.width, height: frame.height };
      this.image.src = `data:image/jpeg;base64,${frame.data}`;
      this.status.hidden = true;
    });
    events.onerror = () => {
      events.close();
      if (this.events !== events || this.closed) return;
      void this.refresh().then(() => { if (!this.gone && !this.closed) this.retry = setTimeout(() => this.connect(), 1_500); });
    };
  }

  private point(clientX: number, clientY: number) {
    const rect = this.image.getBoundingClientRect();
    if (!this.frame.width || !rect.width) return undefined;
    const scale = Math.min(rect.width / this.frame.width, rect.height / this.frame.height);
    const width = this.frame.width * scale, height = this.frame.height * scale;
    const x = (clientX - rect.left - (rect.width - width) / 2) / width, y = (clientY - rect.top - (rect.height - height) / 2) / height;
    return x < 0 || x > 1 || y < 0 || y > 1 ? undefined : { x, y, scale };
  }

  private bindInput() {
    let start: { x: number; y: number; id: number } | undefined, last = { x: 0, y: 0 }, moved = false, pending = { x: 0, y: 0 };
    let anchor: { x: number; y: number; scale: number } | undefined, flush: ReturnType<typeof setTimeout> | undefined;
    const scroll = () => {
      flush = undefined;
      if (!anchor || (!pending.x && !pending.y)) return;
      this.send({ type: "scroll", x: anchor.x, y: anchor.y, deltaX: pending.x / anchor.scale, deltaY: pending.y / anchor.scale });
      pending = { x: 0, y: 0 };
    };
    this.stage.addEventListener("pointerdown", event => {
      if (event.button !== 0) return;
      start = { x: event.clientX, y: event.clientY, id: event.pointerId };
      last = { x: event.clientX, y: event.clientY };
      moved = false;
      anchor = this.point(event.clientX, event.clientY);
      this.stage.setPointerCapture(event.pointerId);
    });
    this.stage.addEventListener("pointermove", event => {
      if (!start || event.pointerId !== start.id) return;
      if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 8) moved = true;
      if (moved && event.pointerType !== "mouse") {
        pending.x += last.x - event.clientX;
        pending.y += last.y - event.clientY;
        flush ??= setTimeout(scroll, 60);
      }
      last = { x: event.clientX, y: event.clientY };
    });
    const end = (event: PointerEvent) => {
      if (!start || event.pointerId !== start.id) return;
      if (!moved) {
        const point = this.point(event.clientX, event.clientY);
        if (point) this.send({ type: "tap", x: point.x, y: point.y });
      }
      start = undefined;
      this.stage.focus({ preventScroll: true });
    };
    this.stage.addEventListener("pointerup", end);
    this.stage.addEventListener("pointercancel", () => { start = undefined; });
    this.stage.addEventListener("wheel", event => {
      event.preventDefault();
      const point = this.point(event.clientX, event.clientY);
      if (!point) return;
      anchor = point;
      pending.x += event.deltaX;
      pending.y += event.deltaY;
      flush ??= setTimeout(scroll, 60);
    }, { passive: false });
    this.stage.addEventListener("keydown", event => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.isComposing) return;
      if (event.key === "Escape") { event.preventDefault(); this.close(); return; }
      if (specialKeys.has(event.key)) { event.preventDefault(); this.flushText(); this.send({ type: "key", key: event.key }); return; }
      if (event.key.length === 1) {
        event.preventDefault();
        this.typed += event.key;
        clearTimeout(this.typing);
        this.typing = setTimeout(() => this.flushText(), 40);
      }
    });
    this.stage.addEventListener("paste", event => {
      const text = event.clipboardData?.getData("text/plain");
      if (text) { event.preventDefault(); this.flushText(); this.send({ type: "text", text: text.slice(0, 4_000) }); }
    });
  }

  private flushText() {
    clearTimeout(this.typing);
    if (this.typed) { this.send({ type: "text", text: this.typed }); this.typed = ""; }
  }

  private send(input: Input) {
    if (this.gone || this.closed) return;
    const id = this.id;
    this.queue = this.queue.then(() => api(`/api/pages/${encodeURIComponent(id)}/input`, { method: "POST", json: input })).catch(error => {
      if (error instanceof APIError && error.status === 404) this.markGone(); else failed(error);
    });
  }

  private async finish() {
    const handoff = this.handoff;
    if (!handoff) return;
    try {
      await (handoff.respond ? handoff.respond() : api(`/api/conversations/${handoff.conversationId}/respond`, { method: "POST", json: { promptId: handoff.promptId, answer: handoff.done } }));
      this.close();
    } catch (error) { failed(error); }
  }

  close(fromUser = true) {
    if (this.closed) return;
    this.closed = true;
    this.flushText();
    clearTimeout(this.retry);
    clearTimeout(this.resizing);
    this.events?.close();
    window.removeEventListener("popstate", this.onPop);
    window.removeEventListener("resize", this.onResize);
    document.removeEventListener("keydown", this.onKey);
    this.root.remove();
    document.body.classList.remove("viewer-open");
    if (current === this) current = undefined;
    if (fromUser && this.pushed && (history.state as { oxViewer?: string } | null)?.oxViewer) history.back();
    (this.previousFocus as HTMLElement | null)?.focus?.({ preventScroll: true });
  }
}

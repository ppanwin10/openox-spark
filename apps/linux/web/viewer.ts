import { api, APIError, failed } from "./client";
import { h, icon } from "./dom";
import { t } from "./i18n";
import { host, type Handoff } from "./prompts";

type PageState = { id: string; owner: string; label: string; conversationId: number | null; url: string; title: string; viewport: { width: number; height: number } };
type Contact = { id: number; x: number; y: number };
type Gesture = { kind: "start" | "move" | "end" | "cancel"; points: Contact[]; at: number };
type MouseInput = { type: "mouse"; kind: "move" | "down" | "up" | "cancel"; x: number; y: number; button: "none" | "left" | "middle" | "right"; buttons: number; clicks: number; modifiers: number };
type Input = { type: "tap"; x: number; y: number } | { type: "scroll"; x: number; y: number; deltaX: number; deltaY: number } | { type: "text"; text: string }
  | MouseInput | { type: "key"; key: string } | { type: "back" } | { type: "forward" } | { type: "reload" } | { type: "touch"; events: Gesture[] };
const coarse = matchMedia("(pointer: coarse)"), gestureLimit = 200;

const specialKeys = new Set(["Enter", "Backspace", "Tab", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Delete", "Home", "End", "PageUp", "PageDown", "Space"]);
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
  private outbox: Input[] = [];
  private pumping = false;
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
    this.outbox = [];
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
    const events = new EventSource(`/api/pages/${encodeURIComponent(this.id)}/stream?width=${width}&height=${height}${coarse.matches ? "&mobile=1" : ""}`);
    this.events = events;
    events.addEventListener("frame", event => {
      if (this.events !== events || this.closed) return;
      const frame = JSON.parse((event as MessageEvent).data) as { data: string; width: number; height: number; scrollX: number; scrollY: number; zoom: number };
      this.frame = { width: frame.width, height: frame.height };
      Object.assign(this.stage.dataset, { scrollX: String(frame.scrollX), scrollY: String(frame.scrollY), zoom: String(frame.zoom) });
      this.image.src = `data:image/jpeg;base64,${frame.data}`;
      this.status.hidden = true;
    });
    events.onerror = () => {
      events.close();
      if (this.events !== events || this.closed) return;
      void this.refresh().then(() => { if (!this.gone && !this.closed) this.retry = setTimeout(() => this.connect(), 1_500); });
    };
  }

  private point(clientX: number, clientY: number, clamp = false) {
    const rect = this.image.getBoundingClientRect();
    if (!this.frame.width || !rect.width) return undefined;
    const scale = Math.min(rect.width / this.frame.width, rect.height / this.frame.height);
    const width = this.frame.width * scale, height = this.frame.height * scale;
    const x = (clientX - rect.left - (rect.width - width) / 2) / width, y = (clientY - rect.top - (rect.height - height) / 2) / height;
    if (clamp) return { x: Math.min(Math.max(x, 0), 1), y: Math.min(Math.max(y, 0), 1), scale };
    return x < 0 || x > 1 || y < 0 || y > 1 ? undefined : { x, y, scale };
  }

  private bindInput() {
    let mouse: { id: number; button: MouseInput["button"]; clicks: number; x: number; y: number } | undefined;
    let click = { at: -1000, x: 0, y: 0, button: -1, count: 0 };
    const fingers = new Map<number, Contact>();
    const touchLike = (event: PointerEvent) => event.pointerType === "touch" || event.pointerType === "pen";
    const gesture = (kind: Gesture["kind"], at: number) => this.send({ type: "touch", events: [{ kind, points: [...fingers.values()].map(point => ({ ...point })), at }] });
    const slot = () => { const used = new Set([...fingers.values()].map(point => point.id)); let id = 0; while (used.has(id)) id += 1; return id; };
    const modifiers = (event: MouseEvent) => (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0);
    this.stage.addEventListener("pointerdown", event => {
      this.flushText();
      if (touchLike(event)) {
        const point = this.point(event.clientX, event.clientY);
        if (!point || fingers.size >= 10) return;
        event.preventDefault();
        fingers.set(event.pointerId, { id: slot(), x: point.x, y: point.y });
        this.stage.setPointerCapture(event.pointerId);
        gesture("start", event.timeStamp);
        return;
      }
      if (![0, 1, 2].includes(event.button)) return;
      const point = this.point(event.clientX, event.clientY);
      if (!point) return;
      event.preventDefault();
      const count = event.button === click.button && event.timeStamp - click.at < 500 && Math.hypot(event.clientX - click.x, event.clientY - click.y) < 5
        ? click.count % 3 + 1 : 1;
      click = { at: event.timeStamp, x: event.clientX, y: event.clientY, button: event.button, count };
      mouse = { id: event.pointerId, button: (["left", "middle", "right"] as const)[event.button]!, clicks: count, x: point.x, y: point.y };
      this.stage.setPointerCapture(event.pointerId);
      this.stage.focus({ preventScroll: true });
      this.send({ type: "mouse", kind: "down", x: point.x, y: point.y, button: mouse.button, buttons: event.buttons, clicks: count, modifiers: modifiers(event) });
    });
    this.stage.addEventListener("pointermove", event => {
      const finger = fingers.get(event.pointerId);
      if (finger) {
        const point = this.point(event.clientX, event.clientY, true);
        if (!point || (point.x === finger.x && point.y === finger.y)) return;
        Object.assign(finger, { x: point.x, y: point.y });
        gesture("move", event.timeStamp);
        return;
      }
      if (touchLike(event)) return;
      const point = this.point(event.clientX, event.clientY, !!mouse);
      if (!point) return;
      if (mouse) {
        Object.assign(mouse, { x: point.x, y: point.y });
        if (Math.hypot(event.clientX - click.x, event.clientY - click.y) > 5) click.at = -1000;
      }
      this.send({ type: "mouse", kind: "move", x: point.x, y: point.y, button: mouse?.button ?? "none", buttons: event.buttons, clicks: 0, modifiers: modifiers(event) });
    });
    const end = (event: PointerEvent) => {
      if (fingers.delete(event.pointerId)) {
        if (event.type === "pointercancel") { fingers.clear(); gesture("cancel", event.timeStamp); }
        else gesture("end", event.timeStamp);
        if (!fingers.size) this.stage.focus({ preventScroll: true });
        return;
      }
      if (!mouse || event.pointerId !== mouse.id) return;
      const point = this.point(event.clientX, event.clientY, true) ?? mouse;
      this.send({ type: "mouse", kind: event.type === "pointerup" ? "up" : "cancel", x: point.x, y: point.y,
        button: mouse.button, buttons: 0, clicks: mouse.clicks, modifiers: modifiers(event) });
      if (event.type !== "pointerup") click.at = -1000;
      mouse = undefined;
      this.stage.focus({ preventScroll: true });
    };
    this.stage.addEventListener("pointerup", end);
    this.stage.addEventListener("pointercancel", end);
    this.stage.addEventListener("lostpointercapture", end);
    this.stage.addEventListener("contextmenu", event => event.preventDefault());
    this.stage.addEventListener("wheel", event => {
      event.preventDefault();
      const point = this.point(event.clientX, event.clientY);
      if (!point) return;
      const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? this.frame.height : 1;
      this.send({ type: "scroll", x: point.x, y: point.y, deltaX: event.deltaX * unit / point.scale, deltaY: event.deltaY * unit / point.scale });
    }, { passive: false });
    this.stage.addEventListener("keydown", event => {
      if (event.isComposing || event.altKey) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() !== "a") return;
      if (event.key === "Escape") { event.preventDefault(); this.close(); return; }
      const primary = event.metaKey || event.ctrlKey, key = event.key === " " ? "Space" : primary ? event.key.toLowerCase() : event.key;
      const base = specialKeys.has(event.key) ? event.key : key;
      if (specialKeys.has(base) || (primary && base === "a")) {
        event.preventDefault(); this.flushText();
        this.send({ type: "key", key: `${primary ? "ControlOrMeta+" : ""}${event.shiftKey ? "Shift+" : ""}${base}` });
        return;
      }
      if (primary || event.altKey) return;
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
    const tail = this.outbox.at(-1);
    if (tail?.type === "touch" && input.type === "touch" && tail.events.length + input.events.length <= gestureLimit) tail.events.push(...input.events);
    else if (tail?.type === "scroll" && input.type === "scroll") Object.assign(tail, { x: input.x, y: input.y, deltaX: tail.deltaX + input.deltaX, deltaY: tail.deltaY + input.deltaY });
    else if (tail?.type === "mouse" && input.type === "mouse" && tail.kind === "move" && input.kind === "move" && tail.buttons === input.buttons && tail.modifiers === input.modifiers)
      Object.assign(tail, input);
    else this.outbox.push(input);
    void this.pump();
  }

  private async pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.outbox.length && !this.gone && !this.closed) {
        const input = this.outbox.shift()!, id = this.id;
        await api(`/api/pages/${encodeURIComponent(id)}/input`, { method: "POST", json: input.type === "touch" ? { ...input, sentAt: performance.now() } : input }).catch(error => {
          if (error instanceof APIError && error.status === 404) this.markGone(); else failed(error);
        });
      }
    } finally { this.pumping = false; }
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

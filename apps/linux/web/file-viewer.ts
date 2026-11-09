import { api, ask, formDialog, sheet } from "./client";
import { highlight } from "./code";
import { h, icon } from "./dom";
import { hostText, t } from "./i18n";
import { markdown, type Resolve } from "./markdown";
import { zoomable } from "./mermaid";

export type FileKind = "image" | "video" | "audio" | "page" | "markdown" | "code" | "other";
type Entry = { name: string; size: number; modified: number };
type PageEvents = { height?: (value: number) => void; unavailable: () => void; left: () => void; escape?: () => void };
type FrameEvents = PageEvents & { pong: (value: number) => void };

export const fileURL = (path: string, download = false) => `/api/files/content?path=${encodeURIComponent(path)}${download ? "&download=1" : ""}`;
export const pageURL = (path: string) => `/api/files/page?path=${encodeURIComponent(path)}`;
const frameURL = (path: string, version: string) => `/api/files/frame?path=${encodeURIComponent(path)}${version ? `&v=${encodeURIComponent(version)}` : ""}`;
const images = /\.(png|jpe?g|gif|webp|svg)$/i, videos = /\.(mp4|webm|mov)$/i, audios = /\.(mp3|wav|m4a|aac|ogg|opus|flac)$/i, pages = /\.html?$/i;
const languages: Record<string, string> = { json: "json", py: "python", sh: "bash", bash: "bash", zsh: "bash", swift: "swift", js: "javascript", mjs: "javascript",
  cjs: "javascript", ts: "javascript", tsx: "javascript", jsx: "javascript" };
const plain = new Set(["txt", "csv", "log", "xml", "yaml", "yml", "toml", "ini", "css", "sql", "go", "rs", "java", "c", "h", "cpp", "rb", "env", "tsv"]);
const textLimit = 1024 * 1024;
const pageHeight = 720, answerWait = 3_000;
const shown = new Set<HTMLIFrameElement>();
const handlers = new WeakMap<HTMLIFrameElement, FrameEvents>();

window.addEventListener("message", event => {
  if (!event.source) return;
  for (const frame of shown) {
    const events = handlers.get(frame);
    if (!events || frame.contentWindow !== event.source) continue;
    const data = event.data as { type?: unknown; height?: unknown; unavailable?: unknown; key?: unknown; pong?: unknown } | null;
    if (data?.type !== "ox-page") return;
    if (typeof data.height === "number" && Number.isFinite(data.height)) events.height?.(Math.min(pageHeight, Math.max(0, Math.ceil(data.height))));
    else if (typeof data.unavailable === "string") events.unavailable();
    else if (typeof data.pong === "number") events.pong(data.pong);
    else if (data.key === "Escape") events.escape?.();
    return;
  }
});

function pageFrame(path: string, version: string, title: string, events: PageEvents, lazy = false) {
  const frame = h("iframe", { className: "canvas-frame", sandbox: "allow-scripts allow-popups allow-popups-to-escape-sandbox", referrerpolicy: "no-referrer",
    loading: lazy ? "lazy" : null, title, src: frameURL(path, version), "data-testid": "canvas-frame" });
  let loads = 0, answered = 0;
  frame.addEventListener("load", () => {
    const ping = ++loads;
    frame.contentWindow?.postMessage({ type: "ox-page", ping }, "*");
    setTimeout(() => { if (answered < ping && shown.has(frame)) (ping === 1 ? events.unavailable : events.left)(); }, answerWait);
  });
  handlers.set(frame, { ...events, pong: value => { answered = Math.max(answered, value); } });
  shown.add(frame);
  return frame;
}
const dropFrame = (frame: HTMLIFrameElement | undefined) => { if (!frame) return; shown.delete(frame); frame.remove(); };
const placeholder = (message: string, loading: boolean) => h("div", { className: "canvas-placeholder", "data-testid": "canvas-placeholder" },
  loading ? h("span", { className: "spinner", "aria-hidden": "true" }) : icon("globe", 28), h("span", {}, message));

const cards = new Set<CanvasCard>();
let checkQueued = false;
let changeTimer: ReturnType<typeof setTimeout> | undefined;
async function checkCards() {
  const folders = new Map<string, CanvasCard[]>();
  for (const card of cards) folders.set(card.folder, [...(folders.get(card.folder) ?? []), card]);
  await Promise.all([...folders].map(async ([folder, list]) => {
    const entries = await api<{ entries: Entry[] }>(`/api/files?path=${encodeURIComponent(folder)}`).then(result => result.entries, () => null);
    for (const card of list) if (card.isConnected) card.update(entries);
  }));
}
function checkSoon() {
  if (checkQueued) return;
  checkQueued = true;
  setTimeout(() => { checkQueued = false; void checkCards(); }, 0);
}
window.addEventListener("ox-files", () => { clearTimeout(changeTimer); changeTimer = setTimeout(() => void checkCards(), 400); });

class CanvasCard extends HTMLElement {
  private surface: HTMLDivElement | undefined;
  private frame: HTMLIFrameElement | undefined;
  private version: string | null = null;
  private gone = false;
  private readonly events: PageEvents = {
    height: value => {
      if (!this.surface) return;
      this.surface.classList.remove("loading");
      this.surface.style.height = `${value}px`;
      this.surface.querySelector(".canvas-placeholder")?.remove();
    },
    unavailable: () => this.fail(t("pageUnavailable")),
    left: () => this.fail(t("pageLeft")),
  };
  get path() { return this.dataset.path ?? ""; }
  get folder() { return this.path.split("/").slice(0, -1).join("/"); }
  private get name() { return this.path.split("/").at(-1) ?? this.path; }

  connectedCallback() {
    if (this.frame) shown.add(this.frame);
    cards.add(this);
    if (this.version === null) { this.show(); checkSoon(); }
  }
  disconnectedCallback() {
    cards.delete(this);
    if (this.frame) shown.delete(this.frame);
  }
  update(entries: Entry[] | null) {
    const entry = entries?.find(item => item.name === this.name);
    if (entries && !entry) { this.markDeleted(); return; }
    if (!entry && this.version !== null) return;
    const version = entry ? `${entry.size}:${entry.modified}` : "";
    if (version !== this.version || this.gone) this.load(version);
  }
  private show() {
    if (this.surface && !this.gone) return;
    this.gone = false;
    this.surface = h("div", { className: "canvas-surface loading", "data-testid": "canvas-surface" }, placeholder(t("loadingHTML"), true));
    this.replaceChildren(this.surface, h("button", { type: "button", className: "canvas-name", "data-testid": "canvas-name", onclick: () => openFile(this.path) }, this.name));
  }
  private load(version: string) {
    this.show();
    const surface = this.surface!;
    if (this.frame) shown.delete(this.frame);
    this.version = version;
    this.frame = pageFrame(this.path, version, this.dataset.title || this.name, this.events, true);
    surface.className = "canvas-surface loading";
    surface.style.height = "";
    surface.replaceChildren(this.frame, placeholder(t("loadingHTML"), true));
  }
  private fail(message: string) {
    if (!this.surface) return;
    dropFrame(this.frame);
    this.frame = undefined;
    this.surface.className = "canvas-surface failed";
    this.surface.style.height = "";
    this.surface.replaceChildren(placeholder(message, false));
  }
  private markDeleted() {
    if (this.gone) return;
    dropFrame(this.frame);
    this.frame = undefined;
    this.gone = true;
    this.version = null;
    this.replaceChildren(h("span", { className: "canvas-removed", "data-testid": "canvas-removed" }, icon("globe", 18), h("del", {}, this.name),
      h("span", { className: "visually-hidden" }, t("deletedFile"))));
  }
}
if (!customElements.get("ox-canvas")) customElements.define("ox-canvas", CanvasCard);

export function canvasCard(path: string, title: string) {
  const card = document.createElement("ox-canvas");
  card.className = "canvas-card";
  card.dataset.live = `canvas:${path}`;
  card.dataset.path = path;
  if (title) card.dataset.title = title;
  return card;
}

const extension = (path: string) => /\.([^./]+)$/.exec(path)?.[1]?.toLowerCase() ?? "";
export function fileKind(path: string): FileKind {
  if (images.test(path)) return "image";
  if (videos.test(path)) return "video";
  if (audios.test(path)) return "audio";
  if (pages.test(path)) return "page";
  if (/\.(md|markdown)$/i.test(path)) return "markdown";
  const ext = extension(path);
  return ext in languages || plain.has(ext) ? "code" : "other";
}

function normalize(path: string) {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") { if (!parts.length) return ""; parts.pop(); } else parts.push(part);
  }
  return parts.join("/");
}

function resolverFor(folder: string): Resolve {
  return target => {
    if (/^(https?:|mailto:)/i.test(target)) return { href: target, file: false, image: false };
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//") || target.startsWith("#")) return undefined;
    let clean = target.split(/[?#]/)[0]!;
    try { clean = decodeURI(clean); } catch {}
    const path = normalize(clean.startsWith("/") ? clean : `${folder}/${clean}`);
    if (!path) return undefined;
    return { href: fileURL(path), file: true, image: images.test(path), media: audios.test(path) ? "audio" : videos.test(path) ? "video" : undefined,
      embed: pages.test(path) ? (title: string) => canvasCard(path, title) : undefined };
  };
}

const size = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

async function text(path: string) {
  const response = await fetch(fileURL(path), { credentials: "same-origin" });
  if (!response.ok) throw new Error(((await response.json().catch(() => null)) as { error?: string } | null)?.error ?? response.statusText);
  return response.text();
}

export function openFile(path: string) {
  const kind = fileKind(path);
  const name = path.split("/").at(-1) ?? path;
  const folder = path.split("/").slice(0, -1).join("/");
  let editing: { previous: string; baseline: string; crlf: boolean; editor: HTMLTextAreaElement } | null = null;
  let signature = "";
  let page: HTMLIFrameElement | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const dirty = () => !!editing && editing.editor.value !== editing.baseline;
  const changed = () => { clearTimeout(timer); timer = setTimeout(() => void refresh(), 400); };
  const view = sheet({ testID: "file-viewer", className: "file-viewer", label: name,
    onClose: () => { clearTimeout(timer); window.removeEventListener("ox-files", changed); dropFrame(page); page = undefined; },
    canClose: async () => !dirty() || await ask({ title: t("discardChanges"), message: t("discardChangesBody"), confirm: t("discard"), destructive: true }) === "confirm" });
  const body = h("div", { className: "file-body", "data-testid": "file-body" });
  const actions = h("div", { className: "file-actions" });
  view.dialog.append(body, h("div", { className: "file-bar" },
    h("button", { type: "button", className: "icon-button outlined", "aria-label": t("close"), title: t("close"), "data-testid": "file-close", onclick: () => void view.attempt() }, icon("close", 20)),
    h("span", { className: "file-title", title: path, "data-testid": "file-title" }, name), actions));
  const downloadLink = () => h("a", { href: fileURL(path, true), download: name, className: "icon-button outlined", "aria-label": t("download"), title: t("download"),
    "data-testid": "file-download" }, icon("download", 20));
  const newTabLink = () => h("a", { href: `/#/file/${path.split("/").map(encodeURIComponent).join("/")}`, target: "_blank", rel: "noopener noreferrer", className: "icon-button outlined", "aria-label": t("openInNewTab"),
    title: t("openInNewTab"), "data-testid": "file-new-tab", "data-new-tab": "true" }, icon("external", 20));
  const entry = async () => (await api<{ entries: Entry[] }>(`/api/files?path=${encodeURIComponent(folder)}`)).entries.find(item => item.name === name);
  const unavailable = (error: unknown) => {
    dropFrame(page);
    page = undefined;
    actions.replaceChildren();
    body.replaceChildren(h("div", { className: "file-card", "data-testid": "file-unavailable" }, icon("warning", 32), h("strong", {}, t("fileUnavailable")),
      h("p", {}, hostText(error instanceof Error ? error.message : String(error)))));
  };
  const card = (found: Entry | undefined, note = "", open = true) => {
    dropFrame(page);
    page = undefined;
    actions.replaceChildren(downloadLink());
    body.replaceChildren(h("div", { className: "file-card", "data-testid": "file-card" }, icon("file", 40), h("strong", {}, name),
      found ? h("p", {}, size(found.size)) : null, note ? h("p", {}, note) : null,
      h("div", { className: "file-card-actions" },
        open && h("a", { href: kind === "page" ? pageURL(path) : fileURL(path), target: "_blank", rel: "noopener noreferrer", className: "button secondary", "data-testid": "file-open",
          "data-new-tab": "true" }, t("open")),
        h("a", { href: fileURL(path, true), download: name, className: "button primary", "data-testid": "file-card-download" }, t("download")))));
  };
  const showMarkdown = (source: string) => {
    editing = null;
    const edit = h("button", { type: "button", className: "button secondary file-edit", "data-testid": "file-edit", onclick: () => startEditing(source) }, t("edit"));
    actions.replaceChildren(edit, downloadLink());
    body.replaceChildren(h("div", { className: "file-document" }, h("div", { className: "markdown", "data-testid": "file-markdown" }, markdown(source, resolverFor(folder), t("copyCode")))));
  };
  const startEditing = (source: string) => {
    const editor: HTMLTextAreaElement = h("textarea", { className: "file-editor", "aria-label": name, spellcheck: "false", "data-testid": "file-editor" });
    editor.value = source;
    editing = { previous: source, baseline: editor.value, crlf: source.includes("\r\n"), editor };
    let saving = false;
    const save: HTMLButtonElement = h("button", { type: "button", className: "button primary file-save", "data-testid": "file-save", onclick: async () => {
      if (saving || !editing) return;
      if (!dirty()) { showMarkdown(editing.previous); void refresh().catch(unavailable); return; }
      saving = true;
      save.disabled = true;
      const saved = editing.crlf ? editor.value.replace(/\r?\n/g, "\r\n") : editor.value;
      try {
        await api("/api/files/text", { method: "PUT", json: { path, text: saved, previous: editing.previous } });
        const entryNow = await entry().catch(() => undefined);
        signature = entryNow ? `${entryNow.size}:${entryNow.modified}` : signature;
        showMarkdown(saved);
      } catch (error) {
        await formDialog({ title: t("saveFailed"), message: hostText(error instanceof Error ? error.message : String(error)), confirm: t("ok"), cancel: false, testID: "file-save-failed" });
      }
      finally { saving = false; save.disabled = false; }
    } }, t("save"));
    actions.replaceChildren(save);
    body.replaceChildren(h("div", { className: "file-document editing" }, editor));
    editor.focus();
  };
  const load = async () => {
    const found = await entry().catch(() => undefined);
    const current = found ? `${found.size}:${found.modified}` : "";
    if (kind === "image") {
      signature = current;
      const image = h("img", { src: `${fileURL(path)}&v=${encodeURIComponent(current)}`, alt: name, draggable: "false", "data-testid": "file-image" });
      const stage = h("div", { className: "diagram-stage file-stage", tabindex: "0", role: "group", "aria-label": name, "data-testid": "file-stage" }, image);
      actions.replaceChildren(downloadLink());
      body.replaceChildren(stage);
      image.addEventListener("load", () => zoomable(stage, image, image.naturalWidth || 1200, image.naturalHeight || 900), { once: true });
      image.addEventListener("error", () => unavailable(new Error(t("fileUnavailable"))), { once: true });
      return;
    }
    if (kind === "video" || kind === "audio") {
      signature = current;
      actions.replaceChildren(downloadLink());
      body.replaceChildren(h("div", { className: "file-media" }, h(kind, { controls: true, preload: "metadata", src: fileURL(path), "aria-label": name, "data-testid": `file-${kind}`,
        ...(kind === "video" ? { playsinline: true } : {}) })));
      return;
    }
    if (kind === "page") {
      signature = current;
      dropFrame(page);
      page = pageFrame(path, current, name, { unavailable: () => found ? card(found, t("pageUnavailable")) : unavailable(new Error(t("fileUnavailable"))),
        left: () => card(found, t("pageLeft"), false), escape: () => void view.attempt() });
      actions.replaceChildren(newTabLink(), downloadLink());
      body.replaceChildren(h("div", { className: "file-page" }, page));
      return;
    }
    if (kind === "other" || (found && found.size > textLimit)) { signature = current; card(found, kind === "other" ? "" : t("fileTooLarge")); return; }
    const source = await text(path);
    if (!view.open() || editing) return;
    signature = current;
    if (kind === "markdown") { showMarkdown(source); return; }
    actions.replaceChildren(downloadLink());
    body.replaceChildren(h("div", { className: "file-document" },
      h("pre", { className: "file-code", "data-testid": "file-code" }, h("code", {}, ...highlight(source, languages[extension(path)] ?? "")))));
  };
  const refresh = async () => {
    if (!view.open() || editing || kind === "other") return;
    const found = await entry().catch(() => undefined);
    if (found && `${found.size}:${found.modified}` !== signature) await load().catch(unavailable);
  };
  window.addEventListener("ox-files", changed);
  void load().catch(unavailable);
}

import { api, ask, formDialog, sheet } from "./client";
import { highlight } from "./code";
import { h, icon, type IconName } from "./dom";
import { hostText, t } from "./i18n";
import { markdown, type Resolve } from "./markdown";
import { approvalCard } from "./prompts";
import { zoomable } from "./mermaid";

export type FileKind = "image" | "video" | "audio" | "page" | "markdown" | "code" | "other";
type Entry = { name: string; size: number; modified: number };
type PageEvents = { height?: (value: number) => void; unavailable: () => void; left: () => void; escape?: () => void; questions?: Questions };
type CallRequest = { doc?: unknown; id?: unknown; function?: unknown; arguments?: unknown };
type CallResult = { ok: true; value: unknown } | { ok: false; error: unknown };
type PageInteraction = { id: string; kind: "approval"; title: string; body: string; detail?: string; options: string[] };
type CallOutcome = CallResult | { interaction: PageInteraction };
type FrameEvents = PageEvents & { pong: (value: number) => void; call: (request: CallRequest) => void };
type PageSession = { id: string; used: boolean; epoch: number; waiting: number; tail: Promise<unknown> };

export const fileURL = (path: string, download = false) => `/api/files/content?path=${encodeURIComponent(path)}${download ? "&download=1" : ""}`;
export const pageURL = (path: string) => `/api/files/page?path=${encodeURIComponent(path)}`;
const frameURL = (path: string, version: string) => `/api/files/frame?path=${encodeURIComponent(path)}${version ? `&v=${encodeURIComponent(version)}` : ""}`;
const images = /\.(png|jpe?g|gif|webp|svg)$/i, videos = /\.(mp4|webm|mov)$/i, audios = /\.(mp3|wav|m4a|aac|ogg|opus|flac)$/i, pages = /\.html?$/i;
const languages: Record<string, string> = { json: "json", py: "python", sh: "bash", bash: "bash", zsh: "bash", swift: "swift", js: "javascript", mjs: "javascript",
  cjs: "javascript", ts: "javascript", tsx: "javascript", jsx: "javascript" };
const plain = new Set(["txt", "csv", "log", "xml", "yaml", "yml", "toml", "ini", "css", "sql", "go", "rs", "java", "c", "h", "cpp", "rb", "env", "tsv"]);
const textLimit = 1024 * 1024;
const pageHeight = 720, answerWait = 3_000, callLimit = 16, callSlots = 2;
const shown = new Set<HTMLIFrameElement>();
const handlers = new WeakMap<HTMLIFrameElement, FrameEvents>();
const sessions = new WeakMap<HTMLIFrameElement, PageSession>();
const askers = new WeakMap<HTMLIFrameElement, Questions>();
const sessionID = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("");

window.addEventListener("message", event => {
  if (!event.source) return;
  for (const frame of shown) {
    const events = handlers.get(frame);
    if (!events || frame.contentWindow !== event.source) continue;
    const data = event.data as { type?: unknown; height?: unknown; unavailable?: unknown; key?: unknown; pong?: unknown } | null;
    if (data?.type === "ox-call") { events.call(data as CallRequest); return; }
    if (data?.type !== "ox-page") return;
    if (typeof data.height === "number" && Number.isFinite(data.height)) events.height?.(Math.min(pageHeight, Math.max(0, Math.ceil(data.height))));
    else if (typeof data.unavailable === "string") events.unavailable();
    else if (typeof data.pong === "number") events.pong(data.pong);
    else if (data.key === "Escape") events.escape?.();
    return;
  }
});

let callsActive = 0;
const callQueue: (() => void)[] = [];
const acquire = () => callsActive < callSlots ? (callsActive += 1, Promise.resolve()) : new Promise<void>(resolve => callQueue.push(resolve));
function release() {
  const next = callQueue.shift();
  if (next) next(); else callsActive -= 1;
}

class Questions {
  readonly element = h("div", { className: "canvas-questions", "data-testid": "page-questions" });
  private waiting?: (reply: string | null) => void;
  ask(interaction: PageInteraction) {
    this.clear();
    return new Promise<string | null>(resolve => {
      this.waiting = resolve;
      this.element.replaceChildren(approvalCard({ type: "prompt", promptKind: "approval", prompt: interaction.body, options: interaction.options, promptId: interaction.id,
        title: interaction.title, detail: interaction.detail }, { conversationId: null, pending: true, answered: () => {}, openPage: () => {}, isOpen: () => false,
        send: async body => { this.settle(typeof body.answer === "string" ? body.answer : null); } }));
    });
  }
  clear() { this.settle(null); }
  private settle(reply: string | null) {
    const waiting = this.waiting;
    this.waiting = undefined;
    this.element.replaceChildren();
    waiting?.(reply);
  }
}

async function streamed(url: string, body: unknown): Promise<CallOutcome> {
  const response = await fetch(url, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const text = await response.text();
  if (!response.ok) {
    let message: string | undefined;
    try { message = (JSON.parse(text) as { error?: string }).error; } catch { message = undefined; }
    return { ok: false, error: { code: response.status === 429 ? "rate_limited" : "failed", message: message ?? `${t("error")} (${response.status})`, recovery: "" } };
  }
  return JSON.parse(text.trim().split("\n").at(-1) ?? "") as CallOutcome;
}
const closeSession = (id: string) => void fetch("/api/canvas/close", { method: "POST", credentials: "same-origin", keepalive: true, headers: { "content-type": "application/json" },
  body: JSON.stringify({ session: id }) }).catch(() => {});

function pageFrame(path: string, version: string, title: string, events: PageEvents, lazy = false) {
  const frame = h("iframe", { className: "canvas-frame", sandbox: "allow-scripts allow-popups allow-popups-to-escape-sandbox", referrerpolicy: "no-referrer",
    loading: lazy ? "lazy" : null, title, src: frameURL(path, version), "data-testid": "canvas-frame" });
  let loads = 0, answered = 0;
  frame.addEventListener("load", () => {
    const ping = ++loads;
    frame.contentWindow?.postMessage({ type: "ox-page", ping }, "*");
    setTimeout(() => { if (answered < ping && shown.has(frame)) (ping === 1 ? events.unavailable : events.left)(); }, answerWait);
  });
  const session: PageSession = { id: sessionID(), used: false, epoch: 0, waiting: 0, tail: Promise.resolve() };
  sessions.set(frame, session);
  const call: FrameEvents["call"] = request => {
    const { doc, id, function: name } = request;
    if (typeof id !== "number" || typeof name !== "string" || typeof doc !== "string") return;
    const reply = (result: CallResult) => frame.contentWindow?.postMessage({ type: "ox-result", doc, id, ...result }, "*");
    if (session.waiting >= callLimit) {
      reply({ ok: false, error: { code: "rate_limited", message: "HTML service call limit reached; wait before retrying", recovery: "Wait for earlier calls to finish." } });
      return;
    }
    const epoch = session.epoch;
    const closed: CallResult = { ok: false, error: { code: "cancelled", message: "The page closed before the call finished", recovery: "" } };
    session.waiting += 1;
    const run = session.tail.then(async (): Promise<CallResult> => {
      await acquire();
      let holding = true;
      const sent = session.id;
      try {
        if (epoch !== session.epoch) return closed;
        session.used = true;
        let outcome = await streamed("/api/canvas/call", { session: sent, path, function: name, arguments: request.arguments ?? {} });
        while ("interaction" in outcome) {
          const { interaction } = outcome;
          release();
          holding = false;
          if (epoch !== session.epoch) return closed;
          const reply = events.questions ? await events.questions.ask(interaction) : null;
          await acquire();
          holding = true;
          if (epoch !== session.epoch) return closed;
          outcome = await streamed("/api/canvas/answer", { session: sent, interaction: interaction.id, ...(reply === null ? { cancel: true } : { answer: reply }) });
        }
        return outcome;
      } catch (error) {
        if (session.id === sent) { session.id = sessionID(); session.used = false; closeSession(sent); }
        return { ok: false, error: { code: "unavailable", message: error instanceof Error ? error.message : String(error), recovery: "Try again." } };
      } finally { if (holding) release(); }
    });
    session.tail = run;
    void run.then(result => { session.waiting -= 1; if (epoch === session.epoch) reply(result); });
  };
  handlers.set(frame, { ...events, pong: value => { answered = Math.max(answered, value); }, call });
  if (events.questions) askers.set(frame, events.questions);
  shown.add(frame);
  return frame;
}
function retire(frame: HTMLIFrameElement | undefined) {
  if (!frame) return;
  shown.delete(frame);
  const session = sessions.get(frame);
  if (!session) return;
  session.epoch += 1;
  askers.get(frame)?.clear();
  if (!session.used) return;
  const closed = session.id;
  session.used = false;
  session.id = sessionID();
  closeSession(closed);
}
const dropFrame = (frame: HTMLIFrameElement | undefined) => { if (!frame) return; retire(frame); frame.remove(); };
const placeholder = (message: string, loading: boolean) => h("div", { className: "canvas-placeholder", "data-testid": "canvas-placeholder" },
  loading ? h("span", { className: "spinner", "aria-hidden": "true" }) : icon("globe", 28), h("span", {}, message));

const cards = new Set<Embed>();
let checkQueued = false;
let changeTimer: ReturnType<typeof setTimeout> | undefined;
async function checkCards() {
  const folders = new Map<string, Embed[]>();
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

abstract class Embed extends HTMLElement {
  protected version: string | null = null;
  protected gone = false;
  get path() { return this.dataset.path ?? ""; }
  get folder() { return this.path.split("/").slice(0, -1).join("/"); }
  protected get name() { return this.path.split("/").at(-1) ?? this.path; }
  protected abstract show(): void;
  protected abstract load(version: string): void;
  protected release() {}

  connectedCallback() {
    cards.add(this);
    if (this.version === null) { this.show(); checkSoon(); }
  }
  disconnectedCallback() { cards.delete(this); }
  update(entries: Entry[] | null) {
    const entry = entries?.find(item => item.name === this.name);
    if (entries && !entry) { this.markDeleted(); return; }
    if (!entry && this.version !== null) return;
    const version = entry ? `${entry.size}:${entry.modified}` : "";
    if (version !== this.version || this.gone) this.load(version);
  }
  private markDeleted() {
    if (this.gone) return;
    this.release();
    this.gone = true;
    this.version = null;
    this.replaceChildren(h("span", { className: "embed-removed", "data-testid": "embed-removed" }, icon(fileIcon(this.path), 18), h("del", {}, this.name),
      h("span", { className: "visually-hidden" }, t("deletedFile"))));
  }
}

class CanvasCard extends Embed {
  private surface: HTMLDivElement | undefined;
  private frame: HTMLIFrameElement | undefined;
  private readonly questions = new Questions();
  private readonly events: PageEvents = {
    questions: this.questions,
    height: value => {
      if (!this.surface) return;
      this.surface.classList.remove("loading");
      this.surface.style.height = `${value}px`;
      this.surface.querySelector(".canvas-placeholder")?.remove();
    },
    unavailable: () => this.fail(t("pageUnavailable")),
    left: () => this.fail(t("pageLeft")),
  };

  connectedCallback() {
    if (this.frame) shown.add(this.frame);
    super.connectedCallback();
  }
  disconnectedCallback() {
    super.disconnectedCallback();
    retire(this.frame);
  }
  protected show() {
    if (this.surface && !this.gone) return;
    this.gone = false;
    this.surface = h("div", { className: "canvas-surface loading", "data-testid": "canvas-surface" }, placeholder(t("loadingHTML"), true));
    this.replaceChildren(this.surface, this.questions.element,
      h("button", { type: "button", className: "canvas-name", "data-testid": "canvas-name", onclick: () => openFile(this.path) }, this.name));
  }
  protected load(version: string) {
    this.show();
    const surface = this.surface!;
    retire(this.frame);
    this.version = version;
    this.frame = pageFrame(this.path, version, this.dataset.title || this.name, this.events, true);
    surface.className = "canvas-surface loading";
    surface.style.height = "";
    surface.replaceChildren(this.frame, placeholder(t("loadingHTML"), true));
  }
  protected release() {
    dropFrame(this.frame);
    this.frame = undefined;
  }
  private fail(message: string) {
    if (!this.surface) return;
    this.release();
    this.surface.className = "canvas-surface failed";
    this.surface.style.height = "";
    this.surface.replaceChildren(placeholder(message, false));
  }
}

type CardFormat = "markdown" | "text" | "table" | "icon" | "name";
function cardFormat(path: string): CardFormat {
  if (/\.(md|markdown)$/i.test(path)) return "markdown";
  if (/\.(csv|tsv)$/i.test(path)) return "table";
  if (/\.(pdf|xlsx|xls|ods|numbers)$/i.test(path)) return "icon";
  const ext = extension(path);
  return ext in languages || plain.has(ext) ? "text" : "name";
}
function tableRows(source: string, separator: string) {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  for (let index = 0; index < source.length && rows.length < 5; index++) {
    const character = source[index]!;
    if (character === "\"") {
      if (quoted && source[index + 1] === "\"") { cell += "\""; index += 1; } else quoted = !quoted;
    } else if (!quoted && character === separator) { row.push(cell); cell = ""; }
    else if (!quoted && character === "\n") { row.push(cell); rows.push(row.slice(0, 3)); row = []; cell = ""; }
    else if (character !== "\r") cell += character;
  }
  if (rows.length < 5 && (cell || row.length)) { row.push(cell); rows.push(row.slice(0, 3)); }
  const columns = Math.max(1, ...rows.map(item => item.length));
  return rows.map(item => [...item, ...Array<string>(columns - item.length).fill("")]);
}
function cardPreview(format: CardFormat, source: string, path: string): Node {
  if (format === "markdown") {
    const rendered = h("div", { className: "markdown" }, markdown(source, () => undefined, ""));
    for (const button of rendered.querySelectorAll("button")) button.remove();
    for (const block of rendered.querySelectorAll("[data-mermaid]")) block.removeAttribute("data-mermaid");
    return rendered;
  }
  if (format === "table") {
    return h("table", {}, h("tbody", {}, tableRows(source, /\.tsv$/i.test(path) ? "\t" : ",").map((row, index) => h("tr", {}, row.map(cell => h(index ? "td" : "th", {}, cell))))));
  }
  return h("pre", {}, source.split("\n").slice(0, 8).join("\n"));
}

class FileCard extends Embed {
  private link: HTMLAnchorElement | undefined;
  private preview: HTMLElement | undefined;
  private request = 0;

  protected show() {
    if (this.link && !this.gone) return;
    this.gone = false;
    const format = cardFormat(this.path);
    this.preview = format === "name" ? undefined : h("span", { className: `file-embed-preview file-embed-${format === "icon" ? "icon" : "loading"}`, "aria-hidden": "true", inert: true,
      "data-testid": "file-embed-preview" }, format === "icon" ? icon(fileIcon(this.path), 32) : h("span", { className: "spinner" }));
    this.link = h("a", { href: fileURL(this.path), className: "file-embed", title: this.dataset.title || this.name, "data-testid": "file-embed" },
      this.preview ?? null, h("span", { className: "file-embed-name" }, this.name));
    this.replaceChildren(this.link);
  }
  protected load(version: string) {
    this.show();
    this.version = version;
    const format = cardFormat(this.path), preview = this.preview;
    if (!preview || format === "icon" || format === "name") return;
    const request = ++this.request;
    void fetch(fileURL(this.path), { credentials: "same-origin", headers: { range: "bytes=0-8191" } })
      .then(response => response.ok ? response.arrayBuffer() : Promise.reject(new Error(response.statusText)))
      .then(buffer => {
        if (request !== this.request) return;
        preview.className = `file-embed-preview file-embed-${format}`;
        preview.replaceChildren(cardPreview(format, new TextDecoder().decode(buffer).slice(0, 2000), this.path));
      })
      .catch(() => {
        if (request !== this.request) return;
        preview.className = "file-embed-preview file-embed-icon";
        preview.replaceChildren(icon(fileIcon(this.path), 32));
      });
  }
  protected release() { this.request += 1; }
}
if (!customElements.get("ox-canvas")) customElements.define("ox-canvas", CanvasCard);
if (!customElements.get("ox-file-card")) customElements.define("ox-file-card", FileCard);

export function fileIcon(path: string): IconName {
  if (images.test(path)) return "image";
  if (videos.test(path)) return "play";
  if (audios.test(path)) return "speaker";
  return pages.test(path) ? "globe" : "file";
}

export function fileEmbed(path: string, title: string) {
  const page = pages.test(path);
  const card = document.createElement(page ? "ox-canvas" : "ox-file-card");
  card.className = page ? "canvas-card" : "file-embed-card";
  card.dataset.live = `${page ? "canvas" : "file"}:${path}`;
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
      embed: (title: string) => fileEmbed(path, title) };
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
  const questions = new Questions();
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
        left: () => card(found, t("pageLeft"), false), escape: () => void view.attempt(), questions });
      actions.replaceChildren(newTabLink(), downloadLink());
      body.replaceChildren(h("div", { className: "file-page" }, page, questions.element));
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

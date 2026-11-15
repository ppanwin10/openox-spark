import type { DiscoveryItem, DiscoveryKind, GenerationView } from "@openox/agent/linux";
import { api, APIError, ask, clearInfoToasts, failed, menu, relativeTime, returnFocus, sheet, toast } from "./client";
import type { PageHost } from "./capabilities";
import { h, icon } from "./dom";
import { fileURL } from "./file-viewer";
import { hostText, t, type StringKey } from "./i18n";
import { markdown } from "./markdown";

type Prompt = { text: string; revision: number };
type Listing = { available: boolean; items: DiscoveryItem[]; prompt: Prompt | { revision: number }; total: number; nextCursor: string | null; generation: GenerationView | null };
export interface DiscoveryHost { discuss(item?: DiscoveryItem): void; openGeneration(id: number): void }
let generation = 0, timer: ReturnType<typeof setTimeout> | undefined;
let active: { context: PageHost; refresh(): void; busy(): boolean } | undefined;
const hidden = new Set<DiscoveryKind>();
const attempts = new Map<DiscoveryKind, { key: string; body: { expectedRevision: number; replaceUnknown?: boolean } }>();
const describe = (error: unknown) => error instanceof TypeError && error.message === "Failed to fetch" ? t("requestResultUnavailable") : hostText(error instanceof Error ? error.message : String(error));
export function closeDiscoveryView() { generation++; clearTimeout(timer); active = undefined; }
export function refreshDiscovery() {
  const view = active; clearTimeout(timer);
  if (view?.context.main.isConnected && !view.busy() && !document.querySelector("dialog[open]")) timer = setTimeout(() => {
    if (active === view && view.context.main.isConnected && !view.busy() && !document.querySelector("dialog[open]")) view.refresh();
  }, 100);
}

async function editPrompt(prompt: Prompt, saved: (prompt: Prompt) => void) {
  let source = prompt, saving = false, baseline = prompt.text;
  const field = h("textarea", { className: "field", rows: 7, maxlength: 2_000, required: true, "aria-label": t("feedPrompt"), "data-testid": "feed-prompt-input" });
  field.value = baseline;
  const dirty = () => field.value !== baseline;
  const beforeUnload = (event: BeforeUnloadEvent) => { if (dirty() || saving) { event.preventDefault(); event.returnValue = ""; } };
  window.addEventListener("beforeunload", beforeUnload);
  const view = sheet({ testID: "feed-prompt-editor", className: "todo-editor-sheet feed-prompt-editor", label: t("feedEditPrompt"),
    onClose: () => { window.removeEventListener("beforeunload", beforeUnload); refreshDiscovery(); },
    canClose: async () => !saving && (!dirty() || await ask({ title: t("discardChanges"), message: t("formCloseBody"), confirm: t("discard"), destructive: true }) === "confirm") });
  const progressLabel = h("span");
  const progress = h("p", { className: "dialog-progress muse-editor-progress", role: "status", hidden: true, "data-testid": "feed-prompt-progress" },
    h("span", { className: "spinner", "aria-hidden": "true" }), progressLabel);
  const error = h("p", { className: "form-error", hidden: true, role: "alert", "data-testid": "feed-prompt-error" });
  const lock = (value: boolean, loading = false) => {
    saving = value; view.dialog.setAttribute("aria-busy", String(value)); progress.hidden = !value; progressLabel.textContent = t(loading ? "personalLoading" : "personalSaving");
    view.dialog.querySelectorAll<HTMLButtonElement | HTMLTextAreaElement>("button,textarea").forEach(control => { control.disabled = value; });
  };
  const reload = h("button", { type: "button", className: "button secondary", hidden: true, "data-testid": "feed-prompt-reload", onclick: async () => {
    if (saving || dirty() && await ask({ title: t("todoReloadTitle"), message: t("feedReloadPrompt"), confirm: t("todoReload") }) !== "confirm") return;
    lock(true, true);
    try {
      const current = (await api<Listing>("/api/feed")).prompt;
      if (!("text" in current) || typeof current.text !== "string") throw new Error(t("personalDataInvalid"));
      source = current;
      saved(current);
      field.value = source.text; baseline = source.text; error.hidden = true; reload.hidden = true;
    } catch (failure) { error.textContent = describe(failure); error.hidden = false; }
    finally { lock(false); }
  } }, t("todoReload"));
  const form = h("form", { className: "todo-editor-form", onsubmit: async (event: Event) => {
    event.preventDefault(); if (saving) return;
    const text = field.value; clearInfoToasts(); lock(true); error.hidden = true; reload.hidden = true;
    try {
      const result = await api<Prompt>("/api/feed/prompt", { method: "PATCH", json: { expectedRevision: source.revision, text } });
      saved(result);
      baseline = text; view.close(); toast(t("saved"));
    } catch (failure) {
      error.textContent = failure instanceof TypeError ? t("feedPromptUnknown") : describe(failure); error.hidden = false;
      reload.hidden = !(failure instanceof TypeError || failure instanceof APIError && (failure.status === 409 || failure.status >= 500));
    } finally { lock(false); }
  } }, h("div", { className: "sheet-body" }, field, h("p", { className: "muted small" }, t("feedPromptScope"))), progress, error, reload,
    h("div", { className: "personal-form-actions" }, h("button", { type: "button", className: "button secondary", "data-testid": "feed-prompt-cancel",
      onclick: () => void view.attempt() }, t("cancel")), h("button", { type: "submit", className: "button primary", "data-testid": "feed-prompt-save" }, t("save"))));
  view.dialog.append(h("div", { className: "sheet-head" }, h("h2", { className: "sheet-title" }, t("feedEditPrompt")),
    h("button", { type: "button", className: "icon-button", "aria-label": t("close"), "data-testid": "feed-prompt-close", onclick: () => void view.attempt() }, icon("close"))), form);
  field.focus();
}

const statusNames: Record<GenerationView["status"], StringKey> = { preparing: "discoveryPreparing", running: "discoveryRunning", completed: "discoveryCompleted",
  noUpdate: "discoveryNoUpdate", incomplete: "discoveryIncomplete", failed: "discoveryFailed", cancelled: "discoveryCancelled",
  unknown: "discoveryUnknown", unavailable: "discoveryGenerationUnavailable" };
export function renderDiscovery(context: PageHost, kind: DiscoveryKind, id: string | null, host: DiscoveryHost) {
  const version = ++generation, here = () => version === generation && context.main.isConnected;
  let state: Listing | undefined, saving = false, dispatching = false, loading = false, issue = false, request = 0;
  const page = h("div", { className: "muse-discovery-page", "data-testid": `discovery-page-${kind}` });
  const content = h("div", { className: "muse-discovery-content" });
  const status = h("div", { className: "discovery-status", "aria-live": "polite" });
  const dispatchProgress = h("p", { className: "dialog-progress discovery-status", role: "status", hidden: true, "data-testid": "discovery-dispatch-progress" },
    h("span", { className: "spinner", "aria-hidden": "true" }), h("span", {}, t("discoveryDispatchPending")));
  const targetStatus = h("div", { className: "discovery-status", role: "status" });
  const list = h("div", { className: "discovery-list" }), continuation = h("div", { className: "discovery-continuation" });
  const title = h("header", { className: "muse-goals-title discovery-heading" }, h("h1", { "data-testid": "discovery-title" }, t(kind === "feed" ? "museFeed" : "museIdeas")));
  const prefix = kind === "feed" ? "/api/feed" : "/api/ideas";
  const toolbar = h("div", { className: "discovery-toolbar" });
  content.append(title, toolbar, dispatchProgress, status, targetStatus, list, continuation);
  page.append(h("button", { type: "button", className: "icon-button discovery-context-icon", "aria-label": t("discoveryOpenSide"),
    "data-testid": "discovery-context-open", onclick: () => host.discuss() }, icon("sidebar", 20)), content);
  context.main.replaceChildren(page);
  active = { context, refresh: () => void load(), busy: () => saving || issue };
  const error = (failure: unknown) => {
    issue = true;
    status.replaceChildren(h("p", { className: "form-error", role: "alert", "data-testid": "discovery-read-error" }, describe(failure)),
      h("button", { type: "button", className: "button secondary", "data-testid": "discovery-retry", onclick: () => void load() }, t("museRetry")));
  };
  const mutate = async (work: () => Promise<unknown>) => {
    if (saving) return;
    const focused = document.activeElement;
    clearInfoToasts(); saving = true; draw();
    try { await work(); if (here()) await load(); }
    catch (failure) { if (here()) error(failure); else failed(failure); }
    finally { saving = false; if (here()) { draw(); if (document.activeElement === document.body) returnFocus(focused); } }
  };
  const generate = async (replaceUnknown = false) => {
    if (!state || saving) return;
    clearInfoToasts();
    const previous = attempts.get(kind), current = state.generation;
    const restart = replaceUnknown || current?.status === "unknown" || !!previous && (previous.body.expectedRevision !== state.prompt.revision
      || !issue && !loading && !!current && !["preparing", "running"].includes(current.status));
    if (restart && await ask({ title: t("discoveryStartAgain"), message: t("discoveryAgainBody"), confirm: t("discoveryGenerate") }) !== "confirm") return;
    if (!here() || saving) return;
    if (restart) attempts.delete(kind);
    const attempt = attempts.get(kind) ?? { key: crypto.randomUUID(), body: { expectedRevision: state.prompt.revision, ...(restart ? { replaceUnknown: true } : {}) } };
    attempts.set(kind, attempt); saving = true; dispatching = true; draw();
    try {
      const result = await api<{ generation: GenerationView }>(`${prefix}/generate`, { method: "POST", headers: { "idempotency-key": attempt.key }, json: attempt.body });
      if (attempts.get(kind) === attempt) attempts.delete(kind);
      if (!here()) return;
      issue = false; status.replaceChildren(); state.generation = result.generation;
      if (result.generation.conversationId !== null) host.openGeneration(result.generation.conversationId);
      else if (here()) await load();
    } catch (failure) {
      if (here()) error(failure instanceof TypeError ? new Error(t("discoveryDispatchUnknown")) : failure); else failed(failure);
    } finally { saving = false; dispatching = false; if (here()) draw(); }
  };
  const menuButton = h("button", { type: "button", className: "icon-button muse-goals-menu", "aria-label": t("moreOptions"), "data-testid": "discovery-menu",
    onclick: () => {
      const last = state?.generation?.conversationId;
      const running = state?.generation && ["preparing", "running"].includes(state.generation.status);
      menu(menuButton, [
      { label: t(hidden.has(kind) ? "discoveryHideDismissed" : "discoveryShowDismissed"), icon: "eye", testID: "discovery-show-hidden",
        run: () => { if (hidden.has(kind)) hidden.delete(kind); else hidden.add(kind); void load(); } },
      ...(state && !saving && !loading && !running ? [{ label: t("discoveryGenerate"), icon: "spark" as const, testID: "discovery-generate-more", run: () => void generate() }] : []),
      ...(last !== null && last !== undefined ? [{
        label: t("discoveryOpenGeneration"), icon: "chat" as const, testID: "discovery-open-last",
        run: () => host.openGeneration(last),
      }] : []),
      { label: t("pageReload"), icon: "reload", testID: "discovery-refresh", run: () => void load() },
    ]); } }, icon("more"));
  title.append(menuButton);
  const draw = () => {
    if (!state) return;
    page.setAttribute("aria-busy", String(saving || loading));
    dispatchProgress.hidden = !dispatching;
    const focused = page.contains(document.activeElement) ? document.activeElement : null;
    const scroll = page.scrollTop, current = state.generation, running = current && ["preparing", "running"].includes(current.status);
    if (kind === "feed" && "text" in state.prompt) {
      const prompt = state.prompt;
      toolbar.replaceChildren(h("section", { className: "feed-prompt-card", "data-testid": "feed-prompt" }, h("h2", {}, t("feedYourPrompt")),
        h("p", { "data-testid": "feed-prompt-text" }, prompt.text), h("div", { className: "feed-prompt-actions" },
          h("button", { type: "button", className: "button secondary", "data-testid": "feed-prompt-edit", disabled: saving,
            onclick: () => void editPrompt(prompt, result => { if (state && here()) { request++; state.prompt = result; draw(); } }).catch(failed) }, icon("pencil", 16), t("edit")),
          h("button", { type: "button", className: "button primary", "data-testid": "feed-generate", disabled: saving || loading || !!running,
            onclick: () => void generate() }, t("discoveryGenerate")))));
    } else toolbar.replaceChildren(h("p", { className: "ideas-intro" }, t("ideasIntro")));
    list.replaceChildren(...state.items.map(item => {
      const body = h("div", { className: "markdown discovery-item-body" }, markdown(item.body,
        target => /^https?:\/\//i.test(target) ? { href: target, file: false, image: false } : undefined, t("copyCode")));
      const linked = new Set([...body.querySelectorAll<HTMLAnchorElement>("a[href]")].map(link => link.href));
      const sources = item.sources.filter(source => !linked.has(source.url));
      for (const link of body.querySelectorAll<HTMLAnchorElement>("a[href]")) if (item.sources.some(source => source.url === link.href)) link.title = t("discoverySourceNote");
      const options = h("button", { type: "button", className: "icon-button", "aria-label": `${t("moreOptions")}: ${item.name}`, "data-testid": `discovery-item-menu-${item.id}`,
        onclick: () => menu(options, [{ label: t(item.hidden ? "discoveryRestore" : "discoveryHide"), icon: item.hidden ? "reload" : "close",
          testID: item.hidden ? "discovery-restore" : "discovery-hide", run: () => mutate(() => api(`${prefix}/items/${item.id}`, { method: "PATCH",
            json: { expectedRevision: item.revision, hidden: !item.hidden } })) },
          { label: t(hidden.has(kind) ? "discoveryHideDismissed" : "discoveryShowDismissed"), icon: "eye", testID: "discovery-show-hidden",
            run: () => { if (hidden.has(kind)) hidden.delete(kind); else hidden.add(kind); void load(); } },
        ]) }, icon("more", 18));
      return h("article", { className: `discovery-item${item.hidden ? " hidden-item" : ""}`, "data-testid": `discovery-item-${item.id}` },
        h("span", { className: "discovery-item-icon", "aria-hidden": "true" }, item.icon),
        h("header", { className: "discovery-item-heading" }, h("h2", {}, item.name), h("small", {}, relativeTime(Date.parse(item.updatedAt))), options),
        body,
        sources.length ? h("div", { className: "discovery-sources" }, ...sources.map(source => h("a", { href: source.url, target: "_blank",
          rel: "noopener noreferrer", referrerpolicy: "no-referrer", title: t("discoverySourceNote") }, source.name))) : null,
        item.imagePath ? h("img", { src: fileURL(item.imagePath), alt: item.name, loading: "lazy", className: "discovery-image" }) : item.imageMissing ? h("p", { className: "muted small" }, t("discoveryImageMissing")) : null,
        h("div", { className: "discovery-item-actions" },
          kind === "feed" ? h("button", { type: "button", className: `icon-button discovery-love${item.loved ? " loved" : ""}`, "aria-pressed": String(item.loved),
            "aria-label": t("discoveryLove"), "data-testid": `feed-love-${item.id}`, disabled: saving, onclick: () => void mutate(() => api(`${prefix}/items/${item.id}`,
              { method: "PATCH", json: { expectedRevision: item.revision, loved: !item.loved } })) }, icon("heart", 20)) : null,
          h("button", { type: "button", className: "discovery-discuss", "data-testid": `discovery-discuss-${item.id}`, onclick: () => host.discuss(item) },
            icon("chat", 18), t(kind === "feed" ? "discoveryDiscuss" : "ideasAct"))),
        item.hidden ? h("small", { className: "muted" }, t("discoveryDismissed")) : null);
    }));
    if (!state.items.length) list.append(h("div", { className: "discovery-empty", "data-testid": "discovery-empty" },
      h("p", { className: "muted" }, t(kind === "feed" ? "feedEmpty" : "ideasEmpty")),
      kind === "ideas" ? h("button", { type: "button", className: "button primary", disabled: saving || loading || !!running, "data-testid": "ideas-generate",
        onclick: () => void generate() }, t("ideasFind")) : null));
    targetStatus.replaceChildren(...(id && !state.items.some(item => item.id === id) ? [
      h("p", { className: "muted", "data-testid": "discovery-source-unavailable" }, t(state.nextCursor ? "discoverySourceNotLoaded" : "discoverySourceUnavailable")),
      h("a", { href: `#/${kind}`, className: "personal-back", "data-testid": "discovery-source-back" }, icon("back", 16), t(kind === "feed" ? "museFeed" : "museIdeas")),
    ] : []));
    if (current && current.status !== "completed") {
      const stateLabel = h("div", { className: `discovery-generation ${current.status}`, "data-testid": "discovery-generation-status" }, h("span", {}, t(statusNames[current.status])),
        current.error ? h("p", { className: "form-error" }, hostText(current.error)) : null,
        current.conversationId !== null ? h("button", { type: "button", className: "button secondary", "data-testid": "discovery-generation-open",
          onclick: () => host.openGeneration(current.conversationId!) }, t("discoveryOpenGeneration")) : null,
        current.status === "running" ? h("button", { type: "button", className: "button secondary", "data-testid": "discovery-stop", disabled: saving,
          onclick: () => void mutate(() => api(`${prefix}/generations/${current.id}/stop`, { method: "POST" })) }, t("stop")) : null,
        current.status === "unknown" ? h("button", { type: "button", className: "button secondary", "data-testid": "discovery-start-again", disabled: saving,
          onclick: () => void generate(true) }, t("discoveryStartAgain")) : null);
      if (!status.querySelector('[data-testid="discovery-read-error"]')) status.replaceChildren(stateLabel);
    } else if (!status.querySelector('[data-testid="discovery-read-error"]')) status.replaceChildren();
    continuation.replaceChildren(...(state.nextCursor ? [h("button", { type: "button", className: "button secondary", "data-testid": "discovery-load-more", disabled: saving || loading,
      onclick: () => void load(true) }, loading ? t("personalLoading") : t("libraryLoadMore", { count: state.items.length, total: state.total }))] : []));
    page.scrollTop = scroll;
    if (id) list.querySelector(`[data-testid="discovery-item-${CSS.escape(id)}"]`)?.scrollIntoView({ block: "nearest" });
    if (document.activeElement === document.body) returnFocus(focused);
  };
  const load = async (append = false) => {
    if (append && (loading || !state?.nextCursor)) return;
    issue = false;
    loading = true;
    const current = ++request, params = new URLSearchParams({ limit: "60", includeHidden: String(hidden.has(kind)) });
    if (append && state?.nextCursor) params.set("cursor", state.nextCursor);
    if (!state) status.replaceChildren(h("div", { className: "page-loading", role: "status" }, h("span", { className: "spinner" })));
    else draw();
    try {
      const result = await api<Listing>(`${prefix}?${params}`);
      if (!here() || current !== request) return;
      if (result.available !== true || !Array.isArray(result.items) || kind === "feed" && (!("text" in result.prompt) || typeof result.prompt.text !== "string")) throw new Error(t("personalDataInvalid"));
      if (append && state) result.items = [...state.items, ...result.items];
      state = result; status.replaceChildren();
    } catch (failure) { if (here() && current === request) error(failure); }
    finally { if (here() && current === request) { loading = false; draw(); } }
  };
  void load();
}

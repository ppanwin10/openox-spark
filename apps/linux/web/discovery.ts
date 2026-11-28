import type { WorkspaceDiscoveryItem as DiscoveryItem, DiscoveryKind, GenerationView } from "@openox/agent/linux";
import { api, APIError, ask, clearInfoToasts, closeMenu, deferRefreshWhileDialogOpen, failed, formDialog, menu, relativeTime, returnFocus, sheet, toast } from "./client";
import type { PageHost } from "./capabilities";
import { h, icon, itemIcon } from "./dom";
import { fileURL } from "./file-viewer";
import { hostText, locale, t, type StringKey } from "./i18n";
import { markdown } from "./markdown";

type Prompt = { text: string; revision: number };
type Listing = { available: boolean; items: DiscoveryItem[]; prompt: Prompt | { revision: number }; total: number; nextCursor: string | null; generation: GenerationView | null };
export interface DiscoveryHost { discuss(item?: DiscoveryItem): void; openGeneration(id: number): void; draftChat?(text: string): void }
type RichItem = DiscoveryItem & { images?: string[]; actionKind?: "do" | "discuss"; why?: string; category?: string; reaction?: string };
const reactions = ["👍", "❤️", "😂", "😮", "😢", "🙏"];
/** Rich pages (decision 0041): Muse-style Feed posts and Ideas rows. */
const richPages = () => document.documentElement.hasAttribute("data-rich-pages");
const ideaOrder = ["Shopping", "Productivity", "Financial Management", "Health & Fitness", "Relationships", "Travel", "Home", "Learning", "Entertainment"];
function viewImage(url: string, label: string) {
  const dialog = h("dialog", { className: "dialog feed-image-viewer", "aria-label": label, "data-testid": "feed-image-viewer", onclick: () => dialog.close() },
    h("img", { src: url, alt: label, referrerpolicy: "no-referrer" }));
  dialog.addEventListener("close", () => dialog.remove());
  document.body.append(dialog); dialog.showModal();
}
let generation = 0, timer: ReturnType<typeof setTimeout> | undefined;
let active: { context: PageHost; lifetime: AbortController; refresh(): void; busy(): boolean } | undefined;
const hidden = new Set<DiscoveryKind>();
const attempts = new Map<DiscoveryKind, { key: string; body: { expectedRevision: number; replaceUnknown?: boolean } }>();
const describe = (error: unknown) => error instanceof TypeError && error.message === "Failed to fetch" ? t("requestResultUnavailable") : hostText(error instanceof Error ? error.message : String(error));
export function closeDiscoveryView() { generation++; clearTimeout(timer); active?.lifetime.abort(); active = undefined; }
export function refreshDiscovery() {
  const view = active; clearTimeout(timer);
  if (view?.context.main.isConnected && !view.busy()) timer = setTimeout(() => {
    if (active !== view || !view.context.main.isConnected || view.busy()) return;
    if (!deferRefreshWhileDialogOpen(refreshDiscovery, view.lifetime.signal)) view.refresh();
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
    if (saving || dirty() && await ask({ title: t("feedReloadTitle"), message: t("feedReloadPrompt"), confirm: t("todoReload") }) !== "confirm") return;
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
  closeDiscoveryView();
  const version = generation, here = () => version === generation && context.main.isConnected;
  let state: Listing | undefined, saving = false, dispatching = false, loading = false, issue = false, stale = false, request = 0;
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
  active = { context, lifetime: new AbortController(), refresh: () => void load(), busy: () => saving || issue };
  const error = (failure: unknown) => {
    issue = true;
    const openMenu = document.querySelector(".discovery-actions-menu"), focusRetry = openMenu?.contains(document.activeElement);
    if (openMenu) closeMenu();
    const retry = h("button", { type: "button", className: "button secondary", "data-testid": "discovery-retry", onclick: () => void load() }, t("museRetry"));
    status.replaceChildren(h("p", { className: "form-error", role: "alert", "data-testid": "discovery-read-error" },
      stale ? `${t("consoleStale")} ${describe(failure)}` : describe(failure)), retry);
    if (focusRetry) retry.focus({ preventScroll: true });
  };
  const mutate = async (work: () => Promise<unknown>) => {
    if (saving || stale) return;
    const focused = document.activeElement;
    clearInfoToasts(); saving = true; draw();
    try { await work(); if (here()) await load(); }
    catch (failure) {
      const message = t("discoveryItemUnknown", { page: t(kind === "feed" ? "museFeed" : "museIdeas") });
      if (here()) error(!(failure instanceof APIError) || failure.status === 408 || failure.status >= 500 ? new Error(`${message}\n${describe(failure)}`) : failure);
      else failed(failure, message);
    }
    finally { saving = false; if (here()) { draw(); if (document.activeElement === document.body) returnFocus(focused); } }
  };
  const generate = async (replaceUnknown = false) => {
    if (kind !== "feed" || !state || saving || stale) return;
    clearInfoToasts();
    const previous = attempts.get(kind), current = state.generation;
    const restart = replaceUnknown || current?.status === "unknown" || !!previous && (previous.body.expectedRevision !== state.prompt.revision
      || !issue && !loading && !!current && !["preparing", "running"].includes(current.status));
    if (restart && await ask({ title: t("discoveryStartAgain"), message: t("discoveryAgainBody"), confirm: t("discoveryGenerate") }) !== "confirm") return;
    if (!here() || saving || stale || !state) return;
    if (restart) attempts.delete(kind);
    const attempt = attempts.get(kind) ?? { key: crypto.randomUUID(), body: { expectedRevision: state.prompt.revision, ...(restart ? { replaceUnknown: true } : {}) } };
    attempts.set(kind, attempt); saving = true; dispatching = true; draw();
    try {
      const result = await api<{ generation: GenerationView }>(`${prefix}/generate`, { method: "POST", headers: { "idempotency-key": attempt.key }, json: attempt.body });
      if (attempts.get(kind) === attempt) attempts.delete(kind);
      if (!here()) return;
      issue = false; status.replaceChildren(); state.generation = result.generation;
      if (result.generation.conversationId !== null && !richPages()) host.openGeneration(result.generation.conversationId);
      else if (here()) await load();
    } catch (failure) {
      if (here()) error(failure instanceof TypeError ? new Error(t("discoveryDispatchUnknown")) : failure);
      else failed(failure, t("discoveryDispatchAwayUnknown", { page: t(kind === "feed" ? "museFeed" : "museIdeas") }));
    } finally { saving = false; dispatching = false; if (here()) draw(); }
  };
  const menuButton = h("button", { type: "button", className: "icon-button muse-goals-menu", "aria-label": t("moreOptions"), "data-testid": "discovery-menu",
    onclick: () => {
      const last = state?.generation?.conversationId;
      const running = state?.generation && ["preparing", "running"].includes(state.generation.status);
      menu(menuButton, [
      ...(state && !stale ? [{ label: t(hidden.has(kind) ? "discoveryHideDismissed" : "discoveryShowDismissed"), icon: "eye" as const, testID: "discovery-show-hidden",
        run: () => { if (hidden.has(kind)) hidden.delete(kind); else hidden.add(kind); void load(); } }] : []),
      ...(kind === "feed" && state && !stale && !saving && !loading && !running ? [{ label: t("discoveryGenerate"), icon: "spark" as const, testID: "discovery-generate-more", run: () => void generate() }] : []),
      ...(!stale && last !== null && last !== undefined ? [{
        label: t("discoveryOpenGeneration"), icon: "chat" as const, testID: "discovery-open-last",
        run: () => host.openGeneration(last),
      }] : []),
      { label: t("pageReload"), icon: "reload", testID: "discovery-refresh", run: () => void load() },
    ], { className: "discovery-actions-menu" }); } }, icon("more"));
  title.append(menuButton);
  const draw = () => {
    page.setAttribute("aria-busy", String(saving || loading));
    const retry = status.querySelector<HTMLButtonElement>('[data-testid="discovery-retry"]');
    if (retry) { retry.disabled = loading; retry.textContent = t(loading ? "personalLoading" : "museRetry"); }
    if (!state) {
      for (const region of [toolbar, list, targetStatus, continuation]) region.replaceChildren();
      return;
    }
    const locked = saving || stale;
    dispatchProgress.hidden = !dispatching;
    const focused = page.contains(document.activeElement) ? document.activeElement : null;
    const scroll = page.scrollTop, current = state.generation, running = current && ["preparing", "running"].includes(current.status);
    if (kind === "feed" && "text" in state.prompt) {
      const prompt = state.prompt;
      toolbar.replaceChildren(h("section", { className: "feed-prompt-card", "data-testid": "feed-prompt" }, h("h2", {}, t("feedYourPrompt")),
        h("p", { "data-testid": "feed-prompt-text" }, prompt.text), h("div", { className: "feed-prompt-actions" },
          h("button", { type: "button", className: "button secondary", "data-testid": "feed-prompt-edit", disabled: locked,
            onclick: () => void editPrompt(prompt, result => { if (state && here()) { request++; state.prompt = result; draw(); } }).catch(failed) }, icon("pencil", 16), t("edit")),
          h("button", { type: "button", className: "button primary", "data-testid": "feed-generate", disabled: locked || loading || !!running,
            onclick: () => void generate() }, ...(richPages() && running ? [h("span", { className: "spinner", "aria-hidden": "true" }), t("discoveryGenerating")] : [t("discoveryGenerate")])))));
    } else toolbar.replaceChildren(h("p", { className: "ideas-intro" }, t(richPages() ? "ideasIntroMuse" : "ideasIntro")));
    const hide = (item: DiscoveryItem) => mutate(() => api(`${prefix}/items/${item.id}`, { method: "PATCH", json: { expectedRevision: item.revision, hidden: !item.hidden } }));
    const richOptions = (item: RichItem, entries: Parameters<typeof menu>[1]) => {
      const options: HTMLButtonElement = h("button", { type: "button", className: "icon-button discovery-item-more", hidden: stale, disabled: locked, "aria-label": `${t("moreOptions")}: ${item.name}`,
        "data-testid": `discovery-item-menu-${item.id}`, onclick: (event: Event) => { event.stopPropagation(); menu(options, entries, { className: "discovery-actions-menu" }); } }, icon("more", 18));
      return options;
    };
    const post = (item: RichItem) => {
      const body = h("div", { className: "markdown feed-post-body" }, markdown(item.body, target => /^https?:\/\//i.test(target) ? { href: target, file: false, image: false } : undefined, t("copyCode")));
      for (const link of body.querySelectorAll<HTMLAnchorElement>("a[href]")) { link.target = "_blank"; link.rel = "noopener noreferrer"; link.referrerPolicy = "no-referrer"; }
      const options = richOptions(item, [
        ...(item.why ? [{ label: t("feedWhy"), icon: "spark" as const, testID: "feed-why", run: () => void formDialog({ title: t("feedWhyTitle"), message: item.why, confirm: t("ok"), cancel: false, testID: "feed-why-dialog" }) }] : []),
        { label: t(item.hidden ? "discoveryRestore" : "delete"), icon: item.hidden ? "reload" : "trash", testID: item.hidden ? "discovery-restore" : "feed-delete", run: () => void hide(item) },
      ]);
      const react = (emoji: string | null) => void mutate(() => api(`${prefix}/items/${item.id}`, { method: "PATCH", json: { expectedRevision: item.revision, reaction: emoji } }));
      const reactButton: HTMLButtonElement = h("button", { type: "button", className: "icon-button", "aria-label": t("feedReact"), title: t("feedReact"), disabled: locked,
        onclick: () => {
          document.querySelector(".feed-reactions")?.remove();
          const bar = h("div", { className: "feed-reactions", role: "menu" }, ...reactions.map(emoji => h("button", { type: "button", role: "menuitem", "aria-pressed": String(item.reaction === emoji),
            onclick: () => { bar.remove(); react(item.reaction === emoji ? null : emoji); } }, emoji)));
          reactButton.closest(".feed-post")!.append(bar);
          const away = (event: Event) => { if (!bar.contains(event.target as Node) && event.target !== reactButton) { bar.remove(); document.removeEventListener("pointerdown", away); } };
          document.addEventListener("pointerdown", away);
        } }, icon("smile", 18));
      const tools = h("div", { className: "feed-post-tools", hidden: stale }, reactButton,
        h("button", { type: "button", className: "icon-button", "aria-label": t("feedReply"), title: t("feedReply"), onclick: () => host.discuss(item) }, icon("reply", 18)));
      return h("article", { className: `feed-post${item.hidden ? " hidden-item" : ""}`, "data-testid": `feed-post-${item.id}` }, tools,
        h("span", { className: "feed-post-icon", "aria-hidden": "true" }, item.icon),
        h("div", { className: "feed-post-main" },
          h("header", { className: "feed-post-heading" }, h("h2", {}, item.name), h("small", {}, relativeTime(Date.parse(item.updatedAt))), options),
          body,
          item.images?.length ? h("div", { className: "feed-post-images" }, ...item.images.map(url => h("button", { type: "button", className: "feed-post-image", "aria-label": t("feedViewImage"),
            onclick: () => viewImage(`/api/product-image?u=${encodeURIComponent(url)}`, item.name) }, h("img", { src: `/api/product-image?u=${encodeURIComponent(url)}`, alt: "", loading: "lazy", referrerpolicy: "no-referrer" })))) : null,
          h("div", { className: "feed-post-actions", hidden: stale },
            h("button", { type: "button", className: `icon-button discovery-love${item.loved ? " loved" : ""}`, "aria-pressed": String(item.loved), "aria-label": t("discoveryLove"),
              "data-testid": `feed-love-${item.id}`, disabled: locked, onclick: () => void mutate(() => api(`${prefix}/items/${item.id}`, { method: "PATCH", json: { expectedRevision: item.revision, loved: !item.loved } })) }, icon("heart", 20)),
            item.reaction ? h("button", { type: "button", className: "feed-post-reaction", "aria-label": t("feedReactionRemove"), disabled: locked, onclick: () => react(null) }, item.reaction) : null,
            h("button", { type: "button", className: "feed-post-act", "data-testid": `feed-act-${item.id}`, disabled: stale, onclick: () => host.discuss(item) },
              icon(item.actionKind === "do" ? "spark" : "chat", 18), t(item.actionKind === "do" ? "feedLetsDo" : "discoveryDiscuss")))));
    };
    const ideaRow = (item: RichItem) => {
      const options = richOptions(item, [
        { label: t("feedLetsDo"), icon: "spark", testID: "idea-do", run: () => host.discuss(item) },
        { label: t("ideaMoreLike"), icon: "plus", testID: "idea-more", run: () => host.draftChat?.(t("ideaMoreLikeDraft", { title: item.name })) },
        { label: t(item.hidden ? "discoveryRestore" : "ideaNotInterested"), icon: item.hidden ? "reload" : "close", testID: item.hidden ? "discovery-restore" : "idea-hide", run: () => void hide(item) },
      ]);
      return h("div", { className: `idea-row${item.hidden ? " hidden-item" : ""}`, "data-testid": `idea-row-${item.id}` },
        h("button", { type: "button", className: "idea-row-open", disabled: stale, onclick: () => host.discuss(item) },
          h("span", { className: "idea-row-icon", "aria-hidden": "true" }, item.icon), h("span", { className: "idea-row-text" }, h("h3", {}, item.name), h("span", {}, item.body))), options);
    };
    if (richPages() && kind === "ideas") {
      const items = [...state.items as RichItem[]].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
      const fresh = items.slice(0, 4), rest = items.slice(4), groups = new Map<string, RichItem[]>();
      for (const item of rest) { const key = item.category ?? t("ideaMore"); groups.set(key, [...groups.get(key) ?? [], item]); }
      const ordered = [...groups.keys()].sort((a, b) => (ideaOrder.indexOf(a) + 1 || 99) - (ideaOrder.indexOf(b) + 1 || 99));
      list.replaceChildren(...(fresh.length ? [h("section", { className: "ideas-group" }, ...fresh.map(ideaRow))] : []),
        ...ordered.map(name => h("section", { className: "ideas-group" }, h("h2", {}, name), ...groups.get(name)!.map(ideaRow))));
    } else
    list.replaceChildren(...state.items.map(item => {
      if (richPages() && kind === "feed" && (item as RichItem).actionKind) return post(item as RichItem);
      const local = item.provenance !== "modelProvided";
      const body = h("div", { className: "markdown discovery-item-body" }, local ? h("p", {}, item.body) : markdown(item.body,
        target => /^https?:\/\//i.test(target) ? { href: target, file: false, image: false } : undefined, t("copyCode")));
      const linked = new Set([...body.querySelectorAll<HTMLAnchorElement>("a[href]")].map(link => link.href));
      const sources = item.sources.filter(source => !linked.has(source.url));
      for (const link of body.querySelectorAll<HTMLAnchorElement>("a[href]")) if (item.sources.some(source => source.url === link.href)) link.title = t("discoverySourceNote");
      const options = h("button", { type: "button", className: "icon-button", hidden: stale, disabled: locked, "aria-label": `${t("moreOptions")}: ${item.name}`, "data-testid": `discovery-item-menu-${item.id}`,
        onclick: () => menu(options, [{ label: t(item.hidden ? "discoveryRestore" : "discoveryHide"), icon: item.hidden ? "reload" : "close",
          testID: item.hidden ? "discovery-restore" : "discovery-hide", run: () => mutate(() => api(`${prefix}/items/${item.id}`, { method: "PATCH",
            json: { expectedRevision: item.revision, hidden: !item.hidden } })) },
          { label: t(hidden.has(kind) ? "discoveryHideDismissed" : "discoveryShowDismissed"), icon: "eye", testID: "discovery-show-hidden",
            run: () => { if (hidden.has(kind)) hidden.delete(kind); else hidden.add(kind); void load(); } },
        ], { className: "discovery-actions-menu" }) }, icon("more", 18));
      return h("article", { className: `discovery-item${item.hidden ? " hidden-item" : ""}`, "data-testid": `discovery-item-${item.id}` },
        h("span", { className: "discovery-item-icon", "aria-hidden": "true" }, itemIcon(item.icon, kind === "feed" ? "feedPages" : "bulb", 24)),
        h("header", { className: "discovery-item-heading" }, h("h2", {}, item.name), h("small", {}, relativeTime(Date.parse(item.updatedAt))), options),
        local ? h("a", { className: "muted small", "data-testid": "discovery-origin",
          href: item.provenance === "connectorUpdate" ? "#/settings/services" :
            `#/${item.provenance === "publicWatch" ? "automations" : item.provenance === "chatQuote" || item.provenance === "chatSuggestion" ? "c" : "goals"}/${encodeURIComponent(item.originId)}` },
          t(item.provenance === "trackedGoal" ? "quietGoalStep" : item.provenance === "goalFinding" ? "quietFinding" : item.provenance === "publicWatch" ? "quietWatch" : item.provenance === "connectorUpdate" ? "quietConnector" : "quietChat",
            { time: new Date(item.observedAt).toLocaleString(locale, { dateStyle: "short", timeStyle: "short" }) })) : null, body,
        sources.length ? h("div", { className: "discovery-sources" }, ...sources.map(source => h("a", { href: source.url, target: "_blank",
          rel: "noopener noreferrer", referrerpolicy: "no-referrer", title: local ? source.url : t("discoverySourceNote") }, source.name))) : null,
        item.imagePath ? h("img", { src: fileURL(item.imagePath), alt: item.name, loading: "lazy", className: "discovery-image" }) : item.imageMissing ? h("p", { className: "muted small" }, t("discoveryImageMissing")) : null,
        h("div", { className: "discovery-item-actions", hidden: stale },
          kind === "feed" ? h("button", { type: "button", className: `icon-button discovery-love${item.loved ? " loved" : ""}`, "aria-pressed": String(item.loved),
            "aria-label": t("discoveryLove"), "data-testid": `feed-love-${item.id}`, disabled: locked, onclick: () => void mutate(() => api(`${prefix}/items/${item.id}`,
              { method: "PATCH", json: { expectedRevision: item.revision, loved: !item.loved } })) }, icon("heart", 20)) : null,
          h("button", { type: "button", className: "discovery-discuss", "data-testid": `discovery-discuss-${item.id}`, disabled: stale, onclick: () => host.discuss(item) },
            icon("chat", 18), t(kind === "feed" ? "discoveryDiscuss" : "ideasAct"))),
        item.hidden ? h("small", { className: "muted" }, t("discoveryDismissed")) : null);
    }));
    if (!state.items.length && !stale) list.append(h("div", { className: "discovery-empty", "data-testid": "discovery-empty" },
      h("p", { className: "muted" }, t(kind === "feed" ? richPages() ? "feedEmptyMuse" : "feedEmpty" : richPages() ? "ideasEmptyMuse" : "ideasEmpty"))));
    targetStatus.replaceChildren(...(!stale && id && !state.items.some(item => item.id === id) ? [
      h("p", { className: "muted", "data-testid": "discovery-source-unavailable" }, t(state.nextCursor ? "discoverySourceNotLoaded" : "discoverySourceUnavailable")),
      h("a", { href: `#/${kind}`, className: "personal-back", "data-testid": "discovery-source-back" }, icon("back", 16), t(kind === "feed" ? "museFeed" : "museIdeas")),
    ] : []));
    if (richPages() && current && ["preparing", "running"].includes(current.status)) { if (!status.querySelector('[data-testid="discovery-read-error"]')) status.replaceChildren(); clearTimeout(timer); timer = setTimeout(() => { if (here()) void load(); }, 3_000); }
    else if (current && current.status !== "completed" && !(richPages() && current.status === "noUpdate")) {
      const stateLabel = h("div", { className: `discovery-generation ${current.status}`, "data-testid": "discovery-generation-status" }, h("span", {}, t(statusNames[current.status])),
        current.error ? h("p", { className: "form-error" }, hostText(current.error)) : null,
        current.conversationId !== null ? h("button", { type: "button", className: "button secondary", "data-testid": "discovery-generation-open",
          onclick: () => host.openGeneration(current.conversationId!) }, t("discoveryOpenGeneration")) : null,
        current.status === "running" ? h("button", { type: "button", className: "button secondary", "data-testid": "discovery-stop", disabled: saving,
          onclick: () => void mutate(() => api(`${prefix}/generations/${current.id}/stop`, { method: "POST" })) }, t("stop")) : null,
        kind === "feed" && current.status === "unknown" ? h("button", { type: "button", className: "button secondary", "data-testid": "discovery-start-again", disabled: saving,
          onclick: () => void generate(true) }, t("discoveryStartAgain")) : null);
      if (!status.querySelector('[data-testid="discovery-read-error"]')) status.replaceChildren(stateLabel);
    } else if (!status.querySelector('[data-testid="discovery-read-error"]')) status.replaceChildren();
    continuation.replaceChildren(...(state.nextCursor ? [h("button", { type: "button", className: "button secondary", "data-testid": "discovery-load-more", disabled: locked || loading,
      onclick: () => void load(true) }, loading ? t("personalLoading") : t("libraryLoadMore", { count: state.items.length, total: state.total }))] : []));
    page.scrollTop = scroll;
    if (id) list.querySelector(`[data-testid="discovery-item-${CSS.escape(id)}"]`)?.scrollIntoView({ block: "nearest" });
    if (document.activeElement === document.body) returnFocus(focused);
  };
  const load = async (append = false) => {
    if (loading && (issue || append) || append && !state?.nextCursor) return;
    const fromRetry = document.activeElement?.matches('[data-testid="discovery-retry"]');
    loading = true;
    const current = ++request, params = new URLSearchParams({ limit: "60", includeHidden: String(hidden.has(kind)) });
    if (append && state?.nextCursor) params.set("cursor", state.nextCursor);
    if (!state && !issue) status.replaceChildren(h("div", { className: "page-loading", role: "status" }, h("span", { className: "spinner" })));
    draw();
    try {
      const result = await api<Listing>(`${prefix}?${params}`);
      if (!here() || current !== request) return;
      if (result.available === false) { state = undefined; throw new Error(t("pageUnavailable")); }
      if (result.available !== true || !Array.isArray(result.items) || kind === "feed" && (!("text" in result.prompt) || typeof result.prompt.text !== "string")) throw new Error(t("personalDataInvalid"));
      if (append && state) result.items = [...state.items, ...result.items];
      state = result; issue = false; stale = false; status.replaceChildren();
    } catch (failure) {
      if (here() && current === request) {
        if (failure instanceof APIError && [401, 403, 404].includes(failure.status)) state = undefined;
        stale = !!state;
        error(failure instanceof Error && (failure.message === "Failed to fetch" || failure.message === "Load failed") ? new Error(t("museReadFailed")) : failure);
      }
    }
    finally {
      if (here() && current === request) {
        loading = false; draw();
        if (fromRetry && document.activeElement === document.body) (status.querySelector<HTMLButtonElement>('[data-testid="discovery-retry"]') ?? menuButton).focus({ preventScroll: true });
      }
    }
  };
  void load();
}

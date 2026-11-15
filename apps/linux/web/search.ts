import { api, APIError, closeOnBackdrop, getContentEpoch } from "./client";
import { h, icon } from "./dom";
import { hostText, t } from "./i18n";
import { searchRange, type SearchPage, type SearchResult, type SearchTarget } from "../src/search-contract";

export interface SearchHost {
  openSearchResult(target: SearchTarget, query: string, reference: string, release: () => void): void;
}
let dismiss: (() => void) | undefined;
export function closeMuseSearch() { dismiss?.(); }
export function highlightSearch(element: HTMLElement, query: string) {
  element.classList.add("muse-search-anchor");
  element.dataset.searchHit = "true";
  element.tabIndex = -1;
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT), nodes: Text[] = [];
  let text = "", node: Node | null;
  while ((node = walker.nextNode())) {
    if (node.parentElement?.closest("button,script,style")) continue;
    nodes.push(node as Text); text += node.textContent ?? "";
  }
  const match = searchRange(text, query);
  if (!match) return;
  const range = document.createRange();
  let offset = 0;
  for (const node of nodes) {
    const end = offset + node.length;
    if (offset <= match.start && match.start < end) range.setStart(node, match.start - offset);
    if (offset < match.end && match.end <= end) { range.setEnd(node, match.end - offset); break; }
    offset = end;
  }
  CSS.highlights?.set("muse-search-hit", new Highlight(range));
  return range;
}
export function clearSearchHighlight() {
  CSS.highlights?.delete("muse-search-hit");
  document.querySelectorAll(".muse-search-anchor").forEach(element => { element.classList.remove("muse-search-anchor"); element.removeAttribute("data-search-hit"); });
}
function validPage(page: SearchPage, requestId: string, previous: SearchResult[]) {
  if (!page || page.available !== true || page.requestId !== requestId || page.epoch !== getContentEpoch() || !Array.isArray(page.items)
    || page.items.length > 50 || typeof page.complete !== "boolean" || page.complete && page.nextCursor !== null
    || page.nextCursor !== null && typeof page.nextCursor !== "string" || !page.coverage || !Array.isArray(page.coverage.issues)
    || page.items.some(item => !item || typeof item.id !== "string" || !["conversation", "message", "file"].includes(item.kind)
      || typeof item.title !== "string" || typeof item.snippet !== "string" || !item.source
      || item.match !== null && (!Number.isInteger(item.match.start) || !Number.isInteger(item.match.end) || item.match.start < 0 || item.match.end > item.snippet.length))
    || new Set([...previous, ...page.items].map(item => item.id)).size !== previous.length + page.items.length) throw new Error(t("personalDataInvalid"));
  return page;
}
const marked = (text: string, match: SearchResult["match"]) => !match ? [text]
  : [text.slice(0, match.start), h("mark", {}, text.slice(match.start, match.end)), text.slice(match.end)];

export function openMuseSearch(host: SearchHost) {
  if (dismiss) return;
  const previous = document.activeElement, epoch = getContentEpoch();
  const dialog = h("dialog", { className: "muse-search-dialog", "aria-label": t("museSearch"), "data-testid": "muse-search" });
  const input = h("input", { type: "search", role: "combobox", placeholder: t("museSearch"), "aria-label": t("museSearch"),
    "aria-autocomplete": "list", "aria-controls": "muse-search-list", "aria-expanded": "true", autocomplete: "off", "data-testid": "muse-search-input" });
  const results = h("div", { className: "muse-search-results" });
  const clear = h("button", { type: "button", className: "icon-button", "aria-label": t("searchClear"), title: t("searchClear"),
    "data-testid": "muse-search-clear", onclick: () => { input.value = ""; start(); input.focus(); } }, icon("close", 18));
  let generation = 0, id = "", items: SearchResult[] = [], page: SearchPage | undefined, busy = false, selected = -1, started = false;
  let timer: ReturnType<typeof setTimeout> | undefined, controller: AbortController | undefined;
  const release = (requestId: string) => { if (requestId) void api(`/api/search/${requestId}`, { method: "DELETE", keepalive: true }).catch(() => {}); };
  const active = (value: number) => value === generation && dialog.isConnected && dialog.open && epoch === getContentEpoch();
  const close = (restore = true, retain = false) => {
    generation++; clearTimeout(timer); controller?.abort();
    window.removeEventListener("hashchange", routeChanged);
    window.removeEventListener("pagehide", routeChanged);
    window.removeEventListener("ox-search-changed", sourcesChanged);
    if (!retain && started) release(id);
    dismiss = undefined; dialog.close(); dialog.remove();
    if (restore && previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
  };
  const routeChanged = () => close(false);
  const sourcesChanged = () => {
    if (!dialog.open) return;
    generation++; controller?.abort(); clearTimeout(timer); if (started) release(id); id = ""; page = undefined; items = []; busy = false;
    error(new Error(t("searchChanged")));
  };
  const loading = () => h("p", { className: "muse-search-note", role: "status", "data-testid": "muse-search-loading" }, h("span", { className: "spinner" }), t("searchLoading"));
  const open = async (item: SearchResult) => {
    if (busy) return;
    const current = ++generation, requestId = id;
    busy = true; draw();
    controller = new AbortController();
    try {
      const result = await api<{ available: boolean; epoch: number; target: SearchTarget }>(`/api/search/targets/${item.id}`, { signal: controller.signal });
      if (!active(current)) return;
      if (result.available !== true || result.epoch !== epoch || !result.target || !["chat", "file"].includes(result.target.kind)) throw new Error(t("personalDataInvalid"));
      close(false, true);
      host.openSearchResult(result.target, input.value.trim(), item.id, () => release(requestId));
    } catch (failure) { if (active(current)) { busy = false; error(failure); } }
  };
  const focusItem = (index: number) => {
    const rows = [...results.querySelectorAll<HTMLButtonElement>(".muse-search-result")];
    selected = index;
    rows.forEach((row, at) => row.setAttribute("aria-selected", String(at === index)));
    if (index < 0) { input.removeAttribute("aria-activedescendant"); input.focus(); }
    else if (rows[index]) { input.setAttribute("aria-activedescendant", rows[index]!.id); rows[index]!.focus(); }
  };
  function draw() {
    clear.hidden = !input.value;
    const list = h("div", { id: "muse-search-list", role: "listbox", "aria-label": t(input.value.trim() ? "museSearchResults" : "museRecents") });
    items.forEach((item, index) => {
      const title = "mainChat" in item.source && item.source.mainChat ? t("museMainChat") : item.title || t("untitled");
      const details = item.kind === "message" || item.kind === "file" && item.snippet !== item.title ? item.snippet : "";
      list.append(h("button", { type: "button", id: `muse-result-${index}`, className: "muse-search-result", role: "option", disabled: busy,
        "aria-selected": String(index === selected), "data-testid": `muse-search-result-${item.id}`, "data-search-kind": item.kind,
        onfocus: () => { selected = index; }, onclick: () => void open(item) }, icon(item.kind === "file" ? "file" : "chat", 20),
        h("span", { className: "muse-search-copy" }, h("strong", {}, title),
          item.kind === "file" && "path" in item.source ? h("small", { className: "muse-search-path", title: item.source.path }, item.source.path) : null,
          details ? h("small", { className: "muse-search-snippet" }, ...marked(details, item.match)) : null)));
    });
    results.replaceChildren(h("p", { className: "muse-search-label" }, t(input.value.trim() ? "museSearchResults" : "museRecents")), list);
    results.setAttribute("aria-busy", String(busy));
    if (busy) results.append(loading());
    else if (page) {
      if (!items.length && page.complete) results.append(h("p", { className: "muse-search-empty", role: "status", "data-testid": "muse-search-empty" },
        t(input.value.trim() ? "museSearchEmpty" : "searchRecentsEmpty")));
      if (page.coverage.issues.length) results.append(h("p", { className: "muse-search-note", role: "status", "data-testid": "muse-search-partial" },
        t("searchPartial"), " ", ...page.coverage.issues.map(value => `${t(value.code === "unsupported-text" ? "searchUnsupported"
          : value.code === "unreadable-text" ? "searchUnreadable" : value.code === "unregistered-files" ? "searchUnregistered"
          : value.code === "unprepared-transcript" ? "searchUnprepared" : "searchLimited")}: ${value.count}. `)));
      if (page.nextCursor) results.append(h("button", { type: "button", className: "button secondary", "data-testid": "muse-search-more", onclick: () => void load(true) },
        t(page.query ? "searchContinue" : "searchMore")));
      if (!page.complete) results.append(h("p", { className: "muse-search-note", "data-testid": "muse-search-progress" }, t("searchProgress", { count: page.coverage.sources })));
    }
  }
  function error(failure: unknown, retain = false) {
    busy = false; selected = -1; input.removeAttribute("aria-activedescendant");
    const previousResults = retain && items.length > 0;
    if (previousResults) {
      draw();
      results.querySelector('[data-testid="muse-search-more"]')?.remove();
      results.querySelector('[data-testid="muse-search-progress"]')?.remove();
    } else { items = []; page = undefined; results.replaceChildren(); }
    results.setAttribute("aria-busy", "false");
    results.prepend(h("p", { className: "muse-search-note form-error", role: "alert", "data-testid": "muse-search-error" },
      failure instanceof APIError && failure.status === 409 ? t("searchChanged") : previousResults ? t("searchContinueFailed")
        : failure instanceof TypeError || failure instanceof Error && failure.message === "Failed to fetch" ? t("searchLoadFailed")
        : hostText(failure instanceof Error ? failure.message : String(failure))),
      h("button", { type: "button", className: "button secondary", "data-testid": "muse-search-retry", onclick: () => start(0) }, t("museRetry")));
    results.scrollTop = 0;
  }
  async function load(more = false) {
    const current = ++generation;
    started = true;
    controller?.abort(); controller = new AbortController(); busy = true; draw();
    const params = new URLSearchParams({ q: input.value, requestId: id });
    if (more && page?.nextCursor) params.set("cursor", page.nextCursor);
    try {
      const result = validPage(await api<SearchPage>(`/api/search?${params}`, { signal: controller.signal }), id, more ? items : []);
      if (!active(current)) return;
      page = result; items = more ? [...items, ...result.items] : result.items;
      selected = -1; busy = false; draw();
    } catch (failure) { if (active(current)) error(failure, more && (!(failure instanceof APIError) || failure.status >= 500)); }
  }
  function start(delay = 200) {
    generation++; controller?.abort(); clearTimeout(timer); if (started) release(id);
    id = crypto.randomUUID(); started = false; page = undefined; items = []; selected = -1; busy = true; draw();
    timer = setTimeout(() => { if (dialog.isConnected && epoch === getContentEpoch()) void load(); }, delay);
  }
  input.addEventListener("input", () => start());
  dialog.addEventListener("keydown", event => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
    else if (["ArrowDown", "ArrowUp"].includes(event.key) && items.length && !busy) {
      event.preventDefault(); focusItem(event.key === "ArrowDown" ? Math.min(items.length - 1, selected + 1) : Math.max(-1, selected - 1));
    } else if (event.key === "Enter" && event.target === input && !busy && items.length) { event.preventDefault(); void open(items[Math.max(0, selected)]!); }
  });
  dialog.addEventListener("cancel", event => { event.preventDefault(); close(); });
  closeOnBackdrop(dialog, () => close());
  dialog.append(h("div", { className: "muse-search-head" }, icon("search", 22), input, clear), results);
  document.body.append(dialog);
  dismiss = () => close(false);
  window.addEventListener("hashchange", routeChanged);
  window.addEventListener("pagehide", routeChanged);
  window.addEventListener("ox-search-changed", sourcesChanged);
  dialog.showModal(); input.focus(); start(0);
}

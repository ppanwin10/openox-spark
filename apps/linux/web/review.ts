import type { ReviewCandidate, ReviewSource } from "@openox/agent/linux";
import { api, APIError, ask, failed, formDialog, menu, sheet, toast } from "./client";
import { keepFocus, skillsContent, type PageHost } from "./capabilities";
import { h, icon, loader } from "./dom";
import { hostText, locale, t, type StringKey } from "./i18n";

type Settings = { revision: number; suggestionsEnabled: boolean };
export type ReviewSummary = { available: false } | { available: true; settings: Settings; pending: number; limit: number };
export type MemoryTab = "memory" | "skills" | "suggestions";
export const memoryHash = (tab: MemoryTab = "memory", id: string | null = null) => `#/memory${tab === "memory" ? "" : `/${tab}`}${id ? `/${id}` : ""}`;
type Memory = { text: string; revision: string };
type State = { available: boolean; settings: Settings; candidates: ReviewCandidate[]; memory: Memory; limit: number };
type Detail = { candidate: ReviewCandidate; source: ReviewSource; validation: { scope: string; addedServices: string[]; removedServices: string[] } };
let generation = 0, filter: "pending" | "all" = "pending", kind: "all" | "memory" | "skill" = "all";
const statuses: Record<ReviewCandidate["status"], StringKey> = {
  pending: "reviewPending", applying: "reviewApplying", accepted: "reviewAccepted", rejected: "reviewRejected", needs_review: "reviewNeedsReview",
};
const note = (text: string) => h("p", { className: "personal-note" }, text);
const when = (value: string) => new Date(value).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });
const titleOf = (candidate: ReviewCandidate) => candidate.data.type === "memory" ? candidate.data.text : `/${candidate.data.name}`;
export function closeReviewView() { generation++; }

export async function loadReviewSummary(): Promise<ReviewSummary> {
  try {
    const result = await api<ReviewSummary>("/api/review?summary=1", { signal: AbortSignal.timeout(10_000) });
    if (result.available === false) return result;
    if (result.available !== true || !Number.isSafeInteger(result.pending) || result.pending < 0
      || typeof result.settings?.suggestionsEnabled !== "boolean" || !Number.isSafeInteger(result.settings.revision)) throw new Error(t("personalDataInvalid"));
    return result;
  } catch (error) {
    if (error instanceof APIError && error.status === 404) return { available: false };
    throw error;
  }
}

function editMemory(memory: Memory, refresh: () => void) {
  const text = h("textarea", { className: "field review-memory-input", rows: 14, "aria-label": t("memory"), "data-testid": "review-memory-input" });
  text.value = memory.text;
  let baseline = memory.text, revision = memory.revision, saving = false;
  const error = h("p", { className: "form-error", role: "alert", hidden: true, "data-testid": "review-memory-error" });
  const beforeUnload = (event: BeforeUnloadEvent) => { if (text.value !== baseline) { event.preventDefault(); event.returnValue = ""; } };
  window.addEventListener("beforeunload", beforeUnload);
  const view = sheet({ testID: "review-memory-editor", className: "todo-editor-sheet", label: t("reviewEditMemory"),
    onClose: () => { window.removeEventListener("beforeunload", beforeUnload); refresh(); },
    canClose: async () => !saving && (text.value === baseline
      || await ask({ title: t("discardChanges"), message: t("todoCloseBody"), confirm: t("discard"), destructive: true }) === "confirm") });
  const save = h("button", { type: "submit", className: "button primary", "data-testid": "review-memory-save" }, t("save"));
  const cancel = h("button", { type: "button", className: "button secondary", "data-testid": "review-memory-cancel", onclick: () => void view.attempt() }, t("cancel"));
  const close = h("button", { type: "button", className: "icon-button", "aria-label": t("close"), "data-testid": "review-memory-close", onclick: () => void view.attempt() }, icon("close"));
  const reload = h("button", { type: "button", className: "button secondary", hidden: true, "data-testid": "review-memory-reload", onclick: async () => {
    if (saving || text.value !== baseline && await ask({ title: t("todoReloadTitle"), message: t("reviewReloadBody"), confirm: t("todoReload") }) !== "confirm") return;
    reload.disabled = true;
    try {
      const current = (await api<State>("/api/review")).memory;
      text.value = baseline = current.text; revision = current.revision;
      feedback.hidden = true; reload.hidden = true;
    } catch (failure) { error.textContent = hostText(failure instanceof Error ? failure.message : String(failure)); error.hidden = false; feedback.hidden = false; }
    finally { reload.disabled = false; }
  } }, t("todoReload"));
  const feedback = h("div", { className: "personal-form-feedback", hidden: true }, error, reload);
  const form = h("form", { className: "todo-editor-form", onsubmit: async (event: Event) => {
    event.preventDefault();
    if (saving) return;
    saving = true; feedback.hidden = true;
    for (const control of [text, save, cancel, close, reload]) control.disabled = true;
    try {
      await api("/api/review/memory", { method: "PUT", json: { text: text.value, expectedSourceRevision: revision } });
      baseline = text.value; view.close(); toast(t("saved"));
    } catch (failure) {
      error.textContent = hostText(failure instanceof Error ? failure.message : String(failure));
      error.hidden = false; reload.hidden = false; feedback.hidden = false;
    } finally { saving = false; for (const control of [text, save, cancel, close, reload]) control.disabled = false; }
  } }, h("div", { className: "sheet-body todo-editor-body" }, note(t("reviewMemoryAuthority")), text, note(t("reviewHistoryNote"))),
  feedback, h("div", { className: "personal-form-actions" }, cancel, save));
  view.dialog.append(h("div", { className: "sheet-head" }, h("h2", { className: "sheet-title" }, t("reviewEditMemory")), close), form);
  text.focus();
}

function newProposal(type: "memory" | "skill", refresh: () => void) {
  const key = crypto.randomUUID();
  return formDialog({ title: t(type === "memory" ? "reviewNewMemory" : "reviewNewSkill"), message: t("reviewDraftNote"), testID: "review-new-dialog", confirm: t("reviewAddDraft"), protectDraft: true,
    fields: type === "memory" ? [
      { name: "text", label: t("reviewFact"), testID: "review-fact" },
      { name: "reason", label: t("reviewReason"), kind: "textarea", rows: 2, testID: "review-reason" },
    ] : [
      { name: "name", label: t("skillName"), placeholder: "daily-brief", testID: "review-skill-name" },
      { name: "description", label: t("skillWhen"), testID: "review-skill-description" },
      { name: "instructions", label: t("skillInstructions"), kind: "textarea", rows: 6, testID: "review-skill-instructions" },
      { name: "services", label: t("reviewDeclaredServices"), help: t("reviewServiceHelp"), testID: "review-skill-services" },
      { name: "update", label: t("reviewUpdateExisting"), kind: "switch", testID: "review-skill-update" },
      { name: "reason", label: t("reviewReason"), kind: "textarea", rows: 2, testID: "review-reason" },
    ],
    submit: async values => {
      const data = type === "memory" ? { type, text: String(values.text), classification: "explicit" }
        : { type, operation: values.update ? "update" : "create", name: String(values.name), description: String(values.description),
          instructions: String(values.instructions), services: String(values.services).split(",").map(value => value.trim()).filter(Boolean) };
      try {
        await api("/api/review", { method: "POST", headers: { "idempotency-key": key }, json: { data, reason: String(values.reason).trim() || t("reviewManualReason") } });
      } catch (error) { if (error instanceof TypeError) throw new Error(t("reviewSaveUnknown")); throw error; }
      toast(t("reviewDraftSaved")); refresh();
    } });
}

export async function renderReview(context: PageHost, id: string | null, tab: MemoryTab = "suggestions") {
  closeReviewView();
  const current = generation, hash = location.hash;
  const here = () => context.route() === "review" && location.hash === hash && context.main.isConnected;
  const active = () => current === generation && here();
  const refresh = () => { if (here()) void renderReview(context, id, tab); };
  let available = false;
  const frame = (...children: Node[]) => {
    if (!active()) return;
    const restore = keepFocus(context.main), scroll = context.main.querySelector(".review-page")?.scrollTop ?? 0;
    const create = available && id === null && tab === "suggestions" ? h("button", { type: "button", className: "button primary", "data-testid": "review-new", "aria-haspopup": "menu",
      onclick: (event: Event) => menu(event.currentTarget as HTMLElement, [
        { label: t("reviewNewMemory"), icon: "book", testID: "review-new-memory", run: () => void newProposal("memory", refresh) },
        { label: t("reviewNewSkill"), icon: "spark", testID: "review-new-skill", run: () => void newProposal("skill", refresh) },
      ]) }, icon("plus", 16), t("add")) : null;
    context.main.replaceChildren(context.topbar(t("reviewTitle"), create),
      h("div", { className: "page personal-page review-page", "data-testid": "review-page" }, h("div", { className: "personal-content" }, ...children)));
    context.main.querySelector(".review-page")!.scrollTop = scroll; restore();
  };
  if (!context.main.querySelector(".review-page")) frame(h("div", { className: "page-loading", role: "status", "aria-label": t("personalLoading") }, loader(24)));
  try {
    const state = await api<State>("/api/review", { signal: AbortSignal.timeout(15_000) });
    if (!active()) return;
    if (state.available === false) {
      frame(h("div", { className: "personal-empty", "data-testid": "review-unavailable" }, h("h2", {}, t("personalUnavailable")), note(t("personalUnavailableBody")))); return;
    }
    if (state.available !== true || !Array.isArray(state.candidates) || typeof state.memory?.text !== "string" || typeof state.settings?.suggestionsEnabled !== "boolean") {
      throw new Error(t("personalDataInvalid"));
    }
    available = true;
    if (id) {
      const detail = await api<Detail>(`/api/review/${encodeURIComponent(id)}`);
      if (!active()) return;
      const candidate = detail.candidate, data = candidate.data;
      if (!Object.hasOwn(statuses, candidate.status) || typeof detail.source?.revision !== "string"
        || (detail.source.text !== null && typeof detail.source.text !== "string")) throw new Error(t("personalDataInvalid"));
      const error = h("p", { className: "form-error", role: "alert", hidden: true, "data-testid": "review-decision-error" });
      const reload = h("button", { type: "button", className: "button secondary", hidden: true, "data-testid": "review-decision-reload", onclick: refresh }, t("todoReload"));
      let busy = false;
      const buttons: HTMLButtonElement[] = [];
      const action = (label: string, testID: string, destructive: boolean, run: () => Promise<void>) => {
        const button = h("button", { type: "button", className: `button ${destructive ? "danger" : "secondary"}`, "data-testid": testID, onclick: async () => {
          if (busy) return;
          busy = true; buttons.forEach(control => { control.disabled = true; });
          try { await run(); }
          catch (failure) { error.textContent = hostText(failure instanceof Error ? failure.message : String(failure)); error.hidden = false; reload.hidden = false; }
          finally { busy = false; buttons.forEach(control => { control.disabled = false; }); }
        } }, label);
        buttons.push(button); return button;
      };
      const publish = ["pending", "needs_review"].includes(candidate.status) ? action(t("reviewPublish"), "review-accept", false, async () => {
        if (await ask({ title: t("reviewPublishTitle"), message: t(data.type === "memory" ? "reviewPublishMemoryBody" : "reviewPublishSkillBody"),
          confirm: t("reviewPublish"), destructive: data.type === "skill" && data.operation === "update" }) !== "confirm") return;
        const result = await api<{ warning?: string | null }>(`/api/review/${id}/accept`, { method: "POST",
          json: { expectedRevision: candidate.revision, expectedSourceRevision: detail.source.revision } });
        if (result.warning) toast(hostText(result.warning), "error");
        toast(t("reviewPublished")); refresh();
      }) : null;
      const reject = ["pending", "needs_review"].includes(candidate.status) ? action(t("reviewReject"), "review-reject", false, async () => {
        if (await ask({ title: t("reviewRejectTitle"), message: t("reviewRejectBody"), confirm: t("reviewReject"), destructive: true }) !== "confirm") return;
        await api(`/api/review/${id}/reject`, { method: "POST", json: { expectedRevision: candidate.revision } }); refresh();
      }) : null;
      const remove = candidate.status !== "applying" ? action(t("delete"), "review-delete", true, async () => {
        if (await ask({ title: t("reviewDeleteTitle"), message: t("reviewDeleteBody"), confirm: t("delete"), destructive: true }) !== "confirm") return;
        await api(`/api/review/${id}`, { method: "DELETE", json: { expectedRevision: candidate.revision } }); location.hash = memoryHash("suggestions");
      }) : null;
      const source = h("textarea", { className: "field review-source", rows: 6, readonly: true, "aria-label": t("reviewCurrentSource"), "data-testid": "review-current-source" });
      source.value = detail.source.text ?? t("reviewNotInstalled");
      const proposed = h("textarea", { className: "field review-source", rows: data.type === "memory" ? 3 : 8, readonly: true,
        "aria-label": t("reviewProposed"), "data-testid": "review-proposed" });
      proposed.value = data.type === "memory" ? data.text : data.instructions;
      frame(h("a", { href: memoryHash("suggestions"), className: "personal-back", "data-testid": "review-back" }, icon("back", 16), t("memorySuggestedChanges")),
        h("article", { className: "group personal-detail review-detail", "data-testid": "review-detail", "data-review": id },
          h("span", { className: "tag subtle", "data-testid": "review-status" }, t(statuses[candidate.status])),
          h("h2", {}, titleOf(candidate)), note(candidate.reason),
          candidate.origin.kind === "agent" && candidate.origin.conversationId !== null
            ? h("a", { href: `#/c/${candidate.origin.conversationId}`, className: "personal-back", "data-testid": "review-origin" }, t("reviewOriginAgent"))
            : note(t("reviewOriginManual")),
          note(t("reviewUnverified")), candidate.note ? h("p", { className: "form-error" }, hostText(candidate.note)) : null,
          data.type === "memory" ? note(t(data.classification === "explicit" ? "reviewReportedExplicit" : "reviewReportedInferred")) : null,
          h("label", { className: "stack" }, h("span", { className: "label" }, t("reviewCurrentSource")), source),
          h("label", { className: "stack" }, h("span", { className: "label" }, t("reviewProposed")), proposed),
          data.type === "skill" ? note(t("reviewServicesDiff", { added: detail.validation.addedServices.join(", ") || t("reviewNone"),
            removed: detail.validation.removedServices.join(", ") || t("reviewNone") })) : null,
          data.type === "skill" ? note(t("reviewValidationNote")) : note(t("reviewMemoryAuthority")),
          candidate.appliedAt ? note(t("reviewAppliedAt", { time: when(candidate.appliedAt) })) : null,
          error, reload, h("div", { className: "personal-detail-actions" }, publish, reject, remove)),
        note(t("reviewHistoryNote")));
      return;
    }
    const pending = state.candidates.filter(candidate => ["pending", "needs_review"].includes(candidate.status)).length;
    const tabs = h("nav", { className: "personal-tabs memory-tabs", "aria-label": t("memorySections") },
      ...(["memory", "skills", "suggestions"] as const).map(value => h("a", { href: memoryHash(value), className: "personal-tab",
        "aria-current": tab === value ? "page" : null, "data-testid": `memory-tab-${value}` },
      t(value === "memory" ? "memory" : value === "skills" ? "memoryInstalledSkills" : "memorySuggestedChanges"),
      value === "suggestions" && pending > 0 ? h("span", { className: "personal-badge", "data-testid": "memory-pending" }, String(pending)) : null)));
    const intro = h("div", { className: "personal-intro" }, h("span", { className: "tag subtle" }, t("personalPreview")),
      note(t(tab === "suggestions" ? "reviewIntro" : "memoryManageIntro")));
    if (tab === "skills") {
      const installed = await skillsContent({ live: active, refresh, protectDraft: true, group: (title, rows) =>
        h("section", { className: "memory-skill-group" }, h("h2", { className: "personal-section-title" }, title), h("div", { className: "group" }, ...rows)) });
      if (!active()) return;
      if (!installed) throw new Error(t("personalDataInvalid"));
      frame(intro, tabs, note(t("memoryManualSkills")), ...installed);
      return;
    }
    const memoryPreview = state.memory.text.trim().replace(/\s+/g, " ");
    const clear = async () => {
      if (await ask({ title: t("reviewClearTitle"), message: t("reviewHistoryNote"), confirm: t("reviewClear"), destructive: true }) !== "confirm") return;
      await api("/api/review/memory", { method: "PUT", json: { text: "", expectedSourceRevision: state.memory.revision } });
      toast(t("saved")); refresh();
    };
    if (tab === "memory") {
      frame(intro, tabs, h("section", { className: "group personal-detail review-memory", "data-testid": "review-memory" },
        h("h2", {}, t("reviewCurrentMemory")), note(memoryPreview ? memoryPreview.slice(0, 240) : t("memoryEmpty")),
        note(t("reviewMemoryAuthority")), h("div", { className: "personal-detail-actions" },
          h("button", { type: "button", className: "button secondary", "data-testid": "review-memory-edit", onclick: () => editMemory(state.memory, refresh) }, t("edit")),
          h("button", { type: "button", className: "button secondary review-danger", "data-testid": "review-memory-clear", onclick: () => void clear().catch(failed) }, t("reviewClear")))),
      note(t("reviewHistoryNote")));
      return;
    }
    const toggle = h("button", { type: "button", className: "button secondary", "data-testid": "review-submissions-toggle", onclick: async () => {
      toggle.disabled = true;
      try { await api("/api/review/settings", { method: "PUT", json: { expectedRevision: state.settings.revision, suggestionsEnabled: !state.settings.suggestionsEnabled } }); refresh(); }
      catch (error) { failed(error); } finally { toggle.disabled = false; }
    } }, t(state.settings.suggestionsEnabled ? "reviewPause" : "reviewEnable"));
    const shown = state.candidates.filter(candidate => (filter === "all" || ["pending", "needs_review", "applying"].includes(candidate.status))
      && (kind === "all" || candidate.data.type === kind));
    const picker = h("select", { className: "field review-filter", "aria-label": t("reviewFilterKind"), "data-testid": "review-filter-kind",
      onchange: (event: Event) => { kind = (event.currentTarget as HTMLSelectElement).value as typeof kind; refresh(); } },
      h("option", { value: "all" }, t("todoAllFilter")), h("option", { value: "memory" }, t("memory")), h("option", { value: "skill" }, t("skills")));
    picker.value = kind;
    frame(intro, tabs,
      h("div", { className: "group review-policy-card" }, h("div", { className: "row review-policy" },
        h("div", { className: "row-text" }, h("strong", {}, t("reviewAssistantSubmissions")),
          h("span", { className: "muted small", "data-testid": "review-submissions-state" }, t(state.settings.suggestionsEnabled ? "reviewSubmissionsOn" : "reviewSubmissionsOff"))), toggle)),
      h("div", { className: "review-filters" }, h("div", { className: "personal-tabs", role: "group", "aria-label": t("reviewFilterStatus") },
        ...(["pending", "all"] as const).map(value => h("button", { type: "button", className: "personal-tab", "aria-pressed": String(filter === value),
          "data-testid": `review-filter-${value}`, onclick: () => { filter = value; refresh(); } }, t(value === "pending" ? "reviewPending" : "todoAllFilter")))), picker),
      shown.length ? h("div", { className: "group" }, ...shown.map(candidate => h("a", { href: `#/review/${candidate.id}`, className: "row notification-row",
        "data-testid": `review-open-${candidate.id}`, "data-review": candidate.id }, icon(candidate.data.type === "memory" ? "book" : "spark", 20),
        h("div", { className: "row-text" }, h("span", { className: "row-name" }, titleOf(candidate)),
          h("span", { className: "muted small clamp" }, candidate.reason), h("span", { className: "faint small" }, `${t(statuses[candidate.status])} · ${when(candidate.createdAt)}`)),
        icon("chevron", 16))))
        : h("div", { className: "personal-empty", "data-testid": "review-empty" }, h("h2", {}, t("reviewEmpty")), note(t("reviewDraftNote"))),
      note(t("reviewManualScope")), note(t("reviewLimit", { count: state.candidates.length, limit: state.limit })));
  } catch (error) {
    if (!active()) return;
    frame(h("div", { className: "personal-failure", role: "alert", "data-testid": "review-error" },
      h("h2", {}, t("personalLoadFailed")), note(hostText(error instanceof Error ? error.message : String(error))),
      h("button", { type: "button", className: "button secondary", "data-testid": "review-retry", onclick: refresh }, t("personalRetry"))));
  }
}

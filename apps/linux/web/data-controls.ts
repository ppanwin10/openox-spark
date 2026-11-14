import { api, APIError, download } from "./client";
import { h, icon, loader } from "./dom";
import { hostText, t, type StringKey } from "./i18n";
import type { Settings } from "./settings";
import { memoryHash } from "./review";
import type { ReviewCandidate } from "@openox/agent/linux";

type Intent = { kind: "import" | "reset"; requestId: string };
type Summary = { deleted: Record<string, number>; kept: Record<string, number> };
type Prepared = { requestId: string; confirmationId: string; inventory: string; profileId: string; epoch: number; summary: Summary };
type Preview = { token: string; format: string; sources: { id: string; role: string; text: string; label: string }[]; excludedMessages: number };
type ImportProof = { requestId: string; outcome: "committed" | "deleted" | "unconfirmed"; source: { selectedCount: number } | null; candidates: ReviewCandidate[] };
type ResetProof = { requestId: string; phase: string; complete: boolean; confirmed: boolean; summary?: Summary;
  progress?: { recorded: number; total: number; logicalContentCleared: boolean } };
const safeID = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const labels: Record<string, StringKey> = { conversations: "dcChats", tasks: "dcTasks", files: "files", todos: "dcTodos", notices: "notifications",
  review: "dcReview", watches: "dcWatches", goals: "museGoals", spaces: "museLibrary", discoveryItems: "dcDiscovery", approvalHistory: "museApprovals",
  schedules: "dcSchedules", credentials: "dcCredentials", profileIdentity: "dcWorkspaceIdentity", HostSettings: "dcSettings", devices: "devices", reviewSettings: "dcReviewSettings" };

export function mountDataControls(target: HTMLElement, settings: Settings, live: () => boolean) {
  const recoveryKey = `ox.data-controls.request.${settings.host.id}.${settings.profile.id}`;
  let intent: Intent | undefined, mode: "root" | "use" | "import" | "export" | "reset" | "proof" = "root", disposed = false, busy = false, view = 0;
  let stageId: string | undefined;
  const controllers = new Set<AbortController>();
  const active = () => !disposed && live() && target.isConnected;
  const controller = () => { const value = new AbortController(); controllers.add(value); return value; };
  const remember = (value: Intent | undefined) => {
    intent = value;
    try { if (value) sessionStorage.setItem(recoveryKey, JSON.stringify(value)); else sessionStorage.removeItem(recoveryKey); } catch {}
  };
  try {
    const text = sessionStorage.getItem(recoveryKey), value = text && text.length < 256 ? JSON.parse(text) : null;
    if (value && Object.keys(value).length === 2 && ["import", "reset"].includes(value.kind) && safeID(value.requestId)) intent = value;
  } catch {}
  const cancelStage = () => {
    const id = stageId; stageId = undefined;
    if (id) void api(`/api/data-controls/imports/${id}`, { method: "DELETE", keepalive: true }).catch(() => {});
  };
  const button = (text: string, testID: string, run: () => void, kind = "secondary") =>
    h("button", { type: "button", className: `button ${kind}`, "data-testid": testID, onclick: run }, text);
  const note = (text: string) => h("p", { className: "data-note" }, text);
  const error = () => h("p", { className: "form-error data-feedback", role: "alert", hidden: true, "data-testid": "data-error" });
  const showError = (element: HTMLElement, failure: unknown) => { element.textContent = hostText(failure instanceof Error ? failure.message : String(failure)); element.hidden = false; };
  const frame = (kind: typeof mode, ...nodes: Node[]) => {
    if (!active()) return;
    mode = kind; view++;
    target.replaceChildren(h("div", { className: `muse-data-page data-${kind}` }, ...nodes));
    target.scrollTop = 0;
  };
  const subhead = (title: string) => h("div", { className: "data-subhead" }, button(t("back"), "data-back", () => void root(false)), h("h3", {}, title));
  const list = (title: string, text: string) => h("section", { className: "data-scope-section" }, h("h4", {}, title), note(text));
  const counts = (values: Record<string, number>, testID: string) => {
    if (!values || Object.values(values).some(value => !Number.isSafeInteger(value) || value < 0)) throw new Error(t("personalDataInvalid"));
    return h("dl", { className: "data-counts", "data-testid": testID }, ...Object.entries(values).flatMap(([key, value]) =>
      [h("dt", {}, labels[key] ? t(labels[key]!) : key), h("dd", {}, String(value))]));
  };
  const scope = () => h("div", { className: "data-scope" },
    list(t("dcIncluded"), t("dcIncludedBody")), list(t("dcKept"), t("dcKeptBody")), note(t("dcNotBackup")));

  async function proof(value: Intent) {
    frame("proof", subhead(t(value.kind === "import" ? "dcImportResult" : "dcResetResult")));
    const version = view, failure = error(), status = h("p", { className: "data-feedback", role: "status", "data-testid": "data-outcome" }, t("dcUnverified"));
    const result = h("div", { "data-testid": value.kind === "import" ? "data-import-result" : "data-reset-result" });
    const verify = button(t("dcVerify"), "data-verify", () => void read());
    const clear = button(t("dcClearVerification"), "data-clear-verification", () => { remember(undefined); cancelStage(); void root(); });
    target.querySelector(".muse-data-page")!.append(status, result, failure, h("div", { className: "data-buttons" }, verify, clear));
    async function read() {
      if (busy || !active() || view !== version) return;
      busy = true; verify.disabled = true; failure.hidden = true; status.textContent = t("dcVerifying");
      const abort = controller();
      try {
        if (value.kind === "import") {
          const resultValue = await api<ImportProof>(`/api/data-controls/imports/requests/${value.requestId}`, { signal: abort.signal });
          if (!active() || view !== version) return;
          if (resultValue.requestId !== value.requestId || !["committed", "deleted", "unconfirmed"].includes(resultValue.outcome) || !Array.isArray(resultValue.candidates)) throw new Error(t("personalDataInvalid"));
          status.textContent = t(resultValue.outcome === "committed" ? "dcDraftsVerified" : resultValue.outcome === "deleted" ? "dcDraftsDeleted" : "dcNotConfirmed");
          result.replaceChildren(...resultValue.candidates.map(candidate => {
            if (!safeID(candidate.id) || candidate.data.type !== "memory" || candidate.origin.kind !== "manual") throw new Error(t("personalDataInvalid"));
            return h("article", { className: "data-review-row" }, h("p", {}, candidate.data.text),
              h("div", { className: "data-review-state" }, h("span", {}, hostText(candidate.status)), h("a", { className: "button secondary small",
                href: memoryHash("suggestions", candidate.id), "data-testid": `data-review-${candidate.id}` }, t("dcReviewOriginal"))));
          }), note(t("dcPublishIndividually")));
        } else {
          const resultValue = await api<ResetProof>(`/api/data-controls/resets/${value.requestId}`, { signal: abort.signal });
          if (!active() || view !== version) return;
          if (resultValue.requestId !== value.requestId || typeof resultValue.complete !== "boolean" || typeof resultValue.confirmed !== "boolean") throw new Error(t("personalDataInvalid"));
          status.textContent = t(resultValue.complete ? "dcResetComplete" : resultValue.confirmed ? "dcResetIncomplete" : "dcNotConfirmed");
          result.replaceChildren(...(resultValue.progress ? [note(t("dcResetProgress", { done: resultValue.progress.recorded, total: resultValue.progress.total }))] : []),
            ...(resultValue.summary ? [h("h4", {}, t(resultValue.complete ? "dcDeleted" : "dcWillDelete")), counts(resultValue.summary.deleted, "data-delete-counts"),
            h("h4", {}, t("dcKept")), counts(resultValue.summary.kept, "data-keep-counts")] : []), note(t("dcResetRecovery")), scope());
        }
      } catch (failureValue) { if (active() && view === version) { status.textContent = t("dcUnverified"); showError(failure, failureValue); } }
      finally {
        controllers.delete(abort);
        if (active() && view === version) { busy = false; verify.disabled = false; target.scrollTop = 0; }
      }
    }
    await read();
  }

  async function root(showProof = true) {
    cancelStage();
    frame("root", h("div", { className: "data-loading", "data-testid": "data-loading", role: "status" }, loader(20), t("personalLoading")));
    const version = view, abort = controller();
    try {
      const state = await api<{ version: number; profileId: string; collector: { available: boolean; sending: boolean }; resetPending: boolean }>("/api/data-controls", { signal: abort.signal });
      if (!active() || view !== version) return;
      if (state.version !== 1 || state.profileId !== settings.profile.id || state.collector?.available !== false || state.collector.sending !== false) throw new Error(t("personalDataInvalid"));
      if (intent && showProof) { await proof(intent); return; }
      const privacy = h("section", { className: "settings-card data-privacy", "data-testid": "muse-data-privacy" },
        icon("shield", 24), h("div", { className: "setting-text" }, h("div", { className: "setting-title" }, t("dcPrivacy")),
          h("div", { className: "setting-description" }, t("dcPrivacyBody")), h("button", { type: "button", className: "data-learn-more", "data-testid": "muse-data-learn-more", onclick: use }, t("dcLearnMore"))));
      const training = h("input", { type: "checkbox", role: "switch", className: "switch", disabled: true, "aria-label": t("dcTraining"), "aria-checked": "false",
        "data-testid": "muse-data-training", title: t("dcTrainingBody") });
      const action = (title: string, id: string, run: () => void) => h("button", { type: "button", className: "setting-row link-row", "data-testid": id,
        disabled: state.resetPending, onclick: run }, h("span", { className: "setting-text" }, h("span", { className: "setting-title" }, title)), icon("chevron", 16));
      frame("root", privacy,
        h("section", { className: "data-training" }, h("div", { className: "settings-card setting-row", "data-testid": "data-training-card" },
          h("span", { className: "setting-title" }, t("dcTraining")), training), h("p", { className: "data-root-note" }, t("dcTrainingBody"))),
        h("div", { className: "settings-card data-actions", "data-testid": "data-actions-card" },
          action(t("dcImport"), "muse-data-import", importView), action(t("dcExport"), "muse-data-export", exportView)),
        h("section", { className: "data-danger" }, h("button", { type: "button", className: "settings-card setting-row data-reset", "data-testid": "muse-data-reset",
          disabled: state.resetPending, onclick: () => void resetView() }, t("dcReset")), h("p", { className: "data-root-note" }, t("dcResetBody"))));
      if (intent) target.querySelector(".muse-data-page")!.append(button(t("dcVerify"), "data-verify-pending", () => void proof(intent!)));
    } catch (failure) {
      if (!active() || view !== version) return;
      const message = error(); showError(message, failure);
      frame("root", message, button(t("museRetry"), "data-retry", () => void root()));
    } finally { controllers.delete(abort); }
  }

  function use() {
    frame("use", subhead(t("dcContentUse")), h("div", { "data-testid": "data-use-details" },
      list(t("dcOnHost"), t("dcOnHostBody")), list(t("dcModelUse"), t("dcModelUseBody")), list(t("dcTraining"), t("dcTrainingBody")),
      list(t("dcProtection"), t("dcProtectionBody")), scope()));
  }

  function importView() {
    cancelStage(); remember(undefined);
    const failure = error(), preview = h("div", { "data-testid": "data-preview", hidden: true });
    const progress = h("div", { className: "data-loading", "data-testid": "data-loading", role: "status", hidden: true }, loader(20), t("dcReading"));
    const input = h("input", { type: "file", accept: ".txt,.md,.zip,.conversation", hidden: true, "aria-label": t("chooseFile"), "data-testid": "data-import-file" });
    const sourceName = h("p", { className: "data-note", "data-testid": "data-import-source", hidden: true });
    const selected = new Map<string, { sourceId: string; text: HTMLInputElement }>();
    const save = button(t("dcCreateDrafts"), "data-import-save", () => void commit(), "primary"); save.disabled = true;
    const cancel = button(t("cancel"), "data-import-cancel", () => { for (const abort of controllers) abort.abort(); busy = false; cancelStage(); void root(); });
    frame("import", subhead(t("dcImport")), note(t("dcImportBody")), note(t("dcImportLimits")),
      h("div", { className: "data-file-picker" }, h("label", { className: "button secondary data-file-button", "data-testid": "data-choose-file" }, t("chooseFile"), input), sourceName),
      progress, preview, failure, h("div", { className: "data-buttons" }, cancel, save));
    const version = view;
    const valid = () => selected.size > 0 && selected.size <= 20 && [...selected.values()].every(value => value.text.value.trim() && !/[\r\n\0]/.test(value.text.value) && value.text.value.length <= 1_000);
    input.addEventListener("change", async () => {
      const file = input.files?.[0]; input.value = "";
      if (!file || busy) return;
      cancelStage(); selected.clear(); save.disabled = true; preview.hidden = true; sourceName.hidden = true; failure.hidden = true; progress.hidden = false; busy = true;
      const id = crypto.randomUUID(); stageId = id;
      const abort = controller();
      try {
        const value = await api<Preview>(`/api/data-controls/imports?name=${encodeURIComponent(file.name)}&stageId=${id}`, { method: "POST", body: file, signal: abort.signal });
        if (!active() || view !== version) return;
        if (value.token !== id || !Array.isArray(value.sources) || value.sources.length > 2_000) throw new Error(t("personalDataInvalid"));
        sourceName.textContent = file.name; sourceName.hidden = false;
        preview.replaceChildren(note(t("dcPreviewPassive")), h("p", { className: "data-note", "data-testid": "data-preview-excluded" }, t("dcExcludedTurns", { count: value.excludedMessages })),
          ...value.sources.map(source => {
            if (!/^source-\d+$/.test(source.id) || !["user", "owner"].includes(source.role) || typeof source.text !== "string") throw new Error(t("personalDataInvalid"));
            const fact = h("input", { type: "text", className: "field", maxlength: 1_000, "aria-label": t("dcFact"), "data-testid": `data-fact-${source.id}`, hidden: true, autocomplete: "off" });
            const checkbox = h("input", { type: "checkbox", "data-testid": `data-source-select-${source.id}`, "aria-label": t("dcSelectFact") });
            checkbox.addEventListener("change", () => {
              fact.hidden = !checkbox.checked;
              if (checkbox.checked) {
                if (!fact.value && source.text.trim().length <= 1_000 && !/[\r\n]/.test(source.text.trim())) fact.value = source.text.trim();
                selected.set(source.id, { sourceId: source.id, text: fact }); fact.focus();
              } else selected.delete(source.id);
              save.disabled = !valid();
            });
            fact.addEventListener("input", () => { save.disabled = !valid(); });
            return h("article", { className: "data-source" }, h("label", { className: "data-source-label" }, checkbox, h("span", {}, source.label)),
              h("pre", { className: "data-source-text", "data-testid": `data-source-text-${source.id}` }, source.text), fact);
          }));
        preview.hidden = false;
      } catch (failureValue) { if (active() && view === version && !abort.signal.aborted) showError(failure, failureValue); }
      finally { controllers.delete(abort); if (active() && view === version) { progress.hidden = true; busy = false; input.disabled = false; } }
    });
    async function commit() {
      if (busy || !valid() || !stageId) return;
      const value: Intent = { kind: "import", requestId: crypto.randomUUID() }, id = stageId;
      const facts = [...selected.values()].map(fact => ({ sourceId: fact.sourceId, text: fact.text.value }));
      remember(value); busy = true; save.disabled = true; failure.hidden = true; input.disabled = true;
      const abort = controller();
      try {
        const receipt = await api<ImportProof>(`/api/data-controls/imports/${id}/candidates`, { method: "POST", json: { requestId: value.requestId, confirm: true, facts }, signal: abort.signal });
        if (!active() || view !== version) return;
        if (receipt.requestId !== value.requestId || receipt.outcome !== "committed" || receipt.candidates.length !== facts.length) throw new Error(t("personalDataInvalid"));
        stageId = undefined; selected.clear(); busy = false; await proof(value);
      } catch (failureValue) {
        if (!active() || view !== version) return;
        busy = false;
        if (failureValue instanceof APIError && failureValue.status >= 400 && failureValue.status < 500) {
          remember(undefined); showError(failure, failureValue); save.disabled = !valid(); input.disabled = false;
        } else await proof(value);
      } finally { controllers.delete(abort); }
    }
  }

  function exportView() {
    const failure = error(), state = h("p", { className: "data-feedback", role: "status", "data-testid": "data-download-state" });
    const start = button(t("dcDownload"), "data-export-download", () => void exportContent(), "primary");
    frame("export", subhead(t("dcExport")), h("div", { "data-testid": "data-export-scope" }, note(t("dcSensitiveExport")), scope(), note(t("dcExportLimits"))), state, failure, start);
    const version = view;
    async function exportContent() {
      if (busy) return;
      busy = true; start.disabled = true; failure.hidden = true; state.textContent = t("dcPreparingDownload");
      const abort = controller();
      try {
        await download("/api/data-controls/exports", "OpenOx-content.zip", { method: "POST", json: {}, signal: abort.signal });
        if (active() && view === version) state.textContent = t("dcDownloadStarted");
      } catch (failureValue) { if (active() && view === version && !abort.signal.aborted) { state.textContent = ""; showError(failure, failureValue); } }
      finally { controllers.delete(abort); busy = false; start.disabled = false; }
    }
  }

  async function resetView() {
    const failure = error(), pending = h("div", { className: "data-loading", "data-testid": "data-loading", role: "status" }, loader(20), t("dcReadingSummary"));
    frame("reset", subhead(t("dcReset")), pending, failure);
    const version = view, abort = controller();
    try {
      const prepared = await api<Prepared>("/api/data-controls/resets", { method: "POST", json: { requestId: crypto.randomUUID() }, signal: abort.signal });
      if (!active() || view !== version) return;
      if (!safeID(prepared.requestId) || !safeID(prepared.confirmationId) || prepared.profileId !== settings.profile.id || !Number.isSafeInteger(prepared.epoch)) throw new Error(t("personalDataInvalid"));
      const phrase = h("input", { type: "text", className: "field", autocomplete: "off", spellcheck: "false", "aria-label": t("dcPhrase"), "data-testid": "data-reset-phrase" });
      const confirm = button(t("dcConfirmReset"), "data-reset-confirm", () => void submit(), "danger"); confirm.disabled = true;
      const reload = button(t("dcReloadSummary"), "data-reset-reload", () => {
        void api(`/api/data-controls/resets/${prepared.requestId}`, { method: "DELETE" }).catch(() => {});
        void resetView();
      }); reload.hidden = true;
      const cancel = button(t("cancel"), "data-reset-cancel", () => {
        void api(`/api/data-controls/resets/${prepared.requestId}`, { method: "DELETE" }).catch(() => {}); void root();
      });
      phrase.addEventListener("input", () => { confirm.disabled = phrase.value !== "RESET" || busy; });
      frame("reset", subhead(t("dcReset")), h("p", { className: "data-workspace", "data-testid": "data-reset-workspace" }, t("dcWorkspace", { name: settings.profile.name })),
        note(t("dcResetWarning")), h("h4", {}, t("dcWillDelete")), counts(prepared.summary.deleted, "data-delete-counts"),
        h("h4", {}, t("dcKept")), counts(prepared.summary.kept, "data-keep-counts"), scope(),
        h("label", { className: "stack" }, h("span", { className: "label" }, t("dcPhrase")), phrase), failure,
        h("div", { className: "data-buttons" }, cancel, reload, confirm));
      const preparedView = view;
      async function submit() {
        if (busy || phrase.value !== "RESET") return;
        const value: Intent = { kind: "reset", requestId: prepared.requestId };
        remember(value); busy = true; confirm.disabled = true; cancel.disabled = true; phrase.disabled = true; failure.hidden = true;
        const submission = controller();
        try {
          const receipt = await api<ResetProof>(`/api/data-controls/resets/${prepared.requestId}/confirm`, { method: "POST",
            json: { confirmationId: prepared.confirmationId, inventory: prepared.inventory, profileId: prepared.profileId, epoch: prepared.epoch, confirm: true, phrase: "RESET" },
            signal: submission.signal });
          if (!active() || view !== preparedView) return;
          if (receipt.requestId !== value.requestId || !receipt.complete) throw new Error(t("dcUnverified"));
          busy = false; await proof(value);
        } catch (failureValue) {
          if (!active() || view !== preparedView) return;
          busy = false;
          if (failureValue instanceof APIError && failureValue.status >= 400 && failureValue.status < 500) {
            remember(undefined); showError(failure, failureValue); reload.hidden = false; cancel.disabled = false; phrase.value = ""; phrase.disabled = true;
          } else await proof(value);
        } finally { controllers.delete(submission); }
      }
    } catch (failureValue) {
      if (active() && view === version) { pending.hidden = true; showError(failure, failureValue);
        target.querySelector(".muse-data-page")!.append(button(t("museRetry"), "data-reset-reload", () => void resetView())); }
    } finally { controllers.delete(abort); }
  }

  void root();
  return { target, refresh: () => { if (mode === "root" && !busy) void root(); },
    dispose: () => { disposed = true; for (const abort of controllers) abort.abort(); controllers.clear(); cancelStage(); target.querySelectorAll<HTMLInputElement>("input").forEach(input => { input.value = ""; }); } };
}

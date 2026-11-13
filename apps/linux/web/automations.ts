import type { WatchView } from "@openox/agent/linux";
import { api, APIError, ask, failed, formDialog, menu, toast } from "./client";
import { editSchedule, keepFocus, scheduleListRow, type PageHost, type ScheduleRow } from "./capabilities";
import { h, icon, loader } from "./dom";
import { hostText, locale, t, type StringKey } from "./i18n";

export type WatchSummary = { available: false } | { available: true; total: number; enabled: number; failed: number; running: number; limit: number; warning: string | null };
export type AutomationSummary = { available: false } | (Extract<WatchSummary, { available: true }> & { scheduledAttention: number });
type State = { available: boolean; watches: WatchView[]; running: number; warning: string | null; limit: number };
const outcomes: Record<WatchView["lastOutcome"], StringKey> = {
  never: "watchNever", baseline: "watchBaseline", unchanged: "watchUnchanged", changed: "watchChanged", failed: "watchFailed", interrupted: "watchInterrupted",
};
let generation = 0;
let filter: "all" | "schedule" | "watch" = "all";
const note = (text: string) => h("p", { className: "personal-note" }, text);
const when = (value: string | null) => value === null ? t("watchNotYet") : new Date(value).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });
export const closeAutomationsView = () => { generation++; };

export async function loadWatchSummary(): Promise<WatchSummary> {
  try {
    const result = await api<WatchSummary>("/api/watches?summary=1", { signal: AbortSignal.timeout(10_000) });
    if (result.available === false) return result;
    if (result.available !== true || ![result.total, result.enabled, result.failed, result.running, result.limit].every(value => Number.isSafeInteger(value) && value >= 0)
      || result.warning !== null && typeof result.warning !== "string") throw new Error(t("personalDataInvalid"));
    return result;
  } catch (error) { if (error instanceof APIError && error.status === 404) return { available: false }; throw error; }
}

export async function loadAutomationSummary(): Promise<AutomationSummary> {
  const watches = await loadWatchSummary();
  if (!watches.available) return watches;
  const schedules = await api<{ total: number; enabled: number; attention: number }>("/api/schedules?summary=1", { signal: AbortSignal.timeout(10_000) });
  if (![schedules.total, schedules.enabled, schedules.attention].every(value => Number.isSafeInteger(value) && value >= 0)) throw new Error(t("personalDataInvalid"));
  return { ...watches, total: watches.total + schedules.total, enabled: watches.enabled + schedules.enabled, scheduledAttention: schedules.attention };
}

function editWatch(watch?: WatchView) {
  const key = crypto.randomUUID();
  return formDialog({ title: t(watch ? "watchEdit" : "watchNew"), message: t("watchScope"), testID: "watch-editor", protectDraft: true,
    confirm: t("save"), fields: [
      { name: "name", label: t("watchName"), value: watch?.name, testID: "watch-name" },
      { name: "url", label: t("watchUrl"), kind: "url", value: watch?.url, help: t("watchUrlHelp"), testID: "watch-url" },
      { name: "selector", label: t("watchSelector"), value: watch?.selector ?? "", placeholder: "main", help: t("watchSelectorHelp"), testID: "watch-selector" },
      { name: "interval", label: t("watchInterval"), value: String(watch?.intervalMinutes ?? 30), help: t("watchIntervalHelp"), testID: "watch-interval" },
      { name: "enabled", label: t("watchEnable"), kind: "switch", checked: watch?.enabled ?? false, help: t("watchConsent"), testID: "watch-enabled" },
    ],
    submit: async values => {
      const body = { name: String(values.name), url: String(values.url), selector: String(values.selector).trim() || null,
        intervalMinutes: Number(values.interval), enabled: values.enabled === true };
      try {
        await api(watch ? `/api/watches/${watch.id}` : "/api/watches", {
          method: watch ? "PATCH" : "POST", headers: watch ? {} : { "idempotency-key": key },
          json: watch ? { ...body, expectedRevision: watch.revision } : body,
        });
      } catch (error) {
        if (error instanceof TypeError) throw new Error(t(watch ? "watchEditUnknown" : "watchSaveUnknown"));
        throw error;
      }
      toast(t("saved"));
    } });
}

export async function renderAutomations(context: PageHost, id: string | null) {
  closeAutomationsView();
  const version = generation, hash = location.hash;
  const active = () => version === generation && ["automations", "schedules"].includes(context.route()) && location.hash === hash && context.main.isConnected;
  const refresh = () => { if (active()) void renderAutomations(context, id); };
  let available = false;
  const frame = (...children: (Node | null)[]) => {
    if (!active()) return;
    const restore = keepFocus(context.main), scroll = context.main.querySelector(".automations-page")?.scrollTop ?? 0;
    const create = available && id === null ? h("button", { type: "button", className: "button secondary", "data-testid": "automation-new", "aria-haspopup": "menu",
      onclick: (event: Event) => menu(event.currentTarget as HTMLElement, [
        { label: t("automationNewSchedule"), icon: "clock", testID: "automation-new-schedule", run: () => void editSchedule(undefined, true).then(refresh).catch(failed) },
        { label: t("watchNew"), icon: "globe", testID: "automation-new-watch", run: () => void editWatch().then(refresh).catch(failed) },
      ]) }, icon("plus", 16), t("activityManualSetup")) : null;
    context.main.replaceChildren(context.topbar(t("personalActivity"), create),
      h("div", { className: "page personal-page automations-page", "data-testid": "automations-page" }, h("div", { className: "personal-content" }, ...children)));
    context.main.querySelector(".automations-page")!.scrollTop = scroll; restore();
  };
  if (!context.main.querySelector(".automations-page")) frame(h("div", { className: "page-loading", role: "status", "aria-label": t("personalLoading") }, loader(24)));
  try {
    const state = await api<State>("/api/watches", { signal: AbortSignal.timeout(15_000) });
    if (!active()) return;
    if (state.available === false) {
      frame(h("div", { className: "personal-empty", "data-testid": "automations-unavailable" }, h("h2", {}, t("personalUnavailable")), note(t("personalUnavailableBody")))); return;
    }
    if (state.available !== true || !Array.isArray(state.watches) || !Number.isSafeInteger(state.running)) throw new Error(t("personalDataInvalid"));
    available = true;
    if (id) {
      const watch = await api<WatchView>(`/api/watches/${encodeURIComponent(id)}`);
      if (!active()) return;
      if (!Object.hasOwn(outcomes, watch.lastOutcome) || typeof watch.enabled !== "boolean" || typeof watch.url !== "string") throw new Error(t("personalDataInvalid"));
      let busy = false;
      const error = h("p", { className: "form-error", role: "alert", hidden: true, "data-testid": "watch-action-error" });
      const reload = h("button", { type: "button", className: "button secondary", hidden: true, "data-testid": "watch-reload", onclick: refresh }, t("todoReload"));
      const buttons: HTMLButtonElement[] = [];
      const action = (label: string, testID: string, run: () => Promise<unknown>, destructive = false) => {
        const button = h("button", { type: "button", className: `button ${destructive ? "danger" : "secondary"}`, "data-testid": testID, onclick: async () => {
          if (busy) return;
          busy = true; buttons.forEach(control => { control.disabled = true; });
          try { await run(); }
          catch (failure) { error.textContent = hostText(failure instanceof Error ? failure.message : String(failure)); error.hidden = false; reload.hidden = false; }
          finally { busy = false; buttons.forEach(control => { control.disabled = control === check && (watch.checking || state.running > 0); }); }
        } }, label);
        buttons.push(button); return button;
      };
      const check = action(t("watchCheckNow"), "watch-check", async () => {
        await api(`/api/watches/${watch.id}/check`, { method: "POST", json: { expectedRevision: watch.revision } }); refresh();
      });
      check.disabled = watch.checking || state.running > 0;
      const edit = action(t("edit"), "watch-edit", async () => { await editWatch(watch); refresh(); });
      const toggle = action(t(watch.enabled ? "watchPause" : "watchResume"), "watch-toggle", async () => {
        if (!watch.enabled && await ask({ title: t("watchResumeTitle"), message: t("watchConsent"), confirm: t("watchResume") }) !== "confirm") return;
        await api(`/api/watches/${watch.id}`, { method: "PATCH", json: { expectedRevision: watch.revision, enabled: !watch.enabled } }); refresh();
      });
      const remove = action(t("delete"), "watch-delete", async () => {
        if (await ask({ title: t("watchDeleteTitle"), message: t("watchDeleteBody"), confirm: t("delete"), destructive: true }) !== "confirm") return;
        await api(`/api/watches/${watch.id}`, { method: "DELETE", json: { expectedRevision: watch.revision } }); location.hash = "#/activity";
      }, true);
      const fact = (label: string, value: string) => h("div", {}, h("dt", {}, label), h("dd", {}, value));
      frame(h("a", { href: "#/activity", className: "personal-back", "data-testid": "watch-back" }, icon("back", 16), t("personalActivity")),
        h("article", { className: "group personal-detail watch-detail", "data-testid": "watch-detail" },
          h("span", { className: "tag subtle", "data-testid": "watch-state" }, t(watch.enabled ? "watchEnabled" : "watchPaused")),
          h("h2", {}, watch.name), h("a", { href: watch.url, target: "_blank", rel: "noopener noreferrer", className: "personal-back watch-source", "data-testid": "watch-source" }, watch.url),
          note(t("watchScope")), h("dl", { className: "watch-facts" },
            fact(t("watchSelector"), watch.selector ?? t("watchWholePage")), fact(t("watchInterval"), t("watchEveryMinutes", { count: watch.intervalMinutes })),
            fact(t("watchLastAttempt"), when(watch.lastCheckedAt)), fact(t("watchLastSuccess"), when(watch.lastSuccessAt)),
            fact(t("watchNextCheck"), when(watch.nextCheckAt)), fact(t("watchLastChange"), when(watch.lastChangedAt))),
          h("p", { className: `personal-note${["failed", "interrupted"].includes(watch.lastOutcome) ? " error-text" : ""}`, "data-testid": "watch-outcome" }, t(watch.checking ? "watchChecking" : outcomes[watch.lastOutcome])),
          watch.lastError ? h("p", { className: "personal-note error-text", "data-testid": "watch-last-error" }, hostText(watch.lastError)) : null,
          watch.characters === null ? null : note(t("watchCharacters", { count: watch.characters })),
          error, reload, h("div", { className: "personal-detail-actions" }, check, edit, toggle, remove)),
        note(t("watchConsent")), note(t("watchNoArchive")));
      return;
    }
    const scheduled = await api<{ schedules: ScheduleRow[] }>("/api/schedules", { signal: AbortSignal.timeout(15_000) });
    if (!active()) return;
    if (!Array.isArray(scheduled.schedules)) throw new Error(t("personalDataInvalid"));
    const jobs = [...scheduled.schedules.map(value => ({ type: "schedule" as const, value })), ...state.watches.map(value => ({ type: "watch" as const, value }))]
      .filter(job => filter === "all" || job.type === filter).sort((a, b) => a.value.name.localeCompare(b.value.name) || a.value.id.localeCompare(b.value.id));
    const watchRow = (watch: WatchView) => h("a", { href: `#/activity/watches/${watch.id}`, className: "row notification-row",
      "data-testid": `watch-open-${watch.id}`, "data-watch": watch.id, "data-automation-type": "watch" }, h("span", { className: "row-icon" }, icon("globe", 18)),
      h("div", { className: "row-text" }, h("div", { className: "row-heading" }, h("span", { className: "row-name" }, watch.name),
        h("span", { className: "tag subtle automation-kind" }, t("automationWatch"))), h("span", { className: "muted small clamp" }, watch.url),
        h("span", { className: "faint small" }, `${t(watch.enabled ? "watchEnabled" : "watchPaused")} · ${t(watch.checking ? "watchChecking" : outcomes[watch.lastOutcome])}`)), icon("chevron", 16));
    frame(h("div", { className: "personal-intro" }, h("span", { className: "tag subtle" }, t("personalPreview")), note(t("activityScope"))),
      h("section", { className: "activity-start", "data-testid": "activity-start" },
        h("h2", { className: "personal-section-title" }, t("automationScheduled")), note(t("automationIntro")),
        h("button", { type: "button", className: "button primary", "data-testid": "activity-ask",
          onclick: () => context.draftChat(t("activityTaskDraft")) }, icon("pencil", 16), t("activityAsk"))),
      state.warning ? h("p", { className: "personal-note error-text" }, hostText(state.warning)) : null,
      h("div", { className: "personal-tabs automation-filters", role: "group", "aria-label": t("automationFilter") },
        ...(["all", "schedule", "watch"] as const).map(value => h("button", { type: "button", className: "personal-tab", "aria-pressed": String(filter === value),
          "data-testid": `automation-filter-${value}`, onclick: () => { filter = value; refresh(); } },
        t(value === "all" ? "todoAllFilter" : value === "schedule" ? "automationScheduled" : "automationWatch")))),
      jobs.length ? h("div", { className: "group", "data-testid": "automation-list" }, ...jobs.map(job => job.type === "schedule"
        ? scheduleListRow(job.value, refresh, { triggerLabel: t("automationScheduled"), protectDraft: true }) : watchRow(job.value)))
        : h("div", { className: "personal-empty", "data-testid": "automations-empty" }, h("h2", {}, t(scheduled.schedules.length + state.watches.length ? "automationEmptyFilter" : "automationEmpty")),
          note(t(scheduled.schedules.length + state.watches.length ? "automationNoMatches" : "automationEmptyBody"))),
      note(t("automationKindsBody")), note(t("automationCounts", { schedules: scheduled.schedules.length, watches: state.watches.length })));
  } catch (error) {
    if (!active()) return;
    frame(h("div", { className: "personal-failure", role: "alert", "data-testid": "automations-error" }, h("h2", {}, t("personalLoadFailed")),
      note(hostText(error instanceof Error ? error.message : String(error))),
      h("button", { type: "button", className: "button secondary", "data-testid": "automations-retry", onclick: refresh }, t("personalRetry"))));
  }
}

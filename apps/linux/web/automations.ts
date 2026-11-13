import type { WatchView } from "@openox/agent/linux";
import { api, APIError, ask, formDialog, toast } from "./client";
import { keepFocus, type PageHost } from "./capabilities";
import { h, icon, loader } from "./dom";
import { hostText, locale, t, type StringKey } from "./i18n";

export type WatchSummary = { available: false } | { available: true; total: number; enabled: number; failed: number; running: number; limit: number; warning: string | null };
type State = { available: boolean; watches: WatchView[]; running: number; warning: string | null; limit: number };
const outcomes: Record<WatchView["lastOutcome"], StringKey> = {
  never: "watchNever", baseline: "watchBaseline", unchanged: "watchUnchanged", changed: "watchChanged", failed: "watchFailed", interrupted: "watchInterrupted",
};
let generation = 0;
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
  const active = () => version === generation && context.route() === "automations" && location.hash === hash && context.main.isConnected;
  const refresh = () => { if (active()) void renderAutomations(context, id); };
  let available = false;
  const frame = (...children: (Node | null)[]) => {
    if (!active()) return;
    const restore = keepFocus(context.main), scroll = context.main.querySelector(".automations-page")?.scrollTop ?? 0;
    const create = available && id === null ? h("button", { type: "button", className: "button primary", "data-testid": "watch-new",
      onclick: () => void editWatch().then(refresh) }, icon("plus", 16), t("add")) : null;
    context.main.replaceChildren(context.topbar(t("personalAutomations"), create),
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
        await api(`/api/watches/${watch.id}`, { method: "DELETE", json: { expectedRevision: watch.revision } }); location.hash = "#/automations";
      }, true);
      const fact = (label: string, value: string) => h("div", {}, h("dt", {}, label), h("dd", {}, value));
      frame(h("a", { href: "#/automations", className: "personal-back", "data-testid": "watch-back" }, icon("back", 16), t("personalAutomations")),
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
    frame(h("div", { className: "personal-intro" }, h("span", { className: "tag subtle" }, t("personalPreview")), note(t("watchIntro"))),
      h("a", { href: "#/schedules", className: "group row notification-row watch-schedules", "data-testid": "automations-schedules" }, icon("spark", 20),
        h("div", { className: "row-text" }, h("strong", {}, t("schedules")), h("span", { className: "muted small" }, t("watchSchedulesBody"))), icon("chevron", 16)),
      state.warning ? h("p", { className: "personal-note error-text" }, hostText(state.warning)) : null,
      h("h2", { className: "personal-section-title" }, t("watchPublicPages")),
      state.watches.length ? h("div", { className: "group" }, ...state.watches.map(watch => h("a", { href: `#/automations/${watch.id}`, className: "row notification-row",
        "data-testid": `watch-open-${watch.id}`, "data-watch": watch.id }, icon("globe", 20),
        h("div", { className: "row-text" }, h("span", { className: "row-name" }, watch.name), h("span", { className: "muted small clamp" }, watch.url),
          h("span", { className: "faint small" }, `${t(watch.enabled ? "watchEnabled" : "watchPaused")} · ${t(watch.checking ? "watchChecking" : outcomes[watch.lastOutcome])}`)), icon("chevron", 16))))
        : h("div", { className: "personal-empty", "data-testid": "watches-empty" }, h("h2", {}, t("watchEmpty")), note(t("watchEmptyBody"))),
      note(t("watchScope")), note(t("watchLimit", { count: state.watches.length, limit: state.limit })));
  } catch (error) {
    if (!active()) return;
    frame(h("div", { className: "personal-failure", role: "alert", "data-testid": "automations-error" }, h("h2", {}, t("personalLoadFailed")),
      note(hostText(error instanceof Error ? error.message : String(error))),
      h("button", { type: "button", className: "button secondary", "data-testid": "automations-retry", onclick: refresh }, t("personalRetry"))));
  }
}

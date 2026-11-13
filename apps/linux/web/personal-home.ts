import { api } from "./client";
import { keepFocus, type PageHost } from "./capabilities";
import { h, icon, loader, type IconName } from "./dom";
import { hostText, locale, t } from "./i18n";
import type { Settings } from "./settings";
import { loadPersonalSummary } from "./personal-agent";
import { loadReviewSummary } from "./review";
import { loadWatchSummary } from "./automations";

type Tasks = { available: boolean; total: number; open: number; completed: number; warning: string | null };
let generation = 0;
export const closeHomeView = () => { generation++; };
const note = (text: string) => h("p", { className: "personal-note" }, text);

export async function renderHome(context: PageHost) {
  closeHomeView();
  const version = generation;
  const active = () => version === generation && context.route() === "home" && context.main.isConnected;
  const refresh = () => { if (active()) void renderHome(context); };
  const frame = (...children: (Node | null)[]) => {
    if (!active()) return;
    const restore = keepFocus(context.main), scroll = context.main.querySelector(".home-page")?.scrollTop ?? 0;
    context.main.replaceChildren(context.topbar(t("personalHome"), h("a", { href: "#/", className: "button secondary", "data-testid": "home-chat" }, icon("pencil", 16), t("homeOpenChat"))),
      h("div", { className: "page personal-page home-page", "data-testid": "home-page" }, h("div", { className: "personal-content" }, ...children)));
    context.main.querySelector(".home-page")!.scrollTop = scroll; restore();
  };
  if (!context.main.querySelector(".home-page")) frame(h("div", { className: "page-loading", role: "status", "aria-label": t("personalLoading") }, loader(24)));
  try {
    const tasks = await api<Tasks>("/api/todos?summary=1", { signal: AbortSignal.timeout(15_000) });
    if (!active()) return;
    if (tasks.available === false) {
      frame(h("div", { className: "personal-empty", "data-testid": "home-unavailable" }, h("h2", {}, t("personalUnavailable")), note(t("personalUnavailableBody")))); return;
    }
    if (tasks.available !== true || ![tasks.total, tasks.open, tasks.completed].every(value => Number.isSafeInteger(value) && value >= 0)) throw new Error(t("personalDataInvalid"));
    const [settings, inbox, review, watches] = await Promise.all([api<Settings>("/api/settings"), loadPersonalSummary(), loadReviewSummary(), loadWatchSummary()]);
    if (!active()) return;
    const selected = settings.defaultModel;
    const row = (title: string, description: string, count: number | null, href: string, symbol: IconName, testID: string) => h("a", {
      href, className: "row home-row", "data-testid": testID,
    }, icon(symbol, 22), h("div", { className: "row-text" }, h("strong", {}, title), h("span", { className: "muted small" }, description)),
    count === null ? null : h("span", { className: "home-count" }, String(count)), icon("chevron", 16));
    const control = (label: string, href: string, symbol: IconName, testID: string) => h("a", { href, className: "button secondary", "data-testid": testID }, icon(symbol, 16), label);
    frame(h("div", { className: "personal-intro" }, h("span", { className: "tag subtle" }, t("personalPreview")), note(t("homeIntro"))),
      h("section", { className: "group personal-detail home-readiness", "data-testid": "home-readiness" },
        h("div", { className: "home-host-line" }, icon("host", 18), h("span", { title: settings.host.id }, t("homeHostReached"))),
        h("h2", {}, t(selected ? "homeModelSelected" : "homeModelMissing")),
        selected ? h("p", { className: "personal-detail-body", "data-testid": "home-model-choice" }, `${selected.provider} / ${selected.modelId}`) : null,
        note(t(selected ? "homeModelUnverified" : "homeModelSetupBody")),
        h("a", { href: "#/settings/models", className: "button primary", "data-testid": "home-model-setup" }, t(selected ? "homeManageModels" : "homeConnectModel")),
        note(t("homeLastRead", { time: new Date().toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" }), version: settings.host.version }))),
      h("h2", { className: "personal-section-title" }, t("homeWorkspace")),
      h("nav", { className: "group", "aria-label": t("homeWorkspace"), "data-testid": "home-destinations" },
        row(t("todoTasks"), t("homeTasksBody"), tasks.open, "#/todos", "check", "home-tasks"),
        inbox.available ? row(t("noticeInbox"), t("homeInboxBody"), inbox.unreadCount, "#/inbox", "inbox", "home-inbox") : null,
        watches.available ? row(t("personalAutomations"), t("homeAutomationsBody"), watches.enabled, "#/automations", "clock", "home-automations") : null,
        review.available ? row(t("reviewTitle"), t("homeReviewBody"), review.pending, "#/review", "shield", "home-review") : null),
      ...[tasks.warning, inbox.available ? inbox.warning : null, watches.available ? watches.warning : null].filter((value): value is string => !!value)
        .map(warning => h("p", { className: "personal-note error-text" }, hostText(warning))),
      watches.available && watches.failed ? note(t("homeFailedWatches", { count: watches.failed })) : null,
      h("h2", { className: "personal-section-title" }, t("homeControls")),
      h("div", { className: "home-controls" },
        control(t("models"), "#/settings/models", "spark", "home-models"),
        control(t("secrets"), "#/settings/secrets", "key", "home-credentials"),
        control(t("services"), "#/settings/services", "plug", "home-services"),
        control(t("permissions"), "#/settings/permissions", "shield", "home-permissions"),
        control(t("settingsProfile"), "#/settings/profile", "user", "home-workspace")),
      note(t("homeHostAwake")), note(t("homeMemoryScope")));
  } catch (error) {
    if (!active()) return;
    frame(h("div", { className: "personal-failure", role: "alert", "data-testid": "home-error" }, h("h2", {}, t("personalLoadFailed")),
      note(hostText(error instanceof Error ? error.message : String(error))),
      h("button", { type: "button", className: "button secondary", "data-testid": "home-retry", onclick: refresh }, t("personalRetry"))));
  }
}

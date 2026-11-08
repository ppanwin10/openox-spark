import { api, ask, failed, formDialog, menu, relativeTime, toast, type MenuItem } from "./client";
import { h, icon, type IconName } from "./dom";
import { locale, t, type StringKey } from "./i18n";

type ServiceRow = { id: string; kind: string; domain: string; name: string; description?: string; faviconUrl?: string | null; repository: string;
  available: boolean; unavailableReason?: string; supportsLogin: boolean; alwaysApproved: string[] };
type RepositoryRow = { id: string; name: string; kind: "bundled" | "local" | "git"; url: string | null; enabled: boolean; syncedAt: number | string | null;
  commit: string | null; error: string | null; services: number; skills: number };
type SecretRow = { key: string; name: string; fields: string[]; available: boolean };
type Recurrence = Record<string, unknown> & { kind?: string; type?: string };
type ScheduleRow = { id: string; name: string; prompt: string; recurrence: Recurrence | string; summary?: string; state: string; nextFireAt: number | string | null; lastRunAt: number | string | null;
  lastOutcome: string | { outcome?: string; kind?: string; status?: string } | null; lastError?: string | null; conversationId: number | string | null };
export interface PageHost { main: HTMLElement; topbar(title: string, ...actions: (Node | null)[]): HTMLElement; openPage(id: string): void; route(): string }

const time = (value: number | string | null | undefined) => {
  if (value === null || value === undefined) return null;
  const milliseconds = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(milliseconds) ? milliseconds : null;
};
const when = (value: number | string | null | undefined, timeZone?: unknown) => {
  const milliseconds = time(value);
  if (milliseconds === null) return "";
  const date = new Date(milliseconds), now = Date.now(), zone = typeof timeZone === "string" && timeZone ? { timeZone } : {};
  return Math.abs(milliseconds - now) < 6 * 86_400_000 && milliseconds > now
    ? date.toLocaleString(locale, { weekday: "short", hour: "numeric", minute: "2-digit", ...zone }) : relativeTime(milliseconds) || date.toLocaleString(locale, zone);
};
const hue = (text: string) => [...text].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) % 360, 7);
const avatar = (name: string, domain: string) => h("span", { className: "avatar", style: `--avatar-hue: ${hue(domain)}` }, (name || domain).trim().charAt(0).toUpperCase());
const repositoryLabel = (id: string, repositories: RepositoryRow[]) => id === "bundled" ? t("builtIn") : id === "local" ? t("localRepository")
  : repositories.find(repository => repository.id === id)?.name ?? id;
const section = (title: string, body: string | null, ...children: (Node | null)[]) =>
  h("section", { className: "settings-section" }, h("h2", {}, title), body ? h("p", { className: "muted section-body" }, body) : null, h("div", { className: "group" }, ...children));
const emptyRow = (text: string, testID: string) => h("div", { className: "row" }, h("span", { className: "muted", "data-testid": testID }, text));
const more = (label: string, testID: string, items: () => MenuItem[]) => h("button", { type: "button", className: "icon-button", "aria-label": `${t("moreOptions")}: ${label}`, title: t("moreOptions"),
  "aria-haspopup": "menu", "data-testid": testID, onclick: (event: Event) => menu(event.currentTarget as HTMLElement, items()) }, icon("more"));
const loading = (context: PageHost, title: string) => {
  context.main.replaceChildren(context.topbar(title), h("div", { className: "page" }, h("div", { className: "page-loading" }, h("span", { className: "spinner", "aria-hidden": "true" }))));
};
const failure = (context: PageHost, title: string, error: unknown) => {
  context.main.replaceChildren(context.topbar(title), h("div", { className: "page" }, h("p", { className: "form-error", role: "alert" }, error instanceof Error ? error.message : String(error))));
};

export async function renderServices(context: PageHost, query = "") {
  if (!context.main.querySelector(".services-page")) loading(context, t("services"));
  let services: ServiceRow[], repositories: RepositoryRow[], secrets: SecretRow[];
  try {
    [services, repositories, secrets] = await Promise.all([
      api<{ services: ServiceRow[] }>("/api/services").then(value => value.services),
      api<{ repositories: RepositoryRow[] }>("/api/repositories").then(value => value.repositories),
      api<{ secrets: SecretRow[] }>("/api/secrets").then(value => value.secrets),
    ]);
  } catch (error) { failure(context, t("services"), error); return; }
  if (context.route() !== "services") return;
  const search = h("input", { className: "field search-field", type: "search", value: query, placeholder: t("searchServices"), "aria-label": t("searchServices"),
    autocomplete: "off", autocapitalize: "off", spellcheck: "false", "data-testid": "service-search" });
  const lists = h("div", {});
  const draw = () => {
    const needle = search.value.trim().toLowerCase();
    const matches = services.filter(service => !needle || `${service.name} ${service.domain} ${service.description ?? ""}`.toLowerCase().includes(needle))
      .sort((a, b) => a.name.localeCompare(b.name, locale));
    const available = matches.filter(service => service.available), unavailable = matches.filter(service => !service.available);
    lists.replaceChildren(
      section(t("availableServices"), null, ...(available.length ? available.map(service => serviceRow(service, repositories, context)) : [emptyRow(t("noServicesMatch"), "services-empty")])),
      ...(unavailable.length ? [section(t("unavailableServices"), null, ...unavailable.map(service => serviceRow(service, repositories, context)))] : []));
  };
  search.addEventListener("input", draw);
  draw();
  const url = h("input", { className: "field", type: "url", placeholder: t("repositoryURL"), inputmode: "url", autocapitalize: "off", spellcheck: "false",
    "aria-label": t("connectRepository"), required: true, "data-testid": "repository-url" });
  const refresh = () => void renderServices(context, search.value);
  context.main.replaceChildren(context.topbar(t("services")), h("div", { className: "page services-page", "data-testid": "services-page" },
    h("div", { className: "search-bar" }, search), lists,
    section(t("repositories"), t("repositoriesBody"),
      ...repositories.map(repository => repositoryRow(repository, refresh)),
      h("form", { className: "row form-row", onsubmit: async (event: Event) => {
        event.preventDefault();
        const button = (event.target as HTMLFormElement).querySelector("button")!;
        button.disabled = true;
        await api("/api/repositories", { method: "POST", json: { url: url.value.trim() } }).then(() => { toast(t("synced")); refresh(); }, failed);
        button.disabled = false;
      } }, h("div", { className: "label" }, t("connectRepository")), url, h("button", { type: "submit", className: "button primary", "data-testid": "repository-connect" }, t("connect")))),
    section(t("secrets"), t("secretsBody"), ...(secrets.length ? secrets.map(secret => h("div", { className: "row", "data-testid": "secret-row" },
      h("div", { className: "row-text" }, h("div", {}, secret.name || secret.key), h("div", { className: "muted small" }, secret.fields.join(", "))),
      h("button", { type: "button", className: "button secondary small", onclick: async () => {
        if (await ask({ title: t("deleteSecretTitle", { name: secret.name || secret.key }), message: t("deleteSecretBody"), confirm: t("delete"), destructive: true }) !== "confirm") return;
        await api(`/api/secrets/${encodeURIComponent(secret.key)}`, { method: "DELETE" }).then(refresh, failed);
      } }, t("delete")))) : [emptyRow(t("noSecrets"), "secrets-empty")]))));
  if (query) { search.focus(); search.setSelectionRange(query.length, query.length); }
}

function serviceRow(service: ServiceRow, repositories: RepositoryRow[], context: PageHost) {
  const actions = service.available ? [
    service.supportsLogin ? h("button", { type: "button", className: "button secondary small", "data-testid": `sign-in-${service.domain}`, onclick: async (event: Event) => {
      const button = event.currentTarget as HTMLButtonElement;
      button.disabled = true;
      await api<{ page: { id: string } }>(`/api/services/${encodeURIComponent(service.domain)}/login`, { method: "POST" }).then(({ page }) => context.openPage(page.id), failed);
      button.disabled = false;
    } }, t("signIn")) : null,
    service.alwaysApproved.length ? h("button", { type: "button", className: "button secondary small", title: t("alwaysApprovedCount", { count: service.alwaysApproved.length }), onclick: async () => {
      await api(`/api/services/${encodeURIComponent(service.domain)}/approvals`, { method: "DELETE" }).then(() => { toast(t("approvalsReset")); void renderServices(context); }, failed);
    } }, t("resetApprovals")) : null,
  ].filter(Boolean) : [];
  return h("div", { className: `row service-row${service.available ? "" : " unavailable"}`, "data-testid": "service-row" },
    avatar(service.name, service.domain),
    h("div", { className: "row-text" },
      h("div", { className: "row-heading" }, h("span", { className: "row-name" }, service.name), h("span", { className: "tag subtle" }, repositoryLabel(service.repository, repositories))),
      h("div", { className: "muted small" }, service.domain),
      service.available ? (service.description ? h("div", { className: "muted small clamp" }, service.description) : null)
        : h("div", { className: "muted small" }, service.unavailableReason ?? t("unavailableServices"))),
    actions.length ? h("div", { className: "row-actions" }, ...actions) : null);
}

function repositoryRow(repository: RepositoryRow, refresh: () => void) {
  const kind = repository.kind === "bundled" ? t("builtIn") : repository.kind === "local" ? t("localRepository") : t("gitRepository");
  const synced = time(repository.syncedAt);
  const detail = repository.error ?? (repository.kind === "git" ? (synced ? t("syncedAt", { time: relativeTime(synced) }) : t("neverSynced")) : null);
  const call = (path: string, init: RequestInit & { json?: unknown }, done?: string) => api(path, init).then(() => { if (done) toast(done); refresh(); }, failed);
  const base = `/api/repositories/${encodeURIComponent(repository.id)}`;
  return h("div", { className: "row repository-row", "data-testid": "repository-row" },
    h("div", { className: "row-text" },
      h("div", { className: "row-heading" }, h("span", { className: "row-name" }, repository.name), h("span", { className: "tag subtle" }, kind),
        repository.enabled ? null : h("span", { className: "tag muted-tag" }, t("disabled"))),
      repository.url ? h("div", { className: "muted small mono" }, repository.url) : null,
      h("div", { className: `small ${repository.error ? "error-text" : "muted"}` }, [t("servicesCount", { count: repository.services }), t("skillsCount", { count: repository.skills }), detail].filter(Boolean).join(" · "))),
    repository.kind === "git" ? h("div", { className: "row-actions" }, more(repository.name, "repository-menu", () => [
      { label: t("sync"), icon: "reload", testID: "repository-sync", run: () => void call(`${base}/sync`, { method: "POST" }, t("synced")) },
      { label: repository.enabled ? t("disable") : t("enable"), icon: repository.enabled ? "pause" : "play", testID: "repository-toggle", run: () => void call(base, { method: "PUT", json: { enabled: !repository.enabled } }) },
      { label: t("remove"), icon: "trash", destructive: true, testID: "repository-remove", run: async () => {
        if (await ask({ title: t("removeRepositoryTitle", { name: repository.name }), message: t("removeRepositoryBody"), confirm: t("remove"), destructive: true }) !== "confirm") return;
        await call(base, { method: "DELETE" });
      } },
    ])) : null);
}

export function keepFocus(root: ParentNode) {
  const active = document.activeElement instanceof HTMLElement && root.contains(document.activeElement) ? document.activeElement : null;
  const control = active?.dataset.testid;
  const skill = active?.closest<HTMLElement>("[data-skill]")?.dataset.skill;
  return () => {
    if (!control) return;
    const selector = `${skill ? `[data-skill="${CSS.escape(skill)}"] ` : ""}[data-testid="${CSS.escape(control)}"]`;
    root.querySelector<HTMLElement>(selector)?.focus({ preventScroll: true });
  };
}

export type SkillRow = { name: string; description: string; source: string; path: string; services: string[]; enabled: boolean; lastUsedAt: number | null; deletable: boolean };

function newSkill(refresh: () => void) {
  return formDialog({ title: t("newSkill"), testID: "skill-dialog", confirm: t("save"), fields: [
    { name: "name", label: t("skillName"), placeholder: "trip-planner", testID: "skill-name" },
    { name: "description", label: t("skillWhen"), testID: "skill-description" },
    { name: "instructions", label: t("skillInstructions"), kind: "textarea", rows: 8, testID: "skill-instructions" }],
  submit: async values => {
    const skill = await api<SkillRow>("/api/skills", { method: "POST", json: values });
    toast(t("skillCreated", { name: skill.name }));
    refresh();
  } });
}

function skillRow(skill: SkillRow, refresh: () => void) {
  const toggle = h("input", { type: "checkbox", className: "switch", role: "switch", checked: skill.enabled, "aria-label": t("skillToggle", { name: skill.name }), "data-testid": "skill-toggle" });
  const row = h("div", { className: `row skill-row${skill.enabled ? "" : " off"}`, "data-testid": "skill-row", "data-skill": skill.name },
    h("span", { className: "row-icon" }, icon("book", 18)),
    h("div", { className: "row-text" }, h("div", { className: "row-name" }, skill.name), h("div", { className: "muted small clamp" }, skill.description),
      h("div", { className: "faint small", "data-testid": "skill-used" }, skill.lastUsedAt ? t("lastUsed", { time: relativeTime(skill.lastUsedAt) }) : t("notUsed"))),
    h("div", { className: "row-actions" }, toggle, skill.deletable ? more(skill.name, "skill-menu", () => [{ label: t("delete"), icon: "trash", destructive: true, testID: "skill-delete", run: async () => {
      if (await ask({ title: t("deleteSkillTitle", { name: skill.name }), message: t("deleteSkillBody"), confirm: t("delete"), destructive: true }) !== "confirm") return;
      await api(`/api/skills/${encodeURIComponent(skill.name)}`, { method: "DELETE" }).then(refresh, failed);
    } }]) : h("span", { className: "icon-spacer", "aria-hidden": "true" })));
  let saving = false;
  toggle.addEventListener("change", async () => {
    if (saving) { toggle.checked = skill.enabled; return; }
    const enabled = toggle.checked;
    saving = true;
    toggle.setAttribute("aria-busy", "true");
    await api(`/api/skills/${encodeURIComponent(skill.name)}/enabled`, { method: "PUT", json: { enabled } })
      .then(() => { skill.enabled = enabled; row.classList.toggle("off", !enabled); }, error => { toggle.checked = !enabled; failed(error); });
    saving = false;
    toggle.removeAttribute("aria-busy");
  });
  return row;
}

export async function skillsContent(options: { live(): boolean; refresh(): void; group(title: string, rows: Node[]): Node }) {
  const skills = (await api<{ skills: SkillRow[] }>("/api/skills")).skills;
  if (!options.live()) return null;
  const groups = new Map<string, SkillRow[]>();
  for (const skill of [...skills].sort((a, b) => a.name.localeCompare(b.name))) groups.set(skill.source, [...groups.get(skill.source) ?? [], skill]);
  const order = ["profile", ...[...groups.keys()].filter(source => source !== "profile" && source !== "system").sort(), "system"];
  const title = (source: string) => source === "profile" ? t("yourSkills") : source === "system" ? t("systemSkills") : source === "local" ? t("localRepository") : source;
  const picker = h("input", { type: "file", accept: ".md,.skill,text/markdown", hidden: true, "data-testid": "skill-upload-input" });
  picker.addEventListener("change", () => {
    const file = picker.files?.[0];
    picker.value = "";
    if (file) void api<SkillRow>("/api/skills/import", { method: "POST", body: file }).then(skill => { toast(t("skillAdded", { name: skill.name })); options.refresh(); }, failed);
  });
  const actions = h("div", { className: "setting-actions" },
    h("button", { type: "button", className: "button primary small", "data-testid": "skill-new", onclick: () => void newSkill(options.refresh) }, icon("plus", 16), h("span", {}, t("newSkill"))),
    h("button", { type: "button", className: "button secondary small", "data-testid": "skill-upload", onclick: () => picker.click() }, icon("upload", 16), h("span", {}, t("uploadSkill"))), picker);
  return [actions, ...(groups.has("profile") ? [] : [options.group(t("yourSkills"), [emptyRow(t("noSkills"), "skills-empty")])]),
    ...order.filter(source => groups.has(source)).map(source => options.group(title(source), groups.get(source)!.map(skill => skillRow(skill, options.refresh))))];
}

const weekdays = (values: unknown) => {
  const days = (Array.isArray(values) ? values : []).map(value => typeof value === "number" ? value : ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]
    .indexOf(String(value).toLowerCase())).filter(day => day >= 0 && day <= 7);
  const formatter = new Intl.DateTimeFormat(locale, { weekday: "short" });
  return days.map(day => formatter.format(new Date(Date.UTC(2023, 0, 1 + (day % 7))))).join(locale === "zh-Hans" ? "、" : ", ");
};
const clock = (recurrence: Recurrence) => {
  const hour = Number(recurrence.hour ?? String(recurrence.time ?? "").split(":")[0]), minute = Number(recurrence.minute ?? String(recurrence.time ?? "").split(":")[1] ?? 0);
  if (!Number.isFinite(hour)) return String(recurrence.time ?? "");
  const text = new Date(2023, 0, 1, hour, Number.isFinite(minute) ? minute : 0).toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
  const zone = typeof recurrence.timeZone === "string" ? recurrence.timeZone : "";
  return zone && zone !== Intl.DateTimeFormat().resolvedOptions().timeZone ? `${text} (${zone})` : text;
};
function recurrenceText(recurrence: Recurrence | string, summary?: string) {
  if (typeof recurrence === "string") return recurrence;
  const kind = String(recurrence.kind ?? recurrence.type ?? "");
  if (kind === "once") return t("once", { time: when((recurrence.at ?? recurrence.date ?? recurrence.fireAt) as number | string | null) });
  if (kind === "interval") {
    const seconds = Number(recurrence.seconds ?? recurrence.interval ?? 0);
    return seconds % 86_400 === 0 ? t("everyDays", { count: seconds / 86_400 }) : seconds % 3_600 === 0 ? t("everyHours", { count: seconds / 3_600 }) : t("everyMinutes", { count: Math.max(1, Math.round(seconds / 60)) });
  }
  if (kind === "daily") return t("dailyAt", { time: clock(recurrence) });
  if (kind === "weekly") return t("weeklyAt", { days: weekdays(recurrence.weekdays ?? recurrence.days ?? [Number(recurrence.weekday) - 1]), time: clock(recurrence) });
  return summary ?? kind;
}
const outcomeOf = (value: ScheduleRow["lastOutcome"]) => typeof value === "string" ? value : value?.outcome ?? value?.kind ?? value?.status ?? null;
const labelKey = (prefix: "state" | "outcome", value: string) => `${prefix}${value.charAt(0).toUpperCase()}${value.slice(1)}` as StringKey;
const translated = (prefix: "state" | "outcome", value: string) => { try { return t(labelKey(prefix, value)); } catch { return value; } };

export async function renderSchedules(context: PageHost) {
  if (!context.main.querySelector(".schedules-page")) loading(context, t("schedules"));
  let schedules: ScheduleRow[];
  try { schedules = (await api<{ schedules: ScheduleRow[] }>("/api/schedules")).schedules; } catch (error) { failure(context, t("schedules"), error); return; }
  if (context.route() !== "schedules") return;
  const refresh = () => void renderSchedules(context);
  const action = (label: string, iconName: IconName, run: () => Promise<unknown>, testID: string): MenuItem => ({ label, icon: iconName, testID, run: () => void run().then(refresh, failed) });
  context.main.replaceChildren(context.topbar(t("schedules")), h("div", { className: "page schedules-page", "data-testid": "schedules-page" },
    schedules.length ? h("div", { className: "group" }, ...schedules.map(schedule => {
      const outcome = outcomeOf(schedule.lastOutcome);
      const paused = schedule.state === "paused";
      const finished = schedule.state === "completed" || schedule.state === "expired";
      const base = `/api/schedules/${encodeURIComponent(schedule.id)}`;
      return h("div", { className: "row schedule-row", "data-testid": "schedule-row" },
        h("span", { className: "row-icon" }, icon("clock", 18)),
        h("div", { className: "row-text" },
          h("div", { className: "row-heading" }, h("span", { className: "row-name" }, schedule.name), h("span", { className: `tag${paused || finished ? " muted-tag" : ""}` }, translated("state", schedule.state))),
          h("div", { className: "muted small" }, [recurrenceText(schedule.recurrence, schedule.summary), !finished && !paused && schedule.nextFireAt ? t("nextRun", { time: when(schedule.nextFireAt, typeof schedule.recurrence === "object" ? schedule.recurrence.timeZone : undefined) }) : null].filter(Boolean).join(" · ")),
          schedule.lastRunAt ? h("div", { className: `small ${outcome === "failed" ? "error-text" : "muted"}` },
            [t("lastRun", { time: when(schedule.lastRunAt) }), outcome ? translated("outcome", outcome) : null, outcome === "failed" ? schedule.lastError : null].filter(Boolean).join(" · ")) : null,
        ),
        h("div", { className: "row-actions" }, more(schedule.name, "schedule-menu", () => [
          ...(finished ? [] : [action(t("runNow"), "play", () => api(`${base}/run`, { method: "POST" }).then(() => toast(t("scheduleStarted"))), "schedule-run"),
            action(paused ? t("resume") : t("pause"), paused ? "play" : "pause", () => api(base, { method: "PUT", json: { enabled: paused } }), "schedule-toggle")]),
          ...(schedule.conversationId !== null && schedule.conversationId !== undefined ? [{ label: t("openLastRun"), icon: "forward" as const, testID: "schedule-open", run: () => { location.hash = `#/c/${schedule.conversationId}`; } }] : []),
          { label: t("delete"), icon: "trash", destructive: true, testID: "schedule-delete", run: async () => {
            if (await ask({ title: t("deleteScheduleTitle", { name: schedule.name }), message: t("deleteScheduleBody"), confirm: t("delete"), destructive: true }) !== "confirm") return;
            await api(base, { method: "DELETE" }).then(refresh, failed);
          } },
        ])));
    })) : h("div", { className: "empty-state compact", "data-testid": "schedules-empty" }, icon("clock", 28), h("h2", {}, t("noSchedules")), h("p", { className: "muted" }, t("noSchedulesBody")))));
}

import { api, ask, failed, formDialog, menu, relativeTime, sheet, toast, type MenuItem } from "./client";
import { h, icon, type IconName } from "./dom";
import { hostText, locale, t, type StringKey } from "./i18n";

export type ServiceRow = { id: string; kind: string; domain: string; name: string; description?: string; faviconUrl?: string | null; repository: string;
  available: boolean; unavailableReason?: string; supportsLogin: boolean; alwaysApproved: string[] };
export type RepositoryRow = { id: string; name: string; kind: "bundled" | "local" | "git"; url: string | null; enabled: boolean; syncedAt: number | string | null;
  commit: string | null; error: string | null; services: number; skills: number };
export type SecretRow = { key: string; name: string; fields: string[]; available: boolean };
export type Recurrence = Record<string, unknown> & { kind?: string; type?: string };
export type ScheduleRow = { id: string; name: string; prompt: string; recurrence: Recurrence | string; summary?: string; state: string; nextFireAt: number | string | null; lastRunAt: number | string | null;
  lastOutcome: string | { outcome?: string; kind?: string; status?: string } | null; lastError?: string | null; conversationId: number | string | null; condition?: string | null; deadline?: number | string | null };
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
  if (milliseconds <= now) return relativeTime(milliseconds) || date.toLocaleString(locale, zone);
  return date.toLocaleString(locale, milliseconds - now < 6 * 86_400_000 ? { weekday: "short", hour: "numeric", minute: "2-digit", ...zone }
    : { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", ...(date.getFullYear() === new Date(now).getFullYear() ? {} : { year: "numeric" }), ...zone });
};
const hue = (text: string) => [...text].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) % 360, 7);
export const avatar = (name: string, domain: string, small = false) => h("span", { className: `avatar${small ? " small" : ""}`, style: `--avatar-hue: ${hue(domain)}` }, (name || domain).trim().charAt(0).toUpperCase());
const repositoryLabel = (id: string, repositories: RepositoryRow[]) => id === "bundled" ? t("builtIn") : id === "local" ? t("localRepository")
  : repositories.find(repository => repository.id === id)?.name ?? id;
const emptyRow = (text: string, testID: string) => h("div", { className: "row" }, h("span", { className: "muted", "data-testid": testID }, text));
const more = (label: string, testID: string, items: () => MenuItem[]) => h("button", { type: "button", className: "icon-button", "aria-label": `${t("moreOptions")}: ${label}`, title: t("moreOptions"),
  "aria-haspopup": "menu", "data-testid": testID, onclick: (event: Event) => menu(event.currentTarget as HTMLElement, items()) }, icon("more"));
const loading = (context: PageHost, title: string) => {
  context.main.replaceChildren(context.topbar(title), h("div", { className: "page" }, h("div", { className: "page-loading" }, h("span", { className: "spinner", "aria-hidden": "true" }))));
};
const failure = (context: PageHost, title: string, error: unknown) => {
  context.main.replaceChildren(context.topbar(title), h("div", { className: "page" }, h("p", { className: "form-error", role: "alert" }, error instanceof Error ? error.message : String(error))));
};

export function connectRepositoryForm(refresh: () => void) {
  const url = h("input", { className: "field", type: "url", placeholder: t("repositoryURL"), inputmode: "url", autocapitalize: "off", spellcheck: "false",
    "aria-label": t("connectRepository"), required: true, "data-testid": "repository-url" });
  return h("form", { className: "row form-row", onsubmit: async (event: Event) => {
    event.preventDefault();
    const button = (event.target as HTMLFormElement).querySelector("button")!;
    button.disabled = true;
    await api("/api/repositories", { method: "POST", json: { url: url.value.trim() } }).then(() => { toast(t("synced")); refresh(); }, failed);
    button.disabled = false;
  } }, h("div", { className: "label" }, t("connectRepository")), url, h("button", { type: "submit", className: "button secondary", "data-testid": "repository-connect" }, t("connect")));
}

export function serviceRow(service: ServiceRow, repositories: RepositoryRow[], handlers: { openPage(id: string): void; refresh(): void; open?(domain: string): void }) {
  const actions = service.available ? [
    service.supportsLogin ? h("button", { type: "button", className: "button secondary small", "data-testid": `sign-in-${service.domain}`, onclick: async (event: Event) => {
      const button = event.currentTarget as HTMLButtonElement;
      button.disabled = true;
      await api<{ page: { id: string } }>(`/api/services/${encodeURIComponent(service.domain)}/login`, { method: "POST" }).then(({ page }) => handlers.openPage(page.id), failed);
      button.disabled = false;
    } }, t("signIn")) : null,
    service.alwaysApproved.length ? h("button", { type: "button", className: "button secondary small", title: t("alwaysApprovedCount", { count: service.alwaysApproved.length }), onclick: async () => {
      await api(`/api/services/${encodeURIComponent(service.domain)}/approvals`, { method: "DELETE" }).then(() => { toast(t("approvalsReset")); handlers.refresh(); }, failed);
    } }, t("resetApprovals")) : null,
  ].filter(Boolean) : [];
  const body = [avatar(service.name, service.domain),
    h("div", { className: "row-text" },
      h("div", { className: "row-heading" }, h("span", { className: "row-name" }, service.name), h("span", { className: "tag subtle" }, repositoryLabel(service.repository, repositories))),
      h("div", { className: "muted small" }, service.domain),
      service.available ? (service.description ? h("div", { className: "muted small clamp" }, service.description) : null)
        : h("div", { className: "muted small" }, service.unavailableReason ?? t("unavailableServices")))];
  const open = handlers.open && service.available ? handlers.open : null;
  return h("div", { className: `row service-row${service.available ? "" : " unavailable"}`, "data-testid": "service-row", "data-domain": service.domain },
    open ? h("button", { type: "button", className: "service-open", "aria-label": service.name, "data-testid": "service-open", onclick: () => open(service.domain) }, ...body) : h("div", { className: "service-open" }, ...body),
    actions.length ? h("div", { className: "row-actions" }, ...actions) : null,
    open ? h("span", { className: "chevron", "aria-hidden": "true" }, icon("chevron", 16)) : null);
}

type ServicePreview = { token: string; kind: string; domain: string; name: string; description: string; actions: string[]; exists: boolean };

export async function importServiceFile(file: File) {
  let preview: ServicePreview;
  try { preview = await api<ServicePreview>("/api/service-imports", { method: "POST", body: file }); }
  catch (error) { toast(t("importServiceFailed", { reason: hostText(error instanceof Error ? error.message : String(error)) }), "error"); return undefined; }
  let installed: string | undefined, pending: Promise<string> | undefined;
  await formDialog({ title: t("importService"), testID: "service-import-dialog", confirm: preview.exists ? t("replaceService") : t("addService"),
    content: h("div", { className: "import-summary", "data-testid": "service-import-summary" },
      h("div", { className: "import-service" }, avatar(preview.name, preview.domain), h("div", {}, h("p", { className: "import-title" }, preview.name), h("p", { className: "import-meta" }, preview.domain))),
      preview.description ? h("p", {}, preview.description) : null,
      preview.actions.length ? h("div", { className: "import-note" }, h("strong", {}, t("serviceActions")), ...preview.actions.map(label => h("p", {}, label))) : null,
      h("p", { className: "import-meta" }, t("importServiceNote")),
      preview.exists ? h("div", { className: "import-note warning" }, h("p", {}, t("importServiceReplaceNote"))) : null),
    submit: async () => {
      pending = api<{ domain: string }>(`/api/service-imports/${preview.token}`, { method: "POST", json: { replace: preview.exists } }).then(result => result.domain);
      installed = await pending;
    } });
  if (installed === undefined && pending) installed = await pending.catch(() => undefined);
  if (installed === undefined) { void api(`/api/service-imports/${preview.token}`, { method: "DELETE" }).catch(() => {}); return undefined; }
  toast(t("serviceImported"));
  return installed;
}

export function repositoryRow(repository: RepositoryRow, refresh: () => void) {
  const name = repository.kind === "git" ? repository.name : repositoryLabel(repository.id, []);
  const synced = time(repository.syncedAt);
  const detail = repository.error ?? (repository.kind === "git" ? (synced ? t("syncedAt", { time: relativeTime(synced) }) : t("neverSynced"))
    : repository.kind === "bundled" ? t("includedWithOx") : t("editableOnHost"));
  const call = (path: string, init: RequestInit & { json?: unknown }, done?: string) => api(path, init).then(() => { if (done) toast(done); refresh(); }, failed);
  const base = `/api/repositories/${encodeURIComponent(repository.id)}`;
  return h("div", { className: "row repository-row", "data-testid": "repository-row" },
    h("div", { className: "row-text" },
      h("div", { className: "row-heading" }, h("span", { className: "row-name" }, name),
        repository.enabled ? null : h("span", { className: "tag muted-tag" }, t("disabled"))),
      repository.url ? h("div", { className: "muted small mono" }, repository.url) : null,
      h("div", { className: `small ${repository.error ? "error-text" : "muted"}` }, [t("servicesCount", { count: repository.services }), t("skillsCount", { count: repository.skills }), detail].filter(Boolean).join(" · "))),
    repository.kind === "local" ? null : h("div", { className: "row-actions" }, more(name, "repository-menu", () => [
      ...(repository.kind === "git" ? [{ label: t("sync"), icon: "reload", testID: "repository-sync", run: () => void call(`${base}/sync`, { method: "POST" }, t("synced")) }] : []),
      { label: repository.enabled ? t("disable") : t("enable"), icon: repository.enabled ? "pause" : "play", testID: "repository-toggle", run: () => void call(base, { method: "PUT", json: { enabled: !repository.enabled } }) },
      ...(repository.kind === "git" ? [{ label: t("remove"), icon: "trash", destructive: true, testID: "repository-remove", run: async () => {
        if (await ask({ title: t("removeRepositoryTitle", { name: repository.name }), message: t("removeRepositoryBody"), confirm: t("remove"), destructive: true }) !== "confirm") return;
        await call(base, { method: "DELETE" });
      } }] : []),
    ])));
}

export function keepFocus(root: ParentNode) {
  const active = document.activeElement instanceof HTMLElement && root.contains(document.activeElement) ? document.activeElement : null;
  const control = active?.dataset.testid;
  const skill = active?.closest<HTMLElement>("[data-skill]")?.dataset.skill;
  const schedule = active?.closest<HTMLElement>("[data-schedule]")?.dataset.schedule;
  return () => {
    if (!control) return;
    const scope = skill ? `[data-skill="${CSS.escape(skill)}"] ` : schedule ? `[data-schedule="${CSS.escape(schedule)}"] ` : "";
    root.querySelector<HTMLElement>(`${scope}[data-testid="${CSS.escape(control)}"]`)?.focus({ preventScroll: true });
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
  const formatter = new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" });
  return days.map(day => formatter.format(new Date(Date.UTC(2023, 0, 1 + (day % 7))))).join(locale === "zh-Hans" ? "、" : ", ");
};
const clock = (recurrence: Recurrence) => {
  const hour = Number(recurrence.hour ?? String(recurrence.time ?? "").split(":")[0]), minute = Number(recurrence.minute ?? String(recurrence.time ?? "").split(":")[1] ?? 0);
  if (!Number.isFinite(hour)) return String(recurrence.time ?? "");
  const text = new Date(2023, 0, 1, hour, Number.isFinite(minute) ? minute : 0).toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
  const zone = typeof recurrence.timeZone === "string" ? recurrence.timeZone : "";
  return zone && zone !== Intl.DateTimeFormat().resolvedOptions().timeZone ? `${text} (${zone})` : text;
};
export function recurrenceText(recurrence: Recurrence | string, summary?: string) {
  if (typeof recurrence === "string") return recurrence;
  const kind = String(recurrence.kind ?? recurrence.type ?? "");
  if (kind === "once") return t("once", { time: when((recurrence.at ?? recurrence.date ?? recurrence.fireAt) as number | string | null) });
  if (kind === "interval") {
    const seconds = Number(recurrence.seconds ?? recurrence.interval ?? 0);
    return seconds % 86_400 === 0 ? t("everyDays", { count: seconds / 86_400 }) : seconds % 3_600 === 0 ? t("everyHours", { count: seconds / 3_600 })
      : seconds % 60 === 0 ? t("everyMinutes", { count: seconds / 60 }) : t("everySeconds", { count: seconds });
  }
  if (kind === "daily") return t("dailyAt", { time: clock(recurrence) });
  if (kind === "weekly") return t("weeklyAt", { days: weekdays(recurrence.weekdays ?? recurrence.days ?? [Number(recurrence.weekday) - 1]), time: clock(recurrence) });
  return summary ?? kind;
}
const outcomeOf = (value: ScheduleRow["lastOutcome"]) => typeof value === "string" ? value : value?.outcome ?? value?.kind ?? value?.status ?? null;
const labelKey = (prefix: "state" | "outcome", value: string) => `${prefix}${value.charAt(0).toUpperCase()}${value.slice(1)}` as StringKey;
const translated = (prefix: "state" | "outcome", value: string) => { try { return t(labelKey(prefix, value)); } catch { return value; } };

let scheduleList: ScheduleRow[] | undefined;
let scheduleRequest: Promise<ScheduleRow[]> | undefined;
let scheduleFollowUp: Promise<ScheduleRow[]> | undefined;
const scheduleWatchers = new Set<(list: ScheduleRow[]) => void>();
export const cachedSchedules = () => scheduleList;
export function loadSchedules(): Promise<ScheduleRow[]> {
  if (scheduleRequest) {
    scheduleFollowUp ??= scheduleRequest.catch(() => []).then(() => { scheduleFollowUp = undefined; return loadSchedules(); });
    return scheduleFollowUp;
  }
  const request = api<{ schedules: ScheduleRow[] }>("/api/schedules").then(body => {
    scheduleList = body.schedules;
    for (const watcher of [...scheduleWatchers]) watcher(body.schedules);
    return body.schedules;
  }).finally(() => { scheduleRequest = undefined; });
  scheduleRequest = request;
  return request;
}
const watchSchedules = (watcher: (list: ScheduleRow[]) => void) => { scheduleWatchers.add(watcher); return () => { scheduleWatchers.delete(watcher); }; };
const scheduleOn = (schedule: ScheduleRow) => schedule.state === "active" || schedule.state === "running";
const dateTime = (value: number | string | null | undefined, zone?: unknown) => {
  const milliseconds = time(value);
  if (milliseconds === null) return "";
  const other = typeof zone === "string" && zone && zone !== Intl.DateTimeFormat().resolvedOptions().timeZone ? zone : null;
  const text = new Date(milliseconds).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short", ...(other ? { timeZone: other } : {}) });
  return other ? `${text} (${other})` : text;
};

export function scheduleSummary(schedule: ScheduleRow | null | undefined) {
  if (schedule === undefined) return "";
  if (schedule === null) return t("scheduleUnavailable");
  return scheduleOn(schedule) ? recurrenceText(schedule.recurrence, schedule.summary) : translated("state", schedule.state);
}

export function scheduleCard(created: { id: string; name?: string }, schedule: ScheduleRow | null | undefined, element?: HTMLButtonElement) {
  const name = schedule?.name || created.name || t("schedule");
  const card = element ?? h("button", { type: "button", className: "page-card schedule-card", "data-testid": "schedule-card", "data-schedule": created.id },
    h("span", { className: "page-icon" }, icon("clock", 18)),
    h("span", { className: "page-text" }, h("span", { className: "page-title" }), h("span", { className: "page-host", "data-testid": "schedule-card-summary" })),
    icon("chevron", 14));
  card.classList.toggle("closed", schedule === null);
  card.querySelector(".page-title")!.textContent = name;
  card.querySelector("[data-testid=schedule-card-summary]")!.textContent = scheduleSummary(schedule);
  card.onclick = () => openScheduleDetails(created.id, name);
  return card;
}

const sheetGroup = (title: string | null, ...rows: (Node | null)[]) => h("section", { className: "settings-group" },
  title ? h("h3", { className: "settings-group-title" }, title) : null, h("div", { className: "settings-card" }, ...rows));
const sheetRow = (title: string, options: { value?: string; description?: string; testID: string; muted?: boolean }) =>
  h("div", { className: "setting-row", "data-testid": options.testID },
    h("div", { className: "setting-text" }, h("div", { className: `setting-title${options.muted ? " muted" : ""}` }, title),
      options.description ? h("div", { className: "setting-description" }, options.description) : null),
    options.value ? h("span", { className: "setting-value" }, options.value) : null);

export function openScheduleDetails(id: string, fallback: string, onClose?: () => void) {
  let stop = () => {};
  const view = sheet({ testID: "schedule-details", className: "schedule-sheet", label: fallback, onClose: () => { stop(); onClose?.(); } });
  const path = `/api/schedules/${encodeURIComponent(id)}`;
  const refresh = () => loadSchedules().catch(failed);
  const render = (list: ScheduleRow[] | undefined) => {
    if (!view.open()) return;
    const schedule = list === undefined ? undefined : list.find(row => row.id === id) ?? null;
    const restore = keepFocus(view.dialog);
    const scroll = view.dialog.querySelector(".sheet-body")?.scrollTop ?? 0;
    const tool = (name: IconName, label: string, testID: string, run: () => void, disabled = false) =>
      h("button", { type: "button", className: "icon-button", "aria-label": label, title: label, "data-testid": testID, disabled, onclick: run }, icon(name, 20));
    const on = !!schedule && scheduleOn(schedule);
    const failure = schedule && outcomeOf(schedule.lastOutcome) === "failed" ? schedule.lastError : null;
    const body = schedule === undefined ? h("div", { className: "page-loading" }, h("span", { className: "spinner", "aria-hidden": "true" }))
      : schedule === null ? sheetGroup(null, sheetRow(t("scheduleUnavailable"), { testID: "schedule-unavailable", muted: true }))
      : h("div", {},
        schedule.prompt ? sheetGroup(t("schedulePrompt"), h("div", { className: "setting-row" }, h("div", { className: "setting-text" },
          h("div", { className: "setting-title schedule-prompt", "data-testid": "schedule-prompt" }, schedule.prompt)))) : null,
        sheetGroup(null,
          schedule.condition ? sheetRow(t("stopWhen"), { description: schedule.condition, testID: "schedule-condition-row" }) : null,
          schedule.deadline !== null && schedule.deadline !== undefined ? sheetRow(t("deadline"), { value: dateTime(schedule.deadline), testID: "schedule-deadline-row" }) : null,
          sheetRow(t("repeat"), { value: recurrenceText(schedule.recurrence, schedule.summary), testID: "schedule-repeat-row" }),
          on && schedule.nextFireAt !== null ? sheetRow(t("nextRunLabel"), { value: dateTime(schedule.nextFireAt, typeof schedule.recurrence === "object" ? schedule.recurrence.timeZone : null),
            testID: "schedule-next-row" }) : null,
          failure ? sheetRow(failure, { testID: "schedule-failure", muted: true }) : null),
        sheetGroup(null, h("button", { type: "button", className: "setting-row link-row destructive", "data-testid": "schedule-details-delete", onclick: async () => {
          if (await ask({ title: t("deleteScheduleQuestion"), message: t("deleteScheduleNote"), confirm: t("deleteSchedule"), destructive: true }) !== "confirm") return;
          await api(path, { method: "DELETE" }).then(() => { view.close(); void refresh(); }, failed);
        } }, h("div", { className: "setting-text" }, h("div", { className: "setting-title" }, t("deleteSchedule"))))));
    view.dialog.replaceChildren(
      h("div", { className: "sheet-head" }, h("h2", { className: "sheet-title", "data-testid": "schedule-title" }, schedule?.name ?? fallback),
        h("div", { className: "sheet-tools" },
          schedule ? tool("pencil", t("edit"), "schedule-edit", () => void editSchedule(schedule), schedule.state === "running") : null,
          schedule && schedule.nextFireAt !== null && (on || schedule.state === "paused") ? tool(on ? "pause" : "play", on ? t("pause") : t("resume"), "schedule-pause",
            () => void api(path, { method: "PUT", json: { enabled: !on } }).then(refresh, failed)) : null,
          tool("close", t("close"), "schedule-close", () => view.close()))),
      h("div", { className: "sheet-body" }, body));
    const scroller = view.dialog.querySelector(".sheet-body");
    if (scroller) scroller.scrollTop = scroll;
    restore();
  };
  stop = watchSchedules(render);
  render(scheduleList);
  void refresh();
}

const localInput = (milliseconds: number) => {
  const date = new Date(milliseconds), pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

export async function editSchedule(schedule: ScheduleRow) {
  const recurrence = typeof schedule.recurrence === "object" ? schedule.recurrence : {};
  const kind = ["once", "interval", "daily", "weekly"].includes(String(recurrence.type)) ? String(recurrence.type) : "interval";
  const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const zone = (kind === "daily" || kind === "weekly") && typeof recurrence.timeZone === "string" ? recurrence.timeZone : browserZone;
  const soon = Math.ceil((Date.now() + 3_600_000) / 60_000) * 60_000;
  const stored = time(recurrence.fireAt as number | undefined);
  const deadline = time(schedule.deadline);
  const pad = (value: number) => String(value).padStart(2, "0");
  const field = (label: string, control: HTMLElement, testID: string) => {
    control.dataset.testid = testID;
    control.setAttribute("aria-label", label);
    return h("label", { className: "stack" }, h("span", { className: "label" }, label), control);
  };
  const name = h("input", { className: "field", value: schedule.name, autocomplete: "off" });
  const prompt = h("textarea", { className: "field", rows: 4 });
  prompt.value = schedule.prompt;
  const repeat = h("select", { className: "field" }, ...([["once", t("repeatOnce")], ["interval", t("repeatInterval")], ["daily", t("repeatDaily")], ["weekly", t("repeatWeekly")]] as const)
    .map(([value, label]) => h("option", { value }, label)));
  repeat.value = kind;
  const seconds = h("input", { className: "field", type: "number", min: 30, step: 1, inputmode: "numeric", value: String(kind === "interval" ? Number(recurrence.seconds) : 3_600) });
  const runAt = h("input", { className: "field", type: "datetime-local", min: localInput(Date.now()), value: localInput(kind === "once" && stored !== null && stored > Date.now() ? stored : soon) });
  const clockTime = h("input", { className: "field", type: "time",
    value: kind === "daily" || kind === "weekly" ? `${pad(Number(recurrence.hour))}:${pad(Number(recurrence.minute))}` : "09:00" });
  const dayNames = new Intl.DateTimeFormat(locale, { weekday: "long", timeZone: "UTC" });
  const day = h("select", { className: "field" }, ...[1, 2, 3, 4, 5, 6, 7].map(index => h("option", { value: String(index) }, dayNames.format(new Date(Date.UTC(2023, 0, index))))));
  day.value = String(kind === "weekly" ? Number(recurrence.weekday) : new Date().getDay() + 1);
  const condition = h("textarea", { className: "field", rows: 2 });
  condition.value = schedule.condition ?? "";
  const conditionNote = h("p", { className: "muted small", "data-testid": "schedule-condition-note" }, t("conditionNote"));
  const hasDeadline = h("input", { type: "checkbox", className: "switch", role: "switch", checked: deadline !== null, "aria-label": t("deadline"), "data-testid": "schedule-has-deadline" });
  const stopAfter = h("input", { className: "field", type: "datetime-local", min: localInput(Date.now()), value: localInput(deadline ?? Date.now() + 86_400_000) });
  const rows = {
    seconds: field(t("everySecondsField"), seconds, "schedule-seconds"),
    runAt: field(t("runAt"), runAt, "schedule-run-at"),
    day: field(t("scheduleDay"), day, "schedule-day"),
    time: field(t("runAt"), clockTime, "schedule-time"),
    zone: zone === browserZone ? null : h("p", { className: "muted small", "data-testid": "schedule-zone" }, t("scheduleZone", { zone })),
    stopAfter: field(t("stopAfter"), stopAfter, "schedule-stop-after"),
  };
  const sync = () => {
    const value = repeat.value;
    rows.seconds.hidden = seconds.disabled = value !== "interval";
    rows.runAt.hidden = runAt.disabled = value !== "once";
    rows.day.hidden = day.disabled = value !== "weekly";
    rows.time.hidden = clockTime.disabled = value !== "daily" && value !== "weekly";
    if (rows.zone) rows.zone.hidden = rows.time.hidden;
    rows.stopAfter.hidden = stopAfter.disabled = !hasDeadline.checked;
    conditionNote.hidden = !condition.value.trim();
  };
  for (const control of [repeat, hasDeadline]) control.addEventListener("change", sync);
  condition.addEventListener("input", sync);
  sync();
  const instant = (input: HTMLInputElement) => {
    const value = new Date(input.value).getTime();
    if (!input.value || !Number.isFinite(value)) throw new Error("Choose a time in the future.");
    return value;
  };
  return formDialog({ title: t("editSchedule"), testID: "schedule-editor", confirm: t("save"),
    content: h("div", { className: "schedule-editor" },
      h("div", { className: "editor-section" }, field(t("scheduleNameField"), name, "schedule-name"), field(t("schedulePrompt"), prompt, "schedule-prompt-field")),
      h("div", { className: "editor-section" }, field(t("repeat"), repeat, "schedule-repeat"), rows.seconds, rows.runAt, rows.day, rows.time, rows.zone),
      h("div", { className: "editor-section" }, field(t("stopWhenOptional"), condition, "schedule-condition"), conditionNote,
        h("label", { className: "switch-row" }, h("span", {}, t("deadline")), hasDeadline), rows.stopAfter)),
    submit: async () => {
      const [hour, minute] = clockTime.value.split(":").map(Number) as [number, number];
      const value = repeat.value;
      const next = value === "interval" ? { type: "interval", seconds: Number(seconds.value) }
        : value === "once" ? { type: "once", fireAt: instant(runAt) }
        : value === "daily" ? { type: "daily", hour, minute, timeZone: zone }
        : { type: "weekly", weekday: Number(day.value), hour, minute, timeZone: zone };
      await api(`/api/schedules/${encodeURIComponent(schedule.id)}`, { method: "PATCH", json: { name: name.value, prompt: prompt.value,
        condition: condition.value.trim() || null, deadline: hasDeadline.checked ? instant(stopAfter) : null, recurrence: next } });
      await loadSchedules().catch(() => {});
    } });
}

export async function renderSchedules(context: PageHost) {
  if (context.route() !== "schedules") return;
  if (!context.main.querySelector(".schedules-page")) loading(context, t("schedules"));
  let schedules: ScheduleRow[];
  try { schedules = await loadSchedules(); } catch (error) { failure(context, t("schedules"), error); return; }
  if (context.route() !== "schedules") return;
  const refresh = () => void renderSchedules(context);
  const action = (label: string, iconName: IconName, run: () => Promise<unknown>, testID: string): MenuItem => ({ label, icon: iconName, testID, run: () => void run().then(refresh, failed) });
  const restore = keepFocus(context.main);
  context.main.replaceChildren(context.topbar(t("schedules")), h("div", { className: "page schedules-page", "data-testid": "schedules-page" },
    schedules.length ? h("div", { className: "group" }, ...schedules.map(schedule => {
      const outcome = outcomeOf(schedule.lastOutcome);
      const paused = schedule.state === "paused";
      const finished = schedule.state === "completed" || schedule.state === "expired";
      const base = `/api/schedules/${encodeURIComponent(schedule.id)}`;
      return h("div", { className: "row schedule-row", "data-testid": "schedule-row", "data-schedule": schedule.id },
        h("button", { type: "button", className: "schedule-open", "data-testid": "schedule-row-open", onclick: () => openScheduleDetails(schedule.id, schedule.name, refresh) },
        h("span", { className: "row-icon" }, icon("clock", 18)),
        h("div", { className: "row-text" },
          h("div", { className: "row-heading" }, h("span", { className: "row-name" }, schedule.name), h("span", { className: `tag${paused || finished ? " muted-tag" : ""}` }, translated("state", schedule.state))),
          h("div", { className: "muted small" }, [recurrenceText(schedule.recurrence, schedule.summary), !finished && !paused && schedule.nextFireAt ? t("nextRun", { time: when(schedule.nextFireAt, typeof schedule.recurrence === "object" ? schedule.recurrence.timeZone : undefined) }) : null].filter(Boolean).join(" · ")),
          schedule.lastRunAt ? h("div", { className: `small ${outcome === "failed" ? "error-text" : "muted"}` },
            [t("lastRun", { time: when(schedule.lastRunAt) }), outcome ? translated("outcome", outcome) : null, outcome === "failed" ? schedule.lastError : null].filter(Boolean).join(" · ")) : null,
        )),
        h("div", { className: "row-actions" }, more(schedule.name, "schedule-menu", () => [
          ...(schedule.state === "running" ? [] : [{ label: t("edit"), icon: "pencil" as const, testID: "schedule-menu-edit", run: () => void editSchedule(schedule).then(saved => { if (saved) refresh(); }) }]),
          ...(finished ? [] : [action(t("runNow"), "play", () => api(`${base}/run`, { method: "POST" }).then(() => toast(t("scheduleStarted"))), "schedule-run"),
            action(paused ? t("resume") : t("pause"), paused ? "play" : "pause", () => api(base, { method: "PUT", json: { enabled: paused } }), "schedule-toggle")]),
          ...(schedule.conversationId !== null && schedule.conversationId !== undefined ? [{ label: t("openLastRun"), icon: "forward" as const, testID: "schedule-open", run: () => { location.hash = `#/c/${schedule.conversationId}`; } }] : []),
          { label: t("delete"), icon: "trash", destructive: true, testID: "schedule-delete", run: async () => {
            if (await ask({ title: t("deleteScheduleTitle", { name: schedule.name }), message: t("deleteScheduleBody"), confirm: t("delete"), destructive: true }) !== "confirm") return;
            await api(base, { method: "DELETE" }).then(refresh, failed);
          } },
        ])));
    })) : h("div", { className: "empty-state compact", "data-testid": "schedules-empty" }, icon("clock", 28), h("h2", {}, t("noSchedules")), h("p", { className: "muted" }, t("noSchedulesBody")))));
  restore();
}

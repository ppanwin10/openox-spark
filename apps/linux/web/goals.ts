import type { Goal, Todo } from "@openox/agent/linux";
import { api, APIError, ask, clearInfoToasts, closeMenu, failed, getContentEpoch, menu, returnFocus, sheet, toast } from "./client";
import { h, icon } from "./dom";
import { scheduleCard, type PageHost, type ScheduleRow } from "./capabilities";
import { hostText, t } from "./i18n";
import { markdown } from "./markdown";

let generation = 0, showCompleted = false;
let activeView: { context: PageHost; id: string | null; busy(): boolean } | undefined;
export function closeGoalsView() {
  if (activeView?.context.main.querySelector('[data-testid="goals-menu"][aria-expanded="true"]')) closeMenu();
  generation++; activeView = undefined;
}
export function refreshGoals() {
  const view = activeView;
  if (view?.context.main.isConnected && !view.busy() && !document.querySelector("dialog[open]")) void renderGoals(view.context, view.id);
}
const describe = (error: unknown) => error instanceof TypeError && error.message === "Failed to fetch" ? t("requestResultUnavailable") : hostText(error instanceof Error ? error.message : String(error));
const goalHash = (id: string) => `#/goals/${encodeURIComponent(id)}`;

function progressNotes(goal: Goal, schedules: ScheduleRow[]) {
  const sources = new Set(schedules.flatMap(({ lastReport }) => lastReport?.goalRevision === goal.revision
    ? lastReport.sources.map(source => source.url).filter(url => /^https?:\/\//i.test(url)) : []));
  if (sources.size && goal.notes) {
    const body = markdown(goal.notes, target => sources.has(target) ? { href: target, file: false, image: false } : undefined,
      t("copyCode"), false, "notes");
    if (body.querySelector("a[href]")) return h("div", { className: "markdown goal-progress-notes" }, body);
  }
  return h("p", {}, goal.notes || t("goalNoNotes"));
}

function editGoal(todos: Todo[], goal?: Goal, category: "health" | null = null) {
  const title = h("input", { className: "field", maxlength: 200, required: true, "aria-label": t("goalTitle"), "data-testid": "goal-title" });
  const outcome = h("textarea", { className: "field", maxlength: 2_000, rows: 3, required: true, "aria-label": t("goalOutcome"), "data-testid": "goal-outcome-input" });
  const notes = h("textarea", { className: "field", maxlength: 8_000, rows: 4, "aria-label": t("goalNotes"), "data-testid": "goal-notes" });
  let selected = new Set(goal?.todoIds ?? []), source = goal, saving = false;
  const key = crypto.randomUUID(), links = h("div", { className: "goal-link-options" });
  const values = () => ({ title: title.value, outcome: outcome.value, notes: notes.value, todoIds: [...selected] });
  const populate = (value?: Goal) => { title.value = value?.title ?? ""; outcome.value = value?.outcome ?? ""; notes.value = value?.notes ?? ""; };
  populate(goal);
  let baseline = JSON.stringify(values());
  const changed = () => JSON.stringify(values()) !== baseline;
  const drawLinks = () => {
    const records = new Map(todos.map(todo => [todo.id, todo]));
    const ids = [...todos.map(todo => todo.id), ...[...selected].filter(id => !records.has(id))];
    links.replaceChildren(...ids.map(id => {
      const todo = records.get(id);
      const input = h("input", { type: "checkbox", checked: selected.has(id), "data-testid": `goal-link-${id}`,
        onchange: () => { if (input.checked) selected.add(id); else selected.delete(id); } });
      return h("label", {}, input, h("span", {}, todo?.title ?? t("goalMissingTask", { id: id.slice(0, 8) })));
    }));
    if (!ids.length) links.append(h("p", { className: "muted" }, t("goalNoTasks")));
  };
  drawLinks();
  const beforeUnload = (event: BeforeUnloadEvent) => { if (changed()) { event.preventDefault(); event.returnValue = ""; } };
  window.addEventListener("beforeunload", beforeUnload);
  const view = sheet({ testID: "goal-editor", className: "todo-editor-sheet goal-editor-sheet", label: t(goal ? "goalEdit" : "goalNew"),
    onClose: () => { window.removeEventListener("beforeunload", beforeUnload); refreshGoals(); },
    canClose: async () => !saving && (!changed()
      || await ask({ title: t("discardChanges"), message: t("todoCloseBody"), confirm: t("discard"), destructive: true }) === "confirm") });
  const progressLabel = h("span");
  const progress = h("p", { className: "dialog-progress muse-editor-progress", role: "status", hidden: true, "data-testid": "goal-editor-progress" },
    h("span", { className: "spinner", "aria-hidden": "true" }), progressLabel);
  const error = h("p", { className: "form-error", role: "alert", hidden: true, "data-testid": "goal-editor-error" });
  const lock = (value: boolean, loading = false) => {
    saving = value; view.dialog.setAttribute("aria-busy", String(value)); progress.hidden = !value; progressLabel.textContent = t(loading ? "personalLoading" : "personalSaving");
    view.dialog.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLButtonElement>("input,textarea,button").forEach(control => { control.disabled = value; });
  };
  const reload = h("button", { type: "button", className: "button secondary", hidden: true, "data-testid": "goal-editor-reload", onclick: async () => {
    if (saving || changed() && await ask({ title: t("goalReloadTitle"), message: t("goalReloadBody"), confirm: t("todoReload") }) !== "confirm") return;
    lock(true, true);
    try {
      const [current, tasks] = await Promise.all([goal ? api<Goal>(`/api/goals/${goal.id}`) : Promise.resolve(undefined), api<{ todos: Todo[] }>("/api/todos")]);
      todos = tasks.todos;
      if (current) { source = current; selected = new Set(current.todoIds); populate(current); baseline = JSON.stringify(values()); }
      drawLinks(); error.hidden = true; reload.hidden = true;
    } catch (failure) { error.textContent = describe(failure); error.hidden = false; }
    finally { lock(false); }
  } }, t("todoReload"));
  const save = h("button", { type: "submit", className: "button primary", "data-testid": "goal-save" }, t("save"));
  const label = (name: string, field: Node) => h("label", { className: "stack" }, h("span", { className: "label" }, name), field);
  const form = h("form", { className: "todo-editor-form", onsubmit: async (event: Event) => {
    event.preventDefault();
    if (saving) return;
    clearInfoToasts(); lock(true); error.hidden = true; reload.hidden = true;
    const draft = values();
    try {
      const body = source ? { expectedRevision: source.revision,
        ...(draft.title !== source.title ? { title: draft.title } : {}), ...(draft.outcome !== source.outcome ? { outcome: draft.outcome } : {}),
        ...(draft.notes !== source.notes ? { notes: draft.notes } : {}),
        ...(JSON.stringify(draft.todoIds) !== JSON.stringify(source.todoIds) ? { todoIds: draft.todoIds } : {}) }
        : { ...draft, category };
      await api(source ? `/api/goals/${source.id}` : "/api/goals", { method: source ? "PATCH" : "POST",
        headers: source ? {} : { "idempotency-key": key }, json: body });
      baseline = JSON.stringify(values()); view.close(); toast(t("saved"));
    } catch (failure) {
      error.textContent = failure instanceof TypeError ? t(source ? "goalEditUnknown" : "goalCreateUnknown") : describe(failure);
      error.hidden = false; reload.hidden = !source || !(failure instanceof TypeError || failure instanceof APIError && (failure.status === 409 || failure.status === 408 || failure.status >= 500));
    } finally { lock(false); }
  } }, h("div", { className: "sheet-body goal-editor-body" }, label(t("goalTitle"), title), label(t("goalOutcome"), outcome),
    label(t("goalNotes"), notes), h("fieldset", {}, h("legend", { className: "label" }, t("goalLinkedTasks")), links),
    h("p", { className: "muted small" }, t("goalNoAutomaticWork"))), progress, error, reload,
  h("div", { className: "personal-form-actions" },
    h("button", { type: "button", className: "button secondary", "data-testid": "goal-editor-cancel", onclick: () => void view.attempt() }, t("cancel")), save));
  view.dialog.append(h("div", { className: "sheet-head" }, h("h2", { className: "sheet-title" }, t(goal ? "goalEdit" : "goalNew")),
    h("button", { type: "button", className: "icon-button", "aria-label": t("close"), "data-testid": "goal-editor-close", onclick: () => void view.attempt() }, icon("close"))), form);
  title.focus();
}

export async function renderGoals(context: PageHost, id: string | null) {
  const retained = activeView?.context === context && activeView.id === id
    ? context.main.querySelector<HTMLElement>('[data-testid="goals-page"][data-loaded="true"]') : null;
  if (retained?.querySelector('[data-testid="goals-menu"][aria-expanded="true"]')) closeMenu();
  const focused = context.main.contains(document.activeElement) ? document.activeElement : null;
  const scroll = retained?.scrollTop ?? 0;
  const version = ++generation;
  let busy = false, opening = false, issue = false;
  activeView = { context, id, busy: () => busy || opening || issue };
  const here = () => version === generation && context.main.isConnected && context.route() === "goals";
  const page = h("div", { className: "muse-goals-page", "aria-busy": "true", "data-testid": "goals-page" });
  const content = h("div", { className: "muse-goals-content" }, !id ? h("header", { className: "muse-goals-title" }, h("h1", {}, t("museGoals"))) : null,
    h("div", { className: "page-loading", role: "status" }, h("span", { className: "spinner", "aria-hidden": "true" }), t("personalLoading")));
  const feedback = h("section", { className: "goal-read-feedback", role: "status", "aria-live": "polite", "data-testid": "goals-refresh-feedback" },
    h("div", { className: "goal-read-feedback-content" }, h("p", { className: "muted" }, t("personalLoading"))));
  page.append(content);
  if (retained) {
    retained.setAttribute("aria-busy", "true");
    retained.querySelectorAll<HTMLInputElement | HTMLButtonElement>("button,input").forEach(control => { control.disabled = true; });
    context.main.querySelector(":scope > .goal-read-feedback")?.remove(); context.main.append(feedback);
  } else context.main.replaceChildren(page);
  const error = h("p", { className: "form-error", role: "alert", hidden: true, "data-testid": "goal-action-error" });
  const progressLabel = h("span", {}, t("personalSaving"));
  const progressNotice = h("p", { className: "dialog-progress", role: "status", hidden: true, "data-testid": "goal-action-progress" },
    h("span", { className: "spinner", "aria-hidden": "true" }), progressLabel);
  const reload = h("button", { type: "button", className: "button secondary", hidden: true, "data-testid": "goal-action-reload", onclick: () => void renderGoals(context, id) }, t("todoReload"));
  const lock = (value: boolean) => {
    content.setAttribute("aria-busy", String(value));
    content.querySelectorAll<HTMLInputElement | HTMLButtonElement>("button,input").forEach(control => { control.disabled = value; });
  };
  const edit = async (goal?: Goal, category: "health" | null = null) => {
    if (busy || opening) return;
    const focused = document.activeElement, owner = activeView, epoch = getContentEpoch(), route = location.hash;
    clearInfoToasts(); opening = true; progressLabel.textContent = t("personalLoading"); progressNotice.hidden = false; lock(true);
    try {
      const todos = (await api<{ todos: Todo[] }>("/api/todos")).todos;
      if (!here() || owner !== activeView || epoch !== getContentEpoch() || route !== location.hash
        || document.activeElement !== document.body && document.activeElement !== focused) return;
      progressNotice.hidden = true; lock(false);
      if (document.activeElement === document.body) returnFocus(focused);
      editGoal(todos, goal, category);
    }
    catch (failure) {
      if (here()) { issue = true; error.textContent = describe(failure); error.hidden = false; reload.hidden = false; }
      else failed(failure);
    } finally {
      opening = false;
      if (here()) {
        progressNotice.hidden = true; lock(false); if (document.activeElement === document.body) returnFocus(focused);
        if (!issue && !document.querySelector('[data-testid="goal-editor"][open]')) void renderGoals(context, id);
      }
    }
  };
  const mutate = async (work: () => Promise<unknown>, success?: () => void) => {
    if (busy) return;
    const focused = document.activeElement;
    clearInfoToasts(); busy = true; issue = false; error.hidden = true; reload.hidden = true; progressLabel.textContent = t("personalSaving"); progressNotice.hidden = false; lock(true);
    let completed = false;
    try { await work(); completed = true; }
    catch (failure) {
      if (here()) {
        issue = true;
        error.textContent = !(failure instanceof APIError) || failure.status === 408 || failure.status >= 500 ? t("goalActionUnknown") : describe(failure);
        error.hidden = false; reload.hidden = false;
      } else failed(failure, t("goalActionUnknown"));
    } finally {
      busy = false;
      if (here()) {
        progressNotice.hidden = true; lock(false);
        if (document.activeElement === document.body) returnFocus(focused);
      }
    }
    if (completed && here()) { if (success) success(); else void renderGoals(context, id); }
  };
  const complete = (goal: Goal, detail = false) => {
    const input = h("input", { type: "checkbox", checked: goal.completed, "data-testid": detail ? "goal-complete" : `goal-complete-${goal.id}`,
      "aria-label": t(goal.completed ? "goalReopen" : "goalComplete"), onchange: () => {
        const next = input.checked;
        input.checked = goal.completed;
        void mutate(() => api(`/api/goals/${goal.id}`, { method: "PATCH", json: { expectedRevision: goal.revision, completed: next } }));
      } });
    return h("label", { className: "goal-complete-control" }, input);
  };
  let keepSnapshot = false, retired = false;
  try {
    const planning = document.documentElement.hasAttribute("data-proactive");
    const [state, tasks, scopeReads] = await Promise.all([api<{ available: boolean; goals: Goal[] }>("/api/goals"), api<{ todos: Todo[] }>("/api/todos"),
      Promise.allSettled([planning ? api<{ schedules: ScheduleRow[] }>("/api/schedules") : Promise.resolve(undefined)])]);
    if (!here()) return;
    if (state.available !== true || !Array.isArray(state.goals) || !Array.isArray(tasks.todos)) throw new Error(t("goalUnavailable"));
    const todos = new Map(tasks.todos.map(todo => [todo.id, todo]));
    const scoped = scopeReads[0]!;
    const schedules = scoped.status === "fulfilled" && Array.isArray(scoped.value?.schedules) ? scoped.value.schedules : undefined;
    const scopeError = planning && schedules === undefined;
    const followups = (goal: Goal) => schedules?.filter(schedule => schedule.goal?.id === goal.id) ?? [];
    const following = (goal: Goal) => !goal.completed && followups(goal).some(schedule => ["active", "running"].includes(schedule.state));
    const followSection = (goal: Goal) => {
      if (!planning) return [];
      const rows = followups(goal);
      return [h("section", { className: "goal-detail-section goal-follow-up", "data-testid": "goal-follow-up" }, h("h2", {}, t("pfGoalFollowing")),
        scopeError ? h("p", { className: "form-error", role: "alert" }, t("pfGoalScopeUnavailable")) : !rows.length ? h("p", { className: "muted" }, t("pfGoalNotFollowing")) : null,
        ...rows.map(schedule => {
          const card = scheduleCard({ id: schedule.id, name: schedule.name }, schedule);
          card.dataset.testid = "goal-follow-up-open";
          return card;
        }),
        scopeError ? h("button", { type: "button", className: "button secondary", "data-testid": "goal-follow-retry",
          onclick: () => void renderGoals(context, id) }, t("personalRetry"))
          : !rows.length && !goal.completed ? h("button", { type: "button", className: "button secondary", "data-testid": "goal-follow",
            onclick: () => context.draftChat(t("pfGoalFollowDraft", { id: goal.id, title: goal.title })) }, t("pfGoalFollow")) : null)];
    };
    const progress = (goal: Goal) => {
      if (!goal.todoIds.length) return t("goalNoLinkedTasks");
      const done = goal.todoIds.filter(key => todos.get(key)?.completed).length;
      return t("goalTaskProgress", { done, total: goal.todoIds.length });
    };
    if (id) {
      const goal = state.goals.find(item => item.id === id);
      if (!goal) { retired = true; throw new Error(t("goalGone")); }
      content.replaceChildren(h("a", { href: "#/goals", className: "personal-back", "data-testid": "goals-back" }, icon("back", 16), t("museGoals")),
        h("header", { className: "muse-goals-title" }, h("h1", {}, goal.title),
          h("button", { type: "button", className: "icon-button", "data-testid": "goal-edit", "aria-label": t("goalEdit"), onclick: () => void edit(goal) }, icon("pencil"))),
        h("div", { className: `goal-tracking${goal.completed ? " completed" : ""}` }, complete(goal, true), h("span", { "data-testid": "goal-state" }, t(goal.completed ? "goalCompleted" : "goalTracking"))),
        h("section", { className: "goal-detail-section" }, h("h2", {}, t("goalOutcome")), h("p", { "data-testid": "goal-outcome" }, goal.outcome)),
        h("section", { className: "goal-detail-section", "data-testid": "goal-detail-notes" }, h("h2", {}, t("goalNotes")), progressNotes(goal, followups(goal))),
        h("section", { className: "goal-detail-section" }, h("h2", {}, t("goalLinkedTasks")), h("p", { className: "muted", "data-testid": "goal-progress" }, progress(goal)),
          ...goal.todoIds.map(key => {
            const todo = todos.get(key);
            return todo ? h("a", { href: `#/todos/${key}`, className: "goal-linked-task" }, icon(todo.completed ? "check" : "clock", 16), todo.title)
              : h("p", { className: "muted", "data-testid": `goal-missing-${key}` }, t("goalMissingTask", { id: key.slice(0, 8) }));
          })),
        ...followSection(goal),
        h("p", { className: "muted small" }, t("goalNoAutomaticWork")),
        progressNotice, error, reload,
        h("div", { className: "goal-detail-actions" },
          h("button", { type: "button", className: "button primary", "data-testid": "goal-ask",
            onclick: () => context.draftChat(t("goalDelegateDraft", { id: goal.id, title: goal.title, outcome: goal.outcome })) }, t("goalAsk")),
          h("button", { type: "button", className: "button danger-text", "data-testid": "goal-delete", onclick: async () => {
            if (await ask({ title: t("goalDelete"), message: t("goalDeleteBody", { title: goal.title }), confirm: t("delete"), destructive: true }) !== "confirm") return;
            await mutate(() => api(`/api/goals/${goal.id}`, { method: "DELETE", json: { expectedRevision: goal.revision } }), () => { location.hash = "#/goals"; });
          } }, t("delete"))));
    } else {
      const more = h("button", { type: "button", className: "icon-button muse-goals-menu", "aria-label": t("moreOptions"), "data-testid": "goals-menu",
        onclick: () => menu(more, [
          { label: t("goalNew"), icon: "plus", testID: "goal-new", run: () => void edit() },
          { label: t(showCompleted ? "goalHideCompleted" : "goalShowCompleted"), icon: "check", testID: "goal-show-completed",
            run: () => { showCompleted = !showCompleted; void renderGoals(context, null); } },
        ]) }, icon("more"));
      const list = (goals: Goal[]) => goals.map(goal => h("div", { className: "muse-goal-row" }, complete(goal),
        h("button", { type: "button", className: "goal-open", "data-testid": `goal-open-${goal.id}`, onclick: () => { location.hash = goalHash(goal.id); } },
          h("strong", {}, goal.title), h("span", {}, goal.outcome), goal.todoIds.length ? h("small", {}, progress(goal)) : null,
          planning ? h("small", { "data-testid": `goal-follow-state-${goal.id}` }, t(scopeError ? "pfGoalScopeUnavailable" : following(goal) ? "pfGoalFollowing" : "pfGoalNotFollowing")) : null)));
      const tracking = state.goals.filter(goal => !goal.completed), completed = state.goals.filter(goal => goal.completed);
      content.replaceChildren(h("header", { className: "muse-goals-title" }, h("h1", {}, t("museGoals")), more),
        h("div", { className: "goal-tracking" }, h("span", { className: "goal-tracking-dot", "aria-hidden": "true" }), t("goalTracking")),
        ...(tracking.length ? list(tracking) : [h("p", { className: "muted goals-empty", "data-testid": "goals-empty" }, t("goalEmpty"))]),
        ...(showCompleted && completed.length ? [h("h2", { className: "goal-completed-heading" }, t("goalCompleted")), ...list(completed)] : []),
        progressNotice, error, reload, h("section", { className: "goal-create-section" }, h("h2", {}, t("goalCreate")),
          h("button", { type: "button", className: "goal-health", "data-testid": "goal-health", onclick: () => void edit(undefined, "health") },
            icon("heart", 22), h("span", {}, t("goalHealth")), icon("chevron", 16))));
    }
    page.setAttribute("data-loaded", "true");
  } catch (failure) {
    if (!here()) return;
    issue = true;
    keepSnapshot = !!retained && !retired && !(failure instanceof APIError && [401, 403, 404].includes(failure.status));
    const message = h("p", { className: "form-error", role: "alert", "data-testid": "goals-error" },
      keepSnapshot ? `${t("goalReadStale")}\n\n${describe(failure)}` : describe(failure));
    const retry = h("button", { type: "button", className: "button secondary", "data-testid": "goals-retry", onclick: () => void renderGoals(context, id) }, t("museRetry"));
    if (keepSnapshot) feedback.replaceChildren(h("div", { className: "goal-read-feedback-content" }, message, retry));
    else content.replaceChildren(h("h1", {}, t("museGoals")), message, retry,
      ...(id ? [h("a", { href: "#/goals", className: "personal-back", "data-testid": "goals-back" }, icon("back", 16), t("museGoals"))] : []));
  } finally {
    if (here()) {
      if (keepSnapshot) retained!.setAttribute("aria-busy", "false");
      else { page.setAttribute("aria-busy", "false"); context.main.replaceChildren(page); page.scrollTop = scroll; }
      if (document.activeElement === document.body) {
        returnFocus(focused);
        if (document.activeElement === document.body && focused instanceof HTMLElement && ["goals-retry", "goal-action-reload"].includes(focused.dataset.testid ?? "")) {
          context.main.querySelector<HTMLElement>('[data-testid="goal-edit"],[data-testid="goals-menu"],[data-testid="goals-back"]')?.focus({ preventScroll: true });
        }
      }
    }
  }
}

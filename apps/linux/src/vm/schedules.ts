import { contentRevision, goalTaskFunctions, goalTaskLimits, OxError, publicSourceURL, stableID, type FunctionCall, type Goal, type GoalRunReport, type GoalTaskBinding, type LinuxProfile, type SpaceScheduleBinding } from "@openox/agent/linux";
import { HTTPError, json, payload } from "../http";
import type { VMContext, VMFactory } from "./context";
import { conversationUUID } from "./conversations";
import { hostTimeZone, isoDate, nextOccurrence, parseISODate, recurrenceSummary, validRecurrence, validTimeZone, weekdays, type Recurrence } from "./schedules-recurrence";
import { scheduleErrors, ScheduleStore, type Schedule, type ScheduleEdit, type ScheduleOutcome } from "./schedules-store";
import { FunctionApprovals } from "./skills-approval";
import { attentionTitle, preview } from "../notifications";
import { assistantVoiceEnabled, evidenceGoalChecksEnabled, evidenceOnlyEnabled, goalSoftBudgetEnabled, museParityEnabled, personalAgentEnabled, proactiveAgentEnabled } from "../config";
import { Approvals } from "./approvals";
import { isObject, same } from "./services/support";

type CreateInput = {
  name: string; prompt: string; frequency: string; fireAt?: string; intervalSeconds?: number; hour?: number; minute?: number; weekday?: string; timeZone?: string;
  condition?: string; deadline?: string; conversation?: "current" | "new"; services?: string[];
  goalId?: string;
};
type GoalRun = { binding: GoalTaskBinding; goal: Goal; revision: number; models: number; operations: number; reads: number;
  sources: Map<string, { url: string; sha256: string }>; submissionId?: string; failure?: string; report?: GoalRunReport;
  commit?: Extract<GoalRunReport, { outcome: "updated" }>["commit"] };

const describe = (error: unknown) => error instanceof Error ? error.message : String(error);
const failed = (message: string): ScheduleOutcome => ({ kind: "failed", message });
const timing = (message: string) => new OxError("invalid_argument", message, "Read ox.schedule.create.help() and retry with valid timing.");
const statuses: Record<string, number> = { not_found: 404, conflict: 409, unavailable: 503, limit_exceeded: 409 };

function goalProgressPreview(previous: Goal, current: Goal) {
  if (current.revision === previous.revision + 1 && previous.notes && current.notes.startsWith(previous.notes)) {
    const added = current.notes.slice(previous.notes.length);
    if (/[\r\n][ \t]*$/.test(previous.notes) || /^[ \t]*[\r\n]/.test(added)) {
      const body = preview(added);
      if (body) return body;
    }
  }
  return preview(current.notes);
}

function recurrenceOf(input: CreateInput, now: number): Recurrence {
  const zone = input.timeZone ?? hostTimeZone();
  switch (input.frequency) {
    case "interval":
      if (input.intervalSeconds === undefined) throw scheduleErrors.invalidRecurrence();
      return { type: "interval", seconds: input.intervalSeconds };
    case "once": {
      const fireAt = input.fireAt === undefined ? undefined : parseISODate(input.fireAt);
      if (fireAt === undefined || fireAt <= now) throw timing("ox.schedule.create: fireAt must be a future ISO-8601 timestamp for a one-time schedule.");
      return { type: "once", fireAt };
    }
    case "daily":
      if (input.hour === undefined || input.minute === undefined) throw timing("ox.schedule.create: hour and minute are required for a daily schedule.");
      return { type: "daily", hour: input.hour, minute: input.minute, timeZone: zone };
    case "weekly": {
      const weekday = weekdays.indexOf((input.weekday ?? "").toLowerCase() as typeof weekdays[number]) + 1;
      if (input.hour === undefined || input.minute === undefined || !weekday) throw timing("ox.schedule.create: weekday, hour, and minute are required for a weekly schedule.");
      return { type: "weekly", weekday, hour: input.hour, minute: input.minute, timeZone: zone };
    }
    default: throw timing("ox.schedule.create: frequency must be once, interval, daily, or weekly.");
  }
}

function editOf(body: Record<string, unknown>): ScheduleEdit {
  const { name, prompt, recurrence } = body;
  const condition = body.condition ?? null, deadline = body.deadline ?? null;
  if (typeof name !== "string" || typeof prompt !== "string" || (condition !== null && typeof condition !== "string")
    || (deadline !== null && (typeof deadline !== "number" || !Number.isFinite(deadline))) || !recurrence || typeof recurrence !== "object" || Array.isArray(recurrence)) {
    throw new HTTPError(400, "Expected name, prompt, condition, deadline and recurrence");
  }
  const value = recurrence as Record<string, unknown>;
  const number = (key: string) => typeof value[key] === "number" ? value[key] as number : Number.NaN;
  const zone = typeof value.timeZone === "string" ? value.timeZone : "";
  const parsed: Recurrence | undefined = value.type === "interval" ? { type: "interval", seconds: number("seconds") }
    : value.type === "once" ? { type: "once", fireAt: number("fireAt") }
    : value.type === "daily" ? { type: "daily", hour: number("hour"), minute: number("minute"), timeZone: zone }
    : value.type === "weekly" ? { type: "weekly", weekday: number("weekday"), hour: number("hour"), minute: number("minute"), timeZone: zone } : undefined;
  if (!parsed) throw scheduleErrors.invalidRecurrence();
  return { name, prompt, condition: condition as string | null, deadline: deadline as number | null, recurrence: parsed };
}

const intent = (schedule: Schedule) => schedule.condition === null ? schedule.prompt : `${schedule.prompt}

This is a scheduled condition check. Stop condition: ${schedule.condition}
Check the condition now. If it is true, perform the requested final action and call ox.schedule.complete({ purpose: "Condition met" }).
If it is false, finish this check without completing the schedule; Ox will check again later. Do not sleep or poll inside this run.`;

export const schedulesModule: VMFactory = (context: VMContext) => {
  const store = new ScheduleStore(context.paths.state, () => context.emit({ type: "schedules" }));
  const approvals = FunctionApprovals.for(context.paths.state);
  const permissions = Approvals.for(context.paths.state);
  const runs = new Map<number, { id: string; token: string; space?: SpaceScheduleBinding; goal?: GoalRun }>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let work: Promise<void> | undefined;
  let active: { id: string; conversationId?: number; stopped?: boolean } | undefined;
  let started = false, closed = false;
  let chain: Promise<void> = Promise.resolve();
  const log = (error: unknown) => context.logs.warning("schedules", describe(error));
  const uuid = (id: number) => conversationUUID(context.settings().profile.id, id);

  const result = (schedule: Schedule) => ({
    id: schedule.id, name: schedule.name, prompt: schedule.prompt, status: schedule.state, enabled: schedule.state === "active" || schedule.state === "running",
    recurrence: recurrenceSummary(schedule.recurrence),
    ...(schedule.condition !== null ? { condition: schedule.condition } : {}),
    ...(schedule.deadline !== null ? { deadline: isoDate(schedule.deadline) } : {}),
    ...(schedule.conversationId !== null ? { conversationId: uuid(schedule.conversationId) } : {}),
    ...(schedule.nextFireAt !== null ? { nextFireAt: isoDate(schedule.nextFireAt) } : {}),
    ...(schedule.lastRunAt !== null ? { lastRunAt: isoDate(schedule.lastRunAt) } : {}),
    ...(schedule.lastOutcome ? { lastOutcome: schedule.lastOutcome.kind, ...(schedule.lastOutcome.kind === "failed" ? { lastError: schedule.lastOutcome.message } : {}) } : {}),
    ...(schedule.lastConversationId !== null ? { lastConversationId: uuid(schedule.lastConversationId) } : {}),
    ...(schedule.goal ? { goal: schedule.goal } : {}), ...(schedule.lastReport ? { lastReport: schedule.lastReport } : {}),
  });
  const row = (schedule: Schedule) => ({ id: schedule.id, name: schedule.name, prompt: schedule.prompt, recurrence: schedule.recurrence, summary: recurrenceSummary(schedule.recurrence), state: schedule.state,
    condition: schedule.condition, deadline: schedule.deadline,
    nextFireAt: schedule.nextFireAt, lastRunAt: schedule.lastRunAt, lastOutcome: schedule.lastOutcome?.kind ?? null,
    lastError: schedule.lastOutcome?.kind === "failed" ? schedule.lastOutcome.message : null, conversationId: schedule.lastConversationId ?? schedule.conversationId,
    ...(schedule.space ? { space: schedule.space, lastCommit: schedule.lastCommit ?? null, modelAvailable: !!context.defaultModel() } : {}),
    ...(schedule.goal ? { goal: schedule.goal, limits: limits(), lastReport: schedule.lastReport ?? null,
      modelAvailable: context.providers.configured(schedule.goal.model.provider) && !!context.providers.models.getModel(schedule.goal.model.provider, schedule.goal.model.modelId) } : {}) });
  const ready = () => { if (store.failure) throw new OxError("unavailable", store.failure, "Ask the user to repair or move the schedules file, then restart the Host."); };
  const owned = (id: string) => {
    ready();
    const schedule = store.get(id);
    if (!schedule) throw new OxError("not_found", `No schedule with id '${id}' exists in this Profile.`, "List schedules with ox.schedule.list before retrying.");
    return schedule;
  };

  const stop = (profile: LinuxProfile, conversationId: number) => {
    if (!active || active.conversationId !== conversationId || active.stopped) return;
    active.stopped = true;
    void profile.stop(conversationId).catch(log);
  };
  const scoped = (conversationId: number) => {
    const run = runs.get(conversationId);
    if (!run?.goal) return undefined;
    const schedule = owned(run.id);
    if (closed || !proactiveAgentEnabled() || schedule.state !== "running" || schedule.token !== run.token) throw new OxError("cancelled", "This original Goal check is no longer active.");
    if (run.goal.failure) throw new OxError("permission_denied", run.goal.failure);
    return { schedule, run: run.goal };
  };
  const newSources = (schedule: Schedule, run: GoalRun) => !schedule.lastReport || schedule.lastReport.goalRevision !== run.goal.revision
    || [...run.sources.values()].some(source => !schedule.lastReport!.sources.some(previous => previous.url === source.url && previous.sha256 === source.sha256));
  const limits = () => goalSoftBudgetEnabled() ? { ...goalTaskLimits, requests: 16, milliseconds: 240_000 } : goalTaskLimits;
  function failScope(run: GoalRun, message: string, code = "permission_denied"): never {
    run.failure ??= message;
    throw new OxError(code, run.failure);
  }
  async function verifyGoalScope(run: GoalRun, conversationId: number) {
    let revision: number;
    try { revision = (await permissions.current()).revision; }
    catch (error) { return failScope(run, describe(error), "unavailable"); }
    if (run.failure) throw new OxError("permission_denied", run.failure);
    if (revision !== run.revision) failScope(run, "Permissions changed during this Goal check.");
    const profile = context.profile();
    if ((await profile.goals.get(run.binding.id)).completed) {
      stop(profile, conversationId);
      throw new OxError("cancelled", "The owner completed this Goal. No further check work is authorized.");
    }
  }

  async function finishGoal(schedule: Schedule, run: GoalRun): Promise<ScheduleOutcome> {
    if (run.failure) return failed(run.failure);
    const report = run.report;
    if (!report || !run.submissionId) return failed("This Goal check produced no original source and progress report receipt.");
    const current = await context.profile().goals.get(run.binding.id);
    if (current.completed || current.revision !== report.goalRevision || report.outcome === "updated" && contentRevision(current.notes) !== report.commit.fingerprint) {
      return failed("The Goal changed after this check. Review its original result before resuming.");
    }
    const revision = await permissions.backgroundDecision(context, `ox.schedule.execute:${schedule.id}`, `${schedule.token}:publish`, true);
    if (revision !== run.revision) return failed("Permissions changed during this Goal check.");
    if (report.outcome === "updated") {
      const activeSchedule = store.get(schedule.id);
      if (closed || active?.stopped || activeSchedule?.state !== "running" || activeSchedule.token !== schedule.token) {
        return { kind: "cancelled" };
      }
      const id = stableID(`goal-notice:${context.profile().id}:${schedule.id}:${run.submissionId}`);
      const body = goalProgressPreview(run.goal, current), notice = await context.profile().inbox.enqueue({ id, tag: `goal-${schedule.id}`,
        targetUrl: `/#/c/${run.binding.conversationId}`, urgency: "normal", title: { en: current.title, "zh-Hans": current.title },
        body: { en: body, "zh-Hans": body }, occurredAt: report.at });
      context.notify({ id: notice.id, tag: notice.tag, url: notice.targetUrl, urgency: notice.urgency,
        title: language => notice.title[language], body: language => notice.body[language] });
    }
    return { kind: "succeeded", report };
  }

  async function submit(profile: LinuxProfile, conversationId: number, schedule: Schedule): Promise<ScheduleOutcome> {
    let poll: ReturnType<typeof setInterval> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined, timedOut = false;
    const stopped = () => !!(schedule.space || schedule.goal) && active?.id === schedule.id && active.stopped === true;
    const submissionId = crypto.randomUUID();
    const goal = runs.get(conversationId)?.goal;
    if (goal) goal.submissionId = submissionId;
    const prompt = goal ? `${intent(schedule)}\n\n<goal_context>${JSON.stringify(goal.goal)}</goal_context>\nUser time zone: ${goal.binding.timeZone}. `
      + "Check only public information relevant to this Goal. Preserve useful original notes and cite actual inspected sources. "
      + "Call ox.schedule.report with updated only after this submission's real notes update, or no_change after successful checks with no substantive progress. "
      + "A failed source is not no change. Do not create other work or complete the Goal."
      + (goalSoftBudgetEnabled() ? ` This check may read at most ${goalTaskLimits.sources} pages: start with the most relevant listing or news page, and report once you have checked it.` : "")
      : schedule.space ? `${intent(schedule)}\n\nThis original scheduled update is bound to Space ${schedule.space.id}, explicit data slot ${schedule.space.slot}. Use ox.space.data.read/write with this slot and its actual sourceRevision. Only an original file commit from this submission proves an update. Do not claim freshness from text, old files or cached results.` : intent(schedule);
    const run = context.submit(conversationId, prompt, [], { schedule: schedule.name }, submissionId,
      { id: schedule.id, ...(goal ? { goal: goal.binding.id } : {}),
        ...(assistantVoiceEnabled() && !goal && !schedule.space && schedule.recurrence.type === "once" ? { followUp: true } : {}),
        active: () => { const current = store.get(schedule.id); return !closed && current?.state === "running" && current.token === schedule.token; } },
      undefined, goal?.binding.timeZone);
    if (goal) deadline = setTimeout(() => { timedOut = true; stop(profile, conversationId); }, limits().milliseconds);
    const attention = new Promise<"attention">(resolve => {
      poll = setInterval(() => {
        if (profile.pendingPrompt(conversationId)) resolve("attention");
        const state = store.get(schedule.id)?.state;
        if (state !== "running" && state !== "completed") stop(profile, conversationId);
      }, 200);
    });
    try {
      const value = await Promise.race([run, attention]);
      if (timedOut) return failed("This Goal check exceeded its finite runtime limit.");
      if (goal?.failure) return failed(goal.failure);
      if (stopped()) return { kind: "cancelled" };
      if (value === "attention") {
        if (goal) { stop(profile, conversationId); await run; }
        return failed("The schedule needs attention in Ox.");
      }
      if (value.outcome !== "completed") return value.outcome === "cancelled" ? { kind: "cancelled" } : failed(value.error || "The scheduled check failed.");
      if (goal) return await finishGoal(schedule, goal);
      if (!schedule.space) return { kind: "succeeded" };
      const current = await profile.spaceData(schedule.space), receipt = current.document.receipts.find(receipt =>
        receipt.source?.kind === "schedule" && receipt.source.submissionId === submissionId && receipt.source.scheduleId === schedule.id);
      if (!receipt) return failed("This scheduled attempt produced no original Space data commit. Model text is not an update proof.");
      return { kind: "succeeded", commit: { fileId: schedule.space.dataFileId, requestId: receipt.id, submissionId,
        revision: receipt.revision, fingerprint: receipt.fingerprint, at: receipt.at } };
    } catch (error) { return timedOut ? failed("This Goal check exceeded its finite runtime limit.") : stopped() ? { kind: "cancelled" } : failed(describe(error)); }
    finally { clearInterval(poll); clearTimeout(deadline); }
  }

  async function execute(schedule: Schedule, token: string): Promise<{ outcome: ScheduleOutcome; conversationId?: number }> {
    const profile = context.profile();
    let conversationId: number | undefined;
    try {
      let goal: Goal | undefined;
      if (schedule.goal) {
        if (!proactiveAgentEnabled() || evidenceOnlyEnabled() && !evidenceGoalChecksEnabled()) return { outcome: failed("Goal follow-through is unavailable in this Host mode.") };
        goal = await profile.goals.get(schedule.goal.id);
        if (goal.completed) return { outcome: { kind: "cancelled" } };
        context.providers.validChoice(schedule.goal.model);
      }
      if (schedule.space) {
        if (!museParityEnabled()) return { outcome: failed("Space updates are unavailable while Muse is disabled.") };
        await profile.validateSpaceBinding(schedule.space);
      }
      const revision = museParityEnabled() ? await permissions.backgroundDecision(context, `ox.schedule.execute:${schedule.id}`, token, !!schedule.goal) : 0;
      if (schedule.space) await profile.validateSpaceBinding(schedule.space);
      if (schedule.conversationId !== null) {
        if (!await profile.summary(schedule.conversationId).then(() => true, () => false)) return { outcome: failed("The schedule's conversation is unavailable.") };
        conversationId = schedule.conversationId;
        if (profile.busy(conversationId) || runs.has(conversationId)) return { outcome: failed("The schedule's conversation is busy. Resume the schedule when it is ready."), conversationId };
      } else {
        const choice = schedule.goal?.model ?? context.defaultModel();
        if (!choice) return { outcome: failed("Choose a default model in Settings so this schedule can run.") };
        conversationId = await profile.create(choice, schedule.goal ? { backgroundGoal: schedule.goal.id } : {});
        await profile.rename(conversationId, schedule.name);
      }
      if (active) active.conversationId = conversationId;
      const current = store.get(schedule.id);
      if (closed || current?.state !== "running" || current.token !== token) return { outcome: { kind: "cancelled" }, conversationId };
      try { await store.bind(schedule.id, token, conversationId); } catch { return { outcome: { kind: "cancelled" }, conversationId }; }
      runs.set(conversationId, { id: schedule.id, token, ...(schedule.space ? { space: schedule.space } : {}),
        ...(schedule.goal && goal ? { goal: { binding: schedule.goal, goal, revision, models: 0, operations: 0, reads: 0, sources: new Map() } } : {}) });
      try { return { outcome: await submit(profile, conversationId, schedule), conversationId }; }
      finally { if (runs.get(conversationId)?.token === token) runs.delete(conversationId); }
    } catch (error) { return { outcome: failed(describe(error)), conversationId }; }
  }

  async function process() {
    for (const due of store.due(Date.now())) {
      if (closed || context.contentBlocked?.()) return;
      if (store.get(due.id)?.state !== "active") continue;
      active = { id: due.id };
      let token: string;
      try { token = await store.claim(due.id, Date.now()); }
      catch (error) { active = undefined; log(error); continue; }
      const { outcome, conversationId } = await execute(store.get(due.id) ?? due, token);
      active = undefined;
      if (closed) return;
      await store.record(due.id, token, outcome, conversationId ?? null, Date.now()).catch(log);
      context.logs.info("schedules", `run id=${due.id} conversation=${conversationId ?? "none"} outcome=${outcome.kind}`);
      if (outcome.kind === "failed") {
        const name = (store.get(due.id) ?? due).name, message = outcome.message;
        context.logs.warning("schedules", `schedule needs attention id=${due.id}: ${message}`);
        context.notify({ tag: `schedule-${due.id}`, url: conversationId === undefined ? "/#/schedules" : `/#/c/${conversationId}`, urgency: "normal",
          title: language => attentionTitle(language, name), body: () => message });
      }
    }
  }

  async function update() {
    if (!started || closed || store.failure || context.contentBlocked?.()) return;
    await store.expire(Date.now()).catch(log);
    if (active?.conversationId !== undefined) {
      const state = store.get(active.id)?.state;
      if (state !== "running" && state !== "completed") stop(context.profile(), active.conversationId);
    }
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (closed) return;
    if (!work && store.due(Date.now()).length) {
      work = process().catch(log).finally(() => { work = undefined; void refresh(); });
      return;
    }
    const next = work ? (active ? store.get(active.id)?.deadline ?? undefined : undefined) : store.nextEnabledDate();
    if (next === undefined) return;
    timer = setTimeout(() => void refresh(), Math.min(Math.max(next - Date.now(), 1_000), 60_000));
  }
  const refresh = () => {
    chain = chain.then(update).catch(log);
    return chain;
  };

  const routeError = (error: unknown) => error instanceof OxError ? new HTTPError(statuses[error.code] ?? 400, error.message) : error;

  return {
    handlers: {
      "ox.schedule.create": async call => {
        ready();
        const input = call.args as CreateInput;
        if (input.goalId !== undefined) {
          if (!proactiveAgentEnabled() || evidenceOnlyEnabled() && !evidenceGoalChecksEnabled()) throw new OxError("not_supported", "Goal follow-through is unavailable in this Host mode.");
          const profile = context.profile(), summary = await profile.summary(call.conversationId);
          if (summary.temporary || call.page || !call.requestID || !permissions.submission(call)) throw new OxError("permission_denied", "Goal follow-through requires an original regular user submission.");
          const goal = await profile.goals.get(input.goalId);
          if (goal.completed) throw new OxError("conflict", "This Goal is already completed. Reopen it explicitly before requesting follow-through.");
          if (input.conversation === "current" || input.services?.length || input.condition !== undefined
            || input.frequency !== "daily" && !(input.frequency === "interval" && input.intervalSeconds === 86400)) {
            throw new OxError("invalid_argument", "Goal follow-through uses one daily public-research check, not current-chat work, account services or a model-controlled completion condition.");
          }
          const timeZone = input.timeZone ?? await profile.userTimeZone(call.conversationId);
          if (!timeZone || !validTimeZone(timeZone)) throw timing("Choose the user's explicit time zone for this Goal follow-through.");
          const recurrence = recurrenceOf({ ...input, timeZone }, Date.now());
          if (!validRecurrence(recurrence) || !summary.model) throw scheduleErrors.invalid();
          const deadline = input.deadline === undefined ? null : parseISODate(input.deadline);
          if (deadline === undefined) throw scheduleErrors.invalid();
          const next = nextOccurrence(recurrence, Date.now());
          if (next === undefined || deadline !== null && deadline <= next) throw scheduleErrors.future();
          const model = context.providers.validChoice(summary.model), id = stableID(`goal-schedule:${profile.id}:${call.requestID}`).toUpperCase();
          const existing = store.list().find(s => s.goal?.id === goal.id && s.goal.conversationId === call.conversationId
            && s.goal.timeZone === timeZone && same(s.goal.model, model) && same(s.recurrence, recurrence)
            && s.prompt === input.prompt.trim() && s.deadline === deadline);
          if (existing && existing.id !== id) {
            const action = `ox.schedule.execute:${existing.id}`;
            if (!["active", "running"].includes(existing.state) || (await permissions.current()).actions[action] !== "allow")
              throw new OxError("conflict", "This watch already exists but is paused or no longer authorized. No new watch was created.");
            await permissions.require(call, action, "ask", { originalAction: "ox.schedule.create", standing: goal.id, title: "Follow this goal with public research" });
            await permissions.guard(call);
            const current = owned(existing.id);
            if (!["active","running"].includes(current.state) || !same(current.goal, existing.goal) || !same(current.recurrence, recurrence)
              || current.prompt !== existing.prompt || current.deadline !== deadline || (await profile.goals.get(goal.id)).completed) throw scheduleErrors.invalid();
            return result(current);
          }
          await permissions.require(call, `ox.schedule.execute:${id}`, "ask", { originalAction: "ox.schedule.create", standing: goal.id,
            title: "Follow this goal with public research",
            body: [`Goal: ${JSON.stringify(goal.title)}`,
              ...(recurrence.type === "daily" ? [`Frequency: ${recurrenceSummary(recurrence)}.`] : [`Time zone: ${timeZone}`, "Frequency: once per day."]),
              "Check public sources with your selected model and notify you only about meaningful changes. This may use paid model quota. You can pause it at any time.",
              ...(deadline === null ? [] : [`End by ${new Date(deadline).toISOString()}.`])].join("\n\n"),
            args: { goalId: goal.id, model, recurrence, timeZone, nextFireAt: next, deadline, limitsPerCheck: limits(),
              scope: "Public research and this Goal's progress only. No private memory/files, credentials, other goals, accounts, external sending or additional jobs.",
              ends: deadline === null ? "When paused or this Goal is completed" : new Date(deadline).toISOString() } });
          const draft = await store.create({ name: input.name, prompt: input.prompt, services: [], condition: null, deadline,
            conversationId: null, recurrence, goal: { id: goal.id, conversationId: call.conversationId, model, timeZone } },
          Date.now(), { key: call.requestID, id, enabled: false });
          await permissions.guard(call);
          if ((await profile.goals.get(goal.id)).completed) throw new OxError("conflict", "The Goal was completed while follow-through was being authorized. Its draft remains paused.");
          const schedule = draft.replayed ? draft.schedule : await store.setEnabled(draft.schedule.id, true, Date.now());
          context.logs.info("schedules", `goal follow-through id=${schedule.id} goal=${goal.id} replayed=${draft.replayed}`);
          void refresh();
          return result(schedule);
        }
        const now = Date.now();
        const recurrence = recurrenceOf(input, now);
        const deadline = input.deadline === undefined ? null : parseISODate(input.deadline) ?? null;
        if (input.deadline !== undefined && deadline === null) throw scheduleErrors.invalid();
        const condition = input.condition ?? null;
        if (!input.name.trim() || !input.prompt.trim() || (condition !== null && (!condition.trim() || recurrence.type === "once" || deadline === null))) throw scheduleErrors.invalid();
        if (!validRecurrence(recurrence)) throw scheduleErrors.invalidRecurrence();
        const next = nextOccurrence(recurrence, now);
        if (next === undefined || (deadline !== null && deadline <= next)) throw scheduleErrors.future();
        await approvals.require(call, { action: "ox.schedule.create", title: "Create a schedule",
          args: { ...call.args, ...(recurrence.type === "daily" || recurrence.type === "weekly" ? { timeZone: recurrence.timeZone } : {}) } });
        const { schedule } = await store.create({ name: input.name, prompt: input.prompt, services: input.services ?? [], condition, deadline,
          conversationId: input.conversation === "current" ? call.conversationId : null, recurrence }, Date.now());
        // A one-time follow-up the user asked for in this chat carries consent for that single run, as creating a Goal watch does.
        if (assistantVoiceEnabled() && recurrence.type === "once" && input.conversation === "current" && !input.services?.length && condition === null)
          await permissions.set(`ox.schedule.execute:${schedule.id}`, "allow");
        context.logs.info("schedules", `create id=${schedule.id} frequency=${input.frequency} conditional=${condition !== null}`);
        void refresh();
        return result(schedule);
      },
      "ox.schedule.complete": async call => {
        const run = runs.get(call.conversationId);
        if (!run) throw new OxError("invalid_state", "Only an active scheduled check can complete its own schedule.", "If the condition is false, finish this check without calling ox.schedule.complete.");
        await store.complete(run.id, run.token, Date.now());
        context.logs.info("schedules", `complete id=${run.id} conversation=${call.conversationId}`);
        void refresh();
        return { id: run.id, completed: true };
      },
      "ox.schedule.list": async () => { ready(); return store.list().map(result); },
      "ox.schedule.delete": async call => {
        const schedule = owned(String(call.args.id));
        await approvals.require(call, { action: "ox.schedule.delete", title: "Delete a schedule", args: { purpose: call.args.purpose, id: schedule.id, name: schedule.name } });
        await store.delete(schedule.id);
        context.logs.info("schedules", `delete id=${schedule.id}`);
        void refresh();
        return { id: String(call.args.id), deleted: true };
      },
      "ox.schedule.enable": async call => {
        const schedule = owned(String(call.args.id));
        const enabled = call.args.enabled === true;
        await approvals.require(call, { action: "ox.schedule.enable", title: "Change a schedule", args: { purpose: call.args.purpose, id: schedule.id, name: schedule.name, enabled } });
        const updated = await store.setEnabled(schedule.id, enabled, Date.now());
        context.logs.info("schedules", `enable id=${schedule.id} enabled=${enabled}`);
        void refresh();
        return result(updated);
      },
      "ox.schedule.run": async call => {
        const schedule = owned(String(call.args.id));
        await approvals.require(call, { action: "ox.schedule.run", title: "Run a schedule", args: { purpose: call.args.purpose, id: schedule.id, name: schedule.name } });
        await store.fireNow(schedule.id, Date.now());
        context.logs.info("schedules", `run now id=${schedule.id}`);
        void refresh();
        return { id: String(call.args.id), started: true };
      },
      ...(proactiveAgentEnabled() ? { "ox.schedule.report": async (call: FunctionCall) => {
        const current = scoped(call.conversationId);
        if (!current) throw new OxError("invalid_state", "Only the original active Goal check can report its result.");
        const { run, schedule } = current;
        if (!run.sources.size || !run.submissionId) throw new OxError("invalid_state", "No readable public source was checked. This is not a no-change result.");
        const goal = await context.profile().goals.get(run.binding.id);
        let report: GoalRunReport;
        const checked = { goalRevision: goal.revision, sources: [...run.sources.values()], at: new Date().toISOString() };
        if (call.args.outcome === "updated") {
          if (!run.commit || !newSources(schedule, run) || goal.revision !== run.commit.revision || contentRevision(goal.notes) !== run.commit.fingerprint) {
            throw new OxError("invalid_state", "This submission has no current original Goal progress commit from new source content.");
          }
          report = { outcome: "updated", ...checked, commit: run.commit };
        } else {
          if (run.commit) throw new OxError("conflict", "This check already committed progress; it cannot report no change.");
          report = { outcome: "no_change", ...checked };
        }
        if (run.report && JSON.stringify(run.report) !== JSON.stringify(report)) throw new OxError("conflict", "This original Goal check already reported its result.");
        run.report = report;
        return { id: schedule.id, goalId: run.binding.id, report };
      } } : {}),
    },
    ...(proactiveAgentEnabled() ? {
      discoveryReports: async () => {
        if (store.failure) throw new OxError("unavailable", "The original Goal schedule store is unavailable.");
        return store.list().flatMap(s => {
          const report = s.lastProgressReport ?? s.lastReport;
          if (!s.goal || !["active", "running"].includes(s.state) || report?.outcome !== "updated") return [];
          return [{ scheduleId: s.id, goalId: s.goal.id, conversationId: s.goal.conversationId, report,
            noticeId: stableID(`goal-notice:${context.profile().id}:${s.id}:${report.commit.submissionId}`) }];
        });
      },
      goalTask: (id: number) => runs.get(id)?.goal?.binding,
      beforeModelRequest: async (id: number) => {
        const current = scoped(id);
        if (!current) return;
        await verifyGoalScope(current.run, id);
        if (++current.run.models > limits().requests) failScope(current.run, "This Goal check reached its model request limit.", "limit_exceeded");
      },
      beforeFunction: async (call: FunctionCall) => {
        const current = scoped(call.conversationId);
        if (!current) return;
        const { run, schedule } = current;
        await verifyGoalScope(run, call.conversationId);
        if (++run.operations > goalTaskLimits.operations) failScope(run, "This Goal check reached its operation limit.", "limit_exceeded");
        if (!goalTaskFunctions.some(name => name === call.name)) {
          failScope(run, `This Goal check only permits anonymous public research, its own progress notes and its original report. Requested: ${call.name}.`);
        }
        if (run.report) throw new OxError("invalid_state", "This Goal check already reported. No further work is authorized.");
        if (call.name === "ox.web.fetch") {
          const url = publicSourceURL(String(call.args.url));
          if (++run.reads > goalTaskLimits.sources) {
            if (goalSoftBudgetEnabled() && run.reads <= goalTaskLimits.sources + 4) throw new OxError("limit_exceeded", `This check has used its source budget (${goalTaskLimits.sources} page reads). Read no more pages: save new source-backed notes with ox.goal.update if you have them, then call ox.schedule.report.`);
            failScope(run, "This Goal check reached its source limit.", "limit_exceeded");
          }
          if (isObject(call.args.options) && Object.keys(call.args.options).some(key => !["maxBytes", "maxPages"].includes(key))) failScope(run, "Goal research cannot select account headers or sessions.");
          call.args.url = url;
          call.args.options = { ...(isObject(call.args.options) ? call.args.options : {}), maxBytes: Math.min(isObject(call.args.options) && typeof call.args.options.maxBytes === "number" ? call.args.options.maxBytes : 6144, 6144) };
        } else if (call.name === "ox.web.search") {
          if (call.args.sessions !== undefined || typeof call.args.query !== "string" || call.args.query.length > 500 || /\$secret\b/i.test(call.args.query)) {
            failScope(run, "Goal research only permits bounded anonymous public queries, not account sessions or secrets.");
          }
          call.args.domains ??= ["duckduckgo.com", "search.brave.com", "google.com"];
          if (!Array.isArray(call.args.domains) || call.args.domains.length > 3) failScope(run, "Goal research permits at most three public search domains per query.", "limit_exceeded");
        } else if (call.name === "ox.goal.update") {
          if (call.args.id !== run.binding.id || Object.keys(call.args).some(key => !["purpose", "id", "expectedRevision", "notes"].includes(key))) {
            failScope(run, "This Goal check cannot change another Goal, completion, criteria or task links.");
          }
          if (!run.sources.size || !newSources(schedule, run) || run.commit || typeof call.args.notes !== "string"
            || call.args.notes.trim() === run.goal.notes.trim() || ![...run.sources.keys()].some(url => String(call.args.notes).includes(url))) {
            throw new OxError("invalid_state", "Save only substantively new source-backed notes with an inspected source URL, once per check. Otherwise report no_change.");
          }
        }
      },
      afterFunction: async (call: FunctionCall, value: unknown) => {
        const current = scoped(call.conversationId);
        if (!current || !isObject(value)) return;
        const { run } = current;
        if (call.name === "ox.web.fetch" && value.ok === true && typeof value.url === "string") {
          const text = typeof value.text === "string" ? value.text.trim() : isObject(value.feed) && Array.isArray(value.feed.entries) && value.feed.entries.length ? JSON.stringify(value.feed.entries) : "";
          if (text) {
            const url = publicSourceURL(value.url);
            run.sources.set(url, { url, sha256: contentRevision(text.replace(/\s+/g, " ")) });
          }
        } else if (call.name === "ox.goal.update") {
          if (value.id !== run.binding.id || typeof value.revision !== "number" || typeof value.notes !== "string" || !call.requestID || !run.submissionId) {
            failScope(run, "The original Goal update receipt is unavailable.");
          }
          run.commit = { requestId: call.requestID, submissionId: run.submissionId, revision: value.revision, fingerprint: contentRevision(value.notes) };
        }
      },
    } : {}),
    conversationReplaced: async (source, replacement) => { await store.rebind(source, replacement); },
    permissionSchedules: async () => { ready(); return store.list().map(schedule => ({ id: schedule.id, name: schedule.name })); },
    conversationWatches: async id => {
      ready();
      return store.list().filter(schedule => schedule.goal?.conversationId === id).map(schedule => ({ id: schedule.id, name: schedule.name,
        summary: recurrenceSummary(schedule.recurrence), recurrence: { ...schedule.recurrence }, state: schedule.state, nextFireAt: schedule.nextFireAt === null ? null : isoDate(schedule.nextFireAt),
        deadline: schedule.deadline === null ? null : isoDate(schedule.deadline), createdAt: isoDate(schedule.createdAt) }));
    },
    spaceTask: call => {
      const run = runs.get(call.conversationId), schedule = run && store.get(run.id);
      if (!run?.space) return undefined;
      if (schedule?.state !== "running" || schedule.token !== run.token) throw new OxError("cancelled", "The original bound Space update is no longer active.");
      return run.space;
    },
    serviceDependencies: async domain => {
      ready();
      const schedules = store.list().filter(schedule => schedule.services.includes(domain));
      return { schedules: schedules.length, activeSchedules: schedules.filter(schedule => ["active", "running"].includes(schedule.state)).length };
    },
    routes: {
      schedules: async (request, url, parts) => {
        try {
          if (!parts.length && request.method === "GET") {
            ready();
            const schedules = store.list();
            return json(url.searchParams.get("summary") === "1" ? { total: schedules.length,
              enabled: schedules.filter(schedule => ["active", "running"].includes(schedule.state)).length,
              attention: schedules.filter(schedule => schedule.lastOutcome?.kind === "failed").length } : { schedules: schedules.map(row) });
          }
          if (!parts.length && request.method === "POST") {
            if (!personalAgentEnabled()) throw new HTTPError(404, "Owner schedule creation is not enabled on this Host.");
            ready();
            const body = await payload<Record<string, unknown>>(request);
            if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => !["name", "prompt", "recurrence", "condition", "deadline", "enabled", ...(museParityEnabled() ? ["space"] : [])].includes(key))
              || body.enabled !== undefined && typeof body.enabled !== "boolean") throw new HTTPError(400, "Send scheduled-task fields and an optional enabled choice.");
            const edit = editOf(body);
            let space: SpaceScheduleBinding | undefined;
            if (body.space !== undefined) {
              const value = body.space as Record<string, unknown>;
              if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !["id", "slot", "expectedRevision", "entrySha256"].includes(key))
                || typeof value.id !== "string" || typeof value.slot !== "string" || !Number.isSafeInteger(value.expectedRevision) || typeof value.entrySha256 !== "string") {
                throw new HTTPError(400, "Bind a scheduled update to the current original Space revision, code and data slot.");
              }
              space = await context.profile().spaceBinding(value.id, value.slot, Number(value.expectedRevision), value.entrySha256);
              await context.profile().validateSpaceBinding(space);
            }
            const created = await store.create({ ...edit, services: [], conversationId: null, ...(space ? { space } : {}) }, Date.now(),
              { key: request.headers.get("idempotency-key") ?? "", enabled: body.enabled === true });
            context.logs.info("schedules", `create id=${created.schedule.id} replayed=${created.replayed} by=web`);
            void refresh();
            return json({ schedule: row(created.schedule), replayed: created.replayed }, { status: created.replayed ? 200 : 201 });
          }
          const id = parts[0] ?? "";
          if (parts.length === 2 && parts[1] === "run" && request.method === "POST") {
            owned(id);
            await store.fireNow(id, Date.now());
            context.logs.info("schedules", `run now id=${id} by=web`);
            void refresh();
            return json({ started: true });
          }
          if (parts.length === 1 && request.method === "PUT") {
            owned(id);
            const body = await payload<{ enabled?: unknown }>(request);
            if (typeof body.enabled !== "boolean") throw new HTTPError(400, "Expected enabled: true or false");
            const updated = await store.setEnabled(id, body.enabled, Date.now());
            context.logs.info("schedules", `enable id=${id} enabled=${body.enabled} by=web`);
            void refresh();
            return json(row(updated));
          }
          if (parts.length === 1 && request.method === "PATCH") {
            owned(id);
            const updated = await store.update(id, editOf(await payload<Record<string, unknown>>(request)), Date.now());
            context.logs.info("schedules", `edit id=${id} frequency=${updated.recurrence.type} conditional=${updated.condition !== null} by=web`);
            void refresh();
            return json(row(updated));
          }
          if (parts.length === 1 && request.method === "DELETE") {
            owned(id);
            await store.delete(id);
            context.logs.info("schedules", `delete id=${id} by=web`);
            void refresh();
            return json({ deleted: true });
          }
        } catch (error) { throw routeError(error); }
        throw new HTTPError(404, "Not found");
      },
    },
    start: async () => {
      closed = false;
      try {
        await store.load();
        const recovered = await store.recover();
        if (recovered) context.logs.warning("schedules", `paused ${recovered} interrupted scheduled check(s)`);
      } catch (error) { context.logs.error("schedules", describe(error)); }
      started = true;
      void refresh();
    },
    close: async () => {
      closed = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      await chain;
      await work;
    },
    content: { busy: () => !!work || !!active, snapshot: () => store.contentSnapshot(), reset: expected => store.resetContent(expected["vm/state/schedules.json"]) },
  };
};

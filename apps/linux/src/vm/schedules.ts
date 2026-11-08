import { OxError, type LinuxProfile } from "@openox/agent/linux";
import { HTTPError, json, payload } from "../http";
import type { VMContext, VMFactory } from "./context";
import { conversationUUID } from "./conversations";
import { hostTimeZone, isoDate, nextOccurrence, parseISODate, recurrenceSummary, validRecurrence, weekdays, type Recurrence } from "./schedules-recurrence";
import { scheduleErrors, ScheduleStore, type Schedule, type ScheduleOutcome } from "./schedules-store";
import { FunctionApprovals } from "./skills-approval";

type CreateInput = {
  name: string; prompt: string; frequency: string; fireAt?: string; intervalSeconds?: number; hour?: number; minute?: number; weekday?: string; timeZone?: string;
  condition?: string; deadline?: string; conversation?: "current" | "new"; services?: string[];
};

const describe = (error: unknown) => error instanceof Error ? error.message : String(error);
const failed = (message: string): ScheduleOutcome => ({ kind: "failed", message });
const timing = (message: string) => new OxError("invalid_argument", message, "Read ox.schedule.create.help() and retry with valid timing.");
const statuses: Record<string, number> = { not_found: 404, conflict: 409, unavailable: 503, limit_exceeded: 409 };

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

const intent = (schedule: Schedule) => schedule.condition === null ? schedule.prompt : `${schedule.prompt}

This is a scheduled condition check. Stop condition: ${schedule.condition}
Check the condition now. If it is true, perform the requested final action and call ox.schedule.complete({ purpose: "Condition met" }).
If it is false, finish this check without completing the schedule; Ox will check again later. Do not sleep or poll inside this run.`;

export const schedulesModule: VMFactory = (context: VMContext) => {
  const store = new ScheduleStore(context.paths.state, () => context.emit({ type: "schedules" }));
  const approvals = FunctionApprovals.for(context.paths.state);
  const runs = new Map<number, { id: string; token: string }>();
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
  });
  const row = (schedule: Schedule) => ({ id: schedule.id, name: schedule.name, prompt: schedule.prompt, recurrence: schedule.recurrence, summary: recurrenceSummary(schedule.recurrence), state: schedule.state,
    nextFireAt: schedule.nextFireAt, lastRunAt: schedule.lastRunAt, lastOutcome: schedule.lastOutcome?.kind ?? null,
    lastError: schedule.lastOutcome?.kind === "failed" ? schedule.lastOutcome.message : null, conversationId: schedule.lastConversationId ?? schedule.conversationId });
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

  async function submit(profile: LinuxProfile, conversationId: number, schedule: Schedule): Promise<ScheduleOutcome> {
    let poll: ReturnType<typeof setInterval> | undefined;
    const run = profile.send(conversationId, intent(schedule));
    const attention = new Promise<"attention">(resolve => {
      poll = setInterval(() => {
        if (profile.pendingPrompt(conversationId)) resolve("attention");
        const state = store.get(schedule.id)?.state;
        if (state !== "running" && state !== "completed") stop(profile, conversationId);
      }, 200);
    });
    try {
      const value = await Promise.race([run, attention]);
      if (value === "attention") return failed("The schedule needs attention in Ox.");
      return value.outcome === "completed" ? { kind: "succeeded" } : value.outcome === "cancelled" ? { kind: "cancelled" } : failed(value.error || "The scheduled check failed.");
    } catch (error) { return failed(describe(error)); }
    finally { clearInterval(poll); }
  }

  async function execute(schedule: Schedule, token: string): Promise<{ outcome: ScheduleOutcome; conversationId?: number }> {
    const profile = context.profile();
    let conversationId: number | undefined;
    try {
      if (schedule.conversationId !== null) {
        if (!await profile.summary(schedule.conversationId).then(() => true, () => false)) return { outcome: failed("The schedule's conversation is unavailable.") };
        conversationId = schedule.conversationId;
        if (profile.busy(conversationId) || runs.has(conversationId)) return { outcome: failed("The schedule's conversation is busy. Resume the schedule when it is ready."), conversationId };
      } else {
        const choice = context.defaultModel();
        if (!choice) return { outcome: failed("Choose a default model in Settings so this schedule can run.") };
        conversationId = await profile.create(choice);
        await profile.rename(conversationId, schedule.name);
      }
      if (active) active.conversationId = conversationId;
      const current = store.get(schedule.id);
      if (closed || current?.state !== "running" || current.token !== token) return { outcome: { kind: "cancelled" }, conversationId };
      try { await store.bind(schedule.id, token, conversationId); } catch { return { outcome: { kind: "cancelled" }, conversationId }; }
      runs.set(conversationId, { id: schedule.id, token });
      try { return { outcome: await submit(profile, conversationId, schedule), conversationId }; }
      finally { if (runs.get(conversationId)?.token === token) runs.delete(conversationId); }
    } catch (error) { return { outcome: failed(describe(error)), conversationId }; }
  }

  async function process() {
    for (const due of store.due(Date.now())) {
      if (closed) return;
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
      if (outcome.kind === "failed") context.logs.warning("schedules", `schedule needs attention id=${due.id}: ${outcome.message}`);
    }
  }

  async function update() {
    if (!started || closed || store.failure) return;
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
        const schedule = await store.create({ name: input.name, prompt: input.prompt, services: input.services ?? [], condition, deadline,
          conversationId: input.conversation === "current" ? call.conversationId : null, recurrence }, Date.now());
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
    },
    routes: {
      schedules: async (request, _url, parts) => {
        try {
          if (!parts.length && request.method === "GET") { ready(); return json({ schedules: store.list().map(row) }); }
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
    },
  };
};

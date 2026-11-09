import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { OxError } from "@openox/agent/linux";
import { nextOccurrence, validRecurrence, type Recurrence } from "./schedules-recurrence";

export type ScheduleState = "active" | "running" | "paused" | "completed" | "expired";
export type ScheduleOutcome = { kind: "succeeded" } | { kind: "cancelled" } | { kind: "failed"; message: string };
export interface Schedule {
  id: string; name: string; prompt: string; services: string[]; condition: string | null; deadline: number | null; conversationId: number | null;
  recurrence: Recurrence; nextFireAt: number | null; state: ScheduleState; token: string | null; createdAt: number;
  lastRunAt: number | null; lastOutcome: ScheduleOutcome | null; lastConversationId: number | null;
}
export interface ScheduleDraft { name: string; prompt: string; services: string[]; condition: string | null; deadline: number | null; conversationId: number | null; recurrence: Recurrence }
export interface ScheduleEdit { name: string; prompt: string; condition: string | null; deadline: number | null; recurrence: Recurrence }

export const scheduleLimits = { count: 100, text: 10_000, outcome: 500 };
export const scheduleErrors = {
  tooMany: () => new OxError("limit_exceeded", `Ox supports up to ${scheduleLimits.count} schedules on this Host.`, "Delete a schedule the user no longer needs, with their confirmation."),
  invalidRecurrence: () => new OxError("invalid_argument", "Choose a valid schedule time and time zone.", "Use a supported frequency, hour 0-23, minute 0-59, and an IANA time zone such as Europe/Paris."),
  invalid: () => new OxError("invalid_argument", "The schedule is invalid.", "Check the name, prompt, condition, and deadline, then retry."),
  running: () => new OxError("conflict", "Pause this schedule before editing or running it again.", "Wait for the running check to finish."),
  missing: () => new OxError("not_found", "That schedule no longer exists.", "List schedules with ox.schedule.list before retrying."),
  future: () => new OxError("invalid_argument", "Choose a time in the future.", "Use a future time or deadline; ask the user before replacing an expired schedule."),
  conditional: () => new OxError("invalid_argument", "A schedule with a stop condition must repeat and have a deadline.", "Choose a repeat other than once and set a deadline."),
};
const interrupted = "The previous check was interrupted. Review its conversation before resuming.";
const enabled = (schedule: Schedule) => schedule.state === "active" || schedule.state === "running";
const text = (value: unknown, maximum: number) => typeof value === "string" && !!value.trim() && value.length <= maximum;
const instant = (value: unknown) => value === null || (typeof value === "number" && Number.isFinite(value));

function validated(schedules: Schedule[]) {
  if (schedules.length > scheduleLimits.count) throw scheduleErrors.tooMany();
  if (new Set(schedules.map(schedule => schedule.id)).size !== schedules.length) throw scheduleErrors.invalid();
  for (const schedule of schedules) {
    const outcome = schedule.lastOutcome;
    const valid = typeof schedule.id === "string" && /^[0-9A-F-]{36}$/.test(schedule.id) && text(schedule.name, 500) && text(schedule.prompt, scheduleLimits.text)
      && Array.isArray(schedule.services) && schedule.services.length <= 100 && schedule.services.every(service => typeof service === "string" && !!service && service.length <= 500)
      && (schedule.condition === null || text(schedule.condition, scheduleLimits.text)) && instant(schedule.deadline) && instant(schedule.nextFireAt) && instant(schedule.lastRunAt)
      && typeof schedule.createdAt === "number" && (schedule.conversationId === null || Number.isSafeInteger(schedule.conversationId))
      && (schedule.lastConversationId === null || Number.isSafeInteger(schedule.lastConversationId))
      && ["active", "running", "paused", "completed", "expired"].includes(schedule.state) && (schedule.state === "running") === (typeof schedule.token === "string")
      && (!enabled(schedule) || schedule.nextFireAt !== null) && (!["completed", "expired"].includes(schedule.state) || schedule.nextFireAt === null)
      && (schedule.condition === null || (schedule.recurrence?.type !== "once" && schedule.deadline !== null && schedule.deadline > schedule.createdAt))
      && (outcome === null || ["succeeded", "cancelled"].includes(outcome.kind) || (outcome.kind === "failed" && text(outcome.message, scheduleLimits.outcome)))
      && !!schedule.recurrence && validRecurrence(schedule.recurrence);
    if (!valid) throw scheduleErrors.invalid();
  }
  return schedules;
}

const bounded = (outcome: ScheduleOutcome): ScheduleOutcome => outcome.kind !== "failed" ? outcome
  : { kind: "failed", message: (outcome.message.trim() || "The scheduled check failed.").slice(0, scheduleLimits.outcome) };

export class ScheduleStore {
  private path: string;
  private schedules: Schedule[] = [];
  private tail: Promise<unknown> = Promise.resolve();
  private onChange: () => void;
  failure?: string;

  constructor(state: string, onChange: () => void) {
    this.path = join(state, "schedules.json");
    this.onChange = onChange;
  }

  async load() {
    try {
      const raw = await readFile(this.path, "utf8").catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; });
      const stored = raw === undefined ? { version: 1, schedules: [] } : JSON.parse(raw) as { version?: unknown; schedules?: unknown };
      if (stored.version !== 1 || !Array.isArray(stored.schedules)) throw new Error("unsupported storage version");
      this.schedules = validated(structuredClone(stored.schedules as Schedule[]));
      this.failure = undefined;
    } catch (error) {
      this.failure = `Schedules could not be loaded from ${this.path}: ${error instanceof Error ? error.message : String(error)}`;
      throw error;
    }
  }

  list() {
    return [...this.schedules].sort((a, b) => (a.nextFireAt ?? Infinity) - (b.nextFireAt ?? Infinity)).map(schedule => structuredClone(schedule));
  }
  get(id: string) {
    const schedule = this.schedules.find(entry => entry.id === id);
    return schedule && structuredClone(schedule);
  }
  due(now: number) {
    return this.list().filter(schedule => schedule.state === "active" && (schedule.deadline === null || schedule.deadline > now) && schedule.nextFireAt !== null && schedule.nextFireAt <= now)
      .sort((a, b) => a.nextFireAt! - b.nextFireAt!);
  }
  nextEnabledDate() {
    const dates = this.schedules.filter(enabled).flatMap(schedule => schedule.state === "running" ? [schedule.deadline]
      : [Math.min(schedule.nextFireAt ?? Infinity, schedule.deadline ?? Infinity)]).filter((value): value is number => value !== null && Number.isFinite(value));
    return dates.length ? Math.min(...dates) : undefined;
  }

  private mutate<T>(operation: (schedules: Schedule[]) => Promise<T> | T) {
    const next = this.tail.then(async () => {
      if (this.failure) throw new OxError("unavailable", this.failure, "Ask the user to repair or move the schedules file, then restart the Host.");
      return operation(structuredClone(this.schedules));
    });
    this.tail = next.catch(() => {});
    return next;
  }

  private async save(schedules: Schedule[]) {
    validated(schedules);
    await mkdir(join(this.path, ".."), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${crypto.randomUUID()}`;
    await writeFile(temporary, `${JSON.stringify({ version: 1, schedules }, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.path);
    this.schedules = schedules;
    this.onChange();
  }

  private static find(schedules: Schedule[], id: string) {
    const schedule = schedules.find(entry => entry.id === id);
    if (!schedule) throw scheduleErrors.missing();
    return schedule;
  }

  create(draft: ScheduleDraft, now: number) {
    return this.mutate(async schedules => {
      if (schedules.length >= scheduleLimits.count) throw scheduleErrors.tooMany();
      if (!validRecurrence(draft.recurrence)) throw scheduleErrors.invalidRecurrence();
      const next = nextOccurrence(draft.recurrence, now);
      if (next === undefined || (draft.deadline !== null && draft.deadline <= next)) throw scheduleErrors.future();
      const schedule: Schedule = { id: crypto.randomUUID().toUpperCase(), ...draft, name: draft.name.trim(), prompt: draft.prompt.trim(),
        nextFireAt: next, state: "active", token: null, createdAt: now, lastRunAt: null, lastOutcome: null, lastConversationId: null };
      await this.save([...schedules, schedule]);
      return structuredClone(schedule);
    });
  }

  update(id: string, edit: ScheduleEdit, now: number) {
    return this.mutate(async schedules => {
      const schedule = ScheduleStore.find(schedules, id);
      if (schedule.state === "running") throw scheduleErrors.running();
      const name = edit.name.trim(), prompt = edit.prompt.trim(), condition = edit.condition?.trim() || null;
      if (!name || name.length > 500 || !prompt || prompt.length > scheduleLimits.text || (condition !== null && condition.length > scheduleLimits.text)) throw scheduleErrors.invalid();
      if (!validRecurrence(edit.recurrence)) throw scheduleErrors.invalidRecurrence();
      if (condition !== null && (edit.recurrence.type === "once" || edit.deadline === null)) throw scheduleErrors.conditional();
      const next = nextOccurrence(edit.recurrence, now);
      if (next === undefined || (edit.deadline !== null && edit.deadline <= next)) throw scheduleErrors.future();
      Object.assign(schedule, { name, prompt, condition, deadline: edit.deadline, recurrence: edit.recurrence, nextFireAt: next,
        state: schedule.state === "paused" ? "paused" : "active", token: null });
      await this.save(schedules);
      return structuredClone(schedule);
    });
  }

  rebind(from: number, to: number) {
    return this.mutate(async schedules => {
      if (!schedules.some(schedule => schedule.conversationId === from || schedule.lastConversationId === from)) return;
      await this.save(schedules.map(schedule => ({ ...schedule, ...(schedule.conversationId === from ? { conversationId: to } : {}),
        ...(schedule.lastConversationId === from ? { lastConversationId: to } : {}) })));
    });
  }

  delete(id: string) {
    return this.mutate(async schedules => {
      ScheduleStore.find(schedules, id);
      await this.save(schedules.filter(schedule => schedule.id !== id));
    });
  }

  setEnabled(id: string, value: boolean, now: number) {
    return this.mutate(async schedules => {
      const schedule = ScheduleStore.find(schedules, id);
      if (value && schedule.state === "running") return structuredClone(schedule);
      if (value) {
        if (schedule.deadline !== null && schedule.deadline <= now) throw scheduleErrors.future();
        const next = nextOccurrence(schedule.recurrence, now);
        if (next === undefined) throw scheduleErrors.future();
        schedule.nextFireAt = next;
      }
      schedule.state = value ? "active" : "paused";
      schedule.token = null;
      await this.save(schedules);
      return structuredClone(schedule);
    });
  }

  fireNow(id: string, now: number) {
    return this.mutate(async schedules => {
      const schedule = ScheduleStore.find(schedules, id);
      if (schedule.state === "running") throw scheduleErrors.running();
      if (schedule.deadline !== null && schedule.deadline <= now) throw scheduleErrors.future();
      schedule.nextFireAt = now;
      schedule.state = "active";
      await this.save(schedules);
    });
  }

  claim(id: string, now: number) {
    return this.mutate(async schedules => {
      const schedule = ScheduleStore.find(schedules, id);
      if (schedule.state !== "active" || (schedule.deadline !== null && schedule.deadline <= now)) throw scheduleErrors.missing();
      const token = crypto.randomUUID();
      Object.assign(schedule, { state: "running", token, lastConversationId: null });
      await this.save(schedules);
      return token;
    });
  }

  bind(id: string, token: string, conversationId: number) {
    return this.mutate(async schedules => {
      const schedule = ScheduleStore.find(schedules, id);
      if (schedule.state !== "running" || schedule.token !== token) throw scheduleErrors.invalid();
      schedule.lastConversationId = conversationId;
      await this.save(schedules);
    });
  }

  complete(id: string, token: string, now: number) {
    return this.mutate(async schedules => {
      const schedule = schedules.find(entry => entry.id === id);
      if (!schedule || schedule.state !== "running" || schedule.token !== token || schedule.condition === null || (schedule.deadline !== null && schedule.deadline <= now)) throw scheduleErrors.invalid();
      Object.assign(schedule, { state: "completed", token: null, nextFireAt: null });
      await this.save(schedules);
    });
  }

  record(id: string, token: string, outcome: ScheduleOutcome, conversationId: number | null, at: number) {
    return this.mutate(async schedules => {
      const schedule = schedules.find(entry => entry.id === id);
      if (!schedule) return;
      Object.assign(schedule, { lastRunAt: at, lastOutcome: bounded(outcome), lastConversationId: conversationId });
      if (schedule.state === "running" && schedule.token === token) {
        schedule.nextFireAt = schedule.recurrence.type === "once" ? null : nextOccurrence(schedule.recurrence, at) ?? null;
        schedule.state = outcome.kind !== "succeeded" ? "paused" : schedule.nextFireAt === null ? "completed" : "active";
        schedule.token = null;
      }
      if (schedule.deadline !== null && schedule.deadline <= at && schedule.state !== "completed") Object.assign(schedule, { state: "expired", token: null, nextFireAt: null });
      await this.save(schedules);
    });
  }

  expire(now: number) {
    return this.mutate(async schedules => {
      let changed = false;
      for (const schedule of schedules) {
        if (!enabled(schedule) || schedule.deadline === null || schedule.deadline > now) continue;
        Object.assign(schedule, { state: "expired", token: null, nextFireAt: null });
        changed = true;
      }
      if (changed) await this.save(schedules);
    });
  }

  recover() {
    return this.mutate(async schedules => {
      const running = schedules.filter(schedule => schedule.state === "running");
      for (const schedule of running) Object.assign(schedule, { state: "paused", token: null, lastOutcome: { kind: "failed", message: interrupted } });
      if (running.length) await this.save(schedules);
      return running.length;
    });
  }
}

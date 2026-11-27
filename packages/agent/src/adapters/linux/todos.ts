import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc, type Harness, type Tx } from "@earendil-works/pi-durable";
import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { OxError } from "./functions";
import { cancelNotice, enqueueNotice, InboxState, type InboxDraft } from "./inbox";
import { todoDraftSchema, todoPatchSchema, todoSchema, type Todo } from "./todo-contracts";

const recordSchema = Type.Object({
  todo: todoSchema, reminderId: Type.Union([Type.String({ format: "uuid" }), Type.Null()]),
}, { additionalProperties: false });
const stateSchema = Type.Object({
  records: Type.Record(Type.String(), recordSchema),
  requests: Type.Record(Type.String(), Type.Object({ fingerprint: Type.String(), id: Type.String({ format: "uuid" }) }, { additionalProperties: false })),
}, { additionalProperties: false });
type State = Static<typeof stateSchema>;
const initial = (): State => ({ records: {}, requests: {} });
const Todos = defineDoc<State>({
  kind: "ox.todos", version: 1, scope: "session", initial,
  checkpointWhen: (_, __, info) => info.deltasSinceBase >= 31,
});
const context = BACKGROUND_CONTEXT;
const hash = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex");
const invalid = (message: string) => new OxError("invalid_argument", message, "Use a nonempty title and, for a reminder, an offset-bearing timestamp with its explicit IANA time zone.");
const conflict = () => new OxError("conflict", "This Todo changed. Read the latest version before saving again.", "List Todos and use the current revision; do not blindly repeat this write.");

export function todoInput<T extends TSchema>(schema: T, value: unknown): Static<T> {
  if (!Value.Check(schema, value)) throw invalid([...Value.Errors(schema, value)].slice(0, 3).map(error => `${error.instancePath || "/"} ${error.message}`).join("; "));
  return value;
}

function validate(state: State) {
  if (!Value.Check(stateSchema, state) || Object.entries(state.records).some(([id, record]) => id !== record.todo.id)) {
    throw new OxError("unavailable", "The Todo store is invalid. No empty replacement was created.", "Restore or repair this Profile before changing Todos.");
  }
  return state;
}

export async function requireTodoLinks(tx: Tx, ids: readonly string[]) {
  if (!ids.length) return;
  const state = validate(await tx.doc(Todos));
  if (ids.some(id => !Object.hasOwn(state.records, id))) throw new OxError("invalid_argument", "A linked Todo is unavailable in the current Profile.");
}
export async function discoveryTodos(tx: Tx) { return validate(await tx.doc(Todos)).records; }

function timing(dueAt: string | null, timeZone: string | null) {
  if (dueAt === null) {
    if (timeZone !== null) throw invalid("A time zone requires an explicit reminder time.");
    return { dueAt: null, timeZone: null };
  }
  if (!timeZone) throw invalid("Choose the IANA time zone for this reminder.");
  try { new Intl.DateTimeFormat("en", { timeZone }).format(0); }
  catch { throw invalid("Choose a valid IANA time zone."); }
  return { dueAt: new Date(dueAt).toISOString(), timeZone };
}

export class TodoStore {
  private readonly harness: Harness;
  constructor(harness: Harness) { this.harness = harness; }
  async contentEmpty() {
    const state = validate(await this.harness.snapshot(Todos, context) ?? initial());
    return !Object.keys(state.records).length && !Object.keys(state.requests).length;
  }

  async list() {
    const state = validate(await this.harness.snapshot(Todos, context) ?? initial());
    return Object.values(state.records).map(record => record.todo).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  async get(id: string) {
    const state = validate(await this.harness.snapshot(Todos, context) ?? initial());
    return this.owned(state, id).todo;
  }

  private owned(state: State, id: string) {
    if (!Object.hasOwn(state.records, id)) throw new OxError("not_found", "This Todo is unavailable in the current Profile.", "List Todos before choosing one.");
    return state.records[id]!;
  }

  async create(value: unknown, key: string, origin?: { conversationId: number }) {
    if (!/^[A-Za-z0-9._:-]{1,160}$/.test(key)) throw invalid("Provide a stable Idempotency-Key of 1-160 ASCII letters, numbers, dots, colons, underscores or hyphens.");
    const input = todoInput(todoDraftSchema, value);
    const title = input.title.trim();
    if (!title) throw invalid("Enter a Todo title.");
    if (origin && (!Number.isSafeInteger(origin.conversationId) || origin.conversationId < 0)) throw invalid("Choose an original source conversation.");
    if (input.plannedFor && (input.dueAt || !Number.isFinite(Date.parse(`${input.plannedFor.date}T00:00:00Z`))
      || new Date(`${input.plannedFor.date}T00:00:00Z`).toISOString().slice(0, 10) !== input.plannedFor.date)) throw invalid("A date-only plan cannot also have a reminder instant.");
    if (input.plannedFor) timing(`${input.plannedFor.date}T00:00:00Z`, input.plannedFor.timeZone);
    const draft = { title, notes: input.notes ?? "", ...timing(input.dueAt ?? null, input.timeZone ?? null),
      ...(input.plannedFor !== undefined ? { plannedFor: input.plannedFor } : {}), ...(origin ? { conversationId: origin.conversationId } : {}) };
    const request = hash(key), fingerprint = hash(JSON.stringify(draft));
    return this.harness.commit(async tx => {
      const state = validate(await tx.doc(Todos));
      const previous = state.requests[request];
      if (previous) {
        if (previous.fingerprint !== fingerprint || !Object.hasOwn(state.records, previous.id)) throw new OxError("conflict", "This request key belongs to a different or deleted Todo.", "Inspect the current Todos; use a new key only for a genuinely new creation.");
        return { todo: Value.Clone(state.records[previous.id]!.todo), replayed: true };
      }
      if (Object.keys(state.records).length >= 500 || Object.keys(state.requests).length >= 5_000) throw new OxError("limit_exceeded", "This preview's Todo or creation-receipt limit was reached.", "Keep the Profile intact and review retention before creating more Todos.");
      const id = crypto.randomUUID(), now = new Date().toISOString();
      const todo: Todo = { id, ...draft, completed: false, revision: 1, reminder: draft.dueAt === null ? null : "pending", reminderQueuedAt: null, createdAt: now, updatedAt: now };
      state.records[id] = { todo, reminderId: todo.reminder ? crypto.randomUUID() : null };
      state.requests[request] = { fingerprint, id };
      return { todo: Value.Clone(todo), replayed: false };
    }, context);
  }

  async update(id: string, value: unknown) {
    const patch = todoInput(todoPatchSchema, value);
    return this.harness.commit(async tx => {
      const state = validate(await tx.doc(Todos));
      const record = this.owned(state, id), todo = record.todo;
      if (todo.revision !== patch.expectedRevision || todo.revision >= Number.MAX_SAFE_INTEGER) throw conflict();
      const title = (patch.title ?? todo.title).trim();
      if (!title) throw invalid("Enter a Todo title.");
      const next = { title, notes: patch.notes ?? todo.notes, completed: patch.completed ?? todo.completed,
        ...timing(patch.dueAt === undefined ? todo.dueAt : patch.dueAt, patch.timeZone === undefined ? todo.timeZone : patch.timeZone) };
      const plannedFor = patch.plannedFor === undefined ? todo.plannedFor : patch.plannedFor;
      if (plannedFor) timing(`${plannedFor.date}T00:00:00Z`, plannedFor.timeZone);
      const rescheduled = next.dueAt !== todo.dueAt || next.timeZone !== todo.timeZone;
      const now = new Date().toISOString();
      if (next.completed || rescheduled) {
        cancelNotice(await tx.doc(InboxState), record.reminderId, now);
        record.reminderId = !next.completed && next.dueAt !== null ? crypto.randomUUID() : null;
        todo.reminder = record.reminderId === null ? null : "pending";
        todo.reminderQueuedAt = null;
      }
      Object.assign(todo, next, { ...(plannedFor === undefined ? {} : { plannedFor: next.dueAt === null ? plannedFor : null }),
        revision: todo.revision + 1, updatedAt: now });
      return Value.Clone(todo);
    }, context);
  }

  async delete(id: string, expectedRevision: number) {
    await this.harness.commit(async tx => {
      const state = validate(await tx.doc(Todos)), record = this.owned(state, id);
      if (record.todo.revision !== expectedRevision) throw conflict();
      cancelNotice(await tx.doc(InboxState), record.reminderId, new Date().toISOString());
      delete state.records[id];
    }, context);
    return { deleted: true as const };
  }

  async queueDue(make: (todo: Todo, noticeId: string) => InboxDraft) {
    const now = new Date().toISOString();
    return this.harness.commit(async tx => {
      const state = validate(await tx.doc(Todos));
      const due = Object.values(state.records).filter(record => !record.todo.completed && record.todo.reminder === "pending" && record.todo.dueAt !== null && record.todo.dueAt <= now);
      if (!due.length) return [];
      const inbox = await tx.doc(InboxState);
      return due.map(record => {
        if (!record.reminderId || record.todo.revision >= Number.MAX_SAFE_INTEGER) throw new OxError("unavailable", "A Todo reminder has invalid identity or revision.");
        const notice = enqueueNotice(inbox, make(record.todo, record.reminderId), now);
        record.todo.reminder = "queued";
        record.todo.reminderQueuedAt = now;
        record.todo.updatedAt = now;
        record.todo.revision++;
        return { todo: Value.Clone(record.todo), notice: Value.Clone(notice) };
      });
    }, context);
  }
}

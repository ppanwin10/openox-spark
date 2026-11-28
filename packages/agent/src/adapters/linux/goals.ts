import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc, type Harness, type Tx } from "@earendil-works/pi-durable";
import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { OxError } from "./functions";
import { goalDraftSchema, goalPatchSchema, goalSchema, type Goal } from "./goal-contracts";
import { requireTodoLinks } from "./todos";
import { discoveryChatVisible, discoverySignals, signalHash } from "./discovery-signals";

const stateSchema = Type.Object({
  records: Type.Record(Type.String(), goalSchema),
  requests: Type.Record(Type.String(), Type.Object({ fingerprint: Type.String(), id: Type.String({ format: "uuid" }) }, { additionalProperties: false })),
}, { additionalProperties: false });
type State = Static<typeof stateSchema>;
const initial = (): State => ({ records: {}, requests: {} });
const Goals = defineDoc<State>({
  kind: "ox.goals", version: 1, scope: "session", initial,
  checkpointWhen: (_, __, info) => info.deltasSinceBase >= 31,
});
const context = BACKGROUND_CONTEXT;
const hash = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex");
const invalid = (message: string) => new OxError("invalid_argument", message, "Provide a nonempty goal title and explicit outcome criteria, with only declared fields.");
export function goalInput<T extends TSchema>(schema: T, value: unknown): Static<T> {
  if (!Value.Check(schema, value)) throw invalid([...Value.Errors(schema, value)].slice(0, 3).map(error => `${error.instancePath || "/"} ${error.message}`).join("; "));
  return value;
}
function validate(state: State) {
  if (!Value.Check(stateSchema, state) || Object.entries(state.records).some(([id, goal]) => id !== goal.id || goal.completed !== (goal.completedAt !== null))) {
    throw new OxError("unavailable", "The Goal store is invalid. No empty replacement was created.", "Restore or repair this Profile before changing goals.");
  }
  return state;
}
function owned(state: State, id: string) {
  if (!Object.hasOwn(state.records, id)) throw new OxError("not_found", "This goal is unavailable in the current Profile.");
  return state.records[id]!;
}
function current(goal: Goal, revision: number) {
  if (goal.revision !== revision || goal.revision >= Number.MAX_SAFE_INTEGER) {
    throw new OxError("conflict", "This goal changed. Read the latest version before saving again.", "Use the current expectedRevision; do not blindly repeat the write.");
  }
}
export async function discoveryGoals(tx: Tx) { return Object.values(validate(await tx.doc(Goals)).records); }
export class GoalStore {
  private readonly harness: Harness;
  constructor(harness: Harness) { this.harness = harness; }
  async contentEmpty() {
    const state = validate(await this.harness.snapshot(Goals, context) ?? initial());
    return !Object.keys(state.records).length && !Object.keys(state.requests).length;
  }
  async list() {
    const state = validate(await this.harness.snapshot(Goals, context) ?? initial());
    return Object.values(state.records).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
  }
  async get(id: string) { return owned(validate(await this.harness.snapshot(Goals, context) ?? initial()), id); }
  async create(value: unknown, key: string, suggestion?: { conversation: number; text: string }) {
    if (!/^[A-Za-z0-9._:-]{1,160}$/.test(key)) throw invalid("Provide a stable Idempotency-Key of 1-160 ASCII letters, numbers, dots, colons, underscores or hyphens.");
    const input = goalInput(goalDraftSchema, value), title = input.title.trim(), outcome = input.outcome.trim();
    if (!title || !outcome) throw invalid("Enter a goal title and explicit outcome criteria.");
    const draft = { title, outcome, notes: input.notes ?? "", category: input.category ?? null, todoIds: input.todoIds ?? [] };
    const step = suggestion?.text.trim();
    if (suggestion && (!step || step.length > 500)) throw invalid("A suggested step must contain 1–500 characters.");
    const request = hash(key), fingerprint = hash(JSON.stringify(suggestion ? { ...draft, suggestedStep: step, conversation: suggestion.conversation } : draft));
    return this.harness.commit(async tx => {
      if (suggestion && !await discoveryChatVisible(tx, suggestion.conversation, true))
        throw new OxError("permission_denied", "The original regular conversation is unavailable or chat-only.");
      const state = validate(await tx.doc(Goals)), previous = state.requests[request];
      if (previous) {
        if (previous.fingerprint !== fingerprint || !Object.hasOwn(state.records, previous.id)) {
          throw new OxError("conflict", "This request key belongs to a different or deleted goal.", "Inspect current goals; use a new key only for a genuinely new creation.");
        }
        return { goal: Value.Clone(state.records[previous.id]!), replayed: true };
      }
      if (Object.keys(state.records).length >= 500 || Object.keys(state.requests).length >= 5_000) {
        throw new OxError("limit_exceeded", "This preview's goal or creation-receipt limit was reached.", "Keep the Profile intact and review retention before creating more goals.");
      }
      await requireTodoLinks(tx, draft.todoIds);
      const id = crypto.randomUUID(), now = new Date().toISOString();
      const goal: Goal = { id, ...draft, completed: false, completedAt: null, revision: 1, createdAt: now, updatedAt: now };
      state.records[id] = goal; state.requests[request] = { fingerprint, id };
      if (suggestion && step) (await discoverySignals(tx)).goals[id] = { conversation: suggestion.conversation, outcomeHash: signalHash(JSON.stringify([title, outcome])), step };
      return { goal: Value.Clone(goal), replayed: false };
    }, context);
  }
  async update(id: string, value: unknown) {
    const patch = goalInput(goalPatchSchema, value);
    return this.harness.commit(async tx => {
      const state = validate(await tx.doc(Goals)), goal = owned(state, id);
      current(goal, patch.expectedRevision);
      if (patch.todoIds !== undefined) await requireTodoLinks(tx, patch.todoIds);
      const title = (patch.title ?? goal.title).trim(), outcome = (patch.outcome ?? goal.outcome).trim();
      if (!title || !outcome) throw invalid("Enter a goal title and explicit outcome criteria.");
      const completed = patch.completed ?? goal.completed, now = new Date().toISOString();
      const status = patch.status?.replace(/\s+/g, " ").trim();
      const notes = patch.notes ?? (status ? [...goal.notes.split("\n"), status].filter(line => line.trim()).join("\n").slice(-8_000).replace(/^[^\n]*\n(?=[\s\S]{7000})/, "") : goal.notes);
      Object.assign(goal, { title, outcome, notes, todoIds: patch.todoIds ?? goal.todoIds,
        category: patch.category === undefined ? goal.category : patch.category, completed,
        completedAt: completed ? goal.completedAt ?? now : null, revision: goal.revision + 1, updatedAt: now });
      return Value.Clone(goal);
    }, context);
  }
  async delete(id: string, revision: number) {
    await this.harness.commit(async tx => {
      const state = validate(await tx.doc(Goals));
      current(owned(state, id), revision); delete state.records[id];
      delete (await discoverySignals(tx)).goals[id];
    }, context);
    return { deleted: true as const };
  }
}

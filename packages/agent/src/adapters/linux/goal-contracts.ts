import { Type, type Static } from "typebox";
import type { ModelChoice } from "./profile";

const strict = { additionalProperties: false };
const identity = Type.String({ format: "uuid" });
const instant = Type.String({ format: "date-time" });
const revision = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const purpose = Type.String({ minLength: 1, maxLength: 240 });
const fields = {
  title: Type.String({ minLength: 1, maxLength: 200 }),
  outcome: Type.String({ minLength: 1, maxLength: 2_000 }),
  notes: Type.String({ maxLength: 8_000 }),
  category: Type.Union([Type.Literal("health"), Type.Null()]),
  todoIds: Type.Array(identity, { maxItems: 50, uniqueItems: true }),
};
export const goalDraftSchema = Type.Object({
  title: fields.title, outcome: fields.outcome, notes: Type.Optional(fields.notes),
  category: Type.Optional(fields.category), todoIds: Type.Optional(fields.todoIds),
}, strict);
export const goalAgentPatchSchema = Type.Object({
  title: Type.Optional(fields.title), outcome: Type.Optional(fields.outcome), notes: Type.Optional(fields.notes),
  category: Type.Optional(fields.category), todoIds: Type.Optional(fields.todoIds), expectedRevision: revision,
}, strict);
export const goalPatchSchema = Type.Object({ ...goalAgentPatchSchema.properties, completed: Type.Optional(Type.Boolean()) }, strict);
export const goalRevisionSchema = Type.Object({ expectedRevision: revision }, strict);
export const goalSchema = Type.Object({
  id: identity, ...fields, completed: Type.Boolean(), completedAt: Type.Union([instant, Type.Null()]),
  revision, createdAt: instant, updatedAt: instant,
}, strict);
export type Goal = Static<typeof goalSchema>;
export const goalTaskLimits = { requests: 12, operations: 32, sources: 8, milliseconds: 120_000 };
export interface GoalTaskBinding { id: string; conversationId: number; model: ModelChoice; timeZone: string }
export const goalTaskSchema = Type.Object({
  id: identity, conversationId: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  model: Type.Object({ provider: Type.String({ minLength: 1, maxLength: 500 }), modelId: Type.String({ minLength: 1, maxLength: 500 }),
    thinkingLevel: Type.Optional(Type.Union(["off", "minimal", "low", "medium", "high", "xhigh", "max"].map(value => Type.Literal(value)))) }, strict),
  timeZone: Type.String({ minLength: 1, maxLength: 100 }),
}, strict);
const source = Type.Object({ url: Type.String({ minLength: 1, maxLength: 2_048 }), sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }) }, strict);
const checked = { goalRevision: revision, sources: Type.Array(source, { minItems: 1, maxItems: goalTaskLimits.sources }), at: instant };
export const goalReportSchema = Type.Union([
  Type.Object({ outcome: Type.Literal("no_change"), ...checked }, strict),
  Type.Object({ outcome: Type.Literal("updated"), ...checked, commit: Type.Object({
    requestId: Type.String({ minLength: 1, maxLength: 160 }), submissionId: identity,
    revision, fingerprint: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  }, strict) }, strict),
]);
export type GoalRunReport = Static<typeof goalReportSchema>;
export const goalReportContract = {
  description: "Report the original active Goal research check as updated or no_change. Only successful original public reads can prove a check; updated also requires this submission's real target-Goal notes commit and new source content or an owner-changed Goal. No-change sends no progress notification. This cannot report another run, create work or complete a Goal. The Host, not model prose, validates and finalizes the outcome.",
  inputSchema: Type.Object({ purpose, outcome: Type.Union([Type.Literal("updated"), Type.Literal("no_change")]) }, strict),
  outputSchema: Type.Object({ id: identity, goalId: identity, report: goalReportSchema }, strict),
};
export const goalContracts = {
  "ox.goal.list": {
    description: "List this Profile's durable goals, outcomes, progress notes and linked Todo IDs after approval. Tracking means an open outcome, not a running model or scheduled work. Read linked Todos for their actual progress; task completion never completes the goal.",
    inputSchema: Type.Object({ purpose }, strict),
    outputSchema: Type.Object({ goals: Type.Array(goalSchema, { maxItems: 500 }) }, strict),
  },
  "ox.goal.create": {
    description: "Create an outcome goal with explicit completion criteria after approval in a regular conversation. Saves the same object shown in Goals, without starting models, reminders or jobs. Existing Todo IDs may be linked but are not copied. The owner marks completion; never claim creation is execution or achievement.",
    inputSchema: Type.Object({ purpose, ...goalDraftSchema.properties, suggestedStep: Type.Optional(Type.String({ minLength: 1, maxLength: 500,
      description: "Only when quiet discovery is enabled: a concrete optional next step for the private Ideas page in the user's language. Do not start the action." })) }, strict),
    outputSchema: Type.Object({ goal: goalSchema, replayed: Type.Boolean() }, strict),
  },
  "ox.goal.update": {
    description: "Update a goal's criteria, progress notes or linked Todo IDs after approval using the current expectedRevision. Notes must reflect evidence, not assumed achievement. This tool cannot set completed; ask the owner to mark completion in Goals. Existing jobs and tasks are unaffected. Read fresh state after a conflict; do not blindly repeat.",
    inputSchema: Type.Object({ purpose, id: identity, ...goalAgentPatchSchema.properties }, strict),
    outputSchema: goalSchema,
  },
  "ox.goal.delete": {
    description: "Delete a goal after approval using its current expectedRevision. This does not delete or stop linked Todos, reminders, schedules, notices or history. Creation receipts remain, so deleted requests do not resurrect goals.",
    inputSchema: Type.Object({ purpose, id: identity, expectedRevision: revision }, strict),
    outputSchema: Type.Object({ deleted: Type.Literal(true) }, strict),
  },
};

import { Type, type Static } from "typebox";

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
export const goalContracts = {
  "ox.goal.list": {
    description: "List this Profile's durable goals, outcomes, progress notes and linked Todo IDs after approval. Tracking means an open outcome, not a running model or scheduled work. Read linked Todos for their actual progress; task completion never completes the goal.",
    inputSchema: Type.Object({ purpose }, strict),
    outputSchema: Type.Object({ goals: Type.Array(goalSchema, { maxItems: 500 }) }, strict),
  },
  "ox.goal.create": {
    description: "Create an outcome goal with explicit completion criteria after approval in a regular conversation. Saves the same object shown in Goals, without starting models, reminders or jobs. Existing Todo IDs may be linked but are not copied. The owner marks completion; never claim creation is execution or achievement.",
    inputSchema: Type.Object({ purpose, ...goalDraftSchema.properties }, strict),
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

import { Type, type Static } from "typebox";

const text = Type.String({ minLength: 1, maxLength: 240 });
const notes = Type.String({ maxLength: 10_000 });
const timestamp = Type.Union([Type.String({ format: "date-time" }), Type.Null()]);
const zone = Type.Union([Type.String({ minLength: 1, maxLength: 100 }), Type.Null()]);
const revision = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const identity = Type.String({ format: "uuid" });
const purpose = Type.String({ minLength: 1, maxLength: 240 });
const fields = { title: Type.Optional(text), notes: Type.Optional(notes), dueAt: Type.Optional(timestamp), timeZone: Type.Optional(zone) };
const strict = { additionalProperties: false };

export const todoDraftSchema = Type.Object({ ...fields, title: text }, strict);
export const todoPatchSchema = Type.Object({ ...fields, completed: Type.Optional(Type.Boolean()), expectedRevision: revision }, strict);
export const todoDeleteSchema = Type.Object({ expectedRevision: revision }, strict);
export const todoSchema = Type.Object({
  id: identity, title: text, notes, completed: Type.Boolean(), dueAt: timestamp, timeZone: zone, revision,
  reminder: Type.Union([Type.Literal("pending"), Type.Literal("queued"), Type.Null()]),
  reminderQueuedAt: timestamp, createdAt: Type.String({ format: "date-time" }), updatedAt: Type.String({ format: "date-time" }),
}, strict);
export type Todo = Static<typeof todoSchema>;
export type TodoDraft = Static<typeof todoDraftSchema>;
export type TodoPatch = Static<typeof todoPatchSchema>;

export const todoContracts = {
  "ox.todo.create": {
    description: "Save a Todo in this Profile after approval. An explicit dueAt timestamp with an offset and IANA timeZone arms one model-free reminder; omit both for no reminder. Only a returned durable receipt proves creation. After an interrupted call, list Todos before deciding whether another create is needed.",
    inputSchema: Type.Object({ purpose, ...fields, title: text }, strict),
    outputSchema: Type.Object({ todo: todoSchema, replayed: Type.Boolean() }, strict),
  },
  "ox.todo.list": {
    description: "List this Profile's saved Todos and current revisions. A queued reminder means a durable notification handoff, not device delivery or reading.",
    inputSchema: Type.Object({ purpose }, strict),
    outputSchema: Type.Object({ todos: Type.Array(todoSchema) }, strict),
  },
  "ox.todo.update": {
    description: "Update a Todo after approval using its current expectedRevision. Completion cancels an unclaimed reminder. Reopening does not rearm the old reminder; choose a different explicit dueAt to schedule another. A conflict requires reading the latest Todo, not blindly repeating the write.",
    inputSchema: Type.Object({ purpose, id: identity, ...todoPatchSchema.properties }, strict),
    outputSchema: todoSchema,
  },
  "ox.todo.delete": {
    description: "Delete a Todo after explicit approval using its current expectedRevision. Cancel its unclaimed reminder without approving other actions or marking notifications read.",
    inputSchema: Type.Object({ purpose, id: identity, expectedRevision: revision }, strict),
    outputSchema: Type.Object({ deleted: Type.Literal(true) }, strict),
  },
};

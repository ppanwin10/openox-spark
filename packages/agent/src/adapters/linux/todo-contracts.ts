import { Type, type Static } from "typebox";

const text = Type.String({ minLength: 1, maxLength: 240 });
const notes = Type.String({ maxLength: 10_000 });
const timestamp = Type.Union([Type.String({ format: "date-time" }), Type.Null()]);
const zone = Type.Union([Type.String({ minLength: 1, maxLength: 100 }), Type.Null()]);
const revision = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const identity = Type.String({ format: "uuid" });
const purpose = Type.String({ minLength: 1, maxLength: 240 });
const strict = { additionalProperties: false };
const plannedFor = Type.Union([Type.Object({ date: Type.String({ format: "date" }), timeZone: Type.String({ minLength: 1, maxLength: 100 }) }, strict), Type.Null()]);
const fields = { title: Type.Optional(text), notes: Type.Optional(notes), dueAt: Type.Optional(timestamp), timeZone: Type.Optional(zone),
  plannedFor: Type.Optional(plannedFor) };
const nativeTiming = { localDueAt: Type.Optional(Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}$" })),
  dueDate: Type.Optional(Type.String({ format: "date" })) };
const preferences = Type.Object({ defaultReminderTime: Type.Union([Type.String({ pattern: "^(?:[01]\\d|2[0-3]):[0-5]\\d$" }), Type.Null()]) }, strict);

export const todoDraftSchema = Type.Object({ ...fields, title: text }, strict);
export const todoPatchSchema = Type.Object({ ...fields, completed: Type.Optional(Type.Boolean()), expectedRevision: revision }, strict);
export const todoDeleteSchema = Type.Object({ expectedRevision: revision }, strict);
export const todoSchema = Type.Object({
  id: identity, title: text, notes, completed: Type.Boolean(), dueAt: timestamp, timeZone: zone, revision,
  reminder: Type.Union([Type.Literal("pending"), Type.Literal("queued"), Type.Null()]),
  reminderQueuedAt: timestamp, createdAt: Type.String({ format: "date-time" }), updatedAt: Type.String({ format: "date-time" }),
  plannedFor: Type.Optional(plannedFor), conversationId: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
}, strict);
export type Todo = Static<typeof todoSchema>;
export type TodoDraft = Static<typeof todoDraftSchema>;
export type TodoPatch = Static<typeof todoPatchSchema>;

export const todoContracts = {
  "ox.todo.create": {
    description: "Save a Todo in this Profile after approval. An explicit dueAt timestamp with an offset and IANA timeZone arms one model-free reminder; omit both for no reminder. With conversational planning enabled, prefer localDueAt (YYYY-MM-DDTHH:mm) plus the user's IANA timeZone; the Host resolves the instant and refuses DST gaps/folds. For a known day without a time, use dueDate plus timeZone: a configured default arms the reminder, otherwise plannedFor retains the date with no reminder, so ask one concise time question. Never guess a time or silently use the Host's zone. Only a returned durable receipt proves creation. After an interrupted call, list Todos before deciding whether another create is needed.",
    inputSchema: Type.Object({ purpose, ...fields, ...nativeTiming, title: text }, strict),
    outputSchema: Type.Object({ todo: todoSchema, replayed: Type.Boolean() }, strict),
  },
  "ox.todo.list": {
    description: "List this Profile's saved Todos and current revisions. A queued reminder means a durable notification handoff, not device delivery or reading.",
    inputSchema: Type.Object({ purpose }, strict),
    outputSchema: Type.Object({ todos: Type.Array(todoSchema) }, strict),
  },
  "ox.todo.update": {
    description: "Update a Todo after approval using its current expectedRevision. Completion cancels an unclaimed reminder. Reopening does not rearm the old reminder; choose a different explicit dueAt to schedule another. A conflict requires reading the latest Todo, not blindly repeating the write.",
    inputSchema: Type.Object({ purpose, id: identity, ...todoPatchSchema.properties, ...nativeTiming }, strict),
    outputSchema: todoSchema,
  },
  "ox.todo.delete": {
    description: "Delete a Todo after explicit approval using its current expectedRevision. Cancel its unclaimed reminder without approving other actions or marking notifications read.",
    inputSchema: Type.Object({ purpose, id: identity, expectedRevision: revision }, strict),
    outputSchema: Type.Object({ deleted: Type.Literal(true) }, strict),
  },
  "ox.todo.preferences": {
    description: "Read this Workspace's configured default reminder time, or set/clear it only when the user explicitly asks for a permanent default, after separate approval. An occurrence-specific answer never changes this preference. Requires conversational planning on this Host; time is HH:mm in the user's explicitly selected local zone for each reminder.",
    inputSchema: Type.Object({ purpose, defaultReminderTime: Type.Optional(preferences.properties.defaultReminderTime) }, strict),
    outputSchema: preferences,
  },
};

import { Type, type Static } from "typebox";

const strict = { additionalProperties: false };
const instant = Type.String({ format: "date-time" });
const nullableInstant = Type.Union([instant, Type.Null()]);
const revision = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const identity = Type.String({ format: "uuid" });
const purpose = Type.String({ minLength: 1, maxLength: 240 });
const fields = {
  name: Type.String({ minLength: 1, maxLength: 240 }),
  url: Type.String({ minLength: 1, maxLength: 2_048 }),
  selector: Type.Union([Type.String({ maxLength: 2_000 }), Type.Null()]),
  intervalMinutes: Type.Integer({ minimum: 5, maximum: 1_440 }),
  enabled: Type.Boolean(),
};
export const watchDraftSchema = Type.Object({
  ...fields, selector: Type.Optional(fields.selector), enabled: Type.Optional(fields.enabled),
}, strict);
export const watchPatchSchema = Type.Object({
  name: Type.Optional(fields.name), url: Type.Optional(fields.url), selector: Type.Optional(fields.selector),
  intervalMinutes: Type.Optional(fields.intervalMinutes), enabled: Type.Optional(fields.enabled), expectedRevision: revision,
}, strict);
export const watchRevisionSchema = Type.Object({ expectedRevision: revision }, strict);
export const watchSchema = Type.Object({
  id: identity, ...fields, revision, createdAt: instant, updatedAt: instant,
  fingerprint: Type.Union([Type.String({ pattern: "^[0-9a-f]{64}$" }), Type.Null()]),
  characters: Type.Union([Type.Integer({ minimum: 1, maximum: 120_000 }), Type.Null()]),
  sourceTitle: Type.Union([Type.String({ maxLength: 240 }), Type.Null()]),
  resolvedUrl: Type.Union([fields.url, Type.Null()]),
  lastOutcome: Type.Union([Type.Literal("never"), Type.Literal("baseline"), Type.Literal("unchanged"),
    Type.Literal("changed"), Type.Literal("failed"), Type.Literal("interrupted")]),
  lastCheckedAt: nullableInstant, lastSuccessAt: nullableInstant, lastChangedAt: nullableInstant,
  lastError: Type.Union([Type.String({ maxLength: 2_000 }), Type.Null()]), nextCheckAt: nullableInstant,
}, strict);
const view = Type.Object({ ...watchSchema.properties, checking: Type.Boolean() }, strict);
export type WatchView = Static<typeof view>;

export const watchContracts = {
  "ox.watch.list": {
    description: "List this workspace's public-page watches after approval, with current revisions, actual last-check outcomes and scheduler warnings. Returns metadata, not page bodies. A saved or enabled watch is not proof of a successful check, notification delivery or event understanding.",
    inputSchema: Type.Object({ purpose }, strict),
    outputSchema: Type.Object({ watches: Type.Array(view, { maxItems: 20 }), running: Type.Integer({ minimum: 0, maximum: 1 }),
      warning: Type.Union([Type.String(), Type.Null()]) }, strict),
  },
  "ox.watch.create": {
    description: "Create a public-page static-text watch after approval in a regular conversation, using the same records as Activity. Starts paused unless enabled:true is explicitly approved. Checks are anonymous, without sign-in or site JavaScript; they do not interpret news/events or call a model. An enabled receipt means scheduled, not verified. After interruption, list current watches before considering another create.",
    inputSchema: Type.Object({ purpose, ...watchDraftSchema.properties }, strict),
    outputSchema: Type.Object({ watch: view, replayed: Type.Boolean() }, strict),
  },
  "ox.watch.update": {
    description: "Edit, enable or pause an existing public-page watch after approval in a regular conversation, using its current expectedRevision. Changing the URL or selector resets its comparison baseline. Pause discards an unrecorded in-flight result but cannot undo a sent request. Read fresh state after a conflict; never blindly repeat a write.",
    inputSchema: Type.Object({ purpose, id: identity, ...watchPatchSchema.properties }, strict),
    outputSchema: view,
  },
  "ox.watch.delete": {
    description: "Delete a public-page watch after approval in a regular conversation using its current expectedRevision. Stops future checks and discards unrecorded results, not requests already sent. Existing Inbox notices, history and backups remain.",
    inputSchema: Type.Object({ purpose, id: identity, expectedRevision: revision }, strict),
    outputSchema: Type.Object({ deleted: Type.Literal(true) }, strict),
  },
};

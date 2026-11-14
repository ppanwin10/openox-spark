import { Type, type Static } from "typebox";

const strict = { additionalProperties: false };
const id = Type.String({ format: "uuid" }), text = Type.String({ minLength: 1, maxLength: 2_000 });
const name = Type.String({ minLength: 1, maxLength: 200 }), instant = Type.String({ format: "date-time" });
const revision = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const source = Type.Object({ name, url: Type.String({ minLength: 1, maxLength: 2_048, format: "uri" }) }, strict);
export const discoveryKindSchema = Type.Union([Type.Literal("feed"), Type.Literal("ideas")]);
export type DiscoveryKind = Static<typeof discoveryKindSchema>;
const shared = { name, body: text, icon: Type.Optional(Type.String({ minLength: 1, maxLength: 24 })),
  imagePath: Type.Optional(Type.String({ minLength: 1, maxLength: 4_096 })) };
const feed = Type.Object({ ...shared, sources: Type.Array(source, { minItems: 1, maxItems: 5 }) }, strict);
const idea = Type.Object({ ...shared, action: text, sources: Type.Optional(Type.Array(source, { maxItems: 5 })) }, strict);
export const feedPublishSchema = Type.Object({ generationId: Type.Optional(id), items: Type.Array(feed, { maxItems: 10 }) }, strict);
export const ideaPublishSchema = Type.Object({ generationId: Type.Optional(id), items: Type.Array(idea, { maxItems: 10 }) }, strict);
export const discoveryPromptSchema = Type.Object({ expectedRevision: revision, text }, strict);
export const discoveryPatchSchema = Type.Object({ expectedRevision: revision, loved: Type.Optional(Type.Boolean()), hidden: Type.Optional(Type.Boolean()) }, strict);
export const generationDraftSchema = Type.Object({ expectedRevision: revision, replaceUnknown: Type.Optional(Type.Boolean()) }, strict);
export const discoveryRecordSchema = Type.Object({ id, kind: discoveryKindSchema, name, body: text, icon: Type.String({ maxLength: 24 }),
  sources: Type.Array(source, { maxItems: 5 }), action: Type.Union([text, Type.Null()]), imageFileId: Type.Union([Type.String({ maxLength: 512 }), Type.Null()]),
  dedupe: Type.String(), revision, loved: Type.Boolean(), hidden: Type.Boolean(), createdAt: instant, updatedAt: instant }, strict);
export const discoveryViewSchema = Type.Object({ id, kind: discoveryKindSchema, name, body: text, icon: Type.String({ maxLength: 24 }),
  sources: Type.Array(source, { maxItems: 5 }), action: Type.Union([text, Type.Null()]), imagePath: Type.Union([Type.String(), Type.Null()]),
  imageMissing: Type.Boolean(), provenance: Type.Literal("modelProvided"), revision, loved: Type.Boolean(), hidden: Type.Boolean(),
  createdAt: instant, updatedAt: instant, modified: Type.Number({ minimum: 0 }) }, strict);
export type DiscoveryItem = Static<typeof discoveryViewSchema>;
export const generationSchema = Type.Object({ id, kind: discoveryKindSchema, prompt: text, promptRevision: revision,
  conversationId: Type.Union([Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }), Type.Null()]), createdAt: instant,
  dispatchAttemptedAt: Type.Union([instant, Type.Null()]), submittedAt: Type.Union([instant, Type.Null()]),
  cancelRequestedAt: Type.Union([instant, Type.Null()]),
  publishedAt: Type.Union([instant, Type.Null()]), publicationCount: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  error: Type.Union([Type.String({ maxLength: 2_000 }), Type.Null()]) }, strict);
export type Generation = Static<typeof generationSchema>;
export type GenerationStatus = "preparing" | "running" | "completed" | "noUpdate" | "incomplete" | "failed" | "cancelled" | "unknown" | "unavailable";
export type GenerationView = Generation & { status: GenerationStatus };
const purpose = Type.String({ minLength: 1, maxLength: 240 });
const paging = { q: Type.Optional(Type.String({ maxLength: 200 })), sort: Type.Optional(Type.Union([Type.Literal("name"), Type.Literal("modified")])),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 30 })), cursor: Type.Optional(Type.String({ maxLength: 512 })) };
const listed = Type.Object({ items: Type.Array(discoveryViewSchema, { maxItems: 30 }), total: Type.Integer({ minimum: 0 }),
  nextCursor: Type.Union([Type.String(), Type.Null()]) }, strict);
const published = Type.Object({ items: Type.Array(discoveryViewSchema, { maxItems: 10 }), created: Type.Integer({ minimum: 0 }),
  updated: Type.Integer({ minimum: 0 }), replayed: Type.Boolean() }, strict);
export const discoveryContracts = {
  "ox.feed.list": { description: "Read approved bounded Feed objects, not live source verification. Use continuation cursors and refresh after inventory changes. Reading starts no generation.",
    inputSchema: Type.Object({ purpose, ...paging }, strict), outputSchema: listed },
  "ox.feed.setPrompt": { description: "Save the owner's Feed prompt after approval using its current expectedRevision. Does not start generation, scheduling or model calls.",
    inputSchema: Type.Object({ purpose, ...discoveryPromptSchema.properties }, strict), outputSchema: Type.Object({ text, revision }, strict) },
  "ox.feed.publish": { description: "Publish source-labelled Feed items after approval in a regular conversation. Cite safe source URLs; do not claim independent verification. Image paths reference existing public original-owner artifacts. An explicit generationId must belong to this conversation. Empty items explicitly report no updates. Dedup preserves owner Love/hidden choices; publishing is not model completion or a scheduled task.",
    inputSchema: Type.Object({ purpose, ...feedPublishSchema.properties }, strict), outputSchema: published },
  "ox.idea.list": { description: "Read approved bounded actionable Ideas with their owner lifecycle. Reading does not generate, activate a Goal or run the proposed action.",
    inputSchema: Type.Object({ purpose, ...paging }, strict), outputSchema: listed },
  "ox.idea.publish": { description: "Save actionable Ideas after approval in a regular conversation, using only context the user has chosen to share. An explicit generationId must belong to this conversation. Images use existing public artifacts. Owner dismissals are preserved; saving never starts the action, creates a Goal or changes MEMORY.",
    inputSchema: Type.Object({ purpose, ...ideaPublishSchema.properties }, strict), outputSchema: published },
};

import { Type, type Static } from "typebox";

const strict = { additionalProperties: false };
const identity = Type.String({ format: "uuid" });
const fileId = Type.String({ minLength: 1, maxLength: 512 });
const path = Type.String({ minLength: 1, maxLength: 4_096 });
const instant = Type.String({ format: "date-time" });
const revision = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const purpose = Type.String({ minLength: 1, maxLength: 240 });
const name = Type.String({ minLength: 1, maxLength: 200 });
const description = Type.String({ maxLength: 2_000 });
const sha256 = Type.String({ pattern: "^[a-f0-9]{64}$" });
const slot = Type.String({ pattern: "^[a-z][a-z0-9_-]{0,39}$" });
export const spacePlacementSchema = Type.Union([Type.Literal("sidebar"), Type.Literal("main"), Type.Literal("hidden")]);
export const spaceVisibilitySchema = Type.Object({
  timeZone: Type.String({ minLength: 1, maxLength: 100 }),
  windows: Type.Array(Type.Object({
    weekdays: Type.Array(Type.Integer({ minimum: 1, maximum: 7 }), { minItems: 1, maxItems: 7, uniqueItems: true }),
    start: Type.String({ pattern: "^([01][0-9]|2[0-3]):[0-5][0-9]$" }), end: Type.String({ pattern: "^([01][0-9]|2[0-3]):[0-5][0-9]$" }),
    from: Type.Optional(Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" })), until: Type.Optional(Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" })),
  }, strict), { maxItems: 8 }),
}, strict);
export type SpaceVisibility = Static<typeof spaceVisibilitySchema>;
export const spaceDataGrantSchema = Type.Object({
  id: identity, slot, fileId, schema: Type.Literal("openox.space.notes.v1"), access: Type.Union([Type.Literal("read"), Type.Literal("readWrite")]),
  entryFileId: fileId, entrySha256: sha256, grantedAt: instant,
}, strict);
export type SpaceDataGrant = Static<typeof spaceDataGrantSchema>;
export const spaceConnectionGrantSchema = Type.Object({
  domain: Type.String({ minLength: 1, maxLength: 500 }), kind: Type.Union([Type.Literal("api"), Type.Literal("web"), Type.Literal("mcp")]),
  repository: Type.String({ minLength: 1, maxLength: 500 }), definition: Type.String({ minLength: 1, maxLength: 2_000 }), proof: sha256, revision: Type.Integer({ minimum: 0 }),
  entryFileId: fileId, entrySha256: sha256, grantedAt: instant,
}, strict);
export type SpaceConnectionGrant = Static<typeof spaceConnectionGrantSchema>;
const navigation = { placement: Type.Optional(spacePlacementSchema), order: Type.Optional(Type.Integer({ minimum: 0, maximum: 499 })),
  visibility: Type.Optional(spaceVisibilitySchema) };
export const libraryCategorySchema = Type.Union([Type.Literal("documents"), Type.Literal("images"), Type.Literal("videos"), Type.Literal("podcasts"), Type.Literal("system")]);
export type LibraryCategory = Static<typeof libraryCategorySchema>;
export const libraryItemSchema = Type.Object({
  id: fileId, name: Type.String({ minLength: 1, maxLength: 240 }), path: Type.Union([path, Type.Null()]), size: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  modified: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]), sha256: Type.Union([Type.String(), Type.Null()]),
  category: libraryCategorySchema, missing: Type.Boolean(), tagRevision: Type.Integer({ minimum: 0 }),
}, strict);
export type LibraryItem = Static<typeof libraryItemSchema>;
export const spaceRecordSchema = Type.Object({
  id: identity, name, description, fileId, pinned: Type.Boolean(), revision, createdAt: instant, updatedAt: instant,
  ...navigation, dataGrants: Type.Optional(Type.Array(spaceDataGrantSchema, { maxItems: 4 })),
  connections: Type.Optional(Type.Array(spaceConnectionGrantSchema, { maxItems: 8 })),
}, strict);
export const spaceViewSchema = Type.Object({
  ...spaceRecordSchema.properties, entryPath: Type.Union([path, Type.Null()]), missing: Type.Boolean(),
  modified: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
}, strict);
export type Space = Static<typeof spaceViewSchema>;
export const spaceDraftSchema = Type.Object({
  name, entryPath: path, description: Type.Optional(description), pinned: Type.Optional(Type.Boolean()), ...navigation,
}, strict);
export const spacePatchSchema = Type.Object({
  name: Type.Optional(name), entryPath: Type.Optional(path), description: Type.Optional(description),
  pinned: Type.Optional(Type.Boolean()), expectedRevision: revision,
  ...navigation,
}, strict);
export const spaceNotesSchema = Type.Object({
  notes: Type.String({ maxLength: 32_000 }),
  items: Type.Array(Type.Object({ id: identity, text: Type.String({ minLength: 1, maxLength: 500 }), checked: Type.Boolean() }, strict), { maxItems: 200 }),
}, strict);
export type SpaceNotes = Static<typeof spaceNotesSchema>;
export const spaceDataSourceSchema = Type.Union([Type.Null(), Type.Object({
  kind: Type.Union([Type.Literal("owner"), Type.Literal("schedule")]), submissionId: identity, scheduleId: Type.Optional(identity),
}, strict)]);
export type SpaceDataSource = Static<typeof spaceDataSourceSchema>;
export const spaceDataSnapshotSchema = Type.Object({
  fileId, path, sourceRevision: sha256, revision: Type.Integer({ minimum: 0 }), data: spaceNotesSchema,
  updatedAt: Type.Union([instant, Type.Null()]), source: spaceDataSourceSchema,
}, strict);
export const spaceDataWriteSchema = Type.Object({ sourceRevision: sha256, requestId: identity, data: spaceNotesSchema }, strict);
export const spaceDataProofSchema = Type.Object({
  requestId: identity, revision: Type.Integer({ minimum: 1 }), inputApplied: Type.Boolean(), fingerprint: sha256, sourceRevision: sha256,
}, strict);
export type SpaceDataSnapshot = Static<typeof spaceDataSnapshotSchema>;
export const spaceScheduleSchema = Type.Object({ id: identity, fileId, entrySha256: sha256, slot, dataFileId: fileId, grantId: identity }, strict);
export type SpaceScheduleBinding = Static<typeof spaceScheduleSchema>;
export const libraryRevisionSchema = Type.Object({ expectedRevision: revision }, strict);
export const podcastPatchSchema = Type.Object({ expectedRevision: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }), podcast: Type.Boolean() }, strict);
const paging = { limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 30 })), cursor: Type.Optional(Type.String({ maxLength: 512 })),
  q: Type.Optional(Type.String({ maxLength: 200 })), sort: Type.Optional(Type.Union([Type.Literal("name"), Type.Literal("modified")])) };
const nextCursor = Type.Union([Type.String(), Type.Null()]);
export const libraryContracts = {
  "ox.space.data.read": {
    description: "Read one explicitly owner-granted notes/checklist JSON slot of the current original Space frame or bound scheduled task. The Host derives identity and current code/grant proof. No private files, arbitrary paths or other Spaces. Source revision is the original file SHA256, not cached freshness.",
    inputSchema: Type.Object({ purpose, slot }, strict), outputSchema: spaceDataSnapshotSchema,
  },
  "ox.space.data.write": {
    description: "Replace one explicitly readWrite-granted original Space notes/checklist slot after original approval, using the exact read sourceRevision and a new requestId UUID. Original file CAS atomically commits data and bounded receipt. On lost response read proof; never auto-replay a toggle/append or assume a historical receipt applied new input. A scheduled write requires its current original bound task.",
    inputSchema: Type.Object({ purpose, slot, ...spaceDataWriteSchema.properties }, strict),
    outputSchema: Type.Object({ inputApplied: Type.Boolean(), historical: Type.Boolean(), snapshot: spaceDataSnapshotSchema }, strict),
  },
  "ox.space.data.proof": {
    description: "Read original-file proof for a possibly committed Space data request without replaying it. inputApplied is false when a later commit replaced that revision. Verify its fingerprint/source against the exact uncertain input, not a newer edit.",
    inputSchema: Type.Object({ purpose, slot, requestId: identity }, strict), outputSchema: spaceDataProofSchema,
  },
  "ox.library.list": {
    description: "List bounded metadata from the original Profile file owner after approval, with category, name/path search and a continuation cursor. No file bodies or duplicate index. Ordinary audio is not a podcast unless explicitly classified. A changed inventory invalidates its cursor; restart the read instead of assuming complete coverage.",
    inputSchema: Type.Object({ purpose, category: libraryCategorySchema, ...paging }, strict),
    outputSchema: Type.Object({ items: Type.Array(libraryItemSchema, { maxItems: 30 }), nextCursor, total: Type.Integer({ minimum: 0 }) }, strict),
  },
  "ox.library.tag": {
    description: "Explicitly classify or unclassify an existing audio artifact as a podcast after approval in a regular conversation, using its current tag revision (0 only when never tagged). Classification is not audio generation or proof of quality. Stable file identity survives moves; deleted files are not silently replaced.",
    inputSchema: Type.Object({ purpose, fileId, ...podcastPatchSchema.properties }, strict),
    outputSchema: Type.Object({ fileId, podcast: Type.Boolean(), revision }, strict),
  },
  "ox.space.list": {
    description: "List persistent named Spaces after approval with current entry paths, revisions, pin and missing state. Metadata references the original file owner, not copied HTML. Missing entries never adopt a new file at the same path.",
    inputSchema: Type.Object({ purpose, ...paging }, strict),
    outputSchema: Type.Object({ spaces: Type.Array(spaceViewSchema, { maxItems: 30 }), nextCursor, total: Type.Integer({ minimum: 0 }) }, strict),
  },
  "ox.space.create": {
    description: "Register an existing regular HTML artifact as a persistent Space after approval in a regular conversation. Generate/write the artifact through the existing file/media functions first. Uses the existing sandboxed page/service runtime and approval rules, without arbitrary networking or private-file access. Registration/pinning starts no model/job and does not prove display or functionality.",
    inputSchema: Type.Object({ purpose, ...spaceDraftSchema.properties }, strict),
    outputSchema: Type.Object({ space: spaceViewSchema, replayed: Type.Boolean() }, strict),
  },
  "ox.space.update": {
    description: "Rename, describe, pin or explicitly rebind a Space to an existing HTML artifact after approval using its current expectedRevision. Entry content stays with the original file owner; ordinary updates/moves retain its identity. Pinning does not schedule work. Read fresh state after a conflict; never blindly repeat a mutation.",
    inputSchema: Type.Object({ purpose, id: identity, ...spacePatchSchema.properties }, strict),
    outputSchema: spaceViewSchema,
  },
  "ox.space.delete": {
    description: "Remove a Space registration after approval using its current expectedRevision. Does not delete its original artifact, content, tasks, history or receipts; deleted create requests cannot resurrect it.",
    inputSchema: Type.Object({ purpose, id: identity, expectedRevision: revision }, strict),
    outputSchema: Type.Object({ deleted: Type.Literal(true) }, strict),
  },
};

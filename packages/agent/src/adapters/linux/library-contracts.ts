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
}, strict);
export const spaceViewSchema = Type.Object({
  ...spaceRecordSchema.properties, entryPath: Type.Union([path, Type.Null()]), missing: Type.Boolean(),
  modified: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
}, strict);
export type Space = Static<typeof spaceViewSchema>;
export const spaceDraftSchema = Type.Object({
  name, entryPath: path, description: Type.Optional(description), pinned: Type.Optional(Type.Boolean()),
}, strict);
export const spacePatchSchema = Type.Object({
  name: Type.Optional(name), entryPath: Type.Optional(path), description: Type.Optional(description),
  pinned: Type.Optional(Type.Boolean()), expectedRevision: revision,
}, strict);
export const libraryRevisionSchema = Type.Object({ expectedRevision: revision }, strict);
export const podcastPatchSchema = Type.Object({ expectedRevision: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }), podcast: Type.Boolean() }, strict);
const paging = { limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 30 })), cursor: Type.Optional(Type.String({ maxLength: 512 })),
  q: Type.Optional(Type.String({ maxLength: 200 })), sort: Type.Optional(Type.Union([Type.Literal("name"), Type.Literal("modified")])) };
const nextCursor = Type.Union([Type.String(), Type.Null()]);
export const libraryContracts = {
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

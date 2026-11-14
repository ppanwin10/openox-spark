import { Type, type Static } from "typebox";

const strict = { additionalProperties: false }, name = Type.String({ minLength: 1, maxLength: 100 });
const revision = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }), path = Type.String({ minLength: 1, maxLength: 4_096 });
export const identityPatchSchema = Type.Object({ expectedRevision: revision, name: Type.Optional(name), avatarPath: Type.Optional(Type.Union([path, Type.Null()])) }, strict);
export const soulPatchSchema = Type.Object({ expectedSourceRevision: Type.String({ minLength: 1, maxLength: 64 }), text: Type.String({ maxLength: 8_000 }) }, strict);
export const identityAgentSchema = Type.Object({ name, avatarPath: Type.Union([path, Type.Null()]), avatarMissing: Type.Boolean(), revision,
  updatedAt: Type.Union([Type.String({ format: "date-time" }), Type.Null()]) }, strict);
export const soulSchema = Type.Object({ path: Type.Literal("SOUL.md"), text: Type.Union([Type.String({ maxLength: 8_000 }), Type.Null()]),
  revision: Type.String(), exists: Type.Boolean() }, strict);
export const identityViewSchema = Type.Object({ agent: identityAgentSchema, soul: soulSchema }, strict);
export type AgentIdentity = Static<typeof identityAgentSchema>;
export type SoulSnapshot = Static<typeof soulSchema>;
const purpose = Type.String({ minLength: 1, maxLength: 240 });
export const identityContracts = {
  "ox.identity.get": { description: "Read the current Agent identity and original SOUL document after approval. This is not the user's Workspace identity. Missing SOUL is explicit; reading creates no file or model work.",
    inputSchema: Type.Object({ purpose }, strict), outputSchema: identityViewSchema },
  "ox.identity.update": { description: "Change the Agent name or an existing public avatar artifact after approval using expectedRevision. Does not rename the Workspace, change MEMORY, grant permissions or implement a live voice avatar.",
    inputSchema: Type.Object({ purpose, ...identityPatchSchema.properties }, strict), outputSchema: identityAgentSchema },
  "ox.identity.setSoul": { description: "Save explicit user-owned Agent guidance to original SOUL.md after approval using expectedSourceRevision (missing only if no file exists). Preserve stale/manual edits; guidance cannot override rules, permissions or Host limitations.",
    inputSchema: Type.Object({ purpose, ...soulPatchSchema.properties }, strict), outputSchema: soulSchema },
};

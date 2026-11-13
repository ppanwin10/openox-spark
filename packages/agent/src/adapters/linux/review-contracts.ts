import { Type, type Static } from "typebox";

const strict = { additionalProperties: false };
const purpose = Type.String({ minLength: 1, maxLength: 240 });
const reason = Type.String({ minLength: 1, maxLength: 2_000 });
export const memoryProposalSchema = Type.Object({
  type: Type.Literal("memory"), text: Type.String({ minLength: 1, maxLength: 1_000 }),
  classification: Type.Union([Type.Literal("explicit"), Type.Literal("inferred")]),
}, strict);
export const skillProposalSchema = Type.Object({
  type: Type.Literal("skill"), operation: Type.Union([Type.Literal("create"), Type.Literal("update")]),
  name: Type.String({ minLength: 1, maxLength: 100 }), description: Type.String({ minLength: 1, maxLength: 1_000 }),
  instructions: Type.String({ minLength: 1, maxLength: 32_000 }), services: Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { maxItems: 32 }),
}, strict);
export const reviewDraftSchema = Type.Object({ data: Type.Union([memoryProposalSchema, skillProposalSchema]), reason }, strict);
const revision = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
export const reviewRevisionSchema = Type.Object({ expectedRevision: revision }, strict);
export const reviewAcceptSchema = Type.Object({ expectedRevision: revision, expectedSourceRevision: Type.String({ minLength: 1, maxLength: 64 }) }, strict);
export const reviewSettingsSchema = Type.Object({
  expectedRevision: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }), suggestionsEnabled: Type.Boolean(),
}, strict);
export const reviewMemorySchema = Type.Object({
  text: Type.String({ maxLength: 524_288 }), expectedSourceRevision: Type.String({ minLength: 1, maxLength: 64 }),
}, strict);
export const reviewCandidateSchema = Type.Object({
  id: Type.String({ format: "uuid" }), data: reviewDraftSchema.properties.data, reason,
  status: Type.Union([Type.Literal("pending"), Type.Literal("applying"), Type.Literal("accepted"), Type.Literal("rejected"), Type.Literal("needs_review")]),
  revision, createdAt: Type.String({ format: "date-time" }),
  appliedAt: Type.Union([Type.String({ format: "date-time" }), Type.Null()]),
  decidedAt: Type.Union([Type.String({ format: "date-time" }), Type.Null()]),
  origin: Type.Object({ kind: Type.Union([Type.Literal("manual"), Type.Literal("agent")]),
    conversationId: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]) }, strict),
  note: Type.Union([Type.String({ maxLength: 2_000 }), Type.Null()]),
}, strict);
export type ReviewCandidate = Static<typeof reviewCandidateSchema>;
export type ReviewDraft = Static<typeof reviewDraftSchema>;
export type ReviewSource = { path: string; text: string | null; revision: string };
const receipt = Type.Object({ candidate: reviewCandidateSchema, replayed: Type.Boolean() }, strict);
export const reviewContracts = {
  "ox.memory.propose": {
    description: "Submit an inactive memory suggestion for owner review after approval. Requires enabled suggestions and a non-temporary conversation. Explicit/inferred is your unverified classification, never authority to save. This does not change MEMORY.md or prove that anything was remembered. Do not propose sensitive profiling or collect unrelated history.",
    inputSchema: Type.Object({ purpose, text: memoryProposalSchema.properties.text, classification: memoryProposalSchema.properties.classification, reason }, strict),
    outputSchema: receipt,
  },
  "ox.skill.propose": {
    description: "Submit an inactive SKILL.md create/update proposal after approval. The owner must review and publish it; proposal receipt never means installed or enabled. Existing scripts/resources and permissions are not expanded. Static validation is not model-quality or security certification.",
    inputSchema: Type.Object({ purpose, operation: skillProposalSchema.properties.operation, name: skillProposalSchema.properties.name,
      description: skillProposalSchema.properties.description, instructions: skillProposalSchema.properties.instructions,
      services: skillProposalSchema.properties.services, reason }, strict),
    outputSchema: receipt,
  },
};

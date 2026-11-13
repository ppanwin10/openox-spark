import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc, type Harness } from "@earendil-works/pi-durable";
import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { OxError } from "./functions";
import { reviewCandidateSchema, reviewDraftSchema, type ReviewCandidate, type ReviewDraft } from "./review-contracts";

const mutationSchema = Type.Object({
  path: Type.String({ minLength: 1 }), before: Type.String(), after: Type.String(), expectedRevision: Type.Integer({ minimum: 1 }),
  staging: Type.Union([Type.String({ pattern: "^drafts/review-[a-f0-9-]{36}$" }), Type.Null()]),
}, { additionalProperties: false });
export type ReviewMutation = Static<typeof mutationSchema>;
const stateSchema = Type.Object({
  settings: Type.Object({ revision: Type.Integer({ minimum: 0 }), suggestionsEnabled: Type.Boolean() }, { additionalProperties: false }),
  records: Type.Record(Type.String(), Type.Object({ candidate: reviewCandidateSchema, mutation: Type.Union([mutationSchema, Type.Null()]) }, { additionalProperties: false })),
  requests: Type.Record(Type.String(), Type.Object({ fingerprint: Type.String(), id: Type.String({ format: "uuid" }) }, { additionalProperties: false })),
}, { additionalProperties: false });
type State = Static<typeof stateSchema>;
const initial = (): State => ({ settings: { revision: 0, suggestionsEnabled: false }, records: {}, requests: {} });
const ReviewState = defineDoc<State>({
  kind: "ox.review", version: 1, scope: "session", initial,
  checkpointWhen: (_, __, info) => info.deltasSinceBase >= 31,
});
const context = BACKGROUND_CONTEXT;
export const contentRevision = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");
export const reviewConflict = () => new OxError("conflict", "This review or its source changed. Reload and review the current version before publishing.");
export function reviewInput<T extends TSchema>(schema: T, value: unknown): Static<T> {
  if (!Value.Check(schema, value)) throw new OxError("invalid_argument", [...Value.Errors(schema, value)].slice(0, 3).map(error => `${error.instancePath || "/"} ${error.message}`).join("; "));
  return value;
}
function valid(state: State) {
  if (!Value.Check(stateSchema, state) || Object.entries(state.records).some(([id, record]) => id !== record.candidate.id
    || (record.candidate.status === "applying" && record.mutation === null))) {
    throw new OxError("unavailable", "The review queue is invalid. No empty replacement was created.", "Restore or repair this Profile before using reviewed suggestions.");
  }
  return state;
}

export class ReviewStore {
  private readonly harness: Harness;
  constructor(harness: Harness) { this.harness = harness; }

  private async state() { return valid(await this.harness.snapshot(ReviewState, context) ?? initial()); }
  private owned(state: State, id: string) {
    if (!Object.hasOwn(state.records, id)) throw new OxError("not_found", "This review is unavailable in the current workspace.");
    return state.records[id]!;
  }
  async list() {
    const state = await this.state();
    return { settings: state.settings, candidates: Object.values(state.records).map(record => record.candidate)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id)), limit: 200 };
  }
  async get(id: string) { return this.owned(await this.state(), id); }
  async requireEnabled() {
    if (!(await this.state()).settings.suggestionsEnabled) throw new OxError("permission_denied", "Assistant suggestions are paused.", "The owner can enable reviewed suggestions. Manual memory/Skill editing remains available.");
  }
  async settings(expectedRevision: number, suggestionsEnabled: boolean) {
    return this.harness.commit(async tx => {
      const state = valid(await tx.doc(ReviewState));
      if (state.settings.revision !== expectedRevision) throw reviewConflict();
      if (state.settings.suggestionsEnabled !== suggestionsEnabled) {
        state.settings.suggestionsEnabled = suggestionsEnabled;
        state.settings.revision++;
      }
      return Value.Clone(state.settings);
    }, context);
  }
  async create(value: unknown, key: string, origin: ReviewCandidate["origin"]) {
    const draft: ReviewDraft = reviewInput(reviewDraftSchema, value);
    if (!/^[A-Za-z0-9._:-]{1,160}$/.test(key) || !draft.reason.trim()) throw new OxError("invalid_argument", "A stable request key and review reason are required.");
    if (draft.data.type === "memory" && (!draft.data.text.trim() || draft.data.text.includes("\n") || draft.data.text.includes("\r"))) {
      throw new OxError("invalid_argument", "A memory suggestion must be one nonempty line.");
    }
    const data = draft.data.type === "memory" ? { ...draft.data, text: draft.data.text.trim() } : draft.data;
    const request = contentRevision(key), fingerprint = contentRevision(JSON.stringify({ data, reason: draft.reason.trim(), origin }));
    return this.harness.commit(async tx => {
      const state = valid(await tx.doc(ReviewState)), previous = state.requests[request];
      if (origin.kind === "agent" && !state.settings.suggestionsEnabled) throw new OxError("permission_denied", "Assistant suggestions are paused.");
      if (previous) {
        if (previous.fingerprint !== fingerprint || !Object.hasOwn(state.records, previous.id)) throw reviewConflict();
        return { candidate: Value.Clone(state.records[previous.id]!.candidate), replayed: true };
      }
      if (Object.keys(state.records).length >= 200 || Object.keys(state.requests).length >= 2_000) throw new OxError("limit_exceeded", "This preview's review or request-receipt limit was reached.");
      const id = crypto.randomUUID(), candidate: ReviewCandidate = { id, data, reason: draft.reason.trim(), status: "pending", revision: 1,
        createdAt: new Date().toISOString(), appliedAt: null, decidedAt: null, origin, note: null };
      state.records[id] = { candidate, mutation: null };
      state.requests[request] = { fingerprint, id };
      return { candidate: Value.Clone(candidate), replayed: false };
    }, context);
  }
  async claim(id: string, expectedRevision: number, mutation: Omit<ReviewMutation, "expectedRevision">) {
    return this.harness.commit(async tx => {
      const record = this.owned(valid(await tx.doc(ReviewState)), id), candidate = record.candidate;
      if (!["pending", "needs_review"].includes(candidate.status) || candidate.revision !== expectedRevision) throw reviewConflict();
      candidate.status = "applying"; candidate.revision++; candidate.note = null;
      record.mutation = { ...mutation, expectedRevision };
      return Value.Clone(candidate);
    }, context);
  }
  async finish(id: string, expectedRevision: number) {
    return this.harness.commit(async tx => {
      const record = this.owned(valid(await tx.doc(ReviewState)), id), candidate = record.candidate;
      if (candidate.status !== "applying" || candidate.revision !== expectedRevision) throw reviewConflict();
      candidate.status = "accepted"; candidate.revision++; candidate.appliedAt = candidate.decidedAt = new Date().toISOString();
      return Value.Clone(candidate);
    }, context);
  }
  async release(id: string, note: string, changed: boolean) {
    await this.harness.commit(async tx => {
      const record = this.owned(valid(await tx.doc(ReviewState)), id);
      if (record.candidate.status !== "applying") return;
      record.candidate.status = changed ? "needs_review" : "pending";
      record.candidate.revision++; record.candidate.note = note.slice(0, 2_000); record.mutation = null;
    }, context);
  }
  async reject(id: string, expectedRevision: number) {
    return this.harness.commit(async tx => {
      const record = this.owned(valid(await tx.doc(ReviewState)), id), candidate = record.candidate;
      if (!["pending", "needs_review"].includes(candidate.status) || candidate.revision !== expectedRevision) throw reviewConflict();
      candidate.status = "rejected"; candidate.revision++; candidate.decidedAt = new Date().toISOString();
      return Value.Clone(candidate);
    }, context);
  }
  async delete(id: string, expectedRevision: number) {
    await this.harness.commit(async tx => {
      const state = valid(await tx.doc(ReviewState)), record = this.owned(state, id);
      if (record.candidate.status === "applying" || record.candidate.revision !== expectedRevision) throw reviewConflict();
      delete state.records[id];
    }, context);
    return { deleted: true as const };
  }
}

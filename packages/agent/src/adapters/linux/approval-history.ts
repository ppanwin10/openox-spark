import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc, type Harness } from "@earendil-works/pi-durable";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { OxError } from "./functions";

const decision = Type.Union([Type.Literal("approved"), Type.Literal("alwaysApproved"), Type.Literal("allowedByPolicy"),
  Type.Literal("denied"), Type.Literal("cancelled"), Type.Literal("blockedByPolicy")]);
const entrySchema = Type.Object({ id: Type.String({ format: "uuid" }), action: Type.String({ minLength: 1, maxLength: 160 }),
  label: Type.String({ minLength: 1, maxLength: 200 }), source: Type.Union([Type.String({ maxLength: 300 }), Type.Null()]),
  decision, scope: Type.Union([Type.Literal("action"), Type.Literal("source"), Type.Literal("default"), Type.Literal("fallback")]),
  conversationId: Type.Union([Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }), Type.Null()]),
  origin: Type.Union([Type.Literal("conversation"), Type.Literal("page")]), recordedAt: Type.String({ format: "date-time" }) }, { additionalProperties: false });
export type ApprovalReceipt = Static<typeof entrySchema>;
type Draft = Omit<ApprovalReceipt, "id" | "recordedAt">;
const schema = Type.Object({ records: Type.Record(Type.String(), entrySchema),
  requests: Type.Record(Type.String(), Type.Object({ id: Type.String(), fingerprint: Type.String() }, { additionalProperties: false })) }, { additionalProperties: false });
type State = Static<typeof schema>;
const initial = (): State => ({ records: {}, requests: {} });
const History = defineDoc<State>({ kind: "ox.approval-history", version: 1, scope: "session", initial, checkpointWhen: (_, __, info) => info.deltasSinceBase >= 31 });
const context = BACKGROUND_CONTEXT, hash = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex");
function validated(state: State) {
  if (!Value.Check(schema, state) || Object.keys(state.records).length > 5_000
    || Object.entries(state.records).some(([id, row]) => id !== row.id)
    || Object.keys(state.records).length !== Object.keys(state.requests).length
    || Object.entries(state.requests).some(([key, request]) => !/^[0-9a-f]{64}$/.test(key)
      || !/^[0-9a-f]{64}$/.test(request.fingerprint) || !state.records[request.id])) {
    throw new OxError("unavailable", "Approval history is invalid. No empty replacement was created.");
  }
  return state;
}
export class ApprovalHistoryStore {
  private readonly harness: Harness;
  private readonly changed?: () => void;
  constructor(harness: Harness, changed?: () => void) { this.harness = harness; this.changed = changed; }
  async list() {
    const state = validated(await this.harness.snapshot(History, context) ?? initial());
    return Object.values(state.records).sort((a, b) => b.recordedAt.localeCompare(a.recordedAt) || b.id.localeCompare(a.id));
  }
  async record(input: Draft, key: string) {
    if (!key) throw new OxError("invalid_state", "This authorization has no trusted request identity.");
    const request = hash(key), fingerprint = hash(JSON.stringify(input));
    const receipt = await this.harness.commit(async tx => {
      const state = validated(await tx.doc(History)), old = state.requests[request];
      if (old) {
        if (old.fingerprint !== fingerprint || !state.records[old.id]) throw new OxError("conflict", "This authorization receipt belongs to another decision.");
        return Value.Clone(state.records[old.id]!);
      }
      if (Object.keys(state.records).length >= 5_000) throw new OxError("limit_exceeded", "Approval history is full. No unrecorded permission was granted.");
      const id = crypto.randomUUID(), row: ApprovalReceipt = { ...input, id, recordedAt: new Date().toISOString() };
      if (!Value.Check(entrySchema, row)) throw new OxError("invalid_argument", "This trusted authorization receipt is invalid.");
      state.records[id] = row; state.requests[request] = { id, fingerprint };
      return Value.Clone(row);
    }, context);
    this.changed?.();
    return receipt;
  }
}

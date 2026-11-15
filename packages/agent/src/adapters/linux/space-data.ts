import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { OxError } from "./functions";
import { spaceDataSourceSchema, spaceNotesSchema, type SpaceNotes, type SpaceDataSource } from "./library-contracts";

const hash = Type.String({ pattern: "^[a-f0-9]{64}$" });
const schema = Type.Object({
  version: Type.Literal(1), revision: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }), data: spaceNotesSchema,
  receipts: Type.Array(Type.Object({
    id: Type.String({ format: "uuid" }), fingerprint: hash, sourceRevision: hash, revision: Type.Integer({ minimum: 1 }),
    at: Type.String({ format: "date-time" }), source: spaceDataSourceSchema,
  }, { additionalProperties: false }), { maxItems: 256 }),
  updatedAt: Type.Union([Type.Null(), Type.String({ format: "date-time" })]), source: spaceDataSourceSchema,
}, { additionalProperties: false });
export type SpaceDataDocument = Static<typeof schema>;
export const spaceDataHash = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex");
export const spaceDataFingerprint = (value: SpaceNotes) => spaceDataHash(JSON.stringify({ notes: value.notes, items: value.items.map(({ id, text, checked }) => ({ id, text, checked })) }));
export function parseSpaceData(text: string): SpaceDataDocument {
  if (Buffer.byteLength(text) > 65_536) throw new OxError("limit_exceeded", "A Space data file is limited to 64 KiB.");
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new OxError("unavailable", "The original Space data file is not valid JSON. Nothing was replaced."); }
  if (!Value.Check(schema, value) || new Set(value.data.items.map(item => item.id)).size !== value.data.items.length
    || new Set(value.receipts.map(item => item.id)).size !== value.receipts.length
    || value.receipts.some(item => item.revision > value.revision) || value.revision === 0 && (value.receipts.length || value.updatedAt !== null || value.source !== null)) {
    throw new OxError("unavailable", "The original Space notes schema is invalid or unsupported. Nothing was replaced.");
  }
  return value;
}
export function spaceDataCommit(document: SpaceDataDocument, requestId: string, sourceRevision: string, data: SpaceNotes, source: SpaceDataSource) {
  const fingerprint = spaceDataFingerprint(data), receipt = document.receipts.find(item => item.id === requestId);
  if (receipt) {
    if (receipt.fingerprint !== fingerprint || receipt.sourceRevision !== sourceRevision) throw new OxError("conflict", "This request belongs to different Space input. It was not replayed.");
    return { historical: true, inputApplied: receipt.revision === document.revision, document };
  }
  if (document.receipts.length >= 256 || document.revision >= Number.MAX_SAFE_INTEGER) throw new OxError("limit_exceeded", "The original Space data receipt limit was reached. No history was pruned.");
  const revision = document.revision + 1;
  const at = new Date().toISOString();
  const next = { ...document, revision, data, updatedAt: at, source,
    receipts: [...document.receipts, { id: requestId, fingerprint, sourceRevision, revision, at, source }] };
  parseSpaceData(JSON.stringify(next));
  return { historical: false, inputApplied: true, document: next };
}

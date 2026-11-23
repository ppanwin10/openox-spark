import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc, type ConversationId, type Harness, type Tx } from "@earendil-works/pi-durable";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { OxError } from "./functions";
import { ConversationPresentation } from "../../profile/conversations";
import { ConversationApplicationMetadata } from "../../profile/install";
import { ProfileFileState } from "../../profile/file-store";

const strict = { additionalProperties: false }, hash = Type.String({ pattern: "^[a-f0-9]{64}$" });
export const chatSuggestionSchema = Type.Object({ title: Type.String({ minLength: 1, maxLength: 200 }),
  suggestion: Type.String({ minLength: 1, maxLength: 500 }) }, strict);
export const chatQuoteSchema = Type.Object({ url: Type.String({ minLength: 1, maxLength: 2048 }), quote: Type.String({ minLength: 20, maxLength: 800 }) }, strict);
export const discoverySignalSchema = Type.Union([chatSuggestionSchema, chatQuoteSchema]);
export type ChatDiscoverySignal = Static<typeof discoverySignalSchema>;
export const connectorUpdatesSchema = Type.Object({ items: Type.Array(Type.Object({
  id: Type.String({ minLength: 1, maxLength: 200 }), title: Type.String({ minLength: 1, maxLength: 200 }),
  body: Type.String({ minLength: 1, maxLength: 800 }), url: Type.String({ minLength: 1, maxLength: 2048 }),
}, strict), { maxItems: 20 }) }, strict);
export type ConnectorUpdates = Static<typeof connectorUpdatesSchema>;
const schema = Type.Object({
  goals: Type.Record(Type.String(), Type.Object({ conversation: Type.Integer({ minimum: 0 }), outcomeHash: hash, step: Type.String({ minLength: 1, maxLength: 500 }) }, strict)),
  watches: Type.Record(Type.String(), Type.Object({ hash, target: hash, text: Type.String({ minLength: 1, maxLength: 800 }),
    url: Type.String({ minLength: 1, maxLength: 2048 }), at: Type.String({ format: "date-time" }) }, strict)),
  chats: Type.Record(Type.String(), Type.Object({ conversation: Type.Integer({ minimum: 0 }), at: Type.String({ format: "date-time" }), signal: discoverySignalSchema }, strict)),
  connectors: Type.Record(Type.String(), Type.Object({ proof: hash, at: Type.String({ format: "date-time" }), checkedAt: Type.String({ format: "date-time" }), updates: connectorUpdatesSchema }, strict)),
}, strict);
type Signals = Static<typeof schema>;
const SignalsDoc = defineDoc<Signals>({ kind: "ox.discovery.signals", version: 1, scope: "session", initial: () => ({ goals: {}, watches: {}, chats: {}, connectors: {} }),
  checkpointWhen: (_, __, info) => info.deltasSinceBase >= 31 });
export const signalHash = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");
export const watchTarget = (url: string, selector: string | null) => signalHash(JSON.stringify([url, selector]));
export async function discoveryChatVisible(tx: Tx, conversation: number, newItem = false) {
  const id = conversation as ConversationId;
  if (!await tx.conversation(id)) return false;
  const [presentation, metadata, files] = await Promise.all([tx.doc(ConversationPresentation, id), tx.doc(ConversationApplicationMetadata, id), tx.doc(ProfileFileState)]);
  return presentation.visible && metadata.fields.temporary !== true && (!newItem || metadata.fields.quietDiscoveryExcluded !== true)
    && !metadata.fields.backgroundGoal && !files.deletedConversations.includes(id);
}
export async function readDiscoverySignals(harness: Harness) {
  const doc = await harness.snapshot(SignalsDoc, BACKGROUND_CONTEXT);
  if (doc && !Value.Check(schema, doc)) throw new OxError("unavailable", "The original discovery signals are unreadable; no replacement was created.");
  return doc;
}
export function discoverySourceURL(value: string) {
  try {
    const u = new URL(value);
    return ["https:", "http:"].includes(u.protocol) && !u.username && !u.password
      && ![...u.searchParams.keys(), ...new URLSearchParams(u.hash.slice(1)).keys()].some(key => /(?:token|api[-_]?key|password|secret|signature)/i.test(key));
  } catch { return false; }
}
export async function discoverySignals(tx: Tx) {
  const doc = await tx.doc(SignalsDoc);
  if (!Value.Check(schema, doc)) throw new OxError("unavailable", "The original discovery signals are unreadable; no replacement was created.");
  return doc;
}

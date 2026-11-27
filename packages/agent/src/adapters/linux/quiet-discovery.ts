import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc, type ConversationId, type Harness, type Tx } from "@earendil-works/pi-durable";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { discoveryInput } from "./discovery";
import { discoveryPatchSchema, type DiscoveryItem, type DiscoveryKind } from "./discovery-contracts";
import { chatSuggestionSchema, discoveryChatVisible, discoverySignalSchema, discoverySignals, discoverySourceURL, readDiscoverySignals, signalHash, watchTarget, type ChatDiscoverySignal, type ConnectorUpdates } from "./discovery-signals";
import { OxError } from "./functions";
import { inputData } from "./message-actions";
import { discoveryGoals } from "./goals";
import { discoveryTodos } from "./todos";
import { discoveryWatches } from "./watches";
import { stableID } from "./transcript";
import { InboxState, validateInbox } from "./inbox";
import type { GoalRunReport } from "./goal-contracts";
import { ConversationApplicationMetadata } from "../../profile/install";

const context = BACKGROUND_CONTEXT, strict = { additionalProperties: false };
const stamp = Type.String({ pattern: "^[a-f0-9]{64}$" }), date = Type.String({ format: "date-time" });
const rowSchema = Type.Object({ stamp, available: Type.Boolean(), revision: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  hidden: Type.Boolean(), loved: Type.Boolean(), createdAt: date, updatedAt: date }, strict);
const indexSchema = Type.Object({ rows: Type.Record(Type.String(), rowSchema) }, strict);
const Index = defineDoc<Static<typeof indexSchema>>({ kind: "ox.discovery.private-index", version: 1, scope: "session",
  initial: () => ({ rows: {} }), checkpointWhen: (_, __, info) => info.deltasSinceBase >= 31 });
const originSchema = Type.Object({ conversation: Type.Integer({ minimum: 0 }), request: Type.String({ maxLength: 160 }),
  entry: Type.Integer({ minimum: 0 }), inputHash: stamp, signalHash: stamp, at: date }, strict);
const originsSchema = Type.Object({ items: Type.Record(Type.String(), originSchema) }, strict);
const Origins = defineDoc<Static<typeof originsSchema>>({ kind: "ox.discovery.idea-origins", version: 1, scope: "session",
  initial: () => ({ items: {} }), checkpointWhen: (_, __, info) => info.deltasSinceBase >= 31 });
type Row = Static<typeof rowSchema>;
type Draft = Pick<DiscoveryItem, "id" | "kind" | "name" | "body" | "action" | "sources"> & {
  originId: string; provenance: "trackedGoal" | "publicWatch" | "goalFinding" | "chatSuggestion" | "chatQuote" | "connectorUpdate"; observedAt: string;
};
export type QuietGoalReport = { scheduleId: string; goalId: string; noticeId: string; conversationId: number; report: Extract<GoalRunReport, { outcome: "updated" }> };
export type QuietSourceAllowed = (kind: DiscoveryKind, urls: readonly string[], scheduleId?: string) => boolean;
export type QuietScope = { reports: readonly QuietGoalReport[]; allows: QuietSourceAllowed; connectors: ReadonlyMap<string, string> };
export type WorkspaceDiscoveryItem = DiscoveryItem | (Omit<DiscoveryItem, "provenance"> & Pick<Draft, "provenance" | "originId" | "observedAt">);

async function index(tx: Tx) {
  const value = await tx.doc(Index);
  if (!Value.Check(indexSchema, value)) throw new OxError("unavailable", "The quiet discovery index is unreadable; no replacement was created.");
  return value.rows;
}
async function soleChatQuoteRevision(tx: Tx, conversation: number, url: string) {
  const { chats } = await discoverySignals(tx), rows = await index(tx);
  let revision: number | undefined;
  for (const [id, entry] of Object.entries(chats)) {
    const row = rows[id];
    if (entry.conversation !== conversation || !("quote" in entry.signal) || !row?.available || row.hidden) continue;
    if (entry.signal.url !== url || revision !== undefined) return;
    revision = row.revision;
  }
  return revision;
}
const sourceStamp = ({ observedAt: _, ...fields }: Draft) => signalHash(JSON.stringify(fields));
function ideaDraft(id: string, conversation: number, signal: Static<typeof chatSuggestionSchema>, at: string): Draft {
  return { id, originId: String(conversation), observedAt: at, kind: "ideas", provenance: "chatSuggestion", name: signal.title,
    body: signal.suggestion, action: signal.suggestion, sources: [] };
}
const chatIdeaID = (conversation: number, title: string) => stableID(JSON.stringify(["quiet:chat", conversation, ["ideas", title.trim().toLowerCase()]]));
const ideaConflict = () => new OxError("conflict", "The earlier Idea does not match this edit. No Idea was changed.");
async function origins(tx: Tx) {
  const state = await tx.doc(Origins);
  if (!Value.Check(originsSchema, state)) throw new OxError("unavailable", "The original Idea source index is invalid.");
  return state.items;
}
async function ideaInput(tx: Tx, conversation: number, request: string, suggestion: string, completed = false) {
  const submission = await tx.submissionByRequest(conversation as ConversationId, request);
  if (submission?.type !== "input" || (submission.status !== "placed" && submission.status !== "done") || (completed && submission.status !== "done")) return;
  const entry = await tx.entry(submission.entry), msg = entry?.model?.[0];
  if (entry?.conversationId !== conversation || entry.kind !== "ox.user.input" || typeof inputData(entry)?.owner !== "string" || entry.model?.length !== 1 || msg?.role !== "user" || typeof msg.content !== "string"
    || msg.content.length > 4_000 || /(?:^|\n)\[Attachment:/.test(msg.content) || !Number.isFinite(new Date(msg.timestamp).getTime())) return;
  // Match a whole sentence, not a substring. Store a pointer and verify it again on each read.
  const parts = Array.from(new Intl.Segmenter(undefined, { granularity: "sentence" }).segment(msg.content), part => part.segment.trim()).filter(Boolean);
  const matches = parts.filter(p => !/[?？]/u.test(p) && (p === suggestion || p.replace(/[.。]$/u, "") === suggestion));
  if (matches.length !== 1) return;
  const statement = matches[0]!;
  return { entry: submission.entry as number, inputHash: signalHash(msg.content), at: new Date(msg.timestamp).toISOString(),
    statement, otherStatements: parts.some(p => p !== statement && !/[?？]$/u.test(p)), answer: submission.answer };
}
function updated(row: Row, at: string) {
  if (row.revision >= Number.MAX_SAFE_INTEGER) throw new OxError("limit_exceeded", "Discovery item revision limit reached.");
  row.revision++; row.updatedAt = at;
}
const view = (draft: Draft, row: Row): WorkspaceDiscoveryItem => ({ ...draft, icon: draft.kind === "feed" ? "🗂️" : "💡",
  imagePath: null, imageMissing: false, loved: row.loved, hidden: row.hidden, revision: row.revision, createdAt: row.createdAt,
  updatedAt: row.updatedAt, modified: Date.parse(row.updatedAt) });
async function drafts(tx: Tx, { reports, allows, connectors }: QuietScope) {
  const signals = await discoverySignals(tx), goals = await discoveryGoals(tx), todos = await discoveryTodos(tx), watches = await discoveryWatches(tx);
  const result = new Map<string, Draft>();
  const visibility = new Map<number, boolean>();
  const visible = async (id: number) => {
    const cached = visibility.get(id);
    if (cached !== undefined) return cached;
    const allowed = await discoveryChatVisible(tx, id);
    visibility.set(id, allowed);
    return allowed;
  };
  for (const goal of goals) {
    if (goal.completed || !allows("ideas", [])) continue;
    const signal = signals.goals[goal.id];
    let step = signal?.outcomeHash === signalHash(JSON.stringify([goal.title, goal.outcome])) && await visible(signal.conversation) ? signal.step : undefined;
    if (!step) for (const id of goal.todoIds) {
      const todo = todos[id]?.todo;
      if (todo && !todo.completed && (todo.conversationId === undefined || await discoveryChatVisible(tx, todo.conversationId, true))) { step = todo.title; break; }
    }
    if (!step) continue;
    const id = stableID(`quiet:goal:${goal.id}`);
    result.set(id, { id, originId: goal.id, kind: "ideas", provenance: "trackedGoal", name: goal.title, body: step,
      action: step, sources: [], observedAt: goal.updatedAt });
  }
  for (const watch of watches) {
    const signal = signals.watches[watch.id];
    if (!watch.enabled || !signal || signal.hash !== watch.fingerprint || signal.target !== watchTarget(watch.url, watch.selector)
      || signal.url !== watch.resolvedUrl || !discoverySourceURL(watch.url) || !discoverySourceURL(signal.url) || !allows("feed", [watch.url, signal.url])) continue;
    const id = stableID(`quiet:watch:${watch.id}`);
    result.set(id, { id, originId: watch.id, kind: "feed", provenance: "publicWatch", name: watch.name.slice(0, 200),
      body: signal.text, sources: [{ name: (watch.sourceTitle || new URL(signal.url).hostname).slice(0, 200), url: signal.url }],
      action: null, observedAt: signal.at });
  }
  if (reports.length) {
    const inbox = validateInbox(await tx.doc(InboxState)), byId = new Map(goals.map(goal => [goal.id, goal]));
    for (const { goalId, scheduleId, noticeId, conversationId, report } of reports) {
      const goal = byId.get(goalId), notice = inbox.records[noticeId];
      if (!goal || goal.completed || goal.revision !== report.goalRevision || signalHash(goal.notes) !== report.commit.fingerprint
        || !notice || notice.cancelledAt || notice.tag !== `goal-${scheduleId}` || notice.targetUrl !== `/#/c/${conversationId}` || notice.occurredAt !== report.at
        || !notice.body.en.trim() || !report.sources.every(s => discoverySourceURL(s.url)) || !allows("feed", report.sources.map(s => s.url), scheduleId) || !await visible(conversationId)) continue;
      const id = stableID(`quiet:finding:${goal.id}`);
      if ((result.get(id)?.observedAt ?? "") >= report.at) continue;
      result.set(id, { id, originId: goal.id, kind: "feed", provenance: "goalFinding", name: goal.title, body: notice.body.en,
        action: null, sources: report.sources.slice(0, 5).map(s => ({ name: new URL(s.url).hostname, url: s.url })), observedAt: report.at });
    }
  }
  for (const [id, { signal, at, conversation }] of Object.entries(signals.chats)) {
    if (!await visible(conversation)) continue;
    const originId = String(conversation), base = { id, originId, observedAt: at };
    if ("suggestion" in signal) {
      if (allows("ideas", [])) result.set(id, ideaDraft(id, conversation, signal, at));
    } else if (discoverySourceURL(signal.url) && allows("feed", [signal.url])) {
      const name = new URL(signal.url).hostname.slice(0, 200);
      result.set(id, { ...base, kind: "feed", provenance: "chatQuote", name, body: signal.quote, action: null, sources: [{ name, url: signal.url }] });
    }
  }
  const connectorIds = new Set<string>();
  for (const [domain, signal] of Object.entries(signals.connectors)) {
    for (const item of signal.updates.items) {
      const id = stableID(JSON.stringify(["quiet:connector", domain, signal.proof, item.id]));
      connectorIds.add(id);
      if (connectors.get(domain) !== signal.proof || !allows("feed", []) || !discoverySourceURL(item.url)) continue;
      result.set(id, { id, originId: domain, kind: "feed", provenance: "connectorUpdate", name: item.title, body: item.body, action: null,
        sources: [{ name: domain, url: item.url }], observedAt: signal.at });
    }
  }
  return { items: result, owned: new Set([...connectorIds, ...Object.keys(signals.chats), ...goals.flatMap(g => [stableID(`quiet:goal:${g.id}`), stableID(`quiet:finding:${g.id}`)]),
    ...watches.map(w => stableID(`quiet:watch:${w.id}`))]) };
}

export class QuietDiscoveryStore {
  private readonly harness: Harness;
  constructor(harness: Harness) { this.harness = harness; }
  async excludeChat(id: number) {
    await this.harness.commit(async tx => {
      if (!await discoveryChatVisible(tx, id)) return;
      (await tx.doc(ConversationApplicationMetadata, id as ConversationId)).fields.quietDiscoveryExcluded = true;
    }, context);
  }
  async chatEligible(id: number) { return this.harness.commit(tx => discoveryChatVisible(tx, id, true), context); }
  async ideaSource(conversation: number, title: string, turn?: string) {
    return this.harness.commit(async tx => {
      if (!await discoveryChatVisible(tx, conversation, true)) return null;
      const id = chatIdeaID(conversation, title), saved = (await discoverySignals(tx)).chats[id], proof = (await origins(tx))[id];
      if (!saved || saved.conversation !== conversation || !("suggestion" in saved.signal) || saved.signal.title !== title || !proof || proof.conversation !== conversation
        || proof.signalHash !== signalHash(JSON.stringify(saved.signal))) return null;
      const row = (await index(tx))[id];
      if (!row?.available || row.stamp !== sourceStamp(ideaDraft(id, conversation, saved.signal, saved.at))) return null;
      const source = await ideaInput(tx, conversation, proof.request, saved.signal.suggestion, true);
      if (!source || source.answer === undefined || source.entry !== proof.entry || source.inputHash !== proof.inputHash || source.at !== proof.at) return null;
      const chat = conversation as ConversationId, latest = await tx.latestEntryId(chat);
      let turnRelation = !turn && latest === source.answer ? "latestAnswer" : "historical";
      if (turn) {
        const current = await tx.submissionByRequest(chat, turn);
        if (current?.type === "input" && current.status === "placed" && current.entry === latest) {
          const entry = await tx.entry(current.entry);
          if (entry?.kind === "ox.user.input" && entry.conversationId === chat && inputData(entry)?.previousEntry === source.answer) turnRelation = "immediatelyBeforeTurn";
        }
      }
      return { provenance: "userStatement" as const, conversationId: conversation, itemId: id, title: saved.signal.title,
        revision: row.revision, statement: source.statement, entry: source.entry, statedAt: source.at, otherStatements: source.otherStatements, turnRelation,
        editPrecondition: { previous: { title: saved.signal.title, suggestion: saved.signal.suggestion }, expectedRevision: row.revision } };
    }, context);
  }
  async chatQuoteRevision(id: number, url: string) {
    return this.harness.commit(tx => soleChatQuoteRevision(tx, id, url), context);
  }
  async connectorState() {
    const signals = await readDiscoverySignals(this.harness);
    return Object.entries(signals?.connectors ?? {}).map(([domain, s]) => ({ domain, proof: s.proof, checkedAt: s.checkedAt }));
  }
  async saveConnector(domain: string, proof: string, updates: ConnectorUpdates) {
    await this.harness.commit(async tx => {
      const { connectors } = await discoverySignals(tx);
      if (!connectors[domain] && Object.keys(connectors).length >= 50) throw new OxError("limit_exceeded", "Private discovery supports up to 50 connected update sources.");
      const old = connectors[domain], now = new Date().toISOString();
      connectors[domain] = { proof, checkedAt: now, at: old?.proof === proof && JSON.stringify(old.updates) === JSON.stringify(updates) ? old.at : now, updates };
    }, context);
  }
  async withdrawConnector(domain: string, proof: string) {
    await this.harness.commit(async tx => {
      const { connectors } = await discoverySignals(tx);
      if (connectors[domain]?.proof === proof) delete connectors[domain];
    }, context);
  }
  async nominate(conversation: number, value: unknown, { previousQuote, previousIdea, expectedRevision, submission }: {
    previousQuote?: { url: string; revision: number }; previousIdea?: unknown; expectedRevision?: number | null; submission?: string;
  } = {}) {
    const signal: ChatDiscoverySignal = discoveryInput(discoverySignalSchema, value);
    const original = previousIdea === undefined ? undefined : discoveryInput(chatSuggestionSchema, previousIdea);
    if (original && !("suggestion" in signal)) throw ideaConflict();
    if (expectedRevision !== undefined && (!("suggestion" in signal) || (original !== undefined) !== (expectedRevision !== null)))
      throw new OxError("invalid_argument", "For a conditional Idea edit provide its prior wording and revision; for create-only provide null and no prior wording.");
    if ("suggestion" in signal ? !signal.title.trim() || !signal.suggestion.trim() : !discoverySourceURL(signal.url)) throw new OxError("invalid_argument", "Use a concrete suggestion or safe public citation.");
    const proposedID = "suggestion" in signal ? chatIdeaID(conversation, signal.title) : stableID(JSON.stringify(["quiet:chat", conversation, ["feed", new URL(signal.url).href]]));
    const id = original ? chatIdeaID(conversation, original.title) : proposedID;
    return this.harness.commit(async tx => {
      if (!await discoveryChatVisible(tx, conversation, true)) throw new OxError("permission_denied", "The original regular conversation is unavailable or chat-only.");
      if (previousQuote && await soleChatQuoteRevision(tx, conversation, previousQuote.url) !== previousQuote.revision)
        throw new OxError("conflict", "The original Feed source changed or is no longer visible.");
      const { chats } = await discoverySignals(tx), previous = chats[id];
      const old = previous?.signal;
      if (expectedRevision !== undefined) {
        if (expectedRevision === null) {
          if (previous) throw ideaConflict();
        } else {
          const row = (await index(tx))[id];
          if (!previous || !old || !("suggestion" in old) || !row?.available || row.revision !== expectedRevision
            || row.stamp !== sourceStamp(ideaDraft(id, conversation, old, previous.at))) throw ideaConflict();
        }
      }
      if (original && (!old || !("suggestion" in old) || old.title !== original.title || old.suggestion !== original.suggestion
        || id !== proposedID && chats[proposedID])) throw ideaConflict();
      if ("suggestion" in signal) {
        if (old && "suggestion" in old && old.suggestion === signal.suggestion) return false;
        // Only an exact action in this chat is a repeat. Do not merge similar deadlines, destinations or instructions.
        if (Object.values(chats).some(entry => entry.conversation === conversation && "suggestion" in entry.signal && entry.signal.suggestion === signal.suggestion)) {
          if (previous || expectedRevision === null) throw ideaConflict();
          return false;
        }
      } else if (old && JSON.stringify(old) === JSON.stringify(signal)) return false;
      if (!previous && Object.keys(chats).length >= 500) throw new OxError("limit_exceeded", "The private chat discovery limit was reached.");
      const next = "suggestion" in signal && old && "suggestion" in old ? { title: old.title, suggestion: signal.suggestion } : signal;
      if ("suggestion" in next) {
        const refs = await origins(tx);
        const input = submission && submission.length <= 160 ? await ideaInput(tx, conversation, submission, next.suggestion) : undefined;
        if (submission && input) refs[id] = { entry: input.entry, at: input.at, inputHash: input.inputHash, conversation, request: submission, signalHash: signalHash(JSON.stringify(next)) };
        else delete refs[id];
      }
      chats[id] = { conversation, signal: next, at: new Date().toISOString() }; return true;
    }, context);
  }
  async forgetConversation(conversation: number) {
    await this.harness.commit(async tx => {
      const { chats, goals } = await discoverySignals(tx);
      const refs = await origins(tx);
      for (const [id, signal] of Object.entries(chats)) if (signal.conversation === conversation) { delete chats[id]; delete refs[id]; }
      for (const [id, signal] of Object.entries(goals)) if (signal.conversation === conversation) delete goals[id];
    }, context);
  }
  async reconcile(scope: QuietScope) {
    return this.harness.commit(async tx => {
      const { items, owned } = await drafts(tx, scope), rows = await index(tx);
      let changed = false;
      for (const [id, item] of items) {
        const fingerprint = sourceStamp(item), row = rows[id];
        if (row?.available && row.stamp === fingerprint) continue;
        const now = new Date().toISOString();
        if (row) { updated(row, now); row.stamp = fingerprint; row.available = true; }
        else rows[id] = { stamp: fingerprint, available: true, revision: 1, createdAt: item.observedAt, updatedAt: item.observedAt, loved: false, hidden: false };
        changed = true;
      }
      for (const [id, row] of Object.entries(rows)) {
        if (!owned.has(id)) { delete rows[id]; changed = true; }
        else if (row.available && !items.has(id)) { row.available = false; changed = true; }
      }
      return changed;
    }, context);
  }
  async list(kind: DiscoveryKind, hidden: boolean, scope: QuietScope) {
    return this.harness.commit(async tx => {
      const rows = await index(tx);
      return [...(await drafts(tx, scope)).items.values()].flatMap(item => {
        const row = rows[item.id];
        return row?.available && item.kind === kind && row.stamp === sourceStamp(item) && (hidden || !row.hidden) ? [view(item, row)] : [];
      });
    }, context);
  }
  async update(kind: DiscoveryKind, id: string, value: unknown, scope: QuietScope) {
    const input = discoveryInput(discoveryPatchSchema, value);
    return this.harness.commit(async tx => {
      const rows = await index(tx), row = rows[id];
      if (!row) return null;
      const item = (await drafts(tx, scope)).items.get(id);
      if (!row.available || !item || item.kind !== kind) throw new OxError("not_found", "This discovery source is no longer available.");
      if (row.revision !== input.expectedRevision || row.stamp !== sourceStamp(item)) throw new OxError("conflict", "This item changed. Refresh before saving.");
      updated(row, new Date().toISOString());
      Object.assign(row, { hidden: input.hidden ?? row.hidden, loved: input.loved ?? row.loved });
      return view(item, row);
    }, context);
  }
  async contentSnapshot() {
    const [stored, signals, sources] = await Promise.all([this.harness.snapshot(Index, context), readDiscoverySignals(this.harness), this.harness.snapshot(Origins, context)]);
    if (sources && !Value.Check(originsSchema, sources)) throw new OxError("unavailable", "The original Idea source index is invalid.");
    return stored || signals || sources ? { rows: stored?.rows ?? {}, signals, ...(sources && Object.keys(sources.items).length ? { origins: sources.items } : {}) } : undefined;
  }
  async contentEmpty() {
    return this.harness.commit(async tx => {
      const signals = await discoverySignals(tx);
      return !Object.keys(await index(tx)).length && !Object.keys(await origins(tx)).length && Object.values(signals).every(group => !Object.keys(group).length);
    }, context);
  }
}

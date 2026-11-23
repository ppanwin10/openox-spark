import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc, type Harness, type Tx } from "@earendil-works/pi-durable";
import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { OxError } from "./functions";
import { enqueueNotice, InboxState, type InboxDraft, type InboxNotice } from "./inbox";
import { contentRevision } from "./review";
import { watchDraftSchema, watchPatchSchema, watchSchema, type WatchView } from "./watch-contracts";
import { discoverySignals, discoverySourceURL, watchTarget } from "./discovery-signals";

export { watchDraftSchema, watchPatchSchema, watchRevisionSchema } from "./watch-contracts";
export type { WatchView } from "./watch-contracts";

const strict = { additionalProperties: false };
const identity = watchSchema.properties.id, revision = watchSchema.properties.revision;
type Watch = Static<typeof watchSchema>;
export type WatchObservation = { fingerprint: string; characters: number; sourceTitle: string; resolvedUrl: string };
const recordSchema = Type.Object({
  watch: watchSchema, claim: Type.Union([Type.Object({ id: identity, revision }, strict), Type.Null()]),
}, strict);
const stateSchema = Type.Object({
  records: Type.Record(Type.String(), recordSchema),
  requests: Type.Record(Type.String(), Type.Object({ fingerprint: Type.String(), id: identity }, strict)),
}, strict);
type State = Static<typeof stateSchema>;
type Record = Static<typeof recordSchema>;
const initial = (): State => ({ records: {}, requests: {} });
const Watches = defineDoc<State>({
  kind: "ox.watches", version: 1, scope: "session", initial,
  checkpointWhen: (_, __, info) => info.deltasSinceBase >= 31,
});
const context = BACKGROUND_CONTEXT;
const conflict = () => new OxError("conflict", "This watch changed or a check is already running. Read its current state before trying again.");
const invalid = (message: string) => new OxError("invalid_argument", message, "Choose a public URL, one optional CSS scope and an interval of 5-1,440 minutes.");
const nextTime = (watch: Watch, now: string) => watch.enabled ? new Date(Date.parse(now) + watch.intervalMinutes * 60_000).toISOString() : null;
const presented = (record: Record): WatchView => Value.Clone({ ...record.watch, checking: record.claim !== null });
const emptyObservation = () => ({ fingerprint: null, characters: null, sourceTitle: null, resolvedUrl: null,
  lastOutcome: "never" as const, lastCheckedAt: null, lastSuccessAt: null, lastChangedAt: null, lastError: null });

export function watchInput<T extends TSchema>(schema: T, value: unknown): Static<T> {
  if (!Value.Check(schema, value)) throw invalid([...Value.Errors(schema, value)].slice(0, 3).map(error => `${error.instancePath || "/"} ${error.message}`).join("; "));
  return value;
}
function validate(state: State) {
  if (!Value.Check(stateSchema, state) || Object.entries(state.records).some(([id, record]) => id !== record.watch.id
    || record.claim !== null && record.claim.revision !== record.watch.revision)) {
    throw new OxError("unavailable", "The public-page watch store is invalid. No empty replacement was created.");
  }
  return state;
}
function normalize(input: Static<typeof watchDraftSchema>) {
  const name = input.name.trim(), url = input.url.trim(), selector = input.selector?.trim() || null;
  if (!name || !url) throw invalid("Enter a watch name and public URL.");
  return { name, url, selector, intervalMinutes: input.intervalMinutes, enabled: input.enabled ?? false };
}
function advance(watch: Watch, now: string) {
  if (watch.revision >= Number.MAX_SAFE_INTEGER) throw new OxError("limit_exceeded", "This watch has reached its revision limit.");
  watch.revision++; watch.updatedAt = now;
}

export async function discoveryWatches(tx: Tx) { return Object.values(validate(await tx.doc(Watches)).records).map(record => record.watch); }
export class WatchStore {
  private readonly harness: Harness;
  constructor(harness: Harness) { this.harness = harness; }
  async contentEmpty() {
    const state = validate(await this.harness.snapshot(Watches, context) ?? initial());
    return !Object.keys(state.records).length && !Object.keys(state.requests).length;
  }

  async list() {
    const state = validate(await this.harness.snapshot(Watches, context) ?? initial());
    return Object.values(state.records).map(presented).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }
  private owned(state: State, id: string) {
    if (!Object.hasOwn(state.records, id)) throw new OxError("not_found", "This watch is unavailable in the current workspace.");
    return state.records[id]!;
  }
  async get(id: string) {
    return presented(this.owned(validate(await this.harness.snapshot(Watches, context) ?? initial()), id));
  }
  async create(value: unknown, key: string) {
    if (!/^[A-Za-z0-9._:-]{1,160}$/.test(key)) throw invalid("Provide a stable Idempotency-Key for watch creation.");
    const draft = normalize(watchInput(watchDraftSchema, value)), request = contentRevision(key), fingerprint = contentRevision(JSON.stringify(draft));
    return this.harness.commit(async tx => {
      const state = validate(await tx.doc(Watches)), previous = state.requests[request];
      if (previous) {
        if (previous.fingerprint !== fingerprint || !Object.hasOwn(state.records, previous.id)) throw new OxError("conflict", "This request key belongs to a different or deleted watch.");
        return { watch: presented(state.records[previous.id]!), replayed: true };
      }
      if (Object.keys(state.records).length >= 20 || Object.keys(state.requests).length >= 2_000) throw new OxError("limit_exceeded", "This preview's watch or creation-receipt limit was reached.");
      const id = crypto.randomUUID(), now = new Date().toISOString();
      const watch: Watch = { id, ...draft, revision: 1, createdAt: now, updatedAt: now, ...emptyObservation(), nextCheckAt: draft.enabled ? now : null };
      state.records[id] = { watch, claim: null }; state.requests[request] = { id, fingerprint };
      return { watch: presented(state.records[id]!), replayed: false };
    }, context);
  }
  async update(id: string, value: unknown) {
    const input = watchInput(watchPatchSchema, value);
    return this.harness.commit(async tx => {
      const record = this.owned(validate(await tx.doc(Watches)), id), watch = record.watch;
      if (watch.revision !== input.expectedRevision) throw conflict();
      const next = normalize({ name: input.name ?? watch.name, url: input.url ?? watch.url,
        selector: input.selector === undefined ? watch.selector : input.selector,
        intervalMinutes: input.intervalMinutes ?? watch.intervalMinutes, enabled: input.enabled ?? watch.enabled });
      const targetChanged = next.url !== watch.url || next.selector !== watch.selector, resumed = !watch.enabled && next.enabled;
      const now = new Date().toISOString();
      advance(watch, now); record.claim = null;
      if (targetChanged || !next.enabled) delete (await discoverySignals(tx)).watches[id];
      Object.assign(watch, next, targetChanged ? emptyObservation() : {});
      watch.nextCheckAt = !watch.enabled ? null : targetChanged || resumed ? now : nextTime(watch, now);
      return presented(record);
    }, context);
  }
  async delete(id: string, expectedRevision: number) {
    await this.harness.commit(async tx => {
      const state = validate(await tx.doc(Watches)), record = this.owned(state, id);
      if (record.watch.revision !== expectedRevision) throw conflict();
      delete state.records[id];
      delete (await discoverySignals(tx)).watches[id];
    }, context);
    return { deleted: true as const };
  }
  async claim(id: string, expectedRevision: number, automatic: boolean) {
    return this.harness.commit(async tx => {
      const record = this.owned(validate(await tx.doc(Watches)), id), watch = record.watch, now = new Date().toISOString();
      if (watch.revision !== expectedRevision || record.claim !== null) throw conflict();
      if (automatic && (!watch.enabled || watch.nextCheckAt === null || watch.nextCheckAt > now)) return null;
      advance(watch, now); record.claim = { id: crypto.randomUUID(), revision: watch.revision };
      return { token: record.claim.id, watch: presented(record) };
    }, context);
  }
  async finish(id: string, token: string, result: WatchObservation | { error: string }, make: (watch: WatchView, noticeId: string) => InboxDraft, excerpt?: string) {
    return this.harness.commit(async tx => {
      const state = validate(await tx.doc(Watches)), record = Object.hasOwn(state.records, id) ? state.records[id]! : null;
      if (!record || record.claim?.id !== token) return { discarded: true as const, watch: null, notice: null };
      const watch = record.watch, now = new Date().toISOString();
      let notice: InboxNotice | null = null;
      if ("error" in result) { watch.lastOutcome = "failed"; watch.lastError = result.error.slice(0, 2_000); }
      else {
        const changed = watch.fingerprint !== null && watch.fingerprint !== result.fingerprint;
        if (watch.enabled && excerpt && discoverySourceURL(watch.url) && discoverySourceURL(result.resolvedUrl)) {
          const signals = await discoverySignals(tx), target = watchTarget(watch.url, watch.selector), prior = signals.watches[id];
          if (!prior || prior.hash !== result.fingerprint || prior.target !== target || prior.url !== result.resolvedUrl)
            signals.watches[id] = { hash: result.fingerprint, target, url: result.resolvedUrl, text: excerpt.slice(0, 800), at: now };
        }
        if (changed) {
          notice = Value.Clone(enqueueNotice(await tx.doc(InboxState), make(presented(record), crypto.randomUUID()), now));
          watch.lastChangedAt = now;
        }
        watch.lastOutcome = watch.fingerprint === null ? "baseline" : changed ? "changed" : "unchanged";
        Object.assign(watch, result, { lastSuccessAt: now, lastError: null });
      }
      advance(watch, now); record.claim = null; watch.lastCheckedAt = now; watch.nextCheckAt = nextTime(watch, now);
      validate(state);
      return { discarded: false as const, watch: presented(record), notice };
    }, context);
  }
  async recover() {
    await this.harness.commit(async tx => {
      const state = validate(await tx.doc(Watches)), now = new Date().toISOString();
      for (const record of Object.values(state.records)) if (record.claim !== null) {
        advance(record.watch, now); record.claim = null;
        record.watch.lastOutcome = "interrupted"; record.watch.lastError = "The check was interrupted. No fresh observation was recorded.";
        record.watch.nextCheckAt = nextTime(record.watch, now);
      }
    }, context);
  }
}

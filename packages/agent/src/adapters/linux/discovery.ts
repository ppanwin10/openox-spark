import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc, type Harness, type Tx } from "@earendil-works/pi-durable";
import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { canonical } from "../../core/file-paths";
import { ProfileFileState, type ProfileFileRecord } from "../../profile/file-store";
import { OxError } from "./functions";
import { publicLibraryFile } from "./library";
import { discoveryPatchSchema, discoveryPromptSchema, discoveryRecordSchema, feedPublishSchema, generationDraftSchema, generationSchema, ideaPublishSchema,
  type DiscoveryItem, type DiscoveryKind, type Generation } from "./discovery-contracts";

const strict = { additionalProperties: false };
const stateSchema = Type.Object({
  prompt: Type.Object({ text: Type.String({ minLength: 1, maxLength: 2_000 }), revision: Type.Integer({ minimum: 1 }) }, strict),
  items: Type.Record(Type.String(), discoveryRecordSchema), generations: Type.Record(Type.String(), generationSchema),
  current: Type.Object({ feed: Type.Union([Type.String(), Type.Null()]), ideas: Type.Union([Type.String(), Type.Null()]) }, strict),
  requests: Type.Record(Type.String(), Type.Object({ id: Type.String(), fingerprint: Type.String() }, strict)),
  publications: Type.Record(Type.String(), Type.Object({ fingerprint: Type.String(), ids: Type.Array(Type.String()),
    created: Type.Integer({ minimum: 0 }), updated: Type.Integer({ minimum: 0 }) }, strict)),
}, strict);
type State = Static<typeof stateSchema>;
type Record = Static<typeof discoveryRecordSchema>;
const initial = (): State => ({ prompt: { text: "Make me a feed about my interests. Keep the tone clear and direct. Ensure it is quick to skim. Try to avoid clickbait.", revision: 1 },
  items: {}, generations: {}, current: { feed: null, ideas: null }, requests: {}, publications: {} });
const Discovery = defineDoc<State>({ kind: "ox.discovery", version: 1, scope: "session", initial, checkpointWhen: (_, __, info) => info.deltasSinceBase >= 31 });
const context = BACKGROUND_CONTEXT;
const hash = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex");
const invalid = (message: string) => new OxError("invalid_argument", message, "Use declared bounded fields, safe sources and existing public artifacts.");
const conflict = () => new OxError("conflict", "This Feed or Idea changed. Read the current revision before saving.");
export function discoveryInput<T extends TSchema>(schema: T, value: unknown): Static<T> {
  if (!Value.Check(schema, value)) throw invalid([...Value.Errors(schema, value)].slice(0, 3).map(error => `${error.instancePath || "/"} ${error.message}`).join("; "));
  return value;
}
function validated(state: State) {
  if (!Value.Check(stateSchema, state) || Object.entries(state.items).some(([id, item]) => id !== item.id)
    || Object.entries(state.generations).some(([id, item]) => id !== item.id)) throw new OxError("unavailable", "The Feed/Ideas metadata is invalid. No empty replacement was created.");
  return state;
}
function requestKey(key: string) {
  if (!/^[A-Za-z0-9._:-]{1,160}$/.test(key)) throw invalid("Provide a stable Idempotency-Key of 1-160 ASCII letters, numbers, dots, colons, underscores or hyphens.");
  return hash(key);
}
const generationIntent = (kind: DiscoveryKind, input: { expectedRevision: number; replaceUnknown?: boolean }) =>
  hash(JSON.stringify([kind, { expectedRevision: input.expectedRevision, replaceUnknown: input.replaceUnknown ?? false }]));
function sourceURL(value: string) {
  let url: URL;
  try { url = new URL(value); } catch { throw invalid("Use an absolute http(s) source URL."); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw invalid("Source URLs must be safe http(s) addresses without credentials.");
  for (const [name] of url.searchParams) if (/^(api[-_]?key|access[-_]?token|password|secret|auth[-_]?token)$/i.test(name)) throw invalid("Do not put credentials in source URLs.");
  for (const [name] of new URLSearchParams(url.hash.slice(1))) if (/^(access[-_]?token|password|secret|auth[-_]?token)$/i.test(name)) throw invalid("Do not put credentials in source URL fragments.");
  return url.href;
}
function sourceIdentity(value: string) { const url = new URL(value); url.hash = ""; return url.href; }
export function discoveryPublication(kind: DiscoveryKind, value: unknown) {
  const draft = kind === "feed" ? discoveryInput(feedPublishSchema, value) : discoveryInput(ideaPublishSchema, value);
  for (const item of draft.items) for (const source of item.sources ?? []) {
    if (!source.name.trim()) throw invalid("Enter a source name.");
    sourceURL(source.url);
  }
  return draft;
}
async function image(tx: Tx, path?: string) {
  if (!path) return null;
  let clean: string;
  try { clean = canonical(path); } catch { throw invalid("Use a canonical public image artifact path."); }
  const files = await tx.doc(ProfileFileState), found = Object.values(files.files).find(file => file.path === clean && publicLibraryFile(file, files.deletedConversations));
  if (!found || !/\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i.test(clean)) throw invalid("The image must be an existing public original-owner image artifact.");
  return found.id;
}
function generation(state: State, id: string) {
  if (!Object.hasOwn(state.generations, id)) throw new OxError("not_found", "This generation request is unavailable.");
  return state.generations[id]!;
}
export class DiscoveryStore {
  private readonly harness: Harness;
  constructor(harness: Harness) { this.harness = harness; }
  private async state() { return validated(await this.harness.snapshot(Discovery, context) ?? initial()); }
  private async files() {
    const files = await this.harness.snapshot(ProfileFileState, context), references = new Map<string, ProfileFileRecord>();
    for (const file of Object.values(files?.files ?? {})) if (publicLibraryFile(file, files?.deletedConversations ?? [])) {
      for (const id of [file.id, ...(file.aliases ?? [])]) references.set(id, file);
    }
    return references;
  }
  private view(item: Record, files: Map<string, ProfileFileRecord>): DiscoveryItem {
    const { dedupe: _dedupe, imageFileId, ...fields } = item, file = imageFileId ? files.get(imageFileId) : undefined;
    return { ...fields, imagePath: file?.path ?? null, imageMissing: imageFileId !== null && !file, provenance: "modelProvided", modified: Date.parse(item.updatedAt) };
  }
  async list(kind: DiscoveryKind, hidden = false) {
    const [state, files] = await Promise.all([this.state(), this.files()]);
    return Object.values(state.items).filter(item => item.kind === kind && (hidden || !item.hidden)).map(item => this.view(item, files));
  }
  async prompt() { return (await this.state()).prompt; }
  async setPrompt(value: unknown) {
    const input = discoveryInput(discoveryPromptSchema, value);
    return this.harness.commit(async tx => {
      const state = validated(await tx.doc(Discovery));
      if (state.prompt.revision !== input.expectedRevision || state.prompt.revision >= Number.MAX_SAFE_INTEGER) throw conflict();
      if (!input.text.trim()) throw invalid("Enter a Feed prompt.");
      const prompt = { text: input.text, revision: state.prompt.revision + 1 };
      state.prompt = prompt;
      return prompt;
    }, context);
  }
  async update(kind: DiscoveryKind, id: string, value: unknown) {
    const input = discoveryInput(discoveryPatchSchema, value);
    await this.harness.commit(async tx => {
      const state = validated(await tx.doc(Discovery)), item = state.items[id];
      if (!item || item.kind !== kind) throw new OxError("not_found", "This Feed item or Idea is unavailable.");
      if (item.revision !== input.expectedRevision || item.revision >= Number.MAX_SAFE_INTEGER) throw conflict();
      Object.assign(item, { loved: input.loved ?? item.loved, hidden: input.hidden ?? item.hidden, revision: item.revision + 1, updatedAt: new Date().toISOString() });
    }, context);
    const [state, files] = await Promise.all([this.state(), this.files()]);
    return this.view(state.items[id]!, files);
  }
  async publish(kind: DiscoveryKind, value: unknown, key: string, caller: number) {
    const draft = discoveryPublication(kind, value);
    const request = hash(`${kind}:${key}`), fingerprint = hash(JSON.stringify(draft));
    if (!key) throw invalid("This publication has no original request identity.");
    const saved = await this.harness.commit(async tx => {
      const state = validated(await tx.doc(Discovery)), old = state.publications[request];
      if (old) {
        if (old.fingerprint !== fingerprint) throw conflict();
        return { ids: [...old.ids], created: old.created, updated: old.updated, replayed: true };
      }
      const requested = draft.generationId ? generation(state, draft.generationId) : undefined;
      if (requested && (requested.kind !== kind || requested.conversationId !== caller)) throw invalid("Publish only to this conversation's generation request.");
      if (Object.keys(state.publications).length >= 5_000) throw new OxError("limit_exceeded", "The publication receipt limit was reached.");
      const ids: string[] = [], seen = new Set<string>(); let created = 0, updated = 0;
      for (const raw of draft.items) {
        const name = raw.name.trim(), body = raw.body.trim();
        if (!name || !body) throw invalid("Enter an item name and body.");
        const sources = (raw.sources ?? []).map(source => ({ name: source.name.trim(), url: sourceURL(source.url) }));
        const action = "action" in raw ? raw.action.trim() : null;
        if (action === "") throw invalid("An Idea needs an explicit proposed action.");
        const dedupe = hash(JSON.stringify([kind, name.toLocaleLowerCase(), sources.map(source => sourceIdentity(source.url)).sort(), kind === "ideas" ? action : null]));
        if (seen.has(dedupe)) continue;
        seen.add(dedupe);
        const previous = Object.values(state.items).find(item => item.dedupe === dedupe), id = previous?.id ?? crypto.randomUUID();
        if (!previous && Object.values(state.items).filter(item => item.kind === kind).length >= 500) throw new OxError("limit_exceeded", "The Feed or Ideas item limit was reached.");
        if (previous?.revision === Number.MAX_SAFE_INTEGER) throw conflict();
        const now = new Date().toISOString();
        state.items[id] = { id, kind, name, body, sources, action, icon: raw.icon ?? (kind === "feed" ? "🗂️" : "💡"),
          imageFileId: await image(tx, raw.imagePath), dedupe, loved: previous?.loved ?? false, hidden: previous?.hidden ?? false,
          revision: (previous?.revision ?? 0) + 1, createdAt: previous?.createdAt ?? now, updatedAt: now };
        ids.push(id); if (previous) updated++; else created++;
      }
      if (requested) { requested.publishedAt = new Date().toISOString(); requested.publicationCount = ids.length; }
      state.publications[request] = { fingerprint, ids, created, updated };
      return { ids, created, updated, replayed: false };
    }, context);
    const [state, files] = await Promise.all([this.state(), this.files()]);
    return { items: saved.ids.map(id => this.view(state.items[id]!, files)), created: saved.created, updated: saved.updated, replayed: saved.replayed };
  }
  async replay(kind: DiscoveryKind, key: string, value: unknown) {
    const input = discoveryInput(generationDraftSchema, value), state = await this.state(), previous = state.requests[requestKey(key)];
    if (!previous) return null;
    if (previous.fingerprint !== generationIntent(kind, input)) throw conflict();
    return { ...generation(state, previous.id) };
  }
  async prepare(kind: DiscoveryKind, key: string, value: unknown) {
    const input = discoveryInput(generationDraftSchema, value), request = requestKey(key), fingerprint = generationIntent(kind, input);
    return this.harness.commit(async tx => {
      const state = validated(await tx.doc(Discovery)), previous = state.requests[request];
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw conflict();
        return generation(state, previous.id);
      }
      if (input.expectedRevision !== (kind === "feed" ? state.prompt.revision : 1)) throw conflict();
      if (Object.keys(state.requests).length >= 5_000) throw new OxError("limit_exceeded", "The generation receipt limit was reached.");
      const id = crypto.randomUUID();
      const item: Generation = { id, kind, prompt: kind === "feed" ? state.prompt.text : "Suggest useful new ways to help using only context the user has chosen to share.",
        promptRevision: input.expectedRevision, conversationId: null, createdAt: new Date().toISOString(), dispatchAttemptedAt: null, submittedAt: null,
        cancelRequestedAt: null, publishedAt: null, publicationCount: null, error: null };
      state.generations[id] = item; state.requests[request] = { id, fingerprint }; state.current[kind] = id;
      return item;
    }, context);
  }
  async getGeneration(id: string) { return generation(await this.state(), id); }
  async current(kind: DiscoveryKind) {
    const state = await this.state(), id = state.current[kind];
    return id ? generation(state, id) : null;
  }
  async bind(id: string, conversationId: number) {
    await this.harness.commit(async tx => {
      const item = generation(validated(await tx.doc(Discovery)), id);
      if (item.conversationId !== null && item.conversationId !== conversationId) throw conflict();
      item.conversationId = conversationId;
    }, context);
  }
  async submitted(id: string) {
    await this.harness.commit(async tx => { generation(validated(await tx.doc(Discovery)), id).submittedAt = new Date().toISOString(); }, context);
  }
  async dispatchAttempted(id: string) {
    await this.harness.commit(async tx => { generation(validated(await tx.doc(Discovery)), id).dispatchAttemptedAt = new Date().toISOString(); }, context);
  }
  async cancelRequested(id: string) {
    await this.harness.commit(async tx => { generation(validated(await tx.doc(Discovery)), id).cancelRequestedAt = new Date().toISOString(); }, context);
  }
  async failed(id: string, error: string) {
    await this.harness.commit(async tx => { generation(validated(await tx.doc(Discovery)), id).error = error.slice(0, 2_000); }, context);
  }
}

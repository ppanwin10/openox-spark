import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc, type Harness, type Tx } from "@earendil-works/pi-durable";
import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { canonical } from "../../core/file-paths";
import { conversationRecordPath, ProfileFileState, publicDocument, type ProfileFileRecord } from "../../profile/file-store";
import { OxError } from "./functions";
import { podcastPatchSchema, spaceDraftSchema, spacePatchSchema, spaceRecordSchema, type LibraryCategory, type LibraryItem, type Space } from "./library-contracts";

const stateSchema = Type.Object({
  spaces: Type.Record(Type.String(), spaceRecordSchema),
  podcasts: Type.Record(Type.String(), Type.Object({ fileId: Type.String(), name: Type.String(), podcast: Type.Boolean(),
    revision: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }) }, { additionalProperties: false })),
  requests: Type.Record(Type.String(), Type.Object({ id: Type.String({ format: "uuid" }), fingerprint: Type.String() }, { additionalProperties: false })),
}, { additionalProperties: false });
type State = Static<typeof stateSchema>;
type SpaceRecord = Static<typeof spaceRecordSchema>;
const initial = (): State => ({ spaces: {}, podcasts: {}, requests: {} });
const Library = defineDoc<State>({ kind: "ox.library", version: 1, scope: "session", initial,
  checkpointWhen: (_, __, info) => info.deltasSinceBase >= 31 });
const context = BACKGROUND_CONTEXT;
const images = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i, videos = /\.(mp4|mov|webm|m4v|mkv)$/i, audios = /\.(mp3|wav|m4a|aac|ogg|opus|flac)$/i;
const hash = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex");
const invalid = (message: string) => new OxError("invalid_argument", message, "Use declared fields and existing public Profile artifacts, not internal app/system paths.");
const conflict = () => new OxError("conflict", "This Library item changed. Read the current revision before saving again.");
export function libraryInput<T extends TSchema>(schema: T, value: unknown): Static<T> {
  if (!Value.Check(schema, value)) throw invalid([...Value.Errors(schema, value)].slice(0, 3).map(error => `${error.instancePath || "/"} ${error.message}`).join("; "));
  return value;
}
function validate(state: State) {
  if (!Value.Check(stateSchema, state) || Object.entries(state.spaces).some(([id, item]) => id !== item.id)
    || Object.entries(state.podcasts).some(([id, item]) => id !== item.fileId)) {
    throw new OxError("unavailable", "The Library metadata is invalid. No empty replacement was created.");
  }
  return state;
}
function publicFile(file: ProfileFileRecord, deleted: number[]) {
  return !file.hidden && !conversationRecordPath(file.path) && !/^(app|history|chats|tmp|repositories|mounts)(\/|$)/.test(file.path)
    && !deleted.some(id => file.path.startsWith(`conversations/${id}/`));
}
function entryPath(value: string) {
  let path: string;
  try { path = canonical(value); } catch { throw invalid("Use a canonical Profile HTML artifact path."); }
  if (!/\.html?$/i.test(path) || publicDocument(path) || /^(app|skills|history|chats|tmp|repositories|mounts)(\/|$)/.test(path)) {
    throw invalid("A Space requires a regular public HTML artifact, not an internal app or system document.");
  }
  return path;
}
async function entry(tx: Tx, path: string) {
  const files = await tx.doc(ProfileFileState), file = Object.values(files.files).find(file => file.path === path && publicFile(file, files.deletedConversations));
  if (!file) throw invalid("The Space entry artifact is unavailable in this Profile.");
  return file;
}
function owned(state: State, id: string) {
  if (!Object.hasOwn(state.spaces, id)) throw new OxError("not_found", "This Space is unavailable in the current Profile.");
  return state.spaces[id]!;
}
function check(item: { revision: number }, revision: number) {
  if (item.revision !== revision || item.revision >= Number.MAX_SAFE_INTEGER) throw conflict();
}
export class LibraryStore {
  private readonly harness: Harness;
  constructor(harness: Harness) { this.harness = harness; }
  private async source() {
    const [library, files] = await Promise.all([this.harness.snapshot(Library, context), this.harness.snapshot(ProfileFileState, context)]);
    const state = validate(library ?? initial());
    const visible = Object.values(files?.files ?? {}).filter(file => publicFile(file, files?.deletedConversations ?? []));
    const references = new Map<string, ProfileFileRecord>();
    for (const file of visible) for (const reference of [file.id, ...(file.aliases ?? [])]) references.set(reference, file);
    return { state, files: references, records: visible };
  }
  private view(item: SpaceRecord, files: Map<string, ProfileFileRecord>): Space {
    const file = files.get(item.fileId);
    return { ...item, entryPath: file?.path ?? null, missing: !file, modified: file?.mtime ?? null };
  }
  async listSpaces() {
    const { state, files } = await this.source();
    return Object.values(state.spaces).map(item => this.view(item, files));
  }
  async getSpace(id: string) {
    const { state, files } = await this.source();
    return this.view(owned(state, id), files);
  }
  async items(category: LibraryCategory): Promise<LibraryItem[]> {
    const { state, files, records } = await this.source(), entries = new Set(Object.values(state.spaces).map(item => item.fileId));
    const tagOf = (file: ProfileFileRecord) => [file.id, ...(file.aliases ?? [])].map(id => state.podcasts[id]).find(Boolean);
    const item = (file: ProfileFileRecord, kind: LibraryCategory): LibraryItem => ({ id: tagOf(file)?.fileId ?? file.aliases?.[0] ?? file.id,
      name: file.path.split("/").at(-1)!, path: file.path, size: file.size, modified: file.mtime, sha256: file.sha256, category: kind,
      missing: false, tagRevision: tagOf(file)?.revision ?? 0 });
    if (category === "podcasts") return Object.values(state.podcasts).filter(tag => tag.podcast).map(tag => {
      const file = files.get(tag.fileId);
      return file ? item(file, category) : { id: tag.fileId, name: tag.name, path: null, size: null, modified: null, sha256: null, category, missing: true, tagRevision: tag.revision };
    });
    return records.filter(file => {
      if (publicDocument(file.path)) return category === "system";
      if (category === "system" || [file.id, ...(file.aliases ?? [])].some(id => entries.has(id)) || tagOf(file)?.podcast) return false;
      return category === "images" ? images.test(file.path) : category === "videos" ? videos.test(file.path)
        : !images.test(file.path) && !videos.test(file.path);
    }).map(file => item(file, category));
  }
  async createSpace(value: unknown, key: string) {
    if (!/^[A-Za-z0-9._:-]{1,160}$/.test(key)) throw invalid("Provide a stable Idempotency-Key of 1-160 ASCII letters, numbers, dots, colons, underscores or hyphens.");
    const input = libraryInput(spaceDraftSchema, value), name = input.name.trim(), path = entryPath(input.entryPath);
    if (!name) throw invalid("Enter a Space name.");
    const draft = { name, description: input.description ?? "", entryPath: path, pinned: input.pinned ?? false }, request = hash(key), fingerprint = hash(JSON.stringify(draft));
    const saved = await this.harness.commit(async tx => {
      const state = validate(await tx.doc(Library)), previous = state.requests[request];
      if (previous) {
        if (previous.fingerprint !== fingerprint || !Object.hasOwn(state.spaces, previous.id)) throw new OxError("conflict", "This request belongs to a different or removed Space.");
        return { id: previous.id, replayed: true };
      }
      if (Object.keys(state.spaces).length >= 500 || Object.keys(state.requests).length >= 5_000) throw new OxError("limit_exceeded", "This preview's Space or create-receipt limit was reached.");
      const file = await entry(tx, path), id = crypto.randomUUID(), now = new Date().toISOString();
      state.spaces[id] = { id, name, description: draft.description, fileId: file.id, pinned: draft.pinned, revision: 1, createdAt: now, updatedAt: now };
      state.requests[request] = { id, fingerprint };
      return { id, replayed: false };
    }, context);
    return { space: await this.getSpace(saved.id), replayed: saved.replayed };
  }
  async updateSpace(id: string, value: unknown) {
    const patch = libraryInput(spacePatchSchema, value);
    await this.harness.commit(async tx => {
      const item = owned(validate(await tx.doc(Library)), id); check(item, patch.expectedRevision);
      const name = (patch.name ?? item.name).trim();
      if (!name) throw invalid("Enter a Space name.");
      const fileId = patch.entryPath === undefined ? item.fileId : (await entry(tx, entryPath(patch.entryPath))).id;
      Object.assign(item, { name, description: patch.description ?? item.description, pinned: patch.pinned ?? item.pinned,
        fileId, revision: item.revision + 1, updatedAt: new Date().toISOString() });
    }, context);
    return this.getSpace(id);
  }
  async deleteSpace(id: string, revision: number) {
    await this.harness.commit(async tx => {
      const state = validate(await tx.doc(Library)); check(owned(state, id), revision); delete state.spaces[id];
    }, context);
    return { deleted: true as const };
  }
  async tagPodcast(fileId: string, value: unknown) {
    const patch = libraryInput(podcastPatchSchema, value);
    return this.harness.commit(async tx => {
      const state = validate(await tx.doc(Library)), source = await tx.doc(ProfileFileState);
      const file = Object.values(source.files).find(file => file.id === fileId || file.aliases?.includes(fileId));
      const key = file ? [file.id, ...(file.aliases ?? [])].find(id => state.podcasts[id]) ?? file.aliases?.[0] ?? file.id : fileId;
      const previous = state.podcasts[key];
      if ((previous?.revision ?? 0) !== patch.expectedRevision || previous && previous.revision >= Number.MAX_SAFE_INTEGER) throw conflict();
      if ((!file || !publicFile(file, source.deletedConversations)) && (!previous || patch.podcast)) throw invalid("This Library file is unavailable.");
      if (patch.podcast && (!file || !audios.test(file.path))) throw invalid("Only an existing audio artifact can be classified as a podcast.");
      if (!previous && Object.keys(state.podcasts).length >= 1_000) throw new OxError("limit_exceeded", "This preview's explicit audio-classification limit was reached.");
      const revision = (previous?.revision ?? 0) + 1;
      state.podcasts[key] = { fileId: key, name: file?.path.split("/").at(-1) ?? previous!.name, podcast: patch.podcast, revision };
      return { fileId: key, podcast: patch.podcast, revision };
    }, context);
  }
}

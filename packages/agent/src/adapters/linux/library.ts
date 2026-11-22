import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc, type Harness, type Tx } from "@earendil-works/pi-durable";
import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { canonical } from "../../core/file-paths";
import { conversationRecordPath, ProfileFileState, publicDocument, removableProfileFile, type ProfileFileRecord } from "../../profile/file-store";
import { OxError } from "./functions";
import { podcastPatchSchema, spaceDraftSchema, spacePatchSchema, spaceRecordSchema, type LibraryCategory, type LibraryItem, type Space, type SpaceDataGrant, type SpaceConnectionGrant } from "./library-contracts";

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
const artworkSchema = Type.Object({ icons: Type.Record(Type.String(), Type.String({ minLength: 1, maxLength: 512 })) }, { additionalProperties: false });
type Artwork = Static<typeof artworkSchema>;
// Keep the original strict ox.library v1 document readable if the Host is downgraded.
const SpaceArtwork = defineDoc<Artwork>({ kind: "ox.space-artwork", version: 1, scope: "session", initial: () => ({ icons: {} }),
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
export function publicLibraryFile(file: ProfileFileRecord, deleted: number[]) {
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
  const files = await tx.doc(ProfileFileState), file = Object.values(files.files).find(file => file.path === path && publicLibraryFile(file, files.deletedConversations));
  if (!file) throw invalid("The Space entry artifact is unavailable in this Profile.");
  return file;
}
function artworkIcons(state: Artwork) {
  if (!Value.Check(artworkSchema, state)) throw new OxError("unavailable", "The Space artwork metadata is invalid. No replacement was created.");
  return state.icons;
}
function eligibleIcon(file: ProfileFileRecord, deleted: number[]) {
  return removableProfileFile(file, deleted) && /\.(?:png|jpe?g|webp|gif|svg)$/i.test(file.path) && file.size > 0 && file.size <= 2 * 1024 * 1024;
}
async function setArtwork(tx: Tx, id: string, path: string | null) {
  const icons = artworkIcons(await tx.doc(SpaceArtwork));
  if (path === null) { delete icons[id]; return; }
  let clean: string;
  try { clean = canonical(path); } catch { throw invalid("Choose an existing local icon image."); }
  const files = await tx.doc(ProfileFileState), file = Object.values(files.files).find(item => item.path === clean);
  if (!file || !eligibleIcon(file, files.deletedConversations)) throw invalid("Choose a public SVG, PNG, JPEG, WebP or GIF file of at most 2 MiB.");
  icons[id] = file.id;
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
  private tail: Promise<unknown> = Promise.resolve();
  constructor(harness: Harness) { this.harness = harness; }
  serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.tail.then(work); this.tail = next.catch(() => {}); return next;
  }
  async contentEmpty() {
    const { state, icons } = await this.source();
    return !Object.keys(state.spaces).length && !Object.keys(state.podcasts).length && !Object.keys(state.requests).length && !Object.keys(icons).length;
  }
  private async source() {
    const [library, files, artwork] = await Promise.all([this.harness.snapshot(Library, context), this.harness.snapshot(ProfileFileState, context),
      this.harness.snapshot(SpaceArtwork, context)]);
    const state = validate(library ?? initial());
    const visible = Object.values(files?.files ?? {}).filter(file => publicLibraryFile(file, files?.deletedConversations ?? []));
    const references = new Map<string, ProfileFileRecord>();
    for (const file of visible) for (const reference of [file.id, ...(file.aliases ?? [])]) references.set(reference, file);
    const icons = artwork ? artworkIcons(artwork) : {};
    const iconFile = (id: string) => {
      const ref = icons[id], file = ref ? references.get(ref) : undefined;
      return file && eligibleIcon(file, files?.deletedConversations ?? []) ? file : undefined;
    };
    return { state, files: references, records: visible, icons, iconFile };
  }
  private view(item: SpaceRecord, source: Awaited<ReturnType<LibraryStore["source"]>>): Space {
    const file = source.files.get(item.fileId), icon = source.iconFile(item.id);
    return { ...item, entryPath: file?.path ?? null, missing: !file, modified: file?.mtime ?? null,
      ...(icon ? { iconPath: icon.path, iconRevision: icon.sha256 } : source.icons[item.id] ? { iconPath: null } : {}) };
  }
  async listSpaces() {
    const source = await this.source();
    return Object.values(source.state.spaces).map(item => this.view(item, source));
  }
  async getSpace(id: string) {
    const source = await this.source();
    return this.view(owned(source.state, id), source);
  }
  async iconFile(id: string) {
    const source = await this.source();
    owned(source.state, id);
    const file = source.iconFile(id);
    if (!file) throw new OxError("not_found", "The original Space icon is unavailable.");
    return file;
  }
  async items(category: LibraryCategory, audience: "agent" | "owner" = "agent"): Promise<LibraryItem[]> {
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
      if (category === "system") return audience === "owner" || publicDocument(file.path);
      if (publicDocument(file.path) || [file.id, ...(file.aliases ?? [])].some(id => entries.has(id)) || tagOf(file)?.podcast) return false;
      return category === "images" ? images.test(file.path) : category === "videos" ? videos.test(file.path)
        : !images.test(file.path) && !videos.test(file.path);
    }).map(file => item(file, category));
  }
  async createSpace(value: unknown, key: string) {
    if (!/^[A-Za-z0-9._:-]{1,160}$/.test(key)) throw invalid("Provide a stable Idempotency-Key of 1-160 ASCII letters, numbers, dots, colons, underscores or hyphens.");
    const input = libraryInput(spaceDraftSchema, value), name = input.name.trim(), path = entryPath(input.entryPath);
    if (!name) throw invalid("Enter a Space name.");
    const draft = { name, description: input.description ?? "", entryPath: path, pinned: input.pinned ?? false,
      ...(input.placement === undefined ? {} : { placement: input.placement }), ...(input.order === undefined ? {} : { order: input.order }),
      ...(input.visibility === undefined ? {} : { visibility: input.visibility }),
      ...(input.iconPath ? { iconPath: input.iconPath } : {}) }, request = hash(key), fingerprint = hash(JSON.stringify(draft));
    const saved = await this.serial(() => this.harness.commit(async tx => {
      const state = validate(await tx.doc(Library)), previous = state.requests[request];
      if (previous) {
        if (previous.fingerprint !== fingerprint || !Object.hasOwn(state.spaces, previous.id)) throw new OxError("conflict", "This request belongs to a different or removed Space.");
        return { id: previous.id, replayed: true };
      }
      if (Object.keys(state.spaces).length >= 500 || Object.keys(state.requests).length >= 5_000) throw new OxError("limit_exceeded", "This preview's Space or create-receipt limit was reached.");
      const file = await entry(tx, path), id = crypto.randomUUID(), now = new Date().toISOString();
      if (draft.iconPath) await setArtwork(tx, id, draft.iconPath);
      state.spaces[id] = { id, name, description: draft.description, fileId: file.id, pinned: draft.placement === undefined ? draft.pinned : draft.placement === "sidebar",
        ...(draft.placement === undefined ? {} : { placement: draft.placement }), ...(draft.order === undefined ? {} : { order: draft.order }),
        ...(draft.visibility === undefined ? {} : { visibility: draft.visibility }), revision: 1, createdAt: now, updatedAt: now };
      state.requests[request] = { id, fingerprint };
      return { id, replayed: false };
    }, context));
    return { space: await this.getSpace(saved.id), replayed: saved.replayed };
  }
  async updateSpace(id: string, value: unknown) {
    const patch = libraryInput(spacePatchSchema, value);
    await this.serial(() => this.harness.commit(async tx => {
      const item = owned(validate(await tx.doc(Library)), id); check(item, patch.expectedRevision);
      const name = (patch.name ?? item.name).trim();
      if (!name) throw invalid("Enter a Space name.");
      const fileId = patch.entryPath === undefined ? item.fileId : (await entry(tx, entryPath(patch.entryPath))).id;
      if (patch.placement !== undefined && patch.pinned !== undefined) throw invalid("Choose placement or the legacy pin field, not both.");
      if (patch.iconPath !== undefined) await setArtwork(tx, id, patch.iconPath);
      const placement = patch.placement ?? (patch.pinned === undefined ? item.placement : patch.pinned ? "sidebar" : "hidden");
      Object.assign(item, { name, description: patch.description ?? item.description, pinned: placement === undefined ? item.pinned : placement === "sidebar",
        ...(placement === undefined ? {} : { placement }), ...(patch.order === undefined ? {} : { order: patch.order }),
        ...(patch.visibility === undefined ? {} : { visibility: patch.visibility }),
        fileId, revision: item.revision + 1, updatedAt: new Date().toISOString() });
      if (fileId !== item.fileId || patch.entryPath !== undefined) { item.dataGrants = []; item.connections = []; }
    }, context));
    return this.getSpace(id);
  }
  async deleteSpace(id: string, revision: number) {
    await this.serial(() => this.harness.commit(async tx => {
      const state = validate(await tx.doc(Library)); check(owned(state, id), revision); delete state.spaces[id];
      await setArtwork(tx, id, null);
    }, context));
    return { deleted: true as const };
  }
  async grant(id: string, revision: number, change: { slot: string; data: SpaceDataGrant | null } | { domain: string; connection: SpaceConnectionGrant | null }) {
    await this.harness.commit(async tx => {
      const item = owned(validate(await tx.doc(Library)), id); check(item, revision);
      if ("slot" in change) {
        const values = (item.dataGrants ?? []).filter(grant => grant.slot !== change.slot);
        if (change.data) values.push(change.data);
        if (values.length > 4) throw new OxError("limit_exceeded", "A Space supports at most four explicit data slots.");
        item.dataGrants = values;
      } else {
        const values = (item.connections ?? []).filter(grant => grant.domain !== change.domain);
        if (change.connection) values.push(change.connection);
        if (values.length > 8) throw new OxError("limit_exceeded", "A Space supports at most eight explicit connector grants.");
        item.connections = values;
      }
      item.revision++; item.updatedAt = new Date().toISOString();
    }, context);
    return this.getSpace(id);
  }
  async tagPodcast(fileId: string, value: unknown) {
    const patch = libraryInput(podcastPatchSchema, value);
    return this.harness.commit(async tx => {
      const state = validate(await tx.doc(Library)), source = await tx.doc(ProfileFileState);
      const file = Object.values(source.files).find(file => file.id === fileId || file.aliases?.includes(fileId));
      const key = file ? [file.id, ...(file.aliases ?? [])].find(id => state.podcasts[id]) ?? file.aliases?.[0] ?? file.id : fileId;
      const previous = state.podcasts[key];
      if ((previous?.revision ?? 0) !== patch.expectedRevision || previous && previous.revision >= Number.MAX_SAFE_INTEGER) throw conflict();
      if ((!file || !publicLibraryFile(file, source.deletedConversations)) && (!previous || patch.podcast)) throw invalid("This Library file is unavailable.");
      if (patch.podcast && (!file || !audios.test(file.path))) throw invalid("Only an existing audio artifact can be classified as a podcast.");
      if (!previous && Object.keys(state.podcasts).length >= 1_000) throw new OxError("limit_exceeded", "This preview's explicit audio-classification limit was reached.");
      const revision = (previous?.revision ?? 0) + 1;
      state.podcasts[key] = { fileId: key, name: file?.path.split("/").at(-1) ?? previous!.name, podcast: patch.podcast, revision };
      return { fileId: key, podcast: patch.podcast, revision };
    }, context);
  }
}

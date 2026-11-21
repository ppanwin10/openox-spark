import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc, type Harness } from "@earendil-works/pi-durable";
import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { canonical } from "../../core/file-paths";
import { ProfileFileState, type ProfileFileRecord } from "../../profile/file-store";
import { ProfileFile } from "../../profile/files";
import { OxError } from "./functions";
import { identityPatchSchema, type AgentIdentity } from "./identity-contracts";
import { publicLibraryFile } from "./library";
import { contentRevision } from "./review";

const schema = Type.Object({ name: Type.String({ minLength: 1, maxLength: 100 }), avatarFileId: Type.Union([Type.String(), Type.Null()]),
  revision: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }), updatedAt: Type.Union([Type.String({ format: "date-time" }), Type.Null()]) }, { additionalProperties: false });
type State = Static<typeof schema>;
const initial = (): State => ({ name: "OpenOx", avatarFileId: null, revision: 1, updatedAt: null });
const Identity = defineDoc<State>({ kind: "ox.identity", version: 1, scope: "session", initial, checkpointWhen: (_, __, info) => info.deltasSinceBase >= 31 });
const context = BACKGROUND_CONTEXT;
const documentKey = ".ox/Identity.md";
function documentView(file: { text: string; blob: string; saved: boolean } | null | undefined) {
  if (!file || file.saved === false && file.text === "" && file.blob === "") {
    return { path: "Identity.md" as const, exists: false, text: null, revision: "missing" };
  }
  if (file.saved !== true || file.blob !== "" || typeof file.text !== "string" || file.text.length > 8_000) {
    throw new OxError("unavailable", "The original Identity.md is not readable Markdown. It was not replaced.");
  }
  return { path: "Identity.md" as const, exists: true, text: file.text, revision: contentRevision(file.text) };
}
export function identityInput<T extends TSchema>(schema: T, value: unknown): Static<T> {
  if (!Value.Check(schema, value)) throw new OxError("invalid_argument", [...Value.Errors(schema, value)].slice(0, 3).map(error => `${error.instancePath} ${error.message}`).join("; "));
  return value;
}
function validated(state: State) {
  if (!Value.Check(schema, state)) throw new OxError("unavailable", "Agent identity metadata is invalid. No empty replacement was created.");
  return state;
}
export class IdentityStore {
  private readonly harness: Harness;
  constructor(harness: Harness) { this.harness = harness; }
  async contentEmpty() {
    const state = validated(await this.harness.snapshot(Identity, context) ?? initial());
    return state.name === initial().name && state.avatarFileId === null && state.revision === 1 && state.updatedAt === null && !(await this.document()).exists;
  }
  async document() {
    return documentView(await this.harness.snapshot(ProfileFile, documentKey, context));
  }
  async saveDocument(text: string, expected: string) {
    if (text.length > 8_000 || expected !== "missing" && !/^[a-f0-9]{64}$/.test(expected)) throw new OxError("invalid_argument", "Invalid Identity.md text or source revision.");
    return this.harness.commit(async tx => {
      const file = await tx.doc(ProfileFile, documentKey, null);
      if (documentView(file).revision !== expected) throw new OxError("conflict", "Identity.md changed. Reopen the document before saving.");
      file.text = text; file.saved = true;
      return documentView(file);
    }, context);
  }
  async get(): Promise<AgentIdentity> {
    const state = validated(await this.harness.snapshot(Identity, context) ?? initial()), files = await this.harness.snapshot(ProfileFileState, context);
    const file = state.avatarFileId ? Object.values(files?.files ?? {}).find(file => [file.id, ...(file.aliases ?? [])].includes(state.avatarFileId!)
      && publicLibraryFile(file, files?.deletedConversations ?? [])) : undefined;
    return { name: state.name, avatarPath: file?.path ?? null, avatarMissing: state.avatarFileId !== null && !file, revision: state.revision, updatedAt: state.updatedAt };
  }
  async update(value: unknown) {
    const input = identityInput(identityPatchSchema, value);
    await this.harness.commit(async tx => {
      const state = validated(await tx.doc(Identity));
      if (state.revision !== input.expectedRevision || state.revision >= Number.MAX_SAFE_INTEGER) throw new OxError("conflict", "This Agent identity changed. Read it before saving.");
      const name = (input.name ?? state.name).trim();
      if (!name) throw new OxError("invalid_argument", "Enter an Agent name.");
      let avatarFileId = state.avatarFileId;
      if (input.avatarPath !== undefined) {
        if (input.avatarPath === null) avatarFileId = null;
        else {
          const path = canonical(input.avatarPath), files = await tx.doc(ProfileFileState);
          const file: ProfileFileRecord | undefined = Object.values(files.files).find(file => file.path === path && publicLibraryFile(file, files.deletedConversations));
          if (!file || !/\.(png|jpe?g|webp|gif|svg)$/i.test(path) || file.size > 2 * 1024 * 1024) throw new OxError("invalid_argument", "Choose an existing public image artifact of at most 2 MiB.");
          avatarFileId = file.id;
        }
      }
      Object.assign(state, { name, avatarFileId, revision: state.revision + 1, updatedAt: new Date().toISOString() });
    }, context);
    return this.get();
  }
}

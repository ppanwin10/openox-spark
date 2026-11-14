import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc, type Harness } from "@earendil-works/pi-durable";
import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { canonical } from "../../core/file-paths";
import { ProfileFileState, type ProfileFileRecord } from "../../profile/file-store";
import { OxError } from "./functions";
import { identityPatchSchema, type AgentIdentity } from "./identity-contracts";
import { publicLibraryFile } from "./library";

const schema = Type.Object({ name: Type.String({ minLength: 1, maxLength: 100 }), avatarFileId: Type.Union([Type.String(), Type.Null()]),
  revision: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }), updatedAt: Type.Union([Type.String({ format: "date-time" }), Type.Null()]) }, { additionalProperties: false });
type State = Static<typeof schema>;
const initial = (): State => ({ name: "OpenOx", avatarFileId: null, revision: 1, updatedAt: null });
const Identity = defineDoc<State>({ kind: "ox.identity", version: 1, scope: "session", initial, checkpointWhen: (_, __, info) => info.deltasSinceBase >= 31 });
const context = BACKGROUND_CONTEXT;
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

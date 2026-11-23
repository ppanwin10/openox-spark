import { join } from "node:path";
import { readJSONFile, Serial, writeJSONFile, type Kind } from "./support";
import { contentState, resetSource, syncContentState } from "../content-state";
import { OxError } from "@openox/agent/linux";
import { lstat, readFile } from "node:fs/promises";
import { HTTPError } from "../../http";
import { canonicalJSON, isObject, sha256 } from "./support";

export interface ConnectorPreference {
  kind: Kind; repository: string; domain: string; definition: string; revision: number; disabled: boolean; sessionDigest?: string; phase?: "disconnecting" | "disconnected";
}
export interface ConnectorReceipt {
  requestId: string; owner: string; identity: string; operation: "connect" | "configure" | "disconnect"; expectedRevision: number; revision: number;
  local: "connected" | "configured" | "pending" | "disconnected"; revocation?: "notSupported" | "revoked" | "failed" | "unknown";
}
interface PreferencesFile {
  format: 1; names: Record<string, string>; saved: string[]; bundledEnabled: boolean;
  connectors?: Record<string, ConnectorPreference>; connectorRequests?: ConnectorReceipt[];
}
export const connectorIdentity = (kind: Kind, repository: string, domain: string) => sha256(JSON.stringify([kind, repository, domain]));
export const connectorLimits = { count: 1000, receipts: 5000, file: 2 * 1024 * 1024, flows: 4, ttl: 600_000, cancellations: 512 };
const uuid = (value: unknown) => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const validRevision = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const preferenceError = () => new HTTPError(503, "The original connector preferences are unavailable, invalid or changed. Existing data has been retained.");
export interface AttachmentRecord { domain: string; kind: Kind; repository: string; version: string }
interface AttachmentsFile { conversations: Record<string, AttachmentRecord[]> }

export class Preferences {
  private path: string;
  private file: PreferencesFile = { format: 1, names: {}, saved: [], bundledEnabled: true };
  private serial = new Serial();
  private guarded: boolean;
  private failure?: HTTPError;

  constructor(state: string, guarded = false) { this.path = join(state, "services.json"); this.guarded = guarded; }

  async load() {
    if (this.guarded) {
      try { this.file = await this.readStored(); this.failure = undefined; } catch { this.failure = preferenceError(); }
      return;
    }
    const stored = await readJSONFile<Partial<PreferencesFile>>(this.path, {});
    this.file = { ...stored, format: 1, names: stored.names ?? {}, saved: Array.isArray(stored.saved) ? stored.saved : [], bundledEnabled: stored.bundledEnabled !== false };
  }

  private async readStored() {
    let stored: unknown;
    try {
      const info = await lstat(this.path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > connectorLimits.file) throw preferenceError();
      stored = JSON.parse(await readFile(this.path, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { format: 1, names: {}, saved: [], bundledEnabled: true } as PreferencesFile;
      throw preferenceError();
    }
    if (!isObject(stored) || stored.format !== 1 || !isObject(stored.names) || Object.values(stored.names).some(name => typeof name !== "string")
      || !Array.isArray(stored.saved) || stored.saved.some(domain => typeof domain !== "string")
      || (stored.bundledEnabled !== undefined && typeof stored.bundledEnabled !== "boolean")) throw preferenceError();
    if (stored.connectors !== undefined) {
      if (!isObject(stored.connectors) || Object.keys(stored.connectors).length > connectorLimits.count) throw preferenceError();
      for (const [identity, entry] of Object.entries(stored.connectors)) {
        if (!isObject(entry) || !["api", "web", "mcp", "ios"].includes(String(entry.kind)) || typeof entry.repository !== "string" || typeof entry.domain !== "string"
          || typeof entry.definition !== "string" || !validRevision(entry.revision) || typeof entry.disabled !== "boolean"
          || identity !== connectorIdentity(entry.kind as Kind, entry.repository, entry.domain)
          || (entry.sessionDigest !== undefined && (typeof entry.sessionDigest !== "string" || !/^[a-f0-9]{64}$/.test(entry.sessionDigest)))
          || (entry.phase !== undefined && !["disconnecting", "disconnected"].includes(String(entry.phase)))) throw preferenceError();
      }
    }
    if (stored.connectorRequests !== undefined) {
      if (!Array.isArray(stored.connectorRequests) || stored.connectorRequests.length > connectorLimits.receipts) throw preferenceError();
      const requests = new Set<string>();
      for (const entry of stored.connectorRequests) {
        if (!isObject(entry) || !uuid(entry.requestId) || !uuid(entry.owner) || typeof entry.identity !== "string" || !/^[a-f0-9]{64}$/.test(entry.identity)
          || !["connect", "configure", "disconnect"].includes(String(entry.operation)) || !validRevision(entry.expectedRevision) || !validRevision(entry.revision)
          || !["connected", "configured", "pending", "disconnected"].includes(String(entry.local)) || requests.has(String(entry.requestId))
          || (entry.revocation !== undefined && !["notSupported", "revoked", "failed", "unknown"].includes(String(entry.revocation)))) throw preferenceError();
        requests.add(String(entry.requestId));
      }
    }
    return { ...stored, bundledEnabled: stored.bundledEnabled !== false } as unknown as PreferencesFile;
  }
  private async verifyStored() {
    if (!this.guarded) return;
    const stored = await this.readStored();
    if (canonicalJSON(stored) !== canonicalJSON(this.file)) throw preferenceError();
    this.failure = undefined;
  }
  verify() {
    return this.serial.run(async () => {
      if (this.failure) await this.load();
      if (this.failure) throw this.failure;
      await this.verifyStored();
    });
  }
  name(domain: string) { return this.file.names[domain]; }
  saved(domain: string) { return this.file.saved.includes(domain); }
  get bundledEnabled() { return this.file.bundledEnabled; }
  snapshot() { return { format: 1, names: { ...this.file.names }, saved: [...this.file.saved] }; }

  update<T>(change: (file: PreferencesFile) => T, beforePublish?: () => void | Promise<void>) {
    return this.serial.run(async () => {
      if (this.failure) throw this.failure;
      await this.verifyStored();
      const next = structuredClone(this.file);
      const result = change(next);
      if (this.guarded && Buffer.byteLength(JSON.stringify(next)) > connectorLimits.file) throw new HTTPError(507, "The original connector preferences are full. No data was removed.");
      await writeJSONFile(this.path, next, beforePublish);
      this.file = next;
      return result;
    });
  }

  setSaved(domain: string, saved: boolean) {
    if (this.saved(domain) === saved) return Promise.resolve();
    return this.update(file => { file.saved = saved ? [...file.saved, domain].sort() : file.saved.filter(entry => entry !== domain); });
  }
  connector(identity: string) { if (this.failure) throw this.failure; return this.file.connectors?.[identity]; }
  connectedAPIs() { return Object.values(this.file.connectors ?? {}).filter(row => row.kind === "api" && !row.disabled); }
  connectorCapacity(identity: string) {
    if ((this.file.connectorRequests?.length ?? 0) >= connectorLimits.receipts || (!this.file.connectors?.[identity] && Object.keys(this.file.connectors ?? {}).length >= connectorLimits.count)) {
      throw new HTTPError(507, "The original connector preferences are full. No credential change was admitted.");
    }
  }
  connectorRequest(requestId: string, owner: string) {
    const receipt = this.file.connectorRequests?.find(entry => entry.requestId === requestId && entry.owner === owner);
    return receipt ? structuredClone(receipt) : undefined;
  }
  commitConnector(identity: string, entry: Omit<ConnectorPreference, "revision">, expectedRevision: number, requestId: string, owner: string,
    operation: ConnectorReceipt["operation"], beforePublish?: () => void | Promise<void>) {
    return this.update(file => {
      const previous = file.connectorRequests?.find(receipt => receipt.requestId === requestId);
      if (previous) {
        if (previous.owner !== owner || previous.identity !== identity || previous.operation !== operation || previous.expectedRevision !== expectedRevision) {
          throw new HTTPError(409, "This request identity belongs to another connector operation.");
        }
        return previous;
      }
      if ((file.connectorRequests?.length ?? 0) >= connectorLimits.receipts || (!file.connectors?.[identity] && Object.keys(file.connectors ?? {}).length >= connectorLimits.count)) {
        throw new HTTPError(507, "The original connector preferences are full. No data was removed.");
      }
      if ((file.connectors?.[identity]?.revision ?? 0) !== expectedRevision || expectedRevision === Number.MAX_SAFE_INTEGER) {
        throw new HTTPError(409, "This connector changed. Read its current state before continuing.");
      }
      const revision = expectedRevision + 1;
      (file.connectors ??= {})[identity] = { ...entry, revision };
      const receipt: ConnectorReceipt = { requestId, owner, identity, operation, expectedRevision, revision,
        local: operation === "disconnect" ? "pending" : operation === "configure" ? "configured" : "connected" };
      (file.connectorRequests ??= []).push(receipt);
      if (operation !== "disconnect" && !file.saved.includes(entry.domain)) file.saved.push(entry.domain);
      if (operation === "disconnect") file.saved = file.saved.filter(domain => domain !== entry.domain);
      return receipt;
    }, beforePublish);
  }
  finishDisconnect(requestId: string, owner: string, revocation: NonNullable<ConnectorReceipt["revocation"]>) {
    return this.update(file => {
      const receipt = file.connectorRequests?.find(entry => entry.requestId === requestId && entry.owner === owner);
      if (!receipt || file.connectors?.[receipt.identity]?.revision !== receipt.revision) throw new HTTPError(409, "The disconnected connector changed before cleanup was confirmed.");
      file.connectors[receipt.identity]!.phase = "disconnected";
      receipt.local = "disconnected"; receipt.revocation = revocation;
      return receipt;
    });
  }
}

export class Attachments {
  private path: string;
  private file: AttachmentsFile = { conversations: {} };
  private serial = new Serial();

  constructor(state: string) { this.path = join(state, "attachments.json"); }

  async load() {
    const stored = await readJSONFile<Partial<AttachmentsFile>>(this.path, {});
    this.file = { conversations: stored.conversations && typeof stored.conversations === "object" ? stored.conversations : {} };
  }

  list(conversation: number) { return [...this.file.conversations[String(conversation)] ?? []]; }
  find(conversation: number, domain: string) { return this.list(conversation).find(record => record.domain === domain); }
  conversations() { return Object.keys(this.file.conversations).map(Number); }
  attachedAnywhere(domain: string) { return Object.values(this.file.conversations).some(records => records.some(record => record.domain === domain)); }
  async contentSnapshot() {
    const source = await contentState(this.path);
    const value = source ? JSON.parse(new TextDecoder().decode(source.data)) : { conversations: {} };
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => key !== "conversations")
      || !value.conversations || typeof value.conversations !== "object" || Array.isArray(value.conversations)
      || Object.entries(value.conversations).some(([id, records]) => !/^-?(0|[1-9][0-9]*)$/.test(id) || !Number.isSafeInteger(Number(id))
        || !Array.isArray(records) || records.some(record => !record || typeof record !== "object" || !["web", "api", "ios", "mcp"].includes(record.kind)
          || ["domain", "repository", "version"].some(key => typeof record[key] !== "string")))
      || JSON.stringify(value) !== JSON.stringify(this.file)) throw new OxError("conflict", "The original service attachment state is invalid or changed.");
    return { data: { attachments: structuredClone(this.file) }, files: source ? [{ path: "vm/state/attachments.json", data: source.data }] : [] };
  }
  async resetContent(expected: string | null | undefined) {
    const source = await this.contentSnapshot();
    const file = source.files[0];
    resetSource(file ? { data: file.data, sha256: new Bun.CryptoHasher("sha256").update(file.data).digest("hex") } : null,
      expected, Object.keys(this.file.conversations).length === 0);
    if (file) { await this.update(value => { value.conversations = {}; }); await syncContentState(this.path); }
  }

  private update(change: (file: AttachmentsFile) => void) {
    return this.serial.run(async () => {
      const next = structuredClone(this.file);
      change(next);
      for (const [key, records] of Object.entries(next.conversations)) if (!records.length) delete next.conversations[key];
      await writeJSONFile(this.path, next);
      this.file = next;
    });
  }

  put(conversation: number, record: AttachmentRecord) {
    return this.update(file => {
      const records = file.conversations[String(conversation)] ?? [];
      const index = records.findIndex(existing => existing.domain === record.domain);
      if (index >= 0) records[index] = record; else records.push(record);
      file.conversations[String(conversation)] = records;
    });
  }

  remove(conversation: number, domain: string) {
    return this.update(file => { file.conversations[String(conversation)] = (file.conversations[String(conversation)] ?? []).filter(record => record.domain !== domain); });
  }

  removeEverywhere(domain: string) {
    return this.update(file => { for (const key of Object.keys(file.conversations)) file.conversations[key] = file.conversations[key]!.filter(record => record.domain !== domain); });
  }
  removeConnector(domain: string, kind: Kind, repository: string) {
    return this.update(file => { for (const key of Object.keys(file.conversations)) file.conversations[key] = file.conversations[key]!
      .filter(record => !(record.domain === domain && record.kind === kind && record.repository === repository)); });
  }

  removeConversation(conversation: number) {
    return this.update(file => { delete file.conversations[String(conversation)]; });
  }
}

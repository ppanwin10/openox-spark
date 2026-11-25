import { join } from "node:path";
import { lstat, readFile } from "node:fs/promises";
import type { FunctionCall, PromptField } from "@openox/agent/linux";
import { sameOrigin } from "../../auth";
import { museParityEnabled } from "../../config";
import { HTTPError, json, payload } from "../../http";
import type { VMContext, VMRoute } from "../context";
import type { Approvals } from "./policy";
import { canonicalJSON, fail, isObject, readJSONFile, Serial, sha256, writeJSONFile } from "./support";

type Consumer = "apiService" | "mcpServer";
type Origin = { kind: "named" } | { kind: "generated"; consumer: Consumer; id: string };
type SecretType = "account" | "apiKey" | "token";
interface Entry { key: string; displayName: string; origin: Origin; value: Record<string, string>; type?: SecretType; serviceID?: string;
  id?: string; revision?: number; website?: { id: string; revision: number } }
interface Binding { consumerKind: Consumer; consumerID: string; secretKey: string; destination: string; configurationFingerprint: string; requiredFields: string[]; revision?: number }
type PasswordOperation = "add" | "edit" | "delete";
interface PasswordReceipt { requestId: string; id: string; operation: PasswordOperation; expectedRevision: number; revision: number }
interface SecretIntent { requestId: string; key: string; operation: "add" | "edit"; expectedId: string | null; expectedRevision: number }
interface SecretReceipt extends SecretIntent { id: string; revision: number }
interface SecretFile { version: 1; entries: Entry[]; bindings: Binding[]; websiteRequests?: PasswordReceipt[]; secretRequests?: SecretReceipt[] }
const passwordLimits = { request: 8192, url: 2048, site: 256, username: 512, password: 4096, websites: 500, entries: 2000, receipts: 5000, file: 40 * 1024 * 1024 };
const bytes = (value: string) => new TextEncoder().encode(value).length;
const uuid = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const revision = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
class PasswordError extends HTTPError {
  readonly code: string;
  constructor(status: number, code: string, message: string) { super(status, message); this.code = code; }
}
const invalidPassword = () => new PasswordError(400, "invalid_input", "Enter a valid website URL, username and password within the store limits.");
function websiteURL(value: unknown) {
  if (typeof value !== "string" || !value || bytes(value) > passwordLimits.url || /[\u0000-\u0020\u007f]/.test(value)) throw invalidPassword();
  let url: URL;
  try { url = new URL(value); } catch { throw invalidPassword(); }
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash || bytes(url.origin) > passwordLimits.site) {
    throw new PasswordError(400, "invalid_url", "Use an HTTP or HTTPS website URL without credentials, query strings or fragments.");
  }
  if (bytes(url.href) > passwordLimits.url) throw invalidPassword();
  return url;
}
function websiteValue(value: Record<string, string>) {
  const url = websiteURL(value.url);
  if (typeof value.username !== "string" || !value.username.trim() || bytes(value.username) > passwordLimits.username
    || /[\u0000-\u001f\u007f]/.test(value.username) || typeof value.password !== "string" || !value.password || bytes(value.password) > passwordLimits.password) throw invalidPassword();
  validateValue(value);
  return { ...value, url: url.href };
}
function passwordBody(value: unknown, operation: PasswordOperation, id?: string) {
  const allowed = operation === "add" ? ["id", "requestId", "url", "username", "password"]
    : operation === "edit" ? ["requestId", "expectedRevision", "confirm", "url", "username", "password"] : ["requestId", "expectedRevision", "confirm"];
  if (!isObject(value) || Object.keys(value).some(key => !allowed.includes(key)) || !uuid(value.requestId) || !uuid(operation === "add" ? value.id : id)) throw invalidPassword();
  if (operation !== "add" && (!revision(value.expectedRevision) || value.confirm !== true)) {
    throw new PasswordError(400, "confirmation_required", "Confirm this change using the current password revision.");
  }
  for (const field of ["url", "username", "password"] as const) {
    if (value[field] !== undefined && (typeof value[field] !== "string" || bytes(value[field]) > passwordLimits[field])) throw invalidPassword();
  }
  return { id: operation === "add" ? value.id as string : id!, requestId: value.requestId, expectedRevision: operation === "add" ? 0 : value.expectedRevision as number,
    fields: { url: value.url as string | undefined, username: value.username as string | undefined, password: value.password as string | undefined } };
}
function validSecretFile(value: unknown): value is SecretFile {
  if (!isObject(value) || value.version !== 1 || !Array.isArray(value.entries) || !Array.isArray(value.bindings)
    || value.entries.length > passwordLimits.entries || (value.websiteRequests !== undefined && !Array.isArray(value.websiteRequests))
    || (value.secretRequests !== undefined && !Array.isArray(value.secretRequests))) return false;
  const keys = new Set<string>(), identities = new Set<string>(), entryIDs = new Set<string>();
  for (const entry of value.entries) {
    if (!isObject(entry) || typeof entry.key !== "string" || keys.has(entry.key) || typeof entry.displayName !== "string" || !isObject(entry.origin) || !isObject(entry.value)) return false;
    if (entry.origin.kind !== "named" && !(entry.origin.kind === "generated" && ["apiService", "mcpServer"].includes(String(entry.origin.consumer)) && typeof entry.origin.id === "string")) return false;
    try { validateKey(entry.key); validateValue(entry.value as Record<string, string>); } catch { return false; }
    keys.add(entry.key);
    if (entry.id !== undefined || entry.revision !== undefined) {
      if (!uuid(entry.id) || !revision(entry.revision) || entryIDs.has(entry.id)) return false;
      entryIDs.add(entry.id);
    }
    if (entry.website !== undefined) {
      if (!isObject(entry.website) || !uuid(entry.website.id) || !revision(entry.website.revision) || identities.has(entry.website.id) || entry.type !== "account") return false;
      try {
        const fields = websiteValue(entry.value as Record<string, string>);
        if (entry.displayName !== websiteURL(fields.url).origin.slice(0, 80)) return false;
      } catch { return false; }
      identities.add(entry.website.id);
    }
  }
  if (identities.size > passwordLimits.websites) return false;
  const bindings = new Set<string>();
  for (const binding of value.bindings) {
    if (!isObject(binding) || !["apiService", "mcpServer"].includes(String(binding.consumerKind)) || typeof binding.consumerID !== "string" || typeof binding.secretKey !== "string"
      || typeof binding.destination !== "string" || typeof binding.configurationFingerprint !== "string" || !Array.isArray(binding.requiredFields)
      || binding.requiredFields.some(field => typeof field !== "string") || (binding.consumerKind === "mcpServer" && !revision(binding.revision))
      || (binding.revision !== undefined && !revision(binding.revision))) return false;
    const identity = `${binding.consumerKind}:${binding.consumerID}`;
    if (bindings.has(identity)) return false;
    bindings.add(identity);
  }
  const requests = new Set<string>();
  for (const receipt of value.websiteRequests ?? []) {
    if (!isObject(receipt) || !uuid(receipt.requestId) || !uuid(receipt.id) || requests.has(receipt.requestId) || !["add", "edit", "delete"].includes(String(receipt.operation))
      || !revision(receipt.revision) || (receipt.operation === "add" ? receipt.expectedRevision !== 0 : !revision(receipt.expectedRevision))) return false;
    if (receipt.revision !== (receipt.operation === "add" ? 1 : Number(receipt.expectedRevision) + 1)) return false;
    requests.add(receipt.requestId);
  }
  for (const receipt of value.secretRequests ?? []) {
    if (!isObject(receipt) || !uuid(receipt.requestId) || requests.has(receipt.requestId) || !uuid(receipt.id)
      || typeof receipt.key !== "string" || !["add", "edit"].includes(String(receipt.operation))
      || !(receipt.expectedId === null && receipt.expectedRevision === 0 || uuid(receipt.expectedId) && revision(receipt.expectedRevision))
      || !revision(receipt.revision) || receipt.revision !== Number(receipt.expectedRevision) + 1
      || receipt.operation === "add" && receipt.expectedId !== null || receipt.expectedId !== null && receipt.expectedId !== receipt.id) return false;
    try { validateKey(receipt.key); } catch { return false; }
    requests.add(receipt.requestId);
  }
  return requests.size <= passwordLimits.receipts;
}

export function validateKey(key: string) {
  if (new TextEncoder().encode(key).length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(key)) throw fail("invalid_argument", "Invalid secret key", "Use letters, digits, dots, hyphens, and underscores, starting with a letter or digit.");
}

function validateDisplayName(name: string) {
  if (!name || [...name].length > 80 || name !== name.normalize("NFC")) throw fail("invalid_argument", "Invalid secret display name", "Use a display name of 1-80 characters.");
}

function validateValue(value: Record<string, string>) {
  const keys = Object.keys(value);
  if (!keys.length || keys.some(key => !key) || Object.values(value).some(field => typeof field !== "string") || new TextEncoder().encode(JSON.stringify(value)).length > 16_384) {
    throw fail("invalid_argument", "Secret value must be a flat JSON object of text fields", "Enter a single value, or a JSON object whose fields are all text.");
  }
}

const secretType = (value: unknown): value is SecretType => value === "account" || value === "apiKey" || value === "token";
const typedFields = (type: SecretType) => type === "account" ? ["username", "password"] : [type];

export class Secrets {
  private path: string;
  private file: SecretFile = { version: 1, entries: [], bindings: [] };
  private serial = new Serial();
  private failure: PasswordError | undefined;
  private guarded: boolean;

  constructor(state: string, guarded = false) { this.path = join(state, "secrets.json"); this.guarded = guarded; }

  async load() {
    if (this.guarded) {
      try { this.file = await this.readStored(); this.failure = undefined; }
      catch (error) { this.failure = error as PasswordError; }
      return;
    }
    const stored = await readJSONFile<Partial<SecretFile>>(this.path, {});
    this.file = { version: 1, entries: Array.isArray(stored.entries) ? stored.entries : [], bindings: Array.isArray(stored.bindings) ? stored.bindings : [],
      ...(Array.isArray(stored.websiteRequests) ? { websiteRequests: stored.websiteRequests } : {}),
      ...(Array.isArray(stored.secretRequests) ? { secretRequests: stored.secretRequests } : {}) };
  }

  private ready() { if (this.failure) throw this.failure; }

  private async readStored() {
    let text: string;
    try {
      const info = await lstat(this.path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > passwordLimits.file) throw new PasswordError(503, "storage_invalid", "The credentials store is invalid or exceeds its limits. Existing data has been retained.");
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, entries: [], bindings: [] } as SecretFile;
      if (error instanceof PasswordError) throw error;
      throw new PasswordError(503, "storage_unavailable", "The credentials store is unavailable. Existing data has been retained; retry after access is restored.");
    }
    let stored: unknown;
    try { stored = JSON.parse(text); } catch { throw new PasswordError(503, "storage_invalid", "The credentials store could not be read. Existing data has been retained."); }
    if (!validSecretFile(stored)) throw new PasswordError(503, "storage_invalid", "The credentials store has an invalid or unsupported format. Existing data has been retained.");
    return stored;
  }

  private async retryRead() {
    if (this.failure?.code === "storage_changed") throw this.failure;
    if (this.failure) await this.load(); else await this.verifyStored();
    this.ready();
  }

  private async verifyStored() {
    try {
      const stored = await this.readStored();
      if (canonicalJSON(stored) !== canonicalJSON(this.file)) throw new PasswordError(503, "storage_changed", "The credentials store changed outside this Host. Restart the Host before making changes.");
    } catch (error) { this.failure = error as PasswordError; throw error; }
  }

  private reviseIdentity(entry: Entry) {
    if (!this.guarded && !entry.id) return;
    if (entry.revision === Number.MAX_SAFE_INTEGER) throw new PasswordError(409, "revision_exhausted", "This credential cannot be changed safely.");
    entry.id ??= crypto.randomUUID();
    entry.revision = (entry.revision ?? 0) + 1;
  }

  private revise(entry: Entry | undefined) {
    if (!entry) return;
    this.reviseIdentity(entry);
    if (entry.website) {
      if (entry.website.revision === Number.MAX_SAFE_INTEGER) throw new PasswordError(409, "revision_exhausted", "This password cannot be changed safely.");
      entry.website.revision++;
    }
  }

  private update<T>(change: (file: SecretFile) => T, skipUnchanged = false, beforePublish?: () => void | Promise<void>) {
    return this.serial.run(async () => {
      this.ready();
      if (this.guarded) await this.verifyStored();
      const next = structuredClone(this.file);
      const result = change(next);
      if (skipUnchanged && canonicalJSON(next) === canonicalJSON(this.file)) return result;
      if (this.guarded && (next.entries.length > passwordLimits.entries || bytes(`${JSON.stringify(next, null, 2)}\n`) > passwordLimits.file)) {
        throw new PasswordError(507, "store_full", "The credentials store is full. No existing data was removed.");
      }
      try { await writeJSONFile(this.path, next, beforePublish); }
      catch (error) {
        if (error instanceof HTTPError || (error as { code?: string })?.code === "cancelled") throw error;
        if (this.guarded) throw new PasswordError(503, "write_failed", "The password change was not saved. Existing data has been retained; restore storage access and retry.");
        throw error;
      }
      this.file = next;
      return result;
    });
  }

  entry(key: string) { this.ready(); return this.file.entries.find(entry => entry.key === key); }
  verify() { return this.serial.run(() => this.guarded ? this.retryRead() : Promise.resolve(this.ready())); }

  list(includeRevision = false) {
    this.ready();
    return this.file.entries.map(entry => ({ key: entry.key, displayName: entry.displayName, fields: Object.keys(entry.value).sort(),
      available: Object.keys(entry.value).length > 0, type: entry.type ?? null, serviceID: entry.serviceID ?? null,
      ...(includeRevision ? { id: entry.id ?? null, revision: entry.revision ?? 0 } : {}) }));
  }

  forService(serviceID: string) {
    this.ready();
    return this.file.entries.flatMap(entry => entry.type && entry.serviceID === serviceID && typedFields(entry.type).every(field => !!entry.value[field])
      ? [{ key: entry.key, displayName: entry.displayName, type: entry.type }] : []);
  }

  set(key: string, displayName: string, value: Record<string, string>, origin: Origin = { kind: "named" }, metadata?: { type: SecretType; serviceID?: string }) {
    return this.update(file => { this.setEntry(file, key, displayName, value, origin, metadata); });
  }

  private setEntry(file: SecretFile, key: string, displayName: string, value: Record<string, string>, origin: Origin, metadata?: { type: SecretType; serviceID?: string }) {
    validateKey(key);
    if (key.startsWith("ox.") && origin.kind === "named") throw fail("invalid_argument", "Secret key is reserved", "Choose a key that does not start with ox.");
    validateDisplayName(displayName);
    validateValue(value);
    const existing = file.entries.find(entry => entry.key === key);
    if (existing?.website) {
      if (metadata && metadata.type !== "account") throw invalidPassword();
      value = websiteValue({ ...value, url: value.url ?? existing.value.url! });
      displayName = websiteURL(value.url).origin.slice(0, 80);
    }
    this.revise(existing);
    const type = metadata?.type ?? existing?.type;
    if (type && !typedFields(type).every(field => typeof value[field] === "string" && value[field]!.length > 0)) {
      throw fail("invalid_argument", "The typed secret is missing required fields", `Include ${typedFields(type).join(", ")}.`);
    }
    for (const binding of file.bindings.filter(binding => binding.secretKey === key)) {
      if (!binding.requiredFields.every(field => typeof value[field] === "string")) throw fail("invalid_argument", "Secret value is missing fields required by a connection", `Include the fields ${binding.requiredFields.join(", ")}.`);
      if (binding.revision === Number.MAX_SAFE_INTEGER) throw new HTTPError(409, "This credential revision cannot advance safely.");
      if (this.guarded || binding.revision !== undefined) binding.revision = (binding.revision ?? 0) + 1;
    }
    if (existing) { existing.displayName = displayName; existing.value = value; if (metadata) Object.assign(existing, metadata); return existing; }
    const entry: Entry = { key, displayName, origin, value, ...metadata };
    this.reviseIdentity(entry); file.entries.push(entry);
    return entry;
  }

  private secretProof(file: SecretFile, receipt: SecretReceipt | undefined) {
    if (!receipt) return { outcome: "unconfirmed", receipt: null, secret: null };
    const entry = file.entries.find(entry => entry.key === receipt.key);
    const outcome = !entry ? "deleted" : entry.id === receipt.id && entry.revision === receipt.revision ? "committed" : "superseded";
    return { outcome, receipt, secret: entry ? { key: entry.key, name: entry.displayName, fields: Object.keys(entry.value).sort(),
      id: entry.id ?? null, revision: entry.revision ?? 0 } : null };
  }

  secretRequest(requestId: unknown) {
    if (!uuid(requestId)) throw new PasswordError(400, "invalid_request", "Use a valid credential request identity.");
    return this.serial.run(async () => {
      await this.retryRead();
      return this.secretProof(this.file, this.file.secretRequests?.find(receipt => receipt.requestId === requestId));
    });
  }

  changeSecret(intent: SecretIntent, name: unknown, fields: unknown) {
    return this.update(file => {
      const previous = file.secretRequests?.find(receipt => receipt.requestId === intent.requestId);
      if (previous) {
        if (previous.key !== intent.key || previous.operation !== intent.operation || previous.expectedId !== intent.expectedId || previous.expectedRevision !== intent.expectedRevision) {
          throw new PasswordError(409, "request_reused", "This request identity already belongs to another credential change.");
        }
        return { replay: true, ...this.secretProof(file, previous) };
      }
      if (file.websiteRequests?.some(receipt => receipt.requestId === intent.requestId)) throw new PasswordError(409, "request_reused", "This request identity already belongs to another credential change.");
      if ((file.secretRequests?.length ?? 0) + (file.websiteRequests?.length ?? 0) >= passwordLimits.receipts) {
        throw new PasswordError(507, "store_full", "The credentials request history is full. No existing data was removed.");
      }
      const existing = file.entries.find(entry => entry.key === intent.key);
      if (intent.operation === "add" && existing) throw new HTTPError(409, "A secret with this key already exists");
      if (intent.operation === "edit" && !existing) throw new HTTPError(404, "Secret not found");
      if ((existing?.id ?? null) !== intent.expectedId || (existing?.revision ?? 0) !== intent.expectedRevision) {
        throw new PasswordError(409, "revision_conflict", "This credential changed on another page. Refresh before saving.");
      }
      if (!isObject(fields) || Object.values(fields).some(value => typeof value !== "string")) throw new HTTPError(400, "Add at least one field");
      const value: Record<string, string> = {};
      for (const [field, entered] of Object.entries(fields)) {
        const key = field.trim(), kept = entered === "" ? existing?.value[key] : entered;
        if (!key || typeof kept !== "string" || kept === "") throw new HTTPError(400, "Name every field and enter a value.");
        value[key] = kept;
      }
      const displayName = typeof name === "string" && name.trim() ? name.trim() : existing?.displayName ?? intent.key;
      const entry = this.setEntry(file, intent.key, displayName, value, existing?.origin ?? { kind: "named" });
      const receipt: SecretReceipt = { ...intent, id: entry.id!, revision: entry.revision! };
      (file.secretRequests ??= []).push(receipt);
      return { replay: false, ...this.secretProof(file, receipt) };
    }, true);
  }

  delete(key: string) {
    return this.update(file => {
      file.bindings = file.bindings.filter(binding => binding.secretKey !== key);
      file.entries = file.entries.filter(entry => entry.key !== key);
    });
  }

  apiCredential(id: string, fingerprint: string) {
    return this.apiCredentialState(id, fingerprint)?.value;
  }
  apiCredentialState(id: string, fingerprint: string) {
    const binding = this.file.bindings.find(binding => binding.consumerKind === "apiService" && binding.consumerID === id);
    if (!binding || binding.configurationFingerprint !== fingerprint) return undefined;
    const value = this.entry(binding.secretKey)?.value;
    return value && binding.requiredFields.every(field => typeof value[field] === "string") ? { value, revision: binding.revision ?? 0 } : undefined;
  }

  saveAPICredential(id: string, fingerprint: string, displayName: string, destination: string, value: Record<string, string>, beforePublish?: () => void | Promise<void>, expectedRevision?: number) {
    return this.saveCredential("apiService", id, fingerprint, displayName, destination, value, expectedRevision, beforePublish);
  }

  async mcpCredential(id: string, fingerprint: string) {
    await this.verify();
    const binding = this.file.bindings.find(binding => binding.consumerKind === "mcpServer" && binding.consumerID === id && binding.configurationFingerprint === fingerprint);
    const entry = binding && this.entry(binding.secretKey);
    return binding && entry && binding.requiredFields.every(field => typeof entry.value[field] === "string")
      ? { value: structuredClone(entry.value), revision: binding.revision! } : undefined;
  }

  saveMCPCredential(id: string, fingerprint: string, displayName: string, destination: string, value: Record<string, string>, expectedRevision: number,
    beforePublish?: () => void | Promise<void>) {
    return this.saveCredential("mcpServer", id, fingerprint, displayName, destination, value, expectedRevision, beforePublish);
  }

  private saveCredential(consumer: Consumer, id: string, fingerprint: string, displayName: string, destination: string, value: Record<string, string>,
    expectedRevision?: number, beforePublish?: () => void | Promise<void>) {
    validateValue(value);
    return this.update(file => {
      const bound = file.bindings.find(binding => binding.consumerKind === consumer && binding.consumerID === id);
      if (bound?.revision === Number.MAX_SAFE_INTEGER) throw new HTTPError(409, "This credential revision cannot advance safely.");
      if (expectedRevision !== undefined && (bound?.revision ?? 0) !== expectedRevision) throw new HTTPError(409, "This connection changed before its credential write.");
      const boundEntry = file.entries.find(entry => entry.key === bound?.secretKey);
      const owned = boundEntry?.origin, base = `ox.${consumer === "apiService" ? "api-service" : "mcp-server"}.${id.slice(0, 24)}`;
      const key = owned?.kind === "generated" && owned.consumer === consumer && owned.id === id ? bound!.secretKey
        : file.entries.some(entry => entry.key === base) ? `${base}.${crypto.randomUUID().toLowerCase()}` : base;
      const existing = file.entries.find(entry => entry.key === key);
      const fields = Object.keys(value).sort();
      if (boundEntry !== existing) this.revise(boundEntry);
      if (existing) {
        existing.value = existing.website ? websiteValue({ ...value, url: existing.value.url! }) : value;
        existing.displayName = existing.website ? websiteURL(existing.value.url).origin.slice(0, 80) : displayName;
        this.revise(existing);
      }
      else {
        const entry: Entry = { key, displayName: displayName.slice(0, 80) || "Service credential", origin: { kind: "generated", consumer, id }, value };
        this.reviseIdentity(entry); file.entries.push(entry);
      }
      file.bindings = file.bindings.filter(binding => !(binding.consumerKind === consumer && binding.consumerID === id));
      const revision = this.guarded || consumer === "mcpServer" || bound?.revision !== undefined ? (bound?.revision ?? 0) + 1 : undefined;
      file.bindings.push({ consumerKind: consumer, consumerID: id, secretKey: key, destination, configurationFingerprint: fingerprint, requiredFields: fields,
        ...(revision === undefined ? {} : { revision }) });
      return revision;
    }, false, beforePublish);
  }

  clearAPICredential(id: string) { return this.clearCredential("apiService", id); }
  clearMCPCredential(id: string) { return this.clearCredential("mcpServer", id); }
  private clearCredential(consumer: Consumer, id: string) {
    return this.update(file => {
      const removed = file.bindings.filter(binding => binding.consumerKind === consumer && binding.consumerID === id);
      for (const binding of removed) this.revise(file.entries.find(entry => entry.key === binding.secretKey));
      file.bindings = file.bindings.filter(binding => !removed.includes(binding));
      file.entries = file.entries.filter(entry => !(entry.origin.kind === "generated" && entry.origin.consumer === consumer && entry.origin.id === id
        && removed.some(binding => binding.secretKey === entry.key)));
    }, true);
  }

  private passwordRow(file: SecretFile, entry: Entry) {
    return { id: entry.website!.id, revision: entry.website!.revision, site: websiteURL(entry.value.url).origin,
      connectedServices: file.bindings.filter(binding => binding.secretKey === entry.key).length };
  }

  private passwordProof(file: SecretFile, receipt: PasswordReceipt | undefined) {
    if (!receipt) return { outcome: "unconfirmed", receipt: null, password: null };
    const entry = file.entries.find(entry => entry.website?.id === receipt.id);
    const outcome = !entry ? receipt.operation === "delete" ? "committed" : "deleted"
      : entry.website!.revision === receipt.revision && receipt.operation !== "delete" ? "committed" : "superseded";
    return { outcome, receipt, password: entry ? this.passwordRow(file, entry) : null };
  }

  passwords() {
    return this.serial.run(async () => {
      await this.retryRead();
      return { available: true, passwords: this.file.entries.filter(entry => entry.website).map(entry => this.passwordRow(this.file, entry)) };
    });
  }

  loginFor(matches: (origin: string) => boolean) {
    return this.serial.run(async () => {
      await this.retryRead();
      const found = this.file.entries.filter(entry => entry.website && matches(websiteURL(entry.value.url).origin)).at(-1);
      return found ? { url: found.value.url!, username: found.value.username!, password: found.value.password! } : undefined;
    });
  }

  async saveLogin(url: string, username: string, password: string) {
    const origin = websiteURL(new URL(url).origin).origin;
    const existing = await this.serial.run(async () => {
      await this.retryRead();
      return this.file.entries.find(entry => entry.website && websiteURL(entry.value.url).origin === origin && entry.value.username === username);
    });
    if (existing) return this.changePassword("edit", { requestId: crypto.randomUUID(), expectedRevision: existing.website!.revision, confirm: true, password }, existing.website!.id);
    return this.changePassword("add", { id: crypto.randomUUID(), requestId: crypto.randomUUID(), url: origin, username, password });
  }

  passwordRequest(requestId: unknown) {
    if (!uuid(requestId)) throw invalidPassword();
    return this.serial.run(async () => {
      await this.retryRead();
      return this.passwordProof(this.file, this.file.websiteRequests?.find(receipt => receipt.requestId === requestId));
    });
  }

  changePassword(operation: PasswordOperation, value: unknown, id?: string) {
    const body = passwordBody(value, operation, id);
    return this.update(file => {
      const previous = file.websiteRequests?.find(receipt => receipt.requestId === body.requestId);
      if (previous) {
        if (previous.id !== body.id || previous.operation !== operation || previous.expectedRevision !== body.expectedRevision) {
          throw new PasswordError(409, "request_reused", "This request identity already belongs to another password change.");
        }
        return { replay: true, ...this.passwordProof(file, previous) };
      }
      if (file.secretRequests?.some(receipt => receipt.requestId === body.requestId)) throw new PasswordError(409, "request_reused", "This request identity already belongs to another credential change.");
      if ((file.websiteRequests?.length ?? 0) + (file.secretRequests?.length ?? 0) >= passwordLimits.receipts) throw new PasswordError(507, "store_full", "The credentials request history is full. No existing data was removed.");
      const entry = file.entries.find(entry => entry.website?.id === body.id);
      let committedRevision: number;
      if (operation === "add") {
        const key = `password.${body.id}`;
        if (entry || file.entries.some(entry => entry.key === key) || file.websiteRequests?.some(receipt => receipt.id === body.id)) {
          throw new PasswordError(409, "identity_used", "This password identity has already been used. No password was replaced.");
        }
        if (file.entries.filter(entry => entry.website).length >= passwordLimits.websites) throw new PasswordError(507, "store_full", "The password store is full. No existing password was removed.");
        const fields = websiteValue(body.fields as Record<string, string>);
        committedRevision = 1;
        const created: Entry = { key, displayName: websiteURL(fields.url).origin.slice(0, 80), origin: { kind: "named" }, type: "account",
          value: fields, website: { id: body.id, revision: committedRevision } };
        this.reviseIdentity(created); file.entries.push(created);
      } else {
        if (!entry) throw new PasswordError(404, "password_missing", "This password no longer exists. Refresh the store.");
        if (entry.website!.revision !== body.expectedRevision) throw new PasswordError(409, "revision_conflict", "This password changed on another page. Refresh before replacing or deleting it.");
        this.revise(entry);
        committedRevision = entry.website!.revision;
        if (operation === "delete") {
          file.entries = file.entries.filter(item => item !== entry);
          file.bindings = file.bindings.filter(binding => binding.secretKey !== entry.key);
        } else {
          entry.value = websiteValue({ ...entry.value, ...Object.fromEntries(Object.entries(body.fields).filter((field): field is [string, string] => typeof field[1] === "string" && field[1] !== "")) });
          entry.displayName = websiteURL(entry.value.url).origin.slice(0, 80);
        }
      }
      const receipt: PasswordReceipt = { requestId: body.requestId, id: body.id, operation, expectedRevision: body.expectedRevision, revision: committedRevision };
      (file.websiteRequests ??= []).push(receipt);
      return { replay: false, ...this.passwordProof(file, receipt) };
    }, true);
  }
}

export const apiIdentity = (repository: string, domain: string) => sha256(`${repository}:${domain}`);
export const apiFingerprint = (auth: unknown, baseURL: string, repository: string, domain: string) => sha256(canonicalJSON({ auth, baseURL, repository, domain }));

function parseSecret(values: Record<string, string>) {
  const text = values.value ?? "";
  const field = values.field?.trim();
  if (!field && text.trim().startsWith("{")) {
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { throw fail("invalid_argument", "The JSON object could not be read", "Enter valid JSON, or a single value."); }
    if (!isObject(parsed) || Object.values(parsed).some(value => typeof value !== "string")) throw fail("invalid_argument", "Every field in the JSON object must be text", "Use text values only.");
    return parsed as Record<string, string>;
  }
  return { [field || "value"]: text };
}

export function secretFunctions(context: VMContext, secrets: Secrets, approvals: Approvals) {
  const tracked = async (call: FunctionCall, action: string, args: Record<string, unknown>) => approvals.require(call, action, action.endsWith(".delete") ? "ask" : "allow", { args });
  return {
    "ox.secret.list": async (call: FunctionCall) => call.untimed(async () => {
      await tracked(call, "ox.secret.list", {});
      return secrets.list();
    }),
    "ox.secret.add": async (call: FunctionCall) => call.untimed(async () => {
      const key = String(call.args.key);
      const type = call.args.type, serviceID = call.args.serviceID;
      if (type !== undefined && !secretType(type)) throw fail("invalid_argument", "Choose a supported secret type", "Use account, apiKey or token.");
      if (serviceID !== undefined && (typeof serviceID !== "string" || !serviceID || !type)) {
        throw fail("invalid_argument", "A service-owned secret requires a type and service ID", "Provide type and a qualified service ID.");
      }
      await tracked(call, "ox.secret.add", { key });
      validateKey(key);
      if (key.startsWith("ox.")) throw fail("invalid_argument", "Secret key is reserved", "Choose a key that does not start with ox.");
      const existing = secrets.entry(key);
      const fields: PromptField[] = type ? [
        { name: "displayName", label: "Display name", optional: true },
        ...typedFields(type).map(field => ({ name: field, label: field === "username" ? "Username" : field === "password" ? "Password" : field === "apiKey" ? "API key" : "Token", secret: true })),
      ] : [
        { name: "displayName", label: "Display name", optional: true },
        { name: "field", label: "Field name, such as apiKey (default: value)", optional: true },
        { name: "value", label: "Secret value, or a JSON object of text fields", secret: true },
      ];
      let problem = "";
      for (let attempt = 0; attempt < 3; attempt++) {
        const answer = await call.ask({ kind: "form", title: existing ? "Edit Secret" : "Add Secret", submit: "Save", fields,
          body: `${problem ? `${problem}\n\n` : ""}Save the secret ${key}. The value stays on this Host and is never shown to the assistant.` });
        if (answer.kind !== "values") return { key, status: "cancelled" };
        try {
          let value: Record<string, string>;
          if (type) {
            value = {};
            for (const field of typedFields(type)) {
              const entered = answer.values[field];
              if (typeof entered !== "string" || !entered) throw fail("invalid_argument", `Enter a value for ${field}`, "Fill in every required secret field.");
              value[field] = entered;
            }
          } else value = parseSecret(answer.values);
          await secrets.set(key, answer.values.displayName?.trim() || existing?.displayName || key, value, { kind: "named" },
            type ? { type, ...(typeof serviceID === "string" ? { serviceID } : {}) } : undefined);
          context.logs.info("secrets", `secret saved key=${key} fields=${Object.keys(value).length}`);
          context.emit({ type: "secrets" });
          return { key, status: "saved" };
        } catch (error) {
          problem = error instanceof Error ? error.message : String(error);
        }
      }
      throw fail("invalid_argument", problem || "The secret could not be saved", "Ask the user whether to try again.");
    }),
    "ox.secret.delete": async (call: FunctionCall) => call.untimed(async () => {
      const key = String(call.args.key);
      if (!secrets.entry(key)) throw fail("not_found", "Secret entry was not found", "List secrets with ox.secret.list.");
      await tracked(call, "ox.secret.delete", { key });
      const answer = await call.ask({ kind: "choice", body: `Delete secret ${key}? Connections using it will need to be set up again.`, options: ["Delete", "Cancel"] });
      if (answer.kind !== "answer" || answer.text !== "Delete") return { key, status: "cancelled" };
      await secrets.delete(key);
      context.logs.info("secrets", `secret deleted key=${key}`);
      context.emit({ type: "secrets" });
      return { key, status: "deleted" };
    }),
  };
}

export function secretRoute(context: VMContext, secrets: Secrets): VMRoute {
  return async (request, _url, parts) => {
    const [key] = parts;
    const guarded = museParityEnabled();
    if (parts.length === 2 && key === "requests" && request.method === "GET") {
      if (!guarded) throw new HTTPError(404, "Not found");
      if (!sameOrigin(request)) throw new HTTPError(403, "Use this Host's paired workspace.");
      try { return json(await secrets.secretRequest(parts[1])); }
      catch (error) {
        if (error instanceof PasswordError) return json({ error: error.message, code: error.code }, { status: error.status });
        throw error;
      }
    }
    if (!key && request.method === "GET") {
      if (guarded) await secrets.verify();
      return json({ ...(guarded ? { requests: true } : {}), secrets: secrets.list(guarded).map(secret => ({
        key: secret.key, name: secret.displayName, fields: secret.fields, available: secret.available,
        ...(guarded ? { id: secret.id, revision: secret.revision } : {}),
      })) });
    }
    if ((!key && request.method === "POST") || (key && parts.length === 1 && request.method === "PUT")) {
      const body = await payload<Record<string, unknown>>(request);
      if (!isObject(body)) throw new HTTPError(400, "Send a valid credential request.");
      const target = key ?? (typeof body.key === "string" ? body.key.trim() : "");
      if (guarded && ["requestId", "expectedId", "expectedRevision"].some(field => field in body)) {
        if (!sameOrigin(request)) throw new HTTPError(403, "Use this Host's paired workspace.");
        if (!uuid(body.requestId) || !(body.expectedId === null && body.expectedRevision === 0 || uuid(body.expectedId) && revision(body.expectedRevision))
          || !key && body.expectedId !== null || Object.keys(body).some(field => !["key", "name", "fields", "requestId", "expectedId", "expectedRevision"].includes(field))) {
          throw new HTTPError(400, "Use a valid credential request identity and current revision.");
        }
        try {
          const result = await secrets.changeSecret({ key: target, operation: key ? "edit" : "add", requestId: body.requestId,
            expectedId: body.expectedId, expectedRevision: body.expectedRevision as number }, body.name, body.fields);
          if (!result.replay) {
            context.logs.info("secrets", `secret ${key ? "edited" : "added"} key=${target} revision=${result.receipt!.revision}`);
            context.emit({ type: "secrets" });
          }
          const { replay, ...proof } = result;
          return json({ ...proof, replayed: replay, inputApplied: !replay }, { status: !key && !replay ? 201 : 200 });
        } catch (error) {
          if (error instanceof PasswordError) return json({ error: error.message, code: error.code }, { status: error.status });
          if (error instanceof HTTPError) throw error;
          if ((error as { code?: string }).code === "invalid_argument") throw new HTTPError(400, error instanceof Error ? error.message : "Invalid credential.");
          throw error;
        }
      }
      const existing = secrets.entry(target);
      if (key && !existing) throw new HTTPError(404, "Secret not found");
      if (!key && existing) throw new HTTPError(409, "A secret with this key already exists");
      if (!isObject(body.fields) || Object.values(body.fields).some(value => typeof value !== "string")) throw new HTTPError(400, "Add at least one field");
      const value: Record<string, string> = {};
      for (const [field, entered] of Object.entries(body.fields as Record<string, string>)) {
        const name = field.trim();
        const kept = entered === "" ? existing?.value[name] : entered;
        if (!name || kept === undefined || kept === "") throw new HTTPError(400, name ? `Enter a value for ${name}` : "Name every field");
        value[name] = kept;
      }
      const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : existing?.displayName ?? target;
      try { await secrets.set(target, name, value, existing?.origin); }
      catch (error) { if (error instanceof HTTPError) throw error; throw new HTTPError(400, error instanceof Error ? error.message : String(error)); }
      context.logs.info("secrets", `secret ${key ? "edited" : "added"} key=${target} fields=${Object.keys(value).length}`);
      context.emit({ type: "secrets" });
      return json({ key: target, name: secrets.entry(target)!.displayName, fields: Object.keys(value).sort() }, { status: key ? 200 : 201 });
    }

    if (key && parts.length === 1 && request.method === "DELETE") {
      if (!secrets.entry(key)) throw new HTTPError(404, "Secret not found");
      await secrets.delete(key);
      context.logs.info("secrets", `secret deleted key=${key}`);
      context.emit({ type: "secrets" });
      return json({ deleted: true });
    }
    throw new HTTPError(404, "Not found");
  };
}

export function passwordRoute(context: VMContext, secrets: Secrets): VMRoute {
  return async (request, _url, parts) => {
    if (!museParityEnabled()) return json({ error: "Secure store is not enabled on this Host.", code: "disabled" }, { status: 404 });
    if (!sameOrigin(request)) return json({ error: "Use this Host's paired workspace.", code: "origin_denied" }, { status: 403 });
    try {
      if (!parts.length && request.method === "GET") return json(await secrets.passwords());
      if (parts.length === 2 && parts[0] === "requests" && request.method === "GET") return json(await secrets.passwordRequest(parts[1]));
      const operation = !parts.length && request.method === "POST" ? "add"
        : parts.length === 1 && request.method === "PATCH" ? "edit" : parts.length === 1 && request.method === "DELETE" ? "delete" : undefined;
      if (!operation) return json({ error: "Not found", code: "not_found" }, { status: 404 });
      const result = await secrets.changePassword(operation, await payload<unknown>(request, passwordLimits.request), parts[0]);
      if (!result.replay) {
        context.logs.info("secrets", `password ${operation} id=${result.receipt!.id} revision=${result.receipt!.revision}`);
        context.emit({ type: "secrets" });
      }
      const { replay, ...proof } = result;
      return json({ ...proof, replayed: replay, inputApplied: !replay }, { status: operation === "add" && !replay ? 201 : 200 });
    } catch (error) {
      if (error instanceof PasswordError) return json({ error: error.message, code: error.code }, { status: error.status });
      if (error instanceof HTTPError) return json({ error: error.status === 413 ? "Password requests are limited to 8 KiB." : "Send a valid password request.", code: "invalid_request" }, { status: error.status });
      return json({ error: "The password change could not be confirmed. Verify its request before trying another change.", code: "unconfirmed" }, { status: 503 });
    }
  };
}

import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { LinuxProfile, OxError } from "@openox/agent/linux";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import type { Host, HostContentSnapshot } from "./host";
import { museParityEnabled } from "./config";
import { sameOrigin } from "./auth";
import { bodyBytes, HTTPError, json, payload } from "./http";
import { memoryFileName, memoryImportLimits, readMemoryImport, type MemoryPreview } from "./memory-import";
import { contentHash } from "./vm/content-state";
import { zipEncode } from "./vm/skills-package";

const scope = {
  included: ["profile-content", "all-conversations-and-lineage", "profile-files-and-skills", "MEMORY-and-SOUL", "profile-retained-trash-staging-scratch",
    "todos-notices-review-watches-goals-library-discovery-identity-approval-history", "Pi-tasks-submissions-history", "VM-schedules-attachments-titles-scratch"],
  excluded: ["credentials-and-authority", "Host-Profile-identity-and-settings", "service-repository-and-skill-preferences", "installed-repository-definitions-and-skills",
    "browser-cookies-history-cache", "diagnostic-logs", "external-mounts-other-profiles", "independent-exports-backups", "third-party-data-OS-snapshots-forensic-erasure"],
};
const limits = { archive: 128 * 1_048_576, entry: 32 * 1_048_576, entries: 256, journal: 4 * 1_048_576, receipts: 500, confirmations: 2, confirmationTTL: 2 * 60_000 };
const vmContentPaths = ["vm/state/schedules.json", "vm/state/attachments.json", "vm/state/conversation-titles.json"];
const retainedVMNames = new Set(["secrets.json", "services.json", "skills.json", "action-policies.json", "repositories.json", ...vmContentPaths.map(path => path.split("/").at(-1)!)]);
const uuid = Type.String({ format: "uuid" }), hash = Type.String({ pattern: "^[0-9a-f]{64}$" }), count = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const counts = Type.Record(Type.String(), count);
const summarySchema = Type.Object({ deleted: counts, kept: counts }, { additionalProperties: false });
const entrySchema = Type.Object({ path: Type.String({ minLength: 1, maxLength: 4096 }), kind: Type.Union([Type.Literal("file"), Type.Literal("directory")]),
  bytes: count, sha256: Type.Union([hash, Type.Null()]), device: count, inode: count }, { additionalProperties: false });
const operationSchema = Type.Object({ requestId: uuid, deviceId: uuid, epoch: count, inventory: hash, confirmed: Type.Literal(true),
  phase: Type.Union([Type.Literal("confirmed"), Type.Literal("files"), Type.Literal("database"), Type.Literal("preparing")]),
  entries: Type.Array(entrySchema, { maxItems: 10_000 }), database: Type.Array(entrySchema, { maxItems: 3 }), progress: count,
  vm: Type.Record(Type.String(), Type.Union([hash, Type.Null()])), summary: summarySchema,
  settings: Type.Object({ revision: count, suggestionsEnabled: Type.Boolean() }, { additionalProperties: false }) }, { additionalProperties: false });
const receiptSchema = Type.Object({ requestId: uuid, deviceId: uuid, epoch: count, inventory: hash, phase: Type.Literal("completed"),
  summary: summarySchema, completedAt: Type.String({ format: "date-time" }) }, { additionalProperties: false });
const journalSchema = Type.Object({ version: Type.Literal(1), hostId: Type.String({ minLength: 1 }), profileId: Type.String({ minLength: 1 }), epoch: count,
  operation: Type.Union([operationSchema, Type.Null()]), receipts: Type.Array(receiptSchema, { maxItems: limits.receipts }) }, { additionalProperties: false });
type Journal = Static<typeof journalSchema>;
type Prepared = { requestId: string; deviceId: string; confirmationId: string; epoch: number; inventory: string; profileId: string;
  summary: Static<typeof summarySchema>; expires: number };
type Stage = { deviceId: string; epoch: number; preview: MemoryPreview; fileName: string; sha256: string; expires: number };
const strict = (value: unknown, keys: string[]): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).every(key => keys.includes(key));
const requestID = (value: unknown): string => {
  if (!Value.Check(uuid, value)) throw new HTTPError(400, "Use a request UUID.");
  return value.toLowerCase();
};
const encoded = (value: unknown) => new TextEncoder().encode(JSON.stringify(value, null, 2) + "\n");
const conflict = () => new HTTPError(409, "Workspace content or confirmation changed. Read a new summary before deciding.");
const unavailable = () => new HTTPError(503, "Content storage is unavailable. Reset is not confirmed complete; read its status or restart normally after access is restored.");
const storageError = (error: unknown) => {
  if (error instanceof HTTPError) return error;
  if (error instanceof OxError) return new HTTPError(error.code === "conflict" ? 409 : error.code === "limit_exceeded" ? 413 : 503, error.message);
  return (error as NodeJS.ErrnoException)?.code === "ENOSPC" ? new HTTPError(507, "Content storage is full. No complete result was produced.") : unavailable();
};

export class DataControls {
  private readonly host: Host;
  private journal: Journal | undefined;
  private readonly stages = new Map<string, Stage>();
  private readonly confirmations = new Map<string, Prepared>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private uploading = 0;
  failure = false;
  constructor(host: Host) { this.host = host; }
  get epoch() { return this.journal?.epoch ?? 0; }
  get pending() { return this.failure || !!this.journal?.operation; }
  private get directory() { return join(this.host.paths.profiles, this.host.settings.profile.id); }
  private get journalPath() { return join(this.directory, "state", "content-control.json"); }
  private initial(): Journal { return { version: 1, hostId: this.host.hostID, profileId: this.host.settings.profile.id, epoch: 0, operation: null, receipts: [] }; }
  private files() { return LinuxProfile.contentFilesAt(this.directory); }

  async load() {
    try {
      const parent = await lstat(join(this.directory, "state")).catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; });
      if (parent && (!parent.isDirectory() || parent.isSymbolicLink())) throw unavailable();
      const info = await lstat(this.journalPath).catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; });
      if (!info) { this.journal = this.initial(); this.failure = false; return; }
      if (!info.isFile() || info.isSymbolicLink() || info.size > limits.journal) throw unavailable();
      const handle = await open(this.journalPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      let value: unknown;
      try { value = JSON.parse(await handle.readFile("utf8")); } finally { await handle.close(); }
      if (!Value.Check(journalSchema, value) || value.hostId !== this.host.hostID || value.profileId !== this.host.settings.profile.id
        || new Set(value.receipts.map(receipt => receipt.requestId)).size !== value.receipts.length
        || value.operation && (value.operation.epoch !== value.epoch || value.operation.progress > value.operation.entries.length
          || Object.keys(value.operation.vm).some(path => !vmContentPaths.includes(path)))) throw unavailable();
      this.journal = value; this.failure = false;
    } catch (error) { this.failure = true; throw storageError(error); }
  }

  private async save(value: Journal) {
    if (!Value.Check(journalSchema, value)) throw unavailable();
    const data = encoded(value);
    if (data.length > limits.journal) throw new HTTPError(507, "The bounded Reset operation record is full. No deletion was authorized.");
    const state = join(this.directory, "state");
    await mkdir(state, { recursive: true, mode: 0o700 });
    const info = await lstat(state);
    if (!info.isDirectory() || info.isSymbolicLink()) throw unavailable();
    const path = join(state, `.content-control-${crypto.randomUUID()}`);
    try {
      const handle = await open(path, "wx", 0o600);
      try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
      await rename(path, this.journalPath);
      const parent = await open(state, constants.O_RDONLY);
      try { await parent.sync(); } finally { await parent.close(); }
      this.journal = structuredClone(value);
    } catch (error) {
      await unlink(path).catch(() => {});
      throw storageError(error);
    }
  }

  private async retainedInventory() {
    const entries = await readdir(join(this.directory, "vm", "state"), { withFileTypes: true });
    if (entries.some(entry => !entry.isFile() || entry.isSymbolicLink() || !retainedVMNames.has(entry.name))) {
      throw new HTTPError(409, "The VM state contains an unsupported or unsafe object. No incomplete content operation was accepted.");
    }
  }

  private async inventory(snapshot: HostContentSnapshot) {
    await this.retainedInventory();
    const entries = await this.files().inventory();
    for (const file of Object.values(snapshot.profile.files.files)) {
      const entry = entries.find(entry => entry.path === `files/${file.path}`);
      if (!entry || entry.kind !== "file" || entry.bytes !== file.size || entry.sha256 !== file.sha256) throw conflict();
    }
    const vm = Object.fromEntries(vmContentPaths.map(path => [path, snapshot.vm.files.find(file => file.path === path)?.data
      ? contentHash(snapshot.vm.files.find(file => file.path === path)!.data) : null]));
    const projection = { ...snapshot.profile, ...snapshot.vm.data };
    const inventory = contentHash(encoded({ entries, vm, projection }));
    const deleted = { conversations: projection.conversations.length, tasks: projection.tasks.length, files: entries.filter(entry => entry.kind === "file").length,
      todos: projection.todos.length, notices: projection.notifications.notifications.length, review: Object.keys(projection.review.records).length,
      watches: projection.watches.length, goals: projection.goals.length, spaces: projection.library.length,
      discoveryItems: projection.discovery.feed.length + projection.discovery.ideas.length, approvalHistory: projection.approvalHistory.length,
      schedules: ((snapshot.vm.data.schedules as { schedules: unknown[] } | undefined)?.schedules ?? []).length };
    const summary = { deleted, kept: { credentials: Number(snapshot.vm.data.keptCredentials ?? 0), profileIdentity: 1, HostSettings: 1,
      devices: (await this.host.devices.list()).length, reviewSettings: 1 } };
    return { entries, vm, projection, inventory, summary };
  }

  private expire() {
    const now = Date.now();
    for (const [id, stage] of this.stages) if (stage.expires < now) this.stages.delete(id);
    for (const [id, confirmation] of this.confirmations) if (confirmation.expires < now) this.confirmations.delete(id);
  }
  private stage(id: string, deviceId: string) {
    this.expire();
    const stage = this.stages.get(id);
    if (!stage || stage.deviceId !== deviceId || stage.epoch !== this.epoch) throw new HTTPError(404, "This import expired or is unavailable. Choose the file again.");
    return stage;
  }
  private clearStages() { this.stages.clear(); for (const timer of this.timers) clearTimeout(timer); this.timers.clear(); }

  private async upload(request: Request, url: URL, deviceId: string) {
    this.expire();
    if (this.uploading + this.stages.size >= memoryImportLimits.stages) throw new HTTPError(429, "Two private import previews are already open. Cancel one first.");
    const fileName = memoryFileName(url.searchParams.get("name") ?? "");
    this.uploading++;
    try {
      const bytes = await bodyBytes(request, memoryImportLimits.upload, "Memory history ZIPs are limited to 8 MiB.");
      const preview = readMemoryImport(bytes, fileName);
      request.signal.throwIfAborted();
      const token = crypto.randomUUID(), expires = Date.now() + memoryImportLimits.ttl;
      this.stages.set(token, { preview, fileName, sha256: contentHash(bytes), deviceId, epoch: this.epoch, expires });
      const timer = setTimeout(() => { this.stages.delete(token); this.timers.delete(timer); }, memoryImportLimits.ttl);
      timer.unref?.(); this.timers.add(timer);
      return json({ token, ...preview, fileName, expiresAt: new Date(expires).toISOString(), limits: memoryImportLimits }, { status: 201 });
    } finally { this.uploading--; }
  }

  private async candidates(request: Request, token: string, deviceId: string) {
    const stage = this.stage(token, deviceId), body = await payload<unknown>(request, 32 * 1024);
    if (!strict(body, ["requestId", "confirm", "facts"]) || body.confirm !== true || !Array.isArray(body.facts) || !body.facts.length
      || body.facts.length > memoryImportLimits.facts || body.facts.some(fact => !strict(fact, ["sourceId", "text"]) || typeof fact.text !== "string"
        || !fact.text.trim() || /[\r\n\0]/.test(fact.text) || fact.text.length > memoryImportLimits.fact
        || !stage.preview.sources.some(source => source.id === fact.sourceId))) throw new HTTPError(400, "Explicitly select and edit one to twenty source-linked, single-line facts.");
    request.signal.throwIfAborted();
    const result = await this.host.profile.review.importMemory(requestID(body.requestId),
      { format: stage.preview.format, fileName: stage.fileName, sha256: stage.sha256, selectedCount: body.facts.length }, body.facts);
    this.stages.delete(token);
    this.host.emit({ type: "review" });
    return json(result, { status: result.replayed ? 200 : 201 });
  }

  private async prepare(request: Request, deviceId: string) {
    const body = await payload<unknown>(request, 4096);
    if (!strict(body, ["requestId"])) throw new HTTPError(400, "Send only the Reset request identity.");
    const id = requestID(body.requestId);
    await this.load(); this.expire();
    if (this.journal!.receipts.some(receipt => receipt.requestId === id)) throw conflict();
    if (this.confirmations.size >= limits.confirmations || this.journal!.receipts.length >= limits.receipts) throw new HTTPError(507, "The bounded Reset confirmation or receipt capacity was reached.");
    const result = await this.host.withContentIdle(async snapshot => {
      const current = await this.inventory(snapshot);
      const prepared: Prepared = { requestId: id, deviceId, confirmationId: crypto.randomUUID(), profileId: this.host.settings.profile.id,
        epoch: this.epoch, inventory: current.inventory, summary: current.summary, expires: Date.now() + limits.confirmationTTL };
      request.signal.throwIfAborted();
      this.confirmations.set(id, prepared);
      return { ...prepared, deviceId: undefined, expiresAt: new Date(prepared.expires).toISOString(), scope, limits, phrase: "RESET" };
    });
    return json(result, { status: 201 });
  }

  private async confirm(request: Request, id: string, deviceId: string) {
    const body = await payload<unknown>(request, 4096);
    this.expire(); await this.load();
    const prepared = this.confirmations.get(id);
    if (!prepared || prepared.deviceId !== deviceId || !strict(body, ["confirmationId", "inventory", "profileId", "epoch", "confirm", "phrase"])
      || body.confirm !== true || body.phrase !== "RESET" || body.confirmationId !== prepared.confirmationId || body.inventory !== prepared.inventory
      || body.profileId !== prepared.profileId || body.epoch !== prepared.epoch || prepared.epoch !== this.epoch) throw conflict();
    return json(await this.host.withContentIdle(async snapshot => {
      const current = await this.inventory(snapshot);
      if (current.inventory !== prepared.inventory) throw conflict();
      const record = structuredClone(this.journal!);
      record.operation = { requestId: id, deviceId, epoch: this.epoch, inventory: current.inventory, confirmed: true, phase: "confirmed",
        entries: [...current.entries.filter(entry => entry.kind === "file"), ...current.entries.filter(entry => entry.kind === "directory").sort((a, b) => b.path.length - a.path.length)],
        database: await this.files().database(), progress: 0, vm: current.vm, summary: current.summary, settings: snapshot.profile.review.settings };
      request.signal.throwIfAborted();
      try {
        await this.save(record);
        this.confirmations.clear(); this.clearStages();
        await this.recover();
        return this.status(id);
      } catch (error) {
        await this.load().catch(() => {});
        throw storageError(error);
      }
    }));
  }

  async recover() {
    const record = structuredClone(this.journal);
    if (!record?.operation) return;
    const operation = record.operation;
    const progress = async () => { await this.save(record); this.host.logs.info("data-controls", `reset request=${operation.requestId} phase=${operation.phase} progress=${operation.progress}`); };
    if (operation.phase === "confirmed") {
      await this.retainedInventory();
      await this.host.resetVMContent(operation.vm);
      operation.phase = "files"; await progress();
    }
    if (operation.phase === "files") {
      for (; operation.progress < operation.entries.length;) {
        await this.files().erase(operation.entries[operation.progress]!);
        operation.progress++; await progress();
      }
      const remaining = await this.files().inventory();
      if (remaining.length) throw conflict();
      operation.phase = "database"; await progress();
    }
    if (operation.phase === "database") {
      for (const entry of operation.database) await this.files().erase(entry);
      operation.phase = "preparing"; await progress();
    }
    await LinuxProfile.prepareContentReset({ directory: this.directory, profileID: this.host.settings.profile.id, models: this.host.providers.models }, operation.settings);
    const remaining = await this.files().inventory();
    if (!remaining.some(entry => entry.path === "files/MEMORY.md" && entry.kind === "file" && entry.bytes === 0)
      || remaining.some(entry => entry.path !== "files/MEMORY.md" && !(entry.path === "files/conversations" && entry.kind === "directory"))) throw conflict();
    record.epoch++;
    record.receipts.push({ requestId: operation.requestId, deviceId: operation.deviceId, epoch: record.epoch, inventory: operation.inventory,
      summary: operation.summary, phase: "completed", completedAt: new Date().toISOString() });
    record.operation = null;
    await this.save(record);
    this.host.active = null;
  }

  private async status(id: string) {
    await this.load();
    const operation = this.journal!.operation;
    if (operation?.requestId === id) return { requestId: id, epoch: this.epoch, inventory: operation.inventory, phase: operation.phase,
      confirmed: true, summary: operation.summary, scope, complete: false };
    const receipt = this.journal!.receipts.find(receipt => receipt.requestId === id);
    return receipt ? { ...receipt, deviceId: undefined, confirmed: true, scope, complete: true }
      : { requestId: id, phase: "unconfirmed", confirmed: false, complete: false };
  }

  private async export(request: Request) {
    const archive = await this.host.withContentIdle(async snapshot => {
      const current = await this.inventory(snapshot), files = [];
      const inventory = [...current.entries, ...await this.files().database()];
      for (const entry of inventory.filter(entry => entry.kind === "file")) {
        files.push({ path: entry.path.startsWith("state/state.sqlite") ? `profile/${entry.path.slice("state/".length)}` : `profile/${entry.path}`,
          data: await this.files().read(entry) });
      }
      files.push(...snapshot.vm.files.map(file => ({ path: file.path, data: file.data })), { path: "content.json", data: encoded(current.projection) });
      if (files.length + 1 > limits.entries || files.some(file => file.data.length > limits.entry)
        || files.reduce((bytes, file) => bytes + file.data.length, 0) > limits.archive) throw new HTTPError(413, "The complete export exceeds 128 MiB, 32 MiB per entry or 256 entries. Nothing was truncated.");
      if (JSON.stringify(await this.files().inventory()) !== JSON.stringify(current.entries)
        || contentHash(encoded((await this.host.vmContentSnapshot()).data)) !== contentHash(encoded(snapshot.vm.data))) throw conflict();
      request.signal.throwIfAborted();
      const manifest = { packageVersion: 1, profileId: this.host.settings.profile.id, hostId: this.host.hostID, exportedAt: new Date().toISOString(), contentEpoch: this.epoch,
        componentVersions: { Host: this.host.version, Profile: "linux-1", files: 2, review: 2, todos: 1, notifications: 1, watches: 1, goals: 1,
          library: 1, discovery: 1, identity: 1, approvalHistory: 1, schedules: 1, PiDurable: "1.5.2" },
        scope, limits, inventory: current.inventory, summary: current.summary, restoreSupported: false,
        database: "Complete original Profile SQLite checkpoint, including hidden lineage, tasks, submissions and retained content history; not a device/account backup.",
        files: files.map(file => ({ path: file.path, bytes: file.data.length, sha256: contentHash(file.data) })) };
      return zipEncode([{ path: "manifest.json", data: encoded(manifest) }, ...files], limits.archive,
        () => new HTTPError(413, "The complete content ZIP exceeds its declared archive limit."));
    });
    this.host.logs.info("data-controls", `export bytes=${archive.length}`);
    return new Response(archive, { headers: { "content-type": "application/vnd.openox.content+zip", "cache-control": "no-store",
      "content-disposition": 'attachment; filename="OpenOx-content.zip"', "content-security-policy": "sandbox" } });
  }

  async route(request: Request, url: URL, parts: string[], deviceId: string): Promise<Response> {
    if (!museParityEnabled()) throw new HTTPError(404, "Not found");
    if (!sameOrigin(request)) throw new HTTPError(403, "Use this Host's paired workspace origin.");
    try {
      if (!parts.length && request.method === "GET") {
        await this.load();
        return json({ version: 1, profileId: this.host.settings.profile.id, epoch: this.epoch, collector: { available: false, sending: false }, scope, limits,
          importLimits: memoryImportLimits, resetPending: this.pending, restoreSupported: false });
      }
      if (parts[0] === "imports") {
        if (parts[1] === "requests" && parts.length === 3 && request.method === "GET") {
          return await this.host.withContentRequest(request, false, async () => json(await this.host.profile.review.importStatus(requestID(parts[2]))));
        }
        return await this.host.withContentRequest(request, true, async () => {
          if (parts.length === 1 && request.method === "POST") return this.upload(request, url, deviceId);
          const stage = this.stage(parts[1] ?? "", deviceId);
          if (parts.length === 2 && request.method === "GET") return json({ token: parts[1], ...stage.preview, fileName: stage.fileName });
          if (parts.length === 2 && request.method === "DELETE") { this.stages.delete(parts[1]!); return json({ cancelled: true }); }
          if (parts.length === 3 && parts[2] === "candidates" && request.method === "POST") return this.candidates(request, parts[1]!, deviceId);
          throw new HTTPError(404, "Not found");
        });
      }
      if (parts[0] === "exports" && parts.length === 1 && request.method === "POST") return await this.export(request);
      if (parts[0] === "resets") {
        if (parts.length === 1 && request.method === "POST") return await this.prepare(request, deviceId);
        const id = requestID(parts[1]);
        if (parts.length === 2 && request.method === "GET") return json(await this.status(id));
        if (parts.length === 2 && request.method === "DELETE") {
          const confirmation = this.confirmations.get(id);
          if (confirmation?.deviceId === deviceId) this.confirmations.delete(id);
          return json({ cancelled: true, confirmed: false });
        }
        if (parts.length === 3 && parts[2] === "confirm" && request.method === "POST") return await this.confirm(request, id, deviceId);
      }
      throw new HTTPError(404, "Not found");
    } catch (error) { throw storageError(error); }
  }
  close() { this.clearStages(); this.confirmations.clear(); }
}

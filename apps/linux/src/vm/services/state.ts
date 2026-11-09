import { join } from "node:path";
import { readJSONFile, Serial, writeJSONFile, type Kind } from "./support";

interface PreferencesFile { format: 1; names: Record<string, string>; saved: string[]; bundledEnabled: boolean }
export interface AttachmentRecord { domain: string; kind: Kind; repository: string; version: string }
interface AttachmentsFile { conversations: Record<string, AttachmentRecord[]> }

export class Preferences {
  private path: string;
  private file: PreferencesFile = { format: 1, names: {}, saved: [], bundledEnabled: true };
  private serial = new Serial();

  constructor(state: string) { this.path = join(state, "services.json"); }

  async load() {
    const stored = await readJSONFile<Partial<PreferencesFile>>(this.path, {});
    this.file = { format: 1, names: stored.names ?? {}, saved: Array.isArray(stored.saved) ? stored.saved : [], bundledEnabled: stored.bundledEnabled !== false };
  }

  name(domain: string) { return this.file.names[domain]; }
  saved(domain: string) { return this.file.saved.includes(domain); }
  get bundledEnabled() { return this.file.bundledEnabled; }
  snapshot() { return { format: 1, names: { ...this.file.names }, saved: [...this.file.saved] }; }

  update(change: (file: PreferencesFile) => void) {
    return this.serial.run(async () => {
      const next = structuredClone(this.file);
      change(next);
      await writeJSONFile(this.path, next);
      this.file = next;
    });
  }

  setSaved(domain: string, saved: boolean) {
    if (this.saved(domain) === saved) return Promise.resolve();
    return this.update(file => { file.saved = saved ? [...file.saved, domain].sort() : file.saved.filter(entry => entry !== domain); });
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

  removeConversation(conversation: number) {
    return this.update(file => { delete file.conversations[String(conversation)]; });
  }
}

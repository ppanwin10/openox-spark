import { join } from "node:path";
import { readJSONFile, Serial, writeJSONFile } from "./services/support";

interface PreferenceFile { disabled: string[]; used: Record<string, number> }

const stores = new Map<string, Promise<SkillPreferences>>();

export class SkillPreferences {
  private readonly path: string;
  private readonly serial = new Serial();
  private disabledNames = new Set<string>();
  private usedAt = new Map<string, number>();

  private constructor(state: string) { this.path = join(state, "skills.json"); }

  static open(state: string) {
    let store = stores.get(state);
    if (!store) {
      const created = new SkillPreferences(state);
      store = created.load().then(() => created);
      store.catch(() => stores.delete(state));
      stores.set(state, store);
    }
    return store;
  }

  private async load() {
    const stored = await readJSONFile<Partial<PreferenceFile>>(this.path, {});
    this.disabledNames = new Set((Array.isArray(stored.disabled) ? stored.disabled : []).filter((name): name is string => typeof name === "string"));
    this.usedAt = new Map(Object.entries(stored.used && typeof stored.used === "object" ? stored.used : {})
      .filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1])));
  }

  disabled(): ReadonlySet<string> { return this.disabledNames; }
  enabled(name: string) { return !this.disabledNames.has(name); }
  lastUsed(name: string) { return this.usedAt.get(name) ?? null; }

  setEnabled(name: string, enabled: boolean) { return this.update(disabled => { if (enabled) disabled.delete(name); else disabled.add(name); }); }
  markUsed(name: string, at = Date.now()) { return this.update((_, used) => { used.set(name, at); }); }
  forget(name: string) { return this.update((disabled, used) => { disabled.delete(name); used.delete(name); }); }

  private update(change: (disabled: Set<string>, used: Map<string, number>) => void) {
    return this.serial.run(async () => {
      const disabled = new Set(this.disabledNames), used = new Map(this.usedAt);
      change(disabled, used);
      await writeJSONFile(this.path, { disabled: [...disabled].sort(), used: Object.fromEntries([...used].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) });
      this.disabledNames = disabled;
      this.usedAt = used;
    });
  }
}

import { lstat, mkdir, readFile, readlink, realpath, rm } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { chromium, type BrowserContext } from "playwright-core";
import { createJSON, readJSON, writeJSON } from "../../config";
import { processBirth, processDetails } from "../../process-info";

type Identity = { pid: number; birth: string };
type Owner = { version: 1; machine: string; profile: string; tag: string; host: Identity; browser: Identity | null };
type LaunchOptions = NonNullable<Parameters<typeof chromium.launchPersistentContext>[1]>;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const identity = (value: unknown): value is Identity => object(value) && Number.isSafeInteger(value.pid) && Number(value.pid) > 0
  && Number(value.pid) <= 2_147_483_647 && typeof value.birth === "string" && value.birth.length > 0 && value.birth.length <= 128;
const uuid = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9-]{36}$/.test(value);
const describe = (error: unknown) => error instanceof Error ? error.message : String(error);
const invalid = () => new Error("The browser ownership proof is invalid or belongs to another profile. No unverified process was stopped.");
const unproven = () => new Error("The browser process ownership could not be verified. No unverified process was stopped.");

export class BrowserOwnership {
  private readonly requested: string;
  private readonly warning: (message: string) => void;
  private profile = "";
  private prepared?: Promise<string>;
  private current?: Owner;
  private tail: Promise<void> = Promise.resolve();

  constructor(profile: string, warning: (message: string) => void) { this.requested = profile; this.warning = warning; }
  private get path() { return join(this.profile, ".openox-owner.json"); }
  private serial<T>(work: () => Promise<T>) {
    const next = this.tail.then(work);
    this.tail = next.then(() => {}, error => this.warning(`browser ownership: ${describe(error)}`));
    return next;
  }
  private async exists(path: string) {
    try { return await lstat(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }
  private async read() {
    const info = await this.exists(this.path);
    if (!info) return null;
    if (!info.isFile() || info.isSymbolicLink() || info.mode & 0o077 || info.uid !== process.getuid?.() || info.size > 16_384) throw invalid();
    let value: unknown;
    try { value = JSON.parse(await readFile(this.path, "utf8")); }
    catch (error) { if (error instanceof SyntaxError) throw invalid(); throw error; }
    if (!object(value) || value.version !== 1 || value.machine !== hostname() || value.profile !== this.profile || !uuid(value.tag)
      || !identity(value.host) || value.browser !== null && !identity(value.browser)) throw invalid();
    return value as Owner;
  }
  private async lockPID() {
    try {
      const target = await readlink(join(this.profile, "SingletonLock")), match = /-(\d+)$/.exec(target);
      if (!match || !Number.isSafeInteger(Number(match[1])) || Number(match[1]) <= 0) throw unproven();
      return Number(match[1]);
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }
  private matches(command: string, owner: Owner) {
    const tag = `--openox-browser-owner=${owner.tag}`, profile = `--user-data-dir=${owner.profile}`;
    const start = command.indexOf(profile), end = start + profile.length;
    return command.split(/\s+/).includes(tag) && start >= 0 && (end === command.length || command.slice(end).startsWith(" --"));
  }
  private async browser(owner: Owner) {
    const pid = owner.browser?.pid ?? await this.lockPID();
    if (!pid) return null;
    const current = await processDetails(pid);
    if (!current) return null;
    if (owner.browser && owner.browser.birth !== current.birth || !this.matches(current.command, owner)) throw unproven();
    return current;
  }
  private async signal(owner: Owner, signal: NodeJS.Signals) {
    const current = await this.browser(owner);
    if (!current) return false;
    try { process.kill(current.pid, signal); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
    return true;
  }
  private async wait(owner: Owner, timeout: number) {
    const deadline = Date.now() + timeout;
    while (await this.browser(owner)) {
      if (Date.now() >= deadline) return false;
      await Bun.sleep(100);
    }
    return true;
  }
  private async retire(owner: Owner) {
    const stored = await this.read();
    if (!stored || stored.tag !== owner.tag) return;
    if (stored.host.pid !== owner.host.pid || stored.host.birth !== owner.host.birth) throw invalid();
    if (await this.signal(stored, "SIGTERM") && !await this.wait(stored, 5_000)) {
      await this.signal(stored, "SIGKILL");
      if (!await this.wait(stored, 2_000)) throw new Error("The owned browser did not stop. Its ownership proof was retained.");
    }
    const final = await this.read();
    if (!final || final.tag !== owner.tag) throw invalid();
    await rm(this.path);
    if (this.current?.tag === owner.tag) this.current = undefined;
  }
  prepare() {
    this.prepared ??= this.serial(async () => {
      if (!["darwin", "linux"].includes(process.platform)) throw new Error("Owned browser recovery is unavailable on this platform.");
      await mkdir(this.requested, { recursive: true, mode: 0o700 });
      const info = await lstat(this.requested);
      if (!info.isDirectory() || info.isSymbolicLink() || info.mode & 0o077 || info.uid !== process.getuid?.()) throw invalid();
      this.profile = await realpath(this.requested);
      if (await this.exists(`${this.path}.recovery`)) throw new Error("Browser recovery is already running or was interrupted. Its proof was retained.");
      const owner = await this.read();
      if (!owner) {
        const pid = await this.lockPID();
        if (pid && await processDetails(pid)) throw unproven();
        return this.profile;
      }
      if (await processBirth(owner.host.pid) === owner.host.birth) throw new Error("This browser profile belongs to a running Host. It was not replaced.");
      const guard = `${this.path}.recovery`, tag = crypto.randomUUID();
      try { await createJSON(guard, { tag, pid: process.pid }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("Browser recovery is already running or was interrupted. Its proof was retained.");
        throw error;
      }
      try {
        const current = await this.read();
        if (!current || current.tag !== owner.tag || await processBirth(current.host.pid) === current.host.birth) throw invalid();
        await this.retire(current);
        this.warning("recovered an abandoned owned browser profile");
      } finally {
        const current = await readJSON<{ tag: string }>(guard, { tag: "" });
        if (current.tag !== tag) throw invalid();
        await rm(guard);
      }
      return this.profile;
    }).catch(error => { this.prepared = undefined; throw error; });
    return this.prepared;
  }
  async launch(options: LaunchOptions): Promise<BrowserContext> {
    const profile = await this.prepare();
    return this.serial(async () => {
      if (this.current) await this.retire(this.current);
      const birth = await processBirth(process.pid);
      if (!birth) throw unproven();
      const owner: Owner = { version: 1, machine: hostname(), profile, tag: crypto.randomUUID(), host: { pid: process.pid, birth }, browser: null };
      await createJSON(this.path, owner);
      this.current = owner;
      let context: BrowserContext | undefined;
      try {
        context = await chromium.launchPersistentContext(profile, { ...options, args: [...options.args ?? [], `--openox-browser-owner=${owner.tag}`] });
        const browser = await this.browser(owner);
        if (!browser) throw unproven();
        const current = await this.read();
        if (!current || current.tag !== owner.tag) throw invalid();
        const tracked: Owner = { ...owner, browser: { pid: browser.pid, birth: browser.birth } };
        await writeJSON(this.path, tracked); this.current = tracked;
        context.on("close", () => { void this.serial(() => this.retire(tracked)).catch(error => this.warning(describe(error))); });
        return context;
      } catch (error) {
        const failures = [error];
        if (context) { try { await context.close(); } catch (failure) { failures.push(failure); } }
        try { await this.retire(this.current ?? owner); } catch (failure) { failures.push(failure); }
        if (failures.length > 1) throw new AggregateError(failures, "Owned browser launch and cleanup failed; ownership proof was retained.");
        throw error;
      }
    });
  }
  async close() {
    await this.serial(async () => { if (this.current) await this.retire(this.current); });
  }
}

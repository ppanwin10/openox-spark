import { join } from "node:path";
import { LinuxProfile, type ModelChoice } from "@openox/agent/linux";
import { hostPaths, loadSettings, prepareDirectories, writeJSON, type CustomProvider, type HostPaths, type HostSettings } from "./config";
import { Logger } from "./logs";
import { Providers, customProviderID } from "./providers";
import { Devices } from "./auth";
import { BrowserManager } from "./vm/browser/manager";
import type { VMContext, VMEvent } from "./vm/context";
import { createVM } from "./vm/index";
import { factories } from "./vm/modules";
import { allowTestOrigins } from "./vm/net";

export type HostEvent = { type: "conversation"; id: number } | { type: "settings" } | { type: "devices" } | VMEvent;
export interface HostOptions { data: string; hostID: string; version: string; quiet?: boolean }

const describe = (error: unknown) => error instanceof Error ? error.stack ?? error.message : String(error);

async function servedContext(baseUrl: string, models: string[], key?: string) {
  try {
    const response = await fetch(`${baseUrl}/models`, { headers: key ? { authorization: `Bearer ${key}` } : {}, redirect: "error", signal: AbortSignal.timeout(5_000) });
    if (!response.ok) return undefined;
    const listed = ((await response.json()) as { data?: { id?: unknown; max_model_len?: unknown }[] }).data ?? [];
    const lengths = listed.filter(entry => models.includes(String(entry.id))).map(entry => Number(entry.max_model_len)).filter(length => Number.isSafeInteger(length) && length >= 4_096);
    return lengths.length ? Math.min(...lengths) : undefined;
  } catch { return undefined; }
}

export class Host {
  readonly paths: HostPaths;
  readonly logs: Logger;
  readonly providers: Providers;
  readonly devices: Devices;
  readonly hostID: string;
  readonly version: string;
  settings: HostSettings;
  profile!: LinuxProfile;
  browser!: BrowserManager;
  active: number | null = null;
  private vm?: Awaited<ReturnType<typeof createVM>>;
  private listeners = new Set<(event: HostEvent) => void>();
  private changes = new Set<number>();
  private timer?: ReturnType<typeof setTimeout>;
  private watcher?: ReturnType<typeof setInterval>;

  private constructor(options: HostOptions, paths: HostPaths, logs: Logger, settings: HostSettings, providers: Providers, devices: Devices) {
    this.paths = paths;
    this.logs = logs;
    this.settings = settings;
    this.providers = providers;
    this.devices = devices;
    this.hostID = options.hostID;
    this.version = options.version;
  }

  static async open(options: HostOptions) {
    const paths = hostPaths(options.data);
    await prepareDirectories(paths);
    const logs = new Logger(paths.logs, options.quiet);
    const settings = await loadSettings(paths);
    const providers = await Providers.open(paths.credentials, settings.custom);
    const devices = await Devices.open(paths);
    const host = new Host(options, paths, logs, settings, providers, devices);
    allowTestOrigins((process.env.OX_HOST_TEST_ORIGINS ?? "").split(",").map(origin => origin.trim()).filter(Boolean));
    const directory = join(paths.profiles, settings.profile.id), root = join(directory, "vm");
    host.browser = new BrowserManager({ userDataDir: join(root, "browser"), onChange: () => host.emit({ type: "pages" }), onWarning: message => logs.warning("browser", message) });
    const context: VMContext = {
      hostID: options.hostID, logs, providers, browser: host.browser,
      paths: { root, state: join(root, "state"), browser: join(root, "browser"), repositories: join(root, "repositories"), local: join(root, "repositories", "local"),
        bundled: join(import.meta.dir, "..", "..", "shared", "Resources", "OxServices.bundle"), scratch: join(root, "scratch") },
      profile: () => host.profile, settings: () => host.settings, updateSettings: change => host.updateSettings(change),
      defaultModel: () => host.defaultModel(), emit: event => host.emit(event),
    };
    host.vm = await createVM(context, factories);
    host.profile = await LinuxProfile.open({ directory, profileID: settings.profile.id, hostID: options.hostID, functions: host.vm.functions,
      models: providers.models, onChange: id => host.changed(id), onReport: error => logs.error("agent", describe(error)) });
    await host.vm.start();
    logs.info("host", `Profile ${settings.profile.id} opened`);
    host.watcher = setInterval(() => {
      void devices.changed().then(changed => { if (changed) host.emit({ type: "devices" }); }, error => logs.warning("devices", describe(error)));
    }, 5_000);
    return host;
  }

  route(group: string) { return Object.hasOwn(this.vm?.routes ?? {}, group) ? this.vm!.routes[group] : undefined; }

  subscribe(listener: (event: HostEvent) => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  emit(event: HostEvent) {
    for (const listener of this.listeners) {
      try { listener(event); } catch (error) { this.logs.warning("events", describe(error)); }
    }
  }

  changed(id: number) {
    this.changes.add(id);
    this.timer ??= setTimeout(() => {
      this.timer = undefined;
      const ids = [...this.changes];
      this.changes.clear();
      for (const changed of ids) this.emit({ type: "conversation", id: changed });
    }, 100);
  }

  defaultModel(): ModelChoice | undefined {
    const stored = this.settings.defaultModel;
    if (stored && this.providers.configured(stored.provider) && this.providers.models.getModel(stored.provider, stored.modelId)) return stored;
    return this.providers.available()[0];
  }

  async updateSettings(change: Partial<HostSettings>) {
    this.settings = { ...this.settings, ...change };
    await writeJSON(this.paths.settings, this.settings);
    this.emit({ type: "settings" });
  }

  async setCustomProvider(custom: CustomProvider | undefined, key?: string) {
    if (custom) {
      const url = new URL(custom.baseUrl);
      if (!["http:", "https:"].includes(url.protocol)) throw new Error("Use an http:// or https:// endpoint");
      const models = [...new Set(custom.models.map(model => model.trim()).filter(Boolean))];
      if (!models.length || models.length > 50 || models.some(model => model.length > 200)) throw new Error("List 1-50 model IDs served by the endpoint");
      const baseUrl = url.toString().replace(/\/+$/, "");
      const contextWindow = await servedContext(baseUrl, models, key || await this.providers.key(customProviderID));
      custom = { baseUrl, models, ...(custom.name?.trim() ? { name: custom.name.trim().slice(0, 60) } : {}), ...(custom.images ? { images: true } : {}), ...(contextWindow ? { contextWindow } : {}) };
    }
    this.providers.setCustom(custom);
    const defaultModel = this.settings.defaultModel?.provider === customProviderID && !custom ? undefined : this.settings.defaultModel;
    await this.updateSettings({ custom, defaultModel });
  }

  async close() {
    if (this.timer) clearTimeout(this.timer);
    if (this.watcher) clearInterval(this.watcher);
    await this.vm?.close();
    await this.profile.close();
    await this.browser.shutdown();
    await this.logs.flush();
  }
}

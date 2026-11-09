import { join } from "node:path";
import { LinuxProfile, type ModelChoice, type StreamUpdate } from "@openox/agent/linux";
import { hostPaths, loadSettings, prepareDirectories, writeJSON, type CustomProvider, type HostPaths, type HostSettings, type LocalMachine } from "./config";
import { Logger } from "./logs";
import { Providers, customProviderID, localMachines, machinePrefix, withSendTimes, withoutMachine } from "./providers";
import { MediaClient } from "./media";
import { Devices } from "./auth";
import { BrowserManager } from "./vm/browser/manager";
import type { VMContext, VMEvent } from "./vm/context";
import { createVM } from "./vm/index";
import { factories } from "./vm/modules";
import { allowTestOrigins } from "./vm/net";

export type HostEvent = { type: "conversation"; id: number } | ({ type: "stream"; id: number } & StreamUpdate) | { type: "settings" } | { type: "devices" } | VMEvent;
export interface HostOptions { data: string; hostID: string; version: string; quiet?: boolean }

const describe = (error: unknown) => error instanceof Error ? error.stack ?? error.message : String(error);

type Listed = { id?: unknown; root?: unknown; max_model_len?: unknown };

async function listedModels(baseUrl: string, key?: string) {
  const response = await fetch(`${baseUrl}/models`, { headers: key ? { authorization: `Bearer ${key}` } : {}, redirect: "error", signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return (((await response.json()) as { data?: Listed[] }).data ?? []).filter(entry => typeof entry.id === "string" && entry.id);
}

async function servedContext(baseUrl: string, models: string[], key?: string) {
  try {
    const lengths = (await listedModels(baseUrl, key)).filter(entry => models.includes(String(entry.id))).map(entry => Number(entry.max_model_len))
      .filter(length => Number.isSafeInteger(length) && length >= 4_096);
    return lengths.length ? Math.min(...lengths) : undefined;
  } catch { return undefined; }
}

function weightGroups(listed: Listed[]) {
  const groups = new Map<string, { weights: string; ids: string[]; contextLength: number | null }>();
  for (const entry of listed) {
    const id = String(entry.id);
    const root = typeof entry.root === "string" && entry.root ? entry.root : id;
    const group = groups.get(root) ?? { weights: root.split("/").filter(Boolean).at(-1) ?? id, ids: [], contextLength: null };
    group.ids.push(id);
    const length = Number(entry.max_model_len);
    if (Number.isSafeInteger(length) && length > 0) group.contextLength = length;
    groups.set(root, group);
  }
  return [...groups.values()];
}

function unreachable(address: string, failure: unknown) {
  const message = failure instanceof Error ? `${failure.name} ${failure.message}` : String(failure);
  const status = /HTTP (\d{3})/.exec(message)?.[1];
  if (status) return `${address} answered with HTTP ${status}. Check the address; most model servers use a path ending in /v1.`;
  if (/TimeoutError|timed? ?out/i.test(message)) return `${address} didn't answer within 5 seconds. Check that the computer is on and its model server is running.`;
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo|DNS/i.test(message)) return `No computer called ${address} was found on the network. Check the name.`;
  return `Couldn't connect to ${address}. Check the address and that its model server is running.`;
}

export function machineURL(address: string) {
  const trimmed = address.trim();
  if (!trimmed) throw new Error("Enter the machine's address");
  let url: URL;
  try { url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`); } catch { throw new Error("Enter an address such as spark-2:8000 or http://192.168.1.20:11434"); }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Use an http:// or https:// address");
  if (url.pathname === "/" || !url.pathname) url.pathname = "/v1";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
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
  readonly media = new MediaClient();
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
    const providers = await Providers.open(paths.credentials, localMachines(settings));
    const devices = await Devices.open(paths);
    const host = new Host(options, paths, logs, settings, providers, devices);
    allowTestOrigins((process.env.OX_HOST_TEST_ORIGINS ?? "").split(",").map(origin => origin.trim()).filter(Boolean));
    const directory = join(paths.profiles, settings.profile.id), root = join(directory, "vm");
    host.browser = new BrowserManager({ userDataDir: join(root, "browser"), onChange: () => host.emit({ type: "pages" }), onWarning: message => logs.warning("browser", message) });
    const context: VMContext = {
      hostID: options.hostID, version: options.version, logs, providers, browser: host.browser,
      paths: { root, state: join(root, "state"), browser: join(root, "browser"), repositories: join(root, "repositories"), local: join(root, "repositories", "local"),
        bundled: join(import.meta.dir, "..", "..", "shared", "Resources", "OxServices.bundle"), scratch: join(root, "scratch") },
      profile: () => host.profile, settings: () => host.settings, updateSettings: change => host.updateSettings(change),
      defaultModel: () => host.defaultModel(), emit: event => host.emit(event),
    };
    host.vm = await createVM(context, factories);
    host.profile = await LinuxProfile.open({ directory, profileID: settings.profile.id, hostID: options.hostID, functions: host.vm.functions,
      models: withSendTimes(providers.models), onChange: id => host.changed(id), onStream: (id, update) => host.emit({ type: "stream", id, ...update }),
      onReport: error => logs.error("agent", describe(error)) });
    await host.vm.start();
    logs.info("host", `Profile ${settings.profile.id} opened`);
    host.watcher = setInterval(() => {
      void devices.changed().then(changed => { if (changed) host.emit({ type: "devices" }); }, error => logs.warning("devices", describe(error)));
    }, 5_000);
    return host;
  }

  route(group: string) { return Object.hasOwn(this.vm?.routes ?? {}, group) ? this.vm!.routes[group] : undefined; }
  async attachedServices(conversationId: number) { return await this.vm?.functions.attachedServices?.(conversationId) ?? []; }
  async invokeSkill(name: string, conversationId: number) { return await this.vm?.invokeSkill(name, conversationId); }

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

  async servedModels() {
    const machines = await Promise.all(localMachines(this.settings).map(async machine => {
      try {
        const groups = weightGroups(await listedModels(machine.baseUrl, await this.providers.key(machine.id)));
        return { ...this.machineSummary(machine), error: null, served: groups.map(group => ({ ...group, added: group.ids.filter(id => machine.models.includes(id)) })) };
      } catch (failure) { return { ...this.machineSummary(machine), error: unreachable(new URL(machine.baseUrl).host, failure), served: [] }; }
    }));
    return { machines, media: await this.media.health() };
  }

  private machineSummary(machine: LocalMachine) {
    return { id: machine.id, name: machine.name ?? null, baseUrl: machine.baseUrl, images: !!machine.images, local: ["127.0.0.1", "localhost", "[::1]"].includes(new URL(machine.baseUrl).hostname) };
  }

  async pairMachine(request: { address: string; name?: string; key?: string; images?: boolean }) {
    const baseUrl = machineURL(request.address);
    if (localMachines(this.settings).some(machine => machine.baseUrl === baseUrl)) throw new Error("This machine is already paired");
    let listed: Listed[];
    try { listed = await listedModels(baseUrl, request.key); }
    catch (failure) { throw new Error(unreachable(new URL(baseUrl).host, failure)); }
    const models = weightGroups(listed).slice(0, 20).map(group => {
      const weights = group.weights.toLowerCase();
      return group.ids.filter(id => weights.includes(id.toLowerCase())).sort((a, b) => b.length - a.length)[0] ?? group.ids[0]!;
    });
    if (!models.length) throw new Error(`${new URL(baseUrl).host} answered, but serves no models`);
    const id = `${machinePrefix}${crypto.randomUUID().slice(0, 8)}`;
    const name = request.name?.trim() || new URL(baseUrl).hostname;
    await this.saveMachine(id, { baseUrl, models, name, images: request.images === true }, request.key);
    if (request.key) await this.providers.setKey(id, request.key);
    this.logs.info("settings", `machine paired id=${id} models=${models.length}`);
    return { id, name, models };
  }

  async saveMachine(id: string, value: CustomProvider | undefined, key?: string) {
    let machine: CustomProvider | undefined;
    if (value) {
      const url = new URL(value.baseUrl);
      if (!["http:", "https:"].includes(url.protocol)) throw new Error("Use an http:// or https:// endpoint");
      const models = [...new Set(value.models.map(model => model.trim()).filter(Boolean))];
      if (!models.length || models.length > 50 || models.some(model => model.length > 200)) throw new Error("List 1-50 model IDs served by the endpoint");
      const baseUrl = url.toString().replace(/\/+$/, "");
      const previous = localMachines(this.settings).find(entry => entry.id === id);
      if (previous && previous.baseUrl !== baseUrl && !key) await this.providers.setKey(id, null).catch(() => {});
      const contextWindow = await servedContext(baseUrl, models, key || await this.providers.key(id));
      machine = { baseUrl, models, ...(value.name?.trim() ? { name: value.name.trim().slice(0, 60) } : {}), ...(value.images ? { images: true } : {}), ...(contextWindow ? { contextWindow } : {}) };
    }
    const change: Partial<HostSettings> = !machine ? withoutMachine(this.settings, id) : id === customProviderID ? { custom: machine }
      : { machines: (this.settings.machines ?? []).some(entry => entry.id === id) ? this.settings.machines!.map(entry => entry.id === id ? { id, ...machine! } : entry) : [...this.settings.machines ?? [], { id, ...machine }] };
    this.providers.setMachines(localMachines({ ...this.settings, ...change }));
    await this.updateSettings(change);
  }

  async removeMachine(id: string) {
    if (!localMachines(this.settings).some(machine => machine.id === id)) throw new Error(`Machine not found: ${id}`);
    await this.providers.setKey(id, null).catch(() => {});
    await this.saveMachine(id, undefined);
    this.logs.info("settings", `machine removed id=${id}`);
  }

  async setCustomProvider(custom: CustomProvider | undefined, key?: string) {
    if (custom) await this.saveMachine(customProviderID, custom, key);
    else if (this.settings.custom) await this.saveMachine(customProviderID, undefined);
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

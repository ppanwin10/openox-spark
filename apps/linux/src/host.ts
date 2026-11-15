import { join } from "node:path";
import { LinuxProfile, OxError, stableID, type FunctionCall, type ModelChoice, type PromptRequest, type RunOutcome, type StreamUpdate } from "@openox/agent/linux";
import { hostPaths, loadSettings, museParityEnabled, personalAgentEnabled, prepareDirectories, writeJSON, type CustomProvider, type HostPaths, type HostSettings, type LocalMachine } from "./config";
import { Logger } from "./logs";
import { Providers, customProviderID, localMachines, machinePrefix, withSendTimes, withoutMachine } from "./providers";
import { MediaClient } from "./media";
import { Notifications, noticeText, preview, type Notice } from "./notifications";
import { Inbox } from "./inbox";
import { cookieName, Devices } from "./auth";
import { BrowserManager } from "./vm/browser/manager";
import type { VMContext, VMEvent } from "./vm/context";
import { createVM } from "./vm/index";
import { PageCalls } from "./page-calls";
import { factories } from "./vm/modules";
import { allowTestOrigins } from "./vm/net";
import type { LocalConnection } from "./connections";
import { DataControls } from "./data-controls";
import { GlobalSearch } from "./global-search";
import { HTTPError } from "./http";
import { Approvals } from "./vm/approvals";
import { canonicalJSON, sha256 } from "./vm/services/support";

export type HostEvent = { type: "conversation"; id: number } | ({ type: "stream"; id: number } & StreamUpdate) | { type: "settings" } | { type: "devices" }
  | { type: "content"; epoch: number } | VMEvent;
export interface HostOptions { data: string; hostID: string; version: string; quiet?: boolean; browserCookieName?: string }
export type HostContentSnapshot = { profile: Awaited<ReturnType<LinuxProfile["contentSnapshot"]>>; vm: Awaited<ReturnType<Awaited<ReturnType<typeof createVM>>["contentSnapshot"]>> };

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
  readonly browserCookieName: string;
  settings: HostSettings;
  profile!: LinuxProfile;
  browser!: BrowserManager;
  localConnection: LocalConnection | null = null;
  localWorkspaceOrigin: string | null = null;
  readonly media = new MediaClient();
  notifications!: Notifications;
  private inbox?: Inbox;
  readonly pageCalls = new PageCalls({ handler: name => this.vm?.functions.handlers[name], profile: () => this.profile,
    authorizePage: (call, previous) => this.pageAuthority(call, previous),
    released: async owner => { await this.vm?.functions.conversationRemoved?.(owner); } });
  active: number | null = null;
  private vm?: Awaited<ReturnType<typeof createVM>>;
  private listeners = new Set<(event: HostEvent) => void>();
  private changes = new Set<number>();
  private timer?: ReturnType<typeof setTimeout>;
  private watcher?: ReturnType<typeof setInterval>;
  private settingsWrites: Promise<void> = Promise.resolve();
  readonly dataControls: DataControls;
  readonly globalSearch = new GlobalSearch(this);
  private contentPhase: "open" | "holding" | "resuming" | "failed" = "open";
  private contentRequests = 0;

  private constructor(options: HostOptions, paths: HostPaths, logs: Logger, settings: HostSettings, providers: Providers, devices: Devices) {
    this.paths = paths;
    this.logs = logs;
    this.settings = settings;
    this.providers = providers;
    this.devices = devices;
    this.hostID = options.hostID;
    this.version = options.version;
    this.browserCookieName = options.browserCookieName ?? cookieName;
    this.dataControls = new DataControls(this);
  }

  static async open(options: HostOptions) {
    if (options.browserCookieName !== undefined && !/^[A-Za-z0-9_]{1,80}$/.test(options.browserCookieName)) throw new Error("Invalid browser cookie name");
    const paths = hostPaths(options.data);
    await prepareDirectories(paths);
    const logs = new Logger(paths.logs, options.quiet);
    const settings = await loadSettings(paths);
    const providers = await Providers.open(paths.credentials, localMachines(settings));
    const devices = await Devices.open(paths);
    const host = new Host(options, paths, logs, settings, providers, devices);
    host.notifications = await Notifications.open(join(paths.data, "push.json"), logs, (process.env.OX_HOST_TEST_PUSH ?? "").split(",").map(origin => origin.trim()).filter(Boolean));
    if (personalAgentEnabled()) host.inbox = new Inbox(() => host.profile.inbox, host.notifications, logs, () => host.emit({ type: "notifications" }));
    await host.notifications.keep(new Set((await devices.list()).map(device => device.id)));
    host.subscribe(event => {
      if (event.type === "devices") void devices.list().then(list => host.notifications.keep(new Set(list.map(device => device.id)))).catch(error => logs.warning("notifications", describe(error)));
    });
    allowTestOrigins((process.env.OX_HOST_TEST_ORIGINS ?? "").split(",").map(origin => origin.trim()).filter(Boolean));
    const directory = join(paths.profiles, settings.profile.id), root = join(directory, "vm");
    try { await host.dataControls.load(); }
    catch {
      host.contentPhase = "failed";
      logs.warning("data-controls", "Confirmed content-operation storage is unavailable; content consumers and workers remain gated.");
      return host;
    }
    host.browser = new BrowserManager({ userDataDir: join(root, "browser"), ownedRecovery: personalAgentEnabled(),
      onChange: () => host.emit({ type: "pages" }), onWarning: message => logs.warning("browser", message) });
    await host.browser.prepare();
    const context: VMContext = {
      hostID: options.hostID, version: options.version, logs, providers, browser: host.browser,
      paths: { root, state: join(root, "state"), browser: join(root, "browser"), repositories: join(root, "repositories"), local: join(root, "repositories", "local"),
        bundled: join(import.meta.dir, "..", "..", "shared", "Resources", "OxServices.bundle"), scratch: join(root, "scratch") },
      profile: () => host.profile, submit: (...args) => host.submit(...args), settings: () => host.settings, updateSettings: change => host.updateSettings(change),
      defaultModel: () => host.defaultModel(), emit: event => host.emit(event), notify: notice => host.notify(notice),
      notificationProblem: () => host.inbox?.failure ?? null,
      contentBlocked: () => host.contentPhase === "holding" || host.contentPhase === "failed",
      contentEpoch: () => host.contentEpoch, withContentEpoch: (epoch, work) => host.withRPCContent(epoch, work),
      ownerActive: async owner => (await host.devices.list()).some(device => device.id === owner),
      serviceDependencies: domain => host.vm!.serviceDependencies(domain),
      permissionSchedules: () => host.vm!.permissionSchedules(),
      familiarWebVisit: url => host.vm!.familiarWebVisit(url),
      spaceConnectionProof: domain => host.vm!.spaceConnectionProof(domain),
      spaceTask: call => host.vm!.spaceTask(call),
    };
    host.vm = await createVM(context, factories);
    if (host.dataControls.pending) {
      host.contentPhase = "holding";
      try { await host.dataControls.recover(); }
      catch {
        host.contentPhase = "failed";
        logs.warning("data-controls", "Confirmed Reset remains incomplete; no content worker or Profile execution was started.");
        return host;
      }
      host.contentPhase = "open";
    }
    host.profile = await LinuxProfile.open({ directory, profileID: settings.profile.id, hostID: options.hostID, functions: host.vm.functions,
      retainMovedReferences: museParityEnabled(),
      ...(museParityEnabled() ? { messageActionsEpoch: () => host.contentEpoch } : {}),
      identityEnabled: museParityEnabled(), onApprovalRecorded: () => host.emit({ type: "approvalHistory" }),
      models: withSendTimes(providers.models), onChange: id => host.changed(id), onStream: (id, update) => host.emit({ type: "stream", id, ...update }),
      onSettled: (id, outcome, requestID) => host.finished(id, outcome, requestID), onAttention: (id, kind) => host.attention(id, kind),
      onReport: error => logs.error("agent", describe(error)) });
    await host.inbox?.start();
    await host.vm.start();
    logs.info("host", `Profile ${settings.profile.id} opened`);
    host.watcher = setInterval(() => {
      void devices.changed().then(changed => { if (changed) host.emit({ type: "devices" }); }, error => logs.warning("devices", describe(error)));
    }, 5_000);
    return host;
  }

  get contentEpoch() { return this.dataControls.epoch; }
  async withContentRequest<T>(request: Request, mutation: boolean, work: () => Promise<T>) {
    if (this.contentPhase === "failed") throw new HTTPError(503, "Confirmed content recovery is incomplete. Read Data controls status before continuing.");
    if (this.contentPhase !== "open") throw new HTTPError(409, "A content operation holds this workspace. Wait for its verified result.");
    if (mutation && this.contentEpoch > 0 && request.headers.get("x-openox-content-epoch") !== String(this.contentEpoch)) {
      throw new HTTPError(409, "This request belongs to an old or unknown content epoch. Reload before creating new content.");
    }
    this.contentRequests++;
    try { return await work(); } finally { this.contentRequests--; }
  }
  async withRPCContent<T>(epoch: number, work: () => Promise<T>) {
    if (epoch !== this.contentEpoch || this.contentPhase !== "open") throw new HTTPError(409, "The workspace changed or is held by a content operation. Reconnect before continuing.");
    this.contentRequests++;
    try { return await work(); } finally { this.contentRequests--; }
  }
  async vmContentSnapshot() {
    if (!this.vm) throw new HTTPError(503, "Content recovery is incomplete.");
    return this.vm.contentSnapshot();
  }
  async resetVMContent(expected: Record<string, string | null>) {
    if (!this.vm) throw new HTTPError(503, "The original VM content owners are unavailable.");
    await this.pageCalls.resetContent();
    await this.vm.resetContent(expected);
  }
  async withContentIdle<T>(work: (snapshot: HostContentSnapshot) => Promise<T>) {
    if (this.contentPhase === "failed" || this.dataControls.pending) throw new HTTPError(503, "Confirmed content recovery is incomplete. Read its status.");
    if (this.contentPhase !== "open" || this.contentRequests) throw new HTTPError(409, "Another workspace request is active. Wait before a content operation.");
    this.contentPhase = "holding";
    const epoch = this.contentEpoch;
    let paused = false;
    try {
      if (this.profile.contentBusy || this.vm?.contentBusy() || this.browser.list().length || this.pageCalls.contentBusy || this.inbox?.contentBusy) {
        throw new HTTPError(409, "A model, worker or HTML/browser page is active. Finish or explicitly stop it first.");
      }
      await this.profile.contentFiles().database();
      await this.profile.contentSnapshot();
      if (this.vm?.contentBusy() || this.browser.list().length || this.pageCalls.contentBusy || this.inbox?.contentBusy) {
        throw new HTTPError(409, "A model, worker or HTML/browser page is active. Finish or explicitly stop it first.");
      }
      paused = true;
      await this.vm!.pauseContent();
      await this.inbox?.close();
      const snapshot = { profile: await this.profile.contentSnapshot(), vm: await this.vmContentSnapshot() };
      await this.profile.suspendContent();
      return await work(snapshot);
    } finally {
      if (this.dataControls.pending) this.contentPhase = "failed";
      else if (paused) {
        this.contentPhase = "resuming";
        try {
          await this.profile.resumeContent();
          await this.vm!.start();
          if (personalAgentEnabled()) {
            this.inbox = new Inbox(() => this.profile.inbox, this.notifications, this.logs, () => this.emit({ type: "notifications" }));
            await this.inbox.start();
          }
          this.contentPhase = "open";
          if (this.contentEpoch !== epoch) this.emit({ type: "content", epoch: this.contentEpoch });
        } catch {
          this.contentPhase = "failed";
          throw new HTTPError(503, "The original content owners could not resume. Restart normally; no content work was replayed.");
        }
      } else this.contentPhase = "open";
    }
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

  private notify(notice: Notice) {
    if (!this.inbox) { this.notifications.notify(notice); return; }
    void this.inbox.publish({ ...notice, id: notice.id ?? crypto.randomUUID() }).catch(error => this.inbox?.report(error));
  }

  finished(id: number, outcome: RunOutcome, requestID?: string) {
    if (outcome.outcome !== "completed") return;
    const body = preview(outcome.text ?? "");
    void this.profile.summary(id).then(summary => {
      if (!summary.temporary) this.notify({ ...(this.inbox && requestID ? { id: stableID(`notification:${this.profile.id}:${id}:${requestID}`) } : {}), tag: `conversation-${id}`, url: `/#/c/${id}`, urgency: "normal",
        title: () => summary.title, body: language => body || noticeText(language, "finished") });
    }, error => this.logs.warning("notifications", describe(error)));
  }

  attention(id: number, kind: PromptRequest["kind"]) {
    const text = kind === "approval" ? "approval" : kind === "page" ? "login" : "input";
    void this.profile.summary(id).then(summary => this.notify({ tag: `conversation-${id}`, url: `/#/c/${id}`, urgency: "high",
      title: () => summary.title, body: language => noticeText(language, text) }), error => this.logs.warning("notifications", describe(error)));
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
  submit(id: number, text: string, attachments: string[] = [], origin?: Parameters<LinuxProfile["send"]>[3], requestID: string = crypto.randomUUID(),
    schedule?: { id: string; active(): boolean }, submission?: Parameters<LinuxProfile["send"]>[5]) {
    const approvals = Approvals.for(join(this.paths.profiles, this.settings.profile.id, "vm/state"));
    return approvals.withTask(id, requestID, schedule, () => this.profile.send(id, text, attachments, origin, requestID, submission));
  }
  private async pageAuthority(call: FunctionCall, previous?: string) {
    if (!museParityEnabled()) return "";
    const snapshot = async () => {
      await this.profile.syncLibrary();
      const spaces = (await this.profile.library.listSpaces()).filter(space => space.entryPath === call.page!.path)
        .sort((a, b) => a.id.localeCompare(b.id));
      const opened = await this.profile.openFile(call.page!.path);
      if (opened.entry.size > 32 * 1024 * 1024) throw new OxError("permission_denied", "This page exceeds its original HTML boundary.");
      const fingerprint = sha256(canonicalJSON({ file: sha256(await opened.file.bytes()),
        spaces: spaces.map(space => ({ id: space.id, fileId: space.fileId, data: space.dataGrants ?? [], connections: space.connections ?? [] })) }));
      if (call.page?.source) {
        const current = await this.profile.spaceOpening(call.page.path, sha256(await opened.file.bytes()));
        if (canonicalJSON(current) !== canonicalJSON(call.page.source)) throw new OxError("permission_denied", "This frame's original code or grants changed. Explicitly reload the Space.");
      }
      return { spaces, fingerprint };
    };
    const initial = await snapshot();
    const denied = () => new OxError("permission_denied", "The Space or its original file changed. Reopen it before making a new service request.");
    if (previous !== undefined && previous !== initial.fingerprint) throw denied();
    const approvals = Approvals.for(join(this.paths.profiles, this.settings.profile.id, "vm/state"));
    for (const space of initial.spaces) await approvals.require(call, `ox.space.bridge:${space.id}`, "ask", { title: "Space service access",
      body: "Allow this Space to use the original service bridge? Each connector action still needs its own permission." });
    if ((await snapshot()).fingerprint !== initial.fingerprint) throw denied();
    await approvals.guard(call);
    return initial.fingerprint;
  }

  async updateSettings(change: Partial<HostSettings>) {
    const write = this.settingsWrites.then(async () => {
      const next = { ...this.settings, ...change };
      await writeJSON(this.paths.settings, next);
      this.settings = next;
      this.emit({ type: "settings" });
    });
    this.settingsWrites = write.catch(() => {});
    return write;
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
    await this.inbox?.close();
    await this.settingsWrites;
    this.dataControls.close();
    await this.profile?.close();
    await this.browser?.shutdown();
    await this.logs.flush();
  }
}

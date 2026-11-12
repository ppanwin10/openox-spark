import { createPrivateKey, X509Certificate } from "node:crypto";
import { lookup } from "node:dns/promises";
import { mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { Devices } from "../src/auth";
import { Host } from "../src/host";
import { startServer } from "../src/server";
import { checkLocalAddress } from "../src/connections";
import { hostPaths, loadSettings, prepareDirectories, writeJSON, type HostSettings } from "../src/config";
import { Logger } from "../src/logs";
import { machinePrefix } from "../src/providers";
import type { ConsoleContext, ConsoleRuntimeState } from "./mac-host-console";
import metadata from "../package.json";

type Prepared = { hostname: string; address: string; port: number };
type Resources = { host?: Host; server?: Awaited<ReturnType<typeof startServer>>; model?: ReturnType<typeof Bun.serve> };
const testProvider = `${machinePrefix}mac-lan-test`;
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export async function readMacIdentity(identity: string) {
  const prepared = JSON.parse(await readFile(join(identity, "host.json"), "utf8")) as Prepared;
  if (!/^[a-z0-9][a-z0-9.-]+\.[a-z]{2,}$/i.test(prepared.hostname) || !Number.isInteger(prepared.port) || prepared.port < 1024 || prepared.port > 65535) {
    throw new Error("The prepared Host name/port is invalid; ask engineering to repair this test identity");
  }
  const cert = await readFile(join(identity, "fullchain.pem"), "utf8");
  return { prepared, cert, certificate: new X509Certificate(cert) };
}

export async function validateMacIdentity(identity: string) {
  const value = await readMacIdentity(identity), { prepared, certificate } = value;
  checkLocalAddress(prepared.address);
  for (const name of ["", "server.key", "fullchain.pem", "host.json"]) {
    if ((await stat(join(identity, name))).mode & 0o077) throw new Error("The prepared identity must be readable by its owner only");
  }
  const key = await readFile(join(identity, "server.key"), "utf8");
  if (certificate.ca || !certificate.checkHost(prepared.hostname) || !certificate.checkPrivateKey(createPrivateKey(key))
    || Date.parse(certificate.validFrom) > Date.now() || Date.parse(certificate.validTo) <= Date.now()) {
    throw new Error("The test TLS identity is expired, mismatched or invalid; it was not replaced or bypassed");
  }
  const addresses = await lookup(prepared.hostname, { all: true });
  if (!addresses.length || addresses.some(entry => entry.address !== prepared.address)) {
    throw new Error("Test DNS does not resolve only to this Mac's prepared private interface; wait for DNS or ask engineering to update it");
  }
  return { ...value, key };
}

export class MacHostRuntime implements ConsoleContext {
  readonly hostID = "Mac LAN Test Host";
  readonly version = metadata.version;
  readonly paths;
  readonly logs: Logger;
  readonly origin: string;
  readonly certificateExpires: string;
  private resources: Resources = {};
  private data: string;
  private identity: string;
  private prepared: Prepared;
  private deviceStore: Devices;
  private settingsValue: HostSettings;
  private workspaceOrigin: string | null = null;
  private status: ConsoleRuntimeState = { kind: "stopped" };
  private generation = 0;
  private pending: Promise<void> = Promise.resolve();
  readonly lifecycle = { state: () => this.status, revision: () => this.generation, start: () => this.start(), stop: () => this.stop() };

  private constructor(data: string, identity: string, prepared: Prepared, settings: HostSettings, devices: Devices, certificate: X509Certificate) {
    this.data = data; this.identity = identity; this.prepared = prepared;
    this.paths = hostPaths(data); this.settingsValue = settings; this.deviceStore = devices;
    this.logs = new Logger(this.paths.logs, true);
    this.origin = `https://${prepared.hostname}:${prepared.port}`;
    this.certificateExpires = certificate.validTo;
  }

  static async open(data: string, identity: string) {
    const { prepared, certificate } = await readMacIdentity(identity);
    await mkdir(data, { recursive: true, mode: 0o700 });
    if ((await stat(data)).mode & 0o077) throw new Error("The test data directory needs owner-only permissions");
    const paths = hostPaths(data);
    const existing = await stat(paths.settings).then(() => true, error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    });
    await prepareDirectories(paths);
    const settings = await loadSettings(paths);
    if (!existing) { settings.profile.name = "Mac LAN Test"; await writeJSON(paths.settings, settings); }
    return new MacHostRuntime(data, identity, prepared, settings, await Devices.open(paths), certificate);
  }

  get settings() { return this.resources.host?.settings ?? this.settingsValue; }
  get devices() { return this.resources.host?.devices ?? this.deviceStore; }
  get notifications() { return { webSessions: (id: string) => this.resources.host?.notifications.webSessions(id) ?? 0 }; }
  get localWorkspaceOrigin() { return this.workspaceOrigin; }
  set localWorkspaceOrigin(value: string | null) {
    this.workspaceOrigin = value;
    if (this.resources.host) this.resources.host.localWorkspaceOrigin = value;
    if (!value) this.devices.clearWorkspaceGrants();
  }
  emit(event: { type: "devices" }) { this.resources.host?.emit(event); }
  private setState(state: ConsoleRuntimeState) { this.status = state; this.generation++; }

  start() {
    if (this.status.kind === "running") return Promise.resolve();
    if (this.status.kind === "starting" || this.status.kind === "stopping") throw new Error("A Host operation is already in progress");
    if (this.status.kind === "failed" && this.status.action === "stop") throw new Error("Finish stopping this Host before starting it again");
    this.setState({ kind: "starting" });
    this.pending = this.startRuntime();
    return this.pending;
  }

  private async startRuntime() {
    try {
      const { prepared, cert, key } = await validateMacIdentity(this.identity);
      if (prepared.hostname !== this.prepared.hostname || prepared.address !== this.prepared.address || prepared.port !== this.prepared.port) {
        throw new Error("The prepared connection changed. Close and reopen this console before starting the Host.");
      }
      this.settingsValue = await loadSettings(this.paths);
      const selected = this.settingsValue.defaultModel;
      if (selected && (selected.provider !== testProvider || selected.modelId !== "lan-connection-test")) {
        throw new Error("This workspace selects another model. The test bundle will not call or replace it; use a dedicated test data folder");
      }
      const event = (content: string, done = false) => `data: ${JSON.stringify({ id: "mac-lan-test", object: "chat.completion.chunk", created: 0,
        model: "lan-connection-test", choices: [{ index: 0, delta: { content }, finish_reason: done ? "stop" : null }] })}\n\n`;
      this.resources.model = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
        const path = new URL(request.url).pathname;
        if (request.method === "GET" && path === "/v1/models") return Response.json({ object: "list", data: [{ id: "lan-connection-test", object: "model" }] });
        if (request.method !== "POST" || path !== "/v1/chat/completions") return new Response("Not found", { status: 404 });
        await request.json();
        return new Response(event("【连接测试回复，不是 AI 推理】这台 Mac 已收到请求。对话保存在 Mac 的测试工作区。")
          + event("", true) + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
      } });
      const host = this.resources.host = await Host.open({ data: this.data, hostID: this.hostID, version: this.version, quiet: true });
      this.deviceStore = host.devices;
      host.localWorkspaceOrigin = this.workspaceOrigin;
      await host.saveMachine(testProvider, { name: "连接测试 · 脚本回复", baseUrl: `http://127.0.0.1:${this.resources.model.port}/v1`, models: ["lan-connection-test"] });
      await host.updateSettings({ defaultModel: host.providers.validChoice({ provider: testProvider, modelId: "lan-connection-test" }) });
      host.localConnection = { url: this.origin, hostId: host.settings.profile.id, hostname: this.prepared.hostname, discovery: "unavailable" };
      this.resources.server = await startServer(host, { hostname: this.prepared.address, port: this.prepared.port, tls: { cert, key } });
      const response = await fetch(`${this.origin}/api/health`, { signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error("The system-trusted LAN check failed");
      this.setState({ kind: "running" });
      this.logs.info("console", "Host started by the local operator");
    } catch (error) {
      let failure = error;
      try { await this.release(); }
      catch (cleanup) { failure = new AggregateError([error, cleanup], `${message(error)}; Host cleanup also failed: ${message(cleanup)}`); }
      this.setState({ kind: "failed", action: Object.keys(this.resources).length ? "stop" : "start", message: message(failure) });
      this.logs.error("console", message(failure));
      throw failure;
    }
  }

  stop() {
    if (this.status.kind === "stopped") return Promise.resolve();
    if (this.status.kind === "starting" || this.status.kind === "stopping") throw new Error("A Host operation is already in progress");
    this.setState({ kind: "stopping" });
    this.pending = this.stopRuntime();
    return this.pending;
  }

  private async stopRuntime() {
    try {
      await this.release();
      this.setState({ kind: "stopped" });
      this.logs.info("console", "Host stopped by the local operator; data and authorizations retained");
    } catch (error) {
      this.setState({ kind: "failed", action: "stop", message: message(error) });
      this.logs.error("console", message(error));
      throw error;
    }
  }

  private async release() {
    const failures: unknown[] = [];
    if (this.resources.host) {
      this.settingsValue = this.resources.host.settings;
      this.resources.host.localWorkspaceOrigin = null;
      this.resources.host.devices.clearWorkspaceGrants();
    }
    for (const key of ["server", "host", "model"] as const) {
      try {
        if (key === "host") await this.resources.host?.close();
        else await this.resources[key]?.stop(true);
        delete this.resources[key];
      } catch (error) { failures.push(error); this.logs.error("console", `Cannot close owned ${key}: ${message(error)}`); }
    }
    if (failures.length) throw new AggregateError(failures, "The Host could not finish stopping; retry Stop and inspect local diagnostics");
  }

  async close() {
    const [operation] = await Promise.allSettled([this.pending]);
    if (operation.status === "rejected") this.logs.warning("console", `Closing after a failed Host operation: ${message(operation.reason)}`);
    await this.stop();
    await this.logs.flush();
  }
}

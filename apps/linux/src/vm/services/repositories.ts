import { lookup } from "node:dns/promises";
import { existsSync } from "node:fs";
import { lstat, readdir, rename, rm } from "node:fs/promises";
import { isIP } from "node:net";
import { join } from "node:path";
import type { FunctionCall, FunctionHandler } from "@openox/agent/linux";
import { HTTPError, json, payload } from "../../http";
import type { VMContext, VMRoute } from "../context";
import { allowsURL, isPublicAddress, isTestURL, resolvesPublic } from "../net";
import { loadRepositoryState, type ConnectedRepository } from "../repository-state";
import { validatePackageDirectory, type RepositoryEntry } from "./catalog";
import { updateRepositoryState } from "./local";
import type { Services } from "./manager";
import { defaultPolicy } from "./policy";
import { describe, fail, fileHashes, Serial, type JSONObject } from "./support";

const cloneLimit = 200 * 1024 * 1024, cloneTimeout = 120_000;

async function directorySize(root: string): Promise<number> {
  let total = 0;
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) total += await directorySize(path);
    else total += await lstat(path).then(info => info.size, () => 0);
  }
  return total;
}

export function validateOrigin(origin: string) {
  let url: URL;
  try { url = new URL(origin); } catch { throw fail("invalid_argument", "ox.repository.connect: use a public HTTPS Git URL without credentials or a fragment", "Pass an https:// Git URL."); }
  if ((url.protocol !== "https:" && !isTestURL(url)) || !url.hostname || url.username || url.password || url.hash || !allowsURL(url)) {
    throw fail("invalid_argument", "ox.repository.connect: use a public HTTPS Git URL without credentials or a fragment", "Pass an https:// Git URL.");
  }
  return url;
}

export class Repositories {
  private context: VMContext;
  private services: Services;
  private serial = new Serial();

  constructor(context: VMContext, services: Services) {
    this.context = context;
    this.services = services;
  }

  private async git(args: string[], options: { cwd?: string; limit?: string; signal?: AbortSignal; extra?: string[] } = {}) {
    const environment: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: this.context.paths.scratch, LANG: "C", GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_ASKPASS: "/bin/false", SSH_ASKPASS: "/bin/false", GCM_INTERACTIVE: "never" };
    const child = Bun.spawn(["git", "-c", "credential.helper=", "-c", "core.askPass=/bin/false", "-c", "http.followRedirects=false", "-c", "core.symlinks=false",
      "-c", "submodule.recurse=false", "-c", "protocol.allow=never", "-c", "protocol.https.allow=always", "-c", "http.lowSpeedLimit=1000", "-c", "http.lowSpeedTime=30",
      ...(options.extra ?? []), ...args], { cwd: options.cwd ?? this.context.paths.scratch, env: environment, stdout: "pipe", stderr: "pipe" });
    let reason: string | undefined;
    const stop = (why: string) => { reason ??= why; child.kill(); };
    const timer = setTimeout(() => stop(`Git did not finish within ${cloneTimeout / 1000} seconds`), cloneTimeout);
    const abort = () => stop("The run stopped before Git finished");
    options.signal?.addEventListener("abort", abort, { once: true });
    const monitor = options.limit ? setInterval(() => {
      void directorySize(options.limit!).then(size => { if (size > cloneLimit) stop("The repository exceeds the 200 MB download limit"); });
    }, 1_000) : undefined;
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      if (reason) throw fail("operation_failed", reason, "Use a smaller repository or try again later.");
      if (code !== 0) {
        const message = stderr.split("\n").map(line => line.trim()).filter(line => /^(fatal|error|remote):/i.test(line)).slice(-2).join(" ") || `git exited with code ${code}`;
        throw fail("operation_failed", message.slice(0, 500), "Check the repository URL and that it is publicly readable, then try again.");
      }
      return stdout.trim();
    } finally {
      clearTimeout(timer);
      if (monitor) clearInterval(monitor);
      options.signal?.removeEventListener("abort", abort);
    }
  }

  private async download(origin: string, signal?: AbortSignal) {
    const url = validateOrigin(origin);
    const test = isTestURL(url);
    const extra: string[] = [];
    if (test) extra.push("-c", `protocol.${url.protocol.slice(0, -1)}.allow=always`);
    else {
      if (!(await resolvesPublic(url, ["https:"]))) throw fail("permission_denied", "The repository host does not resolve to a public address", "Use a public HTTPS Git host.");
      const host = url.hostname.replace(/^\[|\]$/g, "");
      if (!isIP(host)) {
        const addresses = await lookup(host, { all: true, verbatim: true }).catch(() => []);
        if (!addresses.length || !addresses.every(entry => isPublicAddress(entry.address))) throw fail("permission_denied", "The repository host does not resolve to a public address", "Use a public HTTPS Git host.");
        extra.push("-c", `http.curloptResolve=${host}:${url.port || "443"}:${addresses.map(entry => entry.family === 6 ? `[${entry.address}]` : entry.address).join(",")}`);
      }
    }
    const staging = join(this.context.paths.repositories, `.staging-${crypto.randomUUID()}`);
    try {
      try { await this.git(["clone", "--depth", "1", "--no-tags", "--single-branch", "--", url.href, staging], { limit: staging, extra, ...(signal ? { signal } : {}) }); }
      catch (error) {
        if (!/dumb http transport does not support shallow/i.test(describe(error))) throw error;
        await rm(staging, { recursive: true, force: true });
        await this.git(["clone", "--no-tags", "--single-branch", "--", url.href, staging], { limit: staging, extra, ...(signal ? { signal } : {}) });
      }
      const commit = await this.git(["-C", staging, "rev-parse", "HEAD"]);
      await rm(join(staging, ".git"), { recursive: true, force: true });
      const validated = await validatePackageDirectory(staging, "remote").catch(error => { throw fail("invalid_argument", describe(error), "Fix the repository so its root repository.json and services are valid, then try again."); });
      return { staging, commit, name: validated.name };
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
  }

  private async identifier(name: string) {
    const state = await loadRepositoryState(this.context.paths.state);
    const taken = new Set([...state.repositories.map(entry => entry.id), ...(await readdir(this.context.paths.repositories).catch(() => [])), "local", "bundled"]);
    const base = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "") || "repository";
    let id = base, suffix = 2;
    while (taken.has(id)) id = `${base}-${suffix++}`;
    return id;
  }

  private changed() {
    this.context.emit({ type: "repositories" });
    this.context.emit({ type: "services" });
  }

  async cleanup() {
    for (const name of await readdir(this.context.paths.repositories).catch(() => [])) {
      if (name.startsWith(".staging-") || name.startsWith(".backup-")) await rm(join(this.context.paths.repositories, name), { recursive: true, force: true });
    }
  }

  async entry(id: string) {
    const { entries } = await this.services.catalog.repositories();
    const entry = entries.find(repository => repository.id === id);
    if (!entry) throw fail("not_found", "Repository not found", "Use an ID from ox.repository.list.");
    return entry;
  }

  connect(origin: string, signal?: AbortSignal) {
    return this.serial.run(async () => {
      const url = validateOrigin(origin);
      const state = await loadRepositoryState(this.context.paths.state);
      if (state.repositories.some(repository => repository.url === url.href)) throw fail("already_exists", "Repository is already installed", "Use ox.repository.sync to refresh it.");
      const downloaded = await this.download(url.href, signal);
      const id = await this.identifier(downloaded.name);
      try { await rename(downloaded.staging, join(this.context.paths.repositories, id)); }
      catch (error) { await rm(downloaded.staging, { recursive: true, force: true }); throw error; }
      await updateRepositoryState(this.context.paths, state => {
        state.repositories.push({ id, url: url.href, name: downloaded.name, enabled: true, syncedAt: Date.now(), commit: downloaded.commit, error: null });
      });
      this.context.logs.info("repositories", `connected id=${id} commit=${downloaded.commit.slice(0, 12)}`);
      this.changed();
      return this.entry(id);
    });
  }

  sync(id: string, signal?: AbortSignal) {
    return this.serial.run(async () => {
      const stored = (await loadRepositoryState(this.context.paths.state)).repositories.find(repository => repository.id === id);
      if (!stored) throw fail("not_found", "Repository not found", "Use an ID from ox.repository.list.");
      const update = (change: Partial<ConnectedRepository>) => updateRepositoryState(this.context.paths, state => {
        const entry = state.repositories.find(repository => repository.id === id);
        if (entry) Object.assign(entry, change);
      });
      try {
        const downloaded = await this.download(stored.url, signal);
        const destination = join(this.context.paths.repositories, id), backup = join(this.context.paths.repositories, `.backup-${id}-${crypto.randomUUID()}`);
        const existed = existsSync(destination);
        if (existed) await rename(destination, backup);
        try { await rename(downloaded.staging, destination); }
        catch (error) {
          if (existed) await rename(backup, destination).catch(() => {});
          await rm(downloaded.staging, { recursive: true, force: true });
          throw error;
        }
        if (existed) await rm(backup, { recursive: true, force: true });
        await update({ name: downloaded.name, syncedAt: Date.now(), commit: downloaded.commit, error: null });
        this.context.logs.info("repositories", `synced id=${id} commit=${downloaded.commit.slice(0, 12)}`);
      } catch (error) {
        await update({ error: describe(error).slice(0, 500) });
        this.changed();
        throw error;
      }
      this.changed();
      return this.entry(id);
    });
  }

  disconnect(id: string) {
    return this.serial.run(async () => {
      await updateRepositoryState(this.context.paths, state => {
        if (!state.repositories.some(repository => repository.id === id)) throw fail("not_found", "Repository not found", "Use a remote repository ID from ox.repository.list.");
        state.repositories = state.repositories.filter(repository => repository.id !== id);
        state.selections = Object.fromEntries(Object.entries(state.selections).filter(([, repository]) => repository !== id));
      });
      await rm(join(this.context.paths.repositories, id), { recursive: true, force: true });
      this.context.logs.info("repositories", `disconnected id=${id}`);
      this.changed();
    });
  }

  enable(id: string, enabled: boolean) {
    return this.serial.run(async () => {
      if (id === "local") {
        if (!enabled) throw fail("invalid_argument", "The Local repository is always enabled.", "Do not disable Local.");
        return { entry: await this.entry(id), changed: false };
      }
      const previous = await this.entry(id);
      if (previous.enabled === enabled) return { entry: previous, changed: false };
      if (id === "bundled") await this.services.preferences.update(file => { file.bundledEnabled = enabled; });
      else {
        await updateRepositoryState(this.context.paths, state => {
          const stored = state.repositories.find(repository => repository.id === id);
          if (!stored) throw fail("not_found", "Repository not found", "Use an ID from ox.repository.list.");
          stored.enabled = enabled;
        });
      }
      this.context.logs.info("repositories", `enabled id=${id} enabled=${enabled}`);
      this.changed();
      const entry = await this.entry(id);
      if (enabled && entry.state === "failed") throw fail("operation_failed", "Repository enablement is saved, but its content is unavailable; inspect repositories before retrying", "Inspect ox.repository.list.");
      return { entry, changed: true };
    });
  }
}

export const repositoryRow = (entry: RepositoryEntry) => ({ id: entry.id, name: entry.name, kind: entry.provenance === "remote" ? "git" : entry.provenance, url: entry.url,
  enabled: entry.enabled, syncedAt: entry.syncedAt, commit: entry.commit, error: entry.error, services: entry.services.length, skills: entry.skills.length });

export async function repositoryStatus(services: Services) {
  const { entries } = await services.catalog.repositories();
  return { status: entries.some(entry => entry.state === "ready") ? "ready" : "failed", truncated: entries.length > 50,
    repositories: entries.slice(0, 50).map(entry => ({ id: entry.id, path: `repositories/${entry.id}`, name: entry.name, provenance: entry.provenance,
      enabled: entry.enabled, state: entry.state, serviceCount: entry.services.length, skillCount: entry.skills.length })) };
}

export function repositoryFunctions(services: Services, repositories: Repositories): Record<string, FunctionHandler> {
  const { approvals, catalog } = services;
  const tracked = (call: FunctionCall, action: string, args: JSONObject) => approvals.require(call, action, defaultPolicy(action), { args });
  const untimed = (handler: (call: FunctionCall) => Promise<unknown>): FunctionHandler => call => call.untimed(() => handler(call));
  const remote = async (id: string, label: string) => {
    const entry = (await catalog.repositories()).entries.find(repository => repository.id === id && repository.provenance === "remote");
    if (!entry) throw fail("not_found", `${label}: select a remote or mounted repository ID from ox.repository.list`, "Use ox.repository.list to find the ID.");
    return entry;
  };
  return {
    "ox.repository.list": untimed(async call => {
      await tracked(call, "ox.app.repositories", {});
      return repositoryStatus(services);
    }),
    "ox.repository.conflicts": untimed(async call => {
      const service = typeof call.args.service === "string" ? call.args.service : undefined, compare = call.args.compare === true;
      if (compare && !service) throw fail("invalid_argument", "Source comparison requires an exact service from ox.repository.conflicts.", "Pass service with compare:true.");
      await tracked(call, "ox.repository.conflicts", { ...(service ? { service } : {}), compare });
      const conflicts = (await catalog.load()).conflicts.filter(conflict => !service || conflict.service === service || conflict.candidates.some(candidate => candidate.qualified === service));
      const result: JSONObject = { conflicts: conflicts.slice(0, 100).map(conflict => ({ service: conflict.service, selectedRepository: conflict.selectedRepository,
        candidates: conflict.candidates.map(candidate => ({ repository: candidate.repository.id, name: candidate.repository.name, path: candidate.path })) })),
        truncated: conflicts.length > 100 };
      if (compare) {
        const conflict = conflicts[0];
        if (!conflict || conflict.candidates.length < 2) throw fail("not_found", "Service source conflict is no longer available; inspect conflicts again.", "Call ox.repository.conflicts without compare.");
        const candidates = await Promise.all(conflict.candidates.map(async candidate => ({ repository: candidate.repository.id, files: await fileHashes(candidate.root) })));
        const sets = candidates.map(candidate => JSON.stringify(candidate.files.map(file => [file.path, file.sha256])));
        result.comparison = { identical: sets.every(entry => entry === sets[0]), candidates };
      }
      return result;
    }),
    "ox.repository.resolve": untimed(async call => {
      const service = String(call.args.service), repository = String(call.args.repository);
      await tracked(call, "ox.repository.resolve", { service, repository });
      const conflict = (await catalog.load()).conflicts.find(entry => entry.service === service || entry.candidates.some(candidate => candidate.qualified === service));
      const chosen = conflict?.candidates.find(candidate => candidate.repository.id === repository);
      if (!conflict || !chosen) throw fail("invalid_argument", "Choose an available service source from ox.repository.conflicts.", "Use exact IDs from ox.repository.conflicts.");
      const changed = conflict.selectedRepository !== repository;
      if (changed) {
        await updateRepositoryState(services.context.paths, state => {
          for (const candidate of conflict.candidates) delete state.selections[candidate.qualified];
          state.selections[chosen.qualified] = repository;
        });
        const verified = (await catalog.load()).conflicts.find(entry => entry.service === conflict.service);
        if (verified?.selectedRepository !== repository) throw fail("operation_failed", "The service source could not be activated. Inspect ox.repository.conflicts before retrying.", "Inspect conflicts.");
        services.context.logs.info("repositories", `resolution service=${conflict.service} repository=${repository}`);
        services.changed();
      }
      return { service: conflict.service, selectedRepository: repository, reloadRequired: changed && !!services.attachments.find(call.conversationId, conflict.service) };
    }),
    "ox.repository.connect": untimed(async call => {
      const origin = String(call.args.origin).trim();
      if (origin.startsWith("mounts/") || origin.startsWith("files/")) {
        throw fail("not_supported", "Folder repositories are not available on this Linux Host.", "Connect a public HTTPS Git repository, or copy the service source into repositories/local/.");
      }
      validateOrigin(origin);
      await tracked(call, "ox.repository.connect", { origin });
      const entry = await repositories.connect(origin, call.signal);
      return { id: entry.id, name: entry.name, origin, serviceCount: entry.services.length, skillCount: entry.skills.length, connected: true };
    }),
    "ox.repository.disconnect": untimed(async call => {
      const entry = await remote(String(call.args.repository), "ox.repository.disconnect");
      await tracked(call, "ox.repository.disconnect", { id: entry.id, name: entry.name, origin: entry.url, serviceCount: entry.services.length });
      await repositories.disconnect(entry.id);
      return { id: entry.id, disconnected: true };
    }),
    "ox.repository.enable": untimed(async call => {
      const id = String(call.args.repository), enabled = call.args.enabled === true;
      const current = (await catalog.repositories()).entries.find(entry => entry.id === id);
      if (!current) throw fail("not_found", "ox.repository.enable: select an existing repository ID from ox.repository.list", "Use ox.repository.list to find the ID.");
      await tracked(call, "ox.repository.enable", { repository: id, name: current.name, enabled });
      const { entry, changed } = await repositories.enable(id, enabled);
      return { id: entry.id, enabled: entry.enabled, changed, serviceCount: entry.services.length, skillCount: entry.skills.length };
    }),
    "ox.repository.sync": untimed(async call => {
      const entry = await remote(String(call.args.repository), "ox.repository.sync");
      await tracked(call, "ox.repository.sync", { id: entry.id, name: entry.name, serviceCount: entry.services.length });
      const synced = await repositories.sync(entry.id, call.signal);
      return { id: synced.id, name: synced.name, serviceCount: synced.services.length, skillCount: synced.skills.length, synced: true };
    }),
  };
}

export function repositoryRoute(services: Services, repositories: Repositories): VMRoute {
  return async (request, _url, parts) => {
    const [id, action] = parts;
    if (!id && request.method === "GET") return json({ repositories: (await services.catalog.repositories()).entries.map(repositoryRow) });
    if (!id && request.method === "POST") {
      const body = await payload<{ url?: unknown }>(request);
      if (typeof body.url !== "string" || !body.url.trim()) throw new HTTPError(400, "Enter a public HTTPS Git URL");
      return json(repositoryRow(await repositories.connect(body.url.trim())), { status: 201 });
    }
    if (id && action === "sync" && request.method === "POST") return json(repositoryRow(await repositories.sync(id)));
    if (id && !action && request.method === "PUT") {
      const body = await payload<{ enabled?: unknown }>(request);
      if (typeof body.enabled !== "boolean") throw new HTTPError(400, "Expected enabled");
      return json(repositoryRow((await repositories.enable(id, body.enabled)).entry));
    }
    if (id && !action && request.method === "DELETE") {
      if (id === "local" || id === "bundled") throw new HTTPError(400, "This repository cannot be removed");
      await repositories.disconnect(id);
      return json({ deleted: true });
    }
    throw new HTTPError(404, "Not found");
  };
}

import { existsSync, readdirSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FunctionCall, FunctionHandler, HostFunctions } from "@openox/agent/linux";
import { HTTPError } from "../http";
import type { VMContext, VMFactory, VMModule, VMRoute } from "./context";
import { repositoryBackend } from "./repository-files";
import { proactiveAgentEnabled } from "../config";

export const localRepository = { version: 3, name: "Local", services: [] as string[], skills: [] as string[] };

export function connectedRepositories(directory: string) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name !== "local" && entry.name !== "bundled" && /^[a-z0-9][a-z0-9-]{0,62}$/.test(entry.name)
      && existsSync(join(directory, entry.name, "repository.json")))
    .map(entry => ({ id: entry.name, directory: join(directory, entry.name) }));
}

async function prepare(context: VMContext) {
  const { paths } = context;
  for (const path of [paths.root, paths.state, paths.browser, paths.repositories, paths.local, paths.scratch]) await mkdir(path, { recursive: true, mode: 0o700 });
  const manifest = join(paths.local, "repository.json");
  if (!existsSync(manifest)) await writeFile(manifest, `${JSON.stringify(localRepository, null, 2)}\n`, { mode: 0o600 });
}

function limitationsFor(handlers: Record<string, FunctionHandler>, extra: string[]) {
  const missing = ([["ox.web.fetch", "fetch web pages"], ["ox.web.search", "search the web"], ["ox.web.browser.navigate", "open browser pages"],
    ["ox.service.invoke", "use website or app services"], ["ox.schedule.create", "schedule future work"]] as const)
    .filter(([name]) => !handlers[name]).map(([, text]) => text);
  const text = [proactiveAgentEnabled()
    ? "Use exposed direct JSON tools for routine work. ox.* JavaScript functions remain available inside execute for capabilities without a direct tool; discover their actual contracts first."
    : "Every ox.* function, such as ox.web.fetch, ox.web.search or ox.web.browser.navigate, exists only inside the execute tool's JavaScript and is never a tool of its own: call execute with source such as `return await ox.web.fetch({ purpose: \"Read the page\", url })`.", ...extra];
  if (missing.length) text.push(`This Linux Host cannot ${missing.join(", ")}. When a request needs one of these, say plainly that this Host cannot do it yet and offer what it can do. Do not offer, describe, or imply capabilities this Host lacks.`);
  return text.join(" ");
}

export async function createVM(context: VMContext, factories: readonly VMFactory[]) {
  await prepare(context);
  const repositories: VMModule = {
    mounts: [{ path: "repositories", access: "readWrite", source: { kind: "backend", backend: repositoryBackend({
      bundled: context.paths.bundled, local: context.paths.local, connected: () => connectedRepositories(context.paths.repositories),
    }) } }],
  };
  const modules: VMModule[] = [repositories];
  for (const factory of factories) modules.push(await factory(context));
  const handlers: Record<string, FunctionHandler> = {};
  for (const module of modules) for (const [name, handler] of Object.entries(module.handlers ?? {})) {
    if (handlers[name]) throw new Error(`Duplicate Host function ${name}`);
    handlers[name] = handler;
  }
  const routes: Record<string, VMRoute> = {};
  for (const module of modules) for (const [group, route] of Object.entries(module.routes ?? {})) {
    if (routes[group] || ["health", "session", "pair", "logout", "events", "conversations", "files", "settings", "devices", "pages", "push", "presence", "canvas"].includes(group)) throw new Error(`Duplicate API route ${group}`);
    routes[group] = route;
  }
  const functions: HostFunctions = {
    handlers,
    limitations: limitationsFor(handlers, modules.flatMap(module => module.limitations ?? [])),
    serviceKinds: [...new Set(modules.flatMap(module => module.serviceKinds ?? []))],
    mounts: modules.flatMap(module => module.mounts ?? []),
    appFiles: modules.find(module => module.appFiles)?.appFiles,
    unavailableSkills: handlers["ox.service.invoke"] ? [] : ["checkout", "evolve"],
    attachedServices: async id => (await Promise.all(modules.map(module => module.attachedServices?.(id) ?? Promise.resolve([])))).flat(),
    conversationRemoved: async id => { await Promise.all(modules.map(module => module.conversationRemoved?.(id))); },
    conversationForked: async (source, fork) => { await Promise.all(modules.map(module => module.conversationForked?.(source, fork))); },
    conversationReplaced: async (source, replacement) => { await Promise.all(modules.map(module => module.conversationReplaced?.(source, replacement))); },
    spaceTask: call => modules.map(module => module.spaceTask?.(call)).find(Boolean),
    goalTask: id => modules.map(module => module.goalTask?.(id)).find(Boolean),
    ...(modules.some(module => module.beforeFunction) ? { beforeFunction: async (call: FunctionCall) => { for (const module of modules) await module.beforeFunction?.(call); } } : {}),
    ...(modules.some(module => module.afterFunction) ? { afterFunction: async (call: FunctionCall, result: unknown) => { for (const module of modules) await module.afterFunction?.(call, result); } } : {}),
    ...(modules.some(module => module.beforeModelRequest) ? { beforeModelRequest: async (id: number) => { for (const module of modules) await module.beforeModelRequest?.(id); } } : {}),
    skills: async () => (await Promise.all(modules.map(module => module.skills?.() ?? Promise.resolve([])))).flat(),
    disabledSkills: () => new Set(modules.flatMap(module => [...module.disabledSkills?.() ?? []])),
    skillUsed: name => { for (const module of modules) module.skillUsed?.(name); },
  };
  return {
    functions,
    routes,
    finishDiscoveryTurn: async (id: number, submission: string, answer: string) => { for (const module of modules) await module.finishDiscoveryTurn?.(id, submission, answer); },
    invokeSkill: async (name: string, conversationId: number) => {
      let skill: { name: string; instructions: string; services: string[] } | undefined;
      for (const module of modules) if (!skill) skill = await module.invokeSkill?.(name);
      if (!skill) return undefined;
      for (const module of modules) await module.attachServices?.(conversationId, skill.services);
      return skill;
    },
    start: async () => { for (const module of modules) await module.start?.(); },
    contentBusy: () => modules.some(module => module.content?.busy?.()),
    spaceTask: (call: FunctionCall) => modules.map(module => module.spaceTask?.(call)).find(Boolean),
    goalTask: (id: number) => modules.map(module => module.goalTask?.(id)).find(Boolean),
    spaceConnectionProof: async (domain: string) => {
      const owner = modules.find(module => module.spaceConnectionProof);
      if (!owner?.spaceConnectionProof) throw new HTTPError(503, "The original connector owner is unavailable.");
      return owner.spaceConnectionProof(domain);
    },
    permissionSchedules: async () => (await Promise.all(modules.map(module => module.permissionSchedules?.() ?? []))).flat(),
    conversationWatches: async (id: number) => (await Promise.all(modules.map(module => module.conversationWatches?.(id) ?? []))).flat(),
    discoveryReports: async () => (await Promise.all(modules.map(module => module.discoveryReports?.() ?? []))).flat(),
    quietConnectorProofs: async () => await modules.find(module => module.quietConnectorProofs)?.quietConnectorProofs?.() ?? new Map<string,string>(),
    pollQuietConnectors: async (signal: AbortSignal) => { for (const module of modules) await module.pollQuietConnectors?.(signal); },
    familiarWebVisit: async (url: string) => {
      for (const module of modules) if (await module.familiarWebVisit?.(url)) return true;
      return false;
    },
    serviceDependencies: async (domain: string) => {
      const values = await Promise.all(modules.map(module => module.serviceDependencies?.(domain) ?? { schedules: 0, activeSchedules: 0 }));
      return { schedules: values.reduce((sum, value) => sum + value.schedules, 0), activeSchedules: values.reduce((sum, value) => sum + value.activeSchedules, 0) };
    },
    contentSnapshot: async () => {
      const snapshots = await Promise.all(modules.map(module => module.content?.snapshot?.() ?? { data: {}, files: [] }));
      return { data: Object.assign({}, ...snapshots.map(snapshot => snapshot.data)) as Record<string, unknown>, files: snapshots.flatMap(snapshot => snapshot.files) };
    },
    resetContent: async (expected: Record<string, string | null>) => { for (const module of modules) await module.content?.reset?.(expected); },
    pauseContent: async () => {
      if (modules.some(module => module.content?.busy?.())) throw new HTTPError(409, "A workspace worker is active. Wait or explicitly stop it before continuing.");
      for (const module of [...modules].reverse()) await module.close?.();
    },
    close: async () => {
      for (const module of [...modules].reverse()) await module.close?.().catch(error => context.logs.warning("vm", error instanceof Error ? error.message : String(error)));
    },
  };
}

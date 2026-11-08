import { existsSync, readdirSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FunctionHandler, HostFunctions } from "@openox/agent/linux";
import type { VMContext, VMFactory, VMModule, VMRoute } from "./context";
import { repositoryBackend } from "./repository-files";

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
  const text = ["Every ox.* function, such as ox.web.fetch, ox.web.search or ox.web.browser.navigate, exists only inside the execute tool's JavaScript and is never a tool of its own: call execute with source such as `return await ox.web.fetch({ purpose: \"Read the page\", url })`.", ...extra];
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
    if (routes[group] || ["health", "session", "pair", "logout", "events", "conversations", "files", "settings", "devices", "pages"].includes(group)) throw new Error(`Duplicate API route ${group}`);
    routes[group] = route;
  }
  const functions: HostFunctions = {
    handlers,
    limitations: limitationsFor(handlers, modules.flatMap(module => module.limitations ?? [])),
    serviceKinds: [...new Set(modules.flatMap(module => module.serviceKinds ?? []))],
    mounts: modules.flatMap(module => module.mounts ?? []),
    unavailableSkills: handlers["ox.service.invoke"] ? [] : ["checkout", "evolve"],
    attachedServices: async id => (await Promise.all(modules.map(module => module.attachedServices?.(id) ?? Promise.resolve([])))).flat(),
    conversationRemoved: async id => { await Promise.all(modules.map(module => module.conversationRemoved?.(id))); },
    skills: async () => (await Promise.all(modules.map(module => module.skills?.() ?? Promise.resolve([])))).flat(),
    disabledSkills: () => new Set(modules.flatMap(module => [...module.disabledSkills?.() ?? []])),
    skillUsed: name => { for (const module of modules) module.skillUsed?.(name); },
  };
  return {
    functions,
    routes,
    start: async () => { for (const module of modules) await module.start?.(); },
    close: async () => {
      for (const module of [...modules].reverse()) await module.close?.().catch(error => context.logs.warning("vm", error instanceof Error ? error.message : String(error)));
    },
  };
}

import { lstat, mkdir, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { repositoryServiceIdentity, repositoryServiceKind, validateRepositoryPackage, type RepositoryPackage } from "@openox/protocol/repository";
import type { VMPaths } from "../context";
import { loadRepositoryState, saveRepositoryState, type RepositoryState } from "../repository-state";
import { runtimeID } from "./catalog";
import { fail, Serial, writeJSONFile, type Kind } from "./support";

const serial = new Serial(), stateSerial = new Serial();

export function updateRepositoryState<T>(paths: VMPaths, change: (state: RepositoryState) => T | Promise<T>) {
  return stateSerial.run(async () => {
    const state = await loadRepositoryState(paths.state);
    const result = await change(state);
    await saveRepositoryState(paths.state, state);
    return result;
  });
}

async function readLocal(paths: VMPaths): Promise<RepositoryPackage> {
  let raw: unknown;
  try { raw = JSON.parse(await readFile(join(paths.local, "repository.json"), "utf8")); }
  catch { throw fail("invalid_argument", "repositories/local/repository.json is missing or invalid", "Repair repositories/local/repository.json before changing Local services."); }
  const validated = validateRepositoryPackage(raw);
  if ("error" in validated) throw fail("invalid_argument", `repositories/local/repository.json: ${validated.error}`, "Repair repositories/local/repository.json before changing Local services.");
  return validated;
}

export function localServices(paths: VMPaths) {
  return readLocal(paths).then(local => local.services.map(qualified => ({ qualified, kind: repositoryServiceKind(qualified) as Kind, identity: repositoryServiceIdentity(qualified),
    runtime: runtimeID(repositoryServiceKind(qualified) as Kind, repositoryServiceIdentity(qualified)) })));
}

export function addLocalService(paths: VMPaths, qualified: string, write: () => Promise<void>) {
  return serial.run(async () => {
    const local = await readLocal(paths);
    if (local.services.some(service => repositoryServiceIdentity(service) === repositoryServiceIdentity(qualified))) {
      throw fail("already_exists", `A Local service already exists for ${repositoryServiceIdentity(qualified)}.`, "Edit or select the existing Local service instead.");
    }
    await mkdir(join(paths.local, repositoryServiceKind(qualified), repositoryServiceIdentity(qualified)), { recursive: true, mode: 0o700 });
    await write();
    await writeJSONFile(join(paths.local, "repository.json"), { ...local, services: [...local.services, qualified].sort() });
    await updateRepositoryState(paths, state => { state.selections[qualified] = "local"; });
  });
}

export function swapLocalService(paths: VMPaths, kind: Kind, identity: string, staged: string, backup: string, replace: boolean) {
  return serial.run(async () => {
    const local = await readLocal(paths);
    const qualified = `${kind}:${identity}`;
    const registered = local.services.find(service => repositoryServiceIdentity(service) === identity);
    if (registered && registered !== qualified) throw fail("already_exists", "A Local service of another kind already uses this domain.", "Delete the existing Local service first.");
    if (registered && !replace) throw fail("already_exists", "A Local service with this ID already exists.", "Choose Replace Service to change its source.");
    const target = join(paths.local, kind, identity);
    const existing = await lstat(target).then(() => true, () => false);
    if (existing && !registered) throw fail("already_exists", "Local already has a folder for this service that it doesn't list. Move or delete that folder first.", `Inspect repositories/local/${kind}/${identity}.`);
    const next = registered ? local : { ...local, services: [...local.services, qualified].sort() };
    if (!registered && local.services.length >= 256) throw fail("limit_exceeded", "Local already holds 256 services, the most it can. Delete one first.", "Delete a Local service you no longer need.");
    if ("error" in validateRepositoryPackage(next)) throw fail("invalid_argument", `${qualified} can't be listed in repositories/local/repository.json.`, "Use a shorter service ID.");
    await mkdir(join(paths.local, kind), { recursive: true, mode: 0o700 });
    if (existing) await rename(target, backup);
    try {
      await rename(staged, target);
      if (!registered) await writeJSONFile(join(paths.local, "repository.json"), next);
      await updateRepositoryState(paths, state => { state.selections[qualified] = "local"; });
    } catch (error) {
      await rm(target, { recursive: true, force: true }).catch(() => {});
      const restored = !existing || await rename(backup, target).then(() => true, () => false);
      if (!registered) await writeJSONFile(join(paths.local, "repository.json"), local).catch(() => {});
      if (!restored) throw fail("restore_failed", "The import failed and the previous version couldn't be put back. A copy is kept on the Host.", `Move ${backup} back to repositories/local/${kind}/${identity}.`);
      throw error;
    }
    return { replaced: existing };
  });
}

export function removeLocalService(paths: VMPaths, runtime: string) {
  return serial.run(async () => {
    const local = await readLocal(paths);
    const qualified = local.services.find(service => runtimeID(repositoryServiceKind(service) as Kind, repositoryServiceIdentity(service)) === runtime);
    if (!qualified) throw fail("not_found", `No Local service exists for ${runtime}.`, "Only Local web, API, and MCP services can be deleted. Inspect repositories/local/repository.json.");
    const kind = repositoryServiceKind(qualified) as Kind;
    await writeJSONFile(join(paths.local, "repository.json"), { ...local, services: local.services.filter(service => service !== qualified) });
    await rm(join(paths.local, kind, repositoryServiceIdentity(qualified)), { recursive: true, force: true });
    await updateRepositoryState(paths, state => { if (state.selections[qualified] === "local") delete state.selections[qualified]; });
    return kind;
  });
}

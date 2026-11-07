import { readFile, rm, mkdir } from "node:fs/promises";
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

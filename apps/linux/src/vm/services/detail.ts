import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { validateLinuxServiceManifest } from "./schema";
import { HTTPError } from "../../http";
import { zipDecode, zipEncode, type ZipFailure } from "../skills-package";
import { exposedActions, qualifiedName, standardActions } from "./catalog";
import { localServices, removeLocalService, swapLocalService } from "./local";
import type { Services } from "./manager";
import type { Policy } from "./policy";
import { namespaceOf } from "./routes";
import { walk, type Kind } from "./support";

export const servicePackageLimits = { archive: 4_500_000, source: 4_000_000, files: 64 };
const packageMessages: Record<ZipFailure, string> = {
  tooLarge: "This service package is too large.",
  invalidArchive: "This isn't a valid Ox service package.",
  encrypted: "This isn't a valid Ox service package.",
  unsupportedCompression: "This isn't a valid Ox service package.",
  unsafePath: "This isn't a valid Ox service package.",
  checksumMismatch: "This isn't a valid Ox service package.",
};
const invalidSource = () => new HTTPError(400, "This service package has missing or invalid source files.");
const invalidPackage = () => new HTTPError(400, packageMessages.invalidArchive);
const fail = (key: ZipFailure) => new HTTPError(400, packageMessages[key]);
const encoder = new TextEncoder();
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

export async function serviceDetail(services: Services, domain: string) {
  const { candidate } = await services.selected(domain).catch(() => { throw new HTTPError(404, "Service not found"); });
  if (candidate.kind === "ios") throw new HTTPError(400, "Native iOS services need the Ox app on iPhone or Mac.");
  const definition = await services.catalog.definition(candidate);
  await services.approvals.load();
  const stored = services.approvals.stored();
  const standard = new Set(standardActions(definition).map(action => action.id));
  const local = candidate.repository.provenance === "local";
  const scripted = candidate.kind === "web" || candidate.kind === "api";
  const repository = candidate.repository;
  return {
    domain, kind: candidate.kind, name: services.title(definition), description: definition.description, faviconUrl: definition.faviconUrl,
    endpoint: definition.endpoint ?? null, saved: services.preferences.saved(domain),
    supportsLogin: candidate.kind === "web" && standard.has("login"), attachData: candidate.kind === "web" ? "signedIn" : "remote",
    repository: { id: repository.id, name: repository.name, kind: repository.provenance === "bundled" ? "bundled" : local ? "local" : "git", syncedAt: repository.syncedAt },
    manage: { inspect: candidate.kind === "web" && !!definition.baseUrl, share: local && scripted, websiteData: candidate.kind === "web", removeServer: local && candidate.kind === "mcp",
      deleteLocal: local && scripted },
    policy: stored.sources[domain] ?? null,
    attach: { id: `ox.service.attach:${domain}`, policy: stored.actions[`ox.service.attach:${domain}`] ?? null },
    actions: exposedActions(definition).map(action => {
      const id = qualifiedName(definition, action.id);
      return { id, label: action.label, description: action.description ?? "", standard: standard.has(action.id), authenticated: action.requireAuth,
        default: (action.requireApproval ? "ask" : "allow") as Policy, policy: stored.actions[id] ?? null };
    }),
  };
}

async function selectedDefinition(services: Services, domain: string) {
  const { candidate } = await services.selected(domain).catch(() => { throw new HTTPError(404, "Service not found"); });
  return services.catalog.definition(candidate);
}

export async function clearWebsiteData(services: Services, domain: string) {
  const definition = await selectedDefinition(services, domain);
  if (definition.kind !== "web") throw new HTTPError(400, "This service has no website data");
  for (const page of services.web.list(domain)) await page.live.page.close().catch(() => {});
  const context = await services.context.browser.context();
  const escaped = domain.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  await context.clearCookies({ domain: new RegExp(`(^|\\.)${escaped}$`, "i") });
  const hosts = new Set([domain, `www.${domain}`]);
  if (definition.baseUrl) { try { hosts.add(new URL(definition.baseUrl).host); } catch {} }
  const page = await context.newPage();
  try {
    const session = await context.newCDPSession(page);
    for (const host of hosts) await session.send("Storage.clearDataForOrigin", { origin: `https://${host}`, storageTypes: "all" });
  } finally { await page.close().catch(() => {}); }
}

export async function openServicePage(services: Services, domain: string) {
  const definition = await selectedDefinition(services, domain);
  if (definition.kind !== "web" || !definition.baseUrl) throw new HTTPError(400, "This service has no website");
  return services.web.openHome(await services.snapshot(domain));
}

export async function exportServicePackage(services: Services, domain: string) {
  const { candidate } = await services.selected(domain).catch(() => { throw new HTTPError(404, "Service not found"); });
  if (candidate.repository.provenance !== "local" || (candidate.kind !== "web" && candidate.kind !== "api")) throw new HTTPError(400, "Only Local website and API services can be shared");
  const files = await walk(join(services.context.paths.local, candidate.kind, candidate.identity));
  if (files.length > servicePackageLimits.files || files.reduce((total, file) => total + file.size, 0) > servicePackageLimits.source) throw fail("tooLarge");
  const entries = [{ path: "package.json", data: encoder.encode(JSON.stringify({ version: 1, kind: candidate.kind, domain })) }];
  for (const file of files) entries.push({ path: `services/${candidate.kind}/${domain}/${file.path}`, data: new Uint8Array(await readFile(file.absolute)) });
  return zipEncode(entries, servicePackageLimits.archive, fail);
}

export interface ServicePackage { kind: Kind; domain: string; name: string; description: string; actions: string[]; files: { path: string; data: Uint8Array }[] }

export function readServicePackage(data: Uint8Array): ServicePackage {
  const archive = zipDecode(data, servicePackageLimits.archive, servicePackageLimits.source, servicePackageLimits.files + 1, fail, servicePackageLimits.source + 1_000);
  let header: unknown;
  try { header = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(archive.find(entry => entry.path === "package.json")?.data ?? new Uint8Array())); }
  catch { throw invalidPackage(); }
  if (!isObject(header) || header.version !== 1 || (header.kind !== "web" && header.kind !== "api") || typeof header.domain !== "string"
    || !/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/.test(header.domain) || `${header.kind}:${header.domain}`.length > 253
    || (header.kind === "web" && !header.domain.includes("."))) throw invalidPackage();
  const kind = header.kind as Kind, domain = header.domain;
  const prefix = `services/${kind}/${domain}/`;
  const files = archive.filter(entry => entry.path !== "package.json");
  if (!files.length || files.length > servicePackageLimits.files || !files.every(entry => entry.path.startsWith(prefix) && entry.path.length > prefix.length)
    || files.reduce((total, entry) => total + entry.data.length, 0) > servicePackageLimits.source) throw invalidSource();
  const read = (path: string) => files.find(entry => entry.path === prefix + path)?.data;
  const manifestData = read("service.json");
  if (!manifestData || !read("actions.js")) throw invalidSource();
  let manifest: unknown;
  try { manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestData)); } catch { throw invalidSource(); }
  if (!isObject(manifest) || manifest.domain !== domain || (kind === "api") !== (manifest.kind === "api") || !validateLinuxServiceManifest(manifest).ok) throw invalidSource();
  const actions = Array.isArray(manifest.actions) ? manifest.actions.flatMap(action => isObject(action) && typeof (action.label ?? action.id) === "string" ? [String(action.label ?? action.id)] : []) : [];
  return { kind, domain, name: typeof manifest.name === "string" && manifest.name.trim() ? manifest.name.trim() : domain,
    description: typeof manifest.description === "string" ? manifest.description : "", actions,
    files: files.map(entry => ({ path: entry.path.slice(prefix.length), data: entry.data })) };
}

export async function servicePreview(services: Services, value: ServicePackage) {
  const local = await localServices(services.context.paths);
  if (local.some(service => service.runtime === value.domain && service.kind !== value.kind)) throw new HTTPError(409, "A Local service of another kind already uses this domain.");
  return { kind: value.kind, domain: value.domain, name: value.name, description: value.description, actions: value.actions,
    exists: local.some(service => service.runtime === value.domain && service.kind === value.kind) };
}

export async function installServicePackage(services: Services, value: ServicePackage, replace: boolean) {
  const paths = services.context.paths;
  const existing = (await localServices(paths)).find(service => service.runtime === value.domain);
  if (existing && (existing.kind !== value.kind || !replace)) throw new HTTPError(409, "A Local service with this ID already exists.");
  await mkdir(paths.scratch, { recursive: true, mode: 0o700 });
  const work = await mkdtemp(join(paths.scratch, "service-import-"));
  let keep = false;
  try {
    const root = join(work, "service");
    for (const file of value.files) {
      const target = resolve(root, file.path);
      if (!target.startsWith(`${root}/`)) throw invalidSource();
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, file.data, { mode: 0o600, flag: "wx" });
    }
    const local = (await services.catalog.load()).repositories.find(repository => repository.provenance === "local");
    if (!local) throw invalidSource();
    const qualified = `${value.kind}:${value.domain}`;
    await services.catalog.validate({ qualified, kind: value.kind, identity: value.domain, runtime: value.domain, repository: local, root, path: `repositories/local/${value.kind}/${value.domain}` });
    await swapLocalService(paths, value.kind, value.domain, root, join(work, "previous"), replace);
  } catch (error) {
    if (error instanceof HTTPError) throw error;
    const code = error instanceof Error ? (error as { code?: unknown }).code : undefined;
    if (code === "already_exists" || code === "limit_exceeded") throw new HTTPError(409, (error as Error).message);
    if (code === "restore_failed") {
      keep = true;
      services.context.logs.warning("services", `service import could not restore domain=${value.domain}; previous source kept at ${join(work, "previous")}`);
      throw new HTTPError(500, (error as Error).message);
    }
    throw invalidSource();
  } finally {
    if (!keep) await rm(work, { recursive: true, force: true }).catch(() => {});
  }
  await services.forget(value.domain);
  services.changed();
  services.context.emit({ type: "repositories" });
  return { domain: value.domain, kind: value.kind };
}

export async function deleteLocalService(services: Services, domain: string) {
  const state = await services.catalog.load();
  const current = state.selected.get(domain);
  if (!current || current.repository.provenance !== "local" || current.kind === "ios") throw new HTTPError(400, "Only Local services can be deleted");
  const affected = services.attachments.conversations().filter(conversation => !!services.attachments.find(conversation, domain));
  await removeLocalService(services.context.paths, domain);
  await services.forget(domain);
  if (current.kind === "mcp") {
    await services.mcp.forget(domain);
    await services.approvals.clear(domain, namespaceOf({ kind: "mcp", domain }));
  }
  if (!(await services.catalog.load()).selected.has(domain)) {
    await services.preferences.setSaved(domain, false);
    await services.attachments.removeEverywhere(domain);
    for (const conversation of affected) await services.context.profile().refreshTurnState(conversation).catch(() => {});
  }
  services.changed();
  services.context.emit({ type: "repositories" });
  return { domain, kind: current.kind };
}

const staged = new Map<string, ServicePackage>();
export function stageServicePackage(value: ServicePackage) {
  while (staged.size >= 4) staged.delete(staged.keys().next().value!);
  const token = crypto.randomUUID();
  staged.set(token, value);
  setTimeout(() => staged.delete(token), 10 * 60_000).unref?.();
  return token;
}
export function takeServicePackage(token: string) {
  const value = staged.get(token);
  if (!value) throw new HTTPError(404, "This import has expired. Choose the file again.");
  return value;
}
export function discardServicePackage(token: string) { staged.delete(token); }

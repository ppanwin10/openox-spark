import { existsSync } from "node:fs";
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { isUtf8 } from "node:buffer";
import { join } from "node:path";
import { bundledSkills } from "@openox/agent";
import { OxError, type LinuxProfile } from "@openox/agent/linux";
import { isSkillResourcePath, RESERVED_SKILL_NAMES } from "@openox/protocol/skills";
import type { VMContext } from "./context";
import { connectedRepositories } from "./index";
import { loadRepositoryState } from "./repository-state";

export interface SkillContent { name: string; description: string; instructions: string; services: string[]; resources: Record<string, string> }
export type SkillOwner = { kind: "system" } | { kind: "profile" } | { kind: "repository"; id: string; name: string; directory: string };
export interface ResolvedSkill extends SkillContent { owner: SkillOwner }

export const skillLimits = { bytes: 524_288, files: 64, fileBytes: 200 * 1024, script: 524_288 };
const reserved = new Set<string>(RESERVED_SKILL_NAMES);
const servicePattern = /^[a-z0-9]+(?:[.:-][a-z0-9]+)*$/;
const decoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text).length;
const warned = new Set<string>();
const warnOnce = (context: VMContext, message: string, error: unknown) => {
  const text = `${message}: ${error instanceof Error ? error.message : String(error)}`;
  if (warned.has(text)) return;
  warned.add(text);
  context.logs.warning("skills", text);
};

export const skillErrors = {
  invalidPackage: () => new OxError("invalid", "The skill package is invalid or too large.", "Keep SKILL.md frontmatter valid and resources under references/ or scripts/*.js within 512 KiB."),
  reserved: (name: string) => new OxError("permission_denied", `The name /${name} is reserved for a bundled System skill. Copy it to a distinct name to customize.`, "Choose a different skill name."),
  invalidName: () => new OxError("invalid_argument", "User skill names must use lowercase kebab-case.", "Use letters, digits, and hyphens, for example my-skill."),
  missing: (name: string) => new OxError("not_found", `No skill named /${name} exists.`, "Check the skill names listed in the prompt before retrying."),
  exists: (name: string) => new OxError("conflict", `A skill named /${name} already exists.`, "Choose a different name, or improve the existing skill instead."),
  emptyDescription: () => new OxError("invalid_argument", "Skill description cannot be empty.", "Describe when the skill should be used."),
  emptyInstructions: () => new OxError("invalid_argument", "Skill instructions cannot be empty.", "Write the skill's instructions."),
};

const slugSegment = (raw: string) => raw.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
export function skillSlug(raw: string) {
  const value = raw.trim().replace(/^\/+/, "").toLowerCase();
  return value.includes(":") ? "" : slugSegment(value);
}
export const isLocalSkillName = (name: string) => !!name && !name.includes(":") && slugSegment(name) === name;

export function canonicalSkillName(raw: string) {
  const name = skillSlug(raw);
  if (!isLocalSkillName(name)) throw skillErrors.invalidName();
  if (reserved.has(name)) throw skillErrors.reserved(name);
  return name;
}

function frontmatter(text: string) {
  const fields: Record<string, string> = {};
  for (const line of text.split("\n").filter(Boolean)) {
    const index = line.indexOf(":");
    if (index < 0) return undefined;
    const key = line.slice(0, index).trim(), raw = line.slice(index + 1).trim();
    if (!["name", "description", "services"].includes(key) || key in fields) return undefined;
    let value: unknown;
    try { value = JSON.parse(raw); } catch { value = undefined; }
    if (typeof value === "string") fields[key] = value;
    else if (raw.startsWith("\"")) return undefined;
    else fields[key] = raw;
  }
  return fields;
}

export function parseSkill(text: string, directoryName: string): SkillContent | undefined {
  const normalized = text.replaceAll("\r\n", "\n");
  if (!normalized.startsWith("---\n")) return undefined;
  const content = normalized.slice(4), closing = content.indexOf("\n---\n");
  if (closing < 0) return undefined;
  const fields = frontmatter(content.slice(0, closing));
  const instructions = content.slice(closing + 5).trim();
  const description = fields?.description?.trim();
  if (!fields || !isLocalSkillName(directoryName) || directoryName.length > 100 || fields.name !== directoryName || !description || !instructions) return undefined;
  const services = (fields.services ?? "").split(",").map(value => value.trim()).filter(Boolean);
  if (!services.every(service => servicePattern.test(service))) return undefined;
  return { name: directoryName, description, instructions, services: [...new Set(services)], resources: {} };
}

export function serializeSkill(skill: SkillContent) {
  const services = skill.services.length ? `\nservices: ${skill.services.join(", ")}` : "";
  return `---\nname: ${skill.name}\ndescription: ${JSON.stringify(skill.description.split(/\s+/).filter(Boolean).join(" "))}${services}\n---\n\n${skill.instructions.trim()}\n`;
}

export function validateSkill(skill: SkillContent) {
  const paths = Object.keys(skill.resources);
  const total = paths.reduce((sum, path) => sum + bytes(skill.resources[path]!), bytes(serializeSkill(skill)));
  if (!isLocalSkillName(skill.name) || !parseSkill(serializeSkill(skill), skill.name) || !paths.every(isSkillResourcePath) || paths.length >= skillLimits.files
    || paths.some(path => paths.some(other => other.startsWith(path + "/"))) || total > skillLimits.bytes) throw skillErrors.invalidPackage();
}

export function draftSkill(name: string, description: string, instructions: string, services: string[], resources: Record<string, string> = {}): SkillContent {
  const summary = description.trim(), body = instructions.trim();
  if (!summary) throw skillErrors.emptyDescription();
  if (!body) throw skillErrors.emptyInstructions();
  const normalized = [...new Set(services.map(service => service.trim().toLowerCase()).filter(Boolean))];
  const skill = { name, description: summary, instructions: body, services: normalized, resources: { ...resources } };
  validateSkill(skill);
  if (bytes(serializeSkill(skill)) > skillLimits.fileBytes || Object.values(skill.resources).some(text => bytes(text) > skillLimits.fileBytes)) throw skillErrors.invalidPackage();
  return skill;
}

const finish = (files: Record<string, string>, name: string) => {
  const text = files["SKILL.md"];
  const skill = text === undefined ? undefined : parseSkill(text, name);
  if (!skill) throw skillErrors.invalidPackage();
  const { "SKILL.md": _, ...resources } = files;
  skill.resources = resources;
  validateSkill(skill);
  return skill;
};

export async function loadSkillDirectory(directory: string, name: string): Promise<SkillContent> {
  const root = await lstat(directory).catch(() => undefined);
  if (!root?.isDirectory() || root.isSymbolicLink()) throw skillErrors.invalidPackage();
  const files: Record<string, string> = {};
  let total = 0, count = 0;
  const walk = async (relative: string) => {
    for (const entry of await readdir(join(directory, relative), { withFileTypes: true })) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw skillErrors.invalidPackage();
      if (entry.isDirectory()) {
        if (!["references", "scripts"].includes(path) && !isSkillResourcePath(`${path}/file.js`)) throw skillErrors.invalidPackage();
        await walk(path);
        continue;
      }
      if (!entry.isFile() || (path !== "SKILL.md" && !isSkillResourcePath(path))) throw skillErrors.invalidPackage();
      const data = new Uint8Array(await readFile(join(directory, path)));
      total += data.length;
      if (total > skillLimits.bytes || ++count > skillLimits.files || !isUtf8(data)) throw skillErrors.invalidPackage();
      files[path] = decoder.decode(data);
    }
  };
  await walk("");
  return finish(files, name);
}

async function loadProfileSkill(profile: LinuxProfile, name: string): Promise<SkillContent> {
  const files: Record<string, string> = {};
  let total = 0, count = 0;
  const walk = async (relative: string) => {
    for (const entry of await profile.listFiles(`skills/${name}${relative ? `/${relative}` : ""}`)) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.kind === "directory") { await walk(path); continue; }
      total += entry.size;
      if ((path !== "SKILL.md" && !isSkillResourcePath(path)) || total > skillLimits.bytes || ++count > skillLimits.files) throw skillErrors.invalidPackage();
      const data = new Uint8Array(await (await profile.openFile(entry.path)).file.arrayBuffer());
      if (!isUtf8(data)) throw skillErrors.invalidPackage();
      files[path] = decoder.decode(data);
    }
  };
  await walk("");
  return finish(files, name);
}

export async function profileSkillNames(profile: LinuxProfile) {
  const entries = await profile.listFiles("skills").catch(() => []);
  return entries.filter(entry => entry.kind === "directory" && isLocalSkillName(entry.name) && !reserved.has(entry.name)).map(entry => entry.name).sort();
}

export const hasProfileSkill = (profile: LinuxProfile, name: string) => profile.statFile(`skills/${name}`).then(() => true, () => false);

interface RepositorySource { id: string; name: string; directory: string }

async function repositorySources(context: VMContext): Promise<RepositorySource[]> {
  const state = await loadRepositoryState(context.paths.state).catch(() => ({ repositories: [], selections: {} }));
  const present = new Map(connectedRepositories(context.paths.repositories).map(entry => [entry.id, entry.directory]));
  return [{ id: "local", name: "Local", directory: context.paths.local },
    ...state.repositories.filter(entry => entry.enabled && present.has(entry.id)).map(entry => ({ id: entry.id, name: entry.name || entry.id, directory: present.get(entry.id)! }))];
}

async function manifestSkills(directory: string) {
  try {
    const manifest = JSON.parse(await readFile(join(directory, "repository.json"), "utf8")) as { skills?: unknown };
    const names = Array.isArray(manifest.skills) ? manifest.skills : [];
    return names.filter((name): name is string => typeof name === "string" && isLocalSkillName(name) && !reserved.has(name)).slice(0, 256);
  } catch { return []; }
}

export async function repositorySkills(context: VMContext): Promise<ResolvedSkill[]> {
  const skills: ResolvedSkill[] = [];
  const names = new Set<string>();
  for (const source of await repositorySources(context)) {
    for (const name of await manifestSkills(source.directory)) {
      if (names.has(name)) continue;
      try {
        skills.push({ ...await loadSkillDirectory(join(source.directory, "skills", name), name), owner: { kind: "repository", ...source } });
        names.add(name);
      } catch (error) { warnOnce(context, `repository skill invalid repository=${source.id} name=${name}`, error); }
    }
  }
  return skills;
}

const systemSkill = (name: string): ResolvedSkill | undefined => {
  const skill = bundledSkills.find(entry => entry.name === name);
  return skill && { name: skill.name, description: skill.description, instructions: skill.instructions, services: [...skill.services],
    resources: { ...skill.resources }, owner: { kind: "system" } };
};

export async function resolveSkill(context: VMContext, name: string): Promise<ResolvedSkill> {
  const system = systemSkill(name);
  if (system) return system;
  const profile = context.profile();
  if (isLocalSkillName(name) && await hasProfileSkill(profile, name)) return { ...await loadProfileSkill(profile, name), owner: { kind: "profile" } };
  const repository = (await repositorySkills(context)).find(skill => skill.name === name);
  if (!repository) throw skillErrors.missing(name);
  return repository;
}

export async function skillCatalog(context: VMContext): Promise<ResolvedSkill[]> {
  const skills = bundledSkills.map(skill => systemSkill(skill.name)!);
  const names = new Set(skills.map(skill => skill.name));
  const profile = context.profile();
  for (const name of await profileSkillNames(profile)) {
    if (names.has(name)) continue;
    try { skills.push({ ...await loadProfileSkill(profile, name), owner: { kind: "profile" } }); names.add(name); }
    catch (error) { warnOnce(context, `profile skill invalid name=${name}`, error); }
  }
  for (const skill of await repositorySkills(context)) if (!names.has(skill.name)) { names.add(skill.name); skills.push(skill); }
  return skills.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

export async function writeProfileSkill(profile: LinuxProfile, skill: SkillContent) {
  const prefix = `skills/${skill.name}`;
  if (await hasProfileSkill(profile, skill.name)) throw skillErrors.exists(skill.name);
  try {
    for (const [path, text] of Object.entries(skill.resources).sort(([a], [b]) => a < b ? -1 : 1)) await profile.writeFile(`${prefix}/${path}`, text);
    await profile.writeFile(`${prefix}/SKILL.md`, serializeSkill(skill));
  } catch (error) {
    await profile.removeFile(prefix).catch(() => {});
    throw error;
  }
}

async function localManifest(local: string) {
  const path = join(local, "repository.json");
  const manifest = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  const save = async (skills: string[]) => {
    const temporary = `${path}.ox-${crypto.randomUUID()}`;
    await writeFile(temporary, `${JSON.stringify({ ...manifest, skills }, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, path);
  };
  return { skills: Array.isArray(manifest.skills) ? manifest.skills.filter((name): name is string => typeof name === "string") : [], save };
}

export async function saveLocalSkill(context: VMContext, skill: SkillContent) {
  if (reserved.has(skill.name)) throw skillErrors.reserved(skill.name);
  validateSkill(skill);
  const local = context.paths.local, destination = join(local, "skills", skill.name);
  const manifest = await localManifest(local);
  if (existsSync(destination) || manifest.skills.includes(skill.name)) throw skillErrors.exists(skill.name);
  const parent = join(local, "skills");
  await mkdir(parent, { recursive: true, mode: 0o700 });
  if ((await lstat(parent)).isSymbolicLink()) throw skillErrors.invalidPackage();
  const staging = join(parent, `.ox-skill-${crypto.randomUUID()}`);
  try {
    for (const [path, text] of Object.entries({ ...skill.resources, "SKILL.md": serializeSkill(skill) })) {
      const file = join(staging, path);
      await mkdir(join(file, ".."), { recursive: true, mode: 0o700 });
      await writeFile(file, text, { mode: 0o600 });
    }
    await rename(staging, destination);
  } finally { await rm(staging, { recursive: true, force: true }); }
  await manifest.save([...manifest.skills, skill.name].sort());
}

export async function deleteLocalSkill(context: VMContext, name: string) {
  const manifest = await localManifest(context.paths.local);
  if (!isLocalSkillName(name) || !manifest.skills.includes(name)) throw skillErrors.missing(name);
  await manifest.save(manifest.skills.filter(entry => entry !== name));
  await rm(join(context.paths.local, "skills", name), { recursive: true, force: true });
}

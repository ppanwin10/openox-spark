import { lstat, rename, rm, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { OxError, type FunctionCall, type LinuxProfile } from "@openox/agent/linux";
import { bodyBytes, HTTPError, json, payload } from "../http";
import type { VMContext, VMFactory } from "./context";
import { FunctionApprovals } from "./skills-approval";
import { canonicalSkillName, deleteLocalSkill, draftSkill, hasProfileSkill, isLocalSkillName, parseSkill, repositorySkills, resolveSkill, saveLocalSkill, serializeSkill, skillCatalog,
  skillErrors, skillLimits, writeProfileSkill, type ResolvedSkill, type SkillContent } from "./skills-files";
import { decodeSkillPackage, encodeSkillPackage, packageLimits } from "./skills-package";
import { SkillPreferences } from "./skills-preferences";

const scriptPart = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const content = ({ name, description, instructions, services, resources }: SkillContent): SkillContent => ({ name, description, instructions, services, resources });
const result = (skill: SkillContent, source?: string) => ({ name: skill.name, description: skill.description, services: skill.services,
  path: `skills/${skill.name}/SKILL.md`, ...(source !== undefined ? { source } : {}) });
const row = (skill: ResolvedSkill, preferences: SkillPreferences) => ({ name: skill.name, description: skill.description, source: skill.owner.kind === "repository" ? skill.owner.id : skill.owner.kind,
  path: skill.owner.kind === "repository" ? `repositories/${skill.owner.id}/skills/${skill.name}/SKILL.md` : `skills/${skill.name}/SKILL.md`, services: skill.services,
  enabled: preferences.enabled(skill.name), lastUsedAt: preferences.lastUsed(skill.name), deletable: skill.owner.kind === "profile", builtIn: skill.owner.kind === "system" });
const revisionOf = (skill: SkillContent) => new Bun.CryptoHasher("sha256").update(serializeSkill(skill)).digest("hex").slice(0, 16);

async function replaceLocalSkillFile(local: string, name: string, text: string) {
  const directory = join(local, "skills", name);
  if ((await lstat(directory)).isSymbolicLink() || (await lstat(join(local, "skills"))).isSymbolicLink()) throw new HTTPError(400, "This skill can't be edited on this Host");
  const temporary = join(directory, `.SKILL.md.ox-${crypto.randomUUID()}`);
  try {
    await writeFile(temporary, text, { mode: 0o600, flag: "wx" });
    await rename(temporary, join(directory, "SKILL.md"));
  } finally { await rm(temporary, { force: true }); }
}

function importedSkill(bytes: Uint8Array): SkillContent {
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) return decodeSkillPackage(bytes);
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new OxError("invalid", "Upload a SKILL.md text file or a .skill package.", "Choose a SKILL.md file or a .skill package exported by Ox."); }
  const invalid = () => new OxError("invalid", "SKILL.md needs frontmatter with a name and a description, then instructions.", "Start the file with ---, name: and description: lines, ---, and the instructions.");
  const normalized = text.replaceAll("\r\n", "\n");
  const closing = normalized.startsWith("---\n") ? normalized.indexOf("\n---\n", 3) : -1;
  const header = closing < 0 ? "" : normalized.slice(4, closing);
  const declared = /^name:\s*"?([^"\n]*?)"?\s*$/m.exec(header)?.[1]?.trim();
  if (!declared) throw invalid();
  const name = canonicalSkillName(declared);
  const parsed = parseSkill(`---\n${header.replace(/^name:.*$/m, `name: ${name}`)}${normalized.slice(closing)}`, name);
  if (!parsed) throw invalid();
  return draftSkill(parsed.name, parsed.description, parsed.instructions, parsed.services);
}

async function availablePath(profile: LinuxProfile, directory: string, name: string) {
  const extension = extname(name), stem = basename(name, extension);
  for (let index = 1; index < 1_000; index++) {
    const candidate = `${directory}/${index === 1 ? name : `${stem} (${index})${extension}`}`;
    if (!await profile.statFile(candidate).then(() => true, () => false)) return candidate;
  }
  throw new OxError("conflict", "Too many skill packages with this name", "Remove older packages from this conversation's folder.");
}

export const skillsModule: VMFactory = async (context: VMContext) => {
  const approvals = FunctionApprovals.for(context.paths.state);
  const preferences = await SkillPreferences.open(context.paths.state);
  const used = (name: string) => {
    void preferences.markUsed(name).then(() => context.emit({ type: "skills" }), error => context.logs.warning("skills", `usage not saved name=${name}: ${error instanceof Error ? error.message : String(error)}`));
  };
  const saved = async (build: () => SkillContent) => {
    let skill: SkillContent;
    try {
      skill = build();
      await writeProfileSkill(context.profile(), skill);
    } catch (error) {
      if (error instanceof OxError) throw new HTTPError(error.code === "conflict" ? 409 : 400, error.message);
      throw error;
    }
    await preferences.forget(skill.name);
    context.logs.info("skills", `create name=${skill.name} by=web`);
    await changed();
    return json(row({ ...skill, owner: { kind: "profile" } }, preferences), { status: 201 });
  };
  const changed = async (call?: FunctionCall) => {
    context.emit({ type: "skills" });
    if (call) await call.profile.refreshTurnState(call.conversationId).catch(error => context.logs.warning("skills", `turn state refresh failed: ${error instanceof Error ? error.message : String(error)}`));
  };
  return {
    handlers: {
      "ox.skill.create": async call => {
        const { name, description, instructions, services } = call.args as { name: string; description: string; instructions: string; services?: string[] };
        const skill = draftSkill(canonicalSkillName(name), description, instructions, services ?? []);
        await writeProfileSkill(call.profile, skill);
        context.logs.info("skills", `create name=${skill.name} services=${skill.services.length}`);
        await changed(call);
        return result(skill);
      },
      "ox.skill.copy": async call => {
        const { source, name } = call.args as { source: string; name: string };
        const original = await resolveSkill(context, source);
        const skill = draftSkill(canonicalSkillName(name), original.description, original.instructions, original.services, original.resources);
        await writeProfileSkill(call.profile, skill);
        context.logs.info("skills", `copy source=${original.name} name=${skill.name}`);
        await changed(call);
        return result(skill, source);
      },
      "ox.skill.delete": async call => {
        const skill = await resolveSkill(context, String(call.args.name));
        if (skill.owner.kind === "system") throw skillErrors.reserved(skill.name);
        if (skill.owner.kind === "repository" && skill.owner.id !== "local") {
          throw new OxError("permission_denied", `/${skill.name} comes from the read-only repository ${skill.owner.name}.`, "Copy it with ox.skill.copy to customize it; installed repository skills cannot be deleted.");
        }
        await approvals.require(call, { action: "ox.skill.delete", title: "Delete a skill" });
        if (skill.owner.kind === "repository") await deleteLocalSkill(context, skill.name);
        else await call.profile.removeFile(`skills/${skill.name}`);
        await preferences.forget(skill.name);
        context.logs.info("skills", `delete name=${skill.name} source=${skill.owner.kind}`);
        await changed(call);
        return { name: skill.name, path: `skills/${skill.name}/SKILL.md`, deleted: true };
      },
      "ox.skill.share": async call => {
        const skill = content(await resolveSkill(context, String(call.args.name)));
        const archive = encodeSkillPackage(skill);
        decodeSkillPackage(archive);
        await saveLocalSkill(context, skill);
        const path = await availablePath(call.profile, `conversations/${call.conversationId}`, `${skill.name}.skill`);
        await call.profile.writeFile(path, archive);
        await call.update({ path });
        context.logs.info("skills", `share name=${skill.name} bytes=${archive.length}`);
        await changed(call);
        return result(skill, "repository:local");
      },
      "ox.skill.run": async call => {
        const { name, script, args } = call.args as { name: string; script: string; args?: unknown };
        if (!script.endsWith(".js") || script.split("/").some(part => !scriptPart.test(part))) {
          throw new OxError("invalid_argument", "Invalid skill script path", "Pass a path relative to the skill's scripts/ folder that ends in .js.");
        }
        const skill = await resolveSkill(context, name);
        if (!preferences.enabled(skill.name)) throw new OxError("permission_denied", `/${skill.name} is turned off in Settings.`, "Continue without this skill, or ask the user to turn it on in Settings, Skills.");
        const source = skill.resources[`scripts/${script}`];
        if (source === undefined) throw new OxError("not_found", `skills/${skill.name}/scripts/${script} does not exist`, "Read the skill instructions and list its scripts/ folder before retrying.");
        if (source.length > skillLimits.script) throw new OxError("invalid", "Skill script exceeds size limit", "Split the helper into smaller scripts.");
        const { value, logs } = await call.evaluate(source, args ?? null);
        used(skill.name);
        return value ?? (logs.length ? logs.join("\n") : null);
      },
    },
    disabledSkills: () => preferences.disabled(),
    skillUsed: used,
    skills: async () => (await repositorySkills(context)).map(skill => ({ name: skill.name,
      description: `${skill.description} Files: repositories/${skill.owner.kind === "repository" ? skill.owner.id : "local"}/skills/${skill.name}/` })),
    routes: {
      skills: async (request, _url, parts) => {
        if (!parts.length && request.method === "GET") return json({ skills: (await skillCatalog(context)).map(skill => row(skill, preferences)) });
        if (!parts.length && request.method === "POST") {
          const body = await payload<{ name?: unknown; description?: unknown; instructions?: unknown }>(request);
          if (typeof body.name !== "string" || typeof body.description !== "string" || typeof body.instructions !== "string") throw new HTTPError(400, "Name, description and instructions are required");
          const { name, description, instructions } = body as { name: string; description: string; instructions: string };
          return saved(() => draftSkill(canonicalSkillName(name), description, instructions, []));
        }
        if (parts.length === 1 && parts[0] === "import" && request.method === "POST") {
          const bytes = await bodyBytes(request, packageLimits.archive, "The skill file is too large");
          if (!bytes.length) throw new HTTPError(400, "The file is empty");
          return saved(() => importedSkill(bytes));
        }
        if (parts.length === 2 && parts[1] === "enabled" && request.method === "PUT") {
          const name = parts[0]!;
          const body = await payload<{ enabled?: unknown }>(request);
          if (typeof body.enabled !== "boolean") throw new HTTPError(400, "enabled must be true or false");
          if (!(await skillCatalog(context)).some(skill => skill.name === name)) throw new HTTPError(404, "Skill not found");
          await preferences.setEnabled(name, body.enabled);
          context.logs.info("skills", `enabled name=${name} value=${body.enabled}`);
          context.emit({ type: "skills" });
          return json({ name, enabled: body.enabled });
        }
        if (parts.length === 1 && (request.method === "GET" || request.method === "PUT")) {
          const name = parts[0]!;
          const skill = await resolveSkill(context, name).catch(() => { throw new HTTPError(404, "Skill not found"); });
          const editable = skill.owner.kind === "profile" || (skill.owner.kind === "repository" && skill.owner.id === "local");
          const detail = (value: ResolvedSkill) => json({ ...row(value, preferences), instructions: value.instructions, editable, revision: revisionOf(value) });
          if (request.method === "GET") return detail(skill);
          if (!editable) throw new HTTPError(403, "This skill can't be edited on this Host");
          const body = await payload<{ description?: unknown; instructions?: unknown; revision?: unknown }>(request);
          if (typeof body.description !== "string" || typeof body.instructions !== "string" || (body.revision !== undefined && typeof body.revision !== "string")) {
            throw new HTTPError(400, "Description and instructions are required");
          }
          if (body.revision !== undefined && body.revision !== revisionOf(skill)) throw new HTTPError(409, "This skill changed after you opened it. Open it again to see the latest version.");
          let updated: SkillContent;
          try { updated = draftSkill(skill.name, body.description, body.instructions, skill.services, skill.resources); }
          catch (error) { throw new HTTPError(400, error instanceof Error ? error.message : String(error)); }
          if (skill.owner.kind === "profile") await context.profile().writeFile(`skills/${skill.name}/SKILL.md`, serializeSkill(updated));
          else await replaceLocalSkillFile(context.paths.local, skill.name, serializeSkill(updated));
          context.logs.info("skills", `edit name=${skill.name} source=${skill.owner.kind === "profile" ? "profile" : "local"} by=web`);
          await changed();
          return detail({ ...updated, owner: skill.owner });
        }
        if (parts.length === 1 && request.method === "DELETE") {
          const name = parts[0]!, profile = context.profile();
          if (!isLocalSkillName(name) || !await hasProfileSkill(profile, name)) throw new HTTPError(404, "Profile skill not found");
          await profile.removeFile(`skills/${name}`);
          await preferences.forget(name);
          context.logs.info("skills", `delete name=${name} source=profile by=web`);
          await changed();
          return json({ deleted: true });
        }
        throw new HTTPError(404, "Not found");
      },
    },
  };
};

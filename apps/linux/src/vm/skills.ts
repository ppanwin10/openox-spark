import { basename, extname } from "node:path";
import { OxError, type FunctionCall, type LinuxProfile } from "@openox/agent/linux";
import { HTTPError, json } from "../http";
import type { VMContext, VMFactory } from "./context";
import { FunctionApprovals } from "./skills-approval";
import { canonicalSkillName, deleteLocalSkill, draftSkill, hasProfileSkill, isLocalSkillName, repositorySkills, resolveSkill, saveLocalSkill, skillCatalog,
  skillErrors, skillLimits, writeProfileSkill, type ResolvedSkill, type SkillContent } from "./skills-files";
import { decodeSkillPackage, encodeSkillPackage } from "./skills-package";

const scriptPart = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const content = ({ name, description, instructions, services, resources }: SkillContent): SkillContent => ({ name, description, instructions, services, resources });
const result = (skill: SkillContent, source?: string) => ({ name: skill.name, description: skill.description, services: skill.services,
  path: `skills/${skill.name}/SKILL.md`, ...(source !== undefined ? { source } : {}) });
const row = (skill: ResolvedSkill) => ({ name: skill.name, description: skill.description, source: skill.owner.kind === "repository" ? skill.owner.id : skill.owner.kind,
  path: skill.owner.kind === "repository" ? `repositories/${skill.owner.id}/skills/${skill.name}/SKILL.md` : `skills/${skill.name}/SKILL.md`, services: skill.services });

async function availablePath(profile: LinuxProfile, directory: string, name: string) {
  const extension = extname(name), stem = basename(name, extension);
  for (let index = 1; index < 1_000; index++) {
    const candidate = `${directory}/${index === 1 ? name : `${stem} (${index})${extension}`}`;
    if (!await profile.statFile(candidate).then(() => true, () => false)) return candidate;
  }
  throw new OxError("conflict", "Too many skill packages with this name", "Remove older packages from this conversation's folder.");
}

export const skillsModule: VMFactory = (context: VMContext) => {
  const approvals = FunctionApprovals.for(context.paths.state);
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
        const source = skill.resources[`scripts/${script}`];
        if (source === undefined) throw new OxError("not_found", `skills/${skill.name}/scripts/${script} does not exist`, "Read the skill instructions and list its scripts/ folder before retrying.");
        if (source.length > skillLimits.script) throw new OxError("invalid", "Skill script exceeds size limit", "Split the helper into smaller scripts.");
        const { value, logs } = await call.evaluate(source, args ?? null);
        return value ?? (logs.length ? logs.join("\n") : null);
      },
    },
    skills: async () => (await repositorySkills(context)).map(skill => ({ name: skill.name,
      description: `${skill.description} Files: repositories/${skill.owner.kind === "repository" ? skill.owner.id : "local"}/skills/${skill.name}/` })),
    routes: {
      skills: async (request, _url, parts) => {
        if (!parts.length && request.method === "GET") return json({ skills: (await skillCatalog(context)).map(row) });
        if (parts.length === 1 && request.method === "DELETE") {
          const name = parts[0]!, profile = context.profile();
          if (!isLocalSkillName(name) || !await hasProfileSkill(profile, name)) throw new HTTPError(404, "Profile skill not found");
          await profile.removeFile(`skills/${name}`);
          context.logs.info("skills", `delete name=${name} source=profile by=web`);
          await changed();
          return json({ deleted: true });
        }
        throw new HTTPError(404, "Not found");
      },
    },
  };
};

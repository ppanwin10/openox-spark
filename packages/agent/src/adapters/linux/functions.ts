import { Value } from "typebox/value";
import type { TSchema } from "typebox";
import { contracts } from "../../functions/contracts";
import { guidanceText } from "../../core/guidance-texts";
import linux from "./linux-contracts.json";

type Contract = { description: string; inputSchema: TSchema; outputSchema: TSchema };
const secretAdd = contracts["ox.secret.add"], serviceCreate = contracts["ox.service.create"];
const catalog = { ...contracts, ...linux,
  "ox.secret.add": { ...secretAdd, description: `${secretAdd.description} This Linux Host also accepts legacy calls without type for a generic secret form.`,
    inputSchema: { ...secretAdd.inputSchema, required: secretAdd.inputSchema.required.filter(key => key !== "type") } },
  "ox.service.create": { ...serviceCreate, description: `${serviceCreate.description} Legacy Linux calls may omit name; new calls should provide it.`,
    inputSchema: { ...serviceCreate.inputSchema, required: serviceCreate.inputSchema.required.filter(key => key !== "name") } },
  "ox.web.browser.showPage": { ...contracts["ox.web.browser.showPage"],
    description: "Show Browser's actual live page in this Linux Host's web client. Presentation proves neither interaction nor correctness. This Host does not accept instructions here or create an automatic follow-up turn; use ox.web.browser.waitForUserInteraction for an explicit Done/Cancel acknowledgment. It does not stop capture or clear injected scripts. Use ox.service.showPage for a service action's prepared page." },
  "ox.service.showPage": { ...contracts["ox.service.showPage"],
    description: "Show a web action's existing prepared live page in this Host's web client. Preserve its qualified name, input, session and pageUrl; this never invokes, navigates, reloads or replaces the action. Missing, busy, changed or closed pages fail. The awaiting_user status means presentation only: this Linux Host does not add native Done/Cancel controls or an automatic follow-up turn. Explain the person's step, finish the turn and wait for their explicit message; inspect fresh state before continuing and never replay a write to obtain a page. Use the website's login action for its human sign-in handoff. Presentation proves neither interaction nor completion." },
} as Record<string, Contract>;
const namespaceGuidance: Record<string, string> = {
  "namespace.media": "Generate images, transcribe speech, read text aloud, and look inside videos and document pages with models running on this Host.",
};

export const linuxFunctions = [
  "ox.fs.stat", "ox.fs.list", "ox.fs.read", "ox.fs.write", "ox.fs.edit", "ox.fs.mkdir", "ox.fs.rm", "ox.fs.move", "ox.fs.copy", "ox.fs.glob", "ox.fs.grep",
  "ox.user.choose", "ox.user.progress", "ox.user.follow",
] as const;
export type LinuxFunction = typeof linuxFunctions[number];

export class OxError extends Error {
  readonly code: string;
  readonly recovery: string;
  constructor(code: string, message: string, recovery = "Inspect the current state and function help before retrying.") {
    super(message);
    this.code = code;
    this.recovery = recovery;
  }
}

const summary = (contract: Contract) => contract.description.split(/\s+/).join(" ")
  .split(/: `|: await | before calling await | with `\{|(?<=[.?!]) /, 1)[0]!.replace(/(?<![.?!])$/, ".");

export function supportedFunctions(extra: Iterable<string> = []) {
  const names = new Set<string>(linuxFunctions);
  for (const name of extra) {
    if (!catalog[name]) throw new Error(`Unknown Host function: ${name}`);
    names.add(name);
  }
  return [...names].sort();
}

export function functionCatalog(names: readonly string[]) {
  const namespaces = [...new Set(names.map(name => name.split(".")[1]!))];
  return [
    ...namespaces.map(name => `ox.${name} — ${namespaceGuidance[`namespace.${name}`] ?? guidanceText(`namespace.${name}`)}`), "",
    ...names.map(name => `${name} — ${summary(catalog[name]!)}`).sort(),
  ].join("\n");
}

export function scriptContracts(names: readonly string[]) {
  const supported = new Set(names);
  return Object.fromEntries(Object.keys(catalog).sort().map(name => [name, supported.has(name) ? catalog[name] : null]));
}

export function checkedCall(name: string, args: unknown, supported: ReadonlySet<string>) {
  if (!catalog[name]) throw new OxError("invalid_argument", `Unknown function: ${name}`, "Use only functions listed by ox.help().");
  if (!supported.has(name)) throw new OxError("not_supported", `${name} is not available on this Linux Host`, "Tell the user this capability is unavailable on this Host, or continue with the functions listed by ox.help().");
  const schema = catalog[name]!.inputSchema;
  if (!Value.Check(schema, args)) {
    const errors = [...Value.Errors(schema, args)].slice(0, 5).map(error => `${error.instancePath || "/"} ${error.message}`).join("; ");
    throw new OxError("invalid_argument", `${name}: ${errors}`, `Retry with arguments that match this input schema: ${JSON.stringify(schema)}`);
  }
  return name;
}

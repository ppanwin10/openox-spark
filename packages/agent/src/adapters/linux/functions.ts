import { Value } from "typebox/value";
import type { TSchema } from "typebox";
import { contracts } from "../../functions/contracts";
import { guidanceText } from "../../core/guidance-texts";

type Contract = { description: string; inputSchema: TSchema; outputSchema: TSchema };
const catalog = contracts as Record<string, Contract>;

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
    ...namespaces.map(name => `ox.${name} — ${guidanceText(`namespace.${name}`)}`), "",
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
    throw new OxError("invalid_argument", `${name}: ${errors}`, `Read ${name}.help() and retry with valid arguments.`);
  }
  return name;
}

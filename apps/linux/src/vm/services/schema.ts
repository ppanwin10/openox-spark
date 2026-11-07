import Ajv, { type ValidateFunction } from "ajv";
import { isObject } from "./support";

const ajv = new Ajv({ strict: false, validateFormats: false, allErrors: true, addUsedSchema: false, allowUnionTypes: true });
const compiled = new Map<string, ValidateFunction | string>();

function compile(schema: unknown, defs: Record<string, unknown>) {
  const base = isObject(schema) ? schema : schema === true || schema === undefined ? {} : schema;
  if (!isObject(base)) return "schema is not an object";
  const { $id: _id, $schema: _schema, ...rest } = base;
  const definitions = { ...defs, ...(isObject(rest.$defs) ? rest.$defs : {}) };
  const document = Object.keys(definitions).length ? { ...rest, $defs: definitions } : rest;
  const key = JSON.stringify(document);
  let validate = compiled.get(key);
  if (validate === undefined) {
    try { validate = ajv.compile(document); }
    catch (error) { validate = `invalid schema: ${error instanceof Error ? error.message : String(error)}`; }
    if (compiled.size > 500) compiled.delete(compiled.keys().next().value!);
    compiled.set(key, validate);
  }
  return validate;
}

export function violations(value: unknown, schema: unknown, defs: Record<string, unknown> = {}): string[] {
  const validate = compile(schema, defs);
  if (typeof validate === "string") return [validate];
  if (validate(value)) return [];
  return (validate.errors ?? []).slice(0, 3).map(error => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`);
}

export const describeViolations = (issues: string[]) => issues.join("; ");

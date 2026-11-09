import { join } from "node:path";
import type { FunctionCall, PromptField } from "@openox/agent/linux";
import { HTTPError, json, payload } from "../../http";
import type { VMContext, VMRoute } from "../context";
import type { Approvals } from "./policy";
import { canonicalJSON, fail, isObject, readJSONFile, Serial, sha256, writeJSONFile } from "./support";

type Origin = { kind: "named" } | { kind: "generated"; consumer: "apiService"; id: string };
interface Entry { key: string; displayName: string; origin: Origin; value: Record<string, string> }
interface Binding { consumerKind: "apiService"; consumerID: string; secretKey: string; destination: string; configurationFingerprint: string; requiredFields: string[] }
interface SecretFile { version: 1; entries: Entry[]; bindings: Binding[] }

export function validateKey(key: string) {
  if (new TextEncoder().encode(key).length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(key)) throw fail("invalid_argument", "Invalid secret key", "Use letters, digits, dots, hyphens, and underscores, starting with a letter or digit.");
}

function validateDisplayName(name: string) {
  if (!name || [...name].length > 80 || name !== name.normalize("NFC")) throw fail("invalid_argument", "Invalid secret display name", "Use a display name of 1-80 characters.");
}

function validateValue(value: Record<string, string>) {
  const keys = Object.keys(value);
  if (!keys.length || keys.some(key => !key) || Object.values(value).some(field => typeof field !== "string") || new TextEncoder().encode(JSON.stringify(value)).length > 16_384) {
    throw fail("invalid_argument", "Secret value must be a flat JSON object of text fields", "Enter a single value, or a JSON object whose fields are all text.");
  }
}

export class Secrets {
  private path: string;
  private file: SecretFile = { version: 1, entries: [], bindings: [] };
  private serial = new Serial();

  constructor(state: string) { this.path = join(state, "secrets.json"); }

  async load() {
    const stored = await readJSONFile<Partial<SecretFile>>(this.path, {});
    this.file = { version: 1, entries: Array.isArray(stored.entries) ? stored.entries : [], bindings: Array.isArray(stored.bindings) ? stored.bindings : [] };
  }

  private update(change: (file: SecretFile) => void) {
    return this.serial.run(async () => {
      const next = structuredClone(this.file);
      change(next);
      await writeJSONFile(this.path, next);
      this.file = next;
    });
  }

  entry(key: string) { return this.file.entries.find(entry => entry.key === key); }

  list() {
    return this.file.entries.map(entry => ({ key: entry.key, displayName: entry.displayName, fields: Object.keys(entry.value).sort(), available: Object.keys(entry.value).length > 0 }));
  }

  set(key: string, displayName: string, value: Record<string, string>, origin: Origin = { kind: "named" }) {
    validateKey(key);
    if (key.startsWith("ox.") && origin.kind === "named") throw fail("invalid_argument", "Secret key is reserved", "Choose a key that does not start with ox.");
    validateDisplayName(displayName);
    validateValue(value);
    return this.update(file => {
      const existing = file.entries.find(entry => entry.key === key);
      for (const binding of file.bindings.filter(binding => binding.secretKey === key)) {
        if (!binding.requiredFields.every(field => typeof value[field] === "string")) throw fail("invalid_argument", "Secret value is missing fields required by a connection", `Include the fields ${binding.requiredFields.join(", ")}.`);
      }
      if (existing) { existing.displayName = displayName; existing.value = value; }
      else file.entries.push({ key, displayName, origin, value });
    });
  }

  delete(key: string) {
    return this.update(file => {
      file.bindings = file.bindings.filter(binding => binding.secretKey !== key);
      file.entries = file.entries.filter(entry => entry.key !== key);
    });
  }

  apiCredential(id: string, fingerprint: string) {
    const binding = this.file.bindings.find(binding => binding.consumerKind === "apiService" && binding.consumerID === id);
    if (!binding || binding.configurationFingerprint !== fingerprint) return undefined;
    const value = this.entry(binding.secretKey)?.value;
    return value && binding.requiredFields.every(field => typeof value[field] === "string") ? value : undefined;
  }

  saveAPICredential(id: string, fingerprint: string, displayName: string, destination: string, value: Record<string, string>) {
    const bound = this.file.bindings.find(binding => binding.consumerKind === "apiService" && binding.consumerID === id);
    const owned = bound && this.entry(bound.secretKey)?.origin;
    const base = `ox.api-service.${id.slice(0, 24)}`;
    const key = owned?.kind === "generated" && owned.id === id ? bound!.secretKey
      : this.entry(base) ? `${base}.${crypto.randomUUID().toLowerCase()}` : base;
    validateValue(value);
    return this.update(file => {
      const existing = file.entries.find(entry => entry.key === key);
      if (existing) { existing.value = value; existing.displayName = displayName; }
      else file.entries.push({ key, displayName: displayName.slice(0, 80) || "API credential", origin: { kind: "generated", consumer: "apiService", id }, value });
      file.bindings = file.bindings.filter(binding => !(binding.consumerKind === "apiService" && binding.consumerID === id));
      file.bindings.push({ consumerKind: "apiService", consumerID: id, secretKey: key, destination, configurationFingerprint: fingerprint, requiredFields: Object.keys(value).sort() });
    });
  }

  clearAPICredential(id: string) {
    return this.update(file => {
      const removed = file.bindings.filter(binding => binding.consumerKind === "apiService" && binding.consumerID === id);
      file.bindings = file.bindings.filter(binding => !removed.includes(binding));
      file.entries = file.entries.filter(entry => !(entry.origin.kind === "generated" && entry.origin.id === id && removed.some(binding => binding.secretKey === entry.key)));
    });
  }
}

export const apiIdentity = (repository: string, domain: string) => sha256(`${repository}:${domain}`);
export const apiFingerprint = (auth: unknown, baseURL: string, repository: string, domain: string) => sha256(canonicalJSON({ auth, baseURL, repository, domain }));

function parseSecret(values: Record<string, string>) {
  const text = values.value ?? "";
  const field = values.field?.trim();
  if (!field && text.trim().startsWith("{")) {
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { throw fail("invalid_argument", "The JSON object could not be read", "Enter valid JSON, or a single value."); }
    if (!isObject(parsed) || Object.values(parsed).some(value => typeof value !== "string")) throw fail("invalid_argument", "Every field in the JSON object must be text", "Use text values only.");
    return parsed as Record<string, string>;
  }
  return { [field || "value"]: text };
}

export function secretFunctions(context: VMContext, secrets: Secrets, approvals: Approvals) {
  const tracked = async (call: FunctionCall, action: string, args: Record<string, unknown>) => approvals.require(call, action, action.endsWith(".delete") ? "ask" : "allow", { args });
  return {
    "ox.secret.list": async (call: FunctionCall) => call.untimed(async () => {
      await tracked(call, "ox.secret.list", {});
      return secrets.list();
    }),
    "ox.secret.add": async (call: FunctionCall) => call.untimed(async () => {
      const key = String(call.args.key);
      await tracked(call, "ox.secret.add", { key });
      validateKey(key);
      if (key.startsWith("ox.")) throw fail("invalid_argument", "Secret key is reserved", "Choose a key that does not start with ox.");
      const existing = secrets.entry(key);
      const fields: PromptField[] = [
        { name: "displayName", label: "Display name", optional: true },
        { name: "field", label: "Field name, such as apiKey (default: value)", optional: true },
        { name: "value", label: "Secret value, or a JSON object of text fields", secret: true },
      ];
      let problem = "";
      for (let attempt = 0; attempt < 3; attempt++) {
        const answer = await call.ask({ kind: "form", title: existing ? "Edit Secret" : "Add Secret", submit: "Save", fields,
          body: `${problem ? `${problem}\n\n` : ""}Save the secret ${key}. The value stays on this Host and is never shown to the assistant.` });
        if (answer.kind !== "values") return { key, status: "cancelled" };
        try {
          const value = parseSecret(answer.values);
          await secrets.set(key, answer.values.displayName?.trim() || existing?.displayName || key, value);
          context.logs.info("secrets", `secret saved key=${key} fields=${Object.keys(value).length}`);
          context.emit({ type: "secrets" });
          return { key, status: "saved" };
        } catch (error) {
          problem = error instanceof Error ? error.message : String(error);
        }
      }
      throw fail("invalid_argument", problem || "The secret could not be saved", "Ask the user whether to try again.");
    }),
    "ox.secret.delete": async (call: FunctionCall) => call.untimed(async () => {
      const key = String(call.args.key);
      if (!secrets.entry(key)) throw fail("not_found", "Secret entry was not found", "List secrets with ox.secret.list.");
      await tracked(call, "ox.secret.delete", { key });
      const answer = await call.ask({ kind: "choice", body: `Delete secret ${key}? Connections using it will need to be set up again.`, options: ["Delete", "Cancel"] });
      if (answer.kind !== "answer" || answer.text !== "Delete") return { key, status: "cancelled" };
      await secrets.delete(key);
      context.logs.info("secrets", `secret deleted key=${key}`);
      context.emit({ type: "secrets" });
      return { key, status: "deleted" };
    }),
  };
}

export function secretRoute(context: VMContext, secrets: Secrets): VMRoute {
  return async (request, _url, parts) => {
    const [key] = parts;
    if (!key && request.method === "GET") {
      return json({ secrets: secrets.list().map(secret => ({ key: secret.key, name: secret.displayName, fields: secret.fields, available: secret.available })) });
    }
    if ((!key && request.method === "POST") || (key && parts.length === 1 && request.method === "PUT")) {
      const body = await payload<{ key?: unknown; name?: unknown; fields?: unknown }>(request);
      const target = key ?? (typeof body.key === "string" ? body.key.trim() : "");
      const existing = secrets.entry(target);
      if (key && !existing) throw new HTTPError(404, "Secret not found");
      if (!key && existing) throw new HTTPError(409, "A secret with this key already exists");
      if (!isObject(body.fields) || Object.values(body.fields).some(value => typeof value !== "string")) throw new HTTPError(400, "Add at least one field");
      const value: Record<string, string> = {};
      for (const [field, entered] of Object.entries(body.fields as Record<string, string>)) {
        const name = field.trim();
        const kept = entered === "" ? existing?.value[name] : entered;
        if (!name || kept === undefined || kept === "") throw new HTTPError(400, name ? `Enter a value for ${name}` : "Name every field");
        value[name] = kept;
      }
      const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : existing?.displayName ?? target;
      try { await secrets.set(target, name, value, existing?.origin); }
      catch (error) { throw new HTTPError(400, error instanceof Error ? error.message : String(error)); }
      context.logs.info("secrets", `secret ${key ? "edited" : "added"} key=${target} fields=${Object.keys(value).length}`);
      context.emit({ type: "secrets" });
      return json({ key: target, name, fields: Object.keys(value).sort() }, { status: key ? 200 : 201 });
    }
    if (key && parts.length === 1 && request.method === "DELETE") {
      if (!secrets.entry(key)) throw new HTTPError(404, "Secret not found");
      await secrets.delete(key);
      context.logs.info("secrets", `secret deleted key=${key}`);
      context.emit({ type: "secrets" });
      return json({ deleted: true });
    }
    throw new HTTPError(404, "Not found");
  };
}

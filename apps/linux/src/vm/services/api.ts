import type { FunctionCall, PromptField } from "@openox/agent/linux";
import { OxError } from "@openox/agent/linux";
import type { VMContext } from "../context";
import { resolvesPublic } from "../net";
import type { Definition, Snapshot } from "./catalog";
import { apiError, handoffIncomplete, invokeError } from "./errors";
import { runIsolated } from "./sandbox";
import { violations } from "./schema";
import { apiFingerprint, apiIdentity, type Secrets } from "./secrets";
import { describe, fail, isObject, type JSONObject } from "./support";

const installer = `const __handlers = new Map();
let __installed = false;
const window = Object.freeze({ ox: Object.freeze({ install(install, ...extra) {
  if (typeof install !== 'function' || extra.length) throw new Error('window.ox.install takes only the installer');
  if (__installed) throw new Error('Invalid API installer');
  __installed = true;
  const action = (name, handler) => {
    if (typeof name !== 'string' || __handlers.has(name) || typeof handler?.invoke !== 'function') throw new Error('Invalid API action');
    __handlers.set(name, handler.invoke);
  };
  const request = args => __apiRequest(args);
  const api = new Proxy(Object.freeze({ action, request }), {
    get(target, name) {
      if (name in target) return target[name];
      throw new Error(\`service installer does not provide \${String(name)}\`);
    }
  });
  const result = install(api);
  if (result?.then) throw new Error('API installer must be synchronous');
} }) });
const __invokeAPI = async (name, args, declared) => {
  if (!__installed || declared.length !== __handlers.size || declared.some(id => !__handlers.has(id))) throw new Error('API action registration mismatch');
  return await __handlers.get(name)(args);
};`;

type Auth = { type: "none" } | { type: "apiKey"; in: "header" | "query"; name: string } | { type: "http"; scheme: "basic" | "bearer" } | { type: "oauth2" };
const responseLimit = 2_000_000;

export class APIRuntime {
  private context: VMContext;
  private secrets: Secrets;
  private rejected = new Map<string, string>();

  constructor(context: VMContext, secrets: Secrets) {
    this.context = context;
    this.secrets = secrets;
  }

  private auth(definition: Definition) { return (definition.auth ?? { type: "none" }) as Auth; }
  private identity(definition: Definition) { return apiIdentity(definition.candidate.repository.id, definition.domain); }
  private fingerprint(definition: Definition) { return apiFingerprint(definition.auth, definition.baseUrl ?? "", definition.candidate.repository.id, definition.domain); }
  requiresCredentials(definition: Definition) { return this.auth(definition).type !== "none"; }

  private credential(definition: Definition) {
    const value = this.secrets.apiCredential(this.identity(definition), this.fingerprint(definition));
    if (!value) return undefined;
    return this.rejected.get(this.identity(definition)) === JSON.stringify(value) ? undefined : value;
  }

  loginState(definition: Definition) {
    if (!this.requiresCredentials(definition)) return "notRequired";
    return this.credential(definition) ? "signedIn" : "signedOut";
  }

  credentialStatus(definition: Definition) {
    if (!this.requiresCredentials(definition)) return "notRequired";
    return this.credential(definition) ? "configured" : "notConfigured";
  }

  async configure(call: FunctionCall, definition: Definition) {
    const auth = this.auth(definition);
    if (auth.type === "none") return { completed: true, completion: "notRequired", state: "notRequired" };
    if (this.credential(definition)) return { completed: true, completion: "configured", state: "configured" };
    if (auth.type === "oauth2") {
      throw fail("not_supported", `${definition.name} uses OAuth sign-in, which this Linux Host cannot complete yet.`, "Tell the user to set up this service on an Ox app Host, or use an API key or token based service.");
    }
    const fields: PromptField[] = auth.type === "apiKey" ? [{ name: "apiKey", label: "API key", secret: true }]
      : auth.scheme === "bearer" ? [{ name: "token", label: "Token", secret: true }]
      : [{ name: "username", label: "Username" }, { name: "password", label: "Password", secret: true }];
    const answer = await call.ask({ kind: "form", title: `${definition.name} - Set up access`, submit: "Save", fields,
      body: `Enter the credentials for ${definition.name}. They are saved on this Host for ${new URL(definition.baseUrl!).host} and never shown to the assistant.` });
    if (answer.kind !== "values") {
      throw handoffIncomplete("The user cancelled or access setup failed.", "Do not reopen login automatically. Ask the user whether to continue, then inspect the service's login state before trying again.");
    }
    const value = Object.fromEntries(fields.map(field => [field.name, answer.values[field.name] ?? ""]));
    await this.secrets.saveAPICredential(this.identity(definition), this.fingerprint(definition), definition.name, definition.baseUrl!, value);
    this.rejected.delete(this.identity(definition));
    this.context.logs.info("services", `api credentials saved domain=${definition.domain}`);
    this.context.emit({ type: "secrets" });
    return { completed: true, completion: "configured", state: "configured" };
  }

  async clear(definition: Definition) {
    this.rejected.delete(this.identity(definition));
    await this.secrets.clearAPICredential(this.identity(definition));
  }

  private async request(definition: Definition, args: unknown, options: { authenticated: boolean; allowsMutation: boolean; signal: AbortSignal }) {
    if (!isObject(args) || typeof args.path !== "string" || !definition.baseUrl) throw apiError.destinationDenied();
    const base = new URL(definition.baseUrl);
    let url: URL;
    try { url = new URL(args.path, base); } catch { throw apiError.destinationDenied(); }
    const prefix = base.pathname.endsWith("/") ? base.pathname : `${base.pathname}/`;
    if (url.protocol !== base.protocol || url.hostname !== base.hostname || url.port !== base.port || url.username || url.password || url.hash
      || args.path.replaceAll("\\", "/").split(/[/?#]/).includes("..") || !url.pathname.startsWith(prefix)) throw apiError.destinationDenied();
    const method = typeof args.method === "string" ? args.method.toUpperCase() : "GET";
    if (!["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].includes(method)) throw apiError.invalidRequest();
    if (!options.allowsMutation && !["GET", "HEAD"].includes(method)) throw apiError.mutationDenied();
    if (args.query !== undefined) {
      if (!isObject(args.query)) throw apiError.invalidRequest();
      for (const key of Object.keys(args.query).sort()) {
        const value = args.query[key];
        if (value === null || value === undefined) continue;
        url.searchParams.append(key, typeof value === "string" ? value : JSON.stringify(value));
      }
    }
    if (!(await resolvesPublic(url))) throw apiError.destinationDenied();
    const headers: Record<string, string> = { accept: "application/json" };
    if (args.headers !== undefined) {
      if (!isObject(args.headers)) throw apiError.invalidRequest();
      const reserved = new Set(["authorization", "proxy-authorization", "cookie", "set-cookie", "host", "content-type", "content-length",
        "transfer-encoding", "connection", "keep-alive", "te", "trailer", "upgrade", "proxy-connection", "accept-encoding", "www-authenticate", "proxy-authenticate"]);
      const auth = this.auth(definition);
      if (auth.type === "apiKey" && auth.in === "header") reserved.add(auth.name.toLowerCase());
      const names = new Set<string>();
      for (const [name, value] of Object.entries(args.headers)) {
        const normalized = name.toLowerCase();
        if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name) || reserved.has(normalized) || names.has(normalized)
          || typeof value !== "string" || /[\u0000-\u0008\u000a-\u001f\u007f]/.test(value)) throw apiError.invalidRequest();
        names.add(normalized); headers[normalized] = value;
      }
    }
    let body: string | undefined;
    if (args.json !== undefined) {
      if (["GET", "HEAD"].includes(method)) throw apiError.invalidRequest();
      body = JSON.stringify(args.json);
      headers["content-type"] = "application/json";
    }
    const identity = this.identity(definition);
    let credential: Record<string, string> | undefined;
    if (options.authenticated) {
      credential = this.credential(definition);
      if (!credential) throw apiError.authorizationRequired();
      const auth = this.auth(definition);
      if (auth.type === "apiKey" && auth.in === "header") headers[auth.name.toLowerCase()] = credential.apiKey!;
      else if (auth.type === "apiKey") { url.searchParams.delete(auth.name); url.searchParams.append(auth.name, credential.apiKey!); }
      else if (auth.type === "http" && auth.scheme === "basic") headers.authorization = `Basic ${Buffer.from(`${credential.username ?? ""}:${credential.password ?? ""}`).toString("base64")}`;
      else if (auth.type === "http") headers.authorization = `Bearer ${credential.token}`;
    }
    let response: Response;
    try {
      response = await fetch(url, { method, headers, ...(body !== undefined ? { body } : {}), redirect: "manual",
        signal: AbortSignal.any([options.signal, AbortSignal.timeout(45_000)]) });
    } catch (error) {
      if (options.signal.aborted) throw fail("cancelled", "The operation was cancelled.", "Stop. Do not repeat the operation unless the user asks; inspect any possible effects before retrying a write.");
      this.context.logs.warning("services", `api transport failed domain=${definition.domain}: ${describe(error).slice(0, 200)}`);
      throw apiError.transport();
    }
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (reader) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > responseLimit) { await reader.cancel().catch(() => {}); throw apiError.responseTooLarge(); }
      chunks.push(value);
    }
    this.context.logs.info("services", `api request domain=${definition.domain} method=${method} status=${response.status} bytes=${size}`);
    if (response.status === 401 && options.authenticated) {
      this.rejected.set(identity, JSON.stringify(credential));
      throw apiError.authorizationRequired();
    }
    if (response.status < 200 || response.status >= 300) throw apiError.http(response.status);
    if (!size) return null;
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw apiError.invalidResponse(); }
  }

  async invoke(call: FunctionCall, snapshot: Snapshot, actionId: string, input: JSONObject) {
    const definition = snapshot.definition, name = `api:${definition.domain}:${actionId}`;
    const action = definition.index.get(actionId);
    if (!action) throw invokeError.unknown(name);
    if (action.requireAuth && !this.credential(definition)) throw apiError.authorizationRequired();
    let failure: OxError | undefined;
    const result = await runIsolated(`${installer}\n${snapshot.source}\nreturn await __invokeAPI(${JSON.stringify(actionId)}, ${JSON.stringify(input)}, ${JSON.stringify(definition.actions.map(entry => entry.id))});`, {
      timeoutMs: 60_000, memoryLimitBytes: 128 * 1024 * 1024, signal: call.signal,
      globals: [{ name: "__apiRequest", execute: async (args, context) => {
        try { return await this.request(definition, args, { authenticated: action.requireAuth, allowsMutation: action.requireApproval, signal: AbortSignal.any([call.signal, context.signal]) }); }
        catch (error) { failure = error instanceof OxError ? error : apiError.transport(); throw new Error(failure.message); }
      } }],
    });
    if (!result.ok) {
      if (failure && result.error.message.includes(failure.message)) throw failure;
      if (result.error.kind === "aborted") throw fail("cancelled", "The operation was cancelled.", "Stop. Do not repeat the operation unless the user asks; inspect any possible effects before retrying a write.");
      if (result.error.kind === "timeout") throw fail("operation_failed", "snippet timed out after 60s", "Inspect the API handler and any possible effects before retrying a write.");
      throw fail("operation_failed", result.error.message, "Inspect the API handler and any possible effects before retrying a write.");
    }
    const value = result.value ?? null;
    const issues = violations(value, action.outputSchema, definition.defs);
    if (issues.length) throw invokeError.invalidOutput(name, issues);
    return value;
  }
}

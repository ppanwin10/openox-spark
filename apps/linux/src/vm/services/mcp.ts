import { basename, extname } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FunctionCall } from "@openox/agent/linux";
import { OxError } from "@openox/agent/linux";
import { museParityEnabled } from "../../config";
import { HTTPError } from "../../http";
import type { VMContext } from "../context";
import { allowsURL, isTestURL, resolvesPublic } from "../net";
import type { ActionDef, Definition, Snapshot } from "./catalog";
import { invokeError, mcpError } from "./errors";
import { violations } from "./schema";
import { MCPOAuth } from "./mcp-oauth";
import type { Secrets } from "./secrets";
import { describe, fail, isObject, sha256, withTimeout, type JSONObject } from "./support";

const maximumFiles = 4, maximumBytes = 2 * 1024 * 1024, maximumTools = 500;
type Transport = "streamable-http" | "sse";
interface Active { client: Client; version: string; used: number; credentialRevision: number }
interface Tool { name: string; inputSchema: JSONObject }

export function mcpEndpoint(raw: string) {
  const trimmed = raw.trim();
  const normalized = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try { url = new URL(normalized); } catch { throw mcpError.invalidEndpoint(); }
  if (url.hash || url.username || url.password || (url.protocol !== "https:" && !isTestURL(url)) || !allowsURL(url, ["https:", "http:"])) throw mcpError.invalidEndpoint();
  return url.href;
}

export function mcpIdentifier(endpoint: string, taken: Set<string>) {
  const labels = new URL(endpoint).hostname.toLowerCase().split(".").map(label => label.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")).filter(Boolean);
  const base = labels.length ? labels.join(".") : "mcp";
  let candidate = base, suffix = 2;
  while (taken.has(candidate)) candidate = `${base}-${suffix++}`;
  return candidate;
}

function attachmentSchema(schema: unknown): unknown {
  if (!isObject(schema)) return schema;
  if (schema.type === "string" && schema.contentEncoding === "base64") {
    return { description: `Explicit binary transfer: supply {path: "artifacts/photo.png"} to read an authorized Profile file and send its bytes to this MCP server. Never print or construct base64 in model text. At most four files and 2 MiB combined per call. ${typeof schema.description === "string" ? schema.description : ""}`,
      anyOf: [schema, { type: "object", properties: { path: { type: "string", minLength: 1, maxLength: 4096 } }, required: ["path"], additionalProperties: false }] };
  }
  const fields: JSONObject = { ...schema };
  if (isObject(fields.properties)) fields.properties = Object.fromEntries(Object.entries(fields.properties).map(([key, value]) => [key, attachmentSchema(value)]));
  for (const key of ["items", "additionalProperties"]) if (isObject(fields[key])) fields[key] = attachmentSchema(fields[key]);
  for (const key of ["anyOf", "oneOf"]) if (Array.isArray(fields[key])) fields[key] = (fields[key] as unknown[]).map(attachmentSchema);
  return fields;
}

const unauthorized = (error: unknown) => (error as { code?: unknown })?.code === 401 || /\b401\b|Unauthorized/i.test(describe(error));

export class MCPRuntime {
  private context: VMContext;
  private active = new Map<string, Active>();
  private tools = new Map<string, Map<string, Tool>>();
  private status = new Map<string, "notRequired" | "authorizationRequired">();
  private proof = new Map<string, { at: number; credentialRevision: number; fingerprint: string; authorized: boolean }>();
  private imported = new Map<number, Set<string>>();
  private sweeper?: ReturnType<typeof setInterval>;
  readonly oauth?: MCPOAuth;

  constructor(context: VMContext, secrets?: Secrets) {
    this.context = context;
    if (museParityEnabled() && secrets) this.oauth = new MCPOAuth(context, secrets);
    this.start();
  }
  start() {
    this.oauth?.start();
    if (this.sweeper) return;
    this.sweeper = setInterval(() => {
      for (const [domain, entry] of this.active) if (Date.now() - entry.used > 600_000) void this.deactivate(domain);
    }, 60_000);
    this.sweeper.unref();
  }

  login(definition: Definition) {
    if (this.oauth && this.proof.get(definition.domain)?.authorized) return "authorized";
    const status = this.status.get(definition.domain);
    return status === "notRequired" ? "notRequired" : status === "authorizationRequired" ? "notAuthorized" : "unknown";
  }
  async connectionState(definition: Definition) {
    const credential = await this.oauth?.read(definition), proof = this.proof.get(definition.domain);
    const stale = !!credential && (credential.refreshPending || credential.expiresAt !== null && credential.expiresAt <= Date.now());
    const connected = !!proof && !stale && proof.fingerprint === this.fingerprint(definition) && Date.now() - proof.at < 300_000
      && proof.credentialRevision === (credential?.revision ?? 0);
    return { state: credential?.refreshPending ? "unknown" : connected ? proof.authorized ? "authorized" : "notRequired"
      : credential ? "authorizationRequired" : this.status.get(definition.domain) ?? "unknown",
      connected, verifiedAt: connected ? new Date(proof.at).toISOString() : null,
      requestedScopes: credential?.scopes ?? [], grantedScopes: credential?.tokens.scope?.split(" ").filter(Boolean) ?? null };
  }
  private fingerprint(definition: Definition) { return sha256(JSON.stringify([definition.candidate.repository.id, definition.domain, definition.endpoint, definition.transport])); }
  private verified(definition: Definition, credentialRevision: number, authorized: boolean) {
    this.proof.set(definition.domain, { at: Date.now(), credentialRevision, fingerprint: this.fingerprint(definition), authorized });
    this.status.set(definition.domain, "notRequired");
  }

  private fetch = async (input: string | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.href);
    if (!(await resolvesPublic(url, isTestURL(url) ? ["https:", "http:"] : ["https:"]))) throw mcpError.invalidEndpoint();
    const response = await fetch(url, { ...init, redirect: "manual" });
    const length = Number(response.headers.get("content-length") ?? 0);
    if (length > 4 * 1024 * 1024) { await response.body?.cancel().catch(() => {}); throw fail("resource_limit", "The MCP response exceeded the 4 MiB limit.", "Narrow the MCP response."); }
    if (!this.oauth || !response.body) return response;
    const reader = response.body.getReader();
    let bytes = 0;
    return new Response(new ReadableStream({ async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) { controller.close(); return; }
        bytes += next.value.length;
        if (bytes > 4 * 1024 * 1024) {
          await reader.cancel().catch(() => {}); controller.error(fail("resource_limit", "The MCP response exceeded the 4 MiB limit.")); return;
        }
        controller.enqueue(next.value);
      } catch { controller.error(fail("transport_error", "The MCP response could not be verified.")); }
    }, cancel: () => reader.cancel().catch(() => {}) }), { status: response.status, headers: response.headers });
  };

  private async open(definition: Definition, allowRefresh = false, signal = new AbortController().signal): Promise<{ client: Client; transport: Transport; credentialRevision: number; authorized: boolean }> {
    const endpoint = new URL(mcpEndpoint(definition.endpoint ?? ""));
    if (!(await resolvesPublic(endpoint, isTestURL(endpoint) ? ["https:", "http:"] : ["https:"]))) throw mcpError.invalidEndpoint();
    let credential: Awaited<ReturnType<MCPOAuth["token"]>>;
    try { credential = await this.oauth?.token(definition, allowRefresh, signal); }
    catch (error) {
      this.proof.delete(definition.domain);
      if (error instanceof HTTPError && error.status === 401) throw mcpError.authorizationRequired();
      throw error;
    }
    const fetchFor = async (input: string | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input.href);
      if (url.origin !== endpoint.origin) throw mcpError.invalidEndpoint();
      signal.throwIfAborted();
      return this.fetch(input, { ...init, signal: AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]),
        ...(credential ? { headers: { ...Object.fromEntries(new Headers(init?.headers)), authorization: `Bearer ${credential.tokens.access_token}` } } : {}) });
    };
    const attempt = async (kind: Transport) => {
      const client = new Client({ name: this.oauth ? "OpenOx" : "Ox", version: "1.0.0" }, { capabilities: {} });
      const transport = kind === "sse" ? new SSEClientTransport(endpoint, { fetch: this.oauth ? fetchFor : this.fetch })
        : new StreamableHTTPClientTransport(endpoint, { fetch: this.oauth ? fetchFor : this.fetch,
          ...(this.oauth ? { reconnectionOptions: { maxRetries: 0, maxReconnectionDelay: 30_000, initialReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1.5 } } : {}) });
      try {
        await withTimeout(client.connect(transport), 30_000, () => fail("transport_error", "The MCP server did not respond within 30 seconds.", "Check the endpoint and try again later."), signal);
        if (!client.getServerCapabilities()?.tools) throw fail("not_supported", "This MCP server does not declare the required tools capability.", "Use an MCP server with tools.");
        return client;
      } catch (error) {
        await client.close().catch(() => {});
        throw error;
      }
    };
    const mapped = (error: unknown) => {
      if (unauthorized(error)) { this.status.set(definition.domain, "authorizationRequired"); return mcpError.authorizationRequired(); }
      return error instanceof OxError ? error : mcpError.server(this.oauth ? "The MCP server connection could not be verified. No authorization or action was replayed."
        : `The MCP server could not be reached: ${describe(error).slice(0, 300)}`);
    };
    const result = { credentialRevision: credential?.revision ?? 0, authorized: !!credential };
    if (definition.transport) {
      try { return { client: await attempt(definition.transport), transport: definition.transport, ...result }; } catch (error) { throw mapped(error); }
    }
    try { return { client: await attempt("streamable-http"), transport: "streamable-http", ...result }; }
    catch (error) {
      if (unauthorized(error) || (error instanceof OxError && error.code === "not_supported")) throw mapped(error);
      try { return { client: await attempt("sse"), transport: "sse", ...result }; } catch { throw mapped(error); }
    }
  }

  async check(definition: Definition, options: { refresh?: boolean; signal?: AbortSignal } = {}) {
    try {
      const { client, credentialRevision, authorized } = await this.open(definition, options.refresh, options.signal);
      await client.close().catch(() => {});
      this.verified(definition, credentialRevision, authorized);
      return authorized ? "authorized" as const : "notRequired" as const;
    } catch (error) {
      this.proof.delete(definition.domain);
      if (error instanceof OxError && error.code === "authentication_required") return "authorizationRequired" as const;
      throw error;
    }
  }
  async authorize(call: FunctionCall, definition: Definition) {
    let state = await this.check(definition);
    if (state === "authorizationRequired") {
      const answer = await call.untimed(() => call.ask({ kind: "choice", body: `Open Settings → Connectors → ${definition.name} and explicitly authorize OpenOx there. Credentials stay with this Host. Choose Done only after that flow finishes.`,
        options: ["Done", "Cancel"] }));
      if (answer.kind !== "answer" || answer.text !== "Done") throw fail("cancelled", "Authorization was cancelled. It will not be reopened automatically.");
      state = await this.check(definition);
      if (state === "authorizationRequired") throw mcpError.authorizationRequired();
    }
    return { completed: true, completion: state, state };
  }

  async capabilities(snapshot: Snapshot) {
    if (this.tools.has(snapshot.version)) return snapshot.definition;
    const { client, credentialRevision, authorized } = await this.open(snapshot.definition);
    try {
      const actions: ActionDef[] = [], wire = new Map<string, Tool>();
      let cursor: string | undefined;
      for (let page = 0; page < 50; page++) {
        const result = await client.listTools(cursor ? { cursor } : {}, { timeout: 30_000 });
        for (const tool of result.tools) {
          if (!tool.name || wire.has(tool.name) || !isObject(tool.inputSchema)) throw mcpError.protocol("tools/list returned an invalid tool");
          wire.set(tool.name, { name: tool.name, inputSchema: tool.inputSchema as JSONObject });
          const raw: JSONObject = { id: tool.name, label: tool.title ?? tool.name, description: tool.description ?? null, inputSchema: attachmentSchema(tool.inputSchema),
            outputSchema: tool.outputSchema ?? {}, requireApproval: true, requireAuth: false };
          actions.push({ id: tool.name, label: String(raw.label), ...(tool.description ? { description: tool.description } : {}), blocking: false,
            inputSchema: raw.inputSchema, outputSchema: raw.outputSchema, requireApproval: true, requireAuth: false, raw });
          if (wire.size > maximumTools) throw mcpError.tooManyTools();
        }
        cursor = result.nextCursor;
        if (!cursor) break;
        if (page === 49) throw mcpError.tooManyTools();
      }
      this.verified(snapshot.definition, credentialRevision, authorized);
      this.tools.set(snapshot.version, wire);
      snapshot.definition = { ...snapshot.definition, actions, index: new Map(actions.map(action => [action.id, action])) };
      this.context.logs.info("services", `mcp tools loaded domain=${snapshot.domain} count=${actions.length}`);
      return snapshot.definition;
    } finally { await client.close().catch(() => {}); }
  }

  private async client(snapshot: Snapshot) {
    const existing = this.active.get(snapshot.domain);
    const credentialRevision = (await this.oauth?.read(snapshot.definition))?.revision ?? 0;
    if (existing && existing.version === snapshot.version && existing.credentialRevision === credentialRevision) { existing.used = Date.now(); return existing.client; }
    if (existing) await this.deactivate(snapshot.domain);
    const { client, credentialRevision: connectedRevision } = await this.open(snapshot.definition);
    this.active.set(snapshot.domain, { client, version: snapshot.version, used: Date.now(), credentialRevision: connectedRevision });
    return client;
  }

  async deactivate(domain: string) {
    const entry = this.active.get(domain);
    this.active.delete(domain);
    await entry?.client.close().catch(() => {});
  }

  forget(domain: string) {
    this.status.delete(domain);
    this.proof.delete(domain);
    return this.deactivate(domain);
  }

  private async readFile(call: FunctionCall, path: string) {
    if (call.page) throw fail("not_supported", "Pages can't send files to services", "Send the file from a conversation instead.");
    const target = path.startsWith("/") ? path.replace(/^\/+/, "") : `conversations/${call.conversationId}/${path}`;
    const { entry, file } = await call.profile.openFile(target);
    if (entry.size > maximumBytes) throw mcpError.protocol("file exceeds the 2 MiB transfer limit");
    return new Uint8Array(await file.arrayBuffer());
  }

  private async encode(call: FunctionCall, value: unknown, schema: unknown) {
    let count = 0, bytes = 0;
    const visit = async (value: unknown, schema: unknown, depth: number): Promise<unknown> => {
      if (depth >= 64) throw mcpError.protocol("attachment input is too deeply nested");
      if (!isObject(schema)) return value;
      if (schema.type === "string" && schema.contentEncoding === "base64" && isObject(value)) {
        if (Object.keys(value).length !== 1 || typeof value.path !== "string" || !value.path) throw mcpError.protocol("binary file references require only a path");
        if (++count > maximumFiles) throw mcpError.protocol("at most four file transfers per call");
        const data = await this.readFile(call, value.path);
        bytes += data.length;
        if (!data.length || bytes > maximumBytes) throw mcpError.protocol("file transfers exceed the combined 2 MiB limit or contain an empty file");
        return Buffer.from(data).toString("base64");
      }
      for (const key of ["anyOf", "oneOf"]) {
        const variants = schema[key];
        if (!Array.isArray(variants)) continue;
        const selected = variants.find(variant => !violations(value, attachmentSchema(variant)).length);
        if (selected) return visit(value, selected, depth + 1);
      }
      if (isObject(value)) {
        const properties = isObject(schema.properties) ? schema.properties : {};
        const result: JSONObject = {};
        for (const [key, child] of Object.entries(value)) {
          const childSchema = properties[key] ?? schema.additionalProperties;
          result[key] = isObject(childSchema) ? await visit(child, childSchema, depth + 1) : child;
        }
        return result;
      }
      if (Array.isArray(value) && schema.items !== undefined) {
        const result: unknown[] = [];
        for (const child of value) result.push(await visit(child, schema.items, depth + 1));
        return result;
      }
      return value;
    };
    return visit(value, schema, 0);
  }

  private async save(call: FunctionCall, files: { name: string; mimeType: string; data: Uint8Array }[]) {
    if (call.page) return;
    const seen = this.imported.get(call.conversationId) ?? new Set<string>();
    this.imported.set(call.conversationId, seen);
    for (const file of files) {
      const digest = sha256(file.data);
      if (seen.has(digest)) continue;
      const name = basename(file.name.replaceAll("\\", "/")).replace(/[\x00-\x1f\x7f]/g, "").trim() || "FileItem.bin";
      const extension = extname(name), stem = extension ? name.slice(0, -extension.length) : name;
      for (let index = 1; index < 1_000; index++) {
        const path = `conversations/${call.conversationId}/${index === 1 ? name : `${stem} (${index})${extension}`}`;
        if (await call.profile.statFile(path).then(() => true, () => false)) continue;
        await call.profile.writeFile(path, file.data);
        break;
      }
      seen.add(digest);
    }
  }

  async invoke(call: FunctionCall, snapshot: Snapshot, actionId: string, input: JSONObject) {
    const definition = snapshot.definition, name = `mcp:${definition.domain}:${actionId}`;
    const credential = await this.oauth?.read(definition);
    const action = definition.index.get(actionId);
    const tool = this.tools.get(snapshot.version)?.get(actionId);
    if (!action || !tool) throw invokeError.unknown(name);
    const wire = await this.encode(call, input, tool.inputSchema);
    const issues = violations(wire, tool.inputSchema);
    if (issues.length) throw invokeError.invalidInput(name, issues);
    let result: Awaited<ReturnType<Client["callTool"]>>;
    try {
      const client = await this.client(snapshot);
      result = await client.callTool({ name: actionId, arguments: wire as Record<string, unknown> }, undefined, { timeout: 60_000, signal: call.signal });
    } catch (error) {
      if (error instanceof OxError) throw error;
      await this.deactivate(definition.domain);
      if (unauthorized(error)) { this.status.set(definition.domain, "authorizationRequired"); throw mcpError.authorizationRequired(); }
      throw mcpError.server(this.oauth ? "The MCP action outcome is unverified. Inspect possible effects; no write was replayed."
        : `MCP server error: ${describe(error).slice(0, 500)}`);
    }
    if (credential && this.oauth?.containsCredential(result, credential)) {
      throw mcpError.protocol("Private authorization material was withheld from the response. The action may already have executed; do not replay it automatically.");
    }
    const content = Array.isArray(result.content) ? result.content as JSONObject[] : [];
    if (result.isError) throw mcpError.tool(content.flatMap(item => typeof item.text === "string" ? [item.text] : []).join("\n") || "The MCP tool reported an error.");
    const files: { name: string; mimeType: string; data: Uint8Array }[] = [];
    const mapped = content.map(item => {
      if (item.type === "image" && typeof item.data === "string" && typeof item.mimeType === "string" && item.mimeType.toLowerCase().startsWith("image/")) {
        const data = new Uint8Array(Buffer.from(item.data, "base64"));
        const file = { name: `FileItem${files.length ? ` ${files.length + 1}` : ""}.${item.mimeType.split("/")[1]?.replace(/[^a-z0-9]/gi, "") || "bin"}`, mimeType: item.mimeType, data };
        files.push(file);
        return { type: "image", filename: file.name, mimeType: file.mimeType, bytes: data.length };
      }
      if (item.type === "resource" && isObject(item.resource)) {
        const resource = item.resource;
        const data = typeof resource.text === "string" ? new TextEncoder().encode(resource.text) : typeof resource.blob === "string" ? new Uint8Array(Buffer.from(resource.blob, "base64")) : undefined;
        if (!data) throw mcpError.protocol("tool returned invalid embedded resource content");
        const uri = typeof resource.uri === "string" ? decodeURIComponent(resource.uri.split(/[?#]/)[0]!.split("/").at(-1) ?? "") : "";
        const mimeType = typeof resource.mimeType === "string" ? resource.mimeType : typeof resource.text === "string" ? "text/plain" : "application/octet-stream";
        const file = { name: uri || `FileItem${files.length ? ` ${files.length + 1}` : ""}.bin`, mimeType, data };
        files.push(file);
        return { type: "resource", filename: file.name, mimeType, bytes: data.length };
      }
      return item;
    });
    if (files.length > maximumFiles || files.reduce((sum, file) => sum + file.data.length, 0) > maximumBytes) throw mcpError.protocol("tool files exceed four attachments or 2 MiB combined");
    const value = result.structuredContent ?? (Array.isArray(result.content) ? mapped : null);
    const outputIssues = violations(value, action.outputSchema);
    if (outputIssues.length) throw invokeError.invalidOutput(name, outputIssues);
    await this.save(call, files);
    this.status.set(definition.domain, "notRequired");
    return value;
  }

  removeConversation(conversation: number) { this.imported.delete(conversation); }

  async close() {
    clearInterval(this.sweeper);
    this.sweeper = undefined;
    this.oauth?.close();
    this.proof.clear(); this.status.clear();
    for (const domain of [...this.active.keys()]) await this.deactivate(domain);
  }
}

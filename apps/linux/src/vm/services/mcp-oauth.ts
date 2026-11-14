import { discoverOAuthServerInfo, exchangeAuthorization, refreshAuthorization, registerClient, startAuthorization } from "@modelcontextprotocol/sdk/client/auth.js";
import type { AuthorizationServerMetadata, OAuthClientInformationFull, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { HTTPError } from "../../http";
import type { VMContext } from "../context";
import { allowsURL, isTestURL, resolvesPublic } from "../net";
import type { Definition } from "./catalog";
import type { Secrets } from "./secrets";
import { connectorIdentity } from "./state";
import { isObject, sha256 } from "./support";

export interface OAuthPreparation {
  issuer: string; resource: string; scopes: string[]; registration: "dynamic"; metadata: AuthorizationServerMetadata;
  redirectUri: string; credentialRevision: number; generation: number;
  client?: OAuthClientInformationFull; verifier?: string; state?: string; nonce?: string;
}
interface Credential {
  value: Record<string, string>; revision: number; client: OAuthClientInformationFull; tokens: OAuthTokens;
  metadata: AuthorizationServerMetadata; issuer: string; resource: string; expiresAt: number | null; scopes: string[]; refreshPending: boolean;
}
export const oauthLimits = { metadata: 65_536, endpoint: 2048, scopes: 32, scope: 128, step: 30_000 };
const failure = (status = 503, message = "Authorization could not be verified. No authorization request will be replayed automatically.") => new HTTPError(status, message);
const random = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
const scopeList = (value: unknown) => {
  if (!Array.isArray(value) || value.length > oauthLimits.scopes || new Set(value).size !== value.length
    || value.some(scope => typeof scope !== "string" || !/^[\x21\x23-\x5B\x5D-\x7E]{1,128}$/.test(scope))) throw failure(400, "The server declares invalid or excessive authorization scopes.");
  return value as string[];
};
function publicURL(value: unknown) {
  if (typeof value !== "string" || value.length > oauthLimits.endpoint) throw failure(400, "The server declares an invalid authorization destination.");
  let url: URL;
  try { url = new URL(value); } catch { throw failure(400, "The server declares an invalid authorization destination."); }
  if (url.username || url.password || url.hash || url.search || !allowsURL(url, isTestURL(url) ? ["https:", "http:"] : ["https:"])) {
    throw failure(400, "The server declares an unsafe authorization destination.");
  }
  return url;
}
const normalizedIssuer = (value: string) => value.endsWith("/") ? value.slice(0, -1) : value;

export class MCPOAuth {
  private context: VMContext;
  private secrets: Secrets;
  private generations = new Map<string, number>();
  private refreshing = new Map<string, Promise<Credential>>();
  private controllers = new Set<AbortController>();
  private closed = false;

  constructor(context: VMContext, secrets: Secrets) { this.context = context; this.secrets = secrets; }
  identity(definition: Definition) { return connectorIdentity("mcp", definition.candidate.repository.id, definition.domain); }
  fingerprint(definition: Definition) { return sha256(JSON.stringify([this.identity(definition), definition.endpoint, definition.transport ?? "auto"])); }
  private generation(definition: Definition) { return this.generations.get(this.identity(definition)) ?? 0; }
  private guard(definition: Definition, generation: number, epoch: number, signal: AbortSignal) {
    if (this.closed || signal.aborted || this.generation(definition) !== generation || this.context.contentBlocked?.()
      || (this.context.contentEpoch?.() ?? 0) !== epoch) throw failure(409, "This authorization belongs to a cancelled or changed workspace.");
  }
  private fetchFor(signal: AbortSignal) {
    return async (input: string | URL, init?: RequestInit) => {
      const url = publicURL(typeof input === "string" ? input : input.href);
      if (!await resolvesPublic(url, isTestURL(url) ? ["https:", "http:"] : ["https:"])) throw failure(400, "The authorization destination is not public.");
      const response = await fetch(url, { ...init, redirect: "manual", signal: AbortSignal.any([signal, AbortSignal.timeout(oauthLimits.step)]) });
      if (response.status >= 300 && response.status < 400) { await response.body?.cancel().catch(() => {}); throw failure(400, "Authorization destination redirects are not supported."); }
      if (Number(response.headers.get("content-length") ?? 0) > oauthLimits.metadata) {
        await response.body?.cancel().catch(() => {}); throw failure(400, "Authorization metadata exceeds its size limit.");
      }
      const reader = response.body?.getReader(), chunks: Uint8Array[] = [];
      let bytes = 0;
      while (reader) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.length;
        if (bytes > oauthLimits.metadata) { await reader.cancel().catch(() => {}); throw failure(400, "Authorization metadata exceeds its size limit."); }
        chunks.push(next.value);
      }
      return new Response(bytes ? Buffer.concat(chunks) : null, { status: response.status, headers: response.headers });
    };
  }
  async prepare(definition: Definition, redirectUri: string, signal: AbortSignal): Promise<OAuthPreparation> {
    const endpoint = publicURL(definition.endpoint), redirect = new URL(redirectUri);
    if (redirect.pathname !== "/oauth/mcp/callback" || redirect.search || redirect.hash || redirect.username || redirect.password
      || !(redirect.protocol === "https:" || redirect.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(redirect.hostname))) {
      throw failure(422, "This Host needs a supported HTTPS or loopback OpenOx redirect before OAuth can be used.");
    }
    let info: Awaited<ReturnType<typeof discoverOAuthServerInfo>>;
    try { info = await discoverOAuthServerInfo(endpoint, { fetchFn: this.fetchFor(signal) }); }
    catch (error) { throw error instanceof HTTPError ? error : failure(400, "The server's OAuth metadata could not be validated."); }
    if (!info.resourceMetadata || info.resourceMetadata.resource !== endpoint.href
      || !info.resourceMetadata.authorization_servers?.includes(info.authorizationServerUrl)) throw failure(400, "The OAuth resource does not exactly match this MCP server.");
    const issuer = publicURL(info.authorizationServerUrl), metadata = info.authorizationServerMetadata;
    if (!metadata || normalizedIssuer(metadata.issuer) !== normalizedIssuer(info.authorizationServerUrl)
      || !metadata.response_types_supported.includes("code") || !metadata.code_challenge_methods_supported?.includes("S256")
      || (metadata.grant_types_supported && !metadata.grant_types_supported.includes("authorization_code"))
      || (metadata.token_endpoint_auth_methods_supported && !metadata.token_endpoint_auth_methods_supported.includes("none"))) {
      throw failure(400, "The OAuth issuer or required authorization-code / S256 public-client capability is invalid.");
    }
    for (const destination of [metadata.authorization_endpoint, metadata.token_endpoint, metadata.registration_endpoint]) {
      if (destination === undefined) continue;
      if (publicURL(destination).origin !== issuer.origin) throw failure(400, "Cross-issuer OAuth endpoints are not supported by this Host.");
    }
    if (!metadata.registration_endpoint) throw failure(422, "This server needs an OpenOx-registered app and does not support OpenOx dynamic client registration.");
    const credential = await this.read(definition);
    return { issuer: info.authorizationServerUrl, resource: endpoint.href, scopes: scopeList(info.resourceMetadata.scopes_supported ?? []), registration: "dynamic",
      metadata, redirectUri: redirect.href, credentialRevision: credential?.revision ?? 0, generation: this.generation(definition) };
  }
  async authorize(definition: Definition, prepared: OAuthPreparation, signal: AbortSignal, guard: () => Promise<void>) {
    await guard();
    let client: OAuthClientInformationFull;
    try {
      client = await registerClient(prepared.issuer, { metadata: prepared.metadata, scope: prepared.scopes.join(" "), fetchFn: this.fetchFor(signal),
        clientMetadata: { client_name: "OpenOx", redirect_uris: [prepared.redirectUri], grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"], token_endpoint_auth_method: "none" } });
    } catch (error) { throw error instanceof HTTPError ? error : failure(422, "OpenOx dynamic client registration failed. No borrowed app identity was used."); }
    await guard();
    if (client.client_name !== "OpenOx" || client.client_secret || client.token_endpoint_auth_method !== "none"
      || client.redirect_uris.length !== 1 || client.redirect_uris[0] !== prepared.redirectUri) throw failure(400, "The registration response does not identify the requested OpenOx public client.");
    prepared.client = client; prepared.state = random(); prepared.nonce = random();
    const started = await startAuthorization(prepared.issuer, { metadata: prepared.metadata, clientInformation: client, redirectUrl: prepared.redirectUri,
      scope: prepared.scopes.join(" "), state: prepared.state, resource: prepared.resource });
    prepared.verifier = started.codeVerifier;
    started.authorizationUrl.searchParams.set("nonce", prepared.nonce);
    return started.authorizationUrl.href;
  }
  private value(prepared: OAuthPreparation, tokens: OAuthTokens) {
    if (tokens.token_type.toLowerCase() !== "bearer" || !tokens.access_token || (tokens as unknown as Record<string, unknown>).id_token !== undefined
      || (tokens.expires_in !== undefined && (!Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0 || tokens.expires_in > 31_536_000))) {
      throw failure(400, "The token response has unsupported authorization or identity fields.");
    }
    if (tokens.scope !== undefined && scopeList(tokens.scope.split(" ").filter(Boolean)).some(scope => !prepared.scopes.includes(scope))) {
      throw failure(400, "The token response exceeds the scopes explicitly requested for OpenOx.");
    }
    return { issuer: prepared.issuer, resource: prepared.resource, client: JSON.stringify(prepared.client), metadata: JSON.stringify(prepared.metadata),
      tokens: JSON.stringify(tokens), redirectUri: prepared.redirectUri, requestedScopes: JSON.stringify(prepared.scopes),
      expiresAt: tokens.expires_in === undefined ? "" : String(Date.now() + tokens.expires_in * 1000), refreshPending: "false" };
  }
  async exchange(definition: Definition, prepared: OAuthPreparation, code: string, signal: AbortSignal, guard: () => Promise<void>) {
    if (!prepared.client || !prepared.verifier) throw failure(400, "There is no pending OpenOx authorization for this response.");
    await guard();
    let tokens: OAuthTokens;
    try {
      tokens = await exchangeAuthorization(prepared.issuer, { metadata: prepared.metadata, clientInformation: prepared.client, authorizationCode: code,
        codeVerifier: prepared.verifier, redirectUri: prepared.redirectUri, resource: prepared.resource, fetchFn: this.fetchFor(signal) });
    } catch (error) { throw error instanceof HTTPError ? error : failure(503, "The token exchange failed or is unknown. Start a new explicit authorization; this code will not be reused."); }
    await guard();
    const value = this.value(prepared, tokens);
    await this.secrets.saveMCPCredential(this.identity(definition), this.fingerprint(definition), definition.name, prepared.resource, value, prepared.credentialRevision, guard);
    this.context.emit({ type: "secrets" });
  }
  async read(definition: Definition): Promise<Credential | undefined> {
    const stored = await this.secrets.mcpCredential(this.identity(definition), this.fingerprint(definition));
    if (!stored) return undefined;
    try {
      const { value } = stored, client = JSON.parse(value.client!), tokens = JSON.parse(value.tokens!), metadata = JSON.parse(value.metadata!), scopes = scopeList(JSON.parse(value.requestedScopes!));
      const expiresAt = value.expiresAt ? Number(value.expiresAt) : null;
      if (!isObject(client) || client.client_name !== "OpenOx" || typeof client.client_id !== "string" || client.token_endpoint_auth_method !== "none"
        || !isObject(tokens) || typeof tokens.access_token !== "string" || typeof tokens.token_type !== "string" || tokens.token_type.toLowerCase() !== "bearer"
        || (tokens.refresh_token !== undefined && typeof tokens.refresh_token !== "string") || !isObject(metadata)
        || metadata.issuer !== value.issuer || value.resource !== new URL(definition.endpoint!).href
        || (expiresAt !== null && (!Number.isSafeInteger(expiresAt) || expiresAt <= 0)) || !["true", "false"].includes(value.refreshPending!)) throw new Error();
      for (const endpoint of [metadata.authorization_endpoint, metadata.token_endpoint, metadata.registration_endpoint]) {
        if (typeof endpoint !== "string" || publicURL(endpoint).origin !== publicURL(value.issuer).origin) throw new Error();
      }
      return { ...stored, client: client as unknown as OAuthClientInformationFull, tokens: tokens as unknown as OAuthTokens,
        metadata: metadata as unknown as AuthorizationServerMetadata, issuer: value.issuer!, resource: value.resource!, expiresAt, scopes, refreshPending: value.refreshPending === "true" };
    } catch { throw failure(503, "The original MCP credential binding is invalid. Existing credentials have been retained."); }
  }
  async token(definition: Definition, allowRefresh: boolean, signal: AbortSignal) {
    let credential = await this.read(definition);
    if (!credential) return undefined;
    if (credential.refreshPending) throw failure(503, "The last token refresh is unknown. Explicitly authorize again; no rotated refresh token will be replayed.");
    if (credential.expiresAt !== null && credential.expiresAt <= Date.now()) {
      if (!allowRefresh) throw failure(401, "This MCP authorization expired. Choose Verify or authorize explicitly.");
      credential = await this.refresh(definition, credential, signal);
    }
    return credential;
  }
  private async refresh(definition: Definition, credential: Credential, signal: AbortSignal) {
    const identity = this.identity(definition), existing = this.refreshing.get(identity);
    if (existing) return existing;
    const work = this.refreshOnce(definition, credential, signal);
    this.refreshing.set(identity, work);
    try { return await work; } finally { if (this.refreshing.get(identity) === work) this.refreshing.delete(identity); }
  }
  private async refreshOnce(definition: Definition, credential: Credential, signal: AbortSignal) {
    if (!credential.tokens.refresh_token) throw failure(401, "This server did not grant a refresh token. Authorize explicitly.");
    const generation = this.generation(definition), epoch = this.context.contentEpoch?.() ?? 0, controller = new AbortController();
    this.controllers.add(controller);
    const combined = AbortSignal.any([signal, controller.signal]), guard = () => {
      this.guard(definition, generation, epoch, combined); return Promise.resolve();
    };
    try {
      const pendingRevision = await this.secrets.saveMCPCredential(this.identity(definition), this.fingerprint(definition), definition.name, credential.resource,
        { ...credential.value, refreshPending: "true" }, credential.revision, guard);
      this.context.emit({ type: "secrets" });
      let tokens: OAuthTokens;
      try { tokens = await refreshAuthorization(credential.issuer, { metadata: credential.metadata, clientInformation: credential.client,
        refreshToken: credential.tokens.refresh_token, resource: credential.resource, fetchFn: this.fetchFor(combined) }); }
      catch { throw failure(503, "The token refresh failed or is unknown. Explicitly authorize again; this refresh will not be replayed."); }
      await guard();
      const value = this.value({ issuer: credential.issuer, resource: credential.resource, client: credential.client, metadata: credential.metadata, scopes: credential.scopes,
        redirectUri: credential.value.redirectUri!, credentialRevision: pendingRevision!, generation, registration: "dynamic" }, tokens);
      await this.secrets.saveMCPCredential(this.identity(definition), this.fingerprint(definition), definition.name, credential.resource, value, pendingRevision!, guard);
      this.context.emit({ type: "secrets" });
      return (await this.read(definition))!;
    } finally { this.controllers.delete(controller); }
  }
  async revoke(definition: Definition, signal: AbortSignal): Promise<"notSupported" | "revoked" | "failed" | "unknown"> {
    const credential = await this.read(definition);
    if (!credential) return "notSupported";
    const endpoint = (credential.metadata as unknown as Record<string, unknown>).revocation_endpoint;
    if (endpoint === undefined) return "notSupported";
    try {
      if (publicURL(endpoint).origin !== publicURL(credential.issuer).origin) return "notSupported";
      const response = await this.fetchFor(signal)(String(endpoint), { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: credential.client.client_id, token: credential.tokens.refresh_token ?? credential.tokens.access_token,
          token_type_hint: credential.tokens.refresh_token ? "refresh_token" : "access_token" }) });
      return response.ok ? "revoked" : "failed";
    } catch { return "unknown"; }
  }
  async clear(definition: Definition) {
    await this.secrets.clearMCPCredential(this.identity(definition));
    this.context.emit({ type: "secrets" });
  }
  retire(definition: Definition) { this.generations.set(this.identity(definition), this.generation(definition) + 1); }
  close() { this.closed = true; for (const controller of this.controllers) controller.abort(); }
  start() { this.closed = false; }
}

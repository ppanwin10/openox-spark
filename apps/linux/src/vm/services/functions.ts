import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { FunctionCall, FunctionHandler } from "@openox/agent/linux";
import { allowsURL } from "../net";
import { actionDetail, exposedActions, findAction, qualifiedName, standardActions, type Candidate } from "./catalog";
import { iosUnavailable } from "./errors";
import { addLocalService, localServices, removeLocalService } from "./local";
import type { Services } from "./manager";
import { mcpEndpoint, mcpIdentifier } from "./mcp";
import { defaultPolicy } from "./policy";
import { describe, fail, isObject, writeJSONFile, type JSONObject, type Kind } from "./support";

const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

export function serviceFunctions(services: Services): Record<string, FunctionHandler> {
  const { approvals, attachments, preferences, catalog, context } = services;
  const tracked = (call: FunctionCall, action: string, args: JSONObject) => approvals.require(call, action, defaultPolicy(action), { args });
  const untimed = (handler: (call: FunctionCall) => Promise<unknown>): FunctionHandler => call => call.untimed(() => handler(call));
  const attachedHere = (call: FunctionCall, domain: string) => !!attachments.find(call.conversationId, domain);
  const refresh = (call: FunctionCall) => call.profile.refreshTurnState(call.conversationId).catch(error => context.logs.warning("services", `turn state refresh failed: ${describe(error)}`));

  async function invalidListing(candidate: Candidate, call: FunctionCall, error: unknown): Promise<JSONObject> {
    let manifest: JSONObject = {};
    try { const parsed = JSON.parse(await readFile(join(candidate.root, "service.json"), "utf8")); if (isObject(parsed)) manifest = parsed; } catch {}
    return { domain: candidate.runtime, name: preferences.name(candidate.runtime) ?? (typeof manifest.name === "string" ? manifest.name : candidate.runtime),
      ...(typeof manifest.description === "string" ? { description: manifest.description } : {}), kind: candidate.kind, login: "unknown",
      saved: preferences.saved(candidate.runtime), attached: attachedHere(call, candidate.runtime), repository: candidate.repository.id,
      repositoryProvenance: candidate.repository.provenance, manifestPath: `${candidate.path}/service.json`, validationError: describe(error) };
  }

  return {
    "ox.service.list": untimed(async call => {
      const kind = call.args.kind as Kind | undefined;
      await tracked(call, "ox.service.list", kind ? { kind } : {});
      const state = await catalog.load();
      const entries: JSONObject[] = [];
      for (const candidate of state.selected.values()) {
        if (kind && candidate.kind !== kind) continue;
        try {
          const definition = await catalog.definition(candidate);
          entries.push({ ...services.fields(definition, attachedHere(call, candidate.runtime)), manifestPath: `${candidate.path}/service.json` });
        } catch (error) { entries.push(await invalidListing(candidate, call, error)); }
      }
      context.logs.info("services", `list kind=${kind ?? "all"} count=${entries.length} invalid=${entries.filter(entry => entry.validationError).length}`);
      return entries.sort((a, b) => compare(String(a.domain), String(b.domain)));
    }),

    "ox.service.listAttached": untimed(async call => {
      const kind = call.args.kind as Kind | undefined;
      await tracked(call, "ox.service.listAttached", kind ? { kind } : {});
      const records = attachments.list(call.conversationId).filter(record => !kind || record.kind === kind).sort((a, b) => compare(a.domain, b.domain));
      return Promise.all(records.map(async record => services.recordFields(record, await services.definitionFor(record.domain), true)));
    }),

    "ox.service.inspect": untimed(async call => {
      const domain = String(call.args.domain).trim();
      if (!domain || domain.length > 500) throw fail("invalid_argument", "ox.service.inspect: domain must contain 1-500 characters", "Pass an attached service domain.");
      const snapshot = await services.attached(call, domain);
      const cursor = typeof call.args.cursor === "string" ? call.args.cursor : undefined;
      await tracked(call, "ox.service.inspect", { domain, ...(cursor ? { cursor } : {}) });
      if (snapshot.kind === "mcp") {
        try { await services.mcp.capabilities(snapshot); }
        catch (error) {
          throw fail("capabilities_unavailable", describe(error), "Invoke the service's standard setup action if authorization is required; otherwise inspect the source or connection error. Failure does not establish that the service has no actions.");
        }
      }
      const definition = snapshot.definition;
      const standard = standardActions(definition), ids = new Set(standard.map(action => action.id));
      const actions = exposedActions(definition).filter(action => !ids.has(action.id)).sort((a, b) => compare(a.id, b.id));
      let start = 0;
      if (cursor) {
        const previous = actions.findIndex(action => qualifiedName(definition, action.id) === cursor);
        if (previous < 0) throw fail("invalid_argument", "Invalid or stale service inspection cursor.", "Inspect the same service without cursor to restart pagination.");
        start = previous + 1;
      }
      const page = actions.slice(start, start + 10);
      const result: JSONObject = { service: services.serviceSnapshot(definition, true), standardActions: standard.map(action => action.id),
        actions: Object.fromEntries(page.map(action => [action.id, actionDetail(definition, action.id)])) };
      if (start + page.length < actions.length && page.length) result.nextCursor = qualifiedName(definition, page.at(-1)!.id);
      return result;
    }),

    "ox.service.attach": untimed(async call => {
      const domain = String(call.args.domain);
      if (!domain) throw fail("invalid_argument", "ox.service.attach: requires a non-empty domain", "Pass the service's domain.");
      await tracked(call, "ox.service.attach", { domain });
      const { candidate } = await services.selected(domain);
      if (candidate.kind === "ios") throw iosUnavailable(domain);
      const existing = attachments.find(call.conversationId, domain);
      const snapshot = await services.load(candidate);
      const title = services.title(snapshot.definition);
      if (!existing) {
        await approvals.require(call, `ox.service.attach:${domain}`, "allow", { title: `${title} - Attach`,
          body: candidate.kind === "mcp" ? "Its remote Actions can receive arguments from this conversation and return data to Ox."
            : "Its actions and your logged-in data become available to this conversation." });
      }
      await attachments.put(call.conversationId, { domain, kind: candidate.kind, repository: candidate.repository.id, version: snapshot.version });
      await preferences.setSaved(domain, true);
      await refresh(call);
      services.changed();
      context.logs.info("services", `attach domain=${domain} reloaded=${!!existing} conversation=${call.conversationId}`);
      return { ...services.fields(snapshot.definition, true), reloaded: !!existing };
    }),

    "ox.service.detach": untimed(async call => {
      const domain = String(call.args.domain);
      await tracked(call, "ox.service.detach", { domain });
      if (!domain) throw fail("invalid_argument", "ox.service.detach: requires a non-empty domain", "Pass the service's domain.");
      const record = attachments.find(call.conversationId, domain);
      const definition = await services.definitionFor(domain);
      if (!record && !definition) throw fail("not_found", `ox.service.detach: no service with domain '${domain}'.`, "List attached services with ox.service.listAttached.");
      if (!record) return services.fields(definition!, false);
      await attachments.remove(call.conversationId, domain);
      await services.conversations.closeWhere(conversation => conversation.owner === call.conversationId && conversation.domain === domain);
      if (record.kind === "mcp" && !attachments.attachedAnywhere(domain)) await services.mcp.deactivate(domain);
      await refresh(call);
      context.logs.info("services", `detach domain=${domain} conversation=${call.conversationId}`);
      return services.recordFields(record, definition, false);
    }),

    "ox.service.invoke": untimed(async call => {
      const { snapshot, actionId } = await services.target(call, String(call.args.name), "ox.service.invoke");
      const input = isObject(call.args.input) ? call.args.input : {};
      const value = await services.invoke(call, snapshot, actionId, input, call.args.session, typeof call.args.pageUrl === "string" ? call.args.pageUrl : undefined);
      return value ?? null;
    }),

    "ox.service.showPage": untimed(async call => {
      const name = String(call.args.name);
      const { snapshot, actionId } = await services.target(call, name, "ox.service.showPage");
      const input = isObject(call.args.input) ? call.args.input : {};
      const session = call.args.session ?? null, pageURL = typeof call.args.pageUrl === "string" ? call.args.pageUrl : null;
      if (snapshot.kind !== "web" || !findAction(snapshot.definition, actionId, true)) throw fail("invalid_argument", "ox.service.showPage: requires a web service action", "Use a web service action name.");
      await tracked(call, "ox.service.showPage", { name, input, session, pageUrl: pageURL });
      const title = services.title(snapshot.definition);
      await services.web.showPage(snapshot, actionId, input, session, pageURL, call.signal, async page => {
        await call.update({ page: { id: page.live.id, title: (await page.live.page.title().catch(() => "")) || title, url: page.live.page.url() } });
      });
      context.logs.info("services", `showPage domain=${snapshot.domain} action=${actionId}`);
      return { shown: true };
    }),

    "ox.service.validate": untimed(async call => {
      const domain = String(call.args.domain).trim().toLowerCase();
      await tracked(call, "ox.service.validate", { domain });
      const state = await catalog.load();
      const local = state.repositories.find(repository => repository.id === "local")!;
      if (local.state === "failed") throw fail("invalid_argument", local.error ?? "The Local repository is unavailable", "Repair repositories/local/repository.json.");
      const service = (await localServices(context.paths)).find(entry => entry.runtime === domain);
      if (!service) throw fail("not_found", `No Local service exists for ${domain}.`, "Create the service under repositories/local/<kind>/<domain>/ and register <kind>:<domain> in repositories/local/repository.json.");
      await catalog.validate({ ...service, repository: local, root: join(local.root, service.kind, service.identity), path: `repositories/local/${service.kind}/${service.identity}` });
      context.logs.info("services", `validate passed domain=${domain}`);
      return { domain, valid: true };
    }),

    "ox.service.create": untimed(async call => {
      const endpoint = mcpEndpoint(String(call.args.endpoint));
      const transport = call.args.transport as "auto" | "streamable-http" | "sse" | undefined;
      const faviconUrl = typeof call.args.faviconUrl === "string" ? call.args.faviconUrl : undefined;
      if (faviconUrl && !allowsURL(faviconUrl, ["https:"])) throw fail("invalid_argument", "MCP faviconUrl must be a public HTTPS URL.", "Use a public HTTPS PNG, JPEG, or ICO URL.");
      await tracked(call, "ox.service.create", { kind: "mcp", endpoint, transport: transport ?? "auto", ...(faviconUrl ? { faviconUrl } : {}) });
      const state = await catalog.load();
      for (const candidate of state.selected.values()) {
        if (candidate.kind !== "mcp") continue;
        const definition = await catalog.definition(candidate).catch(() => undefined);
        if (definition?.endpoint === endpoint) return services.serviceSnapshot(definition, attachedHere(call, definition.domain));
      }
      const taken = new Set([...state.candidates.keys(), ...(await localServices(context.paths)).map(service => service.runtime)]);
      const id = mcpIdentifier(endpoint, taken);
      const manifest = { id, name: new URL(endpoint).hostname, endpoint, ...(faviconUrl ? { faviconUrl } : {}), ...(transport && transport !== "auto" ? { transport } : {}) };
      await addLocalService(context.paths, `mcp:${id}`, () => writeJSONFile(join(context.paths.local, "mcp", id, "service.json"), manifest));
      await preferences.setSaved(id, true);
      services.changed();
      context.emit({ type: "repositories" });
      context.logs.info("services", `mcp saved id=${id}`);
      const { candidate } = await services.selected(id);
      return services.serviceSnapshot(await catalog.definition(candidate), false);
    }),

    "ox.service.update": untimed(async call => {
      const identifier = String(call.args.domain).trim().toLowerCase();
      const { purpose: _purpose, domain: _domain, ...fields } = call.args;
      const state = await catalog.load();
      const definitions = await Promise.all([...state.selected.values()].map(candidate => catalog.definition(candidate).catch(() => undefined)));
      const matches = definitions.filter(definition => definition?.kind === "mcp"
        && (services.title(definition).toLowerCase() === identifier || new URL(definition.endpoint!).hostname.toLowerCase() === identifier));
      const exact = definitions.find(definition => definition?.domain === identifier);
      if (!exact && matches.length > 1) throw fail("invalid_argument", `ox.service.update: multiple MCP services match '${identifier}'; use the assigned domain from the saved repositories/local/mcp/<domain>/service.json definition.`, "Use the exact domain.");
      const target = exact ?? matches[0];
      if (!target) throw fail("not_found", `ox.service.update: service '${identifier}' does not exist; use ox.service.create for a new service.`, "List services with ox.service.list.");
      let name: string | undefined;
      if ("name" in fields) {
        name = typeof fields.name === "string" ? fields.name.trim() : "";
        if (!name) throw fail("invalid_argument", "ox.service.update: name must be a nonempty string.", "Pass a nonempty name.");
        delete fields.name;
      }
      if (!Object.keys(fields).length && name) {
        await tracked(call, "ox.service.update", { domain: target.domain, name });
        await preferences.update(file => { file.names[target.domain] = name!; });
        services.changed();
        return services.serviceSnapshot(target, attachedHere(call, target.domain));
      }
      const allowed = target.kind === "mcp" ? ["endpoint", "transport", "faviconUrl"] : [];
      if (target.kind === "ios") throw fail("invalid_argument", "ox.service.update: native services support only name.", "Pass only name.");
      const unsupported = Object.keys(fields).filter(key => !allowed.includes(key)).sort();
      if (unsupported.length) {
        throw fail("invalid_argument", `ox.service.update: unsupported fields for ${target.kind}: ${unsupported.join(", ")}; supported fields: ${[...allowed, "name"].sort().join(", ")}.`, "Edit Local web and API source with ox.fs under repositories/local/.");
      }
      if (target.kind !== "mcp") throw fail("invalid_argument", "ox.service.update: provide a name, or edit Local source with ox.fs under repositories/local/.", "Edit Local source with ox.fs.");
      if (target.candidate.repository.provenance !== "local") throw fail("permission_denied", "ox.service.update: repository MCP definitions are read-only; copy the service to Local before editing it.", "Copy the definition into repositories/local/mcp/ first.");
      const endpoint = typeof fields.endpoint === "string" ? mcpEndpoint(fields.endpoint) : target.endpoint!;
      const transport = typeof fields.transport === "string" ? fields.transport : target.transport ?? "auto";
      const faviconUrl = "faviconUrl" in fields ? fields.faviconUrl as string | null : target.faviconUrl;
      if (faviconUrl && !allowsURL(faviconUrl, ["https:"])) throw fail("invalid_argument", "MCP faviconUrl must be an HTTPS URL or null.", "Use a public HTTPS image URL.");
      if (definitions.some(definition => definition?.kind === "mcp" && definition.domain !== target.domain && definition.endpoint === endpoint)) {
        throw fail("already_exists", "An MCP service already uses this endpoint.", "Update or delete the existing connection instead.");
      }
      await tracked(call, "ox.service.update", { kind: "mcp", domain: target.domain, endpoint, transport, ...(name ? { name } : {}), ...("faviconUrl" in fields ? { faviconUrl } : {}) });
      const raw = JSON.parse(await readFile(join(target.candidate.root, "service.json"), "utf8")) as JSONObject;
      const manifest: JSONObject = { ...raw, endpoint };
      if (transport === "auto") delete manifest.transport; else manifest.transport = transport;
      if (faviconUrl) manifest.faviconUrl = faviconUrl; else delete manifest.faviconUrl;
      await writeJSONFile(join(target.candidate.root, "service.json"), manifest);
      if (endpoint !== target.endpoint) await approvals.clear(target.domain, `mcp:${target.domain}`);
      await services.forget(target.domain);
      await services.mcp.forget(target.domain);
      if (name) await preferences.update(file => { file.names[target.domain] = name!; });
      services.changed();
      const { candidate } = await services.selected(target.domain);
      return services.serviceSnapshot(await catalog.definition(candidate), attachedHere(call, target.domain));
    }),

    "ox.service.delete": untimed(async call => {
      const domain = String(call.args.domain).trim().toLowerCase();
      const state = await catalog.load();
      const current = state.selected.get(domain);
      const currentDefinition = current ? await catalog.definition(current).catch(() => undefined) : undefined;
      await tracked(call, "ox.service.delete", { domain, ...(currentDefinition?.endpoint ? { endpoint: currentDefinition.endpoint } : {}) });
      if (current?.kind === "mcp") {
        if (current.repository.provenance === "local") await removeLocalService(context.paths, domain);
        await services.forget(domain);
        await services.mcp.forget(domain);
        await approvals.clear(domain, `mcp:${domain}`);
        await preferences.setSaved(domain, false);
        await attachments.remove(call.conversationId, domain);
        if (!(await catalog.load()).selected.has(domain)) await attachments.removeEverywhere(domain);
        await refresh(call);
        services.changed();
        context.emit({ type: "repositories" });
        return { domain, kind: "mcp", deleted: true };
      }
      const kind = await removeLocalService(context.paths, domain);
      const replacement = (await catalog.load()).selected.get(domain);
      await services.forget(domain);
      if (!replacement) {
        await preferences.setSaved(domain, false);
        await attachments.removeEverywhere(domain);
        await refresh(call);
      }
      services.changed();
      context.emit({ type: "repositories" });
      context.logs.info("services", `local service deleted domain=${domain} kind=${kind}`);
      return { domain, kind, deleted: true, source: "local",
        ...(replacement ? { replacementRepository: replacement.repository.id, replacementProvenance: replacement.repository.provenance } : {}) };
    }),
  };
}

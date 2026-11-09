import { bodyBytes, HTTPError, json, payload } from "../../http";
import type { VMRoute } from "../context";
import { exposedActions, qualifiedName, sessionsEnabled, type Definition } from "./catalog";
import type { Services } from "./manager";
import { builtInActions, policies, type Policy } from "./policy";
import { describe } from "./support";
import { clearWebsiteData, deleteLocalService, discardServicePackage, exportServicePackage, installServicePackage, openServicePage, readServicePackage, serviceDetail,
  servicePackageLimits, servicePreview, stageServicePackage, takeServicePackage } from "./detail";

export const namespaceOf = (definition: { kind: string; domain: string }) => definition.kind === "ios" ? definition.domain : `${definition.kind}:${definition.domain}`;

export function serviceRoute(services: Services): VMRoute {
  const conversationOf = async (value: unknown) => {
    const id = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
    if (!Number.isSafeInteger(id)) throw new HTTPError(400, "Choose a conversation");
    await services.context.profile().summary(id).catch(() => { throw new HTTPError(404, "Conversation not found"); });
    return id;
  };
  const refresh = (conversation: number) => services.context.profile().refreshTurnState(conversation)
    .catch(error => services.context.logs.warning("services", `turn state refresh failed: ${describe(error)}`));
  return async (request, url, parts) => {
    const [domain, action] = parts;
    if (!domain && request.method === "GET") {
      const conversation = url.searchParams.has("conversation") ? await conversationOf(url.searchParams.get("conversation")) : null;
      const state = await services.catalog.load();
      const rows = await Promise.all([...state.selected.values()].map(async candidate => {
        const base = { id: candidate.qualified, kind: candidate.kind, domain: candidate.runtime, repository: candidate.repository.id,
          alwaysApproved: services.approvals.explicit(candidate.runtime, namespaceOf({ kind: candidate.kind, domain: candidate.runtime }), "allow"),
          ...(conversation === null ? {} : { attached: !!services.attachments.find(conversation, candidate.runtime) }), saved: services.preferences.saved(candidate.runtime) };
        let definition: Definition;
        try { definition = await services.catalog.definition(candidate); }
        catch (error) {
          return { ...base, name: services.preferences.name(candidate.runtime) ?? candidate.runtime, description: "", faviconUrl: null, available: false,
            unavailableReason: describe(error), supportsLogin: false };
        }
        const ios = candidate.kind === "ios";
        return { ...base, name: services.title(definition), description: definition.description, faviconUrl: definition.faviconUrl, available: !ios,
          ...(ios ? { unavailableReason: "Native iOS services need the Ox app on iPhone or Mac." } : {}), supportsLogin: sessionsEnabled(definition) };
      }));
      return json({ services: rows.sort((a, b) => a.name.localeCompare(b.name) || a.domain.localeCompare(b.domain)) });
    }
    if (domain && !action && request.method === "GET") return json(await serviceDetail(services, domain));
    if (domain && !action && request.method === "DELETE") {
      const deleted = await deleteLocalService(services, domain);
      services.context.logs.info("services", `local service deleted domain=${domain} kind=${deleted.kind} by=web`);
      return json({ ...deleted, deleted: true });
    }
    if (domain && action === "saved" && request.method === "PUT") {
      const saved = (await payload<{ saved?: unknown }>(request)).saved;
      if (typeof saved !== "boolean") throw new HTTPError(400, "Expected saved: true or false");
      await services.selected(domain).catch(() => { throw new HTTPError(404, "Service not found"); });
      await services.preferences.setSaved(domain, saved);
      services.changed();
      return json({ domain, saved });
    }
    if (domain && action === "website-data" && request.method === "DELETE") {
      await clearWebsiteData(services, domain);
      services.context.logs.info("services", `website data cleared domain=${domain}`);
      return json({ cleared: true });
    }
    if (domain && action === "page" && request.method === "POST") {
      const page = await openServicePage(services, domain);
      return json({ page: await services.context.browser.state(page.live) });
    }
    if (domain && action === "package" && request.method === "GET") {
      const archive = await exportServicePackage(services, domain);
      return new Response(archive, { headers: { "content-type": "application/vnd.ox.service+zip", "cache-control": "no-store",
        "content-disposition": `attachment; filename="${domain}.service"` } });
    }
    if (domain && action === "login" && request.method === "POST") {
      const snapshot = await services.snapshot(domain);
      if (snapshot.kind !== "web") throw new HTTPError(400, "This service has no website sign-in");
      const page = await services.web.openLogin(snapshot);
      services.context.logs.info("services", `login page opened domain=${domain}`);
      return json({ page: await services.context.browser.state(page.live) });
    }
    if (domain && action === "attach" && request.method === "POST") {
      const conversation = await conversationOf((await payload<{ conversation?: unknown }>(request)).conversation);
      const { candidate } = await services.selected(domain).catch(() => { throw new HTTPError(404, "Service not found"); });
      if (candidate.kind === "ios") throw new HTTPError(400, "Native iOS services need the Ox app on iPhone or Mac.");
      const snapshot = await services.load(candidate);
      await services.attachments.put(conversation, { domain, kind: candidate.kind, repository: candidate.repository.id, version: snapshot.version });
      await services.preferences.setSaved(domain, true);
      await refresh(conversation);
      services.changed();
      services.context.logs.info("services", `attach domain=${domain} conversation=${conversation} by=user`);
      return json({ domain, attached: true });
    }
    if (domain && action === "attach" && request.method === "DELETE") {
      const conversation = await conversationOf(url.searchParams.get("conversation"));
      const record = services.attachments.find(conversation, domain);
      if (record) {
        await services.attachments.remove(conversation, domain);
        await services.conversations.closeWhere(item => item.owner === conversation && item.domain === domain);
        if (record.kind === "mcp" && !services.attachments.attachedAnywhere(domain)) await services.mcp.deactivate(domain);
        await refresh(conversation);
        services.changed();
        services.context.logs.info("services", `detach domain=${domain} conversation=${conversation} by=user`);
      }
      return json({ domain, attached: false });
    }
    if (domain && action === "approvals" && request.method === "DELETE") {
      const definition = await services.definitionFor(domain);
      await services.approvals.clear(domain, definition ? namespaceOf(definition) : `web:${domain}`);
      services.context.logs.info("services", `approvals cleared domain=${domain}`);
      services.changed();
      return json({ cleared: true });
    }
    throw new HTTPError(404, "Not found");
  };
}

export function serviceImportRoute(services: Services): VMRoute {
  return async (request, _url, parts) => {
    const [token] = parts;
    if (!token && request.method === "POST") {
      const value = readServicePackage(await bodyBytes(request, servicePackageLimits.archive, "This service package is too large."));
      const preview = await servicePreview(services, value);
      return json({ token: stageServicePackage(value), ...preview });
    }
    if (token && parts.length === 1 && request.method === "POST") {
      const replace = (await payload<{ replace?: unknown }>(request)).replace === true;
      const installed = await installServicePackage(services, takeServicePackage(token), replace);
      discardServicePackage(token);
      services.context.logs.info("services", `service imported domain=${installed.domain} kind=${installed.kind} replace=${replace}`);
      return json(installed, { status: 201 });
    }
    if (token && parts.length === 1 && request.method === "DELETE") { discardServicePackage(token); return json({ discarded: true }); }
    throw new HTTPError(404, "Not found");
  };
}

export function permissionRoute(services: Services): VMRoute {
  const approvals = services.approvals;
  return async (request, _url, parts) => {
    await approvals.load();
    const [domain] = parts;
    if (!domain && request.method === "GET") {
      const stored = approvals.stored();
      const state = await services.catalog.load();
      const rows = await Promise.all([...state.selected.values()].filter(candidate => candidate.kind !== "ios").map(async candidate => {
        const name = await services.catalog.definition(candidate).then(definition => services.title(definition), () => services.preferences.name(candidate.runtime) ?? candidate.runtime);
        return { domain: candidate.runtime, name, policy: stored.sources[candidate.runtime] ?? null };
      }));
      return json({ default: stored.defaultPolicy, builtIn: { policy: stored.sources.ox ?? null, actions: builtInActions().map(action => ({ ...action, policy: stored.actions[action.id] ?? null })) },
        services: rows.sort((a, b) => a.name.localeCompare(b.name) || a.domain.localeCompare(b.domain)) });
    }
    if (domain && parts.length === 1 && request.method === "GET") {
      const { candidate } = await services.selected(domain).catch(() => { throw new HTTPError(404, "Service not found"); });
      if (candidate.kind === "ios") throw new HTTPError(400, "Native iOS services need the Ox app on iPhone or Mac.");
      const definition = await services.catalog.definition(candidate);
      const stored = approvals.stored();
      const actions = [{ id: `ox.service.attach:${domain}`, label: "Attach to a conversation", default: "allow" as Policy },
        ...exposedActions(definition).map(action => ({ id: qualifiedName(definition, action.id), label: action.label, default: (action.requireApproval ? "ask" : "allow") as Policy }))];
      return json({ domain, name: services.title(definition), policy: stored.sources[domain] ?? null, actions: actions.map(action => ({ ...action, policy: stored.actions[action.id] ?? null })) });
    }
    if (!domain && request.method === "PUT") {
      const body = await payload<{ scope?: unknown; id?: unknown; policy?: unknown }>(request);
      if (body.policy !== null && !policies.includes(body.policy as Policy)) throw new HTTPError(400, "Choose Ask, Always allow or Block");
      const policy = body.policy === null ? undefined : body.policy as Policy;
      const id = typeof body.id === "string" ? body.id.trim() : "";
      if (body.scope === "default") await approvals.setDefault(policy);
      else if (body.scope === "source" && id) await approvals.setSource(id, policy);
      else if (body.scope === "action" && id) await approvals.set(id, policy);
      else throw new HTTPError(400, "Choose what to change");
      services.context.logs.info("services", `permission scope=${String(body.scope)} id=${id || "-"} policy=${policy ?? "inherit"}`);
      services.changed();
      return json({ saved: true });
    }
    throw new HTTPError(404, "Not found");
  };
}

import { HTTPError, json } from "../../http";
import type { VMRoute } from "../context";
import { sessionsEnabled, type Definition } from "./catalog";
import type { Services } from "./manager";
import { describe } from "./support";

export const namespaceOf = (definition: { kind: string; domain: string }) => definition.kind === "ios" ? definition.domain : `${definition.kind}:${definition.domain}`;

export function serviceRoute(services: Services): VMRoute {
  return async (request, _url, parts) => {
    const [domain, action] = parts;
    if (!domain && request.method === "GET") {
      const state = await services.catalog.load();
      const rows = await Promise.all([...state.selected.values()].map(async candidate => {
        const base = { id: candidate.qualified, kind: candidate.kind, domain: candidate.runtime, repository: candidate.repository.id,
          alwaysApproved: services.approvals.explicit(candidate.runtime, namespaceOf({ kind: candidate.kind, domain: candidate.runtime }), "allow") };
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
    if (domain && action === "login" && request.method === "POST") {
      const snapshot = await services.snapshot(domain);
      if (snapshot.kind !== "web") throw new HTTPError(400, "This service has no website sign-in");
      const page = await services.web.openLogin(snapshot);
      services.context.logs.info("services", `login page opened domain=${domain}`);
      return json({ page: await services.context.browser.state(page.live) });
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

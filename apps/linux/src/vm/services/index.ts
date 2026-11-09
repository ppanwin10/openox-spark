import type { VMFactory } from "../context";
import { appFiles } from "../app-files";
import { serviceFunctions } from "./functions";
import { Services } from "./manager";
import { Repositories, repositoryFunctions, repositoryRoute } from "./repositories";
import { permissionRoute, serviceImportRoute, serviceRoute } from "./routes";
import { searchFunction } from "./search";
import { secretFunctions, secretRoute } from "./secrets";

export const servicesModule: VMFactory = async context => {
  const services = new Services(context);
  const repositories = new Repositories(context, services);
  const app = appFiles(context, services);
  await services.start();
  await repositories.cleanup();
  return {
    handlers: {
      ...serviceFunctions(services),
      "ox.web.search": searchFunction(services),
      ...repositoryFunctions(services, repositories),
      ...secretFunctions(context, services.secrets, services.approvals),
    },
    limitations: ["Native iOS services such as Calendar, Contacts, Location, Messages, Notifications, and Reminders are unavailable on this Linux Host.",
      "On this Host, app/ has no settings.json because each browser keeps its own language, status.json reports no language or notifications, app/logs.jsonl holds at most the last 2,000 Host log entries since the Host started, with keys and tokens redacted, and app/providers.json changes only defaultModel: change provider definitions with ox.provider.save or ox.provider.delete."],
    serviceKinds: ["web", "api", "mcp"],
    appFiles: (call, request) => app.backend(call, request),
    attachedServices: conversation => services.attachedServices(conversation),
    conversationRemoved: async conversation => {
      app.forget(conversation);
      const records = services.attachments.list(conversation);
      await services.attachments.removeConversation(conversation);
      await services.conversations.closeWhere(entry => entry.owner === conversation);
      services.mcp.removeConversation(conversation);
      for (const record of records) if (record.kind === "mcp" && !services.attachments.attachedAnywhere(record.domain)) await services.mcp.deactivate(record.domain);
    },
    conversationForked: async (source, fork) => { for (const record of services.attachments.list(source)) await services.attachments.put(fork, record); },
    attachServices: async (conversation, domains) => {
      let changed = false;
      for (const domain of domains) {
        if (services.attachments.find(conversation, domain)) continue;
        const selected = await services.selected(domain).catch(() => undefined);
        if (!selected || selected.candidate.kind === "ios") continue;
        const snapshot = await services.load(selected.candidate).catch(() => undefined);
        if (!snapshot) continue;
        await services.attachments.put(conversation, { domain, kind: selected.candidate.kind, repository: selected.candidate.repository.id, version: snapshot.version });
        context.logs.info("services", `attach domain=${domain} conversation=${conversation} by=skill`);
        changed = true;
      }
      if (!changed) return;
      await context.profile().refreshTurnState(conversation).catch(error => context.logs.warning("services", error instanceof Error ? error.message : String(error)));
      services.changed();
    },
    routes: { services: serviceRoute(services), repositories: repositoryRoute(services, repositories), secrets: secretRoute(context, services.secrets), permissions: permissionRoute(services), "service-imports": serviceImportRoute(services) },
    close: () => services.close(),
  };
};

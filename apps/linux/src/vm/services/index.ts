import type { VMFactory } from "../context";
import { serviceFunctions } from "./functions";
import { Services } from "./manager";
import { Repositories, repositoryFunctions, repositoryRoute } from "./repositories";
import { permissionRoute, serviceRoute } from "./routes";
import { searchFunction } from "./search";
import { secretFunctions, secretRoute } from "./secrets";

export const servicesModule: VMFactory = async context => {
  const services = new Services(context);
  const repositories = new Repositories(context, services);
  await services.start();
  await repositories.cleanup();
  return {
    handlers: {
      ...serviceFunctions(services),
      "ox.web.search": searchFunction(services),
      ...repositoryFunctions(services, repositories),
      ...secretFunctions(context, services.secrets, services.approvals),
    },
    limitations: ["Native iOS services such as Calendar, Contacts, Location, Messages, Notifications, and Reminders are unavailable on this Linux Host."],
    serviceKinds: ["web", "api", "mcp"],
    attachedServices: conversation => services.attachedServices(conversation),
    conversationRemoved: async conversation => {
      const records = services.attachments.list(conversation);
      await services.attachments.removeConversation(conversation);
      await services.conversations.closeWhere(entry => entry.owner === conversation);
      services.mcp.removeConversation(conversation);
      for (const record of records) if (record.kind === "mcp" && !services.attachments.attachedAnywhere(record.domain)) await services.mcp.deactivate(record.domain);
    },
    conversationForked: async (source, fork) => { for (const record of services.attachments.list(source)) await services.attachments.put(fork, record); },
    routes: { services: serviceRoute(services), repositories: repositoryRoute(services, repositories), secrets: secretRoute(context, services.secrets), permissions: permissionRoute(services) },
    close: () => services.close(),
  };
};

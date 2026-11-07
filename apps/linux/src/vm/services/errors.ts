import { OxError } from "@openox/agent/linux";
import { describe, fail } from "./support";

const generic = "Inspect the relevant resource and help before deciding how to proceed. Effects may have occurred; verify state before retrying a write. Do not repeat a cancelled or denied user interaction.";

export const invokeError = {
  denied: (name: string) => fail("permission_denied", `action "${name}" denied by user`, "Stop. Do not repeat an action the user denied."),
  unknown: (name: string) => fail("unknown_action", `unknown action "${name}"`, "Use ox.service.inspect to discover the service's exposed actions and copy an exact qualified action name."),
  requiresAuth: (name: string) => fail("authentication_required", `action "${name}" requires login — the user is not logged in to this service. Ask them to log in, then retry.`,
    "Use the service type's standard actions: web listSessions/login, API credentialStatus/configureCredentials, or MCP connectionStatus/authorize. Invoke them through ox.service.invoke; do not automatically replay writes."),
  invalidContract: (name: string) => fail("invalid_contract", `action "${name}" has an invalid manifest contract`, "Use ox.service.validate to inspect the contract. Do not invoke the action until it is repaired."),
  invalidInput: (name: string, issues: string[]) => fail("invalid_argument", `action "${name}" input is invalid: ${issues.join("; ")}`, "Inspect the action's input schema with ox.service.inspect and correct the reported fields."),
  invalidOutput: (name: string, issues: string[]) => fail("invalid_output", `action "${name}" returned invalid output: ${issues.join("; ")}`, "Inspect the service and any possible effects. Do not repeat a write merely because its output was invalid."),
};

export const evalError = {
  timeout: (seconds: number) => fail("operation_failed", `JS eval timed out after ${seconds}s`, generic),
  js: (message: string) => fail("operation_failed", message, generic),
  contextInvalidated: () => fail("operation_failed", "service page navigated while the action was running", generic),
  navigationTimeout: (seconds: number) => fail("operation_failed", `service navigation timed out after ${seconds}s`, generic),
  navigationFailed: (message: string) => fail("operation_failed", `service navigation failed: ${message}`, generic),
  notActive: () => fail("operation_failed", "service page failed to load", generic),
  notReady: (detail?: string) => fail("operation_failed", `service action dispatcher is unavailable${detail ? `: ${detail}` : ""}`, generic),
  offDomain: () => fail("operation_failed", "service page is off-domain; refusing to invoke", generic),
};

export const apiError = {
  authorizationRequired: () => fail("authentication_required", "Set up authentication for this service before invoking it.", "Use the access contract from ox.service.inspect and request access only if needed. Verify any possible effects before retrying a write."),
  invalidRequest: () => fail("invalid_argument", "The API request is invalid.", "Inspect the action input and API handler, then correct the request. Verify any earlier effects before retrying a write."),
  destinationDenied: () => fail("permission_denied", "The API request destination is outside this service's base URL.", "Do not bypass destination restrictions, authentication, or Action approval checks. Inspect the service contract and any earlier effects before proceeding."),
  mutationDenied: () => fail("permission_denied", "This capability must require approval before sending a mutation.", "Do not bypass destination restrictions, authentication, or Action approval checks. Inspect the service contract and any earlier effects before proceeding."),
  responseTooLarge: () => fail("resource_limit", "The API response exceeded the size limit.", "Narrow the requested response. Verify any possible effects before retrying a write."),
  http: (status: number) => status === 403 ? fail("permission_denied", `The API returned HTTP ${status}.`, "Do not bypass destination restrictions, authentication, or Action approval checks. Inspect the service contract and any earlier effects before proceeding.")
    : fail("http_error", `The API returned HTTP ${status}.`, "Inspect the HTTP failure and resulting service state. Do not automatically replay a write."),
  invalidResponse: () => fail("invalid_output", "The API returned an invalid response.", "Inspect the API response and any possible effects. Do not repeat a write merely because its response was invalid."),
  transport: () => fail("transport_error", "The service connection failed; the action may have taken effect.", "Inspect the connection and resulting service state before deciding whether to retry. Do not automatically replay a write after a transport failure."),
};

export const mcpError = {
  invalidEndpoint: () => fail("invalid_argument", "Enter a public HTTPS MCP endpoint.", "Inspect the MCP connection and use a supported endpoint without embedded credentials."),
  authorizationRequired: () => fail("authentication_required", "This MCP server requires authentication.", "Use the access contract from ox.service.inspect and request access only if needed. Verify any possible effects before retrying a write."),
  protocol: (message: string) => fail("invalid_contract", `MCP protocol error: ${message}`, "Inspect the MCP server's protocol behavior. Verify any possible effects before retrying a write."),
  tool: (message: string) => fail("tool_error", message, "Inspect the tool failure and resulting service state. A tool error does not establish that no effects occurred; do not automatically replay a write."),
  tooManyTools: () => fail("resource_limit", "The MCP server exposed more than 500 tools.", "Inspect the MCP server limits and narrow its response or exposed tools. Verify any possible effects before retrying a write."),
  server: (message: string) => fail("server_error", message, "Inspect the MCP server failure and resulting service state. Do not automatically replay a write."),
};

export const notAttached = (label: string, service: string) => fail("service_not_attached", `${label}: service '${service}' isn't attached to this conversation.`,
  "Find the service with ox.service.list and attach its exact domain with ox.service.attach before using its actions.");
export const iosUnavailable = (service: string) => fail("not_supported", `${service} is a native iOS service, which is not available on this Linux Host.`,
  "Tell the user this needs the Ox app on iPhone or Mac, or use a web, API, or MCP service on this Host instead.");
export const handoffIncomplete = (message: string, recovery: string) => fail("handoff_incomplete", message, recovery);
export const pageUnavailable = (message: string, recovery: string) => fail("page_unavailable", message, recovery);

export function asOxError(error: unknown) {
  if (error instanceof OxError) return error;
  return fail("operation_failed", describe(error), generic);
}

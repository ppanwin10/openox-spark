import type { Api, AssistantMessage, Message, Model } from "@earendil-works/pi-ai";
import { OxError, type FunctionCall } from "@openox/agent/linux";
import { isLocalProvider, localMachines, withoutMachine, type Providers } from "../providers";
import type { VMContext, VMFactory } from "./context";
import { Approvals, defaultPolicy } from "./approvals";
import { catalogDefinition, hostSupport, providerSchema, resolvesPublicEndpoint, validateDefinition, type ProviderDefinition } from "./models-definitions";
import { FunctionApprovals } from "./skills-approval";

type GenerateInput = { id: string; model: string; messages: { role: "user" | "assistant"; content: string }[]; maxOutputTokens: number; systemPrompt?: string };

const encoder = new TextEncoder();
const zeroUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const notFound = (id: string) => new OxError("not_found", `Provider not found: ${id}`, "Use a provider ID from ox.provider.list.");
const failure = (message: string) => new OxError("provider_error", message, "Check the provider, model, and inputs, then retry once.");
const describe = (error: unknown) => error instanceof Error ? error.message : String(error);

export function providerDefinition(providers: Providers, id: string): ProviderDefinition {
  const saved = providers.definition(id);
  if (saved) return saved;
  const provider = providers.listed(id);
  if (!provider) throw notFound(id);
  return catalogDefinition(provider, providers.models.getModels(id), isLocalProvider(id));
}
export const addedProvider = (providers: Providers, id: string) => isLocalProvider(id) || !!providers.definition(id);

export const modelsModule: VMFactory = (context: VMContext) => {
  const providers = context.providers;
  const approvals = FunctionApprovals.for(context.paths.state);
  const policies = Approvals.for(context.paths.state);

  const definitionFor = (id: string) => providerDefinition(providers, id);
  const added = (id: string) => addedProvider(providers, id);
  const status = (id: string) => {
    if (!providers.listed(id)) return "unavailable";
    const kind = providers.authKind(id);
    return kind === "none" ? "not-required" : providers.hasKey(id) ? "credential-stored" : kind === "optional" ? "optional" : "required";
  };
  const summary = (definition: ProviderDefinition) => {
    const kind = providers.authKind(definition.id), models = providers.models.getModels(definition.id);
    return {
      id: definition.id, name: definition.name, source: added(definition.id) ? "added" : "bundled", api: definition.api, url: definition.url, website: null,
      regions: [/-cn$/.test(definition.id) ? "china" : "global"], inferenceLocation: added(definition.id) ? "user-hosted" : "remote",
      models: definition.models.length, availableModels: models.length, authentication: status(definition.id),
      access: { methods: [kind === "none" ? "none" : "api-key"], credentialKind: kind === "none" ? null : "api-key", optional: kind === "optional", notice: null },
      capabilities: { supportsTools: true, canLoadModels: false, reasoningPolicy: models.some(model => model.reasoning) ? "providerDefault" : "none" },
      gettingStarted: null,
    };
  };
  const checked = (value: unknown) => {
    const definition = validateDefinition(value);
    if (providers.reserved(definition.id)) {
      throw new OxError("invalid_argument", `${definition.id} is a built-in provider on this Host and cannot be replaced.`, "Save the definition under a new id, such as my-openai.");
    }
    hostSupport(definition);
    return definition;
  };
  const listedOrUnsupported = (id: string) => {
    const provider = providers.listed(id);
    if (provider) return provider;
    const builtin = providers.builtin(id);
    if (!builtin) throw notFound(id);
    throw new OxError("not_supported", `${builtin.name} is not available on this Linux Host${builtin.auth.oauth ? "; it signs in with an account (OAuth), which this Host does not support" : ""}.`,
      "Tell the user to choose a provider that accepts an API key, or to add one in Settings.");
  };

  async function generate(call: FunctionCall) {
    const input = call.args as GenerateInput;
    if (!providers.listed(input.id)) throw notFound(input.id);
    const model = providers.models.getModel(input.id, input.model);
    if (!model) throw new OxError("invalid_argument", "Choose an exact available model ID for this provider", "Read ox.provider.models for this provider.");
    if (!providers.configured(input.id)) throw new OxError("authentication_required", "Authenticate this provider through ox.provider.authenticate before selecting its model", "Ask the user before starting provider authentication.");
    if (!Number.isInteger(input.maxOutputTokens) || input.maxOutputTokens < 1 || input.maxOutputTokens > 8192 || input.maxOutputTokens > model.maxTokens || !model.input.includes("text")) {
      throw new OxError("invalid_argument", "Choose an available text model and an output limit within 1...8192 and the model's limit", `Use maxOutputTokens of at most ${Math.min(8192, model.maxTokens)}.`);
    }
    if (input.systemPrompt !== undefined && !input.systemPrompt) throw new OxError("invalid_argument", "systemPrompt must be nonempty text", "Omit systemPrompt or pass text.");
    const bytes = input.messages.reduce((sum, message) => sum + encoder.encode(message.content).length, encoder.encode(input.systemPrompt ?? "").length);
    if (bytes > 131_072) throw new OxError("invalid_argument", "Supplied generation text exceeds 128 KiB", "Shorten the messages or system prompt.");
    await approvals.require(call, { action: "ox.provider.generate", title: "Run a model", disclosure: `This sends the supplied text to ${providers.listed(input.id)!.name} and can incur provider charges.` });
    const messages: Message[] = input.messages.map(message => message.role === "user" ? { role: "user", content: message.content, timestamp: Date.now() }
      : { role: "assistant", content: [{ type: "text", text: message.content }], api: model.api, provider: model.provider, model: model.id, usage: zeroUsage, stopReason: "stop", timestamp: Date.now() });
    return call.untimed(async () => {
      const controller = new AbortController();
      let timedOut = false;
      const stop = () => controller.abort();
      const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 120_000);
      call.signal.addEventListener("abort", stop, { once: true });
      let result: AssistantMessage | undefined, reason: "stop" | "length" | undefined;
      try {
        const stream = providers.models.stream(model as Model<Api>, { ...(input.systemPrompt ? { systemPrompt: input.systemPrompt } : {}), messages }, { maxTokens: input.maxOutputTokens, signal: controller.signal });
        for await (const event of stream) {
          if (event.type === "toolcall_start" || event.type === "toolcall_delta" || event.type === "toolcall_end") throw failure("Provider generation does not support tool calls");
          if (event.type === "error") {
            if (timedOut) throw failure("Provider generation timed out after 120 seconds");
            if (event.reason === "aborted") throw new OxError("cancelled", "Provider generation was cancelled", "Retry only if the user still wants the result.");
            throw failure(event.error.errorMessage || "Provider generation failed");
          }
          if (event.type === "done") {
            if ((event.reason !== "stop" && event.reason !== "length") || event.message.content.some(part => part.type === "toolCall")) throw failure("Provider generation returned an unsupported completion");
            result = event.message;
            reason = event.reason;
          }
        }
      } catch (error) {
        if (error instanceof OxError) throw error;
        throw timedOut ? failure("Provider generation timed out after 120 seconds") : failure(describe(error));
      } finally {
        clearTimeout(timer);
        call.signal.removeEventListener("abort", stop);
      }
      if (!result || !reason) throw failure("Provider stream ended without a completion");
      const usage = result.usage;
      context.logs.info("providers", `generate provider=${input.id} model=${model.id} input=${usage.input} output=${usage.output}`);
      return { id: input.id, model: model.id, text: result.content.flatMap(part => part.type === "text" ? [part.text] : []).join(""), stopReason: reason,
        usage: { input: usage.input, output: usage.output, cachedInput: usage.cacheRead, totalTokens: usage.totalTokens, cacheWriteInput: usage.cacheWrite ?? null } };
    });
  }

  return {
    handlers: {
      "ox.provider.schema": async () => providerSchema,
      "ox.provider.list": async call => {
        await policies.require(call, "ox.provider.list", defaultPolicy("ox.provider.list"));
        return providers.catalog().map(info => summary(definitionFor(info.id)));
      },
      "ox.provider.default": async () => providers.catalog().filter(info => !added(info.id)).map(info => catalogDefinition(providers.builtin(info.id)!, providers.builtin(info.id)!.getModels())),
      "ox.provider.get": async call => definitionFor(String(call.args.id)),
      "ox.provider.models": async call => {
        const definition = definitionFor(String(call.args.id));
        return definition.models.map(model => ({ id: model.id, name: model.name, available: !!providers.models.getModel(definition.id, model.id),
          contextTokens: model.contextTokens ?? 32_768, outputTokens: model.outputTokens ?? 4_096, input: [...model.input ?? ["text"]].sort(), output: [...model.output ?? ["text"]].sort(),
          reasoningEfforts: model.reasoningEfforts ?? [] }));
      },
      "ox.provider.validate": async call => ({ id: checked(call.args.provider).id, valid: true }),
      "ox.provider.save": async call => {
        const definition = checked(call.args.provider);
        await resolvesPublicEndpoint(definition);
        await providers.saveDefinition(definition);
        context.logs.info("providers", `provider saved id=${definition.id} models=${definition.models.length}`);
        await context.updateSettings({});
        return { id: definition.id, saved: true };
      },
      "ox.provider.delete": async call => {
        const id = String(call.args.id);
        if (!providers.listed(id) && !providers.builtin(id)) throw notFound(id);
        if (!added(id)) throw new OxError("invalid_state", `Provider has no saved override: ${id}`, "Built-in providers cannot be deleted; use ox.provider.deauthenticate to remove its key.");
        await approvals.require(call, { action: "ox.provider.delete", title: "Delete a model provider", disclosure: "This removes the provider and its saved key from this Host." });
        const settings = context.settings();
        if (isLocalProvider(id)) {
          await providers.setKey(id, null).catch(() => {});
          const change = withoutMachine(settings, id);
          providers.setMachines(localMachines({ ...settings, ...change }));
          await context.updateSettings(change);
        } else {
          await providers.deleteDefinition(id);
          await context.updateSettings(settings.defaultModel?.provider === id ? { defaultModel: undefined } : {});
        }
        context.logs.info("providers", `provider deleted id=${id}`);
        return { id, deleted: true };
      },
      "ox.provider.authenticate": async call => {
        const id = String(call.args.id);
        const provider = listedOrUnsupported(id);
        if (providers.authKind(id) === "none") return { id, status: "not-required" };
        const answer = await call.ask({ kind: "form", title: `Log in to ${provider.name}`, submit: "Save",
          body: `Enter the API key for ${provider.name}. Ox stores it on this Host and never shows it to the model.`, fields: [{ name: "key", label: "API key", secret: true }] });
        if (answer.kind !== "values") throw new OxError("cancelled", "Provider authentication was cancelled.", "Stop. Do not reopen authentication unless the user asks.");
        try { await providers.setKey(id, answer.values.key ?? ""); }
        catch { throw new OxError("invalid_argument", "The API key could not be saved; it must be one line without spaces.", "Ask the user whether to try again."); }
        context.logs.info("providers", `provider key saved provider=${id}`);
        await context.updateSettings({});
        return { id, status: "credential-stored" };
      },
      "ox.provider.deauthenticate": async call => {
        const id = String(call.args.id);
        if (!providers.listed(id)) {
          if (!providers.builtin(id)) throw notFound(id);
          return { id, status: "unavailable" };
        }
        await providers.setKey(id, null);
        context.logs.info("providers", `provider key removed provider=${id}`);
        await context.updateSettings({});
        return { id, status: status(id) };
      },
      "ox.provider.generate": generate,
    },
  };
};

import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { OxError, type FunctionCall, type LinuxProfile, type ModelChoice } from "@openox/agent/linux";
import type { VMContext, VMFactory } from "./context";
import { thinkingLevels } from "./models-definitions";
import { FunctionApprovals } from "./skills-approval";

type Selection = { provider: string; model: string; thinkingLevel: string | null };
interface ModelChange { status: "pending" | "applied" | "failed" | "cancelled"; selection: Selection; error: string | null; previous: ModelChoice | null }

const unavailable = "ox.conversation.delete: choose another existing conversation in the active Profile.";
const titleFrom = (text: string) => {
  const line = text.split("\n").map(value => value.trim()).find(Boolean) ?? "";
  return line.length > 60 ? `${line.slice(0, 59)}…` : line;
};
const describe = (error: unknown) => error instanceof Error ? error.message : String(error);
const sameChoice = (a: ModelChoice | null | undefined, b: ModelChoice | null | undefined) => (a?.provider ?? null) === (b?.provider ?? null)
  && (a?.modelId ?? null) === (b?.modelId ?? null) && ((a?.thinkingLevel ?? "off") === (b?.thinkingLevel ?? "off"));
const sameSelection = (a: Selection | undefined, b: Selection) => !!a && a.provider === b.provider && a.model === b.model && a.thinkingLevel === b.thinkingLevel;

function profilePrefix(profileID: string) {
  const compact = profileID.replaceAll("-", "").toUpperCase();
  return /^[0-9A-F]{16}/.test(compact) ? compact.slice(0, 16) : new Bun.CryptoHasher("sha256").update(profileID).digest("hex").slice(0, 16).toUpperCase();
}
export function conversationUUID(profileID: string, id: number) {
  const compact = profilePrefix(profileID) + id.toString(16).toUpperCase().padStart(16, "0");
  return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`;
}
export function conversationNumber(profileID: string, value: string) {
  const compact = value.replaceAll("-", "").toUpperCase();
  if (!/^[0-9A-F]{32}$/.test(compact) || compact.slice(0, 16) !== profilePrefix(profileID)) return undefined;
  const id = Number.parseInt(compact.slice(16), 16);
  return Number.isSafeInteger(id) ? id : undefined;
}

async function runOutcome(profile: LinuxProfile, id: number) {
  const view = await profile.view(id);
  const last = [...view.messages].reverse().find(message => message.role === "assistant");
  if (view.error || last?.stopReason === "error") return "failed";
  return last?.stopReason === "stop" || last?.stopReason === "length" ? "completed" : "cancelled";
}

export const conversationsModule: VMFactory = (context: VMContext) => {
  const approvals = FunctionApprovals.for(context.paths.state);
  const changes = new Map<number, ModelChange>();
  const watching = new Set<number>();
  const titlesPath = join(context.paths.state, "conversation-titles.json");
  let titles: Record<string, string> | undefined;
  const profileID = () => context.settings().profile.id;
  const loadTitles = async (): Promise<Record<string, string>> => titles ??= await readFile(titlesPath, "utf8").then(text => JSON.parse(text) as Record<string, string>, () => ({}));
  const saveTitles = async () => {
    const temporary = `${titlesPath}.${crypto.randomUUID()}`;
    await writeFile(temporary, `${JSON.stringify(titles ?? {}, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, titlesPath);
  };

  const levelsFor = (provider: string, model: string) => {
    const entry = context.providers.models.getModel(provider, model);
    return entry ? thinkingLevels(entry) : [];
  };
  const authentication = (provider: string) => {
    const settingsPath = "Settings > Model providers";
    if (context.providers.hasKey(provider)) return { method: "apiKey", status: "ready", settingsPath };
    if (context.providers.authKind(provider) !== "required") return { method: "none", status: "notRequired", settingsPath };
    return { method: "apiKey", status: "missingCredential", settingsPath };
  };
  const choiceOf = (selection: Selection): ModelChoice => ({ provider: selection.provider, modelId: selection.model,
    ...(selection.thinkingLevel ? { thinkingLevel: selection.thinkingLevel as ModelChoice["thinkingLevel"] } : {}) });

  const watch = async (id: number) => {
    if (watching.has(id)) return;
    watching.add(id);
    try {
      for (;;) {
        await Bun.sleep(250);
        const change = changes.get(id);
        if (!change || change.status !== "pending") return;
        const profile = context.profile();
        if (profile.busy(id)) continue;
        const outcome = await runOutcome(profile, id).catch(() => "cancelled" as const);
        if (changes.get(id) !== change) continue;
        if (outcome !== "completed") {
          Object.assign(change, { status: "cancelled", error: outcome === "failed" ? "The submission failed before the model change applied." : "The run stopped before the model change applied." });
          return;
        }
        const summary = await profile.summary(id).catch(() => undefined);
        if (!summary || !sameChoice(summary.model, change.previous)) {
          Object.assign(change, { status: "cancelled", error: summary ? "A different model was selected for this conversation." : "The conversation is no longer available." });
          return;
        }
        try {
          await profile.setModel(id, choiceOf(change.selection));
          change.status = "applied";
          context.logs.info("conversation", `model applied conversation=${id} provider=${change.selection.provider} model=${change.selection.model}`);
        } catch (error) { Object.assign(change, { status: "failed", error: describe(error) }); }
        return;
      }
    } finally { watching.delete(id); }
  };

  const target = (call: FunctionCall) => {
    const id = conversationNumber(profileID(), String(call.args.id));
    if (id === undefined || id === call.conversationId) throw new OxError("not_found", unavailable, "Use the ID of another conversation in this Profile.");
    return id;
  };

  return {
    limitations: ["Conversation IDs used by ox.conversation and ox.schedule are UUIDs whose last 16 hex digits are the conversation number; the conversation's files are in conversations/<that number in decimal>/."],
    handlers: {
      "ox.conversation.start": async call => {
        const { prompt, title } = call.args as { prompt: string; title?: string };
        if (!prompt.trim()) throw new OxError("invalid_argument", "ox.conversation.start: prompt must not be empty.", "Include the complete task in prompt.");
        const choice = context.defaultModel();
        if (!choice) throw new OxError("unavailable", "ox.conversation.start: no default model is configured.", "Ask the user to add a model provider in Settings.");
        const profile = call.profile;
        const id = await profile.create(choice);
        if (title?.trim()) await profile.rename(id, title.trim());
        context.logs.info("conversation", `start caller=${call.conversationId} target=${id}`);
        profile.send(id, prompt).then(result => {
          if (result.outcome === "failed") context.logs.warning("conversation", `run failed conversation=${id}: ${result.error}`);
        }, error => context.logs.error("conversation", `run error conversation=${id}: ${describe(error)}`));
        return { id: conversationUUID(profileID(), id) };
      },
      "ox.conversation.delete": async call => {
        const id = target(call);
        const summary = await call.profile.summary(id).catch(() => { throw new OxError("not_found", unavailable, "Use the ID of another conversation in this Profile."); });
        const uuid = conversationUUID(profileID(), id);
        await approvals.require(call, { action: "ox.conversation.delete", title: "Delete Conversation",
          disclosure: "This removes the conversation from your history. This can't be undone.", args: { purpose: call.args.purpose, id: uuid, title: summary.title } });
        await call.profile.summary(id).catch(() => { throw new OxError("not_found", "ox.conversation.delete: the conversation is no longer available.", "List conversations again before retrying."); });
        await call.profile.remove(id);
        context.logs.info("conversation", `delete caller=${call.conversationId} target=${id}`);
        return { id: uuid, deleted: true };
      },
      "ox.conversation.rename": async call => {
        const title = String(call.args.title).trim();
        if (!title) throw new OxError("invalid_argument", "ox.conversation.rename: title must not be empty.", "Use a concise title of at most 50 characters.");
        if ([...title].length > 50) throw new OxError("invalid_argument", "ox.conversation.rename: title must contain at most 50 characters.", "Use a concise title of at most 50 characters.");
        const id = call.conversationId, profile = call.profile;
        const stored = await loadTitles();
        const current = (await profile.summary(id)).title;
        const first = (await profile.view(id)).messages.find(message => message.role === "user");
        const text = !first ? "" : typeof first.content === "string" ? first.content : first.content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n");
        if (![titleFrom(text), "New conversation", "", stored[String(id)]].includes(current)) return { renamed: false, title: current };
        const renamed = current !== title;
        if (renamed) await profile.rename(id, title);
        stored[String(id)] = title;
        await saveTitles();
        return { renamed, title };
      },
      "ox.conversation.model": async call => {
        const summary = await call.profile.summary(call.conversationId);
        const choice = summary.model ?? context.defaultModel();
        if (!choice) throw new OxError("unavailable", "This conversation has no model selected.", "Ask the user to choose a model in Settings.");
        const provider = context.providers.models.getProvider(choice.provider), model = context.providers.models.getModel(choice.provider, choice.modelId);
        const change = changes.get(call.conversationId);
        return {
          provider: { id: choice.provider, name: provider?.name ?? choice.provider },
          model: { id: choice.modelId, name: model?.name ?? choice.modelId },
          supportsTools: true,
          thinkingLevel: choice.thinkingLevel && choice.thinkingLevel !== "off" ? choice.thinkingLevel : null,
          change: change ? { status: change.status, selection: change.selection, error: change.error } : null,
          authentication: authentication(choice.provider),
        };
      },
      "ox.conversation.setModel": async call => {
        const input = (call.args as { selection: { provider: string; model: string; thinkingLevel?: string | null } }).selection;
        const id = call.conversationId, profile = call.profile;
        if (!context.providers.listed(input.provider) || !context.providers.models.getModel(input.provider, input.model)) {
          throw new OxError("invalid_argument", "Choose an existing provider from ox.provider.list and an exact available model ID from ox.provider.get", "List providers and models before retrying.");
        }
        if (!context.providers.configured(input.provider)) {
          throw new OxError("authentication_required", "Authenticate this provider through ox.provider.authenticate before selecting its model", "Ask the user before starting provider authentication.");
        }
        const summary = await profile.summary(id);
        const pending = changes.get(id)?.status === "pending" ? changes.get(id)!.selection : undefined;
        const current: Selection | undefined = summary.model ? { provider: summary.model.provider, model: summary.model.modelId,
          thinkingLevel: summary.model.thinkingLevel && summary.model.thinkingLevel !== "off" ? summary.model.thinkingLevel : null } : undefined;
        const previous = pending && pending.provider === input.provider && pending.model === input.model ? pending : current;
        const levels = levelsFor(input.provider, input.model);
        const requested = "thinkingLevel" in input ? input.thinkingLevel ?? null
          : previous && previous.provider === input.provider && previous.model === input.model ? previous.thinkingLevel : null;
        if (requested !== null && !levels.includes(requested)) throw new OxError("invalid_argument", "This model does not support the requested thinking level", `Use one of: ${levels.join(", ") || "null"}.`);
        const selection: Selection = { provider: input.provider, model: input.model, thinkingLevel: requested ?? (levels.includes("medium") ? "medium" : levels[0] ?? null) };
        const changed = !sameSelection(pending ?? current, selection);
        if (!profile.busy(id)) {
          await profile.setModel(id, choiceOf(selection));
          changes.set(id, { status: "applied", selection, error: null, previous: summary.model });
          return { status: "applied", selection, changed };
        }
        changes.set(id, { status: "pending", selection, error: null, previous: summary.model });
        void watch(id);
        return { status: "pending", selection, changed };
      },
    },
    conversationRemoved: async id => {
      const change = changes.get(id);
      if (change?.status === "pending") Object.assign(change, { status: "cancelled", error: "The conversation was deleted." });
      changes.delete(id);
      const stored = await loadTitles();
      if (String(id) in stored) { delete stored[String(id)]; await saveTitles(); }
    },
  };
};

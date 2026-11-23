import { chatQuoteSchema, discoveryInput, discoveryPublication, discoveryPromptSchema, discoverySourceURL, generationDraftSchema, OxError,
  type DiscoveryKind, type FunctionCall, type Generation, type GenerationView, type QuietScope } from "@openox/agent/linux";
import { museParityEnabled, quietDiscoveryAvailable, quietDiscoveryEnabled } from "../config";
import { HTTPError, json, payload } from "../http";
import type { VMFactory, VMRoute } from "./context";
import { metadataPage } from "./metadata-page";
import { FunctionApprovals } from "./skills-approval";
import { Approvals } from "./approvals";
import { isObject } from "./services/support";

const statuses: Record<string, number> = { not_found: 404, conflict: 409, unavailable: 503, limit_exceeded: 409 };
const describe = (error: unknown) => error instanceof Error ? error.message : String(error);
type InspectedPage = { sentences: string[]; revision: number; selected?: string; previousQuote?: { url: string; revision: number } };
export function discoveryLinks(text: string) {
  const links = new Set<string>();
  for (const [match] of text.matchAll(/https?:\/\/[^\s<>"\])]+/giu)) {
    const url = match.replace(/[.,;!?。，；！？]+$/, "");
    if (url.length <= 2048 && discoverySourceURL(url)) links.add(new URL(url).href);
    if (links.size === 8) break;
  }
  return links;
}
export const requestsChatOnly = (text: string) => /\b(?:chat[- ]only|only (?:in|for) this (?:chat|conversation)|keep (?:this|it) (?:in this chat|between us)|(?:don['’]t|do not|never) (?:save|remember|share|publish|retain) (?:this|it))\b|仅限(?:本次|当前|这次)(?:对话|聊天)|只在(?:这个|本次|当前)(?:对话|聊天)|(?:不要|别)(?:保存|记住|分享|加入动态|加入灵感)/iu.test(text);
export const discoveryModule: VMFactory = context => {
  const enabled = museParityEnabled(), store = () => context.profile().discovery, approvals = FunctionApprovals.for(context.paths.state);
  const changed = () => context.emit({ type: "discovery" });
  const quiet = () => quietDiscoveryEnabled(context.settings());
  const policy = Approvals.for(context.paths.state), passages = new WeakMap<object, Map<string, InspectedPage>>();
  const scoped = async <T>(work: (scope: QuietScope) => Promise<T>) => {
    const [reports, connectors] = await Promise.all([context.discoveryReports?.() ?? [], context.quietConnectorProofs?.() ?? new Map<string,string>()]);
    return policy.quietScope(allows => work({ reports, allows, connectors }));
  };
  let lifetime = new AbortController();
  let unsubscribe: (() => void) | undefined, timer: ReturnType<typeof setInterval> | undefined, pending: ReturnType<typeof setTimeout> | undefined;
  let working: Promise<void> | undefined, dirty = false;
  const wake = () => {
    if (!unsubscribe || !quiet()) return;
    dirty = true;
    if (working || pending) return;
    pending = setTimeout(() => {
      pending = undefined;
      if (context.contentBlocked?.() || !unsubscribe || !quiet()) return;
      dirty = false;
      const run = async () => {
        await context.pollQuietConnectors?.(lifetime.signal);
        if (!lifetime.signal.aborted && await scoped(async scope => quiet() && await context.profile().quietDiscovery.reconcile(scope))) changed();
      };
      working = (context.withContentEpoch && context.contentEpoch ? context.withContentEpoch(context.contentEpoch(), run) : run())
        .catch(error => context.logs.warning("quiet-discovery", describe(error))).finally(() => { working = undefined; if (dirty) wake(); });
    }, 50);
  };
  const preparing = new Set<string>();
  let tail: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>) => { const next = tail.then(work); tail = next.then(() => {}, () => {}); return next; };
  const project = async (request: Generation): Promise<GenerationView> => {
    if (preparing.has(request.id)) return { ...request, status: "preparing" };
    if (request.conversationId === null) return { ...request, status: request.error ? "failed" : "unknown" };
    try {
      const [view, receipt] = await Promise.all([context.profile().view(request.conversationId), context.profile().submissionStatus(request.conversationId, request.id)]);
      if (receipt === "done") return { ...request, status: request.publishedAt ? request.publicationCount === 0 ? "noUpdate" : "completed" : "incomplete" };
      if (view.busy) return { ...request, status: "running" };
      if (request.cancelRequestedAt) return { ...request, status: "cancelled", error: null };
      if (receipt === null) return { ...request, status: request.error && !request.dispatchAttemptedAt ? "failed" : "unknown" };
      if (view.error) return { ...request, status: "failed", error: view.error };
      const last = [...view.messages].reverse().find(message => message.role === "assistant");
      if (last?.stopReason === "aborted") return { ...request, status: "cancelled" };
      if (last?.stopReason === "error") return { ...request, status: "failed", error: last.errorMessage ?? request.error };
      if (!view.messages.some(message => message.role === "user")) return { ...request, status: request.error ? "failed" : "unknown" };
      return { ...request, status: request.publishedAt ? request.publicationCount === 0 ? "noUpdate" : "completed" : "incomplete" };
    } catch (error) { return { ...request, status: "unavailable", error: describe(error) }; }
  };
  const generate = (kind: DiscoveryKind, request: Request) => serial(async () => {
    const input = discoveryInput(generationDraftSchema, await payload(request)), key = request.headers.get("idempotency-key") ?? "";
    const previous = await store().replay(kind, key, input);
    if (previous) return json({ generation: await project(previous), replayed: true });
    const current = await store().current(kind), status = current ? await project(current) : null;
    if (status && ["preparing", "running"].includes(status.status)) throw new HTTPError(409, "A generation is already active. Open its conversation or stop it first.");
    if (status?.status === "unknown" && !input.replaceUnknown) throw new HTTPError(409, "The previous dispatch was not confirmed. Inspect its conversation and explicitly confirm before starting again.");
    const choice = context.defaultModel();
    if (!choice || !context.providers.models.getModel(choice.provider, choice.modelId)) throw new HTTPError(503, "Configure an available default model before generating.");
    const allocated = await store().prepare(kind, key, input);
    preparing.add(allocated.id);
    try {
      const profile = context.profile(), id = await profile.create(choice);
      await profile.rename(id, kind === "feed" ? "Feed generation" : "Ideas generation");
      await store().bind(allocated.id, id);
      await profile.ready(id);
      const namespace = kind === "feed" ? "ox.feed.publish" : "ox.idea.publish";
      const prompt = `[OpenOx ${kind} generation ${allocated.id}]\n${allocated.prompt}\n\nUse only context the user has chosen to share. `
        + `Create bounded ${kind === "feed" ? "source-labelled updates with safe source URLs" : "actionable proposals, not new tasks or Goals"}. `
        + `Publish through ${namespace} after approval, using generationId ${allocated.id}. Publish an empty items array if there are no useful updates. `
        + `Do not claim independent source verification or success before the publication receipt. Use only existing public artifact paths for images. Do not start unrelated purchases, logins or scheduled work.`;
      await store().dispatchAttempted(allocated.id);
      const running = context.submit(id, prompt, [], undefined, allocated.id);
      void running.then(outcome => {
        if (outcome.outcome === "failed") context.logs.warning("discovery", `generation failed id=${allocated.id}: ${outcome.error}`);
        changed();
      }, error => { context.logs.error("discovery", `generation failed id=${allocated.id}: ${describe(error)}`); changed(); });
      await store().submitted(allocated.id);
      context.logs.info("discovery", `generate kind=${kind} id=${allocated.id} conversation=${id} by=web`); changed();
      return json({ generation: await project(await store().getGeneration(allocated.id)), replayed: false }, { status: 202,
        headers: { location: `/api/${kind}/generations/${allocated.id}` } });
    } catch (error) {
      context.logs.error("discovery", `dispatch not confirmed id=${allocated.id}: ${describe(error)}`);
      await store().failed(allocated.id, describe(error));
      throw new HTTPError(503, `Generation ${allocated.id} was not confirmed. Inspect this saved request before retrying.`);
    } finally { preparing.delete(allocated.id); changed(); }
  });
  const query = (url: URL) => {
    if ([...url.searchParams.keys()].some(key => !["q", "sort", "limit", "cursor", "includeHidden"].includes(key))) throw new HTTPError(400, "Unknown Feed/Ideas query field.");
    const hidden = url.searchParams.get("includeHidden");
    if (hidden !== null && !["true", "false"].includes(hidden)) throw new HTTPError(400, "Invalid hidden-items filter.");
    return { hidden: hidden === "true", page: Object.fromEntries([...url.searchParams].filter(([key]) => key !== "includeHidden")) };
  };
  const route = (kind: DiscoveryKind): VMRoute => async (request, url, parts) => {
    if (!enabled) { if (!parts.length && request.method === "GET") return json({ available: false }); throw new HTTPError(503, "Feed and Ideas are disabled on this Host."); }
    try {
      if (!parts.length && request.method === "GET") {
        await context.profile().syncLibrary();
        const fields = query(url), current = await store().current(kind);
        const items = await store().list(kind, fields.hidden), local = quiet() ? await scoped(async scope => quiet() ? context.profile().quietDiscovery.list(kind, fields.hidden, scope) : []) : [];
        return json({ available: true, prompt: kind === "feed" ? await store().prompt() : { revision: 1 },
          ...metadataPage([...items, ...local], fields.page, `${kind}:${fields.hidden}`), generation: current ? await project(current) : null });
      }
      if (parts.length === 1 && parts[0] === "prompt" && kind === "feed" && request.method === "PATCH") {
        const result = await store().setPrompt(await payload(request)); changed(); return json(result);
      }
      if (parts.length === 1 && parts[0] === "generate" && request.method === "POST") return await generate(kind, request);
      if (parts.length === 2 && parts[0] === "items" && request.method === "PATCH") {
        const value = await payload(request), id = parts[1]!;
        const local = quiet() ? await scoped(async scope => quiet() ? context.profile().quietDiscovery.update(kind, id, value, scope) : null) : null;
        const result = local ?? await store().update(kind, id, value); changed(); return json(result);
      }
      if (parts[0] === "generations" && parts[1]) {
        const item = await store().getGeneration(parts[1]);
        if (item.kind !== kind) throw new HTTPError(404, "Generation not found");
        if (parts.length === 2 && request.method === "GET") return json(await project(item));
        if (parts.length === 3 && parts[2] === "stop" && request.method === "POST") {
          if (item.conversationId !== null && await context.profile().stop(item.conversationId)) await store().cancelRequested(item.id);
          changed(); return json(await project(await store().getGeneration(item.id)));
        }
      }
      throw new HTTPError(404, "Not found");
    } catch (error) { throw error instanceof OxError ? new HTTPError(statuses[error.code] ?? 400, error.message) : error; }
  };
  const authorize = async (call: FunctionCall, title: string) => {
    if (JSON.stringify(call.args, null, 2).length > 32_768) throw new OxError("invalid_argument", "Feed/Ideas approval details exceed the full-detail budget.");
    await approvals.require(call, { action: call.name, title, args: call.args, detailLimit: 32_768,
      disclosure: "These semantic objects are shared with this model. Sources are not independently verified. Publication does not run an Idea, create a Goal, schedule work or modify MEMORY." });
    call.signal.throwIfAborted();
  };
  const write = async <T>(call: FunctionCall, title: string, work: () => Promise<T>) => {
    if ((await call.profile.summary(call.conversationId)).temporary) throw new OxError("permission_denied", "Temporary conversations cannot publish persistent Feed or Ideas.");
    await authorize(call, title); await context.profile().syncLibrary();
    const result = await work(); context.logs.info("discovery", `${call.name} by=agent`); changed(); return result;
  };
  const input = (call: FunctionCall) => { const { purpose: _purpose, ...fields } = call.args; return fields; };
  const publish = (call: FunctionCall, kind: DiscoveryKind) => {
    if (!call.requestID) throw new OxError("invalid_state", "This publication has no original request identity.");
    const key = call.requestID, draft = discoveryPublication(kind, input(call));
    return write(call, kind === "feed" ? "Publish Feed updates" : "Save actionable Ideas", async () => {
      await call.profile.validateEvidencePublication(call);
      return store().publish(kind, draft, key, call.conversationId);
    });
  };
  return {
    start: quietDiscoveryAvailable() && context.onDiscoveryInput ? async () => {
      lifetime = new AbortController();
      const events = context.onDiscoveryInput!(wake), policies = policy.onChanged(wake);
      unsubscribe = () => { events(); policies(); }; timer = setInterval(wake, 30 * 60_000); wake();
    } : undefined,
    close: async () => { lifetime.abort(); unsubscribe?.(); unsubscribe = undefined; clearInterval(timer); clearTimeout(pending); pending = undefined; dirty = false; await working; },
    conversationRemoved: async id => { await context.profile().quietDiscovery.forgetConversation(id); wake(); },
    conversationReplaced: async id => { await context.profile().quietDiscovery.forgetConversation(id); wake(); },
    afterFunction: quietDiscoveryAvailable() ? async (call, result) => {
      if (!quiet() || call.name !== "ox.web.fetch" || !isObject(result) || !result.ok || typeof result.text !== "string" || typeof result.url !== "string") return;
      const turn = policy.discoveryTurn(call);
      if (!turn || turn.publicLookup?.ticker || !discoverySourceURL(result.url)) return;
      let previousQuote: InspectedPage["previousQuote"];
      if (turn.publicLookup) {
        if (!turn.publicLookup.observed.pages.includes(result.url)) return;
      } else {
        if (!turn.discoveryURLs || result.redirected !== false || !["text", "html"].includes(String(result.kind)) || /[?#]/.test(result.url)) return;
        if (!turn.discoveryURLs.has(result.url)) {
          if (turn.discoveryURLs.size) return;
          // A fresh read may refresh the chat's one visible source, never start a new topic from history.
          const revision = await context.profile().quietDiscovery.chatQuoteRevision(call.conversationId, result.url);
          if (revision === undefined) return;
          previousQuote = { url: result.url, revision };
        }
      }
      if (!await call.profile.quietDiscovery.chatEligible(call.conversationId)) return;
      await policy.guard(call);
      const pages = passages.get(turn) ?? new Map<string, InspectedPage>();
      if (pages.size >= 8 && !pages.has(result.url)) return;
      const parts = result.text.slice(0, 8192).split(/\n+|(?<=[.!?])\s+|(?<=[。！？])/u);
      if (result.text.length > 8192 || result.truncated) parts.pop();
      const sentences = parts.map(s => s.trim().replace(/\s+/g, " ")).filter(s => s.length >= 20 && s.length <= 500);
      pages.set(result.url, { sentences, revision: policy.revision, previousQuote }); passages.set(turn, pages);
    } : undefined,
    finishDiscoveryTurn: async (id, submission, answer) => {
      const turn = policy.discoverySubmission(id);
      if (!quiet() || !turn || turn.id !== submission || turn.publicLookup?.ticker) return;
      const pages = passages.get(turn); if (!pages) return;
      const cited = discoveryLinks(answer);
      const text = answer.replace(/\s+/g, " ");
      for (const [url, page] of pages) {
        if (!cited.has(url)) continue;
        const quote = page.selected ?? page.sentences.find(s => text.includes(s));
        if (!quote) continue;
        const queued = await policy.quietScope(async (allows, revision) => {
          if (!quiet() || policy.discoverySubmission(id) !== turn || revision !== page.revision || !allows("feed", [url])) return false;
          return context.profile().quietDiscovery.nominate(id, { url, quote }, { previousQuote: page.previousQuote });
        });
        if (queued) wake();
        break;
      }
    },
    content: { busy: () => !!working },
    routes: { feed: route("feed"), ideas: route("ideas") }, handlers: enabled ? {
    ...(quietDiscoveryAvailable() ? { "ox.discovery.propose": async (call: FunctionCall) => {
      const item = call.args.item, turn = policy.discoveryTurn(call);
      if (!quiet() || !turn || !isObject(item) || (await call.profile.summary(call.conversationId)).temporary)
        throw new OxError("permission_denied", "Private suggestions require an enabled Workspace and a regular user turn.");
      const source = call.args.source === undefined ? undefined : discoveryInput(chatQuoteSchema, call.args.source);
      const expectedRevision = call.args.expectedRevision;
      if (expectedRevision !== undefined && expectedRevision !== null
        && (typeof expectedRevision !== "number" || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1))
        throw new OxError("invalid_argument", "Use the observed positive Idea revision or null for create-only.");
      const queued = await policy.quietScope(async (allows, revision) => {
        if (!quiet() || policy.discoveryTurn(call) !== turn || !allows("ideas", []))
          throw new OxError("permission_denied", "Current permissions do not allow this quiet discovery item.");
        const page = source && passages.get(turn)?.get(source.url);
        const quote = source?.quote.trim().replace(/\s+/g, " ");
        if (source && (!page || page.revision !== revision || !quote || !page.sentences.includes(quote) || !allows("feed", [source.url])))
          throw new OxError("invalid_argument", "The excerpt must be a complete sentence from the original permitted page read in this turn. Omit the source if it cannot be verified.");
        const saved = await call.profile.quietDiscovery.nominate(call.conversationId, item, { previousQuote: page?.previousQuote, previousIdea: call.args.previous, expectedRevision });
        if (page && quote) page.selected = quote;
        return saved;
      });
      if (queued) wake();
      return { queued };
    } } : {}),
    "ox.feed.list": async call => { await authorize(call, "Read Feed objects"); await context.profile().syncLibrary(); return metadataPage(await store().list("feed"), call.args, "feed", true); },
    "ox.idea.list": async call => { await authorize(call, "Read Ideas"); await context.profile().syncLibrary(); return metadataPage(await store().list("ideas"), call.args, "ideas", true); },
    "ox.feed.setPrompt": async call => { const draft = discoveryInput(discoveryPromptSchema, input(call)); return write(call, "Save the Feed prompt", () => store().setPrompt(draft)); },
    "ox.feed.publish": async call => publish(call, "feed"),
    "ox.idea.publish": async call => publish(call, "ideas"),
  } : undefined };
};

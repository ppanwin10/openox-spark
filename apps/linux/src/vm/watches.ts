import { contentRevision, OxError, watchDraftSchema, watchInput, watchPatchSchema, watchRevisionSchema, type FunctionCall, type InboxDraft, type WatchView } from "@openox/agent/linux";
import { personalAgentEnabled, quietDiscoveryEnabled } from "../config";
import { HTTPError, json, payload } from "../http";
import type { VMFactory, VMRoute } from "./context";
import { allowsURL } from "./net";
import { FunctionApprovals } from "./skills-approval";

const describe = (error: unknown) => error instanceof Error ? error.message : String(error);
const statuses: Record<string, number> = { not_found: 404, conflict: 409, unavailable: 503, limit_exceeded: 409 };
const disclosure = "Watch metadata is shared with the current model. Page checks use anonymous static text, without sign-in or site JavaScript. Enabling permits recurring reads while this Host stays awake, not event interpretation or model runs. Deleting keeps existing notices and history.";
function publicURL(value: string) {
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new OxError("invalid_argument", "Enter an absolute public HTTP or HTTPS URL without credentials."); }
  if (!allowsURL(url)) throw new OxError("invalid_argument", "Enter a public HTTP or HTTPS URL without credentials, private addresses or unusual ports.");
  url.hash = "";
  return url.href;
}

export const watchesModule: VMFactory = context => {
  const enabled = personalAgentEnabled(), store = () => context.profile().watches;
  let abort = new AbortController();
  const approvals = FunctionApprovals.for(context.paths.state);
  let timer: ReturnType<typeof setTimeout> | undefined, active: Promise<unknown> | undefined;
  let closed = false, failure: string | null = null;
  let scheduled = 0;
  const changed = () => context.emit({ type: "watches" });
  const notice = (watch: WatchView, id: string): InboxDraft => ({
    id, tag: `watch-${watch.id}`, targetUrl: `/#/automations/${watch.id}`, urgency: "normal", occurredAt: new Date().toISOString(),
    title: { en: "Public page changed", "zh-Hans": "关注的网页有变化" }, body: { en: watch.name, "zh-Hans": watch.name },
  });
  const report = (error: unknown) => {
    failure = describe(error); context.logs.warning("watches", failure); changed();
    if (!closed) { clearTimeout(timer); timer = setTimeout(() => void schedule().catch(report), 60_000); }
  };
  const schedule = async () => {
    const generation = ++scheduled;
    clearTimeout(timer);
    if (closed || active || context.contentBlocked?.()) return;
    const pending = (await store().list()).filter(watch => watch.enabled && !watch.checking && watch.nextCheckAt !== null);
    failure = null;
    if (!pending.length || closed || active || generation !== scheduled) return;
    const next = Math.min(...pending.map(watch => Date.parse(watch.nextCheckAt!)));
    timer = setTimeout(() => void tick().catch(report), Math.min(Math.max(next - Date.now(), 100), 60_000));
  };
  const run = (id: string, revision: number, automatic: boolean) => {
    if (closed || active) throw new OxError("conflict", "Another public-page check is running. Read the current state before trying again.");
    const operation = (async () => {
      const claim = await store().claim(id, revision, automatic);
      if (!claim) throw new OxError("conflict", "The watch is no longer due or enabled.");
      changed();
      try {
        const read = await context.browser.readPublic(claim.watch.url, claim.watch.selector, abort.signal);
        const result = await store().finish(id, claim.token, { fingerprint: contentRevision(read.text), characters: read.text.length,
          sourceTitle: read.sourceTitle, resolvedUrl: read.resolvedUrl }, notice, quietDiscoveryEnabled(context.settings()) ? read.text : undefined);
        if (result.discarded) throw new OxError("conflict", "The watch changed while checking; its old result was discarded.");
        context.logs.info("watches", `check id=${id} outcome=${result.watch.lastOutcome}`);
        if (result.notice) {
          const item = result.notice;
          context.emit({ type: "notifications" });
          context.notify({ id: item.id, tag: item.tag, url: item.targetUrl, urgency: item.urgency,
            title: language => item.title[language], body: language => item.body[language] });
        }
        return { watch: result.watch, noticeId: result.notice?.id ?? null };
      } catch (error) {
        if (closed) throw error;
        const result = await store().finish(id, claim.token, { error: describe(error) }, notice);
        if (result.discarded) throw new OxError("conflict", "The watch changed while checking; its old result was discarded.");
        context.logs.warning("watches", `check id=${id} failed: ${describe(error)}`);
        throw new HTTPError(502, `The public-page check failed: ${describe(error)}`);
      }
    })();
    const settled = operation.finally(() => { active = undefined; changed(); void schedule().catch(report); });
    active = settled;
    return settled;
  };
  const tick = async () => {
    if (closed || active || context.contentBlocked?.()) return;
    const now = new Date().toISOString(), due = (await store().list()).find(watch => watch.enabled && !watch.checking && watch.nextCheckAt !== null && watch.nextCheckAt <= now);
    if (!due) { await schedule(); return; }
    try { await run(due.id, due.revision, true); }
    catch (error) { if (!closed) context.logs.warning("watches", `scheduled check id=${due.id}: ${describe(error)}`); }
  };
  const authorize = async (call: FunctionCall, title: string, args: Record<string, unknown>) => {
    await approvals.require(call, { action: call.name, title, disclosure, args, detailLimit: 32_768 });
    call.signal.throwIfAborted();
  };
  const write = async <T>(call: FunctionCall, title: string, args: Record<string, unknown>, operation: () => Promise<T>) => {
    if ((await call.profile.summary(call.conversationId)).temporary) throw new OxError("permission_denied", "Temporary conversations cannot manage persistent page watches.");
    await authorize(call, title, args);
    const result = await operation();
    context.logs.info("watches", `${call.name} by=agent`);
    changed(); void schedule().catch(report);
    return result;
  };
  const currentTarget = (watch: WatchView) => ({ id: watch.id, name: watch.name, url: watch.url, selector: watch.selector,
    intervalMinutes: watch.intervalMinutes, enabled: watch.enabled, revision: watch.revision });
  const input = (call: FunctionCall) => { const { purpose: _purpose, id: _id, ...value } = call.args; return value; };
  const route: VMRoute = async (request, url, parts) => {
    if (!enabled) {
      if (!parts.length && request.method === "GET") return json({ available: false });
      throw new HTTPError(503, "The personal-agent preview is disabled on this Host.");
    }
    try {
      if (!parts.length && request.method === "GET") {
        const watches = await store().list(), summary = { available: true, running: active ? 1 : 0, warning: failure, limit: 20 };
        return json(url.searchParams.get("summary") === "1" ? { ...summary, total: watches.length,
          enabled: watches.filter(watch => watch.enabled).length, failed: watches.filter(watch => ["failed", "interrupted"].includes(watch.lastOutcome)).length }
          : { ...summary, watches });
      }
      if (!parts.length && request.method === "POST") {
        const input = watchInput(watchDraftSchema, await payload(request));
        const result = await store().create({ ...input, url: publicURL(input.url) }, request.headers.get("idempotency-key") ?? "");
        context.logs.info("watches", `create id=${result.watch.id} replayed=${result.replayed} by=web`); changed(); void schedule().catch(report);
        return json(result, { status: result.replayed ? 200 : 201 });
      }
      const id = parts[0] ?? "";
      if (parts.length === 1 && request.method === "GET") return json(await store().get(id));
      if (parts.length === 1 && request.method === "PATCH") {
        const input = watchInput(watchPatchSchema, await payload(request));
        const watch = await store().update(id, { ...input, ...(input.url === undefined ? {} : { url: publicURL(input.url) }) });
        context.logs.info("watches", `update id=${id} by=web`); changed(); void schedule().catch(report);
        return json(watch);
      }
      if (parts.length === 1 && request.method === "DELETE") {
        const input = watchInput(watchRevisionSchema, await payload(request)), result = await store().delete(id, input.expectedRevision);
        context.logs.info("watches", `delete id=${id} by=web`); changed(); void schedule().catch(report);
        return json(result);
      }
      if (parts.length === 2 && parts[1] === "check" && request.method === "POST") {
        const input = watchInput(watchRevisionSchema, await payload(request));
        return json(await run(id, input.expectedRevision, false));
      }
      throw new HTTPError(404, "Not found");
    } catch (error) { throw error instanceof OxError ? new HTTPError(statuses[error.code] ?? 400, error.message) : error; }
  };
  return {
    handlers: enabled ? {
      "ox.watch.list": async call => {
        await authorize(call, "List page watches", call.args);
        return { watches: await store().list(), running: active ? 1 : 0, warning: failure };
      },
      "ox.watch.create": async call => {
        if (!call.requestID) throw new OxError("invalid_state", "This watch creation has no Host request identity.");
        const requestID = call.requestID, draft = watchInput(watchDraftSchema, input(call));
        const normalized = { ...draft, url: publicURL(draft.url) };
        return write(call, "Create a page watch", { purpose: call.args.purpose, ...normalized, enabled: normalized.enabled ?? false },
          () => store().create(normalized, requestID));
      },
      "ox.watch.update": async call => {
        const id = String(call.args.id), patch = watchInput(watchPatchSchema, input(call)), current = await store().get(id);
        const normalized = { ...patch, ...(patch.url === undefined ? {} : { url: publicURL(patch.url) }) };
        return write(call, "Update a page watch", { purpose: call.args.purpose, current: currentTarget(current), ...normalized },
          () => store().update(id, normalized));
      },
      "ox.watch.delete": async call => {
        const id = String(call.args.id), current = await store().get(id), revision = Number(call.args.expectedRevision);
        return write(call, "Delete a page watch", { purpose: call.args.purpose, current: currentTarget(current), expectedRevision: revision },
          () => store().delete(id, revision));
      },
    } : undefined,
    routes: { watches: route },
    start: enabled ? async () => { closed = false; abort = new AbortController(); try { await store().recover(); await schedule(); } catch (error) { report(error); } } : undefined,
    close: async () => { closed = true; clearTimeout(timer); abort.abort(); await active?.catch(error => context.logs.info("watches", `shutdown check: ${describe(error)}`)); },
    content: { busy: () => !!active },
  };
};

import { FileError, OxError, contentRevision, reviewAcceptSchema, reviewConflict, reviewDraftSchema, reviewInput, reviewMemorySchema,
  reviewRevisionSchema, reviewSettingsSchema, type FunctionCall, type ReviewCandidate, type ReviewSource } from "@openox/agent/linux";
import { personalAgentEnabled } from "../config";
import { HTTPError, json, payload } from "../http";
import type { VMContext, VMFactory, VMRoute } from "./context";
import { canonicalSkillName, draftSkill, parseSkill, serializeSkill } from "./skills-files";
import { FunctionApprovals } from "./skills-approval";

const describe = (error: unknown) => error instanceof Error ? error.message : String(error);
const statuses: Record<string, number> = { not_found: 404, permission_denied: 403, conflict: 409, unavailable: 503, limit_exceeded: 409 };

export const reviewModule: VMFactory = (context: VMContext) => {
  const enabled = personalAgentEnabled(), store = () => context.profile().review;
  const approvals = FunctionApprovals.for(context.paths.state);
  let chain: Promise<unknown> = Promise.resolve();
  let failure: string | null = null;
  const changed = () => context.emit({ type: "review" });
  const serial = <T>(work: () => Promise<T>) => {
    const next = chain.then(work);
    chain = next.catch(error => context.logs.warning("review", describe(error)));
    return next;
  };
  const normalize = (value: unknown) => {
    const draft = reviewInput(reviewDraftSchema, value);
    if (draft.data.type === "skill") {
      const skill = draftSkill(canonicalSkillName(draft.data.name), draft.data.description, draft.data.instructions, draft.data.services);
      return { data: { type: "skill" as const, operation: draft.data.operation, name: skill.name,
        description: skill.description, instructions: skill.instructions, services: skill.services }, reason: draft.reason };
    }
    return draft;
  };
  const source = async (candidate: ReviewCandidate): Promise<ReviewSource> => {
    if (candidate.data.type === "memory") return { path: "MEMORY.md", ...await context.profile().memorySnapshot() };
    const path = `skills/${canonicalSkillName(candidate.data.name)}/SKILL.md`;
    try { return { path, ...await context.profile().textSnapshot(path) }; }
    catch (error) {
      if (error instanceof FileError && error.code === "not_found") return { path, text: null, revision: "missing" };
      throw error;
    }
  };
  const cleanup = async (id: string) => {
    const record = await store().get(id), staging = record.mutation?.staging;
    if (!staging) return null;
    try {
      const files = await context.profile().listFiles(staging);
      if (files.length !== 1 || files[0]!.name !== "SKILL.md" || files[0]!.kind !== "file"
        || (await context.profile().textSnapshot(`${staging}/SKILL.md`)).revision !== record.mutation!.after) {
        throw new OxError("conflict", "A review staging folder changed; it was retained for inspection.");
      }
      await context.profile().removeFile(staging);
      return null;
    } catch (error) {
      if (error instanceof FileError && error.code === "not_found") return null;
      const warning = describe(error);
      context.logs.warning("review", `staging cleanup id=${id}: ${warning}`);
      return warning;
    }
  };
  const reconcile = async (id: string) => {
    const record = await store().get(id);
    if (record.candidate.status !== "applying" || !record.mutation) return record.candidate;
    const current = await source(record.candidate);
    let matches = current.revision === record.mutation.after;
    if (matches && record.candidate.data.type === "skill" && record.candidate.data.operation === "create") {
      const files = await context.profile().listFiles(`skills/${record.candidate.data.name}`);
      matches = files.length === 1 && files[0]!.name === "SKILL.md" && files[0]!.kind === "file";
    }
    if (matches) {
      const candidate = await store().finish(id, record.candidate.revision);
      await cleanup(id);
      return candidate;
    }
    await cleanup(id);
    await store().release(id, current.revision === record.mutation.before
      ? "Publication was interrupted before the source changed. Review again before retrying."
      : "The source changed during publication. Review the current document before deciding again.", current.revision !== record.mutation.before);
    return (await store().get(id)).candidate;
  };
  const accept = async (id: string, value: unknown) => {
    const input = reviewInput(reviewAcceptSchema, value);
    let record = await store().get(id);
    if (record.candidate.status === "applying") { await reconcile(id); record = await store().get(id); }
    if (record.candidate.status === "accepted" && record.mutation?.expectedRevision === input.expectedRevision
      && record.mutation.before === input.expectedSourceRevision) return { candidate: record.candidate, replayed: true, warning: null };
    if (!["pending", "needs_review"].includes(record.candidate.status) || record.candidate.revision !== input.expectedRevision) throw reviewConflict();
    const current = await source(record.candidate);
    if (current.revision !== input.expectedSourceRevision) throw reviewConflict();
    const data = record.candidate.data;
    if (data.type === "skill" && ((data.operation === "create") !== (current.text === null))) throw reviewConflict();
    let next: string;
    if (data.type === "memory") {
      if (current.text === null) throw new OxError("unavailable", "MEMORY.md is unavailable.");
      const eol = current.text.includes("\r\n") ? "\r\n" : "\n", line = `- ${data.text}`;
      next = current.text.split(/\r?\n/).includes(line) ? current.text
        : current.text + (current.text ? current.text.endsWith("\n") ? eol : eol + eol : "") + line + eol;
    } else next = serializeSkill(draftSkill(data.name, data.description, data.instructions, data.services));
    if (new TextEncoder().encode(next).length > (data.type === "memory" ? 512 * 1024 : 200 * 1024)) throw new OxError("limit_exceeded", "The reviewed document exceeds its size limit.");
    const staging = data.type === "skill" && data.operation === "create" ? `drafts/review-${crypto.randomUUID()}` : null;
    const claimed = await store().claim(id, input.expectedRevision,
      { path: current.path, before: current.revision, after: contentRevision(next), staging });
    try {
      if (staging && data.type === "skill") {
        await context.profile().writeFile(`${staging}/SKILL.md`, next);
        await context.profile().moveFile(staging, `skills/${data.name}`);
      } else {
        if (current.text === null) throw new OxError("unavailable", "The reviewed source is unavailable.");
        await context.profile().writeFile(current.path, next, current.text);
      }
      const verified = await source(record.candidate);
      if (verified.revision !== contentRevision(next)) throw new OxError("conflict", "The published file changed before its receipt was saved.");
      const candidate = await store().finish(id, claimed.revision), warning = await cleanup(id);
      context.logs.info("review", `published id=${id} type=${data.type}`);
      context.emit({ type: data.type === "skill" ? "skills" : "settings" });
      changed();
      return { candidate, replayed: false, warning };
    } catch (error) {
      const recovered = await reconcile(id);
      changed();
      if (recovered.status === "accepted") return { candidate: recovered, replayed: true, warning: "The file result was verified after an interrupted receipt." };
      if (error instanceof FileError && error.code === "invalid") throw reviewConflict();
      throw error;
    }
  };
  const create = async (value: unknown, key: string, origin: ReviewCandidate["origin"]) => {
    const result = await store().create(normalize(value), key, origin);
    context.logs.info("review", `proposed id=${result.candidate.id} type=${result.candidate.data.type} by=${origin.kind}`);
    changed();
    return result;
  };
  const propose = async (call: FunctionCall, type: "memory" | "skill") => {
    await store().requireEnabled();
    if ((await call.profile.summary(call.conversationId)).temporary) throw new OxError("permission_denied", "Temporary conversations cannot retain long-term suggestions.");
    const { purpose: _purpose, reason, ...fields } = call.args;
    const draft = normalize({ data: { type, ...fields }, reason });
    await approvals.require(call, { action: call.name, title: type === "memory" ? "Save a memory suggestion" : "Save a Skill suggestion",
      disclosure: "This stays inactive until the owner reviews and publishes it." });
    call.signal.throwIfAborted();
    if (!call.requestID) throw new OxError("invalid_state", "This suggestion has no Host request identity.");
    return create(draft, call.requestID, { kind: "agent", conversationId: call.conversationId });
  };
  const route: VMRoute = async (request, url, parts) => {
    if (!enabled) {
      if (!parts.length && request.method === "GET") return json({ available: false });
      throw new HTTPError(503, "The personal-agent preview is disabled on this Host.");
    }
    try {
      if (failure) throw new OxError("unavailable", failure);
      if (!parts.length && request.method === "GET") {
        const state = await store().list();
        if (url.searchParams.get("summary") === "1") return json({ available: true, settings: state.settings,
          pending: state.candidates.filter(candidate => ["pending", "needs_review"].includes(candidate.status)).length, limit: state.limit });
        return json({ available: true, ...state, memory: await context.profile().memorySnapshot() });
      }
      if (!parts.length && request.method === "POST") return await serial(async () => {
        const result = await create(await payload(request), request.headers.get("idempotency-key") ?? "", { kind: "manual", conversationId: null });
        return json(result, { status: result.replayed ? 200 : 201 });
      });
      if (parts.length === 1 && parts[0] === "settings" && request.method === "PUT") {
        const input = reviewInput(reviewSettingsSchema, await payload(request));
        const settings = await store().settings(input.expectedRevision, input.suggestionsEnabled);
        changed(); return json(settings);
      }
      if (parts.length === 1 && parts[0] === "memory" && request.method === "PUT") return await serial(async () => {
        const input = reviewInput(reviewMemorySchema, await payload(request)), current = await context.profile().memorySnapshot();
        if (current.revision !== input.expectedSourceRevision) throw reviewConflict();
        await context.profile().writeFile("MEMORY.md", input.text, current.text);
        context.emit({ type: "settings" }); changed();
        return json(await context.profile().memorySnapshot());
      });
      const id = parts[0] ?? "";
      if (parts.length === 1 && request.method === "GET") {
        const { candidate } = await store().get(id), current = await source(candidate), data = candidate.data;
        const before = data.type === "skill" && current.text ? parseSkill(current.text, data.name)?.services ?? [] : [];
        return json({ candidate, source: current, validation: { scope: "instructions_and_declarations",
          addedServices: data.type === "skill" ? data.services.filter(service => !before.includes(service)) : [],
          removedServices: data.type === "skill" ? before.filter(service => !data.services.includes(service)) : [] } });
      }
      if (parts.length === 2 && parts[1] === "accept" && request.method === "POST") return await serial(async () => json(await accept(id, await payload(request))));
      if (parts.length === 2 && parts[1] === "reject" && request.method === "POST") {
        const input = reviewInput(reviewRevisionSchema, await payload(request));
        const candidate = await store().reject(id, input.expectedRevision); changed(); return json({ candidate });
      }
      if (parts.length === 1 && request.method === "DELETE") {
        const input = reviewInput(reviewRevisionSchema, await payload(request));
        const result = await store().delete(id, input.expectedRevision); changed(); return json(result);
      }
      throw new HTTPError(404, "Not found");
    } catch (error) {
      if (error instanceof OxError) throw new HTTPError(statuses[error.code] ?? 400, error.message);
      if (error instanceof FileError && error.code === "invalid") throw new HTTPError(409, "This document changed. Reload before saving.");
      throw error;
    }
  };
  return {
    handlers: enabled ? { "ox.memory.propose": call => propose(call, "memory"), "ox.skill.propose": call => propose(call, "skill") } : undefined,
    routes: { review: route },
    start: enabled ? async () => {
      try { for (const candidate of (await store().list()).candidates.filter(candidate => candidate.status === "applying")) await serial(() => reconcile(candidate.id)); }
      catch (error) { failure = describe(error); context.logs.warning("review", failure); }
    } : undefined,
    close: async () => { await chain; },
  };
};

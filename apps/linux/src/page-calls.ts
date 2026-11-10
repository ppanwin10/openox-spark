import { randomUUID } from "node:crypto";
import { extname } from "node:path";
import { approvalOptions, checkedCall, OxError, scriptContracts, type FunctionCall, type FunctionHandler, type LinuxProfile, type PromptAnswer, type PromptRequest, type Step } from "@openox/agent/linux";
import { HTTPError } from "./http";

export const pageFunctions = ["ox.service.list", "ox.service.inspect", "ox.service.validate", "ox.service.invoke", "ox.service.create", "ox.service.update", "ox.service.delete"] as const;
const supported: ReadonlySet<string> = new Set(pageFunctions);
export const pageContracts: Record<string, unknown> = Object.fromEntries(Object.entries(scriptContracts(pageFunctions)).filter(([, contract]) => contract !== null));
const argumentLimit = 1024 * 1024, resultLimit = 8 * 1024 * 1024, waitingLimit = 16, minuteLimit = 120, activeLimit = 60_000, sessionLimit = 64, closedLimit = 256;
const answerLimit = 15 * 60_000;
const validSession = /^[A-Za-z0-9-]{8,64}$/;

export type PageCallFailure = { code: string; message: string; recovery: string };
export type PageInteraction = { id: string; kind: "approval"; title: string; body: string; detail?: string; options: string[] };
export type PageOutcome = { interaction: PageInteraction } | { ok: true; value: unknown } | { ok: false; error: PageCallFailure };
type Asking = { interaction: PageInteraction; flow: PageFlow; settle(answer: PromptAnswer): void };
type Session = { device: string; path: string; owner: number; tail: Promise<unknown>; waiting: number; times: number[]; controller: AbortController; used: number; asking?: Asking };
export type PageCallHost = { handler(name: string): FunctionHandler | undefined; profile(): LinuxProfile; released(owner: number): Promise<void> };

export class PageFlow {
  readonly name: string;
  private readonly stopped = new AbortController();
  readonly signal = this.stopped.signal;
  private readonly queue: PageOutcome[] = [];
  private waiter?: (outcome: PageOutcome) => void;
  constructor(name: string) { this.name = name; }
  abandon() {
    this.stopped.abort();
    const waiter = this.waiter;
    this.waiter = undefined;
    waiter?.({ ok: false, error: { code: "cancelled", message: "The page stopped waiting for the call", recovery: "" } });
  }
  push(outcome: PageOutcome) {
    const waiter = this.waiter;
    this.waiter = undefined;
    if (waiter) waiter(outcome); else this.queue.push(outcome);
  }
  next() {
    const queued = this.queue.shift();
    return queued ? Promise.resolve(queued) : new Promise<PageOutcome>(resolve => { this.waiter = resolve; });
  }
}

export function pageCallFailure(error: unknown): PageCallFailure {
  if (error instanceof OxError) return { code: error.code, message: error.message, recovery: error.recovery };
  const code = error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : "failed";
  return { code, message: error instanceof Error ? error.message : String(error), recovery: "Inspect the error and try again." };
}

export class PageCalls {
  private readonly sessions = new Map<string, Session>();
  private readonly closed = new Set<string>();
  private readonly host: PageCallHost;
  private owners = 0;
  constructor(host: PageCallHost) { this.host = host; }

  open(device: string, id: string, raw: string) {
    if (!validSession.test(id)) throw new HTTPError(400, "Send the page's session");
    if (this.closed.has(`${device} ${id}`)) throw new HTTPError(410, "This page was closed");
    const path = raw.replace(/^\/+/, "");
    if (/[\\\0]/.test(path) || path.split("/").some(part => !part || part === "." || part === "..")) throw new HTTPError(400, "Invalid page path");
    if (![".html", ".htm"].includes(extname(path).toLowerCase())) throw new HTTPError(415, "Only HTML pages call services");
    let session = this.sessions.get(id);
    if (session && (session.device !== device || session.path !== path)) throw new HTTPError(409, "This session belongs to another page");
    if (!session) {
      if (this.sessions.size >= sessionLimit) this.evict();
      this.owners += 1;
      session = { device, path, owner: -this.owners, tail: Promise.resolve(), waiting: 0, times: [], controller: new AbortController(), used: Date.now() };
      this.sessions.set(id, session);
    }
    return session;
  }

  call(session: Session, name: string, args: unknown) {
    const flow = new PageFlow(name);
    try { this.admit(session, name, args); }
    catch (error) { flow.push({ ok: false, error: pageCallFailure(error) }); return flow; }
    const run = session.tail.then(() => this.run(session, name, args as Record<string, unknown>, flow));
    session.tail = run.catch(() => {});
    void run.then(value => flow.push({ ok: true, value }), (error: unknown) => flow.push({ ok: false, error: pageCallFailure(error) }))
      .finally(() => { session.waiting -= 1; session.used = Date.now(); });
    return flow;
  }

  answer(device: string, id: string, interaction: string, reply: string | null) {
    const session = this.sessions.get(id);
    const asking = session?.device === device ? session.asking : undefined;
    if (!asking || asking.interaction.id !== interaction) throw new HTTPError(409, "This question is no longer waiting for an answer");
    if (reply !== null && !asking.interaction.options.includes(reply)) throw new HTTPError(400, "Choose one of the offered answers");
    asking.settle(reply === null ? { kind: "cancelled" } : { kind: "answer", text: reply });
    return asking.flow;
  }

  close(device: string, id: string) {
    if (validSession.test(id)) {
      this.closed.add(`${device} ${id}`);
      if (this.closed.size > closedLimit) this.closed.delete(this.closed.values().next().value!);
    }
    const session = this.sessions.get(id);
    if (!session || session.device !== device) return false;
    this.discard(id, session);
    return true;
  }

  private admit(session: Session, name: string, args: unknown) {
    if (!supported.has(name)) throw new OxError("not_supported", `${name} isn't available to pages`, "Use the functions the page's ox object offers.");
    if (Buffer.byteLength(JSON.stringify(args) ?? "") > argumentLimit) throw new OxError("too_large", "HTML request exceeds 1 MiB", "Send smaller arguments.");
    checkedCall(name, args, supported);
    const now = Date.now();
    session.times = session.times.filter(time => now - time < 60_000);
    if (session.waiting >= waitingLimit || session.times.length >= minuteLimit) {
      throw new OxError("rate_limited", "HTML service call limit reached; wait before retrying", "Wait a minute, then call again.");
    }
    session.times.push(now);
    session.waiting += 1;
    session.used = now;
  }

  private discard(id: string, session: Session) {
    session.controller.abort();
    this.sessions.delete(id);
    void this.host.released(session.owner).catch(() => {});
  }

  private evict() {
    const idle = [...this.sessions].filter(([, session]) => !session.waiting).sort((a, b) => a[1].used - b[1].used)[0];
    if (!idle) throw new HTTPError(429, "Too many pages are calling services at once");
    this.discard(idle[0], idle[1]);
  }

  private async ask(session: Session, flow: PageFlow, clock: { pause(): void; resume(): void }, signal: AbortSignal, request: PromptRequest): Promise<PromptAnswer> {
    if (request.kind !== "approval") {
      throw new OxError("not_supported", request.kind === "page" ? "Pages can't hand a website to the user yet" : "Pages can't ask for this here",
        "Ask Ox in a conversation to finish setting up this service.");
    }
    if (signal.aborted) return { kind: "cancelled" };
    const interaction: PageInteraction = { id: randomUUID(), kind: "approval", title: request.title, body: request.body, ...(request.detail ? { detail: request.detail } : {}), options: [...approvalOptions] };
    clock.pause();
    try {
      return await new Promise<PromptAnswer>(resolve => {
        const settle = (answer: PromptAnswer) => {
          clearTimeout(expiry);
          signal.removeEventListener("abort", cancel);
          if (session.asking?.interaction === interaction) session.asking = undefined;
          resolve(answer);
        };
        const cancel = () => settle({ kind: "cancelled" });
        const expiry = setTimeout(cancel, answerLimit);
        signal.addEventListener("abort", cancel, { once: true });
        session.asking = { interaction, flow, settle };
        flow.push({ interaction });
      });
    } finally { clock.resume(); }
  }

  private async run(session: Session, name: string, args: Record<string, unknown>, flow: PageFlow) {
    const cancelled = () => new OxError("cancelled", "The page closed before the call finished", "Call again if the page still needs it.");
    if (session.controller.signal.aborted || flow.signal.aborted) throw cancelled();
    const controller = new AbortController();
    const stop = () => controller.abort();
    session.controller.signal.addEventListener("abort", stop, { once: true });
    flow.signal.addEventListener("abort", stop, { once: true });
    let remaining = activeLimit, started = Date.now(), finished = false, timer = setTimeout(stop, remaining);
    const clock = {
      pause() { clearTimeout(timer); remaining -= Date.now() - started; },
      resume() { if (finished) return; started = Date.now(); timer = setTimeout(stop, Math.max(0, remaining)); },
    };
    const stopped = new Promise<never>((_, reject) => controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true }));
    const work = async () => {
      const handler = this.host.handler(name);
      if (!handler) throw new OxError("not_supported", `${name} is not available on this Linux Host`, "Tell the user this capability is unavailable on this Host.");
      const profile = this.host.profile();
      await profile.statFile(session.path).catch(() => { throw new OxError("not_found", "The page's file no longer exists", "Reopen the page."); });
      controller.signal.throwIfAborted();
      const step: Step = { name, purpose: typeof args.purpose === "string" ? args.purpose : "", status: "running" };
      const call: FunctionCall = {
        name, args, conversationId: session.owner, signal: controller.signal, step, execution: { fetches: 0, attachments: [] }, profile,
        update: async fields => { Object.assign(step, fields); },
        ask: request => this.ask(session, flow, clock, controller.signal, request),
        untimed: next => next(),
        evaluate: async () => { throw new OxError("not_supported", "Pages can't run scripts through Ox", "Run the script in the page itself."); },
        page: { path: session.path },
      };
      return handler(call);
    };
    try {
      const value = await Promise.race([work(), stopped]).catch(error => {
        if (!controller.signal.aborted) throw error;
        throw session.controller.signal.aborted || flow.signal.aborted ? cancelled() : new OxError("timeout", "The call ran longer than 60 seconds", "Ask for less, or call again.");
      });
      if (Buffer.byteLength(JSON.stringify(value ?? null)) > resultLimit) throw new OxError("too_large", "HTML response exceeds 8 MiB", "Ask for less data.");
      return value ?? null;
    } finally {
      finished = true;
      clearTimeout(timer);
      session.controller.signal.removeEventListener("abort", stop);
      flow.signal.removeEventListener("abort", stop);
    }
  }
}

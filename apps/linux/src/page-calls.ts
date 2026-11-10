import { extname, posix } from "node:path";
import { checkedCall, OxError, scriptContracts, type FunctionCall, type FunctionHandler, type LinuxProfile, type Step } from "@openox/agent/linux";
import { HTTPError } from "./http";

export const pageFunctions = ["ox.service.list", "ox.service.inspect", "ox.service.validate"] as const;
const supported: ReadonlySet<string> = new Set(pageFunctions);
export const pageContracts: Record<string, unknown> = Object.fromEntries(Object.entries(scriptContracts(pageFunctions)).filter(([, contract]) => contract !== null));
const argumentLimit = 1024 * 1024, resultLimit = 8 * 1024 * 1024, waitingLimit = 16, minuteLimit = 120, activeLimit = 60_000, sessionLimit = 64, closedLimit = 256;
const validSession = /^[A-Za-z0-9-]{8,64}$/;

type Session = { device: string; path: string; tail: Promise<unknown>; waiting: number; times: number[]; controller: AbortController; used: number };
export type PageCallHost = { handler(name: string): FunctionHandler | undefined; profile(): LinuxProfile };
export type PageCallFailure = { code: string; message: string; recovery: string };

export function pageCallFailure(error: unknown): PageCallFailure {
  if (error instanceof OxError) return { code: error.code, message: error.message, recovery: error.recovery };
  const code = error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : "failed";
  return { code, message: error instanceof Error ? error.message : String(error), recovery: "Inspect the error and try again." };
}

export class PageCalls {
  private readonly sessions = new Map<string, Session>();
  private readonly closed = new Set<string>();
  private readonly host: PageCallHost;
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
      session = { device, path, tail: Promise.resolve(), waiting: 0, times: [], controller: new AbortController(), used: Date.now() };
      this.sessions.set(id, session);
    }
    return session;
  }

  async call(session: Session, name: string, args: unknown) {
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
    const run = session.tail.then(() => this.run(session, name, args as Record<string, unknown>));
    session.tail = run.catch(() => {});
    try { return await run; } finally { session.waiting -= 1; session.used = Date.now(); }
  }

  close(device: string, id: string) {
    if (validSession.test(id)) {
      this.closed.add(`${device} ${id}`);
      if (this.closed.size > closedLimit) this.closed.delete(this.closed.values().next().value!);
    }
    const session = this.sessions.get(id);
    if (!session || session.device !== device) return false;
    session.controller.abort();
    this.sessions.delete(id);
    return true;
  }

  private evict() {
    const idle = [...this.sessions].filter(([, session]) => !session.waiting).sort((a, b) => a[1].used - b[1].used)[0];
    if (!idle) throw new HTTPError(429, "Too many pages are calling services at once");
    idle[1].controller.abort();
    this.sessions.delete(idle[0]);
  }

  private async run(session: Session, name: string, args: Record<string, unknown>) {
    const cancelled = () => new OxError("cancelled", "The page closed before the call finished", "Call again if the page still needs it.");
    if (session.controller.signal.aborted) throw cancelled();
    const controller = new AbortController();
    const stop = () => controller.abort();
    session.controller.signal.addEventListener("abort", stop, { once: true });
    const timer = setTimeout(stop, activeLimit);
    const stopped = new Promise<never>((_, reject) => controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true }));
    const work = async () => {
      const handler = this.host.handler(name);
      if (!handler) throw new OxError("not_supported", `${name} is not available on this Linux Host`, "Tell the user this capability is unavailable on this Host.");
      const profile = this.host.profile();
      await profile.statFile(session.path).catch(() => { throw new OxError("not_found", "The page's file no longer exists", "Reopen the page."); });
      controller.signal.throwIfAborted();
      const step: Step = { name, purpose: typeof args.purpose === "string" ? args.purpose : "", status: "running" };
      const call: FunctionCall = {
        name, args, conversationId: -1, signal: controller.signal, step, execution: { fetches: 0, attachments: [] }, profile,
        update: async fields => { Object.assign(step, fields); },
        ask: async () => { throw new OxError("approval_unavailable", "This page can't ask for approval yet", "Allow this Action in Settings → Permissions, or ask Ox in a conversation."); },
        untimed: next => next(),
        evaluate: async () => { throw new OxError("not_supported", "Pages can't run scripts through Ox", "Run the script in the page itself."); },
        page: { path: session.path, folder: posix.dirname(session.path) },
      };
      return handler(call);
    };
    try {
      const value = await Promise.race([work(), stopped]).catch(error => {
        if (!controller.signal.aborted) throw error;
        throw session.controller.signal.aborted ? cancelled() : new OxError("timeout", "The call ran longer than 60 seconds", "Ask for less, or call again.");
      });
      if (Buffer.byteLength(JSON.stringify(value ?? null)) > resultLimit) throw new OxError("too_large", "HTML response exceeds 8 MiB", "Ask for less data.");
      return value ?? null;
    } finally {
      clearTimeout(timer);
      session.controller.signal.removeEventListener("abort", stop);
    }
  }
}

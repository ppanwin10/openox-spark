import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { OxError } from "@openox/agent/linux";
import type { LivePage } from "../browser/manager";
import type { VMContext } from "../context";
import { allowsURL, isTestURL } from "../net";
import { findAction, qualifiedName, resolvedBaseURL, sessionsEnabled, type ActionDef, type Definition, type Snapshot } from "./catalog";
import { evalError, handoffIncomplete, invokeError, pageUnavailable } from "./errors";
import { violations } from "./schema";
import { clone, describe, fail, isObject, same, sha256, sleep, withTimeout, type JSONObject } from "./support";

export type Approve = (name: string, input: unknown) => Promise<boolean>;
interface Invocation { id: string; actionId: string; args: unknown; requestedSession: unknown; pageURL: string | null; selectedSession: unknown; startedAt: number }
export interface ServicePage { owner: string; domain: string; version: string; live: LivePage; executionURL: string | null; lane: Lane; lastInvocation?: Invocation }
export interface WebInvocation {
  snapshot: Snapshot; actionId: string; args: JSONObject; session?: unknown; pageURL?: string | null; approve: Approve; signal?: AbortSignal; owned?: ServicePage;
}
export interface StagedFile { name: string; mimeType: string; data: Uint8Array }

const sessionSchema = { type: "object", properties: { id: { type: "string", minLength: 1 }, label: { type: "string", minLength: 1 }, url: { type: "string", minLength: 1 } },
  required: ["id", "label", "url"], additionalProperties: false };
const contextLost = /Execution context was destroyed|Target page, context or browser has been closed|Target closed|Frame was detached|frame got detached/i;

export const serviceHost = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);
export function hostOf(url: string) { try { return new URL(url).hostname.toLowerCase(); } catch { return ""; } }
export const normalizedURL = (url: string) => new URL(url).href;
const playwrightMessage = (error: unknown) => describe(error).split("\n")[0]!.replace(/^(page|frame|locator)\.\w+: /, "").replace(/^Error: /, "");

export function destination(text: unknown, domain: string) {
  const failure = () => fail("invalid_argument", "Execution URL must be a public HTTPS destination within the service domain", "Use an HTTPS URL on the service's own domain.");
  if (typeof text !== "string") throw failure();
  let url: URL;
  try { url = new URL(text); } catch { throw failure(); }
  if ((url.protocol !== "https:" && !isTestURL(url)) || url.username || url.password || !serviceHost(url.hostname.toLowerCase(), domain) || !allowsURL(url)) throw failure();
  return url.href;
}

function sessionDestination(session: unknown, domain: string) {
  if (!isObject(session) || violations(session, sessionSchema).length) {
    throw fail("invalid_argument", "Invalid session descriptor; copy a session returned by listSessions", "Invoke listSessions and pass one of its descriptors unchanged.");
  }
  return destination(session.url, domain);
}

export function executionURL(definition: Definition, defaultURL: string, session: unknown, pageURL: string | null | undefined) {
  if (session == null && pageURL == null) return defaultURL;
  if (!sessionsEnabled(definition)) throw fail("invalid_argument", "Session routing requires listSessions/login", "Omit session and pageUrl for this service.");
  const sessionURL = session == null ? undefined : sessionDestination(session, definition.domain);
  if (pageURL != null) return destination(pageURL, definition.domain);
  return sessionURL ?? defaultURL;
}

export function validateSessions(value: unknown, domain: string) {
  if (!Array.isArray(value)) throw fail("invalid_output", "listSessions must return an array", "Repair the service's listSessions action.");
  const ids = new Set<string>();
  for (const session of value) {
    sessionDestination(session, domain);
    const id = String((session as JSONObject).id);
    if (ids.has(id)) throw fail("invalid_output", "listSessions returned duplicate session identifiers", "Repair the service's listSessions action.");
    ids.add(id);
  }
}

export class Lane {
  private queue: { exclusive: boolean; start(): void }[] = [];
  private shared = 0;
  private exclusive = false;

  acquire(exclusive: boolean, signal?: AbortSignal) {
    return new Promise<() => void>((resolve, reject) => {
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        if (exclusive) this.exclusive = false; else this.shared--;
        this.pump();
      };
      const abort = () => {
        const index = this.queue.indexOf(entry);
        if (index < 0) return;
        this.queue.splice(index, 1);
        this.pump();
        reject(fail("cancelled", "The run stopped before the service page became available", "Inspect the resulting state before retrying."));
      };
      const entry = { exclusive, start: () => { signal?.removeEventListener("abort", abort); resolve(release); } };
      if (signal?.aborted) { reject(fail("cancelled", "The run stopped before the service page became available", "Inspect the resulting state before retrying.")); return; }
      signal?.addEventListener("abort", abort, { once: true });
      this.queue.push(entry);
      this.pump();
    });
  }

  private pump() {
    while (this.queue.length) {
      const head = this.queue[0]!;
      if (head.exclusive) {
        if (this.shared || this.exclusive) return;
        this.exclusive = true;
        this.queue.shift();
        head.start();
        return;
      }
      if (this.exclusive) return;
      this.shared++;
      this.queue.shift();
      head.start();
    }
  }
}

export class WebRuntime {
  private context: VMContext;
  private runtime?: Promise<string>;
  private pages = new Map<string, ServicePage>();
  private opening = new Map<string, Promise<ServicePage>>();

  constructor(context: VMContext) { this.context = context; }

  private runtimeSource() {
    this.runtime ??= readFile(join(this.context.paths.bundled, "..", "..", "Host", "Services", "Web", "ServiceActionRuntime.js"), "utf8").catch(error => {
      this.runtime = undefined;
      throw fail("operation_failed", `The service page runtime is unavailable: ${describe(error)}`, "Reinstall the Host files, then retry.");
    });
    return this.runtime;
  }

  owner(domain: string, session: unknown) {
    const id = isObject(session) && typeof session.id === "string" ? session.id : undefined;
    return id ? `service:${domain}:session:${sha256(id).slice(0, 16)}` : `service:${domain}`;
  }

  find(owner: string) {
    const page = this.pages.get(owner);
    return page && !page.live.page.isClosed() ? page : undefined;
  }

  list(domain?: string) { return [...this.pages.values()].filter(page => !page.live.page.isClosed() && (domain === undefined || page.domain === domain)); }

  async open(snapshot: Snapshot, owner: string, conversationId?: number): Promise<ServicePage> {
    const existing = this.find(owner);
    if (existing && existing.version === snapshot.version) { existing.live.usedAt = Date.now(); return existing; }
    const pending = this.opening.get(owner);
    if (pending) return pending;
    const opening = (async () => {
      if (existing) { this.pages.delete(owner); await existing.live.page.close().catch(() => {}); }
      const script = `if (window.top === window && (location.hostname.toLowerCase() === ${JSON.stringify(snapshot.domain)} || location.hostname.toLowerCase().endsWith(${JSON.stringify(`.${snapshot.domain}`)}))) {\n`
        + `${await this.runtimeSource()}\nwindow.ox = window.__openOxCreateServiceRuntime(${JSON.stringify(snapshot.domain)}, {legacySessionContext:true});\n${snapshot.source}\n}`;
      const live = await this.context.browser.open(owner, snapshot.definition.name, conversationId);
      await live.page.addInitScript({ content: script });
      const page: ServicePage = { owner, domain: snapshot.domain, version: snapshot.version, live, executionURL: null, lane: new Lane() };
      this.pages.set(owner, page);
      live.page.once("close", () => { if (this.pages.get(owner) === page) this.pages.delete(owner); });
      this.context.logs.info("services", `page open domain=${snapshot.domain} owner=${owner}`);
      return page;
    })();
    this.opening.set(owner, opening);
    try { return await opening; } finally { this.opening.delete(owner); }
  }

  async closePage(page: ServicePage) {
    if (this.pages.get(page.owner) === page) this.pages.delete(page.owner);
    await page.live.page.close().catch(() => {});
  }

  async closeDomain(domain: string, wait = true) {
    for (const page of this.list(domain)) {
      if (wait) {
        const release = await withTimeout(page.lane.acquire(true), 30_000, () => evalError.timeout(30)).catch(() => undefined);
        await this.closePage(page);
        release?.();
      } else await this.closePage(page);
    }
    await this.context.browser.closeOwner(`service:${domain}`);
  }

  private needsNavigation(page: ServicePage, target: string) {
    return page.executionURL !== target || !serviceHost(hostOf(page.live.page.url()), page.domain);
  }

  async probe(page: ServicePage) {
    try {
      const raw = await withTimeout(page.live.page.evaluate(() => {
        const ox = (window as unknown as { ox?: { callServiceAction?: unknown; status?: () => { state: string; error: string | null } } }).ox;
        return { dispatcher: typeof ox?.callServiceAction === "function", runtime: typeof ox?.status === "function" ? ox.status() : null };
      }), 5_000, () => evalError.timeout(5));
      return { ready: raw.dispatcher && raw.runtime?.state === "ready", detail: raw.runtime?.error ?? (raw.runtime ? `installation ${raw.runtime.state}` : "the page runtime is missing") };
    } catch (error) { return { ready: false, detail: playwrightMessage(error) }; }
  }

  async navigate(page: ServicePage, target: string, signal?: AbortSignal) {
    const browserPage = page.live.page;
    try { await withTimeout(browserPage.goto(target, { waitUntil: "load", timeout: 15_000 }), 16_000, () => evalError.navigationTimeout(15), signal); }
    catch (error) {
      if (error instanceof OxError) throw error;
      if (browserPage.isClosed()) throw evalError.notActive();
      const message = playwrightMessage(error);
      if (/Timeout \d+ms exceeded/i.test(message)) throw evalError.navigationTimeout(15);
      throw evalError.navigationFailed(message);
    }
    await sleep(400);
    if (browserPage.isClosed()) throw evalError.notActive();
    if (!serviceHost(hostOf(browserPage.url()), page.domain)) { page.executionURL = target; return; }
    const probe = await this.probe(page);
    if (!probe.ready) {
      this.context.logs.error("services", `dispatcher unavailable domain=${page.domain} owner=${page.owner} detail=${probe.detail.slice(0, 300)}`);
      throw evalError.notReady(probe.detail);
    }
    page.executionURL = target;
  }

  async run<T>(page: ServicePage, options: { exclusive: boolean; destination?: string; signal?: AbortSignal }, work: (page: ServicePage) => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const exclusive = options.exclusive || attempt > 0 || (options.destination !== undefined && this.needsNavigation(page, options.destination));
      const release = await page.lane.acquire(exclusive, options.signal);
      try {
        if (page.live.page.isClosed()) throw evalError.notActive();
        page.live.usedAt = Date.now();
        if (options.destination !== undefined) {
          if (this.needsNavigation(page, options.destination)) {
            if (!exclusive) continue;
            await this.navigate(page, options.destination, options.signal);
          } else if (!(await this.probe(page)).ready) {
            if (!exclusive) continue;
            await page.live.page.waitForLoadState("load", { timeout: 15_000 }).catch(() => {});
            await sleep(400);
            if (!(await this.probe(page)).ready) await this.navigate(page, options.destination, options.signal);
          }
        }
        return await work(page);
      } finally { release(); }
    }
    throw evalError.notReady();
  }

  async call(page: ServicePage, actionId: string, args: unknown, session: unknown, signal?: AbortSignal) {
    try {
      const value = await withTimeout(page.live.page.evaluate(([id, input, selected]) => {
        const ox = (window as unknown as { ox?: { callServiceAction(id: string, args: unknown, context: unknown): Promise<unknown> } }).ox;
        if (!ox) throw new Error("service action dispatcher is unavailable");
        return ox.callServiceAction(id, input, { session: selected });
      }, [actionId, args, session ?? null] as [string, unknown, unknown]), 30_000, () => evalError.timeout(30), signal);
      return value === undefined ? null : clone(value);
    } catch (error) {
      if (error instanceof OxError) throw error;
      const message = playwrightMessage(error);
      if (page.live.page.isClosed() || contextLost.test(message)) throw evalError.contextInvalidated();
      throw evalError.js(message);
    }
  }

  async selectSession(o: WebInvocation, action: ActionDef) {
    const definition = o.snapshot.definition;
    if (!sessionsEnabled(definition) || action.id === "listSessions" || action.id === "login") return o.session ?? undefined;
    let selected = o.session ?? undefined;
    if (selected == null) {
      const discovered = await this.invoke({ ...o, actionId: "listSessions", args: {}, session: undefined, owned: undefined });
      selected = Array.isArray(discovered) ? discovered[0] : undefined;
      this.context.logs.info("services", `session default domain=${definition.domain} action=${action.id} available=${Array.isArray(discovered) ? discovered.length : 0} selected=${selected != null}`);
    }
    if (action.requireAuth && selected == null) {
      throw fail("authentication_required", "No logged-in session was selected or discovered. No action was executed.",
        "Invoke the website's standard login action if needed, or listSessions to inspect available accounts. pageUrl does not select an authenticated session. Never fabricate a descriptor or automatically replay writes.");
    }
    return selected;
  }

  async invoke(o: WebInvocation): Promise<unknown> {
    const definition = o.snapshot.definition, name = qualifiedName(definition, o.actionId);
    const action = findAction(definition, o.actionId, true);
    if (!action) throw invokeError.unknown(name);
    const inputIssues = violations(o.args, action.inputSchema, definition.defs);
    if (inputIssues.length) throw invokeError.invalidInput(name, inputIssues);
    const base = resolvedBaseURL(definition, action, o.args);
    if (!base) throw invokeError.invalidContract(name);
    const defaultURL = normalizedURL(base);
    executionURL(definition, defaultURL, o.session, o.pageURL);
    if ((o.actionId !== "conversation" || o.args.operation === "submit") && !(await o.approve(name, o.args))) throw invokeError.denied(name);
    let selected: unknown;
    if (o.owned) {
      selected = o.session ?? undefined;
      if (sessionsEnabled(definition) && action.requireAuth && selected == null) throw invokeError.requiresAuth(name);
    } else selected = await this.selectSession(o, action);
    const target = executionURL(definition, defaultURL, selected, o.pageURL);
    const page = o.owned ?? await this.open(o.snapshot, this.owner(definition.domain, selected));
    return this.run(page, { exclusive: action.blocking || o.actionId === "login", ...(o.owned ? {} : { destination: target }), ...(o.signal ? { signal: o.signal } : {}) }, async page => {
      if (!serviceHost(hostOf(page.live.page.url()), definition.domain)) throw evalError.offDomain();
      if (selected != null && sessionsEnabled(definition) && o.actionId !== "login" && o.actionId !== "listSessions") {
        const list = qualifiedName(definition, "listSessions");
        if (!(await o.approve(list, {}))) throw invokeError.denied(list);
        const sessions = await this.call(page, "listSessions", {}, selected, o.signal);
        validateSessions(sessions, definition.domain);
        if (!(sessions as unknown[]).some(session => same(session, selected))) {
          throw fail("authentication_required", "The selected logged-in session is no longer available. No action was executed.",
            "Invoke listSessions to rediscover sessions and select the intended account, or login if needed. Do not silently switch accounts or automatically replay writes.");
        }
      }
      page.lastInvocation = { id: crypto.randomUUID(), actionId: o.actionId, args: clone(o.args), requestedSession: o.session ?? null, pageURL: o.pageURL ?? null,
        selectedSession: selected ?? null, startedAt: Date.now() };
      let value: unknown;
      try { value = await this.call(page, o.actionId, o.args, selected, o.signal); }
      catch (error) {
        if (o.actionId === "login" && sessionsEnabled(definition) && error instanceof OxError && error.message === evalError.contextInvalidated().message) return null;
        throw error;
      }
      if (sessionsEnabled(definition) && o.actionId === "listSessions") validateSessions(value, definition.domain);
      const outputIssues = violations(value, action.outputSchema, definition.defs);
      if (outputIssues.length) throw invokeError.invalidOutput(name, outputIssues);
      return value;
    });
  }

  async presentLogin(o: WebInvocation, interact: (page: ServicePage) => Promise<boolean>) {
    const definition = o.snapshot.definition;
    const page = this.find(this.owner(definition.domain, o.session));
    if (!page) throw pageUnavailable("Login preparation has no idle live page.", "Inspect the page and preparation failure before retrying login.");
    const release = await page.lane.acquire(true, o.signal);
    try {
      if (!page.live.page.url()) throw evalError.notReady();
      this.context.logs.info("services", `login presenting domain=${definition.domain} owner=${page.owner}`);
      const completed = await interact(page);
      if (!completed || page.live.page.isClosed()) {
        throw handoffIncomplete("Login interaction was cancelled or unavailable.", "Do not reopen automatically. Ask the user whether to continue; the page is preserved.");
      }
      if (!serviceHost(hostOf(page.live.page.url()), definition.domain)) {
        await page.live.page.waitForLoadState("load", { timeout: 15_000 }).catch(() => {});
        const login = findAction(definition, "login", true)!;
        const target = executionURL(definition, normalizedURL(resolvedBaseURL(definition, login, o.args)!), o.session, o.pageURL);
        try { await this.navigate(page, target, o.signal); }
        catch { throw pageUnavailable("The login interaction finished, but its target page could not be resumed.", "Inspect the preserved page. Do not assume authentication succeeded or repeat a mutation."); }
      }
      this.context.logs.info("services", `login acknowledged domain=${definition.domain} verified=false`);
    } finally { release(); }
  }

  async showPage(snapshot: Snapshot, actionId: string, input: unknown, session: unknown, pageURL: string | null, signal: AbortSignal | undefined, present: (page: ServicePage) => Promise<void>) {
    const page = this.list(snapshot.domain).filter(page => page.lastInvocation && page.lastInvocation.actionId === actionId && same(page.lastInvocation.args, input)
      && same(page.lastInvocation.requestedSession, session ?? null) && page.lastInvocation.pageURL === (pageURL ?? null))
      .sort((a, b) => b.lastInvocation!.startedAt - a.lastInvocation!.startedAt)[0];
    if (!page) {
      throw pageUnavailable("ox.service.showPage: this action has no idle live page.",
        "Wait for active actions to finish. Use the name and input of the action whose page you want to show. This function never opens a replacement page or reruns the action.");
    }
    const prepared = page.lastInvocation!.id;
    const release = await page.lane.acquire(true, signal);
    try {
      if (page.live.page.isClosed() || page.lastInvocation?.id !== prepared) {
        throw pageUnavailable("The prepared page changed before presentation.", "Inspect the current page state. Do not rediscover a different account or repeat a mutation to replace the page.");
      }
      if (!page.live.page.url()) throw evalError.notReady();
      await present(page);
    } finally { release(); }
  }

  async openHome(snapshot: Snapshot) {
    const definition = snapshot.definition;
    const page = await this.open(snapshot, this.owner(definition.domain, undefined));
    try { await this.run(page, { exclusive: true, destination: normalizedURL(definition.baseUrl!) }, async () => {}); }
    catch (error) {
      this.context.logs.warning("services", `page preparation failed domain=${definition.domain}: ${describe(error)}`);
      if (page.live.page.isClosed()) throw error;
    }
    return page;
  }

  async openLogin(snapshot: Snapshot) {
    const definition = snapshot.definition;
    const page = await this.open(snapshot, this.owner(definition.domain, undefined));
    const login = sessionsEnabled(definition) ? findAction(definition, "login", true) : undefined;
    const target = normalizedURL(login ? resolvedBaseURL(definition, login, {}) ?? definition.baseUrl! : definition.baseUrl!);
    try {
      await this.run(page, { exclusive: true, destination: target }, async page => {
        if (!login || !serviceHost(hostOf(page.live.page.url()), definition.domain)) return;
        page.lastInvocation = { id: crypto.randomUUID(), actionId: "login", args: {}, requestedSession: null, pageURL: null, selectedSession: null, startedAt: Date.now() };
        await this.call(page, "login", {}, null).catch(error => {
          if (!(error instanceof OxError && error.message === evalError.contextInvalidated().message)) throw error;
        });
      });
    } catch (error) {
      this.context.logs.warning("services", `login preparation failed domain=${definition.domain}: ${describe(error)}`);
      if (page.live.page.isClosed()) throw error;
    }
    return page;
  }

  async stage(page: ServicePage, files: StagedFile[]) {
    const target = page.live.page;
    await target.evaluate(() => { (window as unknown as { __oxWebsiteFiles: File[] }).__oxWebsiteFiles = []; });
    for (const file of files) {
      await target.evaluate(() => { (window as unknown as { __oxWebsiteChunks: Uint8Array[] }).__oxWebsiteChunks = []; });
      for (let offset = 0; offset < file.data.length; offset += 256 * 1024) {
        const chunk = Buffer.from(file.data.subarray(offset, offset + 256 * 1024)).toString("base64");
        await target.evaluate(value => {
          (window as unknown as { __oxWebsiteChunks: Uint8Array[] }).__oxWebsiteChunks.push(Uint8Array.from(atob(value), character => character.charCodeAt(0)));
        }, chunk);
      }
      await target.evaluate(([name, mimeType]) => {
        const scope = window as unknown as { __oxWebsiteFiles: File[]; __oxWebsiteChunks?: BlobPart[] };
        scope.__oxWebsiteFiles.push(new File(scope.__oxWebsiteChunks ?? [], name, { type: mimeType }));
        delete scope.__oxWebsiteChunks;
      }, [file.name, file.mimeType] as [string, string]);
    }
  }
}

import { extname } from "node:path";
import type { CDPSession, Disposable, Page } from "playwright-core";
import { OxError, type FunctionCall, type LinuxProfile } from "@openox/agent/linux";
import type { Logger } from "../../logs";
import { browserJobsEnabled, museParityEnabled } from "../../config";
import { botCheck } from "../web/fetch";
import { allowsURL, resolvesPublic } from "../net";
import type { SiteApprovals } from "./approvals";
import type { BrowserManager, LivePage } from "./manager";
import { captureBinding, captureScript, injectedScript, pageStateScript, stopCaptureScript } from "./scripts";
import { registrableSite, siteFor, siteOf } from "./site";
import type { BrowserCapability } from "../permissions";

interface Tab {
  live: LivePage; page: Page; cdp: CDPSession; frame: string; installed: Disposable[]; waiters: Set<() => void>;
  generation: number; loads: number; failures: number; failure?: string; loading: boolean; committed: boolean; insecure: boolean;
}
interface Approval { generation: number; site: string | null }
type CapturedEvent = Record<string, unknown> & { id: string; kind: string; timestamp: number };

const recovery = "Inspect the relevant resource and help before deciding how to proceed. Effects may have occurred; verify state before retrying a write. Do not repeat a cancelled or denied user interaction.";
const disclosure = "Browser can read and act on this site, including logged-in data, and share it with the model. Approve trusts it for this conversation.";
const blocked = "Browser blocked navigation to a private-network, unresolvable, or unsupported destination";
const unreachable = "Browser could not reach this destination; it may be private, unresolvable, or offline";
const reachable = async (url: string) => /^(about|data|blob):/i.test(url) || await resolvesPublic(url);
const navigationTimeout = 15_000;
const secretField = /pass(?:word|code|phrase)|\botp\b|one[- ]?time|verification code|security code|\bcvv\b|\bcvc\b|card ?number|cc-?num|expir/i;
const commitLabel = /\b(?:place (?:my |your |the )?order|buy(?: it)? now|pay(?: now)?|complete (?:my |your |the )?(?:purchase|order|payment|booking)|submit (?:my |your |the )?(?:order|payment)|confirm (?:and pay|purchase|order|booking|payment)|book(?: now)?|reserve|subscribe|send(?! (?:code|link|again))|transfer|donate|delete|remove account|close account|cancel (?:my |your |the )?(?:subscription|membership|autoship|order|plan))\b/i;
const amountLine = /(?:[$€£¥]|US\$|USD|EUR|GBP)\s?\d/;
type TargetSpec = { label: string; role?: string; index?: number };
const humanCheckScript = (act: boolean) => `(${(async (act: boolean) => {
  const human = /\b(i am human|i'?m human|i am not a robot|i'?m not a robot|verify (that )?you are human|verify you'?re human)\b/i;
  const visible = (el: Element) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
  const text = (el: Element) => ((el as HTMLElement).innerText || el.getAttribute("aria-label") || (el as HTMLInputElement).value || "").replace(/\s+/g, " ").trim();
  const boxes = [...document.querySelectorAll('input[type=checkbox],[role=checkbox]')].filter(visible).filter(box => {
    const label = (box as HTMLInputElement).labels?.[0] ?? box.closest("label") ?? box.parentElement;
    return human.test(`${text(box)} ${label ? text(label) : ""}`);
  });
  if (!act) return boxes.length > 0 || human.test(document.body.innerText) && !!document.querySelector("form");
  const box = boxes[0] as HTMLElement | undefined;
  if (!box) return false;
  if (!(box as HTMLInputElement).checked) box.click();
  await new Promise(resolve => setTimeout(resolve, 300));
  const form = box.closest("form") ?? document;
  const go = [...form.querySelectorAll('button,input[type=submit],[role=button]')].filter(visible).find(button => /continue|verify|submit|next|go/i.test(text(button)));
  (go as HTMLElement | undefined)?.click();
  return true;
}).toString()})(${act})`;
type TargetMeta = { count: number; marker?: string; label?: string; role?: string; type?: string; autocomplete?: string; name?: string; id?: string; amounts?: string[] };
const resolveTargetScript = (spec: TargetSpec) => `(${((spec: TargetSpec) => {
  const visible = (el: Element) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden" && !el.closest("[aria-hidden=true],[inert]");
  const text = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();
  const labelOf = (el: Element) => {
    const input = el as HTMLInputElement;
    const labelled = el.getAttribute("aria-labelledby")?.split(/\s+/).map(id => document.getElementById(id)?.textContent ?? "").join(" ");
    return text(el.getAttribute("aria-label")) || text(labelled) || text(input.labels?.[0]?.innerText) || text(el.getAttribute("placeholder"))
      || (el.tagName === "INPUT" && ["submit", "button", "reset"].includes(input.type) ? text(input.value) : "") || text((el as HTMLElement).innerText) || text(el.getAttribute("title")) || text(input.name);
  };
  const roleOf = (el: Element) => {
    const explicit = el.getAttribute("role"); if (explicit) return explicit;
    const input = el as HTMLInputElement;
    if (el.tagName === "A") return "link"; if (el.tagName === "BUTTON" || el.tagName === "SUMMARY") return "button";
    if (el.tagName === "SELECT") return "combobox"; if (el.tagName === "TEXTAREA") return "textbox";
    if (el.tagName === "INPUT") return ["checkbox", "radio"].includes(input.type) ? input.type : ["submit", "button", "reset", "image"].includes(input.type) ? "button" : "textbox";
    return el.tagName.toLowerCase();
  };
  const all = [...document.querySelectorAll('a[href],button,input,select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=menuitem],[role=tab],[role=option],[role=combobox],[role=textbox],[contenteditable="true"]')].filter(visible);
  const want = text(spec.label).toLowerCase();
  let matches = all.filter(el => labelOf(el).toLowerCase() === want);
  if (!matches.length) matches = all.filter(el => labelOf(el).toLowerCase().includes(want));
  if (spec.role) { const role = spec.role.toLowerCase(); matches = matches.filter(el => roleOf(el) === role || el.tagName.toLowerCase() === role); }
  if (!matches.length || matches.length > 1 && !spec.index) return { count: matches.length };
  const el = matches[(spec.index ?? 1) - 1];
  if (!el) return { count: matches.length };
  for (const old of document.querySelectorAll("[data-ox-target]")) old.removeAttribute("data-ox-target");
  const marker = crypto.randomUUID(); el.setAttribute("data-ox-target", marker);
  const input = el as HTMLInputElement;
  return { count: matches.length, marker, label: labelOf(el), role: roleOf(el), type: input.type ?? "", autocomplete: el.getAttribute("autocomplete") ?? "", name: input.name ?? "", id: el.id ?? "",
    amounts: (document.body.innerText ?? "").split("\n").map(text).filter(Boolean) };
}).toString()})(${JSON.stringify(spec)})`;

const pdfLimit = 32 * 1024 * 1024;
const kinds = new Set(["mark", "fetch", "xhr", "form", "resource", "websocket"]);
const texts = ["label", "frameURL", "method", "url", "error", "initiatorType", "event"];
const captureCoverage = "Main-document fetch/XHR hooks, form submissions, resource timing, and WebSocket creation; not a complete network trace. Frame documents, workers, WebSocket messages, and requests bypassing hooks are not inspected. Bodies are bounded and redacted; completeness is unknown.";

class NavigationFailure extends Error {}
const failed = (message: string) => new OxError("operation_failed", message, recovery);
const cancelled = () => new OxError("cancelled", "The operation was cancelled.", "Stop. Do not repeat the operation unless the user asks; inspect any possible effects before retrying a write.");
const invalidated = () => failed("Browser page navigated while the action was running");
const closedDuring = () => failed("Browser page was closed while the action was running");
const describe = (error: unknown) => error instanceof Error ? error.message : String(error);
const firstLine = (error: unknown) => describe(error).split("\n")[0]!.replace(/^(?:page\.|frame\.)?(?:evaluate|goto|reload|goBack|goForward|pdf|waitForEvent): /, "");

function within<T>(work: Promise<T>, milliseconds: number, message: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(failed(message)), milliseconds); })]).finally(() => clearTimeout(timer));
}

function until(tab: Tab, done: () => boolean, milliseconds: number, signal?: AbortSignal) {
  return new Promise<boolean>(resolve => {
    const finish = () => { clearTimeout(timer); tab.waiters.delete(check); signal?.removeEventListener("abort", finish); resolve(done()); };
    const check = () => { if (done() || tab.page.isClosed() || signal?.aborted) finish(); };
    const timer = setTimeout(finish, Math.max(0, milliseconds));
    tab.waiters.add(check);
    signal?.addEventListener("abort", finish, { once: true });
    check();
  });
}

function jsonValue(value: unknown, ancestors: readonly object[] = []): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value + 0 : null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value !== "object" || ancestors.includes(value)) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (value instanceof URL || value instanceof RegExp) return String(value);
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  const nested = [...ancestors, value];
  if (Array.isArray(value) || ArrayBuffer.isView(value)) return Array.from(value as ArrayLike<unknown>, item => jsonValue(item, nested));
  return Object.fromEntries(Object.entries(value).flatMap(([key, item]) => item === undefined || typeof item === "function" || typeof item === "symbol" ? [] : [[key, jsonValue(item, nested)]]));
}

function capturedEvent(fields: Record<string, unknown>) {
  if (typeof fields.kind !== "string" || !kinds.has(fields.kind) || typeof fields.timestamp !== "number" || !Number.isFinite(fields.timestamp)) return undefined;
  const event: Record<string, unknown> & { kind: string; timestamp: number } = { kind: fields.kind, timestamp: fields.timestamp };
  for (const key of texts) if (typeof fields[key] === "string") event[key] = fields[key];
  for (const key of ["durationMs", "started"]) if (typeof fields[key] === "number" && Number.isFinite(fields[key])) event[key] = fields[key];
  if (typeof fields.status === "number" && Number.isInteger(fields.status) && fields.status >= 0) event.status = fields.status;
  for (const key of ["requestHeaders", "responseHeaders"]) {
    const value = fields[key];
    if (value && typeof value === "object" && !Array.isArray(value)) event[key] = Object.fromEntries(Object.entries(value).filter(([, item]) => typeof item === "string"));
  }
  for (const key of ["requestBody", "responseBody"]) if (typeof fields[key] === "string" || fields[key] === null) event[key] = fields[key];
  return event;
}

function bodyShape(body: unknown) {
  const coverage = { status: "unavailable", shapeTruncated: false, bodyCompleteness: "unknown" };
  if (typeof body !== "string") return { shape: null, coverage };
  let value: unknown;
  try { value = JSON.parse(body); }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return { shape: null, coverage: { ...coverage, status: "invalid_json" } };
  }
  let budget = 128;
  const visit = (value: unknown, depth: number): Record<string, unknown> => {
    if (budget <= 0 || depth >= 5) { coverage.shapeTruncated = true; return { type: "uninspected" }; }
    budget -= 1;
    if (Array.isArray(value)) {
      const items: Record<string, unknown>[] = [];
      if (value.length > 5) coverage.shapeTruncated = true;
      for (const item of value.slice(0, 5)) {
        if (budget <= 0) { coverage.shapeTruncated = true; break; }
        const shape = visit(item, depth + 1);
        if (!items.some(item => JSON.stringify(item) === JSON.stringify(shape))) items.push(shape);
      }
      return { type: "array", items };
    }
    if (value !== null && typeof value === "object") {
      const properties: [string, Record<string, unknown>][] = [];
      for (const [key, item] of Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) {
        if (budget <= 0) { coverage.shapeTruncated = true; break; }
        if (key.length > 256) { coverage.shapeTruncated = true; continue; }
        properties.push([key, visit(item, depth + 1)]);
      }
      return { type: "object", properties: Object.fromEntries(properties) };
    }
    return { type: value === null ? "null" : typeof value };
  };
  return { shape: visit(value, 0), coverage: { ...coverage, status: "json" } };
}

const pdfPages = (data: Buffer) => {
  const text = data.toString("latin1");
  return (text.match(/\/Type\s*\/Page(?![A-Za-z])/g) ?? []).length || Math.max(0, ...[...text.matchAll(/\/Count\s+(\d+)/g)].map(match => Number(match[1])));
};

function pdfName(filename: unknown) {
  if (typeof filename !== "string") return "Browser Page.pdf";
  let name = filename.normalize("NFC").split(/[/:\p{Cc}\p{Cf}]/u).join(" ").trim();
  if (!name || name === "." || name === "..") name = "File";
  name = [...name].slice(0, 180).join("");
  return extname(name) ? name : `${name}.pdf`;
}

async function availablePath(profile: LinuxProfile, directory: string, name: string) {
  const extension = extname(name), stem = extension ? name.slice(0, -extension.length) : name;
  for (let index = 1; index < 1_000; index++) {
    const candidate = index === 1 ? name : `${stem} (${index})${extension}`;
    if (/^(conversation\.json|turns\.jsonl)$/i.test(candidate)) continue;
    if (!await profile.statFile(`${directory}/${candidate}`).then(() => true, () => false)) return `${directory}/${candidate}`;
  }
  throw new OxError("already_exists", `Too many files named ${name}`, "Use ox.fs.list on the conversation folder and choose a distinct filename.");
}

export class BrowserSession {
  readonly owner: string;
  private conversationId: number;
  private browser: BrowserManager;
  private approvals: SiteApprovals;
  private logs: Logger;
  private current?: Tab;
  private opening?: Promise<Tab>;
  private queue: Promise<unknown> = Promise.resolve();
  private scripts: { domains: string[]; source: string }[] = [];
  private trusted = new Set<string>();
  private approving = new Map<string, Promise<void>>();
  private capture?: { id: string; includeBodies: boolean };
  private events: CapturedEvent[] = [];
  private captureRevision = crypto.randomUUID();
  private dropped = 0;
  private evicted = 0;
  private closed = false;
  private permissionGeneration = 0;
  private destinationSite: string | null = null;

  private readonly savedLogin: (site: string) => Promise<{ username: string; password: string } | undefined>;
  constructor(conversationId: number, browser: BrowserManager, approvals: SiteApprovals, logs: Logger, savedLogin: (site: string) => Promise<{ username: string; password: string } | undefined> = async () => undefined) {
    this.savedLogin = savedLogin;
    this.conversationId = conversationId;
    this.owner = `browser:${conversationId}`;
    this.browser = browser;
    this.approvals = approvals;
    this.logs = logs;
    if (museParityEnabled()) this.browser.permissionGuard(this.owner, async (url, page) => {
      const current = this.current?.page;
      // Browser jobs: once the user approved the job's site, its pages and their popups load like a normal browser; blocked sites stay blocked.
      if (browserJobsEnabled() && current && !current.isClosed() && this.destinationSite && (page === null || page === current || await page.opener().catch(() => null) === current))
        return !await this.approvals.siteBlocked(siteOf(url));
      return page === current && this.approvals.network(siteOf(url), this.destinationSite);
    });
  }

  private existing() { return this.current && !this.current.page.isClosed() ? this.current : undefined; }

  private frame(call: FunctionCall, tab: Tab) {
    const id = `${tab.live.id}:${tab.generation}`;
    if (call.args.frameId !== undefined && call.args.frameId !== id) {
      throw new OxError("not_supported", "This Browser can target only its current main document.", "Inspect getPageState without frameId and use its current main frame ID; child frames and stale documents are unavailable.");
    }
    return id;
  }

  private async tab() {
    if (this.closed) throw failed("This conversation's Browser is closed");
    const current = this.existing();
    if (current) { current.live.usedAt = Date.now(); return current; }
    this.opening ??= this.attach().finally(() => { this.opening = undefined; });
    return this.opening;
  }

  private async attach() {
    const permissions = this.permissionGeneration;
    const live = await this.browser.open(this.owner, "Browser", this.conversationId);
    const page = live.page;
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Page.enable");
    const { frameTree } = await cdp.send("Page.getFrameTree");
    const tab: Tab = { live, page, cdp, frame: frameTree.frame.id, installed: [], waiters: new Set(), generation: 0, loads: 0, failures: 0, loading: false, committed: true, insecure: false };
    const notify = () => { for (const check of [...tab.waiters]) check(); };
    const fail = (reason: string) => { tab.failure = reason; tab.failures += 1; notify(); };
    cdp.on("Page.frameStartedNavigating", event => {
      if (event.frameId !== tab.frame || event.navigationType === "sameDocument" || event.navigationType === "historySameDocument") return;
      tab.generation += 1;
      tab.loading = true;
      tab.committed = false;
      tab.insecure = false;
      notify();
    });
    cdp.on("Page.frameNavigated", event => { if (event.frame.id === tab.frame) { tab.committed = true; notify(); } });
    cdp.on("Page.frameStoppedLoading", event => { if (event.frameId === tab.frame) { tab.loading = false; notify(); } });
    page.on("load", () => { tab.loads += 1; tab.loading = false; notify(); });
    page.on("request", request => { if (request.url().startsWith("http:")) tab.insecure = true; });
    page.on("websocket", socket => { if (socket.url().startsWith("ws:")) tab.insecure = true; });
    page.on("requestfailed", request => {
      const text = request.failure()?.errorText ?? "navigation failed";
      if (request.isNavigationRequest() && request.frame() === page.mainFrame() && !text.includes("ERR_ABORTED")) fail(text.includes("ERR_BLOCKED_BY_CLIENT") ? blocked : text.includes("ERR_TUNNEL_CONNECTION_FAILED") ? unreachable : text);
    });
    page.on("download", () => fail("navigation became a download"));
    page.on("close", () => { if (this.current === tab) this.current = undefined; notify(); });
    try {
      await this.configure(tab);
      if (museParityEnabled()) await page.routeWebSocket(/.*/, socket => socket.close({ code: 1008, reason: "Model Browser background sockets are unavailable" }));
      if (this.closed || permissions !== this.permissionGeneration) throw failed("This conversation's Browser permission changed");
    } catch (error) {
      await page.close().catch(() => {});
      throw error;
    }
    this.current = tab;
    this.logs.info("browser", `open conversation=${this.conversationId} page=${live.id}`);
    return tab;
  }

  private exclusive<T>(call: FunctionCall, work: () => Promise<T>) {
    const run = this.queue.then(() => {
      if (call.signal.aborted) throw cancelled();
      return work();
    });
    this.queue = run.catch(() => {});
    return run;
  }

  private async perform(tab: Tab, start: (timeout: number) => Promise<unknown>, signal: AbortSignal) {
    const deadline = Date.now() + navigationTimeout, failures = tab.failures, initial = tab.generation;
    const action = start(navigationTimeout).then(() => undefined, (error: unknown) => error ?? new Error("navigation failed"));
    const stopped = until(tab, () => tab.generation > initial && tab.committed && !tab.loading, navigationTimeout, signal).then(() => undefined);
    const error = await Promise.race([action, stopped]);
    if (signal.aborted) throw cancelled();
    if (error && !/interrupted by another navigation/i.test(describe(error))) throw new NavigationFailure(await this.failure(tab, error));
    for (;;) {
      const generation = tab.generation;
      await until(tab, () => tab.generation !== generation, 400, signal);
      if (signal.aborted) throw cancelled();
      if (tab.page.isClosed()) throw new NavigationFailure("Browser page was closed");
      if (tab.failures > failures) throw new NavigationFailure(tab.failure ?? "navigation failed");
      if (tab.generation === generation && !tab.loading) {
        if (!await reachable(tab.page.url())) throw new NavigationFailure(blocked);
        return tab.page.url();
      }
      if (!await until(tab, () => !tab.loading, deadline - Date.now(), signal)) {
        if (signal.aborted) throw cancelled();
        await tab.cdp.send("Page.stopLoading").catch(() => {});
        throw new NavigationFailure(tab.page.isClosed() ? "Browser page was closed" : `navigation timed out after ${navigationTimeout / 1_000} seconds`);
      }
    }
  }

  private async failure(tab: Tab, error: unknown) {
    const message = describe(error);
    if (tab.page.isClosed()) return "Browser page was closed";
    if (error instanceof Error && error.name === "TimeoutError") {
      await tab.cdp.send("Page.stopLoading").catch(() => {});
      return `navigation timed out after ${navigationTimeout / 1_000} seconds`;
    }
    if (/Download is starting/i.test(message)) return "navigation became a download";
    if (message.includes("ERR_BLOCKED_BY_CLIENT")) return blocked;
    if (message.includes("ERR_TUNNEL_CONNECTION_FAILED")) return unreachable;
    return /net::ERR_[A-Z0-9_]+/.exec(message)?.[0] ?? firstLine(error);
  }

  private reloadPage(tab: Tab, signal: AbortSignal) {
    return this.perform(tab, timeout => tab.page.reload({ timeout, waitUntil: "load" }), signal);
  }

  private async reloadOrDiscard(tab: Tab, signal: AbortSignal) {
    try { return await this.reloadPage(tab, signal); }
    catch (error) {
      await this.discard(tab);
      throw error instanceof NavigationFailure ? failed(`Browser navigation failed: ${error.message}`) : error;
    }
  }

  private async discard(tab: Tab) {
    if (this.current === tab) this.current = undefined;
    await tab.page.close().catch(() => {});
  }

  private async evaluate(tab: Tab, expression: string, timeout: number, signal: AbortSignal) {
    if (signal.aborted) throw cancelled();
    const generation = tab.generation;
    let cleanup = () => {};
    const interrupted = new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(failed(`JS eval timed out after ${timeout / 1_000}s`)), timeout);
      const check = () => {
        if (tab.generation !== generation) reject(invalidated());
        else if (tab.page.isClosed()) reject(closedDuring());
      };
      const abort = () => reject(cancelled());
      tab.waiters.add(check);
      signal.addEventListener("abort", abort, { once: true });
      cleanup = () => { clearTimeout(timer); tab.waiters.delete(check); signal.removeEventListener("abort", abort); };
    });
    const evaluation = tab.page.evaluate(expression).catch(error => {
      const message = describe(error);
      if (tab.generation !== generation || /Execution context was destroyed/i.test(message)) throw invalidated();
      if (tab.page.isClosed() || /has been closed/i.test(message)) throw closedDuring();
      throw failed(firstLine(error));
    });
    try { return await Promise.race([evaluation, interrupted]); }
    finally { cleanup(); }
  }

  private async trust(call: FunctionCall, site: string, sourceURL?: string) {
    if (museParityEnabled()) { await this.approvals.capability(call, site, "read", "Share this site's page content with the model.", sourceURL); return; }
    if (this.trusted.has(site)) return;
    let pending = this.approving.get(site);
    if (!pending) {
      pending = this.approve(call, site, sourceURL).finally(() => this.approving.delete(site));
      this.approving.set(site, pending);
    }
    await pending;
  }

  private async approve(call: FunctionCall, site: string, sourceURL?: string) {
    const action = `ox.web.browser:${site}`;
    const purpose = typeof call.args.purpose === "string" ? call.args.purpose : "";
    if (museParityEnabled()) {
      const target = typeof call.args.url === "string" && siteOf(call.args.url) === site ? call.args.url : sourceURL;
      await this.approvals.require(call, site, [purpose, disclosure].filter(Boolean).join("\n"), target);
    } else {
      const policy = await this.approvals.policy(site);
      if (policy === "block") throw new OxError("permission_denied", `${action}: the user blocked this site in Settings.`, "Do not bypass the policy. Ask the user to change it in Settings only if they want to allow this site.");
      if (policy !== "allow") {
        const answer = await call.ask({ kind: "approval", title: `Browser - ${site}`, body: [purpose, disclosure].filter(Boolean).join("\n") });
        if (answer.kind !== "answer") throw new OxError("cancelled", `${action}: the user stopped before answering.`, "Stop. Do not reopen the request unless the user asks.");
        if (answer.text === "Always approve") await this.approvals.allow(site);
        else if (answer.text !== "Approve") throw new OxError("permission_denied", `${action}: the user declined.`, "Stop. Do not repeat the action unless the user asks.");
      }
    }
    this.trusted.add(site);
    this.logs.info("browser", `trust conversation=${this.conversationId} site=${site}`);
  }

  private async authorize(call: FunctionCall, tab: Tab, capability: BrowserCapability = "read"): Promise<Approval> {
    const approval = { generation: tab.generation, site: siteOf(tab.page.url()) };
    if (museParityEnabled()) await this.approvals.capability(call, approval.site, capability,
      capability === "read" ? "Share this site's page content with the model." : `Allow Browser ${capability} on this site?`, tab.page.url());
    else if (approval.site) await this.trust(call, approval.site, tab.page.url());
    await this.approvals.guard(call);
    this.destinationSite = approval.site;
    return approval;
  }

  private unchanged(tab: Tab, approval: Approval) {
    if (tab.page.isClosed()) throw closedDuring();
    if (tab.generation !== approval.generation || siteOf(tab.page.url()) !== approval.site) throw invalidated();
  }

  private async configure(tab: Tab) {
    for (const item of tab.installed.splice(0)) await item.dispose().catch(() => {});
    if (this.capture) {
      const { id, includeBodies } = this.capture;
      tab.installed.push(await tab.page.exposeBinding(captureBinding, (source: { frame: { url(): string } }, value: unknown) => this.receive(source.frame.url(), value)));
      tab.installed.push(await tab.page.addInitScript({ content: captureScript(id, includeBodies) }));
    }
    for (const script of this.scripts) tab.installed.push(await tab.page.addInitScript({ content: injectedScript(script.domains, script.source) }));
  }

  private receive(frameURL: string, value: unknown) {
    const capture = this.capture;
    if (!capture || !value || typeof value !== "object") return;
    let size = Number.POSITIVE_INFINITY;
    try { size = Buffer.byteLength(JSON.stringify(value)); } catch {}
    if (size > 100_000) { this.dropped += 1; return; }
    const fields = value as Record<string, unknown>;
    if (fields.captureID !== capture.id) return;
    const event = capturedEvent(fields);
    if (!event) { this.dropped += 1; return; }
    let host = "";
    try { host = new URL(frameURL).hostname; } catch {}
    this.append({ ...event, id: crypto.randomUUID(), site: host ? siteFor(host) : null });
  }

  private append(event: CapturedEvent) {
    this.events.push(event);
    if (this.events.length <= 500) return;
    const removed = this.events.length - 500;
    this.events.splice(0, removed);
    this.evicted += removed;
  }

  private clearEvents() {
    this.events = [];
    this.captureRevision = crypto.randomUUID();
    this.dropped = 0;
    this.evicted = 0;
  }

  private deactivate(tab: Tab, signal: AbortSignal) {
    return this.evaluate(tab, stopCaptureScript, 5_000, signal).then(value => value === true, () => false);
  }

  navigate(call: FunctionCall) {
    let url: URL | undefined;
    try { url = new URL(String(call.args.url)); } catch {}
    if (!url || !["http:", "https:"].includes(url.protocol) || !url.hostname || !allowsURL(url)) throw failed("ox.web.browser.navigate requires an absolute public HTTP or HTTPS URL.");
    const target = url;
    return this.exclusive(call, async () => {
      if (museParityEnabled()) {
        await this.approvals.blocked(call, "read", siteOf(target.href) ?? undefined, target.href);
        await this.approvals.capability(call, siteOf(target.href), "visit", "Visit this website. Reading or interacting needs its own permission.", target.href);
      }
      if (!await resolvesPublic(target)) throw failed(`ox.web.browser.navigate failed to load the requested URL: ${blocked}`);
      await this.approvals.guard(call);
      const tab = await this.tab();
      this.destinationSite = siteOf(target.href);
      await this.approvals.guard(call);
      this.logs.info("browser", `navigate conversation=${this.conversationId} host=${target.hostname}`);
      try {
        const loaded = await this.perform(tab, timeout => tab.page.goto(target.href, { timeout, waitUntil: "load" }), call.signal);
        if (browserJobsEnabled()) {
          const html = (await tab.page.content().catch(() => "")).slice(0, 20_000);
          if (botCheck.some(pattern => pattern.test(html))) return { url: loaded, blocked: "bot-check" as const };
        }
        return { url: loaded };
      }
      catch (error) { throw error instanceof NavigationFailure ? failed(`ox.web.browser.navigate failed to load the requested URL: ${error.message}`) : error; }
    });
  }

  reload(call: FunctionCall) {
    const fromOrigin = call.args.fromOrigin === true;
    return this.exclusive(call, async () => {
      if (museParityEnabled()) {
        const url = this.existing()?.page.url();
        await this.approvals.blocked(call, "read", url ? siteOf(url) ?? undefined : undefined, url);
        await this.approvals.capability(call, url ? siteOf(url) : null, "visit", "Reload this website.", url);
      }
      const tab = await this.tab().catch(error => { this.logs.warning("browser", `reload unavailable: ${describe(error)}`); return undefined; });
      if (!tab) return { url: null };
      const start = (timeout: number) => fromOrigin
        ? Promise.all([tab.page.waitForEvent("load", { timeout }), tab.cdp.send("Page.reload", { ignoreCache: true })]) : tab.page.reload({ timeout, waitUntil: "load" });
      try { return { url: await this.perform(tab, start, call.signal) }; }
      catch (error) { if (error instanceof NavigationFailure) return { url: null }; throw error; }
    });
  }

  async stopLoading() {
    const tab = await this.tab();
    await tab.cdp.send("Page.stopLoading");
    return { stopped: true, url: tab.page.url() || null };
  }

  traverse(call: FunctionCall, offset: -1 | 1) {
    return this.exclusive(call, async () => {
      const none = { navigated: false, url: null };
      const tab = await this.tab().catch(error => { this.logs.warning("browser", `history unavailable: ${describe(error)}`); return undefined; });
      const history = await tab?.cdp.send("Page.getNavigationHistory").catch(() => undefined);
      if (!tab || !history?.entries[history.currentIndex + offset]) return none;
      if (museParityEnabled()) {
        const url = history.entries[history.currentIndex + offset]!.url;
        await this.approvals.blocked(call, "read", siteOf(url) ?? undefined, url);
        await this.approvals.capability(call, siteOf(url), "visit", "Navigate to this website in Browser history.", url);
        this.destinationSite = siteOf(url);
      }
      try {
        return { navigated: true, url: await this.perform(tab, timeout => offset < 0 ? tab.page.goBack({ timeout, waitUntil: "load" }) : tab.page.goForward({ timeout, waitUntil: "load" }), call.signal) };
      } catch (error) { if (error instanceof NavigationFailure) return none; throw error; }
    });
  }

  async navigationHistory(call: FunctionCall) {
    if (museParityEnabled()) await this.approvals.blocked(call, "read");
    const tab = await this.tab();
    if (museParityEnabled()) await this.authorize(call, tab);
    const { currentIndex, entries } = await tab.cdp.send("Page.getNavigationHistory");
    const item = (entry: { url: string; userTypedURL: string; title: string }) => ({ initialUrl: entry.userTypedURL || entry.url, title: entry.title || null, url: entry.url });
    return { back: entries.slice(0, Math.max(currentIndex, 0)).map(item), current: entries[currentIndex] ? item(entries[currentIndex]) : null, forward: entries.slice(currentIndex + 1).map(item) };
  }

  waitForNavigation(call: FunctionCall) {
    const timeout = typeof call.args.timeoutMs === "number" ? call.args.timeoutMs : 15_000;
    return call.untimed(async () => {
      const tab = await this.tab();
      const loads = tab.loads, failures = tab.failures;
      await until(tab, () => tab.loads > loads || tab.failures > failures, timeout, call.signal);
      if (call.signal.aborted) throw cancelled();
      if (tab.failures > failures) throw failed(`ox.web.browser.waitForNavigation failed: ${tab.failure}`);
      if (tab.loads > loads) return { url: tab.page.url() || null };
      throw failed(tab.page.isClosed() ? "ox.web.browser.waitForNavigation ended before navigation finished." : "ox.web.browser.waitForNavigation timed out.");
    });
  }

  async pageState(call: FunctionCall) {
    const tab = this.existing();
    if (!tab) throw failed("Browser has no open page. Open one with ox.web.browser.navigate first.");
    if (tab.loading && !tab.committed) await until(tab, () => tab.committed || !tab.loading, 3_000, call.signal);
    if (call.signal.aborted) throw cancelled();
    if (tab.page.isClosed()) throw closedDuring();
    if (tab.loading && !tab.committed) throw failed("Browser is still waiting for the next page to respond. Use ox.web.browser.waitForNavigation, then inspect the page again.");
    const frameId = this.frame(call, tab);
    const approval = await this.authorize(call, tab);
    this.unchanged(tab, approval);
    const selector = typeof call.args.selector === "string" ? call.args.selector : null;
    const result = await this.evaluate(tab, pageStateScript(selector), 3_000, call.signal) as { state: { readyState?: unknown }; title: string; fullscreen: boolean };
    this.unchanged(tab, approval);
    const url = tab.page.url(), ready = result.state.readyState;
    return {
      pageID: tab.live.id, navigationGeneration: tab.generation, url: url || null, title: String(result.title ?? ""),
      estimatedProgress: !tab.loading ? 1 : !tab.committed ? 0.1 : ready === "complete" ? 0.9 : ready === "interactive" ? 0.7 : 0.4,
      isLoading: tab.loading, hasOnlySecureContent: url.startsWith("https:") && !tab.insecure, isBlockedByScreenTime: false,
      frameId, frames: [{ id: frameId, parentId: null, origin: new URL(url).origin, isMainFrame: true, serviceID: null, attached: false }],
      framesTruncated: tab.page.frames().length > 1,
      fullscreenState: result.fullscreen ? "inFullscreen" : "notInFullscreen", document: result.state,
    };
  }

  executeScript(call: FunctionCall) {
    const script = String(call.args.script);
    return this.exclusive(call, async () => {
      if (museParityEnabled()) for (const capability of ["read", "interact", "upload", "download"] as const) await this.approvals.blocked(call, capability);
      const tab = await this.tab();
      await until(tab, () => !tab.loading, navigationTimeout, call.signal);
      this.frame(call, tab);
      const approval = await this.authorize(call, tab);
      if (museParityEnabled()) for (const capability of ["interact", "upload", "download"] as const) {
        await this.authorize(call, tab, capability); this.unchanged(tab, approval);
      }
      this.unchanged(tab, approval);
      this.logs.info("browser", `script conversation=${this.conversationId} site=${approval.site ?? "none"} bytes=${Buffer.byteLength(script)}`);
      return jsonValue(await this.evaluate(tab, `(async () => {\n${script}\n})()`, 30_000, call.signal));
    });
  }

  interact(call: FunctionCall) {
    return call.untimed(() => this.exclusive(call, async () => {
      const tab = await this.tab();
      await until(tab, () => !tab.loading, navigationTimeout, call.signal);
      const approval = await this.authorize(call, tab, "interact");
      this.unchanged(tab, approval);
      const action = String(call.args.action), spec = call.args.target as TargetSpec, commits = typeof call.args.commits === "string" ? call.args.commits.trim() : "";
      const meta = await this.evaluate(tab, resolveTargetScript(spec), 5_000, call.signal) as TargetMeta;
      this.unchanged(tab, approval);
      if (!meta.marker) throw new OxError("invalid_argument", meta.count > 1
        ? `${meta.count} controls match "${spec.label}". Add index (1–${meta.count}) or role to choose one.`
        : `No visible control matches "${spec.label}"${spec.index ? ` at index ${spec.index}` : ""}.`, "Inspect the page with ox.web.browser.getPageState and use a listed label.");
      const locator = tab.page.locator(`[data-ox-target="${meta.marker}"]`);
      if ((action === "type" || action === "select") && (meta.type === "password" || /one-time-code|cc-/i.test(meta.autocomplete ?? "")
        || secretField.test(`${meta.name} ${meta.id} ${meta.label}`))) {
        throw new OxError("permission_denied", `"${meta.label}" takes a password, code or payment detail, which the assistant never types.`,
          "Hand the page to the user with ox.web.browser.waitForUserInteraction, or use a saved login if one is available.");
      }
      const committing = (action === "click" || action === "press" && /^enter$/i.test(String(call.args.key ?? ""))) && (!!commits || commitLabel.test(meta.label ?? ""));
      if (committing && this.approvals.searchJob(call)) throw new OxError("permission_denied", `This is a search-only job; it never books, buys or signs in. "${meta.label}" was not clicked.`,
        "Report the results you found and offer booking as a step the user can take.");
      if (committing) {
        const amounts = (meta.amounts ?? []).filter(line => amountLine.test(line)).slice(0, 6);
        const answer = await call.ask({ kind: "approval", title: `Confirm on ${approval.site ?? "this site"}`,
          body: [commits || `Click "${meta.label}"`, ...amounts].join("\n"), options: ["Approve once", "I'll do it myself", "Deny"] });
        if (answer.kind !== "answer") throw cancelled();
        this.logs.info("browser", `commit conversation=${this.conversationId} site=${approval.site ?? "none"} answer=${answer.text}`);
        if (answer.text === "I'll do it myself") {
          const handed = await call.ask({ kind: "page", title: "Browser", body: `Take over: ${commits || meta.label}. Hand back when you're done.`, page: tab.live.id, done: "Hand back" });
          if (handed.kind !== "answer") throw cancelled();
          return { url: tab.page.url(), title: await tab.page.title().catch(() => ""), handedOff: true as const };
        }
        if (answer.text !== "Approve once") throw new OxError("permission_denied", "The user declined this step. Nothing was clicked.", "Stop this step. Do not retry it unless the user asks.");
        this.unchanged(tab, approval);
      }
      const generation = tab.generation;
      const act = () => action === "click" ? locator.click({ timeout: 5_000 }) : action === "type" ? locator.fill(String(call.args.text ?? ""), { timeout: 5_000 })
        : action === "select" ? locator.selectOption({ label: String(call.args.option ?? "") }, { timeout: 5_000 }).then(() => {})
        : action === "press" ? locator.press(String(call.args.key ?? "Enter"), { timeout: 5_000 }) : locator.check({ timeout: 5_000 });
      await act().catch(error => { throw failed(`Browser could not ${action} "${meta.label}": ${firstLine(error)}`); });
      this.logs.info("browser", `interact conversation=${this.conversationId} site=${approval.site ?? "none"} action=${action}${committing ? " committed" : ""}`);
      if (await until(tab, () => tab.generation !== generation, 1_000, call.signal)) await until(tab, () => tab.committed && !tab.loading, navigationTimeout, call.signal);
      return { url: tab.page.url(), title: await tab.page.title().catch(() => "") };
    }));
  }

  signIn(call: FunctionCall) {
    return call.untimed(() => this.exclusive(call, async () => {
      if (this.approvals.searchJob(call)) throw new OxError("permission_denied", "This is a search-only job; it never signs in.", "Report what the public search shows, and say signing in is a step the user can take.");
      const tab = await this.tab();
      await until(tab, () => !tab.loading, navigationTimeout, call.signal);
      const approval = await this.authorize(call, tab, "interact");
      this.unchanged(tab, approval);
      const site = approval.site ?? "this site", shown = new URL(tab.page.url()).host;
      const outcome = async (extra: Record<string, unknown>) => ({ ...extra, url: tab.page.url(), title: await tab.page.title().catch(() => "") });
      const saved = approval.site ? await this.savedLogin(approval.site) : undefined;
      if (saved) {
        const masked = saved.username.replace(/^(.)[^@]*(@.*)?$/, (_, first: string, domain?: string) => `${first}***${domain ?? ""}`);
        const answer = await call.ask({ kind: "approval", title: `Sign in to ${site}`, body: `Use your saved login (${masked}) to sign in to ${site}?`, options: ["Approve once", "Deny"] });
        if (answer.kind !== "answer") throw cancelled();
        if (answer.text === "Approve once") {
          this.unchanged(tab, approval);
          const result = await this.browser.signIn(tab.live, { username: saved.username, password: saved.password }, shown).catch(() => ({ status: "none" as const, filled: [] }));
          this.logs.info("browser", `saved sign-in conversation=${this.conversationId} site=${site} status=${result.status}`);
          if (result.status === "submitted") return outcome({ status: "signedIn", savedLogin: true });
        }
      }
      const handed = await call.ask({ kind: "page", title: `Sign in to ${site}`, body: "Sign in yourself on the page, or let OpenOx sign in for you with a login you type here (it can be saved on this Host for next time). Then choose Hand back.",
        page: tab.live.id, done: "Hand back", login: true, saveLogin: true });
      if (handed.kind !== "answer") throw cancelled();
      this.logs.info("browser", `sign-in handoff conversation=${this.conversationId} site=${site}`);
      return outcome({ status: "handedOff" });
    }));
  }

  humanCheck(call: FunctionCall) {
    return call.untimed(() => this.exclusive(call, async () => {
      const tab = await this.tab();
      await until(tab, () => !tab.loading, navigationTimeout, call.signal);
      const approval = await this.authorize(call, tab, "interact");
      this.unchanged(tab, approval);
      const site = approval.site ?? "this site";
      const outcome = async (status: "passed" | "handedOff") => ({ status, url: tab.page.url(), title: await tab.page.title().catch(() => "") });
      const answer = await call.ask({ kind: "approval", title: `Human check on ${site}`, body: "This site wants to check you're human. OpenOx can try the checkbox for you, or you can do it on the page.",
        options: ["Let OpenOx try", "I'll do it", "Cancel"] });
      if (answer.kind !== "answer" || answer.text === "Cancel") throw cancelled();
      if (answer.text === "Let OpenOx try") {
        const present = () => this.evaluate(tab, humanCheckScript(false), 5_000, call.signal).then(value => value === true, () => false);
        const clicked = await this.evaluate(tab, humanCheckScript(true), 5_000, call.signal).then(value => value === true, () => false);
        if (clicked) {
          await until(tab, () => !tab.loading, navigationTimeout, call.signal);
          await tab.page.waitForTimeout(1_000).catch(() => {});
          await until(tab, () => !tab.loading, navigationTimeout, call.signal);
          if (!await present()) { this.logs.info("browser", `human check passed conversation=${this.conversationId} site=${site}`); return outcome("passed"); }
        }
        this.logs.info("browser", `human check needs the user conversation=${this.conversationId} site=${site}`);
      }
      const handed = await call.ask({ kind: "page", title: `Human check on ${site}`, body: "Complete the human check on the page, then choose Hand back.", page: tab.live.id, done: "Hand back" });
      if (handed.kind !== "answer") throw cancelled();
      return outcome("handedOff");
    }));
  }

  readText(call: FunctionCall) {
    return this.exclusive(call, async () => {
      const tab = await this.tab();
      await until(tab, () => !tab.loading, navigationTimeout, call.signal);
      const approval = await this.authorize(call, tab);
      this.unchanged(tab, approval);
      const selector = typeof call.args.selector === "string" ? call.args.selector : null;
      const value = await this.evaluate(tab, `(sel => { const root = sel ? document.querySelector(sel) : document.body; return root ? root.innerText : null; })(${JSON.stringify(selector)})`, 5_000, call.signal);
      this.unchanged(tab, approval);
      if (typeof value !== "string") throw failed(`No element matches ${selector}.`);
      const text = value.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
      return { url: tab.page.url(), title: await tab.page.title().catch(() => ""), text: text.slice(0, 16_000), truncated: text.length > 16_000 };
    });
  }

  exportPdf(call: FunctionCall) {
    return this.exclusive(call, async () => {
      if (museParityEnabled()) { await this.approvals.blocked(call, "read"); await this.approvals.blocked(call, "download"); }
      const tab = await this.tab();
      await until(tab, () => !tab.loading, navigationTimeout, call.signal);
      const approval = await this.authorize(call, tab);
      if (museParityEnabled()) await this.authorize(call, tab, "download");
      this.unchanged(tab, approval);
      const data = await within(tab.page.pdf({ printBackground: true }), 60_000, "Browser could not export the page within 60 seconds")
        .catch(error => { throw error instanceof OxError ? error : tab.page.isClosed() ? closedDuring() : failed(`Browser could not export the page: ${firstLine(error)}`); });
      this.unchanged(tab, approval);
      if (data.length > pdfLimit) throw new OxError("resource_limit", `PDF too large (${data.length} bytes; limit ${pdfLimit}).`, "Choose a smaller file within the reported size limit.");
      const pages = pdfPages(data);
      if (data.subarray(0, 5).toString("latin1") !== "%PDF-" || pages < 1) throw failed("Browser produced an invalid PDF");
      if (call.signal.aborted) throw cancelled();
      await this.approvals.guard(call);
      const stored = await call.profile.writeFile(await availablePath(call.profile, `conversations/${call.conversationId}`, pdfName(call.args.filename)), data);
      await call.update({ path: stored.path });
      this.logs.info("browser", `pdf conversation=${this.conversationId} pages=${pages} bytes=${data.length}`);
      return { url: tab.page.url() || null, contentType: "application/pdf", pages, bytes: data.length, attached: false, file: stored.name };
    });
  }

  async showPage(call: FunctionCall) {
    if (call.args.instructions !== undefined) throw new OxError("not_supported", "Browser showPage instructions require a native Host on this Linux version.", "Use ox.web.browser.waitForUserInteraction for an explicit human step, or omit instructions to present the page only.");
    const tab = await this.tab();
    await call.update({ page: { id: tab.live.id, title: await tab.page.title().catch(() => "") || "Browser", url: tab.page.url() } });
    return { shown: true };
  }

  waitForUserInteraction(call: FunctionCall) {
    return call.untimed(async () => {
      const tab = await this.exclusive(call, async () => {
        const reload = this.scripts.length > 0, current = this.existing();
        const stopped = this.capture && current ? await this.deactivate(current, call.signal) : true;
        this.capture = undefined;
        this.scripts = [];
        this.clearEvents();
        if (current) {
          await this.configure(current);
          if (reload || !stopped) await this.reloadOrDiscard(current, call.signal);
        }
        return this.tab();
      });
      this.logs.info("browser", `handoff conversation=${this.conversationId} page=${tab.live.id}`);
      const answer = await call.ask({ kind: "page", title: "Browser", body: String(call.args.instructions), page: tab.live.id, done: "Done" });
      if (answer.kind !== "answer") throw cancelled();
      return { completed: true };
    });
  }

  injectScript(call: FunctionCall) {
    if (museParityEnabled()) throw new OxError("not_supported", "Persistent document-start scripts are unavailable with scoped Browser permissions.", "Use an explicitly approved foreground Browser operation. No script was installed.");
    const source = String(call.args.script);
    const domains = (call.args.domains as string[]).map(domain => domain.trim().toLowerCase()).filter(Boolean);
    if (!domains.length || domains.length > 50 || !domains.every(domain => /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(domain)) || Buffer.byteLength(source) > 100_000) {
      throw failed("invalid or excessive document-start script");
    }
    const sites = domains.map(registrableSite);
    if (sites.some(site => !site)) throw failed("document-start script domains must be registrable domains, their subdomains, or IP addresses");
    return this.exclusive(call, async () => {
      if (this.scripts.length >= 20) throw failed("invalid or excessive document-start script");
      for (const site of [...new Set(sites as string[])].sort()) await this.trust(call, site);
      const tab = await this.tab();
      this.scripts.push({ domains: [...new Set(domains)].sort(), source });
      try {
        await this.configure(tab);
        this.logs.info("browser", `scripts conversation=${this.conversationId} count=${this.scripts.length}`);
        return { url: await this.reloadPage(tab, call.signal) };
      } catch (error) {
        this.scripts.pop();
        await this.discard(tab);
        throw error instanceof NavigationFailure ? failed(`Browser navigation failed: ${error.message}`) : error;
      }
    });
  }

  clearScripts(call: FunctionCall) {
    return this.exclusive(call, async () => {
      if (!this.scripts.length) return { url: this.existing()?.page.url() || null };
      const tab = await this.tab();
      this.scripts = [];
      await this.configure(tab);
      this.logs.info("browser", `scripts conversation=${this.conversationId} count=0`);
      return { url: await this.reloadOrDiscard(tab, call.signal) };
    });
  }

  startCapture(call: FunctionCall) {
    const includeBodies = call.args.includeBodies === true, reload = call.args.reload === true;
    return this.exclusive(call, async () => {
      if (museParityEnabled()) await this.approvals.blocked(call, "read");
      const tab = await this.tab();
      if (museParityEnabled()) await this.authorize(call, tab);
      const id = crypto.randomUUID();
      this.clearEvents();
      this.capture = { id, includeBodies };
      try {
        await this.configure(tab);
        this.logs.info("browser", `capture conversation=${this.conversationId} bodies=${includeBodies} reload=${reload}`);
        if (reload) return { active: true, includeBodies, reloaded: true, url: await this.reloadPage(tab, call.signal) };
        await this.evaluate(tab, captureScript(id, includeBodies), 5_000, call.signal);
        return { active: true, includeBodies, reloaded: false, url: tab.page.url() || null };
      } catch (error) {
        const stopped = tab.page.isClosed() || await this.deactivate(tab, AbortSignal.timeout(5_000));
        this.capture = undefined;
        if (!tab.page.isClosed()) await this.configure(tab).catch(() => {});
        if (!stopped) await this.discard(tab);
        throw error instanceof NavigationFailure ? failed(`Browser navigation failed: ${error.message}`) : error;
      }
    });
  }

  markCapture(call: FunctionCall) {
    if (!this.capture) return { marked: false };
    this.append({ id: crypto.randomUUID(), kind: "mark", label: String(call.args.label), timestamp: Date.now() });
    return { marked: true };
  }

  async listCapturedEvents(call: FunctionCall) {
    if (museParityEnabled()) {
      await this.approvals.blocked(call, "read");
      const tab = this.existing();
      if (tab) await this.authorize(call, tab);
      const currentSite = tab ? siteOf(tab.page.url()) : null;
      const sites = new Set(this.events.flatMap(event => typeof event.site === "string" ? [event.site] : []));
      if (!tab && !sites.size) await this.approvals.capability(call, null, "read", "Read recorded Browser metadata.");
      for (const site of sites) if (site !== currentSite) await this.approvals.capability(call, site, "read", "Read recorded Browser metadata from this site.");
      await this.approvals.guard(call);
    }
    const total = this.evicted + this.events.length;
    let offset = this.evicted;
    if (typeof call.args.after === "string") {
      const [revision, position, extra] = call.args.after.split(":");
      offset = Number(position);
      if (extra !== undefined || revision !== this.captureRevision || !/^(0|[1-9]\d*)$/.test(position ?? "") || !Number.isSafeInteger(offset) || offset > total) {
        throw new OxError("invalid_cursor", "The capture cursor is invalid or belongs to an earlier capture.", "List events without after to read the current capture.");
      }
    }
    let origin: string | undefined;
    if (typeof call.args.origin === "string") {
      const value = call.args.origin, url = URL.canParse(value) ? new URL(value) : undefined;
      if (!url || !["http:", "https:", "ws:", "wss:"].includes(url.protocol) || url.username || url.password || url.pathname && url.pathname !== "/" || value.includes("?") || value.includes("#")) {
        throw new OxError("invalid_argument", "Capture origin must be an absolute HTTP(S) or WebSocket origin without credentials, path, query, or fragment.", "Use only the origin, including its non-default port.");
      }
      origin = url.origin;
    }
    const gap = offset < this.evicted;
    offset = Math.max(offset, this.evicted);
    const limit = typeof call.args.limit === "number" ? call.args.limit : 500;
    const kinds = Array.isArray(call.args.kinds) ? new Set<unknown>(call.args.kinds) : undefined;
    const events: Record<string, unknown>[] = [];
    for (let index = offset - this.evicted; index < this.events.length; index++) {
      const event = this.events[index]!;
      const url = typeof event.url === "string" && URL.canParse(event.url) ? new URL(event.url) : undefined;
      if ((!kinds || kinds.has(event.kind)) && (origin === undefined || url?.origin === origin) &&
          (typeof call.args.pathPrefix !== "string" || url?.pathname.startsWith(call.args.pathPrefix))) {
        if (events.length === limit) break;
        const { requestBody: _request, responseBody: _response, ...metadata } = event;
        events.push(metadata);
      }
      offset = this.evicted + index + 1;
    }
    this.logs.info("browser", `captureList conversation=${this.conversationId} returned=${events.length} remaining=${total - offset} gap=${gap}`);
    return { active: !!this.capture, dropped: this.dropped, evicted: this.evicted, events, nextCursor: `${this.captureRevision}:${offset}`,
      hasMore: offset < total, gap, coverage: captureCoverage };
  }

  async readCapturedEvent(call: FunctionCall) {
    if (museParityEnabled()) await this.approvals.blocked(call, "read");
    const event = this.events.find(item => item.id === call.args.id);
    if (!event) throw failed("ox.web.browser.readCapturedEvent requires a valid captured event id.");
    if (museParityEnabled()) {
      const site = typeof event.site === "string" ? event.site : null, url = this.existing()?.page.url();
      await this.approvals.capability(call, site, "read", "Read this recorded Browser event, including its metadata.", url && siteOf(url) === site ? url : undefined);
      await this.approvals.guard(call);
    } else if ((typeof event.requestBody === "string" || typeof event.responseBody === "string") && typeof event.site === "string") await this.trust(call, event.site);
    if (call.args.bodyMode === "shape") {
      const { requestBody, responseBody, ...metadata } = event;
      const request = bodyShape(requestBody), response = bodyShape(responseBody);
      return { ...metadata, requestShape: request.shape, responseShape: response.shape, bodyCoverage: { request: request.coverage, response: response.coverage } };
    }
    return { ...event };
  }

  stopCapture(call: FunctionCall) {
    const discard = call.args.discard === true;
    return this.exclusive(call, async () => {
      const active = !!this.capture, tab = this.existing();
      const stopped = active && tab ? await this.deactivate(tab, call.signal) : true;
      this.capture = undefined;
      if (tab) await this.configure(tab);
      if (discard) this.clearEvents();
      if (!stopped && tab) await this.reloadOrDiscard(tab, call.signal);
      this.logs.info("browser", `capture stopped conversation=${this.conversationId} discard=${discard}`);
      return { stopped: active };
    });
  }

  async close() {
    this.closed = true;
    await this.revoke();
    this.browser.permissionGuard(this.owner);
  }
  async revoke() {
    this.permissionGeneration++;
    this.capture = undefined;
    this.scripts = [];
    this.clearEvents();
    this.trusted.clear();
    this.current = undefined;
    this.destinationSite = null;
    await this.browser.closeOwner(this.owner);
  }
}

import { mkdir } from "node:fs/promises";
import { chromium, type BrowserContext, type CDPSession, type Page, type Route, type WebSocketRoute } from "playwright-core";
import { resolvesPublic } from "../net";
import { EgressProxy } from "./proxy";

export interface LivePage {
  readonly id: string;
  readonly owner: string;
  readonly label: string;
  readonly conversationId?: number;
  readonly page: Page;
  readonly createdAt: number;
  usedAt: number;
}
export interface PageState { id: string; owner: string; label: string; conversationId: number | null; url: string; title: string; viewport: { width: number; height: number } }
export type PageInput =
  | { type: "tap"; x: number; y: number }
  | { type: "scroll"; x: number; y: number; deltaX: number; deltaY: number }
  | { type: "text"; text: string }
  | { type: "key"; key: string }
  | { type: "back" } | { type: "forward" } | { type: "reload" };
export interface Frame { data: string; width: number; height: number }
export interface BrowserOptions { userDataDir: string; onChange(): void; onWarning(message: string): void; headless?: boolean; maxPages?: number }

const allowedSchemes = new Set(["data:", "blob:", "about:"]);
const keys = new Set(["Enter", "Backspace", "Tab", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Delete", "Home", "End", "PageUp", "PageDown"]);
export const defaultViewport = { width: 1280, height: 800 };
const origin = (url: string) => { try { const parsed = new URL(url); return `${parsed.protocol}//${parsed.host}`; } catch { return url.slice(0, url.indexOf(":") + 1) || "invalid URL"; } };

export class BrowserManager {
  private options: BrowserOptions;
  private launching?: Promise<BrowserContext>;
  private pages = new Map<string, LivePage>();
  private closed = false;
  private proxy: EgressProxy;

  constructor(options: BrowserOptions) {
    this.options = options;
    this.proxy = new EgressProxy(target => options.onWarning(`blocked non-public connection ${origin(target.includes("://") ? target : `https://${target}`)}`));
  }

  private async launch() {
    await mkdir(this.options.userDataDir, { recursive: true, mode: 0o700 });
    const launchOptions = {
      channel: "chromium", headless: this.options.headless ?? true, chromiumSandbox: false, viewport: defaultViewport, acceptDownloads: false,
      serviceWorkers: "block" as const, locale: "en-US", ignoreDefaultArgs: ["--enable-automation"], proxy: { server: await this.proxy.url(), bypass: "<-loopback>" },
      args: ["--disable-blink-features=AutomationControlled", "--no-first-run", "--no-default-browser-check", "--disable-features=Translate,MediaRouter",
        "--webrtc-ip-handling-policy=disable_non_proxied_udp"],
    };
    let context = await chromium.launchPersistentContext(this.options.userDataDir, launchOptions);
    const probe = context.pages()[0] ?? await context.newPage();
    const agent = await probe.evaluate(() => navigator.userAgent);
    if (agent.includes("HeadlessChrome")) {
      await context.close();
      context = await chromium.launchPersistentContext(this.options.userDataDir, { ...launchOptions, userAgent: agent.replace("HeadlessChrome", "Chrome") });
    }
    for (const page of context.pages()) await page.close().catch(() => {});
    await context.route("**/*", route => this.guard(route));
    await context.routeWebSocket(/.*/, socket => this.guardSocket(socket));
    context.on("close", () => {
      if (this.launching) this.launching = undefined;
      this.pages.clear();
      this.options.onChange();
    });
    context.on("page", page => this.adopt(page));
    return context;
  }

  private async guard(route: Route) {
    const url = route.request().url();
    const scheme = url.slice(0, url.indexOf(":") + 1).toLowerCase();
    if (allowedSchemes.has(scheme) || await resolvesPublic(url)) return route.fallback();
    this.options.onWarning(`blocked non-public request ${origin(url)}`);
    return route.abort("blockedbyclient");
  }

  private async guardSocket(socket: WebSocketRoute) {
    if (await resolvesPublic(socket.url(), ["ws:", "wss:"])) { socket.connectToServer(); return; }
    this.options.onWarning(`blocked non-public WebSocket ${origin(socket.url())}`);
    await socket.close({ code: 1008, reason: "Blocked by Ox" });
  }

  private adopt(page: Page) {
    void page.opener().then(parent => {
      if (!parent || [...this.pages.values()].some(live => live.page === page)) return;
      const source = [...this.pages.values()].find(live => live.page === parent);
      if (!source) return;
      this.register(page, `${source.owner.split("#")[0]}#popup`, `${source.label} (popup)`, source.conversationId);
    }, () => {});
  }

  private register(page: Page, owner: string, label: string, conversationId?: number) {
    const live: LivePage = { id: crypto.randomUUID(), owner, label, ...(conversationId !== undefined ? { conversationId } : {}), page, createdAt: Date.now(), usedAt: Date.now() };
    this.pages.set(live.id, live);
    page.on("close", () => {
      if (this.pages.get(live.id)?.page === page) { this.pages.delete(live.id); this.options.onChange(); }
    });
    page.on("framenavigated", frame => { if (frame === page.mainFrame()) this.options.onChange(); });
    page.on("dialog", dialog => { void (dialog.type() === "alert" || dialog.type() === "beforeunload" ? dialog.accept() : dialog.dismiss()).catch(() => {}); });
    page.on("crash", () => { this.options.onWarning(`page crashed owner=${owner}`); void page.close().catch(() => {}); });
    this.options.onChange();
    return live;
  }

  async context() {
    if (this.closed) throw new Error("The browser is shutting down");
    this.launching ??= this.launch().catch(error => { this.launching = undefined; throw error; });
    return this.launching;
  }

  async open(owner: string, label: string, conversationId?: number) {
    const existing = this.byOwner(owner);
    if (existing && !existing.page.isClosed()) { existing.usedAt = Date.now(); return existing; }
    const context = await this.context();
    await this.trim();
    const page = await context.newPage();
    return this.register(page, owner, label, conversationId);
  }

  private async trim() {
    const limit = this.options.maxPages ?? 12;
    const pages = [...this.pages.values()].sort((a, b) => a.usedAt - b.usedAt);
    while (pages.length >= limit) await pages.shift()!.page.close().catch(() => {});
  }

  byOwner(owner: string) { return [...this.pages.values()].find(live => live.owner === owner && !live.page.isClosed()); }
  find(id: string) { const live = this.pages.get(id); return live && !live.page.isClosed() ? live : undefined; }
  list() { return [...this.pages.values()].filter(live => !live.page.isClosed()); }
  related(id: string) {
    const live = this.find(id);
    if (!live) return [];
    const root = live.owner.split("#")[0]!;
    return this.list().filter(page => page.owner === root || page.owner.startsWith(`${root}#`));
  }

  async state(live: LivePage): Promise<PageState> {
    const viewport = live.page.viewportSize() ?? defaultViewport;
    return { id: live.id, owner: live.owner, label: live.label, conversationId: live.conversationId ?? null, url: live.page.url(),
      title: await live.page.title().catch(() => ""), viewport };
  }

  async close(id: string) { await this.find(id)?.page.close().catch(() => {}); }
  async closeOwner(prefix: string) {
    for (const live of this.list().filter(page => page.owner === prefix || page.owner.startsWith(`${prefix}#`) || page.owner.startsWith(`${prefix}:`))) await live.page.close().catch(() => {});
  }

  async resize(live: LivePage, size: { width: number; height: number }) {
    const width = Math.round(Math.min(Math.max(size.width, 320), 1600)), height = Math.round(Math.min(Math.max(size.height, 480), 1600));
    const current = live.page.viewportSize();
    if (current?.width !== width || current?.height !== height) await live.page.setViewportSize({ width, height });
  }

  async stream(live: LivePage, onFrame: (frame: Frame) => void) {
    const session: CDPSession = await live.page.context().newCDPSession(live.page);
    session.on("Page.screencastFrame", event => {
      const { data, metadata, sessionId } = event as { data: string; metadata: { deviceWidth: number; deviceHeight: number }; sessionId: number };
      onFrame({ data, width: Math.round(metadata.deviceWidth), height: Math.round(metadata.deviceHeight) });
      void session.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
    });
    const viewport = live.page.viewportSize() ?? defaultViewport;
    await session.send("Page.startScreencast", { format: "jpeg", quality: 70, maxWidth: viewport.width, maxHeight: viewport.height, everyNthFrame: 1 });
    const shot = await live.page.screenshot({ type: "jpeg", quality: 70 }).catch(() => undefined);
    if (shot) onFrame({ data: Buffer.from(shot).toString("base64"), width: viewport.width, height: viewport.height });
    return async () => {
      await session.send("Page.stopScreencast").catch(() => {});
      await session.detach().catch(() => {});
    };
  }

  async input(live: LivePage, input: PageInput) {
    live.usedAt = Date.now();
    const page = live.page, viewport = page.viewportSize() ?? defaultViewport;
    const point = (x: number, y: number) => ({ x: Math.min(Math.max(x, 0), 1) * viewport.width, y: Math.min(Math.max(y, 0), 1) * viewport.height });
    switch (input.type) {
      case "tap": { const { x, y } = point(input.x, input.y); await page.mouse.click(x, y); return; }
      case "scroll": {
        const { x, y } = point(input.x, input.y);
        await page.mouse.move(x, y);
        await page.mouse.wheel(Math.max(Math.min(input.deltaX, 4_000), -4_000), Math.max(Math.min(input.deltaY, 4_000), -4_000));
        return;
      }
      case "text": if (input.text.length > 4_000) throw new Error("Type at most 4,000 characters at a time"); await page.keyboard.insertText(input.text); return;
      case "key": if (!keys.has(input.key)) throw new Error("Unsupported key"); await page.keyboard.press(input.key); return;
      case "back": await page.goBack({ timeout: 15_000 }).catch(() => null); return;
      case "forward": await page.goForward({ timeout: 15_000 }).catch(() => null); return;
      case "reload": await page.reload({ timeout: 15_000 }).catch(() => null); return;
    }
  }

  async shutdown() {
    this.closed = true;
    const launching = this.launching;
    this.launching = undefined;
    if (launching) await (await launching.catch(() => undefined))?.close().catch(() => {});
    await this.proxy.close();
  }
}

import { mkdir } from "node:fs/promises";
import { chromium, type BrowserContext, type CDPSession, type ElementHandle, type Frame as PageFrame, type Page, type Route, type WebSocketRoute } from "playwright-core";
import { resolvesPublic } from "../net";
import { EgressProxy } from "./proxy";
import { registrableSite } from "./site";

export interface LivePage {
  readonly id: string;
  readonly owner: string;
  readonly label: string;
  readonly conversationId?: number;
  readonly page: Page;
  readonly createdAt: number;
  usedAt: number;
  view?: PageView;
}
interface PageView { session: Promise<CDPSession>; serial: Promise<unknown>; mobile: number; touching: boolean; points: Map<number, Contact>; clock: number; last: number }
export interface Contact { id: number; x: number; y: number }
export interface Gesture { kind: "start" | "move" | "end" | "cancel"; points: Contact[]; at: number }
export interface PageState { id: string; owner: string; label: string; conversationId: number | null; url: string; title: string; viewport: { width: number; height: number } }
export type PageInput =
  | { type: "tap"; x: number; y: number }
  | { type: "scroll"; x: number; y: number; deltaX: number; deltaY: number }
  | { type: "touch"; events: Gesture[]; sentAt: number }
  | { type: "text"; text: string }
  | { type: "key"; key: string }
  | { type: "back" } | { type: "forward" } | { type: "reload" };
export interface Frame { data: string; width: number; height: number; scrollX: number; scrollY: number; zoom: number }
export interface SignIn { username?: string; password?: string; code?: string }
export type SignInStatus = "submitted" | "form" | "code" | "none" | "moved";
export interface BrowserOptions { userDataDir: string; onChange(): void; onWarning(message: string): void; headless?: boolean; maxPages?: number }

const allowedSchemes = new Set(["data:", "blob:", "about:"]);
const visible = (selectors: string[]) => selectors.map(selector => `${selector}:visible`).join(", ");
const codeMarks = ['[autocomplete="one-time-code" i]', ...["otp", "2fa", "mfa", "totp", "one-time", "onetime", "verif"].flatMap(word => [`[name*="${word}" i]`, `[id*="${word}" i]`])];
const codeFields = visible(codeMarks.map(mark => `input${mark}`));
const passwordFields = visible([`input[type="password" i]${codeMarks.map(mark => `:not(${mark})`).join("")}`]);
const site = (url: string) => { try { const parsed = new URL(url); return /^https?:$/.test(parsed.protocol) ? registrableSite(parsed.hostname) : undefined; } catch { return undefined; } };
const fingers = (event: Gesture) => event.points.map(point => point.id).sort((a, b) => a - b).join(",");

function thin(events: Gesture[]) {
  const kept: Gesture[] = [];
  let anchor = 0, newest = 0;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!, next = events[index + 1];
    if (event.kind !== "move" || next?.kind !== "move" || fingers(event) !== fingers(next)) { anchor = newest = event.at; kept.push(event); continue; }
    if (newest - event.at > 100 || anchor - event.at < 16) continue;
    anchor = event.at;
    kept.push(event);
  }
  return kept.reverse();
}
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
    const set = async () => {
      const current = live.page.viewportSize();
      if (current?.width !== width || current?.height !== height) await live.page.setViewportSize({ width, height });
    };
    if (!live.view) { await set(); return; }
    await this.chain(live, async (view, session) => { await set(); if (view.mobile) await this.apply(live, view, session, view.mobile); });
  }

  private view(live: LivePage) {
    live.view ??= { session: live.page.context().newCDPSession(live.page), serial: Promise.resolve(), mobile: 0, touching: false, points: new Map(), clock: 0, last: 0 };
    return live.view;
  }

  private chain<T>(live: LivePage, work: (view: PageView, session: CDPSession) => Promise<T>) {
    const view = this.view(live);
    const next = view.serial.then(async () => await work(view, await view.session));
    view.serial = next.catch(() => {});
    return next;
  }

  private async apply(live: LivePage, view: PageView, session: CDPSession, was: number) {
    const size = live.page.viewportSize() ?? defaultViewport;
    if (view.mobile > 0) {
      const metrics = { width: size.width, height: size.height, deviceScaleFactor: 1, mobile: true, screenWidth: size.width, screenHeight: size.height };
      if (!view.touching) { await session.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 10 }); view.touching = true; }
      await session.send("Emulation.setDeviceMetricsOverride", { ...metrics, screenWidth: size.width + 1 });
      await session.send("Emulation.setDeviceMetricsOverride", metrics);
      return;
    }
    if (view.touching) {
      if (view.points.size) { await session.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] }).catch(() => {}); view.points = new Map(); }
      await session.send("Emulation.setTouchEmulationEnabled", { enabled: false });
      view.touching = false;
    }
    if (was > 0) {
      await session.send("Emulation.clearDeviceMetricsOverride");
      await live.page.setViewportSize({ width: size.width, height: size.height + 1 });
      await live.page.setViewportSize(size);
    }
  }

  private emulate(live: LivePage, change: -1 | 0 | 1) {
    return this.chain(live, async (view, session) => {
      const was = view.mobile;
      view.mobile = Math.max(0, view.mobile + change);
      await this.apply(live, view, session, was);
    });
  }

  async snapshot(live: LivePage, options: { quality: number; scale?: "css" | "device"; timeout?: number }) {
    if (!live.view?.mobile) {
      const image = await live.page.screenshot({ type: "jpeg", ...options });
      if (live.view?.mobile) await this.emulate(live, 0).catch(() => {});
      return image;
    }
    const session = await live.view.session;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const shot = await Promise.race([session.send("Page.captureScreenshot", { format: "jpeg", quality: options.quality }) as Promise<{ data: string }>,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("The page did not draw within 10 seconds")), options.timeout ?? 10_000); })])
      .finally(() => clearTimeout(timer));
    return Buffer.from(shot.data, "base64");
  }

  private async zoom(live: LivePage) {
    if (!live.view) return 1;
    const metrics = await (await live.view.session).send("Page.getLayoutMetrics") as { cssVisualViewport?: { scale?: number } };
    return metrics.cssVisualViewport?.scale || 1;
  }

  async stream(live: LivePage, onFrame: (frame: Frame) => void, options: { mobile?: boolean } = {}) {
    const release = async () => { if (!live.page.isClosed() && (options.mobile || live.view?.touching)) await this.emulate(live, options.mobile ? -1 : 0).catch(() => {}); };
    const viewport = live.page.viewportSize() ?? defaultViewport;
    let session: CDPSession | undefined;
    try {
      if (options.mobile) await this.emulate(live, 1);
      const screencast = session = await live.page.context().newCDPSession(live.page);
      screencast.on("Page.screencastFrame", event => {
        const { data, metadata, sessionId } = event as { data: string; sessionId: number;
          metadata: { deviceWidth: number; deviceHeight: number; scrollOffsetX: number; scrollOffsetY: number; pageScaleFactor: number } };
        onFrame({ data, width: Math.round(metadata.deviceWidth), height: Math.round(metadata.deviceHeight), scrollX: Math.round(metadata.scrollOffsetX),
          scrollY: Math.round(metadata.scrollOffsetY), zoom: metadata.pageScaleFactor });
        void screencast.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
      });
      await screencast.send("Page.startScreencast", { format: "jpeg", quality: 70, maxWidth: viewport.width, maxHeight: viewport.height, everyNthFrame: 1 });
    } catch (error) {
      await session?.detach().catch(() => {});
      await release();
      throw error;
    }
    const shot = await this.snapshot(live, { quality: 70 }).catch(() => undefined);
    const metrics = await session.send("Page.getLayoutMetrics").catch(() => undefined) as { cssVisualViewport?: { pageX: number; pageY: number; scale: number } } | undefined;
    if (shot) onFrame({ data: Buffer.from(shot).toString("base64"), width: viewport.width, height: viewport.height, scrollX: Math.round(metrics?.cssVisualViewport?.pageX ?? 0),
      scrollY: Math.round(metrics?.cssVisualViewport?.pageY ?? 0), zoom: metrics?.cssVisualViewport?.scale ?? 1 });
    return async () => {
      await session.send("Page.stopScreencast").catch(() => {});
      await session.detach().catch(() => {});
      await release();
    };
  }

  private touch(live: LivePage, events: Gesture[], sentAt: number) {
    const offset = Date.now() - sentAt;
    return this.chain(live, async (view, session) => {
      if (!view.touching) { await session.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 10 }); view.touching = true; }
      const size = live.page.viewportSize() ?? defaultViewport;
      const dispatch = async (type: "touchStart" | "touchMove" | "touchEnd" | "touchCancel", points: Contact[], at: number) => {
        const scale = points.length ? await this.zoom(live) : 1;
        const touchPoints = points.map(point => ({ id: point.id, x: Math.min(Math.max(point.x, 0), 1) * size.width / scale, y: Math.min(Math.max(point.y, 0), 1) * size.height / scale }));
        view.last = Math.max(at, view.last + 0.001);
        return await session.send("Input.dispatchTouchEvent", { type, touchPoints, timestamp: view.last });
      };
      for (const event of thin(events)) {
        if (!view.points.size) view.clock = Math.max(offset, view.last * 1000 - event.at + 1);
        const at = (event.at + view.clock) / 1000;
        const next = new Map(event.kind === "cancel" ? [] : event.points.map(point => [point.id, point] as const));
        try {
          if (event.kind === "cancel") { if (view.points.size) await dispatch("touchCancel", [], at); }
          else {
            const lifted = [...view.points.values()].filter(point => !next.has(point.id));
            const moved = [...next.values()].filter(point => view.points.has(point.id));
            const added = [...next.values()].filter(point => !view.points.has(point.id));
            if (lifted.length) await dispatch("touchEnd", lifted, at);
            if (moved.length) await dispatch("touchMove", moved, at);
            if (added.length) await dispatch("touchStart", added, at);
          }
        } catch (error) {
          this.options.onWarning(`touch sequence restarted owner=${live.owner}: ${error instanceof Error ? error.message : String(error)}`);
          await dispatch("touchCancel", [], at).catch(() => {});
          view.points = new Map();
          if (next.size) await dispatch("touchStart", [...next.values()], at);
        }
        view.points = next;
      }
    });
  }

  async signIn(live: LivePage, values: SignIn, shown?: string) {
    live.usedAt = Date.now();
    const page = live.page, filled: string[] = [], expected = shown === undefined ? site(page.url()) : site(`https://${shown}`);
    const moved = () => site(page.url()) !== expected;
    const frames = () => { const home = site(page.url()); return home ? page.frames().filter(frame => site(frame.url()) === home) : []; };
    const find = async (selector: string) => {
      for (const frame of frames()) {
        const handle = await frame.$(selector).catch(() => null);
        if (handle) return handle;
      }
      return undefined;
    };
    const fill = async (field: ElementHandle, name: keyof SignIn) => { await field.fill(values[name]!, { timeout: 5_000 }); filled.push(name); };
    const settle = async () => {
      await page.waitForEvent("framenavigated", { timeout: 2_000 }).catch(() => {});
      await page.waitForLoadState("load", { timeout: 10_000 }).catch(() => {});
      await page.waitForTimeout(300).catch(() => {});
    };
    const outcome = async (): Promise<SignInStatus> => {
      await settle();
      if (await find(passwordFields)) return "form";
      return await find(codeFields) ? "code" : "submitted";
    };
    const finish = (status: SignInStatus) => ({ status, filled });
    if (moved()) return finish("moved");
    if (values.code) {
      const field = await find(codeFields);
      if (!field) return finish("none");
      await fill(field, "code");
      await field.press("Enter", { timeout: 5_000 });
      return finish(await outcome());
    }
    let password = await find(passwordFields);
    if (!password) {
      const user = await this.loginField(frames());
      if (!user || !values.username) return finish("none");
      await fill(user, "username");
      await user.press("Enter", { timeout: 5_000 });
      for (let waited = 0; !password && waited < 8_000; waited += 250) {
        await page.waitForTimeout(250).catch(() => {});
        password = await find(passwordFields);
      }
      if (!password || !values.password) return finish(await outcome());
      if (moved()) return finish("moved");
    } else if (values.username) {
      const user = (await password.evaluateHandle(field => {
        const input = field as HTMLInputElement, scope = input.form ?? input.ownerDocument;
        const text = [...scope.querySelectorAll("input")].filter(candidate => ["text", "email", "tel"].includes(candidate.type) && candidate.getClientRects().length > 0
          && !candidate.disabled && !candidate.readOnly && candidate.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING);
        return text.at(-1) ?? null;
      })).asElement() as ElementHandle<HTMLInputElement> | null;
      if (user) await fill(user, "username");
    }
    if (!values.password) return finish("form");
    await fill(password, "password");
    await password.press("Enter", { timeout: 5_000 });
    return finish(await outcome());
  }

  private async loginField(frames: PageFrame[]) {
    for (const frame of frames) {
      const handle = await frame.evaluateHandle(() => {
        const label = (control: Element) => ((control as HTMLElement).innerText || (control as HTMLInputElement).value || "").trim();
        const signal = (form: HTMLFormElement | null) => !!form && (!!form.querySelector('input[type="password" i]')
          || [...form.querySelectorAll('button, input[type="submit" i], input[type="button" i]')].some(control => /sign\s*in|log\s*in|login|next|continue|登录|下一步|继续/i.test(label(control))));
        const inputs = [...document.querySelectorAll("input")].filter(input => ["text", "email", "tel"].includes(input.type) && input.getClientRects().length > 0 && !input.disabled && !input.readOnly);
        return inputs.find(input => input.autocomplete.split(/\s+/).includes("username"))
          ?? inputs.find(input => (input.type === "email" || /user|login|email|account|identifier/i.test(`${input.name} ${input.id}`)) && signal(input.form)) ?? null;
      }).catch(() => null);
      const element = handle?.asElement();
      if (element) return element as ElementHandle<HTMLInputElement>;
    }
    return undefined;
  }

  async input(live: LivePage, input: PageInput) {
    live.usedAt = Date.now();
    if (input.type === "touch") { await this.touch(live, input.events, input.sentAt); return; }
    const page = live.page, viewport = page.viewportSize() ?? defaultViewport, scale = input.type === "tap" || input.type === "scroll" ? await this.zoom(live) : 1;
    const point = (x: number, y: number) => ({ x: Math.min(Math.max(x, 0), 1) * viewport.width / scale, y: Math.min(Math.max(y, 0), 1) * viewport.height / scale });
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

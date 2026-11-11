import { createHash } from "node:crypto";
import { readJSON, writeJSON } from "./config";
import { HTTPError } from "./http";
import type { Logger } from "./logs";
import { createPushKeys, sendPush, validClientKeys, type PushKeys, type PushTarget } from "./push";

export type NoticeLanguage = "en" | "zh-Hans";
export type NoticeText = "finished" | "approval" | "input" | "login";
export interface Notice {
  tag: string;
  url: string;
  urgency: "normal" | "high";
  title(language: NoticeLanguage): string;
  body(language: NoticeLanguage): string;
}
interface Subscription extends PushTarget { language: NoticeLanguage }
interface PushFile { format: 1; keys?: PushKeys; devices: Record<string, Subscription> }

const texts: Record<NoticeLanguage, Record<NoticeText, string> & { attention(name: string): string }> = {
  en: { finished: "Your conversation finished while you were away.", approval: "Ox needs your approval", input: "Ox needs your input", login: "Log in to continue",
    attention: name => `${name} needs attention` },
  "zh-Hans": { finished: "你离开时，对话已完成。", approval: "Ox 需要你的批准", input: "Ox 需要你的输入", login: "登录以继续",
    attention: name => `“${name}”需要你处理` },
};
export const noticeText = (language: NoticeLanguage, key: NoticeText) => texts[language][key];
export const attentionTitle = (language: NoticeLanguage, name: string) => texts[language].attention(name);

const services = [/^fcm\.googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /^web\.push\.apple\.com$/, /(^|\.)notify\.windows\.com$/];
const describe = (error: unknown) => error instanceof Error ? error.message : String(error);
const clip = (text: string, limit: number) => { const characters = Array.from(text); return characters.length > limit ? `${characters.slice(0, limit - 1).join("").trimEnd()}…` : text; };

export function preview(text: string) {
  const plain = text.replace(/```[^\n]*\n?/g, "").replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[`*_~#>|]+/g, "").replace(/\s+/g, " ").trim();
  return plain.length > 180 ? `${plain.slice(0, 179).trimEnd()}…` : plain;
}

export class Notifications {
  private file: PushFile = { format: 1, devices: {} };
  private tabs = new Map<string, Map<string, { visible: boolean; stream: symbol }>>();
  private tail: Promise<unknown> = Promise.resolve();
  private keys!: PushKeys;
  private path: string;
  private logs: Logger;
  private testOrigins: readonly string[];

  private constructor(path: string, logs: Logger, testOrigins: readonly string[]) {
    this.path = path;
    this.logs = logs;
    this.testOrigins = testOrigins;
  }

  static async open(path: string, logs: Logger, testOrigins: readonly string[] = []) {
    const notifications = new Notifications(path, logs, testOrigins);
    const stored = await readJSON<Partial<PushFile>>(path, {});
    notifications.file = { format: 1, ...(stored.keys ? { keys: stored.keys } : {}), devices: stored.devices ?? {} };
    if (!notifications.file.keys) {
      notifications.file.keys = await createPushKeys();
      await writeJSON(path, notifications.file);
    }
    notifications.keys = notifications.file.keys!;
    return notifications;
  }

  get publicKey() { return this.keys.publicKey; }
  subscribed(device: string) { return !!this.file.devices[device]; }

  private change(update: (devices: Record<string, Subscription>) => void) {
    const next = this.tail.then(async () => {
      const devices = { ...this.file.devices };
      update(devices);
      const file = { ...this.file, devices };
      await writeJSON(this.path, file);
      this.file = file;
    });
    this.tail = next.catch(() => {});
    return next;
  }

  subscribe(device: string, input: unknown, origin: string | null) {
    const value = (input ?? {}) as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown }; language?: unknown };
    let endpoint: URL;
    try { endpoint = new URL(String(value.endpoint)); } catch { throw new HTTPError(400, "Use the browser's push subscription"); }
    const known = endpoint.protocol === "https:" && !endpoint.username && !endpoint.password && !endpoint.port && services.some(service => service.test(endpoint.hostname));
    if (!known && !this.testOrigins.includes(endpoint.origin)) throw new HTTPError(400, "Use the browser's push subscription");
    if (endpoint.href.length > 2_048 || !validClientKeys(value.keys?.p256dh, value.keys?.auth)) throw new HTTPError(400, "Use the browser's push subscription");
    const subscription: Subscription = { endpoint: endpoint.href, p256dh: value.keys!.p256dh as string, auth: value.keys!.auth as string,
      language: value.language === "zh-Hans" || value.language === "en" ? value.language : this.file.devices[device]?.language ?? "en", subject: origin?.startsWith("https://") ? origin : "mailto:openox-host@users.noreply.github.com" };
    return this.change(devices => { devices[device] = subscription; });
  }

  unsubscribe(device: string, endpoint?: string) {
    return this.change(devices => { if (!endpoint || devices[device]?.endpoint === endpoint) delete devices[device]; });
  }

  keep(existing: ReadonlySet<string>) {
    if (Object.keys(this.file.devices).every(device => existing.has(device))) return Promise.resolve();
    return this.change(devices => { for (const device of Object.keys(devices)) if (!existing.has(device)) delete devices[device]; });
  }

  connect(device: string, tab: string, visible: boolean) {
    const stream = Symbol(tab);
    const tabs = this.tabs.get(device) ?? new Map<string, { visible: boolean; stream: symbol }>();
    tabs.set(tab, { visible, stream });
    this.tabs.set(device, tabs);
    return () => {
      if (tabs.get(tab)?.stream !== stream) return;
      tabs.delete(tab);
      if (!tabs.size && this.tabs.get(device) === tabs) this.tabs.delete(device);
    };
  }

  present(device: string, tab: string, visible: boolean) {
    const entry = this.tabs.get(device)?.get(tab);
    if (entry) entry.visible = visible;
  }

  visible(device: string) { return [...this.tabs.get(device)?.values() ?? []].some(entry => entry.visible); }
  webSessions(device: string) { return this.tabs.get(device)?.size ?? 0; }

  notify(notice: Notice) {
    for (const [device, subscription] of Object.entries(this.file.devices)) {
      if (this.visible(device)) continue;
      void this.deliver(device, subscription, notice);
    }
  }

  private async deliver(device: string, subscription: Subscription, notice: Notice) {
    const service = new URL(subscription.endpoint).host;
    try {
      const status = await sendPush(subscription, this.keys, { ttl: 86_400, urgency: notice.urgency, topic: createHash("sha256").update(notice.tag).digest("base64url").slice(0, 32),
        payload: { title: clip(notice.title(subscription.language), 120), body: clip(notice.body(subscription.language), 600), tag: notice.tag, url: notice.url } });
      if (status === 404 || status === 410) {
        await this.unsubscribe(device, subscription.endpoint);
        this.logs.info("notifications", `subscription ended device=${device} service=${service}`);
      } else if (status >= 400) this.logs.warning("notifications", `push refused device=${device} service=${service} status=${status}`);
      else this.logs.info("notifications", `push sent device=${device} service=${service} tag=${notice.tag}`);
    } catch (error) { this.logs.warning("notifications", `push failed device=${device} service=${service}: ${describe(error)}`); }
  }
}

import type { InboxDraft, InboxStore, PushResult } from "@openox/agent/linux";
import type { Logger } from "./logs";
import { Notifications, preview, type Notice } from "./notifications";

const describe = (error: unknown) => error instanceof Error ? error.message : String(error);
export class Inbox {
  private tail: Promise<void> = Promise.resolve();
  private writes: Promise<void> = Promise.resolve();
  private readonly abort = new AbortController();
  private closed = false;
  private readonly store: () => InboxStore;
  private readonly push: Notifications;
  private readonly logs: Logger;
  private readonly changed: () => void;
  failure: string | null = null;

  constructor(store: () => InboxStore, push: Notifications, logs: Logger, changed: () => void) {
    this.store = store; this.push = push; this.logs = logs; this.changed = changed;
  }

  report(error: unknown) {
    this.failure = describe(error);
    this.logs.warning("notifications", this.failure);
    this.changed();
  }

  publish(notice: Notice & { id: string }) {
    if (this.closed) return Promise.reject(new Error("The notification inbox is closing."));
    const texts = (field: "title" | "body") => ({ en: preview(notice[field]("en")), "zh-Hans": preview(notice[field]("zh-Hans")) });
    const next = this.writes.then(async () => {
      const draft: InboxDraft = { id: notice.id, tag: notice.tag, targetUrl: notice.url, urgency: notice.urgency,
        title: texts("title"), body: texts("body"), occurredAt: new Date().toISOString() };
      await this.store().enqueue(draft);
      this.changed();
      void this.flush();
    });
    this.writes = next.catch(error => this.report(error));
    return next;
  }

  async start() {
    await this.store().recover();
    void this.flush();
  }

  private flush() {
    const next = this.tail.then(async () => {
      if (this.closed) return;
      const { notifications } = await this.store().list();
      for (const candidate of notifications.reverse()) {
        if (this.closed) return;
        if (candidate.delivery.status !== "pending") continue;
        const notice = await this.store().claim(candidate.id);
        if (!notice) continue;
        const attempts: Record<string, PushResult> = {};
        for (const device of this.push.targets()) {
          if (this.closed) break;
          const current = await this.store().get(notice.id);
          attempts[device] = current.readAt !== null || current.cancelledAt !== null ? { status: "skipped" }
            : await this.push.deliverTo(device, { id: notice.id, tag: notice.tag, url: notice.targetUrl, urgency: notice.urgency,
              title: language => notice.title[language], body: language => notice.body[language] }, this.abort.signal);
        }
        if (this.closed) return;
        await this.store().record(notice.id, attempts);
        this.changed();
      }
    });
    this.tail = next.catch(error => this.report(error));
    return this.tail;
  }

  async close() {
    this.closed = true;
    this.abort.abort();
    await this.writes;
    await this.tail;
  }
}

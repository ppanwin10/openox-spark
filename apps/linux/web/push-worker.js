self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));

self.addEventListener("push", event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch {}
  const title = typeof data.title === "string" && data.title ? data.title : "OpenOx";
  const noticeId = typeof data.noticeId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(data.noticeId) ? data.noticeId : null;
  event.waitUntil((async () => {
    if (noticeId) {
      try {
        const response = await fetch(`/api/notifications/${noticeId}`, { credentials: "same-origin", signal: AbortSignal.timeout(5_000) });
        if ([401, 403, 404].includes(response.status)) return;
        if (response.ok) {
          const current = await response.json();
          if ((current.readAt !== null && typeof current.readAt !== "string") || (current.cancelledAt !== null && typeof current.cancelledAt !== "string")) {
            throw new Error("The Host returned invalid notification state.");
          }
          if (current.readAt !== null || current.cancelledAt !== null) return;
        } else console.warn("Could not verify notification read state", response.status);
      } catch (error) { console.warn("Notification read state is unavailable; showing the received push", error); }
    }
    await self.registration.showNotification(title, {
      body: typeof data.body === "string" ? data.body : "",
      tag: typeof data.tag === "string" ? data.tag : undefined,
      renotify: typeof data.tag === "string",
      data: { url: noticeId ? `/#/inbox/${noticeId}` : typeof data.url === "string" && data.url.startsWith("/") ? data.url : "/",
        ...(noticeId ? { noticeId } : {}) },
    });
  })());
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const url = new URL(event.notification.data?.url ?? "/", self.location.origin);
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const open = windows.find(client => new URL(client.url).origin === url.origin);
    if (open) {
      open.postMessage({ type: "open", hash: url.hash });
      await open.focus().catch(() => {});
      return;
    }
    await self.clients.openWindow(url.href);
  })());
});

self.addEventListener("pushsubscriptionchange", event => {
  event.waitUntil((async () => {
    const options = event.oldSubscription?.options;
    if (!options?.applicationServerKey) return;
    const subscription = event.newSubscription ?? await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: options.applicationServerKey });
    await fetch("/api/push", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(subscription) });
  })());
});

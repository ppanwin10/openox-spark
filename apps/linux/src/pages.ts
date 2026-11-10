import type { Host } from "./host";
import { HTTPError, json, payload } from "./http";
import type { Frame, Gesture, LivePage, PageInput } from "./vm/browser/manager";

const encoder = new TextEncoder();
const finite = (value: unknown) => typeof value === "number" && Number.isFinite(value);

function input(body: Record<string, unknown>): PageInput {
  switch (body.type) {
    case "tap": if (finite(body.x) && finite(body.y)) return { type: "tap", x: body.x as number, y: body.y as number }; break;
    case "scroll":
      if ([body.x, body.y, body.deltaX, body.deltaY].every(finite)) return { type: "scroll", x: body.x as number, y: body.y as number, deltaX: body.deltaX as number, deltaY: body.deltaY as number };
      break;
    case "touch": {
      const events = Array.isArray(body.events) ? body.events as Record<string, unknown>[] : [];
      if (!events.length || events.length > 240 || !finite(body.sentAt)) break;
      const valid = events.every(event => event && ["start", "move", "end", "cancel"].includes(event.kind as string) && finite(event.at) && Array.isArray(event.points)
        && (event.points as Record<string, unknown>[]).length <= 10 && (event.points as Record<string, unknown>[]).every(point => point
          && Number.isInteger(point.id) && (point.id as number) >= 0 && (point.id as number) < 10 && finite(point.x) && finite(point.y))
        && new Set((event.points as Record<string, unknown>[]).map(point => point.id)).size === (event.points as unknown[]).length);
      if (!valid) break;
      return { type: "touch", sentAt: body.sentAt as number, events: events.map(event => ({ kind: event.kind as Gesture["kind"], at: event.at as number,
        points: (event.points as Record<string, number>[]).map(point => ({ id: point.id!, x: point.x!, y: point.y! })) })) };
    }
    case "text": if (typeof body.text === "string" && body.text) return { type: "text", text: body.text }; break;
    case "key": if (typeof body.key === "string") return { type: "key", key: body.key }; break;
    case "back": case "forward": case "reload": return { type: body.type };
  }
  throw new HTTPError(400, "Unsupported page input");
}

function stream(host: Host, request: Request, url: URL, live: LivePage) {
  const width = Number(url.searchParams.get("width")), height = Number(url.searchParams.get("height"));
  const mobile = url.searchParams.get("mobile") === "1";
  let latest: Frame | undefined, wake: (() => void) | undefined, stopped = false, stop: (() => Promise<void>) | undefined;
  const finish = () => {
    if (stopped) return;
    stopped = true;
    live.page.off("close", finish);
    wake?.();
    void stop?.();
  };
  request.signal.addEventListener("abort", finish, { once: true });
  live.page.once("close", finish);
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        if (width > 0 && height > 0) await host.browser.resize(live, { width, height });
        stop = await host.browser.stream(live, frame => { latest = frame; wake?.(); }, { mobile });
        if (stopped) await stop();
        controller.enqueue(encoder.encode("retry: 2000\n\n"));
      } catch (error) {
        host.logs.warning("pages", `stream failed: ${error instanceof Error ? error.message : String(error)}`);
        finish();
      }
    },
    async pull(controller) {
      if (!latest && !stopped) await new Promise<void>(resolve => { wake = resolve; setTimeout(resolve, 15_000); });
      wake = undefined;
      if (stopped) { try { controller.close(); } catch {} return; }
      if (!latest) { controller.enqueue(encoder.encode(": keep-alive\n\n")); return; }
      const frame = latest;
      latest = undefined;
      controller.enqueue(encoder.encode(`event: frame\ndata: ${JSON.stringify(frame)}\n\n`));
    },
    cancel() { finish(); },
  }, { highWaterMark: 1 });
  return new Response(body, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" } });
}

export async function pagesRoute(host: Host, request: Request, url: URL, parts: string[]) {
  const [id, action] = parts;
  if (!id && request.method === "GET") {
    const conversation = url.searchParams.get("conversation");
    const pages = host.browser.list().filter(page => conversation === null || String(page.conversationId) === conversation);
    return json({ pages: await Promise.all(pages.map(page => host.browser.state(page))) });
  }
  const live = id ? host.browser.find(id) : undefined;
  if (!live) throw new HTTPError(404, "This page is no longer open");
  if (!action && request.method === "GET") {
    return json({ page: await host.browser.state(live), related: await Promise.all(host.browser.related(live.id).map(page => host.browser.state(page))) });
  }
  if (action === "stream" && request.method === "GET") return stream(host, request, url, live);
  if (action === "snapshot" && request.method === "GET") {
    const image = await host.browser.snapshot(live, { quality: 55, scale: "css", timeout: 10_000 });
    return new Response(new Uint8Array(image), { headers: { "content-type": "image/jpeg", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
  }
  if (action === "input" && request.method === "POST") {
    await host.browser.input(live, input(await payload<Record<string, unknown>>(request)));
    return json({ ok: true });
  }
  throw new HTTPError(404, "Not found");
}

import type { Host } from "./host";
import { HTTPError, json, payload } from "./http";
import { isPageKey } from "./vm/browser/manager";
import type { Frame, Gesture, LivePage, PageInput, SignIn } from "./vm/browser/manager";

const encoder = new TextEncoder();
const finite = (value: unknown) => typeof value === "number" && Number.isFinite(value);

function input(body: Record<string, unknown>): PageInput {
  switch (body.type) {
    case "tap": if (finite(body.x) && finite(body.y)) return { type: "tap", x: body.x as number, y: body.y as number }; break;
    case "mouse": {
      const mask = body.button === "left" ? 1 : body.button === "right" ? 2 : body.button === "middle" ? 4 : 0;
      const cancelling = body.kind === "cancel", moving = body.kind === "move";
      if (["move", "down", "up", "cancel"].includes(body.kind as string) && [body.x, body.y].every(value => finite(value) && (value as number) >= 0 && (value as number) <= 1)
        && ["none", "left", "middle", "right"].includes(body.button as string) && (moving || cancelling || body.button !== "none")
        && Number.isInteger(body.buttons) && (body.buttons as number) >= 0 && (body.buttons as number) <= 7
        && (moving || (cancelling ? body.buttons === 0 : body.kind === "down" ? !!((body.buttons as number) & mask) : !((body.buttons as number) & mask)))
        && Number.isInteger(body.clicks) && (body.clicks as number) >= (moving || cancelling ? 0 : 1) && (body.clicks as number) <= 3
        && Number.isInteger(body.modifiers) && (body.modifiers as number) >= 0 && (body.modifiers as number) <= 15)
        return { type: "mouse", kind: body.kind as "move" | "down" | "up" | "cancel", x: body.x as number, y: body.y as number,
          button: body.button as "none" | "left" | "middle" | "right", buttons: body.buttons as number, clicks: body.clicks as number, modifiers: body.modifiers as number };
      break;
    }
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
    case "key": if (typeof body.key === "string" && isPageKey(body.key)) return { type: "key", key: body.key }; break;
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
    request.signal.removeEventListener("abort", finish);
    live.page.off("close", finish);
    wake?.();
    void stop?.();
  };
  request.signal.addEventListener("abort", finish, { once: true });
  live.page.once("close", finish);
  if (request.signal.aborted) finish();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        if (stopped) { controller.close(); return; }
        controller.enqueue(encoder.encode("retry: 2000\n\n"));
        if (width > 0 && height > 0) await host.browser.resize(live, { width, height });
        stop = await host.browser.stream(live, frame => { latest = frame; wake?.(); }, { mobile });
        if (stopped) await stop();
      } catch (error) {
        host.logs.warning("pages", `stream failed: ${error instanceof Error ? error.message : String(error)}`);
        finish();
      }
    },
    async pull(controller) {
      if (!latest && !stopped) await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, 15_000);
        wake = () => { clearTimeout(timer); resolve(); };
      });
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
  if (action === "sign-in" && request.method === "POST") {
    const body = await payload<Record<string, unknown>>(request);
    const values: SignIn = {};
    for (const name of ["username", "password", "code"] as const) {
      const value = body[name];
      if (value === undefined || value === null || value === "") continue;
      if (typeof value !== "string" || value.length > 1_024) throw new HTTPError(400, "Sign-in values must be text of at most 1,024 characters");
      values[name] = value;
    }
    if (!Object.keys(values).length) throw new HTTPError(400, "Enter a username, password or code");
    if (body.site !== undefined && (typeof body.site !== "string" || !body.site || body.site.length > 1_024)) throw new HTTPError(400, "Send the site the sign-in is for");
    const result = await host.browser.signIn(live, values, body.site as string | undefined).catch(() => {
      host.logs.warning("pages", `sign-in page=${live.id} failed`);
      throw new HTTPError(400, "The page couldn't be filled in. Open the page to sign in there.");
    });
    host.logs.info("pages", `sign-in page=${live.id} filled=${result.filled.join(",") || "none"} status=${result.status}`);
    return json({ status: result.status });
  }
  if (action === "input" && request.method === "POST") {
    await host.browser.input(live, input(await payload<Record<string, unknown>>(request)));
    return json({ ok: true });
  }
  throw new HTTPError(404, "Not found");
}

import type { FunctionCall } from "@openox/agent/linux";
import { OxError } from "@openox/agent/linux";
import type { VMFactory } from "../context";
import { SiteApprovals } from "./approvals";
import { BrowserSession } from "./session";
import { Approvals } from "../approvals";
import { browserJobsEnabled } from "../../config";
import { join } from "node:path";
import { BrowserExtensions, validExtensionID } from "./extensions";
import { sameOrigin } from "../../auth";
import { json } from "../../http";

export const browserModule: VMFactory = context => {
  const approvals = new SiteApprovals(context.paths.state, url => context.familiarWebVisit(url));
  const sessions = new Map<number, BrowserSession>();
  const extensions = new BrowserExtensions(join(context.paths.root, "browser-extensions"));
  const approveOnce = async (call: FunctionCall, title: string, body: string) => {
    const answer = await call.ask({ kind: "approval", title, body, options: ["Approve once", "Deny"] });
    if (answer.kind !== "answer") throw new OxError("cancelled", "The user stopped before answering.", "Stop. Do not repeat the request unless the user asks.");
    return answer.text === "Approve once";
  };
  let unsubscribe: (() => void) | undefined;
  const session = (call: FunctionCall) => {
    if (call.args.service !== undefined) throw new OxError("not_supported", "Targeting a service page with Browser operations is not available on this Linux Host.", "Use the service's actions or the Browser's top-level page.");
    let found = sessions.get(call.conversationId);
    if (!found) {
      found = new BrowserSession(call.conversationId, context.browser, approvals, context.logs, site => context.savedLogin?.(site) ?? Promise.resolve(undefined));
      sessions.set(call.conversationId, found);
    }
    return found;
  };
  return {
    limitations: ["Browser is headless Chromium on this Host: exportPdf saves the PDF in the conversation folder and returns its file name instead of attaching it, and a link that opens a new window opens a separate popup page that ox.web.browser functions do not control, so navigate to such links directly. Browser only inspects and executes in its current main document; child-frame and service-page targeting are unavailable, and omitted live frames set framesTruncated. showPage only presents the live page; use waitForUserInteraction for an explicit Done/Cancel acknowledgment."],
    handlers: {
      "ox.web.browser.navigate": async call => session(call).navigate(call),
      "ox.web.browser.reload": async call => session(call).reload(call),
      "ox.web.browser.stopLoading": async call => session(call).stopLoading(),
      "ox.web.browser.goBack": async call => session(call).traverse(call, -1),
      "ox.web.browser.goForward": async call => session(call).traverse(call, 1),
      "ox.web.browser.getNavigationHistory": async call => session(call).navigationHistory(call),
      "ox.web.browser.getPageState": async call => session(call).pageState(call),
      "ox.web.browser.waitForNavigation": async call => session(call).waitForNavigation(call),
      "ox.web.browser.showPage": async call => session(call).showPage(call),
      "ox.web.browser.executeScript": async call => session(call).executeScript(call),
      "ox.web.browser.exportPdf": async call => session(call).exportPdf(call),
      "ox.web.browser.waitForUserInteraction": async call => session(call).waitForUserInteraction(call),
      "ox.web.browser.injectScript": async call => session(call).injectScript(call),
      "ox.web.browser.clearScripts": async call => session(call).clearScripts(call),
      "ox.web.browser.startCapture": async call => session(call).startCapture(call),
      "ox.web.browser.markCapture": async call => session(call).markCapture(call),
      "ox.web.browser.listCapturedEvents": async call => session(call).listCapturedEvents(call),
      "ox.web.browser.readCapturedEvent": async call => session(call).readCapturedEvent(call),
      "ox.web.browser.stopCapture": async call => session(call).stopCapture(call),
      ...(browserJobsEnabled() ? {
        "ox.web.browser.interact": async (call: FunctionCall) => session(call).interact(call),
        "ox.web.browser.readText": async (call: FunctionCall) => session(call).readText(call),
        "ox.web.browser.signIn": async (call: FunctionCall) => session(call).signIn(call),
        "ox.web.browser.humanCheck": async (call: FunctionCall) => session(call).humanCheck(call),
        "ox.web.browser.extensions.list": async () => ({ extensions: await extensions.list() }),
        "ox.web.browser.extensions.install": async (call: FunctionCall) => call.untimed(async () => {
          if (!validExtensionID(call.args.id)) throw new OxError("invalid_argument", "This isn't a Chrome Web Store extension ID.", "Use the 32-letter ID from the extension's Chrome Web Store address.");
          const prepared = await extensions.prepare(call.args.id, call.signal);
          try {
            const body = [`${prepared.name} ${prepared.version} from the Chrome Web Store`,
              `Site access: ${prepared.sites.length ? prepared.sites.join(", ") : "none"}`, `Permissions: ${prepared.permissions.length ? prepared.permissions.join(", ") : "none"}`,
              "The job browser restarts to load it."].join("\n");
            if (!await approveOnce(call, "Install browser extension", body)) throw new OxError("permission_denied", "The user declined this extension. Nothing was installed.", "Continue without it, or ask the user.");
            const record = await extensions.commit(prepared);
            context.logs.info("browser", `extension installed id=${record.id} version=${record.version}`);
            await context.browser.restart();
            return { id: record.id, name: record.name, version: record.version, restarted: true as const };
          } finally { await extensions.discard(prepared); }
        }),
        "ox.web.browser.extensions.remove": async (call: FunctionCall) => call.untimed(async () => {
          const found = (await extensions.list()).find(item => item.id === call.args.id);
          if (!found) return { removed: false };
          if (!await approveOnce(call, "Remove browser extension", `${found.name} ${found.version}\nThe job browser restarts.`)) throw new OxError("permission_denied", "The user declined. The extension stays installed.", "Stop this step.");
          const removed = await extensions.remove(found.id);
          context.logs.info("browser", `extension removed id=${found.id}`);
          await context.browser.restart();
          return { removed };
        }),
      } : {}),
    },
    ...(browserJobsEnabled() ? { routes: { "browser-extensions": async (request: Request, _url: URL, parts: string[]) => {
      if (!sameOrigin(request)) return json({ error: "Use this Host's paired workspace." }, { status: 403 });
      if (!parts.length && request.method === "GET") return json({ extensions: await extensions.list() });
      if (parts.length === 1 && request.method === "DELETE") {
        const removed = await extensions.remove(parts[0]!);
        if (removed) { context.logs.info("browser", `extension removed id=${parts[0]} by owner`); await context.browser.restart(); }
        return json({ removed });
      }
      return json({ error: "Not found" }, { status: 404 });
    } } } : {}),
    conversationRemoved: async id => {
      const found = sessions.get(id);
      sessions.delete(id);
      await (found ? found.close() : context.browser.closeOwner(`browser:${id}`));
    },
    start: async () => { unsubscribe ??= Approvals.for(context.paths.state).onBrowserRevoke(async () => { for (const session of sessions.values()) await session.revoke(); }); },
    close: async () => { unsubscribe?.(); unsubscribe = undefined; for (const session of sessions.values()) await session.close(); sessions.clear(); },
  };
};

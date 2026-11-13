import type { FunctionCall } from "@openox/agent/linux";
import { OxError } from "@openox/agent/linux";
import type { VMFactory } from "../context";
import { SiteApprovals } from "./approvals";
import { BrowserSession } from "./session";

export const browserModule: VMFactory = context => {
  const approvals = new SiteApprovals(context.paths.state);
  const sessions = new Map<number, BrowserSession>();
  const session = (call: FunctionCall) => {
    if (call.args.service !== undefined) throw new OxError("not_supported", "Targeting a service page with Browser operations is not available on this Linux Host.", "Use the service's actions or the Browser's top-level page.");
    let found = sessions.get(call.conversationId);
    if (!found) {
      found = new BrowserSession(call.conversationId, context.browser, approvals, context.logs);
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
      "ox.web.browser.getNavigationHistory": async call => session(call).navigationHistory(),
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
    },
    conversationRemoved: async id => {
      const found = sessions.get(id);
      sessions.delete(id);
      await (found ? found.close() : context.browser.closeOwner(`browser:${id}`));
    },
    close: async () => { sessions.clear(); },
  };
};

import type { VMFactory } from "./context";
import { attach } from "./web/attach";
import { downloadText, webFetch } from "./web/fetch";
import { museParityEnabled, publicLookupEnabled } from "../config";
import { tesseractAvailable, visionAnalyzer } from "./web/vision";
import { Approvals } from "./approvals";
import { publicSourceURL } from "@openox/agent/linux";

export const webModule: VMFactory = context => ({
  handlers: {
    ...(museParityEnabled() ? { "ox.web.downloadText": (call: Parameters<typeof downloadText>[0]) => downloadText(call, context) } : {}),
    "ox.web.fetch": async call => {
      const lookup = publicLookupEnabled() && !call.page && Approvals.for(context.paths.state).publicLookup(call.conversationId);
      const result = await webFetch(call, context, lookup ? lookup.ticker : undefined);
      if (lookup && result.ok && (result.text?.trim() || "feed" in result && Array.isArray(result.feed.entries) && result.feed.entries.length)) {
        let url;
        try { url = publicSourceURL(result.url); } catch {}
        if (url && url.length <= 4096 && lookup.observed.pages.length < 8 && !lookup.observed.pages.includes(url)) lookup.observed.pages.push(url);
      }
      await call.profile.capturePublicEvidence(call.conversationId, result, call.signal);
      return result;
    },
    "ox.fs.attach": call => attach(call, context),
    "ox.vision.analyze": visionAnalyzer(context),
  },
  limitations: [`ox.vision.analyze reads text with on-device OCR and reports pixel dimensions; it does not classify image content, so its classifications list is always empty.${tesseractAvailable() ? "" : " Image text recognition is unavailable until tesseract-ocr is installed on this Host."}`],
});

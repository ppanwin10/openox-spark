import type { VMFactory } from "./context";
import { attach } from "./web/attach";
import { webFetch } from "./web/fetch";
import { tesseractAvailable, visionAnalyzer } from "./web/vision";

export const webModule: VMFactory = context => ({
  handlers: {
    "ox.web.fetch": call => webFetch(call, context),
    "ox.fs.attach": call => attach(call, context),
    "ox.vision.analyze": visionAnalyzer(context),
  },
  limitations: [`ox.vision.analyze reads text with on-device OCR and reports pixel dimensions; it does not classify image content, so its classifications list is always empty.${tesseractAvailable() ? "" : " Image text recognition is unavailable until tesseract-ocr is installed on this Host."}`],
});

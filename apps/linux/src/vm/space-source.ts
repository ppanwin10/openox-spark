import { OxError, type FunctionCall } from "@openox/agent/linux";
import { publicLookupEnabled } from "../config";
import { Approvals } from "./approvals";
import type { VMContext } from "./context";
import { isTestURL } from "./net";
import { canonicalJSON, sha256 } from "./services/support";
import { fetchResource, webURL } from "./web/client";
import { htmlMarkdown } from "./web/defuddle";
import { decodeText } from "./web/fetch";

export async function readSpaceSource(call: FunctionCall, context: VMContext) {
  const page = call.page, source = page?.source;
  if (!publicLookupEnabled() || !page || !source) throw new OxError("permission_denied", "Only a currently registered Space can refresh its declared public source.");
  const profile = context.profile(), policy = Approvals.for(context.paths.state);
  const entry = await profile.openFile(page.path);
  if (entry.entry.size > 512_000) throw new OxError("limit_exceeded", "A Space with public sources must be smaller than 512 KB.");
  const bytes = await entry.file.bytes();
  const current = async () => {
    const opened = await profile.spaceOpening(page.path, source.sha256);
    if (!opened || canonicalJSON(opened) !== canonicalJSON(source)) throw new OxError("permission_denied", "The registered Space or its original source changed. Reopen it.");
    await policy.guard(call); call.signal.throwIfAborted();
  };
  if (sha256(bytes) !== source.sha256) throw new OxError("permission_denied", "The Space changed after opening.");
  const urls = new Map<string, string>();
  await new HTMLRewriter().on('meta[name="ox-public-source"]', { element(el: { getAttribute(name: string): string | null }) {
    const slot = el.getAttribute("data-slot") ?? "", href = el.getAttribute("content") ?? "";
    if (urls.size >= 8 || !/^[a-z][a-z0-9_-]{0,39}$/.test(slot) || urls.has(slot) || !href || href.length > 2048)
      throw new OxError("invalid_argument", "Declare up to eight unique named public page sources.");
    urls.set(slot, href);
  } }).transform(new Response(bytes)).arrayBuffer();
  const raw = urls.get(String(call.args.slot));
  if (!raw) throw new OxError("permission_denied", "This public source is not declared in the original Space file.");
  const url = webURL(call.name, raw);
  if (url.search || url.hash || url.protocol !== "https:" && !isTestURL(url)) throw new OxError("invalid_argument", "Declare a public HTTPS page without a query, credentials or fragment.");
  await current();
  const response = await fetchResource(call, url, context, current);
  await current();
  if (response.status !== 200) throw new OxError("unavailable", `The public page returned HTTP ${response.status}. No fresh result is available.`);
  const html = ["text/html", "application/xhtml+xml"].includes(response.mimeType);
  if (!html && response.mimeType !== "text/plain") throw new OxError("not_supported", "Choose a readable public HTML or text page.");
  const decoded = decodeText(response.data, response.headers["content-type"], html);
  const text = decoded === undefined ? undefined : html ? htmlMarkdown(decoded, url.href) : decoded.trim();
  if (!text?.trim()) throw new OxError("unavailable", "This public page provided no readable text.");
  if (Buffer.byteLength(text) > 256_000) throw new OxError("limit_exceeded", "The public page exceeds the Space text limit; choose a more focused source.");
  return { text, url: url.href, readAt: new Date().toISOString() };
}

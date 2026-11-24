import { isUtf8 } from "node:buffer";
import { documentText, OxError, type FunctionCall } from "@openox/agent/linux";
import { Approvals } from "../approvals";
import type { VMContext } from "../context";
import { fetchResource, webURL } from "./client";
import { htmlMarkdown, yahooQuoteText } from "./defuddle";
import { parseFeed } from "./feed";
import { kindOf, limits, webFilename } from "./media";
import { limitText } from "./text";
import { evidenceOnlyEnabled } from "../../config";

const noText = "No readable text. Use ox.fs.attach with the returned url to explicitly send the original file to the model.";
const charset = /charset[ \t]*=[ \t]*["']?([A-Za-z0-9._:-]+)/i;

export async function downloadText(call: FunctionCall, context: VMContext) {
  const approvals = Approvals.for(context.paths.state);
  if (call.page || call.conversationId < 0 || !approvals.submission(call) || approvals.scheduled(call)) {
    throw new OxError("permission_denied", "A public file download requires an active chat request.");
  }
  const response = await fetchResource(call, webURL(call.name, String(call.args.url)), context);
  if (response.status !== 200) throw new OxError("http_error", `The site returned HTTP ${response.status}. No file was saved.`);
  if (response.mimeType !== "text/plain" || !isUtf8(response.data) || response.data.includes(0)) {
    throw new OxError("not_supported", "The response is not a plain UTF-8 text file. No file was saved.", "Explain the limitation; do not substitute another format.");
  }
  const base = webFilename(response.url, "text/plain").replace(/^\.+/, "");
  const name = /\.txt$/i.test(base) ? base : `${base}.txt`;
  const path = `conversations/${call.conversationId}/downloads/${crypto.randomUUID()}/${name}`;
  await approvals.guard(call);
  const stored = await call.profile.writeFile(path, response.data);
  await call.update({ path: stored.path });
  return { path: stored.path, name: stored.name, bytes: stored.size };
}

export function decodeText(bytes: Uint8Array, contentType = "", html = false) {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch {}
  const head = html ? new TextDecoder("latin1").decode(bytes.subarray(0, 1024)).match(/<meta[^>]+>/gi)?.join(" ") ?? "" : "";
  const label = (charset.exec(contentType) ?? charset.exec(head))?.[1];
  if (!label) return undefined;
  try { return new TextDecoder(label).decode(bytes); } catch { return undefined; }
}

function pageLimit(text: string, maxPages?: number) {
  const index = maxPages ? text.indexOf(`\n\n--- Page ${maxPages + 1} ---\n`) : -1;
  return index < 0 ? { text, truncated: false } : { text: `${text.slice(0, index)}\n`, truncated: true };
}

export async function webFetch(call: FunctionCall, context: VMContext, quoteSymbol?: string) {
  const options = (call.args.options ?? {}) as { maxBytes?: number; maxPages?: number };
  const started = Date.now();
  const response = await fetchResource(call, webURL(call.name, String(call.args.url)), context);
  const kind = kindOf(response.mimeType);
  context.logs.info("web", `fetch host=${new URL(response.url).host} status=${response.status} bytes=${response.data.length} kind=${kind} ms=${Date.now() - started}`);
  const result = { ok: response.status >= 200 && response.status <= 299, status: response.status, statusText: response.statusText, url: response.url,
    redirected: response.url !== response.requested, headers: response.headers, kind: kind as string, filename: webFilename(response.url, response.mimeType),
    bytes: response.data.length, text: null as string | null, truncated: false, attached: false, unsupported: null as string | null };
  if (kind === "text" || kind === "file" || kind === "html") {
    const feed = parseFeed(response.data, response.url, Math.min(options.maxBytes ?? 65_536, limits.file));
    if (feed) return { ...result, kind: "feed", truncated: feed.truncated, feed: feed.value };
  }
  const maxBytes = Math.min(options.maxBytes ?? limits.file, limits.file);
  if (kind === "html") {
    const html = decodeText(response.data, response.headers["content-type"], true);
    if (html === undefined) throw new OxError("operation_failed", `${call.name}: HTTP response body is not valid text`, "The page uses an unsupported text encoding; try another source.");
    if (quoteSymbol && response.url === `https://finance.yahoo.com/quote/${quoteSymbol}/`) {
      const quote = response.status === 200 && !result.redirected && yahooQuoteText(html, response.url, quoteSymbol);
      if (!quote) throw new OxError("operation_failed", `${call.name}: no complete, unambiguous public quote header for ${quoteSymbol}`, "Report the price as unverified. Do not substitute article text.");
      const limited = limitText(quote, maxBytes);
      if (limited.truncated) throw new OxError("resource_limit", `${call.name}: quote fields exceed the requested text limit`, "Do not report a partial price.");
      return { ...result, ...limited };
    }
    const markdown = htmlMarkdown(html, response.url, evidenceOnlyEnabled() && call.name === "ox.web.fetch" && result.ok && !result.redirected);
    if (markdown === undefined && result.ok) {
      throw new OxError("operation_failed", `${call.name}: HTML document has no readable content`, "The page may need JavaScript or be empty. Try the site's feed, API or another page.");
    }
    return { ...result, ...limitText(markdown ?? "", maxBytes) };
  }
  if (kind === "text") {
    const decoded = decodeText(response.data, response.headers["content-type"]);
    const read = decoded === undefined ? await documentText(response.data, context.paths.scratch) : { text: decoded };
    return "text" in read ? { ...result, ...limitText(read.text, maxBytes) } : { ...result, unsupported: read.unsupported };
  }
  if (kind === "pdf") {
    const pdf = response.data.length > 4 && new TextDecoder().decode(response.data.subarray(0, 5)) === "%PDF-";
    const read = pdf ? await documentText(response.data, context.paths.scratch) : { unsupported: "The PDF couldn't be read." };
    if ("unsupported" in read) return { ...result, unsupported: read.unsupported };
    const pages = pageLimit(read.text, options.maxPages);
    const limited = limitText(pages.text, maxBytes);
    return { ...result, text: limited.text, truncated: pages.truncated || limited.truncated };
  }
  return { ...result, unsupported: noText };
}

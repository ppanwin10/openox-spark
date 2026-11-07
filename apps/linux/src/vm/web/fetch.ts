import { documentText, OxError, type FunctionCall } from "@openox/agent/linux";
import type { VMContext } from "../context";
import { fetchResource, webURL } from "./client";
import { htmlMarkdown } from "./defuddle";
import { parseFeed } from "./feed";
import { kindOf, limits, webFilename } from "./media";
import { limitText } from "./text";

const noText = "No readable text. Use ox.fs.attach with the returned url to explicitly send the original file to the model.";
const charset = /charset[ \t]*=[ \t]*["']?([A-Za-z0-9._:-]+)/i;

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

export async function webFetch(call: FunctionCall, context: VMContext) {
  const options = (call.args.options ?? {}) as { maxBytes?: number; maxPages?: number };
  const started = Date.now();
  const response = await fetchResource(call, webURL(call.name, String(call.args.url)));
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
    const markdown = htmlMarkdown(html, response.url);
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

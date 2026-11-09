import { isUtf8 } from "node:buffer";
import { extname, posix } from "node:path";
import type { LinuxProfile } from "@openox/agent/linux";
import { HTTPError } from "./http";

type Element = { getAttribute(name: string): string | null; setAttribute(name: string, value: string): void; removeAttribute(name: string): void };

export const pagePolicy = "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox; default-src 'none'; img-src data: blob:; media-src data: blob:; "
  + "script-src 'unsafe-inline'; style-src 'unsafe-inline' data:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; worker-src blob:; "
  + "base-uri 'none'; form-action 'none'";
const links = `<script>document.addEventListener("click",function(event){var link=event.target&&event.target.closest?event.target.closest("a[href]"):null;`
  + `if(!link)return;var raw=(link.getAttribute("href")||"").trim();if(raw.charAt(0)==="#")return;event.preventDefault();`
  + `if(/^(https?:|mailto:|tel:)/i.test(raw))window.open(raw,"_blank","noopener");},true);</script>`;
const types: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".svg": "image/svg+xml", ".css": "text/css", ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".mp3": "audio/mpeg", ".wav": "audio/wav",
  ".m4a": "audio/mp4", ".ogg": "audio/ogg" };
const pageLimit = 32 * 1024 * 1024, eachLimit = 8 * 1024 * 1024, totalLimit = 16 * 1024 * 1024, lookupLimit = 200;

export async function preparePage(profile: LinuxProfile, path: string, signal?: AbortSignal): Promise<string | undefined> {
  if (![".html", ".htm"].includes(extname(path).toLowerCase())) throw new HTTPError(415, "Only HTML pages open this way");
  const { entry, file } = await profile.openFile(path);
  if (entry.size > pageLimit) return undefined;
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!isUtf8(bytes)) return undefined;
  const folder = posix.dirname(entry.path);
  const found = new Map<string, { data: string; size: number } | undefined>();
  let used = 0;
  const inline = async (value: string) => {
    if (!value || /^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith("//") || value.startsWith("#")) return undefined;
    let target: string;
    try { target = decodeURI(value.split(/[?#]/)[0]!); } catch { return undefined; }
    const resolved = posix.normalize(target.startsWith("/") ? target.slice(1) : posix.join(folder === "." ? "" : folder, target));
    const type = types[extname(resolved).toLowerCase()];
    if (!type || !resolved || resolved === "." || resolved.startsWith("..")) return undefined;
    if (!found.has(resolved)) {
      if (signal?.aborted || found.size >= lookupLimit || used >= totalLimit) return undefined;
      let item: { data: string; size: number } | undefined;
      try {
        const resource = await profile.openFile(resolved);
        if (resource.entry.size <= eachLimit && used + resource.entry.size <= totalLimit)
          item = { data: `data:${type};base64,${Buffer.from(await resource.file.arrayBuffer()).toString("base64")}`, size: resource.entry.size };
      } catch {}
      found.set(resolved, item);
    }
    const item = found.get(resolved);
    if (!item || used + item.size > totalLimit) return undefined;
    used += item.size;
    return item.data;
  };
  const rewrite = (attribute: string) => ({ async element(element: Element) {
    const value = element.getAttribute(attribute);
    const data = value === null ? undefined : await inline(value.trim());
    if (data) element.setAttribute(attribute, data);
  } });
  const body = await new HTMLRewriter()
    .on("img[src], video[src], audio[src], source[src]", rewrite("src"))
    .on("video[poster]", rewrite("poster"))
    .on("img[srcset], source[srcset]", { element(element: Element) { if (!/^\s*(data|blob):/i.test(element.getAttribute("srcset") ?? "")) element.removeAttribute("srcset"); } })
    .on("link[href]", { async element(element: Element) { if (/(^|\s)stylesheet(\s|$)/i.test(element.getAttribute("rel") ?? "")) await rewrite("href").element(element); } })
    .transform(new Response(bytes)).text();
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${links}</head><body>${body}</body></html>`;
}

import type { ExecutionBudget, FunctionCall } from "@openox/agent/linux";
import { OxError } from "@openox/agent/linux";
import packageMetadata from "../../../package.json";
import { allowsURL, resolvesPublic } from "../net";
import { mediaType } from "./media";

export interface WebResponse { requested: string; url: string; status: number; statusText: string; headers: Record<string, string>; data: Uint8Array; mimeType: string }

const limits = { response: 10 * 1024 * 1024, execution: 20 * 1024 * 1024, fetches: 8, redirects: 5, timeout: 20_000 };
const spent = new WeakMap<ExecutionBudget, number>();
const redirects = new Set([301, 302, 303, 307, 308]);
const agent = `OpenOx-Linux-Host/${packageMetadata.version}`;
const statusTexts = new Map(Object.entries({
  100: "Continue", 101: "Switching Protocols", 200: "OK", 201: "Created", 202: "Accepted", 204: "No Content", 206: "Partial Content", 300: "Multiple Choices",
  301: "Moved Permanently", 302: "Found", 303: "See Other", 304: "Not Modified", 307: "Temporary Redirect", 308: "Permanent Redirect", 400: "Bad Request",
  401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 405: "Method Not Allowed", 408: "Request Timeout", 409: "Conflict", 410: "Gone",
  413: "Content Too Large", 415: "Unsupported Media Type", 422: "Unprocessable Content", 429: "Too Many Requests", 500: "Internal Server Error",
  501: "Not Implemented", 502: "Bad Gateway", 503: "Service Unavailable", 504: "Gateway Timeout",
}).map(([status, text]) => [Number(status), text]));

const failure = (name: string, code: string, message: string, recovery: string) => new OxError(code, `${name}: ${message}`, recovery);
const publicOnly = "Only public internet resources can be fetched; do not retry private, local, or internal addresses.";

export function webURL(name: string, value: string) {
  let url: URL | undefined;
  try { url = new URL(value); } catch {}
  if (!url || !allowsURL(url)) throw failure(name, "invalid_argument", "url must be a public HTTP or HTTPS URL", `Use an absolute http:// or https:// URL without credentials. ${publicOnly}`);
  return url;
}

async function body(name: string, response: Response) {
  const tooLarge = () => failure(name, "resource_limit", "response exceeded the 10 MiB limit", "Fetch a smaller or more specific resource.");
  if (Number(response.headers.get("content-length") ?? 0) > limits.response) {
    await response.body?.cancel().catch(() => {});
    throw tooLarge();
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limits.response) {
      await reader.cancel().catch(() => {});
      throw tooLarge();
    }
    chunks.push(value);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

export async function fetchResource(call: FunctionCall, url: URL): Promise<WebResponse> {
  const name = call.name;
  if (call.execution.fetches >= limits.fetches) {
    throw failure(name, "resource_limit", "one JavaScript execution may fetch at most eight resources", "Return what you have, then fetch the remaining resources in a new execution.");
  }
  call.execution.fetches += 1;
  const timeout = AbortSignal.timeout(limits.timeout);
  const signal = AbortSignal.any([call.signal, timeout]);
  let current = url;
  try {
    for (let hops = 0; ; hops++) {
      if (!await resolvesPublic(current)) throw failure(name, "permission_denied", "host did not resolve to only public addresses", publicOnly);
      const response = await fetch(current, { method: "GET", redirect: "manual", signal, headers: { accept: "*/*", "user-agent": agent } });
      if (response.status >= 300 && response.status <= 399) {
        await response.body?.cancel().catch(() => {});
        const location = response.headers.get("location");
        if (!redirects.has(response.status) || !location) throw failure(name, "invalid_output", `server returned HTTP ${response.status} without a redirect location`, "Use a different URL for this resource.");
        if (hops >= limits.redirects) throw failure(name, "resource_limit", "response exceeded the five-redirect limit", "Fetch the final URL directly if you know it, or use another source.");
        let next: URL | undefined;
        try { next = new URL(location, current); } catch {}
        if (!next || !allowsURL(next)) throw failure(name, "permission_denied", "redirect to a non-public or unsupported URL was blocked", publicOnly);
        current = next;
        continue;
      }
      const data = await body(name, response);
      const total = (spent.get(call.execution) ?? 0) + data.length;
      if (total > limits.execution) throw failure(name, "resource_limit", "responses exceeded the 20 MiB execution limit", "Continue in a new execution and fetch fewer or smaller resources.");
      spent.set(call.execution, total);
      const headers = new Map<string, string>();
      response.headers.forEach((value, key) => { if (key !== "set-cookie" && key !== "set-cookie2") headers.set(key.toLowerCase(), value); });
      return { requested: url.href, url: current.href, status: response.status, statusText: statusTexts.get(response.status) ?? "", headers: Object.fromEntries(headers),
        data, mimeType: mediaType(response.headers.get("content-type")) };
    }
  } catch (error) {
    if (error instanceof OxError) throw error;
    if (call.signal.aborted) throw new OxError("cancelled", "The operation was cancelled.", "Stop. Do not repeat the operation unless the user asks.");
    if (timeout.aborted) throw failure(name, "timeout", "the request did not finish within 20 seconds", "The site may be slow or unreachable; retry once later or use another source.");
    throw failure(name, "transport_error", `request to ${current.host} failed: ${error instanceof Error ? error.message : String(error)}`, "Check the URL; the site may be unreachable. Retry once later or use another source.");
  }
}

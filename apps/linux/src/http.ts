const jsonLimit = 1024 * 1024;

export class HTTPError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
export const json = (value: unknown, init: ResponseInit = {}) => Response.json(value, { ...init, headers: { "cache-control": "no-store", ...init.headers } });

export async function bodyBytes(request: Request, limit: number, message = "Request is too large") {
  if (Number(request.headers.get("content-length") ?? 0) > limit) throw new HTTPError(413, message);
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      throw new HTTPError(413, message);
    }
    chunks.push(value);
  }
  const data = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
  return data;
}

export async function payload<T>(request: Request, limit = jsonLimit): Promise<T> {
  const text = new TextDecoder().decode(await bodyBytes(request, limit));
  try { return JSON.parse(text || "{}") as T; } catch { throw new HTTPError(400, "Expected JSON"); }
}

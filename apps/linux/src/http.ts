const jsonLimit = 1024 * 1024;

export class HTTPError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
export const json = (value: unknown, init: ResponseInit = {}) => Response.json(value, { ...init, headers: { "cache-control": "no-store", ...init.headers } });

export async function payload<T>(request: Request): Promise<T> {
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > jsonLimit) throw new HTTPError(413, "Request is too large");
  const text = await request.text();
  if (text.length > jsonLimit) throw new HTTPError(413, "Request is too large");
  try { return JSON.parse(text || "{}") as T; } catch { throw new HTTPError(400, "Expected JSON"); }
}

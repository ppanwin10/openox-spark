import { homedir } from "node:os";
import { join } from "node:path";

export type MediaCapabilityID = "transcription" | "speech" | "image";
export type MediaState = "ready" | "loads_on_use" | "loading" | "not_installed" | "insufficient_memory";
export interface MediaCapability { id: MediaCapabilityID; model: string; state: MediaState }
export interface MediaHealth { reachable: boolean; memAvailableBytes: number | null; capabilities: MediaCapability[] }

const ids = new Set<string>(["transcription", "speech", "image"]);
const states = new Set<string>(["ready", "loads_on_use", "loading", "not_installed", "insufficient_memory"]);

export interface ExtractedMedia { kind: "video" | "audio"; duration: number; width: number; height: number; frames: { time: number; data: Uint8Array }[]; transcript: string | null }

export class MediaError extends Error {
  readonly status: number;
  readonly kind: string;
  constructor(status: number, message: string, kind: string) { super(message); this.status = status; this.kind = kind; }
}

const minutes = (count: number) => count * 60_000;

export class MediaClient {
  readonly url: string;

  constructor(url = process.env.OPENOX_MEDIA_URL || "http://127.0.0.1:9877") { this.url = url.replace(/\/+$/, ""); }

  private async token() {
    if (process.env.OPENOX_MEDIA_TOKEN) return process.env.OPENOX_MEDIA_TOKEN;
    return Bun.file(join(homedir(), ".local/share/openox-media/token")).text().then(text => text.trim(), () => "");
  }

  private async request(path: string, init: RequestInit, timeout: number, signal?: AbortSignal) {
    const signals = [AbortSignal.timeout(timeout), ...(signal ? [signal] : [])];
    const token = await this.token();
    const headers = { ...init.headers as Record<string, string> | undefined, ...(token ? { authorization: `Bearer ${token}` } : {}) };
    let response: Response;
    try { response = await fetch(`${this.url}${path}`, { ...init, headers, redirect: "error", signal: AbortSignal.any(signals) }); }
    catch (error) {
      if (signal?.aborted) throw error;
      if (error instanceof DOMException && error.name === "TimeoutError") throw new MediaError(504, "The media service did not answer in time.", "timeout");
      throw new MediaError(0, "The media service isn't running on this Host.", "unreachable");
    }
    if (response.ok) return response;
    const body = await response.json().catch(() => undefined) as { error?: { message?: unknown; type?: unknown } } | undefined;
    const message = typeof body?.error?.message === "string" ? body.error.message : `The media service failed with HTTP ${response.status}.`;
    throw new MediaError(response.status, message, typeof body?.error?.type === "string" ? body.error.type : "error");
  }

  private upload(data: Uint8Array, name: string, type: string, fields: Record<string, string>) {
    const form = new FormData();
    form.set("file", new File([new Uint8Array(data)], name || "media", { type: type || "application/octet-stream" }));
    for (const [key, value] of Object.entries(fields)) form.set(key, value);
    return form;
  }

  async transcribe(data: Uint8Array, name: string, type: string, language?: string, signal?: AbortSignal) {
    const response = await this.request("/v1/audio/transcriptions", { method: "POST", body: this.upload(data, name, type, language ? { language } : {}) }, minutes(10), signal);
    const body = await response.json() as { text?: unknown; language?: unknown };
    return { text: typeof body.text === "string" ? body.text.trim() : "", language: typeof body.language === "string" && body.language ? body.language : null };
  }

  async speech(input: string, voice?: string, signal?: AbortSignal) {
    const response = await this.request("/v1/audio/speech", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ input, response_format: "wav", ...(voice ? { voice } : {}) }) }, minutes(5), signal);
    return new Uint8Array(await response.arrayBuffer());
  }

  async image(prompt: string, size: string, seed?: number, signal?: AbortSignal) {
    const response = await this.request("/v1/images/generations", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt, size, n: 1, response_format: "b64_json", ...(seed !== undefined ? { seed } : {}) }) }, minutes(10), signal);
    const body = await response.json() as { data?: { b64_json?: unknown }[]; model?: unknown };
    const encoded = body.data?.[0]?.b64_json;
    if (typeof encoded !== "string" || !encoded) throw new MediaError(502, "The media service returned no image.", "error");
    return Buffer.from(encoded, "base64");
  }

  async extract(data: Uint8Array, name: string, type: string, maxFrames: number, transcribe: boolean, signal?: AbortSignal): Promise<ExtractedMedia> {
    const response = await this.request("/v1/media/extract", { method: "POST", body: this.upload(data, name, type, { max_frames: String(maxFrames), transcribe: String(transcribe) }) }, minutes(10), signal);
    const body = await response.json() as { kind?: unknown; duration?: unknown; width?: unknown; height?: unknown; frames?: { time?: unknown; jpeg_b64?: unknown }[]; transcript?: unknown };
    const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : 0;
    return { kind: body.kind === "audio" ? "audio" : "video", duration: number(body.duration), width: Math.round(number(body.width)), height: Math.round(number(body.height)),
      frames: (Array.isArray(body.frames) ? body.frames : []).flatMap(frame => typeof frame.jpeg_b64 === "string" ? [{ time: number(frame.time), data: Buffer.from(frame.jpeg_b64, "base64") }] : []),
      transcript: typeof body.transcript === "string" ? body.transcript.trim() : null };
  }

  async health(): Promise<MediaHealth> {
    try {
      const response = await fetch(`${this.url}/health`, { redirect: "error", signal: AbortSignal.timeout(2_000) });
      if (!response.ok) return { reachable: false, memAvailableBytes: null, capabilities: [] };
      const body = await response.json() as { memAvailableBytes?: unknown; capabilities?: unknown };
      const listed = Array.isArray(body.capabilities) ? body.capabilities
        : body.capabilities && typeof body.capabilities === "object" ? Object.entries(body.capabilities).map(([id, value]) => ({ id, ...(value as object) })) : [];
      const capabilities = listed.flatMap(entry => {
        const { id, model, state } = entry as { id?: unknown; model?: unknown; state?: unknown };
        return typeof id === "string" && ids.has(id) ? [{ id: id as MediaCapabilityID, model: typeof model === "string" ? model : "", state: (typeof state === "string" && states.has(state) ? state : "not_installed") as MediaState }] : [];
      });
      return { reachable: true, memAvailableBytes: typeof body.memAvailableBytes === "number" ? body.memAvailableBytes : null, capabilities };
    } catch { return { reachable: false, memAvailableBytes: null, capabilities: [] }; }
  }
}

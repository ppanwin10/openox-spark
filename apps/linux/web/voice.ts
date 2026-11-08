import { api, APIError, toast } from "./client";
import { h, icon } from "./dom";
import { hostText, t } from "./i18n";

export type MediaFeature = { id: string; model: string; state: string };
export type MediaStatus = { reachable: boolean; capabilities: MediaFeature[] };

let status: MediaStatus = { reachable: false, capabilities: [] };
const usable = (id: string) => status.reachable && status.capabilities.some(feature => feature.id === id && feature.state !== "not_installed");

export async function loadMedia() {
  status = await api<MediaStatus>("/api/media").catch(() => ({ reachable: false, capabilities: [] }));
  return status;
}
export const canDictate = () => usable("transcription") && window.isSecureContext && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== "undefined";
export const canSpeak = () => usable("speech");

const message = (error: unknown) => hostText(error instanceof Error ? error.message : String(error));
const recordingTypes = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm", "audio/ogg;codecs=opus"];
const maximumSeconds = 300;

let active: { cancel(): void } | null = null;
let starting = false;

export function cancelDictation() { active?.cancel(); }

export function dictationButton(row: HTMLElement, textarea: HTMLTextAreaElement, options: { key(): string; insert(text: string, key: string): void }) {
  const button = h("button", { type: "button", className: "icon-button composer-mic", "aria-label": t("dictate"), title: t("dictate"), "data-testid": "dictate" }, icon("mic", 20));
  button.addEventListener("click", () => { if (!active && !starting) void start(); });

  async function start() {
    starting = true;
    const key = options.key();
    let stream: MediaStream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
    catch { toast(t("micDenied"), "error"); return; }
    finally { starting = false; }
    if (!row.isConnected || active) { for (const track of stream.getTracks()) track.stop(); return; }
    const type = recordingTypes.find(candidate => MediaRecorder.isTypeSupported(candidate)) ?? "";
    const recorder = new MediaRecorder(stream, type ? { mimeType: type } : {});
    const chunks: Blob[] = [];
    recorder.addEventListener("dataavailable", event => { if (event.data.size) chunks.push(event.data); });
    const bars = Array.from({ length: 36 }, () => h("span", { className: "level-bar" }));
    const clock = h("span", { className: "recording-time", "data-testid": "recording-time" }, "0:00");
    const cancel = h("button", { type: "button", className: "icon-button", "aria-label": t("cancelDictation"), title: t("cancelDictation"), "data-testid": "dictation-cancel" }, icon("close", 20));
    const done = h("button", { type: "button", className: "icon-button dictation-done", "aria-label": t("stopDictation"), title: t("stopDictation"), "data-testid": "dictation-done" }, icon("check", 20));
    const strip = h("div", { className: "recording-strip", role: "status", "aria-label": t("recording"), "data-testid": "recording" },
      cancel, h("span", { className: "level", "aria-hidden": "true" }, ...bars), clock, done);
    row.classList.add("recording");
    row.append(strip);
    const audio = new AudioContext();
    void audio.resume().catch(() => {});
    const analyser = audio.createAnalyser();
    analyser.fftSize = 512;
    audio.createMediaStreamSource(stream).connect(analyser);
    const samples = new Uint8Array(analyser.fftSize);
    const levels: number[] = [];
    const started = performance.now();
    let save = true, stopping = false;
    const finish = (keep: boolean) => {
      if (stopping) return;
      stopping = true;
      save = keep;
      if (recorder.state !== "inactive") recorder.stop();
    };
    const meter = setInterval(() => {
      analyser.getByteTimeDomainData(samples);
      let sum = 0;
      for (const sample of samples) sum += ((sample - 128) / 128) ** 2;
      levels.push(Math.min(1, Math.sqrt(sum / samples.length) * 4));
      if (levels.length > bars.length) levels.shift();
      bars.forEach((bar, index) => { bar.style.transform = `scaleY(${Math.max(0.08, levels[index - (bars.length - levels.length)] ?? 0)})`; });
      const seconds = Math.floor((performance.now() - started) / 1000);
      clock.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
      if (seconds >= maximumSeconds) finish(true);
    }, 80);
    const keys = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      finish(false);
    };
    document.addEventListener("keydown", keys, true);
    const reset = () => {
      strip.remove();
      row.classList.remove("recording");
      if (textarea.isConnected) textarea.focus({ preventScroll: true });
    };
    const transcribe = async (blob: Blob) => {
      strip.replaceChildren(h("span", { className: "spinner small", "aria-hidden": "true" }), h("span", { className: "recording-time" }, t("transcribing")));
      try {
        const response = await fetch("/api/media/transcriptions", { method: "POST", body: blob, headers: { "content-type": blob.type }, credentials: "same-origin" });
        const body = await response.json().catch(() => ({})) as { text?: string; error?: string };
        if (!response.ok) throw new APIError(response.status, body.error ?? `HTTP ${response.status}`);
        if (body.text?.trim()) options.insert(body.text.trim(), key); else toast(t("nothingHeard"), "error");
      } catch (error) { toast(message(error), "error"); }
      finally { reset(); }
    };
    recorder.addEventListener("stop", () => {
      clearInterval(meter);
      document.removeEventListener("keydown", keys, true);
      for (const track of stream.getTracks()) track.stop();
      void audio.close().catch(() => {});
      active = null;
      if (save && chunks.length) void transcribe(new Blob(chunks, { type: recorder.mimeType || type || "audio/webm" }));
      else reset();
    }, { once: true });
    cancel.addEventListener("click", () => finish(false));
    done.addEventListener("click", () => finish(true));
    active = { cancel: () => finish(false) };
    try { recorder.start(250); }
    catch (error) {
      active = null;
      clearInterval(meter);
      document.removeEventListener("keydown", keys, true);
      for (const track of stream.getTracks()) track.stop();
      void audio.close().catch(() => {});
      reset();
      toast(message(error), "error");
      return;
    }
    done.focus({ preventScroll: true });
  }
  return button;
}

export function speakable(markdown: string) {
  return markdown
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, "")
    .replace(/(\*\*|__|\*|_|~~)(?=\S)([^*_~]*?\S)\1/g, "$2")
    .replace(/^\s*\|?\s*:?-{3,}.*$/gm, " ")
    .replace(/\|/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim()
    .slice(0, 8_000);
}

const wide = /[\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/g;
const weight = (text: string) => text.length + (text.match(wide)?.length ?? 0);

export function speechChunks(text: string) {
  const sentences = text.match(/[^。！？!?.\n]+[。！？!?.]*\n?|\n/g) ?? [text];
  const chunks: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    const limit = [120, 180, 360][chunks.length] ?? 480;
    if (current && weight(current) >= 40 && weight(current + sentence) > limit) { chunks.push(current.trim()); current = ""; }
    current += sentence.length > 1_900 ? sentence.slice(0, 1_900) : sentence;
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.filter(Boolean);
}

let playing: { button: HTMLButtonElement; stop(): void } | null = null;

export function readAloudButton(text: () => string) {
  const button = h("button", { type: "button", className: "icon-button action", "aria-label": t("readAloud"), title: t("readAloud"), "data-testid": "read-aloud" }, icon("speaker", 18));
  const idle = () => { button.replaceChildren(icon("speaker", 18)); button.setAttribute("aria-label", t("readAloud")); button.title = t("readAloud"); delete button.dataset.state; };
  button.addEventListener("click", () => {
    if (playing?.button === button) { playing.stop(); return; }
    playing?.stop();
    const chunks = speechChunks(speakable(text()));
    if (!chunks.length) return;
    const controller = new AbortController();
    const player = new Audio();
    const urls: string[] = [];
    const stop = () => {
      if (controller.signal.aborted) return;
      controller.abort();
      player.pause();
      player.removeAttribute("src");
      for (const url of urls) URL.revokeObjectURL(url);
      urls.length = 0;
      if (playing?.button === button) playing = null;
      idle();
    };
    playing = { button, stop };
    button.dataset.state = "loading";
    button.replaceChildren(h("span", { className: "spinner small", "aria-hidden": "true" }));
    button.setAttribute("aria-label", t("stopReading"));
    button.title = t("stopReading");
    const fetchChunk = async (chunk: string) => {
      const response = await fetch("/api/media/speech", { method: "POST", body: JSON.stringify({ text: chunk }), headers: { "content-type": "application/json" },
        credentials: "same-origin", signal: controller.signal });
      if (!response.ok) throw new Error(((await response.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${response.status}`);
      const blob = await response.blob();
      if (controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
      const url = URL.createObjectURL(blob);
      urls.push(url);
      return url;
    };
    const fetched: Promise<string>[] = [];
    const settled: boolean[] = [];
    let queue: Promise<unknown> = Promise.resolve();
    const request = (index: number) => {
      if (index >= chunks.length || index < fetched.length) return;
      const result = queue.then(() => controller.signal.aborted ? Promise.reject(new DOMException("Aborted", "AbortError")) : fetchChunk(chunks[index]!));
      queue = result.then(() => { settled[index] = true; }, () => {});
      fetched[index] = result;
      result.catch(() => {});
    };
    void (async () => {
      request(0);
      request(1);
      try {
        for (let index = 0; index < chunks.length; index++) {
          if (index && !settled[index]) {
            button.dataset.state = "loading";
            button.replaceChildren(h("span", { className: "spinner small", "aria-hidden": "true" }));
          }
          const url = await fetched[index]!;
          request(index + 2);
          if (controller.signal.aborted) return;
          player.src = url;
          button.dataset.state = "playing";
          button.replaceChildren(icon("stop", 16));
          await player.play();
          await new Promise<void>((resolve, reject) => {
            player.onended = () => resolve();
            player.onerror = () => reject(new Error(t("error")));
            controller.signal.addEventListener("abort", () => resolve(), { once: true });
          });
          if (controller.signal.aborted) return;
          URL.revokeObjectURL(url);
          urls.splice(urls.indexOf(url), 1);
        }
        stop();
      } catch (error) {
        if (!controller.signal.aborted) { toast(message(error), "error"); stop(); }
      }
    })();
  });
  return button;
}

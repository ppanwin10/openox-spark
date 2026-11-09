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
let transcribing = false;

export function cancelDictation() { active?.cancel(); }

type RecordMode = { kind: "tap" } | { kind: "hold"; gesture: HoldGesture };
type HoldGesture = { id: number; x: number; y: number; holding: boolean; started: boolean; timer?: ReturnType<typeof setTimeout>;
  session?: { move(x: number, y: number): void; release(): void; interrupt(): void } };

export function dictationButton(row: HTMLElement, textarea: HTMLTextAreaElement, options: { key(): string; insert(text: string, key: string): void;
  send(text: string, key: string): void; hold(): boolean; area(): HTMLElement | null; canHold(): boolean }) {
  const button = h("button", { type: "button", className: "icon-button composer-mic", "data-testid": "dictate" }, icon("mic", 20));
  const label = () => {
    const hold = options.hold();
    button.classList.toggle("hold", hold);
    button.setAttribute("aria-label", hold ? t("holdToTalk") : t("dictate"));
    button.title = hold ? t("holdToTalkHint") : t("dictate");
  };
  label();
  button.addEventListener("click", event => {
    label();
    if (options.hold() && event.detail !== 0) return;
    if (!active && !starting && !transcribing) void record({ kind: "tap" });
  });
  button.addEventListener("contextmenu", event => { if (options.hold()) event.preventDefault(); });
  let gesture: HoldGesture | null = null;
  button.addEventListener("pointerdown", event => {
    label();
    if (!options.hold() || active || starting || transcribing || gesture || event.button !== 0) return;
    if (!options.canHold()) { event.preventDefault(); return; }
    event.preventDefault();
    try { button.setPointerCapture(event.pointerId); } catch {}
    const current: HoldGesture = { id: event.pointerId, x: event.clientX, y: event.clientY, holding: true, started: false };
    current.timer = setTimeout(() => { if (current.holding && !active && !starting) { current.started = true; void record({ kind: "hold", gesture: current }); } }, 350);
    gesture = current;
  });
  button.addEventListener("pointermove", event => { if (gesture?.id === event.pointerId) gesture.session?.move(event.clientX, event.clientY); });
  const end = (event: PointerEvent, interrupted: boolean) => {
    if (gesture?.id !== event.pointerId) return;
    const current = gesture;
    gesture = null;
    current.holding = false;
    clearTimeout(current.timer);
    if (current.session) { if (interrupted) current.session.interrupt(); else current.session.release(); }
    else if (!current.started && !interrupted) toast(t("holdToTalkHint"));
  };
  button.addEventListener("pointerup", event => end(event, false));
  button.addEventListener("pointercancel", event => end(event, true));

  async function record(mode: RecordMode) {
    starting = true;
    const key = options.key();
    let stream: MediaStream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
    catch { toast(t("micDenied"), "error"); return; }
    finally { starting = false; }
    if (mode.kind === "hold" && !mode.gesture.holding) {
      for (const track of stream.getTracks()) track.stop();
      toast(t("holdToTalkReady"));
      return;
    }
    if (!row.isConnected || active) { for (const track of stream.getTracks()) track.stop(); return; }
    const type = recordingTypes.find(candidate => MediaRecorder.isTypeSupported(candidate)) ?? "";
    const recorder = new MediaRecorder(stream, type ? { mimeType: type } : {});
    const chunks: Blob[] = [];
    recorder.addEventListener("dataavailable", event => { if (event.data.size) chunks.push(event.data); });
    const bars = Array.from({ length: 36 }, () => h("span", { className: "level-bar" }));
    const clock = h("span", { className: "recording-time", "data-testid": "recording-time" }, "0:00");
    const status = h("span", { className: "recording-status", "data-testid": "recording-status" }, t("releaseToSend"));
    const cancel = h("button", { type: "button", className: "icon-button", "aria-label": t("cancelDictation"), title: t("cancelDictation"), "data-testid": "dictation-cancel" }, icon("close", 20));
    const done = h("button", { type: "button", className: "icon-button dictation-done", "aria-label": t("stopDictation"), title: t("stopDictation"), "data-testid": "dictation-done" }, icon("check", 20));
    const strip = mode.kind === "tap"
      ? h("div", { className: "recording-strip", role: "status", "aria-label": t("recording"), "data-testid": "recording" }, cancel, h("span", { className: "level", "aria-hidden": "true" }, ...bars), clock, done)
      : h("div", { className: "recording-strip holding", role: "status", "aria-live": "polite", "data-testid": "recording" }, status, h("span", { className: "level", "aria-hidden": "true" }, ...bars));
    row.classList.add("recording");
    if (mode.kind === "hold") { row.classList.add("holding"); button.classList.add("active"); }
    row.insertBefore(strip, row.firstChild);
    const audio = new AudioContext();
    void audio.resume().catch(() => {});
    const analyser = audio.createAnalyser();
    analyser.fftSize = 512;
    audio.createMediaStreamSource(stream).connect(analyser);
    const samples = new Uint8Array(analyser.fftSize);
    const levels: number[] = [];
    const started = performance.now();
    let save = true, stopping = false, cancelling = false;
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
      if (seconds >= maximumSeconds) finish(mode.kind === "hold" ? !cancelling : true);
    }, 80);
    const keys = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      finish(false);
    };
    if (mode.kind === "tap") document.addEventListener("keydown", keys, true);
    const reset = () => {
      transcribing = false;
      strip.remove();
      row.classList.remove("recording", "holding");
      button.classList.remove("active", "cancel");
      if (mode.kind === "tap" && textarea.isConnected) textarea.focus({ preventScroll: true });
    };
    const transcribe = async (blob: Blob) => {
      transcribing = true;
      strip.replaceChildren(h("span", { className: "spinner small", "aria-hidden": "true" }),
        h("span", { className: "recording-time", "data-testid": "recording-status" }, mode.kind === "hold" ? t("transcribingAndSending") : t("transcribing")));
      try {
        const response = await fetch("/api/media/transcriptions", { method: "POST", body: blob, headers: { "content-type": blob.type }, credentials: "same-origin" });
        const body = await response.json().catch(() => ({})) as { text?: string; error?: string };
        if (!response.ok) throw new APIError(response.status, body.error ?? `HTTP ${response.status}`);
        const text = body.text?.trim();
        if (!text) toast(mode.kind === "hold" ? t("noSpeechSent") : t("nothingHeard"), "error");
        else if (mode.kind === "hold") options.send(text, key);
        else options.insert(text, key);
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
    if (mode.kind === "hold") mode.gesture.session = {
      move: (x, y) => {
        const area = options.area()?.getBoundingClientRect();
        const slack = cancelling ? 0 : 12;
        const leaving = Math.hypot(x - mode.gesture.x, y - mode.gesture.y) >= 32 && !!area && (y < area.top - slack || x < area.left - slack);
        if (leaving === cancelling) return;
        cancelling = leaving;
        strip.classList.toggle("cancel", leaving);
        button.classList.toggle("cancel", leaving);
        status.textContent = leaving ? t("releaseToCancel") : t("releaseToSend");
      },
      release: () => finish(!cancelling),
      interrupt: () => { if (!stopping) toast(t("recordingInterrupted"), "error"); finish(false); },
    };
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
    if (mode.kind === "tap") done.focus({ preventScroll: true });
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

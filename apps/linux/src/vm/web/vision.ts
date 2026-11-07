import { OxError, type FunctionCall } from "@openox/agent/linux";
import type { VMContext } from "../context";
import { readProfileFile } from "./attach";
import { inspectImage, isRaster, limits, mimeTypeFor, tooManyPixels } from "./media";

const textLimit = 20_000;
const outputLimit = 4 * 1024 * 1024;
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const recognized = new Map<string, string>();
const languages = new Map<string, Promise<string | undefined>>();
const environment = () => ({ PATH: process.env.PATH ?? "/usr/bin:/bin", ...(process.env.TESSDATA_PREFIX ? { TESSDATA_PREFIX: process.env.TESSDATA_PREFIX } : {}) });
export const tesseractAvailable = () => !!Bun.which("tesseract");

function prefix(text: string, limit: number) {
  if (text.length <= limit) return { text, truncated: false };
  let count = 0;
  for (const { index } of segmenter.segment(text)) {
    if (count === limit) return { text: text.slice(0, index), truncated: true };
    count++;
  }
  return { text, truncated: false };
}

async function bounded(stream: ReadableStream<Uint8Array>, limit: number) {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (size < limit) chunks.push(value.subarray(0, limit - size));
    size += value.length;
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

function language(tool: string) {
  let chosen = languages.get(tool);
  if (!chosen) {
    chosen = (async () => {
      const child = Bun.spawn([tool, "--list-langs"], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: environment() });
      const [output, errors] = await Promise.all([bounded(child.stdout, 65_536), bounded(child.stderr, 65_536), child.exited]);
      const installed = `${output}\n${errors}`.split("\n").map(line => line.trim()).filter(line => /^[A-Za-z_]+$/.test(line));
      const preferred = ["chi_sim", "eng", "chi_tra", "jpn", "kor"].filter(name => installed.includes(name));
      return preferred.length ? preferred.slice(0, 3).join("+") : installed.find(name => !["osd", "equ", "snum"].includes(name));
    })();
    languages.set(tool, chosen);
  }
  return chosen;
}

async function recognize(tool: string, image: Uint8Array, signal: AbortSignal, context: VMContext) {
  const code = await language(tool);
  const child = Bun.spawn([tool, "stdin", "stdout", ...(code ? ["-l", code] : [])], { stdin: image, stdout: "pipe", stderr: "pipe", env: environment() });
  const stop = () => child.kill("SIGKILL");
  signal.addEventListener("abort", stop, { once: true });
  if (signal.aborted) stop();
  const timer = setTimeout(stop, 60_000);
  try {
    const [output, errors, status] = await Promise.all([bounded(child.stdout, outputLimit), bounded(child.stderr, 4_096), child.exited]);
    if (signal.aborted) throw new OxError("cancelled", "The operation was cancelled.", "Stop. Do not repeat the operation unless the user asks.");
    if (status !== 0) {
      context.logs.warning("vision", `tesseract exited with ${status}: ${errors.trim().split("\n").at(-1) ?? ""}`);
      throw new OxError("operation_failed", "ox.vision.analyze: text recognition failed", "Check that the file is a readable image. Do not retry the same image unchanged.");
    }
    return output.replaceAll("\f", "").split("\n").map(line => line.trimEnd()).filter(line => line.trim()).join("\n");
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", stop);
  }
}

export function visionAnalyzer(context: VMContext) {
  return async (call: FunctionCall) => {
    const tool = Bun.which("tesseract");
    if (!tool) {
      throw new OxError("not_supported", "ox.vision.analyze needs the tesseract OCR tool, which is not installed on this Host",
        "Tell the user that reading text in images is unavailable until tesseract-ocr is installed on the Host. When a model with image input is selected, ox.fs.attach can send the pixels instead.");
    }
    const tooLarge = (size: number) => new OxError("resource_limit", `File too large (${size} bytes; limit ${limits.file}).`, "Choose a smaller file within the reported size limit.");
    const { entry, data } = await readProfileFile(call, String(call.args.source), limits.file, tooLarge);
    const mimeType = mimeTypeFor(entry.name);
    if (!mimeType.startsWith("image/") || mimeType === "image/svg+xml") throw new OxError("invalid_argument", `ox.vision.analyze: file is not an image: ${entry.path}`, "Pass the path of a PNG, JPEG, GIF or WebP image.");
    const info = inspectImage(data);
    const detected = info?.mimeType;
    if (!isRaster(info)) {
      throw new OxError("not_supported", `ox.vision.analyze: unsupported image format${detected ? ` ${detected}` : ""}: ${entry.path}`, "Convert the image to PNG, JPEG, GIF or WebP.");
    }
    if (tooManyPixels(info)) throw new OxError("resource_limit", "ox.vision.analyze: image exceeded the 40 megapixel limit", "Use a smaller image.");
    const key = new Bun.CryptoHasher("sha256").update(data).digest("hex");
    let text = recognized.get(key);
    if (text === undefined) {
      let image: Uint8Array = data;
      if (info.format !== "png") {
        try { image = await new Bun.Image(data, { maxPixels: limits.pixels }).png().bytes(); }
        catch { throw new OxError("not_supported", `ox.vision.analyze: image could not be analyzed: ${entry.path}`, "Check that the image file is complete and readable."); }
      }
      text = await recognize(tool, image, call.signal, context);
      recognized.set(key, text);
      if (recognized.size > 32) recognized.delete(recognized.keys().next().value!);
    }
    const result = prefix(text, textLimit);
    return { filename: entry.name, mimeType, pixelWidth: info.width, pixelHeight: info.height, recognizedText: result.text, recognizedTextTruncated: result.truncated,
      classifications: [], processing: "on-device" };
  };
}

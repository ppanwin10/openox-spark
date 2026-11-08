import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { officeDocument, officePDF, OxError, type FunctionCall } from "@openox/agent/linux";
import { bodyBytes, HTTPError, json, payload } from "../http";
import { MediaClient, MediaError } from "../media";
import type { VMContext, VMFactory } from "./context";
import { profilePath, readProfileFile } from "./web/attach";
import { mimeTypeFor } from "./web/media";

const fileLimit = 200 * 1024 * 1024;
const recordingLimit = 25 * 1024 * 1024;
const pageLimit = 20;
const pdfSignature = (data: Uint8Array) => data.length > 4 && data[0] === 0x25 && data[1] === 0x50 && data[2] === 0x44 && data[3] === 0x46;
const tooLarge = (name: string) => () => new OxError("resource_limit", `${name}: the file is larger than 200 MB`, "Ask the user for a shorter or smaller file.");
const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
const reservedRoots = new Set(["skills", "repositories", "mounts", "app"]);
const shapes: Record<string, string> = { "1:1": "1024x1024", "4:3": "1280x960", "3:4": "960x1280", "3:2": "1344x896", "2:3": "896x1344", "16:9": "1344x768", "9:16": "768x1344" };
const stem = (path: string) => basename(path, extname(path)).replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "file";

function failure(name: string, error: unknown): never {
  if (error instanceof OxError || !(error instanceof MediaError)) throw error;
  if (error.kind === "unreachable" || error.status === 404) {
    throw new OxError("unavailable", `${name}: the media service isn't running on this Host.`, "Tell the user this feature needs the OpenOx media service on the Host, then continue without it.");
  }
  if (error.kind === "not_installed") throw new OxError("unavailable", `${name}: ${error.message}`, "Tell the user this model isn't installed on the Host yet; installing it is `apps/linux/deploy/media.sh --download`. Continue without it.");
  if (error.status === 503) throw new OxError("unavailable", `${name}: ${error.message}`, "Tell the user the Host is short of memory for this model right now. Do not retry immediately.");
  if (error.status === 400 || error.status === 413 || error.status === 422) throw new OxError("invalid_argument", `${name}: ${error.message}`, "Check the file or arguments before retrying.");
  throw new OxError("operation_failed", `${name}: ${error.message}`, "Do not retry the same request unchanged.");
}

async function target(call: FunctionCall, requested: unknown, fallback: string, extension: string) {
  if (typeof requested === "string" && requested.trim()) {
    const path = profilePath(requested.trim(), call.conversationId);
    const root = path.split("/")[0]!;
    if (reservedRoots.has(root) || path === "MEMORY.md") {
      throw new OxError("permission_denied", `${call.name}: generated media can't be saved in ${root}/`, "Omit path to save in the conversation folder, or use a shared folder such as reports/.");
    }
    if (extname(path).toLowerCase() !== extension) throw new OxError("invalid_argument", `${call.name}: path must end in ${extension}`, `Pass a path ending in ${extension}, or omit path.`);
    return path;
  }
  const directory = `conversations/${call.conversationId}`;
  for (let index = 1; index < 1_000; index++) {
    const candidate = `${directory}/${fallback}${index === 1 ? "" : `-${index}`}${extension}`;
    if (!await call.profile.statFile(candidate).then(() => true, () => false)) return candidate;
  }
  throw new OxError("conflict", `${call.name}: too many files with this name`, "Pass an explicit path.");
}

async function emptyFolder(call: FunctionCall, base: string) {
  const directory = `conversations/${call.conversationId}`;
  for (let index = 1; index < 1_000; index++) {
    const candidate = `${directory}/${base}${index === 1 ? "" : `-${index}`}`;
    if (!await call.profile.statFile(candidate).then(() => true, () => false)) return candidate;
  }
  throw new OxError("conflict", `${call.name}: too many folders with this name`, "Remove older output folders from the conversation.");
}

async function run(tool: string, args: string[], timeout: number, signal: AbortSignal) {
  const child = Bun.spawn([tool, ...args], { stdout: "pipe", stderr: "ignore", stdin: "ignore", detached: true, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } });
  const kill = () => { try { process.kill(-child.pid, "SIGKILL"); } catch {} };
  const timer = setTimeout(kill, timeout);
  signal.addEventListener("abort", kill, { once: true });
  try {
    const output = await new Response(child.stdout).text();
    return { code: await child.exited, output };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", kill);
  }
}
const cancelled = (call: FunctionCall) => new OxError("cancelled", `${call.name}: stopped before the pages were rendered`, "Stop. Do not retry unless the user asks.");

async function pages(context: VMContext, call: FunctionCall) {
  const { entry, data } = await readProfileFile(call, String(call.args.path), fileLimit, tooLarge(call.name));
  let pdf: Uint8Array = data;
  if (!pdfSignature(data)) {
    if (!officeDocument(data)) throw new OxError("invalid_argument", `${call.name}: ${entry.path} is not a PDF, Word, PowerPoint or Excel file`, "Pass a PDF or an Office document.");
    const converted = await officePDF(data, context.paths.scratch, call.signal);
    if (call.signal.aborted) throw cancelled(call);
    if ("unsupported" in converted) throw new OxError("not_supported", `${call.name}: ${converted.unsupported}`, "Read the file as text with ox.fs.read instead.");
    pdf = converted.pdf;
  }
  const info = Bun.which("pdfinfo"), render = Bun.which("pdftoppm");
  if (!info || !render) throw new OxError("not_supported", `${call.name}: rendering pages needs poppler-utils (pdfinfo and pdftoppm) on this Host`, "Read the file as text with ox.fs.read instead.");
  const scratch = join(context.paths.scratch, `pages-${crypto.randomUUID()}`);
  await mkdir(scratch, { recursive: true, mode: 0o700 });
  try {
    const input = join(scratch, "document.pdf");
    await writeFile(input, pdf, { mode: 0o600 });
    const counted = await run(info, [input], 60_000, call.signal);
    if (call.signal.aborted) throw cancelled(call);
    const pageCount = Number(/^Pages:\s+(\d+)/m.exec(counted.output)?.[1] ?? 0);
    if (counted.code !== 0 || !pageCount) throw new OxError("operation_failed", `${call.name}: the document could not be opened; it may be damaged or protected`, "Do not retry the same file unchanged.");
    const first = Math.max(1, Number(call.args.first ?? 1));
    if (first > pageCount) throw new OxError("invalid_argument", `${call.name}: the document has ${pageCount} pages`, `Pass first between 1 and ${pageCount}.`);
    const last = Math.min(pageCount, Number(call.args.last ?? first + pageLimit - 1), first + pageLimit - 1);
    if (last < first) throw new OxError("invalid_argument", `${call.name}: last must not be before first`, "Pass last greater than or equal to first.");
    const rendered = await run(render, ["-r", "150", "-png", "-f", String(first), "-l", String(last), input, join(scratch, "page")], 300_000, call.signal);
    if (call.signal.aborted) throw cancelled(call);
    if (rendered.code !== 0) throw new OxError("operation_failed", `${call.name}: the pages could not be rendered`, "Do not retry the same file unchanged.");
    const images = (await readdir(scratch)).filter(name => /^page-\d+\.png$/.test(name)).sort((a, b) => Number(/\d+/.exec(a)![0]) - Number(/\d+/.exec(b)![0]));
    const folder = await emptyFolder(call, `${stem(entry.path)}-pages`);
    const width = String(pageCount).length;
    const saved: { page: number; path: string }[] = [];
    for (const image of images) {
      const page = Number(/\d+/.exec(image)![0]);
      const path = `${folder}/page-${String(page).padStart(width, "0")}.png`;
      await call.profile.writeFile(path, new Uint8Array(await readFile(join(scratch, image))));
      saved.push({ page, path });
    }
    return { path: entry.path, pageCount, pages: saved };
  } finally { await rm(scratch, { recursive: true, force: true }); }
}

export const mediaModule: VMFactory = (context: VMContext) => {
  const media = new MediaClient();
  const handlers: Record<string, (call: FunctionCall) => Promise<unknown>> = {
    "ox.media.generateImage": async call => {
      const size = typeof call.args.size === "string" ? call.args.size : shapes[String(call.args.aspectRatio)] ?? "1024x1024";
      const [width, height] = size.split("x").map(Number) as [number, number];
      if ([width, height].some(side => side < 512 || side > 1536 || side % 64)) {
        throw new OxError("invalid_argument", `${call.name}: each side must be 512-1536 and a multiple of 64`, "Use a size such as 1024x1024, 1536x1024 or 1024x1536.");
      }
      const path = await target(call, call.args.path, `image-${stamp()}`, ".png");
      await call.update({ path });
      const data = await call.untimed(() => media.image(String(call.args.prompt), size, typeof call.args.seed === "number" ? call.args.seed : undefined, call.signal)).catch(error => failure(call.name, error));
      await call.profile.writeFile(path, data);
      context.logs.info("media", `image size=${size} bytes=${data.length}`);
      return { path, mimeType: "image/png", width, height, bytes: data.length, model: "Z-Image-Turbo" };
    },
    "ox.media.transcribe": async call => {
      const { entry, data } = await readProfileFile(call, String(call.args.path), fileLimit, tooLarge(call.name));
      const language = typeof call.args.language === "string" && call.args.language.trim() ? call.args.language.trim() : undefined;
      const result = await call.untimed(() => media.transcribe(data, entry.name, mimeTypeFor(entry.name), language, call.signal)).catch(error => failure(call.name, error));
      context.logs.info("media", `transcribe bytes=${data.length} chars=${result.text.length}`);
      return { path: entry.path, text: result.text, language: result.language };
    },
    "ox.media.speak": async call => {
      const path = await target(call, call.args.path, `speech-${stamp()}`, ".wav");
      const data = await call.untimed(() => media.speech(String(call.args.text), typeof call.args.voice === "string" ? call.args.voice : undefined, call.signal)).catch(error => failure(call.name, error));
      await call.profile.writeFile(path, data);
      await call.update({ path });
      return { path, mimeType: "audio/wav", bytes: data.length };
    },
    "ox.media.inspectVideo": async call => {
      const { entry, data } = await readProfileFile(call, String(call.args.path), fileLimit, tooLarge(call.name));
      const maxFrames = Math.min(24, Math.max(1, Number(call.args.maxFrames ?? 8)));
      const extracted = await call.untimed(() => media.extract(data, entry.name, mimeTypeFor(entry.name), maxFrames, call.args.transcribe !== false, call.signal)).catch(error => failure(call.name, error));
      if (extracted.kind !== "video") throw new OxError("invalid_argument", `${call.name}: ${entry.path} has no video track`, "Use ox.media.transcribe for audio files.");
      const folder = await emptyFolder(call, `${stem(entry.path)}-frames`);
      const frames: { time: number; path: string }[] = [];
      for (const [index, frame] of extracted.frames.entries()) {
        const path = `${folder}/frame-${String(index + 1).padStart(2, "0")}.jpg`;
        await call.profile.writeFile(path, frame.data);
        frames.push({ time: Math.round(frame.time * 10) / 10, path });
      }
      context.logs.info("media", `video frames=${frames.length} duration=${extracted.duration.toFixed(1)}`);
      return { path: entry.path, duration: Math.round(extracted.duration * 10) / 10, width: extracted.width, height: extracted.height, frames, transcript: extracted.transcript };
    },
    "ox.media.renderPages": async call => call.untimed(() => pages(context, call)),
  };
  return {
    handlers,
    limitations: ["Audio and video attachments are not sent to the model directly: transcribe audio with ox.media.transcribe and look at videos with ox.media.inspectVideo. Images you generate with ox.media.generateImage are saved in the conversation folder."],
    routes: {
      media: async (request, _url, parts) => {
        if (!parts.length && request.method === "GET") return json(await media.health());
        const call = async <T>(work: () => Promise<T>) => {
          try { return await work(); }
          catch (error) {
            if (!(error instanceof MediaError)) throw error;
            throw new HTTPError(error.kind === "unreachable" ? 503 : error.status >= 400 && error.status < 600 ? error.status : 502, error.message);
          }
        };
        if (parts.length === 1 && parts[0] === "transcriptions" && request.method === "POST") {
          const data = await bodyBytes(request, recordingLimit, "Recordings are limited to 25 MB");
          if (!data.length) throw new HTTPError(400, "The recording is empty");
          const type = (request.headers.get("content-type") ?? "audio/webm").split(";", 1)[0]!.trim();
          const extension = type.includes("mp4") || type.includes("m4a") || type.includes("aac") ? "m4a" : type.includes("ogg") ? "ogg" : type.includes("wav") ? "wav" : "webm";
          const result = await call(() => media.transcribe(data, `recording.${extension}`, type));
          context.logs.info("media", `dictation bytes=${data.length} chars=${result.text.length}`);
          return json(result);
        }
        if (parts.length === 1 && parts[0] === "speech" && request.method === "POST") {
          const body = await payload<{ text?: unknown; voice?: unknown }>(request);
          const text = typeof body.text === "string" ? body.text.trim() : "";
          if (!text) throw new HTTPError(400, "Text is required");
          if (text.length > 2_000) throw new HTTPError(400, "Text is limited to 2,000 characters");
          const audio = await call(() => media.speech(text, typeof body.voice === "string" ? body.voice : undefined));
          return new Response(audio, { headers: { "content-type": "audio/wav", "cache-control": "no-store" } });
        }
        throw new HTTPError(404, "Not found");
      },
    },
  };
};

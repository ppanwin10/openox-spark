import { isUtf8 } from "node:buffer";
import { documentText, OxError, type Attachment, type FunctionCall } from "@openox/agent/linux";
import type { VMContext } from "../context";
import { fetchResource, webURL } from "./client";
import { attachmentError, extensionFor, imageFilename, inspectImage, isRaster, isTextType, limits, mimeTypeFor, prepareImage, sanitizedFilename, tooManyPixels,
  webFilename, type ImageInfo } from "./media";
import { utf8Length } from "./text";

interface Source { data: Uint8Array; type: string; name?: string; url?: string; reference?: string }
interface Prepared { kind: "image" | "pdf" | "text" | "file"; mimeType: string; filename: string; data: Uint8Array; raster?: ImageInfo }

const roots = new Set(["app", "MEMORY.md", "skills", "repositories", "mounts", "files", "artifacts", "conversations", "history", "chats", "tmp"]);
const pdfSignature = (data: Uint8Array) => data.length > 4 && data[0] === 0x25 && data[1] === 0x50 && data[2] === 0x44 && data[3] === 0x46 && data[4] === 0x2d;
const guidance = {
  image: "Image input is unavailable for this model. Use ox.vision.analyze with the file reference/path for on-device OCR, or switch to a model with image input when original pixels are needed.",
  file: "Native input support for this binary format is unavailable or unverified for this model and transport. ox.fs.read cannot decode this binary format. Use an attached service only if it supports extracting this format; otherwise explain the limitation and request a text, image, or PDF export, or a compatible model/provider.",
};
const omitted = (source: string, reason: string) => `Attachment omitted from this model request. Its contents are not included. ${source} ${reason} Do not repeat ox.fs.attach for the same unsupported file. Use only available tools; if extraction is unavailable, explain the limitation instead of claiming to have read the file.`;

export function profilePath(path: string, conversationId: number) {
  if (!path.startsWith("/") && !roots.has(path.split("/")[0]!)) return path === "." || path === "" ? `conversations/${conversationId}` : `conversations/${conversationId}/${path}`;
  const parts = (path.startsWith("/") ? path.slice(1) : path).split("/");
  if (parts[0] === "files") parts[0] = "mounts";
  if (parts[0] === "history" || parts[0] === "chats") {
    parts[0] = "conversations";
    if (parts[2] === "messages.jsonl" || parts[2] === "history") parts[2] = "turns.jsonl";
    if (parts[2] === "metadata") parts[2] = "conversation.json";
  }
  return parts.join("/");
}

export async function readProfileFile(call: FunctionCall, path: string, limit: number, tooLarge: (size: number) => OxError) {
  const { entry, file } = await call.profile.openFile(profilePath(path, call.conversationId));
  if (entry.size > limit) throw tooLarge(entry.size);
  const data = new Uint8Array(await file.slice(0, limit + 1).arrayBuffer());
  if (data.length > limit) throw tooLarge(data.length);
  return { entry, data };
}

async function prepare(source: Source): Promise<Prepared> {
  const { data, type: declared } = source;
  if (!data.length) throw attachmentError.empty();
  const detected = inspectImage(data);
  const raster = isRaster(detected) ? detected : undefined;
  if (raster && tooManyPixels(raster)) throw attachmentError.imageTooLarge();
  const named = (type: string) => source.url ? webFilename(source.url, type) : sanitizedFilename(source.name ?? "File");
  const image = async (): Promise<Prepared> => {
    const prepared = await prepareImage(data, raster!);
    return { kind: "image", mimeType: prepared.mimeType, filename: imageFilename(named(prepared.mimeType), prepared.extension), data: prepared.data, raster };
  };
  if (declared.startsWith("image/")) {
    if (!raster) {
      if (declared === "image/svg+xml" || declared === "image/heic" || declared === "image/heif" || declared === "image/avif") throw attachmentError.unsupportedImage(declared);
      throw attachmentError.invalidImage();
    }
    const alias = (type: string) => type === "image/jpg" ? "image/jpeg" : type;
    if (alias(declared) !== raster.mimeType) throw attachmentError.mismatch(declared, raster.mimeType);
    return image();
  }
  if (declared === "application/pdf") {
    if (!pdfSignature(data)) throw attachmentError.invalidPDF();
    return { kind: "pdf", mimeType: declared, filename: named(declared), data };
  }
  if (declared === "application/octet-stream" && raster) return image();
  if (declared === "application/octet-stream" && pdfSignature(data)) return { kind: "pdf", mimeType: "application/pdf", filename: named("application/pdf"), data };
  if (isTextType(declared)) {
    if (!isUtf8(data)) throw attachmentError.invalidText();
    return { kind: "text", mimeType: declared, filename: named(declared), data };
  }
  if (declared === "application/octet-stream" && isUtf8(data) && !data.includes(0)) return { kind: "text", mimeType: "text/plain", filename: named("text/plain"), data };
  return { kind: "file", mimeType: declared, filename: named(declared), data };
}

async function modelContent(prepared: Prepared, reference: string, images: boolean, scratch: string): Promise<Attachment> {
  const base = { name: prepared.filename, mimeType: prepared.mimeType, bytes: prepared.data.length };
  const source = `Available file reference: ${JSON.stringify(reference)}.`;
  if (prepared.kind === "image") return images ? { ...base, data: Buffer.from(prepared.data).toString("base64") } : { ...base, text: omitted(source, guidance.image) };
  if (prepared.kind === "text") return { ...base, text: new TextDecoder().decode(prepared.data) };
  if (prepared.kind === "file") return { ...base, text: omitted(source, guidance.file) };
  const read = await documentText(prepared.data, scratch);
  if ("text" in read && utf8Length(read.text) <= limits.source) return { ...base, text: read.text };
  const reason = "unsupported" in read ? read.unsupported : "Extracted PDF text exceeds the 10 MiB attachment limit; read it in parts with ox.fs.read.";
  return { ...base, text: omitted(source, `PDF input is unavailable for this model and its text could not be extracted: ${reason}`) };
}

async function acceptsImages(call: FunctionCall, context: VMContext) {
  const { model } = await call.profile.summary(call.conversationId);
  return !!model && !!context.providers.models.getModel(model.provider, model.modelId)?.input.includes("image");
}

export async function attach(call: FunctionCall, context: VMContext) {
  const path = String(call.args.path);
  const attachments = call.execution.attachments;
  if (attachments.length >= limits.attachments) throw attachmentError.tooMany();
  let source: Source;
  if (/^https?:/i.test(path)) {
    const response = await fetchResource(call, webURL(call.name, path));
    if (response.status < 200 || response.status > 299) {
      throw new OxError("http_error", `${call.name}: HTTP ${response.status}`, "The server did not return the file. Check the URL, or use ox.web.fetch to inspect the response.");
    }
    source = { data: response.data, type: response.mimeType, url: response.url };
  } else {
    const { entry, data } = await readProfileFile(call, path, limits.source, () => attachmentError.tooLarge());
    source = { data, type: mimeTypeFor(entry.name), name: entry.name, reference: entry.path };
  }
  const prepared = await prepare(source);
  const extension = prepared.raster ? prepared.raster.format === "jpeg" ? "jpg" : prepared.raster.format : extensionFor(source.type === "application/octet-stream" ? prepared.mimeType : source.type);
  const reference = source.reference ?? `conversations/${call.conversationId}/media-${crypto.randomUUID().toUpperCase()}.${extension}`;
  const attachment = await modelContent(prepared, reference, await acceptsImages(call, context), context.paths.scratch);
  if (attachments.length >= limits.attachments) throw attachmentError.tooMany();
  if (attachments.reduce((total, item) => total + item.bytes, attachment.bytes) > limits.total) throw attachmentError.tooLarge();
  attachments.push(attachment);
  if (!source.reference) {
    try { await call.profile.writeFile(reference, source.data); }
    catch (error) {
      attachments.splice(attachments.indexOf(attachment), 1);
      throw error;
    }
  }
  return { filename: prepared.filename, contentType: prepared.mimeType, bytes: prepared.data.length, kind: prepared.kind };
}

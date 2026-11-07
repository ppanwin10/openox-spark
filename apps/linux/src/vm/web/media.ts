import { OxError } from "@openox/agent/linux";

type Kind = "image" | "pdf" | "text" | "html" | "file";
export interface ImageInfo { format: "png" | "jpeg" | "gif" | "webp" | "heic" | "avif" | "bmp" | "tiff"; mimeType: string; width: number; height: number; alpha: boolean }
export const limits = { source: 10 * 1024 * 1024, total: 20 * 1024 * 1024, file: 32 * 1024 * 1024, pixels: 40_000_000, dimension: 1568, attachments: 4 };

const extensionTypes = new Map(Object.entries({
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", jpe: "image/jpeg", gif: "image/gif", webp: "image/webp", heic: "image/heic", heif: "image/heif",
  avif: "image/avif", bmp: "image/bmp", tif: "image/tiff", tiff: "image/tiff", svg: "image/svg+xml", ico: "image/vnd.microsoft.icon", pdf: "application/pdf",
  html: "text/html", htm: "text/html", xhtml: "application/xhtml+xml", md: "text/markdown", markdown: "text/markdown", txt: "text/plain", text: "text/plain",
  log: "text/plain", csv: "text/csv", tsv: "text/tab-separated-values", json: "application/json", xml: "application/xml", rss: "application/rss+xml",
  atom: "application/atom+xml", css: "text/css", js: "text/javascript", mjs: "text/javascript", cjs: "text/javascript", yaml: "application/yaml",
  yml: "application/yaml", sh: "application/x-sh", ics: "text/calendar", vcf: "text/vcard", rtf: "text/rtf", zip: "application/zip", gz: "application/gzip",
  mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
}));
const sourceExtensions = new Set(["ts", "tsx", "jsx", "py", "rb", "go", "rs", "swift", "java", "kt", "kts", "c", "h", "cc", "cpp", "cxx", "hpp", "hh", "cs", "php",
  "pl", "pm", "lua", "r", "scala", "sql", "toml", "ini", "cfg", "conf", "env", "jsonl", "ndjson", "tex", "rst", "adoc", "org", "diff", "patch", "srt", "vtt",
  "gradle", "vue", "svelte", "dart", "ex", "exs", "erl", "hs", "clj", "ml", "groovy", "ps1", "bat", "zsh", "bash", "fish", "proto", "graphql", "gql", "zig", "nim"]);
const typeExtensions = new Map(Object.entries({
  "text/html": "html", "application/xhtml+xml": "xhtml", "text/plain": "txt", "text/markdown": "md", "text/csv": "csv", "text/css": "css",
  "text/javascript": "js", "application/javascript": "js", "application/json": "json", "application/xml": "xml", "text/xml": "xml", "application/rss+xml": "rss",
  "application/atom+xml": "atom", "application/pdf": "pdf", "image/png": "png", "image/jpeg": "jpeg", "image/gif": "gif", "image/webp": "webp",
  "image/svg+xml": "svg", "image/heic": "heic", "image/avif": "avif", "image/bmp": "bmp", "image/tiff": "tiff", "application/zip": "zip",
  "application/gzip": "gz", "application/yaml": "yaml", "text/calendar": "ics", "audio/mpeg": "mp3", "video/mp4": "mp4",
}));

export const extensionFor = (type: string) => typeExtensions.get(type) ?? "bin";
export const mediaType = (header: string | null) => header?.split(";", 1)[0]?.trim().toLowerCase() || "application/octet-stream";
export const isTextType = (type: string) => type.startsWith("text/") || type === "application/json" || type.endsWith("+json") || type === "application/xml"
  || type.endsWith("+xml") || type === "application/javascript" || type === "application/x-javascript" || type === "application/yaml" || type === "application/x-yaml"
  || type === "application/x-sh" || type === "application/sql" || type === "application/toml";

export function kindOf(type: string): Kind {
  if (type === "text/html" || type === "application/xhtml+xml") return "html";
  if (type.startsWith("image/")) return "image";
  if (type === "application/pdf") return "pdf";
  return isTextType(type) ? "text" : "file";
}

export function mimeTypeFor(name: string) {
  const extension = /\.([^./]+)$/.exec(name)?.[1]?.toLowerCase() ?? "";
  if (sourceExtensions.has(extension)) return "text/plain";
  return extensionTypes.get(extension) ?? mediaType(extension ? Bun.file(`file.${extension}`).type : null);
}

const family = (type: string) => type === "image/jpg" ? "image/jpeg" : type === "text/xml" || type.endsWith("+xml") ? "application/xml" : type.endsWith("+json") ? "application/json" : type;

export function webFilename(url: string, type: string) {
  const path = new URL(url).pathname;
  const trimmed = path.replace(/\/+$/, "");
  const last = trimmed ? trimmed.slice(trimmed.lastIndexOf("/") + 1) : path;
  let raw = last;
  try { raw = decodeURIComponent(last); } catch {}
  const safe = raw.replace(/[^A-Za-z0-9._-]/gu, "-");
  const extension = typeExtensions.get(type) ?? "bin";
  if (!/[A-Za-z0-9]/.test(safe)) return `web-response.${extension}`;
  const bounded = safe.slice(0, 120);
  const existing = /\.[^.]+$/.test(bounded) ? mimeTypeFor(bounded) : undefined;
  return existing && (family(existing) === family(type) || (type === "text/plain" && existing.startsWith("text/"))) ? bounded : `${bounded}.${extension}`;
}

export function sanitizedFilename(name: string) {
  const value = name.normalize("NFC").split(/[/:\p{Cc}]/u).join(" ").trim();
  if (!value || value === "." || value === "..") return "File";
  const characters = Array.from(value);
  return characters.length > 180 ? characters.slice(0, 180).join("") : value;
}

export const imageFilename = (name: string, extension: string) => `${name.replace(/(.)\.[^.]*$/, "$1")}.${extension}`;

const ascii = (bytes: Uint8Array, start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end));
const u16be = (bytes: Uint8Array, at: number) => (bytes[at]! << 8) | bytes[at + 1]!;
const u16le = (bytes: Uint8Array, at: number) => bytes[at]! | (bytes[at + 1]! << 8);
const u24le = (bytes: Uint8Array, at: number) => bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16);
const u32be = (bytes: Uint8Array, at: number) => (bytes[at]! * 0x1000000) + ((bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!);

function jpegSize(bytes: Uint8Array) {
  let offset = 2;
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) return undefined;
    const marker = bytes[offset + 1]!;
    if (marker === 0xff) { offset++; continue; }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { offset += 2; continue; }
    if (marker === 0xd9 || marker === 0xda) return undefined;
    const size = u16be(bytes, offset + 2);
    if (size < 2) return undefined;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return offset + 9 <= bytes.length ? { height: u16be(bytes, offset + 5), width: u16be(bytes, offset + 7) } : undefined;
    }
    offset += 2 + size;
  }
  return undefined;
}

export function inspectImage(bytes: Uint8Array): ImageInfo | undefined {
  if (bytes.length >= 26 && ascii(bytes, 0, 8) === "\x89PNG\r\n\x1a\n" && ascii(bytes, 12, 16) === "IHDR") {
    return { format: "png", mimeType: "image/png", width: u32be(bytes, 16), height: u32be(bytes, 20), alpha: bytes[25] === 4 || bytes[25] === 6 };
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    const size = jpegSize(bytes);
    return size && { format: "jpeg", mimeType: "image/jpeg", ...size, alpha: false };
  }
  if (bytes.length >= 10 && /^GIF8[79]a$/.test(ascii(bytes, 0, 6))) return { format: "gif", mimeType: "image/gif", width: u16le(bytes, 6), height: u16le(bytes, 8), alpha: false };
  if (bytes.length >= 30 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") {
    const chunk = ascii(bytes, 12, 16);
    const webp = (width: number, height: number, alpha: boolean): ImageInfo => ({ format: "webp", mimeType: "image/webp", width, height, alpha });
    if (chunk === "VP8 " && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) return webp(u16le(bytes, 26) & 0x3fff, u16le(bytes, 28) & 0x3fff, false);
    if (chunk === "VP8L" && bytes[20] === 0x2f) {
      const bits = bytes[21]! | (bytes[22]! << 8) | (bytes[23]! << 16) | (bytes[24]! << 24);
      return webp((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1, ((bits >>> 28) & 1) === 1);
    }
    if (chunk === "VP8X") return webp(u24le(bytes, 24) + 1, u24le(bytes, 27) + 1, (bytes[20]! & 0x10) !== 0);
    return undefined;
  }
  if (bytes.length >= 12 && ascii(bytes, 4, 8) === "ftyp") {
    const brand = ascii(bytes, 8, 12);
    if (["avif", "avis"].includes(brand)) return { format: "avif", mimeType: "image/avif", width: 0, height: 0, alpha: false };
    if (["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1"].includes(brand)) return { format: "heic", mimeType: "image/heic", width: 0, height: 0, alpha: false };
  }
  if (bytes.length >= 26 && ascii(bytes, 0, 2) === "BM") return { format: "bmp", mimeType: "image/bmp", width: 0, height: 0, alpha: false };
  if (bytes.length >= 8 && ["II*\0", "MM\0*"].includes(ascii(bytes, 0, 4))) return { format: "tiff", mimeType: "image/tiff", width: 0, height: 0, alpha: false };
  return undefined;
}

export const isRaster = (info: ImageInfo | undefined): info is ImageInfo => !!info && ["png", "jpeg", "gif", "webp"].includes(info.format) && info.width > 0 && info.height > 0;
export const tooManyPixels = (info: ImageInfo) => info.width > Math.floor(limits.pixels / info.height);

export const attachmentError = {
  tooMany: () => new OxError("resource_limit", "Attachments: one JavaScript execution may attach at most four sources", "Attach the remaining sources in a later execution."),
  tooLarge: () => new OxError("resource_limit", "Attachments: exceeded the attachment size limit (10 MiB per source, 20 MiB per execution)", "Attach a smaller source, or attach it in a later execution."),
  empty: () => new OxError("invalid_argument", "Attachments: source is empty", "Check the path or URL; there is nothing to attach."),
  unsupportedImage: (type: string) => new OxError("not_supported", `Attachments: unsupported image content type ${type}`, "Convert the image to PNG, JPEG, GIF or WebP, or describe it with ox.vision.analyze after conversion."),
  mismatch: (declared: string, decoded: string) => new OxError("invalid_argument", `Attachments: declared content type ${declared} does not match ${decoded}`, "Do not retry the same source; its content type is wrong."),
  invalidImage: () => new OxError("not_supported", "Attachments: source was not a supported raster image", "Use a PNG, JPEG, GIF or WebP image."),
  imageTooLarge: () => new OxError("resource_limit", "Attachments: image exceeded the 40 megapixel limit", "Use a smaller image."),
  invalidPDF: () => new OxError("not_supported", "Attachments: source was not a valid PDF", "Check that the source is a PDF document."),
  invalidText: () => new OxError("not_supported", "Attachments: text source was not valid UTF-8", "Request a UTF-8 export of the source."),
};

export async function prepareImage(bytes: Uint8Array, info: ImageInfo) {
  const lossless = info.format === "png" || info.format === "gif" || info.alpha;
  try {
    const image = new Bun.Image(bytes, { maxPixels: limits.pixels }).resize(limits.dimension, limits.dimension, { fit: "inside", withoutEnlargement: true });
    const data = await (lossless ? image.png() : image.jpeg({ quality: 85 })).bytes();
    return { data, mimeType: lossless ? "image/png" : "image/jpeg", extension: lossless ? "png" : "jpg" };
  } catch (error) {
    if ((error as { code?: string }).code === "ERR_IMAGE_TOO_MANY_PIXELS") throw attachmentError.imageTooLarge();
    throw attachmentError.invalidImage();
  }
}

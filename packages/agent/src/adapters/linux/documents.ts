import { isUtf8 } from "node:buffer";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export type DocumentText = { text: string } | { unsupported: string };
const pdf = (bytes: Uint8Array) => bytes.length > 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
const outputLimit = 32 * 1024 * 1024;

type OfficeKind = "text" | "sheet" | "slides";
const latin = new TextDecoder("latin1");
const wide = (name: string) => [...name].join("\u0000");

export function officeDocument(bytes: Uint8Array): { kind: OfficeKind; extension: string } | undefined {
  if (bytes.length < 8) return undefined;
  if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) {
    const names = latin.decode(bytes.subarray(0, 1_048_576)) + latin.decode(bytes.subarray(Math.max(0, bytes.length - 262_144)));
    if (names.includes("mimetypeapplication/vnd.oasis.opendocument.text")) return { kind: "text", extension: "odt" };
    if (names.includes("mimetypeapplication/vnd.oasis.opendocument.spreadsheet")) return { kind: "sheet", extension: "ods" };
    if (names.includes("mimetypeapplication/vnd.oasis.opendocument.presentation")) return { kind: "slides", extension: "odp" };
    if (names.includes("word/document")) return { kind: "text", extension: "docx" };
    if (names.includes("xl/workbook")) return { kind: "sheet", extension: "xlsx" };
    if (names.includes("ppt/presentation")) return { kind: "slides", extension: "pptx" };
    return undefined;
  }
  if (bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) {
    const names = latin.decode(bytes.subarray(0, 4_194_304));
    if (names.includes(wide("WordDocument"))) return { kind: "text", extension: "doc" };
    if (names.includes(wide("Workbook")) || names.includes(wide("Book"))) return { kind: "sheet", extension: "xls" };
    if (names.includes(wide("PowerPoint Document"))) return { kind: "slides", extension: "ppt" };
  }
  if (latin.decode(bytes.subarray(0, 5)) === "{\\rtf") return { kind: "text", extension: "rtf" };
  return undefined;
}

async function converted(bytes: Uint8Array, scratch: string, extension: string, target: string, signal?: AbortSignal): Promise<{ directory: string; files: string[] } | { unsupported: string }> {
  const tool = Bun.which("soffice") ?? Bun.which("libreoffice");
  if (!tool) return { unsupported: "Reading Office files needs LibreOffice (soffice) on this Host." };
  const directory = join(scratch, `office-${crypto.randomUUID()}`);
  await mkdir(join(directory, "out"), { recursive: true, mode: 0o700 });
  const input = join(directory, `document.${extension}`);
  await writeFile(input, bytes, { mode: 0o600 });
  const child = Bun.spawn([tool, "--headless", "--norestore", "--nolockcheck", "--nodefault", `-env:UserInstallation=${pathToFileURL(join(directory, "profile")).href}`,
    "--convert-to", target, "--outdir", join(directory, "out"), input], { stdout: "ignore", stderr: "ignore", stdin: "ignore", detached: true, env: { HOME: directory, PATH: process.env.PATH ?? "/usr/bin:/bin" } });
  const kill = () => { try { process.kill(-child.pid, "SIGKILL"); } catch {} };
  const timer = setTimeout(kill, 120_000);
  signal?.addEventListener("abort", kill, { once: true });
  try { await child.exited; } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", kill);
    kill();
  }
  const files = (await readdir(join(directory, "out")).catch(() => [])).sort();
  if (!files.length) {
    await rm(directory, { recursive: true, force: true });
    return { unsupported: "LibreOffice could not convert this file; it may be damaged, protected or not an Office document." };
  }
  return { directory, files: files.map(file => join(directory, "out", file)) };
}

export async function officePDF(bytes: Uint8Array, scratch: string, signal?: AbortSignal): Promise<{ pdf: Uint8Array } | { unsupported: string }> {
  const office = officeDocument(bytes);
  if (!office) return { unsupported: "This file is not a Word, Excel, PowerPoint or OpenDocument file." };
  const result = await converted(bytes, scratch, office.extension, "pdf", signal);
  if ("unsupported" in result) return result;
  try { return { pdf: new Uint8Array(await readFile(result.files[0]!)) }; }
  finally { await rm(result.directory, { recursive: true, force: true }); }
}

async function officeText(bytes: Uint8Array, scratch: string, office: { kind: OfficeKind; extension: string }): Promise<DocumentText> {
  if (office.kind === "slides") {
    const pdfFile = await officePDF(bytes, scratch);
    if ("unsupported" in pdfFile) return pdfFile;
    const text = await pdfText(pdfFile.pdf, scratch);
    return "text" in text ? { text: text.text.replace(/^--- Page (\d+) ---$/gm, "--- Slide $1 ---") } : text;
  }
  const target = office.kind === "sheet" ? "csv:Text - txt - csv (StarCalc):44,34,76,1,,0,false,true,false,false,false,-1" : "txt:Text (encoded):UTF8";
  const result = await converted(bytes, scratch, office.extension, target);
  if ("unsupported" in result) return result;
  try {
    const parts: string[] = [];
    let size = 0;
    for (const file of result.files) {
      const text = (await readFile(file, "utf8")).replace(/^\uFEFF/, "");
      size += text.length;
      if (size > outputLimit) return { unsupported: "Extracted document text exceeds the 32 MiB read limit." };
      const sheet = /document-(.+)\.csv$/.exec(file)?.[1];
      parts.push(office.kind === "sheet" ? `--- Sheet ${sheet ?? parts.length + 1} ---\n${text.trimEnd()}` : text.trimEnd());
    }
    return { text: parts.join("\n\n") + "\n" };
  } finally { await rm(result.directory, { recursive: true, force: true }); }
}

async function pdfText(bytes: Uint8Array, scratch: string): Promise<DocumentText> {
  const tool = Bun.which("pdftotext");
  if (!tool) return { unsupported: "Reading PDF text needs pdftotext (poppler-utils) on this Host." };
  await mkdir(scratch, { recursive: true, mode: 0o700 });
  const input = join(scratch, `${crypto.randomUUID()}.pdf`);
  await writeFile(input, bytes, { mode: 0o600 });
  try {
    const child = Bun.spawn([tool, "-q", "-enc", "UTF-8", "-layout", input, "-"], { stdout: "pipe", stderr: "ignore", stdin: "ignore", env: {} });
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    try {
      const chunks: Uint8Array[] = [];
      let size = 0;
      const reader = child.stdout.getReader();
      for (;;) {
        const { value: chunk, done } = await reader.read();
        if (done) break;
        size += chunk.length;
        if (size > outputLimit) {
          child.kill("SIGKILL");
          await child.exited;
          return { unsupported: "Extracted PDF text exceeds the 32 MiB read limit." };
        }
        chunks.push(chunk);
      }
      const code = await child.exited;
      if (code !== 0) return { unsupported: "PDF text extraction failed; the file may be damaged or protected." };
      const pages = new TextDecoder().decode(Buffer.concat(chunks)).replace(/\f$/, "").split("\f");
      if (!pages.some(page => page.trim())) return { unsupported: "The PDF has no extractable text; it is probably scanned. Render its pages with ox.media.renderPages and attach them with ox.fs.attach to read them." };
      return { text: pages.map((page, index) => `--- Page ${index + 1} ---\n${page.trimEnd()}`).join("\n\n") + "\n" };
    } finally { clearTimeout(timer); }
  } finally { await rm(input, { force: true }); }
}

export async function documentText(bytes: Uint8Array, scratch: string): Promise<DocumentText> {
  if (pdf(bytes)) return pdfText(bytes, scratch);
  const office = officeDocument(bytes);
  if (office) {
    const text = await officeText(bytes, scratch, office);
    return "unsupported" in text && office.extension === "rtf" && isUtf8(bytes) ? { text: new TextDecoder().decode(bytes) } : text;
  }
  if (isUtf8(bytes)) return { text: new TextDecoder().decode(bytes) };
  return { unsupported: "This Host reads UTF-8 text, PDF, Word, Excel, PowerPoint and OpenDocument files; this file's format cannot be read as text. Use ox.media.transcribe for audio and ox.media.inspectVideo for video." };
}

import { isUtf8 } from "node:buffer";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type DocumentText = { text: string } | { unsupported: string };
const pdf = (bytes: Uint8Array) => bytes.length > 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
const outputLimit = 32 * 1024 * 1024;

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
      if (!pages.some(page => page.trim())) return { unsupported: "The PDF has no extractable text. Scanned pages need OCR, which this Host does not provide." };
      return { text: pages.map((page, index) => `--- Page ${index + 1} ---\n${page.trimEnd()}`).join("\n\n") + "\n" };
    } finally { clearTimeout(timer); }
  } finally { await rm(input, { force: true }); }
}

export async function documentText(bytes: Uint8Array, scratch: string): Promise<DocumentText> {
  if (pdf(bytes)) return pdfText(bytes, scratch);
  if (isUtf8(bytes)) return { text: new TextDecoder().decode(bytes) };
  return { unsupported: "This Host reads UTF-8 text and PDF documents; this file's format cannot be read as text." };
}

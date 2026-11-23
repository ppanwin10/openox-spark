import type { FileRecord } from "../../profile/file-record";
import { OxError } from "./functions";

export const artworkPath = /\.(?:svg|png|jpe?g|webp|gif)$/i;
export const artworkByteLimit = 2 * 1024 * 1024;
export type ReadArtwork = (record: FileRecord) => Promise<Uint8Array>;
const pixelLimit = 16_000_000;
const pngEnd = Buffer.from("0000000049454e44ae426082", "hex");
const invalid = () => new OxError("invalid_argument", "Artwork was not changed. Choose a complete image up to 2 MiB and 16 megapixels.");

export async function validateArtwork(path: string, record: FileRecord, read: ReadArtwork) {
  if (!artworkPath.test(path) || !record.size || record.size > artworkByteLimit) throw invalid();
  const expected = path.toLowerCase().split(".").pop()!.replace(/^jpg$/, "jpeg");
  const bytes = Buffer.from(await read(record));
  // Some decoders render all available pixels even when the container's end is missing.
  if ((expected === "png" && !bytes.subarray(-12).equals(pngEnd))
    || (expected === "gif" && bytes.at(-1) !== 0x3b)
    || (expected === "webp" && (bytes.length < 12 || bytes.readUInt32LE(4) + 8 !== bytes.length))) throw invalid();

  const { default: sharp } = await import("sharp");
  const image = sharp(bytes, { animated: true, failOn: "warning", limitInputPixels: pixelLimit });
  try {
    const { format, width, height } = await image.metadata();
    if (format !== expected || !width || !height || width * height > pixelLimit) throw invalid();
    await image.stats(); // Force a full decode; metadata alone accepts incomplete pixel data.
  } catch (cause) {
    if (cause instanceof OxError) throw cause;
    throw Object.assign(invalid(), { cause });
  }
}

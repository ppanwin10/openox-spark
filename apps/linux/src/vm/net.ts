import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const blockedSuffixes = [".localhost", ".local", ".internal"];
const resolved = new Map<string, { expires: number; public: boolean }>();
let testOrigins = new Set<string>();

export function allowTestOrigins(origins: readonly string[]) {
  testOrigins = new Set(origins.map(origin => new URL(origin).origin));
}

const hostOf = (url: URL) => url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");

const ipv4Bytes = (address: string) => address.split(".").map(Number);
function ipv6Bytes(address: string): number[] | undefined {
  const plain = address.split("%")[0]!;
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(plain);
  const head = tail ? plain.slice(0, -tail[1]!.length) + "0:0" : plain;
  const [left, right] = head.includes("::") ? head.split("::") as [string, string] : [head, undefined];
  const parse = (part: string) => part ? part.split(":").map(group => parseInt(group, 16)) : [];
  const start = parse(left), end = right === undefined ? [] : parse(right);
  const groups = right === undefined ? start : [...start, ...new Array(8 - start.length - end.length).fill(0), ...end];
  if (groups.length !== 8 || groups.some(group => !Number.isInteger(group) || group < 0 || group > 0xffff)) return undefined;
  const bytes = groups.flatMap(group => [group >> 8, group & 0xff]);
  if (tail) bytes.splice(12, 4, ...ipv4Bytes(tail[1]!));
  return bytes;
}

function publicIPv4([first, second, third]: number[]) {
  if (first === 0 || first === 10 || first === 127 || first! >= 224) return false;
  if (first === 100 && second! >= 64 && second! <= 127) return false;
  if (first === 169 && second === 254) return false;
  if (first === 172 && second! >= 16 && second! <= 31) return false;
  if (first === 192 && (second === 168 || second === 0 && third === 0)) return false;
  if (first === 198 && (second === 18 || second === 19)) return false;
  return true;
}

export function isPublicAddress(address: string) {
  const family = isIP(address.split("%")[0]!);
  if (family === 4) return publicIPv4(ipv4Bytes(address));
  if (family !== 6) return false;
  const bytes = ipv6Bytes(address);
  if (!bytes) return false;
  const prefix = bytes.slice(0, 12);
  if (prefix.every((byte, index) => byte === (index >= 10 ? 0xff : 0))) return publicIPv4(bytes.slice(12));
  if ([0x00, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0].every((byte, index) => prefix[index] === byte)) return publicIPv4(bytes.slice(12));
  if (prefix.every(byte => byte === 0)) return false;
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return publicIPv4(bytes.slice(2, 6));
  if (bytes[0] === 0xff || (bytes[0]! & 0xfe) === 0xfc) return false;
  return !(bytes[0] === 0xfe && (bytes[1]! & 0x80) === 0x80);
}

export function isTestURL(url: URL) {
  return testOrigins.has(url.origin);
}

export function allowsURL(input: string | URL, schemes: readonly string[] = ["http:", "https:"]) {
  let url: URL;
  try { url = typeof input === "string" ? new URL(input) : input; } catch { return false; }
  if (!schemes.includes(url.protocol) || url.username || url.password) return false;
  if (isTestURL(url)) return true;
  if (url.port && !["80", "443"].includes(url.port)) return false;
  const host = hostOf(url);
  if (!host) return false;
  if (isIP(host)) return isPublicAddress(host);
  return host !== "localhost" && !blockedSuffixes.some(suffix => host.endsWith(suffix));
}

export async function publicEndpoint(input: string | URL, schemes?: readonly string[]) {
  let url: URL;
  try { url = typeof input === "string" ? new URL(input) : input; } catch { return undefined; }
  if (!allowsURL(url, schemes)) return undefined;
  const host = hostOf(url), port = Number(url.port || (["https:", "wss:"].includes(url.protocol) ? 443 : 80));
  if (isIP(host) || isTestURL(url)) return { address: host, port };
  const addresses = await lookup(host, { all: true, verbatim: true }).catch(() => []);
  return addresses.length && addresses.every(entry => isPublicAddress(entry.address)) ? { address: addresses[0]!.address, port } : undefined;
}

export async function resolvesPublic(input: string | URL, schemes?: readonly string[]) {
  let url: URL;
  try { url = typeof input === "string" ? new URL(input) : input; } catch { return false; }
  if (!allowsURL(url, schemes)) return false;
  if (isTestURL(url)) return true;
  const host = hostOf(url);
  if (isIP(host)) return isPublicAddress(host);
  const cached = resolved.get(host);
  if (cached && cached.expires > Date.now()) return cached.public;
  let addresses: { address: string }[] = [];
  try { addresses = await lookup(host, { all: true, verbatim: true }); } catch { addresses = []; }
  const result = addresses.length > 0 && addresses.every(entry => isPublicAddress(entry.address));
  resolved.set(host, { expires: Date.now() + 60_000, public: result });
  if (resolved.size > 2_000) resolved.delete(resolved.keys().next().value!);
  return result;
}

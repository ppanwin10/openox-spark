import { readFileSync } from "node:fs";
import { join } from "node:path";
import { domainToASCII } from "node:url";

const listPath = join(import.meta.dir, "..", "..", "..", "..", "shared", "Resources", "PublicSuffixList.bundle", "public_suffix_list.dat");
let suffixes: Set<string> | undefined;

function rules() {
  suffixes ??= new Set(readFileSync(listPath, "utf8").split("\n").flatMap(line => {
    const rule = line.split("//")[0]!.trim();
    if (!rule) return [];
    if (/^[\x00-\x7f]*$/.test(rule)) return [rule];
    const marker = rule.startsWith("*.") ? "*." : rule.startsWith("!") ? "!" : "";
    const host = domainToASCII(rule.slice(marker.length));
    return host ? [marker + host] : [];
  }));
  return suffixes;
}

const normalized = (domain: string) => domain.toLowerCase().replace(/^\[|\]$/g, "").replace(/^\.+|\.+$/g, "");
const isIPAddress = (domain: string) => domain.includes(":")
  || domain.split(".").length === 4 && domain.split(".").every(label => /^\d{1,3}$/.test(label) && Number(label) <= 255 && String(Number(label)) === label);

function effectiveTLDPlusOne(hostname: string) {
  const labels = hostname.split(".");
  if (labels.some(label => !label)) return undefined;
  const list = rules();
  let suffixCount = 1;
  for (let index = 0; index < labels.length; index++) {
    const suffix = labels.slice(index).join(".");
    if (list.has(`!${suffix}`)) return suffix;
    if (list.has(suffix) || list.has(`*.${labels.slice(index + 1).join(".")}`)) suffixCount = Math.max(suffixCount, labels.length - index);
  }
  return labels.length > suffixCount ? labels.slice(-(suffixCount + 1)).join(".") : undefined;
}

export function registrableSite(domain: string) {
  const host = normalized(domain);
  return isIPAddress(host) ? host : effectiveTLDPlusOne(host);
}

export const siteFor = (domain: string) => registrableSite(domain) ?? normalized(domain);

export function siteOf(url: string) {
  try {
    const parsed = new URL(url);
    return ["http:", "https:"].includes(parsed.protocol) && parsed.hostname ? siteFor(parsed.hostname) : null;
  } catch { return null; }
}

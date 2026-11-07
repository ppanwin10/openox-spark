export const isSpace = (code: number) => code === 32 || (code >= 9 && code <= 13) || code === 0x85 || code === 0xa0 || code === 0x1680
  || (code >= 0x2000 && code <= 0x200a) || code === 0x2028 || code === 0x2029 || code === 0x202f || code === 0x205f || code === 0x3000;
const isNewline = (code: number) => (code >= 10 && code <= 13) || code === 0x85 || code === 0x2028 || code === 0x2029;
export const spaceClass = "\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const spaceRuns = new RegExp(`[${spaceClass}]+`, "g");

function trimWith(value: string, test: (code: number) => boolean) {
  let start = 0, end = value.length;
  while (start < end && test(value.charCodeAt(start))) start++;
  while (end > start && test(value.charCodeAt(end - 1))) end--;
  return start === 0 && end === value.length ? value : value.slice(start, end);
}
export const trim = (value: string) => trimWith(value, isSpace);
export const trimNewlines = (value: string) => trimWith(value, isNewline);
export const collapse = (value: string) => value.replace(spaceRuns, " ");
export const splitSpaces = (value: string) => value.split(spaceRuns).filter(Boolean);

export function blank(value: string) {
  for (let index = 0; index < value.length; index++) if (!isSpace(value.charCodeAt(index))) return false;
  return true;
}

export function wordCount(text: string) {
  let count = 0, inside = false;
  for (let index = 0; index < text.length; index++) {
    const space = isSpace(text.charCodeAt(index));
    if (!space && !inside) count++;
    inside = !space;
  }
  return count;
}

export const utf8Length = (value: string) => Buffer.byteLength(value, "utf8");

export function utf8Prefix(value: string, limit: number) {
  if (limit <= 0) return "";
  if (value.length * 3 <= limit) return value;
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    const pair = code >= 0xd800 && code <= 0xdbff && index + 1 < value.length && (value.charCodeAt(index + 1) & 0xfc00) === 0xdc00;
    const size = pair ? 4 : code < 0x80 ? 1 : code < 0x800 ? 2 : 3;
    if (bytes + size > limit) return value.slice(0, index);
    bytes += size;
    if (pair) index++;
  }
  return value;
}

export function limitText(text: string, maxBytes: number) {
  const prefix = utf8Prefix(text, maxBytes);
  return { text: prefix, truncated: prefix.length < text.length };
}

export function resolveURL(value: string, base: string) {
  let url: URL;
  try { url = new URL(value, base); } catch { return undefined; }
  const bare = url.pathname === "/" && /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]*(?:[?#]|$)/.test(value.trim());
  return { url, href: bare ? url.href.replace(/^([^:]+:\/\/[^/?#]*)\//, "$1") : url.href };
}

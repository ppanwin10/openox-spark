import { OxError } from "@openox/agent/linux";
import { resolveURL, trim, utf8Length, utf8Prefix } from "./text";

const atom = "http://www.w3.org/2005/Atom";
const rss1 = "http://purl.org/rss/1.0/";
const rdf = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
const contentModule = "http://purl.org/rss/1.0/modules/content/";
const dublinCore = "http://purl.org/dc/elements/1.1/";
const xmlNamespace = "http://www.w3.org/XML/1998/namespace";
const namePattern = "[A-Za-z_:\\u00C0-\\uFFFF][A-Za-z0-9_.:\\-\\u00B7\\u00C0-\\uFFFF]*";
const startName = new RegExp(namePattern, "y");
const attributeName = new RegExp(namePattern, "y");
const endTag = new RegExp(`</(${namePattern})[ \\t\\n]*>`, "y");
const entityName = new RegExp(`^${namePattern}$`);
const invalidCharacter = /[\x00-\x08\x0B\x0C\x0E-\x1F\uFFFE\uFFFF]/;
const spaces = new Set([" ", "\t", "\n"]);
const predefined = new Map([["lt", "<"], ["gt", ">"], ["amp", "&"], ["apos", "'"], ["quot", "\""]]);

class Malformed extends Error {}
interface Open { qname: string; name: string; namespace: string; base: string; text: string; bytes: number; scope: Map<string, string> }
export interface Feed { value: Record<string, unknown>; truncated: boolean }

function decodeXML(bytes: Uint8Array) {
  let encoding = "utf-8", offset = 0;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) offset = 3;
  else if (bytes[0] === 0xff && bytes[1] === 0xfe) { encoding = "utf-16le"; offset = 2; }
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) { encoding = "utf-16be"; offset = 2; }
  else {
    let index = 0;
    while (index < bytes.length && (bytes[index] === 32 || bytes[index] === 9 || bytes[index] === 10 || bytes[index] === 13)) index++;
    if (bytes[index] !== 0x3c) return undefined;
    const head = new TextDecoder("latin1").decode(bytes.subarray(index, index + 256));
    const declared = /^<\?xml[^>]*?encoding[ \t\r\n]*=[ \t\r\n]*["']([A-Za-z0-9._-]+)["']/.exec(head)?.[1]?.toLowerCase();
    if (declared && declared !== "utf-8" && declared !== "utf8") encoding = declared;
  }
  try { return new TextDecoder(encoding, { fatal: true, ignoreBOM: true }).decode(bytes.subarray(offset)); }
  catch { return undefined; }
}

class FeedReader {
  private readonly xml: string;
  private readonly source: string;
  private cursor = 0;
  private doctype = false;
  private open: Open[] = [];
  private format?: "rss" | "rdf" | "atom";
  private metadata: Record<string, string> = {};
  private entries: Record<string, string>[] = [];
  private entry?: Record<string, string>;
  private entryDepth?: number;
  private remaining: number;
  private truncated = false;

  constructor(xml: string, source: string, maxBytes: number) {
    this.xml = xml.replace(/\r\n?/g, "\n");
    this.source = source;
    this.remaining = maxBytes;
  }

  read(): Feed | undefined {
    if (/^\uFEFF?[ \t\n]+<\?xml[ \t\n]/.test(this.xml)) return undefined;
    try {
      this.prolog();
      if (!this.xml.startsWith("<", this.cursor) || this.xml.startsWith("</", this.cursor)) return undefined;
      this.startTag();
      if (!this.format) return undefined;
      this.content();
    } catch (error) {
      if (!(error instanceof Malformed)) throw error;
      if (!this.format) return undefined;
      throw new OxError("operation_failed", "ox.web.fetch: malformed RSS or Atom feed", "The feed is not well-formed XML. Fetch the site's HTML pages or entry URLs instead.");
    }
    return { value: { ...this.metadata, entries: this.entries }, truncated: this.truncated };
  }

  private skipSpace() { while (this.cursor < this.xml.length && spaces.has(this.xml[this.cursor]!)) this.cursor++; }

  private skipPast(marker: string) {
    const index = this.xml.indexOf(marker, this.cursor);
    if (index < 0) throw new Malformed();
    this.cursor = index + marker.length;
  }

  private prolog() {
    if (this.xml.startsWith("\uFEFF")) this.cursor = 1;
    for (;;) {
      this.skipSpace();
      if (this.xml.startsWith("<?", this.cursor)) this.skipPast("?>");
      else if (this.xml.startsWith("<!--", this.cursor)) this.skipPast("-->");
      else if (this.xml.startsWith("<!DOCTYPE", this.cursor)) this.skipDoctype();
      else return;
    }
  }

  private skipDoctype() {
    let depth = 0, quote = "";
    for (let index = this.cursor + 9; index < this.xml.length; index++) {
      const character = this.xml[index]!;
      if (quote) { if (character === quote) quote = ""; }
      else if (character === "\"" || character === "'") quote = character;
      else if (character === "[") depth++;
      else if (character === "]") depth--;
      else if (character === ">" && depth <= 0) { this.cursor = index + 1; this.doctype = true; return; }
    }
    throw new Malformed();
  }

  private content() {
    while (this.open.length) {
      if (this.cursor >= this.xml.length) throw new Malformed();
      if (this.xml[this.cursor] !== "<") {
        const next = this.xml.indexOf("<", this.cursor);
        const end = next < 0 ? this.xml.length : next;
        const text = this.xml.slice(this.cursor, end);
        if (text.includes("]]>")) throw new Malformed();
        this.characters(this.decode(text));
        this.cursor = end;
      } else if (this.xml.startsWith("</", this.cursor)) this.endTag();
      else if (this.xml.startsWith("<!--", this.cursor)) this.skipPast("-->");
      else if (this.xml.startsWith("<![CDATA[", this.cursor)) {
        const start = this.cursor + 9;
        this.skipPast("]]>");
        const data = this.xml.slice(start, this.cursor - 3);
        if (invalidCharacter.test(data)) throw new Malformed();
        this.characters(data);
      } else if (this.xml.startsWith("<?", this.cursor)) this.skipPast("?>");
      else if (this.xml.startsWith("<!", this.cursor)) throw new Malformed();
      else this.startTag();
    }
    for (;;) {
      this.skipSpace();
      if (this.cursor >= this.xml.length) return;
      if (this.xml.startsWith("<!--", this.cursor)) this.skipPast("-->");
      else if (this.xml.startsWith("<?", this.cursor)) this.skipPast("?>");
      else throw new Malformed();
    }
  }

  private decode(text: string, attribute = false) {
    if (invalidCharacter.test(text)) throw new Malformed();
    const source = attribute ? text.replace(/[\t\n]/g, " ") : text;
    if (!source.includes("&")) return source;
    let result = "", cursor = 0;
    for (;;) {
      const ampersand = source.indexOf("&", cursor);
      if (ampersand < 0) return result + source.slice(cursor);
      result += source.slice(cursor, ampersand);
      const semicolon = source.indexOf(";", ampersand);
      const reference = semicolon < 0 ? "" : source.slice(ampersand + 1, semicolon);
      const numeric = /^#(?:x([0-9A-Fa-f]+)|([0-9]+))$/.exec(reference);
      if (numeric) {
        const code = parseInt(numeric[1] ?? numeric[2]!, numeric[1] ? 16 : 10);
        if (!(code === 9 || code === 10 || code === 13 || (code >= 0x20 && code <= 0xd7ff) || (code >= 0xe000 && code <= 0xfffd) || (code >= 0x10000 && code <= 0x10ffff))) throw new Malformed();
        result += String.fromCodePoint(code);
      } else if (predefined.has(reference)) result += predefined.get(reference);
      else if (!this.doctype || !entityName.test(reference)) throw new Malformed();
      cursor = semicolon + 1;
    }
  }

  private name(pattern: RegExp) {
    pattern.lastIndex = this.cursor;
    const match = pattern.exec(this.xml);
    if (!match) throw new Malformed();
    this.cursor = pattern.lastIndex;
    return match[0];
  }

  private startTag() {
    this.cursor++;
    const qname = this.name(startName);
    const attributes = new Map<string, string>();
    let selfClosing = false;
    for (;;) {
      const before = this.cursor;
      this.skipSpace();
      if (this.xml.startsWith("/>", this.cursor)) { this.cursor += 2; selfClosing = true; break; }
      if (this.xml.startsWith(">", this.cursor)) { this.cursor++; break; }
      if (this.cursor === before) throw new Malformed();
      const key = this.name(attributeName);
      this.skipSpace();
      if (this.xml[this.cursor] !== "=") throw new Malformed();
      this.cursor++;
      this.skipSpace();
      const quote = this.xml[this.cursor];
      if (quote !== "\"" && quote !== "'") throw new Malformed();
      const close = this.xml.indexOf(quote, this.cursor + 1);
      if (close < 0) throw new Malformed();
      const raw = this.xml.slice(this.cursor + 1, close);
      if (raw.includes("<") || attributes.has(key)) throw new Malformed();
      attributes.set(key, this.decode(raw, true));
      this.cursor = close + 1;
    }
    const parentScope = this.open.at(-1)?.scope ?? new Map<string, string>();
    let scope = parentScope;
    for (const [key, value] of attributes) {
      if (key !== "xmlns" && !key.startsWith("xmlns:")) continue;
      if (scope === parentScope) scope = new Map(parentScope);
      scope.set(key === "xmlns" ? "" : key.slice(6), value);
      attributes.delete(key);
    }
    const separator = qname.indexOf(":");
    const prefix = separator < 0 ? "" : qname.slice(0, separator);
    this.start(qname, qname.slice(separator + 1), prefix === "xml" ? xmlNamespace : scope.get(prefix) ?? "", attributes, scope);
    if (!this.format) return;
    if (selfClosing) this.end();
  }

  private endTag() {
    endTag.lastIndex = this.cursor;
    const match = endTag.exec(this.xml);
    if (!match || match[1] !== this.open.at(-1)?.qname) throw new Malformed();
    this.cursor = endTag.lastIndex;
    this.end();
  }

  private publicLink(text: string) {
    const resolved = resolveURL(text, this.open.at(-1)?.base ?? this.source);
    const url = resolved?.url;
    return url && (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password ? resolved.href : undefined;
  }

  private isField() {
    if (this.entryDepth !== undefined) return this.open.length === this.entryDepth + 1;
    if (this.format === "atom") return this.open.length === 2;
    return this.open.length === 3 && this.open[1]!.name === "channel";
  }

  private start(qname: string, name: string, namespace: string, attributes: Map<string, string>, scope: Map<string, string>) {
    if (this.open.length >= 256) throw new Malformed();
    const inherited = this.open.at(-1)?.base ?? this.source;
    const xmlBase = attributes.get("xml:base");
    const base = xmlBase === undefined ? inherited : resolveURL(xmlBase, inherited)?.url.href ?? inherited;
    this.open.push({ qname, name, namespace, base, text: "", bytes: 0, scope });
    if (this.open.length === 1) {
      this.format = name === "rss" && namespace === "" ? "rss" : name === "RDF" && namespace === rdf ? "rdf" : name === "feed" && namespace === atom ? "atom" : undefined;
      if (!this.format) return;
    }
    const parent = this.open.at(-2)?.name;
    const isEntry = this.format === "atom" ? name === "entry" && namespace === atom && parent === "feed"
      : name === "item" && (namespace === "" || namespace === rss1) && (parent === "channel" || parent === "RDF");
    if (isEntry && this.entryDepth === undefined) {
      this.entryDepth = this.open.length;
      this.entry = {};
    }
    const rel = attributes.get("rel");
    const href = attributes.get("href");
    if (namespace === atom && name === "link" && (rel === undefined || rel === "alternate") && this.isField() && href !== undefined) {
      const link = this.publicLink(href);
      if (link) this.store("url", link);
    }
  }

  private characters(chunk: string) {
    const element = this.open.at(-1);
    if (!element || !chunk) return;
    const size = utf8Length(chunk);
    const allowed = Math.min(size, Math.max(0, this.remaining - element.bytes));
    const prefix = allowed === size ? chunk : utf8Prefix(chunk, allowed);
    element.text += prefix;
    element.bytes += allowed === size ? size : utf8Length(prefix);
    if (allowed < size) this.truncated = true;
  }

  private end() {
    const element = this.open.at(-1)!;
    const text = trim(element.text);
    if (this.isField() && text) {
      const { name, namespace } = element;
      const standard = namespace === "" || namespace === rss1 || namespace === atom;
      if (name === "title" && standard) this.store("title", text);
      else if (name === "id" || (name === "guid" && standard)) this.store("id", text);
      else if (name === "link" && standard && this.format !== "atom") {
        const link = this.publicLink(text);
        if (link) this.store("url", link);
      } else if (name === "published" || (name === "pubDate" && standard)) this.store("published", text);
      else if (name === "updated" && standard) this.store("updated", text);
      else if (name === "description" || (name === "summary" && standard)) this.store("summary", text);
      else if (name === "content" && standard) this.store("content", text);
      else if (name === "encoded" && namespace === contentModule) this.store("content", text);
      else if (name === "date" && namespace === dublinCore) this.store("published", text);
    }
    if (this.entryDepth === this.open.length) {
      if (this.entry && Object.keys(this.entry).length) {
        if (this.entries.length < 100) this.entries.push(this.entry);
        else this.truncated = true;
      }
      this.entry = undefined;
      this.entryDepth = undefined;
    }
    this.open.pop();
    const fieldDepth = this.entryDepth !== undefined ? this.entryDepth + 1 : this.format === "atom" ? 2 : 3;
    if (this.open.length >= fieldDepth) {
      const parent = this.open.at(-1)!;
      const addition = utf8Prefix(element.text, Math.max(0, this.remaining - parent.bytes));
      parent.text += addition;
      parent.bytes += utf8Length(addition);
    }
  }

  private store(key: string, value: string) {
    if (this.entryDepth !== undefined && this.entries.length >= 100) { this.truncated = true; return; }
    const bounded = utf8Prefix(value, this.remaining);
    const size = utf8Length(bounded);
    this.remaining -= size;
    if (size < utf8Length(value)) this.truncated = true;
    if (this.entryDepth !== undefined) this.entry![key] = bounded;
    else this.metadata[key] = bounded;
  }
}

export function parseFeed(bytes: Uint8Array, url: string, maxBytes: number) {
  const xml = decodeXML(bytes);
  return xml === undefined ? undefined : new FeedReader(xml, url, maxBytes).read();
}

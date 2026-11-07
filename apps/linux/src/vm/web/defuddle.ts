import { blank, collapse, isSpace, resolveURL, spaceClass, splitSpaces, trim, trimNewlines, wordCount } from "./text";

const negativeTerms = ["advert", "banner", "breadcrumb", "cookie", "copyright", "footer", "header", "login", "author", "byline", "menu", "nav", "newsletter",
  "pagination", "popular", "post-date", "privacy", "promo", "recommend", "related", "share", "sidebar", "social", "sponsor", "subscribe", "trending", "widget"];
const positiveTerms = ["article", "body", "content", "entry", "main", "markdown", "post", "story"];
const discardedTags = new Set(["applet", "base", "button", "canvas", "dialog", "embed", "fieldset", "footer", "form", "frame", "frameset", "link", "meta", "nav",
  "noscript", "object", "script", "select", "style", "template", "textarea"]);
const discardedRoles = new Set(["navigation", "dialog", "alertdialog", "complementary", "banner", "listbox", "option"]);
const blockTags = new Set(["address", "article", "aside", "blockquote", "dd", "details", "div", "dl", "dt", "fieldset", "figcaption", "figure", "footer", "form",
  "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "li", "main", "nav", "ol", "p", "pre", "section", "summary", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "ul"]);
const voidTags = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const rawTags = new Map(["script", "style", "template", "textarea"].map(tag => [tag, new RegExp(`</${tag}`, "gi")]));
const headings = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);
const richTags = new Set(["pre", "table", "figure", "picture", "math"]);
const clutterTags = new Set(["aside", "header", "nav", "footer", "section", "div", "ul", "ol"]);
const structuralTags = new Set(["article", "main", "section", "div", "td", "blockquote"]);
const removableTags = new Set(["p", "div", "section", "article", "aside", "header", "footer", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "blockquote", "figure"]);
const mediaTags = new Set(["img", "picture", "video", "audio", "iframe", "svg", "math", "table", "pre", "hr"]);
const meaningfulTags = new Set(["img", "picture", "video", "audio", "iframe", "table", "pre", "math"]);
const named = new Map(Object.entries({
  amp: "&", apos: "'", bull: "•", cent: "¢", copy: "©", divide: "÷", emsp: "\u2003", ensp: "\u2002", euro: "€", gt: ">", hellip: "…", laquo: "«",
  ldquo: "“", lsquo: "‘", lt: "<", mdash: "—", middot: "·", nbsp: " ", ndash: "–", pound: "£", quot: "\"", raquo: "»", rdquo: "”", reg: "®",
  rsquo: "’", times: "×", trade: "™", yen: "¥",
}));
const hiddenStyle = new RegExp(`(?:display[${spaceClass}]*:[${spaceClass}]*none|visibility[${spaceClass}]*:[${spaceClass}]*hidden|opacity[${spaceClass}]*:[${spaceClass}]*0(?:\\D|$))`);
const markupStart = new RegExp(`<(?=/?[A-Za-z][A-Za-z0-9-]*(?:[${spaceClass}]|/?>))`, "g");
const nameCharacter = /^[\p{Alphabetic}\p{N}_:-]$/u;
const digit = /^\p{N}$/u;
const lineBreak = /(?<!\r)\n/;
const tagEnd = /[>"']/g;
const maxDepth = 128;

class Node {
  readonly tag: string | null;
  readonly value: string;
  readonly attributes: Map<string, string>;
  parent?: Node;
  private nodes: Node[] = [];
  private detached = false;
  private text?: string;

  constructor(tag: string | null, value = "", attributes = new Map<string, string>()) {
    this.tag = tag;
    this.value = value;
    this.attributes = attributes;
  }

  get children() {
    if (this.detached) {
      this.nodes = this.nodes.filter(child => child.parent === this);
      this.detached = false;
    }
    return this.nodes;
  }

  get elements() {
    const result: Node[] = [];
    const stack = [...this.children].reverse();
    while (stack.length) {
      const node = stack.pop()!;
      if (node.tag !== null) result.push(node);
      const children = node.children;
      for (let index = children.length - 1; index >= 0; index--) stack.push(children[index]!);
    }
    return result;
  }

  get textContent(): string {
    if (this.tag === null) return this.value;
    if (this.text === undefined) this.text = trim(collapse(this.children.map(child => child.textContent).join(blockTags.has(this.tag) ? " " : "")));
    return this.text;
  }

  get rawText(): string { return this.tag === null ? this.value : this.children.map(child => child.rawText).join(""); }
  get classTokens() { return new Set(splitSpaces(this.attribute("class").toLowerCase())); }
  get identity() {
    return [this.tag ?? "", ...["id", "class", "role", "data-block", "data-component", "data-testid"].map(name => this.attribute(name))].join(" ").toLowerCase();
  }
  attribute(name: string) { return this.attributes.get(name) ?? ""; }

  append(child: Node) {
    child.parent = this;
    this.nodes.push(child);
  }

  private changed() { for (let node: Node | undefined = this; node; node = node.parent) node.text = undefined; }

  remove() {
    const parent = this.parent;
    if (!parent) return;
    this.parent = undefined;
    parent.detached = true;
    parent.changed();
  }

  unwrap() {
    const parent = this.parent;
    const index = parent ? parent.children.indexOf(this) : -1;
    if (!parent || index < 0) return;
    const children = this.children;
    for (const child of children) child.parent = parent;
    parent.nodes.splice(index, 1, ...children);
    parent.changed();
    this.nodes = [];
    this.parent = undefined;
  }

  first(predicate: (node: Node) => boolean) {
    const stack: Node[] = [this];
    while (stack.length) {
      const node = stack.pop()!;
      if (predicate(node)) return node;
      const children = node.children;
      for (let index = children.length - 1; index >= 0; index--) stack.push(children[index]!);
    }
    return undefined;
  }

  copy(): Node {
    const copy = new Node(this.tag, this.value, new Map(this.attributes));
    for (const child of this.children) copy.append(child.copy());
    return copy;
  }
}

const isName = (character: string | undefined) => character !== undefined && nameCharacter.test(character);

function integer(value: string, radix: number) {
  if (!(radix === 16 ? /^[+-]?[0-9a-f]+$/i : /^[+-]?[0-9]+$/).test(value)) return undefined;
  const number = parseInt(value.replace(/^[+-]/, ""), radix);
  if (value.startsWith("-")) return number === 0 ? 0 : undefined;
  return number <= 0xffffffff ? number : undefined;
}
const scalar = (code: number | undefined) => code === undefined || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) ? undefined : String.fromCodePoint(code);

function decodeEntities(value: string) {
  if (!value.includes("&")) return value;
  let result = "", cursor = 0;
  while (cursor < value.length) {
    const ampersand = value.indexOf("&", cursor);
    if (ampersand < 0) { result += value.slice(cursor); break; }
    result += value.slice(cursor, ampersand);
    const semicolon = value.slice(ampersand, ampersand + 13).indexOf(";");
    const entity = semicolon < 0 ? undefined : value.slice(ampersand + 1, ampersand + semicolon);
    const replacement = entity === undefined ? undefined : entity.startsWith("#x") || entity.startsWith("#X") ? scalar(integer(entity.slice(2), 16))
      : entity.startsWith("#") ? scalar(integer(entity.slice(1), 10)) : named.get(entity.toLowerCase());
    if (replacement === undefined) { result += "&"; cursor = ampersand + 1; }
    else { result += replacement; cursor = ampersand + semicolon + 1; }
  }
  return result;
}

function findTagEnd(html: string, start: number) {
  let index = start;
  for (;;) {
    tagEnd.lastIndex = index;
    const match = tagEnd.exec(html);
    if (!match) return -1;
    if (match[0] === ">") return match.index;
    const close = html.indexOf(match[0], match.index + 1);
    if (close < 0) return -1;
    index = close + 1;
  }
}

function openingTag(token: string) {
  const characters = Array.from(token);
  const space = (index: number) => index < characters.length && isSpace(characters[index]!.charCodeAt(0));
  let index = 0;
  while (space(index)) index++;
  const nameStart = index;
  while (index < characters.length && isName(characters[index])) index++;
  const name = characters.slice(nameStart, index).join("").toLowerCase();
  const attributes = new Map<string, string>();
  let selfClosing = false;
  while (index < characters.length) {
    while (space(index)) index++;
    if (index >= characters.length) break;
    if (characters[index] === "/") { selfClosing = true; index++; continue; }
    const keyStart = index;
    while (index < characters.length && !space(index) && characters[index] !== "=" && characters[index] !== "/") index++;
    const key = characters.slice(keyStart, index).join("").toLowerCase();
    while (space(index)) index++;
    let value = "";
    if (characters[index] === "=") {
      index++;
      while (space(index)) index++;
      const quote = characters[index];
      if (quote === "\"" || quote === "'") {
        const valueStart = ++index;
        while (index < characters.length && characters[index] !== quote) index++;
        value = characters.slice(valueStart, index).join("");
        if (index < characters.length) index++;
      } else {
        const valueStart = index;
        while (index < characters.length && !space(index)) index++;
        value = characters.slice(valueStart, index).join("");
      }
    }
    if (key) attributes.set(key, decodeEntities(value));
  }
  return { name, attributes, selfClosing };
}

function popLast(tag: string, stack: Node[], after = 0) {
  for (let index = stack.length - 1; index > after; index--) if (stack[index]!.tag === tag) { stack.length = index; return; }
}

function lastIndex(stack: Node[], tags: readonly string[]) {
  for (let index = stack.length - 1; index >= 0; index--) if (tags.includes(stack[index]!.tag ?? "")) return index;
  return 0;
}

function closeImplied(name: string, stack: Node[]) {
  if (name === "p" || (blockTags.has(name) && stack.at(-1)!.tag === "p")) popLast("p", stack);
  if (name === "li") popLast("li", stack, lastIndex(stack, ["ul", "ol"]));
  if (name === "tr") popLast("tr", stack, lastIndex(stack, ["table", "thead", "tbody", "tfoot"]));
  if (name === "td" || name === "th") {
    popLast("td", stack, lastIndex(stack, ["tr"]));
    popLast("th", stack, lastIndex(stack, ["tr"]));
  }
  const current = stack.at(-1)!.tag ?? "";
  if (name.length === 2 && name[0] === "h" && digit.test(name[1]!) && current.length === 2 && current[0] === "h" && stack.length > 1) stack.pop();
}

function appendText(text: string, parent: Node) {
  if (text) parent.append(new Node(null, decodeEntities(text)));
}

function parse(html: string) {
  const root = new Node("document");
  const stack = [root];
  let cursor = 0;
  while (cursor < html.length) {
    if (html.charCodeAt(cursor) !== 60) {
      const next = html.indexOf("<", cursor);
      const end = next < 0 ? html.length : next;
      appendText(html.slice(cursor, end), stack.at(-1)!);
      cursor = end;
      continue;
    }
    if (html.startsWith("<!--", cursor)) {
      const close = html.indexOf("-->", cursor);
      cursor = close < 0 ? html.length : close + 3;
      continue;
    }
    const next = cursor + 1;
    const following = next < html.length ? String.fromCodePoint(html.codePointAt(next)!) : undefined;
    if (following === undefined || (!isName(following) && following !== "!" && following !== "?" && following !== "/")) {
      appendText("<", stack.at(-1)!);
      cursor = next;
      continue;
    }
    const end = findTagEnd(html, next);
    if (end < 0) { appendText(html.slice(cursor), stack.at(-1)!); break; }
    const token = trim(html.slice(next, end));
    cursor = end + 1;
    if (!token || token[0] === "!" || token[0] === "?") continue;
    if (token[0] === "/") {
      let name = "";
      for (const character of token.slice(1)) { if (!isName(character)) break; name += character; }
      popLast(name.toLowerCase(), stack);
      continue;
    }
    const { name, attributes, selfClosing } = openingTag(token);
    if (!name) continue;
    closeImplied(name, stack);
    const node = new Node(name, "", attributes);
    stack.at(-1)!.append(node);
    if (selfClosing || voidTags.has(name)) continue;
    if (stack.length <= maxDepth) stack.push(node);
    const closing = rawTags.get(name);
    if (closing) {
      closing.lastIndex = cursor;
      cursor = closing.exec(html)?.index ?? html.length;
    }
  }
  return root;
}

function double(value: string) {
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) return Number(value);
  if (/^[+-]?(?:inf|infinity)$/i.test(value)) return value.startsWith("-") ? -Infinity : Infinity;
  return /^[+-]?nan$/i.test(value) ? NaN : undefined;
}

function compactBlock(value: string) {
  const lines = value.split("\n");
  for (let index = 0; index < lines.length - 1; index++) {
    const line = lines[index]!;
    let end = line.length;
    while (end > 0 && (line.charCodeAt(end - 1) === 32 || line.charCodeAt(end - 1) === 9)) end--;
    if (end < line.length) lines[index] = line.slice(0, end);
  }
  return trim(lines.join("\n").replace(/\n{3,}/g, "\n\n"));
}
const compactInline = (value: string) => trim(collapse(value));
const block = (content: string) => {
  const trimmed = trim(content);
  return trimmed ? `\n\n${trimmed}\n\n` : "";
};
const escapeText = (value: string) => value.replaceAll("\\", "\\\\").replaceAll("*", "\\*").replaceAll("_", "\\_").replaceAll("[", "\\[").replaceAll("]", "\\]")
  .replace(markupStart, "\\<");
const markdownDestination = (value: string) => [...value].some(character => isSpace(character.charCodeAt(0)))
  ? `<${value.replaceAll(">", "\\>")}>` : value.replaceAll("(", "\\(").replaceAll(")", "\\)");
const titleSuffix = (node: Node) => {
  const title = trim(node.attribute("title"));
  return title ? ` "${title.replaceAll("\"", "\\\"")}"` : "";
};

function wrapInline(content: string, marker: string) {
  let start = 0;
  while (start < content.length && isSpace(content.charCodeAt(start))) start++;
  if (start === content.length) return content;
  let end = content.length;
  while (end > start && isSpace(content.charCodeAt(end - 1))) end--;
  return `${content.slice(0, start)}${marker}${content.slice(start, end)}${marker}${content.slice(end)}`;
}

function longestBacktickRun(value: string) {
  let longest = 0, current = 0;
  for (const character of value) {
    current = character === "`" ? current + 1 : 0;
    longest = Math.max(longest, current);
  }
  return longest;
}

function inlineCode(content: string) {
  if (!content) return "";
  const fence = "`".repeat(Math.max(1, longestBacktickRun(content) + 1));
  const padding = /^[` ]|[` ]$/.test(content) ? " " : "";
  return `${fence}${padding}${content}${padding}${fence}`;
}

class MarkdownRenderer {
  private readonly base: string;
  constructor(base: string) { this.base = base; }

  render(root: Node) { return compactBlock(this.children(root, 0)); }

  private children(node: Node, depth: number) {
    let result = "";
    const children = node.children;
    for (let index = 0; index < children.length; index++) result += this.node(children[index]!, depth, index);
    return result;
  }

  private node(node: Node, depth: number, index: number): string {
    const tag = node.tag;
    if (tag === null) return this.text(node, index);
    switch (tag) {
      case "script": case "style": case "noscript": case "template": case "meta": case "link": case "base": case "source": case "track": case "input": return "";
      case "br": return "  \n";
      case "hr": return "\n\n---\n\n";
      case "h1": case "h2": case "h3": case "h4": case "h5": case "h6": {
        const content = compactInline(this.children(node, depth));
        return content ? `\n\n${"#".repeat(Math.max(2, Number(tag[1])))} ${content}\n\n` : "";
      }
      case "p": case "article": case "main": case "section": case "div": case "header": case "footer": case "address": case "figcaption": case "dl": case "dd":
        return block(this.children(node, depth));
      case "strong": case "b": return wrapInline(this.children(node, depth), "**");
      case "em": case "i": return wrapInline(this.children(node, depth), "*");
      case "del": case "s": case "strike": return wrapInline(this.children(node, depth), "~~");
      case "code": return node.parent?.tag === "pre" ? node.rawText : inlineCode(node.rawText);
      case "pre": return this.codeBlock(node);
      case "a": return this.link(node, depth);
      case "img": return this.image(node);
      case "picture": return this.picture(node);
      case "ul": case "ol": return this.list(node, depth);
      case "blockquote": return this.quote(node, depth);
      case "table": return this.table(node);
      case "dt": {
        const content = compactInline(this.children(node, depth));
        return content ? `\n\n**${content}**\n` : "";
      }
      case "sup": case "sub": {
        const content = compactInline(this.children(node, depth));
        return content ? `<${tag}>${content}</${tag}>` : "";
      }
      case "iframe": case "video": case "audio": {
        const source = this.safeURL(node.attribute("src"), false);
        return source === undefined ? this.children(node, 0) : `\n\n[Embedded media](${markdownDestination(source)})\n\n`;
      }
      case "math": return math(node);
      default: return this.children(node, depth);
    }
  }

  private text(node: Node, index: number) {
    const siblings = node.parent?.children;
    if (siblings && blank(node.value) && ((index > 0 && blockTags.has(siblings[index - 1]!.tag ?? "")) || (index + 1 < siblings.length && blockTags.has(siblings[index + 1]!.tag ?? "")))) return "";
    return escapeText(collapse(node.value));
  }

  private link(node: Node, depth: number) {
    const content = compactInline(this.children(node, depth));
    const destination = this.safeURL(node.attribute("href"), false);
    if (destination === undefined) return content;
    return `[${content || escapeText(destination)}](${markdownDestination(destination)}${titleSuffix(node)})`;
  }

  private image(node: Node) {
    const destination = this.bestImageURL(node);
    return destination === undefined ? escapeText(trim(node.attribute("alt"))) : this.markdownImage(node, destination);
  }

  private picture(node: Node) {
    const descendants = node.elements;
    const image = descendants.find(element => element.tag === "img");
    if (!image) return "";
    const own = this.bestImageURL(image);
    if (own !== undefined) return this.markdownImage(image, own);
    for (const source of descendants) {
      if (source.tag !== "source") continue;
      const destination = this.bestImageURL(source);
      if (destination !== undefined) return this.markdownImage(image, destination);
    }
    return "";
  }

  private markdownImage(node: Node, destination: string) {
    return `![${escapeText(trim(node.attribute("alt")))}](${markdownDestination(destination)}${titleSuffix(node)})`;
  }

  private bestImageURL(node: Node) {
    let best: string | undefined, weight = 0;
    for (const entry of node.attribute("srcset").split(",")) {
      const parts = splitSpaces(trim(entry));
      if (!parts.length) continue;
      const descriptor = parts[1] ?? "1x";
      const value = descriptor.endsWith("w") ? double(descriptor.slice(0, -1)) ?? 0 : descriptor.endsWith("x") ? (double(descriptor.slice(0, -1)) ?? 1) * 1_000 : 1;
      if (best === undefined || weight < value) { best = parts[0]; weight = value; }
    }
    const resolved = best === undefined ? undefined : this.safeURL(best, true);
    return resolved ?? this.safeURL(node.attribute("src"), true);
  }

  private list(node: Node, depth: number) {
    const ordered = node.tag === "ol";
    const parsed = /^[+-]?\d+$/.test(node.attribute("start")) ? Number(node.attribute("start")) : NaN;
    const start = Number.isSafeInteger(parsed) ? parsed : 1;
    const lines = node.children.filter(child => child.tag === "li").map((item, index) => {
      let primary = "", nested = "";
      item.children.forEach((child, position) => {
        if (child.tag === "ul" || child.tag === "ol") nested += this.list(child, depth + 1);
        else primary += this.node(child, depth, position);
      });
      const checkbox = item.elements.find(element => element.tag === "input" && element.attribute("type").toLowerCase() === "checkbox");
      const task = checkbox ? checkbox.attributes.has("checked") ? "[x] " : "[ ] " : "";
      const marker = ordered ? `${start + index}. ` : "- ";
      const indent = "  ".repeat(depth);
      const continuation = indent + " ".repeat(marker.length);
      const content = compactBlock(primary).split(lineBreak).map((line, offset) => offset === 0 ? line : continuation + line).join("\n");
      return `${indent}${marker}${task}${content}${nested}`;
    });
    return lines.length ? `\n${lines.join("\n")}\n` : "";
  }

  private quote(node: Node, depth: number) {
    const content = compactBlock(this.children(node, depth));
    return content ? `\n\n${content.split(lineBreak).map(line => `> ${line}`).join("\n")}\n\n` : "";
  }

  private codeBlock(node: Node) {
    const content = trimNewlines(node.rawText);
    if (!content) return "";
    const fence = "`".repeat(Math.max(3, longestBacktickRun(content) + 1));
    const classes = node.children.find(child => child.tag === "code")?.attribute("class") ?? "";
    const language = splitSpaces(classes).map(token => token.startsWith("language-") ? token.slice(9) : token.startsWith("lang-") ? token.slice(5) : undefined)
      .find(value => value !== undefined) ?? "";
    return `\n\n${fence}${language}\n${content}\n${fence}\n\n`;
  }

  private table(node: Node) {
    const rows = node.elements.filter(row => {
      if (row.tag !== "tr") return false;
      for (let parent = row.parent; parent; parent = parent.parent) if (parent.tag === "table") return parent === node;
      return false;
    });
    const rendered = rows.map(row => row.children.filter(cell => cell.tag === "td" || cell.tag === "th")
      .map(cell => compactBlock(this.children(cell, 0)).replaceAll("\n", " ").replaceAll("|", "\\|"))).filter(cells => cells.length);
    const width = rendered.reduce((largest, cells) => Math.max(largest, cells.length), 0);
    if (!width) return "";
    const row = (cells: string[]) => `| ${[...cells, ...Array<string>(width - cells.length).fill("")].join(" | ")} |`;
    const separator = `| ${Array<string>(width).fill("---").join(" | ")} |`;
    return `\n\n${[row(rendered[0]!), separator, ...rendered.slice(1).map(row)].join("\n")}\n\n`;
  }

  private safeURL(value: string, image: boolean) {
    const trimmed = trim(value);
    if (!trimmed) return undefined;
    if (trimmed.startsWith("#")) return trimmed;
    const resolved = resolveURL(trimmed, this.base);
    if (!resolved) return undefined;
    const scheme = resolved.url.protocol.slice(0, -1);
    return (image ? ["http", "https"] : ["http", "https", "mailto", "tel"]).includes(scheme) ? resolved.href : undefined;
  }
}

function math(node: Node) {
  for (const name of ["data-latex", "alttext", "alt"]) {
    const value = trim(node.attribute(name));
    if (value) return `$${value}$`;
  }
  const content = trim(node.textContent);
  return content ? `$${content}$` : "";
}

function normalizeImages(root: Node) {
  for (const image of root.elements) {
    if (image.tag !== "img" && image.tag !== "source") continue;
    for (const [target, sources] of [["src", ["data-src", "data-original", "data-lazy-src", "data-url"]], ["srcset", ["data-srcset", "data-lazy-srcset"]]] as const) {
      if (trim(image.attribute(target))) continue;
      const value = sources.map(name => trim(image.attribute(name))).find(Boolean);
      if (value) image.attributes.set(target, value);
    }
  }
}

function removeDiscarded(root: Node) {
  for (const element of root.elements.reverse()) {
    const identity = element.identity;
    const classes = element.classTokens;
    const hidden = element.attributes.has("hidden") || element.attribute("aria-hidden").toLowerCase() === "true"
      || hiddenStyle.test(element.attribute("style").toLowerCase()) || classes.has("hidden") || classes.has("invisible");
    const preserved = identity.includes("paywall") || identity.includes("math") || element.tag === "svg";
    if (discardedTags.has(element.tag!) || discardedRoles.has(element.attribute("role").toLowerCase())
      || ["dismiss", "close"].includes(element.attribute("aria-label").toLowerCase()) || (hidden && !preserved)) element.remove();
  }
}

function preferredRank(element: Node) {
  const id = element.attribute("id").toLowerCase();
  const classes = element.classTokens;
  const role = element.attribute("role").toLowerCase();
  const selectors = [
    id === "post", classes.has("post-content"), classes.has("post-body"), classes.has("article-content") || id === "article-content",
    classes.has("js-article-content"), classes.has("article_post"), classes.has("article-wrapper"), classes.has("entry-content"),
    classes.has("content-article"), classes.has("instapaper_body"), classes.has("markdown-body"), element.tag === "article" || role === "article",
    element.tag === "main" || role === "main", classes.has("article-body"), id === "main-content", id === "content",
  ];
  const rank = selectors.indexOf(true);
  return rank < 0 ? undefined : rank;
}

function contentScore(element: Node) {
  const text = element.textContent;
  const words = wordCount(text);
  if (!words) return -Infinity;
  let paragraphs = 0, images = 0, links = 0, commas = 0;
  for (const child of element.elements) {
    if (child.tag === "p") paragraphs++;
    else if (child.tag === "img") images++;
    else if (child.tag === "a") links += child.textContent.length;
  }
  for (let index = 0; index < text.length; index++) if (text.charCodeAt(index) === 44) commas++;
  const density = Math.min(links / Math.max(text.length, 1), 0.8);
  const identity = element.identity;
  const role = element.attribute("role").toLowerCase();
  let score = words + paragraphs * 10 + commas - images / Math.max(words, 1) * 3;
  if (positiveTerms.some(term => identity.includes(term))) score += 35;
  if (negativeTerms.some(term => identity.includes(term))) score -= 65;
  if (element.tag === "article") score += 45;
  if (element.tag === "main") score += 35;
  if (element.tag === "blockquote") score += 10;
  if (role === "article" || role === "main") score += 35;
  return score * (1 - density);
}

function bestElement(elements: Node[]) {
  let best: Node | undefined, top = -Infinity;
  for (const element of elements) {
    const score = contentScore(element);
    if (best === undefined || top < score) { best = element; top = score; }
  }
  return best;
}

function contentRoot(body: Node) {
  const ranked: [Node, number][] = [];
  for (const element of body.elements) {
    const rank = preferredRank(element);
    if (rank !== undefined && wordCount(element.textContent) >= 20) ranked.push([element, rank]);
  }
  if (ranked.length) {
    const first = ranked.reduce((lowest, [, rank]) => Math.min(lowest, rank), Infinity);
    const best = bestElement(ranked.filter(([, rank]) => rank === first).map(([element]) => element));
    if (best) return best;
  }
  const best = bestElement(body.elements.filter(element => structuralTags.has(element.tag!)));
  return best && wordCount(best.textContent) >= 30 ? best : body;
}

const hasRich = (element: Node) => element.elements.some(child => richTags.has(child.tag!));

function removeClutter(root: Node) {
  for (const block of root.elements.filter(element => clutterTags.has(element.tag!)).reverse()) {
    const text = block.textContent;
    const words = wordCount(text);
    if (words >= 120) continue;
    let paragraphs = 0, links = 0, rich = false;
    for (const child of block.elements) {
      if (child.tag === "p") paragraphs++;
      else if (child.tag === "a") links += child.textContent.length;
      if (richTags.has(child.tag!)) rich = true;
    }
    const identity = block.identity;
    const positive = positiveTerms.some(term => identity.includes(term));
    const negative = negativeTerms.some(term => identity.includes(term));
    if (negative && !positive && paragraphs < 3 && !rich) block.remove();
    else if (words < 100 && paragraphs < 6 && !rich && links / Math.max(text.length, 1) > 0.62) block.remove();
  }
  for (const element of root.elements.reverse()) {
    if (element.tag === "p") continue;
    const identity = element.identity;
    if (negativeTerms.some(term => identity.includes(term)) && wordCount(element.textContent) < 40 && !hasRich(element)) element.remove();
  }
  for (const heading of root.elements.filter(element => headings.has(element.tag!)).reverse()) {
    if (!hasContentAfter(heading, root)) heading.remove();
  }
}

function hasContentAfter(node: Node, root: Node) {
  let current = node;
  while (current.parent) {
    const parent = current.parent;
    const index = parent.children.indexOf(current);
    if (index >= 0 && parent.children.slice(index + 1).some(meaningful)) return true;
    if (parent === root) return false;
    current = parent;
  }
  return false;
}

function meaningful(node: Node) {
  if (node.tag === null) return !blank(node.value);
  if (headings.has(node.tag)) return false;
  if (meaningfulTags.has(node.tag)) return true;
  return node.textContent !== "";
}

const normalizedTitle = (value: string) => trim(collapse(value)).toLowerCase();

function extract(root: Node, title: string, base: string, removesClutter: boolean) {
  if (removesClutter) removeClutter(root);
  const heading = title ? root.first(node => node.tag === "h1") : undefined;
  if (heading && normalizedTitle(title) === normalizedTitle(heading.textContent)) heading.remove();
  for (const element of root.elements.reverse()) {
    if (!removableTags.has(element.tag!) || trim(element.textContent)) continue;
    if (element.elements.every(child => !mediaTags.has(child.tag!))) element.remove();
  }
  return new MarkdownRenderer(base).render(root);
}

export function htmlMarkdown(html: string, base: string) {
  const document = parse(html);
  const og = document.elements.find(element => element.tag === "meta" && element.attribute("property").toLowerCase() === "og:title");
  const title = og ? og.attribute("content") : document.first(node => node.tag === "title")?.textContent ?? "";
  const body = document.first(node => node.tag === "body") ?? document.first(node => node.tag === "html") ?? document;
  for (const noscript of body.elements.filter(element => element.tag === "noscript").reverse()) noscript.unwrap();
  normalizeImages(body);
  removeDiscarded(body);
  const root = contentRoot(body);
  const aggressive = extract(root.copy(), title, base, true);
  const words = wordCount(aggressive);
  if (words >= 200) return aggressive;
  const relaxed = extract(root.copy(), title, base, false);
  if (wordCount(relaxed) > words * 2) return relaxed;
  return aggressive || relaxed || undefined;
}

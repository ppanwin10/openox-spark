import { h, icon } from "./dom";

export type Resolve = (target: string) => { href: string; file: boolean; image: boolean } | undefined;

const fence = /^\s*(```+|~~~+)\s*([\w+#.-]*)\s*$/;
const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const rule = /^\s*([-*_])(\s*\1){2,}\s*$/;
const listItem = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const tableDivider = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;
const trailing = /[.,:;!?'")\]]+$/;

function link(target: string, children: Node[], resolve: Resolve) {
  const resolved = resolve(target.trim());
  if (!resolved) return children;
  return [h("a", { href: resolved.href, target: "_blank", rel: "noopener noreferrer", className: resolved.file ? "file-link" : null }, ...children)];
}

function image(alt: string, target: string, resolve: Resolve) {
  const resolved = resolve(target.trim());
  if (!resolved) return [document.createTextNode(alt)];
  if (resolved.file && resolved.image) {
    return [h("a", { href: resolved.href, target: "_blank", rel: "noopener noreferrer", className: "inline-image" },
      h("img", { src: resolved.href, alt, loading: "lazy" }))];
  }
  return [h("a", { href: resolved.href, target: "_blank", rel: "noopener noreferrer", className: resolved.file ? "file-link" : null }, alt || target)];
}

export function inline(text: string, resolve: Resolve): Node[] {
  const nodes: Node[] = [];
  let buffer = "";
  const flush = () => { if (buffer) { nodes.push(document.createTextNode(buffer)); buffer = ""; } };
  let index = 0;
  while (index < text.length) {
    const rest = text.slice(index);
    const previous = index === 0 ? " " : text[index - 1]!;
    let match: RegExpExecArray | null;
    if (rest[0] === "\\" && rest[1] && /[\\`*_{}[\]()#+\-.!~|>]/.test(rest[1])) { buffer += rest[1]; index += 2; continue; }
    if ((match = /^(`+)([\s\S]*?[^`])\1(?!`)/.exec(rest))) {
      flush(); nodes.push(h("code", {}, match[2]!.replace(/^ (.*) $/, "$1"))); index += match[0].length; continue;
    }
    if ((match = /^!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/.exec(rest))) {
      flush(); nodes.push(...image(match[1]!, match[2]!, resolve)); index += match[0].length; continue;
    }
    if ((match = /^\[((?:[^\]\\]|\\.)+)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/.exec(rest))) {
      flush(); nodes.push(...link(match[2]!, inline(match[1]!, resolve), resolve)); index += match[0].length; continue;
    }
    if ((match = /^<(https?:\/\/[^>\s]+)>/.exec(rest))) {
      flush(); nodes.push(...link(match[1]!, [document.createTextNode(match[1]!)], resolve)); index += match[0].length; continue;
    }
    if (/[\s(]/.test(previous) && (match = /^https?:\/\/[^\s<>]+/.exec(rest))) {
      const url = match[0].replace(trailing, "");
      flush(); nodes.push(...link(url, [document.createTextNode(url)], resolve)); index += url.length; continue;
    }
    if ((match = /^(\*\*|__)(?=\S)([\s\S]*?\S)\1/.exec(rest)) && (match[1] === "**" || /\W/.test(previous))) {
      flush(); nodes.push(h("strong", {}, ...inline(match[2]!, resolve))); index += match[0].length; continue;
    }
    if ((match = /^~~(?=\S)([\s\S]*?\S)~~/.exec(rest))) {
      flush(); nodes.push(h("del", {}, ...inline(match[1]!, resolve))); index += match[0].length; continue;
    }
    if ((match = /^(\*|_)(?=[^\s*_])([\s\S]*?[^\s\\])\1(?![*_])/.exec(rest)) && (match[1] === "*" || /\W/.test(previous))) {
      flush(); nodes.push(h("em", {}, ...inline(match[2]!, resolve))); index += match[0].length; continue;
    }
    buffer += rest[0];
    index += 1;
  }
  flush();
  return nodes;
}

function paragraph(lines: string[], resolve: Resolve) {
  const element = h("p");
  lines.forEach((line, position) => {
    if (position) element.append(h("br"));
    element.append(...inline(line.trim(), resolve));
  });
  return element;
}

function cells(line: string) {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/).map(cell => cell.trim());
}

function list(lines: string[], start: number, resolve: Resolve): [HTMLElement, number] {
  const first = listItem.exec(lines[start]!)!;
  const indent = first[1]!.length;
  const ordered = /\d/.test(first[2]!);
  const element = ordered ? h("ol", { start: Number.parseInt(first[2]!, 10) === 1 ? null : Number.parseInt(first[2]!, 10) }) : h("ul");
  let index = start;
  while (index < lines.length) {
    const match = listItem.exec(lines[index]!);
    if (!match || match[1]!.length !== indent || /\d/.test(match[2]!) !== ordered) break;
    const body: string[] = [match[3]!];
    index += 1;
    const children: Node[] = [];
    while (index < lines.length) {
      const line = lines[index]!;
      const nested = listItem.exec(line);
      if (nested && nested[1]!.length > indent) {
        const [child, next] = list(lines, index, resolve);
        children.push(child);
        index = next;
        continue;
      }
      if (!line.trim() || nested || !/^\s+/.test(line)) break;
      body.push(line.trim());
      index += 1;
    }
    const task = /^\[([ xX])\]\s+(.*)$/.exec(body[0]!);
    const item = h("li", { className: task ? "task" : null });
    if (task) { body[0] = task[2]!; item.append(h("span", { className: `task-box${task[1] === " " ? "" : " done"}`, "aria-hidden": "true" })); }
    item.append(...inline(body.join(" "), resolve), ...children);
    element.append(item);
    while (index < lines.length && !lines[index]!.trim() && listItem.exec(lines[index + 1] ?? "")?.[1]?.length === indent) index += 1;
  }
  return [element, index];
}

export function markdown(text: string, resolve: Resolve, copyLabel = "Copy") {
  const fragment = document.createDocumentFragment();
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let index = 0;
  let buffer: string[] = [];
  const flush = () => { if (buffer.length) { fragment.append(paragraph(buffer, resolve)); buffer = []; } };
  while (index < lines.length) {
    const line = lines[index]!;
    const open = fence.exec(line);
    if (open) {
      flush();
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !new RegExp(`^\\s*${open[1]![0] === "`" ? "`" : "~"}{${open[1]!.length},}\\s*$`).test(lines[index]!)) code.push(lines[index++]!);
      index += 1;
      const source = code.join("\n");
      const copy = h("button", { type: "button", className: "copy", "aria-label": copyLabel, title: copyLabel, "data-testid": "copy-code" }, icon("copy", 16));
      copy.addEventListener("click", () => copyText(copy, copy.closest(".code-block")?.querySelector("code")?.textContent ?? ""));
      fragment.append(h("div", { className: "code-block" }, h("div", { className: "code-head" }, h("span", {}, open[2] || "text"), copy),
        h("pre", {}, h("code", {}, source))));
      continue;
    }
    if (!line.trim()) { flush(); index += 1; continue; }
    const title = heading.exec(line);
    if (title) { flush(); fragment.append(h(`h${Math.min(title[1]!.length + 2, 6)}` as "h3", {}, ...inline(title[2]!, resolve))); index += 1; continue; }
    if (rule.test(line)) { flush(); fragment.append(h("hr")); index += 1; continue; }
    if (/^\s*>/.test(line)) {
      flush();
      const quoted: string[] = [];
      while (index < lines.length && /^\s*>/.test(lines[index]!)) quoted.push(lines[index++]!.replace(/^\s*>\s?/, ""));
      fragment.append(h("blockquote", {}, markdown(quoted.join("\n"), resolve, copyLabel)));
      continue;
    }
    if (line.includes("|") && tableDivider.test(lines[index + 1] ?? "") && lines[index + 1]!.includes("-")) {
      flush();
      const header = cells(line);
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && lines[index]!.includes("|") && lines[index]!.trim()) rows.push(cells(lines[index++]!));
      fragment.append(h("div", { className: "table" }, h("table", {},
        h("thead", {}, h("tr", {}, header.map(cell => h("th", {}, ...inline(cell, resolve))))),
        h("tbody", {}, rows.map(row => h("tr", {}, header.map((_, column) => h("td", {}, ...inline(row[column] ?? "", resolve)))))))));
      continue;
    }
    if (listItem.test(line)) {
      flush();
      const [element, next] = list(lines, index, resolve);
      fragment.append(element);
      index = next;
      continue;
    }
    buffer.push(line);
    index += 1;
  }
  flush();
  return fragment;
}

export function copyText(button: HTMLElement, text: string, size = 16) {
  void navigator.clipboard?.writeText(text).then(() => {
    button.replaceChildren(icon("check", size));
    button.dataset.copied = "true";
    setTimeout(() => { button.replaceChildren(icon("copy", size)); delete button.dataset.copied; }, 1_500);
  }, () => {});
}

function morph(target: Node, source: Node) {
  if (target.nodeType !== Node.ELEMENT_NODE) { if (target.nodeValue !== source.nodeValue) target.nodeValue = source.nodeValue; return; }
  const element = target as Element, next = source as Element;
  for (const { name } of [...element.attributes]) if (!next.hasAttribute(name)) element.removeAttribute(name);
  for (const { name, value } of [...next.attributes]) if (element.getAttribute(name) !== value) element.setAttribute(name, value);
  morphChildren(target, source);
}

export function morphChildren(target: Node, source: Node) {
  const next = [...source.childNodes];
  next.forEach((child, index) => {
    const current = target.childNodes[index];
    if (!current) target.appendChild(child);
    else if (current.nodeType === child.nodeType && current.nodeName === child.nodeName) morph(current, child);
    else target.replaceChild(child, current);
  });
  while (target.childNodes.length > next.length) target.lastChild!.remove();
}

export function patchMarkdown(container: Element, text: string, resolve: Resolve, copyLabel = "Copy") {
  morphChildren(container, markdown(text, resolve, copyLabel));
}

export function closeOpen(text: string) {
  let body = text;
  const lineStart = body.lastIndexOf("\n") + 1;
  const last = body.slice(lineStart);
  if (last.trim() && /^\s*(#{1,6}|[-*+]|\d{1,9}[.)]?|>|`{1,2}|~{1,2}|\|)\s*$/.test(last)) body = body.slice(0, lineStart);
  if ((body.match(/^\s*(```|~~~)/gm) ?? []).length % 2) return body;
  const split = body.lastIndexOf("\n\n");
  const start = split < 0 ? 0 : split + 2;
  if ((body.slice(start).match(/`/g) ?? []).length % 2) return body.endsWith("`") ? body.slice(0, -1) : `${body}\``;
  const paragraph = body.slice(start);
  const bracket = paragraph.lastIndexOf("[");
  if (bracket >= 0 && !/^\[[^\]]*\]\([^)]*\)/.test(paragraph.slice(bracket)) && !/^\[[^\]]*\](?=[^(])/.test(paragraph.slice(bracket))) body = body.slice(0, start + bracket);
  const strong = ((body.slice(start).replace(/`[^`]*`/g, "").match(/\*\*/g) ?? []).length % 2) === 1;
  const opener = /\*\*\s*$/.exec(body);
  if (strong && opener) return body.slice(0, opener.index);
  if (strong && /[^*]\*$/.test(body)) body = body.slice(0, -1);
  else if (!strong && /(^|\s)\*$/.test(body)) return body.slice(0, -1);
  return strong ? `${body}**` : body;
}

import { h, icon } from "./dom";
import { t, type StringKey } from "./i18n";

type Rule = readonly [RegExp, string, RegExp?];
type Token = readonly [string, string | null];

const highlightLimit = 100_000;
const quoted = String.raw`(?<!\\)"(?:[^"\\]|\\.)*"`;
const apostrophed = String.raw`(?<!\\)'(?:[^'\\]|\\.)*'`;
const decimal = String.raw`\b\d+(?:\.\d+)?\b`;
const words = (list: string) => String.raw`\b(?:${list})\b`;
const rule = (pattern: string, token: string, key?: RegExp): Rule => [new RegExp(pattern, "g"), token, key];

const grammars = new Map<string, readonly Rule[]>([
  ["json", [
    rule(quoted, "string", /\s*:/y),
    rule(String.raw`\b-?\d+(?:\.\d+)?\b`, "number"),
    rule(words("true|false|null"), "keyword"),
  ]],
  ["python", [
    rule("#[^\\n]*", "comment"),
    rule(`${quoted}|${apostrophed}`, "string"),
    rule(String.raw`f"(?:[^"\\]|\\.)*"|f'(?:[^'\\]|\\.)*'`, "string"),
    rule(words("def|class|import|from|return|if|elif|else|for|while|in|not|and|or|is|None|True|False|with|as|try|except|finally|raise|lambda|yield|pass|break|continue|global|nonlocal"), "keyword"),
    rule(decimal, "number"),
  ]],
  ["bash", [
    rule("#[^\\n]*", "comment"),
    rule(String.raw`${quoted}|(?<!\\)'[^']*'`, "string"),
    rule(words("if|then|else|elif|fi|for|in|do|done|while|case|esac|function|return|export|local|cd|echo"), "keyword"),
    rule(String.raw`\$\{?[A-Za-z_][A-Za-z0-9_]*\}?`, "number"),
  ]],
  ["swift", [
    rule("//[^\\n]*", "comment"),
    rule(quoted, "string"),
    rule(words("let|var|func|struct|class|enum|protocol|extension|if|else|guard|for|in|while|return|import|private|public|internal|static|self|init|nil|true|false|throws|try|catch|async|await"), "keyword"),
    rule(decimal, "number"),
  ]],
  ["javascript", [
    rule("//[^\\n]*", "comment"),
    rule(String.raw`/\*[\s\S]*?\*/`, "comment"),
    rule(String.raw`${quoted}|${apostrophed}|(?<!\\)` + "`(?:[^`\\\\]|\\\\.)*`", "string"),
    rule(words("const|let|var|function|return|if|else|for|while|switch|case|break|continue|new|class|extends|import|from|export|default|async|await|try|catch|finally|throw|typeof|instanceof|null|undefined|true|false|this"), "keyword"),
    rule(decimal, "number"),
  ]],
]);
const aliases = new Map(Object.entries({ py: "python", sh: "bash", shell: "bash", zsh: "bash", js: "javascript", typescript: "javascript", ts: "javascript", tsx: "javascript", jsx: "javascript" }));

export const isDiff = (language: string) => ["diff", "patch"].includes(language.trim().toLowerCase());

function tokenize(source: string, rules: readonly Rule[]) {
  const found: (RegExpExecArray | null | undefined)[] = rules.map(() => undefined);
  const tokens: Token[] = [];
  let position = 0;
  for (;;) {
    let best = -1;
    rules.forEach(([pattern], index) => {
      let match = found[index];
      if (match === null) return;
      if (match === undefined || match.index < position) {
        pattern.lastIndex = position;
        match = found[index] = pattern.exec(source);
        if (match && !match[0]) match = found[index] = null;
        if (!match) return;
      }
      if (best < 0 || match.index < found[best]!.index) best = index;
    });
    if (best < 0) break;
    const match = found[best]!;
    const [, token, key] = rules[best]!;
    const end = match.index + match[0].length;
    if (match.index > position) tokens.push([source.slice(position, match.index), null]);
    if (key) key.lastIndex = end;
    tokens.push([match[0], key?.test(source) ? "key" : token]);
    position = end;
  }
  if (position < source.length) tokens.push([source.slice(position), null]);
  return tokens;
}

export function highlight(source: string, language: string): Node[] {
  const name = language.trim().toLowerCase();
  const rules = grammars.get(aliases.get(name) ?? name);
  if (!rules || source.length > highlightLimit) return [document.createTextNode(source)];
  return tokenize(source, rules).map(([text, token]) => token ? h("span", { className: `syntax-${token}` }, text) : document.createTextNode(text));
}

type Kind = "context" | "addition" | "deletion" | "metadata" | "hunk";
type Line = { kind: Kind; text: string; old?: number; new?: number };
type Change = "modified" | "added" | "deleted" | "renamed" | "binary";
type DiffFile = { oldPath?: string; newPath?: string; change: Change; hunks: Line[][] };
type Cursor = { old: number; new: number; oldLeft: number; newLeft: number };

const metadataPrefixes = ["diff ", "index ", "--- ", "+++ ", "new file mode ", "deleted file mode ", "old mode ", "new mode ", "similarity index ", "dissimilarity index ",
  "rename from ", "rename to ", "copy from ", "copy to ", "Binary files ", "GIT binary patch", "literal ", "delta "];

function cursor(text: string): Cursor | undefined {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(text);
  if (!match) return undefined;
  const [old, oldLeft, next, newLeft] = [match[1]!, match[2] ?? "1", match[3]!, match[4] ?? "1"].map(Number) as [number, number, number, number];
  return Number.isSafeInteger(old + oldLeft) && Number.isSafeInteger(next + newLeft) ? { old, new: next, oldLeft, newLeft } : undefined;
}

function consume(hunk: Cursor, kind: Kind): [number | undefined, number | undefined] | undefined {
  if (kind === "addition" && hunk.newLeft > 0) { hunk.newLeft -= 1; return [undefined, hunk.new++]; }
  if (kind === "deletion" && hunk.oldLeft > 0) { hunk.oldLeft -= 1; return [hunk.old++, undefined]; }
  if (kind === "context" && hunk.oldLeft > 0 && hunk.newLeft > 0) { hunk.oldLeft -= 1; hunk.newLeft -= 1; return [hunk.old++, hunk.new++]; }
  return undefined;
}

const count = (list: Line[], kind: Kind) => list.reduce((total, line) => total + (line.kind === kind ? 1 : 0), 0);

function codeLine(line: Line): Line | undefined {
  if (line.kind !== "context" && line.kind !== "addition" && line.kind !== "deletion") return undefined;
  return { ...line, text: line.text.startsWith(" ") || line.kind !== "context" ? line.text.slice(1) : line.text };
}

function unquote(value: string) {
  if (!value.startsWith("\"") || !value.endsWith("\"")) return value;
  const input = new TextEncoder().encode(value.slice(1, -1));
  const escapes: Record<number, number> = { 97: 7, 98: 8, 116: 9, 110: 10, 118: 11, 102: 12, 114: 13 };
  const output: number[] = [];
  let index = 0;
  const octalDigit = (byte: number | undefined) => byte !== undefined && byte >= 48 && byte <= 55;
  while (index < input.length) {
    const byte = input[index++]!;
    if (byte !== 92 || index >= input.length) { output.push(byte); continue; }
    if (octalDigit(input[index])) {
      let octal = 0;
      for (let digits = 0; digits < 3 && octalDigit(input[index]); digits++) octal = octal * 8 + input[index++]! - 48;
      if (octal > 255) return value;
      output.push(octal);
    } else {
      output.push(escapes[input[index]!] ?? input[index]!);
      index += 1;
    }
  }
  return new TextDecoder().decode(new Uint8Array(output));
}

function filePath(raw: string, strip = true) {
  const decoded = unquote(raw.split("\t")[0]!.replace(/^[\n\v\f\r\u0085\u2028\u2029]+|[\n\v\f\r\u0085\u2028\u2029]+$/g, ""));
  if (decoded === "/dev/null" || !decoded) return undefined;
  return strip && (decoded.startsWith("a/") || decoded.startsWith("b/")) ? decoded.slice(2) : decoded;
}

export function parseDiff(source: string) {
  let hunk: Cursor | undefined;
  const lines = source.split("\n").map((text): Line => {
    if (text.startsWith("@@")) { hunk = cursor(text); return { kind: "hunk", text }; }
    if (text.startsWith("\\")) return { kind: "metadata", text };
    const candidate: Kind = text.startsWith("+") ? "addition" : text.startsWith("-") ? "deletion" : "context";
    const numbers = hunk ? consume(hunk, candidate) : undefined;
    if (numbers && (text.startsWith(" ") || candidate !== "context")) return { kind: candidate, text, old: numbers[0], new: numbers[1] };
    hunk = undefined;
    return { kind: metadataPrefixes.some(prefix => text.startsWith(prefix)) ? "metadata" : candidate, text };
  });
  const files: DiffFile[] = [];
  let builder: { file: DiffFile; phase: "headers" | "old" | "new" | "content" } | undefined;
  const start = () => ({ file: { change: "modified" as Change, hunks: [] }, phase: "headers" as const });
  for (const line of lines) {
    const text = line.text;
    if (text.startsWith("diff --git ")) {
      if (builder) files.push(builder.file);
      const paths = text.slice(11);
      let boundary = paths.indexOf(" b/");
      if (boundary < 0) boundary = paths.indexOf(" \"b/");
      builder = start();
      builder.file.oldPath = filePath(boundary < 0 ? paths : paths.slice(0, boundary));
      builder.file.newPath = boundary < 0 ? undefined : filePath(paths.slice(boundary + 1));
    } else if (line.kind === "metadata" && text.startsWith("--- ")) {
      if (builder?.phase !== "headers") { if (builder) files.push(builder.file); builder = start(); }
      builder.file.oldPath = filePath(text.slice(4));
      if (builder.file.oldPath === undefined) builder.file.change = "added";
      builder.phase = "old";
    } else if (line.kind === "metadata" && text.startsWith("+++ ")) {
      builder ??= start();
      builder.file.newPath = filePath(text.slice(4));
      if (builder.file.newPath === undefined) builder.file.change = "deleted";
      builder.phase = "new";
    } else if (text.startsWith("rename from ")) {
      if (builder) { builder.file.oldPath = filePath(text.slice(12), false); builder.file.change = "renamed"; }
    } else if (text.startsWith("rename to ")) {
      if (builder) { builder.file.newPath = filePath(text.slice(10), false); builder.file.change = "renamed"; }
    } else if (text.startsWith("new file mode ")) {
      if (builder) builder.file.change = "added";
    } else if (text.startsWith("deleted file mode ")) {
      if (builder) builder.file.change = "deleted";
    } else if (text.startsWith("Binary files ") || text === "GIT binary patch") {
      if (builder) builder.file.change = "binary";
    } else if (line.kind === "hunk") {
      if (builder) { builder.file.hunks.push([]); builder.phase = "content"; }
    } else {
      const content = codeLine(line);
      if (content && text && builder && builder.file.change !== "binary") {
        if (!builder.file.hunks.length) builder.file.hunks.push([]);
        builder.file.hunks.at(-1)!.push(content);
        builder.phase = "content";
      }
    }
  }
  if (builder) files.push(builder.file);
  return { files, lines: lines.flatMap(line => codeLine(line) ?? []), additions: count(lines, "addition"), deletions: count(lines, "deletion") };
}

function counts(additions: number, deletions: number) {
  return h("span", { className: "diff-counts", role: "img", "aria-label": t("diffCounts", { added: additions, removed: deletions }) },
    additions ? h("span", { className: "diff-added" }, `+${additions}`) : null, deletions ? h("span", { className: "diff-removed" }, `\u2212${deletions}`) : null);
}

function hunkBody(lines: Line[]) {
  const numbered = lines.some(line => line.old !== undefined || line.new !== undefined);
  const digits = String(lines.reduce((widest, line) => Math.max(widest, line.old ?? 0, line.new ?? 0), 0)).length;
  return h("div", { className: "diff-hunk" }, h("div", { className: `diff-lines${numbered ? " numbered" : ""}`, style: numbered ? `--digits: ${digits}ch` : null },
    ...lines.map(line => h("div", { className: `diff-line ${line.kind}` },
      numbered ? h("span", { className: "diff-number", "aria-hidden": "true" }, line.old === undefined ? "" : String(line.old)) : null,
      numbered ? h("span", { className: "diff-number", "aria-hidden": "true" }, line.new === undefined ? "" : String(line.new)) : null,
      h("span", { className: "diff-text" }, line.text)))));
}

const changeLabel: Record<Exclude<Change, "modified">, StringKey> = { added: "diffAdded", deleted: "diffDeleted", renamed: "diffRenamed", binary: "diffBinary" };

function fileSection(file: DiffFile, streaming: boolean) {
  const all = file.hunks.flat();
  const additions = count(all, "addition"), deletions = count(all, "deletion");
  const path = file.newPath ?? file.oldPath;
  const head = h("summary", { className: "diff-file-head", "data-testid": "diff-file-head" }, h("span", { className: "diff-chevron" }, icon("chevron", 12)),
    h("span", { className: "diff-path" }, h("span", { className: "diff-name", "data-testid": "diff-path" }, path ?? t("diffUntitled")),
      file.change === "renamed" && file.oldPath ? h("span", { className: "diff-old", "data-testid": "diff-old-path" }, file.oldPath) : null),
    file.change !== "modified" ? h("span", { className: "diff-change", "data-testid": "diff-change" }, t(changeLabel[file.change])) : null,
    !streaming && additions + deletions > 0 ? counts(additions, deletions) : null);
  const body = file.change === "binary" ? [h("p", { className: "diff-note" }, t("diffBinaryChanged"))]
    : file.hunks.every(hunk => !hunk.length) ? [h("p", { className: "diff-note" }, t(streaming ? "diffReceiving" : "diffNoText"))]
    : file.hunks.flatMap((hunk, index) => [index ? h("hr", { className: "diff-rule" }) : null, hunk.length ? hunkBody(hunk) : null]);
  return h("details", { className: "diff-file", open: true, "data-testid": "diff-file" }, head, ...body);
}

export function codeBlock(source: string, language: string, copy: HTMLElement, streaming: boolean) {
  if (!isDiff(language)) {
    return h("div", { className: "code-block" }, h("div", { className: "code-head" }, h("span", { className: "code-language" }, language || t("codeText")), copy),
      h("pre", {}, h("code", {}, ...highlight(source, language))));
  }
  const diff = parseDiff(source);
  const summary = streaming ? null : diff.files.length ? h("span", { className: "diff-summary" }, diff.files.length === 1 ? t("diffFile") : t("diffFiles", { count: diff.files.length }))
    : diff.additions + diff.deletions ? counts(diff.additions, diff.deletions) : null;
  const body = diff.files.length ? diff.files.flatMap((file, index) => [index ? h("hr", { className: "diff-divider" }) : null, fileSection(file, streaming)])
    : diff.lines.length ? [hunkBody(diff.lines)] : [];
  return h("div", { className: "code-block diff-block", "data-source": source, "data-testid": "diff-block" },
    h("div", { className: "code-head" }, h("span", { className: "code-language" }, t("diffChanges")), summary, copy), h("div", { className: "diff-body" }, ...body));
}

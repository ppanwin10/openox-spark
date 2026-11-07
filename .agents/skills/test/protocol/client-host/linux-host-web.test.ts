import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Value } from "typebox/value";
import { ROOT } from "../../../../lib.ts";

type Message = { role: string; content: unknown };
type View = { busy: boolean; messages: Message[] };
type Result = Record<string, any>;

const contracts = Object.assign({}, ...["web", "fs", "vision"].map(name =>
  JSON.parse(readFileSync(join(ROOT, "packages/agent/src/functions", name, "contracts.json"), "utf8")))) as Record<string, { outputSchema: object }>;
const chunk = (delta: unknown, finish: string | null = null) => `data: ${JSON.stringify({ id: "chatcmpl-web", object: "chat.completion.chunk", created: 0, model: "fixture",
  choices: [{ index: 0, delta, finish_reason: finish }], ...(finish ? { usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } } : {}) })}\n\n`;
const reply = (value: string) => [chunk({ role: "assistant", content: value }), chunk({}, "stop")];
const call = (source: string) => [chunk({ role: "assistant", tool_calls: [{ index: 0, id: `call_${crypto.randomUUID()}`, type: "function",
  function: { name: "execute", arguments: JSON.stringify({ purpose: "Web step", source }) } }] }), chunk({}, "tool_calls")];
const textOf = (content: unknown): string => typeof content === "string" ? content
  : Array.isArray(content) ? content.map(part => typeof part === "string" ? part : (part as { text?: string }).text ?? "").join("\n") : "";
const script = (source: string) => `run:${Buffer.from(source).toString("base64")}`;

const photo = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAggAAABaCAMAAADq+16EAAAADFBMVEUdHR3////////9/f3C+YPuAAAFgUlEQVR42u2c23LkIAxEofr//3mT1GxiG11aGDJOVfdDHmKGm44FCHDrkvShpi6QBIIkECSBIAkESSBIAkESCJJAkASCJBAkgSAJBEkgSAJBEgiSQJAEgiQQJIEgCQRJIEgCQXokCPhQ+/zz5qpuqAeV5W+2PypkbxUyENCOQvTwlQTx82NGsDL9qFNaFIxHdjYNXNO8PgbcRHbDOFt9pfVKcvI4twaO9oAAx4KxoVEDYbAVUxBGi9h1n2yak+jY0XHbiH51gTOzwAUEp/QtICBpJ5KuWAVCUg8zG8RWoSyIMFGbJmFkFGRd3gNC9sL7hkYJhGurSd5CEmIOwJgwK7ZNkzDYDKlB0d4HwtEhfk2YZl1//hwRCHk9+pgNyQHcLA/lXhLhXMS3aBIw2OxYUAv8Ww7ChjlCUHYw1BmGJlxOBAJRj7Fr4wmC79sQtB+XUih7Ra12Xnffv53rd9E9h9Abz8FYR8vQxwrRIDS4IIBaKJgVSxwCwubCcLXnH5pF5PbA6MXNomFNJJHkivUgMEOVaehDCh6E0SejUI/rP+ocjMOLWe7JzHOLVgME2OOaNQggNhfWxxEQT6QDELAUBKoeV8PFveK9tJZ/jtJws/ugze4Ii6GPMxBwl4PeioQhnwNMgTC8ECjU4/KPxD0nWYaJcBeE1+M6CCCcXN8GQsLeGhBgrgFQqMeZBMy+PMPr3pzw3g0QXquDEQTEIKBH+d4eGFwQguZkk8Hy0NDNuRMK9TgPDtS0CvETNxEQRsIzEF4tTjpmAAFucYsGhmeAACtSUwcB3Ho68KI/j5iunVg14OS0qMAj4pFo0cDgghBknRm6vHwcBnzCQ5u2AhVgo0BgujbaG0t+woDwvRQOHdAqh7AehDGO4G+Rff/ejdSUQOhgAmypi50GwQsLjvkjdxvEVtxKhxCCgDoI4ELMdscYkZriwEhwACpLGoRKnBeXdU1t4c5MbX4VhGFV4FuaBuHceg6EKMTbl4CASRBSDiIQ3CYki53+SBBQBWGMB90CAe8EAfnkxAfBb0F8ZgKPBCE9jzCCcHQJ0yAwc4TdIICJXyCOjphFh/9v/YkgXHdP8snimYRpEJhVw945AgmgB0Lk0cJ4KLaCQK4asjOLnQqcHAaHFctH/O6qAaB2hRB3TJhJNGK0/gQQ/HOTJRB+XMIkCGh2xJoH4VYcgZ4puh0Tw/QeENJpbd3Q6XMrqs7Vw/h5tuc0G1nEj8uzN49DxqgToKgAvGpk2BBingbhvFlQDjF/239604naazDntKRjp87CotdB6PvuNdzYfZwGAcaGK737OG5D4wYI4e7juMrNoxiNXWAV5zarHEJv1fem7QPBmu1R9TAjUuU9W+PMTfE8ApI5fx5xwdQe134QZk4o3QChuz2UnVAyj3/GMdwdJ5SSKIAPAnHoNQCh77zyNn1m8Q4Ixtk17sxii7jgGId5WD3olLkQdzzRfSAIs6eYb4FgxAapU8xolbUcdTMKabHBNjRqIFC/qm1Jvvtew10Qun+LJq2HNYOfblpwwL2llkltA95/vR+Ew62Kz6Wzf9OpfGcuWn4iuFjn1QOtNG8733Ry7w2crkNZaaIBpk2AkFxe8x1Q330tnrxzuBSE6M5Rcgmx4KTX3X3E1E2Tc8Pb00Egb0OvBcFyrmAu39ecNIgdIxARINTixEFs/ckgcN9HWAwCWu37CMkCs934PgLy7yNg6vLZnwMh+YDDFhDsIIlfD9fe4K4LFjwHwB8QCEn4gyD8/4bQAz6itL4er0vEcZY/iXrXV9Wkrq+qSQJBEgiSQJAEgiQQJIEgSQJBEgiSQJAEgiQQJIEgCQRJIEgCQRIIkkCQBIIkECSBIAkESSBIAkESCJJAkASCJBCkX9M/46aqyRmhjZIAAAAASUVORK5CYII=", "base64");
const article = `<!DOCTYPE html><html><head><title>Fixture Article | Fixture Site</title><meta property="og:title" content="Fixture Article"></head><body>
<nav><a href="/">Home</a> <a href="/about">About the site</a></nav>
<header class="site-header"><p>Site header banner</p></header>
<article><h1>Fixture Article</h1>
<p>The fixture article explains how the Linux Host turns HTML into Markdown, with <a href="/linked">a relative link</a>, <strong>strong words</strong> and enough prose for extraction.</p>
<h2>Details</h2>
<ul><li>First item</li><li>Second item</li></ul>
<pre><code class="language-js">console.log("fixture");</code></pre>
<p><img src="/photo.png" alt="Fixture photo"></p>
<table><tr><th>Name</th><th>Value</th></tr><tr><td>alpha</td><td>1</td></tr></table>
</article>
<footer>Footer copyright notice</footer><script>document.write("script text")</script>
</body></html>`;
const feed = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel>
<title>Fixture Feed</title><link>https://feed.example/</link><description>Feed &amp; fixture</description>
<item><title>First post</title><link>/posts/1</link><guid>post-1</guid><pubDate>Mon, 02 Nov 2026 10:00:00 GMT</pubDate>
<description><![CDATA[<p>Hello <b>world</b></p>]]></description><content:encoded><![CDATA[<p>Full text</p>]]></content:encoded></item>
<item><title>Second post</title><link>https://feed.example/posts/2</link><dc:date>2026-11-03</dc:date></item>
</channel></rss>`;

function pdf(pages: string[]) {
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", `<< /Type /Pages /Kids [${pages.map((_, index) => `${4 + index * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  for (const [index, text] of pages.entries()) {
    const stream = `BT /F1 24 Tf 72 700 Td (${text}) Tj ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${5 + index * 2} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`,
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  }
  let body = "%PDF-1.4\n%\xe2\xe3\xcf\xd3\n";
  const offsets = objects.map((object, index) => { const offset = body.length; body += `${index + 1} 0 obj\n${object}\nendobj\n`; return offset; });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}`
    + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

const siteRequests: { path: string; cookie: string | null }[] = [];
function fixtureSite() {
  const server: ReturnType<typeof Bun.serve> = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const { pathname } = new URL(request.url);
    siteRequests.push({ path: pathname, cookie: request.headers.get("cookie") });
    const redirect = (location: string) => new Response(null, { status: 302, headers: { location } });
    const hop = /^\/redirect\/(\d+)$/.exec(pathname);
    const loop = /^\/loop\/(\d+)$/.exec(pathname);
    if (hop) return redirect(Number(hop[1]) > 1 ? `/redirect/${Number(hop[1]) - 1}` : "/article");
    if (loop) return redirect(`/loop/${Number(loop[1]) + 1}`);
    if (pathname === "/escape") return redirect(`http://127.0.0.2:${server.port}/article`);
    if (pathname === "/article") return new Response(article, { headers: { "content-type": "text/html; charset=utf-8", "set-cookie": "session=fixture-secret; Path=/" } });
    if (pathname === "/feed.xml") return new Response(feed, { headers: { "content-type": "application/rss+xml; charset=utf-8" } });
    if (pathname === "/photo.png") return new Response(photo, { headers: { "content-type": "image/png" } });
    if (pathname === "/doc.pdf") return new Response(pdf(["First page text", "Second page text"]), { headers: { "content-type": "application/pdf" } });
    if (pathname === "/notes.txt") return new Response("Plain notes from the fixture site.\n", { headers: { "content-type": "text/plain; charset=utf-8" } });
    if (pathname === "/large") {
      const block = new Uint8Array(1024 * 1024).fill(97);
      let sent = 0;
      return new Response(new ReadableStream({ pull(controller) { if (sent++ < 11) controller.enqueue(block); else controller.close(); } }), { headers: { "content-type": "text/plain" } });
    }
    return new Response("<html><body><p>Not here, the fixture page is missing.</p></body></html>", { status: 404, headers: { "content-type": "text/html" } });
  } });
  return server;
}

let lastExchange: Message[] = [];
function scriptedModel() {
  return Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as { messages: Message[] };
    const start = body.messages.findLastIndex(message => message.role === "user" && textOf(message.content).includes("run:"));
    const exchange = body.messages.slice(start + 1);
    const tool = exchange.find(message => message.role === "tool");
    const encoded = /run:([A-Za-z0-9+/=]+)/.exec(textOf(body.messages[start]?.content))?.[1];
    if (tool) lastExchange = exchange;
    const events = tool ? reply(`OUTPUT ${textOf(tool.content)}`) : encoded ? call(Buffer.from(encoded, "base64").toString("utf8")) : reply("Hello.");
    return new Response(events.join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  } });
}

let data = "";
let site: ReturnType<typeof fixtureSite>;
let model: ReturnType<typeof scriptedModel>;
let host: { process: ReturnType<typeof Bun.spawn>; port: number } | undefined;
let token = "";
let origin = "";
let diagnostics = "";

async function drain(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader(), decoder = new TextDecoder();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    diagnostics += decoder.decode(value);
  }
}

async function startHost() {
  const child = Bun.spawn([process.execPath, `${ROOT}/apps/linux/src/main.ts`, "serve", "--data", data, "--port", "0", "--name", "web"],
    { stdout: "pipe", stderr: "pipe", env: { ...Bun.env, OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "", OX_HOST_TEST_ORIGINS: origin } });
  void drain(child.stderr);
  const reader = child.stdout.getReader();
  let output = "";
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    output += new TextDecoder().decode(value);
    const match = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(output);
    if (match) {
      void (async () => { for (;;) { const { done } = await reader.read(); if (done) return; } })().catch(() => {});
      return { process: child, port: Number(match[1]) };
    }
  }
  child.kill();
  throw new Error(`Host did not start: ${output}${diagnostics}`);
}

function api(path: string, init: RequestInit & { json?: unknown } = {}) {
  const { json, ...rest } = init;
  return fetch(`http://127.0.0.1:${host!.port}${path}`, { ...rest, ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
    headers: { authorization: `Bearer ${token}`, ...(json !== undefined ? { "content-type": "application/json" } : {}), ...rest.headers } });
}

async function provider(images: boolean) {
  const response = await api("/api/settings/providers/custom", { method: "PUT", json: { name: "Scripted", baseUrl: `http://127.0.0.1:${model.port}/v1`, models: ["fixture"], images } });
  expect(response.status).toBe(200);
}

async function conversation(files: Record<string, Uint8Array | string> = {}) {
  const response = await api("/api/conversations", { method: "POST", json: {} });
  expect(response.status).toBe(201);
  const id = (await response.json() as { id: number }).id;
  for (const [name, content] of Object.entries(files)) {
    const body = typeof content === "string" ? content : new Uint8Array(content);
    expect((await api(`/api/conversations/${id}/attachments?name=${name}`, { method: "POST", body })).status).toBe(201);
  }
  return id;
}

async function run(id: number, source: string) {
  expect((await api(`/api/conversations/${id}/messages`, { method: "POST", json: { text: script(source) } })).status).toBe(202);
  const deadline = Date.now() + 30_000;
  for (;;) {
    const view = await (await api(`/api/conversations/${id}`)).json() as View;
    if (!view.busy) {
      const output = textOf([...view.messages].reverse().find(message => message.role === "assistant")?.content);
      expect(output.startsWith("OUTPUT ")).toBe(true);
      return { result: JSON.parse(output.slice(7).split("\n")[0]!) as Result, output: output.slice(7), exchange: lastExchange };
    }
    if (Date.now() > deadline) throw new Error(`Turn did not finish: ${diagnostics.slice(-2_000)}`);
    await Bun.sleep(100);
  }
}

const capture = (expression: string) => `(async () => { try { return await ${expression}; } catch (error) { return { code: error.code, message: error.message }; } })()`;
const fetchCall = (path: string, options?: object) => capture(`ox.web.fetch({ purpose: "Fetch fixture", url: ${JSON.stringify(path.startsWith("http") ? path : origin + path)}${options ? `, options: ${JSON.stringify(options)}` : ""} })`);
const attachCall = (path: string) => capture(`ox.fs.attach({ purpose: "Attach fixture", path: ${JSON.stringify(path.startsWith("/") ? origin + path : path)} })`);
const visionCall = (source: string) => capture(`ox.vision.analyze({ purpose: "Read fixture text", source: ${JSON.stringify(source)} })`);
const collect = (entries: Record<string, string>) => `const result = {};\n${Object.entries(entries).map(([key, expression]) => `result[${JSON.stringify(key)}] = await ${expression};`).join("\n")}\nconsole.log(JSON.stringify(result));`;

function conforms(name: string, value: unknown) {
  const errors = [...Value.Errors(contracts[name]!.outputSchema as Parameters<typeof Value.Check>[0], value)].map(error => `${error.instancePath} ${error.message}`);
  expect(errors).toEqual([]);
}

beforeAll(async () => {
  data = await mkdtemp(join(tmpdir(), "openox-linux-web-"));
  site = fixtureSite();
  model = scriptedModel();
  origin = `http://127.0.0.1:${site.port}`;
  host = await startHost();
  const child = Bun.spawn([process.execPath, `${ROOT}/apps/linux/src/main.ts`, "token", "--name", "web-test", "--data", data], { stdout: "pipe", stderr: "pipe" });
  token = /OX_HOST_TOKEN=(\S+)/.exec(await new Response(child.stdout).text())![1]!;
  await provider(false);
}, 30_000);

afterAll(async () => {
  if (host) {
    host.process.kill("SIGTERM");
    await host.process.exited;
  }
  site?.stop(true);
  model?.stop(true);
  if (data) await rm(data, { recursive: true, force: true });
});

test("ox.web.fetch reads HTML, redirects, feeds and documents without sending cookies", async () => {
  const id = await conversation();
  const { result } = await run(id, collect({
    article: fetchCall("/article"), redirected: fetchCall("/redirect/3"), feed: fetchCall("/feed.xml"), image: fetchCall("/photo.png"),
    pdf: fetchCall("/doc.pdf", { maxPages: 1 }), short: fetchCall("/notes.txt", { maxBytes: 11 }),
  }));
  for (const value of Object.values(result)) conforms("ox.web.fetch", value);
  expect(result.article).toMatchObject({ ok: true, status: 200, statusText: "OK", url: `${origin}/article`, redirected: false, kind: "html", filename: "article.html",
    truncated: false, attached: false, unsupported: null });
  expect(result.article.headers["set-cookie"]).toBeUndefined();
  expect(result.article.headers["content-type"]).toBe("text/html; charset=utf-8");
  const markdown = result.article.text as string;
  expect(markdown).toContain(`The fixture article explains how the Linux Host turns HTML into Markdown, with [a relative link](${origin}/linked), **strong words**`);
  expect(markdown).toContain("## Details\n\n- First item\n- Second item");
  expect(markdown).toContain("```js\nconsole.log(\"fixture\");\n```");
  expect(markdown).toContain(`![Fixture photo](${origin}/photo.png)`);
  expect(markdown).toContain("| Name | Value |\n| --- | --- |\n| alpha | 1 |");
  for (const clutter of ["Fixture Article", "Home", "Site header banner", "Footer copyright", "script text"]) expect(markdown).not.toContain(clutter);
  expect(result.redirected).toMatchObject({ ok: true, redirected: true, url: `${origin}/article`, kind: "html" });
  expect(result.feed).toMatchObject({ kind: "feed", text: null, truncated: false, unsupported: null, feed: {
    title: "Fixture Feed", url: "https://feed.example/", summary: "Feed & fixture",
    entries: [{ title: "First post", url: `${origin}/posts/1`, id: "post-1", published: "Mon, 02 Nov 2026 10:00:00 GMT", summary: "<p>Hello <b>world</b></p>", content: "<p>Full text</p>" },
      { title: "Second post", url: "https://feed.example/posts/2", published: "2026-11-03" }] } });
  expect(result.image).toMatchObject({ kind: "image", filename: "photo.png", bytes: photo.length, text: null, attached: false });
  expect(result.image.unsupported).toContain("ox.fs.attach");
  expect(result.short).toMatchObject({ kind: "text", text: "Plain notes", truncated: true });
  if (Bun.which("pdftotext")) {
    expect(result.pdf).toMatchObject({ kind: "pdf", truncated: true, unsupported: null });
    expect(result.pdf.text).toContain("First page text");
    expect(result.pdf.text).not.toContain("Second page text");
  } else expect(result.pdf.unsupported).toContain("pdftotext");
  expect(siteRequests.filter(request => request.path === "/redirect/3" || request.path === "/article").every(request => request.cookie === null)).toBe(true);
}, 60_000);

test("ox.web.fetch refuses private addresses and enforces redirect, size and count limits", async () => {
  const id = await conversation();
  const { result } = await run(id, collect({
    loop: fetchCall("/loop/0"), large: fetchCall("/large"), literal: fetchCall(`http://127.0.0.2:${site.port}/article`), localhost: fetchCall("http://localhost/"),
    escape: fetchCall("/escape"), missing: fetchCall("/missing"), second: fetchCall("/notes.txt"), third: fetchCall("/notes.txt"), fourth: fetchCall("/notes.txt"),
    fifth: fetchCall("/notes.txt"), ninth: fetchCall("/notes.txt"),
  }));
  expect(result.loop).toMatchObject({ code: "resource_limit" });
  expect(result.loop.message).toContain("five-redirect limit");
  expect(siteRequests.filter(request => request.path.startsWith("/loop/")).length).toBe(6);
  expect(result.large).toMatchObject({ code: "resource_limit" });
  expect(result.large.message).toContain("10 MiB");
  for (const refused of [result.literal, result.localhost]) {
    expect(refused).toMatchObject({ code: "invalid_argument" });
    expect(refused.message).toContain("url must be a public HTTP or HTTPS URL");
  }
  expect(result.escape).toMatchObject({ code: "permission_denied" });
  expect(result.escape.message).toContain("redirect to a non-public or unsupported URL was blocked");
  conforms("ox.web.fetch", result.missing);
  expect(result.missing).toMatchObject({ ok: false, status: 404, statusText: "Not Found", kind: "html" });
  expect(result.missing.text).toContain("Not here, the fixture page is missing.");
  for (const key of ["second", "third", "fourth", "fifth"]) expect(result[key]).toMatchObject({ ok: true, kind: "text" });
  expect(result.ninth).toMatchObject({ code: "resource_limit" });
  expect(result.ninth.message).toContain("at most eight resources");
}, 60_000);

test("ox.fs.attach sends images only to image-capable models and imports URL sources", async () => {
  const jpeg = await new Bun.Image(photo).jpeg({ quality: 90 }).bytes();
  const notes = "# Notes\n\nAttached Markdown body.\n";
  const id = await conversation({ "photo.png": photo, "photo.jpg": jpeg, "notes.md": notes, "data.bin": new Uint8Array([0, 1, 2, 3, 250, 251]) });
  const text = await run(id, collect({ image: attachCall("photo.png"), notes: attachCall("notes.md"), url: attachCall("/notes.txt"), binary: attachCall("data.bin"),
    fifth: attachCall("photo.jpg") }));
  for (const key of ["image", "notes", "url", "binary"]) conforms("ox.fs.attach", text.result[key]);
  expect(text.result.image).toMatchObject({ filename: "photo.png", contentType: "image/png", kind: "image" });
  expect(text.result.notes).toMatchObject({ filename: "notes.md", contentType: "text/markdown", kind: "text", bytes: notes.length });
  expect(text.result.url).toMatchObject({ filename: "notes.txt", contentType: "text/plain", kind: "text" });
  expect(text.result.binary).toMatchObject({ filename: "data.bin", contentType: "application/octet-stream", kind: "file", bytes: 6 });
  expect(text.result.fifth).toMatchObject({ code: "resource_limit" });
  expect(text.result.fifth.message).toContain("at most four sources");
  expect(text.output).toContain(`Image input is unavailable for this model. Use ox.vision.analyze`);
  expect(text.output).toContain(`Available file reference: "conversations/${id}/photo.png".`);
  expect(text.output).toContain(`Attached notes.md (text/markdown, ${notes.length} bytes):\n${notes}`);
  expect(text.output).toContain("Plain notes from the fixture site.");
  expect(text.output).toContain(`Available file reference: "conversations/${id}/data.bin". Native input support for this binary format is unavailable`);
  expect(JSON.stringify(text.exchange)).not.toContain("image_url");
  const listing = await (await api(`/api/files?path=conversations/${id}`)).json() as { entries: { name: string }[] };
  expect(listing.entries.some(entry => /^media-[0-9A-F-]{36}\.txt$/.test(entry.name))).toBe(true);

  await provider(true);
  try {
    const visual = await run(id, collect({ image: attachCall("photo.png"), photo: attachCall("photo.jpg"), url: attachCall("/photo.png") }));
    expect(visual.result.image).toMatchObject({ filename: "photo.png", contentType: "image/png", kind: "image" });
    expect(visual.result.photo).toMatchObject({ filename: "photo.jpg", contentType: "image/jpeg", kind: "image" });
    expect(visual.result.url).toMatchObject({ filename: "photo.png", contentType: "image/png", kind: "image" });
    const images = visual.exchange.flatMap(message => Array.isArray(message.content) ? message.content as { type: string; image_url?: { url: string } }[] : [])
      .filter(part => part.type === "image_url").map(part => part.image_url!.url);
    expect(images.length).toBe(3);
    expect(images.filter(url => url.startsWith("data:image/png;base64,iVBORw0KGgo")).length).toBe(2);
    expect(images.filter(url => url.startsWith("data:image/jpeg;base64,/9j/")).length).toBe(1);
    expect(visual.output).not.toContain("Image input is unavailable");
  } finally { await provider(false); }

  if (Bun.which("pdftotext")) {
    const document = await run(id, collect({ pdf: attachCall("/doc.pdf") }));
    conforms("ox.fs.attach", document.result.pdf);
    expect(document.result.pdf).toMatchObject({ filename: "doc.pdf", contentType: "application/pdf", kind: "pdf" });
    expect(document.output).toContain("First page text");
    expect(document.output).toContain("Second page text");
  }
}, 60_000);

test("ox.vision.analyze reads text with tesseract or names the missing tool", async () => {
  const jpeg = await new Bun.Image(photo).jpeg({ quality: 95 }).bytes();
  const id = await conversation({ "photo.png": photo, "photo.jpg": jpeg, "notes.md": "not an image" });
  const { result } = await run(id, collect({ png: visionCall("photo.png"), jpeg: visionCall(`/conversations/${id}/photo.jpg`), notes: visionCall("notes.md"), missing: visionCall("absent.png") }));
  if (!Bun.which("tesseract")) {
    for (const key of ["png", "jpeg"]) {
      expect(result[key]).toMatchObject({ code: "not_supported" });
      expect(result[key].message).toContain("tesseract");
    }
    return;
  }
  for (const key of ["png", "jpeg"]) {
    conforms("ox.vision.analyze", result[key]);
    expect(result[key]).toMatchObject({ pixelWidth: 520, pixelHeight: 90, recognizedTextTruncated: false, classifications: [], processing: "on-device" });
    expect(result[key].recognizedText).toContain("OPENOX OCR 4217");
  }
  expect(result.png).toMatchObject({ filename: "photo.png", mimeType: "image/png" });
  expect(result.jpeg).toMatchObject({ filename: "photo.jpg", mimeType: "image/jpeg" });
  expect(result.notes).toMatchObject({ code: "invalid_argument" });
  expect(result.notes.message).toContain(`file is not an image: conversations/${id}/notes.md`);
  expect(result.missing).toMatchObject({ code: "not_found" });
}, 60_000);

import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Value } from "typebox/value";
import { ROOT } from "../../../../lib.ts";

type Message = { role: string; content: unknown };
type View = { busy: boolean; messages: { role: string; content: unknown }[] };

const contracts = JSON.parse(readFileSync(join(ROOT, "packages/agent/src/adapters/linux/media-contracts.json"), "utf8")) as Record<string, { outputSchema: object }>;
const chunk = (delta: unknown, finish: string | null = null) => `data: ${JSON.stringify({ id: "chatcmpl-media", object: "chat.completion.chunk", created: 0, model: "fixture",
  choices: [{ index: 0, delta, finish_reason: finish }], ...(finish ? { usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } } : {}) })}\n\n`;
const reply = (value: string) => [chunk({ role: "assistant", content: value }), chunk({}, "stop")];
const call = (source: string) => [chunk({ role: "assistant", tool_calls: [{ index: 0, id: `call_${crypto.randomUUID()}`, type: "function",
  function: { name: "execute", arguments: JSON.stringify({ purpose: "Media step", source }) } }] }), chunk({}, "tool_calls")];
const textOf = (content: unknown): string => typeof content === "string" ? content
  : Array.isArray(content) ? content.map(part => typeof part === "string" ? part : (part as { text?: string }).text ?? "").join("\n") : "";
const script = (source: string) => `run:${Buffer.from(source).toString("base64")}`;
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0xff, 0xd9]);
const wav = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVEfmt "), Buffer.alloc(32)]);

let systems: string[] = [];
let tools = "";
function scriptedModel() {
  return Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (request.method === "GET") return new Response("Not found", { status: 404 });
    const body = await request.json() as { messages: Message[]; tools?: unknown[] };
    systems.push(body.messages.filter(message => message.role === "system" || message.role === "developer").map(message => textOf(message.content)).join("\n"));
    if (body.tools?.length) tools = JSON.stringify(body.tools);
    const last = body.messages.at(-1)!;
    const encoded = /run:([A-Za-z0-9+/=]+)/.exec(textOf([...body.messages].reverse().find(message => message.role === "user")?.content))?.[1];
    const events = last.role === "tool" ? reply(`OUTPUT ${textOf(last.content)}`) : encoded ? call(Buffer.from(encoded, "base64").toString("utf8")) : reply("Hello.");
    return new Response(events.join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  } });
}

const mediaRequests: { path: string; fields: Record<string, string>; file?: { name: string; type: string; size: number }; json?: Record<string, unknown> }[] = [];
let imageMemory = true;
function mediaService() {
  return Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path !== "/health" && request.headers.get("authorization") !== "Bearer media-test-token") return Response.json({ error: { message: "The media service token is missing or wrong", type: "unauthorized" } }, { status: 401 });
    if (path === "/health") return Response.json({ memAvailableBytes: 17_000_000_000, capabilities: [
      { id: "transcription", model: "Qwen3-ASR-0.6B", state: "ready" }, { id: "speech", model: "Qwen3-TTS-12Hz-0.6B-CustomVoice", state: "loads_on_use" },
      { id: "image", model: "Z-Image-Turbo", state: imageMemory ? "loads_on_use" : "insufficient_memory" }] });
    if (request.headers.get("content-type")?.startsWith("multipart/form-data")) {
      const form = await request.formData();
      const file = form.get("file") as File;
      const fields = Object.fromEntries([...form.entries()].filter(([, value]) => typeof value === "string")) as Record<string, string>;
      mediaRequests.push({ path, fields, file: { name: file.name, type: file.type, size: file.size } });
      if (path === "/v1/audio/transcriptions") return Response.json({ text: ` heard ${file.size} bytes `, language: "Chinese" });
      if (path === "/v1/media/extract") {
        if (file.name.endsWith(".mp3")) return Response.json({ kind: "audio", duration: 3, transcript: "only audio" });
        return Response.json({ kind: "video", duration: 9.96, width: 1920, height: 1080, transcript: fields.transcribe === "false" ? null : "video speech",
          frames: Array.from({ length: Math.min(3, Number(fields.max_frames)) }, (_, index) => ({ time: index * 3.333, jpeg_b64: jpeg.toString("base64") })) });
      }
    }
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    mediaRequests.push({ path, fields: {}, json: body });
    if (path === "/v1/audio/speech") {
      if (body.input === "uninstalled") return Response.json({ error: { message: "Qwen3-TTS-12Hz-0.6B-CustomVoice is not installed", type: "not_installed" } }, { status: 503 });
      return new Response(wav, { headers: { "content-type": "audio/wav" } });
    }
    if (path === "/v1/images/generations") {
      if (!imageMemory) return Response.json({ error: { message: "Not enough memory to load Z-Image-Turbo (needs 14.0 GiB, 9.1 GiB available).", type: "insufficient_memory" } }, { status: 503 });
      return Response.json({ created: 0, data: [{ b64_json: png.toString("base64") }] });
    }
    return Response.json({ error: { message: "Not found", type: "not_found" } }, { status: 404 });
  } });
}

let data = "";
let model: ReturnType<typeof scriptedModel>;
let media: ReturnType<typeof mediaService>;
let host: { process: ReturnType<typeof Bun.spawn>; port: number } | undefined;
let token = "";
let profileID = "";

async function startHost(mediaURL: string, env: Record<string, string> = {}) {
  const child = Bun.spawn([process.execPath, `${ROOT}/apps/linux/src/main.ts`, "serve", "--data", data, "--port", "0", "--name", "media"],
    { stdout: "pipe", stderr: "ignore", env: { ...Bun.env, OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "", OPENOX_MEDIA_URL: mediaURL, OPENOX_MEDIA_TOKEN: "media-test-token", ...env } });
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
  throw new Error(`Host did not start: ${output}`);
}

async function stopHost() {
  if (!host) return;
  host.process.kill("SIGTERM");
  await host.process.exited;
  host = undefined;
}

function api(path: string, init: RequestInit & { json?: unknown } = {}) {
  const { json, ...rest } = init;
  return fetch(`http://127.0.0.1:${host!.port}${path}`, { ...rest, ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
    headers: { authorization: `Bearer ${token}`, ...(json !== undefined ? { "content-type": "application/json" } : {}), ...rest.headers } });
}

async function turn(id: number, source: string) {
  expect((await api(`/api/conversations/${id}/messages`, { method: "POST", json: { text: script(source) } })).status).toBe(202);
  const deadline = Date.now() + 60_000;
  for (;;) {
    const view = await (await api(`/api/conversations/${id}`)).json() as View;
    if (!view.busy) {
      const text = textOf([...view.messages].reverse().find(message => message.role === "assistant")?.content);
      expect(text.startsWith("OUTPUT ")).toBe(true);
      return text.slice(7);
    }
    if (Date.now() > deadline) throw new Error("Timed out waiting for the turn");
    await Bun.sleep(100);
  }
}
const value = async <T = Record<string, unknown>>(id: number, source: string) => JSON.parse(await turn(id, source)) as T;
const conforms = (name: string, result: unknown) => expect([...Value.Errors(contracts[name]!.outputSchema as Parameters<typeof Value.Errors>[0], result)].map(error => `${error.instancePath} ${error.message}`)).toEqual([]);
const profilePath = (...parts: string[]) => join(data, "profiles", profileID, "files", ...parts);
async function conversation() {
  const response = await api("/api/conversations", { method: "POST", json: {} });
  return (await response.json() as { id: number }).id;
}
async function upload(id: number, name: string, bytes: Uint8Array<ArrayBuffer> | Uint8Array) {
  const response = await api(`/api/conversations/${id}/attachments?name=${encodeURIComponent(name)}`, { method: "POST", body: new Uint8Array(bytes) });
  expect(response.status).toBe(201);
  return (await response.json() as { path: string }).path;
}

function pdf(pages: string[]) {
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", `<< /Type /Pages /Kids [${pages.map((_, index) => `${4 + index * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  pages.forEach((text, index) => {
    const stream = `BT /F1 24 Tf 72 720 Td (${text}) Tj ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + index * 2} 0 R >>`,
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  let body = "%PDF-1.4\n%\u00E2\u00E3\u00CF\u00D3\n";
  const offsets = objects.map((object, index) => { const offset = body.length; body += `${index + 1} 0 obj\n${object}\nendobj\n`; return offset; });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}`;
  return Uint8Array.from(`${body}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`, character => character.charCodeAt(0));
}

async function office(name: string, source: string, format: string) {
  const directory = await mkdtemp(join(tmpdir(), "openox-office-"));
  try {
    await writeFile(join(directory, name), source);
    const child = Bun.spawn([Bun.which("soffice")!, "--headless", "--norestore", `-env:UserInstallation=file://${directory}/profile`, "--convert-to", format, "--outdir", directory, join(directory, name)],
      { stdout: "ignore", stderr: "ignore", env: { HOME: directory, PATH: process.env.PATH ?? "" } });
    await child.exited;
    return new Uint8Array(await readFile(join(directory, name.replace(/\.[^.]+$/, `.${format}`))));
  } finally { await rm(directory, { recursive: true, force: true }); }
}

beforeAll(async () => {
  data = await mkdtemp(join(tmpdir(), "openox-linux-media-"));
  model = scriptedModel();
  media = mediaService();
  host = await startHost(`http://127.0.0.1:${media.port}`);
  const child = Bun.spawn([process.execPath, `${ROOT}/apps/linux/src/main.ts`, "token", "--name", "media-test", "--data", data], { stdout: "pipe" });
  token = /OX_HOST_TOKEN=(\S+)/.exec(await new Response(child.stdout).text())![1]!;
  expect((await api("/api/settings/providers/custom", { method: "PUT", json: { name: "Scripted", baseUrl: `http://127.0.0.1:${model.port}/v1`, models: ["fixture"], images: true } })).status).toBe(200);
  profileID = JSON.parse(await readFile(join(data, "host.json"), "utf8")).profile.id;
}, 30_000);

afterAll(async () => {
  await stopHost();
  model?.stop(true);
  media?.stop(true);
  if (data) await rm(data, { recursive: true, force: true });
});

test("Media functions generate images, transcribe, speak and look inside videos through the Host's media service", async () => {
  const id = await conversation();
  const image = await value(id, `return await ox.media.generateImage({ purpose: "Draw", prompt: "A warm orange poster that says OpenOx", size: "1536x1024" });`);
  conforms("ox.media.generateImage", image);
  expect(image).toMatchObject({ mimeType: "image/png", width: 1536, height: 1024, bytes: png.length, model: "Z-Image-Turbo" });
  expect(String(image.path)).toMatch(new RegExp(`^conversations/${id}/image-\\d{8}-\\d{6}\\.png$`));
  expect(new Uint8Array(await readFile(profilePath(String(image.path))))).toEqual(new Uint8Array(png));
  expect(mediaRequests.find(entry => entry.path === "/v1/images/generations")?.json).toMatchObject({ prompt: "A warm orange poster that says OpenOx", size: "1536x1024", n: 1 });
  expect(await turn(id, `return await ox.media.generateImage({ purpose: "Draw", prompt: "x", size: "1000x1000" });`)).toContain("multiple of 64");
  const landscape = await value(id, `return await ox.media.generateImage({ purpose: "Draw", prompt: "A wide valley", aspectRatio: "16:9" });`);
  conforms("ox.media.generateImage", landscape);
  expect(landscape).toMatchObject({ width: 1344, height: 768 });
  expect(mediaRequests.findLast(entry => entry.path === "/v1/images/generations")?.json).toMatchObject({ prompt: "A wide valley", size: "1344x768" });
  for (const path of ["skills/trip/references/map.png", "/repositories/local/x.png", "files/folder/x.png"]) {
    expect(await turn(id, `return await ox.media.generateImage({ purpose: "Draw", prompt: "x", path: ${JSON.stringify(path)} });`)).toContain("generated media can't be saved in");
  }
  expect((await value(id, `return await ox.media.generateImage({ purpose: "Draw", prompt: "x", path: "/reports/poster.png" });`)).path).toBe("reports/poster.png");
  expect(tools).toContain("ox.media — Generate images");
  expect(tools).toContain("ox.media.inspectVideo — Look inside one video on this Host.");
  expect(systems.at(-1)).toContain("transcribe audio with ox.media.transcribe");
  imageMemory = false;
  const refused = await turn(id, `return await ox.media.generateImage({ purpose: "Draw", prompt: "x" });`);
  expect(refused).toContain("Not enough memory to load Z-Image-Turbo");
  expect(refused).toContain("Do not retry immediately");
  imageMemory = true;

  const audio = await upload(id, "会议录音.m4a", new Uint8Array(4_096));
  const heard = await value(id, `return await ox.media.transcribe({ purpose: "Listen", path: ${JSON.stringify(audio)}, language: "Chinese" });`);
  conforms("ox.media.transcribe", heard);
  expect(heard).toEqual({ path: audio, text: "heard 4096 bytes", language: "Chinese" });
  expect(mediaRequests.findLast(entry => entry.path === "/v1/audio/transcriptions")).toMatchObject({ fields: { language: "Chinese" }, file: { name: "会议录音.m4a", size: 4_096 } });

  const spoken = await value(id, `return await ox.media.speak({ purpose: "Read", text: "你好，这是 OpenOx。" });`);
  conforms("ox.media.speak", spoken);
  expect(String(spoken.path)).toMatch(/\/speech-\d{8}-\d{6}\.wav$/);
  expect((await readFile(profilePath(String(spoken.path)))).subarray(0, 4).toString()).toBe("RIFF");
  expect(await turn(id, `return await ox.media.speak({ purpose: "Read", text: "x", path: "speech.mp3" });`)).toContain("path must end in .wav");
  const uninstalled = await turn(id, `return await ox.media.speak({ purpose: "Read", text: "uninstalled" });`);
  expect(uninstalled).toContain("is not installed");
  expect(uninstalled).toContain("media.sh --download");
  expect(uninstalled).not.toContain("short of memory");

  const video = await upload(id, "clip.mov", new Uint8Array(8_192));
  const looked = await value<{ frames: { time: number; path: string }[]; transcript: string | null }>(id, `return await ox.media.inspectVideo({ purpose: "Watch", path: ${JSON.stringify(video)}, maxFrames: 3 });`);
  conforms("ox.media.inspectVideo", looked);
  expect(looked).toMatchObject({ path: video, duration: 10, width: 1920, height: 1080, transcript: "video speech" });
  expect(looked.frames.map(frame => frame.path)).toEqual([1, 2, 3].map(index => `conversations/${id}/clip-frames/frame-0${index}.jpg`));
  expect(looked.frames.map(frame => frame.time)).toEqual([0, 3.3, 6.7]);
  expect(existsSync(profilePath(looked.frames[2]!.path))).toBe(true);
  const again = await value<{ frames: { path: string }[]; transcript: string | null }>(id, `return await ox.media.inspectVideo({ purpose: "Watch", path: ${JSON.stringify(video)}, maxFrames: 1, transcribe: false });`);
  expect(again.frames[0]!.path).toBe(`conversations/${id}/clip-frames-2/frame-01.jpg`);
  expect(again.transcript).toBeNull();
  const song = await upload(id, "song.mp3", new Uint8Array(1_024));
  expect(await turn(id, `return await ox.media.inspectVideo({ purpose: "Watch", path: ${JSON.stringify(song)} });`)).toContain("has no video track");
}, 60_000);

test("The web client dictates and reads aloud through authenticated media routes", async () => {
  expect(await (await api("/api/media")).json()).toMatchObject({ reachable: true, capabilities: [{ id: "transcription", state: "ready" }, { id: "speech" }, { id: "image" }] });
  const dictated = await api("/api/media/transcriptions", { method: "POST", body: new Uint8Array(2_048), headers: { "content-type": "audio/webm;codecs=opus" } });
  expect(await dictated.json()).toEqual({ text: "heard 2048 bytes", language: "Chinese" });
  expect(mediaRequests.findLast(entry => entry.path === "/v1/audio/transcriptions")?.file).toMatchObject({ name: "recording.webm", size: 2_048 });
  const spoken = await api("/api/media/speech", { method: "POST", json: { text: "读出来" } });
  expect(spoken.headers.get("content-type")).toBe("audio/wav");
  expect(Buffer.from(await spoken.arrayBuffer()).subarray(0, 4).toString()).toBe("RIFF");
  expect((await api("/api/media/speech", { method: "POST", json: { text: "x".repeat(2_001) } })).status).toBe(400);
  expect((await fetch(`http://127.0.0.1:${host!.port}/api/media/speech`, { method: "POST", body: JSON.stringify({ text: "hi" }), headers: { "content-type": "application/json" } })).status).toBe(401);
  const models = await (await api("/api/settings/models")).json() as { media: { reachable: boolean; capabilities: unknown[] } };
  expect(models.media).toMatchObject({ reachable: true });
  expect(models.media.capabilities).toHaveLength(3);
}, 30_000);

test.skipIf(!Bun.which("soffice") || !Bun.which("pdftoppm"))("Office documents are read as text, and PDF and slide pages render as images", async () => {
  const id = await conversation();
  const docx = await upload(id, "plan.docx", await office("plan.txt", "Quarterly plan\nShip the Linux Host to every Spark.", "docx"));
  expect(await turn(id, `return (await ox.fs.read({ purpose: "Read", path: ${JSON.stringify(docx)} })).text;`)).toContain("Ship the Linux Host to every Spark.");
  const xlsx = await upload(id, "budget.xlsx", await office("budget.csv", "item,cost\nGPU,4000\nRAM,800\n", "xlsx"));
  const sheet = await turn(id, `return (await ox.fs.read({ purpose: "Read", path: ${JSON.stringify(xlsx)} })).text;`);
  expect(sheet).toMatch(/--- Sheet .+ ---/);
  expect(sheet).toContain("GPU,4000");

  const rtf = await upload(id, "note.rtf", new TextEncoder().encode("{\\rtf1\\ansi\\deff0 {\\fonttbl {\\f0 Helvetica;}} \\f0 Hello from an RTF note.\\par}"));
  const note = await turn(id, `return (await ox.fs.read({ purpose: "Read", path: ${JSON.stringify(rtf)} })).text;`);
  expect(note).toContain("Hello from an RTF note.");
  expect(note).not.toContain("\\rtf1");
  const scanned = await upload(id, "scan.pdf", pdf(["", ""]));
  expect(await turn(id, `return await ox.fs.read({ purpose: "Read", path: ${JSON.stringify(scanned)} });`)).toContain("Render its pages with ox.media.renderPages");
  const report = await upload(id, "report.pdf", pdf(["First page", "Second page", "Third page"]));
  const rendered = await value<{ pageCount: number; pages: { page: number; path: string }[] }>(id, `return await ox.media.renderPages({ purpose: "Render", path: ${JSON.stringify(report)}, first: 2 });`);
  conforms("ox.media.renderPages", rendered);
  expect(rendered.pageCount).toBe(3);
  expect(rendered.pages).toEqual([{ page: 2, path: `conversations/${id}/report-pages/page-2.png` }, { page: 3, path: `conversations/${id}/report-pages/page-3.png` }]);
  expect((await readFile(profilePath(rendered.pages[0]!.path))).subarray(1, 4).toString()).toBe("PNG");
  expect(await turn(id, `return await ox.media.renderPages({ purpose: "Render", path: ${JSON.stringify(report)}, first: 9 });`)).toContain("the document has 3 pages");
  const slides = await value<{ pageCount: number; pages: { path: string }[] }>(id, `return await ox.media.renderPages({ purpose: "Render", path: ${JSON.stringify(docx)} });`);
  expect(slides.pageCount).toBeGreaterThanOrEqual(1);
  expect(slides.pages[0]!.path).toBe(`conversations/${id}/plan-pages/page-1.png`);
}, 120_000);

test("Request bodies stop at each route's limit, even without a length", async () => {
  const endless = () => {
    const sent = { bytes: 0 };
    const body = new ReadableStream<Uint8Array>({ pull(controller) {
      if (sent.bytes >= 300 * 1024 * 1024) { controller.close(); return; }
      sent.bytes += 262_144;
      controller.enqueue(new Uint8Array(262_144));
    } });
    return { body, sent };
  };
  const pair = endless();
  const paired = await fetch(`http://127.0.0.1:${host!.port}/api/pair`, { method: "POST", body: pair.body, headers: { "content-type": "application/json" } });
  expect(paired.status).toBe(413);
  expect(pair.sent.bytes).toBeLessThan(48 * 1024 * 1024);
  const recording = endless();
  expect((await api("/api/media/transcriptions", { method: "POST", body: recording.body, headers: { "content-type": "audio/webm" } })).status).toBe(413);
  expect(recording.sent.bytes).toBeLessThan(72 * 1024 * 1024);
  const skill = endless();
  expect((await api("/api/skills/import", { method: "POST", body: skill.body })).status).toBe(413);
  expect(skill.sent.bytes).toBeLessThan(48 * 1024 * 1024);
}, 60_000);

test("Media functions fail clearly when the media service is not running, and RTF stays readable when LibreOffice cannot convert it", async () => {
  await stopHost();
  const tools = await mkdtemp(join(tmpdir(), "ox-no-office-"));
  await writeFile(join(tools, "soffice"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  host = await startHost("http://127.0.0.1:9", { PATH: `${tools}:${Bun.env.PATH ?? "/usr/bin:/bin"}` });
  const id = await conversation();
  const rtf = await upload(id, "plain.rtf", new TextEncoder().encode("{\\rtf1\\ansi Hello from a plain RTF note.\\par}"));
  const note = await turn(id, `return (await ox.fs.read({ purpose: "Read", path: ${JSON.stringify(rtf)} })).text;`);
  expect(note).toContain("Hello from a plain RTF note.");
  expect(note).toContain("\\rtf1");
  await rm(tools, { recursive: true, force: true });
  expect(await turn(id, `return await ox.media.speak({ purpose: "Read", text: "hi" });`)).toContain("the media service isn't running on this Host");
  expect(await (await api("/api/media")).json()).toEqual({ reachable: false, memAvailableBytes: null, capabilities: [] });
  expect((await api("/api/media/speech", { method: "POST", json: { text: "hi" } })).status).toBe(503);
}, 30_000);

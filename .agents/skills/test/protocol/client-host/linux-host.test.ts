import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT } from "../../../../lib.ts";

const chunk = (delta: unknown, finish: string | null = null) => `data: ${JSON.stringify({ id: "chatcmpl-fixture", object: "chat.completion.chunk", created: 0, model: "fixture",
  choices: [{ index: 0, delta, finish_reason: finish }], ...(finish ? { usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } } : {}) })}\n\n`;
const text = (value: string) => [chunk({ role: "assistant", content: value }), chunk({}, "stop")];
const call = (purpose: string, source: string) => [chunk({ role: "assistant", tool_calls: [{ index: 0, id: `call_${crypto.randomUUID()}`, type: "function",
  function: { name: "execute", arguments: JSON.stringify({ purpose, source }) } }] }), chunk({}, "tool_calls")];

const limits: number[] = [];
const penalties: { model: string; presence: unknown }[] = [];
const sent: string[][] = [];
const unreadable: string[] = [];

function scriptedModel() {
  return Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (request.method === "GET" && new URL(request.url).pathname.endsWith("/models")) return Response.json({ object: "list", data: [{ id: "fixture", object: "model", max_model_len: 40_960 }] });
    if (request.method === "GET") return new Response("Not found", { status: 404 });
    const body = await request.json() as { model: string; messages: { role: string; content: unknown }[]; max_tokens?: number; max_completion_tokens?: number; presence_penalty?: unknown };
    limits.push(body.max_completion_tokens ?? body.max_tokens ?? 0);
    penalties.push({ model: body.model, presence: body.presence_penalty });
    sent.push(body.messages.filter(message => message.role === "user")
      .map(message => typeof message.content === "string" ? message.content : (message.content as { text?: string }[]).map(part => part.text ?? "").join("")));
    const last = body.messages.at(-1)!;
    const asked = JSON.stringify([...body.messages].reverse().find(message => message.role === "user")?.content ?? "");
    if (asked.includes("stream") && last.role !== "tool") {
      const encoder = new TextEncoder();
      return new Response(new ReadableStream({ async start(controller) {
        controller.enqueue(encoder.encode(chunk({ role: "assistant", reasoning_content: "Planning the reply. " })));
        for (let index = 0; index < 24; index++) { controller.enqueue(encoder.encode(chunk({ content: `Part ${index} of the streamed reply. ` }))); await Bun.sleep(25); }
        controller.enqueue(encoder.encode(chunk({}, "stop") + "data: [DONE]\n\n"));
        controller.close();
      } }), { headers: { "content-type": "text/event-stream" } });
    }
    if (asked.includes("unreadable")) {
      unreadable.push(last.role);
      const calls = Array.from({ length: asked.includes("batch") ? 6 : 1 }, (_, index) => ({ index, id: `call_${crypto.randomUUID()}`, type: "function",
        function: { name: "execute", arguments: '{"purpose": "Read", "source": "return "x";' } }));
      const events = !asked.includes("always") && last.role === "tool" ? text("Recovered after unreadable calls.")
        : [chunk({ role: "assistant", tool_calls: calls }), chunk({}, "tool_calls")];
      return new Response(events.join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
    }
    const events = last.role === "tool"
      ? text(asked.includes("choose") ? `You chose ${JSON.stringify(last.content).includes("Markdown") ? "Markdown" : "something else"}.`
        : asked.includes("long") ? `Tool output was ${JSON.stringify(last.content).length} characters.` : "Saved the note.")
      : asked.includes("choose") ? call("Ask for a format", `return await ox.user.choose({ purpose: "Choose a format", body: "Which format?", options: ["Markdown", "PDF"] });`)
      : asked.includes("long") ? call("Print a long line", `return "x".repeat(500000);`)
      : asked.includes("write") ? call("Write a note", `const file = await ox.fs.write({ purpose: "Save note", path: "note.md", content: "written by the scripted model" }); console.log(file.path);`)
      : asked.includes("ramble") ? [chunk({ role: "assistant", reasoning_content: "Still weighing every option" }), chunk({}, "length")]
      : text("Hello from the scripted model.");
    return new Response(events.join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  } });
}

let data = "";
let model: ReturnType<typeof scriptedModel>;
let host: { process: ReturnType<typeof Bun.spawn>; port: number } | undefined;
let token = "";

async function startHost() {
  const child = Bun.spawn([process.execPath, `${ROOT}/apps/linux/src/main.ts`, "serve", "--data", data, "--port", "0", "--name", "fixture"],
    { stdout: "pipe", stderr: "pipe", env: { ...Bun.env, OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "", TZ: "Asia/Shanghai" } });
  const reader = child.stdout.getReader();
  let output = "";
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    output += new TextDecoder().decode(value);
    const match = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(output);
    if (match) { reader.releaseLock(); return { process: child, port: Number(match[1]) }; }
  }
  child.kill();
  throw new Error(`Host did not start: ${output}${await new Response(child.stderr).text()}`);
}

async function stopHost() {
  if (!host) return;
  host.process.kill("SIGTERM");
  await host.process.exited;
  host = undefined;
}

async function hostCommand(...args: string[]) {
  const child = Bun.spawn([process.execPath, `${ROOT}/apps/linux/src/main.ts`, ...args, "--data", data], { stdout: "pipe", stderr: "pipe",
    env: { ...Bun.env, XDG_RUNTIME_DIR: data, OPENOX_PUBLIC_URL: "" } });
  const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  expect(code).toBe(0);
  return stdout;
}

async function cli(withToken: boolean, ...args: string[]) {
  const child = Bun.spawn([process.execPath, `${ROOT}/apps/cli/src/ox.ts`, "--host", `ws://127.0.0.1:${host!.port}`, ...args],
    { stdout: "pipe", stderr: "pipe", env: { ...Bun.env, OX_REPOSITORY: "", OX_HOST_TOKEN: withToken ? token : "" } });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, stdout, stderr };
}

function api(path: string, init: RequestInit & { auth?: string | null } = {}) {
  const { auth = `Bearer ${token}`, ...rest } = init;
  return fetch(`http://127.0.0.1:${host!.port}${path}`, { ...rest, headers: { ...(auth ? { authorization: auth } : {}), ...rest.headers } });
}

beforeAll(async () => {
  data = await mkdtemp(join(tmpdir(), "openox-linux-host-"));
  model = scriptedModel();
  host = await startHost();
  token = /OX_HOST_TOKEN=(\S+)/.exec(await hostCommand("token", "--name", "protocol-test"))![1]!;
  const configured = await api("/api/settings/providers/custom", { method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Scripted", baseUrl: `http://127.0.0.1:${model.port}/v1`, models: ["fixture"] }) });
  expect(configured.status).toBe(200);
}, 30_000);

afterAll(async () => {
  await stopHost();
  model?.stop(true);
  if (data) await rm(data, { recursive: true, force: true });
});

test("Linux Host requires a device token and runs a real execute turn through the CLI", async () => {
  const refused = await cli(false, "host", "describe");
  expect(refused.code).toBe(1);
  expect(refused.stderr).toContain("Authentication required");
  const described = await cli(true, "host", "describe", "--json");
  expect(described.code).toBe(0);
  expect(JSON.parse(described.stdout)).toMatchObject({ protocols: { rpc: [4] }, implementation: { name: "OpenOx Linux Host" } });
  const created = await cli(true, "conversation", "new", "--json");
  expect(created.code).toBe(0);
  const { conversationId, model: label } = JSON.parse(created.stdout);
  expect(label).toBe("custom:fixture");
  const greeted = await cli(true, "--conversation", conversationId, "conversation", "send", "hello", "--json");
  expect(JSON.parse(greeted.stdout)).toMatchObject({ conversationId, outcome: "completed", text: "Hello from the scripted model." });
  const wrote = await cli(true, "--conversation", conversationId, "conversation", "send", "please write a note", "--json");
  expect(JSON.parse(wrote.stdout)).toMatchObject({ outcome: "completed", text: "Saved the note." });
  const profile = JSON.parse(await readFile(join(data, "host.json"), "utf8")).profile.id;
  expect(await readFile(join(data, "profiles", profile, "files", "conversations", conversationId, "note.md"), "utf8")).toBe("written by the scripted model");
  const inspected = JSON.parse((await cli(true, "--conversation", conversationId, "conversation", "inspect", "--json")).stdout);
  expect(inspected).toMatchObject({ id: conversationId, isBusy: false });
  expect(inspected.blocks.map((block: { kind: { type: string } }) => block.kind.type)).toEqual(["userText", "agentContent", "userText", "thinking", "agentContent"]);
  const listed = JSON.parse((await cli(true, "conversation", "list", "--json")).stdout);
  expect(listed.map((row: { id: string }) => row.id)).toContain(conversationId);
  const long = JSON.parse((await cli(true, "--conversation", conversationId, "conversation", "send", "print a long line", "--json")).stdout);
  const characters = Number(/Tool output was (\d+) characters/.exec(long.text)?.[1]);
  expect(characters).toBeGreaterThan(50_000);
  expect(characters).toBeLessThan(52_000);
  const reserved = await api(`/api/files/content?path=conversations/${conversationId}/turns.jsonl`, { method: "PUT", body: "{}" });
  expect(reserved.status).toBe(400);
  const attached = await (await api(`/api/conversations/${conversationId}/attachments?name=turns.jsonl`, { method: "POST", body: "{}" })).json() as { name: string };
  expect(attached.name).toBe("turns (2).jsonl");
}, 60_000);

test("The model sees when and in which time zone each message was sent, as in the native app, while the transcript keeps the user's text", async () => {
  const zone = "Asia/Shanghai";
  const wall = (time: number) => `${new Date(time).toLocaleDateString("en-US", { timeZone: zone, weekday: "short" })} ${new Date(time).toLocaleString("sv-SE", { timeZone: zone }).slice(0, 16)}`;
  const stamp = /^\[(\w{3} \d{4}-\d{2}-\d{2} \d{2}:\d{2}) (\S+)\]\n\n/;
  const { conversationId } = JSON.parse((await cli(true, "conversation", "new", "--json")).stdout);
  const started = Date.now();
  expect((await cli(true, "--conversation", conversationId, "conversation", "send", "what day is it", "--json")).code).toBe(0);
  const first = sent.at(-1)!.at(-1)!;
  expect(stamp.exec(first)?.[2]).toBe(zone);
  expect([wall(started), wall(Date.now())]).toContain(stamp.exec(first)![1]);
  expect(first.replace(stamp, "")).toBe("what day is it");
  expect((await cli(true, "--conversation", conversationId, "conversation", "send", "and the time", "--json")).code).toBe(0);
  const [earlier, latest] = sent.at(-1)!.slice(-2);
  expect(earlier).toBe(first);
  expect(latest!.replace(stamp, "")).toBe("and the time");
  const inspected = JSON.parse((await cli(true, "--conversation", conversationId, "conversation", "inspect", "--json")).stdout);
  expect(inspected.blocks.filter((block: { kind: { type: string } }) => block.kind.type === "userText").map((block: { kind: { text: string } }) => block.kind.text)).toEqual(["what day is it", "and the time"]);
}, 60_000);

test("Unreadable tool calls go back to the model for a retry, and five replies in a row of them stop the run with an explanation", async () => {
  for (const message of ["unreadable once", "unreadable batch"]) {
    const conversation = JSON.parse((await cli(true, "conversation", "new", "--json")).stdout).conversationId;
    const retried = await cli(true, "--conversation", conversation, "conversation", "send", message, "--json");
    expect(JSON.parse(retried.stdout)).toMatchObject({ outcome: "completed", text: "Recovered after unreadable calls." });
  }
  const stuck = JSON.parse((await cli(true, "conversation", "new", "--json")).stdout).conversationId;
  const before = unreadable.length;
  const stopped = await cli(true, "--conversation", stuck, "conversation", "send", "unreadable always", "--json");
  const message = "The model sent unreadable tool calls 5 times in a row, so the run stopped. Try again, or choose another model.";
  expect(stopped.code).toBe(1);
  expect(JSON.parse(stopped.stdout)).toMatchObject({ outcome: "failed", error: message });
  expect(unreadable.length - before).toBeGreaterThanOrEqual(5);
  expect(unreadable.length - before).toBeLessThanOrEqual(6);
  expect(await (await api(`/api/conversations/${stuck}`)).json()).toMatchObject({ busy: false, error: message });
  const next = await cli(true, "--conversation", stuck, "conversation", "send", "hello", "--json");
  expect(JSON.parse(next.stdout)).toMatchObject({ outcome: "completed", text: "Hello from the scripted model." });
}, 60_000);

test("A choice reports needsAttention and the Host accepts the CLI response", async () => {
  const created = JSON.parse((await cli(true, "conversation", "new", "--json")).stdout);
  const sent = await cli(true, "--conversation", created.conversationId, "conversation", "send", "please choose a format", "--json");
  expect(sent.code).toBe(1);
  expect(JSON.parse(sent.stdout)).toMatchObject({ outcome: "needsAttention" });
  const pending = JSON.parse((await cli(true, "--conversation", created.conversationId, "conversation", "inspect", "--pending", "--json")).stdout);
  expect(pending.pendingPrompt).toMatchObject({ prompt: "Which format?", options: ["Markdown", "PDF"] });
  const busy = await cli(true, "--conversation", created.conversationId, "conversation", "send", "another message", "--no-wait", "--json");
  expect(busy.code).toBe(1);
  expect(busy.stderr).toContain("still working");
  expect((await cli(true, "--conversation", created.conversationId, "conversation", "respond", "Markdown", "--prompt", pending.pendingPrompt.id)).code).toBe(0);
  let snapshot;
  for (let attempt = 0; attempt < 50; attempt++) {
    snapshot = JSON.parse((await cli(true, "--conversation", created.conversationId, "conversation", "inspect", "--json")).stdout);
    if (!snapshot.isBusy) break;
    await Bun.sleep(100);
  }
  expect(snapshot.isBusy).toBe(false);
  expect(JSON.stringify(snapshot.messages.at(-1))).toContain("You chose Markdown.");
  const stale = await cli(true, "--conversation", created.conversationId, "conversation", "respond", "PDF", "--prompt", pending.pendingPrompt.id);
  expect(stale.code).toBe(1);
}, 60_000);

test("Pairing codes, origin checks and revocation guard the browser API", async () => {
  expect((await api("/api/conversations", { auth: null })).status).toBe(401);
  const code = /Pairing code: (\S+)/.exec(await hostCommand("pair"))![1]!;
  const pair = (value: string) => api("/api/pair", { auth: null, method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: value, name: "Test phone" }) });
  expect((await pair("AAAA-AAAA")).status).toBe(403);
  const paired = await pair(code);
  expect(paired.status).toBe(201);
  const cookie = paired.headers.get("set-cookie")!.split(";")[0]!;
  expect(paired.headers.get("set-cookie")).toContain("HttpOnly");
  expect((await pair(code)).status).toBe(403);
  const session = await (await api("/api/session", { auth: null, headers: { cookie } })).json() as { paired: boolean; device: { id: string } };
  expect(session.paired).toBe(true);
  const crossSite = await api("/api/conversations", { auth: null, method: "POST", headers: { cookie, origin: "https://attacker.example", "content-type": "application/json" }, body: "{}" });
  expect(crossSite.status).toBe(403);
  expect((await api(`/api/devices/${session.device.id}`, { method: "DELETE" })).status).toBe(200);
  expect((await api("/api/conversations", { auth: null, headers: { cookie } })).status).toBe(401);
  const printed = await hostCommand("pair", "--url", "https://openox.example.ts.net/ignored/path");
  const linked = /Pairing code: (\S+)/.exec(printed)![1]!;
  expect(printed).toContain(`https://openox.example.ts.net/#/pair/${linked}`);
  expect(printed).toContain("\u001b[");
  expect((await pair(linked)).status).toBe(201);
  expect(await hostCommand("pair")).toContain("pass --url https://<address>");
}, 30_000);

test("Explicit Host TLS keeps pairing credentials encrypted and requires both certificate files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openox-host-tls-"));
  const cert = join(directory, "host.crt"), key = join(directory, "host.key");
  const command = (...args: string[]) => Bun.spawn([process.execPath, `${ROOT}/apps/linux/src/main.ts`, ...args, "--data", directory],
    { stdout: "pipe", stderr: "pipe" });
  let child: ReturnType<typeof command> | undefined;
  let startup: ReturnType<typeof setTimeout> | undefined;
  try {
    const incomplete = command("serve", "--tls-cert", cert);
    expect(await incomplete.exited).toBe(2);
    expect(await new Response(incomplete.stderr).text()).toContain("both --tls-cert and --tls-key");
    expect(existsSync(join(directory, "host.json"))).toBe(false);
    const wrongCommand = command("pair", "--tls-cert", cert, "--tls-key", key);
    expect(await wrongCommand.exited).toBe(2);
    expect(await new Response(wrongCommand.stderr).text()).toContain("only to serve");
    const certificate = Bun.spawn(["openssl", "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1",
      "-keyout", key, "-out", cert, "-nodes", "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"],
    { stdout: "pipe", stderr: "pipe" });
    const certificateError = await new Response(certificate.stderr).text();
    if (await certificate.exited) throw new Error(`Test certificate generation failed: ${certificateError}`);
    child = command("serve", "--port", "0", "--tls-cert", cert, "--tls-key", key);
    startup = setTimeout(() => child?.kill("SIGTERM"), 20_000);
    const reader = child.stdout.getReader();
    let output = "", port = "";
    while (!port) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`TLS Host did not start: ${output}${await new Response(child.stderr).text()}`);
      output += new TextDecoder().decode(value);
      port = /listening on https:\/\/127\.0\.0\.1:(\d+)/.exec(output)?.[1] ?? "";
    }
    clearTimeout(startup);
    reader.releaseLock();
    const base = `https://127.0.0.1:${port}`;
    await expect(fetch(`${base}/api/health`)).rejects.toThrow();
    const tls = { ca: await readFile(cert, "utf8") };
    expect((await fetch(`${base}/api/settings`, { tls })).status).toBe(401);
    const pairing = command("pair", "--url", base);
    const printed = await new Response(pairing.stdout).text();
    expect(await pairing.exited).toBe(0);
    const code = /Pairing code: (\S+)/.exec(printed)![1]!;
    expect(printed).toContain(`${base}/#/pair/${code}`);
    const paired = await fetch(`${base}/api/pair`, { tls, method: "POST",
      headers: { origin: base, "content-type": "application/json", "x-forwarded-proto": "http" },
      body: JSON.stringify({ code, name: "TLS fixture" }) });
    expect(paired.status).toBe(201);
    const cookie = paired.headers.get("set-cookie")!;
    expect(cookie).toContain("; Secure");
    expect(cookie).toContain("HttpOnly; SameSite=Strict");
    const session = await fetch(`${base}/api/session`, { tls, headers: { cookie: cookie.split(";")[0]! } });
    expect(await session.json()).toMatchObject({ paired: true });
    expect((await fetch(`${base}/api/settings`, { tls, headers: { cookie: "ox_device=invalid" } })).status).toBe(401);
  } finally {
    clearTimeout(startup);
    if (child) { child.kill("SIGTERM"); await child.exited; }
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

test("Host connections are authenticated, validate outside origins and do not change model settings", async () => {
  expect((await api("/api/settings/connections", { auth: null })).status).toBe(401);
  const original = await (await api("/api/settings")).json() as { defaultModel: unknown; machines: unknown };
  const update = (outside: unknown, origin?: string) => api("/api/settings/connections", { method: "PUT",
    headers: { "content-type": "application/json", ...(origin ? { origin } : {}) }, body: JSON.stringify({ outside }) });
  expect(await (await api("/api/settings/connections")).json()).toMatchObject({
    host: { name: "fixture" }, current: `http://127.0.0.1:${host!.port}`, local: null, outside: null,
  });
  for (const outside of [undefined, {}, { provider: "unknown", url: "https://host.example" },
    { provider: "https", url: "http://host.example" }, { provider: "https", url: "https://user:password@host.example" },
    { provider: "https", url: "https://host.example/path" }, { provider: "tailscale", url: "https://host.example/?key=value" },
    { provider: "https", url: "https://host.example/#token" }, { provider: "https", url: "https://host.example:0" }]) expect((await update(outside)).status).toBe(400);
  expect((await update({ provider: "tailscale", url: "https://my-host.example.ts.net" }, "https://foreign.example")).status).toBe(403);
  expect((await update({ provider: "tailscale", url: "https://my-host.example.ts.net/" })).status).toBe(200);
  expect(JSON.parse(await readFile(join(data, "host.json"), "utf8")).connections).toEqual({
    outside: { provider: "tailscale", url: "https://my-host.example.ts.net" },
  });
  expect(await (await api("/api/settings")).json()).toMatchObject(original);
  expect((await update(null)).status).toBe(200);
  expect(await (await api("/api/settings/connections")).json()).toMatchObject({ outside: null, local: null });
});

test("Local-network startup rejects unsafe or unassigned addresses before creating Host data", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openox-lan-refusal-"));
  try {
    for (const address of ["0.0.0.0", "127.0.0.1", "8.8.8.8", "100.64.0.1", "192.0.2.1"]) {
      const child = Bun.spawn([process.execPath, `${ROOT}/apps/linux/src/main.ts`, "serve", "--data", directory, "--port", "0", "--local-network", address],
        { stdout: "pipe", stderr: "pipe" });
      expect(await child.exited).toBe(2);
      expect(await new Response(child.stderr).text()).toContain("assigned private IPv4");
      expect(existsSync(join(directory, "host.json"))).toBe(false);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 30_000);

test("System-trusted LAN invitations use browser pairing while private-CA invitations retain native identity", async () => {
  const { Host } = await import("../../../../../apps/linux/src/host.ts");
  const { startServer } = await import("../../../../../apps/linux/src/server.ts");
  const directory = await mkdtemp(join(tmpdir(), "openox-lan-invitation-"));
  const instance = await Host.open({ data: directory, hostID: "LAN invitation fixture", version: "fixture", quiet: true });
  const server = await startServer(instance, { hostname: "127.0.0.1", port: 0 });
  try {
    const admin = await instance.devices.add("Invitation fixture", "cli");
    const origin = `http://127.0.0.1:${server.port}`, local = "https://owned-lan.example:9879";
    instance.localConnection = { url: local, hostId: instance.settings.profile.id, hostname: "owned-lan.example", discovery: "unavailable" };
    const request = () => fetch(`${origin}/api/devices/pairing`, { method: "POST",
      headers: { authorization: `Bearer ${admin.token}`, origin } });
    const browser = await (await request()).json() as { url: string; appScan: boolean };
    expect(browser.appScan).toBe(false);
    expect(new URL(browser.url).origin).toBe(local);
    expect(new URL(browser.url).search).toBe("");
    expect(new URL(browser.url).hash).not.toContain("ca=");
    instance.localConnection.ca = "a".repeat(64);
    const native = await (await request()).json() as { url: string; appScan: boolean };
    expect(native.appScan).toBe(true);
    expect(new URL(native.url).hash).toContain(`ca=${"a".repeat(64)}`);
  } finally {
    await server.stop(true);
    await instance.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Concurrent connection and Profile saves preserve both changes and failed writes leave memory unchanged", async () => {
  const json = { "content-type": "application/json" };
  const original = await (await api("/api/settings/connections")).json() as { profile: { name: string }; outside: unknown };
  const outside = { provider: "https", url: "https://owned-host.example" };
  const saveOutside = (value: unknown) => api("/api/settings/connections", { method: "PUT", headers: json, body: JSON.stringify({ outside: value }) });
  const saveName = (name: string) => api("/api/settings/profile", { method: "PUT", headers: json, body: JSON.stringify({ name }) });
  const path = join(data, "host.json"), backup = `${path}.saved`;
  let blocked = false;
  try {
    const saved = await Promise.all([saveOutside(outside), saveName("Concurrent fixture")]);
    expect(saved.map(response => response.status)).toEqual([200, 200]);
    expect(await (await api("/api/settings/connections")).json()).toMatchObject({ outside, profile: { name: "Concurrent fixture" } });
    await rename(path, backup);
    blocked = true;
    await mkdir(path);
    const failed = await saveOutside({ provider: "https", url: "https://must-not-save.example" });
    expect(failed.status).toBe(400);
    expect((await failed.json() as { error: string }).error).toContain("rename");
    expect(await (await api("/api/settings/connections")).json()).toMatchObject({ outside, profile: { name: "Concurrent fixture" } });
  } finally {
    if (blocked) { await rm(path, { recursive: true, force: true }); await rename(backup, path); }
    expect((await saveOutside(original.outside)).status).toBe(200);
    expect((await saveName(original.profile.name)).status).toBe(200);
  }
}, 30_000);

test("The web client loads its diagram renderer from the Host, with its license", async () => {
  const page = await (await api("/", { auth: null })).text();
  const scripts = [...page.matchAll(/src="\.?\/([\w.-]+\.js)"/g)].map(match => match[1]!);
  expect(scripts.length).toBeGreaterThan(0);
  const bundles = await Promise.all(scripts.map(async script => await (await api(`/${script}`, { auth: null })).text()));
  const pele = bundles.map(bundle => /["']\.?\/(pele-[\w-]+\.js)["']/.exec(bundle)?.[1]).find(Boolean);
  expect(pele).toBeDefined();
  const served = await api(`/${pele}`, { auth: null });
  expect(served.status).toBe(200);
  expect(served.headers.get("content-type")).toContain("javascript");
  expect(served.headers.get("cache-control")).toContain("immutable");
  const text = await served.text();
  expect(text).toStartWith("/*! Pele ");
  expect(text.slice(0, text.indexOf("*/"))).toContain("MIT License");
});

test("The served context sets the output limit, and a reply cut off by that limit is reported", async () => {
  const json = { "content-type": "application/json" };
  const { id } = await (await api("/api/conversations", { method: "POST", headers: json, body: "{}" })).json() as { id: number };
  expect((await api(`/api/conversations/${id}/messages`, { method: "POST", headers: json, body: JSON.stringify({ text: "please ramble" }) })).status).toBe(202);
  let view: { busy: boolean; error: string | null } = { busy: true, error: null };
  for (let attempt = 0; attempt < 100 && view.busy; attempt++) {
    await Bun.sleep(100);
    view = await (await api(`/api/conversations/${id}`)).json() as typeof view;
  }
  expect(view.error).toBe("The model reached its output limit before it wrote an answer. Ask again, or ask for a shorter answer.");
  expect(limits.at(-1)).toBe(10_240);
}, 30_000);

test("Qwen 3.5 and later get the presence penalty their model card asks for, and other models are left alone", async () => {
  const json = { "content-type": "application/json" };
  const turn = async () => {
    const { id } = await (await api("/api/conversations", { method: "POST", headers: json, body: "{}" })).json() as { id: number };
    expect((await api(`/api/conversations/${id}/messages`, { method: "POST", headers: json, body: JSON.stringify({ text: "sampling check" }) })).status).toBe(202);
    for (let attempt = 0; attempt < 100; attempt++) {
      await Bun.sleep(100);
      if (!(await (await api(`/api/conversations/${id}`)).json() as { busy: boolean }).busy) return penalties.at(-1)!;
    }
    throw new Error("Timed out waiting for the turn");
  };
  expect((await api("/api/settings/providers/custom", { method: "PUT", headers: json,
    body: JSON.stringify({ name: "Scripted", baseUrl: `http://127.0.0.1:${model.port}/v1`, models: ["fixture", "Qwen3.6-35B"] }) })).status).toBe(200);
  expect((await api("/api/settings/default-model", { method: "PUT", headers: json, body: JSON.stringify({ provider: "custom", modelId: "Qwen3.6-35B" }) })).status).toBe(200);
  expect(await turn()).toEqual({ model: "Qwen3.6-35B", presence: 1.5 });
  expect((await api("/api/settings/default-model", { method: "PUT", headers: json, body: JSON.stringify({ provider: "custom", modelId: "fixture" }) })).status).toBe(200);
  expect(await turn()).toEqual({ model: "fixture", presence: undefined });
}, 30_000);

test("Several local machines can be paired, chosen and removed, and an unreachable address fails clearly", async () => {
  const json = { "content-type": "application/json" };
  const received: string[] = [];
  const keys: { server: string; key: string | null }[] = [];
  const lab = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    keys.push({ server: "lab", key: request.headers.get("authorization") });
    return Response.json({ object: "list", data: [{ id: "Qwen3.6-35B", object: "model", root: "/models/Qwen3.6-35B-A3B-NVFP4", max_model_len: 65_536 }] });
  } });
  const studio = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    keys.push({ server: "studio", key: request.headers.get("authorization") });
    if (request.method === "GET" && new URL(request.url).pathname === "/v1/models") return Response.json({ object: "list", data: [
      { id: "studio-alias", object: "model", root: "/models/Qwen3.6-35B-A3B-NVFP4", max_model_len: 65_536 },
      { id: "Qwen3.6-35B", object: "model", root: "/models/Qwen3.6-35B-A3B-NVFP4", max_model_len: 65_536 }] });
    received.push((await request.json() as { model: string }).model);
    return new Response(text("Hello from the studio machine.").join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  } });
  try {
    const unreachable = await api("/api/settings/machines", { method: "POST", headers: json, body: JSON.stringify({ address: "127.0.0.1:9" }) });
    expect(unreachable.status).toBe(400);
    expect((await unreachable.json() as { error: string }).error).toBe("Couldn't connect to 127.0.0.1:9. Check the address and that its model server is running.");
    expect((await api("/api/settings/providers/custom", { method: "DELETE" })).status).toBe(200);
    const paired = await api("/api/settings/machines", { method: "POST", headers: json, body: JSON.stringify({ address: `127.0.0.1:${studio.port}`, name: "Studio", key: "studio-key" }) });
    expect(paired.status).toBe(201);
    expect(keys.filter(entry => entry.server === "studio").every(entry => entry.key === "Bearer studio-key")).toBe(true);
    expect((await api("/api/settings/providers/custom", { method: "PUT", headers: json,
      body: JSON.stringify({ name: "Scripted", baseUrl: `http://127.0.0.1:${model.port}/v1`, models: ["fixture"] }) })).status).toBe(200);
    const settings = await paired.json() as { paired: { id: string }; machines: { id: string; baseUrl: string; models: string[] }[];
      providers: { id: string; custom: boolean; models: { id: string; contextWindow: number }[] }[] };
    const id = settings.paired.id;
    expect(id).toStartWith("machine-");
    expect(settings.paired).toMatchObject({ name: "Studio", models: ["Qwen3.6-35B"] });
    const current = await (await api("/api/settings")).json() as typeof settings;
    expect(current.machines.map(machine => machine.id)).toEqual(["custom", id]);
    expect(current.machines[1]).toMatchObject({ baseUrl: `http://127.0.0.1:${studio.port}/v1`, models: ["Qwen3.6-35B"] });
    expect(current.providers.find(provider => provider.id === id)).toMatchObject({ custom: true, models: [{ id: "Qwen3.6-35B", contextWindow: 65_536 }] });
    expect((await api("/api/settings/machines", { method: "POST", headers: json, body: JSON.stringify({ address: `http://127.0.0.1:${studio.port}/v1` }) })).status).toBe(400);
    await stopHost();
    host = await startHost();
    expect(((await (await api("/api/settings")).json()) as { machines: { id: string }[] }).machines.map(machine => machine.id)).toEqual(["custom", id]);
    const served = await (await api("/api/settings/models")).json() as { machines: { id: string; error: string | null; served: unknown[] }[] };
    expect(served.machines.map(machine => [machine.id, machine.error])).toEqual([["custom", null], [id, null]]);
    expect(served.machines[1]!.served).toEqual([{ weights: "Qwen3.6-35B-A3B-NVFP4", ids: ["studio-alias", "Qwen3.6-35B"], added: ["Qwen3.6-35B"], contextLength: 65_536 }]);
    expect((await api("/api/settings/default-model", { method: "PUT", headers: json, body: JSON.stringify({ provider: id, modelId: "Qwen3.6-35B" }) })).status).toBe(200);
    const { id: conversation } = await (await api("/api/conversations", { method: "POST", headers: json, body: "{}" })).json() as { id: number };
    expect((await api(`/api/conversations/${conversation}/messages`, { method: "POST", headers: json, body: JSON.stringify({ text: "machine check" }) })).status).toBe(202);
    for (let attempt = 0; attempt < 100 && !(received.length && !(await (await api(`/api/conversations/${conversation}`)).json() as { busy: boolean }).busy); attempt++) await Bun.sleep(100);
    expect(received).toEqual(["Qwen3.6-35B"]);
    expect(((await (await api(`/api/settings/machines/${id}`, { method: "PUT", headers: json, body: JSON.stringify({ name: "Studio Mac" }) })).json()) as { machines: { name: string }[] }).machines[1]!.name).toBe("Studio Mac");
    expect((await api(`/api/settings/machines/${id}`, { method: "PUT", headers: json, body: JSON.stringify({ address: `127.0.0.1:${lab.port}` }) })).status).toBe(200);
    expect(keys.filter(entry => entry.server === "lab").map(entry => entry.key)).toEqual([null]);
    const removed = await (await api(`/api/settings/machines/${id}`, { method: "DELETE" })).json() as { machines: { id: string }[]; defaultModel: { provider: string } };
    expect(removed.machines.map(machine => machine.id)).toEqual(["custom"]);
    expect(removed.defaultModel.provider).toBe("custom");
    expect((await api(`/api/settings/machines/${id}`, { method: "DELETE" })).status).toBe(404);
    const legacy = `http://127.0.0.1:${model.port}`;
    expect((await api("/api/settings/providers/custom", { method: "PUT", headers: json, body: JSON.stringify({ name: "Proxy", baseUrl: legacy, models: ["fixture"], key: "legacy-key" }) })).status).toBe(200);
    const renamed = await (await api("/api/settings/machines/custom", { method: "PUT", headers: json, body: JSON.stringify({ name: "Renamed proxy", address: legacy }) })).json() as { machines: { baseUrl: string; name: string; hasKey: boolean }[] };
    expect(renamed.machines[0]).toMatchObject({ baseUrl: legacy, name: "Renamed proxy", hasKey: true });
    const moved = await (await api("/api/settings/providers/custom", { method: "PUT", headers: json,
      body: JSON.stringify({ name: "Scripted", baseUrl: `${legacy}/v1`, models: ["fixture"] }) })).json() as { machines: { baseUrl: string; hasKey: boolean }[] };
    expect(moved.machines[0]).toMatchObject({ baseUrl: `${legacy}/v1`, hasKey: false });
  } finally { studio.stop(true); lab.stop(true); }
}, 30_000);

test("Replies stream as deltas that rebuild the committed text, and keep their block when committed", async () => {
  const json = { "content-type": "application/json" };
  const received: { event: string; data: { id?: number; ref?: string; kind?: string; offset?: number; delta?: string; final?: boolean } }[] = [];
  const stream = await api("/api/events");
  const reader = stream.body!.getReader();
  void (async () => {
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
      if (done) return;
      buffer += new TextDecoder().decode(value);
      for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
        const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        const event = /^event: (.+)$/m.exec(frame)?.[1], data = /^data: (.+)$/m.exec(frame)?.[1];
        if (event && data) received.push({ event, data: JSON.parse(data) });
      }
    }
  })();
  const { id } = await (await api("/api/conversations", { method: "POST", headers: json, body: "{}" })).json() as { id: number };
  expect((await api(`/api/conversations/${id}/messages`, { method: "POST", headers: json, body: JSON.stringify({ text: "please stream a reply" }) })).status).toBe(202);
  type Item = { text?: string; ref?: string };
  type View = { busy: boolean; blocks: { id: string; createdAt: number; kind: { type: string; items?: Item[]; trace?: { completedAt?: number } } }[] };
  const textBlock = (view: View) => view.blocks.find(block => block.kind.type === "agentContent" && block.kind.items?.some(item => item.ref));
  let live: string | undefined, streamingThought: View["blocks"][number] | undefined, view: View = { busy: true, blocks: [] };
  for (let attempt = 0; attempt < 200 && view.busy; attempt++) {
    view = await (await api(`/api/conversations/${id}`)).json() as View;
    if (view.busy && textBlock(view)) { live ??= textBlock(view)!.id; streamingThought = view.blocks.find(block => block.kind.type === "thinking"); }
    await Bun.sleep(20);
  }
  const final = textBlock(view)!;
  const item = final.kind.items!.find(entry => entry.ref)!;
  const deltas = () => received.filter(entry => entry.event === "stream" && entry.data.id === id && entry.data.ref === item.ref);
  for (let attempt = 0; attempt < 100 && !deltas().at(-1)?.data.final; attempt++) await Bun.sleep(20);
  await reader.cancel();
  let rebuilt = "";
  for (const { data } of deltas()) {
    expect(data.offset).toBeLessThanOrEqual(rebuilt.length);
    rebuilt += data.delta!.slice(rebuilt.length - data.offset!);
  }
  expect(live).toBe(final.id);
  expect(deltas().length).toBeGreaterThan(5);
  expect(deltas().filter(entry => entry.data.final).length).toBe(1);
  expect(rebuilt).toBe(item.text!);
  expect(item.text).toContain("Part 23 of the streamed reply.");
  expect(received.some(entry => entry.event === "stream" && entry.data.id === id && entry.data.kind === "reasoning")).toBe(true);
  expect(received.filter(entry => entry.event === "conversation" && entry.data.id === id).length).toBeLessThan(deltas().length);
  const thought = view.blocks.find(block => block.kind.type === "thinking")!;
  expect(thought.kind.trace!.completedAt! - thought.createdAt).toBeGreaterThanOrEqual(0.55);
  expect(thought.kind.trace!.completedAt! - thought.createdAt).toBeLessThan(30);
  expect(streamingThought!.createdAt).toBe(thought.createdAt);
  expect(streamingThought!.kind.trace!.completedAt! - streamingThought!.createdAt).toBeGreaterThan(0.3);
}, 30_000);

test("Branch, Regenerate and Edit fork a conversation, and temporary conversations stay out of the list", async () => {
  type View = { summary: { id: number; title: string; busy: boolean; temporary: boolean }; busy: boolean; blocks: { kind: { type: string; text?: string; files?: string[]; entry?: number } }[] };
  const json = (path: string, method: string, body?: unknown) => api(path, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const view = async (id: number) => await (await api(`/api/conversations/${id}`)).json() as View;
  const settle = async (id: number) => {
    for (let attempt = 0; attempt < 200; attempt++) {
      const current = await view(id);
      if (!current.busy && current.blocks.at(-1)?.kind.type === "agentContent") return current;
      await Bun.sleep(50);
    }
    throw new Error(`Conversation ${id} did not finish`);
  };
  const say = async (id: number, text: string, attachments: string[] = []) => {
    expect((await json(`/api/conversations/${id}/messages`, "POST", { text, attachments })).status).toBe(202);
    return settle(id);
  };
  const users = (current: View) => current.blocks.filter(block => block.kind.type === "userText").map(block => block.kind);
  const listed = async () => ((await (await api("/api/conversations")).json()) as { items: { id: number }[] }).items.map(item => item.id);

  const source = ((await (await json("/api/conversations", "POST", {})).json()) as { id: number }).id;
  const stored = await (await api(`/api/conversations/${source}/attachments?name=notes.txt`, { method: "POST", body: "the notes" })).json() as { path: string };
  await say(source, "first question", [stored.path]);
  const before = await say(source, "second question");
  const [first, second] = users(before);
  expect(first).toMatchObject({ text: "first question", files: [stored.path] });
  expect(typeof first!.entry).toBe("number");
  expect(second!.entry).toBeGreaterThan(first!.entry!);
  expect((await json(`/api/services/en.wikipedia.org/attach`, "POST", { conversation: source })).status).toBe(200);

  const branched = await json(`/api/conversations/${source}/branch`, "POST", { entry: first!.entry });
  expect(branched.status).toBe(201);
  const branch = ((await branched.json()) as { id: number }).id;
  const copy = await view(branch);
  expect(users(copy).map(kind => kind.text)).toEqual(["first question"]);
  expect(copy.blocks.at(-1)!.kind.type).toBe("agentContent");
  expect(copy.summary.title).toBe(before.summary.title);
  expect(await listed()).toEqual(expect.arrayContaining([source, branch]));
  const attached = ((await (await api(`/api/services?conversation=${branch}`)).json()) as { services: { domain: string; attached?: boolean }[] }).services;
  expect(attached.find(service => service.domain === "en.wikipedia.org")?.attached).toBe(true);

  const asked = sent.length;
  const rerun = await json(`/api/conversations/${source}/rerun`, "POST", { entry: second!.entry });
  expect(rerun.status).toBe(202);
  const regenerated = ((await rerun.json()) as { id: number }).id;
  const again = await settle(regenerated);
  expect(users(again).map(kind => kind.text)).toEqual(["first question", "second question"]);
  expect(sent.length).toBe(asked + 1);
  expect(sent.at(-1)!.at(-1)).toContain("second question");
  expect(await listed()).not.toContain(source);
  expect(await listed()).toContain(regenerated);

  const edited = await json(`/api/conversations/${regenerated}/rerun`, "POST", { entry: users(again)[0]!.entry, text: "edited question" });
  expect(edited.status).toBe(202);
  const editedID = ((await edited.json()) as { id: number }).id;
  const rewritten = await settle(editedID);
  expect(users(rewritten)).toEqual([expect.objectContaining({ text: "edited question", files: [stored.path] })]);
  expect(sent.at(-1)!.at(-1)).toContain("edited question");
  expect(sent.at(-1)!.at(-1)).toContain(`[Attachment: ${stored.path}]`);
  expect(rewritten.summary.title).toBe(before.summary.title);
  expect(await listed()).not.toContain(regenerated);
  const editedServices = ((await (await api(`/api/services?conversation=${editedID}`)).json()) as { services: { domain: string; attached?: boolean }[] }).services;
  expect(editedServices.find(service => service.domain === "en.wikipedia.org")?.attached).toBe(true);

  expect((await json(`/api/conversations/${editedID}/rerun`, "POST", { entry: "first" })).status).toBe(400);
  expect((await json(`/api/conversations/${editedID}/branch`, "POST", { entry: 99_999_999 })).status).toBe(404);
  expect((await json(`/api/conversations/${editedID}/rerun`, "POST", { entry: users(rewritten)[0]!.entry, text: "   " })).status).toBe(400);
  expect((await json(`/api/conversations/${editedID}/messages`, "POST", { text: "stream a long reply" })).status).toBe(202);
  expect((await json(`/api/conversations/${editedID}/branch`, "POST", { entry: users(rewritten)[0]!.entry })).status).toBe(409);
  await settle(editedID);

  const temporary = ((await (await json("/api/conversations", "POST", { temporary: true })).json()) as { id: number }).id;
  const brief = await say(temporary, "a passing question");
  expect(brief.summary.temporary).toBe(true);
  expect(await listed()).not.toContain(temporary);
  expect((await json(`/api/conversations/${temporary}/branch`, "POST", { entry: users(brief)[0]!.entry })).status).toBe(400);
  expect((await view(editedID)).summary.temporary).toBe(false);
  expect((await api(`/api/conversations/${temporary}`, { method: "DELETE" })).status).toBe(200);
  expect((await api(`/api/conversations/${temporary}`)).status).toBe(404);

  const readable = async (path: string) => (await api(`/api/files/content?path=${encodeURIComponent(path)}`)).status;
  const parent = ((await (await json("/api/conversations", "POST", {})).json()) as { id: number }).id;
  const kept = await (await api(`/api/conversations/${parent}/attachments?name=kept.txt`, { method: "POST", body: "kept" })).json() as { path: string };
  const parentView = await say(parent, "keep this file", [kept.path]);
  const child = ((await (await json(`/api/conversations/${parent}/branch`, "POST", { entry: users(parentView)[0]!.entry })).json()) as { id: number }).id;
  expect((await api(`/api/conversations/${parent}`, { method: "DELETE" })).status).toBe(200);
  expect(await listed()).not.toContain(parent);
  expect((await view(child)).blocks.length).toBeGreaterThan(0);
  expect(await readable(kept.path)).toBe(200);
  expect((await api(`/api/conversations/${child}`, { method: "DELETE" })).status).toBe(200);
  expect(await readable(kept.path)).toBe(404);

  const racer = ((await (await json("/api/conversations", "POST", {})).json()) as { id: number }).id;
  const raced = await (await api(`/api/conversations/${racer}/attachments?name=raced.txt`, { method: "POST", body: "raced" })).json() as { path: string };
  const racerView = await say(racer, "race this file", [raced.path]);
  const [removed, forked] = await Promise.all([api(`/api/conversations/${racer}`, { method: "DELETE" }), json(`/api/conversations/${racer}/branch`, "POST", { entry: users(racerView)[0]!.entry })]);
  expect(removed.status).toBe(200);
  if (forked.status === 201) {
    const survivor = ((await forked.json()) as { id: number }).id;
    expect(await readable(raced.path)).toBe(200);
    expect((await api(`/api/conversations/${survivor}`, { method: "DELETE" })).status).toBe(200);
  } else expect([404, 409]).toContain(forked.status);
  expect(await readable(raced.path)).toBe(404);

  expect((await api(`/api/conversations/${branch}`, { method: "DELETE" })).status).toBe(200);
  expect(await readable(stored.path)).toBe(200);
  expect((await api(`/api/conversations/${editedID}`, { method: "DELETE" })).status).toBe(200);
  expect(await readable(stored.path)).toBe(404);
}, 60_000);

test("Conversations export to packages the phone app reads, and packages import as new conversations", async () => {
  const { zipDecode, zipEncode } = await import(`${ROOT}/apps/linux/src/vm/skills-package.ts`) as typeof import("../../../../../apps/linux/src/vm/skills-package");
  type View = { summary: { title: string }; busy: boolean; blocks: { createdAt: number; kind: { type: string; text?: string; files?: string[]; items?: { text?: string }[]; trace?: { completedAt?: number } } }[] };
  const json = (path: string, method: string, body?: unknown) => api(path, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const view = async (id: number) => await (await api(`/api/conversations/${id}`)).json() as View;
  const settle = async (id: number) => {
    for (let attempt = 0; attempt < 200; attempt++) {
      const current = await view(id);
      if (!current.busy && current.blocks.at(-1)?.kind.type === "agentContent") return current;
      await Bun.sleep(50);
    }
    throw new Error(`Conversation ${id} did not finish`);
  };
  const say = async (id: number, text: string, attachments: string[] = []) => {
    expect((await json(`/api/conversations/${id}/messages`, "POST", { text, attachments })).status).toBe(202);
    return settle(id);
  };
  const digest = (data: Uint8Array) => new Bun.CryptoHasher("sha256").update(data).digest("hex");
  const replies = (current: View) => current.blocks.filter(block => block.kind.type === "agentContent").flatMap(block => block.kind.items ?? []).map(item => item.text ?? "").join(" ");
  const upload = (data: Uint8Array) => api("/api/conversations/import", { method: "POST", body: new Blob([data as Uint8Array<ArrayBuffer>]) });

  const id = ((await (await json("/api/conversations", "POST", {})).json()) as { id: number }).id;
  const stored = await (await api(`/api/conversations/${id}/attachments?name=notes.txt`, { method: "POST", body: "the notes" })).json() as { path: string };
  await say(id, "package question", [stored.path]);
  await say(id, "please write the note");
  expect((await json(`/api/services/en.wikipedia.org/attach`, "POST", { conversation: id })).status).toBe(200);

  const exported = await api(`/api/conversations/${id}/export`);
  expect(exported.status).toBe(200);
  expect(exported.headers.get("content-type")).toBe("application/vnd.ox.conversation+zip");
  expect(exported.headers.get("content-disposition")).toContain("package%20question.conversation");
  const archive = new Uint8Array(await exported.arrayBuffer());
  const entries = zipDecode(archive, 134_217_728, 33_554_432, 256);
  expect(entries.map(entry => entry.path)).toEqual(["conversation.json", "turns.jsonl", "artifacts/notes.txt"]);
  const headerText = new TextDecoder().decode(entries[0]!.data);
  const header = JSON.parse(headerText) as Record<string, unknown> & { files: { path: string; bytes: number; sha256: string }[]; turnCount: number };
  expect(Object.keys(header)).toEqual([...Object.keys(header)].sort());
  expect(header).toMatchObject({ packageVersion: 1, transcriptSchemaVersion: 1, title: "package question", artifactCount: 1, hasContext: false, hasCompactedContext: false,
    serviceDomains: ["en.wikipedia.org"] });
  expect(typeof header.createdAt).toBe("number");
  expect(header.createdAt as number).toBeLessThan(Date.now() / 1000 - 978_307_200 + 1);
  expect(header.files.map(file => file.path)).toEqual(["turns.jsonl", "artifacts/notes.txt"]);
  for (const record of header.files) {
    const data = entries.find(entry => entry.path === record.path)!.data;
    expect(record).toEqual({ path: record.path, bytes: data.length, sha256: digest(data) });
  }
  expect(new TextDecoder().decode(entries[2]!.data)).toBe("the notes");
  const lines = new TextDecoder().decode(entries[1]!.data).trimEnd().split("\n").map(line => JSON.parse(line) as { id: string; type: string; user?: { intent: string; attachments: string[] };
    agent?: { generations: { id: string; outcome: { type: string } }[]; steps: { generation: string; type: string; text?: string; action?: { execute: { source: string; outcome: { type: string } } } }[] } });
  expect(lines.length).toBe(header.turnCount);
  expect(lines.map(turn => turn.type)).toEqual(["user", "agent", "user", "agent"]);
  expect(lines.every(turn => /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/.test(turn.id))).toBe(true);
  expect(lines[0]!.user).toMatchObject({ intent: "package question", attachments: ["notes.txt"] });
  const action = lines[3]!.agent!.steps.find(step => step.type === "action")!;
  expect(action.action!.execute.source).toContain("ox.fs.write");
  expect(action.action!.execute.outcome.type).toBe("succeeded");
  expect(lines[3]!.agent!.steps.filter(step => step.type === "text").map(step => step.text)).toContain("Saved the note.");
  expect(lines[3]!.agent!.steps.every(step => lines[3]!.agent!.generations.some(generation => generation.id === step.generation))).toBe(true);

  const staged = await upload(archive);
  expect(staged.status).toBe(200);
  const summary = await staged.json() as { token: string; title: string; messages: number; artifacts: number; bytes: number; services: string[]; compacted: boolean };
  expect(summary).toMatchObject({ title: "package question", messages: 4, artifacts: 1, bytes: 9, services: ["en.wikipedia.org"], compacted: false });
  const created = await api(`/api/conversations/import/${summary.token}`, { method: "POST" });
  expect(created.status).toBe(201);
  const imported = ((await created.json()) as { id: number }).id;
  const copy = await view(imported);
  expect(copy.summary.title).toBe("package question");
  expect(copy.blocks.filter(block => block.kind.type === "userText").map(block => block.kind.text)).toEqual(["package question", "please write the note"]);
  const file = copy.blocks.find(block => block.kind.type === "userText")!.kind.files![0]!;
  expect(file).toBe(`conversations/${imported}/notes.txt`);
  expect(await (await api(`/api/files/content?path=${encodeURIComponent(file)}`)).text()).toBe("the notes");
  expect(replies(copy)).toContain("Saved the note.");
  expect(copy.blocks.some(block => block.kind.type === "thinking")).toBe(true);
  const services = ((await (await api(`/api/services?conversation=${imported}`)).json()) as { services: { domain: string; attached?: boolean }[] }).services;
  expect(services.find(service => service.domain === "en.wikipedia.org")?.attached).toBe(false);
  expect(replies(await say(imported, "after import"))).toContain("Hello from the scripted model.");
  expect((await api(`/api/conversations/import/${summary.token}`, { method: "POST" })).status).toBe(404);

  const encoder = new TextEncoder();
  const phoneTurns = encoder.encode([
    { id: "11111111-1111-4111-8111-111111111111", type: "user", user: { intent: "Read note", attachments: ["note.txt"], at: 0 } },
    { id: "22222222-2222-4222-8222-222222222222", type: "agent", agent: { at: 100, generations: [{ id: "33333333-3333-4333-8333-333333333333", at: 100, model: "test-model",
      outcome: { type: "completed", at: 107.4 } }], steps: [{ id: "44444444-4444-4444-8444-444444444444", generation: "33333333-3333-4333-8333-333333333333", type: "reasoning", reasoning: "Read the note." },
      { id: "55555555-5555-4555-8555-555555555555", generation: "33333333-3333-4333-8333-333333333333", type: "text", text: "It says hello." }], outcome: { type: "completed", at: 0 } } },
  ].map(turn => JSON.stringify(turn)).join("\n") + "\n");
  const note = encoder.encode("x");
  const phoneHeader = (extra: Record<string, unknown> = {}) => encoder.encode(JSON.stringify({ packageVersion: 1, transcriptSchemaVersion: 1, title: "Example", createdAt: 0, lastActivity: 0,
    exportedAt: 0, turnCount: 2, artifactCount: 1, hasContext: false, hasCompactedContext: false, serviceDomains: [],
    files: [{ path: "turns.jsonl", bytes: phoneTurns.length, sha256: digest(phoneTurns) }, { path: "artifacts/note.txt", bytes: 1, sha256: digest(note) }], ...extra }));
  const phone = (header: Uint8Array, artifact = note, extra: { path: string; data: Uint8Array }[] = []) => zipEncode([{ path: "conversation.json", data: header },
    { path: "turns.jsonl", data: phoneTurns }, { path: "artifacts/note.txt", data: artifact }, ...extra], 134_217_728);
  const phoneSummary = await (await upload(phone(phoneHeader()))).json() as { token: string; title: string; messages: number };
  expect(phoneSummary).toMatchObject({ title: "Example", messages: 2 });
  const fromPhone = ((await (await api(`/api/conversations/import/${phoneSummary.token}`, { method: "POST" })).json()) as { id: number }).id;
  const phoneView = await view(fromPhone);
  expect(phoneView.blocks.find(block => block.kind.type === "userText")!.kind).toMatchObject({ text: "Read note", files: [`conversations/${fromPhone}/note.txt`] });
  expect(replies(phoneView)).toBe("It says hello.");
  const phoneThought = phoneView.blocks.find(block => block.kind.type === "thinking")!;
  expect(phoneThought.createdAt).toBeCloseTo(100, 3);
  expect(phoneThought.kind.trace!.completedAt!).toBeCloseTo(107.4, 3);
  const reexported = zipDecode(new Uint8Array(await (await api(`/api/conversations/${fromPhone}/export`)).arrayBuffer()), 134_217_728, 33_554_432, 256);
  const generation = new TextDecoder().decode(reexported.find(entry => entry.path === "turns.jsonl")!.data).trimEnd().split("\n")
    .map(line => JSON.parse(line) as { agent?: { generations: { at: number; outcome: { type: string; at: number } }[] } }).find(turn => turn.agent)!.agent!.generations[0]!;
  expect(generation.at).toBeCloseTo(100, 3);
  expect(generation.outcome).toMatchObject({ type: "completed" });
  expect(generation.outcome.at).toBeCloseTo(107.4, 3);
  const legacyTurns = encoder.encode([
    { id: "61111111-1111-4111-8111-111111111111", type: "user", user: { intent: "Think it over", attachments: [], at: 200 } },
    { id: "62222222-2222-4222-8222-222222222222", type: "agent", agent: { at: 210, generations: [{ id: "63333333-3333-4333-8333-333333333333", at: 210, model: "test-model",
      outcome: { type: "completed", at: 205 } }], steps: [{ id: "64444444-4444-4444-8444-444444444444", generation: "63333333-3333-4333-8333-333333333333", type: "reasoning", reasoning: "Weighing it." }],
      outcome: { type: "completed", at: 205 } } },
    { id: "65555555-5555-4555-8555-555555555555", type: "user", user: { intent: "And now?", attachments: [], at: 400 } },
    { id: "66666666-6666-4666-8666-666666666666", type: "agent", agent: { at: 410, generations: [{ id: "67777777-7777-4777-8777-777777777777", at: 410, model: "test-model",
      outcome: { type: "completed", at: 411 } }], steps: [{ id: "68888888-8888-4888-8888-888888888888", generation: "67777777-7777-4777-8777-777777777777", type: "text", text: "Done." }],
      outcome: { type: "completed", at: 411 } } },
  ].map(turn => JSON.stringify(turn)).join("\n") + "\n");
  const legacySummary = await (await upload(zipEncode([{ path: "conversation.json", data: encoder.encode(JSON.stringify({ packageVersion: 1, transcriptSchemaVersion: 1, title: "Legacy",
    createdAt: 0, exportedAt: 0, turnCount: 4, artifactCount: 0, hasContext: false, hasCompactedContext: false, serviceDomains: [],
    files: [{ path: "turns.jsonl", bytes: legacyTurns.length, sha256: digest(legacyTurns) }] })) }, { path: "turns.jsonl", data: legacyTurns }], 134_217_728))).json() as { token: string };
  const legacyID = ((await (await api(`/api/conversations/import/${legacySummary.token}`, { method: "POST" })).json()) as { id: number }).id;
  const legacyThought = (await view(legacyID)).blocks.find(block => block.kind.type === "thinking")!;
  expect(legacyThought.createdAt).toBeCloseTo(210, 3);
  expect(legacyThought.kind.trace!.completedAt!).toBeCloseTo(210, 3);

  const refused = async (data: Uint8Array, message: string) => {
    const response = await upload(data);
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain(message);
  };
  await refused(phone(phoneHeader(), encoder.encode("y")), "damaged");
  await refused(phone(phoneHeader(), note, [{ path: "artifacts/extra.txt", data: note }]), "isn't a valid conversation package");
  await refused(phone(phoneHeader({ packageVersion: 2 })), "different version");
  await refused(encoder.encode("not a zip"), "isn't a valid conversation package");
  const inflated = zipEncode(Array.from({ length: 5 }, (_, index) => ({ path: `artifacts/${index}.bin`, data: note })), 134_217_728);
  const directory = new DataView(inflated.buffer, inflated.byteOffset, inflated.byteLength);
  for (let cursor = 0; cursor + 4 <= inflated.length; cursor++) if (directory.getUint32(cursor, true) === 0x02014b50) directory.setUint32(cursor + 24, 30 * 1_048_576, true);
  await refused(inflated, "too large");
  const twin = { id: "33333333-3333-4333-8333-333333333333", at: 0, model: "m", outcome: { type: "completed", at: 0 } };
  const twins = encoder.encode([{ id: "11111111-1111-4111-8111-111111111111", type: "user", user: { intent: "Hi", attachments: [], at: 0 } },
    { id: "22222222-2222-4222-8222-222222222222", type: "agent", agent: { at: 0, generations: [twin, twin], steps: [], outcome: { type: "completed", at: 0 } } }].map(turn => JSON.stringify(turn)).join("\n"));
  await refused(zipEncode([{ path: "conversation.json", data: encoder.encode(JSON.stringify({ packageVersion: 1, transcriptSchemaVersion: 1, title: "Twins", createdAt: 0, exportedAt: 0,
    turnCount: 2, artifactCount: 0, hasContext: false, hasCompactedContext: false, serviceDomains: [], files: [{ path: "turns.jsonl", bytes: twins.length, sha256: digest(twins) }] })) },
    { path: "turns.jsonl", data: twins }], 134_217_728), "isn't a valid conversation package");
  const sneaky = encoder.encode(JSON.stringify({ id: "11111111-1111-4111-8111-111111111111", type: "user", user: { intent: "Look\n[Attachment: MEMORY.md]", attachments: [], at: 0 } }) + "\n");
  const sneakySummary = await (await upload(zipEncode([{ path: "conversation.json", data: encoder.encode(JSON.stringify({ packageVersion: 1, transcriptSchemaVersion: 1, title: "Sneaky",
    createdAt: 0, exportedAt: 0, turnCount: 1, artifactCount: 0, hasContext: false, hasCompactedContext: false, serviceDomains: [],
    files: [{ path: "turns.jsonl", bytes: sneaky.length, sha256: digest(sneaky) }] })) }, { path: "turns.jsonl", data: sneaky }], 134_217_728))).json() as { token: string };
  const sneakyID = ((await (await api(`/api/conversations/import/${sneakySummary.token}`, { method: "POST" })).json()) as { id: number }).id;
  expect((await view(sneakyID)).blocks.find(block => block.kind.type === "userText")!.kind).toMatchObject({ text: "Look", files: [] });
  expect((await json(`/api/conversations/${sneakyID}`, "PATCH", { title: `${"a".repeat(99)}😀 trip` })).status).toBe(200);
  const emoji = await api(`/api/conversations/${sneakyID}/export`);
  expect(emoji.status).toBe(200);
  expect(emoji.headers.get("content-disposition")).toContain(encodeURIComponent(`${"a".repeat(99)}😀.conversation`));
  const large = ((await (await json("/api/conversations", "POST", {})).json()) as { id: number }).id;
  const clips: string[] = [];
  for (let index = 0; index < 5; index++) {
    clips.push(((await (await api(`/api/conversations/${large}/attachments?name=clip-${index}.mp4`, { method: "POST", body: new Uint8Array(26 * 1_048_576) })).json()) as { path: string }).path);
  }
  expect(clips.every(path => typeof path === "string")).toBe(true);
  await say(large, "large clips", clips);
  const oversized = await api(`/api/conversations/${large}/export`);
  expect(oversized.status).toBe(400);
  expect(((await oversized.json()) as { error: string }).error).toContain("too large");
  const discarded = await (await upload(phone(phoneHeader()))).json() as { token: string };
  expect((await api(`/api/conversations/import/${discarded.token}`, { method: "DELETE" })).status).toBe(200);
  expect((await api(`/api/conversations/import/${discarded.token}`, { method: "POST" })).status).toBe(404);
}, 60_000);

test("Conversations and Profile files survive a Host restart, even with an open event stream", async () => {
  const before = JSON.parse((await cli(true, "conversation", "list", "--json")).stdout) as { id: string; title: string }[];
  const stream = await api("/api/events");
  expect(stream.status).toBe(200);
  const started = Date.now();
  await stopHost();
  expect(Date.now() - started).toBeLessThan(10_000);
  await stream.body?.cancel().catch(() => {});
  host = await startHost();
  const after = JSON.parse((await cli(true, "conversation", "list", "--json")).stdout) as { id: string; title: string }[];
  expect(after.map(row => [row.id, row.title])).toEqual(before.map(row => [row.id, row.title]));
  const written = before.find(row => row.title === "hello")!;
  const listing = await (await api(`/api/files?path=conversations/${written.id}`)).json() as { entries: { name: string }[] };
  expect(listing.entries.map(entry => entry.name)).toContain("note.md");
  expect((await api("/api/settings/providers/custom", { method: "DELETE" })).status).toBe(200);
  const orphaned = await cli(true, "--conversation", written.id, "conversation", "send", "hello", "--json");
  expect(orphaned.code).toBe(1);
  expect(orphaned.stderr).toContain("Choose an available model");
  const profile = JSON.parse(await readFile(join(data, "host.json"), "utf8")).profile.id;
  const folder = join(data, "profiles", profile, "files", "conversations", written.id);
  expect((await api(`/api/conversations/${written.id}`, { method: "DELETE" })).status).toBe(200);
  expect(existsSync(folder)).toBe(false);
  const trashed = await readdir(join(data, "profiles", profile, "state", "trash"), { recursive: true });
  expect(trashed.some(path => path.endsWith(join("conversations", written.id, "note.md")))).toBe(true);
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "left.md"), "left behind");
  await stopHost();
  host = await startHost();
  expect(existsSync(folder)).toBe(false);
}, 60_000);

test("Pages open sandboxed under the phone's content policy with the files next to them inlined, and Markdown saves only over the text it replaces", async () => {
  const put = (path: string, body: BodyInit) => api(`/api/files/content?path=${encodeURIComponent(path)}&overwrite=1`, { method: "PUT", body });
  const read = async (path: string) => (await api(`/api/files/content?path=${encodeURIComponent(path)}`)).text();
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
  expect((await put("pages/chart.png", png)).status).toBe(201);
  expect((await put("pages/style.css", "body { color: red }")).status).toBe(201);
  expect((await put("pages/big.png", new Uint8Array(8 * 1024 * 1024 + 1))).status).toBe(201);
  const source = `<h1 id="top">Report</h1><img src="chart.png" alt="chart"><img src="big.png"><img src="https://example.com/x.png"><img src="missing.png"><img src="../../outside.png">`
    + `<img src="chart.png" srcset="chart@2x.png 2x" alt="retina"><picture><source srcset="chart.webp"><img src="chart.png" alt="picture"></picture>`
    + `<link rel="stylesheet" href="style.css"><script>document.title="ran"</script>`;
  expect((await put("pages/report.html", source)).status).toBe(201);
  const page = await api(`/api/files/page?path=${encodeURIComponent("pages/report.html")}`);
  expect(page.status).toBe(200);
  expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
  expect(page.headers.get("content-security-policy")).toStartWith("sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox; default-src 'none';");
  expect(page.headers.get("content-security-policy")).toContain("connect-src 'none'");
  const html = await page.text();
  expect(html).toStartWith(`<!doctype html><html><head><meta charset="utf-8">`);
  expect(html).toContain(`<img src="data:image/png;base64,${Buffer.from(png).toString("base64")}" alt="chart">`);
  expect(html).toContain(`<link rel="stylesheet" href="data:text/css;base64,${Buffer.from("body { color: red }").toString("base64")}">`);
  for (const kept of [`<img src="big.png">`, `<img src="https://example.com/x.png">`, `<img src="missing.png">`, `<img src="../../outside.png">`]) expect(html).toContain(kept);
  expect(html).toContain(`<script>document.title="ran"</script>`);
  expect(html).toContain(`if(event.isTrusted&&/^(https?:|mailto:|tel:)/i.test(raw))open(raw,"_blank","noopener")`);
  const inlined = `data:image/png;base64,${Buffer.from(png).toString("base64")}`;
  expect(html).toContain(`<img src="${inlined}" alt="retina"><picture><source><img src="${inlined}" alt="picture"></picture>`);
  expect(html).not.toContain("srcset");
  const many = Array.from({ length: 200 }, (_, index) => `<img src="gone-${index}.png">`).join("") + `<img src="chart.png" alt="late">`;
  expect((await put("pages/many.html", many)).status).toBe(201);
  expect(await (await api(`/api/files/page?path=${encodeURIComponent("pages/many.html")}`)).text()).toContain(`<img src="chart.png" alt="late">`);
  expect((await put("pages/photo.png", new Uint8Array(6 * 1024 * 1024))).status).toBe(201);
  expect((await put("pages/repeat.html", `<img src="photo.png">`.repeat(3))).status).toBe(201);
  const repeated = await (await api(`/api/files/page?path=${encodeURIComponent("pages/repeat.html")}`)).text();
  expect(repeated.split("data:image/png;base64,").length - 1).toBe(2);
  expect(repeated.split(`<img src="photo.png">`).length - 1).toBe(1);
  const legacy = new Uint8Array([60, 104, 49, 62, 255, 254, 60, 47, 104, 49, 62]);
  expect((await put("pages/legacy.html", legacy)).status).toBe(201);
  const raw = await api(`/api/files/page?path=${encodeURIComponent("pages/legacy.html")}`);
  expect(raw.status).toBe(200);
  expect(raw.headers.get("content-security-policy")).toStartWith("sandbox allow-scripts allow-popups allow-downloads;");
  expect(new Uint8Array(await raw.arrayBuffer())).toEqual(legacy);
  expect((await api(`/api/files/page?path=${encodeURIComponent("pages/style.css")}`)).status).toBe(415);

  expect((await put("pages/notes.md", "# Notes\n")).status).toBe(201);
  const save = (body: unknown) => api("/api/files/text", { method: "PUT", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
  expect((await save({ path: "pages/notes.md", text: "# Notes\nmore\n", previous: "# Notes\n" })).status).toBe(200);
  expect(await read("pages/notes.md")).toBe("# Notes\nmore\n");
  const stale = await save({ path: "pages/notes.md", text: "# Mine\n", previous: "# Notes\n" });
  expect(stale.status).toBe(409);
  expect((await stale.json() as { error: string }).error).toBe("This file changed after you opened it. Open it again to see the latest version.");
  expect(await read("pages/notes.md")).toBe("# Notes\nmore\n");
  const raced = await Promise.all(["# First\n", "# Second\n"].map(text => save({ path: "pages/notes.md", text, previous: "# Notes\nmore\n" })));
  expect(raced.map(response => response.status).sort()).toEqual([200, 409]);
  const winner = raced[0]!.status === 200 ? "# First\n" : "# Second\n";
  expect(await read("pages/notes.md")).toBe(winner);
  expect((await save({ path: "pages/notes.md", text: "# Notes\nmore\n", previous: winner })).status).toBe(200);
  expect((await save({ path: "pages/style.css", text: "x", previous: "body { color: red }" })).status).toBe(415);
  expect((await save({ path: "pages/notes.md", text: "x".repeat(200 * 1024 + 1), previous: "# Notes\nmore\n" })).status).toBe(413);
  expect(await read("pages/notes.md")).toBe("# Notes\nmore\n");
}, 30_000);

test("HTML pages show inside the app through frame-ancestors, with refreshes removed and links opened only by real clicks", async () => {
  const put = (path: string, body: BodyInit) => api(`/api/files/content?path=${encodeURIComponent(path)}&overwrite=1`, { method: "PUT", body });
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 4, 5, 6]);
  expect((await put("frames/chart.png", png)).status).toBe(201);
  expect((await put("frames/live.html", `<meta http-equiv=" Refresh " content="0;url=https://example.com/"><meta charset="utf-8"><h1>Live</h1><img src="chart.png" alt="chart">`)).status).toBe(201);
  const frame = await api(`/api/files/frame?path=${encodeURIComponent("frames/live.html")}`);
  expect(frame.status).toBe(200);
  expect(frame.headers.get("content-type")).toBe("text/html; charset=utf-8");
  expect(frame.headers.get("content-security-policy")).toStartWith("sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox; default-src 'none';");
  expect(frame.headers.get("content-security-policy")).toEndWith("; form-action 'none'; frame-ancestors 'self'");
  expect(frame.headers.get("x-frame-options")).toBe("DENY");
  const html = await frame.text();
  expect(html).toContain(`<img src="data:image/png;base64,${Buffer.from(png).toString("base64")}" alt="chart">`);
  expect(html).toContain(`<meta charset="utf-8"><h1>Live</h1>`);
  expect(html).not.toMatch(/<meta[^>]*http-equiv/i);
  expect(html).toContain(`var open=window.open.bind(window);window.open=function(){return null;};`);
  expect(html).toContain(`if(event.isTrusted&&/^(https?:|mailto:|tel:)/i.test(raw))open(raw,"_blank","noopener")`);
  expect(html).toContain(`if(parent===window)return;`);
  expect(html).toContain(`parent.postMessage({type:"ox-page",height:height},"*")`);
  expect(html).toContain(`if(event.source===parent&&data&&data.type==="ox-page"&&typeof data.ping==="number")parent.postMessage({type:"ox-page",pong:data.ping},"*")`);
  const tab = await api(`/api/files/page?path=${encodeURIComponent("frames/live.html")}`);
  expect(tab.headers.get("content-security-policy")).not.toContain("frame-ancestors");
  expect((await tab.text()).toLowerCase()).not.toContain("refresh");

  const missing = await api(`/api/files/frame?path=${encodeURIComponent("frames/gone.html")}`);
  expect(missing.status).toBe(404);
  expect(missing.headers.get("content-security-policy")).toEndWith("frame-ancestors 'self'");
  expect(await missing.text()).toContain(`parent.postMessage({type:"ox-page",unavailable:"missing"},"*")`);
  expect((await put("frames/legacy.html", new Uint8Array([60, 112, 62, 255, 254, 60, 47, 112, 62]))).status).toBe(201);
  const legacy = await api(`/api/files/frame?path=${encodeURIComponent("frames/legacy.html")}`);
  expect(legacy.status).toBe(415);
  expect(legacy.headers.get("content-security-policy")).toEndWith("frame-ancestors 'self'");
  expect(await legacy.text()).toContain(`parent.postMessage({type:"ox-page",unavailable:"unsupported"},"*")`);
  const image = await api(`/api/files/frame?path=${encodeURIComponent("frames/chart.png")}`);
  expect(image.status).toBe(415);
  expect(image.headers.get("content-type")).toStartWith("application/json");
}, 30_000);

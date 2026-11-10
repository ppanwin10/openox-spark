import assert from "node:assert/strict";
import { createHash, X509Certificate } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { connect as connectTLS, checkServerIdentity } from "node:tls";
import { parseArgs } from "node:util";
import { chromium, type Browser } from "playwright-core";
import { Host } from "../src/host";
import { startServer } from "../src/server";

process.umask(0o077);
process.env.OPENOX_MEDIA_URL = "http://127.0.0.1:9";
const root = resolve(import.meta.dir, "../../..");
const { values } = parseArgs({ options: { "frp-dir": { type: "string" }, out: { type: "string" } } });
if (!values["frp-dir"]) throw new Error("Usage: bun apps/linux/scripts/connectivity-check.ts --frp-dir <verified-frp-0.72.0-directory> --out <outside-checkout>");
const binaries = resolve(values["frp-dir"]);
const out = resolve(values.out ?? join(tmpdir(), `openox-connectivity-${crypto.randomUUID()}`));
const inside = relative(root, out);
if (!inside || (!inside.startsWith(`..${sep}`) && !isAbsolute(inside))) throw new Error("Keep connectivity evidence outside the checkout");
await mkdir(out, { recursive: true, mode: 0o700 });
const work = await mkdtemp(join(out, "private-run-"));
const results: { name: string; passed: boolean }[] = [];
const secrets: string[] = [];
type OwnedProcess = { child: ReturnType<typeof Bun.spawn>; output(): string; stop(): Promise<void> };
const processes: OwnedProcess[] = [];
const sanitize = (text: string) => secrets.reduce((value, secret) => value.replaceAll(secret, "[redacted]"), text);
const digest = (certificate: string | Buffer) => createHash("sha256").update(new X509Certificate(certificate).publicKey.export({ format: "der", type: "spki" })).digest("base64");

async function execute(command: string[]) {
  const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code) throw new Error(sanitize(`Tool failed (${command[0]}): ${stderr}`));
  return stdout;
}

function launch(command: string[]): OwnedProcess {
  const child = Bun.spawn(command, { cwd: work, stdout: "pipe", stderr: "pipe" });
  let output = "";
  const drain = async (stream: ReadableStream<Uint8Array>) => {
    const reader = stream.getReader(), decoder = new TextDecoder();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        output = (output + decoder.decode(value)).slice(-16_384);
      }
    } finally { reader.releaseLock(); }
  };
  const drained = Promise.all([drain(child.stdout), drain(child.stderr)]);
  const owned = { child, output: () => sanitize(output), stop: async () => {
    if (child.exitCode === null) child.kill("SIGTERM");
    const timer = setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, 2_000);
    try { await child.exited; await drained; } finally { clearTimeout(timer); }
  } };
  processes.push(owned);
  return owned;
}

async function until(predicate: () => boolean | Promise<boolean>, label: string) {
  const deadline = Date.now() + 10_000;
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error(sanitize(`${label} timed out\n${processes.map(process => process.output()).join("\n")}`));
    await Bun.sleep(50);
  }
}

async function check(name: string, operation: () => Promise<void>) {
  await operation();
  results.push({ name, passed: true });
  console.log(`PASS ${name}`);
}

async function freePort() {
  const listener = createServer();
  await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  assert(address && typeof address !== "string");
  await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  return address.port;
}

async function certificate(name: string, authority?: { cert: string; key: string }) {
  const folder = join(work, name);
  await mkdir(folder, { mode: 0o700 });
  const key = join(folder, "key.pem"), cert = join(folder, "cert.pem"), request = join(folder, "request.pem");
  const base = ["openssl", "req", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", key,
    "-subj", authority ? "/CN=localhost" : "/CN=OpenOx connectivity fixture authority"];
  if (!authority) await execute([...base, "-x509", "-days", "1", "-out", cert, "-addext", "basicConstraints=critical,CA:TRUE"]);
  else {
    await execute([...base, "-out", request, "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"]);
    await execute(["openssl", "x509", "-req", "-in", request, "-CA", authority.cert, "-CAkey", authority.key, "-CAcreateserial",
      "-days", "1", "-copy_extensions", "copy", "-out", cert]);
  }
  return { cert, key };
}

async function pinnedPeer(port: number, ca: string, expected: string) {
  return await new Promise<string>((resolve, reject) => {
    const socket = connectTLS({ host: "127.0.0.1", port, servername: "localhost", ca, checkServerIdentity(name, peer) {
      return checkServerIdentity(name, peer) ?? (digest(peer.raw) === expected ? undefined : new Error("Unexpected Host identity"));
    } });
    socket.setTimeout(5_000, () => socket.destroy(new Error("TLS identity check timed out")));
    socket.once("error", reject);
    socket.once("secureConnect", () => { const identity = digest(socket.getPeerCertificate().raw); socket.destroy(); resolve(identity); });
  });
}

const chunk = (delta: unknown, finish: string | null = null) => `data: ${JSON.stringify({ id: "connection-fixture", object: "chat.completion.chunk", created: 0, model: "fixture",
  choices: [{ index: 0, delta, finish_reason: finish }], ...(finish ? { usage: { prompt_tokens: 20, completion_tokens: 20, total_tokens: 40 } } : {}) })}\n\n`;
const canary = `Connection proof ${crypto.randomUUID()}`;
let fixtureCalls = 0;
const model = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  if (request.method === "GET") return Response.json({ object: "list", data: [{ id: "fixture", object: "model", max_model_len: 40_960 }] });
  await request.json();
  fixtureCalls += 1;
  return new Response(new ReadableStream({ async start(controller) {
    controller.enqueue(new TextEncoder().encode(chunk({ role: "assistant", content: `${canary}. ` })));
    for (const word of ["Your ", "Host ", "answered ", "through ", "the ", "encrypted ", "connection."]) {
      controller.enqueue(new TextEncoder().encode(chunk({ content: word })));
      await Bun.sleep(80);
    }
    controller.enqueue(new TextEncoder().encode(chunk({}, "stop") + "data: [DONE]\n\n"));
    controller.close();
  } }), { headers: { "content-type": "text/event-stream" } });
} });
let host: Host | undefined, server: Awaited<ReturnType<typeof startServer>> | undefined, browser: Browser | undefined;
let recorder: ReturnType<typeof createServer> | undefined;
const sockets = new Set<Socket>(), networkErrors: string[] = [], captured: Buffer[] = [];
let recorded = 0, failure = "", cleanupFailure = "";
let events: { abort: AbortController; done: Promise<void>; text: () => string } | undefined;

try {
  for (const binary of ["frpc", "frps"]) assert.equal((await execute([join(binaries, binary), "--version"])).trim(), "0.72.0", "Use the pinned prototype carrier");
  const authority = await certificate("authority");
  const hostIdentity = await certificate("host", authority), relayIdentity = await certificate("relay", authority);
  const ca = await readFile(authority.cert, "utf8"), hostCert = await readFile(hostIdentity.cert, "utf8");
  const hostKey = await readFile(hostIdentity.key, "utf8");
  const fingerprint = digest(hostCert);
  host = await Host.open({ data: join(work, "host-data"), hostID: "Connection fixture", version: "prototype", quiet: true });
  server = await startServer(host, { hostname: "127.0.0.1", port: 0, tls: { cert: hostCert, key: hostKey } });
  const local = `https://localhost:${server.port}`, tls = { ca };
  const admin = await host.devices.add("Connection fixture administrator", "cli");
  const peer = await host.devices.add("Connection fixture RPC", "cli");
  secrets.push(admin.token, peer.token);
  const controlPort = await freePort(), forwardedPort = await freePort();
  const carrierSecret = crypto.randomUUID();
  secrets.push(carrierSecret);
  const frpsConfig = join(work, "frps.json"), frpcConfig = join(work, "frpc.json");
  await Bun.write(frpsConfig, JSON.stringify({
    bindAddr: "127.0.0.1", proxyBindAddr: "127.0.0.1", bindPort: controlPort, allowPorts: [{ single: forwardedPort }], maxPortsPerClient: 1,
    auth: { method: "token", token: carrierSecret, additionalScopes: ["HeartBeats", "NewWorkConns"] },
    transport: { tls: { force: true, certFile: relayIdentity.cert, keyFile: relayIdentity.key } },
    log: { level: "info", disablePrintColor: true },
  }));
  const clientConfig = (token: string) => ({
    serverAddr: "127.0.0.1", serverPort: controlPort, loginFailExit: true,
    auth: { method: "token", token, additionalScopes: ["HeartBeats", "NewWorkConns"] },
    transport: { protocol: "tcp", tls: { enable: true, trustedCaFile: authority.cert, serverName: "localhost" } },
    proxies: [{ name: "host", type: "tcp", localIP: "127.0.0.1", localPort: server!.port, remotePort: forwardedPort }],
    log: { level: "info", disablePrintColor: true },
  });
  await Bun.write(frpcConfig, JSON.stringify(clientConfig(carrierSecret)));
  const relay = launch([join(binaries, "frps"), "-c", frpsConfig]);
  await until(() => relay.output().includes("frps started successfully"), "Carrier server startup");
  let carrier = launch([join(binaries, "frpc"), "-c", frpcConfig]);
  await until(() => carrier.output().includes("start proxy success"), "Outbound carrier registration");
  recorder = createServer(incoming => {
    const upstream = connect({ host: "127.0.0.1", port: forwardedPort });
    for (const socket of [incoming, upstream]) {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", (error: NodeJS.ErrnoException) => {
        networkErrors.push(error.code ?? error.name);
        incoming.destroy(); upstream.destroy();
      });
      socket.on("data", (bytes: Buffer) => {
        if (recorded < 8 * 1024 * 1024) { captured.push(Buffer.from(bytes)); recorded += bytes.length; }
      });
    }
    incoming.pipe(upstream); upstream.pipe(incoming);
    incoming.on("close", () => upstream.destroy()); upstream.on("close", () => incoming.destroy());
  });
  await new Promise<void>(resolve => recorder!.listen(0, "127.0.0.1", resolve));
  const ingress = recorder.address();
  assert(ingress && typeof ingress !== "string");
  const remote = `https://127.0.0.1:${ingress.port}`;
  const request = (base: string, path: string, init: RequestInit = {}) => fetch(`${base}${path}`, { ...init, tls, signal: init.signal ?? AbortSignal.timeout(5_000) });
  const api = async <T>(base: string, path: string, json?: unknown, method = json === undefined ? "GET" : "POST") => {
    const response = await request(base, path, { method, headers: { authorization: `Bearer ${admin.token}`, "content-type": "application/json" },
      body: json === undefined ? undefined : JSON.stringify(json) });
    assert(response.ok, `${path}: HTTP ${response.status}`);
    return await response.json() as T;
  };
  await check("end-to-Host TLS through outbound TCP carrier", async () => {
    assert.equal(await pinnedPeer(ingress.port, ca, fingerprint), fingerprint);
    await assert.rejects(pinnedPeer(ingress.port, ca, digest(await readFile(relayIdentity.cert))), /Unexpected Host identity/);
    assert.equal((await request(remote, "/api/settings")).status, 401);
    assert.equal((await request(remote, "/api/health")).status, 200);
  });
  await check("carrier admission is not Host device authorization", async () => {
    const wrongConfig = join(work, "wrong-client.json");
    await Bun.write(wrongConfig, JSON.stringify(clientConfig("incorrect-fixture-secret")));
    const wrong = launch([join(binaries, "frpc"), "-c", wrongConfig]);
    await until(() => wrong.child.exitCode !== null, "Incorrect carrier enrollment refusal");
    assert.notEqual(wrong.child.exitCode, 0);
    assert.match(wrong.output(), /token.*match|authentication/i);
    assert.equal((await request(remote, "/api/settings", { headers: { authorization: "Bearer incorrect-fixture-token" } })).status, 401);
  });
  await api(remote, "/api/settings/providers/custom", { name: "Scripted connection fixture", baseUrl: `http://127.0.0.1:${model.port}/v1`, models: ["fixture"] }, "PUT");
  const eventAbort = new AbortController();
  const stream = await request(remote, "/api/events", { headers: { authorization: `Bearer ${peer.token}` }, signal: eventAbort.signal });
  assert(stream.body);
  let eventText = "";
  const eventDone = (async () => {
    const reader = stream.body!.getReader(), decoder = new TextDecoder();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        eventText = (eventText + decoder.decode(value)).slice(-256_000);
      }
    }
    catch (error) { if (!eventAbort.signal.aborted) throw error; }
    finally { reader.releaseLock(); }
  })();
  events = { abort: eventAbort, done: eventDone, text: () => eventText };
  browser = await chromium.launch({ channel: "chrome", args: [`--ignore-certificate-errors-spki-list=${fingerprint}`] });
  const rpcContext = await browser.newContext();
  await rpcContext.addCookies([{ name: "ox_device", value: peer.token, url: remote, httpOnly: true, secure: true, sameSite: "Strict" }]);
  const rpcPage = await rpcContext.newPage();
  await rpcPage.goto(remote);
  const rpc = await rpcPage.evaluateHandle(() => new WebSocket(`${location.origin.replace("https:", "wss:")}/rpc`));
  await check("authenticated WSS RPC v4", async () => {
    const described = await rpc.evaluate(socket => new Promise<{ protocols: { rpc: number[] } }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Encrypted RPC timed out")), 5_000);
      const send = () => socket.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "host.describe", params: {} }));
      if (socket.readyState === WebSocket.OPEN) send(); else socket.addEventListener("open", send, { once: true });
      socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Encrypted RPC connection failed")); }, { once: true });
      socket.addEventListener("message", event => {
        const message = JSON.parse(String(event.data)) as { id?: number; result?: { protocols: { rpc: number[] } }; error?: unknown };
        if (message.id !== 1) return;
        clearTimeout(timer);
        if (message.error || !message.result) reject(new Error("Authenticated RPC was refused")); else resolve(message.result);
      });
    }));
    assert(described.protocols.rpc.includes(4));
  });
  const devices: { id: string; name: string }[] = [];
  for (const variant of [
    { name: "desktop", viewport: { width: 1440, height: 900 }, language: "en", theme: "light", touch: false },
    { name: "phone-layout", viewport: { width: 390, height: 844 }, language: "zh-Hans", theme: "dark", touch: true },
  ] as const) {
    await check(`${variant.name}: invitation, pairing and rendered streamed reply`, async () => {
      const context = await browser!.newContext({ viewport: variant.viewport, locale: variant.language, isMobile: variant.touch, hasTouch: variant.touch });
      await context.addInitScript(({ language, theme }) => { localStorage.setItem("ox.language", language); localStorage.setItem("ox.theme", theme);
        localStorage.setItem("ox.onboarded", "1"); localStorage.setItem("ox.memoryIntent", "3"); localStorage.setItem("ox.whatsNew", "2026-11-09"); }, variant);
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      const invitation = await execute([process.execPath, join(root, "apps/linux/src/main.ts"), "pair", "--data", join(work, "host-data"), "--url", remote]);
      const code = /Pairing code: (\S+)/.exec(invitation)?.[1];
      assert(code);
      secrets.push(code);
      assert(invitation.includes(`${remote}/#/pair/${code}`));
      await page.goto(`${remote}/#/pair/${code}`);
      await page.getByTestId("pair-code").waitFor();
      assert.equal(await page.getByTestId("pair-code").inputValue(), code);
      await page.getByTestId("pair-name").fill(`Connection ${variant.name}`);
      if (variant.name === "desktop") await page.screenshot({ path: join(out, "desktop-pairing.png"), fullPage: true });
      await page.getByTestId("pair-submit").click();
      await page.getByTestId("composer-input").waitFor();
      const cookie = (await context.cookies(remote)).find(cookie => cookie.name === "ox_device");
      assert(cookie?.secure && cookie.httpOnly && cookie.sameSite === "Strict");
      secrets.push(cookie.value);
      const session = await page.evaluate(async () => await (await fetch("/api/session")).json() as { paired: boolean; device: { id: string; name: string } });
      assert(session.paired);
      devices.push(session.device);
      await page.getByTestId("composer-input").fill("Check this connection using the scripted fixture.");
      await page.getByTestId("send").click();
      await page.getByText(`${canary}. Your Host answered through the encrypted connection.`, { exact: false }).first().waitFor();
      await page.getByTestId("copy-reply").first().waitFor({ state: "attached" });
      await page.locator("body").evaluate(async element => { await Promise.all(element.getAnimations({ subtree: true })
        .filter(animation => Number.isFinite(animation.effect?.getComputedTiming().endTime)).map(animation => animation.finished)); });
      await page.screenshot({ path: join(out, `${variant.name}-chat.png`), fullPage: true });
      assert.deepEqual(errors, []);
      assert.equal((await request(remote, "/api/pair", { method: "POST", headers: { origin: remote, "content-type": "application/json" },
        body: JSON.stringify({ code, name: "Reused invitation" }) })).status, 403);
      await context.close();
    });
  }
  await check("real Host SSE crosses the carrier", async () => {
    await until(() => events!.text().includes("event: stream") && events!.text().includes("event: conversation"), "Host event stream");
  });
  await check("relay boundary contains ciphertext, not application canaries", async () => {
    const wire = Buffer.concat(captured);
    assert(recorded > 10_000);
    assert.equal(wire[0], 0x16);
    for (const value of [canary, admin.token, peer.token, ...secrets]) assert(!wire.includes(Buffer.from(value)), "Unexpected plaintext at relay boundary");
  });
  await check("revocation cuts off active SSE and WSS access", async () => {
    const closed = await rpc.evaluateHandle(socket => ({ code: new Promise<number>(resolve => {
      socket.addEventListener("close", event => resolve(event.code), { once: true });
    }) }));
    await api(remote, `/api/devices/${peer.device.id}`, undefined, "DELETE");
    assert.equal(await Promise.race([closed.evaluate(event => event.code), Bun.sleep(5_000).then(() => 0)]), 4401);
    await Promise.race([events!.done, Bun.sleep(5_000).then(() => { throw new Error("Revoked event stream stayed open"); })]);
    assert.equal((await request(remote, "/api/settings", { headers: { authorization: `Bearer ${peer.token}` } })).status, 401);
  });
  events.abort.abort();
  await events.done;
  await check("carrier outage fails remotely while direct local access survives", async () => {
    await carrier.stop();
    await assert.rejects(request(remote, "/api/health"));
    assert.equal((await request(local, "/api/settings", { headers: { authorization: `Bearer ${admin.token}` } })).status, 200);
  });
  await check("outbound carrier reconnect preserves Host authorization", async () => {
    carrier = launch([join(binaries, "frpc"), "-c", frpcConfig]);
    await until(() => carrier.output().includes("start proxy success"), "Carrier reconnection");
    const state = await api<{ profile: { id: string } }>(remote, "/api/settings");
    assert.equal(state.profile.id, host!.settings.profile.id);
    for (const device of devices) await api(remote, `/api/devices/${device.id}`, undefined, "DELETE");
  });
} catch (error) {
  failure = sanitize(error instanceof Error ? error.message : String(error));
} finally {
  const cleanups = [
    async () => { events?.abort.abort(); await events?.done; },
    async () => { await browser?.close(); },
    async () => { for (const socket of sockets) socket.destroy(); if (recorder) await new Promise<void>((resolve, reject) => recorder!.close(error => error ? reject(error) : resolve())); },
    async () => { for (const process of [...processes].reverse()) await process.stop(); },
    async () => { await server?.stop(true); await host?.close(); model.stop(true); },
    async () => { await rm(work, { recursive: true, force: true }); },
  ];
  const errors: string[] = [];
  for (const cleanup of cleanups) try { await cleanup(); } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
  cleanupFailure = sanitize(errors.join("; "));
}
await Bun.write(join(out, "report.json"), JSON.stringify({
  status: failure || cleanupFailure ? "failed" : "passed", results, failure: failure || null, cleanupFailure: cleanupFailure || null,
  scope: "loopback-only reverse TCP carrier; actual Host/client; no Tailscale, Spark or real inference",
  carrier: "frp 0.72.0; prototype only", fixtureCalls, recordedTLSBytes: recorded, observedNetworkErrors: networkErrors,
  limitations: ["No public endpoint, cellular or CGNAT acceptance", "Phone layout is Chrome emulation, not real iOS",
    "Fixture SPKI is supplied to an isolated Chrome process; no production certificate bypass or global CA installation",
    "No fleet provisioning, stable identity/recovery or production provider selection", "Browser active-operator/update trust is not established"],
  cleanupComplete: !cleanupFailure,
}, null, 2));
if (failure || cleanupFailure) throw new Error([failure, cleanupFailure].filter(Boolean).join("; "));
console.log(`Evidence: ${out}`);

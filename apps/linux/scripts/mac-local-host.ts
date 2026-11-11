import { createPrivateKey, X509Certificate } from "node:crypto";
import { lookup } from "node:dns/promises";
import { mkdir, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { encode } from "uqr";
import { Host } from "../src/host";
import { startServer } from "../src/server";
import { checkLocalAddress, invitation } from "../src/connections";
import { Devices } from "../src/auth";
import { hostPaths } from "../src/config";
import { machinePrefix } from "../src/providers";
import metadata from "../package.json";

process.umask(0o077);
process.env.OPENOX_MEDIA_URL = "http://127.0.0.1:9";
const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  data: { type: "string" }, identity: { type: "string" }, "no-open": { type: "boolean" },
} });
const command = positionals[0] ?? "start";
if (!["start", "pair", "stop"].includes(command) || positionals.length > 1) throw new Error("Use start, pair or stop");
if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("This engineering bundle supports Apple Silicon Macs only");
const data = resolve(values.data ?? join(homedir(), "Library/Application Support/OpenOx Mac LAN Test"));
const identity = resolve(values.identity ?? join(data, "identity"));
const lock = join(data, "run.json"), script = resolve(import.meta.path);
const testProvider = `${machinePrefix}mac-lan-test`;
type Running = { pid: number; birth: string; script: string; data: string; nonce: string; origin: string };
async function birth(pid: number) {
  const child = Bun.spawn(["/bin/ps", "-p", String(pid), "-o", "lstart="], { env: { ...process.env, LC_ALL: "C" }, stdout: "pipe", stderr: "pipe" });
  const [code, output] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  if (code === 1) return null;
  if (code) throw new Error("Cannot verify the test Host process");
  return output.trim();
}
async function running() {
  let text: string;
  try { text = await readFile(lock, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  const value = JSON.parse(text) as Running;
  if (!Number.isInteger(value.pid) || value.pid <= 0 || !value.birth || !value.nonce || value.script !== script || value.data !== data) {
    throw new Error("The runtime record is invalid; preserve it for explicit repair");
  }
  const current = await birth(value.pid);
  if (current !== null && current !== value.birth) throw new Error("The recorded PID belongs to another process; it will not be stopped");
  if (current !== null) {
    const child = Bun.spawn(["/bin/ps", "-ww", "-p", String(value.pid), "-o", "command="], { stdout: "pipe", stderr: "pipe" });
    const [code, command] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    if (code || !command.includes(script) || !command.includes(data)) throw new Error("The recorded process command does not match this test Host; it will not be stopped");
  }
  return { value, alive: current !== null };
}
async function closeLock(nonce: string) {
  const stored = JSON.parse(await readFile(lock, "utf8")) as Running;
  if (stored.nonce !== nonce || stored.data !== data) throw new Error("Runtime ownership changed; do not remove its record");
  await rm(lock);
}
async function showInvitation(origin: string, pairing: { code: string; expiresAt: string }) {
  const url = invitation(origin, pairing.code);
  const escape = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
  const { data: cells } = encode(url, { ecc: "M", border: 4 });
  const path = cells.flatMap((row, y) => row.flatMap((dark, x) => dark ? [`M${x} ${y}h1v1h-1z`] : [])).join("");
  const page = join(data, "Connect phone.html");
  await writeFile(page, `<!doctype html><html lang="zh-Hans"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>连接 Mac 测试主机</title><style>
:root{color-scheme:light dark;font:17px/1.6 -apple-system,system-ui,sans-serif;background:light-dark(#f2f2f7,#0a0a0a);color:light-dark(#000,#ececec)}
body{max-width:640px;margin:48px auto;padding:0 24px}h1{font-size:28px;line-height:1.25}p{margin:20px 0}.muted{color:light-dark(#555,#aaa)}
.qr{width:min(320px,100%);background:#fff;padding:16px;border-radius:20px;margin:28px 0}.qr svg{display:block;width:100%;height:auto;fill:#000}
a{color:inherit;text-underline-offset:4px;overflow-wrap:anywhere}code{font:14px/1.6 ui-monospace,monospace;overflow-wrap:anywhere}
</style><main><h1>用手机连接这台 Mac</h1><p>手机和 Mac 接入同一个可互通的 Wi-Fi。用手机相机扫描，Safari 打开后点「连接」。</p>
<div class="qr"><svg role="img" aria-label="手机配对二维码" viewBox="0 0 ${cells.length} ${cells.length}" shape-rendering="crispEdges"><path d="${path}"/></svg></div>
<p>本次二维码在 <strong>${escape(new Date(pairing.expiresAt).toLocaleString("zh-CN"))}</strong> 前有效，仅能使用一次。过期或已使用后，请运行包里的 <strong>Pair.command</strong> 生成新码。</p>
<p><a href="${escape(url)}">在这台 Mac 上打开同一配对入口</a>（也会使用掉这个配对码）</p>
<p class="muted">这是局域网连接测试，回复由脚本生成，不是 AI 推理。对话、文件和记忆保存在这台 Mac 的独立测试目录，不会调用 Spark 或 MyGPT。</p>
<p>主机地址<br><code>${escape(origin)}</code></p><p>资料目录<br><code>${escape(data)}</code></p>
<p class="muted">Mac 需保持唤醒。停止请运行 Stop.command；停止不会删除资料。没有配置家外连接时，离开此局域网后不可访问。</p></main></html>`,
  { mode: 0o600 });
  console.log(`Phone invitation: ${page}\nValid until: ${new Date(pairing.expiresAt).toLocaleString()}\nOnly a scripted connection-test model is enabled.`);
  if (!values["no-open"]) {
    const child = Bun.spawn(["/usr/bin/open", pathToFileURL(page).href], { stdout: "inherit", stderr: "inherit" });
    if (await child.exited) throw new Error(`Could not open the invitation. Open this file manually: ${page}`);
  }
}
if (command === "stop") {
  const state = await running();
  if (!state) { console.log("No Mac test Host is running. Data and identity are preserved."); process.exit(0); }
  const { value, alive } = state;
  if (!alive) { await closeLock(value.nonce); console.log("The test Host is already stopped. Its data is preserved."); }
  else {
    process.kill(value.pid, "SIGTERM");
    const deadline = Date.now() + 20000;
    while (await birth(value.pid) === value.birth) {
      if (Date.now() > deadline) throw new Error(`The owned Host (${value.pid}) is still shutting down; it was not force-killed`);
      await Bun.sleep(100);
    }
    console.log("Stopped only the owned Mac test Host. Data and identity are preserved.");
  }
} else if (command === "pair") {
  const state = await running();
  if (!state?.alive) throw new Error("The test Host is stopped. Run Start.command first");
  const { value } = state;
  const response = await fetch(`${value.origin}/api/health`, { signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error("The trusted test Host is not responding");
  await showInvitation(value.origin, await (await Devices.open(hostPaths(data))).createPairingCode());
} else {
  const config = JSON.parse(await readFile(join(identity, "host.json"), "utf8")) as { hostname: string; address: string; port: number };
  if (!/^[a-z0-9][a-z0-9.-]+\.[a-z]{2,}$/i.test(config.hostname) || !Number.isInteger(config.port) || config.port < 1024 || config.port > 65535) {
    throw new Error("The prepared Host name/port is invalid; ask engineering to repair this test identity");
  }
  checkLocalAddress(config.address);
  for (const name of ["", "server.key", "fullchain.pem", "host.json"]) {
    if ((await stat(join(identity, name))).mode & 0o077) throw new Error("The prepared identity must be readable by its owner only");
  }
  const [cert, key] = await Promise.all([readFile(join(identity, "fullchain.pem"), "utf8"), readFile(join(identity, "server.key"), "utf8")]);
  const certificate = new X509Certificate(cert);
  if (certificate.ca || !certificate.checkHost(config.hostname) || !certificate.checkPrivateKey(createPrivateKey(key))
    || Date.parse(certificate.validFrom) > Date.now() || Date.parse(certificate.validTo) <= Date.now()) {
    throw new Error("The test TLS identity is expired, mismatched or invalid; it was not replaced or bypassed");
  }
  const addresses = await lookup(config.hostname, { all: true });
  if (!addresses.length || addresses.some(entry => entry.address !== config.address)) {
    throw new Error("Test DNS does not resolve only to this Mac's prepared private interface; wait for DNS or ask engineering to update it");
  }
  await mkdir(data, { recursive: true, mode: 0o700 });
  if ((await stat(data)).mode & 0o077) throw new Error("The test data directory needs owner-only permissions");
  const nonce = crypto.randomUUID(), origin = `https://${config.hostname}:${config.port}`;
  const ownBirth = await birth(process.pid);
  if (!ownBirth) throw new Error("Cannot establish runtime process ownership");
  const handle = await open(lock, "wx", 0o600).catch(error => {
    if (error.code === "EEXIST") throw new Error("A runtime record already exists. Use Stop.command to check it before starting again");
    throw error;
  });
  await handle.writeFile(JSON.stringify({ pid: process.pid, birth: ownBirth, script, data, nonce, origin } satisfies Running));
  await handle.close();
  let host: Host | undefined, server: Awaited<ReturnType<typeof startServer>> | undefined;
  let model: ReturnType<typeof Bun.serve> | undefined;
  const finished = Promise.withResolvers<void>();
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  const stop = () => finished.resolve();
  for (const signal of signals) process.on(signal, stop);
  try {
    const event = (content: string, done = false) => `data: ${JSON.stringify({ id: "mac-lan-test", object: "chat.completion.chunk", created: 0,
      model: "lan-connection-test", choices: [{ index: 0, delta: { content }, finish_reason: done ? "stop" : null }] })}\n\n`;
    model = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      const path = new URL(request.url).pathname;
      if (request.method === "GET" && path === "/v1/models") return Response.json({ object: "list", data: [{ id: "lan-connection-test", object: "model" }] });
      if (request.method !== "POST" || path !== "/v1/chat/completions") return new Response("Not found", { status: 404 });
      await request.json();
      return new Response(event("【连接测试回复，不是 AI 推理】这台 Mac 已收到请求。对话保存在 Mac 的测试工作区。")
        + event("", true) + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
    } });
    let existing = true;
    try { await stat(hostPaths(data).settings); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") existing = false; else throw error; }
    host = await Host.open({ data, hostID: "Mac LAN Test Host", version: metadata.version, quiet: true });
    const selected = host.settings.defaultModel;
    if (selected && (selected.provider !== testProvider || selected.modelId !== "lan-connection-test")) {
      throw new Error("This workspace selects another model. The test bundle will not call or replace it; use a dedicated test data folder");
    }
    await host.saveMachine(testProvider, { name: "连接测试 · 脚本回复", baseUrl: `http://127.0.0.1:${model.port}/v1`, models: ["lan-connection-test"] });
    const choice = host.providers.validChoice({ provider: testProvider, modelId: "lan-connection-test" });
    await host.updateSettings({ ...(!existing ? { profile: { ...host.settings.profile, name: "Mac LAN Test" } } : {}),
      defaultModel: choice });
    host.localConnection = { url: origin, hostId: host.settings.profile.id, hostname: config.hostname, discovery: "unavailable" };
    server = await startServer(host, { hostname: config.address, port: config.port, tls: { cert, key } });
    const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error("The system-trusted LAN check failed");
    console.log(`Mac LAN test Host ready: ${origin}\nData stays at: ${data}\nNo Spark, MyGPT, outside route or real model is used.`);
    await showInvitation(origin, await host.devices.createPairingCode());
    await finished.promise;
  } finally {
    for (const signal of signals) process.removeListener(signal, stop);
    await server?.stop(true);
    await host?.close();
    await model?.stop(true);
    await closeLock(nonce);
  }
}

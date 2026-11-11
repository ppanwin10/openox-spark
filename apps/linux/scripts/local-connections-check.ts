import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { connect } from "node:tls";
import { parseArgs } from "node:util";
import { localAddresses, localIdentity } from "../src/connections";

process.umask(0o077);
const root = resolve(import.meta.dir, "../../..");
const { values } = parseArgs({ options: { address: { type: "string" }, out: { type: "string" } } });
const address = values.address ?? localAddresses()[0];
assert(address, "Supply an assigned private IPv4 address with --address");
const out = resolve(values.out ?? join(tmpdir(), `openox-local-connections-${crypto.randomUUID()}`));
const inside = relative(root, out);
assert(inside && (inside.startsWith(`..${sep}`) || isAbsolute(inside)), "Keep evidence outside the checkout");
await mkdir(out, { recursive: true, mode: 0o700 });
const work = await mkdtemp(join(out, "private-run-")), data = join(work, "host");
const results: string[] = [];
type Process = { child: ReturnType<typeof Bun.spawn>; output(): string; stop(): Promise<void> };
const processes: Process[] = [];
let current: Process | undefined, failure = "";

function command(...args: string[]) {
  return Bun.spawn([process.execPath, join(root, "apps/linux/src/main.ts"), ...args, "--data", data], { stdout: "pipe", stderr: "pipe",
    env: { ...Bun.env, OPENOX_PUBLIC_URL: "", OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "", OPENOX_MEDIA_URL: "http://127.0.0.1:9" } });
}

async function execute(...args: string[]) {
  const child = command(...args);
  const [code, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  assert.equal(code, 0, `Host command failed: ${error}`);
  return output;
}

async function start() {
  const child = command("serve", "--port", "0", "--name", "Local connection fixture", "--local-network", address!);
  let output = "";
  const drain = async (stream: ReadableStream<Uint8Array>) => {
    const reader = stream.getReader(), decoder = new TextDecoder();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        output = (output + decoder.decode(value)).slice(-16000);
      }
    } finally { reader.releaseLock(); }
  };
  const drains = Promise.all([drain(child.stdout), drain(child.stderr)]);
  const owned = { child, output: () => output, async stop() {
    if (child.exitCode === null) child.kill("SIGTERM");
    const timer = setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, 8000);
    try { await child.exited; await drains; } finally { clearTimeout(timer); }
  } };
  processes.push(owned);
  const deadline = Date.now() + 20000;
  while (!output.includes("Local network available at")) {
    if (child.exitCode !== null || Date.now() > deadline) {
      await owned.stop();
      throw new Error(`Local Host did not start: ${output}`);
    }
    await Bun.sleep(50);
  }
  current = owned;
  const local = JSON.parse(await readFile(join(data, "local-connection.json"), "utf8")) as { url: string; ca: string };
  const ca = await readFile(join(data, "connection-tls/ca.crt"), "utf8");
  return { ...local, tls: { ca }, loopback: `http://127.0.0.1:${new URL(local.url).port}` };
}

async function check(name: string, operation: () => Promise<void>) {
  await operation();
  results.push(name);
  console.log(`PASS ${name}`);
}

try {
  let active = await start();
  let cookie = "", device = "";
  await check("Explicit private-interface HTTPS retains loopback and fails normal unknown-CA validation", async () => {
    assert.equal((await fetch(`${active.loopback}/api/health`)).status, 200);
    await assert.rejects(fetch(`${active.url}/api/health`));
    assert.equal((await fetch(`${active.url}/api/health`, { tls: active.tls })).status, 200);
    assert.equal((await fetch(`${active.url}/api/settings/connections`, { tls: active.tls })).status, 401);
    await assert.rejects(new Promise<void>((resolve, reject) => {
      const peer = connect({ host: address, port: Number(new URL(active.url).port), servername: "wrong-host.invalid", ca: active.tls.ca });
      peer.once("error", reject);
      peer.once("secureConnect", () => { peer.destroy(); resolve(); });
    }));
    for (const name of ["ca.crt", "ca.key", "server.crt", "server.key"]) {
      assert.equal((await stat(join(data, "connection-tls", name))).mode & 0o777, 0o600);
    }
    assert.equal((await stat(join(data, "connection-tls"))).mode & 0o777, 0o700);
  });
  await check("App invitation carries one-time pairing and private CA identity only in its fragment", async () => {
    const output = await execute("pair");
    const code = /Pairing code: (\S+)/.exec(output)?.[1];
    assert(code);
    const link = new URL(`${active.url}/#/pair/${code}?host=${JSON.parse(await readFile(join(data, "host.json"), "utf8")).profile.id}&ca=${active.ca}`);
    assert(output.includes(link.href));
    assert.equal(link.search, "");
    assert.equal(active.ca, new X509Certificate(active.tls.ca).fingerprint256.replaceAll(":", "").toLowerCase());
    const paired = await fetch(`${active.url}/api/pair`, { tls: active.tls, method: "POST", headers: { origin: active.url, "content-type": "application/json" },
      body: JSON.stringify({ code, name: "LAN checker" }) });
    assert.equal(paired.status, 201);
    assert(paired.headers.get("set-cookie")?.includes("; Secure"));
    cookie = paired.headers.get("set-cookie")!.split(";")[0]!;
    const session = await (await fetch(`${active.url}/api/session`, { tls: active.tls, headers: { cookie } })).json() as { paired: boolean; device: { id: string } };
    assert(session.paired);
    device = session.device.id;
    assert.equal((await fetch(`${active.url}/api/pair`, { tls: active.tls, method: "POST", headers: { origin: active.url, "content-type": "application/json" },
      body: JSON.stringify({ code, name: "Replay" }) })).status, 403);
    const details = await (await fetch(`${active.url}/api/settings/connections`, { tls: active.tls, headers: { cookie } })).json() as { local: { discovery: string }; outside: unknown };
    assert.equal(details.local.discovery, "ready");
    assert.equal(details.outside, null);
  });
  await check("A different private Host CA is not accepted", async () => {
    const other = await localIdentity(join(work, "other-host"), address);
    await assert.rejects(fetch(`${active.url}/api/health`, { tls: { ca: other.tls.cert } }));
  });
  await check("Restart preserves private CA, paired device and optional outside settings", async () => {
    assert.equal((await fetch(`${active.url}/api/settings/connections`, { tls: active.tls, method: "PUT",
      headers: { cookie, origin: active.url, "content-type": "application/json" },
      body: JSON.stringify({ outside: { provider: "tailscale", url: "https://owned-host.example.ts.net" } }) })).status, 200);
    await current!.stop();
    assert.equal(current!.child.exitCode, 0);
    await assert.rejects(stat(join(data, "local-connection.json")));
    const previous = active;
    active = await start();
    assert.equal(active.ca, previous.ca);
    assert.equal(active.tls.ca, previous.tls.ca);
    assert.equal((await (await fetch(`${active.url}/api/session`, { tls: active.tls, headers: { cookie } })).json() as { paired: boolean }).paired, true);
    const settings = await (await fetch(`${active.url}/api/settings/connections`, { tls: active.tls, headers: { cookie } })).json() as { outside: unknown };
    assert.deepEqual(settings.outside, { provider: "tailscale", url: "https://owned-host.example.ts.net" });
  });
  await check("Cross-origin writes and revoked pairing cannot access the Host", async () => {
    assert.equal((await fetch(`${active.url}/api/settings/connections`, { tls: active.tls, method: "PUT",
      headers: { cookie, origin: "https://foreign.example", "content-type": "application/json" }, body: JSON.stringify({ outside: null }) })).status, 403);
    await execute("revoke", device);
    let status = 200;
    const deadline = Date.now() + 3000;
    while (status === 200 && Date.now() < deadline) {
      status = (await fetch(`${active.url}/api/settings/connections`, { tls: active.tls, headers: { cookie } })).status;
      if (status === 200) await Bun.sleep(100);
    }
    assert.equal(status, 401, "The existing device-file watcher must propagate CLI revocation within the bounded window");
  });
  await check("Incomplete TLS identity fails visibly without rotating the private CA", async () => {
    await current!.stop();
    const certificate = join(data, "connection-tls/server.crt");
    await rename(certificate, `${certificate}.saved`);
    const child = command("serve", "--port", "0", "--local-network", address!);
    const [, error] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    assert.notEqual(await child.exited, 0);
    assert(error.includes("incomplete"));
    assert.equal(await readFile(join(data, "connection-tls/ca.crt"), "utf8"), active.tls.ca);
  });
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
} finally {
  for (const owned of processes.reverse()) await owned.stop();
  await rm(work, { recursive: true, force: true });
  await writeFile(join(out, "report.json"), JSON.stringify({ address, checks: results, failure: failure || null, cleanup: true }, null, 2) + "\n", { mode: 0o600 });
}
if (failure) throw new Error(failure);

import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ROOT } from "../../../../lib.ts";

const packs = join(ROOT, "apps/linux/packs");
const names = readdirSync(packs).filter(name => existsSync(join(packs, name, "pack.json")));
const data = mkdtempSync(join(tmpdir(), "openox-packs-"));
const packData = join(data, "packs");
const hostData = join(data, "host");
const docker = join(data, "bin");
afterAll(() => rmSync(data, { recursive: true, force: true }));

mkdirSync(docker, { recursive: true });
writeFileSync(join(docker, "docker"), "#!/bin/sh\ncase \"$1\" in inspect) case \"$3\" in *Running*) echo true ;; *) echo running ;; esac ;; esac\n");
chmodSync(join(docker, "docker"), 0o755);

async function pack(env: Record<string, string>, ...args: string[]) {
  const child = Bun.spawn(["bash", join(packs, "pack.sh"), ...args], { stdout: "pipe", stderr: "pipe", env: { ...Bun.env, OPENOX_PACKS_DIR: packData, ...env } });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, stdout, stderr };
}

async function hostCommand(...args: string[]) {
  const child = Bun.spawn([process.execPath, `${ROOT}/apps/linux/src/main.ts`, ...args, "--data", hostData], { stdout: "pipe", stderr: "pipe" });
  const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  expect(code).toBe(0);
  return stdout;
}

async function startHost() {
  const child = Bun.spawn([process.execPath, `${ROOT}/apps/linux/src/main.ts`, "serve", "--data", hostData, "--port", "0", "--name", "fixture"],
    { stdout: "pipe", stderr: "pipe", env: { ...Bun.env, OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "" } });
  const reader = child.stdout.getReader();
  let output = "";
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    output += new TextDecoder().decode(value);
    const match = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(output);
    if (match) {
      void (async () => { while (!(await reader.read()).done); })().catch(() => {});
      void new Response(child.stderr).text().catch(() => "");
      return { process: child, port: Number(match[1]) };
    }
  }
  child.kill();
  throw new Error(`Host did not start: ${output}${await new Response(child.stderr).text()}`);
}

test("Every model pack pins its engine image and model revision and leaves serving flags to pack.sh", () => {
  expect(names.length).toBeGreaterThan(0);
  for (const name of names) {
    const manifest = JSON.parse(readFileSync(join(packs, name, "pack.json"), "utf8"));
    expect(typeof manifest.name).toBe("string");
    expect(manifest.engine.image).toMatch(/^[\w./-]+:[\w.-]+$/);
    expect(manifest.engine.image.endsWith(":latest")).toBe(false);
    expect(manifest.engine.args.join(" ")).not.toMatch(/--(port|host|served-model-name)\b/);
    for (const arg of manifest.engine.args) expect(arg).not.toMatch(/\s/);
    expect(manifest.model.repo).toMatch(/^[\w.-]+\/[\w.-]+$/);
    expect(manifest.model.revision).toMatch(/^[0-9a-f]{40}$/);
    expect(typeof manifest.model.id).toBe("string");
    expect(typeof manifest.model.images).toBe("boolean");
    for (const key of ["memoryGiB", "freeMemoryGiB", "diskGiB"]) expect(manifest.fits[key]).toBeGreaterThan(0);
    expect(typeof manifest.tested).toBe("string");
  }
});

test("pack.sh says whether this machine fits each pack and refuses unknown packs", async () => {
  const help = await pack({}, "--help");
  expect(help.code).toBe(0);
  expect(help.stdout).toContain("install <pack>");
  const unknown = await pack({}, "install", "nothing");
  expect(unknown.code).toBe(2);
  expect(unknown.stderr).toContain("Unknown pack nothing");
  const list = await pack({}, "list");
  expect(list.code).toBe(0);
  for (const name of names) expect(list.stdout).toMatch(new RegExp(`^${name.replace(/[.]/g, "\\.")}  (fits|does not fit)  `, "m"));
  if (!Bun.which("nvidia-smi")) {
    const check = await pack({}, "check", "spark-qwen3.6-35b");
    expect(check.code).toBe(1);
    expect(check.stdout).toMatch(/GPU\s+none\s+needs GB10\s+does not fit/);
    const recommend = await pack({}, "recommend");
    expect(recommend.code).toBe(1);
    expect(recommend.stdout).toContain("pair a computer that runs models");
  }
}, 30_000);

test("pack.sh start adds its model to the Host once and repairs a stale machine at its address", async () => {
  const engine = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: request => new URL(request.url).pathname === "/health" ? new Response("ok")
    : Response.json({ object: "list", data: [{ id: "Qwen3.6-35B", object: "model", max_model_len: 131072 }] }) });
  const host = await startHost();
  try {
    mkdirSync(join(packData, "spark-qwen3.6-35b"), { recursive: true });
    writeFileSync(join(packData, "spark-qwen3.6-35b", "settings"), `port=${engine.port}\nweights=${join(packData, "spark-qwen3.6-35b", "weights")}\n`);
    const env = { PATH: `${docker}:${dirname(process.execPath)}:${Bun.env.PATH}`, OPENOX_HOST_DATA: hostData, OPENOX_HOST_PORT: String(host.port) };
    const token = /OX_HOST_TOKEN=(\S+)/.exec(await hostCommand("token", "--name", "packs-test"))![1]!;
    const api = (path: string, init: RequestInit = {}) => fetch(`http://127.0.0.1:${host.port}/api/settings${path}`,
      { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } });
    const settings = async () => await (await api("")).json() as { machines: { id: string; baseUrl: string; models: string[]; images: boolean; name: string | null }[]; defaultModel: unknown };
    const address = `http://127.0.0.1:${engine.port}/v1`;

    const first = await pack(env, "start", "spark-qwen3.6-35b");
    expect(first.code).toBe(0);
    expect(first.stdout).toContain("is now the Host's default model");
    expect((await settings()).machines).toMatchObject([{ id: "custom", baseUrl: address, models: ["Qwen3.6-35B"], images: true }]);
    expect((await settings()).defaultModel).toEqual({ provider: "custom", modelId: "Qwen3.6-35B" });

    const again = await pack(env, "start", "spark-qwen3.6-35b");
    expect(again.stdout).toContain("already uses Qwen3.6-35B");
    expect((await settings()).machines.length).toBe(1);

    expect((await api("/providers/custom", { method: "PUT", body: JSON.stringify({ baseUrl: address, models: ["Old-Model"], name: "Desk" }) })).ok).toBe(true);
    expect((await api("/default-model", { method: "PUT", body: JSON.stringify({ provider: "custom", modelId: "Old-Model" }) })).ok).toBe(true);
    const repaired = await pack(env, "start", "spark-qwen3.6-35b");
    expect(repaired.stdout).toContain("now uses Qwen3.6-35B");
    expect((await settings()).machines).toMatchObject([{ id: "custom", baseUrl: address, models: ["Qwen3.6-35B"], images: true, name: "Desk" }]);
    expect((await settings()).defaultModel).toEqual({ provider: "custom", modelId: "Qwen3.6-35B" });
    expect(await hostCommand("devices")).not.toContain("Pack installer");
  } finally {
    host.process.kill();
    await engine.stop(true);
  }
}, 60_000);

test("pack.sh remove --purge deletes the weights it downloaded, even after a plain remove, and keeps weights it did not", async () => {
  const env = { PATH: `${docker}:${Bun.env.PATH}` };
  const owned = join(packData, "spark-qwen3.6-35b", "weights");
  mkdirSync(owned, { recursive: true });
  writeFileSync(join(owned, "config.json"), "{}");
  writeFileSync(join(packData, "spark-qwen3.6-35b", "settings"), `port=8000\nweights=${owned}\n`);
  expect((await pack(env, "remove", "spark-qwen3.6-35b", "--yes")).code).toBe(0);
  expect(existsSync(join(owned, "config.json"))).toBe(true);
  expect((await pack(env, "remove", "spark-qwen3.6-35b", "--purge", "--yes")).code).toBe(0);
  expect(existsSync(join(packData, "spark-qwen3.6-35b"))).toBe(false);

  const external = join(data, "external");
  mkdirSync(external, { recursive: true });
  writeFileSync(join(external, "config.json"), "{}");
  mkdirSync(join(packData, "spark-qwen3.6-35b"), { recursive: true });
  writeFileSync(join(packData, "spark-qwen3.6-35b", "settings"), `port=8000\nweights=${external}\n`);
  const kept = await pack(env, "remove", "spark-qwen3.6-35b", "--purge", "--yes");
  expect(kept.stdout).toContain(`Kept ${external}`);
  expect(existsSync(join(external, "config.json"))).toBe(true);
}, 30_000);

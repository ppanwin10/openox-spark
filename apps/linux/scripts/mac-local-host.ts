import { mkdir, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { writeJSON } from "../src/config";
import { consoleLink, startHostConsole } from "./mac-host-console";
import { MacHostRuntime, readMacIdentity, validateMacIdentity } from "./mac-host-runtime";

process.umask(0o077);
process.env.OPENOX_MEDIA_URL = "http://127.0.0.1:9";
const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  data: { type: "string" }, identity: { type: "string" }, "no-open": { type: "boolean" },
} });
const command = positionals[0] ?? "console";
if (!["console", "start", "pair", "stop"].includes(command) || positionals.length > 1) throw new Error("Use console, start, pair or stop");
if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("This engineering bundle supports Apple Silicon Macs only");
const data = resolve(values.data ?? join(homedir(), "Library/Application Support/OpenOx Mac LAN Test"));
const identity = resolve(values.identity ?? join(data, "identity"));
const lock = join(data, "run.json"), script = resolve(import.meta.path);
type Running = { pid: number; birth: string; script: string; data: string; nonce: string; origin: string; control?: { url: string; socket: string } };
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
    throw new Error("The runtime record belongs to another bundle or is invalid. Stop an older running bundle with its own Stop.command before upgrading");
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
async function showConsole(link: { url: string; expiresAt: string }) {
  const escape = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
  const page = join(data, "Host console.html");
  await writeFile(page, `<!doctype html><html lang="zh-Hans"><meta charset="utf-8"><meta name="referrer" content="no-referrer">
<meta http-equiv="refresh" content="0;url=${escape(link.url)}"><title>打开本机 Host 管理台</title>
<p><a href="${escape(link.url)}" rel="noreferrer">打开本机 Host 管理台</a></p>
<p>本机授权链接短时有效。过期后请重新运行 Open Console.command；不需要注册账号。</p></html>`,
  { mode: 0o600 });
  console.log(`Host console: ${page}\nLocal console: ${link.url.split("#")[0]}\nDefault replies use the scripted connection-test model.`);
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
} else if (command === "pair" || await stat(lock).then(() => true, error => {
  if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
  throw error;
})) {
  const state = await running();
  if (!state?.alive) throw new Error("The test Host is stopped. Run Start.command first");
  if (!state.value.control) throw new Error("This Host uses an older console. Stop it with the original bundle before upgrading");
  await showConsole(await consoleLink(state.value.control.socket, state.value.control.url, command === "pair" ? "pair" : command === "start" ? "start" : "open"));
} else {
  const { prepared: config } = await (command === "start" ? validateMacIdentity(identity) : readMacIdentity(identity));
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
  let runtime: MacHostRuntime | undefined;
  let control: Awaited<ReturnType<typeof startHostConsole>> | undefined;
  const finished = Promise.withResolvers<void>();
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  const stop = () => finished.resolve();
  for (const signal of signals) process.on(signal, stop);
  try {
    runtime = await MacHostRuntime.open(data, identity);
    if (runtime.origin !== origin) throw new Error("The prepared connection changed during launch; reopen the console.");
    control = await startHostConsole(runtime, origin, runtime.certificateExpires);
    await writeJSON(lock, { pid: process.pid, birth: ownBirth, script, data, nonce, origin,
      control: { url: control.url, socket: control.socket } } satisfies Running);
    if (command === "start") await runtime.start();
    console.log(`${runtime.lifecycle.state().kind === "running" ? `Mac LAN test Host ready: ${origin}` : "Local console manager ready. Host is stopped."}\nData stays at: ${data}\nNo Spark, MyGPT, outside route or real model is used.`);
    await showConsole(control.link());
    await finished.promise;
  } finally {
    for (const signal of signals) process.removeListener(signal, stop);
    const failures: unknown[] = [];
    for (const close of [() => control?.close(), () => runtime?.close()]) {
      try { await close(); }
      catch (error) { failures.push(error); console.error("Owned test runtime cleanup failed", error); }
    }
    if (failures.length) throw new AggregateError(failures, "The owned test runtime did not finish closing; its ownership record was retained");
    await closeLock(nonce); await rm(join(data, "Host console.html"), { force: true });
  }
}

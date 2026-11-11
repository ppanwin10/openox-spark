import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { chromium, webkit, type Browser, type Page } from "playwright-core";

process.umask(0o077);
const root = resolve(import.meta.dir, "../../..");
const { values } = parseArgs({ options: { archive: { type: "string" }, out: { type: "string" } } });
assert(values.archive && values.out, "Use --archive <zip> --out <outside-checkout-directory>");
const out = resolve(values.out), inside = relative(root, out);
assert(inside && (inside.startsWith(`..${sep}`) || isAbsolute(inside)), "Keep evidence outside the checkout");
await mkdir(out, { recursive: true, mode: 0o700 });
const work = await mkdtemp(join(out, "private-run-"));
const bundle = join(work, "OpenOx-Mac-LAN-Test-arm64"), data = join(work, "host-data");
const identity = join(homedir(), "Library/Application Support/OpenOx Mac LAN Test/identity");
const checks: string[] = [], errors: string[] = [];
let browser: Browser | undefined, safari: Browser | undefined, activePage: Page | undefined, failure = "", active: ReturnType<typeof launch> | undefined;
const environment = { HOME: homedir(), PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "en_US.UTF-8", TMPDIR: tmpdir(), NODE_PATH: "" };
async function execute(args: string[], allowFailure = false) {
  const child = Bun.spawn(args, { cwd: work, env: environment, stdout: "pipe", stderr: "pipe" });
  const [code, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (!allowFailure) assert.equal(code, 0, `${args[0]} failed: ${error}`);
  return { code, output, error };
}
function launch(directory = data, prepared = identity) {
  const child = Bun.spawn([join(bundle, "bin/bun"), "--no-env-file", join(bundle, "runtime/apps/linux/scripts/mac-local-host.ts"),
    "start", "--data", directory, "--identity", prepared, "--no-open"],
  { cwd: bundle, env: environment, stdout: "pipe", stderr: "pipe" });
  let output = "";
  const drain = async (stream: ReadableStream<Uint8Array>) => {
    const reader = stream.getReader(), decoder = new TextDecoder();
    try { for (;;) { const { value, done } = await reader.read(); if (done) return; output += decoder.decode(value); } }
    finally { reader.releaseLock(); }
  };
  const drained = Promise.all([drain(child.stdout), drain(child.stderr)]);
  return { child, output: () => output, drained };
}
async function until(condition: () => boolean | Promise<boolean>, label: string) {
  const deadline = Date.now() + 20000;
  while (!await condition()) {
    if (Date.now() > deadline) throw new Error(`${label} timed out`);
    await Bun.sleep(50);
  }
}
async function start() {
  active = launch();
  await until(() => {
    if (active!.child.exitCode !== null) throw new Error(active!.output());
    return active!.output().includes("Phone invitation:");
  }, "Unpacked Host readiness");
}
async function stop() {
  if (!active) return;
  const result = await execute([join(bundle, "bin/bun"), "--no-env-file", join(bundle, "runtime/apps/linux/scripts/mac-local-host.ts"), "stop", "--data", data]);
  assert(result.output.includes("Data and identity are preserved"));
  await active.child.exited;
  await active.drained;
  assert.equal(active.child.exitCode, 0, active.output());
  active = undefined;
  const repeated = await execute([join(bundle, "bin/bun"), "--no-env-file", join(bundle, "runtime/apps/linux/scripts/mac-local-host.ts"), "stop", "--data", data]);
  assert(repeated.output.includes("No Mac test Host is running"));
}
async function invite() {
  const html = await readFile(join(data, "Connect phone.html"), "utf8");
  const url = /href="(https:[^"]+)"/.exec(html)?.[1];
  assert(url);
  assert.equal(new URL(url).search, "");
  assert(new URL(url).hash.startsWith("#/pair/"));
  return url;
}
async function check(name: string, operation: () => Promise<void>) {
  await operation(); checks.push(name); console.log(`PASS ${name}`);
}
async function screenshot(page: Page, name: string) {
  await page.screenshot({ path: join(out, `${name}.png`), animations: "disabled" });
}
try {
  await execute(["/usr/bin/ditto", "-x", "-k", resolve(values.archive), work]);
  const build = JSON.parse(await readFile(join(bundle, "BUILD.json"), "utf8"));
  assert.equal(build.bundledIdentityOrCredentials, false);
  const config = JSON.parse(await readFile(join(identity, "host.json"), "utf8")) as { hostname: string; address: string; port: number };
  const origin = `https://${config.hostname}:${config.port}`;
  await check("Unpacked runtime starts with no global Bun, NODE_PATH or source-checkout dependency", async () => {
    await start();
    assert.equal((await fetch(`${origin}/api/health`)).status, 200);
    assert.equal((await fetch(`${origin}/api/settings`)).status, 401);
    assert.equal((await stat(join(data, "run.json"))).mode & 0o777, 0o600);
    const duplicate = launch();
    await duplicate.child.exited; await duplicate.drained;
    assert.notEqual(duplicate.child.exitCode, 0);
    assert(duplicate.output().includes("runtime record already exists"));
  });
  browser = await chromium.launch({ channel: "chrome", headless: true, env: environment });
  const desktop = await browser.newContext({ viewport: { width: 1365, height: 900 }, locale: "zh-CN" });
  await desktop.addInitScript(() => { localStorage.setItem("ox.language", "zh-Hans"); localStorage.setItem("ox.memoryIntent", "3"); });
  const page = await desktop.newPage();
  activePage = page;
  page.on("pageerror", error => errors.push(error.message));
  let conversation = "";
  await check("Fresh QR, actual trusted HTTPS pairing, scripted reply and Host attachment storage", async () => {
    await page.goto(pathToFileURL(join(data, "Connect phone.html")).href);
    await screenshot(page, "desktop-invitation");
    const invitation = await invite();
    const code = new URL(invitation).hash.split("/").at(-1)!;
    await page.goto(invitation);
    assert.equal(await page.getByTestId("pair-code").inputValue(), code);
    await page.getByTestId("pair-name").fill("Mac package desktop check");
    await page.getByTestId("pair-submit").click();
    await page.getByTestId("onboarding-start").click();
    await page.getByTestId("composer-input").fill("验证这台 Mac 的连接");
    await page.getByTestId("send").click();
    await page.getByText("【连接测试回复，不是 AI 推理】这台 Mac 已收到请求。对话保存在 Mac 的测试工作区。", { exact: false }).first().waitFor();
    conversation = page.url();
    assert((await page.getByTestId("workspace-context").innerText()).includes("Mac LAN Test Host"));
    await screenshot(page, "desktop-scripted-reply");
    const upload = page.waitForResponse(response => response.url().includes("/attachments?name=lan-proof.txt") && response.request().method() === "POST");
    await page.getByTestId("composer-input").evaluate(element => {
      const transfer = new DataTransfer(); transfer.items.add(new File(["Owned archive acceptance file"], "lan-proof.txt", { type: "text/plain" }));
      element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, clipboardData: transfer }));
    });
    assert((await upload).ok());
    await page.getByTestId("attachment-chip").waitFor();
    const replay = await page.request.post(`${origin}/api/pair`, { headers: { origin }, data: { code, name: "Rejected replay" } });
    assert.equal(replay.status(), 403);
    await page.getByTestId("workspace-context").click();
    await page.getByTestId("connection-local").getByText(origin, { exact: true }).waitFor();
    await page.getByTestId("connection-pair").click();
    const qr = page.getByTestId("pairing-qr");
    const link = new URL((await qr.getAttribute("data-link"))!);
    assert.equal(link.origin, origin);
    assert(!link.hash.includes("ca="));
    await page.locator("dialog[open]").last().getByTestId("dialog-confirm").click();
    await screenshot(page, "desktop-connections");
  });
  await check("Explicit stop preserves files, identity and browser pairing across restart", async () => {
    await stop();
    await assert.rejects(stat(join(data, "run.json")));
    const profile = JSON.parse(await readFile(join(data, "host.json"), "utf8")).profile;
    async function find(directory: string): Promise<boolean> {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) { if (await find(path)) return true; }
        else if (entry.name === "lan-proof.txt" && (await readFile(path, "utf8")) === "Owned archive acceptance file") return true;
      }
      return false;
    }
    assert(await find(join(data, "profiles", profile.id)));
    await start();
    await page.goto(conversation);
    await page.getByText("【连接测试回复，不是 AI 推理】这台 Mac 已收到请求。对话保存在 Mac 的测试工作区。", { exact: false }).first().waitFor();
    assert.equal(await page.getByTestId("pair-submit").count(), 0);
  });
  await check("Separate phone-layout browser pairs independently using normal certificate trust", async () => {
    await execute([join(bundle, "bin/bun"), "--no-env-file", join(bundle, "runtime/apps/linux/scripts/mac-local-host.ts"),
      "pair", "--data", data, "--no-open"]);
    const context = await browser!.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: "zh-CN", colorScheme: "dark" });
    await context.addInitScript(() => { localStorage.setItem("ox.language", "zh-Hans"); });
    const phone = await context.newPage(); phone.on("pageerror", error => errors.push(error.message));
    activePage = phone;
    await phone.goto(await invite());
    await phone.getByTestId("pair-submit").click();
    await phone.getByTestId("onboarding-start").click();
    await phone.goto(conversation);
    await phone.getByText("【连接测试回复，不是 AI 推理】这台 Mac 已收到请求。对话保存在 Mac 的测试工作区。", { exact: false }).first().waitFor();
    await screenshot(phone, "phone-existing-workspace");
    await phone.getByTestId("workspace-context").click();
    await phone.getByTestId("connection-processing").waitFor();
    await screenshot(phone, "phone-connections");
    assert(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await context.close();
  });
  await check("WebKit phone-layout client pairs and sends through normal trusted HTTPS", async () => {
    await execute([join(bundle, "bin/bun"), "--no-env-file", join(bundle, "runtime/apps/linux/scripts/mac-local-host.ts"),
      "pair", "--data", data, "--no-open"]);
    safari = await webkit.launch({ headless: true, env: environment });
    const context = await safari.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: "zh-CN", colorScheme: "dark" });
    await context.addInitScript(() => { localStorage.setItem("ox.language", "zh-Hans"); });
    const tab = await context.newPage(); activePage = tab;
    tab.on("pageerror", error => errors.push(error.message));
    await tab.goto(await invite());
    await tab.getByTestId("pair-submit").click();
    await tab.getByTestId("onboarding-start").click();
    await tab.goto(conversation);
    await tab.getByTestId("composer-input").fill("WebKit 连接验收");
    await tab.getByTestId("send").click();
    await until(async () => await tab.getByText("【连接测试回复，不是 AI 推理】这台 Mac 已收到请求。对话保存在 Mac 的测试工作区。", { exact: false }).count() === 2,
      "WebKit scripted follow-up reply");
    await screenshot(tab, "webkit-phone-workspace");
    await context.close();
    await safari.close(); safari = undefined;
  });
  await desktop.close();
  await stop();
  await check("Wrong identity/interface fails before listener/data creation and an unrelated process is never stopped", async () => {
    const wrong = join(work, "wrong-identity");
    await mkdir(wrong, { mode: 0o700 });
    await copyFile(join(identity, "fullchain.pem"), join(wrong, "fullchain.pem"));
    await copyFile(join(identity, "server.key"), join(wrong, "server.key"));
    await writeFile(join(wrong, "host.json"), JSON.stringify({ ...config, hostname: "wrong.example.invalid" }), { mode: 0o600 });
    const directory = join(work, "refused-data");
    const refused = launch(directory, wrong);
    await refused.child.exited; await refused.drained;
    assert.notEqual(refused.child.exitCode, 0);
    assert(refused.output().includes("identity is expired, mismatched or invalid"));
    await assert.rejects(stat(join(directory, "run.json")));
    await writeFile(join(wrong, "host.json"), JSON.stringify({ ...config, address: "0.0.0.0" }), { mode: 0o600 });
    const unsafe = launch(directory, wrong);
    await unsafe.child.exited; await unsafe.drained;
    assert.notEqual(unsafe.child.exitCode, 0);
    assert(unsafe.output().includes("assigned private IPv4 address"));
    await assert.rejects(stat(join(directory, "run.json")));
    const sleeper = Bun.spawn([join(bundle, "bin/bun"), "--no-env-file", "-e", "setInterval(()=>{},1000)"], { env: environment, stdout: "ignore", stderr: "ignore" });
    try {
      await mkdir(directory, { mode: 0o700 });
      await writeFile(join(directory, "run.json"), JSON.stringify({ pid: sleeper.pid, birth: "does not match the owned process",
        nonce: "owned-test-record", data: directory, script: join(bundle, "runtime/apps/linux/scripts/mac-local-host.ts"), origin }), { mode: 0o600 });
      const guarded = await execute([join(bundle, "bin/bun"), "--no-env-file", join(bundle, "runtime/apps/linux/scripts/mac-local-host.ts"),
        "stop", "--data", directory], true);
      assert.notEqual(guarded.code, 0);
      assert(guarded.error.includes("PID belongs to another process"));
      assert.equal(sleeper.exitCode, null);
      const actualBirth = (await execute(["/bin/ps", "-p", String(sleeper.pid), "-o", "lstart="])).output.trim();
      const record = JSON.parse(await readFile(join(directory, "run.json"), "utf8"));
      await writeFile(join(directory, "run.json"), JSON.stringify({ ...record, birth: actualBirth }), { mode: 0o600 });
      const wrongCommand = await execute([join(bundle, "bin/bun"), "--no-env-file", join(bundle, "runtime/apps/linux/scripts/mac-local-host.ts"),
        "stop", "--data", directory], true);
      assert.notEqual(wrongCommand.code, 0);
      assert(wrongCommand.error.includes("process command does not match"));
      assert.equal(sleeper.exitCode, null);
    } finally { sleeper.kill("SIGTERM"); await sleeper.exited; }
  });
  assert.deepEqual(errors, []);
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
  if (activePage && !activePage.isClosed()) await screenshot(activePage, "failure");
} finally {
  await safari?.close();
  await browser?.close();
  if (active) {
    if (active.child.exitCode === null) active.child.kill("SIGTERM");
    await active.child.exited; await active.drained;
  }
  await rm(work, { recursive: true, force: true });
  await writeFile(join(out, "report.json"), JSON.stringify({ checks, errors, failure: failure || null, normalTLS: true,
    noGlobalRuntimeOrSourceCheckoutDependency: true, privateFixtureRemoved: true,
    phone: "Chrome and macOS WebKit phone emulation; physical iPhone Safari acceptance remains owner-assisted" }, null, 2), { mode: 0o600 });
}
if (failure) throw new Error(failure);

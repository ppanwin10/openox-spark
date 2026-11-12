import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { createServer } from "node:net";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { Browser, Page } from "../../../../../../apps/linux/node_modules/playwright-core";
import type { ConsoleState } from "../../../../../../apps/linux/scripts/mac-host-console";
import { checkNativeSafari } from "./native-safari";
import { checkConnectionRecovery } from "./connection-browser";
import { checkWorkspacePages } from "./workspace-pages";

process.umask(0o077);
const root = resolve(import.meta.dir, "../../../../../..");
const { chromium, webkit } = await import(Bun.resolveSync("playwright-core", join(root, "apps/linux"))) as typeof import("../../../../../../apps/linux/node_modules/playwright-core");
const { values } = parseArgs({ options: { archive: { type: "string" }, out: { type: "string" }, "webkit-touch": { type: "boolean", default: false },
  "safari-driver": { type: "string" }, "workspace-pages": { type: "boolean", default: false } } });
assert(values.archive && values.out, "Use --archive <zip> --out <outside-checkout-directory>");
const out = resolve(values.out), inside = relative(root, out);
assert(inside && (inside.startsWith(`..${sep}`) || isAbsolute(inside)), "Keep evidence outside the checkout");
await mkdir(out, { recursive: true, mode: 0o700 });
const work = await mkdtemp(join(out, "private-run-"));
const bundle = join(work, "OpenOx-Mac-LAN-Test-arm64"), data = join(work, "host-data");
const sourceIdentity = join(homedir(), "Library/Application Support/OpenOx Mac LAN Test/identity"), identity = join(work, "identity");
const checks: string[] = [], errors: string[] = [];
const renderedQrs: { image: string; payloadSHA256: string }[] = [];
const screenshotPolicies = new WeakMap<Page, string[]>();
const screenshotDiagnostics: { image: string; source: string }[] = [];
const webkitScreenshotPolicy = "Refused to apply a stylesheet because its hash, its nonce, or 'unsafe-inline' does not appear in the style-src directive of the Content Security Policy.";
let browser: Browser | undefined, safari: Browser | undefined, activePage: Page | undefined, failure = "", active: ReturnType<typeof launch> | undefined;
let operator: Page, controlBase = "";
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
    return active!.output().includes("Host console:");
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
async function consoleEntry() {
  const html = await readFile(join(data, "Host console.html"), "utf8");
  const raw = /href="(http:[^"]+)"/.exec(html)?.[1];
  assert(raw);
  const url = raw.replaceAll("&amp;", "&");
  assert.equal(new URL(url).hostname, "127.0.0.1");
  assert.equal(new URL(url).search, "");
  return url;
}
async function invite(fromCommand = false, capture?: string) {
  const previous = activePage;
  activePage = operator;
  if (fromCommand) {
    const entry = await consoleEntry();
    assert.equal(new URLSearchParams(new URL(entry).hash.slice(1)).get("panel"), "pair");
    await operator.goto(entry);
  } else await operator.getByTestId("console-add").click();
  const qr = operator.getByTestId("console-pairing-qr");
  await qr.waitFor();
  const url = await qr.getAttribute("data-link");
  assert(url);
  assert.equal(new URL(url).search, "");
  assert(new URL(url).hash.startsWith("#/pair/"));
  if (capture) await screenshot(operator, capture);
  await operator.getByTestId("console-pair-close").click();
  activePage = previous;
  return url;
}
async function controlState() {
  const response = await operator.request.get(`${controlBase}api/state`);
  assert.equal(response.status(), 200);
  return response.json() as Promise<ConsoleState>;
}
async function check(name: string, operation: () => Promise<void>) {
  await operation(); checks.push(name); console.log(`PASS ${name}`);
}
async function screenshot(page: Page, name: string, qr = false) {
  const policies: string[] = [];
  screenshotPolicies.set(page, policies);
  try {
    await (qr ? page.getByTestId("console-pairing-qr") : page).screenshot({ path: join(out, `${name}.png`), animations: "disabled" });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  } finally { screenshotPolicies.delete(page); }
  if (policies.length) {
    assert.deepEqual(policies, [webkitScreenshotPolicy]);
    screenshotDiagnostics.push({ image: `${name}.png`, source: "Playwright 1.65 WebKit screenshot animation synchronization injects body {}; strict CSP correctly rejects it" });
  }
}
async function qrScreenshot(page: Page, name: string, value: string) {
  const image = `${name}.png`;
  const visible = await page.getByTestId("console-pairing-qr").evaluate(element => {
    const body = element.closest(".sheet-body");
    if (!body) return false;
    const qr = element.getBoundingClientRect(), clip = body.getBoundingClientRect();
    return qr.width > 0 && qr.height > 0 && qr.top >= clip.top - 1 && qr.bottom <= clip.bottom + 1
      && qr.left >= clip.left - 1 && qr.right <= clip.right + 1 && qr.top >= 0 && qr.bottom <= innerHeight;
  });
  assert(visible, "The complete QR must be visible inside its scroll region and viewport, not merely present in the DOM");
  await screenshot(page, name, true);
  renderedQrs.push({ image, payloadSHA256: new Bun.CryptoHasher("sha256").update(value).digest("hex") });
}
try {
  await execute(["/usr/bin/ditto", "-x", "-k", resolve(values.archive), work]);
  const build = JSON.parse(await readFile(join(bundle, "BUILD.json"), "utf8"));
  assert.equal(build.bundledIdentityOrCredentials, false);
  const prepared = JSON.parse(await readFile(join(sourceIdentity, "host.json"), "utf8")) as { hostname: string; address: string; port: number };
  const reservation = createServer();
  await new Promise<void>(resolve => reservation.listen(0, prepared.address, resolve));
  const address = reservation.address();
  assert(address && typeof address !== "string");
  const config = { ...prepared, port: address.port };
  await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
  await mkdir(identity, { mode: 0o700 });
  for (const file of ["fullchain.pem", "server.key"]) await copyFile(join(sourceIdentity, file), join(identity, file));
  await writeFile(join(identity, "host.json"), JSON.stringify(config), { mode: 0o600 });
  const origin = `https://${config.hostname}:${config.port}`;
  await check("Unpacked runtime starts with no global Bun, NODE_PATH or source-checkout dependency", async () => {
    await start();
    assert.equal((await fetch(`${origin}/api/health`)).status, 200);
    assert.equal((await fetch(`${origin}/api/settings`)).status, 401);
    assert.equal((await stat(join(data, "run.json"))).mode & 0o777, 0o600);
    const before = JSON.parse(await readFile(join(data, "run.json"), "utf8"));
    const duplicate = launch();
    await duplicate.child.exited; await duplicate.drained;
    assert.equal(duplicate.child.exitCode, 0);
    const after = JSON.parse(await readFile(join(data, "run.json"), "utf8"));
    assert.equal(after.pid, before.pid);
    controlBase = after.control.url;
    assert.equal((await stat(after.control.socket)).mode & 0o777, 0o600);
  });
  browser = await chromium.launch({ channel: "chrome", headless: true, env: environment });
  const desktop = await browser.newContext({ viewport: { width: 1365, height: 900 }, locale: "zh-CN" });
  await desktop.addInitScript(() => {
    if (!["http:", "https:"].includes(location.protocol)) return;
    localStorage.setItem("ox.language", "zh-Hans"); localStorage.setItem("ox.memoryIntent", "3");
  });
  operator = await desktop.newPage();
  operator.on("pageerror", error => errors.push(error.message));
  activePage = operator;
  const claimedEntry = await consoleEntry();
  await operator.goto(pathToFileURL(join(data, "Host console.html")).href);
  await operator.getByTestId("console-add").waitFor();
  await screenshot(operator, "desktop-console-empty");
  await check("Loopback console authorization, one-use bootstrap and mutation origin/CSRF boundaries", async () => {
    assert.equal((await fetch(`${controlBase}api/state`)).status, 401);
    const local = new URL(controlBase);
    await assert.rejects(fetch(`http://${config.address}:${local.port}${local.pathname}api/state`, { signal: AbortSignal.timeout(2000) }));
    assert.equal((await operator.request.get(`${controlBase}api/state`, { headers: { origin: "https://foreign.example" } })).status(), 403);
    assert.equal((await operator.request.get(`${controlBase}api/state`, { headers: { host: "rebinding.example" } })).status(), 403);
    const origin = new URL(controlBase).origin;
    const claim = new URLSearchParams(new URL(claimedEntry).hash.slice(1)).get("claim");
    assert.equal((await operator.request.post(`${controlBase}api/claim`, { headers: { origin }, data: { claim } })).status(), 401);
    assert.equal((await operator.request.post(`${controlBase}api/pairing`, { headers: { origin }, data: {} })).status(), 403);
    const cookies = await desktop.cookies(controlBase);
    assert(cookies.some(cookie => cookie.name.startsWith("ox_control_") && cookie.httpOnly && cookie.sameSite === "Strict"));
    const state = await controlState();
    assert.equal(state.devices.length, 0);
    assert(!JSON.stringify(state).includes("tokenHash"));
    assert.equal(await operator.getByTestId("console-empty").count(), 1);
  });
  if (values["safari-driver"]) await check("PA-02/13 actual native Safari shows the full QR and opens the local workspace without re-pairing", async () => {
    const reopen = launch(); await reopen.child.exited; await reopen.drained;
    assert.equal(reopen.child.exitCode, 0);
    await checkNativeSafari({ driver: values["safari-driver"]!, entry: await consoleEntry(), out, workspacePages: values["workspace-pages"] });
  });
  await check(`Active QR regeneration changes the real invitation in desktop Chrome and ${values["webkit-touch"] ? "phone-touch" : "desktop"} WebKit`, async () => {
    const failures: string[] = [];
    for (const kind of ["chrome", "webkit"] as const) {
      const touch = kind === "webkit" && values["webkit-touch"], activate = touch ? "tap" : "click";
      const engine = kind === "chrome" ? browser! : await webkit.launch({ headless: true, env: environment });
      const context = await engine.newContext({ viewport: { width: touch ? 390 : 1365, height: touch ? 844 : 900 },
        isMobile: touch, hasTouch: touch, locale: "en-US" });
      try {
        const reopen = launch(); await reopen.child.exited; await reopen.drained; assert.equal(reopen.child.exitCode, 0);
        const tab = await context.newPage(); activePage = tab;
        tab.on("pageerror", error => errors.push(error.message));
        tab.on("console", event => {
          if (!/content security policy|violates.*directive/i.test(event.text())) return;
          const capture = screenshotPolicies.get(tab);
          if (kind === "webkit" && event.text() === webkitScreenshotPolicy && capture) capture.push(event.text());
          else errors.push(`${kind} policy violation: ${event.text()}`);
        });
        await tab.goto(await consoleEntry());
        await tab.bringToFront();
        await screenshot(tab, `${kind}-operator-before-pairing`);
        await tab.getByTestId("console-add")[activate]();
        const qr = tab.getByTestId("console-pairing-qr"), regenerate = tab.getByTestId("console-pair-regenerate");
        await qr.waitFor();
        await screenshot(tab, `${kind}-active-qr-before`);
        let previous = await qr.getAttribute("data-link");
        assert(previous);
        await qrScreenshot(tab, `${kind}-scannable-qr-before`, previous);
        for (let attempt = 0; attempt < 2; attempt++) {
          const response = tab.waitForResponse(response => response.url().endsWith("/api/pairing") && response.request().method() === "POST");
          await regenerate[activate]();
          const result = await response;
          assert.equal(result.status(), 200);
          await until(async () => await qr.getAttribute("data-link") !== previous, `${kind} active QR replacement`);
          await until(async () => await regenerate.isEnabled(), `${kind} QR action recovery`);
          previous = await qr.getAttribute("data-link");
        }
        const held = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), delivered = Promise.withResolvers<void>();
        await tab.route("**/api/state", async route => {
          const response = await route.fetch();
          held.resolve(); await release.promise;
          await route.fulfill({ response });
          delivered.resolve();
        }, { times: 1 });
        try {
          await Promise.race([held.promise, Bun.sleep(10000).then(() => { throw new Error("Overlapping state request did not start"); })]);
          const response = tab.waitForResponse(response => response.url().endsWith("/api/pairing") && response.request().method() === "POST");
          await regenerate[activate]();
          const result = await response, replacement = await result.json() as { url?: string };
          assert.equal(result.status(), 200);
          assert(replacement.url && replacement.url !== previous, "The Host must issue a different invitation");
          await until(async () => await regenerate.isEnabled(), `${kind} overlapping QR action completed`);
          await screenshot(tab, `${kind}-overlapping-poll-qr`);
          assert(await qr.getAttribute("data-link") === replacement.url, "A completed generation must show its new QR, not the now-invalid replaced invitation");
          release.resolve();
          await delivered.promise;
          await tab.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
          assert(await qr.getAttribute("data-link") === replacement.url, "An older poll must not restore a replaced QR");
        } finally { release.resolve(); }
        const committed = Promise.withResolvers<void>(), show = Promise.withResolvers<void>();
        await tab.route("**/api/pairing", async route => {
          const response = await route.fetch(); committed.resolve(); await show.promise; await route.fulfill({ response });
        }, { times: 1 });
        try {
          const previous = await qr.getAttribute("data-link");
          await regenerate[activate]();
          await committed.promise;
          assert(await regenerate.isDisabled());
          assert.equal(await qr.count(), 0, "A pending generation must hide the old QR as soon as it might be invalid");
          await screenshot(tab, `${kind}-generating-qr`);
          await tab.getByTestId("console-pair-close")[activate]();
          await tab.bringToFront();
          await tab.getByTestId("console-pair-dialog").waitFor({ state: "detached" });
          await tab.getByTestId("console-add")[activate]({ timeout: 5000 });
          assert.equal(await tab.getByTestId("console-pairing-status").count(), 1, "Reopening an in-flight generation must show its current state, not an empty panel");
          assert(await regenerate.isDisabled());
          assert.equal(await qr.count(), 0);
          await screenshot(tab, `${kind}-reopened-generating-qr`);
          show.resolve();
          await until(async () => await regenerate.isEnabled(), `${kind} visible generation completed`);
          assert(await qr.getAttribute("data-link") !== previous);
        } finally { show.resolve(); }
        await tab.route("**/api/pairing", async route => {
          await route.fetch();
          await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Owned response-loss fixture" }) });
        }, { times: 1 });
        await regenerate[activate]();
        await tab.getByTestId("console-pairing-status").getByText("A new QR could not be confirmed. Do not use the previous code. Try again.", { exact: true }).waitFor();
        assert.equal(await qr.count(), 0, "An unconfirmed mutation must not leave the old QR scannable");
        assert(await regenerate.isEnabled());
        await screenshot(tab, `${kind}-failed-qr`);
        await regenerate[activate]();
        await qr.waitFor();
        await until(async () => await regenerate.isEnabled(), `${kind} failed QR recovery`);
        const replacement = await qr.getAttribute("data-link");
        assert(replacement);
        const prior = new URL(previous!), code = prior.hash.slice("#/pair/".length);
        const refused = await tab.request.post(`${prior.origin}/api/pair`, { headers: { origin: prior.origin }, data: { code, name: "Rejected replaced QR" } });
        assert.equal(refused.status(), 403);
        const shown = await tab.getByTestId("console-pairing-code").innerText();
        assert(shown.includes(new URL(replacement).hash.slice("#/pair/".length)));
        await screenshot(tab, `${kind}-active-qr-after`);
        await qrScreenshot(tab, `${kind}-scannable-qr-after`, replacement);
        const client = await context.newPage();
        await client.goto(replacement);
        await client.getByTestId("pair-name").fill(`Regenerated QR ${kind}`);
        await client.getByTestId("pair-submit")[activate]();
        await client.getByTestId("onboarding-start")[activate]();
        await client.getByTestId("composer-input").waitFor();
        await tab.bringToFront();
        await tab.getByTestId("console-pairing-status").getByText("This invitation was used or replaced. Generate a new QR if needed.", { exact: true }).waitFor();
        assert.equal(await qr.count(), 0);
        await screenshot(tab, `${kind}-consumed-qr`);
        await client.close();
      } catch (error) {
        failures.push(`${kind}: ${error instanceof Error ? error.message : String(error)}`);
        const tab = context.pages().at(-1);
        if (tab && !tab.isClosed()) {
          await screenshot(tab, `${kind}-active-qr-failure`);
          const geometry = await tab.evaluate(() => {
            const element = document.querySelector<HTMLElement>('[data-testid="console-add"]');
            if (!element) return { control: null };
            const box = element.getBoundingClientRect(), hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
            return { box: { x: box.x, y: box.y, width: box.width, height: box.height }, hitTag: hit?.tagName,
              hitClass: hit?.className, modalCount: document.querySelectorAll(":modal").length, popoverCount: document.querySelectorAll(":popover-open").length,
              rootInert: document.documentElement.inert, bodyInert: document.body.inert,
              viewport: { width: innerWidth, height: innerHeight, scale: visualViewport?.scale } };
          });
          await writeFile(join(out, `${kind}-console-hit-target.json`), JSON.stringify(geometry, null, 2), { mode: 0o600 });
        }
      } finally {
        await context.close();
        if (kind === "webkit") await engine.close();
      }
    }
    activePage = operator;
    assert.deepEqual(failures, []);
  });
  const page = await desktop.newPage();
  activePage = page;
  page.on("pageerror", error => errors.push(error.message));
  let conversation = "";
  await check("Fresh QR, actual trusted HTTPS pairing, scripted reply and Host attachment storage", async () => {
    const invitation = await invite(false, "desktop-invitation");
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
    await operator.getByTestId("console-refresh").click();
    await until(async () => (await controlState()).devices.some(device => device.name === "Mac package desktop check" && device.webSessions > 0),
      "Observed desktop web session");
    const client = (await controlState()).devices.find(device => device.name === "Mac package desktop check")!;
    await operator.getByTestId(`console-device-${client.id}`).click();
    await screenshot(operator, "desktop-console-device");
    await page.goto("about:blank");
    await until(async () => (await controlState()).devices.some(device => device.id === client.id && device.webSessions === 0),
      "Paired authorization retained without a current session");
    await page.goto(conversation);
  });
  await check("CN-04/05: failed and lost-response send retries stay explicit and never silently replay", async () => {
    await checkConnectionRecovery({ browser: browser!, invitation: () => invite(), screenshot });
  });
  if (values["workspace-pages"]) await check("PA-13/14: every reachable web-Host page, direct local entry, browser reuse and phone invitation survival", async () => {
    await checkWorkspacePages({ browser: browser!, controlURL: controlBase, origin, out, entry: async () => {
      const reopened = launch(); await reopened.child.exited; await reopened.drained;
      assert.equal(reopened.child.exitCode, 0); return consoleEntry();
    } });
  });
  await check("Local pairing lifecycle, workspace entry and responsive operator views use no account", async () => {
    await operator.getByTestId("console-add").click();
    const qr = operator.getByTestId("console-pairing-qr");
    const original = await qr.getAttribute("data-link");
    const file = join(data, "pairing.json"), pairing = JSON.parse(await readFile(file, "utf8"));
    await writeFile(file, JSON.stringify({ ...pairing, expiresAt: new Date(Date.now() - 1000).toISOString() }), { mode: 0o600 });
    await operator.getByTestId("console-pairing-status").getByText("这个邀请已过期，请生成新二维码。", { exact: true }).waitFor();
    await operator.getByTestId("console-pair-regenerate").click();
    await until(async () => (await qr.getAttribute("data-link")) !== original, "Regenerated invitation");
    await operator.getByTestId("console-pair-close").click();
    const opened = desktop.waitForEvent("page");
    await operator.getByTestId("console-workspace").click();
    const workspace = await opened; activePage = workspace;
    await workspace.getByTestId("composer-input").waitFor();
    assert.equal(new URL(workspace.url()).origin, origin);
    await workspace.close();
    activePage = operator;
    const variants = [
      { name: "console-desktop-en-dark", width: 1365, height: 900, language: "en", theme: "dark" },
      { name: "console-narrow-zh-dark", width: 390, height: 844, language: "zh-Hans", theme: "dark" },
      { name: "console-narrow-en-light", width: 375, height: 812, language: "en", theme: "light" },
      { name: "console-tablet-en-light", width: 768, height: 1000, language: "en", theme: "light" },
    ];
    for (const variant of variants) {
      const reopen = launch(); await reopen.child.exited; await reopen.drained; assert.equal(reopen.child.exitCode, 0);
      const context = await browser!.newContext({ viewport: { width: variant.width, height: variant.height }, isMobile: variant.width < 650, hasTouch: variant.width < 650 });
      await context.addInitScript(({ language, theme }) => {
        if (!["http:", "https:"].includes(location.protocol)) return;
        localStorage.setItem("ox.language", language); localStorage.setItem("ox.theme", theme);
      }, variant);
      const tab = await context.newPage(); tab.on("pageerror", error => errors.push(error.message)); activePage = tab;
      await tab.goto(await consoleEntry()); await tab.getByTestId("console-add").waitFor();
      const client = (await controlState()).devices.find(device => device.name === "Mac package desktop check")!;
      await tab.getByTestId("console-search").fill("no-matching-owned-client");
      await tab.getByTestId("console-empty").waitFor();
      assert.equal(await tab.getByTestId(`console-device-${client.id}`).count(), 0);
      await screenshot(tab, `${variant.name}-search`);
      await tab.getByTestId("console-search").fill("Mac package");
      await tab.getByTestId(`console-device-${client.id}`).click();
      assert((await tab.getByTestId("console-add").boundingBox())!.height >= 44);
      assert(await tab.locator(".hc-tools button").evaluateAll(buttons => buttons.every(button => {
        const box = button.getBoundingClientRect();
        return box.width >= 44 && box.height >= 44 && box.left >= 0 && box.right <= innerWidth;
      })), "Every header action must retain a real 44px target without compact-layout clipping");
      assert(await tab.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await screenshot(tab, variant.name);
      if (variant.width < 650) {
        await tab.getByTestId("console-back").click();
        await tab.getByTestId("console-search").waitFor();
        await tab.getByTestId("console-overview").click();
        await tab.getByRole("heading", { name: "Mac LAN Test Host", exact: true }).waitFor();
        assert.equal(await tab.getByTestId("console-overview").getAttribute("aria-pressed"), "true");
        await tab.getByTestId("console-back").click();
        await tab.getByTestId("console-search").waitFor();
        await tab.getByTestId(`console-device-${client.id}`).click();
      } else {
        await tab.getByTestId("console-overview").click();
        await tab.getByRole("heading", { name: "Mac LAN Test Host", exact: true }).waitFor();
        await tab.getByTestId("console-search").click();
        assert.equal(await tab.getByTestId("console-search").evaluate(element => element === document.activeElement), true);
      }
      await tab.getByTestId("console-add").click();
      const qr = tab.getByTestId("console-pairing-qr");
      await qr.waitFor();
      const before = await qr.getAttribute("data-link");
      await tab.getByTestId("console-pair-regenerate").click();
      await until(async () => await qr.getAttribute("data-link") !== before, `${variant.name} visible QR regenerated`);
      await screenshot(tab, `${variant.name}-qr`);
      await tab.route("**/api/state", route => route.fulfill({ status: 503, contentType: "application/json",
        body: JSON.stringify({ error: "Owned state outage fixture" }) }), { times: 1 });
      await tab.getByTestId("console-pairing-status").getByText(variant.language === "en"
        ? "Status unavailable. Displayed information may be out of date." : "暂时无法读取状态，当前信息可能已经过时。", { exact: true }).waitFor();
      assert.equal(await qr.count(), 0);
      assert(await tab.getByTestId("console-pair-regenerate").isEnabled());
      await screenshot(tab, `${variant.name}-stale`);
      await tab.getByTestId("console-pair-regenerate").click();
      await qr.waitFor();
      await tab.getByTestId("console-pair-close").click();
      await tab.getByTestId("console-refresh").click();
      await until(async () => await tab.getByTestId("console-status").getAttribute("data-live") === "true", `${variant.name} operator recovery`);
      await context.close();
    }
    activePage = operator;
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
    controlBase = JSON.parse(await readFile(join(data, "run.json"), "utf8")).control.url;
    await operator.goto(await consoleEntry());
    await operator.getByTestId("console-add").waitFor();
    await page.goto(conversation);
    await page.getByText("【连接测试回复，不是 AI 推理】这台 Mac 已收到请求。对话保存在 Mac 的测试工作区。", { exact: false }).first().waitFor();
    assert.equal(await page.getByTestId("pair-submit").count(), 0);
  });
  await check("Separate phone-layout browser pairs independently using normal certificate trust", async () => {
    await execute([join(bundle, "bin/bun"), "--no-env-file", join(bundle, "runtime/apps/linux/scripts/mac-local-host.ts"),
      "pair", "--data", data, "--no-open"]);
    const context = await browser!.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: "zh-CN", colorScheme: "dark" });
    await context.addInitScript(() => { if (["http:", "https:"].includes(location.protocol)) localStorage.setItem("ox.language", "zh-Hans"); });
    const phone = await context.newPage(); phone.on("pageerror", error => errors.push(error.message));
    activePage = phone;
    await phone.goto(await invite(true));
    await phone.getByTestId("pair-name").fill("Phone console check");
    await phone.getByTestId("pair-submit").click();
    await phone.getByTestId("onboarding-start").click();
    await phone.goto(conversation);
    await phone.getByText("【连接测试回复，不是 AI 推理】这台 Mac 已收到请求。对话保存在 Mac 的测试工作区。", { exact: false }).first().waitFor();
    await screenshot(phone, "phone-existing-workspace");
    await phone.getByTestId("workspace-context").click();
    await phone.getByTestId("connection-processing").waitFor();
    await screenshot(phone, "phone-connections");
    assert(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await operator.getByTestId("console-refresh").click();
    await until(async () => (await controlState()).devices.some(device => device.name === "Phone console check" && device.webSessions > 0),
      "Observed phone web session");
    const client = (await controlState()).devices.find(device => device.name === "Phone console check")!;
    await operator.getByTestId(`console-device-${client.id}`).click();
    await operator.getByTestId("console-revoke").click();
    await screenshot(operator, "revoke-confirmation");
    await operator.locator("dialog[open]").last().getByTestId("dialog-cancel").click();
    assert((await controlState()).devices.some(device => device.id === client.id));
    await operator.getByTestId("console-revoke").click();
    await operator.locator("dialog[open]").last().getByTestId("dialog-confirm").click();
    await until(async () => !(await controlState()).devices.some(device => device.id === client.id), "Selected pairing revoked");
    await operator.getByTestId(`console-device-${client.id}`).waitFor({ state: "detached" });
    await screenshot(operator, "revoked-pairing-list");
    assert.equal((await phone.request.get(`${origin}/api/settings`)).status(), 401);
    assert((await controlState()).devices.some(device => device.name === "Mac package desktop check"));
    await context.close();
  });
  await check("WebKit phone-layout client pairs and sends through normal trusted HTTPS", async () => {
    await execute([join(bundle, "bin/bun"), "--no-env-file", join(bundle, "runtime/apps/linux/scripts/mac-local-host.ts"),
      "pair", "--data", data, "--no-open"]);
    safari = await webkit.launch({ headless: true, env: environment });
    const context = await safari.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: "zh-CN", colorScheme: "dark" });
    await context.addInitScript(() => { if (["http:", "https:"].includes(location.protocol)) localStorage.setItem("ox.language", "zh-Hans"); });
    const tab = await context.newPage(); activePage = tab;
    tab.on("pageerror", error => errors.push(error.message));
    await tab.goto(await invite(true));
    await tab.bringToFront();
    await tab.getByTestId("pair-submit").tap();
    await tab.getByTestId("onboarding-start").tap();
    await tab.goto(conversation);
    await tab.getByTestId("composer-input").fill("WebKit 连接验收");
    await tab.getByTestId("send").tap();
    await until(async () => await tab.getByText("【连接测试回复，不是 AI 推理】这台 Mac 已收到请求。对话保存在 Mac 的测试工作区。", { exact: false }).count() === 2,
      "WebKit scripted follow-up reply");
    await screenshot(tab, "webkit-phone-workspace");
    const reopen = launch(); await reopen.child.exited; await reopen.drained; assert.equal(reopen.child.exitCode, 0);
    const localConsole = await context.newPage(); activePage = localConsole;
    localConsole.on("pageerror", error => errors.push(error.message));
    await localConsole.goto(await consoleEntry());
    await localConsole.getByTestId("console-add").waitFor();
    await screenshot(localConsole, "webkit-local-console");
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
  if (activePage && !activePage.isClosed()) {
    await screenshot(activePage, "failure");
    const geometry = await activePage.evaluate(() => {
      const element = document.querySelector<HTMLElement>('[data-testid="pair-submit"]');
      if (!element) return { pairButton: null };
      const box = element.getBoundingClientRect(), hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      return { button: { x: box.x, y: box.y, width: box.width, height: box.height }, hitTag: hit?.tagName,
        hitClass: hit?.className, viewport: { width: innerWidth, height: innerHeight, scale: visualViewport?.scale } };
    });
    await writeFile(join(out, "failure-geometry.json"), JSON.stringify(geometry, null, 2), { mode: 0o600 });
  }
} finally {
  await safari?.close();
  await browser?.close();
  if (active) {
    if (active.child.exitCode === null) active.child.kill("SIGTERM");
    await active.child.exited; await active.drained;
  }
  await rm(work, { recursive: true, force: true });
  await writeFile(join(out, "report.json"), JSON.stringify({ checks, errors, failure: failure || null, normalTLS: true,
    renderedQrs, screenshotDiagnostics, activeQRWebKitInput: values["webkit-touch"] ? "Explicit phone-layout touch; not desktop mouse acceptance" : "Desktop mouse",
    noGlobalRuntimeOrSourceCheckoutDependency: true, privateFixtureRemoved: true,
    phone: "Chrome and macOS WebKit phone emulation; physical iPhone Safari acceptance remains owner-assisted" }, null, 2), { mode: 0o600 });
}
if (failure) throw new Error(failure);

import assert from "node:assert/strict";
import { createHash, X509Certificate } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { chromium, type Browser, type Page } from "playwright-core";
import { Host } from "../src/host";
import { startServer } from "../src/server";

process.umask(0o077);
process.env.OPENOX_MEDIA_URL = "http://127.0.0.1:9";
const root = resolve(import.meta.dir, "../../..");
const { values } = parseArgs({ options: { out: { type: "string" } } });
const out = resolve(values.out ?? join(tmpdir(), `openox-workspace-${crypto.randomUUID()}`));
const inside = relative(root, out);
assert(inside && (inside.startsWith(`..${sep}`) || isAbsolute(inside)), "Keep evidence outside the checkout");
await mkdir(out, { recursive: true, mode: 0o700 });
const work = await mkdtemp(join(out, "private-run-"));
const hosts: Host[] = [], servers: Awaited<ReturnType<typeof startServer>>[] = [];
const checks: string[] = [], errors: string[] = [];
let browser: Browser | undefined, activePage: Page | undefined, failure = "";
let calls = 0, requestContext = "";
const completion = Promise.withResolvers<void>();
const chunk = (content: string, done = false) => `data: ${JSON.stringify({ id: "workspace-fixture", object: "chat.completion.chunk", created: 0, model: "shared-fixture",
  choices: [{ index: 0, delta: { content }, finish_reason: done ? "stop" : null }] })}\n\n`;
const model = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  if (request.method === "GET") return Response.json({ object: "list", data: [{ id: "shared-fixture", object: "model", max_model_len: 40960 }] });
  requestContext = JSON.stringify(await request.json());
  calls++;
  return new Response(new ReadableStream({ async start(controller) {
    controller.enqueue(new TextEncoder().encode(chunk("Working on Host A. ")));
    await completion.promise;
    controller.enqueue(new TextEncoder().encode(chunk("Host A completed independently.", true) + "data: [DONE]\n\n"));
    controller.close();
  } }), { headers: { "content-type": "text/event-stream" } });
} });
const dialog = (page: Page) => page.locator("dialog[open]").last();
async function check(name: string, operation: () => Promise<void>) {
  await operation(); checks.push(name); console.log(`PASS ${name}`);
}
async function otherHost(page: Page, address: string) {
  await page.getByTestId("host-switch").click();
  await page.getByTestId("host-switch-address").fill(address);
  await dialog(page).getByTestId("dialog-confirm").click();
}
async function chat(page: Page) {
  await page.getByTestId("settings-close").click();
  await page.getByTestId("composer-input").waitFor();
}
async function shot(page: Page, name: string) {
  await page.screenshot({ path: join(out, `${name}.png`), animations: "disabled" });
}
try {
  const key = join(work, "key.pem"), cert = join(work, "cert.pem");
  const child = Bun.spawn(["openssl", "req", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-x509",
    "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1", "-keyout", key, "-out", cert],
  { stdout: "pipe", stderr: "pipe" });
  const [code, , stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  assert.equal(code, 0, stderr);
  const identity = { cert: await readFile(cert, "utf8"), key: await readFile(key, "utf8") };
  const tls = { ca: identity.cert };
  const endpoints: string[] = [], tokens: string[] = [];
  for (const [index, name] of ["A", "B"].entries()) {
    const host = await Host.open({ data: join(work, name), hostID: `Host ${name}`, version: `fixture-${name}`, quiet: true });
    hosts.push(host);
    await host.updateSettings({ profile: { ...host.settings.profile, name: `Studio ${name}` } });
    const server = await startServer(host, { hostname: "127.0.0.1", port: 0, tls: identity });
    servers.push(server);
    const origin = `https://${index ? "127.0.0.1" : "localhost"}:${server.port}`;
    endpoints.push(origin);
    const device = await host.devices.add(`Workspace ${name} fixture`, "browser");
    tokens.push(device.token);
    const headers = { cookie: `ox_device=${device.token}`, origin, "content-type": "application/json" };
    const configured = await fetch(`${origin}/api/settings/machines`, { tls, method: "POST", headers,
      body: JSON.stringify({ address: `http://127.0.0.1:${model.port}/v1`, name: "Shared model service" }) });
    assert(configured.ok);
    const settings = await configured.json() as { providers: { id: string; custom: boolean; models: { id: string }[] }[] };
    const provider = settings.providers.find(value => value.custom && value.models.length);
    assert(provider);
    assert((await fetch(`${origin}/api/settings/default-model`, { tls, method: "PUT", headers,
      body: JSON.stringify({ provider: provider.id, modelId: provider.models[0]!.id }) })).ok);
    assert((await fetch(`${origin}/api/settings/memory`, { tls, method: "PUT", headers,
      body: JSON.stringify({ text: `Workspace ${name} instruction canary` }) })).ok);
  }
  const a = endpoints[0]!, b = endpoints[1]!;
  const fingerprint = createHash("sha256").update(new X509Certificate(identity.cert).publicKey.export({ type: "spki", format: "der" })).digest("base64");
  browser = await chromium.launch({ channel: "chrome", headless: true, args: [`--ignore-certificate-errors-spki-list=${fingerprint}`] });
  for (const variant of [
    { name: "desktop-en-light", width: 1365, height: 900, language: "en", theme: "light", phone: false },
    { name: "desktop-en-dark", width: 1365, height: 900, language: "en", theme: "dark", phone: false },
    { name: "phone-zh-light", width: 390, height: 844, language: "zh-Hans", theme: "light", phone: true },
    { name: "phone-zh-dark", width: 390, height: 844, language: "zh-Hans", theme: "dark", phone: true },
  ]) {
    const context = await browser.newContext({ viewport: { width: variant.width, height: variant.height }, isMobile: variant.phone, hasTouch: variant.phone });
    await context.addCookies([{ name: "ox_device", value: tokens[0]!, url: a, httpOnly: true, secure: true, sameSite: "Strict" }]);
    await context.addInitScript(({ language, theme }) => { localStorage.setItem("ox.language", language); localStorage.setItem("ox.theme", theme);
      localStorage.setItem("ox.memoryIntent", "3"); }, variant);
    const page = await context.newPage();
    activePage = page;
    page.on("pageerror", error => errors.push(error.message));
    await check(`${variant.name}: rendered first use, workspace identity and data scope`, async () => {
      await page.goto(a);
      await page.getByTestId("onboarding").waitFor();
      assert((await page.getByTestId("onboarding-workspace").innerText()).includes("Studio A"));
      await shot(page, `${variant.name}-onboarding`);
      await page.getByTestId("onboarding-start").click();
      const badge = page.getByTestId("workspace-context");
      assert((await badge.innerText()).includes("Host A"));
      assert((await badge.boundingBox())!.height >= 44);
      await shot(page, `${variant.name}-chat`);
      await badge.click();
      await page.getByTestId("connection-processing").waitFor();
      assert((await page.getByTestId("connection-workspace").innerText()).includes("Studio A"));
      assert((await page.getByTestId("connection-current").innerText()).includes(a));
      await page.getByTestId("connection-test").click();
      await page.getByText(variant.phone ? "当前地址可用，设备已配对。" : "This address is reachable and paired.", { exact: true }).waitFor();
      await page.locator(".toast:not(.error)").waitFor({ state: "hidden" });
      await page.getByTestId("settings-body").evaluate(element => { element.scrollTop = 0; });
      await shot(page, `${variant.name}-connections`);
      await page.getByTestId("outside-configure").scrollIntoViewIfNeeded();
      await shot(page, `${variant.name}-entries`);
      await page.getByTestId("connection-models").click();
      await page.getByTestId("models-scope").waitFor();
      await page.getByTestId("served-model").first().waitFor();
      assert((await page.getByTestId("models-scope").innerText()).includes("Host A"));
      await shot(page, `${variant.name}-models`);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.evaluate(() => { location.hash = "#/files"; });
      await page.locator(".page").waitFor();
      assert((await page.getByTestId("workspace-context").innerText()).includes("Host A"));
      await shot(page, `${variant.name}-files`);
      await page.evaluate(() => { location.hash = "#/schedules"; });
      await page.getByRole("heading", { name: variant.phone ? "定时任务" : "Schedules", exact: true }).waitFor();
      assert((await page.getByTestId("workspace-context").innerText()).includes("Studio A"));
    });
    await context.close();
  }
  const context = await browser.newContext({ viewport: { width: 1365, height: 900 } });
  await context.addCookies([{ name: "ox_device", value: tokens[0]!, url: a, httpOnly: true, secure: true, sameSite: "Strict" }]);
  await context.addInitScript(() => { localStorage.setItem("ox.onboarded", "1"); localStorage.setItem("ox.whatsNew", "2026-11-11");
    localStorage.setItem("ox.language", "en"); localStorage.setItem("ox.memoryIntent", "3"); });
  const page = await context.newPage();
  activePage = page;
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(a);
  await page.getByTestId("composer-input").waitFor();
  await check("Outside entry is Host-shared, does not navigate or provision, and can be removed explicitly", async () => {
    await page.getByTestId("workspace-context").click();
    await page.getByTestId("outside-configure").click();
    await page.getByTestId("outside-provider").selectOption("https");
    await page.getByTestId("outside-address").fill("https://recorded.example.invalid");
    await dialog(page).getByTestId("dialog-confirm").click();
    await page.getByTestId("connection-outside").getByText("https://recorded.example.invalid", { exact: true }).waitFor();
    assert.equal(new URL(page.url()).origin, a);
    const second = await browser!.newContext();
    try {
      const peer = await hosts[0]!.devices.add("Second workspace client", "browser");
      await second.addCookies([{ name: "ox_device", value: peer.token, url: a, httpOnly: true, secure: true, sameSite: "Strict" }]);
      const tab = await second.newPage();
      await tab.goto(`${a}/#/settings/connections`);
      await tab.getByTestId("connection-outside").getByText("https://recorded.example.invalid", { exact: true }).waitFor();
    } finally { await second.close(); }
    await page.getByTestId("outside-remove").click();
    await dialog(page).getByTestId("dialog-confirm").click();
    await page.getByTestId("connection-outside").getByText("No additional outside address recorded", { exact: true }).waitFor();
    await page.getByTestId("connection-workspace-settings").click();
    await page.getByTestId("workspace-scope").waitFor();
    await shot(page, "workspace-settings");
    await page.getByTestId("settings-close").click();
    await page.getByTestId("composer-input").waitFor();
  });
  await check("Long workspace names retain the full accessible identity and a usable 200-percent page zoom", async () => {
    await page.getByTestId("workspace-context").click();
    await page.getByTestId("connection-workspace-settings").click();
    await page.getByTestId("profile-edit").click();
    const name = "Studio A with a deliberately long shared workspace name";
    await page.getByTestId("profile-name").fill(name);
    await dialog(page).getByTestId("dialog-confirm").click();
    await page.getByTestId("profile-name-row").getByText(name, { exact: true }).waitFor();
    await page.getByTestId("settings-close").click();
    assert((await page.getByTestId("workspace-context").getAttribute("aria-label"))!.includes(name));
    const session = await context.newCDPSession(page);
    await session.send("Emulation.setPageScaleFactor", { pageScaleFactor: 2 });
    assert.equal(await page.evaluate(() => visualViewport!.scale), 2);
    await shot(page, "workspace-zoom-200");
    await session.send("Emulation.setPageScaleFactor", { pageScaleFactor: 1 });
    await session.detach();
  });
  await check("Unsent draft stays after cancelled Host navigation", async () => {
    await page.getByTestId("composer-input").fill("Keep this draft on Host A");
    await page.getByTestId("workspace-context").click();
    await page.getByTestId("host-switch").waitFor();
    await otherHost(page, b);
    await dialog(page).getByRole("button", { name: "Stay here", exact: true }).click();
    assert.equal(new URL(page.url()).origin, a);
    await chat(page);
    assert.equal(await page.getByTestId("composer-input").inputValue(), "Keep this draft on Host A");
    await page.getByTestId("composer-input").fill("");
  });
  await check("In-flight upload blocks navigation; completed attachment selection is guarded", async () => {
    const held = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const creating = Promise.withResolvers<void>(), create = Promise.withResolvers<void>();
    await page.route("**/api/conversations", async route => {
      if (route.request().method() === "POST") { creating.resolve(); await create.promise; }
      await route.continue();
    });
    await page.route("**/api/conversations/*/attachments?*", async route => { held.resolve(); await release.promise; await route.continue(); }, { times: 1 });
    try {
      await page.getByTestId("composer-input").evaluate(element => {
        const data = new DataTransfer(); data.items.add(new File(["Owned fixture"], "workspace.txt", { type: "text/plain" }));
        element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, clipboardData: data }));
      });
      await Promise.race([creating.promise, Bun.sleep(10000).then(() => { throw new Error("Fixture attachment preparation did not start"); })]);
      await page.getByTestId("workspace-context").click();
      await otherHost(page, b);
      await page.getByTestId("toast-error").waitFor();
      assert.equal(new URL(page.url()).origin, a);
      await page.getByTestId("toast-dismiss").click();
      create.resolve();
      await Promise.race([held.promise, Bun.sleep(10000).then(() => { throw new Error("Fixture upload did not start"); })]);
      await chat(page);
      await page.getByTestId("workspace-context").click();
      await otherHost(page, b);
      await page.getByText("An upload or message submission is still in progress. Wait for it to finish before opening another Host.", { exact: true }).waitFor();
      assert.equal(new URL(page.url()).origin, a);
      release.resolve();
      await page.getByTestId("toast-dismiss").click();
      await chat(page);
      await page.getByTestId("attachment-chip").waitFor();
      await page.getByTestId("workspace-context").click();
      await otherHost(page, b);
      await dialog(page).getByRole("button", { name: "Stay here", exact: true }).click();
      await chat(page);
      await page.getByTestId("attachment-chip").waitFor();
    } finally { create.resolve(); release.resolve(); }
  });
  await check("Submitted Host work continues after explicit switch; another hostname needs independent pairing", async () => {
    const submitted = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    await page.route("**/api/conversations/*/messages", async route => { submitted.resolve(); await release.promise; await route.continue(); }, { times: 1 });
    await page.getByTestId("composer-input").fill("Use my workspace instructions");
    await page.getByTestId("send").click();
    try {
      await Promise.race([submitted.promise, Bun.sleep(10000).then(() => { throw new Error("Fixture submission did not start"); })]);
      await page.getByTestId("workspace-context").click();
      await otherHost(page, b);
      await page.getByTestId("toast-error").waitFor();
      assert.equal(new URL(page.url()).origin, a);
      await page.getByTestId("toast-dismiss").click();
    } finally { release.resolve(); }
    await chat(page);
    await page.getByText("Working on Host A.", { exact: false }).first().waitFor();
    const conversation = page.url();
    assert.equal(calls, 1);
    assert(requestContext.includes("Workspace A instruction canary"));
    assert(!requestContext.includes("Workspace B instruction canary"));
    await page.getByTestId("workspace-context").click();
    const received: Promise<string>[] = [];
    page.on("request", request => { if (new URL(request.url()).origin === b) received.push(request.allHeaders().then(headers => headers.cookie ?? "")); });
    await otherHost(page, b);
    await page.getByTestId("pair-submit").waitFor();
    assert.equal(new URL(page.url()).origin, b);
    assert(received.length && (await Promise.all(received)).every(cookie => !cookie.includes("ox_device=")));
    completion.resolve();
    const pairing = await hosts[1]!.devices.createPairingCode();
    await page.getByTestId("pair-code").fill(pairing.code);
    await page.getByTestId("pair-submit").click();
    await page.getByTestId("workspace-context").waitFor();
    assert((await page.getByTestId("workspace-context").innerText()).includes("Studio B"));
    assert.equal(calls, 1);
    const ownHistory = await page.evaluate(async () => (await (await fetch("/api/conversations")).json()) as { items: unknown[] });
    assert.equal(ownHistory.items.length, 0);
    await shot(page, "host-b-workspace");
    await page.goto(conversation);
    await page.getByText("Host A completed independently.", { exact: false }).first().waitFor();
  });
  await context.close();
  assert.deepEqual(errors, []);
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
  if (activePage && !activePage.isClosed()) await shot(activePage, "failure");
} finally {
  completion.resolve();
  await browser?.close();
  for (const server of servers) await server.stop(true);
  for (const host of hosts) await host.close();
  await model.stop(true);
  await rm(work, { recursive: true, force: true });
  await writeFile(join(out, "report.json"), JSON.stringify({ checks, errors, failure: failure || null, modelCalls: calls,
    trust: "Exact owned fixture SPKI pin; UI acceptance, not certificate or physical-network acceptance.",
    phone: "Chrome emulation, not physical iOS", cleanup: "Owned Hosts, browser contexts, pairing tokens, certificates and data removed" }, null, 2));
}
if (failure) throw new Error(failure);

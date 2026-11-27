import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "../../../../../apps/linux/node_modules/playwright-core";
import { Host } from "../../../../../apps/linux/src/host";
import { startServer } from "../../../../../apps/linux/src/server";
import { zipEncode } from "../../../../../apps/linux/src/vm/skills-package";

test("G1: cancelling a genuine service import returns focus to Choose File for another keyboard selection", async () => {
  const flags = { OPENOX_PERSONAL_AGENT: process.env.OPENOX_PERSONAL_AGENT, OPENOX_MUSE_PARITY: process.env.OPENOX_MUSE_PARITY };
  const data = await mkdtemp(join(tmpdir(), "g1-service-chooser-"));
  let host: Host | undefined, server: Awaited<ReturnType<typeof startServer>> | undefined, browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    process.env.OPENOX_PERSONAL_AGENT = process.env.OPENOX_MUSE_PARITY = "1";
    host = await Host.open({ data, hostID: crypto.randomUUID(), version: "g1-focus", quiet: true });
    server = await startServer(host, { hostname: "127.0.0.1", port: 0 });
    const url = `http://127.0.0.1:${server.port}`;
    browser = await chromium.launch();
    const context = await browser.newContext({ serviceWorkers: "block" });
    await context.route("**/*", route => new URL(route.request().url()).origin === url ? route.continue() : route.abort());
    const page = await context.newPage();
    await page.goto(url);
    await page.getByTestId("pair-code").fill((await host.devices.createPairingCode()).code);
    await page.getByTestId("pair-name").fill("Local G1 browser");
    await page.getByTestId("pair-submit").click();
    await page.getByTestId("composer-input").waitFor();
    if (await page.getByTestId("onboarding-start").isVisible()) await page.getByTestId("onboarding-start").click();
    await page.goto(`${url}/#/settings/services`);
    await page.getByTestId("connector-advanced").click();
    const picker = page.getByTestId("import-service");
    const domain = "g1-chooser.localhost";
    const manifest = { domain, name: "G1 chooser", description: "", baseUrl: `http://${domain}/`, actions: [] };
    const files = { "package.json": JSON.stringify({ version: 1, kind: "web", domain }), [`services/web/${domain}/service.json`]: JSON.stringify(manifest),
      [`services/web/${domain}/actions.js`]: "window.ox.install(() => {});" };
    const buffer = Buffer.from(zipEncode(Object.entries(files).map(([path, s]) => ({ path, data: new TextEncoder().encode(s) })), 4_500_000));
    const [choose] = await Promise.all([page.waitForEvent("filechooser"), picker.click()]);
    await choose.setFiles({ name: "chooser.service", mimeType: "application/octet-stream", buffer });
    const dialog = page.getByTestId("service-import-dialog");
    await dialog.getByTestId("dialog-cancel").click();
    await dialog.waitFor({ state: "detached" });
    expect(await page.evaluate(() => (document.activeElement as HTMLElement)?.dataset.testid)).toBe("import-service");
    const [again] = await Promise.all([page.waitForEvent("filechooser"), page.keyboard.press("Enter")]);
    expect(again.isMultiple()).toBe(false);
    await again.setFiles([]);
  } finally {
    await browser?.close(); server?.stop(true); await host?.close(); await rm(data, { recursive: true, force: true });
    for (const [key, value] of Object.entries(flags)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
}, 45_000);

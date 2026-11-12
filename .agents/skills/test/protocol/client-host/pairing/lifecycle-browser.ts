import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Browser, Page } from "../../../../../../apps/linux/node_modules/playwright-core";
import type { ConsoleState } from "../../../../../../apps/linux/scripts/mac-host-console";

export async function checkHostLifecycle(options: { browser: Browser; phoneBrowser: Browser; entry(): Promise<string>; controlURL: string; origin: string; address: string; out: string }) {
  const out = join(options.out, "host-lifecycle"), captures: string[] = [], errors: string[] = [];
  await mkdir(out, { recursive: true, mode: 0o700 });
  for (const variant of [
    { name: "desktop-en-light", width: 1365, height: 900, language: "en", theme: "light" },
    { name: "compact-zh-dark", width: 390, height: 844, language: "zh-Hans", theme: "dark" },
  ]) {
    const touch = variant.width < 650, browser = touch ? options.phoneBrowser : options.browser;
    const context = await browser.newContext({ viewport: { width: variant.width, height: variant.height },
      isMobile: variant.width < 650, hasTouch: variant.width < 650, recordVideo: { dir: join(out, "recording-cache"),
        size: { width: variant.width, height: variant.height } } });
    await context.addInitScript(({ language, theme }) => {
      if (!["http:", "https:"].includes(location.protocol)) return;
      localStorage.setItem("ox.language", language); localStorage.setItem("ox.theme", theme);
    }, variant);
    const page = await context.newPage(), video = page.video();
    const activate = async (id: string, target: Page = page) => {
      await target.bringToFront();
      if (touch) await target.getByTestId(id).tap();
      else await target.getByTestId(id).click();
    };
    const state = async () => {
      const response = await page.request.get(`${options.controlURL}api/state`);
      assert.equal(response.status(), 200); return response.json() as Promise<ConsoleState>;
    };
    const visibleState = async (kind: string) => {
      await page.waitForFunction(value => document.querySelector('[data-testid="console-status"]')?.getAttribute("data-state") === value, kind);
    };
    const capture = async (name: string, target: Page = page) => {
      const file = `${variant.name}-${name}.png`;
      await target.screenshot({ path: join(out, file), animations: "disabled" });
      assert(await target.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${file}: horizontal overflow`);
      if (target === page) {
        const box = await page.getByTestId("console-power").boundingBox();
        assert(box && box.width >= 44 && box.height >= 44, `${file}: usable power control`);
      }
      captures.push(file);
    };
    const confirmStop = async () => {
      await activate("console-power");
      await activate("dialog-confirm");
    };
    try {
      page.on("pageerror", error => errors.push(error.message));
      await page.goto(await options.entry());
      await visibleState("running");
      assert.equal(await page.locator(".hc-facts").count(), 0, "Technical details are not the default landing content");
      assert.equal(await page.locator(".hc-nav").count(), 0);
      await capture("running");
      await activate("console-overview");
      await page.locator(".hc-facts").waitFor();
      await capture("more-information");
      await activate("console-back");

      const localOrigin = new URL(options.controlURL).origin;
      assert.equal((await fetch(`${options.controlURL}api/runtime/stop`, { method: "POST", headers: { origin: localOrigin } })).status, 401);
      assert.equal((await page.request.post(`${options.controlURL}api/runtime/stop`, { headers: { origin: "https://foreign.example" } })).status(), 403);
      assert.equal((await page.request.post(`${options.controlURL}api/runtime/stop`, { headers: { origin: localOrigin } })).status(), 403);
      assert.equal((await state()).runtime.state.kind, "running");

      const opening = context.waitForEvent("page");
      await activate("console-workspace");
      const client = await opening;
      await client.getByTestId("onboarding-start").waitFor();
      await activate("onboarding-start", client);
      await client.getByTestId("composer-input").waitFor();
      const cookie = (await context.cookies(options.origin)).find(value => value.name === "ox_device")?.value;
      assert(cookie);
      await client.getByTestId("composer-input").fill("Lifecycle check - synthetic connection request");
      await activate("send", client);
      await client.getByText("【连接测试回复，不是 AI 推理】", { exact: false }).first().waitFor();
      const conversation = client.url(), id = new URL(conversation).hash.split("/").at(-1);
      const uploaded = await client.request.post(`${options.origin}/api/conversations/${id}/attachments?name=lifecycle-note.txt`, {
        data: "Synthetic lifecycle retention check.", headers: { origin: options.origin, "content-type": "text/plain" },
      });
      assert(uploaded.ok());
      const file = await uploaded.json() as { path: string };
      await client.getByTestId("composer-input").fill("Retain this draft while the Host is stopped");
      await activate("console-add");
      await page.getByTestId("console-pairing-qr").waitFor();
      const auxiliaryInvitation = (await state()).pairing.url;
      assert(auxiliaryInvitation);
      const auxiliary = await fetch(`${options.origin}/api/pair`, { method: "POST",
        headers: { origin: options.origin, "content-type": "application/json" },
        body: JSON.stringify({ code: new URL(auxiliaryInvitation).hash.slice("#/pair/".length), name: "Lifecycle offline revoke" }) });
      assert.equal(auxiliary.status, 201);
      const auxiliaryDevice = await auxiliary.json() as { device: { id: string } };
      const auxiliaryCookie = auxiliary.headers.get("set-cookie")!.split(";")[0]!;
      await activate("console-pair-close");
      await activate("console-add");
      await page.getByTestId("console-pairing-qr").waitFor();
      const phone = (await state()).pairing.url, before = (await state()).devices.map(value => value.id).sort();
      assert(phone);
      await activate("console-pair-close");

      await activate("console-power");
      await capture("stop-confirmation");
      await activate("dialog-cancel");
      assert.equal((await state()).runtime.state.kind, "running");

      if (variant.language === "en") {
        let release!: () => void, held!: () => void, done!: () => void;
        const hold = new Promise<void>(resolve => { release = resolve; }), caught = new Promise<void>(resolve => { held = resolve; }),
          completed = new Promise<void>(resolve => { done = resolve; });
        await page.route("**/api/runtime/stop", async route => {
          try { const response = await route.fetch(); held(); await hold; await route.fulfill({ response }); }
          finally { done(); }
        });
        try {
          await confirmStop(); await caught;
          await visibleState("stopping"); await capture("stopping");
          assert(await page.getByTestId("console-power").isDisabled());
          assert.equal((await state()).runtime.state.kind, "stopped");
        } finally { release(); await completed; await page.unroute("**/api/runtime/stop"); }
      } else await confirmStop();
      await visibleState("stopped");
      await capture("stopped");
      assert(await page.getByTestId("console-workspace").isDisabled());
      assert(await page.getByTestId("console-add").isDisabled());
      assert.equal(await client.getByTestId("composer-input").inputValue(), "Retain this draft while the Host is stopped");
      await assert.rejects(fetch(`${options.origin}/api/health`, { signal: AbortSignal.timeout(1000) }));
      assert.deepEqual((await state()).devices.map(value => value.id).sort(), before);
      await capture("client-disconnected", client);
      await activate(`console-device-${auxiliaryDevice.device.id}`);
      await activate("console-revoke");
      await activate("dialog-confirm");
      await page.getByTestId(`console-device-${auxiliaryDevice.device.id}`).waitFor({ state: "hidden" });
      const retained = before.filter(value => value !== auxiliaryDevice.device.id);
      assert.deepEqual((await state()).devices.map(value => value.id).sort(), retained);
      await capture("revoked-while-stopped");

      if (variant.language === "en") {
        const holder = createServer();
        await new Promise<void>((resolve, reject) => {
          holder.once("error", reject); holder.listen(Number(new URL(options.origin).port), options.address, resolve);
        });
        try {
          await activate("console-power");
          await visibleState("failed"); await capture("start-failed");
          assert.equal((await state()).runtime.state.kind, "failed");
          assert(holder.listening, "A failed Host start must not stop an unrelated port owner");
        } finally { await new Promise<void>((resolve, reject) => holder.close(error => error ? reject(error) : resolve())); }
      }

      let release!: () => void, held!: () => void, done!: () => void;
      const hold = new Promise<void>(resolve => { release = resolve; }), caught = new Promise<void>(resolve => { held = resolve; }),
        completed = new Promise<void>(resolve => { done = resolve; });
      await page.route("**/api/runtime/start", async route => {
        try { const response = await route.fetch(); held(); await hold; await route.fulfill({ response }); }
        finally { done(); }
      });
      try {
        await activate("console-power"); await caught;
        await visibleState("starting"); await capture("starting");
        assert(await page.getByTestId("console-power").isDisabled());
      } finally { release(); await completed; await page.unroute("**/api/runtime/start"); }
      await visibleState("running");
      await capture("restarted");
      assert.equal((await state()).pairing.url, phone);
      assert.deepEqual((await state()).devices.map(value => value.id).sort(), retained);
      assert.equal((await fetch(`${options.origin}/api/settings`, { headers: { cookie: auxiliaryCookie } })).status, 401);
      assert.equal((await context.cookies(options.origin)).find(value => value.name === "ox_device")?.value, cookie);
      assert.equal((await client.request.get(`${options.origin}/api/session`)).status(), 200);
      assert.equal(await client.getByTestId("composer-input").inputValue(), "Retain this draft while the Host is stopped");
      await client.getByTestId("composer-input").fill("");
      await client.reload();
      await client.getByText("【连接测试回复，不是 AI 推理】", { exact: false }).first().waitFor();
      assert.equal(await client.getByTestId("pair-submit").count(), 0);
      await capture("client-reconnected", client);
      await client.goto(`${options.origin}/#/file/${file.path.split("/").map(encodeURIComponent).join("/")}`);
      await client.getByText("Synthetic lifecycle retention check.", { exact: false }).waitFor();
      await capture("file-retained", client);

      if (variant.language === "en") {
        let submissions = 0;
        await page.route("**/api/runtime/stop", async route => {
          submissions++; await route.fetch(); await route.abort("failed");
        });
        await confirmStop();
        await visibleState("unknown");
        await capture("unconfirmed-stop");
        assert.equal(submissions, 1, "An uncertain lifecycle action must never silently replay");
        await page.unroute("**/api/runtime/stop");
        await activate("console-refresh");
        await visibleState("stopped");
        await activate("console-power");
        await visibleState("running");
      }
      await context.close();
      if (video) await video.saveAs(join(out, `${variant.name}.webm`));
    } catch (error) {
      if (!page.isClosed()) await capture("failure");
      throw error;
    } finally { await context.close(); }
  }
  await writeFile(join(out, "report.json"), JSON.stringify({
    cases: ["HL-02", "HL-03", "HL-04", "HL-05", "HL-06", "PA-11", "PA-13", "CN-07"], captures, errors,
    scope: "Real isolated Host lifecycle, retained cookie/history/draft/access, control-response faults and occupied fixture port; no physical phone/radios or real inference",
  }, null, 2), { mode: 0o600 });
  assert.deepEqual(errors, []);
}

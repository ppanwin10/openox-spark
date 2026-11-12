import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Browser, Page } from "../../../../../../apps/linux/node_modules/playwright-core";
import type { ConsoleState } from "../../../../../../apps/linux/scripts/mac-host-console";

export async function checkWorkspacePages(options: { browser: Browser; entry(): Promise<string>; controlURL: string; origin: string; out: string }) {
  const out = join(options.out, "workspace-pages"), inventory: unknown[] = [], errors: string[] = [];
  await mkdir(out, { recursive: true, mode: 0o700 });
  for (const variant of [
    { name: "desktop-en-light", width: 1365, height: 900, language: "en", theme: "light" },
    { name: "compact-zh-dark", width: 390, height: 844, language: "zh-Hans", theme: "dark" },
  ]) {
    const context = await options.browser.newContext({ viewport: { width: variant.width, height: variant.height },
      isMobile: variant.width < 650, hasTouch: variant.width < 650, locale: variant.language === "en" ? "en-US" : "zh-CN",
      recordVideo: { dir: join(out, "recording-cache"), size: { width: variant.width, height: variant.height } } });
    await context.addInitScript(({ language, theme }) => {
      if (!["http:", "https:"].includes(location.protocol)) return;
      localStorage.setItem("ox.language", language); localStorage.setItem("ox.theme", theme);
    }, variant);
    const operator = await context.newPage(), operatorVideo = operator.video();
    let active = operator;
    const state = async () => {
      const response = await operator.request.get(`${options.controlURL}api/state`);
      assert.equal(response.status(), 200); return response.json() as Promise<ConsoleState>;
    };
    const capture = async (page: Page, name: string) => {
      active = page;
      await page.screenshot({ path: join(out, `${variant.name}-${name}.png`), animations: "disabled" });
      const observation = await page.evaluate(() => ({
        title: document.title, route: location.pathname + location.hash.replace(/#\/(?:pair|local-workspace)\/.*/, "#/[credential removed]"),
        headings: [...document.querySelectorAll("h1,h2,h3")].map(element => element.textContent),
        overflow: document.documentElement.scrollWidth > innerWidth,
      }));
      inventory.push({ variant: variant.name, page: name, ...observation });
      assert(!observation.overflow, `${name}: page-wide overflow`);
    };
    try {
      operator.on("pageerror", error => errors.push(error.message));
      await operator.goto(await options.entry());
      await operator.getByTestId("console-add").waitFor();
      assert.equal(await operator.locator(".hc-nav").count(), 0, "One console device-list navigation, not a second sidebar");
      await capture(operator, "console");
      await operator.getByTestId("console-add").click();
      await operator.getByTestId("console-pairing-qr").waitFor();
      const phone = (await state()).pairing.url;
      assert(phone);
      await capture(operator, "phone-invitation");
      await operator.getByTestId("console-pair-close").click();
      const opening = context.waitForEvent("page");
      await operator.getByTestId("console-workspace").click();
      const page = await opening, video = page.video();
      active = page; page.on("pageerror", error => errors.push(error.message));
      await page.getByTestId("onboarding-start").waitFor();
      assert.equal(await page.getByTestId("pair-submit").count(), 0);
      assert.equal((await state()).pairing.url, phone, "Local entry must not replace the phone QR");
      await capture(page, "workspace-first-use");
      await page.getByTestId("onboarding-start").click();
      await page.getByTestId("composer-input").waitFor();
      await capture(page, "chat-empty");
      await page.getByTestId("composer-input").fill("Host page review - synthetic connection check");
      await page.getByTestId("send").click();
      await page.getByText("【连接测试回复，不是 AI 推理】这台 Mac 已收到请求。对话保存在 Mac 的测试工作区。", { exact: false }).first().waitFor();
      const conversation = page.url(), id = new URL(conversation).hash.split("/").at(-1);
      await capture(page, "chat-populated");
      const attachment = await page.request.post(`${options.origin}/api/conversations/${id}/attachments?name=review-note.txt`, {
        data: "Synthetic Host page-review note. No customer data.", headers: { origin: options.origin, "content-type": "text/plain" },
      });
      assert(attachment.ok());
      const uploaded = await attachment.json() as { path: string };
      for (const route of ["files", "schedules"]) {
        await page.goto(`${options.origin}/#/${route}`);
        await page.waitForFunction(() => !!document.querySelector(".file-list > *,.schedules-page > *"));
        await capture(page, route);
        if (route === "files") {
          await page.goto(`${options.origin}/#/file/${uploaded.path.split("/").map(encodeURIComponent).join("/")}`);
          await page.getByText("Synthetic Host page-review note. No customer data.", { exact: false }).waitFor();
          await capture(page, "file-preview");
          await page.getByTestId("file-close").click();
        }
      }
      for (const tab of ["general", "connections", "models", "profile", "security", "about", "permissions", "services", "repositories", "secrets"]) {
        await page.goto(`${options.origin}/#/settings/${tab}`);
        await page.getByTestId("settings").waitFor();
        await page.waitForFunction(() => !!document.querySelector(".settings-body > *"));
        await capture(page, `settings-${tab}`);
        const scroller = page.locator(".settings-body");
        if (await scroller.evaluate(element => element.scrollHeight > element.clientHeight + 20)) {
          await scroller.evaluate(element => { element.scrollTop = element.scrollHeight; });
          await capture(page, `settings-${tab}-bottom`);
          await scroller.evaluate(element => { element.scrollTop = 0; });
        }
        if (tab === "general") {
          await page.getByTestId("notifications-row").click();
          await page.getByTestId("notifications-message").waitFor();
          await capture(page, "notifications");
          await page.getByTestId("notifications-close").click();
        }
        if (tab === "about") {
          await page.getByTestId("whats-new-row").click();
          await page.getByTestId("whats-new-done").waitFor();
          await capture(page, "release-notes");
          await page.getByTestId("whats-new-close").click();
        }
        if (tab === "profile") {
          await page.getByTestId("memory-manage").click();
          await page.getByTestId("memory-input").waitFor();
          await capture(page, "memory");
          await page.getByTestId("dialog-cancel").last().click();
          if (await page.getByTestId("skill-open").count()) {
            await page.getByTestId("skill-open").first().click();
            await page.getByTestId("skill-instructions").waitFor();
            await capture(page, "skill-details");
            await page.getByTestId("skill-close").click();
          }
        }
        if (tab === "permissions") {
          await page.getByTestId("permission-builtin").click();
          await page.getByTestId("permission-builtin-all").waitFor();
          await capture(page, "permissions-built-in");
          await page.getByTestId("permission-group").first().click();
          await page.getByTestId("permission-action").first().waitFor();
          await capture(page, "permissions-actions");
        }
        if (tab === "services") {
          await page.getByTestId("service-open").first().click();
          await page.getByTestId("service-description").waitFor();
          await capture(page, "service-details");
        }
      }
      await page.goto(conversation);
      await page.getByTestId("composer-input").waitFor();
      await capture(page, "return-to-chat");
      const count = (await state()).devices.length, reopening = context.waitForEvent("page");
      await operator.getByTestId("console-workspace").click();
      const reused = await reopening;
      await reused.getByTestId("composer-input").waitFor();
      assert.equal(await reused.getByTestId("pair-submit").count(), 0);
      assert.equal((await state()).devices.length, count, "Do not duplicate a valid browser authorization");
      await capture(reused, "workspace-reused"); await reused.close();
      await page.goto(`${options.origin}/#/settings/security`);
      await page.getByTestId("sign-out").click(); await capture(page, "disconnect-confirmation");
      await page.getByTestId("dialog-cancel").click();
      await page.getByTestId("sign-out").click(); await page.getByTestId("dialog-confirm").click();
      await page.getByTestId("pair-submit").waitFor(); await capture(page, "browser-disconnected");
      const reentry = context.waitForEvent("page");
      await operator.getByTestId("console-workspace").click();
      const returned = await reentry;
      await returned.getByTestId("composer-input").waitFor();
      await capture(returned, "local-reentry-after-disconnect");
      assert.equal((await state()).pairing.url, phone);
      await page.goto(`${options.origin}/#/local-workspace/${"0".repeat(64)}`);
      await page.getByTestId("local-workspace-error").waitFor();
      assert.equal(await page.getByTestId("pair-submit").count(), 0);
      await capture(page, "invalid-local-entry");
      if (variant.language === "en") {
        const fresh = await options.browser.newContext({ viewport: { width: variant.width, height: variant.height } });
        try {
          let submissions = 0;
          await fresh.route("**/api/local-workspace", async route => {
            submissions++;
            const response = await fetch(route.request().url(), { method: "POST",
              headers: { origin: options.origin, "content-type": "application/json" }, body: route.request().postData() });
            assert.equal(response.status, 201);
            await route.abort("failed");
          });
          const local = await fresh.newPage();
          await local.goto(await options.entry());
          await local.getByTestId("console-workspace").waitFor();
          const lost = fresh.waitForEvent("page");
          await local.getByTestId("console-workspace").click();
          const failed = await lost;
          await failed.getByTestId("local-workspace-error").waitFor();
          assert.equal(await failed.getByTestId("pair-submit").count(), 0);
          assert.equal(new URL(failed.url()).hash, "#/");
          assert.equal(submissions, 1, "An uncertain admission must not silently retry");
          await capture(failed, "lost-local-entry-response");
          await fresh.unroute("**/api/local-workspace");
          const recovering = fresh.waitForEvent("page");
          await local.getByTestId("console-workspace").click();
          const recovered = await recovering;
          await recovered.getByTestId("onboarding-start").waitFor();
          await recovered.getByTestId("onboarding-start").click();
          await recovered.getByTestId("composer-input").waitFor();
          await capture(recovered, "lost-local-entry-recovered");
          assert.equal((await state()).pairing.url, phone);
        } finally { await fresh.close(); }
      }
      await context.close();
      if (operatorVideo) await operatorVideo.saveAs(join(out, `${variant.name}-console.webm`));
      if (video) await video.saveAs(join(out, `${variant.name}-workspace.webm`));
    } catch (error) {
      if (!active.isClosed()) await capture(active, "failure");
      throw error;
    } finally { await context.close(); }
  }
  await writeFile(join(out, "inventory.json"), JSON.stringify({
    inventory, errors, realInference: false,
    scope: "Real web-Host desktop/compact pages and available overlays with synthetic data; external logins, real providers, native apps and physical radio states not exercised",
  }, null, 2), { mode: 0o600 });
  assert.deepEqual(errors, []);
}

import assert from "node:assert/strict";
import type { Browser, Page } from "../../../../../../apps/linux/node_modules/playwright-core";

export async function checkConnectionRecovery(options: {
  browser: Browser; invitation(): Promise<string>; screenshot(page: Page, name: string): Promise<void>;
}) {
  const context = await options.browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: "en-US" });
  const page = await context.newPage();
  async function until(condition: () => Promise<boolean>, label: string) {
    const deadline = Date.now() + 15000;
    while (!await condition()) { assert(Date.now() < deadline, label); await Bun.sleep(100); }
  }
  try {
    await page.goto(await options.invitation());
    await page.getByTestId("pair-name").fill("Connection recovery fixture");
    await page.getByTestId("pair-submit").click();
    await page.getByTestId("onboarding-start").click();
    const composer = page.getByTestId("composer-input");
    await composer.fill("Before delivery failure");
    await page.route("**/api/conversations/*/messages", route => route.abort("connectionfailed"), { times: 1 });
    await page.getByTestId("send").click();
    await page.getByTestId("toast-error").waitFor();
    await until(async () => await composer.inputValue() === "Before delivery failure", "Failed send draft retained");
    await page.getByTestId("toast-dismiss").click();
    await page.getByTestId("send").click();
    assert.equal(await page.getByTestId("dialog").count(), 1, "An uncertain send must require explicit confirmation before replay");
    await page.getByTestId("dialog-cancel").click();
    assert.equal(await composer.inputValue(), "Before delivery failure");
    await page.getByTestId("send").click();
    await page.getByTestId("dialog-confirm").click();
    await page.getByText("Before delivery failure", { exact: true }).waitFor();
    await page.getByText("【连接测试回复，不是 AI 推理】这台 Mac 已收到请求。对话保存在 Mac 的测试工作区。", { exact: false }).first().waitFor();
    await composer.fill("Committed but response lost");
    await page.route("**/api/conversations/*/messages", async route => {
      const response = await route.fetch();
      assert(response.ok(), "The owned Host must actually accept the request before losing its response");
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Owned response-loss fixture" }) });
    }, { times: 1 });
    await page.getByTestId("send").click();
    await page.getByTestId("toast-error").waitFor();
    await until(async () => await composer.inputValue() === "Committed but response lost", "Unconfirmed draft retained");
    await page.getByText("Committed but response lost", { exact: true }).waitFor();
    await page.getByTestId("toast-dismiss").click();
    await page.getByTestId("send").click();
    assert.equal(await page.getByTestId("dialog").count(), 1, "A lost successful reply must not silently duplicate the user's message on retry");
    await options.screenshot(page, "connection-uncertain-retry-confirmation");
    await page.getByTestId("dialog-cancel").click();
    assert.equal(await page.getByText("Committed but response lost", { exact: true }).count(), 1);
    const current = new URL(page.url());
    const history = await page.request.get(`${current.origin}/api/conversations/${current.hash.split("/").at(-1)}`);
    assert(history.ok());
    const view = await history.json() as { blocks: { kind: { type: string; text?: string } }[] };
    assert.equal(view.blocks.filter(block => block.kind.type === "userText" && block.kind.text === "Committed but response lost").length, 1);
    await page.getByTestId("send").click();
    await page.getByTestId("dialog-confirm").waitFor();
    await page.goto(`${current.origin}/#/`);
    await page.getByTestId("dialog-confirm").click();
    await page.getByTestId("toast-info").waitFor();
    const afterNavigation = await page.request.get(`${current.origin}/api/conversations/${current.hash.split("/").at(-1)}`);
    assert(afterNavigation.ok());
    const retained = await afterNavigation.json() as { blocks: { kind: { type: string; text?: string } }[] };
    assert.equal(retained.blocks.filter(block => block.kind.type === "userText" && block.kind.text === "Committed but response lost").length, 1);
  } finally { await context.close(); }
}

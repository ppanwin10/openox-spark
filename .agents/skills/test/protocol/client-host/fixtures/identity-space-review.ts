import { rename } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "../../../../../../apps/linux/node_modules/playwright-core";

export async function reviewJourney(paired: Page, prefix: string) {
  const dir = process.env.OPENOX_TEST_ARTIFACTS;
  let page = paired;
  if (dir && process.env.OPENOX_TEST_VIDEO === "1") {
    const size = paired.viewportSize()!, url = new URL(paired.url());
    const context = await paired.context().browser()!.newContext({
      storageState: await paired.context().storageState(), viewport: size, colorScheme: "dark", recordVideo: { dir, size },
    });
    await context.route("**/*", route => new URL(route.request().url()).origin === url.origin ? route.continue() : route.abort());
    await paired.context().close();
    page = await context.newPage();
    await page.goto(url.href);
  }
  return {
    page,
    async capture(name: string, region?: Locator) {
      if (!dir) return;
      await (region ?? page).screenshot({ path: join(dir, `${prefix}-${name}.png`), animations: "disabled" });
      if (page.video()) await Bun.sleep(1500);
    },
    async finish() {
      const video = page.video();
      await page.context().close();
      if (video && dir) await rename(await video.path(), join(dir, `${prefix}.webm`));
    },
  };
}

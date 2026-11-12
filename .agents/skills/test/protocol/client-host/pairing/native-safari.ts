import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

type Created = { sessionId: string; capabilities: { browserName: string; browserVersion: string; acceptInsecureCerts: boolean; platformName: string } };
type Rectangle = { x: number; y: number; width: number; height: number };
type Layout = { visible: boolean; qr: Rectangle; body: Rectangle; dialog: Rectangle; flexBasis: string };
const pairing = '[data-testid="console-pairing-qr"]';

export async function checkNativeSafari(options: { driver: string; entry: string; out: string }) {
  const driver = new URL(options.driver);
  assert(driver.protocol === "http:" && driver.hostname === "127.0.0.1" && driver.pathname === "/" && !driver.search && !driver.hash
    && !driver.username && !driver.password, "Use an explicitly started local Safari driver, not a remote service");
  let session: Created | undefined;
  const cache = await mkdtemp(join(options.out, "native-swift-"));
  async function request<T>(method: string, path: string, value?: unknown): Promise<T> {
    const response = await fetch(new URL(path, driver), { method, signal: AbortSignal.timeout(20000),
      ...(value === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(value) }) });
    const body = await response.json() as { value: T & { error?: string; message?: string } };
    if (!response.ok || body.value?.error) throw new Error(`Native Safari ${body.value?.error ?? response.status}: ${body.value?.message ?? "operation failed"}`);
    return body.value;
  }
  const wd = <T>(method: string, path: string, value?: unknown) => request<T>(method, `/session/${session!.sessionId}${path}`, value);
  const script = <T>(source: string) => wd<T>("POST", "/execute/sync", { script: source, args: [] });
  async function until(condition: () => Promise<boolean>, label: string) {
    const deadline = Date.now() + 15000;
    while (!await condition()) { assert(Date.now() < deadline, label); await Bun.sleep(100); }
  }
  async function click(id: string) {
    const handle = await wd<string>("GET", "/window");
    await wd("POST", "/window", { handle });
    const element = await wd<Record<string, string>>("POST", "/element", { using: "css selector", value: `[data-testid="${id}"]` });
    await wd("POST", `/element/${element["element-6066-11e4-a52e-4f735466cecf"]}/click`, {});
  }
  async function capture(name: string) {
    await until(() => script("return document.getAnimations().every(animation => animation.playState !== 'running' || !Number.isFinite(animation.effect?.getComputedTiming().endTime));"),
      "Native Safari finite animations must settle before visual capture");
    const bytes = await wd<string>("GET", "/screenshot");
    await writeFile(join(options.out, `${name}.png`), Buffer.from(bytes, "base64"), { mode: 0o600 });
  }
  let failure: string | null = null;
  try {
    const precondition = Bun.spawn(["/usr/bin/xcrun", "swift", "-module-cache-path", cache, "-e",
      'import CoreGraphics; import Foundation; import Darwin; guard let state = CGSessionCopyCurrentDictionary() as? [String:Any], state[kCGSessionOnConsoleKey as String] as? Bool == true else { exit(2) }; exit(state["CGSSessionScreenIsLocked"] as? Bool == true ? 3 : 0)'],
    { env: { HOME: homedir(), PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "en_US.UTF-8" }, stdout: "ignore", stderr: "pipe" });
    const [exit, error] = await Promise.all([precondition.exited, new Response(precondition.stderr).text()]);
    assert.equal(exit, 0, exit === 3 ? "Native Safari requires an unlocked Mac; a locked-session black screenshot is not a product test"
      : `Cannot establish the native Safari console precondition: ${error.trim()}`);
    session = await request<Created>("POST", "/session", { capabilities: {
      alwaysMatch: { browserName: "safari", platformName: "mac", acceptInsecureCerts: false },
    } });
    assert(session.sessionId && session.capabilities.browserName.toLowerCase() === "safari");
    assert.equal(session.capabilities.acceptInsecureCerts, false);
    await wd("POST", "/timeouts", { pageLoad: 15000, script: 10000, implicit: 0 });
    await wd("POST", "/window/rect", { x: 0, y: 30, width: 1365, height: 900 });
    await wd("POST", "/url", { url: options.entry });
    await until(() => script(`return !!document.querySelector('[data-testid="console-add"]');`), "Authorized native Safari console");
    await click("console-add");
    await until(() => script(`return !!document.querySelector('${pairing}');`), "Native Safari QR creation");
    const previous = await script<string>(`return document.querySelector('${pairing}').getAttribute('data-link');`);
    await capture("native-safari-qr-before");
    await click("console-pair-regenerate");
    await until(() => script(`return !!document.querySelector('${pairing}')
      && document.querySelector('${pairing}').getAttribute('data-link') !== ${JSON.stringify(previous)};`), "Native Safari active QR replacement");
    const layout = await script<Layout>(`const element=document.querySelector('${pairing}'), body=element.closest('.sheet-body'), dialog=element.closest('dialog');
      const q=element.getBoundingClientRect(), b=body.getBoundingClientRect(), d=dialog.getBoundingClientRect();
      const rect=r=>({x:r.x,y:r.y,width:r.width,height:r.height});
      return {visible:q.width>0&&q.height>0&&q.top>=b.top-1&&q.bottom<=b.bottom+1
        &&q.left>=b.left-1&&q.right<=b.right+1&&q.top>=0&&q.bottom<=innerHeight,
        qr:rect(q),body:rect(b),dialog:rect(d),flexBasis:getComputedStyle(body).flexBasis};`);
    await capture("native-safari-qr-after");
    assert(layout.visible, "PA-02: the whole native Safari QR must be visible, not hidden inside a collapsed scroll region");
    assert(await script(`return document.querySelector('[data-testid="console-pair-regenerate"]').disabled === false;`));
    const current = await script<string>(`return document.querySelector('${pairing}').getAttribute('data-link');`);
    await writeFile(join(options.out, "native-safari.json"), JSON.stringify({
      case: "PA-02", outcome: "passed", browser: session.capabilities, layout, normalTLS: true,
      input: "Native WebDriver visible element clicks", rawPairingCredentialsRetained: false,
      renderedInvitationSHA256: new Bun.CryptoHasher("sha256").update(current).digest("hex"),
    }, null, 2), { mode: 0o600 });
  } catch (error) {
    failure = (error instanceof Error ? error.message : String(error)).replace(/#claim=[a-f0-9]{64}/g, "#claim=[redacted]")
      .replace(/#\/pair\/[A-Z0-9-]+/g, "#/pair/[redacted]");
    if (session) await capture("native-safari-failure");
    await writeFile(join(options.out, "native-safari.json"), JSON.stringify({
      case: "PA-02", outcome: "failed", failure, browser: session?.capabilities ?? null,
    }, null, 2), { mode: 0o600 });
    throw new Error(failure);
  } finally {
    try { if (session) await request("DELETE", `/session/${session.sessionId}`); }
    finally { await rm(cache, { recursive: true, force: true }); }
  }
}

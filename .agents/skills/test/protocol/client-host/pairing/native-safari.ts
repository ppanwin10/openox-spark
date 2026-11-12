import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

type Created = { sessionId: string; capabilities: { browserName: string; browserVersion: string; acceptInsecureCerts: boolean; platformName: string } };
type Rectangle = { x: number; y: number; width: number; height: number };
type Layout = { visible: boolean; qr: Rectangle; body: Rectangle; dialog: Rectangle; flexBasis: string };
const pairing = '[data-testid="console-pairing-qr"]';

export async function checkNativeSafari(options: { driver: string; entry: string; out: string; workspacePages?: boolean; hostLifecycle?: boolean }) {
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
    await wd("POST", "/execute/async", { script: "const done=arguments[arguments.length-1]; requestAnimationFrame(()=>requestAnimationFrame(()=>done(true)));", args: [] });
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
    const current = await script<string>(`return document.querySelector('${pairing}').getAttribute('data-link');`);
    await capture("native-safari-qr-after");
    assert(layout.visible, "PA-02: the whole native Safari QR must be visible, not hidden inside a collapsed scroll region");
    assert(await script(`return document.querySelector('[data-testid="console-pair-regenerate"]').disabled === false;`));
    assert(await script<string>(`return document.querySelector('${pairing}').getAttribute('data-link');`) === current,
      "The invitation changed during native capture; do not compare a screenshot against a later code");
    const operator = await wd<string>("GET", "/window");
    const localState = () => wd<{ count: number; phone: string | null }>("POST", "/execute/async", {
      script: "const done=arguments[arguments.length-1]; fetch(new URL('api/state',location.href),{credentials:'same-origin'}).then(r=>r.json()).then(s=>done({count:s.devices.length,phone:s.pairing.url??null}));",
      args: [],
    });
    await click("console-pair-close");
    if (options.hostLifecycle) {
      assert(await script("return document.querySelectorAll('.hc-facts').length===0;"), "Native default console must not be a technical-details landing page");
      await click("console-power");
      await until(() => script("return !!document.querySelector('[data-testid=\"dialog-confirm\"]');"), "Native stop confirmation");
      await capture("native-safari-stop-confirmation");
      await click("dialog-cancel");
      assert(await script("return document.querySelector('[data-testid=\"console-status\"]').dataset.state==='running';"));
      await click("console-power"); await click("dialog-confirm");
      await until(() => script("return document.querySelector('[data-testid=\"console-status\"]').dataset.state==='stopped';"), "Native stopped Host with live console");
      assert(await script("return document.querySelector('[data-testid=\"console-workspace\"]').disabled&&document.querySelector('[data-testid=\"console-add\"]').disabled;"));
      await capture("native-safari-host-stopped");
      await click("console-power");
      await until(() => script("return document.querySelector('[data-testid=\"console-status\"]').dataset.state==='running';"), "Native restarted Host");
      await capture("native-safari-host-running");
      assert.equal((await localState()).phone, current);
    }
    let firstCount = 0;
    for (let attempt = 0; attempt < 2; attempt++) {
      const previousWindows = await wd<string[]>("GET", "/window/handles");
      await click("console-workspace");
      await until(async () => (await wd<string[]>("GET", "/window/handles")).some(handle => !previousWindows.includes(handle)),
        "Native workspace window must open");
      const target = (await wd<string[]>("GET", "/window/handles")).find(handle => !previousWindows.includes(handle));
      assert(target);
      await wd("POST", "/window", { handle: target });
      await until(() => script("return !!document.querySelector('[data-testid=\"composer-input\"],[data-testid=\"local-workspace-error\"],[data-testid=\"pair-submit\"]');"),
        "Native local workspace entry must complete");
      assert(await script("return !document.querySelector('[data-testid=\"pair-submit\"],[data-testid=\"local-workspace-error\"]');"),
        "Native local entry must not show a new pairing or an authorization failure");
      if (await script("return !!document.querySelector('[data-testid=\"onboarding-start\"]');")) await click("onboarding-start");
      await until(() => script("return !!document.querySelector('[data-testid=\"composer-input\"]');"), "Native workspace composer");
      await capture(`native-safari-workspace-${attempt}`);
      if (attempt === 0 && options.workspacePages) {
        const origin = await script<string>("return location.origin;");
        await wd("POST", "/url", { url: `${origin}/#/settings/profile` });
        await until(() => script("return !!document.querySelector('[data-testid=\"skill-open\"]');"), "Native workspace skills");
        await click("skill-open");
        await until(() => script("return !!document.querySelector('[data-testid=\"skill-instructions\"]');"), "Native skill instructions");
        await capture("native-safari-skill-details");
        assert(await script(`const content=document.querySelector('[data-testid="skill-instructions"]'), body=content.closest('.sheet-body');
          const text=content.getBoundingClientRect(), region=body.getBoundingClientRect();
          return region.height>60&&text.top>=region.top-1&&text.top<region.bottom-20;`),
        "Native skill instructions must be visible inside an uncollapsed sheet body");
        await click("skill-close");
        await click("settings-tab-general");
        await until(() => script("return !!document.querySelector('[data-testid=\"notifications-row\"]');"), "Native General settings");
        await click("notifications-row");
        await until(() => script("return !!document.querySelector('[data-testid=\"notifications-message\"]');"), "Native notification state");
        await capture("native-safari-notifications");
        assert(await script("return document.querySelector('[data-testid=\"notifications\"] .stay-notified').getBoundingClientRect().height>60;"),
          "Native notification status must remain readable");
        await click("notifications-close");
        await click("settings-tab-about");
        await until(() => script("return !!document.querySelector('[data-testid=\"whats-new-row\"]');"), "Native About settings");
        await click("whats-new-row");
        await until(() => script("return !!document.querySelector('[data-testid=\"whats-new-done\"]');"), "Native release notes");
        await capture("native-safari-release-notes");
        assert(await script("return document.querySelector('[data-testid=\"whats-new\"] .sheet-body').getBoundingClientRect().height>60;"),
          "Native release notes must be readable inside an uncollapsed sheet body");
        await click("whats-new-close");
      }
      await wd("DELETE", "/window");
      await wd("POST", "/window", { handle: operator });
      const observed = await localState();
      assert(observed.phone === current, "Native workspace entry must preserve the phone invitation");
      if (attempt === 0) firstCount = observed.count;
      else assert.equal(observed.count, firstCount, "A returning native browser must reuse its authorization");
    }
    await writeFile(join(options.out, "native-safari.json"), JSON.stringify({
      case: "PA-02", outcome: "passed", browser: session.capabilities, layout, normalTLS: true,
      input: "Native WebDriver visible element clicks", rawPairingCredentialsRetained: false,
      renderedInvitationSHA256: new Bun.CryptoHasher("sha256").update(current).digest("hex"),
      localWorkspaceEntry: true, existingBrowserReused: true, phoneInvitationPreserved: true,
      nativeWorkspaceSheets: !!options.workspacePages,
      nativeHostLifecycle: !!options.hostLifecycle,
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

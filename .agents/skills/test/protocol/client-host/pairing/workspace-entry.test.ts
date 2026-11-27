import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Host } from "../../../../../../apps/linux/src/host";
import { startServer } from "../../../../../../apps/linux/src/server";
import { startHostConsole } from "../../../../../../apps/linux/scripts/mac-host-console";
import { ROOT } from "../../../../../lib";

test("PA-13: local workspace entry reuses the browser and leaves the pending phone invitation unchanged", async () => {
  const data = await mkdtemp(join(tmpdir(), "ox-local-workspace-"));
  const host = await Host.open({ data, hostID: "Local workspace fixture", version: "fixture", quiet: true });
  const server = await startServer(host, { hostname: "127.0.0.1", port: 0 });
  const origin = `http://127.0.0.1:${server.port}`;
  const control = await startHostConsole(host, origin, new Date(Date.now() + 86400000).toISOString());
  try {
    const controlOrigin = new URL(control.url).origin, link = control.link();
    const claim = new URLSearchParams(new URL(link.url).hash.slice(1)).get("claim");
    const claimed = await fetch(`${control.url}api/claim`, { method: "POST",
      headers: { origin: controlOrigin, "content-type": "application/json" }, body: JSON.stringify({ claim }) });
    expect(claimed.status).toBe(200);
    const cookie = claimed.headers.get("set-cookie")!.split(";")[0]!;
    const state = await (await fetch(`${control.url}api/state`, { headers: { cookie } })).json() as { csrf: string };
    const form = () => fetch(`${control.url}api/workspace`, { method: "POST", redirect: "manual",
      headers: { cookie, origin: controlOrigin, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf: state.csrf }) });
    expect((await fetch(`${control.url}api/workspace`, { method: "POST", headers: { origin: controlOrigin } })).status).toBe(401);
    expect((await fetch(`${control.url}api/workspace`, { method: "POST", headers: {
      cookie, origin: controlOrigin, "content-type": "application/x-www-form-urlencoded" }, body: "" })).status).toBe(403);
    const phone = await host.devices.createPairingCode();
    const before = await readFile(host.paths.pairing, "utf8");
    const issued = await form();
    expect(issued.status).toBe(303);
    const target = new URL(issued.headers.get("location")!);
    expect(target.origin).toBe(origin);
    expect(target.search).toBe("");
    expect(target.hash.startsWith("#/local-workspace/")).toBe(true);
    expect((await host.devices.list()).length).toBe(0);
    const grant = target.hash.slice("#/local-workspace/".length);
    const open = (value: string, browserCookie?: string, requestOrigin = origin) => fetch(`${origin}/api/local-workspace`, {
      method: "POST", headers: { origin: requestOrigin, "content-type": "application/json", ...(browserCookie ? { cookie: browserCookie } : {}) },
      body: JSON.stringify({ grant: value, name: "This Mac's browser" }),
    });
    expect((await open(grant, undefined, "https://foreign.example")).status).toBe(403);
    expect((await fetch(`${origin}/api/local-workspace`, { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ grant }) })).status).toBe(403);
    expect((await fetch(`${origin}/api/local-workspace`, { method: "POST",
      headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ grant, name: "x".repeat(5000) }) })).status).toBe(413);
    for (const body of ["null", "[]"]) expect((await fetch(`${origin}/api/local-workspace`, { method: "POST",
      headers: { origin, "content-type": "application/json" }, body })).status).toBe(400);
    const opened = await open(grant);
    expect(opened.status).toBe(201);
    const browserCookie = opened.headers.get("set-cookie")!.split(";")[0]!;
    expect(opened.headers.get("set-cookie")).toContain("HttpOnly; SameSite=Strict");
    expect(await (await fetch(`${origin}/api/session`, { headers: { cookie: browserCookie } })).json()).toMatchObject({ paired: true });
    expect((await open(grant, browserCookie)).status).toBe(403);
    const again = new URL((await form()).headers.get("location")!).hash.slice("#/local-workspace/".length);
    const reused = await open(again, browserCookie);
    expect(reused.status).toBe(200);
    expect(reused.headers.get("set-cookie")).toBeNull();
    expect((await host.devices.list()).length).toBe(1);
    expect(await readFile(host.paths.pairing, "utf8")).toBe(before);
    expect((await fetch(`${origin}/api/pair`, { method: "POST", headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ code: phone.code, name: "Phone invitation still works" }) })).status).toBe(201);
    const expired = host.devices.createWorkspaceGrant(-1000);
    expect((await open(expired.grant)).status).toBe(403);
    const abandoned = host.devices.createWorkspaceGrant();
    await control.close();
    expect((await open(abandoned.grant)).status).toBe(404);
  } finally {
    if (host.localWorkspaceOrigin) await control.close();
    await server.stop(true); await host.close(); await rm(data, { recursive: true, force: true });
  }
}, 30000);

test("PA-13: ordinary Hosts do not expose local admission and grants cannot authorize a different Host", async () => {
  const roots = await Promise.all([0, 1].map(() => mkdtemp(join(tmpdir(), "ox-workspace-isolation-"))));
  const hosts = await Promise.all(roots.map(data => Host.open({ data, hostID: "Host isolation fixture", version: "fixture", quiet: true })));
  const servers = await Promise.all(hosts.map(host => startServer(host, { hostname: "127.0.0.1", port: 0 })));
  const origins = servers.map(server => `http://127.0.0.1:${server.port}`);
  const controls: Awaited<ReturnType<typeof startHostConsole>>[] = [];
  try {
    const request = (index: number, grant: string) => fetch(`${origins[index]}/api/local-workspace`, {
      method: "POST", headers: { origin: origins[index]!, "content-type": "application/json" }, body: JSON.stringify({ grant }),
    });
    expect((await request(0, "0".repeat(64))).status).toBe(404);
    for (let index = 0; index < hosts.length; index++) controls.push(await startHostConsole(hosts[index]!, origins[index]!, new Date().toISOString()));
    const grant = hosts[0]!.devices.createWorkspaceGrant();
    expect((await request(1, grant.grant)).status).toBe(403);
    const raced = await Promise.all([request(0, grant.grant), request(0, grant.grant)]);
    expect(raced.map(response => response.status).sort()).toEqual([201, 403]);
    expect((await hosts[0]!.devices.list()).length).toBe(1);
    expect((await hosts[1]!.devices.list()).length).toBe(0);
  } finally {
    await Promise.all(controls.map(control => control.close()));
    await Promise.all(servers.map(server => server.stop(true)));
    await Promise.all(hosts.map(host => host.close()));
    await Promise.all(roots.map(data => rm(data, { recursive: true, force: true })));
  }
}, 30000);

test("LP-03: opt-in browser cookie scopes preserve other local Hosts during admission and logout", async () => {
  const roots = await Promise.all([0, 1].map(() => mkdtemp(join(tmpdir(), "ox-cookie-scope-"))));
  const scope = "ox_personal_fixture";
  const hosts = [await Host.open({ data: roots[0]!, hostID: "Existing Host", version: "fixture", quiet: true }),
    await Host.open({ data: roots[1]!, hostID: "Independent preview", version: "fixture", quiet: true, browserCookieName: scope })];
  const servers = await Promise.all(hosts.map(host => startServer(host, { hostname: "127.0.0.1", port: 0 })));
  const origins = servers.map(server => `http://127.0.0.1:${server.port}`);
  hosts.forEach((host, index) => { host.localWorkspaceOrigin = origins[index]!; });
  const open = (index: number, cookie?: string) => fetch(`${origins[index]}/api/local-workspace`, {
    method: "POST", headers: { origin: origins[index]!, "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify({ grant: hosts[index]!.devices.createWorkspaceGrant().grant }),
  });
  const session = async (index: number, cookie: string) => await (await fetch(`${origins[index]}/api/session`, { headers: { cookie } })).json() as { paired: boolean };
  try {
    const legacy = (await open(0)).headers.get("set-cookie")!.split(";")[0]!;
    const preview = await open(1, legacy);
    expect(preview.status).toBe(201);
    const current = preview.headers.get("set-cookie")!.split(";")[0]!;
    expect(current.split("=")[0]).toBe(scope);
    expect(legacy.split("=")[0]).toBe("ox_device");
    const both = `${legacy}; ${current}`;
    expect((await session(0, both)).paired).toBe(true);
    expect((await session(1, both)).paired).toBe(true);
    expect((await session(1, legacy)).paired).toBe(false);
    expect((await session(0, current)).paired).toBe(false);
    const reused = await open(1, both);
    expect(reused.status).toBe(200);
    expect(reused.headers.get("set-cookie")).toBeNull();
    expect(await hosts[1]!.devices.list()).toHaveLength(1);
    const logout = await fetch(`${origins[1]}/api/logout`, { method: "POST", headers: { origin: origins[1]!, cookie: both } });
    expect(logout.status).toBe(200);
    expect(logout.headers.get("set-cookie")!.split("=")[0]).toBe(scope);
    expect((await session(0, both)).paired).toBe(true);
    expect((await session(1, both)).paired).toBe(false);
  } finally {
    await Promise.all(servers.map(server => server.stop(true)));
    await Promise.all(hosts.map(host => host.close()));
    await Promise.all(roots.map(data => rm(data, { recursive: true, force: true })));
  }
}, 30_000);

test.skipIf(process.platform !== "darwin" || process.arch !== "arm64")("LP-01/02/04: the personal Mac bundle runs the real isolated Host and retains data after owned restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ox-personal-package-")), output = join(directory, "out"), extracted = join(directory, "unpacked"), data = join(directory, "data");
  let service: ReturnType<typeof Bun.spawn> | undefined;
  const competing: ReturnType<typeof Bun.spawn>[] = [];
  const command = async (args: string[], cwd = ROOT) => {
    const process = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()]);
    return { code, stdout, stderr };
  };
  const app = join(extracted, "OpenOx Personal Preview.app"), resources = join(app, "Contents/Resources");
  const bun = join(resources, "bin/bun"), script = join(resources, "runtime/apps/linux/scripts/personal-preview.ts");
  const run = async () => {
    const child = service = Bun.spawn([bun, "--no-env-file", script, "serve", "--data", data], { cwd: directory, stdout: "pipe", stderr: "pipe" });
    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        const state = JSON.parse(await readFile(join(data, "run.json"), "utf8")) as { state: string; origin: string; socket: string; nonce: string; pid: number };
        if (state.state === "running" && state.pid === child.pid) return state;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (child.exitCode !== null) throw new Error(`The packaged preview exited before readiness: ${await new Response(child.stderr).text()}`);
      if (Date.now() > deadline) throw new Error("The packaged preview did not become ready");
      await Bun.sleep(100);
    }
  };
  const entry = async () => {
    const result = await command([bun, "--no-env-file", script, "open", "--data", data, "--no-open", "--no-start"], directory);
    expect(result.code).toBe(0);
    return JSON.parse(result.stdout) as { url: string };
  };
  try {
    const built = await command([process.execPath, `${ROOT}/apps/linux/scripts/package-mac-host.ts`, "--personal-preview", "--out", output]);
    expect(built.code, built.stderr).toBe(0);
    expect((await command(["/usr/bin/ditto", "-x", "-k", join(output, "OpenOx-Personal-Preview-arm64.zip"), extracted])).code).toBe(0);
    const build = JSON.parse(await readFile(join(resources, "BUILD.json"), "utf8")) as { personalPreview: boolean; bundledIdentityOrCredentials: boolean };
    expect(build).toMatchObject({ personalPreview: true, bundledIdentityOrCredentials: false });
    let running = await run();
    const originalOrigin = running.origin;
    expect((await stat(data)).mode & 0o077).toBe(0);
    expect((await stat(running.socket)).mode & 0o077).toBe(0);
    const link = new URL((await entry()).url), grant = /^#\/local-workspace\/([a-f0-9]{64})\/home$/.exec(link.hash)![1]!;
    expect(link.origin).toBe(running.origin);
    const opened = await fetch(`${running.origin}/api/local-workspace`, { method: "POST",
      headers: { origin: running.origin, "content-type": "application/json" }, body: JSON.stringify({ grant }) });
    expect(opened.status).toBe(201);
    const cookie = opened.headers.get("set-cookie")!.split(";")[0]!;
    expect(cookie.split("=")[0]).not.toBe("ox_device");
    const settings = await (await fetch(`${running.origin}/api/settings`, { headers: { cookie } })).json() as { defaultModel: unknown; profile: { id: string } };
    expect(settings.defaultModel).toBeNull();
    const created = await fetch(`${running.origin}/api/todos`, { method: "POST", headers: { cookie, origin: running.origin, "content-type": "application/json", "idempotency-key": "packaged-preview-todo" },
      body: JSON.stringify({ title: "Package persistence fixture" }) });
    expect(created.status).toBe(201);
    const denied = await fetch("http://owner/", { unix: running.socket, method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "stop", nonce: "not-the-owner" }) });
    expect(denied.status).toBe(403);
    expect((await command([bun, "--no-env-file", script, "stop", "--data", data])).code).toBe(0);
    expect(await service!.exited).toBe(0);
    service = undefined;
    running = await run();
    expect(running.origin).toBe(originalOrigin);
    const retained = await (await fetch(`${running.origin}/api/todos`, { headers: { cookie } })).json() as { todos: { title: string }[] };
    expect(retained.todos.map(todo => todo.title)).toContain("Package persistence fixture");
    const restored = await (await fetch(`${running.origin}/api/settings`, { headers: { cookie } })).json() as { profile: { id: string }; defaultModel: unknown };
    expect(restored.profile.id).toBe(settings.profile.id);
    expect(restored.defaultModel).toBeNull();
    const active = await command([bun, "--no-env-file", script, "serve", "--data", data]);
    expect(active.code).not.toBe(0);
    expect((await fetch(`${running.origin}/api/health`)).ok).toBe(true);
    const lockPath = join(data, "run.lock"), recordPath = join(data, "run.json");
    const lock = await readFile(lockPath, "utf8"), record = await readFile(recordPath, "utf8");
    service!.kill("SIGKILL");
    await service!.exited;
    service = undefined;
    const foreign = JSON.stringify({ ...JSON.parse(lock), script: `${script}-foreign` });
    await writeFile(lockPath, foreign, { mode: 0o600 });
    const refused = await command([bun, "--no-env-file", script, "serve", "--data", data]);
    expect(refused.code).not.toBe(0);
    expect(await readFile(lockPath, "utf8")).toBe(foreign);
    expect(await readFile(recordPath, "utf8")).toBe(record);
    await writeFile(lockPath, lock, { mode: 0o600 });
    await rm(running.socket, { force: true });
    const foreignControl = Bun.serve({ unix: running.socket, fetch: () => new Response("Not this preview", { status: 403 }) });
    await chmod(running.socket, 0o600);
    try {
      const blocked = await command([bun, "--no-env-file", script, "serve", "--data", data]);
      expect(blocked.code).not.toBe(0);
      expect(blocked.stderr).toContain("control channel is still active");
      expect((await fetch("http://foreign/", { unix: running.socket })).status).toBe(403);
      expect(await readFile(lockPath, "utf8")).toBe(lock);
      expect(await readFile(recordPath, "utf8")).toBe(record);
    } finally { foreignControl.stop(true); await rm(running.socket, { force: true }); }
    competing.push(...[0, 1].map(() => Bun.spawn([bun, "--no-env-file", script, "serve", "--data", data],
      { cwd: directory, stdout: "pipe", stderr: "pipe" })));
    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        const state = JSON.parse(await readFile(recordPath, "utf8")) as typeof running;
        if (state.state === "running" && competing.some(child => child.pid === state.pid && child.exitCode === null)) {
          running = state; service = competing.find(child => child.pid === state.pid); break;
        }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (Date.now() > deadline) throw new Error("Competing owned recovery did not produce one ready preview");
      await Bun.sleep(100);
    }
    const loser = competing.find(child => child !== service)!;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; loser.kill("SIGTERM"); }, 5_000);
    const lost = await loser.exited;
    clearTimeout(timer);
    expect(timedOut).toBe(false); expect(lost).not.toBe(0);
    expect(running.origin).toBe(originalOrigin);
    const recovered = await (await fetch(`${running.origin}/api/todos`, { headers: { cookie } })).json() as { todos: { title: string }[] };
    expect(recovered.todos.map(todo => todo.title)).toContain("Package persistence fixture");
    expect(await (await fetch(`${running.origin}/api/session`, { headers: { cookie } })).json()).toMatchObject({ paired: true });
    expect((await command([bun, "--no-env-file", script, "stop", "--data", data])).code).toBe(0);
    expect(await service!.exited).toBe(0);
    service = undefined;
  } finally {
    if (service) { service.kill("SIGTERM"); await service.exited; }
    for (const child of competing) if (child.exitCode === null) { child.kill("SIGTERM"); await child.exited; }
    await rm(directory, { recursive: true, force: true });
  }
}, 180_000);

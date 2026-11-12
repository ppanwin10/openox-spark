import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Host } from "../../../../../../apps/linux/src/host";
import { startServer } from "../../../../../../apps/linux/src/server";
import { startHostConsole } from "../../../../../../apps/linux/scripts/mac-host-console";

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

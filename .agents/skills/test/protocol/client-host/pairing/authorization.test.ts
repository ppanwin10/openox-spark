import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Host } from "../../../../../../apps/linux/src/host";
import { startServer } from "../../../../../../apps/linux/src/server";

test("PA-01/06/09: viewing, replacing, expiring and racing invitations never grants unintended access", async () => {
  const data = await mkdtemp(join(tmpdir(), "ox-pairing-admission-"));
  const host = await Host.open({ data, hostID: "Pairing acceptance", version: "fixture", quiet: true });
  const server = await startServer(host, { hostname: "127.0.0.1", port: 0 });
  const origin = `http://127.0.0.1:${server.port}`;
  const pair = (code: string, name = "Fixture browser") => fetch(`${origin}/api/pair`, {
    method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ code, name }),
  });
  try {
    const invitation = await host.devices.createPairingCode();
    expect((await fetch(`${origin}/#/pair/${invitation.code}`)).status).toBe(200);
    expect(await (await fetch(`${origin}/api/session`)).json()).toMatchObject({ paired: false });
    expect((await host.devices.list()).length).toBe(0);
    const attempts = await Promise.all([pair(invitation.code, "First fixture"), pair(invitation.code, "Second fixture")]);
    expect(attempts.map(response => response.status).sort()).toEqual([201, 403]);
    expect((await host.devices.list()).length).toBe(1);
    const replaced = await host.devices.createPairingCode();
    const replacement = await host.devices.createPairingCode();
    expect((await pair(replaced.code)).status).toBe(403);
    expect((await pair(replacement.code)).status).toBe(201);
    const expired = await host.devices.createPairingCode(-1000);
    expect((await pair(expired.code)).status).toBe(403);
    const limited = await host.devices.createPairingCode();
    for (let attempt = 0; attempt < 5; attempt++) expect((await pair("0000-0000")).status).toBe(403);
    expect((await pair(limited.code)).status).toBe(403);
    expect((await host.devices.list()).length).toBe(2);
    const fresh = await host.devices.createPairingCode();
    expect((await pair(fresh.code)).status).toBe(201);
  } finally {
    await server.stop(true);
    await host.close();
    await rm(data, { recursive: true, force: true });
  }
}, 30000);

test("PA-07/CN-06: revocation closes a live stream and rejects old-cookie reads, sends and reconnects", async () => {
  const data = await mkdtemp(join(tmpdir(), "ox-pairing-revoke-"));
  const host = await Host.open({ data, hostID: "Revocation acceptance", version: "fixture", quiet: true });
  const server = await startServer(host, { hostname: "127.0.0.1", port: 0 });
  const origin = `http://127.0.0.1:${server.port}`;
  const controller = new AbortController();
  try {
    const owner = await host.devices.add("Fixture operator", "cli");
    const invitation = await host.devices.createPairingCode();
    const paired = await fetch(`${origin}/api/pair`, { method: "POST",
      headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ code: invitation.code, name: "Fixture phone" }) });
    expect(paired.status).toBe(201);
    const cookie = paired.headers.get("set-cookie")!.split(";")[0]!;
    const session = await (await fetch(`${origin}/api/session`, { headers: { cookie } })).json() as { device: { id: string } };
    const stream = await fetch(`${origin}/api/events?tab=fixture-tab&visible=1`, { headers: { cookie }, signal: controller.signal });
    const reader = stream.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("event: ready");
    expect(host.notifications.webSessions(session.device.id)).toBe(1);
    const revoked = await fetch(`${origin}/api/devices/${session.device.id}`, {
      method: "DELETE", headers: { authorization: `Bearer ${owner.token}`, origin },
    });
    expect(revoked.status).toBe(200);
    const timeout = setTimeout(() => controller.abort(), 5000);
    try { expect((await reader.read()).done).toBe(true); }
    finally { clearTimeout(timeout); reader.releaseLock(); }
    expect(host.notifications.webSessions(session.device.id)).toBe(0);
    for (const path of ["/api/settings", "/api/conversations", "/api/events"]) {
      expect((await fetch(`${origin}${path}`, { headers: { cookie } })).status).toBe(401);
    }
    expect((await fetch(`${origin}/api/conversations/1/messages`, { method: "POST", headers: { cookie, origin, "content-type": "application/json" },
      body: JSON.stringify({ text: "Must not run" }) })).status).toBe(401);
    expect(await (await fetch(`${origin}/api/session`, { headers: { cookie } })).json()).toMatchObject({ paired: false });
    expect((await host.devices.list()).map(device => device.name)).toEqual(["Fixture operator"]);
  } finally {
    controller.abort();
    await server.stop(true);
    await host.close();
    await rm(data, { recursive: true, force: true });
  }
}, 30000);

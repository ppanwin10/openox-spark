#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { renderANSI } from "uqr";
import { Host } from "./host";
import { startServer } from "./server";
import { Devices } from "./auth";
import { defaultDataDirectory, hostPaths, prepareDirectories } from "./config";
import { checkLocalAddress, invitation, localHint, localIdentity, publishLocal } from "./connections";
import packageMetadata from "../package.json";

process.umask(0o077);

const usage = `OpenOx Linux Host ${packageMetadata.version}

Usage: openox-host <command> [options]

Commands:
  serve                 Run the Host (web app, Host API and agent runtime)
  pair                  Create a one-time code for pairing a phone or browser
  token --name <name>   Create a device token for the ox CLI (OX_HOST_TOKEN)
  devices               List paired devices
  revoke <device-id>    Remove a paired device

Options:
  --data <dir>          Host data directory (default: ${defaultDataDirectory()})
  --listen <address>    Listening address for serve (default: 127.0.0.1)
  --port <port>         Listening port for serve (default: 9876)
  --name <name>         Host name for serve, or device name for token
  --url <address>       Address phones use to reach this Host, for the pair QR code
                        (default: OPENOX_PUBLIC_URL, then the deploy/tailscale.sh address)
  --tls-cert <file>     TLS certificate chain for serve (requires --tls-key)
  --tls-key <file>      TLS private key for serve (requires --tls-cert)
  --local-network <ip> Add encrypted LAN access on an assigned private IPv4 address
                        (loopback remains available; requires OpenSSL)
`;

async function publicURL(configured?: string) {
  if (configured) {
    let url: URL;
    try { url = new URL(configured); } catch { console.error(`--url must be an address such as https://host.example.com`); process.exit(2); }
    if (!["http:", "https:"].includes(url.protocol)) { console.error("--url must start with http:// or https://"); process.exit(2); }
    return url.origin;
  }
  const bin = join(homedir(), ".local", "tailscale", "tailscale");
  const socket = join(process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 0}`, "openox-tailscale", "tailscaled.sock");
  if (!existsSync(bin) || !existsSync(socket)) return undefined;
  const child = Bun.spawn([bin, `--socket=${socket}`, "status", "--json"], { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
  const timer = setTimeout(() => child.kill(), 5_000);
  const status = await new Response(child.stdout).json().catch(() => undefined) as { Self?: { DNSName?: string } } | undefined;
  clearTimeout(timer);
  const name = status?.Self?.DNSName?.replace(/\.$/, "");
  return name ? `https://${name}` : undefined;
}

function options(args: string[]) {
  const values: Record<string, string> = {};
  const positional: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (argument === "--help" || argument === "-h") { console.log(usage); process.exit(0); }
    if (!argument.startsWith("--")) { positional.push(argument); continue; }
    const [key, inline] = argument.slice(2).split("=", 2) as [string, string | undefined];
    if (!["data", "listen", "port", "name", "url", "tls-cert", "tls-key", "local-network"].includes(key)) { console.error(`Unknown option --${key}\n\n${usage}`); process.exit(2); }
    const value = inline ?? args[++index];
    if (value === undefined) { console.error(`--${key} requires a value`); process.exit(2); }
    values[key] = value;
  }
  return { values, positional };
}

const [command = "help", ...rest] = process.argv.slice(2);
const { values, positional } = options(rest);
const data = values.data ?? defaultDataDirectory();
const certificate = values["tls-cert"], privateKey = values["tls-key"];
if (values["local-network"] !== undefined && command !== "serve") { console.error("--local-network applies only to serve"); process.exit(2); }
if (values["local-network"] !== undefined && values.listen && !["127.0.0.1", "localhost", "::1"].includes(values.listen)) {
  console.error("Local network mode keeps the primary listener on loopback; do not combine it with a non-loopback --listen");
  process.exit(2);
}
if (values["local-network"] !== undefined) {
  try { checkLocalAddress(values["local-network"]); }
  catch (error) { console.error((error as Error).message); process.exit(2); }
}
if (certificate !== undefined || privateKey !== undefined) {
  if (command !== "serve") { console.error("TLS certificate options apply only to serve"); process.exit(2); }
  if (!certificate || !privateKey) { console.error("TLS requires both --tls-cert and --tls-key"); process.exit(2); }
}

async function devices() {
  const paths = hostPaths(data);
  await prepareDirectories(paths);
  return Devices.open(paths);
}

if (command === "serve") {
  const port = Number(values.port ?? process.env.OPENOX_HOST_PORT ?? 9876);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) { console.error("--port must be 0-65535"); process.exit(2); }
  const tls = certificate && privateKey ? { cert: await Bun.file(certificate).text(), key: await Bun.file(privateKey).text() } : undefined;
  const host = await Host.open({ data, hostID: values.name ?? hostname(), version: packageMetadata.version });
  const server = await startServer(host, { hostname: values.listen ?? "127.0.0.1", port, tls });
  let localServer: Awaited<ReturnType<typeof startServer>> | undefined;
  let stopDiscovery: (() => Promise<void>) | undefined;
  try {
    const address = values["local-network"];
    if (address !== undefined) {
      const identity = await localIdentity(data, address);
      localServer = await startServer(host, { hostname: address, port: server.port!, tls: identity.tls });
      host.localConnection = { url: `https://${address}:${localServer.port}`, hostId: host.settings.profile.id,
        ca: identity.ca, hostname: identity.hostname, discovery: "starting" };
      stopDiscovery = await publishLocal(data, host.localConnection, address, localServer.port!,
        message => host.logs.warning("connections", `discovery unavailable: ${message}`));
      host.logs.info("connections", `Local network available at ${host.localConnection.url}; pair in the OpenOx app, not by accepting browser certificate warnings`);
    }
  } catch (error) {
    await localServer?.stop(true);
    await server.stop(true);
    await host.close();
    throw error;
  }
  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) process.exit(1);
    stopping = true;
    host.logs.info("host", `stopping after ${signal}`);
    setTimeout(() => process.exit(1), 30_000).unref();
    let failed = false;
    try { await stopDiscovery?.(); }
    catch (error) { failed = true; host.logs.error("connections", `discovery cleanup failed: ${(error as Error).message}`); }
    finally {
      await localServer?.stop(true);
      await server.stop(true);
      await host.close();
    }
    process.exit(failed ? 1 : 0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
} else if (command === "pair") {
  const local = await localHint(data);
  const configured = values.url ?? process.env.OPENOX_PUBLIC_URL;
  const base = configured ? await publicURL(configured) : local?.url ?? await publicURL();
  const { code, expiresAt } = await (await devices()).createPairingCode();
  console.log(`Pairing code: ${code}\nValid until ${new Date(expiresAt).toLocaleString()} (single use).`);
  if (base) {
    const link = invitation(base, code, local);
    console.log(`\n${local && base === local.url ? "Scan or paste this invitation in OpenOx → Settings → Host and connections. The app verifies this Host's private identity." : "Scan this with the new phone's camera, or open the link on it:"}\n\n${renderANSI(link, { ecc: "M", border: 2 })}\n${link}`);
  } else console.log("Enter it in the OpenOx web app on the new device. Run deploy/tailscale.sh, or pass --url https://<address>, to also get a QR code.");
} else if (command === "token") {
  if (!values.name) { console.error("token requires --name <device name>"); process.exit(2); }
  const { device, token } = await (await devices()).add(values.name, "cli");
  console.log(`Device ${device.id} (${device.name})\nOX_HOST_TOKEN=${token}`);
} else if (command === "devices") {
  for (const device of await (await devices()).list()) console.log(`${device.id}  ${device.kind.padEnd(7)}  ${device.name}  last seen ${device.lastSeenAt ?? "never"}`);
} else if (command === "revoke") {
  const id = positional[0];
  if (!id) { console.error("revoke requires a device id"); process.exit(2); }
  if (!await (await devices()).revoke(id)) { console.error("Device not found"); process.exit(1); }
  console.log(`Revoked ${id}`);
} else {
  console.log(usage);
  process.exit(command === "help" ? 0 : 2);
}

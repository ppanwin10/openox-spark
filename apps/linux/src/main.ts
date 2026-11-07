#!/usr/bin/env bun
import { hostname } from "node:os";
import { Host } from "./host";
import { startServer } from "./server";
import { Devices } from "./auth";
import { defaultDataDirectory, hostPaths, prepareDirectories } from "./config";
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
`;

function options(args: string[]) {
  const values: Record<string, string> = {};
  const positional: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (argument === "--help" || argument === "-h") { console.log(usage); process.exit(0); }
    if (!argument.startsWith("--")) { positional.push(argument); continue; }
    const [key, inline] = argument.slice(2).split("=", 2) as [string, string | undefined];
    if (!["data", "listen", "port", "name"].includes(key)) { console.error(`Unknown option --${key}\n\n${usage}`); process.exit(2); }
    const value = inline ?? args[++index];
    if (value === undefined) { console.error(`--${key} requires a value`); process.exit(2); }
    values[key] = value;
  }
  return { values, positional };
}

const [command = "help", ...rest] = process.argv.slice(2);
const { values, positional } = options(rest);
const data = values.data ?? defaultDataDirectory();

async function devices() {
  const paths = hostPaths(data);
  await prepareDirectories(paths);
  return Devices.open(paths);
}

if (command === "serve") {
  const port = Number(values.port ?? process.env.OPENOX_HOST_PORT ?? 9876);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) { console.error("--port must be 0-65535"); process.exit(2); }
  const host = await Host.open({ data, hostID: values.name ?? hostname(), version: packageMetadata.version });
  const server = await startServer(host, { hostname: values.listen ?? "127.0.0.1", port });
  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) process.exit(1);
    stopping = true;
    host.logs.info("host", `stopping after ${signal}`);
    setTimeout(() => process.exit(1), 30_000).unref();
    await server.stop(true);
    await host.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
} else if (command === "pair") {
  const { code, expiresAt } = await (await devices()).createPairingCode();
  console.log(`Pairing code: ${code}\nValid until ${new Date(expiresAt).toLocaleString()} (single use). Enter it in the OpenOx web app on the new device.`);
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

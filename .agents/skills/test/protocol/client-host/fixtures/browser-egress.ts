import { mock } from "bun:test";
import * as dns from "node:dns/promises";
import { request } from "node:http";
import { join } from "node:path";
import { ROOT } from "../../../../../lib.ts";

const realLookup = dns.lookup;
mock.module("node:dns/promises", () => ({ ...dns, lookup: async (host: string, options: { all: true; verbatim?: boolean }) => {
  if (host === "dual-stack.test") return [{ address: "::1", family: 6 }, { address: "127.0.0.1", family: 4 }];
  if (host === "mixed.test") return [{ address: "8.8.8.8", family: 4 }, { address: "127.0.0.1", family: 4 }];
  return realLookup(host, options);
} }));
const { allowTestOrigins } = await import(join(ROOT, "apps/linux/src/vm/net.ts"));
const { EgressProxy } = await import(join(ROOT, "apps/linux/src/vm/browser/proxy.ts"));
let received = 0;
const fixture = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => { received++; return new Response("validated IPv4 fixture"); } });
allowTestOrigins([`http://dual-stack.test:${fixture.port}`, `https://dual-stack.test:${fixture.port}`]);
const blocked: string[] = [], proxy = new EgressProxy((target: string) => blocked.push(target));
const address = new URL(await proxy.url());

function tunnel(target: string) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const child = request({ hostname: address.hostname, port: address.port, method: "CONNECT", path: target });
    child.on("error", reject);
    child.on("connect", (response, socket) => {
      if (response.statusCode !== 200) { socket.destroy(); resolve({ status: response.statusCode ?? 0, body: "" }); return; }
      const chunks: Buffer[] = [];
      const timer = setTimeout(() => { socket.destroy(); reject(new Error("Fixture tunnel did not close")); }, 3000);
      socket.on("data", chunk => chunks.push(Buffer.from(chunk)));
      socket.on("error", reject);
      socket.on("close", () => { clearTimeout(timer); resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString() }); });
      socket.write(`GET /tunnel HTTP/1.1\r\nHost: ${target}\r\nConnection: close\r\n\r\n`);
    });
    child.end();
  });
}
function forward() {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const child = request({ hostname: address.hostname, port: address.port,
      path: `http://dual-stack.test:${fixture.port}/forward`, headers: { host: `dual-stack.test:${fixture.port}` } }, response => {
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
      response.on("error", reject);
    });
    child.on("error", reject); child.end();
  });
}
try {
  const connected = await tunnel(`dual-stack.test:${fixture.port}`);
  const forwarded = await forward();
  const beforeDenied = received;
  const denied = await tunnel("mixed.test:443");
  console.log(JSON.stringify({ connected, forwarded, denied, received, beforeDenied, blocked, dnsMockIsolatedToChild: true }));
} finally { await proxy.close(); fixture.stop(true); }

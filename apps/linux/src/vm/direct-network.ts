import { createSocket } from "node:dgram";
import { Resolver } from "node:dns/promises";
import { connect as connectTCP, isIP, type Socket } from "node:net";
import { connect as connectTLS } from "node:tls";
import { networkExchangeSchema, networkResolveSchema, OxError, type FunctionCall } from "@openox/agent/linux";
import { Value } from "typebox/value";
import { museParityEnabled } from "../config";
import { Approvals } from "./approvals";
import type { VMFactory } from "./context";
import { publicDirectEndpoint } from "./net";
import { directProtocol, protocolEnabled, type DirectProtocol } from "./network-policy";

type Observation = { status: "end" | "datagram" | "limit" | "timeout"; bytesSent: number; data: string; remoteOutcome: "unconfirmed" };
type Exchange = { host: string; port: number; transport: "tcp" | "tls" | "udp"; payload?: string; maxBytes?: number; timeoutMs?: number };
const stopped = () => new OxError("cancelled", "The direct request stopped. Earlier network effects cannot be recalled.", "Do not reconnect or replay automatically.");
const networkFailure = () => new OxError("network_error", "The direct request did not complete. Bytes already sent may have reached the destination.", "Inspect the earlier result. Do not retry an uncertain operation automatically.");
const invalid = (message: string) => new OxError("invalid_argument", message);
function endpointURL(host: string, port: number) {
  if (!isIP(host) && !/^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(host)) throw invalid("Use an explicit hostname or IP address without credentials, path or query.");
  return new URL(`http://${isIP(host) === 6 ? `[${host}]` : host}:${port}`);
}

function exchange(input: Exchange, address: string, payload: Buffer, signal: AbortSignal): Promise<Observation> {
  return new Promise((resolve, reject) => {
    let settled = false, size = 0, bytesSent = 0;
    let close = () => {};
    const maximum = input.maxBytes ?? 16384, received = Buffer.alloc(maximum);
    const finish = (status: Observation["status"], error?: OxError) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal.removeEventListener("abort", abort); close();
      if (error) reject(error);
      else resolve({ status, bytesSent, data: received.subarray(0, size).toString("base64"), remoteOutcome: "unconfirmed" });
    };
    const abort = () => finish("end", stopped());
    const timer = setTimeout(() => finish("timeout"), input.timeoutMs ?? 3000);
    const receive = (data: Buffer) => {
      if (settled) return;
      const kept = data.copy(received, size, 0, maximum - size);
      size += kept;
      if (data.length > kept || size >= maximum) finish("limit");
      else if (input.transport === "udp") finish("datagram");
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) { abort(); return; }
    if (input.transport === "udp") {
      const socket = createSocket(isIP(address) === 6 ? "udp6" : "udp4");
      close = () => {
        try { socket.close(); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ERR_SOCKET_DGRAM_NOT_RUNNING") reject(networkFailure()); }
      };
      socket.on("error", () => finish("end", networkFailure()));
      socket.on("message", receive);
      socket.connect(input.port, address, () => {
        if (settled) return;
        bytesSent = payload.length;
        socket.send(payload, error => { if (error) finish("end", networkFailure()); });
      });
      return;
    }
    const socket: Socket = input.transport === "tls" ? connectTLS({ host: address, port: input.port,
      servername: isIP(input.host) ? undefined : input.host, rejectUnauthorized: true, minVersion: "TLSv1.2" }) : connectTCP({ host: address, port: input.port });
    close = () => { socket.destroy(); };
    socket.once(input.transport === "tls" ? "secureConnect" : "connect", () => {
      if (settled || !payload.length) return;
      bytesSent = payload.length;
      socket.write(payload, error => { if (error) finish("end", networkFailure()); });
    });
    socket.on("data", receive);
    socket.on("end", () => finish("end"));
    socket.on("error", () => finish("end", networkFailure()));
    socket.on("close", () => { if (!settled) finish("end", networkFailure()); });
  });
}

export const directNetworkModule: VMFactory = context => {
  if (!museParityEnabled()) return {};
  const approvals = Approvals.for(context.paths.state), active = new Set<AbortController>();
  let times: number[] = [];
  const unsubscribe = approvals.onChanged(() => { for (const controller of active) controller.abort(); });
  const available = async (call: FunctionCall, protocol: DirectProtocol, requestId: string) => {
    if (call.page || call.conversationId < 0) throw new OxError("permission_denied", "Direct transports are not exposed to HTML pages.");
    const current = await approvals.current();
    if (!protocolEnabled(current.actions, protocol)) throw new OxError("permission_denied", `Direct ${protocol} is Off in Permissions. No request was dispatched.`);
    await approvals.requireUnusedDirectRequest(requestId);
  };
  const run = async <T>(call: FunctionCall, requestId: string, protocol: DirectProtocol, work: (signal: AbortSignal) => Promise<T>) => {
    times = times.filter(time => Date.now() - time < 60000);
    if (active.size >= 4 || times.length >= 20) throw new OxError("limit_exceeded", "Direct transport admission is full. No new request was dispatched.");
    const epoch = context.contentEpoch?.() ?? 0, controller = new AbortController();
    active.add(controller); times.push(Date.now());
    const signal = AbortSignal.any([call.signal, controller.signal]);
    try {
      await approvals.guard(call);
      await approvals.claimDirectRequest(call, requestId, protocol);
      await approvals.guard(call);
      if (signal.aborted || context.contentBlocked?.() || context.contentEpoch?.() !== epoch) throw stopped();
      const result = await work(signal);
      await approvals.guard(call);
      if (signal.aborted || context.contentBlocked?.() || context.contentEpoch?.() !== epoch) throw stopped();
      return result;
    } finally { controller.abort(); active.delete(controller); }
  };
  return {
    handlers: {
      "ox.network.exchange": async call => {
        const input: unknown = call.args;
        if (!Value.Check(networkExchangeSchema, input)) throw invalid("Invalid direct exchange arguments.");
        const protocol = directProtocol(input.transport, input.port);
        if (protocol === "dns") throw invalid("Raw DNS ports are not available. Use a structured external DNS lookup.");
        const payload = Buffer.from(input.payload ?? "", "base64");
        if (payload.length > 16384 || payload.toString("base64") !== (input.payload ?? "") || input.transport === "udp" && !payload.length) throw invalid("Use at most16KiB of canonical base64 input; UDP requires a payload.");
        await available(call, protocol, input.requestId);
        const target = endpointURL(input.host, input.port), found = await publicDirectEndpoint(target);
        if (!found) throw new OxError("permission_denied", "This direct target is not an allowed public address.");
        await approvals.require(call, "ox.network.exchange", "ask", { connection: true, title: "Approve a direct connection",
          body: "This permits one finite exchange, including the supplied data. Remote changes cannot be recalled; completion is not verified.",
          detail: `${input.transport.toUpperCase()} ${input.host}:${input.port}\nAddress: ${found.address}\nCategory: ${protocol}\nOutgoing bytes: ${payload.length}`, sourceURL: target.origin });
        return run(call, input.requestId, protocol, async signal => ({ requestId: input.requestId, protocol, ...await exchange(input, found.address, payload, signal) }));
      },
      "ox.network.resolve": async call => {
        const input: unknown = call.args;
        if (!Value.Check(networkResolveSchema, input)) throw invalid("Invalid structured DNS arguments.");
        if (!isIP(input.resolver) || !/^(?=.{1,253}$)[A-Za-z0-9_](?:[A-Za-z0-9_.-]*[A-Za-z0-9])?$/.test(input.name)) throw invalid("Use a resolver IP and an ASCII DNS name without URL, credentials or query.");
        await available(call, "dns", input.requestId);
        const target = endpointURL(input.resolver, input.port ?? 53), found = await publicDirectEndpoint(target);
        if (!found) throw new OxError("permission_denied", "This resolver is not an allowed public address.");
        await approvals.require(call, "ox.network.resolve", "allow", { title: "Query an external DNS resolver", sourceURL: target.origin });
        return run(call, input.requestId, "dns", async signal => {
          const resolver = new Resolver({ timeout: 2000, tries: 1 });
          resolver.setServers([`${isIP(found.address) === 6 ? `[${found.address}]` : found.address}:${input.port ?? 53}`]);
          const abort = () => resolver.cancel();
          signal.addEventListener("abort", abort, { once: true });
          try {
            if (signal.aborted) throw stopped();
            const records = await ({ A: () => resolver.resolve4(input.name), AAAA: () => resolver.resolve6(input.name),
              CNAME: () => resolver.resolveCname(input.name), MX: () => resolver.resolveMx(input.name), NS: () => resolver.resolveNs(input.name),
              SRV: () => resolver.resolveSrv(input.name), TXT: () => resolver.resolveTxt(input.name) })[input.type]();
            if (!records.length) throw new OxError("network_error", "The external resolver returned no records.");
            if (records.length > 256 || Buffer.byteLength(JSON.stringify(records)) > 65536) throw new OxError("limit_exceeded", "The DNS response exceeds the bounded result limit.");
            return { requestId: input.requestId, type: input.type, records };
          } catch (error) {
            if (signal.aborted) throw stopped();
            if (error instanceof OxError) throw error;
            throw networkFailure();
          } finally { signal.removeEventListener("abort", abort); resolver.cancel(); }
        });
      },
    },
    limitations: ["Direct network functions perform finite approved transport exchanges or structured DNS, not complete SSH, mail or database clients. All eight protocol gates default Off. Never repeat an uncertain network mutation or disclose credentials in payloads/query names."],
    content: { busy: () => active.size > 0 },
    close: async () => { unsubscribe(); for (const controller of active) controller.abort(); },
  };
};

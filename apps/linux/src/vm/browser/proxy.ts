import { createServer, request, type IncomingMessage, type ServerResponse } from "node:http";
import { connect, type AddressInfo, type Socket } from "node:net";
import { publicEndpoint } from "../net";

const blockedBody = "Ox blocked this request because its destination is not a public web address.";
const connectTimeout = 30_000;

export class EgressProxy {
  private server = createServer((incoming, response) => void this.forward(incoming, response));
  private sockets = new Set<Socket>();
  private listening?: Promise<string>;
  private onBlocked: (target: string) => void;

  constructor(onBlocked: (target: string) => void) {
    this.onBlocked = onBlocked;
    this.server.on("connect", (incoming: IncomingMessage, socket: Socket, head: Buffer) => void this.tunnel(incoming, socket, head));
    this.server.on("connection", socket => this.track(socket));
  }

  url() {
    this.listening ??= new Promise<string>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(this.server.address() as AddressInfo).port}`));
    });
    return this.listening;
  }

  async close() {
    for (const socket of this.sockets) socket.destroy();
    if (this.listening) await new Promise<void>(resolve => this.server.close(() => resolve()));
  }

  private track(socket: Socket) {
    this.sockets.add(socket);
    socket.once("close", () => this.sockets.delete(socket));
    socket.on("error", () => socket.destroy());
  }

  private async forward(incoming: IncomingMessage, response: ServerResponse) {
    let target: URL | undefined;
    try { target = new URL(incoming.url ?? ""); } catch {}
    const endpoint = target?.protocol === "http:" ? await publicEndpoint(target) : undefined;
    if (!target || !endpoint) {
      this.onBlocked(target?.origin ?? "invalid request");
      response.writeHead(403, { "content-type": "text/plain; charset=utf-8", connection: "close" }).end(blockedBody);
      return;
    }
    const headers = { ...incoming.headers };
    for (const name of ["proxy-connection", "proxy-authorization", "connection", "keep-alive"]) delete headers[name];
    const upstream = request({ host: endpoint.address, port: endpoint.port, method: incoming.method, path: `${target.pathname}${target.search}`, headers, agent: false }, reply => {
      response.writeHead(reply.statusCode ?? 502, reply.headers);
      reply.pipe(response);
    });
    upstream.on("error", () => { if (!response.headersSent) response.writeHead(502, { connection: "close" }); response.end(); });
    response.once("close", () => upstream.destroy());
    incoming.pipe(upstream);
  }

  private async tunnel(incoming: IncomingMessage, socket: Socket, head: Buffer) {
    const target = incoming.url ?? "";
    const endpoint = await publicEndpoint(`https://${target}`) ?? await publicEndpoint(`http://${target}`);
    if (!endpoint) {
      this.onBlocked(target);
      socket.end("HTTP/1.1 403 Forbidden\r\nconnection: close\r\n\r\n");
      return;
    }
    const upstream = connect(endpoint.port, endpoint.address);
    this.track(upstream);
    let connected = false;
    const timer = setTimeout(() => upstream.destroy(), connectTimeout);
    upstream.once("connect", () => {
      connected = true;
      clearTimeout(timer);
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.once("close", () => {
      clearTimeout(timer);
      if (connected) socket.destroy(); else socket.end("HTTP/1.1 502 Bad Gateway\r\nconnection: close\r\n\r\n");
    });
    socket.once("close", () => upstream.destroy());
  }
}

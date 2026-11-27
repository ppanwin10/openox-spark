import { Type } from "typebox";

const strict = { additionalProperties: false };
const purpose = Type.String({ minLength: 1, maxLength: 240 });
const requestId = Type.String({ pattern: "^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$" });
const port = Type.Integer({ minimum: 1, maximum: 65535 });
const host = Type.String({ minLength: 1, maxLength: 253 });
export const networkExchangeSchema = Type.Object({
  purpose, requestId, host, port,
  transport: Type.Union([Type.Literal("tcp"), Type.Literal("tls"), Type.Literal("udp")]),
  payload: Type.Optional(Type.String({ maxLength: 21848, pattern: "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$" })),
  maxBytes: Type.Optional(Type.Integer({ minimum: 1, maximum: 65536 })),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 100, maximum: 10000 })),
}, strict);
export const networkResolveSchema = Type.Object({
  purpose, requestId, resolver: host, port: Type.Optional(port), name: host,
  type: Type.Union([Type.Literal("A"), Type.Literal("AAAA"), Type.Literal("CNAME"), Type.Literal("MX"),
    Type.Literal("NS"), Type.Literal("SRV"), Type.Literal("TXT")]),
}, strict);
export const networkContracts = {
  "ox.network.exchange": {
    description: "Request one finite direct TCP, certificate-verified TLS, or UDP exchange after enabling its protocol in Permissions and explicit per-connection approval. Classification uses transport/port, not a caller-supplied label. Optional payload and returned data are base64. The connection always closes; there are no persistent handles, automatic retries or complete SSH/email/database clients. Use a fresh UUID for each intentional attempt; a spent UUID is never replayed, even after restart. bytesSent only describes bytes handed to the socket, not remote application success. end/datagram/limit/timeout describe transport observation only; limit/timeout output is incomplete. Raw DNS ports53/853 are refused; use resolve.",
    inputSchema: networkExchangeSchema,
    outputSchema: Type.Object({ requestId, protocol: Type.String(), status: Type.Union([Type.Literal("end"), Type.Literal("datagram"), Type.Literal("limit"), Type.Literal("timeout")]),
      bytesSent: Type.Integer({ minimum: 0, maximum: 16384 }), data: Type.String({ maxLength: 87384 }), remoteOutcome: Type.Literal("unconfirmed") }, strict),
  },
  "ox.network.resolve": {
    description: "Perform one bounded structured A/AAAA/CNAME/MX/NS/SRV/TXT lookup using an explicit public resolver IP after enabling External DNS in Permissions. Internal HTTP hostname resolution is separate. There is no additional default connection prompt, but stricter original action policy still applies. Never send secrets in query names. Use a fresh UUID for each intentional lookup; attempted identities are never replayed. Failure is not an empty successful answer.",
    inputSchema: networkResolveSchema,
    outputSchema: Type.Object({ requestId, type: networkResolveSchema.properties.type, records: Type.Array(Type.Union([
      Type.String(), Type.Array(Type.String()), Type.Object({ exchange: Type.String(), priority: Type.Integer() }, strict),
      Type.Object({ name: Type.String(), port: Type.Integer(), priority: Type.Integer(), weight: Type.Integer() }, strict),
    ]), { maxItems: 256 }) }, strict),
  },
};

const encoder = new TextEncoder();
const b64url = (data: Uint8Array) => Buffer.from(data).toString("base64url");
const bytes = (text: string): Uint8Array<ArrayBuffer> => new Uint8Array(Buffer.from(text, "base64url"));
type Bytes = Uint8Array<ArrayBuffer>;
const concat = (...parts: Uint8Array[]): Bytes => {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
};

export interface PushKeys { publicKey: string; privateKey: JsonWebKey }
export interface PushTarget { endpoint: string; p256dh: string; auth: string; subject: string }
export interface PushMessage { payload: unknown; ttl: number; urgency: "normal" | "high"; topic?: string }

export async function createPushKeys(): Promise<PushKeys> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  return { publicKey: b64url(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))), privateKey: await crypto.subtle.exportKey("jwk", pair.privateKey) };
}

export function validClientKeys(p256dh: unknown, auth: unknown) {
  return typeof p256dh === "string" && typeof auth === "string" && /^[A-Za-z0-9_-]+={0,2}$/.test(p256dh) && /^[A-Za-z0-9_-]+={0,2}$/.test(auth)
    && bytes(p256dh).length === 65 && bytes(p256dh)[0] === 4 && bytes(auth).length === 16;
}

async function hkdf(salt: Bytes, secret: Bytes, info: Bytes, length: number) {
  const key = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8));
}

export async function encryptPush(target: Pick<PushTarget, "p256dh" | "auth">, plaintext: Bytes) {
  const client = bytes(target.p256dh);
  const local = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const localPublic = new Uint8Array(await crypto.subtle.exportKey("raw", local.publicKey));
  const clientKey = await crypto.subtle.importKey("raw", client, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: clientKey }, local.privateKey, 256));
  const ikm = await hkdf(bytes(target.auth), shared, concat(encoder.encode("WebPush: info\0"), client, localPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", await hkdf(salt, ikm, encoder.encode("Content-Encoding: aes128gcm\0"), 16), "AES-GCM", false, ["encrypt"]);
  const nonce = await hkdf(salt, ikm, encoder.encode("Content-Encoding: nonce\0"), 12);
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, concat(plaintext, new Uint8Array([2]))));
  const header = new Uint8Array(21 + localPublic.length);
  header.set(salt);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = localPublic.length;
  header.set(localPublic, 21);
  return concat(header, sealed);
}

async function vapid(endpoint: string, keys: PushKeys, subject: string) {
  const header = b64url(encoder.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64url(encoder.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject })));
  const key = await crypto.subtle.importKey("jwk", keys.privateKey, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, encoder.encode(`${header}.${claims}`)));
  return `vapid t=${header}.${claims}.${b64url(signature)}, k=${keys.publicKey}`;
}

export async function sendPush(target: PushTarget, keys: PushKeys, message: PushMessage) {
  const body = await encryptPush(target, encoder.encode(JSON.stringify(message.payload)));
  const response = await fetch(target.endpoint, { method: "POST", body, redirect: "error", signal: AbortSignal.timeout(15_000),
    headers: { "content-encoding": "aes128gcm", "content-type": "application/octet-stream", ttl: String(message.ttl), urgency: message.urgency,
      ...(message.topic ? { topic: message.topic } : {}), authorization: await vapid(target.endpoint, keys, target.subject) } });
  await response.body?.cancel().catch(() => {});
  return response.status;
}

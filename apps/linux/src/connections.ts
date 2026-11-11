import { createPrivateKey, X509Certificate } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { readJSON, writeJSON } from "./config";

export interface OutsideConnection { provider: "tailscale" | "https"; url: string }
export interface LocalConnection {
  url: string; hostId: string; ca?: string; hostname: string; discovery: "starting" | "ready" | "unavailable"; error?: string;
}
export interface LocalRuntime extends LocalConnection { pid: number }
const material = ["ca.crt", "ca.key", "server.crt", "server.key"] as const;
const fingerprint = (certificate: X509Certificate) => certificate.fingerprint256.replaceAll(":", "").toLowerCase();

export function privateIPv4(address: string) {
  if (isIP(address) !== 4) return false;
  const [first, second] = address.split(".").map(Number);
  return first === 10 || (first === 172 && second! >= 16 && second! <= 31) || (first === 192 && second === 168);
}

export function localAddresses() {
  return [...new Set(Object.values(networkInterfaces()).flatMap(entries => (entries ?? [])
    .filter(entry => !entry.internal && entry.family === "IPv4" && privateIPv4(entry.address)).map(entry => entry.address)))];
}

export function checkLocalAddress(address: string) {
  if (!privateIPv4(address) || !localAddresses().includes(address)) {
    throw new Error("Local access needs an assigned private IPv4 address, not a public, loopback or shared-carrier address");
  }
}

export function outsideConnection(value: unknown): OutsideConnection | null {
  if (value === null) return null;
  if (!value || typeof value !== "object" || !("provider" in value) || !("url" in value)
    || (value.provider !== "tailscale" && value.provider !== "https") || typeof value.url !== "string" || value.url.length > 2048) {
    throw new Error("Choose an outside connection and enter its HTTPS address");
  }
  let url: URL;
  try { url = new URL(value.url.trim()); } catch { throw new Error("Enter an HTTPS Host address"); }
  if (url.protocol !== "https:" || !url.hostname || url.port === "0" || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("Use an HTTPS Host origin without credentials, a path, query or fragment");
  }
  return { provider: value.provider, url: url.origin };
}

async function exists(path: string) {
  try { await stat(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

async function openssl(args: string[]) {
  const executable = Bun.which("openssl");
  if (!executable) throw new Error("OpenSSL is required to prepare encrypted local Host access");
  const child = Bun.spawn([executable, ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [code, diagnostic] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  if (code) throw new Error(`Local certificate preparation failed: ${diagnostic.trim().slice(-1500)}`);
}

async function leaf(directory: string, address: string, hostname: string) {
  const temporary = await mkdtemp(join(directory, "leaf-"));
  try {
    const config = join(temporary, "extensions.cnf"), request = join(temporary, "server.csr"), certificate = join(temporary, "server.crt");
    await writeFile(config, `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:${hostname},DNS:localhost,IP:${address},IP:127.0.0.1\n`, { mode: 0o600 });
    await openssl(["req", "-new", "-key", join(directory, "server.key"), "-subj", `/CN=${hostname}`, "-out", request]);
    await openssl(["x509", "-req", "-in", request, "-CA", join(directory, "ca.crt"), "-CAkey", join(directory, "ca.key"),
      "-CAcreateserial", "-days", "365", "-sha256", "-extfile", config, "-out", certificate]);
    await rename(certificate, join(directory, "server.crt"));
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

async function createIdentity(directory: string, parent: string, address: string) {
  const temporary = await mkdtemp(join(parent, "local-tls-"));
  try {
    await openssl(["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-sha256", "-days", "3650",
      "-keyout", join(temporary, "ca.key"), "-out", join(temporary, "ca.crt"), "-subj", "/CN=OpenOx private Host CA",
      "-addext", "basicConstraints=critical,CA:TRUE,pathlen:0", "-addext", "keyUsage=critical,keyCertSign,cRLSign"]);
    await openssl(["genpkey", "-algorithm", "EC", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-out", join(temporary, "server.key")]);
    const ca = new X509Certificate(await readFile(join(temporary, "ca.crt")));
    await leaf(temporary, address, `ox-${fingerprint(ca).slice(0, 20)}.local`);
    await Promise.all(material.map(name => chmod(join(temporary, name), 0o600)));
    await rename(temporary, directory);
  } finally { if (await exists(temporary)) await rm(temporary, { recursive: true, force: true }); }
}

export async function localIdentity(data: string, address: string) {
  checkLocalAddress(address);
  const directory = join(data, "connection-tls");
  await mkdir(data, { recursive: true, mode: 0o700 });
  if (!await exists(directory)) await createIdentity(directory, data, address);
  const entries = await readdir(directory);
  if (!material.every(name => entries.includes(name))) throw new Error("The private Host TLS identity is incomplete; restore it rather than silently replacing it");
  for (const name of ["", ...material]) {
    if ((await stat(join(directory, name))).mode & 0o077) throw new Error("The private Host TLS identity needs owner-only file and directory permissions");
  }
  const [caPEM, caKeyPEM, serverPEM, serverKeyPEM] = await Promise.all(material.map(name => readFile(join(directory, name), "utf8")));
  const ca = new X509Certificate(caPEM!);
  if (!ca.ca || !ca.verify(ca.publicKey) || !ca.checkPrivateKey(createPrivateKey(caKeyPEM!))
    || Date.parse(ca.validFrom) > Date.now() || Date.parse(ca.validTo) <= Date.now()) {
    throw new Error("The private Host CA is invalid or expired; explicit identity repair is required");
  }
  let certificate = new X509Certificate(serverPEM!);
  if (certificate.ca || !certificate.checkPrivateKey(createPrivateKey(serverKeyPEM!)) || !certificate.verify(ca.publicKey)
    || Date.parse(certificate.validFrom) > Date.now()) {
    throw new Error("The private Host certificate does not match its stored identity");
  }
  const hostname = `ox-${fingerprint(ca).slice(0, 20)}.local`;
  if (!certificate.checkIP(address) || Date.parse(certificate.validTo) <= Date.now() + 86400_000) {
    await leaf(directory, address, hostname);
    await chmod(join(directory, "server.crt"), 0o600);
    certificate = new X509Certificate(await readFile(join(directory, "server.crt")));
    if (!certificate.verify(ca.publicKey) || !certificate.checkIP(address)) throw new Error("The renewed local Host certificate could not be verified");
  }
  return { tls: { cert: `${certificate.toString()}\n${ca.toString()}`, key: serverKeyPEM! }, ca: fingerprint(ca), hostname };
}

export function invitation(origin: string, code: string, local?: LocalConnection | null) {
  const extra = local?.ca && new URL(local.url).origin === new URL(origin).origin
    ? `?host=${encodeURIComponent(local.hostId)}&ca=${local.ca}` : "";
  return `${origin}/#/pair/${code}${extra}`;
}

export function connectionOrigin(request: Request) {
  const url = new URL(request.url);
  if (request.headers.get("x-forwarded-proto") === "https") url.protocol = "https:";
  return url.origin;
}

export async function localHint(data: string) {
  const hint = await readJSON<LocalRuntime | null>(join(data, "local-connection.json"), null);
  if (!hint) return undefined;
  if (!Number.isInteger(hint.pid) || hint.pid <= 0 || !privateIPv4(new URL(hint.url).hostname) || typeof hint.ca !== "string" || !/^[a-f0-9]{64}$/.test(hint.ca)) {
    throw new Error("The stored local connection hint is invalid");
  }
  try { process.kill(hint.pid, 0); } catch (error) {
    if (["ESRCH", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) return undefined;
    throw error;
  }
  return hint;
}

export async function publishLocal(data: string, info: LocalConnection, address: string, port: number, warning: (message: string) => void) {
  if (!info.ca) throw new Error("Private-CA discovery requires the Host CA identity");
  await writeJSON(join(data, "local-connection.json"), { ...info, pid: process.pid });
  const { getResponder } = await import("@homebridge/ciao");
  const responder = getResponder({ interface: address, disableIpv6: true, advertiseIpv6: false });
  const service = responder.createService({ name: `OpenOx ${info.ca.slice(0, 8)}`, type: "openox", port,
    hostname: info.hostname.replace(/\.local$/, ""), restrictedAddresses: [address], disabledIpv6: true,
    txt: { url: info.url, id: info.hostId, ca: info.ca } });
  try { await service.advertise(); info.discovery = "ready"; }
  catch (error) { info.discovery = "unavailable"; info.error = "Local discovery is unavailable; use the Host invitation"; warning(error instanceof Error ? error.message : String(error)); }
  return async () => {
    try {
      try { await service.destroy(); } finally { await responder.shutdown(); }
    } finally {
      const current = await readJSON<LocalRuntime | null>(join(data, "local-connection.json"), null);
      if (current?.pid === process.pid) await rm(join(data, "local-connection.json"));
    }
  };
}

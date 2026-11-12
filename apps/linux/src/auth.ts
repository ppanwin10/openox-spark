import { rm, stat } from "node:fs/promises";
import { readJSON, writeJSON, type HostPaths } from "./config";

export type DeviceKind = "browser" | "cli";
interface Device { id: string; name: string; kind: DeviceKind; tokenHash: string; createdAt: string; lastSeenAt: string | null }
interface Pairing { hash: string; expiresAt: string; failures: number }
export type DeviceInfo = Omit<Device, "tokenHash">;
export class AuthError extends Error {}

export const cookieName = "ox_device";
const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const pairingAttempts = 5;
const digest = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex");
const information = ({ tokenHash: _, ...device }: Device): DeviceInfo => device;
const deviceName = (value: string) => value.replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, 80) || "Unnamed device";

export class Devices {
  private paths: HostPaths;
  private devices: Device[] = [];
  private seen = new Map<string, string>();
  private modified = -1;
  private checked = 0;
  private tail: Promise<unknown> = Promise.resolve();
  private workspaceGrants = new Map<string, number>();

  private constructor(paths: HostPaths) { this.paths = paths; }

  static async open(paths: HostPaths) {
    const devices = new Devices(paths);
    await devices.reload(true);
    return devices;
  }

  private serialize<T>(body: () => Promise<T>) {
    const next = this.tail.then(body);
    this.tail = next.catch(() => {});
    return next;
  }

  private async reload(force = false, throttle = true) {
    if (!force && throttle && Date.now() - this.checked < 1_000) return;
    this.checked = Date.now();
    const modified = await stat(this.paths.devices).then(info => info.mtimeMs, () => 0);
    if (!force && modified === this.modified) return;
    this.modified = modified;
    this.devices = (await readJSON<{ devices: Device[] }>(this.paths.devices, { devices: [] })).devices;
  }

  private async save() {
    this.devices = this.devices.map(device => ({ ...device, lastSeenAt: this.seen.get(device.id) ?? device.lastSeenAt }));
    await writeJSON(this.paths.devices, { devices: this.devices });
    this.modified = await stat(this.paths.devices).then(info => info.mtimeMs, () => 0);
  }

  async changed() {
    const before = this.modified;
    await this.reload(false, false);
    return this.modified !== before;
  }

  async list() {
    await this.reload(true);
    return this.devices.map(device => information({ ...device, lastSeenAt: this.seen.get(device.id) ?? device.lastSeenAt }));
  }

  async authenticate(token: string | undefined) {
    if (!token?.startsWith("oxd_") || token.length > 200) return undefined;
    await this.reload();
    const hash = digest(token);
    let device = this.devices.find(item => item.tokenHash === hash);
    if (!device) {
      await this.reload(false, false);
      device = this.devices.find(item => item.tokenHash === hash);
    }
    if (!device) return undefined;
    const lastSeenAt = new Date().toISOString();
    this.seen.set(device.id, lastSeenAt);
    return information({ ...device, lastSeenAt });
  }

  createPairingCode(ttlMs = 10 * 60_000) {
    return this.serialize(async () => {
      const code = Array.from(crypto.getRandomValues(new Uint8Array(8)), byte => alphabet[byte % alphabet.length]).join("");
      const expiresAt = new Date(Date.now() + ttlMs).toISOString();
      await writeJSON(this.paths.pairing, { hash: digest(code), expiresAt, failures: 0 } satisfies Pairing);
      return { code: `${code.slice(0, 4)}-${code.slice(4)}`, expiresAt };
    });
  }

  createWorkspaceGrant(ttlMs = 60_000) {
    const now = Date.now();
    for (const [hash, expires] of this.workspaceGrants) if (expires <= now) this.workspaceGrants.delete(hash);
    if (this.workspaceGrants.size >= 16) throw new AuthError("Too many pending workspace opens. Wait a minute and reopen from the Host console.");
    const grant = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
    const expires = now + Math.min(ttlMs, 60_000);
    this.workspaceGrants.set(digest(grant), expires);
    return { grant, expiresAt: new Date(expires).toISOString() };
  }

  clearWorkspaceGrants() { this.workspaceGrants.clear(); }

  openWorkspace(grant: unknown, token: string | undefined, name: string) {
    return this.serialize(async () => {
      if (typeof grant !== "string" || !/^[a-f0-9]{64}$/.test(grant)) throw new AuthError("Open the workspace again from the Host console.");
      const hash = digest(grant), expires = this.workspaceGrants.get(hash);
      if (!expires || expires <= Date.now()) throw new AuthError("Local workspace authorization expired or was already used. Reopen from the Host console.");
      this.workspaceGrants.delete(hash);
      const current = await this.authenticate(token);
      return current ? { device: current, token: null } : this.addLocked(name, "browser");
    });
  }

  pair(code: string, name: string, kind: DeviceKind) {
    return this.serialize(async () => {
      const pairing = await readJSON<Pairing | null>(this.paths.pairing, null);
      if (!pairing || Date.parse(pairing.expiresAt) < Date.now()) throw new AuthError("There is no active pairing code. Create a new code on a paired device or run openox-host pair on the Host.");
      if (digest(code.toUpperCase().replace(/[^A-Z0-9]/g, "")) !== pairing.hash) {
        const failures = pairing.failures + 1;
        if (failures >= pairingAttempts) await rm(this.paths.pairing, { force: true });
        else await writeJSON(this.paths.pairing, { ...pairing, failures });
        throw new AuthError(failures >= pairingAttempts ? "Too many incorrect codes. Create a new pairing code." : "That pairing code is not correct.");
      }
      await rm(this.paths.pairing, { force: true });
      return this.addLocked(name, kind);
    });
  }

  add(name: string, kind: DeviceKind) { return this.serialize(() => this.addLocked(name, kind)); }

  private async addLocked(name: string, kind: DeviceKind) {
    await this.reload(true);
    const token = `oxd_${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")}`;
    const device: Device = { id: crypto.randomUUID(), name: deviceName(name), kind, tokenHash: digest(token), createdAt: new Date().toISOString(), lastSeenAt: null };
    this.devices.push(device);
    await this.save();
    return { device: information(device), token };
  }

  revoke(id: string) {
    return this.serialize(async () => {
      await this.reload(true);
      const remaining = this.devices.filter(device => device.id !== id);
      if (remaining.length === this.devices.length) return false;
      this.devices = remaining;
      await this.save();
      return true;
    });
  }
}

export function requestToken(request: Request) {
  const header = request.headers.get("authorization");
  if (header?.startsWith("Bearer ")) return header.slice(7).trim();
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === cookieName) return value.join("=");
  }
  return undefined;
}

export function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  const hosts = [request.headers.get("x-forwarded-host"), request.headers.get("host")].filter(Boolean);
  try { return hosts.includes(new URL(origin).host); } catch { return false; }
}

const secure = (request: Request) => request.headers.get("x-forwarded-proto") === "https" || new URL(request.url).protocol === "https:";
export function deviceCookie(request: Request, token: string) {
  return `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000${secure(request) ? "; Secure" : ""}`;
}
export function clearedCookie(request: Request) {
  return `${cookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure(request) ? "; Secure" : ""}`;
}

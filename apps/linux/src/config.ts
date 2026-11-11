import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ModelChoice } from "@openox/agent/linux";
import type { OutsideConnection } from "./connections";

export interface CustomProvider { baseUrl: string; models: string[]; name?: string; images?: boolean; contextWindow?: number }
export interface LocalMachine extends CustomProvider { id: string }
export interface HostSettings {
  profile: { id: string; name: string };
  defaultModel?: ModelChoice;
  custom?: CustomProvider;
  machines?: LocalMachine[];
  connections?: { outside: OutsideConnection | null };
}
export interface HostPaths {
  data: string; settings: string; credentials: string; devices: string; pairing: string; logs: string; profiles: string;
}

export function defaultDataDirectory() {
  return process.env.OPENOX_HOST_DATA ?? join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "openox-host");
}

export function hostPaths(data: string): HostPaths {
  return { data, settings: join(data, "host.json"), credentials: join(data, "credentials.json"), devices: join(data, "devices.json"),
    pairing: join(data, "pairing.json"), logs: join(data, "logs"), profiles: join(data, "profiles") };
}

export async function prepareDirectories(paths: HostPaths) {
  for (const path of [paths.data, paths.logs, paths.profiles]) {
    await mkdir(path, { recursive: true, mode: 0o700 });
    await chmod(path, 0o700);
  }
}

export async function readJSON<T>(path: string, fallback: T): Promise<T> {
  try { return JSON.parse(await readFile(path, "utf8")) as T; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw new Error(`Cannot read ${path}: ${(error as Error).message}`);
  }
}

export async function writeJSON(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  await rename(temporary, path);
}

export async function loadSettings(paths: HostPaths): Promise<HostSettings> {
  const stored = await readJSON<Partial<HostSettings>>(paths.settings, {});
  if (stored.profile?.id && stored.profile.name) return stored as HostSettings;
  const settings: HostSettings = { ...stored, profile: { id: crypto.randomUUID().toUpperCase(), name: "Personal" } };
  await writeJSON(paths.settings, settings);
  return settings;
}

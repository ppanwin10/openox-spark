import { chmod, link, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
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
  defaultReminderTime?: string | null;
  quietDiscovery?: boolean;
}
export interface HostPaths {
  data: string; settings: string; credentials: string; devices: string; pairing: string; logs: string; profiles: string;
}
export const personalAgentEnabled = () => process.env.OPENOX_PERSONAL_AGENT === "1";
export const museParityEnabled = () => personalAgentEnabled() && process.env.OPENOX_MUSE_PARITY === "1";
export const evidenceOnlyEnabled = () => museParityEnabled() && process.env.OPENOX_EVIDENCE_ONLY === "1";
export const goalSoftBudgetEnabled = () => proactiveAgentEnabled() && process.env.OPENOX_GOAL_SOFT_BUDGET === "1";
export const evidenceGoalChecksEnabled = () => evidenceOnlyEnabled() && process.env.OPENOX_EVIDENCE_GOAL_CHECKS === "1";
export const readableQuotesEnabled = () => evidenceOnlyEnabled() && process.env.OPENOX_READABLE_QUOTES === "1";
export const sourceLabelsEnabled = () => evidenceOnlyEnabled() && process.env.OPENOX_SOURCE_LABELS === "1";
export const priceSummaryEnabled = () => evidenceOnlyEnabled() && process.env.OPENOX_PRICE_SUMMARY === "1";
export const researchPagesEnabled = () => evidenceOnlyEnabled() && process.env.OPENOX_RESEARCH_PAGES === "1";
export const publicLookupEnabled = () => museParityEnabled() && !evidenceOnlyEnabled() && process.env.OPENOX_PUBLIC_LOOKUP === "1";
export const implicitPublicReadsEnabled = () => museParityEnabled() && process.env.OPENOX_IMPLICIT_PUBLIC_READS === "1";
export const implicitPlanningEnabled = () => museParityEnabled() && process.env.OPENOX_PROACTIVE_AGENT === "1" && process.env.OPENOX_IMPLICIT_PLANNING === "1";
export const memoryRememberEnabled = () => museParityEnabled() && process.env.OPENOX_MEMORY_REMEMBER === "1";
export const proactiveAgentEnabled = () => museParityEnabled() && process.env.OPENOX_PROACTIVE_AGENT === "1";
export const quietDiscoveryAvailable = () => proactiveAgentEnabled() && !evidenceOnlyEnabled();
export const quietDiscoveryEnabled = (settings: Pick<HostSettings, "quietDiscovery">) => quietDiscoveryAvailable() && (settings.quietDiscovery ?? true);
export const vertexADCEnabled = () => process.env.OPENOX_VERTEX_ADC === "1";

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

export async function createJSON(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    await link(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

export async function loadSettings(paths: HostPaths): Promise<HostSettings> {
  const stored = await readJSON<Partial<HostSettings>>(paths.settings, {});
  if (stored.quietDiscovery !== undefined && typeof stored.quietDiscovery !== "boolean") throw new Error("Invalid quiet discovery preference.");
  if (stored.defaultReminderTime !== undefined && stored.defaultReminderTime !== null
    && (typeof stored.defaultReminderTime !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(stored.defaultReminderTime))) {
    throw new Error("The saved default reminder time is invalid. Repair it before starting this Host.");
  }
  if (stored.profile?.id && stored.profile.name) return stored as HostSettings;
  const settings: HostSettings = { ...stored, profile: { id: crypto.randomUUID().toUpperCase(), name: "Personal" } };
  await writeJSON(paths.settings, settings);
  return settings;
}

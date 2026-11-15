import type { AppFileRequest, AttachedService, FileBackend, FileMount, FunctionCall, FunctionHandler, LinuxProfile, ModelChoice, ServiceKind, SpaceScheduleBinding } from "@openox/agent/linux";
import type { HostSettings } from "../config";
import type { Logger } from "../logs";
import type { Notice } from "../notifications";
import type { Providers } from "../providers";
import type { BrowserManager } from "./browser/manager";

export type VMEvent = { type: "pages" | "services" | "schedules" | "skills" | "secrets" | "repositories" | "todos" | "notifications" | "review" | "settings" | "watches" | "goals" | "library" | "discovery" | "identity" | "approvalHistory" };
export type SpaceConnectionProof = { domain: string; kind: "api" | "web" | "mcp"; repository: string; definition: string; revision: number; proof: string; connected: boolean; verifiedAt: string | null };
export interface VMPaths {
  root: string;
  state: string;
  browser: string;
  repositories: string;
  local: string;
  bundled: string;
  scratch: string;
}
export interface VMContext {
  readonly hostID: string;
  readonly version: string;
  readonly paths: VMPaths;
  readonly logs: Logger;
  readonly providers: Providers;
  readonly browser: BrowserManager;
  profile(): LinuxProfile;
  submit(id: number, text: string, attachments?: string[], origin?: Parameters<LinuxProfile["send"]>[3], requestID?: string,
    schedule?: { id: string; active(): boolean }): ReturnType<LinuxProfile["send"]>;
  settings(): HostSettings;
  updateSettings(change: Partial<HostSettings>): Promise<void>;
  defaultModel(): ModelChoice | undefined;
  emit(event: VMEvent): void;
  notify(notice: Notice): void;
  notificationProblem?(): string | null;
  contentBlocked?(): boolean;
  contentEpoch?(): number;
  withContentEpoch?<T>(epoch: number, work: () => Promise<T>): Promise<T>;
  ownerActive?(owner: string): Promise<boolean>;
  serviceDependencies?(domain: string): Promise<{ schedules: number; activeSchedules: number }>;
  permissionSchedules(): Promise<{ id: string; name: string }[]>;
  familiarWebVisit(url: string): Promise<boolean>;
  spaceConnectionProof(domain: string): Promise<SpaceConnectionProof>;
  spaceTask(call: FunctionCall): SpaceScheduleBinding | undefined;
}
export interface VMModule {
  handlers?: Record<string, FunctionHandler>;
  limitations?: string[];
  serviceKinds?: ServiceKind[];
  mounts?: FileMount[];
  appFiles?(call: FunctionCall, request: AppFileRequest): FileBackend;
  attachedServices?(conversationId: number): Promise<AttachedService[]>;
  conversationRemoved?(conversationId: number): Promise<void>;
  conversationForked?(sourceId: number, forkId: number): Promise<void>;
  conversationReplaced?(sourceId: number, replacementId: number): Promise<void>;
  skills?(): Promise<{ name: string; description: string }[]>;
  disabledSkills?(): ReadonlySet<string>;
  skillUsed?(name: string): void;
  invokeSkill?(name: string): Promise<{ name: string; instructions: string; services: string[] } | undefined>;
  attachServices?(conversationId: number, domains: string[]): Promise<void>;
  routes?: Record<string, VMRoute>;
  start?(): Promise<void>;
  close?(): Promise<void>;
  content?: { busy?(): boolean; snapshot?(): Promise<{ data: Record<string, unknown>; files: { path: string; data: Uint8Array }[] }>;
    reset?(expected: Record<string, string | null>): Promise<void> };
  serviceDependencies?(domain: string): Promise<{ schedules: number; activeSchedules: number }>;
  permissionSchedules?(): Promise<{ id: string; name: string }[]>;
  familiarWebVisit?(url: string): Promise<boolean>;
  spaceConnectionProof?(domain: string): Promise<SpaceConnectionProof>;
  spaceTask?(call: FunctionCall): SpaceScheduleBinding | undefined;
}
export type VMRoute = (request: Request, url: URL, parts: string[], owner?: string) => Promise<Response>;
export type VMFactory = (context: VMContext) => VMModule | Promise<VMModule>;

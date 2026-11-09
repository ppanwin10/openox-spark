import type { AppFileRequest, AttachedService, FileBackend, FileMount, FunctionCall, FunctionHandler, LinuxProfile, ModelChoice, ServiceKind } from "@openox/agent/linux";
import type { HostSettings } from "../config";
import type { Logger } from "../logs";
import type { Notice } from "../notifications";
import type { Providers } from "../providers";
import type { BrowserManager } from "./browser/manager";

export type VMEvent = { type: "pages" | "services" | "schedules" | "skills" | "secrets" | "repositories" };
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
  settings(): HostSettings;
  updateSettings(change: Partial<HostSettings>): Promise<void>;
  defaultModel(): ModelChoice | undefined;
  emit(event: VMEvent): void;
  notify(notice: Notice): void;
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
}
export type VMRoute = (request: Request, url: URL, parts: string[]) => Promise<Response>;
export type VMFactory = (context: VMContext) => VMModule | Promise<VMModule>;

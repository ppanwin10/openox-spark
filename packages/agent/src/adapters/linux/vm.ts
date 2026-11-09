import type { TurnState } from "../../core/prompts";
import type { FileBackend, FileMount } from "../../core/file-mounts";
import type { FileOperation } from "../../core/filesystem";
import type { Step } from "./transcript";
import type { LinuxProfile } from "./profile";

export interface PromptField { name: string; label: string; secret?: boolean; optional?: boolean; multiline?: boolean }
export type PromptRequest =
  | { kind: "choice"; body: string; options: string[] }
  | { kind: "approval"; title: string; body: string; detail?: string }
  | { kind: "form"; title: string; body: string; fields: PromptField[]; submit?: string }
  | { kind: "page"; title: string; body: string; page: string; done: string };
export type PromptAnswer = { kind: "answer"; text: string } | { kind: "values"; values: Record<string, string> } | { kind: "cancelled" };
export type PromptResponse = string | { values: Record<string, string> } | { cancel: true };
export const approvalOptions = ["Approve", "Always approve", "Deny"] as const;

export interface Attachment { name: string; mimeType: string; bytes: number; data?: string; text?: string }
export interface ExecutionBudget { fetches: number; attachments: Attachment[] }
export type AttachedService = TurnState["attachedServices"][number];
export type ServiceKind = NonNullable<TurnState["hostContext"]>["hosts"][number]["serviceKinds"][number];

export interface FunctionCall {
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly conversationId: number;
  readonly signal: AbortSignal;
  readonly step: Step;
  readonly execution: ExecutionBudget;
  readonly profile: LinuxProfile;
  update(fields: Partial<Step>): Promise<void>;
  ask(request: PromptRequest): Promise<PromptAnswer>;
  untimed<T>(work: () => Promise<T>): Promise<T>;
  evaluate(source: string, args: unknown): Promise<{ value: unknown; logs: string[] }>;
}
export type FunctionHandler = (call: FunctionCall) => Promise<unknown>;
export interface AppFileRequest { operation: FileOperation; path: string; diagnostics: { path: string; message: string }[] }

export interface HostFunctions {
  handlers: Record<string, FunctionHandler>;
  limitations?: string;
  serviceKinds?: ServiceKind[];
  unavailableSkills?: readonly string[];
  mounts?: readonly FileMount[];
  appFiles?(call: FunctionCall, request: AppFileRequest): FileBackend;
  skills?(): Promise<TurnState["skills"]>;
  disabledSkills?(): ReadonlySet<string>;
  skillUsed?(name: string): void;
  attachedServices?(conversationId: number): Promise<AttachedService[]>;
  conversationRemoved?(conversationId: number): Promise<void>;
  conversationForked?(sourceId: number, forkId: number): Promise<void>;
  conversationReplaced?(sourceId: number, replacementId: number): Promise<void>;
}

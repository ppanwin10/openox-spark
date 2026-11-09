import { existsSync } from "node:fs";
import { lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord";
import { AgentDoc, defineExtension, defineTool, section, ToolResultEntry, type ConversationId, type Cursor, type EntryId, type EntryRecord, type Extension, type JsonObject } from "@earendil-works/pi-durable";
import { FileError } from "@earendil-works/pi-durable/env";
import type { AssistantMessage, Message, Models, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { openProfileRuntime, type CommittedEvent, type ProfileRuntime } from "../../profile/runtime";
import { ApplicationPresentation } from "../../profile/presentation";
import { ConversationApplicationMetadata } from "../../profile/install";
import { ConversationPresentation, type ConversationReference } from "../../profile/conversations";
import type { ConversationIndexCursor } from "../../profile/conversation-index";
import { profileMounts } from "../../profile/filesystem";
import { conversationRecordPath } from "../../profile/file-store";
import { applyChanges } from "../../profile/committed-partial";
import { mountedFileSystem, type FileBackend, type FileMount } from "../../core/file-mounts";
import { canonical } from "../../core/file-paths";
import { resolveFileRequest, validateFileRequest, type FileOperation, type FileRequest } from "../../core/filesystem";
import { composeOxPrompt, composeOxTurnSections } from "../../core/ox-prompts";
import { renderSections, type TurnState } from "../../core/prompts";
import type { HostContext } from "../../core/host-context";
import { executeGuidance } from "../../core/tool-prompts";
import { bundledSkills } from "../../core/bundled-skills";
import { isSkillResourcePath, parseSkill } from "@openox/protocol/skills";
import { sqliteDatabase } from "./database";
import { diskPath, diskProfileFiles } from "./files";
import { documentText } from "./documents";
import { checkedCall, functionCatalog, OxError, scriptContracts, supportedFunctions } from "./functions";
import { evaluateScript, runScript, type ExecutionClock, type ScriptCall } from "./execute";
import { assistantSeed, displayed, stepsOf, transcript, userInput, type FollowIntent, type LivePrompt, type Step } from "./transcript";
import { approvalOptions, type Attachment, type ExecutionBudget, type FunctionCall, type HostFunctions, type PromptAnswer, type PromptRequest, type PromptResponse } from "./vm";

const context = BACKGROUND_CONTEXT;
const referenceSeconds = 978_307_200;
const limits = { activeMs: 60_000, maxLines: 2_000, maxBytes: 50 * 1024 };
export const executionLimits = { fetches: 8, attachments: 4 };
const defaultUnavailableSkills = ["checkout", "evolve"];
const defaultLimitations = "This Host is an always-on Linux server. Its tools read, write, and organize the Profile's files, including text and PDF documents, and talk with the user through questions, progress, and follow-up choices. It has no services, website access, web search, URL fetching, browser pages, schedules, or shell commands. When a request needs one of these, say plainly that this Host cannot do it yet and offer what it can do with files. Do not offer, describe, or imply capabilities this Host lacks.";
const mutations = new Set<FileOperation>(["write", "edit", "mkdir", "move", "copy", "rm"]);
const turnKeys = ["skills", "hosts", "replies", "attached_services", "conversation_files", "mounted_folders", "storage", "language"] as const;
const recoveries: Record<string, string> = {
  not_found: "Check the path with ox.fs.list or ox.fs.glob before retrying.",
  permission_denied: "Use a writable Profile path; conversation records, bundled skills, and Host storage are read-only.",
  invalid: "Read the current file or directory state, then retry with corrected arguments.",
  not_supported: "Tell the user this file or operation is unsupported on this Host.",
};

export interface ModelChoice { provider: string; modelId: string; thinkingLevel?: ModelThinkingLevel }
export interface LinuxProfileOptions {
  directory: string;
  profileID: string;
  hostID: string;
  models: Models;
  functions?: HostFunctions;
  onChange?(conversationID: number): void;
  onStream?(conversationID: number, update: StreamUpdate): void;
  onReport?(error: unknown): void;
}
export interface StreamUpdate { ref: string; kind: "text" | "reasoning"; offset: number; delta: string; final?: true }
export interface ConversationSummary {
  id: number; title: string; model: ModelChoice | null; createdAt: number; lastActivity: number | null;
  unread: boolean; favorite: boolean; busy: boolean; temporary: boolean;
}
export interface PendingPrompt { id: string; prompt: string; options: string[]; allowsCustomAnswer: boolean; requiresApp: boolean }
export interface RunOutcome { outcome: "completed" | "failed" | "cancelled"; text?: string; error?: string }
export interface StoredFile { path: string; name: string; kind: "file" | "directory"; size: number; modified: number }
type PresentedConversation = NonNullable<Awaited<ReturnType<ApplicationPresentation["find"]>>["item"]>;
interface Live {
  running: boolean;
  partial?: AssistantMessage;
  steps: Map<string, Step[]>;
  prompt?: LivePrompt & { resolve(answer: PromptAnswer): void };
  follow: FollowIntent[];
  error?: string;
  round: { unreadable: number; readable: number; sample?: string };
  unreadableTurns: number;
  halted?: string;
}

const attachmentContent = (attachment: Attachment) => attachment.data
  ? { type: "image" as const, data: attachment.data, mimeType: attachment.mimeType }
  : { type: "text" as const, text: `Attached ${attachment.name} (${attachment.mimeType}, ${attachment.bytes} bytes):\n${attachment.text ?? ""}` };
const titleFrom = (text: string) => {
  const line = text.split("\n").map(value => value.trim()).find(Boolean) ?? "";
  return line.length > 60 ? `${line.slice(0, 59)}…` : line;
};
const describe = (error: unknown) => error instanceof Error ? error.message : String(error);
const lineageOf = (fields: JsonObject | undefined) => Array.isArray(fields?.lineage) ? fields.lineage.filter((id): id is number => typeof id === "number") : [];
const unreadableTurnLimit = 5;
const unreadableTurnsStopped = `The model sent unreadable tool calls ${unreadableTurnLimit} times in a row, so the run stopped. Try again, or choose another model.`;
const textLengths = (message: AssistantMessage) => message.content.map(part => part.type === "text" ? part.text.length : part.type === "thinking" ? part.thinking.length : -1);
const skillDescription = (text: string, name: string) => { try { return parseSkill(text, name).description; } catch { return undefined; } };
const skillPath = /^skills\/([^/]+)\/(.+)$/;
const skillFile = /^(?:repositories\/[^/]+\/)?skills\/([^/]+)\/SKILL\.md$/;
const checkSkill = (text: unknown, name: string) => {
  try { parseSkill(typeof text === "string" ? text : "", name); }
  catch (error) {
    throw new OxError("invalid_argument", `skills/${name}/SKILL.md must contain valid skill frontmatter and non-empty instructions (${describe(error)}).`,
      `Begin SKILL.md with a "---" line, "name: ${name}", "description: <when to use the skill>" and another "---" line, then the instructions, or create the skill with ox.skill.create.`);
  }
};

export class LinuxProfile {
  readonly id: string;
  readonly content: string;
  private options: LinuxProfileOptions;
  private state: string;
  private runtime!: ProfileRuntime;
  private presentation!: ApplicationPresentation;
  private extension!: Extension;
  private memory = "";
  private lives = new Map<number, Live>();
  private sending = new Map<number, Promise<RunOutcome>>();
  private sweeper?: ReturnType<typeof setInterval>;
  private exclusive: Promise<void> = Promise.resolve();
  private held = new Set<number>();
  private readonly names: string[];
  private readonly supported: ReadonlySet<string>;
  private readonly contracts: Record<string, unknown>;
  private readonly hostContext: HostContext;
  private readonly limitations: string;
  private readonly unavailableSkills: ReadonlySet<string>;

  private constructor(options: LinuxProfileOptions) {
    this.options = options;
    this.id = options.profileID;
    this.content = join(options.directory, "files");
    this.state = join(options.directory, "state");
    this.names = supportedFunctions(Object.keys(options.functions?.handlers ?? {}));
    this.supported = new Set(this.names);
    this.contracts = scriptContracts(this.names);
    this.limitations = options.functions ? options.functions.limitations ?? "" : defaultLimitations;
    this.unavailableSkills = new Set(options.functions?.unavailableSkills ?? defaultUnavailableSkills);
    this.hostContext = { active: { hostID: options.hostID, profileID: options.profileID }, hosts: [{ hostID: options.hostID, profileID: options.profileID,
      functions: [...this.names], serviceKinds: [...options.functions?.serviceKinds ?? []], presentation: "conversation-bubbles", externalFiles: false }] };
  }

  static async open(options: LinuxProfileOptions) {
    const profile = new LinuxProfile(options);
    await profile.start();
    return profile;
  }

  private async start() {
    for (const path of [this.options.directory, this.content, this.state, join(this.state, "staging"), join(this.state, "trash"), join(this.state, "scratch")]) {
      await mkdir(path, { recursive: true, mode: 0o700 });
    }
    const database = join(this.state, "state.sqlite");
    const ready = join(this.state, "ready");
    if (!existsSync(ready)) {
      for (const suffix of ["", "-wal", "-shm"]) await rm(database + suffix, { force: true });
      const prepared = await openProfileRuntime({ database: sqliteDatabase(database), profileID: this.id, models: this.options.models,
        fileStorage: { kind: "prepare", backend: diskProfileFiles(this.content, this.state), publicFiles: true } });
      try {
        await prepared.files.install([], []);
        await prepared.files.bindPhysicalFiles(true);
        await prepared.files.seedDocument("MEMORY.md", "");
      } finally { await prepared.close(); }
      await writeFile(ready, `${new Date().toISOString()}\n`, { mode: 0o600 });
    }
    this.runtime = await openProfileRuntime({ database: sqliteDatabase(database), profileID: this.id, models: this.options.models,
      fileStorage: { kind: "physical", backend: diskProfileFiles(this.content, this.state), publicFiles: true }, mounts: this.options.functions?.mounts ?? [],
      settings: { retry: { enabled: true, maxRetries: 2 }, toolExecution: "parallel", progress: { partialIntervalMs: 50 } },
      onEvents: async (id, events) => this.observe(id, events),
      onReport: error => this.options.onReport?.(error) });
    this.presentation = new ApplicationPresentation(this.runtime);
    await this.trashConversationFolders((await this.runtime.files.state()).deletedConversations);
    this.extension = this.createExtension();
    this.runtime.registry.install(this.extension);
    await this.loadMemory();
    const inspection = await this.runtime.harness.inspect(context);
    const pending = new Set<number>([...inspection.tasks.map(task => task.record.conversationId), ...inspection.submissions.map(submission => submission.conversationId)]
      .filter((id): id is ConversationId => typeof id === "number"));
    for (const id of pending) {
      this.live(id).running = true;
      await this.runtime.observe(this.runtime.conversations.reference(id as ConversationId));
    }
    this.runtime.harness.resume();
    await this.sweepTemporary().catch(error => this.options.onReport?.(error));
    this.sweeper = setInterval(() => void this.sweepTemporary().catch(error => this.options.onReport?.(error)), 3_600_000);
    this.sweeper.unref?.();
  }

  private live(id: number) {
    let live = this.lives.get(id);
    if (!live) { live = { running: false, steps: new Map(), follow: [], round: { unreadable: 0, readable: 0 }, unreadableTurns: 0 }; this.lives.set(id, live); }
    return live;
  }
  private changed(id: number) { this.options.onChange?.(id); }

  private async observe(id: ConversationId, events: CommittedEvent[]) {
    const live = this.live(id);
    let structural = false;
    for (const event of events) {
      if (event.type === "message_update") {
        const before = live.partial, lengths = before ? textLengths(before) : [];
        if (event.partial) { live.partial = structuredClone(event.partial); structural = true; }
        else if (live.partial) { applyChanges(live.partial, event); structural ||= !event.changes.every(change => change.type === "text_delta" || change.type === "thinking_delta"); }
        if (live.partial) this.streamed(id, live.partial, before?.timestamp === live.partial.timestamp ? lengths : []);
        continue;
      }
      structural = true;
      if (event.type === "run_start") live.running = true;
      else if (event.type === "run_end") live.running = this.sending.has(id);
      else if (event.type === "message_start" && event.message.role === "assistant") { live.partial = structuredClone(event.message); this.streamed(id, live.partial, []); }
      else if (event.type === "message_end") {
        const partial = live.partial;
        const committed = partial && event.entry.model?.find((message): message is AssistantMessage => message.role === "assistant" && message.timestamp === partial.timestamp);
        if (partial && committed) this.streamed(id, committed, textLengths(partial), true);
        live.partial = undefined;
      }
      else if (event.type === "tool_execution_start") live.steps.set(event.toolCallId, []);
      else if (event.type === "tool_execution_update" && event.details !== undefined) live.steps.set(event.toolCallId, stepsOf(event.details));
      else if (event.type === "tool_execution_end") {
        live.steps.delete(event.toolCallId);
        if (event.entry) this.countCall(live, event.entry);
      }
      else if (event.type === "turn_end") this.endTurn(id, live);
    }
    if (structural) this.changed(id);
  }

  private countCall(live: Live, entry: EntryRecord) {
    const unreadable = ToolResultEntry.is(entry) ? entry.data.diagnostics.find(diagnostic => diagnostic.code === "invalid_arguments") : undefined;
    if (unreadable) live.round = { ...live.round, unreadable: live.round.unreadable + 1, sample: unreadable.message };
    else live.round = { ...live.round, readable: live.round.readable + 1 };
  }

  private endTurn(id: number, live: Live) {
    const { unreadable, readable, sample } = live.round;
    live.round = { unreadable: 0, readable: 0 };
    if (!unreadable && !readable) return;
    live.unreadableTurns = readable ? 0 : live.unreadableTurns + 1;
    if (live.unreadableTurns < unreadableTurnLimit || live.halted) return;
    live.halted = unreadableTurnsStopped;
    this.options.onReport?.(`Stopped conversation ${id} after ${unreadableTurnLimit} replies in a row whose tool calls could not be read; the last: ${(sample ?? "").slice(0, 400)}`);
    void this.runtime.abort(this.reference(id)).catch(error => this.options.onReport?.(error));
  }

  private streamed(id: number, message: AssistantMessage, lengths: number[], final = false) {
    if (!this.options.onStream) return;
    message.content.forEach((part, index) => {
      const text = part.type === "text" ? part.text : part.type === "thinking" ? part.thinking : undefined;
      if (text === undefined) return;
      const offset = Math.min(text.length, Math.max(0, lengths[index] ?? 0));
      if (!final && text.length <= offset) return;
      this.options.onStream!(id, { ref: `${assistantSeed(message)}:${index}`, kind: part.type === "text" ? "text" : "reasoning", offset, delta: text.slice(offset), ...(final ? { final: true as const } : {}) });
    });
  }

  private createExtension() {
    const base = composeOxPrompt({ memory: "", hostContext: this.hostContext }).sections;
    const sections = [
      section("preamble", () => base.preamble, { tag: false }),
      section("rules", () => base.rules),
      ...(this.limitations ? [section("host_limits", () => this.limitations)] : []),
      section("memory", () => this.memory),
      ...turnKeys.map(key => section(key, async ({ conversationId, read }, sectionContext) => {
        const state = (await read.snapshot(ConversationApplicationMetadata, conversationId, sectionContext))?.fields.turnState;
        return composeOxTurnSections((state as unknown as TurnState | undefined) ?? this.defaultTurnState(), { memory: this.memory, hostContext: this.hostContext })[key];
      })),
      section("cwd", ({ conversationId }) => this.cwd(conversationId)),
    ];
    return defineExtension({ name: "ox-linux", sections, tools: [this.executeTool()] });
  }

  private cwd(id: number) {
    return `conversations/${id}/\nRelative file paths resolve here. Use / for the Profile root and absolute paths such as /reports/report.md for shared files. Mounted resource paths such as skills/ remain Profile-relative.`;
  }

  private executeDescription() {
    const web = this.supported.has("ox.web.fetch");
    return `Call ox.* functions only inside this tool's JavaScript source; they are not separate tools.\n\n${executeGuidance({ catalog: functionCatalog(this.names),
      timeoutSeconds: limits.activeMs / 1000, maxLines: limits.maxLines, maxBytes: limits.maxBytes, maxFetches: web ? executionLimits.fetches : 0,
      maxTransientAttachments: this.supported.has("ox.fs.attach") ? executionLimits.attachments : 0, canCancelLoops: true })}`;
  }

  private executeParameters() {
    return Type.Object({
      purpose: Type.String({ minLength: 1, maxLength: 80, description: "Short (<10 words) description of this execution." }),
      source: Type.String({ minLength: 1, maxLength: 100_000, description: "JavaScript snippet body. Use `await`; print model-visible data with `console.log` or a top-level `return`." }),
    }, { additionalProperties: false });
  }

  private executeTool() {
    return defineTool({ name: "execute", description: this.executeDescription(), parameters: this.executeParameters(), replay: "unsafe", executionMode: "sequential",
      outputLimits: { maxBytes: limits.maxBytes + 1_024, maxLines: limits.maxLines + 2, retain: "tail" },
      execute: async ({ purpose, source }, api, toolContext) => {
        const steps: Step[] = [];
        const execution: ExecutionBudget = { fetches: 0, attachments: [] };
        let requested = 0, published = 0, flushing: Promise<void> | undefined;
        const publish = () => {
          requested += 1;
          flushing ??= (async () => {
            while (published < requested) {
              const target = requested;
              try { await api.details({ purpose, steps: structuredClone(steps) } as unknown as JsonValue, toolContext); }
              catch (error) { this.options.onReport?.(error); }
              published = target;
            }
            flushing = undefined;
          })();
          return flushing;
        };
        const dispatch: ScriptCall = async (name, args, signal, clock) => {
          const step: Step = { name, purpose: args && typeof args === "object" && typeof (args as { purpose?: unknown }).purpose === "string" ? (args as { purpose: string }).purpose : "", status: "running" };
          steps.push(step);
          void publish();
          try {
            const value = await this.invoke(api.conversationId, name, args, signal, clock, step, publish, execution, dispatch);
            step.status = "ok";
            return value;
          } catch (error) {
            step.status = "error";
            step.error = describe(error);
            throw error;
          } finally { void publish(); }
        };
        const outcome = await runScript(source, this.contracts, dispatch, toolContext.abortSignal, limits);
        await flushing;
        return { output: [{ type: "text" as const, text: outcome.text }, ...execution.attachments.map(attachmentContent)], isError: outcome.isError,
          details: { purpose, steps } as unknown as JsonValue };
      } });
  }

  private async invoke(id: number, name: string, args: unknown, signal: AbortSignal, clock: ExecutionClock, step: Step, publish: () => Promise<void>, execution: ExecutionBudget, dispatch: ScriptCall) {
    const fn = checkedCall(name, args, this.supported);
    const input = args as Record<string, unknown>;
    if (fn === "ox.user.progress") { step.message = String(input.message); this.changed(id); return null; }
    if (fn === "ox.user.follow") {
      const intents = (input.intents as FollowIntent[]).map(({ label, message }) => ({ label, message }));
      step.intents = intents;
      this.live(id).follow = intents;
      this.changed(id);
      return null;
    }
    if (fn === "ox.user.choose") {
      const answer = await this.ask(id, { kind: "choice", body: String(input.body), options: (input.options as string[]).map(String) }, signal, clock, step, publish);
      if (answer.kind !== "answer") throw new OxError("cancelled", "The user did not answer", "Ask again only if the choice is still needed.");
      return answer.text;
    }
    const handler = this.options.functions?.handlers[fn];
    if (!handler) return this.filesystem(id, fn.slice(6) as FileOperation, input as FileRequest, signal, step);
    const call: FunctionCall = {
      name: fn, args: input, conversationId: id, signal, step, execution, profile: this,
      update: async fields => { Object.assign(step, fields); this.changed(id); void publish(); },
      ask: request => this.ask(id, request, signal, clock, step, publish),
      untimed: async work => {
        clock.pause();
        try { return await work(); } finally { clock.resume(); }
      },
      evaluate: (source, scriptArgs) => evaluateScript(source, scriptArgs, this.contracts, dispatch, clock, signal),
    };
    try { return await handler(call); }
    catch (error) {
      if (error instanceof OxError) throw error;
      if (error instanceof FileError) throw new OxError(error.code, error.message, recoveries[error.code]);
      throw error;
    }
  }

  private async ask(id: number, request: PromptRequest, signal: AbortSignal, clock: ExecutionClock, step: Step, publish: () => Promise<void>): Promise<PromptAnswer> {
    const live = this.live(id);
    if (live.prompt) throw new OxError("conflict", "Another request is already waiting for the user", "Wait for the pending request before asking again.");
    const options = request.kind === "choice" ? request.options : request.kind === "approval" ? [...approvalOptions] : [];
    const details = request.kind === "choice" ? { kind: "choice" as const } : request.kind === "approval" ? { kind: "approval" as const, title: request.title, ...(request.detail ? { detail: request.detail } : {}) }
      : request.kind === "form" ? { kind: "form" as const, title: request.title, fields: request.fields.map(field => ({ ...field })), ...(request.submit ? { submit: request.submit } : {}) }
      : { kind: "page" as const, title: request.title, page: request.page, done: request.done };
    const prompt: LivePrompt = { id: crypto.randomUUID(), prompt: request.body, options, ...details };
    step.body = prompt.prompt;
    step.options = options;
    if (request.kind !== "choice") step.prompt = details;
    void publish();
    clock.pause();
    try {
      const answer = await new Promise<PromptAnswer>((resolve, reject) => {
        const abort = () => reject(new OxError("cancelled", "The run stopped before the user answered", "Ask again only if the request is still needed."));
        if (signal.aborted) { abort(); return; }
        signal.addEventListener("abort", abort, { once: true });
        live.prompt = { ...prompt, resolve: answer => { signal.removeEventListener("abort", abort); resolve(answer); } };
        this.changed(id);
      });
      step.answer = answer.kind === "answer" ? answer.text : answer.kind === "values" ? "Submitted" : request.kind === "page" ? "Closed" : "Cancelled";
      return answer;
    } finally {
      if (this.live(id).prompt?.id === prompt.id) this.live(id).prompt = undefined;
      clock.resume();
      this.changed(id);
    }
  }

  private async filesystem(id: number, operation: FileOperation, args: FileRequest, signal: AbortSignal, step: Step) {
    try {
      validateFileRequest(operation, args);
      const request = validateFileRequest(operation, resolveFileRequest(args, `conversations/${id}`));
      const skill = await this.skillChange(operation, request);
      const value = await this.invokeFilesystem(operation, request, signal);
      const used = operation === "read" ? skillFile.exec(canonical(request.path ?? "")) : null;
      if (used) this.options.functions?.skillUsed?.(used[1]!);
      if (skill?.before !== undefined) {
        const after = await this.runtime.files.read(skill.path).catch(() => undefined);
        try { checkSkill(after, skill.name); }
        catch (error) { await this.invokeFilesystem("write", { purpose: "Restore SKILL.md", path: skill.path, content: skill.before }, signal); throw error; }
      }
      if (mutations.has(operation)) {
        step.path = request.to ?? request.path;
        if ([request.path, request.to, request.from].includes("MEMORY.md")) await this.loadMemory();
        if (skill) await this.refreshTurnState(id).catch(error => this.options.onReport?.(error));
      }
      return value;
    } catch (error) {
      if (error instanceof OxError) throw error;
      if (error instanceof FileError) throw new OxError(error.code, error.message, recoveries[error.code]);
      throw error;
    }
  }

  private async skillChange(operation: FileOperation, request: FileRequest) {
    const target = operation === "move" || operation === "copy" ? request.to : request.path;
    const match = target && ["write", "edit", "mkdir", "move", "copy"].includes(operation) ? skillPath.exec(canonical(target)) : null;
    if (!match) return undefined;
    const name = match[1]!, file = match[2]!, path = `skills/${name}/SKILL.md`;
    if (file !== "SKILL.md") {
      const folder = operation === "mkdir" || (operation !== "write" && operation !== "edit" && (await this.runtime.files.info(request.from!).catch(() => undefined))?.kind === "directory");
      if (!isSkillResourcePath(folder ? `${file}/file.js` : file)) {
        throw new OxError("invalid_argument", `skills/${name}/${file} is not a skill resource path`, "Keep only SKILL.md, references/<file> and scripts/<file>.js in a skill folder.");
      }
      return { name, path };
    }
    if (operation === "mkdir") throw new OxError("invalid_argument", `${path} must be a file`, "Write SKILL.md as a file.");
    if (operation === "edit") return { name, path, before: await this.runtime.files.read(path).then(text => typeof text === "string" ? text : undefined, () => undefined) };
    checkSkill(operation === "write" ? request.content : await this.runtime.files.read(request.from!).catch(() => undefined), name);
    return { name, path };
  }

  private readable(backend: FileBackend): FileBackend {
    return { ...backend, read: async (path, readContext) => {
      const content = await backend.read(path, readContext);
      if (typeof content === "string" && !content.startsWith("%PDF-") && !content.startsWith("{\\rtf")) return content;
      const result = await documentText(typeof content === "string" ? new TextEncoder().encode(content) : content, join(this.state, "scratch"));
      if ("unsupported" in result) throw new FileError("not_supported", result.unsupported, path);
      return result.text;
    } };
  }

  private async invokeFilesystem(operation: FileOperation, args: FileRequest, signal: AbortSignal) {
    const runtime = this.runtime;
    const search = operation === "glob" || operation === "grep";
    const base = canonical(args.path ?? "");
    const records = operation !== "grep" || base === "conversations" || base.startsWith("conversations/") ? "named" : "excluded";
    const mounts = search ? [...profileMounts(runtime.files, runtime.conversations, await runtime.files.snapshot(signal, base), records), ...this.options.functions?.mounts ?? []] : runtime.env.mounts;
    const inputs = mounts.map((mount): FileMount => operation === "read" && mount.source.kind === "backend"
      ? { path: mount.path, access: mount.access, source: { ...mount.source, backend: this.readable(mount.source.backend) } } : mount);
    const env = mountedFileSystem(runtime.conversations.profileID, inputs);
    try { return await runtime.filesystem.invoke(env, operation, args, withAbortSignal(signal, context)); }
    catch (error) {
      if (operation === "read" && error instanceof FileError && error.code === "not_supported") {
        return { path: canonical(args.path!), text: null, truncated: false, unsupported: error.message, nextOffset: null, diagnostics: [] };
      }
      throw error;
    } finally { await env.cleanup(context); }
  }

  private defaultTurnState(filePaths: string[] = [], skills: TurnState["skills"] = this.bundled(), attachedServices: TurnState["attachedServices"] = []): TurnState {
    return { skills, skillConflicts: [], attachedServices, fileMounts: [], hostContext: this.hostContext, filePaths, storageMode: "persisted", responseLanguage: null };
  }
  private async turnState(id: number, filePaths: string[]) {
    return this.defaultTurnState(filePaths, await this.skills(), await this.options.functions?.attachedServices?.(id) ?? []);
  }
  async refreshTurnState(id: number) {
    const metadata = await this.runtime.harness.snapshot(ConversationApplicationMetadata, id as ConversationId, context);
    const previous = metadata?.fields.turnState as unknown as TurnState | undefined;
    const turnState = await this.turnState(id, previous?.filePaths ?? []);
    const conversation = await this.handle(id);
    await conversation.commit(async tx => {
      (await tx.doc(ConversationApplicationMetadata, id as ConversationId)).fields.turnState = turnState as unknown as JsonObject;
    }, context);
  }
  private bundled() {
    const disabled = this.disabledSkills();
    return bundledSkills.filter(skill => !this.unavailableSkills.has(skill.name) && !disabled.has(skill.name)).map(({ name, description }) => ({ name, description }));
  }
  private disabledSkills() { return this.options.functions?.disabledSkills?.() ?? new Set<string>(); }

  private async skills() {
    const disabled = this.disabledSkills();
    const skills = this.bundled();
    const names = new Set([...skills.map(skill => skill.name), ...disabled]);
    const entries = await this.runtime.files.list("skills").catch(() => []);
    for (const entry of entries.filter(entry => entry.kind === "directory" && !names.has(entry.name))) {
      const text = await this.runtime.files.read(`skills/${entry.name}/SKILL.md`).catch(() => undefined);
      const description = typeof text === "string" ? skillDescription(text, entry.name) : undefined;
      if (description) { names.add(entry.name); skills.push({ name: entry.name, description }); }
    }
    for (const skill of await this.options.functions?.skills?.().catch(error => { this.options.onReport?.(error); return []; }) ?? []) {
      if (!names.has(skill.name)) { names.add(skill.name); skills.push(skill); }
    }
    return skills;
  }
  private async loadMemory() {
    const content = await this.runtime.files.read("MEMORY.md").catch(() => "");
    this.memory = typeof content === "string" ? content : "";
  }

  reference(id: number): ConversationReference {
    if (!Number.isSafeInteger(id) || id < 0) throw new Error("Conversation not found");
    return this.runtime.conversations.reference(id as ConversationId);
  }

  private summaryOf(item: PresentedConversation): ConversationSummary {
    const id = item.reference.conversationID;
    const created = typeof item.metadata.createdAt === "number" ? (item.metadata.createdAt + referenceSeconds) * 1000 : item.lastMessageAt ?? 0;
    const model = item.agent?.model ? { provider: item.agent.model.provider, modelId: item.agent.model.modelId,
      ...(item.agent.thinkingLevel ? { thinkingLevel: item.agent.thinkingLevel } : {}) } : null;
    return { id, title: item.presentation?.title ?? "", model, createdAt: Math.round(created), lastActivity: item.lastMessageAt ?? null,
      unread: item.unread, favorite: item.favorite, busy: this.busy(id), temporary: item.metadata.temporary === true };
  }

  busy(id: number) { return this.held.has(id) || this.running(id); }
  private running(id: number) { return this.sending.has(id) || (this.lives.get(id)?.running ?? false); }

  private async serialized<T>(work: () => Promise<T>) {
    const previous = this.exclusive;
    let release!: () => void;
    this.exclusive = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try { return await work(); } finally { release(); }
  }

  private async holding<T>(id: number, work: () => Promise<T>) {
    if (this.busy(id)) throw new Error("This conversation is still working; stop it or wait for it to finish");
    this.held.add(id);
    this.changed(id);
    try { return await work(); } finally { this.held.delete(id); this.changed(id); }
  }

  async list(limit = 100, cursor?: ConversationIndexCursor) {
    const page = await this.presentation.list(limit, cursor);
    return { items: page.items.map(item => this.summaryOf(item)).filter(item => !item.temporary), next: page.next };
  }

  private async catalog() {
    const ids: ConversationId[] = [];
    let cursor: Cursor | undefined;
    do {
      const page = await this.runtime.harness.commit(tx => tx.scanConversations({}, 100, cursor), context);
      ids.push(...page.items.map(record => record.id));
      cursor = page.next;
    } while (cursor);
    const deleted = new Set((await this.runtime.files.state()).deletedConversations);
    return Promise.all(ids.filter(id => !deleted.has(id)).map(async id => {
      const [presentation, metadata] = await Promise.all([this.runtime.harness.snapshot(ConversationPresentation, id, context),
        this.runtime.harness.snapshot(ConversationApplicationMetadata, id, context)]);
      return { id: id as number, visible: presentation?.visible === true, fields: metadata?.fields ?? {} };
    }));
  }

  async sweepTemporary(idleMs = 6 * 3_600_000) {
    let removed = 0;
    for (const row of await this.catalog()) {
      if (row.fields.temporary !== true || !row.visible || this.busy(row.id)) continue;
      const created = typeof row.fields.createdAt === "number" ? (row.fields.createdAt + referenceSeconds) * 1000 : 0;
      const last = await this.runtime.index.lastMessageAt(row.id as ConversationId, row.fields) ?? created;
      if (Date.now() - last < idleMs) continue;
      await this.remove(row.id);
      removed += 1;
    }
    return removed;
  }

  async summary(id: number) {
    const found = await this.presentation.find(this.reference(id));
    if (!found.item) throw new Error("Conversation not found");
    return this.summaryOf(found.item);
  }

  async create(choice?: ModelChoice, options: { temporary?: boolean; lineage?: number[] } = {}) {
    if (choice && !this.options.models.getModel(choice.provider, choice.modelId)) throw new Error(`Model ${choice.provider}/${choice.modelId} is not available`);
    const files = this.runtime.registry.snapshot().extension("ox-profile-files")!;
    const conversation = await this.runtime.harness.createConversation({ ownership: { kind: "ownerless" },
      agent: { ...(choice ? { model: { provider: choice.provider, modelId: choice.modelId } } : {}), ...(choice?.thinkingLevel ? { thinkingLevel: choice.thinkingLevel } : {}),
        extensions: [this.extension, files] },
      init: async (tx, id) => {
        const presentation = await tx.doc(ConversationPresentation, id);
        presentation.visible = true;
        presentation.title = "";
        (await tx.doc(ConversationApplicationMetadata, id)).fields = { createdAt: Date.now() / 1000 - referenceSeconds, ...(options.temporary ? { temporary: true } : {}),
          ...(options.lineage?.length ? { lineage: options.lineage } : {}) };
      } }, context);
    await this.runtime.files.createConversation(conversation.id);
    this.changed(conversation.id);
    return conversation.id as number;
  }

  async exportSource(id: number) {
    await this.handle(id);
    const entries = await this.entries(this.reference(id), 20_000);
    return { summary: await this.summary(id), messages: entries.filter(displayed).flatMap(entry => entry.model!.filter(message => message.role !== "system")) };
  }

  async adopt(options: { choice?: ModelChoice; title: string; files: { name: string; data: Uint8Array }[]; messages(folder: string): Message[][] }) {
    const id = await this.create(options.choice);
    try {
      const folder = `conversations/${id}`;
      for (const file of options.files) await this.writeFile(`${folder}/${file.name}`, file.data);
      const groups = options.messages(folder);
      const conversation = await this.handle(id);
      await conversation.commit(async tx => {
        for (const model of groups) await tx.appendEntry(id as ConversationId, { kind: "ox.import", model });
        (await tx.doc(ConversationPresentation, id as ConversationId)).title = Array.from(options.title).slice(0, 200).join("").trim();
      }, context);
    } catch (error) {
      await this.remove(id).catch(() => {});
      throw error;
    }
    this.runtime.index.refresh(id as ConversationId);
    this.changed(id);
    return id;
  }

  private async turnOf(id: number, entryID: number) {
    const entries = await this.entries(this.reference(id), 10_000);
    const asks = (entry: EntryRecord) => displayed(entry) && entry.model!.some(message => message.role === "user");
    const at = entries.findIndex(entry => entry.id === entryID);
    if (at < 0 || !asks(entries[at]!)) throw new Error("Message not found");
    const next = entries.findIndex((entry, index) => index > at && asks(entry));
    const message = entries[at]!.model!.find(item => item.role === "user")!;
    return { before: at > 0 ? entries[at - 1] : undefined, last: entries[(next < 0 ? entries.length : next) - 1]!, input: message.role === "user" ? userInput(message) : { text: "", files: [] } };
  }

  private async mutable(id: number) {
    await this.ready(id);
    if ((await this.summary(id)).temporary) throw new Error("Temporary conversations can't be branched, edited or regenerated");
  }

  private async choiceOf(id: number): Promise<ModelChoice | undefined> {
    const agent = await this.runtime.harness.snapshot(AgentDoc, id as ConversationId, context);
    return agent?.model ? { provider: agent.model.provider, modelId: agent.model.modelId, ...(agent.thinkingLevel ? { thinkingLevel: agent.thinkingLevel as ModelThinkingLevel } : {}) } : undefined;
  }

  private async forkAt(id: number, entryID: number) {
    const source = await this.handle(id);
    const choice = await this.choiceOf(id);
    const conversation = await source.fork(entryID as EntryId, { ownership: { kind: "ownerless" },
      ...(choice ? { agent: { model: { provider: choice.provider, modelId: choice.modelId }, ...(choice.thinkingLevel ? { thinkingLevel: choice.thinkingLevel } : {}) } } : {}),
      init: async (tx, forkID) => {
        const metadata = await tx.doc(ConversationApplicationMetadata, forkID);
        metadata.fields.createdAt = Date.now() / 1000 - referenceSeconds;
        metadata.fields.lineage = [id, ...lineageOf(metadata.fields)];
      } }, context);
    await this.runtime.files.createConversation(conversation.id);
    this.runtime.index.refresh(conversation.id);
    await this.options.functions?.conversationForked?.(id, conversation.id).catch(error => this.options.onReport?.(error));
    this.changed(conversation.id);
    return conversation.id as number;
  }

  branch(id: number, entryID: number) {
    return this.serialized(async () => {
      await this.mutable(id);
      return this.holding(id, async () => this.forkAt(id, (await this.turnOf(id, entryID)).last.id));
    });
  }

  rerun(id: number, entryID: number, text?: string) {
    return this.serialized(async () => {
      await this.mutable(id);
      return this.holding(id, () => this.rerunHeld(id, entryID, text));
    });
  }

  private async rerunHeld(id: number, entryID: number, text?: string) {
    const turn = await this.turnOf(id, entryID);
    const prompt = text === undefined ? turn.input.text : text.trim();
    if (text !== undefined && !prompt) throw new Error("Write a message");
    let created: number;
    if (turn.before) created = await this.forkAt(id, turn.before.id);
    else {
      const source = await this.runtime.harness.snapshot(ConversationApplicationMetadata, id as ConversationId, context);
      created = await this.create(await this.choiceOf(id), { lineage: [id, ...lineageOf(source?.fields)] });
      const { title } = await this.summary(id);
      if (title) await this.rename(created, title);
      await this.options.functions?.conversationForked?.(id, created).catch(error => this.options.onReport?.(error));
    }
    await this.options.functions?.conversationReplaced?.(id, created).catch(error => this.options.onReport?.(error));
    await this.retire(id);
    return { id: created, text: prompt || "Please review the attached files.", files: turn.input.files };
  }

  async setModel(id: number, choice: ModelChoice) {
    if (this.busy(id)) throw new Error("Stop the running turn before changing models");
    if (!this.options.models.getModel(choice.provider, choice.modelId)) throw new Error(`Model ${choice.provider}/${choice.modelId} is not available`);
    const conversation = await this.handle(id);
    await conversation.commit(async tx => {
      const agent = await tx.doc(AgentDoc, id as ConversationId);
      agent.model = { provider: choice.provider, modelId: choice.modelId };
      if (choice.thinkingLevel && choice.thinkingLevel !== "off") agent.thinkingLevel = choice.thinkingLevel; else delete agent.thinkingLevel;
    }, context);
    this.changed(id);
  }

  async rename(id: number, title: string) {
    await this.runtime.conversations.present(this.reference(id), { title: title.trim().slice(0, 200) });
    this.changed(id);
  }

  remove(id: number) { return this.serialized(() => this.removeHeld(id)); }

  private async removeHeld(id: number) {
    this.held.add(id);
    try { await this.removeHolding(id); } finally { this.held.delete(id); }
  }

  private async removeHolding(id: number) {
    if (this.running(id)) await this.stop(id);
    const catalog = await this.catalog();
    const gone = new Set<number>();
    const needed = (target: number) => catalog.some(row => row.id !== target && !gone.has(row.id) && lineageOf(row.fields).includes(target));
    if (needed(id)) await this.retire(id);
    else { await this.purge(id); gone.add(id); }
    for (const ancestor of lineageOf(catalog.find(row => row.id === id)?.fields)) {
      const row = catalog.find(item => item.id === ancestor);
      if (!row || row.visible || needed(ancestor)) break;
      await this.purge(ancestor);
      gone.add(ancestor);
    }
  }

  private async retire(id: number) {
    await this.runtime.conversations.present(this.reference(id), { visible: false });
    if (this.running(id)) await this.runtime.abort(this.reference(id)).catch(error => this.options.onReport?.(error));
    await this.options.functions?.conversationRemoved?.(id).catch(error => this.options.onReport?.(error));
    this.lives.delete(id);
    this.changed(id);
  }

  private async purge(id: number) {
    await this.presentation.delete(this.reference(id));
    await this.trashConversationFolders([id]);
    await this.options.functions?.conversationRemoved?.(id).catch(error => this.options.onReport?.(error));
    this.lives.delete(id);
    this.changed(id);
  }

  private async trashConversationFolders(ids: readonly number[]) {
    for (const id of ids) {
      const folder = join(this.content, "conversations", String(id));
      const info = await lstat(folder).catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; });
      if (!info?.isDirectory()) continue;
      const destination = join(this.state, "trash", `${Date.now()}-${crypto.randomUUID()}`, "conversations", String(id));
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      await rename(folder, destination);
    }
  }

  async markRead(id: number) {
    const reference = this.reference(id);
    const latest = (await this.runtime.conversations.history(reference, 1)).items[0];
    if (latest) await this.runtime.conversations.markRead(reference, latest.id);
  }

  private async handle(id: number) {
    const conversation = await this.runtime.harness.conversation(id as ConversationId, context);
    if (!conversation || !await this.runtime.conversations.visible(this.reference(id))) throw new Error("Conversation not found");
    return conversation;
  }

  async ready(id: number) {
    await this.handle(id);
    if (this.busy(id)) throw new Error("This conversation is still working; stop it or wait for it to finish");
    const agent = await this.runtime.harness.snapshot(AgentDoc, id as ConversationId, context);
    if (!agent?.model || !this.options.models.getModel(agent.model.provider, agent.model.modelId)) throw new Error("Choose an available model for this conversation");
  }

  send(id: number, text: string, attachments: string[] = []) {
    if (this.busy(id)) return Promise.reject(new Error("This conversation is already working; stop it or wait for it to finish"));
    const run = this.run(id, text, attachments);
    this.sending.set(id, run);
    const settle = () => {
      if (this.sending.get(id) === run) this.sending.delete(id);
      const live = this.live(id);
      live.running = false;
      live.partial = undefined;
      live.steps.clear();
      this.changed(id);
    };
    run.then(settle, settle);
    this.changed(id);
    return run;
  }

  private async run(id: number, text: string, attachments: string[]): Promise<RunOutcome> {
    const live = this.live(id);
    live.running = true;
    live.follow = [];
    live.error = undefined;
    live.round = { unreadable: 0, readable: 0 };
    live.unreadableTurns = 0;
    live.halted = undefined;
    try {
      const conversation = await this.handle(id);
      const agent = await this.runtime.harness.snapshot(AgentDoc, id as ConversationId, context);
      if (!agent?.model || !this.options.models.getModel(agent.model.provider, agent.model.modelId)) throw new Error("Choose an available model for this conversation");
      await this.loadMemory();
      const files = attachments.map(path => canonical(path));
      const turnState = await this.turnState(id, files);
      await conversation.commit(async tx => {
        (await tx.doc(ConversationApplicationMetadata, id as ConversationId)).fields.turnState = turnState as unknown as JsonObject;
        const presentation = await tx.doc(ConversationPresentation, id as ConversationId);
        if (!presentation.title) presentation.title = titleFrom(text) || "New conversation";
      }, context);
      const content = files.length ? `${text}\n\n${files.map(path => `[Attachment: ${path}]`).join("\n")}` : text;
      if (!await this.runtime.conversations.visible(this.reference(id))) throw new Error("Conversation not found");
      const result = await this.runtime.run(this.reference(id), { type: "input", content, requestId: crypto.randomUUID() });
      if (live.halted) {
        live.error = live.halted;
        return { outcome: "failed", error: live.halted };
      }
      const last = result.messages.at(-1);
      if (last?.role === "assistant" && last.stopReason === "aborted") return { outcome: "cancelled" };
      if (result.receipt.status !== "done" || last?.role !== "assistant" || last.stopReason === "error") {
        const error = last?.role === "assistant" && last.errorMessage || ("detail" in result.receipt ? String(result.receipt.detail) : `Run ended: ${result.receipt.status}`);
        live.error = error;
        return { outcome: "failed", error };
      }
      const reply = last.content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n");
      if (last.stopReason === "length" && !reply.trim()) {
        live.error = "The model reached its output limit before it wrote an answer. Ask again, or ask for a shorter answer.";
        return { outcome: "failed", error: live.error };
      }
      return { outcome: "completed", text: reply };
    } catch (error) {
      live.error = describe(error);
      return { outcome: "failed", error: live.error };
    }
  }

  async stop(id: number) {
    const running = this.running(id);
    if (running) await this.runtime.abort(this.reference(id));
    return running;
  }

  respond(id: number, promptID: string, response: PromptResponse) {
    const prompt = this.lives.get(id)?.prompt;
    if (!prompt || prompt.id !== promptID) throw new Error("This request is no longer waiting for an answer");
    if (typeof response === "object" && "cancel" in response) {
      if (prompt.kind === "choice" || prompt.kind === "approval") throw new Error("Choose one of the offered answers");
      prompt.resolve({ kind: "cancelled" });
      return;
    }
    if (typeof response === "object") {
      if (prompt.kind !== "form") throw new Error("This request does not take form values");
      const values: Record<string, string> = {};
      for (const field of prompt.fields ?? []) {
        const value = response.values[field.name];
        if (typeof value !== "string" || !value.trim()) {
          if (field.optional) continue;
          throw new Error(`Enter ${field.label}`);
        }
        if (value.length > 16_384) throw new Error(`${field.label} is too long`);
        values[field.name] = value;
      }
      prompt.resolve({ kind: "values", values });
      return;
    }
    const text = response.trim();
    if (!text || text.length > 2_000) throw new Error("Answers must be 1-2000 characters");
    if (prompt.kind === "form") throw new Error("Complete this request in the Ox web app");
    if (prompt.kind !== "choice" && !prompt.options.includes(text) && !(prompt.kind === "page" && text === prompt.done)) {
      throw new Error(`Answer with one of: ${[...prompt.options, ...(prompt.kind === "page" && prompt.done ? [prompt.done] : [])].join(", ")}`);
    }
    prompt.resolve({ kind: "answer", text });
  }

  pendingPrompt(id: number): PendingPrompt | undefined {
    const prompt = this.lives.get(id)?.prompt;
    if (!prompt) return undefined;
    const kind = prompt.kind ?? "choice";
    return { id: prompt.id, prompt: prompt.title ? `${prompt.title}\n\n${prompt.prompt}` : prompt.prompt, options: kind === "page" && prompt.done ? [prompt.done] : prompt.options,
      allowsCustomAnswer: kind === "choice", requiresApp: kind === "form" || kind === "page" };
  }

  private async entries(reference: ConversationReference, limit = 600) {
    const entries: EntryRecord[] = [];
    let cursor;
    do {
      const page = await this.runtime.conversations.history(reference, 100, cursor);
      entries.push(...page.items);
      cursor = page.next;
    } while (cursor && entries.length < limit);
    return entries.reverse();
  }

  async view(id: number) {
    const reference = this.reference(id);
    const summary = await this.summary(id);
    const live = this.live(id);
    const { blocks, messages } = transcript(await this.entries(reference), { partial: live.partial, steps: live.steps, prompt: live.prompt });
    return { summary, blocks, messages, busy: this.busy(id), pendingPrompt: this.pendingPrompt(id), follow: live.follow, error: live.error ?? null };
  }

  async systemPrompt(id: number) {
    const state = (await this.runtime.harness.snapshot(ConversationApplicationMetadata, id as ConversationId, context))?.fields.turnState as unknown as TurnState | undefined;
    const input = { memory: this.memory, hostContext: this.hostContext };
    const { preamble, rules, ...rest } = composeOxPrompt(input).sections;
    return renderSections({ preamble, rules, ...(this.limitations ? { host_limits: this.limitations } : {}), ...rest, ...composeOxTurnSections(state ?? this.defaultTurnState(), input), cwd: this.cwd(id) });
  }

  tools() { return [{ name: "execute", description: this.executeDescription(), parameters: this.executeParameters() as unknown as JsonValue, strict: false }]; }

  get memoryText() { return this.memory; }
  async setMemory(text: string) {
    await this.runtime.files.write("MEMORY.md", text);
    await this.loadMemory();
  }

  async listFiles(path: string): Promise<StoredFile[]> {
    const entries = await this.runtime.files.list(canonical(path));
    return entries.map(entry => ({ path: canonical(entry.path), name: entry.name, kind: entry.kind === "directory" ? "directory" : "file", size: entry.size, modified: entry.mtimeMs ?? 0 }));
  }
  async statFile(path: string): Promise<StoredFile> {
    const entry = await this.runtime.files.info(canonical(path));
    return { path: canonical(entry.path), name: entry.name, kind: entry.kind === "directory" ? "directory" : "file", size: entry.size, modified: entry.mtimeMs ?? 0 };
  }
  private writable(path: string) {
    const target = canonical(path);
    if (conversationRecordPath(target)) throw new FileError("permission_denied", "conversation.json and turns.jsonl are reserved for conversation records", target);
    return target;
  }
  async writeFile(path: string, content: string | Uint8Array) {
    const target = this.writable(path);
    await this.runtime.files.write(target, content);
    if (target === "MEMORY.md") await this.loadMemory();
    return this.statFile(target);
  }
  async makeDirectory(path: string) { await this.runtime.files.mkdir(this.writable(path), true); return this.statFile(path); }
  async moveFile(from: string, to: string) { await this.runtime.files.move(canonical(from), this.writable(to)); return this.statFile(to); }
  async openFile(path: string) {
    const entry = await this.statFile(path);
    if (entry.kind !== "file") throw new FileError("is_directory", "Expected a file", path);
    return { entry, file: Bun.file(await diskPath(this.content, entry.path)) };
  }
  async removeFile(path: string) {
    const entry = await this.statFile(path);
    await this.runtime.files.remove(entry.path, entry.kind === "directory", true);
    if (entry.path === "MEMORY.md") await this.loadMemory();
  }

  async close() {
    clearInterval(this.sweeper);
    for (const id of this.sending.keys()) await this.stop(id).catch(() => {});
    await Promise.allSettled(this.sending.values());
    await this.runtime.close();
  }
}

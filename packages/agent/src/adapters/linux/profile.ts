import { existsSync } from "node:fs";
import { lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord";
import { AgentDoc, defineExtension, defineTool, section, type ConversationId, type EntryRecord, type Extension, type JsonObject } from "@earendil-works/pi-durable";
import { FileError } from "@earendil-works/pi-durable/env";
import type { Models, ModelThinkingLevel } from "@earendil-works/pi-ai";
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
import { sqliteDatabase } from "./database";
import { diskPath, diskProfileFiles } from "./files";
import { documentText } from "./documents";
import { checkedCall, functionCatalog, linuxFunctions, OxError, scriptContracts } from "./functions";
import { runScript, type ExecutionClock } from "./execute";
import { stepsOf, transcript, type FollowIntent, type LivePrompt, type Step } from "./transcript";

const context = BACKGROUND_CONTEXT;
const referenceSeconds = 978_307_200;
const limits = { activeMs: 60_000, maxLines: 2_000, maxBytes: 50 * 1024 };
const unavailableSkills = new Set(["checkout", "evolve"]);
const hostLimits = "This Host is an always-on Linux server. Its tools read, write, and organize the Profile's files, including text and PDF documents, and talk with the user through questions, progress, and follow-up choices. It has no services, website access, web search, URL fetching, browser pages, schedules, or shell commands. When a request needs one of these, say plainly that this Host cannot do it yet and offer what it can do with files. Do not offer, describe, or imply capabilities this Host lacks.";
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
  onChange?(conversationID: number): void;
  onReport?(error: unknown): void;
}
export interface ConversationSummary {
  id: number; title: string; model: ModelChoice | null; createdAt: number; lastActivity: number | null;
  unread: boolean; favorite: boolean; busy: boolean;
}
export interface PendingPrompt { id: string; prompt: string; options: string[]; allowsCustomAnswer: boolean; requiresApp: boolean }
export interface RunOutcome { outcome: "completed" | "failed" | "cancelled"; text?: string; error?: string }
export interface StoredFile { path: string; name: string; kind: "file" | "directory"; size: number; modified: number }
type PresentedConversation = NonNullable<Awaited<ReturnType<ApplicationPresentation["find"]>>["item"]>;
interface Live {
  running: boolean;
  partial?: import("@earendil-works/pi-ai").AssistantMessage;
  steps: Map<string, Step[]>;
  prompt?: LivePrompt & { resolve(answer: string): void };
  follow: FollowIntent[];
  error?: string;
}

const titleFrom = (text: string) => {
  const line = text.split("\n").map(value => value.trim()).find(Boolean) ?? "";
  return line.length > 60 ? `${line.slice(0, 59)}…` : line;
};
const describe = (error: unknown) => error instanceof Error ? error.message : String(error);
const skillDescription = (text: string) => {
  const front = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? "";
  return /^description:\s*(.+)$/m.exec(front)?.[1]?.trim().replace(/^["']|["']$/g, "");
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
  private readonly contracts = scriptContracts();
  private readonly hostContext: HostContext;

  private constructor(options: LinuxProfileOptions) {
    this.options = options;
    this.id = options.profileID;
    this.content = join(options.directory, "files");
    this.state = join(options.directory, "state");
    this.hostContext = { active: { hostID: options.hostID, profileID: options.profileID }, hosts: [{ hostID: options.hostID, profileID: options.profileID,
      functions: [...linuxFunctions], serviceKinds: [], presentation: "conversation-bubbles", externalFiles: false }] };
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
      fileStorage: { kind: "physical", backend: diskProfileFiles(this.content, this.state), publicFiles: true },
      settings: { retry: { enabled: true, maxRetries: 2 }, toolExecution: "parallel" },
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
  }

  private live(id: number) {
    let live = this.lives.get(id);
    if (!live) { live = { running: false, steps: new Map(), follow: [] }; this.lives.set(id, live); }
    return live;
  }
  private changed(id: number) { this.options.onChange?.(id); }

  private async observe(id: ConversationId, events: CommittedEvent[]) {
    const live = this.live(id);
    for (const event of events) {
      if (event.type === "run_start") live.running = true;
      else if (event.type === "run_end") live.running = this.sending.has(id);
      else if (event.type === "message_start" && event.message.role === "assistant") live.partial = structuredClone(event.message);
      else if (event.type === "message_update") {
        if (event.partial) live.partial = structuredClone(event.partial);
        else if (live.partial) applyChanges(live.partial, event);
      } else if (event.type === "message_end") live.partial = undefined;
      else if (event.type === "tool_execution_start") live.steps.set(event.toolCallId, []);
      else if (event.type === "tool_execution_update" && event.details !== undefined) live.steps.set(event.toolCallId, stepsOf(event.details));
      else if (event.type === "tool_execution_end") live.steps.delete(event.toolCallId);
    }
    this.changed(id);
  }

  private createExtension() {
    const base = composeOxPrompt({ memory: "", hostContext: this.hostContext }).sections;
    const sections = [
      section("preamble", () => base.preamble, { tag: false }),
      section("rules", () => base.rules),
      section("host_limits", () => hostLimits),
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
    return executeGuidance({ catalog: functionCatalog(), timeoutSeconds: limits.activeMs / 1000, maxLines: limits.maxLines, maxBytes: limits.maxBytes,
      maxFetches: 0, maxTransientAttachments: 0, canCancelLoops: true });
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
        const publish = async () => {
          try { await api.details({ purpose, steps: structuredClone(steps) } as unknown as JsonValue, toolContext); }
          catch (error) { this.options.onReport?.(error); }
        };
        const outcome = await runScript(source, this.contracts, async (name, args, signal, clock) => {
          const step: Step = { name, purpose: args && typeof args === "object" && typeof (args as { purpose?: unknown }).purpose === "string" ? (args as { purpose: string }).purpose : "", status: "running" };
          steps.push(step);
          await publish();
          try {
            const value = await this.invoke(api.conversationId, name, args, signal, clock, step, publish);
            step.status = "ok";
            return value;
          } catch (error) {
            step.status = "error";
            step.error = describe(error);
            throw error;
          } finally { await publish(); }
        }, toolContext.abortSignal, limits);
        return { output: [{ type: "text" as const, text: outcome.text }], isError: outcome.isError, details: { purpose, steps } as unknown as JsonValue };
      } });
  }

  private async invoke(id: number, name: string, args: unknown, signal: AbortSignal, clock: ExecutionClock, step: Step, publish: () => Promise<void>) {
    const fn = checkedCall(name, args);
    const input = args as Record<string, unknown>;
    if (fn === "ox.user.progress") { step.message = String(input.message); this.changed(id); return null; }
    if (fn === "ox.user.follow") {
      const intents = (input.intents as FollowIntent[]).map(({ label, message }) => ({ label, message }));
      step.intents = intents;
      this.live(id).follow = intents;
      this.changed(id);
      return null;
    }
    if (fn === "ox.user.choose") return this.choose(id, input, signal, clock, step, publish);
    return this.filesystem(id, fn.slice(6) as FileOperation, input as FileRequest, signal, step);
  }

  private async choose(id: number, input: Record<string, unknown>, signal: AbortSignal, clock: ExecutionClock, step: Step, publish: () => Promise<void>) {
    const live = this.live(id);
    if (live.prompt) throw new OxError("conflict", "Another choice is already waiting for the user", "Wait for the pending choice before asking again.");
    const prompt: LivePrompt = { id: crypto.randomUUID(), prompt: String(input.body), options: (input.options as string[]).map(String) };
    step.body = prompt.prompt;
    step.options = prompt.options;
    await publish();
    clock.pause();
    try {
      const answer = await new Promise<string>((resolve, reject) => {
        const abort = () => reject(new OxError("cancelled", "The run stopped before the user answered", "Ask again only if the choice is still needed."));
        if (signal.aborted) { abort(); return; }
        signal.addEventListener("abort", abort, { once: true });
        live.prompt = { ...prompt, resolve: answer => { signal.removeEventListener("abort", abort); resolve(answer); } };
        this.changed(id);
      });
      step.answer = answer;
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
      const value = await this.invokeFilesystem(operation, request, signal);
      if (mutations.has(operation)) {
        step.path = request.to ?? request.path;
        if ([request.path, request.to, request.from].includes("MEMORY.md")) await this.loadMemory();
      }
      return value;
    } catch (error) {
      if (error instanceof OxError) throw error;
      if (error instanceof FileError) throw new OxError(error.code, error.message, recoveries[error.code]);
      throw error;
    }
  }

  private readable(backend: FileBackend): FileBackend {
    return { ...backend, read: async (path, readContext) => {
      const content = await backend.read(path, readContext);
      if (typeof content === "string") return content;
      const result = await documentText(content, join(this.state, "scratch"));
      if ("unsupported" in result) throw new FileError("not_supported", result.unsupported, path);
      return result.text;
    } };
  }

  private async invokeFilesystem(operation: FileOperation, args: FileRequest, signal: AbortSignal) {
    const runtime = this.runtime;
    const search = operation === "glob" || operation === "grep";
    const base = canonical(args.path ?? "");
    const records = operation !== "grep" || base === "conversations" || base.startsWith("conversations/") ? "named" : "excluded";
    const mounts = search ? profileMounts(runtime.files, runtime.conversations, await runtime.files.snapshot(signal, base), records) : runtime.env.mounts;
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

  private defaultTurnState(filePaths: string[] = [], skills: TurnState["skills"] = this.bundled()): TurnState {
    return { skills, skillConflicts: [], attachedServices: [], fileMounts: [], hostContext: this.hostContext, filePaths, storageMode: "persisted", responseLanguage: null };
  }
  private bundled() {
    return bundledSkills.filter(skill => !unavailableSkills.has(skill.name)).map(({ name, description }) => ({ name, description }));
  }
  private async skills() {
    const skills = this.bundled();
    const names = new Set(skills.map(skill => skill.name));
    const entries = await this.runtime.files.list("skills").catch(() => []);
    for (const entry of entries.filter(entry => entry.kind === "directory" && !names.has(entry.name))) {
      const text = await this.runtime.files.read(`skills/${entry.name}/SKILL.md`).catch(() => undefined);
      const description = typeof text === "string" ? skillDescription(text) : undefined;
      if (description) skills.push({ name: entry.name, description });
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
      unread: item.unread, favorite: item.favorite, busy: this.busy(id) };
  }

  busy(id: number) { return this.sending.has(id) || (this.lives.get(id)?.running ?? false); }

  async list(limit = 100, cursor?: ConversationIndexCursor) {
    const page = await this.presentation.list(limit, cursor);
    return { items: page.items.map(item => this.summaryOf(item)), next: page.next };
  }

  async summary(id: number) {
    const found = await this.presentation.find(this.reference(id));
    if (!found.item) throw new Error("Conversation not found");
    return this.summaryOf(found.item);
  }

  async create(choice?: ModelChoice) {
    if (choice && !this.options.models.getModel(choice.provider, choice.modelId)) throw new Error(`Model ${choice.provider}/${choice.modelId} is not available`);
    const files = this.runtime.registry.snapshot().extension("ox-profile-files")!;
    const conversation = await this.runtime.harness.createConversation({ ownership: { kind: "ownerless" },
      agent: { ...(choice ? { model: { provider: choice.provider, modelId: choice.modelId } } : {}), ...(choice?.thinkingLevel ? { thinkingLevel: choice.thinkingLevel } : {}),
        extensions: [this.extension, files] },
      init: async (tx, id) => {
        const presentation = await tx.doc(ConversationPresentation, id);
        presentation.visible = true;
        presentation.title = "";
        (await tx.doc(ConversationApplicationMetadata, id)).fields = { createdAt: Date.now() / 1000 - referenceSeconds };
      } }, context);
    await this.runtime.files.createConversation(conversation.id);
    this.changed(conversation.id);
    return conversation.id as number;
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

  async remove(id: number) {
    if (this.busy(id)) await this.stop(id);
    await this.presentation.delete(this.reference(id));
    await this.trashConversationFolders([id]);
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
    try {
      const conversation = await this.handle(id);
      const agent = await this.runtime.harness.snapshot(AgentDoc, id as ConversationId, context);
      if (!agent?.model || !this.options.models.getModel(agent.model.provider, agent.model.modelId)) throw new Error("Choose an available model for this conversation");
      await this.loadMemory();
      const files = attachments.map(path => canonical(path));
      const turnState = this.defaultTurnState(files, await this.skills());
      await conversation.commit(async tx => {
        (await tx.doc(ConversationApplicationMetadata, id as ConversationId)).fields.turnState = turnState as unknown as JsonObject;
        const presentation = await tx.doc(ConversationPresentation, id as ConversationId);
        if (!presentation.title) presentation.title = titleFrom(text) || "New conversation";
      }, context);
      const content = files.length ? `${text}\n\n${files.map(path => `[Attachment: ${path}]`).join("\n")}` : text;
      const result = await this.runtime.run(this.reference(id), { type: "input", content, requestId: crypto.randomUUID() });
      const last = result.messages.at(-1);
      if (last?.role === "assistant" && last.stopReason === "aborted") return { outcome: "cancelled" };
      if (result.receipt.status !== "done" || last?.role !== "assistant" || last.stopReason === "error") {
        const error = last?.role === "assistant" && last.errorMessage || ("detail" in result.receipt ? String(result.receipt.detail) : `Run ended: ${result.receipt.status}`);
        live.error = error;
        return { outcome: "failed", error };
      }
      return { outcome: "completed", text: last.content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n") };
    } catch (error) {
      live.error = describe(error);
      return { outcome: "failed", error: live.error };
    }
  }

  async stop(id: number) {
    const running = this.busy(id);
    if (running) await this.runtime.abort(this.reference(id));
    return running;
  }

  respond(id: number, promptID: string, answer: string) {
    const prompt = this.lives.get(id)?.prompt;
    if (!prompt || prompt.id !== promptID) throw new Error("This choice is no longer waiting for an answer");
    const text = answer.trim();
    if (!text || text.length > 2_000) throw new Error("Answers must be 1-2000 characters");
    prompt.resolve(text);
  }

  pendingPrompt(id: number): PendingPrompt | undefined {
    const prompt = this.lives.get(id)?.prompt;
    return prompt && { id: prompt.id, prompt: prompt.prompt, options: prompt.options, allowsCustomAnswer: true, requiresApp: false };
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
    return renderSections({ preamble, rules, host_limits: hostLimits, ...rest, ...composeOxTurnSections(state ?? this.defaultTurnState(), input), cwd: this.cwd(id) });
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
    for (const id of this.sending.keys()) await this.stop(id).catch(() => {});
    await Promise.allSettled(this.sending.values());
    await this.runtime.close();
  }
}

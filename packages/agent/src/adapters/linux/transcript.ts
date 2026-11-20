import type { AssistantMessage, Message, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import type { JsonValue } from "@earendil-works/chord/json";
import { ToolResultEntry, type EntryRecord } from "@earendil-works/pi-durable";
import { evidenceReply, evidenceRoute, isEvidenceModelMessage } from "./evidence";

export type StepStatus = "running" | "ok" | "error";
export interface FollowIntent { label: string; message: string }
export type PromptKind = "choice" | "approval" | "form" | "page";
export interface PromptDetails { kind: PromptKind; title?: string; fields?: { name: string; label: string; secret?: boolean; optional?: boolean; multiline?: boolean }[]; page?: string; done?: string; detail?: string; submit?: string; login?: boolean }
export interface PageCard { id: string; title: string; url: string }
export interface Step {
  name: string; purpose: string; status: StepStatus;
  error?: string; path?: string; message?: string; body?: string; options?: string[]; answer?: string; intents?: FollowIntent[];
  prompt?: PromptDetails; page?: PageCard; schedule?: { id: string; name: string }; skill?: string; from?: string;
  priorPublicApprovals?: { title: string; body: string; options: string[]; answer: string }[];
}
export const isPublicReadOrDownload = (step: Step) => step.name === "ox.web.fetch" || step.name === "ox.web.downloadText";
export interface LivePrompt extends PromptDetails { id: string; prompt: string; options: string[] }
export interface LiveTranscript {
  toolStops?: boolean;
  publicApprovalReceipts?: boolean;
  partial?: AssistantMessage;
  steps: ReadonlyMap<string, Step[]>;
  prompt?: LivePrompt;
}
export type TranscriptMessage = Exclude<Message, AssistantMessage> | (Omit<AssistantMessage, "usage"> & { usage?: AssistantMessage["usage"] });

export function assistantError(message?: TranscriptMessage) {
  if (message?.role !== "assistant") return undefined;
  if (message.stopReason === "error") return message.errorMessage || "The model request failed.";
  if (message.stopReason !== "length") return undefined;
  return message.content.some(part => part.type === "text" && part.text.trim())
    ? "The model reached its output limit. The partial answer may be incomplete; review it before continuing."
    : "The model reached its output limit before it wrote an answer. Ask again, or ask for a shorter answer.";
}

const referenceSeconds = 978_307_200;
const previewLimit = 4_000;
const hiddenKinds = new Set(["pi.reset", "pi.compaction"]);
const attachment = /^\[Attachment: (.+)\]$/;

const date = (milliseconds: number) => milliseconds / 1000 - referenceSeconds;
const promptFields = (prompt?: PromptDetails): Record<string, JsonValue> => {
  if (!prompt || prompt.kind === "choice") return { promptKind: "choice" };
  return { promptKind: prompt.kind, ...(prompt.title ? { title: prompt.title } : {}), ...(prompt.detail ? { detail: prompt.detail } : {}),
    ...(prompt.fields ? { fields: prompt.fields.map(field => ({ ...field })) } : {}), ...(prompt.page ? { page: prompt.page } : {}),
    ...(prompt.done ? { done: prompt.done } : {}), ...(prompt.submit ? { submit: prompt.submit } : {}), ...(prompt.login ? { login: true } : {}) };
};
export function stableID(seed: string) {
  const hash = new Bun.CryptoHasher("sha256").update(seed).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-${"89ab"[parseInt(hash[16]!, 16) % 4]}${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
const preview = (text: string) => text.length > previewLimit ? { text: text.slice(0, previewLimit), truncated: true } : { text, truncated: false };
const textOf = (content: UserMessage["content"] | ToolResultMessage["content"]) => typeof content === "string" ? content
  : content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n");
export const stepsOf = (details: unknown): Step[] => details && typeof details === "object" && Array.isArray((details as { steps?: unknown }).steps)
  ? (details as { steps: Step[] }).steps : [];
export const displayed = (entry: EntryRecord) => !hiddenKinds.has(entry.kind) && !!entry.model?.length;
export function userInput(message: UserMessage, entry?: EntryRecord) {
  const content = entry?.kind === "ox.user.reply" && Array.isArray(message.content) && message.content[0]?.type === "text"
    ? message.content[0].text : textOf(message.content);
  const lines = content.split("\n");
  return { text: lines.filter(line => !attachment.test(line.trim())).join("\n").trim(), files: lines.flatMap(line => attachment.exec(line.trim())?.[1] ?? []) };
}
export function visibleMessageParts(entry: EntryRecord, note?: { schedule?: string; skill?: { name: string; argument: string } }): { source: string; text: string; entry: number; role: "user" | "assistant" }[] {
  if (!displayed(entry)) return [];
  return entry.model!.flatMap<{ source: string; text: string; entry: number; role: "user" | "assistant" }>((message, index) => {
    if (message.role === "user") {
      const text = note ? note.skill?.argument ?? "" : userInput(message, entry).text;
      return text ? [{ source: `${entry.id}:${index}:0`, text, entry: entry.id as number, role: "user" as const }] : [];
    }
    const reply = evidenceReply(message);
    if (reply) return [{ source: `${entry.id}:${index}:0`, text: reply.text, entry: entry.id as number, role: "assistant" as const }];
    return message.role === "assistant" && !isEvidenceModelMessage(message) ? message.content.flatMap((part, at) => part.type === "text" && part.text
      ? [{ source: `${entry.id}:${index}:${at}`, text: part.text, entry: entry.id as number, role: "assistant" as const }] : []) : [];
  });
}

type Invocation = { id: string; name: string; purpose: string; args: JsonValue; outcome: JsonValue; preview?: JsonValue };
type Trace = { id: string; createdAt: number; sealedAt?: number; entries: JsonValue[]; invocations: Map<string, Invocation>; nested: Map<string, Invocation[]> };

class Blocks {
  readonly blocks: JsonValue[] = [];
  private trace?: Trace;
  private content?: { items: JsonValue[] };
  private live: LiveTranscript;
  private time = Date.now();

  constructor(live: LiveTranscript) { this.live = live; }

  private push(seed: string, kind: Record<string, JsonValue>) {
    this.blocks.push({ id: stableID(seed), createdAt: date(this.time), kind });
  }
  private closeTrace() {
    if (!this.trace) return;
    const running = [...this.trace.invocations.values(), ...[...this.trace.nested.values()].flat()]
      .some(invocation => !!invocation.outcome && typeof invocation.outcome === "object" && "running" in invocation.outcome);
    const entries = this.trace.entries;
    this.blocks.push({ id: this.trace.id, createdAt: date(this.trace.createdAt), kind: { type: "thinking",
      trace: { entries, ...(running ? {} : { completedAt: date(this.trace.sealedAt ?? this.time) }) } } });
    this.trace = undefined;
  }
  private closeContent() { this.content = undefined; }
  private openTrace(seed: string, at: number) {
    this.closeContent();
    this.trace ??= { id: stableID(`trace:${seed}`), createdAt: at, entries: [], invocations: new Map(), nested: new Map() };
    return this.trace;
  }
  private item(seed: string, item: JsonValue, failure = false) {
    this.closeTrace();
    if (!this.content || failure) {
      const items: JsonValue[] = [];
      this.push(`content:${seed}`, { type: "agentContent", items, ...(failure ? { failure: true } : {}) });
      this.content = failure ? undefined : { items };
      items.push(item);
      return;
    }
    this.content.items.push(item);
  }
  private nested(toolCallID: string, steps: Step[], trace: Trace) {
    const parent = trace.invocations.get(toolCallID);
    if (parent?.name.startsWith("ox_")) return;
    const invocations = steps.flatMap((step, index): Invocation[] => step.name.startsWith("ox.user.") ? [] : [{ id: stableID(`${toolCallID}:${index}`), name: step.name, purpose: step.purpose,
      args: step.path ? { path: step.path, ...(step.from ? { from: step.from } : {}) } : {},
      outcome: step.status === "running" ? { running: {} } : step.status === "error" ? { failed: { _0: step.error ?? "Failed" } }
        : { succeeded: { _0: step.schedule ? { id: step.schedule.id, name: step.schedule.name } : step.skill ? { skill: step.skill } : step.path ?? null } } }]);
    const previous = trace.nested.get(toolCallID) ?? [];
    for (const invocation of invocations) {
      const existing = previous.find(item => item.id === invocation.id);
      if (existing) Object.assign(existing, invocation);
      else { previous.push(invocation); trace.entries.push({ kind: "invocation", invocation }); }
    }
    trace.nested.set(toolCallID, previous);
  }
  private requests(toolCallID: string, steps: Step[], pending = false, aborted = false) {
    steps.forEach((step, index) => {
      if (step.name === "ox.user.progress" && step.message) this.item(`${toolCallID}:p${index}`, { progress: step.message });
      if (step.page) this.item(`${toolCallID}:g${index}`, { page: { ...step.page } });
      const publicWeb = this.live.publicApprovalReceipts && isPublicReadOrDownload(step);
      const prior = publicWeb && Array.isArray(step.priorPublicApprovals) ? step.priorPublicApprovals : [];
      const seed = `${toolCallID}:c${index}`;
      const decisionID = (ordinal: number) => ordinal ? `${seed}:${ordinal}` : seed;
      prior.forEach((decision, ordinal) => {
        this.closeTrace(); this.closeContent();
        this.push(decisionID(ordinal), { type: "confirm", promptKind: "approval", publicWebApproval: true,
          title: decision.title, prompt: decision.body, options: decision.options, answer: decision.answer });
      });
      if ((step.name === "ox.user.choose" || step.prompt) && step.body && (step.answer !== undefined || !pending)) {
        this.closeTrace(); this.closeContent();
        this.push(decisionID(prior.length), { type: "confirm", ...promptFields(step.prompt), prompt: step.body, options: step.options ?? [],
          ...(publicWeb && step.prompt?.kind === "approval" && step.answer !== undefined ? { publicWebApproval: true } : {}),
          ...(step.answer !== undefined ? { answer: step.answer } : { resolution: aborted && step.prompt?.kind === "approval" ? "Not recorded" : "Not answered" }) });
      }
      if (!pending && step.name === "ox.web.downloadText" && step.status === "ok" && step.path) {
        this.item(`${toolCallID}:download${index}`, { downloadedText: step.path });
      }
    });
  }
  user(message: UserMessage, seed: string, record: EntryRecord, note?: { schedule?: string; skill?: { name: string; argument: string } }, source?: string) {
    this.closeTrace(); this.closeContent();
    const { text, files } = userInput(message, record);
    const input = record.data && typeof record.data === "object" && !Array.isArray(record.data) ? record.data.openoxInput : undefined;
    const reply = input && typeof input === "object" && !Array.isArray(input) ? input.reply : undefined;
    this.push(`user:${seed}`, { type: "userText", text, attachments: [], files, entry: record.id, ...(reply ? { reply } : {}),
      ...(source ? { source: `${source}:0` } : {}), ...(note?.schedule !== undefined ? { schedule: note.schedule } : {}),
      ...(note?.skill ? { skill: { name: note.skill.name, argument: note.skill.argument } } : {}) });
  }
  assistant(message: AssistantMessage, seed: string, live = false, source?: string, hideText = false) {
    const start = message.timestamp || this.time;
    const sealedAt = message.durationMs !== undefined ? start + message.durationMs : live ? undefined : start;
    message.content.forEach((part, index) => {
      if (part.type === "thinking" && part.thinking.trim()) {
        const trace = this.openTrace(seed, start);
        trace.entries.push({ kind: "reasoning", reasoning: { id: stableID(`${seed}:r${index}`), text: part.thinking, ref: `${seed}:${index}` } });
        trace.sealedAt = sealedAt;
      } else if (part.type === "text" && part.text && !hideText && !isEvidenceModelMessage(message)) {
        this.item(`${seed}:t${index}`, { text: part.text, ref: `${seed}:${index}`, ...(source ? { source: `${source}:${index}` } : {}) });
      } else if (part.type === "toolCall") {
        const trace = this.openTrace(seed, start);
        const args = part.arguments as Record<string, unknown>;
        const source = preview(typeof args.source === "string" ? args.source : JSON.stringify(args));
        const invocation: Invocation = { id: stableID(part.id), name: part.name, purpose: typeof args.purpose === "string" ? args.purpose : "",
          args: { source: source.text }, outcome: { running: {} },
          ...(source.truncated ? { preview: { argumentsTruncated: true, resultTruncated: false, purposeTruncated: false } } : {}) };
        trace.invocations.set(part.id, invocation);
        trace.entries.push({ kind: "invocation", invocation });
        trace.sealedAt = sealedAt;
        const steps = this.live.steps.get(part.id);
        if (steps) { this.nested(part.id, steps, trace); }
      }
    });
    if (message.stopReason === "error") this.item(`${seed}:error`, { text: message.errorMessage || "The model request failed." }, true);
    if (message.stopReason === "aborted") this.item(`${seed}:aborted`, { text: "Stopped." }, true);
  }
  result(message: ToolResultMessage, source?: string, aborted = false) {
    const trace = this.trace;
    const invocation = trace?.invocations.get(message.toolCallId);
    const steps = stepsOf(message.details).map((step): Step => step.status === "running" ? { ...step, status: "error",
      error: "The execution ended before this operation's outcome was recorded. Verify state before retrying." } : step);
    if (trace && invocation) {
      const output = preview(textOf(message.content));
      invocation.outcome = message.isError ? { failed: { _0: output.text } } : { succeeded: { _0: output.text } };
      if (output.truncated) invocation.preview = { argumentsTruncated: false, resultTruncated: true, purposeTruncated: false };
      this.nested(message.toolCallId, steps, trace);
    }
    this.requests(message.toolCallId, steps, false, aborted);
    if (aborted) {
      this.closeTrace(); this.closeContent();
      this.push(`${message.toolCallId}:stopped`, { type: "toolStopped" });
    }
    const reply = evidenceReply(message);
    if (reply) this.item(`evidence:${message.toolCallId}`, { text: reply.text, ...(source ? { source: `${source}:0` } : {}) });
  }
  liveSteps() {
    for (const [toolCallID, steps] of this.live.steps) this.requests(toolCallID, steps, true);
    if (this.live.prompt) {
      this.closeTrace(); this.closeContent();
      this.push(`prompt:${this.live.prompt.id}`, { type: "confirm", ...promptFields(this.live.prompt), prompt: this.live.prompt.prompt,
        options: this.live.prompt.options, promptId: this.live.prompt.id });
    }
  }
  at(milliseconds: number | undefined) { if (milliseconds) this.time = milliseconds; }
  finish() { this.closeTrace(); return this.blocks; }
}

export const assistantSeed = (message: AssistantMessage) => `a:${message.timestamp}`;

export function transcript(entries: readonly EntryRecord[], live: LiveTranscript, marks: ReadonlyMap<number, { schedule?: string; skill?: { name: string; argument: string } }> = new Map(), sources = false) {
  const builder = new Blocks(live);
  const messages: TranscriptMessage[] = [];
  const seeds = new Set<string>();
  let publicMode = false;
  const unique = (seed: string) => { let value = seed; for (let copy = 1; seeds.has(value); copy++) value = `${seed}#${copy}`; seeds.add(value); return value; };
  for (const entry of entries) {
    if (!displayed(entry)) continue;
    entry.model!.forEach((message, index) => {
      builder.at(message.timestamp);
      const source = sources ? `${entry.id}:${index}` : undefined;
      if (message.role === "user") { publicMode = false; builder.user(message, `${entry.id}:${index}`, entry, marks.get(entry.id as number), source); }
      else if (message.role === "assistant") builder.assistant(message, unique(assistantSeed(message)), false, source, publicMode);
      else if (message.role === "toolResult") {
        const route = evidenceRoute(message);
        if (route) publicMode = route.kind === "public";
        builder.result(message, source, !!live.toolStops && ToolResultEntry.is(entry) && entry.data.diagnostics.some(d => d.code === "aborted"));
      }
      if (message.role === "assistant" && entry.kind === "ox.import") {
        const { usage: _unavailable, ...imported } = message;
        messages.push(imported);
      } else if (message.role !== "system") messages.push(message);
    });
  }
  if (live.partial && !seeds.has(assistantSeed(live.partial))) { builder.at(Date.now()); builder.assistant(live.partial, unique(assistantSeed(live.partial)), true, undefined, publicMode); }
  builder.liveSteps();
  return { blocks: builder.finish(), messages };
}

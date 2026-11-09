import { createHash } from "node:crypto";
import { basename } from "node:path";
import { userInput, type AssistantMessage, type Message, type ToolResultMessage } from "@openox/agent/linux";
import type { Host } from "./host";
import { HTTPError } from "./http";
import { zipDecode, zipEncode, type ZipFailure } from "./vm/skills-package";

const referenceSeconds = 978_307_200;
export const conversationPackageLimits = { archive: 128 * 1_048_576, entry: 32 * 1_048_576, entries: 256 };
export const conversationPackageType = "application/vnd.ox.conversation+zip";
const zipMessages: Record<ZipFailure, string> = {
  tooLarge: "This conversation package is too large.",
  invalidArchive: "This isn't a valid conversation package.",
  encrypted: "Encrypted conversation packages aren't supported.",
  unsupportedCompression: "This conversation package uses unsupported compression.",
  unsafePath: "This conversation package contains an unsafe path.",
  checksumMismatch: "This conversation package appears to be damaged.",
};
const invalid = () => new HTTPError(400, zipMessages.invalidArchive);
const damaged = () => new HTTPError(400, zipMessages.checksumMismatch);
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const uuid = () => crypto.randomUUID().toUpperCase();
const seconds = (milliseconds: number) => milliseconds / 1000 - referenceSeconds;
const milliseconds = (value: number) => Math.round((value + referenceSeconds) * 1000);
const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
const clip = (text: string, length: number) => Array.from(text.toWellFormed()).slice(0, length).join("");
const attachmentLine = /^\s*\[Attachment: .+\]\s*$/;
export const packageTitle = (title: string) => clip(title, 200).trim() || "Conversation";

type Outcome = { type: "completed"; at: number } | { type: "failed"; at: number; message: string } | { type: "cancelled"; at: number };
type Execute = { source: string; effects: never[]; outcome: { type: "running" } | { type: "succeeded" | "failed"; output: string } };
type Step = { id: string; generation: string } & ({ type: "reasoning"; reasoning: string } | { type: "text"; text: string } | { type: "action"; action: { type: "execute"; execute: Execute } });
type Generation = { id: string; at: number; model: string; outcome: Outcome };
type AgentTurn = { at: number; generations: Generation[]; steps: Step[]; outcome: Outcome };
type Turn = { id: string; type: "user"; user: { intent: string; attachments: string[]; at: number; scheduleName?: string } } | { id: string; type: "agent"; agent: AgentTurn };
type Header = {
  packageVersion: number; transcriptSchemaVersion: number; title: string; createdAt: number; lastActivity?: number; exportedAt: number; turnCount: number;
  artifactCount: number; hasContext: boolean; hasCompactedContext: boolean; serviceDomains: string[]; files: { path: string; bytes: number; sha256: string }[];
};
export interface ConversationPackage { header: Header; turns: Turn[]; artifacts: Map<string, Uint8Array> }

const sorted = (value: unknown): unknown => Array.isArray(value) ? value.map(sorted)
  : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted((value as Record<string, unknown>)[key])])) : value;
const textOf = (content: ToolResultMessage["content"] | AssistantMessage["content"]) => content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n");

export function validFilename(name: string) {
  return !!name && name !== "." && name !== ".." && !name.startsWith(".") && name.normalize("NFC") === name && !/[/:\\\u0000-\u001f\u007f]/.test(name) && name.length <= 255;
}

function filename(path: string, taken: Set<string>) {
  const cleaned = clip(basename(path).normalize("NFC").replace(/[/:\\\u0000-\u001f\u007f]/g, "-").replace(/^\.+/, "").trim(), 200) || "file";
  const dot = cleaned.lastIndexOf(".");
  const stem = dot > 0 ? cleaned.slice(0, dot) : cleaned, extension = dot > 0 ? cleaned.slice(dot) : "";
  let name = cleaned;
  for (let copy = 2; taken.has(name.toLowerCase()); copy++) name = `${stem} (${copy})${extension}`;
  taken.add(name.toLowerCase());
  return name;
}

function outcomeOf(message: AssistantMessage): Outcome {
  const at = seconds(message.timestamp + (message.durationMs ?? 0));
  if (message.stopReason === "error") return { type: "failed", at, message: message.errorMessage || "The model request failed." };
  if (message.stopReason === "aborted") return { type: "cancelled", at };
  return { type: "completed", at };
}

export async function exportConversation(host: Host, id: number) {
  const { summary, messages, scheduled } = await host.profile.exportSource(id);
  const artifacts = new Map<string, { name: string; data: Uint8Array }>();
  const taken = new Set<string>();
  const tooLarge = () => new HTTPError(400, zipMessages.tooLarge);
  let total = 0;
  const artifact = async (path: string) => {
    const known = artifacts.get(path);
    if (known) return known.name;
    if (!/^conversations\/\d+\//.test(path)) return undefined;
    const opened = await host.profile.openFile(path).catch(() => undefined);
    if (!opened) return undefined;
    total += opened.entry.size;
    if (opened.entry.size > conversationPackageLimits.entry || total > conversationPackageLimits.archive || artifacts.size + 2 >= conversationPackageLimits.entries) throw tooLarge();
    const data = new Uint8Array(await opened.file.arrayBuffer());
    const name = filename(path, taken);
    artifacts.set(path, { name, data });
    return name;
  };
  const turns: Turn[] = [];
  const pending = new Map<string, Execute>();
  let agent: AgentTurn | undefined;
  for (const message of messages) {
    if (message.role === "user") {
      agent = undefined;
      const input = userInput(message);
      const attachments: string[] = [];
      for (const path of input.files) { const name = await artifact(path); if (name) attachments.push(name); }
      const scheduleName = scheduled.get(message);
      turns.push({ id: uuid(), type: "user", user: { intent: input.text, attachments, at: seconds(message.timestamp), ...(scheduleName !== undefined ? { scheduleName } : {}) } });
    } else if (message.role === "assistant") {
      const generation: Generation = { id: uuid(), at: seconds(message.timestamp), model: message.model || "unknown", outcome: outcomeOf(message) };
      if (!agent) { agent = { at: generation.at, generations: [], steps: [], outcome: generation.outcome }; turns.push({ id: uuid(), type: "agent", agent }); }
      agent.generations.push(generation);
      agent.outcome = generation.outcome;
      for (const part of message.content) {
        if (part.type === "thinking" && part.thinking.trim()) agent.steps.push({ id: uuid(), generation: generation.id, type: "reasoning", reasoning: part.thinking });
        else if (part.type === "text" && part.text) agent.steps.push({ id: uuid(), generation: generation.id, type: "text", text: part.text });
        else if (part.type === "toolCall") {
          const args = part.arguments as Record<string, unknown>;
          const execute: Execute = { source: typeof args.source === "string" ? args.source : JSON.stringify(args), effects: [], outcome: { type: "running" } };
          pending.set(part.id, execute);
          agent.steps.push({ id: uuid(), generation: generation.id, type: "action", action: { type: "execute", execute } });
        }
      }
    } else if (message.role === "toolResult") {
      const execute = pending.get(message.toolCallId);
      if (execute) execute.outcome = { type: message.isError ? "failed" : "succeeded", output: textOf(message.content) };
    }
  }
  for (const execute of pending.values()) if (execute.outcome.type === "running") execute.outcome = { type: "failed", output: "No result was recorded." };
  if (!turns.length) throw new HTTPError(400, "This conversation has no messages to export");
  const services = [...new Set((await host.attachedServices(id)).map(service => service.domain))].sort();
  const transcript = encoder.encode(turns.map(turn => JSON.stringify(turn)).join("\n") + "\n");
  if (transcript.length > conversationPackageLimits.entry || total + transcript.length > conversationPackageLimits.archive) throw tooLarge();
  const files = [{ path: "turns.jsonl", data: transcript },
    ...[...artifacts.values()].sort((a, b) => a.name.localeCompare(b.name)).map(file => ({ path: `artifacts/${file.name}`, data: file.data }))];
  const header: Header = { packageVersion: 1, transcriptSchemaVersion: 1, title: packageTitle(summary.title), createdAt: seconds(summary.createdAt),
    ...(summary.lastActivity === null ? {} : { lastActivity: seconds(summary.lastActivity) }), exportedAt: seconds(Date.now()), turnCount: turns.length,
    artifactCount: artifacts.size, hasContext: false, hasCompactedContext: false, serviceDomains: services,
    files: files.map(file => ({ path: file.path, bytes: file.data.length, sha256: sha256(file.data) })) };
  const archive = zipEncode([{ path: "conversation.json", data: encoder.encode(`${JSON.stringify(sorted(header), null, 2)}\n`) }, ...files],
    conversationPackageLimits.archive, key => new HTTPError(400, zipMessages[key]));
  return { title: header.title, archive };
}

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const number = (value: unknown) => typeof value === "number" && Number.isFinite(value);
const string = (value: unknown) => typeof value === "string";

function json(data: Uint8Array) {
  try { return JSON.parse(decoder.decode(data)) as unknown; } catch { throw invalid(); }
}

function outcome(value: unknown): Outcome {
  if (!isObject(value)) throw invalid();
  if (value.type === "completed" && number(value.at)) return { type: "completed", at: value.at as number };
  if (value.type === "failed" && number(value.at) && string(value.message)) return { type: "failed", at: value.at as number, message: value.message as string };
  if (value.type === "cancelled" && number(value.at)) return { type: "cancelled", at: value.at as number };
  if (value.type === "running") return { type: "cancelled", at: 0 };
  throw invalid();
}

function step(value: unknown): Step | undefined {
  if (!isObject(value) || !string(value.id) || !string(value.generation) || !string(value.type)) throw invalid();
  const base = { id: value.id as string, generation: value.generation as string };
  if (value.type === "reasoning" && string(value.reasoning)) return { ...base, type: "reasoning", reasoning: value.reasoning as string };
  if (value.type === "text" && string(value.text)) return { ...base, type: "text", text: value.text as string };
  if (value.type === "action" && isObject(value.action)) {
    const action = value.action;
    if (action.type !== "execute") return undefined;
    const execute = action.execute;
    if (!isObject(execute) || !string(execute.source) || !isObject(execute.outcome)) throw invalid();
    const result = execute.outcome;
    return { ...base, type: "action", action: { type: "execute", execute: { source: execute.source as string, effects: [],
      outcome: (result.type === "succeeded" || result.type === "failed") && string(result.output) ? { type: result.type, output: result.output as string } : { type: "failed", output: "" } } } };
  }
  if (["reasoning", "text", "action", "contextCompaction", "wire"].includes(value.type as string)) return undefined;
  throw invalid();
}

function turn(value: unknown): Turn {
  if (!isObject(value) || !string(value.id)) throw invalid();
  if (value.type === "user" && isObject(value.user)) {
    const user = value.user;
    if (!string(user.intent) || !number(user.at) || !Array.isArray(user.attachments) || !user.attachments.every(string)
      || (user.scheduleName !== undefined && (typeof user.scheduleName !== "string" || user.scheduleName.length > 500))) throw invalid();
    return { id: value.id as string, type: "user", user: { intent: user.intent as string, attachments: user.attachments as string[], at: user.at as number,
      ...(typeof user.scheduleName === "string" ? { scheduleName: user.scheduleName } : {}) } };
  }
  if (value.type === "agent" && isObject(value.agent)) {
    const agent = value.agent;
    if (!number(agent.at) || !Array.isArray(agent.generations) || !Array.isArray(agent.steps)) throw invalid();
    const generations = agent.generations.map(entry => {
      if (!isObject(entry) || !string(entry.id) || !number(entry.at) || !string(entry.model)) throw invalid();
      return { id: entry.id as string, at: entry.at as number, model: entry.model as string, outcome: outcome(entry.outcome) };
    });
    const steps = agent.steps.flatMap(entry => step(entry) ?? []);
    if (new Set(generations.map(entry => entry.id)).size !== generations.length || new Set(steps.map(entry => entry.id)).size !== steps.length) throw invalid();
    return { id: value.id as string, type: "agent", agent: { at: agent.at as number, generations, steps, outcome: outcome(agent.outcome) } };
  }
  throw invalid();
}

export function readConversationPackage(data: Uint8Array): ConversationPackage {
  const entries = zipDecode(data, conversationPackageLimits.archive, conversationPackageLimits.entry, conversationPackageLimits.entries, key => new HTTPError(400, zipMessages[key]),
    conversationPackageLimits.archive);
  const files = new Map(entries.map(entry => [entry.path, entry.data]));
  const headerPath = files.has("conversation.json") ? "conversation.json" : files.has("chat.json") ? "chat.json" : undefined;
  if (!headerPath) throw invalid();
  const raw = json(files.get(headerPath)!);
  if (!isObject(raw)) throw invalid();
  if (raw.packageVersion !== 1 || raw.transcriptSchemaVersion !== 1) throw new HTTPError(400, "This conversation package was made by a different version of Ox.");
  if (!string(raw.title) || !(raw.title as string).trim() || !Number.isSafeInteger(raw.turnCount) || (raw.turnCount as number) < 1 || !Number.isSafeInteger(raw.artifactCount)
    || (raw.artifactCount as number) < 0 || !Array.isArray(raw.files) || !Array.isArray(raw.serviceDomains) || !raw.serviceDomains.every(string)
    || typeof raw.hasCompactedContext !== "boolean" || !number(raw.createdAt)) throw invalid();
  const declared = raw.files.map(record => {
    if (!isObject(record) || !string(record.path) || !Number.isSafeInteger(record.bytes) || !string(record.sha256)) throw invalid();
    return { path: record.path as string, bytes: record.bytes as number, sha256: (record.sha256 as string).toLowerCase() };
  });
  const payload = entries.filter(entry => entry.path !== headerPath).map(entry => entry.path);
  if (payload.length !== declared.length || new Set(declared.map(record => record.path)).size !== declared.length
    || payload.some(path => !declared.some(record => record.path === path))) throw invalid();
  const artifacts = new Map<string, Uint8Array>();
  for (const record of declared) {
    const content = files.get(record.path)!;
    if (content.length !== record.bytes || sha256(content) !== record.sha256) throw damaged();
    if (record.path === "turns.jsonl" || record.path === "context.json") continue;
    const name = record.path.startsWith("artifacts/") ? record.path.slice("artifacts/".length) : "";
    if (!validFilename(name) || [...artifacts.keys()].some(known => known.toLowerCase() === name.toLowerCase())) throw invalid();
    artifacts.set(name, content);
  }
  const lines = files.get("turns.jsonl");
  if (!lines) throw invalid();
  let text: string;
  try { text = decoder.decode(lines); } catch { throw invalid(); }
  const turns = text.split("\n").filter(line => line.trim()).map(line => {
    try { return turn(JSON.parse(line)); } catch (error) { throw error instanceof HTTPError ? error : invalid(); }
  });
  if (!turns.length || turns.length !== raw.turnCount || artifacts.size !== raw.artifactCount) throw invalid();
  for (const entry of turns) if (entry.type === "user" && entry.user.attachments.some(name => !artifacts.has(name))) throw invalid();
  return { header: raw as unknown as Header, turns, artifacts };
}

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

export function packageMessages(turns: Turn[], folder: string): { model: Message[]; schedule?: string }[] {
  const groups: { model: Message[]; schedule?: string }[] = [];
  for (const entry of turns) {
    if (entry.type === "user") {
      const files = entry.user.attachments.map(name => `${folder}/${name}`);
      const intent = entry.user.intent.split("\n").filter(line => !attachmentLine.test(line)).join("\n").trim() || (files.length ? "Please review the attached files." : "");
      if (!intent) continue;
      groups.push({ model: [{ role: "user", content: files.length ? `${intent}\n\n${files.map(path => `[Attachment: ${path}]`).join("\n")}` : intent, timestamp: milliseconds(entry.user.at) }],
        ...(entry.user.scheduleName !== undefined ? { schedule: entry.user.scheduleName } : {}) });
      continue;
    }
    const group: Message[] = [];
    const byGeneration = new Map<string, Step[]>();
    for (const item of entry.agent.steps) {
      const list = byGeneration.get(item.generation);
      if (list) list.push(item); else byGeneration.set(item.generation, [item]);
    }
    for (const generation of entry.agent.generations) {
      const content: AssistantMessage["content"] = [];
      const results: ToolResultMessage[] = [];
      const at = milliseconds(generation.at);
      for (const part of byGeneration.get(generation.id) ?? []) {
        if (part.type === "reasoning") content.push({ type: "thinking", thinking: part.reasoning });
        else if (part.type === "text") content.push({ type: "text", text: part.text });
        else {
          const outcome = part.action.execute.outcome;
          content.push({ type: "toolCall", id: part.id, name: "execute", arguments: { purpose: "", source: part.action.execute.source } });
          results.push({ role: "toolResult", toolCallId: part.id, toolName: "execute", content: [{ type: "text", text: "output" in outcome ? outcome.output : "" }],
            isError: outcome.type !== "succeeded", timestamp: at });
        }
      }
      const failed = generation.outcome.type === "failed", cancelled = generation.outcome.type === "cancelled";
      if (!content.length && !failed && !cancelled) continue;
      const duration = milliseconds(generation.outcome.at) - at;
      group.push({ role: "assistant", content, api: "openai-completions", provider: "imported", model: generation.model, usage,
        stopReason: failed ? "error" : cancelled ? "aborted" : results.length ? "toolUse" : "stop",
        ...(generation.outcome.type === "failed" ? { errorMessage: generation.outcome.message } : {}), timestamp: at, ...(duration >= 0 ? { durationMs: duration } : {}) }, ...results);
    }
    if (group.length) groups.push({ model: group });
  }
  return groups;
}

const staged = new Map<string, { package: ConversationPackage; expires: number }>();

export function stageConversationPackage(value: ConversationPackage) {
  const now = Date.now();
  for (const [token, entry] of staged) if (entry.expires < now) staged.delete(token);
  while (staged.size >= 2) staged.delete(staged.keys().next().value!);
  const token = crypto.randomUUID();
  staged.set(token, { package: value, expires: now + 10 * 60_000 });
  setTimeout(() => staged.delete(token), 10 * 60_000).unref?.();
  const bytes = [...value.artifacts.values()].reduce((total, data) => total + data.length, 0);
  return { token, title: value.header.title, messages: value.header.turnCount, artifacts: value.artifacts.size, bytes, services: value.header.serviceDomains,
    compacted: value.header.hasCompactedContext };
}

export function takeConversationPackage(token: string) {
  const entry = staged.get(token);
  staged.delete(token);
  if (!entry || entry.expires < Date.now()) throw new HTTPError(404, "This import has expired. Choose the file again.");
  return entry.package;
}

export function discardConversationPackage(token: string) { staged.delete(token); }

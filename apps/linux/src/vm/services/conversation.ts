import { findAction, resolvedBaseURL, sessionsEnabled, type Snapshot } from "./catalog";
import { canonicalJSON, fail, isObject, same, sha256, type JSONObject } from "./support";
import { executionURL, normalizedURL, type Approve, type ServicePage, type StagedFile, type WebRuntime } from "./web";

const maximumSubmissions = 32, maximumResponseBytes = 2_000_000, maximumRetainedBytes = 8_000_000;
interface Submission { nativeID: string; digests: string[]; text: string; terminal: boolean }
interface Conversation {
  id: string; owner: number; domain: string; version: string; page: ServicePage; marker: string; selectedSession: unknown; initialPageURL: string;
  continuation: boolean; lastUsed: number; activeSince: number; busy: boolean; closed: boolean; conversationRef?: string;
  submissions: Map<string, Submission>; latestSubmission?: string; modelID?: unknown; accountID?: unknown; options?: unknown;
}
export interface ConversationInvocation {
  snapshot: Snapshot; owner: number; args: JSONObject; session?: unknown; pageURL?: string | null; approve: Approve; signal?: AbortSignal; attachments: StagedFile[];
}

const websiteError = (message: string) => fail("operation_failed", message, "Inspect the website conversation state before retrying; never resubmit automatically.");

export class WebConversations {
  private web: WebRuntime;
  private items = new Map<string, Conversation>();
  private opening = 0;

  constructor(web: WebRuntime) { this.web = web; }

  private expired(conversation: Conversation, now = Date.now()) {
    return conversation.busy ? now - conversation.activeSince > 3_600_000 : now - conversation.lastUsed > 600_000;
  }

  private async current(conversation: Conversation) {
    if (conversation.closed || this.expired(conversation) || conversation.page.live.page.isClosed()) return false;
    return conversation.page.live.page.evaluate(marker => (window as unknown as { __oxConversation?: string }).__oxConversation === marker, conversation.marker).catch(() => false);
  }

  private async check(conversation: Conversation) {
    if (await this.current(conversation)) return;
    await this.close(conversation);
    throw websiteError("Website conversation interrupted or expired; the request was not resubmitted");
  }

  async close(conversation: Conversation) {
    if (conversation.closed) return;
    conversation.closed = true;
    this.items.delete(conversation.id);
    conversation.submissions.clear();
    await this.web.closePage(conversation.page);
  }

  async closeWhere(match: (conversation: Conversation) => boolean) {
    for (const conversation of [...this.items.values()].filter(match)) await this.close(conversation);
  }

  private async prune() {
    for (const conversation of [...this.items.values()]) if (!(await this.current(conversation))) await this.close(conversation);
  }

  private async open(o: ConversationInvocation) {
    await this.prune();
    if (this.items.size + this.opening >= 12) throw websiteError("Too many website conversations are open or opening");
    this.opening++;
    try {
      const definition = o.snapshot.definition;
      const action = findAction(definition, "conversation");
      if (!action) throw websiteError("The website conversation service is unavailable");
      const selected = await this.web.selectSession({ snapshot: o.snapshot, actionId: "conversation", args: o.args, session: o.session, pageURL: o.pageURL ?? null,
        approve: o.approve, ...(o.signal ? { signal: o.signal } : {}) }, action);
      const target = executionURL(definition, normalizedURL(resolvedBaseURL(definition, action, {})!), selected, o.pageURL);
      const id = crypto.randomUUID().toUpperCase();
      const page = await this.web.open(o.snapshot, `service:${definition.domain}:conversation:${id}`, o.owner);
      const marker = crypto.randomUUID();
      try {
        await this.web.run(page, { exclusive: true, destination: target, ...(o.signal ? { signal: o.signal } : {}) }, async page => {
          await page.live.page.evaluate(value => { (window as unknown as { __oxConversation?: string }).__oxConversation = value; }, marker);
        });
      } catch (error) {
        await this.web.closePage(page);
        throw error;
      }
      const conversation: Conversation = { id, owner: o.owner, domain: definition.domain, version: o.snapshot.version, page, marker, selectedSession: selected ?? null,
        initialPageURL: target, continuation: false, lastUsed: Date.now(), activeSince: Date.now(), busy: false, closed: false, submissions: new Map() };
      this.items.set(id, conversation);
      return conversation;
    } finally { this.opening--; }
  }

  private async invokePage(conversation: Conversation, o: ConversationInvocation, args: JSONObject) {
    await this.check(conversation);
    conversation.lastUsed = Date.now();
    const value = await this.web.invoke({ snapshot: o.snapshot, actionId: "conversation", args, session: conversation.selectedSession ?? undefined,
      pageURL: sessionsEnabled(o.snapshot.definition) ? conversation.initialPageURL : null, approve: o.approve, owned: conversation.page, ...(o.signal ? { signal: o.signal } : {}) });
    await this.check(conversation);
    return value;
  }

  async invoke(o: ConversationInvocation) {
    await this.prune();
    const isNew = o.args.operation === "submit" && o.args.conversationRef === null;
    let conversation: Conversation;
    if (isNew) conversation = await this.open(o);
    else {
      const reference = o.args.conversationRef, submission = o.args.submissionId;
      const found = [...this.items.values()].find(entry => entry.owner === o.owner && entry.domain === o.snapshot.domain
        && (reference === entry.id || (typeof submission === "string" && entry.submissions.has(submission))));
      if (!found) throw websiteError("Website conversation reference expired or belongs to another caller");
      if ((o.session != null && !same(o.session, found.selectedSession)) || (o.pageURL != null && o.pageURL !== found.initialPageURL)) {
        throw fail("invalid_argument", "Website conversation routing cannot switch accounts or targets; start a new conversation", "Start a new website conversation for another account or target.");
      }
      conversation = found;
    }
    try {
      await this.check(conversation);
      if (o.args.operation === "submit") return await this.submit(conversation, o);
      if (o.args.operation === "read") return await this.read(conversation, o);
      if (o.args.operation === "cancel") return await this.cancel(conversation, o);
      throw websiteError("Unknown website conversation operation");
    } catch (error) {
      if (isNew) await this.close(conversation);
      throw error;
    }
  }

  private async submit(conversation: Conversation, o: ConversationInvocation) {
    const fields = { ...o.args };
    if (conversation.busy || conversation.submissions.size >= maximumSubmissions) throw websiteError("Website conversation is busy or its submission limit was reached");
    const messages = Array.isArray(fields.messages) ? fields.messages as JSONObject[] : [];
    const last = messages.at(-1);
    if (!last || !["user", "tool"].includes(String(last.role)) || typeof last.text !== "string" || !last.text.trim()) {
      throw fail("invalid_argument", "Website submission requires a final nonempty user or tool message", "End the messages with a nonempty user or tool message.");
    }
    if (typeof fields.conversationRef === "string") {
      const latest = conversation.latestSubmission ? conversation.submissions.get(conversation.latestSubmission) : undefined;
      if (fields.conversationRef !== conversation.id || !conversation.continuation || !conversation.conversationRef || !latest?.terminal
        || !same(fields.modelId, conversation.modelID) || !same(fields.accountId, conversation.accountID) || !same(fields.options, conversation.options)
        || !messages.every(message => ["user", "tool"].includes(String(message.role)))) {
        throw websiteError("Unknown, unsupported, or stale website conversation reference");
      }
      fields.conversationRef = conversation.conversationRef;
    } else if (conversation.submissions.size) throw websiteError("This page already owns a conversation");
    const references = Array.isArray(fields.attachments) ? fields.attachments as JSONObject[] : [];
    if (references.length !== o.attachments.length || references.some((reference, index) => reference.id !== index
      || reference.name !== o.attachments[index]!.name || reference.mimeType !== o.attachments[index]!.mimeType)) {
      throw fail("invalid_argument", "Website attachments do not match the staged files", "Pass the attachments array unchanged.");
    }
    conversation.busy = true;
    conversation.activeSince = Date.now();
    try {
      if (o.attachments.length && conversation.selectedSession) {
        const sessions = await this.web.invoke({ snapshot: o.snapshot, actionId: "listSessions", args: {}, session: conversation.selectedSession,
          pageURL: sessionsEnabled(o.snapshot.definition) ? conversation.initialPageURL : null, approve: o.approve, owned: conversation.page });
        if (!Array.isArray(sessions) || !sessions.some(session => same(session, conversation.selectedSession))) {
          throw fail("authentication_required", "The selected website session is no longer available. No files were staged.", "Inspect available sessions or request login. Do not switch accounts or automatically replay a submission.");
        }
      }
      await this.web.stage(conversation.page, o.attachments);
      const value = await this.invokePage(conversation, o, fields);
      if (!isObject(value) || value.operation !== "submit" || typeof value.submissionId !== "string" || typeof value.conversationRef !== "string" || typeof value.continuation !== "boolean") {
        throw websiteError("Invalid website submission receipt; submission may have occurred");
      }
      if (conversation.conversationRef && conversation.conversationRef !== value.conversationRef) throw websiteError("Website continuation changed conversation identity; submission may have occurred");
      if ([...conversation.submissions.values()].some(entry => entry.nativeID === value.submissionId)) throw websiteError("Website reused a submission identity; submission may have occurred");
      const handle = crypto.randomUUID().toUpperCase();
      conversation.submissions.set(handle, { nativeID: value.submissionId, digests: [], text: "", terminal: false });
      conversation.latestSubmission = handle;
      conversation.conversationRef = value.conversationRef;
      conversation.modelID = fields.modelId;
      conversation.accountID = fields.accountId;
      conversation.options = fields.options;
      conversation.continuation = value.continuation;
      return { ...value, submissionId: handle, conversationRef: conversation.id };
    } catch (error) {
      await this.close(conversation);
      throw error;
    }
  }

  private arguments(conversation: Conversation, args: JSONObject) {
    const handle = args.submissionId;
    const submission = typeof handle === "string" ? conversation.submissions.get(handle) : undefined;
    if (!submission) throw websiteError("Unknown website submission");
    const fields: JSONObject = { ...args, submissionId: submission.nativeID };
    return { handle: handle as string, submission, fields };
  }

  private async read(conversation: Conversation, o: ConversationInvocation) {
    const { handle, fields } = this.arguments(conversation, o.args);
    const after = Number(fields.after);
    if (!Number.isInteger(after) || after > (conversation.submissions.get(handle)?.digests.length ?? 0)) throw websiteError("Website read cursor skips unobserved events");
    try {
      const value = await this.invokePage(conversation, o, fields);
      const submission = conversation.submissions.get(handle);
      const events = isObject(value) && Array.isArray(value.events) ? value.events as JSONObject[] : undefined;
      if (!isObject(value) || value.operation !== "read" || value.conversationRef !== conversation.conversationRef || !events || value.nextCursor !== after + events.length
        || events.length > 1_000 || !submission || after > submission.digests.length || after + events.length > 4_096) {
        throw websiteError("Invalid website event cursor or conversation identity");
      }
      const next = { ...submission, digests: [...submission.digests] };
      events.forEach((event, index) => {
        const digest = sha256(canonicalJSON(event)), cursor = after + index;
        if (cursor < next.digests.length) {
          if (digest !== next.digests[cursor]) throw websiteError("Website revised a previously read event");
          return;
        }
        if (next.terminal) throw websiteError("Website emitted events after completion");
        if (event.type === "text") {
          if (typeof event.text !== "string" || !event.text.startsWith(next.text) || new TextEncoder().encode(event.text).length > maximumResponseBytes) {
            throw websiteError("Website revised published text or exceeded the response limit");
          }
          next.text = event.text;
        } else if (event.type === "completed" || event.type === "failed") next.terminal = true;
        else throw websiteError("Unknown website event");
        next.digests.push(digest);
      });
      const retained = [...conversation.submissions].filter(([key]) => key !== handle).reduce((sum, [, entry]) => sum + entry.text.length, 0);
      if (retained + next.text.length > maximumRetainedBytes) throw websiteError("Website response history exceeded the retained size limit");
      conversation.submissions.set(handle, next);
      if (next.terminal && handle === conversation.latestSubmission) {
        conversation.busy = false;
        if (events.at(-1)?.type === "failed") conversation.continuation = false;
      }
      return { ...value, conversationRef: conversation.id };
    } catch (error) {
      await this.close(conversation);
      throw error;
    }
  }

  private async cancel(conversation: Conversation, o: ConversationInvocation) {
    const { handle, fields } = this.arguments(conversation, o.args);
    const value = await this.invokePage(conversation, o, fields);
    if (!isObject(value) || value.operation !== "cancel") throw websiteError("Invalid website cancellation receipt");
    if (value.status === "cancelled" && handle === conversation.latestSubmission) {
      conversation.busy = false;
      conversation.continuation = false;
    }
    return value;
  }
}

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc, type Harness } from "@earendil-works/pi-durable";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { OxError } from "./functions";
import { noticeConversationID } from "./notice-target";
import type { Todo } from "./todo-contracts";

const instant = Type.String({ format: "date-time" });
const localized = Type.Object({ en: Type.String({ maxLength: 600 }), "zh-Hans": Type.String({ maxLength: 600 }) }, { additionalProperties: false });
const deliveryResultSchema = Type.Object({
  status: Type.Union([Type.Literal("accepted"), Type.Literal("failed"), Type.Literal("unknown"), Type.Literal("skipped")]),
  httpStatus: Type.Optional(Type.Integer({ minimum: 100, maximum: 599 })),
}, { additionalProperties: false });
const noticeSchema = Type.Object({
  id: Type.String({ format: "uuid" }), tag: Type.String({ minLength: 1, maxLength: 240 }),
  targetUrl: Type.String({ pattern: "^/#/", maxLength: 2_048 }), urgency: Type.Union([Type.Literal("normal"), Type.Literal("high")]),
  title: localized, body: localized, createdAt: instant, occurredAt: instant,
  readAt: Type.Union([instant, Type.Null()]), cancelledAt: Type.Union([instant, Type.Null()]),
  delivery: Type.Object({
    status: Type.Union([Type.Literal("pending"), Type.Literal("sending"), Type.Literal("accepted"), Type.Literal("failed"),
      Type.Literal("unknown"), Type.Literal("in_app"), Type.Literal("suppressed")]),
    attempts: Type.Record(Type.String(), deliveryResultSchema),
  }, { additionalProperties: false }),
}, { additionalProperties: false });
export type InboxNotice = Static<typeof noticeSchema>;
export type ConversationWatch = { id: string; name: string; summary: string; recurrence: Record<string, unknown>; state: string; nextFireAt: string | null; deadline: string | null; createdAt: string };
export type ProactiveConversation = { status: "ready"; todos: Todo[]; notices: InboxNotice[]; watches?: ConversationWatch[] } | { status: "unavailable"; message: string };
export type InboxDraft = Pick<InboxNotice, "id" | "tag" | "targetUrl" | "urgency" | "title" | "body" | "occurredAt">;
export type PushResult = Static<typeof deliveryResultSchema>;
const stateSchema = Type.Object({ records: Type.Record(Type.String(), noticeSchema) }, { additionalProperties: false });
type State = Static<typeof stateSchema>;
const initial = (): State => ({ records: {} });
export const InboxState = defineDoc<State>({
  kind: "ox.notifications", version: 1, scope: "session", initial,
  checkpointWhen: (_, __, info) => info.deltasSinceBase >= 31,
});
const context = BACKGROUND_CONTEXT;
const limit = 1_000;
const conversationReadSchema = Type.Object({
  conversationId: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  ids: Type.Array(Type.String({ format: "uuid" }), { minItems: 1, maxItems: limit, uniqueItems: true }),
}, { additionalProperties: false });
const unavailable = () => new OxError("unavailable", "The notification inbox is invalid. No empty replacement was created.", "Restore or repair this Profile before using its inbox.");

export function validateInbox(state: State) {
  if (!Value.Check(stateSchema, state) || Object.entries(state.records).some(([id, notice]) => id !== notice.id)) throw unavailable();
  return state;
}

export function enqueueNotice(state: State, draft: InboxDraft, now: string) {
  validateInbox(state);
  if (Object.hasOwn(state.records, draft.id)) return state.records[draft.id]!;
  if (Object.keys(state.records).length >= limit) throw new OxError("limit_exceeded", "This preview's notification inbox has reached its 1,000-notice limit.", "Keep the existing Profile intact and review inbox retention before enabling more notifications.");
  const notice: InboxNotice = { ...draft, createdAt: now, readAt: null, cancelledAt: null, delivery: { status: "pending", attempts: {} } };
  if (!Value.Check(noticeSchema, notice)) throw new OxError("invalid_argument", "Invalid notification content or destination.");
  state.records[notice.id] = notice;
  return notice;
}

export function cancelNotice(state: State, id: string | null, now: string) {
  validateInbox(state);
  const notice = id && Object.hasOwn(state.records, id) ? state.records[id] : undefined;
  if (notice && notice.delivery.status === "pending") {
    notice.cancelledAt = now;
    notice.delivery.status = "suppressed";
  }
}

export class InboxStore {
  private readonly harness: Harness;
  constructor(harness: Harness) { this.harness = harness; }
  async contentEmpty() { return !Object.keys(validateInbox(await this.harness.snapshot(InboxState, context) ?? initial()).records).length; }

  async list() {
    const state = validateInbox(await this.harness.snapshot(InboxState, context) ?? initial());
    const notifications = Object.values(state.records).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
    return { notifications, unreadCount: notifications.filter(notice => notice.readAt === null && notice.cancelledAt === null).length, limit };
  }

  async get(id: string) {
    const state = validateInbox(await this.harness.snapshot(InboxState, context) ?? initial());
    return this.owned(state, id);
  }

  private owned(state: State, id: string) {
    if (!Object.hasOwn(state.records, id)) throw new OxError("not_found", "This notification is unavailable in the current Profile.");
    return state.records[id]!;
  }

  async enqueue(draft: InboxDraft) {
    return this.harness.commit(async tx => Value.Clone(enqueueNotice(await tx.doc(InboxState), draft, new Date().toISOString())), context);
  }

  async read(id: string) {
    return this.harness.commit(async tx => {
      const state = validateInbox(await tx.doc(InboxState));
      const notice = this.owned(state, id);
      notice.readAt ??= new Date().toISOString();
      if (notice.delivery.status === "pending") notice.delivery.status = "suppressed";
      return Value.Clone(notice);
    }, context);
  }

  async readConversation(input: unknown) {
    return this.harness.commit(async tx => {
      if (!Value.Check(conversationReadSchema, input)) throw new OxError("invalid_argument", "Send one safe conversation ID and 1–1,000 distinct notification IDs.");
      const state = validateInbox(await tx.doc(InboxState));
      const notices = input.ids.map(id => this.owned(state, id));
      if (notices.some(notice => noticeConversationID(notice.targetUrl) !== input.conversationId || notice.cancelledAt !== null)) {
        throw new OxError("conflict", "These notifications no longer match the displayed conversation.");
      }
      const now = new Date().toISOString();
      for (const notice of notices) {
        notice.readAt ??= now;
        if (notice.delivery.status === "pending") notice.delivery.status = "suppressed";
      }
      return Value.Clone(notices);
    }, context);
  }

  async recover() {
    await this.harness.commit(async tx => {
      const state = validateInbox(await tx.doc(InboxState));
      for (const notice of Object.values(state.records)) if (notice.delivery.status === "sending") notice.delivery.status = "unknown";
    }, context);
  }

  async claim(id: string) {
    return this.harness.commit(async tx => {
      const notice = this.owned(validateInbox(await tx.doc(InboxState)), id);
      if (notice.delivery.status !== "pending" || notice.readAt !== null || notice.cancelledAt !== null) return null;
      notice.delivery.status = "sending";
      return Value.Clone(notice);
    }, context);
  }

  async record(id: string, attempts: Record<string, PushResult>) {
    await this.harness.commit(async tx => {
      const notice = this.owned(validateInbox(await tx.doc(InboxState)), id);
      if (notice.delivery.status !== "sending") throw new OxError("conflict", "This notification is no longer claimed for delivery.");
      const results = Object.values(attempts);
      notice.delivery.attempts = attempts;
      notice.delivery.status = results.some(result => result.status === "unknown") ? "unknown"
        : results.some(result => result.status === "failed") ? "failed"
        : results.some(result => result.status === "accepted") ? "accepted" : "in_app";
      validateInbox(await tx.doc(InboxState));
    }, context);
  }
}

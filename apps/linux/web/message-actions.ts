import { api, APIError, failed, menu, toast, type MenuItem } from "./client";
import { h, icon } from "./dom";
import { hostText, t } from "./i18n";
import { reactionEmojis, type MessageRef, type MessageTarget, type ReactionEmoji } from "../../../packages/agent/src/adapters/linux/message-actions-contract";

type Operation = { ref: MessageRef; requestId: string; emoji: ReactionEmoji | null; expectedRevision: number; phase: "saving" | "unknown" | "error"; message?: string };
export interface MessageActionHost {
  current(source: string): { target: MessageTarget; revision: number } | undefined;
  epoch(): number | undefined;
  refresh(): Promise<void>;
  changed(): void;
  reply(ref: MessageRef): void;
  more(target: MessageTarget): MenuItem[];
}
const keyOf = (ref: MessageRef) => `${ref.profileId}:${ref.conversationId}:${ref.source}`;
const operations = new Map<string, Operation>();
let generation = 0;
let dismissMenu: (() => void) | undefined;
export function closeMessageMenus() { dismissMenu?.(); dismissMenu = undefined; }
export function clearMessageActions() { generation++; operations.clear(); closeMessageMenus(); }
export function messageActionsStatus(source: string, host: MessageActionHost) {
  const current = host.current(source);
  return current ? operations.get(keyOf(current.target.ref)) : undefined;
}

async function react(source: string, emoji: ReactionEmoji, host: MessageActionHost) {
  const current = host.current(source);
  if (!current) return;
  const key = keyOf(current.target.ref);
  if (operations.has(key)) return;
  const operation: Operation = { ref: current.target.ref, requestId: crypto.randomUUID(), expectedRevision: current.revision,
    emoji: current.target.emoji === emoji ? null : emoji, phase: "saving" };
  const started = generation;
  operations.set(key, operation); host.changed();
  const active = () => generation === started && host.epoch() === operation.ref.epoch && operations.get(key) === operation;
  try {
    const proof = await api<{ requestId: string; inputApplied: boolean; replayed: boolean; emoji: ReactionEmoji | null }>(`/api/conversations/${operation.ref.conversationId}/reactions`,
      { method: "POST", json: { ref: operation.ref, emoji: operation.emoji, expectedRevision: operation.expectedRevision, requestId: operation.requestId } });
    if (!active()) return;
    if (proof.requestId !== operation.requestId || proof.inputApplied !== true || proof.replayed !== false || proof.emoji !== operation.emoji) {
      operation.phase = "unknown";
    } else {
      operations.delete(key);
      await host.refresh();
    }
  } catch (error) {
    if (!active()) return;
    operation.phase = error instanceof APIError && error.status >= 400 && error.status < 500 && error.status !== 408 ? "error" : "unknown";
    operation.message = hostText(error instanceof Error ? error.message : String(error));
  } finally { if (generation === started && host.epoch() === operation.ref.epoch) host.changed(); }
}
async function check(operation: Operation, host: MessageActionHost) {
  const started = generation, key = keyOf(operation.ref);
  try {
    if (operation.phase === "unknown") {
      const proof = await api<{ requestId: string; inputApplied: boolean; replayed: boolean; current: boolean }>(
        `/api/conversations/${operation.ref.conversationId}/reactions/${operation.requestId}`);
      if (generation !== started || host.epoch() !== operation.ref.epoch) return;
      if (proof.requestId !== operation.requestId || proof.inputApplied !== false || proof.replayed !== true) throw new Error(t("personalDataInvalid"));
      toast(t(proof.current ? "mrReactionVerified" : "mrReactionHistorical"));
    }
    if (generation !== started || host.epoch() !== operation.ref.epoch) return;
    operations.delete(key); await host.refresh(); host.changed();
  } catch (error) { if (generation === started) failed(error); }
}

export function messageMoreButton(items: () => MenuItem[]) {
  const more = h("button", { type: "button", className: "icon-button action", title: t("moreOptions"), "aria-label": t("moreOptions"),
    "aria-haspopup": "menu", "aria-expanded": "false", "data-testid": "message-more", onclick: () => {
      dismissMenu = menu(more, items().map(item => ({ ...item, run: () => { more.focus({ preventScroll: true }); item.run(); } })),
        { className: "muse-message-more-menu" });
    } }, icon("more", 18));
  return more;
}

export function messageControls(source: string, host: MessageActionHost) {
  const controls = h("div", { className: "muse-message-actions", "data-testid": "message-actions", "data-message-actions": source });
  const reaction = h("button", { type: "button", className: "icon-button action", title: t("mrReact"), "aria-label": t("mrReact"),
    "aria-haspopup": "menu", "aria-expanded": "false", "data-testid": "message-react", onclick: () => {
      if (messageActionsStatus(source, host)) return;
      dismissMenu = menu(reaction, reactionEmojis.map((emoji, index) => ({ label: emoji, testID: `message-reaction-${index}`,
        run: () => { reaction.focus({ preventScroll: true }); void react(source, emoji, host); } })),
        { className: "muse-reaction-picker" });
    } }, icon("smile", 18));
  const reply = h("button", { type: "button", className: "icon-button action", title: t("mrReply"), "aria-label": t("mrReply"),
    "data-testid": "message-reply", onclick: () => { const current = host.current(source); if (current) host.reply(current.target.ref); } }, icon("reply", 18));
  const more = messageMoreButton(() => { const current = host.current(source); return current ? host.more(current.target) : []; });
  controls.append(reaction, reply, more);
  updateMessageControls(controls, host);
  return controls;
}
export function updateMessageControls(controls: HTMLElement, host: MessageActionHost) {
  const source = controls.dataset.messageActions!, current = host.current(source);
  if (!current) { controls.hidden = true; return; }
  controls.hidden = false;
  const operation = messageActionsStatus(source, host), reaction = controls.querySelector<HTMLButtonElement>("[data-testid=message-react]")!;
  const value = current.target.emoji ?? "";
  if (reaction.dataset.emoji !== value) {
    reaction.dataset.emoji = value; reaction.replaceChildren(value || icon("smile", 18));
  }
  reaction.setAttribute("aria-pressed", String(!!value));
  reaction.setAttribute("aria-label", value ? `${t("mrReact")}: ${value}` : t("mrReact"));
  reaction.classList.toggle("selected", !!value);
  reaction.setAttribute("aria-disabled", String(!!operation));
  controls.querySelector("[data-testid=message-action-status]")?.remove();
  if (operation) controls.append(h("span", { className: `muse-message-status${operation.phase === "error" ? " error" : ""}`,
    "data-testid": "message-action-status", role: operation.phase === "error" ? "alert" : "status" },
  operation.phase === "saving" ? t("mrSaving") : operation.phase === "unknown" ? t("mrReactionUnknown") : operation.message ?? t("error"),
  operation.phase === "saving" ? null : h("button", { type: "button", className: "text-button", "data-testid": "message-action-check",
    onclick: () => void check(operation, host) }, t(operation.phase === "unknown" ? "mrCheckResult" : "mrRefreshMessage"))));
}

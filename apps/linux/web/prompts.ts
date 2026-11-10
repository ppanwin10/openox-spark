import { recurrenceText } from "./capabilities";
import { api, failed, formDialog } from "./client";
import { h, icon } from "./dom";
import { hostText, t } from "./i18n";

export type Field = { name: string; label: string; secret?: boolean; optional?: boolean; multiline?: boolean };
export type PromptKind = { type: string; promptKind?: string; prompt: string; options: string[]; answer?: string; promptId?: string;
  title?: string; detail?: string; fields?: Field[]; page?: string; done?: string; submit?: string; login?: boolean };
export type PageCard = { id: string; title: string; url: string };
export interface Handoff { conversationId: number | null; promptId: string; title: string; body: string; done: string; respond?(): Promise<unknown> }
export interface PromptContext { conversationId: number | null; pending: boolean; answered(): void; openPage(id: string, handoff?: Handoff): void; isOpen(id: string): boolean;
  send?(body: Record<string, unknown>): Promise<unknown> }

const approvalLabels: Record<string, () => string> = { Approve: () => t("approve"), "Always approve": () => t("alwaysApprove"), Deny: () => t("deny") };
const resolvedLabels: Record<string, () => string> = { Approve: () => t("approved"), "Always approve": () => t("alwaysApproved"), Deny: () => t("denied"),
  Submitted: () => t("submitted"), Cancelled: () => t("cancelled"), Closed: () => t("cancelled"), Done: () => t("done") };
const doneLabel = (done: string | undefined) => !done || done === "Done" ? t("done") : hostText(done);
export const host = (url: string) => { try { return new URL(url).host; } catch { return url; } };

function detailView(detail: string) {
  let parsed: unknown;
  try { parsed = JSON.parse(detail); } catch {}
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !Object.keys(parsed).length) return h("pre", { className: "request-detail" }, detail);
  return h("dl", { className: "request-detail fields" }, ...Object.entries(parsed as Record<string, unknown>).flatMap(([key, value]) => [
    h("dt", {}, key), h("dd", {}, typeof value === "string" ? value : JSON.stringify(value, null, 2))]));
}

async function respond(context: PromptContext, card: HTMLElement, body: Record<string, unknown>) {
  if (!context.send && context.conversationId === null) return;
  card.querySelectorAll("button, input, textarea").forEach(element => (element as HTMLButtonElement).disabled = true);
  await (context.send ? context.send(body) : api(`/api/conversations/${context.conversationId}/respond`, { method: "POST", json: body })).catch(error => {
    card.querySelectorAll("button, input, textarea").forEach(element => (element as HTMLButtonElement).disabled = false);
    failed(error);
  });
  context.answered();
}

function resolved(kind: PromptKind, testID: string) {
  const answer = kind.answer === undefined ? t("notAnswered") : resolvedLabels[kind.answer]?.() ?? hostText(kind.answer);
  return h("div", { className: "request-card resolved", "data-testid": testID },
    h("div", { className: "request-head" }, icon(kind.promptKind === "form" ? "key" : kind.promptKind === "page" ? "globe" : "shield", 18),
      h("span", { className: "request-title" }, hostText(kind.title || kind.prompt)), h("span", { className: "request-result" }, answer)));
}

function detailObject(detail: string | undefined) {
  if (!detail) return undefined;
  try {
    const value: unknown = JSON.parse(detail);
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch { return undefined; }
}

const weekdayNames = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const frequencies = ["once", "interval", "daily", "weekly"];
const ofType = (args: Record<string, unknown>, type: string, keys: string[]) => keys.every(key => args[key] === undefined || typeof args[key] === type);

function scheduleSummary(kind: PromptKind) {
  const args = kind.title === "Create a schedule" ? detailObject(kind.detail) : undefined;
  if (!args || typeof args.name !== "string" || typeof args.frequency !== "string" || !frequencies.includes(args.frequency)
    || !ofType(args, "number", ["hour", "minute", "intervalSeconds"]) || !ofType(args, "string", ["fireAt", "timeZone", "weekday", "prompt"])) return null;
  const weekday = typeof args.weekday === "string" ? weekdayNames.indexOf(args.weekday.toLowerCase()) + 1 : undefined;
  let when: string;
  try {
    when = recurrenceText({ kind: args.frequency, seconds: args.intervalSeconds, hour: args.hour, minute: args.minute, weekday, fireAt: args.fireAt, timeZone: args.timeZone });
  } catch { return null; }
  return h("div", { className: "request-summary", "data-testid": "approval-summary" }, icon("clock", 18),
    h("div", { className: "request-summary-text" },
      h("div", { className: "request-summary-title" }, args.name),
      h("div", { className: "request-summary-when" }, when),
      typeof args.prompt === "string" && args.prompt.trim() ? h("div", { className: "request-summary-body" }, args.prompt) : null));
}

const sourceLine = (title: string) => title.includes(" - ") ? title.replace(" - ", " · ") : `Ox · ${title}`;

export function approvalCard(kind: PromptKind, context: PromptContext) {
  if (!kind.promptId || !context.pending) return resolved(kind, "resolved-approval");
  const detail = kind.detail;
  const info = detail ? h("button", { type: "button", className: "icon-button request-info", "aria-haspopup": "dialog", "aria-label": t("viewArguments"), title: t("viewArguments"),
    "data-testid": "approval-details", onclick: () => void formDialog({ title: t("arguments"), content: detailView(detail), confirm: t("done"), cancel: false, testID: "arguments-dialog" }) },
    icon("info", 18)) : null;
  const card = h("div", { className: "request-card", "data-testid": "pending-approval" },
    h("div", { className: "request-head" }, icon("shield", 16), h("span", { className: "request-source", "data-testid": "approval-source" }, sourceLine(hostText(kind.title) || t("approve"))), info),
    h("p", { className: "request-prompt" }, hostText(kind.prompt)),
    scheduleSummary(kind));
  card.append(h("div", { className: "request-options" }, ...["Approve", "Always approve", "Deny"].map(option => h("button", { type: "button",
    className: `button ${option === "Approve" ? "primary" : "secondary"}`, "data-testid": `approval-${option.toLowerCase().replace(" ", "-")}`,
    onclick: () => void respond(context, card, { promptId: kind.promptId, answer: option }) }, approvalLabels[option]!()))));
  return card;
}

export function formCard(kind: PromptKind, context: PromptContext) {
  if (!kind.promptId || !context.pending) return resolved(kind, "resolved-form");
  const inputs = (kind.fields ?? []).map(field => {
    const props = { className: "field", name: field.name, required: !field.optional, autocomplete: field.secret ? "new-password" : "off", autocapitalize: "off",
      spellcheck: "false", "aria-label": hostText(field.label), "data-testid": `form-field-${field.name}` };
    const input = field.multiline ? h("textarea", { ...props, rows: 4 }) : h("input", { ...props, type: field.secret ? "password" : "text" });
    return { field, input };
  });
  const card = h("form", { className: "request-card", "data-testid": "pending-form", onsubmit: (event: Event) => {
    event.preventDefault();
    const values = Object.fromEntries(inputs.map(({ field, input }) => [field.name, input.value]));
    for (const { input } of inputs) input.value = "";
    void respond(context, card, { promptId: kind.promptId, values });
  } },
    h("div", { className: "request-head" }, icon("key", 18), h("h3", { className: "request-title" }, hostText(kind.title || kind.prompt))),
    kind.title ? h("p", { className: "request-prompt" }, hostText(kind.prompt)) : null,
    ...inputs.map(({ field, input }) => h("label", { className: "stack" },
      h("span", { className: "label" }, hostText(field.label), field.optional ? h("span", { className: "tag" }, t("optional")) : null), input)),
    h("div", { className: "button-row" },
      h("button", { type: "submit", className: "button primary", "data-testid": "form-submit" }, hostText(kind.submit) || t("save")),
      h("button", { type: "button", className: "button secondary", "data-testid": "form-cancel", onclick: () => {
        for (const { input } of inputs) input.value = "";
        void respond(context, card, { promptId: kind.promptId, cancel: true });
      } }, t("cancel"))));
  return card;
}

export function pageHandoffCard(kind: PromptKind, context: PromptContext) {
  if (!kind.promptId || !context.pending || !kind.page) return resolved(kind, "resolved-page");
  const done = kind.done || "Done", send = context.send;
  const handoff: Handoff = { conversationId: context.conversationId, promptId: kind.promptId, title: hostText(kind.title) || t("livePage"), body: hostText(kind.prompt), done,
    ...(send ? { respond: () => send({ promptId: kind.promptId, answer: done }) } : {}) };
  const preview = h("img", { className: "page-thumb", alt: "", src: `/api/pages/${encodeURIComponent(kind.page)}/snapshot?t=${Date.now()}`, loading: "lazy" });
  preview.addEventListener("error", () => preview.remove(), { once: true });
  const card = h("div", { className: "request-card", "data-testid": "pending-page" },
    h("div", { className: "request-head" }, icon("globe", 18), h("h3", { className: "request-title" }, handoff.title)),
    h("p", { className: "request-prompt" }, handoff.body),
    kind.login ? signInForm(kind.page) : null,
    h("button", { type: "button", className: "page-preview", "data-testid": "open-handoff-page", onclick: () => context.openPage(kind.page!, handoff) },
      preview, h("span", { className: "page-preview-label" }, icon("globe", 16), t("openPage"))));
  card.append(h("div", { className: "button-row" },
    h("button", { type: "button", className: kind.login ? "button secondary" : "button primary", "data-testid": "page-done",
      onclick: () => void respond(context, card, { promptId: kind.promptId, answer: handoff.done }) }, doneLabel(kind.done)),
    h("button", { type: "button", className: "button secondary", "data-testid": "page-cancel", onclick: () => void respond(context, card, { promptId: kind.promptId, cancel: true }) }, t("cancel"))));
  return card;
}

const signIns = new Set<() => void>();
export function refreshSignIns() { for (const refresh of [...signIns]) refresh(); }

function signInForm(page: string) {
  const field = (name: string, label: string, attributes: Record<string, string>) => {
    const input = h("input", { className: "field", name, "data-testid": `signin-${name}`, ...attributes }) as HTMLInputElement;
    return { input, row: h("label", { className: "stack" }, h("span", { className: "label" }, label), input) };
  };
  const unsaved = { autocomplete: "off", "data-1p-ignore": "true", "data-lpignore": "true", "data-bwignore": "true", "data-form-type": "other" };
  const user = field("username", t("signInUser"), { ...unsaved, autocapitalize: "off", spellcheck: "false" });
  const password = field("password", t("signInPassword"), { ...unsaved, type: "password", autocomplete: "new-password" });
  const code = field("code", t("signInCode"), { autocomplete: "one-time-code", inputmode: "numeric" });
  code.row.hidden = true;
  const status = h("p", { className: "request-note", role: "status", "data-testid": "signin-status", hidden: true });
  const destination = h("p", { className: "request-note signin-host", "data-testid": "signin-host", hidden: true });
  let shown: string | undefined;
  const where = async () => {
    try {
      const { page: state } = await api<{ page: { url: string } }>(`/api/pages/${encodeURIComponent(page)}`);
      shown = /^https?:/.test(state.url) ? host(state.url) : undefined;
      destination.textContent = t("signInDestination", { host: shown ?? "" });
      destination.hidden = !shown;
    } catch { shown = undefined; destination.hidden = true; }
  };
  const submit = h("button", { type: "submit", className: "button primary", "data-testid": "signin-submit" }, t("signIn")) as HTMLButtonElement;
  const messages: Record<string, string> = { submitted: t("signInSubmitted"), form: t("signInForm"), code: t("signInNeedsCode"), none: t("signInNone"), moved: t("signInMoved") };
  const form = h("form", { className: "signin-form", "data-testid": "handoff-signin", onsubmit: async (event: Event) => {
    event.preventDefault();
    const asking = !code.row.hidden;
    const values = asking ? { code: code.input.value } : { username: user.input.value, password: password.input.value };
    if (!Object.values(values).some(Boolean) || submit.disabled) return;
    submit.disabled = true;
    try {
      const result = await api<{ status: string }>(`/api/pages/${encodeURIComponent(page)}/sign-in`, { method: "POST", json: { ...values, ...(shown ? { site: shown } : {}) } });
      password.input.value = "";
      code.input.value = "";
      const needsCode = result.status === "code" || (asking && result.status !== "submitted" && result.status !== "none" && result.status !== "moved");
      code.row.hidden = !needsCode;
      user.row.hidden = password.row.hidden = needsCode;
      submit.textContent = needsCode ? t("signInVerify") : t("signIn");
      status.textContent = messages[result.status] ?? t("signInForm");
      status.hidden = false;
      (needsCode ? code.input : result.status === "form" ? password.input : null)?.focus();
    } catch (error) { failed(error); }
    finally { submit.disabled = false; void where(); }
  } }, destination, user.row, password.row, code.row, h("div", { className: "button-row" }, submit), status);
  const refresh = () => { if (form.isConnected) void where(); else signIns.delete(refresh); };
  signIns.add(refresh);
  void where();
  return form;
}

export function pageItem(page: PageCard, context: PromptContext) {
  const open = context.isOpen(page.id);
  return h("button", { type: "button", className: `page-card${open ? "" : " closed"}`, "data-testid": "page-card", disabled: !open,
    onclick: () => context.openPage(page.id) },
    h("span", { className: "page-icon" }, icon("globe", 18)),
    h("span", { className: "page-text" }, h("span", { className: "page-title" }, page.title || host(page.url)), h("span", { className: "page-host" }, host(page.url))),
    h("span", { className: "chip" }, open ? t("open") : t("pageClosed")));
}

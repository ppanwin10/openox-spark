import { recurrenceText } from "./capabilities";
import { api, failed, formDialog } from "./client";
import { h, icon } from "./dom";
import { hostText, t } from "./i18n";

export type Field = { name: string; label: string; secret?: boolean; optional?: boolean; multiline?: boolean };
export type PromptKind = { type: string; promptKind?: string; prompt: string; options: string[]; answer?: string; resolution?: string; promptId?: string; publicWebApproval?: boolean;
  title?: string; detail?: string; persistentScope?: "site"; fields?: Field[]; page?: string; done?: string; submit?: string; login?: boolean; saveLogin?: boolean };
export type PageCard = { id: string; title: string; url: string };
export interface Handoff { conversationId: number | null; promptId: string; title: string; body: string; done: string; respond?(): Promise<unknown> }
export interface PromptContext { conversationId: number | null; pending: boolean; answered(): void; openPage(id: string, handoff?: Handoff): void; isOpen(id: string): boolean;
  send?(body: Record<string, unknown>): Promise<unknown> }

const approvalLabels: Record<string, () => string> = { Approve: () => t("approve"), "Always approve": () => t("alwaysApprove"), Deny: () => t("deny"),
  "Approve for this task": () => t("ppApproveTask"), "Approve once": () => t("approveOnce"), "I'll do it myself": () => t("doItMyself"),
  "Let OpenOx try": () => t("letOpenOxTry"), "I'll do it": () => t("illDoIt"), Cancel: () => t("cancel") };
const resolvedLabels: Record<string, () => string> = { Approve: () => t("approved"), "Always approve": () => t("alwaysApproved"), Deny: () => t("denied"),
  "Approve for this task": () => t("ppApprovedTask"), Submitted: () => t("submitted"), Cancelled: () => t("cancelled"), Closed: () => t("cancelled"), Done: () => t("done"),
  "Approve once": () => t("approved"), "I'll do it myself": () => t("tookOver"), "Hand back": () => t("handedBack"),
  "Let OpenOx try": () => t("openOxTried"), "I'll do it": () => t("tookOver") };
const doneLabel = (done: string | undefined) => !done || done === "Done" ? t("done") : done === "Hand back" ? t("handBack") : hostText(done);
export const host = (url: string) => { try { return new URL(url).host; } catch { return url; } };

function detailView(detail: string) {
  let parsed: unknown;
  try { parsed = JSON.parse(detail); } catch {}
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !Object.keys(parsed).length) return h("pre", { className: "request-detail" }, detail);
  return h("dl", { className: "request-detail fields" }, ...Object.entries(parsed as Record<string, unknown>).flatMap(([key, value]) => [
    h("dt", {}, key), h("dd", {}, typeof value === "string" ? value : JSON.stringify(value, null, 2))]));
}

async function respond(context: PromptContext, card: HTMLElement, body: Record<string, unknown>) {
  const muse = document.documentElement.hasAttribute("data-muse");
  if (!context.send && context.conversationId === null || muse && card.getAttribute("aria-busy") === "true") return false;
  if (muse) card.setAttribute("aria-busy", "true");
  let accepted = true;
  card.querySelectorAll("button, input, textarea").forEach(element => (element as HTMLButtonElement).disabled = true);
  await (context.send ? context.send(body) : api(`/api/conversations/${context.conversationId}/respond`, { method: "POST", json: body })).catch(error => {
    accepted = false;
    card.querySelectorAll("button, input, textarea").forEach(element => (element as HTMLButtonElement).disabled = false);
    failed(error);
  });
  if (muse) card.setAttribute("aria-busy", "false");
  context.answered();
  return accepted;
}

function resolved(kind: PromptKind, testID: string) {
  const answer = kind.answer === undefined ? t(kind.resolution === "Not recorded" ? "decisionNotRecorded" : "notAnswered")
    : kind.persistentScope === "site" && kind.answer === "Always approve" ? t("ppAllowedSite") : resolvedLabels[kind.answer]?.() ?? hostText(kind.answer);
  const approvalReceipt = kind.promptKind === "approval" && (kind.answer !== undefined || (kind.publicWebApproval && kind.resolution === "Not recorded"));
  return h("div", { className: `request-card resolved${approvalReceipt ? " approval-receipt" : ""}`, "data-testid": testID },
    h("div", { className: "request-head" }, icon(kind.promptKind === "form" ? "key" : kind.promptKind === "page" ? "globe" : "shield", 18),
      h("span", { className: "request-title" }, hostText(kind.title || kind.prompt)), h("span", { className: "request-result" }, answer)),
    approvalReceipt && kind.publicWebApproval && document.documentElement.hasAttribute("data-muse")
      ? h("p", { className: "request-note" }, hostText(kind.prompt)) : null);
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

const watchApprovals = new Set(["List page watches", "Create a page watch", "Update a page watch", "Delete a page watch"]);
function watchSummary(kind: PromptKind) {
  if (kind.title === "List page watches") return null;
  const args = detailObject(kind.detail);
  if (!args) return null;
  const current = args.current && typeof args.current === "object" && !Array.isArray(args.current) ? args.current as Record<string, unknown> : {};
  const draft = { ...current, ...args };
  if (typeof draft.name !== "string" || typeof draft.url !== "string" || typeof draft.enabled !== "boolean"
    || typeof draft.intervalMinutes !== "number" || !Number.isInteger(draft.intervalMinutes) || draft.intervalMinutes < 5 || draft.intervalMinutes > 1_440
    || draft.selector !== undefined && draft.selector !== null && typeof draft.selector !== "string") return null;
  return h("div", { className: "request-summary", "data-testid": "watch-approval-summary" }, icon("globe", 18),
    h("div", { className: "request-summary-text" },
      h("div", { className: "request-summary-title" }, draft.name),
      h("div", { className: "request-summary-when watch-approval-target", "data-testid": "watch-approval-target" }, draft.url),
      h("div", { className: "request-summary-when" }, `${t("watchEveryMinutes", { count: draft.intervalMinutes })} · ${t(draft.enabled ? "watchEnabled" : "watchPaused")}`),
      h("div", { className: "request-summary-body" }, `${t("watchSelector")}: ${typeof draft.selector === "string" && draft.selector ? draft.selector : t("watchWholePage")}`)));
}

function feedPublicationSummary(kind: PromptKind) {
  const items = detailObject(kind.detail)?.items;
  if (!Array.isArray(items) || items.length > 10) return null;
  const names: string[] = [];
  for (const item of items) {
    if (!item || typeof item.name !== "string" || !item.name.trim()) return null;
    names.push(item.name.trim());
  }
  return h("div", { className: "request-summary", "data-testid": "feed-publication-summary" }, icon("feed", 18),
    h("div", { className: "request-summary-text" },
      h("div", { className: "request-summary-title" }, names.length ? t("feedProposedCount", { count: names.length }) : t("feedProposedEmpty")),
      names.length ? h("ul", { className: "feed-proposed-titles" }, ...names.slice(0, 2).map(name => h("li", {}, name))) : null,
      names.length > 2 ? h("div", { className: "request-summary-when" }, t("feedProposedMore", { count: names.length - 2 })) : null));
}

const sourceLine = (title: string) => title.includes(" - ") ? title.replace(" - ", " · ") : `Ox · ${title}`;

export function approvalCard(kind: PromptKind, context: PromptContext) {
  if (!kind.promptId || !context.pending) return resolved(kind, "resolved-approval");
  const detail = kind.detail, watch = watchApprovals.has(kind.title ?? "");
  const info = detail ? h("button", { type: "button", className: "icon-button request-info", "aria-haspopup": "dialog", "aria-label": t("viewArguments"), title: t("viewArguments"),
    "data-testid": "approval-details", onclick: () => void formDialog({ title: t("arguments"),
      content: watch ? h("div", { className: "watch-approval-arguments" }, detailView(detail)) : detailView(detail), confirm: t("done"), cancel: false, testID: "arguments-dialog" }) },
    icon("info", 18)) : null;
  const card = h("div", { className: `request-card${watch ? " watch-approval" : ""}`, "data-testid": "pending-approval" },
    h("div", { className: "request-head" }, icon("shield", 16), h("span", { className: "request-source", "data-testid": "approval-source" }, sourceLine(hostText(kind.title) || t("approve"))), info),
    h("p", { className: "request-prompt" }, hostText(kind.prompt)),
    watch ? watchSummary(kind) : kind.title === "Publish Feed updates" ? feedPublicationSummary(kind) : scheduleSummary(kind));
  card.append(h("div", { className: "request-options" }, ...kind.options.filter(option => option in approvalLabels).map(option => h("button", { type: "button",
    className: `button ${option === "Approve" || option === "Approve once" || option === "Let OpenOx try" ? "primary" : "secondary"}`, "data-testid": `approval-${option.toLowerCase().replaceAll("'", "").replaceAll(" ", "-")}`,
    onclick: () => void respond(context, card, { promptId: kind.promptId, answer: option }) },
    kind.persistentScope === "site" && option === "Always approve" ? t("ppAllowSite") : approvalLabels[option]!()))));
  return card;
}

export function formCard(kind: PromptKind, context: PromptContext) {
  if (!kind.promptId || !context.pending) return resolved(kind, "resolved-form");
  const muse = document.documentElement.hasAttribute("data-muse");
  const inputs = (kind.fields ?? []).map(field => {
    const props = { className: "field", name: field.name, required: !field.optional, autocomplete: field.secret ? "new-password" : "off", autocapitalize: "off",
      spellcheck: "false", "aria-label": hostText(field.label), "data-testid": `form-field-${field.name}` };
    const input = field.multiline ? h("textarea", { ...props, rows: 4 }) : h("input", { ...props, type: field.secret ? "password" : "text" });
    return { field, input };
  });
  const card = h("form", { className: "request-card", "data-testid": "pending-form", onsubmit: async (event: Event) => {
    event.preventDefault();
    const values = Object.fromEntries(inputs.map(({ field, input }) => [field.name, input.value]));
    if (!muse) for (const { input } of inputs) input.value = "";
    if (await respond(context, card, { promptId: kind.promptId, values }) && muse) for (const { input } of inputs) input.value = "";
  } },
    h("div", { className: "request-head" }, icon("key", 18), h("h3", { className: "request-title" }, hostText(kind.title || kind.prompt))),
    kind.title ? h("p", { className: "request-prompt" }, hostText(kind.prompt)) : null,
    ...inputs.map(({ field, input }) => h("label", { className: "stack" },
      h("span", { className: "label" }, hostText(field.label), field.optional ? h("span", { className: "tag" }, t("optional")) : null), input)),
    h("div", { className: "button-row" },
      h("button", { type: "submit", className: "button primary", "data-testid": "form-submit" }, hostText(kind.submit) || t("save")),
      h("button", { type: "button", className: "button secondary", "data-testid": "form-cancel", onclick: async () => {
        if (!muse) for (const { input } of inputs) input.value = "";
        if (await respond(context, card, { promptId: kind.promptId, cancel: true }) && muse) for (const { input } of inputs) input.value = "";
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
  const jobs = document.documentElement.hasAttribute("data-browser-jobs");
  const card = h("div", { className: `request-card${jobs ? " computer-turn" : ""}`, "data-testid": "pending-page" },
    h("div", { className: "request-head" }, icon(jobs ? "monitor" : "globe", 18), h("h3", { className: "request-title" }, jobs && !kind.login ? t("computerYourTurn") : handoff.title)),
    h("p", { className: "request-prompt" }, handoff.body),
    kind.login ? signInForm(kind.page, kind.saveLogin === true, status => { if (jobs && status === "submitted") void respond(context, card, { promptId: kind.promptId, answer: handoff.done }); }) : null,
    h("button", { type: "button", className: "page-preview", "data-testid": "open-handoff-page", onclick: () => context.openPage(kind.page!, handoff) },
      preview, h("span", { className: "page-preview-label" }, icon("globe", 16), t("openPage"))));
  card.append(h("div", { className: "button-row" },
    jobs ? h("button", { type: "button", className: "button primary", "data-testid": "page-takeover", onclick: () => context.openPage(kind.page!, handoff) }, t(kind.login ? "signInMyself" : "takeOverShort")) : null,
    jobs && kind.login ? h("button", { type: "button", className: "button secondary", "data-testid": "signin-for-me", onclick: () => {
      const details = card.querySelector<HTMLDetailsElement>("details.signin-details");
      if (!details) return;
      details.open = true;
      card.querySelector('[data-testid="page-takeover"]')?.classList.replace("primary", "secondary");
      card.querySelector<HTMLElement>('[data-testid="signin-for-me"]')?.setAttribute("hidden", "");
      details.querySelector<HTMLInputElement>('[data-testid="signin-username"]')?.focus();
    } }, t("signInForMe")) : null,
    h("button", { type: "button", className: kind.login || jobs ? "button secondary" : "button primary", "data-testid": "page-done",
      onclick: () => void respond(context, card, { promptId: kind.promptId, answer: handoff.done }) }, doneLabel(kind.done)),
    h("button", { type: "button", className: "button secondary", "data-testid": "page-cancel", onclick: () => void respond(context, card, { promptId: kind.promptId, cancel: true }) }, t("cancel"))));
  return card;
}

const signIns = new Set<() => void>();
export function refreshSignIns() { for (const refresh of [...signIns]) refresh(); }

function signInForm(page: string, offerSave = false, filled?: (status: string) => void) {
  const field = (name: string, label: string, attributes: Record<string, string>) => {
    const input = h("input", { className: "field", name, "data-testid": `signin-${name}`, ...attributes }) as HTMLInputElement;
    return { input, row: h("label", { className: "stack" }, h("span", { className: "label" }, label), input) };
  };
  const unsaved = { autocomplete: "off", "data-1p-ignore": "true", "data-lpignore": "true", "data-bwignore": "true", "data-form-type": "other" };
  const user = field("username", t("signInUser"), { ...unsaved, autocapitalize: "off", spellcheck: "false" });
  const password = field("password", t("signInPassword"), { ...unsaved, type: "password", autocomplete: "new-password" });
  const code = field("code", t("signInCode"), { autocomplete: "one-time-code", inputmode: "numeric" });
  const save = h("input", { type: "checkbox", "data-testid": "signin-save" }) as HTMLInputElement;
  const saveRow = offerSave ? h("label", { className: "checkbox-row" }, save, h("span", {}, t("signInSave"))) : null;
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
  const jobs = document.documentElement.hasAttribute("data-browser-jobs");
  const messages: Record<string, string> = { submitted: t(jobs ? "signInSubmittedJobs" : "signInSubmitted"), form: t("signInForm"), code: t("signInNeedsCode"),
    none: t(jobs ? "signInNoneJobs" : "signInNone"), moved: t("signInMoved") };
  const form = h("form", { className: "signin-form", "data-testid": "handoff-signin", onsubmit: async (event: Event) => {
    event.preventDefault();
    const asking = !code.row.hidden;
    const values = asking ? { code: code.input.value } : { username: user.input.value, password: password.input.value, ...(offerSave && save.checked ? { save: true } : {}) };
    if (!Object.values(values).some(Boolean) || submit.disabled) return;
    submit.disabled = true;
    try {
      const result = await api<{ status: string }>(`/api/pages/${encodeURIComponent(page)}/sign-in`, { method: "POST", json: { ...values, ...(shown ? { site: shown } : {}) } });
      password.input.value = "";
      code.input.value = "";
      const needsCode = result.status === "code" || (asking && result.status !== "submitted" && result.status !== "none" && result.status !== "moved");
      code.row.hidden = !needsCode;
      user.row.hidden = password.row.hidden = needsCode;
      if (saveRow) saveRow.hidden = needsCode;
      submit.textContent = needsCode ? t("signInVerify") : t("signIn");
      status.textContent = messages[result.status] ?? t("signInForm");
      status.hidden = false;
      filled?.(result.status);
      (needsCode ? code.input : result.status === "form" ? password.input : null)?.focus();
    } catch (error) { failed(error); }
    finally { submit.disabled = false; void where(); }
  } }, destination, user.row, password.row, saveRow, code.row, h("div", { className: "button-row" }, submit), status);
  const refresh = () => { if (form.isConnected) void where(); else signIns.delete(refresh); };
  signIns.add(refresh);
  void where();
  return jobs ? h("details", { className: "signin-details" }, h("summary", { hidden: true }, t(offerSave ? "signInTypeToSave" : "signInTypeHere")), form) : form;
}

export function pageItem(page: PageCard, context: PromptContext) {
  const open = context.isOpen(page.id);
  return h("button", { type: "button", className: `page-card${open ? "" : " closed"}`, "data-testid": "page-card", disabled: !open,
    onclick: () => context.openPage(page.id) },
    h("span", { className: "page-icon" }, icon("globe", 18)),
    h("span", { className: "page-text" }, h("span", { className: "page-title" }, page.title || host(page.url)), h("span", { className: "page-host" }, host(page.url))),
    h("span", { className: "chip" }, open ? t("open") : t("pageClosed")));
}

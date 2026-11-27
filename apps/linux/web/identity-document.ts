import { api, APIError, ask, formDialog, getContentEpoch, toast } from "./client";
import { h } from "./dom";
import { t } from "./i18n";

type Document = { path: string; exists: boolean; text: string | null; revision: string };
const route = "/api/identity/document";
function checked(doc: Document) {
  if (!doc || doc.path !== "Identity.md" || typeof doc.exists !== "boolean"
    || (doc.exists ? typeof doc.text !== "string" || doc.text.length > 8_000 || !/^[a-f0-9]{64}$/.test(doc.revision)
      : doc.text !== null || doc.revision !== "missing")) throw new Error(t("personalDataInvalid"));
  return doc;
}
const read = async () => checked(await api<Document>(route, { signal: AbortSignal.timeout(10_000) }));

export async function editIdentityDocument(opener: HTMLButtonElement) {
  if (opener.disabled) return;
  const epoch = getContentEpoch(), here = () => opener.isConnected && getContentEpoch() === epoch;
  opener.disabled = true;
  try {
    const source = await read();
    if (!here()) return;
    const text = h("textarea", { className: "field", rows: 8, maxlength: 8_000, "aria-label": "Identity.md", "data-testid": "muse-identity-document-text",
      placeholder: t("identityDocumentPlaceholder"), spellcheck: "false" });
    text.value = source.text ?? "";
    const baseline = text.value, crlf = source.text?.includes("\r\n") && !/[\r\n]/.test(source.text.replaceAll("\r\n", ""));
    const saved = await formDialog({ title: "Identity.md", testID: "muse-identity-document", message: t("identityDocumentHelp"), protectDraft: true,
      content: h("div", { className: "stack" }, h("label", { className: "stack" }, h("span", { className: "label" }, t("identityDocumentDescription")), text),
        h("p", { className: "muted small" }, t(source.exists ? "identityDocumentExisting" : "identityDocumentMissing"))), submit: async () => {
        if (text.value === baseline) return;
        const draft = crlf ? text.value.replaceAll("\n", "\r\n") : text.value;
        if (!draft && await ask({ title: t("identityDocumentClear"), message: t("identityDocumentClearBody"), confirm: t("identityDocumentClear"),
          testID: "identity-document-clear", destructive: true }) !== "confirm") throw new Error(t("identityDocumentNotCleared"));
        if (!here()) throw new Error(t("museIdentityUnavailable"));
        try {
          const result = checked(await api<Document>(route, { method: "PUT", json: { text: draft, expectedSourceRevision: source.revision } }));
          if (result.text !== draft) throw new Error(t("personalDataInvalid"));
        } catch (failure) {
          if (failure instanceof APIError && failure.status === 409) throw new Error(t("identityDocumentConflict"));
          if (failure instanceof APIError && failure.status < 500) throw failure;
          if (here() && await read().then(doc => doc.exists && doc.text === draft).catch(() => false)) return;
          throw new Error(t("identityDocumentUnknown"));
        }
      } });
    if (saved && text.value !== baseline && here()) toast(t("saved"));
  } finally { if (opener.isConnected) { opener.disabled = false; opener.focus(); } }
}

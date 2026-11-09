import { api, ask, closeOnBackdrop, download, failed, formDialog, menu, relativeTime, toast, type MenuItem, placeToasts } from "./client";
import { h, icon, type IconName } from "./dom";
import { hostText, languagePreference, locale, t } from "./i18n";
import { avatar, connectRepositoryForm, importServiceFile, keepFocus, repositoryRow, serviceRow, skillsContent, type RepositoryRow, type SecretRow, type ServiceRow } from "./capabilities";
import { qrCode } from "./qr";
import { openWhatsNew } from "./onboarding";

export type ModelChoice = { provider: string; modelId: string; thinkingLevel?: string };
export type ModelInfo = { id: string; name: string };
export type Provider = { id: string; name: string; configured: boolean; custom: boolean; baseUrl: string; models: ModelInfo[] };
export type Machine = { id: string; name: string | null; baseUrl: string; models: string[]; images: boolean; hasKey: boolean };
export type Settings = { host: { id: string; version: string }; profile: { id: string; name: string }; storage: string; defaultModel: ModelChoice | null;
  providers: Provider[]; machines: Machine[] };
export type Device = { id: string; name: string; kind: string; createdAt: string; lastSeenAt: string | null };
export type SettingsTab = "general" | "models" | "profile" | "security" | "about" | "permissions" | "services" | "repositories" | "secrets";
export type Theme = "system" | "light" | "dark";
type MediaFeature = { id: "transcription" | "speech" | "image"; model: string; state: string };
type ServedModel = { weights: string; ids: string[]; added: string[]; contextLength: number | null };
type ServedMachine = { id: string; name: string | null; baseUrl: string; images: boolean; local: boolean; error: string | null; served: ServedModel[] };
type Served = { machines: ServedMachine[]; media: { reachable: boolean; memAvailableBytes: number | null; capabilities: MediaFeature[] } };
type Approval = { action: string; policy: string; kind: string; label: string; target: string | null };

export interface SettingsHost {
  settings(): Settings | null;
  apply(value: Settings, defaultChanged?: boolean): void;
  modelSelect(current: ModelChoice | null, onchange: (choice: ModelChoice) => void, testID: string): HTMLElement;
  show(tab: SettingsTab | null): void;
  close(): void;
  signOut(): Promise<void>;
  openPage(id: string): void;
  importConversation(file: File): void;
  startConversation(domain: string): void;
}

const primaryTabs: SettingsTab[] = ["general", "models", "profile", "security", "about"];
const capabilityTabs: SettingsTab[] = ["permissions", "services", "repositories", "secrets"];
export const settingsTabs: SettingsTab[] = [...primaryTabs, ...capabilityTabs];
const tabs: Record<SettingsTab, { icon: IconName; label: () => string }> = {
  general: { icon: "gear", label: () => t("settingsGeneral") },
  models: { icon: "spark", label: () => t("models") },
  profile: { icon: "user", label: () => t("settingsProfile") },
  security: { icon: "shield", label: () => t("settingsSecurity") },
  about: { icon: "info", label: () => t("settingsAbout") },
  permissions: { icon: "check", label: () => t("permissions") },
  services: { icon: "plug", label: () => t("services") },
  repositories: { icon: "book", label: () => t("repositories") },
  secrets: { icon: "key", label: () => t("secrets") },
};
const features: { id: MediaFeature["id"]; label: () => string }[] = [
  { id: "transcription", label: () => t("featureTranscription") }, { id: "speech", label: () => t("featureSpeech") }, { id: "image", label: () => t("featureImage") }];
const stateLabels: Record<string, () => string> = {
  ready: () => t("stateReady"), loads_on_use: () => t("stateOnUse"), loading: () => t("stateLoading"), not_installed: () => t("stateMissing"), insufficient_memory: () => t("stateNoMemory"),
};
const wide = window.matchMedia("(min-width: 900px)");

let dialog: HTMLDialogElement | undefined;
let body: HTMLElement | undefined;
let current: SettingsTab | null = null;
let host: SettingsHost;
let generation = 0;

const stored = (key: string) => { try { return localStorage.getItem(key); } catch { return null; } };
const store = (key: string, value: string | null) => { try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch {} };

export function applyTheme(theme: Theme = (stored("ox.theme") as Theme | null) ?? "system", save = false) {
  if (save) store("ox.theme", theme === "system" ? null : theme);
  const root = document.documentElement;
  if (theme === "light" || theme === "dark") root.dataset.theme = theme;
  else delete root.dataset.theme;
  root.lang = locale === "zh-Hans" ? "zh-CN" : "en";
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    meta.content = theme === "dark" || (theme === "system" && meta.media.includes("dark")) ? "#0A0A0A" : "#FFFFFF";
  }
}

export const settingsOpen = () => !!dialog?.open;
export const settingsTab = () => current;

export function openSettings(context: SettingsHost, tab: SettingsTab | null) {
  host = context;
  current = tab ?? (wide.matches ? "general" : null);
  permissionView = { level: "root" };
  serviceView = null;
  void loadSummaries();
  if (!dialog) {
    dialog = h("dialog", { className: "settings-dialog", "aria-label": t("settings"), "data-testid": "settings" });
    dialog.addEventListener("cancel", event => { event.preventDefault(); host.close(); });
    closeOnBackdrop(dialog, () => host.close());
    document.body.append(dialog);
  }
  render();
  if (!dialog.open) dialog.showModal();
  placeToasts();
  (dialog.querySelector<HTMLElement>(current ? `[data-testid="settings-tab-${current}"]` : ".settings-tab") ?? dialog).focus({ preventScroll: true });
}

export function closeSettings() {
  generation++;
  dialog?.close();
  placeToasts();
  dialog?.remove();
  dialog = undefined;
  body = undefined;
  current = null;
}

export function refreshSettings(tab?: SettingsTab) {
  if (!dialog?.open || !current || (tab && tab !== current) || dialog.querySelector(".menu")) return;
  renderBody();
}

function render() {
  if (!dialog) return;
  dialog.dataset.view = current ? "tab" : "list";
  dialog.toggleAttribute("data-sub", false);
  const nav = h("nav", { className: "settings-nav", "aria-label": t("settings") },
    h("div", { className: "settings-nav-head" },
      h("button", { type: "button", className: "icon-button", "aria-label": t("close"), title: t("close"), "data-testid": "settings-close", onclick: () => host.close() }, icon("close")),
      h("h2", {}, t("settings")), h("span", { className: "phone-spacer" })),
    h("div", { className: "settings-tabs" }, ...primaryTabs.map(tabButton)),
    h("div", { className: "settings-tabs settings-links" }, ...capabilityTabs.map(tabButton),
      h("a", { href: "#/schedules", className: "settings-tab settings-link", "data-testid": "settings-link-schedules" }, icon("clock", 18), h("span", {}, t("schedules")), h("span", { className: "chevron" }, icon("chevron", 16)))));
  body = h("div", { className: "settings-body", "data-testid": "settings-body" });
  const main = h("section", { className: "settings-main", "aria-labelledby": "settings-title" },
    h("header", { className: "settings-head" },
      h("button", { type: "button", className: "icon-button settings-head-back", "aria-label": t("back"), title: t("back"), "data-testid": "settings-back", onclick: goBack }, icon("back")),
      h("h2", { id: "settings-title" }, current ? tabs[current].label() : t("settings")),
      h("button", { type: "button", className: "icon-button phone-only", "aria-label": t("close"), title: t("close"), onclick: () => host.close() }, icon("close"))),
    body);
  const toasts = dialog.querySelector(":scope > .toasts");
  dialog.replaceChildren(nav, main, ...(toasts ? [toasts] : []));
  placeToasts();
  renderBody();
}

function tabButton(id: SettingsTab) {
  return h("button", { type: "button", className: "settings-tab", "aria-current": id === current ? "page" : null, "aria-selected": String(id === current), "data-testid": `settings-tab-${id}`,
    onclick: () => { permissionView = { level: "root" }; serviceView = null; host.show(id); } }, icon(tabs[id].icon, 18), h("span", {}, tabs[id].label()),
    h("span", { className: "settings-tab-value", "data-tab-value": id }, summaries[id] ?? ""), h("span", { className: "chevron" }, icon("chevron", 16)));
}

function renderBody() {
  const settings = host.settings();
  if (!body || !current || !settings) return;
  const token = ++generation, live = () => token === generation;
  const target = body;
  const run = { general, models, profile, security, about, permissions, services, repositories, secrets }[current];
  void Promise.resolve(run(target, settings, live)).catch(error => { if (live()) swap(target, group(null, row({ title: hostText(error instanceof Error ? error.message : String(error)) }))); });
}

function swap(target: HTMLElement, ...nodes: Node[]) {
  const scroll = target.scrollTop, restore = keepFocus(target);
  target.replaceChildren(...nodes);
  target.scrollTop = scroll;
  restore();
}

function row(options: { title: string | Node; description?: string | Node | null; control?: Node | null; testID?: string; mono?: boolean; muted?: boolean; nested?: boolean }) {
  return h("div", { className: `setting-row${options.nested ? " nested" : ""}`, ...(options.testID ? { "data-testid": options.testID } : {}) },
    h("div", { className: "setting-text" }, h("div", { className: `setting-title${options.muted ? " muted" : ""}` }, options.title),
      options.description ? h("div", { className: `setting-description${options.mono ? " mono" : ""}` }, options.description) : null),
    options.control ? h("div", { className: "setting-control" }, options.control) : null);
}

function group(title: string | null, ...children: (Node | null)[]) {
  const nodes: Node[] = [];
  let card: HTMLElement | undefined;
  for (const child of children) {
    if (!child) continue;
    if (child instanceof HTMLElement && (child.classList.contains("setting-row") || child.classList.contains("row"))) {
      if (!card) nodes.push(card = h("div", { className: "settings-card" }));
      card.append(child);
    } else {
      card = undefined;
      nodes.push(child);
    }
  }
  return h("div", { className: "settings-group" }, title ? h("h3", { className: "settings-group-title" }, title) : null, ...nodes);
}

function linkRow(title: string, description: string, href: string, testID: string) {
  return h("a", { href, className: "setting-row link-row", "data-testid": testID },
    h("div", { className: "setting-text" }, h("div", { className: "setting-title" }, title), h("div", { className: "setting-description" }, description)), icon("chevron", 16));
}

function choice(options: [string, string][], value: string, label: string, testID: string, onchange: (value: string) => void) {
  const select = h("select", { "aria-label": label, "data-testid": testID }, ...options.map(([id, text]) => h("option", { value: id }, text)));
  select.value = value;
  const text = h("span", {}, options.find(([id]) => id === value)?.[1] ?? "");
  select.addEventListener("change", () => { text.textContent = options.find(([id]) => id === select.value)?.[1] ?? ""; onchange(select.value); });
  return h("label", { className: "setting-choice" }, text, icon("expand", 16), select);
}

const button = (label: string, testID: string, onclick: () => void, kind = "secondary") =>
  h("button", { type: "button", className: `button ${kind} small`, "data-testid": testID, onclick }, label);

function more(label: string, testID: string, items: () => MenuItem[]) {
  const trigger = h("button", { type: "button", className: "icon-button", "aria-label": `${t("moreOptions")}: ${label}`, title: t("moreOptions"), "data-testid": testID }, icon("more", 18));
  trigger.addEventListener("click", () => menu(trigger, items()));
  return trigger;
}

const tag = (text: string, subtle = false) => h("span", { className: `tag${subtle ? " subtle" : ""}` }, text);

async function saved(work: Promise<unknown>, defaultChanged = false) {
  const value = await work as Settings;
  host.apply(value, defaultChanged);
  renderBody();
}

function general(target: HTMLElement) {
  const theme = (stored("ox.theme") as Theme | null) ?? "system";
  swap(target, group(null,
    row({ title: t("appearance"), control: choice([["system", t("themeSystem")], ["light", t("themeLight")], ["dark", t("themeDark")]], theme, t("appearance"), "setting-theme",
      value => applyTheme(value as Theme, true)) }),
    row({ title: t("language"), control: choice([["auto", t("languageAuto")], ["en", "English"], ["zh-Hans", "简体中文"]], languagePreference, t("language"), "setting-language",
      value => { store("ox.language", value === "auto" ? null : value); location.reload(); }) })));
}

const machineFields = (machine?: Machine) => [
  { name: "address", label: t("machineAddress"), value: machine?.baseUrl ?? "", placeholder: "spark-2:8000", testID: "machine-address" },
  { name: "name", label: t("machineName"), value: machine?.name ?? "", placeholder: t("machineNamePlaceholder"), testID: "machine-name" },
  { name: "key", label: t("optionalKey"), kind: "password" as const, placeholder: machine?.hasKey ? "••••••••" : "", testID: "machine-key" },
  { name: "images", label: t("acceptsImages"), kind: "switch" as const, checked: !!machine?.images, help: t("acceptsImagesBody"), testID: "machine-images" }];

function pairDialog() {
  return formDialog({ title: t("pairMachine"), message: t("pairMachineBody"), testID: "pair-machine-dialog", confirm: t("pairConfirm"), fields: machineFields(),
    submit: async values => {
      const result = await api<Settings & { paired: { name: string; models: string[] } }>("/api/settings/machines", { method: "POST", json: values });
      host.apply(result);
      renderBody();
      toast(t("machinePaired", { name: result.paired.name, count: result.paired.models.length }));
    } });
}

function machineDialog(machine: Machine) {
  return formDialog({ title: t("editMachine"), testID: "machine-dialog", fields: machineFields(machine),
    submit: async values => saved(api(`/api/settings/machines/${encodeURIComponent(machine.id)}`, { method: "PUT", json: values })) });
}

function keyDialog(provider: Provider) {
  return formDialog({ title: provider.configured ? t("replaceKey") : t("addKey"), message: provider.name, testID: "key-dialog", fields: [
    { name: "key", label: t("apiKey"), kind: "password", testID: "provider-key" }],
  submit: async values => {
    if (!String(values.key).trim()) throw new Error(t("apiKey"));
    await saved(api(`/api/settings/providers/${encodeURIComponent(provider.id)}/key`, { method: "PUT", json: { key: values.key } }));
    toast(t("keySaved"));
  } });
}

function machineRows(machine: ServedMachine, settings: Settings) {
  const saved = settings.machines.find(entry => entry.id === machine.id);
  const name = machine.name || new URL(machine.baseUrl).host;
  const rows: Node[] = [row({ testID: "machine-row",
    title: h("span", { className: "name-line" }, h("strong", {}, name), machine.local ? tag(t("thisMachine"), true) : null),
    description: machine.error ? h("span", {}, h("span", { className: "mono" }, machine.baseUrl), h("br"), hostText(machine.error)) : machine.baseUrl, mono: !machine.error,
    control: h("span", { className: "setting-controls" }, tag(machine.error ? t("machineOffline") : t("machineOnline"), true), saved ? more(name, "machine-menu", () => [
      { label: t("edit"), icon: "pencil", testID: "machine-edit", run: () => void machineDialog(saved) },
      { label: t("removeMachine"), icon: "trash", destructive: true, testID: "machine-remove", run: async () => {
        if (await ask({ title: t("removeMachineTitle", { name }), message: t("removeMachineBody"), confirm: t("remove"), destructive: true }) !== "confirm") return;
        await saved_(api(`/api/settings/machines/${encodeURIComponent(machine.id)}`, { method: "DELETE" }));
      } }]) : null) })];
  for (const model of machine.served) {
    const shown = model.added[0] ?? model.ids[0]!;
    const isDefault = settings.defaultModel?.provider === machine.id && model.added.includes(settings.defaultModel.modelId);
    const abilities = [t("capabilityChat"), machine.images ? t("capabilityImages") : null, machine.images && machine.local ? t("capabilityVideo") : null,
      model.contextLength ? t("contextWindow", { count: Math.round(model.contextLength / 1024) }) : null].filter(Boolean).join(" · ");
    const aliases = model.ids.filter(id => id !== shown);
    rows.push(row({ title: model.weights, testID: "served-model", nested: true,
      description: h("span", {}, `${shown} · ${abilities}`, aliases.length ? h("span", { className: "faint" }, ` · ${t("aliasesOf", { names: aliases.join(locale === "zh-Hans" ? "、" : ", ") })}`) : null),
      control: model.added.length ? tag(isDefault ? t("defaultTag") : t("addedTag"), !isDefault)
        : saved ? button(t("add"), "served-add", () => void saved_(api(`/api/settings/machines/${encodeURIComponent(machine.id)}`, { method: "PUT", json: { models: [...saved.models, shown] } }))) : null }));
  }
  return rows;
}

const saved_ = (work: Promise<unknown>) => saved(work).catch(failed);

async function models(target: HTMLElement, settings: Settings, live: () => boolean) {
  const configured = settings.providers.some(provider => provider.configured && provider.models.length);
  const defaults = group(null, row({ title: t("defaultModel"), description: t("defaultModelBody"), testID: "default-model-row", control: configured
    ? host.modelSelect(settings.defaultModel, choice => void saved(api("/api/settings/default-model", { method: "PUT", json: choice }), true).then(() => toast(t("saved")), failed), "default-model")
    : h("span", { className: "muted small" }, t("noDefault")) }));
  const providers = group(t("aiProviders"), ...settings.providers.filter(provider => !provider.custom).map(provider => row({ title: provider.name, testID: `provider-${provider.id}`,
    description: provider.configured ? t("providerConfigured") : t("keyNotSet"),
    control: provider.configured ? more(provider.name, "provider-menu", () => [{ label: t("replaceKey"), icon: "key", run: () => void keyDialog(provider) },
      { label: t("removeKey"), icon: "trash", destructive: true, run: async () => {
        if (await ask({ title: t("removeKeyTitle", { name: provider.name }), message: t("removeKeyBody"), confirm: t("removeKey"), destructive: true }) !== "confirm") return;
        await saved(api(`/api/settings/providers/${encodeURIComponent(provider.id)}/key`, { method: "DELETE" })).catch(failed);
      } }]) : button(t("addKey"), `provider-add-${provider.id}`, () => void keyDialog(provider)) })));
  const pair = h("div", { className: "setting-actions" }, h("button", { type: "button", className: "button secondary small", "data-testid": "machine-pair", onclick: () => void pairDialog() },
    icon("plus", 16), h("span", {}, t("pairMachine"))));
  if (!target.querySelector(".settings-group")) swap(target, defaults, group(t("localMachines"), row({ title: "…", muted: true }), pair), providers);
  const served = await api<Served>("/api/settings/models");
  if (!live()) return;
  const machines = served.machines.flatMap(machine => machineRows(machine, settings));
  const media = served.media;
  const featureRows = media.reachable ? features.map(feature => {
    const entry = media.capabilities.find(item => item.id === feature.id);
    const state = entry?.state ?? "not_installed";
    return row({ title: feature.label(), description: entry?.model || null, testID: `feature-${feature.id}`, control: tag((stateLabels[state] ?? stateLabels.not_installed!)(), state !== "ready") });
  }) : [row({ title: t("mediaOffline"), muted: true, testID: "media-offline" })];
  swap(target, defaults, group(t("localMachines"), ...(machines.length ? machines : [row({ title: t("noMachines"), description: t("noMachinesBody"), muted: true, testID: "machines-empty" })]), pair),
    group(t("localFeatures"), ...featureRows), providers);
}

async function profile(target: HTMLElement, settings: Settings, live: () => boolean) {
  const [memory, skills] = await Promise.all([api<{ text: string }>("/api/settings/memory"),
    skillsContent({ live, refresh: () => refreshSettings("profile"), group: (title, rows) => group(title, ...rows) })]);
  if (!skills || !live()) return;
  const preview = memory.text.trim().replace(/\s+/g, " ");
  const [actions, ...lists] = skills;
  swap(target, group(null,
    row({ title: t("profileName"), description: settings.profile.name, testID: "profile-name-row",
      control: button(t("edit"), "profile-edit", () => void formDialog({ title: t("profileName"), testID: "profile-dialog",
        fields: [{ name: "name", label: t("profileName"), value: settings.profile.name, testID: "profile-name" }],
        submit: async values => { await saved(api("/api/settings/profile", { method: "PUT", json: { name: values.name } })); toast(t("saved")); } })) }),
    row({ title: t("memory"), description: preview ? (preview.length > 140 ? `${preview.slice(0, 140)}…` : preview) : t("memoryEmpty"), testID: "memory-row",
      control: button(t("manage"), "memory-manage", () => void formDialog({ title: t("memory"), message: t("memoryBody"), testID: "memory-dialog",
        fields: [{ name: "text", label: t("memory"), kind: "textarea", rows: 12, value: memory.text, testID: "memory-input" }],
        submit: async values => { await api("/api/settings/memory", { method: "PUT", json: { text: values.text } }); toast(t("saved")); renderBody(); } })) }),
    linkRow(t("files"), t("filesBody"), "#/files", "settings-files"),
    row({ title: t("importConversation"), description: t("importConversationBody"), testID: "import-conversation-row",
      control: h("label", { className: "button secondary small file-button", "data-testid": "import-conversation" }, t("chooseFile"),
        h("input", { type: "file", accept: ".conversation,.chat", hidden: true, "data-testid": "import-conversation-input", onchange: (event: Event) => {
          const input = event.currentTarget as HTMLInputElement, file = input.files?.[0];
          input.value = "";
          if (file) host.importConversation(file);
        } })) })),
    group(t("skills"), h("p", { className: "settings-intro" }, t("skillsBody")), actions ?? null),
    ...lists);
}

async function security(target: HTMLElement, _settings: Settings, live: () => boolean) {
  const [{ devices, current: me }, { approvals }] = await Promise.all([api<{ devices: Device[]; current: string }>("/api/devices"), api<{ approvals: Approval[] }>("/api/approvals")]);
  if (!live()) return;
  const deviceRows = devices.map(device => row({ testID: "device-row",
    title: h("span", { className: "name-line" }, device.name, device.id === me ? tag(t("thisDevice")) : null),
    description: t("lastSeen", { time: device.lastSeenAt ? relativeTime(Date.parse(device.lastSeenAt)) : t("never") }),
    control: device.id === me ? null : button(t("revoke"), "device-revoke", async () => {
      if (await ask({ title: t("revokeTitle", { name: device.name }), message: t("revokeBody"), confirm: t("revoke"), destructive: true }) !== "confirm") return;
      await api(`/api/devices/${device.id}`, { method: "DELETE" }).then(() => renderBody(), failed);
    }) }));
  const approvalRows = approvals.length ? approvals.map(item => row({ testID: "approval-row",
    title: h("span", { className: "name-line" }, item.kind === "browser" ? t("browserSite") : hostText(item.label)),
    description: item.target, control: button(t("forget"), "approval-forget", async () => {
      await api(`/api/approvals/${encodeURIComponent(item.action)}`, { method: "DELETE" }).then(() => renderBody(), failed);
    }) })) : [row({ title: t("noApprovals"), muted: true })];
  swap(target, 
    group(t("devices"), ...deviceRows, h("div", { className: "setting-actions" }, button(t("pairDevice"), "pair-device", async () => {
      const pairing = await api<{ code: string; expiresAt: string }>("/api/devices/pairing", { method: "POST" }).catch(error => { failed(error); return null; });
      if (!pairing) return;
      const link = `${location.origin}/#/pair/${pairing.code}`;
      const reachable = !["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
      await formDialog({ title: t("pairDevice"), testID: "pairing-dialog", confirm: t("done"), cancel: false, content: h("div", { className: "pairing-display" },
        reachable ? h("div", { className: "qr", "data-testid": "pairing-qr", "data-link": link }, qrCode(link, t("pairQrLabel"))) : null,
        reachable ? h("p", { className: "muted small" }, t("pairScan")) : null,
        h("div", { className: "code", "data-testid": "pairing-code" }, pairing.code),
        h("p", { className: "muted small" }, t("pairCodeBody", { time: new Date(pairing.expiresAt).toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" }) }))) });
      renderBody();
    }))),
    group(t("approvalsTitle"), h("p", { className: "settings-intro" }, t("approvalsBody")), ...approvalRows,
      approvals.length > 1 ? h("div", { className: "setting-actions" }, button(t("forgetAll"), "forget-all", async () => {
        if (await ask({ title: t("forgetAllTitle"), message: t("forgetAllBody"), confirm: t("forgetAll"), destructive: true }) !== "confirm") return;
        await api("/api/approvals", { method: "DELETE" }).then(() => renderBody(), failed);
      })) : null));
}

function about(target: HTMLElement, settings: Settings) {
  swap(target, group(null,
    row({ title: t("hostName"), description: settings.host.id }),
    row({ title: t("version"), description: settings.host.version }),
    row({ title: t("storage"), description: settings.storage, mono: true })),
  group(null, drill(t("whatsNew"), "", () => openWhatsNew(), "whats-new-row")),
  h("div", { className: "setting-actions" }, h("button", { type: "button", className: "button danger-text", "data-testid": "sign-out", onclick: async () => {
    if (await ask({ title: t("signOutTitle"), message: t("revokeBody"), confirm: t("signOut"), destructive: true }) !== "confirm") return;
    await host.signOut().catch(failed);
  } }, t("signOut"))));
}

type PermissionAction = { id: string; label: string; default: string; policy: string | null; group?: string };
type Permissions = { default: string | null; builtIn: { policy: string | null; actions: PermissionAction[] }; services: { domain: string; name: string; policy: string | null }[] };
type PermissionView = { level: "root" } | { level: "builtin" } | { level: "group"; group: string } | { level: "service"; domain: string };
let permissionView: PermissionView = { level: "root" };
let serviceView: string | null = null;
let serviceQuery = "";
let summaries: Partial<Record<SettingsTab, string>> = {};
const permissionGroups: Record<string, string> = { conversation: "conversations", provider: "models", secret: "models", web: "web", schedule: "skills", skill: "skills", service: "services",
  repository: "repositories", app: "settings" };
const actionGroups: Record<string, string> = { "ox.app.defaultModel": "models", "ox.app.setDefaultModel": "models", "ox.app.repositories": "repositories" };
const groupTitles: Record<string, () => string> = { conversations: () => t("groupConversations"), models: () => t("groupModels"), web: () => t("groupWeb"), skills: () => t("groupSkills"),
  services: () => t("services"), repositories: () => t("repositories"), settings: () => t("groupAppSettings") };
const policyTitle = (policy: string | null) => policy === "ask" ? t("policyAsk") : policy === "allow" ? t("policyAllow") : policy === "block" ? t("policyBlock") : t("policyDefault");
const policyOptions = (): [string, string][] => [["", t("policyDefault")], ["ask", t("policyAsk")], ["allow", t("policyAllow")], ["block", t("policyBlock")]];

async function loadSummaries() {
  const [permissions, services, repositories] = await Promise.all([api<{ default: string | null }>("/api/permissions").catch(() => null),
    api<{ services: ServiceRow[] }>("/api/services").catch(() => null), api<{ repositories: RepositoryRow[] }>("/api/repositories").catch(() => null)]);
  summaries = {
    ...(permissions ? { permissions: policyTitle(permissions.default) } : {}),
    ...(services ? { services: String(services.services.filter(service => service.available).length) } : {}),
    ...(repositories ? { repositories: t("enabledCount", { count: repositories.repositories.filter(repository => repository.enabled).length }) } : {}),
  };
  for (const [id, text] of Object.entries(summaries)) dialog?.querySelectorAll(`[data-tab-value="${id}"]`).forEach(slot => { slot.textContent = text; });
}

function drill(title: string, value: string, open: () => void, testID: string) {
  return h("button", { type: "button", className: "setting-row link-row", "data-testid": testID, onclick: open },
    h("div", { className: "setting-text" }, h("div", { className: "setting-title" }, title)), value ? h("span", { className: "setting-value" }, value) : null, icon("chevron", 16));
}

function goBack() {
  if (current === "services" && serviceView) { serviceView = null; renderBody(); return; }
  const parent: PermissionView | null = current !== "permissions" || permissionView.level === "root" ? null : permissionView.level === "group" ? { level: "builtin" } : { level: "root" };
  if (!parent) return host.show(null);
  permissionView = parent;
  renderBody();
}

function heading(title: string, sub: boolean) {
  const element = dialog?.querySelector("#settings-title");
  if (element && element.textContent !== title) { element.textContent = title; if (body) body.scrollTop = 0; }
  dialog?.toggleAttribute("data-sub", sub);
}

async function permissions(target: HTMLElement, _settings: Settings, live: () => boolean) {
  const view = permissionView;
  const save = (scope: string, id: string | undefined, policy: string) => void api("/api/permissions", { method: "PUT", json: { scope, id, policy: policy || null } })
    .then(() => { renderBody(); void loadSummaries(); }, failed);
  const picker = (policy: string | null, label: string, testID: string, change: (value: string) => void) => choice(policyOptions(), policy ?? "", label, testID, change);
  const actionRow = (action: PermissionAction) => row({ title: hostText(action.label), description: t("defaultIs", { policy: policyTitle(action.default) }), testID: "permission-action",
    control: picker(action.policy, hostText(action.label), `permission-action-${action.id}`, value => save("action", action.id, value)) });
  if (view.level === "service") {
    const data = await api<{ name: string; policy: string | null; actions: PermissionAction[] }>(`/api/permissions/${encodeURIComponent(view.domain)}`);
    if (!live()) return;
    heading(data.name, true);
    swap(target, group(null, row({ title: t("allServiceActions"), testID: "permission-service-all", control: picker(data.policy, t("allServiceActions"), "permission-service-select", value => save("source", view.domain, value)) })),
      group(null, ...data.actions.map(actionRow)));
    return;
  }
  const data = await api<Permissions>("/api/permissions");
  if (!live()) return;
  const groupOf = (action: PermissionAction) => actionGroups[action.id] ?? permissionGroups[action.group ?? ""] ?? "settings";
  if (view.level === "group") {
    heading(groupTitles[view.group]?.() ?? view.group, true);
    swap(target, group(null, ...data.builtIn.actions.filter(action => groupOf(action) === view.group).map(actionRow)));
  } else if (view.level === "builtin") {
    const groups = Object.keys(groupTitles).filter(name => data.builtIn.actions.some(action => groupOf(action) === name));
    heading(t("builtIntoOx"), true);
    swap(target, group(null, row({ title: t("allBuiltIn"), testID: "permission-builtin-all", control: picker(data.builtIn.policy, t("allBuiltIn"), "permission-builtin-select", value => save("source", "ox", value)) })),
      group(null, ...groups.map(name => drill(groupTitles[name]!(), "", () => { permissionView = { level: "group", group: name }; renderBody(); }, "permission-group"))));
  } else {
    heading(t("permissions"), false);
    swap(target, h("p", { className: "settings-intro" }, t("permissionsBody")),
      group(null, row({ title: t("allActions"), testID: "permission-default", control: picker(data.default, t("allActions"), "permission-default-select", value => save("default", undefined, value)) })),
      group(null, drill(t("builtIntoOx"), policyTitle(data.builtIn.policy), () => { permissionView = { level: "builtin" }; renderBody(); }, "permission-builtin")),
      group(t("services"), ...data.services.map(service => drill(service.name, policyTitle(service.policy), () => { permissionView = { level: "service", domain: service.domain }; renderBody(); }, "permission-service"))));
  }
}

type ServiceDetail = { domain: string; kind: string; name: string; description: string; endpoint: string | null; saved: boolean; supportsLogin: boolean; attachData: "signedIn" | "remote";
  repository: { id: string; name: string; kind: "bundled" | "local" | "git"; syncedAt: number | string | null };
  manage: { inspect: boolean; share: boolean; websiteData: boolean; removeServer: boolean; deleteLocal: boolean }; policy: string | null; attach: { id: string; policy: string | null };
  actions: { id: string; label: string; description: string; standard: boolean; authenticated: boolean; policy: string | null }[] };

function manageRow(title: string, testID: string, run: () => void, destructive = false) {
  return h("button", { type: "button", className: `setting-row link-row${destructive ? " destructive" : ""}`, "data-testid": testID, onclick: run },
    h("div", { className: "setting-text" }, h("div", { className: "setting-title" }, title)), destructive ? null : icon("chevron", 16));
}

async function serviceDetail(target: HTMLElement, domain: string, live: () => boolean) {
  const path = `/api/services/${encodeURIComponent(domain)}`;
  const detail = await api<ServiceDetail>(path);
  if (!live()) return;
  heading(detail.name, true);
  const save = (scope: string, id: string, policy: string) => void api("/api/permissions", { method: "PUT", json: { scope, id, policy: policy || null } }).then(() => renderBody(), failed);
  const options = (inherit: string): [string, string][] => [["", inherit], ["ask", t("policyAsk")], ["allow", t("policyAllow")], ["block", t("policyBlock")]];
  const close = () => { serviceView = null; renderBody(); };
  const confirm = async (title: string, message: string, label: string, run: () => Promise<unknown>) => {
    if (await ask({ title, message, confirm: label, destructive: true }) === "confirm") await run().catch(failed);
  };
  const synced = typeof detail.repository.syncedAt === "string" ? Date.parse(detail.repository.syncedAt) : detail.repository.syncedAt;
  const repositoryStatus = detail.repository.kind === "bundled" ? t("includedWithOx") : detail.repository.kind === "git" ? (synced ? t("syncedAt", { time: relativeTime(synced) }) : t("neverSynced")) : "";
  const chips = (action: ServiceDetail["actions"][number]) => [action.standard ? t("chipStandard") : "", action.authenticated ? t("chipAuthenticated") : ""].filter(Boolean)
    .map(text => h("span", { className: "tag subtle" }, text));
  const actionRows = detail.actions.map(action => row({ title: action.label, testID: "service-action",
    description: action.description || action.standard || action.authenticated ? h("span", { className: "service-action-meta" }, action.description ? h("span", {}, action.description) : null, ...chips(action)) : null,
    control: action.standard ? null : choice(options(t("useServiceDefault")), action.policy ?? "", action.label, `service-action-${action.id}`, value => save("action", action.id, value)) }));
  const manage = [
    detail.manage.inspect ? manageRow(t("inspectServicePage"), "service-inspect", () => void api<{ page: { id: string } }>(`${path}/page`, { method: "POST" }).then(({ page }) => host.openPage(page.id), failed)) : null,
    detail.manage.share ? manageRow(t("shareService"), "service-share", () => void download(`${path}/package`, `${domain}.service`).catch(failed)) : null,
    detail.manage.websiteData ? manageRow(t("clearWebsiteData"), "service-clear-data", () => void confirm(t("clearWebsiteTitle"), t("clearWebsiteBody", { name: detail.name }), t("clearData"),
      () => api(`${path}/website-data`, { method: "DELETE" }).then(() => toast(t("websiteDataCleared"))))) : null,
    detail.manage.removeServer ? manageRow(t("removeMcpServer"), "service-remove-server", () => void confirm(t("removeMcpTitle"), t("removeMcpBody", { name: detail.name }), t("remove"),
      () => api(path, { method: "DELETE" }).then(close)), true) : null,
    detail.manage.deleteLocal ? manageRow(t("deleteLocalService"), "service-delete-local", () => void confirm(t("deleteLocalTitle"), t("deleteLocalBody"), t("delete"),
      () => api(path, { method: "DELETE" }).then(close)), true) : null,
  ].filter((item): item is HTMLButtonElement => !!item);
  swap(target,
    h("div", { className: "service-detail-head", "data-testid": "service-detail" }, avatar(detail.name, detail.domain),
      h("div", { className: "service-detail-title" }, h("div", { className: "row-name" }, detail.name), h("div", { className: "muted small" }, detail.domain)),
      h("div", { className: "button-row" },
        h("button", { type: "button", className: `button secondary small${detail.saved ? " pressed" : ""}`, "aria-pressed": String(detail.saved), "data-testid": "service-save",
          onclick: () => void api(`${path}/saved`, { method: "PUT", json: { saved: !detail.saved } }).then(() => renderBody(), failed) }, detail.saved ? t("serviceSaved") : t("serviceSave")),
        button(t("startConversation"), "service-start", () => host.startConversation(domain)),
        detail.supportsLogin ? button(t("signIn"), "service-sign-in", () => void api<{ page: { id: string } }>(`${path}/login`, { method: "POST" }).then(({ page }) => host.openPage(page.id), failed)) : null)),
    group(null, row({ title: detail.description || t("noDescription"), muted: !detail.description, testID: "service-description" })),
    group(t("serviceActions"),
      row({ title: t("serviceDefault"), testID: "service-default", control: choice(options(t("useGlobalDefault")), detail.policy ?? "", t("serviceDefault"), "service-default-select", value => save("source", domain, value)) }),
      row({ title: hostText("Attach to a conversation"), description: t(detail.attachData === "signedIn" ? "attachSignedIn" : "attachRemote"), testID: "service-attach-policy",
        control: choice(options(t("useServiceDefault")), detail.attach.policy ?? "", hostText("Attach to a conversation"), "service-attach-select", value => save("action", detail.attach.id, value)) }),
      ...(actionRows.length ? actionRows : [row({ title: t("noServiceActions"), muted: true, testID: "service-no-actions" })])),
    group(null, row({ title: detail.kind === "mcp" ? t("serviceEndpoint") : t("serviceDomain"), testID: "service-domain-row", control: h("span", { className: "setting-value" }, detail.endpoint ?? detail.domain) }),
      row({ title: t("serviceRepository"), description: repositoryStatus || null, testID: "service-repository-row",
        control: h("span", { className: "setting-value" }, detail.repository.kind === "git" ? detail.repository.name : detail.repository.kind === "bundled" ? t("builtIn") : t("localRepository")) })),
    ...(manage.length ? [group(null, ...manage)] : []));
}

async function services(target: HTMLElement, _settings: Settings, live: () => boolean) {
  if (serviceView) return serviceDetail(target, serviceView, live);
  const [list, repositories] = await Promise.all([api<{ services: ServiceRow[] }>("/api/services"), api<{ repositories: RepositoryRow[] }>("/api/repositories")]);
  if (!live()) return;
  heading(t("services"), false);
  const search = h("input", { className: "field search-field", type: "search", value: serviceQuery, placeholder: t("searchServices"), "aria-label": t("searchServices"),
    autocomplete: "off", autocapitalize: "off", spellcheck: "false", "data-testid": "service-search" });
  const lists = h("div", {});
  const actions = { openPage: (id: string) => host.openPage(id), refresh: () => renderBody(), open: (domain: string) => { serviceView = domain; renderBody(); } };
  const draw = () => {
    serviceQuery = search.value;
    const needle = search.value.trim().toLocaleLowerCase();
    const matches = list.services.filter(service => !needle || `${service.name} ${service.domain} ${service.description ?? ""}`.toLocaleLowerCase().includes(needle))
      .sort((a, b) => a.name.localeCompare(b.name, locale));
    const available = matches.filter(service => service.available), unavailable = matches.filter(service => !service.available);
    lists.replaceChildren(group(t("availableServices"), ...(available.length ? available.map(service => serviceRow(service, repositories.repositories, actions))
      : [row({ title: t("noServicesMatch"), muted: true, testID: "services-empty" })])),
      ...(unavailable.length ? [group(t("unavailableServices"), ...unavailable.map(service => serviceRow(service, repositories.repositories, actions)))] : []));
  };
  search.addEventListener("input", draw);
  draw();
  const importRow = row({ title: t("importService"), description: t("importServiceBody"), testID: "import-service-row",
    control: h("label", { className: "button secondary small file-button", "data-testid": "import-service" }, t("chooseFile"),
      h("input", { type: "file", accept: ".service", hidden: true, "data-testid": "import-service-input", onchange: async (event: Event) => {
        const input = event.currentTarget as HTMLInputElement, file = input.files?.[0];
        input.value = "";
        const domain = file ? await importServiceFile(file) : undefined;
        if (domain) { serviceView = domain; renderBody(); }
      } })) });
  swap(target, h("div", { className: "settings-search" }, search), lists, group(null, importRow));
}

async function repositories(target: HTMLElement, _settings: Settings, live: () => boolean) {
  const { repositories: list } = await api<{ repositories: RepositoryRow[] }>("/api/repositories");
  if (!live()) return;
  const refresh = () => { renderBody(); void loadSummaries(); };
  swap(target, h("p", { className: "settings-intro" }, t("repositoriesBody")), group(null, ...list.map(repository => repositoryRow(repository, refresh))),
    group(null, connectRepositoryForm(refresh)));
}

async function secrets(target: HTMLElement, _settings: Settings, live: () => boolean) {
  const { secrets: list } = await api<{ secrets: SecretRow[] }>("/api/secrets");
  if (!live()) return;
  swap(target, h("p", { className: "settings-intro" }, t("secretsBody")),
    group(null, ...(list.length ? list.map(secret => row({ title: secret.name || secret.key, description: [secret.key, secret.fields.join(", ")].join(" · "), testID: "secret-row",
      control: more(secret.name || secret.key, "secret-menu", () => [
        { label: t("edit"), icon: "pencil", testID: "secret-edit", run: () => void secretDialog(secret) },
        { label: t("delete"), icon: "trash", destructive: true, testID: "secret-delete", run: async () => {
          if (await ask({ title: t("deleteSecretTitle", { name: secret.name || secret.key }), message: t("deleteSecretBody"), confirm: t("delete"), destructive: true }) !== "confirm") return;
          await api(`/api/secrets/${encodeURIComponent(secret.key)}`, { method: "DELETE" }).then(() => renderBody(), failed);
        } },
      ]) })) : [row({ title: t("noSecrets"), muted: true, testID: "secrets-empty" })]),
      h("div", { className: "setting-actions" }, button(t("addSecret"), "secret-add", () => void secretDialog(null)))));
}

async function secretDialog(secret: SecretRow | null) {
  const text = (testID: string, label: string, value = "", extra: Record<string, string | boolean> = {}) => h("input", { className: "field", value, "aria-label": label, autocomplete: "off",
    autocapitalize: "off", spellcheck: "false", "data-testid": testID, ...extra });
  const key = text("secret-key", t("secretKey"), secret?.key ?? "", secret ? { disabled: true } : { placeholder: "github-token" });
  const name = text("secret-name", t("displayName"), secret?.name ?? "");
  const fields = h("div", { className: "secret-fields" });
  const addField = (field = "") => {
    const line: HTMLElement = h("div", { className: "secret-field" }, text("secret-field-name", t("fieldName"), field, { placeholder: t("fieldName") }),
      text("secret-field-value", t("fieldValue"), "", { type: "password", autocomplete: "new-password", placeholder: secret && field ? t("valueUnchanged") : t("fieldValue") }),
      h("button", { type: "button", className: "icon-button", "aria-label": t("removeField"), title: t("removeField"), onclick: () => line.remove() }, icon("close", 16)));
    fields.append(line);
  };
  for (const field of secret?.fields ?? ["value"]) addField(field);
  const label = (title: string, control: Node) => h("label", { className: "stack" }, h("span", { className: "label" }, title), control);
  await formDialog({ title: secret ? t("editSecret") : t("addSecret"), testID: "secret-dialog", message: t(secret ? "secretEditBody" : "secretAddBody"),
    content: h("div", { className: "secret-form" }, label(t("secretKey"), key), label(t("displayName"), name), h("span", { className: "label" }, t("fields")), fields,
      h("button", { type: "button", className: "button ghost small", "data-testid": "secret-add-field", onclick: () => addField() }, icon("plus", 16), t("addField"))),
    submit: async () => {
      const values = Object.fromEntries([...fields.querySelectorAll(".secret-field")].map(line => {
        const [field, value] = line.querySelectorAll("input");
        return [field!.value.trim(), value!.value];
      }));
      await api(secret ? `/api/secrets/${encodeURIComponent(secret.key)}` : "/api/secrets", { method: secret ? "PUT" : "POST", json: { name: name.value.trim(), fields: values, ...(secret ? {} : { key: key.value.trim() }) } });
      toast(t("saved"));
      renderBody();
    } });
}

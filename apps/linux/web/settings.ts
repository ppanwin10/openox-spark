import { api, ask, closeOnBackdrop, failed, formDialog, menu, relativeTime, toast, type MenuItem } from "./client";
import { h, icon, type IconName } from "./dom";
import { hostText, languagePreference, locale, t } from "./i18n";
import { keepFocus, skillsContent } from "./capabilities";

export type ModelChoice = { provider: string; modelId: string; thinkingLevel?: string };
export type ModelInfo = { id: string; name: string };
export type Provider = { id: string; name: string; configured: boolean; custom: boolean; baseUrl: string; models: ModelInfo[] };
export type Machine = { id: string; name: string | null; baseUrl: string; models: string[]; images: boolean; hasKey: boolean };
export type Settings = { host: { id: string; version: string }; profile: { id: string; name: string }; storage: string; defaultModel: ModelChoice | null;
  providers: Provider[]; machines: Machine[] };
export type Device = { id: string; name: string; kind: string; createdAt: string; lastSeenAt: string | null };
export type SettingsTab = "general" | "models" | "profile" | "security" | "about";
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
}

export const settingsTabs: SettingsTab[] = ["general", "models", "profile", "security", "about"];
const tabs: Record<SettingsTab, { icon: IconName; label: () => string }> = {
  general: { icon: "gear", label: () => t("settingsGeneral") },
  models: { icon: "spark", label: () => t("models") },
  profile: { icon: "user", label: () => t("settingsProfile") },
  security: { icon: "shield", label: () => t("settingsSecurity") },
  about: { icon: "info", label: () => t("settingsAbout") },
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
    meta.content = theme === "dark" || (theme === "system" && meta.media.includes("dark")) ? "#000000" : "#FCFCFC";
  }
}

export const settingsOpen = () => !!dialog?.open;
export const settingsTab = () => current;

export function openSettings(context: SettingsHost, tab: SettingsTab | null) {
  host = context;
  current = tab ?? (wide.matches ? "general" : null);
  if (!dialog) {
    dialog = h("dialog", { className: "settings-dialog", "aria-label": t("settings"), "data-testid": "settings" });
    dialog.addEventListener("cancel", event => { event.preventDefault(); host.close(); });
    closeOnBackdrop(dialog, () => host.close());
    document.body.append(dialog);
  }
  render();
  if (!dialog.open) dialog.showModal();
  (dialog.querySelector<HTMLElement>(current ? `[data-testid="settings-tab-${current}"]` : ".settings-tab") ?? dialog).focus({ preventScroll: true });
}

export function closeSettings() {
  generation++;
  dialog?.close();
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
  const nav = h("nav", { className: "settings-nav", "aria-label": t("settings") },
    h("div", { className: "settings-nav-head" },
      h("button", { type: "button", className: "icon-button", "aria-label": t("close"), title: t("close"), "data-testid": "settings-close", onclick: () => host.close() }, icon("close")),
      h("h2", {}, t("settings")), h("span", { className: "phone-spacer" })),
    ...settingsTabs.map(id => h("button", { type: "button", className: "settings-tab", "aria-current": id === current ? "page" : null, "aria-selected": String(id === current),
      "data-testid": `settings-tab-${id}`, onclick: () => host.show(id) }, icon(tabs[id].icon, 18), h("span", {}, tabs[id].label()), h("span", { className: "chevron" }, icon("chevron", 16)))));
  body = h("div", { className: "settings-body", "data-testid": "settings-body" });
  const main = h("section", { className: "settings-main", "aria-labelledby": "settings-title" },
    h("header", { className: "settings-head" },
      h("button", { type: "button", className: "icon-button phone-only", "aria-label": t("back"), title: t("back"), "data-testid": "settings-back", onclick: () => host.show(null) }, icon("back")),
      h("h2", { id: "settings-title" }, current ? tabs[current].label() : t("settings")),
      h("button", { type: "button", className: "icon-button phone-only", "aria-label": t("close"), title: t("close"), onclick: () => host.close() }, icon("close"))),
    body);
  dialog.replaceChildren(nav, main);
  renderBody();
}

function renderBody() {
  const settings = host.settings();
  if (!body || !current || !settings) return;
  const token = ++generation, live = () => token === generation;
  const target = body;
  const run = { general, models, profile, security, about }[current];
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
  return h("div", { className: "settings-group" }, title ? h("h3", { className: "settings-group-title" }, title) : null, ...children);
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
        submit: async values => { await api("/api/settings/memory", { method: "PUT", json: { text: values.text } }); toast(t("saved")); renderBody(); } })) })),
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
    title: h("span", { className: "name-line" }, item.kind === "browser" ? t("browserSite") : hostText(item.label), item.policy === "block" ? tag(t("blocked"), true) : null),
    description: item.target, control: button(t("forget"), "approval-forget", async () => {
      await api(`/api/approvals/${encodeURIComponent(item.action)}`, { method: "DELETE" }).then(() => renderBody(), failed);
    }) })) : [row({ title: t("noApprovals"), muted: true })];
  swap(target, 
    group(t("devices"), ...deviceRows, h("div", { className: "setting-actions" }, button(t("pairDevice"), "pair-device", async () => {
      const pairing = await api<{ code: string; expiresAt: string }>("/api/devices/pairing", { method: "POST" }).catch(error => { failed(error); return null; });
      if (!pairing) return;
      await formDialog({ title: t("pairCodeTitle"), testID: "pairing-dialog", confirm: t("done"), cancel: false, content: h("div", { className: "pairing-display" },
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
  h("div", { className: "setting-actions" }, h("button", { type: "button", className: "button danger-text", "data-testid": "sign-out", onclick: async () => {
    if (await ask({ title: t("signOutTitle"), message: t("revokeBody"), confirm: t("signOut"), destructive: true }) !== "confirm") return;
    await host.signOut().catch(failed);
  } }, t("signOut"))));
}

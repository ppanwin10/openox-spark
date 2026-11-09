import { sheet } from "./client";
import { h, icon, type IconName } from "./dom";
import { locale, t, type StringKey } from "./i18n";

type Release = { id: string; items: Record<"en" | "zh-Hans", string[]> };

export const releases: Release[] = [
  { id: "2026-11-09", items: {
    en: [
      "Import what another AI app knows about you from a new conversation, and see what's new after each update.",
      "Code in replies is coloured, changes read as files with numbered lines, and Mermaid diagrams are drawn and open full screen.",
      "Replies show how long Ox thought.",
      "Type / to use a skill, paste or drop files into the message box, see a conversation's files, and hold the microphone to talk on a phone.",
      "Open and edit schedules and skills from a conversation, and see the messages a schedule sent.",
      "Open services in Settings, and share or import them as packages the phone app reads.",
      "Regenerate, branch, edit or copy a reply, start a temporary conversation, and export or import conversations.",
    ],
    "zh-Hans": [
      "在新对话里把其他 AI 应用记住的信息导入 Ox；每次更新后都能看到新功能。",
      "回复里的代码会按语法着色，改动以文件和带行号的形式呈现，Mermaid 图表会直接画出来，还能全屏查看。",
      "回复会显示 Ox 思考了多久。",
      "输入 / 就能使用技能；文件可以直接粘贴或拖进输入框；能查看对话里的文件；在手机上按住麦克风就能说话。",
      "在对话里直接打开、编辑定时任务和技能，并能看到定时任务发出的消息。",
      "在设置里打开服务，还能以手机应用可读的格式分享或导入服务。",
      "可以重新生成、分支、编辑或复制回复，开启临时对话，并导出或导入对话。",
    ],
  } },
  { id: "2026-11-08", items: {
    en: [
      "Add photos, files and services from +, and manage permissions, services, repositories and secrets in Settings.",
      "The web client follows the phone app's design, in light and dark.",
      "Requests for your approval show as cards with their source.",
    ],
    "zh-Hans": [
      "可以通过 + 添加照片、文件和服务，并在设置里管理权限、服务、仓库和密钥。",
      "网页版采用与手机应用一致的设计，支持浅色和深色。",
      "需要你批准的请求会以卡片形式显示，并标明来源。",
    ],
  } },
];

const rows: [IconName, StringKey, StringKey][] = [["globe", "onboardingConnect", "onboardingConnectBody"], ["host", "onboardingYours", "onboardingYoursBody"],
  ["cube", "onboardingModel", "onboardingModelBody"]];

const stored = (key: string) => { try { return localStorage.getItem(key); } catch { return null; } };
const store = (key: string, value: string) => { try { localStorage.setItem(key, value); } catch {} };
const markSeen = () => store("ox.whatsNew", releases[0]!.id);
const dateOf = (id: string) => new Intl.DateTimeFormat(locale, { dateStyle: "long", timeZone: "UTC" }).format(new Date(`${id}T12:00:00Z`));

export function openWhatsNew(shown: Release[] = releases, done?: () => void) {
  const view = sheet({ testID: "whats-new", className: "whats-new-sheet", label: t("whatsNew"), onClose: () => { markSeen(); done?.(); } });
  view.dialog.append(
    h("div", { className: "sheet-head" }, h("h2", { className: "sheet-title" }, t("whatsNew")),
      h("div", { className: "sheet-tools" }, h("button", { type: "button", className: "icon-button", "aria-label": t("close"), title: t("close"), "data-testid": "whats-new-close",
        onclick: () => view.close() }, icon("close", 20)))),
    h("div", { className: "sheet-body" }, ...shown.map(release => h("section", { className: "release", "data-testid": "release", "data-release": release.id },
      h("h3", { className: "release-date" }, dateOf(release.id)),
      h("ol", { className: "release-items" }, ...release.items[locale].map(item => h("li", {}, item))))),
      h("button", { type: "button", className: "button primary release-done", "data-testid": "whats-new-done", onclick: () => view.close() }, t("gotIt"))));
}

function openOnboarding(done?: () => void) {
  const view = sheet({ testID: "onboarding", className: "onboarding-sheet", label: t("onboardingTitle"), onClose: () => { store("ox.onboarded", "1"); markSeen(); done?.(); } });
  view.dialog.append(h("div", { className: "onboarding" },
    h("h2", { className: "onboarding-title" }, t("onboardingTitle")),
    h("ul", { className: "onboarding-rows" }, ...rows.map(([name, title, body]) => h("li", { className: "onboarding-row" },
      h("span", { className: "onboarding-icon" }, icon(name, 24)), h("div", { className: "onboarding-text" }, h("strong", {}, t(title)), h("span", {}, t(body)))))),
    h("p", { className: "onboarding-note" }, t("onboardingNote")),
    h("button", { type: "button", className: "button primary onboarding-start", "data-testid": "onboarding-start", onclick: () => view.close() }, t("getStarted"))));
}

export function firstRun(done?: () => void) {
  if (stored("ox.onboarded") !== "1") { openOnboarding(done); return; }
  const seen = releases.findIndex(release => release.id === stored("ox.whatsNew"));
  const unseen = seen < 0 ? releases : releases.slice(0, seen);
  if (unseen.length) openWhatsNew(unseen, done);
}

import peleURL from "../../ios/Resources/Pele.bundle/pele.js" with { type: "file" };
import { sheet } from "./client";
import { codeBlock } from "./code";
import { copyText, h, icon } from "./dom";
import { t } from "./i18n";

type ChartModel =
  | { type: "pie"; sections: Map<string, number> }
  | { type: "quadrantChart"; points: { x: number; y: number; text: { text: string } }[] }
  | { type: "xychart"; xAxis: { type: "band"; categories: string[] } | { type: "linear"; min: number; max: number };
      yAxis: { min: number; max: number }; hasSetYAxis: boolean; plots: { type: "line" | "bar"; title: string; data: [string, number | undefined][] }[] }
  | { type: "sankey"; links: { value: number }[] }
  | { type: "radar"; axes: { label: string }[]; curves: { entries: number[] }[]; options: { min: number; max: number | null; ticks: number } }
  | { type: "treemap"; roots: { value?: number; children?: ChartModelNode[] }[] }
  | { type: "venn"; subsets: { sets: string[]; size: number }[] }
  | { type: "timeline"; periods: { text: string; events: string[] }[] }
  | { type: "gantt"; getTasks(): { processed: boolean; startTime?: Date; endTime?: Date }[] }
  | { type: "kanban"; sections: { items: { id: string }[] }[] }
  | { type: "journey"; tasks: { score: number }[] }
  | { type: "gitGraph"; commits: Map<string, { id: string; seq: number; parents: string[] }>; warnings: string[] }
  | { type: "flowchart"; nodes: Map<string, unknown> }
  | { type: "er" | "mindmap" | "class" | "state" | "architecture" | "requirement" | "sequence" | "c4" | "block" }
  | { type: "packet" | "info" | "railroad" | "agentflow" | "treeView" | "cynefin" | "wardley" | "eventmodeling" | "usecase" | "ishikawa" };
type ChartModelNode = { value?: number; children?: ChartModelNode[] };
type Measurer = { width(text: string, size: number, style: number): number };
type Pele = {
  detectType(source: string): string | null;
  parse(source: string, options?: { config: Record<string, unknown> }): { type: string };
  render(source: string | ChartModel, options: { maxWidth: number; links: boolean; images: boolean; fontFamily?: string; fontFamilyMono?: string; measurer?: Measurer }):
    { type?: unknown; svg?: unknown; width?: unknown; height?: unknown };
};
type ChartIssue = "chartNoRecords" | "chartInvalidData" | "chartZeroArea" | "chartUnavailable";
type Diagram = { src: string; width: number; height: number; label: string; type: string; range?: [number, number] };
type Drawing = Diagram | { issue: ChartIssue };

const tokens = [["bg", "--bg"], ["fg", "--text"], ["muted", "--text-tertiary"], ["line", "--text-secondary"], ["surface", "--surface"],
  ["surface-alt", "--surface-secondary"], ["border", "--text-tertiary"], ["accent", "--accent"]] as const;
const sources = new Map<string, string>();
const ids = new Map<string, string>();
const drawn = new Map<string, Drawing | null>();
const drawing = new Set<string>();
const numerical = new Set(["pie", "quadrantChart", "xychart", "sankey", "radar", "treemap"]);
const temporal = new Set(["venn", "gantt", "timeline"]);
const work = new Set(["kanban", "journey", "gitGraph", "swimlane"]);
const relationships = new Set(["flowchart", "er", "mindmap", "class", "state", "architecture", "requirement", "sequence", "c4", "block"]);
const diagrams = new Set(["packet", "info", "railroad", "agentflow", "treeView", "cynefin", "wardley", "eventmodeling", "usecase", "ishikawa"]);
const charts = new Set([...numerical, ...temporal, ...work, ...relationships, ...diagrams]);
let renderer: Promise<Pele> | undefined;
let palette: string | undefined;
let chartPalette: string | undefined;
let fontRevision = 0;
const containers = new Set<Element>();
const resize = new ResizeObserver(entries => {
  const ids = new Set(entries.flatMap(({ target }) => [...target.querySelectorAll<HTMLElement>("[data-mermaid]")].map(element => element.dataset.mermaid!)));
  for (const id of ids) refresh(id);
});

function load() {
  renderer ??= new Promise<Pele>((resolve, reject) => {
    const script = h("script", { src: peleURL });
    script.addEventListener("load", () => {
      const pele = (window as unknown as { pele?: Pele }).pele;
      if (pele) resolve(pele); else reject(new Error("Pele did not load"));
    });
    script.addEventListener("error", () => { script.remove(); reject(new Error("Pele did not load")); });
    document.head.append(script);
  }).catch((error: unknown) => { renderer = undefined; throw error; });
  return renderer;
}

function colors() {
  if (palette !== undefined) return palette;
  const probe = h("span", { hidden: true });
  document.body.append(probe);
  palette = tokens.map(([name, token]) => { probe.style.color = `var(${token})`; return `--pele-${name}:${getComputedStyle(probe).color}`; }).join(";");
  probe.remove();
  return palette;
}

function chartColors() {
  if (chartPalette !== undefined) return chartPalette;
  const probe = h("span", { hidden: true });
  document.body.append(probe);
  const chartTokens = [["muted", "--text-secondary"], ...Array.from({ length: 8 }, (_, index) => [`series-${index + 1}`, `--diagram-series-${index + 1}`])];
  chartPalette = chartTokens.map(([name, token]) => { probe.style.color = `var(${token})`; return `--pele-${name}:${getComputedStyle(probe).color}`; }).join(";");
  probe.remove();
  return chartPalette;
}

function widthOf(element?: HTMLElement) {
  return Math.max(1, Math.floor(element?.closest(".markdown")?.getBoundingClientRect().width || Math.min(innerWidth - 32, 700)));
}

function keyOf(id: string, element?: HTMLElement) {
  return `${colors()}\n${document.documentElement.hasAttribute("data-muse") ? `${widthOf(element)}\n${getComputedStyle(document.body).fontFamily}\n${fontRevision}\n` : ""}${sources.get(id)}`;
}

function idOf(source: string) {
  let id = ids.get(source);
  if (id === undefined) {
    id = String(ids.size + 1);
    ids.set(source, id);
    sources.set(id, source);
  }
  return id;
}

function rangeOf(model: Extract<ChartModel, { type: "radar" }>): [number, number] {
  let max = model.options.max ?? -Infinity;
  if (model.options.max === null) for (const curve of model.curves) for (const value of curve.entries) max = Math.max(max, value);
  return [model.options.min, max];
}

function chartIssue(model: ChartModel): ChartIssue | undefined {
  let values: number[];
  switch (model.type) {
    case "er":
    case "mindmap":
    case "class":
    case "state":
    case "architecture":
    case "requirement":
    case "sequence":
    case "c4":
    case "block":
    case "packet":
    case "info":
    case "railroad":
    case "agentflow":
    case "treeView":
    case "cynefin":
    case "wardley":
    case "eventmodeling":
    case "usecase":
    case "ishikawa":
      return undefined;
    case "kanban":
      return model.sections.length ? undefined : "chartNoRecords";
    case "journey":
      if (!model.tasks.length) return "chartNoRecords";
      return model.tasks.some(task => !Number.isFinite(task.score) || task.score < 1 || task.score > 5) ? "chartInvalidData" : undefined;
    case "gitGraph":
      if (!model.commits.size) return "chartNoRecords";
      return model.warnings.length || [...model.commits.values()].some(commit => commit.parents.some(id => {
        const parent = model.commits.get(id);
        return !parent || parent.seq >= commit.seq;
      })) ? "chartInvalidData" : undefined;
    case "flowchart":
      return model.nodes.size ? undefined : "chartNoRecords";
    case "venn": {
      if (!model.subsets.length) return "chartNoRecords";
      if (model.subsets.some(subset => !Number.isFinite(subset.size) || subset.size < 0)) return "chartInvalidData";
      const sizes = new Map(model.subsets.filter(subset => subset.sets.length === 1).map(subset => [subset.sets[0]!, subset.size]));
      if (!sizes.size) return "chartInvalidData";
      if (model.subsets.every(subset => subset.size === 0)) return "chartZeroArea";
      if ([...sizes.values()].some(size => size === 0)) return "chartInvalidData";
      if (model.subsets.some(subset => subset.sets.some(id => !sizes.has(id)) || subset.sets.some(id => subset.size > sizes.get(id)!))) return "chartInvalidData";
      const values = [...sizes.values()];
      if (values.some(size => !Number.isFinite((4 * Math.sqrt(size / Math.PI)) ** 4) || (4 * Math.sqrt(size / Math.PI)) ** 4 === 0)) return "chartUnavailable";
      return Math.min(...values) / Math.max(...values) < .09 ? "chartUnavailable" : undefined;
    }
    case "timeline":
      return model.periods.length ? undefined : "chartNoRecords";
    case "gantt": {
      const tasks = model.getTasks();
      if (!tasks.length) return "chartNoRecords";
      return tasks.some(task => !task.processed || !Number.isFinite(Number(task.startTime)) || !Number.isFinite(Number(task.endTime))
        || Number(task.endTime) < Number(task.startTime)) ? "chartInvalidData" : undefined;
    }
    case "pie":
      values = [...model.sections.values()];
      break;
    case "quadrantChart":
      if (!model.points.length) return "chartNoRecords";
      return model.points.some(point => ![point.x, point.y].every(value => Number.isFinite(value) && value >= 0 && value <= 1)) ? "chartInvalidData" : undefined;
    case "xychart": {
      if (!model.plots.length) return "chartNoRecords";
      const values = model.plots.flatMap(plot => plot.data.map(([, value]) => value).filter(value => value !== undefined));
      if (!values.length || values.some(value => !Number.isFinite(value) || Math.abs(value) > 1e300)) return "chartInvalidData";
      if (model.xAxis.type === "linear" && ![model.xAxis.min, model.xAxis.max].every(value => Number.isFinite(value) && Math.abs(value) <= 1e300))
        return "chartInvalidData";
      const { min, max } = model.yAxis;
      return model.hasSetYAxis && (!([min, max].every(value => Number.isFinite(value) && Math.abs(value) <= 1e300) && min !== max)
        || values.some(value => value < Math.min(min, max) || value > Math.max(min, max))) ? "chartInvalidData" : undefined;
    }
    case "sankey":
      values = model.links.map(link => link.value);
      break;
    case "radar": {
      if (!model.axes.length && !model.curves.length) return "chartNoRecords";
      if (model.axes.length < 3 || !model.curves.length || model.curves.some(curve => curve.entries.length !== model.axes.length)) return "chartInvalidData";
      values = model.curves.flatMap(curve => curve.entries);
      if (!values.every(Number.isFinite)) return "chartInvalidData";
      const [min, max] = rangeOf(model);
      if (min === 0 && max === 0 && values.every(value => value === 0)) return "chartZeroArea";
      return !(Number.isFinite(min) && Number.isFinite(max) && min < max && Number.isFinite(max - min)
        && Number.isInteger(model.options.ticks) && model.options.ticks > 0) || values.some(value => value < min || value > max) ? "chartInvalidData" : undefined;
    }
    case "treemap": {
      values = [];
      const pending = [...model.roots];
      while (pending.length) {
        const node = pending.pop()!;
        if (node.children) pending.push(...node.children);
        else if (node.value !== undefined) values.push(node.value);
      }
      break;
    }
  }
  if (!values.length) return "chartNoRecords";
  if (values.some(value => !Number.isFinite(value) || value < 0) || !Number.isFinite(values.reduce((sum, value) => sum + value, 0))) return "chartInvalidData";
  return (model.type === "treemap" || model.type === "sankey") && values.every(value => value === 0) ? "chartZeroArea" : undefined;
}

function chartFont() {
  const style = getComputedStyle(document.body), fontFamily = style.fontFamily, fontFamilyMono = style.getPropertyValue("--mono").trim();
  const canvas = document.createElement("canvas").getContext("2d");
  if (!canvas) return undefined;
  const measurer: Measurer = { width(text, size, style) {
    canvas.font = `${style & 2 ? "italic " : ""}${style & 1 ? "bold " : ""}${size}px ${style & 4 ? fontFamilyMono : fontFamily}`;
    const measured = canvas.measureText(text);
    return Math.max(measured.width, measured.actualBoundingBoxLeft + measured.actualBoundingBoxRight);
  } };
  return { fontFamily, fontFamilyMono, measurer };
}

function chartWidth(model: ChartModel, measurer: Measurer, available: number) {
  if (model.type === "quadrantChart")
    return model.points.reduce((width, point) => Math.max(width, measurer.width(point.text.text, 12, 0) * 2 + 80), available);
  if (model.type !== "xychart" || model.xAxis.type !== "band") return available;
  const category = model.xAxis.categories.reduce((width, label) => Math.max(width, measurer.width(label, 14, 0) + 12), 0);
  const legend = model.plots.reduce((width, plot) => Math.max(width, measurer.width(plot.title, 14, 0) + 44), 0);
  return Math.max(available, category * model.xAxis.categories.length + legend + 80);
}

function mixedColors(model: ChartModel | undefined) {
  if (model?.type !== "xychart" || model.plots.length !== 2 || model.plots[0]!.type === model.plots[1]!.type) return "";
  const probe = h("span", { hidden: true });
  document.body.append(probe);
  const colors = model.plots.map((plot, index) => {
    probe.style.color = `var(--diagram-xy-${plot.type})`;
    return `--pele-series-${index + 1}:${getComputedStyle(probe).color}`;
  }).join(";");
  probe.remove();
  return colors;
}

function temporalColors(type: string) {
  const probe = h("span", { hidden: true });
  probe.style.color = "var(--diagram-series-1)";
  document.body.append(probe);
  let colors = `--pele-accent:${getComputedStyle(probe).color}`;
  if (type === "venn") {
    probe.style.color = "var(--diagram-series-5)";
    colors += `;--pele-series-1:${getComputedStyle(probe).color}`;
  }
  probe.remove();
  return colors;
}

function picture(pele: Pele, source: string, width: number, style: string): Drawing | null {
  let result: ReturnType<Pele["render"]>;
  let model: ChartModel | undefined, numeric = false;
  try {
    numeric = document.documentElement.hasAttribute("data-muse") && charts.has(pele.detectType(source) ?? "");
    let font: ReturnType<typeof chartFont> | undefined;
    if (numeric) {
      model = pele.parse(source) as ChartModel;
      const issue = chartIssue(model);
      if (issue) return { issue };
      font = chartFont();
      if (!font) return { issue: "chartUnavailable" };
      const minimum = Math.ceil(chartWidth(model, font.measurer, 0));
      if (minimum > 4000) return { issue: "chartUnavailable" };
      width = Math.max(width, minimum);
      if (model.type === "quadrantChart" || model.type === "xychart") width = Math.min(width, 4000);
      if (model.type === "xychart" && width > 700) model = pele.parse(source, { config: { xyChart: { width } } }) as ChartModel;
      if (model.type === "quadrantChart" && width > 500) model = pele.parse(source, { config: { quadrantChart: { chartWidth: width } } }) as ChartModel;
    }
    result = pele.render(model ?? source, { maxWidth: width, links: false, images: false, ...font });
  } catch (error) {
    if (!numeric) return null;
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    return { issue: ["syntax", "semantic", "limit", "unsupported-diagram"].includes(String(code)) ? "chartInvalidData" : "chartUnavailable" };
  }
  if (typeof result.svg !== "string" || typeof result.width !== "number" || typeof result.height !== "number"
    || !Number.isFinite(result.width) || !Number.isFinite(result.height) || !(result.width > 0) || !(result.height > 0)) return numeric ? { issue: "chartUnavailable" } : null;
  const parsed = new DOMParser().parseFromString(result.svg, "image/svg+xml").documentElement;
  if (!(parsed instanceof SVGSVGElement) || parsed.querySelector("parsererror")) return numeric ? { issue: "chartUnavailable" } : null;
  const text = (attribute: string) => (parsed.getAttribute(attribute) ?? "").split(/\s+/).map(id => id && parsed.ownerDocument.getElementById(id)?.textContent?.trim()).filter(Boolean).join(" ");
  parsed.style.cssText += `;${style}`;
  if (document.documentElement.hasAttribute("data-muse") && charts.has(String(result.type))) {
    parsed.style.cssText += `;${chartColors()};${temporal.has(String(result.type)) ? temporalColors(String(result.type)) : mixedColors(model)}`;
    if (work.has(String(result.type)) || relationships.has(String(result.type)) || diagrams.has(String(result.type))) parsed.style.setProperty("--pele-border", "var(--pele-line)");
    if (result.type === "swimlane" || result.type === "cynefin") parsed.style.setProperty("--pele-muted", "var(--pele-fg)");
  }
  return { src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(parsed))}`,
    width: Math.round(result.width), height: Math.round(result.height), label: [text("aria-labelledby"), text("aria-describedby")].filter(Boolean).join(". ") || source,
    type: String(result.type), range: model?.type === "radar" ? rangeOf(model) : undefined };
}

function figure(id: string, diagram: Diagram) {
  const range = diagram.range ? t("chartRange", { min: diagram.range[0], max: diagram.range[1] }) : "";
  const button = h("button", { type: "button", className: "diagram", "data-mermaid": id, "data-testid": "diagram", "aria-label": t("openDiagram"), title: t("openDiagram"),
    "data-numeric": document.documentElement.hasAttribute("data-muse") && charts.has(diagram.type) ? "true" : null,
    "aria-describedby": `diagram-${id}`, onclick: (event: Event) => openDiagram(event.currentTarget as HTMLElement) },
    h("img", { src: diagram.src, alt: "", width: diagram.width, height: diagram.height, draggable: "false" }),
    h("span", { className: "visually-hidden", id: `diagram-${id}`, "data-testid": "diagram-description" }, [diagram.label, range].filter(Boolean).join(". ")));
  if (!document.documentElement.hasAttribute("data-muse")) return button;
  return h("div", { className: "diagram-content" }, button,
    range ? h("p", { className: "diagram-range", "data-testid": "diagram-range" }, range) : null,
    h("details", { className: "diagram-source" }, h("summary", { "data-testid": "diagram-inline-source" }, t("showCode")),
      h("pre", { tabindex: "0", "aria-label": t("showCode"), "data-testid": "diagram-inline-code" }, h("code", {}, sources.get(id) ?? ""))));
}

function rejected(id: string, issue: ChartIssue, block?: HTMLElement) {
  if (!block) {
    const copy = h("button", { type: "button", className: "copy", "aria-label": t("copyCode"), title: t("copyCode"), "data-testid": "copy-code" }, icon("copy", 16));
    copy.addEventListener("click", () => copyText(copy, sources.get(id) ?? ""));
    block = codeBlock(sources.get(id) ?? "", "mermaid", copy, false);
  }
  block.dataset.mermaid = id;
  if (!block.querySelector('[data-testid="diagram-error"]'))
    block.prepend(h("p", { className: "diagram-notice", role: issue === "chartInvalidData" || issue === "chartUnavailable" ? "alert" : "status", "data-testid": "diagram-error" }, t(issue)));
  const pre = block.querySelector("pre");
  pre?.setAttribute("tabindex", "0");
  pre?.setAttribute("data-testid", "diagram-fallback-source");
  pre?.setAttribute("aria-label", t("showCode"));
  return block;
}

function place(id: string) {
  let changed = false;
  for (const element of document.querySelectorAll<HTMLElement>(`[data-mermaid="${id}"]`)) {
    const diagram = drawn.get(keyOf(id, element));
    if (!diagram) continue;
    if ("issue" in diagram) {
      if (!element.querySelector('[data-testid="diagram-error"]') || !element.matches(".code-block")) {
        const previous = element.closest(".diagram-content") ?? element, focused = previous.contains(document.activeElement);
        const next = rejected(id, diagram.issue, element.matches(".code-block") ? element : undefined);
        if (next !== element) previous.replaceWith(next);
        if (focused && next !== element) next.querySelector<HTMLElement>("pre")?.focus({ preventScroll: true });
        changed = true;
      }
      continue;
    }
    if (element.querySelector("img")?.getAttribute("src") === diagram.src) continue;
    const previous = element.closest(".diagram-content") ?? element;
    const focused = previous.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.testid : undefined;
    const expanded = previous.querySelector("details")?.open;
    const next = figure(id, diagram);
    previous.replaceWith(next);
    if (expanded && next.querySelector("details")) next.querySelector("details")!.open = true;
    if (focused && document.documentElement.hasAttribute("data-muse"))
      (next.matches(`[data-testid="${focused}"]`) ? next : next.querySelector<HTMLElement>(`[data-testid="${focused}"]`) ?? next.querySelector<HTMLElement>(".diagram"))?.focus({ preventScroll: true });
    changed = true;
  }
  if (changed) document.dispatchEvent(new Event("content-change"));
}

function refresh(id: string) {
  for (const container of containers) if (!container.isConnected) { resize.unobserve(container); containers.delete(container); }
  const keys = new Set<string>();
  for (const element of document.querySelectorAll<HTMLElement>(`[data-mermaid="${id}"]`)) {
    const container = document.documentElement.hasAttribute("data-muse") ? element.closest(".markdown") : null;
    if (container && !containers.has(container)) { containers.add(container); resize.observe(container); }
    keys.add(keyOf(id, element));
  }
  for (const key of keys) if (!drawn.has(key)) void draw(id, key);
  place(id);
}

async function draw(id: string, key: string) {
  if (drawing.has(key) || drawn.has(key)) return;
  drawing.add(key);
  const element = [...document.querySelectorAll<HTMLElement>(`[data-mermaid="${id}"]`)].find(element => keyOf(id, element) === key);
  const width = document.documentElement.hasAttribute("data-muse") ? widthOf(element) : Math.round(element?.getBoundingClientRect().width || Math.min(innerWidth - 32, 700));
  try {
    const pele = await load();
    if (document.documentElement.hasAttribute("data-muse")) await document.fonts.ready;
    drawn.set(key, picture(pele, sources.get(id)!, width, key.slice(0, key.indexOf("\n"))));
  } catch {
    if (!document.documentElement.hasAttribute("data-muse")) return;
    drawn.set(key, { issue: "chartUnavailable" });
  } finally {
    drawing.delete(key);
  }
  place(id);
}

function retheme() {
  palette = undefined;
  chartPalette = undefined;
  const shown = new Set([...document.querySelectorAll<HTMLElement>("[data-mermaid]")].map(element => element.dataset.mermaid!));
  for (const id of shown) refresh(id);
}

matchMedia("(prefers-color-scheme: dark)").addEventListener("change", retheme);
new MutationObserver(retheme).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
document.fonts.addEventListener("loadingdone", () => {
  if (!document.documentElement.hasAttribute("data-muse")) return;
  fontRevision += 1;
  retheme();
});

export const isMermaid = (language: string) => language.trim().toLowerCase() === "mermaid";

export function mermaid(source: string, fallback: HTMLElement) {
  const id = idOf(source);
  if (document.documentElement.hasAttribute("data-muse")) {
    const pre = fallback.querySelector("pre");
    pre?.setAttribute("tabindex", "0");
    pre?.setAttribute("data-testid", "diagram-fallback-source");
    pre?.setAttribute("aria-label", t("showCode"));
  }
  const key = keyOf(id, document.querySelector<HTMLElement>(`[data-mermaid="${id}"]`) ?? undefined);
  const diagram = drawn.get(key);
  queueMicrotask(() => refresh(id));
  if (diagram) return "issue" in diagram ? rejected(id, diagram.issue, fallback) : figure(id, diagram);
  fallback.dataset.mermaid = id;
  return fallback;
}

export function zoomable(stage: HTMLElement, image: HTMLImageElement, width: number, height: number) {
  let fit = 1, scale = 1, touched = 0;
  const pointers = new Map<number, { x: number; y: number }>();
  let pinch: { distance: number; scale: number } | undefined;
  let tap: { time: number; x: number; y: number } | undefined;
  let press: { x: number; y: number; moved: boolean } | undefined;
  const size = () => {
    image.style.width = `${width * fit * scale}px`;
    image.style.height = `${height * fit * scale}px`;
    stage.dataset.zoomed = scale > 1.01 ? "true" : "false";
  };
  const to = (next: number, x: number, y: number) => {
    const before = image.getBoundingClientRect();
    const fx = Math.min(1, Math.max(0, (x - before.left) / before.width)), fy = Math.min(1, Math.max(0, (y - before.top) / before.height));
    scale = Math.min(8, Math.max(1, next));
    size();
    const after = image.getBoundingClientRect();
    stage.scrollLeft += after.left + fx * after.width - x;
    stage.scrollTop += after.top + fy * after.height - y;
  };
  const center = () => { const box = stage.getBoundingClientRect(); return [box.left + box.width / 2, box.top + box.height / 2] as const; };
  const toggle = (x: number, y: number) => to(scale > 1.01 ? 1 : 3, x, y);
  const spread = () => { const [a, b] = [...pointers.values()]; return { distance: Math.hypot(a!.x - b!.x, a!.y - b!.y), x: (a!.x + b!.x) / 2, y: (a!.y + b!.y) / 2 }; };
  new ResizeObserver(() => {
    fit = Math.min(stage.clientWidth / width, stage.clientHeight / height);
    scale = 1;
    size();
  }).observe(stage);
  stage.addEventListener("pointerdown", event => {
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    try { stage.setPointerCapture(event.pointerId); } catch {}
    press = pointers.size === 1 ? { x: event.clientX, y: event.clientY, moved: false } : undefined;
    if (pointers.size === 2) pinch = { distance: spread().distance, scale };
  });
  stage.addEventListener("pointermove", event => {
    const last = pointers.get(event.pointerId);
    if (!last) return;
    if (press && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 8) press.moved = true;
    if (pinch && pointers.size === 2) {
      const before = spread();
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      const after = spread();
      to(pinch.scale * after.distance / pinch.distance, after.x, after.y);
      stage.scrollLeft -= after.x - before.x;
      stage.scrollTop -= after.y - before.y;
      return;
    }
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size === 1 && press?.moved) {
      stage.scrollLeft -= event.clientX - last.x;
      stage.scrollTop -= event.clientY - last.y;
    }
  });
  const release = (event: PointerEvent) => {
    if (!pointers.delete(event.pointerId)) return;
    if (pointers.size < 2) pinch = undefined;
    if (event.type !== "pointerup" || event.pointerType !== "touch" || pointers.size || !press || press.moved) return;
    const now = event.timeStamp;
    if (tap && now - tap.time < 300 && Math.hypot(event.clientX - tap.x, event.clientY - tap.y) < 30) {
      toggle(event.clientX, event.clientY);
      touched = now;
      tap = undefined;
    } else tap = { time: now, x: event.clientX, y: event.clientY };
  };
  stage.addEventListener("pointerup", release);
  stage.addEventListener("pointercancel", release);
  stage.addEventListener("dblclick", event => {
    event.preventDefault();
    if (event.timeStamp - touched > 500) toggle(event.clientX, event.clientY);
  });
  stage.addEventListener("wheel", event => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    to(scale * Math.exp(-event.deltaY * 0.01), event.clientX, event.clientY);
  }, { passive: false });
  let gesture = 1;
  stage.addEventListener("gesturestart", event => { event.preventDefault(); gesture = scale; });
  stage.addEventListener("gesturechange", event => {
    event.preventDefault();
    const change = event as Event & { scale?: number; clientX?: number; clientY?: number };
    if (pinch || typeof change.scale !== "number") return;
    const [x, y] = typeof change.clientX === "number" && typeof change.clientY === "number" ? [change.clientX, change.clientY] : center();
    to(gesture * change.scale, x, y);
  });
  stage.addEventListener("gestureend", event => event.preventDefault());
  stage.addEventListener("keydown", event => {
    const step = event.key === "+" || event.key === "=" ? 1.5 : event.key === "-" ? 1 / 1.5 : event.key === "0" ? 0 : undefined;
    if (step === undefined) return;
    event.preventDefault();
    to(step ? scale * step : 1, ...center());
  });
  return (nextWidth: number, nextHeight: number) => {
    width = nextWidth; height = nextHeight;
    fit = Math.min(stage.clientWidth / width, stage.clientHeight / height);
    scale = 1;
    size();
  };
}

function openDiagram(button: HTMLElement) {
  const image = button.querySelector("img");
  const id = button.dataset.mermaid ?? "", source = sources.get(id);
  if (!image || source === undefined) return;
  const muse = document.documentElement.hasAttribute("data-muse"), route = location.hash;
  const container = button.closest(".file-body") ?? button.closest(".markdown"), scope = container ?? document;
  const owner = button.closest('[data-testid="file-viewer"]');
  const index = [...scope.querySelectorAll(`[data-mermaid="${id}"]`)].indexOf(button);
  if (muse) button.focus({ preventScroll: true });
  const view = sheet({ testID: "diagram-viewer", className: "diagram-viewer", label: t("diagram"), onClose: () => {
    document.removeEventListener("content-change", refresh);
    observer?.disconnect();
    if (muse && !button.isConnected && location.hash === route) {
      const current = scope.querySelectorAll<HTMLElement>(`[data-mermaid="${id}"]`)[index];
      const target = (current?.matches(".diagram") ? current : current?.querySelector<HTMLElement>("pre"))
        ?? (owner?.isConnected ? owner.querySelector<HTMLElement>('[data-testid="file-close"]') : document.querySelector<HTMLElement>('[data-testid="composer-input"]'));
      target?.focus({ preventScroll: true });
    }
  } });
  const description = button.querySelector("[data-testid=diagram-description]")?.textContent || t("diagram");
  const full = h("img", { src: image.getAttribute("src") ?? "", alt: description, draggable: "false", "data-testid": "diagram-image" });
  const stage = h("div", { className: "diagram-stage", tabindex: "0", role: "group", "aria-label": t("diagram"), "data-testid": "diagram-stage" }, full);
  const copy = h("button", { type: "button", className: "icon-button outlined", "aria-label": t("copyCode"), title: t("copyCode"), "data-testid": "diagram-copy" }, icon("copy", 20));
  copy.addEventListener("click", () => copyText(copy, source, 20));
  const code = muse ? h("pre", { className: "diagram-source-code", tabindex: "0", hidden: true, "aria-label": t("showCode"), "data-testid": "diagram-source-code" }, source) : null;
  const toggle = muse ? h("button", { type: "button", className: "button secondary", "aria-expanded": "false", "data-testid": "diagram-source", onclick: () => {
    code!.hidden = !code!.hidden;
    stage.hidden = !code!.hidden;
    toggle!.textContent = t(code!.hidden ? "showCode" : "hideCode");
    toggle!.setAttribute("aria-expanded", String(!code!.hidden));
  } }, t("showCode")) : null;
  view.dialog.append(stage, h("div", { className: "diagram-bar" },
    h("button", { type: "button", className: "icon-button outlined", "aria-label": t("close"), title: t("close"), "data-testid": "diagram-close", onclick: () => view.close() }, icon("close", 20)),
    muse ? h("div", { className: "diagram-tools" }, toggle, copy) : copy));
  if (code) view.dialog.append(code);
  const update = zoomable(stage, full, Number(image.getAttribute("width")), Number(image.getAttribute("height")));
  const refresh = () => {
    const current = scope.querySelectorAll<HTMLImageElement>(`.diagram[data-mermaid="${id}"] img`)[index];
    if (container && !container.isConnected || !current) { view.close(); return; }
    if (full.getAttribute("src") === current.getAttribute("src")) return;
    full.src = current.getAttribute("src") ?? "";
    update(Number(current.getAttribute("width")), Number(current.getAttribute("height")));
  };
  const observer = muse ? new MutationObserver(refresh) : null;
  if (muse) {
    document.addEventListener("content-change", refresh);
    observer!.observe(document.body, { childList: true });
    if (container) observer!.observe(container, { childList: true, subtree: true });
  }
}

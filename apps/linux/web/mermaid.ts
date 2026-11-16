import peleURL from "../../ios/Resources/Pele.bundle/pele.js" with { type: "file" };
import { sheet } from "./client";
import { copyText, h, icon } from "./dom";
import { t } from "./i18n";

type Pele = { render(source: string, options: { maxWidth: number; links: boolean; images: boolean }): { type?: unknown; svg?: unknown; width?: unknown; height?: unknown } };
type Diagram = { src: string; width: number; height: number; label: string; type: string };

const tokens = [["bg", "--bg"], ["fg", "--text"], ["muted", "--text-tertiary"], ["line", "--text-secondary"], ["surface", "--surface"],
  ["surface-alt", "--surface-secondary"], ["border", "--text-tertiary"], ["accent", "--accent"]] as const;
const sources = new Map<string, string>();
const ids = new Map<string, string>();
const drawn = new Map<string, Diagram | null>();
const drawing = new Set<string>();
const numerical = new Set(["pie", "quadrantChart", "xychart", "sankey", "radar", "treemap"]);
let renderer: Promise<Pele> | undefined;
let palette: string | undefined;
let chartPalette: string | undefined;
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
  return `${colors()}\n${document.documentElement.hasAttribute("data-muse") ? `${widthOf(element)}\n` : ""}${sources.get(id)}`;
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

function picture(pele: Pele, source: string, width: number, style: string): Diagram | null {
  let result: ReturnType<Pele["render"]>;
  try { result = pele.render(source, { maxWidth: width, links: false, images: false }); } catch { return null; }
  if (typeof result.svg !== "string" || typeof result.width !== "number" || typeof result.height !== "number"
    || !Number.isFinite(result.width) || !Number.isFinite(result.height) || !(result.width > 0) || !(result.height > 0)) return null;
  const parsed = new DOMParser().parseFromString(result.svg, "image/svg+xml").documentElement;
  if (!(parsed instanceof SVGSVGElement) || parsed.querySelector("parsererror")) return null;
  const text = (attribute: string) => (parsed.getAttribute(attribute) ?? "").split(/\s+/).map(id => id && parsed.ownerDocument.getElementById(id)?.textContent?.trim()).filter(Boolean).join(" ");
  parsed.style.cssText += `;${style}`;
  if (document.documentElement.hasAttribute("data-muse") && numerical.has(String(result.type)))
    parsed.style.cssText += `;${chartColors()}`;
  return { src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(parsed))}`,
    width: Math.round(result.width), height: Math.round(result.height), label: [text("aria-labelledby"), text("aria-describedby")].filter(Boolean).join(". ") || source, type: String(result.type) };
}

function figure(id: string, diagram: Diagram) {
  const button = h("button", { type: "button", className: "diagram", "data-mermaid": id, "data-testid": "diagram", "aria-label": t("openDiagram"), title: t("openDiagram"),
    "data-numeric": document.documentElement.hasAttribute("data-muse") && numerical.has(diagram.type) ? "true" : null,
    "aria-describedby": `diagram-${id}`, onclick: (event: Event) => openDiagram(event.currentTarget as HTMLElement) },
    h("img", { src: diagram.src, alt: "", width: diagram.width, height: diagram.height, draggable: "false" }),
    h("span", { className: "visually-hidden", id: `diagram-${id}`, "data-testid": "diagram-description" }, diagram.label));
  if (!document.documentElement.hasAttribute("data-muse")) return button;
  return h("div", { className: "diagram-content" }, button,
    h("details", { className: "diagram-source" }, h("summary", { "data-testid": "diagram-inline-source" }, t("showCode")),
      h("pre", { tabindex: "0", "aria-label": t("showCode"), "data-testid": "diagram-inline-code" }, h("code", {}, sources.get(id) ?? ""))));
}

function place(id: string) {
  let changed = false;
  for (const element of document.querySelectorAll<HTMLElement>(`[data-mermaid="${id}"]`)) {
    const diagram = drawn.get(keyOf(id, element));
    if (!diagram || element.querySelector("img")?.getAttribute("src") === diagram.src) continue;
    const previous = element.closest(".diagram-content") ?? element;
    const focused = previous.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.testid : undefined;
    const expanded = previous.querySelector("details")?.open;
    const next = figure(id, diagram);
    previous.replaceWith(next);
    if (expanded && next.querySelector("details")) next.querySelector("details")!.open = true;
    if (focused && document.documentElement.hasAttribute("data-muse"))
      (next.matches(`[data-testid="${focused}"]`) ? next : next.querySelector<HTMLElement>(`[data-testid="${focused}"]`))?.focus({ preventScroll: true });
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
    drawn.set(key, picture(await load(), sources.get(id)!, width, key.slice(0, key.indexOf("\n"))));
  } catch {
    return;
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

export const isMermaid = (language: string) => language.trim().toLowerCase() === "mermaid";

export function mermaid(source: string, fallback: HTMLElement) {
  const id = idOf(source);
  const key = keyOf(id, document.querySelector<HTMLElement>(`[data-mermaid="${id}"]`) ?? undefined);
  const diagram = drawn.get(key);
  queueMicrotask(() => refresh(id));
  if (diagram) return figure(id, diagram);
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
      const target = scope.querySelectorAll<HTMLElement>(`.diagram[data-mermaid="${id}"]`)[index]
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

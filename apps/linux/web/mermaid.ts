import peleURL from "../../ios/Resources/Pele.bundle/pele.js" with { type: "file" };
import { sheet } from "./client";
import { copyText, h, icon } from "./dom";
import { t } from "./i18n";

type Pele = { render(source: string, options: { maxWidth: number; links: boolean; images: boolean }): { svg?: unknown; width?: unknown; height?: unknown } };
type Diagram = { src: string; width: number; height: number; label: string };

const tokens = [["bg", "--bg"], ["fg", "--text"], ["muted", "--text-tertiary"], ["line", "--text-secondary"], ["surface", "--surface"],
  ["surface-alt", "--surface-secondary"], ["border", "--text-tertiary"], ["accent", "--accent"]] as const;
const sources = new Map<string, string>();
const ids = new Map<string, string>();
const drawn = new Map<string, Diagram | null>();
const drawing = new Set<string>();
let renderer: Promise<Pele> | undefined;
let palette: string | undefined;

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
  const root = typeof result.svg === "string" ? /<svg\b[^>]*>/.exec(result.svg) : null;
  if (!root || typeof result.width !== "number" || typeof result.height !== "number" || !(result.width > 0) || !(result.height > 0)) return null;
  const svg = result.svg as string, end = root.index + root[0].length;
  const parsed = new DOMParser().parseFromString(svg, "image/svg+xml").documentElement;
  const text = (attribute: string) => (parsed.getAttribute(attribute) ?? "").split(/\s+/).map(id => id && parsed.ownerDocument.getElementById(id)?.textContent?.trim()).filter(Boolean).join(" ");
  return { src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(`${svg.slice(0, end)}<style>.pele{${style}}</style>${svg.slice(end)}`)}`,
    width: Math.round(result.width), height: Math.round(result.height), label: [text("aria-labelledby"), text("aria-describedby")].filter(Boolean).join(". ") || source };
}

function figure(id: string, diagram: Diagram) {
  return h("button", { type: "button", className: "diagram", "data-mermaid": id, "data-testid": "diagram", "aria-label": t("openDiagram"), title: t("openDiagram"),
    "aria-describedby": `diagram-${id}`, onclick: (event: Event) => openDiagram(event.currentTarget as HTMLElement) },
    h("img", { src: diagram.src, alt: "", width: diagram.width, height: diagram.height, draggable: "false" }),
    h("span", { className: "visually-hidden", id: `diagram-${id}`, "data-testid": "diagram-description" }, diagram.label));
}

function place(id: string) {
  const diagram = drawn.get(`${colors()}\n${sources.get(id)}`);
  const shown = diagram ? document.querySelectorAll<HTMLElement>(`[data-mermaid="${id}"]`) : [];
  for (const element of shown) element.replaceWith(figure(id, diagram!));
  if (shown.length) document.dispatchEvent(new Event("content-change"));
}

async function draw(id: string, key: string) {
  if (drawing.has(key) || drawn.has(key)) return;
  drawing.add(key);
  const shown = document.querySelector<HTMLElement>(`[data-mermaid="${id}"]`)?.getBoundingClientRect().width;
  const width = Math.round(shown || Math.min(innerWidth - 32, 700));
  try {
    drawn.set(key, picture(await load(), sources.get(id)!, width, key.slice(0, key.indexOf("\n"))));
  } catch {
    return;
  } finally {
    drawing.delete(key);
  }
  if (key === `${colors()}\n${sources.get(id)}`) place(id);
}

function retheme() {
  palette = undefined;
  const shown = new Set([...document.querySelectorAll<HTMLElement>("[data-mermaid]")].map(element => element.dataset.mermaid!));
  for (const id of shown) {
    const key = `${colors()}\n${sources.get(id)}`;
    if (drawn.has(key)) place(id); else void draw(id, key);
  }
}

matchMedia("(prefers-color-scheme: dark)").addEventListener("change", retheme);
new MutationObserver(retheme).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

export const isMermaid = (language: string) => language.trim().toLowerCase() === "mermaid";

export function mermaid(source: string, fallback: HTMLElement) {
  const id = idOf(source);
  const key = `${colors()}\n${source}`;
  const diagram = drawn.get(key);
  if (diagram) return figure(id, diagram);
  fallback.dataset.mermaid = id;
  if (diagram === undefined) queueMicrotask(() => void draw(id, key));
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
}

function openDiagram(button: HTMLElement) {
  const image = button.querySelector("img");
  const source = sources.get(button.dataset.mermaid ?? "");
  if (!image || source === undefined) return;
  const view = sheet({ testID: "diagram-viewer", className: "diagram-viewer", label: t("diagram") });
  const description = button.querySelector("[data-testid=diagram-description]")?.textContent || t("diagram");
  const full = h("img", { src: image.getAttribute("src") ?? "", alt: description, draggable: "false", "data-testid": "diagram-image" });
  const stage = h("div", { className: "diagram-stage", tabindex: "0", role: "group", "aria-label": t("diagram"), "data-testid": "diagram-stage" }, full);
  const copy = h("button", { type: "button", className: "icon-button outlined", "aria-label": t("copyCode"), title: t("copyCode"), "data-testid": "diagram-copy" }, icon("copy", 20));
  copy.addEventListener("click", () => copyText(copy, source, 20));
  view.dialog.append(stage, h("div", { className: "diagram-bar" },
    h("button", { type: "button", className: "icon-button outlined", "aria-label": t("close"), title: t("close"), "data-testid": "diagram-close", onclick: () => view.close() }, icon("close", 20)),
    copy));
  zoomable(stage, full, Number(image.getAttribute("width")), Number(image.getAttribute("height")));
}

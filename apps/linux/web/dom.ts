type Child = Node | string | null | undefined | false;
type Props = Record<string, string | number | boolean | EventListener | null | undefined>;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: (Child | Child[])[]): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key.startsWith("on") && typeof value === "function") element.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === "className") element.className = String(value);
    else if (key === "value" && "value" in element) (element as HTMLInputElement).value = String(value);
    else if (value === true) element.setAttribute(key, "");
    else element.setAttribute(key, String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    element.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return element;
}

const paths: Record<string, string> = {
  plus: "M12 5v14M5 12h14",
  user: "M12 12a4 4 0 100-8 4 4 0 000 8zM4.5 20a7.5 7.5 0 0115 0",
  info: "M12 21a9 9 0 100-18 9 9 0 000 18zM12 11v5M12 7.5v.5",
  mic: "M12 15a3 3 0 003-3V6a3 3 0 00-6 0v6a3 3 0 003 3zM18.5 11a6.5 6.5 0 01-13 0M12 17.5V21",
  speaker: "M4 9.5v5h4l5 4V5.5l-5 4H4zM16.5 9a4 4 0 010 6M19 6.5a7.5 7.5 0 010 11",
  image: "M5 4h14a1 1 0 011 1v14a1 1 0 01-1 1H5a1 1 0 01-1-1V5a1 1 0 011-1zM4 16l4.5-4.5 4 4 3-3L20 16M15.5 9a1 1 0 100-2 1 1 0 000 2z",
  compose: "M4 20h4L19 9l-4-4L4 16v4zM14 6l4 4",
  back: "M15 5l-7 7 7 7",
  send: "M12 19V5M5 12l7-7 7 7",
  stop: "M7 7h10v10H7z",
  clip: "M16.5 6.5l-7.8 7.8a2.2 2.2 0 003.1 3.1l7.8-7.8a4 4 0 00-5.7-5.7l-7.8 7.8a5.8 5.8 0 008.2 8.2l6.4-6.4",
  folder: "M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z",
  file: "M7 3h7l5 5v13H7a2 2 0 01-2-2V5a2 2 0 012-2zM14 3v5h5",
  gear: "M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.6 1.6 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.6 1.6 0 00-1.8-.3 1.6 1.6 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.6 1.6 0 00-1-1.5 1.6 1.6 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.6 1.6 0 00.3-1.8 1.6 1.6 0 00-1.5-1H3a2 2 0 110-4h.1a1.6 1.6 0 001.5-1 1.6 1.6 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.6 1.6 0 001.8.3H9a1.6 1.6 0 001-1.5V3a2 2 0 114 0v.1a1.6 1.6 0 001 1.5 1.6 1.6 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.6 1.6 0 00-.3 1.8V9a1.6 1.6 0 001.5 1H21a2 2 0 110 4h-.1a1.6 1.6 0 00-1.5 1z",
  trash: "M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3",
  download: "M12 4v12M6 11l6 6 6-6M5 20h14",
  check: "M5 12l5 5 9-10",
  close: "M6 6l12 12M18 6L6 18",
  chevron: "M9 6l6 6-6 6",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  upload: "M12 20V8M6 13l6-6 6 6M5 4h14",
  sidebar: "M4 5h16v14H4zM9 5v14",
  spark: "M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z",
  globe: "M12 21a9 9 0 100-18 9 9 0 000 18zM3.6 9h16.8M3.6 15h16.8M12 3a14 14 0 010 18M12 3a14 14 0 000 18",
  cube: "M12 3l8 4.5v9L12 21l-8-4.5v-9zM4 7.5l8 4.5 8-4.5M12 12v9",
  host: "M5 4h14a1 1 0 011 1v5a1 1 0 01-1 1H5a1 1 0 01-1-1V5a1 1 0 011-1zM5 13h14a1 1 0 011 1v5a1 1 0 01-1 1H5a1 1 0 01-1-1v-5a1 1 0 011-1zM8 7.5h.01M8 16.5h.01",
  forward: "M9 5l7 7-7 7",
  reload: "M20 12a8 8 0 11-2.3-5.7M20 4v5h-5",
  keyboard: "M3 7a2 2 0 012-2h14a2 2 0 012 2v10a2 2 0 01-2 2H5a2 2 0 01-2-2zM7 9h.01M11 9h.01M15 9h.01M7 13h.01M17 13h.01M8 16h8",
  shield: "M12 3l8 3v6c0 4.4-3.4 8.3-8 9-4.6-.7-8-4.6-8-9V6z",
  key: "M15 8a4 4 0 11-5.7 3.6L3 18v3h3v-2h2v-2h2l2.4-2.4A4 4 0 0115 8zM16 7h.01",
  plug: "M9 3v5M15 3v5M6 8h12v3a6 6 0 01-12 0zM12 17v4",
  book: "M5 4h9a3 3 0 013 3v13H8a3 3 0 01-3-3zM5 17a3 3 0 013-3h9",
  clock: "M12 21a9 9 0 100-18 9 9 0 000 18zM12 7v5l3 2",
  play: "M8 5v14l11-7z",
  pause: "M8 5v14M16 5v14",
  enter: "M20 5v7a3 3 0 01-3 3H5M9 11l-4 4 4 4",
  erase: "M21 5H9l-6 7 6 7h12zM12 9l6 6M18 9l-6 6",
  down: "M12 5v14M6 13l6 6 6-6",
  copy: "M9 9h10v10a2 2 0 01-2 2H11a2 2 0 01-2-2zM15 9V5a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2h4",
  menu: "M4 9h16M4 15h10",
  expand: "M6 9l6 6 6-6",
  pencil: "M13 5l6 6M4 20l4.5-1 10-10a2.1 2.1 0 00-3-3l-10 10z",
  warning: "M12 9v4M12 17h.01M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z",
  search: "M11 18a7 7 0 100-14 7 7 0 000 14zM20 20l-3.5-3.5",
  camera: "M4 8.5A1.5 1.5 0 015.5 7h2.3l1.5-2h5.4l1.5 2h2.3A1.5 1.5 0 0120 8.5v9a1.5 1.5 0 01-1.5 1.5h-13A1.5 1.5 0 014 17.5zM12 16a3.2 3.2 0 100-6.4 3.2 3.2 0 000 6.4z",
  branch: "M6 3v12M18 9a3 3 0 100-6 3 3 0 000 6zM6 21a3 3 0 100-6 3 3 0 000 6zM18 9a9 9 0 01-9 9",
  share: "M4 12v7a2 2 0 002 2h12a2 2 0 002-2v-7M16 6l-4-4-4 4M12 2v13",
  temporary: "M4.521 15.166a.665.665 0 0 0-1.24-.459l-.048.126a14 14 0 0 1-.372 1.196l-.148.4a.666.666 0 0 0 .661.902l.405-.03a14.5 14.5 0 0 0 2.455-.425c.613.303 1.27.534 1.96.682a.665.665 0 1 0 .279-1.3 7 7 0 0 1-1.85-.676.67.67 0 0 0-.37-.077l-.125.023q-.883.25-1.822.375.047-.147.092-.293zM15.8 14.537a.665.665 0 0 0-.833-.107l-.107.083a6.95 6.95 0 0 1-3.333 1.744.665.665 0 0 0 .279 1.301 8.3 8.3 0 0 0 3.765-1.893l.204-.188a.665.665 0 0 0 .025-.94M2.238 7.59a7.4 7.4 0 0 0-.092 4.533l.092.288a.665.665 0 0 0 1.288-.302l-.03-.132A6 6 0 0 1 3.164 10c0-.69.116-1.355.33-1.977a.665.665 0 0 0-1.257-.434M16.917 12.823a.665.665 0 0 0 .845-.412 7.388 7.388 0 0 0 0-4.821.665.665 0 1 0-1.257.433c.214.622.33 1.287.33 1.977s-.116 1.355-.33 1.977a.665.665 0 0 0 .412.846M8.983 2.953a.665.665 0 0 0-.789-.511A8.3 8.3 0 0 0 4.43 4.335l-.204.188a.665.665 0 0 0 .808 1.047l.107-.082a6.95 6.95 0 0 1 3.333-1.745.665.665 0 0 0 .51-.79M15.571 4.335a8.3 8.3 0 0 0-3.765-1.893.665.665 0 0 0-.279 1.3A6.97 6.97 0 0 1 14.69 5.33l.17.158.107.082a.665.665 0 0 0 .896-.945l-.088-.102z",
  temporaryOn: "M11.73 7.352a.665.665 0 0 1 1.124.713l-3.175 5a.665.665 0 0 1-1.053.092l-1.825-2-.081-.109a.665.665 0 0 1 .963-.878l.1.09 1.238 1.357zM4.521 15.166a.665.665 0 0 0-1.24-.459l-.048.126a14 14 0 0 1-.372 1.196l-.148.4a.666.666 0 0 0 .661.902l.405-.03a14.5 14.5 0 0 0 2.455-.425c.613.303 1.27.534 1.96.682a.665.665 0 1 0 .279-1.3 7 7 0 0 1-1.85-.676.67.67 0 0 0-.37-.077l-.125.023q-.883.25-1.822.375.047-.147.092-.293zM15.8 14.537a.665.665 0 0 0-.833-.107l-.107.083a6.95 6.95 0 0 1-3.333 1.744.665.665 0 0 0 .279 1.301 8.3 8.3 0 0 0 3.765-1.893l.204-.188a.665.665 0 0 0 .025-.94M2.238 7.59a7.4 7.4 0 0 0-.092 4.533l.092.288a.665.665 0 0 0 1.288-.302l-.03-.132A6 6 0 0 1 3.164 10c0-.69.116-1.355.33-1.977a.665.665 0 0 0-1.257-.434M16.917 12.823a.665.665 0 0 0 .845-.412 7.388 7.388 0 0 0 0-4.821.665.665 0 1 0-1.257.433c.214.622.33 1.287.33 1.977s-.116 1.355-.33 1.977a.665.665 0 0 0 .412.846M8.983 2.953a.665.665 0 0 0-.789-.511A8.3 8.3 0 0 0 4.43 4.335l-.204.188a.665.665 0 0 0 .808 1.047l.107-.082a6.95 6.95 0 0 1 3.333-1.745.665.665 0 0 0 .51-.79M15.571 4.335a8.3 8.3 0 0 0-3.765-1.893.665.665 0 0 0-.279 1.3A6.97 6.97 0 0 1 14.69 5.33l.17.158.107.082a.665.665 0 0 0 .896-.945l-.088-.102z",
};
const filled = new Set(["temporary", "temporaryOn"]);

export function icon(name: keyof typeof paths, size = 20) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", paths[name]!);
  svg.append(path);
  if (filled.has(name)) {
    svg.setAttribute("viewBox", "0 0 20 20");
    svg.setAttribute("fill", "currentColor");
    return svg;
  }
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", name === "more" ? "3" : "1.9");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  return svg;
}

export type IconName = keyof typeof paths;

const oxGeneration = 0b0110_0110_1111_1001;
const loaderGenerations = (() => {
  const alive = (generation: number, index: number) => (generation >> ((index + 16) % 16)) & 1;
  const next = (generation: number) => Array.from({ length: 16 }, (_, index) =>
    (75 >> (alive(generation, index - 1) << 2 | alive(generation, index) << 1 | alive(generation, index + 1))) & 1 ? 1 << index : 0).reduce((sum, bit) => sum | bit, 0);
  const generations = [oxGeneration];
  for (let generation = next(oxGeneration); generation !== oxGeneration && generations.length < 256; generation = next(generation)) generations.push(generation);
  return generations;
})();

function loaderStyle() {
  if (document.getElementById("ox-loader-style")) return;
  const frames = [...loaderGenerations, oxGeneration];
  const rules = Array.from({ length: 16 }, (_, cell) => {
    const steps = frames.map((generation, step) => {
      const opacity = (generation >> cell) & 1 ? 1 : generation === oxGeneration ? 0 : 0.08;
      return `${(step / loaderGenerations.length * 100).toFixed(3)}%{opacity:${opacity};transform:scale(${(0.72 + opacity * 0.28).toFixed(3)})}`;
    });
    return `@keyframes ox-cell-${cell}{${steps.join("")}}.ox-loader i:nth-child(${cell + 1}){animation-name:ox-cell-${cell}}`;
  });
  document.head.append(h("style", { id: "ox-loader-style" }, `.ox-loader i{animation-duration:${(loaderGenerations.length * 0.15).toFixed(2)}s}${rules.join("")}`));
}

export function loader(size = 16) {
  loaderStyle();
  return h("span", { className: "ox-loader", "aria-hidden": "true", style: `--size:${size}px` }, ...Array.from({ length: 16 }, () => h("i")));
}

export function copyText(button: HTMLElement, text: string, size = 16) {
  void navigator.clipboard?.writeText(text).then(() => {
    button.replaceChildren(icon("check", size));
    button.dataset.copied = "true";
    setTimeout(() => { button.replaceChildren(icon("copy", size)); delete button.dataset.copied; }, 1_500);
  }, () => {});
}

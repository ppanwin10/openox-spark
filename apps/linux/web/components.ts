import { h } from "./dom";

// Components the agent can place in a reply as a fenced block (```ox-<name>), filled from data the Host has checked.
type Card = { t: string; u: string; h: string; s?: string; v?: string; w?: string; b?: string; n?: string; i?: string; a?: string; o?: string; r?: string; x?: 1 };
type Cards = { l: "list" | "grid" | "carousel"; g?: string; items: Card[] };

const text = (value: unknown, max: number) => typeof value === "string" && value.length > 0 && value.length <= max ? value : undefined;
const web = (value: unknown) => {
  if (typeof value !== "string") return undefined;
  try { const url = new URL(value); return /^https?:$/.test(url.protocol) && !url.username && !url.password ? url.href : undefined; } catch { return undefined; }
};

function parseCards(source: string): Cards | undefined {
  let data: unknown;
  try { data = JSON.parse(source); } catch { return undefined; }
  if (!data || typeof data !== "object") return undefined;
  const { l, g, items } = data as Record<string, unknown>;
  if (l !== "list" && l !== "grid" && l !== "carousel" || !Array.isArray(items) || !items.length || items.length > 8) return undefined;
  const cards: Card[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== "object") return undefined;
    const item = raw as Record<string, unknown>, t = text(item.t, 120), u = web(item.u), host = text(item.h, 120);
    if (!t || !u || !host) return undefined;
    cards.push({ t, u, h: host, s: text(item.s, 80), v: text(item.v, 24), w: text(item.w, 16), b: text(item.b, 24), n: text(item.n, 120), i: web(item.i),
      a: text(item.a, 120), o: text(item.o, 80), r: text(item.r, 24), ...item.x === 1 ? { x: 1 } : {} });
  }
  return { l, g: text(g, 60), items: cards };
}

function card(item: Card, thirdParty: string, mapLabel: string) {
  const image = item.i ? h("img", { className: "ox-card-image", src: `/api/product-image?u=${encodeURIComponent(item.i)}`, alt: "", loading: "lazy", referrerpolicy: "no-referrer" }) : null;
  image?.addEventListener("error", () => { image.closest(".ox-card")?.classList.remove("with-image"); image.parentElement?.remove(); }, { once: true });
  return h("a", { href: item.u, target: "_blank", rel: "noopener noreferrer", className: `ox-card${image ? " with-image" : ""}`, "data-testid": "ox-card" },
    image ? h("span", { className: "ox-card-media" }, image) : null,
    h("span", { className: "ox-card-body" },
      item.r ? h("span", { className: "ox-card-head" }, h("span", { className: "ox-card-title" }, item.t), h("span", { className: "ox-card-rating" }, item.r)) : h("span", { className: "ox-card-title" }, item.t),
      item.s ? h("span", { className: "ox-card-subtitle" }, item.s) : null,
      item.v || item.w || item.b ? h("span", { className: "ox-card-value" }, item.v ? h("strong", {}, item.v) : null, item.w ? h("s", {}, item.w) : null,
        item.b ? h("span", { className: "ox-card-badge" }, item.b) : null) : null,
      item.o ? h("span", { className: "ox-card-hours" }, item.o) : null,
      item.a ? h("span", { className: "ox-card-address" }, item.a, " ", h("a", { className: "ox-card-map", "data-testid": "ox-card-map", target: "_blank", rel: "noopener noreferrer",
        href: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${item.t}, ${item.a}`)}`, onclick: (event: Event) => event.stopPropagation() }, mapLabel)) : null,
      item.n ? h("span", { className: "ox-card-note" }, item.n) : null,
      h("span", { className: "ox-card-site" }, item.x ? `${item.h} · ${thirdParty}` : item.h)));
}

function parse(source: string) { try { const data = JSON.parse(source); return data && typeof data === "object" ? data as Record<string, unknown> : undefined; } catch { return undefined; } }
type Cited = { u: string; h: string; x?: 1 };
const cited = (raw: Record<string, unknown>): Cited | undefined => { const u = web(raw.u), host = text(raw.h, 120); return u && host ? { u, h: host, ...raw.x === 1 ? { x: 1 } : {} } : undefined; };
const site = (item: Cited, thirdParty: string) => item.x ? `${item.h} · ${thirdParty}` : item.h;

function table(source: string, thirdParty: string) {
  const data = parse(source);
  const columns = Array.isArray(data?.c) ? data.c.map(value => text(value, 30)) : [];
  if (!data || columns.length < 2 || columns.length > 5 || columns.some(value => !value) || !Array.isArray(data.r) || !data.r.length || data.r.length > 8) return null;
  const rows: (Cited & { cells: string[] })[] = [];
  for (const raw of data.r as Record<string, unknown>[]) {
    const ref = raw && typeof raw === "object" ? cited(raw) : undefined, cells = Array.isArray(raw?.cells) ? raw.cells.map(value => typeof value === "string" && value.length <= 80 ? value : undefined) : [];
    if (!ref || cells.length !== columns.length || cells.some(value => value === undefined) || !cells[0]) return null;
    rows.push({ ...ref, cells: cells as string[] });
  }
  const title = text(data.g, 60);
  return h("section", { className: "ox-table", "data-testid": "ox-table", "aria-label": title ?? null },
    title ? h("div", { className: "ox-cards-title" }, title) : null,
    h("div", { className: "ox-table-scroll" }, h("table", {},
      h("thead", {}, h("tr", {}, ...columns.map(column => h("th", { scope: "col" }, column!)))),
      h("tbody", {}, ...rows.map(row => h("tr", {},
        h("td", {}, h("a", { href: row.u, target: "_blank", rel: "noopener noreferrer" }, row.cells[0]!), h("span", { className: "ox-card-site" }, site(row, thirdParty))),
        ...row.cells.slice(1).map(cell => h("td", {}, cell))))))));
}

function timeline(source: string, thirdParty: string) {
  const data = parse(source);
  if (!data || !Array.isArray(data.items) || !data.items.length || data.items.length > 8) return null;
  const items: (Cited & { d: string; t: string; n?: string })[] = [];
  for (const raw of data.items as Record<string, unknown>[]) {
    const ref = raw && typeof raw === "object" ? cited(raw) : undefined, d = text(raw?.d, 30), t = text(raw?.t, 120);
    if (!ref || !d || !t) return null;
    items.push({ ...ref, d, t, n: text(raw.n, 160) });
  }
  const title = text(data.g, 60);
  return h("section", { className: "ox-timeline", "data-testid": "ox-timeline", "aria-label": title ?? null },
    title ? h("div", { className: "ox-cards-title" }, title) : null,
    h("ol", {}, ...items.map(item => h("li", { className: "ox-timeline-item" },
      h("span", { className: "ox-timeline-date" }, item.d),
      h("a", { className: "ox-timeline-title", href: item.u, target: "_blank", rel: "noopener noreferrer" }, item.t),
      item.n ? h("span", { className: "ox-card-note" }, item.n) : null,
      h("span", { className: "ox-card-site" }, site(item, thirdParty))))));
}

export function renderComponent(name: string, source: string, labels: { thirdParty: string; map: string }): HTMLElement | null {
  if (name === "ox-table") return table(source, labels.thirdParty);
  if (name === "ox-timeline") return timeline(source, labels.thirdParty);
  if (name !== "ox-cards") return null;
  const data = parseCards(source);
  if (!data) return null;
  return h("section", { className: `ox-cards ${data.l}`, "data-testid": "ox-cards", "data-layout": data.l, "aria-label": data.g ?? null },
    data.g ? h("div", { className: "ox-cards-title" }, data.g) : null,
    h("div", { className: "ox-cards-items" }, ...data.items.map(item => card(item, labels.thirdParty, labels.map))));
}

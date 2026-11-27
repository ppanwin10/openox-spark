import { h } from "./dom";

// Components the agent can place in a reply as a fenced block (```ox-<name>), filled from data the Host has checked.
type Card = { t: string; u: string; h: string; s?: string; v?: string; w?: string; b?: string; n?: string; i?: string; x?: 1 };
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
    cards.push({ t, u, h: host, s: text(item.s, 80), v: text(item.v, 24), w: text(item.w, 16), b: text(item.b, 24), n: text(item.n, 120), i: web(item.i), ...item.x === 1 ? { x: 1 } : {} });
  }
  return { l, g: text(g, 60), items: cards };
}

function card(item: Card, thirdParty: string) {
  const image = item.i ? h("img", { className: "ox-card-image", src: `/api/product-image?u=${encodeURIComponent(item.i)}`, alt: "", loading: "lazy", referrerpolicy: "no-referrer" }) : null;
  image?.addEventListener("error", () => { image.closest(".ox-card")?.classList.remove("with-image"); image.parentElement?.remove(); }, { once: true });
  return h("a", { href: item.u, target: "_blank", rel: "noopener noreferrer", className: `ox-card${image ? " with-image" : ""}`, "data-testid": "ox-card" },
    image ? h("span", { className: "ox-card-media" }, image) : null,
    h("span", { className: "ox-card-body" },
      item.b ? h("span", { className: "ox-card-badge" }, item.b) : null,
      h("span", { className: "ox-card-title" }, item.t),
      item.s ? h("span", { className: "ox-card-subtitle" }, item.s) : null,
      item.v || item.w ? h("span", { className: "ox-card-value" }, item.v ? h("strong", {}, item.v) : null, item.w ? h("s", {}, item.w) : null) : null,
      item.n ? h("span", { className: "ox-card-note" }, item.n) : null,
      h("span", { className: "ox-card-site" }, item.x ? `${item.h} · ${thirdParty}` : item.h)));
}

export function renderComponent(name: string, source: string, labels: { thirdParty: string }): HTMLElement | null {
  if (name !== "ox-cards") return null;
  const data = parseCards(source);
  if (!data) return null;
  return h("section", { className: `ox-cards ${data.l}`, "data-testid": "ox-cards", "data-layout": data.l, "aria-label": data.g ?? null },
    data.g ? h("div", { className: "ox-cards-title" }, data.g) : null,
    h("div", { className: "ox-cards-items" }, ...data.items.map(item => card(item, labels.thirdParty))));
}

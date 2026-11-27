import type { Space } from "@openox/agent/linux";
import { h, icon } from "./dom";
import { t } from "./i18n";

export type SpaceIcon = Pick<Space, "id" | "name" | "iconPath" | "iconRevision">;

export function spaceIcon(space: SpaceIcon, size: number, defaultSize = size) {
  const fallback = () => icon("globe", defaultSize);
  if (!space.iconPath || !space.iconRevision) return fallback();
  const image = h("img", { className: "space-artwork", alt: "", width: size, height: size, decoding: "async",
    src: `/api/spaces/${encodeURIComponent(space.id)}/icon?v=${encodeURIComponent(space.iconRevision)}` });
  image.addEventListener("error", () => {
    const replacement = h("span", { className: "space-artwork-fallback", title: t("spaceIconMissing") }, fallback());
    image.replaceWith(replacement);
  }, { once: true });
  return image;
}

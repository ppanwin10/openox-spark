import { h } from "./dom";

let dismissActive: (() => void) | undefined;
document.addEventListener("keydown", event => { if (event.key === "Escape") dismissActive?.(); });
document.addEventListener("pointerdown", () => dismissActive?.(), true);
window.addEventListener("resize", () => dismissActive?.());

export function withRailTooltip(rail: HTMLElement, searchShortcut: string) {
  const hint = h("div", { className: "muse-rail-tooltip", role: "tooltip", popover: "manual", id: "muse-rail-hint" });
  rail.append(hint);
  let anchor: HTMLElement | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  const control = (target: EventTarget | null) => target instanceof Element ? target.closest<HTMLElement>(".muse-rail-button:not(:disabled)") : null;
  for (const element of rail.querySelectorAll<HTMLElement>(".muse-rail-button:not(:disabled)")) element.removeAttribute("title");
  const close = () => {
    clearTimeout(timer);
    anchor?.removeAttribute("aria-describedby"); anchor = undefined;
    if (hint.matches(":popover-open")) hint.hidePopover();
    if (dismissActive === close) dismissActive = undefined;
  };
  const leave = () => {
    if (!anchor) return;
    hint.classList.add("leaving"); clearTimeout(timer); timer = setTimeout(close, 150);
  };
  const show = (element: HTMLElement) => {
    const label = element.getAttribute("aria-label");
    if (!label || !element.isConnected) return;
    if (anchor !== element) {
      dismissActive?.(); anchor = element; dismissActive = close;
      hint.replaceChildren(h("span", {}, label));
      if (element.dataset.testid === "muse-search-open") hint.append(h("kbd", {}, searchShortcut));
      element.setAttribute("aria-describedby", hint.id);
    }
    clearTimeout(timer); hint.classList.remove("leaving");
    if (!hint.matches(":popover-open")) hint.showPopover();
    const box = element.getBoundingClientRect();
    hint.style.left = `${Math.max(4, Math.min(box.right + 10, innerWidth - hint.offsetWidth - 4))}px`;
    hint.style.top = `${Math.max(4, Math.min(box.top + (box.height - hint.offsetHeight) / 2, innerHeight - hint.offsetHeight - 4))}px`;
  };
  rail.addEventListener("pointerover", event => {
    if (event.pointerType === "touch" || !matchMedia("(any-hover: hover)").matches) return;
    const element = control(event.target);
    if (element && element !== control(event.relatedTarget)) show(element);
    else if (anchor && event.target instanceof Node && hint.contains(event.target)) show(anchor);
  });
  rail.addEventListener("pointerout", event => {
    if (!anchor || event.relatedTarget instanceof Node && (anchor.contains(event.relatedTarget) || hint.contains(event.relatedTarget))) return;
    leave();
  });
  rail.addEventListener("focusin", event => { const element = control(event.target); if (element?.matches(":focus-visible")) show(element); });
  rail.addEventListener("focusout", event => { if (control(event.target) === anchor) close(); });
  rail.addEventListener("scroll", close, true);
  return rail;
}

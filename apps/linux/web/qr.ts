import { encode } from "uqr";

const namespace = "http://www.w3.org/2000/svg";

export function qrCode(text: string, label: string) {
  const { data } = encode(text, { ecc: "M", border: 2 });
  const svg = document.createElementNS(namespace, "svg");
  svg.setAttribute("viewBox", `0 0 ${data.length} ${data.length}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", label);
  svg.setAttribute("shape-rendering", "crispEdges");
  const path = document.createElementNS(namespace, "path");
  path.setAttribute("d", data.flatMap((row, y) => row.flatMap((dark, x) => dark ? [`M${x} ${y}h1v1h-1z`] : [])).join(""));
  svg.append(path);
  return svg;
}

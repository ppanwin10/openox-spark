import { Type } from "typebox";

const strict = { additionalProperties: false };
const purpose = Type.String({ minLength: 1, maxLength: 80, description: "Short (<10 words) description shown to the user as the step label." });
const target = Type.Object({
  label: Type.String({ minLength: 1, maxLength: 256, description: "The control's label as listed by getPageState (visible text, accessible name or placeholder)." }),
  role: Type.Optional(Type.String({ minLength: 1, maxLength: 40, description: "Optional role or tag, such as button, link, textbox, checkbox or combobox, to narrow matches." })),
  index: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, description: "1-based choice among several visible controls with the same label, in page order." })),
}, strict);
const outcome = Type.Object({ url: Type.String(), title: Type.String(), handedOff: Type.Optional(Type.Literal(true)) }, strict);

export const browserJobContracts = {
  "ox.web.browser.interact": {
    description: "Act on one visible control of Browser's current page within its approved site: click, type text, select an option, press a key or check a box. "
      + "Targets are matched by label (and optional role and index) among visible controls; an ambiguous label fails with the number of matches. "
      + "Never types into password, one-time-code or payment-card fields: hand the page to the user with ox.web.browser.waitForUserInteraction for those. "
      + "Set commits to a short summary (what and how much) whenever the step places an order, pays, books, sends, subscribes, cancels or deletes; the user approves, takes over or denies it. "
      + "The Host also asks before clicks whose label looks like such a step. Returns the resulting page URL and title.",
    inputSchema: Type.Object({
      purpose,
      action: Type.Union([Type.Literal("click"), Type.Literal("type"), Type.Literal("select"), Type.Literal("press"), Type.Literal("check")]),
      target,
      text: Type.Optional(Type.String({ maxLength: 2_000, description: "Text to type (replaces the field's value) for action type." })),
      option: Type.Optional(Type.String({ minLength: 1, maxLength: 256, description: "Visible option label for action select." })),
      key: Type.Optional(Type.String({ minLength: 1, maxLength: 20, description: "Key for action press, such as Enter or Tab." })),
      commits: Type.Optional(Type.String({ minLength: 1, maxLength: 240, description: "Required for consequential steps: what this commits and its amount, e.g. \"Place order: 2 items, $57.97\"." })),
    }, strict),
    outputSchema: outcome,
  },
  "ox.web.browser.readText": {
    description: "Read the visible text of Browser's current page (or a CSS-selected part) within its approved site, bounded to 16,000 characters. Input values are not included.",
    inputSchema: Type.Object({ purpose, selector: Type.Optional(Type.String({ minLength: 1, maxLength: 2_000 })) }, strict),
    outputSchema: Type.Object({ url: Type.String(), title: Type.String(), text: Type.String(), truncated: Type.Boolean() }, strict),
  },
};

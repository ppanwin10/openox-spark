import { expect, test } from "bun:test";
import { preview } from "../../../../../apps/linux/src/notifications";

test("Notification previews read escaped source quotes as plain text", () => {
  const reply = ["公开来源原文", "", "### \\*\\*What is a Carfax report?\\*\\*", "",
    "> - When you shop for a used car on the Carfax website", "> - On a car dealer’s website", "",
    "[www.creditkarma.com](<https://www.creditkarma.com/auto/i/how-to-get-free-carfax-report>)"].join("\n");
  expect(preview(reply)).toBe("公开来源原文 What is a Carfax report? When you shop for a used car on the Carfax website On a car dealer’s website www.creditkarma.com");
  expect(preview("> \\[Learn More.\\](https://example.com/a \"/a\") Regular price $31.85 \\~\\~$49.00\\~\\~ with subscription"))
    .toBe("[Learn More.](https://example.com/a \"/a\") Regular price $31.85 $49.00 with subscription");
  expect(preview("Plain **bold** and _em_ text with a [link](https://example.com).")).toBe("Plain bold and em text with a link.");
});

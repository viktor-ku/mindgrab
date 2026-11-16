import { expect, test } from "bun:test";
import { branchOutline, parseOutline } from "../src/outline-text";
import type { MindMapNode } from "../src/mind-map";

const texts = (entries: ReturnType<typeof parseOutline>): unknown =>
  entries.map((entry) =>
    entry.children.length ? [entry.text, texts(entry.children)] : entry.text,
  );

test("copied ideas paste back exactly, whatever markers or escapes they start with", () => {
  for (const text of [
    "plain",
    "- dash",
    "# heading",
    "> quote",
    "1. numbered",
    "2024. A good year",
    "\\- escaped dash",
    "\\\\- two backslashes",
    "\\1. escaped number",
    "-no space",
  ]) {
    const node: MindMapNode = { id: "a", text, next: [{ id: "b", text }] };
    const pasted = parseOutline(branchOutline(node, () => text));
    expect(texts(pasted)).toEqual([[text, [text]]]);
  }
});

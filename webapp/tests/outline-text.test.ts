import { expect, test } from "bun:test";
import {
  branchEntry,
  branchOutline,
  parseBranchEntries,
  parseOutline,
} from "../src/outline-text";
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

test("rich copies keep notes and colors for one branch or several, and reject malformed data", () => {
  const nodes: MindMapNode[] = [
    {
      id: "a",
      text: "Trip",
      note: "Book **early**",
      color: "blue",
      next: [{ id: "b", text: "Flights", color: "rose-300" }],
    },
    { id: "c", text: "Budget", next: [] },
  ];
  const entries = nodes.map((node) => branchEntry(node, (id) => id));
  // Several branches are stored as a list.
  expect(parseBranchEntries(JSON.stringify(entries))).toEqual(entries);
  // One branch is stored on its own, as earlier versions wrote it.
  expect(parseBranchEntries(JSON.stringify(entries[0]))).toEqual([entries[0]]);
  for (const data of [
    "",
    "not json",
    "[]",
    "null",
    JSON.stringify([entries[0], { text: 1, children: [] }]),
  ])
    expect(parseBranchEntries(data)).toBeUndefined();
});

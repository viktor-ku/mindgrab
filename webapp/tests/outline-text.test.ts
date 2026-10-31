import { expect, test } from "bun:test";
import {
  branchEntry,
  branchOutline,
  parseBranchEntry,
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

test("pasted outlines skip empty items and keep prose that starts with a number", () => {
  expect(
    texts(
      parseOutline("- A\n-\n- \n1. \n[ ] \n2024. great\n1) one\n  - nested"),
    ),
  ).toEqual(["A", "2024. great", ["one", ["nested"]]]);
  expect(texts(parseOutline("# Trip\n- Flights\n## Days\n- Monday"))).toEqual([
    ["Trip", ["Flights", ["Days", ["Monday"]]]],
  ]);
});

test("rich branch data keeps notes and colors and rejects malformed input", () => {
  const node: MindMapNode = {
    id: "a",
    text: "A",
    note: "details",
    color: "rose",
    next: [{ id: "b", text: "B" }],
  };
  const entry = branchEntry(node, (id) => (id === "a" ? "A" : "B"));
  expect(parseBranchEntry(JSON.stringify(entry))).toEqual({
    text: "A",
    note: "details",
    color: "rose",
    children: [{ text: "B", children: [] }],
  });
  for (const bad of [
    "",
    "nope",
    "[]",
    '{"text":1,"children":[]}',
    '{"text":"x"}',
  ])
    expect(parseBranchEntry(bad)).toBeUndefined();
  expect(parseBranchEntry('{"text":"x","color":"neon","children":[]}')).toEqual(
    { text: "x", children: [] },
  );
});

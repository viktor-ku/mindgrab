import { describe, expect, test } from "bun:test";
import type { MindMapNode } from "../src/mind-map";
import { searchNodes } from "../src/search";

const texts = new Map([
  ["a", "Product plan"],
  ["b", "Café launch"],
  ["c", "Replan budget"],
  ["d", ""],
  ["e", "Plans for Q3"],
  ["f", "PLANET"],
]);
const tree: MindMapNode[] = [
  {
    id: "a",
    text: "",
    next: [
      { id: "b", text: "", next: [{ id: "c", text: "" }] },
      { id: "d", text: "", next: [{ id: "e", text: "" }] },
    ],
  },
  { id: "f", text: "" },
];
const text = (id: string) => texts.get(id) ?? "";
const search = (query: string, limit?: number) =>
  searchNodes(tree, text, query, limit);

describe("searchNodes", () => {
  test("blank queries find nothing", () => {
    expect(search("")).toEqual([]);
    expect(search("   ")).toEqual([]);
  });

  test("word-start matches rank before inner matches, each in reading order", () => {
    expect(search("plan").map((result) => result.id)).toEqual([
      "a",
      "e",
      "f",
      "c",
    ]);
  });

  test("matching ignores case, accents and surrounding whitespace", () => {
    const [result] = search("  CAFE ");
    expect(result).toEqual({
      id: "b",
      text: "Café launch",
      path: ["Product plan"],
      match: [0, 4],
    });
    expect(search("planet").map((result) => result.id)).toEqual(["f"]);
  });

  test("results carry the ancestor path, naming empty ancestors, and the match range", () => {
    const [budget] = search("budget");
    expect(budget.path).toEqual(["Product plan", "Café launch"]);
    expect(budget.match).toEqual([7, 13]);
    expect(budget.text.slice(...budget.match)).toBe("budget");
    const [plans] = search("q3");
    expect(plans.path).toEqual(["Product plan", "New idea"]);
    expect(plans.text.slice(...plans.match)).toBe("Q3");
  });

  test("match offsets index the original text when folding changes characters", () => {
    const decomposed = new Map([["x", "Amélie's café"]]);
    const [result] = searchNodes(
      [{ id: "x", text: "" }],
      (id) => decomposed.get(id) ?? "",
      "cafe",
    );
    expect(result.text.slice(...result.match)).toBe("café");
  });

  test("results stop at the limit", () => {
    expect(search("plan", 2).map((result) => result.id)).toEqual(["a", "e"]);
  });
});

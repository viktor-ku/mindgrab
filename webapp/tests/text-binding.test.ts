import { describe, expect, test } from "bun:test";
import type { TextChange } from "../src/project-document";
import { diffText } from "../src/project-document";

const apply = (text: string, { index, deleteCount, insert }: TextChange) =>
  text.slice(0, index) + insert + text.slice(index + deleteCount);

describe("diffText", () => {
  test("places repeated characters where the caret is", () => {
    expect(diffText("aa", "aaa", 1)).toEqual({
      index: 0,
      deleteCount: 0,
      insert: "a",
    });
    expect(diffText("aa", "aaa", 3)).toEqual({
      index: 2,
      deleteCount: 0,
      insert: "a",
    });
    expect(diffText("aab", "ab", 0)).toEqual({
      index: 0,
      deleteCount: 1,
      insert: "",
    });
    expect(diffText("aab", "ab", 1)).toEqual({
      index: 1,
      deleteCount: 1,
      insert: "",
    });
  });

  test("never splits surrogate pairs", () => {
    for (const [previous, next, cursor] of [
      ["😀", "😁", 2],
      ["a😀b", "a😁b", 3],
      ["😀😀", "😀", 2],
      ["😀😀", "😀", 0],
      ["x", "x😀", 3],
    ] as const) {
      const change = diffText(previous, next, cursor);
      expect(apply(previous, change)).toBe(next);
      for (const edge of [change.index, change.index + change.deleteCount]) {
        const code = previous.charCodeAt(edge);
        expect(code >= 0xdc00 && code <= 0xdfff).toBe(false);
      }
    }
  });
});

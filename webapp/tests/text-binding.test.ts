import { describe, expect, test } from "bun:test";
import * as Y from "yjs";
import { diffText } from "../src/project-document";
import type { TextChange } from "../src/project-document";
import { rebaseChange } from "../src/text-binding";

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

  test("describes replacements, pastes, and newlines minimally", () => {
    expect(diffText("hello world", "hello brave world", 12)).toEqual({
      index: 6,
      deleteCount: 0,
      insert: "brave ",
    });
    expect(diffText("one two", "one\nline two", 8)).toEqual({
      index: 3,
      deleteCount: 0,
      insert: "\nline",
    });
    expect(diffText("abc", "abc", 1)).toEqual({
      index: 1,
      deleteCount: 0,
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

describe("rebaseChange", () => {
  // Applies `local` (computed against `base`) after the concurrent `remote`
  // edit, and compares with Yjs merging the same two edits.
  function rebased(
    base: string,
    local: TextChange,
    remote: (text: Y.Text) => void,
  ) {
    const doc = new Y.Doc();
    const text = doc.getText();
    text.insert(0, base);
    const deltas: unknown[] = [];
    text.observe((event) => deltas.push(event.delta));
    remote(text);
    const change = deltas.reduce<TextChange>(
      (current, delta) => rebaseChange(current, delta as never),
      local,
    );
    text.delete(change.index, change.deleteCount);
    text.insert(change.index, change.insert);
    return text.toString();
  }

  test("moves a local change over remote inserts and deletes", () => {
    const typed = { index: 5, deleteCount: 0, insert: "!" };
    expect(rebased("hello world", typed, (t) => t.insert(0, ">> "))).toBe(
      ">> hello! world",
    );
    expect(rebased("hello world", typed, (t) => t.insert(6, "big "))).toBe(
      "hello! big world",
    );
    expect(rebased("hello world", typed, (t) => t.delete(0, 2))).toBe(
      "llo! world",
    );
    expect(rebased("hello world", typed, (t) => t.insert(5, ","))).toBe(
      "hello,! world",
    );
  });

  test("keeps remote text next to a replaced range", () => {
    const replace = { index: 6, deleteCount: 5, insert: "there" };
    expect(rebased("hello world", replace, (t) => t.insert(0, "Oh, "))).toBe(
      "Oh, hello there",
    );
    expect(rebased("hello world", replace, (t) => t.insert(11, "!"))).toBe(
      "hello there!",
    );
    expect(rebased("hello world", replace, (t) => t.delete(4, 4))).toBe(
      "hellthere",
    );
  });
});

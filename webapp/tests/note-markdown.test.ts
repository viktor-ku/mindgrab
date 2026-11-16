import { expect, test } from "bun:test";
import { MarkdownManager } from "@tiptap/markdown";
import { NOTE_MARKED_OPTIONS, noteExtensions } from "../src/note-editor";

const markdown = new MarkdownManager({
  extensions: noteExtensions(),
  markedOptions: NOTE_MARKED_OPTIONS,
});
const roundTrip = (note: string) => markdown.serialize(markdown.parse(note));
const links = (note: string) =>
  (markdown.parse(note).content?.[0]?.content ?? []).flatMap((node) =>
    (node.marks ?? [])
      .filter((mark) => mark.type === "link")
      .map((mark) => ({
        text: node.text,
        href: mark.attrs?.href,
        title: mark.attrs?.title ?? null,
      })),
  );

test("plain text notes keep their lines", () => {
  expect(roundTrip("first line\nsecond line\n\nnext")).toBe(
    "first line\nsecond line\n\nnext",
  );
});

test("links keep their destination and title through a save", () => {
  for (const note of [
    "[guide](<https://example.com/a)b>)",
    "[guide](<https://example.com/a b>)",
    "[guide](https://example.com/a\\)b)",
    "[guide](<https://example.com/a\\<b\\>c>)",
    '[guide](https://example.com "The \\"guide\\"")',
    "<https://example.com/a)b>",
    "https://example.com/a",
  ]) {
    const saved = roundTrip(note);
    expect(links(saved)).toEqual(links(note));
    expect(roundTrip(saved)).toBe(saved);
  }
  expect(links("[guide](<https://example.com/a)b>)")).toEqual([
    { text: "guide", href: "https://example.com/a)b", title: null },
  ]);
});

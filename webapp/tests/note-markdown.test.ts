import { expect, test } from "bun:test";
import type { JSONContent } from "@tiptap/core";
import { MarkdownManager } from "@tiptap/markdown";
import {
  noteExtensions,
  noteLinkHref,
  noteMarkdown,
  parseNote,
} from "../src/note-editor";
import {
  DEEP_NOTES,
  LINKED_NOTES,
  STALLING_NOTES,
  UNLINKED_NOTES,
} from "./hostile-notes";

const markdown = new MarkdownManager({
  extensions: noteExtensions(),
  ...noteMarkdown(),
});
const roundTrip = (note: string) => markdown.serialize(markdown.parse(note));
const nodes = (node: JSONContent): JSONContent[] => [
  node,
  ...(node.content ?? []).flatMap(nodes),
];
const links = (note: string) =>
  nodes(markdown.parse(note)).flatMap((node) =>
    (node.marks ?? [])
      .filter((mark) => mark.type === "link")
      .map((mark) => ({
        text: node.text,
        href: mark.attrs?.href,
        title: mark.attrs?.title ?? null,
      })),
  );

test("plain lines and links keep their text and destination through a save", () => {
  expect(roundTrip("first line\nsecond line\n\nnext")).toBe(
    "first line\nsecond line\n\nnext",
  );
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

test("a note links only to whole http, https and mailto addresses", () => {
  for (const note of UNLINKED_NOTES)
    expect([note, links(note)]).toEqual([note, []]);
  for (const [note, href] of LINKED_NOTES) {
    const found = links(note).map((link) => noteLinkHref(link.href));
    expect([note, found]).toEqual([note, [href]]);
  }

  // The same rule decides what a link draws with and what Ctrl+click opens.
  for (const href of [
    "javascript:alert(1)",
    " \tJaVa\nScRiPt:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "file:///etc/passwd",
    "blob:https://mindgrab.app/1",
    "ftp://example.com/a",
    "tel:+3725550100",
    "//evil.example/a",
    "/api/logout.php",
    "evil.example/a",
    "",
    undefined,
    null,
    { href: "https://example.com" },
  ])
    expect([href, noteLinkHref(href)]).toEqual([href, undefined]);
  expect(noteLinkHref("https://example.com/a b")).toBe(
    "https://example.com/a%20b",
  );
  expect(noteLinkHref("https:/api/logout.php")).toBe("https://api/logout.php");
});

// A note shown as its lines, unformatted.
const plain = (note: string) => ({
  type: "doc",
  content: note.split("\n").map((line) => ({
    type: "paragraph",
    ...(line && { content: [{ type: "text", text: line }] }),
  })),
});

test("a note no stack can parse shows as its text", () => {
  expect(parseNote({ markdown }, "")).toEqual({
    type: "doc",
    content: [{ type: "paragraph" }],
  });
  expect(parseNote({ markdown }, "> > quoted").content?.[0]?.type).toBe(
    "blockquote",
  );
  for (const note of DEEP_NOTES)
    expect(parseNote({ markdown }, `first line\n${note}`)).toEqual(
      plain(`first line\n${note}`),
    );
});

// Unbounded, the first of these alone takes longer than the test may.
test("a note written to stall the reader shows as its text, in about a second", () => {
  for (const note of STALLING_NOTES) {
    const started = performance.now();
    expect(parseNote({ markdown }, note)).toEqual(plain(note));
    expect(performance.now() - started).toBeLessThan(3000);
  }
  // The reader is as quick as before for the next note.
  expect(parseNote({ markdown }, "**bold**").content?.[0]?.type).toBe(
    "paragraph",
  );
  expect(links("[x](https://example.com/a)")).toHaveLength(1);
}, 15_000);

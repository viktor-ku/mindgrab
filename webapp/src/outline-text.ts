import type { MindMapNode } from "./mind-map";

export interface OutlineEntry {
  text: string;
  children: OutlineEntry[];
}

// Bullets and numbering that mark list items in pasted outlines.
const MARKER = /^(?:[-*+•◦▪‣]|\d+[.)]|\[[ xX]\])\s+/;

// Turns indented text (Markdown lists, tab-indented outlines, plain lines)
// into a tree. Each line becomes one idea; deeper indentation nests it under
// the nearest shallower line; Markdown headings contain the lines below them.
// Blank lines are ignored.
export function parseOutline(text: string): OutlineEntry[] {
  const roots: OutlineEntry[] = [];
  const stack: { indent: number; entry: OutlineEntry }[] = [];
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    if (!raw.trim()) continue;
    const expanded = raw.replace(/\t/g, "    ");
    let content = expanded.trim();
    // A heading contains everything until the next heading of its level.
    const heading = /^(#{1,6})\s+/.exec(content);
    const indent = heading
      ? heading[1].length - 100
      : expanded.length - expanded.trimStart().length;
    if (heading) content = content.slice(heading[0].length);
    content = content
      .replace(MARKER, "")
      .replace(/^\\([#>+*-])/, "$1")
      .trim();
    if (!content) continue;
    const entry: OutlineEntry = { text: content, children: [] };
    while (stack.length && stack[stack.length - 1].indent >= indent)
      stack.pop();
    (stack.length ? stack[stack.length - 1].entry.children : roots).push(entry);
    stack.push({ indent, entry });
  }
  return roots;
}

export const outlineSize = (entries: readonly OutlineEntry[]): number =>
  entries.reduce((count, entry) => count + 1 + outlineSize(entry.children), 0);

// The inverse of parseOutline for one branch, as a Markdown list.
export function branchOutline(
  node: MindMapNode,
  text: (id: string) => string,
): string {
  const lines: string[] = [];
  const visit = (current: MindMapNode, depth: number) => {
    const value = text(current.id)
      .replace(/\s*\n\s*/g, " ")
      .trim();
    lines.push(`${"  ".repeat(depth)}- ${value || "New idea"}`);
    for (const child of current.next ?? []) visit(child, depth + 1);
  };
  visit(node, 0);
  return lines.join("\n");
}

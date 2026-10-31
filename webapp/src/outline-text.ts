import type { MindMapNode } from "./mind-map";
import { isNodeColor } from "./node-colors";
import type { NodeColor } from "./node-colors";

export interface OutlineEntry {
  text: string;
  // Only branches copied from Mindgrab carry notes and colors.
  note?: string;
  color?: NodeColor;
  children: OutlineEntry[];
}

// Alongside plain text, copies carry the full branch so notes and colors
// survive cut and paste inside Mindgrab.
export const BRANCH_MIME = "application/x-mindgrab-branch";

export function branchEntry(
  node: MindMapNode,
  text: (id: string) => string,
): OutlineEntry {
  return {
    text: text(node.id),
    ...(node.note && { note: node.note }),
    ...(node.color && { color: node.color }),
    children: (node.next ?? []).map((child) => branchEntry(child, text)),
  };
}

// Undefined unless the data is a well-formed copied branch.
export function parseBranchEntry(data: string): OutlineEntry | undefined {
  const parse = (value: unknown, depth: number): OutlineEntry | undefined => {
    if (depth > 10_000 || !value || typeof value !== "object") return;
    const { text, note, color, children } = value as Record<string, unknown>;
    if (typeof text !== "string" || !Array.isArray(children)) return;
    const parsed: OutlineEntry[] = [];
    for (const child of children) {
      const entry = parse(child, depth + 1);
      if (!entry) return;
      parsed.push(entry);
    }
    return {
      text,
      ...(typeof note === "string" && note && { note }),
      ...(isNodeColor(color) && { color }),
      children: parsed,
    };
  };
  try {
    return parse(JSON.parse(data), 0);
  } catch {
    return undefined;
  }
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
    // A marker with nothing after it (trimmed "- ") is an empty item.
    if (/^(?:[-*+•◦▪‣]|\d+[.)]|\[[ xX]\])$/.test(content)) continue;
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

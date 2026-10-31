import type { MindMapNode } from "./mind-map";

export interface SearchResult {
  id: string;
  text: string;
  // Ancestor texts from the root down to the parent.
  path: string[];
  // Character range of the first match within `text`.
  match: [number, number];
}

// Case- and accent-insensitive, one UTF-16 unit per input unit so match
// offsets index the original text.
function fold(text: string) {
  return Array.from(text, (character) =>
    character
      .normalize("NFD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .padEnd(character.length, " ")
      .slice(0, character.length),
  ).join("");
}

// Every node, including those inside folded branches, in reading order.
// Matches at the start of a word rank before matches inside a word.
export function searchNodes(
  roots: readonly MindMapNode[],
  text: (id: string) => string,
  query: string,
  limit = 50,
): SearchResult[] {
  const needle = fold(query.trim());
  if (!needle) return [];
  const starts: SearchResult[] = [];
  const inside: SearchResult[] = [];
  const visit = (nodes: readonly MindMapNode[], path: string[]) => {
    for (const node of nodes) {
      const value = text(node.id);
      const folded = fold(value);
      const index = folded.indexOf(needle);
      if (index !== -1) {
        const wordStart = index === 0 || /[\s\p{P}]/u.test(folded[index - 1]);
        (wordStart ? starts : inside).push({
          id: node.id,
          text: value,
          path,
          match: [index, index + needle.length],
        });
      }
      visit(node.next ?? [], [...path, value.trim() || "New idea"]);
    }
  };
  visit(roots, []);
  return [...starts, ...inside].slice(0, limit);
}

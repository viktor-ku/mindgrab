import { z } from "zod";
import {
  LIMITS,
  SavingPreferencesSchema,
  DEFAULT_SAVING_PREFERENCES,
  projectForest,
  SCHEMA_VERSION,
} from "./project-document";
import type { ProjectDocument, DocumentView } from "./project-document";
import { isNodeColor } from "./node-colors";
import type { NodeColor } from "./node-colors";

export const PROJECT_FILE_FORMAT = "mindgrab-project";
export const PROJECT_FILE_VERSION = 4;
export const PROJECT_FILE_MAX_BYTES = 10 * 1024 * 1024;
export const PROJECT_FILE_MAX_DEPTH = 100;

export interface ProjectFileNode {
  id: string;
  text: string;
  note?: string;
  color: NodeColor;
  position?: { x: number; y: number };
  children: ProjectFileNode[];
}

// Viewport state is a local preference.
export interface ViewportPreference {
  left: number;
  top: number;
  zoom: number;
  anchor?: { id: string; centerY: number };
  // Folded branches in this browser; ids of nodes that no longer exist are ignored.
  collapsed?: string[];
}

export interface ProjectFile {
  format: typeof PROJECT_FILE_FORMAT;
  version: typeof PROJECT_FILE_VERSION;
  project: { name: string; nodes: ProjectFileNode[] };
  preferences?: {
    saving?: import("./project-document").SavingPreferences;
    viewport?: { left: number; top: number; zoom: number };
    anchor?: { id: string; centerY: number };
  };
}

export class ProjectFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectFileError";
  }
}

const PositionSchema = z.strictObject({
  x: z.number().finite(),
  y: z.number().finite(),
});
const ViewportSchema = z.strictObject({
  left: z.number().finite(),
  top: z.number().finite(),
  zoom: z.number().finite().min(0.25).max(2.5),
});
const AnchorSchema = z.strictObject({
  id: z.string().min(1),
  centerY: z.number().finite(),
});

function nodeSchema(depth: number): z.ZodType<ProjectFileNode> {
  return z.lazy(() =>
    z.strictObject({
      id: z.string().min(1).max(128),
      text: z.string().max(LIMITS.text),
      note: z
        .string()
        .refine(
          (note) => note.length <= LIMITS.note,
          `Note must be at most ${LIMITS.note} UTF-16 units.`,
        )
        .optional(),
      color: z.custom<NodeColor>(isNodeColor, "Invalid node color."),
      position: PositionSchema.optional(),
      children:
        depth < PROJECT_FILE_MAX_DEPTH
          ? z.array(nodeSchema(depth + 1))
          : z.array(z.never()),
    }),
  );
}

const PortableProjectSchema = z
  .strictObject({
    format: z.literal(PROJECT_FILE_FORMAT),
    version: z.literal(PROJECT_FILE_VERSION),
    project: z.strictObject({
      name: z
        .string()
        .refine((name) => name.trim().length > 0, "Project name is required.")
        .refine(
          (name) => new TextEncoder().encode(name).length <= LIMITS.nameBytes,
          `Project name must be at most ${LIMITS.nameBytes} bytes.`,
        ),
      nodes: z.array(nodeSchema(1)),
    }),
    preferences: z
      .strictObject({
        saving: SavingPreferencesSchema.optional(),
        viewport: ViewportSchema.optional(),
        anchor: AnchorSchema.optional(),
      })
      .optional(),
  })
  .superRefine((file, context) => {
    const ids = new Set<string>();
    const visit = (nodes: ProjectFileNode[]) => {
      for (const node of nodes) {
        if (ids.has(node.id))
          context.addIssue({
            code: "custom",
            message: "Node IDs must be unique.",
          });
        ids.add(node.id);
        visit(node.children);
      }
    };
    visit(file.project.nodes);
    const anchor = file.preferences?.anchor;
    if (anchor && !ids.has(anchor.id))
      context.addIssue({
        code: "custom",
        message: "Viewport anchor must reference a project node.",
      });
  });

function checkedFile(value: unknown): ProjectFile {
  // Bound traversal before recursive schema validation, even for hostile files.
  const roots = (value as ProjectFile | undefined)?.project?.nodes;
  if (Array.isArray(roots)) {
    const pending = [{ nodes: roots, depth: 1 }];
    let count = 0;
    for (let branch = pending.pop(); branch; branch = pending.pop()) {
      if (branch.nodes.length && branch.depth > PROJECT_FILE_MAX_DEPTH)
        throw new ProjectFileError("Node nesting exceeds 100 levels.");
      count += branch.nodes.length;
      if (count > LIMITS.nodes)
        throw new ProjectFileError(
          "A project can contain at most 10000 nodes.",
        );
      for (const node of branch.nodes)
        if (node && Array.isArray(node.children))
          pending.push({ nodes: node.children, depth: branch.depth + 1 });
    }
  }
  const parsed = PortableProjectSchema.safeParse(value);
  if (!parsed.success)
    throw new ProjectFileError(
      parsed.error.issues[0]?.message ?? "Invalid project file.",
    );
  return parsed.data;
}

export function projectFileFromContent(
  content: DocumentView,
  preferences?: ProjectFile["preferences"],
): ProjectFile {
  const anchor = preferences?.anchor;
  const localPreferences = {
    saving: content.saving,
    ...preferences,
    // A deleted layout anchor is only a stale local preference.
    anchor:
      anchor && content.nodes.some((node) => node.id === anchor.id)
        ? anchor
        : undefined,
  };
  return checkedFile({
    format: PROJECT_FILE_FORMAT,
    version: PROJECT_FILE_VERSION,
    project: {
      name: content.name,
      nodes: projectForest(content),
    },
    ...(localPreferences && { preferences: localPreferences }),
  });
}

export function serializeProjectFile(
  content: DocumentView,
  preferences?: ProjectFile["preferences"],
): string {
  const file = projectFileFromContent(content, preferences);
  const json = `${JSON.stringify(file, null, 2)}\n`;
  if (new TextEncoder().encode(json).length > PROJECT_FILE_MAX_BYTES)
    throw new ProjectFileError("Project file exceeds the 10 MiB size limit.");
  return json;
}

export function parseProjectFile(json: string): ProjectFile {
  if (new TextEncoder().encode(json).length > PROJECT_FILE_MAX_BYTES)
    throw new ProjectFileError("Project file exceeds the 10 MiB size limit.");
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new ProjectFileError("Project file is not valid JSON.");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new ProjectFileError("Project file must contain a JSON object.");
  const header = value as { format?: unknown; version?: unknown };
  if (header.format !== PROJECT_FILE_FORMAT)
    throw new ProjectFileError("File is not a Mindgrab project.");
  if (header.version !== 3 && header.version !== PROJECT_FILE_VERSION)
    throw new ProjectFileError(
      `Unsupported Mindgrab project version: ${String(header.version)}.`,
    );
  return checkedFile({ ...value, version: PROJECT_FILE_VERSION });
}

export function prepareProjectImport(input: ProjectFile) {
  const file = checkedFile(input);
  const ids = new Map<string, string>();
  const addIds = (nodes: ProjectFileNode[]) => {
    for (const node of nodes) {
      ids.set(node.id, crypto.randomUUID());
      addIds(node.children);
    }
  };
  addIds(file.project.nodes);

  const nodes: DocumentView["nodes"] = [];
  const add = (
    branch: ProjectFileNode[],
    parent: string | null,
    depth: number,
  ) => {
    for (const node of branch) {
      const id = ids.get(node.id)!;
      nodes.push({
        id,
        parent,
        children: node.children.map((child) => ids.get(child.id)!),
        depth,
        text: node.text,
        note: node.note ?? "",
        position: node.position ? { ...node.position } : null,
        color: node.color,
      });
      add(node.children, id, depth + 1);
    }
  };
  add(file.project.nodes, null, 0);
  const content: DocumentView = {
    format: "mindgrab-loro-v1",
    schemaVersion: SCHEMA_VERSION,
    name: file.project.name,
    saving: file.preferences?.saving ?? { ...DEFAULT_SAVING_PREFERENCES },
    roots: file.project.nodes.map((node) => ids.get(node.id)!),
    nodes,
  };
  const preferences = file.preferences && {
    ...file.preferences,
    ...(file.preferences.anchor && {
      anchor: {
        ...file.preferences.anchor,
        id: ids.get(file.preferences.anchor.id) as string,
      },
    }),
  };
  return { content, preferences };
}

export function exportProjectDocument(
  doc: ProjectDocument,
  preferences?: ProjectFile["preferences"],
) {
  // Rust returns a detached view synchronously before any awaits.
  return serializeProjectFile(doc.view(), preferences);
}

type OpenFilePicker = (options: {
  types: { description: string; accept: Record<string, string[]> }[];
  multiple: false;
}) => Promise<{ getFile(): Promise<File> }[]>;

type SaveFilePicker = (options: {
  suggestedName: string;
  types: { description: string; accept: Record<string, string[]> }[];
}) => Promise<{
  createWritable(): Promise<{
    write(data: string): Promise<void>;
    close(): Promise<void>;
  }>;
}>;

const JSON_FILE_TYPE = [
  {
    description: "Mindgrab project",
    accept: { "application/json": [".mindgrab.json", ".json"] },
  },
];

const MARKDOWN_FILE_TYPE = [
  { description: "Markdown outline", accept: { "text/markdown": [".md"] } },
];

function safeFileName(name: string): string {
  return Array.from(name, (character) =>
    /[<>:"/\\|?*]/.test(character) || character.charCodeAt(0) < 32
      ? "-"
      : character,
  ).join("");
}

export async function readProjectFile(): Promise<File | undefined> {
  const picker = (window as Window & { showOpenFilePicker?: OpenFilePicker })
    .showOpenFilePicker;
  if (picker) {
    const [handle] = await picker.call(window, {
      types: JSON_FILE_TYPE,
      multiple: false,
    });
    return handle?.getFile();
  }

  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".mindgrab.json,.json,application/json";
    input.addEventListener("change", () => resolve(input.files?.[0]));
    input.addEventListener("cancel", () => resolve(undefined));
    input.click();
  });
}

export function writeProjectFile(fileName: string, json: string) {
  return writeFile(
    `${safeFileName(fileName)}.mindgrab.json`,
    json,
    "application/json",
    JSON_FILE_TYPE,
  );
}

export function writeMarkdownFile(fileName: string, markdown: string) {
  return writeFile(
    `${safeFileName(fileName)}.md`,
    markdown,
    "text/markdown",
    MARKDOWN_FILE_TYPE,
  );
}

// A readable outline of every node, folded or not. Nested list items keep the
// hierarchy; line breaks inside a node continue its list item.
interface OutlineNode {
  id: string;
  note?: string;
  next?: readonly OutlineNode[];
}

export function projectMarkdown(
  name: string,
  roots: readonly OutlineNode[],
  text: (id: string) => string,
  note?: (id: string) => string,
) {
  const lines = [`# ${escapeMarkdown(name.trim() || "Untitled map")}`, ""];
  const visit = (nodes: readonly OutlineNode[], depth: number) => {
    for (const node of nodes) {
      const indent = "  ".repeat(depth);
      const [first = "", ...rest] = (text(node.id).trim() || "New idea").split(
        /\r?\n/,
      );
      lines.push(`${indent}- ${escapeMarkdown(first)}`);
      for (const line of rest)
        lines.push(`${indent}  ${escapeMarkdown(line)}`.trimEnd());
      const details = note ? note(node.id) : node.note;
      if (details)
        for (const line of details.split(/\r?\n/))
          lines.push(`${indent}  > ${escapeMarkdown(line)}`.trimEnd());
      visit(node.next ?? [], depth + 1);
    }
  };
  visit(roots, 0);
  return `${lines.join("\n")}\n`;
}

// Leading list, heading and quote markers would change the outline structure.
function escapeMarkdown(line: string) {
  return line.replace(/^(\s*)([#>+*-]|\d+[.)])(\s)/, "$1\\$2$3");
}

async function writeFile(
  suggestedName: string,
  contents: string,
  type: string,
  types: { description: string; accept: Record<string, string[]> }[],
): Promise<void> {
  const picker = (window as Window & { showSaveFilePicker?: SaveFilePicker })
    .showSaveFilePicker;
  if (picker) {
    const handle = await picker.call(window, { suggestedName, types });
    const writable = await handle.createWritable();
    await writable.write(contents);
    await writable.close();
    return;
  }

  const url = URL.createObjectURL(new Blob([contents], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = suggestedName;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

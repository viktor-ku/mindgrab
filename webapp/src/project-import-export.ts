import {
  parseProject,
  listProjects,
  loadProject,
  saveProject,
} from "./projects";
import { ProjectFileSchema } from "./project-schema";
import type { Project } from "./project-schema";

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
    accept: { "application/json": [".json"] },
  },
];

function safeFileName(name: string): string {
  return Array.from(name, (character) =>
    /[<>:"/\\|?*]/.test(character) || character.charCodeAt(0) < 32
      ? "-"
      : character,
  ).join("");
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function findDuplicateProject(
  storage: Storage,
  imported: Project,
): string | undefined {
  const importedJson = canonical(imported);
  for (const key of listProjects(storage)) {
    try {
      const json = storage.getItem(key);
      if (json !== null && canonical(parseProject(json)) === importedJson) {
        return key;
      }
    } catch {
      // Ignore damaged local projects while checking for an exact match.
    }
  }
  return undefined;
}

function availableProjectName(storage: Storage, requestedName: string): string {
  const names = new Set(
    listProjects(storage).map((key) => key.slice("proj/".length)),
  );
  if (!names.has(requestedName)) return requestedName;
  let suffix = " (copy)";
  let number = 2;
  while (names.has(`${requestedName}${suffix}`)) {
    suffix = ` (copy ${number++})`;
  }
  return `${requestedName}${suffix}`;
}

export type ImportResult =
  | { kind: "existing"; project: Project }
  | { kind: "imported" | "clone"; project: Project };

export function saveImportedProject(
  storage: Storage,
  imported: Project,
  clone: boolean,
): ImportResult {
  const duplicateKey = findDuplicateProject(storage, imported);
  if (duplicateKey && !clone) {
    return { kind: "existing", project: loadProject(storage, duplicateKey) };
  }

  const name = availableProjectName(storage, imported.name);
  const project = { ...imported, name };
  saveProject(storage, project);
  return { kind: duplicateKey ? "clone" : "imported", project };
}

export function serializeProjectFile(project: Project): string {
  return `${JSON.stringify(ProjectFileSchema.parse(project), null, 2)}\n`;
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
    input.accept = ".json,application/json";
    input.addEventListener("change", () => resolve(input.files?.[0]));
    input.addEventListener("cancel", () => resolve(undefined));
    input.click();
  });
}

export async function writeProjectFile(project: Project): Promise<void> {
  const json = serializeProjectFile(project);
  const picker = (window as Window & { showSaveFilePicker?: SaveFilePicker })
    .showSaveFilePicker;
  if (picker) {
    const handle = await picker.call(window, {
      suggestedName: `${safeFileName(project.name)}.json`,
      types: JSON_FILE_TYPE,
    });
    const writable = await handle.createWritable();
    await writable.write(json);
    await writable.close();
    return;
  }

  const url = URL.createObjectURL(
    new Blob([json], { type: "application/json" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = `${safeFileName(project.name)}.json`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

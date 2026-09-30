import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { scenarios } from "./yjs-scenarios";
const directory = join(import.meta.dir, "yjs");
await mkdir(directory, { recursive: true });
// Only the explicitly generated files are replaced; README is maintained by hand.
for (const name of await readdir(directory))
  if (/\.(bin|json)$/.test(name)) await rm(join(directory, name));
for (const scenario of scenarios()) {
  const files: string[] = [];
  for (const [index, update] of scenario.updates.entries()) {
    const file = `${scenario.name}.${index}.bin`;
    files.push(file);
    await writeFile(join(directory, file), update);
  }
  await writeFile(
    join(directory, `${scenario.name}.json`),
    `${JSON.stringify(
      { updates: files, expected: scenario.expected, forest: scenario.forest },
      null,
      2,
    )}\n`,
  );
}

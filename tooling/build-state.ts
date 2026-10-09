import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const output = resolve(root, "webapp/src/generated/mindgrab-state");
const wasmBindgen = Bun.which("wasm-bindgen");
if (!wasmBindgen) {
  throw new Error(
    "Run mise run state:setup to install the WASM target and wasm-bindgen CLI.",
  );
}

async function run(command: string[], capture = false) {
  const process = Bun.spawn(command, {
    cwd: root,
    stdout: capture ? "pipe" : "inherit",
    stderr: "inherit",
  });
  const text = capture ? await new Response(process.stdout).text() : "";
  if ((await process.exited) !== 0)
    throw new Error(`${command.join(" ")} failed`);
  return text;
}

await run([
  "cargo",
  "build",
  "--locked",
  "-p",
  "mindgrab-state",
  "--target",
  "wasm32-unknown-unknown",
  "--release",
]);
await mkdir(output, { recursive: true });
await run([
  wasmBindgen,
  "--target",
  "web",
  "--out-dir",
  output,
  "--out-name",
  "mindgrab_state",
  resolve(root, "target/wasm32-unknown-unknown/release/mindgrab_state.wasm"),
]);
const types = await run(
  [
    "cargo",
    "run",
    "--locked",
    "--quiet",
    "-p",
    "mindgrab-state",
    "--features",
    "bindings",
    "--example",
    "generate_types",
  ],
  true,
);
await Bun.write(resolve(output, "model.ts"), types);
console.log("Built shared Rust state, browser WASM, and TypeScript types.");

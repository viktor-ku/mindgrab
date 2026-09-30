import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { Plugin } from "vite";
import { SHELL_COMPATIBILITY } from "../src/offline-contract.ts";

// The manifest is an allowlist, including copied public files and every emitted
// chunk (also lazy chunks). Never cache a route or response discovered at runtime.
export function offlineShell(): Plugin {
  let publicDir: string;
  return {
    name: "mindgrab-offline-shell",
    apply: "build",
    enforce: "post",
    configResolved(config) {
      if (config.base !== "/")
        throw new Error("Offline shell currently requires deployment at /.");
      publicDir = config.publicDir;
    },
    async generateBundle(_, bundle) {
      const files = new Map<string, string | Uint8Array>();
      for (const [name, entry] of Object.entries(bundle))
        if (!name.endsWith(".map"))
          files.set(name, entry.type === "chunk" ? entry.code : entry.source);
      async function collect(directory: string, prefix = "") {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          const name = prefix + entry.name;
          if (entry.isDirectory())
            await collect(resolve(directory, entry.name), `${name}/`);
          else files.set(name, await readFile(resolve(directory, entry.name)));
        }
      }
      if (publicDir) await collect(publicDir);
      for (const name of files.keys()) {
        if (/^(api|auth|checkhealth)(\/|$)/.test(name) || name === "sw.js")
          throw new Error(`Reserved offline asset path: ${name}`);
      }
      const hash = createHash("sha256");
      hash.update(JSON.stringify(SHELL_COMPATIBILITY));
      const worker = await readFile(
        new URL("./service-worker.js", import.meta.url),
        "utf8",
      );
      hash.update(worker);
      const assets = [...files.keys()].sort();
      for (const name of assets) {
        hash.update(name);
        hash.update(files.get(name) ?? "");
      }
      const version = hash.digest("hex").slice(0, 20);
      this.emitFile({
        type: "asset",
        fileName: "sw.js",
        source: `const BUILD = ${JSON.stringify({ version, assets: assets.map((name) => `/${name}`), compatibility: SHELL_COMPATIBILITY })};\n${worker}`,
      });
    },
  };
}

import { createHash } from "node:crypto";
import { mkdir, realpath, rmdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const environmentKeys = [
  "COMPOSE_PROJECT_NAME",
  "WEBAPP_PORT",
  "PORT",
  "POSTGRES_PORT",
  "DATABASE_URL",
  "VITE_BACKEND_URL",
  "WORKOS_REDIRECT_URI",
  "APP_URL",
] as const;
type Environment = Record<(typeof environmentKeys)[number], string>;
type Config = { env?: Record<string, unknown>; [key: string]: unknown };
const portKeys = ["WEBAPP_PORT", "PORT", "POSTGRES_PORT"] as const;

function git(root: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", "-C", root, ...args]);
  if (result.exitCode !== 0)
    throw new Error(
      `Cannot read Git worktree information: git ${args.join(" ")}`,
    );
  return result.stdout.toString();
}

async function readConfig(root: string): Promise<Config> {
  const file = Bun.file(join(root, "mise.local.toml"));
  if (!(await file.exists())) return {};
  return Bun.TOML.parse(await file.text()) as Config;
}

function port(value: unknown) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 && number <= 65535
    ? number
    : undefined;
}

async function available(port: number, host: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") resolve(false);
      else if (
        host === "::1" &&
        ["EAFNOSUPPORT", "EADDRNOTAVAIL"].includes(error.code ?? "")
      )
        resolve(true);
      else reject(error);
    });
    server.listen({ port, host, exclusive: true }, () => {
      server.close((error) => (error ? reject(error) : resolve(true)));
    });
  });
}

async function lock(directory: string) {
  const deadline = Date.now() + 10_000;
  while (true) {
    try {
      await mkdir(directory);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() >= deadline)
        throw new Error(
          `Bootstrap lock is busy: ${directory}. If no bootstrap is running, remove this stale lock directory and retry.`,
        );
      await Bun.sleep(50);
    }
  }
}

// No package dependencies: T3 can run this before installing the workspace.
export async function bootstrap(directory: string) {
  const root = await realpath(directory);
  const common = git(
    root,
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ).trim();
  const lockDirectory = join(common, "mindgrab-worktree-bootstrap.lock");
  await lock(lockDirectory);
  try {
    const worktrees = git(root, "worktree", "list", "--porcelain", "-z")
      .split("\0")
      .filter((field) => field.startsWith("worktree "))
      .map((field) => field.slice("worktree ".length));
    const reservedPorts = new Set<number>();
    const projects = new Set<string>();
    for (const worktree of worktrees) {
      if (worktree === root) continue;
      const { env } = await readConfig(worktree);
      for (const key of portKeys) {
        const value = port(env?.[key]);
        if (value !== undefined) reservedPorts.add(value);
      }
      if (typeof env?.COMPOSE_PROJECT_NAME === "string")
        projects.add(env.COMPOSE_PROJECT_NAME);
    }

    const config = await readConfig(root);
    const env = config.env ?? {};
    const existing = environmentKeys.filter((key) => env[key] !== undefined);
    if (existing.length) {
      if (
        existing.length !== environmentKeys.length ||
        environmentKeys.some((key) => typeof env[key] !== "string") ||
        portKeys.some((key) => port(env[key]) === undefined)
      )
        throw new Error(
          "mise.local.toml has incomplete worktree settings. Configure all bootstrap variables or remove those variables and rerun; existing settings were preserved.",
        );
      const saved = env as Environment;
      if (
        new Set(portKeys.map((key) => Number(saved[key]))).size !== 3 ||
        portKeys.some((key) => reservedPorts.has(Number(saved[key]))) ||
        projects.has(saved.COMPOSE_PROJECT_NAME)
      )
        throw new Error(
          "Existing worktree ports or Compose project conflict with another worktree.",
        );
      // Keep ports and the database volume stable, including while servers run.
      return Object.fromEntries(
        environmentKeys.map((key) => [key, saved[key]]),
      ) as Environment;
    }

    const hash = createHash("sha256").update(root).digest();
    const start = hash.readUInt32BE(0) % 10_000;
    let ports: number[] | undefined;
    for (let offset = 0; offset < 10_000; offset++) {
      const first = 20_000 + ((start + offset) % 10_000) * 3;
      const candidate = [first, first + 1, first + 2];
      if (candidate.some((value) => reservedPorts.has(value))) continue;
      const free = await Promise.all(
        candidate.flatMap((value) => [
          available(value, "127.0.0.1"),
          available(value, "::1"),
        ]),
      );
      if (free.every(Boolean)) {
        ports = candidate;
        break;
      }
    }
    if (!ports)
      throw new Error("No available worktree ports in the range 20000–49999.");
    const [webapp, backend, postgres] = ports;
    const name = basename(root)
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, "-")
      .slice(0, 40);
    const project = `mindgrab-${name}-${hash.toString("hex").slice(0, 12)}`;
    if (projects.has(project))
      throw new Error(
        "Compose project is already reserved by another worktree.",
      );
    const environment: Environment = {
      COMPOSE_PROJECT_NAME: project,
      WEBAPP_PORT: String(webapp),
      PORT: String(backend),
      POSTGRES_PORT: String(postgres),
      DATABASE_URL: `postgres://postgres@127.0.0.1:${postgres}/mindgrab`,
      VITE_BACKEND_URL: `http://127.0.0.1:${backend}`,
      WORKOS_REDIRECT_URI: `http://localhost:${webapp}/api/auth/callback`,
      APP_URL: `http://localhost:${webapp}/`,
    };

    // Reference shared credentials instead of copying secrets into generated files.
    // A worktree's own .env takes precedence over the main checkout's .env.
    const directives = env._ as Record<string, unknown> | undefined;
    if (directives?.file === undefined) {
      const files = [
        ...new Set([join(worktrees[0], ".env"), join(root, ".env")]),
      ];
      // mise skips missing dotenv files; credentials can be added later.
      env._ = {
        ...directives,
        file: files.map((path) => ({ path, redact: true })),
      };
    }
    const { _: sources, ...values } = env;
    config.env = { ...values, ...environment };
    // mise evaluates env directives in declaration order. Load dotenv files
    // before assigning worktree URLs so a shared callback cannot override them.
    const prefix = sources ? Bun.TOML.stringify({ env: { _: sources } }) : "";
    await writeFile(
      join(root, "mise.local.toml"),
      `# Worktree environment generated by tooling/worktree-bootstrap.ts.\n${prefix}${Bun.TOML.stringify(config)}`,
      { mode: 0o600 },
    );
    return environment;
  } finally {
    await rmdir(lockDirectory);
  }
}

if (import.meta.main) {
  try {
    const env = await bootstrap(fileURLToPath(new URL("../", import.meta.url)));
    console.log(
      `Worktree environment ready in mise.local.toml (${env.COMPOSE_PROJECT_NAME})`,
    );
    console.log(
      `Webapp: ${env.APP_URL} Backend: ${env.VITE_BACKEND_URL} Postgres: ${env.POSTGRES_PORT}`,
    );
    console.log(
      "Start with mise run db, mise run backend:dev, and mise run webapp:dev.",
    );
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "Worktree bootstrap failed",
    );
    process.exitCode = 1;
  }
}

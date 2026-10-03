import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrap } from "./worktree-bootstrap";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

function git(root: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", "-C", root, ...args]);
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}

async function repository() {
  const root = await mkdtemp(join(tmpdir(), "mindgrab-bootstrap-"));
  directories.push(root);
  git(root, "init", "--quiet");
  git(
    root,
    "-c",
    "user.name=Bootstrap Test",
    "-c",
    "user.email=bootstrap@example.test",
    "commit",
    "--quiet",
    "--allow-empty",
    "-m",
    "init",
  );
  return root;
}

function worktree(root: string, name: string) {
  const path = join(root, name);
  git(root, "worktree", "add", "--quiet", "--detach", path);
  return path;
}

test("concurrent bootstraps reserve different ports and Compose volumes", async () => {
  const root = await repository();
  const first = worktree(root, "worker one");
  const second = worktree(root, "worker two");
  const environments = await Promise.all([bootstrap(first), bootstrap(second)]);
  const ports = environments.flatMap((env) => [
    env.WEBAPP_PORT,
    env.PORT,
    env.POSTGRES_PORT,
  ]);
  expect(new Set(ports).size).toBe(6);
  expect(environments[0].COMPOSE_PROJECT_NAME).not.toBe(
    environments[1].COMPOSE_PROJECT_NAME,
  );
  for (const env of environments) {
    expect(env.COMPOSE_PROJECT_NAME).toMatch(/^[a-z0-9][a-z0-9_-]+$/);
    expect(env.DATABASE_URL).toBe(
      `postgres://postgres@127.0.0.1:${env.POSTGRES_PORT}/mindgrab`,
    );
    expect(env.VITE_BACKEND_URL).toBe(`http://127.0.0.1:${env.PORT}`);
    expect(env.WORKOS_REDIRECT_URI).toBe(`${env.APP_URL}api/auth/callback`);
  }
});

test("reruns preserve configuration even when the assigned port is in use", async () => {
  const root = await repository();
  await Bun.write(
    join(root, "mise.local.toml"),
    '[env]\nCUSTOM = "keep me"\n[tasks.custom]\nrun = "echo custom"\n',
  );
  const env = await bootstrap(root);
  const file = Bun.file(join(root, "mise.local.toml"));
  const before = await file.text();
  const config = Bun.TOML.parse(before) as {
    env: Record<string, unknown>;
    tasks: Record<string, { run: string }>;
  };
  expect(config.env.CUSTOM).toBe("keep me");
  expect(config.tasks.custom.run).toBe("echo custom");
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(Number(env.WEBAPP_PORT), "127.0.0.1", resolve);
  });
  try {
    expect(await bootstrap(root)).toEqual(env);
    expect(await file.text()).toBe(before);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("skips ports reserved by stopped worktrees and occupied by other processes", async () => {
  const root = await repository();
  const target = worktree(root, "target");
  const other = worktree(root, "other");
  const original = await bootstrap(target);
  await Bun.write(
    join(other, "mise.local.toml"),
    `[env]\nWEBAPP_PORT = "${original.WEBAPP_PORT}"\n`,
  );
  await rm(join(target, "mise.local.toml"));
  const afterReservation = await bootstrap(target);
  expect(afterReservation.WEBAPP_PORT).not.toBe(original.WEBAPP_PORT);
  await rm(join(other, "mise.local.toml"));
  await rm(join(target, "mise.local.toml"));
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(Number(original.PORT), "127.0.0.1", resolve);
  });
  try {
    const afterListener = await bootstrap(target);
    expect(afterListener.PORT).not.toBe(original.PORT);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("references shared and local credentials without copying secrets", async () => {
  const root = await repository();
  const target = worktree(root, "target");
  await Bun.write(
    join(root, ".env"),
    "WORKOS_CLIENT_ID=shared-client\nWORKOS_API_KEY=shared-secret\nPORT=3000\n",
  );
  await Bun.write(join(target, ".env"), "WORKOS_API_KEY=local-secret\n");
  await bootstrap(target);
  const text = await Bun.file(join(target, "mise.local.toml")).text();
  expect(text).not.toContain("shared-secret");
  expect(text).not.toContain("local-secret");
  const config = Bun.TOML.parse(text) as {
    env: { _: { file: { path: string; redact: boolean }[] } };
  };
  expect(config.env._.file).toEqual([
    { path: join(root, ".env"), redact: true },
    { path: join(target, ".env"), redact: true },
  ]);
});

test.skipIf(!Bun.which("mise"))(
  "mise inherits credentials and prioritizes generated URLs",
  async () => {
    const root = await repository();
    const target = worktree(root, "target");
    await Bun.write(
      join(root, ".env"),
      "WORKOS_CLIENT_ID=shared-client\nWORKOS_API_KEY=shared-secret\nPORT=3000\nWORKOS_REDIRECT_URI=http://localhost:5173/api/auth/callback\n",
    );
    const generated = await bootstrap(target);
    // A local credential file added after bootstrap must still take precedence.
    await Bun.write(
      join(target, ".env"),
      "WORKOS_API_KEY=local-secret\nAPP_URL=http://localhost:5173/\n",
    );
    const result = Bun.spawnSync(["mise", "env", "--json"], {
      cwd: target,
      env: { ...process.env, MISE_YES: "1" },
    });
    expect(result.exitCode).toBe(0);
    const inherited = JSON.parse(result.stdout.toString());
    expect(inherited.WORKOS_CLIENT_ID).toBe("shared-client");
    expect(inherited.WORKOS_API_KEY).toBe("local-secret");
    for (const [key, value] of Object.entries(generated))
      expect(inherited[key]).toBe(value);
  },
);

test("rejects incomplete settings without replacing the user's file", async () => {
  const root = await repository();
  const text = '[env]\nPORT = "13000"\nCUSTOM = "keep me"\n';
  await Bun.write(join(root, "mise.local.toml"), text);
  await expect(bootstrap(root)).rejects.toThrow("incomplete worktree settings");
  expect(await Bun.file(join(root, "mise.local.toml")).text()).toBe(text);
  expect(
    await Bun.file(
      join(root, ".git", "mindgrab-worktree-bootstrap.lock"),
    ).exists(),
  ).toBe(false);
});

test("rejects settings copied from a different worktree", async () => {
  const root = await repository();
  const first = worktree(root, "first");
  const second = worktree(root, "second");
  await bootstrap(first);
  await Bun.write(
    join(second, "mise.local.toml"),
    await Bun.file(join(first, "mise.local.toml")).text(),
  );
  await expect(bootstrap(second)).rejects.toThrow(
    "conflict with another worktree",
  );
});

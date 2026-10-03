import { parseEnv } from "node:util";
import { Backend } from "./backend";
import { isLocalDatabase, loopback, readConfig } from "./config";
import { connect, migrate } from "./db";
import { Archive } from "./project/backup";
import { parseNewProjectId } from "./project/storage";

async function main() {
  const envFile = Bun.file(new URL("../../.env", import.meta.url));
  if (await envFile.exists()) {
    for (const [key, value] of Object.entries(parseEnv(await envFile.text())))
      if (process.env[key] === undefined) process.env[key] = value;
  }
  const args = process.argv.slice(2);
  const config = args.length ? undefined : readConfig();
  const db = connect(
    config?.databaseUrl ??
      process.env.DATABASE_URL ??
      "postgres://postgres@localhost:5432/mindgrab",
  );
  let backend: Backend | undefined;
  try {
    await migrate(db);
    const adminConfig = config ?? {
      databaseUrl: "",
      clientId: "",
      apiKey: "",
      redirectUri: "http://localhost/api/auth/callback",
      appUrl: "http://localhost/",
      issuer: "",
      secureCookies: false,
    };
    backend = new Backend(db, adminConfig);
    if (args.length) {
      const [command, project, sourceOwner, destinationOrPath, path] = args;
      if (command === "rebuild-read-models" && args.length === 1) {
        await backend.services.readModels.rebuildAll();
        console.log("Read models rebuilt from canonical binary storage");
      } else if (command === "compact-project" && args.length === 3) {
        const id = parseNewProjectId(project);
        console.log(
          JSON.stringify(
            await backend.maintenance.compact(
              await backend.backups.owner(sourceOwner),
              id,
            ),
          ),
        );
      } else if (command === "backup-project" && args.length === 4) {
        const id = parseNewProjectId(project);
        await (await backend.backups.export(id, sourceOwner)).write(
          destinationOrPath,
        );
        console.log(`Binary backup written for project ${id}`);
      } else if (command === "restore-project" && args.length === 5) {
        const id = parseNewProjectId(project);
        await backend.backups.restore(
          id,
          sourceOwner,
          destinationOrPath,
          await Archive.read(path),
        );
        await backend.services.readModels.rebuild(
          await backend.backups.owner(destinationOrPath),
          id,
        );
        console.log(
          `Canonical binary state restored and read models rebuilt for project ${id}`,
        );
      } else
        throw new Error(
          "Usage: backend [rebuild-read-models | compact-project <uuid> <owner-external-id> | backup-project <uuid> <owner-external-id> <file> | restore-project <uuid> <source-owner-external-id> <destination-owner-external-id> <file>]",
        );
      await backend.close();
      await db.close();
      return;
    }
    if (
      config &&
      loopback(new URL(config.appUrl).hostname) &&
      isLocalDatabase(config.databaseUrl)
    ) {
      await db`INSERT INTO users (name, email, external_id) VALUES ('Boba Tee', 'boba.tee@mindgrab.test', 'user_01M3D7HX2KDTKS1SQXA8KWMX15') ON CONFLICT (external_id) DO NOTHING`;
    }
    const port = Number(process.env.PORT ?? "3000");
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error("Invalid PORT");
    const server = backend.listen(port);
    console.log(`Mindgrab API listening on http://localhost:${server.port}`);
    let stopping = false;
    const shutdown = async () => {
      if (stopping) return;
      stopping = true;
      await backend?.close();
      await db.close();
    };
    process.once("SIGINT", () => {
      void shutdown();
    });
    process.once("SIGTERM", () => {
      void shutdown();
    });
  } catch (error) {
    await backend?.close();
    await db.close();
    throw error;
  }
}

if (import.meta.main) {
  main().catch((error) => {
    // Connection/provider errors can contain credentials; report only safe,
    // application-owned configuration/usage messages.
    console.error(
      error instanceof Error && !("code" in error)
        ? error.message
        : "Backend startup or administration failed",
    );
    process.exitCode = 1;
  });
}

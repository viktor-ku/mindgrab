import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { SQL } from "bun";

export type Database = Pick<SQL, "unsafe">;
export function connect(url: string, max = 10) {
  return new SQL(url, {
    max,
    connectionTimeout: 5,
    idleTimeout: 30,
    bigint: true,
  });
}

export async function query<T>(
  db: Database,
  statement: string,
  args: unknown[] = [],
): Promise<T[]> {
  return (await db.unsafe(statement, args)) as T[];
}

export async function one<T>(
  db: Database,
  statement: string,
  args: unknown[] = [],
): Promise<T | undefined> {
  return (await query<T>(db, statement, args))[0];
}

// Preserve the original SQL and adopt already-applied migration checksums. A
// reserved connection keeps the advisory lock through every transaction.
export async function migrate(db: SQL) {
  const connection = await db.reserve();
  try {
    await connection`SELECT pg_advisory_lock(624873210)`;
    await connection.unsafe(
      "CREATE TABLE IF NOT EXISTS backend_migrations (version BIGINT PRIMARY KEY, checksum BYTEA NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
    );
    const legacy = (
      await connection`SELECT to_regclass('public._sqlx_migrations') AS name`
    )[0].name;
    const directory = new URL("../migrations/", import.meta.url);
    for (const file of (await readdir(directory))
      .filter((name) => /^\d+_.+\.sql$/.test(name))
      .sort()) {
      const version = BigInt(file.split("_")[0]);
      const bytes = await Bun.file(new URL(file, directory)).bytes();
      const checksum = createHash("sha384").update(bytes).digest();
      const applied = (
        await connection`SELECT checksum FROM backend_migrations WHERE version = ${version}`
      )[0];
      if (applied) {
        if (!Buffer.from(applied.checksum).equals(checksum))
          throw new Error(`Migration ${file} changed after application`);
        continue;
      }
      if (legacy) {
        const old = (
          await connection`SELECT checksum, success FROM _sqlx_migrations WHERE version = ${version}`
        )[0];
        if (old) {
          if (!old.success || !Buffer.from(old.checksum).equals(checksum))
            throw new Error(
              `Existing migration ${file} failed or has a different checksum`,
            );
          await connection`INSERT INTO backend_migrations (version, checksum) VALUES (${version}, ${checksum})`;
          continue;
        }
      }
      await connection.begin(async (tx) => {
        await tx.unsafe(new TextDecoder().decode(bytes));
        await tx`INSERT INTO backend_migrations (version, checksum) VALUES (${version}, ${checksum})`;
      });
    }
  } finally {
    try {
      await connection`SELECT pg_advisory_unlock(624873210)`;
    } finally {
      connection.release();
    }
  }
}

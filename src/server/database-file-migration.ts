import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { link, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import Sqlite from "better-sqlite3";

export type LegacyDatabaseMigrationResult = "current" | "fresh" | "migrated";

export async function migrateLegacyDatabaseFile(
  targetPath: string,
  legacyPath: string,
): Promise<LegacyDatabaseMigrationResult> {
  const target = resolve(targetPath);
  if (existsSync(target)) return "current";

  const legacy = resolve(legacyPath);
  if (!existsSync(legacy)) return "fresh";

  await mkdir(dirname(target), { recursive: true });
  const staging = `${target}.migrating-${randomUUID()}`;

  try {
    const source = new Sqlite(legacy, { readonly: true, fileMustExist: true });
    try {
      await source.backup(staging);
    } finally {
      source.close();
    }

    const copy = new Sqlite(staging, { fileMustExist: true });
    try {
      copy.pragma("journal_mode = DELETE");
      const integrity = copy.pragma("integrity_check", { simple: true });
      if (integrity !== "ok") {
        throw new Error(`SQLite integrity check returned ${String(integrity)}`);
      }
    } finally {
      copy.close();
    }

    try {
      await link(staging, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return "current";
      throw error;
    }
    return "migrated";
  } catch (error) {
    throw new Error(
      `Could not migrate the existing Echovale database to Feedfold. The original database is unchanged. ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  } finally {
    await Promise.all(
      [staging, `${staging}-journal`, `${staging}-shm`, `${staging}-wal`].map((path) =>
        rm(path, { force: true }),
      ),
    );
  }
}

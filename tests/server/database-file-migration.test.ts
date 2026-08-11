import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AppDatabase } from "../../src/server/database.js";
import { migrateLegacyDatabaseFile } from "../../src/server/database-file-migration.js";

const directories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "feedfold-database-file-migration-"));
  directories.push(directory);
  return directory;
}

function addFeed(database: AppDatabase, title: string): void {
  database.feeds.createFeed(1, {
    title,
    feedUrl: `https://example.test/${encodeURIComponent(title)}`,
  });
}

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("legacy database file migration", () => {
  it("preserves committed Echovale data that is still in an active WAL", async () => {
    const directory = await temporaryDirectory();
    const legacyPath = join(directory, "echovale.db");
    const targetPath = join(directory, "feedfold.db");
    const legacy = new AppDatabase(legacyPath);
    legacy.connection.pragma("wal_autocheckpoint = 0");
    addFeed(legacy, "Existing subscriptions");

    try {
      await expect(migrateLegacyDatabaseFile(targetPath, legacyPath)).resolves.toBe("migrated");
      await expect(migrateLegacyDatabaseFile(targetPath, legacyPath)).resolves.toBe("current");

      const migrated = new AppDatabase(targetPath);
      try {
        expect(migrated.wasNewDatabase).toBe(false);
        expect(migrated.feeds.listFeeds(1).map((feed) => feed.title)).toEqual([
          "Existing subscriptions",
        ]);
        expect(existsSync(legacyPath)).toBe(true);
      } finally {
        migrated.close();
      }
    } finally {
      legacy.close();
    }
  });

  it("leaves an existing Feedfold database in control", async () => {
    const directory = await temporaryDirectory();
    const legacyPath = join(directory, "echovale.db");
    const targetPath = join(directory, "feedfold.db");
    const legacy = new AppDatabase(legacyPath);
    const current = new AppDatabase(targetPath);
    addFeed(legacy, "Legacy feed");
    addFeed(current, "Current feed");
    legacy.close();
    current.close();

    await expect(migrateLegacyDatabaseFile(targetPath, legacyPath)).resolves.toBe("current");

    const reopened = new AppDatabase(targetPath);
    try {
      expect(reopened.feeds.listFeeds(1).map((feed) => feed.title)).toEqual(["Current feed"]);
    } finally {
      reopened.close();
    }
  });

  it("keeps the fresh-install path empty until normal database startup", async () => {
    const directory = await temporaryDirectory();
    const legacyPath = join(directory, "echovale.db");
    const targetPath = join(directory, "feedfold.db");

    await expect(migrateLegacyDatabaseFile(targetPath, legacyPath)).resolves.toBe("fresh");
    expect(existsSync(targetPath)).toBe(false);

    const fresh = new AppDatabase(targetPath);
    try {
      expect(fresh.wasNewDatabase).toBe(true);
      expect(fresh.feeds.listFeeds(1)).toEqual([]);
    } finally {
      fresh.close();
    }
  });

  it("publishes only one concurrent migration without overwriting the winner", async () => {
    const directory = await temporaryDirectory();
    const firstLegacyPath = join(directory, "first-echovale.db");
    const secondLegacyPath = join(directory, "second-echovale.db");
    const targetPath = join(directory, "feedfold.db");
    const firstLegacy = new AppDatabase(firstLegacyPath);
    const secondLegacy = new AppDatabase(secondLegacyPath);
    addFeed(firstLegacy, "First legacy feed");
    addFeed(secondLegacy, "Second legacy feed");
    firstLegacy.close();
    secondLegacy.close();

    const results = await Promise.all([
      migrateLegacyDatabaseFile(targetPath, firstLegacyPath),
      migrateLegacyDatabaseFile(targetPath, secondLegacyPath),
    ]);
    expect(results.sort()).toEqual(["current", "migrated"]);

    const migrated = new AppDatabase(targetPath);
    try {
      expect(migrated.feeds.listFeeds(1).map((feed) => feed.title)).toHaveLength(1);
      expect(["First legacy feed", "Second legacy feed"]).toContain(
        migrated.feeds.listFeeds(1)[0]?.title,
      );
      expect(existsSync(firstLegacyPath)).toBe(true);
      expect(existsSync(secondLegacyPath)).toBe(true);
      expect((await readdir(directory)).filter((entry) => entry.includes(".migrating-"))).toEqual(
        [],
      );
    } finally {
      migrated.close();
    }
  });

  it("fails without leaving a Feedfold database when the legacy file is invalid", async () => {
    const directory = await temporaryDirectory();
    const legacyPath = join(directory, "echovale.db");
    const targetPath = join(directory, "feedfold.db");
    await writeFile(legacyPath, "not a sqlite database");

    await expect(migrateLegacyDatabaseFile(targetPath, legacyPath)).rejects.toThrow(
      "The original database is unchanged",
    );
    expect(existsSync(targetPath)).toBe(false);
    expect((await readdir(directory)).filter((entry) => entry.includes(".migrating-"))).toEqual([]);
    expect(existsSync(legacyPath)).toBe(true);
  });
});

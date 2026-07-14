import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Sqlite from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { AppDatabase } from "../../src/server/db.js";

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("database migrations", () => {
  it("repairs media responses and backfills article images when upgrading an existing database", async () => {
    const directory = await mkdtemp(join(tmpdir(), "echovale-migration-test-"));
    directories.push(directory);
    const path = join(directory, "echovale.db");
    const oldDatabase = new Sqlite(path);
    oldDatabase.exec(`
      CREATE TABLE migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      INSERT INTO migrations (version, applied_at) VALUES (1, '2026-07-13T00:00:00.000Z');

      CREATE TABLE settings (
        id INTEGER PRIMARY KEY,
        poll_interval_minutes INTEGER NOT NULL,
        single_key_shortcuts INTEGER NOT NULL
      );
      INSERT INTO settings (id, poll_interval_minutes, single_key_shortcuts) VALUES (1, 20, 1);

      CREATE TABLE feeds (id INTEGER PRIMARY KEY, refreshing INTEGER NOT NULL DEFAULT 0);
      INSERT INTO feeds (id, refreshing) VALUES (1, 1);

      CREATE TABLE articles (
        id INTEGER PRIMARY KEY,
        url TEXT,
        feed_content_html TEXT,
        content_html TEXT,
        content_source TEXT,
        extraction_status TEXT NOT NULL,
        extraction_error TEXT
      );
      INSERT INTO articles (
        id, url, feed_content_html, content_html, content_source, extraction_status, extraction_error
      ) VALUES
        (1, 'https://media.example.test/video.mp4?tag=1',
         '<p>Feed fallback</p><img src="/fallback.jpg">',
         'video bytes incorrectly stored as article HTML', 'article', 'complete', NULL),
        (2, 'https://example.test/story', NULL,
         '<img src="https://img.shields.io/badge/build-passing"><img src="/hero.jpg">',
         'article', 'complete', NULL),
        (3, 'https://example.test/feed-image', '<img src="/feed-hero.jpg">',
         '<p>Extracted text without an image.</p>', 'article', 'complete', NULL);
    `);
    oldDatabase.close();

    const database = new AppDatabase(path);
    try {
      expect(database.getSettings()).toMatchObject({ markReadOnScroll: true });
      expect(
        database.sqlite
          .prepare(
            `SELECT id, content_html AS contentHtml, content_source AS contentSource,
                    extraction_status AS extractionStatus, extraction_error AS extractionError,
                    image_url AS imageUrl
             FROM articles ORDER BY id`,
          )
          .all(),
      ).toEqual([
        {
          id: 1,
          contentHtml: null,
          contentSource: null,
          extractionStatus: "pending",
          extractionError: null,
          imageUrl: "https://media.example.test/fallback.jpg",
        },
        {
          id: 2,
          contentHtml:
            '<img src="https://img.shields.io/badge/build-passing"><img src="/hero.jpg">',
          contentSource: "article",
          extractionStatus: "complete",
          extractionError: null,
          imageUrl: "https://example.test/hero.jpg",
        },
        {
          id: 3,
          contentHtml: "<p>Extracted text without an image.</p>",
          contentSource: "article",
          extractionStatus: "complete",
          extractionError: null,
          imageUrl: "https://example.test/feed-hero.jpg",
        },
      ]);
      expect(database.sqlite.prepare("SELECT MAX(version) FROM migrations").pluck().get()).toBe(2);
    } finally {
      database.close();
    }

    const reopened = new AppDatabase(path);
    try {
      expect(reopened.sqlite.prepare("SELECT MAX(version) FROM migrations").pluck().get()).toBe(2);
      expect(
        reopened.sqlite.prepare("SELECT image_url FROM articles WHERE id = 2").pluck().get(),
      ).toBe("https://example.test/hero.jpg");
    } finally {
      reopened.close();
    }
  });
});

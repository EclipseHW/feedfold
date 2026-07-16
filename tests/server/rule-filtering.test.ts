import { afterEach, describe, expect, it } from "vitest";
import { AppDatabase, type ParsedArticle } from "../../src/server/db.js";

const TEST_USER_ID = 1;
const databases: AppDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0).reverse()) database.close();
});

function article(
  externalId: string,
  title: string,
  author: string,
  publishedAt: string,
): ParsedArticle {
  return {
    externalId,
    title,
    url: null,
    author,
    publishedAt,
    summary: "",
    imageUrl: null,
    feedContentHtml: null,
  };
}

function seededDatabase(): {
  database: AppDatabase;
  folderId: number;
  scopedFeedId: number;
  outsideFeedId: number;
} {
  const database = new AppDatabase(":memory:");
  databases.push(database);

  const folder = database.createFolder(TEST_USER_ID, { name: "Scoped" });
  const scopedFeed = database.createFeed(TEST_USER_ID, {
    title: "Scoped feed",
    feedUrl: "https://scoped.example.test/feed",
    folderId: folder.id,
  });
  const outsideFeed = database.createFeed(TEST_USER_ID, {
    title: "Outside feed",
    feedUrl: "https://outside.example.test/feed",
  });

  database.markFeedSuccess(scopedFeed.id, {
    httpStatus: 200,
    etag: null,
    lastModified: null,
    pollIntervalMinutes: 20,
    parsed: {
      title: "Scoped feed",
      siteUrl: null,
      articles: [
        article("alpha-rust", "Alpha Rust", "Egor", "2026-07-16T12:00:00.000Z"),
        article("alpha-only", "Alpha only", "Someone", "2026-07-16T11:00:00.000Z"),
        article("rust-report", "Rust report", "Egor", "2026-07-16T10:00:00.000Z"),
        article("rust-only", "Rust only", "Someone", "2026-07-16T09:00:00.000Z"),
        article("other", "Other", "Egor", "2026-07-16T08:00:00.000Z"),
        article("plain", "Plain", "Someone", "2026-07-16T07:00:00.000Z"),
      ],
    },
  });
  database.markFeedSuccess(outsideFeed.id, {
    httpStatus: 200,
    etag: null,
    lastModified: null,
    pollIntervalMinutes: 20,
    parsed: {
      title: "Outside feed",
      siteUrl: null,
      articles: [
        article("outside-unmatched", "Outside unmatched", "Someone", "2026-07-16T06:00:00.000Z"),
      ],
    },
  });

  return {
    database,
    folderId: folder.id,
    scopedFeedId: scopedFeed.id,
    outsideFeedId: outsideFeed.id,
  };
}

function titles(database: AppDatabase, state: "all" | "unread" = "all"): string[] {
  return database.listArticles(TEST_USER_ID, { state }).map((candidate) => candidate.title);
}

describe("article filtering rules", () => {
  it("applies one AND or OR operator to every condition and leaves articles outside scope alone", () => {
    const { database, folderId, scopedFeedId, outsideFeedId } = seededDatabase();
    const conditions = [
      { field: "title" as const, pattern: "alpha" },
      { field: "author" as const, pattern: "egor" },
    ];

    const rule = database.createRule(TEST_USER_ID, {
      name: "Focused topics",
      feedId: scopedFeedId,
      conditions,
      conditionOperator: "and",
      action: "keep",
    });

    expect(rule).toMatchObject({
      conditions,
      conditionOperator: "and",
      matchedCount: 1,
    });
    expect(titles(database)).toEqual(["Alpha Rust", "Outside unmatched"]);
    expect(database.getBootstrap(TEST_USER_ID).counts).toEqual({ unread: 2, starred: 0, all: 2 });
    expect(database.getFeed(TEST_USER_ID, scopedFeedId)).toMatchObject({
      unreadCount: 1,
      totalCount: 1,
    });
    expect(database.getFeed(TEST_USER_ID, outsideFeedId)).toMatchObject({
      unreadCount: 1,
      totalCount: 1,
    });
    expect(database.getFolder(TEST_USER_ID, folderId)).toMatchObject({ unreadCount: 1 });

    const updated = database.updateRule(TEST_USER_ID, rule.id, { conditionOperator: "or" });

    expect(updated).toMatchObject({ conditionOperator: "or", matchedCount: 4 });
    expect(titles(database)).toEqual([
      "Alpha Rust",
      "Alpha only",
      "Rust report",
      "Other",
      "Outside unmatched",
    ]);
    expect(database.getBootstrap(TEST_USER_ID).counts).toEqual({ unread: 5, starred: 0, all: 5 });
    expect(database.getFeed(TEST_USER_ID, scopedFeedId)).toMatchObject({
      unreadCount: 4,
      totalCount: 4,
    });
    expect(database.getFolder(TEST_USER_ID, folderId)).toMatchObject({ unreadCount: 4 });
  });

  it("unites applicable keep rules, lets matching hide rules win, and ignores disabled keep rules", () => {
    const { database, folderId, scopedFeedId } = seededDatabase();
    const keepAlpha = database.createRule(TEST_USER_ID, {
      name: "Keep Alpha",
      feedId: scopedFeedId,
      conditions: [{ field: "title", pattern: "alpha" }],
      conditionOperator: "and",
      action: "keep",
    });
    const keepEgor = database.createRule(TEST_USER_ID, {
      name: "Keep Egor",
      folderId,
      conditions: [{ field: "author", pattern: "egor" }],
      conditionOperator: "and",
      action: "keep",
    });

    expect(keepAlpha.matchedCount).toBe(2);
    expect(keepEgor.matchedCount).toBe(3);
    expect(titles(database)).toEqual([
      "Alpha Rust",
      "Alpha only",
      "Rust report",
      "Other",
      "Outside unmatched",
    ]);

    database.createRule(TEST_USER_ID, {
      name: "Hide Rust",
      folderId,
      conditions: [{ field: "title", pattern: "rust" }],
      conditionOperator: "and",
      action: "hide",
    });

    expect(titles(database)).toEqual(["Alpha only", "Other", "Outside unmatched"]);
    expect(database.getBootstrap(TEST_USER_ID).counts).toEqual({ unread: 3, starred: 0, all: 3 });
    expect(database.getFeed(TEST_USER_ID, scopedFeedId)).toMatchObject({
      unreadCount: 2,
      totalCount: 2,
    });

    expect(database.updateRule(TEST_USER_ID, keepEgor.id, { enabled: false })).toMatchObject({
      enabled: false,
      matchedCount: 3,
    });
    expect(titles(database)).toEqual(["Alpha only", "Outside unmatched"]);

    expect(database.updateRule(TEST_USER_ID, keepAlpha.id, { enabled: false })).toMatchObject({
      enabled: false,
      matchedCount: 2,
    });
    expect(titles(database)).toEqual(["Alpha only", "Other", "Plain", "Outside unmatched"]);
    expect(database.getBootstrap(TEST_USER_ID).counts).toEqual({ unread: 4, starred: 0, all: 4 });
  });

  it("uses the same multi-condition matcher when marking articles as read", () => {
    const { database, scopedFeedId } = seededDatabase();

    const rule = database.createRule(TEST_USER_ID, {
      name: "Read Rust by Egor",
      feedId: scopedFeedId,
      conditions: [
        { field: "title", pattern: "rust" },
        { field: "author", pattern: "egor" },
      ],
      conditionOperator: "and",
      action: "mark_read",
    });

    expect(rule.matchedCount).toBe(2);
    expect(titles(database)).toEqual([
      "Alpha Rust",
      "Alpha only",
      "Rust report",
      "Rust only",
      "Other",
      "Plain",
      "Outside unmatched",
    ]);
    expect(titles(database, "unread")).toEqual([
      "Alpha only",
      "Rust only",
      "Other",
      "Plain",
      "Outside unmatched",
    ]);
    expect(database.getBootstrap(TEST_USER_ID).counts).toEqual({ unread: 5, starred: 0, all: 7 });
  });
});

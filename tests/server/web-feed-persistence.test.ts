import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AppDatabase, type ParsedFeed } from "../../src/server/db.js";
import type { WebFeedConfig } from "../../src/shared/types.js";

const directories: string[] = [];
const TEST_USER_ID = 1;

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function temporaryDatabase(): Promise<AppDatabase> {
  const directory = await mkdtemp(join(tmpdir(), "echovale-web-feed-test-"));
  directories.push(directory);
  return new AppDatabase(join(directory, "echovale.db"));
}

function config(pageUrl: string, item = ".card"): WebFeedConfig {
  return {
    pageUrl,
    selectors: {
      item,
      title: "h2",
      link: "a",
      date: "time",
      author: ".author",
      summary: "p",
      image: "img",
    },
    minimumItemCount: 2,
  };
}

function article(externalId: string, title: string, url: string) {
  return {
    externalId,
    title,
    url,
    author: null,
    publishedAt: null,
    summary: `${title} summary`,
    imageUrl: null,
    feedContentHtml: `<p>${title} body</p>`,
  };
}

describe("web feed persistence", () => {
  it("atomically saves selections and refreshes stable items without losing history or state", async () => {
    const database = await temporaryDatabase();
    const pageUrl = "https://example.test/releases";
    try {
      const folder = database.createFolder(TEST_USER_ID, { name: "Releases" });
      const initial: ParsedFeed = {
        title: "Example releases",
        siteUrl: pageUrl,
        articles: [
          article("web:first", "Shared title", "https://example.test/releases/one"),
          article("web:second", "Shared title", "https://example.test/releases/two"),
          article("web:duplicate-link", "Repeated card", "https://example.test/releases/one"),
        ],
      };
      const feed = database.createWebFeed(TEST_USER_ID, {
        title: "Tracked releases",
        pageUrl,
        folderId: folder.id,
        config: config(pageUrl),
        parsed: initial,
      });

      expect(feed).toMatchObject({
        title: "Tracked releases",
        folderId: folder.id,
        sourceKind: "web",
        healthStatus: "healthy",
        lastErrorKind: null,
        lastMatchCount: 3,
        totalCount: 2,
      });
      const record = database.getFeedRecord(feed.id);
      expect(record).toMatchObject({
        sourceKind: "web",
        webConfig: config(pageUrl),
        selectionRevision: 1,
        lastMatchCount: 3,
      });
      if (record?.sourceKind !== "web") throw new Error("Expected a stored web feed config");
      expect(database.getWebFeedConfig(TEST_USER_ID, feed.id)).toEqual(config(pageUrl));
      expect(database.getWebFeedConfig(999, feed.id)).toBeNull();

      const initialArticles = database.listArticles(TEST_USER_ID, {
        state: "all",
        includeContent: true,
      });
      expect(initialArticles).toHaveLength(2);
      expect(initialArticles.map(({ url }) => url)).toEqual([
        "https://example.test/releases/two",
        "https://example.test/releases/one",
      ]);
      for (const stored of initialArticles) {
        expect(stored.publishedAt).toBe(stored.discoveredAt);
      }

      const first = initialArticles.find(({ url }) => url === "https://example.test/releases/one");
      if (!first) throw new Error("Expected the first web article");
      database.updateArticleState(TEST_USER_ID, first.id, { isRead: true, isStarred: true });
      const firstPublishedAt = first.publishedAt;

      const revised: ParsedFeed = {
        title: "Example releases",
        siteUrl: pageUrl,
        articles: [
          {
            ...article("web:first", "Corrected title", "https://example.test/releases/one"),
            summary: "Corrected summary",
          },
          article("web:third", "Corrected title", "https://example.test/releases/three"),
        ],
      };
      expect(
        database.updateWebFeedSelection(
          TEST_USER_ID,
          feed.id,
          config(pageUrl, "article.release"),
          revised,
        ),
      ).toMatchObject({ lastMatchCount: 2, totalCount: 3 });

      expect(database.getFeedRecord(feed.id)).toMatchObject({
        sourceKind: "web",
        webConfig: config(pageUrl, "article.release"),
        selectionRevision: 2,
        lastMatchCount: 2,
      });
      expect(database.getArticle(TEST_USER_ID, first.id)).toMatchObject({
        title: "Corrected title",
        summary: "Corrected summary",
        publishedAt: firstPublishedAt,
        isRead: true,
        isStarred: true,
      });
      expect(
        database
          .listArticles(TEST_USER_ID, { state: "all" })
          .map(({ url }) => url)
          .sort(),
      ).toEqual([
        "https://example.test/releases/one",
        "https://example.test/releases/three",
        "https://example.test/releases/two",
      ]);

      database.markFeedFailure(feed.id, {
        httpStatus: 200,
        error: "Stale selection failed",
        errorKind: "selection_broken",
        healthStatus: "needs_attention",
        retryMinutes: 20,
        expectedSelectionRevision: 1,
      });
      database.markFeedSuccess(feed.id, {
        httpStatus: 200,
        etag: null,
        lastModified: null,
        pollIntervalMinutes: 20,
        parsed: {
          title: "Stale result",
          siteUrl: pageUrl,
          articles: [article("web:stale", "Stale article", "https://example.test/releases/stale")],
        },
        webMatchCount: 1,
        expectedSelectionRevision: 1,
      });
      expect(database.getFeed(TEST_USER_ID, feed.id)).toMatchObject({
        healthStatus: "healthy",
        lastErrorKind: null,
        lastMatchCount: 2,
        totalCount: 3,
      });
      expect(
        database
          .listArticles(TEST_USER_ID, { state: "all" })
          .some(({ url }) => url === "https://example.test/releases/stale"),
      ).toBe(false);

      database.markFeedRefreshing(feed.id);
      database.markFeedFailure(feed.id, {
        httpStatus: null,
        error: "The page could not be reached",
        errorKind: "network",
        healthStatus: "failing",
        retryMinutes: 20,
      });
      expect(database.getFeed(TEST_USER_ID, feed.id)).toMatchObject({
        healthStatus: "failing",
        lastErrorKind: "network",
        lastMatchCount: 2,
        totalCount: 3,
      });
      database.markFeedRefreshing(feed.id);
      expect(database.getFeed(TEST_USER_ID, feed.id)).toMatchObject({
        refreshing: true,
        healthStatus: "failing",
        lastErrorKind: "network",
      });
      database.markFeedFailure(feed.id, {
        httpStatus: 200,
        error: "The saved page selection no longer matches meaningful items",
        errorKind: "selection_broken",
        healthStatus: "needs_attention",
        retryMinutes: 20,
      });
      expect(database.getFeed(TEST_USER_ID, feed.id)).toMatchObject({
        healthStatus: "needs_attention",
        lastErrorKind: "selection_broken",
        lastMatchCount: 0,
        totalCount: 3,
      });

      database.markFeedSuccess(feed.id, {
        httpStatus: 200,
        etag: null,
        lastModified: null,
        pollIntervalMinutes: 20,
        parsed: revised,
        webMatchCount: 2,
      });
      expect(database.getFeed(TEST_USER_ID, feed.id)).toMatchObject({
        healthStatus: "healthy",
        lastErrorKind: null,
        lastError: null,
        lastMatchCount: 2,
        totalCount: 3,
      });

      expect(() =>
        database.updateFeed(TEST_USER_ID, feed.id, {
          feedUrl: "https://example.test/other-page",
        }),
      ).toThrow("Web feed URLs can only be changed by repairing the page selection");
      expect(
        database.updateFeed(TEST_USER_ID, feed.id, { title: "Renamed web feed" }),
      ).toMatchObject({ title: "Renamed web feed", feedUrl: pageUrl });
      expect(database.listOpmlFeeds(TEST_USER_ID)).toEqual([]);

      expect(database.deleteFeed(TEST_USER_ID, feed.id)).toBe(true);
      expect(
        database.sqlite.prepare("SELECT 1 FROM web_feed_configs WHERE feed_id = ?").get(feed.id),
      ).toBeUndefined();
    } finally {
      database.close();
    }
  });

  it("does not create a web feed without a usable initial selection", async () => {
    const database = await temporaryDatabase();
    const pageUrl = "https://example.test/jobs";
    try {
      expect(() =>
        database.createWebFeed(TEST_USER_ID, {
          title: "Jobs",
          pageUrl,
          folderId: null,
          config: config(pageUrl),
          parsed: { title: "Jobs", siteUrl: pageUrl, articles: [] },
        }),
      ).toThrow("The web feed selection did not match any items");
      expect(database.listFeeds(TEST_USER_ID)).toEqual([]);

      const published = database.createFeed(TEST_USER_ID, {
        title: "Published feed",
        feedUrl: "https://example.test/feed.xml",
      });
      expect(published).toMatchObject({
        sourceKind: "published",
        healthStatus: "healthy",
        lastErrorKind: null,
        lastMatchCount: null,
      });
      expect(database.getFeedRecord(published.id)).toMatchObject({
        sourceKind: "published",
        webConfig: null,
      });
      expect(() =>
        database.updateWebFeedSelection(
          TEST_USER_ID,
          published.id,
          config("https://example.test/feed.xml"),
          {
            title: "Not web",
            siteUrl: null,
            articles: [article("one", "One", "https://example.test/one")],
          },
        ),
      ).toThrow("Only web feeds have page selections");
      expect(database.listOpmlFeeds(TEST_USER_ID)).toMatchObject([
        { title: "Published feed", feedUrl: "https://example.test/feed.xml" },
      ]);
    } finally {
      database.close();
    }
  });
});

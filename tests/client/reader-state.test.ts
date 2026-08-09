import { describe, expect, it } from "vitest";
import {
  articleQueryForReaderRoute,
  articleSettingsInvalidation,
  filterRuleName,
  fullContentIdsAfterReload,
  invalidateArticleSummaries,
  readerRouteForSelection,
  readerScopeLabel,
  readerScopeUnreadCount,
  refreshFeedIds,
  shouldAutoMarkRoutedArticleRead,
  updateBootstrapCounts,
} from "../../src/client/reader-state.js";
import type { Article, BootstrapData, Feed, Folder } from "../../src/shared/types.js";

function folder(id: number, parentId: number | null, name: string): Folder {
  return {
    id,
    parentId,
    name,
    position: id,
    sortDirection: "newest",
    unreadCount: 1,
  };
}

function feed(id: number, folderId: number | null, title: string): Feed {
  return {
    id,
    folderId,
    title,
    feedUrl: `https://example.test/${id}.xml`,
    siteUrl: null,
    sourceKind: "published",
    healthStatus: "healthy",
    lastErrorKind: null,
    lastMatchCount: null,
    createdAt: "2026-07-28T12:00:00.000Z",
    pollIntervalMinutes: 20,
    unreadCount: 1,
    totalCount: 1,
    paused: false,
    refreshing: false,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastHttpStatus: null,
    lastError: null,
    nextPollAt: null,
  };
}

function bootstrap(): BootstrapData {
  return {
    folders: [folder(1, null, "Engineering"), folder(2, 1, "Frontend"), folder(3, null, "Cooking")],
    feeds: [
      feed(10, 1, "Platform"),
      feed(11, 2, "Interfaces"),
      feed(12, 3, "Recipes"),
      feed(13, null, "Loose notes"),
    ],
    settings: {
      pollIntervalMinutes: 20,
      duplicateArticleWindowDays: 7,
      singleKeyShortcuts: true,
      markReadOnScroll: true,
      showYouTubeDescriptions: false,
      translationLanguage: "English",
      summaryPrompt: "Summarize",
      translationPrompt: "Translate",
      customPrompts: [],
    },
    aiSettings: {
      credentialStorageAvailable: false,
      providers: [],
      features: { articleSummary: null },
    },
    counts: { unread: 1, starred: 0, all: 4 },
  };
}

const article: Article = {
  id: 100,
  feedId: 11,
  feedTitle: "Interfaces",
  feedSourceKind: "published",
  folderId: 2,
  title: "A useful article",
  url: "https://example.test/article",
  author: null,
  publishedAt: null,
  discoveredAt: "2026-07-28T12:00:00.000Z",
  summary: "",
  imageUrl: null,
  media: null,
  feedContentHtml: null,
  contentHtml: null,
  contentSource: null,
  extractionStatus: "feed",
  extractionError: null,
  aiSummary: null,
  isRead: false,
  isStarred: false,
};

function summarizedArticle(id: number, promptId: string | null): Article {
  return {
    ...article,
    id,
    aiSummary: {
      text: "Summary",
      promptId,
      provider: "openai",
      model: "example-model",
      sourceKind: "feed",
      generatedAt: "2026-07-28T12:00:00.000Z",
      usage: { inputTokens: null, outputTokens: null },
      grounding: null,
    },
  };
}

describe("reader state", () => {
  it("builds one canonical route and API query for each reader scope", () => {
    const route = readerRouteForSelection("starred", null, 2, "design systems");
    expect(route).toEqual({
      kind: "reader",
      scope: "folder",
      scopeId: 2,
      state: "starred",
      search: "design systems",
    });
    expect(
      articleQueryForReaderRoute(route, {
        limit: 20,
        includeContent: true,
        cursor: "next-page",
      }),
    ).toEqual({
      state: "starred",
      folderId: 2,
      search: "design systems",
      limit: 20,
      includeContent: true,
      cursor: "next-page",
    });

    expect(readerRouteForSelection("unread", 10, 2, "").scope).toBe("feed");
    expect(readerRouteForSelection("all", null, null, "").scope).toBe("all");
  });

  it("targets explicit feeds, nested folder feeds, or every feed for refresh", () => {
    const data = bootstrap();
    expect(refreshFeedIds(data, 12, 1)).toEqual([12]);
    expect(refreshFeedIds(data, null, 1)).toEqual([10, 11]);
    expect(refreshFeedIds(data, null, null)).toBeUndefined();
  });

  it("tracks which replacement records still have full article content", () => {
    const articles = [
      { ...article, id: 1 },
      { ...article, id: 2 },
    ];

    expect(fullContentIdsAfterReload("magazine", articles, null)).toEqual(new Set());
    expect(fullContentIdsAfterReload("magazine", articles, 2)).toEqual(new Set([2]));
    expect(fullContentIdsAfterReload("expanded", articles, null)).toEqual(new Set([1, 2]));
  });

  it("keeps an open article unread after the reader explicitly marks it unread", () => {
    expect(shouldAutoMarkRoutedArticleRead(article, article.id, new Set())).toBe(true);
    expect(shouldAutoMarkRoutedArticleRead(article, article.id, new Set([article.id]))).toBe(false);
    expect(
      shouldAutoMarkRoutedArticleRead({ ...article, isRead: true }, article.id, new Set()),
    ).toBe(false);
  });

  it("updates only the affected counters and never makes a count negative", () => {
    const updated = updateBootstrapCounts(bootstrap(), article, -2, 1);
    expect(updated.counts).toEqual({ unread: 0, starred: 1, all: 4 });
    expect(updated.feeds.map(({ id, unreadCount }) => [id, unreadCount])).toEqual([
      [10, 1],
      [11, 0],
      [12, 1],
      [13, 1],
    ]);
    expect(updated.folders.map(({ id, unreadCount }) => [id, unreadCount])).toEqual([
      [1, 1],
      [2, 0],
      [3, 1],
    ]);
  });

  it("invalidates only AI output affected by changed reader settings", () => {
    const previous = {
      ...bootstrap().settings,
      customPrompts: [
        { id: "changed", name: "Changed", prompt: "Old instructions" },
        { id: "kept", name: "Kept", prompt: "Stable instructions" },
      ],
    };
    const next = {
      ...previous,
      summaryPrompt: "A new default summary prompt",
      translationLanguage: "Polish",
      customPrompts: [
        { id: "changed", name: "Changed", prompt: "New instructions" },
        { id: "kept", name: "Renamed only", prompt: "Stable instructions" },
      ],
    };

    const invalidation = articleSettingsInvalidation(previous, next);
    expect(invalidation.resetTranslationState).toBe(true);
    expect([...invalidation.invalidatedSummaryPromptIds]).toEqual([null, "changed"]);

    const articles = [
      summarizedArticle(1, null),
      summarizedArticle(2, "changed"),
      summarizedArticle(3, "kept"),
    ];
    expect(
      invalidateArticleSummaries(articles, invalidation.invalidatedSummaryPromptIds).map((item) =>
        item.aiSummary ? (item.aiSummary.promptId ?? "default") : "removed",
      ),
    ).toEqual(["removed", "removed", "kept"]);

    const unchanged = articleSettingsInvalidation(previous, previous);
    expect(unchanged.resetTranslationState).toBe(false);
    expect(invalidateArticleSummaries(articles, unchanged.invalidatedSummaryPromptIds)).toBe(
      articles,
    );
  });

  it("derives stable labels for reader scopes and generated filter rules", () => {
    const data = bootstrap();
    expect(readerScopeLabel(data, 11, null, "unread")).toBe("Interfaces");
    expect(readerScopeLabel(data, null, 1, "starred")).toBe("Engineering");
    expect(readerScopeLabel(data, null, null, "unread")).toBe("Feed");
    expect(readerScopeLabel(data, null, null, "all")).toBe("Feed");
    expect(readerScopeLabel(data, null, null, "read")).toBe("Read");
    expect(readerScopeLabel(data, null, null, "starred")).toBe("Saved");
    expect(readerScopeLabel(data, 999, null, "all")).toBe("Feed");
    expect(filterRuleName("x".repeat(100))).toBe(`Filter: ${"x".repeat(71)}…`);
  });

  it("reports unread counts for the active reader scope", () => {
    const data = bootstrap();
    data.counts.unread = 9;
    data.feeds[1] = { ...data.feeds[1], unreadCount: 4 };
    data.folders[0] = { ...data.folders[0], unreadCount: 7 };

    expect(readerScopeUnreadCount(data, null, null)).toBe(9);
    expect(readerScopeUnreadCount(data, 11, null)).toBe(4);
    expect(readerScopeUnreadCount(data, null, 1)).toBe(7);
  });
});

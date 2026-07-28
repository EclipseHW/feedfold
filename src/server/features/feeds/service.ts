import type Sqlite from "better-sqlite3";
import type { Feed, WebFeedConfig } from "../../../shared/types.js";
import type { ArticleRepository } from "../articles/repository.js";
import type { FolderRepository } from "../folders/repository.js";
import type { RuleRepository } from "../rules/repository.js";
import { type FeedRecord, type ParsedFeed, WEB_FEED_POLL_INTERVAL_MINUTES } from "../shared.js";
import { FeedIngestionService, type SuccessfulFeedRefresh } from "./ingestion-service.js";
import type { FeedRepository } from "./repository.js";

export class FeedService {
  private readonly ingestion: FeedIngestionService;

  constructor(
    private readonly sqlite: Sqlite.Database,
    private readonly repository: FeedRepository,
    private readonly folders: FolderRepository,
    private readonly articles: ArticleRepository,
    private readonly rules: RuleRepository,
  ) {
    this.ingestion = new FeedIngestionService(sqlite, repository, articles, rules);
  }

  listFeeds(userId: number): Feed[] {
    return this.repository.listFeeds(userId);
  }

  getFeed(userId: number, id: number): Feed | null {
    return this.repository.getFeed(userId, id);
  }

  createFeed(
    userId: number,
    input: {
      feedUrl: string;
      title?: string;
      siteUrl?: string | null;
      folderId?: number | null;
      paused?: boolean;
    },
  ): Feed {
    return this.repository.createFeed(userId, input);
  }

  createWebFeed(
    userId: number,
    input: {
      title: string;
      pageUrl: string;
      folderId: number | null;
      config: WebFeedConfig;
      parsed: ParsedFeed;
    },
  ): Feed {
    this.folders.assertFolderExists(userId, input.folderId);
    if (input.parsed.articles.length === 0) {
      throw new Error("The web feed selection did not match any items");
    }
    const pageUrl = new URL(input.pageUrl).toString();
    const config = { ...input.config, pageUrl: new URL(input.config.pageUrl).toString() };
    if (config.pageUrl !== pageUrl) {
      throw new Error("The web feed selection belongs to a different page");
    }

    return this.sqlite.transaction(() => {
      const feedId = this.repository.createWebFeedRecord(userId, {
        ...input,
        pageUrl,
        config,
      });
      this.ingestion.completeRefresh(feedId, {
        httpStatus: 200,
        etag: null,
        lastModified: null,
        pollIntervalMinutes: WEB_FEED_POLL_INTERVAL_MINUTES,
        parsed: input.parsed,
        webMatchCount: input.parsed.articles.length,
      });
      return this.repository.getFeed(userId, feedId) as Feed;
    })();
  }

  updateWebFeedSelection(
    userId: number,
    id: number,
    configInput: WebFeedConfig,
    parsed: ParsedFeed,
  ): Feed | null {
    const existing = this.repository.getFeed(userId, id);
    if (!existing) return null;
    if (existing.sourceKind !== "web") throw new Error("Only web feeds have page selections");
    if (parsed.articles.length === 0) {
      throw new Error("The web feed selection did not match any items");
    }
    const config = { ...configInput, pageUrl: new URL(configInput.pageUrl).toString() };

    return this.sqlite.transaction(() => {
      this.repository.updateWebFeedSelectionRecord(id, config, parsed);
      this.ingestion.completeRefresh(id, {
        httpStatus: 200,
        etag: null,
        lastModified: null,
        pollIntervalMinutes: existing.pollIntervalMinutes,
        parsed,
        webMatchCount: parsed.articles.length,
      });
      return this.repository.getFeed(userId, id);
    })();
  }

  updateFeed(
    userId: number,
    id: number,
    input: {
      title?: string;
      feedUrl?: string;
      siteUrl?: string | null;
      folderId?: number | null;
      paused?: boolean;
    },
  ): Feed | null {
    const existing = this.repository.getFeed(userId, id);
    if (!existing) return null;
    return this.sqlite.transaction(() => {
      const updated = this.repository.updateFeed(userId, id, input);
      if (updated && input.folderId !== undefined && input.folderId !== existing.folderId) {
        this.rules.recomputeRulesForArticles(this.articles.listFeedArticleIds(id));
      }
      return updated;
    })();
  }

  deleteFeed(userId: number, id: number): boolean {
    return this.repository.deleteFeed(userId, id);
  }

  getFeedRecord(id: number): FeedRecord | null {
    return this.repository.getFeedRecord(id);
  }

  getWebFeedConfig(userId: number, id: number): WebFeedConfig | null {
    return this.repository.getWebFeedConfig(userId, id);
  }

  getRefreshCandidates(ids?: number[]): FeedRecord[] {
    return this.repository.getRefreshCandidates(ids);
  }

  getUserRefreshFeedIds(userId: number, requestedIds?: number[]): number[] {
    return this.repository.getUserRefreshFeedIds(userId, requestedIds);
  }

  getDueFeedIds(at?: string): number[] {
    return this.repository.getDueFeedIds(at);
  }

  markRefreshing(id: number): void {
    this.repository.markFeedRefreshing(id);
  }

  completeRefresh(id: number, input: SuccessfulFeedRefresh): boolean {
    return this.ingestion.completeRefresh(id, input);
  }

  failRefresh(id: number, input: Parameters<FeedRepository["markFeedFailure"]>[1]): void {
    this.repository.markFeedFailure(id, input);
  }

  listOpmlFeeds(userId: number): Array<{
    title: string;
    feedUrl: string;
    siteUrl: string | null;
    folderId: number | null;
  }> {
    return this.repository.listOpmlFeeds(userId);
  }
}

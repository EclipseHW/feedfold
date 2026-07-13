import type { RefreshResult } from "../shared/types.js";
import type { AppDatabase, FeedRecord } from "./db.js";
import type { ExtractionQueue } from "./extraction.js";
import { parseAndNormalizeFeed } from "./feed-parser.js";

class FeedHttpError extends Error {
  constructor(readonly status: number) {
    super(`Feed request returned HTTP ${status}`);
  }
}

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

export class FeedRefreshService {
  private readonly pending: FeedRecord[] = [];
  private readonly requestedIds = new Set<number>();
  private active = 0;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private idleResolvers: Array<() => void> = [];

  constructor(
    private readonly database: AppDatabase,
    private readonly extractionQueue: ExtractionQueue,
    private readonly concurrency = 3,
    private readonly timeoutMs = 15_000,
  ) {}

  start(): void {
    if (this.stopped || this.timer) return;
    void this.request(this.database.getDueFeedIds());
    this.timer = setInterval(() => {
      void this.request(this.database.getDueFeedIds());
    }, 30_000);
    this.timer.unref();
  }

  request(feedIds?: number[]): RefreshResult {
    if (this.stopped) return { requested: 0, refreshingFeedIds: [] };
    const candidates = this.database.getRefreshCandidates(feedIds);
    const accepted = candidates.filter((feed) => !this.requestedIds.has(feed.id));
    for (const feed of accepted) {
      this.requestedIds.add(feed.id);
      this.database.markFeedRefreshing(feed.id);
      this.pending.push(feed);
    }
    this.pump();
    return { requested: accepted.length, refreshingFeedIds: accepted.map((feed) => feed.id) };
  }

  private pump(): void {
    while (!this.stopped && this.active < this.concurrency && this.pending.length > 0) {
      const feed = this.pending.shift();
      if (!feed) break;
      this.active += 1;
      void this.refresh(feed).finally(() => {
        this.active -= 1;
        this.requestedIds.delete(feed.id);
        this.pump();
        this.resolveIdleIfNeeded();
      });
    }
    this.resolveIdleIfNeeded();
  }

  private async refresh(feed: FeedRecord): Promise<void> {
    let httpStatus: number | null = null;
    try {
      const headers = new Headers({
        Accept:
          "application/atom+xml,application/rss+xml,application/feed+json,application/json;q=0.9,application/xml;q=0.8,text/xml;q=0.8,*/*;q=0.5",
        "User-Agent": "Echovale/0.1 (+self-hosted RSS reader)",
      });
      if (feed.etag) headers.set("If-None-Match", feed.etag);
      if (feed.lastModified) headers.set("If-Modified-Since", feed.lastModified);
      const response = await fetch(feed.feedUrl, {
        headers,
        redirect: "follow",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      httpStatus = response.status;
      const settings = this.database.getSettings();
      if (response.status === 304) {
        this.database.markFeedSuccess(feed.id, {
          httpStatus: response.status,
          etag: response.headers.get("etag"),
          lastModified: response.headers.get("last-modified"),
          pollIntervalMinutes: settings.pollIntervalMinutes,
        });
        return;
      }
      if (!response.ok) throw new FeedHttpError(response.status);
      const source = await response.text();
      const parsed = parseAndNormalizeFeed(source, response.url || feed.feedUrl);
      const articleIds = this.database.markFeedSuccess(feed.id, {
        httpStatus: response.status,
        etag: response.headers.get("etag"),
        lastModified: response.headers.get("last-modified"),
        pollIntervalMinutes: settings.pollIntervalMinutes,
        parsed,
      });
      this.extractionQueue.enqueue(articleIds);
    } catch (error) {
      const retryMinutes = this.database.getSettings().pollIntervalMinutes;
      this.database.markFeedFailure(feed.id, {
        httpStatus: error instanceof FeedHttpError ? error.status : httpStatus,
        error: message(error),
        retryMinutes,
      });
    }
  }

  async waitForIdle(): Promise<void> {
    if (this.pending.length === 0 && this.active === 0) return;
    await new Promise<void>((resolve) => this.idleResolvers.push(resolve));
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const feed of this.pending.splice(0)) {
      this.requestedIds.delete(feed.id);
      this.database.markFeedFailure(feed.id, {
        httpStatus: null,
        error: "Refresh stopped during server shutdown",
        retryMinutes: this.database.getSettings().pollIntervalMinutes,
      });
    }
    await this.waitForIdle();
  }

  private resolveIdleIfNeeded(): void {
    if (this.pending.length > 0 || this.active > 0) return;
    const resolvers = this.idleResolvers;
    this.idleResolvers = [];
    for (const resolve of resolvers) resolve();
  }
}

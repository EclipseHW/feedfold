import type { RefreshResult } from "../shared/types.js";
import type { AppDatabase, FeedRecord, ParsedFeed } from "./db.js";
import type { ExtractionQueue } from "./extraction.js";
import { parseAndNormalizeFeed, parseAndNormalizeWordPressPosts } from "./feed-parser.js";

const USER_AGENT = "Echovale/0.1 (+self-hosted RSS reader)";

class FeedHttpError extends Error {
  constructor(
    readonly status: number,
    detail?: string,
  ) {
    super(detail ?? `Feed request returned HTTP ${status}`);
  }
}

function browserVerificationProvider(response: Response, source: string | null): string | null {
  if (response.headers.get("cf-mitigated") === "challenge") return "Cloudflare";
  if (response.headers.get("x-vercel-mitigated") === "challenge") return "Vercel";
  if (
    source?.includes("Imunify360 bot-protection") ||
    (source?.includes("One moment, please") &&
      source.includes("Please wait while your request is being verified"))
  ) {
    return "Imunify360";
  }
  return null;
}

function wordpressPostsUrl(feedUrl: string): string | null {
  const url = new URL(feedUrl);
  if (url.pathname.replace(/\/+$/, "") !== "/feed" && url.searchParams.get("feed") !== "rss2") {
    return null;
  }
  url.pathname = "/wp-json/wp/v2/posts";
  url.search = new URLSearchParams({
    per_page: "20",
    _fields: "id,guid,date_gmt,link,title,excerpt,content",
  }).toString();
  url.hash = "";
  return url.toString();
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
        "User-Agent": USER_AGENT,
      });
      if (feed.etag) headers.set("If-None-Match", feed.etag);
      if (feed.lastModified) headers.set("If-Modified-Since", feed.lastModified);
      let response = await fetch(feed.feedUrl, {
        headers,
        redirect: "follow",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      httpStatus = response.status;
      if (response.status === 304) {
        this.database.markFeedSuccess(feed.id, {
          httpStatus: response.status,
          etag: response.headers.get("etag"),
          lastModified: response.headers.get("last-modified"),
          pollIntervalMinutes: feed.pollIntervalMinutes,
        });
        return;
      }
      let source = response.ok ? await response.text() : null;
      const verificationProvider = browserVerificationProvider(response, source);
      let parsed: ParsedFeed | null = null;
      if (verificationProvider || response.status === 415) {
        const fallback = await this.fetchWordPressPosts(feed, response.url || feed.feedUrl);
        if (fallback) {
          response = fallback.response;
          httpStatus = response.status;
          parsed = fallback.parsed;
          source = null;
        } else if (verificationProvider) {
          throw new FeedHttpError(
            response.status,
            `Feed host requires browser verification (${verificationProvider}); automated refresh cannot access this URL`,
          );
        }
      }
      if (!parsed) {
        if (!response.ok) throw new FeedHttpError(response.status);
        parsed = parseAndNormalizeFeed(
          source ?? (await response.text()),
          response.url || feed.feedUrl,
        );
      }
      const articleIds = this.database.markFeedSuccess(feed.id, {
        httpStatus: response.status,
        etag: response.headers.get("etag"),
        lastModified: response.headers.get("last-modified"),
        pollIntervalMinutes: feed.pollIntervalMinutes,
        parsed,
      });
      this.extractionQueue.enqueue(articleIds);
    } catch (error) {
      this.database.markFeedFailure(feed.id, {
        httpStatus: error instanceof FeedHttpError ? error.status : httpStatus,
        error: message(error),
        retryMinutes: feed.pollIntervalMinutes,
      });
    }
  }

  private async fetchWordPressPosts(
    feed: FeedRecord,
    feedUrl: string,
  ): Promise<{ response: Response; parsed: ParsedFeed } | null> {
    const url = wordpressPostsUrl(feedUrl);
    if (!url) return null;
    const response = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": USER_AGENT },
      redirect: "follow",
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) return null;
    return {
      response,
      parsed: parseAndNormalizeWordPressPosts(await response.text(), feedUrl, feed.title),
    };
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
        retryMinutes: feed.pollIntervalMinutes,
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

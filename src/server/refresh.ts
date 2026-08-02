import type { FeedErrorKind, FeedHealthStatus, RefreshResult } from "../shared/types.js";
import type { FeedService } from "./features/feeds/service.js";
import type { FeedRecord, ParsedFeed } from "./features/shared.js";
import { fetchFeed, nitterFeedUrl } from "./feed-http.js";
import { parseAndNormalizeFeed, parseAndNormalizeWordPressPosts } from "./feed-parser.js";
import { parseAndNormalizeTelegramFeed, telegramChannelUrls } from "./telegram-feed.js";
import { WebFeedError, type WebFeedService } from "./web-feed.js";

const USER_AGENT = "echovale/0.1 (+self-hosted feed reader)";

class FeedHttpError extends Error {
  constructor(
    readonly status: number,
    detail?: string,
    readonly kind: FeedErrorKind = status === 401 || status === 403 ? "inaccessible" : "http",
  ) {
    super(detail ?? `The feed returned HTTP ${status}.`);
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

function failureDetails(
  error: unknown,
  sourceKind: FeedRecord["sourceKind"],
  httpStatus: number | null,
): {
  httpStatus: number | null;
  errorKind: FeedErrorKind;
  healthStatus: FeedHealthStatus;
} {
  if (sourceKind === "web" && error instanceof WebFeedError) {
    return {
      httpStatus: error.httpStatus ?? httpStatus,
      errorKind: error.kind,
      healthStatus: error.kind === "selection_broken" ? "needs_attention" : "failing",
    };
  }
  if (error instanceof FeedHttpError) {
    return { httpStatus: error.status, errorKind: error.kind, healthStatus: "failing" };
  }
  if (
    error instanceof DOMException &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  ) {
    return { httpStatus, errorKind: "timeout", healthStatus: "failing" };
  }
  return {
    httpStatus,
    errorKind: httpStatus === null ? "network" : "parse",
    healthStatus: "failing",
  };
}

export class FeedRefreshService {
  private readonly pending: FeedRecord[] = [];
  private readonly requestedIds = new Set<number>();
  private active = 0;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private idleResolvers: Array<() => void> = [];

  constructor(
    private readonly feeds: FeedService,
    private readonly concurrency = 3,
    private readonly timeoutMs = 15_000,
    private readonly webFeedService?: WebFeedService,
    private readonly feedFetcher: typeof fetchFeed = fetchFeed,
  ) {}

  start(): void {
    if (this.stopped || this.timer) return;
    void this.request(this.feeds.getDueFeedIds());
    this.timer = setInterval(() => {
      void this.request(this.feeds.getDueFeedIds());
    }, 30_000);
    this.timer.unref();
  }

  request(feedIds?: number[]): RefreshResult {
    if (this.stopped) return { requested: 0, refreshingFeedIds: [] };
    const candidates = this.feeds.getRefreshCandidates(feedIds);
    const accepted = candidates.filter((feed) => !this.requestedIds.has(feed.id));
    for (const feed of accepted) {
      this.requestedIds.add(feed.id);
      this.feeds.markRefreshing(feed.id);
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
      if (feed.sourceKind === "web") {
        if (!this.webFeedService) {
          this.feeds.failRefresh(feed.id, {
            httpStatus: null,
            error: "Web feed loading is unavailable. Check the server's Chromium setup.",
            errorKind: "unsupported_content",
            healthStatus: "failing",
            retryMinutes: feed.pollIntervalMinutes,
            expectedSelectionRevision: feed.selectionRevision,
          });
          return;
        }
        const result = await this.webFeedService.extract(feed.webConfig);
        httpStatus = result.httpStatus;
        this.feeds.completeRefresh(feed.id, {
          httpStatus: result.httpStatus ?? 200,
          etag: null,
          lastModified: null,
          pollIntervalMinutes: feed.pollIntervalMinutes,
          parsed: result.parsed,
          webMatchCount: result.matchCount,
          expectedSelectionRevision: feed.selectionRevision,
        });
        return;
      }

      const telegram = telegramChannelUrls(feed.feedUrl);
      const sourceUrl = telegram?.previewUrl ?? nitterFeedUrl(feed.feedUrl) ?? feed.feedUrl;
      const headers = new Headers({
        Accept:
          "application/atom+xml,application/rss+xml,application/feed+json,application/json;q=0.9,application/xml;q=0.8,text/xml;q=0.8,*/*;q=0.5",
        "User-Agent": USER_AGENT,
      });
      if (feed.etag) headers.set("If-None-Match", feed.etag);
      if (feed.lastModified) headers.set("If-Modified-Since", feed.lastModified);
      let response = await this.feedFetcher(sourceUrl, {
        headers,
        redirect: "follow",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      httpStatus = response.status;
      if (response.status === 304) {
        this.feeds.completeRefresh(feed.id, {
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
            `This feed requires browser verification from ${verificationProvider}, so echovale cannot refresh it automatically.`,
            "access_blocked",
          );
        }
      }
      if (!parsed) {
        if (!response.ok) throw new FeedHttpError(response.status);
        const feedSource = source ?? (await response.text());
        parsed = telegram
          ? parseAndNormalizeTelegramFeed(feedSource, telegram.channelUrl)
          : parseAndNormalizeFeed(feedSource, response.url || sourceUrl);
      }
      this.feeds.completeRefresh(feed.id, {
        httpStatus: response.status,
        etag: response.headers.get("etag"),
        lastModified: response.headers.get("last-modified"),
        pollIntervalMinutes: feed.pollIntervalMinutes,
        parsed,
      });
    } catch (error) {
      const failure = failureDetails(error, feed.sourceKind, httpStatus);
      this.feeds.failRefresh(feed.id, {
        ...failure,
        error: message(error),
        retryMinutes: feed.pollIntervalMinutes,
        expectedSelectionRevision: feed.sourceKind === "web" ? feed.selectionRevision : undefined,
      });
    }
  }

  private async fetchWordPressPosts(
    feed: FeedRecord,
    feedUrl: string,
  ): Promise<{ response: Response; parsed: ParsedFeed } | null> {
    const url = wordpressPostsUrl(feedUrl);
    if (!url) return null;
    const response = await this.feedFetcher(url, {
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
      this.feeds.failRefresh(feed.id, {
        httpStatus: null,
        error: "The refresh stopped because the server shut down. Refresh the feed again.",
        errorKind: "network",
        healthStatus: "failing",
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

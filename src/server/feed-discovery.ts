import { JSDOM } from "jsdom";
import type { FeedPreview } from "../shared/types.js";
import type { ParsedFeed } from "./db.js";
import { fetchFeed, nitterFeedUrl } from "./feed-http.js";
import { parseAndNormalizeFeed } from "./feed-parser.js";
import { parseAndNormalizeTelegramFeed, telegramChannelUrls } from "./telegram-feed.js";

const USER_AGENT = "Echovale/0.1 (+self-hosted RSS reader)";
const FEED_ACCEPT =
  "application/atom+xml,application/rss+xml,application/feed+json,application/json;q=0.9,application/xml;q=0.8,text/xml;q=0.8,text/html;q=0.7,*/*;q=0.5";
const FEED_MIME_TYPES = new Set([
  "application/atom+xml",
  "application/feed+json",
  "application/json",
  "application/rss+xml",
  "application/xml",
  "text/xml",
]);
const COMMON_FEED_PATHS = ["/feed", "/rss.xml", "/feed.xml", "/atom.xml", "/index.xml"];
const PREVIEW_ARTICLE_LIMIT = 3;

export class FeedDiscoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FeedDiscoveryError";
  }
}

function preview(parsed: ParsedFeed, feedUrl: string): FeedPreview {
  return {
    feedUrl,
    title: parsed.title,
    siteUrl: parsed.siteUrl,
    totalArticles: parsed.articles.length,
    articles: parsed.articles.slice(0, PREVIEW_ARTICLE_LIMIT).map((article) => ({
      title: article.title,
      url: article.url,
      author: article.author,
      publishedAt: article.publishedAt,
      summary: article.summary,
      imageUrl: article.imageUrl,
    })),
  };
}

function parsePreview(source: string, feedUrl: string): FeedPreview | null {
  try {
    return preview(parseAndNormalizeFeed(source, feedUrl), feedUrl);
  } catch {
    return null;
  }
}

function isFeedReference(value: string): boolean {
  return /(^|[^a-z])(rss|atom|feed)([^a-z]|$)/i.test(value) || /\.xml(?:[?#]|$)/i.test(value);
}

function resolvedHttpUrl(value: string, baseUrl: string): string | null {
  try {
    const url = new URL(value, baseUrl);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function feedCandidates(source: string, pageUrl: string): string[] {
  const candidates: string[] = [];
  const seen = new Set([new URL(pageUrl).toString()]);
  const add = (value: string | null): void => {
    if (!value || seen.has(value)) return;
    seen.add(value);
    candidates.push(value);
  };
  const dom = new JSDOM(source, { url: pageUrl });
  try {
    for (const link of dom.window.document.querySelectorAll<HTMLLinkElement>(
      'link[rel~="alternate"][href]',
    )) {
      const type = link.type.split(";", 1)[0]?.trim().toLowerCase();
      if (!FEED_MIME_TYPES.has(type) && !isFeedReference(`${link.title} ${link.href}`)) continue;
      add(resolvedHttpUrl(link.getAttribute("href") ?? "", pageUrl));
    }
    for (const link of dom.window.document.querySelectorAll<HTMLAnchorElement>("a[href]")) {
      const href = link.getAttribute("href") ?? "";
      if (!isFeedReference(`${link.textContent ?? ""} ${href}`)) continue;
      add(resolvedHttpUrl(href, pageUrl));
    }
  } finally {
    dom.window.close();
  }
  const origin = new URL(pageUrl).origin;
  for (const path of COMMON_FEED_PATHS) add(new URL(path, origin).toString());
  return candidates;
}

async function fetchSource(
  url: string,
  signal: AbortSignal,
  required: boolean,
): Promise<{ source: string; url: string } | null> {
  let response: Response;
  try {
    response = await fetchFeed(url, {
      headers: { Accept: FEED_ACCEPT, "User-Agent": USER_AGENT },
      redirect: "follow",
      signal,
    });
  } catch {
    if (signal.aborted) {
      throw new FeedDiscoveryError("This URL took too long to respond. Try again in a moment.");
    }
    if (required) {
      throw new FeedDiscoveryError("Could not reach this URL. Check the address and try again.");
    }
    return null;
  }
  if (!response.ok) {
    await response.body?.cancel();
    if (required) {
      throw new FeedDiscoveryError(`This URL returned HTTP ${response.status}.`);
    }
    return null;
  }
  return { source: await response.text(), url: response.url || url };
}

export async function discoverFeed(inputUrl: string, timeoutMs = 15_000): Promise<FeedPreview> {
  const input = new URL(inputUrl).toString();
  const url = nitterFeedUrl(input) ?? input;
  const telegram = telegramChannelUrls(url);
  const signal = AbortSignal.timeout(timeoutMs);
  const page = await fetchSource(telegram?.previewUrl ?? url, signal, true);
  if (!page) throw new FeedDiscoveryError("Could not load this URL.");
  if (telegram) {
    try {
      return preview(
        parseAndNormalizeTelegramFeed(page.source, telegram.channelUrl),
        telegram.channelUrl,
      );
    } catch {
      throw new FeedDiscoveryError("Could not read a public Telegram channel at this URL.");
    }
  }
  const direct = parsePreview(page.source, page.url);
  if (direct) return direct;

  for (const candidate of feedCandidates(page.source, page.url)) {
    const result = await fetchSource(candidate, signal, false);
    if (!result) continue;
    const found = parsePreview(result.source, result.url);
    if (found) return found;
  }

  throw new FeedDiscoveryError("No RSS, Atom, or JSON Feed was found at this URL.");
}

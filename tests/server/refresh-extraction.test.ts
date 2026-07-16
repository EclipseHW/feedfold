import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app.js";
import { youtubeMediaFromUrl } from "../../src/server/article-media.js";
import { AuthService } from "../../src/server/auth.js";
import { AppDatabase, type ParsedFeed } from "../../src/server/db.js";
import { ExtractionQueue, extractArticle } from "../../src/server/extraction.js";
import { FeedRefreshService } from "../../src/server/refresh.js";

const cleanups: Array<() => Promise<void> | void> = [];
const TEST_USER_ID = 1;
const TEST_ACCOUNT = { username: "reader", password: "test-password" };

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function temporaryDatabase(): Promise<AppDatabase> {
  const directory = await mkdtemp(join(tmpdir(), "echovale-test-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  return new AppDatabase(join(directory, "echovale.db"));
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

describe("feed refresh and full-text extraction", () => {
  it("keeps an image-only feed article instead of unrelated page text", async () => {
    let requests = 0;
    const server = createServer((_request, response) => {
      requests += 1;
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end(
        `<html><body><main><p>${"Unrelated archive footer. ".repeat(100)}</p></main></body></html>`,
      );
    });
    const baseUrl = await listen(server);
    const outcome = await extractArticle({
      id: 1,
      url: `${baseUrl}/comic`,
      feedContentHtml: '<p><img src="/current-comic.png" alt="Current comic"></p>',
    });

    expect(outcome).toMatchObject({ contentSource: "feed", status: "feed", error: null });
    expect(outcome.contentHtml).toContain(`src="${baseUrl}/current-comic.png"`);
    expect(outcome.contentHtml).not.toContain("Unrelated archive footer");
    expect(requests).toBe(0);
  });

  it("uses conditional feed requests, extracts full text, falls back to feed content, and records failures", async () => {
    let baseUrl = "";
    let feedRequests = 0;
    let conditionalHeader: string | undefined;
    let forceFullResponse = false;
    let revised = false;
    const articleText = Array.from(
      { length: 40 },
      () => "A substantial article paragraph keeps the readability result representative.",
    ).join(" ");
    const server = createServer((request, response) => {
      if (request.url === "/feed") {
        feedRequests += 1;
        conditionalHeader = request.headers["if-none-match"];
        if (conditionalHeader === '"v1"' && !forceFullResponse) {
          response.writeHead(304, { ETag: '"v1"' });
          response.end();
          return;
        }
        response.writeHead(200, {
          "Content-Type": "application/rss+xml",
          ETag: '"v1"',
          "Last-Modified": "Mon, 13 Jul 2026 12:00:00 GMT",
        });
        response.end(`<?xml version="1.0"?>
          <rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
            <channel>
              <title>Remote title</title><link>${baseUrl}</link><description>Test feed</description>
              <item><guid>article-1</guid><title>${revised ? "Extract me (corrected)" : "Extract me"}</title><link>${baseUrl}/article</link>
                <description>${revised ? "Corrected feed summary" : "Short feed summary"}</description></item>
              <item><guid>article-2</guid><title>Use fallback</title><link>${baseUrl}/missing</link>
                <content:encoded><![CDATA[<div><p>Complete text supplied by the feed.</p><script>bad()</script></div>]]></content:encoded>
              </item>
            </channel>
          </rss>`);
        return;
      }
      if (request.url === "/article") {
        response.writeHead(200, { "Content-Type": "text/html" });
        response.end(`<!doctype html><html><head><title>Extract me</title></head><body>
          <article><h1>${revised ? "Corrected article" : "Extract me"}</h1><p>${articleText}</p>
          <a href="/more">Related</a><img src="/image.jpg" alt="Example"><script>bad()</script></article>
        </body></html>`);
        return;
      }
      if (request.url === "/missing") {
        response.writeHead(503).end("offline");
        return;
      }
      if (request.url === "/broken") {
        response.writeHead(503).end("offline");
        return;
      }
      if (request.url === "/video") {
        response.writeHead(200, {
          "Content-Type": "video/mp4",
          "Content-Length": "847456566",
        });
        response.end("not article HTML");
        return;
      }
      if (request.url === "/oversized") {
        response.writeHead(200, {
          "Content-Type": "text/html",
          "Content-Length": String(5 * 1024 * 1024 + 1),
        });
        response.end("<p>declared too large</p>");
        return;
      }
      response.writeHead(404).end();
    });
    baseUrl = await listen(server);

    const database = await temporaryDatabase();
    const extraction = new ExtractionQueue(database, 2, 2_000);
    const refresh = new FeedRefreshService(database, extraction, 2, 2_000);
    cleanups.push(async () => {
      await Promise.all([refresh.stop(), extraction.stop()]);
      database.close();
    });

    const media = await extractArticle({
      id: 100,
      url: `${baseUrl}/video`,
      feedContentHtml: "<p>Feed text remains readable.</p>",
    });
    expect(media).toMatchObject({
      status: "feed",
      contentSource: "feed",
      error: "Article response is not HTML (video/mp4)",
    });
    const oversized = await extractArticle({
      id: 101,
      url: `${baseUrl}/oversized`,
      feedContentHtml: "<p>Feed text remains readable.</p>",
    });
    expect(oversized).toMatchObject({
      status: "feed",
      contentSource: "feed",
      error: "Article response exceeds the 5 MiB extraction limit",
    });

    const feed = database.createFeed(TEST_USER_ID, { feedUrl: `${baseUrl}/feed` });
    expect(refresh.request([feed.id])).toEqual({ requested: 1, refreshingFeedIds: [feed.id] });
    await refresh.waitForIdle();
    await extraction.waitForIdle();

    const articles = database.listArticles(TEST_USER_ID, { state: "all", includeContent: true });
    expect(articles).toHaveLength(2);
    const extracted = articles.find((article) => article.title === "Extract me");
    expect(extracted?.extractionStatus).toBe("complete");
    expect(extracted?.contentSource).toBe("article");
    expect(extracted?.contentHtml).toContain(`href="${baseUrl}/more"`);
    expect(extracted?.contentHtml).toContain('target="_blank"');
    expect(extracted?.contentHtml).toContain(`src="${baseUrl}/image.jpg"`);
    expect(extracted?.contentHtml).not.toContain("<script");
    expect(extracted?.imageUrl).toBe(`${baseUrl}/image.jpg`);
    if (!extracted) throw new Error("Extracted article was not stored");

    const fallback = articles.find((article) => article.title === "Use fallback");
    expect(fallback?.extractionStatus).toBe("feed");
    expect(fallback?.contentSource).toBe("feed");
    expect(fallback?.contentHtml).toContain("Complete text supplied by the feed");
    expect(fallback?.contentHtml).not.toContain("<script");
    expect(fallback?.extractionError).toContain("HTTP 503");

    expect(database.getFeed(TEST_USER_ID, feed.id)?.title).toBe("Remote title");
    refresh.request([feed.id]);
    await refresh.waitForIdle();
    expect(feedRequests).toBe(2);
    expect(conditionalHeader).toBe('"v1"');
    expect(database.getFeed(TEST_USER_ID, feed.id)?.lastHttpStatus).toBe(304);
    expect(database.listArticles(TEST_USER_ID, { state: "all" })).toHaveLength(2);

    database.updateArticleState(TEST_USER_ID, extracted.id, { isRead: true, isStarred: true });
    forceFullResponse = true;
    revised = true;
    refresh.request([feed.id]);
    await refresh.waitForIdle();
    await extraction.waitForIdle();
    expect(feedRequests).toBe(3);
    expect(database.getArticle(TEST_USER_ID, extracted.id)).toMatchObject({
      title: "Extract me (corrected)",
      summary: "Corrected feed summary",
      isRead: true,
      isStarred: true,
    });
    expect(database.getArticle(TEST_USER_ID, extracted.id)?.contentHtml).toContain(
      "Corrected article",
    );
    expect(database.listArticles(TEST_USER_ID, { state: "all" })).toHaveLength(2);

    const broken = database.createFeed(TEST_USER_ID, {
      feedUrl: `${baseUrl}/broken`,
      title: "Broken",
    });
    refresh.request([broken.id]);
    await refresh.waitForIdle();
    expect(database.getFeed(TEST_USER_ID, broken.id)).toMatchObject({
      lastHttpStatus: 503,
      lastSuccessAt: null,
      refreshing: false,
    });
    expect(database.getFeed(TEST_USER_ID, broken.id)?.lastError).toContain("HTTP 503");
  });

  it("uses the publisher's WordPress API when bot protection replaces its feed", async () => {
    let wordpressRequests = 0;
    const server = createServer((request, response) => {
      if (request.url === "/feed") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            message:
              "Access denied by Imunify360 bot-protection. IPs used for automation should be whitelisted",
          }),
        );
        return;
      }
      if (request.url?.startsWith("/wp-json/wp/v2/posts?")) {
        wordpressRequests += 1;
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify([
            {
              id: 1292,
              guid: { rendered: `http://${request.headers.host}/?p=1292` },
              date_gmt: "2026-01-12T10:56:53",
              link: `http://${request.headers.host}/story`,
              title: { rendered: "Publisher &amp; post" },
              excerpt: { rendered: "<p>Fallback summary.</p>" },
              content: { rendered: "<p>Complete first-party post content.</p>" },
            },
          ]),
        );
        return;
      }
      if (request.url === "/story") {
        response.writeHead(503).end("offline");
        return;
      }
      response.writeHead(404).end();
    });
    const baseUrl = await listen(server);
    const database = await temporaryDatabase();
    const extraction = new ExtractionQueue(database, 1, 2_000);
    const refresh = new FeedRefreshService(database, extraction, 1, 2_000);
    cleanups.push(async () => {
      await Promise.all([refresh.stop(), extraction.stop()]);
      database.close();
    });

    const feed = database.createFeed(TEST_USER_ID, {
      feedUrl: `${baseUrl}/feed`,
      title: "Publisher",
    });
    refresh.request([feed.id]);
    await refresh.waitForIdle();
    await extraction.waitForIdle();

    expect(wordpressRequests).toBe(1);
    expect(database.getFeed(TEST_USER_ID, feed.id)).toMatchObject({
      title: "Publisher",
      siteUrl: baseUrl,
      lastHttpStatus: 200,
      lastError: null,
      totalCount: 1,
    });
    expect(
      database.listArticles(TEST_USER_ID, { state: "all", includeContent: true })[0],
    ).toMatchObject({
      title: "Publisher & post",
      summary: "Fallback summary.",
      contentHtml: "<p>Complete first-party post content.</p>",
      contentSource: "feed",
    });
  });

  it("identifies browser-verification responses instead of reporting parser errors", async () => {
    const server = createServer((request, response) => {
      if (request.url === "/imunify") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end('{"message":"Access denied by Imunify360 bot-protection"}');
        return;
      }
      if (request.url === "/cloudflare") {
        response.writeHead(403, { "cf-mitigated": "challenge" }).end("challenge");
        return;
      }
      if (request.url === "/vercel") {
        response.writeHead(429, { "x-vercel-mitigated": "challenge" }).end("challenge");
        return;
      }
      response.writeHead(404).end();
    });
    const baseUrl = await listen(server);
    const database = await temporaryDatabase();
    const extraction = new ExtractionQueue(database, 1, 2_000);
    const refresh = new FeedRefreshService(database, extraction, 3, 2_000);
    cleanups.push(async () => {
      await Promise.all([refresh.stop(), extraction.stop()]);
      database.close();
    });

    const feeds = ["imunify", "cloudflare", "vercel"].map((provider) =>
      database.createFeed(TEST_USER_ID, { feedUrl: `${baseUrl}/${provider}`, title: provider }),
    );
    refresh.request(feeds.map((feed) => feed.id));
    await refresh.waitForIdle();

    expect(feeds.map((feed) => database.getFeed(TEST_USER_ID, feed.id)?.lastError)).toEqual([
      "Feed host requires browser verification (Imunify360); automated refresh cannot access this URL",
      "Feed host requires browser verification (Cloudflare); automated refresh cannot access this URL",
      "Feed host requires browser verification (Vercel); automated refresh cannot access this URL",
    ]);
  });

  it("drains more than one extraction batch after a restart", async () => {
    const database = await temporaryDatabase();
    const extraction = new ExtractionQueue(database, 4, 1_000);
    cleanups.push(async () => {
      await extraction.stop();
      database.close();
    });
    const feed = database.createFeed(TEST_USER_ID, {
      feedUrl: "https://example.test/feed",
      title: "Batch",
    });
    const parsed: ParsedFeed = {
      title: "Batch",
      siteUrl: "https://example.test",
      articles: Array.from({ length: 125 }, (_, index) => ({
        externalId: `article-${index}`,
        title: `Article ${index}`,
        url: null,
        author: null,
        publishedAt: null,
        summary: "",
        imageUrl: null,
        feedContentHtml: `<p>Readable feed content ${index}</p>`,
      })),
    };
    database.markFeedSuccess(feed.id, {
      httpStatus: 200,
      etag: null,
      lastModified: null,
      pollIntervalMinutes: 20,
      parsed,
    });

    extraction.start();
    await extraction.waitForIdle();

    const count = database.sqlite
      .prepare("SELECT COUNT(*) AS count FROM articles WHERE extraction_status = 'feed'")
      .get() as { count: number };
    expect(count.count).toBe(125);
    expect(database.getPendingExtractions()).toHaveLength(0);

    const firstPage = database.listArticlePage(TEST_USER_ID, { state: "all", limit: 100 });
    expect(firstPage.articles).toHaveLength(100);
    expect(firstPage.nextCursor).not.toBeNull();
    const secondPage = database.listArticlePage(TEST_USER_ID, {
      state: "all",
      limit: 100,
      cursor: firstPage.nextCursor ?? undefined,
    });
    expect(secondPage.articles).toHaveLength(25);
    expect(secondPage.nextCursor).toBeNull();
    expect(
      new Set([...firstPage.articles, ...secondPage.articles].map((article) => article.id)).size,
    ).toBe(125);
  });

  it("preserves an extracted thumbnail when feed metadata changes", async () => {
    const database = await temporaryDatabase();
    cleanups.push(() => database.close());
    const feed = database.createFeed(TEST_USER_ID, {
      feedUrl: "https://example.test/feed",
      title: "Feed",
    });
    const parsedArticle = {
      externalId: "story",
      title: "Original title",
      url: "https://example.test/story",
      author: null,
      publishedAt: null,
      summary: "Summary",
      imageUrl: null,
      feedContentHtml: "<p>Feed summary without an image.</p>",
    };
    const [articleId] = database.markFeedSuccess(feed.id, {
      httpStatus: 200,
      etag: null,
      lastModified: null,
      pollIntervalMinutes: 20,
      parsed: { title: "Feed", siteUrl: "https://example.test", articles: [parsedArticle] },
    });
    database.completeExtraction(articleId, {
      contentHtml: '<p>Full article.</p><img src="https://cdn.example.test/hero.jpg">',
      imageUrl: "https://cdn.example.test/hero.jpg",
      contentSource: "article",
      status: "complete",
      error: null,
    });

    database.markFeedSuccess(feed.id, {
      httpStatus: 200,
      etag: null,
      lastModified: null,
      pollIntervalMinutes: 20,
      parsed: {
        title: "Feed",
        siteUrl: "https://example.test",
        articles: [{ ...parsedArticle, title: "Updated title" }],
      },
    });

    expect(database.getArticle(TEST_USER_ID, articleId)).toMatchObject({
      title: "Updated title",
      imageUrl: "https://cdn.example.test/hero.jpg",
      extractionStatus: "complete",
    });
  });

  it("stores playable media without text extraction and filters Shorts by media type", async () => {
    const database = await temporaryDatabase();
    cleanups.push(() => database.close());
    const feed = database.createFeed(TEST_USER_ID, {
      feedUrl: "https://www.youtube.com/feeds/videos.xml?channel_id=UCexample",
      title: "Video feed",
    });
    const video = youtubeMediaFromUrl("https://www.youtube.com/watch?v=regular123");
    const short = youtubeMediaFromUrl("https://www.youtube.com/shorts/short123");
    if (!video || !short) throw new Error("Expected YouTube media metadata");

    const extractionIds = database.markFeedSuccess(feed.id, {
      httpStatus: 200,
      etag: null,
      lastModified: null,
      pollIntervalMinutes: 20,
      parsed: {
        title: "Video feed",
        siteUrl: "https://www.youtube.com/channel/UCexample",
        articles: [
          {
            externalId: "regular123",
            title: "Regular upload",
            url: "https://www.youtube.com/watch?v=regular123",
            author: "Example channel",
            publishedAt: "2026-07-16T13:00:20.000Z",
            summary: "Regular description",
            imageUrl: video.thumbnailUrl,
            media: video,
            feedContentHtml: null,
          },
          {
            externalId: "short123",
            title: "Short upload",
            url: "https://www.youtube.com/shorts/short123",
            author: "Example channel",
            publishedAt: "2026-07-15T14:09:22.000Z",
            summary: "",
            imageUrl: short.thumbnailUrl,
            media: short,
            feedContentHtml: null,
          },
        ],
      },
    });

    expect(extractionIds).toEqual([]);
    expect(database.listArticles(TEST_USER_ID, { state: "all" })).toMatchObject([
      { title: "Regular upload", extractionStatus: "feed", media: { type: "video" } },
      { title: "Short upload", extractionStatus: "feed", media: { type: "short" } },
    ]);

    const rule = database.createRule(TEST_USER_ID, {
      name: "Hide Shorts",
      field: "media",
      pattern: "short",
      action: "hide",
    });
    expect(rule.matchedCount).toBe(1);
    expect(
      database.listArticles(TEST_USER_ID, { state: "all" }).map((article) => article.title),
    ).toEqual(["Regular upload"]);
  });

  it("promotes an opened pending article ahead of the extraction backlog", async () => {
    let releaseFirst: (() => void) | undefined;
    let reportFirstStarted: (() => void) | undefined;
    const firstStarted = new Promise<void>((resolve) => {
      reportFirstStarted = resolve;
    });
    const firstReleased = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const requestOrder: string[] = [];
    const articleBody = `<article><h1>Readable</h1><p>${"Article text. ".repeat(80)}</p></article>`;
    const server = createServer((request, response) => {
      const path = request.url ?? "";
      requestOrder.push(path);
      if (path === "/first") {
        reportFirstStarted?.();
        void firstReleased.then(() => {
          response.writeHead(200, { "Content-Type": "text/html" });
          response.end(articleBody);
        });
        return;
      }
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end(articleBody);
    });
    const baseUrl = await listen(server);
    const database = await temporaryDatabase();
    const extraction = new ExtractionQueue(database, 1, 2_000);
    const refresh = new FeedRefreshService(database, extraction, 1, 2_000);
    const authService = new AuthService(database);
    expect(authService.register(TEST_ACCOUNT.username, TEST_ACCOUNT.password)).not.toBeNull();
    const app = await createApp({
      database,
      authService,
      extractionQueue: extraction,
      refreshService: refresh,
    });
    cleanups.push(async () => {
      releaseFirst?.();
      await app.close();
      await Promise.all([refresh.stop(), extraction.stop()]);
      database.close();
    });

    const feed = database.createFeed(TEST_USER_ID, {
      feedUrl: `${baseUrl}/feed`,
      title: "Priority",
    });
    const articleIds = database.markFeedSuccess(feed.id, {
      httpStatus: 200,
      etag: null,
      lastModified: null,
      pollIntervalMinutes: 20,
      parsed: {
        title: "Priority",
        siteUrl: baseUrl,
        articles: ["first", "second", "opened"].map((name) => ({
          externalId: name,
          title: name,
          url: `${baseUrl}/${name}`,
          author: null,
          publishedAt: null,
          summary: "",
          imageUrl: null,
          feedContentHtml: null,
        })),
      },
    });
    extraction.start();
    await firstStarted;

    const openedId = articleIds[2];
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: TEST_ACCOUNT,
    });
    const setCookie = login.headers["set-cookie"];
    const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(";", 1)[0];
    const response = await app.inject({
      method: "POST",
      url: `/api/articles/${openedId}/extract`,
      headers: { cookie: cookie ?? "" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: openedId, extractionStatus: "pending" });
    releaseFirst?.();
    await extraction.waitForIdle();

    expect(requestOrder).toEqual(["/first", "/opened", "/second"]);
  });
});

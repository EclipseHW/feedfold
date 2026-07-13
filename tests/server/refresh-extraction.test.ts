import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AppDatabase, type ParsedFeed } from "../../src/server/db.js";
import { ExtractionQueue, extractArticle } from "../../src/server/extraction.js";
import { FeedRefreshService } from "../../src/server/refresh.js";

const cleanups: Array<() => Promise<void> | void> = [];

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

    const feed = database.createFeed({ feedUrl: `${baseUrl}/feed` });
    expect(refresh.request([feed.id])).toEqual({ requested: 1, refreshingFeedIds: [feed.id] });
    await refresh.waitForIdle();
    await extraction.waitForIdle();

    const articles = database.listArticles({ state: "all" });
    expect(articles).toHaveLength(2);
    const extracted = articles.find((article) => article.title === "Extract me");
    expect(extracted?.extractionStatus).toBe("complete");
    expect(extracted?.contentSource).toBe("article");
    expect(extracted?.contentHtml).toContain(`href="${baseUrl}/more"`);
    expect(extracted?.contentHtml).toContain('target="_blank"');
    expect(extracted?.contentHtml).toContain(`src="${baseUrl}/image.jpg"`);
    expect(extracted?.contentHtml).not.toContain("<script");
    if (!extracted) throw new Error("Extracted article was not stored");

    const fallback = articles.find((article) => article.title === "Use fallback");
    expect(fallback?.extractionStatus).toBe("feed");
    expect(fallback?.contentSource).toBe("feed");
    expect(fallback?.contentHtml).toContain("Complete text supplied by the feed");
    expect(fallback?.contentHtml).not.toContain("<script");
    expect(fallback?.extractionError).toContain("HTTP 503");

    expect(database.getFeed(feed.id)?.title).toBe("Remote title");
    refresh.request([feed.id]);
    await refresh.waitForIdle();
    expect(feedRequests).toBe(2);
    expect(conditionalHeader).toBe('"v1"');
    expect(database.getFeed(feed.id)?.lastHttpStatus).toBe(304);
    expect(database.listArticles({ state: "all" })).toHaveLength(2);

    database.updateArticleState(extracted.id, { isRead: true, isStarred: true });
    forceFullResponse = true;
    revised = true;
    refresh.request([feed.id]);
    await refresh.waitForIdle();
    await extraction.waitForIdle();
    expect(feedRequests).toBe(3);
    expect(database.getArticle(extracted.id)).toMatchObject({
      title: "Extract me (corrected)",
      summary: "Corrected feed summary",
      isRead: true,
      isStarred: true,
    });
    expect(database.getArticle(extracted.id)?.contentHtml).toContain("Corrected article");
    expect(database.listArticles({ state: "all" })).toHaveLength(2);

    const broken = database.createFeed({ feedUrl: `${baseUrl}/broken`, title: "Broken" });
    refresh.request([broken.id]);
    await refresh.waitForIdle();
    expect(database.getFeed(broken.id)).toMatchObject({
      lastHttpStatus: 503,
      lastSuccessAt: null,
      refreshing: false,
    });
    expect(database.getFeed(broken.id)?.lastError).toContain("HTTP 503");
  });

  it("drains more than one extraction batch after a restart", async () => {
    const database = await temporaryDatabase();
    const extraction = new ExtractionQueue(database, 4, 1_000);
    cleanups.push(async () => {
      await extraction.stop();
      database.close();
    });
    const feed = database.createFeed({ feedUrl: "https://example.test/feed", title: "Batch" });
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

    const firstPage = database.listArticlePage({ state: "all", limit: 100 });
    expect(firstPage.articles).toHaveLength(100);
    expect(firstPage.nextCursor).not.toBeNull();
    const secondPage = database.listArticlePage({
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
});

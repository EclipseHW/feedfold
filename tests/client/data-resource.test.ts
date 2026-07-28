import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InjectOptions } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { api, type FeedInput } from "../../src/client/api.js";
import { ReaderDataResource } from "../../src/client/data-resource.js";
import { createApp } from "../../src/server/app.js";
import { AuthService } from "../../src/server/auth.js";
import { AppDatabase } from "../../src/server/db.js";
import { ExtractionQueue } from "../../src/server/extraction.js";
import { FeedRefreshService } from "../../src/server/refresh.js";
import type { ArticlePage, BootstrapData, Feed, Rule } from "../../src/shared/types.js";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const FEED_SOURCE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Resource test feed</title>
    <link>https://example.test/</link>
    <description>Resource integration test</description>
    <item>
      <guid>resource-story</guid>
      <title>Resource story</title>
      <link>https://example.test/resource-story</link>
      <pubDate>Tue, 28 Jul 2026 12:00:00 GMT</pubDate>
      <description>Loaded after the refresh gate opens.</description>
    </item>
  </channel>
</rss>`;

describe("reader data resource", () => {
  it("cancels an obsolete article request when a newer query starts", async () => {
    const firstRequestStarted = deferred();
    const firstRequestAborted = deferred();
    const server = createServer((request, response) => {
      if (request.url === "/first") {
        firstRequestStarted.resolve();
        request.once("aborted", firstRequestAborted.resolve);
        return;
      }
      response.writeHead(200, { "Content-Type": "text/plain" });
      response.end("new query");
    });
    const baseUrl = await listen(server);
    const resource = new ReaderDataResource(api, 5);
    cleanups.push(() => resource.pause());
    const appliedResponses: string[] = [];
    let requestNumber = 0;
    resource.connect({
      getBootstrap: () => null,
      applyBootstrap: () => {},
      setBootstrapError: () => {},
      reloadArticles: async (signal) => {
        requestNumber += 1;
        const path = requestNumber === 1 ? "first" : "second";
        const response = await fetch(`${baseUrl}/${path}`, { signal });
        appliedResponses.push(await response.text());
      },
      reloadRules: async () => {},
    });

    const obsoleteRequest = resource.loadArticles();
    await firstRequestStarted.promise;
    const currentRequest = resource.loadArticles();
    await Promise.all([obsoleteRequest, currentRequest, firstRequestAborted.promise]);

    expect(appliedResponses).toEqual(["new query"]);
  });

  it("replaces a stale add-feed snapshot after ingestion and reloads articles", async () => {
    const directory = await mkdtemp(join(tmpdir(), "echovale-data-resource-test-"));
    const database = new AppDatabase(join(directory, "echovale.db"));
    const authService = new AuthService(database);
    const extraction = new ExtractionQueue(database, 1, 1_000);
    const fetchStarted = [deferred(), deferred()];
    const fetchRelease = [deferred(), deferred()];
    let fetchIndex = 0;
    const feedFetcher: typeof fetch = async () => {
      const index = fetchIndex;
      fetchIndex += 1;
      fetchStarted[index]?.resolve();
      await fetchRelease[index]?.promise;
      return new Response(FEED_SOURCE, {
        status: 200,
        headers: { "Content-Type": "application/rss+xml" },
      });
    };
    const refresh = new FeedRefreshService(database, 1, 1_000, undefined, feedFetcher);
    const app = await createApp({
      database,
      authService,
      extractionQueue: extraction,
      refreshService: refresh,
    });
    cleanups.push(
      () => rm(directory, { recursive: true, force: true }),
      () => database.close(),
      () => Promise.all([refresh.stop(), extraction.stop()]).then(() => undefined),
      () => app.close(),
    );

    const registration = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { username: "resource-reader", password: "reader-password" },
    });
    const setCookie = registration.headers["set-cookie"];
    const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(";", 1)[0];
    if (!cookie) throw new Error("Registration did not return a session cookie");

    const request = (options: InjectOptions) =>
      app.inject({ ...options, headers: { ...options.headers, cookie } });
    const createInput = (feedUrl: string): FeedInput => ({
      title: "Resource test feed",
      feedUrl,
      siteUrl: "https://example.test/",
      folderId: null,
      sourceKind: "published",
    });

    const oneShotCreate = await request({
      method: "POST",
      url: "/api/feeds",
      payload: createInput("https://example.test/one-shot.xml"),
    });
    const oneShotFeed = oneShotCreate.json<Feed>();
    await fetchStarted[0].promise;
    const oneShotSnapshot = (
      await request({ method: "GET", url: "/api/bootstrap" })
    ).json<BootstrapData>();
    expect(oneShotSnapshot.feeds[0]).toMatchObject({
      id: oneShotFeed.id,
      refreshing: true,
      unreadCount: 0,
    });

    fetchRelease[0].resolve();
    await refresh.waitForIdle();
    const completedServerSnapshot = (
      await request({ method: "GET", url: "/api/bootstrap" })
    ).json<BootstrapData>();
    expect(oneShotSnapshot.feeds[0]).toMatchObject({ refreshing: true, unreadCount: 0 });
    expect(completedServerSnapshot.feeds[0]).toMatchObject({ refreshing: false, unreadCount: 1 });

    await request({ method: "DELETE", url: `/api/feeds/${oneShotFeed.id}` });

    const client = {
      ...api,
      bootstrap: async (signal?: AbortSignal) => {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        const response = await request({ method: "GET", url: "/api/bootstrap" });
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        return response.json<BootstrapData>();
      },
      createFeed: async (input: FeedInput) =>
        (await request({ method: "POST", url: "/api/feeds", payload: input })).json<Feed>(),
    };
    const resource = new ReaderDataResource(client, 5);
    cleanups.push(() => resource.pause());
    let latestBootstrap: BootstrapData | null = null;
    let latestArticles: ArticlePage | null = null;
    const healthyBootstrap = deferred();
    const articlesReloaded = deferred();
    resource.connect({
      getBootstrap: () => latestBootstrap,
      applyBootstrap: (bootstrap) => {
        latestBootstrap = bootstrap;
        if (bootstrap.feeds.some((feed) => !feed.refreshing && feed.unreadCount === 1)) {
          healthyBootstrap.resolve();
        }
      },
      setBootstrapError: (message) => {
        if (message) throw new Error(message);
      },
      reloadArticles: async (signal) => {
        if (signal.aborted) return;
        const articlePage = (
          await request({ method: "GET", url: "/api/articles?state=unread" })
        ).json<ArticlePage>();
        latestArticles = articlePage;
        if (articlePage.articles.length === 1) articlesReloaded.resolve();
      },
      reloadRules: async (signal) => {
        if (signal.aborted) return;
        (await request({ method: "GET", url: "/api/rules" })).json<{ rules: Rule[] }>();
      },
    });

    const currentBootstrap = () => {
      if (!latestBootstrap) throw new Error("The resource did not load bootstrap data");
      return latestBootstrap;
    };
    const currentArticles = () => {
      if (!latestArticles) throw new Error("The resource did not load articles");
      return latestArticles;
    };

    const trackedFeed = await resource.createFeed(createInput("https://example.test/tracked.xml"));
    await fetchStarted[1].promise;
    expect(currentBootstrap().feeds[0]).toMatchObject({
      id: trackedFeed.id,
      refreshing: true,
      unreadCount: 0,
    });

    fetchRelease[1].resolve();
    await Promise.all([refresh.waitForIdle(), healthyBootstrap.promise, articlesReloaded.promise]);
    expect(currentBootstrap().feeds[0]).toMatchObject({
      id: trackedFeed.id,
      refreshing: false,
      unreadCount: 1,
    });
    expect(currentArticles().articles).toHaveLength(1);
  });
});

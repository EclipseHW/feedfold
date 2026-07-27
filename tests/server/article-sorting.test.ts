import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InjectOptions } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app.js";
import { AuthService } from "../../src/server/auth.js";
import { AppDatabase } from "../../src/server/db.js";
import { ExtractionQueue } from "../../src/server/extraction.js";
import { FeedRefreshService } from "../../src/server/refresh.js";
import type { ArticlePage, Folder } from "../../src/shared/types.js";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("folder article sorting", () => {
  it("applies each folder order to its feeds and fairly merges aggregate pages", async () => {
    const directory = await mkdtemp(join(tmpdir(), "echovale-sorting-test-"));
    const database = new AppDatabase(join(directory, "echovale.db"));
    const authService = new AuthService(database);
    const extraction = new ExtractionQueue(database, 1, 1_000);
    const refresh = new FeedRefreshService(database, 1, 1_000);
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
      payload: { username: "reader", password: "reader-password" },
    });
    const setCookie = registration.headers["set-cookie"];
    const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(";", 1)[0];
    expect(registration.statusCode).toBe(201);
    expect(cookie).toBeTruthy();
    const request = (options: InjectOptions) =>
      app.inject({ ...options, headers: { ...options.headers, cookie } });

    const newestFolderResponse = await request({
      method: "POST",
      url: "/api/folders",
      payload: { name: "Newsletters", parentId: null },
    });
    const oldestFolderResponse = await request({
      method: "POST",
      url: "/api/folders",
      payload: { name: "Social", parentId: null },
    });
    const newestFolder = newestFolderResponse.json<Folder>();
    const oldestFolder = oldestFolderResponse.json<Folder>();
    expect(newestFolder.sortDirection).toBe("newest");
    expect(oldestFolder.sortDirection).toBe("newest");

    const updatedFolderResponse = await request({
      method: "PATCH",
      url: `/api/folders/${oldestFolder.id}`,
      payload: { sortDirection: "oldest" },
    });
    expect(updatedFolderResponse.statusCode).toBe(200);
    expect(updatedFolderResponse.json<Folder>().sortDirection).toBe("oldest");
    expect(
      (
        await request({
          method: "PATCH",
          url: `/api/folders/${oldestFolder.id}`,
          payload: { sortDirection: "sideways" },
        })
      ).statusCode,
    ).toBe(400);

    const createFeed = async (title: string, folderId: number) => {
      const response = await request({
        method: "POST",
        url: "/api/feeds",
        payload: {
          sourceKind: "published",
          title,
          feedUrl: `https://example.test/${title.toLowerCase()}`,
          folderId,
          paused: true,
        },
      });
      expect(response.statusCode).toBe(200);
      return response.json<{ id: number }>();
    };
    const newestFeed = await createFeed("News", newestFolder.id);
    const oldestFeed = await createFeed("Social", oldestFolder.id);

    const storeArticles = (
      feedId: number,
      title: string,
      articles: Array<{ externalId: string; title: string; publishedAt: string }>,
    ) =>
      database.markFeedSuccess(feedId, {
        httpStatus: 200,
        etag: null,
        lastModified: null,
        pollIntervalMinutes: 20,
        parsed: {
          title,
          siteUrl: null,
          articles: articles.map((article) => ({
            ...article,
            url: null,
            author: null,
            summary: "",
            imageUrl: null,
            feedContentHtml: null,
          })),
        },
      });
    storeArticles(newestFeed.id, "News", [
      {
        externalId: "news-older",
        title: "News older",
        publishedAt: "2026-07-20T08:00:00.000Z",
      },
      {
        externalId: "news-newer",
        title: "News newer",
        publishedAt: "2026-07-20T12:00:00.000Z",
      },
    ]);
    storeArticles(oldestFeed.id, "Social", [
      {
        externalId: "social-older",
        title: "Social older",
        publishedAt: "2026-07-20T09:00:00.000Z",
      },
      {
        externalId: "social-newer",
        title: "Social newer",
        publishedAt: "2026-07-20T11:00:00.000Z",
      },
    ]);

    const articleTitles = async (url: string) =>
      (await request({ method: "GET", url }))
        .json<ArticlePage>()
        .articles.map(({ title }) => title);
    expect(await articleTitles(`/api/articles?state=unread&feedId=${newestFeed.id}`)).toEqual([
      "News newer",
      "News older",
    ]);
    expect(await articleTitles(`/api/articles?state=unread&feedId=${oldestFeed.id}`)).toEqual([
      "Social older",
      "Social newer",
    ]);
    expect(await articleTitles(`/api/articles?state=unread&folderId=${oldestFolder.id}`)).toEqual([
      "Social older",
      "Social newer",
    ]);
    expect(await articleTitles("/api/articles?state=all")).toEqual([
      "News newer",
      "Social older",
      "Social newer",
      "News older",
    ]);

    const allArticles = (
      await request({ method: "GET", url: "/api/articles?state=all" })
    ).json<ArticlePage>();
    const anchorId = allArticles.articles.find((article) => article.title === "Social newer")?.id;
    if (!anchorId) throw new Error("Anchor article was not stored");
    const anchoredPage = (
      await request({
        method: "GET",
        url: `/api/articles?state=all&limit=3&anchorId=${anchorId}`,
      })
    ).json<ArticlePage>();
    expect(anchoredPage.articles.map(({ title }) => title)).toEqual([
      "Social older",
      "Social newer",
      "News older",
    ]);
    expect(anchoredPage.anchorIndex).toBe(1);

    const firstPageResponse = await request({
      method: "GET",
      url: "/api/articles?state=unread&limit=2",
    });
    const firstPage = firstPageResponse.json<ArticlePage>();
    expect(firstPage.articles.map(({ title }) => title)).toEqual(["News newer", "Social older"]);
    expect(firstPage.nextCursor).not.toBeNull();
    expect(
      (
        await request({
          method: "POST",
          url: "/api/articles/mark-read",
          payload: { articleIds: firstPage.articles.map(({ id }) => id) },
        })
      ).json(),
    ).toEqual({ updated: 2 });
    const secondPage = (
      await request({
        method: "GET",
        url: `/api/articles?state=unread&limit=2&cursor=${firstPage.nextCursor}`,
      })
    ).json<ArticlePage>();
    expect(secondPage.articles.map(({ title }) => title)).toEqual(["Social newer", "News older"]);
    expect(secondPage.nextCursor).toBeNull();
  });
});

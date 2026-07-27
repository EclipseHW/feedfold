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
import type { Feed, Folder, Rule } from "../../src/shared/types.js";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("feed and folder management", () => {
  it("manages a subscription in place and returns persisted feed settings", async () => {
    const directory = await mkdtemp(join(tmpdir(), "echovale-feed-management-test-"));
    const database = new AppDatabase(join(directory, "echovale.db"), 37);
    const authService = new AuthService(database, 37);
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

    const register = async (username: string): Promise<string> => {
      const response = await app.inject({
        method: "POST",
        url: "/api/auth/register",
        payload: { username, password: "reader-password" },
      });
      expect(response.statusCode).toBe(201);
      const setCookie = response.headers["set-cookie"];
      const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(";", 1)[0];
      if (!cookie) throw new Error("Registration did not return a session cookie");
      return cookie;
    };

    const readerCookie = await register("reader");
    const otherCookie = await register("other-reader");
    const request = (options: InjectOptions) =>
      app.inject({ ...options, headers: { ...options.headers, cookie: readerCookie } });

    const inbox = (
      await request({
        method: "POST",
        url: "/api/folders",
        payload: { name: "Inbox", parentId: null },
      })
    ).json<Folder>();
    const archive = (
      await request({
        method: "POST",
        url: "/api/folders",
        payload: { name: "Archive", parentId: null },
      })
    ).json<Folder>();

    const createResponse = await request({
      method: "POST",
      url: "/api/feeds",
      payload: {
        sourceKind: "published",
        title: "Original name",
        feedUrl: "https://example.test/feed.xml",
        siteUrl: "https://example.test/",
        folderId: inbox.id,
        paused: true,
      },
    });
    expect(createResponse.statusCode).toBe(200);
    const createdFeed = createResponse.json<Feed>();
    const storedPollInterval = database.sqlite
      .prepare("SELECT poll_interval_minutes FROM settings WHERE user_id = 1")
      .pluck()
      .get();
    expect(storedPollInterval).toBe(37);
    expect(createdFeed).toMatchObject({
      title: "Original name",
      folderId: inbox.id,
      pollIntervalMinutes: storedPollInterval,
    });
    expect(new Date(createdFeed.createdAt).toISOString()).toBe(createdFeed.createdAt);

    const getResponse = await request({
      method: "GET",
      url: `/api/feeds/${createdFeed.id}`,
    });
    expect(getResponse.statusCode).toBe(200);
    expect(getResponse.json<Feed>()).toEqual(createdFeed);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/feeds/${createdFeed.id}`,
          headers: { cookie: otherCookie },
        })
      ).statusCode,
    ).toBe(404);

    const renamedFolder = await request({
      method: "PATCH",
      url: `/api/folders/${archive.id}`,
      payload: { name: "Read later" },
    });
    expect(renamedFolder.json<Folder>()).toMatchObject({ id: archive.id, name: "Read later" });

    const updatedFeed = await request({
      method: "PATCH",
      url: `/api/feeds/${createdFeed.id}`,
      payload: { title: "Personal name", folderId: archive.id },
    });
    expect(updatedFeed.json<Feed>()).toMatchObject({
      id: createdFeed.id,
      title: "Personal name",
      folderId: archive.id,
      feedUrl: createdFeed.feedUrl,
    });

    const feedRule = await request({
      method: "POST",
      url: "/api/rules",
      payload: {
        name: "Hide promotions",
        feedId: createdFeed.id,
        folderId: null,
        conditions: [{ field: "title", pattern: "sponsored" }],
        conditionOperator: "and",
        action: "hide",
        enabled: true,
      },
    });
    expect(feedRule.json<Rule>()).toMatchObject({
      feedId: createdFeed.id,
      folderId: null,
    });

    const folderRule = await request({
      method: "POST",
      url: "/api/rules",
      payload: {
        name: "Mark announcements read",
        feedId: null,
        folderId: archive.id,
        conditions: [{ field: "title", pattern: "announcement" }],
        conditionOperator: "and",
        action: "mark_read",
        enabled: true,
      },
    });
    expect(folderRule.json<Rule>()).toMatchObject({
      feedId: null,
      folderId: archive.id,
    });

    expect(
      (
        await request({
          method: "DELETE",
          url: `/api/feeds/${createdFeed.id}`,
        })
      ).statusCode,
    ).toBe(204);
    expect(
      (
        await request({
          method: "GET",
          url: `/api/feeds/${createdFeed.id}`,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (await request({ method: "GET", url: "/api/rules" })).json<{ rules: Rule[] }>().rules,
    ).toEqual([expect.objectContaining({ id: folderRule.json<Rule>().id })]);
  });
});

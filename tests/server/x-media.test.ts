import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app.js";
import { AppDatabase } from "../../src/server/database.js";
import { ExtractionQueue } from "../../src/server/extraction.js";
import { AuthService } from "../../src/server/features/auth/service.js";
import { FeedRefreshService } from "../../src/server/refresh.js";
import { parseXPostMedia, XMediaService, xSyndicationToken } from "../../src/server/x-media.js";
import type { XArticleMedia } from "../../src/shared/types.js";

const cleanups: Array<() => Promise<void> | void> = [];
const VIDEO_POST_ID = "2086315104472383847";
const OUTER_POST_ID = "2086315619226681697";
const VIDEO_URL = "https://video.twimg.com/amplify_video/fixture/vid/544x960/video.mp4";
const POSTER_URL = "https://pbs.twimg.com/amplify_video_thumb/fixture/poster.jpg";
const PAYLOAD = {
  mediaDetails: [
    {
      type: "video",
      media_url_https: POSTER_URL,
      video_info: {
        aspect_ratio: [17, 30],
        variants: [
          { content_type: "application/x-mpegURL", url: "https://video.twimg.com/stream.m3u8" },
          { content_type: "video/mp4", bitrate: 256_000, url: "https://video.twimg.com/low.mp4" },
          { content_type: "video/mp4", bitrate: 2_176_000, url: VIDEO_URL },
        ],
      },
    },
  ],
};

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("X article media", () => {
  it("parses the highest-quality trusted MP4 and its dimensions", () => {
    expect(xSyndicationToken(VIDEO_POST_ID)).toBe("522coghmok");
    expect(parseXPostMedia(PAYLOAD)).toEqual({
      url: VIDEO_URL,
      posterUrl: POSTER_URL,
      aspectRatio: 17 / 30,
    });
  });

  it("rejects media URLs returned from untrusted hosts", () => {
    const payload = structuredClone(PAYLOAD);
    payload.mediaDetails[0].video_info.variants = [
      { content_type: "video/mp4", bitrate: 10, url: "https://example.test/video.mp4" },
    ];
    expect(() => parseXPostMedia(payload)).toThrow("playable MP4");
  });

  it("resolves a quoted video for an owned article and exposes authenticated URLs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "echovale-x-media-test-"));
    const database = new AppDatabase(join(directory, "echovale.db"));
    const authService = new AuthService(database.auth);
    const reader = authService.register("reader", "reader-password");
    const otherReader = authService.register("other", "reader-password");
    if (!reader || !otherReader) throw new Error("Expected test accounts");

    const feed = database.feeds.createFeed(reader.user.id, {
      feedUrl: "https://nitter.net/marclou/rss",
      title: "Marc Lou / @marclou",
      paused: true,
    });
    database.feeds.completeRefresh(feed.id, {
      httpStatus: 200,
      etag: null,
      lastModified: null,
      pollIntervalMinutes: 20,
      parsed: {
        title: feed.title,
        siteUrl: "https://nitter.net/marclou",
        articles: [
          {
            externalId: OUTER_POST_ID,
            title: "A post quoting native video",
            url: `https://nitter.net/marclou/status/${OUTER_POST_ID}#m`,
            author: "Marc Lou",
            publishedAt: "2026-08-09T10:00:00.000Z",
            summary: "A post with video.",
            imageUrl: POSTER_URL,
            feedContentHtml: `<p>Post text.</p><a href="https://nitter.net/marclou/status/${VIDEO_POST_ID}#m"><br>Video<br><img src="https://nitter.net/pic/amplify_video_thumb%2Ffixture.jpg"></a>`,
          },
        ],
      },
    });
    const article = database.articles.listArticles(reader.user.id, { state: "all" })[0];
    if (!article) throw new Error("Expected a stored article");

    const extraction = new ExtractionQueue(database.extractions, 1, 1_000);
    const refresh = new FeedRefreshService(database.feeds, 1, 1_000);
    const xMedia = new XMediaService(1_000, async (url) => {
      expect(url).toContain(`id=${VIDEO_POST_ID}`);
      return new Response(JSON.stringify(PAYLOAD), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const app = await createApp({
      database,
      authService,
      extractionQueue: extraction,
      refreshService: refresh,
      xMediaService: xMedia,
    });
    cleanups.push(
      () => rm(directory, { recursive: true, force: true }),
      () => database.close(),
      () => Promise.all([refresh.stop(), extraction.stop()]).then(() => undefined),
      () => app.close(),
    );
    const cookie = `echovale_session=${reader.token}`;
    const request = (url: string) => app.inject({ method: "GET", url, headers: { cookie } });

    const metadata = await request(`/api/articles/${article.id}/x-media`);
    expect(metadata.statusCode).toBe(200);
    expect(metadata.json<XArticleMedia>()).toEqual({
      sourceUrl: `/api/articles/${article.id}/x-media/source`,
      posterUrl: `/api/articles/${article.id}/x-media/poster`,
      aspectRatio: 17 / 30,
    });
    expect((await request(`/api/articles/${article.id}/x-media/source`)).headers.location).toBe(
      VIDEO_URL,
    );
    expect((await request(`/api/articles/${article.id}/x-media/poster`)).headers.location).toBe(
      POSTER_URL,
    );

    const hidden = await app.inject({
      method: "GET",
      url: `/api/articles/${article.id}/x-media`,
      headers: { cookie: `echovale_session=${otherReader.token}` },
    });
    expect(hidden.statusCode).toBe(404);
  });
});

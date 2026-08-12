import { describe, expect, it } from "vitest";
import {
  YOUTUBE_EMBED_REFERRER,
  youtubeEmbedRequestHeaders,
} from "../../src/desktop/youtube-player.js";

describe("desktop YouTube player requests", () => {
  it("identifies Feedfold when a YouTube iframe has no HTTP referrer", () => {
    const headers = { Accept: "text/html" };
    expect(
      youtubeEmbedRequestHeaders(
        {
          url: "https://www.youtube.com/embed/video-id",
          resourceType: "subFrame",
          webContentsId: 7,
          requestHeaders: headers,
        },
        7,
      ),
    ).toEqual({ Accept: "text/html", Referer: YOUTUBE_EMBED_REFERRER });
  });

  it("replaces a custom-scheme referrer without duplicating its header casing", () => {
    expect(
      youtubeEmbedRequestHeaders(
        {
          url: "https://www.youtube.com/embed/video-id?autoplay=1",
          resourceType: "subFrame",
          webContentsId: 7,
          requestHeaders: { referer: "feedfold://app/" },
        },
        7,
      ),
    ).toEqual({ referer: YOUTUBE_EMBED_REFERRER });
  });

  it("does not rewrite normal web referrers or unrelated requests", () => {
    const webHeaders = { Referer: "https://reader.example/" };
    expect(
      youtubeEmbedRequestHeaders(
        {
          url: "https://www.youtube.com/embed/video-id",
          resourceType: "subFrame",
          webContentsId: 7,
          requestHeaders: webHeaders,
        },
        7,
      ),
    ).toBe(webHeaders);

    const unrelatedHeaders = {};
    expect(
      youtubeEmbedRequestHeaders(
        {
          url: "https://www.youtube.com/watch?v=video-id",
          resourceType: "mainFrame",
          webContentsId: 7,
          requestHeaders: unrelatedHeaders,
        },
        7,
      ),
    ).toBe(unrelatedHeaders);
  });
});

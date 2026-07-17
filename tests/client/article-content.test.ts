import { describe, expect, it } from "vitest";
import { articleContentView } from "../../src/client/article-content.js";
import type { Article } from "../../src/shared/types.js";

function linkedArticle(): Article {
  return {
    id: 1,
    feedId: 1,
    feedTitle: "Linked feed",
    folderId: null,
    title: "Commentary about an external post",
    url: "https://external.example/post",
    author: "Feed author",
    publishedAt: null,
    discoveredAt: "2026-07-17T00:00:00.000Z",
    summary: "Feed summary",
    imageUrl: null,
    media: null,
    feedContentHtml: "<p>Complete commentary supplied by the feed.</p>",
    contentHtml: "<p>Text extracted from the external post.</p>",
    contentSource: "article",
    extractionStatus: "complete",
    extractionError: null,
    isRead: false,
    isStarred: false,
  };
}

describe("article content source selection", () => {
  it("keeps the feed article visible until full content is explicitly selected", () => {
    const article = linkedArticle();

    expect(articleContentView(article, false)).toBe("feed");
    expect(articleContentView(article, true)).toBe("full");
  });

  it("keeps extraction progress and failure distinct from the feed fallback", () => {
    const article = linkedArticle();

    expect(
      articleContentView({ ...article, contentHtml: null, extractionStatus: "processing" }, true),
    ).toBe("loading");
    expect(
      articleContentView({ ...article, contentHtml: null, extractionStatus: "failed" }, true),
    ).toBe("failed");
  });
});

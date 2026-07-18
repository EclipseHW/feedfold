import { afterEach, describe, expect, it } from "vitest";
import { prepareArticleSummary } from "../../src/server/ai/article-summary.js";
import { CredentialCipher } from "../../src/server/ai/credential-cipher.js";
import { AiError } from "../../src/server/ai/errors.js";
import { AiService } from "../../src/server/ai/service.js";
import { AuthService } from "../../src/server/auth.js";
import { AppDatabase, type ParsedFeed } from "../../src/server/db.js";

const cleanups: Array<() => Promise<void> | void> = [];
const CREDENTIAL_KEY = "11".repeat(32);

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function databaseWithUsers(): { database: AppDatabase; readerId: number; partnerId: number } {
  const database = new AppDatabase(":memory:");
  cleanups.push(() => database.close());
  const auth = new AuthService(database);
  const reader = auth.register("reader", "reader-password")?.user;
  const partner = auth.register("partner", "partner-password")?.user;
  if (!reader || !partner) throw new Error("Test accounts could not be created");
  return { database, readerId: reader.id, partnerId: partner.id };
}

function addArticle(database: AppDatabase, userId: number): { feedId: number; articleId: number } {
  const feed = database.createFeed(userId, {
    title: "Engineering",
    feedUrl: `https://example.test/feed-${userId}`,
  });
  const parsed: ParsedFeed = {
    title: "Engineering",
    siteUrl: "https://example.test",
    articles: [
      {
        externalId: "story",
        title: "A useful story",
        url: "https://example.test/story",
        author: "Ada Example",
        publishedAt: "2026-07-18T08:00:00.000Z",
        summary: "A short fallback.",
        imageUrl: null,
        feedContentHtml:
          "<article><p>The full feed article explains an important result.</p></article>",
      },
    ],
  };
  database.markFeedSuccess(feed.id, {
    httpStatus: 200,
    etag: null,
    lastModified: null,
    pollIntervalMinutes: 20,
    parsed,
  });
  const articleId = database.listArticles(userId, { state: "all" })[0]?.id;
  if (!articleId) throw new Error("Test article was not stored");
  return { feedId: feed.id, articleId };
}

describe("AI article summaries", () => {
  it("encrypts provider keys per account and never exposes them through settings", () => {
    const { database, readerId, partnerId } = databaseWithUsers();
    const cipher = CredentialCipher.fromHex(CREDENTIAL_KEY);
    if (!cipher) throw new Error("Credential cipher was not created");
    const service = new AiService(database, { credentialCipher: cipher });

    service.setApiKey(readerId, "openai", "reader-secret-key");
    service.setFeatureSetting(readerId, "article_summary", "openai");

    const readerSettings = service.getSettings(readerId);
    expect(readerSettings).toMatchObject({
      credentialStorageAvailable: true,
      features: { articleSummary: { provider: "openai", model: "gpt-5.6-luna" } },
    });
    expect(readerSettings.providers.find((provider) => provider.id === "openai")).toMatchObject({
      configured: true,
    });
    const partnerSettings = service.getSettings(partnerId);
    expect(partnerSettings).toMatchObject({
      features: { articleSummary: null },
    });
    expect(partnerSettings.providers.find((provider) => provider.id === "openai")).toMatchObject({
      configured: false,
    });
    const stored = database.getEncryptedAiCredential(readerId, "openai");
    expect(stored).not.toBeNull();
    expect(stored).not.toContain("reader-secret-key");
    expect(() => cipher.decrypt(partnerId, "openai", stored ?? "")).toThrow(AiError);
  });

  it("prefers full article text and keeps both ends of oversized sources", () => {
    const prepared = prepareArticleSummary({
      id: 1,
      revision: 1,
      title: "Long article",
      url: "https://example.test/long",
      author: null,
      contentHtml: `<p>START-${"a".repeat(120_000)}-END</p>`,
      feedContentHtml: "<p>Feed fallback must not be selected.</p>",
      excerpt: "Excerpt fallback must not be selected.",
      currentSummary: null,
    });

    expect(prepared.sourceKind).toBe("full");
    expect(prepared.input).toContain("START-");
    expect(prepared.input).toContain("characters omitted from the middle");
    expect(prepared.input).toContain("-END");
    expect(prepared.input).not.toContain("Feed fallback");
  });

  it("keeps a summary for metadata-only refreshes and invalidates it when source text changes", () => {
    const { database, readerId, partnerId } = databaseWithUsers();
    const { feedId, articleId } = addArticle(database, readerId);
    const article = database.getArticleForAiSummary(readerId, articleId);
    if (!article) throw new Error("Test article is unavailable");
    database.saveArticleAiSummary(readerId, articleId, article.revision, {
      promptVersion: 1,
      sourceKind: "feed",
      provider: "openai",
      model: "gpt-5.6-luna",
      text: "Stored summary",
      usage: { inputTokens: 10, outputTokens: 3 },
    });

    const metadataOnly = {
      externalId: "story",
      title: "A useful story",
      url: "https://example.test/story",
      author: "Ada Example",
      publishedAt: "2026-07-18T09:00:00.000Z",
      summary: "A short fallback.",
      imageUrl: null,
      feedContentHtml:
        "<article><p>The full feed article explains an important result.</p></article>",
    };
    database.markFeedSuccess(feedId, {
      httpStatus: 200,
      etag: null,
      lastModified: null,
      pollIntervalMinutes: 20,
      parsed: {
        title: "Engineering",
        siteUrl: "https://example.test",
        articles: [metadataOnly],
      },
    });
    expect(database.getArticle(readerId, articleId)?.aiSummary?.text).toBe("Stored summary");

    database.markFeedSuccess(feedId, {
      httpStatus: 200,
      etag: null,
      lastModified: null,
      pollIntervalMinutes: 20,
      parsed: {
        title: "Engineering",
        siteUrl: "https://example.test",
        articles: [{ ...metadataOnly, title: "A corrected story" }],
      },
    });
    expect(database.getArticle(readerId, articleId)?.aiSummary).toBeNull();
    expect(database.getArticleForAiSummary(partnerId, articleId)).toBeNull();
  });

  it("explains whether the provider selection or its API key is missing", async () => {
    const { database, readerId } = databaseWithUsers();
    const { articleId } = addArticle(database, readerId);
    const cipher = CredentialCipher.fromHex(CREDENTIAL_KEY);
    if (!cipher) throw new Error("Credential cipher was not created");
    const service = new AiService(database, { credentialCipher: cipher });

    await expect(service.summarizeArticle(readerId, articleId)).rejects.toMatchObject({
      code: "AI_NOT_CONFIGURED",
      statusCode: 422,
    });
    service.setFeatureSetting(readerId, "article_summary", "anthropic");
    await expect(service.summarizeArticle(readerId, articleId)).rejects.toMatchObject({
      code: "AI_KEY_MISSING",
      statusCode: 422,
    });
  });
});

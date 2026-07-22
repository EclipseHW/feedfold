import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it } from "vitest";
import { prepareArticleSummary } from "../../src/server/ai/article-summary.js";
import {
  prepareArticleTranslation,
  renderArticleTranslation,
} from "../../src/server/ai/article-translation.js";
import { CredentialCipher } from "../../src/server/ai/credential-cipher.js";
import { AiError } from "../../src/server/ai/errors.js";
import { createAiProviders } from "../../src/server/ai/providers.js";
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

async function liveOpenAiProvider(): Promise<{
  providers: ReturnType<typeof createAiProviders>;
  requests: Array<Record<string, unknown>>;
}> {
  const requests: Array<Record<string, unknown>> = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      requests.push(body);
      const input = String(body.input);
      const language = input.includes("Target language: French") ? "Français" : "Polski";
      const ids = [...input.matchAll(/data-translation-id="(\d+)"/gu)].map((match) => match[1]);
      const text = JSON.stringify(
        Object.fromEntries(ids.map((id) => [id, `${language} fragment ${id}`])),
      );
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          status: "completed",
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text }],
            },
          ],
          usage: { input_tokens: 24, output_tokens: 8 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { providers: createAiProviders({ openai: baseUrl }), requests };
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

  it("preserves links, images, and quotations while replacing only translated text", () => {
    const article = {
      id: 1,
      revision: 1,
      title: "Structured article",
      url: null,
      author: null,
      contentHtml: null,
      feedContentHtml: `<p>Sales start: <a href="https://busy.app/" target="_blank" rel="noopener noreferrer">https://busy.app</a></p>
        <figure><img src="https://example.test/product.png" alt="Product"><figcaption>Product image.</figcaption></figure>
        <blockquote class="article-prose-quote article-prose-quote-marked"><span class="article-quote-mark" aria-hidden="true">“</span><p><strong>Quoted claim.</strong> More context.</p></blockquote>`,
      excerpt: "Fallback excerpt with https://example.test/story",
      currentSummary: null,
    };

    const prepared = prepareArticleTranslation(article, "Polish", "feed");
    expect(prepared).toMatchObject({ sourceKind: "feed", segmentCount: 4 });
    expect(prepared.input).toContain('<span data-translation-id="0">Sales start:</span>');
    expect(prepared.input).not.toContain("https://example.test/product.png");

    const html = renderArticleTranslation(
      prepared,
      JSON.stringify({
        0: "Sprzedaż rusza:",
        1: "Zdjęcie produktu.",
        2: "Cytowane stwierdzenie.",
        3: "Więcej kontekstu.",
      }),
    );
    const body = new JSDOM(`<body>${html}</body>`).window.document.body;
    expect(body.querySelector("a")).toMatchObject({
      href: "https://busy.app/",
      textContent: "https://busy.app",
      target: "_blank",
    });
    expect(body.querySelector("img")).toMatchObject({
      src: "https://example.test/product.png",
      alt: "Product",
    });
    expect(body.querySelector("blockquote")?.className).toBe(
      "article-prose-quote article-prose-quote-marked",
    );
    expect(body.querySelector(".article-quote-mark")).toMatchObject({
      textContent: "“",
      ariaHidden: "true",
    });
    expect(body.querySelector("blockquote strong")?.textContent).toBe("Cytowane stwierdzenie.");
    expect(body.querySelector("blockquote p")?.textContent).toBe(
      "Cytowane stwierdzenie. Więcej kontekstu.",
    );

    const excerpt = prepareArticleTranslation(article, "Polish", "excerpt");
    expect(renderArticleTranslation(excerpt, '{"0":"Zapasowy fragment z"}')).toContain(
      '<a href="https://example.test/story"',
    );
    expect(() => renderArticleTranslation(prepared, '{"0":"Incomplete"}')).toThrow(
      expect.objectContaining({ code: "AI_RESPONSE_INVALID" }),
    );
    expect(() => prepareArticleTranslation(article, "Polish", "full")).toThrow(AiError);
  });

  it("uses the summary model for cached translations in the configured account language", async () => {
    const { database, readerId } = databaseWithUsers();
    const { articleId } = addArticle(database, readerId);
    const cipher = CredentialCipher.fromHex(CREDENTIAL_KEY);
    if (!cipher) throw new Error("Credential cipher was not created");
    const { providers, requests } = await liveOpenAiProvider();
    const service = new AiService(database, { credentialCipher: cipher, providers });
    service.setApiKey(readerId, "openai", "live-provider-test-key");
    service.setFeatureSetting(readerId, "article_summary", "openai", "shared-reader-model");
    database.updateSettings(readerId, { translationLanguage: "Polish" });

    const first = await service.translateArticle(readerId, articleId, "feed");
    expect(first).toMatchObject({
      html: "<article><p>Polski fragment 0</p></article>",
      language: "Polish",
      provider: "openai",
      model: "shared-reader-model",
      sourceKind: "feed",
      usage: { inputTokens: 24, outputTokens: 8 },
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      model: "shared-reader-model",
      max_output_tokens: 32_000,
      input: expect.stringContaining("Target language: Polish"),
    });

    expect(await service.translateArticle(readerId, articleId, "feed")).toEqual(first);
    expect(requests).toHaveLength(1);

    service.deleteApiKey(readerId, "openai");
    expect(await service.translateArticle(readerId, articleId, "feed")).toEqual(first);
    expect(requests).toHaveLength(1);

    service.setApiKey(readerId, "openai", "live-provider-test-key");
    database.updateSettings(readerId, { translationLanguage: "French" });
    expect(await service.translateArticle(readerId, articleId, "feed")).toMatchObject({
      html: "<article><p>Français fragment 0</p></article>",
      language: "French",
      model: "shared-reader-model",
    });
    expect(requests).toHaveLength(2);
  });

  it("uses account prompts and regenerates cached output after either prompt changes", async () => {
    const { database, readerId } = databaseWithUsers();
    const { articleId } = addArticle(database, readerId);
    const cipher = CredentialCipher.fromHex(CREDENTIAL_KEY);
    if (!cipher) throw new Error("Credential cipher was not created");
    const { providers, requests } = await liveOpenAiProvider();
    const service = new AiService(database, { credentialCipher: cipher, providers });
    service.setApiKey(readerId, "openai", "live-provider-test-key");
    service.setFeatureSetting(readerId, "article_summary", "openai", "shared-reader-model");
    database.updateSettings(readerId, {
      translationLanguage: "Polish",
      summaryPrompt: "Write one short summary paragraph.",
      translationPrompt: "Translate every marked fragment and return one JSON object.",
    });

    await service.summarizeArticle(readerId, articleId);
    await service.translateArticle(readerId, articleId, "feed");
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({ instructions: "Write one short summary paragraph." });
    expect(requests[1]).toMatchObject({
      instructions: "Translate every marked fragment and return one JSON object.",
    });

    await service.summarizeArticle(readerId, articleId);
    await service.translateArticle(readerId, articleId, "feed");
    expect(requests).toHaveLength(2);

    database.updateSettings(readerId, {
      summaryPrompt: "Write a detailed summary with key points.",
      translationPrompt: "Translate all marked fragments and return only their JSON object.",
    });
    expect(database.getArticle(readerId, articleId)?.aiSummary).toBeNull();

    await service.summarizeArticle(readerId, articleId);
    await service.translateArticle(readerId, articleId, "feed");
    expect(requests).toHaveLength(4);
    expect(requests[2]).toMatchObject({
      instructions: "Write a detailed summary with key points.",
    });
    expect(requests[3]).toMatchObject({
      instructions: "Translate all marked fragments and return only their JSON object.",
    });
  });

  it("keeps a summary for metadata-only refreshes and invalidates it when source text changes", () => {
    const { database, readerId, partnerId } = databaseWithUsers();
    const { feedId, articleId } = addArticle(database, readerId);
    const article = database.getArticleForAi(readerId, articleId);
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
    expect(database.getArticleForAi(partnerId, articleId)).toBeNull();
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
    await expect(service.translateArticle(readerId, articleId, "feed")).rejects.toMatchObject({
      code: "AI_NOT_CONFIGURED",
      statusCode: 422,
    });
    service.setFeatureSetting(readerId, "article_summary", "anthropic");
    await expect(service.summarizeArticle(readerId, articleId)).rejects.toMatchObject({
      code: "AI_KEY_MISSING",
      statusCode: 422,
    });
    await expect(service.translateArticle(readerId, articleId, "feed")).rejects.toMatchObject({
      code: "AI_KEY_MISSING",
      statusCode: 422,
    });
  });

  it("stores any provider model ID entered by the user", () => {
    const { database, readerId } = databaseWithUsers();
    const cipher = CredentialCipher.fromHex(CREDENTIAL_KEY);
    if (!cipher) throw new Error("Credential cipher was not created");
    const service = new AiService(database, { credentialCipher: cipher });

    const settings = service.setFeatureSetting(
      readerId,
      "article_summary",
      "openai",
      "my-team/custom-summary-model",
    );

    expect(settings.features.articleSummary).toEqual({
      provider: "openai",
      model: "my-team/custom-summary-model",
    });
  });
});

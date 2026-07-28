import { existsSync } from "node:fs";
import { join } from "node:path";
import fastifyStatic from "@fastify/static";
import { SqliteError } from "better-sqlite3";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { ZodError, z } from "zod";
import { AI_PROMPT_MAX_LENGTH } from "../shared/ai-prompts.js";
import {
  type AiArticleSourceKind,
  type AiFeature,
  type AiProvider,
  type ArticleQuery,
  DUPLICATE_ARTICLE_WINDOW_DAYS,
  type DuplicateArticleWindowDays,
  MARK_READ_AGE_DAYS,
  type MarkReadAgeDays,
  type MarkReadRequest,
  type WebFeedConfig,
} from "../shared/types.js";
import { AiError } from "./ai/errors.js";
import { AiService } from "./ai/service.js";
import { type AuthService, type LoginSession, sessionToken } from "./auth.js";
import type { AppDatabase } from "./db.js";
import { InvalidRequestError } from "./errors.js";
import type { ExtractionQueue } from "./extraction.js";
import { discoverFeed, FeedDiscoveryError } from "./feed-discovery.js";
import { exportOpml, importOpml } from "./opml.js";
import type { FeedRefreshService } from "./refresh.js";
import { WebFeedError, type WebFeedService } from "./web-feed.js";

export interface AppServices {
  database: AppDatabase;
  authService: AuthService;
  extractionQueue: ExtractionQueue;
  refreshService: FeedRefreshService;
  webFeedService?: WebFeedService;
  aiService?: AiService;
  feedDiscoveryTimeoutMs?: number;
  staticDir?: string;
  logger?: boolean;
}

const idParams = z.object({ id: z.coerce.number().int().positive() });
const appBasePath = "/echovale";
const aiFeatureParams = z.object({ feature: z.literal("article_summary") });
const aiProviderParams = z.object({ provider: z.enum(["gemini", "openai", "anthropic"]) });
const nullableId = z.number().int().positive().nullable();
const markReadAgeDays = z
  .number()
  .int()
  .refine(
    (value) => MARK_READ_AGE_DAYS.includes(value as MarkReadAgeDays),
    "Choose one of the available age thresholds",
  );
const duplicateArticleWindowDays = z.custom<DuplicateArticleWindowDays>(
  (value) =>
    typeof value === "number" &&
    DUPLICATE_ARTICLE_WINDOW_DAYS.includes(value as DuplicateArticleWindowDays),
  "Choose 1, 7, or 30 days",
);
const credentials = z.object({
  username: z.string().trim().min(1).max(80),
  password: z.string().min(1).max(1_024),
});
const httpUrl = z
  .string()
  .trim()
  .min(1)
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "http:" || url.protocol === "https:";
    } catch {
      return false;
    }
  }, "Must be an HTTP or HTTPS URL");
const selector = z.string().trim().min(1).max(2_000);
const optionalSelector = selector.nullable();
const webFeedConfig = z
  .object({
    pageUrl: httpUrl,
    selectors: z
      .object({
        item: selector,
        title: selector,
        link: selector,
        date: optionalSelector,
        author: optionalSelector,
        summary: optionalSelector,
        image: optionalSelector,
      })
      .strict(),
    minimumItemCount: z.number().int().min(2).max(1_000),
  })
  .strict();

function missing(reply: FastifyReply, resource: string): FastifyReply {
  return reply.code(404).send({ error: `${resource} not found` });
}

function secureRequest(request: FastifyRequest): boolean {
  return request.protocol === "https";
}

function sendSession(
  reply: FastifyReply,
  request: FastifyRequest,
  authService: AuthService,
  session: LoginSession,
): FastifyReply {
  return reply
    .header("Set-Cookie", authService.sessionCookie(session.token, secureRequest(request)))
    .send({ user: session.user });
}

export async function createApp(services: AppServices): Promise<FastifyInstance> {
  const app = Fastify({
    logger: services.logger ?? false,
    bodyLimit: 10 * 1024 * 1024,
    trustProxy: true,
    rewriteUrl(request) {
      const url = request.url ?? "/";
      if (url === appBasePath) return "/";
      return url.startsWith(`${appBasePath}/`) ? url.slice(appBasePath.length) : url;
    },
  });
  const aiService =
    services.aiService ??
    new AiService(services.database, {
      credentialCipher: null,
    });
  const requestUsers = new WeakMap<FastifyRequest, { id: number; username: string }>();
  const userId = (request: FastifyRequest): number => {
    const user = requestUsers.get(request);
    if (!user) throw new Error("Authenticated user is missing");
    return user.id;
  };

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AiError) {
      reply.code(error.statusCode).send({ error: error.message, code: error.code });
      return;
    }
    if (error instanceof WebFeedError) {
      reply.code(422).send({ error: error.message, code: error.kind });
      return;
    }
    if (error instanceof ZodError) {
      reply.code(400).send({ error: error.issues[0]?.message ?? "Invalid request" });
      return;
    }
    if (error instanceof InvalidRequestError) {
      reply.code(400).send({ error: error.message });
      return;
    }
    if (error instanceof SqliteError) {
      if (
        error.code === "SQLITE_CONSTRAINT_UNIQUE" ||
        error.code === "SQLITE_CONSTRAINT_PRIMARYKEY"
      ) {
        reply.code(409).send({ error: "That item already exists" });
        return;
      }
      if (error.code === "SQLITE_CONSTRAINT_FOREIGNKEY") {
        reply.code(400).send({ error: "The selected folder or feed does not exist" });
        return;
      }
    }
    app.log.error(error);
    reply.code(500).send({ error: "Internal server error" });
  });

  app.get("/health", async () => {
    services.database.sqlite.prepare("SELECT 1").get();
    return { status: "ok" };
  });

  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/api/")) return;
    reply.header("Cache-Control", "no-store");
    const path = request.url.split("?", 1)[0];
    if (path === "/api/auth/login" || path === "/api/auth/register" || path === "/api/auth/session")
      return;
    const user = services.authService.userForToken(sessionToken(request.headers.cookie));
    if (!user) return reply.code(401).send({ error: "Sign in required" });
    requestUsers.set(request, user);
  });

  app.post("/api/auth/login", async (request, reply) => {
    const body = credentials.parse(request.body);
    const session = services.authService.login(body.username, body.password);
    if (!session) {
      return reply.code(401).send({ error: "Username or password is incorrect" });
    }
    return sendSession(reply, request, services.authService, session);
  });

  app.post("/api/auth/register", async (request, reply) => {
    const body = credentials.parse(request.body);
    const session = services.authService.register(body.username, body.password);
    if (!session) return reply.code(409).send({ error: "That username is already taken" });
    return sendSession(reply.code(201), request, services.authService, session);
  });

  app.get("/api/auth/session", async (request, reply) => {
    const user = services.authService.userForToken(sessionToken(request.headers.cookie));
    if (!user) return reply.code(401).send({ error: "Sign in required" });
    return { user };
  });

  app.post("/api/auth/logout", async (request, reply) => {
    services.authService.endSession(sessionToken(request.headers.cookie));
    return reply
      .header("Set-Cookie", services.authService.clearSessionCookie(secureRequest(request)))
      .code(204)
      .send();
  });

  app.get("/api/bootstrap", async (request) => {
    const accountId = userId(request);
    return {
      ...services.database.getBootstrap(accountId),
      aiSettings: aiService.getSettings(accountId),
    };
  });

  app.get("/api/articles", async (request) => {
    const query = z
      .object({
        state: z.enum(["all", "unread", "read", "starred"]).default("unread"),
        feedId: z.coerce.number().int().positive().optional(),
        folderId: z.coerce.number().int().positive().optional(),
        search: z.string().trim().max(300).optional(),
        limit: z.coerce.number().int().min(1).max(500).optional(),
        cursor: z.string().min(1).max(50_000).optional(),
        anchorId: z.coerce.number().int().positive().optional(),
        includeContent: z
          .enum(["true", "false"])
          .transform((value) => value === "true")
          .optional(),
      })
      .parse(request.query) as ArticleQuery;
    return services.database.listArticlePage(userId(request), query);
  });

  app.get("/api/articles/:id", async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const article = services.database.getArticle(userId(request), id);
    return article ?? missing(reply, "Article");
  });

  app.patch("/api/articles/:id/state", async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const body = z
      .object({ isRead: z.boolean().optional(), isStarred: z.boolean().optional() })
      .refine((value) => value.isRead !== undefined || value.isStarred !== undefined, {
        message: "Provide isRead or isStarred",
      })
      .parse(request.body);
    const article = services.database.updateArticleState(userId(request), id, body);
    return article ?? missing(reply, "Article");
  });

  app.post("/api/articles/mark-read", async (request) => {
    const body = z
      .object({
        articleIds: z.array(z.number().int().positive()).max(1_000).optional(),
        feedId: z.number().int().positive().optional(),
        folderId: z.number().int().positive().optional(),
        olderThanDays: markReadAgeDays.optional(),
      })
      .parse(request.body ?? {}) as MarkReadRequest;
    return { updated: services.database.markArticlesRead(userId(request), body) };
  });

  app.post("/api/articles/:id/extract", async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const accountId = userId(request);
    if (!services.database.getArticle(accountId, id)) return missing(reply, "Article");
    if (services.database.requestExtraction(accountId, id)) {
      services.extractionQueue.prioritize(id);
    }
    return services.database.getArticle(accountId, id);
  });

  app.post("/api/articles/:id/summary", async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const { promptId, regenerate } = z
      .object({ promptId: z.uuid().nullable(), regenerate: z.boolean() })
      .parse(request.body ?? {});
    const summary = await aiService.summarizeArticle(userId(request), id, promptId, regenerate);
    return summary ?? missing(reply, "Article");
  });

  app.post("/api/articles/:id/translation", async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const { sourceKind } = z
      .object({ sourceKind: z.enum(["full", "feed", "excerpt"]) })
      .parse(request.body) as { sourceKind: AiArticleSourceKind };
    const translation = await aiService.translateArticle(userId(request), id, sourceKind);
    return translation ?? missing(reply, "Article");
  });

  app.get("/api/feeds", async (request) => ({
    feeds: services.database.listFeeds(userId(request)),
  }));

  app.get("/api/feeds/:id", async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const feed = services.database.getFeed(userId(request), id);
    return feed ?? missing(reply, "Feed");
  });

  app.post("/api/feeds/discover", async (request, reply) => {
    const { url } = z.object({ url: httpUrl }).parse(request.body);
    try {
      return await discoverFeed(url, services.feedDiscoveryTimeoutMs);
    } catch (error) {
      if (error instanceof FeedDiscoveryError) {
        return reply.code(422).send({ error: error.message, code: error.kind });
      }
      throw error;
    }
  });

  app.post("/api/web-feeds/analyze", async (request, reply) => {
    if (!services.webFeedService) {
      return reply.code(503).send({ error: "Web feed loading is unavailable on this server" });
    }
    const { url } = z.object({ url: httpUrl }).strict().parse(request.body);
    return services.webFeedService.analyze(String(userId(request)), url);
  });

  app.get("/api/web-feed-snapshots/:id", async (request, reply) => {
    if (!services.webFeedService) return missing(reply, "Page preview");
    const { id } = z.object({ id: z.string().min(1).max(200) }).parse(request.params);
    try {
      const snapshot = services.webFeedService.snapshot(String(userId(request)), id);
      return reply
        .type("text/html; charset=utf-8")
        .header(
          "Content-Security-Policy",
          "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
        )
        .header("Cross-Origin-Resource-Policy", "same-origin")
        .header("Referrer-Policy", "no-referrer")
        .header("X-Content-Type-Options", "nosniff")
        .send(snapshot);
    } catch (error) {
      if (error instanceof WebFeedError) {
        return reply.code(404).send({
          error: "This page preview has expired. Reload the page to continue.",
          code: error.kind,
        });
      }
      throw error;
    }
  });

  app.post("/api/feeds", async (request, reply) => {
    const body = z
      .discriminatedUnion("sourceKind", [
        z
          .object({
            sourceKind: z.literal("published"),
            title: z.string().trim().min(1).max(300).optional(),
            feedUrl: httpUrl,
            siteUrl: httpUrl.nullable().optional(),
            folderId: nullableId.optional(),
            paused: z.boolean().optional(),
          })
          .strict(),
        z
          .object({
            sourceKind: z.literal("web"),
            title: z.string().trim().min(1).max(300).optional(),
            feedUrl: httpUrl,
            siteUrl: httpUrl.nullable().optional(),
            folderId: nullableId.optional(),
            webConfig: webFeedConfig,
          })
          .strict(),
      ])
      .parse(request.body);
    const accountId = userId(request);
    if (body.sourceKind === "published") {
      const feed = services.database.createFeed(accountId, body);
      if (!feed.paused) services.refreshService.request([feed.id]);
      return services.database.getFeed(accountId, feed.id);
    }
    if (!services.webFeedService) {
      return reply.code(503).send({ error: "Web feed loading is unavailable on this server" });
    }
    const extracted = await services.webFeedService.extract(body.webConfig as WebFeedConfig);
    return services.database.createWebFeed(accountId, {
      title: body.title ?? extracted.parsed.title,
      pageUrl: body.feedUrl,
      folderId: body.folderId ?? null,
      config: body.webConfig as WebFeedConfig,
      parsed: extracted.parsed,
    });
  });

  app.post("/api/feeds/:id/web-feed/analyze", async (request, reply) => {
    if (!services.webFeedService) {
      return reply.code(503).send({ error: "Web feed loading is unavailable on this server" });
    }
    const { id } = idParams.parse(request.params);
    const accountId = userId(request);
    const feed = services.database.getFeed(accountId, id);
    if (!feed) return missing(reply, "Feed");
    if (feed.sourceKind !== "web") {
      return reply.code(400).send({ error: "Only web feeds have page selections" });
    }
    const config = services.database.getWebFeedConfig(accountId, id);
    if (!config) return missing(reply, "Page selection");
    return services.webFeedService.analyze(String(accountId), config.pageUrl, config);
  });

  app.patch("/api/feeds/:id/web-feed", async (request, reply) => {
    if (!services.webFeedService) {
      return reply.code(503).send({ error: "Web feed loading is unavailable on this server" });
    }
    const { id } = idParams.parse(request.params);
    const { config } = z.object({ config: webFeedConfig }).strict().parse(request.body);
    const accountId = userId(request);
    const feed = services.database.getFeed(accountId, id);
    if (!feed) return missing(reply, "Feed");
    if (feed.sourceKind !== "web") {
      return reply.code(400).send({ error: "Only web feeds have page selections" });
    }
    const extracted = await services.webFeedService.extract(config as WebFeedConfig);
    const updated = services.database.updateWebFeedSelection(
      accountId,
      id,
      config as WebFeedConfig,
      extracted.parsed,
    );
    return updated ?? missing(reply, "Feed");
  });

  app.patch("/api/feeds/:id", async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const body = z
      .object({
        title: z.string().trim().min(1).max(300).optional(),
        feedUrl: httpUrl.optional(),
        siteUrl: httpUrl.nullable().optional(),
        folderId: nullableId.optional(),
        paused: z.boolean().optional(),
      })
      .parse(request.body);
    const feed = services.database.updateFeed(userId(request), id, body);
    return feed ?? missing(reply, "Feed");
  });

  app.delete("/api/feeds/:id", async (request, reply) => {
    const { id } = idParams.parse(request.params);
    if (!services.database.deleteFeed(userId(request), id)) return missing(reply, "Feed");
    return reply.code(204).send();
  });

  app.post("/api/feeds/:id/refresh", async (request, reply) => {
    const { id } = idParams.parse(request.params);
    if (!services.database.getFeed(userId(request), id)) return missing(reply, "Feed");
    return services.refreshService.request([id]);
  });

  app.get("/api/folders", async (request) => ({
    folders: services.database.listFolders(userId(request)),
  }));

  app.post("/api/folders", async (request) => {
    const body = z
      .object({
        name: z.string().trim().min(1).max(200),
        parentId: nullableId.optional(),
        position: z.number().int().min(0).optional(),
        sortDirection: z.enum(["newest", "oldest"]).optional(),
      })
      .parse(request.body);
    return services.database.createFolder(userId(request), body);
  });

  app.patch("/api/folders/:id", async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const body = z
      .object({
        name: z.string().trim().min(1).max(200).optional(),
        parentId: nullableId.optional(),
        position: z.number().int().min(0).optional(),
        sortDirection: z.enum(["newest", "oldest"]).optional(),
      })
      .parse(request.body);
    const folder = services.database.updateFolder(userId(request), id, body);
    return folder ?? missing(reply, "Folder");
  });

  app.delete("/api/folders/:id", async (request, reply) => {
    const { id } = idParams.parse(request.params);
    if (!services.database.deleteFolder(userId(request), id)) return missing(reply, "Folder");
    return reply.code(204).send();
  });

  app.get("/api/rules", async (request) => ({
    rules: services.database.listRules(userId(request)),
  }));

  const ruleCondition = z.object({
    field: z.enum(["title", "author", "summary", "content", "media", "any"]),
    pattern: z.string().trim().min(1).max(500),
  });
  const ruleFields = z
    .object({
      name: z.string().trim().min(1).max(200),
      feedId: nullableId.optional(),
      folderId: nullableId.optional(),
      conditions: z.array(ruleCondition).min(1),
      conditionOperator: z.enum(["and", "or"]),
      action: z.enum(["hide", "keep", "mark_read"]),
      enabled: z.boolean().optional(),
    })
    .strict();
  const ruleBody = ruleFields.refine((value) => !(value.feedId && value.folderId), {
    message: "A rule can target a feed or a folder, not both",
  });

  app.post("/api/rules", async (request) =>
    services.database.createRule(userId(request), ruleBody.parse(request.body)),
  );

  app.patch("/api/rules/:id", async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const accountId = userId(request);
    const existing = services.database.getRule(accountId, id);
    if (!existing) return missing(reply, "Rule");
    const body = ruleFields.partial().parse(request.body);
    if (
      (body.feedId === undefined ? existing.feedId : body.feedId) &&
      (body.folderId === undefined ? existing.folderId : body.folderId)
    ) {
      return reply.code(400).send({ error: "A rule can target a feed or a folder, not both" });
    }
    return services.database.updateRule(accountId, id, body);
  });

  app.delete("/api/rules/:id", async (request, reply) => {
    const { id } = idParams.parse(request.params);
    if (!services.database.deleteRule(userId(request), id)) return missing(reply, "Rule");
    return reply.code(204).send();
  });

  app.get("/api/settings", async (request) => services.database.getSettings(userId(request)));

  app.patch("/api/settings", async (request) => {
    const body = z
      .object({
        pollIntervalMinutes: z.number().int().min(1).max(1_440).optional(),
        duplicateArticleWindowDays: duplicateArticleWindowDays.optional(),
        singleKeyShortcuts: z.boolean().optional(),
        markReadOnScroll: z.boolean().optional(),
        translationLanguage: z.string().trim().min(1).max(80).optional(),
        summaryPrompt: z.string().trim().min(1).max(AI_PROMPT_MAX_LENGTH).optional(),
        translationPrompt: z.string().trim().min(1).max(AI_PROMPT_MAX_LENGTH).optional(),
        customPrompts: z
          .array(
            z
              .object({
                id: z.uuid(),
                name: z.string().trim().min(1).max(80),
                prompt: z.string().trim().min(1).max(AI_PROMPT_MAX_LENGTH),
              })
              .strict(),
          )
          .optional(),
      })
      .parse(request.body);
    return services.database.updateSettings(userId(request), body);
  });

  app.get("/api/ai/settings", async (request) => aiService.getSettings(userId(request)));

  app.patch("/api/ai/features/:feature", async (request) => {
    const { feature } = aiFeatureParams.parse(request.params) as { feature: AiFeature };
    const body = z
      .object({
        provider: z.enum(["gemini", "openai", "anthropic"]),
        model: z.string().trim().min(1).max(200).optional(),
      })
      .parse(request.body) as { provider: AiProvider; model?: string };
    return aiService.setFeatureSetting(userId(request), feature, body.provider, body.model);
  });

  app.put("/api/ai/providers/:provider/key", async (request) => {
    const { provider } = aiProviderParams.parse(request.params) as { provider: AiProvider };
    const { apiKey } = z
      .object({ apiKey: z.string().trim().min(1).max(10_000) })
      .parse(request.body);
    return aiService.setApiKey(userId(request), provider, apiKey);
  });

  app.delete("/api/ai/providers/:provider/key", async (request) => {
    const { provider } = aiProviderParams.parse(request.params) as { provider: AiProvider };
    return aiService.deleteApiKey(userId(request), provider);
  });

  app.post("/api/refresh", async (request) => {
    const body = z
      .object({ feedIds: z.array(z.number().int().positive()).max(1_000).optional() })
      .parse(request.body ?? {});
    const feedIds = services.database.getUserRefreshFeedIds(userId(request), body.feedIds);
    return services.refreshService.request(feedIds);
  });

  app.post("/api/opml/import", async (request, reply) => {
    const { opml: source } = z.object({ opml: z.string().min(1) }).parse(request.body);
    try {
      const { feedIds, ...result } = importOpml(services.database, userId(request), source);
      services.refreshService.request(feedIds);
      return result;
    } catch (error) {
      return reply
        .code(400)
        .send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/api/opml/export", async (request, reply) => {
    return reply
      .header("Content-Type", "text/x-opml; charset=utf-8")
      .header("Content-Disposition", 'attachment; filename="echovale-subscriptions.opml"')
      .send(exportOpml(services.database, userId(request)));
  });

  if (services.staticDir && existsSync(join(services.staticDir, "index.html"))) {
    await app.register(fastifyStatic, {
      root: services.staticDir,
      wildcard: false,
      setHeaders(response, path) {
        if (path.endsWith("sw.js")) response.header("Cache-Control", "no-cache");
      },
    });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/") || request.url === "/health") {
        return reply.code(404).send({ error: "Not found" });
      }
      return reply.sendFile("index.html");
    });
  }

  return app;
}

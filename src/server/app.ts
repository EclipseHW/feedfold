import { existsSync } from "node:fs";
import { join } from "node:path";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { ZodError, z } from "zod";
import {
  type ArticleQuery,
  MARK_READ_AGE_DAYS,
  type MarkReadAgeDays,
  type MarkReadRequest,
} from "../shared/types.js";
import { type AuthService, type LoginSession, sessionToken } from "./auth.js";
import type { AppDatabase } from "./db.js";
import type { ExtractionQueue } from "./extraction.js";
import { discoverFeed, FeedDiscoveryError } from "./feed-discovery.js";
import { exportOpml, importOpml } from "./opml.js";
import type { FeedRefreshService } from "./refresh.js";

export interface AppServices {
  database: AppDatabase;
  authService: AuthService;
  extractionQueue: ExtractionQueue;
  refreshService: FeedRefreshService;
  feedDiscoveryTimeoutMs?: number;
  staticDir?: string;
  logger?: boolean;
}

const idParams = z.object({ id: z.coerce.number().int().positive() });
const nullableId = z.number().int().positive().nullable();
const markReadAgeDays = z
  .number()
  .int()
  .refine(
    (value) => MARK_READ_AGE_DAYS.includes(value as MarkReadAgeDays),
    "Choose one of the available age thresholds",
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
  });
  const requestUsers = new WeakMap<FastifyRequest, { id: number; username: string }>();
  const userId = (request: FastifyRequest): number => {
    const user = requestUsers.get(request);
    if (!user) throw new Error("Authenticated user is missing");
    return user.id;
  };

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      reply.code(400).send({ error: error.issues[0]?.message ?? "Invalid request" });
      return;
    }
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (errorMessage.includes("UNIQUE constraint failed")) {
      reply.code(409).send({ error: "That item already exists" });
      return;
    }
    if (errorMessage.includes("FOREIGN KEY constraint failed")) {
      reply.code(400).send({ error: "The selected folder or feed does not exist" });
      return;
    }
    if (errorMessage.includes("cannot be moved inside itself")) {
      reply.code(400).send({ error: errorMessage });
      return;
    }
    if (errorMessage === "The selected folder or feed does not exist") {
      reply.code(400).send({ error: errorMessage });
      return;
    }
    if (errorMessage === "Invalid article cursor") {
      reply.code(400).send({ error: errorMessage });
      return;
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

  app.get("/api/bootstrap", async (request) => services.database.getBootstrap(userId(request)));

  app.get("/api/articles", async (request) => {
    const query = z
      .object({
        state: z.enum(["all", "unread", "read", "starred"]).default("unread"),
        feedId: z.coerce.number().int().positive().optional(),
        folderId: z.coerce.number().int().positive().optional(),
        search: z.string().trim().max(300).optional(),
        limit: z.coerce.number().int().min(1).max(500).optional(),
        cursor: z.string().min(1).max(500).optional(),
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
    if (services.database.retryExtraction(accountId, id)) services.extractionQueue.prioritize(id);
    return services.database.getArticle(accountId, id);
  });

  app.get("/api/feeds", async (request) => ({
    feeds: services.database.listFeeds(userId(request)),
  }));

  app.post("/api/feeds/discover", async (request, reply) => {
    const { url } = z.object({ url: httpUrl }).parse(request.body);
    try {
      return await discoverFeed(url, services.feedDiscoveryTimeoutMs);
    } catch (error) {
      if (error instanceof FeedDiscoveryError) {
        return reply.code(422).send({ error: error.message });
      }
      throw error;
    }
  });

  app.post("/api/feeds", async (request) => {
    const body = z
      .object({
        title: z.string().trim().min(1).max(300).optional(),
        feedUrl: httpUrl,
        siteUrl: httpUrl.nullable().optional(),
        folderId: nullableId.optional(),
        paused: z.boolean().optional(),
      })
      .parse(request.body);
    const accountId = userId(request);
    const feed = services.database.createFeed(accountId, body);
    if (!feed.paused) services.refreshService.request([feed.id]);
    return services.database.getFeed(accountId, feed.id);
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
        singleKeyShortcuts: z.boolean().optional(),
        markReadOnScroll: z.boolean().optional(),
      })
      .parse(request.body);
    return services.database.updateSettings(userId(request), body);
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
    await app.register(fastifyStatic, { root: services.staticDir, wildcard: false });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/") || request.url === "/health") {
        return reply.code(404).send({ error: "Not found" });
      }
      return reply.sendFile("index.html");
    });
  }

  return app;
}

import { existsSync } from "node:fs";
import { join } from "node:path";
import fastifyStatic from "@fastify/static";
import { SqliteError } from "better-sqlite3";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { ZodError } from "zod";
import { AiError } from "./ai/errors.js";
import type { AppDatabase } from "./database.js";
import { InvalidRequestError } from "./errors.js";
import type { ExtractionQueue } from "./extraction.js";
import { aiRoutes } from "./features/ai/routes.js";
import { AiService } from "./features/ai/service.js";
import { articleRoutes } from "./features/articles/routes.js";
import { authRoutes } from "./features/auth/routes.js";
import { type AuthService, sessionToken } from "./features/auth/service.js";
import { bootstrapRoutes } from "./features/bootstrap/routes.js";
import { feedRoutes } from "./features/feeds/routes.js";
import { folderRoutes } from "./features/folders/routes.js";
import { opmlRoutes } from "./features/opml/routes.js";
import { refreshRoutes } from "./features/refresh/routes.js";
import { ruleRoutes } from "./features/rules/routes.js";
import { settingsRoutes } from "./features/settings/routes.js";
import type { FeedRefreshService } from "./refresh.js";
import { TelegramMediaService } from "./telegram-media.js";
import { WebFeedError, type WebFeedService } from "./web-feed.js";

export interface AppServices {
  database: AppDatabase;
  authService: AuthService;
  extractionQueue: ExtractionQueue;
  refreshService: FeedRefreshService;
  webFeedService?: WebFeedService;
  aiService?: AiService;
  telegramMediaService?: TelegramMediaService;
  feedDiscoveryTimeoutMs?: number;
  staticDir?: string;
  logger?: boolean;
}

const appBasePath = "/echovale";

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
  const ai =
    services.aiService ??
    new AiService(services.database, {
      credentialCipher: null,
    });
  const telegramMedia =
    services.telegramMediaService ??
    new TelegramMediaService(services.feedDiscoveryTimeoutMs ?? 15_000);
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
    services.database.connection.prepare("SELECT 1").get();
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

  await app.register(authRoutes, { authService: services.authService });
  await app.register(bootstrapRoutes, {
    bootstrap: services.database.bootstrap,
    ai,
    userId,
  });
  await app.register(articleRoutes, {
    articles: services.database.articles,
    extractions: services.database.extractions,
    extractionQueue: services.extractionQueue,
    ai,
    telegramMedia,
    userId,
  });
  await app.register(feedRoutes, {
    feeds: services.database.feeds,
    refreshService: services.refreshService,
    webFeedService: services.webFeedService,
    feedDiscoveryTimeoutMs: services.feedDiscoveryTimeoutMs,
    userId,
  });
  await app.register(folderRoutes, { folders: services.database.folders, userId });
  await app.register(ruleRoutes, { rules: services.database.rules, userId });
  await app.register(settingsRoutes, { settings: services.database.settings, userId });
  await app.register(aiRoutes, { ai, userId });
  await app.register(refreshRoutes, {
    feeds: services.database.feeds,
    refreshService: services.refreshService,
    userId,
  });
  await app.register(opmlRoutes, {
    opml: services.database.opml,
    refreshService: services.refreshService,
    userId,
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

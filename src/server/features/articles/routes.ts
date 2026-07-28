import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type {
  AiArticleSourceKind,
  ArticleQuery,
  MarkReadAgeDays,
  MarkReadRequest,
} from "../../../shared/types.js";
import { MARK_READ_AGE_DAYS } from "../../../shared/types.js";
import type { ExtractionQueue } from "../../extraction.js";
import type { AiService } from "../ai/service.js";
import type { ExtractionService } from "../extraction/service.js";
import { idParams, missing, type UserId } from "../routes.js";
import type { ArticleRepository } from "./repository.js";

const markReadAgeDays = z
  .number()
  .int()
  .refine(
    (value) => MARK_READ_AGE_DAYS.includes(value as MarkReadAgeDays),
    "Choose one of the available age thresholds",
  );

export async function articleRoutes(
  app: FastifyInstance,
  {
    articles,
    extractions,
    extractionQueue,
    ai,
    userId,
  }: {
    articles: ArticleRepository;
    extractions: ExtractionService;
    extractionQueue: ExtractionQueue;
    ai: AiService;
    userId: UserId;
  },
): Promise<void> {
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
    return articles.listArticlePage(userId(request), query);
  });

  app.get("/api/articles/:id", async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const article = articles.getArticle(userId(request), id);
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
    const article = articles.updateArticleState(userId(request), id, body);
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
    return { updated: articles.markArticlesRead(userId(request), body) };
  });

  app.post("/api/articles/:id/extract", async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const accountId = userId(request);
    if (!articles.getArticle(accountId, id)) return missing(reply, "Article");
    if (extractions.requestExtraction(accountId, id)) {
      extractionQueue.prioritize(id);
    }
    return articles.getArticle(accountId, id);
  });

  app.post("/api/articles/:id/summary", async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const { promptId, regenerate } = z
      .object({ promptId: z.uuid().nullable(), regenerate: z.boolean() })
      .parse(request.body ?? {});
    const summary = await ai.summarizeArticle(userId(request), id, promptId, regenerate);
    return summary ?? missing(reply, "Article");
  });

  app.post("/api/articles/:id/translation", async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const { sourceKind } = z
      .object({ sourceKind: z.enum(["full", "feed", "excerpt"]) })
      .parse(request.body) as { sourceKind: AiArticleSourceKind };
    const translation = await ai.translateArticle(userId(request), id, sourceKind);
    return translation ?? missing(reply, "Article");
  });
}

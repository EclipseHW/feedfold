import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { FeedRefreshService } from "../../refresh.js";
import type { FeedService } from "../feeds/service.js";
import type { UserId } from "../routes.js";

export async function refreshRoutes(
  app: FastifyInstance,
  {
    feeds,
    refreshService,
    userId,
  }: { feeds: FeedService; refreshService: FeedRefreshService; userId: UserId },
): Promise<void> {
  app.post("/api/refresh", async (request) => {
    const body = z
      .object({ feedIds: z.array(z.number().int().positive()).max(1_000).optional() })
      .parse(request.body ?? {});
    const feedIds = feeds.getUserRefreshFeedIds(userId(request), body.feedIds);
    return refreshService.request(feedIds);
  });
}

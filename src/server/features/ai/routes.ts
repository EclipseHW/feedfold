import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AiFeature, AiProvider } from "../../../shared/types.js";
import type { UserId } from "../routes.js";
import type { AiService } from "./service.js";

const aiFeatureParams = z.object({ feature: z.literal("article_summary") });
const aiProviderParams = z.object({ provider: z.enum(["gemini", "openai", "anthropic"]) });

export async function aiRoutes(
  app: FastifyInstance,
  { ai, userId }: { ai: AiService; userId: UserId },
): Promise<void> {
  app.get("/api/ai/settings", async (request) => ai.getSettings(userId(request)));

  app.patch("/api/ai/features/:feature", async (request) => {
    const { feature } = aiFeatureParams.parse(request.params) as { feature: AiFeature };
    const body = z
      .object({
        provider: z.enum(["gemini", "openai", "anthropic"]),
        model: z.string().trim().min(1).max(200).optional(),
      })
      .parse(request.body) as { provider: AiProvider; model?: string };
    return ai.setFeatureSetting(userId(request), feature, body.provider, body.model);
  });

  app.put("/api/ai/providers/:provider/key", async (request) => {
    const { provider } = aiProviderParams.parse(request.params) as { provider: AiProvider };
    const { apiKey } = z
      .object({ apiKey: z.string().trim().min(1).max(10_000) })
      .parse(request.body);
    return ai.setApiKey(userId(request), provider, apiKey);
  });

  app.delete("/api/ai/providers/:provider/key", async (request) => {
    const { provider } = aiProviderParams.parse(request.params) as { provider: AiProvider };
    return ai.deleteApiKey(userId(request), provider);
  });
}

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AI_PROMPT_MAX_LENGTH } from "../../../shared/ai-prompts.js";
import {
  DUPLICATE_ARTICLE_WINDOW_DAYS,
  type DuplicateArticleWindowDays,
} from "../../../shared/types.js";
import type { UserId } from "../routes.js";
import type { SettingsService } from "./service.js";

const duplicateArticleWindowDays = z.custom<DuplicateArticleWindowDays>(
  (value) =>
    typeof value === "number" &&
    DUPLICATE_ARTICLE_WINDOW_DAYS.includes(value as DuplicateArticleWindowDays),
  "Choose 1, 7, or 30 days",
);

export async function settingsRoutes(
  app: FastifyInstance,
  { settings, userId }: { settings: SettingsService; userId: UserId },
): Promise<void> {
  app.get("/api/settings", async (request) => settings.getSettings(userId(request)));

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
    return settings.updateSettings(userId(request), body);
  });
}

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { idParams, missing, nullableId, type UserId } from "../routes.js";
import type { RuleRepository } from "./repository.js";

export async function ruleRoutes(
  app: FastifyInstance,
  { rules, userId }: { rules: RuleRepository; userId: UserId },
): Promise<void> {
  app.get("/api/rules", async (request) => ({
    rules: rules.listRules(userId(request)),
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
    rules.createRule(userId(request), ruleBody.parse(request.body)),
  );

  app.patch("/api/rules/:id", async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const accountId = userId(request);
    const existing = rules.getRule(accountId, id);
    if (!existing) return missing(reply, "Rule");
    const body = ruleFields.partial().parse(request.body);
    if (
      (body.feedId === undefined ? existing.feedId : body.feedId) &&
      (body.folderId === undefined ? existing.folderId : body.folderId)
    ) {
      return reply.code(400).send({ error: "A rule can target a feed or a folder, not both" });
    }
    return rules.updateRule(accountId, id, body);
  });

  app.delete("/api/rules/:id", async (request, reply) => {
    const { id } = idParams.parse(request.params);
    if (!rules.deleteRule(userId(request), id)) return missing(reply, "Rule");
    return reply.code(204).send();
  });
}

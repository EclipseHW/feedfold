import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

export type UserId = (request: FastifyRequest) => number;

export const idParams = z.object({ id: z.coerce.number().int().positive() });
export const nullableId = z.number().int().positive().nullable();
export const httpUrl = z
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

export function missing(reply: FastifyReply, resource: string): FastifyReply {
  return reply.code(404).send({ error: `${resource} not found` });
}

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { idParams, missing, nullableId, type UserId } from "../routes.js";
import type { FolderService } from "./service.js";

export async function folderRoutes(
  app: FastifyInstance,
  { folders, userId }: { folders: FolderService; userId: UserId },
): Promise<void> {
  app.get("/api/folders", async (request) => ({
    folders: folders.listFolders(userId(request)),
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
    return folders.createFolder(userId(request), body);
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
    const folder = folders.updateFolder(userId(request), id, body);
    return folder ?? missing(reply, "Folder");
  });

  app.delete("/api/folders/:id", async (request, reply) => {
    const { id } = idParams.parse(request.params);
    if (!folders.deleteFolder(userId(request), id)) return missing(reply, "Folder");
    return reply.code(204).send();
  });
}

import type Sqlite from "better-sqlite3";
import type { Folder, FolderSortDirection } from "../../../shared/types.js";
import type { RuleRepository } from "../rules/repository.js";
import type { FolderRepository } from "./repository.js";

export class FolderService {
  constructor(
    private readonly sqlite: Sqlite.Database,
    private readonly repository: FolderRepository,
    private readonly rules: RuleRepository,
  ) {}

  listFolders(userId: number): Folder[] {
    return this.repository.listFolders(userId);
  }

  getFolder(userId: number, id: number): Folder | null {
    return this.repository.getFolder(userId, id);
  }

  createFolder(
    userId: number,
    input: {
      name: string;
      parentId?: number | null;
      position?: number;
      sortDirection?: FolderSortDirection;
    },
  ): Folder {
    return this.repository.createFolder(userId, input);
  }

  updateFolder(
    userId: number,
    id: number,
    input: {
      name?: string;
      parentId?: number | null;
      position?: number;
      sortDirection?: FolderSortDirection;
    },
  ): Folder | null {
    const existing = this.repository.getFolder(userId, id);
    if (!existing) return null;
    return this.sqlite.transaction(() => {
      const updated = this.repository.updateFolder(userId, id, input);
      if (updated && input.parentId !== undefined && input.parentId !== existing.parentId) {
        this.rules.recomputeRulesForAllArticles(userId);
      }
      return updated;
    })();
  }

  deleteFolder(userId: number, id: number): boolean {
    return this.sqlite.transaction(() => {
      const deleted = this.repository.deleteFolder(userId, id);
      if (deleted) this.rules.recomputeRulesForAllArticles(userId);
      return deleted;
    })();
  }

  listOpmlFolders(userId: number): Array<{ id: number; name: string; parentId: number | null }> {
    return this.repository.listOpmlFolders(userId);
  }
}

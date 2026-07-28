import type Sqlite from "better-sqlite3";
import type { RuleRepository } from "../rules/repository.js";
import type { ExtractionRecord } from "../shared.js";
import type { ExtractionRepository } from "./repository.js";

export class ExtractionService {
  constructor(
    private readonly sqlite: Sqlite.Database,
    private readonly repository: ExtractionRepository,
    private readonly rules: RuleRepository,
  ) {}

  getPendingExtractions(limit = 100): ExtractionRecord[] {
    return this.repository.getPendingExtractions(limit);
  }

  getExtractionRecord(id: number): ExtractionRecord | null {
    return this.repository.getExtractionRecord(id);
  }

  markExtractionProcessing(id: number): boolean {
    return this.repository.markExtractionProcessing(id);
  }

  requestExtraction(userId: number, id: number): boolean {
    return this.repository.requestExtraction(userId, id);
  }

  completeExtraction(
    id: number,
    input: {
      contentHtml: string | null;
      imageUrl: string | null;
      contentSource: "article" | null;
      status: "complete" | "failed";
      error: string | null;
    },
  ): void {
    this.sqlite.transaction(() => {
      if (this.repository.completeExtraction(id, input)) {
        this.rules.recomputeRulesForArticle(id);
      }
    })();
  }
}

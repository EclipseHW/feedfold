import type Sqlite from "better-sqlite3";
import { cleanArticleHtml } from "../../article-html.js";
import type { ArticleRepository } from "../articles/repository.js";
import type { RuleRepository } from "../rules/repository.js";
import type { ParsedFeed } from "../shared.js";
import type { FeedRepository } from "./repository.js";

const INITIAL_ARTICLE_LIMIT = 10;

export interface SuccessfulFeedRefresh {
  httpStatus: number;
  etag: string | null;
  lastModified: string | null;
  pollIntervalMinutes: number;
  parsed?: ParsedFeed;
  webMatchCount?: number;
  expectedSelectionRevision?: number;
}

export class FeedIngestionService {
  constructor(
    private readonly sqlite: Sqlite.Database,
    private readonly feeds: FeedRepository,
    private readonly articles: ArticleRepository,
    private readonly rules: RuleRepository,
  ) {}

  completeRefresh(feedId: number, input: SuccessfulFeedRefresh): boolean {
    const parsed = input.parsed
      ? {
          ...input.parsed,
          articles: input.parsed.articles.map((article) => ({
            ...article,
            feedContentHtml: article.feedContentHtml
              ? cleanArticleHtml(
                  article.feedContentHtml,
                  article.url ?? input.parsed?.siteUrl ?? undefined,
                )
              : null,
          })),
        }
      : undefined;

    return this.sqlite.transaction(() => {
      if (
        input.expectedSelectionRevision !== undefined &&
        !this.feeds.selectionRevisionMatches(feedId, input.expectedSelectionRevision)
      ) {
        return false;
      }

      const changedArticleIds = new Set<number>();
      if (parsed) {
        this.feeds.updateFromParsedFeed(feedId, parsed);
        const initialArticleLimit = this.feeds.isInitialRefresh(feedId)
          ? INITIAL_ARTICLE_LIMIT
          : undefined;
        for (const articleId of this.articles.storeParsedFeedArticles(
          feedId,
          parsed,
          initialArticleLimit,
        )) {
          changedArticleIds.add(articleId);
        }
      }
      this.feeds.completeSuccessfulRefresh(feedId, input);
      this.rules.recomputeRulesForArticles(changedArticleIds);
      return true;
    })();
  }
}

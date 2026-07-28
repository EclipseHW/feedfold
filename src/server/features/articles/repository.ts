import type Sqlite from "better-sqlite3";
import type {
  Article,
  ArticlePage,
  ArticleQuery,
  FeedSourceKind,
  FolderSortDirection,
  MarkReadRequest,
} from "../../../shared/types.js";
import {
  type ArticleCursor,
  decodeArticleCursor,
  encodeArticleCursor,
  mapArticle,
  now,
  type ParsedFeed,
  type Row,
  visibleClause,
} from "../shared.js";

export class ArticleRepository {
  constructor(private readonly sqlite: Sqlite.Database) {}

  getCounts(userId: number): { unread: number; starred: number; all: number } {
    const counts = this.sqlite
      .prepare(
        `SELECT
           SUM(CASE WHEN is_read = 0 AND ${visibleClause} THEN 1 ELSE 0 END) AS unread,
           SUM(CASE WHEN is_starred = 1 AND ${visibleClause} THEN 1 ELSE 0 END) AS starred,
           SUM(CASE WHEN ${visibleClause} THEN 1 ELSE 0 END) AS allCount
         FROM articles
         JOIN feeds ON feeds.id = articles.feed_id
         WHERE feeds.user_id = ?`,
      )
      .get(userId) as Row;
    return {
      unread: Number(counts.unread ?? 0),
      starred: Number(counts.starred ?? 0),
      all: Number(counts.allCount ?? 0),
    };
  }

  listArticles(userId: number, query: ArticleQuery): Article[] {
    return this.listArticlePage(userId, query).articles;
  }

  listArticlePage(userId: number, query: ArticleQuery): ArticlePage {
    const where = ["feeds.user_id = ?"];
    const values: Array<string | number> = [userId];
    if (query.feedId !== undefined) {
      where.push("articles.feed_id = ?");
      values.push(query.feedId);
    }
    if (query.folderId !== undefined) {
      where.push(
        `feeds.folder_id IN (
           WITH RECURSIVE folder_tree(id) AS (
             SELECT id FROM folders WHERE id = ? AND user_id = ?
             UNION ALL
             SELECT folders.id FROM folders JOIN folder_tree ON folders.parent_id = folder_tree.id
             WHERE folders.user_id = ?
           ) SELECT id FROM folder_tree
         )`,
      );
      values.push(query.folderId, userId, userId);
    }
    const queueWhere = [visibleClause];
    const queueValues: Array<string | number> = [];
    if (query.state === "unread") queueWhere.push("articles.is_read = 0");
    if (query.state === "read") queueWhere.push("articles.is_read = 1");
    if (query.state === "starred") queueWhere.push("articles.is_starred = 1");
    if (query.search) {
      queueWhere.push(
        `(articles.title LIKE ? ESCAPE '\\' COLLATE NOCASE
          OR COALESCE(articles.author, '') LIKE ? ESCAPE '\\' COLLATE NOCASE
          OR articles.summary LIKE ? ESCAPE '\\' COLLATE NOCASE)`,
      );
      const escaped = query.search.replace(/[\\%_]/g, "\\$&");
      queueValues.push(`%${escaped}%`, `%${escaped}%`, `%${escaped}%`);
    }
    if (query.anchorId === undefined) {
      where.push(...queueWhere);
      values.push(...queueValues);
    } else {
      where.push(`((${queueWhere.join(" AND ")}) OR articles.id = ?)`);
      values.push(...queueValues, query.anchorId);
    }
    const limit = Math.max(1, Math.min(query.limit ?? 200, 500));
    const anchor =
      query.anchorId !== undefined && !query.cursor
        ? this.articlePageAnchor(where, values, query.anchorId, Math.floor(limit / 2))
        : null;
    const cursor = query.cursor ? decodeArticleCursor(query.cursor) : (anchor?.cursor ?? new Map());
    const buckets = this.sqlite
      .prepare(
        `SELECT feeds.folder_id AS folderId,
                COALESCE(folders.sort_direction, 'newest') AS sortDirection
         FROM articles
         JOIN feeds ON feeds.id = articles.feed_id
         LEFT JOIN folders ON folders.id = feeds.folder_id
         WHERE ${where.join(" AND ")}
         GROUP BY feeds.folder_id, folders.sort_direction
         ORDER BY feeds.folder_id`,
      )
      .all(...values) as Array<{
      folderId: number | null;
      sortDirection: FolderSortDirection;
    }>;
    const queues = buckets.map((bucket) => {
      const key = bucket.folderId === null ? "top" : String(bucket.folderId);
      const boundary = cursor.get(key);
      const bucketWhere = [...where];
      const bucketValues = [...values];
      if (bucket.folderId === null) {
        bucketWhere.push("feeds.folder_id IS NULL");
      } else {
        bucketWhere.push("feeds.folder_id = ?");
        bucketValues.push(bucket.folderId);
      }
      if (boundary) {
        const comparison = bucket.sortDirection === "oldest" ? ">" : "<";
        bucketWhere.push(
          `(COALESCE(articles.published_at, articles.discovered_at) ${comparison} ?
            OR (COALESCE(articles.published_at, articles.discovered_at) = ?
              AND articles.id ${comparison} ?))`,
        );
        bucketValues.push(boundary.sortAt, boundary.sortAt, boundary.id);
      }
      bucketValues.push(limit + 1);
      const order = bucket.sortDirection === "oldest" ? "ASC" : "DESC";
      const rows = this.sqlite
        .prepare(
          `SELECT articles.id,
                articles.feed_id AS feedId,
                feeds.title AS feedTitle,
                feeds.source_kind AS feedSourceKind,
                feeds.folder_id AS folderId,
                articles.title,
                articles.url,
                articles.author,
                articles.published_at AS publishedAt,
                articles.discovered_at AS discoveredAt,
                articles.summary,
                articles.image_url AS imageUrl,
                articles.media_json AS mediaJson,
                ${query.includeContent ? "articles.feed_content_html" : "NULL"} AS feedContentHtml,
                ${query.includeContent ? "articles.content_html" : "NULL"} AS contentHtml,
                articles.content_source AS contentSource,
                articles.extraction_status AS extractionStatus,
                articles.extraction_error AS extractionError,
                ${query.includeContent ? "article_ai_summaries.summary_text" : "NULL"} AS aiSummaryText,
                ${query.includeContent ? "article_ai_summaries.prompt_id" : "NULL"} AS aiSummaryPromptId,
                ${query.includeContent ? "article_ai_summaries.provider" : "NULL"} AS aiSummaryProvider,
                ${query.includeContent ? "article_ai_summaries.model" : "NULL"} AS aiSummaryModel,
                ${query.includeContent ? "article_ai_summaries.source_kind" : "NULL"} AS aiSummarySourceKind,
                ${query.includeContent ? "article_ai_summaries.generated_at" : "NULL"} AS aiSummaryGeneratedAt,
                ${query.includeContent ? "article_ai_summaries.input_tokens" : "NULL"} AS aiSummaryInputTokens,
                ${query.includeContent ? "article_ai_summaries.output_tokens" : "NULL"} AS aiSummaryOutputTokens,
                articles.is_read AS isRead,
                articles.is_starred AS isStarred,
                COALESCE(articles.published_at, articles.discovered_at) AS sortAt
           FROM articles
           JOIN feeds ON feeds.id = articles.feed_id
           LEFT JOIN article_ai_summaries
             ON article_ai_summaries.article_id = articles.id
            AND article_ai_summaries.source_revision = articles.content_revision
           WHERE ${bucketWhere.join(" AND ")}
           ORDER BY COALESCE(articles.published_at, articles.discovered_at) ${order},
                    articles.id ${order}
           LIMIT ?`,
        )
        .all(...bucketValues) as Row[];
      return {
        key,
        rows,
        index: 0,
        consumed: boundary?.consumed ?? 0,
      };
    });
    const nextBoundaries: ArticleCursor = new Map(
      [...cursor].map(([key, boundary]) => [key, { ...boundary }]),
    );
    const pageRows: Row[] = [];
    while (pageRows.length < limit) {
      const available = queues.filter((queue) => queue.index < queue.rows.length);
      if (available.length === 0) break;
      const selected = available.reduce((preferred, candidate) => {
        if (candidate.consumed !== preferred.consumed) {
          return candidate.consumed < preferred.consumed ? candidate : preferred;
        }
        const candidateRow = candidate.rows[candidate.index];
        const preferredRow = preferred.rows[preferred.index];
        const dateComparison = String(candidateRow.sortAt).localeCompare(
          String(preferredRow.sortAt),
        );
        if (dateComparison !== 0) return dateComparison > 0 ? candidate : preferred;
        return Number(candidateRow.id) > Number(preferredRow.id) ? candidate : preferred;
      });
      const row = selected.rows[selected.index];
      selected.index += 1;
      selected.consumed += 1;
      pageRows.push(row);
      nextBoundaries.set(selected.key, {
        sortAt: String(row.sortAt),
        id: Number(row.id),
        consumed: selected.consumed,
      });
    }
    const hasMore = queues.some((queue) => queue.index < queue.rows.length);
    return {
      articles: pageRows.map(mapArticle),
      nextCursor: hasMore ? encodeArticleCursor(nextBoundaries) : null,
      anchorIndex: anchor?.index ?? null,
    };
  }

  private articlePageAnchor(
    where: string[],
    values: Array<string | number>,
    anchorId: number,
    precedingArticles: number,
  ): { cursor: ArticleCursor; index: number } | null {
    const rows = this.sqlite
      .prepare(
        `WITH filtered_articles AS (
           SELECT articles.id,
                  CASE
                    WHEN feeds.folder_id IS NULL THEN 'top'
                    ELSE CAST(feeds.folder_id AS TEXT)
                  END AS bucketKey,
                  COALESCE(folders.sort_direction, 'newest') AS sortDirection,
                  COALESCE(articles.published_at, articles.discovered_at) AS sortAt
           FROM articles
           JOIN feeds ON feeds.id = articles.feed_id
           LEFT JOIN folders ON folders.id = feeds.folder_id
           WHERE ${where.join(" AND ")}
         ),
         bucket_ranked AS (
           SELECT *,
                  ROW_NUMBER() OVER (
                    PARTITION BY bucketKey
                    ORDER BY
                      CASE WHEN sortDirection = 'oldest' THEN sortAt END ASC,
                      CASE WHEN sortDirection = 'newest' THEN sortAt END DESC,
                      CASE WHEN sortDirection = 'oldest' THEN id END ASC,
                      CASE WHEN sortDirection = 'newest' THEN id END DESC
                  ) - 1 AS bucketIndex
           FROM filtered_articles
         ),
         ordered_articles AS (
           SELECT *,
                  ROW_NUMBER() OVER (
                    ORDER BY bucketIndex ASC, sortAt DESC, id DESC
                  ) - 1 AS queueIndex
           FROM bucket_ranked
         ),
         anchor AS (
           SELECT queueIndex
           FROM ordered_articles
           WHERE id = ?
         ),
         window_start AS (
           SELECT queueIndex, MAX(0, queueIndex - ?) AS startIndex
           FROM anchor
         ),
         ranked_boundaries AS (
           SELECT ordered_articles.bucketKey,
                  ordered_articles.sortAt,
                  ordered_articles.id,
                  ordered_articles.bucketIndex,
                  ROW_NUMBER() OVER (
                    PARTITION BY ordered_articles.bucketKey
                    ORDER BY ordered_articles.bucketIndex DESC
                  ) AS boundaryRank
           FROM ordered_articles
           JOIN window_start ON ordered_articles.queueIndex < window_start.startIndex
         )
         SELECT 'anchor' AS kind,
                queueIndex,
                startIndex,
                NULL AS bucketKey,
                NULL AS sortAt,
                NULL AS id,
                NULL AS consumed
         FROM window_start
         UNION ALL
         SELECT 'boundary' AS kind,
                NULL AS queueIndex,
                NULL AS startIndex,
                bucketKey,
                sortAt,
                id,
                bucketIndex + 1 AS consumed
         FROM ranked_boundaries
         WHERE boundaryRank = 1`,
      )
      .all(...values, anchorId, precedingArticles) as Array<{
      kind: "anchor" | "boundary";
      queueIndex: number | null;
      startIndex: number | null;
      bucketKey: string | null;
      sortAt: string | null;
      id: number | null;
      consumed: number | null;
    }>;
    const anchor = rows.find((row) => row.kind === "anchor");
    if (!anchor || anchor.queueIndex === null || anchor.startIndex === null) return null;

    const cursor: ArticleCursor = new Map();
    for (const row of rows) {
      if (
        row.kind === "boundary" &&
        row.bucketKey !== null &&
        row.sortAt !== null &&
        row.id !== null &&
        row.consumed !== null
      ) {
        cursor.set(row.bucketKey, {
          sortAt: row.sortAt,
          id: row.id,
          consumed: row.consumed,
        });
      }
    }
    return { cursor, index: anchor.queueIndex - anchor.startIndex };
  }

  getArticle(userId: number, id: number): Article | null {
    const row = this.sqlite
      .prepare(
        `SELECT articles.id,
                articles.feed_id AS feedId,
                feeds.title AS feedTitle,
                feeds.source_kind AS feedSourceKind,
                feeds.folder_id AS folderId,
                articles.title,
                articles.url,
                articles.author,
                articles.published_at AS publishedAt,
                articles.discovered_at AS discoveredAt,
                articles.summary,
                articles.image_url AS imageUrl,
                articles.media_json AS mediaJson,
                articles.feed_content_html AS feedContentHtml,
                articles.content_html AS contentHtml,
                articles.content_source AS contentSource,
                articles.extraction_status AS extractionStatus,
                articles.extraction_error AS extractionError,
                article_ai_summaries.summary_text AS aiSummaryText,
                article_ai_summaries.prompt_id AS aiSummaryPromptId,
                article_ai_summaries.provider AS aiSummaryProvider,
                article_ai_summaries.model AS aiSummaryModel,
                article_ai_summaries.source_kind AS aiSummarySourceKind,
                article_ai_summaries.generated_at AS aiSummaryGeneratedAt,
                article_ai_summaries.input_tokens AS aiSummaryInputTokens,
                article_ai_summaries.output_tokens AS aiSummaryOutputTokens,
                articles.is_read AS isRead,
                articles.is_starred AS isStarred
         FROM articles
         JOIN feeds ON feeds.id = articles.feed_id
         LEFT JOIN article_ai_summaries
           ON article_ai_summaries.article_id = articles.id
          AND article_ai_summaries.source_revision = articles.content_revision
         WHERE articles.id = ? AND feeds.user_id = ?`,
      )
      .get(id, userId) as Row | undefined;
    return row ? mapArticle(row) : null;
  }

  updateArticleState(
    userId: number,
    id: number,
    input: { isRead?: boolean; isStarred?: boolean },
  ): Article | null {
    const existing = this.getArticle(userId, id);
    if (!existing) return null;
    this.sqlite
      .prepare("UPDATE articles SET is_read = ?, is_starred = ? WHERE id = ?")
      .run(
        (input.isRead ?? existing.isRead) ? 1 : 0,
        (input.isStarred ?? existing.isStarred) ? 1 : 0,
        id,
      );
    return this.getArticle(userId, id);
  }

  markArticlesRead(userId: number, input: MarkReadRequest): number {
    if (input.articleIds?.length === 0) return 0;

    const articleWhere = ["articles.is_read = 0"];
    const feedWhere = ["feeds.id = articles.feed_id", "feeds.user_id = ?"];
    const articleValues: Array<number | string> = [];
    const feedValues: Array<number | string> = [userId];

    if (input.articleIds) {
      articleWhere.push(`articles.id IN (${input.articleIds.map(() => "?").join(", ")})`);
      articleValues.push(...input.articleIds);
    }
    if (input.feedId !== undefined) {
      feedWhere.push("feeds.id = ?");
      feedValues.push(input.feedId);
    }
    if (input.folderId !== undefined) {
      feedWhere.push(
        `feeds.folder_id IN (
           WITH RECURSIVE folder_tree(id) AS (
             SELECT id FROM folders WHERE id = ? AND user_id = ?
             UNION ALL
             SELECT folders.id FROM folders JOIN folder_tree ON folders.parent_id = folder_tree.id
             WHERE folders.user_id = ?
           ) SELECT id FROM folder_tree
         )`,
      );
      feedValues.push(input.folderId, userId, userId);
    }
    if (input.olderThanDays !== undefined) {
      const cutoff = new Date(Date.now() - input.olderThanDays * 86_400_000).toISOString();
      articleWhere.push("COALESCE(articles.published_at, articles.discovered_at) < ?");
      articleValues.push(cutoff);
    }

    return this.sqlite
      .prepare(
        `UPDATE articles SET is_read = 1
         WHERE ${articleWhere.join(" AND ")}
           AND EXISTS (
             SELECT 1 FROM feeds
             WHERE ${feedWhere.join(" AND ")}
           )`,
      )
      .run(...articleValues, ...feedValues).changes;
  }

  storeParsedFeedArticles(id: number, parsed: ParsedFeed): Set<number> {
    const ruleArticleIds = new Set<number>();
    const findExisting = this.sqlite.prepare(
      `SELECT id, title, url, author, published_at AS publishedAt, summary,
                  image_url AS imageUrl, media_json AS mediaJson,
                  feed_content_html AS feedContentHtml, extraction_status AS extractionStatus
           FROM articles WHERE feed_id = ? AND external_id = ?`,
    );
    const insert = this.sqlite.prepare(
      `INSERT INTO articles (
             feed_id, external_id, title, url, author, published_at, discovered_at,
             summary, image_url, media_json, feed_content_html, extraction_status
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const duplicateSettings = this.sqlite
      .prepare(
        `SELECT feeds.user_id AS userId,
                    feeds.source_kind AS sourceKind,
                    settings.duplicate_article_window_days AS windowDays
             FROM feeds
             JOIN settings ON settings.user_id = feeds.user_id
             WHERE feeds.id = ?`,
      )
      .get(id) as { userId: number; sourceKind: FeedSourceKind; windowDays: number };
    const duplicateCutoff = new Date(
      Date.now() - duplicateSettings.windowDays * 24 * 60 * 60 * 1_000,
    ).toISOString();
    const findDuplicate = this.sqlite.prepare(
      duplicateSettings.sourceKind === "web"
        ? `SELECT 1
               FROM articles
               JOIN feeds ON feeds.id = articles.feed_id
               WHERE feeds.user_id = ?
                 AND articles.discovered_at >= ?
                 AND ? IS NOT NULL
                 AND articles.url = ?
               LIMIT 1`
        : `SELECT 1
               FROM articles
               JOIN feeds ON feeds.id = articles.feed_id
               WHERE feeds.user_id = ?
                 AND articles.discovered_at >= ?
                 AND ((? IS NOT NULL AND articles.url = ?) OR (? <> '' AND articles.title = ?))
               LIMIT 1`,
    );
    const update = this.sqlite.prepare(
      `UPDATE articles
           SET title = ?, url = ?, author = ?, published_at = ?, summary = ?,
               image_url = CASE WHEN ? = 1 THEN ? ELSE image_url END,
               media_json = ?,
               feed_content_html = ?,
               content_html = CASE WHEN ? = 1 THEN NULL ELSE content_html END,
               content_source = CASE WHEN ? = 1 THEN NULL ELSE content_source END,
               extraction_status = CASE WHEN ? = 1 THEN ? ELSE extraction_status END,
               extraction_error = CASE WHEN ? = 1 THEN NULL ELSE extraction_error END,
               content_revision = content_revision + ?
           WHERE id = ?`,
    );
    for (const article of parsed.articles) {
      const media = article.media ?? null;
      const mediaJson = media ? JSON.stringify(media) : null;
      const extractionStatus = "feed";
      const existing = findExisting.get(id, article.externalId) as Row | undefined;
      if (existing) {
        const publishedAt =
          duplicateSettings.sourceKind === "web" && article.publishedAt === null
            ? existing.publishedAt
            : article.publishedAt;
        const sourceChanged =
          existing.url !== article.url || existing.feedContentHtml !== article.feedContentHtml;
        const statusChanged = media !== null && existing.extractionStatus !== "feed";
        const replaceImage = sourceChanged || media !== null;
        const resetExtraction = sourceChanged || statusChanged;
        const aiSourceChanged =
          resetExtraction ||
          existing.title !== article.title ||
          existing.url !== article.url ||
          existing.author !== article.author ||
          existing.summary !== article.summary ||
          existing.feedContentHtml !== article.feedContentHtml;
        const changed =
          sourceChanged ||
          statusChanged ||
          existing.title !== article.title ||
          existing.author !== article.author ||
          existing.publishedAt !== publishedAt ||
          existing.summary !== article.summary ||
          existing.mediaJson !== mediaJson ||
          (media !== null && existing.imageUrl !== article.imageUrl);
        if (!changed) continue;
        const articleId = Number(existing.id);
        update.run(
          article.title,
          article.url,
          article.author,
          publishedAt,
          article.summary,
          replaceImage ? 1 : 0,
          article.imageUrl,
          mediaJson,
          article.feedContentHtml,
          resetExtraction ? 1 : 0,
          resetExtraction ? 1 : 0,
          resetExtraction ? 1 : 0,
          extractionStatus,
          resetExtraction ? 1 : 0,
          aiSourceChanged ? 1 : 0,
          articleId,
        );
        ruleArticleIds.add(articleId);
        continue;
      }
      const duplicate =
        duplicateSettings.sourceKind === "web"
          ? findDuplicate.get(duplicateSettings.userId, duplicateCutoff, article.url, article.url)
          : findDuplicate.get(
              duplicateSettings.userId,
              duplicateCutoff,
              article.url,
              article.url,
              article.title,
              article.title,
            );
      if (duplicate) {
        continue;
      }
      const discoveredAt = now();
      const result = insert.run(
        id,
        article.externalId,
        article.title,
        article.url,
        article.author,
        duplicateSettings.sourceKind === "web"
          ? (article.publishedAt ?? discoveredAt)
          : article.publishedAt,
        discoveredAt,
        article.summary,
        article.imageUrl,
        mediaJson,
        article.feedContentHtml,
        extractionStatus,
      );
      const articleId = Number(result.lastInsertRowid);
      ruleArticleIds.add(articleId);
    }

    return ruleArticleIds;
  }

  listFeedArticleIds(feedId: number): number[] {
    return (
      this.sqlite.prepare("SELECT id FROM articles WHERE feed_id = ?").all(feedId) as Array<{
        id: number;
      }>
    ).map((article) => article.id);
  }
}

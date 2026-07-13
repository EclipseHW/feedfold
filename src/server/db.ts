import Sqlite from "better-sqlite3";
import type {
  AppSettings,
  Article,
  ArticlePage,
  ArticleQuery,
  BootstrapData,
  Feed,
  Folder,
  Rule,
  RuleAction,
  RuleField,
} from "../shared/types.js";

export interface FeedRecord {
  id: number;
  folderId: number | null;
  title: string;
  feedUrl: string;
  siteUrl: string | null;
  paused: boolean;
  etag: string | null;
  lastModified: string | null;
}

export interface ParsedArticle {
  externalId: string;
  title: string;
  url: string | null;
  author: string | null;
  publishedAt: string | null;
  summary: string;
  feedContentHtml: string | null;
}

export interface ParsedFeed {
  title: string;
  siteUrl: string | null;
  articles: ParsedArticle[];
}

export interface ExtractionRecord {
  id: number;
  url: string | null;
  feedContentHtml: string | null;
}

type Row = Record<string, unknown>;

const migrations = [
  `
    CREATE TABLE folders (
      id INTEGER PRIMARY KEY,
      parent_id INTEGER REFERENCES folders(id) ON DELETE SET NULL,
      name TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE feeds (
      id INTEGER PRIMARY KEY,
      folder_id INTEGER REFERENCES folders(id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      feed_url TEXT NOT NULL UNIQUE,
      site_url TEXT,
      paused INTEGER NOT NULL DEFAULT 0,
      refreshing INTEGER NOT NULL DEFAULT 0,
      etag TEXT,
      last_modified TEXT,
      last_attempt_at TEXT,
      last_success_at TEXT,
      last_http_status INTEGER,
      last_error TEXT,
      next_poll_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE articles (
      id INTEGER PRIMARY KEY,
      feed_id INTEGER NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
      external_id TEXT NOT NULL,
      title TEXT NOT NULL,
      url TEXT,
      author TEXT,
      published_at TEXT,
      discovered_at TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      feed_content_html TEXT,
      content_html TEXT,
      content_source TEXT CHECK(content_source IN ('article', 'feed')),
      extraction_status TEXT NOT NULL DEFAULT 'pending'
        CHECK(extraction_status IN ('pending', 'processing', 'complete', 'failed', 'feed')),
      extraction_error TEXT,
      is_read INTEGER NOT NULL DEFAULT 0,
      is_starred INTEGER NOT NULL DEFAULT 0,
      UNIQUE(feed_id, external_id)
    );

    CREATE TABLE rules (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      feed_id INTEGER REFERENCES feeds(id) ON DELETE CASCADE,
      folder_id INTEGER REFERENCES folders(id) ON DELETE CASCADE,
      field TEXT NOT NULL CHECK(field IN ('title', 'author', 'summary', 'content', 'any')),
      pattern TEXT NOT NULL,
      action TEXT NOT NULL CHECK(action IN ('hide', 'mark_read')),
      enabled INTEGER NOT NULL DEFAULT 1,
      matched_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE article_rule_matches (
      article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
      rule_id INTEGER NOT NULL REFERENCES rules(id) ON DELETE CASCADE,
      PRIMARY KEY(article_id, rule_id)
    );

    CREATE TABLE settings (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      poll_interval_minutes INTEGER NOT NULL,
      single_key_shortcuts INTEGER NOT NULL
    );

    CREATE INDEX articles_feed_id_idx ON articles(feed_id);
    CREATE INDEX articles_read_idx ON articles(is_read);
    CREATE INDEX articles_starred_idx ON articles(is_starred);
    CREATE INDEX articles_published_idx ON articles(published_at DESC);
    CREATE INDEX feeds_folder_id_idx ON feeds(folder_id);
    CREATE INDEX rules_feed_id_idx ON rules(feed_id);
    CREATE INDEX rules_folder_id_idx ON rules(folder_id);
    INSERT INTO settings (id, poll_interval_minutes, single_key_shortcuts) VALUES (1, 20, 1);
  `,
];

function now(): string {
  return new Date().toISOString();
}

function decodeArticleCursor(cursor: string): { sortAt: string; id: number } {
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (
      !Array.isArray(value) ||
      value.length !== 2 ||
      typeof value[0] !== "string" ||
      typeof value[1] !== "number" ||
      !Number.isInteger(value[1])
    ) {
      throw new Error("Invalid cursor fields");
    }
    return { sortAt: value[0], id: value[1] };
  } catch {
    throw new Error("Invalid article cursor");
  }
}

function encodeArticleCursor(sortAt: string, id: number): string {
  return Buffer.from(JSON.stringify([sortAt, id])).toString("base64url");
}

function toBoolean(value: unknown): boolean {
  return value === 1;
}

function mapFolder(row: Row): Folder {
  return {
    id: Number(row.id),
    parentId: row.parentId === null ? null : Number(row.parentId),
    name: String(row.name),
    position: Number(row.position),
    unreadCount: Number(row.unreadCount),
  };
}

function mapFeed(row: Row): Feed {
  return {
    id: Number(row.id),
    folderId: row.folderId === null ? null : Number(row.folderId),
    title: String(row.title),
    feedUrl: String(row.feedUrl),
    siteUrl: row.siteUrl === null ? null : String(row.siteUrl),
    unreadCount: Number(row.unreadCount),
    totalCount: Number(row.totalCount),
    paused: toBoolean(row.paused),
    refreshing: toBoolean(row.refreshing),
    lastAttemptAt: row.lastAttemptAt === null ? null : String(row.lastAttemptAt),
    lastSuccessAt: row.lastSuccessAt === null ? null : String(row.lastSuccessAt),
    lastHttpStatus: row.lastHttpStatus === null ? null : Number(row.lastHttpStatus),
    lastError: row.lastError === null ? null : String(row.lastError),
    nextPollAt: row.nextPollAt === null ? null : String(row.nextPollAt),
  };
}

function mapArticle(row: Row): Article {
  return {
    id: Number(row.id),
    feedId: Number(row.feedId),
    feedTitle: String(row.feedTitle),
    folderId: row.folderId === null ? null : Number(row.folderId),
    title: String(row.title),
    url: row.url === null ? null : String(row.url),
    author: row.author === null ? null : String(row.author),
    publishedAt: row.publishedAt === null ? null : String(row.publishedAt),
    discoveredAt: String(row.discoveredAt),
    summary: String(row.summary),
    contentHtml: row.contentHtml === null ? null : String(row.contentHtml),
    contentSource:
      row.contentSource === "article" || row.contentSource === "feed" ? row.contentSource : null,
    extractionStatus: row.extractionStatus as Article["extractionStatus"],
    extractionError: row.extractionError === null ? null : String(row.extractionError),
    isRead: toBoolean(row.isRead),
    isStarred: toBoolean(row.isStarred),
  };
}

function mapRule(row: Row): Rule {
  return {
    id: Number(row.id),
    name: String(row.name),
    feedId: row.feedId === null ? null : Number(row.feedId),
    folderId: row.folderId === null ? null : Number(row.folderId),
    field: row.field as RuleField,
    pattern: String(row.pattern),
    action: row.action as RuleAction,
    enabled: toBoolean(row.enabled),
    matchedCount: Number(row.matchedCount),
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
  };
}

const hiddenClause = `NOT EXISTS (
  SELECT 1
  FROM article_rule_matches arm
  JOIN rules hidden_rule ON hidden_rule.id = arm.rule_id
  WHERE arm.article_id = articles.id
    AND hidden_rule.enabled = 1
    AND hidden_rule.action = 'hide'
)`;

export class AppDatabase {
  readonly sqlite: Sqlite.Database;

  constructor(path: string, defaultPollIntervalMinutes = 20) {
    this.sqlite = new Sqlite(path);
    this.sqlite.pragma("foreign_keys = ON");
    this.sqlite.pragma("journal_mode = WAL");
    const isNewDatabase =
      this.sqlite
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'settings'")
        .get() === undefined;
    this.migrate();
    if (isNewDatabase && defaultPollIntervalMinutes !== 20) {
      this.updateSettings({ pollIntervalMinutes: defaultPollIntervalMinutes });
    }
    this.sqlite.prepare("UPDATE feeds SET refreshing = 0 WHERE refreshing = 1").run();
    this.sqlite
      .prepare(
        "UPDATE articles SET extraction_status = 'pending' WHERE extraction_status = 'processing'",
      )
      .run();
  }

  private migrate(): void {
    this.sqlite.exec(
      "CREATE TABLE IF NOT EXISTS migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
    );
    const current = this.sqlite
      .prepare("SELECT COALESCE(MAX(version), 0) AS version FROM migrations")
      .get() as { version: number };
    for (let index = current.version; index < migrations.length; index += 1) {
      const apply = this.sqlite.transaction(() => {
        this.sqlite.exec(migrations[index]);
        this.sqlite
          .prepare("INSERT INTO migrations (version, applied_at) VALUES (?, ?)")
          .run(index + 1, now());
      });
      apply();
    }
  }

  close(): void {
    this.sqlite.close();
  }

  getSettings(): AppSettings {
    const row = this.sqlite
      .prepare(
        `SELECT poll_interval_minutes AS pollIntervalMinutes,
                single_key_shortcuts AS singleKeyShortcuts
         FROM settings WHERE id = 1`,
      )
      .get() as Row;
    return {
      pollIntervalMinutes: Number(row.pollIntervalMinutes),
      singleKeyShortcuts: toBoolean(row.singleKeyShortcuts),
    };
  }

  updateSettings(input: Partial<AppSettings>): AppSettings {
    const current = this.getSettings();
    this.sqlite
      .prepare(
        `UPDATE settings
         SET poll_interval_minutes = ?, single_key_shortcuts = ?
         WHERE id = 1`,
      )
      .run(
        input.pollIntervalMinutes ?? current.pollIntervalMinutes,
        (input.singleKeyShortcuts ?? current.singleKeyShortcuts) ? 1 : 0,
      );
    return this.getSettings();
  }

  listFolders(): Folder[] {
    const rows = this.sqlite
      .prepare(
        `WITH RECURSIVE descendants(root_id, id) AS (
           SELECT id, id FROM folders
           UNION ALL
           SELECT descendants.root_id, folders.id
           FROM folders JOIN descendants ON folders.parent_id = descendants.id
         )
         SELECT folders.id,
                folders.parent_id AS parentId,
                folders.name,
                folders.position,
                (
                  SELECT COUNT(*)
                  FROM descendants
                  JOIN feeds ON feeds.folder_id = descendants.id
                  JOIN articles ON articles.feed_id = feeds.id
                  WHERE descendants.root_id = folders.id
                    AND articles.is_read = 0
                    AND ${hiddenClause}
                ) AS unreadCount
         FROM folders
         ORDER BY folders.position, folders.name COLLATE NOCASE`,
      )
      .all() as Row[];
    return rows.map(mapFolder);
  }

  getFolder(id: number): Folder | null {
    return this.listFolders().find((folder) => folder.id === id) ?? null;
  }

  createFolder(input: { name: string; parentId?: number | null; position?: number }): Folder {
    const timestamp = now();
    const result = this.sqlite
      .prepare(
        `INSERT INTO folders (name, parent_id, position, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        input.name,
        input.parentId ?? null,
        input.position ?? this.nextFolderPosition(),
        timestamp,
        timestamp,
      );
    return this.getFolder(Number(result.lastInsertRowid)) as Folder;
  }

  updateFolder(
    id: number,
    input: { name?: string; parentId?: number | null; position?: number },
  ): Folder | null {
    const existing = this.getFolder(id);
    if (!existing) return null;
    if (
      input.parentId === id ||
      (input.parentId !== undefined && this.isFolderDescendant(input.parentId, id))
    ) {
      throw new Error("A folder cannot be moved inside itself");
    }
    this.sqlite
      .prepare(
        `UPDATE folders
         SET name = ?, parent_id = ?, position = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        input.name ?? existing.name,
        input.parentId === undefined ? existing.parentId : input.parentId,
        input.position ?? existing.position,
        now(),
        id,
      );
    if (input.parentId !== undefined && input.parentId !== existing.parentId) {
      this.recomputeRulesForAllArticles();
    }
    return this.getFolder(id);
  }

  deleteFolder(id: number): boolean {
    const deleted = this.sqlite.prepare("DELETE FROM folders WHERE id = ?").run(id).changes > 0;
    if (deleted) this.recomputeRulesForAllArticles();
    return deleted;
  }

  private nextFolderPosition(): number {
    const row = this.sqlite
      .prepare("SELECT COALESCE(MAX(position), -1) + 1 AS position FROM folders")
      .get() as { position: number };
    return row.position;
  }

  private isFolderDescendant(candidateId: number | null, folderId: number): boolean {
    if (candidateId === null) return false;
    const row = this.sqlite
      .prepare(
        `WITH RECURSIVE descendants(id) AS (
           SELECT id FROM folders WHERE parent_id = ?
           UNION ALL
           SELECT folders.id FROM folders JOIN descendants ON folders.parent_id = descendants.id
         )
         SELECT 1 FROM descendants WHERE id = ?`,
      )
      .get(folderId, candidateId);
    return row !== undefined;
  }

  listFeeds(): Feed[] {
    const rows = this.sqlite
      .prepare(
        `SELECT feeds.id,
                feeds.folder_id AS folderId,
                feeds.title,
                feeds.feed_url AS feedUrl,
                feeds.site_url AS siteUrl,
                feeds.paused,
                feeds.refreshing,
                feeds.last_attempt_at AS lastAttemptAt,
                feeds.last_success_at AS lastSuccessAt,
                feeds.last_http_status AS lastHttpStatus,
                feeds.last_error AS lastError,
                feeds.next_poll_at AS nextPollAt,
                SUM(CASE WHEN articles.id IS NOT NULL AND articles.is_read = 0 AND ${hiddenClause} THEN 1 ELSE 0 END) AS unreadCount,
                SUM(CASE WHEN articles.id IS NOT NULL AND ${hiddenClause} THEN 1 ELSE 0 END) AS totalCount
         FROM feeds
         LEFT JOIN articles ON articles.feed_id = feeds.id
         GROUP BY feeds.id
         ORDER BY feeds.title COLLATE NOCASE`,
      )
      .all() as Row[];
    return rows.map(mapFeed);
  }

  getFeed(id: number): Feed | null {
    return this.listFeeds().find((feed) => feed.id === id) ?? null;
  }

  createFeed(input: {
    feedUrl: string;
    title?: string;
    siteUrl?: string | null;
    folderId?: number | null;
    paused?: boolean;
  }): Feed {
    const timestamp = now();
    const feedUrl = new URL(input.feedUrl).toString();
    const result = this.sqlite
      .prepare(
        `INSERT INTO feeds (
           folder_id, title, feed_url, site_url, paused, next_poll_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.folderId ?? null,
        input.title?.trim() || feedUrl,
        feedUrl,
        input.siteUrl ?? null,
        input.paused ? 1 : 0,
        timestamp,
        timestamp,
        timestamp,
      );
    return this.getFeed(Number(result.lastInsertRowid)) as Feed;
  }

  updateFeed(
    id: number,
    input: {
      title?: string;
      feedUrl?: string;
      siteUrl?: string | null;
      folderId?: number | null;
      paused?: boolean;
    },
  ): Feed | null {
    const existing = this.getFeed(id);
    if (!existing) return null;
    const feedUrl = input.feedUrl ? new URL(input.feedUrl).toString() : existing.feedUrl;
    const title = input.title ?? (existing.title === existing.feedUrl ? feedUrl : existing.title);
    this.sqlite
      .prepare(
        `UPDATE feeds
         SET title = ?, feed_url = ?, site_url = ?, folder_id = ?, paused = ?,
             etag = CASE WHEN feed_url != ? THEN NULL ELSE etag END,
             last_modified = CASE WHEN feed_url != ? THEN NULL ELSE last_modified END,
             next_poll_at = CASE WHEN ? = 1 THEN next_poll_at ELSE ? END,
             updated_at = ?
         WHERE id = ?`,
      )
      .run(
        title,
        feedUrl,
        input.siteUrl === undefined ? existing.siteUrl : input.siteUrl,
        input.folderId === undefined ? existing.folderId : input.folderId,
        (input.paused ?? existing.paused) ? 1 : 0,
        feedUrl,
        feedUrl,
        (input.paused ?? existing.paused) ? 1 : 0,
        now(),
        now(),
        id,
      );
    if (input.folderId !== undefined && input.folderId !== existing.folderId) {
      const articles = this.sqlite
        .prepare("SELECT id FROM articles WHERE feed_id = ?")
        .all(id) as Array<{ id: number }>;
      for (const article of articles) this.recomputeRulesForArticle(article.id);
    }
    return this.getFeed(id);
  }

  deleteFeed(id: number): boolean {
    return this.sqlite.prepare("DELETE FROM feeds WHERE id = ?").run(id).changes > 0;
  }

  getFeedRecord(id: number): FeedRecord | null {
    const row = this.sqlite
      .prepare(
        `SELECT id, folder_id AS folderId, title, feed_url AS feedUrl, site_url AS siteUrl,
                paused, etag, last_modified AS lastModified
         FROM feeds WHERE id = ?`,
      )
      .get(id) as Row | undefined;
    if (!row) return null;
    return {
      id: Number(row.id),
      folderId: row.folderId === null ? null : Number(row.folderId),
      title: String(row.title),
      feedUrl: String(row.feedUrl),
      siteUrl: row.siteUrl === null ? null : String(row.siteUrl),
      paused: toBoolean(row.paused),
      etag: row.etag === null ? null : String(row.etag),
      lastModified: row.lastModified === null ? null : String(row.lastModified),
    };
  }

  getRefreshCandidates(ids?: number[]): FeedRecord[] {
    let rows: Row[];
    if (ids) {
      if (ids.length === 0) return [];
      const placeholders = ids.map(() => "?").join(", ");
      rows = this.sqlite
        .prepare(
          `SELECT id, folder_id AS folderId, title, feed_url AS feedUrl, site_url AS siteUrl,
                  paused, etag, last_modified AS lastModified
           FROM feeds WHERE id IN (${placeholders})`,
        )
        .all(...ids) as Row[];
    } else {
      rows = this.sqlite
        .prepare(
          `SELECT id, folder_id AS folderId, title, feed_url AS feedUrl, site_url AS siteUrl,
                  paused, etag, last_modified AS lastModified
           FROM feeds WHERE paused = 0`,
        )
        .all() as Row[];
    }
    return rows.map((row) => ({
      id: Number(row.id),
      folderId: row.folderId === null ? null : Number(row.folderId),
      title: String(row.title),
      feedUrl: String(row.feedUrl),
      siteUrl: row.siteUrl === null ? null : String(row.siteUrl),
      paused: toBoolean(row.paused),
      etag: row.etag === null ? null : String(row.etag),
      lastModified: row.lastModified === null ? null : String(row.lastModified),
    }));
  }

  getDueFeedIds(at = now()): number[] {
    const rows = this.sqlite
      .prepare(
        `SELECT id FROM feeds
         WHERE paused = 0 AND refreshing = 0
           AND (next_poll_at IS NULL OR next_poll_at <= ?)
         ORDER BY COALESCE(next_poll_at, created_at)`,
      )
      .all(at) as Array<{ id: number }>;
    return rows.map((row) => row.id);
  }

  markFeedRefreshing(id: number): void {
    this.sqlite
      .prepare(
        "UPDATE feeds SET refreshing = 1, last_attempt_at = ?, last_error = NULL WHERE id = ?",
      )
      .run(now(), id);
  }

  markFeedSuccess(
    id: number,
    input: {
      httpStatus: number;
      etag: string | null;
      lastModified: string | null;
      pollIntervalMinutes: number;
      parsed?: ParsedFeed;
    },
  ): number[] {
    const extractionIds: number[] = [];
    const ruleArticleIds = new Set<number>();
    const complete = this.sqlite.transaction(() => {
      if (input.parsed) {
        this.sqlite
          .prepare(
            `UPDATE feeds
             SET title = CASE WHEN title = feed_url THEN ? ELSE title END,
                 site_url = COALESCE(?, site_url), updated_at = ?
             WHERE id = ?`,
          )
          .run(input.parsed.title, input.parsed.siteUrl, now(), id);
        const findExisting = this.sqlite.prepare(
          `SELECT id, title, url, author, published_at AS publishedAt, summary,
                  feed_content_html AS feedContentHtml
           FROM articles WHERE feed_id = ? AND external_id = ?`,
        );
        const insert = this.sqlite.prepare(
          `INSERT INTO articles (
             feed_id, external_id, title, url, author, published_at, discovered_at,
             summary, feed_content_html, extraction_status
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        const update = this.sqlite.prepare(
          `UPDATE articles
           SET title = ?, url = ?, author = ?, published_at = ?, summary = ?,
               feed_content_html = ?,
               content_html = CASE WHEN ? = 1 THEN NULL ELSE content_html END,
               content_source = CASE WHEN ? = 1 THEN NULL ELSE content_source END,
               extraction_status = CASE WHEN ? = 1 THEN ? ELSE extraction_status END,
               extraction_error = CASE WHEN ? = 1 THEN NULL ELSE extraction_error END
           WHERE id = ?`,
        );
        for (const article of input.parsed.articles) {
          const extractionStatus = article.url || article.feedContentHtml ? "pending" : "failed";
          const existing = findExisting.get(id, article.externalId) as Row | undefined;
          if (existing) {
            const sourceChanged =
              existing.url !== article.url || existing.feedContentHtml !== article.feedContentHtml;
            const changed =
              sourceChanged ||
              existing.title !== article.title ||
              existing.author !== article.author ||
              existing.publishedAt !== article.publishedAt ||
              existing.summary !== article.summary;
            if (!changed) continue;
            const articleId = Number(existing.id);
            update.run(
              article.title,
              article.url,
              article.author,
              article.publishedAt,
              article.summary,
              article.feedContentHtml,
              sourceChanged ? 1 : 0,
              sourceChanged ? 1 : 0,
              sourceChanged ? 1 : 0,
              extractionStatus,
              sourceChanged ? 1 : 0,
              articleId,
            );
            ruleArticleIds.add(articleId);
            if (sourceChanged && extractionStatus === "pending") extractionIds.push(articleId);
            continue;
          }
          const result = insert.run(
            id,
            article.externalId,
            article.title,
            article.url,
            article.author,
            article.publishedAt,
            now(),
            article.summary,
            article.feedContentHtml,
            extractionStatus,
          );
          const articleId = Number(result.lastInsertRowid);
          ruleArticleIds.add(articleId);
          if (extractionStatus === "pending") extractionIds.push(articleId);
        }
      }
      const completedAt = now();
      const nextPollAt = new Date(
        Date.parse(completedAt) + input.pollIntervalMinutes * 60_000,
      ).toISOString();
      this.sqlite
        .prepare(
          `UPDATE feeds
           SET refreshing = 0, last_success_at = ?, last_http_status = ?, last_error = NULL,
               etag = COALESCE(?, etag), last_modified = COALESCE(?, last_modified),
               next_poll_at = ?
           WHERE id = ?`,
        )
        .run(completedAt, input.httpStatus, input.etag, input.lastModified, nextPollAt, id);
      for (const articleId of ruleArticleIds) this.recomputeRulesForArticle(articleId);
    });
    complete();
    return extractionIds;
  }

  markFeedFailure(
    id: number,
    input: { httpStatus: number | null; error: string; retryMinutes: number },
  ): void {
    const nextPollAt = new Date(Date.now() + input.retryMinutes * 60_000).toISOString();
    this.sqlite
      .prepare(
        `UPDATE feeds
         SET refreshing = 0, last_http_status = ?, last_error = ?, next_poll_at = ?
         WHERE id = ?`,
      )
      .run(input.httpStatus, input.error, nextPollAt, id);
  }

  getBootstrap(): BootstrapData {
    const counts = this.sqlite
      .prepare(
        `SELECT
           SUM(CASE WHEN is_read = 0 AND ${hiddenClause} THEN 1 ELSE 0 END) AS unread,
           SUM(CASE WHEN is_starred = 1 AND ${hiddenClause} THEN 1 ELSE 0 END) AS starred,
           SUM(CASE WHEN ${hiddenClause} THEN 1 ELSE 0 END) AS allCount
         FROM articles`,
      )
      .get() as Row;
    return {
      folders: this.listFolders(),
      feeds: this.listFeeds(),
      settings: this.getSettings(),
      counts: {
        unread: Number(counts.unread ?? 0),
        starred: Number(counts.starred ?? 0),
        all: Number(counts.allCount ?? 0),
      },
    };
  }

  listArticles(query: ArticleQuery): Article[] {
    return this.listArticlePage(query).articles;
  }

  listArticlePage(query: ArticleQuery): ArticlePage {
    const where = [hiddenClause];
    const values: Array<string | number> = [];
    if (query.state === "unread") where.push("articles.is_read = 0");
    if (query.state === "read") where.push("articles.is_read = 1");
    if (query.state === "starred") where.push("articles.is_starred = 1");
    if (query.feedId !== undefined) {
      where.push("articles.feed_id = ?");
      values.push(query.feedId);
    }
    if (query.folderId !== undefined) {
      where.push(
        `feeds.folder_id IN (
           WITH RECURSIVE folder_tree(id) AS (
             SELECT id FROM folders WHERE id = ?
             UNION ALL
             SELECT folders.id FROM folders JOIN folder_tree ON folders.parent_id = folder_tree.id
           ) SELECT id FROM folder_tree
         )`,
      );
      values.push(query.folderId);
    }
    if (query.search) {
      where.push(
        `(articles.title LIKE ? ESCAPE '\\' COLLATE NOCASE
          OR COALESCE(articles.author, '') LIKE ? ESCAPE '\\' COLLATE NOCASE
          OR articles.summary LIKE ? ESCAPE '\\' COLLATE NOCASE)`,
      );
      const escaped = query.search.replace(/[\\%_]/g, "\\$&");
      values.push(`%${escaped}%`, `%${escaped}%`, `%${escaped}%`);
    }
    if (query.cursor) {
      const cursor = decodeArticleCursor(query.cursor);
      where.push(
        `(COALESCE(articles.published_at, articles.discovered_at) < ?
          OR (COALESCE(articles.published_at, articles.discovered_at) = ? AND articles.id < ?))`,
      );
      values.push(cursor.sortAt, cursor.sortAt, cursor.id);
    }
    const limit = Math.max(1, Math.min(query.limit ?? 200, 500));
    values.push(limit + 1);
    const rows = this.sqlite
      .prepare(
        `SELECT articles.id,
                articles.feed_id AS feedId,
                feeds.title AS feedTitle,
                feeds.folder_id AS folderId,
                articles.title,
                articles.url,
                articles.author,
                articles.published_at AS publishedAt,
                articles.discovered_at AS discoveredAt,
                articles.summary,
                articles.content_html AS contentHtml,
                articles.content_source AS contentSource,
                articles.extraction_status AS extractionStatus,
                articles.extraction_error AS extractionError,
                articles.is_read AS isRead,
                articles.is_starred AS isStarred,
                COALESCE(articles.published_at, articles.discovered_at) AS sortAt
         FROM articles
         JOIN feeds ON feeds.id = articles.feed_id
         WHERE ${where.join(" AND ")}
         ORDER BY COALESCE(articles.published_at, articles.discovered_at) DESC, articles.id DESC
         LIMIT ?`,
      )
      .all(...values) as Row[];
    const pageRows = rows.slice(0, limit);
    const last = pageRows.at(-1);
    return {
      articles: pageRows.map(mapArticle),
      nextCursor:
        rows.length > limit && last
          ? encodeArticleCursor(String(last.sortAt), Number(last.id))
          : null,
    };
  }

  getArticle(id: number): Article | null {
    const row = this.sqlite
      .prepare(
        `SELECT articles.id,
                articles.feed_id AS feedId,
                feeds.title AS feedTitle,
                feeds.folder_id AS folderId,
                articles.title,
                articles.url,
                articles.author,
                articles.published_at AS publishedAt,
                articles.discovered_at AS discoveredAt,
                articles.summary,
                articles.content_html AS contentHtml,
                articles.content_source AS contentSource,
                articles.extraction_status AS extractionStatus,
                articles.extraction_error AS extractionError,
                articles.is_read AS isRead,
                articles.is_starred AS isStarred
         FROM articles JOIN feeds ON feeds.id = articles.feed_id
         WHERE articles.id = ?`,
      )
      .get(id) as Row | undefined;
    return row ? mapArticle(row) : null;
  }

  updateArticleState(id: number, input: { isRead?: boolean; isStarred?: boolean }): Article | null {
    const existing = this.getArticle(id);
    if (!existing) return null;
    this.sqlite
      .prepare("UPDATE articles SET is_read = ?, is_starred = ? WHERE id = ?")
      .run(
        (input.isRead ?? existing.isRead) ? 1 : 0,
        (input.isStarred ?? existing.isStarred) ? 1 : 0,
        id,
      );
    return this.getArticle(id);
  }

  markArticlesRead(input: { articleIds?: number[]; feedId?: number; folderId?: number }): number {
    if (input.articleIds) {
      if (input.articleIds.length === 0) return 0;
      const placeholders = input.articleIds.map(() => "?").join(", ");
      return this.sqlite
        .prepare(`UPDATE articles SET is_read = 1 WHERE id IN (${placeholders})`)
        .run(...input.articleIds).changes;
    }
    if (input.feedId !== undefined) {
      return this.sqlite
        .prepare("UPDATE articles SET is_read = 1 WHERE feed_id = ?")
        .run(input.feedId).changes;
    }
    if (input.folderId !== undefined) {
      return this.sqlite
        .prepare(
          `WITH RECURSIVE folder_tree(id) AS (
             SELECT id FROM folders WHERE id = ?
             UNION ALL
             SELECT folders.id FROM folders JOIN folder_tree ON folders.parent_id = folder_tree.id
           )
           UPDATE articles SET is_read = 1
           WHERE feed_id IN (SELECT id FROM feeds WHERE folder_id IN (SELECT id FROM folder_tree))`,
        )
        .run(input.folderId).changes;
    }
    return this.sqlite.prepare("UPDATE articles SET is_read = 1").run().changes;
  }

  listRules(): Rule[] {
    const rows = this.sqlite
      .prepare(
        `SELECT id, name, feed_id AS feedId, folder_id AS folderId, field, pattern, action,
                enabled, matched_count AS matchedCount, created_at AS createdAt, updated_at AS updatedAt
         FROM rules ORDER BY created_at DESC, id DESC`,
      )
      .all() as Row[];
    return rows.map(mapRule);
  }

  getRule(id: number): Rule | null {
    return this.listRules().find((rule) => rule.id === id) ?? null;
  }

  createRule(input: {
    name: string;
    feedId?: number | null;
    folderId?: number | null;
    field: RuleField;
    pattern: string;
    action: RuleAction;
    enabled?: boolean;
  }): Rule {
    const timestamp = now();
    const result = this.sqlite
      .prepare(
        `INSERT INTO rules (
           name, feed_id, folder_id, field, pattern, action, enabled,
           matched_count, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      )
      .run(
        input.name,
        input.feedId ?? null,
        input.folderId ?? null,
        input.field,
        input.pattern,
        input.action,
        (input.enabled ?? true) ? 1 : 0,
        timestamp,
        timestamp,
      );
    const id = Number(result.lastInsertRowid);
    this.reapplyRule(id);
    return this.getRule(id) as Rule;
  }

  updateRule(
    id: number,
    input: Partial<{
      name: string;
      feedId: number | null;
      folderId: number | null;
      field: RuleField;
      pattern: string;
      action: RuleAction;
      enabled: boolean;
    }>,
  ): Rule | null {
    const existing = this.getRule(id);
    if (!existing) return null;
    this.sqlite
      .prepare(
        `UPDATE rules
         SET name = ?, feed_id = ?, folder_id = ?, field = ?, pattern = ?, action = ?,
             enabled = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        input.name ?? existing.name,
        input.feedId === undefined ? existing.feedId : input.feedId,
        input.folderId === undefined ? existing.folderId : input.folderId,
        input.field ?? existing.field,
        input.pattern ?? existing.pattern,
        input.action ?? existing.action,
        (input.enabled ?? existing.enabled) ? 1 : 0,
        now(),
        id,
      );
    this.reapplyRule(id);
    return this.getRule(id);
  }

  deleteRule(id: number): boolean {
    return this.sqlite.prepare("DELETE FROM rules WHERE id = ?").run(id).changes > 0;
  }

  private reapplyRule(ruleId: number): void {
    const run = this.sqlite.transaction(() => {
      this.sqlite.prepare("DELETE FROM article_rule_matches WHERE rule_id = ?").run(ruleId);
      this.sqlite.prepare("UPDATE rules SET matched_count = 0 WHERE id = ?").run(ruleId);
      const rows = this.sqlite.prepare("SELECT id FROM articles").all() as Array<{ id: number }>;
      for (const row of rows) this.applyRuleToArticle(ruleId, row.id);
    });
    run();
  }

  recomputeRulesForArticle(articleId: number): void {
    this.sqlite.prepare("DELETE FROM article_rule_matches WHERE article_id = ?").run(articleId);
    const rules = this.sqlite.prepare("SELECT id FROM rules").all() as Array<{ id: number }>;
    for (const rule of rules) this.applyRuleToArticle(rule.id, articleId);
    this.sqlite
      .prepare(
        `UPDATE rules
       SET matched_count = (
         SELECT COUNT(*) FROM article_rule_matches WHERE rule_id = rules.id
       )`,
      )
      .run();
  }

  private recomputeRulesForAllArticles(): void {
    const articles = this.sqlite.prepare("SELECT id FROM articles").all() as Array<{ id: number }>;
    for (const article of articles) this.recomputeRulesForArticle(article.id);
  }

  private applyRuleToArticle(ruleId: number, articleId: number): void {
    const rule = this.sqlite.prepare("SELECT * FROM rules WHERE id = ?").get(ruleId) as
      | Row
      | undefined;
    const article = this.sqlite
      .prepare(
        `SELECT articles.*, feeds.folder_id
         FROM articles JOIN feeds ON feeds.id = articles.feed_id
         WHERE articles.id = ?`,
      )
      .get(articleId) as Row | undefined;
    if (!rule || !article) return;
    if (rule.feed_id !== null && Number(rule.feed_id) !== Number(article.feed_id)) return;
    if (rule.folder_id !== null) {
      const inScope = this.sqlite
        .prepare(
          `WITH RECURSIVE folder_tree(id) AS (
             SELECT id FROM folders WHERE id = ?
             UNION ALL
             SELECT folders.id FROM folders JOIN folder_tree ON folders.parent_id = folder_tree.id
           )
           SELECT 1 FROM folder_tree WHERE id = ?`,
        )
        .get(rule.folder_id, article.folder_id);
      if (!inScope) return;
    }
    const values: Record<RuleField, string> = {
      title: String(article.title ?? ""),
      author: String(article.author ?? ""),
      summary: String(article.summary ?? ""),
      content: `${String(article.feed_content_html ?? "")} ${String(article.content_html ?? "")}`,
      any: `${String(article.title ?? "")} ${String(article.author ?? "")} ${String(
        article.summary ?? "",
      )} ${String(article.feed_content_html ?? "")} ${String(article.content_html ?? "")}`,
    };
    const field = rule.field as RuleField;
    const matched = values[field]
      .toLocaleLowerCase()
      .includes(String(rule.pattern).toLocaleLowerCase());
    if (!matched) return;
    const inserted = this.sqlite
      .prepare("INSERT OR IGNORE INTO article_rule_matches (article_id, rule_id) VALUES (?, ?)")
      .run(articleId, ruleId);
    if (inserted.changes === 0) return;
    this.sqlite
      .prepare("UPDATE rules SET matched_count = matched_count + 1 WHERE id = ?")
      .run(ruleId);
    if (rule.enabled === 1 && rule.action === "mark_read") {
      this.sqlite.prepare("UPDATE articles SET is_read = 1 WHERE id = ?").run(articleId);
    }
  }

  getPendingExtractions(limit = 100): ExtractionRecord[] {
    const rows = this.sqlite
      .prepare(
        `SELECT id, url, feed_content_html AS feedContentHtml
         FROM articles WHERE extraction_status = 'pending'
         ORDER BY discovered_at LIMIT ?`,
      )
      .all(limit) as Row[];
    return rows.map((row) => ({
      id: Number(row.id),
      url: row.url === null ? null : String(row.url),
      feedContentHtml: row.feedContentHtml === null ? null : String(row.feedContentHtml),
    }));
  }

  getExtractionRecord(id: number): ExtractionRecord | null {
    const row = this.sqlite
      .prepare(
        `SELECT id, url, feed_content_html AS feedContentHtml
         FROM articles WHERE id = ? AND extraction_status = 'pending'`,
      )
      .get(id) as Row | undefined;
    if (!row) return null;
    return {
      id: Number(row.id),
      url: row.url === null ? null : String(row.url),
      feedContentHtml: row.feedContentHtml === null ? null : String(row.feedContentHtml),
    };
  }

  markExtractionProcessing(id: number): boolean {
    return (
      this.sqlite
        .prepare(
          "UPDATE articles SET extraction_status = 'processing' WHERE id = ? AND extraction_status = 'pending'",
        )
        .run(id).changes > 0
    );
  }

  retryExtraction(id: number): boolean {
    return (
      this.sqlite
        .prepare(
          `UPDATE articles
           SET extraction_status = 'pending', extraction_error = NULL
           WHERE id = ? AND extraction_status != 'processing'`,
        )
        .run(id).changes > 0
    );
  }

  completeExtraction(
    id: number,
    input: {
      contentHtml: string | null;
      contentSource: "article" | "feed" | null;
      status: "complete" | "feed" | "failed";
      error: string | null;
    },
  ): void {
    this.sqlite
      .prepare(
        `UPDATE articles
         SET content_html = ?, content_source = ?, extraction_status = ?, extraction_error = ?
         WHERE id = ?`,
      )
      .run(input.contentHtml, input.contentSource, input.status, input.error, id);
    this.recomputeRulesForArticle(id);
  }

  listOpmlFolders(): Array<{ id: number; name: string; parentId: number | null }> {
    return this.sqlite
      .prepare(
        "SELECT id, name, parent_id AS parentId FROM folders ORDER BY position, name COLLATE NOCASE",
      )
      .all() as Array<{ id: number; name: string; parentId: number | null }>;
  }

  listOpmlFeeds(): Array<{
    title: string;
    feedUrl: string;
    siteUrl: string | null;
    folderId: number | null;
  }> {
    return this.sqlite
      .prepare(
        `SELECT title, feed_url AS feedUrl, site_url AS siteUrl, folder_id AS folderId
         FROM feeds ORDER BY title COLLATE NOCASE`,
      )
      .all() as Array<{
      title: string;
      feedUrl: string;
      siteUrl: string | null;
      folderId: number | null;
    }>;
  }
}

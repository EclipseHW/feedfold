import Sqlite from "better-sqlite3";
import type {
  AiArticleSourceKind,
  AiFeature,
  AiFeatureSetting,
  AiProvider,
  AiUsage,
  AppSettings,
  Article,
  ArticleAiSummary,
  ArticleMedia,
  ArticlePage,
  ArticleQuery,
  BootstrapData,
  Feed,
  Folder,
  FolderSortDirection,
  MarkReadRequest,
  Rule,
  RuleAction,
  RuleCondition,
  RuleConditionOperator,
  RuleField,
} from "../shared/types.js";
import { cleanArticleHtml, removeStoredSrcsetsWithFallback } from "./article-html.js";
import { firstSafeImageUrl } from "./article-image.js";
import { articleMediaRuleText, youtubeMediaFromUrl } from "./article-media.js";

export interface FeedRecord {
  id: number;
  folderId: number | null;
  title: string;
  feedUrl: string;
  siteUrl: string | null;
  paused: boolean;
  etag: string | null;
  lastModified: string | null;
  pollIntervalMinutes: number;
}

export interface ParsedArticle {
  externalId: string;
  title: string;
  url: string | null;
  author: string | null;
  publishedAt: string | null;
  summary: string;
  imageUrl: string | null;
  media?: ArticleMedia | null;
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
}

export interface AiArticleRecord {
  id: number;
  revision: number;
  title: string;
  url: string | null;
  author: string | null;
  contentHtml: string | null;
  feedContentHtml: string | null;
  excerpt: string;
  currentSummary: StoredArticleAiSummary | null;
}

export interface StoredArticleAiSummary extends ArticleAiSummary {
  sourceRevision: number;
  promptVersion: number;
}

type Row = Record<string, unknown>;

interface Migration {
  sql: string;
  after?: (database: Sqlite.Database) => void;
  foreignKeysOff?: boolean;
}

type ArticleStructureTag = "blockquote" | "table";

function recleanStructuredArticleHtml(
  database: Sqlite.Database,
  tags: ArticleStructureTag[],
): void {
  for (const column of ["feed_content_html", "content_html"] as const) {
    const structureCondition = tags.map((tag) => `${column} LIKE '%<${tag}%'`).join(" OR ");
    const selectBatch = database.prepare(
      `SELECT id, url, ${column} AS html
       FROM articles
       WHERE id > ? AND (${structureCondition})
       ORDER BY id
       LIMIT 50`,
    );
    const update = database.prepare(`UPDATE articles SET ${column} = ? WHERE id = ?`);
    let lastId = 0;
    while (true) {
      const rows = selectBatch.all(lastId) as Array<{
        id: number;
        url: string | null;
        html: string;
      }>;
      if (rows.length === 0) break;
      for (const row of rows) {
        update.run(cleanArticleHtml(row.html, row.url ?? undefined), row.id);
      }
      lastId = rows.at(-1)?.id ?? lastId;
    }
  }
}

function repairStoredArticleSrcsets(database: Sqlite.Database): void {
  for (const column of ["feed_content_html", "content_html"] as const) {
    const selectBatch = database.prepare(
      `SELECT id, ${column} AS html
       FROM articles
       WHERE id > ? AND ${column} LIKE '%srcset=%'
       ORDER BY id
       LIMIT 50`,
    );
    const update = database.prepare(`UPDATE articles SET ${column} = ? WHERE id = ?`);
    let lastId = 0;
    while (true) {
      const rows = selectBatch.all(lastId) as Array<{ id: number; html: string }>;
      if (rows.length === 0) break;
      for (const row of rows) {
        const repairedHtml = removeStoredSrcsetsWithFallback(row.html);
        if (repairedHtml !== row.html) update.run(repairedHtml, row.id);
      }
      lastId = rows.at(-1)?.id ?? lastId;
    }
  }
}

const migrations: Migration[] = [
  {
    sql: `
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
  },
  {
    sql: `
      ALTER TABLE settings ADD COLUMN mark_read_on_scroll INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE articles ADD COLUMN image_url TEXT;
      UPDATE articles
      SET content_html = NULL,
          content_source = NULL,
          extraction_status = 'pending',
          extraction_error = NULL,
          image_url = NULL
      WHERE extraction_status IN ('complete', 'processing')
        AND (
          lower(url) LIKE '%.mp4'
          OR instr(lower(url), '.mp4?') > 0
          OR instr(lower(url), '.mp4#') > 0
        );
    `,
    after: (database) => {
      const rows = database
        .prepare(
          `SELECT id, url, content_html AS contentHtml, feed_content_html AS feedContentHtml
           FROM articles
           WHERE content_html IS NOT NULL OR feed_content_html IS NOT NULL`,
        )
        .all() as Array<{
        id: number;
        url: string | null;
        contentHtml: string | null;
        feedContentHtml: string | null;
      }>;
      const update = database.prepare("UPDATE articles SET image_url = ? WHERE id = ?");
      for (const row of rows) {
        const baseUrl = row.url ?? undefined;
        const imageUrl =
          firstSafeImageUrl(row.contentHtml, baseUrl) ??
          firstSafeImageUrl(row.feedContentHtml, baseUrl);
        update.run(imageUrl, row.id);
      }
    },
  },
  {
    foreignKeysOff: true,
    sql: `
      CREATE TABLE users (
        id INTEGER PRIMARY KEY,
        username TEXT NOT NULL COLLATE NOCASE UNIQUE,
        password_hash TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      INSERT INTO users (id, username, password_hash, enabled, created_at, updated_at)
      VALUES (1, '__legacy_owner__', '', 0, datetime('now'), datetime('now'));

      CREATE TABLE sessions (
        token_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );

      ALTER TABLE folders RENAME TO folders_v2;
      ALTER TABLE feeds RENAME TO feeds_v2;
      ALTER TABLE articles RENAME TO articles_v2;
      ALTER TABLE rules RENAME TO rules_v2;
      ALTER TABLE article_rule_matches RENAME TO article_rule_matches_v2;
      ALTER TABLE settings RENAME TO settings_v2;

      DROP INDEX IF EXISTS articles_feed_id_idx;
      DROP INDEX IF EXISTS articles_read_idx;
      DROP INDEX IF EXISTS articles_starred_idx;
      DROP INDEX IF EXISTS articles_published_idx;
      DROP INDEX IF EXISTS feeds_folder_id_idx;
      DROP INDEX IF EXISTS rules_feed_id_idx;
      DROP INDEX IF EXISTS rules_folder_id_idx;

      CREATE TABLE folders (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        parent_id INTEGER REFERENCES folders(id) ON DELETE SET NULL,
        name TEXT NOT NULL,
        position INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE feeds (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        folder_id INTEGER REFERENCES folders(id) ON DELETE SET NULL,
        title TEXT NOT NULL,
        feed_url TEXT NOT NULL,
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
        updated_at TEXT NOT NULL,
        UNIQUE(user_id, feed_url)
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
        image_url TEXT,
        UNIQUE(feed_id, external_id)
      );

      CREATE TABLE rules (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
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
        user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        poll_interval_minutes INTEGER NOT NULL,
        single_key_shortcuts INTEGER NOT NULL,
        mark_read_on_scroll INTEGER NOT NULL DEFAULT 1
      );

      INSERT INTO folders (id, user_id, parent_id, name, position, created_at, updated_at)
      SELECT id, 1, parent_id, name, position, created_at, updated_at FROM folders_v2;

      INSERT INTO feeds (
        id, user_id, folder_id, title, feed_url, site_url, paused, refreshing, etag,
        last_modified, last_attempt_at, last_success_at, last_http_status, last_error,
        next_poll_at, created_at, updated_at
      )
      SELECT id, 1, folder_id, title, feed_url, site_url, paused, refreshing, etag,
             last_modified, last_attempt_at, last_success_at, last_http_status, last_error,
             next_poll_at, created_at, updated_at
      FROM feeds_v2;

      INSERT INTO articles (
        id, feed_id, external_id, title, url, author, published_at, discovered_at, summary,
        feed_content_html, content_html, content_source, extraction_status, extraction_error,
        is_read, is_starred, image_url
      )
      SELECT id, feed_id, external_id, title, url, author, published_at, discovered_at, summary,
             feed_content_html, content_html, content_source, extraction_status, extraction_error,
             is_read, is_starred, image_url
      FROM articles_v2;

      INSERT INTO rules (
        id, user_id, name, feed_id, folder_id, field, pattern, action, enabled,
        matched_count, created_at, updated_at
      )
      SELECT id, 1, name, feed_id, folder_id, field, pattern, action, enabled,
             matched_count, created_at, updated_at
      FROM rules_v2;

      INSERT INTO article_rule_matches (article_id, rule_id)
      SELECT article_id, rule_id FROM article_rule_matches_v2;

      INSERT INTO settings (
        user_id, poll_interval_minutes, single_key_shortcuts, mark_read_on_scroll
      )
      SELECT 1, poll_interval_minutes, single_key_shortcuts, mark_read_on_scroll FROM settings_v2;

      DROP TABLE article_rule_matches_v2;
      DROP TABLE rules_v2;
      DROP TABLE articles_v2;
      DROP TABLE feeds_v2;
      DROP TABLE folders_v2;
      DROP TABLE settings_v2;

      CREATE INDEX sessions_user_id_idx ON sessions(user_id);
      CREATE INDEX sessions_expires_at_idx ON sessions(expires_at);
      CREATE INDEX folders_user_id_idx ON folders(user_id);
      CREATE INDEX articles_feed_id_idx ON articles(feed_id);
      CREATE INDEX articles_read_idx ON articles(is_read);
      CREATE INDEX articles_starred_idx ON articles(is_starred);
      CREATE INDEX articles_published_idx ON articles(published_at DESC);
      CREATE INDEX feeds_user_id_idx ON feeds(user_id);
      CREATE INDEX feeds_folder_id_idx ON feeds(folder_id);
      CREATE INDEX rules_user_id_idx ON rules(user_id);
      CREATE INDEX rules_feed_id_idx ON rules(feed_id);
      CREATE INDEX rules_folder_id_idx ON rules(folder_id);
    `,
  },
  {
    foreignKeysOff: true,
    sql: `
      ALTER TABLE article_rule_matches RENAME TO article_rule_matches_v3;
      ALTER TABLE rules RENAME TO rules_v3;

      DROP INDEX IF EXISTS rules_user_id_idx;
      DROP INDEX IF EXISTS rules_feed_id_idx;
      DROP INDEX IF EXISTS rules_folder_id_idx;

      CREATE TABLE rules (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        feed_id INTEGER REFERENCES feeds(id) ON DELETE CASCADE,
        folder_id INTEGER REFERENCES folders(id) ON DELETE CASCADE,
        field TEXT NOT NULL
          CHECK(field IN ('title', 'author', 'summary', 'content', 'media', 'any')),
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

      INSERT INTO rules (
        id, user_id, name, feed_id, folder_id, field, pattern, action, enabled,
        matched_count, created_at, updated_at
      )
      SELECT id, user_id, name, feed_id, folder_id, field, pattern, action, enabled,
             matched_count, created_at, updated_at
      FROM rules_v3;

      INSERT INTO article_rule_matches (article_id, rule_id)
      SELECT article_id, rule_id FROM article_rule_matches_v3;

      DROP TABLE article_rule_matches_v3;
      DROP TABLE rules_v3;

      CREATE INDEX rules_user_id_idx ON rules(user_id);
      CREATE INDEX rules_feed_id_idx ON rules(feed_id);
      CREATE INDEX rules_folder_id_idx ON rules(folder_id);

      ALTER TABLE articles ADD COLUMN media_json TEXT;
    `,
    after: (database) => {
      const rows = database
        .prepare("SELECT id, url FROM articles WHERE url IS NOT NULL")
        .all() as Array<{ id: number; url: string }>;
      const update = database.prepare(
        `UPDATE articles
         SET media_json = ?, image_url = COALESCE(image_url, ?), content_html = NULL,
             content_source = NULL, extraction_status = 'feed', extraction_error = NULL
         WHERE id = ?`,
      );
      for (const row of rows) {
        const media = youtubeMediaFromUrl(row.url);
        if (media) update.run(JSON.stringify(media), media.thumbnailUrl, row.id);
      }
    },
  },
  {
    foreignKeysOff: true,
    sql: `
      ALTER TABLE article_rule_matches RENAME TO article_rule_matches_v4;
      ALTER TABLE rules RENAME TO rules_v4;

      DROP INDEX IF EXISTS rules_user_id_idx;
      DROP INDEX IF EXISTS rules_feed_id_idx;
      DROP INDEX IF EXISTS rules_folder_id_idx;

      CREATE TABLE rules (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        feed_id INTEGER REFERENCES feeds(id) ON DELETE CASCADE,
        folder_id INTEGER REFERENCES folders(id) ON DELETE CASCADE,
        conditions_json TEXT NOT NULL
          CHECK(json_valid(conditions_json) AND json_array_length(conditions_json) > 0),
        condition_operator TEXT NOT NULL CHECK(condition_operator IN ('and', 'or')),
        action TEXT NOT NULL CHECK(action IN ('hide', 'keep', 'mark_read')),
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

      INSERT INTO rules (
        id, user_id, name, feed_id, folder_id, conditions_json, condition_operator, action,
        enabled, matched_count, created_at, updated_at
      )
      SELECT id, user_id, name, feed_id, folder_id,
             json_array(json_object('field', field, 'pattern', pattern)), 'and', action,
             enabled, matched_count, created_at, updated_at
      FROM rules_v4;

      INSERT INTO article_rule_matches (article_id, rule_id)
      SELECT article_id, rule_id FROM article_rule_matches_v4;

      DROP TABLE article_rule_matches_v4;
      DROP TABLE rules_v4;

      CREATE INDEX rules_user_id_idx ON rules(user_id);
      CREATE INDEX rules_feed_id_idx ON rules(feed_id);
      CREATE INDEX rules_folder_id_idx ON rules(folder_id);
    `,
  },
  {
    sql: `
      UPDATE articles
      SET content_html = CASE
            WHEN content_source = 'article' AND content_html IS NOT NULL THEN content_html
            ELSE NULL
          END,
          content_source = CASE
            WHEN content_source = 'article' AND content_html IS NOT NULL THEN 'article'
            ELSE NULL
          END,
          extraction_status = CASE
            WHEN content_source = 'article' AND content_html IS NOT NULL THEN 'complete'
            ELSE 'feed'
          END,
          extraction_error = NULL;
    `,
    after: (database) => {
      const rows = database
        .prepare(
          `SELECT id, url, feed_content_html AS feedContentHtml
           FROM articles WHERE feed_content_html IS NOT NULL`,
        )
        .all() as Array<{ id: number; url: string | null; feedContentHtml: string }>;
      const update = database.prepare("UPDATE articles SET feed_content_html = ? WHERE id = ?");
      for (const row of rows) {
        update.run(cleanArticleHtml(row.feedContentHtml, row.url ?? undefined), row.id);
      }
    },
  },
  {
    sql: "",
    after: (database) => recleanStructuredArticleHtml(database, ["blockquote", "table"]),
  },
  {
    sql: "",
    after: (database) => recleanStructuredArticleHtml(database, ["blockquote"]),
  },
  {
    sql: "",
    after: repairStoredArticleSrcsets,
  },
  {
    sql: "",
    after: (database) => recleanStructuredArticleHtml(database, ["blockquote"]),
  },
  {
    sql: `
      ALTER TABLE articles ADD COLUMN content_revision INTEGER NOT NULL DEFAULT 1;

      CREATE TABLE ai_credentials (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        encrypted_api_key TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(user_id, provider)
      );

      CREATE TABLE ai_feature_settings (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        feature TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(user_id, feature)
      );

      CREATE TABLE article_ai_summaries (
        article_id INTEGER PRIMARY KEY REFERENCES articles(id) ON DELETE CASCADE,
        source_revision INTEGER NOT NULL,
        prompt_version INTEGER NOT NULL,
        source_kind TEXT NOT NULL CHECK(source_kind IN ('full', 'feed', 'excerpt')),
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        summary_text TEXT NOT NULL,
        input_tokens INTEGER CHECK(input_tokens IS NULL OR input_tokens >= 0),
        output_tokens INTEGER CHECK(output_tokens IS NULL OR output_tokens >= 0),
        generated_at TEXT NOT NULL
      );
    `,
  },
  {
    sql: `
      UPDATE articles
      SET title = '', content_revision = content_revision + 1
      WHERE title <> ''
        AND feed_id IN (
          SELECT id FROM feeds
          WHERE lower(feed_url) LIKE 'https://nitter.net/%'
             OR lower(feed_url) LIKE 'http://nitter.net/%'
             OR lower(feed_url) LIKE 'https://t.me/%'
             OR lower(feed_url) LIKE 'http://t.me/%'
        );

      UPDATE feeds
      SET etag = NULL, last_modified = NULL, next_poll_at = NULL
      WHERE lower(feed_url) LIKE 'https://nitter.net/%'
         OR lower(feed_url) LIKE 'http://nitter.net/%'
         OR lower(feed_url) LIKE 'https://t.me/%'
         OR lower(feed_url) LIKE 'http://t.me/%';
    `,
  },
  {
    sql: `
      ALTER TABLE folders ADD COLUMN sort_direction TEXT NOT NULL DEFAULT 'newest'
        CHECK(sort_direction IN ('newest', 'oldest'));
    `,
  },
];

function now(): string {
  return new Date().toISOString();
}

interface ArticleCursorBoundary {
  sortAt: string;
  id: number;
  consumed: number;
}

type ArticleCursor = Map<string, ArticleCursorBoundary>;

function decodeArticleCursor(cursor: string): ArticleCursor {
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (!Array.isArray(value)) throw new Error("Invalid cursor fields");
    const boundaries: ArticleCursor = new Map();
    for (const boundary of value) {
      if (
        !Array.isArray(boundary) ||
        boundary.length !== 4 ||
        typeof boundary[0] !== "string" ||
        typeof boundary[1] !== "string" ||
        typeof boundary[2] !== "number" ||
        !Number.isInteger(boundary[2]) ||
        typeof boundary[3] !== "number" ||
        !Number.isInteger(boundary[3]) ||
        boundary[3] < 0
      ) {
        throw new Error("Invalid cursor fields");
      }
      boundaries.set(boundary[0], {
        sortAt: boundary[1],
        id: boundary[2],
        consumed: boundary[3],
      });
    }
    return boundaries;
  } catch {
    throw new Error("Invalid article cursor");
  }
}

function encodeArticleCursor(cursor: ArticleCursor): string {
  return Buffer.from(
    JSON.stringify(
      [...cursor].map(([bucket, boundary]) => [
        bucket,
        boundary.sortAt,
        boundary.id,
        boundary.consumed,
      ]),
    ),
  ).toString("base64url");
}

function toBoolean(value: unknown): boolean {
  return value === 1;
}

function parseArticleMedia(value: unknown): ArticleMedia | null {
  return value === null ? null : (JSON.parse(String(value)) as ArticleMedia);
}

function mapFolder(row: Row): Folder {
  return {
    id: Number(row.id),
    parentId: row.parentId === null ? null : Number(row.parentId),
    name: String(row.name),
    position: Number(row.position),
    sortDirection: row.sortDirection as FolderSortDirection,
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

function mapFeedRecord(row: Row): FeedRecord {
  return {
    id: Number(row.id),
    folderId: row.folderId === null ? null : Number(row.folderId),
    title: String(row.title),
    feedUrl: String(row.feedUrl),
    siteUrl: row.siteUrl === null ? null : String(row.siteUrl),
    paused: toBoolean(row.paused),
    etag: row.etag === null ? null : String(row.etag),
    lastModified: row.lastModified === null ? null : String(row.lastModified),
    pollIntervalMinutes: Number(row.pollIntervalMinutes),
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
    imageUrl: row.imageUrl === null ? null : String(row.imageUrl),
    media: parseArticleMedia(row.mediaJson),
    feedContentHtml: row.feedContentHtml === null ? null : String(row.feedContentHtml),
    contentHtml: row.contentHtml === null ? null : String(row.contentHtml),
    contentSource:
      row.contentSource === "article" || row.contentSource === "feed" ? row.contentSource : null,
    extractionStatus: row.extractionStatus as Article["extractionStatus"],
    extractionError: row.extractionError === null ? null : String(row.extractionError),
    aiSummary: mapArticleAiSummary(row),
    isRead: toBoolean(row.isRead),
    isStarred: toBoolean(row.isStarred),
  };
}

function mapArticleAiSummary(row: Row): ArticleAiSummary | null {
  if (row.aiSummaryText === null || row.aiSummaryText === undefined) return null;
  return {
    text: String(row.aiSummaryText),
    provider: row.aiSummaryProvider as AiProvider,
    model: String(row.aiSummaryModel),
    sourceKind: row.aiSummarySourceKind as AiArticleSourceKind,
    generatedAt: String(row.aiSummaryGeneratedAt),
    usage: {
      inputTokens: row.aiSummaryInputTokens === null ? null : Number(row.aiSummaryInputTokens),
      outputTokens: row.aiSummaryOutputTokens === null ? null : Number(row.aiSummaryOutputTokens),
    },
  };
}

function mapStoredArticleAiSummary(row: Row): StoredArticleAiSummary | null {
  const summary = mapArticleAiSummary(row);
  if (!summary) return null;
  return {
    ...summary,
    sourceRevision: Number(row.aiSummarySourceRevision),
    promptVersion: Number(row.aiSummaryPromptVersion),
  };
}

function mapRule(row: Row): Rule {
  return {
    id: Number(row.id),
    name: String(row.name),
    feedId: row.feedId === null ? null : Number(row.feedId),
    folderId: row.folderId === null ? null : Number(row.folderId),
    conditions: JSON.parse(String(row.conditionsJson)) as RuleCondition[],
    conditionOperator: row.conditionOperator as RuleConditionOperator,
    action: row.action as RuleAction,
    enabled: toBoolean(row.enabled),
    matchedCount: Number(row.matchedCount),
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
  };
}

const visibleClause = `NOT EXISTS (
  SELECT 1
  FROM article_rule_matches arm
  JOIN rules hidden_rule ON hidden_rule.id = arm.rule_id
  WHERE arm.article_id = articles.id
    AND hidden_rule.enabled = 1
    AND hidden_rule.action = 'hide'
)
AND (
  NOT EXISTS (
    SELECT 1
    FROM rules keep_rule
    WHERE keep_rule.user_id = feeds.user_id
      AND keep_rule.enabled = 1
      AND keep_rule.action = 'keep'
      AND (keep_rule.feed_id IS NULL OR keep_rule.feed_id = articles.feed_id)
      AND (
        keep_rule.folder_id IS NULL
        OR EXISTS (
          WITH RECURSIVE folder_tree(id) AS (
            SELECT id
            FROM folders
            WHERE id = keep_rule.folder_id AND user_id = keep_rule.user_id
            UNION ALL
            SELECT folders.id
            FROM folders
            JOIN folder_tree ON folders.parent_id = folder_tree.id
            WHERE folders.user_id = keep_rule.user_id
          )
          SELECT 1 FROM folder_tree WHERE id = feeds.folder_id
        )
      )
  )
  OR EXISTS (
    SELECT 1
    FROM article_rule_matches keep_match
    JOIN rules matched_keep_rule ON matched_keep_rule.id = keep_match.rule_id
    WHERE keep_match.article_id = articles.id
      AND matched_keep_rule.enabled = 1
      AND matched_keep_rule.action = 'keep'
  )
)`;

export class AppDatabase {
  readonly sqlite: Sqlite.Database;
  readonly wasNewDatabase: boolean;

  constructor(path: string, defaultPollIntervalMinutes = 20) {
    this.sqlite = new Sqlite(path);
    this.sqlite.pragma("foreign_keys = ON");
    this.sqlite.pragma("journal_mode = WAL");
    this.wasNewDatabase =
      this.sqlite
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'settings'")
        .get() === undefined;
    this.migrate();
    if (this.wasNewDatabase && defaultPollIntervalMinutes !== 20) {
      this.sqlite
        .prepare("UPDATE settings SET poll_interval_minutes = ? WHERE user_id = 1")
        .run(defaultPollIntervalMinutes);
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
      const migration = migrations[index];
      const apply = this.sqlite.transaction(() => {
        this.sqlite.exec(migration.sql);
        migration.after?.(this.sqlite);
        this.sqlite
          .prepare("INSERT INTO migrations (version, applied_at) VALUES (?, ?)")
          .run(index + 1, now());
      });
      if (migration.foreignKeysOff) this.sqlite.pragma("foreign_keys = OFF");
      try {
        apply();
      } finally {
        if (migration.foreignKeysOff) this.sqlite.pragma("foreign_keys = ON");
      }
      const violations = this.sqlite.pragma("foreign_key_check") as Row[];
      if (violations.length > 0) throw new Error(`Migration ${index + 1} broke foreign keys`);
    }
  }

  close(): void {
    this.sqlite.close();
  }

  getSettings(userId: number): AppSettings {
    const row = this.sqlite
      .prepare(
        `SELECT poll_interval_minutes AS pollIntervalMinutes,
                single_key_shortcuts AS singleKeyShortcuts,
                mark_read_on_scroll AS markReadOnScroll
         FROM settings WHERE user_id = ?`,
      )
      .get(userId) as Row;
    return {
      pollIntervalMinutes: Number(row.pollIntervalMinutes),
      singleKeyShortcuts: toBoolean(row.singleKeyShortcuts),
      markReadOnScroll: toBoolean(row.markReadOnScroll),
    };
  }

  updateSettings(userId: number, input: Partial<AppSettings>): AppSettings {
    const current = this.getSettings(userId);
    this.sqlite
      .prepare(
        `UPDATE settings
         SET poll_interval_minutes = ?, single_key_shortcuts = ?, mark_read_on_scroll = ?
         WHERE user_id = ?`,
      )
      .run(
        input.pollIntervalMinutes ?? current.pollIntervalMinutes,
        (input.singleKeyShortcuts ?? current.singleKeyShortcuts) ? 1 : 0,
        (input.markReadOnScroll ?? current.markReadOnScroll) ? 1 : 0,
        userId,
      );
    return this.getSettings(userId);
  }

  getAiFeatureSetting(userId: number, feature: AiFeature): AiFeatureSetting | null {
    const row = this.sqlite
      .prepare(
        `SELECT provider, model
         FROM ai_feature_settings
         WHERE user_id = ? AND feature = ?`,
      )
      .get(userId, feature) as Row | undefined;
    if (!row) return null;
    return { provider: row.provider as AiProvider, model: String(row.model) };
  }

  setAiFeatureSetting(
    userId: number,
    feature: AiFeature,
    setting: AiFeatureSetting,
  ): AiFeatureSetting {
    this.sqlite
      .prepare(
        `INSERT INTO ai_feature_settings (user_id, feature, provider, model, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id, feature) DO UPDATE SET
           provider = excluded.provider,
           model = excluded.model,
           updated_at = excluded.updated_at`,
      )
      .run(userId, feature, setting.provider, setting.model, now());
    return this.getAiFeatureSetting(userId, feature) as AiFeatureSetting;
  }

  listConfiguredAiProviders(userId: number): AiProvider[] {
    return (
      this.sqlite
        .prepare("SELECT provider FROM ai_credentials WHERE user_id = ? ORDER BY provider")
        .all(userId) as Array<{ provider: AiProvider }>
    ).map((row) => row.provider);
  }

  getEncryptedAiCredential(userId: number, provider: AiProvider): string | null {
    const row = this.sqlite
      .prepare(
        `SELECT encrypted_api_key AS encryptedApiKey
         FROM ai_credentials WHERE user_id = ? AND provider = ?`,
      )
      .get(userId, provider) as { encryptedApiKey: string } | undefined;
    return row?.encryptedApiKey ?? null;
  }

  setEncryptedAiCredential(userId: number, provider: AiProvider, encryptedApiKey: string): void {
    const timestamp = now();
    this.sqlite
      .prepare(
        `INSERT INTO ai_credentials (
           user_id, provider, encrypted_api_key, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id, provider) DO UPDATE SET
           encrypted_api_key = excluded.encrypted_api_key,
           updated_at = excluded.updated_at`,
      )
      .run(userId, provider, encryptedApiKey, timestamp, timestamp);
  }

  deleteAiCredential(userId: number, provider: AiProvider): boolean {
    return (
      this.sqlite
        .prepare("DELETE FROM ai_credentials WHERE user_id = ? AND provider = ?")
        .run(userId, provider).changes > 0
    );
  }

  listFolders(userId: number): Folder[] {
    const rows = this.sqlite
      .prepare(
        `WITH RECURSIVE descendants(root_id, id) AS (
           SELECT id, id FROM folders WHERE user_id = ?
           UNION ALL
           SELECT descendants.root_id, folders.id
           FROM folders JOIN descendants ON folders.parent_id = descendants.id
           WHERE folders.user_id = ?
         )
         SELECT folders.id,
                folders.parent_id AS parentId,
                folders.name,
                folders.position,
                folders.sort_direction AS sortDirection,
                (
                  SELECT COUNT(*)
                  FROM descendants
                  JOIN feeds ON feeds.folder_id = descendants.id
                  JOIN articles ON articles.feed_id = feeds.id
                  WHERE descendants.root_id = folders.id
                    AND articles.is_read = 0
                    AND ${visibleClause}
                ) AS unreadCount
         FROM folders
         WHERE folders.user_id = ?`,
      )
      .all(userId, userId, userId) as Row[];
    return rows
      .map(mapFolder)
      .sort(
        (left, right) =>
          left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" }) ||
          left.position - right.position,
      );
  }

  getFolder(userId: number, id: number): Folder | null {
    return this.listFolders(userId).find((folder) => folder.id === id) ?? null;
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
    if (input.parentId && !this.getFolder(userId, input.parentId)) {
      throw new Error("The selected folder or feed does not exist");
    }
    const timestamp = now();
    const result = this.sqlite
      .prepare(
        `INSERT INTO folders (
           user_id, name, parent_id, position, sort_direction, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        userId,
        input.name,
        input.parentId ?? null,
        input.position ?? this.nextFolderPosition(userId),
        input.sortDirection ?? "newest",
        timestamp,
        timestamp,
      );
    return this.getFolder(userId, Number(result.lastInsertRowid)) as Folder;
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
    const existing = this.getFolder(userId, id);
    if (!existing) return null;
    if (input.parentId && !this.getFolder(userId, input.parentId)) {
      throw new Error("The selected folder or feed does not exist");
    }
    if (
      input.parentId === id ||
      (input.parentId !== undefined && this.isFolderDescendant(userId, input.parentId, id))
    ) {
      throw new Error("A folder cannot be moved inside itself");
    }
    this.sqlite
      .prepare(
        `UPDATE folders
         SET name = ?, parent_id = ?, position = ?, sort_direction = ?, updated_at = ?
         WHERE id = ? AND user_id = ?`,
      )
      .run(
        input.name ?? existing.name,
        input.parentId === undefined ? existing.parentId : input.parentId,
        input.position ?? existing.position,
        input.sortDirection ?? existing.sortDirection,
        now(),
        id,
        userId,
      );
    if (input.parentId !== undefined && input.parentId !== existing.parentId) {
      this.recomputeRulesForAllArticles(userId);
    }
    return this.getFolder(userId, id);
  }

  deleteFolder(userId: number, id: number): boolean {
    const deleted =
      this.sqlite.prepare("DELETE FROM folders WHERE id = ? AND user_id = ?").run(id, userId)
        .changes > 0;
    if (deleted) this.recomputeRulesForAllArticles(userId);
    return deleted;
  }

  private nextFolderPosition(userId: number): number {
    const row = this.sqlite
      .prepare("SELECT COALESCE(MAX(position), -1) + 1 AS position FROM folders WHERE user_id = ?")
      .get(userId) as { position: number };
    return row.position;
  }

  private isFolderDescendant(
    userId: number,
    candidateId: number | null,
    folderId: number,
  ): boolean {
    if (candidateId === null) return false;
    const row = this.sqlite
      .prepare(
        `WITH RECURSIVE descendants(id) AS (
           SELECT id FROM folders WHERE parent_id = ? AND user_id = ?
           UNION ALL
           SELECT folders.id FROM folders JOIN descendants ON folders.parent_id = descendants.id
           WHERE folders.user_id = ?
         )
         SELECT 1 FROM descendants WHERE id = ?`,
      )
      .get(folderId, userId, userId, candidateId);
    return row !== undefined;
  }

  listFeeds(userId: number): Feed[] {
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
                SUM(CASE WHEN articles.id IS NOT NULL AND articles.is_read = 0 AND ${visibleClause} THEN 1 ELSE 0 END) AS unreadCount,
                SUM(CASE WHEN articles.id IS NOT NULL AND ${visibleClause} THEN 1 ELSE 0 END) AS totalCount
         FROM feeds
         LEFT JOIN articles ON articles.feed_id = feeds.id
         WHERE feeds.user_id = ?
         GROUP BY feeds.id
         ORDER BY feeds.title COLLATE NOCASE`,
      )
      .all(userId) as Row[];
    return rows.map(mapFeed);
  }

  getFeed(userId: number, id: number): Feed | null {
    return this.listFeeds(userId).find((feed) => feed.id === id) ?? null;
  }

  createFeed(
    userId: number,
    input: {
      feedUrl: string;
      title?: string;
      siteUrl?: string | null;
      folderId?: number | null;
      paused?: boolean;
    },
  ): Feed {
    if (input.folderId && !this.getFolder(userId, input.folderId)) {
      throw new Error("The selected folder or feed does not exist");
    }
    const timestamp = now();
    const feedUrl = new URL(input.feedUrl).toString();
    const result = this.sqlite
      .prepare(
        `INSERT INTO feeds (
           user_id, folder_id, title, feed_url, site_url, paused, next_poll_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        userId,
        input.folderId ?? null,
        input.title?.trim() || feedUrl,
        feedUrl,
        input.siteUrl ?? null,
        input.paused ? 1 : 0,
        timestamp,
        timestamp,
        timestamp,
      );
    return this.getFeed(userId, Number(result.lastInsertRowid)) as Feed;
  }

  updateFeed(
    userId: number,
    id: number,
    input: {
      title?: string;
      feedUrl?: string;
      siteUrl?: string | null;
      folderId?: number | null;
      paused?: boolean;
    },
  ): Feed | null {
    const existing = this.getFeed(userId, id);
    if (!existing) return null;
    if (input.folderId && !this.getFolder(userId, input.folderId)) {
      throw new Error("The selected folder or feed does not exist");
    }
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
         WHERE id = ? AND user_id = ?`,
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
        userId,
      );
    if (input.folderId !== undefined && input.folderId !== existing.folderId) {
      const articles = this.sqlite
        .prepare("SELECT id FROM articles WHERE feed_id = ?")
        .all(id) as Array<{ id: number }>;
      for (const article of articles) this.recomputeRulesForArticle(article.id);
    }
    return this.getFeed(userId, id);
  }

  deleteFeed(userId: number, id: number): boolean {
    return (
      this.sqlite.prepare("DELETE FROM feeds WHERE id = ? AND user_id = ?").run(id, userId)
        .changes > 0
    );
  }

  getFeedRecord(id: number): FeedRecord | null {
    const row = this.sqlite
      .prepare(
        `SELECT feeds.id, feeds.folder_id AS folderId, feeds.title,
                feeds.feed_url AS feedUrl, feeds.site_url AS siteUrl, feeds.paused,
                feeds.etag, feeds.last_modified AS lastModified,
                settings.poll_interval_minutes AS pollIntervalMinutes
         FROM feeds
         JOIN settings ON settings.user_id = feeds.user_id
         WHERE feeds.id = ?`,
      )
      .get(id) as Row | undefined;
    return row ? mapFeedRecord(row) : null;
  }

  getRefreshCandidates(ids?: number[]): FeedRecord[] {
    let rows: Row[];
    if (ids) {
      if (ids.length === 0) return [];
      const placeholders = ids.map(() => "?").join(", ");
      rows = this.sqlite
        .prepare(
          `SELECT feeds.id, feeds.folder_id AS folderId, feeds.title,
                  feeds.feed_url AS feedUrl, feeds.site_url AS siteUrl, feeds.paused,
                  feeds.etag, feeds.last_modified AS lastModified,
                  settings.poll_interval_minutes AS pollIntervalMinutes
           FROM feeds
           JOIN settings ON settings.user_id = feeds.user_id
           WHERE feeds.id IN (${placeholders})`,
        )
        .all(...ids) as Row[];
    } else {
      rows = this.sqlite
        .prepare(
          `SELECT feeds.id, feeds.folder_id AS folderId, feeds.title,
                  feeds.feed_url AS feedUrl, feeds.site_url AS siteUrl, feeds.paused,
                  feeds.etag, feeds.last_modified AS lastModified,
                  settings.poll_interval_minutes AS pollIntervalMinutes
           FROM feeds
           JOIN settings ON settings.user_id = feeds.user_id
           WHERE feeds.paused = 0`,
        )
        .all() as Row[];
    }
    return rows.map(mapFeedRecord);
  }

  getUserRefreshFeedIds(userId: number, requestedIds?: number[]): number[] {
    if (requestedIds) {
      if (requestedIds.length === 0) return [];
      const placeholders = requestedIds.map(() => "?").join(", ");
      const rows = this.sqlite
        .prepare(`SELECT id FROM feeds WHERE user_id = ? AND id IN (${placeholders})`)
        .all(userId, ...requestedIds) as Array<{ id: number }>;
      return rows.map((row) => row.id);
    }
    const rows = this.sqlite
      .prepare("SELECT id FROM feeds WHERE user_id = ? AND paused = 0")
      .all(userId) as Array<{ id: number }>;
    return rows.map((row) => row.id);
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
  ): void {
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
    const ruleArticleIds = new Set<number>();
    const complete = this.sqlite.transaction(() => {
      if (parsed) {
        this.sqlite
          .prepare(
            `UPDATE feeds
             SET title = CASE WHEN title = feed_url THEN ? ELSE title END,
                 site_url = COALESCE(?, site_url), updated_at = ?
             WHERE id = ?`,
          )
          .run(parsed.title, parsed.siteUrl, now(), id);
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
              existing.publishedAt !== article.publishedAt ||
              existing.summary !== article.summary ||
              existing.mediaJson !== mediaJson ||
              (media !== null && existing.imageUrl !== article.imageUrl);
            if (!changed) continue;
            const articleId = Number(existing.id);
            update.run(
              article.title,
              article.url,
              article.author,
              article.publishedAt,
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
          const result = insert.run(
            id,
            article.externalId,
            article.title,
            article.url,
            article.author,
            article.publishedAt,
            now(),
            article.summary,
            article.imageUrl,
            mediaJson,
            article.feedContentHtml,
            extractionStatus,
          );
          const articleId = Number(result.lastInsertRowid);
          ruleArticleIds.add(articleId);
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

  getBootstrap(userId: number): Omit<BootstrapData, "aiSettings"> {
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
      folders: this.listFolders(userId),
      feeds: this.listFeeds(userId),
      settings: this.getSettings(userId),
      counts: {
        unread: Number(counts.unread ?? 0),
        starred: Number(counts.starred ?? 0),
        all: Number(counts.allCount ?? 0),
      },
    };
  }

  listArticles(userId: number, query: ArticleQuery): Article[] {
    return this.listArticlePage(userId, query).articles;
  }

  listArticlePage(userId: number, query: ArticleQuery): ArticlePage {
    const where = ["feeds.user_id = ?", visibleClause];
    const values: Array<string | number> = [userId];
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
             SELECT id FROM folders WHERE id = ? AND user_id = ?
             UNION ALL
             SELECT folders.id FROM folders JOIN folder_tree ON folders.parent_id = folder_tree.id
             WHERE folders.user_id = ?
           ) SELECT id FROM folder_tree
         )`,
      );
      values.push(query.folderId, userId, userId);
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
    const limit = Math.max(1, Math.min(query.limit ?? 200, 500));
    const cursor = query.cursor ? decodeArticleCursor(query.cursor) : new Map();
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
    };
  }

  getArticle(userId: number, id: number): Article | null {
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
                articles.image_url AS imageUrl,
                articles.media_json AS mediaJson,
                articles.feed_content_html AS feedContentHtml,
                articles.content_html AS contentHtml,
                articles.content_source AS contentSource,
                articles.extraction_status AS extractionStatus,
                articles.extraction_error AS extractionError,
                article_ai_summaries.summary_text AS aiSummaryText,
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

  getArticleForAiSummary(userId: number, id: number): AiArticleRecord | null {
    const row = this.sqlite
      .prepare(
        `SELECT articles.id,
                articles.content_revision AS revision,
                articles.title,
                articles.url,
                articles.author,
                articles.content_html AS contentHtml,
                articles.feed_content_html AS feedContentHtml,
                articles.summary AS excerpt,
                article_ai_summaries.source_revision AS aiSummarySourceRevision,
                article_ai_summaries.prompt_version AS aiSummaryPromptVersion,
                article_ai_summaries.source_kind AS aiSummarySourceKind,
                article_ai_summaries.provider AS aiSummaryProvider,
                article_ai_summaries.model AS aiSummaryModel,
                article_ai_summaries.summary_text AS aiSummaryText,
                article_ai_summaries.input_tokens AS aiSummaryInputTokens,
                article_ai_summaries.output_tokens AS aiSummaryOutputTokens,
                article_ai_summaries.generated_at AS aiSummaryGeneratedAt
         FROM articles
         JOIN feeds ON feeds.id = articles.feed_id
         LEFT JOIN article_ai_summaries
           ON article_ai_summaries.article_id = articles.id
          AND article_ai_summaries.source_revision = articles.content_revision
         WHERE articles.id = ? AND feeds.user_id = ?`,
      )
      .get(id, userId) as Row | undefined;
    if (!row) return null;
    return {
      id: Number(row.id),
      revision: Number(row.revision),
      title: String(row.title),
      url: row.url === null ? null : String(row.url),
      author: row.author === null ? null : String(row.author),
      contentHtml: row.contentHtml === null ? null : String(row.contentHtml),
      feedContentHtml: row.feedContentHtml === null ? null : String(row.feedContentHtml),
      excerpt: String(row.excerpt),
      currentSummary: mapStoredArticleAiSummary(row),
    };
  }

  getArticleAiSummary(userId: number, id: number): StoredArticleAiSummary | null {
    const row = this.sqlite
      .prepare(
        `SELECT article_ai_summaries.source_revision AS aiSummarySourceRevision,
                article_ai_summaries.prompt_version AS aiSummaryPromptVersion,
                article_ai_summaries.source_kind AS aiSummarySourceKind,
                article_ai_summaries.provider AS aiSummaryProvider,
                article_ai_summaries.model AS aiSummaryModel,
                article_ai_summaries.summary_text AS aiSummaryText,
                article_ai_summaries.input_tokens AS aiSummaryInputTokens,
                article_ai_summaries.output_tokens AS aiSummaryOutputTokens,
                article_ai_summaries.generated_at AS aiSummaryGeneratedAt
         FROM article_ai_summaries
         JOIN articles ON articles.id = article_ai_summaries.article_id
         JOIN feeds ON feeds.id = articles.feed_id
         WHERE article_ai_summaries.article_id = ?
           AND article_ai_summaries.source_revision = articles.content_revision
           AND feeds.user_id = ?`,
      )
      .get(id, userId) as Row | undefined;
    return row ? mapStoredArticleAiSummary(row) : null;
  }

  saveArticleAiSummary(
    userId: number,
    id: number,
    sourceRevision: number,
    input: {
      promptVersion: number;
      sourceKind: AiArticleSourceKind;
      provider: AiProvider;
      model: string;
      text: string;
      usage: AiUsage;
    },
  ): StoredArticleAiSummary | null {
    const save = this.sqlite.transaction(() => {
      const current = this.sqlite
        .prepare(
          `SELECT articles.content_revision AS revision
           FROM articles JOIN feeds ON feeds.id = articles.feed_id
           WHERE articles.id = ? AND feeds.user_id = ?`,
        )
        .get(id, userId) as { revision: number } | undefined;
      if (!current || current.revision !== sourceRevision) return null;
      this.sqlite
        .prepare(
          `INSERT INTO article_ai_summaries (
             article_id, source_revision, prompt_version, source_kind, provider, model,
             summary_text, input_tokens, output_tokens, generated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(article_id) DO UPDATE SET
             source_revision = excluded.source_revision,
             prompt_version = excluded.prompt_version,
             source_kind = excluded.source_kind,
             provider = excluded.provider,
             model = excluded.model,
             summary_text = excluded.summary_text,
             input_tokens = excluded.input_tokens,
             output_tokens = excluded.output_tokens,
             generated_at = excluded.generated_at`,
        )
        .run(
          id,
          sourceRevision,
          input.promptVersion,
          input.sourceKind,
          input.provider,
          input.model,
          input.text,
          input.usage.inputTokens,
          input.usage.outputTokens,
          now(),
        );
      return this.getArticleAiSummary(userId, id);
    });
    return save();
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

  listRules(userId: number): Rule[] {
    const rows = this.sqlite
      .prepare(
        `SELECT id, name, feed_id AS feedId, folder_id AS folderId,
                conditions_json AS conditionsJson, condition_operator AS conditionOperator, action,
                enabled, matched_count AS matchedCount, created_at AS createdAt, updated_at AS updatedAt
         FROM rules WHERE user_id = ? ORDER BY created_at DESC, id DESC`,
      )
      .all(userId) as Row[];
    return rows.map(mapRule);
  }

  getRule(userId: number, id: number): Rule | null {
    return this.listRules(userId).find((rule) => rule.id === id) ?? null;
  }

  createRule(
    userId: number,
    input: {
      name: string;
      feedId?: number | null;
      folderId?: number | null;
      conditions: RuleCondition[];
      conditionOperator: RuleConditionOperator;
      action: RuleAction;
      enabled?: boolean;
    },
  ): Rule {
    this.assertRuleScope(userId, input.feedId, input.folderId);
    const timestamp = now();
    const result = this.sqlite
      .prepare(
        `INSERT INTO rules (
           user_id, name, feed_id, folder_id, conditions_json, condition_operator, action, enabled,
           matched_count, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      )
      .run(
        userId,
        input.name,
        input.feedId ?? null,
        input.folderId ?? null,
        JSON.stringify(input.conditions),
        input.conditionOperator,
        input.action,
        (input.enabled ?? true) ? 1 : 0,
        timestamp,
        timestamp,
      );
    const id = Number(result.lastInsertRowid);
    this.reapplyRule(id);
    return this.getRule(userId, id) as Rule;
  }

  updateRule(
    userId: number,
    id: number,
    input: Partial<{
      name: string;
      feedId: number | null;
      folderId: number | null;
      conditions: RuleCondition[];
      conditionOperator: RuleConditionOperator;
      action: RuleAction;
      enabled: boolean;
    }>,
  ): Rule | null {
    const existing = this.getRule(userId, id);
    if (!existing) return null;
    const feedId = input.feedId === undefined ? existing.feedId : input.feedId;
    const folderId = input.folderId === undefined ? existing.folderId : input.folderId;
    this.assertRuleScope(userId, feedId, folderId);
    this.sqlite
      .prepare(
        `UPDATE rules
         SET name = ?, feed_id = ?, folder_id = ?, conditions_json = ?, condition_operator = ?,
             action = ?, enabled = ?, updated_at = ?
         WHERE id = ? AND user_id = ?`,
      )
      .run(
        input.name ?? existing.name,
        input.feedId === undefined ? existing.feedId : input.feedId,
        input.folderId === undefined ? existing.folderId : input.folderId,
        JSON.stringify(input.conditions ?? existing.conditions),
        input.conditionOperator ?? existing.conditionOperator,
        input.action ?? existing.action,
        (input.enabled ?? existing.enabled) ? 1 : 0,
        now(),
        id,
        userId,
      );
    this.reapplyRule(id);
    return this.getRule(userId, id);
  }

  deleteRule(userId: number, id: number): boolean {
    return (
      this.sqlite.prepare("DELETE FROM rules WHERE id = ? AND user_id = ?").run(id, userId)
        .changes > 0
    );
  }

  private assertRuleScope(
    userId: number,
    feedId: number | null | undefined,
    folderId: number | null | undefined,
  ): void {
    if (feedId && !this.getFeed(userId, feedId)) {
      throw new Error("The selected folder or feed does not exist");
    }
    if (folderId && !this.getFolder(userId, folderId)) {
      throw new Error("The selected folder or feed does not exist");
    }
  }

  private reapplyRule(ruleId: number): void {
    const run = this.sqlite.transaction(() => {
      this.sqlite.prepare("DELETE FROM article_rule_matches WHERE rule_id = ?").run(ruleId);
      this.sqlite.prepare("UPDATE rules SET matched_count = 0 WHERE id = ?").run(ruleId);
      const rows = this.sqlite
        .prepare(
          `SELECT articles.id
           FROM articles
           JOIN feeds ON feeds.id = articles.feed_id
           JOIN rules ON rules.user_id = feeds.user_id
           WHERE rules.id = ?`,
        )
        .all(ruleId) as Array<{ id: number }>;
      for (const row of rows) this.applyRuleToArticle(ruleId, row.id);
    });
    run();
  }

  recomputeRulesForArticle(articleId: number): void {
    this.sqlite.prepare("DELETE FROM article_rule_matches WHERE article_id = ?").run(articleId);
    const rules = this.sqlite
      .prepare(
        `SELECT rules.id
         FROM rules
         JOIN feeds ON feeds.user_id = rules.user_id
         JOIN articles ON articles.feed_id = feeds.id
         WHERE articles.id = ?`,
      )
      .all(articleId) as Array<{ id: number }>;
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

  private recomputeRulesForAllArticles(userId: number): void {
    const articles = this.sqlite
      .prepare(
        `SELECT articles.id
         FROM articles JOIN feeds ON feeds.id = articles.feed_id
         WHERE feeds.user_id = ?`,
      )
      .all(userId) as Array<{ id: number }>;
    for (const article of articles) this.recomputeRulesForArticle(article.id);
  }

  private applyRuleToArticle(ruleId: number, articleId: number): void {
    const rule = this.sqlite.prepare("SELECT * FROM rules WHERE id = ?").get(ruleId) as
      | Row
      | undefined;
    const article = this.sqlite
      .prepare(
        `SELECT articles.*, feeds.folder_id, feeds.user_id AS userId
         FROM articles JOIN feeds ON feeds.id = articles.feed_id
         WHERE articles.id = ?`,
      )
      .get(articleId) as Row | undefined;
    if (!rule || !article) return;
    if (Number(rule.user_id) !== Number(article.userId)) return;
    if (rule.feed_id !== null && Number(rule.feed_id) !== Number(article.feed_id)) return;
    if (rule.folder_id !== null) {
      const inScope = this.sqlite
        .prepare(
          `WITH RECURSIVE folder_tree(id) AS (
             SELECT id FROM folders WHERE id = ? AND user_id = ?
             UNION ALL
             SELECT folders.id FROM folders JOIN folder_tree ON folders.parent_id = folder_tree.id
             WHERE folders.user_id = ?
           )
           SELECT 1 FROM folder_tree WHERE id = ?`,
        )
        .get(rule.folder_id, rule.user_id, rule.user_id, article.folder_id);
      if (!inScope) return;
    }
    const mediaText = articleMediaRuleText(parseArticleMedia(article.media_json));
    const values: Record<RuleField, string> = {
      title: String(article.title ?? ""),
      author: String(article.author ?? ""),
      summary: String(article.summary ?? ""),
      content: `${String(article.feed_content_html ?? "")} ${String(article.content_html ?? "")}`,
      media: mediaText,
      any: `${String(article.title ?? "")} ${String(article.author ?? "")} ${String(
        article.summary ?? "",
      )} ${String(article.feed_content_html ?? "")} ${String(
        article.content_html ?? "",
      )} ${mediaText}`,
    };
    const conditions = JSON.parse(String(rule.conditions_json)) as RuleCondition[];
    const matchesCondition = (condition: RuleCondition) =>
      values[condition.field].toLocaleLowerCase().includes(condition.pattern.toLocaleLowerCase());
    const matched =
      rule.condition_operator === "and"
        ? conditions.every(matchesCondition)
        : conditions.some(matchesCondition);
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
        `SELECT id, url FROM articles WHERE extraction_status = 'pending'
         ORDER BY discovered_at LIMIT ?`,
      )
      .all(limit) as Row[];
    return rows.map((row) => ({
      id: Number(row.id),
      url: row.url === null ? null : String(row.url),
    }));
  }

  getExtractionRecord(id: number): ExtractionRecord | null {
    const row = this.sqlite
      .prepare(`SELECT id, url FROM articles WHERE id = ? AND extraction_status = 'pending'`)
      .get(id) as Row | undefined;
    if (!row) return null;
    return {
      id: Number(row.id),
      url: row.url === null ? null : String(row.url),
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

  requestExtraction(userId: number, id: number): boolean {
    return (
      this.sqlite
        .prepare(
          `UPDATE articles
           SET extraction_status = 'pending', extraction_error = NULL
           WHERE id = ? AND extraction_status != 'processing'
             AND NOT (extraction_status = 'complete' AND content_html IS NOT NULL)
             AND feed_id IN (SELECT id FROM feeds WHERE user_id = ?)`,
        )
        .run(id, userId).changes > 0
    );
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
    const updated = this.sqlite
      .prepare(
        `UPDATE articles
         SET content_html = ?, image_url = COALESCE(?, image_url), content_source = ?,
             extraction_status = ?, extraction_error = ?,
             content_revision = content_revision +
               CASE WHEN ? = 'complete'
                          AND (content_html IS NOT ? OR content_source IS NOT ?)
                    THEN 1 ELSE 0 END
         WHERE id = ? AND extraction_status = 'processing'`,
      )
      .run(
        input.contentHtml,
        input.imageUrl,
        input.contentSource,
        input.status,
        input.error,
        input.status,
        input.contentHtml,
        input.contentSource,
        id,
      ).changes;
    if (updated > 0) this.recomputeRulesForArticle(id);
  }

  listOpmlFolders(userId: number): Array<{ id: number; name: string; parentId: number | null }> {
    return this.sqlite
      .prepare(
        `SELECT id, name, parent_id AS parentId
         FROM folders WHERE user_id = ? ORDER BY position, name COLLATE NOCASE`,
      )
      .all(userId) as Array<{ id: number; name: string; parentId: number | null }>;
  }

  listOpmlFeeds(userId: number): Array<{
    title: string;
    feedUrl: string;
    siteUrl: string | null;
    folderId: number | null;
  }> {
    return this.sqlite
      .prepare(
        `SELECT title, feed_url AS feedUrl, site_url AS siteUrl, folder_id AS folderId
         FROM feeds WHERE user_id = ? ORDER BY title COLLATE NOCASE`,
      )
      .all(userId) as Array<{
      title: string;
      feedUrl: string;
      siteUrl: string | null;
      folderId: number | null;
    }>;
  }
}

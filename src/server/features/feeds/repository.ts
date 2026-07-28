import type Sqlite from "better-sqlite3";
import type {
  Feed,
  FeedErrorKind,
  FeedHealthStatus,
  WebFeedConfig,
} from "../../../shared/types.js";
import type { FolderRepository } from "../folders/repository.js";
import {
  type FeedRecord,
  feedPollIntervalSql,
  feedRecordColumns,
  mapFeed,
  mapFeedRecord,
  now,
  type ParsedFeed,
  type Row,
  visibleClause,
} from "../shared.js";

export class FeedRepository {
  constructor(
    private readonly sqlite: Sqlite.Database,
    private readonly folders: FolderRepository,
  ) {}

  listFeeds(userId: number): Feed[] {
    return this.selectFeeds(userId);
  }

  private selectFeeds(userId: number, feedId?: number): Feed[] {
    const feedIdClause = feedId === undefined ? "" : "AND feeds.id = ?";
    const rows = this.sqlite
      .prepare(
        `SELECT feeds.id,
                feeds.folder_id AS folderId,
                feeds.title,
                feeds.feed_url AS feedUrl,
                feeds.site_url AS siteUrl,
                feeds.source_kind AS sourceKind,
                feeds.health_status AS healthStatus,
                feeds.last_error_kind AS lastErrorKind,
                web_feed_configs.last_match_count AS lastMatchCount,
                feeds.created_at AS createdAt,
                ${feedPollIntervalSql} AS pollIntervalMinutes,
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
         JOIN settings ON settings.user_id = feeds.user_id
         LEFT JOIN web_feed_configs ON web_feed_configs.feed_id = feeds.id
         LEFT JOIN articles ON articles.feed_id = feeds.id
         WHERE feeds.user_id = ?
           ${feedIdClause}
         GROUP BY feeds.id
         ORDER BY feeds.title COLLATE NOCASE`,
      )
      .all(...(feedId === undefined ? [userId] : [userId, feedId])) as Row[];
    return rows.map(mapFeed);
  }

  getFeed(userId: number, id: number): Feed | null {
    return this.selectFeeds(userId, id)[0] ?? null;
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
    this.folders.assertFolderExists(userId, input.folderId);
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
    this.folders.assertFolderExists(userId, input.folderId);
    const feedUrl = input.feedUrl ? new URL(input.feedUrl).toString() : existing.feedUrl;
    if (existing.sourceKind === "web" && feedUrl !== existing.feedUrl) {
      throw new Error("Web feed URLs can only be changed by repairing the page selection");
    }
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
        `SELECT ${feedRecordColumns}
         FROM feeds
         JOIN settings ON settings.user_id = feeds.user_id
         LEFT JOIN web_feed_configs ON web_feed_configs.feed_id = feeds.id
         WHERE feeds.id = ?`,
      )
      .get(id) as Row | undefined;
    return row ? mapFeedRecord(row) : null;
  }

  getWebFeedConfig(userId: number, id: number): WebFeedConfig | null {
    const row = this.sqlite
      .prepare(
        `SELECT web_feed_configs.config_json AS configJson
         FROM web_feed_configs
         JOIN feeds ON feeds.id = web_feed_configs.feed_id
         WHERE web_feed_configs.feed_id = ? AND feeds.user_id = ? AND feeds.source_kind = 'web'`,
      )
      .get(id, userId) as { configJson: string } | undefined;
    return row ? (JSON.parse(row.configJson) as WebFeedConfig) : null;
  }

  getRefreshCandidates(ids?: number[]): FeedRecord[] {
    let rows: Row[];
    if (ids) {
      if (ids.length === 0) return [];
      const placeholders = ids.map(() => "?").join(", ");
      rows = this.sqlite
        .prepare(
          `SELECT ${feedRecordColumns}
           FROM feeds
           JOIN settings ON settings.user_id = feeds.user_id
           LEFT JOIN web_feed_configs ON web_feed_configs.feed_id = feeds.id
           WHERE feeds.id IN (${placeholders})`,
        )
        .all(...ids) as Row[];
    } else {
      rows = this.sqlite
        .prepare(
          `SELECT ${feedRecordColumns}
           FROM feeds
           JOIN settings ON settings.user_id = feeds.user_id
           LEFT JOIN web_feed_configs ON web_feed_configs.feed_id = feeds.id
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
      .prepare("UPDATE feeds SET refreshing = 1, last_attempt_at = ? WHERE id = ?")
      .run(now(), id);
  }

  createWebFeedRecord(
    userId: number,
    input: {
      title: string;
      pageUrl: string;
      folderId: number | null;
      config: WebFeedConfig;
      parsed: ParsedFeed;
    },
  ): number {
    const timestamp = now();
    const result = this.sqlite
      .prepare(
        `INSERT INTO feeds (
           user_id, folder_id, title, feed_url, site_url, source_kind, paused, refreshing,
           last_attempt_at, next_poll_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, 'web', 0, 1, ?, ?, ?, ?)`,
      )
      .run(
        userId,
        input.folderId,
        input.title.trim() || input.parsed.title.trim() || input.pageUrl,
        input.pageUrl,
        input.parsed.siteUrl ?? input.pageUrl,
        timestamp,
        timestamp,
        timestamp,
        timestamp,
      );
    const feedId = Number(result.lastInsertRowid);
    this.sqlite
      .prepare(
        `INSERT INTO web_feed_configs (
           feed_id, config_json, selection_revision, last_match_count, created_at, updated_at
         ) VALUES (?, ?, 1, ?, ?, ?)`,
      )
      .run(
        feedId,
        JSON.stringify(input.config),
        input.parsed.articles.length,
        timestamp,
        timestamp,
      );
    return feedId;
  }

  updateWebFeedSelectionRecord(id: number, config: WebFeedConfig, parsed: ParsedFeed): void {
    const timestamp = now();
    const changed = this.sqlite
      .prepare(
        `UPDATE web_feed_configs
         SET config_json = ?, selection_revision = selection_revision + 1,
             last_match_count = ?, updated_at = ?
         WHERE feed_id = ?`,
      )
      .run(JSON.stringify(config), parsed.articles.length, timestamp, id).changes;
    if (changed === 0) throw new Error(`Web feed ${id} is missing its page selection`);
    this.sqlite
      .prepare(
        `UPDATE feeds
         SET feed_url = ?, site_url = ?, refreshing = 1, last_attempt_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(config.pageUrl, parsed.siteUrl ?? config.pageUrl, timestamp, timestamp, id);
  }

  selectionRevisionMatches(id: number, expectedRevision: number): boolean {
    const selection = this.sqlite
      .prepare("SELECT selection_revision AS revision FROM web_feed_configs WHERE feed_id = ?")
      .get(id) as { revision: number } | undefined;
    return selection?.revision === expectedRevision;
  }

  updateFromParsedFeed(id: number, parsed: ParsedFeed): void {
    this.sqlite
      .prepare(
        `UPDATE feeds
         SET title = CASE WHEN title = feed_url THEN ? ELSE title END,
             site_url = COALESCE(?, site_url), updated_at = ?
         WHERE id = ?`,
      )
      .run(parsed.title, parsed.siteUrl, now(), id);
  }

  completeSuccessfulRefresh(
    id: number,
    input: {
      httpStatus: number;
      etag: string | null;
      lastModified: string | null;
      pollIntervalMinutes: number;
      webMatchCount?: number;
    },
  ): void {
    const completedAt = now();
    const nextPollAt = new Date(
      Date.parse(completedAt) + input.pollIntervalMinutes * 60_000,
    ).toISOString();
    this.sqlite
      .prepare(
        `UPDATE feeds
         SET refreshing = 0, health_status = 'healthy', last_success_at = ?,
             last_http_status = ?, last_error_kind = NULL, last_error = NULL,
             etag = COALESCE(?, etag), last_modified = COALESCE(?, last_modified),
             next_poll_at = ?
         WHERE id = ?`,
      )
      .run(completedAt, input.httpStatus, input.etag, input.lastModified, nextPollAt, id);
    if (input.webMatchCount !== undefined) {
      this.sqlite
        .prepare(
          `UPDATE web_feed_configs
           SET last_match_count = ?, updated_at = ?
           WHERE feed_id = ?`,
        )
        .run(input.webMatchCount, completedAt, id);
    }
  }

  markFeedFailure(
    id: number,
    input: {
      httpStatus: number | null;
      error: string;
      errorKind: FeedErrorKind;
      healthStatus: FeedHealthStatus;
      retryMinutes: number;
      expectedSelectionRevision?: number;
    },
  ): void {
    const nextPollAt = new Date(Date.now() + input.retryMinutes * 60_000).toISOString();
    const fail = this.sqlite.transaction(() => {
      if (input.expectedSelectionRevision !== undefined) {
        const selection = this.sqlite
          .prepare("SELECT selection_revision AS revision FROM web_feed_configs WHERE feed_id = ?")
          .get(id) as { revision: number } | undefined;
        if (!selection || selection.revision !== input.expectedSelectionRevision) return;
      }
      this.sqlite
        .prepare(
          `UPDATE feeds
           SET refreshing = 0, health_status = ?, last_http_status = ?, last_error_kind = ?,
               last_error = ?, next_poll_at = ?
           WHERE id = ?`,
        )
        .run(input.healthStatus, input.httpStatus, input.errorKind, input.error, nextPollAt, id);
      if (input.errorKind === "selection_broken") {
        this.sqlite
          .prepare(
            "UPDATE web_feed_configs SET last_match_count = 0, updated_at = ? WHERE feed_id = ?",
          )
          .run(now(), id);
      }
    });
    fail();
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
         FROM feeds
         WHERE user_id = ? AND source_kind = 'published'
         ORDER BY title COLLATE NOCASE`,
      )
      .all(userId) as Array<{
      title: string;
      feedUrl: string;
      siteUrl: string | null;
      folderId: number | null;
    }>;
  }
}

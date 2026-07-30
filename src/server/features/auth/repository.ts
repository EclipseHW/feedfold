import type Sqlite from "better-sqlite3";
import {
  DEFAULT_ARTICLE_SUMMARY_PROMPT,
  DEFAULT_ARTICLE_TRANSLATION_PROMPT,
  DEFAULT_CUSTOM_PROMPTS,
} from "../../../shared/ai-prompts.js";
import type { SessionUser } from "../../../shared/types.js";

const LEGACY_OWNER = "__legacy_owner__";

export interface UserWithPassword extends SessionUser {
  passwordHash: string;
}

export interface StoredSession {
  tokenHash: string;
  createdAt: string;
  expiresAt: string;
}

export class AuthRepository {
  constructor(private readonly sqlite: Sqlite.Database) {}

  deleteExpiredSessions(at: string): void {
    this.sqlite.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(at);
  }

  registerUserWithSession(
    username: string,
    passwordHash: string,
    defaultPollIntervalMinutes: number,
    session: StoredSession,
  ): SessionUser | null {
    return this.sqlite.transaction(() => {
      const existing = this.sqlite
        .prepare("SELECT id FROM users WHERE username = ? COLLATE NOCASE")
        .get(username);
      if (existing) return null;

      const legacy = this.sqlite
        .prepare("SELECT id FROM users WHERE username = ? COLLATE NOCASE")
        .get(LEGACY_OWNER) as { id: number } | undefined;
      let user: SessionUser;
      if (legacy) {
        this.sqlite
          .prepare(
            `UPDATE users
             SET username = ?, password_hash = ?, enabled = 1, updated_at = ?
             WHERE id = ?`,
          )
          .run(username, passwordHash, session.createdAt, legacy.id);
        user = { id: legacy.id, username };
      } else {
        const result = this.sqlite
          .prepare(
            `INSERT INTO users (username, password_hash, enabled, created_at, updated_at)
             VALUES (?, ?, 1, ?, ?)`,
          )
          .run(username, passwordHash, session.createdAt, session.createdAt);
        const userId = Number(result.lastInsertRowid);
        this.sqlite
          .prepare(
            `INSERT INTO settings (
               user_id, poll_interval_minutes, single_key_shortcuts, mark_read_on_scroll,
               translation_language, summary_prompt, translation_prompt, custom_prompts_json
             ) VALUES (?, ?, 1, 1, 'English', ?, ?, ?)`,
          )
          .run(
            userId,
            defaultPollIntervalMinutes,
            DEFAULT_ARTICLE_SUMMARY_PROMPT,
            DEFAULT_ARTICLE_TRANSLATION_PROMPT,
            JSON.stringify(DEFAULT_CUSTOM_PROMPTS),
          );
        user = { id: userId, username };
      }
      this.insertSession(user.id, session);
      return user;
    })();
  }

  findEnabledUser(username: string): UserWithPassword | null {
    const row = this.sqlite
      .prepare(
        `SELECT id, username, password_hash AS passwordHash
         FROM users WHERE username = ? COLLATE NOCASE AND enabled = 1`,
      )
      .get(username) as UserWithPassword | undefined;
    return row ?? null;
  }

  insertSession(userId: number, session: StoredSession): void {
    this.sqlite
      .prepare(
        `INSERT INTO sessions (token_hash, user_id, created_at, expires_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(session.tokenHash, userId, session.createdAt, session.expiresAt);
  }

  userForTokenHash(hash: string, at: string): SessionUser | null {
    const row = this.sqlite
      .prepare(
        `SELECT users.id, users.username
         FROM sessions
         JOIN users ON users.id = sessions.user_id
         WHERE sessions.token_hash = ? AND sessions.expires_at > ? AND users.enabled = 1`,
      )
      .get(hash, at) as SessionUser | undefined;
    return row ?? null;
  }

  deleteSession(hash: string): void {
    this.sqlite.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hash);
  }
}

import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { SessionUser } from "../shared/types.js";
import type { AppDatabase } from "./db.js";

const SESSION_COOKIE = "echovale_session";
const SESSION_SECONDS = 60 * 60 * 24 * 30;
const LEGACY_OWNER = "__legacy_owner__";

interface UserRow extends SessionUser {
  passwordHash: string;
}

export interface LoginSession {
  token: string;
  user: SessionUser;
}

function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const digest = scryptSync(password, salt, 64);
  return `scrypt$${salt.toString("base64url")}$${digest.toString("base64url")}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const [algorithm, saltValue, digestValue] = stored.split("$");
  if (algorithm !== "scrypt" || !saltValue || !digestValue) return false;
  const expected = Buffer.from(digestValue, "base64url");
  const actual = scryptSync(password, Buffer.from(saltValue, "base64url"), expected.length);
  return timingSafeEqual(actual, expected);
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

function now(): string {
  return new Date().toISOString();
}

export function sessionToken(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === SESSION_COOKIE) return value.join("=") || null;
  }
  return null;
}

export class AuthService {
  constructor(
    private readonly database: AppDatabase,
    private readonly defaultPollIntervalMinutes = 20,
  ) {
    this.database.sqlite.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now());
  }

  register(username: string, password: string): LoginSession | null {
    const trimmedUsername = username.trim();
    const register = this.database.sqlite.transaction(() => {
      const existing = this.database.sqlite
        .prepare("SELECT id FROM users WHERE username = ? COLLATE NOCASE")
        .get(trimmedUsername);
      if (existing) return null;

      const timestamp = now();
      const legacy = this.database.sqlite
        .prepare("SELECT id FROM users WHERE username = ? COLLATE NOCASE")
        .get(LEGACY_OWNER) as { id: number } | undefined;
      let user: SessionUser;
      if (legacy) {
        this.database.sqlite
          .prepare(
            `UPDATE users
             SET username = ?, password_hash = ?, enabled = 1, updated_at = ?
             WHERE id = ?`,
          )
          .run(trimmedUsername, hashPassword(password), timestamp, legacy.id);
        user = { id: legacy.id, username: trimmedUsername };
      } else {
        const result = this.database.sqlite
          .prepare(
            `INSERT INTO users (username, password_hash, enabled, created_at, updated_at)
             VALUES (?, ?, 1, ?, ?)`,
          )
          .run(trimmedUsername, hashPassword(password), timestamp, timestamp);
        const userId = Number(result.lastInsertRowid);
        this.database.sqlite
          .prepare(
            `INSERT INTO settings (
               user_id, poll_interval_minutes, single_key_shortcuts, mark_read_on_scroll,
               translation_language
             ) VALUES (?, ?, 1, 1, 'English')`,
          )
          .run(userId, this.defaultPollIntervalMinutes);
        user = { id: userId, username: trimmedUsername };
      }

      return this.createSession(user);
    });
    return register();
  }

  login(username: string, password: string): LoginSession | null {
    const row = this.database.sqlite
      .prepare(
        `SELECT id, username, password_hash AS passwordHash
         FROM users WHERE username = ? COLLATE NOCASE AND enabled = 1`,
      )
      .get(username.trim()) as UserRow | undefined;
    if (!row || !verifyPassword(password, row.passwordHash)) return null;

    return this.createSession({ id: row.id, username: row.username });
  }

  private createSession(user: SessionUser): LoginSession {
    const token = randomBytes(32).toString("base64url");
    const createdAt = now();
    const expiresAt = new Date(Date.now() + SESSION_SECONDS * 1_000).toISOString();
    this.database.sqlite
      .prepare(
        `INSERT INTO sessions (token_hash, user_id, created_at, expires_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(tokenHash(token), user.id, createdAt, expiresAt);
    return { token, user };
  }

  userForToken(token: string | null): SessionUser | null {
    if (!token) return null;
    const row = this.database.sqlite
      .prepare(
        `SELECT users.id, users.username
         FROM sessions
         JOIN users ON users.id = sessions.user_id
         WHERE sessions.token_hash = ? AND sessions.expires_at > ? AND users.enabled = 1`,
      )
      .get(tokenHash(token), now()) as SessionUser | undefined;
    return row ?? null;
  }

  endSession(token: string | null): void {
    if (!token) return;
    this.database.sqlite.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash(token));
  }

  sessionCookie(token: string, secure: boolean): string {
    return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_SECONDS}${secure ? "; Secure" : ""}`;
  }

  clearSessionCookie(secure: boolean): string {
    return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`;
  }
}

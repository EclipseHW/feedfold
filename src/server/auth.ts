import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { SessionUser } from "../shared/types.js";
import type { AppDatabase } from "./db.js";

const SESSION_COOKIE = "echovale_session";
const SESSION_SECONDS = 60 * 60 * 24 * 30;
const LEGACY_OWNER = "__legacy_owner__";

const accountSchema = z.object({
  username: z.string().trim().min(1).max(80),
  password: z.string().min(1).max(1_024),
});

export interface AccountCredentials {
  username: string;
  password: string;
}

interface UserRow extends SessionUser {
  passwordHash: string;
}

export interface LoginSession {
  token: string;
  user: SessionUser;
}

export function parseAccountCredentials(source: string | undefined): AccountCredentials[] {
  if (!source) {
    throw new Error(
      'ECHOVALE_ACCOUNTS must be a JSON array such as [{"username":"you","password":"secret"}]',
    );
  }

  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error("ECHOVALE_ACCOUNTS must be valid JSON");
  }

  const accounts = z.array(accountSchema).min(1).parse(value);
  const usernames = new Set<string>();
  for (const account of accounts) {
    const normalized = account.username.toLocaleLowerCase();
    if (normalized === LEGACY_OWNER) throw new Error("That account name is reserved");
    if (usernames.has(normalized)) {
      throw new Error(`ECHOVALE_ACCOUNTS contains duplicate username: ${account.username}`);
    }
    usernames.add(normalized);
  }
  return accounts;
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
    accounts: AccountCredentials[],
    defaultPollIntervalMinutes = 20,
  ) {
    this.configureAccounts(accounts, defaultPollIntervalMinutes);
  }

  private configureAccounts(
    accounts: AccountCredentials[],
    defaultPollIntervalMinutes: number,
  ): void {
    const timestamp = now();
    const run = this.database.sqlite.transaction(() => {
      this.database.sqlite.prepare("UPDATE users SET enabled = 0, updated_at = ?").run(timestamp);

      const legacy = this.database.sqlite
        .prepare("SELECT id FROM users WHERE username = ? COLLATE NOCASE")
        .get(LEGACY_OWNER) as { id: number } | undefined;
      let startIndex = 0;
      if (legacy) {
        const first = accounts[0];
        this.database.sqlite
          .prepare(
            `UPDATE users
             SET username = ?, password_hash = ?, enabled = 1, updated_at = ?
             WHERE id = ?`,
          )
          .run(first.username, hashPassword(first.password), timestamp, legacy.id);
        if (this.database.wasNewDatabase) {
          this.database.sqlite
            .prepare("UPDATE settings SET poll_interval_minutes = ? WHERE user_id = ?")
            .run(defaultPollIntervalMinutes, legacy.id);
        }
        startIndex = 1;
      }

      for (const account of accounts.slice(startIndex)) {
        const existing = this.database.sqlite
          .prepare(
            `SELECT id, username, password_hash AS passwordHash
             FROM users WHERE username = ? COLLATE NOCASE`,
          )
          .get(account.username) as UserRow | undefined;
        if (existing) {
          const passwordChanged = !verifyPassword(account.password, existing.passwordHash);
          this.database.sqlite
            .prepare(
              `UPDATE users
               SET username = ?, password_hash = ?, enabled = 1, updated_at = ?
               WHERE id = ?`,
            )
            .run(
              account.username,
              passwordChanged ? hashPassword(account.password) : existing.passwordHash,
              timestamp,
              existing.id,
            );
          if (passwordChanged) {
            this.database.sqlite.prepare("DELETE FROM sessions WHERE user_id = ?").run(existing.id);
          }
          continue;
        }

        const result = this.database.sqlite
          .prepare(
            `INSERT INTO users (username, password_hash, enabled, created_at, updated_at)
             VALUES (?, ?, 1, ?, ?)`,
          )
          .run(account.username, hashPassword(account.password), timestamp, timestamp);
        this.database.sqlite
          .prepare(
            `INSERT INTO settings (
               user_id, poll_interval_minutes, single_key_shortcuts, mark_read_on_scroll
             ) VALUES (?, ?, 1, 1)`,
          )
          .run(Number(result.lastInsertRowid), defaultPollIntervalMinutes);
      }

      this.database.sqlite
        .prepare(
          `DELETE FROM sessions
           WHERE expires_at <= ?
              OR user_id IN (SELECT id FROM users WHERE enabled = 0)`,
        )
        .run(timestamp);
    });
    run();
  }

  login(username: string, password: string): LoginSession | null {
    const row = this.database.sqlite
      .prepare(
        `SELECT id, username, password_hash AS passwordHash
         FROM users WHERE username = ? COLLATE NOCASE AND enabled = 1`,
      )
      .get(username.trim()) as UserRow | undefined;
    if (!row || !verifyPassword(password, row.passwordHash)) return null;

    const token = randomBytes(32).toString("base64url");
    const createdAt = now();
    const expiresAt = new Date(Date.now() + SESSION_SECONDS * 1_000).toISOString();
    this.database.sqlite
      .prepare(
        `INSERT INTO sessions (token_hash, user_id, created_at, expires_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(tokenHash(token), row.id, createdAt, expiresAt);
    return { token, user: { id: row.id, username: row.username } };
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

import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { normalizeFeedPollInterval, type SessionUser } from "../../../shared/types.js";
import type { AuthRepository, StoredSession } from "./repository.js";

const SESSION_COOKIE = "feedfold_session";
const SESSION_SECONDS = 60 * 60 * 24 * 30;
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
    private readonly repository: AuthRepository,
    private readonly defaultPollIntervalMinutes = 20,
  ) {
    this.repository.deleteExpiredSessions(now());
  }

  register(username: string, password: string): LoginSession | null {
    const trimmedUsername = username.trim();
    const token = randomBytes(32).toString("base64url");
    const storedSession = this.storedSession(token);
    const user = this.repository.registerUserWithSession(
      trimmedUsername,
      hashPassword(password),
      normalizeFeedPollInterval(this.defaultPollIntervalMinutes),
      storedSession,
    );
    return user ? { token, user } : null;
  }

  login(username: string, password: string): LoginSession | null {
    const row = this.repository.findEnabledUser(username.trim());
    if (!row || !verifyPassword(password, row.passwordHash)) return null;

    return this.createSession({ id: row.id, username: row.username });
  }

  private createSession(user: SessionUser): LoginSession {
    const token = randomBytes(32).toString("base64url");
    this.repository.insertSession(user.id, this.storedSession(token));
    return { token, user };
  }

  private storedSession(token: string): StoredSession {
    const createdAt = now();
    return {
      tokenHash: tokenHash(token),
      createdAt,
      expiresAt: new Date(Date.now() + SESSION_SECONDS * 1_000).toISOString(),
    };
  }

  userForToken(token: string | null): SessionUser | null {
    if (!token) return null;
    return this.repository.userForTokenHash(tokenHash(token), now());
  }

  endSession(token: string | null): void {
    if (!token) return;
    this.repository.deleteSession(tokenHash(token));
  }

  sessionCookie(token: string, secure: boolean): string {
    return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_SECONDS}${secure ? "; Secure" : ""}`;
  }

  clearSessionCookie(secure: boolean): string {
    return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`;
  }
}

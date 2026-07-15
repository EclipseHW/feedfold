import { LoaderCircle, LogIn, Rss } from "lucide-react";
import { type FormEvent, useState } from "react";
import type { SessionUser } from "../shared/types";
import { api, errorMessage } from "./api";

export function SessionLoading() {
  return (
    <main className="auth-page" aria-busy="true">
      <div className="session-loading" role="status">
        <span className="brand-mark" aria-hidden="true">
          <Rss size={17} />
        </span>
        <span>Opening Echovale</span>
      </div>
    </main>
  );
}

export function LoginPage({ onAuthenticated }: { onAuthenticated: (user: SessionUser) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      onAuthenticated(await api.login(username, password));
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="auth-page">
      <section className="login-panel" aria-labelledby="login-heading">
        <div className="login-brand">
          <span className="brand-mark" aria-hidden="true">
            <Rss size={17} />
          </span>
          <span>Echovale</span>
        </div>
        <div className="login-heading">
          <h1 id="login-heading">Sign in</h1>
          <p>Open your feeds, folders, and reading queue.</p>
        </div>
        <form className="login-form" onSubmit={submit}>
          <label className="field" htmlFor="login-username">
            <span>Username</span>
            <input
              id="login-username"
              name="username"
              type="text"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              required
              value={username}
              onChange={(event) => setUsername(event.target.value)}
            />
          </label>
          <label className="field" htmlFor="login-password">
            <span>Password</span>
            <input
              id="login-password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          {error ? (
            <div className="login-error" role="alert">
              {error}
            </div>
          ) : null}
          <button className="primary-button login-button" type="submit" disabled={submitting}>
            {submitting ? (
              <LoaderCircle className="spin" aria-hidden="true" size={16} />
            ) : (
              <LogIn aria-hidden="true" size={16} />
            )}
            {submitting ? "Signing in" : "Sign in"}
          </button>
        </form>
      </section>
    </main>
  );
}

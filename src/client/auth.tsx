import { LoaderCircle, LogIn, Rss, UserPlus } from "lucide-react";
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
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      onAuthenticated(
        mode === "login"
          ? await api.login(username, password)
          : await api.register(username, password),
      );
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSubmitting(false);
    }
  };

  const switchMode = () => {
    setMode((current) => (current === "login" ? "register" : "login"));
    setPassword("");
    setError(null);
  };

  const registering = mode === "register";
  const actionLabel = registering ? "Create account" : "Sign in";
  const progressLabel = registering ? "Creating account" : "Signing in";
  const ActionIcon = registering ? UserPlus : LogIn;

  return (
    <main className="auth-page">
      <section className="login-panel" aria-labelledby="auth-heading">
        <div className="login-brand">
          <span className="brand-mark" aria-hidden="true">
            <Rss size={17} />
          </span>
          <span>Echovale</span>
        </div>
        <div className="login-heading">
          <h1 id="auth-heading">{actionLabel}</h1>
          <p>
            {registering
              ? "Choose a username and password for your reading queue."
              : "Open your feeds, folders, and reading queue."}
          </p>
        </div>
        <form className="login-form" onSubmit={submit}>
          <label className="login-field" htmlFor="auth-username">
            <span>Username</span>
            <input
              id="auth-username"
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
          <label className="login-field" htmlFor="auth-password">
            <span>Password</span>
            <input
              id="auth-password"
              name="password"
              type="password"
              autoComplete={registering ? "new-password" : "current-password"}
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
              <ActionIcon aria-hidden="true" size={16} />
            )}
            {submitting ? progressLabel : actionLabel}
          </button>
        </form>
        <div className="auth-switch">
          <span>{registering ? "Already have an account?" : "New to Echovale?"}</span>
          <button type="button" onClick={switchMode} disabled={submitting}>
            {registering ? "Sign in" : "Create an account"}
          </button>
        </div>
      </section>
    </main>
  );
}

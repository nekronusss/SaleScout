import { useEffect, useState } from "react";
import { App } from "./App";
import { Auth, type AuthLink } from "./Auth";
import { getSession, type User, type Providers } from "./api";
import { readOAuthFeedback } from "./OAuthButtons";

function readLink(): AuthLink | null {
  const params = new URLSearchParams(window.location.hash.slice(1));
  for (const mode of ["verify", "reset"] as const) {
    const token = params.get(mode);
    if (token) {
      window.history.replaceState(
        null,
        "",
        window.location.pathname + window.location.search,
      );
      return { mode, token };
    }
  }
  return null;
}

export function Root() {
  const [link, setLink] = useState(readLink);
  const [feedback] = useState(readOAuthFeedback);
  const [providers, setProviders] = useState<Providers>({
    google: false,
    apple: false,
  });
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    getSession()
      .then((session) => {
        if (active) {
          setUser(session.user);
          setProviders(session.providers ?? { google: false, apple: false });
        }
      })
      .catch((cause) => {
        if (active)
          setError(
            cause instanceof Error
              ? cause.message
              : "Не удалось загрузить приложение.",
          );
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [attempt]);
  useEffect(() => {
    const expired = () => {
      setUser(null);
      setAttempt((value) => value + 1);
    };
    window.addEventListener("salescout:session-expired", expired);
    return () =>
      window.removeEventListener("salescout:session-expired", expired);
  }, []);
  if (loading || error)
    return (
      <div className="app-loading">
        <img src="/favicon.svg" width="44" height="44" alt="" />
        <h1>SaleScout</h1>
        {error ? (
          <>
            <p role="alert">{error}</p>
            <button
              className="button primary"
              onClick={() => setAttempt((value) => value + 1)}
            >
              Повторить загрузку
            </button>
          </>
        ) : (
          <p role="status">Загружаем рабочее пространство…</p>
        )}
      </div>
    );
  if (!user || link)
    return (
      <Auth
        providers={providers}
        feedback={feedback}
        link={link}
        onLogin={(next) => {
          setLink(null);
          setUser(next);
        }}
      />
    );
  return (
    <App
      key={user.id}
      user={user}
      providers={providers}
      feedback={feedback}
      onLogout={() => {
        setUser(null);
        setAttempt((value) => value + 1);
      }}
    />
  );
}

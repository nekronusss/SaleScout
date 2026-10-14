import { useState, type FormEvent } from "react";
import {
  api,
  ApiError,
  setCsrfToken,
  type AuthSession,
  type User,
  type Providers,
} from "./api";
import { OAuthButtons } from "./OAuthButtons";

type Mode = "login" | "register" | "forgot" | "resend" | "verify" | "reset";
export interface AuthLink {
  mode: "verify" | "reset";
  token: string;
}

export function Auth({
  onLogin,
  link,
  providers = { google: false, apple: false },
  feedback = "",
}: {
  onLogin: (user: User) => void;
  link: AuthLink | null;
  providers?: Providers;
  feedback?: string;
}) {
  const [mode, setMode] = useState<Mode>(link?.mode ?? "login");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [unverified, setUnverified] = useState(false);
  const titles: Record<Mode, string> = {
    login: "Вход в SaleScout",
    register: "Регистрация",
    forgot: "Восстановление пароля",
    resend: "Подтверждение почты",
    verify: "Подтвердите вашу почту",
    reset: "Задайте новый пароль",
  };
  function navigate(next: Mode) {
    setMode(next);
    setError("");
    setMessage("");
    setPassword("");
    setUnverified(false);
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setMessage("");
    try {
      if (mode === "login") {
        const response = await api<AuthSession>("/api/auth/login", {
          method: "POST",
          body: { email, password },
        });
        setCsrfToken(response.csrfToken);
        if (response.user) onLogin(response.user);
      } else {
        const routes: Record<Exclude<Mode, "login">, string> = {
          register: "register",
          forgot: "request-reset",
          resend: "request-verify",
          verify: "verify",
          reset: "reset",
        };
        const response = await api<{ message: string }>(
          `/api/auth/${routes[mode]}`,
          {
            method: "POST",
            body: { email, password, name, token: link?.token },
          },
        );
        setMessage(response.message);
        if (mode === "verify" || mode === "reset") {
          setMode("login");
          setPassword("");
        }
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Попробуйте ещё раз.");
      setUnverified(
        cause instanceof ApiError && cause.code === "EMAIL_UNVERIFIED",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="auth-layout">
      <header className="auth-header">
        <a className="brand" href="/">
          <img src="/favicon.svg" width="36" height="36" alt="" />
          SaleScout
        </a>
        <span>Управление ценами</span>
      </header>
      <section className="auth-main">
        <div className="auth-card">
          <h1>{titles[mode]}</h1>
          <p className="intro">
            {mode === "login"
              ? "Войдите, чтобы открыть свой каталог."
              : mode === "register"
                ? "Для начала работы подтвердите электронную почту."
                : mode === "verify"
                  ? "Нажмите кнопку, чтобы завершить подтверждение."
                  : mode === "reset"
                    ? "Придумайте пароль от 10 символов."
                    : "Отправим ссылку на почту вашего аккаунта."}
          </p>
          {feedback && (
            <div className="banner warning" role="status">
              {feedback}
            </div>
          )}
          {(mode === "login" || mode === "register") && (
            <>
              <OAuthButtons providers={providers} disabled={busy} />
              <div className="auth-divider">
                <span>или по электронной почте</span>
              </div>
            </>
          )}
          {error && (
            <div className="banner error" role="alert">
              {error}
            </div>
          )}
          {message && (
            <div className="banner success" role="status">
              {message}
            </div>
          )}
          <form onSubmit={(event) => void submit(event)}>
            <fieldset disabled={busy} className="plain-fieldset">
              {mode === "register" && (
                <label className="field">
                  Ваше имя
                  <input
                    required
                    maxLength={80}
                    autoComplete="name"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder="Как к вам обращаться"
                  />
                </label>
              )}
              {mode !== "verify" && mode !== "reset" && (
                <label className="field">
                  Электронная почта
                  <input
                    required
                    type="email"
                    maxLength={254}
                    autoComplete="email"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    placeholder="you@company.kz"
                  />
                </label>
              )}
              {["login", "register", "reset"].includes(mode) && (
                <label className="field">
                  {mode === "reset" ? "Новый пароль" : "Пароль"}
                  <input
                    required
                    type="password"
                    minLength={mode === "login" ? undefined : 10}
                    maxLength={128}
                    autoComplete={
                      mode === "login" ? "current-password" : "new-password"
                    }
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    placeholder={
                      mode === "login" ? "Ваш пароль" : "Не менее 10 символов"
                    }
                  />
                </label>
              )}
              {mode === "login" && (
                <button
                  className="text-button forgot-link"
                  type="button"
                  onClick={() => navigate("forgot")}
                >
                  Забыли пароль?
                </button>
              )}
              <button className="button primary auth-submit" type="submit">
                {busy
                  ? "Подождите…"
                  : mode === "login"
                    ? "Войти в аккаунт"
                    : mode === "register"
                      ? "Создать аккаунт"
                      : mode === "verify"
                        ? "Подтвердить почту"
                        : mode === "reset"
                          ? "Сохранить новый пароль"
                          : "Отправить письмо"}
              </button>
            </fieldset>
          </form>
          {unverified && (
            <button className="text-button" onClick={() => navigate("resend")}>
              Отправить подтверждение повторно
            </button>
          )}
          <div className="auth-switch">
            {mode === "login" ? (
              <>
                Нет аккаунта?{" "}
                <button
                  className="text-button"
                  disabled={busy}
                  onClick={() => navigate("register")}
                >
                  Зарегистрироваться
                </button>
              </>
            ) : (
              <button
                className="text-button"
                disabled={busy}
                onClick={() => navigate("login")}
              >
                Вернуться ко входу
              </button>
            )}
          </div>
          {mode === "register" && (
            <p className="auth-privacy">
              Для регистрации по почте потребуется подтвердить адрес по ссылке
              из письма.
            </p>
          )}
        </div>
      </section>
      <footer className="auth-footer">
        SaleScout · Расчёт цен для продавцов Kaspi.kz
      </footer>
    </div>
  );
}

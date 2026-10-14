import { useState } from "react";
import { api, type Providers } from "./api";

export function readOAuthFeedback() {
  const params = new URLSearchParams(window.location.hash.slice(1));
  const error = params.get("auth-error");
  if (!error && !params.has("auth-linked")) return "";
  window.history.replaceState(
    null,
    "",
    window.location.pathname + window.location.search,
  );
  if (!error) return "Способ входа подключён к вашему аккаунту.";
  const messages: Record<string, string> = {
    cancelled: "Вход отменён. Вы можете повторить попытку или войти по почте.",
    invalid: "Ссылка входа устарела. Попробуйте ещё раз в этой вкладке.",
    exists:
      "Для этой почты уже есть аккаунт. Войдите по паролю или восстановите его, затем подключите Google или Apple в разделе «Аккаунт и данные».",
    link: "Этот способ входа уже связан с другим аккаунтом.",
    email:
      "Провайдер не передал подтверждённую почту. Используйте вход по почте.",
  };
  return (
    messages[error] ??
    "Не удалось завершить вход. Попробуйте ещё раз или войдите по почте."
  );
}

function ProviderIcon({ provider }: { provider: "google" | "apple" }) {
  return provider === "google" ? (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M21.6 12.23c0-.71-.06-1.39-.18-2.05H12v3.88h5.38a4.6 4.6 0 0 1-2 3.02v2.51h3.24c1.89-1.74 2.98-4.3 2.98-7.36Z"
      />
      <path
        fill="#34A853"
        d="M12 22c2.7 0 4.96-.9 6.62-2.42l-3.24-2.51c-.9.6-2.05.96-3.38.96-2.6 0-4.8-1.76-5.59-4.12H3.06v2.6A10 10 0 0 0 12 22Z"
      />
      <path
        fill="#FBBC05"
        d="M6.41 13.91a6 6 0 0 1 0-3.82v-2.6H3.06a10 10 0 0 0 0 9.02l3.35-2.6Z"
      />
      <path
        fill="#EA4335"
        d="M12 5.97c1.47 0 2.79.5 3.83 1.5L18.7 4.6A9.6 9.6 0 0 0 12 2a10 10 0 0 0-8.94 5.49l3.35 2.6A6.01 6.01 0 0 1 12 5.97Z"
      />
    </svg>
  ) : (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M16.7 1.3c.1 1.3-.4 2.5-1.2 3.4-.8 1-2 1.6-3.2 1.5-.2-1.2.4-2.5 1.1-3.3.8-.9 2.1-1.6 3.3-1.6ZM20.5 17.1c-.5 1.1-.7 1.6-1.4 2.6-1 1.4-2.3 3.1-3.9 3.1-1.4 0-1.8-.9-3.7-.9-1.8 0-2.3.9-3.7.9-1.6 0-2.8-1.5-3.8-2.9-2.8-4-3.1-8.7-1.4-11.2 1.2-1.8 3.1-2.8 4.9-2.8 1.5 0 2.5.9 3.8.9 1.2 0 2-.9 3.7-.9 1.5 0 3.1.8 4.3 2.2-3.8 2.1-3.2 7.5 1.2 9Z" />
    </svg>
  );
}

export function OAuthButtons({
  providers,
  linked = [],
  connect = false,
  disabled = false,
}: {
  providers: Providers;
  linked?: string[];
  connect?: boolean;
  disabled?: boolean;
}) {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState("");
  async function start(provider: "google" | "apple") {
    setPending(provider);
    setError("");
    try {
      const { url } = await api<{ url: string }>(
        `/api/auth/oauth/${provider}/start`,
        { method: "POST" },
      );
      window.location.assign(url);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Попробуйте ещё раз.");
      setPending(null);
    }
  }
  return (
    <div className="oauth-section">
      <div className="oauth-buttons">
        {(["google", "apple"] as const).map((provider) => {
          const label = provider === "google" ? "Google" : "Apple";
          const connected = linked.includes(provider);
          return (
            <button
              type="button"
              className={`button oauth-button oauth-${provider}`}
              key={provider}
              disabled={
                disabled ||
                Boolean(pending) ||
                !providers[provider] ||
                connected
              }
              title={
                !providers[provider]
                  ? `Вход через ${label} пока недоступен`
                  : undefined
              }
              onClick={() => void start(provider)}
            >
              <ProviderIcon provider={provider} />
              {pending === provider
                ? "Переходим…"
                : connected
                  ? `${label} подключён`
                  : connect
                    ? `Подключить ${label}`
                    : `Войти через ${label}`}
            </button>
          );
        })}
      </div>
      {(!providers.google || !providers.apple) && (
        <p className="provider-note">
          {!providers.google && !providers.apple
            ? "Вход через Google и Apple пока недоступен. Используйте почту."
            : `Вход через ${!providers.google ? "Google" : "Apple"} пока недоступен.`}
        </p>
      )}
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

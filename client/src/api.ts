export interface User {
  id: string;
  email: string;
  name: string;
  hasPassword?: boolean;
  linkedProviders?: string[];
}
export interface Providers {
  google: boolean;
  apple: boolean;
}
export interface AuthSession {
  user: User | null;
  csrfToken: string;
  providers?: Providers;
}
let csrfToken = "";
export const setCsrfToken = (token: string) => {
  csrfToken = token;
};

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
  ) {
    super(message);
  }
}

export async function api<T>(
  path: string,
  options: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: options.method ?? "GET",
      credentials: "same-origin",
      signal: options.signal,
      headers: {
        "Content-Type": "application/json",
        ...(options.method && options.method !== "GET"
          ? { "X-CSRF-Token": csrfToken }
          : {}),
      },
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError")
      throw error;
    throw new ApiError(
      "Не удалось связаться с сервером. Проверьте соединение и попробуйте ещё раз.",
      0,
    );
  }
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const record =
      typeof body === "object" && body !== null
        ? (body as Record<string, unknown>)
        : {};
    if (response.status === 401 && record.code === "UNAUTHENTICATED")
      window.dispatchEvent(new Event("salescout:session-expired"));
    throw new ApiError(
      typeof record.error === "string"
        ? record.error
        : `Ошибка сервера (${response.status}).`,
      response.status,
      typeof record.code === "string" ? record.code : undefined,
    );
  }
  return response.status === 204
    ? (undefined as T)
    : (response.json() as Promise<T>);
}

export async function getSession(): Promise<AuthSession> {
  const session = await api<AuthSession>("/api/auth/session");
  setCsrfToken(session.csrfToken);
  return session;
}

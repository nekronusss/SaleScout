import "dotenv/config";

export interface Config {
  production: boolean;
  port: number;
  host: string;
  origin: string;
  databaseUrl: string;
  sessionSecret: string;
  secureCookies: boolean;
  trustProxy: number;
  oauth: {
    google?: { clientId: string; clientSecret: string };
    apple?: {
      clientId: string;
      teamId: string;
      keyId: string;
      privateKey: string;
    };
  };
  smtp: {
    host: string;
    port: number;
    secure: boolean;
    user?: string;
    pass?: string;
    from: string;
  };
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const production = env.NODE_ENV === "production";
  const required = (key: string) => {
    const value = env[key];
    if (!value)
      throw new Error(
        `Missing environment variable: ${key}. See .env.example.`,
      );
    return value;
  };
  const integer = (key: string, fallback: number, min: number, max: number) => {
    const value = Number(env[key] ?? fallback);
    if (!Number.isInteger(value) || value < min || value > max)
      throw new Error(`Invalid ${key}`);
    return value;
  };
  const origin = new URL(env.APP_ORIGIN ?? "http://localhost:5173").origin;
  const sessionSecret = required("SESSION_SECRET");
  if (sessionSecret.length < 32)
    throw new Error("SESSION_SECRET must contain at least 32 characters");
  const secureCookies = production;
  if (production && !origin.startsWith("https://"))
    throw new Error("Production APP_ORIGIN must use HTTPS");
  const smtpHost = production
    ? required("SMTP_HOST")
    : (env.SMTP_HOST ?? "127.0.0.1");
  const from = production
    ? required("SMTP_FROM")
    : (env.SMTP_FROM ?? "SaleScout <noreply@localhost.test>");
  const google =
    env.GOOGLE_CLIENT_ID || env.GOOGLE_CLIENT_SECRET
      ? {
          clientId: required("GOOGLE_CLIENT_ID"),
          clientSecret: required("GOOGLE_CLIENT_SECRET"),
        }
      : undefined;
  const apple = [
    env.APPLE_CLIENT_ID,
    env.APPLE_TEAM_ID,
    env.APPLE_KEY_ID,
    env.APPLE_PRIVATE_KEY,
  ].some(Boolean)
    ? {
        clientId: required("APPLE_CLIENT_ID"),
        teamId: required("APPLE_TEAM_ID"),
        keyId: required("APPLE_KEY_ID"),
        privateKey: required("APPLE_PRIVATE_KEY").replaceAll("\\n", "\n"),
      }
    : undefined;
  if (
    apple &&
    (!origin.startsWith("https://") ||
      ["localhost", "127.0.0.1"].includes(new URL(origin).hostname))
  )
    throw new Error(
      "Sign in with Apple requires APP_ORIGIN with a public HTTPS domain",
    );
  return {
    oauth: { google, apple },
    production,
    port: integer("PORT", 3001, 1, 65535),
    host: env.HOST ?? "127.0.0.1",
    origin,
    databaseUrl: required("DATABASE_URL"),
    sessionSecret,
    secureCookies,
    trustProxy: integer("TRUST_PROXY", 0, 0, 1),
    smtp: {
      host: smtpHost,
      port: integer("SMTP_PORT", production ? 587 : 1025, 1, 65535),
      secure: env.SMTP_SECURE === "true",
      user: env.SMTP_USER,
      pass: env.SMTP_PASS,
      from,
    },
  };
}

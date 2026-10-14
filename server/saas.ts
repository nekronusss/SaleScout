import {
  randomBytes,
  randomUUID,
  createHash,
  timingSafeEqual,
} from "node:crypto";
import { Router, type RequestHandler, type Request } from "express";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import { rateLimit } from "express-rate-limit";
import type { Pool } from "./db.js";
import type { Config } from "./config.js";
import type { SendMail } from "./mail.js";
import { hashPassword, verifyPassword } from "./passwords.js";
import { isProduct } from "../src/validation.js";
import type { Product } from "../src/types.js";
import { createOAuthRoutes, type OAuthAdapter } from "./oauth.js";

declare module "express-session" {
  interface SessionData {
    userId?: string;
    authVersion?: number;
    csrf?: string;
  }
}
interface User {
  id: string;
  email: string;
  name: string;
  password_hash: string | null;
  verified: boolean;
  auth_version: number;
}
export interface SaaSOptions {
  pool: Pool;
  config: Config;
  sendMail: SendMail;
  disableRateLimit?: boolean;
  oauthAdapter?: OAuthAdapter;
}
export const publicUser = (user: User) => ({
  id: user.id,
  email: user.email,
  name: user.name,
  hasPassword: Boolean(user.password_hash),
});
const digest = (token: string) =>
  createHash("sha256").update(token).digest("hex");
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const validPassword = (value: unknown): value is string =>
  typeof value === "string" && value.length >= 10 && value.length <= 128;
const emailOf = (value: unknown) =>
  typeof value === "string" ? value.trim().toLowerCase() : "";
const validEmail = (email: string) =>
  email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

function catalogIsValid(input: unknown): input is Product[] {
  return (
    Array.isArray(input) &&
    input.length <= 500 &&
    input.every(
      (item) =>
        isProduct(item) &&
        item.name.trim().length > 0 &&
        item.name.length <= 240 &&
        item.sku.trim().length > 0 &&
        item.sku.length <= 120 &&
        item.competitors.length <= 100 &&
        item.competitors.every(
          (c) => c.seller.trim().length > 0 && c.seller.length <= 240,
        ) &&
        [
          item.myPrice,
          item.minPrice,
          item.maxPrice,
          item.step,
          ...item.competitors.map((c) => c.price),
        ].every((n) => n <= Number.MAX_SAFE_INTEGER),
    )
  );
}

export function createSaaS({
  pool,
  config,
  sendMail,
  disableRateLimit = false,
  oauthAdapter,
}: SaaSOptions) {
  const router = Router();
  const Store = connectPgSimple(session);
  const store = new Store({
    pool,
    tableName: "sessions",
    pruneSessionInterval: false,
  });
  const cookieName = config.secureCookies
    ? "__Host-salescout.sid"
    : "salescout.sid";
  router.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  router.use(
    session({
      name: cookieName,
      secret: config.sessionSecret,
      store,
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        secure: config.secureCookies,
        sameSite: "lax",
        maxAge: 7 * 86400000,
        path: "/",
      },
    }),
  );
  // Same-origin cookies plus a synchronizer token protect every state-changing API call.
  const allowedOrigins = new Set([config.origin]);
  if (!config.production) {
    const local = new URL(config.origin);
    if (local.hostname === "localhost" || local.hostname === "127.0.0.1") {
      local.hostname =
        local.hostname === "localhost" ? "127.0.0.1" : "localhost";
      allowedOrigins.add(local.origin);
    }
  }
  router.use((req, res, next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
    // The Apple callback authenticates using its one-time state + original
    // browser session on the subsequent GET; it cannot carry our CSRF header.
    if (req.method === "POST" && req.path === "/auth/oauth/apple/callback")
      return next();
    const origin = req.get("origin");
    const token = req.get("x-csrf-token");
    const expected = req.session.csrf;
    if (
      (origin && !allowedOrigins.has(origin)) ||
      !token ||
      !/^[a-f0-9]{64}$/.test(token) ||
      !expected ||
      !timingSafeEqual(Buffer.from(token), Buffer.from(expected))
    ) {
      res.status(403).json({
        error: "Сессия устарела. Обновите страницу и повторите действие.",
        code: "CSRF",
      });
      return;
    }
    next();
  });

  const findUser = async (req: Request): Promise<User | null> => {
    if (!req.session.userId) return null;
    const { rows } = await pool.query<User>(
      "SELECT * FROM users WHERE id = $1 AND auth_version = $2 AND verified = true",
      [req.session.userId, req.session.authVersion],
    );
    return rows[0] ?? null;
  };
  const requireUser: RequestHandler = async (req, res, next) => {
    const user = await findUser(req);
    if (!user) {
      res
        .status(401)
        .json({ error: "Войдите в аккаунт.", code: "UNAUTHENTICATED" });
      return;
    }
    res.locals.user = user;
    next();
  };
  router.get("/auth/session", async (req, res) => {
    req.session.csrf ??= randomBytes(32).toString("hex");
    const user = await findUser(req);
    const identities = user
      ? await pool.query<{ provider: string }>(
          "SELECT provider FROM oauth_identities WHERE user_id=$1",
          [user.id],
        )
      : null;
    res.json({
      user: user
        ? {
            ...publicUser(user),
            linkedProviders: identities?.rows.map((row) => row.provider) ?? [],
          }
        : null,
      csrfToken: req.session.csrf,
      providers: {
        google: Boolean(config.oauth.google),
        apple: Boolean(config.oauth.apple),
      },
    });
  });

  if (!disableRateLimit)
    router.use(
      "/auth",
      rateLimit({
        windowMs: 15 * 60000,
        limit: 30,
        standardHeaders: "draft-7",
        legacyHeaders: false,
        message: { error: "Слишком много попыток. Попробуйте через 15 минут." },
      }),
    );

  router.use("/auth/oauth", createOAuthRoutes(pool, config, oauthAdapter));

  async function emailToken(
    user: Pick<User, "id" | "email">,
    purpose: "verify" | "reset",
  ) {
    const token = randomBytes(32).toString("hex");
    const expires = new Date(
      Date.now() + (purpose === "verify" ? 86400000 : 1800000),
    );
    const issued = await pool.query(
      "INSERT INTO email_tokens(token_hash,user_id,purpose,expires_at) VALUES ($1,$2,$3,$4) ON CONFLICT (user_id,purpose) DO UPDATE SET token_hash = EXCLUDED.token_hash, expires_at = EXCLUDED.expires_at, issued_at = now() WHERE email_tokens.issued_at < now() - interval '60 seconds' RETURNING user_id",
      [digest(token), user.id, purpose, expires],
    );
    if (issued.rowCount) await sendMail(user.email, purpose, token);
  }

  router.post("/auth/register", async (req, res) => {
    const body: unknown = req.body;
    const email = record(body) ? emailOf(body.email) : "";
    if (
      !record(body) ||
      !validEmail(email) ||
      !validPassword(body.password) ||
      typeof body.name !== "string" ||
      !body.name.trim() ||
      body.name.trim().length > 80
    ) {
      res.status(400).json({
        error: "Укажите имя, корректную почту и пароль от 10 до 128 символов.",
      });
      return;
    }
    const passwordHash = await hashPassword(body.password);
    const client = await pool.connect();
    let user: User | undefined;
    try {
      await client.query("BEGIN");
      const result = await client.query<User>(
        "INSERT INTO users(id,email,name,password_hash) VALUES ($1,$2,$3,$4) ON CONFLICT (email) DO NOTHING RETURNING *",
        [randomUUID(), email, body.name.trim(), passwordHash],
      );
      user = result.rows[0];
      if (user)
        await client.query("INSERT INTO catalogs(user_id) VALUES ($1)", [
          user.id,
        ]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    if (user) await emailToken(user, "verify");
    res.status(202).json({
      message:
        "Если адрес ещё не зарегистрирован, на него отправлена ссылка подтверждения. Для существующего аккаунта используйте вход или восстановление пароля.",
    });
  });

  router.post("/auth/login", async (req, res) => {
    const body: unknown = req.body;
    if (
      !record(body) ||
      typeof body.password !== "string" ||
      body.password.length > 128
    ) {
      res.status(400).json({ error: "Укажите почту и пароль." });
      return;
    }
    const { rows } = await pool.query<User>(
      "SELECT * FROM users WHERE email = $1",
      [emailOf(body.email)],
    );
    const user = rows[0];
    // Perform the same expensive derivation even when the email is unknown.
    const encoded =
      user?.password_hash ?? `scrypt$${"0".repeat(32)}$${"0".repeat(128)}`;
    if (!(await verifyPassword(body.password, encoded)) || !user) {
      res.status(401).json({ error: "Неверная почта или пароль." });
      return;
    }
    if (!user.verified) {
      res.status(403).json({
        error: "Подтвердите почту по ссылке из письма.",
        code: "EMAIL_UNVERIFIED",
      });
      return;
    }
    await new Promise<void>((resolve, reject) =>
      req.session.regenerate((error) => (error ? reject(error) : resolve())),
    );
    req.session.userId = user.id;
    req.session.authVersion = user.auth_version;
    req.session.csrf = randomBytes(32).toString("hex");
    await new Promise<void>((resolve, reject) =>
      req.session.save((error) => (error ? reject(error) : resolve())),
    );
    const identities = await pool.query<{ provider: string }>(
      "SELECT provider FROM oauth_identities WHERE user_id=$1",
      [user.id],
    );
    res.json({
      user: {
        ...publicUser(user),
        linkedProviders: identities.rows.map((row) => row.provider),
      },
      csrfToken: req.session.csrf,
    });
  });

  router.post("/auth/logout", (req, res, next) => {
    req.session.destroy((error) => {
      if (error) return next(error);
      res.clearCookie(cookieName, {
        path: "/",
        httpOnly: true,
        secure: config.secureCookies,
        sameSite: "lax",
      });
      res.status(204).end();
    });
  });

  for (const purpose of ["verify", "reset"] as const) {
    router.post(`/auth/request-${purpose}`, async (req, res) => {
      const email = record(req.body) ? emailOf(req.body.email) : "";
      if (!validEmail(email)) {
        res.status(400).json({ error: "Укажите корректную почту." });
        return;
      }
      const { rows } = await pool.query<User>(
        "SELECT * FROM users WHERE email = $1",
        [email],
      );
      const user = rows[0];
      if (user && (purpose === "reset" ? user.verified : !user.verified))
        await emailToken(user, purpose);
      res.json({
        message:
          "Если для этого адреса доступно действие, мы отправили письмо. Проверьте также папку «Спам».",
      });
    });
    router.post(`/auth/${purpose}`, async (req, res) => {
      const body: unknown = req.body;
      if (
        !record(body) ||
        typeof body.token !== "string" ||
        !/^[a-f0-9]{64}$/.test(body.token) ||
        (purpose === "reset" && !validPassword(body.password))
      ) {
        res.status(400).json({
          error: "Проверьте ссылку и пароль (от 10 до 128 символов).",
        });
        return;
      }
      const passwordHash =
        purpose === "reset"
          ? await hashPassword(body.password as string)
          : null;
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const { rows } = await client.query<{ user_id: string }>(
          "DELETE FROM email_tokens WHERE token_hash = $1 AND purpose = $2 AND expires_at > now() RETURNING user_id",
          [digest(body.token), purpose],
        );
        const userId = rows[0]?.user_id;
        if (!userId) {
          await client.query("ROLLBACK");
          res.status(400).json({
            error:
              "Ссылка недействительна или истекла. Запросите новое письмо.",
          });
          return;
        }
        if (purpose === "verify")
          await client.query("UPDATE users SET verified = true WHERE id = $1", [
            userId,
          ]);
        else {
          await client.query(
            "UPDATE users SET password_hash = $1, auth_version = auth_version + 1 WHERE id = $2",
            [passwordHash, userId],
          );
          await client.query(
            "DELETE FROM sessions WHERE sess->>'userId' = $1",
            [userId],
          );
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      res.json({
        message:
          purpose === "verify"
            ? "Почта подтверждена. Теперь можно войти."
            : "Пароль изменён. Войдите с новым паролем.",
      });
    });
  }

  router.get("/products", requireUser, async (req, res) => {
    const { rows } = await pool.query(
      "SELECT products, version FROM catalogs WHERE user_id = $1",
      [req.session.userId],
    );
    res.json(rows[0]);
  });
  router.put("/products", requireUser, async (req, res) => {
    const body: unknown = req.body;
    if (
      !record(body) ||
      !catalogIsValid(body.products) ||
      !Number.isInteger(body.version) ||
      (body.version as number) < 0
    ) {
      res.status(400).json({
        error:
          "Некорректные товары. Максимум 500 товаров и 100 конкурентов на товар; заполните названия и числовые поля.",
      });
      return;
    }
    const { rows } = await pool.query(
      "UPDATE catalogs SET products = $1, version = version + 1, updated_at = now() WHERE user_id = $2 AND version = $3 RETURNING products, version",
      [JSON.stringify(body.products), req.session.userId, body.version],
    );
    if (!rows[0]) {
      res.status(409).json({
        error:
          "Список изменён в другой вкладке. Обновите список перед сохранением.",
        code: "CONFLICT",
      });
      return;
    }
    res.json(rows[0]);
  });
  router.delete("/account", requireUser, async (req, res) => {
    const user = res.locals.user as User;
    const body: unknown = req.body;
    if (
      !record(body) ||
      typeof body.password !== "string" ||
      body.password.length > 128 ||
      !user.password_hash ||
      !(await verifyPassword(body.password, user.password_hash))
    ) {
      res
        .status(400)
        .json({ error: "Для удаления аккаунта введите текущий пароль." });
      return;
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM users WHERE id = $1", [user.id]);
      await client.query("DELETE FROM sessions WHERE sess->>'userId' = $1", [
        user.id,
      ]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    req.session.destroy(() => undefined);
    res.clearCookie(cookieName, {
      path: "/",
      httpOnly: true,
      secure: config.secureCookies,
      sameSite: "lax",
    });
    res.status(204).end();
  });

  return router;
}

import "dotenv/config";
import { randomUUID } from "node:crypto";
import pg from "pg";
import request from "supertest";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { createApp } from "../server/app";
import { migrate } from "../server/db";
import { readConfig } from "../server/config";
import type { SendMail } from "../server/mail";
import products from "../data/products.json";
import { createOAuthAdapter, type OAuthAdapter } from "../server/oauth";

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl)
  throw new Error(
    "Set TEST_DATABASE_URL or run npm run setup && npm run infra.",
  );
const schema = `salescout_test_${randomUUID().replaceAll("-", "")}`;
const admin = new pg.Pool({ connectionString: databaseUrl });
const pool = new pg.Pool({
  connectionString: databaseUrl,
  options: `-c search_path=${schema}`,
});
const config = readConfig({
  ...process.env,
  NODE_ENV: "test",
  DATABASE_URL: databaseUrl,
  APP_ORIGIN: "http://localhost:5173",
  SESSION_SECRET: "test-only-secret-with-more-than-32-characters",
});
const mail: { email: string; purpose: string; token: string }[] = [];
const sendMail: SendMail = async (email, purpose, token) => {
  mail.push({ email, purpose, token });
};
const app = createApp({ pool, config, sendMail, disableRateLimit: true });
type Agent = ReturnType<typeof request.agent>;
const password = "correct-password-123";
let sequence = 0;

async function session(agent: Agent) {
  return (await agent.get("/api/auth/session").expect(200)).body
    .csrfToken as string;
}
function post(agent: Agent, csrf: string, route: string, body: object) {
  return agent.post(`/api/auth/${route}`).set("X-CSRF-Token", csrf).send(body);
}
async function account() {
  const agent = request.agent(app);
  let csrf = await session(agent);
  const email = `person-${++sequence}@example.test`;
  await post(agent, csrf, "register", {
    email,
    password,
    name: "Test User",
  }).expect(202);
  const token = [...mail]
    .reverse()
    .find((item) => item.email === email && item.purpose === "verify")!.token;
  await post(agent, csrf, "verify", { token }).expect(200);
  const login = await post(agent, csrf, "login", { email, password }).expect(
    200,
  );
  csrf = login.body.csrfToken;
  return {
    agent,
    csrf,
    email,
    user: login.body.user as { id: string; email: string; name: string },
  };
}
beforeAll(async () => {
  await admin.query(`CREATE SCHEMA "${schema}"`);
  await migrate(pool);
});
afterAll(async () => {
  await pool.end();
  if (!/^salescout_test_[a-f0-9]{32}$/.test(schema))
    throw new Error("Unsafe test schema");
  await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await admin.end();
});

describe("SaaS with real PostgreSQL", () => {
  it("migrates idempotently and reports readiness", async () => {
    await migrate(pool);
    await request(app).get("/readyz").expect(200);
  });

  it("requires authentication and CSRF, including cross-origin requests", async () => {
    const agent = request.agent(app);
    const csrf = await session(agent);
    await agent.get("/api/products").expect(401);
    await agent.put("/api/products").send({ products, version: 0 }).expect(403);
    await agent
      .put("/api/products")
      .set("X-CSRF-Token", "é".repeat(64))
      .send({ products, version: 0 })
      .expect(403);
    await post(agent, csrf, "register", {
      email: "a@example.com",
      password,
      name: "A",
    })
      .set("Origin", "https://evil.example")
      .expect(403);
  });

  it("verifies email once, hashes credentials and regenerates sessions on login", async () => {
    const agent = request.agent(app);
    const csrf = await session(agent);
    const email = `person-${++sequence}@example.test`;
    await post(agent, csrf, "register", {
      email,
      password,
      name: "Test",
    }).expect(202);
    await post(agent, csrf, "login", { email, password }).expect(403);
    const token = [...mail]
      .reverse()
      .find((item) => item.email === email)!.token;
    const saved = await pool.query(
      "SELECT password_hash FROM users WHERE email=$1",
      [email],
    );
    expect(saved.rows[0].password_hash).not.toContain(password);
    const tokens = await pool.query(
      "SELECT token_hash FROM email_tokens WHERE token_hash=$1",
      [token],
    );
    expect(tokens.rowCount).toBe(0);
    await post(agent, csrf, "verify", { token }).expect(200);
    await post(agent, csrf, "verify", { token }).expect(400);
    const login = await post(agent, csrf, "login", { email, password }).expect(
      200,
    );
    expect(login.body.csrfToken).not.toBe(csrf);
    expect(login.body.user).not.toHaveProperty("password_hash");
    expect(String(login.headers["set-cookie"]?.[0])).toContain("HttpOnly");
    expect(String(login.headers["set-cookie"]?.[0])).toContain("SameSite=Lax");
    expect(login.headers["cache-control"]).toBe("no-store");
  });

  it("keeps two users isolated even when a forged userId is submitted", async () => {
    const a = await account();
    const b = await account();
    await a.agent
      .put("/api/products")
      .set("X-CSRF-Token", a.csrf)
      .send({ products, version: 0, userId: b.user.id })
      .expect(200);
    expect((await a.agent.get("/api/products")).body.products).toEqual(
      products,
    );
    expect((await b.agent.get("/api/products")).body.products).toEqual([]);
    const replay = createApp({
      pool,
      config,
      sendMail,
      disableRateLimit: true,
    });
    const login = await post(a.agent, a.csrf, "login", {
      email: a.email,
      password,
    }).expect(200);
    const cookie = String(login.headers["set-cookie"]?.[0]).split(";")[0]!;
    expect(
      (
        await request(replay)
          .get("/api/products")
          .set("Cookie", cookie)
          .expect(200)
      ).body.products,
    ).toEqual(products);
  });

  it("rejects stale versions and accepts only one concurrent save", async () => {
    const { agent, csrf } = await account();
    const results = await Promise.all([
      agent
        .put("/api/products")
        .set("X-CSRF-Token", csrf)
        .send({ products, version: 0 }),
      agent
        .put("/api/products")
        .set("X-CSRF-Token", csrf)
        .send({ products: [products[0]], version: 0 }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    expect((await agent.get("/api/products")).body.version).toBe(1);
  });

  it("validates catalog limits and does not change data on failure", async () => {
    const { agent, csrf } = await account();
    for (const invalid of [
      [{ ...products[0], minPrice: -1 }],
      Array(501).fill(products[0]),
      [{ ...products[0], name: "" }],
    ]) {
      await agent
        .put("/api/products")
        .set("X-CSRF-Token", csrf)
        .send({ products: invalid, version: 0 })
        .expect(400);
    }
    expect((await agent.get("/api/products")).body.products).toEqual([]);
  });

  it("duplicate registration cannot change the existing password", async () => {
    const a = await account();
    const guest = request.agent(app);
    const csrf = await session(guest);
    await post(guest, csrf, "register", {
      email: a.email,
      name: "Attacker",
      password: "changed-password",
    }).expect(202);
    await post(guest, csrf, "login", {
      email: a.email,
      password: "changed-password",
    }).expect(401);
    await post(guest, csrf, "login", { email: a.email, password }).expect(200);
  });

  it("reset tokens are single-use and invalidate previous sessions", async () => {
    const a = await account();
    const guest = request.agent(app);
    const csrf = await session(guest);
    await post(guest, csrf, "request-reset", { email: a.email }).expect(200);
    const token = [...mail]
      .reverse()
      .find(
        (item) => item.email === a.email && item.purpose === "reset",
      )!.token;
    await post(guest, csrf, "reset", {
      token,
      password: "new-password-12345",
    }).expect(200);
    await post(guest, csrf, "reset", {
      token,
      password: "new-password-12345",
    }).expect(400);
    await a.agent.get("/api/products").expect(401);
    await post(guest, csrf, "login", { email: a.email, password }).expect(401);
    await post(guest, csrf, "login", {
      email: a.email,
      password: "new-password-12345",
    }).expect(200);
  });

  it("rejects expired tokens and returns generic recovery responses", async () => {
    const a = await account();
    const guest = request.agent(app);
    const csrf = await session(guest);
    const known = await post(guest, csrf, "request-reset", {
      email: a.email,
    }).expect(200);
    const unknown = await post(guest, csrf, "request-reset", {
      email: "unknown@example.test",
    }).expect(200);
    expect(known.body).toEqual(unknown.body);
    const token = [...mail]
      .reverse()
      .find(
        (item) => item.email === a.email && item.purpose === "reset",
      )!.token;
    await pool.query(
      "UPDATE email_tokens SET expires_at = now() - interval '1 minute' WHERE user_id=$1",
      [a.user.id],
    );
    await post(guest, csrf, "reset", {
      token,
      password: "new-password-12345",
    }).expect(400);
  });

  it("logout invalidates access", async () => {
    const { agent, csrf } = await account();
    await post(agent, csrf, "logout", {}).expect(204);
    await agent.get("/api/products").expect(401);
  });

  it("account deletion requires a password and removes its catalog", async () => {
    const a = await account();
    await a.agent
      .put("/api/products")
      .set("X-CSRF-Token", a.csrf)
      .send({ products, version: 0 })
      .expect(200);
    await a.agent
      .delete("/api/account")
      .set("X-CSRF-Token", a.csrf)
      .send({ password: "wrong" })
      .expect(400);
    await a.agent
      .delete("/api/account")
      .set("X-CSRF-Token", a.csrf)
      .send({ password })
      .expect(204);
    expect(
      (await pool.query("SELECT * FROM catalogs WHERE user_id=$1", [a.user.id]))
        .rowCount,
    ).toBe(0);
    await a.agent.get("/api/products").expect(401);
  });

  it("sets secure host-only cookies in production behind the configured proxy", async () => {
    const productionApp = createApp({
      pool,
      config: {
        ...config,
        production: true,
        secureCookies: true,
        trustProxy: 1,
        origin: "https://salescout.example",
      },
      sendMail,
      disableRateLimit: true,
    });
    const response = await request(productionApp)
      .get("/api/auth/session")
      .set("X-Forwarded-Proto", "https")
      .expect(200);
    expect(String(response.headers["set-cookie"]?.[0])).toContain(
      "__Host-salescout.sid=",
    );
    expect(String(response.headers["set-cookie"]?.[0])).toContain("Secure");
    expect(response.headers["content-security-policy"]).toContain(
      "frame-ancestors 'none'",
    );
  });

  it("limits recovery messages to one per minute for the same account", async () => {
    const a = await account();
    const guest = request.agent(app);
    const csrf = await session(guest);
    await post(guest, csrf, "request-reset", { email: a.email }).expect(200);
    await post(guest, csrf, "request-reset", { email: a.email }).expect(200);
    expect(
      mail.filter((item) => item.email === a.email && item.purpose === "reset"),
    ).toHaveLength(1);
  });
});

describe("OAuth browser/session integration", () => {
  const oauthConfig = {
    ...config,
    oauth: {
      google: { clientId: "google-test", clientSecret: "test" },
      apple: {
        clientId: "apple-test",
        teamId: "test",
        keyId: "test",
        privateKey: "unused-test-key",
      },
    },
  };
  const adapter: OAuthAdapter = {
    authorize: createOAuthAdapter(oauthConfig).authorize,
    async exchange(_provider, code) {
      if (code === "bad-token") throw new Error("Invalid token");
      return {
        subject: code,
        email: `${code}@example.test`,
        name: "OAuth User",
      };
    },
  };
  const oauthApp = createApp({
    pool,
    config: oauthConfig,
    sendMail,
    disableRateLimit: true,
    oauthAdapter: adapter,
  });
  async function begin(agent: Agent, provider = "google") {
    const csrf = await session(agent);
    const started = await post(
      agent,
      csrf,
      `oauth/${provider}/start`,
      {},
    ).expect(200);
    return new URL(started.body.url as string).searchParams.get("state")!;
  }
  async function google(agent: Agent, code: string) {
    const state = await begin(agent);
    return agent.get("/api/auth/oauth/google/callback").query({ state, code });
  }
  it("requires CSRF on start and accurately reports unavailable providers", async () => {
    const agent = request.agent(app);
    const csrf = await session(agent);
    expect((await agent.get("/api/auth/session")).body.providers).toEqual({
      google: false,
      apple: false,
    });
    await post(agent, csrf, "oauth/google/start", {}).expect(503);
    await request(oauthApp)
      .post("/api/auth/oauth/google/start")
      .send({})
      .expect(403);
  });
  it("creates a separate catalog, reuses the identity and prevents callback replay", async () => {
    const agent = request.agent(oauthApp);
    const state = await begin(agent);
    const response = await agent
      .get("/api/auth/oauth/google/callback")
      .query({ state, code: "new-oauth" })
      .expect(303);
    expect(response.headers.location).toBe(config.origin + "/");
    const loggedIn = (await agent.get("/api/auth/session")).body;
    expect(loggedIn.user.hasPassword).toBe(false);
    expect(loggedIn.user.linkedProviders).toEqual(["google"]);
    expect(
      (await agent.get("/api/products").expect(200)).body.products,
    ).toEqual([]);
    expect(
      (
        await agent
          .get("/api/auth/oauth/google/callback")
          .query({ state, code: "new-oauth" })
      ).headers.location,
    ).toContain("auth-error=invalid");
    const second = request.agent(oauthApp);
    await google(second, "new-oauth");
    expect((await second.get("/api/auth/session")).body.user.id).toBe(
      loggedIn.user.id,
    );
  });
  it("rejects callback from another browser, mismatched provider, expired flow and invalid tokens", async () => {
    const agent = request.agent(oauthApp);
    const state = await begin(agent);
    expect(
      (
        await request(oauthApp)
          .get("/api/auth/oauth/google/callback")
          .query({ state, code: "stolen" })
      ).headers.location,
    ).toContain("auth-error=invalid");
    expect(
      (
        await agent
          .get("/api/auth/oauth/apple/callback")
          .query({ state, code: "wrong-provider" })
      ).headers.location,
    ).toContain("auth-error=invalid");
    await pool.query(
      "UPDATE oauth_flows SET expires_at=now()-interval '1 minute'",
    );
    expect(
      (
        await agent
          .get("/api/auth/oauth/google/callback")
          .query({ state, code: "expired" })
      ).headers.location,
    ).toContain("auth-error=invalid");
    expect((await google(agent, "bad-token")).headers.location).toContain(
      "auth-error=failed",
    );
    expect((await agent.get("/api/auth/session")).body.user).toBe(null);
  });
  it("handles cancellation without creating an account", async () => {
    const agent = request.agent(oauthApp);
    const state = await begin(agent);
    expect(
      (
        await agent
          .get("/api/auth/oauth/google/callback")
          .query({ state, error: "access_denied" })
      ).headers.location,
    ).toContain("auth-error=cancelled");
    expect((await agent.get("/api/auth/session")).body.user).toBe(null);
  });
  it("bridges Apple cross-site POST without cookies, then requires the original session", async () => {
    const agent = request.agent(oauthApp);
    const state = await begin(agent, "apple");
    const staged = await request(oauthApp)
      .post("/api/auth/oauth/apple/callback")
      .type("form")
      .send({
        state,
        code: "apple-user",
        user: JSON.stringify({ email: "forged@example.test" }),
      })
      .expect(303);
    const location = new URL(staged.headers.location as string);
    expect(
      (await request(oauthApp).get(location.pathname + location.search)).headers
        .location,
    ).toContain("auth-error=invalid");
    await agent.get(location.pathname + location.search).expect(303);
    const result = (await agent.get("/api/auth/session")).body;
    expect(result.user.email).toBe("apple-user@example.test");
    expect(result.user.linkedProviders).toEqual(["apple"]);
  });
  it("does not automatically link a matching email; permits linking from an authenticated account", async () => {
    const local = await account();
    const guest = request.agent(oauthApp);
    const code = local.email.split("@")[0]!;
    expect((await google(guest, code)).headers.location).toContain(
      "auth-error=exists",
    );
    expect((await guest.get("/api/auth/session")).body.user).toBe(null);
    const authenticated = request.agent(oauthApp);
    const csrf = await session(authenticated);
    await post(authenticated, csrf, "login", {
      email: local.email,
      password,
    }).expect(200);
    expect((await google(authenticated, code)).headers.location).toContain(
      "auth-linked=1",
    );
    await google(guest, code);
    expect((await guest.get("/api/auth/session")).body.user.id).toBe(
      local.user.id,
    );
  });
  it("does not link an identity already owned by another account", async () => {
    const owner = request.agent(oauthApp);
    await google(owner, "owned-identity");
    const local = await account();
    const attacker = request.agent(oauthApp);
    const csrf = await session(attacker);
    await post(attacker, csrf, "login", {
      email: local.email,
      password,
    }).expect(200);
    expect(
      (await google(attacker, "owned-identity")).headers.location,
    ).toContain("auth-error=link");
    expect((await attacker.get("/api/auth/session")).body.user.id).toBe(
      local.user.id,
    );
  });
  it("allows OAuth users to set a password by email and delete their account", async () => {
    const agent = request.agent(oauthApp);
    await google(agent, "password-setup");
    const csrf = await session(agent);
    await post(agent, csrf, "request-reset", {
      email: "password-setup@example.test",
    }).expect(200);
    const token = mail.find(
      (item) =>
        item.email === "password-setup@example.test" &&
        item.purpose === "reset",
    )!.token;
    await post(agent, csrf, "reset", { token, password }).expect(200);
    const refreshed = await session(agent);
    const login = await post(agent, refreshed, "login", {
      email: "password-setup@example.test",
      password,
    }).expect(200);
    expect(login.body.user.hasPassword).toBe(true);
    await agent
      .delete("/api/account")
      .set("X-CSRF-Token", login.body.csrfToken as string)
      .send({ password })
      .expect(204);
    expect(
      (
        await pool.query(
          "SELECT * FROM oauth_identities WHERE subject='password-setup'",
        )
      ).rowCount,
    ).toBe(0);
  });
});

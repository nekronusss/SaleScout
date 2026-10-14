import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Router, urlencoded, type Request } from "express";
import {
  createRemoteJWKSet,
  importPKCS8,
  jwtVerify,
  SignJWT,
  type JWTVerifyGetKey,
} from "jose";
import type { Config } from "./config.js";
import type { Pool } from "./db.js";

export type Provider = "google" | "apple";
interface Flow {
  provider: Provider;
  state: string;
  nonce: string;
  verifier: string;
  expires: number;
  userId?: string;
  authVersion?: number;
}
declare module "express-session" {
  interface SessionData {
    oauth?: Flow;
  }
}
export interface Identity {
  subject: string;
  email?: string;
  name?: string;
}
export interface OAuthAdapter {
  authorize(provider: Provider, flow: Flow): string;
  exchange(provider: Provider, code: string, flow: Flow): Promise<Identity>;
}
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const providerOf = (value: unknown): Provider | null =>
  value === "google" || value === "apple" ? value : null;
const callback = (config: Config, provider: Provider) =>
  `${config.origin}/api/auth/oauth/${provider}/callback`;
const endpoints = {
  google: {
    authorize: "https://accounts.google.com/o/oauth2/v2/auth",
    token: "https://oauth2.googleapis.com/token",
    keys: "https://www.googleapis.com/oauth2/v3/certs",
    issuer: ["https://accounts.google.com", "accounts.google.com"],
  },
  apple: {
    authorize: "https://appleid.apple.com/auth/authorize",
    token: "https://appleid.apple.com/auth/token",
    keys: "https://appleid.apple.com/auth/keys",
    issuer: "https://appleid.apple.com",
  },
};

// Only signed, audience-bound ID tokens establish an identity. Access tokens and
// the unsigned Apple `user` form field are never used as proof of identity.
export async function verifyIdentity(
  token: string,
  provider: Provider,
  clientId: string,
  nonce: string,
  keys: JWTVerifyGetKey,
): Promise<Identity> {
  const { payload } = await jwtVerify(token, keys, {
    issuer: endpoints[provider].issuer,
    audience: clientId,
    algorithms: ["RS256"],
    requiredClaims: ["sub", "iat", "exp", "nonce"],
    clockTolerance: 5,
    maxTokenAge: "10m",
  });
  if (
    payload.nonce !== nonce ||
    !payload.sub ||
    (payload.azp !== undefined && payload.azp !== clientId)
  )
    throw new Error("Invalid identity binding");
  if (
    Array.isArray(payload.aud) &&
    payload.aud.length > 1 &&
    payload.azp !== clientId
  )
    throw new Error("Invalid authorized party");
  const email =
    typeof payload.email === "string"
      ? payload.email.trim().toLowerCase()
      : undefined;
  if (
    email &&
    (email.length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
      ![true, "true"].includes(payload.email_verified as boolean | string))
  )
    throw new Error("Unverified email");
  return {
    subject: payload.sub,
    email,
    name:
      typeof payload.name === "string" ? payload.name.slice(0, 80) : undefined,
  };
}

export function createOAuthAdapter(config: Config): OAuthAdapter {
  const keys = {
    google: createRemoteJWKSet(new URL(endpoints.google.keys), {
      timeoutDuration: 10000,
    }),
    apple: createRemoteJWKSet(new URL(endpoints.apple.keys), {
      timeoutDuration: 10000,
    }),
  };
  return {
    authorize(provider, flow) {
      const settings = config.oauth[provider];
      if (!settings) throw new Error("Provider unavailable");
      const url = new URL(endpoints[provider].authorize);
      url.search = new URLSearchParams({
        client_id: settings.clientId,
        redirect_uri: callback(config, provider),
        response_type: "code",
        scope: provider === "google" ? "openid email profile" : "email",
        state: flow.state,
        nonce: flow.nonce,
      }).toString();
      if (provider === "google") {
        url.searchParams.set(
          "code_challenge",
          createHash("sha256").update(flow.verifier).digest("base64url"),
        );
        url.searchParams.set("code_challenge_method", "S256");
        url.searchParams.set("prompt", "select_account");
      } else url.searchParams.set("response_mode", "form_post");
      return url.href;
    },
    async exchange(provider, code, flow) {
      const settings = config.oauth[provider];
      if (!settings) throw new Error("Provider unavailable");
      let secret: string;
      if (provider === "apple") {
        const apple = config.oauth.apple!;
        const key = await importPKCS8(apple.privateKey, "ES256");
        secret = await new SignJWT({})
          .setProtectedHeader({ alg: "ES256", kid: apple.keyId })
          .setIssuer(apple.teamId)
          .setSubject(apple.clientId)
          .setAudience("https://appleid.apple.com")
          .setIssuedAt()
          .setExpirationTime("5m")
          .sign(key);
      } else secret = config.oauth.google!.clientSecret;
      const body = new URLSearchParams({
        grant_type: "authorization_code",
        client_id: settings.clientId,
        client_secret: secret,
        redirect_uri: callback(config, provider),
        code,
      });
      if (provider === "google") body.set("code_verifier", flow.verifier);
      const response = await fetch(endpoints[provider].token, {
        method: "POST",
        body,
        signal: AbortSignal.timeout(10000),
        redirect: "error",
      });
      if (!response.ok) throw new Error("Provider exchange rejected");
      const result: unknown = await response.json();
      if (
        !result ||
        typeof result !== "object" ||
        !("id_token" in result) ||
        typeof result.id_token !== "string"
      )
        throw new Error("Missing identity token");
      return verifyIdentity(
        result.id_token,
        provider,
        settings.clientId,
        flow.nonce,
        keys[provider],
      );
    },
  };
}

export function createOAuthRoutes(
  pool: Pool,
  config: Config,
  adapter = createOAuthAdapter(config),
) {
  const router = Router();
  const fail = (reason: string) => `${config.origin}/#auth-error=${reason}`;
  const save = (req: Request) =>
    new Promise<void>((resolve, reject) =>
      req.session.save((error) => (error ? reject(error) : resolve())),
    );

  router.post("/:provider/start", async (req, res) => {
    const provider = providerOf(req.params.provider);
    if (!provider || !config.oauth[provider]) {
      res.status(503).json({ error: "Этот способ входа пока недоступен." });
      return;
    }
    if (req.session.oauth)
      await pool.query("DELETE FROM oauth_flows WHERE state_hash=$1", [
        hash(req.session.oauth.state),
      ]);
    const flow: Flow = {
      provider,
      state: randomBytes(32).toString("hex"),
      nonce: randomBytes(32).toString("hex"),
      verifier: randomBytes(32).toString("base64url"),
      expires: Date.now() + 600000,
      userId: req.session.userId,
      authVersion: req.session.authVersion,
    };
    await pool.query(
      "INSERT INTO oauth_flows(state_hash,expires_at) VALUES ($1,$2)",
      [hash(flow.state), new Date(flow.expires)],
    );
    req.session.oauth = flow;
    await save(req);
    res.json({ url: adapter.authorize(provider, flow) });
  });

  // Apple posts cross-site, where SameSite=Lax deliberately omits the session.
  // Stage the code, then redirect to a GET that MUST prove the original browser
  // session before consuming the flow. Never authenticate on the POST itself.
  router.post(
    "/apple/callback",
    urlencoded({ extended: false, limit: "16kb", parameterLimit: 10 }),
    async (req, res) => {
      const { state, code, error } = req.body ?? {};
      if (
        !config.oauth.apple ||
        typeof state !== "string" ||
        !/^[a-f0-9]{64}$/.test(state) ||
        (typeof code !== "string" && typeof error !== "string") ||
        (typeof code === "string" && code.length > 4096)
      ) {
        res.redirect(303, fail("invalid"));
        return;
      }
      const result = await pool.query(
        "UPDATE oauth_flows SET code=$1,error=$2 WHERE state_hash=$3 AND expires_at > now() AND code IS NULL AND error IS NULL RETURNING state_hash",
        [
          typeof code === "string" ? code : null,
          error ? "cancelled" : null,
          hash(state),
        ],
      );
      if (!result.rowCount) {
        res.redirect(303, fail("invalid"));
        return;
      }
      res.redirect(303, `${callback(config, "apple")}?state=${state}`);
    },
  );

  router.get("/:provider/callback", async (req, res) => {
    const provider = providerOf(req.params.provider);
    const flow = req.session.oauth;
    if (
      !provider ||
      !config.oauth[provider] ||
      !flow ||
      flow.provider !== provider ||
      typeof req.query.state !== "string" ||
      flow.state !== req.query.state ||
      flow.expires < Date.now()
    ) {
      res.redirect(303, fail("invalid"));
      return;
    }
    delete req.session.oauth;
    await save(req);
    const consumed = await pool.query<{
      code: string | null;
      error: string | null;
    }>(
      "DELETE FROM oauth_flows WHERE state_hash=$1 AND expires_at > now() RETURNING code,error",
      [hash(flow.state)],
    );
    const stored = consumed.rows[0];
    if (!stored) {
      res.redirect(303, fail("invalid"));
      return;
    }
    if (req.query.error || stored.error) {
      res.redirect(303, fail("cancelled"));
      return;
    }
    const code = provider === "apple" ? stored.code : req.query.code;
    if (typeof code !== "string" || !code || code.length > 4096) {
      res.redirect(303, fail("invalid"));
      return;
    }
    try {
      const identity = await adapter.exchange(provider, code, flow);
      const client = await pool.connect();
      let user: { id: string; auth_version: number };
      try {
        await client.query("BEGIN");
        // Serialize creation/linking of the same provider identity or email.
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
          [`${provider}:${identity.subject}`],
        );
        if (identity.email)
          await client.query(
            "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
            [`email:${identity.email}`],
          );
        const existing = await client.query<{
          id: string;
          auth_version: number;
        }>(
          "SELECT u.id,u.auth_version FROM oauth_identities i JOIN users u ON u.id=i.user_id WHERE i.provider=$1 AND i.subject=$2 AND u.verified=true",
          [provider, identity.subject],
        );
        if (flow.userId) {
          const current = await client.query<{
            id: string;
            auth_version: number;
          }>(
            "SELECT id,auth_version FROM users WHERE id=$1 AND auth_version=$2 AND verified=true FOR UPDATE",
            [flow.userId, flow.authVersion],
          );
          if (
            req.session.userId !== flow.userId ||
            !current.rows[0] ||
            (existing.rows[0] && existing.rows[0].id !== flow.userId)
          )
            throw new Error("link");
          user = current.rows[0];
          await client.query(
            "INSERT INTO oauth_identities(provider,subject,user_id) VALUES ($1,$2,$3) ON CONFLICT (provider,subject) DO NOTHING",
            [provider, identity.subject, user.id],
          );
        } else if (existing.rows[0]) user = existing.rows[0];
        else {
          if (!identity.email) throw new Error("email");
          const created = await client.query<{
            id: string;
            auth_version: number;
          }>(
            "INSERT INTO users(id,email,name,verified) VALUES ($1,$2,$3,true) ON CONFLICT(email) DO NOTHING RETURNING id,auth_version",
            [
              randomUUID(),
              identity.email,
              identity.name?.trim() ||
                identity.email.split("@")[0]!.slice(0, 80),
            ],
          );
          if (!created.rows[0]) throw new Error("exists");
          user = created.rows[0];
          await client.query("INSERT INTO catalogs(user_id) VALUES ($1)", [
            user.id,
          ]);
          await client.query(
            "INSERT INTO oauth_identities(provider,subject,user_id) VALUES ($1,$2,$3)",
            [provider, identity.subject, user.id],
          );
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      await new Promise<void>((resolve, reject) =>
        req.session.regenerate((error) => (error ? reject(error) : resolve())),
      );
      req.session.userId = user.id;
      req.session.authVersion = user.auth_version;
      req.session.csrf = randomBytes(32).toString("hex");
      await save(req);
      res.redirect(
        303,
        `${config.origin}/${flow.userId ? "#auth-linked=1" : ""}`,
      );
    } catch (error) {
      const reason =
        error instanceof Error &&
        ["exists", "link", "email"].includes(error.message)
          ? error.message
          : "failed";
      res.redirect(303, fail(reason));
    }
  });
  return router;
}

import { describe, expect, it, beforeAll } from "vitest";
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type JWTPayload,
} from "jose";
import { verifyIdentity, createOAuthAdapter } from "../server/oauth";
import { readConfig } from "../server/config";

let pair: Awaited<ReturnType<typeof generateKeyPair>>;
let keys: ReturnType<typeof createLocalJWKSet>;
beforeAll(async () => {
  pair = await generateKeyPair("RS256");
  keys = createLocalJWKSet({
    keys: [{ ...(await exportJWK(pair.publicKey)), kid: "test" }],
  });
});
async function token(overrides: JWTPayload = {}) {
  return new SignJWT({
    sub: "subject-123",
    iss: "https://accounts.google.com",
    aud: "client",
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 300,
    nonce: "nonce",
    email: "person@example.test",
    email_verified: true,
    ...overrides,
  })
    .setProtectedHeader({ alg: "RS256", kid: "test" })
    .sign(pair.privateKey);
}
describe("OIDC identity verification", () => {
  it("accepts a signed Google identity and Apple's string email_verified", async () => {
    expect(
      (await verifyIdentity(await token(), "google", "client", "nonce", keys))
        .subject,
    ).toBe("subject-123");
    expect(
      (
        await verifyIdentity(
          await token({
            iss: "https://appleid.apple.com",
            email_verified: "true",
          }),
          "apple",
          "client",
          "nonce",
          keys,
        )
      ).email,
    ).toBe("person@example.test");
  });
  it.each([
    { iss: "https://evil.example" },
    { aud: "other-app" },
    { exp: 1 },
    { nonce: "other-browser" },
    { email_verified: false },
    { azp: "other-app" },
    { aud: ["client", "other"] },
    { sub: "" },
  ])("rejects invalid identity claims: %j", async (overrides) => {
    await expect(
      verifyIdentity(await token(overrides), "google", "client", "nonce", keys),
    ).rejects.toThrow();
  });
  it("rejects signatures from a different key", async () => {
    const other = await generateKeyPair("RS256");
    const otherKeys = createLocalJWKSet({
      keys: [{ ...(await exportJWK(other.publicKey)), kid: "test" }],
    });
    await expect(
      verifyIdentity(await token(), "google", "client", "nonce", otherKeys),
    ).rejects.toThrow();
  });
  it("builds exact callbacks, Google PKCE and Apple form_post", () => {
    const config = readConfig({
      DATABASE_URL: "postgres://test",
      SESSION_SECRET: "test".repeat(10),
      APP_ORIGIN: "https://salescout.example",
      GOOGLE_CLIENT_ID: "google",
      GOOGLE_CLIENT_SECRET: "secret",
      APPLE_CLIENT_ID: "apple",
      APPLE_TEAM_ID: "team",
      APPLE_KEY_ID: "key",
      APPLE_PRIVATE_KEY: "test",
    });
    const adapter = createOAuthAdapter(config);
    const flow = {
      provider: "google" as const,
      state: "state",
      nonce: "nonce",
      verifier: "verifier",
      expires: Date.now() + 1000,
    };
    const google = new URL(adapter.authorize("google", flow));
    expect(google.searchParams.get("redirect_uri")).toBe(
      "https://salescout.example/api/auth/oauth/google/callback",
    );
    expect(google.searchParams.get("code_challenge_method")).toBe("S256");
    expect(google.searchParams.get("code_challenge")).not.toBe("verifier");
    expect(google.searchParams.has("client_secret")).toBe(false);
    const apple = new URL(adapter.authorize("apple", flow));
    expect(apple.searchParams.get("response_mode")).toBe("form_post");
    expect(apple.searchParams.get("nonce")).toBe("nonce");
  });
  it("fails incomplete provider configuration and localhost Apple setup", () => {
    const base = {
      DATABASE_URL: "postgres://test",
      SESSION_SECRET: "test".repeat(10),
    };
    expect(() => readConfig({ ...base, GOOGLE_CLIENT_ID: "client" })).toThrow(
      "GOOGLE_CLIENT_SECRET",
    );
    expect(() =>
      readConfig({
        ...base,
        APPLE_CLIENT_ID: "client",
        APPLE_KEY_ID: "key",
        APPLE_TEAM_ID: "team",
        APPLE_PRIVATE_KEY: "key",
      }),
    ).toThrow("public HTTPS domain");
  });
});

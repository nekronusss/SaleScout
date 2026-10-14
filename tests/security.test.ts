import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../server/passwords";
import { readConfig } from "../server/config";

const environment = {
  DATABASE_URL: "postgres://localhost/test",
  SESSION_SECRET: "test-secret-long-enough-for-configuration-checks",
};
describe("Security configuration", () => {
  it("uses unique password salts and verifies only the correct password", async () => {
    const first = await hashPassword("my-password-123");
    const second = await hashPassword("my-password-123");
    expect(first).not.toEqual(second);
    expect(await verifyPassword("my-password-123", first)).toBe(true);
    expect(await verifyPassword("wrong", first)).toBe(false);
    expect(await verifyPassword("anything", "invalid")).toBe(false);
  });
  it("rejects missing or weak session secrets", () => {
    expect(() =>
      readConfig({ DATABASE_URL: environment.DATABASE_URL }),
    ).toThrow("SESSION_SECRET");
    expect(() =>
      readConfig({ ...environment, SESSION_SECRET: "short" }),
    ).toThrow("32");
  });
  it("requires HTTPS and SMTP in production", () => {
    expect(() =>
      readConfig({ ...environment, NODE_ENV: "production" }),
    ).toThrow("HTTPS");
    expect(() =>
      readConfig({
        ...environment,
        NODE_ENV: "production",
        APP_ORIGIN: "https://example.test",
      }),
    ).toThrow("SMTP_HOST");
    const config = readConfig({
      ...environment,
      NODE_ENV: "production",
      APP_ORIGIN: "https://example.test",
      SMTP_HOST: "smtp.example.test",
      SMTP_FROM: "noreply@example.test",
    });
    expect(config.secureCookies).toBe(true);
    expect(config.trustProxy).toBe(0);
  });
});

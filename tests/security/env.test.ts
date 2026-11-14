import { describe, expect, it } from "vitest";
import { parseEnv } from "../../src/lib/env";

const base = {
  DATABASE_URL: "postgresql://hr_runtime:pw@localhost:5432/hr_recruitment",
  MIGRATION_DATABASE_URL: "postgresql://hr_app:pw@localhost:5432/hr_recruitment",
  AUTH_SECRET: "x".repeat(40),
  APP_ORIGIN: "http://localhost:3000",
};

describe("environment settings", () => {
  it("applies the approved defaults", () => {
    const env = parseEnv(base);
    expect(env.SESSION_IDLE_MINUTES).toBe(60);
    expect(env.SESSION_ABSOLUTE_HOURS).toBe(12);
    expect(env.SESSION_TOUCH_INTERVAL_SECONDS).toBe(60);
    expect(env.TRUSTED_PROXY_HOPS).toBe(0);
    expect(env.LOGIN_ATTEMPT_RETENTION_DAYS).toBe(14);
  });
  it("refuses to run the app as the owner account", () => {
    expect(() => parseEnv({ ...base, DATABASE_URL: "postgresql://hr_app:pw@localhost:5432/hr_recruitment" })).toThrow(/restricted runtime account/);
  });
  it("requires the migration URL, if given, to be the owner account", () => {
    expect(() => parseEnv({ ...base, MIGRATION_DATABASE_URL: "postgresql://hr_runtime:pw@localhost:5432/x" })).toThrow(/owner account/);
  });
  it("rejects a short secret and never prints values", () => {
    try {
      parseEnv({ ...base, AUTH_SECRET: "short" });
      throw new Error("should have thrown");
    } catch (e: any) {
      expect(e.message).toMatch(/AUTH_SECRET/);
      expect(e.message).not.toContain("short");
    }
  });
  it("rejects absolute timeout shorter than idle timeout", () => {
    expect(() => parseEnv({ ...base, SESSION_IDLE_MINUTES: "180", SESSION_ABSOLUTE_HOURS: "1" })).toThrow(/absolute/);
  });
  it("requires https in production and limits proxy hops", () => {
    expect(() => parseEnv({ ...base, NODE_ENV: "production" })).toThrow(/https/);
    expect(parseEnv({ ...base, NODE_ENV: "production", APP_ORIGIN: "https://hr.example.com" }).NODE_ENV).toBe("production");
    expect(() => parseEnv({ ...base, TRUSTED_PROXY_HOPS: "9" })).toThrow();
  });
});

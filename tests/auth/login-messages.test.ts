import { describe, expect, it } from "vitest";
import {
  checkLoginInput,
  formatWait,
  GENERIC_ERROR_MESSAGE,
  interpretLoginResponse,
  safeDestination,
} from "@/lib/auth/login-messages";

describe("login messages", () => {
  it("rounds waiting time UP to whole minutes", () => {
    expect(formatWait(1)).toBe("1 minute");
    expect(formatWait(60)).toBe("1 minute");
    expect(formatWait(61)).toBe("2 minutes");
    expect(formatWait(895)).toBe("15 minutes");
    for (const odd of [0, -5, NaN, Infinity, "10", null, undefined]) expect(formatWait(odd)).toBe("a few minutes");
  });
  it("success goes to the server's destination, but only if it is a plain local path", () => {
    expect(interpretLoginResponse(200, { redirectTo: "/jobs?x=1" })).toEqual({ kind: "success", redirectTo: "/jobs?x=1" });
    for (const bad of ["//evil.com", "https://evil.com", "/\\evil.com", "javascript:alert(1)", "", 5, null, undefined, "/a\nb", "/" + "a".repeat(600)]) {
      expect(interpretLoginResponse(200, { redirectTo: bad })).toEqual({ kind: "success", redirectTo: "/dashboard" });
      expect(safeDestination(bad)).toBe("/dashboard");
    }
    expect(interpretLoginResponse(200, null)).toEqual({ kind: "success", redirectTo: "/dashboard" });
  });
  it("wrong password and unknown account show exactly the same message", () => {
    const a = interpretLoginResponse(401, { error: "invalid_credentials" });
    const b = interpretLoginResponse(401, {});
    expect(a).toEqual(b);
    expect(a.kind).toBe("error");
  });
  it("tells a locked-out person how long to wait", () => {
    const r = interpretLoginResponse(429, { error: "too_many_attempts", retryAfterSeconds: 895 });
    expect(r).toMatchObject({ kind: "error" });
    expect((r as { message: string }).message).toContain("15 minutes");
    expect((interpretLoginResponse(429, {}) as { message: string }).message).toContain("a few minutes");
  });
  it("has a clear message for each refusal, and a safe generic one for everything else", () => {
    const messages = new Set([400, 401, 403, 429, 500].map((s) => (interpretLoginResponse(s, {}) as { message: string }).message));
    expect(messages.size).toBe(5);
    for (const status of [413, 415, 500, 502, 503, 0]) {
      expect(interpretLoginResponse(status, { error: "boom", detail: "secret" })).toEqual({ kind: "error", message: GENERIC_ERROR_MESSAGE });
    }
  });
  it("never repeats text from the server's answer", () => {
    const r = interpretLoginResponse(500, { error: "server_error", message: "password=hunter2" }) as { message: string };
    expect(r.message).not.toContain("hunter2");
  });
  it("checks empty or obviously wrong input before sending", () => {
    expect(checkLoginInput("", "x")).not.toBeNull();
    expect(checkLoginInput("a@b.co", "")).not.toBeNull();
    expect(checkLoginInput("   ", "x")).not.toBeNull();
    expect(checkLoginInput("no-at-sign", "x")).toMatch(/valid email/);
    expect(checkLoginInput(" a@b.co ", "pw")).toBeNull();
  });
});

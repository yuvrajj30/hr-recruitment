import { describe, expect, it } from "vitest";
import { createLogger, redact } from "../../src/lib/security/logger";
import { generateSessionToken } from "../../src/lib/security/tokens";

describe("logger redaction", () => {
  it("hides sensitive field names at any depth", () => {
    const out = redact({ user: "a", password: "hunter2", nested: { sessionToken: "x", apiKey: "k", inner: { Authorization: "Bearer z" } } }) as any;
    expect(out.user).toBe("a");
    expect(out.password).toBe("[redacted]");
    expect(out.nested.sessionToken).toBe("[redacted]");
    expect(out.nested.apiKey).toBe("[redacted]");
    expect(out.nested.inner.Authorization).toBe("[redacted]");
  });
  it("hides token-looking text inside ordinary strings", () => {
    const token = generateSessionToken();
    const out = redact({ note: `cookie was ${token} ok` }) as any;
    expect(out.note).not.toContain(token);
    expect(out.note).toContain("[redacted-token]");
  });
  it("keeps normal ids readable", () => {
    expect(redact({ id: "0194a8e0-7b3c-7d41-9a52-3f6a1b2c3d4e" })).toEqual({ id: "0194a8e0-7b3c-7d41-9a52-3f6a1b2c3d4e" });
  });
  it("handles circular objects, errors and does not change the input", () => {
    const a: any = { name: "a", secretValue: "s" };
    a.self = a;
    const out = redact(a) as any;
    expect(out.self).toBe("[circular]");
    expect(a.secretValue).toBe("s");
    expect((redact(new Error(`boom ${generateSessionToken()}`)) as any).message).toContain("[redacted-token]");
  });
  it("writes one JSON line with no secrets", () => {
    const lines: string[] = [];
    const log = createLogger((l) => lines.push(l));
    log.warn("login.failed", { email: "a@b.c", password: "pw", ip: "1.2.3.4" });
    const parsed = JSON.parse(lines[0]!);
    expect(parsed).toMatchObject({ level: "warn", event: "login.failed", ip: "1.2.3.4", password: "[redacted]" });
    expect(lines[0]).not.toContain('"pw"');
  });
});

import { describe, expect, it } from "vitest";
import { loginBodySchema, switchOrganizationBodySchema } from "@/lib/auth/schemas";

const parse = (v: unknown) => loginBodySchema.safeParse(v);

describe("login request shape", () => {
  it("accepts an email and a password", () => {
    const r = parse({ email: "hr@example.com", password: "whatever" });
    expect(r.success).toBe(true);
  });
  it("trims and lower-cases the email but leaves the password exactly as typed", () => {
    const r = parse({ email: "  Hr.Person@Example.COM ", password: "  Spaces And CAPS  " });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.email).toBe("hr.person@example.com");
      expect(r.data.password).toBe("  Spaces And CAPS  ");
    }
  });
  it("rejects things that are not an email", () => {
    for (const email of ["", "   ", "nope", "a@", "@b.com", "a b@c.com", "x".repeat(250) + "@example.com"]) {
      expect(parse({ email, password: "pw" }).success, email).toBe(false);
    }
  });
  it("rejects an empty or very long password", () => {
    expect(parse({ email: "a@example.com", password: "" }).success).toBe(false);
    expect(parse({ email: "a@example.com", password: "x".repeat(1025) }).success).toBe(false);
    expect(parse({ email: "a@example.com", password: "x".repeat(1024) }).success).toBe(true);
  });
  it("rejects missing fields, wrong types and unexpected extra fields", () => {
    for (const body of [
      {},
      { email: "a@example.com" },
      { password: "pw" },
      { email: 5, password: "pw" },
      { email: "a@example.com", password: 5 },
      { email: "a@example.com", password: "pw", isPlatformAdmin: true },
      null,
      "text",
      [],
    ]) {
      expect(parse(body).success, JSON.stringify(body)).toBe(false);
    }
  });
});

describe("login request: the optional 'next' page", () => {
  it("is optional, and must be a string of reasonable length", () => {
    expect(parse({ email: "a@example.com", password: "pw", next: "/jobs" }).success).toBe(true);
    expect(parse({ email: "a@example.com", password: "pw", next: 5 }).success).toBe(false);
    expect(parse({ email: "a@example.com", password: "pw", next: "/" + "a".repeat(600) }).success).toBe(false);
  });
});

describe("switch organization request", () => {
  const ok = (v: unknown) => switchOrganizationBodySchema.safeParse(v).success;
  it("needs exactly one organization id that is a UUID", () => {
    expect(ok({ organizationId: "0192f0aa-1b2c-7d3e-8f40-123456789abc" })).toBe(true);
    expect(ok({ organizationId: "4f9c2a4e-6c1f-4c0e-9a3b-0e8f1d2c3b4a" })).toBe(true);
    for (const bad of [{}, { organizationId: "123" }, { organizationId: "" }, { organizationId: 5 }, null, [], { organizationId: "4f9c2a4e-6c1f-4c0e-9a3b-0e8f1d2c3b4a", extra: 1 }]) {
      expect(ok(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});


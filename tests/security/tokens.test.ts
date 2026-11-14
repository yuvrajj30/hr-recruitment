import { describe, expect, it } from "vitest";
import { generateSessionToken, hashIdentifier, hashToken, isWellFormedToken, safeEqual } from "../../src/lib/security/tokens";

describe("session tokens", () => {
  it("creates unique 43-character url-safe tokens", () => {
    const tokens = new Set(Array.from({ length: 500 }, generateSessionToken));
    expect(tokens.size).toBe(500);
    for (const t of tokens) expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
  it("stores only a hash that differs from the token", () => {
    const t = generateSessionToken();
    expect(hashToken(t)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(t)).not.toContain(t);
    expect(hashToken(t)).toBe(hashToken(t));
    expect(hashToken(t)).not.toBe(hashToken(generateSessionToken()));
  });
  it("rejects malformed cookie values before any database lookup", () => {
    expect(isWellFormedToken(generateSessionToken())).toBe(true);
    for (const bad of ["", "abc", "a".repeat(44), "a".repeat(42) + "!", undefined, null, 5, "a b" + "c".repeat(40)]) {
      expect(isWellFormedToken(bad)).toBe(false);
    }
  });
  it("hashes login identifiers with a secret and ignores case and spaces", () => {
    const secret = "s".repeat(40);
    expect(hashIdentifier(" Admin@Example.com ", secret)).toBe(hashIdentifier("admin@example.com", secret));
    expect(hashIdentifier("admin@example.com", secret)).not.toBe(hashIdentifier("admin@example.com", "t".repeat(40)));
    expect(hashIdentifier("admin@example.com", secret)).not.toContain("admin");
  });
  it("compares strings safely", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });
});

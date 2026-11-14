import { describe, expect, it } from "vitest";
import { buildClearedSessionCookie, buildSessionCookie, readSessionToken, sessionCookieName } from "@/lib/auth/cookies";
import { generateSessionToken } from "@/lib/security/tokens";

const HTTPS = "https://hr.example.com";
const HTTP = "http://localhost:3000";
const now = new Date("2026-11-14T10:00:00.000Z");
const hard = new Date("2026-11-14T22:00:00.000Z"); // 12 hours later
const token = generateSessionToken();

describe("cookie name", () => {
  it("uses the __Host- prefix on https", () => expect(sessionCookieName(HTTPS)).toBe("__Host-hr_session"));
  it("uses a plain name on local http (browsers reject __Host- without https)", () =>
    expect(sessionCookieName(HTTP)).toBe("hr_session"));
});

describe("session cookie flags (https)", () => {
  const c = buildSessionCookie({ appOrigin: HTTPS, token, absoluteExpiresAt: hard, now });
  it("carries the token under the __Host- name", () => expect(c.startsWith(`__Host-hr_session=${token};`)).toBe(true));
  it("is HttpOnly, Secure, SameSite=Lax and Path=/", () => {
    for (const flag of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/"]) expect(c).toContain(flag);
  });
  it("has no Domain attribute (required for __Host-, keeps it to this exact host)", () =>
    expect(c.toLowerCase()).not.toContain("domain="));
  it("lasts until the hard deadline", () => {
    expect(c).toContain("Max-Age=43200");
    expect(c).toContain(`Expires=${hard.toUTCString()}`);
  });
  it("never has a negative lifetime", () => {
    const past = buildSessionCookie({ appOrigin: HTTPS, token, absoluteExpiresAt: new Date(0), now });
    expect(past).toContain("Max-Age=0");
  });
});

describe("session cookie flags (local http)", () => {
  const c = buildSessionCookie({ appOrigin: HTTP, token, absoluteExpiresAt: hard, now });
  it("is HttpOnly and SameSite=Lax but not Secure", () => {
    expect(c).toContain("HttpOnly");
    expect(c).toContain("SameSite=Lax");
    expect(c).not.toContain("Secure");
    expect(c.startsWith(`hr_session=${token};`)).toBe(true);
  });
});

describe("refusing bad tokens", () => {
  it("will not write anything that is not a real token (no header injection)", () => {
    for (const bad of ["", "short", `${token}\r\nSet-Cookie: evil=1`, `${token}; Domain=evil.com`, "a".repeat(44)]) {
      expect(() => buildSessionCookie({ appOrigin: HTTPS, token: bad, absoluteExpiresAt: hard, now })).toThrow();
    }
  });
});

describe("clearing the cookie", () => {
  it("expires it immediately with the same name and flags", () => {
    const c = buildClearedSessionCookie(HTTPS);
    expect(c.startsWith("__Host-hr_session=;")).toBe(true);
    for (const flag of ["Max-Age=0", "Expires=Thu, 01 Jan 1970 00:00:00 GMT", "HttpOnly", "Secure", "SameSite=Lax", "Path=/"]) {
      expect(c).toContain(flag);
    }
  });
});

describe("reading the token from a request", () => {
  it("finds it among other cookies", () => {
    const header = `theme=dark; __Host-hr_session=${token}; other=1`;
    expect(readSessionToken(header, HTTPS)).toBe(token);
  });
  it("returns null when absent or empty", () => {
    expect(readSessionToken(null, HTTPS)).toBeNull();
    expect(readSessionToken(undefined, HTTPS)).toBeNull();
    expect(readSessionToken("", HTTPS)).toBeNull();
    expect(readSessionToken("theme=dark", HTTPS)).toBeNull();
  });
  it("ignores a cookie with the wrong name (the plain name is not accepted on https)", () => {
    expect(readSessionToken(`hr_session=${token}`, HTTPS)).toBeNull();
  });
  it("returns null for anything not shaped like a real token", () => {
    for (const bad of ["abc", "a".repeat(42), "a".repeat(44), `${token.slice(0, 42)}!`]) {
      expect(readSessionToken(`__Host-hr_session=${bad}`, HTTPS)).toBeNull();
    }
  });
  it("uses the first cookie of that name and does not fall through to a later one", () => {
    const other = generateSessionToken();
    expect(readSessionToken(`__Host-hr_session=junk; __Host-hr_session=${other}`, HTTPS)).toBeNull();
    expect(readSessionToken(`__Host-hr_session=${token}; __Host-hr_session=${other}`, HTTPS)).toBe(token);
  });
  it("works for the plain name on local http", () => {
    expect(readSessionToken(`hr_session=${token}`, HTTP)).toBe(token);
  });
});

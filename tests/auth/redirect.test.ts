import { describe, expect, it } from "vitest";
import { sanitizeRedirectPath } from "@/lib/auth/redirect";

const FALLBACK = "/dashboard";

describe("safe redirect after login", () => {
  it("keeps ordinary paths inside the app", () => {
    expect(sanitizeRedirectPath("/dashboard")).toBe("/dashboard");
    expect(sanitizeRedirectPath("/jobs")).toBe("/jobs");
    expect(sanitizeRedirectPath("/jobs/123/edit")).toBe("/jobs/123/edit");
    expect(sanitizeRedirectPath("/jobs?status=open&page=2")).toBe("/jobs?status=open&page=2");
  });
  it("drops the #fragment", () => expect(sanitizeRedirectPath("/jobs#top")).toBe("/jobs"));

  it("rejects addresses that lead to another site", () => {
    for (const bad of [
      "//evil.com",
      "///evil.com",
      "/\\evil.com",
      "\\\\evil.com",
      "https://evil.com",
      "http://evil.com/x",
      "javascript:alert(1)",
      "data:text/html,hi",
      "mailto:a@b.c",
    ]) {
      expect(sanitizeRedirectPath(bad), bad).toBe(FALLBACK);
    }
  });
  it("rejects hidden tab/newline/space tricks that parsers turn into //", () => {
    for (const bad of ["/\t/evil.com", "/\n/evil.com", "/\r/evil.com", "/ /evil.com", "/\u0000/evil.com", "/jobs\u007f"]) {
      expect(sanitizeRedirectPath(bad), JSON.stringify(bad)).toBe(FALLBACK);
    }
  });
  it("rejects values that are not a path", () => {
    for (const bad of ["", "dashboard", "jobs/1", "?next=/x", "#x", null, undefined, 42, {}, ["/jobs"]]) {
      expect(sanitizeRedirectPath(bad as unknown)).toBe(FALLBACK);
    }
  });
  it("rejects very long values", () => {
    expect(sanitizeRedirectPath("/" + "a".repeat(600))).toBe(FALLBACK);
    expect(sanitizeRedirectPath("/" + "a".repeat(100))).toBe("/" + "a".repeat(100));
  });
  it("never sends the user back to the login page or to an API address", () => {
    for (const bad of ["/login", "/login?next=/jobs", "/login/", "/api", "/api/auth/logout", "/api?x=1"]) {
      expect(sanitizeRedirectPath(bad), bad).toBe(FALLBACK);
    }
    expect(sanitizeRedirectPath("/loginhelp")).toBe("/loginhelp");
    expect(sanitizeRedirectPath("/apply")).toBe("/apply");
  });
  it("treats encoded slashes as ordinary path text, not as a new host", () => {
    expect(sanitizeRedirectPath("/%2F%2Fevil.com")).toBe("/%2F%2Fevil.com");
  });
  it("normalises dot segments so they cannot climb out", () => {
    expect(sanitizeRedirectPath("/jobs/../dashboard")).toBe("/dashboard");
    expect(sanitizeRedirectPath("/../../etc/passwd")).toBe("/etc/passwd");
  });
  it("uses a custom fallback when given", () => {
    expect(sanitizeRedirectPath("//evil.com", "/home")).toBe("/home");
  });
});

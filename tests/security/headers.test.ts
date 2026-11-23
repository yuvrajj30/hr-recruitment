import { describe, expect, it } from "vitest";
import { contentSecurityPolicy, securityHeaders } from "@/lib/security/headers";

const directives = (csp: string) => Object.fromEntries(csp.split(";").map((d) => d.trim().split(/\s+/)).map(([k, ...v]) => [k!, v]));
const PROD = { isDev: false, isProduction: true };
const DEV = { isDev: true, isProduction: false };

describe("security headers", () => {
  it("hardens every response and adds HSTS only in production", () => {
    const keys = (o: typeof PROD) => securityHeaders(o).map((h) => h.key);
    expect(keys(DEV)).toEqual(expect.arrayContaining(["Content-Security-Policy", "X-Content-Type-Options", "X-Frame-Options", "Referrer-Policy", "Permissions-Policy"]));
    expect(keys(DEV)).not.toContain("Strict-Transport-Security");
    expect(keys(PROD)).toContain("Strict-Transport-Security");
    expect(securityHeaders(PROD).find((h) => h.key === "Content-Security-Policy")!.value).toBe(contentSecurityPolicy(PROD));
  });

  it("keeps every kind of resource on this site and blocks eval, plugins, frames and framing in production", () => {
    const csp = directives(contentSecurityPolicy(PROD));
    for (const [k, v] of Object.entries(csp)) {
      expect(v, k).not.toContain("'unsafe-eval'");
      expect(v.some((s) => s === "*" || /^(https?|wss?):/.test(s) || s === "https:" || s === "data:" && !["img-src"].includes(k)), `${k} allows another site`).toBe(false);
    }
    expect(csp["default-src"]).toEqual(["'self'"]);
    expect(csp["script-src"]).toEqual(["'self'", "'unsafe-inline'"]);
    expect(csp["connect-src"]).toEqual(["'self'"]);
    expect(csp["object-src"]).toEqual(["'none'"]);
    expect(csp["frame-src"]).toEqual(["'none'"]);
    expect(csp["frame-ancestors"]).toEqual(["'none'"]);
    expect(csp["base-uri"]).toEqual(["'self'"]);
    expect(csp["form-action"]).toEqual(["'self'"]);
    expect(csp["upgrade-insecure-requests"]).toEqual([]);
  });

  it("adds eval and the hot-reload websocket only in development", () => {
    const csp = directives(contentSecurityPolicy(DEV));
    expect(csp["script-src"]).toContain("'unsafe-eval'");
    expect(csp["connect-src"]).toEqual(["'self'", "ws:", "wss:"]);
    expect(csp["upgrade-insecure-requests"]).toBeUndefined();
  });
});

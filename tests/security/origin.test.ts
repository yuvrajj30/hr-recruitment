import { describe, expect, it } from "vitest";
import { checkSameOrigin } from "../../src/lib/security/origin";

const APP = "https://hr.example.com";
const req = (method: string, headers: Record<string, string> = {}) => ({
  method,
  headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
});

describe("cross-site request check", () => {
  it("allows reads", () => expect(checkSameOrigin(req("GET"), APP).ok).toBe(true));
  it("allows changes from our own origin", () => {
    expect(checkSameOrigin(req("POST", { origin: APP }), APP).ok).toBe(true);
    expect(checkSameOrigin(req("DELETE", { origin: "https://hr.example.com" }), APP).ok).toBe(true);
  });
  it("blocks changes from other origins", () => {
    for (const origin of ["https://evil.example", "http://hr.example.com", "https://hr.example.com.evil.io", "null"]) {
      expect(checkSameOrigin(req("POST", { origin }), APP).ok).toBe(false);
    }
  });
  it("falls back to Sec-Fetch-Site, then Referer, when Origin is missing", () => {
    expect(checkSameOrigin(req("POST", { "sec-fetch-site": "same-origin" }), APP).ok).toBe(true);
    expect(checkSameOrigin(req("POST", { "sec-fetch-site": "cross-site" }), APP).ok).toBe(false);
    expect(checkSameOrigin(req("PUT", { referer: `${APP}/jobs/1` }), APP).ok).toBe(true);
    expect(checkSameOrigin(req("PUT", { referer: "https://evil.example/x" }), APP).ok).toBe(false);
  });
  it("blocks a change that carries no origin information at all", () => {
    expect(checkSameOrigin(req("PATCH"), APP).ok).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { getClientIp } from "../../src/lib/security/client-ip";

const h = (o: Record<string, string>) => ({ get: (n: string) => o[n.toLowerCase()] ?? null });
const xff = (hops: number) => ({ hops, header: "x-forwarded-for" });

describe("client IP from trusted proxies", () => {
  it("ignores all headers when no proxy is configured", () => {
    expect(getClientIp(h({ "x-forwarded-for": "9.9.9.9" }), xff(0))).toBeNull();
  });
  it("takes the address our own proxy added (rightmost), not what the client wrote", () => {
    expect(getClientIp(h({ "x-forwarded-for": "6.6.6.6, 203.0.113.7" }), xff(1))).toBe("203.0.113.7");
  });
  it("cannot be spoofed by adding fake leading entries", () => {
    expect(getClientIp(h({ "x-forwarded-for": "1.1.1.1, 2.2.2.2, 3.3.3.3, 203.0.113.7" }), xff(1))).toBe("203.0.113.7");
  });
  it("counts correctly through two proxies", () => {
    expect(getClientIp(h({ "x-forwarded-for": "fake, 198.51.100.4, 10.0.0.2" }), xff(2))).toBe("198.51.100.4");
  });
  it("returns null when fewer entries than proxies (something bypassed the proxy)", () => {
    expect(getClientIp(h({ "x-forwarded-for": "198.51.100.4" }), xff(2))).toBeNull();
  });
  it("returns null for missing, empty or invalid values", () => {
    expect(getClientIp(h({}), xff(1))).toBeNull();
    expect(getClientIp(h({ "x-forwarded-for": "" }), xff(1))).toBeNull();
    expect(getClientIp(h({ "x-forwarded-for": "not-an-ip" }), xff(1))).toBeNull();
    expect(getClientIp(h({ "x-forwarded-for": "999.1.1.1" }), xff(1))).toBeNull();
  });
  it("handles ports, IPv6 and IPv4-mapped IPv6", () => {
    expect(getClientIp(h({ "x-forwarded-for": "203.0.113.7:51234" }), xff(1))).toBe("203.0.113.7");
    expect(getClientIp(h({ "x-forwarded-for": "[2001:db8::1]:443" }), xff(1))).toBe("2001:db8::1");
    expect(getClientIp(h({ "x-forwarded-for": "2001:DB8::1" }), xff(1))).toBe("2001:db8::1");
    expect(getClientIp(h({ "x-forwarded-for": "::ffff:203.0.113.7" }), xff(1))).toBe("203.0.113.7");
  });
  it("supports single-value headers set by the proxy", () => {
    expect(getClientIp(h({ "cf-connecting-ip": "203.0.113.7" }), { hops: 1, header: "cf-connecting-ip" })).toBe("203.0.113.7");
    expect(getClientIp(h({ "cf-connecting-ip": "203.0.113.7" }), { hops: 0, header: "cf-connecting-ip" })).toBeNull();
  });
});

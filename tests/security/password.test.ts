import { describe, expect, it } from "vitest";
import { hashPassword, validateNewPassword, verifyPassword } from "../../src/lib/security/password";

describe("passwords", () => {
  it("hashes and verifies", async () => {
    const hash = await hashPassword("maple-river-orbit-lantern");
    expect(hash.startsWith("$2")).toBe(true);
    expect(await verifyPassword("maple-river-orbit-lantern", hash)).toBe(true);
    expect(await verifyPassword("wrong-password-here", hash)).toBe(false);
  });
  it("fails safely for a missing account but still does the work", async () => {
    const started = Date.now();
    expect(await verifyPassword("anything-at-all-123", null)).toBe(false);
    expect(await verifyPassword("anything-at-all-123", undefined)).toBe(false);
    expect(Date.now() - started).toBeGreaterThan(50); // a real bcrypt comparison ran
  });
  it("refuses passwords longer than bcrypt's 72-byte limit instead of silently cutting them", async () => {
    const long = "a1b2c3d4".repeat(10);
    await expect(hashPassword(long)).rejects.toThrow();
    const hash = await hashPassword("short-enough-password");
    expect(await verifyPassword(long, hash)).toBe(false);
  });
  it("enforces the password rules", () => {
    expect(validateNewPassword("short").ok).toBe(false);
    expect(validateNewPassword("aaaaaaaaaaaaaaaa").ok).toBe(false);
    expect(validateNewPassword("maple-river-orbit-lantern").ok).toBe(true);
    expect(validateNewPassword("x".repeat(80)).ok).toBe(false);
  });
  it("rejects passwords built from the company name or email", () => {
    const avoid = ["The Trust Coffee", "admin.support@thecrushcoffeeofficial.com", "Yuvraj Singh Solanki"];
    expect(validateNewPassword("thetrustcoffee", avoid).ok).toBe(false);
    expect(validateNewPassword("My-Trust-Coffee-2026!", avoid).ok).toBe(false);
    expect(validateNewPassword("adminsupport-12345", avoid).ok).toBe(false);
    expect(validateNewPassword("maple-river-orbit-lantern", avoid).ok).toBe(true);
  });
});

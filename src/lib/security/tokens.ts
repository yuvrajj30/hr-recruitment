import "server-only";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// Session tokens are 32 random bytes (256 bits). The browser keeps the token;
// the database keeps only its SHA-256 hash, so a database leak cannot be used to log in.
export function generateSessionToken(): string {
  return randomBytes(32).toString("base64url"); // always 43 characters
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

// Cheap shape check so obviously fake cookies never reach the database.
export function isWellFormedToken(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}

// Login identifiers (emails) are stored only as a keyed hash, so the rate-limit table
// cannot be used to read email addresses if it ever leaks.
export function hashIdentifier(identifier: string, secret: string): string {
  return createHmac("sha256", secret).update(identifier.trim().toLowerCase(), "utf8").digest("hex");
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  if (x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}

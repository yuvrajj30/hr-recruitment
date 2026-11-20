import "server-only";
import { createHmac } from "node:crypto";
import type { Db } from "@/lib/db";
import { publicApplyDb } from "@/lib/db-context";
import { hashIdentifier, safeEqual } from "@/lib/security/tokens";

// Protection for the public application form, which anyone on the internet can reach.
//
//   1. A hidden "trap" field that people never see but simple bots fill in.
//   2. A signed time stamp: the form must have been open for a few seconds (bots submit instantly)
//      and not for longer than a day. It is tied to the job, so it cannot be reused elsewhere.
//   3. Rate limits per visitor address and per email address, counted in the database so that every app
//      server shares one count (only keyed hashes are stored, never the address or the email).
//
// These stop casual spam without any outside service. They are not a CAPTCHA.

export const FORM_MIN_SECONDS = 3;
export const FORM_MAX_SECONDS = 24 * 60 * 60;
export const TRAP_FIELD = "website"; // looks tempting to a bot; hidden from people

const sign = (secret: string, jobId: string, issuedAt: number) =>
  createHmac("sha256", secret).update(`application-form:${jobId}:${issuedAt}`, "utf8").digest("base64url");

export function issueFormToken(secret: string, jobId: string, now: Date): string {
  const issuedAt = Math.floor(now.getTime() / 1000);
  return `${issuedAt}.${sign(secret, jobId, issuedAt)}`;
}

export type FormTokenResult = "ok" | "too_fast" | "expired" | "invalid";

export function checkFormToken(secret: string, jobId: string, token: unknown, now: Date): FormTokenResult {
  if (typeof token !== "string") return "invalid";
  const match = /^(\d{9,12})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!match) return "invalid";
  const issuedAt = Number(match[1]);
  if (!safeEqual(match[2]!, sign(secret, jobId, issuedAt))) return "invalid";
  const age = Math.floor(now.getTime() / 1000) - issuedAt;
  if (age < FORM_MIN_SECONDS) return "too_fast";
  if (age > FORM_MAX_SECONDS) return "expired";
  return "ok";
}

// A small in-memory limiter: at most `limit` events per `windowMs` for each key, in this server process only.
// Used for signed-in or token-holding requests (password change, invitation acceptance); the public application
// form uses the shared database limit below instead.
export type RateLimiter = { hit(key: string, now: Date): boolean; size(): number };

export function createRateLimiter(limit: number, windowMs: number, maxKeys = 10_000): RateLimiter {
  const events = new Map<string, number[]>();
  return {
    hit(key, now) {
      const t = now.getTime();
      const recent = (events.get(key) ?? []).filter((at) => t - at < windowMs);
      if (recent.length >= limit) {
        events.set(key, recent);
        return false;
      }
      recent.push(t);
      events.delete(key);
      events.set(key, recent); // most recently used last
      if (events.size > maxKeys) events.delete(events.keys().next().value!); // forget the oldest key
      return true;
    },
    size: () => events.size,
  };
}

// Enforced by the database function app_public_apply_allowed (migration 20261120000000), which holds the same
// numbers; kept here for reference and tests.
export const PUBLIC_APPLY_LIMITS = {
  perAddress: { limit: 5, windowMs: 10 * 60_000 }, // 5 submissions per 10 minutes from one address
  unknownAddress: { limit: 30, windowMs: 10 * 60_000 }, // shared bucket when the address is not known
  perEmail: { limit: 5, windowMs: 60 * 60_000 }, // 5 submissions per hour for one email
} as const;

// Keyed hashes (HMAC with the app secret): the database can count repeats without ever holding the address or
// the email. Different prefixes keep an address and an email from ever sharing a key.
export function applyRateKeys(secret: string, input: { ipAddress: string | null; email: string }): { addressHash: string | null; emailHash: string } {
  return {
    addressHash: input.ipAddress ? hashIdentifier(`apply-address:${input.ipAddress}`, secret) : null,
    emailHash: hashIdentifier(`apply-email:${input.email}`, secret),
  };
}

// TRUE (and counted) when this submission is within the limits, across all app servers. The organisation is the
// one the application goes to: the database keeps the "address unknown" and per-email counts per organisation (it
// takes the organisation from this narrowed session, not from a value the app passes), so traffic against one
// company cannot block applications to another.
export async function allowPublicApplication(
  db: Db,
  secret: string,
  input: { organizationId: string; ipAddress: string | null; email: string },
): Promise<boolean> {
  const k = applyRateKeys(secret, input);
  const [row] = await publicApplyDb(db, input.organizationId).$queryRaw<{ allowed: boolean }[]>`SELECT "app_public_apply_allowed"(${k.addressHash}, ${k.emailHash}) AS "allowed"`;
  return row?.allowed === true;
}

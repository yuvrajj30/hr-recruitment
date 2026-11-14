import "server-only";
import type { Db } from "@/lib/db";
import { THROTTLE } from "./config";

// Login throttling and failed-attempt tracking (table: auth_login_attempts).
//
// Rules (approved):
//   - one email (stored only as a keyed hash): max 5 failures in 15 minutes,
//     counted only since that email's last successful login
//   - one IP address: max 20 failures in 15 minutes (a success does NOT reset this one,
//     otherwise an attacker could reset it by logging in to their own account)
//   - the IP rule applies only when the IP is known and trusted (TRUSTED_PROXY_HOPS > 0)
//   - there is no permanent lock: the lock lifts by itself as old failures age out
//
// How an attempt flows (see login-service.ts):
//   1. recordAttemptStart  - the attempt is written down FIRST, as a failure
//   2. evaluateThrottle    - counts the OTHER failures; if there are too many, the attempt is refused
//   3. discardAttempt      - a refused attempt is removed again, so refused attempts never extend a lock
//   4. markAttemptSucceeded - a good login flips its own row to "succeeded"
// Writing the attempt down before checking means many simultaneous guesses cannot all slip past
// the limit, and the slow password check never even starts for the ones that are refused.

export type AttemptDb = Pick<Db, "authLoginAttempt">;

export type ThrottleLimits = {
  windowMs: number;
  maxFailuresPerIdentifier: number;
  maxFailuresPerIp: number;
};

export type ThrottleDecision = { blocked: false } | { blocked: true; retryAfterSeconds: number };

export async function recordAttemptStart(
  db: AttemptDb,
  input: { identifierHash: string; ipAddress: string | null; now: Date },
): Promise<string> {
  const row = await db.authLoginAttempt.create({
    data: {
      identifierHash: input.identifierHash,
      ipAddress: input.ipAddress ? input.ipAddress.slice(0, 64) : null,
      succeeded: false,
      createdAt: input.now,
    },
    select: { id: true },
  });
  return row.id;
}

export async function markAttemptSucceeded(db: AttemptDb, attemptId: string): Promise<void> {
  await db.authLoginAttempt.update({ where: { id: attemptId }, data: { succeeded: true } });
}

export async function discardAttempt(db: AttemptDb, attemptId: string): Promise<void> {
  await db.authLoginAttempt.deleteMany({ where: { id: attemptId } });
}

// Seconds until the lock lifts: the moment the `limit`-th most recent failure leaves the window.
const secondsUntil = (releaseAt: number, now: Date) => Math.max(1, Math.ceil((releaseAt - now.getTime()) / 1000));

export async function evaluateThrottle(
  db: AttemptDb,
  input: {
    identifierHash: string;
    ipAddress: string | null;
    now: Date;
    ownAttemptId: string; // this attempt's own row is never counted against itself
    limits?: ThrottleLimits;
  },
): Promise<ThrottleDecision> {
  const { identifierHash, ipAddress, now, ownAttemptId } = input;
  const limits = input.limits ?? THROTTLE;
  const windowStart = new Date(now.getTime() - limits.windowMs);
  const waits: number[] = [];

  // --- this email ---------------------------------------------------------
  const lastSuccess = await db.authLoginAttempt.findFirst({
    where: { identifierHash, succeeded: true, createdAt: { gt: windowStart, lte: now } },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  const since = lastSuccess?.createdAt ?? windowStart;
  const byIdentifier = await db.authLoginAttempt.findMany({
    where: { identifierHash, succeeded: false, id: { not: ownAttemptId }, createdAt: { gt: since, lte: now } },
    orderBy: { createdAt: "desc" },
    take: limits.maxFailuresPerIdentifier,
    select: { createdAt: true },
  });
  if (byIdentifier.length >= limits.maxFailuresPerIdentifier) {
    const oldestCounted = byIdentifier[byIdentifier.length - 1]!.createdAt;
    waits.push(secondsUntil(oldestCounted.getTime() + limits.windowMs, now));
  }

  // --- this IP address (only when it is known) ---------------------------
  if (ipAddress) {
    const byIp = await db.authLoginAttempt.findMany({
      where: { ipAddress, succeeded: false, id: { not: ownAttemptId }, createdAt: { gt: windowStart, lte: now } },
      orderBy: { createdAt: "desc" },
      take: limits.maxFailuresPerIp,
      select: { createdAt: true },
    });
    if (byIp.length >= limits.maxFailuresPerIp) {
      const oldestCounted = byIp[byIp.length - 1]!.createdAt;
      waits.push(secondsUntil(oldestCounted.getTime() + limits.windowMs, now));
    }
  }

  return waits.length > 0 ? { blocked: true, retryAfterSeconds: Math.max(...waits) } : { blocked: false };
}

// Housekeeping: delete attempt records older than the retention period.
export async function purgeOldLoginAttempts(db: AttemptDb, now: Date, retentionDays: number): Promise<number> {
  const cutoff = new Date(now.getTime() - retentionDays * 86_400_000);
  const result = await db.authLoginAttempt.deleteMany({ where: { createdAt: { lt: cutoff } } });
  return result.count;
}

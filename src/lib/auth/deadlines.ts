import type { SessionTimings } from "./config";

// All session time rules live here as pure functions. "now" is always passed in,
// so tests can use a fake clock and the whole session uses one consistent reading of the time.

export type Deadlines = {
  expiresAt: Date; // idle deadline (slides forward while the user is active)
  absoluteExpiresAt: Date; // hard deadline (never moves)
};

const min = (a: number, b: number) => (a < b ? a : b);

// The idle deadline can never be later than the hard deadline (the database enforces this too).
export function computeInitialDeadlines(now: Date, timings: SessionTimings): Deadlines {
  const absolute = now.getTime() + timings.absoluteMs;
  const idle = min(now.getTime() + timings.idleMs, absolute);
  return { expiresAt: new Date(idle), absoluteExpiresAt: new Date(absolute) };
}

// New idle deadline after activity, clamped so it never passes the hard deadline.
export function extendIdleDeadline(now: Date, absoluteExpiresAt: Date, timings: SessionTimings): Date {
  return new Date(min(now.getTime() + timings.idleMs, absoluteExpiresAt.getTime()));
}

// Only write "last seen" when enough time has passed (keeps database writes low).
// A last-seen time in the future (clock difference) never triggers a write.
export function shouldTouch(now: Date, lastSeenAt: Date, timings: SessionTimings): boolean {
  return now.getTime() - lastSeenAt.getTime() >= timings.touchIntervalMs;
}

// A session is usable only if it is not revoked and BOTH deadlines are still in the future.
// A deadline exactly equal to "now" counts as expired.
export function isSessionLive(
  now: Date,
  session: { expiresAt: Date; absoluteExpiresAt: Date; revokedAt: Date | null },
): boolean {
  return (
    session.revokedAt === null &&
    now.getTime() < session.expiresAt.getTime() &&
    now.getTime() < session.absoluteExpiresAt.getTime()
  );
}

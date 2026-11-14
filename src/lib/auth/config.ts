import type { Env } from "@/lib/env";

// Fixed authentication settings in one place. Session timeouts come from env.ts (already validated).

// Login throttling (approved numbers).
export const THROTTLE = {
  windowMs: 15 * 60 * 1000,
  maxFailuresPerIdentifier: 5,
  maxFailuresPerIp: 20,
} as const;

// Limits applied to login requests before any password work happens.
export const REQUEST_LIMITS = {
  maxBodyBytes: 4 * 1024,
  maxEmailLength: 254,
  maxPasswordLength: 1024,
} as const;

// Where a user lands after signing in when no safe "next" address was given.
export const DEFAULT_LOGIN_REDIRECT = "/dashboard";

export type SessionTimings = {
  idleMs: number; // sign out after this much inactivity
  absoluteMs: number; // sign out this long after login no matter what
  touchIntervalMs: number; // "last seen" is written at most this often
};

export function sessionTimings(
  env: Pick<Env, "SESSION_IDLE_MINUTES" | "SESSION_ABSOLUTE_HOURS" | "SESSION_TOUCH_INTERVAL_SECONDS">,
): SessionTimings {
  return {
    idleMs: env.SESSION_IDLE_MINUTES * 60_000,
    absoluteMs: env.SESSION_ABSOLUTE_HOURS * 3_600_000,
    touchIntervalMs: env.SESSION_TOUCH_INTERVAL_SECONDS * 1_000,
  };
}

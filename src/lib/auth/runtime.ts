import "server-only";
import { after } from "next/server";
import { getDb, type Db } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { writeAudit } from "./audit";
import { LOGIN_LIMITS, type SessionTimings, sessionTimings } from "./config";
import { type ConcurrencyGate, createConcurrencyGate } from "./concurrency-gate";
import { type LoginDeps, signInWithDatabase } from "./login-service";

// Everything the auth handlers need from the outside world, in one object.
// The real one is built from your settings and the real database; tests build their own
// (test database, fake clock, stand-in password check) and call the handlers directly.
// This is the ONLY auth file that imports from Next.js.

export type AuthRuntime = {
  db: Db;
  appOrigin: string;
  authSecret: string;
  timings: SessionTimings;
  trustedProxyHops: number;
  clientIpHeader: string;
  retention: { loginAttemptDays: number; sessionDays: number };
  now: () => Date;
  deps: LoginDeps; // the sign-in step (the database checks the password) and the audit writer
  runLater: (task: () => Promise<void>) => void; // runs after the response has been sent
  shouldRunCleanup: () => boolean;
  loginGate: ConcurrencyGate; // caps how many password checks run at once
};

// One gate for the whole server process (kept on globalThis so development reloads do not reset it).
const globalForGate = globalThis as unknown as { __hrLoginGate?: ConcurrencyGate };
const getLoginGate = (): ConcurrencyGate =>
  (globalForGate.__hrLoginGate ??= createConcurrencyGate(LOGIN_LIMITS.maxConcurrentLogins));

export function getAuthRuntime(): AuthRuntime {
  const env = getEnv();
  return {
    db: getDb(),
    appOrigin: env.APP_ORIGIN,
    authSecret: env.AUTH_SECRET,
    timings: sessionTimings(env),
    trustedProxyHops: env.TRUSTED_PROXY_HOPS,
    clientIpHeader: env.CLIENT_IP_HEADER,
    retention: { loginAttemptDays: env.LOGIN_ATTEMPT_RETENTION_DAYS, sessionDays: env.SESSION_RETENTION_DAYS },
    now: () => new Date(),
    deps: { signIn: signInWithDatabase, writeAudit },
    runLater: (task) => after(task),
    // About 1 login in 50 also tidies old rows, so no separate scheduler is needed to keep the tables small.
    shouldRunCleanup: () => Math.random() < 0.02,
    loginGate: getLoginGate(),
  };
}

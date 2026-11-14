import "server-only";
import { after } from "next/server";
import { getDb, type Db } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { verifyPassword } from "@/lib/security/password";
import { writeAudit } from "./audit";
import { type SessionTimings, sessionTimings } from "./config";
import type { LoginDeps } from "./login-service";

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
  deps: LoginDeps; // the password check and the audit writer
  runLater: (task: () => Promise<void>) => void; // runs after the response has been sent
  shouldRunCleanup: () => boolean;
};

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
    deps: { verifyPassword, writeAudit },
    runLater: (task) => after(task),
    // About 1 login in 50 also tidies old rows, so no separate scheduler is needed to keep the tables small.
    shouldRunCleanup: () => Math.random() < 0.02,
  };
}

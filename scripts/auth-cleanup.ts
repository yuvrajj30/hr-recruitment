// Removes old, finished rows from the sign-in tables:
//   - sessions that ended (expired or signed out) more than SESSION_RETENTION_DAYS ago
//   - sign-in attempt records older than LOGIN_ATTEMPT_RETENTION_DAYS
// It never touches live sessions, and it never prints secrets: only how many rows were removed.
// Usage (PowerShell, from the project folder):  npm run auth:cleanup
// The app also does this by itself now and then; this script is for running it on purpose.
import "dotenv/config";
import { purgeEndedSessions } from "@/lib/auth/session-store";
import { purgeOldLoginAttempts } from "@/lib/auth/throttle";
import { getDb } from "@/lib/db";
import { getEnv } from "@/lib/env";

async function main() {
  const env = getEnv();
  const db = getDb();
  try {
    const now = new Date();
    const sessions = await purgeEndedSessions(db, now, env.SESSION_RETENTION_DAYS);
    const attempts = await purgeOldLoginAttempts(db, now, env.LOGIN_ATTEMPT_RETENTION_DAYS);
    console.log(`Removed ${sessions} ended session(s) and ${attempts} old sign-in attempt record(s).`);
  } finally {
    await db.$disconnect();
  }
}

main().catch((error) => {
  // The settings error lists setting names only; for anything else show just the error type.
  console.error(error instanceof Error && error.name === "EnvError" ? error.message : `Cleanup failed (${error instanceof Error ? error.name : "unknown error"}).`);
  process.exit(1);
});

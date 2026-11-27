// The candidate retention job (see src/lib/recruitment/retention.ts): removes every candidate who is due for
// removal under their organisation's retention period, and deletes (or retries deleting) the files of removed
// documents. Prints only counts, never names or emails.
// Usage (PowerShell, from the project folder):  npm run privacy:retention
// Meant to run once a day from a scheduler (Windows Task Scheduler, cron, or the hosting platform's jobs).
// It connects as the MAINTENANCE account (hr_maintenance), the only account that may run the housekeeping functions,
// read from .env.maintenance (git-ignored, never loaded by the web app). The app's own connections in .env are removed
// from this process before anything runs, so the job cannot use them by mistake.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "dotenv";
import { generateStandardShifts, removeOldAttendanceDeviceData, runLeaveHousekeeping } from "@/lib/attendance/retention";
import { createDb } from "@/lib/db";
import { EnvError } from "@/lib/env";
import { maintenanceSecretsIn, parseMaintenanceEnv } from "@/lib/maintenance-env";
import { runCandidateRetention } from "@/lib/recruitment/retention";
import { runTaskHousekeeping } from "@/lib/tasks/housekeeping";
import { getFileStorage } from "@/lib/recruitment/storage";

// .env: shared settings such as FILE_STORAGE_DIR and DB_SESSION_TIME_ZONE. .env.maintenance: the job's own connection.
// Values already set in the environment win, as with dotenv. The maintenance connection must NOT be in .env, which the
// web app reads too.
function loadSettings(): void {
  const read = (file: string) => (existsSync(file) ? parse(readFileSync(file)) : {});
  const shared = read(path.join(process.cwd(), ".env"));
  const misplaced = maintenanceSecretsIn(shared);
  if (misplaced.length) throw new EnvError(`${misplaced.join(", ")} must not be in .env (the web app reads that file): move it to .env.maintenance.`);
  const own = read(path.join(process.cwd(), ".env.maintenance"));
  for (const [k, v] of Object.entries({ ...shared, ...own })) if (process.env[k] === undefined) process.env[k] = v;
  for (const k of ["DATABASE_URL", "MIGRATION_DATABASE_URL", "AUTH_SECRET"]) delete process.env[k];
}

async function main() {
  loadSettings();
  const env = parseMaintenanceEnv(process.env); // refuses to run with missing or unsafe settings
  const db = createDb(env.MAINTENANCE_DATABASE_URL, { max: 2, sessionTimeZone: env.DB_SESSION_TIME_ZONE ?? null });
  try {
    const r = await runCandidateRetention(db, getFileStorage());
    console.log(`Removed ${r.candidatesRemoved} candidate(s) due for removal; deleted ${r.filesDeleted} file(s).`);
    if (r.storageRoot) console.log(`Storage folder: ${r.storageRoot}`);
    if (r.candidatesFailed) console.log(`${r.candidatesFailed} candidate(s) could not be removed this time and will be retried (record ids in the app log).`);
    if (r.filesFailed) console.log(`${r.filesFailed} file(s) could not be deleted and will be retried.`);
    if (r.candidatesFailed || r.filesFailed) process.exitCode = 2;
    // Attendance: device details (IP address, browser) of punches older than 90 days.
    const devices = await removeOldAttendanceDeviceData(db);
    console.log(devices === null ? "Attendance device details: not installed on this database yet." : `Removed device details from ${devices} attendance record(s) older than 90 days.`);
    // Attendance: fill the coming two weeks of the rota from the standard shifts.
    const shifts = await generateStandardShifts(db);
    console.log(shifts === null ? "Standard shifts: not installed on this database yet." : `Added ${shifts} shift(s) to the rota from the standard shifts.`);
    // Leave: yearly grants, monthly accruals, and the close of last year (from 1 February).
    const leave = await runLeaveHousekeeping(db);
    console.log(leave === null ? "Leave: not installed on this database yet." : `Wrote ${leave} leave balance line(s) (grants, accruals, year close).`);
    // Tasks: deadline reminders (nothing is deleted).
    const tasks = await runTaskHousekeeping(db);
    console.log(tasks === null ? "Tasks: not installed on this database yet." : `Sent ${tasks.reminders} task reminder(s).`);
  } finally {
    await db.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error && error.name === "EnvError" ? error.message : `Retention job failed (${error instanceof Error ? error.name : "unknown error"}).`);
  process.exit(1);
});

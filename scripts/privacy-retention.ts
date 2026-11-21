// The candidate retention job (see src/lib/recruitment/retention.ts): removes every candidate who is due for
// removal under their organisation's retention period, and deletes (or retries deleting) the files of removed
// documents. Prints only counts, never names or emails.
// Usage (PowerShell, from the project folder):  npm run privacy:retention
// Meant to run once a day from a scheduler (Windows Task Scheduler, cron, or the hosting platform's jobs). It
// connects with the app's own restricted account (DATABASE_URL), like the app.
import "dotenv/config";
import { generateStandardShifts, removeOldAttendanceDeviceData, runLeaveHousekeeping } from "@/lib/attendance/retention";
import { getDb } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { runCandidateRetention } from "@/lib/recruitment/retention";
import { getFileStorage } from "@/lib/recruitment/storage";

async function main() {
  getEnv(); // refuses to run with missing or unsafe settings
  const db = getDb();
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
  } finally {
    await db.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error && error.name === "EnvError" ? error.message : `Retention job failed (${error instanceof Error ? error.name : "unknown error"}).`);
  process.exit(1);
});

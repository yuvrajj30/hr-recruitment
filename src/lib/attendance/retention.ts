import "server-only";
import type { Db } from "@/lib/db";
import { maintenanceDb } from "@/lib/db-context";
import { ATTENDANCE_LIMITS, STANDARD_DAYS_AHEAD } from "./rules";

// Housekeeping: removes the device details (IP address, browser) of clock-ins and clock-outs older than the retention
// period. The times themselves stay. Runs in the database's maintenance mode, as part of the daily privacy retention
// job (scripts/privacy-retention.ts).
// Returns null when the database does not have attendance yet (a database the attendance migrations have not
// reached), so the daily job keeps working there. The same holds for generateStandardShifts below.
export async function removeOldAttendanceDeviceData(db: Db): Promise<number | null> {
  try {
    const rows = await maintenanceDb(db).$queryRaw<{ n: number }[]>`SELECT app_remove_old_attendance_device_data(${ATTENDANCE_LIMITS.deviceRetentionDays}::int) AS n`;
    return Number(rows[0]?.n ?? 0);
  } catch (error) {
    const text = String((error as Error)?.message ?? "") + JSON.stringify((error as { meta?: unknown })?.meta ?? "");
    if (/42883|app_remove_old_attendance_device_data.*does not exist|function .* does not exist/i.test(text)) return null;
    throw error;
  }
}

// Housekeeping: fills the coming days of every organisation's rota from its standard shifts (outlet hours +
// each employee's standard). Days HR changed or added by hand are never touched. Returns the number of shifts
// added, or null when the database does not have standard shifts yet.
export async function generateStandardShifts(db: Db): Promise<number | null> {
  try {
    const rows = await maintenanceDb(db).$queryRaw<{ n: number }[]>`SELECT app_generate_standard_shifts(${STANDARD_DAYS_AHEAD}::int) AS n`;
    return Number(rows[0]?.n ?? 0);
  } catch (error) {
    const text = String((error as Error)?.message ?? "") + JSON.stringify((error as { meta?: unknown })?.meta ?? "");
    if (/42883|function .* does not exist/i.test(text)) return null;
    throw error;
  }
}

// Housekeeping: leave grants and monthly accruals, and from 1 February the close of the previous leave year
// (carry-over up to each type's cap; the rest expires). Idempotent. Returns the number of ledger lines written, or
// null when the database does not have leave yet.
export async function runLeaveHousekeeping(db: Db): Promise<number | null> {
  try {
    const rows = await maintenanceDb(db).$queryRaw<{ n: number }[]>`SELECT app_leave_housekeeping() AS n`;
    return Number(rows[0]?.n ?? 0);
  } catch (error) {
    const text = String((error as Error)?.message ?? "") + JSON.stringify((error as { meta?: unknown })?.meta ?? "");
    if (/42883|function .* does not exist/i.test(text)) return null;
    throw error;
  }
}

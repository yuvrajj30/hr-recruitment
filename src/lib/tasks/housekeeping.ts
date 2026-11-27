import "server-only";
import type { Db } from "@/lib/db";
import { maintenanceDb } from "@/lib/db-context";

// The daily job's task step: deadline reminders (once on the due date, once the day after; never more). Nothing is
// deleted: evidence retention is a proposed setting, not built until the owner approves a period.
// Returns null when the database does not have tasks yet, so the daily job keeps working there.
export async function runTaskHousekeeping(db: Db): Promise<{ reminders: number } | null> {
  try {
    const rows = await maintenanceDb(db).$queryRaw<{ n: number }[]>`SELECT app_task_housekeeping() AS n`;
    return { reminders: Number(rows[0]?.n ?? 0) };
  } catch (error) {
    const text = String((error as Error)?.message ?? "") + JSON.stringify((error as { meta?: unknown })?.meta ?? "");
    if (/42883|function .* does not exist/i.test(text)) return null;
    throw error;
  }
}

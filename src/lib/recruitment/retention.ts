import "server-only";
import type { Db } from "@/lib/db";
import { maintenanceDb } from "@/lib/db-context";
import type { FileStorage } from "@/lib/recruitment/storage";
import { logger } from "@/lib/security/logger";

// The candidate retention job: what the public privacy notice promises, done without anyone clicking.
//   1. Removes every candidate who is due under their organisation's retention period. The DATABASE decides who
//      is due (app_remove_due_candidates, from each organisation's own setting and the database clock, in UTC;
//      for 14 days after a period is shortened the longer previous period still applies); this code cannot name
//      anyone. The removal is the same one HR's "Remove" button runs. A removal that fails is skipped, counted and
//      tried again on the next run; it does not stop the others.
//   2. Deletes the files of removed documents from storage, and tells the database once each one is gone. Before
//      deleting anything it checks the storage folder really is the app's (a wrong folder would make deletions
//      "succeed" on files that are not there). A file that cannot be deleted now stays on the list and is tried
//      again on the next run (also files left over from a manual removal whose storage deletion failed).
// Safe to run as often as wanted (for example once a day); a second run right after the first does nothing.

export type RetentionResult = {
  candidatesRemoved: number;
  candidatesFailed: number;
  filesDeleted: number;
  filesFailed: number;
  storageRoot: string | null;
};

const BATCH = 50;
// One batch of removals is one transaction. The app account's own statement limit (30 s) is raised for this
// statement only (SET LOCAL), and Prisma's transaction limit matches it.
const BATCH_TIMEOUT_MS = 120_000;

// opts.organizationId limits the run to one organisation (tests); the daily job leaves it out (all organisations).
export async function runCandidateRetention(
  db: Db,
  storage: FileStorage,
  opts: { maxBatches?: number; organizationId?: string } = {},
): Promise<RetentionResult> {
  const m = maintenanceDb(db);
  const org = opts.organizationId ?? null;
  const maxBatches = opts.maxBatches ?? 200;
  let candidatesRemoved = 0;
  let candidatesFailed = 0;
  let removalError: unknown = null;
  let lastFailed: string[] = [];
  try {
    for (let i = 0; i < maxBatches; i++) {
      const rows = await m.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT set_config('statement_timeout', ${`${BATCH_TIMEOUT_MS - 5_000}ms`}, true)`;
          return tx.$queryRaw<{ organization_candidate_id: string; failed: boolean }[]>`
            SELECT "organization_candidate_id", "failed" FROM "app_remove_due_candidates"(${BATCH}::int, ${org}::uuid)`;
        },
        { timeout: BATCH_TIMEOUT_MS, maxWait: 10_000 },
      );
      const ok = rows.filter((r) => !r.failed).length;
      candidatesRemoved += ok;
      // A failing candidate is tried again in every later batch of this run; keep the latest batch's list only.
      lastFailed = rows.filter((r) => r.failed).map((r) => r.organization_candidate_id);
      if (ok < BATCH) break;
    }
    candidatesFailed = lastFailed.length;
    // Record ids only (random ids, no personal data), so the failures can be looked into.
    for (const id of lastFailed) logger.error("recruitment.retention_removal_skipped", { organizationCandidateId: id });
  } catch (error) {
    // Still delete files of earlier removals below; the error is thrown afterwards. Logged now (its kind only, no
    // message: it could echo data) so it is not lost if the file step fails too.
    removalError = error;
    logger.error("recruitment.retention_removal_failed", { errorName: error instanceof Error ? error.name : typeof error });
  }

  let filesDeleted = 0;
  let filesFailed = 0;
  let storageRoot: string | null = null;
  const failedIds = new Set<string>();
  for (let i = 0; i < maxBatches; i++) {
    const pending = (await m.$queryRaw<{ id: string; storage_key: string }[]>`
      SELECT "id", "storage_key" FROM "app_pending_file_removals"(${BATCH}::int, ${org}::uuid)`).filter((p) => !failedIds.has(p.id));
    if (pending.length === 0) break;
    // Before the first deletion: is this really the app's file store? If not, nothing is deleted or confirmed
    // (the documents stay pending) and the job fails loudly.
    if (storageRoot === null && storage.verifyRoot) storageRoot = await storage.verifyRoot();
    const done: string[] = [];
    for (const p of pending) {
      try {
        await storage.remove(p.storage_key); // removing a file that is already gone is fine
        done.push(p.id);
      } catch {
        failedIds.add(p.id);
        filesFailed++;
        logger.error("recruitment.retention_file_not_deleted", { storageKey: p.storage_key });
      }
    }
    if (done.length > 0) {
      await m.$queryRaw`SELECT "app_confirm_file_removed"(${done}::uuid[])`;
      filesDeleted += done.length;
    }
    if (done.length === 0) break; // everything left failed this run; it is retried next time
  }
  if (removalError) throw removalError;
  return { candidatesRemoved, candidatesFailed, filesDeleted, filesFailed, storageRoot };
}

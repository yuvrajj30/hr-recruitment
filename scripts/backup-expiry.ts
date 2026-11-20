// Backup expiry: the privacy notice promises that backups which may still hold a removed candidate are deleted
// within BACKUP_RETENTION_DAYS. This lists (and, only with --apply, deletes) everything in the backup folder that
// is older than that: database dumps with their .sha256 / .json side files, and private-file copies
// (storage-private-* folders).
//
//   npm run backup:expiry               lists what has expired; deletes NOTHING
//   npm run backup:expiry -- --apply    deletes what has expired (needs the owner's go-ahead the first time)
//
// The newest database dump is never deleted, whatever its age, so there is always one backup to restore from.
// Folder: HR_BACKUP_DIR, or ~/hr-recruitment-backups.
import { readdirSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { BACKUP_RETENTION_DAYS } from "../src/lib/recruitment/privacy-rules";

type Entry = { name: string; full: string; mtime: Date; dir: boolean };

export function expiredBackups(entries: Entry[], now: Date, retentionDays: number): Entry[] {
  const cutoff = now.getTime() - retentionDays * 86_400_000;
  const dumps = entries.filter((e) => !e.dir && e.name.endsWith(".dump")).sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  const keep = new Set<string>(dumps.slice(0, 1).map((d) => d.name)); // the newest dump always stays
  const isBackup = (e: Entry) => (e.dir ? /^storage-private-/.test(e.name) : /\.dump(\.[a-z0-9.-]+)?$/.test(e.name));
  // A side file (x.dump.sha256) follows its dump.
  const dumpOf = (e: Entry) => e.name.replace(/(\.dump)\..*$/, "$1");
  return entries.filter((e) => isBackup(e) && e.mtime.getTime() < cutoff && !keep.has(e.dir ? "" : dumpOf(e)));
}

function main() {
  const apply = process.argv.includes("--apply");
  const dir = process.env.HR_BACKUP_DIR?.trim() || path.join(os.homedir(), "hr-recruitment-backups");
  const entries: Entry[] = readdirSync(dir).map((name) => {
    const full = path.join(dir, name);
    const st = statSync(full);
    return { name, full, mtime: st.mtime, dir: st.isDirectory() };
  });
  const expired = expiredBackups(entries, new Date(), BACKUP_RETENTION_DAYS);
  if (expired.length === 0) {
    console.log(`Nothing in ${dir} is older than ${BACKUP_RETENTION_DAYS} days.`);
    return;
  }
  for (const e of expired) {
    console.log(`${apply ? "deleting" : "expired "}  ${e.mtime.toISOString().slice(0, 10)}  ${e.name}`);
    if (apply) rmSync(e.full, { recursive: true, force: true });
  }
  console.log(apply ? `Deleted ${expired.length} expired backup item(s).` : `${expired.length} item(s) have expired. Nothing was deleted; run with --apply to delete them.`);
}

if (process.argv[1] && path.basename(process.argv[1]).startsWith("backup-expiry")) main();

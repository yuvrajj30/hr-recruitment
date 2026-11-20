// Backup expiry: the privacy notice promises that backups which may still hold a removed candidate are deleted
// within BACKUP_RETENTION_DAYS. This lists (and, only with --apply, deletes) everything in the backup folder that
// is older than that: database dumps with their .sha256 / .json side files, and private-file copies
// (storage-private-* folders).
//
//   npm run backup:expiry               lists what has expired; deletes NOTHING
//   npm run backup:expiry -- --apply    deletes what has expired (the daily scheduled job does this)
//
// The newest VERIFIED database backup (a .dump with its .sha256) and the newest VERIFIED file backup (a
// storage-private-* folder with manifest.json.sha256) are kept whatever their age, so there is always one complete
// pair to restore from. That only happens when backups have stopped; the daily job then reports the stale backups
// (scripts/ops/backup-status.cjs), and someone has to act. Half-written leftovers (*.partial) of a failed run are
// deleted after one day. Folder: HR_BACKUP_DIR, or ~/hr-recruitment-backups.
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { BACKUP_RETENTION_DAYS } from "../src/lib/recruitment/privacy-rules";

// `verified` (directories only): the file backup's manifest and its checksum are there.
type Entry = { name: string; full: string; mtime: Date; dir: boolean; verified?: boolean };

const PARTIAL_MAX_DAYS = 1;

export function expiredBackups(entries: Entry[], now: Date, retentionDays: number): Entry[] {
  const cutoff = now.getTime() - retentionDays * 86_400_000;
  const partialCutoff = now.getTime() - PARTIAL_MAX_DAYS * 86_400_000;
  const names = new Set(entries.map((e) => e.name));
  const byAge = (a: Entry, b: Entry) => b.mtime.getTime() - a.mtime.getTime();
  const newestDump = entries.filter((e) => !e.dir && e.name.endsWith(".dump") && names.has(e.name + ".sha256")).sort(byAge)[0];
  const newestFiles = entries.filter((e) => e.dir && /^storage-private-[0-9A-Za-z]+$/.test(e.name) && e.verified).sort(byAge)[0];
  const isPartial = (e: Entry) => e.name.endsWith(".partial");
  const isBackup = (e: Entry) => (e.dir ? /^storage-private-/.test(e.name) : /\.dump(\.[a-z0-9.-]+)?$/.test(e.name));
  // A side file (x.dump.sha256) follows its dump; a partial dump (x.dump.partial) does not.
  const dumpOf = (e: Entry) => (isPartial(e) ? e.name : e.name.replace(/(\.dump)\..*$/, "$1"));
  const kept = (e: Entry) => (e.dir ? e === newestFiles : newestDump !== undefined && dumpOf(e) === newestDump.name);
  return entries.filter((e) => isBackup(e) && !kept(e) && e.mtime.getTime() < (isPartial(e) ? partialCutoff : cutoff));
}

function main() {
  const apply = process.argv.includes("--apply");
  const dir = process.env.HR_BACKUP_DIR?.trim() || path.join(os.homedir(), "hr-recruitment-backups");
  const entries: Entry[] = readdirSync(dir).map((name) => {
    const full = path.join(dir, name);
    const st = statSync(full);
    const isDir = st.isDirectory();
    return { name, full, mtime: st.mtime, dir: isDir, verified: isDir && existsSync(path.join(full, "manifest.json.sha256")) };
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

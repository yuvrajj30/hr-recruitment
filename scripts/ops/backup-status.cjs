// Are the backups fresh? Exits 1 (and says so) when the newest VERIFIED database backup (a .dump with its .sha256)
// or the newest VERIFIED file backup (a storage-private-* folder with manifest.json.sha256) is older than
// MAX_AGE_HOURS, or missing. Run after the daily backup and at sign-in, so stopped or failing backups are noticed.
//   node scripts/ops/backup-status.cjs        (npm run backup:status)
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const MAX_AGE_HOURS = 26;
const dir = process.env.HR_BACKUP_DIR || path.join(os.homedir(), "hr-recruitment-backups");
const names = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
const newest = (list) => list.map((n) => ({ n, t: fs.statSync(path.join(dir, n)).mtimeMs })).sort((a, b) => b.t - a.t)[0];
const dump = newest(names.filter((n) => n.endsWith(".dump") && names.includes(n + ".sha256")));
const files = newest(names.filter((n) => /^storage-private-[0-9A-Za-z]+$/.test(n) && fs.existsSync(path.join(dir, n, "manifest.json.sha256"))));
let stale = 0;
for (const [what, b] of [["database backup", dump], ["file backup", files]]) {
  if (!b) { stale++; console.log(`STALE  no verified ${what} in ${dir}`); continue; }
  const hours = (Date.now() - b.t) / 3_600_000;
  const ok = hours <= MAX_AGE_HOURS;
  if (!ok) stale++;
  console.log(`${ok ? "OK   " : "STALE"}  newest ${what}: ${b.n} (${hours.toFixed(1)} hours old)`);
  // Decided 21 Nov 2026: if backups stop, the last verified pair is kept past the 30-day promise; say so plainly.
  if (hours > 30 * 24) console.log(`PRIVACY  this ${what} is older than the 30 days promised in the privacy notice and is kept only because no newer backup exists. Fix the backups now.`);
}
process.exit(stale ? 1 : 0);

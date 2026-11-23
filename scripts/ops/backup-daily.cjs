// The daily backup: the real database (scripts/ops/db-backup.cjs daily) and the app's file store
// (scripts/ops/storage-backup.cjs). Both always run, even if the other fails, and the result is a failure if either
// failed, so one problem never silently skips the other backup.
//   node scripts/ops/backup-daily.cjs        (npm run backup:daily)
"use strict";
const cp = require("child_process");
const path = require("path");
const run = (script, args = []) => cp.spawnSync(process.execPath, [path.join(__dirname, script), ...args], { stdio: "inherit" }).status ?? 1;
const db = run("db-backup.cjs", ["daily"]);
const files = run("storage-backup.cjs");
if (db !== 0) console.error("database backup FAILED");
if (files !== 0) console.error("file backup FAILED");
process.exit(db !== 0 || files !== 0 ? 1 : 0);

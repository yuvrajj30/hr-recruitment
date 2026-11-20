// Backup of the REAL database (hr_recruitment). pg_dump only READS the database.
//   node scripts/ops/db-backup.cjs <label>        e.g. before-release-20261120, or daily
// Writes <backups>/hr_recruitment-<label>-<stamp>.dump + .sha256 and proves the file is readable with
// pg_restore --list. The dump is written under a temporary name (.dump.partial) and gets its final name only after
// every check passed, so a failed or interrupted run never leaves something that looks like a good backup (a
// leftover .partial is deleted by the backup-expiry job after 30 days like any backup). Never overwrites a file.
// Verify a backup with: node scripts/tz-ops/tz-restore-verify.cjs --dump <file>
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const cp = require("child_process");
const req = (m) => require(require.resolve(m, { paths: [process.cwd()] }));
let partial = null;
const stop = (m) => {
  if (partial) fs.rmSync(partial, { force: true });
  console.error("STOPPED: " + String(m).replace(/postgres(ql)?:\/\/\S+/g, "<url>"));
  process.exit(2);
};

const label = process.argv[2];
if (!label || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(label)) stop("give a label of lower-case letters, digits and dashes, e.g. before-release-20261120");
if (process.env.MIGRATION_DATABASE_URL) stop("MIGRATION_DATABASE_URL is already set in this environment (it would override .env); open a new terminal");
req("dotenv").config({ path: ".env", quiet: true });
if (!process.env.MIGRATION_DATABASE_URL) stop("MIGRATION_DATABASE_URL is missing from .env");
let u;
try { u = new URL(process.env.MIGRATION_DATABASE_URL); } catch { stop("MIGRATION_DATABASE_URL in .env is not a valid address"); }
if (u.pathname !== "/hr_recruitment" || decodeURIComponent(u.username) !== "hr_app") stop("expected hr_app on hr_recruitment");
const root = "C:\\Program Files\\PostgreSQL";
const versions = fs.existsSync(root) ? fs.readdirSync(root).filter((d) => /^\d+$/.test(d)).sort((a, b) => b - a) : [];
if (!versions.length || !fs.existsSync(path.join(root, versions[0], "bin", "pg_dump.exe"))) stop(`pg_dump.exe not found under ${root}\\<version>\\bin`);
const bin = path.join(root, versions[0], "bin");
const env = { ...process.env, PGPASSWORD: decodeURIComponent(u.password) };
const dir = process.env.HR_BACKUP_DIR || path.join(os.homedir(), "hr-recruitment-backups");
fs.mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "");
const file = path.join(dir, `hr_recruitment-${label}-${stamp}.dump`);
if (fs.existsSync(file) || fs.existsSync(file + ".partial")) stop("file exists: " + file);
partial = file + ".partial";

let r = cp.spawnSync(path.join(bin, "pg_dump.exe"), ["--format=custom", "--no-password", "--host", u.hostname, "--port", u.port || "5432",
  "--username", "hr_app", "--dbname", "hr_recruitment", "--file", partial], { env, encoding: "utf8" });
if (r.status !== 0) stop("pg_dump failed: " + (r.stderr || "").slice(0, 300));
r = cp.spawnSync(path.join(bin, "pg_restore.exe"), ["--list", partial], { encoding: "utf8", maxBuffer: 1 << 26 });
if (r.status !== 0) stop("pg_restore --list failed: the backup is not readable");
const entries = r.stdout.split("\n").filter((l) => / TABLE DATA /.test(l)).length;
if (entries === 0) stop("the backup lists no table data");
const sha = crypto.createHash("sha256").update(fs.readFileSync(partial)).digest("hex");
fs.renameSync(partial, file);
partial = null;
fs.writeFileSync(file + ".sha256", sha + "  " + path.basename(file) + "\n");
console.log(`PASS  backup ${file}`);
console.log(`PASS  ${fs.statSync(file).size} bytes, sha256 ${sha}`);
console.log(`PASS  readable: ${entries} table-data entries listed by pg_restore`);

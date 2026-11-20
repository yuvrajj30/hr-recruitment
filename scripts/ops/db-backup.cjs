// Backup of the REAL database (hr_recruitment). pg_dump only READS the database.
//   node scripts/ops/db-backup.cjs <label>        e.g. before-release-20261120
// Writes <backups>/hr_recruitment-<label>-<stamp>.dump + .sha256, then proves the file is readable with
// pg_restore --list. Never overwrites an existing file. Same method as scripts/tz-ops/tz-backup.cjs, with a label.
// Verify it afterwards with: node scripts/tz-ops/tz-restore-verify.cjs --dump <file>
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const cp = require("child_process");
const req = (m) => require(require.resolve(m, { paths: [process.cwd()] }));
const stop = (m) => { console.error("STOPPED: " + m); process.exit(2); };

const label = process.argv[2];
if (!label || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(label)) stop("give a label of lower-case letters, digits and dashes, e.g. before-release-20261120");
if (process.env.MIGRATION_DATABASE_URL) stop("MIGRATION_DATABASE_URL is set in this shell; open a new terminal");
req("dotenv").config({ path: ".env", quiet: true });
const u = new URL(process.env.MIGRATION_DATABASE_URL);
if (u.pathname !== "/hr_recruitment" || decodeURIComponent(u.username) !== "hr_app") stop("expected hr_app on hr_recruitment");
const root = "C:\\Program Files\\PostgreSQL";
const bin = path.join(root, fs.readdirSync(root).filter((d) => /^\d+$/.test(d)).sort((a, b) => b - a)[0], "bin");
const env = { ...process.env, PGPASSWORD: decodeURIComponent(u.password) };
const dir = process.env.HR_BACKUP_DIR || path.join(os.homedir(), "hr-recruitment-backups");
fs.mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "");
const file = path.join(dir, `hr_recruitment-${label}-${stamp}.dump`);
if (fs.existsSync(file)) stop("file exists: " + file);

let r = cp.spawnSync(path.join(bin, "pg_dump.exe"), ["--format=custom", "--no-password", "--host", u.hostname, "--port", u.port || "5432",
  "--username", "hr_app", "--dbname", "hr_recruitment", "--file", file], { env, encoding: "utf8" });
if (r.status !== 0) stop("pg_dump failed: " + (r.stderr || "").replace(/postgres(ql)?:\/\/\S+/g, "<url>").slice(0, 300));
const sha = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
fs.writeFileSync(file + ".sha256", sha + "  " + path.basename(file) + "\n");
r = cp.spawnSync(path.join(bin, "pg_restore.exe"), ["--list", file], { encoding: "utf8", maxBuffer: 1 << 26 });
if (r.status !== 0) stop("pg_restore --list failed: the backup is not readable");
const entries = r.stdout.split("\n").filter((l) => / TABLE DATA /.test(l)).length;
console.log(`PASS  backup ${file}`);
console.log(`PASS  ${fs.statSync(file).size} bytes, sha256 ${sha}`);
console.log(`PASS  readable: ${entries} table-data entries listed by pg_restore`);

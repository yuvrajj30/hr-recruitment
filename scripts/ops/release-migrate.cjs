// Applies the pending release migration (maintenance identity, audit fix) to the REAL database (hr_recruitment),
// with guards, then checks the result.
//   node scripts/ops/release-migrate.cjs
// Refuses (and changes nothing) unless:
//   - the pending migrations are exactly the expected ones (same list as release-preflight.cjs);
//   - every pending migration file is committed in Git and unchanged (the applied bytes must stay the committed
//     bytes forever; Prisma compares checksums);
//   - a backup hr_recruitment-before-release-*.dump from the last 3 hours exists and matches its .sha256;
//   - the app is not connected (no hr_runtime session on hr_recruitment).
// Then runs `prisma migrate deploy` (each migration is one transaction; a safety stop inside a migration aborts
// it with nothing changed) and read-only post-checks.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const cp = require("child_process");
const req = (m) => require(require.resolve(m, { paths: [process.cwd()] }));
const { Client } = req("pg");
const stop = (m) => { console.error("STOPPED (nothing changed): " + m); process.exit(2); };

const EXPECTED_PENDING = [
  "20261127000000_maintenance_identity",
];

// The seven housekeeping functions that from now on only the scheduled job's account (hr_maintenance) may run.
const JOB_FUNCTIONS = ["app_remove_due_candidates", "app_pending_file_removals", "app_confirm_file_removed", "app_remove_old_attendance_device_data",
  "app_generate_standard_shifts", "app_leave_housekeeping", "app_task_housekeeping"];

if (process.env.MIGRATION_DATABASE_URL) stop("MIGRATION_DATABASE_URL is set in this shell; open a new terminal");
req("dotenv").config({ path: ".env", quiet: true });
const url = process.env.MIGRATION_DATABASE_URL;
const u = new URL(url);
if (u.pathname !== "/hr_recruitment" || decodeURIComponent(u.username) !== "hr_app") stop("expected hr_app on hr_recruitment");
const git = (args) => cp.spawnSync("git", args, { encoding: "utf8" });
let bad = 0;
const line = (ok, text) => { if (!ok) bad++; console.log((ok ? "PASS  " : "FAIL  ") + text); };

(async () => {
  const c = new Client({ connectionString: url, options: "-c TimeZone=UTC" });
  await c.connect();
  const q = async (sql, p = []) => (await c.query(sql, p)).rows;
  try {
    // ---- guards ----
    const dir = path.join(process.cwd(), "prisma", "migrations");
    const local = fs.readdirSync(dir).filter((d) => /^\d{14}_/.test(d)).sort();
    const applied = (await q(`SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`)).map((r) => r.migration_name);
    const failed = await q(`SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL`);
    if (failed.length) stop("a failed migration is recorded: " + failed.map((r) => r.migration_name).join(", "));
    const pending = local.filter((m) => !applied.includes(m));
    if (JSON.stringify(pending) !== JSON.stringify(EXPECTED_PENDING)) stop("pending migrations are not the expected ones: " + pending.join(", "));
    for (const m of pending) {
      const f = `prisma/migrations/${m}/migration.sql`;
      if (git(["ls-files", "--error-unmatch", f]).status !== 0) stop(`${m} is not committed in Git`);
      if (git(["diff", "--quiet", "HEAD", "--", f]).status !== 0) stop(`${m} differs from the committed file`);
    }
    console.log(`PASS  ${pending.length} pending migrations, all committed and unchanged`);
    const bdir = process.env.HR_BACKUP_DIR || path.join(os.homedir(), "hr-recruitment-backups");
    const backups = fs.readdirSync(bdir).filter((f) => /^hr_recruitment-before-release-.*\.dump$/.test(f))
      .map((f) => ({ f, full: path.join(bdir, f), t: fs.statSync(path.join(bdir, f)).mtimeMs })).sort((a, b) => b.t - a.t);
    if (!backups.length || Date.now() - backups[0].t > 3 * 3600_000) stop("no hr_recruitment-before-release-*.dump from the last 3 hours (run scripts/ops/db-backup.cjs before-release)");
    const want = fs.readFileSync(backups[0].full + ".sha256", "utf8").split(/\s+/)[0];
    if (crypto.createHash("sha256").update(fs.readFileSync(backups[0].full)).digest("hex") !== want) stop("the newest release backup does not match its .sha256");
    console.log(`PASS  fresh backup ${backups[0].f} matches its checksum`);
    const conns = (await q(`SELECT count(*)::int n FROM pg_stat_activity WHERE datname = 'hr_recruitment' AND usename = 'hr_runtime'`))[0].n;
    if (conns > 0) stop(`the app is connected (${conns} hr_runtime session(s)); stop it first`);
    console.log("PASS  the app is not connected");
  } finally {
    await c.end();
  }

  // ---- apply ----
  const r = cp.spawnSync("npx", ["prisma", "migrate", "deploy"], { encoding: "utf8", shell: true, env: { ...process.env, MIGRATION_DATABASE_URL: url } });
  process.stdout.write(((r.stdout || "") + (r.stderr || "")).replace(/postgres(ql)?:\/\/\S+/g, "<url>"));
  if (r.status !== 0) { console.error("\nprisma migrate deploy FAILED - see above. Each migration is its own transaction: check _prisma_migrations before anything else."); process.exit(1); }

  // ---- post-checks (read-only) ----
  const p = new Client({ connectionString: url, options: "-c TimeZone=UTC" });
  await p.connect();
  const pq = async (sql, a = []) => (await p.query(sql, a)).rows;
  try {
    await p.query("BEGIN READ ONLY");
    const done = (await pq(`SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`)).map((x) => x.migration_name);
    line(EXPECTED_PENDING.every((m) => done.includes(m)), "all release migrations are recorded as applied");
    const fns = await pq(`SELECT p.proname, bool_or(has_function_privilege('hr_runtime', p.oid, 'EXECUTE')) AS rt, bool_or(has_function_privilege('public', p.oid, 'EXECUTE')) AS pub,
        bool_or(has_function_privilege('hr_maintenance', p.oid, 'EXECUTE')) AS mt
      FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = ANY($1) GROUP BY p.proname`, [JOB_FUNCTIONS]);
    const ok = fns.filter((f) => !f.rt && !f.pub && f.mt).map((f) => f.proname);
    line(ok.length === JOB_FUNCTIONS.length, `${ok.length}/${JOB_FUNCTIONS.length} housekeeping functions: only hr_maintenance may run them${ok.length === JOB_FUNCTIONS.length ? "" : " (wrong: " + JOB_FUNCTIONS.filter((n) => !ok.includes(n)).join(", ") + ")"}`);
    const extra = (await pq(`SELECT p.proname FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
        AND has_function_privilege('hr_maintenance', p.oid, 'EXECUTE') AND NOT has_function_privilege('public', p.oid, 'EXECUTE') ORDER BY 1`)).map((x) => x.proname);
    line(JSON.stringify(extra) === JSON.stringify([...JOB_FUNCTIONS].sort()), `hr_maintenance may run nothing else${JSON.stringify(extra) === JSON.stringify([...JOB_FUNCTIONS].sort()) ? "" : ": " + extra.join(", ")}`);
    await p.query(`SELECT set_config('app.mode', 'maintenance', true)`);
    const [m] = await pq(`SELECT app_mode() AS m`);
    line(m.m === "refused", `maintenance mode set by another account is refused (owner session sees "${m.m}")`);
    await p.query(`SELECT set_config('app.mode', 'staff', true)`);
    const [s2] = await pq(`SELECT app_mode() AS m`);
    line(s2.m === "staff", "the web app's own modes are unchanged");
  } finally {
    await p.query("ROLLBACK").catch(() => {});
    await p.end();
  }
  console.log(bad ? `\n${bad} POST-CHECK(S) FAILED` : "\nMigration applied and all post-checks passed. Next: run the daily job once (npm run privacy:retention).");
  process.exitCode = bad ? 1 : 0;
})().catch((e) => { console.error("FAILED: " + String(e.message).replace(/postgres(ql)?:\/\/\S+/g, "<url>")); process.exit(1); });

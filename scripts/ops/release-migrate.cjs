// Applies the pending release migrations (Employee Management + Attendance) to the REAL database (hr_recruitment),
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
  "20261121000000_employee_management",
  "20261121010000_employee_management_fixes",
  "20261122000000_attendance_shifts",
  "20261122000100_attendance_records",
  "20261122000200_attendance_exit_rules",
  "20261122000300_attendance_fixes",
  "20261122000400_standard_shifts_and_shift_history",
  "20261122000500_standard_shifts_fixes",
];

const NEW_TABLES = ["outlets", "designations", "employees", "employee_assignments", "shifts", "attendance_records", "attendance_breaks",
  "attendance_changes", "attendance_correction_requests", "employee_shift_patterns", "shift_changes"];
const READ_ONLY_TABLES = ["attendance_records", "attendance_breaks", "attendance_changes", "attendance_correction_requests", "shift_changes", "employee_assignments"];
const APP_FUNCTIONS = ["app_my_employee_id", "app_has_permission", "app_clock_in", "app_clock_out", "app_break", "app_request_attendance_correction",
  "app_withdraw_attendance_correction", "app_hr_record_attendance", "app_hr_correct_attendance", "app_hr_void_attendance",
  "app_decide_attendance_correction", "app_remove_old_attendance_device_data", "app_apply_standard_shifts", "app_generate_standard_shifts"];
const INTERNAL_FUNCTIONS = ["att_sync_standard_shifts", "att_apply_correction", "att_lock_employee", "att_say", "att_check_period", "guard_shift",
  "guard_employee_status", "guard_employee_manager", "record_employee_assignment", "record_shift_change", "att_org_timezone"];

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
    const [ext] = await pq(`SELECT count(*)::int n FROM pg_extension WHERE extname = 'btree_gist'`);
    line(ext.n === 1, "btree_gist is installed");
    const rls = await pq(`SELECT relname, relrowsecurity FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' AND relname = ANY($1)`, [NEW_TABLES]);
    line(rls.length === NEW_TABLES.length && rls.every((r) => r.relrowsecurity), `row-level security is on for all ${NEW_TABLES.length} new tables (${rls.filter((r) => r.relrowsecurity).length}/${NEW_TABLES.length})`);
    const writes = await pq(`SELECT t FROM unnest($1::text[]) t WHERE has_table_privilege('hr_runtime', t, 'INSERT') OR has_table_privilege('hr_runtime', t, 'UPDATE') OR has_table_privilege('hr_runtime', t, 'DELETE') OR has_table_privilege('hr_runtime', t, 'TRUNCATE')`, [READ_ONLY_TABLES]);
    line(writes.length === 0, `the app can only read attendance, its history and shift history${writes.length ? ": writable: " + writes.map((r) => r.t).join(", ") : ""}`);
    const [sh] = await pq(`SELECT has_table_privilege('hr_runtime', 'shifts', 'DELETE') d, has_table_privilege('hr_runtime', 'shifts', 'TRUNCATE') t, has_table_privilege('hr_runtime', 'shifts', 'UPDATE') u`);
    line(!sh.d && !sh.t && !sh.u, "shifts: the app cannot delete or truncate, and may update only the allowed columns");
    const fns = await pq(`SELECT p.proname, bool_or(has_function_privilege('hr_runtime', p.oid, 'EXECUTE')) AS rt, bool_or(has_function_privilege('public', p.oid, 'EXECUTE')) AS pub
      FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = ANY($1) GROUP BY p.proname`, [[...APP_FUNCTIONS, ...INTERNAL_FUNCTIONS]]);
    const fn = Object.fromEntries(fns.map((x) => [x.proname, x]));
    const appOk = APP_FUNCTIONS.filter((n) => fn[n]?.rt === true && fn[n]?.pub === false);
    line(appOk.length === APP_FUNCTIONS.length, `${appOk.length}/${APP_FUNCTIONS.length} entry functions: the app may call them, nobody else${appOk.length === APP_FUNCTIONS.length ? "" : " (wrong: " + APP_FUNCTIONS.filter((n) => !appOk.includes(n)).join(", ") + ")"}`);
    const intOk = INTERNAL_FUNCTIONS.filter((n) => fn[n] && fn[n].rt === false && fn[n].pub === false);
    line(intOk.length === INTERNAL_FUNCTIONS.length, `${intOk.length}/${INTERNAL_FUNCTIONS.length} internal functions: not callable by the app or anyone else${intOk.length === INTERNAL_FUNCTIONS.length ? "" : " (wrong: " + INTERNAL_FUNCTIONS.filter((n) => !intOk.includes(n)).join(", ") + ")"}`);
    const clock = (await pq(`SELECT r.key FROM role_permissions rp JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id WHERE p.key = 'self:attendance_clock' ORDER BY 1`)).map((x) => x.key);
    line(clock.join(",") === "EMPLOYEE,HR_MANAGER,SUPER_ADMIN", `self:attendance_clock is held by all three roles (${clock.join(", ")})`);
    const [counts] = await pq(`SELECT (SELECT count(*) FROM employees)::int e, (SELECT count(*) FROM shifts)::int s, (SELECT count(*) FROM attendance_records)::int a`);
    console.log(`INFO  new tables start empty: ${counts.e} employees, ${counts.s} shifts, ${counts.a} attendance records`);
  } finally {
    await p.query("ROLLBACK").catch(() => {});
    await p.end();
  }
  console.log(bad ? `\n${bad} POST-CHECK(S) FAILED` : "\nMigrations applied and all post-checks passed.");
  process.exitCode = bad ? 1 : 0;
})().catch((e) => { console.error("FAILED: " + String(e.message).replace(/postgres(ql)?:\/\/\S+/g, "<url>")); process.exit(1); });

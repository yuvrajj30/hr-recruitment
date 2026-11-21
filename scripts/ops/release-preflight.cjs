// READ-ONLY pre-flight of the REAL database (hr_recruitment) before the release that brings Employee Management and
// Attendance (rota, standard shifts, clock-in/out, corrections, shift history).
//   node scripts/ops/release-preflight.cjs
// Everything runs inside BEGIN READ ONLY ... ROLLBACK as the owner account from .env: nothing can be changed.
// It reports:
//   - the migration history: every applied migration still matches its file byte for byte (Prisma checksum),
//     none failed, and exactly the expected migrations are pending;
//   - what the new migrations need: the btree_gist extension (installable by the owner account), a valid time zone
//     for every organisation (attendance computes local days with it), the three roles and the attendance
//     permissions they extend;
//   - whether the app is connected right now (it should be stopped while migrating);
//   - the newest backup.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const req = (m) => require(require.resolve(m, { paths: [process.cwd()] }));
const { Client } = req("pg");
const stop = (m) => { console.error("STOPPED: " + m); process.exit(2); };

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

if (process.env.MIGRATION_DATABASE_URL) stop("MIGRATION_DATABASE_URL is set in this shell; open a new terminal");
req("dotenv").config({ path: ".env", quiet: true });
const url = process.env.MIGRATION_DATABASE_URL;
const u = new URL(url);
if (u.pathname !== "/hr_recruitment" || decodeURIComponent(u.username) !== "hr_app") stop("expected hr_app on hr_recruitment");

let bad = 0;
const line = (ok, text) => { if (!ok) bad++; console.log((ok ? "PASS  " : "FAIL  ") + text); };
const info = (text) => console.log("INFO  " + text);

(async () => {
  const c = new Client({ connectionString: url, options: "-c TimeZone=UTC" });
  await c.connect();
  const q = async (sql, p = []) => (await c.query(sql, p)).rows;
  try {
    await c.query("BEGIN READ ONLY");
    line((await q("SELECT current_database() d"))[0].d === "hr_recruitment", "connected to hr_recruitment as hr_app, read-only transaction");

    // ---- migration history ----
    const dir = path.join(process.cwd(), "prisma", "migrations");
    const local = fs.readdirSync(dir).filter((d) => /^\d{14}_/.test(d)).sort();
    const rows = await q(`SELECT migration_name, checksum, finished_at IS NOT NULL AS done, rolled_back_at IS NOT NULL AS rolled_back FROM _prisma_migrations ORDER BY started_at`);
    const applied = rows.filter((r) => r.done && !r.rolled_back);
    const failed = rows.filter((r) => !r.done && !r.rolled_back);
    line(failed.length === 0, `no failed migration in the history${failed.length ? ": " + failed.map((r) => r.migration_name).join(", ") : ""}`);
    let mismatched = 0;
    for (const r of applied) {
      const f = path.join(dir, r.migration_name, "migration.sql");
      if (!fs.existsSync(f)) { mismatched++; console.log(`FAIL  applied migration has no file here: ${r.migration_name}`); continue; }
      const sum = crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
      if (sum !== r.checksum) { mismatched++; console.log(`FAIL  file differs from what was applied: ${r.migration_name}`); }
    }
    line(mismatched === 0, `${applied.length} applied migration(s) match their files byte for byte`);
    const pending = local.filter((m) => !applied.some((r) => r.migration_name === m));
    line(JSON.stringify(pending) === JSON.stringify(EXPECTED_PENDING), `pending migrations are exactly the ${EXPECTED_PENDING.length} expected ones${JSON.stringify(pending) === JSON.stringify(EXPECTED_PENDING) ? "" : ": " + pending.join(", ")}`);

    // ---- what the new migrations need ----
    const [ext] = await q(`SELECT e.installed_version, v.trusted, v.superuser,
        has_database_privilege(current_user, current_database(), 'CREATE') AS can_create
      FROM pg_available_extensions e JOIN pg_available_extension_versions v ON v.name = e.name AND v.version = e.default_version
      WHERE e.name = 'btree_gist'`);
    line(Boolean(ext) && (ext.installed_version !== null || (ext.trusted && ext.can_create)),
      `btree_gist ${ext ? (ext.installed_version ? `already installed (${ext.installed_version})` : `available, trusted=${ext.trusted}, owner may create=${ext.can_create}`) : "NOT AVAILABLE on this server"}`);
    const orgs = await q(`SELECT o.slug, o.timezone, EXISTS (SELECT 1 FROM pg_timezone_names t WHERE t.name = o.timezone) AS valid FROM organizations o ORDER BY o.slug`);
    info(`organisations: ${orgs.map((o) => `${o.slug} (${o.timezone})`).join(", ")}`);
    line(orgs.every((o) => o.valid), `every organisation has a real time zone${orgs.some((o) => !o.valid) ? ": not valid: " + orgs.filter((o) => !o.valid).map((o) => o.slug).join(", ") : ""}`);
    const roles = (await q(`SELECT key FROM roles ORDER BY key`)).map((r) => r.key);
    line(["EMPLOYEE", "HR_MANAGER", "SUPER_ADMIN"].every((k) => roles.includes(k)) && roles.length === 3, `exactly the three roles exist (${roles.join(", ")})`);
    const perms = (await q(`SELECT key FROM permissions WHERE key IN ('attendance:read', 'attendance:manage', 'self:attendance_read', 'employee:read', 'employee:manage', 'self:attendance_clock')`)).map((r) => r.key);
    line(["attendance:read", "attendance:manage", "self:attendance_read", "employee:read", "employee:manage"].every((k) => perms.includes(k)), "the attendance and employee permissions the migrations build on exist");
    info(`self:attendance_clock ${perms.includes("self:attendance_clock") ? "already exists" : "will be added (to all three roles)"}`);
    const clash = await q(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN
      ('outlets','designations','employees','employee_assignments','shifts','attendance_records','attendance_breaks','attendance_changes',
       'attendance_correction_requests','employee_shift_patterns','shift_changes')`);
    line(clash.length === 0, `none of the new tables exists yet${clash.length ? ": " + clash.map((r) => r.table_name).join(", ") : ""}`);
    const [depts] = await q(`SELECT count(*)::int AS n FROM departments`);
    info(`departments today: ${depts.n} (employees can be assigned to them)`);

    // ---- is the app connected? ----
    const conns = await q(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = 'hr_recruitment' AND usename = 'hr_runtime'`);
    info(`app connections (hr_runtime) right now: ${conns[0].n}${conns[0].n ? " - stop the app before migrating" : ""}`);
  } finally {
    await c.query("ROLLBACK").catch(() => {});
    await c.end();
  }

  // ---- newest backup ----
  const bdir = process.env.HR_BACKUP_DIR || path.join(os.homedir(), "hr-recruitment-backups");
  const dumps = fs.existsSync(bdir) ? fs.readdirSync(bdir).filter((f) => f.endsWith(".dump")).map((f) => ({ f, t: fs.statSync(path.join(bdir, f)).mtime })).sort((a, b) => b.t - a.t) : [];
  info(`newest backup: ${dumps.length ? `${dumps[0].f} (${dumps[0].t.toISOString()})` : "none"}`);

  console.log(bad ? `\n${bad} CHECK(S) FAILED - do not migrate` : "\nAll checks passed. Nothing was changed.");
  process.exitCode = bad ? 1 : 0;
})().catch((e) => { console.error("FAILED: " + String(e.message).replace(/postgres(ql)?:\/\/\S+/g, "<url>")); process.exit(1); });

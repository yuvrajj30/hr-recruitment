// READ-ONLY pre-flight of the REAL database (hr_recruitment) before the maintenance-identity release (audit fix: the
// daily housekeeping functions move from the web app's account hr_runtime to the scheduled job's own account
// hr_maintenance; app.mode = 'maintenance' alone no longer counts).
//   node scripts/ops/release-preflight.cjs
// Everything runs inside BEGIN READ ONLY ... ROLLBACK as the owner account from .env: nothing can be changed.
// It reports:
//   - the migration history: every applied migration still matches its file byte for byte (Prisma checksum),
//     none failed, and exactly the expected migration is pending;
//   - what the migration needs: the hr_maintenance account exists on the server, is a plain restricted login (no
//     superuser, no bypass of row-level security, no role or database creation, NOINHERIT, member of no other role),
//     may connect to hr_recruitment, and has no table rights; the seven housekeeping functions exist;
//   - whether the job's settings file .env.maintenance is ready (the account name only, never the password), and
//     that .env does not hold the maintenance connection;
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
    info(`last applied: ${applied.length ? applied[applied.length - 1].migration_name : "none"}`);
    const pending = local.filter((m) => !applied.some((r) => r.migration_name === m));
    line(JSON.stringify(pending) === JSON.stringify(EXPECTED_PENDING), `pending migrations are exactly the ${EXPECTED_PENDING.length} expected ones${JSON.stringify(pending) === JSON.stringify(EXPECTED_PENDING) ? "" : ": " + pending.join(", ")}`);
    for (const m of EXPECTED_PENDING) {
      const f = path.join(dir, m, "migration.sql");
      if (fs.existsSync(f)) info(`${m}  sha256 ${crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex").slice(0, 16)}...`);
    }

    // ---- what the new migration needs ----
    const [role] = await q(`SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication, rolinherit, rolcanlogin,
        (SELECT count(*)::int FROM pg_auth_members m WHERE m.member = r.oid) AS member_of,
        has_database_privilege(r.oid, 'hr_recruitment', 'CONNECT') AS can_connect
      FROM pg_roles r WHERE r.rolname = 'hr_maintenance'`);
    line(Boolean(role), "the hr_maintenance account exists on the server (prisma/sql/m4-01-create-maintenance-role.sql)");
    if (role) {
      const plain = role.rolcanlogin && !role.rolsuper && !role.rolbypassrls && !role.rolcreaterole && !role.rolcreatedb && !role.rolreplication && !role.rolinherit && role.member_of === 0;
      line(plain, "hr_maintenance is a plain restricted login (no superuser, no RLS bypass, no create role/database, no replication, NOINHERIT, member of no other role)");
      line(role.can_connect, "hr_maintenance may connect to hr_recruitment");
      const explicit = (await q(`SELECT datacl::text AS acl FROM pg_database WHERE datname = 'hr_recruitment'`))[0].acl || "";
      info(`CONNECT for hr_maintenance on hr_recruitment: ${/(^|[{,])hr_maintenance=/.test(explicit) ? "granted explicitly" : "only through PUBLIC (run: GRANT CONNECT ON DATABASE hr_recruitment TO hr_maintenance;)"}`);
      const tables = await q(`SELECT c.relname FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r','v','p')
        AND (has_table_privilege('hr_maintenance', c.oid, 'SELECT') OR has_table_privilege('hr_maintenance', c.oid, 'INSERT') OR has_table_privilege('hr_maintenance', c.oid, 'UPDATE') OR has_table_privilege('hr_maintenance', c.oid, 'DELETE'))`);
      line(tables.length === 0, `hr_maintenance has no table rights${tables.length ? ": " + tables.map((r) => r.relname).join(", ") : ""}`);
    }
    const fns = await q(`SELECT p.proname, bool_or(has_function_privilege('hr_runtime', p.oid, 'EXECUTE')) AS rt FROM pg_proc p
      WHERE p.pronamespace = 'public'::regnamespace AND p.proname = ANY($1) GROUP BY p.proname`, [JOB_FUNCTIONS]);
    line(fns.length === JOB_FUNCTIONS.length, `the seven housekeeping functions exist (${fns.length}/${JOB_FUNCTIONS.length})`);
    info(`today the web app's account may run ${fns.filter((f) => f.rt).length} of them (the release takes them all away)`);
    const [mode] = await q(`SELECT pg_get_functiondef('app_mode()'::regprocedure) ~ 'session_user' AS new`);
    line(!mode.new, "app_mode() is still the old one (not changed yet)");

    // ---- the job's settings ----
    const read = (f) => (fs.existsSync(f) ? req("dotenv").parse(fs.readFileSync(f)) : null);
    const shared = read(path.join(process.cwd(), ".env")) || {};
    line(shared.MAINTENANCE_DATABASE_URL === undefined, ".env does not hold MAINTENANCE_DATABASE_URL (the web app reads .env)");
    const own = read(path.join(process.cwd(), ".env.maintenance"));
    let jobUrl = null;
    try { jobUrl = own && own.MAINTENANCE_DATABASE_URL ? new URL(own.MAINTENANCE_DATABASE_URL) : null; } catch { jobUrl = null; }
    line(Boolean(jobUrl) && decodeURIComponent(jobUrl.username) === "hr_maintenance" && jobUrl.pathname === "/hr_recruitment",
      `.env.maintenance sets MAINTENANCE_DATABASE_URL for hr_maintenance on hr_recruitment${own ? "" : " (file missing)"}`);

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

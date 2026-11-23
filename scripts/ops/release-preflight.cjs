// READ-ONLY pre-flight of the REAL database (hr_recruitment) before the Leave release (CafeOS Milestone 3: leave
// types, holidays, balances ledger, requests and decisions, who is off; plus the faster organisation time zone check).
//   node scripts/ops/release-preflight.cjs
// Everything runs inside BEGIN READ ONLY ... ROLLBACK as the owner account from .env: nothing can be changed.
// It reports:
//   - the migration history: every applied migration still matches its file byte for byte (Prisma checksum),
//     none failed, and exactly the expected migrations are pending;
//   - what the new migrations need: the btree_gist extension (installed by the Attendance release), a valid time
//     zone for every organisation, the three roles, the leave permissions they extend, and the released functions
//     Leave replaces (app_clock_in, att_sync_standard_shifts, guard_employee_status, att_org_timezone); no name clash;
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
  "20261123000000_leave",
  "20261123000100_leave_functions",
  "20261123000200_time_zone_lookup",
  "20261123000300_leave_review_fixes",
  "20261123000400_who_is_off_for_staff",
  "20261123000500_leave_days_off_and_shift_return",
];
const NEW_TABLES = ["leave_types", "holidays", "leave_ledger", "leave_requests", "time_zone_names", "leave_request_days"];
const NEW_TYPES = ["LeaveAccrual", "LeaveLedgerKind", "LeaveRequestStatus"];
const REPLACED_FUNCTIONS = ["app_clock_in", "att_sync_standard_shifts", "guard_employee_status", "att_org_timezone"];
const LEAVE_PERMISSIONS = ["leave:read", "leave:approve", "self:leave_apply", "self:leave_read"];

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

    // ---- what the new migrations need ----
    const ext = await q(`SELECT extversion FROM pg_extension WHERE extname = 'btree_gist'`);
    line(ext.length === 1, `btree_gist is installed${ext.length ? ` (${ext[0].extversion})` : " - NOT installed (leave_requests needs it)"}`);
    const orgs = await q(`SELECT o.slug, o.timezone, o.status, EXISTS (SELECT 1 FROM pg_timezone_names t WHERE t.name = o.timezone) AS valid FROM organizations o ORDER BY o.slug`);
    info(`organisations: ${orgs.map((o) => `${o.slug} (${o.timezone}, ${o.status})`).join(", ")} - each gets the five leave types`);
    line(orgs.every((o) => o.valid), `every organisation has a real time zone${orgs.some((o) => !o.valid) ? ": not valid: " + orgs.filter((o) => !o.valid).map((o) => o.slug).join(", ") : ""}`);
    const roles = (await q(`SELECT key FROM roles ORDER BY key`)).map((r) => r.key);
    line(["EMPLOYEE", "HR_MANAGER", "SUPER_ADMIN"].every((k) => roles.includes(k)) && roles.length === 3, `exactly the three roles exist (${roles.join(", ")})`);
    const perms = (await q(`SELECT key FROM permissions WHERE key = ANY($1)`, [[...LEAVE_PERMISSIONS, "leave:manage"]])).map((r) => r.key);
    line(LEAVE_PERMISSIONS.every((k) => perms.includes(k)), `the leave permissions the migrations build on exist (${LEAVE_PERMISSIONS.filter((k) => perms.includes(k)).join(", ")})`);
    info(`leave:manage ${perms.includes("leave:manage") ? "already exists" : "will be added (Super Admin and HR Manager)"}`);
    const fns = (await q(`SELECT DISTINCT proname FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = ANY($1)`, [REPLACED_FUNCTIONS])).map((r) => r.proname);
    line(REPLACED_FUNCTIONS.every((f) => fns.includes(f)), `the released functions Leave replaces exist (${fns.sort().join(", ")})`);
    const clashT = await q(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ANY($1)`, [NEW_TABLES]);
    line(clashT.length === 0, `none of the new tables exists yet${clashT.length ? ": " + clashT.map((r) => r.table_name).join(", ") : ""}`);
    const clashY = await q(`SELECT typname FROM pg_type WHERE typnamespace = 'public'::regnamespace AND typname = ANY($1)`, [NEW_TYPES]);
    line(clashY.length === 0, `none of the new types exists yet${clashY.length ? ": " + clashY.map((r) => r.typname).join(", ") : ""}`);
    const [counts] = await q(`SELECT (SELECT count(*) FROM employees)::int e, (SELECT count(*) FROM shifts WHERE status = 'PLANNED')::int s, (SELECT count(*) FROM employee_shift_patterns)::int p`);
    info(`today: ${counts.e} employee record(s), ${counts.s} planned shift(s), ${counts.p} standard shift pattern(s)`);

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

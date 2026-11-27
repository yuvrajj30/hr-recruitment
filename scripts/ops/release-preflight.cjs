// READ-ONLY pre-flight of the REAL database (hr_recruitment) before the Tasks release (CafeOS Milestone 4 Part 1:
// HR-assigned tasks with proof, review and a 1-5 rating, plus in-app notifications for them).
//   node scripts/ops/release-preflight.cjs
// Everything runs inside BEGIN READ ONLY ... ROLLBACK as the owner account from .env: nothing can be changed.
// It reports:
//   - the migration history: every applied migration still matches its file byte for byte (Prisma checksum),
//     none failed, and exactly the expected migrations are pending;
//   - what the new migrations need: the three roles, the identity and helper functions they call (app_org_id,
//     app_my_employee_id, att_org_timezone, block_attendance_truncate, ...), the notifications table without a
//     task_id yet; no name clash with the new tables, types, functions or the outlets policy;
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
  "20261124000000_tasks",
  "20261124000100_task_functions",
  "20261124000200_task_fixes",
  "20261124000300_task_outlet_visibility",
];
const NEW_TABLES = ["tasks", "task_events", "task_submissions", "task_evidence", "task_resources", "task_reminders"];
const NEW_TYPES = ["TaskStatus", "TaskPriority", "TaskProofKind", "TaskEventKind", "TaskResourceKind", "TaskReminderKind"];
// Released functions the task migrations call (they must exist and keep their meaning).
const REQUIRED_FUNCTIONS = ["app_org_id", "app_user_id", "app_my_employee_id", "app_staff_role", "app_has_permission", "app_mode",
  "att_org_timezone", "block_attendance_truncate"];
const NEW_FUNCTIONS = ["app_assign_task", "app_edit_task", "app_start_task", "app_add_task_note", "app_submit_task", "app_review_task",
  "app_cancel_task", "app_add_task_resource", "app_remove_task_resource", "app_task_housekeeping", "task_require", "task_lock",
  "task_require_owner", "task_active_employee", "task_active_outlet", "task_text", "task_today", "task_owner_login", "task_owner_with_login",
  "task_reviewers", "task_notify", "task_event", "task_file_ok", "task_check_four_eyes", "task_proof_ok", "block_task_history_updates"];
const TASK_PERMISSIONS = ["task:manage", "self:task"];

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
    const roles = (await q(`SELECT key FROM roles ORDER BY key`)).map((r) => r.key);
    line(["EMPLOYEE", "HR_MANAGER", "SUPER_ADMIN"].every((k) => roles.includes(k)) && roles.length === 3, `exactly the three roles exist (${roles.join(", ")})`);
    const perms = (await q(`SELECT key FROM permissions WHERE key = ANY($1)`, [TASK_PERMISSIONS])).map((r) => r.key);
    info(`task permissions: ${perms.length ? "already exist: " + perms.join(", ") : "will be added (task:manage to Super Admin and HR Manager, self:task to all three roles)"}`);
    const fns = (await q(`SELECT DISTINCT proname FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = ANY($1)`, [REQUIRED_FUNCTIONS])).map((r) => r.proname);
    line(REQUIRED_FUNCTIONS.every((f) => fns.includes(f)), `the released functions the migrations call exist (${fns.length}/${REQUIRED_FUNCTIONS.length}${REQUIRED_FUNCTIONS.every((f) => fns.includes(f)) ? "" : "; missing: " + REQUIRED_FUNCTIONS.filter((f) => !fns.includes(f)).join(", ")})`);
    const clashF = (await q(`SELECT DISTINCT proname FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = ANY($1)`, [NEW_FUNCTIONS])).map((r) => r.proname);
    line(clashF.length === 0, `none of the new functions exists yet${clashF.length ? ": " + clashF.join(", ") : ""}`);
    const clashT = await q(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ANY($1)`, [NEW_TABLES]);
    line(clashT.length === 0, `none of the new tables exists yet${clashT.length ? ": " + clashT.map((r) => r.table_name).join(", ") : ""}`);
    const clashY = await q(`SELECT typname FROM pg_type WHERE typnamespace = 'public'::regnamespace AND typname = ANY($1)`, [NEW_TYPES]);
    line(clashY.length === 0, `none of the new types exists yet${clashY.length ? ": " + clashY.map((r) => r.typname).join(", ") : ""}`);
    const col = await q(`SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'notifications' AND column_name = 'task_id'`);
    line(col.length === 0, "notifications has no task_id column yet");
    const pol = await q(`SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'outlets' AND policyname = 'own_task_outlet'`);
    line(pol.length === 0, "the outlets table has no own_task_outlet policy yet");
    const [counts] = await q(`SELECT (SELECT count(*) FROM employees WHERE status = 'ACTIVE')::int e, (SELECT count(*) FROM employees WHERE status = 'ACTIVE' AND member_id IS NOT NULL)::int l, (SELECT count(*) FROM notifications)::int n`);
    info(`today: ${counts.e} active employee(s), ${counts.l} with a linked login (only those can be given tasks), ${counts.n} notification(s)`);

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

// Applies the pending release migrations (Leave, CafeOS Milestone 3) to the REAL database (hr_recruitment),
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
  "20261123000000_leave",
  "20261123000100_leave_functions",
  "20261123000200_time_zone_lookup",
  "20261123000300_leave_review_fixes",
  "20261123000400_who_is_off_for_staff",
  "20261123000500_leave_days_off_and_shift_return",
];

const NEW_TABLES = ["leave_types", "holidays", "leave_ledger", "leave_requests", "time_zone_names", "leave_request_days"];
// The app only reads these (the database functions write them).
const READ_ONLY_TABLES = ["leave_ledger", "leave_requests"];
// The app may not even read these (only the database functions use them).
const NO_ACCESS_TABLES = ["time_zone_names", "leave_request_days"];
const APP_FUNCTIONS = ["app_request_leave", "app_withdraw_leave", "app_decide_leave", "app_hr_record_leave", "app_cancel_leave", "app_adjust_leave",
  "app_leave_preview", "app_leave_housekeeping", "app_who_is_off", "app_clock_in"];
const INTERNAL_FUNCTIONS = ["leave_count_days", "leave_day_weights", "leave_balance", "leave_available", "leave_on_full_leave", "leave_lock_employee",
  "leave_require", "leave_me", "leave_type_of", "leave_check_request", "leave_other_approver_exists", "leave_cancel_shifts", "leave_approve",
  "leave_refill_standard_shifts", "leave_seed_types", "seed_leave_types_for_new_org", "guard_leave_type", "block_leave_ledger_updates",
  "att_sync_standard_shifts", "guard_employee_status", "att_org_timezone"];

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
    const rls = await pq(`SELECT relname, relrowsecurity FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' AND relname = ANY($1)`, [NEW_TABLES]);
    line(rls.length === NEW_TABLES.length && rls.every((r) => r.relrowsecurity), `row-level security is on for all ${NEW_TABLES.length} new tables (${rls.filter((r) => r.relrowsecurity).length}/${NEW_TABLES.length})`);
    const writes = await pq(`SELECT t FROM unnest($1::text[]) t WHERE has_table_privilege('hr_runtime', t, 'INSERT') OR has_table_privilege('hr_runtime', t, 'UPDATE') OR has_table_privilege('hr_runtime', t, 'DELETE') OR has_table_privilege('hr_runtime', t, 'TRUNCATE')`, [READ_ONLY_TABLES]);
    line(writes.length === 0, `the app can only read the leave ledger and requests${writes.length ? ": writable: " + writes.map((r) => r.t).join(", ") : ""}`);
    const hidden = await pq(`SELECT t FROM unnest($1::text[]) t WHERE has_table_privilege('hr_runtime', t, 'SELECT') OR has_table_privilege('hr_runtime', t, 'INSERT') OR has_table_privilege('hr_runtime', t, 'UPDATE') OR has_table_privilege('hr_runtime', t, 'DELETE')`, [NO_ACCESS_TABLES]);
    line(hidden.length === 0, `the app cannot touch the time zone list or the per-day charges${hidden.length ? ": open: " + hidden.map((r) => r.t).join(", ") : ""}`);
    const [lt] = await pq(`SELECT has_table_privilege('hr_runtime', 'leave_types', 'DELETE') d, has_table_privilege('hr_runtime', 'leave_types', 'TRUNCATE') t, has_table_privilege('hr_runtime', 'holidays', 'UPDATE') hu`);
    line(!lt.d && !lt.t && !lt.hu, "leave types cannot be deleted by the app; holidays are added or removed, never edited");
    const fns = await pq(`SELECT p.proname, bool_or(has_function_privilege('hr_runtime', p.oid, 'EXECUTE')) AS rt, bool_or(has_function_privilege('public', p.oid, 'EXECUTE')) AS pub
      FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = ANY($1) GROUP BY p.proname`, [[...APP_FUNCTIONS, ...INTERNAL_FUNCTIONS]]);
    const fn = Object.fromEntries(fns.map((x) => [x.proname, x]));
    const appOk = APP_FUNCTIONS.filter((n) => fn[n]?.rt === true && fn[n]?.pub === false);
    line(appOk.length === APP_FUNCTIONS.length, `${appOk.length}/${APP_FUNCTIONS.length} entry functions: the app may call them, nobody else${appOk.length === APP_FUNCTIONS.length ? "" : " (wrong: " + APP_FUNCTIONS.filter((n) => !appOk.includes(n)).join(", ") + ")"}`);
    const intOk = INTERNAL_FUNCTIONS.filter((n) => fn[n] && fn[n].rt === false && fn[n].pub === false);
    line(intOk.length === INTERNAL_FUNCTIONS.length, `${intOk.length}/${INTERNAL_FUNCTIONS.length} internal functions: not callable by the app or anyone else${intOk.length === INTERNAL_FUNCTIONS.length ? "" : " (wrong: " + INTERNAL_FUNCTIONS.filter((n) => !intOk.includes(n)).join(", ") + ")"}`);
    const manage = (await pq(`SELECT r.key FROM role_permissions rp JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id WHERE p.key = 'leave:manage' ORDER BY 1`)).map((x) => x.key);
    line(manage.join(",") === "HR_MANAGER,SUPER_ADMIN", `leave:manage is held by Super Admin and HR Manager only (${manage.join(", ")})`);
    const types = await pq(`SELECT o.slug, string_agg(t.code || CASE WHEN t.configured THEN '*' ELSE '' END, ',' ORDER BY t.code) AS codes
      FROM organizations o LEFT JOIN leave_types t ON t.organization_id = o.id GROUP BY o.slug ORDER BY o.slug`);
    line(types.every((t) => t.codes === "CL,CO,EL,SL,UL*"), `every organisation has the five leave types, only unpaid set up (${types.map((t) => `${t.slug}: ${t.codes}`).join("; ")})`);
    const [tz] = await pq(`SELECT count(*)::int n FROM time_zone_names`);
    line(tz.n > 300, `the time zone list is filled (${tz.n} names)`);
    const [counts] = await pq(`SELECT (SELECT count(*) FROM leave_requests)::int r, (SELECT count(*) FROM leave_ledger)::int l, (SELECT count(*) FROM holidays)::int h`);
    console.log(`INFO  new tables start empty: ${counts.r} requests, ${counts.l} ledger lines, ${counts.h} holidays`);
  } finally {
    await p.query("ROLLBACK").catch(() => {});
    await p.end();
  }
  console.log(bad ? `\n${bad} POST-CHECK(S) FAILED` : "\nMigrations applied and all post-checks passed.");
  process.exitCode = bad ? 1 : 0;
})().catch((e) => { console.error("FAILED: " + String(e.message).replace(/postgres(ql)?:\/\/\S+/g, "<url>")); process.exit(1); });

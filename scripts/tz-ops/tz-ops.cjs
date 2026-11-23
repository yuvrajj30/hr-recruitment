// Timestamp correction operations tool (see prisma/proposals/README-timestamp-correction.md).
//
//   node scripts/tz-ops/tz-ops.cjs preflight [--database <name>] [--allow-recent-sessions]
//        READ-ONLY. Checks the database is exactly in the state the correction was written for, and that
//        NOTHING ELSE IS CONNECTED to it (the app must be stopped).
//   node scripts/tz-ops/tz-ops.cjs apply --database <name> --confirm "CORRECT TIMESTAMPS IN <name>" [--allow-recent-sessions]
//        Locks EVERY table, checks again that nothing else is connected, then runs
//        prisma/proposals/timestamp-correction.sql in ONE transaction, compares every timestamp before and after
//        inside that transaction, and COMMITS ONLY IF EVERY CHECK PASSES (otherwise ROLLBACK: nothing changes).
//        Writes a before/after report next to the backups.
//   node scripts/tz-ops/tz-ops.cjs post [--database <name>] [--report <file>]
//                                       [--expected <file>] [--write-expected <file>] [--allow-later-activity]
//        READ-ONLY. Verifies the result. With --report, every value recorded by "apply" is compared with the
//        database as it is now: a missing row, a missing timestamp column or a changed value is a FAILURE unless
//        it is listed in --expected (the changes the migrations are known to make). --write-expected records
//        that list from a rehearsal copy. --allow-later-activity accepts values written after the correction
//        (for checks made once the app is in use again).
//
// --allow-recent-sessions: someone signed in during the last 15 minutes is normally a failure ("is the app
// really stopped?"). Pass this only after stopping the app yourself; open connections are still refused.
//
// The database name defaults to hr_recruitment (the real database). Connections use the owner account from
// MIGRATION_DATABASE_URL in .env; only the database name is swapped. Run from the project folder.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const req = (m) => require(require.resolve(m, { paths: [process.cwd()] }));
const { Client } = req("pg");

const SHIFT_US = 330n * 60n * 1_000_000n; // 5 h 30 min in microseconds
const EXPECTED_LAST_MIGRATION = "20261115090000_m3_applications_pipeline";
const SQL_FILE = path.join("prisma", "proposals", "timestamp-correction.sql");
const BACKUP_DIR = process.env.HR_BACKUP_DIR || path.join(os.homedir(), "hr-recruitment-backups");
const EXCLUDED_TABLES = ["_prisma_migrations", "timestamp_corrections", "audit_log_time_corrections"];
const CORRECTION_TABLES = ["audit_log_time_corrections", "timestamp_corrections"];
const LOCK_WAIT = "5s";

const args = process.argv.slice(2);
const mode = args[0];
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const flag = (name) => args.includes(name);
const DB = opt("--database") || "hr_recruitment";
const stop = (m) => { console.error("\nSTOPPED: " + m); process.exit(2); };
let bad = 0;
const line = (ok, text) => { if (!ok) bad++; console.log((ok ? "PASS  " : "FAIL  ") + text); };
const warn = (text) => console.log("WARN  " + text);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (process.env.MIGRATION_DATABASE_URL) stop("MIGRATION_DATABASE_URL is set in this shell and would override .env. Open a new terminal.");
req("dotenv").config({ path: ".env", quiet: true });
const base = process.env.MIGRATION_DATABASE_URL;
if (!base) stop("MIGRATION_DATABASE_URL is missing from .env");
if (decodeURIComponent(new URL(base).username) !== "hr_app") stop("expected the owner account hr_app");
if (!/^hr_recruitment[a-z0-9_]*$/.test(DB)) stop("unexpected database name");
const urlFor = (db) => { const u = new URL(base); u.pathname = "/" + db; return u.toString(); };
const connect = async (readOnly) => {
  const c = new Client({ connectionString: urlFor(DB), application_name: "tz-ops", options: `-c TimeZone=UTC${readOnly ? " -c default_transaction_read_only=on" : ""}` });
  await c.connect();
  const name = (await c.query("SELECT current_database() AS d")).rows[0].d;
  if (name !== DB) { await c.end(); stop(`connected to ${name}, expected ${DB}`); }
  return c;
};

// Every OTHER connection to this database (the app, a tool, a console ...). A connection this tool closed a
// moment ago can linger for a few milliseconds, so an apparent one is looked at again before it counts.
async function otherConnections(c) {
  const sql = `SELECT pid, usename, COALESCE(NULLIF(application_name, ''), '(no name)') AS app, state,
                      to_char(backend_start AT TIME ZONE 'UTC', 'HH24:MI:SS') AS since
               FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND backend_type = 'client backend' ORDER BY backend_start`;
  let rows = (await c.query(sql)).rows;
  for (let i = 0; i < 4 && rows.length > 0 && rows.every((r) => r.app === "tz-ops"); i++) { await sleep(250); rows = (await c.query(sql)).rows; }
  return rows;
}
const describeConnections = (rows) => rows.map((r) => `${r.usename} via ${r.app} (${r.state || "?"}, connected ${r.since} UTC, pid ${r.pid})`).join("; ");

// Every timestamptz column (except the tool's own records), with each table's primary key.
async function inventory(c) {
  // Base tables only (views such as audit_logs_display also appear in information_schema.columns).
  const cols = (await c.query(`SELECT c.table_name, c.column_name FROM information_schema.columns c
    JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
    WHERE c.table_schema='public' AND c.data_type='timestamp with time zone' AND c.table_name <> ALL($1) ORDER BY 1,2`, [EXCLUDED_TABLES])).rows;
  const noKey = [];
  const tables = new Map();
  for (const r of cols) tables.set(r.table_name, [...(tables.get(r.table_name) || []), r.column_name]);
  const out = [];
  for (const [t, cs] of tables) {
    const pk = (await c.query(`SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=ANY(i.indkey)
      WHERE i.indrelid=$1::regclass AND i.indisprimary ORDER BY a.attnum`, [t])).rows.map((r) => r.attname);
    if (pk.length === 0) { noKey.push(t); continue; }
    out.push({ table: t, columns: cs, pk });
  }
  if (noKey.length) stop("table(s) without a primary key cannot be verified: " + noKey.join(", "));
  return out;
}
// table|key|column -> microseconds since epoch as a string (exact), or null
async function snapshot(c, inv) {
  const snap = {};
  for (const { table, columns, pk } of inv) {
    const key = pk.map((k) => `"${k}"::text`).join(` || '|' || `);
    const sel = columns.map((col) => `(EXTRACT(EPOCH FROM "${col}") * 1000000)::bigint::text AS "${col}"`).join(", ");
    for (const r of (await c.query(`SELECT ${key} AS k, ${sel} FROM "${table}"`)).rows) {
      for (const col of columns) snap[`${table}|${r.k}|${col}`] = r[col];
    }
  }
  return snap;
}
const baseTables = async (c) => (await c.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`)).rows.map((r) => r.tablename);

async function preflight(c) {
  console.log(`Preflight for database "${DB}" (read-only)\n`);
  line((await c.query("SHOW TimeZone")).rows[0].TimeZone === "UTC", "this session uses UTC");
  const plain = new Client({ connectionString: urlFor(DB), application_name: "tz-ops", options: "-c default_transaction_read_only=on" });
  await plain.connect();
  const serverTz = (await plain.query("SHOW TimeZone")).rows[0].TimeZone;
  await plain.end();
  console.log(`INFO  server's configured time zone: ${serverTz} (the cause; the app will use UTC sessions after the switch)`);
  const migs = (await c.query(`SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name`)).rows.map((r) => r.migration_name);
  line(migs[migs.length - 1] === EXPECTED_LAST_MIGRATION, `last applied migration is ${EXPECTED_LAST_MIGRATION} (found ${migs[migs.length - 1]})`);
  line((await c.query("SELECT to_regclass('public.staff_invitations') AS t")).rows[0].t === null, "later migrations (three roles and after) are NOT applied yet");
  const tc = (await c.query("SELECT to_regclass('public.timestamp_corrections') AS t")).rows[0].t;
  const done = tc ? (await c.query("SELECT count(*)::int AS n FROM timestamp_corrections")).rows[0].n : 0;
  line(done === 0, "the correction has not been applied before");
  line((await c.query("SELECT count(*)::int AS n FROM permissions WHERE key='document:read'")).rows[0].n === 1, "the one database-stamped exception (permission document:read) exists");
  const trg = (await c.query(`SELECT tgname, tgenabled FROM pg_trigger WHERE tgname IN ('application_status_history_no_update','application_assignments_no_update','audit_logs_append_only')`)).rows;
  line(trg.length === 3 && trg.every((t) => t.tgenabled === "O"), "append-only triggers exist and are enabled (history, assignments, audit log)");

  // The app must be stopped: nothing else may be connected, and nobody may have been active just now.
  const others = await otherConnections(c);
  line(others.length === 0, others.length === 0 ? "nothing else is connected to this database (the app is stopped)"
    : `${others.length} other connection(s) to this database: stop the app and close every other tool first: ${describeConnections(others)}`);
  const recent = (await c.query(`SELECT count(*)::int AS n FROM sessions WHERE revoked_at IS NULL AND last_seen_at > now() - interval '15 minutes' - interval '5 hours 30 minutes'`)).rows[0].n;
  if (recent === 0) line(true, "nobody was active in the app during the last 15 minutes");
  else if (flag("--allow-recent-sessions")) warn(`${recent} session(s) were active in the last 15 minutes; accepted because --allow-recent-sessions was given (you confirmed the app is stopped)`);
  else line(false, `${recent} session(s) were active in the last 15 minutes: stop the app, then wait or pass --allow-recent-sessions`);

  if (DB === "hr_recruitment") {
    const backups = fs.existsSync(BACKUP_DIR) ? fs.readdirSync(BACKUP_DIR).filter((f) => /^hr_recruitment-before-tz-.*\.dump$/.test(f)) : [];
    const fresh = backups.map((f) => path.join(BACKUP_DIR, f)).filter((f) => Date.now() - fs.statSync(f).mtimeMs < 6 * 3600_000 && fs.existsSync(f + ".sha256"));
    const verified = fresh.filter((f) => fs.readFileSync(f + ".sha256", "utf8").split(/\s+/)[0] === crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex"));
    line(verified.length > 0, `a verified database backup from the last 6 hours exists in ${BACKUP_DIR}`);
  }
  const inv = await inventory(c);
  const snap = await snapshot(c, inv);
  const values = Object.values(snap).filter((v) => v !== null).length;
  console.log(`INFO  ${inv.length} tables with timestamps; ${values} stored values; ${Object.keys(snap).length - values} empty`);
  console.log(`INFO  audit log rows that will get a correction note: ${(await c.query("SELECT count(*)::int AS n FROM audit_logs")).rows[0].n}`);

  // What the migrations that follow the correction need (three roles ... security hardening). Read-only.
  console.log("\nFor the migrations that follow:");
  const dbOwner = (await c.query("SELECT pg_get_userbyid(datdba) AS o FROM pg_database WHERE datname = current_database()")).rows[0].o;
  line(dbOwner === "hr_app", `the owner account owns this database (needed to restrict temporary tables): ${dbOwner}`);
  const ext = (await c.query("SELECT installed_version IS NOT NULL AS installed FROM pg_available_extensions WHERE name = 'pgcrypto'")).rows[0];
  line(Boolean(ext), `password checking inside the database is available (pgcrypto${ext && ext.installed ? ", already installed" : ""})`);
  // The session token and passwords travel to the database as query parameters: they must never be logged.
  const setting = async (name) => (await c.query("SELECT setting FROM pg_settings WHERE name = $1", [name])).rows[0]?.setting;
  const logs = { log_statement: await setting("log_statement"), log_min_duration_statement: await setting("log_min_duration_statement"), log_parameter_max_length_on_error: await setting("log_parameter_max_length_on_error") };
  line(logs.log_statement === "none" && logs.log_min_duration_statement === "-1" && logs.log_parameter_max_length_on_error === "0",
    `the server does not log query parameters (${Object.entries(logs).map(([k, v]) => `${k}=${v}`).join(", ")})`);
  // Sessions the role migration will end: open sessions of members it suspends (former Recruiters / Interviewers).
  const toEnd = (await c.query(`
    SELECT u.email, count(s.id)::int AS open_sessions
    FROM organization_members om
    JOIN users u ON u.id = om.user_id
    LEFT JOIN sessions s ON s.user_id = om.user_id AND s.revoked_at IS NULL
    WHERE om.status <> 'SUSPENDED'
      AND EXISTS (SELECT 1 FROM organization_member_roles mr JOIN roles r ON r.id = mr.role_id WHERE mr.member_id = om.id AND r.key IN ('RECRUITER', 'INTERVIEWER'))
      AND NOT EXISTS (SELECT 1 FROM organization_member_roles mr JOIN roles r ON r.id = mr.role_id WHERE mr.member_id = om.id AND r.key IN ('ADMIN', 'SUPER_ADMIN', 'HR_MANAGER'))
    GROUP BY u.email ORDER BY u.email`)).rows;
  for (const m of toEnd) console.log(`INFO  the role migration will suspend ${m.email} and end ${m.open_sessions} open session(s) of theirs`);
  if (toEnd.length === 0) console.log("INFO  the role migration will suspend nobody");
  return inv;
}

async function apply() {
  const phrase = `CORRECT TIMESTAMPS IN ${DB}`;
  if (opt("--confirm") !== phrase) stop(`apply needs --confirm "${phrase}"`);
  if (process.env.TZ_OPS_REHEARSAL_PAUSE_MS && DB === "hr_recruitment") stop("TZ_OPS_REHEARSAL_PAUSE_MS is set: not allowed on the real database. Open a new terminal.");
  if (!fs.existsSync(SQL_FILE)) stop(`${SQL_FILE} not found`);
  const sql = fs.readFileSync(SQL_FILE, "utf8");
  if (/^\s*(BEGIN|COMMIT|ROLLBACK)\s*;/im.test(sql)) stop("the correction SQL must not control the transaction itself");

  const ro = await connect(true);
  await preflight(ro);
  await ro.end();
  if (bad) stop(`${bad} preflight check(s) failed; nothing was changed`);

  // Rehearsals only: a pause between preflight and the locks, so a test can make "something connects in
  // between" happen on purpose and prove that the two guards below stop it. Never on the real database.
  const pause = Number(process.env.TZ_OPS_REHEARSAL_PAUSE_MS || 0);
  if (pause > 0) {
    if (DB === "hr_recruitment") stop("TZ_OPS_REHEARSAL_PAUSE_MS is set: not allowed on the real database. Open a new terminal.");
    console.log(`\n(rehearsal: pausing ${pause} ms between preflight and the locks)`);
    await sleep(pause);
  }

  const c = await connect(false);
  await c.query("BEGIN");
  try {
    // 1. Nobody else may read or write ANY table while the values are compared and corrected. Waiting at most
    //    a few seconds: a lock that is not free means something is still using the database.
    await c.query(`SET LOCAL lock_timeout = '${LOCK_WAIT}'`);
    const tables = await baseTables(c);
    try {
      await c.query(`LOCK TABLE ${tables.map((t) => `"${t}"`).join(", ")} IN ACCESS EXCLUSIVE MODE`);
    } catch (e) {
      await c.query("ROLLBACK").catch(() => undefined);
      await c.end();
      stop(`could not lock every table within ${LOCK_WAIT} (${e.message}): something is still using the database. Nothing was changed.`);
    }
    await c.query("SET LOCAL lock_timeout = 0");
    console.log(`\nLocked all ${tables.length} tables (nobody else can read or write them until this finishes).`);
    // 2. Now that every table is locked: still nothing else connected? (Closes the gap since preflight.)
    const others = await otherConnections(c);
    if (others.length > 0) {
      await c.query("ROLLBACK");
      await c.end();
      stop(`${others.length} other connection(s) appeared since preflight: ${describeConnections(others)}. Nothing was changed.`);
    }
    // 3. Only now the list of timestamp columns and the "before" values are read.
    const inv = await inventory(c);
    const before = await snapshot(c, inv);
    const auditBefore = (await c.query("SELECT count(*)::int AS n FROM audit_logs")).rows[0].n;
    const orgs = (await c.query("SELECT count(*)::int AS n FROM organizations")).rows[0].n;
    const docRead = (await c.query("SELECT id::text AS id FROM permissions WHERE key='document:read'")).rows[0].id;

    await c.query(sql);

    const after = await snapshot(c, inv);
    console.log("\nVerifying every value inside the transaction:");
    const tablesAfter = await baseTables(c);
    const expectedTables = [...new Set([...tables, ...CORRECTION_TABLES])].sort();
    line(JSON.stringify(tablesAfter) === JSON.stringify(expectedTables), `the set of tables is unchanged except the two correction tables (${tablesAfter.length})`);
    line(JSON.stringify(await inventory(c)) === JSON.stringify(inv), "the set of timestamp columns is unchanged");
    let shifted = 0, untouched = 0, empty = 0;
    for (const [k, b] of Object.entries(before)) {
      const parts = k.split("|"); // table | primary key (may have several parts) | column
      const [table, key, col] = [parts[0], parts.slice(1, -1).join("|"), parts[parts.length - 1]];
      const a = after[k];
      if (a === undefined) { line(false, `row disappeared: ${k}`); continue; }
      const keep = table === "audit_logs" || (table === "permissions" && key === docRead && col === "created_at");
      if (b === null) { if (a !== null) line(false, `empty value was filled: ${k}`); else empty++; continue; }
      if (keep) { if (a !== b) line(false, `must not change: ${k}`); else untouched++; continue; }
      if (BigInt(a) - BigInt(b) !== SHIFT_US) line(false, `not moved by exactly +5h30: ${k}`); else shifted++;
    }
    const newAudit = Object.keys(after).filter((k) => !(k in before));
    line(newAudit.every((k) => k.startsWith("audit_logs|")) && newAudit.length === orgs, `only new rows: ${orgs} audit record(s) documenting the correction (found ${newAudit.length})`);
    const notes = (await c.query("SELECT count(*)::int AS n FROM audit_log_time_corrections")).rows[0].n;
    line(notes === auditBefore, `a correction note for every pre-existing audit row (${notes} of ${auditBefore})`);
    const trg = (await c.query(`SELECT tgname, tgenabled FROM pg_trigger WHERE tgname IN ('application_status_history_no_update','application_assignments_no_update','audit_logs_append_only','audit_log_time_corrections_append_only','timestamp_corrections_append_only')`)).rows;
    line(trg.length === 5 && trg.every((t) => t.tgenabled === "O"), "all append-only triggers are enabled");
    const view = (await c.query(`SELECT reloptions FROM pg_class WHERE relname='audit_logs_display'`)).rows[0];
    line(Boolean(view && String(view.reloptions).includes("security_invoker=true")), "audit_logs_display respects the audit log's access rules (security_invoker)");
    line((await otherConnections(c)).length === 0, "still nothing else connected at the end");
    console.log(`INFO  moved +5h30: ${shifted}; left unchanged: ${untouched}; empty: ${empty}`);

    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "");
    const report = path.join(BACKUP_DIR, `tz-correction-report-${DB}-${stamp}.json`);
    fs.writeFileSync(report, JSON.stringify({ database: DB, ranAt: new Date().toISOString(), committed: bad === 0, shiftedValues: shifted, unchangedValues: untouched, emptyValues: empty, before, after }, null, 1));
    console.log(`INFO  report: ${report}`);

    if (bad) { await c.query("ROLLBACK"); stop(`${bad} check(s) failed: ROLLED BACK, nothing was changed`); }
    await c.query("COMMIT");
    console.log("\nCOMMITTED. Next: the post-check, then switch the app to UTC sessions (DB_SESSION_TIME_ZONE=UTC) before it writes anything, then apply the pending migrations.");
  } catch (e) {
    await c.query("ROLLBACK").catch(() => undefined);
    stop("error, ROLLED BACK, nothing was changed: " + e.message);
  } finally {
    await c.end().catch(() => undefined);
  }
}

async function post(c) {
  console.log(`Post-check for database "${DB}" (read-only)\n`);
  const runs = (await c.query("SELECT count(*)::int AS n FROM timestamp_corrections")).rows[0].n;
  line(runs === 1, `the correction is recorded exactly once (${runs})`);
  const trg = (await c.query(`SELECT tgname, tgenabled FROM pg_trigger WHERE tgname IN ('application_status_history_no_update','application_assignments_no_update','audit_logs_append_only','audit_log_time_corrections_append_only','timestamp_corrections_append_only')`)).rows;
  line(trg.length === 5 && trg.every((t) => t.tgenabled === "O"), "all append-only triggers are enabled");
  const view = (await c.query(`SELECT reloptions FROM pg_class WHERE relname='audit_logs_display'`)).rows[0];
  line(Boolean(view && String(view.reloptions).includes("security_invoker=true")), "audit_logs_display uses security_invoker");
  const corrected = (await c.query(`SELECT count(*)::int AS n FROM audit_logs a JOIN audit_log_time_corrections t ON t.audit_log_id = a.id`)).rows[0].n;
  const record = (await c.query(`SELECT count(*)::int AS n FROM audit_logs WHERE action='maintenance.timestamps_corrected'`)).rows[0].n;
  line(corrected > 0 && record > 0, `audit rows with a correction note: ${corrected}; correction record(s): ${record}`);

  const reportFile = opt("--report");
  if (!reportFile) {
    if (opt("--expected") || opt("--write-expected")) stop("--expected / --write-expected need --report");
    return;
  }
  const rep = JSON.parse(fs.readFileSync(reportFile, "utf8"));
  if (rep.database !== DB) stop("the report is for another database");
  if (rep.committed !== true) stop("that report is from a run that was rolled back");
  const inv = await inventory(c);
  const now = await snapshot(c, inv);
  const columnsNow = new Set(inv.flatMap((t) => t.columns.map((col) => `${t.table}|${col}`)));
  const appliedUs = BigInt((await c.query(`SELECT (EXTRACT(EPOCH FROM min(applied_at)) * 1000000)::bigint::text AS t FROM timestamp_corrections`)).rows[0].t);

  // Everything "apply" recorded, against the database as it is now. Nothing is skipped.
  const found = []; // { key, kind: "missing row" | "missing column" | "changed" }
  for (const [k, v] of Object.entries(rep.after)) {
    const parts = k.split("|"); // table | primary key (may have several parts) | column
    const [table, col] = [parts[0], parts[parts.length - 1]];
    if (!(k in now)) found.push({ key: k, kind: columnsNow.has(`${table}|${col}`) ? "missing row" : "missing column" });
    else if (now[k] !== v) found.push({ key: k, kind: "changed" });
  }
  console.log(`\nCompared ${Object.keys(rep.after).length} recorded values with the database: ${found.filter((f) => f.kind === "missing row").length} missing row value(s), ` +
    `${found.filter((f) => f.kind === "missing column").length} missing column value(s), ${found.filter((f) => f.kind === "changed").length} changed.`);

  const writeTo = opt("--write-expected");
  if (writeTo) {
    fs.writeFileSync(writeTo, JSON.stringify({ recordedFrom: DB, recordedAt: new Date().toISOString(), note: "Differences between the committed correction and the database after the migrations, recorded on a rehearsal copy.", differences: found }, null, 1));
    console.log(`INFO  wrote ${found.length} expected difference(s) to ${writeTo}`);
    for (const [kind, n] of Object.entries(found.reduce((m, f) => { const t = `${f.kind} in ${f.key.split("|")[0]}`; m[t] = (m[t] || 0) + 1; return m; }, {}))) console.log(`INFO    ${kind}: ${n}`);
    return;
  }

  const expectedFile = opt("--expected");
  const expected = new Map(expectedFile ? JSON.parse(fs.readFileSync(expectedFile, "utf8")).differences.map((d) => [d.key, d.kind]) : []);
  const show = (items, text) => { for (const f of items.slice(0, 15)) console.log(`        ${text}: ${f.key}`); if (items.length > 15) console.log(`        ... and ${items.length - 15} more`); };

  const unexpectedMissing = found.filter((f) => f.kind !== "changed" && expected.get(f.key) !== f.kind);
  line(unexpectedMissing.length === 0, `no recorded row or timestamp column is missing${expectedFile ? " beyond the expected ones" : ""} (${unexpectedMissing.length} unexpected)`);
  show(unexpectedMissing.filter((f) => f.kind === "missing row"), "MISSING ROW");
  show(unexpectedMissing.filter((f) => f.kind === "missing column"), "MISSING COLUMN");

  let unexpectedChanged = found.filter((f) => f.kind === "changed" && expected.get(f.key) !== "changed");
  if (flag("--allow-later-activity")) {
    // A value written after the correction was recorded (by the app, with correct UTC sessions) is accepted;
    // one that changed to anything earlier is not.
    const later = unexpectedChanged.filter((f) => now[f.key] !== null && BigInt(now[f.key]) > appliedUs);
    unexpectedChanged = unexpectedChanged.filter((f) => !later.includes(f));
    console.log(`INFO  ${later.length} value(s) were written after the correction (accepted: --allow-later-activity)`);
  }
  line(unexpectedChanged.length === 0, `no recorded value has changed${expectedFile ? " beyond the expected ones" : ""} (${unexpectedChanged.length} unexpected)`);
  show(unexpectedChanged, "CHANGED");

  if (expectedFile) {
    const foundKeys = new Map(found.map((f) => [f.key, f.kind]));
    const notSeen = [...expected].filter(([k, kind]) => foundKeys.get(k) !== kind).map(([key]) => ({ key }));
    line(notSeen.length === 0, `every expected difference is present, as on the rehearsal copy (${expected.size} expected, ${notSeen.length} not found)`);
    show(notSeen, "EXPECTED BUT NOT FOUND");
  }
  console.log(`INFO  rows added since the correction (not part of the comparison): ${new Set(Object.keys(now).filter((k) => !(k in rep.after)).map((k) => k.split("|").slice(0, 2).join("|"))).size}`);
}

(async () => {
  if (mode === "preflight") { const c = await connect(true); await preflight(c); await c.end(); }
  else if (mode === "apply") { await apply(); }
  else if (mode === "post") { const c = await connect(true); await post(c); await c.end(); }
  else stop("usage: preflight | apply | post   (see the top of this file)");
  console.log(bad === 0 ? "\nALL CHECKS PASSED" : `\n${bad} CHECK(S) FAILED`);
  process.exit(bad === 0 ? 0 : 1);
})().catch((e) => stop(e.message));

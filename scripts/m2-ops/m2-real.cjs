// Milestone 2 - real-database safety tool.
//   node m2-real.cjs backup          make a backup file of hr_recruitment (the real database is only READ)
//   node m2-real.cjs restore-check   restore that backup into a SEPARATE new database and compare it with the real one
//   node m2-real.cjs preflight       read-only checks that everything is ready for the migration
//   node m2-real.cjs post            read-only checks of the new objects and of hr_runtime's rights, after the migration
// Run it from the project folder. It never changes hr_recruitment.
// The only thing it ever creates is a new, separate database named hr_recruitment_restore_check (restore-check).
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const cp = require("child_process");
const req = (m) => require(require.resolve(m, { paths: [process.cwd()] }));
const { Client } = req("pg");

const mode = process.argv[2];
const REAL_DB = "hr_recruitment";
const CHECK_DB = "hr_recruitment_restore_check";
const OWNER = "hr_app";
const NEW_MIGRATION = "20261114140000_m2_sessions_and_login_attempts";
const NEW_MIGRATION_SHA256 = "48b78ee11a74480df87cb46cbab51c97d287d48511c0089034196320b61ab512";
const EXPECTED_APPLIED = ["20261113080938_init", "20261113081530_init"];
const BACKUP_DIR = process.env.HR_BACKUP_DIR || path.join(os.homedir(), "hr-recruitment-backups");
const MAX_MARKER_AGE_HOURS = 24;

const stop = (msg) => { console.error("\nSTOPPED: " + msg); process.exit(2); };
let bad = 0;
const line = (ok, text) => { if (!ok) bad++; console.log((ok ? "PASS  " : "FAIL  ") + text); };
const sha256File = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");

function loadReal() {
  if (process.env.MIGRATION_DATABASE_URL) {
    stop("this PowerShell window already has MIGRATION_DATABASE_URL set (it would override .env). Close it and open a NEW PowerShell window.");
  }
  req("dotenv").config({ path: ".env", quiet: true });
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) stop("MIGRATION_DATABASE_URL is missing from .env");
  const u = new URL(url);
  const db = u.pathname.replace(/^\//, "");
  if (db !== REAL_DB) stop(`.env points at database "${db}", expected "${REAL_DB}"`);
  const user = decodeURIComponent(u.username);
  if (user !== OWNER) stop(`.env connects as "${user}", expected "${OWNER}"`);
  return { url, u, host: u.hostname, port: u.port || "5432", user, pass: decodeURIComponent(u.password) };
}
const urlFor = (r, db) => { const x = new URL(r.url); x.pathname = "/" + db; return x.toString(); };
const roClient = (url) => new Client({ connectionString: url, options: "-c default_transaction_read_only=on -c TimeZone=UTC" });

function pgBin() {
  const win = process.platform === "win32";
  const names = win ? ["pg_dump.exe", "pg_restore.exe"] : ["pg_dump", "pg_restore"];
  const dirs = [];
  if (process.env.PG_BIN) dirs.push(process.env.PG_BIN);
  if (win) {
    const root = "C:\\Program Files\\PostgreSQL";
    try { fs.readdirSync(root).filter((d) => /^\d+$/.test(d)).sort((a, b) => b - a).forEach((d) => dirs.push(path.join(root, d, "bin"))); } catch (e) { /* ignore */ }
  }
  for (const d of dirs) {
    if (fs.existsSync(path.join(d, names[0])) && fs.existsSync(path.join(d, names[1]))) return { dump: path.join(d, names[0]), restore: path.join(d, names[1]) };
  }
  stop("could not find pg_dump / pg_restore (looked in C:\\Program Files\\PostgreSQL\\<version>\\bin).");
}
function runPg(r, exe, args) {
  const res = cp.spawnSync(exe, args, { env: { ...process.env, PGPASSWORD: r.pass }, encoding: "utf8", maxBuffer: 1 << 28 });
  if (res.error) stop(`could not run ${path.basename(exe)}: ${res.error.message}`);
  return res;
}
const majorOf = (exe) => {
  const o = cp.spawnSync(exe, ["--version"], { encoding: "utf8" });
  const m = /(\d+)(?:\.\d+)?/.exec(o.stdout || "");
  return m ? Number(m[1]) : 0;
};

async function q(c, sql, params) { return (await c.query(sql, params)).rows; }

// ---------- structure + data fingerprints (same method for the real database and the restored copy) ----------
const FP = {
  tables: "SELECT count(*)::int v FROM pg_tables WHERE schemaname='public'",
  indexes: "SELECT count(*)::int v FROM pg_indexes WHERE schemaname='public'",
  constraints: "SELECT count(*)::int v FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='public'",
  columns: "SELECT md5(coalesce(string_agg(table_name||'.'||column_name||':'||data_type||':'||is_nullable||':'||coalesce(column_default,'-'), '|' ORDER BY table_name, column_name),'')) v FROM information_schema.columns WHERE table_schema='public'",
  indexdefs: "SELECT md5(coalesce(string_agg(indexname||':'||indexdef, '|' ORDER BY indexname),'')) v FROM pg_indexes WHERE schemaname='public'",
  constraintdefs: "SELECT md5(coalesce(string_agg(c.conrelid::regclass::text||':'||c.conname||':'||pg_get_constraintdef(c.oid), '|' ORDER BY c.conrelid::regclass::text, c.conname),'')) v FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='public'",
  table_permissions: "SELECT md5(coalesce(string_agg(c.relname||':'||pg_get_userbyid(c.relowner)||':'||coalesce(c.relacl, CASE WHEN c.relkind='S' THEN acldefault('s', c.relowner) ELSE acldefault('r', c.relowner) END)::text, '|' ORDER BY c.relname),'')) v FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','S')",
  effective_privileges: "SELECT md5(coalesce(string_agg(c.relname||':'||r.rolname||':'||p.priv||':'||has_table_privilege(r.rolname, c.oid, p.priv)::text, '|' ORDER BY c.relname, r.rolname, p.priv),'')) v FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace CROSS JOIN (VALUES ('hr_app'),('hr_runtime')) r(rolname) CROSS JOIN (VALUES ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER')) p(priv) WHERE n.nspname='public' AND c.relkind='r'",
  column_permissions: "SELECT md5(coalesce(string_agg(c.relname||'.'||a.attname||':'||a.attacl::text, '|' ORDER BY c.relname, a.attname),'')) v FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND a.attacl IS NOT NULL AND NOT a.attisdropped",
  schema_permissions: "SELECT md5(coalesce(string_agg(nspname||':'||pg_get_userbyid(nspowner)||':'||coalesce(nspacl, acldefault('n', nspowner))::text, '|' ORDER BY nspname),'')) v FROM pg_namespace WHERE nspname='public'",
  default_permissions: "SELECT md5(coalesce(string_agg(defaclrole::regrole::text||':'||defaclnamespace::regnamespace::text||':'||defaclobjtype::text||':'||defaclacl::text, '|' ORDER BY 1),'')) v FROM pg_default_acl",
  recorded_migrations: "SELECT md5(coalesce(string_agg(id||':'||migration_name||':'||checksum||':'||coalesce(finished_at::text,'-')||':'||applied_steps_count::text, '|' ORDER BY migration_name),'')) v FROM public._prisma_migrations",
};
async function fingerprint(c) {
  const out = { fp: {}, rows: {}, content: {} };
  for (const [k, sql] of Object.entries(FP)) out.fp[k] = (await q(c, sql))[0].v;
  const tabs = (await q(c, "SELECT tablename t FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).map((r) => r.t);
  for (const t of tabs) {
    const id = '"' + t.replace(/"/g, '""') + '"';
    out.rows[t] = (await q(c, `SELECT count(*)::int v FROM public.${id}`))[0].v;
    out.content[t] = (await q(c, `SELECT md5(coalesce(string_agg(x::text, '|' ORDER BY x::text),'')) v FROM public.${id} x`))[0].v;
  }
  return out;
}

// ---------- backup ----------
async function backup() {
  const r = loadReal();
  const bin = pgBin();
  const c = roClient(r.url);
  await c.connect();
  let sv, tableCount, who;
  try {
    who = (await q(c, "SELECT current_database() d, current_user u"))[0];
    sv = Number((await q(c, "SHOW server_version_num"))[0].server_version_num);
    tableCount = (await q(c, "SELECT count(*)::int v FROM pg_tables WHERE schemaname='public'"))[0].v;
  } finally { await c.end(); }
  if (who.d !== REAL_DB) stop("connected to " + who.d);
  const serverMajor = Math.floor(sv / 10000);
  const dumpMajor = majorOf(bin.dump);
  console.log(`Server version ${serverMajor}, pg_dump version ${dumpMajor}`);
  if (dumpMajor < serverMajor) stop("pg_dump is older than the server. Backup would be unreliable.");
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "");
  const file = path.join(BACKUP_DIR, `${REAL_DB}-before-m2-${stamp}.dump`);
  if (fs.existsSync(file)) stop("backup file already exists: " + file);
  console.log("Backing up " + REAL_DB + " (read-only dump) ...");
  const res = runPg(r, bin.dump, ["--format=custom", "--no-password", "--host", r.host, "--port", r.port, "--username", r.user, "--dbname", REAL_DB, "--file", file]);
  if (res.status !== 0) stop("pg_dump failed: " + (res.stderr || "").trim().split("\n").slice(0, 5).join(" | "));
  const size = fs.statSync(file).size;
  if (size < 1000) stop("backup file is suspiciously small (" + size + " bytes)");
  const hash = sha256File(file);
  fs.writeFileSync(file + ".sha256", hash + "\n");
  const list = runPg(r, bin.restore, ["--list", file]);
  if (list.status !== 0) stop("pg_restore could not read the backup's table of contents: " + (list.stderr || "").trim().slice(0, 300));
  const toc = list.stdout.split("\n");
  const count = (re) => toc.filter((l) => re.test(l)).length;
  const tocTables = count(/^\d+; \d+ \d+ TABLE public /);
  const tocData = count(/^\d+; \d+ \d+ TABLE DATA public /);
  line(tocTables === tableCount, `backup contains ${tocTables} tables (database has ${tableCount})`);
  line(tocData > 0, `backup contains data for ${tocData} tables`);
  line(count(/ ACL /) > 0, `backup contains permission (ACL) entries: ${count(/ ACL /)}`);
  line(count(/ INDEX /) > 0, `backup contains ${count(/ INDEX /)} indexes`);
  console.log(`\nBackup file : ${file}`);
  console.log(`Size        : ${size} bytes`);
  console.log(`SHA-256     : ${hash}`);
  console.log(bad === 0 ? "\nBackup written and its table of contents is readable. NEXT: run restore-check to prove it can be restored." : "\nBackup check FAILED.");
  process.exitCode = bad === 0 ? 0 : 1;
}

function latestDump(soft) {
  if (!fs.existsSync(BACKUP_DIR)) { if (soft) return null; stop("backup folder not found: " + BACKUP_DIR); }
  const files = fs.readdirSync(BACKUP_DIR).filter((f) => f.endsWith(".dump")).map((f) => ({ f, t: fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs })).sort((a, b) => b.t - a.t);
  if (!files.length) { if (soft) return null; stop("no .dump backup found in " + BACKUP_DIR); }
  return path.join(BACKUP_DIR, files[0].f);
}
const markerOf = (dump) => dump + ".restore-verified.json";

// ---------- restore-check ----------
async function restoreCheck() {
  const r = loadReal();
  const bin = pgBin();
  const dump = process.argv[3] || latestDump();
  if (!fs.existsSync(dump)) stop("backup file not found: " + dump);
  if (CHECK_DB === REAL_DB) stop("internal error: check database equals real database");
  const hash = sha256File(dump);
  const saved = fs.existsSync(dump + ".sha256") ? fs.readFileSync(dump + ".sha256", "utf8").trim() : "";
  line(saved === hash, "backup file is unchanged since it was written (SHA-256 matches)");
  if (saved !== hash) stop("backup file changed or its checksum file is missing");
  console.log("Backup under test: " + dump);

  const admin = new Client({ connectionString: urlFor(r, "postgres") });
  await admin.connect();
  try {
    const ex = await q(admin, "SELECT 1 FROM pg_database WHERE datname=$1", [CHECK_DB]);
    if (ex.length) stop(`a database named ${CHECK_DB} already exists (from an earlier check). Nothing was deleted or changed. Tell me and we decide together what to do.`);
    console.log(`Creating a NEW, separate, empty database: ${CHECK_DB}`);
    await admin.query(`CREATE DATABASE "${CHECK_DB}" OWNER "${OWNER}"`);
  } finally { await admin.end(); }

  console.log(`Restoring the backup into ${CHECK_DB} (never into ${REAL_DB}) ...`);
  const res = runPg(r, bin.restore, ["--no-password", "--host", r.host, "--port", r.port, "--username", r.user, "--dbname", CHECK_DB, dump]);
  const errLines = (res.stderr || "").split("\n").filter((l) => /error/i.test(l));
  line(res.status === 0 && errLines.length === 0, `restore finished with ${errLines.length} error message(s)` + (errLines.length ? ": " + errLines.slice(0, 5).join(" | ") : ""));

  const real = roClient(r.url), copy = roClient(urlFor(r, CHECK_DB));
  await real.connect(); await copy.connect();
  let a, b;
  try {
    const dbs = [(await q(real, "SELECT current_database() d"))[0].d, (await q(copy, "SELECT current_database() d"))[0].d];
    line(dbs[0] === REAL_DB && dbs[1] === CHECK_DB, `compared ${dbs[0]} (real) with ${dbs[1]} (restored copy)`);
    a = await fingerprint(real); b = await fingerprint(copy);
  } finally { await real.end(); await copy.end(); }
  for (const k of Object.keys(a.fp)) line(a.fp[k] === b.fp[k], `${k.replace(/_/g, " ")} identical` + (typeof a.fp[k] === "number" ? ` (${a.fp[k]})` : ""));
  const names = Object.keys(a.rows);
  const sameTables = JSON.stringify(names) === JSON.stringify(Object.keys(b.rows));
  line(sameTables, `same list of ${names.length} tables`);
  let rowTotal = 0, rowBad = 0, contentBad = 0;
  for (const t of names) {
    rowTotal += a.rows[t];
    if (a.rows[t] !== b.rows[t]) { rowBad++; console.log(`      rows differ in ${t}: real ${a.rows[t]} vs copy ${b.rows[t]}`); }
    if (a.content[t] !== b.content[t]) { contentBad++; console.log(`      contents differ in ${t}`); }
  }
  line(rowBad === 0, `row counts identical in every table (${rowTotal} rows in total)`);
  line(contentBad === 0, `row contents identical in every table (checksum of all rows)`);
  if (bad === 0) {
    fs.writeFileSync(markerOf(dump), JSON.stringify({ dump: path.basename(dump), sha256: hash, verifiedAt: new Date().toISOString(), tables: names.length, rows: rowTotal }, null, 1));
    console.log(`\nBackup PROVEN restorable. Marker written: ${markerOf(dump)}`);
    console.log(`The separate database ${CHECK_DB} was left in place (nothing deleted).`);
  } else console.log("\nRestore check FAILED. No marker written. Do NOT continue to the migration.");
  process.exitCode = bad === 0 ? 0 : 1;
}

// ---------- preflight ----------
async function preflight() {
  const r = loadReal();
  const c = roClient(r.url);
  await c.connect();
  try {
    const who = (await q(c, "SELECT current_database() d, current_user u, current_setting('server_version_num')::int sv, current_setting('default_transaction_read_only') ro"))[0];
    line(who.d === REAL_DB && who.u === OWNER, `connected to ${who.d} as ${who.u} (read-only session: ${who.ro})`);
    line(Math.floor(who.sv / 10000) >= 14, `server major version ${Math.floor(who.sv / 10000)}`);

    // 1. migration history: database vs local folders
    const dbm = await q(c, "SELECT migration_name n, checksum cs, finished_at IS NOT NULL fin, rolled_back_at IS NOT NULL rb FROM public._prisma_migrations ORDER BY migration_name");
    line(JSON.stringify(dbm.map((m) => m.n)) === JSON.stringify(EXPECTED_APPLIED), `database has exactly the 2 expected applied migrations: ${dbm.map((m) => m.n).join(", ") || "(none)"}`);
    line(dbm.every((m) => m.fin && !m.rb), "every recorded migration finished and none is rolled back / failed");
    const migDir = path.join(process.cwd(), "prisma", "migrations");
    const local = fs.readdirSync(migDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
    line(JSON.stringify(local) === JSON.stringify([...EXPECTED_APPLIED, NEW_MIGRATION].sort()), `local migration folders = the 2 applied + only the new one: ${local.join(", ")}`);
    for (const m of dbm) {
      const f = path.join(migDir, m.n, "migration.sql");
      line(fs.existsSync(f) && sha256File(f) === m.cs, `applied migration ${m.n}: file on disk matches the recorded checksum`);
    }
    const nf = path.join(migDir, NEW_MIGRATION, "migration.sql");
    line(fs.existsSync(nf) && sha256File(nf) === NEW_MIGRATION_SHA256, "new migration file is byte-for-byte the reviewed file (SHA-256 " + NEW_MIGRATION_SHA256.slice(0, 16) + "...)");

    // 2. the database must be exactly as before the change
    const s = (await q(c, "SELECT count(*)::int v FROM public.sessions"))[0].v;
    line(s === 0, `sessions table is empty (${s} rows)`);
    const cols = (await q(c, "SELECT count(*)::int v FROM information_schema.columns WHERE table_schema='public' AND table_name='sessions' AND column_name IN ('absolute_expires_at','last_seen_at','revoked_at','revoked_reason')"))[0].v;
    line(cols === 0, `none of the 4 new session columns exist yet (${cols})`);
    line((await q(c, "SELECT to_regclass('public.auth_login_attempts') IS NULL v"))[0].v, "auth_login_attempts does not exist yet");
    line((await q(c, "SELECT count(*)::int v FROM pg_constraint WHERE conname='sessions_idle_not_after_absolute'"))[0].v === 0, "check rule sessions_idle_not_after_absolute does not exist yet");
    line((await q(c, "SELECT count(*)::int v FROM pg_indexes WHERE schemaname='public' AND indexname='sessions_user_id_revoked_at_idx'"))[0].v === 0, "index sessions_user_id_revoked_at_idx does not exist yet");

    // 3. rights: the migration account must own sessions and be able to create in public
    line((await q(c, "SELECT tableowner o FROM pg_tables WHERE schemaname='public' AND tablename='sessions'"))[0].o === OWNER, "hr_app owns the sessions table");
    line((await q(c, "SELECT has_schema_privilege(current_user,'public','CREATE') v"))[0].v, "hr_app can create objects in schema public");

    // 4. nothing else holding locks or half-finished work
    line((await q(c, "SELECT count(*)::int v FROM pg_prepared_xacts"))[0].v === 0, "no prepared (unfinished two-phase) transactions");
    const busy = (await q(c, "SELECT count(DISTINCT l.pid)::int v FROM pg_locks l WHERE l.database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND l.relation>=16384 AND l.pid<>pg_backend_pid()"))[0].v;
    line(busy === 0, `no other connection has an open transaction touching ${REAL_DB} tables (${busy})`);
    const others = (await q(c, "SELECT count(*)::int v FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()"))[0].v;
    console.log(`INFO  other connections to ${REAL_DB} visible to this account: ${others}  (idle ones do not block the migration)`);
    const locks = (await q(c, "SELECT count(*)::int v FROM pg_locks l JOIN pg_class c ON c.oid=l.relation WHERE c.relname='sessions' AND c.relnamespace='public'::regnamespace AND l.pid<>pg_backend_pid()"))[0].v;
    line(locks === 0, `nobody holds any lock on sessions right now (${locks})`);
  } finally { await c.end(); }

  // 5. a restore-verified backup must exist and be unchanged
  const dump = latestDump(true);
  const mk = dump ? markerOf(dump) : "";
  const ok = !!dump && fs.existsSync(mk);
  line(ok, dump ? "latest backup has a restore-verified marker: " + path.basename(dump) : "a backup file exists in " + BACKUP_DIR);
  if (ok) {
    const m = JSON.parse(fs.readFileSync(mk, "utf8"));
    line(m.sha256 === sha256File(dump), "backup file is unchanged since it was verified");
    const age = (Date.now() - new Date(m.verifiedAt).getTime()) / 3600000;
    line(age >= 0 && age <= MAX_MARKER_AGE_HOURS, `verification is recent (${age.toFixed(1)} hours old, limit ${MAX_MARKER_AGE_HOURS})`);
  }
  console.log(bad === 0 ? "\nPREFLIGHT PASSED. Nothing was changed. Waiting for your explicit approval to apply." : `\nPREFLIGHT FAILED (${bad}). Do NOT apply the migration.`);
  process.exitCode = bad === 0 ? 0 : 1;
}

// ---------- post (after the migration; read-only) ----------
async function post() {
  const r = loadReal();
  const c = roClient(r.url);
  await c.connect();
  try {
    const has = async (rel, priv) => (await q(c, "SELECT has_table_privilege('hr_runtime', $1, $2) v", [rel, priv]))[0].v;
    const got = async (rel, privs) => { const o = []; for (const p of privs) if (await has(rel, p)) o.push(p); return o.join(","); };
    line((await q(c, "SELECT to_regclass('public.auth_login_attempts') IS NOT NULL v"))[0].v, "auth_login_attempts exists");
    line((await got("public.auth_login_attempts", ["SELECT", "INSERT", "UPDATE", "DELETE"])) === "SELECT,INSERT,UPDATE,DELETE", "hr_runtime can read, add, change and remove rows in auth_login_attempts");
    line((await got("public.auth_login_attempts", ["TRUNCATE", "TRIGGER", "REFERENCES"])) === "", "hr_runtime cannot truncate, add triggers to, or reference auth_login_attempts");
    line((await q(c, "SELECT pg_get_userbyid(relowner) o FROM pg_class WHERE oid='public.auth_login_attempts'::regclass"))[0].o === OWNER, "auth_login_attempts is owned by hr_app (not by hr_runtime)");
    line((await q(c, "SELECT NOT (has_schema_privilege('hr_runtime','public','CREATE')) v"))[0].v, "hr_runtime still cannot create objects in schema public");
    line((await got("public.sessions", ["SELECT", "INSERT", "UPDATE", "DELETE"])) === "SELECT,INSERT,UPDATE,DELETE", "hr_runtime still has read/add/change/remove on sessions");
    line((await got("public.sessions", ["TRUNCATE", "TRIGGER", "REFERENCES"])) === "", "hr_runtime still has no truncate/trigger/references on sessions");
    line((await q(c, "SELECT count(*)::int v FROM pg_constraint WHERE conname='sessions_idle_not_after_absolute' AND convalidated"))[0].v === 1, "check rule sessions_idle_not_after_absolute exists and is validated");
    const cols = await q(c, "SELECT column_name n, is_nullable nl FROM information_schema.columns WHERE table_schema='public' AND table_name='sessions' AND column_name IN ('absolute_expires_at','last_seen_at','revoked_at','revoked_reason') ORDER BY 1");
    line(cols.length === 4 && cols.find((x) => x.n === "absolute_expires_at").nl === "NO" && cols.find((x) => x.n === "last_seen_at").nl === "NO", "sessions has the 4 new columns; absolute_expires_at and last_seen_at are required");
    const m = await q(c, "SELECT migration_name n, finished_at IS NOT NULL f, rolled_back_at IS NOT NULL rb FROM public._prisma_migrations WHERE migration_name=$1", [NEW_MIGRATION]);
    line(m.length === 1 && m[0].f && !m[0].rb, "the new migration is recorded as finished");
    line((await q(c, "SELECT count(*)::int v FROM public.sessions"))[0].v === 0, "sessions is still empty");
  } finally { await c.end(); }
  console.log(bad === 0 ? "\nPOST-CHECK PASSED." : `\nPOST-CHECK FAILED (${bad}).`);
  process.exitCode = bad === 0 ? 0 : 1;
}

(async () => {
  if (mode === "backup") await backup();
  else if (mode === "restore-check") await restoreCheck();
  else if (mode === "preflight") await preflight();
  else if (mode === "post") await post();
  else stop("Usage: node m2-real.cjs backup | restore-check | preflight | post");
})().catch((e) => { console.error("\nSTOPPED:", e.message); process.exit(2); });

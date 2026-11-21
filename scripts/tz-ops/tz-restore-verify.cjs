// Complete restore verification of a database backup (see prisma/proposals/README-timestamp-correction.md).
//
//   node scripts/tz-ops/tz-restore-verify.cjs [--dump <file>] [--against <database>] [--storage <backup folder>] [--drop]
//
// Proves that a backup can really be restored and that the restored copy is the SAME as the database it was
// taken from:
//   1. the dump's SHA-256 matches the .sha256 written next to it;
//   2. it is restored into a NEW database (hr_recruitment_restore_verify_<timestamp>; never an existing one);
//   3. the copy is compared with the source database, which is only READ:
//        every table present, the same number of rows, and the same CONTENT (a checksum of every row);
//        the same migration history, triggers, functions, row-level-security policies, sequences and the
//        app account's rights;
//   4. the newest file backup (storage/private) still matches its manifest and the current files.
//
// --dump     defaults to the newest hr_recruitment-before-tz-correction-*.dump in the backup folder.
// --against  defaults to hr_recruitment (the real database, read-only). The source must not have changed
//            since the backup was taken (the app is stopped at that point of the runbook).
// --drop     removes the verified copy at the end. Without it the copy is KEPT (it holds real data: remove it
//            when it is no longer needed).
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const cp = require("child_process");
const req = (m) => require(require.resolve(m, { paths: [process.cwd()] }));
const { Client } = req("pg");

// The app's file store, resolved like the app (FILE_STORAGE_DIR, otherwise storage/private).
const STORE = path.resolve(process.env.FILE_STORAGE_DIR?.trim() || path.join(process.cwd(), "storage", "private"));
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const stop = (m) => { console.error("\nSTOPPED: " + m); process.exit(2); };
let bad = 0;
const line = (ok, text) => { if (!ok) bad++; console.log((ok ? "PASS  " : "FAIL  ") + text); };
const sha = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");

if (process.env.MIGRATION_DATABASE_URL) stop("MIGRATION_DATABASE_URL is set in this shell and would override .env. Open a new terminal.");
req("dotenv").config({ path: ".env", quiet: true });
const base = process.env.MIGRATION_DATABASE_URL;
if (!base) stop("MIGRATION_DATABASE_URL is missing from .env");
const u = new URL(base);
if (decodeURIComponent(u.username) !== "hr_app") stop("expected the owner account hr_app");
const urlFor = (db) => { const x = new URL(base); x.pathname = "/" + db; return x.toString(); };
const BACKUP_DIR = process.env.HR_BACKUP_DIR || path.join(os.homedir(), "hr-recruitment-backups");
const SOURCE = opt("--against") || "hr_recruitment";
if (!/^hr_recruitment[a-z0-9_]*$/.test(SOURCE)) stop("unexpected source database name");
const newest = (re) => fs.readdirSync(BACKUP_DIR).filter((f) => re.test(f)).map((f) => path.join(BACKUP_DIR, f)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
const DUMP = opt("--dump") || newest(/^hr_recruitment-before-tz-correction-.*\.dump$/);
if (!DUMP || !fs.existsSync(DUMP)) stop("no backup file found");
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").toLowerCase();
const COPY = `hr_recruitment_restore_verify_${stamp}`;
const root = "C:\\Program Files\\PostgreSQL";
const bin = path.join(root, fs.readdirSync(root).filter((d) => /^\d+$/.test(d)).sort((a, b) => b - a)[0], "bin");

// Everything comparable about a database. Read-only; UTC so that timestamps are written the same way.
async function describe(db) {
  const c = new Client({ connectionString: urlFor(db), application_name: "tz-restore-verify", options: "-c TimeZone=UTC -c default_transaction_read_only=on" });
  await c.connect();
  const q = async (sql, p) => (await c.query(sql, p)).rows;
  await c.query("BEGIN ISOLATION LEVEL REPEATABLE READ"); // one consistent picture of the source
  const tables = (await q(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`)).map((r) => r.tablename);
  const content = {};
  for (const t of tables) {
    // Every row as text, in a fixed order, hashed: any difference in any column of any row changes the result.
    const r = (await q(`SELECT count(*)::int AS n, COALESCE(md5(string_agg(md5(x::text), '' ORDER BY md5(x::text))), 'empty') AS sum FROM "${t}" x`))[0];
    content[t] = `${r.n} rows / ${r.sum}`;
  }
  const out = {
    tables: content,
    migrations: await q(`SELECT migration_name, checksum, finished_at IS NOT NULL AS finished, rolled_back_at IS NOT NULL AS rolled_back FROM _prisma_migrations ORDER BY 1`),
    triggers: await q(`SELECT c.relname, t.tgname, t.tgenabled, md5(pg_get_triggerdef(t.oid)) AS def FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE NOT t.tgisinternal AND c.relnamespace = 'public'::regnamespace ORDER BY 1, 2`),
    functions: await q(`SELECT p.oid::regprocedure::text AS f, md5(pg_get_functiondef(p.oid)) AS def, p.proacl::text AS acl FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                        WHERE n.nspname = 'public' AND p.prokind IN ('f', 'p') AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e') ORDER BY 1`),
    policies: await q(`SELECT tablename, policyname, cmd, roles::text, qual, with_check FROM pg_policies WHERE schemaname = 'public' ORDER BY 1, 2`),
    rowSecurity: await q(`SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' ORDER BY 1`),
    constraints: await q(`SELECT conrelid::regclass::text AS t, conname, md5(pg_get_constraintdef(oid)) AS def FROM pg_constraint WHERE connamespace = 'public'::regnamespace ORDER BY 1, 2`),
    indexes: await q(`SELECT tablename, indexname, md5(indexdef) AS def FROM pg_indexes WHERE schemaname = 'public' ORDER BY 1, 2`),
    views: await q(`SELECT viewname, md5(definition) AS def FROM pg_views WHERE schemaname = 'public' ORDER BY 1`),
    sequences: await q(`SELECT sequencename, last_value FROM pg_sequences WHERE schemaname = 'public' ORDER BY 1`),
    appAccountRights: await q(`SELECT table_name, string_agg(privilege_type, ',' ORDER BY privilege_type) AS p FROM information_schema.role_table_grants WHERE grantee = 'hr_runtime' AND table_schema = 'public' GROUP BY 1 ORDER BY 1`),
    extensions: await q(`SELECT extname FROM pg_extension ORDER BY 1`),
  };
  await c.query("COMMIT");
  await c.end();
  return out;
}

function checkStorage() {
  const folder = opt("--storage") || newest(/^storage-private-\d{8}t?\d*/i);
  if (!folder || !fs.existsSync(path.join(folder, "manifest.json"))) { line(false, "no file backup (storage-private-*) with a manifest was found"); return; }
  const manifestFile = path.join(folder, "manifest.json");
  line(fs.readFileSync(manifestFile + ".sha256", "utf8").split(/\s+/)[0] === sha(manifestFile), `file backup manifest is intact (${path.basename(folder)})`);
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  let copyBad = 0, originalBad = 0;
  for (const m of manifest.files) {
    const copy = path.join(folder, "private", m.path);
    const original = path.join(STORE, m.path);
    if (!fs.existsSync(copy) || fs.statSync(copy).size !== m.bytes || sha(copy) !== m.sha256) copyBad++;
    if (!fs.existsSync(original) || sha(original) !== m.sha256) originalBad++;
  }
  line(copyBad === 0, `every backed-up file matches its recorded checksum (${manifest.files.length} files, ${copyBad} wrong)`);
  line(originalBad === 0, `every original file is still present and unchanged (${originalBad} missing or changed)`);
  const walk = (dir, b = dir) => fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(dir, e.name), b) : [path.relative(b, path.join(dir, e.name)).split(path.sep).join("/")]) : [];
  const known = new Set(manifest.files.map((m) => m.path));
  const extra = walk(STORE).filter((p) => !known.has(p));
  if (extra.length) console.log(`INFO  ${extra.length} file(s) in storage/private are newer than the file backup (not covered by it): take a new file backup before a production run`);
}

(async () => {
  console.log(`Restore verification\n  backup:  ${DUMP}\n  source:  ${SOURCE} (read-only)\n  copy:    ${COPY} (new)\n`);
  if (!fs.existsSync(DUMP + ".sha256")) stop("no .sha256 next to the backup");
  line(fs.readFileSync(DUMP + ".sha256", "utf8").split(/\s+/)[0] === sha(DUMP), "the backup file matches its recorded SHA-256");
  if (bad) stop("the backup file is damaged or was changed; not restoring it");

  const admin = new Client({ connectionString: urlFor("postgres"), application_name: "tz-restore-verify" });
  await admin.connect();
  if ((await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [COPY])).rowCount) { await admin.end(); stop(`${COPY} already exists`); }
  await admin.query(`CREATE DATABASE "${COPY}" OWNER "hr_app"`);
  const r = cp.spawnSync(path.join(bin, "pg_restore.exe"), ["--no-password", "--host", u.hostname, "--port", u.port || "5432", "--username", "hr_app", "--dbname", COPY, "--exit-on-error", DUMP],
    { env: { ...process.env, PGPASSWORD: decodeURIComponent(u.password) }, encoding: "utf8" });
  line(r.status === 0, "the backup restores completely, without a single error");
  if (r.status !== 0) { console.log((r.stderr || "").slice(0, 600)); }

  if (r.status === 0) {
    const [source, copy] = [await describe(SOURCE), await describe(COPY)];
    const tablesS = Object.keys(source.tables), tablesC = Object.keys(copy.tables);
    line(JSON.stringify(tablesS) === JSON.stringify(tablesC), `the same tables exist (${tablesC.length})`);
    const differing = tablesS.filter((t) => source.tables[t] !== copy.tables[t]);
    const rows = (o) => Object.values(o).reduce((n, v) => n + Number(v.split(" ")[0]), 0);
    line(differing.length === 0, `every row of every table is identical (${rows(copy.tables)} rows in ${tablesC.length} tables; ${differing.length} table(s) differ)`);
    for (const t of differing) console.log(`        ${t}: source ${source.tables[t]} | copy ${copy.tables[t] ?? "missing"}`);
    for (const key of ["migrations", "triggers", "functions", "policies", "rowSecurity", "constraints", "indexes", "views", "sequences", "appAccountRights", "extensions"]) {
      const same = JSON.stringify(source[key]) === JSON.stringify(copy[key]);
      line(same, `${key}: identical (${copy[key].length})`);
      if (!same) {
        const A = new Set(source[key].map((x) => JSON.stringify(x))), B = new Set(copy[key].map((x) => JSON.stringify(x)));
        for (const x of A) if (!B.has(x)) console.log("        only in the source: " + x.slice(0, 200));
        for (const x of B) if (!A.has(x)) console.log("        only in the copy:   " + x.slice(0, 200));
      }
    }
  }
  console.log("");
  checkStorage();

  if (args.includes("--drop")) {
    await admin.query(`DROP DATABASE "${COPY}"`);
    console.log(`\nINFO  the verified copy ${COPY} was removed (--drop)`);
  } else {
    console.log(`\nINFO  the verified copy is KEPT as ${COPY}. It holds real data: remove it when it is no longer needed.`);
  }
  await admin.end();
  console.log(bad === 0 ? "\nRESTORE VERIFIED: the backup restores to an exact copy" : `\n${bad} CHECK(S) FAILED: do not rely on this backup`);
  process.exit(bad === 0 ? 0 : 1);
})().catch((e) => stop(e.message));

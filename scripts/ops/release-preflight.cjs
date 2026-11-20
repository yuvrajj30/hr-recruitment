// READ-ONLY pre-flight of the REAL database (hr_recruitment) before the release that brings interviews, candidate
// profiles per organisation, document links per organisation, shared application limits and automatic retention.
//   node scripts/ops/release-preflight.cjs
// Everything runs inside BEGIN READ ONLY ... ROLLBACK as the owner account from .env: nothing can be changed.
// It reports:
//   - the migration history: every applied migration still matches its file byte for byte (Prisma checksum),
//     none failed, and exactly the expected migrations are pending;
//   - what the candidate split would do (shared profiles, profiles to rebuild) and anything that would make it stop;
//   - how many candidates the retention job would remove on its FIRST run, per organisation;
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
  "20261118000000_interviews_feedback",
  "20261118010000_interviews_review_fixes",
  "20261118020000_candidate_profiles_per_organization",
  "20261118020100_candidate_document_keeps_organization",
  "20261118020200_candidate_document_links_same_organization",
  "20261120000000_shared_limits_and_retention",
  "20261120010000_retention_review_fixes",
  "20261120020000_retention_review_fixes_2",
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

    // ---- candidate split (20261118020000) ----
    const orgs = await q(`SELECT slug, candidate_retention_months FROM organizations ORDER BY slug`);
    info(`organisations: ${orgs.map((o) => `${o.slug} (keeps candidates ${o.candidate_retention_months} months)`).join(", ")}`);
    const [s] = await q(`WITH r AS (
        SELECT oc.id, oc.removed_at,
          (SELECT count(*) FROM organization_candidates o WHERE o.candidate_id = oc.candidate_id) AS links,
          cp.created_at < oc.created_at - INTERVAL '2 seconds' AS profile_older,
          EXISTS (SELECT 1 FROM applications a WHERE a.organization_candidate_id = oc.id AND a.profile_snapshot IS NOT NULL) AS has_snapshot
        FROM organization_candidates oc JOIN candidate_profiles cp ON cp.id = oc.candidate_id)
      SELECT count(*)::int AS records,
             count(*) FILTER (WHERE links > 1)::int AS on_shared,
             count(*) FILTER (WHERE links = 1 AND profile_older)::int AS older_profile,
             count(*) FILTER (WHERE (links > 1 OR profile_older) AND removed_at IS NULL AND NOT has_snapshot)::int AS would_stop
      FROM r`);
    info(`candidate records: ${s.records}; on shared profiles: ${s.on_shared}; lone records with an older profile (rebuilt): ${s.older_profile}`);
    line(s.would_stop === 0, `no record needs a rebuilt profile without submitted details (${s.would_stop})`);
    const [x] = await q(`SELECT
        (SELECT count(*) FROM candidate_profiles cp WHERE NOT EXISTS (SELECT 1 FROM organization_candidates oc WHERE oc.candidate_id = cp.id))::int AS profiles_without_org,
        (SELECT count(*) FROM candidate_documents WHERE organization_id IS NULL)::int AS documents_without_org,
        (SELECT count(*) FROM candidate_profiles WHERE email <> lower(btrim(email)) OR email = '')::int AS non_normalised_emails,
        (SELECT count(*) FROM candidate_accounts)::int AS candidate_accounts,
        (SELECT count(*) FROM candidate_login_tokens)::int AS login_tokens,
        (SELECT count(*) FROM audit_logs WHERE action = 'candidate.removed' AND metadata->>'profile' = 'detached')::int AS detached_removals`);
    line(x.profiles_without_org === 0, `every candidate profile belongs to an organisation (${x.profiles_without_org} without)`);
    line(x.documents_without_org === 0, `every candidate document has an organisation (${x.documents_without_org} without)`);
    line(x.non_normalised_emails === 0, `every candidate email is normalised (${x.non_normalised_emails} not)`);
    info(`candidate accounts: ${x.candidate_accounts}; sign-in links: ${x.login_tokens}; earlier "detached" removals: ${x.detached_removals}`);

    // ---- first run of the retention job ----
    const due = await q(`SELECT o.slug, count(*)::int AS n FROM (
        SELECT oc.id, oc.organization_id FROM organization_candidates oc
        JOIN organizations o2 ON o2.id = oc.organization_id
        JOIN applications a ON a.organization_candidate_id = oc.id AND a.organization_id = oc.organization_id
        WHERE oc.removed_at IS NULL
        GROUP BY oc.id, oc.organization_id, o2.candidate_retention_months
        HAVING bool_and(a.stage IN ('REJECTED','WITHDRAWN','OFFER_DECLINED'))
           AND max(a.stage_changed_at) < ((now() AT TIME ZONE 'UTC') - make_interval(months => o2.candidate_retention_months)) AT TIME ZONE 'UTC') d
      JOIN organizations o ON o.id = d.organization_id GROUP BY o.slug ORDER BY o.slug`);
    info(`the retention job's first run would remove: ${due.length ? due.map((d) => `${d.n} in ${d.slug}`).join(", ") : "nobody (no candidate is past the retention period)"}`);

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

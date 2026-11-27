// Shared public-application limits and the automatic candidate retention job (migration
// 20261120000000_shared_limits_and_retention), against the DISPOSABLE test database only. Everything is checked
// as the app's restricted account (hr_runtime) and the job's own account (hr_maintenance), the way the app and the
// scheduled job really call it.
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db } from "@/lib/db";
import { effectiveRetentionMonths, retentionCutoff } from "@/lib/recruitment/privacy-rules";
import { runCandidateRetention } from "@/lib/recruitment/retention";
import { createLocalStorage, type FileStorage } from "@/lib/recruitment/storage";
import { pgSessionToken, purgeTestAuditRows } from "./session-helper";
import { realRoleIds } from "./roles-helper";

const ownerUrl = process.env.TEST_OWNER_URL;
const runtimeUrl = process.env.TEST_RUNTIME_URL;
const maintenanceUrl = process.env.TEST_MAINTENANCE_URL;
const isTestDb = (u?: string) => Boolean(u && /_test\b/.test(new URL(u).pathname));
const enabled = isTestDb(ownerUrl) && isTestDb(runtimeUrl) && isTestDb(maintenanceUrl);
const rnd = () => randomBytes(4).toString("hex");
const hash = () => randomBytes(32).toString("hex"); // stands in for a keyed hash
const DOMAIN = "retention.example.test";

describe.skipIf(!enabled)("shared limits and automatic retention (test database)", () => {
  let owner: Db;
  let db: Db;
  let mdb: Db; // the scheduled job's account
  let raw: Client;
  const orgIds: string[] = [];
  const userIds: string[] = [];
  const usedHashes: string[] = [];
type K = "a" | "b" | "c" | "d";
  // a: 1 month, b: 12 months (shared by several tests); c: 1 month, only for the batch test; d: 12 months, only for
  // the retention-shortening tests.
  const org: Record<K, { id: string; job: string; job2: string; hr: string }> = {} as never;

  // Runtime connections: ONE shared one for the sequential checks (the app account has a connection limit, and
  // other test files run at the same time); extra ones only for the parallel check, closed right after.
  let shared: Client;
  let mshared: Client; // the same for the scheduled job's account
  async function rtClient() {
    const c = new Client({ connectionString: runtimeUrl, options: "-c TimeZone=UTC" });
    await c.connect();
    return c;
  }
  async function mtClient() {
    const c = new Client({ connectionString: maintenanceUrl, options: "-c TimeZone=UTC" });
    await c.connect();
    return c;
  }
  async function inMode(c: Client, mode: "public_apply" | "maintenance" | "staff", sql: string, params: unknown[] = [], k: K = "a") {
    await c.query("BEGIN");
    try {
      if (mode === "staff") {
        const token = await pgSessionToken(raw, org[k].hr, org[k].id);
        await c.query(`SELECT set_config('app.mode', 'staff', true), set_config('app.session_token', $1, true)`, [token]);
      } else {
        await c.query(`SELECT set_config('app.mode', $1, true), set_config('app.org_id', $2, true)`, [mode, mode === "public_apply" ? org[k].id : ""]);
      }
      const r = await c.query(sql, params);
      await c.query("COMMIT");
      return { rows: r.rows as Record<string, unknown>[], error: undefined as string | undefined };
    } catch (e) {
      await c.query("ROLLBACK");
      return { rows: [] as Record<string, unknown>[], error: (e as Error).message };
    }
  }

  beforeAll(async () => {
    owner = createDb(ownerUrl!, { max: 2 });
    db = createDb(runtimeUrl!, { max: 2 });
    mdb = createDb(maintenanceUrl!, { max: 1 });
    raw = new Client({ connectionString: ownerUrl, options: "-c TimeZone=UTC" });
    await raw.connect();
    shared = await rtClient();
    mshared = await mtClient();
    const role = await realRoleIds(owner);
    for (const [k, months] of [["a", 1], ["b", 12], ["c", 1], ["d", 12]] as const) {
      const u = await owner.user.create({ data: { email: `hr-${k}-${rnd()}@${DOMAIN}`, name: `HR ${k}` } });
      userIds.push(u.id);
      const o = await owner.organization.create({ data: { slug: `ret-${k}-${rnd()}${rnd()}`, name: `Retention ${k}`, ownerUserId: u.id, timezone: "Asia/Kolkata", candidateRetentionMonths: months } });
      orgIds.push(o.id);
      await owner.organizationMember.create({ data: { organizationId: o.id, userId: u.id, status: "ACTIVE", joinedAt: new Date(), roles: { create: [{ roleId: role.HR_MANAGER }] } } });
      const j = await owner.jobOpening.create({ data: { organizationId: o.id, slug: `job-${rnd()}`, title: "Barista", description: "Synthetic job.", employmentType: "FULL_TIME", workMode: "ON_SITE", createdById: u.id, status: "PUBLISHED", publishedAt: new Date() } });
      const j2 = await owner.jobOpening.create({ data: { organizationId: o.id, slug: `job-${rnd()}`, title: "Cashier", description: "Synthetic job.", employmentType: "FULL_TIME", workMode: "ON_SITE", createdById: u.id, status: "PUBLISHED", publishedAt: new Date() } });
      org[k] = { id: o.id, job: j.id, job2: j2.id, hr: u.id };
    }
  }, 60_000);

  afterAll(async () => {
    if (raw) {
      // Address keys are stored as given; the "address unknown" and email keys are derived per organisation.
      if (usedHashes.length || orgIds.length) {
        await raw.query(`DELETE FROM public_apply_rate_events WHERE key_hash = ANY($1)
          OR key_hash IN (SELECT encode(sha256(convert_to('email:' || o || ':' || h, 'UTF8')), 'hex') FROM unnest($2::text[]) o, unnest($1::text[]) h)
          OR key_hash IN (SELECT encode(sha256(convert_to('unknown-address:' || o, 'UTF8')), 'hex') FROM unnest($2::text[]) o)`, [usedHashes, orgIds]);
      }
      if (orgIds.length) {
        await raw.query(`DELETE FROM candidate_documents WHERE organization_id = ANY($1)`, [orgIds]);
        await raw.query(`DELETE FROM application_status_history WHERE organization_id = ANY($1)`, [orgIds]);
        await raw.query(`DELETE FROM applications WHERE organization_id = ANY($1)`, [orgIds]);
        await raw.query(`DELETE FROM organization_candidates WHERE organization_id = ANY($1)`, [orgIds]);
        await raw.query(`DELETE FROM candidate_profiles WHERE organization_id = ANY($1)`, [orgIds]);
        await raw.query(`DELETE FROM job_openings WHERE organization_id = ANY($1)`, [orgIds]);
        await owner.session.deleteMany({ where: { userId: { in: userIds } } });
        await owner.organizationMember.deleteMany({ where: { organizationId: { in: orgIds } } });
        await purgeTestAuditRows(owner, orgIds);
        await owner.organization.deleteMany({ where: { id: { in: orgIds } } });
        await owner.user.deleteMany({ where: { id: { in: userIds } } });
      }
    }
    await shared?.end();
    await mshared?.end();
    await raw?.end();
    await owner?.$disconnect();
    await db?.$disconnect();
    await mdb?.$disconnect();
  });

  describe("public application limits", () => {
    const allowed = async (c: Client, address: string | null, email: string, k: "a" | "b" = "a") => {
      const r = await inMode(c, "public_apply", `SELECT app_public_apply_allowed($1, $2) AS ok`, [address, email], k);
      expect(r.error).toBeUndefined();
      return r.rows[0]!.ok as boolean;
    };

    it("allows 5 submissions per address in 10 minutes, then refuses (nothing counted for the refused ones)", async () => {
      const c = shared;
      const address = hash();
      usedHashes.push(address);
      const results: boolean[] = [];
      for (let i = 0; i < 7; i++) {
        const email = hash();
        usedHashes.push(email);
        results.push(await allowed(c, address, email));
      }
      expect(results).toEqual([true, true, true, true, true, false, false]);
      expect((await raw.query(`SELECT count(*)::int n FROM public_apply_rate_events WHERE key_hash = $1`, [address])).rows[0].n).toBe(5);
    });

    it("allows 5 submissions per email in an hour, whatever the address", async () => {
      const c = shared;
      const email = hash();
      usedHashes.push(email);
      const results: boolean[] = [];
      for (let i = 0; i < 6; i++) {
        const address = hash();
        usedHashes.push(address);
        results.push(await allowed(c, address, email));
      }
      expect(results).toEqual([true, true, true, true, true, false]);
    });

    it("counts parallel submissions from separate connections (separate app servers) together", async () => {
      const address = hash();
      usedHashes.push(address);
      const clients = await Promise.all(Array.from({ length: 7 }, rtClient)); // 7 at once, limit 5
      try {
        const results = await Promise.all(clients.map((c) => {
          const email = hash();
          usedHashes.push(email);
          return allowed(c, address, email);
        }));
        expect(results.filter(Boolean)).toHaveLength(5);
      } finally {
        await Promise.all(clients.map((c) => c.end()));
      }
    });

    it("keeps the address-unknown and per-email counts per organisation, so one company cannot block another", async () => {
      const c = shared;
      // Address unknown (no trusted proxy): 30 per 10 minutes for organisation A ...
      const unknownA: boolean[] = [];
      for (let i = 0; i < 31; i++) {
        const email = hash();
        usedHashes.push(email);
        unknownA.push(await allowed(c, null, email, "a"));
      }
      expect(unknownA.filter(Boolean)).toHaveLength(30);
      expect(unknownA[30]).toBe(false);
      // ... while organisation B still accepts applications from unknown addresses.
      const emailB = hash();
      usedHashes.push(emailB);
      expect(await allowed(c, null, emailB, "b")).toBe(true);
      // One email used up at A (5 per hour) can still apply to B.
      const email = hash();
      usedHashes.push(email);
      for (let i = 0; i < 5; i++) {
        const address = hash();
        usedHashes.push(address);
        expect(await allowed(c, address, email, "a")).toBe(true);
      }
      const address = hash();
      usedHashes.push(address);
      expect(await allowed(c, address, email, "a")).toBe(false);
      const address2 = hash();
      usedHashes.push(address2);
      expect(await allowed(c, address2, email, "b")).toBe(true);
      // Without an organisation in the session it refuses.
      await c.query("BEGIN");
      await c.query(`SELECT set_config('app.mode', 'public_apply', true)`);
      const noOrg = await c.query(`SELECT app_public_apply_allowed($1, $2)`, [hash(), hash()]).then(() => "allowed", (e: Error) => e.message);
      await c.query("ROLLBACK");
      expect(noOrg).toMatch(/not allowed/);
    });

    it("stores only hashes, keeps nothing older than an hour, and is closed to the app account otherwise", async () => {
      const rows = (await raw.query(`SELECT bucket, key_hash, created_at FROM public_apply_rate_events WHERE key_hash = ANY($1)`, [usedHashes])).rows;
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) expect(r.key_hash).toMatch(/^[0-9a-f]{64}$/);
      // An old row is cleared by the next call.
      const old = hash();
      usedHashes.push(old);
      await raw.query(`INSERT INTO public_apply_rate_events (bucket, key_hash, created_at) VALUES ('address', $1, now() - interval '2 hours')`, [old]);
      const c = shared;
      const email = hash();
      usedHashes.push(email);
      const address = hash();
      usedHashes.push(address);
      await allowed(c, address, email);
      expect((await raw.query(`SELECT count(*)::int n FROM public_apply_rate_events WHERE key_hash = $1`, [old])).rows[0].n).toBe(0);
      // Direct access and other modes are refused.
      expect((await inMode(c, "public_apply", `SELECT count(*) FROM public_apply_rate_events`)).error).toMatch(/permission denied/);
      expect((await inMode(c, "public_apply", `INSERT INTO public_apply_rate_events (bucket, key_hash) VALUES ('address', $1)`, [hash()])).error).toMatch(/permission denied/);
      expect((await inMode(c, "staff", `SELECT app_public_apply_allowed($1, $2)`, [hash(), hash()])).error).toMatch(/not allowed/);
      expect((await inMode(c, "maintenance", `SELECT app_public_apply_allowed($1, $2)`, [hash(), hash()])).error).toMatch(/not allowed/);
    });
  });

  describe("candidate retention job", () => {
    const files = new Map<string, Uint8Array>();
    const failing = new Set<string>();
    const storage: FileStorage = {
      put: async (key, b) => void files.set(key, b),
      get: async (key) => files.get(key) ?? null,
      remove: async (key) => {
        if (failing.has(key)) throw new Error("storage unavailable");
        files.delete(key);
      },
    };
    const c: Record<string, { oc: string; profile: string; key: string }> = {};

    // A candidate of `k` with one application in `stage`, last changed `monthsAgo` months ago, and one file.
    // `ago`: months (number), an interval ("12 months - 6 hours"), or a fixed UTC time ("2025-03-31T00:00:00Z").
    async function candidate(name: string, k: K, stage: string, ago: number | string, email?: string) {
      const profile = (await raw.query(`INSERT INTO candidate_profiles (id, organization_id, email, full_name, phone, updated_at) VALUES (gen_random_uuid(), $1, $2, $3, '9800000000', now()) RETURNING id`,
        [org[k].id, email ?? `${name.toLowerCase()}-${rnd()}@${DOMAIN}`, `Person ${name}`])).rows[0].id;
      const oc = (await raw.query(`INSERT INTO organization_candidates (id, organization_id, candidate_id, notes, updated_at) VALUES (gen_random_uuid(), $1, $2, 'HR note', now()) RETURNING id`, [org[k].id, profile])).rows[0].id;
      const at = typeof ago === "number" ? `now() - interval '${ago} months'`
        : /^[0-9]{4}-/.test(ago) ? `'${ago}'::timestamptz` : `now() - interval '${ago}'`;
      const app = (await raw.query(`INSERT INTO applications (id, organization_id, reference_number, organization_candidate_id, job_id, stage, stage_changed_at, profile_snapshot, consent_accepted_at, privacy_notice_version, age_confirmed_at, applied_at, updated_at)
        VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, ${at}, '{"fullName":"x"}', ${at}, 'test', ${at}, ${at}, now()) RETURNING id`, [org[k].id, `RET-${rnd()}${rnd()}`, oc, org[k].job, stage])).rows[0].id;
      const key = `resumes/2026/${randomUUID()}`;
      await raw.query(`INSERT INTO candidate_documents (id, candidate_id, organization_id, application_id, kind, original_name, storage_key, mime_type, size_bytes, sha256)
        VALUES (gen_random_uuid(), $1, $2, $3, 'RESUME', 'cv.pdf', $4, 'application/pdf', 1, 'x')`, [profile, org[k].id, app, key]);
      files.set(key, new Uint8Array([1]));
      c[name] = { oc, profile, key };
    }
    const state = async (name: string) => (await raw.query(`SELECT oc.removed_at IS NOT NULL AS removed, oc.notes, cp.full_name, cp.anonymized_at IS NOT NULL AS anon,
        d.deleted_at IS NOT NULL AS doc_deleted, d.file_removed_at IS NOT NULL AS file_confirmed
        FROM organization_candidates oc JOIN candidate_profiles cp ON cp.id = oc.candidate_id JOIN candidate_documents d ON d.candidate_id = cp.id WHERE oc.id = $1`, [c[name]!.oc])).rows[0];

    beforeAll(async () => {
      await candidate("due", "a", "REJECTED", 2); // A keeps 1 month: due
      await candidate("dueFileFails", "a", "WITHDRAWN", 3); // due, but its file cannot be deleted the first time
      await candidate("recent", "a", "REJECTED", 0); // closed this month: not due yet
      await candidate("open", "a", "APPLIED", 6); // still open: never removed automatically
      await candidate("otherOrg", "b", "REJECTED", 2); // B keeps 12 months: not due
      failing.add(c.dueFileFails!.key);
    });

    it("removes exactly the candidates who are due, by the organisation's own retention period", async () => {
      const result = await runCandidateRetention(mdb, storage, { organizationId: org.a.id });
      expect(result.candidatesRemoved).toBe(2);
      for (const n of ["due", "dueFileFails"]) {
        expect(await state(n), n).toMatchObject({ removed: true, notes: null, full_name: "Removed candidate", anon: true, doc_deleted: true });
      }
      for (const n of ["recent", "open"]) {
        expect(await state(n), n).toMatchObject({ removed: false, notes: "HR note", anon: false, doc_deleted: false });
      }
      // Organisation B's candidate is not due under B's 12 months, also when B's run happens.
      expect((await runCandidateRetention(mdb, storage, { organizationId: org.b.id })).candidatesRemoved).toBe(0);
      expect(await state("otherOrg")).toMatchObject({ removed: false, anon: false, doc_deleted: false });
      // The audit log says it was the retention job (no person).
      const audit = (await raw.query(`SELECT actor_user_id, metadata FROM audit_logs WHERE action = 'candidate.removed' AND entity_id = $1`, [c.due!.oc])).rows;
      expect(audit).toHaveLength(1);
      expect(audit[0]!.actor_user_id).toBeNull();
      expect(audit[0]!.metadata).toMatchObject({ reason: "retention", profile: "anonymised" });
    });

    it("deletes the removed candidates' files, and retries a file whose deletion failed", async () => {
      expect(files.has(c.due!.key)).toBe(false);
      expect(await state("due")).toMatchObject({ file_confirmed: true });
      expect(files.has(c.dueFileFails!.key)).toBe(true);
      expect(await state("dueFileFails")).toMatchObject({ file_confirmed: false });
      for (const n of ["recent", "open"]) expect(files.has(c[n]!.key), n).toBe(true);
      // Storage works again: the next run deletes the left-over file and confirms it.
      failing.clear();
      expect(await runCandidateRetention(mdb, storage, { organizationId: org.a.id })).toMatchObject({ candidatesRemoved: 0, candidatesFailed: 0, filesDeleted: 1, filesFailed: 0 });
      expect(files.has(c.dueFileFails!.key)).toBe(false);
      expect(await state("dueFileFails")).toMatchObject({ file_confirmed: true });
      // And a further run has nothing left to do.
      expect(await runCandidateRetention(mdb, storage, { organizationId: org.a.id })).toMatchObject({ candidatesRemoved: 0, candidatesFailed: 0, filesDeleted: 0, filesFailed: 0 });
    });

    it("is reachable only as the maintenance job, which can read no data at all", async () => {
      const rt = shared;
      // The app account may not run the job's functions in any mode, maintenance included.
      for (const mode of ["staff", "public_apply", "maintenance"] as const) {
        expect((await inMode(rt, mode, `SELECT * FROM app_remove_due_candidates(10, NULL)`)).error, mode).toMatch(/permission denied for function app_remove_due_candidates/);
        expect((await inMode(rt, mode, `SELECT * FROM app_pending_file_removals(10, NULL)`)).error, mode).toMatch(/permission denied for function app_pending_file_removals/);
        expect((await inMode(rt, mode, `SELECT app_confirm_file_removed(ARRAY[]::uuid[])`)).error, mode).toMatch(/permission denied for function app_confirm_file_removed/);
      }
      // The job's account may, but only in maintenance mode.
      for (const mode of ["staff", "public_apply"] as const) {
        expect((await inMode(mshared, mode, `SELECT * FROM app_remove_due_candidates(10, NULL)`)).error, mode).toMatch(/not allowed/);
        expect((await inMode(mshared, mode, `SELECT * FROM app_pending_file_removals(10, NULL)`)).error, mode).toMatch(/not allowed/);
        expect((await inMode(mshared, mode, `SELECT app_confirm_file_removed(ARRAY[]::uuid[])`)).error, mode).toMatch(/not allowed/);
      }
      // The removal core cannot be called by the job's account directly either.
      expect((await inMode(mshared, "maintenance", `SELECT * FROM app_remove_candidate_core($1, NULL, $2, now(), 'retention')`, [org.a.id, c.recent!.oc])).error)
        .toMatch(/permission denied for function app_remove_candidate_core/);
      // The job's account cannot read any candidate table at all.
      for (const t of ["candidate_profiles", "organization_candidates", "applications", "candidate_documents", "audit_logs"]) {
        expect((await inMode(mshared, "maintenance", `SELECT count(*)::int n FROM ${t}`)).error, t).toMatch(/permission denied for table/);
      }
      // The removal core cannot be called by the app account at all (it would skip the permission check).
      const core = await inMode(rt, "maintenance", `SELECT * FROM app_remove_candidate_core($1, NULL, $2, now(), 'retention')`, [org.a.id, c.recent!.oc]);
      expect(core.error).toMatch(/permission denied for function app_remove_candidate_core/);
      // Maintenance mode sees no rows of any candidate table.
      for (const t of ["candidate_profiles", "organization_candidates", "applications", "candidate_documents", "audit_logs"]) {
        const r = await inMode(rt, "maintenance", `SELECT count(*)::int n FROM ${t}`);
        expect(r.error, t).toBeUndefined();
        expect(r.rows[0]!.n, t).toBe(0);
      }
      expect(await state("recent")).toMatchObject({ removed: false });
    });

    // What app_remove_due_candidates would remove (rolled back), in a session with the given time zone and, for
    // fixed-date checks, a pinned clock (the function only allows moving it back).
    async function dueInZone(zone: string, k: K, pNow: string | null = null) {
      const rt = mshared;
      await rt.query("BEGIN");
      try {
        await rt.query(`SELECT set_config('app.mode', 'maintenance', true)`);
        await rt.query(`SELECT set_config('TimeZone', $1, true)`, [zone]);
        const r = await rt.query(`SELECT organization_candidate_id, failed FROM app_remove_due_candidates(50, $1, $2::timestamptz)`, [org[k].id, pNow]);
        return r.rows.filter((x) => !x.failed).map((x) => x.organization_candidate_id as string);
      } finally {
        await rt.query("ROLLBACK");
      }
    }
    // Waits until the backend `pid` is blocked on a lock (fails after 5 s), instead of hoping a sleep is long enough.
    // Asked as the same account as the waiting backend: another (non-superuser) account cannot see its wait state in
    // pg_stat_activity. `via` is shared (app account) or mshared (the job's account).
    async function waitUntilBlocked(pid: number, via: Client = shared) {
      for (let i = 0; i < 100; i++) {
        const r = await via.query(`SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1`, [pid]);
        if (r.rows[0]?.wait_event_type === "Lock") return;
        await new Promise((res) => setTimeout(res, 50));
      }
      throw new Error(`backend ${pid} never waited on a lock`);
    }

    it("computes the cutoff in UTC, whatever the time zone of the connection (fixed clock on a month end)", async () => {
      // Clock pinned at 2025-04-30 12:00 UTC; A keeps 1 month, so the UTC cutoff is 2025-03-30 12:00 UTC.
      const pNow = "2025-04-30T12:00:00Z";
      await candidate("tzNotDue", "a", "REJECTED", "2025-03-31T00:00:00Z"); // after the UTC cutoff: not due
      await candidate("tzDue", "a", "REJECTED", "2025-03-29T00:00:00Z"); // before it: due
      // The test is sensitive: in a UTC+14 session, plain "now - 1 month" lands a day later (2025-03-31 12:00 UTC)
      // and WOULD count tzNotDue as due. The function must not.
      await raw.query("BEGIN");
      await raw.query(`SET LOCAL TimeZone = 'Pacific/Kiritimati'`);
      const naive = (await raw.query(`SELECT ($1::timestamptz - interval '1 month') > '2025-03-31T00:00:00Z'::timestamptz AS would_remove`, [pNow])).rows[0];
      await raw.query("ROLLBACK");
      expect(naive.would_remove).toBe(true);
      for (const zone of ["UTC", "Asia/Kolkata", "Pacific/Kiritimati", "Pacific/Pago_Pago", "America/Los_Angeles"]) {
        const due = await dueInZone(zone, "a", pNow);
        expect(due, zone).toContain(c.tzDue!.oc);
        expect(due, zone).not.toContain(c.tzNotDue!.oc);
      }
      // A clock in the future is refused (it could only make more people due).
      await mshared.query("BEGIN");
      await mshared.query(`SELECT set_config('app.mode', 'maintenance', true)`);
      const future = await mshared.query(`SELECT * FROM app_remove_due_candidates(1, $1, now() + interval '1 day')`, [org.a.id]).then(() => "allowed", (e: Error) => e.message);
      await mshared.query("ROLLBACK");
      expect(future).toMatch(/not allowed/);
      // Both are really due today: let the later tests in A see them removed already.
      expect((await runCandidateRetention(mdb, storage, { organizationId: org.a.id })).candidatesRemoved).toBe(2);
    });

    it("skips a candidate whose removal fails, removes the others, and retries it on the next run", async () => {
      await candidate("stuck", "a", "REJECTED", 4); // oldest: tried first
      await candidate("next", "a", "REJECTED", 3);
      const fn = `test_block_removal_${rnd()}`;
      await raw.query(`CREATE FUNCTION ${fn}() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'simulated failure'; END; $$ LANGUAGE plpgsql`);
      await raw.query(`CREATE TRIGGER ${fn} BEFORE UPDATE ON organization_candidates FOR EACH ROW WHEN (OLD.id = '${c.stuck!.oc}') EXECUTE FUNCTION ${fn}()`);
      try {
        const first = await runCandidateRetention(mdb, storage, { organizationId: org.a.id });
        expect(first).toMatchObject({ candidatesRemoved: 1, candidatesFailed: 1 });
        expect(await state("next")).toMatchObject({ removed: true, anon: true });
        // Nothing of the failed candidate changed (its removal was its own subtransaction).
        expect(await state("stuck")).toMatchObject({ removed: false, notes: "HR note", full_name: "Person stuck", anon: false, doc_deleted: false });
      } finally {
        await raw.query(`DROP TRIGGER IF EXISTS ${fn} ON organization_candidates`);
        await raw.query(`DROP FUNCTION IF EXISTS ${fn}()`);
      }
      expect(await runCandidateRetention(mdb, storage, { organizationId: org.a.id })).toMatchObject({ candidatesRemoved: 1, candidatesFailed: 0 });
      expect(await state("stuck")).toMatchObject({ removed: true, anon: true, doc_deleted: true });
    });

    it("counts only successful removals against the batch size, and leaves the rest for the next call", async () => {
      // Organisation C: one failing candidate (oldest) and three healthy ones, a batch of 2.
      await candidate("cStuck", "c", "REJECTED", 9);
      await candidate("c1", "c", "REJECTED", 8);
      await candidate("c2", "c", "REJECTED", 7);
      await candidate("c3", "c", "REJECTED", 6);
      const fn = `test_block_removal_${rnd()}`;
      await raw.query(`CREATE FUNCTION ${fn}() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'simulated failure'; END; $$ LANGUAGE plpgsql`);
      await raw.query(`CREATE TRIGGER ${fn} BEFORE UPDATE ON candidate_documents FOR EACH ROW WHEN (OLD.candidate_id = '${c.cStuck!.profile}') EXECUTE FUNCTION ${fn}()`);
      try {
        await mshared.query("BEGIN");
        await mshared.query(`SELECT set_config('app.mode', 'maintenance', true)`);
        const rows = (await mshared.query(`SELECT organization_candidate_id AS id, failed FROM app_remove_due_candidates(2, $1)`, [org.c.id])).rows;
        await mshared.query("COMMIT");
        expect(rows).toEqual([{ id: c.cStuck!.oc, failed: true }, { id: c.c1!.oc, failed: false }, { id: c.c2!.oc, failed: false }]);
      } finally {
        await mshared.query("ROLLBACK").catch(() => {});
        await raw.query(`DROP TRIGGER IF EXISTS ${fn} ON candidate_documents`);
        await raw.query(`DROP FUNCTION IF EXISTS ${fn}()`);
      }
      // The failing one: its profile was anonymised BEFORE its documents step failed, and that was undone too.
      expect(await state("cStuck")).toMatchObject({ removed: false, notes: "HR note", full_name: "Person cStuck", anon: false, doc_deleted: false });
      for (const n of ["c1", "c2"]) expect(await state(n), n).toMatchObject({ removed: true, anon: true });
      expect(await state("c3")).toMatchObject({ removed: false, anon: false }); // left for the next call
    });

    it("deletes and confirms nothing when the storage folder is not the app's own, and accepts older stores without the marker", async () => {
      await candidate("rootCheck", "a", "REJECTED", 5);
      const empty = await mkdtemp(path.join(os.tmpdir(), "cafeos-wrong-root-"));
      const legacy = await mkdtemp(path.join(os.tmpdir(), "cafeos-legacy-root-"));
      try {
        // The removal happens; the file step refuses: the wrong folder has neither the marker nor resumes/.
        await expect(runCandidateRetention(mdb, createLocalStorage(empty), { organizationId: org.a.id })).rejects.toThrow(/not the app's file storage/);
        expect(await state("rootCheck")).toMatchObject({ removed: true, doc_deleted: true, file_confirmed: false });
        await expect(createLocalStorage(path.join(empty, "missing")).verifyRoot!()).rejects.toThrow(/storage folder not found/);
        // A store from before the marker existed (it has resumes/ but no marker) is accepted.
        await mkdir(path.join(legacy, "resumes", "2026"), { recursive: true });
        expect(await createLocalStorage(legacy).verifyRoot!()).toBe(path.resolve(legacy));
        // A store that got the marker with its first file is accepted, and the pending file is then confirmed.
        const real = createLocalStorage(empty);
        await real.put(`documents/2026/${randomUUID()}`, new Uint8Array([1]));
        expect(await real.verifyRoot!()).toBe(path.resolve(empty));
        expect(await runCandidateRetention(mdb, storage, { organizationId: org.a.id })).toMatchObject({ filesDeleted: 1, filesFailed: 0 });
        expect(await state("rootCheck")).toMatchObject({ file_confirmed: true });
      } finally {
        await rm(empty, { recursive: true, force: true });
        await rm(legacy, { recursive: true, force: true });
      }
    });

    const submitSql = `SELECT * FROM app_submit_public_application($1, $2, $3, 'Applies Again', '9800000001', NULL, NULL, NULL, NULL, NULL, '{}'::text[],
        NULL, '{"fullName":"Applies Again"}'::jsonb, 'test', now(), NULL, NULL, NULL, NULL, NULL, true)`;

    it("an application arriving while the removal runs gets a fresh record; the removed one gets none", async () => {
      const email = `racer-${rnd()}@${DOMAIN}`;
      await candidate("racer", "a", "REJECTED", 6, email);
      const remover = await mtClient(); // the scheduled job's account
      const applicant = await rtClient();
      try {
        // The retention job removes the person but has not committed yet ...
        await remover.query("BEGIN");
        await remover.query(`SELECT set_config('app.mode', 'maintenance', true)`);
        const removed = (await remover.query(`SELECT organization_candidate_id FROM app_remove_due_candidates(50, $1) WHERE NOT failed`, [org.a.id])).rows.map((x) => x.organization_candidate_id);
        expect(removed).toContain(c.racer!.oc);
        // ... while the same person applies again: the application waits for the removal.
        const pid = (await applicant.query(`SELECT pg_backend_pid() AS pid`)).rows[0].pid as number;
        await applicant.query("BEGIN");
        await applicant.query(`SELECT set_config('app.mode', 'public_apply', true), set_config('app.org_id', $1, true)`, [org.a.id]);
        const submitting = applicant.query(submitSql, [org.a.job2, `RACE-${rnd()}${rnd()}`, email]);
        submitting.catch(() => {});
        await waitUntilBlocked(pid);
        await remover.query("COMMIT");
        const app = (await submitting).rows[0].application_id;
        await applicant.query("COMMIT");
        const oc = (await raw.query(`SELECT a.organization_candidate_id AS oc, o.removed_at FROM applications a JOIN organization_candidates o ON o.id = a.organization_candidate_id WHERE a.id = $1`, [app])).rows[0];
        expect(oc.oc).not.toBe(c.racer!.oc); // a fresh record ...
        expect(oc.removed_at).toBeNull(); // ... that is not removed
        expect(await state("racer")).toMatchObject({ removed: true, anon: true });
      } finally {
        // Whichever side holds the lock is released first, so the other one can finish.
        await Promise.all([remover.query("ROLLBACK").catch(() => {}), applicant.query("ROLLBACK").catch(() => {})]);
        await remover.end();
        await applicant.end();
      }
    });

    it("a removal arriving while the person applies waits, then leaves the person (they have an open application)", async () => {
      const email = `stayer-${rnd()}@${DOMAIN}`;
      await candidate("stayer", "a", "REJECTED", 6, email);
      const remover = await mtClient(); // the scheduled job's account
      const applicant = await rtClient();
      try {
        // The application holds a share lock on the record and has not committed yet ...
        await applicant.query("BEGIN");
        await applicant.query(`SELECT set_config('app.mode', 'public_apply', true), set_config('app.org_id', $1, true)`, [org.a.id]);
        const app = (await applicant.query(submitSql, [org.a.job2, `STAY-${rnd()}${rnd()}`, email])).rows[0].application_id;
        // ... when the retention job reaches the same person: it has to wait.
        const pid = (await remover.query(`SELECT pg_backend_pid() AS pid`)).rows[0].pid as number;
        await remover.query("BEGIN");
        await remover.query(`SELECT set_config('app.mode', 'maintenance', true)`);
        const removing = remover.query(`SELECT organization_candidate_id AS id, failed FROM app_remove_due_candidates(50, $1)`, [org.a.id]);
        removing.catch(() => {});
        await waitUntilBlocked(pid, mshared);
        await applicant.query("COMMIT");
        const rows = (await removing).rows;
        await remover.query("COMMIT");
        // The removal saw the new open application and refused, for this person only.
        expect(rows).toContainEqual({ id: c.stayer!.oc, failed: true });
        expect(await state("stayer")).toMatchObject({ removed: false, notes: "HR note", anon: false });
        const a = (await raw.query(`SELECT organization_candidate_id AS oc, stage FROM applications WHERE id = $1`, [app])).rows[0];
        expect(a).toEqual({ oc: c.stayer!.oc, stage: "APPLIED" });
      } finally {
        // Whichever side holds the lock is released first, so the other one can finish.
        await Promise.all([remover.query("ROLLBACK").catch(() => {}), applicant.query("ROLLBACK").catch(() => {})]);
        await remover.end();
        await applicant.end();
      }
    });

    it("a removal that runs between the application's record look-up and its insert waits, then leaves the person", async () => {
      // The exact window from the review: the application has found the (not yet removed) record; before it inserts,
      // the retention job removes the person. A test-only trigger pauses the application right at its insert.
      const email = `window-${rnd()}@${DOMAIN}`;
      await candidate("window", "a", "REJECTED", 6, email);
      const key = Math.floor(Math.random() * 1e9);
      const fn = `zz_test_pause_${rnd()}`;
      await raw.query(`CREATE FUNCTION ${fn}() RETURNS trigger AS $$ BEGIN PERFORM pg_advisory_lock(${key}); PERFORM pg_advisory_unlock(${key}); RETURN NEW; END; $$ LANGUAGE plpgsql`);
      await raw.query(`CREATE TRIGGER ${fn} BEFORE INSERT ON applications FOR EACH ROW WHEN (NEW.organization_candidate_id = '${c.window!.oc}') EXECUTE FUNCTION ${fn}()`);
      const gate = new Client({ connectionString: ownerUrl });
      await gate.connect();
      const remover = await mtClient(); // the scheduled job's account
      const applicant = await rtClient();
      try {
        await gate.query(`SELECT pg_advisory_lock($1)`, [key]); // closed
        const appPid = (await applicant.query(`SELECT pg_backend_pid() AS pid`)).rows[0].pid as number;
        await applicant.query("BEGIN");
        await applicant.query(`SELECT set_config('app.mode', 'public_apply', true), set_config('app.org_id', $1, true)`, [org.a.id]);
        const submitting = applicant.query(submitSql, [org.a.job2, `WIN-${rnd()}${rnd()}`, email]);
        submitting.catch(() => {});
        await waitUntilBlocked(appPid); // paused at its insert, record already looked up
        // Now the retention job reaches the same person. With the fix it must wait for the application.
        const remPid = (await remover.query(`SELECT pg_backend_pid() AS pid`)).rows[0].pid as number;
        await remover.query("BEGIN");
        await remover.query(`SELECT set_config('app.mode', 'maintenance', true)`);
        const removing = remover.query(`SELECT organization_candidate_id AS id, failed FROM app_remove_due_candidates(50, $1)`, [org.a.id]);
        removing.catch(() => {});
        await waitUntilBlocked(remPid, mshared);
        await gate.query(`SELECT pg_advisory_unlock($1)`, [key]); // let the application finish
        const app = (await submitting).rows[0].application_id;
        await applicant.query("COMMIT");
        const rows = (await removing).rows;
        await remover.query("COMMIT");
        expect(rows).toContainEqual({ id: c.window!.oc, failed: true }); // refused: an open application again
        expect(await state("window")).toMatchObject({ removed: false, anon: false });
        const a = (await raw.query(`SELECT a.organization_candidate_id AS oc, o.removed_at FROM applications a JOIN organization_candidates o ON o.id = a.organization_candidate_id WHERE a.id = $1`, [app])).rows[0];
        expect(a).toEqual({ oc: c.window!.oc, removed_at: null });
      } finally {
        await gate.query(`SELECT pg_advisory_unlock_all()`).catch(() => {});
        await Promise.all([remover.query("ROLLBACK").catch(() => {}), applicant.query("ROLLBACK").catch(() => {})]);
        await Promise.all([remover.end(), applicant.end(), gate.end()]);
        await raw.query(`DROP TRIGGER IF EXISTS ${fn} ON applications`);
        await raw.query(`DROP FUNCTION IF EXISTS ${fn}()`);
      }
    });

    it("refuses any application on a removed record: new, moved onto it, or entered by HR", async () => {
      await candidate("gone", "a", "REJECTED", 0);
      await candidate("other", "a", "APPLIED", 0);
      await raw.query(`UPDATE organization_candidates SET removed_at = now() WHERE id = $1`, [c.gone!.oc]);
      const insert = `INSERT INTO applications (id, organization_id, reference_number, organization_candidate_id, job_id, stage, stage_changed_at, consent_accepted_at, privacy_notice_version, age_confirmed_at, applied_at, updated_at)
        VALUES (gen_random_uuid(), $1, $2, $3, $4, 'APPLIED', now(), now(), 'test', now(), now(), now())`;
      const asOwner = await raw.query(insert, [org.a.id, `GUARD-${rnd()}`, c.gone!.oc, org.a.job]).then(() => "allowed", (e: Error) => e.message);
      expect(asOwner).toMatch(/candidate_removed/);
      const moved = await raw.query(`UPDATE applications SET organization_candidate_id = $1 WHERE organization_candidate_id = $2`, [c.gone!.oc, c.other!.oc]).then(() => "allowed", (e: Error) => e.message);
      expect(moved).toMatch(/candidate_removed/);
      const asHr = await inMode(shared, "staff", insert, [org.a.id, `GUARD-${rnd()}`, c.gone!.oc, org.a.job]);
      expect(asHr.error).toMatch(/candidate_removed/);
    });

    it("computes the same cutoff as the database, so the due list and the job agree (month ends, leap days)", async () => {
      const cases: { now: Date; months: number }[] = [];
      const days = ["2024-02-29T10:00:00Z", "2025-03-31T23:59:59Z", "2025-05-31T00:00:00Z", "2026-01-31T12:00:00Z", "2028-02-29T00:30:00Z", "2026-12-31T18:45:00.123Z"];
      for (const d of days) for (let m = 1; m <= 120; m += 1) if (m <= 24 || m % 12 === 0 || m === 37 || m === 119) cases.push({ now: new Date(d), months: m });
      for (let i = 0; i < 400; i++) cases.push({ now: new Date(Date.UTC(2024, 0, 1) + i * 86_400_000 * 2.3 + i * 37_000), months: (i % 120) + 1 });
      const rows = (await raw.query(
        `SELECT ((t AT TIME ZONE 'UTC') - make_interval(months => m)) AT TIME ZONE 'UTC' AS cutoff FROM unnest($1::timestamptz[], $2::int[]) AS x(t, m)`,
        [cases.map((x) => x.now.toISOString()), cases.map((x) => x.months)],
      )).rows;
      const mismatches = cases.filter((x, i) => retentionCutoff(x.now, x.months).getTime() !== new Date(rows[i].cutoff).getTime());
      expect(mismatches.slice(0, 3)).toEqual([]);
      expect(cases.length).toBeGreaterThan(500);
      expect(effectiveRetentionMonths({ months: 1, previousMonths: 12, shortenedAt: new Date(Date.now() - 86_400_000) }, new Date())).toBe(12);
      expect(effectiveRetentionMonths({ months: 1, previousMonths: 12, shortenedAt: new Date(Date.now() - 15 * 86_400_000) }, new Date())).toBe(1);
    });

    describe("shortening the retention period", () => {
      const months = async () => (await raw.query(`SELECT candidate_retention_months AS m, candidate_retention_previous_months AS prev, candidate_retention_shortened_at AS at FROM organizations WHERE id = $1`, [org.d.id])).rows[0];
      const setMonths = (m: number) => raw.query(`UPDATE organizations SET candidate_retention_months = $1 WHERE id = $2`, [m, org.d.id]);
      // Moves the start of the grace back in time (the trigger is switched off for that one update only).
      const backdate = async (days: number) => {
        await raw.query("BEGIN");
        await raw.query(`ALTER TABLE organizations DISABLE TRIGGER organizations_note_retention_change`);
        await raw.query(`UPDATE organizations SET candidate_retention_shortened_at = now() - make_interval(days => $1) WHERE id = $2`, [days, org.d.id]);
        await raw.query(`ALTER TABLE organizations ENABLE TRIGGER organizations_note_retention_change`);
        await raw.query("COMMIT");
      };
      const reset = async () => {
        await raw.query("BEGIN");
        await raw.query(`ALTER TABLE organizations DISABLE TRIGGER organizations_note_retention_change`);
        await raw.query(`UPDATE organizations SET candidate_retention_months = 12, candidate_retention_previous_months = NULL, candidate_retention_shortened_at = NULL WHERE id = $1`, [org.d.id]);
        await raw.query(`ALTER TABLE organizations ENABLE TRIGGER organizations_note_retention_change`);
        await raw.query("COMMIT");
      };

      it("keeps the longer period for 14 days, then applies the shorter one", async () => {
        await candidate("shortened", "d", "REJECTED", 2);
        try {
          await setMonths(1); // a typo: 12 -> 1
          expect(await months()).toMatchObject({ m: 1, prev: 12 });
          expect(await dueInZone("UTC", "d")).not.toContain(c.shortened!.oc);
          // Writing the two columns directly changes nothing; an unrelated change keeps them too.
          await raw.query(`UPDATE organizations SET candidate_retention_shortened_at = NULL, candidate_retention_previous_months = NULL WHERE id = $1`, [org.d.id]);
          await raw.query(`UPDATE organizations SET name = name || '' WHERE id = $1`, [org.d.id]);
          expect(await months()).toMatchObject({ m: 1, prev: 12 });
          expect((await months()).at).not.toBeNull();
          // 15 days later the shorter period applies.
          await backdate(15);
          expect(await dueInZone("UTC", "d")).toContain(c.shortened!.oc);
        } finally {
          await reset();
        }
      });

      it("protects the longest recent period through repeated changes", async () => {
        try {
          await setMonths(6);
          await setMonths(1); // 12 -> 6 -> 1 within the grace: still 12
          expect(await months()).toMatchObject({ m: 1, prev: 12 });
          await setMonths(3); // lengthened, but still below 12: the grace stays
          expect(await months()).toMatchObject({ m: 3, prev: 12 });
          await setMonths(12); // back to at least the previous period: nothing to protect
          expect(await months()).toEqual({ m: 12, prev: null, at: null });
          // After the grace has run out, a new shortening protects only the period just before it.
          await setMonths(6);
          await backdate(15);
          await setMonths(1);
          expect(await months()).toMatchObject({ m: 1, prev: 6 });
        } finally {
          await reset();
        }
      });
    });
  });
});

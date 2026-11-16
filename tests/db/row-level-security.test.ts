// Row-level security, tested DIRECTLY in PostgreSQL: no application code is involved.
// It connects as the app's restricted account (hr_runtime), says who is asking with set_config (exactly
// what the app's wrapper does), then tries to read and change data. Everything an attempt does is rolled
// back. Fixtures are created and removed with the owner account (hr_app), which row security does not limit.
import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pgSessionToken } from "./session-helper";

const ownerUrl = process.env.TEST_OWNER_URL;
const runtimeUrl = process.env.TEST_RUNTIME_URL;
const isTestDb = (u?: string) => Boolean(u && /_test\b/.test(new URL(u).pathname));
const enabled = isTestDb(ownerUrl) && isTestDb(runtimeUrl);
const rnd = () => randomBytes(4).toString("hex");

type Who =
  | { mode: "none" }
  | { mode: "staff"; user: string; org: string }
  | { mode: "public_apply"; org?: string }
  // Settings stated directly, the way a forged request would try it.
  | { mode: "forged"; settings: Record<string, string> };

// Recruitment and HR tables protected by "Super Admins and HR Managers of the same organisation".
const HR_TABLES = [
  "job_openings", "organization_candidates", "applications", "application_status_history",
  "application_notes", "application_assignments", "candidate_documents", "departments",
];

describe.skipIf(!enabled)("row-level security, directly in PostgreSQL (test database)", () => {
  let owner: Client;
  let rt: Client;
  const f: Record<string, string> = {};
  const tag = rnd();

  beforeAll(async () => {
    owner = new Client({ connectionString: ownerUrl });
    rt = new Client({ connectionString: runtimeUrl });
    await owner.connect();
    await rt.connect();
    const one = async (sql: string, params: unknown[] = []) => (await owner.query(sql, params)).rows[0];
    const role = async (key: string) => (await one(`SELECT id FROM roles WHERE key = $1`, [key])).id as string;
    const R = { SA: await role("SUPER_ADMIN"), HR: await role("HR_MANAGER"), EMP: await role("EMPLOYEE") };
    const user = async (name: string) => (await one(`INSERT INTO users (id, email, name, updated_at) VALUES (gen_random_uuid(), $1, $2, now()) RETURNING id`, [`rls-${name}-${tag}@example.test`, name])).id;
    const org = async (slug: string, ownerId: string) => (await one(`INSERT INTO organizations (id, slug, name, owner_user_id, updated_at) VALUES (gen_random_uuid(), $1, $1, $2, now()) RETURNING id`, [`rls-${slug}-${tag}`, ownerId])).id;
    const member = async (o: string, u: string, r: string, status = "ACTIVE") => {
      const m = (await one(`INSERT INTO organization_members (id, organization_id, user_id, status, updated_at) VALUES (gen_random_uuid(), $1, $2, $3, now()) RETURNING id`, [o, u, status])).id;
      await owner.query(`INSERT INTO organization_member_roles (member_id, role_id) VALUES ($1, $2)`, [m, r]);
      return m;
    };
    f.sa = await user("sa"); f.hr = await user("hr"); f.emp = await user("emp"); f.hrSuspended = await user("hrsusp"); f.hrB = await user("hrb");
    f.orgA = await org("a", f.sa);
    f.orgB = await org("b", f.hrB);
    f.memberSa = await member(f.orgA, f.sa, R.SA);
    f.memberHr = await member(f.orgA, f.hr, R.HR);
    f.memberEmp = await member(f.orgA, f.emp, R.EMP);
    await member(f.orgA, f.hrSuspended, R.HR, "SUSPENDED");
    f.memberHrB = await member(f.orgB, f.hrB, R.SA);

    const job = async (o: string, slug: string, status: string, createdBy: string) =>
      (await one(`INSERT INTO job_openings (id, organization_id, slug, title, description, employment_type, work_mode, status, created_by_id, updated_at)
                   VALUES (gen_random_uuid(), $1, $2, $2, 'RLS test job', 'FULL_TIME', 'ON_SITE', $3, $4, now()) RETURNING id`, [o, `${slug}-${tag}`, status, createdBy])).id;
    f.jobA = await job(f.orgA, "published", "PUBLISHED", f.sa);
    f.jobADraft = await job(f.orgA, "draft", "DRAFT", f.sa);
    f.jobB = await job(f.orgB, "published-b", "PUBLISHED", f.hrB);

    const candidate = async (email: string) => (await one(`INSERT INTO candidate_profiles (id, email, full_name, updated_at) VALUES (gen_random_uuid(), $1, $1, now()) RETURNING id`, [email])).id;
    f.candA = await candidate(`rls-cand-a-${tag}@example.test`);
    f.candBOnly = await candidate(`rls-cand-b-${tag}@example.test`);
    f.ocA = (await one(`INSERT INTO organization_candidates (id, organization_id, candidate_id, updated_at) VALUES (gen_random_uuid(), $1, $2, now()) RETURNING id`, [f.orgA, f.candA])).id;
    f.ocB = (await one(`INSERT INTO organization_candidates (id, organization_id, candidate_id, updated_at) VALUES (gen_random_uuid(), $1, $2, now()) RETURNING id`, [f.orgB, f.candBOnly])).id;
    const app = async (o: string, oc: string, j: string, ref: string) =>
      (await one(`INSERT INTO applications (id, organization_id, reference_number, organization_candidate_id, job_id, consent_accepted_at, updated_at)
                   VALUES (gen_random_uuid(), $1, $2, $3, $4, now(), now()) RETURNING id`, [o, ref, oc, j])).id;
    f.appA = await app(f.orgA, f.ocA, f.jobA, `RLS-A-${tag}`);
    f.appB = await app(f.orgB, f.ocB, f.jobB, `RLS-B-${tag}`);
    await owner.query(`INSERT INTO application_status_history (id, organization_id, application_id, to_stage) VALUES (gen_random_uuid(), $1, $2, 'APPLIED')`, [f.orgA, f.appA]);
    await owner.query(`INSERT INTO application_notes (id, organization_id, application_id, author_id, body) VALUES (gen_random_uuid(), $1, $2, $3, 'secret HR note')`, [f.orgA, f.appA, f.hr]);
    await owner.query(`INSERT INTO application_assignments (id, organization_id, application_id, recruiter_id, assigned_by_id) VALUES (gen_random_uuid(), $1, $2, $3, $4)`, [f.orgA, f.appA, f.hr, f.sa]);
    await owner.query(`INSERT INTO candidate_documents (id, candidate_id, organization_id, application_id, kind, original_name, storage_key, mime_type, size_bytes, sha256)
                       VALUES (gen_random_uuid(), $1, $2, $3, 'RESUME', 'cv.pdf', $4, 'application/pdf', 10, 'x')`, [f.candA, f.orgA, f.appA, `resumes/2026/${tag}`]);
    await owner.query(`INSERT INTO departments (id, organization_id, name, updated_at) VALUES (gen_random_uuid(), $1, 'Bar', now())`, [f.orgA]);
    for (const [email, roleKey] of [["inv-emp", "EMPLOYEE"], ["inv-hr", "HR_MANAGER"]]) {
      await owner.query(`INSERT INTO staff_invitations (id, organization_id, email, name, role_key, token_hash, expires_at) VALUES (gen_random_uuid(), $1, $2, 'N', $3, md5(random()::text), now() + interval '7 days')`,
        [f.orgA, `${email}-${tag}@example.test`, roleKey]);
    }
  }, 60000);

  afterAll(async () => {
    if (owner && f.orgA) {
      const orgs = [f.orgA, f.orgB];
      await owner.query(`DELETE FROM staff_invitations WHERE organization_id = ANY($1)`, [orgs]);
      await owner.query(`DELETE FROM candidate_documents WHERE organization_id = ANY($1)`, [orgs]);
      await owner.query(`DELETE FROM applications WHERE organization_id = ANY($1)`, [orgs]);
      await owner.query(`DELETE FROM organization_candidates WHERE organization_id = ANY($1)`, [orgs]);
      await owner.query(`DELETE FROM candidate_profiles WHERE email LIKE $1`, [`rls-%-${tag}@example.test`]);
      await owner.query(`DELETE FROM job_openings WHERE organization_id = ANY($1)`, [orgs]);
      await owner.query(`DELETE FROM departments WHERE organization_id = ANY($1)`, [orgs]);
      await owner.query(`DELETE FROM organization_members WHERE organization_id = ANY($1)`, [orgs]);
      await owner.query(`DELETE FROM organizations WHERE id = ANY($1)`, [orgs]);
      await owner.query(`DELETE FROM users WHERE email LIKE $1`, [`rls-%-${tag}@example.test`]);
    }
    await owner?.end();
    await rt?.end();
  });

  // Runs SQL as the app account with the given identity, then rolls everything back.
  async function as<T = Record<string, unknown>>(who: Who, sql: string, params: unknown[] = []): Promise<{ rows: T[]; rowCount: number; error?: string }> {
    await rt.query("BEGIN");
    try {
      if (who.mode === "forged") {
        for (const [k, v] of Object.entries(who.settings)) await rt.query(`SELECT set_config($1, $2, true)`, [k, v]);
      } else if (who.mode !== "none") {
        // Staff: a live session of that member (the database takes the user and organisation from it).
        // Public form: only the organisation it was narrowed to.
        await rt.query(`SELECT set_config('app.mode', $1, true), set_config('app.session_token', $2, true), set_config('app.org_id', $3, true)`, [
          who.mode, who.mode === "staff" ? await pgSessionToken(owner, who.user, who.org) : "", who.mode === "staff" ? "" : (who.org ?? ""),
        ]);
      }
      const r = await rt.query(sql, params);
      return { rows: r.rows as T[], rowCount: r.rowCount ?? 0 };
    } catch (e) {
      return { rows: [], rowCount: 0, error: (e as Error).message };
    } finally {
      await rt.query("ROLLBACK");
    }
  }
  // Several statements in ONE transaction as the given identity; returns the last result; always rolled back.
  async function asMany<T = Record<string, unknown>>(who: Who, sqls: string[]): Promise<{ rows: T[]; error?: string }> {
    await rt.query("BEGIN");
    try {
      if (who.mode === "forged") {
        for (const [k, v] of Object.entries(who.settings)) await rt.query(`SELECT set_config($1, $2, true)`, [k, v]);
      } else if (who.mode !== "none") {
        // Staff: a live session of that member (the database takes the user and organisation from it).
        // Public form: only the organisation it was narrowed to.
        await rt.query(`SELECT set_config('app.mode', $1, true), set_config('app.session_token', $2, true), set_config('app.org_id', $3, true)`, [
          who.mode, who.mode === "staff" ? await pgSessionToken(owner, who.user, who.org) : "", who.mode === "staff" ? "" : (who.org ?? ""),
        ]);
      }
      let last: { rows: T[] } = { rows: [] };
      for (const sql of sqls) last = (await rt.query(sql)) as unknown as { rows: T[] };
      return { rows: last.rows };
    } catch (e) {
      return { rows: [], error: (e as Error).message };
    } finally {
      await rt.query("ROLLBACK");
    }
  }
  // An audit record added by a signed-in member: for an organisation, with an actor.
  const addAudit = (actor: string, org = f.orgA) =>
    `INSERT INTO audit_logs (id, organization_id, actor_user_id, action, entity_type) VALUES (gen_random_uuid(), '${org}', '${actor}', 'rls.test', 'test')`;

  const count = async (who: Who, table: string, where = "true") => Number((await as<{ n: number }>(who, `SELECT count(*)::int AS n FROM "${table}" WHERE ${where}`)).rows[0]?.n ?? -1);
  const inOrgs = () => `organization_id IN ('${f.orgA}', '${f.orgB}')`;

  const SA = (): Who => ({ mode: "staff", user: f.sa, org: f.orgA });
  const HR = (): Who => ({ mode: "staff", user: f.hr, org: f.orgA });
  const EMP = (): Who => ({ mode: "staff", user: f.emp, org: f.orgA });

  it("is switched on for every protected table, and the app account cannot bypass it", async () => {
    const r = await owner.query(`SELECT relname FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' AND NOT relrowsecurity
                                 AND relname IN (${[...HR_TABLES, "candidate_profiles", "staff_invitations", "audit_logs", "organization_members", "organization_member_roles", "notifications", "interviews", "offers"].map((t) => `'${t}'`).join(",")})`);
    expect(r.rows).toEqual([]);
    const role = await owner.query(`SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = 'hr_runtime'`);
    expect(role.rows[0]).toEqual({ rolbypassrls: false, rolsuper: false });
    // Turning it off is not possible for the app account either.
    expect((await as({ mode: "none" }, `ALTER TABLE applications DISABLE ROW LEVEL SECURITY`)).error).toMatch(/owner|permission/i);
    expect((await as(SA(), `SET row_security = off; SELECT count(*) FROM applications`)).error).toMatch(/would be affected by row-level security/);
  });

  it("shows nothing at all when nobody says who is asking (deny by default)", async () => {
    for (const t of [...HR_TABLES, "candidate_profiles", "staff_invitations", "audit_logs"]) {
      expect(await count({ mode: "none" }, t), t).toBe(0);
    }
    // Sign-in still works: membership lookups are allowed before anyone is known.
    expect(await count({ mode: "none" }, "organization_members", inOrgs())).toBe(5);
  });

  it("gives an Employee no recruitment data whatsoever, and only their own membership", async () => {
    for (const t of [...HR_TABLES, "candidate_profiles", "staff_invitations", "audit_logs"]) {
      expect(await count(EMP(), t), t).toBe(0);
    }
    const members = await as<{ user_id: string }>(EMP(), `SELECT user_id FROM organization_members`);
    expect(members.rows.map((m) => m.user_id)).toEqual([f.emp]);
    expect(await count(EMP(), "organization_member_roles")).toBe(1);
    // Writes are refused or reach nothing.
    expect((await as(EMP(), `UPDATE applications SET stage = 'SHORTLISTED' WHERE id = $1`, [f.appA])).rowCount).toBe(0);
    expect((await as(EMP(), `DELETE FROM application_notes`)).rowCount).toBe(0);
    expect((await as(EMP(), `INSERT INTO job_openings (id, organization_id, slug, title, description, employment_type, work_mode, created_by_id, updated_at)
                              VALUES (gen_random_uuid(), $1, 'emp-job', 'x', 'x', 'FULL_TIME', 'ON_SITE', $2, now())`, [f.orgA, f.emp])).error).toMatch(/row-level security/);
    expect((await as(EMP(), `SELECT * FROM app_find_or_create_candidate_profile('x@example.test', 'X', null, null, null, null, null, null, null)`)).error).toMatch(/not allowed/);
  });

  it("gives HR Managers their own organisation's recruitment data, and nothing of another organisation", async () => {
    for (const t of ["job_openings", "applications", "application_notes", "application_assignments", "candidate_documents", "organization_candidates"]) {
      expect(await count(HR(), t, inOrgs()), t).toBe(t === "job_openings" ? 2 : 1);
      expect(await count(HR(), t, `organization_id = '${f.orgB}'`), `${t} in B`).toBe(0);
    }
    // Candidate profiles: only people who applied to THIS organisation.
    expect(await count(HR(), "candidate_profiles", `id IN ('${f.candA}', '${f.candBOnly}')`)).toBe(1);
    expect(await count(HR(), "organization_members", inOrgs())).toBe(4); // all of A's members, none of B's
    // Cannot write into another organisation, not even by naming it.
    expect((await as(HR(), `UPDATE applications SET stage = 'SHORTLISTED' WHERE id = $1`, [f.appB])).rowCount).toBe(0);
    expect((await as(HR(), `INSERT INTO application_notes (id, organization_id, application_id, body) VALUES (gen_random_uuid(), $1, $2, 'x')`, [f.orgB, f.appB])).error).toMatch(/row-level security/);
    // Can work in their own.
    expect((await as(HR(), `UPDATE applications SET stage = 'UNDER_REVIEW' WHERE id = $1`, [f.appA])).rowCount).toBe(1);
  });

  it("keeps Super Admin controls away from HR Managers", async () => {
    // Invitations: HR sees and creates Employee invitations only.
    const seen = await as<{ role_key: string }>(HR(), `SELECT role_key FROM staff_invitations ORDER BY role_key`);
    expect(seen.rows.map((r) => r.role_key)).toEqual(["EMPLOYEE"]);
    const inviteHr = await as(HR(), `INSERT INTO staff_invitations (id, organization_id, email, name, role_key, token_hash, expires_at) VALUES (gen_random_uuid(), $1, 'hrx@example.test', 'X', 'HR_MANAGER', 'h1', now() + interval '1 day')`, [f.orgA]);
    expect(inviteHr.error).toMatch(/row-level security/);
    const inviteEmp = await as(HR(), `INSERT INTO staff_invitations (id, organization_id, email, name, role_key, token_hash, expires_at) VALUES (gen_random_uuid(), $1, 'empx@example.test', 'X', 'EMPLOYEE', 'h2', now() + interval '1 day')`, [f.orgA]);
    expect(inviteEmp.error).toBeUndefined();
    // Audit log and system integrations: Super Admin only.
    const hrAudit = await asMany<{ n: number }>(HR(), [addAudit(f.hr), `SELECT count(*)::int AS n FROM audit_logs WHERE action = 'rls.test'`]);
    expect(hrAudit.error).toBeUndefined(); // HR may ADD audit records (their own organisation, themselves as the actor)...
    expect(hrAudit.rows[0]?.n).toBe(0); // ...but not read them
    // ...and nobody can add one for another organisation, or in somebody else's name.
    expect((await as(HR(), addAudit(f.hr, f.orgB))).error).toMatch(/row-level security/);
    expect((await as(HR(), addAudit(f.sa))).error).toMatch(/row-level security/);
    expect((await as(SA(), addAudit(f.sa, f.orgB))).error).toMatch(/row-level security/);
    const apiClient = `INSERT INTO api_clients (id, organization_id, name, key_prefix, key_hash, scopes) VALUES (gen_random_uuid(), $1, 'x', 'x', md5(random()::text), '{}')`;
    expect((await as(HR(), apiClient, [f.orgA])).error).toMatch(/row-level security/);
    expect((await as(SA(), apiClient, [f.orgA])).error).toBeUndefined();
    // The Super Admin sees both invitations and only their own organisation's audit records.
    expect(await count(SA(), "staff_invitations")).toBe(2);
    const audit = await asMany<{ organization_id: string }>(SA(), [addAudit(f.sa), `SELECT DISTINCT organization_id FROM audit_logs WHERE action = 'rls.test'`]);
    expect(audit.rows.map((r) => r.organization_id)).toEqual([f.orgA]); // never organisation B's
  });

  it("decides the role from the database, so a forged or stale identity gets nothing", async () => {
    // The right user but another organisation (not a member there).
    expect(await count({ mode: "staff", user: f.hr, org: f.orgB }, "applications")).toBe(0);
    // A suspended HR Manager.
    expect(await count({ mode: "staff", user: f.hrSuspended, org: f.orgA }, "applications")).toBe(0);
    // A user id and organisation simply STATED by the caller (how it worked before): not read at all any more.
    expect(await count({ mode: "forged", settings: { "app.mode": "staff", "app.user_id": f.sa, "app.org_id": f.orgA } }, "applications")).toBe(0);
    // A made-up session token.
    expect(await count({ mode: "forged", settings: { "app.mode": "staff", "app.session_token": "x".repeat(43) } }, "applications")).toBe(0);
    // A real token together with a stated organisation: the stated organisation is ignored.
    const saToken = await pgSessionToken(owner, f.sa, f.orgA);
    expect(await count({ mode: "forged", settings: { "app.mode": "staff", "app.session_token": saToken, "app.org_id": f.orgB } }, "applications", inOrgs())).toBe(1);
    expect((await as<{ organization_id: string }>({ mode: "forged", settings: { "app.mode": "staff", "app.session_token": saToken, "app.org_id": f.orgB } }, `SELECT organization_id FROM applications`)).rows.map((r) => r.organization_id)).toEqual([f.orgA]);
    // A disabled user account loses access immediately.
    await owner.query(`UPDATE users SET status = 'DISABLED' WHERE id = $1`, [f.hr]);
    try {
      expect(await count(HR(), "applications")).toBe(0);
    } finally {
      await owner.query(`UPDATE users SET status = 'ACTIVE' WHERE id = $1`, [f.hr]);
    }
  });

  it("lets the public careers form read only published public jobs, and nothing else", async () => {
    const pub: Who = { mode: "public_apply" };
    const jobs = await as<{ id: string }>(pub, `SELECT id FROM job_openings WHERE ${inOrgs()}`);
    expect(jobs.rows.map((j) => j.id).sort()).toEqual([f.jobA, f.jobB].sort()); // not the draft
    for (const t of ["applications", "application_notes", "application_assignments", "organization_candidates", "candidate_documents", "candidate_profiles", "staff_invitations", "audit_logs", "organization_members"]) {
      expect(await count(pub, t), t).toBe(0);
    }
    expect((await as(pub, `SELECT * FROM app_find_or_create_candidate_profile('p@example.test', 'P', null, null, null, null, null, null, null)`)).error).toMatch(/not allowed/);
  });

  it("gives the public careers form no access to candidate or application data, only one narrow function", async () => {
    const pubA: Who = { mode: "public_apply", org: f.orgA };
    // Narrowed to an organisation or not, it reads nothing of anyone's applications, candidates or documents...
    for (const t of ["applications", "application_status_history", "application_notes", "application_assignments", "organization_candidates", "candidate_documents", "candidate_profiles"]) {
      expect(await count(pubA, t), t).toBe(0);
    }
    // ...cannot list organisations (their owner and settings), only ask about one web address...
    expect(await count(pubA, "organizations")).toBe(0);
    const org = await as<Record<string, unknown>>(pubA, `SELECT * FROM app_public_organization($1)`, [`rls-a-${tag}`]);
    expect(org.rows).toEqual([{ id: f.orgA, name: `rls-a-${tag}`, slug: `rls-a-${tag}`, timezone: expect.any(String) }]);
    expect((await as(HR(), `SELECT * FROM app_public_organization($1)`, [`rls-a-${tag}`])).rows).toEqual([]); // public pages only
    // ...and cannot write to those tables directly, however well-formed the row.
    expect((await as(pubA, `INSERT INTO applications (id, organization_id, reference_number, organization_candidate_id, job_id, consent_accepted_at, updated_at)
                             VALUES (gen_random_uuid(), $1, $2, $3, $4, now(), now())`, [f.orgA, `RLS-P-${rnd()}`, f.ocA, f.jobA])).error).toMatch(/row-level security/);
    expect((await as(pubA, `UPDATE applications SET stage = 'SELECTED' WHERE id = $1`, [f.appA])).rowCount).toBe(0);
    expect((await as(pubA, `UPDATE organization_candidates SET notes = 'x'`)).rowCount).toBe(0);
    expect((await as(pubA, `INSERT INTO application_status_history (id, organization_id, application_id, from_stage, to_stage) VALUES (gen_random_uuid(), $1, $2, 'APPLIED', 'SELECTED')`, [f.orgA, f.appA])).error).toMatch(/row-level security/);
    expect((await as(pubA, `INSERT INTO candidate_documents (id, candidate_id, organization_id, application_id, kind, original_name, storage_key, mime_type, size_bytes, sha256) VALUES (gen_random_uuid(), $1, $2, $3, 'RESUME', 'x.pdf', 'k', 'application/pdf', 1, 'x')`, [f.candA, f.orgA, f.appA])).error).toMatch(/row-level security/);
    // It cannot add audit records of its own either.
    expect((await as(pubA, `INSERT INTO audit_logs (id, organization_id, action, entity_type) VALUES (gen_random_uuid(), $1, 'application.submitted', 'application')`, [f.orgA])).error).toMatch(/row-level security/);
  });

  // The whole public submission, the way the app calls it. Always rolled back by as().
  const submit = (who: Who, job: string, email: string, ref = `RLS-S-${rnd()}`) =>
    as<{ application_id: string; reference_number: string; candidate_was_known: boolean }>(who,
      `SELECT * FROM app_submit_public_application($1::uuid, $2, $3, 'New Person', NULL, 'Indore', NULL, NULL, '{"institution":"DAVV","graduationYear":2025}'::jsonb, NULL,
         ARRAY['Espresso','espresso'], 'careers_page', '{}'::jsonb, '2026-11', now(), 'cv.pdf', $4, 'application/pdf', 10, 'abc', '203.0.113.5', 'vitest')`,
      [job, ref, email, `resumes/2026/${rnd()}`]);

  it("saves a public application only through that function, only to an open public job of the organisation it was narrowed to", async () => {
    const pubA: Who = { mode: "public_apply", org: f.orgA };
    const fresh = `rls-new-${tag}@example.test`;
    // A new person: the application, its first history row, the resume record and the audit record, in one step.
    await rt.query("BEGIN");
    try {
      await rt.query(`SELECT set_config('app.mode', 'public_apply', true), set_config('app.org_id', $1, true)`, [f.orgA]);
      const r = (await rt.query(`SELECT * FROM app_submit_public_application($1::uuid, $2, $3, 'New Person', NULL, 'Indore', NULL, NULL, NULL, NULL, ARRAY['Espresso','espresso'], 'careers_page', '{}'::jsonb, '2026-11', now(), 'cv.pdf', $4, 'application/pdf', 10, 'abc', '203.0.113.5', 'vitest')`,
        [f.jobA, `RLS-NEW-${tag}`, fresh, `resumes/2026/new-${tag}`])).rows[0];
      expect(r).toMatchObject({ reference_number: `RLS-NEW-${tag}`, candidate_was_known: false });
      // The caller got only the id and reference back, and still cannot read what was saved.
      expect((await rt.query(`SELECT count(*)::int AS n FROM applications`)).rows[0].n).toBe(0);
      // Seen by an HR Manager of that organisation (same transaction): a fresh, unassigned 'Applied' application.
      await rt.query(`SELECT set_config('app.mode', 'staff', true), set_config('app.session_token', $1, true), set_config('app.org_id', '', true)`, [await pgSessionToken(owner, f.hr, f.orgA)]);
      const saved = (await rt.query(`SELECT a.stage, a.assigned_recruiter_id, a.created_by_id,
          (SELECT count(*)::int FROM application_status_history h WHERE h.application_id = a.id AND h.from_stage IS NULL AND h.to_stage = 'APPLIED' AND h.changed_by_id IS NULL) AS history,
          (SELECT count(*)::int FROM candidate_documents d WHERE d.application_id = a.id AND d.kind = 'RESUME') AS docs
        FROM applications a WHERE a.id = $1`, [r.application_id])).rows[0];
      expect(saved).toEqual({ stage: "APPLIED", assigned_recruiter_id: null, created_by_id: null, history: 1, docs: 1 });
      // The audit record was written by the database itself (visible to the Super Admin).
      await rt.query(`SELECT set_config('app.session_token', $1, true)`, [await pgSessionToken(owner, f.sa, f.orgA)]);
      const audit = (await rt.query(`SELECT actor_user_id, entity_id, metadata FROM audit_logs WHERE action = 'application.submitted' AND entity_id = $1`, [r.application_id])).rows;
      expect(audit).toEqual([{ actor_user_id: null, entity_id: r.application_id, metadata: { reference: `RLS-NEW-${tag}`, jobId: f.jobA, knownCandidate: false, hasResume: true } }]);
    } finally {
      await rt.query("ROLLBACK");
    }
    // The same email again for the same job: refused, without revealing the existing application.
    const known = await submit(pubA, f.jobA, `rls-cand-a-${tag}@example.test`);
    expect(known.error).toMatch(/duplicate_application/);
    expect(known.error).not.toContain(`RLS-A-${tag}`);
    // Not to a draft job, not to another organisation's job, not without an organisation, not as staff.
    expect((await submit(pubA, f.jobADraft, fresh)).error).toMatch(/job_closed/);
    expect((await submit(pubA, f.jobB, fresh)).error).toMatch(/job_closed/);
    expect((await submit({ mode: "public_apply" }, f.jobA, fresh)).error).toMatch(/job_closed/);
    expect((await submit(HR(), f.jobA, fresh)).error).toMatch(/not allowed/);
    expect((await submit({ mode: "none" }, f.jobA, fresh)).error).toMatch(/not allowed/);
    // A job whose deadline has passed (by the database's own clock) is closed.
    await owner.query(`UPDATE job_openings SET application_deadline = now() - interval '1 minute' WHERE id = $1`, [f.jobA]);
    try {
      expect((await submit(pubA, f.jobA, fresh)).error).toMatch(/job_closed/);
    } finally {
      await owner.query(`UPDATE job_openings SET application_deadline = NULL WHERE id = $1`, [f.jobA]);
    }
  });

  it("matches a known email to its profile without revealing it, never changes it, and only for HR staff directly", async () => {
    const pubA: Who = { mode: "public_apply", org: f.orgA };
    // The public form cannot call the profile function on its own any more (only through the submission).
    expect((await as(pubA, `SELECT * FROM app_find_or_create_candidate_profile($1, 'Someone Else', NULL, NULL, NULL, NULL, NULL, NULL, NULL)`, [`rls-cand-b-${tag}@example.test`])).error).toMatch(/not allowed/);
    expect((await as(pubA, `SELECT * FROM app_candidate_profile_internal($1, 'Someone Else', NULL, NULL, NULL, NULL, NULL, NULL, NULL)`, [`rls-cand-b-${tag}@example.test`])).error).toMatch(/permission denied/);
    expect((await as(EMP(), `SELECT * FROM app_find_or_create_candidate_profile($1, 'Someone Else', NULL, NULL, NULL, NULL, NULL, NULL, NULL)`, [`rls-cand-b-${tag}@example.test`])).error).toMatch(/not allowed/);
    // HR staff (entering an application by hand): a person known to ANOTHER organisation is matched by email.
    const known = await as<{ id: string; created: boolean }>(HR(), `SELECT * FROM app_find_or_create_candidate_profile($1, 'Someone Else', '+911111111111', NULL, NULL, NULL, NULL, NULL, NULL)`, [`rls-cand-b-${tag}@example.test`]);
    expect(known.rows).toEqual([{ id: f.candBOnly, created: false }]);
    // Only the id came back; the profile itself is still unreadable from here, and its name is unchanged.
    expect(await count(HR(), "candidate_profiles", `id = '${f.candBOnly}'`)).toBe(0);
    expect((await owner.query(`SELECT full_name FROM candidate_profiles WHERE id = $1`, [f.candBOnly])).rows[0].full_name).toBe(`rls-cand-b-${tag}@example.test`);
    expect((await as(HR(), `SELECT * FROM app_find_or_create_candidate_profile('Not.Lower@Example.test', 'X', NULL, NULL, NULL, NULL, NULL, NULL, NULL)`)).error).toMatch(/normalised/);
  });
});

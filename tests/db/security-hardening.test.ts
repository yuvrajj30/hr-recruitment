// What the app's restricted database account (hr_runtime) can NOT do, even with full control of its SQL:
// the findings of the 2026-11-15 security review, each tried for real against the DISPOSABLE test database.
// Fixtures are created with the owner account; every attempt as hr_runtime runs in a rolled-back transaction.
import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateSessionToken, hashToken } from "@/lib/security/tokens";
import { pgSessionToken } from "./session-helper";

const ownerUrl = process.env.TEST_OWNER_URL;
const runtimeUrl = process.env.TEST_RUNTIME_URL;
const isTestDb = (u?: string) => Boolean(u && /_test\b/.test(new URL(u).pathname));
const enabled = isTestDb(ownerUrl) && isTestDb(runtimeUrl);
const rnd = () => randomBytes(4).toString("hex");
const PASSWORD = "Correct-Horse-77 ünï";

// Functions that run with the owner's rights, and whether the app account may call each one. A new function
// of this kind fails the first test until it is added here on purpose.
const DEFINER_FUNCTIONS: Record<string, boolean> = {
  // called by row-level security policies and trigger conditions
  app_session_identity: true, app_staff_role: true, app_member_in_my_org: true, app_member_is_me: true, app_member_role_key: true,
  member_is_super_admin: true, role_is_super_admin: true,
  app_feedback_visible: true, // interview feedback independence (20261118000000_interviews_feedback)
  // called by the application
  app_public_organization: true, app_find_or_create_candidate_profile: true, app_submit_public_application: true,
  app_sign_in: true, app_my_password_matches: true, app_change_my_password: true, app_invitation_lookup: true, app_accept_invitation: true,
  app_remove_candidate: true,
  // shared public-application limit and the retention job (20261120000000_shared_limits_and_retention)
  app_my_employee_id: true, // employee self-service (20261121000000_employee_management)
  app_public_apply_allowed: true, app_remove_due_candidates: true, app_pending_file_removals: true, app_confirm_file_removed: true,
  // attendance (20261122000000_attendance_shifts, 20261122000100_attendance_records): the only way to write attendance
  app_has_permission: true, app_clock_in: true, app_clock_out: true, app_break: true, app_request_attendance_correction: true,
  app_withdraw_attendance_correction: true, app_hr_record_attendance: true, app_hr_correct_attendance: true, app_hr_void_attendance: true,
  app_decide_attendance_correction: true, app_remove_old_attendance_device_data: true,
  att_org_timezone: false, guard_shift: false,
  // standard shifts and shift history (20261122000400_standard_shifts_and_shift_history)
  app_apply_standard_shifts: true, app_generate_standard_shifts: true, guard_shift_pattern: false, record_shift_change: false,
  // leave (20261123000000_leave, 20261123000100_leave_functions): the only way to write requests and the ledger
  app_request_leave: true, app_withdraw_leave: true, app_decide_leave: true, app_hr_record_leave: true, app_cancel_leave: true,
  app_adjust_leave: true, app_leave_preview: true, app_leave_housekeeping: true, app_who_is_off: true, seed_leave_types_for_new_org: false,
  // internal only
  app_remove_candidate_core: false, guard_application_candidate_removed: false, guard_employee_manager: false, record_employee_assignment: false, guard_employee_status: false, close_employee_assignment: false, app_candidate_profile_internal: false, app_password_matches: false, app_invitation_sender_ok: false, org_active_super_admins: false,
  guard_last_super_admin: false, guard_owner_is_super_admin: false, guard_session_changes: false, check_application_document_owner: false,
  guard_interview_changes: false, guard_interview_participants: false, guard_interview_feedback: false, guard_hiring_decisions: false, interview_candidate_removed: false,
};

describe.skipIf(!enabled)("security hardening: what the app's database account cannot do (test database)", () => {
  let owner: Client;
  let rt: Client;
  const f: Record<string, string> = {};
  const tag = rnd();
  const auditIds: string[] = [];

  beforeAll(async () => {
    owner = new Client({ connectionString: ownerUrl, options: "-c TimeZone=UTC" });
    rt = new Client({ connectionString: runtimeUrl, options: "-c TimeZone=UTC" });
    await owner.connect();
    await rt.connect();
    const one = async (sql: string, params: unknown[] = []) => (await owner.query(sql, params)).rows[0];
    const role = async (key: string) => (await one(`SELECT id FROM roles WHERE key = $1`, [key])).id as string;
    const R = { SA: await role("SUPER_ADMIN"), HR: await role("HR_MANAGER"), EMP: await role("EMPLOYEE") };
    const hash = bcrypt.hashSync(PASSWORD, 4); // "$2b$": what the application has always stored
    const user = async (name: string, passwordHash: string | null = hash) =>
      (await one(`INSERT INTO users (id, email, name, password_hash, updated_at) VALUES (gen_random_uuid(), $1, $2, $3, now()) RETURNING id`, [`sec-${name}-${tag}@example.test`, name, passwordHash])).id as string;
    const org = async (slug: string, ownerId: string) =>
      (await one(`INSERT INTO organizations (id, slug, name, owner_user_id, updated_at) VALUES (gen_random_uuid(), $1, $1, $2, now()) RETURNING id`, [`sec-${slug}-${tag}`, ownerId])).id as string;
    const member = async (o: string, u: string, r: string, status = "ACTIVE") => {
      const m = (await one(`INSERT INTO organization_members (id, organization_id, user_id, status, updated_at) VALUES (gen_random_uuid(), $1, $2, $3, now()) RETURNING id`, [o, u, status])).id as string;
      await owner.query(`INSERT INTO organization_member_roles (member_id, role_id) VALUES ($1, $2)`, [m, r]);
      return m;
    };
    f.sa = await user("sa"); f.hr = await user("hr"); f.emp = await user("emp"); f.saB = await user("sab");
    f.orgA = await org("a", f.sa);
    f.orgB = await org("b", f.saB);
    f.mSa = await member(f.orgA, f.sa, R.SA);
    f.mHr = await member(f.orgA, f.hr, R.HR);
    f.mEmp = await member(f.orgA, f.emp, R.EMP);
    f.mSaB = await member(f.orgB, f.saB, R.SA);
    // One audit row per organisation, each with a correction note (as the timestamp correction would add).
    for (const o of [f.orgA, f.orgB]) {
      const id = (await one(`INSERT INTO audit_logs (id, organization_id, action, entity_type) VALUES (gen_random_uuid(), $1, 'sec.test', 'test') RETURNING id`, [o])).id as string;
      auditIds.push(id);
      await owner.query(`INSERT INTO audit_log_time_corrections (audit_log_id, shift) VALUES ($1, interval '5 hours 30 minutes')`, [id]);
    }
    const type = (await one(`SELECT (enum_range(NULL::"NotificationType"))[1]::text AS t`)).t as string;
    f.note = (await one(`INSERT INTO notifications (id, organization_id, type, recipient_user_id, subject, body) VALUES (gen_random_uuid(), $1, $2::"NotificationType", $3, 'Hello', 'Original text') RETURNING id`, [f.orgA, type, f.emp])).id;
    f.noteHr = (await one(`INSERT INTO notifications (id, organization_id, type, recipient_user_id, subject, body) VALUES (gen_random_uuid(), $1, $2::"NotificationType", $3, 'For HR', 'x') RETURNING id`, [f.orgA, type, f.hr])).id;
  }, 60000);

  afterAll(async () => {
    if (owner && f.orgA) {
      const orgs = [f.orgA, f.orgB];
      const users = [f.sa, f.hr, f.emp, f.saB];
      await owner.query("BEGIN");
      // The audit log and its correction notes are append-only for everyone: lifted for this clean-up only.
      await owner.query(`ALTER TABLE audit_log_time_corrections DISABLE TRIGGER audit_log_time_corrections_append_only`);
      await owner.query(`ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_append_only`);
      await owner.query(`DELETE FROM audit_log_time_corrections WHERE audit_log_id IN (SELECT id FROM audit_logs WHERE organization_id = ANY($1))`, [orgs]);
      await owner.query(`DELETE FROM audit_logs WHERE organization_id = ANY($1)`, [orgs]);
      await owner.query(`ALTER TABLE audit_logs ENABLE TRIGGER audit_logs_append_only`);
      await owner.query(`ALTER TABLE audit_log_time_corrections ENABLE TRIGGER audit_log_time_corrections_append_only`);
      await owner.query("COMMIT");
      await owner.query(`DELETE FROM notifications WHERE organization_id = ANY($1)`, [orgs]);
      await owner.query(`DELETE FROM sessions WHERE user_id = ANY($1)`, [users]);
      await owner.query(`DELETE FROM organization_members WHERE organization_id = ANY($1)`, [orgs]);
      await owner.query(`DELETE FROM organizations WHERE id = ANY($1)`, [orgs]);
      await owner.query(`DELETE FROM users WHERE email LIKE $1`, [`sec-%-${tag}@example.test`]);
    }
    await owner?.end();
    await rt?.end();
  });

  type Ctx = Record<string, string>;
  const staff = async (user: string, org = f.orgA): Promise<Ctx> => ({ "app.mode": "staff", "app.session_token": await pgSessionToken(owner, user, org) });
  // Runs statements as the app account with the given settings; returns the last result; always rolled back.
  async function as<T = Record<string, unknown>>(ctx: Ctx, sql: string, params: unknown[] = []): Promise<{ rows: T[]; rowCount: number; error?: string }> {
    await rt.query("BEGIN");
    try {
      for (const [k, v] of Object.entries(ctx)) await rt.query(`SELECT set_config($1, $2, true)`, [k, v]);
      const r = await rt.query(sql, params);
      await rt.query("SET CONSTRAINTS ALL IMMEDIATE");
      return { rows: r.rows as T[], rowCount: r.rowCount ?? 0 };
    } catch (e) {
      return { rows: [], rowCount: 0, error: (e as Error).message };
    } finally {
      await rt.query("ROLLBACK");
    }
  }
  const NONE: Ctx = {};
  // A fresh session row made by the owner, with chosen deadlines; returns its raw token and id.
  async function session(user: string, org: string, opts: { expires?: string; absolute?: string; revoked?: boolean } = {}) {
    const token = generateSessionToken();
    const id = (await owner.query(
      `INSERT INTO sessions (id, user_id, active_organization_id, token_hash, expires_at, absolute_expires_at, last_seen_at, created_at, revoked_at, revoked_reason)
       VALUES (gen_random_uuid(), $1, $2, $3, now() + $4::interval, now() + $5::interval, now(), now() - interval '13 hours', $6, $7) RETURNING id`,
      [user, org, hashToken(token), opts.expires ?? "1 hour", opts.absolute ?? "12 hours", opts.revoked ? new Date() : null, opts.revoked ? "logout" : null],
    )).rows[0].id as string;
    return { token, id };
  }
  const signIn = (email: string, password: string, tokenHash = hashToken(generateSessionToken())) =>
    as<{ session_id: string; user_id: string; organization_id: string }>(NONE,
      `SELECT session_id, user_id, organization_id FROM app_sign_in($1, $2, $3, now() + interval '1 hour', now() + interval '12 hours', now(), '203.0.113.5', 'vitest')`, [email, password, tokenHash]);
  const email = (name: string) => `sec-${name}-${tag}@example.test`;

  // -------------------------------------------------------------------------
  it("runs every owner's-rights function with temporary tables searched last, and opens none of them to everyone", async () => {
    const rows = (await owner.query(`
      SELECT p.proname, p.proconfig, pg_get_userbyid(p.proowner) AS owner,
             has_function_privilege('public', p.oid, 'EXECUTE') AS everyone, has_function_privilege('hr_runtime', p.oid, 'EXECUTE') AS runtime
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.prosecdef
        AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')`)).rows;
    expect(rows.map((r) => r.proname).sort()).toEqual(Object.keys(DEFINER_FUNCTIONS).sort());
    for (const r of rows) {
      expect(r.proconfig, r.proname).toEqual(["search_path=pg_catalog, public, pg_temp"]);
      expect(r.owner, r.proname).toBe("hr_app");
      expect(r.everyone, r.proname).toBe(false);
      expect(r.runtime, r.proname).toBe(DEFINER_FUNCTIONS[r.proname]);
    }
  });

  it("cannot stand a temporary table in for a real one (the route to a made-up Super Admin)", async () => {
    expect((await owner.query(`SELECT has_database_privilege('hr_runtime', current_database(), 'TEMP') AS v`)).rows[0].v).toBe(false);
    const r = await as({ "app.mode": "staff" }, `CREATE TEMP TABLE organization_members (id uuid, organization_id uuid, user_id uuid, status text)`);
    expect(r.error).toMatch(/permission denied/);
  });

  it("cannot change anything about members, roles or organisations before someone is signed in", async () => {
    // Reading stays possible (sign-in needs it); every write finds no row it may touch, or is refused outright.
    expect(Number((await as<{ n: number }>(NONE, `SELECT count(*)::int AS n FROM organization_members WHERE organization_id = $1`, [f.orgB])).rows[0].n)).toBe(1);
    expect((await as(NONE, `UPDATE organization_members SET status = 'SUSPENDED' WHERE organization_id = $1`, [f.orgB])).rowCount).toBe(0);
    expect((await as(NONE, `UPDATE organization_member_roles SET role_id = (SELECT id FROM roles WHERE key = 'SUPER_ADMIN') WHERE member_id = $1`, [f.mEmp])).rowCount).toBe(0);
    expect((await as(NONE, `UPDATE organizations SET owner_user_id = $1 WHERE id = $2`, [f.emp, f.orgA])).rowCount).toBe(0);
    for (const sql of [
      `INSERT INTO organization_members (id, organization_id, user_id, status, updated_at) VALUES (gen_random_uuid(), '${f.orgB}', '${f.emp}', 'ACTIVE', now())`,
      `INSERT INTO organization_member_roles (member_id, role_id) SELECT '${f.mEmp}', id FROM roles WHERE key = 'SUPER_ADMIN'`,
      `DELETE FROM organization_member_roles WHERE member_id = '${f.mSaB}'`,
      `DELETE FROM organization_members WHERE id = '${f.mSaB}'`,
      `DELETE FROM organizations WHERE id = '${f.orgB}'`,
    ]) {
      expect((await as(NONE, sql)).error, sql).toMatch(/permission denied/);
      expect((await as(await staff(f.sa), sql)).error, sql).toMatch(/permission denied/); // not even as a Super Admin: no such right at all
    }
  });

  it("recognises only a live session: not a revoked one, not an expired one, not one past its hard deadline", async () => {
    const live = await session(f.hr, f.orgA);
    const revoked = await session(f.hr, f.orgA, { revoked: true });
    const idle = await session(f.hr, f.orgA, { expires: "-1 minute" });
    const hard = await session(f.hr, f.orgA, { expires: "-2 minutes", absolute: "-1 minute" });
    const role = async (token: string) => (await as<{ r: string | null }>({ "app.mode": "staff", "app.session_token": token }, `SELECT app_staff_role() AS r`)).rows[0]?.r;
    expect(await role(live.token)).toBe("HR_MANAGER");
    expect(await role(revoked.token)).toBeNull();
    expect(await role(idle.token)).toBeNull();
    expect(await role(hard.token)).toBeNull();
    expect(await role(hashToken(live.token))).toBeNull(); // the stored fingerprint is not the token
    // Ending a session takes effect on the very next statement.
    await owner.query(`UPDATE sessions SET revoked_at = now(), revoked_reason = 'logout' WHERE id = $1`, [live.id]);
    expect(await role(live.token)).toBeNull();
    // Without 'staff' mode the token means nothing.
    expect((await as<{ r: string | null }>({ "app.session_token": (await session(f.hr, f.orgA)).token }, `SELECT app_staff_role() AS r`)).rows[0].r).toBeNull();
  });

  it("cannot create a session, move one to another person, or bring an ended one back", async () => {
    const mine = await session(f.emp, f.orgA);
    const ended = await session(f.emp, f.orgA, { revoked: true });
    const stale = await session(f.emp, f.orgA, { expires: "-1 minute" });
    const insert = `INSERT INTO sessions (id, user_id, active_organization_id, token_hash, expires_at, absolute_expires_at) VALUES (gen_random_uuid(), '${f.sa}', '${f.orgA}', '${"b".repeat(64)}', now() + interval '1 hour', now() + interval '12 hours')`;
    expect((await as(NONE, insert)).error).toMatch(/permission denied/);
    expect((await as(await staff(f.sa), insert)).error).toMatch(/permission denied/);
    expect((await as(NONE, `UPDATE sessions SET user_id = $1 WHERE id = $2`, [f.sa, mine.id])).error).toMatch(/permission denied/);
    expect((await as(NONE, `UPDATE sessions SET token_hash = $1 WHERE id = $2`, ["c".repeat(64), mine.id])).error).toMatch(/permission denied/);
    expect((await as(NONE, `UPDATE sessions SET absolute_expires_at = now() + interval '30 days' WHERE id = $1`, [mine.id])).error).toMatch(/permission denied/);
    expect((await as(NONE, `UPDATE sessions SET revoked_at = NULL, revoked_reason = NULL WHERE id = $1`, [ended.id])).error).toMatch(/ended session cannot be changed/);
    expect((await as(NONE, `UPDATE sessions SET expires_at = absolute_expires_at + interval '1 hour' WHERE id = $1`, [mine.id])).error).toMatch(/hard deadline|sessions_idle_not_after_absolute/);
    // Switching a session into an organisation the person does not belong to.
    expect((await as(NONE, `UPDATE sessions SET active_organization_id = $1 WHERE id = $2`, [f.orgB, mine.id])).error).toMatch(/not an active member/);
    // What the application legitimately does still works: keep alive, end, tidy up ended ones.
    expect((await as(NONE, `UPDATE sessions SET last_seen_at = now(), expires_at = now() + interval '30 minutes' WHERE id = $1`, [mine.id])).rowCount).toBe(1);
    expect((await as(NONE, `UPDATE sessions SET revoked_at = now(), revoked_reason = 'logout' WHERE id = $1`, [mine.id])).rowCount).toBe(1);
    expect((await as(NONE, `DELETE FROM sessions WHERE id = ANY($1)`, [[ended.id, stale.id]])).rowCount).toBe(2);
    expect((await as(NONE, `DELETE FROM sessions WHERE id = $1`, [mine.id])).error).toMatch(/only ended sessions/);
  });

  it("cannot read or write password hashes, and can change no account but the signed-in person's own name", async () => {
    expect((await as(NONE, `SELECT password_hash FROM users WHERE id = $1`, [f.sa])).error).toMatch(/permission denied/);
    expect((await as(NONE, `SELECT * FROM users WHERE id = $1`, [f.sa])).error).toMatch(/permission denied/);
    expect((await as<{ email: string }>(NONE, `SELECT id, email, name, status FROM users WHERE id = $1`, [f.sa])).rows[0].email).toBe(email("sa"));
    const mine = await staff(f.emp);
    for (const sql of [
      `UPDATE users SET password_hash = 'x' WHERE id = '${f.sa}'`,
      `UPDATE users SET password_hash = 'x' WHERE id = '${f.emp}'`,
      `UPDATE users SET email = 'x@example.test' WHERE id = '${f.emp}'`,
      `UPDATE users SET status = 'DISABLED' WHERE id = '${f.sa}'`,
      `UPDATE users SET is_platform_admin = true WHERE id = '${f.emp}'`,
      `INSERT INTO users (id, email, name, updated_at) VALUES (gen_random_uuid(), 'made-up-${tag}@example.test', 'X', now())`,
      `DELETE FROM users WHERE id = '${f.emp}'`,
    ]) {
      expect((await as(mine, sql)).error, sql).toMatch(/permission denied/);
    }
    expect((await as(mine, `UPDATE users SET name = 'Somebody Else' WHERE id = $1`, [f.sa])).error).toMatch(/only your own account/);
    expect((await as(NONE, `UPDATE users SET name = 'Nobody' WHERE id = $1`, [f.emp])).error).toMatch(/only your own account/);
    expect((await as(mine, `UPDATE users SET name = 'My New Name', updated_at = now() WHERE id = $1`, [f.emp])).rowCount).toBe(1);
  });

  it("signs in only with the right password, and every refusal looks the same", async () => {
    const good = await signIn(email("emp"), PASSWORD);
    expect(good.error).toBeUndefined();
    expect(good.rows[0]).toMatchObject({ user_id: f.emp, organization_id: f.orgA });
    expect((await signIn(`  ${email("emp").toUpperCase()} `, PASSWORD)).rows).toHaveLength(1); // spaces and capitals in the email
    const refusals = [
      await signIn(email("emp"), "Wrong-Password-1"),
      await signIn(`nobody-${tag}@example.test`, PASSWORD),
      await signIn(email("emp"), ""),
    ];
    // A disabled account, an account without a password, one with a damaged hash, one without an active workspace.
    const special = async (name: string, hash: string | null, status = "ACTIVE", membership = true) => {
      const id = (await owner.query(`INSERT INTO users (id, email, name, password_hash, status, updated_at) VALUES (gen_random_uuid(), $1, $2, $3, $4::"UserStatus", now()) RETURNING id`, [email(name), name, hash, status])).rows[0].id;
      if (membership) await owner.query(`INSERT INTO organization_members (id, organization_id, user_id, status, updated_at) VALUES (gen_random_uuid(), $1, $2, 'ACTIVE', now())`, [f.orgA, id]);
      return signIn(email(name), PASSWORD);
    };
    const real = bcrypt.hashSync(PASSWORD, 4);
    refusals.push(await special("disabled", real, "DISABLED"), await special("nopw", null), await special("badhash", "not-a-bcrypt-hash"), await special("nowork", real, "ACTIVE", false));
    for (const r of refusals) {
      expect(r.rows).toEqual([]);
      expect(r.error).toMatch(/invalid_credentials/);
      expect(r.error).not.toMatch(/salt|disabled|member|hash/i); // nothing about WHY
    }
    // An unknown email still costs a full password check (a throw-away hash), so timing does not give accounts away.
    const t0 = Date.now();
    await signIn(`nobody2-${tag}@example.test`, PASSWORD);
    expect(Date.now() - t0).toBeGreaterThan(40);
    // A malformed request never creates anything.
    expect((await signIn(email("emp"), PASSWORD, "not-a-fingerprint")).error).toMatch(/invalid_request/);
  });

  it("checks existing passwords (as stored by the application) and stores new ones the application can still read", async () => {
    const me = await session(f.hr, f.orgA);
    const other = await session(f.hr, f.orgA);
    const ctx = { "app.mode": "staff", "app.session_token": me.token };
    expect((await as<{ ok: boolean }>(ctx, `SELECT app_my_password_matches($1) AS ok`, [PASSWORD])).rows[0].ok).toBe(true);
    expect((await as<{ ok: boolean }>(ctx, `SELECT app_my_password_matches($1) AS ok`, ["Wrong-Password-1"])).rows[0].ok).toBe(false);
    expect((await as<{ ok: boolean }>(NONE, `SELECT app_my_password_matches($1) AS ok`, [PASSWORD])).rows[0].ok).toBe(false); // nobody signed in
    expect((await as(ctx, `SELECT app_change_my_password($1, $2, now())`, ["Wrong-Password-1", "Brand-New-Pass-88"])).error).toMatch(/wrong_password/);
    expect((await as(ctx, `SELECT app_change_my_password($1, $1, now())`, [PASSWORD])).error).toMatch(/same_password/);
    expect((await as(ctx, `SELECT app_change_my_password($1, 'short', now())`, [PASSWORD])).error).toMatch(/password_required/);
    expect((await as(NONE, `SELECT app_change_my_password($1, $2, now())`, [PASSWORD, "Brand-New-Pass-88"])).error).toMatch(/not allowed/);
    // The change itself, kept (committed) so the stored hash can be inspected; put back afterwards.
    await rt.query("BEGIN");
    await rt.query(`SELECT set_config('app.mode', 'staff', true), set_config('app.session_token', $1, true)`, [me.token]);
    const ended = (await rt.query(`SELECT app_change_my_password($1, $2, now()) AS n`, [PASSWORD, "Brand-New-Pass-88"])).rows[0].n;
    await rt.query("COMMIT");
    try {
      expect(ended).toBeGreaterThanOrEqual(1); // the other session(s) of this person
      const stored = (await owner.query(`SELECT password_hash FROM users WHERE id = $1`, [f.hr])).rows[0].password_hash as string;
      expect(stored).toMatch(/^\$2a\$12\$/);
      expect(bcrypt.compareSync("Brand-New-Pass-88", stored)).toBe(true); // the application's own library agrees
      const after = (await owner.query(`SELECT id, revoked_at IS NULL AS live, revoked_reason FROM sessions WHERE id = ANY($1)`, [[me.id, other.id]])).rows;
      expect(after.find((s) => s.id === me.id)).toMatchObject({ live: true });
      expect(after.find((s) => s.id === other.id)).toMatchObject({ live: false, revoked_reason: "password_changed" });
      expect((await signIn(email("hr"), "Brand-New-Pass-88")).rows).toHaveLength(1);
      expect((await signIn(email("hr"), PASSWORD)).error).toMatch(/invalid_credentials/);
    } finally {
      await owner.query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [bcrypt.hashSync(PASSWORD, 4), f.hr]);
    }
  });

  it("answers questions about members only for the caller's own organisation, and only to its HR staff", async () => {
    const key = async (ctx: Ctx, member: string) => (await as<{ r: string | null }>(ctx, `SELECT app_member_role_key($1) AS r`, [member])).rows[0]?.r;
    expect(await key(await staff(f.sa), f.mEmp)).toBe("EMPLOYEE");
    expect(await key(await staff(f.hr), f.mSa)).toBe("SUPER_ADMIN");
    expect(await key(await staff(f.sa), f.mSaB)).toBeNull(); // another organisation's member
    expect(await key(await staff(f.emp), f.mSa)).toBeNull(); // an Employee asking
    expect(await key(NONE, f.mSa)).toBeNull(); // nobody asking
    expect((await as<{ a: boolean; b: boolean }>(await staff(f.sa), `SELECT app_member_in_my_org($1) AS a, app_member_in_my_org($2) AS b`, [f.mEmp, f.mSaB])).rows[0]).toEqual({ a: true, b: false });
    expect((await as<{ a: boolean; b: boolean }>(await staff(f.sa), `SELECT app_member_is_me($1) AS a, app_member_is_me($2) AS b`, [f.mSa, f.mEmp])).rows[0]).toEqual({ a: true, b: false });
    // The old helpers that answered for any organisation are gone; internal ones cannot be called.
    expect((await as(NONE, `SELECT app_member_org($1)`, [f.mSaB])).error).toMatch(/does not exist/);
    expect((await as(NONE, `SELECT app_member_user($1)`, [f.mSaB])).error).toMatch(/does not exist/);
    expect((await as(NONE, `SELECT org_active_super_admins($1)`, [f.orgB])).error).toMatch(/permission denied/);
    expect((await as(NONE, `SELECT app_password_matches('x', 'y')`)).error).toMatch(/permission denied/);
    expect((await as(NONE, `SELECT app_invitation_sender_ok($1, $2, 'EMPLOYEE')`, [f.orgA, f.sa])).error).toMatch(/permission denied/);
    // The role rules they serve still hold: a Super Admin changes someone else's role, never their own, never elsewhere.
    const toHr = `UPDATE organization_member_roles SET role_id = (SELECT id FROM roles WHERE key = 'HR_MANAGER') WHERE member_id = $1`;
    expect((await as(await staff(f.sa), toHr, [f.mEmp])).rowCount).toBe(1);
    expect((await as(await staff(f.sa), toHr, [f.mSa])).rowCount).toBe(0);
    expect((await as(await staff(f.sa), toHr, [f.mSaB])).rowCount).toBe(0);
    expect((await as(await staff(f.hr), toHr, [f.mEmp])).rowCount).toBe(0);
  });

  it("lets a recipient mark their own notification as read, and change nothing else about it", async () => {
    const emp = await staff(f.emp);
    expect((await as(emp, `UPDATE notifications SET read_at = now() WHERE id = $1`, [f.note])).rowCount).toBe(1);
    expect((await as(emp, `UPDATE notifications SET body = 'Edited' WHERE id = $1`, [f.note])).error).toMatch(/only read_at may be changed/);
    expect((await as(emp, `UPDATE notifications SET subject = 'Edited', read_at = now() WHERE id = $1`, [f.note])).error).toMatch(/only read_at may be changed/);
    expect((await as(emp, `UPDATE notifications SET recipient_user_id = $1 WHERE id = $2`, [f.hr, f.note])).error).toMatch(/only read_at|row-level security/);
    expect((await as(emp, `UPDATE notifications SET read_at = now() WHERE id = $1`, [f.noteHr])).rowCount).toBe(0); // somebody else's
    expect((await as(emp, `DELETE FROM notifications WHERE id = $1`, [f.note])).rowCount).toBe(0);
    // A suspended member has no notifications to touch at all.
    await owner.query(`UPDATE organization_members SET status = 'SUSPENDED' WHERE id = $1`, [f.mEmp]);
    try {
      expect((await as(emp, `UPDATE notifications SET read_at = now() WHERE id = $1`, [f.note])).rowCount).toBe(0);
    } finally {
      await owner.query(`UPDATE organization_members SET status = 'ACTIVE' WHERE id = $1`, [f.mEmp]);
    }
    // HR staff manage their organisation's notifications as before.
    expect((await as(await staff(f.hr), `UPDATE notifications SET body = 'Corrected by HR' WHERE id = $1`, [f.note])).rowCount).toBe(1);
  });

  it("shows timestamp-correction notes only with the audit rows they belong to, and lets nobody add one", async () => {
    const notes = async (ctx: Ctx) => (await as<{ audit_log_id: string }>(ctx, `SELECT audit_log_id FROM audit_log_time_corrections WHERE audit_log_id = ANY($1)`, [auditIds])).rows.map((r) => r.audit_log_id);
    const [auditA, auditB] = auditIds as [string, string];
    expect(await notes(await staff(f.sa))).toEqual([auditA]); // own organisation only
    expect(await notes(await staff(f.saB, f.orgB))).toEqual([auditB]);
    for (const ctx of [NONE, await staff(f.hr), await staff(f.emp), { "app.mode": "public_apply", "app.org_id": f.orgA }]) expect(await notes(ctx)).toEqual([]);
    // The display view: the corrected time, and the same access rules as the audit log itself.
    const view = await as<{ id: string; shifted: boolean }>(await staff(f.sa), `SELECT id, display_created_at - created_at = interval '5 hours 30 minutes' AS shifted FROM audit_logs_display WHERE id = ANY($1)`, [auditIds]);
    expect(view.rows).toEqual([{ id: auditA, shifted: true }]);
    expect((await as(NONE, `SELECT count(*)::int AS n FROM audit_logs_display`)).rows[0]).toEqual({ n: 0 });
    // The run record is not for the app; nobody but the owner adds notes, and even the owner cannot change one.
    expect((await as(await staff(f.sa), `SELECT * FROM timestamp_corrections`)).error).toMatch(/permission denied/);
    expect((await as(await staff(f.sa), `INSERT INTO audit_log_time_corrections (audit_log_id, shift) SELECT id, interval '1 day' FROM audit_logs LIMIT 1`)).error).toMatch(/permission denied/);
    expect((await as(await staff(f.sa), `INSERT INTO timestamp_corrections (shift, description) VALUES (interval '1 day', 'x')`)).error).toMatch(/permission denied/);
    expect((await as(await staff(f.sa), `INSERT INTO audit_logs_display (id, action, entity_type) VALUES (gen_random_uuid(), 'x', 'x')`)).error).toMatch(/permission denied|cannot insert into view/);
    await owner.query("BEGIN");
    const tamper = await owner.query(`UPDATE audit_log_time_corrections SET shift = interval '0' WHERE audit_log_id = $1`, [auditA]).then(() => "", (e: Error) => e.message);
    await owner.query("ROLLBACK");
    expect(tamper).not.toBe("");
  });
});

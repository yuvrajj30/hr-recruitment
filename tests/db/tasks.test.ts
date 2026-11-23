// Tasks (CafeOS Milestone 4, Part 1): migrations 20261124000000_tasks and 20261124000100_task_functions, against the
// DISPOSABLE test database only. As the app's restricted account through real session tokens (row-level security and
// function rights apply), plus maintenance mode for the daily job.
// Plan: docs/superpowers/plans/2026-11-23-outlet-operations-part1-tasks.md.
import { randomBytes, randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db } from "@/lib/db";
import { realRoleIds } from "./roles-helper";
import { pgSessionToken, purgeTestAuditRows } from "./session-helper";

const ownerUrl = process.env.TEST_OWNER_URL;
const runtimeUrl = process.env.TEST_RUNTIME_URL;
const isTestDb = (u?: string) => Boolean(u && /_test\b/.test(new URL(u).pathname));
const enabled = isTestDb(ownerUrl) && isTestDb(runtimeUrl);
const rnd = () => randomBytes(4).toString("hex");
const TZ = "Asia/Kolkata";
type K = "a" | "b";
type Who = "sa" | "hr" | "emp" | "emp2";
type Emp = Who | "nologin";
type Result = { rows: Record<string, unknown>[]; error?: string };
const TABLES = ["tasks", "task_events", "task_submissions", "task_evidence", "task_resources", "task_reminders"];

describe.skipIf(!enabled)("tasks (test database)", { timeout: 90_000 }, () => {
  let owner: Db;
  let raw: Client;
  let rt: Client;
  const orgIds: string[] = [];
  const userIds: string[] = [];
  const w = {} as Record<K, { org: string; user: Record<Who, string>; member: Record<Who, string>; outlet: string; outlet2: string; e: Record<Emp, string> }>;
  let today = "";
  let roleIds: Record<string, string> = {};
  const day = (n: number) => (new Date(Date.parse(`${today}T00:00:00Z`) + n * 86_400_000)).toISOString().slice(0, 10);

  beforeAll(async () => {
    owner = createDb(ownerUrl!, { max: 2 });
    raw = new Client({ connectionString: ownerUrl, options: "-c TimeZone=UTC" });
    rt = new Client({ connectionString: runtimeUrl, options: "-c TimeZone=UTC" });
    await raw.connect();
    await rt.connect();
    today = (await raw.query(`SELECT (now() AT TIME ZONE $1)::date::text AS d`, [TZ])).rows[0].d;
    const role = await realRoleIds(owner);
    roleIds = role as unknown as Record<string, string>;
    const keyOf: Record<Who, "SUPER_ADMIN" | "HR_MANAGER" | "EMPLOYEE"> = { sa: "SUPER_ADMIN", hr: "HR_MANAGER", emp: "EMPLOYEE", emp2: "EMPLOYEE" };
    for (const k of ["a", "b"] as const) {
      const user = {} as Record<Who, string>;
      for (const who of ["sa", "hr", "emp", "emp2"] as const) {
        user[who] = (await owner.user.create({ data: { email: `${who}-${k}-${rnd()}@tasks.example.test`, name: `${who.toUpperCase()} ${k}` } })).id;
        userIds.push(user[who]);
      }
      const org = await owner.organization.create({ data: { slug: `tasks-${k}-${rnd()}${rnd()}`, name: `Tasks ${k}`, ownerUserId: user.sa, timezone: TZ } });
      orgIds.push(org.id);
      const member = {} as Record<Who, string>;
      for (const who of ["sa", "hr", "emp", "emp2"] as const) {
        member[who] = (await owner.organizationMember.create({ data: { organizationId: org.id, userId: user[who], status: "ACTIVE", joinedAt: new Date(), roles: { create: [{ roleId: role[keyOf[who]] }] } } })).id;
      }
      const outlet = (await raw.query(`INSERT INTO outlets (organization_id, name, updated_at) VALUES ($1, 'Main', now()) RETURNING id`, [org.id])).rows[0].id;
      const outlet2 = (await raw.query(`INSERT INTO outlets (organization_id, name, updated_at) VALUES ($1, 'Second', now()) RETURNING id`, [org.id])).rows[0].id;
      const e = {} as Record<Emp, string>;
      for (const who of ["sa", "hr", "emp", "emp2", "nologin"] as const) {
        e[who] = (await raw.query(`INSERT INTO employees (organization_id, employee_code, full_name, joined_on, outlet_id, member_id, updated_at)
          VALUES ($1, $2, $3, '2026-01-01', $4, $5, now()) RETURNING id`, [org.id, `TK-${who}-${rnd()}`.toUpperCase(), `Person ${who} ${k}`, outlet, who === "nologin" ? null : member[who]])).rows[0].id;
      }
      w[k] = { org: org.id, user, member, outlet, outlet2, e };
    }
  }, 90_000);

  afterAll(async () => {
    if (raw && orgIds.length) {
      for (const t of ["notifications", "task_reminders", "task_evidence", "task_resources", "task_submissions", "task_events", "tasks"]) {
        await raw.query(`DELETE FROM ${t} WHERE organization_id = ANY($1)`, [orgIds]).catch(() => undefined);
      }
      await raw.query(`DELETE FROM employees WHERE organization_id = ANY($1)`, [orgIds]);
      await raw.query(`DELETE FROM leave_types WHERE organization_id = ANY($1)`, [orgIds]).catch(() => undefined);
      await raw.query(`DELETE FROM outlets WHERE organization_id = ANY($1)`, [orgIds]);
      await owner.session.deleteMany({ where: { userId: { in: userIds } } });
      await owner.organizationMember.deleteMany({ where: { organizationId: { in: orgIds } } });
      await purgeTestAuditRows(owner, orgIds);
      await owner.organization.deleteMany({ where: { id: { in: orgIds } } });
      await owner.user.deleteMany({ where: { id: { in: userIds } } });
    }
    await owner?.$disconnect();
    await raw?.end();
    await rt?.end();
  });

  async function run(c: Client, k: K, who: Who | "public" | "maintenance", sql: string, params: unknown[] = []): Promise<Result> {
    await c.query("BEGIN");
    try {
      if (who === "public") await c.query(`SELECT set_config('app.mode', 'public_apply', true), set_config('app.org_id', $1, true)`, [w[k].org]);
      else if (who === "maintenance") await c.query(`SELECT set_config('app.mode', 'maintenance', true)`);
      else await c.query(`SELECT set_config('app.mode', 'staff', true), set_config('app.session_token', $1, true)`, [await pgSessionToken(raw, w[k].user[who], w[k].org)]);
      const r = await c.query(sql, params);
      await c.query("COMMIT");
      return { rows: r.rows };
    } catch (e) {
      await c.query("ROLLBACK");
      return { rows: [], error: (e as Error).message };
    }
  }
  const as = (k: K, who: Who | "public" | "maintenance", sql: string, params: unknown[] = []) => run(rt, k, who, sql, params);
  const ok = async (k: K, who: Who | "public" | "maintenance", sql: string, params: unknown[] = []) => {
    const r = await as(k, who, sql, params);
    expect(r.error, sql).toBeUndefined();
    return r.rows;
  };
  const rawError = (sql: string, params: unknown[] = []) => raw.query(sql, params).then(() => undefined, (e: Error) => e.message);
  // A task written directly by the owner account (schema tests only; the app writes through the functions).
  async function insertTask(k: K, owner: Emp, extra: Record<string, unknown> = {}) {
    const cols = { organization_id: w[k].org, outlet_id: w[k].outlet, owner_employee_id: w[k].e[owner], title: "Clean the coffee machine", description: "Descale and photograph it.",
      due_on: day(3), proof_kinds: "{PHOTO}", created_by_id: w[k].user.hr, ...extra };
    const names = Object.keys(cols);
    const r = await raw.query(`INSERT INTO tasks (${names.map((n) => `"${n}"`).join(", ")}) VALUES (${names.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING id`, Object.values(cols));
    return r.rows[0].id as string;
  }

  // ---------------------------------------------------------------------------
  // Task 1: schema, rights, row access
  // ---------------------------------------------------------------------------
  describe("tasks schema", () => {
    it("creates the task tables with row-level security, readable but never writable by the app", async () => {
      const rls = (await raw.query(`SELECT relname, relrowsecurity FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname = ANY($1) ORDER BY relname`, [TABLES])).rows;
      expect(rls).toEqual([...TABLES].sort().map((t) => ({ relname: t, relrowsecurity: true })));
      const rights = (await raw.query(`SELECT t, has_table_privilege('hr_runtime', t, 'SELECT') s, has_table_privilege('hr_runtime', t, 'INSERT') i,
          has_table_privilege('hr_runtime', t, 'UPDATE') u, has_table_privilege('hr_runtime', t, 'DELETE') d, has_table_privilege('hr_runtime', t, 'TRUNCATE') tr
        FROM unnest($1::text[]) t ORDER BY t`, [TABLES])).rows;
      for (const r of rights) expect(r, r.t as string).toMatchObject({ s: r.t !== "task_reminders", i: false, u: false, d: false, tr: false });
      const types = (await raw.query(`SELECT unnest(enum_range(NULL::"NotificationType"))::text v`)).rows.map((r) => r.v);
      expect(types).toEqual(expect.arrayContaining(["TASK_ASSIGNED", "TASK_SUBMITTED", "TASK_CHANGES_REQUESTED", "TASK_APPROVED", "TASK_CANCELLED", "TASK_DUE"]));
      expect((await raw.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'notifications' AND column_name = 'task_id'`)).rows).toHaveLength(1);
      const perms = (await raw.query(`SELECT p.key, string_agg(r.key, ',' ORDER BY r.key) roles FROM permissions p JOIN role_permissions rp ON rp.permission_id = p.id JOIN roles r ON r.id = rp.role_id
        WHERE p.key IN ('task:manage', 'self:task') GROUP BY p.key ORDER BY p.key`)).rows;
      expect(perms).toEqual([{ key: "self:task", roles: "EMPLOYEE,HR_MANAGER,SUPER_ADMIN" }, { key: "task:manage", roles: "HR_MANAGER,SUPER_ADMIN" }]);
    });

    it("refuses bad task values: no proof, long titles, repeated proof kinds, ratings outside 1-5 or before approval", async () => {
      expect(await rawError(`INSERT INTO tasks (organization_id, outlet_id, owner_employee_id, title, description, due_on, proof_kinds) VALUES ($1, $2, $3, 'T', 'D', $4, '{}')`, [w.a.org, w.a.outlet, w.a.e.emp, day(1)])).toMatch(/tasks_proof_check/);
      expect(await rawError(`INSERT INTO tasks (organization_id, outlet_id, owner_employee_id, title, description, due_on, proof_kinds) VALUES ($1, $2, $3, $4, 'D', $5, '{TEXT}')`, [w.a.org, w.a.outlet, w.a.e.emp, "x".repeat(121), day(1)])).toMatch(/tasks_text_check/);
      expect(await rawError(`INSERT INTO tasks (organization_id, outlet_id, owner_employee_id, title, description, due_on, proof_kinds) VALUES ($1, $2, $3, 'T', 'D', $4, '{TEXT,TEXT}')`, [w.a.org, w.a.outlet, w.a.e.emp, day(1)])).toMatch(/tasks_proof_check/);
      const id = await insertTask("a", "emp");
      expect(await rawError(`UPDATE tasks SET rating = 4 WHERE id = $1`, [id])).toMatch(/tasks_rating_check/);
      expect(await rawError(`UPDATE tasks SET status = 'APPROVED', final_at = now(), rating = 6 WHERE id = $1`, [id])).toMatch(/tasks_rating_check/);
      expect(await rawError(`UPDATE tasks SET status = 'APPROVED', final_at = now(), rating = 0 WHERE id = $1`, [id])).toMatch(/tasks_rating_check/);
      expect(await rawError(`UPDATE tasks SET status = 'APPROVED', final_at = now() WHERE id = $1`, [id])).toMatch(/tasks_rating_check/);
      // A task outlet in another organisation is refused by the composite key.
      expect(await rawError(`INSERT INTO tasks (organization_id, outlet_id, owner_employee_id, title, description, due_on, proof_kinds) VALUES ($1, $2, $3, 'T', 'D', $4, '{TEXT}')`, [w.a.org, w.b.outlet, w.a.e.emp, day(1)])).toMatch(/foreign key/);
    });

    it("keeps history, submissions, evidence and reminders unchangeable once written", async () => {
      const id = await insertTask("a", "emp");
      const ev = (await raw.query(`INSERT INTO task_events (organization_id, task_id, kind, to_status) VALUES ($1, $2, 'ASSIGNED', 'ASSIGNED') RETURNING id`, [w.a.org, id])).rows[0].id;
      expect(await rawError(`UPDATE task_events SET note = 'changed' WHERE id = $1`, [ev])).toMatch(/append-only/);
      const sub = (await raw.query(`INSERT INTO task_submissions (organization_id, task_id, number, text) VALUES ($1, $2, 1, 'Done') RETURNING id`, [w.a.org, id])).rows[0].id;
      expect(await rawError(`UPDATE task_submissions SET text = 'Edited' WHERE id = $1`, [sub])).toMatch(/append-only/);
      const key = `tasks/2026/${randomUUID()}`;
      const evi = (await raw.query(`INSERT INTO task_evidence (organization_id, task_id, submission_id, storage_key, original_name, mime_type, size_bytes, sha256)
        VALUES ($1, $2, $3, $4, 'photo.jpg', 'image/jpeg', 1000, $5) RETURNING id`, [w.a.org, id, sub, key, "a".repeat(64)])).rows[0].id;
      expect(await rawError(`UPDATE task_evidence SET original_name = 'other.jpg' WHERE id = $1`, [evi])).toMatch(/append-only/);
      // No automatic deletion yet: evidence has no removal column until the owner approves a retention period.
      expect((await raw.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'task_evidence' AND column_name = 'removed_at'`)).rows).toHaveLength(0);
      expect((await raw.query(`SELECT table_name, column_name FROM information_schema.columns WHERE table_name = ANY($1) AND column_name LIKE '%behalf%'`, [TABLES])).rows).toEqual([]);
      expect(await rawError(`INSERT INTO task_evidence (organization_id, task_id, submission_id, storage_key, original_name, mime_type, size_bytes, sha256)
        VALUES ($1, $2, $3, 'resumes/2026/x', 'x.pdf', 'application/pdf', 10, $4)`, [w.a.org, id, sub, "b".repeat(64)])).toMatch(/task_evidence_file_check/);
    });

    it("lets HR read every task of its organisation and an employee only their own", async () => {
      const mine = await insertTask("a", "emp");
      const theirs = await insertTask("a", "emp2");
      await insertTask("b", "emp");
      const seen = async (k: K, who: Who) => (await ok(k, who, `SELECT id FROM tasks WHERE id = ANY($1)`, [[mine, theirs]])).map((r) => r.id).sort();
      expect(await seen("a", "hr")).toEqual([mine, theirs].sort());
      expect(await seen("a", "emp")).toEqual([mine]);
      expect(await seen("b", "hr")).toEqual([]);
      expect((await ok("a", "emp", `SELECT count(*)::int n FROM task_events WHERE task_id = $1`, [theirs]))[0]!.n).toBe(0);
      // The owner may read the name of their task's outlet (even another outlet), but no other outlet.
      const second = await insertTask("a", "emp2", { outlet_id: w.a.outlet2 });
      expect((await ok("a", "emp2", `SELECT name FROM outlets WHERE id = $1`, [w.a.outlet2])).map((r) => r.name)).toEqual(["Second"]);
      expect((await ok("a", "emp", `SELECT name FROM outlets WHERE id = $1`, [w.a.outlet2]))).toEqual([]);
      void second;
      // Nobody writes directly.
      expect((await as("a", "hr", `UPDATE tasks SET title = 'x' WHERE id = $1`, [mine])).error).toMatch(/permission denied/);
      expect((await as("a", "hr", `INSERT INTO task_events (organization_id, task_id, kind, to_status) VALUES ($1, $2, 'NOTE', 'ASSIGNED')`, [w.a.org, mine])).error).toMatch(/permission denied/);
    });
  });
  // ---------------------------------------------------------------------------
  // Task 2: the functions (the only way to change tasks), notifications, daily job
  // ---------------------------------------------------------------------------
  describe("task functions", () => {
    const file = (mime: string, size = 1000) => ({ storage_key: `tasks/2026/${randomUUID()}`, original_name: mime.startsWith("image/") ? "photo.jpg" : "proof.pdf", mime_type: mime, size_bytes: size, sha256: randomBytes(32).toString("hex") });
    const assign = async (k: K, owner: Emp, opts: { proof?: string; outlet?: "outlet" | "outlet2"; due?: string; by?: Who } = {}) =>
      (await ok(k, opts.by ?? "hr", `SELECT app_assign_task($1, $2, 'Descale the machine', 'Descale it and send a photo.', $3::date, NULL, 'HIGH', $4::"TaskProofKind"[]) AS id`,
        [w[k].e[owner], w[k][opts.outlet ?? "outlet2"], opts.due ?? day(2), opts.proof ?? "{PHOTO,TEXT}"]))[0]!.id as string;
    const submit = (k: K, who: Who, id: string, text: string | null, files: unknown[]) => as(k, who, `SELECT app_submit_task($1, $2, $3::jsonb) AS id`, [id, text, JSON.stringify(files)]);
    const status = async (id: string) => (await raw.query(`SELECT status FROM tasks WHERE id = $1`, [id])).rows[0].status as string;
    const events = async (id: string) => (await raw.query(`SELECT kind FROM task_events WHERE task_id = $1 ORDER BY created_at, id`, [id])).rows;
    const notes = async (id: string, k: K, who: Who) => (await raw.query(`SELECT type::text FROM notifications WHERE task_id = $1 AND recipient_user_id = $2 ORDER BY created_at`, [id, w[k].user[who]])).rows.map((r) => r.type);

    it("runs the whole workflow with history, a rating, and a notification at each step for the right person", async () => {
      const id = await assign("a", "emp");
      expect(await notes(id, "a", "emp")).toEqual(["TASK_ASSIGNED"]);
      await ok("a", "emp", `SELECT app_start_task($1)`, [id]);
      await ok("a", "emp", `SELECT app_add_task_note($1, 'Bought descaler')`, [id]);
      expect((await submit("a", "emp", id, "Done, see photo", [file("image/jpeg")])).error).toBeUndefined();
      expect(await notes(id, "a", "hr")).toEqual(["TASK_SUBMITTED"]);
      expect(await notes(id, "a", "sa")).toEqual(["TASK_SUBMITTED"]);
      // Changes requested: a note, no rating.
      expect((await as("a", "hr", `SELECT app_review_task($1, false, 3::smallint, 'Photo too dark')`, [id])).error).toMatch(/rating_not_allowed/);
      expect((await as("a", "hr", `SELECT app_review_task($1, false, NULL, NULL)`, [id])).error).toMatch(/note_required/);
      await ok("a", "hr", `SELECT app_review_task($1, false, NULL, 'Photo too dark')`, [id]);
      expect(await status(id)).toBe("CHANGES_REQUESTED");
      await ok("a", "emp", `SELECT app_start_task($1)`, [id]);
      expect((await submit("a", "emp", id, "Better photo", [file("image/png")])).error).toBeUndefined();
      // Approving needs a rating 1-5.
      expect((await as("a", "hr", `SELECT app_review_task($1, true, NULL, NULL)`, [id])).error).toMatch(/rating_required/);
      expect((await as("a", "hr", `SELECT app_review_task($1, true, 6::smallint, NULL)`, [id])).error).toMatch(/rating_required/);
      await ok("a", "hr", `SELECT app_review_task($1, true, 4::smallint, 'Clean and on time')`, [id]);
      expect(await status(id)).toBe("APPROVED");
      expect((await events(id)).map((e) => e.kind)).toEqual(["ASSIGNED", "STARTED", "NOTE", "SUBMITTED", "CHANGES_REQUESTED", "STARTED", "SUBMITTED", "APPROVED"]);
      expect((await raw.query(`SELECT number FROM task_submissions WHERE task_id = $1 ORDER BY number`, [id])).rows.map((r) => r.number)).toEqual([1, 2]);
      expect(await notes(id, "a", "emp")).toEqual(["TASK_ASSIGNED", "TASK_CHANGES_REQUESTED", "TASK_APPROVED"]);
      // The owner sees the rating; the task's outlet never changed their home outlet.
      expect((await ok("a", "emp", `SELECT rating, rating_comment FROM tasks WHERE id = $1`, [id]))[0]).toEqual({ rating: 4, rating_comment: "Clean and on time" });
      expect((await raw.query(`SELECT outlet_id FROM employees WHERE id = $1`, [w.a.e.emp])).rows[0].outlet_id).toBe(w.a.outlet);
      // Final: nothing changes any more.
      expect((await as("a", "hr", `SELECT app_cancel_task($1, 'Too late')`, [id])).error).toMatch(/task_not_open/);
      expect((await as("a", "emp", `SELECT app_add_task_note($1, 'More')`, [id])).error).toMatch(/task_not_open/);
    });

    it("refuses wrong steps, missing proof, too many or bad files, and anyone but HR assigning", async () => {
      const id = await assign("a", "emp");
      expect((await submit("a", "emp", id, "x", [file("image/jpeg")])).error).toMatch(/task_bad_transition/); // not started
      expect((await as("a", "hr", `SELECT app_review_task($1, true, 3::smallint, NULL)`, [id])).error).toMatch(/task_bad_transition/);
      await ok("a", "emp", `SELECT app_start_task($1)`, [id]);
      expect((await as("a", "emp", `SELECT app_start_task($1)`, [id])).error).toMatch(/task_bad_transition/);
      expect((await submit("a", "emp", id, "only text", [])).error).toMatch(/task_proof_missing/); // photo required
      expect((await submit("a", "emp", id, null, [file("image/jpeg")])).error).toMatch(/task_proof_missing/); // text required
      expect((await submit("a", "emp", id, "x", [file("image/jpeg"), file("image/jpeg"), file("image/jpeg"), file("image/jpeg"), file("image/jpeg"), file("image/jpeg")])).error).toMatch(/task_too_many_files/);
      expect((await submit("a", "emp", id, "x", [file("image/gif")])).error).toMatch(/task_bad_file/);
      expect((await submit("a", "emp", id, "x", [file("image/jpeg", 10485761)])).error).toMatch(/task_bad_file/);
      expect((await submit("a", "emp", id, "x", [{ ...file("image/jpeg"), storage_key: "resumes/2026/abc" }])).error).toMatch(/task_bad_file/);
      expect((await submit("a", "emp", id, "x", [{ ...file("image/jpeg"), size_bytes: "abc" }])).error).toMatch(/task_bad_file/);
      expect((await as("a", "emp", `SELECT app_assign_task($1, $2, 'T', 'D', $3::date, NULL, 'LOW', '{TEXT}')`, [w.a.e.emp2, w.a.outlet, day(1)])).error).toMatch(/not allowed/);
      expect((await as("a", "hr", `SELECT app_assign_task($1, $2, 'T', 'D', $3::date, NULL, 'LOW', '{TEXT}')`, [w.a.e.emp, w.a.outlet, day(-1)])).error).toMatch(/task_due_in_past/);
      expect((await as("a", "hr", `SELECT app_assign_task($1, $2, 'T', 'D', $3::date, NULL, 'LOW', '{TEXT}')`, [w.b.e.emp, w.a.outlet, day(1)])).error).toMatch(/not_found/);
      expect((await as("a", "hr", `SELECT app_assign_task($1, $2, 'T', 'D', $3::date, NULL, 'LOW', '{TEXT}')`, [w.a.e.emp, w.b.outlet, day(1)])).error).toMatch(/not_found/);
      // Another employee and another organisation's HR cannot touch it.
      expect((await as("a", "emp2", `SELECT app_add_task_note($1, 'Hi')`, [id])).error).toMatch(/not_found/);
      expect((await as("b", "hr", `SELECT app_cancel_task($1, 'x')`, [id])).error).toMatch(/not_found/);
      expect((await ok("a", "emp2", `SELECT count(*)::int n FROM tasks WHERE id = $1`, [id]))[0]!.n).toBe(0);
      await ok("a", "hr", `SELECT app_cancel_task($1, 'Not needed')`, [id]);
      expect(await notes(id, "a", "emp")).toEqual(["TASK_ASSIGNED", "TASK_CANCELLED"]);
    });

    it("lets HR attach files and https links as resources, and hides removed ones from the owner", async () => {
      const id = await assign("a", "emp");
      const pdf = file("application/pdf");
      const fileId = (await ok("a", "hr", `SELECT app_add_task_resource($1, 'FILE', $2, NULL, 'Guide.pdf', 'application/pdf', 2000, $3) AS id`, [id, pdf.storage_key, pdf.sha256]))[0]!.id;
      const linkId = (await ok("a", "hr", `SELECT app_add_task_resource($1, 'LINK', NULL, 'https://example.com/descaling', 'How to descale', NULL, NULL, NULL) AS id`, [id]))[0]!.id;
      // A resource removed twice: the second is not found (not a raw database error).
      await ok("a", "hr", `SELECT app_remove_task_resource($1)`, [fileId]);
      expect((await as("a", "hr", `SELECT app_remove_task_resource($1)`, [fileId])).error).toMatch(/not_found/);
      for (const bad of ["http://example.com", "javascript:alert(1)"]) {
        expect((await as("a", "hr", `SELECT app_add_task_resource($1, 'LINK', NULL, $2, 'x', NULL, NULL, NULL)`, [id, bad])).error).toMatch(/bad_link/);
      }
      expect((await as("a", "emp", `SELECT app_add_task_resource($1, 'LINK', NULL, 'https://x.example', 'x', NULL, NULL, NULL)`, [id])).error).toMatch(/not allowed/);
      await ok("a", "hr", `SELECT app_remove_task_resource($1)`, [linkId]);
      expect((await ok("a", "emp", `SELECT id FROM task_resources WHERE task_id = $1`, [id])).map((r) => r.id)).toEqual([]);
      expect((await ok("a", "hr", `SELECT count(*)::int n FROM task_resources WHERE task_id = $1`, [id]))[0]!.n).toBe(2);
      expect((await events(id)).map((e) => e.kind)).toEqual(["ASSIGNED", "RESOURCE_ADDED", "RESOURCE_ADDED", "RESOURCE_REMOVED", "RESOURCE_REMOVED"]);
      // The CHECK refuses a file resource without a file and a link without a url, even from the owner account.
      expect(await rawError(`INSERT INTO task_resources (organization_id, task_id, kind, original_name) VALUES ($1, $2, 'FILE', 'x')`, [w.a.org, id])).toMatch(/task_resources_kind_check/);
      expect(await rawError(`INSERT INTO task_resources (organization_id, task_id, kind, original_name) VALUES ($1, $2, 'LINK', 'x')`, [w.a.org, id])).toMatch(/task_resources_kind_check/);
    });

    it("keeps HR from reviewing their own task unless they are the only reviewer", async () => {
      const id = await assign("a", "hr", { by: "sa", proof: "{TEXT}" });
      await ok("a", "hr", `SELECT app_start_task($1)`, [id]);
      expect((await submit("a", "hr", id, "Done", [])).error).toBeUndefined();
      expect((await as("a", "hr", `SELECT app_review_task($1, true, 5::smallint, NULL)`, [id])).error).toMatch(/own_task/);
      // The owner (Super Admin) on their own task: refused while HR can review; allowed, and marked, once they are the only reviewer.
      // (An organisation always keeps an active Super Admin, so the sole reviewer in practice is the owner.)
      const own = await assign("a", "sa", { proof: "{TEXT}" });
      await ok("a", "sa", `SELECT app_start_task($1)`, [own]);
      expect((await submit("a", "sa", own, "Done", [])).error).toBeUndefined();
      expect((await as("a", "sa", `SELECT app_review_task($1, true, 5::smallint, NULL)`, [own])).error).toMatch(/own_task/);
      await raw.query(`UPDATE organization_members SET status = 'SUSPENDED' WHERE id = $1`, [w.a.member.hr]);
      try {
        await ok("a", "sa", `SELECT app_review_task($1, true, 5::smallint, NULL)`, [own]);
        expect((await raw.query(`SELECT self_reviewed FROM tasks WHERE id = $1`, [own])).rows[0].self_reviewed).toBe(true);
      } finally {
        await raw.query(`UPDATE organization_members SET status = 'ACTIVE' WHERE id = $1`, [w.a.member.hr]);
      }
      // HR's own task is reviewed by the Super Admin.
      await ok("a", "sa", `SELECT app_review_task($1, true, 5::smallint, NULL)`, [id]);
    });

    it("needs a linked login for every task owner, and only the owner starts and submits", async () => {
      // Staff without a login cannot be given a task, or have one moved to them; nor can a suspended member or user,
      // a leaver, or someone from another organisation.
      const assignTo = (emp: string) => as("a", "hr", `SELECT app_assign_task($1, $2, 'T', 'D', $3::date, NULL, 'LOW', '{TEXT}')`, [emp, w.a.outlet, day(1)]);
      expect((await assignTo(w.a.e.nologin)).error).toMatch(/employee_no_login/);
      expect((await assignTo(w.b.e.emp)).error).toMatch(/not_found/);
      await raw.query(`UPDATE organization_members SET status = 'SUSPENDED' WHERE id = $1`, [w.a.member.emp2]);
      try {
        expect((await assignTo(w.a.e.emp2)).error).toMatch(/employee_no_login/);
      } finally {
        await raw.query(`UPDATE organization_members SET status = 'ACTIVE' WHERE id = $1`, [w.a.member.emp2]);
      }
      await raw.query(`UPDATE users SET status = 'DISABLED' WHERE id = $1`, [w.a.user.emp2]);
      try {
        expect((await assignTo(w.a.e.emp2)).error).toMatch(/employee_no_login/);
      } finally {
        await raw.query(`UPDATE users SET status = 'ACTIVE' WHERE id = $1`, [w.a.user.emp2]);
      }
      const id = await assign("a", "emp", { proof: "{TEXT}" });
      expect((await as("a", "hr", `SELECT app_edit_task($1, 'Descale the machine', 'Descale it and send a photo.', $2::date, NULL, 'HIGH', '{TEXT}', $3, $4, 'Move')`,
        [id, day(2), w.a.outlet2, w.a.e.nologin])).error).toMatch(/employee_no_login/);
      // HR cannot start or submit for the owner; another employee does not even learn the task exists; HR may still
      // leave a note (recorded as HR's).
      expect((await as("a", "hr", `SELECT app_start_task($1)`, [id])).error).toMatch(/task_not_owner/);
      const other = (await as("a", "emp2", `SELECT app_start_task($1)`, [id])).error ?? "";
      expect(other).toMatch(/not_found/);
      expect(other).not.toMatch(/task_not_owner/);
      await ok("a", "emp", `SELECT app_start_task($1)`, [id]);
      expect((await submit("a", "hr", id, "Done", [])).error).toMatch(/task_not_owner/);
      expect((await submit("a", "emp2", id, "Done", [])).error).toMatch(/not_found/);
      await ok("a", "hr", `SELECT app_add_task_note($1, 'Use the new descaler')`, [id]);
      const note = (await raw.query(`SELECT actor_id FROM task_events WHERE task_id = $1 AND kind = 'NOTE'`, [id])).rows[0];
      expect(note.actor_id).toBe(w.a.user.hr);
      // The owner submits normally.
      expect((await submit("a", "emp", id, "Done", [])).error).toBeUndefined();
    });

    it("moves a task to another person only before it is submitted; the previous owner loses sight of it (Review Focus 3)", async () => {
      const id = await assign("a", "emp");
      await ok("a", "emp", `SELECT app_start_task($1)`, [id]);
      expect((await as("a", "hr", `SELECT app_edit_task($1, 'Descale the machine', 'Descale it and send a photo.', $2::date, NULL, 'HIGH', '{PHOTO,TEXT}', $3, $4, NULL)`,
        [id, day(2), w.a.outlet2, w.a.e.emp2])).error).toMatch(/reason_required/);
      await ok("a", "hr", `SELECT app_edit_task($1, 'Descale the machine', 'Descale it and send a photo.', $2::date, NULL, 'HIGH', '{PHOTO,TEXT}', $3, $4, 'Emp is on leave')`,
        [id, day(2), w.a.outlet2, w.a.e.emp2]);
      expect((await ok("a", "emp", `SELECT count(*)::int n FROM tasks WHERE id = $1`, [id]))[0]!.n).toBe(0);
      expect((await ok("a", "emp2", `SELECT count(*)::int n FROM tasks WHERE id = $1`, [id]))[0]!.n).toBe(1);
      expect(await status(id)).toBe("ASSIGNED"); // the new owner starts it themselves
      const ev = (await raw.query(`SELECT changes FROM task_events WHERE task_id = $1 AND kind = 'REASSIGNED'`, [id])).rows[0].changes;
      expect(ev.owner_employee_id).toEqual([w.a.e.emp, w.a.e.emp2]);
      expect(await notes(id, "a", "emp2")).toEqual(["TASK_ASSIGNED"]);
      await ok("a", "emp2", `SELECT app_start_task($1)`, [id]);
      expect((await submit("a", "emp2", id, "Done", [file("image/webp")])).error).toBeUndefined();
      expect((await as("a", "hr", `SELECT app_edit_task($1, 'Descale the machine', 'Descale it and send a photo.', $2::date, NULL, 'HIGH', '{PHOTO,TEXT}', $3, $4, 'Back')`,
        [id, day(2), w.a.outlet2, w.a.e.emp])).error).toMatch(/task_bad_transition/);
    });

    it("stops a leaver from working on open tasks and sends them no reminders; HR can still cancel (Review Focus 4)", async () => {
      // A leaver with a login (tasks need one).
      const u = await owner.user.create({ data: { email: `leaver-${rnd()}@tasks.example.test`, name: "Leaver" } });
      userIds.push(u.id);
      const m = await owner.organizationMember.create({ data: { organizationId: w.b.org, userId: u.id, status: "ACTIVE", joinedAt: new Date(), roles: { create: [{ roleId: roleIds.EMPLOYEE! }] } } });
      const leaver = (await raw.query(`INSERT INTO employees (organization_id, employee_code, full_name, joined_on, outlet_id, member_id, updated_at) VALUES ($1, $2, 'Leaver', '2026-01-01', $3, $4, now()) RETURNING id`,
        [w.b.org, `TK-LV-${rnd()}`.toUpperCase(), w.b.outlet, m.id])).rows[0].id;
      const id = (await ok("b", "hr", `SELECT app_assign_task($1, $2, 'T', 'D', $3::date, NULL, 'LOW', '{TEXT}') AS id`, [leaver, w.b.outlet, today]))[0]!.id as string;
      await raw.query(`UPDATE employees SET status = 'EXITED', exited_on = $2::date WHERE id = $1`, [leaver, today]);
      const leaverToken = await pgSessionToken(raw, u.id, w.b.org);
      await rt.query("BEGIN");
      await rt.query(`SELECT set_config('app.mode', 'staff', true), set_config('app.session_token', $1, true)`, [leaverToken]);
      const started = await rt.query(`SELECT app_start_task($1)`, [id]).then(() => undefined, (e: Error) => e.message);
      await rt.query("ROLLBACK");
      // The member is still active but the employee record has left: refused by the status check.
      expect(started).toMatch(/employee_not_active/);
      await ok("b", "maintenance", `SELECT * FROM app_task_housekeeping($1::date)`, [today]);
      expect((await raw.query(`SELECT count(*)::int n FROM task_reminders WHERE task_id = $1`, [id])).rows[0].n).toBe(0);
      await ok("b", "hr", `SELECT app_cancel_task($1, 'Left the company')`, [id]);
      expect(await status(id)).toBe("CANCELLED");
    });

    it("sends each reminder once even if the daily job runs twice or skips a day (Review Focus 5)", async () => {
      const a1 = await assign("b", "emp", { due: day(1), proof: "{TEXT}" });
      const a2 = await assign("b", "emp2", { due: day(1), proof: "{TEXT}" });
      const due = (id: string) => raw.query(`SELECT count(*)::int n FROM notifications WHERE task_id = $1 AND type = 'TASK_DUE'`, [id]).then((r) => r.rows[0].n as number);
      // p_today may be at most one day ahead of the real date.
      await ok("b", "maintenance", `SELECT * FROM app_task_housekeeping($1::date)`, [day(1)]);
      await ok("b", "maintenance", `SELECT * FROM app_task_housekeeping($1::date)`, [day(1)]);
      expect(await due(a1)).toBe(1);
      expect(await due(a2)).toBe(1);
      expect((await as("b", "maintenance", `SELECT * FROM app_task_housekeeping($1::date)`, [day(5)])).error).toMatch(/not allowed/);
      // A task due yesterday whose due-day run was missed gets one "overdue" reminder only.
      const late = (await raw.query(`INSERT INTO tasks (organization_id, outlet_id, owner_employee_id, title, description, due_on, proof_kinds, created_by_id)
        VALUES ($1, $2, $3, 'Old', 'Old task', $4::date, '{TEXT}', $5) RETURNING id`, [w.b.org, w.b.outlet, w.b.e.emp, day(-1), w.b.user.hr])).rows[0].id;
      await ok("b", "maintenance", `SELECT * FROM app_task_housekeeping($1::date)`, [today]);
      await ok("b", "maintenance", `SELECT * FROM app_task_housekeeping($1::date)`, [today]);
      expect((await raw.query(`SELECT kind::text FROM task_reminders WHERE task_id = $1`, [late])).rows).toEqual([{ kind: "DUE_AFTER" }]);
      expect(await due(late)).toBe(1);
      // An owner whose login is suspended today gets no reminder, and it is not used up: it comes once the login is back.
      const paused = await assign("b", "emp2", { due: today, proof: "{TEXT}" });
      await raw.query(`UPDATE organization_members SET status = 'SUSPENDED' WHERE id = $1`, [w.b.member.emp2]);
      try {
        await ok("b", "maintenance", `SELECT * FROM app_task_housekeeping($1::date)`, [today]);
        expect((await raw.query(`SELECT count(*)::int n FROM task_reminders WHERE task_id = $1`, [paused])).rows[0].n).toBe(0);
      } finally {
        await raw.query(`UPDATE organization_members SET status = 'ACTIVE' WHERE id = $1`, [w.b.member.emp2]);
      }
      await ok("b", "maintenance", `SELECT * FROM app_task_housekeeping($1::date)`, [today]);
      expect(await due(paused)).toBe(1);
      // Reassigned on its due day: the new owner gets their own reminder.
      await ok("b", "hr", `SELECT app_edit_task($1, 'Descale the machine', 'Descale it and send a photo.', $2::date, NULL, 'HIGH', '{TEXT}', $3, $4, 'Cover')`,
        [paused, today, w.b.outlet2, w.b.e.emp]);
      await ok("b", "maintenance", `SELECT * FROM app_task_housekeeping($1::date)`, [today]);
      expect((await raw.query(`SELECT count(*)::int n FROM notifications WHERE task_id = $1 AND type = 'TASK_DUE' AND recipient_user_id = $2`, [paused, w.b.user.emp])).rows[0].n).toBe(1);
      // Two days late: nothing more.
      const older = (await raw.query(`INSERT INTO tasks (organization_id, outlet_id, owner_employee_id, title, description, due_on, proof_kinds, created_by_id)
        VALUES ($1, $2, $3, 'Older', 'Older task', $4::date, '{TEXT}', $5) RETURNING id`, [w.b.org, w.b.outlet, w.b.e.emp, day(-2), w.b.user.hr])).rows[0].id;
      await ok("b", "maintenance", `SELECT * FROM app_task_housekeeping($1::date)`, [today]);
      expect(await due(older)).toBe(0);
    });

    it("never deletes evidence automatically (retention waits for the owner's approval)", async () => {
      const id = await assign("b", "emp", { proof: "{PHOTO}" });
      await ok("b", "emp", `SELECT app_start_task($1)`, [id]);
      const f = file("image/jpeg");
      expect((await submit("b", "emp", id, null, [f])).error).toBeUndefined();
      await ok("b", "hr", `SELECT app_review_task($1, true, 3::smallint, NULL)`, [id]);
      await raw.query(`UPDATE tasks SET final_at = now() - interval '5 years' WHERE id = $1`, [id]);
      const r = await ok("b", "maintenance", `SELECT app_task_housekeeping($1::date) AS n`, [today]);
      expect(typeof r[0]!.n).toBe("number");
      expect((await raw.query(`SELECT count(*)::int n FROM task_evidence WHERE storage_key = $1`, [f.storage_key])).rows[0].n).toBe(1);
    });
  });
});

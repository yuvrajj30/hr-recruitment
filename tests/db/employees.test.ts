// Employee Management (migration 20261121000000_employee_management), against the DISPOSABLE test database only.
// Service behaviour (create, update, history, managers, exit, account link) and direct PostgreSQL checks as the app's
// restricted account for every role: HR of the same organisation, HR of another organisation, an Employee (with and
// without a linked record) and the public careers mode.
import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuthContext } from "@/lib/auth/context";
import { ROLE_PERMISSIONS, type RoleKey } from "@/lib/auth/roles";
import { createDb, type Db } from "@/lib/db";
import {
  createEmployee, createStructureItem, type EmployeeDeps, getEmployee, getMyEmployee, linkEmployeeAccount,
  listEmployees, listStructure, markEmployeeExited, updateEmployee, updateStructureItem,
} from "@/lib/employees/employees";
import type { EmployeeInput } from "@/lib/employees/rules";
import { realRoleIds } from "./roles-helper";
import { giveSession, pgSessionToken, purgeTestAuditRows } from "./session-helper";

const ownerUrl = process.env.TEST_OWNER_URL;
const runtimeUrl = process.env.TEST_RUNTIME_URL;
const isTestDb = (u?: string) => Boolean(u && /_test\b/.test(new URL(u).pathname));
const enabled = isTestDb(ownerUrl) && isTestDb(runtimeUrl);
const rnd = () => randomBytes(4).toString("hex");
const DOMAIN = "employees.example.test";
type K = "a" | "b";
type Who = "hr" | "sa" | "emp";

describe.skipIf(!enabled)("employee management (test database)", () => {
  let owner: Db;
  let db: Db;
  let raw: Client;
  let rt: Client;
  const orgIds: string[] = [];
  const userIds: string[] = [];
  const w: Record<K, { org: string; ctx: Record<Who, AuthContext>; user: Record<Who, string>; member: Record<Who, string>; deps: EmployeeDeps; outlet: string; dept: string; desig: string }> = {} as never;
  const base = (over: Partial<EmployeeInput> = {}): EmployeeInput => ({
    employeeCode: `E-${rnd()}`, fullName: "Asha Rao", email: null, phone: null, employmentType: "FULL_TIME", joinedOn: "2026-01-05",
    outletId: null, departmentId: null, designationId: null, managerId: null, ...over,
  });

  beforeAll(async () => {
    owner = createDb(ownerUrl!, { max: 2 });
    db = createDb(runtimeUrl!, { max: 2 });
    raw = new Client({ connectionString: ownerUrl, options: "-c TimeZone=UTC" });
    rt = new Client({ connectionString: runtimeUrl, options: "-c TimeZone=UTC" });
    await raw.connect();
    await rt.connect();
    const role = await realRoleIds(owner);
    for (const k of ["a", "b"] as const) {
      const users = {} as Record<Who, { id: string; email: string; name: string }>;
      for (const who of ["sa", "hr", "emp"] as const) {
        users[who] = await owner.user.create({ data: { email: `${who}-${k}-${rnd()}@${DOMAIN}`, name: `${who.toUpperCase()} ${k}` } });
        userIds.push(users[who].id);
      }
      const org = await owner.organization.create({ data: { slug: `emp-${k}-${rnd()}${rnd()}`, name: `Employees ${k}`, ownerUserId: users.sa.id, timezone: "Asia/Kolkata" } });
      orgIds.push(org.id);
      const member = {} as Record<Who, string>;
      const ctx = {} as Record<Who, AuthContext>;
      const keyOf: Record<Who, RoleKey> = { sa: "SUPER_ADMIN", hr: "HR_MANAGER", emp: "EMPLOYEE" };
      for (const who of ["sa", "hr", "emp"] as const) {
        const m = await owner.organizationMember.create({ data: { organizationId: org.id, userId: users[who].id, status: "ACTIVE", joinedAt: new Date(), roles: { create: [{ roleId: role[keyOf[who]] }] } } });
        member[who] = m.id;
        ctx[who] = await giveSession(owner, {
          sessionId: "00000000-0000-0000-0000-000000000000",
          user: { ...users[who], isPlatformAdmin: false },
          organization: { id: org.id, name: org.name, slug: org.slug },
          memberId: m.id, expiresAt: new Date(), absoluteExpiresAt: new Date(), roleKeys: [keyOf[who]], permissions: new Set(ROLE_PERMISSIONS[keyOf[who]]),
        });
      }
      const deps: EmployeeDeps = { db, now: new Date(), writeAudit: async () => undefined, client: { ipAddress: null, userAgent: null } };
      w[k] = { org: org.id, ctx, member, deps, user: { sa: users.sa.id, hr: users.hr.id, emp: users.emp.id }, outlet: "", dept: "", desig: "" };
      w[k].outlet = (await createStructureItem(deps, ctx.hr, "outlet", { name: "Vijay Nagar", address: "Indore" })).id;
      w[k].dept = (await createStructureItem(deps, ctx.hr, "department", { name: "Cafe Floor", address: null })).id;
      w[k].desig = (await createStructureItem(deps, ctx.hr, "designation", { name: "Barista", address: null })).id;
    }
  }, 90_000);

  afterAll(async () => {
    if (raw && orgIds.length) {
      // Records of people who left are frozen (no UPDATE), so remove everything in one statement: the
      // manager references are checked only at its end, when all rows are gone.
      await raw.query(`DELETE FROM employee_assignments WHERE organization_id = ANY($1)`, [orgIds]);
      await raw.query(`DELETE FROM employees WHERE organization_id = ANY($1)`, [orgIds]);
      for (const t of ["outlets", "designations", "departments"]) await raw.query(`DELETE FROM ${t} WHERE organization_id = ANY($1)`, [orgIds]);
      await owner.session.deleteMany({ where: { userId: { in: userIds } } });
      await owner.organizationMember.deleteMany({ where: { organizationId: { in: orgIds } } });
      await purgeTestAuditRows(owner, orgIds);
      await owner.organization.deleteMany({ where: { id: { in: orgIds } } });
      await owner.user.deleteMany({ where: { id: { in: userIds } } });
    }
    await owner?.$disconnect();
    await db?.$disconnect();
    await raw?.end();
    await rt?.end();
  });

  // A direct attempt as the app account (row-level security applies), signed in as `who` of `k`, rolled back.
  async function as(k: K, who: Who | "public", sql: string, params: unknown[] = []) {
    await rt.query("BEGIN");
    try {
      if (who === "public") await rt.query(`SELECT set_config('app.mode', 'public_apply', true), set_config('app.org_id', $1, true)`, [w[k].org]);
      else await rt.query(`SELECT set_config('app.mode', 'staff', true), set_config('app.session_token', $1, true)`, [await pgSessionToken(raw, w[k].user[who], w[k].org)]);
      const r = await rt.query(sql, params);
      return { rows: r.rows as Record<string, unknown>[], rowCount: r.rowCount ?? 0, error: undefined as string | undefined };
    } catch (e) {
      return { rows: [] as Record<string, unknown>[], rowCount: 0, error: (e as Error).message };
    } finally {
      await rt.query("ROLLBACK");
    }
  }
  const count = async (k: K, who: Who | "public", table: string, where = "true", params: unknown[] = []) => {
    const r = await as(k, who, `SELECT count(*)::int AS n FROM ${table} WHERE ${where}`, params);
    expect(r.error, `${who} of ${k} reading ${table}`).toBeUndefined();
    return r.rows[0]!.n as number;
  };

  it("creates employees with structure and records where they work, by whom", async () => {
    const a = w.a;
    const lead = await createEmployee(a.deps, a.ctx.hr, base({ fullName: "Priya Lead", outletId: a.outlet, departmentId: a.dept, designationId: a.desig }));
    const e = await createEmployee(a.deps, a.ctx.hr, base({ fullName: "Ravi Barista", email: "Ravi@Example.test".toLowerCase(), outletId: a.outlet, managerId: lead.id }));
    const d = await getEmployee(db, a.ctx.hr, e.id);
    expect(d).toMatchObject({ fullName: "Ravi Barista", outlet: "Vijay Nagar", manager: "Priya Lead", status: "ACTIVE", joinedOn: "2026-01-05" });
    expect(d.history).toHaveLength(1);
    expect(d.history[0]).toMatchObject({ outlet: "Vijay Nagar", manager: "Priya Lead", endsAt: null, changedBy: "HR a" });
    // A move to another outlet ends the old assignment and starts a new one.
    const second = (await createStructureItem(a.deps, a.ctx.hr, "outlet", { name: "Palasia", address: null })).id;
    await updateEmployee(a.deps, a.ctx.sa, e.id, { ...base({ fullName: "Ravi Barista", outletId: second, managerId: lead.id }), employeeCode: d.employeeCode, joinedOn: d.joinedOn });
    const after = await getEmployee(db, a.ctx.hr, e.id);
    expect(after.history.map((h) => [h.outlet, h.endsAt === null, h.changedBy])).toEqual([["Palasia", true, "SA a"], ["Vijay Nagar", false, "HR a"]]);
    // A change that does not touch the assignment adds no history.
    await updateEmployee(a.deps, a.ctx.hr, e.id, { ...base({ fullName: "Ravi B.", outletId: second, managerId: lead.id }), employeeCode: d.employeeCode, joinedOn: d.joinedOn });
    expect((await getEmployee(db, a.ctx.hr, e.id)).history).toHaveLength(2);
    expect((await getEmployee(db, a.ctx.hr, lead.id)).reports.map((r) => r.fullName)).toEqual(["Ravi B."]);
    expect((await listEmployees(db, a.ctx.hr, { q: "ravi" })).map((x) => x.fullName)).toEqual(["Ravi B."]);
  });

  it("refuses duplicate codes, reporting loops, inactive structure and changes to people who left", async () => {
    const a = w.a;
    const code = `DUP-${rnd()}`;
    await createEmployee(a.deps, a.ctx.hr, base({ employeeCode: code }));
    await expect(createEmployee(a.deps, a.ctx.hr, base({ employeeCode: code }))).rejects.toMatchObject({ fieldErrors: { employeeCode: expect.any(String) } });
    const x = await createEmployee(a.deps, a.ctx.hr, base({ fullName: "X" }));
    const y = await createEmployee(a.deps, a.ctx.hr, base({ fullName: "Y", managerId: x.id }));
    const xd = await getEmployee(db, a.ctx.hr, x.id);
    await expect(updateEmployee(a.deps, a.ctx.hr, x.id, { ...base({ fullName: "X", managerId: y.id }), employeeCode: xd.employeeCode })).rejects.toMatchObject({ fieldErrors: { managerId: expect.stringMatching(/loop/) } });
    // The database refuses a loop even when the app's checks are skipped.
    const direct = await as("a", "hr", `UPDATE employees SET manager_id = $1 WHERE id = $2`, [y.id, x.id]);
    expect(direct.error).toMatch(/manager_loop/);
    // An inactive outlet cannot be chosen.
    const closed = (await createStructureItem(a.deps, a.ctx.hr, "outlet", { name: `Closed ${rnd()}`, address: null })).id;
    await updateStructureItem(a.deps, a.ctx.hr, "outlet", closed, { isActive: false });
    await expect(createEmployee(a.deps, a.ctx.hr, base({ outletId: closed }))).rejects.toMatchObject({ fieldErrors: { outletId: expect.any(String) } });
    // Someone with active reports cannot leave; once they have none they can, and are then read-only.
    await expect(markEmployeeExited(a.deps, a.ctx.hr, x.id, "2026-10-31")).rejects.toThrow(/report to this person/);
    await markEmployeeExited(a.deps, a.ctx.hr, y.id, "2026-10-31");
    expect(await getEmployee(db, a.ctx.hr, y.id)).toMatchObject({ status: "EXITED", exitedOn: "2026-10-31" });
    await expect(updateEmployee(a.deps, a.ctx.hr, y.id, base())).rejects.toThrow(/has left/);
    expect((await listEmployees(db, a.ctx.hr)).map((e) => e.id)).not.toContain(y.id); // active only by default
    expect((await listEmployees(db, a.ctx.hr, { status: "EXITED" })).map((e) => e.id)).toContain(y.id);
    // The database: an exit date needs the EXITED status, and records are never deleted.
    expect((await as("a", "hr", `UPDATE employees SET exited_on = '2026-11-01' WHERE id = $1`, [x.id])).error).toMatch(/employees_exit_check/);
    expect((await as("a", "hr", `DELETE FROM employees WHERE id = $1`, [x.id])).error).toMatch(/permission denied/);
  });

  it("keeps each organisation's employees, structure and history to itself", async () => {
    const e = await createEmployee(w.a.deps, w.a.ctx.hr, base({ fullName: "Only In A", outletId: w.a.outlet }));
    for (const who of ["hr", "sa"] as const) {
      expect(await count("a", who, "employees", "id = $1", [e.id]), `${who} of A`).toBe(1);
      expect(await count("b", who, "employees", "id = $1", [e.id]), `${who} of B`).toBe(0);
      expect(await count("b", who, "employee_assignments", "employee_id = $1", [e.id])).toBe(0);
      expect(await count("b", who, "outlets", "id = $1", [w.a.outlet])).toBe(0);
    }
    await expect(getEmployee(db, w.b.ctx.hr, e.id)).rejects.toMatchObject({ code: "not_found" });
    // B cannot change A's employee, nor create one in A, nor point its own employee at A's outlet.
    const upd = await as("b", "hr", `UPDATE employees SET full_name = 'hijacked' WHERE id = $1`, [e.id]);
    expect(upd.error).toBeUndefined();
    expect(upd.rowCount).toBe(0);
    const ins = await as("b", "hr", `INSERT INTO employees (organization_id, employee_code, full_name, joined_on, updated_at) VALUES ($1, 'X1', 'x', '2026-01-01', now())`, [w.a.org]);
    expect(ins.error).toMatch(/row-level security/);
    const cross = await as("b", "hr", `INSERT INTO employees (organization_id, employee_code, full_name, joined_on, outlet_id, updated_at) VALUES ($1, 'X2', 'x', '2026-01-01', $2, now())`, [w.b.org, w.a.outlet]);
    expect(cross.error).toMatch(/employees_organization_id_outlet_id_fkey/);
    // Even the owner account cannot link across organisations: the composite key refuses another organisation's
    // outlet, and the manager guard another organisation's employee (before its composite key would).
    const inB = await createEmployee(w.b.deps, w.b.ctx.hr, base({ fullName: "Only In B" }));
    const ownerCross = await raw.query(`UPDATE employees SET outlet_id = $1 WHERE id = $2`, [w.b.outlet, e.id]).then(() => "allowed", (x: Error) => x.message);
    expect(ownerCross).toMatch(/employees_organization_id_outlet_id_fkey/);
    const ownerManager = await raw.query(`UPDATE employees SET manager_id = $1 WHERE id = $2`, [inB.id, e.id]).then(() => "allowed", (x: Error) => x.message);
    expect(ownerManager).toMatch(/manager_not_active/);
  });

  it("lets an Employee read only their own linked record and the structure names it uses", async () => {
    const a = w.a;
    const mine = await createEmployee(a.deps, a.ctx.hr, base({ fullName: "Emp Self", outletId: a.outlet, designationId: a.desig }));
    const other = await createEmployee(a.deps, a.ctx.hr, base({ fullName: "Someone Else" }));
    // Not linked yet: nothing.
    expect(await count("a", "emp", "employees")).toBe(0);
    expect(await getMyEmployee(db, a.ctx.emp)).toBeNull();
    await linkEmployeeAccount(a.deps, a.ctx.hr, mine.id, a.member.emp);
    expect(await count("a", "emp", "employees")).toBe(1);
    expect(await count("a", "emp", "employees", "id = $1", [other.id])).toBe(0);
    expect(await count("a", "emp", "employee_assignments", "employee_id = $1", [mine.id])).toBe(1);
    expect(await count("a", "emp", "employee_assignments", "employee_id = $1", [other.id])).toBe(0);
    const me = await getMyEmployee(db, a.ctx.emp);
    expect(me).toMatchObject({ id: mine.id, fullName: "Emp Self", outlet: "Vijay Nagar", designation: "Barista", reports: [], account: null });
    expect(me!.history[0]!.changedBy).toBeNull(); // who changed it is HR information
    // Structure names: only those of their own assignments (the organisation has more outlets than this one);
    // employees list and changes: refused.
    expect(await count("a", "hr", "outlets")).toBeGreaterThan(1);
    expect(await count("a", "emp", "outlets")).toBe(1);
    expect(await count("a", "emp", "outlets", "id = $1", [a.outlet])).toBe(1);
    expect(await count("a", "emp", "designations")).toBe(1);
    expect(await count("a", "emp", "departments")).toBe(0);
    expect((await listStructure(db, a.ctx.emp)).outlet.map((o) => o.name)).toEqual(["Vijay Nagar"]);
    // A suspended member loses their own record too, like every other staff access.
    await raw.query(`UPDATE organization_members SET status = 'SUSPENDED' WHERE id = $1`, [a.member.emp]);
    try {
      expect(await count("a", "emp", "employees")).toBe(0);
      expect(await count("a", "emp", "employee_assignments")).toBe(0);
      expect(await count("a", "emp", "outlets")).toBe(0);
    } finally {
      await raw.query(`UPDATE organization_members SET status = 'ACTIVE' WHERE id = $1`, [a.member.emp]);
    }
    expect(await count("a", "emp", "employees")).toBe(1);
    await expect(listEmployees(db, a.ctx.emp)).rejects.toThrow();
    const own = await as("a", "emp", `UPDATE employees SET full_name = 'changed' WHERE id = $1`, [mine.id]);
    expect(own.rowCount).toBe(0);
    expect((await as("a", "emp", `INSERT INTO outlets (organization_id, name, updated_at) VALUES ($1, 'x', now())`, [a.org])).error).toMatch(/row-level security/);
    // A staff account links to one record only; unlinking hides it again.
    await expect(linkEmployeeAccount(a.deps, a.ctx.hr, other.id, a.member.emp)).rejects.toThrow(/already linked/);
    await linkEmployeeAccount(a.deps, a.ctx.hr, mine.id, null);
    expect(await count("a", "emp", "employees")).toBe(0);
    expect(await count("a", "emp", "outlets")).toBe(0);
    // Another organisation's staff account cannot be linked.
    await expect(linkEmployeeAccount(a.deps, a.ctx.hr, mine.id, w.b.member.emp)).rejects.toMatchObject({ fieldErrors: { memberId: expect.any(String) } });
  });

  it("gives the public careers mode nothing, and lets nobody write the assignment history", async () => {
    for (const t of ["employees", "employee_assignments", "outlets", "designations"]) expect(await count("a", "public", t), t).toBe(0);
    const anyEmp = (await raw.query(`SELECT id FROM employees WHERE organization_id = $1 LIMIT 1`, [w.a.org])).rows[0].id;
    for (const sql of [
      `INSERT INTO employee_assignments (organization_id, employee_id, starts_at) VALUES ('${w.a.org}', '${anyEmp}', now())`,
      `UPDATE employee_assignments SET ends_at = now() WHERE employee_id = '${anyEmp}'`,
      `DELETE FROM employee_assignments WHERE employee_id = '${anyEmp}'`,
    ]) expect((await as("a", "hr", sql)).error, sql).toMatch(/permission denied/);
    // An Employee without a linked record sees no structure at all; HR sees all of it, with counts.
    const s = await listStructure(db, w.a.ctx.emp);
    expect([...s.outlet, ...s.department, ...s.designation]).toEqual([]);
    expect((await listStructure(db, w.a.ctx.hr)).outlet.find((o) => o.name === "Vijay Nagar")!.employees).toBeGreaterThan(0);
  });

  it("freezes the records of people who left and closes their current assignment", async () => {
    const a = w.a;
    const e = await createEmployee(a.deps, a.ctx.hr, base({ fullName: "Leaving Soon", outletId: a.outlet }));
    await linkEmployeeAccount(a.deps, a.ctx.hr, e.id, a.member.sa);
    await markEmployeeExited(a.deps, a.ctx.hr, e.id, "2026-11-01");
    const d = await getEmployee(db, a.ctx.hr, e.id);
    expect(d.history).toHaveLength(1);
    expect(d.history[0]!.endsAt).not.toBeNull();
    // Directly in the database, as HR of the same organisation: no edits, no reinstatement, no new link.
    for (const sql of [
      `UPDATE employees SET full_name = 'changed' WHERE id = $1`,
      `UPDATE employees SET status = 'ACTIVE', exited_on = NULL WHERE id = $1`,
      `UPDATE employees SET outlet_id = NULL WHERE id = $1`,
      `UPDATE employees SET member_id = '${a.member.hr}' WHERE id = $1`,
    ]) expect((await as("a", "hr", sql, [e.id])).error, sql).toMatch(/employee_exited/);
    // Unlinking the login stays possible (and is what removing the staff account does).
    await linkEmployeeAccount(a.deps, a.ctx.hr, e.id, null);
    expect((await getEmployee(db, a.ctx.hr, e.id)).memberId).toBeNull();
    await expect(linkEmployeeAccount(a.deps, a.ctx.hr, e.id, a.member.sa)).rejects.toThrow(/has left/);
    // A person who left cannot be chosen as someone's manager.
    await expect(createEmployee(a.deps, a.ctx.hr, base({ managerId: e.id }))).rejects.toMatchObject({ fieldErrors: { managerId: expect.any(String) } });
    expect((await as("a", "hr", `INSERT INTO employees (organization_id, employee_code, full_name, joined_on, manager_id, updated_at)
                                  VALUES ($1, 'MX-1', 'x', '2026-01-01', $2, now())`, [a.org, e.id])).error).toMatch(/manager_not_active/);
  });

  // Two HR users at the same moment, on two connections: the second waits for the first and then sees its change.
  describe("concurrent changes in one organisation", () => {
    let c1: Client;
    let c2: Client;
    beforeAll(async () => {
      c1 = new Client({ connectionString: runtimeUrl, options: "-c TimeZone=UTC" });
      c2 = new Client({ connectionString: runtimeUrl, options: "-c TimeZone=UTC" });
      await c1.connect();
      await c2.connect();
    });
    afterAll(async () => {
      await c1?.end();
      await c2?.end();
    });
    const begin = async (c: Client, who: Who) => {
      await c.query("BEGIN");
      await c.query(`SELECT set_config('app.mode', 'staff', true), set_config('app.session_token', $1, true)`, [await pgSessionToken(raw, w.a.user[who], w.a.org)]);
    };
    const settle = (p: Promise<unknown>) => p.then(() => "ok", (x: Error) => x.message);
    // Runs first (holding the organisation's lock), then second (which must wait), commits first, returns second's outcome.
    async function race(first: [string, unknown[]], second: [string, unknown[]]) {
      await begin(c1, "hr");
      await begin(c2, "sa");
      try {
        await c1.query(first[0], first[1]);
        const pending = settle(c2.query(second[0], second[1]));
        // The second statement is blocked on the lock, not finished.
        const early = await Promise.race([pending, new Promise((r) => setTimeout(() => r("waiting"), 300))]);
        expect(early).toBe("waiting");
        await c1.query("COMMIT");
        return await pending;
      } finally {
        await c1.query("ROLLBACK").catch(() => undefined);
        await c2.query("ROLLBACK").catch(() => undefined);
      }
    }

    it("cannot create a reporting loop with two simultaneous manager changes", async () => {
      const x = await createEmployee(w.a.deps, w.a.ctx.hr, base({ fullName: "Race X" }));
      const y = await createEmployee(w.a.deps, w.a.ctx.hr, base({ fullName: "Race Y" }));
      const outcome = await race([`UPDATE employees SET manager_id = $1 WHERE id = $2`, [y.id, x.id]], [`UPDATE employees SET manager_id = $1 WHERE id = $2`, [x.id, y.id]]);
      expect(outcome).toMatch(/manager_loop/);
      expect((await getEmployee(db, w.a.ctx.hr, y.id)).managerId).toBeNull();
    });

    it("cannot mark someone as left while a report is being assigned to them, nor the other way round", async () => {
      const m = await createEmployee(w.a.deps, w.a.ctx.hr, base({ fullName: "Race Manager" }));
      const r = await createEmployee(w.a.deps, w.a.ctx.hr, base({ fullName: "Race Report" }));
      const assign: [string, unknown[]] = [`UPDATE employees SET manager_id = $1 WHERE id = $2`, [m.id, r.id]];
      const exit: [string, unknown[]] = [`UPDATE employees SET status = 'EXITED', exited_on = '2026-11-01' WHERE id = $1`, [m.id]];
      expect(await race(assign, exit)).toMatch(/employee_has_reports/);
      expect((await getEmployee(db, w.a.ctx.hr, m.id)).status).toBe("ACTIVE");
      // Reverse order, with a fresh pair.
      const m2 = await createEmployee(w.a.deps, w.a.ctx.hr, base({ fullName: "Race Manager 2" }));
      const r2 = await createEmployee(w.a.deps, w.a.ctx.hr, base({ fullName: "Race Report 2" }));
      expect(await race([`UPDATE employees SET status = 'EXITED', exited_on = '2026-11-01' WHERE id = $1`, [m2.id]], [`UPDATE employees SET manager_id = $1 WHERE id = $2`, [m2.id, r2.id]])).toMatch(/manager_not_active/);
      expect((await getEmployee(db, w.a.ctx.hr, r2.id)).managerId).toBeNull();
    });
  });
});

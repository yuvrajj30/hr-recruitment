// The three-role rules, checked directly in the DISPOSABLE test database as the restricted app account
// (hr_runtime), without going through any application code. Every attempt to break a rule runs inside a
// transaction that is rolled back, and the fixture organisation is removed afterwards.
import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROLE_KEYS, ROLE_PERMISSIONS } from "@/lib/auth/roles";
import { pgSessionToken } from "./session-helper";

const ownerUrl = process.env.TEST_OWNER_URL;
const runtimeUrl = process.env.TEST_RUNTIME_URL;
const isTestDb = (u?: string) => Boolean(u && /_test\b/.test(new URL(u).pathname));
const enabled = isTestDb(ownerUrl) && isTestDb(runtimeUrl);
const rnd = () => randomBytes(4).toString("hex");

describe.skipIf(!enabled)("three-role rules in the database (test database)", () => {
  let owner: Client;
  let rt: Client;
  const ids = { org: "", sa1User: "", sa2User: "", hrUser: "", empUser: "", sa1: "", sa2: "", hr: "", emp: "" };
  const role: Record<string, string> = {};

  beforeAll(async () => {
    owner = new Client({ connectionString: ownerUrl });
    rt = new Client({ connectionString: runtimeUrl });
    await owner.connect();
    await rt.connect();
    for (const r of (await owner.query(`SELECT id, key FROM roles`)).rows) role[r.key] = r.id;
    const user = async (name: string) =>
      (await owner.query(`INSERT INTO users (id, email, name, updated_at) VALUES (gen_random_uuid(), $1, $2, now()) RETURNING id`, [`three-roles-${rnd()}@example.test`, name])).rows[0].id as string;
    ids.sa1User = await user("SA One");
    ids.sa2User = await user("SA Two");
    ids.hrUser = await user("HR");
    ids.empUser = await user("Employee");
    ids.org = (await owner.query(`INSERT INTO organizations (id, slug, name, owner_user_id, updated_at) VALUES (gen_random_uuid(), $1, 'Three Roles', $2, now()) RETURNING id`, [`t-${rnd()}${rnd()}`, ids.sa1User])).rows[0].id;
    const member = async (userId: string, key: string) => {
      const m = (await owner.query(`INSERT INTO organization_members (id, organization_id, user_id, status, updated_at) VALUES (gen_random_uuid(), $1, $2, 'ACTIVE', now()) RETURNING id`, [ids.org, userId])).rows[0].id as string;
      await owner.query(`INSERT INTO organization_member_roles (member_id, role_id) VALUES ($1, $2)`, [m, role[key]]);
      return m;
    };
    ids.sa1 = await member(ids.sa1User, "SUPER_ADMIN");
    ids.sa2 = await member(ids.sa2User, "SUPER_ADMIN");
    ids.hr = await member(ids.hrUser, "HR_MANAGER");
    ids.emp = await member(ids.empUser, "EMPLOYEE");
  }, 30000);

  afterAll(async () => {
    if (owner && ids.org) {
      // Removing every member at once is a full teardown, which the last-Super-Admin rule allows.
      await owner.query(`DELETE FROM organization_members WHERE organization_id = $1`, [ids.org]);
      await owner.query(`DELETE FROM organizations WHERE id = $1`, [ids.org]);
      await owner.query(`DELETE FROM users WHERE id = ANY($1)`, [[ids.sa1User, ids.sa2User, ids.hrUser, ids.empUser]]);
    }
    await owner?.end();
    await rt?.end();
  });

  // Runs statements and makes the deferred checks run, but always undoes the change. By default as the OWNER
  // account: these rules bind everyone, and the app account is no longer allowed to even try most of them
  // (the security tests cover that). Pass `rt` to run as the app account.
  async function outcome(sqls: string[], client: Client = owner): Promise<string> {
    await client.query("BEGIN");
    try {
      for (const s of sqls) await client.query(s);
      await client.query("SET CONSTRAINTS ALL IMMEDIATE");
      await client.query("ROLLBACK");
      return "allowed";
    } catch (e) {
      await client.query("ROLLBACK").catch(() => undefined);
      return `refused: ${(e as Error).message}`;
    }
  }

  it("holds exactly the three roles, each with exactly the permissions in src/lib/auth/roles.ts", async () => {
    expect(Object.keys(role).sort()).toEqual([...ROLE_KEYS].sort());
    const rows = (await owner.query(`SELECT r.key AS role, p.key AS perm FROM role_permissions rp JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id`)).rows;
    for (const key of ROLE_KEYS) {
      expect(rows.filter((x) => x.role === key).map((x) => x.perm).sort(), key).toEqual([...ROLE_PERMISSIONS[key]].sort());
    }
  });

  it("refuses a fourth role, a renamed role and a second role for one member", async () => {
    expect(await outcome([`INSERT INTO roles (id, key, name) VALUES (gen_random_uuid(), 'RECRUITER', 'x')`])).toMatch(/roles_only_three/);
    expect(await outcome([`UPDATE roles SET key = 'ADMIN' WHERE key = 'SUPER_ADMIN'`])).toMatch(/roles_only_three/);
    expect(await outcome([`INSERT INTO organization_member_roles (member_id, role_id) VALUES ('${ids.emp}', '${role.HR_MANAGER}')`])).toMatch(/member_id_key/);
  });

  it("never lets an organisation lose its last active Super Admin, whichever way it is tried", async () => {
    const both = `('${ids.sa1}', '${ids.sa2}')`;
    expect(await outcome([`UPDATE organization_members SET status = 'SUSPENDED' WHERE id IN ${both}`])).toMatch(/at least one active Super Admin/);
    expect(await outcome([`UPDATE organization_member_roles SET role_id = '${role.EMPLOYEE}' WHERE member_id IN ${both}`])).toMatch(/at least one active Super Admin/);
    expect(await outcome([`DELETE FROM organization_member_roles WHERE member_id IN ${both}`])).toMatch(/at least one active Super Admin/);
    expect(await outcome([`UPDATE users SET status = 'DISABLED' WHERE id IN ('${ids.sa1User}', '${ids.sa2User}')`])).toMatch(/at least one active Super Admin/);
    expect(await outcome([`DELETE FROM organization_members WHERE id IN ${both}`])).toMatch(/at least one active Super Admin/);
    // One at a time: the first is fine, the second is refused.
    expect(await outcome([`UPDATE organization_members SET status = 'SUSPENDED' WHERE id = '${ids.sa2}'`])).toBe("allowed");
    expect(await outcome([`UPDATE organization_members SET status = 'SUSPENDED' WHERE id = '${ids.sa2}'`, `UPDATE organization_member_roles SET role_id = '${role.HR_MANAGER}' WHERE member_id = '${ids.sa1}'`])).toMatch(/at least one active Super Admin/);
  });

  it("allows ordinary changes to HR Managers and Employees, and swapping a role within one transaction", async () => {
    expect(await outcome([`UPDATE organization_members SET status = 'SUSPENDED' WHERE id IN ('${ids.hr}', '${ids.emp}')`])).toBe("allowed");
    expect(await outcome([`UPDATE organization_member_roles SET role_id = '${role.HR_MANAGER}' WHERE member_id = '${ids.emp}'`])).toBe("allowed");
    expect(await outcome([`DELETE FROM organization_member_roles WHERE member_id = '${ids.sa1}'`, `INSERT INTO organization_member_roles (member_id, role_id) VALUES ('${ids.sa1}', '${role.SUPER_ADMIN}')`])).toBe("allowed");
  });

  it("lets ownership pass only to an active Super Admin of the organisation", async () => {
    expect(await outcome([`UPDATE organizations SET owner_user_id = '${ids.hrUser}' WHERE id = '${ids.org}'`])).toMatch(/owner must be an active Super Admin/);
    expect(await outcome([`UPDATE organizations SET owner_user_id = '${ids.empUser}' WHERE id = '${ids.org}'`])).toMatch(/owner must be an active Super Admin/);
    expect(await outcome([`UPDATE organizations SET owner_user_id = '${ids.sa2User}' WHERE id = '${ids.org}'`])).toBe("allowed");
  });

  it("keeps invitations to HR Managers and Employees, lower-case, single-outcome and one open per person", async () => {
    // Invitations are protected by row-level security: run as this organisation's Super Admin.
    const token = await pgSessionToken(owner, ids.sa1User, ids.org);
    const asSuperAdmin = `SELECT set_config('app.mode', 'staff', true), set_config('app.session_token', '${token}', true)`;
    const invite = (email: string, roleKey: string, extra = "") =>
      `INSERT INTO staff_invitations (id, organization_id, email, name, role_key, token_hash, expires_at${extra ? ", accepted_at" : ""}) VALUES (gen_random_uuid(), '${ids.org}', '${email}', 'N', '${roleKey}', md5(random()::text), now() + interval '7 days'${extra})`;
    expect(await outcome([asSuperAdmin, invite("a@example.test", "EMPLOYEE")], rt)).toBe("allowed");
    expect(await outcome([asSuperAdmin, invite("a@example.test", "HR_MANAGER")], rt)).toBe("allowed");
    expect(await outcome([asSuperAdmin, invite("a@example.test", "SUPER_ADMIN")], rt)).toMatch(/staff_invitations_role/);
    expect(await outcome([asSuperAdmin, invite("A@Example.test", "EMPLOYEE")], rt)).toMatch(/staff_invitations_email_lower/);
    expect(await outcome([asSuperAdmin, invite("b@example.test", "EMPLOYEE"), invite("b@example.test", "EMPLOYEE")], rt)).toMatch(/staff_invitations_one_open/);
    expect(await outcome([asSuperAdmin, invite("c@example.test", "EMPLOYEE", ", now()")], rt)).toMatch(/staff_invitations_accepted_user/);
  });

  it("has HR inviting Employees switched on by default", async () => {
    expect((await owner.query(`SELECT hr_can_invite_employees FROM organizations WHERE id = $1`, [ids.org])).rows[0].hr_can_invite_employees).toBe(true);
  });
});

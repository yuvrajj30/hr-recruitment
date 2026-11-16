// User and role management against the DISPOSABLE test database: the service rules, plus direct SQL
// attempts (as the app's restricted account) to get around them. Audit writes go to a recorder.
import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuditEntry } from "@/lib/auth/audit";
import { sessionTimings } from "@/lib/auth/config";
import type { AuthContext } from "@/lib/auth/context";
import { ForbiddenError } from "@/lib/auth/errors";
import { ROLE_PERMISSIONS, type RoleKey } from "@/lib/auth/roles";
import { createSession } from "@/lib/auth/session-store";
import { createDb, type Db } from "@/lib/db";
import { hashToken } from "@/lib/security/tokens";
import {
  changeRole,
  createInvitation,
  listInvitations,
  listPeople,
  resendInvitation,
  revokeInvitation,
  setHrCanInviteEmployees,
  setMemberStatus,
  type UserDeps,
} from "@/lib/users/members";
import { realRoleIds } from "./roles-helper";
import { createTestSession, giveSession, STAFF_CONTEXT_SQL } from "./session-helper";

const ownerUrl = process.env.TEST_OWNER_URL;
const runtimeUrl = process.env.TEST_RUNTIME_URL;
const isTestDb = (u?: string) => Boolean(u && /_test\b/.test(new URL(u).pathname));
const enabled = isTestDb(ownerUrl) && isTestDb(runtimeUrl);
const now = new Date("2026-11-15T06:00:00.000Z");
const timings = sessionTimings({ SESSION_IDLE_MINUTES: 60, SESSION_ABSOLUTE_HOURS: 12, SESSION_TOUCH_INTERVAL_SECONDS: 60 });
const rnd = () => randomBytes(4).toString("hex");
const DOMAIN = "users-test.example.test";

describe.skipIf(!enabled)("user and role management (test database)", () => {
  let owner: Db;
  let db: Db;
  let raw: Client;
  let role: Record<RoleKey, string>;
  const orgIds: string[] = [];

  beforeAll(async () => {
    owner = createDb(ownerUrl!, { max: 3 });
    db = createDb(runtimeUrl!, { max: 5 });
    raw = new Client({ connectionString: runtimeUrl });
    await raw.connect();
    role = await realRoleIds(owner);
  });
  afterAll(async () => {
    if (owner) {
      await owner.staffInvitation.deleteMany({ where: { organizationId: { in: orgIds } } });
      await owner.session.deleteMany({ where: { user: { email: { endsWith: `@${DOMAIN}` } } } });
      await owner.organizationMember.deleteMany({ where: { organizationId: { in: orgIds } } });
      await owner.organization.deleteMany({ where: { id: { in: orgIds } } });
      await owner.user.deleteMany({ where: { email: { endsWith: `@${DOMAIN}` } } });
      await owner.$disconnect();
    }
    await db?.$disconnect();
    await raw?.end();
  });

  // An organisation owned by a Super Admin, with a second Super Admin, an HR Manager and two Employees.
  async function world() {
    const user = (name: string) => owner.user.create({ data: { email: `${name.toLowerCase()}-${rnd()}@${DOMAIN}`, name } });
    const [own, sa2, hr, emp1, emp2] = await Promise.all([user("Owner"), user("Second"), user("Harsha"), user("Esha"), user("Eli")]);
    const org = await owner.organization.create({ data: { slug: `t-${rnd()}${rnd()}`, name: "Users Org", ownerUserId: own.id } });
    orgIds.push(org.id);
    const member = (u: { id: string }, key: RoleKey) =>
      owner.organizationMember.create({ data: { organizationId: org.id, userId: u.id, status: "ACTIVE", joinedAt: now, roles: { create: [{ roleId: role[key] }] } } });
    const m = { own: await member(own, "SUPER_ADMIN"), sa2: await member(sa2, "SUPER_ADMIN"), hr: await member(hr, "HR_MANAGER"), emp1: await member(emp1, "EMPLOYEE"), emp2: await member(emp2, "EMPLOYEE") };
    const ctx = (u: { id: string; email: string; name: string }, key: RoleKey, memberId: string): AuthContext => ({
      sessionId: "00000000-0000-0000-0000-000000000000",
      user: { id: u.id, email: u.email, name: u.name, isPlatformAdmin: false },
      organization: { id: org.id, name: org.name, slug: org.slug },
      memberId, expiresAt: now, absoluteExpiresAt: now, roleKeys: [key], permissions: new Set(ROLE_PERMISSIONS[key]),
    });
    const entries: AuditEntry[] = [];
    const deps: UserDeps = { db, now, writeAudit: async (_db, e) => void entries.push(e), client: { ipAddress: null, userAgent: "vitest" }, appOrigin: "https://hr.example.test" };
    return {
      org, m, deps, entries,
      users: { own, sa2, hr, emp1, emp2 },
      // Each with a real, live session: the database works out who is asking from it.
      sa: await giveSession(owner, ctx(own, "SUPER_ADMIN", m.own.id)),
      hr: await giveSession(owner, ctx(hr, "HR_MANAGER", m.hr.id)),
      emp: await giveSession(owner, ctx(emp1, "EMPLOYEE", m.emp1.id)),
    };
  }

  // Raw SQL as the app account, as a given staff member; always rolled back.
  async function asStaff(userId: string, orgId: string, sql: string, params: unknown[] = []) {
    const token = await createTestSession(owner, userId, orgId); // a fresh live session of that member
    await raw.query("BEGIN");
    try {
      await raw.query(STAFF_CONTEXT_SQL, [token]);
      const r = await raw.query(sql, params);
      await raw.query("SET CONSTRAINTS ALL IMMEDIATE");
      return { rowCount: r.rowCount ?? 0, error: undefined as string | undefined };
    } catch (e) {
      return { rowCount: 0, error: (e as Error).message };
    } finally {
      await raw.query("ROLLBACK");
    }
  }

  it("lists the organisation's people with their roles; Employees cannot", async () => {
    const w = await world();
    const people = await listPeople(db, w.sa);
    expect(people.map((p) => [p.name, p.role, p.isOwner, p.isSelf])).toEqual([
      ["Eli", "EMPLOYEE", false, false],
      ["Esha", "EMPLOYEE", false, false],
      ["Harsha", "HR_MANAGER", false, false],
      ["Owner", "SUPER_ADMIN", true, true],
      ["Second", "SUPER_ADMIN", false, false],
    ]);
    expect((await listPeople(db, w.hr)).length).toBe(5);
    await expect(listPeople(db, w.emp)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("creates one-time invitation links, storing only a hash, and replaces an open one for the same person", async () => {
    const w = await world();
    const first = await createInvitation(w.deps, w.sa, { email: " New.Person@Example.test ", name: "New Person", role: "HR_MANAGER" });
    const token = first.link.split("/invite/")[1]!;
    expect(first.link).toMatch(/^https:\/\/hr\.example\.test\/invite\/[A-Za-z0-9_-]{43}$/);
    expect(first.expiresAt).toEqual(new Date(now.getTime() + 7 * 24 * 3600_000));
    const row = await owner.staffInvitation.findUniqueOrThrow({ where: { id: first.id } });
    expect(row).toMatchObject({ email: "new.person@example.test", roleKey: "HR_MANAGER", tokenHash: hashToken(token), invitedById: w.users.own.id });
    expect(JSON.stringify(row)).not.toContain(token); // the link itself is never stored
    expect(w.entries.at(-1)).toMatchObject({ action: "invitation.created", metadata: { role: "HR_MANAGER" } });
    expect(JSON.stringify(w.entries)).not.toContain(token);

    const second = await createInvitation(w.deps, w.sa, { email: "new.person@example.test", name: "New Person", role: "EMPLOYEE" });
    expect((await owner.staffInvitation.findUniqueOrThrow({ where: { id: first.id } })).revokedAt).toEqual(now);
    expect(second.link).not.toBe(first.link);
    await expect(createInvitation(w.deps, w.sa, { email: w.users.emp1.email, name: "Esha", role: "EMPLOYEE" })).rejects.toMatchObject({ code: "invalid" });
  });

  it("lets HR Managers invite Employees only, and only while a Super Admin allows it", async () => {
    const w = await world();
    await createInvitation(w.deps, w.sa, { email: `hr-invite-${rnd()}@example.test`, name: "Future HR", role: "HR_MANAGER" });
    const empInvite = await createInvitation(w.deps, w.hr, { email: `emp-invite-${rnd()}@example.test`, name: "Future Employee", role: "EMPLOYEE" });
    await expect(createInvitation(w.deps, w.hr, { email: "x@example.test", name: "X", role: "HR_MANAGER" })).rejects.toMatchObject({ code: "invalid" });
    await expect(createInvitation(w.deps, w.emp, { email: "y@example.test", name: "Y", role: "EMPLOYEE" })).rejects.toMatchObject({ code: "invalid" });
    // HR sees only the Employee invitation; the Super Admin sees both.
    expect((await listInvitations(db, w.hr, now)).map((i) => i.role)).toEqual(["EMPLOYEE"]);
    expect((await listInvitations(db, w.sa, now)).map((i) => i.role).sort()).toEqual(["EMPLOYEE", "HR_MANAGER"]);
    // Only the Super Admin can switch HR invitations off; then HR cannot invite, the Super Admin still can.
    await expect(setHrCanInviteEmployees(w.deps, w.hr, false)).rejects.toBeInstanceOf(ForbiddenError);
    await setHrCanInviteEmployees(w.deps, w.sa, false);
    expect((await owner.organization.findUniqueOrThrow({ where: { id: w.org.id } })).hrCanInviteEmployees).toBe(false);
    await expect(createInvitation(w.deps, w.hr, { email: "z@example.test", name: "Z", role: "EMPLOYEE" })).rejects.toMatchObject({ message: expect.stringContaining("turned off") });
    await createInvitation(w.deps, w.sa, { email: `sa-emp-${rnd()}@example.test`, name: "By SA", role: "EMPLOYEE" });
    // HR can still revoke their own Employee invitation.
    await revokeInvitation(w.deps, w.hr, empInvite.id);
    expect(w.entries.map((e) => e.action)).toContain("settings.hr_can_invite_employees");
  });

  it("revokes and resends invitations, each change audited", async () => {
    const w = await world();
    const inv = await createInvitation(w.deps, w.sa, { email: `resend-${rnd()}@example.test`, name: "Resend Me", role: "EMPLOYEE" });
    const again = await resendInvitation(w.deps, w.sa, inv.id);
    expect(again.link).not.toBe(inv.link);
    expect((await owner.staffInvitation.findUniqueOrThrow({ where: { id: inv.id } })).revokedAt).not.toBeNull();
    await revokeInvitation(w.deps, w.sa, again.id);
    await expect(revokeInvitation(w.deps, w.sa, again.id)).rejects.toMatchObject({ code: "conflict" });
    expect(w.entries.map((e) => e.action)).toEqual(["invitation.created", "invitation.created", "invitation.revoked"]);
  });

  it("lets a Super Admin change roles (signing the person out), never their own or the owner's", async () => {
    const w = await world();
    const s = await createSession(owner, { userId: w.users.emp1.id, activeOrganizationId: w.org.id, ipAddress: null, userAgent: null, now, timings });
    await changeRole(w.deps, w.sa, w.m.emp1.id, "HR_MANAGER");
    expect((await listPeople(db, w.sa)).find((p) => p.name === "Esha")?.role).toBe("HR_MANAGER");
    expect((await owner.session.findUniqueOrThrow({ where: { id: s.sessionId } })).revokedReason).toBe("membership_changed");
    expect(w.entries.at(-1)).toMatchObject({ action: "member.role_changed", metadata: { from: "EMPLOYEE", to: "HR_MANAGER" } });
    // A second Super Admin can be demoted; the owner and the actor themselves cannot.
    await changeRole(w.deps, w.sa, w.m.sa2.id, "EMPLOYEE");
    await expect(changeRole(w.deps, w.sa, w.m.own.id, "HR_MANAGER")).rejects.toMatchObject({ code: "invalid" });
    // HR Managers change no roles.
    await expect(changeRole(w.deps, w.hr, w.m.emp2.id, "HR_MANAGER")).rejects.toMatchObject({ code: "invalid" });
  });

  it("lets HR Managers deactivate and reactivate Employees only; deactivation signs the person out", async () => {
    const w = await world();
    const s = await createSession(owner, { userId: w.users.emp2.id, activeOrganizationId: w.org.id, ipAddress: null, userAgent: null, now, timings });
    await setMemberStatus(w.deps, w.hr, w.m.emp2.id, "SUSPENDED");
    expect((await owner.organizationMember.findUniqueOrThrow({ where: { id: w.m.emp2.id } })).status).toBe("SUSPENDED");
    expect((await owner.session.findUniqueOrThrow({ where: { id: s.sessionId } })).revokedAt).not.toBeNull();
    await setMemberStatus(w.deps, w.hr, w.m.emp2.id, "ACTIVE");
    expect(w.entries.map((e) => e.action)).toEqual(["member.deactivated", "member.reactivated"]);
    await expect(setMemberStatus(w.deps, w.hr, w.m.sa2.id, "SUSPENDED")).rejects.toMatchObject({ code: "invalid" });
    await expect(setMemberStatus(w.deps, w.hr, w.m.hr.id, "SUSPENDED")).rejects.toMatchObject({ code: "invalid" }); // themselves
    // A Super Admin may deactivate an HR Manager, but never the owner.
    await setMemberStatus(w.deps, w.sa, w.m.hr.id, "SUSPENDED");
    await expect(setMemberStatus(w.deps, w.sa, w.m.own.id, "SUSPENDED")).rejects.toMatchObject({ code: "invalid" });
  });

  it("refuses the same changes in the database itself, without any application code", async () => {
    const w = await world();
    const { own, hr, emp1 } = w.users;
    // HR cannot deactivate another HR Manager or a Super Admin, change any role, or change settings.
    expect((await asStaff(hr.id, w.org.id, `UPDATE organization_members SET status = 'SUSPENDED' WHERE id = $1`, [w.m.sa2.id])).rowCount).toBe(0);
    expect((await asStaff(hr.id, w.org.id, `UPDATE organization_member_roles SET role_id = $1 WHERE member_id = $2`, [role.SUPER_ADMIN, w.m.emp1.id])).rowCount).toBe(0);
    expect((await asStaff(hr.id, w.org.id, `UPDATE organizations SET hr_can_invite_employees = false WHERE id = $1`, [w.org.id])).rowCount).toBe(0);
    // ...but can deactivate an Employee.
    expect((await asStaff(hr.id, w.org.id, `UPDATE organization_members SET status = 'SUSPENDED' WHERE id = $1`, [w.m.emp1.id])).rowCount).toBe(1);
    // Nobody changes their own membership or role, not even a Super Admin.
    expect((await asStaff(own.id, w.org.id, `UPDATE organization_member_roles SET role_id = $1 WHERE member_id = $2`, [role.EMPLOYEE, w.m.own.id])).rowCount).toBe(0);
    expect((await asStaff(emp1.id, w.org.id, `UPDATE organization_member_roles SET role_id = $1 WHERE member_id = $2`, [role.SUPER_ADMIN, w.m.emp1.id])).rowCount).toBe(0);
    // A Super Admin cannot demote the owner (the database refuses even though the row is reachable).
    expect((await asStaff(w.users.sa2.id, w.org.id, `UPDATE organization_member_roles SET role_id = $1 WHERE member_id = $2`, [role.HR_MANAGER, w.m.own.id])).error).toMatch(/owner must stay an active Super Admin/);
    // ...and cannot touch another organisation.
    const other = await world();
    expect((await asStaff(own.id, w.org.id, `UPDATE organization_members SET status = 'SUSPENDED' WHERE id = $1`, [other.m.emp1.id])).rowCount).toBe(0);
  });
});

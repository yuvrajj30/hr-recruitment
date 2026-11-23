// Tests roles, permissions and the per-request context against the DISPOSABLE test database only.
// It uses the three real roles (Super Admin, HR Manager, Employee); the database refuses any other role.
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sessionTimings } from "@/lib/auth/config";
import { getAuthContext, requireOrganizationId, scopedToOrganization } from "@/lib/auth/context";
import { ForbiddenError } from "@/lib/auth/errors";
import { loadAccess } from "@/lib/auth/permissions";
import { ROLE_PERMISSIONS, type RoleKey } from "@/lib/auth/roles";
import { createSession } from "@/lib/auth/session-store";
import { createDb, type Db } from "@/lib/db";
import { realRoleIds } from "./roles-helper";

const ownerUrl = process.env.TEST_OWNER_URL;
const runtimeUrl = process.env.TEST_RUNTIME_URL;
const isTestDb = (u?: string) => Boolean(u && /_test\b/.test(new URL(u).pathname));
const enabled = isTestDb(ownerUrl) && isTestDb(runtimeUrl);

const t0 = new Date("2026-11-14T10:00:00.000Z");
const timings = sessionTimings({ SESSION_IDLE_MINUTES: 60, SESSION_ABSOLUTE_HOURS: 12, SESSION_TOUCH_INTERVAL_SECONDS: 60 });
const rnd = () => randomBytes(4).toString("hex");

describe.skipIf(!enabled)("permissions and request context (test database)", () => {
  let owner: Db;
  let db: Db;
  const userIds: string[] = [];
  const orgIds: string[] = [];
  let role: Record<RoleKey, string>;

  beforeAll(async () => {
    owner = createDb(ownerUrl!, { max: 3 });
    db = createDb(runtimeUrl!, { max: 4 });
    role = await realRoleIds(owner);
  });
  afterAll(async () => {
    if (owner) {
      await owner.session.deleteMany({ where: { userId: { in: userIds } } });
      await owner.organizationMember.deleteMany({ where: { userId: { in: userIds } } }); // also removes their role links
      await owner.organization.deleteMany({ where: { id: { in: orgIds } } });
      await owner.user.deleteMany({ where: { id: { in: userIds } } });
      await owner.$disconnect();
    }
    await db?.$disconnect();
  });

  const permsOf = (key: RoleKey) => [...ROLE_PERMISSIONS[key]].sort();
  async function makeUser(isPlatformAdmin = false) {
    const user = await owner.user.create({ data: { email: `perm-test-${rnd()}@example.test`, name: "Perm Test", isPlatformAdmin } });
    userIds.push(user.id);
    return user;
  }
  async function makeOrg(ownerUserId: string) {
    const org = await owner.organization.create({ data: { slug: `t-${rnd()}${rnd()}`, name: "Perm Org", ownerUserId } });
    orgIds.push(org.id);
    return org;
  }
  const makeMember = (organizationId: string, userId: string, roleIds: string[], status: "ACTIVE" | "SUSPENDED" = "ACTIVE") =>
    owner.organizationMember.create({
      data: {
        organizationId,
        userId,
        status,
        joinedAt: t0,
        roles: { create: roleIds.map((roleId) => ({ roleId })) },
      },
    });

  const signIn = (userId: string, organizationId: string | null) =>
    createSession(owner, { userId, activeOrganizationId: organizationId, ipAddress: null, userAgent: null, now: t0, timings });
  const context = (token: string) => getAuthContext(db, token, { now: new Date(t0.getTime() + 60_000), timings, touch: false });

  // -------------------------------------------------------------------------
  describe("loading a member's access", () => {
    it("gives a member exactly their one role's permissions", async () => {
      const user = await makeUser();
      const org = await makeOrg(user.id);
      const member = await makeMember(org.id, user.id, [role.EMPLOYEE]);
      const access = await loadAccess(db, member.id);
      expect(access.roleKeys).toEqual(["EMPLOYEE"]);
      expect([...access.permissions].sort()).toEqual(permsOf("EMPLOYEE"));
      expect(access.permissions.has("job:read")).toBe(false);
    });
    it("refuses a second role for the same member (the database allows exactly one)", async () => {
      const user = await makeUser();
      const org = await makeOrg(user.id);
      const member = await makeMember(org.id, user.id, [role.EMPLOYEE]);
      await expect(owner.organizationMemberRole.create({ data: { memberId: member.id, roleId: role.HR_MANAGER } })).rejects.toThrow();
      const other = await makeUser();
      await expect(
        owner.organizationMember.create({ data: { organizationId: org.id, userId: other.id, roles: { create: [{ roleId: role.HR_MANAGER }, { roleId: role.EMPLOYEE }] } } }),
      ).rejects.toThrow();
      expect((await loadAccess(db, member.id)).roleKeys).toEqual(["EMPLOYEE"]);
    });
    it("refuses any role other than the three, for the owner and the app account alike", async () => {
      await expect(owner.role.create({ data: { key: "RECRUITER", name: "Recruiter" } })).rejects.toThrow();
      await expect(db.role.create({ data: { key: `T_${rnd()}`, name: "Made up" } })).rejects.toThrow();
    });
    it("is empty for a member with no roles", async () => {
      const user = await makeUser();
      const org = await makeOrg(user.id);
      const member = await makeMember(org.id, user.id, []);
      expect(await loadAccess(db, member.id)).toEqual({ roleKeys: [], permissions: new Set() });
    });
    it("never mixes in another member's role", async () => {
      const me = await makeUser();
      const colleague = await makeUser();
      const org = await makeOrg(me.id);
      const myMember = await makeMember(org.id, me.id, [role.EMPLOYEE]);
      await makeMember(org.id, colleague.id, [role.HR_MANAGER]);
      expect([...(await loadAccess(db, myMember.id)).permissions].sort()).toEqual(permsOf("EMPLOYEE"));
    });
    it("gives the same person different roles in different organizations", async () => {
      const user = await makeUser();
      const orgA = await makeOrg(user.id);
      const orgB = await makeOrg(user.id);
      const inA = await makeMember(orgA.id, user.id, [role.SUPER_ADMIN]);
      const inB = await makeMember(orgB.id, user.id, [role.EMPLOYEE]);
      expect([...(await loadAccess(db, inA.id)).permissions].sort()).toEqual(permsOf("SUPER_ADMIN"));
      expect([...(await loadAccess(db, inB.id)).permissions].sort()).toEqual(permsOf("EMPLOYEE"));
    });
  });

  // -------------------------------------------------------------------------
  describe("the per-request context", () => {
    it("carries the person, the organization, the membership, role and permissions", async () => {
      const user = await makeUser();
      const org = await makeOrg(user.id);
      const member = await makeMember(org.id, user.id, [role.HR_MANAGER]);
      const s = await signIn(user.id, org.id);
      const r = await context(s.token);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.ctx.user.id).toBe(user.id);
      expect(r.ctx.organization).toEqual({ id: org.id, name: "Perm Org", slug: org.slug });
      expect(r.ctx.memberId).toBe(member.id);
      expect(r.ctx.roleKeys).toEqual(["HR_MANAGER"]);
      expect([...r.ctx.permissions].sort()).toEqual(permsOf("HR_MANAGER"));
    });
    it("a role change takes effect on the very next request", async () => {
      const user = await makeUser();
      const org = await makeOrg(user.id);
      const member = await makeMember(org.id, user.id, [role.HR_MANAGER]);
      const s = await signIn(user.id, org.id);
      const before = await context(s.token);
      expect(before.ok && before.ctx.permissions.has("job:create")).toBe(true);
      await owner.organizationMemberRole.updateMany({ where: { memberId: member.id }, data: { roleId: role.EMPLOYEE } });
      const after = await context(s.token);
      expect(after.ok).toBe(true);
      expect(after.ok && after.ctx.permissions.has("job:create")).toBe(false);
      expect(after.ok && after.ctx.roleKeys).toEqual(["EMPLOYEE"]);
    });
    it("no context at all once the membership is suspended", async () => {
      const user = await makeUser();
      const org = await makeOrg(user.id);
      const member = await makeMember(org.id, user.id, [role.EMPLOYEE]);
      const s = await signIn(user.id, org.id);
      await owner.organizationMember.update({ where: { id: member.id }, data: { status: "SUSPENDED" } });
      expect(await context(s.token)).toEqual({ ok: false, reason: "membership_inactive" });
    });
    it("a session with no organization has no permissions and cannot be used for company data", async () => {
      const user = await makeUser();
      const s = await signIn(user.id, null);
      const r = await context(s.token);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.ctx.organization).toBeNull();
      expect(r.ctx.permissions.size).toBe(0);
      expect(() => requireOrganizationId(r.ctx)).toThrow(ForbiddenError);
      expect(() => scopedToOrganization(r.ctx, {})).toThrow(ForbiddenError);
    });
  });

  // -------------------------------------------------------------------------
  describe("platform admins and other organizations", () => {
    it("a platform admin gets no access to a company they are not a member of", async () => {
      const boss = await makeUser(true);
      const someoneElse = await makeUser();
      const foreignOrg = await makeOrg(someoneElse.id);
      await makeMember(foreignOrg.id, someoneElse.id, []);
      // Even if a session somehow points at that organization, the missing membership refuses it.
      const s = await signIn(boss.id, foreignOrg.id);
      expect(await context(s.token)).toEqual({ ok: false, reason: "membership_inactive" });
      // And with no organization the flag alone grants nothing.
      const s2 = await signIn(boss.id, null);
      const r2 = await context(s2.token);
      expect(r2.ok && r2.ctx.permissions.size).toBe(0);
      expect(r2.ok && r2.ctx.user.isPlatformAdmin).toBe(true);
    });
    it("queries scoped by the context only ever see the session's own organization", async () => {
      const userA = await makeUser();
      const userB = await makeUser();
      const orgA = await makeOrg(userA.id);
      const orgB = await makeOrg(userB.id);
      const memberA = await makeMember(orgA.id, userA.id, []);
      await makeMember(orgB.id, userB.id, []);
      const r = await context((await signIn(userA.id, orgA.id)).token);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const seen = await db.organizationMember.findMany({ where: scopedToOrganization(r.ctx, {}), select: { id: true } });
      expect(seen.map((m) => m.id)).toEqual([memberA.id]);
      // Trying to aim the query at the other organization is overridden.
      const aimed = await db.organizationMember.findMany({
        where: scopedToOrganization(r.ctx, { organizationId: orgB.id }),
        select: { id: true },
      });
      expect(aimed.map((m) => m.id)).toEqual([memberA.id]);
    });
  });
});

// Tests roles, permissions and the per-request context against the DISPOSABLE test database only.
// Roles and permissions are created here with unique names (the test database may be empty), and removed afterwards.
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sessionTimings } from "@/lib/auth/config";
import { getAuthContext, requireOrganizationId, scopedToOrganization } from "@/lib/auth/context";
import { ForbiddenError } from "@/lib/auth/errors";
import { loadAccess } from "@/lib/auth/permissions";
import { createSession } from "@/lib/auth/session-store";
import { createDb, type Db } from "@/lib/db";

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
  const roleIds: string[] = [];
  const permissionIds: string[] = [];

  beforeAll(() => {
    owner = createDb(ownerUrl!, { max: 3 });
    db = createDb(runtimeUrl!, { max: 4 });
  });
  afterAll(async () => {
    if (owner) {
      await owner.session.deleteMany({ where: { userId: { in: userIds } } });
      await owner.organizationMember.deleteMany({ where: { userId: { in: userIds } } }); // also removes their role links
      await owner.organization.deleteMany({ where: { id: { in: orgIds } } });
      await owner.user.deleteMany({ where: { id: { in: userIds } } });
      await owner.role.deleteMany({ where: { id: { in: roleIds } } });
      await owner.permission.deleteMany({ where: { id: { in: permissionIds } } });
      await owner.$disconnect();
    }
    await db?.$disconnect();
  });

  // A role that carries exactly the given permission names (created fresh, unique to this test run).
  async function makeRole(label: string, permissionKeys: string[]) {
    const role = await owner.role.create({ data: { key: `T_${label}_${rnd()}`, name: `Test ${label}`, isSystem: false } });
    roleIds.push(role.id);
    for (const key of permissionKeys) {
      const p = await owner.permission.upsert({ where: { key }, update: {}, create: { key, module: "test" } });
      if (!permissionIds.includes(p.id)) permissionIds.push(p.id);
      await owner.rolePermission.create({ data: { roleId: role.id, permissionId: p.id } });
    }
    return role;
  }
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
  const p = (name: string, tag: string) => `tp${tag}:${name}`; // unique permission names for this test

  const signIn = (userId: string, organizationId: string | null) =>
    createSession(db, { userId, activeOrganizationId: organizationId, ipAddress: null, userAgent: null, now: t0, timings });
  const context = (token: string) => getAuthContext(db, token, { now: new Date(t0.getTime() + 60_000), timings, touch: false });

  // -------------------------------------------------------------------------
  describe("loading a member's access", () => {
    it("combines the permissions of all of the member's roles", async () => {
      const tag = rnd();
      const r1 = await makeRole("one", [p("a", tag), p("b", tag)]);
      const r2 = await makeRole("two", [p("b", tag), p("c", tag)]);
      const user = await makeUser();
      const org = await makeOrg(user.id);
      const member = await makeMember(org.id, user.id, [r1.id, r2.id]);
      const access = await loadAccess(db, member.id);
      expect([...access.permissions].sort()).toEqual([p("a", tag), p("b", tag), p("c", tag)]);
      expect(access.roleKeys).toEqual([r1.key, r2.key].sort());
    });
    it("is empty for a member with no roles", async () => {
      const user = await makeUser();
      const org = await makeOrg(user.id);
      const member = await makeMember(org.id, user.id, []);
      expect(await loadAccess(db, member.id)).toEqual({ roleKeys: [], permissions: new Set() });
    });
    it("never mixes in another member's roles", async () => {
      const tag = rnd();
      const mine = await makeRole("mine", [p("mine", tag)]);
      const theirs = await makeRole("theirs", [p("theirs", tag)]);
      const me = await makeUser();
      const colleague = await makeUser();
      const org = await makeOrg(me.id);
      const myMember = await makeMember(org.id, me.id, [mine.id]);
      await makeMember(org.id, colleague.id, [theirs.id]);
      expect([...(await loadAccess(db, myMember.id)).permissions]).toEqual([p("mine", tag)]);
    });
    it("gives the same person different permissions in different organizations", async () => {
      const tag = rnd();
      const adminLike = await makeRole("adminlike", [p("manage", tag), p("view", tag)]);
      const viewOnly = await makeRole("viewonly", [p("view", tag)]);
      const user = await makeUser();
      const orgA = await makeOrg(user.id);
      const orgB = await makeOrg(user.id);
      const inA = await makeMember(orgA.id, user.id, [adminLike.id]);
      const inB = await makeMember(orgB.id, user.id, [viewOnly.id]);
      expect([...(await loadAccess(db, inA.id)).permissions].sort()).toEqual([p("manage", tag), p("view", tag)]);
      expect([...(await loadAccess(db, inB.id)).permissions]).toEqual([p("view", tag)]);
    });
  });

  // -------------------------------------------------------------------------
  describe("the per-request context", () => {
    it("carries the person, the organization, the membership, roles and permissions", async () => {
      const tag = rnd();
      const role = await makeRole("ctx", [p("x", tag)]);
      const user = await makeUser();
      const org = await makeOrg(user.id);
      const member = await makeMember(org.id, user.id, [role.id]);
      const s = await signIn(user.id, org.id);
      const r = await context(s.token);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.ctx.user.id).toBe(user.id);
      expect(r.ctx.organization).toEqual({ id: org.id, name: "Perm Org", slug: org.slug });
      expect(r.ctx.memberId).toBe(member.id);
      expect(r.ctx.roleKeys).toEqual([role.key]);
      expect([...r.ctx.permissions]).toEqual([p("x", tag)]);
    });
    it("a role change takes effect on the very next request", async () => {
      const tag = rnd();
      const role = await makeRole("change", [p("x", tag)]);
      const user = await makeUser();
      const org = await makeOrg(user.id);
      const member = await makeMember(org.id, user.id, [role.id]);
      const s = await signIn(user.id, org.id);
      const before = await context(s.token);
      expect(before.ok && before.ctx.permissions.has(p("x", tag))).toBe(true);
      await owner.organizationMemberRole.deleteMany({ where: { memberId: member.id } });
      const after = await context(s.token);
      expect(after.ok).toBe(true);
      expect(after.ok && after.ctx.permissions.size).toBe(0);
    });
    it("no context at all once the membership is suspended", async () => {
      const role = await makeRole("susp", [p("x", rnd())]);
      const user = await makeUser();
      const org = await makeOrg(user.id);
      const member = await makeMember(org.id, user.id, [role.id]);
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

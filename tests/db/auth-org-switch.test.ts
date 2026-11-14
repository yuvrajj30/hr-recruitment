// Tests switching the active organization against the DISPOSABLE test database only.
// The audit writer is replaced by a recorder (real audit rows can never be deleted).
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuditEntry } from "@/lib/auth/audit";
import { sessionTimings } from "@/lib/auth/config";
import { getAuthContext } from "@/lib/auth/context";
import { switchActiveOrganization } from "@/lib/auth/org-switch";
import { createSession, revokeSessionByToken } from "@/lib/auth/session-store";
import { createDb, type Db } from "@/lib/db";

const ownerUrl = process.env.TEST_OWNER_URL;
const runtimeUrl = process.env.TEST_RUNTIME_URL;
const isTestDb = (u?: string) => Boolean(u && /_test\b/.test(new URL(u).pathname));
const enabled = isTestDb(ownerUrl) && isTestDb(runtimeUrl);

const t0 = new Date("2026-11-14T10:00:00.000Z");
const timings = sessionTimings({ SESSION_IDLE_MINUTES: 60, SESSION_ABSOLUTE_HOURS: 12, SESSION_TOUCH_INTERVAL_SECONDS: 60 });
const rnd = () => randomBytes(4).toString("hex");
const FORBIDDEN = { ok: false, reason: "forbidden" } as const;

describe.skipIf(!enabled)("switching organization (test database)", () => {
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
      await owner.organizationMember.deleteMany({ where: { userId: { in: userIds } } });
      await owner.organization.deleteMany({ where: { id: { in: orgIds } } });
      await owner.user.deleteMany({ where: { id: { in: userIds } } });
      await owner.role.deleteMany({ where: { id: { in: roleIds } } });
      await owner.permission.deleteMany({ where: { id: { in: permissionIds } } });
      await owner.$disconnect();
    }
    await db?.$disconnect();
  });

  const recorder = () => {
    const entries: AuditEntry[] = [];
    return { entries, deps: { writeAudit: async (_db: unknown, e: AuditEntry) => void entries.push(e) } };
  };

  async function makeRole(permissionKey: string) {
    const role = await owner.role.create({ data: { key: `T_SW_${rnd()}`, name: "Switch Test", isSystem: false } });
    roleIds.push(role.id);
    const perm = await owner.permission.upsert({ where: { key: permissionKey }, update: {}, create: { key: permissionKey, module: "test" } });
    permissionIds.push(perm.id);
    await owner.rolePermission.create({ data: { roleId: role.id, permissionId: perm.id } });
    return role;
  }
  async function makeUser() {
    const u = await owner.user.create({ data: { email: `switch-test-${rnd()}@example.test`, name: "Switch Test" } });
    userIds.push(u.id);
    return u;
  }
  async function makeOrg(ownerUserId: string, status: "ACTIVE" | "SUSPENDED" = "ACTIVE") {
    const o = await owner.organization.create({ data: { slug: `t-${rnd()}${rnd()}`, name: `Org ${rnd()}`, ownerUserId, status } });
    orgIds.push(o.id);
    return o;
  }
  const makeMember = (organizationId: string, userId: string, status: "ACTIVE" | "INVITED" | "SUSPENDED", roleId?: string) =>
    owner.organizationMember.create({
      data: { organizationId, userId, status, joinedAt: t0, ...(roleId ? { roles: { create: [{ roleId }] } } : {}) },
    });
  const signIn = (userId: string, organizationId: string | null) =>
    createSession(db, { userId, activeOrganizationId: organizationId, ipAddress: null, userAgent: null, now: t0, timings });
  const sessionOrg = async (sessionId: string) =>
    (await owner.session.findUniqueOrThrow({ where: { id: sessionId } })).activeOrganizationId;
  const input = (sessionId: string, userId: string, organizationId: string) => ({
    sessionId, userId, organizationId, ipAddress: "203.0.113.9", userAgent: "vitest", now: new Date(t0.getTime() + 5000),
  });

  // One person working in two companies, plus other companies they have no (usable) access to.
  async function world() {
    const tag = rnd();
    const permA = `tsw${tag}:only_in_a`;
    const permB = `tsw${tag}:only_in_b`;
    const roleA = await makeRole(permA);
    const roleB = await makeRole(permB);
    const me = await makeUser();
    const stranger = await makeUser();
    const orgA = await makeOrg(me.id);
    const orgB = await makeOrg(me.id);
    const foreign = await makeOrg(stranger.id); // I am not a member
    const suspendedOrg = await makeOrg(stranger.id, "SUSPENDED");
    const invitedOrg = await makeOrg(stranger.id);
    const suspendedMemberOrg = await makeOrg(stranger.id);
    await makeMember(orgA.id, me.id, "ACTIVE", roleA.id);
    await makeMember(orgB.id, me.id, "ACTIVE", roleB.id);
    await makeMember(foreign.id, stranger.id, "ACTIVE");
    await makeMember(suspendedOrg.id, me.id, "ACTIVE");
    await makeMember(invitedOrg.id, me.id, "INVITED");
    await makeMember(suspendedMemberOrg.id, me.id, "SUSPENDED");
    const session = await signIn(me.id, orgA.id);
    return { me, stranger, orgA, orgB, foreign, suspendedOrg, invitedOrg, suspendedMemberOrg, permA, permB, session };
  }

  it("moves the session to another organization the person belongs to", async () => {
    const w = await world();
    const { deps, entries } = recorder();
    const r = await switchActiveOrganization(db, input(w.session.sessionId, w.me.id, w.orgB.id), deps);
    expect(r).toEqual({ ok: true, organization: { id: w.orgB.id, name: w.orgB.name, slug: w.orgB.slug } });
    expect(await sessionOrg(w.session.sessionId)).toBe(w.orgB.id);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      action: "auth.organization_switched",
      organizationId: w.orgB.id,
      actorUserId: w.me.id,
      entityType: "session",
      entityId: w.session.sessionId,
      metadata: { fromOrganizationId: w.orgA.id },
    });
  });
  it("then shows ONLY the new organization's permissions", async () => {
    const w = await world();
    const ctxNow = () => getAuthContext(db, w.session.token, { now: new Date(t0.getTime() + 60_000), timings, touch: false });
    const before = await ctxNow();
    expect(before.ok && [...before.ctx.permissions]).toEqual([w.permA]);
    await switchActiveOrganization(db, input(w.session.sessionId, w.me.id, w.orgB.id), recorder().deps);
    const after = await ctxNow();
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.ctx.organization?.id).toBe(w.orgB.id);
    expect([...after.ctx.permissions]).toEqual([w.permB]); // nothing carried over from organization A
  });
  it("switching to the organization already active does nothing and writes no audit record", async () => {
    const w = await world();
    const { deps, entries } = recorder();
    const r = await switchActiveOrganization(db, input(w.session.sessionId, w.me.id, w.orgA.id), deps);
    expect(r.ok).toBe(true);
    expect(entries).toHaveLength(0);
    expect(await sessionOrg(w.session.sessionId)).toBe(w.orgA.id);
  });
  it("gives the SAME refusal for every organization that is not usable, so nothing can be learned from it", async () => {
    const w = await world();
    const { deps, entries } = recorder();
    const targets = {
      "not a member": w.foreign.id,
      "organization suspended": w.suspendedOrg.id,
      "invitation not accepted": w.invitedOrg.id,
      "membership suspended": w.suspendedMemberOrg.id,
      "organization that does not exist": randomUUID(),
    };
    for (const [label, organizationId] of Object.entries(targets)) {
      expect(await switchActiveOrganization(db, input(w.session.sessionId, w.me.id, organizationId), deps), label).toEqual(FORBIDDEN);
    }
    expect(await sessionOrg(w.session.sessionId)).toBe(w.orgA.id); // never moved
    expect(entries).toHaveLength(0);
  });
  it("cannot move somebody else's session", async () => {
    const w = await world();
    const other = await makeUser();
    const otherOrg = await makeOrg(other.id);
    await makeMember(otherOrg.id, other.id, "ACTIVE");
    await makeMember(w.orgB.id, other.id, "ACTIVE");
    const otherSession = await signIn(other.id, otherOrg.id);
    // I try to switch THEIR session (I know its id) using MY identity.
    expect(await switchActiveOrganization(db, input(otherSession.sessionId, w.me.id, w.orgB.id), recorder().deps)).toEqual(FORBIDDEN);
    expect(await sessionOrg(otherSession.sessionId)).toBe(otherOrg.id);
  });
  it("refuses once the session has been revoked", async () => {
    const w = await world();
    await revokeSessionByToken(db, w.session.token, "logout", new Date(t0.getTime() + 1000));
    expect(await switchActiveOrganization(db, input(w.session.sessionId, w.me.id, w.orgB.id), recorder().deps)).toEqual(FORBIDDEN);
    expect(await sessionOrg(w.session.sessionId)).toBe(w.orgA.id);
  });
  it("changes nothing if the audit record cannot be written", async () => {
    const w = await world();
    const deps = { writeAudit: async () => { throw new Error("audit write failed"); } };
    await expect(switchActiveOrganization(db, input(w.session.sessionId, w.me.id, w.orgB.id), deps)).rejects.toThrow("audit write failed");
    expect(await sessionOrg(w.session.sessionId)).toBe(w.orgA.id);
  });
});
